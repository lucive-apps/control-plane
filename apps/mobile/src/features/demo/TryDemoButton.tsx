import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { enterDemoMode } from "./demoMode";

export const TRY_DEMO_LABEL = "Try demo";
export const TRY_DEMO_DETAIL = "No computer? Explore the app with sample data.";

/**
 * The demo entry point on first-run screens. Starting the demo adds the
 * "Demo Mac" environment; `DemoModeFrame` then rebuilds navigation on Home,
 * which also closes the sheet this button may sit in.
 */
export function TryDemoButton(props: {
  /** `row` puts the explanation beside the button, for sheets with little height. */
  readonly layout?: "stack" | "row";
  readonly className?: string;
}) {
  const row = props.layout === "row";
  return (
    <View
      className={cn(
        row
          ? "flex-row items-center justify-between gap-3 rounded-[20px] bg-card px-4 py-3"
          : "items-center gap-2",
        props.className,
      )}
    >
      {row ? (
        <Text className="flex-1 text-sm leading-normal text-foreground-muted">
          {TRY_DEMO_DETAIL}
        </Text>
      ) : null}
      <Pressable
        accessibilityLabel={TRY_DEMO_LABEL}
        accessibilityHint="Opens the app with sample Projects, Tasks and threads"
        accessibilityRole="button"
        className="min-h-[44px] flex-row items-center justify-center gap-2 rounded-full border border-secondary-border bg-secondary px-5 py-3 active:opacity-70"
        onPress={() => enterDemoMode()}
        testID="try-demo-button"
      >
        <SymbolView
          name="play"
          size={15}
          tintColorClassName="accent-secondary-foreground"
          type="monochrome"
        />
        <Text className="text-sm font-t3-bold text-secondary-foreground">{TRY_DEMO_LABEL}</Text>
      </Pressable>
      {row ? null : (
        <Text className="text-center text-xs text-foreground-muted">{TRY_DEMO_DETAIL}</Text>
      )}
    </View>
  );
}
