import { GLOBAL_INSTRUCTIONS_CAP_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  globalInstructionsErrorMessage,
  globalInstructionsUsage,
} from "./GlobalInstructionsSettings.logic";

describe("globalInstructionsUsage", () => {
  it("counts the trimmed text against the server cap", () => {
    const usage = globalInstructionsUsage("  - one rule  \n");
    expect(usage).toMatchObject({ count: 10, cap: GLOBAL_INSTRUCTIONS_CAP_CHARS, tone: "normal" });
    expect(usage.label).toBe("10 / 8,000 characters");
    expect(usage.warning).toBeNull();
  });

  it("turns amber from 90% and warns once over the cap", () => {
    expect(globalInstructionsUsage("a".repeat(7_200)).tone).toBe("near");
    expect(globalInstructionsUsage("a".repeat(8_000)).warning).toBeNull();
    const over = globalInstructionsUsage("a".repeat(8_250));
    expect(over.tone).toBe("over");
    expect(over.label).toBe("8,250 / 8,000 characters");
    expect(over.warning).toContain("Over the cap by 250.");
  });
});

describe("globalInstructionsErrorMessage", () => {
  it("prefers the server's detail", () => {
    expect(globalInstructionsErrorMessage({ detail: "Could not write x" })).toBe(
      "Could not write x",
    );
    expect(globalInstructionsErrorMessage(new Error("boom"))).toBe("boom");
    expect(globalInstructionsErrorMessage(null)).toBe("An error occurred.");
  });
});
