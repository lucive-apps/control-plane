// Fork-owned. Which chats the Creator Micro 2 agent keys show: the targets of
// Cmd+1..Cmd+6 in the sidebar's default view, with each chat's row status.

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadIndicatorStatus } from "@t3tools/client-runtime/state/thread-status";
import type { CreatorMicroSlot } from "@t3tools/contracts";

export const CREATOR_MICRO_SLOT_COUNT = 6;

type SlotThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "backgroundLiveness"
  | "latestTurn"
>;

/**
 * Slot n is the chat Cmd+(n+1) opens, so the keys follow pins, unpins and
 * reorders exactly as the shortcuts do. Fewer than six chats leaves the
 * remaining slots null (the key goes dark).
 */
export function buildCreatorMicroSlots(
  jumpOrder: readonly SlotThread[],
  lastVisitedAtByKey: Readonly<Record<string, string>>,
): (CreatorMicroSlot | null)[] {
  return Array.from({ length: CREATOR_MICRO_SLOT_COUNT }, (_, slot) => {
    const thread = jumpOrder[slot];
    if (!thread) return null;
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return {
      threadKey,
      status: resolveThreadIndicatorStatus({
        ...thread,
        lastVisitedAt: lastVisitedAtByKey[threadKey],
      }),
    };
  });
}

/**
 * The jump order of the sidebar's default view. A search or the settled view
 * reorders Cmd+N while it is open; the pad keeps showing the regular order so
 * typing in the search box does not reshuffle the lights.
 */
export function creatorMicroJumpOrder<T>(input: {
  readonly assistantThreads: readonly T[];
  readonly folderThreads: readonly T[];
}): readonly T[] {
  return input.assistantThreads.length === 0
    ? input.folderThreads
    : [...input.assistantThreads, ...input.folderThreads];
}
