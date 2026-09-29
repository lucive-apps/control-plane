import { describe, expect, it } from "vite-plus/test";

import { buildAssistantProjectMenuItems } from "./assistantMenu.logic";

describe("buildAssistantProjectMenuItems", () => {
  it("lists the Project actions in menu order, Delete last and destructive", () => {
    const items = buildAssistantProjectMenuItems({ canOpenFolder: true, canSchedule: true });
    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      "Settings",
      "Schedules",
      "Open folder",
      "Archive",
      "Move to Tasks",
      "Delete",
    ]);
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });

  it("drops Open folder when the host has no file manager", () => {
    const ids = buildAssistantProjectMenuItems({ canOpenFolder: false, canSchedule: true }).map(
      (item) => item.id,
    );
    expect(ids).not.toContain("open-folder");
    expect(ids).toHaveLength(6);
  });

  it("offers Schedules only when the Project's server stores them", () => {
    const ids = buildAssistantProjectMenuItems({ canOpenFolder: true, canSchedule: false }).map(
      (item) => item.id,
    );
    expect(ids).not.toContain("schedules");
    expect(ids).toHaveLength(6);
  });
});
