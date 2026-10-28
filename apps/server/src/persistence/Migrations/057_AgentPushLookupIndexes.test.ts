import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0057 from "./057_AgentPushLookupIndexes.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_AgentPushLookupIndexes", (it) => {
  it.effect("indexes the agent reactor's reply and failed-start lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* runMigrations({ toMigrationInclusive: 57 });
      // A rerun is a no-op.
      yield* Migration0057;

      const columns = (index: string) =>
        sql<{ readonly name: string }>`SELECT name FROM pragma_index_info(${index})`.pipe(
          Effect.map((rows) => rows.map((row) => row.name)),
        );
      assert.deepStrictEqual(yield* columns("idx_projection_thread_messages_thread_turn"), [
        "thread_id",
        "turn_id",
      ]);
      assert.deepStrictEqual(yield* columns("idx_projection_thread_activities_thread_kind"), [
        "thread_id",
        "kind",
      ]);

      // The shapes `agentPushes.ts` runs per completed turn and per request.
      const plan = (rows: ReadonlyArray<{ readonly detail: string }>) =>
        rows.map((row) => row.detail).join("\n");
      const replyPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT MAX(e.rowid) FROM projection_thread_messages e
        WHERE e.thread_id = 'thread' AND e.role = 'assistant' AND e.turn_id = 'turn'
          AND e.is_streaming = 0 AND length(trim(e.text)) > 0
      `;
      assert.include(plan(replyPlan), "idx_projection_thread_messages_thread_turn");
      const failedStartPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT 1 FROM projection_thread_activities f
        WHERE f.thread_id = 'thread' AND f.kind = 'provider.turn.start.failed'
          AND json_extract(f.payload_json, '$.requestId') = 'request'
      `;
      assert.include(plan(failedStartPlan), "idx_projection_thread_activities_thread_kind");
    }),
  );
});
