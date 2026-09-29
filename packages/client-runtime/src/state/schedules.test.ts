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
  buildScheduleEditorDraft,
  buildScheduleInputs,
  buildScheduleRows,
  cronToPreset,
  DEFAULT_SCHEDULE_PRESET,
  diffScheduleRunAlerts,
  formatScheduleClock,
  formatScheduledMessageTime,
  formatTimeUntil,
  hasScheduleAttention,
  initialScheduleEditorForm,
  planPauseAllSchedules,
  presetToCron,
  resolveScheduleEditor,
  resolveScheduleHost,
  resolveScheduleRowState,
  scheduleAuthorLabel,
  scheduleDeletionWarning,
  scheduleEditorChange,
  scheduleHostProblems,
  scheduleHostProblemText,
  scheduleHostSummary,
  schedulePresetError,
  scheduleRunNotice,
  scheduleTargetOptions,
  scheduleUnsupportedText,
  storedSchedulePrompt,
  summarizeSchedules,
  switchSchedulePreset,
  toggleScheduleDay,
  type ScheduleEditorForm,
  type ScheduleListThread,
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

describe("buildScheduleRows", () => {
  function thread(overrides: Partial<ScheduleListThread> & Pick<ScheduleListThread, "id">) {
    return {
      title: "Thread",
      archivedAt: null,
      session: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      latestUserMessageAt: null,
      ...overrides,
    };
  }
  const threads = [
    thread({ id: coordinatorThreadId, title: "Personal" }),
    thread({ id: salesThreadId, title: "Sales" }),
  ];
  const rows = (input: {
    schedules: ProjectSchedule[];
    scheduleRuns?: Record<string, ProjectScheduleRun>;
    threads?: readonly ScheduleListThread[];
    held?: Record<string, { since: string }>;
  }) =>
    buildScheduleRows({
      assistant: assistant({
        schedules: input.schedules,
        ...(input.scheduleRuns ? { scheduleRuns: input.scheduleRuns } : {}),
      }),
      projectTitle: "Personal project",
      threads: input.threads ?? threads,
      held: input.held,
      now: NOW,
      timeZone: ZONE,
    });

  it("reads cadence, target and next run in the host zone, or Paused", () => {
    const [on, paused] = rows({
      schedules: [
        schedule(),
        schedule({ id: "weekly-review", cron: "0 16 * * 5", enabled: false }),
      ],
    });
    // Tuesday 9:00 in Denver; the next weekday 7:00 is 22 hours away.
    expect(on).toMatchObject({
      detail: "Weekdays at 7:00 · Coordinator · in 22h",
      targetTitle: "Personal",
      state: { text: "Not run yet" },
      author: null,
    });
    expect(paused!.detail).toBe("Fridays at 16:00 · Coordinator · Paused");
  });

  it("names a standing agent target, and a missing one without failing the row", () => {
    const toSales = schedule({ id: "pipeline", target: salesThreadId });
    expect(
      rows({ schedules: [toSales], held: { pipeline: { since: NOW.toISOString() } } })[0],
    ).toMatchObject({
      detail: "Weekdays at 7:00 · Sales · in 22h",
      targetTitle: "Sales",
      state: { kind: "held", text: "Queued until Sales is idle" },
    });
    const archived = [threads[0]!, { ...threads[1]!, archivedAt: NOW.toISOString() }];
    expect(rows({ schedules: [toSales], threads: archived })[0]).toMatchObject({
      detail: "Weekdays at 7:00 · Missing agent · in 22h",
      targetTitle: "its agent",
    });
  });

  it("falls back to the Project title before the coordinator's shell arrives", () => {
    expect(rows({ schedules: [schedule()], threads: [] })[0]!.targetTitle).toBe("Personal project");
  });

  it("reads Running now from the target's shell, and labels an agent's schedule", () => {
    const sent = run();
    const [row] = rows({
      schedules: [schedule({ createdBy: coordinatorThreadId, updatedBy: coordinatorThreadId })],
      scheduleRuns: { [schedule().id]: sent },
      threads: [
        thread({
          id: coordinatorThreadId,
          title: "Personal",
          session: { status: "running" },
          latestUserMessageAt: sent.at,
        }),
      ],
    });
    expect(row).toMatchObject({ state: { kind: "running" }, author: "Created by Personal" });
  });

  it("reads the same rows on an engine without longOffset or formatToParts, as Hermes", () => {
    // Edmonton keeps Denver's clock; no other test reads it, so no zone or run is cached yet.
    const build = () =>
      buildScheduleRows({
        assistant: assistant({
          schedules: [schedule(), schedule({ id: "weekly-review", cron: "30 16 * * 5" })],
          scheduleRuns: {
            [schedule().id]: run(),
            "weekly-review": run({ at: "2026-09-25T22:30:00.000Z" }),
          },
        }),
        projectTitle: "Personal project",
        threads,
        held: undefined,
        now: NOW,
        timeZone: "America/Edmonton",
      }).map((row) => [row.detail, row.state.text]);

    const realFormat = Intl.DateTimeFormat;
    class HermesDateTimeFormat extends realFormat {
      constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
        if (options?.timeZoneName === "longOffset") throw new RangeError("Invalid timeZoneName");
        super(locales, options);
      }
      override formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
        return [{ type: "literal", value: this.format(date) }];
      }
    }
    Intl.DateTimeFormat = HermesDateTimeFormat as typeof Intl.DateTimeFormat;
    let hermes: ReturnType<typeof build>;
    try {
      hermes = build();
    } finally {
      Intl.DateTimeFormat = realFormat;
    }

    expect(hermes).toEqual([
      ["Weekdays at 7:00 · Coordinator · in 22h", "Ran at 7:00"],
      ["Fridays at 16:30 · Coordinator · in 3d", "Ran on Sep 25 at 16:30"],
    ]);
    expect(build()).toEqual(hermes);
  });
});

describe("schedule editor", () => {
  const options = [
    { value: "coordinator" as const, label: "Coordinator" },
    { value: salesThreadId, label: "Sales" },
  ];
  const editor = (input: {
    opened: ProjectSchedule | null;
    form?: Partial<ScheduleEditorForm>;
    storedPrompt?: string;
    changed?: "edited" | "deleted" | null;
    saving?: boolean;
  }) => {
    const form = { ...initialScheduleEditorForm(input.opened), ...input.form };
    const view = resolveScheduleEditor({
      opened: input.opened,
      form,
      storedPrompt: input.storedPrompt,
      targetOptions: options,
      changed: input.changed ?? null,
      saving: input.saving ?? false,
      now: NOW,
      timeZone: ZONE,
    });
    return { view, draft: () => buildScheduleEditorDraft({ opened: input.opened, form, view }) };
  };

  it("saves a new schedule only with a name and a prompt, switched on, with a fresh id", () => {
    expect(editor({ opened: null }).view).toMatchObject({ canSave: false, dirty: false });
    expect(editor({ opened: null, form: { name: "Morning brief" } }).view.canSave).toBe(false);
    const { view, draft } = editor({
      opened: null,
      form: { name: " Morning brief ", typedPrompt: "Summarize." },
    });
    expect(view).toMatchObject({ canSave: true, dirty: true, cron: "0 9 * * 1-5" });
    expect(view.nextRuns.map((date) => date.toISOString())).toEqual([
      "2026-09-30T15:00:00.000Z",
      "2026-10-01T15:00:00.000Z",
      "2026-10-02T15:00:00.000Z",
    ]);
    expect(draft()).toMatchObject({
      name: "Morning brief",
      cron: "0 9 * * 1-5",
      target: "coordinator",
      enabled: true,
      prompt: "Summarize.",
      updatedAt: undefined,
    });
    expect(draft().id).toMatch(/^morning-brief-[a-z0-9]{6}$/);
  });

  it("keeps an untouched cadence and prompt, echoing the version it opened", () => {
    const opened = schedule({ cron: "15 */2 * * *", enabled: false });
    const { view, draft } = editor({ opened });
    expect(view).toMatchObject({
      promptUnknown: true,
      promptRequired: false,
      canSave: true,
      dirty: false,
    });
    expect(draft()).toEqual({
      id: opened.id,
      name: "Morning brief",
      cron: "15 */2 * * *",
      target: "coordinator",
      enabled: false,
      updatedAt: opened.updatedAt,
    });
  });

  it("sends a typed prompt, and refuses an emptied one", () => {
    const opened = schedule();
    expect(
      editor({ opened, storedPrompt: "Old", form: { typedPrompt: "New" } }).draft(),
    ).toMatchObject({ prompt: "New" });
    expect(editor({ opened, storedPrompt: "Old", form: { typedPrompt: "Old" } }).view.dirty).toBe(
      false,
    );
    expect(editor({ opened, form: { typedPrompt: "  " } }).view.canSave).toBe(false);
  });

  it("refuses to save over a schedule that changed, except while its own save lands", () => {
    const opened = schedule();
    expect(editor({ opened, changed: "edited" }).view).toMatchObject({
      canSave: false,
      changed: "edited",
    });
    expect(editor({ opened, changed: "edited", saving: true }).view.changed).toBeNull();
    expect(scheduleEditorChange(opened, [opened])).toBeNull();
    expect(
      scheduleEditorChange(opened, [{ ...opened, updatedAt: "2026-09-29T14:00:00.000Z" }]),
    ).toBe("edited");
    expect(scheduleEditorChange(opened, [])).toBe("deleted");
    expect(scheduleEditorChange(null, [])).toBeNull();
  });

  it("refuses a target no longer offered and a cadence that never runs", () => {
    const opened = schedule({ target: ThreadId.make("unpinned") });
    expect(editor({ opened }).view).toMatchObject({ targetKnown: false, canSave: false });
    const never = editor({
      opened: schedule(),
      form: {
        cadenceTouched: true,
        preset: { ...DEFAULT_SCHEDULE_PRESET, kind: "custom", cron: "0 9 31 2 *" },
      },
    }).view;
    expect(never).toMatchObject({
      cadenceError: "That schedule never runs.",
      nextRuns: [],
      canSave: false,
      dirty: true,
    });
  });

  it("starts Custom from the cadence on screen and toggles weekly days in order", () => {
    const weekly = { ...DEFAULT_SCHEDULE_PRESET, kind: "weekly" as const, days: [1] };
    expect(switchSchedulePreset(weekly, "custom", "0 9 * * 1")).toMatchObject({
      kind: "custom",
      cron: "0 9 * * 1",
      days: [1],
    });
    const custom = { ...weekly, kind: "custom" as const, cron: "5 4 * * *" };
    expect(switchSchedulePreset(custom, "custom", "0 9 * * 1").cron).toBe("5 4 * * *");
    expect(switchSchedulePreset(custom, "daily", "5 4 * * *").kind).toBe("daily");
    expect(toggleScheduleDay([5, 1], 0)).toEqual([0, 1, 5]);
    expect(toggleScheduleDay([0, 1, 5], 1)).toEqual([0, 5]);
  });
});

describe("schedule host and notices", () => {
  const host = {
    scheduler: "launchd" as const,
    backend: "os" as const,
    timeZone: ZONE,
    entry: { state: "installed" as const },
    problems: ["backend-off" as const, "zone-mismatch" as const],
    hostZone: "America/Boise",
  };

  it("lists host problems, leaving backend-off to the unsupported line", () => {
    expect(scheduleHostProblems(host)).toEqual(["zone-mismatch"]);
    expect(scheduleHostProblems(null)).toEqual([]);
    expect(scheduleHostProblemText("zone-mismatch", host)).toBe(
      "The host's time zone is America/Boise, but Control Plane is using America/Denver. Restart Control Plane to switch.",
    );
    expect(scheduleUnsupportedText(["unsupported-platform"])).toBe(
      "Schedules aren't available on Windows yet.",
    );
    expect(scheduleUnsupportedText(["backend-off"])).toBe(
      "This host doesn't run schedules. They run from the Control Plane desktop app.",
    );
  });

  it("reads the live host over the startup capability, and replaces the list where none run", () => {
    const capability = { scheduler: "launchd" as const, timeZone: "America/Boise" };
    expect(resolveScheduleHost({ capability, host: null })).toEqual({
      timeZone: "America/Boise",
      scheduler: "launchd",
      unsupportedText: null,
      problems: [],
    });
    expect(resolveScheduleHost({ capability, host })).toEqual({
      timeZone: ZONE,
      scheduler: "launchd",
      unsupportedText: null,
      problems: [scheduleHostProblemText("zone-mismatch", host)],
    });
    const off = { ...host, scheduler: "none" as const, problems: ["backend-off" as const] };
    expect(resolveScheduleHost({ capability, host: off }).unsupportedText).toBe(
      "This host doesn't run schedules. They run from the Control Plane desktop app.",
    );
    expect(
      resolveScheduleHost({ capability: { ...capability, scheduler: "none" }, host: null })
        .unsupportedText,
    ).toBe("This host doesn't run schedules. They run from the Control Plane desktop app.");
  });

  it("reads a stored prompt by own key only, and a preset's clock time", () => {
    expect(storedSchedulePrompt({ brief: "Summarize." }, "brief")).toBe("Summarize.");
    expect(storedSchedulePrompt({}, "constructor")).toBeUndefined();
    expect(storedSchedulePrompt(undefined, "brief")).toBeUndefined();
    expect(formatScheduleClock(7, 5)).toBe("7:05");
    expect(formatScheduleClock(16, 30)).toBe("16:30");
  });

  it("names the host and its scheduler on the read-only line", () => {
    expect(scheduleHostSummary({ scheduler: "launchd", backend: "os", hostLabel: "Studio" })).toBe(
      "Runs on Studio with launchd while Control Plane is running there.",
    );
    expect(
      scheduleHostSummary({ scheduler: "launchd", backend: "dry-run", hostLabel: "Studio" }),
    ).toBe("Dry run on Studio: its launchd entry is written but never installed.");
    expect(scheduleHostSummary({ scheduler: "none", backend: null, hostLabel: "Studio" })).toBe(
      null,
    );
  });

  it("says why Run now did not send", () => {
    expect(scheduleRunNotice({ outcome: "sent" }, "Sales")).toBeNull();
    expect(scheduleRunNotice({ outcome: "held" }, "Sales")).toEqual({
      tone: "info",
      title: "Queued until Sales is idle",
    });
    expect(scheduleRunNotice({ outcome: "missed", reason: "target-missing" }, "Sales")).toEqual({
      tone: "warning",
      title: "Schedule missed",
      description: "The thread it runs in is gone. Edit the schedule to pick another.",
    });
  });

  it("warns Move to Tasks about the schedules it deletes", () => {
    expect(scheduleDeletionWarning(assistant())).toBeNull();
    expect(scheduleDeletionWarning(assistant({ schedules: [schedule()] }))).toBe(
      "1 schedule will be deleted.",
    );
    expect(
      scheduleDeletionWarning(assistant({ schedules: [schedule(), schedule({ id: "b" })] })),
    ).toBe("2 schedules will be deleted.");
  });

  it("times a scheduled prompt's label, with the day once it is not today", () => {
    expect(formatScheduledMessageTime("2026-09-29T13:00:02.000Z", NOW, ZONE)).toBe("7:00");
    expect(formatScheduledMessageTime("2026-09-25T22:30:00.000Z", NOW, ZONE)).toBe(
      "Sep 25 at 16:30",
    );
    expect(formatScheduledMessageTime("not a date", NOW, ZONE)).toBe("");
  });
});
