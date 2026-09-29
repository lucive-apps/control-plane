// @effect-diagnostics globalDate:off -- The route reads the live clock, so tokens are minted against it.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import { scheduleFireRouteLayer } from "./fireRoute.ts";
import {
  SCHEDULE_FIRE_ROUTE_PATH,
  SCHEDULE_FIRE_SIGNING_SECRET,
  issueScheduleFireToken,
} from "./fireToken.ts";
import { ScheduleService } from "./ScheduleService.ts";

const secret = new Uint8Array(32).fill(3);
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = () => {
  const fires: Date[] = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    scheduleFireRouteLayer.pipe(
      Layer.provideMerge(
        Layer.mock(ScheduleService)({
          requestFire: (now) => Effect.sync(() => void fires.push(now)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Effect.succeed(
              name === SCHEDULE_FIRE_SIGNING_SECRET ? Option.some(secret) : Option.none(),
            ),
        }),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const post = (authorization?: string) =>
    handler(
      new Request(`http://127.0.0.1:3773${SCHEDULE_FIRE_ROUTE_PATH}`, {
        method: "POST",
        ...(authorization !== undefined ? { headers: { authorization } } : {}),
      }),
    );
  return { fires, post };
};

describe("schedule fire route", () => {
  it("refuses a request without a schedule-fire token", async () => {
    const { fires, post } = fixture();
    expect((await post()).status).toBe(401);
    expect((await post("Bearer not-a-token")).status).toBe(401);
    const payload = base64UrlEncode(
      JSON.stringify({
        v: 1,
        kind: "websocket",
        sid: "s",
        iat: Date.now(),
        exp: Date.now() + 60_000,
      }),
    );
    expect((await post(`Bearer ${payload}.${signPayload(payload, secret)}`)).status).toBe(401);
    expect(fires).toEqual([]);
  });

  it("queues exactly one fire for a valid token", async () => {
    const { fires, post } = fixture();
    const response = await post(`Bearer ${issueScheduleFireToken(secret, Date.now())}`);
    expect(response.status).toBe(202);
    expect(fires).toHaveLength(1);
  });
});
