import { describe, expect, it } from "vite-plus/test";

import { showsTurnMinimap } from "./assistantThreadView.logic";

describe("showsTurnMinimap", () => {
  it("drops the minimap for the coordinator only", () => {
    expect(showsTurnMinimap("coordinator")).toBe(false);
    expect(showsTurnMinimap("agent")).toBe(true);
    expect(showsTurnMinimap(null)).toBe(true);
  });
});
