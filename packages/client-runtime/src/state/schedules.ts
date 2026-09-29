import {
  isRunningAgent,
  type ProjectAssistant,
  type ProjectId,
  type ProjectSchedule,
  type ProjectScheduleInput,
  type ProjectScheduler,
  type ProjectScheduleRun,
  type ProjectScheduleTarget,
  type ScheduleHostProblem,
  type ScheduleHostStatus,
  type SchedulesRunResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  describeCadence,
  newScheduleId,
  nextScheduleRuns,
  validateScheduleCron,
  wallClockAt,
} from "@t3tools/shared/schedules";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";

// Fork-owned. Presentation logic behind the Schedules panel, shared by web and
// mobile. Hermes-safe: no toSorted/toSpliced, sort copies instead. Times read
// in the host's zone, which the caller passes in.

export type SchedulePresetKind = "daily" | "weekdays" | "weekly" | "hourly" | "monthly" | "custom";

/**
 * The editor's cadence form. Every kind's fields stay filled, so switching
 * kinds keeps the time and days the user already picked.
 */
export interface SchedulePreset {
  readonly kind: SchedulePresetKind;
  /** The time for daily, weekdays, weekly and monthly: 0-23 and 0-59. */
  readonly hour: number;
  readonly minute: number;
  /** Weekly days, 0 = Sunday through 6 = Saturday. */
  readonly days: readonly number[];
  /** Every N hours on the hour, 1-12. */
  readonly everyHours: number;
  /** Monthly day, 1-28, so every month has it. */
  readonly dayOfMonth: number;
  /** The cron Custom edits. */
  readonly cron: string;
}

export const DEFAULT_SCHEDULE_PRESET: SchedulePreset = {
  kind: "weekdays",
  hour: 9,
  minute: 0,
  days: [1],
  everyHours: 2,
  dayOfMonth: 1,
  cron: "0 9 * * 1-5",
};

const WEEKDAY_VALUES = [1, 2, 3, 4, 5];

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));
}

function sortedUnique(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function sameValues(actual: readonly number[], expected: readonly number[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

/** The five-field cron a preset stands for. */
export function presetToCron(preset: SchedulePreset): string {
  const minute = clampInt(preset.minute, 0, 59);
  const hour = clampInt(preset.hour, 0, 23);
  switch (preset.kind) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly": {
      const days = sortedUnique(preset.days.map((day) => clampInt(day, 0, 6)));
      return `${minute} ${hour} * * ${days.length > 0 ? days.join(",") : "*"}`;
    }
    case "hourly": {
      const every = clampInt(preset.everyHours, 1, 12);
      return every === 1 ? "0 * * * *" : `0 */${every} * * *`;
    }
    case "monthly":
      return `${minute} ${hour} ${clampInt(preset.dayOfMonth, 1, 28)} * *`;
    case "custom":
      return preset.cron.trim();
  }
}

/** Sorted values of a cron field; a field listing every value reads as unrestricted (empty). */
function fieldValues(field: ReadonlySet<number>, size: number): number[] {
  return field.size === size ? [] : Array.from(field).sort((a, b) => a - b);
}

/** `n` when `hours` is 0, n, 2n, ... through the day; otherwise null. */
function uniformHourStep(hours: readonly number[]): number | null {
  if (hours.length < 2 || hours[0] !== 0) return null;
  const step = hours[1]!;
  const expected = Array.from({ length: Math.ceil(24 / step) }, (_, index) => index * step);
  return sameValues(hours, expected) ? step : null;
}

/**
 * The preset a stored cron reads as, so the editor opens on it. Anything the
 * presets cannot express opens as Custom with the cron unchanged.
 */
export function cronToPreset(cron: string): SchedulePreset {
  const trimmed = cron.trim();
  const custom: SchedulePreset = { ...DEFAULT_SCHEDULE_PRESET, kind: "custom", cron: trimmed };
  if (trimmed.split(/\s+/).length !== 5) return custom;
  const parsed = Cron.parse(trimmed);
  if (Result.isFailure(parsed)) return custom;
  const minutes = fieldValues(parsed.success.minutes, 60);
  const hours = fieldValues(parsed.success.hours, 24);
  const days = fieldValues(parsed.success.days, 31);
  const months = fieldValues(parsed.success.months, 12);
  const weekdays = fieldValues(parsed.success.weekdays, 7);
  if (months.length > 0) return custom;
  if (minutes.length === 1 && hours.length === 1) {
    const time = { hour: hours[0]!, minute: minutes[0]! };
    if (days.length === 0) {
      if (weekdays.length === 0) return { ...custom, ...time, kind: "daily" };
      if (sameValues(weekdays, WEEKDAY_VALUES)) return { ...custom, ...time, kind: "weekdays" };
      return { ...custom, ...time, kind: "weekly", days: weekdays };
    }
    if (days.length === 1 && weekdays.length === 0 && days[0]! <= 28) {
      return { ...custom, ...time, kind: "monthly", dayOfMonth: days[0]! };
    }
    return custom;
  }
  if (sameValues(minutes, [0]) && days.length === 0 && weekdays.length === 0) {
    const step = hours.length === 0 ? 1 : uniformHourStep(hours);
    if (step !== null && step <= 12) return { ...custom, kind: "hourly", everyHours: step };
  }
  return custom;
}

/** Why the preset cannot be saved, or null. */
export function schedulePresetError(preset: SchedulePreset): string | null {
  if (preset.kind === "weekly" && preset.days.length === 0) return "Pick at least one day.";
  if (preset.kind === "custom" && preset.cron.trim().length === 0) {
    return "Enter a cron expression.";
  }
  return validateScheduleCron(presetToCron(preset));
}

/** The cadence picker's choices, in order, with their labels. */
export const SCHEDULE_PRESET_LABELS: Readonly<Record<SchedulePresetKind, string>> = {
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Weekly on",
  hourly: "Every N hours",
  monthly: "Monthly",
  custom: "Custom",
};

export const SCHEDULE_PRESET_KINDS: readonly SchedulePresetKind[] = [
  "daily",
  "weekdays",
  "weekly",
  "hourly",
  "monthly",
  "custom",
];

/** Weekly day chips, Monday first the way people read a week. Values are cron weekdays (Sunday = 0). */
export const SCHEDULE_WEEK_DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;

/** The preset switched to `kind`. Custom starts from the cadence on screen, not a stale cron. */
export function switchSchedulePreset(
  preset: SchedulePreset,
  kind: SchedulePresetKind,
  cronOnScreen: string,
): SchedulePreset {
  return kind === "custom" && preset.kind !== "custom"
    ? { ...preset, kind, cron: cronOnScreen }
    : { ...preset, kind };
}

/** A weekly day chip tapped: on becomes off and off becomes on. */
export function toggleScheduleDay(days: readonly number[], day: number): number[] {
  return days.includes(day) ? days.filter((value) => value !== day) : sortedUnique([...days, day]);
}

// ── Time in the host's zone ──────────────────────────────────────────

interface ZonedParts {
  readonly dayKey: string;
  readonly monthDay: string;
  readonly hour: number;
  readonly minute: number;
}

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Undefined reads in the device's zone. */
function zonedParts(date: Date, timeZone: string | undefined): ZonedParts {
  const at = date.getTime();
  // An unknown zone reads in the device's zone rather than failing the row.
  const clock = wallClockAt(at, timeZone) ?? wallClockAt(at);
  const monthDay = `${MONTH_ABBREVIATIONS[clock.month - 1] ?? ""} ${clock.day}`;
  return {
    dayKey: `${clock.year} ${monthDay}`,
    monthDay,
    hour: clock.hour,
    minute: clock.minute,
  };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** "7:00" and whether that is today in `timeZone`, or its "Sep 25". */
function zonedTime(
  iso: string,
  now: Date,
  timeZone: string | undefined,
): { readonly time: string; readonly monthDay: string | null } {
  // Intl formats plain dates; the caller owns the clock through `now`.
  // @effect-diagnostics-next-line globalDate:off
  const parts = zonedParts(new Date(iso), timeZone);
  const time = `${parts.hour}:${pad(parts.minute)}`;
  const today = parts.dayKey === zonedParts(now, timeZone).dayKey;
  return { time, monthDay: today ? null : parts.monthDay };
}

/** "at 7:00" today in the host's zone, else "on Sep 25 at 7:00". */
function atTime(iso: string, now: Date, timeZone: string): string {
  const { time, monthDay } = zonedTime(iso, now, timeZone);
  return monthDay === null ? `at ${time}` : `on ${monthDay} at ${time}`;
}

/**
 * When a scheduled prompt arrived, for its timeline label: "7:00" today,
 * else "Sep 25 at 7:00". Reads in `timeZone`, the device's when omitted.
 */
export function formatScheduledMessageTime(iso: string, now: Date, timeZone?: string): string {
  if (Number.isNaN(Date.parse(iso))) return "";
  const { time, monthDay } = zonedTime(iso, now, timeZone);
  return monthDay === null ? time : `${monthDay} at ${time}`;
}

const nextRunFormats = new Map<string, Intl.DateTimeFormat>();

/** An upcoming run as the editor lists it: "Tue, Sep 29, 7:00 AM". */
export function formatScheduleRunTime(date: Date, timeZone: string): string {
  let format = nextRunFormats.get(timeZone);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    };
    try {
      format = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat("en-US", options);
    }
    nextRunFormats.set(timeZone, format);
  }
  return format.format(date);
}

/** "in 5m", "in 14h", "in 3d". */
export function formatTimeUntil(next: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

// ── Row state ────────────────────────────────────────────────────────

/** A run sent this long after its slot waited for something. */
const LATE_RUN_MS = 5 * 60 * 1000;

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Own keys only: a schedule id such as "constructor" must not read Object.prototype. */
function entryOf<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * A missed or failed run that still asks for attention: the schedule is on and
 * the run came after its last edit, pause or resume.
 */
export function isScheduleRunAttention(
  schedule: Pick<ProjectSchedule, "enabled" | "updatedAt">,
  run: ProjectScheduleRun | undefined,
): boolean {
  return (
    schedule.enabled &&
    run !== undefined &&
    run.outcome !== "sent" &&
    toMs(run.at) >= toMs(schedule.updatedAt)
  );
}

export type ScheduleRowKind =
  | "not-run"
  | "held"
  | "running"
  | "sent"
  | "missed"
  | "failed"
  | "pick-target";

export interface ScheduleRowState {
  readonly kind: ScheduleRowKind;
  readonly text: string;
  /** Red: a missed or failed run of an enabled schedule. */
  readonly attention: boolean;
  /** The thread the result links to. */
  readonly linkThreadId: ThreadId | null;
  /** The host was closed: the host line's Open at login is the fix. */
  readonly suggestOpenAtLogin: boolean;
}

export interface ScheduleRowTargetThread {
  readonly session: { readonly status: string } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestUserMessageAt: string | null;
}

/**
 * The "last result" of a schedule row. `targetTitle` names the target in
 * sentences ("Queued until Sales is idle"); `targetThread` is its live shell.
 */
export function resolveScheduleRowState(input: {
  readonly schedule: Pick<ProjectSchedule, "enabled" | "updatedAt">;
  readonly run: ProjectScheduleRun | undefined;
  readonly held: { readonly since: string } | undefined;
  readonly targetTitle: string;
  readonly targetThread: ScheduleRowTargetThread | null;
  readonly now: Date;
  readonly timeZone: string;
}): ScheduleRowState {
  const { schedule, run, targetTitle } = input;
  const row = (
    kind: ScheduleRowKind,
    text: string,
    extra: Partial<Omit<ScheduleRowState, "kind" | "text">> = {},
  ): ScheduleRowState => ({
    kind,
    text,
    attention: false,
    linkThreadId: null,
    suggestOpenAtLogin: false,
    ...extra,
  });
  // A run recorded since the hold began settled it; status catches up on its next read.
  if (input.held !== undefined && (run === undefined || toMs(run.at) < toMs(input.held.since))) {
    return row("held", `Queued until ${targetTitle} is idle`);
  }
  if (run === undefined) return row("not-run", "Not run yet");
  const at = (iso: string) => atTime(iso, input.now, input.timeZone);
  const link = run.threadId ?? null;

  if (run.outcome === "sent") {
    const thread = input.targetThread;
    if (thread !== null && isRunningAgent(thread) && thread.latestUserMessageAt === run.at) {
      return row("running", "Running now", { linkThreadId: link });
    }
    const late = toMs(run.at) - toMs(run.slot) > LATE_RUN_MS;
    const text = !late
      ? `Ran ${at(run.at)}`
      : run.reason === "busy"
        ? `Ran ${at(run.at)} after ${targetTitle} was busy`
        : `Ran ${at(run.at)} after sleep`;
    return row("sent", text, { linkThreadId: link });
  }

  // An edit, pause or resume re-arms the schedule, so an older miss stops counting.
  if (toMs(run.at) < toMs(schedule.updatedAt)) return row("not-run", "Not run yet");
  const attention = schedule.enabled;
  if (run.outcome === "failed") {
    return row("failed", "Failed · run errored", { attention, linkThreadId: link });
  }
  switch (run.reason) {
    case "late":
    case "no-fire":
      return row("missed", `Missed · host was off ${at(run.slot)}`, { attention });
    case "not-running":
      return row("missed", `Missed · Control Plane was closed ${at(run.slot)}`, {
        attention,
        suggestOpenAtLogin: true,
      });
    case "busy":
      return row("missed", `Missed · ${targetTitle} was busy`, { attention });
    case "rejected":
      return row("missed", "Missed · could not start", { attention, linkThreadId: link });
    case "target-missing":
      return row("pick-target", "Pick target", { attention });
    case undefined:
      return row("missed", `Missed ${at(run.slot)}`, { attention });
  }
}

/** A Project thread as the Schedules list reads it. */
export interface ScheduleListThread extends ScheduleRowTargetThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly archivedAt: string | null;
}

export interface ScheduleRowView {
  readonly schedule: ProjectSchedule;
  /** How sentences name the target: "Queued until Sales is idle". */
  readonly targetTitle: string;
  /** "Weekdays at 7:00 · Coordinator · in 14h", or "… · Paused". */
  readonly detail: string;
  readonly state: ScheduleRowState;
  /** "Created by Personal" while an agent made the last change. */
  readonly author: string | null;
}

const nextRuns = new Map<string, Date | null>();

/**
 * A row's next run, remembered per minute tick: the list re-renders on every
 * thread change in its Project, and cron math is slow without a JIT (Hermes).
 */
function nextRunAfter(cron: string, timeZone: string, now: Date): Date | null {
  const key = `${now.getTime()} ${timeZone} ${cron}`;
  const cached = nextRuns.get(key);
  if (cached !== undefined) return cached;
  if (nextRuns.size >= 200) nextRuns.clear();
  const next = nextScheduleRuns(cron, timeZone, now, 1)[0] ?? null;
  nextRuns.set(key, next);
  return next;
}

/**
 * The Schedules list of one Project, in stored order. `threads` are the
 * Project's thread shells; `held` comes from `schedules.status`.
 */
export function buildScheduleRows(input: {
  readonly assistant: Pick<ProjectAssistant, "coordinatorThreadId" | "schedules" | "scheduleRuns">;
  readonly projectTitle: string;
  readonly threads: readonly ScheduleListThread[];
  readonly held: Readonly<Record<string, { readonly since: string }>> | undefined;
  readonly now: Date;
  readonly timeZone: string;
}): ScheduleRowView[] {
  const { assistant, threads, now, timeZone } = input;
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const coordinator = threadById.get(assistant.coordinatorThreadId) ?? null;
  const titleOf = (threadId: ThreadId) => threadById.get(threadId)?.title ?? null;
  return (assistant.schedules ?? []).map((schedule) => {
    const toCoordinator = schedule.target === "coordinator";
    const targetThread = toCoordinator
      ? coordinator
      : (threads.find((thread) => thread.id === schedule.target && thread.archivedAt === null) ??
        null);
    const targetTitle = toCoordinator
      ? (coordinator?.title ?? input.projectTitle)
      : (targetThread?.title ?? "its agent");
    const targetLabel = toCoordinator ? "Coordinator" : (targetThread?.title ?? "Missing agent");
    const nextRun = schedule.enabled ? nextRunAfter(schedule.cron, timeZone, now) : null;
    const when = schedule.enabled ? (nextRun ? formatTimeUntil(nextRun, now) : null) : "Paused";
    return {
      schedule,
      targetTitle,
      detail: [describeCadence(schedule.cron), targetLabel, when]
        .filter((part): part is string => part !== null)
        .join(" · "),
      state: resolveScheduleRowState({
        schedule,
        run: entryOf(assistant.scheduleRuns, schedule.id),
        held: entryOf(input.held, schedule.id),
        targetTitle,
        targetThread,
        now,
        timeZone,
      }),
      author: scheduleAuthorLabel(schedule, titleOf),
    };
  });
}

// ── Project-level helpers ────────────────────────────────────────────

/** Any enabled schedule whose last run missed or failed since its last edit, in an unarchived Project. */
export function hasScheduleAttention(assistant: ProjectAssistant | null | undefined): boolean {
  if (assistant == null || assistant.archivedAt != null || assistant.scheduleRuns === undefined) {
    return false;
  }
  return (assistant.schedules ?? []).some((schedule) =>
    isScheduleRunAttention(schedule, entryOf(assistant.scheduleRuns, schedule.id)),
  );
}

/** "3 schedules · 1 paused", "1 schedule" or "No schedules". */
export function summarizeSchedules(assistant: ProjectAssistant | null | undefined): string {
  const schedules = assistant?.schedules ?? [];
  if (schedules.length === 0) return "No schedules";
  const paused = schedules.filter((schedule) => !schedule.enabled).length;
  const count = `${schedules.length} ${schedules.length === 1 ? "schedule" : "schedules"}`;
  return paused > 0 ? `${count} · ${paused} paused` : count;
}

/** "Created by Personal" or "Edited by Sales" while an agent made the last change. */
export function scheduleAuthorLabel(
  schedule: Pick<ProjectSchedule, "createdBy" | "updatedBy">,
  titleOf: (threadId: ThreadId) => string | null,
): string | null {
  if (schedule.updatedBy === "user") return null;
  const name = titleOf(schedule.updatedBy) ?? "an agent";
  return schedule.createdBy === schedule.updatedBy ? `Created by ${name}` : `Edited by ${name}`;
}

/** A schedule as the editor saves it. */
export interface ScheduleDraft {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly target: ProjectScheduleTarget;
  readonly enabled: boolean;
  /** Omit to keep the stored prompt. Required for a new schedule. */
  readonly prompt?: string | undefined;
  /**
   * The `updatedAt` the editor opened with; absent for a new schedule. The
   * save echoes it, so a change made meanwhile (an agent's edit, another
   * client's pause, a delete) refuses the save instead of being overwritten.
   */
  readonly updatedAt?: string | undefined;
}

export type ScheduleListChange =
  | { readonly kind: "save"; readonly schedule: ScheduleDraft }
  | { readonly kind: "delete"; readonly id: string }
  | {
      readonly kind: "set-enabled";
      readonly ids: readonly string[];
      readonly enabled: boolean;
    };

function draftInput(draft: ScheduleDraft): ProjectScheduleInput {
  return {
    id: draft.id,
    name: draft.name,
    cron: draft.cron,
    target: draft.target,
    enabled: draft.enabled,
    ...(draft.prompt === undefined ? {} : { prompt: draft.prompt }),
    ...(draft.updatedAt === undefined ? {} : { updatedAt: draft.updatedAt }),
  };
}

/**
 * The whole list a user write sends, with one change applied. Existing
 * entries echo the `updatedAt` they were read at, so the server refuses a
 * write built from a stale list; a saved entry echoes its draft's instead.
 * Only a saved entry carries its prompt.
 */
export function buildScheduleInputs(
  schedules: readonly ProjectSchedule[],
  change: ScheduleListChange,
): ProjectScheduleInput[] {
  const inputs: ProjectScheduleInput[] = [];
  let saved = false;
  for (const schedule of schedules) {
    if (change.kind === "delete" && change.id === schedule.id) continue;
    if (change.kind === "save" && change.schedule.id === schedule.id) {
      saved = true;
      inputs.push(draftInput(change.schedule));
      continue;
    }
    const enabled =
      change.kind === "set-enabled" && change.ids.includes(schedule.id)
        ? change.enabled
        : schedule.enabled;
    inputs.push({
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      target: schedule.target,
      enabled,
      updatedAt: schedule.updatedAt,
    });
  }
  // A draft of a schedule deleted meanwhile still echoes, so the server refuses it.
  if (change.kind === "save" && !saved) inputs.push(draftInput(change.schedule));
  return inputs;
}

export interface ScheduleAlertProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly assistant?: ProjectAssistant | null | undefined;
}

export interface ScheduleRunAlert {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly run: ProjectScheduleRun;
}

/** The last run seen per `<projectId>:<scheduleId>`. */
export type ScheduleRunsSeen = ReadonlyMap<string, string>;

/**
 * Newly recorded missed runs of enabled schedules in unarchived Projects.
 * With no `previous` (the first live snapshot), it only records what it saw.
 * Failed runs are left to the thread's own failure alert.
 */
export function diffScheduleRunAlerts(
  previous: ScheduleRunsSeen | null,
  projects: readonly ScheduleAlertProject[],
): { readonly seen: ScheduleRunsSeen; readonly alerts: readonly ScheduleRunAlert[] } {
  const seen = new Map<string, string>();
  const alerts: ScheduleRunAlert[] = [];
  for (const project of projects) {
    const assistant = project.assistant;
    if (assistant == null || assistant.scheduleRuns === undefined) continue;
    for (const schedule of assistant.schedules ?? []) {
      const run = entryOf(assistant.scheduleRuns, schedule.id);
      if (run === undefined) continue;
      const key = `${project.id}:${schedule.id}`;
      const signature = `${run.slot}|${run.at}|${run.outcome}|${run.reason ?? ""}`;
      seen.set(key, signature);
      if (
        previous === null ||
        previous.get(key) === signature ||
        run.outcome !== "missed" ||
        assistant.archivedAt != null ||
        !isScheduleRunAttention(schedule, run)
      ) {
        continue;
      }
      alerts.push({
        projectId: project.id,
        projectTitle: project.title,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        run,
      });
    }
  }
  return { seen, alerts };
}

export interface ScheduleTargetOption {
  readonly value: ProjectScheduleTarget;
  readonly label: string;
}

/**
 * "Runs in" choices: the coordinator, then standing agents in pin order. A
 * current target that is no longer pinned stays listed, last, while it is live.
 */
export function scheduleTargetOptions(input: {
  readonly coordinatorThreadId: ThreadId;
  readonly threads: readonly {
    readonly id: ThreadId;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly pinnedAt?: string | null | undefined;
    readonly pinOrderKey?: string | null | undefined;
  }[];
  readonly current: ProjectScheduleTarget | null;
}): ScheduleTargetOption[] {
  const live = input.threads.filter(
    (thread) => thread.archivedAt === null && thread.id !== input.coordinatorThreadId,
  );
  const standing = live
    .filter((thread) => thread.pinnedAt != null || thread.id === input.current)
    .sort((left, right) => {
      const pinned = Number(right.pinnedAt != null) - Number(left.pinnedAt != null);
      if (pinned !== 0) return pinned;
      const leftKey = left.pinOrderKey ?? "";
      const rightKey = right.pinOrderKey ?? "";
      return leftKey < rightKey
        ? -1
        : leftKey > rightKey
          ? 1
          : left.title.localeCompare(right.title);
    });
  return [
    { value: "coordinator", label: "Coordinator" },
    ...standing.map((thread) => ({ value: thread.id, label: thread.title })),
  ];
}

/**
 * Every enabled schedule in `projects`, grouped per Project with the list
 * that pauses them: "Remove from this host".
 */
export function planPauseAllSchedules(
  projects: readonly {
    readonly id: ProjectId;
    readonly assistant?: ProjectAssistant | null | undefined;
  }[],
): {
  readonly scheduleCount: number;
  readonly writes: readonly {
    readonly projectId: ProjectId;
    readonly schedules: ProjectScheduleInput[];
  }[];
} {
  let scheduleCount = 0;
  const writes: { projectId: ProjectId; schedules: ProjectScheduleInput[] }[] = [];
  for (const project of projects) {
    const schedules = project.assistant?.schedules ?? [];
    const ids = schedules.filter((schedule) => schedule.enabled).map((schedule) => schedule.id);
    if (ids.length === 0) continue;
    scheduleCount += ids.length;
    writes.push({
      projectId: project.id,
      schedules: buildScheduleInputs(schedules, { kind: "set-enabled", ids, enabled: false }),
    });
  }
  return { scheduleCount, writes };
}

// ── Editor ───────────────────────────────────────────────────────────

/** How the stored schedule moved on since the editor opened it; the server refuses to overwrite either. */
export type ScheduleEditorChange = "edited" | "deleted" | null;

export function scheduleEditorChange(
  opened: Pick<ProjectSchedule, "id" | "updatedAt"> | null,
  schedules: readonly Pick<ProjectSchedule, "id" | "updatedAt">[],
): ScheduleEditorChange {
  if (opened === null) return null;
  const stored = schedules.find((schedule) => schedule.id === opened.id);
  if (stored === undefined) return "deleted";
  return stored.updatedAt === opened.updatedAt ? null : "edited";
}

/** The editor's notice while `scheduleEditorChange` is set. */
export function scheduleEditorChangeText(change: Exclude<ScheduleEditorChange, null>): string {
  return change === "deleted"
    ? "This schedule was deleted since you opened it."
    : "This schedule changed since you opened it. Close and reopen it to edit the latest version.";
}

/** What the user has entered. `typedPrompt` stays null until they type, so the stored prompt is kept. */
export interface ScheduleEditorForm {
  readonly name: string;
  readonly target: ProjectScheduleTarget;
  readonly typedPrompt: string | null;
  readonly preset: SchedulePreset;
  /** An untouched cadence saves the stored cron as it is. */
  readonly cadenceTouched: boolean;
}

/** A schedule's stored prompt from `schedules.status`, undefined until status loads. */
export function storedSchedulePrompt(
  prompts: Readonly<Record<string, string>> | undefined,
  scheduleId: string,
): string | undefined {
  return entryOf(prompts, scheduleId);
}

export function initialScheduleEditorForm(schedule: ProjectSchedule | null): ScheduleEditorForm {
  return {
    name: schedule?.name ?? "",
    target: schedule?.target ?? "coordinator",
    typedPrompt: null,
    preset: schedule ? cronToPreset(schedule.cron) : DEFAULT_SCHEDULE_PRESET,
    cadenceTouched: schedule === null,
  };
}

export interface ScheduleEditorView {
  /** The prompt field's value. */
  readonly prompt: string;
  /** Editing, with the stored prompt not loaded and nothing typed. */
  readonly promptUnknown: boolean;
  /** Save sends the prompt: a new schedule, or one whose prompt was typed. */
  readonly promptRequired: boolean;
  readonly cron: string;
  readonly cadenceError: string | null;
  /** The next three runs, empty while the cadence is invalid. */
  readonly nextRuns: readonly Date[];
  /** The chosen "Runs in" is still offered. */
  readonly targetKnown: boolean;
  /** Hidden while saving, since the save itself moves the stored schedule on. */
  readonly changed: ScheduleEditorChange;
  readonly canSave: boolean;
  /** Save would change something, so leaving asks first. */
  readonly dirty: boolean;
}

/**
 * The editor as it stands. `opened` is the schedule the editor opened with
 * (null for a new one); `storedPrompt` comes from `schedules.status`.
 */
export function resolveScheduleEditor(input: {
  readonly opened: ProjectSchedule | null;
  readonly form: ScheduleEditorForm;
  readonly storedPrompt: string | undefined;
  readonly targetOptions: readonly ScheduleTargetOption[];
  readonly changed: ScheduleEditorChange;
  readonly saving: boolean;
  readonly now: Date;
  readonly timeZone: string;
}): ScheduleEditorView {
  const { opened, form, saving } = input;
  const prompt = form.typedPrompt ?? input.storedPrompt ?? "";
  const presetCadence = form.cadenceTouched || opened === null;
  const cron = presetCadence ? presetToCron(form.preset) : opened.cron;
  const cadenceError = presetCadence
    ? schedulePresetError(form.preset)
    : validateScheduleCron(cron);
  const changed = saving ? null : input.changed;
  const targetKnown = input.targetOptions.some((option) => option.value === form.target);
  const promptRequired = opened === null || form.typedPrompt !== null;
  const name = form.name.trim();
  return {
    prompt,
    promptUnknown: opened !== null && form.typedPrompt === null && input.storedPrompt === undefined,
    promptRequired,
    cron,
    cadenceError,
    nextRuns: cadenceError === null ? nextScheduleRuns(cron, input.timeZone, input.now, 3) : [],
    targetKnown,
    changed,
    canSave:
      !saving &&
      changed === null &&
      name.length > 0 &&
      cadenceError === null &&
      targetKnown &&
      (!promptRequired || prompt.trim().length > 0),
    dirty:
      form.name !== (opened?.name ?? "") ||
      form.target !== (opened?.target ?? "coordinator") ||
      (form.typedPrompt !== null && form.typedPrompt !== (input.storedPrompt ?? "")) ||
      cron !== (opened?.cron ?? presetToCron(DEFAULT_SCHEDULE_PRESET)),
  };
}

/**
 * What Save sends: the opened schedule's id, switch and `updatedAt` echo, or
 * a new id switched on. Only a new or typed prompt travels.
 */
export function buildScheduleEditorDraft(input: {
  readonly opened: ProjectSchedule | null;
  readonly form: ScheduleEditorForm;
  readonly view: ScheduleEditorView;
}): ScheduleDraft {
  const { opened, form, view } = input;
  const name = form.name.trim();
  return {
    id: opened?.id ?? newScheduleId(name),
    name,
    cron: view.cron,
    target: form.target,
    enabled: opened?.enabled ?? true,
    ...(view.promptRequired ? { prompt: view.prompt } : {}),
    updatedAt: opened?.updatedAt,
  };
}

// ── Host and results ─────────────────────────────────────────────────

/** What a host problem means for the user, in one line. */
export function scheduleHostProblemText(
  problem: ScheduleHostProblem,
  host: Pick<ScheduleHostStatus, "timeZone" | "hostZone" | "entry">,
): string {
  switch (problem) {
    case "no-gui-session":
      return "Nobody is logged in to this Mac's desktop, so macOS won't run schedules until someone is.";
    case "no-user-manager":
      return "Schedules need systemd user services on this Linux host.";
    case "no-linger":
      return "Schedules run only while you are logged in to this host. Enable lingering to run them after you log out.";
    case "entry-disabled":
      return "The host's schedule entry is turned off (Login Items on macOS). Schedules won't run until it's back on.";
    case "zone-mismatch":
      return host.hostZone
        ? `The host's time zone is ${host.hostZone}, but Control Plane is using ${host.timeZone}. Restart Control Plane to switch.`
        : "The host's time zone changed. Restart Control Plane to switch.";
    case "ephemeral-path":
      return "Control Plane is running from a disk image or temporary folder. Move it to Applications so schedules can find it.";
    case "install-failed":
      return host.entry.detail
        ? `Couldn't install the schedule entry: ${host.entry.detail}`
        : "Couldn't install the schedule entry.";
    case "unsupported-platform":
      return "Schedules aren't available on Windows yet.";
    case "backend-off":
      return "Schedules are off on this host.";
  }
}

/** The host problems worth a line under the list. A host with its backend off shows the unsupported line instead. */
export function scheduleHostProblems(host: ScheduleHostStatus | null): ScheduleHostProblem[] {
  return host?.problems.filter((problem) => problem !== "backend-off") ?? [];
}

/** The one line a host that runs no schedules shows instead of the list. */
export function scheduleUnsupportedText(problems: readonly ScheduleHostProblem[]): string {
  return problems.includes("unsupported-platform")
    ? "Schedules aren't available on Windows yet."
    : "This host doesn't run schedules. They run from the Control Plane desktop app.";
}

/** "How to fix" for a host that runs no schedules: the user guide's Schedules section. */
export const SCHEDULES_HELP_URL =
  "https://github.com/lucive-apps/control-plane/blob/main/docs/user/projects.md#schedules";

export interface ScheduleHostView {
  /** Times read in the live host zone once status loads, else the zone at startup. */
  readonly timeZone: string;
  readonly scheduler: ProjectScheduler;
  /** The one line that replaces the list on a host that runs no schedules; null otherwise. */
  readonly unsupportedText: string | null;
  /** One line per host problem, shown under the list. */
  readonly problems: readonly string[];
}

/**
 * The host a Schedules list reads: `capability` is the server config's
 * `projectSchedules`, `host` the `schedules.status` host once loaded.
 */
export function resolveScheduleHost(input: {
  readonly capability: { readonly scheduler: ProjectScheduler; readonly timeZone: string };
  readonly host: ScheduleHostStatus | null;
}): ScheduleHostView {
  const { host } = input;
  const scheduler = host?.scheduler ?? input.capability.scheduler;
  return {
    timeZone: host?.timeZone ?? input.capability.timeZone,
    scheduler,
    unsupportedText: scheduler === "none" ? scheduleUnsupportedText(host?.problems ?? []) : null,
    problems:
      host === null
        ? []
        : scheduleHostProblems(host).map((problem) => scheduleHostProblemText(problem, host)),
  };
}

/** A preset's time as the editor shows it: "7:00", "16:30". */
export function formatScheduleClock(hour: number, minute: number): string {
  return `${clampInt(hour, 0, 23)}:${pad(clampInt(minute, 0, 59))}`;
}

const SCHEDULER_NAMES: Readonly<Record<Exclude<ProjectScheduler, "none">, string>> = {
  launchd: "launchd",
  systemd: "systemd",
  "task-scheduler": "Task Scheduler",
};

/**
 * A remote client's read-only host line: which host runs the schedules and
 * with what. Null when the host runs none (the unsupported line says so).
 */
export function scheduleHostSummary(input: {
  readonly scheduler: ProjectScheduler;
  readonly backend: ScheduleHostStatus["backend"] | null;
  readonly hostLabel: string;
}): string | null {
  if (input.scheduler === "none") return null;
  const name = SCHEDULER_NAMES[input.scheduler];
  return input.backend === "dry-run"
    ? `Dry run on ${input.hostLabel}: its ${name} entry is written but never installed.`
    : `Runs on ${input.hostLabel} with ${name} while Control Plane is running there.`;
}

export interface ScheduleNotice {
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly description?: string;
}

/** What Run now tells the user beyond the row: null when the run was sent. */
export function scheduleRunNotice(
  result: Pick<SchedulesRunResult, "outcome" | "reason">,
  targetTitle: string,
): ScheduleNotice | null {
  switch (result.outcome) {
    case "sent":
      return null;
    case "held":
      return { tone: "info", title: `Queued until ${targetTitle} is idle` };
    case "missed":
      return {
        tone: "warning",
        title: "Schedule missed",
        description:
          result.reason === "target-missing"
            ? "The thread it runs in is gone. Edit the schedule to pick another."
            : "It could not start.",
      };
  }
}

/** Move to Tasks deletes a Project's schedules; its confirmation says how many. */
export function scheduleDeletionWarning(
  assistant: Pick<ProjectAssistant, "schedules"> | null | undefined,
): string | null {
  const count = assistant?.schedules?.length ?? 0;
  return count === 0 ? null : `${count} ${count === 1 ? "schedule" : "schedules"} will be deleted.`;
}
