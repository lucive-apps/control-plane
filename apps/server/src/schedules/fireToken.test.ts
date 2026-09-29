import { describe, expect, it } from "vite-plus/test";

import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import {
  SCHEDULE_FIRE_TOKEN_TTL_MS,
  issueScheduleFireToken,
  verifyScheduleFireToken,
} from "./fireToken.ts";

const secret = new Uint8Array(32).fill(7);
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

const sign = (claims: Record<string, unknown>) => {
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${payload}.${signPayload(payload, secret)}`;
};

describe("schedule-fire token", () => {
  it("verifies for two minutes and then expires", () => {
    const token = issueScheduleFireToken(secret, NOW);
    expect(verifyScheduleFireToken(token, secret, NOW)).toBe(true);
    expect(verifyScheduleFireToken(token, secret, NOW + SCHEDULE_FIRE_TOKEN_TTL_MS - 1)).toBe(true);
    expect(verifyScheduleFireToken(token, secret, NOW + SCHEDULE_FIRE_TOKEN_TTL_MS)).toBe(false);
  });

  it("refuses a session token signed with the same key", () => {
    const session = sign({
      v: 1,
      kind: "session",
      sid: "session-1",
      sub: "browser",
      scopes: ["orchestration:operate"],
      method: "bearer-access-token",
      iat: NOW,
      exp: NOW + 60_000,
    });
    expect(verifyScheduleFireToken(session, secret, NOW)).toBe(false);
  });

  it("refuses a tampered signature, another key and a long-lived token", () => {
    const token = issueScheduleFireToken(secret, NOW);
    const [payload, signature] = token.split(".");
    // The first character is all signal; the last carries padding bits.
    const flipped = `${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    expect(verifyScheduleFireToken(`${payload}.${flipped}`, secret, NOW)).toBe(false);
    expect(verifyScheduleFireToken(token, new Uint8Array(32).fill(8), NOW)).toBe(false);
    expect(
      verifyScheduleFireToken(
        sign({ v: 1, kind: "schedule-fire", iat: NOW, exp: NOW + 24 * 60 * 60 * 1000 }),
        secret,
        NOW,
      ),
    ).toBe(false);
  });
});
