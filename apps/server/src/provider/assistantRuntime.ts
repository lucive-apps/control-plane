// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  assistantSlug,
  isStandingAgent,
  type ProjectAssistant,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AGENT_RUNNING_CAP, capUtf8 } from "../orchestration/agentProtocol.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildGlobalInstructionsBlock,
  type GlobalInstructionsScope,
  type GlobalInstructionsSource,
} from "./globalInstructions.ts";

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
/** Coordinator only: the schedule tools refuse every other caller. */
const SCHEDULE_RULE =
  "Create or edit schedules with cp_schedule_* only when the user asks; they stay paused until the user turns them on.";

/** Coordinator only: cp_agent_settle refuses every other caller. */
const COORDINATOR_SETTLE_RULE =
  "Settle agents with cp_agent_settle once their work is complete (for example, merged) and no follow-ups remain. Reporting a result does not settle an agent. It fails while an agent is working; a settled agent wakes on a new message.";

const COORDINATOR_BROWSER_RULE =
  "Every delegation message must tell the agent to use its own built-in Control Plane browser (preview_* tools) for all browsing, including logged-in sites, and never the user's desktop browsers. Only when the user explicitly asks for an agent to use their own browser or computer, say so in the delegation message and quote the user's request. Never grant it on your own. Each coordinator and agent has its own browser tabs; do not send browser work to another coordinator or reuse another thread's browser.";

const AGENT_BROWSER_RULE =
  "Always use your own thread's built-in Control Plane browser via the preview_* tools for all browsing, testing and screenshots, including logged-in sites. Load the tools if they are not loaded yet, then call preview_status or preview_open (without tabId) before preview_navigate, preview_snapshot and the other preview_* tools. Never open or drive the user's desktop browsers: never run `open <url>`, never AppleScript a browser, never use computer-use tools for one. Exception: if the user explicitly tells you to use their own browser or computer (for example 'use my Helium' or 'use my computer'), you may do so for that request. A coordinator relaying the user's explicit instruction counts. Never decide on your own that you need the user's browser. Logins persist in the built-in browser profile. If a site needs a login you don't have, stop and ask the user to sign in once in the Control Plane browser panel (or import from their browser with the browser's import option), then continue. If preview_open reports no automation host, report the tool error; switching to another thread's browser does not repair the host connection.";

/** Agent side: a turn that ends reports to the coordinator, so it must not end as a wait. */
const AGENT_TURN_RULE =
  "Never end your turn just to wait for a command, test run, or sub-agent. Run it in the foreground or keep polling until it finishes. Your turn ending is what reports back to the coordinator, so end only with your final report or a question for the user.";

/** Standing agents only: their own agents are the one thing a turn may end to wait on. */
const STANDING_DELEGATION_EXCEPTION =
  "The exception is agents you start with cp_agent_create: end your turn after starting them, and their results arrive as messages.";

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
  /**
   * Grants the `agents` MCP capability: coordinators and standing agents.
   * Always set by the builder; absent reads as false.
   */
  readonly agents?: boolean;
}

type AssistantRole =
  | { readonly kind: "coordinator" }
  | {
      readonly kind: "agent";
      readonly standing: boolean;
      /** Names a standing agent's `<slug>/AGENTS.md`; null for one-off agents and empty slugs. */
      readonly slug: string | null;
      readonly coordinatorThreadId: ThreadId;
    };

function resolveAssistantRole({ project, thread }: AssistantRuntimeTarget): AssistantRole | null {
  const assistant = project?.assistant;
  if (!project || !thread || assistant == null) return null;
  if (assistant.coordinatorThreadId === thread.id) return { kind: "coordinator" };
  const standing = isStandingAgent(project, thread);
  const slug = standing ? assistantSlug(thread.title) : "";
  return {
    kind: "agent",
    standing,
    slug: slug || null,
    coordinatorThreadId: assistant.coordinatorThreadId,
  };
}

/** Which global-instructions toggle governs the thread: threads outside a Project are Tasks. */
export function globalInstructionsScopeOf(input: AssistantRuntimeTarget): GlobalInstructionsScope {
  const role = resolveAssistantRole(input);
  if (!role) return "tasks";
  return role.kind === "coordinator" ? "coordinator" : "agent";
}

/**
 * Puts the global instructions ahead of the Project block, so the Project's
 * own files come later and win. A Tasks thread gets a block of its own under
 * the "none" key, so it never looks like a role change.
 */
export function withGlobalInstructions(
  block: AssistantRuntimeBlock | null,
  global: GlobalInstructionsSource | undefined,
  scope: GlobalInstructionsScope,
): AssistantRuntimeBlock | null {
  const prefix = buildGlobalInstructionsBlock(global, scope);
  if (!prefix) return block;
  if (!block)
    return { roleKey: "none", inline: prefix.inline, pointer: prefix.pointer, agents: false };
  return {
    ...block,
    inline: `${prefix.inline}\n\n${block.inline}`,
    pointer: `${prefix.pointer}\n\n${block.pointer}`,
  };
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
 * their own, so first-turn auto-titling does not restart every new agent. A
 * standing agent's key has its slug, which names its role file, and the
 * coordinator's id, which its text names. Standing and one-off keys always
 * differ, even without a slug, so Pin and Unpin restart the session and
 * re-mint the `agents` capability.
 */
export function assistantRoleKey(input: AssistantRuntimeTarget): string {
  const role = resolveAssistantRole(input);
  const project = input.project;
  if (!role || !project) return "none";
  const base = `${project.id}:${project.title}`;
  if (role.kind === "coordinator") {
    return `coordinator:${base}:${fileEpoch(project.workspaceRoot, MEMORY_FILE)}`;
  }
  if (!role.standing) return `agent:${base}:one-off`;
  const standing = `agent:${base}:standing:${role.coordinatorThreadId}`;
  if (role.slug === null) return `${standing}:-:-`;
  return `${standing}:${role.slug}:${fileEpoch(project.workspaceRoot, roleFileOf(role.slug))}`;
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
    const roleFilePattern = NodePath.join(folder, "<slug>", ROLE_FILE);
    const inline = [
      open,
      "You coordinate this Control Plane Project. The other threads in its folder are its agents.",
      `Your memory is ${memoryPath}. Keep it current. The copy below was read when this session started, and the user may have changed the file since, so re-read it from disk before relying on it and edit it in place. Never silently rewrite rules the user wrote.`,
      `The root ${ROLE_FILE} is shared by you and every agent. Coordinator-only routing and user preferences go in ${MEMORY_FILE}.`,
      "Do not reply to acknowledgements.",
      `Delegate work to agents with cp_agent_create. An agent is one-off by default and stays available for follow-ups after it reports. Pass standing: true only for a role you will reuse, and first write its role to \`${roleFilePattern}\` (slug: its title in lowercase with dashes).`,
      "When an agent you started or messaged finishes, its final message arrives here as a message from it, including any question it has for the user. Nothing polls: after delegating, end your turn. Relay an agent's question to the user, then send the answer with cp_thread_send and the agent's threadId.",
      `At most ${AGENT_RUNNING_CAP} agents run at once in this Project. Use cp_agent_list, cp_agent_read and cp_agent_stop to check on them or stop them. A message to a busy agent waits until its turn ends; stop it first to redirect it. Pass threadId to cp_thread_send, since titles can match threads outside this Project.`,
      COORDINATOR_SETTLE_RULE,
      AGENT_BROWSER_RULE,
      COORDINATOR_BROWSER_RULE,
      SCHEDULE_RULE,
      input.memory.trim()
        ? `<memory>\n${capInline(input.memory, memoryPath)}\n</memory>`
        : `<memory>(${MEMORY_FILE} is empty)</memory>`,
      close,
    ].join("\n");
    const pointer = [
      open,
      `You coordinate the Control Plane Project ${name}. The other threads in its folder are its agents.`,
      `Read \`${memoryPath}\` before acting and keep it current.`,
      "Delegate with cp_agent_create; results arrive as messages, so end your turn after delegating.",
      `Before passing standing: true, write the agent's role to \`${roleFilePattern}\` (slug: its title in lowercase with dashes).`,
      "Do not reply to acknowledgements. When you message an agent with cp_thread_send, pass the threadId its result returns on later sends.",
      COORDINATOR_SETTLE_RULE,
      AGENT_BROWSER_RULE,
      COORDINATOR_BROWSER_RULE,
      SCHEDULE_RULE,
      close,
    ].join("\n");
    return { roleKey, inline, pointer, agents: true };
  }

  const endTurn = "End your turn with your result, or with your question when you need the user.";
  const opening = role.standing
    ? `You are a standing agent in the Control Plane Project ${name}. ${endTurn}`
    : `You are an agent in the Control Plane Project ${name}. ${endTurn}`;
  const oneOffGuidance =
    "When another thread asked for the work, your final message goes back to it automatically, so do not also send it with cp_thread_send.";
  // By id: an agent can share the coordinator's title (the Project's name).
  const sendCombined = `send the combined result to the coordinator (threadId ${role.coordinatorThreadId}) with cp_thread_send.`;
  const guidance = role.standing
    ? `You may start one-off agents with cp_agent_create (never standing ones); their final messages come back to you, and you count toward the Project's limit of ${AGENT_RUNNING_CAP} running agents. Your final message reaches the coordinator automatically only for turns it asked for. After your agents report back, ${sendCombined}`
    : oneOffGuidance;
  // A missing or empty role file is left out; saving it later restarts the agent.
  const rolePath =
    role.slug !== null && input.roleFile.trim()
      ? NodePath.join(folder, role.slug, ROLE_FILE)
      : null;
  const inline = [
    open,
    opening,
    guidance,
    AGENT_TURN_RULE,
    ...(role.standing ? [STANDING_DELEGATION_EXCEPTION] : []),
    AGENT_BROWSER_RULE,
    ...(rolePath
      ? [
          `<role file="${escapeAttribute(rolePath)}">\n${capInline(input.roleFile, rolePath)}\n</role>`,
        ]
      : []),
    close,
  ].join("\n");
  const pointer = [
    open,
    opening,
    // Each role keeps its delivery rule: a one-off agent's own send would arrive
    // twice, and a standing agent's combined result would never arrive.
    role.standing
      ? `You may start one-off agents with cp_agent_create; you count toward the Project's ${AGENT_RUNNING_CAP} running agents. Only turns the coordinator asked for report back automatically; after your agents report, ${sendCombined}`
      : oneOffGuidance,
    AGENT_TURN_RULE,
    ...(role.standing ? [STANDING_DELEGATION_EXCEPTION] : []),
    AGENT_BROWSER_RULE,
    ...(rolePath ? [`Your role file: \`${rolePath}\``] : []),
    close,
  ].join("\n");
  return { roleKey, inline, pointer, agents: role.standing };
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
  /** The user's global instructions; omitted or empty leaves the block unchanged. */
  readonly global?: GlobalInstructionsSource | undefined;
}) =>
  Effect.gen(function* () {
    const thread = Option.getOrUndefined(
      yield* input.projection.getThreadShellById(input.threadId),
    );
    if (!thread) return null;
    const project = Option.getOrUndefined(
      yield* input.projection.getProjectShellById(thread.projectId),
    );
    const block = yield* loadAssistantRuntimeBlock({ project, thread, readFile: input.readFile });
    return withGlobalInstructions(
      block,
      input.global,
      globalInstructionsScopeOf({ project, thread }),
    );
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
  return capUtf8(
    text.trimEnd(),
    ASSISTANT_INLINE_CAP_BYTES,
    `\n[truncated: read ${path} for the rest]`,
  );
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
