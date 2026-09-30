import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantAgentSections } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentDropTargetFilter,
  indexAgentOrderSlots,
  planAgentOrderMove,
  type AgentOrderModel,
} from "./assistantAgentOrder.logic";

const env = EnvironmentId.make("env");
const oldEnv = EnvironmentId.make("old-env");

function agent(
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

const standing = (
  id: string,
  pinOrderKey: string,
  overrides: Partial<EnvironmentThreadShell> = {},
) => agent(id, { pinnedAt: "2026-09-01T00:00:00.000Z", pinOrderKey, ...overrides });
const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function model(key: string, sections: Partial<AssistantAgentSections<EnvironmentThreadShell>>) {
  return {
    key,
    sections: { standing: [], active: [], snoozed: [], settled: [], ...sections },
  } satisfies AgentOrderModel;
}

const allCapable = { pinReorder: () => true, activeReorder: () => true };

// The screenshot's Project: six standing agents, then a Project beside it.
const fantasy = standing("fantasy", "c");
const planner = standing("planner", "f");
const operator = standing("operator", "i");
const marketing = standing("marketing", "l");
const active = agent("scratch");
const otherProjectAgent = standing("other", "d");
const personal = model("personal", {
  standing: [fantasy, planner, operator, marketing],
  active: [active],
});
const work = model("work", { standing: [otherProjectAgent] });
const models = [personal, work];

describe("agent drop scoping", () => {
  const slots = indexAgentOrderSlots(models, allCapable);

  it("accepts only agents in the same Project and block", () => {
    const accepts = agentDropTargetFilter(slots, keyOf(marketing))!;
    expect(accepts(keyOf(fantasy))).toBe(true);
    expect(accepts(keyOf(active))).toBe(false);
    expect(accepts(keyOf(otherProjectAgent))).toBe(false);
    // Tasks rows and Project rows are never agent slots.
    expect(accepts("env:task-thread")).toBe(false);
    expect(accepts("sidebar-assistant:env:work")).toBe(false);
  });

  it("leaves non-agent drags to the other handlers", () => {
    expect(agentDropTargetFilter(slots, "sidebar-assistant:env:work")).toBeNull();
    expect(agentDropTargetFilter(slots, "env:task-thread")).toBeNull();
  });

  it("rejects drops on rows whose environment cannot store order", () => {
    const stale = standing("stale", "o", { environmentId: oldEnv });
    const mixed = [model("personal", { standing: [fantasy, stale] })];
    const mixedSlots = indexAgentOrderSlots(mixed, {
      pinReorder: (environmentId) => environmentId !== oldEnv,
      activeReorder: () => true,
    });
    expect(agentDropTargetFilter(mixedSlots, keyOf(fantasy))!(keyOf(stale))).toBe(false);
    expect(
      planAgentOrderMove({
        models: mixed,
        slots: mixedSlots,
        movedKey: keyOf(stale),
        target: { direction: -1 },
      }),
    ).toBeNull();
  });
});

describe("planAgentOrderMove", () => {
  const slots = indexAgentOrderSlots(models, allCapable);

  it("turns a drop into one pin-order write for the moved agent", () => {
    const move = planAgentOrderMove({
      models,
      slots,
      movedKey: keyOf(marketing),
      target: { overKey: keyOf(fantasy) },
    });
    expect(move?.plan.section).toBe("pinned");
    expect(move?.writes).toHaveLength(1);
    expect(move?.writes[0]?.threadRef).toEqual(scopeThreadRef(env, marketing.id));
    expect(move!.writes[0]!.orderKey < "c").toBe(true);
  });

  it("moves one place with Alt+Arrow and stops at either end", () => {
    const down = planAgentOrderMove({
      models,
      slots,
      movedKey: keyOf(fantasy),
      target: { direction: 1 },
    });
    expect(down?.plan.order.slice(0, 2)).toEqual([keyOf(planner), keyOf(fantasy)]);
    const key = down!.writes[0]!.orderKey;
    expect(key > "f" && key < "i").toBe(true);
    expect(
      planAgentOrderMove({ models, slots, movedKey: keyOf(fantasy), target: { direction: -1 } }),
    ).toBeNull();
    expect(
      planAgentOrderMove({ models, slots, movedKey: keyOf(active), target: { direction: 1 } }),
    ).toBeNull();
  });

  it("never moves an agent into another Project or across the standing line", () => {
    expect(
      planAgentOrderMove({
        models,
        slots,
        movedKey: keyOf(fantasy),
        target: { overKey: keyOf(otherProjectAgent) },
      }),
    ).toBeNull();
    expect(
      planAgentOrderMove({
        models,
        slots,
        movedKey: keyOf(marketing),
        target: { overKey: keyOf(active) },
      }),
    ).toBeNull();
  });

  it("uses active order keys for unpinned agents", () => {
    const newer = agent("newer", { createdAt: "2026-09-02T00:00:00.000Z" });
    const older = agent("older");
    const project = [model("personal", { active: [newer, older] })];
    const move = planAgentOrderMove({
      models: project,
      slots: indexAgentOrderSlots(project, allCapable),
      movedKey: keyOf(older),
      target: { overKey: keyOf(newer) },
    });
    expect(move?.plan.section).toBe("active");
    // Keyless neighbors: the block is keyed once, in the new order.
    expect(move?.writes.map((write) => write.threadRef.threadId)).toEqual([older.id, newer.id]);
  });

  it("does nothing in the settled view, where no slots exist", () => {
    expect(
      planAgentOrderMove({
        models,
        slots: new Map(),
        movedKey: keyOf(fantasy),
        target: { direction: 1 },
      }),
    ).toBeNull();
  });
});
