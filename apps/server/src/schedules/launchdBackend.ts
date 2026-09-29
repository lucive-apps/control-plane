/**
 * The macOS schedule entry: one LaunchAgent per home. Fork-owned.
 *
 * The plist runs the guarded `schedules fire` on a `StartCalendarInterval`
 * array and nothing else: no `RunAtLoad`, no `KeepAlive`. Only a calendar,
 * program or environment change alters its bytes (names and prompts are never
 * in it), so the reconcile rewrites it rarely and macOS rarely repeats its
 * "Background Items Added" prompt.
 *
 * It never runs `launchctl enable`. A user who turns the entry off in Login
 * Items gets a disable override that refuses bootstrap; that stays their call,
 * and the host reports `entry-disabled` until they turn it back on.
 *
 * The job's output goes to `~/Library/Logs/<label>.log`, never into the home:
 * launchd will not spawn a job whose log directory is gone, so a log inside a
 * deleted home would stop the fire that removes the entry for that home.
 *
 * @module launchdBackend
 */
import type { ScheduleHostProblem } from "@t3tools/contracts";
import { HostProcessHomeDirectory, HostProcessUserId } from "@t3tools/shared/hostProcess";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { trimScheduleLog } from "./attemptLog.ts";
import {
  ENTRY_GUARD,
  entryProgramArguments,
  ephemeralProgramPath,
  shellQuote,
} from "./entryProgram.ts";
import { launchdCalendar } from "./scheduleCalendar.ts";
import type {
  DesiredScheduleEntry,
  ScheduleEntryState,
  ScheduleHostBackend,
} from "./ScheduleHost.ts";

/** launchd jobs start without a login shell's PATH; the guard needs only these. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PROBE_TIMEOUT: Duration.Input = "10 seconds";
/** `bootout --wait` blocks while a fire drains; a fire returns in seconds. */
const BOOTOUT_TIMEOUT: Duration.Input = "30 seconds";

/** Plist values are emitted as XML text nodes; only these three need escaping (as `bootService.ts`). */
function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export const launchAgentPath = (path: Path.Path, homeDir: string, label: string) =>
  path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);

/** Where launchd appends the fire's output. `~/Library/Logs` outlives any T3 home. */
export const launchAgentLogPath = (path: Path.Path, homeDir: string, label: string) =>
  path.join(homeDir, "Library", "Logs", `${label}.log`);

/** The guard's cleanup. bootout ends this very job, so the plist goes first. */
const guardCleanup = (label: string, plistPath: string) =>
  `rm -f ${shellQuote(plistPath)}; launchctl bootout "gui/$(id -u)/${label}"`;

/** Pure: the LaunchAgent plist for `entry`, installed at `plistPath`, logging to `logPath`. */
export function renderSchedulePlist(
  entry: DesiredScheduleEntry,
  options: { readonly plistPath: string; readonly logPath: string; readonly guard?: boolean },
): string {
  const program = entryProgramArguments(
    { ...entry, cleanup: guardCleanup(entry.label, options.plistPath) },
    options.guard ?? ENTRY_GUARD,
  );
  const env = Object.entries({ ...entry.env, PATH: LAUNCHD_PATH }).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const string = (value: string) => `<string>${escapeXmlText(value)}</string>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${string(entry.label)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...program.map((argument) => `    ${string(argument)}`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.flatMap(([name, value]) => [
      `    <key>${escapeXmlText(name)}</key>`,
      `    ${string(value)}`,
    ]),
    `  </dict>`,
    `  <key>StartCalendarInterval</key>`,
    `  <array>`,
    ...launchdCalendar(entry.crons).flatMap((interval) => [
      `    <dict>`,
      ...Object.entries(interval).flatMap(([key, value]) => [
        `      <key>${key}</key>`,
        `      <integer>${value}</integer>`,
      ]),
      `    </dict>`,
    ]),
    `  </array>`,
    `  <key>StandardOutPath</key>`,
    `  ${string(options.logPath)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${string(options.logPath)}`,
    // Groups the entry under the app in System Settings > Login Items.
    ...(entry.appId === undefined
      ? []
      : [
          `  <key>AssociatedBundleIdentifiers</key>`,
          `  <array>`,
          `    ${string(entry.appId)}`,
          `  </array>`,
        ]),
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `launchctl print-disabled` lists overrides as `"<label>" => disabled` (older macOS: `=> true`). */
function isLabelDisabled(printDisabledOutput: string, label: string): boolean {
  return new RegExp(`"${escapeRegExp(label)}"\\s*=>\\s*(disabled|true)\\b`).test(
    printDisabledOutput,
  );
}

/**
 * The launchd backend for the current user. Every path hangs off the injected
 * home directory and every command goes through the injected `ProcessRunner`,
 * so tests never reach the real LaunchAgents or `launchctl`.
 */
export const makeLaunchdBackend = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const homeDir = yield* HostProcessHomeDirectory;
  const uid = yield* HostProcessUserId;
  const domain = `gui/${uid}`;
  const plistOf = (label: string) => launchAgentPath(path, homeDir, label);
  const logOf = (label: string) => launchAgentLogPath(path, homeDir, label);

  const launchctl = (args: ReadonlyArray<string>, timeout: Duration.Input = PROBE_TIMEOUT) =>
    runner
      .run({
        command: "launchctl",
        args,
        timeout,
        // `print gui/<uid>` lists every job in the session; only the exit code matters.
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;

  const readPlist = (plistPath: string) =>
    fs.readFileString(plistPath).pipe(Effect.option, Effect.map(Option.getOrUndefined));

  /** Writes the plist when its bytes differ, and the log dir launchd will not create. */
  const writePlist = (plistPath: string, contents: string, logPath: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
      if ((yield* readPlist(plistPath)) === contents) return;
      yield* fs.makeDirectory(path.dirname(plistPath), { recursive: true });
      yield* fs.writeFileString(plistPath, contents, { mode: 0o644 });
    });

  const failed = (problem: ScheduleHostProblem, detail: string, plistPath?: string) =>
    ({
      state: "failed",
      ...(plistPath === undefined ? {} : { path: plistPath }),
      detail,
      problems: [problem],
    }) satisfies ScheduleEntryState;

  /** Nothing to do without a plist: the only way this backend loads a job is from it. */
  const unload = (label: string) =>
    Effect.gen(function* () {
      const plistPath = plistOf(label);
      if (!(yield* fs.exists(plistPath))) return;
      yield* launchctl(["bootout", "--wait", `${domain}/${label}`], BOOTOUT_TIMEOUT);
      yield* fs.remove(plistPath, { force: true });
    });

  const install = (label: string, entry: DesiredScheduleEntry) =>
    Effect.gen(function* () {
      const plistPath = plistOf(label);
      const logPath = logOf(label);
      const installed = (problems: ReadonlyArray<ScheduleHostProblem>): ScheduleEntryState => ({
        state: "installed",
        path: plistPath,
        problems,
      });
      // The hourly reconcile keeps the log launchd appends to at its last 256 KB.
      yield* trimScheduleLog(logPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.ignore,
      );
      const contents = renderSchedulePlist(entry, { plistPath, logPath });
      // No GUI session (nobody logged in at the screen): the plist loads at the next login.
      if (!succeeded(yield* launchctl(["print", domain]))) {
        yield* writePlist(plistPath, contents, logPath);
        return installed(["no-gui-session"]);
      }
      // A saved disable override refuses bootstrap, and is the user's to lift.
      const disabled = yield* launchctl(["print-disabled", domain]);
      if (Option.isSome(disabled) && isLabelDisabled(disabled.value.stdout, label)) {
        yield* writePlist(plistPath, contents, logPath);
        return installed(["entry-disabled"]);
      }
      if (
        (yield* readPlist(plistPath)) === contents &&
        succeeded(yield* launchctl(["print", `${domain}/${label}`]))
      ) {
        return installed([]);
      }
      // Unload before writing: stopped anywhere after this, the next
      // reconcile finds nothing loaded and bootstraps the new bytes. Written
      // first, a stop would leave the new bytes beside a job still on the old
      // calendar, which the next reconcile would trust. Without --wait, a
      // bootstrap while the old job drains fails with EIO.
      yield* launchctl(["bootout", "--wait", `${domain}/${label}`], BOOTOUT_TIMEOUT);
      yield* writePlist(plistPath, contents, logPath);
      const bootstrap = yield* launchctl(["bootstrap", domain, plistPath]);
      if (!succeeded(bootstrap)) {
        const stderr = Option.isSome(bootstrap) ? bootstrap.value.stderr.trim() : "";
        return failed("install-failed", stderr || "launchctl bootstrap failed.", plistPath);
      }
      return installed([]);
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
      Effect.catch((cause) =>
        Effect.succeed(failed("install-failed", String(cause), plistOf(label))),
      ),
    );
  };

  const probe: ScheduleHostBackend["Service"]["probe"] = (label) =>
    fs.exists(plistOf(label)).pipe(
      Effect.map((exists): ScheduleEntryState =>
        exists
          ? { state: "installed", path: plistOf(label), problems: [] }
          : { state: "not-needed", problems: [] },
      ),
      Effect.catch((cause) => Effect.succeed(failed("install-failed", String(cause)))),
    );

  /**
   * For callers outside the server. `schedules fire` runs as this very job,
   * and bootout ends it, so the plist goes first and nothing waits.
   */
  const remove: ScheduleHostBackend["Service"]["remove"] = (label) =>
    Effect.gen(function* () {
      const plistPath = plistOf(label);
      if (!(yield* fs.exists(plistPath))) return;
      yield* fs.remove(plistPath, { force: true });
      yield* launchctl(["bootout", `${domain}/${label}`]);
    }).pipe(Effect.ignore);

  return {
    scheduler: "launchd",
    mode: "os",
    apply,
    probe,
    remove,
  } satisfies ScheduleHostBackend["Service"];
});
