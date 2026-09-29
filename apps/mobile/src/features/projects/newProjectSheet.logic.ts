import type { FolderResolution } from "@t3tools/client-runtime/state/assistant-flows";
import type { EnvironmentId } from "@t3tools/contracts";

// Fork-owned. The copy and gating of the New Project and Convert sheet
// (design A1 and A2). Same rules as the desktop dialog.

export type NewProjectSheetMode = "new" | "convert";
export type CoordinatorMode = "new" | "existing";

/** Environments a Project can be created on: connected ones that advertise Projects, by label. */
export function selectProjectEnvironments<
  E extends {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: string };
    readonly serverConfig: {
      readonly environment: { readonly capabilities: { readonly assistants?: boolean } };
    } | null;
  },
>(environments: readonly E[]): E[] {
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.assistants === true,
    )
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId),
    );
}

/** Convert from a Tasks folder starts on its most recent Local thread when one exists (A2). */
export function defaultCoordinatorMode(input: {
  readonly mode: NewProjectSheetMode;
  readonly candidateCount: number;
}): CoordinatorMode {
  return input.mode === "convert" && input.candidateCount > 0 ? "existing" : "new";
}

/** "N threads in this folder become agents (M pinned stay standing)." */
export function convertSummaryText(summary: {
  readonly agents: number;
  readonly standing: number;
}): string {
  const one = summary.agents === 1;
  return `${summary.agents} ${one ? "thread" : "threads"} in this folder ${
    one ? "becomes an agent" : "become agents"
  }${
    summary.standing > 0
      ? ` (${summary.standing} pinned ${summary.standing === 1 ? "stays" : "stay"} standing)`
      : ""
  }.`;
}

/**
 * What the sheet shows and whether it can submit. Folder problems show under
 * the folder; anything else shows under the form. An empty name blocks
 * silently, like the desktop dialog.
 */
export function resolveNewProjectStatus(input: {
  readonly environmentReady: boolean;
  readonly name: string;
  readonly folder: FolderResolution;
  /** The Project already at the resolved folder, if any. */
  readonly existingProjectTitle: string | null;
  readonly hasModel: boolean;
  readonly isSubmitting: boolean;
}): {
  readonly folderMessage: string | null;
  readonly formMessage: string | null;
  readonly canSubmit: boolean;
} {
  const folderMessage =
    input.folder.kind === "error"
      ? input.folder.message
      : input.existingProjectTitle !== null
        ? `This folder is already the Project "${input.existingProjectTitle}".`
        : null;
  const formMessage = !input.environmentReady
    ? "Connect an environment that supports Projects."
    : input.name.trim().length === 0 || folderMessage !== null || input.hasModel
      ? null
      : "No providers are available on this environment.";
  return {
    folderMessage,
    formMessage,
    canSubmit:
      !input.isSubmitting &&
      input.name.trim().length > 0 &&
      input.folder.kind === "ok" &&
      folderMessage === null &&
      formMessage === null,
  };
}
