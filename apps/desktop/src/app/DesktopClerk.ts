import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import { T3_CONNECT_ENABLED } from "@t3tools/shared/forkFeatures";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { resolveDesktopChromiumUserDataPath } from "./DesktopEarlyElectronStartup.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { syncHomeProbe } from "./DesktopHomeProbe.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedError<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedError<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = T3_CONNECT_ENABLED
  ? resolveDesktopClerkFrontendApiHostname(
      typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
        ? undefined
        : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
    )
  : undefined;

function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

const configureInstance = (isPrimaryInstance: boolean) =>
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
    const runPromise = Effect.runPromiseWith(context);

    // The layer acquired Electron's single-instance lock at construction (the
    // SDK bridge does so that OAuth deep-link callbacks on Windows/Linux reach
    // the running app). A secondary instance quits; app.quit() is
    // asynchronous, so stop bootstrap here before whenReady can fire.
    if (!isPrimaryInstance) {
      yield* electronApp.quit;
      return yield* Effect.interrupt;
    }

    yield* electronApp.on("second-instance", () => {
      void runPromise(
        Effect.gen(function* () {
          const mainWindow = yield* electronWindow.currentMainOrFirst;
          if (Option.isSome(mainWindow)) {
            yield* electronWindow.reveal(mainWindow.value);
          }
        }),
      );
    });
  }).pipe(Effect.withSpan("desktop.clerk.configure"));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  // Electron scopes the single-instance lock to the userData directory and
  // creates that directory when the lock is acquired. The SDK bridge takes
  // the lock at creation, so userData must already point at the real
  // directory here — under the default productName-derived path, acquiring
  // the lock would create "T3 Code (Alpha)" and make the legacy-install
  // detection in resolveUserDataPath match on fresh installs.
  // The bridge also registers its scheme as privileged, which Electron rejects
  // once `ready` has fired, so nothing before it may await: an awaited read
  // hands the main thread back to Electron, which can emit `ready` first.
  const userDataPath = resolveDesktopChromiumUserDataPath({
    appDataDirectory: environment.appDataDirectory,
    isDevelopment: environment.isDevelopment,
    joinPath: environment.path.join,
    pathExists: syncHomeProbe.exists,
  });
  yield* electronApp.setPath("userData", userDataPath);

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({ configure: configureInstance(bridge.isPrimaryInstance) });
});

export const layer = Layer.effect(DesktopClerk, make);

/**
 * DesktopClerk for builds with T3 Connect off: no SDK bridge, so no Clerk IPC,
 * OAuth scheme, or privileged scheme registration at startup. Keeps what the
 * app itself relied on the bridge for: userData set before the instance lock,
 * and one instance on Windows and Linux (macOS routes relaunches to the
 * running app). Synchronous like `make`, so `ready` cannot fire first.
 */
const makeWithoutBridge = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  yield* electronApp.setPath(
    "userData",
    resolveDesktopChromiumUserDataPath({
      appDataDirectory: environment.appDataDirectory,
      isDevelopment: environment.isDevelopment,
      joinPath: environment.path.join,
      pathExists: syncHomeProbe.exists,
    }),
  );
  const isPrimaryInstance =
    environment.platform === "darwin" || Electron.app.requestSingleInstanceLock();

  return DesktopClerk.of({ configure: configureInstance(isPrimaryInstance) });
});

export const layerWithoutBridge = Layer.effect(DesktopClerk, makeWithoutBridge);
