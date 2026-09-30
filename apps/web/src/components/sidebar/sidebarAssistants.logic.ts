import { visibleAssistantAgentRows } from "@t3tools/client-runtime/state/assistant-lists";
import type { AssistantAgentSections } from "@t3tools/client-runtime/state/assistants";
import {
  isAssistantSettlementExempt,
  type EnvironmentId,
  type ProjectAssistant,
  type ThreadId,
} from "@t3tools/contracts";

import { orderItemsByPreferredIds } from "../Sidebar.logic";

// Fork-owned. Web-only helpers behind the sidebar's Projects section. The list
// helpers shared with mobile live in client-runtime and are re-exported here.

export {
  assistantExpansionKey,
  isAssistantExpanded,
  rollupAssistantsStatus,
  rollupThreadGroupStatus,
  visibleAssistantAgentRows,
  type AssistantAgentRow,
  type SidebarRollupStatus,
} from "@t3tools/client-runtime/state/assistant-lists";

/**
 * Applies the saved manual order of the Projects section. Projects without a
 * saved place (new ones) keep their default order after the ordered ones, and
 * saved keys with no Project are ignored.
 */
export function orderAssistantsByPreference<T extends { readonly key: string }>(
  models: readonly T[],
  order: readonly string[],
): readonly T[] {
  return order.length === 0
    ? models
    : orderItemsByPreferredIds({ items: models, preferredIds: order, getId: (model) => model.key });
}

interface ScopedThreadLike {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
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
  routeThreadKey: string | null = null,
): T[] {
  const ordered: T[] = [];
  for (const entry of entries) {
    if (entry.coordinator !== null) ordered.push(entry.coordinator);
    if (!expandedKeys.has(entry.key)) continue;
    const { rows } = visibleAssistantAgentRows(entry.sections, {
      settledCount: 0,
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
