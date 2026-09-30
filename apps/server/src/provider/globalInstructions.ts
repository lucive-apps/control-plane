// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  GLOBAL_INSTRUCTIONS_CAP_CHARS,
  GLOBAL_INSTRUCTIONS_FILE,
  GlobalInstructionsError,
  type GlobalInstructionsInput,
  type GlobalInstructionsResult,
  type GlobalInstructionsScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

// Fork-owned. The user's global instructions: `<stateDir>/GLOBAL_AGENTS.md`,
// edited in Settings or on disk. prepareAssistantRuntime reads it at each
// session start and puts it ahead of the Project block, so a running session
// keeps the text it started with and the next session start picks up edits.

/** Which scope toggle governs a session. */
export type GlobalInstructionsScope = "coordinator" | "agent" | "tasks";

export interface GlobalInstructionsSource {
  readonly path: string;
  /** The file's contents; "" when missing. */
  readonly text: string;
  readonly scopes: GlobalInstructionsScopes;
}

export interface GlobalInstructionsBlock {
  readonly inline: string;
  readonly pointer: string;
}

export const globalInstructionsPath = (stateDir: string) =>
  NodePath.join(stateDir, GLOBAL_INSTRUCTIONS_FILE);

const PRECEDENCE =
  "These are the user's own instructions for every session. Instructions closer to the work (a repository's or Project's AGENTS.md, MEMORY.md, role files) take precedence where they conflict.";

export function globalInstructionsApply(
  scopes: GlobalInstructionsScopes,
  scope: GlobalInstructionsScope,
): boolean {
  if (scope === "coordinator") return scopes.coordinators;
  if (scope === "agent") return scopes.projectAgents;
  return scopes.tasks;
}

/** Null when the file is empty or the session's scope is off, so prompts stay unchanged. */
export function buildGlobalInstructionsBlock(
  source: GlobalInstructionsSource | undefined,
  scope: GlobalInstructionsScope,
): GlobalInstructionsBlock | null {
  if (!source || !globalInstructionsApply(source.scopes, scope)) return null;
  const text = source.text.trim();
  if (!text) return null;
  const open = `<global_instructions file="${escapeAttribute(source.path)}">`;
  const close = "</global_instructions>";
  return {
    inline: [open, PRECEDENCE, capChars(text, source.path), close].join("\n"),
    pointer: [open, `Read \`${source.path}\` before acting. ${PRECEDENCE}`, close].join("\n"),
  };
}

/** Cuts at `GLOBAL_INSTRUCTIONS_CAP_CHARS` (UTF-16 units, as the editor counts), never inside a pair. */
export function capChars(text: string, path: string): string {
  if (text.length <= GLOBAL_INSTRUCTIONS_CAP_CHARS) return text;
  let cut = GLOBAL_INSTRUCTIONS_CAP_CHARS;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}\n[truncated: read ${path} for the rest]`;
}

/** The `server.globalInstructions` RPC: read or replace the file. */
export const manageGlobalInstructions = Effect.fnUntraced(function* (
  stateDir: string,
  input: GlobalInstructionsInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = globalInstructionsPath(stateDir);
  const fail = (action: string) => (cause: { readonly message: string }) =>
    new GlobalInstructionsError({ detail: `Could not ${action} ${path}: ${cause.message}` });
  if (input.action === "write") {
    yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.mapError(fail("write")));
    yield* fs.writeFileString(path, input.text).pipe(Effect.mapError(fail("write")));
  }
  const exists = yield* fs.exists(path).pipe(Effect.mapError(fail("read")));
  const text = exists ? yield* fs.readFileString(path).pipe(Effect.mapError(fail("read"))) : "";
  return { path, text, capChars: GLOBAL_INSTRUCTIONS_CAP_CHARS } satisfies GlobalInstructionsResult;
});

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
