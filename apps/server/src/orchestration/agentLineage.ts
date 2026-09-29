/**
 * Which thread started an agent. Fork-owned.
 *
 * `createdByThreadId` is recorded once, on the `thread.created` event, and has
 * no projection column: a fork migration would renumber on every upstream
 * sync. The latest creation wins, since a deleted thread id can be created
 * again. Consumers provide `AgentLineage.layer` in their own Live layers, and
 * tests stub the service.
 *
 * @module agentLineage
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";

export interface AgentLineageShape {
  /** The manager that created `threadId` with `cp_agent_create`, or null. */
  readonly creatorOf: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadId | null, ProjectionRepositoryError>;
}

const makeAgentLineage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The (aggregate_kind, stream_id, sequence) index narrows this to one
  // stream, but the walk back to its creation is linear in the stream's
  // length. Use it for single lookups, never per event.
  const findLatestCreation = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: Schema.Struct({ createdByThreadId: Schema.NullOr(ThreadId) }),
    execute: ({ threadId }) =>
      sql`
        SELECT json_extract(payload_json, '$.createdByThreadId') AS "createdByThreadId"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND event_type = 'thread.created'
        ORDER BY sequence DESC
        LIMIT 1
      `,
  });

  const creatorOf: AgentLineageShape["creatorOf"] = (threadId) =>
    findLatestCreation({ threadId }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.createdByThreadId })),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError("AgentLineage.creatorOf:decodeRow")(cause)
          : toPersistenceSqlError("AgentLineage.creatorOf:query")(cause),
      ),
    );

  return { creatorOf } satisfies AgentLineageShape;
});

export class AgentLineage extends Context.Service<AgentLineage, AgentLineageShape>()(
  "t3/orchestration/agentLineage",
) {
  static readonly layer = Layer.effect(AgentLineage, makeAgentLineage);
}
