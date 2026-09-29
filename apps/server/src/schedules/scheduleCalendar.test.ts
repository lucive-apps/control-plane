import { describe, expect, it } from "vite-plus/test";

import { launchdCalendar, systemdOnCalendar } from "./scheduleCalendar.ts";

describe("launchdCalendar", () => {
  it("lists every combination of the restricted fields", () => {
    expect(launchdCalendar(["0 7 * * 1-5"])).toEqual(
      [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 7, Minute: 0 })),
    );
    expect(launchdCalendar(["*/15 * * * *"])).toEqual([
      { Minute: 0 },
      { Minute: 15 },
      { Minute: 30 },
      { Minute: 45 },
    ]);
    // A field listing every value is a wildcard, not 24 dicts.
    expect(launchdCalendar(["0 0-23 * * *"])).toEqual([{ Minute: 0 }]);
    expect(launchdCalendar(["0 9 1 * *"])).toEqual([{ Day: 1, Hour: 9, Minute: 0 }]);
  });

  it("merges schedules into one sorted, deduplicated calendar", () => {
    const weekdays = launchdCalendar(["0 7 * * 1-5"]);
    expect(launchdCalendar(["0 7 * * 1,2", "0 7 * * 1-5"])).toEqual(weekdays);
    // Order of the schedules never changes the bytes.
    expect(launchdCalendar(["0 16 * * 5", "0 7 * * *"])).toEqual(
      launchdCalendar(["0 7 * * *", "0 16 * * 5"]),
    );
    expect(launchdCalendar(["0 7 * * *", "0 16 * * 5"])).toEqual([
      { Hour: 7, Minute: 0 },
      { Weekday: 5, Hour: 16, Minute: 0 },
    ]);
  });

  it("widens past 256 dicts to the times of day, then to the minutes alone", () => {
    // 4 minutes x 13 hours x 15 days = 780 dicts; its 52 times of day fit.
    const timesOfDay = launchdCalendar(["0,15,30,45 8-20 1-15 * *"]);
    expect(timesOfDay).toHaveLength(52);
    expect(timesOfDay.at(0)).toEqual({ Hour: 8, Minute: 0 });
    expect(timesOfDay.at(-1)).toEqual({ Hour: 20, Minute: 45 });
    // 2 minutes x 23 hours x 6 weekdays = 276 dicts, merged with a daily time.
    expect(launchdCalendar(["0,30 0-22 * * 1-6", "15 9 * * *"])).toHaveLength(47);
    // 12 minutes x 23 hours is 276 times of day, so only the minutes are left.
    expect(launchdCalendar(["*/5 0-22 * * 1-6"])).toEqual(
      Array.from({ length: 12 }, (_, index) => ({ Minute: index * 5 })),
    );
  });
});

describe("systemdOnCalendar", () => {
  const zone = "America/Denver";

  it("renders presets in the host zone", () => {
    expect(systemdOnCalendar("0 7 * * *", zone)).toBe("*-*-* 07:00:00 America/Denver");
    expect(systemdOnCalendar("0 7 * * 1-5", zone)).toBe("Mon..Fri *-*-* 07:00:00 America/Denver");
    expect(systemdOnCalendar("0 16 * * 5", zone)).toBe("Fri *-*-* 16:00:00 America/Denver");
    expect(systemdOnCalendar("0 9 1 * *", zone)).toBe("*-*-01 09:00:00 America/Denver");
  });

  it("renders steps as repetitions", () => {
    expect(systemdOnCalendar("0 */2 * * *", zone)).toBe("*-*-* 00/2:00:00 America/Denver");
    expect(systemdOnCalendar("*/15 * * * *", zone)).toBe("*-*-* *:00/15:00 America/Denver");
    expect(systemdOnCalendar("30 9-17 * * *", zone)).toBe("*-*-* 09..17:30:00 America/Denver");
  });

  it("reads Sunday as 0 or 7, and weeks as starting on Monday", () => {
    expect(systemdOnCalendar("0 9 * * 0", zone)).toBe("Sun *-*-* 09:00:00 America/Denver");
    expect(systemdOnCalendar("0 9 * * 7", zone)).toBe("Sun *-*-* 09:00:00 America/Denver");
    expect(systemdOnCalendar("0 10 * * 0,6", zone)).toBe("Sat,Sun *-*-* 10:00:00 America/Denver");
  });

  it("returns null for a cron that does not parse", () => {
    expect(systemdOnCalendar("not a cron", zone)).toBeNull();
  });
});
