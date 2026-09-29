import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  convertSummary,
  countRunningAgents,
  defaultProjectFolder,
  localCoordinatorCandidates,
  partitionAssistants,
  planAssistantScaffold,
  rollupAssistantStatus,
  sectionAssistantAgents,
  selectWorkspaceProjects,
} from "./assistants.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { derivePhysicalProjectKey } from "./projectGrouping.ts";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const NOW = "2026-09-28T12:00:00.000Z";

function project(
  id: string,
  overrides: Partial<EnvironmentProject> & { coordinator?: string; archivedAt?: string } = {},
): EnvironmentProject {
  const { coordinator, archivedAt, ...rest } = overrides;
  return {
    environmentId: primary,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...(coordinator
      ? {
          assistant: {
            coordinatorThreadId: ThreadId.make(coordinator),
            ...(archivedAt ? { archivedAt } : {}),
          },
        }
      : {}),
    ...rest,
  };
}

function thread(
  id: string,
  projectId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: primary,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
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

function session(status: "starting" | "running" | "ready" | "error") {
  return { status } as unknown as EnvironmentThreadShell["session"];
}

describe("partitionAssistants", () => {
  it("keeps the input arrays when no Project exists", () => {
    const projects = [project("web")];
    const threads = [thread("t1", "web")];
    const partition = partitionAssistants(projects, threads, primary);
    expect(partition.assistants).toEqual([]);
    expect(partition.workspaceProjects).toBe(projects);
    expect(partition.workspaceThreads).toBe(threads);
    expect(selectWorkspaceProjects(projects)).toBe(projects);
  });

  it("routes Project threads to their Project and hides archived Projects", () => {
    const personal = project("personal", { coordinator: "coord" });
    const archived = project("old", { coordinator: "old-coord", archivedAt: NOW });
    const web = project("web");
    const threads = [
      thread("coord", "personal"),
      thread("sales", "personal"),
      thread("gone", "personal", { archivedAt: NOW }),
      thread("old-coord", "old"),
      thread("old-agent", "old"),
      thread("task", "web"),
    ];

    const partition = partitionAssistants([personal, archived, web], threads, primary);

    expect(partition.workspaceProjects).toEqual([web]);
    expect(partition.workspaceThreads.map((entry) => entry.id)).toEqual(["task"]);
    expect(partition.assistants).toHaveLength(1);
    expect(partition.assistants[0]).toMatchObject({
      project: personal,
      projectKey: derivePhysicalProjectKey(personal),
      coordinator: { id: "coord" },
    });
    expect(partition.assistants[0]?.agents.map((entry) => entry.id)).toEqual(["sales"]);
    expect(partition.archivedAssistants.map((entry) => entry.project.id)).toEqual(["old"]);
    expect(partition.archivedAssistants[0]?.agents.map((entry) => entry.id)).toEqual(["old-agent"]);
  });

  it("orders the primary environment first, then by title", () => {
    const projects = [
      project("zeta", { coordinator: "z" }),
      project("alpha-remote", { coordinator: "a", environmentId: remote, title: "Alpha" }),
      project("beta", { coordinator: "b", title: "Beta" }),
      project("alpha", { coordinator: "c", title: "Alpha" }),
    ];
    const titles = partitionAssistants(projects, [], primary).assistants.map(
      (entry) => `${entry.project.environmentId}:${entry.project.title}`,
    );
    expect(titles).toEqual(["primary:Alpha", "primary:Beta", "primary:zeta", "remote:Alpha"]);
  });

  it("matches threads by environment as well as project id", () => {
    const personal = project("shared", { coordinator: "coord" });
    const remoteThread = thread("remote-task", "shared", { environmentId: remote });
    const partition = partitionAssistants([personal], [remoteThread], primary);
    expect(partition.workspaceThreads).toEqual([remoteThread]);
    expect(partition.assistants[0]?.coordinator).toBeNull();
  });
});

describe("sectionAssistantAgents", () => {
  const options = { now: NOW, supportsSnooze: true, supportsSettlement: true };

  it("applies snoozed, then settled, then pinned precedence", () => {
    const sections = sectionAssistantAgents(
      [
        thread("pinned-snoozed", "p", {
          pinnedAt: NOW,
          snoozedUntil: "2026-09-29T00:00:00.000Z",
          snoozedAt: NOW,
        }),
        thread("pinned-settled", "p", { pinnedAt: NOW, settledOverride: "settled" }),
        thread("pinned", "p", { pinnedAt: NOW }),
        thread("active", "p"),
        thread("woke", "p", { snoozedUntil: "2026-09-27T00:00:00.000Z", snoozedAt: NOW }),
      ],
      options,
    );
    expect(sections.snoozed.map((entry) => entry.id)).toEqual(["pinned-snoozed"]);
    expect(sections.settled.map((entry) => entry.id)).toEqual(["pinned-settled"]);
    expect(sections.standing.map((entry) => entry.id)).toEqual(["pinned"]);
    expect(sections.active.map((entry) => entry.id).toSorted()).toEqual(["active", "woke"]);
  });

  it("ignores snooze and settlement the environment does not support", () => {
    const sections = sectionAssistantAgents(
      [
        thread("snoozed", "p", { snoozedUntil: "2026-09-29T00:00:00.000Z", snoozedAt: NOW }),
        thread("settled", "p", { settledOverride: "settled" }),
      ],
      { now: NOW, supportsSnooze: false, supportsSettlement: false },
    );
    expect(sections.snoozed).toEqual([]);
    expect(sections.settled).toEqual([]);
    expect(sections.active).toHaveLength(2);
  });

  it("orders snoozed by soonest wake and settled by latest settle", () => {
    const sections = sectionAssistantAgents(
      [
        thread("late-wake", "p", { snoozedUntil: "2026-09-30T00:00:00.000Z", snoozedAt: NOW }),
        thread("early-wake", "p", { snoozedUntil: "2026-09-29T00:00:00.000Z", snoozedAt: NOW }),
        thread("old-settle", "p", {
          settledOverride: "settled",
          settledAt: "2026-09-01T00:00:00.000Z",
        }),
        thread("new-settle", "p", {
          settledOverride: "settled",
          settledAt: "2026-09-20T00:00:00.000Z",
        }),
      ],
      options,
    );
    expect(sections.snoozed.map((entry) => entry.id)).toEqual(["early-wake", "late-wake"]);
    expect(sections.settled.map((entry) => entry.id)).toEqual(["new-settle", "old-settle"]);
  });
});

describe("countRunningAgents", () => {
  it("counts live and blocked agents, not ready or failed ones", () => {
    const personal = project("personal", { coordinator: "coord" });
    const threads = [
      thread("coord", "personal", { session: session("running") }),
      thread("starting", "personal", { session: session("starting") }),
      thread("running", "personal", { session: session("running") }),
      thread("approval", "personal", { hasPendingApprovals: true }),
      thread("input", "personal", { hasPendingUserInput: true }),
      thread("ready", "personal", { session: session("ready") }),
      thread("failed", "personal", { session: session("error") }),
    ];
    const [entry] = partitionAssistants([personal], threads, primary).assistants;
    expect(countRunningAgents(entry!.agents)).toBe(4);
  });
});

describe("rollupAssistantStatus", () => {
  it("puts failed below working and above monitoring", () => {
    expect(
      rollupAssistantStatus({
        statuses: ["ready", "failed", "working"],
        coordinatorUnread: false,
        agentsUnread: false,
      }),
    ).toBe("working");
    expect(
      rollupAssistantStatus({
        statuses: ["monitoring", "failed"],
        coordinatorUnread: true,
        agentsUnread: false,
      }),
    ).toBe("failed");
    expect(
      rollupAssistantStatus({
        statuses: ["working", "input", "approval"],
        coordinatorUnread: false,
        agentsUnread: false,
      }),
    ).toBe("approval");
  });

  it("falls back to coordinator unread only when nothing is live", () => {
    expect(
      rollupAssistantStatus({ statuses: ["ready"], coordinatorUnread: true, agentsUnread: false }),
    ).toBe("unread");
    expect(
      rollupAssistantStatus({ statuses: ["ready"], coordinatorUnread: true, agentsUnread: true }),
    ).toBe("unread");
    // Agent results reach the coordinator, so an unread agent alone lights nothing.
    expect(
      rollupAssistantStatus({ statuses: ["ready"], coordinatorUnread: false, agentsUnread: true }),
    ).toBeNull();
    expect(
      rollupAssistantStatus({ statuses: [], coordinatorUnread: false, agentsUnread: false }),
    ).toBeNull();
  });
});

describe("planAssistantScaffold", () => {
  it("writes every file into an empty folder", () => {
    expect(planAssistantScaffold({ existingNames: [], instructions: "  Be brief.  " })).toEqual([
      { relativePath: "AGENTS.md", contents: "Be brief.\n" },
      { relativePath: "CLAUDE.md", contents: "@AGENTS.md\n" },
      { relativePath: "MEMORY.md", contents: expect.stringContaining("# Memory") },
    ]);
  });

  it("writes only missing files, matching names case-insensitively", () => {
    const files = planAssistantScaffold({
      existingNames: ["agents.md", "MEMORY.md", "src"],
      instructions: "ignored",
    });
    expect(files.map((file) => file.relativePath)).toEqual(["CLAUDE.md"]);
  });
});

describe("defaultProjectFolder", () => {
  it("falls back to project when the name has no ASCII slug", () => {
    expect(
      defaultProjectFolder({ parentPath: "/Users/n/Projects", existingNames: [], name: "日本" }),
    ).toBe("/Users/n/Projects/project");
    expect(
      defaultProjectFolder({
        parentPath: "/Users/n/Projects/",
        existingNames: [],
        name: "Café Ops",
      }),
    ).toBe("/Users/n/Projects/cafe-ops");
  });

  it("suffixes collisions with -2, -3", () => {
    expect(
      defaultProjectFolder({
        parentPath: "/Users/n/Projects",
        existingNames: ["personal", "Personal-2"],
        name: "Personal",
      }),
    ).toBe("/Users/n/Projects/personal-3");
    expect(
      defaultProjectFolder({ parentPath: "C:\\Users\\n", existingNames: [], name: "Work" }),
    ).toBe("C:\\Users\\n\\work");
  });
});

describe("Convert helpers", () => {
  const threads = [
    thread("coord", "w"),
    thread("pinned", "w", { pinnedAt: NOW }),
    thread("plain", "w"),
    thread("worktree", "w", { worktreePath: "/wt/one", pinnedAt: NOW }),
    thread("archived", "w", { archivedAt: NOW }),
  ];

  it("counts agents and standing agents, excluding the coordinator and archived threads", () => {
    expect(convertSummary(threads, null)).toEqual({ agents: 4, standing: 2 });
    expect(convertSummary(threads, ThreadId.make("pinned"))).toEqual({ agents: 3, standing: 1 });
  });

  it("offers only live Local threads as coordinators", () => {
    expect(
      localCoordinatorCandidates(threads)
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["coord", "pinned", "plain"]);
  });
});
