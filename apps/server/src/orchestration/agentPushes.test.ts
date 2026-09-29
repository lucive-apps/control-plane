import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { AGENT_RESULT_CAP_BYTES } from "./agentProtocol.ts";
import {
  formatAgentResult,
  isDeliveryIdle,
  makeAgentPushQueries,
  openMessageQuestions,
  type AgentResultOutcome,
} from "./agentPushes.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const header = (state: string) => `Result from agent "Compare" (threadId agent-1): ${state}`;

const format = (outcome: AgentResultOutcome, text: string | null, questions: string[] = []) =>
  formatAgentResult({
    agentTitle: "Compare",
    agentThreadId: "agent-1",
    outcome,
    text,
    questions,
  });

describe("formatAgentResult", () => {
  it("states how the request ended, then the agent's last reply", () => {
    expect(format({ kind: "finished" }, "WAL is faster.\n")).toBe(
      `${header("finished")}\n\nWAL is faster.`,
    );
    expect(format({ kind: "failed", lastError: "Model overloaded" }, "Partial")).toBe(
      `${header("failed: Model overloaded")}\n\nPartial`,
    );
    expect(format({ kind: "failed", lastError: null }, null)).toBe(
      `${header("failed")}\n\n(no final message)`,
    );
    expect(format({ kind: "stopped" }, "   ")).toBe(
      `${header("stopped before finishing")}\n\n(no final message)`,
    );
    expect(format({ kind: "failed-to-start", detail: "Provider unavailable" }, null)).toBe(
      `${header("failed to start: Provider unavailable")}\n\n(no final message)`,
    );
  });

  it("cuts a long error and a long reply at a character boundary", () => {
    const lastError = "é".repeat(400);
    const [firstLine] = format({ kind: "failed", lastError }, null).split("\n");
    expect(firstLine).toBe(header(`failed: ${"é".repeat(250)}...`));

    const reply = "€".repeat(AGENT_RESULT_CAP_BYTES);
    const body = format({ kind: "finished" }, reply).split("\n\n")[1]!;
    expect(body).toBe(
      `${"€".repeat(Math.floor(AGENT_RESULT_CAP_BYTES / 3))}\n[truncated: use cp_agent_read for the rest]`,
    );
  });

  it("lists open questions for the user after the reply", () => {
    expect(format({ kind: "finished" }, null, ["Which city?", "Which season?"])).toBe(
      `${header("finished")}\n\n(no final message)\n\nQuestions for the user:\n- Which city?\n- Which season?`,
    );
  });
});

describe("openMessageQuestions", () => {
  it("keeps unanswered message-mode questions only", () => {
    const requested = (requestId: string, question: string, responseMode?: "message") => ({
      kind: "user-input.requested",
      payload: {
        requestId,
        questions: [{ id: "q", header: "Q", question, options: [] }],
        ...(responseMode ? { responseMode } : {}),
      },
    });
    expect(
      openMessageQuestions([
        requested("native", "Approve the plan?"),
        requested("answered", "Which repo?", "message"),
        { kind: "user-input.resolved", payload: { requestId: "answered", answers: {} } },
        requested("open", "Which city?", "message"),
      ]),
    ).toEqual(["Which city?"]);
  });
});

describe("isDeliveryIdle", () => {
  const now = "2026-09-28T12:00:00.000Z";
  const ready = { status: "ready" };

  it("waits for a working session", () => {
    expect(isDeliveryIdle({ status: "running" }, null, now)).toBe(false);
    expect(isDeliveryIdle({ status: "starting" }, null, now)).toBe(false);
    expect(isDeliveryIdle(null, null, now)).toBe(true);
    expect(isDeliveryIdle(ready, null, now)).toBe(true);
  });

  it("waits for a fresh unadopted start but not a stale one", () => {
    expect(isDeliveryIdle(ready, { requestedAt: "2026-09-28T11:59:00.000Z" }, now)).toBe(false);
    expect(isDeliveryIdle(ready, { requestedAt: "2026-09-28T11:57:00.000Z" }, now)).toBe(true);
  });
});

describe("pushBudget", () => {
  const PROJECT = ProjectId.make("project-personal");
  const COORDINATOR = ThreadId.make("coordinator");
  const EngineLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-push-budget-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  effectIt.effect("releases on a scheduled turn and never counts a push answering a schedule", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const queries = makeAgentPushQueries(yield* SqlClient.SqlClient);
      const createdAt = "2026-09-28T12:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("project"),
        projectId: PROJECT,
        title: "Personal",
        workspaceRoot: "/tmp/project-personal",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("coordinator"),
        threadId: COORDINATOR,
        projectId: PROJECT,
        title: "Personal",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      /** A turn the coordinator ran, started by an agent-sourced `messageId`. */
      const runTurn = (messageId: string) =>
        Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`start:${messageId}`),
            threadId: COORDINATOR,
            message: {
              messageId: MessageId.make(messageId),
              role: "user",
              text: "",
              attachments: [],
              // Pushes name their agent; scheduled prompts name their schedule.
              source: messageId.startsWith("cp-schedule:")
                ? { kind: "agent", threadTitle: "Daily", scheduleId: "daily" }
                : { kind: "agent", threadId: ThreadId.make("agent"), threadTitle: "Agent" },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          });
          for (const status of ["running", "ready"] as const) {
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`session:${status}:${messageId}`),
              threadId: COORDINATOR,
              session: {
                threadId: COORDINATOR,
                status,
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: status === "running" ? TurnId.make(`turn:${messageId}`) : null,
                lastError: null,
                updatedAt: createdAt,
              },
              createdAt,
            });
          }
        });
      const scheduledPrompt = `cp-schedule:${PROJECT}:daily:2026-09-28T13:00:00.000Z`;

      yield* runTurn("cp-push:agent-1:request-1");
      yield* runTurn(
        `cp-push:standing-sales:cp-schedule:${PROJECT}:pipeline:2026-09-28T13:00:00.000Z`,
      );
      assert.deepStrictEqual(yield* queries.pushBudget(COORDINATOR), {
        pushedSinceRelease: 1,
        releaseMessageId: null,
      });
      yield* runTurn(scheduledPrompt);
      yield* runTurn("cp-push:agent-2:request-2");
      assert.deepStrictEqual(yield* queries.pushBudget(COORDINATOR), {
        pushedSinceRelease: 1,
        releaseMessageId: MessageId.make(scheduledPrompt),
      });
    }).pipe(Effect.provide(EngineLayer)),
  );
});
