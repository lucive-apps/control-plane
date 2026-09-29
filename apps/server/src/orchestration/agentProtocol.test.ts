import { assert, describe, it } from "@effect/vitest";

import { capUtf8 } from "./agentProtocol.ts";

const MARKER = "\n[truncated]";

describe("capUtf8", () => {
  it("returns text that fits unchanged", () => {
    assert.strictEqual(capUtf8("héllo", 6, MARKER), "héllo");
    assert.strictEqual(capUtf8("", 0, MARKER), "");
  });

  it("never splits a multi-byte character", () => {
    // "é" is 2 bytes and "🚀" is 4, so byte 2 and bytes 5 to 7 are mid-character.
    const text = "aé🚀b";
    assert.strictEqual(capUtf8(text, 1, MARKER), `a${MARKER}`);
    assert.strictEqual(capUtf8(text, 2, MARKER), `a${MARKER}`);
    assert.strictEqual(capUtf8(text, 3, MARKER), `aé${MARKER}`);
    for (const maxBytes of [4, 5, 6]) {
      assert.strictEqual(capUtf8(text, maxBytes, MARKER), `aé${MARKER}`, `at ${maxBytes}`);
    }
    assert.strictEqual(capUtf8(text, 7, MARKER), `aé🚀${MARKER}`);
    assert.strictEqual(capUtf8(text, 8, MARKER), text);
  });

  it("keeps the cut within the byte limit and adds the marker after it", () => {
    const text = "日本語".repeat(10);
    const capped = capUtf8(text, 16, MARKER);
    assert.isTrue(capped.endsWith(MARKER));
    const kept = capped.slice(0, -MARKER.length);
    assert.strictEqual(kept, "日本語日本");
    assert.isAtMost(Buffer.byteLength(kept, "utf8"), 16);
  });
});
