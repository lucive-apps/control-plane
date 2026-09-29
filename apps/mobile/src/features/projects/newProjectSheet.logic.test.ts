import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  convertSummaryText,
  defaultCoordinatorMode,
  resolveNewProjectStatus,
  selectProjectEnvironments,
} from "./newProjectSheet.logic";

const ready = {
  environmentReady: true,
  name: "Personal",
  folder: { kind: "ok", path: "/Users/n/Projects/personal", hasAgentsFile: false },
  existingProjectTitle: null,
  hasModel: true,
  isSubmitting: false,
} as const;

describe("resolveNewProjectStatus", () => {
  it("submits once the name, folder and model are all resolved", () => {
    expect(resolveNewProjectStatus(ready)).toEqual({
      folderMessage: null,
      formMessage: null,
      canSubmit: true,
    });
    expect(resolveNewProjectStatus({ ...ready, isSubmitting: true }).canSubmit).toBe(false);
    expect(resolveNewProjectStatus({ ...ready, folder: { kind: "pending" } }).canSubmit).toBe(
      false,
    );
  });

  it("blocks an empty name without a message", () => {
    expect(resolveNewProjectStatus({ ...ready, name: "  ", hasModel: false })).toEqual({
      folderMessage: null,
      formMessage: null,
      canSubmit: false,
    });
  });

  it("shows folder problems under the folder, not under the form", () => {
    expect(
      resolveNewProjectStatus({
        ...ready,
        folder: { kind: "error", message: "Folder not found." },
        hasModel: false,
      }),
    ).toEqual({ folderMessage: "Folder not found.", formMessage: null, canSubmit: false });
    expect(resolveNewProjectStatus({ ...ready, existingProjectTitle: "Work" })).toEqual({
      folderMessage: 'This folder is already the Project "Work".',
      formMessage: null,
      canSubmit: false,
    });
  });

  it("asks for a Projects environment first, then for a provider", () => {
    expect(
      resolveNewProjectStatus({ ...ready, environmentReady: false, name: "" }).formMessage,
    ).toBe("Connect an environment that supports Projects.");
    expect(resolveNewProjectStatus({ ...ready, hasModel: false })).toMatchObject({
      formMessage: "No providers are available on this environment.",
      canSubmit: false,
    });
  });
});

describe("defaultCoordinatorMode", () => {
  it("starts Convert on an existing thread when the folder has a Local one", () => {
    expect(defaultCoordinatorMode({ mode: "convert", candidateCount: 2 })).toBe("existing");
    expect(defaultCoordinatorMode({ mode: "convert", candidateCount: 0 })).toBe("new");
    // New Project on an existing folder keeps the desktop default.
    expect(defaultCoordinatorMode({ mode: "new", candidateCount: 2 })).toBe("new");
  });
});

describe("convertSummaryText", () => {
  it("counts the agents and the pinned ones that stay standing", () => {
    expect(convertSummaryText({ agents: 12, standing: 2 })).toBe(
      "12 threads in this folder become agents (2 pinned stay standing).",
    );
    expect(convertSummaryText({ agents: 3, standing: 1 })).toBe(
      "3 threads in this folder become agents (1 pinned stays standing).",
    );
    expect(convertSummaryText({ agents: 1, standing: 0 })).toBe(
      "1 thread in this folder becomes an agent.",
    );
    expect(convertSummaryText({ agents: 0, standing: 0 })).toBe(
      "0 threads in this folder become agents.",
    );
  });
});

describe("selectProjectEnvironments", () => {
  const environment = (id: string, label: string, phase: string, assistants: boolean) => ({
    environmentId: EnvironmentId.make(id),
    label,
    connection: { phase },
    serverConfig: { environment: { capabilities: { assistants } } },
  });

  it("keeps connected environments that support Projects, by label", () => {
    const selected = selectProjectEnvironments([
      environment("mini", "Mac mini", "connected", true),
      environment("old", "Old host", "connected", false),
      environment("away", "Laptop", "reconnecting", true),
      environment("mac", "MacBook", "connected", true),
      { ...environment("new", "Fresh", "connected", true), serverConfig: null },
    ]);
    expect(selected.map((entry) => entry.environmentId)).toEqual(["mini", "mac"]);
  });
});
