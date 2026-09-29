import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useMemo } from "react";
import { Platform } from "react-native";

import { BrandJet } from "../../components/BrandJet";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import {
  createClearFilterHeaderItem,
  createHomeListHeaderItems,
} from "../threads/sidebar-native-header-items";
import { MaterialThreadListToolbar } from "./MaterialThreadListToolbar";
import {
  buildHomeListFilterMenu,
  type HomeListFilterMenuEnvironment,
  type HomeListFilterMenuProject,
} from "./home-list-filter-menu";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  /** Adds View Settled to the iOS overflow menu. */
  readonly onOpenSettled?: () => void;
  readonly onStartNewTask: () => void;
  readonly onStartSearch: () => void;
  readonly searchOpen?: boolean;
  /** Set while the Environment or Workspace filter is active; clears both. */
  readonly onClearFilter?: () => void;
  /** Header title while filtered: the workspace, else the environment. */
  readonly filterTitle?: string;
}) {
  if (Platform.OS === "android") {
    return <AndroidHomeHeader {...props} />;
  }

  return <IosHomeHeader {...props} />;
}

type HomeHeaderProps = Parameters<typeof HomeHeader>[0];

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

function AndroidHomeHeader(props: HomeHeaderProps) {
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: checkedMenuState(props.selectedEnvironmentId === null),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
          })),
        ],
      },
      ...(props.projects.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Workspace",
              subactions: [
                {
                  id: "project:all",
                  title: "All workspaces",
                  state: checkedMenuState(props.selectedProjectKey === null),
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: checkedMenuState(props.selectedProjectKey === project.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [props.environments, props.projects, props.selectedEnvironmentId, props.selectedProjectKey],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }

      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }

      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
        }
        return;
      }
    },
    [props],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <MaterialThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenSettings={props.onOpenSettings}
        onOpenEnvironments={props.onOpenEnvironments}
        onBack={props.onClearFilter}
      />
    </>
  );
}

function IosHomeHeader(props: HomeHeaderProps) {
  const iconColor = useUniwindTheme()["--color-icon"];
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const focusSearch = useCallback(() => {
    props.onStartSearch();
    return true;
  }, [props]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu(props);

  const backTitle = props.filterTitle ?? "";
  const showBack = props.onClearFilter !== undefined;
  const searchOpen = props.searchOpen === true;

  return (
    <NativeStackScreenOptions
      optionsVersion={[filterMenu.items, showBack, backTitle, searchOpen]}
      options={{
        headerShown: !searchOpen,
        headerTintColor: iconColor,
        headerBackVisible: false,
        headerTitle: showBack && backTitle.length > 0 ? backTitle : () => null,
        title: showBack ? backTitle : "",
        unstable_headerLeftItems: () =>
          showBack && props.onClearFilter
            ? [createClearFilterHeaderItem({ onPress: props.onClearFilter })]
            : [
                {
                  type: "custom",
                  element: <BrandJet size={28} />,
                  hidesSharedBackground: true,
                },
              ],
        unstable_headerRightItems: () =>
          createHomeListHeaderItems({
            filterIcon: hasCustomListOptions
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease",
            filterMenu,
            onFocusSearch: props.onStartSearch,
            onOpenSettings: props.onOpenSettings,
            ...(props.onOpenSettled ? { onOpenSettled: props.onOpenSettled } : {}),
          }),
      }}
    />
  );
}
