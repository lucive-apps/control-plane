import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentMessagePresentation,
  resolveAssistantThreadChrome,
  showsTurnMinimap,
} from "./assistantThreadView.logic";

describe("resolveAssistantThreadChrome", () => {
  const base = { isStanding: false, isGitRepo: true, worktreePath: null };

  it("keeps every control for a thread outside a Project", () => {
    expect(resolveAssistantThreadChrome({ ...base, role: null })).toEqual({
      showGitControls: true,
      showPullRequestControls: true,
      supportsMultipleModels: true,
      keybindingSettle: true,
      keybindingPin: true,
    });
  });

  it("gives the coordinator no git or PR controls", () => {
    expect(resolveAssistantThreadChrome({ ...base, role: "coordinator" })).toEqual({
      showGitControls: false,
      showPullRequestControls: false,
      supportsMultipleModels: false,
      keybindingSettle: false,
      keybindingPin: false,
    });
  });

  it("hides git and PR controls for a Local agent", () => {
    expect(resolveAssistantThreadChrome({ ...base, role: "agent" })).toMatchObject({
      showGitControls: false,
      showPullRequestControls: false,
    });
  });

  it("keeps git and PR controls for an agent that already works in a worktree", () => {
    const chrome = resolveAssistantThreadChrome({
      ...base,
      role: "agent",
      worktreePath: "/repo/.worktrees/sales",
    });
    expect(chrome).toMatchObject({ showGitControls: true, showPullRequestControls: true });
    // Git controls still need a repository; PR controls do not depend on it here.
    expect(
      resolveAssistantThreadChrome({
        ...base,
        role: "agent",
        worktreePath: "/repo/.worktrees/sales",
        isGitRepo: false,
      }),
    ).toMatchObject({ showGitControls: false, showPullRequestControls: true });
  });

  it("turns multi-model fanout off for every Project thread", () => {
    for (const input of [
      { ...base, role: "coordinator" as const },
      { ...base, role: "agent" as const },
      { ...base, role: "agent" as const, isStanding: true },
      { ...base, role: "agent" as const, worktreePath: "/repo/.worktrees/sales" },
    ]) {
      expect(resolveAssistantThreadChrome(input).supportsMultipleModels).toBe(false);
    }
  });

  it("allows the settle keybinding only where the thread can settle", () => {
    const settle = (role: "coordinator" | "agent" | null, isStanding: boolean) =>
      resolveAssistantThreadChrome({ ...base, role, isStanding }).keybindingSettle;
    expect(settle("coordinator", false)).toBe(false);
    expect(settle("agent", true)).toBe(false);
    expect(settle("agent", false)).toBe(true);
    // A pinned thread in a plain workspace still settles.
    expect(settle(null, true)).toBe(true);
  });

  it("allows the pin keybinding everywhere except on the coordinator", () => {
    const pin = (role: "coordinator" | "agent" | null, isStanding: boolean) =>
      resolveAssistantThreadChrome({ ...base, role, isStanding }).keybindingPin;
    expect(pin("coordinator", false)).toBe(false);
    expect(pin("agent", false)).toBe(true);
    expect(pin("agent", true)).toBe(true);
    expect(pin(null, false)).toBe(true);
  });
});

describe("showsTurnMinimap", () => {
  it("drops the minimap for the coordinator only", () => {
    expect(showsTurnMinimap("coordinator")).toBe(false);
    expect(showsTurnMinimap("agent")).toBe(true);
    expect(showsTurnMinimap(null)).toBe(true);
  });
});

describe("resolveAgentMessagePresentation", () => {
  const coordinatorThreadId = ThreadId.make("thread-coordinator");
  const salesThreadId = ThreadId.make("thread-sales");
  const outsiderThreadId = ThreadId.make("thread-outside");
  const projectThreadTitles = new Map([
    [coordinatorThreadId, "Personal"],
    [salesThreadId, "Sales"],
  ]);
  const timeline = (role: "coordinator" | "agent") => ({
    role,
    coordinatorThreadId,
    project: { title: "Personal" },
    projectThreadTitle: (threadId: ThreadId) => projectThreadTitles.get(threadId) ?? null,
  });
  const fromThread = (threadId: ThreadId, threadTitle: string) => ({
    role: "user",
    source: { kind: "agent" as const, threadId, threadTitle },
  });

  it("attributes the coordinator's message in an agent thread to the Project", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(coordinatorThreadId, "Personal"),
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({
      kind: "attributed-user",
      displayName: "Personal",
      linkThreadId: coordinatorThreadId,
    });
  });

  it("leaves other agents' messages in an agent thread as default rows", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(salesThreadId, "Sales"),
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "default" });
  });

  it("labels a message from one of the Project's agents as a reply in the coordinator", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(salesThreadId, "Sales"),
        assistantTimeline: timeline("coordinator"),
      }),
    ).toEqual({ kind: "replied", displayName: "Sales", linkThreadId: salesThreadId });
  });

  it("names the replying agent by its current title, not the one it sent with", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(salesThreadId, "New thread"),
        assistantTimeline: timeline("coordinator"),
      }),
    ).toMatchObject({ kind: "replied", displayName: "Sales" });
  });

  it("keeps the default row for a sender outside the Project", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(outsiderThreadId, "Elsewhere"),
        assistantTimeline: timeline("coordinator"),
      }),
    ).toEqual({ kind: "default" });
  });

  it("keeps the default row outside a Project, for typed messages and for unknown senders", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(coordinatorThreadId, "Personal"),
        assistantTimeline: null,
      }),
    ).toEqual({ kind: "default" });
    expect(
      resolveAgentMessagePresentation({
        message: { role: "user" },
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "default" });
    expect(
      resolveAgentMessagePresentation({
        message: { role: "user", source: { kind: "agent", threadTitle: "Personal" } },
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "default" });
  });
});
