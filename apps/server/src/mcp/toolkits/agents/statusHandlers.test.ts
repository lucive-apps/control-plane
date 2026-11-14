import * as ServerSettings from "../../../serverSettings.ts";
import { RemoteAgentsLocalOnly } from "../../../agentMachines/testFixtures.ts";
import {
  CommandId,
  PROJECT_STATUS_LIMIT,
  countStatusesNeedingUser,
  visibleProjectStatuses,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  statusReminderMessageId,
  statusReplyText,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectAssistant,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../../config.ts";
import { makeAgentPushQueries } from "../../../orchestration/agentPushes.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as StatusDeadlineReactor from "../../../orchestration/StatusDeadlineReactor.ts";
import { statusReplyEvents } from "../../../orchestration/statusDecider.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { HostTimeZoneSource } from "../../../schedules/hostZone.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlersLive } from "./handlers.ts";
import { AgentsToolkit, StatusListResult, StatusSetResult } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-acme");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const COORDINATOR = ThreadId.make("thread-coordinator");
const SALES = ThreadId.make("thread-sales");
const PDF = ThreadId.make("thread-pdf");
const OTHER_COORDINATOR = ThreadId.make("thread-other-coordinator");
const CODEX = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const NOW = "2026-10-28T12:00:00.000Z";
const THURSDAY = "2026-10-29T17:00:00.000Z";

/** The real engine, projections and SQLite, so writes go through the decider as they do live. */
const TestLayer = Layer.mergeAll(
  AgentsToolkitHandlersLive,
  StatusDeadlineReactor.layer.pipe(Layer.provide(ProjectionProjectRepositoryLive)),
  ProjectionThreadMessageRepositoryLive,
).pipe(
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(RemoteAgentsLocalOnly),
  Layer.provideMerge(ServerSettings.layerTest()),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-status-tools-" })),
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

/** Project Acme: coordinator, standing agent Sales, one-off agent PDF. Project Other: its own coordinator. */
const seed = Effect.gen(function* () {
  for (const [projectId, title, coordinator] of [
    [PROJECT_ID, "Acme", COORDINATOR],
    [OTHER_PROJECT_ID, "Other", OTHER_COORDINATOR],
  ] as const) {
    yield* dispatch({
      type: "project.create",
      commandId: nextCommandId(),
      projectId,
      title,
      workspaceRoot: `/tmp/${title.toLowerCase()}`,
      createdAt: SEEDED_AT,
    });
    yield* createThread(coordinator, projectId, title);
  }
  yield* createThread(SALES, PROJECT_ID, "Sales");
  yield* createThread(PDF, PROJECT_ID, "PDF agent");
  yield* dispatch({ type: "thread.pin", commandId: nextCommandId(), threadId: SALES });
  for (const [projectId, coordinatorThreadId] of [
    [PROJECT_ID, COORDINATOR],
    [OTHER_PROJECT_ID, OTHER_COORDINATOR],
  ] as const) {
    yield* dispatch({
      type: "project.meta.update",
      commandId: nextCommandId(),
      projectId,
      assistant: { coordinatorThreadId },
    });
  }
});

const readMarker = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const readModel = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
    const assistant = readModel.projects.find((project) => project.id === projectId)?.assistant;
    if (assistant == null) throw new Error(`Project ${projectId} has no marker.`);
    return assistant;
  });

const statusOf = (marker: ProjectAssistant, id: string) => {
  const status = marker.statuses?.find((entry) => entry.id === id);
  if (status === undefined) throw new Error(`No status ${id}.`);
  return status;
};

const messagesOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionThreadMessageRepository, (messages) =>
    messages.listByThreadId({ threadId }),
  );

const statusTools = Effect.gen(function* () {
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
    ) => run(toolkit.handle("cp_status_list", {}), StatusListResult, caller, capabilities),
    set: (caller: ThreadId, params: Parameters<typeof toolkit.handle<"cp_status_set">>[1]) =>
      run(toolkit.handle("cp_status_set", params), StatusSetResult, caller, ["agents"]),
  };
});

const withSeededEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seed),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
    Effect.provideService(HostTimeZoneSource, () => ({ zone: "UTC", processZone: "UTC" })),
  );

const PAYOUTS = {
  id: "payouts",
  title: "Payouts",
  summary: "Connect onboarding and the payout webhook pass in sandbox.",
  detail: "The 1099 step has not run against a live account yet.",
  question: "Pilot or release to every inspector?",
  recommendation: "Pilot with 5 inspectors behind a flag",
  answer: "Pilot with 5",
  deadline: THURSDAY,
} as const;

describe("status tool access", () => {
  it.effect("refuses a caller without the agents capability", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const error = yield* tools.list(COORDINATOR, []).pipe(Effect.flip);
        expect(error._tag).toBe("McpCapabilityUnavailableError");
      }),
    ),
  );

  it.effect("refuses a standing agent even though it holds the agents capability", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const error = yield* tools
          .set(SALES, { id: "pipeline", title: "Pipeline", summary: "Mine now." })
          .pipe(Effect.flip);
        expect(error._tag).toBe("StatusCoordinatorOnlyError");
        expect((yield* readMarker(PROJECT_ID)).statuses).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps each coordinator to its own Project's board", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(OTHER_COORDINATOR, { id: "launch", title: "Launch", summary: "Soon." });
        expect((yield* tools.list(COORDINATOR)).statuses).toEqual([]);
        // An agent of another Project is not a thread this board can list.
        const error = yield* tools
          .set(OTHER_COORDINATOR, { id: "launch", agents: [PDF] })
          .pipe(Effect.flip);
        expect(error.message).toContain("is not a thread in this Project");
      }),
    ),
  );
});

describe("cp_status_set", () => {
  it.effect("writes a workstream with a decision as needs-you, and lists those first", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, {
          id: "pdf",
          title: "Report PDF export",
          summary: "Photo grids still break across pages.",
          agents: [PDF],
        });
        const result = yield* tools.set(COORDINATOR, { ...PAYOUTS, state: "working" });

        expect(result.needsYou).toBe(1);
        expect(result.status).toMatchObject({
          state: "needs-you",
          decision: {
            question: PAYOUTS.question,
            recommendation: PAYOUTS.recommendation,
            deadline: THURSDAY,
            openedAt: NOW,
          },
          updatedAt: NOW,
        });
        const listed = yield* tools.list(COORDINATOR);
        expect(listed.statuses.map((status) => status.id)).toEqual(["payouts", "pdf"]);
        expect(statusOf(yield* readMarker(PROJECT_ID), "pdf").agents).toEqual([PDF]);
      }),
    ),
  );

  it.effect("keeps a decision's version for an unchanged write and restamps any change", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.adjust("1 hour");
        const same = yield* tools.set(COORDINATOR, {
          ...PAYOUTS,
          summary: "Webhook retries fixed.",
        });
        expect(same.status?.decision?.openedAt).toBe(NOW);
        expect(same.status?.updatedAt).not.toBe(NOW);

        const tweaked = yield* tools.set(COORDINATOR, {
          id: "payouts",
          recommendation: "Pilot with 3 inspectors",
          answer: "Pilot with 3",
        });
        expect(tweaked.status?.decision?.openedAt).toBe(tweaked.status?.updatedAt);
        expect(tweaked.status?.decision?.question).toBe(PAYOUTS.question);
      }),
    ),
  );

  it.effect("clears an answered decision back to working, keeping the lines", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const cleared = yield* tools.set(COORDINATOR, {
          id: "payouts",
          clearDecision: true,
          summary: "Flag going on for three pilots.",
          detail: "",
        });
        expect(cleared.needsYou).toBe(0);
        expect(cleared.status).toEqual({
          id: "payouts",
          title: "Payouts",
          state: "working",
          summary: "Flag going on for three pilots.",
          updatedAt: NOW,
        });
      }),
    ),
  );

  it.effect("refuses what would make the board wrong", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const refusals = yield* Effect.forEach(
          [
            { id: "new-one", title: "No summary" },
            { id: "payouts-2", title: "payouts", summary: "Same title, other case." },
            { id: "payouts", deadline: "2026-10-01T00:00:00.000Z" },
            { id: "payouts", deadline: "next thursday" },
            { id: "payouts", clearDecision: true, question: "Both at once?" },
            { id: "nav", title: "Nav", summary: "Copy.", question: "Rename it?" },
            { id: "nav", title: "Nav", summary: "x".repeat(61) },
            { id: "missing", remove: true },
          ],
          (params) =>
            tools.set(COORDINATOR, params).pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            ),
        );
        expect(refusals).toEqual([
          "A new workstream needs a title and a summary.",
          "Another workstream is already titled 'payouts'.",
          "The deadline must be in the future.",
          "Deadline 'next thursday' is not an ISO date-time.",
          "Pass clearDecision alone, or a new question without clearDecision.",
          "A decision needs both a question and your recommendation.",
          "The summary is at most 60 characters.",
          "There is no workstream 'missing'.",
        ]);
        expect((yield* readMarker(PROJECT_ID)).statuses).toHaveLength(1);
      }),
    ),
  );

  it.effect("removes a workstream", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const removed = yield* tools.set(COORDINATOR, { id: "payouts", remove: true });
        expect(removed).toEqual({ id: "payouts", status: null, needsYou: 0 });
        expect((yield* readMarker(PROJECT_ID)).statuses).toBeUndefined();
      }),
    ),
  );

  it.effect("survives the user's own Project edits, such as archive and unarchive", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        for (const archived of [true, false]) {
          yield* dispatch({
            type: "project.meta.update",
            commandId: nextCommandId(),
            projectId: PROJECT_ID,
            assistant: { archived },
          });
        }
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.question).toBe(
          PAYOUTS.question,
        );
      }),
    ),
  );
});

describe("StatusDeadlineReactor", () => {
  const reminders = Effect.map(messagesOf(COORDINATOR), (messages) =>
    messages.filter((message) => message.messageId.startsWith("cp-status:")),
  );

  it.effect("reminds the coordinator once when a deadline passes, never as approval", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);

        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(0);

        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        yield* reactor.sweep;
        const sent = yield* reminders;
        expect(sent.map((message) => message.messageId)).toEqual([
          statusReminderMessageId(PROJECT_ID, "payouts", NOW),
        ]);
        expect(sent[0]?.source).toEqual({ kind: "agent", threadTitle: "Status" });
        // Delivered like a schedule run: the coordinator's next idle moment starts a turn on it.
        const deliveries = yield* makeAgentPushQueries(yield* SqlClient.SqlClient).listDeliveries(
          PROJECT_ID,
        );
        expect(deliveries.map((delivery) => delivery.messageId)).toEqual([sent[0]?.messageId]);
        expect(sent[0]?.text).toContain("Silence never authorizes acting for the user");
        const decision = statusOf(yield* readMarker(PROJECT_ID), "payouts").decision;
        expect(decision?.deadlineHandled?.outcome).toBe("reminded");
        // Still waiting on the user: a reminder never answers the question.
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").state).toBe("needs-you");
      }),
    ),
  );

  it.effect("reminds again only for a new version of the question", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;

        const later = "2026-11-02T17:00:00.000Z";
        const moved = yield* tools.set(COORDINATOR, { id: "payouts", deadline: later });
        expect(moved.status?.decision?.deadlineHandled).toBeUndefined();
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(1);

        yield* TestClock.setTime(Date.parse(later) + 1);
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(2);
      }),
    ),
  );

  it.effect("sends the message for a deadline recorded just before a crash, once", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        // A sweep that recorded the deadline and crashed before its message.
        yield* dispatch({
          type: "project.status.deadline",
          commandId: nextCommandId(),
          projectId: PROJECT_ID,
          statusId: "payouts",
          openedAt: NOW,
          outcome: "reminded",
          createdAt: THURSDAY,
        });
        yield* reactor.sweep;
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(1);
      }),
    ),
  );

  it.effect("holds reminders while the Project is archived", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* dispatch({
          type: "project.meta.update",
          commandId: nextCommandId(),
          projectId: PROJECT_ID,
          assistant: { archived: true },
        });
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(0);
      }),
    ),
  );

  const automate = (enabled: boolean, openedAt = NOW) =>
    Effect.flatMap(DateTime.now, (now) =>
      dispatch({
        type: "project.status.automate",
        commandId: nextCommandId(),
        projectId: PROJECT_ID,
        statusId: "payouts",
        openedAt,
        enabled,
        createdAt: DateTime.formatIso(now),
      }),
    );

  it.effect("sends the recommendation as the answer only when the user opted in", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* automate(true);
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.autoAccept).toEqual({
          openedAt: NOW,
          enabledAt: NOW,
        });

        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        const [sent] = yield* reminders;
        expect(sent?.text).toMatch(
          /^Re: Payouts \[status:payouts@\d+\]\n\nGo with your recommendation: Pilot with 5/,
        );
        expect(sent?.text).toContain("the user opted in to this recommendation");
        expect(sent?.text).toContain("anything that needs the user's approval still needs it");
        expect(
          statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.deadlineHandled,
        ).toMatchObject({ outcome: "accepted" });
      }),
    ),
  );

  it.effect("drops the opt-in when the coordinator changes the recommendation", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* automate(true);
        yield* TestClock.adjust("1 hour");
        yield* tools.set(COORDINATOR, {
          id: "payouts",
          recommendation: "Release to everyone",
          answer: "Release",
        });
        // The opt-in named the old version; re-arming it from a stale read is refused.
        const stale = yield* automate(true).pipe(Effect.flip);
        expect(stale.message).toContain("changed this decision");

        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        const [sent] = yield* reminders;
        expect(sent?.text).toContain("This is a reminder, not an answer.");
        expect(
          statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.deadlineHandled,
        ).toMatchObject({ outcome: "reminded" });
      }),
    ),
  );

  it.effect("refuses an opt-in on a decision without a deadline, and lets the user opt out", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, { ...PAYOUTS, deadline: "" });
        const refused = yield* automate(true).pipe(Effect.flip);
        expect(refused.message).toContain("no deadline");

        yield* tools.set(COORDINATOR, { id: "payouts", deadline: THURSDAY });
        const openedAt = statusOf(yield* readMarker(PROJECT_ID), "payouts").decision!.openedAt;
        yield* automate(true, openedAt);
        yield* automate(false, openedAt);
        expect(
          statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.autoAccept,
        ).toBeUndefined();
      }),
    ),
  );

  const userMessage = (text: string) =>
    dispatch({
      type: "thread.turn.start",
      commandId: nextCommandId(),
      threadId: COORDINATOR,
      message: {
        messageId: MessageId.make(`user-${commandCounter}`),
        role: "user",
        text,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    });

  it.effect("records a Re: reply with the message itself, so the deadline stops", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* automate(true);
        const answeredAt = Effect.map(
          readMarker(PROJECT_ID),
          (marker) => statusOf(marker, "payouts").decision?.answeredAt,
        );
        // Untagged chat does not answer; the tag matches the title in any case.
        yield* userMessage("Thanks, looking now.");
        expect(yield* answeredAt).toBeUndefined();
        yield* userMessage("Re: payouts\n\nPilot, but only three inspectors.");
        expect(yield* answeredAt).toBe(NOW);

        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(0);

        // A tagged message from an agent never answers for the user.
        yield* tools.set(COORDINATOR, {
          id: "payouts",
          question: "Which three?",
          answer: "These three",
          deadline: "2026-11-02T17:00:00.000Z",
        });
        yield* dispatch({
          type: "thread.message.user.append",
          commandId: nextCommandId(),
          threadId: COORDINATOR,
          message: {
            messageId: MessageId.make("agent-says"),
            text: "Re: Payouts\n\nGo with it.",
            attachments: [],
            source: { kind: "agent", threadId: SALES, threadTitle: "Sales" },
          },
          createdAt: THURSDAY,
        });
        expect(yield* answeredAt).toBeUndefined();

        // A tagged user append replays idempotently.
        yield* tools.set(COORDINATOR, {
          id: "payouts",
          question: "Which four?",
          answer: "These four",
        });
        const append = dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make("tagged-append"),
          threadId: COORDINATOR,
          message: {
            messageId: MessageId.make("tagged-append"),
            text: "Re: Payouts\n\nThe four on Stripe.",
            attachments: [],
          },
          createdAt: THURSDAY,
        });
        const first = yield* append;
        expect(yield* append).toEqual(first);
        expect(yield* answeredAt).toBeDefined();
      }),
    ),
  );

  it.effect("matches a reply by workstream id and question version, not just title", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const answeredAt = Effect.map(
          readMarker(PROJECT_ID),
          (marker) => statusOf(marker, "payouts").decision?.answeredAt,
        );
        // Renamed since the user started replying: the id still finds it.
        yield* tools.set(COORDINATOR, { id: "payouts", title: "Payouts rollout" });
        // A reply to an older version of the question does not answer the new one.
        yield* TestClock.adjust("1 hour");
        yield* tools.set(COORDINATOR, {
          id: "payouts",
          recommendation: "Pilot with 3",
          answer: "Pilot with 3",
        });
        yield* userMessage(
          statusReplyText("Payouts", "Yes, pilot.", { statusId: "payouts", openedAt: NOW }),
        );
        expect(yield* answeredAt).toBeUndefined();
        const current = statusOf(yield* readMarker(PROJECT_ID), "payouts").decision!.openedAt;
        yield* userMessage(
          statusReplyText("Payouts", "Yes, three.", { statusId: "payouts", openedAt: current }),
        );
        expect(yield* answeredAt).toBeDefined();
      }),
    ),
  );

  it.effect("records nothing for a reply to a row without an open question", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const rows = [
          { id: "pdf", title: "PDF export", summary: "Grids break.", state: "working" },
          { id: "pricing", title: "Pricing page", summary: "After payouts.", state: "queued" },
          { id: "isn", title: "ISN integration", summary: "Merged.", state: "done" },
        ] as const;
        for (const row of rows) yield* tools.set(COORDINATOR, row);
        const before = (yield* readMarker(PROJECT_ID)).statuses;
        for (const row of rows) {
          yield* userMessage(statusReplyText(row.title, "Quick note.", { statusId: row.id }));
        }
        // The workstream is named in the message, and no record is touched.
        expect((yield* readMarker(PROJECT_ID)).statuses).toEqual(before);
        const texts = (yield* messagesOf(COORDINATOR)).map((message) => message.text);
        expect(texts).toContain("Re: Pricing page [status:pricing]\n\nQuick note.");
      }),
    ),
  );

  it.effect("answers only a question that is waiting on the user", () =>
    Effect.gen(function* () {
      const openedAt = "2026-11-11T11:00:00.000Z";
      const row = {
        id: "pdf",
        title: "PDF export",
        summary: "Grids break.",
        state: "working" as const,
        decision: { question: "Ship?", recommendation: "Ship", answer: "Ship", openedAt },
        updatedAt: openedAt,
      };
      const readModel = (state: "working" | "needs-you") =>
        ({
          projects: [
            {
              id: PROJECT_ID,
              deletedAt: null,
              assistant: { coordinatorThreadId: COORDINATOR, statuses: [{ ...row, state }] },
            },
          ],
          threads: [],
        }) as unknown as OrchestrationReadModel;
      const reply = (state: "working" | "needs-you") =>
        statusReplyEvents(readModel(state), {
          threadId: COORDINATOR,
          text: statusReplyText("PDF export", "Ship it.", { statusId: "pdf", openedAt }),
          hasSource: false,
          commandId: nextCommandId(),
          createdAt: openedAt,
        });
      // A decision held outside needs-you shows no question, so nothing is answered.
      expect(yield* reply("working")).toEqual([]);
      expect(yield* reply("needs-you")).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never lets a reply started before the question answer it", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, { id: "pdf", title: "PDF export", summary: "Grids break." });
        yield* tools.set(COORDINATOR, {
          id: "pdf",
          question: "Ship without grids?",
          answer: "Ship it",
          recommendation: "yes",
        });
        // "Ask for update" was clicked while the row had no question: id, no version.
        yield* userMessage(statusReplyText("PDF export", "Any update?", { statusId: "pdf" }));
        expect(statusOf(yield* readMarker(PROJECT_ID), "pdf").decision?.answeredAt).toBeUndefined();
        const refused = yield* tools
          .set(COORDINATOR, { id: "pdf", title: "PDF [status:x]" })
          .pipe(Effect.flip);
        expect(refused.message).toContain("cannot contain");
      }),
    ),
  );

  it.effect("turns an opt-in withdrawn mid-sweep into a reminder, and keeps others moving", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* tools.set(OTHER_COORDINATOR, { ...PAYOUTS, id: "launch", title: "Launch" });
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        // A sweep that read an opt-in the user withdrew before it dispatched.
        yield* dispatch({
          type: "project.status.deadline",
          commandId: CommandId.make(
            `${statusReminderMessageId(PROJECT_ID, "payouts", NOW)}:handled:accepted`,
          ),
          projectId: PROJECT_ID,
          statusId: "payouts",
          openedAt: NOW,
          outcome: "accepted",
          createdAt: THURSDAY,
        });
        // Opting back in once the deadline was handled is refused.
        const late = yield* automate(true).pipe(Effect.flip);
        expect(late.message).toContain("no deadline still ahead");

        yield* reactor.sweep;
        const [sent] = yield* reminders;
        expect(sent?.text).toContain("This is a reminder, not an answer.");
        for (const [projectId, id] of [
          [PROJECT_ID, "payouts"],
          [OTHER_PROJECT_ID, "launch"],
        ] as const) {
          expect(
            statusOf(yield* readMarker(projectId), id).decision?.deadlineHandled,
          ).toMatchObject({ outcome: "reminded" });
        }
      }),
    ),
  );

  it.effect("never carries a passed deadline into a new version of the question", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        const asked = yield* tools.set(COORDINATOR, {
          id: "payouts",
          question: "Pilot with three?",
          answer: "Pilot with 3",
        });
        expect(asked.status?.decision?.deadline).toBeUndefined();
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(1);
      }),
    ),
  );

  it.effect("drops an opt-in whose deadline lapsed while the Project was archived", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* automate(true);
        const archive = (archived: boolean) =>
          dispatch({
            type: "project.meta.update",
            commandId: nextCommandId(),
            projectId: PROJECT_ID,
            assistant: { archived },
          });
        yield* archive(true);
        yield* TestClock.setTime(Date.parse(THURSDAY) + 7 * 86_400_000);
        yield* archive(false);
        yield* reactor.sweep;
        const [sent] = yield* reminders;
        expect(sent?.text).toContain("This is a reminder, not an answer.");
      }),
    ),
  );
});

describe("checking off finished workstreams", () => {
  const DONE = {
    id: "payouts",
    title: "Payouts",
    summary: "Shipped to every inspector.",
    state: "done",
  } as const;

  const dismiss = (dismissed: boolean, updatedAt: string, statusId = "payouts") =>
    Effect.flatMap(DateTime.now, (now) =>
      dispatch({
        type: "project.status.dismiss",
        commandId: nextCommandId(),
        projectId: PROJECT_ID,
        statusId,
        updatedAt,
        dismissed,
        createdAt: DateTime.formatIso(now),
      }),
    );

  it.effect("hides a done row for the user and brings it back on undo, keeping the record", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, DONE);
        yield* TestClock.adjust("1 minute");
        yield* dismiss(true, NOW);
        const hidden = statusOf(yield* readMarker(PROJECT_ID), "payouts");
        expect(hidden.dismissedAt).toBe("2026-10-28T12:01:00.000Z");
        // A user action, not the coordinator checking in.
        expect(hidden.updatedAt).toBe(NOW);
        expect(visibleProjectStatuses((yield* readMarker(PROJECT_ID)).statuses ?? [])).toEqual([]);

        yield* dismiss(false, NOW);
        const shown = statusOf(yield* readMarker(PROJECT_ID), "payouts");
        expect(shown).toEqual({ ...hidden, dismissedAt: undefined });
        expect(shown.dismissedAt).toBeUndefined();
      }),
    ),
  );

  it.effect("refuses a stale check-off once the row is active again", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, DONE);
        yield* TestClock.adjust("1 minute");
        // The coordinator reopens it with a question after the user saw it done.
        yield* tools.set(COORDINATOR, { ...PAYOUTS, deadline: "" });
        const stale = yield* dismiss(true, NOW).pipe(Effect.flip);
        expect(stale.message).toContain("updated this workstream since you saw it");
        // Even at the current version, only a done row can be checked off.
        const current = statusOf(yield* readMarker(PROJECT_ID), "payouts").updatedAt;
        const active = yield* dismiss(true, current).pipe(Effect.flip);
        expect(active.message).toContain("updated this workstream since you saw it");
        const marker = yield* readMarker(PROJECT_ID);
        expect(statusOf(marker, "payouts").dismissedAt).toBeUndefined();
        expect(countStatusesNeedingUser(marker.statuses)).toBe(1);
      }),
    ),
  );

  it.effect("shows a checked-off row again when the coordinator moves it off done", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, DONE);
        yield* dismiss(true, NOW);
        // Staying done keeps it hidden.
        yield* tools.set(COORDINATOR, { id: "payouts", summary: "Shipped; 1099s filed." });
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").dismissedAt).toBeDefined();
        // A new question on it is never hidden.
        yield* tools.set(COORDINATOR, { ...PAYOUTS, deadline: "" });
        const marker = yield* readMarker(PROJECT_ID);
        expect(statusOf(marker, "payouts").dismissedAt).toBeUndefined();
        expect(countStatusesNeedingUser(marker.statuses)).toBe(1);
        // Undo after that is refused rather than rewriting anything.
        const undo = yield* dismiss(false, NOW).pipe(Effect.flip);
        expect(undo.message).toContain("already showing");
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.question).toBe(
          PAYOUTS.question,
        );
      }),
    ),
  );

  it.effect("keeps the coordinator's newer edits when the user undoes", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, DONE);
        yield* dismiss(true, NOW);
        yield* TestClock.adjust("1 minute");
        yield* tools.set(COORDINATOR, { id: "payouts", summary: "Shipped; 1099s filed." });
        yield* dismiss(false, NOW);
        const shown = statusOf(yield* readMarker(PROJECT_ID), "payouts");
        expect(shown.summary).toBe("Shipped; 1099s filed.");
        expect(shown.updatedAt).toBe("2026-10-28T12:01:00.000Z");
        expect(shown.dismissedAt).toBeUndefined();
      }),
    ),
  );

  it.effect("makes room on a full board by dropping the oldest checked-off row", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        for (let index = 0; index < PROJECT_STATUS_LIMIT; index += 1) {
          yield* tools.set(COORDINATOR, {
            id: `w${index}`,
            title: `Workstream ${index}`,
            summary: "Done.",
            state: "done",
          });
        }
        const full = yield* tools
          .set(COORDINATOR, { id: "next", title: "Next", summary: "Starting." })
          .pipe(Effect.flip);
        expect(String(full)).toContain(`at most ${PROJECT_STATUS_LIMIT} workstreams`);

        yield* dismiss(true, NOW, "w3");
        yield* TestClock.adjust("1 minute");
        yield* dismiss(true, NOW, "w1");
        yield* tools.set(COORDINATOR, { id: "next", title: "Next", summary: "Starting." });
        const ids = ((yield* readMarker(PROJECT_ID)).statuses ?? []).map((status) => status.id);
        expect(ids).toHaveLength(PROJECT_STATUS_LIMIT);
        expect(ids).not.toContain("w3");
        expect(ids).toContain("w1");
        expect(ids).toContain("next");
      }),
    ),
  );
});
