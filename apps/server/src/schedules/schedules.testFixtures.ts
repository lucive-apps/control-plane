/**
 * A real engine on in-memory SQLite, plus helpers to build Projects with
 * schedules and read back what the runner and host recorded. Test-only.
 */
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type ProjectAssistant,
  type ProjectScheduleTarget,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

/** A fresh in-memory database, and a temp home, per test. */
export const makeScheduleEngineLayer = (prefix: string) =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

export type ScheduleEngineServices = Layer.Success<ReturnType<typeof makeScheduleEngineLayer>>;

export interface ScheduleSpec {
  readonly id: string;
  readonly cron: string;
  readonly target?: ProjectScheduleTarget;
  readonly enabled?: boolean;
  readonly name?: string;
  readonly prompt?: string;
}

const CODEX = ProviderInstanceId.make("codex");

export const makeScheduleFixture = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  let counter = 0;
  const nextId = (label: string) => `test:${label}:${++counter}`;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.asVoid);

  const createThread = (
    projectId: ProjectId,
    threadId: ThreadId,
    title: string,
    options: { readonly pinned?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(nextId("create")),
        threadId,
        projectId,
        title,
        modelSelection: { instanceId: CODEX, model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: yield* now,
      });
      if (options.pinned === true) {
        yield* dispatch({ type: "thread.pin", commandId: CommandId.make(nextId("pin")), threadId });
      }
    });

  /** A Project titled `title` whose coordinator is `coordinatorId`. */
  const createProject = (projectId: ProjectId, coordinatorId: ThreadId, title: string) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make(nextId("project")),
        projectId,
        title,
        workspaceRoot: `/tmp/${projectId}`,
        createdAt: yield* now,
      });
      yield* createThread(projectId, coordinatorId, title);
      yield* dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(nextId("marker")),
        projectId,
        assistant: { coordinatorThreadId: coordinatorId },
      });
    });

  const assistantOf = (projectId: ProjectId) =>
    snapshots.getProjectShellById(projectId).pipe(
      Effect.map((project) => Option.getOrNull(project)?.assistant ?? null),
      Effect.orDie,
    );

  /** Replaces the Project's schedules as a user would, echoing stored stamps. */
  const setSchedules = (projectId: ProjectId, specs: ReadonlyArray<ScheduleSpec>) =>
    Effect.gen(function* () {
      const stored = (yield* assistantOf(projectId))?.schedules ?? [];
      yield* dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(nextId("schedules")),
        projectId,
        assistant: {
          schedules: specs.map((spec) => {
            const existing = stored.find((schedule) => schedule.id === spec.id);
            return {
              id: spec.id,
              name: spec.name ?? spec.id,
              cron: spec.cron,
              target: spec.target ?? "coordinator",
              enabled: spec.enabled ?? true,
              ...(existing === undefined || spec.prompt !== undefined
                ? { prompt: spec.prompt ?? `Run ${spec.id}.` }
                : {}),
              ...(existing !== undefined ? { updatedAt: existing.updatedAt } : {}),
            };
          }),
        },
      });
    });

  const archiveProject = (projectId: ProjectId, archived: boolean) =>
    dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(nextId("archive")),
      projectId,
      assistant: { archived },
    });

  const setSession = (
    threadId: ThreadId,
    status: OrchestrationSessionStatus,
    activeTurnId: TurnId | null = null,
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

  /** A user message that starts a turn, as the composer sends it. */
  const sendUserMessage = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(nextId("turn-start")),
        threadId,
        message: { messageId, role: "user", text: "Hello", attachments: [] },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: yield* now,
      });
    });

  const appendActivity = (threadId: ThreadId, kind: string, payload: Record<string, unknown>) =>
    Effect.gen(function* () {
      const id = nextId("activity");
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(id),
        threadId,
        activity: {
          id: EventId.make(id),
          tone: "error",
          kind,
          summary: kind,
          payload,
          turnId: null,
          createdAt: yield* now,
        },
        createdAt: yield* now,
      });
    });

  const runsOf = (projectId: ProjectId) =>
    assistantOf(projectId).pipe(
      Effect.map(
        (assistant): NonNullable<ProjectAssistant["scheduleRuns"]> => assistant?.scheduleRuns ?? {},
      ),
    );

  const userMessages = (threadId: ThreadId) =>
    sql<{
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
      readonly source: string | null;
    }>`
      SELECT message_id AS id, text, created_at AS "createdAt", source_json AS source
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
      ORDER BY rowid
    `;

  const receipts = (prefix: string) =>
    sql<{ readonly id: string; readonly status: string }>`
      SELECT command_id AS id, status FROM orchestration_command_receipts
      WHERE command_id GLOB ${`${prefix}*`}
      ORDER BY command_id
    `.pipe(Effect.map((rows) => rows.map((row) => `${row.status} ${row.id}`)));

  return {
    engine,
    dispatch,
    nextId,
    now,
    createProject,
    createThread,
    setSchedules,
    archiveProject,
    setSession,
    sendUserMessage,
    appendActivity,
    assistantOf,
    runsOf,
    userMessages,
    receipts,
  };
});
