import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const OpenAtLoginState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  requiresApproval: Schema.Boolean,
});
type OpenAtLoginState = typeof OpenAtLoginState.Type;

const UNSUPPORTED: OpenAtLoginState = { supported: false, enabled: false, requiresApproval: false };

/**
 * Only the installed app registers itself: a dev build is not what should
 * open at login, and Electron has no login items on Linux. Schedules run
 * only while the app is open, which is why this setting exists.
 */
const isSupported = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return environment.isPackaged && environment.platform !== "linux";
});

const readState = Effect.gen(function* () {
  const app = yield* ElectronApp.ElectronApp;
  const settings = yield* app.getLoginItemSettings;
  // macOS 13+ can hold a registration until the user allows it in System
  // Settings; the user's choice is still on.
  const requiresApproval = settings.status === "requires-approval";
  return {
    supported: true,
    enabled: settings.openAtLogin || requiresApproval,
    requiresApproval,
  } satisfies OpenAtLoginState;
});

export const getOpenAtLogin = makeIpcMethod({
  channel: IpcChannels.GET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Void,
  result: OpenAtLoginState,
  handler: Effect.fn("desktop.ipc.loginItem.get")(function* () {
    return (yield* isSupported) ? yield* readState : UNSUPPORTED;
  }),
});

export const setOpenAtLogin = makeIpcMethod({
  channel: IpcChannels.SET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Boolean,
  result: OpenAtLoginState,
  handler: Effect.fn("desktop.ipc.loginItem.set")(function* (enabled) {
    if (!(yield* isSupported)) return UNSUPPORTED;
    const app = yield* ElectronApp.ElectronApp;
    yield* app.setLoginItemSettings({ openAtLogin: enabled });
    return yield* readState;
  }),
});
