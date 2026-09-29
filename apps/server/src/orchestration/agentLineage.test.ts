import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { AgentLineage } from "./agentLineage.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const engineLayer = it.layer(
  Layer.mergeAll(OrchestrationEngineLive, AgentLineage.layer).pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-lineage-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const createdAt = "2026-01-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-lineage");
const COORDINATOR = ThreadId.make("thread-lineage-coordinator");
const STANDING = ThreadId.make("thread-lineage-standing");
const AGENT = ThreadId.make("thread-lineage-agent");

let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`cmd-lineage-${label}-${++commandCount}`);

const createThread = (threadId: ThreadId, title: string, createdByThreadId?: ThreadId) =>
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
      ...(createdByThreadId !== undefined ? { createdByThreadId } : {}),
    });
  });

engineLayer("AgentLineage", (it) => {
  it.effect("reads the creator from the latest thread.created event", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const lineage = yield* AgentLineage;

      yield* engine.dispatch({
        type: "project.create",
        commandId: nextCommandId("project"),
        projectId: PROJECT,
        title: "Personal",
        workspaceRoot: "/tmp/project-lineage",
        createdAt,
      });
      yield* createThread(COORDINATOR, "Personal");
      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: nextCommandId("marker"),
        projectId: PROJECT,
        assistant: { coordinatorThreadId: COORDINATOR },
      });
      yield* createThread(STANDING, "Research");
      yield* createThread(AGENT, "Compare", COORDINATOR);

      assert.strictEqual(yield* lineage.creatorOf(AGENT), COORDINATOR);
      assert.isNull(yield* lineage.creatorOf(COORDINATOR));
      assert.isNull(yield* lineage.creatorOf(STANDING));
      assert.isNull(yield* lineage.creatorOf(ThreadId.make("thread-lineage-missing")));

      // A deleted thread id can be created again; the latest creation wins.
      const recreate = (createdByThreadId?: ThreadId) =>
        Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: nextCommandId("delete"),
            threadId: AGENT,
          });
          yield* createThread(AGENT, "Compare again", createdByThreadId);
        });
      yield* recreate(STANDING);
      assert.strictEqual(yield* lineage.creatorOf(AGENT), STANDING);
      yield* recreate();
      assert.isNull(yield* lineage.creatorOf(AGENT));
    }),
  );
});
