import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  assistantSlug,
  assistantThreadRole,
  isArchivedAssistant,
  isAssistantSettlementExempt,
  isRunningAgent,
  isStandingAgent,
} from "./assistants.ts";
import { ThreadId } from "./baseSchemas.ts";
import { ClientOrchestrationCommand } from "./orchestration.ts";

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

const COORDINATOR = ThreadId.make("coordinator");
const AGENT = ThreadId.make("agent");
const project = { assistant: { coordinatorThreadId: COORDINATOR } };
const workspace = { assistant: null };

describe("ProjectAssistantPatch", () => {
  it.effect("keeps absent (unchanged) distinct from null (clear)", () =>
    Effect.gen(function* () {
      const base = { type: "project.meta.update", commandId: "cmd", projectId: "project" };
      const absent = yield* decodeClientCommand(base);
      const cleared = yield* decodeClientCommand({ ...base, assistant: null });
      const set = yield* decodeClientCommand({
        ...base,
        assistant: { coordinatorThreadId: "coordinator", archived: true },
      });
      if (
        absent.type !== "project.meta.update" ||
        cleared.type !== "project.meta.update" ||
        set.type !== "project.meta.update"
      ) {
        throw new Error("Unexpected command");
      }
      assert.isFalse("assistant" in absent);
      assert.isNull(cleared.assistant);
      assert.deepStrictEqual(set.assistant, {
        coordinatorThreadId: COORDINATOR,
        archived: true,
      });
    }),
  );
});

describe("assistant predicates", () => {
  it("resolves thread roles", () => {
    assert.strictEqual(assistantThreadRole(project, COORDINATOR), "coordinator");
    assert.strictEqual(assistantThreadRole(project, AGENT), "agent");
    assert.isNull(assistantThreadRole(workspace, AGENT));
    assert.isNull(assistantThreadRole({}, AGENT));
    assert.isNull(assistantThreadRole(project, undefined));
    assert.isNull(assistantThreadRole(undefined, AGENT));
  });

  it("detects archived Projects", () => {
    assert.isTrue(isArchivedAssistant({ assistant: { ...project.assistant, archivedAt: "t" } }));
    assert.isFalse(isArchivedAssistant({ assistant: { ...project.assistant, archivedAt: null } }));
    assert.isFalse(isArchivedAssistant(project));
    assert.isFalse(isArchivedAssistant(workspace));
  });

  it("treats only pinned agents as standing and exempts them with the coordinator", () => {
    const pinned = { id: AGENT, pinnedAt: "t" };
    const unpinned = { id: AGENT, pinnedAt: null };
    const pinnedCoordinator = { id: COORDINATOR, pinnedAt: "t" };

    assert.isTrue(isStandingAgent(project, pinned));
    assert.isFalse(isStandingAgent(project, unpinned));
    assert.isFalse(isStandingAgent(project, pinnedCoordinator));
    assert.isFalse(isStandingAgent(workspace, pinned));

    assert.isTrue(isAssistantSettlementExempt(project, pinnedCoordinator));
    assert.isTrue(isAssistantSettlementExempt(project, { id: COORDINATOR }));
    assert.isTrue(isAssistantSettlementExempt(project, pinned));
    assert.isFalse(isAssistantSettlementExempt(project, unpinned));
    assert.isFalse(isAssistantSettlementExempt(workspace, pinned));
    assert.isFalse(isAssistantSettlementExempt(undefined, pinned));
  });

  it("counts live and blocked sessions as running, not idle ones", () => {
    const thread = (status: string | null, pending: Partial<Record<string, boolean>> = {}) => ({
      hasPendingApprovals: pending.approval ?? false,
      hasPendingUserInput: pending.input ?? false,
      session: status === null ? null : { status },
    });
    assert.isTrue(isRunningAgent(thread("starting")));
    assert.isTrue(isRunningAgent(thread("running")));
    assert.isTrue(isRunningAgent(thread("ready", { approval: true })));
    assert.isTrue(isRunningAgent(thread(null, { input: true })));
    assert.isFalse(isRunningAgent(thread("ready")));
    assert.isFalse(isRunningAgent(thread("error")));
    assert.isFalse(isRunningAgent(thread(null)));
  });
});

describe("assistantSlug", () => {
  it("builds kebab-case ASCII slugs", () => {
    assert.strictEqual(assistantSlug("Sales Team"), "sales-team");
    assert.strictEqual(assistantSlug("  Q3 -- Planning!  "), "q3-planning");
    assert.strictEqual(assistantSlug("Café"), "cafe");
    assert.strictEqual(assistantSlug("Crème Brûlée"), "creme-brulee");
  });

  it("returns an empty slug when nothing ASCII survives", () => {
    assert.strictEqual(assistantSlug("日本語"), "");
    assert.strictEqual(assistantSlug("🚀"), "");
    assert.strictEqual(assistantSlug("🚀 Launch"), "launch");
  });
});
