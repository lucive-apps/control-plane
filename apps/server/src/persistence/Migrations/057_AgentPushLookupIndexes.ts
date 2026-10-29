import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Lookup indexes for the agent completion reactor's per-Project passes
 * (`agentPushes.ts`). Without them, finding a turn's assistant reply scans
 * every message in the thread once per completed turn, finding the request
 * before a continuation sorts every turn in the thread once per turn, and
 * finding a failed turn start scans every activity in the thread once per
 * request. On a large
 * coordinator thread those synchronous reads held the server's event loop for
 * over a minute, long enough for clients to drop the connection.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_turn
    ON projection_thread_messages(thread_id, turn_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind
    ON projection_thread_activities(thread_id, kind)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_row
    ON projection_turns(thread_id, row_id)
  `;
});
