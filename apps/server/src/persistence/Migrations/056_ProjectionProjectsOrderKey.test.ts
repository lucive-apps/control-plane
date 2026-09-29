import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0056 from "./056_ProjectionProjectsOrderKey.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_ProjectionProjectsOrderKey", (it) => {
  it.effect("adds a nullable order key column, and a rerun is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* Migration0056;

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const orderKey = columns.filter((column) => column.name === "order_key");

      assert.equal(orderKey.length, 1);
      assert.equal(orderKey[0]?.notnull, 0);
    }),
  );
});
