import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  type ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

// Fork-owned. Imports only baseSchemas so orchestration.ts can import this
// module without a cycle.

export const PROJECT_SCHEDULE_LIMIT = 20;
export const PROJECT_SCHEDULE_PROMPT_MAX = 2_000;
export const PROJECT_SCHEDULE_NAME_MAX = 80;

/** Scheduled prompts: `cp-schedule:<projectId>:<scheduleId>:<slotIso>` or `...:manual:<uuid>`. */
export const SCHEDULE_MESSAGE_PREFIX = "cp-schedule:";

export function isScheduleMessageId(id: string): boolean {
  return id.startsWith(SCHEDULE_MESSAGE_PREFIX);
}

export const ProjectScheduleId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/));
export type ProjectScheduleId = typeof ProjectScheduleId.Type;

/** `"coordinator"` follows the role; a thread id names a standing agent. */
export const ProjectScheduleTarget = Schema.Union([Schema.Literal("coordinator"), ThreadId]);
export type ProjectScheduleTarget = typeof ProjectScheduleTarget.Type;

/** Who last wrote a schedule: the user, or the agent thread that called a schedule tool. */
export const ProjectScheduleActor = Schema.Union([Schema.Literal("user"), ThreadId]);
export type ProjectScheduleActor = typeof ProjectScheduleActor.Type;

/** A prompt the host sends on a cadence. Its prompt lives in `schedulePrompts`. */
export const ProjectSchedule = Schema.Struct({
  id: ProjectScheduleId,
  name: TrimmedNonEmptyString,
  /** Five-field cron, read in the host's time zone. */
  cron: TrimmedNonEmptyString,
  target: ProjectScheduleTarget,
  enabled: Schema.Boolean,
  createdBy: ProjectScheduleActor,
  updatedBy: ProjectScheduleActor,
  /** Server-stamped arming time: slots before it never run. */
  updatedAt: IsoDateTime,
});
export type ProjectSchedule = typeof ProjectSchedule.Type;

export const ProjectScheduleMissReason = Schema.Literals([
  "late",
  "busy",
  "target-missing",
  "rejected",
  "not-running",
  "no-fire",
]);
export type ProjectScheduleMissReason = typeof ProjectScheduleMissReason.Type;

/** A schedule's last run. Written only by the server. */
export const ProjectScheduleRun = Schema.Struct({
  slot: IsoDateTime,
  at: IsoDateTime,
  trigger: Schema.Literals(["cron", "manual"]),
  outcome: Schema.Literals(["sent", "missed", "failed"]),
  /**
   * On `"sent"`, only `"busy"`: the run waited for its target. A reason from a
   * newer server reads as absent rather than failing the whole Project.
   */
  reason: ForwardCompatibleOptional(ProjectScheduleMissReason),
  threadId: Schema.optional(ThreadId),
  /** Set only on `"failed"`. */
  turnId: Schema.optional(TurnId),
});
export type ProjectScheduleRun = typeof ProjectScheduleRun.Type;

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
  schedules: Schema.optional(Schema.Array(ProjectSchedule)),
  /** Prompt per schedule id. Never on the shell; `schedules.status` returns them. */
  schedulePrompts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Last run per schedule id. */
  scheduleRuns: Schema.optional(Schema.Record(Schema.String, ProjectScheduleRun)),
});
export type ProjectAssistant = typeof ProjectAssistant.Type;

/** A client's schedule entry. The server stamps authorship and arming time. */
export const ProjectScheduleInput = Schema.Struct({
  id: ProjectScheduleId,
  name: TrimmedNonEmptyString,
  cron: TrimmedNonEmptyString,
  target: ProjectScheduleTarget,
  enabled: Schema.Boolean,
  /** Omitted keeps the stored prompt. Required for a new id. */
  prompt: Schema.optional(Schema.String),
  /**
   * The stored `updatedAt` this entry was read at, echoed back. Required for an
   * existing id and absent for a new one. The server refuses the whole write
   * when it does not match, so a list built from a stale read cannot turn on
   * or overwrite an entry an agent changed in the meantime.
   */
  updatedAt: Schema.optional(IsoDateTime),
});
export type ProjectScheduleInput = typeof ProjectScheduleInput.Type;

/** `project.meta.update` input. The server resolves it into a full `ProjectAssistant`. */
export const ProjectAssistantPatch = Schema.Struct({
  coordinatorThreadId: Schema.optional(ThreadId),
  /** The server stamps `archivedAt`. */
  archived: Schema.optional(Schema.Boolean),
  /** The whole list, like `scripts`. */
  schedules: Schema.optional(Schema.Array(ProjectScheduleInput)),
});
export type ProjectAssistantPatch = typeof ProjectAssistantPatch.Type;

/**
 * One agent write to one schedule. An agent can pause a schedule but never
 * turn one on, so `enabled` admits only `false`.
 */
export const ProjectScheduleAgentChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upsert"),
    id: ProjectScheduleId,
    name: Schema.optional(TrimmedNonEmptyString),
    prompt: Schema.optional(Schema.String),
    cron: Schema.optional(TrimmedNonEmptyString),
    target: Schema.optional(ProjectScheduleTarget),
    enabled: Schema.optional(Schema.Literal(false)),
  }),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    id: ProjectScheduleId,
  }),
]);
export type ProjectScheduleAgentChange = typeof ProjectScheduleAgentChange.Type;

/** The marker as the shell carries it: every field except the prompts. */
export function withoutSchedulePrompts<A extends { readonly schedulePrompts?: unknown }>(
  assistant: A,
): Omit<A, "schedulePrompts"> {
  const { schedulePrompts: _prompts, ...rest } = assistant;
  return rest;
}

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
