/**
 * Muse subscription usage. The MSP host observes quota from the provider
 * during turns and pushes it as `usage/changed`; `usage/read` returns the
 * same payload. A fresh host has observed nothing, so there is no probe
 * read here: windows arrive with turns and the published snapshot keeps
 * the last good values between them, like Claude's sparse updates.
 *
 * @module provider/Layers/museUsageLimits
 */
import type { ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { MuseSubscriptionUsage } from "../museProtocol.ts";
import { clampPercent } from "../providerUsageLimits.ts";

function isoFromEpochMs(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/** Map one observed subscription usage payload onto the two Limits windows. */
export function museUsageToLimitsUpdate(usage: MuseSubscriptionUsage): ProviderUsageLimitsUpdate {
  const windowReset = isoFromEpochMs(usage.window.resetsAtMs);
  const weeklyReset = isoFromEpochMs(usage.weekly.resetsAtMs);
  return {
    windows: [
      {
        id: "current",
        kind: "session",
        label: "Current",
        usedPercent: clampPercent(usage.window.usedPercent),
        ...(windowReset ? { resetsAt: windowReset } : {}),
        windowDurationMins: Math.round(usage.window.windowDurationMins),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
      },
    ],
  };
}
