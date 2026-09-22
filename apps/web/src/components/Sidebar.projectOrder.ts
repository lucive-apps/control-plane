import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";

/** Arrange a folder's section without writing keys belonging to other projects. */
export function planProjectThreadReorder(input: {
  readonly activeKey: string;
  readonly overKey: string;
  readonly rows: readonly {
    readonly key: string;
    readonly projectKey: string;
    readonly section: "pinned" | "active" | "snoozed" | "settled";
  }[];
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly pinnedReorderableKeys: ReadonlySet<string>;
  readonly activeReorderableKeys: ReadonlySet<string>;
}) {
  if (input.activeKey === input.overKey) return null;
  const active = input.rows.find((row) => row.key === input.activeKey);
  const over = input.rows.find((row) => row.key === input.overKey);
  if (
    active === undefined ||
    over === undefined ||
    active.projectKey !== over.projectKey ||
    active.section !== over.section ||
    (active.section !== "pinned" && active.section !== "active")
  ) {
    return null;
  }

  const section = active.section;
  const order = section === "pinned" ? input.pinnedOrder : input.activeOrder;
  const keysById = section === "pinned" ? input.pinnedKeysById : input.activeKeysById;
  const reorderableKeys =
    section === "pinned" ? input.pinnedReorderableKeys : input.activeReorderableKeys;
  if (!reorderableKeys.has(active.key)) return null;
  const projectKeys = new Set(
    input.rows
      .filter((row) => row.projectKey === active.projectKey && row.section === section)
      .map((row) => row.key),
  );
  const projectOrder = order.filter((key) => projectKeys.has(key));
  const from = projectOrder.indexOf(active.key);
  const to = projectOrder.indexOf(over.key);
  if (from < 0 || to < 0) return null;
  projectOrder.splice(from, 1);
  projectOrder.splice(to, 0, active.key);
  const assignments = planPinnedReorder({
    orderedIds: projectOrder,
    keysById,
    movedId: active.key,
  });
  if (
    assignments.length === 0 ||
    assignments.some((assignment) => !reorderableKeys.has(assignment.id))
  ) {
    return null;
  }

  // Keep the complete section for the optimistic hold, including hidden folders.
  let projectIndex = 0;
  return {
    section,
    order: order.map((key) => (projectKeys.has(key) ? projectOrder[projectIndex++]! : key)),
    assignments,
  };
}
