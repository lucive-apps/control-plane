import { RemoteAgentsLocalOnly } from "../../../agentMachines/testFixtures.ts";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationAgentMessageSource,
  type OrchestrationCommand,
  type ProjectAssistant,
  type ProjectScheduleInput,
  type ProjectScheduleRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

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
import { HostTimeZoneSource } from "../../../schedules/hostZone.ts";
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
/** A Wednesday. Tests run with the clock here and the host in UTC. */
const NOW = "2026-10-28T12:00:00.000Z";

/** The real engine, projections and SQLite, so writes go through the decider as they do live. */
const TestLayer = AgentsToolkitHandlersLive.pipe(
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(RemoteAgentsLocalOnly),
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

const AGENT_RESULT: OrchestrationAgentMessageSource = {
  kind: "agent",
  threadId: SALES,
  threadTitle: "Sales",
};
const SCHEDULE_RUN: OrchestrationAgentMessageSource = {
  kind: "agent",
  threadTitle: "Brief",
  scheduleId: "brief",
};

/** A message in `threadId` that starts no turn: the user's own without `source`. */
const appendPrompt = (threadId: ThreadId, source?: OrchestrationAgentMessageSource) =>
  Effect.gen(function* () {
    const id = nextCommandId();
    const createdAt = yield* tick;
    yield* dispatch({
      type: "thread.message.user.append",
      commandId: id,
      threadId,
      message: {
        messageId: MessageId.make(`message-${id}`),
        text: "Turn the morning brief on.",
        attachments: [],
        ...(source === undefined ? {} : { source }),
      },
      createdAt,
    });
  });

/** One second on, so every message and request has its own time. */
const tick = Effect.gen(function* () {
  yield* TestClock.adjust("1 second");
  return DateTime.formatIso(yield* DateTime.now);
});

const setSession = (threadId: ThreadId, activeTurnId: TurnId | null) =>
  Effect.gen(function* () {
    const at = yield* tick;
    yield* dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(),
      threadId,
      session: {
        threadId,
        status: activeTurnId === null ? "ready" : "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId,
        lastError: null,
        updatedAt: at,
      },
      createdAt: at,
    });
  });

/** A turn-start request, as a client, an agent or a schedule delivery sends one. */
const requestTurn = (
  threadId: ThreadId,
  source?: OrchestrationAgentMessageSource,
  messageId?: MessageId,
) =>
  Effect.gen(function* () {
    const id = nextCommandId();
    const createdAt = yield* tick;
    yield* dispatch({
      type: "thread.turn.start",
      commandId: id,
      threadId,
      message: {
        messageId: messageId ?? MessageId.make(`turn-message-${id}`),
        role: "user",
        text: "Turn the morning brief on.",
        attachments: [],
        ...(source === undefined ? {} : { source }),
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });
    return messageId ?? MessageId.make(`turn-message-${id}`);
  });

/**
 * A turn in `threadId` started by a message, as the provider runs it: the
 * user's own without `source`, else an agent result, peer message or schedule run.
 */
const startTurn = (threadId: ThreadId, source?: OrchestrationAgentMessageSource) =>
  Effect.gen(function* () {
    yield* setSession(threadId, null);
    const messageId = yield* requestTurn(threadId, source);
    yield* setSession(threadId, TurnId.make(`turn-${nextCommandId()}`));
    return messageId;
  });

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

const withSeededEngine = <A, E, R>(effect: Effect.Effect<A, E, R>, zone = "UTC") =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seed),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
    Effect.provideService(HostTimeZoneSource, () => ({ zone, processZone: "UTC" })),
  );

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
          .update(COORDINATOR, { id: "other-brief", enabled: false })
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
          nextRun: null,
          note: "Saved paused. Turn it on only when the user asks.",
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

  it.effect("saves a new schedule on when the user asked, from its next slot", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* startTurn(COORDINATOR);
        const result = yield* tools.create(COORDINATOR, {
          name: "Morning brief",
          prompt: "Summarize what changed in this folder.",
          cron: "0 9 * * 1-5",
          enabled: true,
        });

        expect(result).toEqual({
          id: expect.stringMatching(/^morning-brief-[a-z0-9]{6}$/),
          enabled: true,
          nextRun: "2026-10-29T09:00:00.000Z",
          note: "On. It first runs at nextRun, not now.",
        });
        const marker = yield* readMarker(PROJECT_ID);
        expect(scheduleOf(marker, result.id)).toMatchObject({
          enabled: true,
          createdBy: COORDINATOR,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        // Nothing ran on the way in.
        expect(marker.scheduleRuns).toBeUndefined();
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

        expect(renamed).toEqual({
          id: "brief",
          enabled: true,
          nextRun: "2026-10-29T07:00:00.000Z",
        });
        expect(reprompted).toEqual({ id: "brief", enabled: false, nextRun: null });
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

        expect(retimed).toEqual({ id: "retimed", enabled: false, nextRun: null });
        expect(retargeted).toEqual({ id: "retargeted", enabled: false, nextRun: null });
        expect(same).toEqual({
          id: "same-target",
          enabled: true,
          nextRun: "2026-10-29T07:00:00.000Z",
        });
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
          enabled: false,
        });

        expect(result).toEqual({ id: "brief", enabled: false, nextRun: null });
        // No event, so the Project keeps its place in the sidebar.
        expect(yield* sequence()).toBe(before);
      }),
    ),
  );

  it.effect("pauses on request, and turns a schedule back on when the user asked", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "brief", name: "Brief", cron: "0 7 * * *", prompt: "Brief me." }),
        ]);
        yield* startTurn(COORDINATOR);

        const paused = yield* tools.update(COORDINATOR, { id: "brief", enabled: false });
        expect(paused).toEqual({ id: "brief", enabled: false, nextRun: null });

        yield* TestClock.adjust("1 minute");
        const resumed = yield* tools.update(COORDINATOR, { id: "brief", enabled: true });

        expect(resumed).toEqual({
          id: "brief",
          enabled: true,
          nextRun: "2026-10-29T07:00:00.000Z",
        });
        // Armed now: the runner skips every slot before updatedAt.
        expect(scheduleOf(yield* readMarker(PROJECT_ID), "brief")).toMatchObject({
          enabled: true,
          updatedBy: COORDINATOR,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    ),
  );

  it.effect("keeps a schedule on through an edit only when the same call turns it on", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "brief", name: "Brief", cron: "0 7 * * *", prompt: "Brief me." }),
        ]);
        yield* startTurn(COORDINATOR);

        const kept = yield* tools.update(COORDINATOR, {
          id: "brief",
          cron: "0 8 * * *",
          enabled: true,
        });

        expect(kept).toEqual({ id: "brief", enabled: true, nextRun: "2026-10-29T08:00:00.000Z" });
        // Re-armed by the edit: a slot from before it never runs.
        expect(scheduleOf(yield* readMarker(PROJECT_ID), "brief")).toMatchObject({
          cron: "0 8 * * *",
          enabled: true,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    ),
  );

  it.effect("still takes the older pause flag", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "brief", name: "Brief", cron: "0 7 * * *", prompt: "Brief me." }),
        ]);
        yield* startTurn(COORDINATOR);

        const conflicting = yield* tools
          .update(COORDINATOR, { id: "brief", pause: true, enabled: true })
          .pipe(Effect.flip);
        // pause: false never turned a schedule on, and still does nothing.
        const unpaused = yield* tools.update(COORDINATOR, { id: "brief", pause: false });
        const paused = yield* tools.update(COORDINATOR, { id: "brief", pause: true });
        const stillPaused = yield* tools.update(COORDINATOR, { id: "brief", pause: false });

        expect(conflicting.message).toBe("Pass enabled or pause, not both: they disagree.");
        expect(unpaused).toEqual({
          id: "brief",
          enabled: true,
          nextRun: "2026-10-29T07:00:00.000Z",
        });
        expect(paused).toEqual({ id: "brief", enabled: false, nextRun: null });
        expect(stillPaused).toEqual({ id: "brief", enabled: false, nextRun: null });
      }),
    ),
  );

  it.effect("gives the next run in the host's zone, across a DST change", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({ id: "daily", name: "Daily", cron: "0 7 * * *", prompt: "Brief me." }),
          // Mondays: the next one is after US clocks fall back on November 1.
          userInput({ id: "weekly", name: "Weekly", cron: "0 7 * * 1", prompt: "Plan the week." }),
        ]);

        const listed = yield* tools.list(COORDINATOR);

        // 12:00 UTC is 06:00 in Denver (MDT, UTC-6).
        expect(listed.schedules.map(({ id, nextRun }) => ({ id, nextRun }))).toEqual([
          { id: "daily", nextRun: "2026-10-28T13:00:00.000Z" },
          { id: "weekly", nextRun: "2026-11-02T14:00:00.000Z" },
        ]);
      }),
      "America/Denver",
    ),
  );

  it.effect("stays authorized when an agent result arrives during the user's turn", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({
            id: "brief",
            name: "Brief",
            cron: "0 7 * * *",
            prompt: "Brief me.",
            enabled: false,
          }),
        ]);
        yield* startTurn(COORDINATOR);
        yield* appendPrompt(COORDINATOR, AGENT_RESULT);
        yield* appendPrompt(COORDINATOR, SCHEDULE_RUN);
        // A delivery that asks for its own turn while this one runs.
        yield* requestTurn(COORDINATOR, AGENT_RESULT);

        const resumed = yield* tools.update(COORDINATOR, { id: "brief", enabled: true });

        expect(resumed).toEqual({
          id: "brief",
          enabled: true,
          nextRun: "2026-10-29T07:00:00.000Z",
        });
      }),
    ),
  );

  it.effect("refuses to turn a schedule on for a turn an agent or a schedule started", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(PROJECT_ID, [
          userInput({
            id: "brief",
            name: "Brief",
            cron: "0 7 * * *",
            prompt: "Brief me.",
            enabled: false,
          }),
        ]);
        const refused = () =>
          Effect.gen(function* () {
            const updated = yield* tools
              .update(COORDINATOR, { id: "brief", enabled: true })
              .pipe(Effect.flip);
            const created = yield* tools
              .create(COORDINATOR, {
                name: "Ping",
                prompt: "Ping.",
                cron: "0 9 * * *",
                enabled: true,
              })
              .pipe(Effect.flip);
            return [updated._tag, created._tag];
          });
        const refusedTags = ["ScheduleTurnOnNotRequestedError", "ScheduleTurnOnNotRequestedError"];

        // No running turn, though the user's message is the latest.
        yield* appendPrompt(COORDINATOR);
        expect(yield* refused()).toEqual(refusedTags);
        // A turn an agent result or a schedule run started, after an unrelated
        // message from the user.
        for (const source of [AGENT_RESULT, SCHEDULE_RUN]) {
          yield* appendPrompt(COORDINATOR);
          yield* startTurn(COORDINATOR, source);
          expect(yield* refused()).toEqual(refusedTags);
        }
        // The turn has ended.
        const earlier = yield* startTurn(COORDINATOR);
        yield* setSession(COORDINATOR, null);
        expect(yield* refused()).toEqual(refusedTags);
        // An agent's start request overwritten by the user's before its turn ran:
        // the turn could be either, so it counts as neither.
        yield* requestTurn(COORDINATOR, AGENT_RESULT);
        yield* requestTurn(COORDINATOR);
        yield* setSession(COORDINATOR, TurnId.make("turn-overwritten"));
        expect(yield* refused()).toEqual(refusedTags);
        // An old user message started again, as an HTTP caller could.
        yield* setSession(COORDINATOR, null);
        yield* requestTurn(COORDINATOR, AGENT_RESULT, earlier);
        yield* setSession(COORDINATOR, TurnId.make("turn-replayed"));
        expect(yield* refused()).toEqual(refusedTags);

        const marker = yield* readMarker(PROJECT_ID);
        expect(marker.schedules?.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
          { id: "brief", enabled: false },
        ]);
        // Pausing and editing still work from any turn.
        expect(yield* tools.update(COORDINATOR, { id: "brief", name: "Daily brief" })).toEqual({
          id: "brief",
          enabled: false,
          nextRun: null,
        });
      }),
    ),
  );

  it.effect("cannot turn on another Project's schedule, or one as a standing agent", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* scheduleTools;
        yield* userWrite(OTHER_PROJECT_ID, [
          {
            ...echoInputs(yield* readMarker(OTHER_PROJECT_ID))[0]!,
            enabled: false,
          },
        ]);
        yield* userWrite(PROJECT_ID, [
          userInput({
            id: "brief",
            name: "Brief",
            cron: "0 7 * * *",
            prompt: "Brief me.",
            enabled: false,
          }),
        ]);
        yield* startTurn(COORDINATOR);
        yield* startTurn(SALES);

        const elsewhere = yield* tools
          .update(COORDINATOR, { id: "other-brief", enabled: true })
          .pipe(Effect.flip);
        const standing = yield* tools
          .update(SALES, { id: "brief", enabled: true })
          .pipe(Effect.flip);

        expect(elsewhere._tag).toBe("ScheduleNotFoundError");
        expect(standing._tag).toBe("SchedulesCoordinatorOnlyError");
        expect(scheduleOf(yield* readMarker(OTHER_PROJECT_ID), "other-brief").enabled).toBe(false);
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
            nextRun: "2026-10-29T07:00:00.000Z",
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
            nextRun: null,
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
