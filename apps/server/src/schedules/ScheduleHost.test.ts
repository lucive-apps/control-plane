import { EnvironmentId, ProjectId, ThreadId, type ScheduleHostProblem } from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessHomeDirectory,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProcessRunner } from "../processRunner.ts";
import { appendScheduleAttempt } from "./attemptLog.ts";
import { HostTimeZoneSource } from "./hostZone.ts";
import * as ScheduleHost from "./ScheduleHost.ts";
import { ScheduleRunner } from "./ScheduleRunner.ts";
import {
  makeScheduleEngineLayer,
  makeScheduleFixture,
  type ScheduleEngineServices,
} from "./schedules.testFixtures.ts";

const PROJECT = ProjectId.make("project-personal");
const COORDINATOR = ThreadId.make("coordinator");
const ENVIRONMENT = EnvironmentId.make("environment-1");
const LABEL = ScheduleHost.scheduleEntryLabel(undefined, ENVIRONMENT);
const WRITTEN_AT = "2026-09-28T12:00:00.000Z";
const DAILY = "0 13 * * *";

const test = <A, E>(name: string, body: Effect.Effect<A, E, ScheduleEngineServices>) =>
  it.effect(name, () => body.pipe(Effect.provide(makeScheduleEngineLayer("t3-schedule-host-"))));

/** An OS backend that reports its entry installed, and never touches the OS. */
const installedOsBackend = (problems: ReadonlyArray<ScheduleHostProblem> = []) =>
  Layer.succeed(
    ScheduleHost.ScheduleHostBackend,
    ScheduleHost.ScheduleHostBackend.of({
      scheduler: "launchd",
      mode: "os",
      apply: (_label, entry) =>
        Effect.succeed({ state: entry === null ? "not-needed" : "installed", problems }),
      probe: () => Effect.succeed({ state: "installed", problems }),
      remove: () => Effect.void,
    }),
  );

const makeHostFixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(WRITTEN_AT));
  const f = yield* makeScheduleFixture;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* f.createProject(PROJECT, COORDINATOR, "Personal");
  const processCalls: Array<string> = [];
  const dryRunFile = path.join(config.stateDir, "schedules", "dry-run", `${LABEL}.json`);

  /** Runs `body` with a started host, then stops it. The default backend follows `env`. */
  const withHost = <A, E, R>(
    options: {
      readonly env?: NodeJS.ProcessEnv;
      /** Picks the scheduler a dry-run renders for; darwin by default. */
      readonly platform?: NodeJS.Platform;
      readonly backend?: Layer.Layer<ScheduleHost.ScheduleHostBackend>;
      /** Schedule ids the runner is holding a run for. */
      readonly held?: ReadonlyArray<string>;
    },
    body: (host: ScheduleHost.ScheduleHost["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const host = yield* ScheduleHost.ScheduleHost;
      yield* host.start();
      yield* host.drain;
      return yield* body(host);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ScheduleHost.layerWithoutBackend.pipe(
          Layer.provide(options.backend ?? ScheduleHost.backendLayer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerEnvironmentIdentity)({
                getEnvironmentId: Effect.succeed(ENVIRONMENT),
              }),
              Layer.mock(ScheduleRunner)({
                holds: () =>
                  Effect.succeed(
                    Object.fromEntries(
                      (options.held ?? []).map((id) => [id, { since: WRITTEN_AT }]),
                    ),
                  ),
              }),
              Layer.succeed(HostTimeZoneSource, () => ({ zone: "UTC", processZone: "UTC" })),
              // Neither backend may run a process.
              Layer.mock(ProcessRunner)({
                run: (input) => Effect.die(processCalls.push(input.command)),
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, options.env ?? {}),
      Effect.provideService(HostProcessPlatform, options.platform ?? "darwin"),
      Effect.provideService(HostProcessHomeDirectory, "/Users/theo"),
    );

  const dryRun = { env: { CPLANE_SCHEDULES_BACKEND: "dry-run" } };
  const readEntry = fs.readFileString(dryRunFile).pipe(Effect.map((text) => JSON.parse(text)));
  const dryRunDir = path.dirname(dryRunFile);
  return { ...f, config, fs, processCalls, dryRunFile, dryRunDir, withHost, dryRun, readEntry };
});

describe("ScheduleHost entry", () => {
  test(
    "runs nothing by default",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);

      const status = yield* f.withHost({}, (host) => host.status);

      assert.deepStrictEqual(status, {
        scheduler: "none",
        backend: "none",
        timeZone: "UTC",
        entry: { state: "unsupported" },
        problems: ["backend-off"],
      });
      assert.isFalse(yield* f.fs.exists(f.dryRunFile));
    }),
  );

  test(
    "writes the dry-run entry without prompts or processes, and removes it when nothing is enabled",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [
        { id: "daily", cron: DAILY, prompt: "Secret prompt text." },
        { id: "weekly", cron: "0 16 * * 5" },
        { id: "paused", cron: "0 9 * * *", enabled: false },
      ]);

      yield* f.withHost(f.dryRun, (host) =>
        Effect.gen(function* () {
          const entry = yield* f.readEntry;
          assert.deepStrictEqual(entry.crons, [DAILY, "0 16 * * 5"]);
          assert.strictEqual(entry.timeZone, "UTC");
          assert.deepStrictEqual(entry.program.slice(-6), [
            "schedules",
            "fire",
            "--state-dir",
            f.config.stateDir,
            "--label",
            LABEL,
          ]);
          const text = yield* f.fs.readFileString(f.dryRunFile);
          assert.notInclude(text, "Secret prompt text.");
          const status = yield* host.status;
          assert.deepStrictEqual(status.entry.state, "dry-run");
          assert.strictEqual(status.entry.path, f.dryRunFile);
          assert.include(
            status.entry.fireCommand,
            `schedules fire --state-dir ${f.config.stateDir}`,
          );
          assert.notInclude(status.entry.fireCommand, "--label");

          yield* f.setSchedules(PROJECT, [
            { id: "daily", cron: DAILY, enabled: false },
            { id: "weekly", cron: "0 16 * * 5", enabled: false },
          ]);
          yield* host.drain;
          assert.isFalse(yield* f.fs.exists(f.dryRunFile));
          assert.strictEqual((yield* host.status).entry.state, "not-needed");
        }),
      );

      assert.deepStrictEqual(f.processCalls, []);
    }),
  );

  test(
    "renders the entry the OS would get next to the dry-run JSON, for each scheduler",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [
        { id: "weekdays", cron: "0 7 * * 1-5", prompt: "Secret prompt text." },
      ]);
      const listDryRun = f.fs.readDirectory(f.dryRunDir).pipe(Effect.map((names) => names.sort()));

      yield* f.withHost({ ...f.dryRun, platform: "darwin" }, () => Effect.void);
      assert.deepStrictEqual(yield* listDryRun, [`${LABEL}.json`, `${LABEL}.plist`]);
      const plist = yield* f.fs.readFileString(`${f.dryRunDir}/${LABEL}.plist`);
      assert.include(plist, "<key>Weekday</key>");
      assert.include(plist, `/Users/theo/Library/LaunchAgents/${LABEL}.plist`);
      assert.notInclude(plist, "Secret prompt text.");

      yield* f.withHost({ ...f.dryRun, platform: "linux" }, (host) =>
        Effect.gen(function* () {
          const timer = yield* f.fs.readFileString(`${f.dryRunDir}/${LABEL}.timer`);
          assert.include(timer, "OnCalendar=Mon..Fri *-*-* 07:00:00 UTC");
          assert.include(
            yield* f.fs.readFileString(`${f.dryRunDir}/${LABEL}.service`),
            "ExecStart=/bin/sh -c",
          );
          yield* f.setSchedules(PROJECT, [{ id: "weekdays", cron: "0 7 * * 1-5", enabled: false }]);
          yield* host.drain;
        }),
      );
      // The earlier plist and the units all go once nothing is enabled.
      assert.deepStrictEqual(yield* listDryRun, []);
      assert.deepStrictEqual(f.processCalls, []);
    }),
  );

  test(
    "reports Windows as unsupported when a backend is asked for",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);

      const status = yield* f.withHost(
        { env: { CPLANE_SCHEDULES_BACKEND: "os" }, platform: "win32" },
        (host) => host.status,
      );

      assert.deepStrictEqual(status, {
        scheduler: "none",
        backend: "none",
        timeZone: "UTC",
        entry: { state: "unsupported" },
        problems: ["unsupported-platform"],
      });
      assert.deepStrictEqual(f.processCalls, []);
    }),
  );

  test(
    "leaves archived Projects out of the entry and puts them back on unarchive",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);

      yield* f.withHost(f.dryRun, (host) =>
        Effect.gen(function* () {
          yield* f.archiveProject(PROJECT, true);
          yield* host.drain;
          assert.isFalse(yield* f.fs.exists(f.dryRunFile));
          yield* f.archiveProject(PROJECT, false);
          yield* host.drain;
          assert.deepStrictEqual((yield* f.readEntry).crons, [DAILY]);
        }),
      );
    }),
  );
});

describe("ScheduleHost misses", () => {
  test(
    "records not-running for a fire the CLI logged while the server was down",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* TestClock.setTime(Date.parse("2026-09-28T13:30:00.000Z"));
      // Armed after the 13:00 slot, so that slot was never this schedule's.
      yield* f.setSchedules(PROJECT, [
        { id: "daily", cron: DAILY },
        { id: "fresh", cron: DAILY },
      ]);
      yield* appendScheduleAttempt(f.config.logsDir, {
        v: 1,
        startedAt: "2026-09-28T13:00:02.000Z",
        result: "server-down",
      });
      yield* TestClock.setTime(Date.parse("2026-09-28T14:00:00.000Z"));

      yield* f.withHost({}, () => Effect.void);

      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {
        daily: {
          slot: "2026-09-28T13:00:00.000Z",
          at: "2026-09-28T14:00:00.000Z",
          trigger: "cron",
          outcome: "missed",
          reason: "not-running",
        },
      });
      // A second start finds the slot already recorded.
      yield* f.withHost({}, () => Effect.void);
      assert.lengthOf(yield* f.receipts("cp-schedule-run:"), 1);
    }),
  );

  test(
    "leaves a slot the runner is holding to the runner",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* appendScheduleAttempt(f.config.logsDir, {
        v: 1,
        startedAt: "2026-09-28T13:00:02.000Z",
        result: "server-down",
      });
      yield* TestClock.setTime(Date.parse("2026-09-28T13:10:00.000Z"));

      // A later fire reached the new server first and holds the 13:00 slot.
      yield* f.withHost({ held: ["daily"] }, () => Effect.void);

      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
    }),
  );

  const armDailyAndFresh = (f: Effect.Success<typeof makeHostFixture>) =>
    Effect.gen(function* () {
      yield* f.setSchedules(PROJECT, [{ id: "daily", cron: DAILY }]);
      yield* TestClock.setTime(Date.parse("2026-09-28T14:00:00.000Z"));
      // Created after its latest slot, so that slot never counts.
      yield* f.setSchedules(PROJECT, [
        { id: "daily", cron: DAILY },
        { id: "fresh", cron: DAILY },
      ]);
      yield* TestClock.setTime(Date.parse("2026-09-28T14:10:00.000Z"));
    });

  test(
    "records no-fire under an installed OS entry once a slot is 2h15m old",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* armDailyAndFresh(f);

      yield* f.withHost({ backend: installedOsBackend() }, (host) =>
        Effect.gen(function* () {
          // The 15:10 pass looks at 12:55: the 13:00 slot is not due to have fired yet.
          yield* TestClock.adjust("1 hour");
          yield* host.drain;
          assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
          yield* TestClock.adjust("1 hour");
          yield* host.drain;
        }),
      );

      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {
        daily: {
          slot: "2026-09-28T13:00:00.000Z",
          at: "2026-09-28T16:10:00.000Z",
          trigger: "cron",
          outcome: "missed",
          reason: "no-fire",
        },
      });
    }),
  );

  test(
    "never records no-fire for an entry the host reports as turned off",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* armDailyAndFresh(f);

      for (const problem of ["entry-disabled", "no-gui-session"] as const) {
        yield* f.withHost({ backend: installedOsBackend([problem]) }, (host) =>
          TestClock.adjust("3 hours").pipe(Effect.andThen(host.drain)),
        );
      }

      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
    }),
  );

  test(
    "never records no-fire for a backend that does not fire on its own",
    Effect.gen(function* () {
      const f = yield* makeHostFixture;
      yield* armDailyAndFresh(f);

      yield* f.withHost(f.dryRun, (host) =>
        TestClock.adjust("3 hours").pipe(Effect.andThen(host.drain)),
      );

      assert.deepStrictEqual(yield* f.runsOf(PROJECT), {});
    }),
  );
});
