import { describe, expect, it } from "vite-plus/test";

import { hasZoneMismatch, resolveHostTimeZone, zoneFromLocaltimeTarget } from "./hostZone.ts";

describe("zoneFromLocaltimeTarget", () => {
  it("reads the zone after zoneinfo/ on macOS and Linux links", () => {
    expect(zoneFromLocaltimeTarget("/var/db/timezone/zoneinfo/America/Denver")).toBe(
      "America/Denver",
    );
    expect(zoneFromLocaltimeTarget("../usr/share/zoneinfo/posix/Europe/London")).toBe(
      "Europe/London",
    );
    expect(zoneFromLocaltimeTarget("/usr/share/zoneinfo/Not/AZone")).toBeNull();
    expect(zoneFromLocaltimeTarget("/etc/localtime.copy")).toBeNull();
  });
});

describe("resolveHostTimeZone", () => {
  it("prefers the OS zone and falls back to the process zone", () => {
    const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveHostTimeZone(() => "/usr/share/zoneinfo/America/Boise")).toEqual({
      zone: "America/Boise",
      processZone,
    });
    const fallback = resolveHostTimeZone(() => {
      throw new Error("EINVAL: not a link");
    });
    expect(fallback).toEqual({ zone: processZone, processZone });
    expect(hasZoneMismatch(fallback)).toBe(false);
  });

  it("treats zone aliases as the same zone", () => {
    expect(hasZoneMismatch({ zone: "Asia/Kolkata", processZone: "Asia/Calcutta" })).toBe(false);
    expect(hasZoneMismatch({ zone: "America/Boise", processZone: "UTC" })).toBe(true);
  });
});
