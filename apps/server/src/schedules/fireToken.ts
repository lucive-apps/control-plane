/**
 * The `schedule-fire` token the OS entry's CLI signs and the fire route checks.
 * Fork-owned.
 *
 * It is signed with the home's `server-signing-key`, like session tokens, but
 * carries its own claim kind, so no session or websocket token verifies here
 * and this token verifies nowhere else. It lives two minutes and names
 * nothing: the route it opens only runs slots that are already due.
 *
 * @module fireToken
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

/** The fire route. It takes no parameters. */
export const SCHEDULE_FIRE_ROUTE_PATH = "/api/orchestration/schedules/fire";

/** The secret `SessionStore` signs with; stored at `secrets/server-signing-key.bin`. */
export const SCHEDULE_FIRE_SIGNING_SECRET = "server-signing-key";
export const SCHEDULE_FIRE_TOKEN_TTL_MS = 120_000;

const ScheduleFireClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("schedule-fire"),
  iat: Schema.Number,
  exp: Schema.Number,
});
const claimsJson = Schema.fromJsonString(ScheduleFireClaims);
const encodeClaims = Schema.encodeSync(claimsJson);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);

export function issueScheduleFireToken(secret: Uint8Array, nowMs: number): string {
  const payload = base64UrlEncode(
    encodeClaims({
      v: 1,
      kind: "schedule-fire",
      iat: nowMs,
      exp: nowMs + SCHEDULE_FIRE_TOKEN_TTL_MS,
    }),
  );
  return `${payload}.${signPayload(payload, secret)}`;
}

/** A current, correctly signed `schedule-fire` token that lives at most two minutes. */
export function verifyScheduleFireToken(token: string, secret: Uint8Array, nowMs: number): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return false;
  let json: string;
  try {
    json = base64UrlDecodeUtf8(payload);
  } catch {
    return false;
  }
  const claims = Option.getOrNull(decodeClaims(json));
  return (
    claims !== null &&
    claims.exp > nowMs &&
    claims.exp - claims.iat <= SCHEDULE_FIRE_TOKEN_TTL_MS &&
    claims.iat <= nowMs + SCHEDULE_FIRE_TOKEN_TTL_MS
  );
}
