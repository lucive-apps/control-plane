import { describe, expect, it } from "@effect/vitest";

import { parseRetryAfterMs } from "./http.ts";

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");

  it("reads delay seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("5", now)).toBe(5_000);
    expect(parseRetryAfterMs("Tue, 29 Sep 2026 12:00:07 GMT", now)).toBe(7_000);
    expect(parseRetryAfterMs("Tue, 29 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("ignores missing or unusable values", () => {
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
  });
});
