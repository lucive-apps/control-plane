import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectAssistant,
  type ProjectSchedule,
  type ProjectScheduleAgentChange,
  type ProjectScheduleInput,
  type ProjectScheduleRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

// The decider clock is the Effect test clock pinned to the epoch.
const DECIDED_AT = "1970-01-01T00:00:00.000Z";
const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-personal");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const COORDINATOR = ThreadId.make("thread-coordinator");
const STANDING = ThreadId.make("thread-standing");
const ONE_OFF = ThreadId.make("thread-one-off");
const ARCHIVED_STANDING = ThreadId.make("thread-archived-standing");
const ELSEWHERE = ThreadId.make("thread-elsewhere");

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    title: `Title ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<OrchestrationProject> = {}): OrchestrationProject {
  return {
    id: PROJECT_ID,
    title: "Personal",
    workspaceRoot: "/tmp/personal",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const storedSchedule = (id: string, overrides: Partial<ProjectSchedule> = {}): ProjectSchedule => ({
  id,
  name: `Schedule ${id}`,
  cron: "0 7 * * 1-5",
  target: "coordinator",
  enabled: true,
  createdBy: "user",
  updatedBy: "user",
  updatedAt: NOW,
  ...overrides,
});

const missedRun: ProjectScheduleRun = {
  slot: "2026-01-02T07:00:00.000Z",
  at: "2026-01-02T07:00:00.000Z",
  trigger: "cron",
  outcome: "missed",
  reason: "not-running",
};

const withSchedules = (
  schedules: ReadonlyArray<ProjectSchedule>,
  extra: Partial<ProjectAssistant> = {},
): ProjectAssistant => ({
  coordinatorThreadId: COORDINATOR,
  schedules,
  schedulePrompts: Object.fromEntries(schedules.map((entry) => [entry.id, `Prompt ${entry.id}`])),
  ...extra,
});

function makeReadModel(
  assistant: ProjectAssistant | null,
  threads: ReadonlyArray<OrchestrationThread> = [
    makeThread(COORDINATOR, { title: "Personal" }),
    makeThread(STANDING, { pinnedAt: NOW }),
    makeThread(ONE_OFF),
    makeThread(ARCHIVED_STANDING, { pinnedAt: NOW, archivedAt: NOW }),
    makeThread(ELSEWHERE, { projectId: OTHER_PROJECT_ID, pinnedAt: NOW }),
  ],
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      makeProject({ assistant }),
      makeProject({ id: OTHER_PROJECT_ID, title: "Other", workspaceRoot: "/tmp/other" }),
    ],
    threads,
    updatedAt: NOW,
  };
}

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((result): ReadonlyArray<PlannedEvent> => ("eventId" in result ? [result] : result)),
  );

const rejection = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decide(readModel, command).pipe(Effect.flip);

const apply = Effect.fn("apply")(function* (
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<PlannedEvent>,
) {
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, {
      ...event,
      sequence: next.snapshotSequence + 1,
    } as OrchestrationEvent);
  }
  return next;
});

const assistantOf = (readModel: OrchestrationReadModel) =>
  readModel.projects.find((project) => project.id === PROJECT_ID)?.assistant;

/** Decides and applies, returning the Project's resulting marker. */
const resolve = Effect.fn("resolve")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  return assistantOf(yield* apply(readModel, yield* decide(readModel, command)));
});

/** A new entry, as a client sends it. */
const input = (
  id: string,
  overrides: Partial<ProjectScheduleInput> = {},
): ProjectScheduleInput => ({
  id,
  name: `Schedule ${id}`,
  cron: "0 7 * * 1-5",
  target: "coordinator",
  enabled: true,
  ...overrides,
});

/** An existing entry, echoing the `updatedAt` the client read. */
const kept = (id: string, overrides: Partial<ProjectScheduleInput> = {}): ProjectScheduleInput =>
  input(id, { updatedAt: NOW, ...overrides });

type AssistantPatch = Extract<OrchestrationCommand, { type: "project.meta.update" }>["assistant"];

const patchAssistant = (assistant: AssistantPatch): OrchestrationCommand => ({
  type: "project.meta.update",
  commandId: CommandId.make("cmd-assistant"),
  projectId: PROJECT_ID,
  assistant,
});

const writeSchedules = (schedules: ReadonlyArray<ProjectScheduleInput>) =>
  patchAssistant({ schedules });

const agentChange = (
  change: ProjectScheduleAgentChange,
  actorThreadId: ThreadId = COORDINATOR,
): OrchestrationCommand => ({
  type: "project.schedule.agent-change",
  commandId: CommandId.make("cmd-agent-change"),
  projectId: PROJECT_ID,
  actorThreadId,
  change,
  createdAt: DECIDED_AT,
});

const expectRejected = Effect.fn("expectRejected")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  detail?: string,
) {
  const error = yield* rejection(readModel, command);
  expect(error._tag).toBe("OrchestrationCommandInvariantError");
  if (detail !== undefined) expect(error).toMatchObject({ detail });
});

it.layer(NodeServices.layer)("schedule decider", (it) => {
  describe("user writes", () => {
    it.effect("stamps a new schedule as the user's and stores its prompt", () =>
      Effect.gen(function* () {
        const next = yield* resolve(
          makeReadModel({ coordinatorThreadId: COORDINATOR }),
          writeSchedules([input("brief", { prompt: "Summarize the day." })]),
        );
        expect(next?.schedules).toEqual([
          {
            id: "brief",
            name: "Schedule brief",
            cron: "0 7 * * 1-5",
            target: "coordinator",
            enabled: true,
            createdBy: "user",
            updatedBy: "user",
            updatedAt: DECIDED_AT,
          },
        ]);
        expect(next?.schedulePrompts).toEqual({ brief: "Summarize the day." });
      }),
    );

    it.effect("keeps the stored prompt when a write omits it, and needs one for a new id", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(withSchedules([storedSchedule("brief")]));
        const next = yield* resolve(readModel, writeSchedules([kept("brief", { enabled: false })]));
        expect(next?.schedulePrompts).toEqual({ brief: "Prompt brief" });
        expect(next?.schedules?.[0]?.enabled).toBe(false);
        yield* expectRejected(
          readModel,
          writeSchedules([kept("brief"), input("new-one")]),
          "New schedule 'Schedule new-one' needs a prompt.",
        );
      }),
    );

    it.effect("enforces the limit, the id pattern, unique ids, the prompt and the cron", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel({ coordinatorThreadId: COORDINATOR });
        const many = Array.from({ length: 21 }, (_, index) =>
          input(`s-${index}`, { prompt: "Go." }),
        );
        yield* expectRejected(
          readModel,
          writeSchedules(many),
          "A Project has at most 20 schedules.",
        );
        yield* Effect.forEach(
          [
            [input("Bad Id", { prompt: "Go." })],
            [input("dup", { prompt: "Go." }), input("dup", { prompt: "Go." })],
            [input("empty", { prompt: "   " })],
            [input("long", { prompt: "x".repeat(2_001) })],
            [input("often", { prompt: "Go.", cron: "*/5 * * * *" })],
            [input("both", { prompt: "Go.", cron: "0 7 1 * 1" })],
            [input("name", { prompt: "Go.", name: "n".repeat(81) })],
          ],
          (schedules) => expectRejected(readModel, writeSchedules(schedules)),
        );
        const twenty = yield* resolve(readModel, writeSchedules(many.slice(0, 20)));
        expect(twenty?.schedules).toHaveLength(20);
        // An id that names an Object.prototype key is still a new id with no stored prompt.
        yield* expectRejected(readModel, writeSchedules([input("constructor")]));
        const named = yield* resolve(
          readModel,
          writeSchedules([input("constructor", { prompt: "Go." })]),
        );
        expect(named?.schedulePrompts).toEqual({ constructor: "Go." });
        expect(named).not.toHaveProperty("scheduleRuns");
      }),
    );

    it.effect("runs only in the coordinator or a live standing agent of the Project", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel({ coordinatorThreadId: COORDINATOR });
        for (const target of [
          ThreadId.make("thread-missing"),
          ARCHIVED_STANDING,
          ONE_OFF,
          ELSEWHERE,
        ]) {
          yield* expectRejected(readModel, writeSchedules([input("s", { prompt: "Go.", target })]));
        }
        const standing = yield* resolve(
          readModel,
          writeSchedules([input("s", { prompt: "Go.", target: STANDING })]),
        );
        expect(standing?.schedules?.[0]?.target).toBe(STANDING);
        const coordinator = yield* resolve(
          readModel,
          writeSchedules([input("s", { prompt: "Go.", target: COORDINATOR })]),
        );
        expect(coordinator?.schedules?.[0]?.target).toBe("coordinator");
      }),
    );

    it.effect("keeps an agent that was unpinned later as the target of an unchanged entry", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(withSchedules([storedSchedule("s", { target: ONE_OFF })]));
        const next = yield* resolve(readModel, writeSchedules([kept("s", { target: ONE_OFF })]));
        expect(next?.schedules?.[0]).toEqual(storedSchedule("s", { target: ONE_OFF }));
      }),
    );

    it.effect("keeps an unchanged entry's stamps and restamps an edited one", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(
          withSchedules([
            storedSchedule("same", { createdBy: STANDING, updatedBy: STANDING }),
            storedSchedule("edited", { createdBy: STANDING, updatedBy: STANDING }),
          ]),
        );
        const next = yield* resolve(
          readModel,
          writeSchedules([kept("same"), kept("edited", { prompt: "New words." })]),
        );
        expect(next?.schedules?.[0]).toEqual(
          storedSchedule("same", { createdBy: STANDING, updatedBy: STANDING }),
        );
        expect(next?.schedules?.[1]).toEqual(
          storedSchedule("edited", {
            createdBy: STANDING,
            updatedBy: "user",
            updatedAt: DECIDED_AT,
          }),
        );
      }),
    );

    it.effect("drops a removed schedule's prompt and run", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(
          withSchedules([storedSchedule("kept"), storedSchedule("removed")], {
            scheduleRuns: { kept: missedRun, removed: missedRun },
          }),
        );
        const next = yield* resolve(readModel, writeSchedules([kept("kept")]));
        expect(next?.schedules?.map((entry) => entry.id)).toEqual(["kept"]);
        expect(next?.schedulePrompts).toEqual({ kept: "Prompt kept" });
        expect(next?.scheduleRuns).toEqual({ kept: missedRun });
        const empty = yield* resolve(readModel, writeSchedules([]));
        expect(empty).toEqual({ coordinatorThreadId: COORDINATOR });
      }),
    );

    it.effect("refuses a list built before an agent changed a schedule", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(
          withSchedules([storedSchedule("a"), storedSchedule("b", { enabled: false })]),
        );
        // The coordinator rewrites A's prompt, which turns A off.
        const afterAgent = yield* apply(
          readModel,
          yield* decide(readModel, agentChange({ kind: "upsert", id: "a", prompt: "Injected." })),
        );
        const agentEdited = assistantOf(afterAgent)?.schedules?.[0];
        expect(agentEdited).toMatchObject({ enabled: false, updatedBy: COORDINATOR });

        // A client still showing A on turns B on and sends the whole list.
        const stale = writeSchedules([kept("a"), kept("b", { enabled: true })]);
        yield* expectRejected(
          afterAgent,
          stale,
          "Schedules changed since they were loaded. Try again.",
        );
        // An existing entry with no echo, or an echo for an entry that is gone, is stale too.
        yield* expectRejected(afterAgent, writeSchedules([input("a"), kept("b")]));
        yield* expectRejected(
          afterAgent,
          writeSchedules([
            kept("a", { updatedAt: agentEdited?.updatedAt }),
            kept("b"),
            kept("gone"),
          ]),
        );

        // Reloaded, the same write keeps A off with the agent's prompt and label.
        const next = yield* resolve(
          afterAgent,
          writeSchedules([
            kept("a", { enabled: false, updatedAt: agentEdited?.updatedAt }),
            kept("b", { enabled: true }),
          ]),
        );
        expect(next?.schedules?.[0]).toEqual(agentEdited);
        expect(next?.schedulePrompts?.a).toBe("Injected.");
        expect(next?.schedules?.[1]).toMatchObject({ enabled: true, updatedBy: "user" });
      }),
    );
  });

  describe("carry-over and lifecycle", () => {
    const scheduled = withSchedules(
      [storedSchedule("brief"), storedSchedule("sales", { target: STANDING })],
      { scheduleRuns: { brief: missedRun } },
    );

    it.effect("an archive-only patch keeps every schedule, prompt and run", () =>
      Effect.gen(function* () {
        const next = yield* resolve(makeReadModel(scheduled), patchAssistant({ archived: true }));
        expect(next).toEqual({ ...scheduled, archivedAt: DECIDED_AT });
      }),
    );

    it.effect("unarchiving re-arms every schedule", () =>
      Effect.gen(function* () {
        const next = yield* resolve(
          makeReadModel({ ...scheduled, archivedAt: NOW }),
          patchAssistant({ archived: false }),
        );
        expect(next?.archivedAt).toBeNull();
        expect(next?.schedules?.map((entry) => entry.updatedAt)).toEqual([DECIDED_AT, DECIDED_AT]);
        expect(next?.schedules?.map((entry) => entry.updatedBy)).toEqual(["user", "user"]);
        expect(next?.scheduleRuns).toEqual({ brief: missedRun });
      }),
    );

    it.effect("a coordinator swap keeps coordinator targets and adopts the new one's", () =>
      Effect.gen(function* () {
        const next = yield* resolve(
          makeReadModel(scheduled),
          patchAssistant({ coordinatorThreadId: STANDING }),
        );
        expect(next?.coordinatorThreadId).toBe(STANDING);
        expect(next?.schedules?.map((entry) => [entry.id, entry.target, entry.updatedAt])).toEqual([
          ["brief", "coordinator", NOW],
          ["sales", "coordinator", NOW],
        ]);
      }),
    );

    it.effect("Move to Tasks drops everything", () =>
      Effect.gen(function* () {
        const next = yield* resolve(makeReadModel(scheduled), patchAssistant(null));
        expect(next).toBeNull();
      }),
    );
  });

  describe("agent changes", () => {
    it.effect("saves a new schedule off, authored by the calling thread", () =>
      Effect.gen(function* () {
        const next = yield* resolve(
          makeReadModel({ coordinatorThreadId: COORDINATOR }),
          agentChange({
            kind: "upsert",
            id: "digest",
            name: "Digest",
            prompt: "Summarize changes.",
            cron: "0 9 * * 1-5",
          }),
        );
        expect(next?.schedules).toEqual([
          {
            id: "digest",
            name: "Digest",
            cron: "0 9 * * 1-5",
            target: "coordinator",
            enabled: false,
            createdBy: COORDINATOR,
            updatedBy: COORDINATOR,
            updatedAt: DECIDED_AT,
          },
        ]);
        expect(next?.schedulePrompts).toEqual({ digest: "Summarize changes." });
        yield* expectRejected(
          makeReadModel({ coordinatorThreadId: COORDINATOR }),
          agentChange({ kind: "upsert", id: "digest", name: "Digest", cron: "0 9 * * 1-5" }),
          "A new schedule needs a name, a prompt and a cron.",
        );
      }),
    );

    it.effect("turns a schedule off when its prompt changes, and allows a pause", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(withSchedules([storedSchedule("brief")]));
        const edited = yield* resolve(
          readModel,
          agentChange({ kind: "upsert", id: "brief", prompt: "Different words." }),
        );
        expect(edited?.schedules?.[0]).toMatchObject({
          enabled: false,
          createdBy: "user",
          updatedBy: COORDINATOR,
          updatedAt: DECIDED_AT,
        });
        expect(edited?.schedulePrompts).toEqual({ brief: "Different words." });

        const renamed = yield* resolve(
          readModel,
          agentChange({ kind: "upsert", id: "brief", name: "Renamed" }),
        );
        expect(renamed?.schedules?.[0]).toMatchObject({ name: "Renamed", enabled: true });

        const paused = yield* resolve(
          readModel,
          agentChange({ kind: "upsert", id: "brief", enabled: false }),
        );
        expect(paused?.schedules?.[0]).toMatchObject({ enabled: false, updatedBy: COORDINATOR });
      }),
    );

    it.effect("a change to one schedule leaves the user's other schedule as stored", () =>
      Effect.gen(function* () {
        // The user just turned A on; the agent's write names only B.
        const userEnabledA = storedSchedule("a", { enabled: true, updatedAt: NOW });
        const readModel = makeReadModel(
          withSchedules([userEnabledA, storedSchedule("b", { enabled: false })]),
        );
        const next = yield* resolve(
          readModel,
          agentChange({ kind: "upsert", id: "b", cron: "0 8 * * *" }),
        );
        expect(next?.schedules?.[0]).toEqual(userEnabledA);
        expect(next?.schedules?.[1]).toMatchObject({ cron: "0 8 * * *", enabled: false });
      }),
    );

    it.effect("delete removes the schedule, its prompt and its run", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(
          withSchedules([storedSchedule("a"), storedSchedule("b")], {
            scheduleRuns: { a: missedRun, b: missedRun },
          }),
        );
        const next = yield* resolve(readModel, agentChange({ kind: "delete", id: "a" }));
        expect(next?.schedules?.map((entry) => entry.id)).toEqual(["b"]);
        expect(next?.schedulePrompts).toEqual({ b: "Prompt b" });
        expect(next?.scheduleRuns).toEqual({ b: missedRun });
        yield* expectRejected(readModel, agentChange({ kind: "delete", id: "missing" }));
      }),
    );

    it.effect("only the coordinator of a live Project can change its schedules", () =>
      Effect.gen(function* () {
        const pause = { kind: "upsert", id: "a", enabled: false } as const;
        const readModel = makeReadModel(withSchedules([storedSchedule("a")]));
        for (const actor of [ELSEWHERE, STANDING, ONE_OFF, ThreadId.make("thread-missing")]) {
          yield* expectRejected(
            readModel,
            agentChange(pause, actor),
            "Only the Project's coordinator can manage schedules.",
          );
        }
        yield* expectRejected(
          makeReadModel(withSchedules([storedSchedule("a")], { archivedAt: NOW })),
          agentChange(pause),
        );
      }),
    );
  });

  describe("run records", () => {
    const record = (scheduleId: string, run = missedRun): OrchestrationCommand => ({
      type: "project.schedule.record",
      commandId: CommandId.make(`cp-schedule-run:${scheduleId}`),
      projectId: PROJECT_ID,
      scheduleId,
      run,
      createdAt: run.at,
    });

    it.effect("records a run without touching the Project's updatedAt", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(withSchedules([storedSchedule("brief")]));
        const events = yield* decide(readModel, record("brief"));
        expect(events.map((event) => event.type)).toEqual(["project.schedule-run-recorded"]);
        const next = yield* apply(readModel, events);
        const project = next.projects.find((entry) => entry.id === PROJECT_ID);
        expect(project?.assistant?.scheduleRuns).toEqual({ brief: missedRun });
        expect(project?.updatedAt).toBe(NOW);
      }),
    );

    it.effect("rejects a record for a schedule that is gone", () =>
      Effect.gen(function* () {
        yield* expectRejected(
          makeReadModel(withSchedules([storedSchedule("brief")])),
          record("gone"),
        );
        yield* expectRejected(makeReadModel(null), record("brief"));
      }),
    );

    it.effect("re-records the same slot but never moves back to an older one", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel(
          withSchedules([storedSchedule("brief")], { scheduleRuns: { brief: missedRun } }),
        );
        const failed: ProjectScheduleRun = {
          slot: missedRun.slot,
          at: missedRun.at,
          trigger: "cron",
          outcome: "failed",
        };
        const next = yield* apply(readModel, yield* decide(readModel, record("brief", failed)));
        expect(assistantOf(next)?.scheduleRuns).toEqual({ brief: failed });
        yield* expectRejected(
          readModel,
          record("brief", { ...missedRun, slot: "2026-01-01T07:00:00.000Z" }),
          "Schedule 'brief' already has a run for a later slot.",
        );
      }),
    );
  });

  it.effect("a scheduled turn keeps a snoozed target snoozed but still unsettles it", () =>
    Effect.gen(function* () {
      const snoozed = makeReadModel(withSchedules([storedSchedule("brief")]), [
        makeThread(COORDINATOR, {
          title: "Personal",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          snoozedAt: NOW,
          settledOverride: "active",
        }),
      ]);
      const start = (messageId: string): OrchestrationCommand => ({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${messageId}`),
        threadId: COORDINATOR,
        message: {
          messageId: MessageId.make(messageId),
          role: "user",
          text: "Summarize the day.",
          attachments: [],
          source: { kind: "agent", threadTitle: "Morning brief", scheduleId: "brief" },
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      });
      const scheduled = yield* decide(
        snoozed,
        start(`cp-schedule:${PROJECT_ID}:brief:2026-01-02T07:00:00.000Z`),
      );
      expect(scheduled.map((event) => event.type)).toContain("thread.unsettled");
      expect(scheduled.map((event) => event.type)).not.toContain("thread.unsnoozed");
      const other = yield* decide(snoozed, start("message-peer"));
      expect(other.map((event) => event.type)).toContain("thread.unsnoozed");
    }),
  );
});
