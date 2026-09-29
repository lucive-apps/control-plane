/**
 * Which schedule backend this server runs. Fork-owned.
 *
 * `none` is the default: nothing is installed and nothing fires on its own.
 * `dry-run` writes the would-be OS entry to disk and never installs it, which
 * is what dev and tests use. `os` installs the real entry, a LaunchAgent on
 * macOS or a systemd user timer on Linux; Vitest always gets `dry-run`
 * instead, so no test can reach the OS scheduler. Windows gets `none`.
 *
 * The desktop app picks through its bootstrap (`ServerConfig.schedulesBackend`),
 * never through env: an env value would pass to every terminal and agent the
 * server spawns, and a server one of them started would install a real entry.
 * `CPLANE_SCHEDULES_BACKEND` is for servers run by hand or by the dev runner.
 *
 * @module scheduleBackend
 */
import type { ProjectScheduler } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../config.ts";

export const SCHEDULES_BACKEND_ENV = "CPLANE_SCHEDULES_BACKEND";

export type ScheduleBackendMode = "os" | "dry-run" | "none";

export interface ScheduleBackendChoice {
  readonly mode: ScheduleBackendMode;
  /** The OS scheduler the entry is for; `none` when nothing is installed or rendered. */
  readonly scheduler: ProjectScheduler;
  /** A backend was asked for on a platform that has none (Windows). */
  readonly unsupportedPlatform?: true;
}

function platformScheduler(platform: NodeJS.Platform): ProjectScheduler {
  switch (platform) {
    case "darwin":
      return "launchd";
    case "linux":
      return "systemd";
    default:
      // Windows has no backend yet: Task Scheduler actions cannot set ELECTRON_RUN_AS_NODE.
      return "none";
  }
}

export function chooseScheduleBackend(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ScheduleBackendChoice {
  const requested = env[SCHEDULES_BACKEND_ENV]?.trim().toLowerCase();
  const mode: ScheduleBackendMode =
    requested === "os"
      ? env.VITEST
        ? "dry-run"
        : "os"
      : requested === "dry-run"
        ? "dry-run"
        : "none";
  if (mode === "none") return { mode, scheduler: "none" };
  const scheduler = platformScheduler(platform);
  return scheduler === "none"
    ? { mode: "none", scheduler, unsupportedPlatform: true }
    : { mode, scheduler };
}

/**
 * The real process is checked for `VITEST` too, so a test that injects its
 * own `HostProcessEnvironment` still cannot reach the OS scheduler.
 */
const withVitest = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  env.VITEST || !process.env.VITEST ? env : { ...env, VITEST: process.env.VITEST };

/** The desktop's bootstrap choice when it made one, else `CPLANE_SCHEDULES_BACKEND`. */
export const resolveScheduleBackend: Effect.Effect<ScheduleBackendChoice, never, ServerConfig> =
  Effect.gen(function* () {
    const desktopChoice = (yield* ServerConfig).schedulesBackend;
    const env = withVitest(yield* HostProcessEnvironment);
    return chooseScheduleBackend(
      desktopChoice === undefined ? env : { ...env, [SCHEDULES_BACKEND_ENV]: desktopChoice },
      yield* HostProcessPlatform,
    );
  });

/** The platform's OS backend whatever the env asks for; still `dry-run` under Vitest. */
export const resolvePlatformScheduleBackend: Effect.Effect<ScheduleBackendChoice> = Effect.gen(
  function* () {
    const env = withVitest(yield* HostProcessEnvironment);
    return chooseScheduleBackend(
      { VITEST: env.VITEST, [SCHEDULES_BACKEND_ENV]: "os" },
      yield* HostProcessPlatform,
    );
  },
);
