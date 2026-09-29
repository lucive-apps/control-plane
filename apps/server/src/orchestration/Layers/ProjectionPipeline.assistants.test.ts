import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-pipeline-assistants-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const createdAt = "2026-01-01T00:00:00.000Z";

engineLayer("OrchestrationProjectionPipeline assistant marker", (it) => {
  it.effect("persists the marker through every project read and clears it on null", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-assistant");
      const coordinatorThreadId = ThreadId.make("thread-assistant-coordinator");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-assistant-project"),
        projectId,
        title: "Personal",
        workspaceRoot: "/tmp/project-assistant",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-assistant-thread"),
        threadId: coordinatorThreadId,
        projectId,
        title: "Personal",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const setMarker = {
        type: "project.meta.update",
        commandId: CommandId.make("cmd-assistant-set"),
        projectId,
        assistant: { coordinatorThreadId },
      } as const;
      const first = yield* engine.dispatch(setMarker);
      // The receipt sits on the project event (the last one), so a retry of
      // this project command replays it instead of conflicting on a thread.
      const retry = yield* engine.dispatch(setMarker);
      assert.strictEqual(retry.sequence, first.sequence);

      const expected = { coordinatorThreadId };
      const readMarkers = Effect.gen(function* () {
        const shell = yield* snapshots.getShellSnapshot();
        const byId = yield* snapshots.getProjectShellById(projectId);
        const commandModel = yield* snapshots.getCommandReadModel();
        return {
          shell: shell.projects.find((project) => project.id === projectId),
          byId: Option.getOrUndefined(byId),
          command: commandModel.projects.find((project) => project.id === projectId),
          coordinatorTitle: shell.threads.find((thread) => thread.id === coordinatorThreadId)
            ?.title,
        };
      });

      const saved = yield* readMarkers;
      assert.deepStrictEqual(saved.shell?.assistant, expected);
      assert.deepStrictEqual(saved.byId?.assistant, expected);
      assert.deepStrictEqual(saved.command?.assistant, expected);

      // A title-only update keeps the marker and renames the coordinator.
      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-assistant-rename"),
        projectId,
        title: "Home",
      });
      const renamed = yield* readMarkers;
      assert.deepStrictEqual(renamed.shell?.assistant, expected);
      assert.deepStrictEqual(renamed.command?.assistant, expected);
      assert.strictEqual(renamed.coordinatorTitle, "Home");

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-assistant-clear"),
        projectId,
        assistant: null,
      });
      const cleared = yield* readMarkers;
      // Workspaces carry no marker on the wire.
      assert.isDefined(cleared.shell);
      assert.notProperty(cleared.shell, "assistant");
      assert.isDefined(cleared.byId);
      assert.notProperty(cleared.byId, "assistant");
      assert.isDefined(cleared.command);
      assert.notProperty(cleared.command, "assistant");
      const rows = yield* sql<{ readonly assistant: string | null }>`
        SELECT assistant_json AS assistant FROM projection_projects WHERE project_id = ${projectId}
      `;
      assert.deepStrictEqual(rows, [{ assistant: null }]);
    }),
  );
});
