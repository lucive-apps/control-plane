import { isArchivedAssistant, type EnvironmentId, type ProjectAssistant } from "@t3tools/contracts";

import type { ArchivedThreadSortOrder } from "./archivedThreadList";

// Fork-owned. Settings > Archived lists archived Projects above the
// per-workspace thread groups, filtered like the rest of the screen.

export interface ArchivedProjectRow<P> {
  readonly key: string;
  readonly title: string;
  readonly ageLabel: string;
  readonly project: P;
}

type ArchivedProjectInput = {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly assistant?: ProjectAssistant | null | undefined;
};

function archivedAtMs(project: ArchivedProjectInput): number {
  const timestamp = Date.parse(project.assistant?.archivedAt ?? "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/** Compact age in the list's idiom: "now" under a minute, then m, h, d. */
export function archivedAgeLabel(archivedAtMsValue: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - archivedAtMsValue) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The archived Projects among `projects`, filtered and sorted like the screen. */
export function selectArchivedProjectRows<P extends ArchivedProjectInput>(input: {
  readonly projects: readonly P[];
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly sortOrder?: ArchivedThreadSortOrder;
  readonly now: number;
}): ReadonlyArray<ArchivedProjectRow<P>> {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const direction = input.sortOrder === "oldest" ? 1 : -1;
  return (
    input.projects
      .filter(
        (project) =>
          isArchivedAssistant(project) &&
          (input.environmentId === null || project.environmentId === input.environmentId) &&
          (query.length === 0 ||
            project.title.toLocaleLowerCase().includes(query) ||
            project.workspaceRoot.toLocaleLowerCase().includes(query)),
      )
      // `filter` already copied the array, so sorting in place is safe.
      .sort(
        (left, right) =>
          direction * (archivedAtMs(left) - archivedAtMs(right)) ||
          left.title.localeCompare(right.title),
      )
      .map((project) => ({
        key: `${project.environmentId}:${project.id}`,
        title: project.title,
        ageLabel: archivedAgeLabel(archivedAtMs(project), input.now),
        project,
      }))
  );
}

/**
 * A Project's agents among the live thread shells: its unarchived threads
 * other than the coordinator, as `partitionAssistants` counts them. A number,
 * so a row selecting it re-renders only when the count changes.
 */
export function countProjectAgents(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly id: string;
    readonly archivedAt: string | null;
  }>,
  project: ArchivedProjectInput,
): number {
  const coordinatorThreadId = project.assistant?.coordinatorThreadId;
  let count = 0;
  for (const thread of threads) {
    if (
      thread.environmentId === project.environmentId &&
      thread.projectId === project.id &&
      thread.id !== coordinatorThreadId &&
      thread.archivedAt === null
    ) {
      count += 1;
    }
  }
  return count;
}
