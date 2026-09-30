import { planPinnedReorder, generateSpreadPinOrderKeys } from "./threadSort.ts";

// Shared, Hermes-safe helpers for the synced order of Projects and Tasks folders.
// `orderKey` lives on each project record (fractional index, same alphabet as thread order
// keys), so it reaches every client through the shell like `projectIcon`. Keys from different
// environments compare directly; ties break by environment id, then project id.

export interface OrderKeyedProject {
  readonly environmentId: string;
  readonly id: string;
  readonly orderKey?: string | null | undefined;
}

/** Keyed before keyless; keyed by key, then environment id, then project id. Keyless: 0. */
export function compareProjectOrder(left: OrderKeyedProject, right: OrderKeyedProject): number {
  const leftKey = left.orderKey ?? null;
  const rightKey = right.orderKey ?? null;
  if (leftKey === null || rightKey === null) {
    return leftKey === null ? (rightKey === null ? 0 : 1) : -1;
  }
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return left.environmentId.localeCompare(right.environmentId) || left.id.localeCompare(right.id);
}

/** The lowest key among several members (a folder holds one project per environment). */
export function minProjectOrderKey(keys: ReadonlyArray<string | null | undefined>): string | null {
  let min: string | null = null;
  for (const key of keys) {
    if (key != null && (min === null || key < min)) min = key;
  }
  return min;
}

/**
 * Arranged projects first in key order, then the rest. `orderRest` lets a caller keep an
 * older ordering (a client's saved local order, or its default sort) for keyless projects.
 */
export function orderProjectsByKey<T extends OrderKeyedProject>(
  projects: readonly T[],
  orderRest?: (keyless: readonly T[]) => readonly T[],
): T[] {
  const keyed: T[] = [];
  const keyless: T[] = [];
  for (const project of projects) {
    (project.orderKey != null ? keyed : keyless).push(project);
  }
  keyed.sort(compareProjectOrder);
  return [...keyed, ...(orderRest ? orderRest(keyless) : keyless)];
}

export interface ProjectOrderAssignment {
  readonly id: string;
  readonly orderKey: string;
}

/**
 * Keys needed to realize a drop. `orderedIds` is the visible order after the move; `keysById`
 * also carries hidden entries (filtered folders, archived Projects) so their keys stay
 * reserved. Entries whose environment cannot store keys are left out of `reorderableIds`:
 * they sit after the arranged ones and never take part in the plan. Null when the moved entry
 * cannot be arranged.
 */
export function planProjectReorder(input: {
  readonly orderedIds: readonly string[];
  readonly movedId: string;
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableIds: ReadonlySet<string>;
}): ReadonlyArray<ProjectOrderAssignment> | null {
  if (!input.reorderableIds.has(input.movedId)) return null;
  const orderedIds = input.orderedIds.filter((id) => input.reorderableIds.has(id));
  const assignments = planPinnedReorder({
    orderedIds,
    keysById: input.keysById,
    movedId: input.movedId,
  });
  return assignments.length === 0 ? null : assignments;
}

/**
 * Moves one entry to the slot of `targetId` in `orderedIds`, dropping it where the target was
 * (before it when moving up, after it when moving down), like a drag.
 */
export function moveIdToTarget(
  orderedIds: readonly string[],
  movedId: string,
  targetId: string,
): string[] | null {
  const from = orderedIds.indexOf(movedId);
  const to = orderedIds.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...orderedIds];
  next.splice(from, 1);
  next.splice(to, 0, movedId);
  return next;
}

/**
 * Keys that publish a client's saved local order. `items` are in that saved order. Null unless
 * nobody has arranged the list yet (no item holds a key) and something can be written: the
 * first client to seed wins, and the server ignores writes to keyed projects (`ifKeyless`).
 */
export function planProjectOrderSeed(input: {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly orderKey: string | null | undefined;
    readonly writable: boolean;
  }>;
}): ReadonlyArray<ProjectOrderAssignment> | null {
  if (input.items.some((item) => item.orderKey != null)) return null;
  const writable = input.items.filter((item) => item.writable);
  if (writable.length < 2) return null;
  const keys = generateSpreadPinOrderKeys(writable.length);
  return writable.map((item, index) => ({ id: item.id, orderKey: keys[index]! }));
}
