import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  rollupAssistantStatus,
  type AssistantAgentSections,
} from "@t3tools/client-runtime/state/assistants";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  rollupSidebarThreadStatus,
  type SidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-status";
import {
  isAssistantSettlementExempt,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ProjectAssistant,
  type ThreadId,
} from "@t3tools/contracts";

import type { SidebarSection } from "../Sidebar.logic";

// Fork-owned. Pure helpers behind the sidebar's Projects section.

/** Settled agents under a Project page in like the settled tail. */
export const ASSISTANT_SETTLED_PAGE_SIZE = 10;

/** The collapsed dot of a section, folder or Project. Null shows no dot. */
export type SidebarRollupStatus = SidebarThreadStatus | "unread" | null;

interface ScopedThreadLike {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}

type RollupThread = ScopedThreadLike &
  Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness" | "latestTurn"
  >;

const threadKeyOf = (thread: ScopedThreadLike) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Per-device expansion key of a Project row in `uiStateStore.projectExpandedById`. */
export function assistantExpansionKey(environmentId: string, projectId: string): string {
  return `sidebar-assistant:${environmentId}:${projectId}`;
}

/** Project rows start collapsed; the row's dot and count carry the status. */
export function isAssistantExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  expansionKey: string,
): boolean {
  return projectExpandedById[expansionKey] === true;
}

export interface AssistantAgentRow<T> {
  readonly thread: T;
  readonly section: SidebarSection;
}

/**
 * An expanded Project's agents in rendered order: standing, active, snoozed,
 * then the settled page. The open thread never hides behind the settled
 * button, the same exception the settled tail makes.
 */
export function visibleAssistantAgentRows<T extends ScopedThreadLike>(
  sections: AssistantAgentSections<T>,
  options: { readonly settledCount: number; readonly routeThreadKey: string | null },
): { readonly rows: AssistantAgentRow<T>[]; readonly hiddenSettledCount: number } {
  const settled = sections.settled.slice(0, Math.max(0, options.settledCount));
  if (options.routeThreadKey !== null) {
    const routeThread = sections.settled
      .slice(settled.length)
      .find((thread) => threadKeyOf(thread) === options.routeThreadKey);
    if (routeThread !== undefined) settled.push(routeThread);
  }
  const rows: AssistantAgentRow<T>[] = [];
  for (const thread of sections.standing) rows.push({ thread, section: "pinned" });
  for (const thread of sections.active) rows.push({ thread, section: "active" });
  for (const thread of sections.snoozed) rows.push({ thread, section: "snoozed" });
  for (const thread of settled) rows.push({ thread, section: "settled" });
  return { rows, hiddenSettledCount: sections.settled.length - settled.length };
}

/**
 * The settled button under a Project: "3 settled", then "N more settled",
 * then "Hide settled" once a page is open and nothing is left. No button when
 * nothing is hidden and no page is open (the open thread can pull the only
 * settled agent in).
 */
export function assistantSettledToggle(input: {
  readonly settledCount: number;
  readonly settledTotal: number;
  readonly hiddenSettledCount: number;
}): { readonly label: string; readonly nextSettledCount: number } | null {
  const settledCount = Math.max(0, input.settledCount);
  if (input.settledTotal === 0) return null;
  if (input.hiddenSettledCount === 0) {
    return settledCount > 0 ? { label: "Hide settled", nextSettledCount: 0 } : null;
  }
  return {
    label:
      settledCount === 0
        ? `${input.hiddenSettledCount} settled`
        : `${input.hiddenSettledCount} more settled`,
    nextSettledCount: settledCount + ASSISTANT_SETTLED_PAGE_SIZE,
  };
}

export interface AssistantJumpEntry<T> {
  /** `assistantExpansionKey` of the Project. */
  readonly key: string;
  readonly coordinator: T | null;
  readonly sections: AssistantAgentSections<T>;
}

/**
 * Jump and traversal order for the Projects section: each coordinator, then
 * its visible agents in rendered order. Collapsed Projects contribute only
 * their coordinator.
 */
export function flattenAssistantJumpOrder<T extends ScopedThreadLike>(
  entries: readonly AssistantJumpEntry<T>[],
  expandedKeys: ReadonlySet<string>,
  settledCounts: ReadonlyMap<string, number>,
  routeThreadKey: string | null = null,
): T[] {
  const ordered: T[] = [];
  for (const entry of entries) {
    if (entry.coordinator !== null) ordered.push(entry.coordinator);
    if (!expandedKeys.has(entry.key)) continue;
    const { rows } = visibleAssistantAgentRows(entry.sections, {
      settledCount: settledCounts.get(entry.key) ?? 0,
      routeThreadKey,
    });
    for (const row of rows) ordered.push(row.thread);
  }
  return ordered;
}

/**
 * Range selection runs over the rendered order minus coordinators: a
 * coordinator is never selected, so bulk actions can never reach it.
 */
export function selectableThreadKeys(
  orderedKeys: readonly string[],
  coordinatorKeys: ReadonlySet<string>,
): string[] {
  return coordinatorKeys.size === 0
    ? [...orderedKeys]
    : orderedKeys.filter((key) => !coordinatorKeys.has(key));
}

/** The part of a selection that "Settle (k)" acts on: never a coordinator or standing agent. */
export function settleableSelection<
  T extends {
    readonly environmentId: string;
    readonly projectId: string;
    readonly id: ThreadId;
    readonly pinnedAt?: string | null | undefined;
  },
>(
  threads: readonly T[],
  projectByKey: ReadonlyMap<
    string,
    { readonly assistant?: ProjectAssistant | null | undefined } | undefined
  >,
): T[] {
  return threads.filter(
    (thread) =>
      !isAssistantSettlementExempt(
        projectByKey.get(`${thread.environmentId}:${thread.projectId}`),
        thread,
      ),
  );
}

const isUnreadThread = (
  thread: RollupThread,
  lastVisitedAtById: Readonly<Record<string, string>>,
) =>
  hasUnseenCompletion({
    latestTurn: thread.latestTurn,
    lastVisitedAt: lastVisitedAtById[threadKeyOf(thread)],
  });

/**
 * The dot a collapsed Tasks section or folder shows: the most urgent live
 * status, else unread, else nothing.
 */
export function rollupThreadGroupStatus(
  threads: readonly RollupThread[],
  lastVisitedAtById: Readonly<Record<string, string>>,
): SidebarRollupStatus {
  const status = rollupSidebarThreadStatus(threads.map(resolveSidebarThreadStatus));
  if (status !== null && status !== "ready") return status;
  return threads.some((thread) => isUnreadThread(thread, lastVisitedAtById)) ? "unread" : null;
}

/**
 * The dot of one Project row, or of the collapsed Projects section when given
 * every Project. Rolls up each coordinator and its standing and active agents;
 * snoozed and settled agents stay out, as they do for a Tasks folder, so a
 * hidden agent never keeps a dot lit.
 */
export function rollupAssistantsStatus(
  entries: readonly {
    readonly coordinator: RollupThread | null;
    readonly sections: AssistantAgentSections<RollupThread>;
  }[],
  lastVisitedAtById: Readonly<Record<string, string>>,
): SidebarRollupStatus {
  const statuses: SidebarThreadStatus[] = [];
  let coordinatorUnread = false;
  let agentsUnread = false;
  for (const entry of entries) {
    if (entry.coordinator !== null) {
      statuses.push(resolveSidebarThreadStatus(entry.coordinator));
      coordinatorUnread ||= isUnreadThread(entry.coordinator, lastVisitedAtById);
    }
    for (const agents of [entry.sections.standing, entry.sections.active]) {
      for (const agent of agents) {
        statuses.push(resolveSidebarThreadStatus(agent));
        agentsUnread ||= isUnreadThread(agent, lastVisitedAtById);
      }
    }
  }
  return rollupAssistantStatus({ statuses, coordinatorUnread, agentsUnread });
}
