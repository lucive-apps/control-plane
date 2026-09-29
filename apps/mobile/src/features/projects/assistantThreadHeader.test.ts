import { describe, expect, it } from "vite-plus/test";

import { resolveAssistantHeaderActions } from "./assistantThreadHeader";

describe("resolveAssistantHeaderActions", () => {
  const base = { isStanding: false, worktreePath: null, isGitRepo: true, canSchedule: true };

  it("gives the coordinator Memory, Schedules and the Project menu, with git hidden", () => {
    expect(resolveAssistantHeaderActions({ ...base, role: "coordinator" })).toEqual({
      showGitControls: false,
      memory: true,
      schedules: true,
      projectMenu: true,
      openProject: false,
    });
  });

  it("offers Schedules only when the coordinator's server stores them", () => {
    expect(
      resolveAssistantHeaderActions({ ...base, role: "coordinator", canSchedule: false }),
    ).toMatchObject({ memory: true, schedules: false, projectMenu: true });
    expect(resolveAssistantHeaderActions({ ...base, role: "agent" }).schedules).toBe(false);
  });

  it("gives a Local agent a way to its Project, with git hidden", () => {
    for (const isStanding of [false, true]) {
      expect(resolveAssistantHeaderActions({ ...base, role: "agent", isStanding })).toEqual({
        showGitControls: false,
        memory: false,
        schedules: false,
        projectMenu: false,
        openProject: true,
      });
    }
  });

  it("keeps git for an agent that works in a worktree", () => {
    expect(
      resolveAssistantHeaderActions({
        ...base,
        role: "agent",
        worktreePath: "/repo/.worktrees/sales",
      }),
    ).toEqual({
      showGitControls: true,
      memory: false,
      schedules: false,
      projectMenu: false,
      openProject: true,
    });
  });

  it("adds nothing to a plain thread and keeps its git controls", () => {
    expect(resolveAssistantHeaderActions({ ...base, role: null })).toEqual({
      showGitControls: true,
      memory: false,
      schedules: false,
      projectMenu: false,
      openProject: false,
    });
  });

  it("hides git for a plain thread whose folder is not a git repository", () => {
    expect(resolveAssistantHeaderActions({ ...base, role: null, isGitRepo: false })).toEqual({
      showGitControls: false,
      memory: false,
      schedules: false,
      projectMenu: false,
      openProject: false,
    });
  });
});
