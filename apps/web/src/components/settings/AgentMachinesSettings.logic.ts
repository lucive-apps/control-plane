import {
  AgentMachinesError,
  AgentPlacementMode as AgentPlacementModeSchema,
  LOCAL_AGENT_MACHINE,
  type AgentMachineConfig,
  type AgentMachinePreference,
  type AgentMachineStatus,
  type AgentMachinesInput,
  type AgentPlacementMode,
  type AgentPlacementSettings,
  type AgentPlacementSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const isAgentPlacementMode = Schema.is(AgentPlacementModeSchema);

export const agentPlacementModeOptions: ReadonlyArray<{
  readonly value: AgentPlacementMode;
  readonly label: string;
}> = [
  { value: "local", label: "This machine" },
  { value: "single", label: "One machine" },
  { value: "balanced", label: "Balance across machines" },
];

export interface LinkedAgentMachine extends AgentMachineConfig {
  readonly id: string;
}

/** Linked machines in label order, so rows never reorder when one is toggled. */
export function linkedAgentMachines(
  placement: AgentPlacementSettings,
): ReadonlyArray<LinkedAgentMachine> {
  return Object.entries(placement.machines)
    .map(([id, config]) => ({ id, ...config }))
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * The machine "One machine" points at. Null, `local` and a machine that has
 * since been unlinked all read as this machine, like the server's placement.
 */
export function singleAgentMachineValue(placement: AgentPlacementSettings): string {
  const id = placement.singleMachineId;
  return id !== null && id in placement.machines ? id : LOCAL_AGENT_MACHINE;
}

export function singleAgentMachineOptions(
  placement: AgentPlacementSettings,
): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  return [
    { value: LOCAL_AGENT_MACHINE, label: "This machine" },
    ...linkedAgentMachines(placement).map((machine) => ({
      value: machine.id,
      label: machine.label,
    })),
  ];
}

/**
 * How many machines Balance can pick without being named: this machine and
 * every switched-on linked machine, minus those set to Manual only.
 */
export function balancedAgentMachineCount(placement: AgentPlacementSettings): number {
  const linked = Object.values(placement.machines).filter(
    (machine) => machine.enabled && machine.preference > 0,
  ).length;
  return linked + (placement.localPreference > 0 ? 1 : 0);
}

/** Closed-header summary of where new agents run. */
export function summarizeAgentPlacement(placement: AgentPlacementSettings): string {
  switch (placement.mode) {
    case "local":
      return "This machine";
    case "single": {
      const id = singleAgentMachineValue(placement);
      return id === LOCAL_AGENT_MACHINE
        ? "This machine"
        : `One machine: ${placement.machines[id]!.label}`;
    }
    case "balanced": {
      const count = balancedAgentMachineCount(placement);
      return `Balanced across ${count} ${count === 1 ? "machine" : "machines"}`;
    }
  }
}

export type AgentMachineStatusTone = "success" | "warning" | "destructive" | "muted";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "expires in 5 days", "expired 2 days ago". Null when the date is missing or unreadable. */
export function tokenExpiryText(tokenExpiresAt: string | undefined, now: number): string | null {
  if (tokenExpiresAt === undefined) return null;
  const expiresAt = Date.parse(tokenExpiresAt);
  if (Number.isNaN(expiresAt)) return null;
  const remaining = expiresAt - now;
  const days = Math.floor(Math.abs(remaining) / DAY_MS);
  const span = days === 1 ? "1 day" : `${days} days`;
  if (remaining >= 0) return days === 0 ? "token expires today" : `token expires in ${span}`;
  return days === 0 ? "token expired today" : `token expired ${span} ago`;
}

/** Tokens last 30 days and are not refreshed, so warn a week ahead. */
const EXPIRY_WARNING_MS = 7 * DAY_MS;

export function agentMachineStatusPresentation(
  status: AgentMachineStatus | undefined,
  now: number,
): { readonly label: string; readonly tone: AgentMachineStatusTone } {
  if (status === undefined) return { label: "Not checked", tone: "muted" };
  const expiry = tokenExpiryText(status.tokenExpiresAt, now);
  switch (status.status) {
    case "connected": {
      const expiresAt =
        status.tokenExpiresAt === undefined ? Number.NaN : Date.parse(status.tokenExpiresAt);
      const expiringSoon = !Number.isNaN(expiresAt) && expiresAt - now <= EXPIRY_WARNING_MS;
      return expiringSoon && expiry !== null
        ? { label: `Connected, ${expiry}`, tone: "warning" }
        : { label: "Connected", tone: "success" };
    }
    case "offline":
      return { label: "Offline", tone: "muted" };
    case "needs-relink":
      return {
        label: expiry === null ? "Needs re-link" : `Needs re-link (${expiry})`,
        tone: "destructive",
      };
    case "incompatible":
      return { label: "Incompatible version", tone: "destructive" };
    case "wrong-environment":
      return { label: "Wrong environment", tone: "destructive" };
  }
}

export function agentMachineStatusDotClassName(tone: AgentMachineStatusTone): string {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "destructive":
      return "bg-destructive";
    case "muted":
      return "bg-muted-foreground/40";
  }
}

/** "Matches 3 of 4 Projects". Null when this machine has no Projects to match. */
export function projectMatchText(status: AgentMachineStatus | undefined): string | null {
  if (status === undefined || status.projectCount === 0) return null;
  const noun = status.projectCount === 1 ? "Project" : "Projects";
  return `Matches ${status.matchedProjectCount} of ${status.projectCount} ${noun}`;
}

export function agentMachineStatusesById(
  statuses: ReadonlyArray<AgentMachineStatus>,
): ReadonlyMap<string, AgentMachineStatus> {
  return new Map(statuses.map((status) => [status.id, status]));
}

// ── Patches ─────────────────────────────────────────────────────────

export function agentPlacementModePatch(mode: AgentPlacementMode): AgentPlacementSettingsPatch {
  return { mode };
}

export function singleAgentMachinePatch(id: string): AgentPlacementSettingsPatch {
  return { singleMachineId: id };
}

export function localPreferencePatch(
  localPreference: AgentMachinePreference,
): AgentPlacementSettingsPatch {
  return { localPreference };
}

export function localFallbackPatch(allowLocalFallback: boolean): AgentPlacementSettingsPatch {
  return { allowLocalFallback };
}

/**
 * The server merges `machines` per entry and replaces the entry it names, so
 * the patch carries the whole entry. Null when the machine is no longer linked,
 * because writing it back would resurrect an entry without a token.
 */
export function agentMachineEntryPatch(
  placement: AgentPlacementSettings,
  id: string,
  changes: Partial<Pick<AgentMachineConfig, "enabled" | "preference">>,
): AgentPlacementSettingsPatch | null {
  const current = placement.machines[id];
  if (current === undefined) return null;
  return {
    machines: {
      [id]: {
        label: current.label,
        baseUrl: current.baseUrl,
        enabled: changes.enabled ?? current.enabled,
        preference: changes.preference ?? current.preference,
      },
    },
  };
}

// ── RPC ─────────────────────────────────────────────────────────────

/** A link request; a blank address override is left out so the link's own address is used. */
export function agentMachineLinkInput(pairingUrl: string, baseUrl: string): AgentMachinesInput {
  const override = baseUrl.trim();
  return {
    action: "link",
    pairingUrl: pairingUrl.trim(),
    ...(override.length > 0 ? { baseUrl: override } : {}),
  };
}

const isAgentMachinesError = Schema.is(AgentMachinesError);

/** Toast text for a failed agent machines call. The server's detail wins when it sent one. */
export function agentMachinesErrorMessage(error: unknown): string {
  if (isAgentMachinesError(error)) return error.detail;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "The server did not answer. Check that it is up to date and try again.";
}
