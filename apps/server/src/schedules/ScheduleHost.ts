/**
 * ScheduleHost - keeps this home's single OS scheduler entry in step with its
 * schedules, and records the misses only the host can see. Fork-owned.
 *
 * One entry per home, whose calendar is the union of every enabled schedule
 * in an unarchived Project, or no entry at all. The OS fires it; the entry
 * runs `schedules fire`, and the server decides what is due. The reconcile
 * runs at startup, on Project changes and hourly. It never dispatches turns.
 *
 * Backends: `none` does nothing, `dry-run` writes the would-be entry under
 * the state dir, and `os` installs a LaunchAgent (`launchdBackend.ts`) or a
 * systemd user timer (`systemdBackend.ts`). Only `os` runs a process.
 *
 * Misses:
 * - At startup, each `server-down` line in `attempts.jsonl` records
 *   `missed: not-running` for the slot its fire was for.
 * - Hourly, only with an installed OS entry, a slot over 2h15m old with no
 *   run records `missed: no-fire`. `none` and `dry-run` never fire on their
 *   own, so they never record it.
 *
 * @module ScheduleHost
 */
import type {
  ProjectId,
  ProjectScheduleRun,
  ProjectScheduler,
  ScheduleHostProblem,
  ScheduleHostStatus,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessHomeDirectory,
  HostProcessIsExecutable,
} from "@t3tools/shared/hostProcess";
import { LATE_LIMIT_MS, NO_FIRE_GRACE_MS, scheduleSlotAt } from "@t3tools/shared/schedules";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import { readScheduleAttempts } from "./attemptLog.ts";
import { HostTimeZoneSource, hasZoneMismatch } from "./hostZone.ts";
import {
  launchAgentLogPath,
  launchAgentPath,
  makeLaunchdBackend,
  renderSchedulePlist,
} from "./launchdBackend.ts";
import {
  resolvePlatformScheduleBackend,
  resolveScheduleBackend,
  type ScheduleBackendMode,
} from "./scheduleBackend.ts";
import { isProjectReorderOnlyPayload } from "../orchestration/projectOrderEvents.ts";
import { makeSystemdBackend, renderScheduleUnits, systemdUnitDir } from "./systemdBackend.ts";
import {
  ScheduleRunner,
  activeAssistant,
  cronRunKey,
  lastRunOf,
  recordScheduleRun,
} from "./ScheduleRunner.ts";

const DEFAULT_APP_ID = "com.lucive.controlplane";
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/** What the OS entry should hold. Names and prompts are never in it. */
export interface DesiredScheduleEntry {
  readonly label: string;
  /** `execPath`, the entry script when `hasEntryScript`, then the `schedules fire` arguments. */
  readonly program: ReadonlyArray<string>;
  readonly hasEntryScript: boolean;
  readonly env: Readonly<Record<string, string>>;
  /** Every enabled cron in an unarchived Project, deduplicated and sorted. */
  readonly crons: ReadonlyArray<string>;
  readonly timeZone: string;
  readonly appId?: string;
}

export interface ScheduleEntryState {
  readonly state: ScheduleHostStatus["entry"]["state"];
  readonly path?: string;
  readonly detail?: string;
  readonly problems: ReadonlyArray<ScheduleHostProblem>;
}

/** Installs, inspects and removes the entry for one label. */
export class ScheduleHostBackend extends Context.Service<
  ScheduleHostBackend,
  {
    readonly scheduler: ProjectScheduler;
    readonly mode: ScheduleBackendMode;
    /** Makes the entry match; `null` removes it. */
    readonly apply: (
      label: string,
      entry: DesiredScheduleEntry | null,
    ) => Effect.Effect<ScheduleEntryState>;
    readonly probe: (label: string) => Effect.Effect<ScheduleEntryState>;
    readonly remove: (label: string) => Effect.Effect<void>;
  }
>()("t3/schedules/ScheduleHost/ScheduleHostBackend") {}

export class ScheduleHost extends Context.Service<
  ScheduleHost,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** The host line: backend, live zone, the entry and any problems. */
    readonly status: Effect.Effect<ScheduleHostStatus>;
    /** Resolves once every event committed so far has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/schedules/ScheduleHost") {}

/**
 * `<appId>.schedules.<first 8 hex of sha256(environmentId)>`: stable across a
 * home move. The app id is cut to label-safe characters, since the label
 * names files and is spliced into the entry's cleanup shell.
 */
export function scheduleEntryLabel(appId: string | undefined, environmentId: string): string {
  const homeKey = NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 8);
  const safeAppId = appId?.trim().replaceAll(/[^A-Za-z0-9.-]/g, "-");
  return `${safeAppId || DEFAULT_APP_ID}.schedules.${homeKey}`;
}

/** Whether `label` has the shape `scheduleEntryLabel` produces, so it is safe to remove. */
export function isScheduleEntryLabel(label: string): boolean {
  return /^[A-Za-z0-9.-]+\.schedules\.[0-9a-f]{8}$/.test(label);
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const shellQuote = (value: string) =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** The entry's command as a shell line, without `--label`, for running a fire by hand. */
export function formatFireCommand(entry: Pick<DesiredScheduleEntry, "program" | "env">): string {
  const program = [...entry.program];
  const labelIndex = program.indexOf("--label");
  if (labelIndex >= 0) program.splice(labelIndex, 2);
  return [
    ...Object.entries(entry.env).map(([name, value]) => `${name}=${shellQuote(value)}`),
    ...program.map(shellQuote),
  ].join(" ");
}

/** The union calendar of every enabled schedule in an unarchived Project. */
function enabledCrons(rows: ReadonlyArray<ProjectionProject>): ReadonlyArray<string> {
  const crons = new Set<string>();
  for (const row of rows) {
    for (const schedule of activeAssistant(row)?.schedules ?? []) {
      if (schedule.enabled) crons.add(schedule.cron);
    }
  }
  return [...crons].sort();
}

/** Installs nothing; `unsupported-platform` on Windows, `backend-off` when not asked for. */
const noneBackend = (problem: "backend-off" | "unsupported-platform") => {
  const state: ScheduleEntryState = { state: "unsupported", problems: [problem] };
  return ScheduleHostBackend.of({
    scheduler: "none",
    mode: "none",
    apply: () => Effect.succeed(state),
    probe: () => Effect.succeed(state),
    remove: () => Effect.void,
  });
};

/**
 * Writes `<stateDir>/schedules/dry-run/<label>.json` plus the entry the OS
 * backend would install (`.plist`, or `.service` and `.timer`), and never
 * runs a process.
 */
const makeDryRunBackend = (scheduler: ProjectScheduler) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const homeDir = yield* HostProcessHomeDirectory;
    const directory = path.join(config.stateDir, "schedules", "dry-run");
    const fileOf = (label: string) => path.join(directory, `${label}.json`);
    /** The rendered OS files, named as they would be installed, with the real install paths inside. */
    const renderedFiles = (
      label: string,
      entry: DesiredScheduleEntry,
    ): ReadonlyArray<readonly [string, string]> => {
      if (scheduler === "launchd") {
        const plistPath = launchAgentPath(path, homeDir, label);
        const logPath = launchAgentLogPath(path, homeDir, label);
        return [[`${label}.plist`, renderSchedulePlist(entry, { plistPath, logPath })]];
      }
      if (scheduler === "systemd") {
        const units = renderScheduleUnits(entry, { unitDir: systemdUnitDir(path, homeDir) });
        return [
          [`${label}.service`, units.service],
          [`${label}.timer`, units.timer],
        ];
      }
      return [];
    };
    const writeIfChanged = (filePath: string, contents: string) =>
      Effect.gen(function* () {
        const current = yield* fs.readFileString(filePath).pipe(Effect.option);
        // Unchanged bytes are left alone, as the OS backends do.
        if (Option.getOrNull(current) === contents) return;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(filePath, contents);
      });
    const failed = (cause: unknown): ScheduleEntryState => ({
      state: "failed",
      detail: String(cause),
      problems: ["install-failed"],
    });

    const probe = (label: string) =>
      fs.exists(fileOf(label)).pipe(
        Effect.map((exists): ScheduleEntryState =>
          exists
            ? { state: "dry-run", path: fileOf(label), problems: [] }
            : { state: "not-needed", problems: [] },
        ),
        Effect.catch((cause) => Effect.succeed(failed(cause))),
      );
    const removeAll = (label: string) =>
      Effect.forEach(
        ["json", "plist", "service", "timer"],
        (extension) => fs.remove(path.join(directory, `${label}.${extension}`), { force: true }),
        { discard: true },
      );
    const remove = (label: string) => removeAll(label).pipe(Effect.ignore);
    const apply = (label: string, entry: DesiredScheduleEntry | null) =>
      Effect.gen(function* () {
        if (entry === null) {
          yield* removeAll(label);
          return { state: "not-needed", problems: [] } satisfies ScheduleEntryState;
        }
        // Indented for a person reading it; nothing parses this file back.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const summary = `${JSON.stringify({ scheduler, ...entry }, null, 2)}\n`;
        yield* writeIfChanged(fileOf(label), summary);
        for (const [name, contents] of renderedFiles(label, entry)) {
          yield* writeIfChanged(path.join(directory, name), contents);
        }
        return { state: "dry-run", path: fileOf(label), problems: [] } satisfies ScheduleEntryState;
      }).pipe(Effect.catch((cause) => Effect.succeed(failed(cause))));
    return ScheduleHostBackend.of({ scheduler, mode: "dry-run", apply, probe, remove });
  });

/**
 * The only backends that run processes: `launchctl` or `systemctl`, through
 * the caller's `ProcessRunner`, so a test's fake runner sees every call.
 */
const osBackendLayer = (scheduler: ProjectScheduler) =>
  Layer.effect(
    ScheduleHostBackend,
    (scheduler === "systemd" ? makeSystemdBackend : makeLaunchdBackend).pipe(
      Effect.map(ScheduleHostBackend.of),
    ),
  );

type BackendLayer = Layer.Layer<
  ScheduleHostBackend,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | ProcessRunner.ProcessRunner
>;

/** The backend the desktop's bootstrap or `CPLANE_SCHEDULES_BACKEND` picks. */
export const backendLayer = Layer.unwrap(
  Effect.map(resolveScheduleBackend, (choice): BackendLayer => {
    switch (choice.mode) {
      case "os":
        return osBackendLayer(choice.scheduler);
      case "dry-run":
        return Layer.effect(ScheduleHostBackend, makeDryRunBackend(choice.scheduler));
      case "none":
        return Layer.succeed(
          ScheduleHostBackend,
          noneBackend(choice.unsupportedPlatform ? "unsupported-platform" : "backend-off"),
        );
    }
  }),
);

/**
 * This platform's OS backend, whatever `CPLANE_SCHEDULES_BACKEND` says, for
 * commands that remove an entry from outside the server: `schedules fire` for
 * a home that is gone, and `uninstall`. Under Vitest, and on platforms without
 * a backend, it removes nothing.
 */
export const entryRemovalBackendLayer = Layer.unwrap(
  Effect.gen(function* () {
    const choice = yield* resolvePlatformScheduleBackend;
    return choice.mode === "os"
      ? osBackendLayer(choice.scheduler)
      : Layer.succeed(ScheduleHostBackend, noneBackend("backend-off"));
  }),
).pipe(Layer.provide(ProcessRunner.layer));

/** Log and continue, so one bad pass never stops the host. */
const warnOnFailure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { cause: Cause.pretty(cause) }),
      ),
    );

type Work = "reconcile" | "startup" | "hourly";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const backend = yield* ScheduleHostBackend;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const identity = yield* ServerEnvironmentIdentity;
  const projects = yield* ProjectionProjectRepository;
  const engine = yield* OrchestrationEngineService;
  const runner = yield* ScheduleRunner;
  const hostZone = yield* HostTimeZoneSource;
  const execPath = yield* HostProcessExecutablePath;
  const argv = yield* HostProcessArguments;
  const isExecutable = yield* HostProcessIsExecutable;

  const label = scheduleEntryLabel(config.appId, yield* identity.getEnvironmentId);
  const entryScript = isExecutable ? undefined : argv[1];
  const program = [
    execPath,
    ...(entryScript ? [entryScript] : []),
    "schedules",
    "fire",
    "--state-dir",
    config.stateDir,
    "--label",
    label,
  ];
  // Under Electron the entry runs the app binary as plain Node.
  const entryEnv: Record<string, string> =
    "electron" in process.versions ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  const fireCommand = formatFireCommand({ program, env: entryEnv });
  const appId = config.appId?.trim();
  const desiredEntry = (crons: ReadonlyArray<string>, timeZone: string) =>
    crons.length === 0
      ? null
      : ({
          label,
          program,
          hasEntryScript: entryScript !== undefined,
          env: entryEnv,
          crons,
          timeZone,
          ...(appId ? { appId } : {}),
        } satisfies DesiredScheduleEntry);

  const lastEntry = yield* Ref.make<ScheduleEntryState | null>(null);

  const reconcile = Effect.gen(function* () {
    const crons = enabledCrons(yield* projects.listAll());
    const entry = yield* backend.apply(label, desiredEntry(crons, hostZone().zone));
    yield* Ref.set(lastEntry, entry);
  });

  /** A run waiting in the runner is the runner's to record. */
  const isHeld = (projectId: ProjectId, scheduleId: string) =>
    runner.holds(projectId).pipe(Effect.map((held) => Object.hasOwn(held, scheduleId)));

  /**
   * A slot the host missed, when it is armed, unrun, not held and in an
   * unarchived Project. `slotFor` gets the time a slot must reach to count.
   */
  const recordMisses = (
    reason: "not-running" | "no-fire",
    slotFor: (cron: string, zone: string, floorMs: number) => Date | null,
  ) =>
    Effect.gen(function* () {
      const zone = hostZone().zone;
      const at = DateTime.formatIso(yield* DateTime.now);
      for (const row of yield* projects.listAll()) {
        const assistant = activeAssistant(row);
        if (assistant === null) continue;
        for (const schedule of assistant.schedules ?? []) {
          if (!schedule.enabled) continue;
          const last = lastRunOf(assistant, schedule.id);
          const armedMs = Date.parse(schedule.updatedAt);
          const floorMs = last === undefined ? armedMs : Math.max(armedMs, Date.parse(last.slot));
          const slot = slotFor(schedule.cron, zone, floorMs);
          if (slot === null || slot.getTime() < armedMs) continue;
          if (last !== undefined && Date.parse(last.slot) >= slot.getTime()) continue;
          if (yield* isHeld(row.projectId, schedule.id)) continue;
          const slotIso = slot.toISOString();
          const run: ProjectScheduleRun = {
            slot: slotIso,
            at,
            trigger: "cron",
            outcome: "missed",
            reason,
          };
          yield* recordScheduleRun(engine, {
            projectId: row.projectId,
            scheduleId: schedule.id,
            runKey: cronRunKey(row.projectId, schedule.id, slotIso),
            run,
          });
        }
      }
    });

  /** Fires the CLI logged while the server was down: the latest such slot per schedule. */
  const recordNotRunning = Effect.gen(function* () {
    const downAt = (yield* readScheduleAttempts(config.logsDir))
      .filter((attempt) => attempt.result === "server-down")
      .map((attempt) => Date.parse(attempt.startedAt))
      .filter((startedAt) => !Number.isNaN(startedAt))
      .sort((left, right) => right - left);
    if (downAt.length === 0) return;
    yield* recordMisses("not-running", (cron, zone, floorMs) => {
      // Newest first. A slot is never after its fire and only moves forward
      // with it, so the first fire in reach has the latest slot, and a fire
      // before the floor cannot reach a slot that counts.
      for (const startedAt of downAt) {
        if (startedAt < floorMs) return null;
        const slot = scheduleSlotAt(cron, zone, DateTime.toDateUtc(DateTime.makeUnsafe(startedAt)));
        if (slot !== null && startedAt - slot.getTime() <= LATE_LIMIT_MS) return slot;
      }
      return null;
    });
  });

  /**
   * An installed OS entry should have fired every slot by now. One the host
   * already reports as off (turned off by the user, or no GUI session) is
   * not "host was off": the host line says why instead.
   */
  const recordNoFire = Effect.gen(function* () {
    const entry = yield* Ref.get(lastEntry);
    if (backend.mode !== "os" || entry?.state !== "installed") return;
    if (
      entry.problems.some((problem) => problem === "entry-disabled" || problem === "no-gui-session")
    ) {
      return;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const before = DateTime.toDateUtc(DateTime.makeUnsafe(nowMs - NO_FIRE_GRACE_MS));
    yield* recordMisses("no-fire", (cron, zone) => scheduleSlotAt(cron, zone, before));
  });

  const withFileSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  let reconcileQueued = false;
  const handle = (work: Work): Effect.Effect<void> => {
    switch (work) {
      case "reconcile":
        return Effect.suspend(() => {
          reconcileQueued = false;
          return reconcile;
        }).pipe(warnOnFailure("schedule entry not reconciled"));
      case "startup":
        return Effect.gen(function* () {
          yield* Effect.logInfo(`schedules backend=${backend.mode}`);
          yield* reconcile.pipe(warnOnFailure("schedule entry not reconciled"));
          yield* recordNotRunning.pipe(withFileSystem, warnOnFailure("missed fires not recorded"));
        });
      case "hourly":
        return Effect.gen(function* () {
          // The reconcile also trims the entry's log (the launchd backend's).
          yield* reconcile.pipe(warnOnFailure("schedule entry not reconciled"));
          yield* recordNoFire.pipe(warnOnFailure("unfired slots not recorded"));
        });
    }
  };
  const worker = yield* makeDrainableWorker(handle);
  const enqueueReconcile = Effect.suspend(() => {
    if (reconcileQueued) return Effect.void;
    reconcileQueued = true;
    return worker.enqueue("reconcile");
  });

  // Highest event sequence the subscriber has handled; -1 until it runs.
  const seenSequence = yield* SubscriptionRef.make(-1);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ScheduleHost["Service"]["start"] = Effect.fn("ScheduleHost.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Effect.gen(function* () {
        const head = yield* engine.latestSequence;
        yield* worker.enqueue("startup");
        yield* noteSeen(head);
        yield* Stream.runForEach(events, (event) =>
          ((event.type === "project.meta-updated" && !isProjectReorderOnlyPayload(event.payload)) ||
          event.type === "project.deleted"
            ? enqueueReconcile
            : Effect.void
          ).pipe(Effect.andThen(noteSeen(event.sequence))),
        );
      }),
    );
    yield* forkParked(
      Effect.sleep(RECONCILE_INTERVAL_MS).pipe(
        Effect.andThen(worker.enqueue("hourly")),
        Effect.forever,
      ),
    );
  });

  const status: ScheduleHost["Service"]["status"] = Effect.gen(function* () {
    const zone = hostZone();
    const entry = (yield* Ref.get(lastEntry)) ?? (yield* backend.probe(label));
    const problems = new Set<ScheduleHostProblem>([
      ...entry.problems,
      ...(hasZoneMismatch(zone) ? (["zone-mismatch"] as const) : []),
    ]);
    return {
      scheduler: backend.scheduler,
      backend: backend.mode,
      timeZone: zone.zone,
      entry: {
        state: entry.state,
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        ...(backend.mode === "dry-run" ? { fireCommand } : {}),
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      },
      problems: [...problems],
    } satisfies ScheduleHostStatus;
  });

  const drain: ScheduleHost["Service"]["drain"] = Effect.gen(function* () {
    while (true) {
      const target = yield* engine.latestSequence;
      yield* SubscriptionRef.changes(seenSequence).pipe(
        Stream.filter((seen) => seen >= target),
        Stream.runHead,
      );
      yield* worker.drain;
      if ((yield* engine.latestSequence) === target) return;
    }
  });

  return { start, status, drain } satisfies ScheduleHost["Service"];
});

/** Needs a `ScheduleHostBackend`; `layer` picks it from the environment. */
export const layerWithoutBackend = Layer.effect(ScheduleHost, make).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);

export const layer = layerWithoutBackend.pipe(
  Layer.provide(backendLayer.pipe(Layer.provide(ProcessRunner.layer))),
);
