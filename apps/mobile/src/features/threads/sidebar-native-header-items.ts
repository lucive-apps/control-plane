import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: HomeListFilterMenu["items"]): NativeHeaderMenuItems {
  return items.map((item) =>
    item.type === "action"
      ? {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.state === "on" ? ("on" as const) : undefined,
        }
      : {
          type: "submenu" as const,
          label: item.title,
          items: toNativeHeaderMenuItems(item.items),
        },
  );
}

/**
 * Right-side UINavigationBar items for the sidebar column: the thread list
 * filter/sort menu plus the settings button, sharing one glass capsule —
 * the Messages-style grouped header buttons.
 */
export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "menu",
      label: "",
      accessibilityLabel: "Filter and sort threads",
      icon: sfSymbolIcon(input.filterIcon),
      menu: {
        title: input.filterMenu.title,
        items: toNativeHeaderMenuItems(input.filterMenu.items),
      },
    }),
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
  ];
}

/** Top-left Inbox back control for Working, Needs Attention, and project lists. */
export function createHomeInboxBackHeaderItem(input: {
  readonly onPress: () => void;
}): NativeStackHeaderItem {
  return withNativeGlassHeaderItem({
    type: "button",
    label: "",
    accessibilityLabel: "Back to Inbox",
    icon: sfSymbolIcon("chevron.left"),
    onPress: input.onPress,
  });
}

/** Home: search on the left, overflow menu (filter + settings) on the right. */
export function createHomeListHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onFocusSearch: () => void;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "menu",
      label: "",
      accessibilityLabel: "More",
      icon: sfSymbolIcon(
        input.filterIcon === "line.3.horizontal.decrease.circle.fill"
          ? "ellipsis.circle.fill"
          : "ellipsis",
      ),
      menu: {
        title: "",
        items: [
          ...toNativeHeaderMenuItems(input.filterMenu.items),
          {
            type: "action",
            label: "Settings",
            onPress: input.onOpenSettings,
          },
        ],
      },
    }),
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Search threads",
      icon: sfSymbolIcon("magnifyingglass"),
      onPress: input.onFocusSearch,
    }),
  ];
}
