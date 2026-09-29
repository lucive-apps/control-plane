/**
 * The Linux schedule entry: a user oneshot service and its timer. Fork-owned.
 *
 * `<label>.timer` carries one `OnCalendar=` line per cron, in the host zone,
 * with `Persistent=true` so a slot missed while the machine was off fires once
 * on the next boot. `<label>.service` runs the guarded `schedules fire`, with
 * its output in the journal: an `append:` log inside the home would stop the
 * service from starting once the home is deleted, and with it the fire that
 * removes the entry. Without lingering, user timers run only while the user
 * is logged in, which is reported as a warning. A masked or disabled timer is
 * the user's call and is reported, never re-enabled.
 *
 * @module systemdBackend
 */
import type { ScheduleHostProblem } from "@t3tools/contracts";
import { HostProcessHomeDirectory, HostProcessUserId } from "@t3tools/shared/hostProcess";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import {
  ENTRY_GUARD,
  entryProgramArguments,
  ephemeralProgramPath,
  shellQuote,
} from "./entryProgram.ts";
import { systemdOnCalendar } from "./scheduleCalendar.ts";
import type {
  DesiredScheduleEntry,
  ScheduleEntryState,
  ScheduleHostBackend,
} from "./ScheduleHost.ts";

const PROBE_TIMEOUT: Duration.Input = "10 seconds";

/** systemd expands `%` specifiers (as `bootService.ts`). */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

/** As `bootService.ts`. */
function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/** `ExecStart=` also expands `$VAR`, and the guard script is full of `$0` and `$@`. */
const quoteSystemdExecArgument = (value: string) =>
  quoteSystemdValue(value.replaceAll("$", () => "$$"));

export const systemdUnitDir = (path: Path.Path, homeDir: string) =>
  path.join(homeDir, ".config", "systemd", "user");

/** systemd is Linux-only, so these are POSIX paths. */
const unitPaths = (unitDir: string, label: string) => ({
  service: `${unitDir}/${label}.service`,
  timer: `${unitDir}/${label}.timer`,
});

/** The guard's cleanup: stop the timer, drop both units, and let systemd forget them. */
const guardCleanup = (label: string, servicePath: string, timerPath: string) =>
  `systemctl --user disable --now ${label}.timer; rm -f ${shellQuote(servicePath)} ${shellQuote(timerPath)}; systemctl --user daemon-reload`;

/** Pure: the service and timer units for `entry`, installed under `unitDir`. */
export function renderScheduleUnits(
  entry: DesiredScheduleEntry,
  options: { readonly unitDir: string; readonly guard?: boolean },
): { readonly service: string; readonly timer: string } {
  const paths = unitPaths(options.unitDir, entry.label);
  const program = entryProgramArguments(
    { ...entry, cleanup: guardCleanup(entry.label, paths.service, paths.timer) },
    options.guard ?? ENTRY_GUARD,
  );
  const env = Object.entries(entry.env).sort(([left], [right]) => left.localeCompare(right));
  const service = [
    "[Unit]",
    "Description=Control Plane schedules",
    "",
    "[Service]",
    "Type=oneshot",
    ...env.map(([name, value]) => `Environment=${quoteSystemdValue(`${name}=${value}`)}`),
    `ExecStart=${program.map(quoteSystemdExecArgument).join(" ")}`,
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Control Plane schedules",
    "",
    "[Timer]",
    ...entry.crons.flatMap((cron) => {
      const calendar = systemdOnCalendar(cron, entry.timeZone);
      return calendar === null ? [] : [`OnCalendar=${calendar}`];
    }),
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

/**
 * The systemd user backend. Every path hangs off the injected home directory
 * and every command goes through the injected `ProcessRunner`, so tests never
 * reach the real user units or `systemctl`.
 */
export const makeSystemdBackend = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const homeDir = yield* HostProcessHomeDirectory;
  const uid = yield* HostProcessUserId;
  const unitDir = systemdUnitDir(path, homeDir);

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: PROBE_TIMEOUT }).pipe(Effect.option);
  const systemctl = (...args: ReadonlyArray<string>) => run("systemctl", ["--user", ...args]);
  const succeeded = (result: Option.Option<ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
  const stdoutOf = (result: Option.Option<ProcessRunOutput>) =>
    Option.isSome(result) ? result.value.stdout.trim() : "";

  const failed = (problem: ScheduleHostProblem, detail: string, unitPath?: string) =>
    ({
      state: "failed",
      ...(unitPath === undefined ? {} : { path: unitPath }),
      detail,
      problems: [problem],
    }) satisfies ScheduleEntryState;

  /** Writes whichever unit's bytes differ. */
  const writeUnits = (files: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      let changed = false;
      for (const [filePath, contents] of files) {
        const current = yield* fs.readFileString(filePath).pipe(Effect.option);
        if (Option.getOrUndefined(current) === contents) continue;
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, contents, { mode: 0o644 });
        changed = true;
      }
      return changed;
    });

  /**
   * Unit files written but never reloaded (a stop between the two) leave the
   * old calendar running; systemd flags either unit as `NeedDaemonReload`.
   */
  const needsDaemonReload = (label: string) =>
    systemctl(
      "show",
      "--property=NeedDaemonReload",
      "--value",
      `${label}.timer`,
      `${label}.service`,
    ).pipe(
      Effect.map((result) =>
        stdoutOf(result)
          .split("\n")
          .some((line) => line.trim() === "yes"),
      ),
    );

  /** Nothing to do without unit files: the only way this backend starts a timer is from them. */
  const unload = (label: string) =>
    Effect.gen(function* () {
      const paths = unitPaths(unitDir, label);
      const present = (yield* fs.exists(paths.timer)) || (yield* fs.exists(paths.service));
      if (!present) return;
      yield* systemctl("disable", "--now", `${label}.timer`);
      yield* fs.remove(paths.timer, { force: true });
      yield* fs.remove(paths.service, { force: true });
      yield* systemctl("daemon-reload");
    });

  const install = (label: string, entry: DesiredScheduleEntry) =>
    Effect.gen(function* () {
      const paths = unitPaths(unitDir, label);
      const timerName = `${label}.timer`;
      if (!succeeded(yield* systemctl("show-environment"))) {
        return { state: "unsupported", problems: ["no-user-manager"] } satisfies ScheduleEntryState;
      }
      const problems: ScheduleHostProblem[] = [];
      const linger = yield* run("loginctl", [
        "show-user",
        ...(uid === undefined ? [] : [String(uid)]),
        "--property=Linger",
        "--value",
      ]);
      if (!succeeded(linger) || stdoutOf(linger) !== "yes") problems.push("no-linger");
      const installed = (extra: ReadonlyArray<ScheduleHostProblem> = []): ScheduleEntryState => ({
        state: "installed",
        path: paths.timer,
        problems: [...problems, ...extra],
      });
      // `is-enabled` exits non-zero for these too, so only its output counts.
      const enabled = stdoutOf(yield* systemctl("is-enabled", timerName));
      if (enabled === "disabled" || enabled.startsWith("masked"))
        return installed(["entry-disabled"]);

      const units = renderScheduleUnits(entry, { unitDir });
      const changed = yield* writeUnits([
        [paths.service, units.service],
        [paths.timer, units.timer],
      ]);
      if (
        !changed &&
        succeeded(yield* systemctl("is-active", timerName)) &&
        !(yield* needsDaemonReload(label))
      ) {
        return installed();
      }
      const reload = yield* systemctl("daemon-reload");
      const enable = succeeded(reload)
        ? yield* systemctl("enable", "--now", timerName)
        : Option.none<ProcessRunOutput>();
      if (!succeeded(enable)) {
        const stderr = Option.isSome(enable) ? enable.value.stderr.trim() : "";
        const reloadError = Option.isSome(reload) ? reload.value.stderr.trim() : "";
        // Unit files left behind unenabled would read as `disabled`, the
        // user's choice, on every later reconcile. Removed, the next one
        // installs from scratch.
        yield* unload(label).pipe(Effect.ignore);
        return failed(
          "install-failed",
          stderr || reloadError || "systemctl could not enable the timer.",
        );
      }
      return installed();
    });

  const apply: ScheduleHostBackend["Service"]["apply"] = (label, entry) => {
    if (entry === null) {
      return unload(label).pipe(
        Effect.as({ state: "not-needed", problems: [] } satisfies ScheduleEntryState),
        Effect.catch((cause) => Effect.succeed(failed("install-failed", String(cause)))),
      );
    }
    const ephemeral = ephemeralProgramPath(entry);
    if (ephemeral !== undefined) return Effect.succeed(failed("ephemeral-path", ephemeral));
    return install(label, entry).pipe(
      Effect.catch((cause) => Effect.succeed(failed("install-failed", String(cause)))),
    );
  };

  const probe: ScheduleHostBackend["Service"]["probe"] = (label) => {
    const timerPath = unitPaths(unitDir, label).timer;
    return fs.exists(timerPath).pipe(
      Effect.map((exists): ScheduleEntryState =>
        exists
          ? { state: "installed", path: timerPath, problems: [] }
          : { state: "not-needed", problems: [] },
      ),
      Effect.catch((cause) => Effect.succeed(failed("install-failed", String(cause)))),
    );
  };

  return {
    scheduler: "systemd",
    mode: "os",
    apply,
    probe,
    remove: (label) => unload(label).pipe(Effect.ignore),
  } satisfies ScheduleHostBackend["Service"];
});
