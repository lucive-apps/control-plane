import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0055 from "./055_ProjectionProjectsAssistant.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_ProjectionProjectsAssistant", (it) => {
  it.effect("adds a nullable assistant JSON column, and a rerun is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* runMigrations({ toMigrationInclusive: 55 });
      // A renumbered copy of this migration must be able to run again.
      yield* Migration0055;

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const assistant = columns.filter((column) => column.name === "assistant_json");

      assert.equal(assistant.length, 1);
      assert.equal(assistant[0]?.notnull, 0);
    }),
  );
});
