/**
 * Schedule crons as OS calendars. Pure. Fork-owned.
 *
 * launchd takes an array of `StartCalendarInterval` dicts (an omitted key is a
 * wildcard) and systemd one `OnCalendar=` line per cron. Both fire in the zone
 * the OS runs in, which is the zone the server reads slots in (`hostZone.ts`).
 *
 * @module scheduleCalendar
 */
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";

/** launchd refuses nothing, but past this many dicts the plist is only noise. */
const LAUNCHD_CALENDAR_LIMIT = 256;

const LAUNCHD_KEYS = ["Month", "Day", "Weekday", "Hour", "Minute"] as const;
type LaunchdKey = (typeof LAUNCHD_KEYS)[number];

/** One `StartCalendarInterval` dict. An omitted key matches every value. */
type LaunchdCalendarInterval = Partial<Record<LaunchdKey, number>>;

interface CronFields {
  readonly minutes: ReadonlyArray<number>;
  readonly hours: ReadonlyArray<number>;
  readonly days: ReadonlyArray<number>;
  readonly months: ReadonlyArray<number>;
  /** 0 is Sunday; `Cron` already folds 7 into 0. */
  readonly weekdays: ReadonlyArray<number>;
}

const FIELD_SIZE = { minutes: 60, hours: 24, days: 31, months: 12, weekdays: 7 } as const;

/** Sorted values, or empty when the field matches everything (`*`, or a full list). */
function restricted(field: ReadonlySet<number>, size: number): ReadonlyArray<number> {
  return field.size >= size ? [] : Array.from(field).sort((left, right) => left - right);
}

function cronFields(cron: string): CronFields | null {
  const parsed = Cron.parse(cron.trim());
  if (Result.isFailure(parsed)) return null;
  const { minutes, hours, days, months, weekdays } = parsed.success;
  return {
    minutes: restricted(minutes, FIELD_SIZE.minutes),
    hours: restricted(hours, FIELD_SIZE.hours),
    days: restricted(days, FIELD_SIZE.days),
    months: restricted(months, FIELD_SIZE.months),
    weekdays: restricted(weekdays, FIELD_SIZE.weekdays),
  };
}

/** Every combination of the restricted fields; an unrestricted field adds no key. */
function intervalsOf(fields: CronFields): LaunchdCalendarInterval[] {
  const axes: ReadonlyArray<readonly [LaunchdKey, ReadonlyArray<number>]> = [
    ["Month", fields.months],
    ["Day", fields.days],
    ["Weekday", fields.weekdays],
    ["Hour", fields.hours],
    ["Minute", fields.minutes],
  ];
  let intervals: LaunchdCalendarInterval[] = [{}];
  for (const [key, values] of axes) {
    if (values.length === 0) continue;
    intervals = intervals.flatMap((interval) =>
      values.map((value) => ({ ...interval, [key]: value })),
    );
  }
  return intervals;
}

const intervalKey = (interval: LaunchdCalendarInterval) =>
  LAUNCHD_KEYS.map((key) => interval[key] ?? -1).join(",");

function sortedUnique(intervals: ReadonlyArray<LaunchdCalendarInterval>) {
  const byKey = new Map<string, LaunchdCalendarInterval>();
  for (const interval of intervals) byKey.set(intervalKey(interval), interval);
  return [...byKey.values()].sort((left, right) => {
    for (const key of LAUNCHD_KEYS) {
      const difference = (left[key] ?? -1) - (right[key] ?? -1);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

/**
 * The union calendar of `crons`, deduplicated and sorted so the same set of
 * crons always renders the same bytes. Past `LAUNCHD_CALENDAR_LIMIT` dicts it
 * widens in steps: first to the hours and minutes alone (fires every day at
 * those times), then to the minutes alone (every hour). A wider calendar is
 * harmless because a fire only runs slots that are due, but each extra fire
 * with the app closed retries for 10 minutes, so it widens no further than
 * it must. launchd, like cron, fires when either `Day` or `Weekday` matches.
 */
export function launchdCalendar(
  crons: ReadonlyArray<string>,
): ReadonlyArray<LaunchdCalendarInterval> {
  const fields = crons.flatMap((cron) => {
    const parsed = cronFields(cron);
    return parsed === null ? [] : [parsed];
  });
  const widenings: ReadonlyArray<(field: CronFields) => CronFields> = [
    (field) => field,
    (field) => ({ ...field, days: [], months: [], weekdays: [] }),
    (field) => ({ ...field, hours: [], days: [], months: [], weekdays: [] }),
  ];
  for (const widen of widenings) {
    const intervals = sortedUnique(fields.map(widen).flatMap(intervalsOf));
    if (intervals.length <= LAUNCHD_CALENDAR_LIMIT) return intervals;
  }
  // Only reachable with over 256 distinct minutes, which a minute field cannot hold.
  return [{}];
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A numeric calendar component: `*`, a repetition such as `00/2` when the
 * values step evenly to the end of the field, else values and `a..b` runs.
 */
function renderComponent(values: ReadonlyArray<number>, max: number): string {
  if (values.length === 0) return "*";
  if (values.length >= 3) {
    const step = values[1]! - values[0]!;
    const even = values.every(
      (value, index) => index === 0 || value - (values[index - 1] ?? 0) === step,
    );
    if (even && step > 1 && values[values.length - 1]! + step > max) {
      return `${pad(values[0]!)}/${step}`;
    }
  }
  return runsOf(values)
    .map(([from, to]) =>
      to - from >= 2
        ? `${pad(from)}..${pad(to)}`
        : from === to
          ? pad(from)
          : `${pad(from)},${pad(to)}`,
    )
    .join(",");
}

/** Consecutive runs of sorted values, as `[first, last]` pairs. */
function runsOf(values: ReadonlyArray<number>): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last !== undefined && value === last[1] + 1) last[1] = value;
    else runs.push([value, value]);
  }
  return runs;
}

const SYSTEMD_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** systemd weeks start on Monday, so Sunday (cron 0) sorts last and `Sat..Sun` is a run. */
function renderWeekdays(weekdays: ReadonlyArray<number>): string {
  const mondayFirst = weekdays.map((day) => (day + 6) % 7).sort((left, right) => left - right);
  return runsOf(mondayFirst)
    .map(([from, to]) =>
      to - from >= 2
        ? `${SYSTEMD_WEEKDAYS[from]}..${SYSTEMD_WEEKDAYS[to]}`
        : from === to
          ? SYSTEMD_WEEKDAYS[from]
          : `${SYSTEMD_WEEKDAYS[from]},${SYSTEMD_WEEKDAYS[to]}`,
    )
    .join(",");
}

/**
 * A cron as one `OnCalendar=` value in `zone`, for example `0 7 * * 1-5` in
 * America/Denver as `Mon..Fri *-*-* 07:00:00 America/Denver`. Null when the
 * cron does not parse. systemd needs a day and a weekday to both match, which
 * `validateScheduleCron` makes moot by refusing crons that restrict both.
 */
export function systemdOnCalendar(cron: string, zone: string): string | null {
  const fields = cronFields(cron);
  if (fields === null) return null;
  const date = `*-${renderComponent(fields.months, 12)}-${renderComponent(fields.days, 31)}`;
  const time = `${renderComponent(fields.hours, 23)}:${renderComponent(fields.minutes, 59)}:00`;
  const weekdays = fields.weekdays.length === 0 ? "" : `${renderWeekdays(fields.weekdays)} `;
  return `${weekdays}${date} ${time} ${zone}`;
}
