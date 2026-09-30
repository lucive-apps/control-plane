import { createNavigationContainerRef } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Alert, Pressable, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { exitDemoMode, useDemoModeActive } from "./demoMode";

export const appNavigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

export const DEMO_BANNER_TITLE = "Demo";
export const DEMO_BANNER_DETAIL = "Sample data";
export const EXIT_DEMO_LABEL = "Exit demo";

function openConnectFlow() {
  if (!appNavigationRef.isReady()) return;
  appNavigationRef.navigate("SettingsSheet", {
    screen: "SettingsContent",
    params: { screen: "SettingsEnvironmentNew" },
  });
}

// Long enough for the rebuilt navigation tree to mount.
const REMOUNT_MS = 600;

function leaveDemoForConnectFlow() {
  exitDemoMode();
  setTimeout(openConnectFlow, REMOUNT_MS);
}

export function confirmExitDemoMode() {
  Alert.alert(
    "Exit demo?",
    "The sample data is removed from this device. Next, you can pair Control Plane on your computer.",
    [
      { text: "Stay in demo", style: "cancel" },
      {
        text: EXIT_DEMO_LABEL,
        style: "destructive",
        onPress: leaveDemoForConnectFlow,
      },
    ],
  );
}

function DemoModeBanner() {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="summary"
      className="border-b border-warning-border bg-warning"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
      testID="demo-mode-banner"
    >
      <View className="min-h-[36px] flex-row items-center justify-between gap-3 px-4 py-1">
        <View className="flex-1 flex-row items-center gap-2">
          <View className="rounded-full bg-warning-foreground px-2 py-0.5">
            <Text className="text-[11px] font-t3-bold uppercase text-warning">
              {DEMO_BANNER_TITLE}
            </Text>
          </View>
          <Text className="flex-1 text-xs text-warning-foreground" numberOfLines={1}>
            {DEMO_BANNER_DETAIL}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={EXIT_DEMO_LABEL}
          accessibilityRole="button"
          className="min-h-[32px] justify-center rounded-full px-3 active:opacity-60"
          hitSlop={8}
          onPress={confirmExitDemoMode}
          testID="exit-demo-button"
        >
          <Text className="text-xs font-t3-bold text-warning-foreground">{EXIT_DEMO_LABEL}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Hosts the app below a persistent demo banner while demo mode is on. The
 * nested safe-area provider measures from below the banner, so screens and
 * native headers lay out as if the banner were the top of the screen.
 *
 * Entering or leaving demo mode remounts navigation (the `key`). That starts
 * both sides on Home, never leaves a demo screen open without its data, and
 * gives UIKit a fresh hierarchy: resizing the frame under a sheet that is
 * being dismissed in code leaves the presenting view stuck in its shrunken
 * card state on iOS 26 and later.
 */
export function DemoModeFrame(props: { readonly children: ReactNode }) {
  const active = useDemoModeActive();
  return (
    <View style={{ flex: 1 }}>
      {active ? <DemoModeBanner /> : null}
      <SafeAreaProvider key={active ? "demo" : "live"} style={{ flex: 1 }}>
        {props.children}
      </SafeAreaProvider>
    </View>
  );
}
