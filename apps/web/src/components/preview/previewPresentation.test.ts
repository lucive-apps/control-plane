import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewPresentation } from "./previewPresentation";

describe("resolvePreviewPresentation", () => {
  it("separates an off-screen thread preview from a background tab", () => {
    expect(resolvePreviewPresentation({ visible: true, shownInThread: true })).toBe("on-screen");
    expect(resolvePreviewPresentation({ visible: false, shownInThread: true })).toBe(
      "shown-in-thread",
    );
    expect(resolvePreviewPresentation({ visible: false, shownInThread: false })).toBe("background");
  });
});
