import { partitionAssistants } from "@t3tools/client-runtime/state/assistants";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingQueuedTask } from "../../state/use-pending-new-tasks";
import {
  assistantEnvironmentIds,
  buildHomeSections,
  folderMoveDestination,
  HOME_PROJECTS_SECTION_KEY,
  HOME_TASKS_SECTION_KEY,
  homeSectionItemsAreEqual,
  withSectionActions,
  type HomeSectionItem,
  type HomeSectionsInput,
} from "./homeSections";
import { buildSettledProjectGroups, buildSettledWorkspaceGroups } from "./settledThreads";

const env = EnvironmentId.make("env-1");
const otherEnv = EnvironmentId.make("env-2");
const NOW = "2026-09-28T12:00:00.000Z";
const LATER = "2026-09-29T09:00:00.000Z";

function project(
  id: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly coordinator?: string;
    readonly archivedAt?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: options.environmentId ?? env,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...(options.coordinator
      ? {
          assistant: {
            coordinatorThreadId: ThreadId.make(options.coordinator),
            ...(options.archivedAt ? { archivedAt: options.archivedAt } : {}),
          },
        }
      : {}),
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

function pendingTask(
  id: string,
  projectId: string,
  title = id,
  projectTitle?: string,
): PendingQueuedTask {
  const creation = {
    projectId: ProjectId.make(projectId),
    workspaceMode: "local" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId: env,
    projectId: creation.projectId,
    projectTitle,
    projectCwd: undefined,
    branch: null,
    title,
    createdAt: NOW,
    message: {
      environmentId: env,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: title,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

const running = { status: "running" } as unknown as EnvironmentThreadShell["session"];
const settled = { settledOverride: "settled" as const, settledAt: NOW };
const snoozed = { snoozedUntil: LATER, snoozedAt: NOW };
const pinned = (at: string) => ({ pinnedAt: at });

const personal = project("personal", { coordinator: "coordinator" });
const website = project("website");
const api = project("api");

/** Personal (a Project) with every kind of agent, and two Tasks workspaces. */
const fixtureThreads = [
  thread("coordinator", "personal", { title: "Personal" }),
  thread("sales", "personal", { ...pinned(NOW), title: "Sales" }),
  thread("flights", "personal", { session: running, title: "Compare flight options" }),
  thread("later", "personal", snoozed),
  thread("done", "personal", settled),
  thread("site-pinned", "website", { ...pinned(NOW), createdAt: "2026-09-02T00:00:00.000Z" }),
  thread("site-a", "website", { createdAt: "2026-09-03T00:00:00.000Z" }),
  thread("api-a", "api", { createdAt: "2026-09-04T00:00:00.000Z" }),
  thread("site-b", "website", { createdAt: "2026-09-05T00:00:00.000Z" }),
  thread("site-snoozed", "website", snoozed),
  thread("site-settled", "website", settled),
];

function input(
  overrides: Partial<HomeSectionsInput> & {
    readonly projects?: readonly EnvironmentProject[];
    readonly threads?: readonly EnvironmentThreadShell[];
  } = {},
): HomeSectionsInput {
  const { projects = [personal, website, api], threads = fixtureThreads, ...rest } = overrides;
  return {
    partition: partitionAssistants(projects, threads, null),
    threads,
    pendingTasks: [],
    environmentId: null,
    workspaceKey: null,
    searchQuery: "",
    projectGroupingMode: "separate",
    projectSortOrder: "updated_at",
    assistantsEnvironmentIds: new Set([env]),
    now: NOW,
    snoozedShelfExpanded: true,
    settledShelfExpanded: true,
    collapsedKeys: new Set(),
    expandedAssistantKeys: new Set(),
    selectedThreadKey: null,
    lastVisitedAtById: {},
    ...rest,
  };
}

const personalKey = "sidebar-assistant:env-1:personal";
/** The Workspace filter accepts a member project's scoped key. */
const websiteFilterKey = "env-1:website";
/** Folders collapse by their scope key. */
const websiteFolderKey = derivePhysicalProjectKey(website);
const apiFolderKey = derivePhysicalProjectKey(api);

/** A compact trace of the list: the type, plus the thread or folder it shows. */
function trace(items: readonly HomeSectionItem[]): string[] {
  return items.map((item) => {
    switch (item.type) {
      case "section":
        return `section:${item.section}${item.collapsed ? " (collapsed)" : ""}`;
      case "project":
        return `project:${item.project.id}${item.expanded ? " (open)" : ""}`;
      case "agent":
        return `agent:${item.item.thread.id}`;
      case "agent-pending":
        return `agent-pending:${item.pendingTask.title}`;
      case "folder":
        return `folder:${item.title}${item.collapsed ? " (collapsed)" : ""}`;
      case "v2-thread":
        return `task:${item.item.thread.id}`;
      case "v2-pending":
        return `pending:${item.pendingTask.title}`;
      default:
        return item.type;
    }
  });
}

describe("buildHomeSections partition", () => {
  it("renders the coordinator only as its Project row and agents only under it", () => {
    const { items } = buildHomeSections(input({ expandedAssistantKeys: new Set([personalKey]) }));
    expect(trace(items)).toEqual([
      "section:projects",
      "project:personal (open)",
      "agent:sales",
      "agent:flights",
      "agent:later",
      "section:tasks",
      "folder:api",
      "task:api-a",
      "folder:website",
      "task:site-pinned",
      "task:site-b",
      "task:site-a",
      "v2-snoozed-shelf",
      "task:site-snoozed",
      "v2-settled-shelf",
      "task:site-settled",
    ]);
  });

  it("keeps Project threads out of Tasks and the shelves even when snoozed or settled", () => {
    const { items } = buildHomeSections(input());
    const taskIds = items.flatMap((item) =>
      item.type === "v2-thread" ? [String(item.item.thread.id)] : [],
    );
    expect(taskIds).not.toContain("coordinator");
    expect(taskIds).not.toContain("later");
    expect(taskIds).not.toContain("done");
  });

  it("renders the threads of an archived Project nowhere", () => {
    const archived = project("archived", { coordinator: "archived-coordinator", archivedAt: NOW });
    const withArchived = input({
      projects: [personal, website, api, archived],
      threads: [
        ...fixtureThreads,
        thread("archived-coordinator", "archived"),
        thread("archived-agent", "archived"),
        thread("archived-settled", "archived", settled),
      ],
      pendingTasks: [pendingTask("archived-draft", "archived")],
    });
    const { items, jumpThreads } = buildHomeSections(withArchived);
    expect(trace(items)).toEqual(trace(buildHomeSections(input()).items));
    expect(jumpThreads.map((value) => value.id)).not.toContain("archived-agent");
  });
});

describe("buildHomeSections Projects section", () => {
  const plainOnly = { projects: [website], threads: [thread("site-a", "website")] };

  it("shows an empty row when the environment supports Projects but has none", () => {
    expect(trace(buildHomeSections(input(plainOnly)).items).slice(0, 2)).toEqual([
      "section:projects",
      "projects-empty",
    ]);
  });

  it("hides the section without the capability", () => {
    const { items } = buildHomeSections(
      input({ ...plainOnly, assistantsEnvironmentIds: new Set() }),
    );
    expect(trace(items)[0]).toBe("section:tasks");
  });

  it("explains when every connected server predates Projects", () => {
    const { items } = buildHomeSections(
      input({
        ...plainOnly,
        assistantsEnvironmentIds: new Set(),
        assistantsUnsupportedEnvironmentIds: new Set([env]),
      }),
    );
    expect(items[1]).toEqual({ type: "projects-empty", key: "projects-empty", unsupported: true });
  });

  it("offers New Project when any connected server supports Projects", () => {
    const { items } = buildHomeSections(
      input({ ...plainOnly, assistantsUnsupportedEnvironmentIds: new Set([otherEnv]) }),
    );
    expect(items[1]).toEqual({ type: "projects-empty", key: "projects-empty", unsupported: false });
  });

  it("explains for a filtered environment that predates Projects", () => {
    const { items } = buildHomeSections(
      input({
        ...plainOnly,
        environmentId: otherEnv,
        assistantsUnsupportedEnvironmentIds: new Set([otherEnv]),
      }),
    );
    expect(trace(items).slice(0, 2)).toEqual(["section:projects", "projects-empty"]);
    expect(items[1]).toMatchObject({ unsupported: true });
  });

  it("follows the filtered environment's capability", () => {
    const { items } = buildHomeSections(input({ ...plainOnly, environmentId: otherEnv }));
    expect(trace(items)).toEqual(["section:tasks", "tasks-empty"]);
  });

  it("keeps listed Projects while their environment reconnects", () => {
    const { items } = buildHomeSections(input({ assistantsEnvironmentIds: new Set() }));
    expect(trace(items).slice(0, 2)).toEqual(["section:projects", "project:personal"]);
  });

  it("is hidden under a Workspace filter", () => {
    const { items } = buildHomeSections(input({ workspaceKey: websiteFilterKey }));
    expect(trace(items)).toEqual([
      "section:tasks",
      "folder:website",
      "task:site-pinned",
      "task:site-b",
      "task:site-a",
      "v2-snoozed-shelf",
      "task:site-snoozed",
      "v2-settled-shelf",
      "task:site-settled",
    ]);
  });
});

describe("buildHomeSections Project rows", () => {
  it("starts collapsed, counts running agents without the coordinator, and rolls up a dot", () => {
    const threads = fixtureThreads.map((value) =>
      value.id === "coordinator" ? { ...value, session: running } : value,
    );
    const row = buildHomeSections(input({ threads })).items.find((item) => item.type === "project");
    expect(row).toMatchObject({ expanded: false, running: 1, rollup: "working" });
  });

  it("reads a missed schedule as a failed Project dot, below a working agent", () => {
    const withMissedSchedule: EnvironmentProject = {
      ...personal,
      assistant: {
        coordinatorThreadId: ThreadId.make("coordinator"),
        schedules: [
          {
            id: "morning-brief",
            name: "Morning brief",
            cron: "0 7 * * 1-5",
            target: "coordinator",
            enabled: true,
            createdBy: "user",
            updatedBy: "user",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        scheduleRuns: {
          "morning-brief": {
            slot: NOW,
            at: NOW,
            trigger: "cron",
            outcome: "missed",
            reason: "late",
          },
        },
      },
    };
    const projects = [withMissedSchedule, website, api];
    const idle = fixtureThreads.map((value) =>
      value.id === "flights" ? { ...value, session: null } : value,
    );
    const projectRow = (threads: readonly EnvironmentThreadShell[]) =>
      buildHomeSections(input({ projects, threads })).items.find((item) => item.type === "project");
    expect(projectRow(idle)).toMatchObject({ rollup: "failed" });
    expect(projectRow(fixtureThreads)).toMatchObject({ rollup: "working" });
    const { items } = buildHomeSections(
      input({ projects, threads: idle, collapsedKeys: new Set([HOME_PROJECTS_SECTION_KEY]) }),
    );
    expect(items[0]).toMatchObject({ type: "section", section: "projects", rollup: "failed" });
  });

  it("lists a Project whose coordinator shell has not arrived", () => {
    const { items, jumpThreads } = buildHomeSections(
      input({
        threads: fixtureThreads.filter((value) => value.id !== "coordinator"),
        expandedAssistantKeys: new Set([personalKey]),
      }),
    );
    const row = items.find((item) => item.type === "project");
    expect(row).toMatchObject({ coordinator: null, running: 1, rollup: "working" });
    expect(jumpThreads[0]?.id).toBe("sales");
  });

  it("puts unsent agents after the active agents and lists no settled agent under the Project", () => {
    const settledAgents = Array.from({ length: 12 }, (_, index) =>
      thread(`settled-${index}`, "personal", {
        ...settled,
        settledAt: `2026-09-2${index < 10 ? 0 : 1}T0${index % 10}:00:00.000Z`,
      }),
    );
    const traced = trace(
      buildHomeSections(
        input({
          threads: [...fixtureThreads, ...settledAgents],
          pendingTasks: [pendingTask("draft", "personal", "Book hotel")],
          expandedAssistantKeys: new Set([personalKey]),
        }),
      ).items,
    );
    expect(traced.slice(1, 6)).toEqual([
      "project:personal (open)",
      "agent:sales",
      "agent:flights",
      "agent-pending:Book hotel",
      "agent:later",
    ]);
    expect(
      traced.some((entry) => entry.startsWith("agent:settled-") || entry === "agent:done"),
    ).toBe(false);
    expect(traced.some((entry) => entry.startsWith("agent-settled"))).toBe(false);
  });

  it("keeps the open settled agent out of the Project list and leaves the Project closed", () => {
    const { items, selectionReveal } = buildHomeSections(
      input({
        selectedThreadKey: "env-1:done",
      }),
    );
    expect(trace(items)).not.toContain("agent:done");
    expect(selectionReveal).toBeNull();
  });

  it("marks standing agents and gives snoozed agents a wake label", () => {
    const { items } = buildHomeSections(
      input({ expandedAssistantKeys: new Set([personalKey]), snoozeLabelNow: NOW }),
    );
    const agents = items.flatMap((item) => (item.type === "agent" ? [item] : []));
    expect(
      agents.map((agent) => [agent.item.thread.id, agent.standing, agent.item.variant]),
    ).toEqual([
      ["sales", true, "card"],
      ["flights", false, "card"],
      ["later", false, "slim"],
    ]);
    expect(agents[2]?.snoozeWakeLabelText).toBeDefined();
  });
});

describe("buildHomeSections Tasks section", () => {
  it("shows every workspace, empty ones included, with unsent tasks after its rows", () => {
    const quiet = project("quiet");
    const { items } = buildHomeSections(
      input({
        projects: [personal, website, api, quiet],
        pendingTasks: [pendingTask("queued", "website", "Fix footer")],
        collapsedKeys: new Set([HOME_PROJECTS_SECTION_KEY]),
      }),
    );
    const shown = trace(items);
    expect(shown).toContain("folder:quiet");
    const folderIndex = shown.indexOf("folder:website");
    expect(shown.slice(folderIndex, folderIndex + 5)).toEqual([
      "folder:website",
      "task:site-pinned",
      "task:site-b",
      "task:site-a",
      "pending:Fix footer",
    ]);
  });

  it("draws no Unsent divider inside folders", () => {
    const { items } = buildHomeSections(
      input({
        pendingTasks: [
          pendingTask("queued", "website", "Fix footer"),
          pendingTask("queued-api", "api", "Add endpoint"),
        ],
      }),
    );
    const pending = items.filter((item) => item.type === "v2-pending");
    expect(pending).toHaveLength(2);
    expect(pending.some((item) => item.showPendingDivider)).toBe(false);
  });

  it("keeps unsent work visible when its workspace shell is missing", () => {
    const orphan = pendingTask("orphan", "gone", "orphan", "Gone");
    const { items } = buildHomeSections(input({ pendingTasks: [orphan] }));
    const folder = items.find((item) => item.type === "folder" && item.title === "Gone");
    expect(folder).toMatchObject({ newThreadTarget: null, count: 1, members: [] });
  });

  it("gives a grouped folder every checkout, for Convert to pick one", () => {
    const identity = {
      canonicalKey: "github.com/acme/site",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/site",
      },
    } as unknown as EnvironmentProject["repositoryIdentity"];
    const here = { ...website, repositoryIdentity: identity };
    const there = {
      ...project("website", { environmentId: otherEnv }),
      repositoryIdentity: identity,
    };
    const siteFolder = (projects: readonly EnvironmentProject[]) =>
      buildHomeSections(input({ projects, projectGroupingMode: "repository" })).items.find(
        (item) => item.type === "folder" && item.title !== "api",
      );
    const folder = siteFolder([personal, here, there, api]);
    expect(folder).toMatchObject({ members: [here, there] });

    // A changed checkout re-renders the folder, since its menu lists it.
    const moved = siteFolder([personal, here, { ...there, workspaceRoot: "/elsewhere" }, api]);
    expect(homeSectionItemsAreEqual(folder!, moved!)).toBe(false);
  });

  it("hides a collapsed folder's rows and shows its dot", () => {
    const threads = fixtureThreads.map((value) =>
      value.id === "site-a" ? { ...value, hasPendingApprovals: true } : value,
    );
    const { items } = buildHomeSections(
      input({ threads, collapsedKeys: new Set([websiteFolderKey]) }),
    );
    expect(trace(items)).not.toContain("task:site-a");
    expect(items.find((item) => item.type === "folder" && item.title === "website")).toMatchObject({
      collapsed: true,
      rollup: "approval",
      count: 3,
    });
  });

  it("says so when there are no workspaces", () => {
    const { items } = buildHomeSections(input({ projects: [], threads: [] }));
    expect(trace(items)).toEqual([
      "section:projects",
      "projects-empty",
      "section:tasks",
      "tasks-empty",
    ]);
  });

  it("pages the settled shelf behind Show more", () => {
    const { items, hiddenSettledCount } = buildHomeSections(
      input({
        threads: [...fixtureThreads, thread("site-settled-2", "website", settled)],
        settledLimit: 1,
      }),
    );
    expect(hiddenSettledCount).toBe(1);
    expect(items.at(-1)).toMatchObject({ type: "v2-show-more", hiddenCount: 1 });
  });
});

describe("buildHomeSections collapse and filters", () => {
  it("collapses a section to its header with the rolled-up dot", () => {
    const threads = fixtureThreads.map((value) =>
      value.id === "flights" ? { ...value, hasPendingUserInput: true } : value,
    );
    const { items, jumpThreads } = buildHomeSections(
      input({
        threads,
        collapsedKeys: new Set([HOME_PROJECTS_SECTION_KEY, HOME_TASKS_SECTION_KEY]),
      }),
    );
    expect(trace(items)).toEqual(["section:projects (collapsed)", "section:tasks (collapsed)"]);
    expect(items.map((item) => (item.type === "section" ? item.rollup : null))).toEqual([
      "input",
      null,
    ]);
    expect(jumpThreads).toEqual([]);
  });

  it("applies the Environment filter to both sections", () => {
    const remoteProject = project("remote", { environmentId: otherEnv, coordinator: "rc" });
    const remoteWorkspace = project("remote-site", { environmentId: otherEnv });
    const { items } = buildHomeSections(
      input({
        projects: [personal, website, remoteProject, remoteWorkspace],
        threads: [
          ...fixtureThreads,
          thread("rc", "remote", { environmentId: otherEnv }),
          thread("remote-a", "remote-site", { environmentId: otherEnv }),
        ],
        environmentId: otherEnv,
        assistantsEnvironmentIds: new Set([env, otherEnv]),
      }),
    );
    expect(trace(items)).toEqual([
      "section:projects",
      "project:remote",
      "section:tasks",
      "folder:remote-site",
      "task:remote-a",
    ]);
  });

  it("forces the filtered folder and the Tasks section open, with inert toggles", () => {
    const { items } = buildHomeSections(
      input({
        workspaceKey: websiteFilterKey,
        collapsedKeys: new Set([websiteFolderKey, HOME_TASKS_SECTION_KEY]),
      }),
    );
    expect(trace(items)).toContain("task:site-a");
    expect(items.find((item) => item.type === "section")).toMatchObject({
      section: "tasks",
      collapsed: false,
      forcedOpen: true,
    });
    expect(items.find((item) => item.type === "folder")).toMatchObject({
      collapsed: false,
      forcedOpen: true,
    });
  });

  it("leaves toggles live when nothing holds a group open", () => {
    const { items } = buildHomeSections(input());
    const toggles = items.filter(
      (item) => item.type === "section" || item.type === "project" || item.type === "folder",
    );
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggles.every((item) => !item.forcedOpen)).toBe(true);
  });
});

describe("buildHomeSections search", () => {
  it("filters both sections, forces them open, and drops empty groups", () => {
    const { items } = buildHomeSections(
      input({
        searchQuery: "flight",
        collapsedKeys: new Set([HOME_PROJECTS_SECTION_KEY, HOME_TASKS_SECTION_KEY]),
      }),
    );
    expect(trace(items)).toEqual(["section:projects", "project:personal (open)", "agent:flights"]);
    expect(
      items.every(
        (item) =>
          (item.type !== "section" && item.type !== "project" && item.type !== "folder") ||
          item.forcedOpen,
      ),
    ).toBe(true);
  });

  it("never shows a matching settled agent under its Project", () => {
    const { items } = buildHomeSections(input({ searchQuery: "done" }));
    expect(trace(items)).not.toContain("agent:done");
    expect(trace(items)).not.toContain("project:personal (open)");
  });

  it("matches a Project by its name or its coordinator, never as a thread row", () => {
    const byName = buildHomeSections(input({ searchQuery: "PERSONAL" })).items;
    expect(trace(byName)).toEqual(["section:projects", "project:personal (open)"]);
    const byMessage = buildHomeSections(
      input({
        searchQuery: "invoice",
        matchedThreadKeys: new Set(
          ["coordinator", "site-a"].map((id) =>
            threadSearchMatchKey({ environmentId: env, threadId: ThreadId.make(id) }),
          ),
        ),
      }),
    ).items;
    expect(trace(byMessage)).toEqual([
      "section:projects",
      "project:personal (open)",
      "section:tasks",
      "folder:website",
      "task:site-a",
    ]);
  });
});

describe("buildHomeSections jump order", () => {
  it("follows the visible order: coordinator, visible agents, then Tasks rows", () => {
    const { jumpThreads } = buildHomeSections(
      input({
        expandedAssistantKeys: new Set([personalKey]),
        collapsedKeys: new Set([apiFolderKey]),
      }),
    );
    expect(jumpThreads.map((value) => value.id)).toEqual([
      "coordinator",
      "sales",
      "flights",
      "later",
      "site-pinned",
      "site-b",
      "site-a",
      "site-snoozed",
      "site-settled",
    ]);
  });
});

describe("folderMoveDestination", () => {
  it("moves past the folder neighbor, not past another folder's thread in between", () => {
    // Global active order: site-b, api-a, site-a. The website folder holds site-b, site-a.
    const folder = ["env-1:site-b", "env-1:site-a"];
    expect(folderMoveDestination(folder, "env-1:site-a", "up")).toEqual({
      targetId: "env-1:site-b",
      placement: "before",
    });
    expect(folderMoveDestination(folder, "env-1:site-b", "down")).toEqual({
      targetId: "env-1:site-a",
      placement: "after",
    });
  });

  it("returns null at the folder's edges and for unknown rows", () => {
    const folder = ["env-1:site-b", "env-1:site-a"];
    expect(folderMoveDestination(folder, "env-1:site-b", "up")).toBeNull();
    expect(folderMoveDestination(folder, "env-1:site-a", "down")).toBeNull();
    expect(folderMoveDestination(folder, "env-1:api-a", "up")).toBeNull();
  });

  it("gives each Tasks row its folder-scoped moves inside its own block", () => {
    const rows = buildHomeSections(input()).items.flatMap((item) =>
      item.type === "v2-thread" ? [item] : [],
    );
    const move = (id: string) => {
      const row = rows.find((value) => value.item.thread.id === id);
      return [row?.moveUp?.targetId ?? null, row?.moveDown?.targetId ?? null];
    };
    // The pinned row never moves into the active block below it.
    expect(move("site-pinned")).toEqual([null, null]);
    expect(move("site-b")).toEqual([null, "env-1:site-a"]);
    expect(move("site-a")).toEqual(["env-1:site-b", null]);
    expect(move("site-snoozed")).toEqual([null, null]);
  });
});

describe("selection on the iPad", () => {
  it("reveals a selected agent's collapsed Project and section once", () => {
    expect(
      buildHomeSections(
        input({
          selectedThreadKey: "env-1:flights",
          collapsedKeys: new Set([HOME_PROJECTS_SECTION_KEY]),
        }),
      ).selectionReveal,
    ).toEqual({ collapsedKeys: [HOME_PROJECTS_SECTION_KEY], assistantKey: personalKey });
  });

  it("marks the coordinator's Project row selected and reveals a collapsed folder", () => {
    const coordinator = buildHomeSections(input({ selectedThreadKey: "env-1:coordinator" }));
    expect(coordinator.items.find((item) => item.type === "project")).toMatchObject({
      selected: true,
    });
    expect(coordinator.selectionReveal).toEqual({ collapsedKeys: [], assistantKey: null });
    expect(
      buildHomeSections(
        input({ selectedThreadKey: "env-1:site-a", collapsedKeys: new Set([websiteFolderKey]) }),
      ).selectionReveal,
    ).toEqual({ collapsedKeys: [websiteFolderKey], assistantKey: null });
    expect(
      buildHomeSections(input({ selectedThreadKey: "env-1:nope" })).selectionReveal,
    ).toBeNull();
  });
});

describe("homeSectionItemsAreEqual", () => {
  const pairs = (left: readonly HomeSectionItem[], right: readonly HomeSectionItem[]) =>
    left.map((item, index) => homeSectionItemsAreEqual(item, right[index]!));

  it("is true for every row of an unchanged rebuild", () => {
    const options = input({ expandedAssistantKeys: new Set([personalKey]) });
    const first = buildHomeSections(options).items;
    const second = buildHomeSections({ ...options }).items;
    expect(pairs(first, second).every(Boolean)).toBe(true);
  });

  it("is false for a row whose thread, dot or expansion changed", () => {
    const options = input();
    const before = buildHomeSections(options).items;
    const changedThread = buildHomeSections(
      input({
        threads: fixtureThreads.map((value) =>
          value.id === "site-a" ? { ...value, title: "renamed" } : value,
        ),
      }),
    ).items;
    const index = before.findIndex((item) => item.key === "v2-thread:env-1:site-a");
    expect(homeSectionItemsAreEqual(before[index]!, changedThread[index]!)).toBe(false);

    const projectIndex = before.findIndex((item) => item.type === "project");
    const expanded = buildHomeSections({
      ...options,
      expandedAssistantKeys: new Set([personalKey]),
    }).items;
    expect(homeSectionItemsAreEqual(before[projectIndex]!, expanded[projectIndex]!)).toBe(false);

    const working = buildHomeSections(
      input({
        threads: fixtureThreads.map((value) =>
          value.id === "sales" ? { ...value, session: running } : value,
        ),
      }),
    ).items;
    expect(homeSectionItemsAreEqual(before[projectIndex]!, working[projectIndex]!)).toBe(false);

    // An open folder that a filter starts holding open must re-render to go inert.
    const folderOf = (items: readonly HomeSectionItem[]) =>
      items.find((item) => item.key === `folder:${websiteFolderKey}`)!;
    const filtered = buildHomeSections({ ...options, workspaceKey: websiteFilterKey }).items;
    expect(homeSectionItemsAreEqual(folderOf(before), folderOf(filtered))).toBe(false);
  });
});

describe("withSectionActions", () => {
  const both = { newProject: true, addWorkspace: true };

  it("closes each open section, before the Tasks shelves", () => {
    const { items } = buildHomeSections(input({ workspaceKey: websiteFilterKey }));
    expect(trace(withSectionActions(items, both))).toEqual([
      "section:tasks",
      "folder:website",
      "task:site-pinned",
      "task:site-b",
      "task:site-a",
      "section-action",
      "v2-snoozed-shelf",
      "task:site-snoozed",
      "v2-settled-shelf",
      "task:site-settled",
    ]);
  });

  it("skips collapsed sections and actions the caller withholds", () => {
    const { items } = buildHomeSections(
      input({ collapsedKeys: new Set([HOME_TASKS_SECTION_KEY]) }),
    );
    const withActions = withSectionActions(items, { newProject: true, addWorkspace: true });
    expect(withActions.filter((item) => item.type === "section-action")).toEqual([
      { type: "section-action", key: "section-action:projects", action: "new-project" },
    ]);
    expect(
      withSectionActions(items, { newProject: false, addWorkspace: true }).some(
        (item) => item.type === "section-action",
      ),
    ).toBe(false);
  });

  it("offers no New Project when the server predates Projects", () => {
    const { items } = buildHomeSections(
      input({
        projects: [website],
        threads: [thread("site-a", "website")],
        assistantsEnvironmentIds: new Set(),
        assistantsUnsupportedEnvironmentIds: new Set([env]),
      }),
    );
    expect(trace(withSectionActions(items, both)).slice(0, 3)).toEqual([
      "section:projects",
      "projects-empty",
      "section:tasks",
    ]);
  });
});

describe("cold launch from the cached shell", () => {
  const config = (assistants: boolean) =>
    ({ environment: { capabilities: { assistants } } }) as unknown as ServerConfig;
  const disconnected = new Set<EnvironmentId>();

  it("takes Projects support from a cached config before the socket connects", () => {
    expect(assistantEnvironmentIds(new Map([[env, config(true)]]), disconnected)).toEqual({
      assistants: new Set([env]),
      assistantsUnsupported: new Set(),
    });
    // Only a connected server's config can say it predates Projects.
    expect(assistantEnvironmentIds(new Map([[env, config(false)]]), disconnected)).toEqual({
      assistants: new Set(),
      assistantsUnsupported: new Set(),
    });
    expect(assistantEnvironmentIds(new Map([[env, config(false)]]), new Set([env]))).toEqual({
      assistants: new Set(),
      assistantsUnsupported: new Set([env]),
    });
  });

  it("lists the Projects and New Project in the same first pass", () => {
    const capabilities = assistantEnvironmentIds(new Map([[env, config(true)]]), disconnected);
    const { items } = buildHomeSections(
      input({
        assistantsEnvironmentIds: capabilities.assistants,
        assistantsUnsupportedEnvironmentIds: capabilities.assistantsUnsupported,
      }),
    );
    const listed = withSectionActions(items, {
      newProject: capabilities.assistants.size > 0,
      addWorkspace: true,
    });
    expect(trace(listed).slice(0, 4)).toEqual([
      "section:projects",
      "project:personal",
      "section-action",
      "section:tasks",
    ]);
    expect(listed[2]).toEqual({
      type: "section-action",
      key: "section-action:projects",
      action: "new-project",
    });
  });
});

describe("Settled off Home", () => {
  it("drops the Settled shelf and its rows", () => {
    const { items } = buildHomeSections(input({ settledShelf: false }));
    const traced = trace(items);
    expect(traced).not.toContain("v2-settled-shelf");
    expect(traced).not.toContain("task:site-settled");
    expect(traced).toContain("v2-snoozed-shelf");
  });

  it("groups settled Tasks threads under their workspace, newest first", () => {
    const groups = buildSettledWorkspaceGroups({
      projects: [website, api],
      threads: [
        thread("site-a", "website"),
        thread("site-old", "website", settled),
        thread("api-new", "api", { settledOverride: "settled", settledAt: LATER }),
        thread("site-new", "website", { settledOverride: "settled", settledAt: LATER }),
      ],
      projectGroupingMode: "separate",
      now: LATER,
    });
    expect(
      groups.map((group) => [group.title, group.threads.map((item) => String(item.id))]),
    ).toEqual([
      ["api", ["api-new"]],
      ["website", ["site-new", "site-old"]],
    ]);
  });

  it("groups settled Project agents by Project, newest first, skipping Projects with none", () => {
    const partition = partitionAssistants(
      [personal, website, api],
      [
        ...fixtureThreads,
        thread("done-new", "personal", { settledOverride: "settled", settledAt: LATER }),
      ],
      null,
    );
    const groups = buildSettledProjectGroups({ assistants: partition.assistants, now: LATER });
    expect(
      groups.map((group) => [group.project.title, group.threads.map((item) => String(item.id))]),
    ).toEqual([[personal.title, ["done-new", "done"]]]);
  });

  it("leaves snoozed, active and unsupported agents out of the Project groups", () => {
    const partition = partitionAssistants([personal], fixtureThreads, null);
    expect(
      buildSettledProjectGroups({
        assistants: partition.assistants,
        settlementEnvironmentIds: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
  });
});
