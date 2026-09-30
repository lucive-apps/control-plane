import { useAtomValue } from "@effect/atom-react";
import {
  ConnectionBlockedError,
  ConnectionDriverOverride,
  type EnvironmentConnectionLease,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentCacheStore, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { ShellSnapshotLoader, shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import {
  ThreadSnapshotLoader,
  threadSnapshotLoaderLayer,
} from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  DEMO_ENVIRONMENT_ID,
  DEMO_ENVIRONMENT_LABEL,
  DEMO_HTTP_BASE_URL,
  DEMO_WS_BASE_URL,
} from "./demoFixtures";
import { readDemoModeFlag, writeDemoModeFlag } from "./demoModeFlag";
import { DemoServer } from "./demoServer";

/**
 * Demo mode lets someone without a computer (an App Store reviewer, say)
 * explore the app on sample data. It registers one platform environment,
 * "Demo Mac", whose connection is served by an in-process `DemoServer`, so
 * the real connection supervisor, shell and thread state, and screens all run
 * unchanged. Only an "in demo" flag is persisted, so relaunching returns to
 * the demo with fresh sample data. Exiting demo mode clears the flag and
 * removes the environment and its cached data; real environments are never
 * touched.
 */

export const demoModeActiveAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:demo-mode-active"),
);

let demoServer: DemoServer | null = null;

export function currentDemoServer(): DemoServer | null {
  return demoServer;
}

export function isDemoModeActive(): boolean {
  return appAtomRegistry.get(demoModeActiveAtom);
}

export function useDemoModeActive(): boolean {
  return useAtomValue(demoModeActiveAtom);
}

export function isDemoEnvironmentId(environmentId: string | null | undefined): boolean {
  return environmentId === DEMO_ENVIRONMENT_ID;
}

export function enterDemoMode(options?: { readonly server?: DemoServer }): void {
  if (appAtomRegistry.get(demoModeActiveAtom)) return;
  demoServer = options?.server ?? new DemoServer();
  appAtomRegistry.set(demoModeActiveAtom, true);
  writeDemoModeFlag(true);
}

/** Re-enters demo mode at launch if the app was closed while in it. */
export function restoreDemoMode(): void {
  if (readDemoModeFlag()) enterDemoMode();
}

export function exitDemoMode(): void {
  if (!appAtomRegistry.get(demoModeActiveAtom) && demoServer === null) return;
  writeDemoModeFlag(false);
  appAtomRegistry.set(demoModeActiveAtom, false);
  demoServer?.dispose();
  demoServer = null;
}

export const DEMO_CONNECTION_TARGET = new PrimaryConnectionTarget({
  environmentId: DEMO_ENVIRONMENT_ID,
  label: DEMO_ENVIRONMENT_LABEL,
  httpBaseUrl: DEMO_HTTP_BASE_URL,
  wsBaseUrl: DEMO_WS_BASE_URL,
});

const DEMO_REGISTRATION = new PrimaryConnectionRegistration({ target: DEMO_CONNECTION_TARGET });

export function demoRegistrations(active: boolean): ReadonlyArray<PlatformConnectionRegistration> {
  return active ? [DEMO_REGISTRATION] : [];
}

/**
 * Platform environments for the connection registry: the demo environment
 * while demo mode is on, nothing otherwise. Leftover demo cache from a run
 * that ended without exiting is cleared first.
 */
export const demoPlatformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    const cache = yield* EnvironmentCacheStore;
    const clearStaleDemoCache = cache.clear(DEMO_ENVIRONMENT_ID).pipe(Effect.ignore);
    return PlatformConnectionSource.of({
      registrations: Stream.concat(
        Stream.fromEffect(clearStaleDemoCache).pipe(Stream.drain),
        AtomRegistry.toStream(appAtomRegistry, demoModeActiveAtom).pipe(
          Stream.changes,
          Stream.map(demoRegistrations),
        ),
      ),
    });
  }),
);

function demoLease(): Effect.Effect<EnvironmentConnectionLease, ConnectionBlockedError> {
  return Effect.suspend(() => {
    const server = demoServer;
    if (server === null) {
      return Effect.fail(
        new ConnectionBlockedError({ reason: "configuration", detail: "Demo mode has ended." }),
      );
    }
    return Effect.succeed({
      prepared: {
        environmentId: DEMO_ENVIRONMENT_ID,
        label: DEMO_ENVIRONMENT_LABEL,
        httpBaseUrl: DEMO_HTTP_BASE_URL,
        socketUrl: DEMO_WS_BASE_URL,
        httpAuthorization: null,
        target: DEMO_CONNECTION_TARGET,
      },
      session: server.makeSession(),
    });
  });
}

/** Serves the demo environment in-process; every other environment connects normally. */
export const demoConnectionDriverOverrideLayer = Layer.succeed(ConnectionDriverOverride, {
  connect: (entry) =>
    isDemoEnvironmentId(entry.target.environmentId) ? Option.some(demoLease()) : Option.none(),
});

/** HTTP snapshot loaders that answer the demo environment from memory, without a request. */
export const demoAwareSnapshotLoaderLayer = Layer.merge(
  Layer.effect(
    ShellSnapshotLoader,
    Effect.gen(function* () {
      const base = yield* ShellSnapshotLoader;
      return ShellSnapshotLoader.of({
        load: (prepared) =>
          isDemoEnvironmentId(prepared.environmentId)
            ? Effect.sync(() => Option.fromNullishOr(demoServer?.shellSnapshot()))
            : base.load(prepared),
      });
    }),
  ).pipe(Layer.provide(shellSnapshotLoaderLayer)),
  Layer.effect(
    ThreadSnapshotLoader,
    Effect.gen(function* () {
      const base = yield* ThreadSnapshotLoader;
      return ThreadSnapshotLoader.of({
        load: (prepared, threadId, window, reasoningMessages) =>
          isDemoEnvironmentId(prepared.environmentId)
            ? Effect.sync(() => Option.fromNullishOr(demoServer?.threadSnapshot(threadId)))
            : base.load(prepared, threadId, window, reasoningMessages),
      });
    }),
  ).pipe(Layer.provide(threadSnapshotLoaderLayer)),
);
