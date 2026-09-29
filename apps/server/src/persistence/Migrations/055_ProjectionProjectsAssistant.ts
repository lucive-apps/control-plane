import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Fork migration. Once shipped, this id never moves: the migrator only runs ids
// above the highest recorded one, so a renumbered fork migration would make
// databases skip upstream's migration at this id. Port a colliding upstream
// migration to the next free id instead, PRAGMA-guarded like this one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "assistant_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN assistant_json TEXT
    `;
  }
});
