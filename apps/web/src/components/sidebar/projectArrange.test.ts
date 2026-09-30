import { describe, expect, it } from "vite-plus/test";

import { planEntryArrange, planEntrySeed, type ArrangeEntry } from "./projectArrange";

const entry = (
  id: string,
  members: ReadonlyArray<{
    env: string;
    key?: string | null;
    writable?: boolean;
  }>,
): ArrangeEntry => ({
  id,
  members: members.map((member) => ({
    environmentId: member.env,
    projectId: `${id}-${member.env}`,
    orderKey: member.key ?? null,
    writable: member.writable ?? true,
  })),
});

describe("planEntryArrange", () => {
  it("writes one key to a single-project entry between its keyed neighbours", () => {
    const writes = planEntryArrange({
      visible: [
        entry("a", [{ env: "e1", key: "d" }]),
        entry("b", [{ env: "e1", key: "h" }]),
        entry("c", [{ env: "e1", key: "m" }]),
      ],
      hidden: [],
      activeId: "c",
      overId: "b",
    });
    expect(writes).toHaveLength(1);
    expect(writes![0]).toMatchObject({ environmentId: "e1", projectId: "c-e1" });
    expect(writes![0]!.orderKey > "d" && writes![0]!.orderKey < "h").toBe(true);
  });

  it("writes the same key to every writable member of a moved folder", () => {
    const writes = planEntryArrange({
      visible: [
        entry("a", [{ env: "e1", key: "d" }]),
        entry("folder", [
          { env: "e1", key: "m" },
          { env: "e2", key: "q" },
          { env: "old", writable: false },
        ]),
      ],
      hidden: [],
      activeId: "folder",
      overId: "a",
    });
    expect(writes!.map((write) => write.environmentId).sort()).toEqual(["e1", "e2"]);
    expect(new Set(writes!.map((write) => write.orderKey)).size).toBe(1);
    expect(writes![0]!.orderKey < "d").toBe(true);
  });

  it("returns null when the moved entry lives only on servers without the capability", () => {
    expect(
      planEntryArrange({
        visible: [entry("a", [{ env: "e1" }]), entry("old", [{ env: "old", writable: false }])],
        hidden: [],
        activeId: "old",
        overId: "a",
      }),
    ).toBeNull();
  });

  it("never reuses a hidden entry's key", () => {
    const writes = planEntryArrange({
      visible: [entry("a", [{ env: "e1", key: "d" }]), entry("b", [{ env: "e1", key: "m" }])],
      hidden: [entry("hidden", [{ env: "e1", key: "h" }])],
      activeId: "b",
      overId: "a",
    });
    for (const write of writes!) expect(write.orderKey).not.toBe("h");
  });

  it("ignores a drop onto itself or an unknown row", () => {
    const visible = [entry("a", [{ env: "e1" }]), entry("b", [{ env: "e1" }])];
    expect(planEntryArrange({ visible, hidden: [], activeId: "a", overId: "a" })).toBeNull();
    expect(planEntryArrange({ visible, hidden: [], activeId: "a", overId: "zzz" })).toBeNull();
  });
});

describe("planEntrySeed", () => {
  it("seeds keys in saved order, skipping servers that cannot store them", () => {
    const writes = planEntrySeed({
      entries: [
        entry("b", [{ env: "e1" }]),
        entry("old", [{ env: "old", writable: false }]),
        entry("a", [{ env: "e2" }]),
      ],
    });
    expect(writes!.map((write) => write.projectId)).toEqual(["b-e1", "a-e2"]);
    expect(writes![0]!.orderKey < writes![1]!.orderKey).toBe(true);
  });

  it("does nothing once any entry already has a key", () => {
    expect(
      planEntrySeed({
        entries: [entry("a", [{ env: "e1", key: "m" }]), entry("b", [{ env: "e1" }])],
      }),
    ).toBeNull();
  });
});
