import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_ROLLUP_AGENT_UNREAD,
  type AssistantAgentSections,
} from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_SETTLED_PAGE_SIZE,
  assistantExpansionKey,
  assistantSettledToggle,
  flattenAssistantJumpOrder,
  isAssistantExpanded,
  rollupAssistantsStatus,
  rollupThreadGroupStatus,
  selectableThreadKeys,
  settleableSelection,
  visibleAssistantAgentRows,
} from "./sidebarAssistants.logic";

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
const ids = (threads: readonly EnvironmentThreadShell[]) => threads.map((value) => value.id);

function sections(
  input: Partial<AssistantAgentSections<EnvironmentThreadShell>>,
): AssistantAgentSections<EnvironmentThreadShell> {
  return { standing: [], active: [], snoozed: [], settled: [], ...input };
}

const settledAgents = Array.from({ length: 13 }, (_, index) => thread(`settled-${index + 1}`));

describe("flattenAssistantJumpOrder", () => {
  const personal = {
    key: assistantExpansionKey("env", "personal"),
    coordinator: thread("personal-coordinator"),
    sections: sections({
      standing: [thread("sales")],
      active: [thread("flights")],
      snoozed: [thread("later")],
      settled: settledAgents,
    }),
  };
  const work = {
    key: assistantExpansionKey("env", "work"),
    coordinator: thread("work-coordinator"),
    sections: sections({ active: [thread("research")] }),
  };

  it("puts each coordinator first and skips the agents of collapsed Projects", () => {
    expect(ids(flattenAssistantJumpOrder([personal, work], new Set(), new Map()))).toEqual([
      "personal-coordinator",
      "work-coordinator",
    ]);
    expect(
      ids(flattenAssistantJumpOrder([personal, work], new Set([work.key]), new Map())),
    ).toEqual(["personal-coordinator", "work-coordinator", "research"]);
  });

  it("follows the rendered order: standing, active, snoozed, then the settled page", () => {
    expect(
      ids(
        flattenAssistantJumpOrder(
          [personal],
          new Set([personal.key]),
          new Map([[personal.key, 2]]),
        ),
      ),
    ).toEqual(["personal-coordinator", "sales", "flights", "later", "settled-1", "settled-2"]);
  });

  it("lists the agents of a Project whose coordinator shell has not arrived", () => {
    expect(
      ids(
        flattenAssistantJumpOrder([{ ...work, coordinator: null }], new Set([work.key]), new Map()),
      ),
    ).toEqual(["research"]);
  });
});

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

describe("selectableThreadKeys", () => {
  it("drops coordinators from the range-select order", () => {
    expect(
      selectableThreadKeys(["coordinator", "agent", "task"], new Set(["coordinator"])),
    ).toEqual(["agent", "task"]);
    expect(selectableThreadKeys(["a", "b"], new Set())).toEqual(["a", "b"]);
  });
});

describe("settleableSelection", () => {
  const coordinatorId = ThreadId.make("coordinator");
  const projectByKey = new Map([
    ["env:personal", { assistant: { coordinatorThreadId: coordinatorId } }],
    ["env:website", { assistant: null }],
  ]);
  const inProject = (id: string, pinnedAt: string | null) => ({
    environmentId: "env",
    projectId: "personal",
    id: ThreadId.make(id),
    pinnedAt,
  });

  it("excludes standing agents and coordinators, keeps one-off agents and plain threads", () => {
    const selection = [
      inProject("coordinator", null),
      inProject("standing", "2026-09-28T00:00:00.000Z"),
      inProject("one-off", null),
      {
        environmentId: "env",
        projectId: "website",
        id: ThreadId.make("pinned-task"),
        pinnedAt: "2026-09-28T00:00:00.000Z",
      },
      { environmentId: "env", projectId: "website", id: ThreadId.make("task"), pinnedAt: null },
    ];
    expect(settleableSelection(selection, projectByKey).map((value) => value.id)).toEqual([
      "one-off",
      "pinned-task",
      "task",
    ]);
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
});
