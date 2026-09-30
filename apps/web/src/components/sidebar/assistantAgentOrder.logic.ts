import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  planAssistantAgentReorder,
  type AssistantAgentReorderPlan,
} from "@t3tools/client-runtime/state/assistant-lists";
import type { AssistantAgentSections } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

// Fork-owned. Arranging agents inside a Project: standing agents among
// themselves, active agents among themselves, never across Projects or into
// Tasks. Order lives on the threads (pin and active order keys), so it syncs.

export interface AgentOrderModel {
  /** `assistantExpansionKey` of the Project. */
  readonly key: string;
  readonly sections: AssistantAgentSections<EnvironmentThreadShell>;
}

export interface AgentOrderSlot {
  readonly modelKey: string;
  readonly section: "pinned" | "active";
  /** The environment can persist this block's order. */
  readonly reorderable: boolean;
}

export interface AgentOrderCapabilities {
  readonly pinReorder: (environmentId: EnvironmentId) => boolean;
  readonly activeReorder: (environmentId: EnvironmentId) => boolean;
}

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Every standing and active agent row, keyed by scoped thread key. */
export function indexAgentOrderSlots(
  models: readonly AgentOrderModel[],
  capabilities: AgentOrderCapabilities,
): ReadonlyMap<string, AgentOrderSlot> {
  const slots = new Map<string, AgentOrderSlot>();
  for (const model of models) {
    for (const thread of model.sections.standing) {
      slots.set(keyOf(thread), {
        modelKey: model.key,
        section: "pinned",
        reorderable: capabilities.pinReorder(thread.environmentId),
      });
    }
    for (const thread of model.sections.active) {
      slots.set(keyOf(thread), {
        modelKey: model.key,
        section: "active",
        reorderable: capabilities.activeReorder(thread.environmentId),
      });
    }
  }
  return slots;
}

/** Where a dragged agent may land: its own Project and block only. */
export function agentDropTargetFilter(
  slots: ReadonlyMap<string, AgentOrderSlot>,
  activeKey: string,
): ((id: string) => boolean) | null {
  const source = slots.get(activeKey);
  if (source === undefined) return null;
  return (id) => {
    const target = slots.get(id);
    return (
      target !== undefined &&
      target.modelKey === source.modelKey &&
      target.section === source.section &&
      target.reorderable
    );
  };
}

export interface AgentOrderMove {
  readonly plan: AssistantAgentReorderPlan;
  readonly writes: ReadonlyArray<{
    readonly threadRef: ScopedThreadRef;
    readonly orderKey: string;
  }>;
}

/** A drop (onto `overKey`) or an Alt+Arrow step, as thread writes. */
export function planAgentOrderMove(input: {
  readonly models: readonly AgentOrderModel[];
  readonly slots: ReadonlyMap<string, AgentOrderSlot>;
  readonly movedKey: string;
  readonly target: { readonly overKey: string } | { readonly direction: -1 | 1 };
}): AgentOrderMove | null {
  const slot = input.slots.get(input.movedKey);
  if (slot === undefined || !slot.reorderable) return null;
  if ("overKey" in input.target) {
    const accepts = agentDropTargetFilter(input.slots, input.movedKey);
    if (accepts === null || !accepts(input.target.overKey)) return null;
  }
  const model = input.models.find((candidate) => candidate.key === slot.modelKey);
  if (model === undefined) return null;
  const plan = planAssistantAgentReorder(model.sections, input.movedKey, input.target);
  if (plan === null) return null;
  const threadByKey = new Map(
    [...model.sections.standing, ...model.sections.active].map((thread) => [keyOf(thread), thread]),
  );
  const writes: { threadRef: ScopedThreadRef; orderKey: string }[] = [];
  for (const assignment of plan.assignments) {
    const thread = threadByKey.get(assignment.id);
    // A materializing rewrite may only touch rows this client can arrange.
    if (thread === undefined || input.slots.get(assignment.id)?.reorderable !== true) return null;
    writes.push({
      threadRef: scopeThreadRef(thread.environmentId, thread.id),
      orderKey: assignment.orderKey,
    });
  }
  return { plan, writes };
}
