/**
 * Where a new agent runs. Pure: the caller gathers reachability, load and
 * Project matches, this decides. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module placement
 */
import {
  LOCAL_AGENT_MACHINE,
  type AgentMachinePreference,
  type AgentPlacementSettings,
} from "@t3tools/contracts";

export interface PlacementCandidate {
  /** `LOCAL_AGENT_MACHINE` for this machine, else the linked machine's id. */
  readonly id: string;
  readonly label: string;
  /** Null when the machine can take the agent; else why it cannot. */
  readonly ineligibleReason: string | null;
  /** Running agents on the machine, plus placements it has not shown yet. */
  readonly load: number;
}

export type PlacementDecision =
  | {
      readonly kind: "placed";
      readonly machineId: string;
      readonly label: string;
      /** Set when the choice is not what the settings asked for. */
      readonly note?: string;
    }
  | { readonly kind: "rejected"; readonly detail: string };

const weightOf = (
  settings: Pick<AgentPlacementSettings, "localPreference" | "machines">,
  candidate: PlacementCandidate,
): AgentMachinePreference =>
  candidate.id === LOCAL_AGENT_MACHINE
    ? settings.localPreference
    : (settings.machines[candidate.id]?.preference ?? 50);

/** Load per unit of weight; a new agent adds one. Lower is better. */
export function placementScore(load: number, weight: number): number {
  return (load + 1) / weight;
}

function findRequested(
  requested: string,
  candidates: ReadonlyArray<PlacementCandidate>,
): PlacementCandidate | null {
  const wanted = requested.trim().toLowerCase();
  return (
    candidates.find((candidate) => candidate.id.toLowerCase() === wanted) ??
    candidates.find((candidate) => candidate.label.toLowerCase() === wanted) ??
    null
  );
}

function describe(candidates: ReadonlyArray<PlacementCandidate>): string {
  return candidates
    .map((candidate) =>
      candidate.ineligibleReason === null
        ? candidate.label
        : `${candidate.label} (${candidate.ineligibleReason})`,
    )
    .join(", ");
}

/**
 * `candidates` are this machine and every enabled linked machine, this
 * machine first. `requested` is the tool's explicit `machine`, which the
 * settings still bound and which never falls back.
 */
export function placeAgent(input: {
  readonly settings: Pick<
    AgentPlacementSettings,
    "mode" | "singleMachineId" | "localPreference" | "allowLocalFallback" | "machines"
  >;
  readonly requested: string | undefined;
  readonly candidates: ReadonlyArray<PlacementCandidate>;
}): PlacementDecision {
  const { settings, requested, candidates } = input;
  const local = candidates.find((candidate) => candidate.id === LOCAL_AGENT_MACHINE);
  if (local === undefined) return { kind: "rejected", detail: "This machine is not a candidate." };
  const placed = (candidate: PlacementCandidate, note?: string): PlacementDecision => ({
    kind: "placed",
    machineId: candidate.id,
    label: candidate.label,
    ...(note === undefined ? {} : { note }),
  });

  if (requested !== undefined) {
    const target = findRequested(requested, candidates);
    if (target === null) {
      return {
        kind: "rejected",
        detail: `No machine matches '${requested}'. Available: ${describe(candidates)}.`,
      };
    }
    if (target.id === LOCAL_AGENT_MACHINE) return placed(target);
    if (settings.mode === "local") {
      return {
        kind: "rejected",
        detail:
          "Agents run on this machine only. The user can change where new agents run in Settings > Connections > Agent machines.",
      };
    }
    if (settings.mode === "single" && target.id !== settings.singleMachineId) {
      return {
        kind: "rejected",
        detail: `New agents are set to run on one machine. '${target.label}' is not that machine; omit machine or use "local".`,
      };
    }
    if (target.ineligibleReason !== null) {
      return {
        kind: "rejected",
        detail: `${target.label} cannot take the agent: ${target.ineligibleReason}.`,
      };
    }
    return placed(target);
  }

  if (settings.mode === "local") return placed(local);

  const fallback = (why: string): PlacementDecision =>
    settings.allowLocalFallback
      ? placed(local, `${why} Started on this machine instead.`)
      : { kind: "rejected", detail: `${why} Fallback to this machine is off.` };

  if (settings.mode === "single") {
    const singleId = settings.singleMachineId ?? LOCAL_AGENT_MACHINE;
    if (singleId === LOCAL_AGENT_MACHINE) return placed(local);
    const target = candidates.find((candidate) => candidate.id === singleId);
    if (target === undefined) return fallback("The chosen machine is no longer linked or enabled.");
    if (target.ineligibleReason === null) return placed(target);
    return fallback(`${target.label} is unavailable: ${target.ineligibleReason}.`);
  }

  // balanced: Manual only (weight 0) machines are left out, but this machine
  // is never left out for the fallback below.
  const eligible = candidates.filter(
    (candidate) => candidate.ineligibleReason === null && weightOf(settings, candidate) > 0,
  );
  if (eligible.length === 0) {
    const skipped = candidates.filter((candidate) => candidate.id !== LOCAL_AGENT_MACHINE);
    return fallback(
      skipped.length === 0
        ? "No linked machine is available."
        : `No machine can take the agent: ${describe(candidates)}.`,
    );
  }
  const best = [...eligible].sort((a, b) => {
    const weightA = weightOf(settings, a);
    const weightB = weightOf(settings, b);
    return (
      placementScore(a.load, weightA) - placementScore(b.load, weightB) ||
      a.load - b.load ||
      weightB - weightA ||
      (a.id === LOCAL_AGENT_MACHINE ? -1 : 0) - (b.id === LOCAL_AGENT_MACHINE ? -1 : 0) ||
      a.id.localeCompare(b.id)
    );
  })[0]!;
  return placed(best);
}
