import type { CanonicalItemType, RuntimeItemStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MuseItem } from "./museProtocol.ts";

const decodeToolArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
/** Muse's `web_search` tool output: the query and its hits, as JSON. */
const decodeWebSearchOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          url: Schema.optional(Schema.String),
          title: Schema.optional(Schema.String),
          snippet: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** A Muse item as one V1 item lifecycle payload. */
export interface MuseItemPresentation {
  readonly itemType: CanonicalItemType;
  readonly status: RuntimeItemStatus;
  readonly title: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

/** Unrecognized native terminal states must not appear as successful work. */
export function museItemStatus(item: MuseItem): RuntimeItemStatus {
  if (item.status === "inProgress") return "inProgress";
  if (item.status === "cancelled") return "declined";
  if (
    item.status === "completed" &&
    !(item.kind === "compaction" && item.outcome && item.outcome !== "compacted")
  )
    return "completed";
  return "failed";
}

/** The text a Muse item shows: output, result, or message text. */
export function museItemText(item: MuseItem): string {
  return (
    item.visibleOutput ??
    item.result?.text ??
    item.result?.summary ??
    item.text ??
    item.summary?.join("\n") ??
    item.finalSummary ??
    item.fallbackText ??
    item.objective ??
    ""
  );
}

/** Converts a native Muse tool item into the shared V1 tool fields every client reads. */
export function museToolPresentation(
  item: MuseItem,
  status = museItemStatus(item),
): MuseItemPresentation {
  const args = item.args ? Option.getOrUndefined(decodeToolArgs(item.args)) : undefined;
  const stringArg = (...keys: string[]) => {
    for (const key of keys) {
      const value = args?.[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  };
  const toolName = item.tool ?? item.kind;
  const failure =
    status === "failed" ? item.failureReason || `Muse reported ${item.status}.` : undefined;
  const text = museItemText(item);
  const output = failure ? [failure, text].filter(Boolean).join("\n") : text;
  const base = { toolCallId: item.itemId, tool: toolName, ...(args ? { rawInput: args } : {}) };

  if (item.kind === "subagent" || item.kind === "workflow") {
    const title =
      item.kind === "subagent"
        ? item.objective || item.role || "Muse agent"
        : item.entryId || "Workflow";
    return {
      itemType: "collab_agent_tool_call",
      status,
      title: item.kind === "subagent" ? "Muse agent" : "Muse workflow",
      ...(title ? { detail: title } : {}),
      data: {
        ...base,
        kind: item.kind,
        ...(item.objective ? { prompt: item.objective } : {}),
        ...(output && status !== "inProgress" ? { rawOutput: { content: output } } : {}),
        ...(item.children ? { children: item.children } : {}),
      },
    };
  }

  if (item.kind === "userShell" || /shell|bash|exec_command/i.test(item.tool ?? "")) {
    const command = item.commandText ?? stringArg("command", "cmd") ?? item.args ?? "";
    return {
      itemType: "command_execution",
      status,
      title: "Ran command",
      ...(command ? { detail: command } : {}),
      data: {
        ...base,
        kind: "execute",
        ...(command ? { command } : {}),
        rawOutput: {
          ...(output ? { stdout: output } : {}),
          ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
        },
      },
    };
  }

  if (item.kind === "toolCall" && /write|edit|patch/i.test(toolName)) {
    const filePath = stringArg("file_path", "path", "filePath")?.trim();
    if (filePath) {
      return {
        itemType: "file_change",
        status,
        title: toolName,
        detail: failure ? `${filePath}: ${failure}` : filePath,
        data: { ...base, kind: "edit", locations: [{ path: filePath }] },
      };
    }
  }

  if (item.kind === "toolCall" && /web|browse|fetch/i.test(toolName)) {
    const query = stringArg("query", "url", "pattern")?.trim();
    const hits =
      item.tool === "web_search" && !failure
        ? Option.getOrUndefined(decodeWebSearchOutput(text))?.results
        : undefined;
    return {
      itemType: "web_search",
      status,
      title: toolName,
      ...(query ? { detail: query } : failure ? { detail: failure } : {}),
      data: {
        ...base,
        kind: "fetch",
        ...(query ? { query } : {}),
        ...(hits ? { results: hits } : output ? { rawOutput: { content: output } } : {}),
      },
    };
  }

  const isMcp = toolName.startsWith("mcp__") || toolName.includes("/");
  return {
    itemType: isMcp ? "mcp_tool_call" : "dynamic_tool_call",
    status,
    title: toolName,
    ...(failure ? { detail: failure } : {}),
    data: {
      ...base,
      ...(output && status !== "inProgress" ? { rawOutput: { content: output } } : {}),
    },
  };
}
