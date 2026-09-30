import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { create } from "zustand";
import { useEffect, useMemo } from "react";

import { useProjects } from "./state/entities";

// A drop shows at once: the keys we just wrote stand in for the project records' `orderKey`
// until the shell stream delivers them. A failed write drops its override immediately; a
// successful one is dropped once the server value matches, or after a grace period if another
// client's later write superseded it.
const OVERRIDE_GRACE_MS = 5_000;

const overrideKey = (environmentId: string, projectId: string) => `${environmentId}\0${projectId}`;

interface ProjectOrderOverrideStore {
  readonly overrides: Readonly<Record<string, string>>;
  readonly set: (entries: ReadonlyArray<readonly [string, string]>) => void;
  readonly clear: (keys: ReadonlyArray<string>) => void;
}

export const useProjectOrderOverrideStore = create<ProjectOrderOverrideStore>((set) => ({
  overrides: {},
  set: (entries) =>
    set((state) => ({ overrides: { ...state.overrides, ...Object.fromEntries(entries) } })),
  clear: (keys) =>
    set((state) => {
      if (!keys.some((key) => key in state.overrides)) return state;
      const overrides = { ...state.overrides };
      for (const key of keys) delete overrides[key];
      return { overrides };
    }),
}));

export function holdProjectOrder(
  writes: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
    readonly orderKey: string;
  }>,
): { readonly release: () => void; readonly releaseSoon: () => void } {
  const keys = writes.map((write) => overrideKey(write.environmentId, write.projectId));
  useProjectOrderOverrideStore
    .getState()
    .set(writes.map((write, index) => [keys[index]!, write.orderKey] as const));
  const release = () => useProjectOrderOverrideStore.getState().clear(keys);
  return { release, releaseSoon: () => void setTimeout(release, OVERRIDE_GRACE_MS) };
}

/** `useProjects()` with pending drops applied. Same array while nothing is pending. */
export function useProjectsWithOrderOverrides(): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  const overrides = useProjectOrderOverrideStore((state) => state.overrides);
  const clear = useProjectOrderOverrideStore((state) => state.clear);
  const hasOverrides = Object.keys(overrides).length > 0;

  useEffect(() => {
    if (!hasOverrides) return;
    const settled = projects.flatMap((project) => {
      const key = overrideKey(project.environmentId, project.id);
      return overrides[key] !== undefined && overrides[key] === project.orderKey ? [key] : [];
    });
    if (settled.length > 0) clear(settled);
  }, [clear, hasOverrides, overrides, projects]);

  return useMemo(() => {
    if (!hasOverrides) return projects;
    return projects.map((project) => {
      const orderKey = overrides[overrideKey(project.environmentId, project.id)];
      return orderKey === undefined ? project : { ...project, orderKey };
    });
  }, [hasOverrides, overrides, projects]);
}
