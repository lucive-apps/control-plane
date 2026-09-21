import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProjectionThreadMessageSource", (it) => {
  it.effect("adds source_json to projected thread messages", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });

      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const source = columns.find((column) => column.name === "source_json");
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = 54
      `;

      assert.equal(source?.name, "source_json");
      assert.equal(source?.notnull, 0);
      assert.equal(migrations.length, 1);
    }),
  );
});
