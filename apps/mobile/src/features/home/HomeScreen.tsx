import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import { AppText as Text } from "../../components/AppText";
import { AppTextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { HomeComposerBar } from "./HomeComposerBar";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useThreadSearch } from "../../state/queries";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { HomeSectionList } from "./HomeSectionList";
import type { HomeProjectSortOrder } from "./homeThreadList";
import { useHomeSections } from "./useHomeSections";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly searchOpen: boolean;
  readonly onCloseSearch: () => void;
  readonly selectedEnvironmentId: EnvironmentId | null;
  /** Workspace filter: a Tasks folder's scope key. */
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onAddConnection: () => void;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onNewAgent: (project: EnvironmentProject) => void;
  readonly onAddWorkspace: () => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;

/**
 * The full-page state shown until a shell snapshot arrives. Once one does,
 * the sections render, and an empty environment shows their in-list rows.
 */
function deriveEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load workspaces and start coding sessions.",
      loading: false,
    };
  }

  if (
    catalogState.connectionState === "available" ||
    catalogState.connectionState === "offline" ||
    catalogState.connectionState === "error" ||
    catalogState.connectionState === "unsupported"
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  return {
    title: "Connecting to environment",
    detail: "Loading workspaces and threads from the saved environment.",
    loading: true,
  };
}

/**
 * Top spacing between the list and the Android custom header. The Android
 * header (AndroidHomeHeader) is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */
function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const iosBottomToolbarClearance =
    Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED
      ? PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT
      : 0;
  const searchEnvironmentIds = useMemo(
    () =>
      props.selectedEnvironmentId === null
        ? props.environments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : props.environments.some(
              (environment) =>
                environment.environmentId === props.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [props.selectedEnvironmentId]
          : [],
    [props.environments, props.selectedEnvironmentId],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const hasSearchQuery = props.searchQuery.trim().length > 0;

  // The queued-start and snooze helpers need a clock while the list stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useFocusEffect(
    useCallback(() => {
      // Refresh immediately on focus because the previous value can be hours old.
      setNowMinute(new Date().toISOString().slice(0, 16));
      const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
      return () => clearInterval(id);
    }, []),
  );

  const model = useHomeSections({
    projects: props.projects,
    threads: props.threads,
    pendingTasks: props.pendingTasks,
    environmentId: props.selectedEnvironmentId,
    workspaceKey: props.selectedProjectKey,
    searchQuery: props.searchQuery,
    matchedThreadKeys,
    // Phones navigate away on select, so nothing stays selected here.
    selectedThreadKey: null,
    projectGroupingMode: props.projectGroupingMode,
    projectSortOrder: props.projectSortOrder,
    nowMinute,
  });
  const { items, workspaceScope } = model.sections;
  useThreadJumpShortcuts(model.sections.jumpThreads, props.onSelectThread);

  const hasSavedEnvironment =
    props.catalogState.hasConnections || Object.keys(props.savedConnectionsById).length > 0;
  const showComposer = hasSavedEnvironment || props.catalogState.hasReadyEnvironment;
  const lockedProject = workspaceScope?.representative ?? null;

  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle), so reconnects never shift the rows.
  if (!props.catalogState.hasLoadedShellSnapshot) {
    const emptyState = deriveEmptyState(props.catalogState);
    return (
      <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
        {props.searchOpen ? (
          <HomeSearchField
            query={props.searchQuery}
            onChange={props.onSearchQueryChange}
            onClose={props.onCloseSearch}
          />
        ) : null}
        <View
          className={cn(
            "flex-1 items-center justify-center bg-screen px-8",
            Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
          )}
          style={{
            paddingBottom: Math.max(insets.bottom, 24) + (showComposer ? 88 : 0),
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
          }}
        >
          <View className="w-full max-w-[430px]">
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
              onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
              action={
                Platform.OS === "android" && !props.catalogState.hasReadyEnvironment ? (
                  <MaterialFloatingActionButton
                    label="Add environment"
                    icon="plus"
                    variant="extended"
                    tone="primary"
                    onPress={props.onAddConnection}
                  />
                ) : undefined
              }
              variant="plain"
            />
            {emptyState.loading ? (
              <View className="mt-4 items-center">
                <ActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </View>
        {showComposer ? <HomeComposerBar lockedProject={lockedProject} /> : null}
      </View>
    );
  }

  // Both sections always render with the shell loaded, so the list is only
  // empty when a search matches nothing.
  const listEmpty =
    hasSearchQuery && threadSearch.isPending ? null : (
      <CenteredListEmpty
        title="No results"
        detail={`No threads matching "${props.searchQuery}".`}
      />
    );

  if (Platform.OS === "android" && items.length === 0) {
    return (
      <View className="flex-1 bg-header">
        <View
          className="flex-1 items-center justify-center overflow-hidden rounded-t-[28px] bg-screen px-4"
          style={{ paddingBottom: insets.bottom }}
        >
          {listEmpty}
        </View>
      </View>
    );
  }

  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      {props.searchOpen ? (
        <HomeSearchField
          query={props.searchQuery}
          onChange={props.onSearchQueryChange}
          onClose={props.onCloseSearch}
        />
      ) : null}
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
            : "flex-1 bg-screen"
        }
      >
        <HomeSectionList
          pane="screen"
          model={model}
          searchQuery={props.searchQuery}
          threadSearchMatchByKey={threadSearchMatchByKey}
          savedConnectionsById={props.savedConnectionsById}
          nowMinute={nowMinute}
          selectedThreadKey={null}
          onSelectThread={props.onSelectThread}
          onNewThreadInProject={props.onNewThreadInProject}
          onNewAgent={props.onNewAgent}
          onNewThreadOnBranch={props.onNewThreadOnBranch}
          onAddWorkspace={props.onAddWorkspace}
          ListHeaderComponent={Platform.OS === "ios" ? null : <HomeTopContentSpacer />}
          ListEmptyComponent={listEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          contentContainerStyle={{
            flexGrow: items.length === 0 ? 1 : undefined,
            justifyContent: items.length === 0 ? "center" : undefined,
            paddingBottom:
              items.length === 0
                ? showComposer
                  ? 88
                  : Math.max(insets.bottom, 24)
                : Platform.OS === "ios"
                  ? Math.max(insets.bottom, 24) + 96 + iosBottomToolbarClearance
                  : Math.max(insets.bottom, 16) + (Platform.OS === "android" ? 148 : 88),
          }}
        />
      </View>
      {showComposer ? <HomeComposerBar lockedProject={lockedProject} /> : null}
    </View>
  );
}

function CenteredListEmpty(props: { readonly title: string; readonly detail?: string }) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <EmptyState title={props.title} detail={props.detail ?? ""} variant="plain" />
    </View>
  );
}

function HomeSearchField(props: {
  readonly query: string;
  readonly onChange: (query: string) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-row items-center gap-3 px-4 pb-2" style={{ paddingTop: insets.top + 8 }}>
      <AppTextInput
        autoFocus
        className="min-h-11 flex-1 rounded-full bg-card px-4 py-2"
        onChangeText={props.onChange}
        placeholder="Search"
        returnKeyType="search"
        value={props.query}
      />
      <Pressable accessibilityRole="button" onPress={props.onClose}>
        <Text className="text-base text-foreground">Cancel</Text>
      </Pressable>
    </View>
  );
}
