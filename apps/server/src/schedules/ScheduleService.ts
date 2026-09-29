/**
 * ScheduleService - what the schedule RPCs and the fire route call. Fork-owned.
 *
 * `layer` joins the host's status, the Project's prompts and the runner's held
 * runs, and hands Run now and fires to the runner. `layerUnavailable` answers
 * status with a host that runs nothing and refuses Run now and fires.
 *
 * @module ScheduleService
 */
import {
  ScheduleUnavailableError,
  type ProjectId,
  type ScheduleHostStatus,
  type SchedulesRunResult,
  type SchedulesStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ScheduleHost } from "./ScheduleHost.ts";
import { ScheduleRunner } from "./ScheduleRunner.ts";

export class ScheduleService extends Context.Service<
  ScheduleService,
  {
    /** The host's status, plus the Project's prompts and held runs. */
    readonly status: (projectId: ProjectId) => Effect.Effect<SchedulesStatusResult>;
    /** Run now: the schedule's prompt goes out once, whether or not it is enabled. */
    readonly run: (
      projectId: ProjectId,
      scheduleId: string,
    ) => Effect.Effect<SchedulesRunResult, ScheduleUnavailableError>;
    /** A fire from the host's OS entry: every due slot runs. */
    readonly requestFire: (now: Date) => Effect.Effect<void, ScheduleUnavailableError>;
  }
>()("t3/schedules/ScheduleService") {}

const unavailableHost = (): ScheduleHostStatus => ({
  scheduler: "none",
  backend: "none",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  entry: { state: "unsupported" },
  problems: ["backend-off"],
});

const promptsOf = (projects: ProjectionProjectRepository["Service"], projectId: ProjectId) =>
  projects.getById({ projectId }).pipe(
    Effect.orDie,
    Effect.map((row) => Option.getOrUndefined(row)?.assistant?.schedulePrompts ?? {}),
  );

const make = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const host = yield* ScheduleHost;
  const runner = yield* ScheduleRunner;
  return {
    status: (projectId) =>
      Effect.all({
        host: host.status,
        prompts: promptsOf(projects, projectId),
        held: runner.holds(projectId),
      }),
    run: runner.runNow,
    requestFire: runner.requestFire,
  } satisfies ScheduleService["Service"];
});

/** Needs `ScheduleHost` and `ScheduleRunner`. */
export const layer = Layer.effect(ScheduleService, make).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);

const makeUnavailable = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const backendOff = Effect.fail(new ScheduleUnavailableError({ reason: "backend-off" }));
  return {
    status: (projectId) =>
      promptsOf(projects, projectId).pipe(
        Effect.map((prompts) => ({ host: unavailableHost(), prompts, held: {} })),
      ),
    run: () => backendOff,
    requestFire: () => backendOff,
  } satisfies ScheduleService["Service"];
});

export const layerUnavailable = Layer.effect(ScheduleService, makeUnavailable).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);
