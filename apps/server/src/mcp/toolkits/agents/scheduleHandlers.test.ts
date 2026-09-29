import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ProjectAssistant,
  type ProjectScheduleInput,
  type ProjectScheduleRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlersLive } from "./handlers.ts";
import {
  AgentsToolkit,
  ScheduleCreateResult,
  ScheduleDeleteResult,
  ScheduleListResult,
  ScheduleUpdateResult,
} from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-acme");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const COORDINATOR = ThreadId.make("thread-coordinator");
const SALES = ThreadId.make("thread-sales");
const SCRATCH = ThreadId.make("thread-scratch");
const OTHER_COORDINATOR = ThreadId.make("thread-other-coordinator");
const CODEX = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

/** The real engine, projections and SQLite, so writes go through the decider as they do live. */
const TestLayer = AgentsToolkitHandlersLive.pipe(
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-schedule-tools-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let commandCounter = 0;
const nextCommandId = () => CommandId.make(`test-command-${(commandCounter += 1)}`);

const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const createThread = (threadId: ThreadId, projectId: ProjectId, title: string) =>
  dispatch({
    type: "thread.create",
    commandId: nextCommandId(),
    threadId,
    projectId,
    title,
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: SEEDED_AT,
  });

const userInput = (
  input: Omit<ProjectScheduleInput, "enabled" | "target"> &
    Partial<Pick<ProjectScheduleInput, "enabled" | "target">>,
): ProjectScheduleInput => ({ target: "coordinator", enabled: true, ...input });

/** A whole-list write from a client, like the Schedules panel's. */
const userWrite = (projectId: ProjectId, schedules: ReadonlyArray<ProjectScheduleInput>) =>
  dispatch({
    type: "project.meta.update",
    commandId: nextCommandId(),
    projectId,
    assistant: { schedules },
  });

/**
 * Project Acme: coordinator, standing agent Sales and one-off agent Scratch.
 * Project Other has its own coordinator and an enabled schedule "other-brief".
 */
const seed = Effect.gen(function* () {
  yield* dispatch({
    type: "project.create",
    commandId: nextCommandId(),
    projectId: PROJECT_ID,
    title: "Acme",
    workspaceRoot: "/tmp/acme",
    createdAt: SEEDED_AT,
  });
  yield* createThread(COORDINATOR, PROJECT_ID, "Acme");
  yield* createThread(SALES, PROJECT_ID, "Sales");
  yield* createThread(SCRATCH, PROJECT_ID, "Scratch");
  yield* dispatch({ type: "thread.pin", commandId: nextCommandId(), threadId: SALES });
  yield* dispatch({
    type: "project.meta.update",
    commandId: nextCommandId(),
    projectId: PROJECT_ID,
    assistant: { coordinatorThreadId: COORDINATOR },
  });

  yield* dispatch({
    type: "project.create",
    commandId: nextCommandId(),
    projectId: OTHER_PROJECT_ID,
    title: "Other",
    workspaceRoot: "/tmp/other",
    createdAt: SEEDED_AT,
  });
  yield* createThread(OTHER_COORDINATOR, OTHER_PROJECT_ID, "Other");
  yield* dispatch({
    type: "project.meta.update",
    commandId: nextCommandId(),
    projectId: OTHER_PROJECT_ID,
    assistant: {
      coordinatorThreadId: OTHER_COORDINATOR,
      schedules: [
        userInput({ id: "other-brief", name: "Other brief", cron: "0 8 * * *", prompt: "Hi." }),
      ],
    },
  });
});

/** The full marker, prompts included, as the decider sees it. */
const readMarker = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const readModel = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
    const assistant = readModel.projects.find((project) => project.id === projectId)?.assistant;
    if (assistant == null) throw new Error(`Project ${projectId} has no marker.`);
    return assistant;
  });

const scheduleOf = (marker: ProjectAssistant, id: string) => {
  const schedule = marker.schedules?.find((entry) => entry.id === id);
  if (schedule === undefined) throw new Error(`No schedule ${id}.`);
  return schedule;
};

/** The stored list as a client would write it back, echoing each entry's `updatedAt`. */
const echoInputs = (marker: ProjectAssistant): ProjectScheduleInput[] =>
  (marker.schedules ?? []).map(({ id, name, cron, target, enabled, updatedAt }) => ({
    id,
    name,
    cron,
    target,
    enabled,
    updatedAt,
  }));

/** Runs each schedule tool as `caller`, decoding the result with the tool's success schema. */
const scheduleTools = Effect.gen(function* () {
  const toolkit = yield* AgentsToolkit;
  const run = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
    handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
    success: S,
    caller: ThreadId,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  ) =>
    handled.pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => Schema.decodeUnknownSync(success)(chunk.at(-1)!.result)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: caller,
        providerSessionId: "provider-session-1",
        providerInstanceId: CODEX,
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
    );
  return {
    list: (
      caller: ThreadId,
      capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["agents"],
    ) => run(toolkit.handle("cp_schedule_list", {}), ScheduleListResult, caller, capabilities),
    create: (
      caller: ThreadId,
      params: Parameters<typeof toolkit.handle<"cp_schedule_create">>[1],
    ) =>
      run(toolkit.handle("cp_schedule_create", params), ScheduleCreateResult, caller, ["agents"]),
    update: (
      caller: ThreadId,
      params: Parameters<typeof toolkit.handle<"cp_schedule_update">>[1],
    ) =>
      run(toolkit.handle("cp_schedule_update", params), ScheduleUpdateResult, caller, ["agents"]),
    delete: (
      caller: ThreadId,
      params: Parameters<typeof toolkit.handle<"cp_schedule_delete">>[1],
    ) =>
      run(toolkit.handle("cp_schedule_delete", params), ScheduleDeleteResult, caller, ["agents"]),
  };
});

const withSeededEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.andThen(seed, effect).pipe(Effect.provide(TestLayer));

describe("schedule tool access", () => {
  it.effect("refuses a caller without the agents capability", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const error = yield* tools.list(COORDINATOR, []).pipe(Effect.flip);
        expect(error._tag).toBe("McpCapabilityUnavailableError");
      }),
    ),
  );

  it.effect("refuses a standing agent even though it holds the agents capability", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const listed = yield* tools.list(SALES).pipe(Effect.flip);
        const created = yield* tools
          .create(SALES, { name: "Pipeline", prompt: "Check the pipeline.", cron: "0 9 * * *" })
          .pipe(Effect.flip);

        expect(listed._tag).toBe("SchedulesCoordinatorOnlyError");
        expect(created._tag).toBe("SchedulesCoordinatorOnlyError");
        expect(created.message).toBe("Only the Project's coordinator can manage schedules.");
        expect((yield* readMarker(PROJECT_ID)).schedules).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps a coordinator to its own Project's schedules", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const listed = yield* tools.list(COORDINATOR);
        const paused = yield* tools
          .update(COORDINATOR, { id: "other-brief", pause: true })
          .pipe(Effect.flip);
        const deleted = yield* tools.delete(COORDINATOR, { id: "other-brief" }).pipe(Effect.flip);

        expect(listed.schedules).toEqual([]);
        expect(paused._tag).toBe("ScheduleNotFoundError");
        expect(deleted._tag).toBe("ScheduleNotFoundError");
        expect(scheduleOf(yield* readMarker(OTHER_PROJECT_ID), "other-brief").enabled).toBe(true);
      }),
    ),
  );
});

describe("cp_schedule_create", () => {
  it.effect("saves a new schedule off, authored by the calling coordinator", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const result = yield* tools.create(COORDINATOR, {
          name: "Morning brief",
          prompt: "Summarize what changed in this folder.",
          cron: "0 9 * * 1-5",
        });

        expect(result).toEqual({
          id: expect.stringMatching(/^morning-brief-[a-z0-9]{6}$/),
          enabled: false,
          note: "Saved off until the user turns it on.",
        });
        const marker = yield* readMarker(PROJECT_ID);
        expect(scheduleOf(marker, result.id)).toMatchObject({
          name: "Morning brief",
          cron: "0 9 * * 1-5",
          target: "coordinator",
          enabled: false,
          createdBy: COORDINATOR,
          updatedBy: COORDINATOR,
        });
        expect(marker.schedulePrompts?.[result.id]).toBe("Summarize what changed in this folder.");
      }),
    ),
  );

  it.effect("runs in a standing agent named by title, never in a one-off agent", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const params = { name: "Pipeline", prompt: "Check the pipeline.", cron: "0 9 * * *" };

        const sales = yield* tools.create(COORDINATOR, { ...params, target: "sales" });
        const oneOff = yield* tools
          .create(COORDINATOR, { ...params, target: "Scratch" })
          .pipe(Effect.flip);
        const missing = yield* tools
          .create(COORDINATOR, { ...params, target: "Nobody" })
          .pipe(Effect.flip);
        const elsewhere = yield* tools
          .create(COORDINATOR, { ...params, target: OTHER_COORDINATOR })
          .pipe(Effect.flip);

        expect(scheduleOf(yield* readMarker(PROJECT_ID), sales.id).target).toBe(SALES);
        expect(oneOff.message).toBe(
          "Schedules run in the coordinator or a standing agent. 'Scratch' is neither.",
        );
        expect(missing._tag).toBe("AgentNotFoundError");
        expect(elsewhere._tag).toBe("AgentNotFoundError");
        expect((yield* readMarker(PROJECT_ID)).schedules).toHaveLength(1);
      }),
    ),
  );

  it.effect("returns the decider's reason when the cadence is refused", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const error = yield* tools
          .create(COORDINATOR, { name: "Ping", prompt: "Ping.", cron: "*/5 * * * *" })
          .pipe(Effect.flip);

        expect(error._tag).toBe("AgentToolFailedError");
        expect(error.message).toBe("Schedule 'Ping': Schedules run at most every 15 minutes.");
        expect((yield* readMarker(PROJECT_ID)).schedules).toBeUndefined();
      }),
    ),
  );
});

describe("cp_schedule_update", () => {
  it.effect("keeps a renamed schedule on, and turns it off when its prompt changes", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "brief", name: "Brief", cron: "0 7 * * 1-5", prompt: "Brief me." }),
        ]);

        const renamed = yield* tools.update(COORDINATOR, { id: "brief", name: "Daily brief" });
        const reprompted = yield* tools.update(COORDINATOR, {
          id: "brief",
          prompt: "Brief me, then email the team.",
        });

        expect(renamed).toEqual({ id: "brief", enabled: true });
        expect(reprompted).toEqual({ id: "brief", enabled: false });
        const marker = yield* readMarker(PROJECT_ID);
        expect(scheduleOf(marker, "brief")).toMatchObject({
          name: "Daily brief",
          enabled: false,
          createdBy: "user",
          updatedBy: COORDINATOR,
        });
        expect(marker.schedulePrompts?.brief).toBe("Brief me, then email the team.");
      }),
    ),
  );

  it.effect("turns an enabled schedule off when its cron or target changes", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        const prompt = "Brief me.";
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "retimed", name: "Retimed", cron: "0 7 * * *", prompt }),
          userInput({ id: "retargeted", name: "Retargeted", cron: "0 7 * * *", prompt }),
          userInput({ id: "same-target", name: "Same target", cron: "0 7 * * *", prompt }),
        ]);

        const retimed = yield* tools.update(COORDINATOR, { id: "retimed", cron: "0 8 * * *" });
        const retargeted = yield* tools.update(COORDINATOR, { id: "retargeted", target: "Sales" });
        // The coordinator named by its own id is still the coordinator: no retarget.
        const same = yield* tools.update(COORDINATOR, { id: "same-target", target: COORDINATOR });

        expect(retimed).toEqual({ id: "retimed", enabled: false });
        expect(retargeted).toEqual({ id: "retargeted", enabled: false });
        expect(same).toEqual({ id: "same-target", enabled: true });
        const marker = yield* readMarker(PROJECT_ID);
        expect(scheduleOf(marker, "retimed")).toMatchObject({ cron: "0 8 * * *", enabled: false });
        expect(scheduleOf(marker, "retargeted")).toMatchObject({ target: SALES, enabled: false });
        expect(scheduleOf(marker, "same-target")).toMatchObject({
          target: "coordinator",
          enabled: true,
          updatedBy: "user",
        });
      }),
    ),
  );

  it.effect("writes nothing when an update repeats the stored values", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({
            id: "brief",
            name: "Brief",
            cron: "0 7 * * *",
            prompt: "Brief me.",
            target: SALES,
            enabled: false,
          }),
        ]);
        const sequence = () =>
          Effect.map(
            Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getCommandReadModel()),
            (readModel) => readModel.snapshotSequence,
          );
        const before = yield* sequence();

        // A "pause everything" pass, restating every field of a paused schedule.
        const result = yield* tools.update(COORDINATOR, {
          id: "brief",
          name: "Brief",
          prompt: "Brief me.",
          cron: "0 7 * * *",
          target: "Sales",
          pause: true,
        });

        expect(result).toEqual({ id: "brief", enabled: false });
        // No event, so the Project keeps its place in the sidebar.
        expect(yield* sequence()).toBe(before);
      }),
    ),
  );

  it.effect("pauses on request, and cannot turn a schedule back on", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "brief", name: "Brief", cron: "0 7 * * *", prompt: "Brief me." }),
        ]);

        const paused = yield* tools.update(COORDINATOR, { id: "brief", pause: true });
        const resumed = yield* tools.update(COORDINATOR, { id: "brief", pause: false });

        expect(paused).toEqual({ id: "brief", enabled: false });
        expect(resumed).toEqual({ id: "brief", enabled: false });
        expect(scheduleOf(yield* readMarker(PROJECT_ID), "brief").enabled).toBe(false);
      }),
    ),
  );

  it.effect(
    "leaves a schedule the user just turned on alone when a stale update edits another",
    () =>
      withSeededEngine(
        Effect.gen(function* () {
          const tools = yield* scheduleTools;
          const a = yield* tools.create(COORDINATOR, {
            name: "Alpha",
            prompt: "Alpha.",
            cron: "0 7 * * *",
          });
          const b = yield* tools.create(COORDINATOR, {
            name: "Beta",
            prompt: "Beta.",
            cron: "0 8 * * *",
          });
          // The coordinator reads the list while both are off.
          const stale = yield* tools.list(COORDINATOR);
          expect(stale.schedules.map((schedule) => schedule.enabled)).toEqual([false, false]);

          // The user turns Alpha on from the panel.
          yield* userWrite(
            PROJECT_ID,
            echoInputs(yield* readMarker(PROJECT_ID)).map((input) =>
              input.id === a.id ? { ...input, enabled: true } : input,
            ),
          );
          // Then the coordinator edits Beta from its stale read.
          yield* tools.update(COORDINATOR, { id: b.id, prompt: "Beta, shorter." });

          const marker = yield* readMarker(PROJECT_ID);
          expect(scheduleOf(marker, a.id)).toMatchObject({ enabled: true, updatedBy: "user" });
          expect(marker.schedulePrompts?.[a.id]).toBe("Alpha.");
          expect(marker.schedulePrompts?.[b.id]).toBe("Beta, shorter.");
        }),
      ),
  );
});

describe("cp_schedule_list and cp_schedule_delete", () => {
  it.effect("lists prompts, cadence and the last run, and deletes one schedule whole", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "brief", name: "Brief", cron: "0 7 * * 1-5", prompt: "Brief me." }),
          userInput({
            id: "pipeline",
            name: "Pipeline",
            cron: "0 16 * * 5",
            prompt: "Check the pipeline.",
            target: SALES,
            enabled: false,
          }),
        ]);
        const run: ProjectScheduleRun = {
          slot: "2026-01-05T14:00:00.000Z",
          at: "2026-01-05T14:00:00.000Z",
          trigger: "cron",
          outcome: "missed",
          reason: "busy",
        };
        yield* dispatch({
          type: "project.schedule.record",
          commandId: nextCommandId(),
          projectId: PROJECT_ID,
          scheduleId: "brief",
          run,
          createdAt: run.at,
        });

        const listed = yield* tools.list(COORDINATOR);
        expect(listed.schedules).toEqual([
          {
            id: "brief",
            name: "Brief",
            prompt: "Brief me.",
            cron: "0 7 * * 1-5",
            cadence: "Weekdays at 7:00",
            target: "coordinator",
            enabled: true,
            createdBy: "user",
            updatedBy: "user",
            lastRun: run,
          },
          {
            id: "pipeline",
            name: "Pipeline",
            prompt: "Check the pipeline.",
            cron: "0 16 * * 5",
            cadence: "Fridays at 16:00",
            target: SALES,
            enabled: false,
            createdBy: "user",
            updatedBy: "user",
            lastRun: null,
          },
        ]);

        const deleted = yield* tools.delete(COORDINATOR, { id: "brief" });
        expect(deleted).toEqual({ id: "brief", deleted: true });
        const marker = yield* readMarker(PROJECT_ID);
        expect(marker.schedules?.map((schedule) => schedule.id)).toEqual(["pipeline"]);
        expect(marker.schedulePrompts).toEqual({ pipeline: "Check the pipeline." });
        expect(marker.scheduleRuns).toBeUndefined();
        expect((yield* tools.list(COORDINATOR)).schedules.map((entry) => entry.id)).toEqual([
          "pipeline",
        ]);
      }),
    ),
  );
});
