import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessHomeDirectory, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ProcessRunner } from "../processRunner.ts";
import { SCHEDULE_LOG_MAX_BYTES } from "./attemptLog.ts";
import { makeLaunchdBackend, renderSchedulePlist } from "./launchdBackend.ts";
import type { DesiredScheduleEntry } from "./ScheduleHost.ts";

const UID = 501;
const LABEL = "com.lucive.controlplane.schedules.0a1b2c3d";
const APP = "/Applications/Control Plane.app/Contents";

const makeEntry = (overrides: Partial<DesiredScheduleEntry> = {}) =>
  ({
    label: LABEL,
    program: [
      `${APP}/MacOS/Control Plane`,
      `${APP}/Resources/app.asar/apps/server/dist/bin.mjs`,
      "schedules",
      "fire",
      "--state-dir",
      "/Users/theo/.t3/userdata",
      "--label",
      LABEL,
    ],
    hasEntryScript: true,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    crons: ["0 7 * * 1-5"],
    timeZone: "America/Denver",
    appId: "com.lucive.controlplane",
    ...overrides,
  }) satisfies DesiredScheduleEntry;

describe("renderSchedulePlist", () => {
  it("renders the guarded fire on a calendar, with no prompt and no run at load", () => {
    const plist = renderSchedulePlist(makeEntry(), {
      plistPath: `/Users/theo/Library/LaunchAgents/${LABEL}.plist`,
      logPath: `/Users/theo/Library/Logs/${LABEL}.log`,
    });

    const weekday = (day: number) =>
      [
        `    <dict>`,
        `      <key>Weekday</key>`,
        `      <integer>${day}</integer>`,
        `      <key>Hour</key>`,
        `      <integer>7</integer>`,
        `      <key>Minute</key>`,
        `      <integer>0</integer>`,
        `    </dict>`,
      ].join("\n");
    assert.strictEqual(
      plist,
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
        `<plist version="1.0">`,
        `<dict>`,
        `  <key>Label</key>`,
        `  <string>${LABEL}</string>`,
        `  <key>ProgramArguments</key>`,
        `  <array>`,
        `    <string>/bin/sh</string>`,
        `    <string>-c</string>`,
        `    <string>test -x "$0" &amp;&amp; test -f '${APP}/Resources/app.asar' || { rm -f '/Users/theo/Library/LaunchAgents/${LABEL}.plist'; launchctl bootout "gui/$(id -u)/${LABEL}"; exit 0; }; exec "$0" "$@"</string>`,
        `    <string>${APP}/MacOS/Control Plane</string>`,
        `    <string>${APP}/Resources/app.asar/apps/server/dist/bin.mjs</string>`,
        `    <string>schedules</string>`,
        `    <string>fire</string>`,
        `    <string>--state-dir</string>`,
        `    <string>/Users/theo/.t3/userdata</string>`,
        `    <string>--label</string>`,
        `    <string>${LABEL}</string>`,
        `  </array>`,
        `  <key>EnvironmentVariables</key>`,
        `  <dict>`,
        `    <key>ELECTRON_RUN_AS_NODE</key>`,
        `    <string>1</string>`,
        `    <key>PATH</key>`,
        `    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>`,
        `  </dict>`,
        `  <key>StartCalendarInterval</key>`,
        `  <array>`,
        ...[1, 2, 3, 4, 5].map(weekday),
        `  </array>`,
        // Outside the home, so a deleted home can still spawn the fire that removes this.
        `  <key>StandardOutPath</key>`,
        `  <string>/Users/theo/Library/Logs/${LABEL}.log</string>`,
        `  <key>StandardErrorPath</key>`,
        `  <string>/Users/theo/Library/Logs/${LABEL}.log</string>`,
        `  <key>AssociatedBundleIdentifiers</key>`,
        `  <array>`,
        `    <string>com.lucive.controlplane</string>`,
        `  </array>`,
        `</dict>`,
        `</plist>`,
        ``,
      ].join("\n"),
    );
  });

  it("names the app in Login Items only when it has an app id", () => {
    const { appId: _appId, ...withoutAppId } = makeEntry();
    const plist = renderSchedulePlist(withoutAppId, {
      plistPath: "/agents/x.plist",
      logPath: "/logs/x.log",
    });
    assert.notInclude(plist, "AssociatedBundleIdentifiers");
  });
});

/**
 * A fake `launchctl` over an in-memory gui domain. Every command is recorded;
 * `bootstrap` loads the job and `bootout` unloads it.
 */
const makeLaunchctl = (fs: FileSystem.FileSystem, plistPath: string) => {
  const control = {
    guiSession: true,
    disabled: false,
    loaded: false,
    bootstrapError: undefined as string | undefined,
    /** The plist on disk at each bootout; null when there was none. */
    plistAtBootout: [] as Array<string | null>,
  };
  const commands: Array<string> = [];
  const runner = ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(`${input.command} ${input.args.join(" ")}`);
        const [verb, target] = input.args;
        let code = 0;
        let stdout = "";
        let stderr = "";
        if (verb === "print") {
          code = (target === `gui/${UID}` ? control.guiSession : control.loaded) ? 0 : 113;
        } else if (verb === "print-disabled") {
          stdout = [
            "disabled services = {",
            `\t"com.apple.Siri.agent" => enabled`,
            ...(control.disabled ? [`\t"${LABEL}" => disabled`] : []),
            "}",
          ].join("\n");
        } else if (verb === "bootout") {
          control.plistAtBootout.push(
            yield* fs.readFileString(plistPath).pipe(Effect.orElseSucceed(() => null)),
          );
          code = control.loaded ? 0 : 3;
          control.loaded = false;
        } else if (verb === "bootstrap") {
          if (control.bootstrapError === undefined) control.loaded = true;
          else {
            code = 5;
            stderr = control.bootstrapError;
          }
        } else {
          code = 64;
        }
        return {
          stdout,
          stderr,
          code: ChildProcessSpawner.ExitCode(code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  /** Commands since the last call. */
  const take = () => commands.splice(0);
  return { control, runner, take };
};

const withBackend = <A, E>(
  body: (input: {
    readonly backend: Effect.Success<typeof makeLaunchdBackend>;
    readonly launchctl: ReturnType<typeof makeLaunchctl>;
    readonly plistPath: string;
    readonly logPath: string;
    readonly agentsDir: string;
    readonly entry: DesiredScheduleEntry;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launchd-backend-" });
    const agentsDir = path.join(home, "Library", "LaunchAgents");
    const plistPath = path.join(agentsDir, `${LABEL}.plist`);
    const logPath = path.join(home, "Library", "Logs", `${LABEL}.log`);
    const launchctl = makeLaunchctl(fs, plistPath);
    const backend = yield* makeLaunchdBackend.pipe(
      Effect.provideService(ProcessRunner, launchctl.runner),
      Effect.provideService(HostProcessHomeDirectory, home),
      Effect.provideService(HostProcessUserId, UID),
    );
    const entry = makeEntry();
    return yield* body({ backend, launchctl, plistPath, logPath, agentsDir, entry, fs });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const installSteps = (plistPath: string) => [
  `launchctl print gui/${UID}`,
  `launchctl print-disabled gui/${UID}`,
  `launchctl bootout --wait gui/${UID}/${LABEL}`,
  `launchctl bootstrap gui/${UID} ${plistPath}`,
];

describe("launchd backend", () => {
  it.effect(
    "installs with bootout --wait then bootstrap, never enable, and then leaves it alone",
    () =>
      withBackend(({ backend, launchctl, plistPath, logPath, entry, fs }) =>
        Effect.gen(function* () {
          const state = yield* backend.apply(LABEL, entry);

          assert.deepStrictEqual(state, { state: "installed", path: plistPath, problems: [] });
          assert.deepStrictEqual(launchctl.take(), installSteps(plistPath));
          assert.strictEqual(
            yield* fs.readFileString(plistPath),
            renderSchedulePlist(entry, { plistPath, logPath }),
          );
          // launchd will not create the log's directory.
          assert.isTrue(yield* fs.exists(logPath.replace(/\/[^/]+$/, "")));

          // Same bytes and a loaded job: only the read-only probes run.
          assert.strictEqual((yield* backend.apply(LABEL, entry)).state, "installed");
          assert.deepStrictEqual(launchctl.take(), [
            `launchctl print gui/${UID}`,
            `launchctl print-disabled gui/${UID}`,
            `launchctl print gui/${UID}/${LABEL}`,
          ]);
        }),
      ),
  );

  it.effect("reloads a changed calendar and reinstalls a hand-deleted plist", () =>
    withBackend(({ backend, launchctl, plistPath, entry, fs }) =>
      Effect.gen(function* () {
        yield* backend.apply(LABEL, entry);
        launchctl.take();
        const original = yield* fs.readFileString(plistPath);
        launchctl.control.plistAtBootout.length = 0;

        const edited = { ...entry, crons: ["0 9 * * *"] };
        yield* backend.apply(LABEL, edited);
        assert.deepStrictEqual(launchctl.take(), installSteps(plistPath));
        assert.include(yield* fs.readFileString(plistPath), "<integer>9</integer>");
        // Unloaded before the rewrite: a stop in between leaves nothing
        // loaded, never the new bytes beside a job on the old calendar.
        assert.deepStrictEqual(launchctl.control.plistAtBootout, [original]);

        yield* fs.remove(plistPath);
        const state = yield* backend.apply(LABEL, edited);
        assert.strictEqual(state.state, "installed");
        assert.deepStrictEqual(launchctl.take(), installSteps(plistPath));
        assert.isTrue(yield* fs.exists(plistPath));
      }),
    ),
  );

  it.effect("keeps the log launchd appends to at its last 256 KB", () =>
    withBackend(({ backend, logPath, entry, fs }) =>
      Effect.gen(function* () {
        const line = `${"x".repeat(1023)}\n`;
        yield* fs.makeDirectory(logPath.replace(/\/[^/]+$/, ""), { recursive: true });
        yield* fs.writeFileString(logPath, line.repeat(300));

        yield* backend.apply(LABEL, entry);

        const kept = yield* fs.readFileString(logPath);
        assert.isAtMost(kept.length, SCHEDULE_LOG_MAX_BYTES);
        assert.isTrue(kept.endsWith(line));
      }),
    ),
  );

  it.effect("reports a disabled entry on every reconcile and never overrides it", () =>
    withBackend(({ backend, launchctl, plistPath, entry }) =>
      Effect.gen(function* () {
        launchctl.control.disabled = true;
        for (const crons of [entry.crons, ["0 9 * * *"]]) {
          const state = yield* backend.apply(LABEL, { ...entry, crons });
          assert.deepStrictEqual(state, {
            state: "installed",
            path: plistPath,
            problems: ["entry-disabled"],
          });
          assert.deepStrictEqual(launchctl.take(), [
            `launchctl print gui/${UID}`,
            `launchctl print-disabled gui/${UID}`,
          ]);
        }
      }),
    ),
  );

  it.effect("writes the plist for the next login when there is no GUI session", () =>
    withBackend(({ backend, launchctl, plistPath, entry, fs }) =>
      Effect.gen(function* () {
        launchctl.control.guiSession = false;
        const state = yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(state.problems, ["no-gui-session"]);
        assert.deepStrictEqual(launchctl.take(), [`launchctl print gui/${UID}`]);
        assert.isTrue(yield* fs.exists(plistPath));
      }),
    ),
  );

  it.effect("reports a failed bootstrap with its stderr", () =>
    withBackend(({ backend, launchctl, plistPath, entry }) =>
      Effect.gen(function* () {
        launchctl.control.bootstrapError = "Bootstrap failed: 5: Input/output error";
        const state = yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(state, {
          state: "failed",
          path: plistPath,
          detail: "Bootstrap failed: 5: Input/output error",
          problems: ["install-failed"],
        });
      }),
    ),
  );

  it.effect("refuses a program that runs from a disk image, with zero calls", () =>
    withBackend(({ backend, launchctl, plistPath, entry, fs }) =>
      Effect.gen(function* () {
        const fromDiskImage = {
          ...entry,
          program: ["/Volumes/Control Plane/Control Plane.app/Contents/MacOS/Control Plane"],
          hasEntryScript: false,
        };
        const state = yield* backend.apply(LABEL, fromDiskImage);
        assert.deepStrictEqual(state.problems, ["ephemeral-path"]);
        assert.deepStrictEqual(launchctl.take(), []);
        assert.isFalse(yield* fs.exists(plistPath));
      }),
    ),
  );

  it.effect("removes only its own plist, and makes zero calls when there is none", () =>
    withBackend(({ backend, launchctl, plistPath, agentsDir, entry, fs }) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* backend.apply(LABEL, null)).state, "not-needed");
        assert.deepStrictEqual(launchctl.take(), []);

        const foreign = `${agentsDir}/com.example.backup.plist`;
        yield* fs.makeDirectory(agentsDir, { recursive: true });
        yield* fs.writeFileString(foreign, "<plist>theirs</plist>");
        yield* backend.apply(LABEL, entry);
        launchctl.take();

        assert.strictEqual((yield* backend.apply(LABEL, null)).state, "not-needed");
        assert.deepStrictEqual(launchctl.take(), [`launchctl bootout --wait gui/${UID}/${LABEL}`]);
        assert.isFalse(yield* fs.exists(plistPath));
        assert.strictEqual(yield* fs.readFileString(foreign), "<plist>theirs</plist>");
        assert.isFalse(launchctl.control.loaded);
      }),
    ),
  );

  it.effect("deletes the plist before bootout when removed from inside its own fire", () =>
    withBackend(({ backend, launchctl, plistPath, entry, fs }) =>
      Effect.gen(function* () {
        yield* backend.apply(LABEL, entry);
        launchctl.take();
        launchctl.control.plistAtBootout.length = 0;

        yield* backend.remove(LABEL);
        assert.deepStrictEqual(launchctl.take(), [`launchctl bootout gui/${UID}/${LABEL}`]);
        // bootout ends the job running this very command, so the file went first.
        assert.deepStrictEqual(launchctl.control.plistAtBootout, [null]);
        assert.isFalse(yield* fs.exists(plistPath));
      }),
    ),
  );
});
