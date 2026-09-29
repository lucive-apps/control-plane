// @effect-diagnostics nodeBuiltinImport:off - reads the OS zone link, a host boundary.
/**
 * The host's time zone for schedules. Fork-owned.
 *
 * launchd and systemd fire in the OS zone, and the server process may run
 * with another `TZ` (a shell env, a container) or keep a zone it read before
 * the user changed it. So slots are read in the zone `/etc/localtime` names,
 * resolved on every fire and status call rather than cached.
 *
 * @module hostZone
 */
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";

export interface HostTimeZone {
  /** The zone schedules run in: the OS zone, or the process zone without one. */
  readonly zone: string;
  /** The server process's own zone. */
  readonly processZone: string;
}

const LOCALTIME_PATH = "/etc/localtime";

/** The IANA name for `zone`, so aliases such as Asia/Calcutta and Asia/Kolkata compare equal. */
function canonicalZone(zone: string): string | null {
  if (zone.trim().length === 0) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * `America/Denver` from a `/etc/localtime` link target such as
 * `/var/db/timezone/zoneinfo/America/Denver` or `../usr/share/zoneinfo/posix/America/Denver`.
 */
export function zoneFromLocaltimeTarget(target: string): string | null {
  const marker = "zoneinfo/";
  const index = target.lastIndexOf(marker);
  if (index < 0) return null;
  const name = target.slice(index + marker.length).replace(/^(?:posix|right)\//, "");
  return canonicalZone(name) === null ? null : name;
}

/** Reads the OS zone. Falls back to the process zone when `/etc/localtime` is absent or not a link. */
export function resolveHostTimeZone(
  readLink: (path: string) => string = (path) => NodeFS.readlinkSync(path),
): HostTimeZone {
  const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let zone: string | null = null;
  try {
    zone = zoneFromLocaltimeTarget(readLink(LOCALTIME_PATH));
  } catch {
    // Windows, or a copied file instead of a link.
  }
  return { zone: zone ?? processZone, processZone };
}

/** The process runs in another zone than the OS scheduler fires in. */
export function hasZoneMismatch(zone: HostTimeZone): boolean {
  return canonicalZone(zone.zone) !== canonicalZone(zone.processZone);
}

/** Tests replace the reader to pin a zone. */
export const HostTimeZoneSource = Context.Reference<() => HostTimeZone>(
  "t3/schedules/hostZone/HostTimeZoneSource",
  { defaultValue: () => () => resolveHostTimeZone() },
);
