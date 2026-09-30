import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { clearAssistantRuntime, setAssistantRuntime } from "./assistantRuntime.ts";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the cplane MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  describe("Project role block", () => {
    const threadId = ThreadId.make("project-thread");
    afterEach(() => clearAssistantRuntime(threadId));

    it("appends the block registered for the thread", () => {
      setAssistantRuntime(threadId, { roleKey: "k", inline: "INLINE BLOCK", pointer: "POINTER" });

      const instructions = buildRuntimeInstructions({ harness: "Claude Code", threadId });

      expect(instructions.endsWith("</pull_request_linking>\n\nINLINE BLOCK")).toBe(true);
      expect(instructions).not.toContain("POINTER");
      expect(buildRuntimeInstructions({ harness: "Claude Code" })).not.toContain("INLINE BLOCK");
      expect(
        buildRuntimeInstructions({ harness: "Claude Code", threadId: ThreadId.make("other") }),
      ).not.toContain("INLINE BLOCK");
    });

    it("appends the pointer for providers that resend it every prompt", () => {
      setAssistantRuntime(threadId, { roleKey: "k", inline: "INLINE BLOCK", pointer: "POINTER" });

      const instructions = buildRuntimeInstructions({ harness: "Grok", threadId });

      expect(instructions.endsWith("\n\nPOINTER")).toBe(true);
      expect(instructions).not.toContain("INLINE BLOCK");
    });
  });
});
