// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  assistantSlug,
  assistantThreadRole,
  isStandingAgent,
  type ProjectAssistant,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

// Fork-owned. The role block a Project's coordinator and agents receive.
// ProviderService builds it once per session start and stores it here, and
// every adapter reads it back through buildRuntimeInstructions, so the text
// stays identical (and cache-stable) for the life of the session. When the
// role or a tracked file changes, ProviderCommandReactor restarts the session
// at its next turn, which rebuilds the block.

const MEMORY_FILE = "MEMORY.md";
const ROLE_FILE = "AGENTS.md";
/** Inline cap for MEMORY.md and role files; the rest stays on disk. */
export const ASSISTANT_INLINE_CAP_BYTES = 16_384;

interface AssistantRuntimeProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly assistant?: ProjectAssistant | null | undefined;
}

interface AssistantRuntimeThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly pinnedAt?: string | null | undefined;
}

interface AssistantRuntimeTarget {
  readonly project: AssistantRuntimeProject | null | undefined;
  readonly thread: AssistantRuntimeThread | null | undefined;
}

export interface AssistantRuntimeBlock {
  /** Session identity: a session restarts when its stored key no longer matches. */
  readonly roleKey: string;
  /** System or developer text, for Claude, Codex and OpenCode. */
  readonly inline: string;
  /** A short pointer to the files, for Cursor, Grok and Antigravity, which resend it every prompt. */
  readonly pointer: string;
}

type AssistantRole =
  | { readonly kind: "coordinator" }
  /** `slug` names a standing agent's `<slug>/AGENTS.md`; null for one-off agents and empty slugs. */
  | { readonly kind: "agent"; readonly slug: string | null };

function resolveAssistantRole({ project, thread }: AssistantRuntimeTarget): AssistantRole | null {
  if (!project || !thread) return null;
  const role = assistantThreadRole(project, thread.id);
  if (role === null) return null;
  if (role === "coordinator") return { kind: "coordinator" };
  const slug = isStandingAgent(project, thread) ? assistantSlug(thread.title) : "";
  return { kind: "agent", slug: slug || null };
}

const roleFileOf = (slug: string) => `${slug}/${ROLE_FILE}`;

const blocksByThread = new Map<ThreadId, AssistantRuntimeBlock>();
const fileEpochs = new Map<string, number>();

export function setAssistantRuntime(threadId: ThreadId, block: AssistantRuntimeBlock): void {
  blocksByThread.set(threadId, block);
}

export function readAssistantRuntime(threadId: ThreadId): AssistantRuntimeBlock | undefined {
  return blocksByThread.get(threadId);
}

export function clearAssistantRuntime(threadId: ThreadId): void {
  blocksByThread.delete(threadId);
}

function fileEpochKey(root: string, relativePath: string): string {
  return `${NodePath.resolve(root)}\0${relativePath.replaceAll("\\", "/")}`;
}

/** Only files that feed a role block are tracked, so the map stays small. */
function isTrackedRoleFile(relativePath: string): boolean {
  return relativePath === MEMORY_FILE || /^[^/]+\/AGENTS\.md$/.test(relativePath);
}

/**
 * Records a `projects.writeFile` save. Only user saves through the RPC count:
 * a coordinator editing its own MEMORY.md with its tools already knows what it
 * wrote, so it keeps its session.
 */
export function noteProjectFileWritten(cwd: string, relativePath: string): void {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!isTrackedRoleFile(normalized)) return;
  const key = fileEpochKey(cwd, normalized);
  fileEpochs.set(key, (fileEpochs.get(key) ?? 0) + 1);
}

function fileEpoch(root: string, relativePath: string): number {
  return fileEpochs.get(fileEpochKey(root, relativePath)) ?? 0;
}

/**
 * Everything the block's text depends on. Agents use the Project title, never
 * their own, so first-turn auto-titling does not restart every new agent; a
 * standing agent's slug is in the key because it names its role file.
 */
export function assistantRoleKey(input: AssistantRuntimeTarget): string {
  const role = resolveAssistantRole(input);
  const project = input.project;
  if (!role || !project) return "none";
  const base = `${project.id}:${project.title}`;
  if (role.kind === "coordinator") {
    return `coordinator:${base}:${fileEpoch(project.workspaceRoot, MEMORY_FILE)}`;
  }
  if (role.slug === null) return `agent:${base}:-`;
  return `agent:${base}:${role.slug}:${fileEpoch(project.workspaceRoot, roleFileOf(role.slug))}`;
}

export function buildAssistantRuntimeBlock(
  input: AssistantRuntimeTarget & {
    /** MEMORY.md contents; "" when missing. Read only for the coordinator. */
    readonly memory: string;
    /** `<slug>/AGENTS.md` contents; "" when missing. Read only for standing agents. */
    readonly roleFile: string;
    /** Defaults to the current key. The loader passes the key it read before the files. */
    readonly roleKey?: string;
  },
): AssistantRuntimeBlock | null {
  const role = resolveAssistantRole(input);
  const project = input.project;
  if (!role || !project) return null;
  const roleKey = input.roleKey ?? assistantRoleKey(input);
  const name = toSingleLine(project.title);
  const folder = project.workspaceRoot;
  const open = `<control_plane_project role="${role.kind}" name="${escapeAttribute(name)}" folder="${escapeAttribute(folder)}">`;
  const close = "</control_plane_project>";

  if (role.kind === "coordinator") {
    const memoryPath = NodePath.join(folder, MEMORY_FILE);
    const inline = [
      open,
      "You coordinate this Control Plane Project. The other threads in its folder are its agents.",
      `Your memory is ${memoryPath}. Keep it current. The copy below was read when this session started, and the user may have changed the file since, so re-read it from disk before relying on it and edit it in place. Never silently rewrite rules the user wrote.`,
      `The root ${ROLE_FILE} is shared by you and every agent. Coordinator-only routing and user preferences go in ${MEMORY_FILE}.`,
      "Do not reply to acknowledgements.",
      "You may message an agent with cp_thread_send. Its result returns the agent's threadId. Pass that threadId on later sends, since titles can match threads outside this Project.",
      input.memory.trim()
        ? `<memory>\n${capInline(input.memory, memoryPath)}\n</memory>`
        : `<memory>(${MEMORY_FILE} is empty)</memory>`,
      close,
    ].join("\n");
    const pointer = [
      open,
      `You coordinate the Control Plane Project ${name}. The other threads in its folder are its agents.`,
      `Read \`${memoryPath}\` before acting and keep it current.`,
      "Do not reply to acknowledgements. When you message an agent with cp_thread_send, pass the threadId its result returns on later sends.",
      close,
    ].join("\n");
    return { roleKey, inline, pointer };
  }

  const roleSentence = `You are an agent in the Control Plane Project ${name}. When you need the user, end your turn with the question.`;
  // A missing or empty role file is left out; saving it later restarts the agent.
  const rolePath =
    role.slug !== null && input.roleFile.trim()
      ? NodePath.join(folder, role.slug, ROLE_FILE)
      : null;
  const inline = [
    open,
    roleSentence,
    ...(rolePath
      ? [
          `<role file="${escapeAttribute(rolePath)}">\n${capInline(input.roleFile, rolePath)}\n</role>`,
        ]
      : []),
    close,
  ].join("\n");
  const pointer = [
    open,
    roleSentence,
    ...(rolePath ? [`Your role file: \`${rolePath}\``] : []),
    close,
  ].join("\n");
  return { roleKey, inline, pointer };
}

/**
 * Builds the block for a session start. The key is read before the files, so
 * a save that lands mid-read leaves a stale key and restarts the session again
 * at its next turn, instead of pairing old text with the new epoch.
 */
export const loadAssistantRuntimeBlock = Effect.fnUntraced(function* (
  input: AssistantRuntimeTarget & {
    /** Reads an absolute path; a missing file succeeds with "". */
    readonly readFile: (absolutePath: string) => Effect.Effect<string>;
  },
) {
  const role = resolveAssistantRole(input);
  const project = input.project;
  if (!role || !project) return null;
  const roleKey = assistantRoleKey(input);
  const memory =
    role.kind === "coordinator"
      ? yield* input.readFile(NodePath.join(project.workspaceRoot, MEMORY_FILE))
      : "";
  const roleFile =
    role.kind === "agent" && role.slug !== null
      ? yield* input.readFile(NodePath.join(project.workspaceRoot, role.slug, ROLE_FILE))
      : "";
  return buildAssistantRuntimeBlock({ ...input, memory, roleFile, roleKey });
});

/**
 * Stores the thread's block for a session start, or clears it. ProviderService
 * runs this before every adapter start. A failed projection read starts the
 * session without a block; the next turn sees the key mismatch and retries.
 */
export const prepareAssistantRuntime = (input: {
  readonly threadId: ThreadId;
  readonly projection: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getProjectShellById"
  >;
  /** Reads an absolute path; a missing file succeeds with "". */
  readonly readFile: (absolutePath: string) => Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const thread = Option.getOrUndefined(
      yield* input.projection.getThreadShellById(input.threadId),
    );
    if (!thread) return null;
    const project = Option.getOrUndefined(
      yield* input.projection.getProjectShellById(thread.projectId),
    );
    return yield* loadAssistantRuntimeBlock({ project, thread, readFile: input.readFile });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not build the Project role block for this session.", {
        threadId: input.threadId,
        cause,
      }).pipe(Effect.as(null)),
    ),
    Effect.map((block) => {
      if (block) setAssistantRuntime(input.threadId, block);
      else clearAssistantRuntime(input.threadId);
    }),
  );

/** Absolute `path` in the marker: a worktree agent's cwd has its own copy of the file. */
function capInline(text: string, path: string): string {
  const trimmed = text.trimEnd();
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.length <= ASSISTANT_INLINE_CAP_BYTES) return trimmed;
  let cut = ASSISTANT_INLINE_CAP_BYTES;
  // Step back off UTF-8 continuation bytes (10xxxxxx) so no character is split.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return `${bytes.subarray(0, cut).toString("utf8")}\n[truncated: read ${path} for the rest]`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
