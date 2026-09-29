import { describe, expect, it } from "vite-plus/test";

import { partitionAssistants } from "@t3tools/client-runtime/state/assistants";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildCommandPaletteAssistantRows,
  buildCommandPaletteProjectRows,
  filterCommandPaletteItems,
  nextPaletteIndex,
  resolveContextualPaletteActions,
  resolvePaletteThreadChrome,
  type CommandPaletteItem,
} from "./commandPaletteItems";

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return { key, title, kind, searchTerms, run: () => {} };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread", ["Mobile app", "Siva"]),
  item("mac:one", "Mobile app", "thread", ["Mac"]),
];
const emptyMatches = new Set<string>();

describe("filterCommandPaletteItems", () => {
  it("shows actions and recent threads in their original order when the query is empty", () => {
    expect(filterCommandPaletteItems(items, "", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
      "siva:one",
      "mac:one",
    ]);
  });

  it("matches query tokens across titles and metadata and ranks exact titles first", () => {
    expect(
      filterCommandPaletteItems(items, " MOBILE app ", emptyMatches).map((item) => item.key),
    ).toEqual(["project", "mac:one", "siva:one"]);
    expect(
      filterCommandPaletteItems(items, "siva keyboard", emptyMatches).map((item) => item.key),
    ).toEqual(["siva:one"]);
  });

  it("supports the desktop actions-only prefix and action aliases", () => {
    expect(filterCommandPaletteItems(items, ">", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
    ]);
    expect(
      filterCommandPaletteItems(items, "> preferences", emptyMatches).map((item) => item.key),
    ).toEqual(["settings"]);
    expect(
      filterCommandPaletteItems(items, "> new thread", emptyMatches).map((item) => item.key),
    ).toEqual(["new"]);
  });

  it("includes server content matches scoped to the correct environment, except in actions-only mode", () => {
    const matches = new Set(["siva:one", "project"]);
    expect(
      filterCommandPaletteItems(items, "message content", matches).map((item) => item.key),
    ).toEqual(["siva:one"]);
    expect(filterCommandPaletteItems(items, "> message content", matches)).toEqual([]);
  });
});

describe("buildCommandPaletteProjectRows", () => {
  const mac = EnvironmentId.make("mac");
  const mini = EnvironmentId.make("mini");
  const local = {
    environmentId: mac,
    title: "t3code",
    workspaceRoot: "/Users/nick/Code/t3code",
  };
  const remote = {
    environmentId: mini,
    title: "t3code",
    workspaceRoot: "/Users/nick/t3code",
  };

  it("lists one row per logical repo and keeps the current-machine checkout", () => {
    const [row] = buildCommandPaletteProjectRows({
      scopes: [
        {
          key: "github.com/pingdotgg/t3code",
          title: "t3code",
          representative: local,
          projects: [local, remote],
        },
      ],
      preferredEnvironmentId: mini,
      environmentLabelById: new Map([
        [mac, "MacBook Pro"],
        [mini, "Mac Mini"],
      ]),
    });

    expect(row?.title).toBe("t3code");
    expect(row?.detail).toBe("/Users/nick/t3code");
    expect(row?.detail).not.toContain("Mac Mini");
    expect(row?.target).toBe(remote);
    expect(row?.searchTerms).toEqual(
      expect.arrayContaining([
        "MacBook Pro",
        "Mac Mini",
        "/Users/nick/Code/t3code",
        "/Users/nick/t3code",
      ]),
    );
  });
});

describe("nextPaletteIndex", () => {
  it("wraps arrow navigation in both directions and handles empty results", () => {
    expect(nextPaletteIndex(0, -1, 3)).toBe(2);
    expect(nextPaletteIndex(2, 1, 3)).toBe(0);
    expect(nextPaletteIndex(0, 1, 3)).toBe(1);
    expect(nextPaletteIndex(0, -1, 0)).toBe(0);
    expect(nextPaletteIndex(0, 1, 0)).toBe(0);
  });
});

const env = EnvironmentId.make("env-1");
const NOW = "2026-09-28T12:00:00.000Z";

function project(id: string, coordinator?: string): EnvironmentProject {
  return {
    environmentId: env,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...(coordinator ? { assistant: { coordinatorThreadId: ThreadId.make(coordinator) } } : {}),
  };
}

function thread(
  id: string,
  projectId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("buildCommandPaletteAssistantRows", () => {
  it("lists each Project with its running agents and rolled-up dot", () => {
    const personal = project("Personal", "coordinator");
    const partition = partitionAssistants(
      [personal, project("website")],
      [
        thread("coordinator", "Personal", { hasPendingApprovals: true }),
        thread("sales", "Personal", {
          session: {
            threadId: ThreadId.make("sales"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
        thread("planner", "Personal"),
        thread("fix-hero", "website"),
      ],
      null,
    );
    const rows = buildCommandPaletteAssistantRows({
      assistants: partition.assistants,
      lastVisitedAtById: {},
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "assistant:env-1:Personal",
      title: "Personal",
      // The coordinator never counts toward "N running".
      detail: "1 running",
      rollup: "approval",
      coordinatorThreadId: "coordinator",
    });
    expect(rows[0]?.project).toBe(personal);
  });

  it("omits the count when nothing runs and opens a coordinator whose shell has not arrived", () => {
    const partition = partitionAssistants([project("Work", "boss")], [], null);
    const [row] = buildCommandPaletteAssistantRows({
      assistants: partition.assistants,
      lastVisitedAtById: {},
      now: NOW,
    });
    expect(row?.detail).toBeUndefined();
    expect(row?.coordinator).toBeNull();
    expect(row?.coordinatorThreadId).toBe("boss");
    expect(row?.rollup).toBeNull();
  });
});

describe("filterCommandPaletteItems with Projects", () => {
  const withProjects = [
    item("assistant:env-1:Personal", "Personal", "assistant", ["coordinator"]),
    item("newProject", "New Project…", "action", ["create project"]),
    ...items,
  ];

  it("leads the root with Projects and keeps them out of actions-only mode", () => {
    expect(
      filterCommandPaletteItems(withProjects, "", emptyMatches)
        .map((entry) => entry.key)
        .slice(0, 2),
    ).toEqual(["assistant:env-1:Personal", "newProject"]);
    expect(
      filterCommandPaletteItems(withProjects, ">", emptyMatches).map((entry) => entry.key),
    ).not.toContain("assistant:env-1:Personal");
    expect(
      filterCommandPaletteItems(withProjects, "> project", emptyMatches).map((entry) => entry.key),
    ).toContain("newProject");
  });
});

describe("resolveContextualPaletteActions", () => {
  const personal = project("Personal", "coordinator");
  const website = project("website");
  const keys = (actions: ReadonlyArray<{ readonly key: string }>) =>
    actions.map((action) => action.key);
  const contextFor = (
    activeProject: EnvironmentProject,
    active: EnvironmentThreadShell,
    assistantsCapability = true,
    schedulesCapability = false,
  ) =>
    resolveContextualPaletteActions({
      activeProject,
      hasActiveThread: true,
      chrome: resolvePaletteThreadChrome({
        project: activeProject,
        threadId: active.id,
        worktreePath: active.worktreePath,
      }),
      assistantsCapability,
      schedulesCapability,
    });

  it("offers a coordinator New agent and Project settings, without Review", () => {
    const context = contextFor(personal, thread("coordinator", "Personal"));
    expect(context.leading.map((action) => action.title)).toEqual([
      "New agent in Personal",
      "Project settings",
    ]);
    expect(keys(context.thread)).toEqual(["files", "terminal", "copyThreadReference"]);
  });

  it("adds Project schedules inside a Project whose server stores them", () => {
    const context = contextFor(personal, thread("sales", "Personal"), true, true);
    expect(keys(context.leading)).toEqual(["newThread", "projectSettings", "projectSchedules"]);
    expect(context.leading[2]).toMatchObject({ title: "Project schedules", detail: "Personal" });
    expect(keys(contextFor(website, thread("fix-hero", "website"), true, true).leading)).toEqual([
      "newThread",
      "convertToProject",
    ]);
  });

  it("hides Review for a Local agent and keeps it for a worktree agent", () => {
    const local = contextFor(personal, thread("sales", "Personal"));
    expect(keys(local.leading)).toEqual(["newThread", "projectSettings"]);
    expect(keys(local.thread)).not.toContain("review");

    const worktree = contextFor(
      personal,
      thread("fix", "Personal", { worktreePath: "/work/.worktrees/fix" }),
    );
    expect(keys(worktree.thread)).toContain("review");
  });

  it("offers a workspace thread New thread and Convert where Projects are supported", () => {
    const context = contextFor(website, thread("fix-hero", "website"));
    expect(context.leading.map((action) => action.title)).toEqual([
      "New thread in website",
      "Convert to Project…",
    ]);
    expect(keys(context.thread)).toEqual(["files", "terminal", "review", "copyThreadReference"]);
    expect(keys(contextFor(website, thread("fix-hero", "website"), false).leading)).toEqual([
      "newThread",
    ]);
  });

  it("keeps the thread actions while the open thread's shell loads", () => {
    const context = resolveContextualPaletteActions({
      activeProject: null,
      hasActiveThread: true,
      chrome: resolvePaletteThreadChrome({ project: null, threadId: null, worktreePath: null }),
      assistantsCapability: false,
      schedulesCapability: false,
    });
    expect(context.leading).toEqual([]);
    expect(keys(context.thread)).toContain("review");
    expect(
      resolveContextualPaletteActions({
        activeProject: null,
        hasActiveThread: false,
        chrome: { showPullRequestControls: true },
        assistantsCapability: true,
        schedulesCapability: true,
      }).thread,
    ).toEqual([]);
  });
});
