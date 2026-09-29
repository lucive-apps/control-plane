import {
  assistantExpansionKey,
  assistantSettledToggle,
  rollupAssistantsStatus,
  rollupThreadGroupStatus,
  visibleAssistantAgentRows,
  type SidebarRollupStatus,
} from "@t3tools/client-runtime/state/assistant-lists";
import {
  countRunningAgents,
  sectionAssistantAgents,
  type AssistantAgentSections,
  type AssistantPartition,
} from "@t3tools/client-runtime/state/assistants";
import { hasScheduleAttention } from "@t3tools/client-runtime/state/schedules";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { PendingThreadOrder } from "../threads/threadOrder";
import {
  buildThreadListV2Items,
  snoozeWakeLabel,
  threadMatchesListSearch,
  type ThreadListV2Item,
  type ThreadListV2PendingListItem,
  type ThreadListV2SettledShelfListItem,
  type ThreadListV2SnoozedShelfListItem,
} from "../threads/threadListV2";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
  type HomeProjectSortOrder,
} from "./homeThreadList";

// Fork-owned. The one model behind the phone Home list and the iPad sidebar:
// Projects (coordinators with their agents), then Tasks (workspace folders
// holding v2 rows), then the global Snoozed and Settled shelves.

/** Collapse keys of the two sections, stored beside folder keys in `collapsedProjectGroups`. */
export const HOME_PROJECTS_SECTION_KEY = "home-section:projects";
export const HOME_TASKS_SECTION_KEY = "home-section:tasks";

export type HomeSectionKind = "projects" | "tasks";

type AgentSectionRow = "pinned" | "active" | "snoozed" | "settled";

/** Where Move up/down puts a Tasks row: next to its folder neighbor in the same block. */
export interface FolderMoveDestination {
  readonly targetId: string;
  readonly placement: "before" | "after";
}

export interface HomeSectionHeaderItem {
  readonly type: "section";
  readonly key: string;
  readonly section: HomeSectionKind;
  readonly collapseKey: string;
  readonly collapsed: boolean;
  /** Search or a filter holds it open, so its toggle is inert. */
  readonly forcedOpen: boolean;
  /** Only computed while collapsed; an open section shows no dot. */
  readonly rollup: SidebarRollupStatus;
}

export interface HomeProjectsEmptyItem {
  readonly type: "projects-empty";
  readonly key: "projects-empty";
  /** The connected server predates Projects, so the row explains instead of offering New Project. */
  readonly unsupported: boolean;
}

export interface HomeTasksEmptyItem {
  readonly type: "tasks-empty";
  readonly key: "tasks-empty";
}

export interface HomeProjectItem {
  readonly type: "project";
  readonly key: string;
  readonly expansionKey: string;
  readonly project: EnvironmentProject;
  /** Null until the coordinator's shell reaches this client. */
  readonly coordinator: EnvironmentThreadShell | null;
  readonly expanded: boolean;
  /** Search holds it open, so its chevron is inert. */
  readonly forcedOpen: boolean;
  /** "N running", hidden at 0. Never counts the coordinator. */
  readonly running: number;
  readonly rollup: SidebarRollupStatus;
  /** The coordinator is the selected thread (iPad). */
  readonly selected: boolean;
}

export interface HomeNewAgentItem {
  readonly type: "new-agent";
  readonly key: string;
  readonly project: EnvironmentProject;
}

export interface HomeAgentItem {
  readonly type: "agent";
  readonly key: string;
  readonly item: ThreadListV2Item;
  /** Pinned agents are standing agents: pin glyph, no Settle. */
  readonly standing: boolean;
  readonly snoozeWakeLabelText: string | undefined;
}

export interface HomeAgentPendingItem {
  readonly type: "agent-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
}

export interface HomeAgentSettledToggleItem {
  readonly type: "agent-settled-toggle";
  readonly key: string;
  readonly expansionKey: string;
  readonly label: string;
  readonly nextSettledCount: number;
}

export interface HomeFolderItem {
  readonly type: "folder";
  readonly key: string;
  /** Collapse key in `collapsedProjectGroups`. */
  readonly collapseKey: string;
  readonly title: string;
  /** Favicon and icon source: the scope's representative project. */
  readonly project: EnvironmentProject;
  readonly collapsed: boolean;
  /** Search or the Workspace filter holds it open, so its toggle is inert. */
  readonly forcedOpen: boolean;
  /** Rows the folder holds: its active threads and unsent tasks. */
  readonly count: number;
  /** Only computed while collapsed. */
  readonly rollup: SidebarRollupStatus;
  /** Where the folder's "+" starts a thread; null for a folder rebuilt from queued-task metadata. */
  readonly newThreadTarget: EnvironmentProject | null;
  /** The checkouts grouped into the folder, for its long-press menu; empty for a rebuilt folder. */
  readonly members: ReadonlyArray<EnvironmentProject>;
  readonly isFirst: boolean;
}

export interface HomeTaskThreadItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  /** Folder-scoped Move up/down; null at the folder's edge and on shelf rows. */
  readonly moveUp: FolderMoveDestination | null;
  readonly moveDown: FolderMoveDestination | null;
}

export interface HomeShowMoreItem {
  readonly type: "v2-show-more";
  readonly key: "v2-show-more";
  readonly hiddenCount: number;
}

export type HomeSectionItem =
  | HomeSectionHeaderItem
  | HomeProjectsEmptyItem
  | HomeTasksEmptyItem
  | HomeProjectItem
  | HomeNewAgentItem
  | HomeAgentItem
  | HomeAgentPendingItem
  | HomeAgentSettledToggleItem
  | HomeFolderItem
  | HomeTaskThreadItem
  | ThreadListV2PendingListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem
  | HomeShowMoreItem;

export interface HomeSectionsInput {
  readonly partition: AssistantPartition<EnvironmentProject, EnvironmentThreadShell>;
  /** Every shell the partition came from. Pending moves are planned against the full section. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  /** Environment filter: applies to both sections. */
  readonly environmentId: EnvironmentId | null;
  /** Workspace filter (a scope key): shows one folder, forced open, and hides Projects. */
  readonly workspaceKey: string | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly projectSortOrder: HomeProjectSortOrder;
  /** Connected environments whose server advertises `assistants`. */
  readonly assistantsEnvironmentIds: ReadonlySet<EnvironmentId>;
  /** Connected environments whose loaded server config lacks `assistants`. */
  readonly assistantsUnsupportedEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Absent means no gating (tests), as in `buildThreadListV2Items`. */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly pendingOrder?: PendingThreadOrder | null;
  /** Second-precise clock for snooze and settle classification. */
  readonly now: string;
  /** Minute clock the snooze countdown labels format against. */
  readonly snoozeLabelNow?: string;
  /** Settled Tasks rows to render; the rest sit behind "Show more". */
  readonly settledLimit?: number;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  /** Collapsed section and folder keys. */
  readonly collapsedKeys: ReadonlySet<string>;
  readonly expandedAssistantKeys: ReadonlySet<string>;
  /** Settled agents paged in per Project, by expansion key. */
  readonly assistantSettledCounts: ReadonlyMap<string, number>;
  /** The thread open in the detail pane (iPad); null on the phone. */
  readonly selectedThreadKey: string | null;
  readonly lastVisitedAtById: Readonly<Record<string, string>>;
}

/** What must open so the selected thread is visible. */
export interface HomeSelectionReveal {
  readonly collapsedKeys: readonly string[];
  readonly assistantKey: string | null;
}

export interface HomeSections {
  readonly items: HomeSectionItem[];
  /** Hardware-keyboard jump order: the visible thread rows, top to bottom. */
  readonly jumpThreads: EnvironmentThreadShell[];
  readonly hiddenSettledCount: number;
  readonly nextSnoozeWakeAt: string | null;
  /** The folder a Workspace filter selects, for the composer's locked workspace. */
  readonly workspaceScope: HomeProjectScope | null;
  /** Null when there is no selection or it is not in either section. */
  readonly selectionReveal: HomeSelectionReveal | null;
}

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(thread.environmentId, thread.id);

function destinationAt(
  ids: readonly string[],
  index: number,
  direction: "up" | "down",
): FolderMoveDestination | null {
  if (index < 0) return null;
  const targetId = ids[direction === "up" ? index - 1 : index + 1];
  return targetId === undefined
    ? null
    : { targetId, placement: direction === "up" ? "before" : "after" };
}

/**
 * Move up/down inside a Tasks folder. `folderThreadIds` are the folder's rows in
 * the moved row's block (pinned or active), in order. The destination names the
 * folder neighbor, so rows of other folders in between never block the move.
 */
export function folderMoveDestination(
  folderThreadIds: readonly string[],
  movedId: string,
  direction: "up" | "down",
): FolderMoveDestination | null {
  return destinationAt(folderThreadIds, folderThreadIds.indexOf(movedId), direction);
}

function earlier(left: string | null, right: string | null | undefined): string | null {
  if (right == null) return left;
  if (left === null) return right;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(rightMs)) return left;
  return Number.isNaN(leftMs) || rightMs < leftMs ? right : left;
}

function agentListItem(
  thread: EnvironmentThreadShell,
  section: AgentSectionRow,
  snoozeLabelNow: string | undefined,
): HomeAgentItem {
  const snoozed = section === "snoozed";
  return {
    type: "agent",
    key: `agent:${threadKeyOf(thread)}`,
    item: {
      thread,
      variant: section === "pinned" || section === "active" ? "card" : "slim",
      snoozed,
      pinned: section === "pinned",
      isLast: false,
    },
    standing: section === "pinned",
    snoozeWakeLabelText:
      snoozed && thread.snoozedUntil != null && snoozeLabelNow !== undefined
        ? snoozeWakeLabel(thread.snoozedUntil, { now: snoozeLabelNow })
        : undefined,
  };
}

function filterSections(
  sections: AssistantAgentSections<EnvironmentThreadShell>,
  keep: (thread: EnvironmentThreadShell) => boolean,
): AssistantAgentSections<EnvironmentThreadShell> {
  return {
    standing: sections.standing.filter(keep),
    active: sections.active.filter(keep),
    snoozed: sections.snoozed.filter(keep),
    settled: sections.settled.filter(keep),
  };
}

interface TaskFolder {
  readonly key: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly members: ReadonlyArray<EnvironmentProject> | null;
  readonly rows: ThreadListV2Item[];
  readonly pending: PendingNewTask[];
}

/** A folder for work whose workspace shell is missing, rebuilt from queued-task metadata. */
function placeholderFolder(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: EnvironmentProject["id"];
  readonly title: string | undefined;
  readonly createdAt: string;
}): TaskFolder {
  const project: EnvironmentProject = {
    environmentId: input.environmentId,
    id: input.projectId,
    title: input.title ?? "Unknown workspace",
    workspaceRoot: "",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  return {
    key: `pending-project:${scopedProjectKey(input.environmentId, input.projectId)}`,
    title: project.title,
    project,
    members: null,
    rows: [],
    pending: [],
  };
}

export function buildHomeSections(input: HomeSectionsInput): HomeSections {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const searching = query.length > 0;
  const matches = (thread: EnvironmentThreadShell) =>
    threadMatchesListSearch(thread, query, input.matchedThreadKeys);
  const inEnvironment = (environmentId: EnvironmentId) =>
    input.environmentId === null || environmentId === input.environmentId;
  const items: HomeSectionItem[] = [];
  const jumpThreads: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  let selectionReveal: HomeSelectionReveal | null = null;
  const selectedKey = input.selectedThreadKey;

  const assistantByProjectKey = new Map(
    [...input.partition.assistants, ...input.partition.archivedAssistants].map((entry) => [
      scopedProjectKey(entry.project.environmentId, entry.project.id),
      entry,
    ]),
  );
  const pendingByAssistantKey = new Map<string, PendingNewTask[]>();
  const taskPending: PendingNewTask[] = [];
  for (const pendingTask of input.pendingTasks) {
    if (!inEnvironment(pendingTask.environmentId)) continue;
    const projectKey = scopedProjectKey(pendingTask.environmentId, pendingTask.projectId);
    const entry = assistantByProjectKey.get(projectKey);
    if (entry === undefined) {
      taskPending.push(pendingTask);
      continue;
    }
    // Unsent agents of an archived Project render nowhere, like its threads.
    if (entry.project.assistant?.archivedAt != null) continue;
    const list = pendingByAssistantKey.get(projectKey) ?? [];
    list.push(pendingTask);
    pendingByAssistantKey.set(projectKey, list);
  }
  const matchesPending = (pendingTask: PendingNewTask) =>
    !searching || pendingTask.title.toLocaleLowerCase().includes(query);

  // ── Projects ──────────────────────────────────────────────────────────
  const entries = input.partition.assistants.filter((entry) =>
    inEnvironment(entry.project.environmentId),
  );
  const projectsCapable =
    input.environmentId === null
      ? input.assistantsEnvironmentIds.size > 0
      : input.assistantsEnvironmentIds.has(input.environmentId);
  const unsupportedIds = input.assistantsUnsupportedEnvironmentIds ?? new Set<EnvironmentId>();
  // Known to be missing: every connected server that reported a config lacks Projects.
  const projectsUnsupported =
    !projectsCapable &&
    (input.environmentId === null
      ? unsupportedIds.size > 0
      : unsupportedIds.has(input.environmentId));
  // Projects already in the shell stay listed while their environment reconnects.
  if (
    input.workspaceKey === null &&
    (projectsCapable || projectsUnsupported || entries.length > 0)
  ) {
    const collapsed = !searching && input.collapsedKeys.has(HOME_PROJECTS_SECTION_KEY);
    const projectItems: HomeSectionItem[] = [];
    const projectJumpThreads: EnvironmentThreadShell[] = [];
    const rollupEntries: {
      coordinator: EnvironmentThreadShell | null;
      sections: AssistantAgentSections<EnvironmentThreadShell>;
      scheduleAttention: boolean;
    }[] = [];
    for (const entry of entries) {
      const { project } = entry;
      const coordinatorThreadId = project.assistant?.coordinatorThreadId;
      if (coordinatorThreadId === undefined) continue;
      const environmentId = project.environmentId;
      const projectKey = scopedProjectKey(environmentId, project.id);
      const expansionKey = assistantExpansionKey(environmentId, project.id);
      const sections = sectionAssistantAgents(entry.agents, {
        now: input.now,
        supportsSnooze: input.snoozeEnvironmentIds?.has(environmentId) ?? true,
        supportsSettlement: input.settlementEnvironmentIds?.has(environmentId) ?? true,
      });
      for (const agent of sections.snoozed) {
        nextSnoozeWakeAt = earlier(nextSnoozeWakeAt, agent.snoozedUntil);
      }
      // A missed or failed schedule lights the Project dot as failed.
      const rollupEntry = {
        coordinator: entry.coordinator,
        sections,
        scheduleAttention: hasScheduleAttention(project.assistant),
      };
      rollupEntries.push(rollupEntry);
      const coordinatorKey = scopedThreadKey(environmentId, coordinatorThreadId);
      const selectedAgent =
        selectedKey !== null && entry.agents.some((agent) => threadKeyOf(agent) === selectedKey);
      if (selectedKey === coordinatorKey || selectedAgent) {
        selectionReveal = {
          collapsedKeys: collapsed ? [HOME_PROJECTS_SECTION_KEY] : [],
          assistantKey:
            selectedAgent && !input.expandedAssistantKeys.has(expansionKey) ? expansionKey : null,
        };
      }

      const pending = (pendingByAssistantKey.get(projectKey) ?? []).filter(matchesPending);
      const shownSections = searching ? filterSections(sections, matches) : sections;
      const projectMatches =
        project.title.toLocaleLowerCase().includes(query) ||
        (entry.coordinator !== null && matches(entry.coordinator));
      const hasHits =
        shownSections.standing.length +
          shownSections.active.length +
          shownSections.snoozed.length +
          shownSections.settled.length +
          pending.length >
        0;
      if (searching && !projectMatches && !hasHits) continue;

      const expanded = searching || input.expandedAssistantKeys.has(expansionKey);
      projectItems.push({
        type: "project",
        key: `project:${expansionKey}`,
        expansionKey,
        project,
        coordinator: entry.coordinator,
        expanded,
        forcedOpen: searching,
        running: countRunningAgents(entry.agents),
        rollup: rollupAssistantsStatus([rollupEntry], input.lastVisitedAtById),
        selected: selectedKey === coordinatorKey,
      });
      if (entry.coordinator !== null) projectJumpThreads.push(entry.coordinator);
      if (!expanded) continue;

      if (!searching) {
        projectItems.push({ type: "new-agent", key: `new-agent:${expansionKey}`, project });
      }
      const settledCount = searching
        ? shownSections.settled.length
        : (input.assistantSettledCounts.get(expansionKey) ?? 0);
      const { rows, hiddenSettledCount } = visibleAssistantAgentRows(shownSections, {
        settledCount,
        routeThreadKey: selectedKey,
      });
      let pendingPlaced = false;
      const placePending = () => {
        if (pendingPlaced) return;
        pendingPlaced = true;
        for (const pendingTask of pending) {
          projectItems.push({
            type: "agent-pending",
            key: `agent-pending:${pendingTask.key}`,
            pendingTask,
          });
        }
      };
      for (const row of rows) {
        // Unsent agents sit after the active agents, before the parked ones.
        if (row.section === "snoozed" || row.section === "settled") placePending();
        projectItems.push(agentListItem(row.thread, row.section, input.snoozeLabelNow));
        projectJumpThreads.push(row.thread);
      }
      placePending();
      // Search shows every matching settled agent, so there is nothing to page.
      const toggle = searching
        ? null
        : assistantSettledToggle({
            settledCount,
            settledTotal: shownSections.settled.length,
            hiddenSettledCount,
          });
      if (toggle !== null) {
        projectItems.push({
          type: "agent-settled-toggle",
          key: `agent-settled:${expansionKey}`,
          expansionKey,
          label: toggle.label,
          nextSettledCount: toggle.nextSettledCount,
        });
      }
    }

    if (!searching || projectItems.length > 0) {
      items.push({
        type: "section",
        key: "section:projects",
        section: "projects",
        collapseKey: HOME_PROJECTS_SECTION_KEY,
        collapsed,
        forcedOpen: searching,
        rollup: collapsed ? rollupAssistantsStatus(rollupEntries, input.lastVisitedAtById) : null,
      });
      if (!collapsed) {
        items.push(
          ...(projectItems.length === 0
            ? [
                {
                  type: "projects-empty",
                  key: "projects-empty",
                  unsupported: projectsUnsupported,
                } as const,
              ]
            : projectItems),
        );
        jumpThreads.push(...projectJumpThreads);
      }
    }
  }

  // ── Tasks ─────────────────────────────────────────────────────────────
  const workspaceProjects = input.partition.workspaceProjects;
  const workspaceThreads = input.partition.workspaceThreads;
  const scopes = sortHomeProjectScopes({
    scopes: buildHomeProjectScopes({
      projects: workspaceProjects,
      environmentId: input.environmentId,
      projectGroupingMode: input.projectGroupingMode,
    }),
    threads: workspaceThreads,
    pendingTasks: taskPending,
    projectSortOrder: input.projectSortOrder,
  });
  const workspaceScope =
    input.workspaceKey === null
      ? null
      : (scopes.find(
          (scope) =>
            scope.key === input.workspaceKey ||
            scope.projectRefs.some(
              (ref) => scopedProjectKey(ref.environmentId, ref.projectId) === input.workspaceKey,
            ),
        ) ?? null);
  const visibleScopes =
    input.workspaceKey === null ? scopes : workspaceScope === null ? [] : [workspaceScope];
  const layout = buildThreadListV2Items({
    pendingOrder: input.pendingOrder ?? null,
    threads: workspaceThreads.filter((thread) => thread.archivedAt === null),
    sectionThreads: input.threads,
    environmentId: input.environmentId,
    projectRefs:
      input.workspaceKey === null
        ? null
        : workspaceScope === null
          ? []
          : workspaceScope.projectRefs,
    searchQuery: input.searchQuery,
    ...(input.matchedThreadKeys ? { matchedThreadKeys: input.matchedThreadKeys } : {}),
    ...(input.settlementEnvironmentIds
      ? { settlementEnvironmentIds: input.settlementEnvironmentIds }
      : {}),
    ...(input.snoozeEnvironmentIds ? { snoozeEnvironmentIds: input.snoozeEnvironmentIds } : {}),
    ...(input.queuedThreadKeys ? { queuedThreadKeys: input.queuedThreadKeys } : {}),
    ...(input.settledLimit !== undefined ? { settledLimit: input.settledLimit } : {}),
    now: input.now,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    settledShelfExpanded: input.settledShelfExpanded,
    selectedThreadKey: selectedKey,
  });
  nextSnoozeWakeAt = earlier(nextSnoozeWakeAt, layout.nextSnoozeWakeAt);

  const folders = new Map<string, TaskFolder>();
  const folderKeyByProjectKey = new Map<string, string>();
  for (const scope of visibleScopes) {
    folders.set(scope.key, {
      key: scope.key,
      title: scope.title,
      project: scope.representative,
      members: scope.projects,
      rows: [],
      pending: [],
    });
    for (const ref of scope.projectRefs) {
      folderKeyByProjectKey.set(scopedProjectKey(ref.environmentId, ref.projectId), scope.key);
    }
  }
  const folderFor = (seed: {
    readonly environmentId: EnvironmentId;
    readonly projectId: EnvironmentProject["id"];
    readonly title: string | undefined;
    readonly createdAt: string;
  }): TaskFolder => {
    const projectKey = scopedProjectKey(seed.environmentId, seed.projectId);
    const known = folders.get(folderKeyByProjectKey.get(projectKey) ?? "");
    if (known !== undefined) return known;
    const placeholder = placeholderFolder(seed);
    folderKeyByProjectKey.set(projectKey, placeholder.key);
    folders.set(placeholder.key, placeholder);
    return placeholder;
  };

  const cardEnd =
    layout.snoozedShelfHeaderIndex ?? layout.settledShelfHeaderIndex ?? layout.items.length;
  const cardThreads: EnvironmentThreadShell[] = [];
  for (const item of layout.items.slice(0, cardEnd)) {
    cardThreads.push(item.thread);
    folderFor({
      environmentId: item.thread.environmentId,
      projectId: item.thread.projectId,
      title: undefined,
      createdAt: item.thread.createdAt,
    }).rows.push(item);
  }
  for (const pendingTask of taskPending) {
    if (!matchesPending(pendingTask)) continue;
    const projectKey = scopedProjectKey(pendingTask.environmentId, pendingTask.projectId);
    // Under a Workspace filter only that folder's unsent work shows.
    if (input.workspaceKey !== null && !folderKeyByProjectKey.has(projectKey)) continue;
    folderFor({
      environmentId: pendingTask.environmentId,
      projectId: pendingTask.projectId,
      title: pendingTask.projectTitle,
      createdAt: pendingTask.createdAt,
    }).pending.push(pendingTask);
  }

  // The Workspace filter asks to see one folder, so it opens the section too.
  const tasksForcedOpen = searching || input.workspaceKey !== null;
  const tasksCollapsed = !tasksForcedOpen && input.collapsedKeys.has(HOME_TASKS_SECTION_KEY);
  const taskItems: HomeSectionItem[] = [];
  const taskJumpThreads: EnvironmentThreadShell[] = [];
  let firstFolder = true;
  for (const folder of folders.values()) {
    const rowCount = folder.rows.length + folder.pending.length;
    // Search drops folders without hits; otherwise every workspace shows.
    if (searching && rowCount === 0) continue;
    const forcedOpen = searching || input.workspaceKey !== null;
    const collapsed = !forcedOpen && input.collapsedKeys.has(folder.key);
    if (
      selectedKey !== null &&
      folder.rows.some((row) => threadKeyOf(row.thread) === selectedKey)
    ) {
      selectionReveal = {
        collapsedKeys: [
          ...(tasksCollapsed ? [HOME_TASKS_SECTION_KEY] : []),
          ...(collapsed ? [folder.key] : []),
        ],
        assistantKey: null,
      };
    }
    let newThreadTarget: EnvironmentProject | null = null;
    if (folder.members !== null) {
      // The member owning the folder's latest thread: the machine last worked on.
      let latest = Number.NEGATIVE_INFINITY;
      let latestThread: EnvironmentThreadShell | null = null;
      for (const row of folder.rows) {
        const timestamp = getThreadSortTimestamp(row.thread, "updated_at");
        if (timestamp > latest) {
          latest = timestamp;
          latestThread = row.thread;
        }
      }
      newThreadTarget =
        (latestThread === null
          ? undefined
          : folder.members.find(
              (member) =>
                member.environmentId === latestThread.environmentId &&
                member.id === latestThread.projectId,
            )) ?? folder.project;
    }
    taskItems.push({
      type: "folder",
      key: `folder:${folder.key}`,
      collapseKey: folder.key,
      title: folder.title,
      project: folder.project,
      collapsed,
      forcedOpen,
      count: rowCount,
      rollup: collapsed
        ? rollupThreadGroupStatus(
            folder.rows.map((row) => row.thread),
            input.lastVisitedAtById,
          )
        : null,
      newThreadTarget,
      members: folder.members ?? [],
      isFirst: firstFolder,
    });
    firstFolder = false;
    if (collapsed) continue;

    const blockIds = { pinned: [] as string[], active: [] as string[] };
    for (const row of folder.rows) {
      blockIds[row.pinned ? "pinned" : "active"].push(threadKeyOf(row.thread));
    }
    const blockIndex = { pinned: 0, active: 0 };
    for (const row of folder.rows) {
      const block = row.pinned ? "pinned" : "active";
      const index = blockIndex[block];
      blockIndex[block] += 1;
      taskItems.push({
        type: "v2-thread",
        key: `v2-thread:${threadKeyOf(row.thread)}`,
        item: row,
        snoozeWakeLabelText: undefined,
        moveUp: destinationAt(blockIds[block], index, "up"),
        moveDown: destinationAt(blockIds[block], index, "down"),
      });
      taskJumpThreads.push(row.thread);
    }
    // Unsent rows label themselves ("Draft", "Sends on reconnect"), so a
    // folder draws no divider above them, like a Project's unsent agents.
    for (const pendingTask of folder.pending) {
      taskItems.push({
        type: "v2-pending",
        key: `v2-${pendingTask.key}`,
        pendingTask,
        showPendingDivider: false,
      });
    }
  }
  if (taskItems.length === 0 && !searching) {
    taskItems.push({ type: "tasks-empty", key: "tasks-empty" });
  }

  const shelfItems = layout.items.slice(cardEnd);
  const snoozedEnd = layout.settledShelfHeaderIndex ?? layout.items.length;
  const pushShelfRow = (item: ThreadListV2Item) => {
    taskItems.push({
      type: "v2-thread",
      key: `v2-thread:${threadKeyOf(item.thread)}`,
      item,
      snoozeWakeLabelText:
        item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
          ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
          : undefined,
      moveUp: null,
      moveDown: null,
    });
    taskJumpThreads.push(item.thread);
  };
  if (layout.snoozedShelfHeaderIndex !== null && layout.snoozedCount > 0) {
    taskItems.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: layout.snoozedCount,
      expanded: input.snoozedShelfExpanded,
    });
    for (const item of layout.items.slice(layout.snoozedShelfHeaderIndex, snoozedEnd)) {
      pushShelfRow(item);
    }
  }
  if (layout.settledShelfHeaderIndex !== null && layout.settledCount > 0) {
    taskItems.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: layout.settledCount,
      expanded: input.settledShelfExpanded,
    });
    for (const item of layout.items.slice(layout.settledShelfHeaderIndex)) {
      pushShelfRow(item);
    }
    if (input.settledShelfExpanded && layout.hiddenSettledCount > 0) {
      taskItems.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: layout.hiddenSettledCount,
      });
    }
  }
  if (
    selectionReveal === null &&
    selectedKey !== null &&
    shelfItems.some((item) => threadKeyOf(item.thread) === selectedKey)
  ) {
    selectionReveal = {
      collapsedKeys: tasksCollapsed ? [HOME_TASKS_SECTION_KEY] : [],
      assistantKey: null,
    };
  }

  if (!searching || taskItems.length > 0) {
    items.push({
      type: "section",
      key: "section:tasks",
      section: "tasks",
      collapseKey: HOME_TASKS_SECTION_KEY,
      collapsed: tasksCollapsed,
      forcedOpen: tasksForcedOpen,
      rollup: tasksCollapsed ? rollupThreadGroupStatus(cardThreads, input.lastVisitedAtById) : null,
    });
    if (!tasksCollapsed) {
      items.push(...taskItems);
      jumpThreads.push(...taskJumpThreads);
    }
  }

  return {
    items,
    jumpThreads,
    hiddenSettledCount: layout.hiddenSettledCount,
    nextSnoozeWakeAt,
    workspaceScope,
    selectionReveal,
  };
}

const sameDestination = (left: FolderMoveDestination | null, right: FolderMoveDestination | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.targetId === right.targetId &&
    left.placement === right.placement);

const sameMembers = (
  left: ReadonlyArray<EnvironmentProject>,
  right: ReadonlyArray<EnvironmentProject>,
) => left.length === right.length && left.every((member, index) => member === right[index]);

const sameListItem = (left: ThreadListV2Item, right: ThreadListV2Item) =>
  left.thread === right.thread &&
  left.variant === right.variant &&
  left.snoozed === right.snoozed &&
  left.pinned === right.pinned;

/** Recycled-list equality: false whenever anything a row renders changed. */
export function homeSectionItemsAreEqual(
  previous: HomeSectionItem,
  item: HomeSectionItem,
): boolean {
  if (previous.key !== item.key) return false;
  switch (previous.type) {
    case "section":
      return (
        item.type === "section" &&
        previous.collapsed === item.collapsed &&
        previous.forcedOpen === item.forcedOpen &&
        previous.rollup === item.rollup
      );
    case "projects-empty":
      return item.type === "projects-empty" && previous.unsupported === item.unsupported;
    case "tasks-empty":
      return item.type === previous.type;
    case "project":
      return (
        item.type === "project" &&
        previous.project === item.project &&
        previous.coordinator === item.coordinator &&
        previous.expanded === item.expanded &&
        previous.forcedOpen === item.forcedOpen &&
        previous.running === item.running &&
        previous.rollup === item.rollup &&
        previous.selected === item.selected
      );
    case "new-agent":
      return item.type === "new-agent" && previous.project === item.project;
    case "agent":
      return (
        item.type === "agent" &&
        sameListItem(previous.item, item.item) &&
        previous.standing === item.standing &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText
      );
    case "agent-pending":
      return item.type === "agent-pending" && previous.pendingTask === item.pendingTask;
    case "agent-settled-toggle":
      return (
        item.type === "agent-settled-toggle" &&
        previous.label === item.label &&
        previous.nextSettledCount === item.nextSettledCount
      );
    case "folder":
      return (
        item.type === "folder" &&
        previous.title === item.title &&
        previous.project === item.project &&
        previous.collapsed === item.collapsed &&
        previous.forcedOpen === item.forcedOpen &&
        previous.count === item.count &&
        previous.rollup === item.rollup &&
        previous.newThreadTarget === item.newThreadTarget &&
        sameMembers(previous.members, item.members) &&
        previous.isFirst === item.isFirst
      );
    case "v2-thread":
      return (
        item.type === "v2-thread" &&
        sameListItem(previous.item, item.item) &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        sameDestination(previous.moveUp, item.moveUp) &&
        sameDestination(previous.moveDown, item.moveDown)
      );
    case "v2-pending":
      return (
        item.type === "v2-pending" &&
        previous.pendingTask === item.pendingTask &&
        previous.showPendingDivider === item.showPendingDivider
      );
    case "v2-snoozed-shelf":
    case "v2-settled-shelf":
      return (
        item.type === previous.type &&
        previous.count === item.count &&
        previous.expanded === item.expanded
      );
    case "v2-show-more":
      return item.type === "v2-show-more" && previous.hiddenCount === item.hiddenCount;
  }
}

/** Where a row sits in its rounded card, on the grouped (iOS phone) Home. */
export type HomeCardEdge = "none" | "top" | "middle" | "bottom" | "only";

export interface HomeCardRow {
  readonly key: string;
  readonly item: HomeSectionItem;
  readonly edge: HomeCardEdge;
}

/** Headers, shelf labels and Show more sit between cards; everything else is inside one. */
function sitsInCard(item: HomeSectionItem | undefined): boolean {
  if (item === undefined) return false;
  switch (item.type) {
    case "section":
    case "v2-snoozed-shelf":
    case "v2-settled-shelf":
    case "v2-show-more":
      return false;
    default:
      return true;
  }
}

/** Each run of rows between headers becomes one card, rounded at its ends. */
export function homeCardRows(items: readonly HomeSectionItem[]): HomeCardRow[] {
  return items.map((item, index) => {
    if (!sitsInCard(item)) return { key: item.key, item, edge: "none" };
    const top = !sitsInCard(items[index - 1]);
    const bottom = !sitsInCard(items[index + 1]);
    const edge = top && bottom ? "only" : top ? "top" : bottom ? "bottom" : "middle";
    return { key: item.key, item, edge };
  });
}
