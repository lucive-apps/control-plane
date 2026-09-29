import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. Where a coordinator's new agents run. See
// docs/internals/multi-machine-agents.md. Imports only baseSchemas so
// settings.ts and rpc.ts can import this module without a cycle.

/**
 * `local` starts every agent on this machine (today's behaviour), `single`
 * sends them all to one machine, `balanced` spreads them by load.
 */
export const AgentPlacementMode = Schema.Literals(["local", "single", "balanced"]);
export type AgentPlacementMode = typeof AgentPlacementMode.Type;
export const DEFAULT_AGENT_PLACEMENT_MODE: AgentPlacementMode = "local";

/** The same vocabulary as the client's Load balancing: Prefer, Normal, Less often, Manual only. */
export const AgentMachinePreference = Schema.Literals([100, 50, 25, 0]);
export type AgentMachinePreference = typeof AgentMachinePreference.Type;
export const DEFAULT_AGENT_MACHINE_PREFERENCE: AgentMachinePreference = 50;

/** The linked machine's environment id, as its own descriptor reports it. */
export const AgentMachineId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type AgentMachineId = typeof AgentMachineId.Type;

/** What the user picks for "this machine" in `singleMachineId`. */
export const LOCAL_AGENT_MACHINE = "local";

/** A linked machine. Its bearer token lives in the server secret store, never here. */
export const AgentMachineConfig = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** https, or http to a loopback, private-range or tailnet host. */
  baseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  preference: AgentMachinePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_MACHINE_PREFERENCE)),
  ),
});
export type AgentMachineConfig = typeof AgentMachineConfig.Type;

export const AgentPlacementSettings = Schema.Struct({
  mode: AgentPlacementMode.pipe(Schema.withDecodingDefault(Effect.succeed("local" as const))),
  /** For `single`: a machine id, or `local`. Null reads as this machine. */
  singleMachineId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** This machine's weight in `balanced`. */
  localPreference: AgentMachinePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_MACHINE_PREFERENCE)),
  ),
  /** Use this machine when no other is eligible. An explicit machine never falls back. */
  allowLocalFallback: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  machines: Schema.Record(AgentMachineId, AgentMachineConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AgentPlacementSettings = typeof AgentPlacementSettings.Type;

/** Per-entry `machines`, like `usageLimitSources`: `null` removes an entry. */
export const AgentPlacementSettingsPatch = Schema.Struct({
  mode: Schema.optionalKey(AgentPlacementMode),
  singleMachineId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  localPreference: Schema.optionalKey(AgentMachinePreference),
  allowLocalFallback: Schema.optionalKey(Schema.Boolean),
  machines: Schema.optionalKey(Schema.Record(AgentMachineId, Schema.NullOr(AgentMachineConfig))),
});
export type AgentPlacementSettingsPatch = typeof AgentPlacementSettingsPatch.Type;

// ── RPC ────────────────────────────────────────────────────────────

export const AgentMachinesInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("link"),
    /** The pairing link created on the other machine. */
    pairingUrl: TrimmedNonEmptyString,
    /** Overrides the link's address when it is not reachable from this machine. */
    baseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({ action: Schema.Literal("unlink"), id: AgentMachineId }),
  Schema.Struct({ action: Schema.Literal("check") }),
]);
export type AgentMachinesInput = typeof AgentMachinesInput.Type;

export const AgentMachineStatusKind = Schema.Literals([
  "connected",
  "offline",
  "needs-relink",
  "incompatible",
  "wrong-environment",
]);
export type AgentMachineStatusKind = typeof AgentMachineStatusKind.Type;

export const AgentMachineStatus = Schema.Struct({
  id: AgentMachineId,
  status: AgentMachineStatusKind,
  detail: Schema.optionalKey(Schema.String),
  /** When the stored token stops working. Tokens last 30 days and are not refreshed. */
  tokenExpiresAt: Schema.optionalKey(Schema.String),
  /** Projects on this machine with a matching Project on the linked one. */
  matchedProjectCount: Schema.Int,
  projectCount: Schema.Int,
});
export type AgentMachineStatus = typeof AgentMachineStatus.Type;

export const AgentMachinesResult = Schema.Struct({
  /** The entry `link` added. */
  linked: Schema.optionalKey(Schema.Struct({ id: AgentMachineId, label: Schema.String })),
  machines: Schema.Array(AgentMachineStatus),
});
export type AgentMachinesResult = typeof AgentMachinesResult.Type;

export class AgentMachinesError extends Schema.TaggedError<AgentMachinesError>()(
  "AgentMachinesError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
