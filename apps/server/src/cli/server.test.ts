import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CplaneOwnerMarker } from "@t3tools/shared/home";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { markDefaultHomeOwner } from "./server.ts";

const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(CplaneOwnerMarker));

it.layer(NodeServices.layer)("markDefaultHomeOwner", (it) => {
  it.effect("marks ~/.t3 for a server start but never for a dev server or another home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-marker-" });
      const stateDir = path.join(homeDirectory, ".t3", "userdata");
      const otherStateDir = path.join(homeDirectory, "elsewhere", "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.makeDirectory(otherStateDir, { recursive: true });
      const marker = path.join(stateDir, "cplane-owner");

      yield* markDefaultHomeOwner(
        {
          baseDir: path.join(homeDirectory, ".t3"),
          stateDir,
          devUrl: new URL("http://localhost:5733"),
        },
        homeDirectory,
      );
      yield* markDefaultHomeOwner(
        {
          baseDir: path.join(homeDirectory, "elsewhere"),
          stateDir: otherStateDir,
          devUrl: undefined,
        },
        homeDirectory,
      );
      assert.isFalse(yield* fs.exists(marker));
      assert.isFalse(yield* fs.exists(path.join(otherStateDir, "cplane-owner")));

      yield* markDefaultHomeOwner(
        { baseDir: path.join(homeDirectory, ".t3"), stateDir, devUrl: undefined },
        homeDirectory,
      );
      const written = decodeMarker(yield* fs.readFileString(marker));
      assert.equal(written.app, "control-plane");
      assert.equal(written.version, packageJson.version);
    }).pipe(Effect.scoped),
  );
});
