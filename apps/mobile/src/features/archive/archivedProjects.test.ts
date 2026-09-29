import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedAgeLabel,
  countProjectAgents,
  selectArchivedProjectRows,
} from "./archivedProjects";

const hostA = EnvironmentId.make("host-a");
const hostB = EnvironmentId.make("host-b");
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly environmentId?: EnvironmentId;
  readonly archivedAt?: string;
}) {
  return {
    environmentId: input.environmentId ?? hostA,
    id: ProjectId.make(input.id),
    title: input.title,
    workspaceRoot: `/Users/n/Projects/${input.id}`,
    assistant: {
      coordinatorThreadId: ThreadId.make(`${input.id}-coordinator`),
      ...(input.archivedAt === undefined ? {} : { archivedAt: input.archivedAt }),
    },
  };
}

const renovation = project({
  id: "home-renovation",
  title: "Home renovation",
  archivedAt: "2026-09-26T12:00:00.000Z",
});
const personal = project({
  id: "personal",
  title: "Personal",
  environmentId: hostB,
  archivedAt: "2026-09-28T11:59:30.000Z",
});
const work = project({
  id: "work",
  title: "Work",
  archivedAt: "2026-09-28T09:00:00.000Z",
});
const live = project({ id: "live", title: "Live" });
const plainWorkspace = {
  environmentId: hostA,
  id: ProjectId.make("repo"),
  title: "Repo",
  workspaceRoot: "/Users/n/Code/repo",
};

describe("selectArchivedProjectRows", () => {
  it("lists only archived Projects, most recently archived first, with ages", () => {
    const rows = selectArchivedProjectRows({
      projects: [renovation, live, personal, plainWorkspace, work],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(rows.map(({ title, ageLabel }) => [title, ageLabel])).toEqual([
      ["Personal", "now"],
      ["Work", "3h"],
      ["Home renovation", "2d"],
    ]);
    expect(rows[0]?.project).toBe(personal);
    expect(rows[0]?.key).toBe("host-b:personal");
  });

  it("follows the screen's oldest-first sort", () => {
    const rows = selectArchivedProjectRows({
      projects: [personal, renovation, work],
      environmentId: null,
      searchQuery: "",
      sortOrder: "oldest",
      now: NOW,
    });
    expect(rows.map((row) => row.title)).toEqual(["Home renovation", "Work", "Personal"]);
  });

  it("keeps only the filtered environment", () => {
    const rows = selectArchivedProjectRows({
      projects: [renovation, personal, work],
      environmentId: hostB,
      searchQuery: "",
      now: NOW,
    });
    expect(rows.map((row) => row.title)).toEqual(["Personal"]);
  });

  it("matches the search against the name and folder, ignoring case", () => {
    const byName = selectArchivedProjectRows({
      projects: [renovation, personal, work],
      environmentId: null,
      searchQuery: "  RENOV ",
      now: NOW,
    });
    expect(byName.map((row) => row.title)).toEqual(["Home renovation"]);
    const byFolder = selectArchivedProjectRows({
      projects: [renovation, personal, work],
      environmentId: null,
      searchQuery: "projects/work",
      now: NOW,
    });
    expect(byFolder.map((row) => row.title)).toEqual(["Work"]);
  });
});

describe("countProjectAgents", () => {
  const thread = (
    id: string,
    overrides: { projectId?: string; archivedAt?: string | null } = {},
  ) => ({
    environmentId: hostA,
    projectId: overrides.projectId ?? "home-renovation",
    id,
    archivedAt: overrides.archivedAt ?? null,
  });

  it("counts the Project's unarchived threads other than the coordinator", () => {
    const threads = [
      thread("home-renovation-coordinator"),
      thread("sales"),
      thread("plumber"),
      thread("old", { archivedAt: "2026-09-20T00:00:00.000Z" }),
      thread("elsewhere", { projectId: "work" }),
      { ...thread("other-host"), environmentId: hostB },
    ];
    expect(countProjectAgents(threads, renovation)).toBe(2);
    expect(countProjectAgents([], renovation)).toBe(0);
  });
});

describe("archivedAgeLabel", () => {
  it("steps from now through minutes, hours and days", () => {
    expect(archivedAgeLabel(NOW - 30_000, NOW)).toBe("now");
    expect(archivedAgeLabel(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(archivedAgeLabel(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(archivedAgeLabel(NOW - 49 * 3_600_000, NOW)).toBe("2d");
    // A clock skewed behind the host never shows a negative age.
    expect(archivedAgeLabel(NOW + 60_000, NOW)).toBe("now");
  });
});
