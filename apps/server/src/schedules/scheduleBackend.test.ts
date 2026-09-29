import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../config.ts";
import {
  chooseScheduleBackend,
  resolvePlatformScheduleBackend,
  resolveScheduleBackend,
} from "./scheduleBackend.ts";

describe("chooseScheduleBackend", () => {
  it("runs nothing unless asked", () => {
    expect(chooseScheduleBackend({}, "darwin")).toEqual({ mode: "none", scheduler: "none" });
    expect(chooseScheduleBackend({ CPLANE_SCHEDULES_BACKEND: "bogus" }, "linux")).toEqual({
      mode: "none",
      scheduler: "none",
    });
  });

  it("installs the platform's entry for os, except under Vitest", () => {
    expect(chooseScheduleBackend({ CPLANE_SCHEDULES_BACKEND: "os" }, "darwin")).toEqual({
      mode: "os",
      scheduler: "launchd",
    });
    expect(chooseScheduleBackend({ CPLANE_SCHEDULES_BACKEND: "os" }, "linux")).toEqual({
      mode: "os",
      scheduler: "systemd",
    });
    expect(
      chooseScheduleBackend({ CPLANE_SCHEDULES_BACKEND: "os", VITEST: "true" }, "darwin"),
    ).toEqual({ mode: "dry-run", scheduler: "launchd" });
  });

  it("renders dry-run entries for the platform's scheduler, and none on Windows", () => {
    expect(chooseScheduleBackend({ CPLANE_SCHEDULES_BACKEND: "dry-run" }, "linux")).toEqual({
      mode: "dry-run",
      scheduler: "systemd",
    });
    for (const requested of ["dry-run", "os"]) {
      expect(chooseScheduleBackend({ CPLANE_SCHEDULES_BACKEND: requested }, "win32")).toEqual({
        mode: "none",
        scheduler: "none",
        unsupportedPlatform: true,
      });
    }
  });
});

describe("resolving the backend in this test run", () => {
  /** Runs `effect` under a test `ServerConfig` carrying the desktop's bootstrap choice. */
  const withDesktopChoice =
    (schedulesBackend: "os" | "dry-run" | undefined) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        return yield* effect.pipe(
          Effect.provideService(ServerConfig, { ...config, schedulesBackend }),
        );
      }).pipe(
        Effect.provide(
          serverConfigLayerTest(process.cwd(), { prefix: "t3-schedule-backend-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );

  it.effect("never reaches the OS, even when a test injects an env without VITEST", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolveScheduleBackend, {
        mode: "dry-run",
        scheduler: "launchd",
      });
      // The CLI's removal path asks for the platform backend outright.
      assert.deepStrictEqual(yield* resolvePlatformScheduleBackend, {
        mode: "dry-run",
        scheduler: "launchd",
      });
    }).pipe(
      withDesktopChoice(undefined),
      Effect.provideService(HostProcessEnvironment, { CPLANE_SCHEDULES_BACKEND: "os" }),
      Effect.provideService(HostProcessPlatform, "darwin"),
    ),
  );

  it.effect("takes the desktop's bootstrap choice over the env", () =>
    Effect.gen(function* () {
      // No env at all: only the bootstrap asked, and Vitest still turns `os` into `dry-run`.
      assert.deepStrictEqual(
        yield* resolveScheduleBackend.pipe(
          withDesktopChoice("os"),
          Effect.provideService(HostProcessEnvironment, {}),
        ),
        { mode: "dry-run", scheduler: "systemd" },
      );
      // The bootstrap wins over whatever the env says.
      assert.deepStrictEqual(
        yield* resolveScheduleBackend.pipe(
          withDesktopChoice("dry-run"),
          Effect.provideService(HostProcessEnvironment, { CPLANE_SCHEDULES_BACKEND: "none" }),
        ),
        { mode: "dry-run", scheduler: "systemd" },
      );
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
});
