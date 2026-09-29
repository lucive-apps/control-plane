import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationAgentMessageSource,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-snapshot-agents-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const createdAt = "2026-01-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-agents");
const COORDINATOR = ThreadId.make("thread-agents-coordinator");
const AGENT = ThreadId.make("thread-agents-agent");
const REQUEST = MessageId.make("message-agents-request");

let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`cmd-agents-${label}-${++commandCount}`);

const createThread = (threadId: ThreadId, title: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: nextCommandId("create"),
      threadId,
      projectId: PROJECT,
      title,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
  });

/** Sends a message and lets a session adopt it as a finished turn. */
const runTurn = (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly source?: OrchestrationAgentMessageSource;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: nextCommandId("turn"),
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: "Compare the options",
        attachments: [],
        ...(input.source !== undefined ? { source: input.source } : {}),
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });
    const session = (status: "running" | "ready", activeTurnId: TurnId | null) => ({
      threadId: input.threadId,
      status,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeTurnId,
      lastError: null,
      updatedAt: createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: nextCommandId("running"),
      threadId: input.threadId,
      session: session("running", input.turnId),
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: nextCommandId("ready"),
      threadId: input.threadId,
      session: session("ready", null),
      createdAt,
    });
  });

engineLayer("ProjectionSnapshotQuery agent requests", (it) => {
  it.effect("exposes a manager's request on the turn it started", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch({
        type: "project.create",
        commandId: nextCommandId("project"),
        projectId: PROJECT,
        title: "Personal",
        workspaceRoot: "/tmp/project-agents",
        createdAt,
      });
      yield* createThread(COORDINATOR, "Personal");
      yield* createThread(AGENT, "Compare");
      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: nextCommandId("marker"),
        projectId: PROJECT,
        assistant: { coordinatorThreadId: COORDINATOR },
      });

      const source = {
        kind: "agent",
        threadId: COORDINATOR,
        threadTitle: "Personal",
        replyTo: COORDINATOR,
      } as const;
      yield* runTurn({
        threadId: AGENT,
        messageId: REQUEST,
        turnId: TurnId.make("turn-agents-request"),
        source,
      });
      yield* runTurn({
        threadId: COORDINATOR,
        messageId: MessageId.make("message-agents-user"),
        turnId: TurnId.make("turn-agents-user"),
      });

      const agentShell = Option.getOrThrow(yield* snapshots.getThreadShellById(AGENT));
      assert.strictEqual(agentShell.latestTurn?.state, "completed");
      assert.strictEqual(agentShell.latestTurn?.replyTo, COORDINATOR);
      const coordinatorShell = Option.getOrThrow(yield* snapshots.getThreadShellById(COORDINATOR));
      assert.isNotNull(coordinatorShell.latestTurn);
      assert.notProperty(coordinatorShell.latestTurn, "replyTo");

      const shell = yield* snapshots.getShellSnapshot();
      const latestTurnOf = (threadId: ThreadId) =>
        shell.threads.find((thread) => thread.id === threadId)?.latestTurn;
      assert.strictEqual(latestTurnOf(AGENT)?.replyTo, COORDINATOR);
      assert.isDefined(latestTurnOf(COORDINATOR));
      assert.notProperty(latestTurnOf(COORDINATOR), "replyTo");

      const detail = Option.getOrThrow(yield* snapshots.getThreadDetailSnapshot(AGENT));
      const request = detail.thread.messages.find((message) => message.id === REQUEST);
      assert.deepStrictEqual(request?.source, source);

      const readModel = yield* snapshots.getCommandReadModel();
      const commandTurnOf = (threadId: ThreadId) =>
        readModel.threads.find((thread) => thread.id === threadId)?.latestTurn;
      assert.strictEqual(commandTurnOf(AGENT)?.replyTo, COORDINATOR);
      assert.notProperty(commandTurnOf(COORDINATOR), "replyTo");

      yield* engine.dispatch({
        type: "thread.archive",
        commandId: nextCommandId("archive"),
        threadId: AGENT,
      });
      const archived = yield* snapshots.getArchivedShellSnapshot();
      const archivedAgent = archived.threads.find((thread) => thread.id === AGENT);
      assert.strictEqual(archivedAgent?.latestTurn?.replyTo, COORDINATOR);
    }),
  );
});
