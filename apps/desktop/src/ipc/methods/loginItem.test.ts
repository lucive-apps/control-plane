import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import { getOpenAtLogin, setOpenAtLogin } from "./loginItem.ts";

/** A login item store in memory; `status` is what macOS 13+ reports for it. */
const makeLoginItems = (status: Electron.LoginItemSettings["status"] = "enabled") => {
  const calls: Array<string> = [];
  let openAtLogin = false;
  const layer = Layer.mock(ElectronApp.ElectronApp, {
    getLoginItemSettings: Effect.sync(() => {
      calls.push("get");
      return {
        openAtLogin: openAtLogin && status === "enabled",
        status: openAtLogin ? status : "not-registered",
      } as Electron.LoginItemSettings;
    }),
    setLoginItemSettings: (settings) =>
      Effect.sync(() => {
        calls.push(`set ${settings.openAtLogin}`);
        openAtLogin = settings.openAtLogin === true;
      }),
  });
  return { calls, layer };
};

const environmentLayer = (input: { isPackaged: boolean; platform: NodeJS.Platform }) =>
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      input as unknown as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  );

describe("Open at login IPC", () => {
  it.effect("is unsupported without touching Electron in dev builds and on Linux", () =>
    Effect.gen(function* () {
      const loginItems = makeLoginItems();
      const unsupported = { supported: false, enabled: false, requiresApproval: false };
      for (const environment of [
        { isPackaged: false, platform: "darwin" as const },
        { isPackaged: true, platform: "linux" as const },
      ]) {
        const layer = Layer.merge(loginItems.layer, environmentLayer(environment));
        assert.deepEqual(
          yield* getOpenAtLogin.handler(undefined).pipe(Effect.provide(layer)),
          unsupported,
        );
        assert.deepEqual(
          yield* setOpenAtLogin.handler(true).pipe(Effect.provide(layer)),
          unsupported,
        );
      }
      assert.deepEqual(loginItems.calls, []);
    }),
  );

  it.effect("turns on in the installed app and reports a pending macOS approval", () =>
    Effect.gen(function* () {
      const loginItems = makeLoginItems("requires-approval");
      const layer = Layer.merge(
        loginItems.layer,
        environmentLayer({ isPackaged: true, platform: "darwin" }),
      );

      const on = yield* setOpenAtLogin.handler(true).pipe(Effect.provide(layer));
      assert.deepEqual(on, { supported: true, enabled: true, requiresApproval: true });
      const off = yield* setOpenAtLogin.handler(false).pipe(Effect.provide(layer));
      assert.deepEqual(off, { supported: true, enabled: false, requiresApproval: false });
      assert.deepEqual(loginItems.calls, ["set true", "get", "set false", "get"]);
    }),
  );
});
