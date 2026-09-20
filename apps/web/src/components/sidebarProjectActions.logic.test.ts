import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectFolderActionMenuItems,
  buildRemoveProjectConfirmMessage,
  formatProjectMemberActionLabel,
  resolveProjectFolderMenuAction,
  routeBelongsToProjectMembers,
  type ProjectFolderMenuMember,
} from "./sidebarProjectActions.logic";

const localMember: ProjectFolderMenuMember = {
  physicalProjectKey: "local:alpha",
  title: "alpha",
  workspaceRoot: "/Users/nick/Code/alpha",
  environmentLabel: "This device",
};

const remoteMember: ProjectFolderMenuMember = {
  physicalProjectKey: "remote:alpha",
  title: "alpha",
  workspaceRoot: "/home/nick/alpha",
  environmentLabel: "studio",
};

function ids(items: ReturnType<typeof buildProjectFolderActionMenuItems>): string[] {
  const flatten = (entries: ReturnType<typeof buildProjectFolderActionMenuItems>): string[] =>
    entries.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(items);
}

describe("buildProjectFolderActionMenuItems", () => {
  it("offers settings, copy path, and remove for a single checkout", () => {
    const items = buildProjectFolderActionMenuItems({
      memberProjects: [localMember],
      groupedProjectCount: 1,
    });
    expect(ids(items)).toEqual(["project-settings", "copy-path", "delete"]);
    expect(items[2]).toMatchObject({
      id: "delete",
      label: "Remove",
      destructive: true,
      icon: "trash",
      separatorBefore: true,
    });
  });

  it("nests copy path and remove under each grouped checkout", () => {
    const items = buildProjectFolderActionMenuItems({
      memberProjects: [localMember, remoteMember],
      groupedProjectCount: 2,
    });
    expect(ids(items)).toEqual([
      "project-settings",
      "copy-path",
      "copy-path:local:alpha",
      "copy-path:remote:alpha",
      "delete",
      "delete:local:alpha",
      "delete:remote:alpha",
    ]);
    expect(items[2]).toMatchObject({
      id: "delete",
      label: "Remove",
      icon: "trash",
      separatorBefore: true,
    });
    expect(items[2]?.destructive).toBeUndefined();
    expect(items[2]?.children?.[1]).toMatchObject({
      id: "delete:remote:alpha",
      label: "studio: /home/nick/alpha",
      destructive: true,
    });
  });
});

describe("resolveProjectFolderMenuAction", () => {
  it("targets the only checkout from a leaf action", () => {
    const project = { memberProjects: [localMember] };
    expect(resolveProjectFolderMenuAction(project, "project-settings")).toEqual({
      kind: "project-settings",
    });
    expect(resolveProjectFolderMenuAction(project, "copy-path")).toEqual({
      kind: "copy-path",
      member: localMember,
    });
    expect(resolveProjectFolderMenuAction(project, "delete")).toEqual({
      kind: "delete",
      members: [localMember],
    });
  });

  it("ignores parent copy and remove ids when the folder is grouped", () => {
    const project = { memberProjects: [localMember, remoteMember] };
    expect(resolveProjectFolderMenuAction(project, "copy-path")).toBeNull();
    expect(resolveProjectFolderMenuAction(project, "delete")).toBeNull();
    expect(resolveProjectFolderMenuAction(project, "delete:remote:alpha")).toEqual({
      kind: "delete",
      members: [remoteMember],
    });
  });
});

describe("formatProjectMemberActionLabel", () => {
  it("uses the path when a grouped checkout has no environment label", () => {
    expect(formatProjectMemberActionLabel({ ...remoteMember, environmentLabel: null }, 2)).toBe(
      "/home/nick/alpha",
    );
  });
});

describe("buildRemoveProjectConfirmMessage", () => {
  it("names a single empty project and keeps files on disk", () => {
    expect(
      buildRemoveProjectConfirmMessage({
        members: [localMember],
        groupDisplayName: "alpha",
        groupMemberCount: 1,
        threadCount: 0,
        hasOtherMembers: false,
      }),
    ).toBe(
      [
        'Remove project "alpha"?',
        "Path: /Users/nick/Code/alpha",
        "Environment: This device",
        "This permanently clears any archived conversation history.",
        "This removes only the project entries, not the files on disk.",
        "This action cannot be undone.",
      ].join("\n"),
    );
  });

  it("counts threads when removing one checkout from a group", () => {
    expect(
      buildRemoveProjectConfirmMessage({
        members: [remoteMember],
        groupDisplayName: "alpha",
        groupMemberCount: 2,
        threadCount: 3,
        hasOtherMembers: false,
      }),
    ).toBe(
      [
        'Remove checkout "alpha" and delete its 3 threads?',
        "Path: /home/nick/alpha",
        "Environment: studio",
        "This permanently clears conversation history for those threads and any archived threads.",
        "Other entries in this grouped project are unaffected.",
        "This action cannot be undone.",
      ].join("\n"),
    );
  });

  it("describes removing every grouped checkout at once", () => {
    expect(
      buildRemoveProjectConfirmMessage({
        members: [localMember, remoteMember],
        groupDisplayName: "alpha",
        groupMemberCount: 2,
        threadCount: 1,
        hasOtherMembers: false,
      }),
    ).toContain("This removes 2 grouped project entries.");
  });
});

describe("routeBelongsToProjectMembers", () => {
  it("matches a thread or draft on a removed checkout", () => {
    const members = [
      { environmentId: "env-1", id: "proj-1" },
      { environmentId: "env-2", id: "proj-2" },
    ];
    expect(
      routeBelongsToProjectMembers({
        members,
        routeThread: { environmentId: "env-2", projectId: "proj-2" },
        routeDraft: null,
      }),
    ).toBe(true);
    expect(
      routeBelongsToProjectMembers({
        members,
        routeThread: null,
        routeDraft: { environmentId: "env-1", projectId: "proj-1" },
      }),
    ).toBe(true);
    expect(
      routeBelongsToProjectMembers({
        members,
        routeThread: { environmentId: "env-1", projectId: "other" },
        routeDraft: null,
      }),
    ).toBe(false);
  });
});
