import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import type { ReactElement } from "react";

import { NativeHeaderToolbar } from "../../native/StackHeader";

// Fork-owned. iOS without Liquid Glass draws the compact thread header from
// ThreadGitControls' toolbar, which owns the right-hand items, so the Project
// items ride along as toolbar children there.

function symbolName(icon: Extract<NativeStackHeaderItem, { type: "button" }>["icon"]) {
  return icon?.type === "sfSymbol" ? icon.name : undefined;
}

/** The Project header items as `NativeHeaderToolbar` children. */
export function assistantHeaderToolbarItems(
  items: ReadonlyArray<NativeStackHeaderItem>,
): ReactElement[] {
  return items.flatMap((item, index) => {
    const key = ("identifier" in item ? item.identifier : undefined) ?? String(index);
    if (item.type === "button") {
      return [
        <NativeHeaderToolbar.Button
          key={key}
          accessibilityLabel={item.accessibilityLabel}
          icon={symbolName(item.icon)}
          onPress={item.onPress}
          separateBackground
        />,
      ];
    }
    if (item.type === "menu") {
      return [
        <NativeHeaderToolbar.Menu
          key={key}
          accessibilityLabel={item.accessibilityLabel}
          icon={symbolName(item.icon)}
          separateBackground
        >
          {item.menu.items.flatMap((entry) =>
            entry.type === "action"
              ? [
                  <NativeHeaderToolbar.MenuAction
                    key={entry.label}
                    destructive={entry.destructive}
                    icon={symbolName(entry.icon)}
                    onPress={entry.onPress}
                  >
                    <NativeHeaderToolbar.Label>{entry.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>,
                ]
              : [],
          )}
        </NativeHeaderToolbar.Menu>,
      ];
    }
    return [];
  });
}
