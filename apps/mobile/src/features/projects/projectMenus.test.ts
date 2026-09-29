import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentRowMenu,
  buildProjectMenuItems,
  buildProjectRowMenu,
  buildTaskFolderMenu,
  isProjectRowMenuAction,
  leadingEmoji,
  matchesProjectName,
  resolveAgentRowState,
  resolveAgentSwipeActions,
  resolveTaskFolderMenuAction,
} from "./projectMenus";

const PRESETS: MenuAction[] = [
  { id: "snooze:1h", title: "1 hour" },
  { id: "snooze:custom", title: "Custom…" },
];

function agentMenu(overrides: Partial<Parameters<typeof buildAgentRowMenu>[0]> = {}) {
  return buildAgentRowMenu({
    standing: false,
    snoozable: true,
    snoozeSubactions: PRESETS,
    canStop: true,
    canBeCoordinator: true,
    titleRegenerationSupported: false,
    isRegenerating: false,
    ...overrides,
  });
}

const ids = (actions: readonly MenuAction[]) => actions.map((action) => action.id);
const find = (actions: readonly MenuAction[], id: string) =>
  actions.find((action) => action.id === id);

describe("buildProjectRowMenu", () => {
  it("lists New agent, then the desktop Project menu without Open folder", () => {
    const menu = buildProjectRowMenu(false);
    expect(ids(menu)).toEqual([
      "new-agent",
      "rename",
      "settings",
      "archive",
      "move-to-tasks",
      "delete",
    ]);
    expect(find(menu, "delete")?.attributes?.destructive).toBe(true);
    expect(menu.every((action) => isProjectRowMenuAction(action.id ?? ""))).toBe(true);
    expect(isProjectRowMenuAction("open-folder")).toBe(false);
  });

  it("offers Schedules after Settings only where the server stores them", () => {
    const menu = buildProjectRowMenu(true);
    expect(ids(menu).slice(1, 4)).toEqual(["rename", "settings", "schedules"]);
    expect(isProjectRowMenuAction("schedules")).toBe(true);
    expect(ids(buildProjectRowMenu(false))).not.toContain("schedules");
  });
});

describe("buildProjectMenuItems", () => {
  it("gives the coordinator header the row's actions without New agent", () => {
    const header = buildProjectMenuItems({ surface: "header", archived: false });
    expect(header.map((item) => item.id)).toEqual(ids(buildProjectRowMenu(false)).slice(1));
    // The header has its own Schedules button.
    expect(
      buildProjectMenuItems({ surface: "header", archived: false, canSchedule: true }).map(
        (item) => item.id,
      ),
    ).not.toContain("schedules");
  });

  it("offers Unarchive instead of Archive in an archived Project's header", () => {
    const menuIds = buildProjectMenuItems({ surface: "header", archived: true }).map(
      (item) => item.id,
    );
    expect(menuIds).toContain("unarchive");
    expect(menuIds).not.toContain("archive");
  });
});

describe("buildAgentRowMenu", () => {
  it("offers a one-off agent Pin, Snooze, Settle, Stop and Set as coordinator in A4 order", () => {
    expect(ids(agentMenu())).toEqual([
      "pin",
      "snooze",
      "settle",
      "stop-agent",
      "set-coordinator",
      "rename",
      "archive",
      "delete",
    ]);
  });

  it("offers a standing agent Unpin and never Settle", () => {
    const menu = agentMenu({ standing: true });
    expect(ids(menu)).toEqual([
      "unpin",
      "snooze",
      "stop-agent",
      "set-coordinator",
      "rename",
      "archive",
      "delete",
    ]);
    expect(find(menu, "settle")).toBeUndefined();
  });

  it("lists the snooze presets only while the thread can snooze", () => {
    expect(find(agentMenu(), "snooze")?.subactions).toEqual(PRESETS);
    expect(find(agentMenu({ snoozable: false }), "snooze")).toBeUndefined();
  });

  it("disables Stop agent without a live session and Set as coordinator for a worktree agent", () => {
    const menu = agentMenu({ canStop: false, canBeCoordinator: false });
    expect(find(menu, "stop-agent")?.attributes?.disabled).toBe(true);
    expect(find(menu, "set-coordinator")?.attributes?.disabled).toBe(true);
    const enabled = agentMenu();
    expect(find(enabled, "stop-agent")?.attributes?.disabled).toBeUndefined();
    expect(find(enabled, "set-coordinator")?.attributes?.disabled).toBeUndefined();
  });

  it("never offers a new thread on the agent's branch", () => {
    expect(find(agentMenu(), "new-thread-on-branch")).toBeUndefined();
    expect(find(agentMenu({ standing: true }), "new-thread-on-branch")).toBeUndefined();
  });

  it("adds Regenerate title after Rename when the environment supports it", () => {
    const menu = agentMenu({ titleRegenerationSupported: true, isRegenerating: true });
    expect(ids(menu).slice(5, 7)).toEqual(["rename", "regenerate-title"]);
    expect(find(menu, "regenerate-title")?.attributes?.disabled).toBe(true);
  });
});

describe("resolveAgentRowState", () => {
  const idle = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    worktreePath: null,
  };

  it("counts live work and work blocked on the user as running", () => {
    expect(resolveAgentRowState({ ...idle, session: { status: "running" } }).running).toBe(true);
    expect(resolveAgentRowState({ ...idle, hasPendingApprovals: true }).running).toBe(true);
    expect(resolveAgentRowState({ ...idle, session: { status: "ready" } }).running).toBe(false);
  });

  it("can stop any session that is not already stopped", () => {
    expect(resolveAgentRowState(idle).canStop).toBe(false);
    expect(resolveAgentRowState({ ...idle, session: { status: "stopped" } }).canStop).toBe(false);
    expect(resolveAgentRowState({ ...idle, session: { status: "ready" } }).canStop).toBe(true);
  });

  it("lets only a Local agent become the coordinator", () => {
    expect(resolveAgentRowState(idle).canBeCoordinator).toBe(true);
    expect(resolveAgentRowState({ ...idle, worktreePath: "/wt/agent" }).canBeCoordinator).toBe(
      false,
    );
  });
});

describe("resolveAgentSwipeActions", () => {
  it("full-swipes to Pin or Unpin and shows Stop only while running", () => {
    expect(resolveAgentSwipeActions({ standing: false, running: true, canStop: true })).toEqual({
      primary: "pin",
      secondary: "stop",
    });
    expect(resolveAgentSwipeActions({ standing: true, running: true, canStop: true })).toEqual({
      primary: "unpin",
      secondary: "stop",
    });
    expect(resolveAgentSwipeActions({ standing: false, running: false, canStop: true })).toEqual({
      primary: "pin",
      secondary: null,
    });
  });

  it("hides Stop for a thread waiting on the user with no session to stop", () => {
    const waiting = { hasPendingApprovals: false, hasPendingUserInput: true, session: null };
    const state = resolveAgentRowState({ ...waiting, worktreePath: null });
    expect(state.running).toBe(true);
    expect(
      resolveAgentSwipeActions({ standing: false, running: state.running, canStop: state.canStop })
        .secondary,
    ).toBeNull();
  });
});

describe("leadingEmoji", () => {
  it("keeps the first emoji, joined sequences and flags whole", () => {
    expect(leadingEmoji(" 🏡 ")).toBe("🏡");
    expect(leadingEmoji("🔥 Sales")).toBe("🔥");
    expect(leadingEmoji("❤️")).toBe("❤️");
    expect(leadingEmoji("👩🏽‍💻")).toBe("👩🏽‍💻");
    expect(leadingEmoji("🕵️‍♀️")).toBe("🕵️‍♀️");
    expect(leadingEmoji("👨‍👩‍👧‍👦👍")).toBe("👨‍👩‍👧‍👦");
    expect(leadingEmoji("🇺🇸🇨🇦")).toBe("🇺🇸");
    expect(leadingEmoji("🏴󠁧󠁢󠁳󠁣󠁴󠁿")).toBe("🏴󠁧󠁢󠁳󠁣󠁴󠁿");
    expect(leadingEmoji("#️⃣")).toBe("#️⃣");
  });

  it("rejects text that does not start with an emoji", () => {
    expect(leadingEmoji("Sales")).toBeNull();
    expect(leadingEmoji("S🔥")).toBeNull();
    expect(leadingEmoji("7")).toBeNull();
    expect(leadingEmoji("   ")).toBeNull();
  });
});

describe("matchesProjectName", () => {
  it("accepts only the exact name, ignoring surrounding spaces", () => {
    expect(matchesProjectName("  Personal ", "Personal")).toBe(true);
    expect(matchesProjectName("personal", "Personal")).toBe(false);
    expect(matchesProjectName("Person", "Personal")).toBe(false);
    expect(matchesProjectName("   ", "Personal")).toBe(false);
  });
});

describe("buildTaskFolderMenu", () => {
  const website = {
    key: "mac:website",
    title: "website",
    workspaceRoot: "/Users/n/code/website",
    environmentLabel: "MacBook",
    supportsProjects: true,
  };
  const mini = {
    key: "mini:website",
    title: "website",
    workspaceRoot: "/Users/n/website",
    environmentLabel: "Mac mini",
    supportsProjects: false,
  };
  const canConvert = (member: { readonly supportsProjects: boolean }) => member.supportsProjects;

  it("offers New thread and Convert to Project… for a folder that can convert", () => {
    const menu = buildTaskFolderMenu({ members: [website], canConvert });
    expect(ids(menu)).toEqual(["new-thread", "convert"]);
    expect(find(menu, "convert")?.title).toBe("Convert to Project…");
    expect(find(menu, "convert")?.subactions).toBeUndefined();
    expect(resolveTaskFolderMenuAction([website], "convert")).toEqual({
      kind: "convert",
      member: website,
    });
  });

  it("offers only New thread when no checkout's environment supports Projects", () => {
    expect(ids(buildTaskFolderMenu({ members: [mini], canConvert }))).toEqual(["new-thread"]);
    expect(find(buildTaskFolderMenu({ members: [mini], canConvert }), "workspace-settings")).toBe(
      undefined,
    );
  });

  it("lists a grouped folder's convertible checkouts, since Convert moves one", () => {
    const menu = buildTaskFolderMenu({ members: [website, mini], canConvert });
    expect(find(menu, "convert")?.subactions).toEqual([
      { id: "convert:mac:website", title: "MacBook: /Users/n/code/website" },
    ]);
    expect(resolveTaskFolderMenuAction([website, mini], "convert:mac:website")).toEqual({
      kind: "convert",
      member: website,
    });
    // The grouped parent item is only a submenu.
    expect(resolveTaskFolderMenuAction([website, mini], "convert")).toBeNull();
    expect(resolveTaskFolderMenuAction([website, mini], "new-thread")).toEqual({
      kind: "new-thread",
    });
    expect(resolveTaskFolderMenuAction([website, mini], "convert:gone")).toBeNull();
  });
});
