import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { shareAutomaticDevServer } from "./dev-tailnet.ts";

describe("automatic tailnet helper lifecycle", () => {
  it.effect("closes the acquired session when the dev stack fails", () =>
    Effect.gen(function* () {
      const events: Array<string | number> = [];
      const result = yield* Effect.gen(function* () {
        const mapping = yield* shareAutomaticDevServer(5733, "/helper.mjs", async (path) => ({
          prepareTailnet: async (port) => {
            events.push(path, port);
            return {
              url: "https://host.example.ts.net:25733",
              close: async () => {
                events.push("closed");
              },
            };
          },
        }));
        assert.equal(mapping?.url, "https://host.example.ts.net:25733");
        assert.deepEqual(events, ["/helper.mjs", 5733]);
        return yield* Effect.fail("dev stack failed");
      }).pipe(Effect.scoped, Effect.flip);
      assert.equal(result, "dev stack failed");
      assert.deepEqual(events, ["/helper.mjs", 5733, "closed"]);
    }),
  );
  it.effect("continues without a mapping when the helper is offline", () =>
    Effect.gen(function* () {
      const mapping = yield* shareAutomaticDevServer(5733, "/helper.mjs", async () => ({
        prepareTailnet: async () => null,
      })).pipe(Effect.scoped);
      assert.isNull(mapping);
    }),
  );
  it.effect("surfaces failed acquisition without claiming a shared URL", () =>
    Effect.gen(function* () {
      const error = yield* shareAutomaticDevServer(5733, "/helper.mjs", async () => {
        throw new Error("occupied");
      }).pipe(Effect.scoped, Effect.flip);
      assert.equal(error._tag, "TailscaleUnavailableError");
    }),
  );
});
