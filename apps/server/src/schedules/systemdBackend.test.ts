import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessHomeDirectory, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ProcessRunner } from "../processRunner.ts";
import type { DesiredScheduleEntry } from "./ScheduleHost.ts";
import { makeSystemdBackend, renderScheduleUnits } from "./systemdBackend.ts";

const UID = 1000;
const LABEL = "com.lucive.controlplane.schedules.0a1b2c3d";
const TIMER = `${LABEL}.timer`;
const SCRIPT = "/home/theo/.npm/_npx/4f2a/node_modules/t3/dist/bin.mjs";

const makeEntry = (): DesiredScheduleEntry => ({
  label: LABEL,
  program: [
    "/usr/bin/node",
    SCRIPT,
    "schedules",
    "fire",
    "--state-dir",
    "/home/theo/.t3/userdata",
    "--label",
    LABEL,
  ],
  hasEntryScript: true,
  env: {},
  crons: ["0 7 * * 1-5", "0 */2 * * *"],
  timeZone: "America/Denver",
});

describe("renderScheduleUnits", () => {
  it("renders a guarded oneshot and a persistent timer in the host zone", () => {
    const unitDir = "/home/theo/.config/systemd/user";
    const units = renderScheduleUnits(
      { ...makeEntry(), env: { ELECTRON_RUN_AS_NODE: "1", LABEL: "100%" } },
      { unitDir },
    );

    const cleanup = [
      `systemctl --user disable --now ${TIMER}`,
      `rm -f '${unitDir}/${LABEL}.service' '${unitDir}/${TIMER}'`,
      `systemctl --user daemon-reload`,
    ].join("; ");
    assert.strictEqual(
      units.service,
      [
        "[Unit]",
        "Description=Control Plane schedules",
        "",
        "[Service]",
        "Type=oneshot",
        "Environment=ELECTRON_RUN_AS_NODE=1",
        // `%` doubles so systemd does not read it as a specifier.
        "Environment=LABEL=100%%",
        // `$` doubles so systemd passes the guard's `$0` and `$@` to the shell.
        `ExecStart=/bin/sh -c "test -x \\"$$0\\" && test -f \\"$$1\\" || { ${cleanup}; exit 0; }; exec \\"$$0\\" \\"$$@\\"" /usr/bin/node ${SCRIPT} schedules fire --state-dir /home/theo/.t3/userdata --label ${LABEL}`,
        // No log file: output goes to the journal, which outlives any home.
        "",
      ].join("\n"),
    );
    assert.strictEqual(
      units.timer,
      [
        "[Unit]",
        "Description=Control Plane schedules",
        "",
        "[Timer]",
        "OnCalendar=Mon..Fri *-*-* 07:00:00 America/Denver",
        "OnCalendar=*-*-* 00/2:00:00 America/Denver",
        "Persistent=true",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
      ].join("\n"),
    );
  });
});

/** A fake user manager: `enable --now` enables and starts the timer, `disable --now` undoes it. */
const makeSystemd = () => {
  const control = {
    manager: true,
    linger: "yes",
    enabled: "not-found",
    active: false,
    /** Unit files changed on disk since the last `daemon-reload`. */
    needsReload: false,
    enableError: undefined as string | undefined,
  };
  const commands: Array<string> = [];
  const runner = ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        commands.push(`${input.command} ${input.args.join(" ")}`);
        let code = 0;
        let stdout = "";
        let stderr = "";
        switch (input.args.find((arg) => arg !== "--user")) {
          case "show-environment":
            code = control.manager ? 0 : 1;
            break;
          case "show-user":
            stdout = `${control.linger}\n`;
            break;
          case "is-enabled":
            stdout = `${control.enabled}\n`;
            code = control.enabled === "enabled" ? 0 : 1;
            break;
          case "is-active":
            code = control.active ? 0 : 3;
            break;
          case "show":
            stdout = control.needsReload ? "yes\n\nno\n" : "no\n\nno\n";
            break;
          case "daemon-reload":
            control.needsReload = false;
            break;
          case "enable":
            if (control.enableError !== undefined) {
              code = 1;
              stderr = control.enableError;
              break;
            }
            control.enabled = "enabled";
            control.active = true;
            break;
          case "disable":
            control.enabled = "disabled";
            control.active = false;
            break;
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
  return { control, runner, take: () => commands.splice(0) };
};

const withBackend = <A, E>(
  body: (input: {
    readonly backend: Effect.Success<typeof makeSystemdBackend>;
    readonly systemd: ReturnType<typeof makeSystemd>;
    readonly unitDir: string;
    readonly entry: DesiredScheduleEntry;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-systemd-backend-" });
    const systemd = makeSystemd();
    const backend = yield* makeSystemdBackend.pipe(
      Effect.provideService(ProcessRunner, systemd.runner),
      Effect.provideService(HostProcessHomeDirectory, home),
      Effect.provideService(HostProcessUserId, UID),
    );
    const unitDir = path.join(home, ".config", "systemd", "user");
    const entry = makeEntry();
    return yield* body({ backend, systemd, unitDir, entry, fs });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const PROBES = [
  "systemctl --user show-environment",
  `loginctl show-user ${UID} --property=Linger --value`,
  `systemctl --user is-enabled ${TIMER}`,
];
const STEADY = [
  ...PROBES,
  `systemctl --user is-active ${TIMER}`,
  `systemctl --user show --property=NeedDaemonReload --value ${TIMER} ${LABEL}.service`,
];
const RELOAD_AND_ENABLE = [
  "systemctl --user daemon-reload",
  `systemctl --user enable --now ${TIMER}`,
];

describe("systemd backend", () => {
  it.effect("writes both units, then reloads and enables the timer once", () =>
    withBackend(({ backend, systemd, unitDir, entry, fs }) =>
      Effect.gen(function* () {
        const state = yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(state, {
          state: "installed",
          path: `${unitDir}/${TIMER}`,
          problems: [],
        });
        assert.deepStrictEqual(systemd.take(), [...PROBES, ...RELOAD_AND_ENABLE]);
        assert.strictEqual(
          yield* fs.readFileString(`${unitDir}/${TIMER}`),
          renderScheduleUnits(entry, { unitDir }).timer,
        );

        yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(systemd.take(), STEADY);
      }),
    ),
  );

  it.effect("reloads unit files written before a stop that skipped the reload", () =>
    withBackend(({ backend, systemd, entry }) =>
      Effect.gen(function* () {
        yield* backend.apply(LABEL, entry);
        systemd.take();
        // Same bytes on disk, but the manager still runs what it loaded before.
        systemd.control.needsReload = true;

        const state = yield* backend.apply(LABEL, entry);
        assert.strictEqual(state.state, "installed");
        assert.deepStrictEqual(systemd.take(), [...STEADY, ...RELOAD_AND_ENABLE]);
        assert.isFalse(systemd.control.needsReload);
      }),
    ),
  );

  it.effect("removes the units when enabling fails, so the next reconcile retries", () =>
    withBackend(({ backend, systemd, unitDir, entry, fs }) =>
      Effect.gen(function* () {
        systemd.control.enableError = "Failed to enable unit: Access denied";
        const state = yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(state, {
          state: "failed",
          detail: "Failed to enable unit: Access denied",
          problems: ["install-failed"],
        });
        // Left in place, the unenabled timer would read as `disabled` from now on.
        assert.isFalse(yield* fs.exists(`${unitDir}/${TIMER}`));
        assert.isFalse(yield* fs.exists(`${unitDir}/${LABEL}.service`));
        systemd.take();

        // With its files gone and the manager reloaded, systemd forgets the timer.
        systemd.control.enabled = "not-found";
        systemd.control.enableError = undefined;
        const retried = yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(retried.problems, []);
        assert.strictEqual(retried.state, "installed");
        assert.deepStrictEqual(systemd.take(), [...PROBES, ...RELOAD_AND_ENABLE]);
      }),
    ),
  );

  it.effect("is unsupported without a user manager, and writes nothing", () =>
    withBackend(({ backend, systemd, unitDir, entry, fs }) =>
      Effect.gen(function* () {
        systemd.control.manager = false;
        const state = yield* backend.apply(LABEL, entry);
        assert.deepStrictEqual(state, { state: "unsupported", problems: ["no-user-manager"] });
        assert.deepStrictEqual(systemd.take(), ["systemctl --user show-environment"]);
        assert.isFalse(yield* fs.exists(`${unitDir}/${TIMER}`));
      }),
    ),
  );

  it.effect("installs without lingering and warns that it runs only while logged in", () =>
    withBackend(({ backend, systemd, entry }) =>
      Effect.gen(function* () {
        systemd.control.linger = "no";
        const state = yield* backend.apply(LABEL, entry);
        assert.strictEqual(state.state, "installed");
        assert.deepStrictEqual(state.problems, ["no-linger"]);
        assert.isTrue(systemd.control.active);
      }),
    ),
  );

  it.effect("reports a masked or disabled timer and never re-enables it", () =>
    withBackend(({ backend, systemd, entry }) =>
      Effect.gen(function* () {
        for (const enabled of ["masked", "disabled"]) {
          systemd.control.enabled = enabled;
          const state = yield* backend.apply(LABEL, { ...entry, crons: ["0 9 * * *"] });
          assert.strictEqual(state.state, "installed");
          assert.deepStrictEqual(state.problems, ["entry-disabled"]);
          assert.deepStrictEqual(systemd.take(), PROBES);
        }
      }),
    ),
  );

  it.effect("removes both units, and makes zero calls when there are none", () =>
    withBackend(({ backend, systemd, unitDir, entry, fs }) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* backend.apply(LABEL, null)).state, "not-needed");
        assert.deepStrictEqual(systemd.take(), []);

        yield* backend.apply(LABEL, entry);
        systemd.take();
        assert.strictEqual((yield* backend.apply(LABEL, null)).state, "not-needed");
        assert.deepStrictEqual(systemd.take(), [
          `systemctl --user disable --now ${TIMER}`,
          "systemctl --user daemon-reload",
        ]);
        assert.isFalse(yield* fs.exists(`${unitDir}/${TIMER}`));
        assert.isFalse(yield* fs.exists(`${unitDir}/${LABEL}.service`));
      }),
    ),
  );
});
