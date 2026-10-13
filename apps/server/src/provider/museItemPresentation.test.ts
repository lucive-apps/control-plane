import { describe, expect, it } from "@effect/vitest";

import type { MuseItem } from "./museProtocol.ts";
import { museItemStatus, museItemText, museToolPresentation } from "./museItemPresentation.ts";

const item = (fields: Partial<MuseItem>): MuseItem => ({
  itemId: "native-item",
  kind: "toolCall",
  status: "completed",
  revision: 1,
  ...fields,
});

describe("Muse item presentation", () => {
  it("keeps an edit's file and exact old/new text for the shared diff UI", () => {
    expect(
      museToolPresentation(
        item({
          tool: "edit_file",
          args: JSON.stringify({ file_path: "src/index.ts", old_string: "old\n", new_string: "" }),
        }),
      ),
    ).toMatchObject({
      itemType: "file_change",
      status: "completed",
      detail: "src/index.ts",
      data: {
        locations: [{ path: "src/index.ts" }],
        rawInput: { file_path: "src/index.ts", old_string: "old\n", new_string: "" },
      },
    });
  });

  it("shows a shell command with its output and exit code", () => {
    expect(
      museToolPresentation(
        item({
          kind: "userShell",
          commandText: "ls -la",
          visibleOutput: "a.txt\nb.md",
          exitCode: 0,
        }),
      ),
    ).toMatchObject({
      itemType: "command_execution",
      detail: "ls -la",
      data: { command: "ls -la", rawOutput: { stdout: "a.txt\nb.md", exitCode: 0 } },
    });
    expect(
      museToolPresentation(item({ tool: "shell", args: JSON.stringify({ command: "pwd" }) })),
    ).toMatchObject({ itemType: "command_execution", data: { command: "pwd" } });
  });

  it.each(["rejected", "timedOut", "handedOff"])(
    "does not report native %s activity as successful",
    (status) => {
      const native = item({ tool: "search_files", status, fallbackText: "Native explanation" });
      expect(museItemStatus(native)).toBe("failed");
      expect(museToolPresentation(native)).toMatchObject({
        status: "failed",
        detail: `Muse reported ${status}.`,
        data: { rawOutput: { content: `Muse reported ${status}.\nNative explanation` } },
      });
    },
  );

  it("treats a cancelled item as declined and a running one as in progress", () => {
    expect(museItemStatus(item({ status: "cancelled" }))).toBe("declined");
    expect(museItemStatus(item({ status: "inProgress" }))).toBe("inProgress");
    expect(
      museItemStatus(item({ kind: "compaction", status: "completed", outcome: "skipped" })),
    ).toBe("failed");
  });

  it("lists web search hits and keeps a page fetch's text", () => {
    expect(
      museToolPresentation(
        item({
          tool: "web_search",
          args: JSON.stringify({ query: "effect schema" }),
          visibleOutput: JSON.stringify({
            results: [{ url: "https://effect.website", title: "Effect" }],
          }),
        }),
      ),
    ).toMatchObject({
      itemType: "web_search",
      detail: "effect schema",
      data: { results: [{ url: "https://effect.website", title: "Effect" }] },
    });
    expect(
      museToolPresentation(
        item({
          tool: "web_fetch",
          args: JSON.stringify({ url: "https://example.com" }),
          visibleOutput: "Example Domain",
        }),
      ),
    ).toMatchObject({
      itemType: "web_search",
      detail: "https://example.com",
      data: { rawOutput: { content: "Example Domain" } },
    });
  });

  it("shows subagents and workflows as agent rows with their objective", () => {
    expect(
      museToolPresentation(
        item({
          kind: "subagent",
          status: "inProgress",
          objective: "Audit the tests",
          role: "reviewer",
        }),
      ),
    ).toMatchObject({
      itemType: "collab_agent_tool_call",
      status: "inProgress",
      title: "Muse agent",
      detail: "Audit the tests",
      data: { kind: "subagent", prompt: "Audit the tests" },
    });
    expect(
      museToolPresentation(item({ kind: "workflow", entryId: "review", finalSummary: "Done" })),
    ).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Muse workflow",
      detail: "review",
      data: { rawOutput: { content: "Done" } },
    });
  });

  it("marks MCP tools and keeps unparseable streaming arguments", () => {
    expect(museToolPresentation(item({ tool: "mcp__cplane__cp_agent_list" }))).toMatchObject({
      itemType: "mcp_tool_call",
      title: "mcp__cplane__cp_agent_list",
    });
    expect(
      museToolPresentation(
        item({ tool: "read_file", args: '{"path": "src/in', status: "inProgress" }),
      ),
    ).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "inProgress",
      data: { tool: "read_file" },
    });
  });

  it("prefers output, then results, then message text", () => {
    expect(museItemText(item({ visibleOutput: "out", text: "text" }))).toBe("out");
    expect(museItemText(item({ result: { summary: "sum", text: "full" } }))).toBe("full");
    expect(museItemText(item({ summary: ["a", "b"] }))).toBe("a\nb");
  });
});
