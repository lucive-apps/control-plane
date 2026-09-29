import { describe, expect, it } from "vite-plus/test";

import { buildAssistantProjectMenuItems } from "./assistantMenu.logic";

describe("buildAssistantProjectMenuItems", () => {
  it("lists the Project actions in menu order, Delete last and destructive", () => {
    const items = buildAssistantProjectMenuItems({ canOpenFolder: true });
    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      "Settings",
      "Open folder",
      "Archive",
      "Move to Tasks",
      "Delete",
    ]);
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });

  it("drops Open folder when the host has no file manager", () => {
    const ids = buildAssistantProjectMenuItems({ canOpenFolder: false }).map((item) => item.id);
    expect(ids).not.toContain("open-folder");
    expect(ids).toHaveLength(5);
  });
});
