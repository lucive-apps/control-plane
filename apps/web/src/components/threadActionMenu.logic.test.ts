import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  resolveThreadActionMenuAgent,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toEqual(["rename", "mark-unread", "copy", "project-settings", "archive", "delete"]);
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(baseState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    expect(items[copyIndex + 1]).toMatchObject({
      id: "project-settings",
      label: "Workspace settings",
      icon: "settings",
    });
    expect(items[copyIndex + 2]?.id).toBe("archive");
  });

  it("offers project filtering only for surfaces with a scoped thread list", () => {
    expect(ids(baseState)).not.toContain("filter-by-project");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        projectFilter: { label: "Beta Project", isActive: false },
      }).find((item) => item.id === "filter-by-project"),
    ).toMatchObject({ label: "Filter by Beta Project", icon: "folder-tree" });
  });

  it("offers the way back to all projects once the list is scoped", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      projectFilter: { label: "Beta Project", isActive: true },
    });
    const filterIndex = items.findIndex((candidate) => candidate.id === "filter-by-project");
    expect(items[filterIndex]).toMatchObject({ label: "Show all workspaces", icon: "folder-tree" });
    expect(items[filterIndex - 1]?.id).toBe("mark-unread");
    expect(items[filterIndex + 1]?.id).toBe("copy");
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = allIds({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(allIds(baseState)).not.toContain("new-thread-on-branch");
    expect(allIds(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.icon).toBe("archive");
    expect(archiveItem?.separatorBefore).toBe(true);
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("Project agent menu", () => {
  const coordinatorId = ThreadId.make("coordinator");
  const project = { assistant: { coordinatorThreadId: coordinatorId } };
  const agentThread = (overrides: {
    pinnedAt?: string | null;
    worktreePath?: string | null;
    session?: { status: string } | null;
  }) => ({
    id: ThreadId.make("agent"),
    pinnedAt: overrides.pinnedAt ?? null,
    worktreePath: overrides.worktreePath ?? null,
    session: overrides.session ?? null,
  });
  const menuFor = (thread: ReturnType<typeof agentThread>, state = baseState) => {
    const agent = resolveThreadActionMenuAgent(project, thread);
    return buildThreadActionMenuItems({
      ...state,
      branch: "feat/agent",
      projectFilter: { label: "Personal", isActive: false },
      isPinned: thread.pinnedAt != null,
      agent,
    });
  };
  const item = (items: ReturnType<typeof menuFor>, id: string) =>
    items.find((candidate) => candidate.id === id);

  it("gives a standing agent Unpin and no Settle", () => {
    const items = menuFor(agentThread({ pinnedAt: "2026-09-28T00:00:00.000Z" }));
    const menuIds = items.map((candidate) => candidate.id);
    expect(menuIds).toContain("unpin");
    expect(menuIds).toContain("snooze");
    expect(menuIds).not.toContain("settle");
    expect(menuIds).not.toContain("unsettle");
  });

  it("gives a one-off agent Pin and Settle", () => {
    const menuIds = menuFor(agentThread({})).map((candidate) => candidate.id);
    expect(menuIds).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("adds Set as coordinator and Stop agent, and drops branch and workspace filter items", () => {
    for (const thread of [agentThread({}), agentThread({ pinnedAt: "2026-09-28T00:00:00.000Z" })]) {
      const items = menuFor(thread);
      const menuIds = items.map((candidate) => candidate.id);
      expect(menuIds).toEqual(expect.arrayContaining(["set-coordinator", "stop-agent"]));
      expect(menuIds).not.toContain("new-thread-on-branch");
      expect(menuIds).not.toContain("filter-by-project");
      expect(item(items, "project-settings")?.label).toBe("Project settings");
      expect(items.at(-2)?.id).toBe("archive");
    }
  });

  it("disables Stop agent without a live session", () => {
    expect(item(menuFor(agentThread({})), "stop-agent")?.disabled).toBe(true);
    expect(
      item(menuFor(agentThread({ session: { status: "stopped" } })), "stop-agent")?.disabled,
    ).toBe(true);
    expect(
      item(menuFor(agentThread({ session: { status: "ready" } })), "stop-agent")?.disabled,
    ).toBe(false);
  });

  it("disables Set as coordinator for a worktree agent", () => {
    expect(item(menuFor(agentThread({})), "set-coordinator")?.disabled).toBe(false);
    expect(
      item(menuFor(agentThread({ worktreePath: "/work/.worktrees/a" })), "set-coordinator")
        ?.disabled,
    ).toBe(true);
  });

  it("is not an agent menu for the coordinator or a plain workspace thread", () => {
    expect(
      resolveThreadActionMenuAgent(project, { ...agentThread({}), id: coordinatorId }),
    ).toBeUndefined();
    expect(resolveThreadActionMenuAgent({ assistant: null }, agentThread({}))).toBeUndefined();
    const plain = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(plain.map((candidate) => candidate.id)).not.toContain("stop-agent");
    expect(plain.find((candidate) => candidate.id === "project-settings")?.label).toBe(
      "Workspace settings",
    );
  });
});
