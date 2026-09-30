import type { EnvironmentId, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { rollupAssistantStatus, type AssistantAgentSections } from "./assistants.ts";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  rollupSidebarThreadStatus,
  type SidebarThreadStatus,
} from "./threadStatus.ts";
import { planPinnedReorder } from "./threadSort.ts";

// Fork-owned. Pure list helpers behind the Projects section, shared by the web
// sidebar and the mobile home and iPad sidebar.

/** The collapsed dot of a section, folder or Project. Null shows no dot. */
export type SidebarRollupStatus = SidebarThreadStatus | "unread" | null;

interface ScopedThreadLike {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}

export type RollupThread = ScopedThreadLike &
  Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness" | "latestTurn"
  >;

const threadKeyOf = (thread: ScopedThreadLike) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Per-device expansion key of a Project row. */
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
  readonly section: "pinned" | "active" | "snoozed" | "settled";
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
 * hidden agent never keeps a dot lit. A missed or failed schedule reads as
 * failed.
 */
export function rollupAssistantsStatus(
  entries: readonly {
    readonly coordinator: RollupThread | null;
    readonly sections: AssistantAgentSections<RollupThread>;
    readonly scheduleAttention?: boolean | undefined;
  }[],
  lastVisitedAtById: Readonly<Record<string, string>>,
): SidebarRollupStatus {
  const statuses: SidebarThreadStatus[] = [];
  let coordinatorUnread = false;
  let agentsUnread = false;
  let scheduleAttention = false;
  for (const entry of entries) {
    scheduleAttention ||= entry.scheduleAttention === true;
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
  return rollupAssistantStatus({ statuses, coordinatorUnread, agentsUnread, scheduleAttention });
}

type ReorderableAgent = ScopedThreadLike & {
  readonly pinOrderKey?: string | null | undefined;
  readonly activeOrderKey?: string | null | undefined;
};

export interface AssistantAgentReorderPlan {
  /** Standing agents arrange by pin key, active agents by active key. */
  readonly section: "pinned" | "active";
  /** The block's agent keys in their new order, for an optimistic hold. */
  readonly order: readonly string[];
  readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
}

/**
 * Moves one agent within its Project's standing or active block, by a drop
 * target or one step. Null for a move that crosses blocks (a pin change, not
 * an arrangement), leaves the Project, or falls off either end. Keys of the
 * Project's other agents stay reserved so a move never reuses one.
 */
export function planAssistantAgentReorder<T extends ReorderableAgent>(
  sections: AssistantAgentSections<T>,
  movedKey: string,
  target: { readonly overKey: string } | { readonly direction: -1 | 1 },
): AssistantAgentReorderPlan | null {
  const standingKeys = sections.standing.map(threadKeyOf);
  const section = standingKeys.includes(movedKey)
    ? "pinned"
    : sections.active.some((thread) => threadKeyOf(thread) === movedKey)
      ? "active"
      : null;
  if (section === null) return null;
  const order =
    section === "pinned" ? [...standingKeys] : sections.active.map((agent) => threadKeyOf(agent));
  const from = order.indexOf(movedKey);
  const to = "overKey" in target ? order.indexOf(target.overKey) : from + target.direction;
  if (to < 0 || to >= order.length || to === from) return null;
  order.splice(from, 1);
  order.splice(to, 0, movedKey);
  const keysById = new Map<string, string | null>();
  for (const agent of [
    ...sections.standing,
    ...sections.active,
    ...sections.snoozed,
    ...sections.settled,
  ]) {
    keysById.set(
      threadKeyOf(agent),
      (section === "pinned" ? agent.pinOrderKey : agent.activeOrderKey) ?? null,
    );
  }
  const assignments = planPinnedReorder({ orderedIds: order, keysById, movedId: movedKey });
  return assignments.length === 0 ? null : { section, order, assignments };
}
