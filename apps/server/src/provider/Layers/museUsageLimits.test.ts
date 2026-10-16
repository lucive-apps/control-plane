import { describe, expect, it } from "@effect/vitest";

import type { MuseSubscriptionUsage } from "../museProtocol.ts";
import { museUsageToLimitsUpdate } from "./museUsageLimits.ts";

// Sanitized shape captured from a real `usage/changed` payload: percentages
// and reset stamps are invented, the field names and duration are not.
const observed: MuseSubscriptionUsage = {
  observedAtMs: 1_800_000_000_000,
  tier: "00000000000000000",
  window: { usedPercent: 40, windowDurationMins: 300, resetsAtMs: 1_800_001_800_000 },
  weekly: { usedPercent: 10, resetsAtMs: 1_800_432_000_000 },
};

describe("museUsageToLimitsUpdate", () => {
  it("maps the current window and weekly blocks onto Limits windows", () => {
    expect(museUsageToLimitsUpdate(observed)).toEqual({
      windows: [
        {
          id: "current",
          kind: "session",
          label: "Current",
          usedPercent: 40,
          resetsAt: "2027-01-15T08:30:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          resetsAt: "2027-01-20T08:00:00.000Z",
        },
      ],
    });
  });

  it("clamps over-quota percentages instead of inventing headroom", () => {
    const update = museUsageToLimitsUpdate({
      ...observed,
      window: { ...observed.window, usedPercent: 130 },
    });
    expect(update.windows[0]?.usedPercent).toBe(100);
  });
});
