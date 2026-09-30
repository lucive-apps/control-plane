import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../state/atom-registry";
import { connectionAtomRuntime } from "./runtime";

/** True while pairing waits for a server that is starting up or overloaded. */
export const pairingWakingServerAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connection:pairing-waking-server"),
);

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: (pairingUrl: string) => pairingUrl },
  execute: (pairingUrl: string) =>
    ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) =>
        onboarding.registerPairing({
          pairingUrl,
          onWaiting: () => appAtomRegistry.set(pairingWakingServerAtom, true),
        }),
      ),
      Effect.ensuring(Effect.sync(() => appAtomRegistry.set(pairingWakingServerAtom, false))),
    ),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) => ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.updateBearer(input))),
});
