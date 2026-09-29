import {
  assistantSlug,
  isArchivedAssistant,
  isRunningAgent,
  type EnvironmentId,
  type ProjectAssistant,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import { derivePhysicalProjectKey } from "./projectGrouping.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./threadSettled.ts";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortThreads,
  toSortableTimestamp,
  type SettledThreadTimestampInput,
  type ThreadSortInput,
} from "./threadSort.ts";
import { rollupSidebarThreadStatus, type SidebarThreadStatus } from "./threadStatus.ts";

// Fork-owned. Pure helpers behind the Projects UI (the `assistant` marker on a
// workspace project). Hermes-safe: no toSorted/toSpliced, sort copies instead.

export interface AssistantProjectInput {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly assistant?: ProjectAssistant | null | undefined;
}

export interface AssistantThreadInput {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
}

export interface AssistantEntry<P, T> {
  readonly project: P;
  /**
   * The settings and sidebar group key. Projects never join repository
   * groups, so this is always the project's physical key.
   */
  readonly projectKey: string;
  /** Null until the coordinator's shell reaches this client. */
  readonly coordinator: T | null;
  /** Unarchived threads in the Project folder other than the coordinator. */
  readonly agents: readonly T[];
}

export interface AssistantPartition<P, T> {
  /** Unarchived Projects, primary environment first, then by title. */
  readonly assistants: readonly AssistantEntry<P, T>[];
  readonly archivedAssistants: readonly AssistantEntry<P, T>[];
  readonly workspaceProjects: readonly P[];
  /** Threads outside every Project, archived Projects included. */
  readonly workspaceThreads: readonly T[];
}

const EMPTY_ENTRIES: readonly never[] = Object.freeze([]);

/** Plain workspaces only. Returns the input array itself when it holds no Project. */
export function selectWorkspaceProjects<
  P extends { readonly assistant?: ProjectAssistant | null | undefined },
>(projects: readonly P[]): readonly P[] {
  return projects.some((project) => project.assistant != null)
    ? projects.filter((project) => project.assistant == null)
    : projects;
}

/**
 * Splits the shell into Projects and plain workspaces. Threads of a Project,
 * archived or not, never reach `workspaceThreads`, so they cannot land in a
 * Tasks folder or the global lists.
 */
export function partitionAssistants<
  P extends AssistantProjectInput,
  T extends AssistantThreadInput,
>(
  projects: readonly P[],
  threads: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
): AssistantPartition<P, T> {
  const workspaceProjects = selectWorkspaceProjects(projects);
  if (workspaceProjects === projects) {
    return {
      assistants: EMPTY_ENTRIES,
      archivedAssistants: EMPTY_ENTRIES,
      workspaceProjects: projects,
      workspaceThreads: threads,
    };
  }

  const draftByProject = new Map<
    string,
    { project: P; coordinatorThreadId: ThreadId; coordinator: T | null; agents: T[] }
  >();
  for (const project of projects) {
    if (project.assistant == null) continue;
    draftByProject.set(`${project.environmentId}:${project.id}`, {
      project,
      coordinatorThreadId: project.assistant.coordinatorThreadId,
      coordinator: null,
      agents: [],
    });
  }

  const workspaceThreads: T[] = [];
  for (const thread of threads) {
    const draft = draftByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (draft === undefined) {
      workspaceThreads.push(thread);
    } else if (thread.id === draft.coordinatorThreadId) {
      draft.coordinator = thread;
    } else if (thread.archivedAt === null) {
      draft.agents.push(thread);
    }
  }

  const assistants: AssistantEntry<P, T>[] = [];
  const archivedAssistants: AssistantEntry<P, T>[] = [];
  for (const draft of draftByProject.values()) {
    const entry: AssistantEntry<P, T> = {
      project: draft.project,
      projectKey: derivePhysicalProjectKey(draft.project),
      coordinator: draft.coordinator,
      agents: draft.agents,
    };
    (isArchivedAssistant(draft.project) ? archivedAssistants : assistants).push(entry);
  }
  const compare = (left: AssistantEntry<P, T>, right: AssistantEntry<P, T>) => {
    const leftPrimary = left.project.environmentId === primaryEnvironmentId ? 0 : 1;
    const rightPrimary = right.project.environmentId === primaryEnvironmentId ? 0 : 1;
    return (
      leftPrimary - rightPrimary ||
      left.project.title.localeCompare(right.project.title) ||
      left.project.environmentId.localeCompare(right.project.environmentId) ||
      left.project.id.localeCompare(right.project.id)
    );
  };
  assistants.sort(compare);
  archivedAssistants.sort(compare);

  return { assistants, archivedAssistants, workspaceProjects, workspaceThreads };
}

export type AssistantAgentSectionInput = ThreadSnoozeShell &
  SettledThreadTimestampInput & {
    readonly id: string;
    readonly environmentId?: string | undefined;
    readonly createdAt: string;
    readonly settledOverride: "settled" | "active" | null;
    readonly pinnedAt?: string | null | undefined;
    readonly pinOrderKey?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly unsettledAt?: string | null | undefined;
  };

export interface AssistantAgentSections<T> {
  /** Pinned agents: reused roles that never settle until unpinned. */
  readonly standing: readonly T[];
  readonly active: readonly T[];
  /** Soonest wake first. */
  readonly snoozed: readonly T[];
  /** Most recently settled first. */
  readonly settled: readonly T[];
}

/**
 * Sections a Project's agents the way the sidebar sections threads:
 * snoozed outranks settled, which outranks pinned. The capability flags
 * belong to the Project's environment.
 */
export function sectionAssistantAgents<T extends AssistantAgentSectionInput>(
  agents: readonly T[],
  options: {
    readonly now: string;
    readonly supportsSnooze: boolean;
    readonly supportsSettlement: boolean;
  },
): AssistantAgentSections<T> {
  const standing: T[] = [];
  const active: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];
  for (const agent of agents) {
    if (options.supportsSnooze && effectiveSnoozed(agent, { now: options.now })) {
      snoozed.push(agent);
    } else if (options.supportsSettlement && agent.settledOverride === "settled") {
      settled.push(agent);
    } else if (agent.pinnedAt != null) {
      standing.push(agent);
    } else {
      active.push(agent);
    }
  }
  const wakeMs = (agent: T) => toSortableTimestamp(agent.snoozedUntil ?? undefined) ?? 0;
  const settledMs = (agent: T) =>
    toSortableTimestamp(resolveSettledThreadTimestamp(agent) ?? undefined) ?? 0;
  return {
    standing: sortPinnedThreadsByOrderKey(standing),
    active: sortActiveThreadsByOrderKey(active),
    snoozed: snoozed.sort(
      (left, right) => wakeMs(left) - wakeMs(right) || left.id.localeCompare(right.id),
    ),
    settled: settled.sort(
      (left, right) => settledMs(right) - settledMs(left) || left.id.localeCompare(right.id),
    ),
  };
}

/** "N running": agents with live work, including work blocked on the user. */
export function countRunningAgents(
  agents: readonly Parameters<typeof isRunningAgent>[0][],
): number {
  let count = 0;
  for (const agent of agents) {
    if (isRunningAgent(agent)) count += 1;
  }
  return count;
}

/**
 * Whether an unread agent lights its Project's dot. False: a finished agent's
 * result now reaches the coordinator, so coordinator unread is the only unread
 * source. Agents' live statuses still roll up.
 */
export const ASSISTANT_ROLLUP_AGENT_UNREAD = false;

/** One static dot for a Project: the most urgent live status, else unread. */
export function rollupAssistantStatus(input: {
  readonly statuses: Iterable<SidebarThreadStatus>;
  readonly coordinatorUnread: boolean;
  readonly agentsUnread: boolean;
}): SidebarThreadStatus | "unread" | null {
  const status = rollupSidebarThreadStatus(input.statuses);
  if (status !== null && status !== "ready") return status;
  return input.coordinatorUnread || (ASSISTANT_ROLLUP_AGENT_UNREAD && input.agentsUnread)
    ? "unread"
    : null;
}

export interface AssistantScaffoldFile {
  readonly relativePath: string;
  readonly contents: string;
}

const MEMORY_TEMPLATE = `# Memory

Facts, preferences and routing notes for this Project's coordinator. The coordinator keeps this file current, and you can edit it too.
`;

/**
 * The Project files a folder is missing. Existing files are never replaced;
 * names compare case-insensitively because the default macOS and Windows
 * filesystems do.
 */
export function planAssistantScaffold(input: {
  readonly existingNames: readonly string[];
  readonly instructions: string;
}): AssistantScaffoldFile[] {
  const existing = new Set(input.existingNames.map((name) => name.toLowerCase()));
  const instructions = input.instructions.trim();
  const files: AssistantScaffoldFile[] = [
    {
      relativePath: "AGENTS.md",
      contents: instructions.length > 0 ? `${instructions}\n` : "# Shared instructions\n",
    },
    { relativePath: "CLAUDE.md", contents: "@AGENTS.md\n" },
    { relativePath: "MEMORY.md", contents: MEMORY_TEMPLATE },
  ];
  return files.filter((file) => !existing.has(file.relativePath.toLowerCase()));
}

/**
 * The New Project folder: the name's slug (or "project" when nothing ASCII
 * survives) under the absolute `parentPath`, suffixed `-2`, `-3`, ... past
 * names that already exist.
 */
export function defaultProjectFolder(input: {
  readonly parentPath: string;
  readonly existingNames: readonly string[];
  readonly name: string;
}): string {
  const base = assistantSlug(input.name) || "project";
  const taken = new Set(input.existingNames.map((name) => name.toLowerCase()));
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  const separator = input.parentPath.includes("\\") && !input.parentPath.includes("/") ? "\\" : "/";
  return `${input.parentPath.replace(/[\\/]+$/, "")}${separator}${candidate}`;
}

/** Convert's "N threads become agents (M pinned stay standing)". */
export function convertSummary(
  threads: readonly {
    readonly id: ThreadId;
    readonly archivedAt: string | null;
    readonly pinnedAt?: string | null | undefined;
  }[],
  coordinatorThreadId: ThreadId | null,
): { readonly agents: number; readonly standing: number } {
  let agents = 0;
  let standing = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.id === coordinatorThreadId) continue;
    agents += 1;
    if (thread.pinnedAt != null) standing += 1;
  }
  return { agents, standing };
}

/**
 * Threads that may become a coordinator: live and Local. A worktree thread
 * would edit a different MEMORY.md than the one the server loads.
 */
export function localCoordinatorCandidates<
  T extends ThreadSortInput & {
    readonly id: string;
    readonly archivedAt: string | null;
    readonly worktreePath: string | null;
  },
>(threads: readonly T[]): T[] {
  return sortThreads(
    threads.filter((thread) => thread.archivedAt === null && thread.worktreePath === null),
    "updated_at",
  );
}
