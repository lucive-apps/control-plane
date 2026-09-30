import { assert, it } from "@effect/vitest";
import {
  BearerConnectionTarget,
  ConnectionDriverOverride,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, describe, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { DEMO_ENVIRONMENT_ID } from "./demoFixtures";
import {
  DEMO_CONNECTION_TARGET,
  currentDemoServer,
  demoConnectionDriverOverrideLayer,
  demoModeActiveAtom,
  demoRegistrations,
  enterDemoMode,
  exitDemoMode,
  isDemoModeActive,
} from "./demoMode";
import { DemoServer } from "./demoServer";

vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

const demoEntry: ConnectionCatalogEntry = {
  target: DEMO_CONNECTION_TARGET,
  profile: Option.none(),
  enabled: true,
};

const realEntry: ConnectionCatalogEntry = {
  target: new BearerConnectionTarget({
    environmentId: EnvironmentId.make("real-mac"),
    label: "Real Mac",
    connectionId: "real-connection",
  }),
  profile: Option.none(),
  enabled: true,
};

afterEach(() => exitDemoMode());

describe("demo mode state", () => {
  it("registers the demo environment only while active", () => {
    assert.deepStrictEqual(demoRegistrations(false), []);
    const [registration] = demoRegistrations(true);
    assert.strictEqual(registration?.target.environmentId, DEMO_ENVIRONMENT_ID);
    assert.strictEqual(registration?.target.label, "Demo Mac");
  });

  it("enters and exits, disposing the sample data", () => {
    assert.isFalse(isDemoModeActive());
    const server = new DemoServer();
    const dispose = vi.spyOn(server, "dispose");

    enterDemoMode({ server });
    assert.isTrue(appAtomRegistry.get(demoModeActiveAtom));
    assert.strictEqual(currentDemoServer(), server);

    exitDemoMode();
    assert.isFalse(appAtomRegistry.get(demoModeActiveAtom));
    assert.isNull(currentDemoServer());
    assert.strictEqual(dispose.mock.calls.length, 1);
  });

  it("starts fresh sample data on each entry", () => {
    enterDemoMode();
    const first = currentDemoServer();
    exitDemoMode();
    enterDemoMode();
    assert.notStrictEqual(currentDemoServer(), first);
  });
});

describe("demo connection override", () => {
  it.effect("serves the demo environment in-process and leaves real ones alone", () =>
    Effect.gen(function* () {
      const override = yield* ConnectionDriverOverride;
      assert.isTrue(Option.isNone(override.connect(realEntry)));

      enterDemoMode();
      const lease = override.connect(demoEntry);
      assert.isTrue(Option.isSome(lease));
      if (Option.isNone(lease)) return;
      const { prepared, session } = yield* Effect.scoped(lease.value);
      assert.strictEqual(prepared.environmentId, DEMO_ENVIRONMENT_ID);
      const config = yield* session.initialConfig;
      assert.strictEqual(config.environment.environmentId, DEMO_ENVIRONMENT_ID);
    }).pipe(Effect.provide(demoConnectionDriverOverrideLayer)),
  );

  it.effect("blocks the demo connection after exit instead of reaching the network", () =>
    Effect.gen(function* () {
      const override = yield* ConnectionDriverOverride;
      const lease = override.connect(demoEntry);
      assert.isTrue(Option.isSome(lease));
      if (Option.isNone(lease)) return;
      const error = yield* Effect.scoped(lease.value).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ConnectionBlockedError");
    }).pipe(Effect.provide(demoConnectionDriverOverrideLayer)),
  );
});
