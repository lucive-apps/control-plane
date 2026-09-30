import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { minProjectOrderKey } from "@t3tools/client-runtime/state/project-order";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  getThreadSortTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

/**
 * `manual` lists arranged folders first in their synced order (the desktop drag order), then
 * the rest by activity. Pickers that want plain activity order pass `updated_at`.
 */
export type HomeProjectSortOrder = SidebarProjectSortOrder;

type HomeActivitySortOrder = Exclude<HomeProjectSortOrder, "manual">;

export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

function getProjectSortTimestamp(
  project: EnvironmentProject,
  sortOrder: HomeActivitySortOrder,
): number {
  return sortOrder === "created_at"
    ? (toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY)
    : (toSortableTimestamp(project.updatedAt) ??
        toSortableTimestamp(project.createdAt) ??
        Number.NEGATIVE_INFINITY);
}

export function buildHomeProjectScopes(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}): ReadonlyArray<HomeProjectScope> {
  const projects = input.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  return buildProjectGroups({
    projects,
    settings: {
      sidebarProjectGroupingMode: input.projectGroupingMode,
      sidebarProjectGroupingOverrides: {},
    },
  }).map((group) => {
    return {
      key: group.key,
      title: group.label,
      representative: group.representative,
      projects: group.members.map((member) => member.project),
      projectRefs: group.memberProjectRefs,
    };
  });
}

export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly projectSortOrder: HomeProjectSortOrder;
}): ReadonlyArray<HomeProjectScope> {
  const scopeKeyByProjectRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.key] as const,
      ),
    ),
  );
  // Activity still orders the folders nobody has arranged; `manual` falls back to updates.
  const activityOrder: HomeActivitySortOrder =
    input.projectSortOrder === "manual" ? "updated_at" : input.projectSortOrder;
  const latestActivityByScope = new Map<string, number>();
  const recordActivity = (scopeKey: string | undefined, timestamp: number) => {
    if (!scopeKey || !Number.isFinite(timestamp)) return;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, timestamp),
    );
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      getThreadSortTimestamp(thread, activityOrder),
    );
  }
  for (const pendingTask of input.pendingTasks) {
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(pendingTask.environmentId, pendingTask.projectId)),
      Date.parse(pendingTask.createdAt),
    );
  }

  const arrangedKeyByScope = new Map<string, string>();
  if (input.projectSortOrder === "manual") {
    for (const scope of input.scopes) {
      // A folder holds one project per environment; it sits at its lowest key.
      const key = minProjectOrderKey(scope.projects.map((project) => project.orderKey));
      if (key !== null) arrangedKeyByScope.set(scope.key, key);
    }
  }

  return Arr.sort(
    input.scopes,
    Order.mapInput(
      Order.Struct({
        // "0" + key sorts every arranged folder ahead of "1" (no key), then by key.
        arranged: Order.String,
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (scope: HomeProjectScope) => ({
        arranged: arrangedKeyByScope.has(scope.key) ? `0${arrangedKeyByScope.get(scope.key)}` : "1",
        timestamp:
          latestActivityByScope.get(scope.key) ??
          Math.max(
            ...scope.projects.map((project) => getProjectSortTimestamp(project, activityOrder)),
          ),
        title: scope.title,
        key: scope.key,
      }),
    ),
  );
}
