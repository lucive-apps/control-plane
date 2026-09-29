import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  agentManagerRole,
  assistantSlug,
  assistantThreadRole,
  canManageAgent,
  isAgentPushMessageId,
  isArchivedAssistant,
  isAssistantSettlementExempt,
  isRunningAgent,
  isScheduleMessageId,
  isStandingAgent,
  ProjectAssistant,
  ProjectScheduleAgentChange,
  withoutSchedulePrompts,
} from "./assistants.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClientOrchestrationCommand } from "./orchestration.ts";

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeAgentChange = Schema.decodeUnknownEffect(ProjectScheduleAgentChange);
const decodeAssistant = Schema.decodeUnknownEffect(ProjectAssistant);
// The M2 marker, as older clients decode it.
const decodeOlderAssistant = Schema.decodeUnknownEffect(
  Schema.Struct({
    coordinatorThreadId: ThreadId,
    formerTitle: Schema.optional(TrimmedNonEmptyString),
    archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  }),
);

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

describe("schedules", () => {
  const schedule = {
    id: "morning-brief",
    name: "Morning brief",
    cron: "0 7 * * 1-5",
    target: "coordinator" as const,
    enabled: true,
  };
  const decodeScheduleWrite = (schedules: ReadonlyArray<Record<string, unknown>>) =>
    decodeClientCommand({
      type: "project.meta.update",
      commandId: "cmd",
      projectId: "project",
      assistant: { schedules },
    }).pipe(
      Effect.map((command) =>
        command.type === "project.meta.update" ? command.assistant?.schedules : undefined,
      ),
    );

  it.effect("takes a whole-list write with or without a prompt, and no authorship", () =>
    Effect.gen(function* () {
      const withPrompt = yield* decodeScheduleWrite([{ ...schedule, prompt: "Summarize." }]);
      assert.strictEqual(withPrompt?.[0]?.prompt, "Summarize.");
      // `updatedAt` is the echo of the read; the server stamps its own.
      const updatedAt = "2026-01-01T00:00:00.000Z";
      const kept = yield* decodeScheduleWrite([
        { ...schedule, createdBy: "thread-x", updatedBy: "thread-x", updatedAt },
      ]);
      assert.deepStrictEqual(kept, [{ ...schedule, updatedAt }]);
      const badId = yield* Effect.flip(decodeScheduleWrite([{ ...schedule, id: "Morning Brief" }]));
      assert.strictEqual(badId._tag, "SchemaError");
      const withRuns = yield* decodeClientCommand({
        type: "project.meta.update",
        commandId: "cmd",
        projectId: "project",
        assistant: { schedules: [], scheduleRuns: { x: {} }, schedulePrompts: { x: "y" } },
      });
      assert.deepStrictEqual(
        withRuns.type === "project.meta.update" ? withRuns.assistant : undefined,
        { schedules: [] },
      );
    }),
  );

  it.effect("keeps the schedule record and agent commands off the client wire", () =>
    Effect.gen(function* () {
      for (const type of ["project.schedule.record", "project.schedule.agent-change"]) {
        const error = yield* Effect.flip(
          decodeClientCommand({
            type,
            commandId: "cmd",
            projectId: "project",
            scheduleId: "morning-brief",
            actorThreadId: "coordinator",
            change: { kind: "delete", id: "morning-brief" },
            run: { slot: "t", at: "t", trigger: "cron", outcome: "sent" },
            createdAt: "t",
          }),
        );
        assert.strictEqual(error._tag, "SchemaError", type);
      }
    }),
  );

  it.effect("lets an agent pause a schedule but never turn one on", () =>
    Effect.gen(function* () {
      const paused = yield* decodeAgentChange({
        kind: "upsert",
        id: "morning-brief",
        enabled: false,
      });
      assert.deepStrictEqual(paused, { kind: "upsert", id: "morning-brief", enabled: false });
      const enabled = yield* Effect.flip(
        decodeAgentChange({ kind: "upsert", id: "morning-brief", enabled: true }),
      );
      assert.strictEqual(enabled._tag, "SchemaError");
    }),
  );

  it.effect("a marker with schedules still decodes on a build that predates them", () =>
    Effect.gen(function* () {
      const marker = {
        coordinatorThreadId: "coordinator",
        schedules: [
          {
            ...schedule,
            createdBy: "user",
            updatedBy: "coordinator",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        scheduleRuns: {
          "morning-brief": {
            slot: "2026-01-02T07:00:00.000Z",
            at: "2026-01-02T07:00:01.000Z",
            trigger: "cron",
            outcome: "missed",
            reason: "not-running",
          },
        },
      };
      const older = yield* decodeOlderAssistant(marker);
      assert.deepStrictEqual(older, { coordinatorThreadId: COORDINATOR });
      const current = yield* decodeAssistant(marker);
      assert.strictEqual(current.schedules?.[0]?.updatedBy, "coordinator");
      assert.strictEqual(current.scheduleRuns?.["morning-brief"]?.reason, "not-running");
      // A miss reason from a newer server reads as absent instead of failing the Project.
      const newer = yield* decodeAssistant({
        ...marker,
        scheduleRuns: {
          "morning-brief": { ...marker.scheduleRuns["morning-brief"], reason: "future-reason" },
        },
      });
      assert.strictEqual(newer.scheduleRuns?.["morning-brief"]?.outcome, "missed");
      assert.strictEqual(newer.scheduleRuns?.["morning-brief"]?.reason, undefined);
    }),
  );

  it("strips prompts for the shell", () => {
    const marker = {
      coordinatorThreadId: COORDINATOR,
      schedulePrompts: { "morning-brief": "Summarize." },
      scheduleRuns: {},
    };
    assert.deepStrictEqual(withoutSchedulePrompts(marker), {
      coordinatorThreadId: COORDINATOR,
      scheduleRuns: {},
    });
  });

  it("recognizes scheduled prompt ids but not run record ids", () => {
    assert.isTrue(isScheduleMessageId("cp-schedule:x"));
    assert.isFalse(isScheduleMessageId("cp-schedule-run:x"));
    assert.isFalse(isScheduleMessageId("cp-push:cp-schedule:x"));
  });
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

describe("agent managers", () => {
  const PROJECT = ProjectId.make("project");
  const OTHER_PROJECT = ProjectId.make("project-other");
  const STANDING = ThreadId.make("standing");
  const OTHER_STANDING = ThreadId.make("standing-other");
  const ONE_OFF = ThreadId.make("one-off");

  const personal = { id: PROJECT, assistant: { coordinatorThreadId: COORDINATOR } };
  const archived = {
    id: PROJECT,
    assistant: { coordinatorThreadId: COORDINATOR, archivedAt: "2026-01-01T00:00:00.000Z" },
  };
  const plain = { id: PROJECT, assistant: null };

  const thread = (
    id: ThreadId,
    extra: { pinnedAt?: string | null; projectId?: ProjectId; createdByThreadId?: ThreadId } = {},
  ) => ({ id, projectId: PROJECT, pinnedAt: null, ...extra });
  const coordinator = thread(COORDINATOR);
  const standing = thread(STANDING, { pinnedAt: "t" });
  const otherStanding = thread(OTHER_STANDING, { pinnedAt: "t" });
  const oneOff = thread(ONE_OFF, { createdByThreadId: STANDING });
  const coordinatorsOneOff = thread(AGENT, { createdByThreadId: COORDINATOR });

  it("gives the coordinator and standing agents a role, and nothing else", () => {
    assert.strictEqual(agentManagerRole(personal, coordinator), "coordinator");
    assert.strictEqual(agentManagerRole(personal, standing), "standing");
    assert.isNull(agentManagerRole(personal, oneOff));
    assert.isNull(agentManagerRole(plain, coordinator));
    assert.isNull(agentManagerRole(plain, standing));
    assert.isNull(agentManagerRole({ id: PROJECT }, coordinator));
    assert.isNull(agentManagerRole(archived, coordinator));
    assert.isNull(agentManagerRole(archived, standing));
    assert.isNull(agentManagerRole(personal, { ...coordinator, projectId: OTHER_PROJECT }));
    assert.isNull(agentManagerRole(personal, { ...standing, projectId: OTHER_PROJECT }));
  });

  it("lets the coordinator manage any agent but not itself", () => {
    for (const agent of [standing, otherStanding, oneOff, coordinatorsOneOff]) {
      assert.isTrue(canManageAgent(personal, coordinator, agent), agent.id);
    }
    assert.isFalse(canManageAgent(personal, coordinator, coordinator));
    assert.isFalse(canManageAgent(archived, coordinator, oneOff));
    assert.isFalse(canManageAgent(plain, coordinator, oneOff));
  });

  it("lets a standing agent manage only the unpinned agents it created", () => {
    assert.isTrue(canManageAgent(personal, standing, oneOff));
    assert.isFalse(canManageAgent(personal, standing, { ...oneOff, pinnedAt: "t" }));
    assert.isFalse(canManageAgent(personal, standing, coordinatorsOneOff));
    assert.isFalse(canManageAgent(personal, standing, thread(AGENT)));
    assert.isFalse(canManageAgent(personal, standing, otherStanding));
    assert.isFalse(canManageAgent(personal, standing, standing));
    assert.isFalse(canManageAgent(personal, standing, coordinator));
    // Even when it somehow created the coordinator, it never manages it.
    assert.isFalse(
      canManageAgent(personal, standing, { ...coordinator, createdByThreadId: STANDING }),
    );
    assert.isFalse(canManageAgent(archived, standing, oneOff));
  });

  it("gives a one-off agent and a plain workspace thread nothing to manage", () => {
    const nested = thread(ThreadId.make("nested"), { createdByThreadId: ONE_OFF });
    assert.isFalse(canManageAgent(personal, oneOff, nested));
    assert.isFalse(canManageAgent(plain, standing, oneOff));
    assert.isFalse(canManageAgent(plain, coordinator, coordinatorsOneOff));
  });

  it("never matches across Projects", () => {
    assert.isFalse(
      canManageAgent(personal, coordinator, { ...coordinatorsOneOff, projectId: OTHER_PROJECT }),
    );
    assert.isFalse(canManageAgent(personal, standing, { ...oneOff, projectId: OTHER_PROJECT }));
    assert.isFalse(
      canManageAgent(personal, { ...coordinator, projectId: OTHER_PROJECT }, coordinatorsOneOff),
    );
    assert.isFalse(canManageAgent({ ...personal, id: OTHER_PROJECT }, coordinator, oneOff));
  });

  it("recognizes pushed result message ids", () => {
    assert.isTrue(isAgentPushMessageId("cp-push:agent:message"));
    assert.isFalse(isAgentPushMessageId("cp-send:agent:uuid"));
    assert.isFalse(isAgentPushMessageId("message-cp-push:agent"));
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
