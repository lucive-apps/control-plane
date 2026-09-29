import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ProcessRunner, layer as ProcessRunnerLayer } from "../processRunner.ts";
import { entryProgramArguments, ephemeralProgramPath, shellQuote } from "./entryProgram.ts";

const FIRE = ["schedules", "fire", "--state-dir", "/Users/theo/.t3/userdata"];

describe("entryProgramArguments", () => {
  it("checks the entry script only when there is one", () => {
    const [, , withScript] = entryProgramArguments({
      program: ["/usr/local/bin/node", "/opt/t3/bin.mjs", ...FIRE],
      hasEntryScript: true,
      cleanup: "rm -f x",
    });
    expect(withScript).toBe(`test -x "$0" && test -f "$1" || { rm -f x; exit 0; }; exec "$0" "$@"`);
    const [, , executableOnly] = entryProgramArguments({
      program: ["/opt/t3/t3", ...FIRE],
      hasEntryScript: false,
      cleanup: "rm -f x",
    });
    expect(executableOnly).toBe(`test -x "$0" || { rm -f x; exit 0; }; exec "$0" "$@"`);
  });

  it("checks the archive for a script inside app.asar, which the shell cannot see into", () => {
    const app = "/Applications/Control Plane.app/Contents";
    const [shell, flag, script, ...program] = entryProgramArguments({
      program: [`${app}/MacOS/Control Plane`, `${app}/Resources/app.asar/apps/server/dist/bin.mjs`],
      hasEntryScript: true,
      cleanup: "true",
    });
    expect([shell, flag]).toEqual(["/bin/sh", "-c"]);
    expect(script).toContain(`test -f '${app}/Resources/app.asar' ||`);
    expect(program).toEqual([
      `${app}/MacOS/Control Plane`,
      `${app}/Resources/app.asar/apps/server/dist/bin.mjs`,
    ]);
  });

  it("renders the bare program without the guard", () => {
    const program = ["/opt/t3/t3", ...FIRE];
    expect(
      entryProgramArguments({ program, hasEntryScript: false, cleanup: "true" }, false),
    ).toEqual(program);
  });
});

describe("ephemeralProgramPath", () => {
  it("refuses translocated, disk image and AppImage paths, for the executable or the script", () => {
    const ephemeral = [
      "/private/var/folders/x/AppTranslocation/1F2E/d/Control Plane.app/Contents/MacOS/Control Plane",
      "/Volumes/Control Plane/Control Plane.app/Contents/MacOS/Control Plane",
      "/tmp/.mount_ctrlplXyZ/control-plane",
    ];
    for (const execPath of ephemeral) {
      expect(ephemeralProgramPath({ program: [execPath, ...FIRE], hasEntryScript: false })).toBe(
        execPath,
      );
    }
    expect(
      ephemeralProgramPath({
        program: ["/usr/local/bin/node", "/Volumes/usb/t3/bin.mjs", ...FIRE],
        hasEntryScript: true,
      }),
    ).toBe("/Volumes/usb/t3/bin.mjs");
    expect(
      ephemeralProgramPath({
        program: ["/Applications/Control Plane.app/Contents/MacOS/Control Plane", ...FIRE],
        hasEntryScript: false,
      }),
    ).toBeUndefined();
  });
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- the guard is POSIX shell; the skip needs the real host.
describe.skipIf(process.platform === "win32")("the guard under /bin/sh", () => {
  /** Runs the guarded `program` for real, with a cleanup that leaves a marker file. */
  const runGuard = (program: ReadonlyArray<string>, hasEntryScript: boolean) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-entry-guard-" });
      const marker = `${dir}/cleaned up`;
      const [command, ...args] = entryProgramArguments({
        program,
        hasEntryScript,
        cleanup: `touch ${shellQuote(marker)}`,
      });
      const result = yield* (yield* ProcessRunner).run({ command: command!, args });
      return { code: result.code, stdout: result.stdout, cleaned: yield* fs.exists(marker) };
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer))),
    );

  it.effect("runs the program with its arguments when it exists", () =>
    Effect.gen(function* () {
      expect(yield* runGuard(["/bin/echo", "fire's", "--state-dir", "/a b"], false)).toEqual({
        code: 0,
        stdout: "fire's --state-dir /a b\n",
        cleaned: false,
      });
    }),
  );

  it.effect("removes its entry and exits 0 when the program or script is gone", () =>
    Effect.gen(function* () {
      expect(
        yield* runGuard(["/Applications/Gone.app/Contents/MacOS/Gone", ...FIRE], false),
      ).toMatchObject({ code: 0, cleaned: true });
      expect(yield* runGuard(["/bin/echo", "/no/such/npx-cache/bin.mjs", ...FIRE], true)).toEqual({
        code: 0,
        stdout: "",
        cleaned: true,
      });
    }),
  );
});
