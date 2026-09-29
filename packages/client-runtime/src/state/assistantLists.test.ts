import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  ASSISTANT_SETTLED_PAGE_SIZE,
  assistantExpansionKey,
  assistantSettledToggle,
  isAssistantExpanded,
  rollupAssistantsStatus,
  rollupThreadGroupStatus,
  visibleAssistantAgentRows,
} from "./assistantLists.ts";
import { ASSISTANT_ROLLUP_AGENT_UNREAD, type AssistantAgentSections } from "./assistants.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const env = EnvironmentId.make("env");

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    projectId: ProjectId.make("personal"),
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

const keyOf = (value: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(value.environmentId, value.id));

function sections(
  input: Partial<AssistantAgentSections<EnvironmentThreadShell>>,
): AssistantAgentSections<EnvironmentThreadShell> {
  return { standing: [], active: [], snoozed: [], settled: [], ...input };
}

const settledAgents = Array.from({ length: 13 }, (_, index) => thread(`settled-${index + 1}`));

describe("settled paging under a Project", () => {
  const agentSections = sections({ settled: settledAgents });

  it("hides settled agents until asked, then pages by ten", () => {
    const hidden = visibleAssistantAgentRows(agentSections, {
      settledCount: 0,
      routeThreadKey: null,
    });
    expect(hidden.rows).toEqual([]);
    expect(
      assistantSettledToggle({
        settledCount: 0,
        settledTotal: 13,
        hiddenSettledCount: hidden.hiddenSettledCount,
      }),
    ).toEqual({ label: "13 settled", nextSettledCount: ASSISTANT_SETTLED_PAGE_SIZE });

    const firstPage = visibleAssistantAgentRows(agentSections, {
      settledCount: ASSISTANT_SETTLED_PAGE_SIZE,
      routeThreadKey: null,
    });
    expect(firstPage.rows).toHaveLength(10);
    expect(firstPage.rows.every((row) => row.section === "settled")).toBe(true);
    expect(
      assistantSettledToggle({
        settledCount: ASSISTANT_SETTLED_PAGE_SIZE,
        settledTotal: 13,
        hiddenSettledCount: firstPage.hiddenSettledCount,
      }),
    ).toEqual({ label: "3 more settled", nextSettledCount: 20 });

    const all = visibleAssistantAgentRows(agentSections, {
      settledCount: 20,
      routeThreadKey: null,
    });
    expect(all.hiddenSettledCount).toBe(0);
    expect(
      assistantSettledToggle({ settledCount: 20, settledTotal: 13, hiddenSettledCount: 0 }),
    ).toEqual({ label: "Hide settled", nextSettledCount: 0 });
  });

  it("shows no button without settled agents", () => {
    expect(
      assistantSettledToggle({ settledCount: 0, settledTotal: 0, hiddenSettledCount: 0 }),
    ).toBeNull();
  });

  it("never hides the open thread behind the settled button", () => {
    const routeThread = settledAgents[11]!;
    const visible = visibleAssistantAgentRows(agentSections, {
      settledCount: 0,
      routeThreadKey: keyOf(routeThread),
    });
    expect(visible.rows.map((row) => row.thread.id)).toEqual([routeThread.id]);
    expect(visible.hiddenSettledCount).toBe(12);
    expect(
      assistantSettledToggle({
        settledCount: 0,
        settledTotal: 13,
        hiddenSettledCount: visible.hiddenSettledCount,
      }),
    ).toEqual({ label: "12 settled", nextSettledCount: ASSISTANT_SETTLED_PAGE_SIZE });
  });

  it("shows no dead button when the open thread is the only settled agent", () => {
    const only = thread("only-settled");
    const visible = visibleAssistantAgentRows(sections({ settled: [only] }), {
      settledCount: 0,
      routeThreadKey: keyOf(only),
    });
    expect(visible.rows.map((row) => row.thread.id)).toEqual([only.id]);
    expect(
      assistantSettledToggle({
        settledCount: 0,
        settledTotal: 1,
        hiddenSettledCount: visible.hiddenSettledCount,
      }),
    ).toBeNull();
  });
});

describe("Project expansion", () => {
  it("starts collapsed and follows the stored choice", () => {
    const key = assistantExpansionKey("env", "personal");
    expect(isAssistantExpanded({}, key)).toBe(false);
    expect(isAssistantExpanded({ [key]: true }, key)).toBe(true);
    expect(isAssistantExpanded({ [key]: false }, key)).toBe(false);
  });
});

describe("collapsed rollups", () => {
  const completedTurn = {
    turnId: "turn-1",
    state: "completed",
    requestedAt: "2026-09-28T10:00:00.000Z",
    startedAt: "2026-09-28T10:00:00.000Z",
    completedAt: "2026-09-28T10:05:00.000Z",
    assistantMessageId: null,
  } as unknown as EnvironmentThreadShell["latestTurn"];
  const running = { status: "running" } as unknown as EnvironmentThreadShell["session"];
  const failed = { status: "error" } as unknown as EnvironmentThreadShell["session"];
  const visitedBefore = "2026-09-28T10:01:00.000Z";

  it("shows the most urgent live status, then unread, then nothing", () => {
    const unread = thread("unread", { latestTurn: completedTurn });
    const lastVisited = { [keyOf(unread)]: visitedBefore };
    expect(rollupThreadGroupStatus([], lastVisited)).toBeNull();
    expect(rollupThreadGroupStatus([thread("idle")], lastVisited)).toBeNull();
    expect(rollupThreadGroupStatus([unread], lastVisited)).toBe("unread");
    expect(
      rollupThreadGroupStatus([unread, thread("broken", { session: failed })], lastVisited),
    ).toBe("failed");
    expect(
      rollupThreadGroupStatus(
        [thread("broken", { session: failed }), thread("busy", { session: running })],
        lastVisited,
      ),
    ).toBe("working");
    expect(
      rollupThreadGroupStatus(
        [thread("busy", { session: running }), thread("ask", { hasPendingApprovals: true })],
        lastVisited,
      ),
    ).toBe("approval");
  });

  it("rolls every Project into the Projects section dot", () => {
    const agent = thread("sales", { latestTurn: completedTurn });
    const coordinator = thread("c", { latestTurn: completedTurn });
    const lastVisited = { [keyOf(agent)]: visitedBefore, [keyOf(coordinator)]: visitedBefore };
    // Agent unread lights the dot while nothing relays agent results (M2).
    expect(
      rollupAssistantsStatus(
        [{ coordinator: thread("c"), sections: sections({ active: [agent] }) }],
        lastVisited,
      ),
    ).toBe(ASSISTANT_ROLLUP_AGENT_UNREAD ? "unread" : null);
    expect(rollupAssistantsStatus([{ coordinator, sections: sections({}) }], lastVisited)).toBe(
      "unread",
    );
    expect(
      rollupAssistantsStatus(
        [
          { coordinator: thread("c"), sections: sections({ standing: [agent] }) },
          {
            coordinator: null,
            sections: sections({ active: [thread("x", { hasPendingUserInput: true })] }),
          },
        ],
        lastVisited,
      ),
    ).toBe("input");
    expect(
      rollupAssistantsStatus([{ coordinator: thread("c"), sections: sections({}) }], lastVisited),
    ).toBeNull();
  });

  it("keeps settled and snoozed agents out of the Project dot", () => {
    const failedSettled = thread("failed-settled", { session: failed });
    const unreadSettled = thread("unread-settled", { latestTurn: completedTurn });
    const unreadSnoozed = thread("unread-snoozed", { latestTurn: completedTurn });
    const lastVisited = {
      [keyOf(unreadSettled)]: visitedBefore,
      [keyOf(unreadSnoozed)]: visitedBefore,
    };
    expect(
      rollupAssistantsStatus(
        [
          {
            coordinator: thread("c"),
            sections: sections({
              settled: [failedSettled, unreadSettled],
              snoozed: [unreadSnoozed],
            }),
          },
        ],
        lastVisited,
      ),
    ).toBeNull();
  });

  it("reads a Project's missed or failed schedule as failed unless a thread needs more", () => {
    const quiet = { coordinator: thread("c"), sections: sections({}), scheduleAttention: true };
    expect(rollupAssistantsStatus([quiet], {})).toBe("failed");
    expect(
      rollupAssistantsStatus(
        [{ ...quiet, coordinator: thread("c", { hasPendingApprovals: true }) }],
        {},
      ),
    ).toBe("approval");
  });
});
