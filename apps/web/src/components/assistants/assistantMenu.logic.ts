import type { ContextMenuItem } from "@t3tools/contracts";

export type AssistantProjectMenuAction =
  | "rename"
  | "settings"
  | "open-folder"
  | "archive"
  | "move-to-tasks"
  | "delete";

/**
 * The Project menu (row, coordinator crumb). Open folder needs a file manager
 * on the Project's host, as in the file context menu.
 */
export function buildAssistantProjectMenuItems(input: {
  readonly canOpenFolder: boolean;
}): ReadonlyArray<ContextMenuItem<AssistantProjectMenuAction>> {
  return [
    { id: "rename", label: "Rename", icon: "pencil" },
    { id: "settings", label: "Settings", icon: "settings" },
    ...(input.canOpenFolder
      ? [{ id: "open-folder" as const, label: "Open folder", icon: "folder" }]
      : []),
    { id: "archive", label: "Archive", icon: "archive", separatorBefore: true },
    { id: "move-to-tasks", label: "Move to Tasks", icon: "folder-tree" },
    { id: "delete", label: "Delete", icon: "trash", destructive: true, separatorBefore: true },
  ];
}

export function isAssistantProjectMenuAction(value: string): value is AssistantProjectMenuAction {
  return (
    value === "rename" ||
    value === "settings" ||
    value === "open-folder" ||
    value === "archive" ||
    value === "move-to-tasks" ||
    value === "delete"
  );
}
