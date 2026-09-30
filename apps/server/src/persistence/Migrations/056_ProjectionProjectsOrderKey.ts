import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Fork migration. Once shipped, this id never moves (see 055). PRAGMA-guarded so a
// renumbered copy can run again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "order_key")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN order_key TEXT
    `;
  }
});
