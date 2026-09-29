/**
 * Schedule cadence math shared by the server, web and mobile: cron validation,
 * due slots, next runs and plain-words cadence text. Crons are five fields and
 * read in the host's IANA time zone.
 */
import { assistantSlug } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";

/** A fire over 2h after its slot records `missed: late` instead of running. */
export const LATE_LIMIT_MS = 2 * 60 * 60 * 1000;
/** How long a run waits for a busy target before `missed: busy`. */
export const BUSY_HOLD_MS = 15 * 60 * 1000;
/** How often held runs are re-tested while any exist. */
export const HOLD_RECHECK_MS = 30 * 1000;
/** A slot this old with no run, under an installed OS entry, records `missed: no-fire`. */
export const NO_FIRE_GRACE_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;
/** Schedules fire at most this often. */
export const MIN_INTERVAL_MS = 15 * 60 * 1000;

const MINUTES_PER_DAY = 24 * 60;
const HOUR_MS = 60 * 60 * 1000;
/** About 15 years: a February 29 schedule can wait 8 years between runs. */
const MAX_LOOKBACK_MS = 2 ** 17 * HOUR_MS;
const NEVER_RUNS_PROBE_FROM = Date.UTC(2000, 0, 1);

function parseFiveFields(cron: string, timeZone?: string): Cron.Cron | null {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  const parsed = Cron.parse(cron.trim(), timeZone);
  return Result.isSuccess(parsed) ? parsed.success : null;
}

/** Sorted values of a cron field. Empty means unrestricted. */
function values(field: ReadonlySet<number>): number[] {
  return Array.from(field).sort((a, b) => a - b);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * The shortest gap between two runs in minutes. Wrapping from the last time of
 * a day to the first time of the next counts even when the next day does not
 * match, so the bound never depends on the calendar.
 */
function shortestGapMinutes(cron: Cron.Cron): number {
  const minutes = cron.minutes.size === 0 ? range(0, 59) : values(cron.minutes);
  const hours = cron.hours.size === 0 ? range(0, 23) : values(cron.hours);
  const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
  let gap = MINUTES_PER_DAY - times[times.length - 1]! + times[0]!;
  for (let index = 1; index < times.length; index += 1) {
    gap = Math.min(gap, times[index]! - times[index - 1]!);
  }
  return gap;
}

/** Why `cron` cannot be a schedule's cadence, or null when it can. */
export function validateScheduleCron(cron: string): string | null {
  const trimmed = cron.trim();
  if (trimmed.split(/\s+/).length !== 5) {
    return "Use five fields: minute, hour, day of month, month and day of week.";
  }
  const parsed = Cron.parse(trimmed);
  if (Result.isFailure(parsed)) {
    return "That cron expression is not valid.";
  }
  if (parsed.success.days.size > 0 && parsed.success.weekdays.size > 0) {
    return "Pick days of the month or days of the week, not both.";
  }
  if (shortestGapMinutes(parsed.success) * 60 * 1000 < MIN_INTERVAL_MS) {
    return "Schedules run at most every 15 minutes.";
  }
  try {
    // A date that never exists, such as February 31, parses but has no run.
    Cron.next(parsed.success, NEVER_RUNS_PROBE_FROM);
  } catch {
    return "That schedule never runs.";
  }
  return null;
}

/**
 * The latest slot at or before `now`: the last run `nextScheduleRuns` would
 * have listed. Null when the cron or zone is invalid or the cron never runs.
 *
 * It walks forward with `Cron.next` from a lookback that doubles until it
 * holds a slot. `Cron.prev` cannot step back across a spring-forward gap
 * (it throws, or returns a slot after `now`), and walking forward also moves
 * a skipped 02:30 to 03:30 exactly as the listed runs do.
 */
export function scheduleSlotAt(cron: string, timeZone: string, now: Date): Date | null {
  const parsed = safeParse(cron, timeZone);
  if (parsed === null) return null;
  const at = now.getTime();
  try {
    for (let lookback = HOUR_MS; lookback <= MAX_LOOKBACK_MS; lookback *= 2) {
      let slot = Cron.next(parsed, at - lookback);
      if (slot.getTime() > at) continue;
      for (;;) {
        const following = Cron.next(parsed, slot);
        if (following.getTime() > at || following.getTime() <= slot.getTime()) return slot;
        slot = following;
      }
    }
  } catch {
    // `Cron` throws when no date matches.
  }
  return null;
}

/** The next `count` slots after `from`. Empty when the cron or zone is invalid or never runs. */
export function nextScheduleRuns(
  cron: string,
  timeZone: string,
  from: Date,
  count: number,
): Date[] {
  const parsed = safeParse(cron, timeZone);
  if (parsed === null) return [];
  try {
    const runs = Cron.sequence(parsed, from);
    return Array.from({ length: count }, () => runs.next().value);
  } catch {
    return [];
  }
}

function safeParse(cron: string, timeZone: string): Cron.Cron | null {
  try {
    return parseFiveFields(cron, timeZone);
  } catch {
    // An unknown zone throws rather than failing the parse.
    return null;
  }
}

/** A schedule id from its name: `<slug>-<6 random>`, or `s-<6 random>` without an ASCII slug. */
export function newScheduleId(name: string): string {
  const slug = assistantSlug(name).slice(0, 32).replace(/-+$/, "");
  // Plain callers on web and mobile have no Effect runtime; the suffix only avoids collisions.
  // @effect-diagnostics-next-line globalRandom:off
  const suffix = Array.from({ length: 6 }, () => Math.floor(Math.random() * 36).toString(36)).join(
    "",
  );
  return `${slug.length > 0 ? slug : "s"}-${suffix}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function joinWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function sameValues(actual: ReadonlyArray<number>, expected: ReadonlyArray<number>): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function isContiguous(sorted: ReadonlyArray<number>): boolean {
  return sorted.every((value, index) => index === 0 || value === sorted[index - 1]! + 1);
}

/** `n` when `sorted` is 0, n, 2n, ... up to `limit` exclusive; otherwise null. */
function uniformStep(sorted: ReadonlyArray<number>, limit: number): number | null {
  const step = sorted.length > 1 ? sorted[1]! : sorted.length === 1 ? limit : 0;
  if (sorted[0] !== 0 || step <= 0) return null;
  return sameValues(
    sorted,
    range(0, Math.ceil(limit / step) - 1).map((index) => index * step),
  )
    ? step
    : null;
}

/** Weekdays as Monday = 0 through Sunday = 6, the way people read a week. */
function mondayFirst(weekdays: ReadonlySet<number>): number[] {
  return Array.from(weekdays, (day) => (day + 6) % 7).sort((a, b) => a - b);
}

function weekdayName(mondayFirstDay: number): string {
  return WEEKDAYS[(mondayFirstDay + 1) % 7]!;
}

/** "Monday through Friday" for three or more in a row, otherwise a list. */
function isSpan(sorted: ReadonlyArray<number>): boolean {
  return sorted.length >= 3 && isContiguous(sorted);
}

function describeSpan(sorted: ReadonlyArray<number>, name: (value: number) => string): string {
  return isSpan(sorted)
    ? `${name(sorted[0]!)} through ${name(sorted[sorted.length - 1]!)}`
    : joinWords(sorted.map(name));
}

/** Sorted field values for reading aloud. A field listing every value reads as unrestricted. */
function readFields(parsed: Cron.Cron) {
  const read = (field: ReadonlySet<number>, size: number) =>
    field.size === size ? [] : values(field);
  return {
    minutes: read(parsed.minutes, 60),
    hours: read(parsed.hours, 24),
    days: read(parsed.days, 31),
    months: read(parsed.months, 12),
    weekdays: parsed.weekdays.size === 7 ? [] : mondayFirst(parsed.weekdays),
  };
}

function describeTimes(minutes: ReadonlyArray<number>, hours: ReadonlyArray<number>): string {
  const everyMinute = minutes.length === 0;
  const everyHour = hours.length === 0;
  if (!everyMinute && !everyHour && minutes.length * hours.length <= 4) {
    const times = hours.flatMap((hour) => minutes.map((minute) => `${pad(hour)}:${pad(minute)}`));
    return `At ${joinWords(times)}`;
  }
  const hourSpan = everyHour
    ? null
    : isContiguous(hours)
      ? `between ${pad(hours[0]!)}:00 and ${pad(hours[hours.length - 1]!)}:59`
      : `during hours ${joinWords(hours.map((hour) => pad(hour)))}`;
  const minuteStep = everyMinute ? 1 : uniformStep(minutes, 60);
  if (minuteStep !== null && minuteStep < 60) {
    const every = minuteStep === 1 ? "Every minute" : `Every ${minuteStep} minutes`;
    return hourSpan === null ? every : `${every}, ${hourSpan}`;
  }
  const minuteText =
    minutes.length === 1
      ? `At minute ${minutes[0]}`
      : `At minutes ${joinWords(minutes.map((minute) => `${minute}`))}`;
  if (everyHour) return `${minuteText} past every hour`;
  const hourStep = uniformStep(hours, 24);
  if (hourStep !== null && hourStep > 1) return `${minuteText} past every ${hourStep} hours`;
  return `${minuteText} past the hour, ${hourSpan}`;
}

/**
 * A plain-words reading of any valid five-field cron, such as
 * "At 07:00, Monday through Friday". Returns the cron itself when it does not parse.
 */
export function describeCron(cron: string): string {
  const parsed = parseFiveFields(cron);
  if (parsed === null) return cron.trim();
  const { minutes, hours, days, months, weekdays } = readFields(parsed);
  const parts = [describeTimes(minutes, hours)];
  if (weekdays.length > 0) {
    const span = describeSpan(weekdays, weekdayName);
    parts.push(isSpan(weekdays) ? span : `on ${span}`);
  }
  if (days.length > 0) {
    parts.push(
      days.length === 1
        ? `on day ${days[0]} of the month`
        : `on days ${describeSpan(days, (day) => `${day}`)} of the month`,
    );
  }
  if (months.length > 0) {
    parts.push(`in ${describeSpan(months, (month) => MONTHS[month - 1]!)}`);
  }
  return parts.join(", ");
}

/**
 * The cadence as a schedule row reads it: preset wording such as
 * "Weekdays at 7:00", "Fridays at 16:00", "Every 2 hours" or
 * "Monthly on the 1st at 9:00", falling back to `describeCron`.
 */
export function describeCadence(cron: string): string {
  const parsed = parseFiveFields(cron);
  if (parsed === null) return cron.trim();
  const { minutes, hours, days, months, weekdays } = readFields(parsed);
  if (months.length === 0) {
    if (minutes.length === 1 && hours.length === 1) {
      const time = `${hours[0]}:${pad(minutes[0]!)}`;
      if (days.length === 0) {
        if (weekdays.length === 0) return `Every day at ${time}`;
        if (sameValues(weekdays, [0, 1, 2, 3, 4])) return `Weekdays at ${time}`;
        if (sameValues(weekdays, [5, 6])) return `Weekends at ${time}`;
        return `${joinWords(weekdays.map((day) => `${weekdayName(day)}s`))} at ${time}`;
      }
      if (days.length === 1 && weekdays.length === 0) {
        return `Monthly on the ${ordinal(days[0]!)} at ${time}`;
      }
    }
    if (sameValues(minutes, [0]) && days.length === 0 && weekdays.length === 0) {
      const step = hours.length === 0 ? 1 : uniformStep(hours, 24);
      if (step === 1) return "Every hour";
      if (step !== null && step <= 12) return `Every ${step} hours`;
    }
  }
  return describeCron(cron);
}
