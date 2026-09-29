import type { MenuAction } from "@react-native-menu/menu";
import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";

// Fork-owned. The grouped-row pieces the Project sheets and Project settings
// share: a value row that opens a native menu, its value text, and the muted
// note under a section.

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function Footnote(props: { readonly children: ReactNode }) {
  return <Text className="-mt-1 px-2 text-sm text-foreground-muted">{props.children}</Text>;
}

/** A grouped row whose trailing content is its value, opening a native menu on tap. */
export function MenuRow(props: {
  readonly icon: SymbolName;
  readonly label: string;
  /** The menu's title, and the row's name for screen readers unless `accessibilityLabel` is set. */
  readonly title: string;
  readonly accessibilityLabel?: string;
  readonly actions: MenuAction[];
  readonly disabled?: boolean;
  readonly onPressAction: (id: string) => void;
  readonly trailing: ReactNode;
}) {
  const accessibilityLabel = props.accessibilityLabel ?? props.title;
  const row = (
    <View className="flex-row items-center gap-4 p-4 android:min-h-14 android:py-3">
      <SymbolView
        name={props.icon}
        size={Platform.OS === "android" ? 24 : 22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="shrink-0 text-lg text-foreground android:text-base" numberOfLines={1}>
        {props.label}
      </Text>
      <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
        {props.trailing}
      </View>
      {props.disabled ? null : (
        <SymbolView
          name="chevron.up.chevron.down"
          size={13}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      )}
    </View>
  );
  if (props.disabled) return row;
  return (
    <ControlPillMenu
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      actions={props.actions}
      isAnchoredToRight
      title={props.title}
      onPressAction={({ nativeEvent }) => props.onPressAction(nativeEvent.event)}
    >
      <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button">
        {row}
      </Pressable>
    </ControlPillMenu>
  );
}

export function ValueText(props: { readonly children: ReactNode }) {
  return (
    <Text className="max-w-[200px] text-right text-base text-foreground-muted" numberOfLines={1}>
      {props.children}
    </Text>
  );
}
