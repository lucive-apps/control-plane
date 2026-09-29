// @effect-diagnostics globalDate:off -- Fixed instants keep zone and row-copy assertions deterministic.
import {
  ProjectId,
  ThreadId,
  type ProjectAssistant,
  type ProjectSchedule,
  type ProjectScheduleRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildScheduleInputs,
  cronToPreset,
  DEFAULT_SCHEDULE_PRESET,
  diffScheduleRunAlerts,
  formatTimeUntil,
  hasScheduleAttention,
  planPauseAllSchedules,
  presetToCron,
  resolveScheduleRowState,
  scheduleAuthorLabel,
  schedulePresetError,
  scheduleTargetOptions,
  summarizeSchedules,
  type SchedulePreset,
} from "./schedules.ts";

const ZONE = "America/Denver";
// 2026-09-29 13:00Z is 7:00 in Denver (MDT).
const NOW = new Date("2026-09-29T15:00:00.000Z");
const coordinatorThreadId = ThreadId.make("thread-coordinator");
const salesThreadId = ThreadId.make("thread-sales");

function schedule(overrides: Partial<ProjectSchedule> = {}): ProjectSchedule {
  return {
    id: "morning-brief-abc123",
    name: "Morning brief",
    cron: "0 7 * * 1-5",
    target: "coordinator",
    enabled: true,
    createdBy: "user",
    updatedBy: "user",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<ProjectScheduleRun> = {}): ProjectScheduleRun {
  return {
    slot: "2026-09-29T13:00:00.000Z",
    at: "2026-09-29T13:00:02.000Z",
    trigger: "cron",
    outcome: "sent",
    threadId: coordinatorThreadId,
    ...overrides,
  };
}

function rowText(input: {
  schedule?: ProjectSchedule;
  run?: ProjectScheduleRun;
  held?: { since: string };
  targetThread?: Parameters<typeof resolveScheduleRowState>[0]["targetThread"];
}) {
  return resolveScheduleRowState({
    schedule: input.schedule ?? schedule(),
    run: input.run,
    held: input.held,
    targetTitle: "Sales",
    targetThread: input.targetThread ?? null,
    now: NOW,
    timeZone: ZONE,
  });
}

function assistant(overrides: Partial<ProjectAssistant> = {}): ProjectAssistant {
  return { coordinatorThreadId, ...overrides };
}

describe("schedule presets", () => {
  it("round-trips every preset kind through its cron", () => {
    const presets: SchedulePreset[] = [
      { ...DEFAULT_SCHEDULE_PRESET, kind: "daily", hour: 7, minute: 30 },
      { ...DEFAULT_SCHEDULE_PRESET, kind: "weekdays", hour: 7, minute: 0 },
      { ...DEFAULT_SCHEDULE_PRESET, kind: "weekly", hour: 16, minute: 0, days: [0, 5] },
      { ...DEFAULT_SCHEDULE_PRESET, kind: "hourly", everyHours: 1 },
      { ...DEFAULT_SCHEDULE_PRESET, kind: "hourly", everyHours: 5 },
      { ...DEFAULT_SCHEDULE_PRESET, kind: "monthly", hour: 9, minute: 15, dayOfMonth: 28 },
    ];
    for (const preset of presets) {
      const cron = presetToCron(preset);
      expect(schedulePresetError(preset), cron).toBeNull();
      expect(cronToPreset(cron), cron).toEqual({ ...preset, cron });
    }
  });

  it("reads equivalent crons as their preset", () => {
    expect(cronToPreset("0 7 * * MON-FRI").kind).toBe("weekdays");
    expect(cronToPreset("0 7 * * 0-6").kind).toBe("daily");
    expect(cronToPreset("0 16 * * 7")).toMatchObject({ kind: "weekly", days: [0], hour: 16 });
  });

  it("opens anything else as Custom with the cron unchanged", () => {
    for (const cron of ["15 */2 * * *", "0 9 31 * *", "0 9 1 1 *", "0 9,17 * * *", "nope"]) {
      expect(cronToPreset(cron), cron).toMatchObject({ kind: "custom", cron });
    }
  });

  it("explains presets that cannot be saved", () => {
    expect(schedulePresetError({ ...DEFAULT_SCHEDULE_PRESET, kind: "weekly", days: [] })).toBe(
      "Pick at least one day.",
    );
    expect(schedulePresetError({ ...DEFAULT_SCHEDULE_PRESET, kind: "custom", cron: " " })).toBe(
      "Enter a cron expression.",
    );
    expect(
      schedulePresetError({ ...DEFAULT_SCHEDULE_PRESET, kind: "custom", cron: "*/5 * * * *" }),
    ).toBe("Schedules run at most every 15 minutes.");
  });
});

describe("resolveScheduleRowState", () => {
  it("reads a never-run schedule as Not run yet", () => {
    expect(rowText({})).toMatchObject({ kind: "not-run", text: "Not run yet", attention: false });
  });

  it("shows a held run as queued, ahead of the last result", () => {
    expect(
      rowText({ held: { since: NOW.toISOString() }, run: run({ outcome: "failed" }) }),
    ).toMatchObject({ kind: "held", text: "Queued until Sales is idle" });
  });

  it("drops a hold that a run recorded since then has settled", () => {
    const held = { since: "2026-09-29T13:00:00.000Z" };
    expect(
      rowText({ held, run: run({ at: "2026-09-29T13:20:00.000Z", reason: "busy" }) }).text,
    ).toBe("Ran at 7:20 after Sales was busy");
    expect(
      rowText({
        held,
        run: run({ outcome: "missed", reason: "busy", at: "2026-09-29T13:15:00.000Z" }),
      }).text,
    ).toBe("Missed · Sales was busy");
  });

  it("reads a sent run at its time in the host zone, linking the thread", () => {
    expect(rowText({ run: run() })).toEqual({
      kind: "sent",
      text: "Ran at 7:00",
      attention: false,
      linkThreadId: coordinatorThreadId,
      suggestOpenAtLogin: false,
    });
    expect(rowText({ run: run({ at: "2026-09-25T22:00:00.000Z" }) }).text).toBe(
      "Ran on Sep 25 at 16:00",
    );
  });

  it("says why a sent run came late", () => {
    const late = { at: "2026-09-29T13:20:00.000Z" };
    expect(rowText({ run: run({ ...late, reason: "busy" }) }).text).toBe(
      "Ran at 7:20 after Sales was busy",
    );
    expect(rowText({ run: run({ at: "2026-09-29T13:42:00.000Z" }) }).text).toBe(
      "Ran at 7:42 after sleep",
    );
    // Within 5 minutes is on time.
    expect(rowText({ run: run({ at: "2026-09-29T13:04:00.000Z", reason: "busy" }) }).text).toBe(
      "Ran at 7:04",
    );
  });

  it("reads Running now only while the target works on this run's message", () => {
    const working = {
      session: { status: "running" },
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      latestUserMessageAt: run().at,
    };
    expect(rowText({ run: run(), targetThread: working }).text).toBe("Running now");
    expect(
      rowText({
        run: run(),
        targetThread: { ...working, latestUserMessageAt: "2026-09-29T14:00:00.000Z" },
      }).text,
    ).toBe("Ran at 7:00");
    expect(
      rowText({ run: run(), targetThread: { ...working, session: { status: "ready" } } }).text,
    ).toBe("Ran at 7:00");
  });

  it("uses the missed and failed copy, red while enabled", () => {
    const missed = (reason: ProjectScheduleRun["reason"]) =>
      rowText({ run: run({ outcome: "missed", reason, at: "2026-09-29T15:10:00.000Z" }) });
    expect(missed("late")).toMatchObject({
      text: "Missed · host was off at 7:00",
      attention: true,
    });
    expect(missed("no-fire").text).toBe("Missed · host was off at 7:00");
    expect(missed("not-running")).toMatchObject({
      text: "Missed · Control Plane was closed at 7:00",
      suggestOpenAtLogin: true,
    });
    expect(missed("busy").text).toBe("Missed · Sales was busy");
    expect(missed("rejected")).toMatchObject({
      text: "Missed · could not start",
      linkThreadId: coordinatorThreadId,
    });
    expect(missed("target-missing")).toMatchObject({ kind: "pick-target", text: "Pick target" });
    expect(missed(undefined)).toMatchObject({ text: "Missed at 7:00", attention: true });
    expect(rowText({ run: run({ outcome: "failed" }) })).toMatchObject({
      kind: "failed",
      text: "Failed · run errored",
      attention: true,
      linkThreadId: coordinatorThreadId,
    });
  });

  it("is not red while paused", () => {
    expect(
      rowText({
        schedule: schedule({ enabled: false }),
        run: run({ outcome: "missed", reason: "busy" }),
      }),
    ).toMatchObject({ text: "Missed · Sales was busy", attention: false });
  });

  it("reads a miss from before the last edit as Not run yet", () => {
    const edited = schedule({ updatedAt: "2026-09-29T14:00:00.000Z" });
    for (const outcome of ["missed", "failed"] as const) {
      expect(rowText({ schedule: edited, run: run({ outcome, reason: "late" }) })).toMatchObject({
        kind: "not-run",
        text: "Not run yet",
        attention: false,
      });
    }
    // A sent run keeps its result.
    expect(rowText({ schedule: edited, run: run() }).text).toBe("Ran at 7:00");
  });
});

describe("schedule helpers", () => {
  const failing = {
    schedules: [schedule()],
    scheduleRuns: { [schedule().id]: run({ outcome: "missed", reason: "late" }) },
  };

  it("asks for attention only for an armed, enabled miss in an unarchived Project", () => {
    expect(hasScheduleAttention(assistant(failing))).toBe(true);
    expect(hasScheduleAttention(assistant({ ...failing, archivedAt: NOW.toISOString() }))).toBe(
      false,
    );
    expect(
      hasScheduleAttention(assistant({ ...failing, schedules: [schedule({ enabled: false })] })),
    ).toBe(false);
    expect(
      hasScheduleAttention(
        assistant({
          ...failing,
          schedules: [schedule({ updatedAt: "2026-09-29T14:00:00.000Z" })],
        }),
      ),
    ).toBe(false);
    expect(
      hasScheduleAttention(assistant({ ...failing, scheduleRuns: { [schedule().id]: run() } })),
    ).toBe(false);
    expect(hasScheduleAttention(null)).toBe(false);
  });

  it("summarizes the list for the settings row", () => {
    expect(summarizeSchedules(assistant())).toBe("No schedules");
    expect(summarizeSchedules(assistant({ schedules: [schedule()] }))).toBe("1 schedule");
    expect(
      summarizeSchedules(
        assistant({
          schedules: [
            schedule({ id: "a" }),
            schedule({ id: "b" }),
            schedule({ id: "c", enabled: false }),
          ],
        }),
      ),
    ).toBe("3 schedules · 1 paused");
  });

  it("labels a schedule an agent created or edited last", () => {
    const titleOf = (threadId: ThreadId) =>
      threadId === coordinatorThreadId ? "Personal" : threadId === salesThreadId ? "Sales" : null;
    expect(scheduleAuthorLabel(schedule(), titleOf)).toBeNull();
    expect(
      scheduleAuthorLabel(
        schedule({ createdBy: coordinatorThreadId, updatedBy: coordinatorThreadId }),
        titleOf,
      ),
    ).toBe("Created by Personal");
    expect(scheduleAuthorLabel(schedule({ updatedBy: salesThreadId }), titleOf)).toBe(
      "Edited by Sales",
    );
    expect(scheduleAuthorLabel(schedule({ updatedBy: ThreadId.make("gone") }), titleOf)).toBe(
      "Edited by an agent",
    );
  });

  it("builds the whole list with echoes, carrying only the saved entry's prompt", () => {
    const stored = [
      schedule({ id: "a", updatedAt: "2026-09-01T00:00:00.000Z" }),
      schedule({ id: "b", enabled: false, updatedAt: "2026-09-02T00:00:00.000Z" }),
    ];
    const edited = buildScheduleInputs(stored, {
      kind: "save",
      schedule: { ...stored[0]!, name: "Brief", prompt: "Summarize." },
    });
    expect(edited).toEqual([
      {
        id: "a",
        name: "Brief",
        cron: "0 7 * * 1-5",
        target: "coordinator",
        enabled: true,
        prompt: "Summarize.",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "b",
        name: "Morning brief",
        cron: "0 7 * * 1-5",
        target: "coordinator",
        enabled: false,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ]);

    const created = buildScheduleInputs(stored, {
      kind: "save",
      schedule: {
        id: "c",
        name: "New",
        cron: "0 9 * * *",
        target: salesThreadId,
        enabled: true,
        prompt: "Ping.",
      },
    });
    expect(created.at(-1)).toEqual({
      id: "c",
      name: "New",
      cron: "0 9 * * *",
      target: salesThreadId,
      enabled: true,
      prompt: "Ping.",
    });
    expect(created.slice(0, 2).every((input) => input.prompt === undefined)).toBe(true);

    // A save echoes the version the editor opened, so a change made meanwhile refuses it.
    const opened = { ...stored[0]!, updatedAt: "2026-08-01T00:00:00.000Z" };
    expect(buildScheduleInputs(stored, { kind: "save", schedule: opened })[0]!.updatedAt).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    // A schedule deleted meanwhile is refused rather than created again.
    expect(buildScheduleInputs([stored[1]!], { kind: "save", schedule: opened }).at(-1)).toEqual({
      id: "a",
      name: "Morning brief",
      cron: "0 7 * * 1-5",
      target: "coordinator",
      enabled: true,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(buildScheduleInputs(stored, { kind: "delete", id: "a" }).map((i) => i.id)).toEqual([
      "b",
    ]);
    const resumed = buildScheduleInputs(stored, { kind: "set-enabled", ids: ["b"], enabled: true });
    expect(resumed.map((input) => input.enabled)).toEqual([true, true]);
    expect(resumed.every((input) => input.prompt === undefined)).toBe(true);
  });

  it("plans Remove from this host as one pause write per Project with enabled schedules", () => {
    const plan = planPauseAllSchedules([
      {
        id: ProjectId.make("p1"),
        assistant: assistant({ schedules: [schedule({ id: "a" }), schedule({ id: "b" })] }),
      },
      {
        id: ProjectId.make("p2"),
        assistant: assistant({ schedules: [schedule({ id: "c", enabled: false })] }),
      },
      { id: ProjectId.make("p3"), assistant: null },
    ]);
    expect(plan.scheduleCount).toBe(2);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]!.schedules.map((input) => input.enabled)).toEqual([false, false]);
  });

  it("lists the coordinator first, then pinned agents, then a live unpinned current target", () => {
    const threads = [
      { id: coordinatorThreadId, title: "Personal", archivedAt: null, pinnedAt: NOW.toISOString() },
      { id: salesThreadId, title: "Sales", archivedAt: null, pinnedAt: NOW.toISOString() },
      { id: ThreadId.make("one-off"), title: "One-off", archivedAt: null, pinnedAt: null },
      {
        id: ThreadId.make("archived"),
        title: "Old",
        archivedAt: NOW.toISOString(),
        pinnedAt: NOW.toISOString(),
      },
    ];
    expect(
      scheduleTargetOptions({ coordinatorThreadId, threads, current: null }).map((o) => o.label),
    ).toEqual(["Coordinator", "Sales"]);
    expect(
      scheduleTargetOptions({
        coordinatorThreadId,
        threads,
        current: ThreadId.make("one-off"),
      }).map((option) => option.label),
    ).toEqual(["Coordinator", "Sales", "One-off"]);
  });

  it("formats the time until the next run", () => {
    expect(formatTimeUntil(new Date(NOW.getTime() + 5 * 60_000), NOW)).toBe("in 5m");
    expect(formatTimeUntil(new Date(NOW.getTime() + 14.5 * 3_600_000), NOW)).toBe("in 14h");
    expect(formatTimeUntil(new Date(NOW.getTime() + 72 * 3_600_000), NOW)).toBe("in 3d");
  });
});

describe("diffScheduleRunAlerts", () => {
  const projectWith = (scheduleRun: ProjectScheduleRun | undefined, overrides = {}) => ({
    id: ProjectId.make("p1"),
    title: "Personal",
    assistant: assistant({
      schedules: [schedule()],
      ...(scheduleRun ? { scheduleRuns: { [schedule().id]: scheduleRun } } : {}),
      ...overrides,
    }),
  });
  const missed = run({ outcome: "missed", reason: "not-running", at: "2026-09-29T15:00:00.000Z" });

  it("never alerts on the first snapshot", () => {
    expect(diffScheduleRunAlerts(null, [projectWith(missed)]).alerts).toEqual([]);
  });

  it("alerts once for a newly recorded missed run", () => {
    const first = diffScheduleRunAlerts(null, [projectWith(run())]);
    const second = diffScheduleRunAlerts(first.seen, [projectWith(missed)]);
    expect(second.alerts).toEqual([
      {
        projectId: ProjectId.make("p1"),
        projectTitle: "Personal",
        scheduleId: schedule().id,
        scheduleName: "Morning brief",
        run: missed,
      },
    ]);
    expect(diffScheduleRunAlerts(second.seen, [projectWith(missed)]).alerts).toEqual([]);
  });

  it("alerts for a first run that missed on a schedule seen before", () => {
    const first = diffScheduleRunAlerts(null, [projectWith(undefined)]);
    expect(diffScheduleRunAlerts(first.seen, [projectWith(missed)]).alerts).toHaveLength(1);
  });

  it("alerts once when a sent run is re-recorded as missed", () => {
    const sent = run({ at: "2026-09-29T15:00:00.000Z" });
    const first = diffScheduleRunAlerts(null, [projectWith(sent)]);
    const rejected = { ...sent, outcome: "missed" as const, reason: "rejected" as const };
    const second = diffScheduleRunAlerts(first.seen, [projectWith(rejected)]);
    expect(second.alerts.map((alert) => alert.run)).toEqual([rejected]);
    expect(diffScheduleRunAlerts(second.seen, [projectWith(rejected)]).alerts).toEqual([]);
  });

  it("leaves failed runs, paused schedules and archived Projects alone", () => {
    const first = diffScheduleRunAlerts(null, [projectWith(run())]);
    const failed = run({ outcome: "failed", at: "2026-09-29T15:00:00.000Z" });
    expect(diffScheduleRunAlerts(first.seen, [projectWith(failed)]).alerts).toEqual([]);
    expect(
      diffScheduleRunAlerts(first.seen, [
        projectWith(missed, { schedules: [schedule({ enabled: false })] }),
      ]).alerts,
    ).toEqual([]);
    expect(
      diffScheduleRunAlerts(first.seen, [projectWith(missed, { archivedAt: NOW.toISOString() })])
        .alerts,
    ).toEqual([]);
  });
});
