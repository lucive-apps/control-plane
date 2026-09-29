import {
  AgentMachinesError,
  type AgentMachineStatus,
  type AgentPlacementSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentMachineEntryPatch,
  agentMachineLinkInput,
  agentMachineStatusPresentation,
  agentMachinesErrorMessage,
  balancedAgentMachineCount,
  linkedAgentMachines,
  projectMatchText,
  singleAgentMachineOptions,
  singleAgentMachineValue,
  summarizeAgentPlacement,
  tokenExpiryText,
} from "./AgentMachinesSettings.logic";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function placement(overrides: Partial<AgentPlacementSettings> = {}): AgentPlacementSettings {
  return {
    mode: "local",
    singleMachineId: null,
    localPreference: 50,
    allowLocalFallback: true,
    machines: {
      "env-mini": {
        label: "Mac Mini",
        baseUrl: "http://mini.tail.ts.net:3773",
        enabled: true,
        preference: 50,
      },
      "env-box": {
        label: "Build box",
        baseUrl: "https://box.example.com",
        enabled: true,
        preference: 100,
      },
    },
    ...overrides,
  };
}

function status(overrides: Partial<AgentMachineStatus> = {}): AgentMachineStatus {
  return {
    id: "env-mini",
    status: "connected",
    matchedProjectCount: 3,
    projectCount: 4,
    ...overrides,
  };
}

describe("summarizeAgentPlacement", () => {
  it("names this machine for local mode", () => {
    expect(summarizeAgentPlacement(placement())).toBe("This machine");
  });

  it("names the chosen machine for one machine", () => {
    expect(
      summarizeAgentPlacement(placement({ mode: "single", singleMachineId: "env-mini" })),
    ).toBe("One machine: Mac Mini");
  });

  it("reads a missing or unlinked choice as this machine", () => {
    expect(summarizeAgentPlacement(placement({ mode: "single" }))).toBe("This machine");
    expect(summarizeAgentPlacement(placement({ mode: "single", singleMachineId: "gone" }))).toBe(
      "This machine",
    );
  });

  it("counts machines Balance can pick", () => {
    expect(summarizeAgentPlacement(placement({ mode: "balanced" }))).toBe(
      "Balanced across 3 machines",
    );
    expect(
      summarizeAgentPlacement(
        placement({
          mode: "balanced",
          localPreference: 0,
          machines: {
            "env-mini": {
              label: "Mac Mini",
              baseUrl: "http://mini.tail.ts.net:3773",
              enabled: true,
              preference: 50,
            },
          },
        }),
      ),
    ).toBe("Balanced across 1 machine");
  });
});

describe("balancedAgentMachineCount", () => {
  it("skips switched-off and Manual only machines", () => {
    const settings = placement({
      localPreference: 0,
      machines: {
        a: { label: "A", baseUrl: "https://a", enabled: false, preference: 100 },
        b: { label: "B", baseUrl: "https://b", enabled: true, preference: 0 },
        c: { label: "C", baseUrl: "https://c", enabled: true, preference: 25 },
      },
    });
    expect(balancedAgentMachineCount(settings)).toBe(1);
  });
});

describe("machine options", () => {
  it("lists linked machines by label", () => {
    expect(linkedAgentMachines(placement()).map((machine) => machine.id)).toEqual([
      "env-box",
      "env-mini",
    ]);
  });

  it("offers this machine first for one machine", () => {
    expect(singleAgentMachineOptions(placement())).toEqual([
      { value: "local", label: "This machine" },
      { value: "env-box", label: "Build box" },
      { value: "env-mini", label: "Mac Mini" },
    ]);
  });

  it("selects this machine when the choice is gone", () => {
    expect(singleAgentMachineValue(placement({ singleMachineId: "env-box" }))).toBe("env-box");
    expect(singleAgentMachineValue(placement({ singleMachineId: "gone" }))).toBe("local");
    expect(singleAgentMachineValue(placement({ singleMachineId: null }))).toBe("local");
  });
});

describe("agentMachineStatusPresentation", () => {
  it("is muted before the first check", () => {
    expect(agentMachineStatusPresentation(undefined, NOW)).toEqual({
      label: "Not checked",
      tone: "muted",
    });
  });

  it("warns when a connected token expires within a week", () => {
    expect(
      agentMachineStatusPresentation(
        status({ tokenExpiresAt: new Date(NOW + 20 * DAY).toISOString() }),
        NOW,
      ),
    ).toEqual({ label: "Connected", tone: "success" });
    expect(
      agentMachineStatusPresentation(
        status({ tokenExpiresAt: new Date(NOW + 3 * DAY + 60_000).toISOString() }),
        NOW,
      ),
    ).toEqual({ label: "Connected, token expires in 3 days", tone: "warning" });
  });

  it("shows the expiry on a machine that needs re-linking", () => {
    expect(
      agentMachineStatusPresentation(
        status({
          status: "needs-relink",
          tokenExpiresAt: new Date(NOW - 2 * DAY - 60_000).toISOString(),
        }),
        NOW,
      ),
    ).toEqual({ label: "Needs re-link (token expired 2 days ago)", tone: "destructive" });
    expect(agentMachineStatusPresentation(status({ status: "needs-relink" }), NOW).label).toBe(
      "Needs re-link",
    );
  });

  it("labels the remaining kinds", () => {
    expect(agentMachineStatusPresentation(status({ status: "offline" }), NOW)).toEqual({
      label: "Offline",
      tone: "muted",
    });
    expect(agentMachineStatusPresentation(status({ status: "incompatible" }), NOW).label).toBe(
      "Incompatible version",
    );
    expect(agentMachineStatusPresentation(status({ status: "wrong-environment" }), NOW).label).toBe(
      "Wrong environment",
    );
  });
});

describe("tokenExpiryText", () => {
  it("handles today, one day and bad dates", () => {
    expect(tokenExpiryText(new Date(NOW + 60_000).toISOString(), NOW)).toBe("token expires today");
    expect(tokenExpiryText(new Date(NOW + DAY + 60_000).toISOString(), NOW)).toBe(
      "token expires in 1 day",
    );
    expect(tokenExpiryText("not a date", NOW)).toBeNull();
    expect(tokenExpiryText(undefined, NOW)).toBeNull();
  });
});

describe("projectMatchText", () => {
  it("counts matching Projects", () => {
    expect(projectMatchText(status())).toBe("Matches 3 of 4 Projects");
    expect(projectMatchText(status({ matchedProjectCount: 0, projectCount: 1 }))).toBe(
      "Matches 0 of 1 Project",
    );
  });

  it("is empty with nothing to match", () => {
    expect(projectMatchText(status({ projectCount: 0, matchedProjectCount: 0 }))).toBeNull();
    expect(projectMatchText(undefined)).toBeNull();
  });
});

describe("agentMachineEntryPatch", () => {
  it("sends the whole entry with the change applied", () => {
    expect(agentMachineEntryPatch(placement(), "env-mini", { enabled: false })).toEqual({
      machines: {
        "env-mini": {
          label: "Mac Mini",
          baseUrl: "http://mini.tail.ts.net:3773",
          enabled: false,
          preference: 50,
        },
      },
    });
    expect(agentMachineEntryPatch(placement(), "env-box", { preference: 0 })).toEqual({
      machines: {
        "env-box": {
          label: "Build box",
          baseUrl: "https://box.example.com",
          enabled: true,
          preference: 0,
        },
      },
    });
  });

  it("never writes back an unlinked machine", () => {
    expect(agentMachineEntryPatch(placement(), "gone", { enabled: true })).toBeNull();
  });
});

describe("agentMachineLinkInput", () => {
  it("trims the link and drops a blank address", () => {
    expect(agentMachineLinkInput("  https://mini/pair#token=abc ", "  ")).toEqual({
      action: "link",
      pairingUrl: "https://mini/pair#token=abc",
    });
    expect(agentMachineLinkInput("https://mini/pair", " http://100.64.0.2:3773 ")).toEqual({
      action: "link",
      pairingUrl: "https://mini/pair",
      baseUrl: "http://100.64.0.2:3773",
    });
  });
});

describe("agentMachinesErrorMessage", () => {
  it("prefers the server's detail", () => {
    expect(agentMachinesErrorMessage(new AgentMachinesError({ detail: "Link expired" }))).toBe(
      "Link expired",
    );
    expect(agentMachinesErrorMessage(new Error("socket closed"))).toBe("socket closed");
    expect(agentMachinesErrorMessage({ message: "Forbidden" })).toBe("Forbidden");
    expect(agentMachinesErrorMessage(null)).toMatch(/did not answer/);
  });
});
