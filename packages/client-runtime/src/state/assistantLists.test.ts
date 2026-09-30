import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  assistantExpansionKey,
  isAssistantExpanded,
  planAssistantAgentReorder,
  rollupAssistantsStatus,
  rollupThreadGroupStatus,
  visibleAssistantAgentRows,
} from "./assistantLists.ts";
import {
  ASSISTANT_ROLLUP_AGENT_UNREAD,
  sectionAssistantAgents,
  type AssistantAgentSections,
} from "./assistants.ts";
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

  it("hides settled agents until paged in", () => {
    const hidden = visibleAssistantAgentRows(agentSections, {
      settledCount: 0,
      routeThreadKey: null,
    });
    expect(hidden.rows).toEqual([]);
    expect(hidden.hiddenSettledCount).toBe(13);

    const firstPage = visibleAssistantAgentRows(agentSections, {
      settledCount: 10,
      routeThreadKey: null,
    });
    expect(firstPage.rows).toHaveLength(10);
    expect(firstPage.rows.every((row) => row.section === "settled")).toBe(true);
    expect(firstPage.hiddenSettledCount).toBe(3);

    const all = visibleAssistantAgentRows(agentSections, {
      settledCount: 20,
      routeThreadKey: null,
    });
    expect(all.hiddenSettledCount).toBe(0);
  });

  it("never hides the open thread behind the settled button", () => {
    const routeThread = settledAgents[11]!;
    const visible = visibleAssistantAgentRows(agentSections, {
      settledCount: 0,
      routeThreadKey: keyOf(routeThread),
    });
    expect(visible.rows.map((row) => row.thread.id)).toEqual([routeThread.id]);
    expect(visible.hiddenSettledCount).toBe(12);
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

describe("planAssistantAgentReorder", () => {
  const pinned = (id: string, pinOrderKey: string | null) =>
    thread(id, { pinnedAt: "2026-09-01T00:00:00.000Z", pinOrderKey });
  const reorder = (
    value: AssistantAgentSections<EnvironmentThreadShell>,
    moved: EnvironmentThreadShell,
    target: { overKey: string } | { direction: -1 | 1 },
  ) => planAssistantAgentReorder(value, keyOf(moved), target);
  // Re-sort the way every client does after the writes land.
  const applied = (
    agents: readonly EnvironmentThreadShell[],
    plan: NonNullable<ReturnType<typeof planAssistantAgentReorder>>,
  ) => {
    const keyById = new Map(plan.assignments.map(({ id, orderKey }) => [id, orderKey]));
    const next = agents.map((agent) => {
      const orderKey = keyById.get(keyOf(agent));
      if (orderKey === undefined) return agent;
      return plan.section === "pinned"
        ? { ...agent, pinOrderKey: orderKey }
        : { ...agent, activeOrderKey: orderKey };
    });
    const resorted = sectionAssistantAgents(next, {
      now: "2026-09-02T00:00:00.000Z",
      supportsSnooze: true,
      supportsSettlement: true,
    });
    return (plan.section === "pinned" ? resorted.standing : resorted.active).map(keyOf);
  };

  it("moves a standing agent with one write between keyed neighbors", () => {
    const [a, b, c] = [pinned("a", "g"), pinned("b", "n"), pinned("c", "t")];
    const value = sections({ standing: [a!, b!, c!] });
    const plan = reorder(value, c!, { overKey: keyOf(a!) });
    expect(plan?.section).toBe("pinned");
    expect(plan?.order).toEqual([c, a, b].map((agent) => keyOf(agent!)));
    expect(plan?.assignments).toHaveLength(1);
    expect(applied([a!, b!, c!], plan!)).toEqual(plan?.order);
  });

  it("materializes keys once when a keyless standing agent is involved", () => {
    const a = pinned("a", null);
    const b = pinned("b", null);
    const value = sections({ standing: [a, b] });
    const plan = reorder(value, b, { direction: -1 });
    expect(plan?.assignments.map((assignment) => assignment.id)).toEqual([keyOf(b), keyOf(a)]);
    expect(applied([a, b], plan!)).toEqual([keyOf(b), keyOf(a)]);
  });

  it("moves an active agent by one step and keeps new keyless agents on top", () => {
    const a = thread("a", { createdAt: "2026-09-01T03:00:00.000Z" });
    const b = thread("b", { createdAt: "2026-09-01T02:00:00.000Z" });
    const c = thread("c", { createdAt: "2026-09-01T01:00:00.000Z" });
    const value = sections({ active: [a, b, c] });
    const plan = reorder(value, a, { direction: 1 });
    expect(plan?.section).toBe("active");
    expect(applied([a, b, c], plan!)).toEqual([keyOf(b), keyOf(a), keyOf(c)]);
    const fresh = thread("fresh", { createdAt: "2026-09-01T04:00:00.000Z" });
    const arranged = [a, b, c].map((agent) => {
      const orderKey = plan!.assignments.find((entry) => entry.id === keyOf(agent))?.orderKey;
      return orderKey === undefined ? agent : { ...agent, activeOrderKey: orderKey };
    });
    const resorted = sectionAssistantAgents([...arranged, fresh], {
      now: "2026-09-02T00:00:00.000Z",
      supportsSnooze: true,
      supportsSettlement: true,
    });
    expect(resorted.active.map(keyOf)).toEqual([fresh, b, a, c].map(keyOf));
  });

  it("refuses moves across blocks, past either end, or onto another Project's agent", () => {
    const standing = pinned("s", "g");
    const a = thread("a");
    const b = thread("b");
    const value = sections({ standing: [standing], active: [a, b] });
    expect(reorder(value, a, { overKey: keyOf(standing) })).toBeNull();
    expect(reorder(value, standing, { overKey: keyOf(a) })).toBeNull();
    expect(reorder(value, standing, { direction: -1 })).toBeNull();
    expect(reorder(value, standing, { direction: 1 })).toBeNull();
    expect(reorder(value, a, { overKey: keyOf(thread("elsewhere")) })).toBeNull();
    expect(reorder(value, thread("snoozed"), { direction: 1 })).toBeNull();
  });

  it("never reuses a key held by a hidden agent in the Project", () => {
    const a = pinned("a", "g");
    const b = pinned("b", "i");
    const c = pinned("c", "k");
    const hidden = thread("hidden", {
      pinnedAt: "2026-09-01T00:00:00.000Z",
      pinOrderKey: "h",
      snoozedUntil: "2026-09-09T00:00:00.000Z",
    });
    const value = sections({ standing: [a, b, c], snoozed: [hidden] });
    const plan = reorder(value, c, { overKey: keyOf(b) });
    expect(plan?.assignments).toHaveLength(1);
    const orderKey = plan!.assignments[0]!.orderKey;
    expect(orderKey).not.toBe("h");
    expect(orderKey > "g" && orderKey < "i").toBe(true);
  });
});
