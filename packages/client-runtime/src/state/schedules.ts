import {
  isRunningAgent,
  type ProjectAssistant,
  type ProjectId,
  type ProjectSchedule,
  type ProjectScheduleInput,
  type ProjectScheduleRun,
  type ProjectScheduleTarget,
  type ThreadId,
} from "@t3tools/contracts";
import { validateScheduleCron } from "@t3tools/shared/schedules";
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

// ── Time in the host's zone ──────────────────────────────────────────

interface ZonedParts {
  readonly dayKey: string;
  readonly monthDay: string;
  readonly hour: number;
  readonly minute: number;
}

const zonedFormats = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormats.get(timeZone);
  if (cached) return cached;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    // An unknown zone reads in the device's zone rather than failing the row.
    format = new Intl.DateTimeFormat("en-US", options);
  }
  zonedFormats.set(timeZone, format);
  return format;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = zonedFormat(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const monthDay = `${part("month")} ${part("day")}`;
  return {
    dayKey: `${part("year")} ${monthDay}`,
    monthDay,
    // Some engines write midnight as 24.
    hour: Number(part("hour")) % 24,
    minute: Number(part("minute")),
  };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** "at 7:00" today in the host's zone, else "on Sep 25 at 7:00". */
function atTime(iso: string, now: Date, timeZone: string): string {
  // Intl formats plain dates; the caller owns the clock through `now`.
  // @effect-diagnostics-next-line globalDate:off
  const parts = zonedParts(new Date(iso), timeZone);
  const time = `${parts.hour}:${pad(parts.minute)}`;
  return parts.dayKey === zonedParts(now, timeZone).dayKey
    ? `at ${time}`
    : `on ${parts.monthDay} at ${time}`;
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
