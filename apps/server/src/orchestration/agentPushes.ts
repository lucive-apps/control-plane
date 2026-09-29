/**
 * Reads and text for delivering agent results. Fork-owned.
 *
 * A request is a user message whose `source.replyTo` names the thread its
 * result goes to. Everything here is derived from projections and command
 * receipts, so a restarted server recomputes what is owed and what is held.
 * `AgentCompletionReactor` acts on it; the SQL mirrors the ids built in
 * `agentProtocol.ts`.
 *
 * @module agentPushes
 */
import {
  MessageId,
  OrchestrationAgentMessageSource,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import {
  AGENT_DELIVERY_RETRY_PREFIX,
  AGENT_DELIVERY_START_PREFIX,
  AGENT_PUSH_MESSAGE_PREFIX,
  AGENT_QUEUED_START_GRACE_MS,
  AGENT_RESULT_CAP_BYTES,
  AGENT_SEND_MESSAGE_PREFIX,
  AGENT_STOP_PREFIX,
  capUtf8,
} from "./agentProtocol.ts";

/** A finished request whose result has not been handled. */
export interface OwedResult {
  readonly agentThreadId: ThreadId;
  readonly requestId: MessageId;
  readonly replyTo: ThreadId;
}

export type AgentResultOutcome =
  | { readonly kind: "finished" }
  | { readonly kind: "failed"; readonly lastError: string | null }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed-to-start"; readonly detail: string | null };

export interface AgentResult {
  readonly outcome: AgentResultOutcome;
  /** The agent's last complete reply after the request, or null. */
  readonly text: string | null;
  /** No user message reached the agent after the request. */
  readonly isLatestRequest: boolean;
}

/**
 * An appended `cp-push:*` or `cp-send:*` message waiting to start in its
 * thread. `started` marks a push whose start failed and may be retried once.
 */
export interface AgentDelivery {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly source: OrchestrationAgentMessageSource | null;
  readonly started: boolean;
  /** The receiving thread's modes, which its turn start carries. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface PushBudget {
  /** Pushed turns since the recipient's latest release. */
  readonly pushedSinceRelease: number;
  /** The message that started that release turn, or null before the first. */
  readonly releaseMessageId: MessageId | null;
}

const OwedResultRow = Schema.Struct({
  agentThreadId: ThreadId,
  requestId: MessageId,
  replyTo: ThreadId,
});

const AgentResultRow = Schema.Struct({
  latestTurnState: Schema.NullOr(Schema.String),
  requestStarted: Schema.BooleanFromBit,
  sessionStatus: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  startFailed: Schema.BooleanFromBit,
  startFailureDetail: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  isLatestRequest: Schema.BooleanFromBit,
});

const AgentDeliveryRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  source: Schema.NullOr(Schema.fromJsonString(OrchestrationAgentMessageSource)),
  started: Schema.BooleanFromBit,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

const PushBudgetRow = Schema.Struct({
  pushedSinceRelease: Schema.Int,
  releaseMessageId: Schema.NullOr(MessageId),
});

const pushPattern = `${AGENT_PUSH_MESSAGE_PREFIX}*`;
const sendPattern = `${AGENT_SEND_MESSAGE_PREFIX}*`;

function toRepositoryError(operation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`agentPushes.${operation}:decode`)(cause)
      : toPersistenceSqlError(`agentPushes.${operation}:query`)(cause);
}

export function makeAgentPushQueries(sql: SqlClient.SqlClient) {
  // Receipts are keyed by `agentPushId` and `agentStopId`; the concatenations
  // below build the same ids.
  const findOwedResults = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String }),
    Result: OwedResultRow,
    execute: ({ projectId }) => sql`
      SELECT m.thread_id AS "agentThreadId", m.message_id AS "requestId",
             json_extract(m.source_json, '$.replyTo') AS "replyTo"
      FROM projection_thread_messages m
      JOIN projection_threads a ON a.thread_id = m.thread_id
      LEFT JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
      WHERE a.project_id = ${projectId} AND a.deleted_at IS NULL AND a.archived_at IS NULL
        AND m.role = 'user' AND m.source_json IS NOT NULL
        AND json_extract(m.source_json, '$.replyTo') IS NOT NULL
        AND (s.status IS NULL OR s.status NOT IN ('starting', 'running'))
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_command_receipts c
          WHERE c.command_id = ${AGENT_PUSH_MESSAGE_PREFIX} || m.thread_id || ':' || m.message_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_command_receipts c
          WHERE c.status = 'accepted'
            AND c.command_id = ${AGENT_STOP_PREFIX} || json_extract(m.source_json, '$.replyTo')
                               || ':' || m.thread_id || ':' || m.message_id
        )
        AND (
          EXISTS (
            SELECT 1 FROM projection_turns t
            WHERE t.thread_id = m.thread_id AND t.pending_message_id = m.message_id
              AND t.turn_id IS NOT NULL AND t.state IN ('completed', 'error', 'interrupted')
          )
          OR EXISTS (
            SELECT 1 FROM projection_thread_activities f
            WHERE f.thread_id = m.thread_id AND f.kind = 'provider.turn.start.failed'
              AND json_extract(f.payload_json, '$.requestId') = m.message_id
          )
          OR (
            -- A start no turn adopted: a restart settled the starting session,
            -- or the agent was stopped. The pending row is gone and nothing
            -- else reports it. A later turn means the request was folded into
            -- it; a held send that never started is still a delivery.
            s.status IN ('error', 'stopped', 'interrupted')
            AND NOT EXISTS (
              SELECT 1 FROM projection_turns t
              WHERE t.thread_id = m.thread_id AND t.pending_message_id = m.message_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_turns later
              JOIN projection_thread_messages lm ON lm.message_id = later.pending_message_id
              WHERE later.thread_id = m.thread_id AND lm.rowid > m.rowid
            )
            AND (
              m.message_id NOT GLOB ${sendPattern}
              OR EXISTS (
                SELECT 1 FROM orchestration_command_receipts c
                WHERE c.command_id = ${AGENT_DELIVERY_START_PREFIX} || m.message_id
                  AND c.status = 'accepted'
              )
            )
          )
        )
      ORDER BY m.rowid
    `,
  });

  // The request's own turn row bounds the reply: a reply from a turn that
  // started before it (a held request appended mid-turn) is not its result,
  // and a request no turn took has no reply at all.
  const findAgentResult = SqlSchema.findOneOption({
    Request: Schema.Struct({ agentThreadId: Schema.String, requestId: Schema.String }),
    Result: AgentResultRow,
    execute: ({ agentThreadId, requestId }) => sql`
      WITH request AS (
        SELECT rowid AS message_row,
               (
                 SELECT t.row_id FROM projection_turns t
                 WHERE t.thread_id = ${agentThreadId} AND t.pending_message_id = ${requestId}
                   AND t.turn_id IS NOT NULL
                 ORDER BY t.row_id DESC
                 LIMIT 1
               ) AS turn_row
        FROM projection_thread_messages
        WHERE message_id = ${requestId} AND thread_id = ${agentThreadId}
      )
      SELECT
        (
          SELECT t.state FROM projection_threads a
          JOIN projection_turns t ON t.thread_id = a.thread_id AND t.turn_id = a.latest_turn_id
          WHERE a.thread_id = ${agentThreadId}
        ) AS "latestTurnState",
        request.turn_row IS NOT NULL AS "requestStarted",
        (
          SELECT s.status FROM projection_thread_sessions s
          WHERE s.thread_id = ${agentThreadId}
        ) AS "sessionStatus",
        (
          SELECT s.last_error FROM projection_thread_sessions s
          WHERE s.thread_id = ${agentThreadId}
        ) AS "lastError",
        EXISTS (
          SELECT 1 FROM projection_thread_activities f
          WHERE f.thread_id = ${agentThreadId} AND f.kind = 'provider.turn.start.failed'
            AND json_extract(f.payload_json, '$.requestId') = ${requestId}
        ) AS "startFailed",
        (
          SELECT json_extract(f.payload_json, '$.detail') FROM projection_thread_activities f
          WHERE f.thread_id = ${agentThreadId} AND f.kind = 'provider.turn.start.failed'
            AND json_extract(f.payload_json, '$.requestId') = ${requestId}
          ORDER BY f.rowid DESC
          LIMIT 1
        ) AS "startFailureDetail",
        (
          SELECT am.text FROM projection_thread_messages am
          WHERE request.turn_row IS NOT NULL
            AND am.thread_id = ${agentThreadId} AND am.role = 'assistant'
            AND am.is_streaming = 0 AND length(trim(am.text)) > 0
            AND am.rowid > request.message_row
            AND NOT EXISTS (
              SELECT 1 FROM projection_turns earlier
              WHERE earlier.thread_id = am.thread_id AND earlier.turn_id = am.turn_id
                AND earlier.row_id < request.turn_row
            )
          ORDER BY am.rowid DESC
          LIMIT 1
        ) AS "text",
        NOT EXISTS (
          SELECT 1 FROM projection_thread_messages u
          WHERE u.thread_id = ${agentThreadId} AND u.role = 'user'
            AND u.rowid > request.message_row
        ) AS "isLatestRequest"
      FROM request
    `,
  });

  // A `cp-push:*` or `cp-send:*` message this code appended. Both append
  // paths use the message id as the command id, so an imported or foreign
  // message with a delivery id never starts. Uses the alias `m`.
  const isDelivery = sql`(
    m.role = 'user'
    AND (m.message_id GLOB ${pushPattern} OR m.message_id GLOB ${sendPattern})
    AND EXISTS (
      SELECT 1 FROM orchestration_command_receipts own
      WHERE own.command_id = m.message_id AND own.status = 'accepted'
    )
  )`;
  const notStarted = sql`NOT EXISTS (
    SELECT 1 FROM orchestration_command_receipts c
    WHERE c.command_id = ${AGENT_DELIVERY_START_PREFIX} || m.message_id
  )`;

  // Unstarted deliveries, plus pushes whose start failed and were never
  // retried. Every delivery ever made is scanned, so the per-row checks stay
  // cheap: receipts by key, one set of the Project's turn-starting messages
  // (built once; projection_turns has no index on pending_message_id), and
  // the activity scan only for a start that never became a turn.
  const findDeliveries = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String }),
    Result: AgentDeliveryRow,
    execute: ({ projectId }) => sql`
      SELECT m.thread_id AS "threadId", m.message_id AS "messageId", m.text,
             m.source_json AS "source",
             NOT ${notStarted} AS "started",
             r.runtime_mode AS "runtimeMode", r.interaction_mode AS "interactionMode"
      FROM projection_thread_messages m
      JOIN projection_threads r ON r.thread_id = m.thread_id
      WHERE r.project_id = ${projectId} AND r.deleted_at IS NULL AND r.archived_at IS NULL
        AND ${isDelivery}
        AND (
          ${notStarted}
          OR (
            m.message_id GLOB ${pushPattern}
            AND m.message_id NOT IN (
              SELECT t.pending_message_id FROM projection_turns t
              JOIN projection_threads tr ON tr.thread_id = t.thread_id
              WHERE tr.project_id = ${projectId} AND t.pending_message_id IS NOT NULL
            )
            AND EXISTS (
              SELECT 1 FROM orchestration_command_receipts c
              WHERE c.command_id = ${AGENT_DELIVERY_START_PREFIX} || m.message_id
                AND c.status = 'accepted'
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_command_receipts c
              WHERE c.command_id = ${AGENT_DELIVERY_RETRY_PREFIX} || m.message_id
            )
            AND EXISTS (
              SELECT 1 FROM projection_thread_activities f
              WHERE f.thread_id = m.thread_id AND f.kind = 'provider.turn.start.failed'
                AND json_extract(f.payload_json, '$.requestId') = m.message_id
            )
          )
        )
      ORDER BY m.rowid
    `,
  });

  // Held deliveries outlive a Project's marker (Move to Tasks), so these find
  // them without one: per thread on a turn end, and across Projects at startup.
  const findThreadHasHeldDelivery = SqlSchema.findOne({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: Schema.Struct({ held: Schema.BooleanFromBit }),
    execute: ({ threadId }) => sql`
      SELECT EXISTS (
        SELECT 1 FROM projection_thread_messages m
        WHERE m.thread_id = ${threadId} AND ${isDelivery} AND ${notStarted}
      ) AS "held"
    `,
  });
  const findProjectsWithHeldDeliveries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ projectId: ProjectId }),
    execute: () => sql`
      SELECT DISTINCT r.project_id AS "projectId"
      FROM projection_thread_messages m
      JOIN projection_threads r ON r.thread_id = m.thread_id
      WHERE r.deleted_at IS NULL AND r.archived_at IS NULL AND ${isDelivery} AND ${notStarted}
    `,
  });

  // A release is a turn started by the user (no source) or by a manager's
  // request (a replyTo). Turns with no starting message count as neither.
  const findPushBudget = SqlSchema.findOne({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: PushBudgetRow,
    execute: ({ threadId }) => sql`
      WITH started AS (
        SELECT t.row_id AS row_id, t.pending_message_id AS message_id, m.source_json AS source_json
        FROM projection_turns t
        JOIN projection_thread_messages m ON m.message_id = t.pending_message_id
        WHERE t.thread_id = ${threadId}
      ),
      release AS (
        SELECT row_id, message_id FROM started
        WHERE source_json IS NULL OR json_extract(source_json, '$.replyTo') IS NOT NULL
        ORDER BY row_id DESC
        LIMIT 1
      )
      SELECT
        (
          SELECT COUNT(*) FROM started
          WHERE message_id GLOB ${pushPattern}
            AND row_id > COALESCE((SELECT row_id FROM release), 0)
        ) AS "pushedSinceRelease",
        (SELECT message_id FROM release) AS "releaseMessageId"
    `,
  });

  const listOwedResults = (
    projectId: ProjectId,
  ): Effect.Effect<ReadonlyArray<OwedResult>, ProjectionRepositoryError> =>
    findOwedResults({ projectId }).pipe(Effect.mapError(toRepositoryError("listOwedResults")));

  const readAgentResult = (input: {
    readonly agentThreadId: ThreadId;
    readonly requestId: MessageId;
  }): Effect.Effect<AgentResult | null, ProjectionRepositoryError> =>
    findAgentResult(input).pipe(
      Effect.mapError(toRepositoryError("readAgentResult")),
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (row): AgentResult => ({
            outcome: resultOutcome(row),
            text: row.text,
            isLatestRequest: row.isLatestRequest,
          }),
        }),
      ),
    );

  const listDeliveries = (
    projectId: ProjectId,
  ): Effect.Effect<ReadonlyArray<AgentDelivery>, ProjectionRepositoryError> =>
    findDeliveries({ projectId }).pipe(Effect.mapError(toRepositoryError("listDeliveries")));

  const pushBudget = (threadId: ThreadId): Effect.Effect<PushBudget, ProjectionRepositoryError> =>
    findPushBudget({ threadId }).pipe(Effect.mapError(toRepositoryError("pushBudget")));

  const hasHeldDelivery = (threadId: ThreadId): Effect.Effect<boolean, ProjectionRepositoryError> =>
    findThreadHasHeldDelivery({ threadId }).pipe(
      Effect.map((row) => row.held),
      Effect.mapError(toRepositoryError("hasHeldDelivery")),
    );

  const listProjectsWithHeldDeliveries = (): Effect.Effect<
    ReadonlyArray<ProjectId>,
    ProjectionRepositoryError
  > =>
    findProjectsWithHeldDeliveries(undefined).pipe(
      Effect.map((rows) => rows.map((row) => row.projectId)),
      Effect.mapError(toRepositoryError("listProjectsWithHeldDeliveries")),
    );

  return {
    listOwedResults,
    readAgentResult,
    listDeliveries,
    pushBudget,
    hasHeldDelivery,
    listProjectsWithHeldDeliveries,
  };
}

export type AgentPushQueries = ReturnType<typeof makeAgentPushQueries>;

/**
 * The request's state comes from the agent's latest turn, so a restart
 * continuation that superseded the request's turn reports how it ended.
 */
function resultOutcome(row: typeof AgentResultRow.Type): AgentResultOutcome {
  if (row.requestStarted) {
    switch (row.latestTurnState) {
      case "error":
        return { kind: "failed", lastError: row.lastError };
      case "interrupted":
        return { kind: "stopped" };
      default:
        return { kind: "finished" };
    }
  }
  if (row.startFailed) return { kind: "failed-to-start", detail: row.startFailureDetail };
  // No turn took the request: a restart failed its session, or it was stopped.
  if (row.sessionStatus === "error") return { kind: "failed-to-start", detail: row.lastError };
  return { kind: "stopped" };
}

const ERROR_CAP_BYTES = 500;
const TRUNCATED_MARKER = "\n[truncated: use cp_agent_read for the rest]";

function outcomeLabel(outcome: AgentResultOutcome): string {
  const cutError = (text: string | null) =>
    text === null || text.trim().length === 0
      ? ""
      : `: ${capUtf8(text.trim(), ERROR_CAP_BYTES, "...")}`;
  switch (outcome.kind) {
    case "finished":
      return "finished";
    case "failed":
      return `failed${cutError(outcome.lastError)}`;
    case "stopped":
      return "stopped before finishing";
    case "failed-to-start":
      return `failed to start${cutError(outcome.detail)}`;
  }
}

/** The message appended into the recipient for one request. */
export function formatAgentResult(input: {
  readonly agentTitle: string;
  readonly agentThreadId: string;
  readonly outcome: AgentResultOutcome;
  readonly text: string | null;
  readonly questions: ReadonlyArray<string>;
}): string {
  const header = `Result from agent "${input.agentTitle}" (threadId ${input.agentThreadId}): ${outcomeLabel(input.outcome)}`;
  const reply = input.text?.trim() ?? "";
  const parts = [
    header,
    reply.length > 0
      ? capUtf8(reply, AGENT_RESULT_CAP_BYTES, TRUNCATED_MARKER)
      : "(no final message)",
  ];
  if (input.questions.length > 0) {
    parts.push(
      ["Questions for the user:", ...input.questions.map((question) => `- ${question}`)].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/**
 * Questions an agent asked in message mode (Codex async questions) that no
 * answer or dismissal has resolved. They outlive the turn, so they travel
 * with the result.
 */
export function openMessageQuestions(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyArray<string> {
  const open = new Map<string, ReadonlyArray<string>>();
  for (const { kind, payload } of activities) {
    if (!Predicate.isObject(payload) || typeof payload.requestId !== "string") continue;
    if (kind === "user-input.requested" && payload.responseMode === "message") {
      const questions: ReadonlyArray<unknown> = Array.isArray(payload.questions)
        ? payload.questions
        : [];
      open.set(
        payload.requestId,
        questions.flatMap((entry) =>
          Predicate.isObject(entry) && typeof entry.question === "string" ? [entry.question] : [],
        ),
      );
    } else if (kind === "user-input.resolved") {
      open.delete(payload.requestId);
    }
  }
  return [...open.values()].flat();
}

/**
 * Whether a delivery may start in a thread: its session is not working, and
 * no sent message is waiting to be adopted. A pending start older than the
 * grace window is treated as lost, as `threadHasQueuedTurnStart` does.
 */
export function isDeliveryIdle(
  session: { readonly status: string } | null,
  pendingStart: { readonly requestedAt: string } | null,
  now: string,
): boolean {
  if (session?.status === "starting" || session?.status === "running") return false;
  if (pendingStart === null) return true;
  const age = Date.parse(now) - Date.parse(pendingStart.requestedAt);
  return Number.isNaN(age) || Math.abs(age) > AGENT_QUEUED_START_GRACE_MS;
}
