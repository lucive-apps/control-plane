import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

export type AssistantDialogRequest =
  | { readonly kind: "new"; readonly environmentId?: EnvironmentId }
  | { readonly kind: "convert"; readonly projectRef: ScopedProjectRef }
  | { readonly kind: "delete"; readonly projectRef: ScopedProjectRef };

interface AssistantDialogState {
  readonly request: AssistantDialogRequest | null;
  readonly openNewProject: (environmentId?: EnvironmentId) => void;
  readonly openConvert: (projectRef: ScopedProjectRef) => void;
  readonly openDelete: (projectRef: ScopedProjectRef) => void;
  readonly close: () => void;
}

/** The one open Project dialog. `AssistantDialogsHost` renders it. */
export const useAssistantDialogStore = create<AssistantDialogState>((set) => ({
  request: null,
  openNewProject: (environmentId) =>
    set({ request: environmentId ? { kind: "new", environmentId } : { kind: "new" } }),
  openConvert: (projectRef) => set({ request: { kind: "convert", projectRef } }),
  openDelete: (projectRef) => set({ request: { kind: "delete", projectRef } }),
  close: () => set({ request: null }),
}));

export const openNewProject = (environmentId?: EnvironmentId) =>
  useAssistantDialogStore.getState().openNewProject(environmentId);
export const openConvertToProject = (projectRef: ScopedProjectRef) =>
  useAssistantDialogStore.getState().openConvert(projectRef);
export const openDeleteProject = (projectRef: ScopedProjectRef) =>
  useAssistantDialogStore.getState().openDelete(projectRef);
