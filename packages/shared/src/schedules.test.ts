// @effect-diagnostics globalDate:off -- Fixed instants keep slot and zone assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  describeCadence,
  describeCron,
  newScheduleId,
  nextScheduleRuns,
  scheduleSlotAt,
  validateScheduleCron,
} from "./schedules.ts";

const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("validateScheduleCron", () => {
  it("accepts every preset shape", () => {
    for (const cron of [
      "0 7 * * *",
      "0 7 * * 1-5",
      "0 16 * * 5",
      "0 9 * * 1,4",
      "0 */2 * * *",
      "0 9 1 * *",
      "*/15 * * * *",
    ]) {
      expect(validateScheduleCron(cron), cron).toBeNull();
    }
  });

  it("holds schedules to one run per 15 minutes", () => {
    expect(validateScheduleCron("*/5 * * * *")).toBe("Schedules run at most every 15 minutes.");
    expect(validateScheduleCron("* 9 * * *")).not.toBeNull();
    // The wrap from 23:55 to the next day's 00:00 counts too.
    expect(validateScheduleCron("0,55 0,23 * * *")).not.toBeNull();
    expect(validateScheduleCron("*/15 * * * *")).toBeNull();
  });

  it("refuses a day of the month together with days of the week", () => {
    expect(validateScheduleCron("0 7 1 * 1")).toBe(
      "Pick days of the month or days of the week, not both.",
    );
  });

  it("refuses a date that never exists, but keeps February 29", () => {
    for (const cron of ["0 7 31 2 *", "0 7 30 2 *", "0 7 31 4 *"]) {
      expect(validateScheduleCron(cron), cron).toBe("That schedule never runs.");
    }
    expect(validateScheduleCron("0 7 29 2 *")).toBeNull();
    expect(validateScheduleCron("0 7 31 1,2 *")).toBeNull();
  });

  it("wants exactly five fields that parse", () => {
    expect(validateScheduleCron("0 0 7 * * *")).not.toBeNull();
    expect(validateScheduleCron("0 7 * *")).not.toBeNull();
    expect(validateScheduleCron("0 25 * * *")).toBe("That cron expression is not valid.");
  });
});

describe("scheduleSlotAt", () => {
  it("returns the slot itself when the fire lands exactly on it", () => {
    const slot = new Date("2026-06-01T07:00:00.000Z");
    expect(iso(scheduleSlotAt("0 7 * * *", "UTC", slot))).toBe("2026-06-01T07:00:00.000Z");
    expect(iso(scheduleSlotAt("0 7 * * *", "UTC", new Date(slot.getTime() - 1)))).toBe(
      "2026-05-31T07:00:00.000Z",
    );
    expect(iso(scheduleSlotAt("0 7 * * *", "UTC", new Date(slot.getTime() + 90_000)))).toBe(
      "2026-06-01T07:00:00.000Z",
    );
  });

  it("reads the cron in the host zone, whatever the process zone is", () => {
    try {
      vi.stubEnv("TZ", "UTC");
      expect(
        iso(scheduleSlotAt("0 7 * * *", "America/Boise", new Date("2026-06-01T15:00:00.000Z"))),
      ).toBe("2026-06-01T13:00:00.000Z");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns null for an unknown zone, a bad cron or a cron that never runs", () => {
    expect(scheduleSlotAt("0 7 * * *", "Not/AZone", new Date())).toBeNull();
    expect(scheduleSlotAt("0 99 * * *", "UTC", new Date())).toBeNull();
    expect(scheduleSlotAt("0 7 31 2 *", "UTC", new Date("2026-05-01T00:00:00.000Z"))).toBeNull();
    expect(iso(scheduleSlotAt("0 7 29 2 *", "UTC", new Date("2026-05-01T00:00:00.000Z")))).toBe(
      "2024-02-29T07:00:00.000Z",
    );
  });

  describe("across the spring-forward change in America/Denver", () => {
    const at = (cron: string, now: string) =>
      iso(scheduleSlotAt(cron, "America/Denver", new Date(now)));

    it("finds the 02:30 run that moved to 03:30, as the listed runs show it", () => {
      expect(at("30 2 * * *", "2026-03-08T09:29:00.000Z")).toBe("2026-03-07T09:30:00.000Z");
      expect(at("30 2 * * *", "2026-03-08T10:00:00.000Z")).toBe("2026-03-08T09:30:00.000Z");
      expect(at("30 2 * * *", "2026-03-09T08:00:00.000Z")).toBe("2026-03-08T09:30:00.000Z");
    });

    it("never returns a slot after now at the moment of the change", () => {
      expect(at("30 3 * * *", "2026-03-08T09:00:00.000Z")).toBe("2026-03-07T10:30:00.000Z");
    });

    it("finds a weekly run in the skipped hour for the whole following week", () => {
      expect(at("15 2 * * 0", "2026-03-10T12:00:00.000Z")).toBe("2026-03-08T09:15:00.000Z");
      expect(at("15 2 * * 0", "2026-03-15T08:00:00.000Z")).toBe("2026-03-08T09:15:00.000Z");
    });
  });

  it("keeps the one 01:30 of the fall-back night through the repeated hour", () => {
    for (const now of [
      "2026-11-01T08:10:00.000Z",
      "2026-11-01T08:45:00.000Z",
      "2026-11-01T09:10:00.000Z",
    ]) {
      expect(iso(scheduleSlotAt("30 1 * * *", "America/Denver", new Date(now))), now).toBe(
        "2026-11-01T07:30:00.000Z",
      );
    }
  });
});

describe("nextScheduleRuns", () => {
  it("runs 01:30 once on the fall-back night", () => {
    const runs = nextScheduleRuns(
      "30 1 * * *",
      "America/Denver",
      new Date("2026-10-31T12:00:00.000Z"),
      2,
    );
    expect(runs.map(iso)).toEqual(["2026-11-01T07:30:00.000Z", "2026-11-02T08:30:00.000Z"]);
  });

  it("moves 02:30 to 03:30 on the spring-forward night", () => {
    const runs = nextScheduleRuns(
      "30 2 * * *",
      "America/Denver",
      new Date("2026-03-07T12:00:00.000Z"),
      2,
    );
    expect(runs.map(iso)).toEqual(["2026-03-08T09:30:00.000Z", "2026-03-09T08:30:00.000Z"]);
  });

  it("lists nothing for a cron that never runs", () => {
    expect(nextScheduleRuns("0 7 31 2 *", "UTC", new Date("2026-05-01T00:00:00.000Z"), 3)).toEqual(
      [],
    );
  });

  it("lists the next weekday runs in order", () => {
    const runs = nextScheduleRuns("0 7 * * 1-5", "UTC", new Date("2026-06-05T08:00:00.000Z"), 3);
    // Friday after 07:00, so Monday through Wednesday.
    expect(runs.map(iso)).toEqual([
      "2026-06-08T07:00:00.000Z",
      "2026-06-09T07:00:00.000Z",
      "2026-06-10T07:00:00.000Z",
    ]);
  });
});

describe("describeCadence", () => {
  it("names the presets", () => {
    expect(describeCadence("0 7 * * *")).toBe("Every day at 7:00");
    expect(describeCadence("0 7 * * 1-5")).toBe("Weekdays at 7:00");
    expect(describeCadence("0 7 * * MON-FRI")).toBe("Weekdays at 7:00");
    expect(describeCadence("0 16 * * 5")).toBe("Fridays at 16:00");
    expect(describeCadence("30 9 * * 1,4")).toBe("Mondays and Thursdays at 9:30");
    expect(describeCadence("0 10 * * 0,6")).toBe("Weekends at 10:00");
    expect(describeCadence("0 10 * * 7")).toBe("Sundays at 10:00");
    expect(describeCadence("0 */2 * * *")).toBe("Every 2 hours");
    expect(describeCadence("0 * * * *")).toBe("Every hour");
    expect(describeCadence("0 9 1 * *")).toBe("Monthly on the 1st at 9:00");
    expect(describeCadence("0 9 22 * *")).toBe("Monthly on the 22nd at 9:00");
  });

  it("reads a field that lists every value as unrestricted", () => {
    expect(describeCadence("0 7 * * 0-6")).toBe("Every day at 7:00");
    expect(describeCadence("0 7 * * 1-7")).toBe("Every day at 7:00");
    expect(describeCadence("0 7 1-31 * *")).toBe("Every day at 7:00");
    expect(describeCron("0 7 * 1-12 1-5")).toBe("At 07:00, Monday through Friday");
  });

  it("falls back to plain words for anything else", () => {
    expect(describeCadence("0 7,19 * * *")).toBe("At 07:00 and 19:00");
    expect(describeCadence("*/15 9-17 * * *")).toBe("Every 15 minutes, between 09:00 and 17:59");
    expect(describeCadence("30 */3 * * *")).toBe("At minute 30 past every 3 hours");
    expect(describeCadence("0 9 1 1,7 *")).toBe(
      "At 09:00, on day 1 of the month, in January and July",
    );
    expect(describeCadence("not a cron")).toBe("not a cron");
  });
});

describe("describeCron", () => {
  it("reads any cron in plain words", () => {
    expect(describeCron("0 7 * * 1-5")).toBe("At 07:00, Monday through Friday");
    expect(describeCron("0 7 * * 1,3")).toBe("At 07:00, on Monday and Wednesday");
    expect(describeCron("0 7 * * 5,6,0")).toBe("At 07:00, Friday through Sunday");
  });
});

describe("newScheduleId", () => {
  const pattern = /^[a-z0-9-]{1,40}$/;

  it("builds a valid id from an ASCII name", () => {
    const id = newScheduleId("Morning Brief");
    expect(id).toMatch(/^morning-brief-[a-z0-9]{6}$/);
    expect(id).toMatch(pattern);
    const long = newScheduleId("A very long schedule name that keeps going and going");
    expect(long).toMatch(pattern);
    expect(long.endsWith("-")).toBe(false);
  });

  it("falls back for names with no ASCII slug", () => {
    const id = newScheduleId("日報");
    expect(id).toMatch(/^s-[a-z0-9]{6}$/);
    expect(id).toMatch(pattern);
  });
});
