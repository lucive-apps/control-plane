import { describe, expect, it } from "vite-plus/test";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { planProjectThreadReorder } from "./Sidebar.projectOrder";

type Input = Parameters<typeof planProjectThreadReorder>[0];

function fixture(section: "pinned" | "active" = "active"): Input {
  const order = ["env-a:a", "env-b:a", "env-a:b", "env-a:c"];
  const keys = new Map(order.map((key, index) => [key, ["d", "h", "m", "t"][index]!]));
  return {
    activeKey: "env-a:a",
    overKey: "env-a:c",
    rows: order.map((key) => ({
      key,
      projectKey: key === "env-b:a" ? "other" : "project",
      section,
    })),
    pinnedOrder: section === "pinned" ? order : [],
    activeOrder: section === "active" ? order : [],
    pinnedKeysById: keys,
    activeKeysById: keys,
    pinnedReorderableKeys: new Set(order),
    activeReorderableKeys: new Set(order),
  };
}

function persistedProjectOrder(
  input: Input,
  plan: NonNullable<ReturnType<typeof planProjectThreadReorder>>,
) {
  const keys = new Map(plan.section === "pinned" ? input.pinnedKeysById : input.activeKeysById);
  for (const assignment of plan.assignments) keys.set(assignment.id, assignment.orderKey);
  const rows = input.rows
    .filter((row) => row.projectKey === "project")
    .map((row) => ({
      id: row.key,
      createdAt: "2026-09-22T00:00:00Z",
      pinOrderKey: keys.get(row.key),
      activeOrderKey: keys.get(row.key),
    }));
  return (
    plan.section === "pinned"
      ? sortPinnedThreadsByOrderKey(rows)
      : sortActiveThreadsByOrderKey(rows)
  ).map((row) => row.id);
}

describe("planProjectThreadReorder", () => {
  for (const section of ["active", "pinned"] as const) {
    it(`moves ${section} tasks down within their project and preserves other project slots`, () => {
      const input = fixture(section);
      const plan = planProjectThreadReorder(input)!;
      expect(plan.section).toBe(section);
      expect(plan.order).toEqual(["env-a:b", "env-b:a", "env-a:c", "env-a:a"]);
      expect(plan.assignments.map((assignment) => assignment.id)).toEqual(["env-a:a"]);
      expect(persistedProjectOrder(input, plan)).toEqual(["env-a:b", "env-a:c", "env-a:a"]);
    });

    it(`moves ${section} tasks up within their project`, () => {
      const input = { ...fixture(section), activeKey: "env-a:c", overKey: "env-a:a" };
      const plan = planProjectThreadReorder(input)!;
      expect(plan.order).toEqual(["env-a:c", "env-b:a", "env-a:a", "env-a:b"]);
      expect(persistedProjectOrder(input, plan)).toEqual(["env-a:c", "env-a:a", "env-a:b"]);
    });
  }

  it("rejects same-row, missing-row, cross-project, and cross-section drops", () => {
    const input = fixture();
    for (const overKey of [input.activeKey, "missing", "env-b:a"]) {
      expect(planProjectThreadReorder({ ...input, overKey })).toBeNull();
    }
    expect(
      planProjectThreadReorder({
        ...input,
        rows: input.rows.map((row) =>
          row.key === input.overKey ? { ...row, section: "pinned" } : row,
        ),
      }),
    ).toBeNull();
  });

  it("does not arrange snoozed or settled tasks", () => {
    const input = fixture();
    for (const section of ["snoozed", "settled"] as const) {
      expect(
        planProjectThreadReorder({
          ...input,
          rows: input.rows.map((row) => ({ ...row, section })),
        }),
      ).toBeNull();
    }
  });

  it("rejects tasks missing from the canonical section", () => {
    expect(planProjectThreadReorder({ ...fixture(), activeOrder: ["env-a:a"] })).toBeNull();
  });

  it("materializes only the project section when neighbors are keyless", () => {
    const input = { ...fixture(), activeKeysById: new Map([["env-b:a", "h"]]) };
    const plan = planProjectThreadReorder(input)!;
    expect(plan.assignments.map((assignment) => assignment.id)).toEqual([
      "env-a:b",
      "env-a:c",
      "env-a:a",
    ]);
    expect(plan.assignments.every((assignment) => assignment.orderKey !== "h")).toBe(true);
    expect(plan.order[1]).toBe("env-b:a");
    expect(persistedProjectOrder(input, plan)).toEqual(["env-a:b", "env-a:c", "env-a:a"]);
  });

  it("rejects unsupported sources and keyless normalization touching unsupported neighbors", () => {
    const input = fixture();
    expect(
      planProjectThreadReorder({
        ...input,
        activeReorderableKeys: new Set(["env-a:b", "env-a:c"]),
      }),
    ).toBeNull();
    expect(
      planProjectThreadReorder({
        ...input,
        activeKeysById: new Map(),
        activeReorderableKeys: new Set(["env-a:a"]),
      }),
    ).toBeNull();
  });

  it("permits a single-key move past an unsupported keyed neighbor", () => {
    const input = { ...fixture(), activeReorderableKeys: new Set(["env-a:a"]) };
    expect(planProjectThreadReorder(input)?.assignments.map((assignment) => assignment.id)).toEqual(
      ["env-a:a"],
    );
  });
});
