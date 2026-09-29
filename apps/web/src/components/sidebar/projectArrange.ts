import {
  minProjectOrderKey,
  moveIdToTarget,
  planProjectOrderSeed,
  planProjectReorder,
} from "@t3tools/client-runtime/state/project-order";

// Web glue for the synced order of Projects and Tasks folders. An "entry" is one row of a
// list: a Project (one member) or a Tasks folder (one member per project it groups, possibly
// on several environments). Entries are planned as a unit; the chosen key is then written to
// every member whose environment can store it, so members stay adjacent under any client's
// grouping (equal keys tie-break by environment id and project id).

export interface ArrangeMember {
  readonly environmentId: string;
  readonly projectId: string;
  readonly orderKey: string | null | undefined;
  /** The member's environment understands `project.reorder`. */
  readonly writable: boolean;
}

export interface ArrangeEntry {
  readonly id: string;
  readonly members: readonly ArrangeMember[];
}

export interface ProjectOrderWrite {
  readonly environmentId: string;
  readonly projectId: string;
  readonly orderKey: string;
}

function entryKey(entry: ArrangeEntry): string | null {
  return minProjectOrderKey(entry.members.map((member) => member.orderKey));
}

function isWritable(entry: ArrangeEntry): boolean {
  return entry.members.some((member) => member.writable);
}

function fanOut(
  entries: ReadonlyMap<string, ArrangeEntry>,
  assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>,
): ProjectOrderWrite[] {
  return assignments.flatMap(({ id, orderKey }) =>
    (entries.get(id)?.members ?? [])
      .filter((member) => member.writable)
      .map((member) => ({
        environmentId: member.environmentId,
        projectId: member.projectId,
        orderKey,
      })),
  );
}

/**
 * Writes that realize dropping `activeId` at `overId`. `visible` is the list in displayed
 * order; `hidden` are entries outside it (filtered, archived) whose keys stay reserved. Null
 * when nothing can be written, so the caller falls back to the local order.
 */
export function planEntryArrange(input: {
  readonly visible: readonly ArrangeEntry[];
  readonly hidden: readonly ArrangeEntry[];
  readonly activeId: string;
  readonly overId: string;
}): ProjectOrderWrite[] | null {
  const orderedIds = moveIdToTarget(
    input.visible.map((entry) => entry.id),
    input.activeId,
    input.overId,
  );
  if (orderedIds === null) return null;
  const all = [...input.visible, ...input.hidden];
  const entries = new Map(all.map((entry) => [entry.id, entry] as const));
  const assignments = planProjectReorder({
    orderedIds,
    movedId: input.activeId,
    keysById: new Map(all.map((entry) => [entry.id, entryKey(entry)] as const)),
    reorderableIds: new Set(all.filter(isWritable).map((entry) => entry.id)),
  });
  if (assignments === null) return null;
  const writes = fanOut(entries, assignments);
  return writes.length === 0 ? null : writes;
}

/** Writes that publish a client's saved order; null once anyone has arranged the list. */
export function planEntrySeed(input: {
  readonly entries: readonly ArrangeEntry[];
}): ProjectOrderWrite[] | null {
  const entries = new Map(input.entries.map((entry) => [entry.id, entry] as const));
  const assignments = planProjectOrderSeed({
    items: input.entries.map((entry) => ({
      id: entry.id,
      orderKey: entryKey(entry),
      writable: isWritable(entry),
    })),
  });
  if (assignments === null) return null;
  const writes = fanOut(entries, assignments);
  return writes.length === 0 ? null : writes;
}
