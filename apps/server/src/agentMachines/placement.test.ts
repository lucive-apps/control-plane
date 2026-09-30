import { LOCAL_AGENT_MACHINE, type AgentMachinePreference } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { placeAgent, placementScore, type PlacementCandidate } from "./placement.ts";

type Settings = Parameters<typeof placeAgent>[0]["settings"];

const machine = (label: string, preference: AgentMachinePreference = 50) => ({
  label,
  baseUrl: `http://${label.toLowerCase().replaceAll(" ", "-")}.tailnet.ts.net:3773`,
  enabled: true,
  preference,
});

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  mode: "balanced",
  singleMachineId: null,
  localPreference: 50,
  allowLocalFallback: true,
  machines: { mini: machine("Mac Mini"), studio: machine("Studio") },
  ...overrides,
});

const local = (load = 0): PlacementCandidate => ({
  id: LOCAL_AGENT_MACHINE,
  label: "This Mac",
  ineligibleReason: null,
  load,
});

const remote = (
  id: string,
  label: string,
  load = 0,
  ineligibleReason: string | null = null,
): PlacementCandidate => ({ id, label, ineligibleReason, load });

const mini = (load = 0, reason: string | null = null) => remote("mini", "Mac Mini", load, reason);
const studio = (load = 0, reason: string | null = null) => remote("studio", "Studio", load, reason);

const place = (
  overrides: Partial<Settings>,
  candidates: ReadonlyArray<PlacementCandidate>,
  requested?: string,
) => placeAgent({ settings: settings(overrides), requested, candidates });

describe("placementScore", () => {
  it("is load per unit of weight, counting the new agent", () => {
    expect(placementScore(0, 50)).toBe(1 / 50);
    expect(placementScore(3, 100)).toBe(4 / 100);
    expect(placementScore(1, 25)).toBe(2 / 25);
  });
});

describe("placeAgent without an explicit machine", () => {
  it("rejects when this machine is not a candidate", () => {
    expect(place({ mode: "local" }, [mini()])).toEqual({
      kind: "rejected",
      detail: "This machine is not a candidate.",
    });
  });

  it("local mode always places on this machine, however loaded", () => {
    expect(place({ mode: "local" }, [local(9), mini(0)])).toEqual({
      kind: "placed",
      machineId: LOCAL_AGENT_MACHINE,
      label: "This Mac",
    });
  });

  it("single mode places on the chosen machine when it is eligible", () => {
    expect(
      place({ mode: "single", singleMachineId: "mini" }, [local(), mini(5), studio()]),
    ).toEqual({ kind: "placed", machineId: "mini", label: "Mac Mini" });
  });

  it("single mode with no choice or 'local' places on this machine", () => {
    for (const singleMachineId of [null, LOCAL_AGENT_MACHINE]) {
      expect(place({ mode: "single", singleMachineId }, [local(), mini()])).toEqual({
        kind: "placed",
        machineId: LOCAL_AGENT_MACHINE,
        label: "This Mac",
      });
    }
  });

  it("single mode falls back to this machine with a note when the chosen one is ineligible", () => {
    const decision = place({ mode: "single", singleMachineId: "mini" }, [
      local(),
      mini(0, "offline"),
    ]);
    expect(decision).toEqual({
      kind: "placed",
      machineId: LOCAL_AGENT_MACHINE,
      label: "This Mac",
      note: "Mac Mini is unavailable: offline. Started on this machine instead.",
    });
  });

  it("single mode falls back with a note when the chosen machine is no longer a candidate", () => {
    const decision = place({ mode: "single", singleMachineId: "gone" }, [local(), mini()]);
    expect(decision.kind).toBe("placed");
    if (decision.kind !== "placed") return;
    expect(decision.machineId).toBe(LOCAL_AGENT_MACHINE);
    expect(decision.note).toContain("no longer linked or enabled");
  });

  it("single mode is rejected instead of falling back when fallback is off", () => {
    expect(
      place({ mode: "single", singleMachineId: "mini", allowLocalFallback: false }, [
        local(),
        mini(0, "no matching Project"),
      ]),
    ).toEqual({
      kind: "rejected",
      detail: "Mac Mini is unavailable: no matching Project. Fallback to this machine is off.",
    });
  });

  it("balanced picks the lowest (load + 1) / weight", () => {
    // local: 2/50 = 0.04, mini: 3/100 = 0.03, studio: 1/25 = 0.04
    const decision = place(
      {
        localPreference: 50,
        machines: { mini: machine("Mac Mini", 100), studio: machine("Studio", 25) },
      },
      [local(1), mini(2), studio(0)],
    );
    expect(decision).toEqual({ kind: "placed", machineId: "mini", label: "Mac Mini" });
  });

  it("balanced prefers an idle machine over a busier one at the same weight", () => {
    expect(place({}, [local(2), mini(0), studio(1)])).toMatchObject({ machineId: "mini" });
  });

  it("balanced reads a machine missing from settings as Normal (50)", () => {
    // mini has no settings entry: 2/50 = 0.04 beats local 3/50 = 0.06.
    expect(place({ machines: {} }, [local(2), mini(1)])).toMatchObject({ machineId: "mini" });
  });

  it("balanced leaves Manual only (weight 0) machines out of automatic choice", () => {
    const decision = place({ machines: { mini: machine("Mac Mini", 0) } }, [local(8), mini(0)]);
    expect(decision).toEqual({ kind: "placed", machineId: LOCAL_AGENT_MACHINE, label: "This Mac" });
  });

  it("balanced skips ineligible machines", () => {
    expect(place({}, [local(4), mini(0, "offline"), studio(1)])).toMatchObject({
      machineId: "studio",
    });
  });

  it("a local preference of 0 sends every automatic agent to a linked machine", () => {
    expect(place({ localPreference: 0 }, [local(0), mini(9)])).toMatchObject({
      machineId: "mini",
    });
  });

  it("a local preference of 0 with no eligible remote falls back to this machine with a note", () => {
    const decision = place({ localPreference: 0 }, [
      local(0),
      mini(0, "offline"),
      studio(0, "offline"),
    ]);
    expect(decision).toEqual({
      kind: "placed",
      machineId: LOCAL_AGENT_MACHINE,
      label: "This Mac",
      note: "No machine can take the agent: This Mac, Mac Mini (offline), Studio (offline). Started on this machine instead.",
    });
  });

  it("a local preference of 0 with no linked machine at all falls back with its own note", () => {
    const decision = place({ localPreference: 0, machines: {} }, [local(0)]);
    expect(decision).toEqual({
      kind: "placed",
      machineId: LOCAL_AGENT_MACHINE,
      label: "This Mac",
      note: "No linked machine is available. Started on this machine instead.",
    });
  });

  it("balanced with nothing eligible is rejected when fallback is off", () => {
    const decision = place({ localPreference: 0, allowLocalFallback: false }, [
      local(0),
      mini(0, "needs re-link"),
    ]);
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") return;
    expect(decision.detail).toContain("Mac Mini (needs re-link)");
    expect(decision.detail).toContain("Fallback to this machine is off.");
  });
});

describe("placeAgent tie-breaks", () => {
  it("equal scores go to the lower load", () => {
    // local 1/50 = 0.02, mini 2/100 = 0.02: local has less load.
    expect(
      place({ machines: { mini: machine("Mac Mini", 100) } }, [local(0), mini(1)]),
    ).toMatchObject({ machineId: LOCAL_AGENT_MACHINE });
    // local 2/50 = 0.04, mini 1/25 = 0.04: mini has less load.
    expect(
      place({ machines: { mini: machine("Mac Mini", 25) } }, [local(1), mini(0)]),
    ).toMatchObject({ machineId: "mini" });
  });

  it("equal score and load go to this machine, ahead of a lower id", () => {
    const decision = place({ machines: { aaa: machine("Alpha") } }, [
      remote("aaa", "Alpha"),
      local(0),
    ]);
    expect(decision).toMatchObject({ machineId: LOCAL_AGENT_MACHINE });
  });

  it("equal linked machines are ordered by id, whatever the candidate order", () => {
    const candidates = [studio(0), mini(0)];
    expect(place({ localPreference: 0 }, [local(), ...candidates])).toMatchObject({
      machineId: "mini",
    });
    expect(place({ localPreference: 0 }, [local(), ...candidates.toReversed()])).toMatchObject({
      machineId: "mini",
    });
  });
});

describe("placeAgent with an explicit machine", () => {
  it("names a machine by id or by label, ignoring case and spaces around it", () => {
    for (const requested of ["mini", "MINI", "Mac Mini", "  mac mini "]) {
      expect(place({}, [local(0), mini(9)], requested)).toEqual({
        kind: "placed",
        machineId: "mini",
        label: "Mac Mini",
      });
    }
  });

  it("'local' is always allowed, in every mode", () => {
    for (const mode of ["local", "single", "balanced"] as const) {
      expect(place({ mode, singleMachineId: "mini" }, [local(9), mini(0)], "local")).toMatchObject({
        kind: "placed",
        machineId: LOCAL_AGENT_MACHINE,
      });
    }
  });

  it("a linked machine is rejected in local mode", () => {
    const decision = place({ mode: "local" }, [local(), mini()], "mini");
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") return;
    expect(decision.detail).toContain("Agents run on this machine only.");
  });

  it("single mode allows only the chosen machine", () => {
    const candidates = [local(), mini(), studio()];
    expect(place({ mode: "single", singleMachineId: "mini" }, candidates, "Mac Mini")).toEqual({
      kind: "placed",
      machineId: "mini",
      label: "Mac Mini",
    });
    const other = place({ mode: "single", singleMachineId: "mini" }, candidates, "studio");
    expect(other.kind).toBe("rejected");
    if (other.kind !== "rejected") return;
    expect(other.detail).toContain("'Studio' is not that machine");
  });

  it("balanced allows a Manual only machine when it is named", () => {
    expect(
      place({ machines: { mini: machine("Mac Mini", 0) } }, [local(0), mini(5)], "mini"),
    ).toEqual({ kind: "placed", machineId: "mini", label: "Mac Mini" });
  });

  it("an ineligible machine is rejected with its reason and never falls back", () => {
    for (const mode of ["single", "balanced"] as const) {
      expect(
        place(
          { mode, singleMachineId: "mini", allowLocalFallback: true },
          [local(), mini(0, "offline")],
          "mini",
        ),
      ).toEqual({ kind: "rejected", detail: "Mac Mini cannot take the agent: offline." });
    }
  });

  it("an unknown machine is rejected and lists what is available", () => {
    expect(place({}, [local(), mini(0, "offline")], "laptop")).toEqual({
      kind: "rejected",
      detail: "No machine matches 'laptop'. Available: This Mac, Mac Mini (offline).",
    });
  });
});
