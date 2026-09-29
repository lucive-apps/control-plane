/**
 * `POST /api/orchestration/schedules/fire`: the host's OS entry asks the server
 * to run whatever is due. Fork-owned.
 *
 * It takes no parameters and accepts only a `schedule-fire` token, so a leaked
 * token can only run slots that are already due. The fire is queued and the
 * route answers 202 at once; the CLI that calls it returns in seconds.
 *
 * @module fireRoute
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  SCHEDULE_FIRE_ROUTE_PATH,
  SCHEDULE_FIRE_SIGNING_SECRET,
  verifyScheduleFireToken,
} from "./fireToken.ts";
import { ScheduleService } from "./ScheduleService.ts";

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export const scheduleFireRouteLayer = HttpRouter.add(
  "POST",
  SCHEDULE_FIRE_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = BEARER_PATTERN.exec(request.headers.authorization ?? "")?.[1];
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const secret = yield* secrets.get(SCHEDULE_FIRE_SIGNING_SECRET).pipe(
      Effect.map(Option.getOrNull),
      Effect.catch((cause) =>
        Effect.logWarning("schedule fire: signing key unreadable", { cause }).pipe(Effect.as(null)),
      ),
    );
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (token === undefined || secret === null || !verifyScheduleFireToken(token, secret, nowMs)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const schedules = yield* ScheduleService;
    return yield* schedules.requestFire(DateTime.toDateUtc(now)).pipe(
      Effect.as(HttpServerResponse.empty({ status: 202 })),
      Effect.catchTag("ScheduleUnavailableError", (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 409 })),
      ),
    );
  }),
);
