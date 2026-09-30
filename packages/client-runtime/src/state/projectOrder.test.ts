import { describe, expect, it } from "vite-plus/test";

import {
  compareProjectOrder,
  minProjectOrderKey,
  moveIdToTarget,
  orderProjectsByKey,
  planProjectOrderSeed,
  planProjectReorder,
} from "./projectOrder.ts";

const p = (environmentId: string, id: string, orderKey?: string | null) => ({
  environmentId,
  id,
  orderKey,
});

describe("orderProjectsByKey", () => {
  it("puts keyed projects first by key, across environments, keyless after in input order", () => {
    const ordered = orderProjectsByKey([
      p("a", "z"),
      p("b", "k2", "m"),
      p("a", "k1", "c"),
      p("a", "y", null),
    ]);
    expect(ordered.map((project) => project.id)).toEqual(["k1", "k2", "z", "y"]);
  });

  it("breaks equal keys by environment id then project id, on every client alike", () => {
    const projects = [p("b", "one", "m"), p("a", "two", "m"), p("a", "one", "m")];
    const forward = orderProjectsByKey(projects).map((x) => `${x.environmentId}:${x.id}`);
    const reversed = orderProjectsByKey([...projects].reverse()).map(
      (x) => `${x.environmentId}:${x.id}`,
    );
    expect(forward).toEqual(["a:one", "a:two", "b:one"]);
    expect(reversed).toEqual(forward);
  });

  it("lets a caller order the keyless tail", () => {
    const ordered = orderProjectsByKey([p("a", "x"), p("a", "y"), p("a", "z", "m")], (rest) =>
      [...rest].reverse(),
    );
    expect(ordered.map((project) => project.id)).toEqual(["z", "y", "x"]);
  });

  it("keeps compareProjectOrder neutral for two keyless projects", () => {
    expect(compareProjectOrder(p("a", "x"), p("a", "y", null))).toBe(0);
  });
});

describe("minProjectOrderKey", () => {
  it("ignores keyless members and returns the lowest key", () => {
    expect(minProjectOrderKey([null, "m", undefined, "c"])).toBe("c");
    expect(minProjectOrderKey([null, undefined])).toBeNull();
  });
});

describe("planProjectReorder", () => {
  const all = new Set(["a", "b", "c", "d"]);

  it("writes a single key between arranged neighbours", () => {
    const keys = new Map([
      ["a", "d"],
      ["b", "h"],
      ["c", "m"],
      ["d", "t"],
    ]);
    const plan = planProjectReorder({
      orderedIds: ["a", "c", "b", "d"],
      movedId: "c",
      keysById: keys,
      reorderableIds: all,
    });
    expect(plan).toHaveLength(1);
    expect(plan![0]!.id).toBe("c");
    expect(plan![0]!.orderKey > "d" && plan![0]!.orderKey < "h").toBe(true);
  });

  it("materializes the visible list when a neighbour has no key yet", () => {
    const plan = planProjectReorder({
      orderedIds: ["b", "a", "c"],
      movedId: "b",
      keysById: new Map(),
      reorderableIds: new Set(["a", "b", "c"]),
    });
    expect(plan!.map((assignment) => assignment.id)).toEqual(["b", "a", "c"]);
    const written = plan!.map((assignment) => assignment.orderKey);
    expect([...written].sort()).toEqual(written);
  });

  it("does not write to entries whose environment cannot store keys", () => {
    const plan = planProjectReorder({
      orderedIds: ["b", "old", "a"],
      movedId: "b",
      keysById: new Map(),
      reorderableIds: new Set(["a", "b"]),
    });
    expect(plan!.map((assignment) => assignment.id).sort()).toEqual(["a", "b"]);
    expect(
      planProjectReorder({
        orderedIds: ["b", "old"],
        movedId: "old",
        keysById: new Map(),
        reorderableIds: new Set(["b"]),
      }),
    ).toBeNull();
  });

  it("keeps hidden entries' keys reserved", () => {
    const keys = new Map([
      ["a", "d"],
      ["hidden", "h"],
      ["b", "m"],
    ]);
    const plan = planProjectReorder({
      orderedIds: ["b", "a"],
      movedId: "b",
      keysById: keys,
      reorderableIds: new Set(["a", "b"]),
    });
    for (const assignment of plan!) expect(assignment.orderKey).not.toBe("h");
  });

  it("rewrites over a non-monotone visible order instead of failing", () => {
    // An activity-sorted view whose order disagrees with the stored keys.
    const keys = new Map([
      ["a", "t"],
      ["b", "d"],
    ]);
    const plan = planProjectReorder({
      orderedIds: ["a", "b"],
      movedId: "b",
      keysById: keys,
      reorderableIds: new Set(["a", "b"]),
    });
    expect(plan).not.toBeNull();
    const byId = new Map(plan!.map((assignment) => [assignment.id, assignment.orderKey]));
    expect((byId.get("a") ?? "t") < (byId.get("b") ?? "d")).toBe(true);
  });
});

describe("moveIdToTarget", () => {
  it("moves in either direction and refuses no-ops", () => {
    expect(moveIdToTarget(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveIdToTarget(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveIdToTarget(["a", "b"], "a", "a")).toBeNull();
    expect(moveIdToTarget(["a", "b"], "a", "zzz")).toBeNull();
  });
});

describe("planProjectOrderSeed", () => {
  const item = (id: string, orderKey: string | null, writable = true) => ({
    id,
    orderKey,
    writable,
  });

  it("publishes the saved order as ascending keys", () => {
    const plan = planProjectOrderSeed({
      items: [item("c", null), item("a", null), item("b", null)],
    });
    expect(plan!.map((assignment) => assignment.id)).toEqual(["c", "a", "b"]);
    const keys = plan!.map((assignment) => assignment.orderKey);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(3);
  });

  it("does nothing once anyone has arranged the list", () => {
    expect(planProjectOrderSeed({ items: [item("a", null), item("b", "m")] })).toBeNull();
  });

  it("skips entries that cannot store keys and lists too short to order", () => {
    const plan = planProjectOrderSeed({
      items: [item("a", null), item("old", null, false), item("b", null)],
    });
    expect(plan!.map((assignment) => assignment.id)).toEqual(["a", "b"]);
    expect(planProjectOrderSeed({ items: [item("a", null)] })).toBeNull();
  });
});
