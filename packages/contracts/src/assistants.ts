import * as Schema from "effect/Schema";

import { IsoDateTime, type ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. Imports only baseSchemas so orchestration.ts can import this
// module without a cycle.

/**
 * Marks a workspace project as a Project (the UI term): a named coordinator
 * thread plus every other thread in the folder as its agents. Absent or null
 * means a plain workspace.
 */
export const ProjectAssistant = Schema.Struct({
  coordinatorThreadId: ThreadId,
  /** The current coordinator's title from before it was promoted, restored if it is replaced. */
  formerTitle: Schema.optional(TrimmedNonEmptyString),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type ProjectAssistant = typeof ProjectAssistant.Type;

/** `project.meta.update` input. The server resolves it into a full `ProjectAssistant`. */
export const ProjectAssistantPatch = Schema.Struct({
  coordinatorThreadId: Schema.optional(ThreadId),
  /** The server stamps `archivedAt`. */
  archived: Schema.optional(Schema.Boolean),
});
export type ProjectAssistantPatch = typeof ProjectAssistantPatch.Type;

export type AssistantThreadRole = "coordinator" | "agent";

interface AssistantProjectLike {
  readonly assistant?: ProjectAssistant | null | undefined;
}

interface AssistantThreadLike {
  readonly id: ThreadId;
  readonly pinnedAt?: string | null | undefined;
}

/** Role of a thread that belongs to `project`, or null for a plain workspace. */
export function assistantThreadRole(
  project: AssistantProjectLike | null | undefined,
  threadId: ThreadId | null | undefined,
): AssistantThreadRole | null {
  const assistant = project?.assistant;
  if (assistant == null || threadId == null) return null;
  return assistant.coordinatorThreadId === threadId ? "coordinator" : "agent";
}

export function isArchivedAssistant(project: AssistantProjectLike | null | undefined): boolean {
  return project?.assistant?.archivedAt != null;
}

/** A pinned agent: a reused role that never settles until it is unpinned. */
export function isStandingAgent(
  project: AssistantProjectLike | null | undefined,
  thread: AssistantThreadLike,
): boolean {
  const assistant = project?.assistant;
  return (
    assistant != null && assistant.coordinatorThreadId !== thread.id && thread.pinnedAt != null
  );
}

/** Coordinators and standing agents never settle, manually or automatically. */
export function isAssistantSettlementExempt(
  project: AssistantProjectLike | null | undefined,
  thread: AssistantThreadLike,
): boolean {
  return (
    assistantThreadRole(project, thread.id) === "coordinator" || isStandingAgent(project, thread)
  );
}

/** Counts toward "N running": live work, including work blocked on the user. */
export function isRunningAgent(thread: {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null;
}): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

/** Message id prefix of an agent's result appended into the thread that asked for it. */
export const AGENT_PUSH_MESSAGE_PREFIX = "cp-push:";

export function isAgentPushMessageId(id: string): boolean {
  return id.startsWith(AGENT_PUSH_MESSAGE_PREFIX);
}

export type AgentManagerRole = "coordinator" | "standing";

interface AgentManagerProjectLike extends AssistantProjectLike {
  readonly id: ProjectId;
}

interface AgentManagerThreadLike extends AssistantThreadLike {
  readonly projectId: ProjectId;
}

interface ManagedAgentLike extends AgentManagerThreadLike {
  readonly createdByThreadId?: ThreadId | null | undefined;
}

/**
 * Whether `thread` may start and manage agents in `project`: its coordinator,
 * or a standing agent. Null outside the Project and while it is archived.
 */
export function agentManagerRole(
  project: AgentManagerProjectLike,
  thread: AgentManagerThreadLike,
): AgentManagerRole | null {
  const assistant = project.assistant;
  if (assistant == null || assistant.archivedAt != null || thread.projectId !== project.id) {
    return null;
  }
  if (assistant.coordinatorThreadId === thread.id) return "coordinator";
  return isStandingAgent(project, thread) ? "standing" : null;
}

/**
 * The coordinator manages every other thread in its Project. A standing
 * agent manages only the one-off agents it created.
 */
export function canManageAgent(
  project: AgentManagerProjectLike,
  manager: AgentManagerThreadLike,
  agent: ManagedAgentLike,
): boolean {
  const role = agentManagerRole(project, manager);
  if (
    role === null ||
    agent.projectId !== project.id ||
    agent.id === manager.id ||
    agent.id === project.assistant?.coordinatorThreadId
  ) {
    return false;
  }
  return (
    role === "coordinator" || (agent.createdByThreadId === manager.id && agent.pinnedAt == null)
  );
}

/**
 * Kebab-case ASCII slug for a Project or agent title, used for folder and role
 * file names. Returns "" when nothing ASCII survives (CJK, emoji); callers
 * pick their own fallback.
 */
export function assistantSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
