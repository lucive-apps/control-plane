/**
 * How a sent scheduled run ended, read from projections and receipts.
 * Fork-owned.
 *
 * A restart settles orphaned turns as `error`, so a run that was mid-turn
 * when the server stopped still ends as `failed`. A start that failed or was
 * refused never ran, so it reads as `rejected` ("could not start").
 *
 * @module scheduleQueries
 */
import { MessageId, SCHEDULE_MESSAGE_PREFIX, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";

/** M3's turn start of an appended delivery; see `agentProtocol.ts`. */
const DELIVERY_START_PREFIX = "cp-start:";

export type ScheduleRunOutcome =
  | { readonly kind: "failed"; readonly turnId: TurnId }
  | { readonly kind: "rejected" };

const RunOutcomeRow = Schema.Struct({
  errorTurnId: Schema.NullOr(TurnId),
  startFailed: Schema.BooleanFromBit,
  startRejected: Schema.BooleanFromBit,
});

/** Message id prefix of every Run now of one schedule. */
export function manualRunMessagePrefix(projectId: string, scheduleId: string): string {
  return `${SCHEDULE_MESSAGE_PREFIX}${projectId}:${scheduleId}:manual:`;
}

function toRepositoryError(operation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`scheduleQueries.${operation}:decode`)(cause)
      : toPersistenceSqlError(`scheduleQueries.${operation}:query`)(cause);
}

export function makeScheduleQueries(sql: SqlClient.SqlClient) {
  const findRunOutcome = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String, messageId: Schema.String }),
    Result: RunOutcomeRow,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        (
          SELECT t.turn_id FROM projection_turns t
          WHERE t.thread_id = ${threadId} AND t.pending_message_id = ${messageId}
            AND t.state = 'error' AND t.turn_id IS NOT NULL
          LIMIT 1
        ) AS "errorTurnId",
        EXISTS (
          SELECT 1 FROM projection_thread_activities f
          WHERE f.thread_id = ${threadId} AND f.kind = 'provider.turn.start.failed'
            AND json_extract(f.payload_json, '$.requestId') = ${messageId}
        ) AS "startFailed",
        EXISTS (
          SELECT 1 FROM orchestration_command_receipts c
          WHERE c.command_id = ${DELIVERY_START_PREFIX} || ${messageId} AND c.status = 'rejected'
        ) AS "startRejected"
    `,
  });

  // A Run now id ends in a uuid the run record does not carry, so its message
  // is the one appended to the run's thread at the run's `at`.
  const findManualRunMessage = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String, prefix: Schema.String, at: Schema.String }),
    Result: Schema.Struct({ messageId: MessageId }),
    execute: ({ threadId, prefix, at }) => sql`
      SELECT m.message_id AS "messageId" FROM projection_thread_messages m
      WHERE m.thread_id = ${threadId} AND m.role = 'user' AND m.created_at = ${at}
        AND substr(m.message_id, 1, length(${prefix})) = ${prefix}
      ORDER BY m.rowid DESC
      LIMIT 1
    `,
  });

  /** Null while the run is pending, running or finished well. */
  const runOutcome = (input: {
    readonly threadId: string;
    readonly messageId: string;
  }): Effect.Effect<ScheduleRunOutcome | null, ProjectionRepositoryError> =>
    findRunOutcome(input).pipe(
      Effect.mapError(toRepositoryError("runOutcome")),
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (row): ScheduleRunOutcome | null =>
            row.errorTurnId !== null
              ? { kind: "failed", turnId: row.errorTurnId }
              : row.startFailed || row.startRejected
                ? { kind: "rejected" }
                : null,
        }),
      ),
    );

  /** The message of a Run now recorded at `at`, or null. */
  const manualRunMessageId = (input: {
    readonly threadId: string;
    readonly projectId: string;
    readonly scheduleId: string;
    readonly at: string;
  }): Effect.Effect<MessageId | null, ProjectionRepositoryError> =>
    findManualRunMessage({
      threadId: input.threadId,
      prefix: manualRunMessagePrefix(input.projectId, input.scheduleId),
      at: input.at,
    }).pipe(
      Effect.mapError(toRepositoryError("manualRunMessageId")),
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.messageId })),
    );

  return { runOutcome, manualRunMessageId };
}

export type ScheduleQueries = ReturnType<typeof makeScheduleQueries>;
