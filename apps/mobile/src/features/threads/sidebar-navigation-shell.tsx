import {
  NavigationContainer,
  NavigationIndependentTree,
  useNavigation,
  type NavigationProp,
  type NavigationState,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { createContext, use, type ReactNode } from "react";
import { Platform } from "react-native";

import { getCompactBrandHeaderOptions } from "../../components/CompactBrandTitle";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

const SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type SidebarScreenOptions = NativeStackNavigationOptions & {
  // Same patched RNS option the GLASS/SOLID presets in Stack.tsx use — the
  // iOS 26 "editor" navigation-item style leading-aligns the inline title.
  readonly unstable_navigationItemStyle?: "editor";
};

/**
 * Static chrome for the sidebar column: a real UINavigationBar with a fixed
 * inline title (no large title — saves vertical space, left-aligned via the
 * editor item style) and the search bar pinned below it, scroll-edge blur
 * sampling the list. Only genuinely dynamic values (search callbacks, header
 * items) are set by the screen content via NativeStackScreenOptions.
 */
const SIDEBAR_SCREEN_OPTIONS: SidebarScreenOptions = {
  contentStyle: { backgroundColor: "transparent" },
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? { backgroundColor: "transparent" } : undefined,
  ...getCompactBrandHeaderOptions({ fontSize: 17, fontWeight: "400" }),
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};

const SidebarStack = createNativeStackNavigator();

// `useNavigation()`'s default type: the root container's getState can be undefined.
type AppNavigation = Omit<NavigationProp<ReactNavigation.RootParamList>, "getState"> & {
  getState(): NavigationState | undefined;
};

const AppNavigationContext = createContext<AppNavigation | null>(null);

/**
 * `useNavigation()` for hooks that navigate from rows the sidebar pane also
 * renders (e.g. useProjectActions). Inside the shell's independent tree
 * `useNavigation()` is the inert sidebar stack, which handles no app routes;
 * this returns the app navigation the shell was mounted under instead.
 */
export function useAppNavigation(): AppNavigation {
  const navigation = useNavigation<AppNavigation>();
  return use(AppNavigationContext) ?? navigation;
}

/**
 * Hosts the iPad sidebar pane inside its own single-screen native stack.
 *
 * The stack is navigation-inert — nothing is ever pushed onto it. It exists so
 * the sidebar column owns a real UINavigationBar (large title, native bar
 * button items, UISearchController), mirroring how each column of a
 * UISplitViewController has its own UINavigationController. All real
 * navigation still flows through the root stack, via callbacks minted in
 * AdaptiveWorkspaceLayout or `useAppNavigation`; NavigationIndependentTree
 * only isolates the navigation hooks used for header configuration inside
 * the pane.
 */
export function SidebarNavigationShell(props: { readonly children: ReactNode }) {
  const navigationTheme = useMobileNavigationTheme();
  // Read outside the independent tree: the root stack's navigation.
  const appNavigation = useNavigation<AppNavigation>();

  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={navigationTheme}>
        <SidebarStack.Navigator
          screenOptions={SIDEBAR_SCREEN_OPTIONS}
          initialRouteName="SidebarThreads"
        >
          <SidebarStack.Screen name="SidebarThreads">
            {() => (
              <AppNavigationContext value={appNavigation}>{props.children}</AppNavigationContext>
            )}
          </SidebarStack.Screen>
        </SidebarStack.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}
