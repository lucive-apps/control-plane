/**
 * Workspace zoom scales the main pane (chat, settings, usage) while the
 * sidebar stays at 1×. Step size matches Electron's zoomIn/zoomOut roles
 * (`1.2 ** level`, half-level steps).
 */

import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";

export type WorkspaceZoomDirection = "in" | "out" | "reset";

export const WORKSPACE_ZOOM_STORAGE_KEY = "t3code:workspace-zoom-level";
export const WORKSPACE_ZOOM_STEP = 0.5;
export const WORKSPACE_ZOOM_MIN_LEVEL = -4;
export const WORKSPACE_ZOOM_MAX_LEVEL = 6;
export const WORKSPACE_ZOOM_WHEEL_THRESHOLD = 40;

export function clampWorkspaceZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  const stepped = Math.round(level / WORKSPACE_ZOOM_STEP) * WORKSPACE_ZOOM_STEP;
  return Math.min(WORKSPACE_ZOOM_MAX_LEVEL, Math.max(WORKSPACE_ZOOM_MIN_LEVEL, stepped));
}

export function stepWorkspaceZoomLevel(current: number, direction: WorkspaceZoomDirection): number {
  if (direction === "reset") return 0;
  return clampWorkspaceZoomLevel(
    current + (direction === "in" ? WORKSPACE_ZOOM_STEP : -WORKSPACE_ZOOM_STEP),
  );
}

export function workspaceZoomFactor(level: number): number {
  return 1.2 ** clampWorkspaceZoomLevel(level);
}

export function readStoredWorkspaceZoomLevel(): number {
  if (typeof window === "undefined") return 0;
  try {
    return clampWorkspaceZoomLevel(
      getLocalStorageItem(WORKSPACE_ZOOM_STORAGE_KEY, Schema.Finite) ?? 0,
    );
  } catch {
    return 0;
  }
}

function persistWorkspaceZoomLevel(level: number): void {
  try {
    if (level === 0) {
      removeLocalStorageItem(WORKSPACE_ZOOM_STORAGE_KEY);
      return;
    }
    setLocalStorageItem(WORKSPACE_ZOOM_STORAGE_KEY, level, Schema.Finite);
  } catch (error) {
    console.error("Could not persist workspace zoom.", error);
  }
}

interface WorkspaceZoomStore {
  level: number;
  apply: (direction: WorkspaceZoomDirection) => void;
}

export const useWorkspaceZoomStore = create<WorkspaceZoomStore>((set, get) => ({
  level: readStoredWorkspaceZoomLevel(),
  apply: (direction) => {
    const level = stepWorkspaceZoomLevel(get().level, direction);
    persistWorkspaceZoomLevel(level);
    set({ level });
  },
}));
