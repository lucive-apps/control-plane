import {
  sectionAssistantAgents,
  type AssistantPartition,
} from "@t3tools/client-runtime/state/assistants";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { buildThreadListV2Items } from "../threads/threadListV2";
import { buildHomeProjectScopes } from "./homeThreadList";

// Fork-owned. The Settled screen's model: settled Project agents grouped by
// Project, then settled Tasks threads, the same set the Home Settled shelf held,
// grouped under their workspace folder.

export interface SettledProjectGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  /** Most recently settled first. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

/** Projects that hold settled agents, in the Home's Project order. Settled agents show nowhere else. */
export function buildSettledProjectGroups(input: {
  readonly assistants: AssistantPartition<EnvironmentProject, EnvironmentThreadShell>["assistants"];
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly now: string;
}): SettledProjectGroup[] {
  const groups: SettledProjectGroup[] = [];
  for (const entry of input.assistants) {
    const { environmentId, id } = entry.project;
    const { settled } = sectionAssistantAgents(entry.agents, {
      now: input.now,
      supportsSnooze: input.snoozeEnvironmentIds?.has(environmentId) ?? true,
      supportsSettlement: input.settlementEnvironmentIds?.has(environmentId) ?? true,
    });
    if (settled.length === 0) continue;
    groups.push({
      key: `project:${scopedProjectKey(environmentId, id)}`,
      project: entry.project,
      threads: settled,
    });
  }
  return groups;
}

export interface SettledWorkspaceGroup {
  readonly key: string;
  readonly title: string;
  /** Most recently settled first. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

/** Groups follow their most recently settled thread, newest first. */
export function buildSettledWorkspaceGroups(input: {
  /** Workspace (Tasks) projects and threads; Project agents keep their own settled rows. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly now: string;
}): SettledWorkspaceGroup[] {
  const layout = buildThreadListV2Items({
    threads: input.threads.filter((thread) => thread.archivedAt === null),
    environmentId: null,
    searchQuery: "",
    ...(input.settlementEnvironmentIds
      ? { settlementEnvironmentIds: input.settlementEnvironmentIds }
      : {}),
    now: input.now,
    settledShelfExpanded: true,
  });
  if (layout.settledShelfHeaderIndex === null) return [];

  const scopeByProjectKey = new Map<string, { key: string; title: string }>();
  for (const scope of buildHomeProjectScopes({
    projects: input.projects,
    environmentId: null,
    projectGroupingMode: input.projectGroupingMode,
  })) {
    for (const ref of scope.projectRefs) {
      scopeByProjectKey.set(scopedProjectKey(ref.environmentId, ref.projectId), scope);
    }
  }
  const groups = new Map<
    string,
    { key: string; title: string; threads: EnvironmentThreadShell[] }
  >();
  for (const item of layout.items.slice(layout.settledShelfHeaderIndex)) {
    const projectKey = scopedProjectKey(item.thread.environmentId, item.thread.projectId);
    const scope = scopeByProjectKey.get(projectKey) ?? {
      key: `unknown:${projectKey}`,
      title: "Unknown workspace",
    };
    const group = groups.get(scope.key) ?? { key: scope.key, title: scope.title, threads: [] };
    group.threads.push(item.thread);
    groups.set(scope.key, group);
  }
  return [...groups.values()];
}
