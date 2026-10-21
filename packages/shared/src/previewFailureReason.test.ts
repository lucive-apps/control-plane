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

  it("strips local paths, URL credentials and queries, and token-like values", () => {
    const text = sanitizePreviewFailureText(
      [
        "ERR_ABORTED loading 'https://user:hunter2@app.example.com/callback?code=abc123&state=xyz'",
        "from file:///Users/nick/app/index.html",
        "at /Users/nick/Library/Application Support/Control Plane/x.png",
        "and C:/Users/nick/a.txt",
        "Authorization: Bearer abc123def456",
        '{"access_token":"sk-live-1"} api_key=k-2 x-api-key: k-3',
        "a".repeat(48),
      ].join(" "),
    );
    for (const leaked of [
      "hunter2",
      "code=abc123",
      "/Users/nick",
      "nick/a.txt",
      "Support/Control",
      "abc123def456",
      "sk-live-1",
      "k-2",
      "k-3",
      "a".repeat(48),
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("https://app.example.com/callback");
  });

  it("keeps ordinary words that only resemble credential keys", () => {
    expect(sanitizePreviewFailureText("token expired while waiting; Cookie import failed")).toBe(
      "token expired while waiting; Cookie import failed",
    );
  });

  it("bounds the reason and ignores causes without text", () => {
    expect(
      previewFailureReason(new Error("x".repeat(20) + " " + "word ".repeat(200))),
    ).toHaveLength(300);
    expect(previewFailureReason({})).toBeUndefined();
    expect(previewFailureReason(undefined)).toBeUndefined();
  });
});
