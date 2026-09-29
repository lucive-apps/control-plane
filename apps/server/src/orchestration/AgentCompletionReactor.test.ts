import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationAgentMessageSource,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as AgentCompletionReactor from "./AgentCompletionReactor.ts";
import { AgentLineage } from "./agentLineage.ts";
import { AGENT_PUSH_BUDGET, agentPushId, agentSendId, agentStopId } from "./agentProtocol.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

// A fresh in-memory database per test.
const EngineLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-completion-reactor-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const NOW = "2026-09-28T12:00:00.000Z";
const PROJECT = ProjectId.make("project-personal");
const COORDINATOR = ThreadId.make("coordinator");
const CODEX = ProviderInstanceId.make("codex");

const pushIdOf = (agent: ThreadId, request: MessageId) =>
  MessageId.make(agentPushId(agent, request));

const resultText = (title: string, agent: ThreadId, state: string, body: string) =>
  `Result from agent "${title}" (threadId ${agent}): ${state}\n\n${body}`;

/** Commands in the order ingestion dispatches them, plus reads for assertions. */
const makeFixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const creators = new Map<ThreadId, ThreadId>();
  let counter = 0;
  const nextId = (label: string) => `test:${label}:${++counter}`;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.asVoid);

  const reactorLayer = AgentCompletionReactor.layerWithoutLineage.pipe(
    Layer.provide(
      Layer.mock(AgentLineage)({
        creatorOf: (threadId) => Effect.succeed(creators.get(threadId) ?? null),
      }),
    ),
  );

  /** Runs `body` with a started reactor, then stops it. */
  const withReactor = <A, E, R>(body: (drain: Effect.Effect<void>) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const reactor = yield* AgentCompletionReactor.AgentCompletionReactor;
      yield* reactor.start();
      yield* reactor.drain;
      return yield* body(reactor.drain);
    }).pipe(Effect.scoped, Effect.provide(reactorLayer));

  const createThread = (
    threadId: ThreadId,
    title: string,
    options: { readonly createdBy?: ThreadId; readonly pinned?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(nextId("create")),
        threadId,
        projectId: PROJECT,
        title,
        modelSelection: { instanceId: CODEX, model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: yield* now,
        ...(options.createdBy !== undefined ? { createdByThreadId: options.createdBy } : {}),
      });
      if (options.createdBy !== undefined) creators.set(threadId, options.createdBy);
      if (options.pinned === true) {
        yield* dispatch({ type: "thread.pin", commandId: CommandId.make(nextId("pin")), threadId });
      }
    });

  const createProject = Effect.gen(function* () {
    yield* dispatch({
      type: "project.create",
      commandId: CommandId.make(nextId("project")),
      projectId: PROJECT,
      title: "Personal",
      workspaceRoot: "/tmp/project-personal",
      createdAt: yield* now,
    });
    yield* createThread(COORDINATOR, "Personal");
    yield* dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(nextId("marker")),
      projectId: PROJECT,
      assistant: { coordinatorThreadId: COORDINATOR },
    });
  });

  const startTurn = (
    threadId: ThreadId,
    messageId: MessageId,
    source?: OrchestrationAgentMessageSource,
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(nextId("turn-start")),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "Compare the options",
          attachments: [],
          ...(source !== undefined ? { source } : {}),
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: yield* now,
      });
    });

  /** A manager's request: its result goes back to `from`. */
  const request = (agent: ThreadId, messageId: MessageId, from: ThreadId) =>
    startTurn(agent, messageId, {
      kind: "agent",
      threadId: from,
      threadTitle: "Manager",
      replyTo: from,
    });

  /** A manager's `cp_thread_send` held for a busy agent, as the toolkit appends it. */
  const holdSend = (agent: ThreadId, messageId: MessageId, from: ThreadId, text: string) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(messageId),
        threadId: agent,
        message: {
          messageId,
          text,
          attachments: [],
          source: { kind: "agent", threadId: from, threadTitle: "Manager", replyTo: from },
        },
        createdAt: yield* now,
      });
    });

  const setSession = (
    threadId: ThreadId,
    status: OrchestrationSessionStatus,
    activeTurnId: TurnId | null,
    lastError: string | null = null,
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      yield* dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(nextId("session")),
        threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          providerInstanceId: CODEX,
          runtimeMode: "full-access",
          activeTurnId,
          lastError,
          updatedAt: createdAt,
        },
        createdAt,
      });
    });

  /** The session adopts the thread's pending start as `turnId`. */
  const beginTurn = (threadId: ThreadId, turnId: TurnId) => setSession(threadId, "running", turnId);

  /** The final assistant message lands before the turn-ending session-set. */
  const endTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    text: string,
    status: OrchestrationSessionStatus = "ready",
    lastError: string | null = null,
  ) =>
    Effect.gen(function* () {
      if (text.length > 0) {
        const messageId = MessageId.make(`assistant:${turnId}`);
        yield* dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(nextId("delta")),
          threadId,
          messageId,
          delta: text,
          turnId,
          createdAt: yield* now,
        });
        yield* dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(nextId("complete")),
          threadId,
          messageId,
          turnId,
          createdAt: yield* now,
        });
      }
      yield* setSession(threadId, status, null, lastError);
    });

  const finishTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    text: string,
    status: OrchestrationSessionStatus = "ready",
    lastError: string | null = null,
  ) =>
    beginTurn(threadId, turnId).pipe(
      Effect.andThen(endTurn(threadId, turnId, text, status, lastError)),
    );

  const appendActivity = (
    threadId: ThreadId,
    kind: string,
    payload: Record<string, unknown>,
    turnId: TurnId | null = null,
  ) =>
    Effect.gen(function* () {
      const id = nextId("activity");
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(id),
        threadId,
        activity: {
          id: EventId.make(id),
          tone: "info",
          kind,
          summary: kind,
          payload,
          turnId,
          createdAt: yield* now,
        },
        createdAt: yield* now,
      });
    });

  const userMessages = (threadId: ThreadId) =>
    sql<{ readonly id: string; readonly text: string }>`
      SELECT message_id AS id, text
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
      ORDER BY rowid
    `;
  const sourceOf = (messageId: string) =>
    sql<{
      readonly kind: string;
      readonly threadId: string;
      readonly threadTitle: string;
      readonly replyTo: string | null;
    }>`
      SELECT json_extract(source_json, '$.kind') AS kind,
             json_extract(source_json, '$.threadId') AS "threadId",
             json_extract(source_json, '$.threadTitle') AS "threadTitle",
             json_extract(source_json, '$.replyTo') AS "replyTo"
      FROM projection_thread_messages
      WHERE message_id = ${messageId}
    `.pipe(Effect.map((rows) => rows[0]));
  const receipts = (prefix: string) =>
    sql<{ readonly id: string; readonly status: string }>`
      SELECT command_id AS id, status FROM orchestration_command_receipts
      WHERE command_id GLOB ${`${prefix}*`}
      ORDER BY command_id
    `.pipe(Effect.map((rows) => rows.map((row) => `${row.status} ${row.id}`)));
  const activities = (threadId: ThreadId, kind: string) =>
    sql<{ readonly id: string; readonly detail: string | null; readonly requestId: string | null }>`
      SELECT activity_id AS id,
             json_extract(payload_json, '$.detail') AS detail,
             json_extract(payload_json, '$.requestId') AS "requestId"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND kind = ${kind}
      ORDER BY rowid
    `;
  const settled = (threadId: ThreadId) =>
    sql<{ readonly settled: string | null }>`
      SELECT settled_override AS settled FROM projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.settled === "settled"));
  const turnStartsOf = (messageId: string) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE event_type = 'thread.turn-start-requested'
        AND json_extract(payload_json, '$.messageId') = ${messageId}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  return {
    engine,
    dispatch,
    nextId,
    now,
    withReactor,
    createProject,
    createThread,
    startTurn,
    request,
    holdSend,
    setSession,
    beginTurn,
    endTurn,
    finishTurn,
    appendActivity,
    userMessages,
    sourceOf,
    receipts,
    activities,
    settled,
    turnStartsOf,
  };
});

const test = <A, E>(
  name: string,
  body: Effect.Effect<A, E, OrchestrationEngineService | SqlClient.SqlClient>,
) => it.effect(name, () => body.pipe(Effect.provide(EngineLayer)));

const T = (id: string) => TurnId.make(id);
const M = (id: string) => MessageId.make(id);
const A = (id: string) => ThreadId.make(id);

describe("AgentCompletionReactor", () => {
  test(
    "pushes a coordinator's request into the coordinator, starts it, and settles the agent",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.finishTurn(agent, T("turn-1"), "WAL wins on concurrency.");
          yield* drain;
        }),
      );

      const pushId = pushIdOf(agent, M("request-1"));
      const messages = yield* f.userMessages(COORDINATOR);
      assert.deepStrictEqual(
        messages.map((message) => message.id),
        [pushId],
      );
      assert.strictEqual(
        messages[0]!.text,
        resultText("Compare", agent, "finished", "WAL wins on concurrency."),
      );
      assert.deepStrictEqual(yield* f.sourceOf(pushId), {
        kind: "agent",
        threadId: agent,
        threadTitle: "Compare",
        replyTo: null,
      });
      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${pushId}`]);
      assert.isTrue(yield* f.settled(agent));
    }),
  );

  test(
    "delivers a standing agent's result without settling it",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const standing = A("standing-research");
      yield* f.createThread(standing, "Research", { pinned: true });
      yield* f.request(standing, M("request-1"), COORDINATOR);

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.finishTurn(standing, T("turn-1"), "Bun starts faster.");
          yield* drain;
        }),
      );

      const pushId = pushIdOf(standing, M("request-1"));
      assert.deepStrictEqual(
        (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
        [pushId],
      );
      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${pushId}`]);
      assert.isFalse(yield* f.settled(standing));
    }),
  );

  test(
    "sends nothing back for turns nobody requested",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      const peer = A("standing-writer");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.createThread(peer, "Writer", { pinned: true });

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.startTurn(agent, M("user-message"));
          yield* f.finishTurn(agent, T("turn-user"), "Done.");
          yield* f.startTurn(agent, M("peer-message"), {
            kind: "agent",
            threadId: peer,
            threadTitle: "Writer",
          });
          yield* f.finishTurn(agent, T("turn-peer"), "Noted.");
          yield* drain;
        }),
      );

      assert.deepStrictEqual(yield* f.receipts("cp-push"), []);
      assert.deepStrictEqual(yield* f.userMessages(COORDINATOR), []);
      assert.isFalse(yield* f.settled(agent));
    }),
  );

  test(
    "never pushes a pushed turn onward",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      const standing = A("standing-research");
      const helper = A("helper-research");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.createThread(standing, "Research", { pinned: true });
      yield* f.createThread(helper, "Research helper", { createdBy: standing });
      yield* f.request(agent, M("request-agent"), COORDINATOR);
      yield* f.request(helper, M("request-helper"), standing);

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.finishTurn(agent, T("turn-agent"), "Answer.");
          yield* f.finishTurn(helper, T("turn-helper"), "Helper answer.");
          yield* drain;
          // Both recipients run the turns their pushes started.
          yield* f.finishTurn(COORDINATOR, T("turn-coordinator"), "Thanks.");
          yield* f.finishTurn(standing, T("turn-standing"), "Combined answer.");
          yield* drain;
        }),
      );

      assert.deepStrictEqual(yield* f.receipts("cp-push:"), [
        `accepted cp-push:${agent}:request-agent`,
        `accepted cp-push:${helper}:request-helper`,
      ]);
      assert.deepStrictEqual(
        (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
        [pushIdOf(agent, M("request-agent"))],
      );
    }),
  );

  test(
    "holds results for a busy recipient and starts them one at a time in order",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const first = A("agent-first");
      const second = A("agent-second");
      yield* f.createThread(first, "First", { createdBy: COORDINATOR });
      yield* f.createThread(second, "Second", { createdBy: COORDINATOR });
      yield* f.request(first, M("request-first"), COORDINATOR);
      yield* f.request(second, M("request-second"), COORDINATOR);
      const firstPush = pushIdOf(first, M("request-first"));
      const secondPush = pushIdOf(second, M("request-second"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.startTurn(COORDINATOR, M("user-message"));
          yield* f.beginTurn(COORDINATOR, T("turn-user"));
          yield* f.finishTurn(first, T("turn-first"), "First answer.");
          yield* f.finishTurn(second, T("turn-second"), "Second answer.");
          yield* drain;
          assert.deepStrictEqual(
            (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
            [M("user-message"), firstPush, secondPush],
          );
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), []);

          yield* f.endTurn(COORDINATOR, T("turn-user"), "Working on it.");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [
            `accepted cp-start:${firstPush}`,
          ]);

          yield* f.finishTurn(COORDINATOR, T("turn-first-push"), "Noted.");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [
            `accepted cp-start:${firstPush}`,
            `accepted cp-start:${secondPush}`,
          ]);
        }),
      );
    }),
  );

  test(
    "delivers exactly once across restarts",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      const late = A("agent-late");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.createThread(late, "Late", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);
      const pushId = pushIdOf(agent, M("request-1"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.startTurn(COORDINATOR, M("user-message"));
          yield* f.beginTurn(COORDINATOR, T("turn-user"));
          yield* f.finishTurn(agent, T("turn-1"), "Answer.");
          yield* drain;
        }),
      );
      // The coordinator goes idle while no reactor runs.
      yield* f.endTurn(COORDINATOR, T("turn-user"), "Done.");

      yield* f.withReactor(() => Effect.void);
      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${pushId}`]);
      yield* f.withReactor(() => Effect.void);
      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${pushId}`]);
      assert.strictEqual(yield* f.turnStartsOf(pushId), 1);

      // A result that finished with no reactor running is appended by the next one.
      yield* f.request(late, M("request-late"), COORDINATOR);
      yield* f.finishTurn(late, T("turn-late"), "Late answer.");
      yield* f.withReactor(() => Effect.void);
      yield* f.withReactor(() => Effect.void);
      const latePush = pushIdOf(late, M("request-late"));
      assert.deepStrictEqual(
        (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
        [M("user-message"), pushId, latePush],
      );
    }),
  );

  test(
    `pauses a coordinator's results after ${AGENT_PUSH_BUDGET} in a row until the user writes`,
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const pushes: Array<MessageId> = [];

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          for (let index = 1; index <= AGENT_PUSH_BUDGET + 1; index += 1) {
            const agent = A(`agent-${index}`);
            yield* f.createThread(agent, `Agent ${index}`, { createdBy: COORDINATOR });
            yield* f.request(agent, M(`request-${index}`), COORDINATOR);
            yield* f.finishTurn(agent, T(`turn-agent-${index}`), `Answer ${index}.`);
            yield* drain;
            pushes.push(pushIdOf(agent, M(`request-${index}`)));
            if (index <= AGENT_PUSH_BUDGET) {
              assert.strictEqual((yield* f.receipts("cp-start:")).length, index);
              yield* f.finishTurn(COORDINATOR, T(`turn-push-${index}`), "Noted.");
              yield* drain;
            }
          }
          const held = pushes.at(-1)!;
          assert.include(
            (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
            held,
          );
          assert.notInclude(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);
          const notices = yield* f.activities(COORDINATOR, "agent-results.paused");
          assert.deepStrictEqual(
            notices.map((notice) => notice.detail),
            [
              `Agent results paused after ${AGENT_PUSH_BUDGET} in a row. The rest start after your next message here.`,
            ],
          );

          // Another pass while paused adds no second notice.
          yield* f.setSession(COORDINATOR, "ready", null);
          yield* drain;
          assert.lengthOf(yield* f.activities(COORDINATOR, "agent-results.paused"), 1);
          assert.notInclude(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);

          yield* f.startTurn(COORDINATOR, M("user-message"));
          yield* f.finishTurn(COORDINATOR, T("turn-user"), "Carry on.");
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);
        }),
      );
    }),
  );

  test(
    "lets a manager's request through a paused standing agent and release it",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const standing = A("standing-research");
      yield* f.createThread(standing, "Research", { pinned: true });
      const pushes: Array<MessageId> = [];

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          for (let index = 1; index <= AGENT_PUSH_BUDGET + 1; index += 1) {
            const helper = A(`helper-${index}`);
            yield* f.createThread(helper, `Helper ${index}`, { createdBy: standing });
            yield* f.request(helper, M(`request-${index}`), standing);
            yield* f.finishTurn(helper, T(`turn-helper-${index}`), `Finding ${index}.`);
            yield* drain;
            pushes.push(pushIdOf(helper, M(`request-${index}`)));
            if (index <= AGENT_PUSH_BUDGET) {
              yield* f.finishTurn(standing, T(`turn-push-${index}`), "Noted.");
              yield* drain;
            }
          }
          const held = pushes.at(-1)!;
          assert.notInclude(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);
          const noticeText = (threadId: ThreadId) =>
            f
              .activities(threadId, "agent-results.paused")
              .pipe(Effect.map((rows) => rows.map((row) => row.detail)));
          assert.deepStrictEqual(yield* noticeText(standing), [
            `Agent results paused after ${AGENT_PUSH_BUDGET} in a row. The rest start after your next message here.`,
          ]);
          assert.deepStrictEqual(yield* noticeText(COORDINATOR), [
            `Results for Research paused after ${AGENT_PUSH_BUDGET} in a row. Message Research to continue.`,
          ]);

          // The coordinator's follow-up was held for the busy agent; it starts
          // while results are paused, and as a manager request it releases them.
          const followUp = M(agentSendId(standing, "follow-up"));
          yield* f.dispatch({
            type: "thread.message.user.append",
            commandId: CommandId.make(followUp),
            threadId: standing,
            message: {
              messageId: followUp,
              text: "Combine what you have.",
              attachments: [],
              source: {
                kind: "agent",
                threadId: COORDINATOR,
                threadTitle: "Personal",
                replyTo: COORDINATOR,
              },
            },
            createdAt: yield* f.now,
          });
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${followUp}`);
          assert.notInclude(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);

          yield* f.finishTurn(standing, T("turn-follow-up"), "Combined findings.");
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);
          assert.include(
            (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
            pushIdOf(standing, followUp),
          );
        }),
      );
    }),
  );

  test(
    "reports failed, stopped and unstarted requests, except ones the manager stopped",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const failed = A("agent-failed");
      const interrupted = A("agent-interrupted");
      const unstarted = A("agent-unstarted");
      const stopped = A("agent-stopped");
      const notStopped = A("agent-not-stopped");
      for (const [agent, title] of [
        [failed, "Failed"],
        [interrupted, "Interrupted"],
        [unstarted, "Unstarted"],
        [stopped, "Stopped"],
        [notStopped, "Not stopped"],
      ] as const) {
        yield* f.createThread(agent, title, { createdBy: COORDINATOR });
        yield* f.request(agent, M(`request-${agent}`), COORDINATOR);
      }

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.finishTurn(failed, T("turn-failed"), "Partial.", "error", "Model overloaded");
          yield* f.finishTurn(interrupted, T("turn-interrupted"), "Halfway.", "interrupted");
          yield* f.appendActivity(unstarted, "provider.turn.start.failed", {
            detail: "Provider unavailable",
            requestId: `request-${unstarted}`,
          });

          yield* f.beginTurn(stopped, T("turn-stopped"));
          yield* f.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(agentStopId(COORDINATOR, stopped, `request-${stopped}`)),
            threadId: stopped,
            turnId: T("turn-stopped"),
            createdAt: yield* f.now,
          });
          yield* f.endTurn(stopped, T("turn-stopped"), "", "interrupted");

          // A rejected command with the stop id does not suppress the result.
          yield* f
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(
                agentStopId(COORDINATOR, notStopped, `request-${notStopped}`),
              ),
              threadId: A("missing-thread"),
              createdAt: yield* f.now,
            })
            .pipe(Effect.flip);
          yield* f.finishTurn(notStopped, T("turn-not-stopped"), "Done anyway.");
          yield* drain;
        }),
      );

      const texts = new Map(
        (yield* f.userMessages(COORDINATOR)).map((message) => [message.id, message.text]),
      );
      assert.strictEqual(
        texts.get(pushIdOf(failed, M(`request-${failed}`))),
        resultText("Failed", failed, "failed: Model overloaded", "Partial."),
      );
      assert.strictEqual(
        texts.get(pushIdOf(interrupted, M(`request-${interrupted}`))),
        resultText("Interrupted", interrupted, "stopped before finishing", "Halfway."),
      );
      assert.strictEqual(
        texts.get(pushIdOf(unstarted, M(`request-${unstarted}`))),
        resultText(
          "Unstarted",
          unstarted,
          "failed to start: Provider unavailable",
          "(no final message)",
        ),
      );
      assert.isFalse(texts.has(pushIdOf(stopped, M(`request-${stopped}`))));
      assert.deepStrictEqual(yield* f.receipts(`cp-push:${stopped}`), []);
      assert.strictEqual(
        texts.get(pushIdOf(notStopped, M(`request-${notStopped}`))),
        resultText("Not stopped", notStopped, "finished", "Done anyway."),
      );
    }),
  );

  test(
    "starts a request held for a busy agent after its turn, and pushes both results",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-counter");
      yield* f.createThread(agent, "Counter", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-count"), COORDINATOR);
      const followUp = M(agentSendId(agent, "follow-up"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.beginTurn(agent, T("turn-count"));
          yield* f.dispatch({
            type: "thread.message.user.append",
            commandId: CommandId.make(followUp),
            threadId: agent,
            message: {
              messageId: followUp,
              text: "Also print done.",
              attachments: [],
              source: {
                kind: "agent",
                threadId: COORDINATOR,
                threadTitle: "Personal",
                replyTo: COORDINATOR,
              },
            },
            createdAt: yield* f.now,
          });
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), []);

          yield* f.endTurn(agent, T("turn-count"), "Counted to 60.");
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${followUp}`);
          // The follow-up is newer work, so the agent stays unsettled.
          assert.isFalse(yield* f.settled(agent));

          yield* f.finishTurn(agent, T("turn-follow-up"), "Printed done.");
          yield* drain;
        }),
      );

      const texts = new Map(
        (yield* f.userMessages(COORDINATOR)).map((message) => [message.id, message.text]),
      );
      assert.deepStrictEqual(
        [...texts.keys()],
        [pushIdOf(agent, M("request-count")), pushIdOf(agent, followUp)],
      );
      assert.strictEqual(
        texts.get(pushIdOf(agent, M("request-count"))),
        resultText("Counter", agent, "finished", "Counted to 60."),
      );
      assert.strictEqual(
        texts.get(pushIdOf(agent, followUp)),
        resultText("Counter", agent, "finished", "Printed done."),
      );
      assert.isTrue(yield* f.settled(agent));
    }),
  );

  test(
    "reports a request after the continuation that replaced its turn at restart",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);
      yield* f.beginTurn(agent, T("turn-before-restart"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          // Startup resumes the session and the provider opens a new turn.
          yield* f.setSession(agent, "starting", null);
          yield* f.beginTurn(agent, T("turn-continuation"));
          yield* f.setSession(COORDINATOR, "ready", null);
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-push:"), []);

          yield* f.endTurn(agent, T("turn-continuation"), "Continued answer.");
          yield* drain;
        }),
      );

      const messages = yield* f.userMessages(COORDINATOR);
      assert.deepStrictEqual(
        messages.map((message) => message.text),
        [resultText("Compare", agent, "finished", "Continued answer.")],
      );
    }),
  );

  test(
    "carries an open message-mode question and dismisses it when the agent settles",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-haiku");
      yield* f.createThread(agent, "Haiku", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.beginTurn(agent, T("turn-1"));
          yield* f.appendActivity(
            agent,
            "user-input.requested",
            {
              requestId: "question-city",
              questions: [{ id: "city", header: "City", question: "Which city?", options: [] }],
              responseMode: "message",
            },
            T("turn-1"),
          );
          yield* f.endTurn(agent, T("turn-1"), "");
          yield* drain;
        }),
      );

      const messages = yield* f.userMessages(COORDINATOR);
      assert.deepStrictEqual(
        messages.map((message) => message.text),
        [
          `${resultText("Haiku", agent, "finished", "(no final message)")}\n\nQuestions for the user:\n- Which city?`,
        ],
      );
      assert.isTrue(yield* f.settled(agent));
      const resolved = yield* f.activities(agent, "user-input.resolved");
      assert.deepStrictEqual(
        resolved.map((row) => row.requestId),
        ["question-city"],
      );
    }),
  );

  test(
    "holds results while the Project is archived and delivers them on Unarchive",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);
      const pushId = pushIdOf(agent, M("request-1"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.beginTurn(agent, T("turn-1"));
          yield* f.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(f.nextId("archive")),
            projectId: PROJECT,
            assistant: { archived: true },
          });
          yield* f.endTurn(agent, T("turn-1"), "", "stopped");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-push:"), []);

          yield* f.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(f.nextId("unarchive")),
            projectId: PROJECT,
            assistant: { archived: false },
          });
          yield* drain;
        }),
      );

      const messages = yield* f.userMessages(COORDINATOR);
      assert.deepStrictEqual(
        messages.map((message) => message.text),
        [resultText("Compare", agent, "stopped before finishing", "(no final message)")],
      );
      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${pushId}`]);
    }),
  );

  test(
    "sends a result to the coordinator when its recipient is gone or no longer manages the agent",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const cases = [
        { name: "deleted", command: "thread.delete" },
        { name: "archived", command: "thread.archive" },
        { name: "unpinned", command: "thread.unpin" },
      ] as const;
      for (const { name } of cases) {
        yield* f.createThread(A(`standing-${name}`), `Standing ${name}`, { pinned: true });
        yield* f.createThread(A(`helper-${name}`), `Helper ${name}`, {
          createdBy: A(`standing-${name}`),
        });
        yield* f.request(A(`helper-${name}`), M(`request-${name}`), A(`standing-${name}`));
        yield* f.beginTurn(A(`helper-${name}`), T(`turn-${name}`));
      }

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          for (const { name, command } of cases) {
            yield* f.dispatch({
              type: command,
              commandId: CommandId.make(f.nextId(name)),
              threadId: A(`standing-${name}`),
            });
            yield* f.endTurn(A(`helper-${name}`), T(`turn-${name}`), `Finding ${name}.`);
          }
          yield* drain;
        }),
      );

      assert.deepStrictEqual(
        (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
        cases.map(({ name }) => pushIdOf(A(`helper-${name}`), M(`request-${name}`))),
      );
      for (const { name } of cases) {
        assert.deepStrictEqual(yield* f.userMessages(A(`standing-${name}`)), []);
      }
    }),
  );

  test(
    "records an undelivered result when the agent became the coordinator",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-promoted");
      yield* f.createThread(agent, "Promoted", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);
      const pushId = pushIdOf(agent, M("request-1"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.beginTurn(agent, T("turn-1"));
          yield* f.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(f.nextId("promote")),
            projectId: PROJECT,
            assistant: { coordinatorThreadId: agent },
          });
          yield* f.endTurn(agent, T("turn-1"), "Answer.");
          yield* drain;
        }),
      );

      const undelivered = yield* f.activities(agent, "agent-results.undelivered");
      assert.deepStrictEqual(
        undelivered.map((row) => row.id),
        [pushId],
      );
      assert.deepStrictEqual(yield* f.receipts("cp-push:"), [`accepted ${pushId}`]);
      assert.deepStrictEqual(yield* f.userMessages(COORDINATOR), []);
      assert.isFalse(yield* f.settled(agent));
    }),
  );

  test(
    "keeps an agent unsettled when the user wrote to it after the request",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.beginTurn(agent, T("turn-1"));
          yield* f.dispatch({
            type: "thread.message.user.append",
            commandId: CommandId.make(f.nextId("user-append")),
            threadId: agent,
            message: { messageId: M("user-aside"), text: "Also check WAL2.", attachments: [] },
            createdAt: yield* f.now,
          });
          yield* f.endTurn(agent, T("turn-1"), "Answer.");
          yield* drain;
        }),
      );

      assert.deepStrictEqual(
        (yield* f.userMessages(COORDINATOR)).map((message) => message.id),
        [pushIdOf(agent, M("request-1"))],
      );
      assert.isFalse(yield* f.settled(agent));
    }),
  );

  test(
    "retries a pushed result whose start failed once",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-1"), COORDINATOR);
      const pushId = pushIdOf(agent, M("request-1"));
      const startFailed = () =>
        f.appendActivity(COORDINATOR, "provider.turn.start.failed", {
          detail: "The queued message was canceled before it could resume.",
          requestId: pushId,
        });

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.finishTurn(agent, T("turn-1"), "Answer.");
          yield* drain;
          assert.strictEqual(yield* f.turnStartsOf(pushId), 1);

          yield* startFailed();
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-retry:"), [`accepted cp-retry:${pushId}`]);
          assert.strictEqual(yield* f.turnStartsOf(pushId), 2);

          yield* startFailed();
          yield* drain;
          assert.strictEqual(yield* f.turnStartsOf(pushId), 2);
        }),
      );
    }),
  );

  test(
    "reports a request whose start was lost before any turn took it",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const restarted = A("agent-restarted");
      const stopped = A("agent-stopped");
      const busy = A("agent-busy");
      const folded = A("agent-folded");
      for (const [agent, title] of [
        [restarted, "Restarted"],
        [stopped, "Stopped"],
        [busy, "Busy"],
        [folded, "Folded"],
      ] as const) {
        yield* f.createThread(agent, title, { createdBy: COORDINATOR });
        yield* f.request(agent, M(`request-${agent}`), COORDINATOR);
      }
      const heldFollowUp = M(agentSendId(busy, "follow-up"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          // Startup settles a session that was still starting; the provider never saw the turn.
          yield* f.setSession(restarted, "starting", null);
          yield* f.setSession(
            restarted,
            "error",
            null,
            "Provider session did not survive a server restart.",
          );
          // The user stops an agent while it is still starting.
          yield* f.setSession(stopped, "starting", null);
          yield* f.setSession(stopped, "stopped", null);
          // A follow-up held for a busy agent is a delivery, not a lost start.
          yield* f.beginTurn(busy, T("turn-busy"));
          yield* f.holdSend(busy, heldFollowUp, COORDINATOR, "Also print done.");
          yield* f.endTurn(busy, T("turn-busy"), "Partial.", "error", "Model overloaded");
          // A user message sent before the turn began took the request's place;
          // stopping the agent later does not report the request as lost.
          yield* f.startTurn(folded, M("user-aside"));
          yield* f.finishTurn(folded, T("turn-folded"), "Did both.");
          yield* f.setSession(folded, "stopped", null);
          yield* drain;
        }),
      );

      const texts = new Map(
        (yield* f.userMessages(COORDINATOR)).map((message) => [message.id, message.text]),
      );
      assert.deepStrictEqual(
        [...texts.keys()],
        [
          pushIdOf(restarted, M(`request-${restarted}`)),
          pushIdOf(stopped, M(`request-${stopped}`)),
          pushIdOf(busy, M(`request-${busy}`)),
        ],
      );
      assert.strictEqual(
        texts.get(pushIdOf(restarted, M(`request-${restarted}`))),
        resultText(
          "Restarted",
          restarted,
          "failed to start: Provider session did not survive a server restart.",
          "(no final message)",
        ),
      );
      assert.strictEqual(
        texts.get(pushIdOf(stopped, M(`request-${stopped}`))),
        resultText("Stopped", stopped, "stopped before finishing", "(no final message)"),
      );
      assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${heldFollowUp}`);
    }),
  );

  test(
    "reports no earlier reply for a held request whose start failed",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-counter");
      yield* f.createThread(agent, "Counter", { createdBy: COORDINATOR });
      yield* f.request(agent, M("request-count"), COORDINATOR);
      const followUp = M(agentSendId(agent, "follow-up"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.beginTurn(agent, T("turn-count"));
          yield* f.holdSend(agent, followUp, COORDINATOR, "Also print done.");
          // The first turn's final message lands after the held follow-up.
          yield* f.endTurn(agent, T("turn-count"), "Counted to 60.");
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${followUp}`);

          yield* f.appendActivity(agent, "provider.turn.start.failed", {
            detail: "Provider unavailable",
            requestId: followUp,
          });
          yield* drain;
        }),
      );

      const texts = new Map(
        (yield* f.userMessages(COORDINATOR)).map((message) => [message.id, message.text]),
      );
      assert.strictEqual(
        texts.get(pushIdOf(agent, M("request-count"))),
        resultText("Counter", agent, "finished", "Counted to 60."),
      );
      assert.strictEqual(
        texts.get(pushIdOf(agent, followUp)),
        resultText("Counter", agent, "failed to start: Provider unavailable", "(no final message)"),
      );
    }),
  );

  test(
    "still starts held deliveries after Move to Tasks, across a restart",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const agent = A("agent-compare");
      const standing = A("standing-research");
      yield* f.createThread(agent, "Compare", { createdBy: COORDINATOR });
      yield* f.createThread(standing, "Research", { pinned: true });
      yield* f.request(agent, M("request-1"), COORDINATOR);
      const pushId = pushIdOf(agent, M("request-1"));
      const heldSend = M(agentSendId(standing, "follow-up"));

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.startTurn(COORDINATOR, M("user-message"));
          yield* f.beginTurn(COORDINATOR, T("turn-user"));
          yield* f.finishTurn(agent, T("turn-1"), "Answer.");
          yield* f.beginTurn(standing, T("turn-standing"));
          yield* f.holdSend(standing, heldSend, COORDINATOR, "Summarize.");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), []);

          yield* f.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(f.nextId("move-to-tasks")),
            projectId: PROJECT,
            assistant: null,
          });
          yield* f.endTurn(standing, T("turn-standing"), "Done.");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${heldSend}`]);
        }),
      );
      // The coordinator goes idle while no reactor runs; the next one finds the push.
      yield* f.endTurn(COORDINATOR, T("turn-user"), "Done.");
      yield* f.withReactor(() => Effect.void);

      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [
        `accepted cp-start:${pushId}`,
        `accepted cp-start:${heldSend}`,
      ]);
      // A plain workspace owes no new results.
      assert.deepStrictEqual(yield* f.receipts(`cp-push:${standing}`), []);
    }),
  );

  test(
    "ignores history imports, and cp-* messages it did not append",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const imported = A("imported-session");
      yield* f.createThread(imported, "Imported");

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(f.nextId("import")),
            threadId: imported,
            messages: [
              {
                messageId: M(agentSendId(imported, "imported")),
                role: "user",
                text: "Imported message",
                createdAt: yield* f.now,
              },
            ],
          });
          yield* drain;
          // A pass does run now, and still leaves a message this code never appended alone.
          yield* f.setSession(imported, "ready", null);
          yield* drain;
        }),
      );

      assert.deepStrictEqual(yield* f.receipts("cp-start:"), []);
    }),
  );
});

describe("AgentCompletionReactor with scheduled prompts", () => {
  const SALES = A("standing-sales");
  const scheduled = (scheduleId: string) =>
    M(`cp-schedule:${PROJECT}:${scheduleId}:2026-09-28T13:00:00.000Z`);

  /** A schedule's prompt, appended as ScheduleRunner appends it. */
  const appendScheduled = (
    f: Effect.Success<typeof makeFixture>,
    threadId: ThreadId,
    messageId: MessageId,
    replyTo?: ThreadId,
  ) =>
    Effect.gen(function* () {
      yield* f.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(messageId),
        threadId,
        message: {
          messageId,
          text: "Run the pipeline check.",
          attachments: [],
          source: {
            kind: "agent",
            threadTitle: "Pipeline check",
            scheduleId: "pipeline",
            ...(replyTo !== undefined ? { replyTo } : {}),
          },
        },
        createdAt: yield* f.now,
      });
    });

  /** A one-off agent's result pushed into the coordinator; `run` lets the coordinator take it. */
  const pushResult = (
    f: Effect.Success<typeof makeFixture>,
    drain: Effect.Effect<void>,
    index: number,
    run: boolean,
  ) =>
    Effect.gen(function* () {
      const agent = A(`agent-${index}`);
      yield* f.createThread(agent, `Agent ${index}`, { createdBy: COORDINATOR });
      yield* f.request(agent, M(`request-${index}`), COORDINATOR);
      yield* f.finishTurn(agent, T(`turn-agent-${index}`), `Answer ${index}.`);
      yield* drain;
      if (run) {
        yield* f.finishTurn(COORDINATOR, T(`turn-push-${index}`), "Noted.");
        yield* drain;
      }
      return pushIdOf(agent, M(`request-${index}`));
    });

  test(
    "starts a scheduled prompt in an idle coordinator exactly once",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const prompt = scheduled("daily");

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* appendScheduled(f, COORDINATOR, prompt);
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${prompt}`]);
          yield* f.setSession(COORDINATOR, "ready", null);
          yield* drain;
        }),
      );
      yield* f.withReactor(() => Effect.void);

      assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${prompt}`]);
      assert.strictEqual(yield* f.turnStartsOf(prompt), 1);
    }),
  );

  test(
    "starts a held push and a scheduled prompt for one coordinator one after the other",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const prompt = scheduled("daily");

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* f.startTurn(COORDINATOR, M("user-message"));
          yield* f.beginTurn(COORDINATOR, T("turn-user"));
          const push = yield* pushResult(f, drain, 1, false);
          yield* appendScheduled(f, COORDINATOR, prompt);
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), []);

          yield* f.endTurn(COORDINATOR, T("turn-user"), "Done.");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${push}`]);

          yield* f.finishTurn(COORDINATOR, T("turn-push"), "Noted.");
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [
            `accepted cp-start:${push}`,
            `accepted cp-start:${prompt}`,
          ]);
        }),
      );
    }),
  );

  test(
    "pushes a standing agent's scheduled result to the coordinator, and only once it ran",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      yield* f.createThread(SALES, "Sales", { pinned: true });
      // An idle standing agent's provider session is often stopped.
      yield* f.setSession(SALES, "stopped", null);
      const prompt = scheduled("pipeline");

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          yield* appendScheduled(f, SALES, prompt, COORDINATOR);
          yield* drain;
          assert.deepStrictEqual(yield* f.receipts("cp-start:"), [`accepted cp-start:${prompt}`]);
          assert.deepStrictEqual(yield* f.receipts("cp-push:"), []);

          yield* f.finishTurn(SALES, T("turn-pipeline"), "pong");
          yield* drain;
        }),
      );

      const pushId = pushIdOf(SALES, prompt);
      const [pushed] = yield* f.userMessages(COORDINATOR);
      assert.deepStrictEqual(pushed, {
        id: pushId,
        text: resultText("Sales", SALES, "finished", "pong"),
      });
      assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${pushId}`);
    }),
  );

  test(
    `starts a pushed answer to a scheduled request after ${AGENT_PUSH_BUDGET} counted pushes`,
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      yield* f.createThread(SALES, "Sales", { pinned: true });
      const prompt = scheduled("pipeline");

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          for (let index = 1; index <= AGENT_PUSH_BUDGET; index += 1) {
            yield* pushResult(f, drain, index, true);
          }
          yield* appendScheduled(f, SALES, prompt, COORDINATOR);
          yield* drain;
          yield* f.finishTurn(SALES, T("turn-pipeline"), "pong");
          yield* drain;
        }),
      );

      assert.include(
        yield* f.receipts("cp-start:"),
        `accepted cp-start:${pushIdOf(SALES, prompt)}`,
      );
      assert.lengthOf(yield* f.activities(COORDINATOR, "agent-results.paused"), 0);
    }),
  );

  test(
    "starts a scheduled prompt while results are paused, and its turn releases them",
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.createProject;
      const prompt = scheduled("daily");

      yield* f.withReactor((drain) =>
        Effect.gen(function* () {
          for (let index = 1; index <= AGENT_PUSH_BUDGET; index += 1) {
            yield* pushResult(f, drain, index, true);
          }
          const held = yield* pushResult(f, drain, AGENT_PUSH_BUDGET + 1, false);
          assert.notInclude(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);

          yield* appendScheduled(f, COORDINATOR, prompt);
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${prompt}`);
          assert.notInclude(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);

          yield* f.finishTurn(COORDINATOR, T("turn-scheduled"), "Brief sent.");
          yield* drain;
          assert.include(yield* f.receipts("cp-start:"), `accepted cp-start:${held}`);
        }),
      );
    }),
  );
});
