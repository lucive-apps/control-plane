import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewPresentation } from "./previewPresentation";

describe("resolvePreviewPresentation", () => {
  it("separates an off-screen thread preview from a background tab", () => {
    expect(
      resolvePreviewPresentation({ visible: true, windowVisible: true, shownInThread: true }),
    ).toBe("on-screen");
    expect(
      resolvePreviewPresentation({ visible: false, windowVisible: true, shownInThread: true }),
    ).toBe("shown-in-thread");
    expect(
      resolvePreviewPresentation({ visible: false, windowVisible: true, shownInThread: false }),
    ).toBe("background");
  });

  it("does not claim on-screen while the app window is minimized or hidden", () => {
    expect(
      resolvePreviewPresentation({ visible: true, windowVisible: false, shownInThread: true }),
    ).toBe("shown-in-thread");
  });
});
