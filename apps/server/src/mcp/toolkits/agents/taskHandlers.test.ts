import { RemoteAgentsLocalOnly } from "../../../agentMachines/testFixtures.ts";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type AssistantSettings,
  type OrchestrationCommand,
  type Task,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
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
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlersLive } from "./handlers.ts";
import { resolveTaskHome, taskHomeOf, withReminder } from "./taskHandlers.ts";
import {
  AgentsToolkit,
  TaskListResult,
  TaskProposeResult,
  TaskUpdateResult,
  type TaskProposeInput,
  type TaskUpdateInput,
} from "./tools.ts";

describe("taskHomeOf", () => {
  it("maps every `when` to a task home from the local today", () => {
    // 2026-11-13 is a Friday; weeks start on Monday by default.
    const today = "2026-11-13";
    expect(taskHomeOf("today", today)).toEqual({ kind: "date", date: "2026-11-13" });
    expect(taskHomeOf("tomorrow", today)).toEqual({ kind: "date", date: "2026-11-14" });
    const week = { kind: "period", horizon: "week" } as const;
    expect(taskHomeOf(undefined, today)).toEqual({
      ...week,
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(taskHomeOf("this-week", today)).toEqual(taskHomeOf(undefined, today));
    expect(taskHomeOf("next-week", today)).toEqual({
      ...week,
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
    });
    expect(taskHomeOf("this-month", today)).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2026-11-01",
      endsOn: "2026-11-30",
    });
    expect(taskHomeOf("next-month", "2026-12-31")).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2027-01-01",
      endsOn: "2027-01-31",
    });
    expect(taskHomeOf("this-year", today)).toEqual({
      kind: "period",
      horizon: "year",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    });
    expect(taskHomeOf("next-year", today)).toEqual({
      kind: "period",
      horizon: "year",
      startsOn: "2027-01-01",
      endsOn: "2027-12-31",
    });
    expect(taskHomeOf("backlog", today)).toEqual({ kind: "backlog", horizon: null });
    expect(taskHomeOf("week-backlog", today)).toEqual({ kind: "backlog", horizon: "week" });
    expect(taskHomeOf("month-backlog", today)).toEqual({ kind: "backlog", horizon: "month" });
    expect(taskHomeOf("year-backlog", today)).toEqual({ kind: "backlog", horizon: "year" });
  });
});

describe("resolveTaskHome", () => {
  const today = "2026-11-13";

  it("puts a date on that day, or commits to the period containing it", () => {
    expect(resolveTaskHome({ date: "2026-11-16" }, today)).toEqual({
      kind: "date",
      date: "2026-11-16",
    });
    expect(resolveTaskHome({ date: "2026-11-18", period: "week" }, today)).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
    });
    expect(resolveTaskHome({ date: "2027-02-10", period: "month" }, today)).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2027-02-01",
      endsOn: "2027-02-28",
    });
    expect(resolveTaskHome({ date: "2028-06-01", period: "year" }, today)).toEqual({
      kind: "period",
      horizon: "year",
      startsOn: "2028-01-01",
      endsOn: "2028-12-31",
    });
    expect(resolveTaskHome({ when: "next-week" }, today)).toEqual(taskHomeOf("next-week", today));
    expect(resolveTaskHome({}, today)).toBeNull();
  });

  it("refuses unreal dates and contradictory fields", () => {
    expect(resolveTaskHome({ date: "2026-02-30" }, today)).toMatch(/not a real date/);
    expect(resolveTaskHome({ date: "2026-13-01" }, today)).toMatch(/not a real date/);
    expect(resolveTaskHome({ date: "Monday" }, today)).toMatch(/YYYY-MM-DD/);
    expect(resolveTaskHome({ date: "2026-11-16", when: "today" }, today)).toMatch(/not both/);
    expect(resolveTaskHome({ period: "week" }, today)).toMatch(/needs a `date`/);
  });
});

describe("withReminder", () => {
  it("sets, keeps and clears a day's reminder, and only on a day", () => {
    const day = { kind: "date", date: "2026-11-16" } as const;
    expect(withReminder(day, "09:30")).toEqual({ ...day, reminderTime: "09:30" });
    expect(withReminder({ ...day, reminderTime: "09:30" }, undefined)).toEqual({
      ...day,
      reminderTime: "09:30",
    });
    expect(withReminder({ ...day, reminderTime: "09:30" }, null)).toEqual(day);
    expect(withReminder(day, "9:30")).toMatch(/not a time/);
    expect(withReminder(day, "24:00")).toMatch(/not a time/);
    expect(withReminder({ kind: "backlog", horizon: null }, "09:30")).toMatch(/single day/);
  });
});

// ── The tools against the real engine ──────────────────────────────

const CODEX = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-11-01T00:00:00.000Z";
/** Friday 2026-11-13, midday UTC, so the local day is the 13th in every US zone. */
const NOW = "2026-11-13T17:00:00.000Z";
const ACME = ProjectId.make("acme");
const OTHER = ProjectId.make("other");
const HOME = ProjectId.make("assistant-home");
const ACME_COORD = ThreadId.make("acme-coord");
const ACME_STANDING = ThreadId.make("acme-standing");
const OTHER_COORD = ThreadId.make("other-coord");
const ASSISTANT = ThreadId.make("assistant");
const ASSISTANT_CHANNEL = ThreadId.make("assistant-channel");

let settings = DEFAULT_SERVER_SETTINGS;
const useAssistant = (patch: Partial<AssistantSettings>) => {
  settings = {
    ...DEFAULT_SERVER_SETTINGS,
    assistant: { ...DEFAULT_SERVER_SETTINGS.assistant, ...patch },
  };
};

const TestLayer = AgentsToolkitHandlersLive.pipe(
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(RemoteAgentsLocalOnly),
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
  ),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-tools-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let counter = 0;
const cid = () => CommandId.make(`task-test-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const createThread = (threadId: ThreadId, projectId: ProjectId) =>
  dispatch({
    type: "thread.create",
    commandId: cid(),
    threadId,
    projectId,
    title: threadId,
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: SEEDED_AT,
  });

/** Acme (coordinator + a pinned standing agent), Other, and the global Assistant with a pinned channel. */
const seed = Effect.gen(function* () {
  for (const [projectId, coordinator, scope] of [
    [ACME, ACME_COORD, undefined],
    [OTHER, OTHER_COORD, undefined],
    [HOME, ASSISTANT, "global"],
  ] as const) {
    yield* dispatch({
      type: "project.create",
      commandId: cid(),
      projectId,
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      createdAt: SEEDED_AT,
    });
    yield* createThread(coordinator, projectId);
    yield* dispatch({
      type: "project.meta.update",
      commandId: cid(),
      projectId,
      assistant: { coordinatorThreadId: coordinator, ...(scope ? { scope } : {}) },
    });
  }
  yield* createThread(ACME_STANDING, ACME);
  yield* dispatch({ type: "thread.pin", commandId: cid(), threadId: ACME_STANDING });
  yield* createThread(ASSISTANT_CHANNEL, HOME);
  yield* dispatch({ type: "thread.pin", commandId: cid(), threadId: ASSISTANT_CHANNEL });
  // One task the user added themselves.
  yield* dispatch({
    type: "task.create",
    commandId: cid(),
    taskId: TaskId.make("user-task"),
    title: "Renew passport",
    home: { kind: "backlog", horizon: null },
    createdAt: SEEDED_AT,
  });
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seed),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
  );

const call = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
  success: S,
  caller: ThreadId,
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
      capabilities: new Set<McpInvocationContext.McpCapability>(["agents"]),
      issuedAt: 1,
    }),
  );

const tools = {
  list: (caller: ThreadId) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_list", {}), TaskListResult, caller),
    ),
  propose: (caller: ThreadId, params: TaskProposeInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_propose", params), TaskProposeResult, caller),
    ),
  update: (caller: ThreadId, params: TaskUpdateInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_update", params), TaskUpdateResult, caller),
    ),
};
const storedTask = (taskId: string) =>
  Effect.gen(function* () {
    const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
    return model.tasks?.find((task) => task.id === taskId);
  });

const errorOf = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.flip(effect).pipe(Effect.map((error) => ({ tag: error._tag, message: error.message })));

describe("cp_task_propose", () => {
  it.effect("a coordinator proposes a task for a specific day with a reminder", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const result = yield* tools.propose(ACME_COORD, {
          title: "Verify ISN integration in prod",
          date: "2026-11-16",
          reminderTime: "09:00",
        });
        expect(result.added).toBe(false);
        expect(result.proposed).toBe(1);
        expect(result.task.home).toEqual({
          kind: "date",
          date: "2026-11-16",
          reminderTime: "09:00",
        });
        expect(result.task.proposal?.projectId).toBe(ACME);
        expect(result.task.proposal?.acceptedAt).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps the old `when` values and supports next periods and horizon backlogs", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const legacy = yield* tools.propose(ACME_COORD, { title: "Legacy", when: "this-month" });
        expect(legacy.task.home).toEqual({
          kind: "period",
          horizon: "month",
          startsOn: "2026-11-01",
          endsOn: "2026-11-30",
        });
        const fallback = yield* tools.propose(ACME_COORD, { title: "Default" });
        expect(fallback.task.home).toMatchObject({ kind: "period", horizon: "week" });
        const nextWeek = yield* tools.propose(ACME_COORD, { title: "Next", when: "next-week" });
        expect(nextWeek.task.home).toEqual({
          kind: "period",
          horizon: "week",
          startsOn: "2026-11-16",
          endsOn: "2026-11-22",
        });
        const backlog = yield* tools.propose(ACME_COORD, { title: "Later", when: "year-backlog" });
        expect(backlog.task.home).toEqual({ kind: "backlog", horizon: "year" });
        const month = yield* tools.propose(ACME_COORD, {
          title: "February",
          date: "2027-02-14",
          period: "month",
        });
        expect(month.task.home).toEqual({
          kind: "period",
          horizon: "month",
          startsOn: "2027-02-01",
          endsOn: "2027-02-28",
        });
      }),
    ),
  );

  it.effect("refuses an unreal date, a reminder off a day, and conflicting fields", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        expect(
          (yield* errorOf(tools.propose(ACME_COORD, { title: "A", date: "2026-02-30" }))).message,
        ).toMatch(/not a real date/);
        expect(
          (yield* errorOf(
            tools.propose(ACME_COORD, { title: "A", when: "this-week", reminderTime: "09:00" }),
          )).message,
        ).toMatch(/single day/);
        expect(
          (yield* errorOf(
            tools.propose(ACME_COORD, { title: "A", when: "today", date: "2026-11-16" }),
          )).message,
        ).toMatch(/not both/);
      }),
    ),
  );

  it.effect("the Assistant proposes when its settings say propose", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "propose" });
        const result = yield* tools.propose(ASSISTANT, { title: "Call the bank", when: "today" });
        expect(result.added).toBe(false);
        expect(result.task.proposal?.projectId).toBe(HOME);
      }),
    ),
  );

  it.effect("the Assistant adds directly when its settings say create, from any channel", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const result = yield* tools.propose(ASSISTANT, {
          title: "Verify ISN integration in prod",
          date: "2026-11-16",
        });
        expect(result.added).toBe(true);
        expect(result.task.proposal).toBeUndefined();
        expect(result.task.home).toEqual({ kind: "date", date: "2026-11-16" });
        const fromChannel = yield* tools.propose(ASSISTANT_CHANNEL, { title: "Book flights" });
        expect(fromChannel.added).toBe(true);
      }),
    ),
  );

  it.effect("the Assistant only proposes when task access is read only", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "read", newTasks: "create" });
        const result = yield* tools.propose(ASSISTANT, { title: "Call the bank" });
        expect(result.added).toBe(false);
        expect(result.task.proposal).toBeDefined();
      }),
    ),
  );

  it.effect("coordinators keep proposing even when the Assistant adds directly", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const result = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        expect(result.added).toBe(false);
        expect(result.task.proposal?.acceptedAt).toBeUndefined();
      }),
    ),
  );

  it.effect("refuses the Assistant with task access off, and non-coordinator agents", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "off" });
        const off = yield* errorOf(tools.propose(ASSISTANT, { title: "Call the bank" }));
        expect(off.tag).toBe("TaskAccessDeniedError");
        expect(off.message).toMatch(/turned off/);
        const agent = yield* errorOf(tools.propose(ACME_STANDING, { title: "Call the bank" }));
        expect(agent.tag).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("cp_task_list", () => {
  it.effect("the Assistant sees every open task; a coordinator only its Project's", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "read" });
        yield* tools.propose(OTHER_COORD, { title: "Other's task" });
        const all = yield* tools.list(ASSISTANT);
        expect(all.tasks.map((task) => task.title).toSorted()).toEqual([
          "Other's task",
          "Renew passport",
        ]);
        const acme = yield* tools.list(ACME_COORD);
        expect(acme.tasks).toEqual([]);
        useAssistant({ tasks: "off" });
        expect((yield* errorOf(tools.list(ASSISTANT))).tag).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("cp_task_update", () => {
  it.effect("the Assistant with edit access moves, renames and completes any task", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const moved = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          title: "Renew passport online",
          date: "2026-11-16",
          reminderTime: "08:15",
          notes: "Form DS-82",
        });
        expect(moved.task).toMatchObject({
          title: "Renew passport online",
          notes: "Form DS-82",
          home: { kind: "date", date: "2026-11-16", reminderTime: "08:15" },
        });
        // A new day keeps the reminder; null clears it.
        const later = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          date: "2026-11-17",
        });
        expect(later.task.home).toEqual({
          kind: "date",
          date: "2026-11-17",
          reminderTime: "08:15",
        });
        const cleared = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          reminderTime: null,
        });
        expect(cleared.task.home).toEqual({ kind: "date", date: "2026-11-17" });
        const done = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          status: "completed",
        });
        expect(done.task.status).toBe("completed");
        expect(done.task.completedAt).toBeDefined();
        const reopened = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          status: "todo",
        });
        expect(reopened.task.status).toBe("todo");
        const committed = yield* tools.update(ASSISTANT_CHANNEL, {
          taskId: TaskId.make("user-task"),
          when: "next-month",
        });
        expect(committed.task.home).toEqual({
          kind: "period",
          horizon: "month",
          startsOn: "2026-12-01",
          endsOn: "2026-12-31",
        });
      }),
    ),
  );

  it.effect("refuses the Assistant with read-only or off task access", () =>
    run(
      Effect.gen(function* () {
        for (const tasks of ["read", "off"] as const) {
          useAssistant({ tasks });
          const error = yield* errorOf(
            tools.update(ASSISTANT, { taskId: TaskId.make("user-task"), when: "today" }),
          );
          expect(error.tag).toBe("TaskAccessDeniedError");
          expect(error.message).toMatch(tasks === "read" ? /Read only/ : /turned off/);
        }
        expect((yield* storedTask("user-task"))?.home).toEqual({ kind: "backlog", horizon: null });
      }),
    ),
  );

  it.effect("the Assistant may move a waiting proposal but never accept it", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const proposed = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const moved = yield* tools.update(ASSISTANT, { taskId: proposed.task.id, when: "today" });
        expect(moved.task.home).toEqual({ kind: "date", date: "2026-11-13" });
        expect(moved.task.proposal?.acceptedAt).toBeUndefined();
        const error = yield* errorOf(
          tools.update(ASSISTANT, { taskId: proposed.task.id, status: "completed" }),
        );
        expect(error.message).toMatch(/still a proposal/);
      }),
    ),
  );

  it.effect("a coordinator edits only its own Project's tasks and never completes them", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const moved = yield* tools.update(ACME_COORD, {
          taskId: own.task.id,
          date: "2026-11-20",
          title: "Approve email copy",
        });
        expect(moved.task).toMatchObject({
          title: "Approve email copy",
          home: { kind: "date", date: "2026-11-20" },
        });
        expect(moved.task.proposal?.acceptedAt).toBeUndefined();

        const status = yield* errorOf(
          tools.update(ACME_COORD, { taskId: own.task.id, status: "completed" }),
        );
        expect(status.message).toMatch(/Only the user completes/);

        const others = yield* errorOf(
          tools.update(OTHER_COORD, { taskId: own.task.id, when: "today" }),
        );
        expect(others.message).toMatch(/only edit tasks this Project proposed/);

        const users = yield* errorOf(
          tools.update(ACME_COORD, { taskId: TaskId.make("user-task"), when: "today" }),
        );
        expect(users.message).toMatch(/only edit tasks this Project proposed/);

        const agent = yield* errorOf(
          tools.update(ACME_STANDING, { taskId: own.task.id, when: "today" }),
        );
        expect(agent.tag).toBe("TaskAccessDeniedError");
      }),
    ),
  );

  it.effect("refuses an empty edit and a missing task", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        expect(
          (yield* errorOf(tools.update(ASSISTANT, { taskId: TaskId.make("user-task") }))).message,
        ).toMatch(/Nothing to change/);
        expect(
          (yield* errorOf(tools.update(ASSISTANT, { taskId: TaskId.make("nope"), when: "today" })))
            .message,
        ).toMatch(/no longer exists/);
      }),
    ),
  );
});

describe("task agent commands in the decider", () => {
  it.effect("refuse a direct add from anyone but the Assistant", () =>
    run(
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(
          dispatch({
            type: "task.agent.create",
            commandId: cid(),
            taskId: TaskId.make("sneaky"),
            actorThreadId: ACME_COORD,
            title: "Sneaky",
            home: { kind: "backlog", horizon: null },
            createdAt: NOW,
          }),
        );
        expect(outcome._tag).toBe("Failure");
        expect(yield* storedTask("sneaky")).toBeUndefined();
      }),
    ),
  );

  it.effect("complete a repeating task's occurrence and open the next one", () =>
    run(
      Effect.gen(function* () {
        yield* dispatch({
          type: "task.create",
          commandId: cid(),
          taskId: TaskId.make("weekly"),
          title: "Weekly review",
          home: { kind: "date", date: "2026-11-13" },
          recurrence: { frequency: "weekly", interval: 1 },
          createdAt: SEEDED_AT,
        });
        useAssistant({ tasks: "edit" });
        yield* tools.update(ASSISTANT, { taskId: TaskId.make("weekly"), status: "completed" });
        const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
        const open = (model.tasks ?? []).filter(
          (task: Task) => task.title === "Weekly review" && task.status === "todo",
        );
        expect(open.map((task) => task.home)).toEqual([{ kind: "date", date: "2026-11-20" }]);
      }),
    ),
  );
});
