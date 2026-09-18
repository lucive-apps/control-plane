import { describe, expect, it } from "vite-plus/test";

import {
  clampWorkspaceZoomLevel,
  stepWorkspaceZoomLevel,
  WORKSPACE_ZOOM_MAX_LEVEL,
  WORKSPACE_ZOOM_MIN_LEVEL,
  workspaceZoomFactor,
} from "./workspaceZoom";

describe("clampWorkspaceZoomLevel", () => {
  it("snaps to half-level steps and rejects non-finite values", () => {
    expect(clampWorkspaceZoomLevel(0.4)).toBe(0.5);
    expect(clampWorkspaceZoomLevel(Number.NaN)).toBe(0);
  });
});

describe("stepWorkspaceZoomLevel", () => {
  it("steps in and out by half a Chromium zoom level", () => {
    expect(stepWorkspaceZoomLevel(0, "in")).toBe(0.5);
    expect(stepWorkspaceZoomLevel(0.5, "out")).toBe(0);
    expect(stepWorkspaceZoomLevel(2, "reset")).toBe(0);
  });

  it("clamps to the allowed range", () => {
    expect(stepWorkspaceZoomLevel(WORKSPACE_ZOOM_MAX_LEVEL, "in")).toBe(WORKSPACE_ZOOM_MAX_LEVEL);
    expect(stepWorkspaceZoomLevel(WORKSPACE_ZOOM_MIN_LEVEL, "out")).toBe(WORKSPACE_ZOOM_MIN_LEVEL);
  });
});

describe("workspaceZoomFactor", () => {
  it("matches Electron's 1.2 ** level scale", () => {
    expect(workspaceZoomFactor(0)).toBe(1);
    expect(workspaceZoomFactor(1)).toBeCloseTo(1.2);
    expect(workspaceZoomFactor(0.5)).toBeCloseTo(Math.sqrt(1.2));
  });
});
