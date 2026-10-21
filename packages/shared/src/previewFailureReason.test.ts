import { describe, expect, it } from "vite-plus/test";

import { previewFailureReason, sanitizePreviewFailureText } from "./previewFailureReason.ts";

describe("previewFailureReason", () => {
  it("joins a wrapped cause chain into one actionable line", () => {
    const timeout = Object.assign(new Error("Operation timed out after '1s'"), {
      _tag: "TimeoutError",
    });
    const wrapper = new Error("Desktop preview operation failed: automationSnapshot.capturePage", {
      cause: timeout,
    });
    expect(previewFailureReason(wrapper)).toBe(
      "Desktop preview operation failed: automationSnapshot.capturePage: TimeoutError: Operation timed out after '1s'",
    );
  });

  it("does not repeat a cause the wrapper already quotes", () => {
    const inner = new Error("target closed while handling command");
    const outer = new Error("Runtime.enable failed: target closed while handling command", {
      cause: inner,
    });
    expect(previewFailureReason(outer)).toBe(
      "Runtime.enable failed: target closed while handling command",
    );
  });

  it("strips local paths, URL queries and token-like values", () => {
    const text = sanitizePreviewFailureText(
      "ERR_ABORTED loading 'https://app.example.com/callback?code=abc123&state=xyz' from file:///Users/nick/app/index.html at /Users/nick/.t3/userdata/x.png Authorization: Bearer-zzz " +
        "a".repeat(48),
    );
    expect(text).not.toContain("code=abc123");
    expect(text).not.toContain("/Users/nick");
    expect(text).not.toContain("Bearer-zzz");
    expect(text).not.toContain("a".repeat(48));
    expect(text).toContain("https://app.example.com/callback");
  });

  it("bounds the reason and ignores causes without text", () => {
    expect(
      previewFailureReason(new Error("x".repeat(20) + " " + "word ".repeat(200))),
    ).toHaveLength(300);
    expect(previewFailureReason({})).toBeUndefined();
    expect(previewFailureReason(undefined)).toBeUndefined();
  });
});
