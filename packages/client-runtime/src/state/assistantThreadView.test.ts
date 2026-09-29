import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentMessagePresentation,
  resolveAssistantThreadChrome,
} from "./assistantThreadView.ts";

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

describe("resolveAgentMessagePresentation", () => {
  const coordinatorThreadId = ThreadId.make("thread-coordinator");
  const salesThreadId = ThreadId.make("thread-sales");
  const researchThreadId = ThreadId.make("thread-research");
  const helperThreadId = ThreadId.make("thread-helper");
  const outsiderThreadId = ThreadId.make("thread-outside");
  const projectThreadTitles = new Map([
    [coordinatorThreadId, "Personal"],
    [salesThreadId, "Sales"],
    [researchThreadId, "Research"],
    [helperThreadId, "Bun startup"],
  ]);
  const timeline = (role: "coordinator" | "agent") => ({
    role,
    coordinatorThreadId,
    project: { title: "Personal" },
    projectThreadTitle: (threadId: ThreadId) => projectThreadTitles.get(threadId) ?? null,
  });
  const fromThread = (
    threadId: ThreadId,
    threadTitle: string,
    options: { id?: string; replyTo?: ThreadId } = {},
  ) => ({
    id: options.id ?? "message-1",
    role: "user",
    source: {
      kind: "agent" as const,
      threadId,
      threadTitle,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    },
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

  it("leaves a peer's plain message in an agent thread as a default row", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(salesThreadId, "Sales"),
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "default" });
  });

  it("reads a one-off agent's pushed result in its standing agent's thread as a reply", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(helperThreadId, "New thread", {
          id: `cp-push:${helperThreadId}:message-request`,
        }),
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "replied", displayName: "Bun startup", linkThreadId: helperThreadId });
  });

  it("attributes a standing agent's request in its one-off agent's thread to the standing agent", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(researchThreadId, "Research", { replyTo: researchThreadId }),
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({
      kind: "attributed-user",
      displayName: "Research",
      linkThreadId: researchThreadId,
    });
  });

  it("keeps the coordinator's requests in an agent thread attributed to the Project", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(coordinatorThreadId, "Personal", { replyTo: coordinatorThreadId }),
        assistantTimeline: timeline("agent"),
      }),
    ).toMatchObject({ kind: "attributed-user", displayName: "Personal" });
  });

  it("keeps a result from an agent later set as coordinator as a reply in the old coordinator", () => {
    expect(
      resolveAgentMessagePresentation({
        message: fromThread(coordinatorThreadId, "Bun startup", {
          id: `cp-push:${coordinatorThreadId}:message-request`,
        }),
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "replied", displayName: "Personal", linkThreadId: coordinatorThreadId });
  });

  it("keeps the default row in an agent thread for a sender outside the Project", () => {
    for (const options of [
      { id: `cp-push:${outsiderThreadId}:message-request` },
      { replyTo: outsiderThreadId },
    ]) {
      expect(
        resolveAgentMessagePresentation({
          message: fromThread(outsiderThreadId, "Elsewhere", options),
          assistantTimeline: timeline("agent"),
        }),
      ).toEqual({ kind: "default" });
    }
  });

  it("labels a message from one of the Project's agents as a reply in the coordinator", () => {
    for (const options of [{}, { id: `cp-push:${salesThreadId}:message-request` }]) {
      expect(
        resolveAgentMessagePresentation({
          message: fromThread(salesThreadId, "Sales", options),
          assistantTimeline: timeline("coordinator"),
        }),
      ).toEqual({ kind: "replied", displayName: "Sales", linkThreadId: salesThreadId });
    }
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
        message: { id: "message-1", role: "user" },
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "default" });
    expect(
      resolveAgentMessagePresentation({
        message: {
          id: "message-1",
          role: "user",
          source: { kind: "agent", threadTitle: "Personal" },
        },
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual({ kind: "default" });
  });

  it("labels a scheduled prompt by its schedule, ahead of every handoff reading", () => {
    const scheduleSource = {
      kind: "agent" as const,
      threadTitle: "Morning brief",
      scheduleId: "morning-brief-abc123",
    };
    const scheduled = { kind: "scheduled", name: "Morning brief" };
    // In the coordinator, and outside any Project timeline.
    for (const assistantTimeline of [timeline("coordinator"), null]) {
      expect(
        resolveAgentMessagePresentation({
          message: { id: "cp-schedule:p:s:slot", role: "user", source: scheduleSource },
          assistantTimeline,
        }),
      ).toEqual(scheduled);
    }
    // In a standing agent, where it also carries the coordinator as replyTo.
    expect(
      resolveAgentMessagePresentation({
        message: {
          id: "cp-schedule:p:s:slot",
          role: "user",
          source: { ...scheduleSource, replyTo: coordinatorThreadId },
        },
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual(scheduled);
    // Even with a sender and a push id, the schedule wins.
    expect(
      resolveAgentMessagePresentation({
        message: {
          id: `cp-push:${salesThreadId}:message-request`,
          role: "user",
          source: { ...scheduleSource, threadId: coordinatorThreadId },
        },
        assistantTimeline: timeline("agent"),
      }),
    ).toEqual(scheduled);
  });
});
