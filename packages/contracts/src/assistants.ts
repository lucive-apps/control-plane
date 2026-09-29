import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
