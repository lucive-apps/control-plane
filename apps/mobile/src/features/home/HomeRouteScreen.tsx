import { selectWorkspaceProjects } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import {
  AndroidWorkspaceSidebarButton,
  WorkspaceSidebarToolbar,
} from "../layout/workspace-sidebar-toolbar";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { setAddProjectClosesSheet } from "../projects/AddProjectScreen.logic";
import { useHomeListOptions } from "./home-list-options";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { buildHomeProjectScopes } from "./homeThreadList";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const { layout, panes } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const handleSelectThread = useHomeThreadSelection();

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);

  const pendingTasks = usePendingNewTasks();
  const homePendingTasks = useMemo(
    () => pendingTasks.filter((task) => task.kind !== "draft"),
    [pendingTasks],
  );
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options: listOptions, setSelectedEnvironmentId } =
    useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const filterActive = selectedEnvironmentId !== null || selectedProjectKey !== null;
  const handleClearFilter = useCallback(() => {
    setSelectedEnvironmentId(null);
    setSelectedProjectKey(null);
  }, [setSelectedEnvironmentId]);
  // The Workspace filter lists Tasks folders only; Project folders are not workspaces.
  const workspaceProjects = useMemo(() => selectWorkspaceProjects(projects), [projects]);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: workspaceProjects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, selectedEnvironmentId, workspaceProjects],
  );
  const filterTitle =
    projectFilterOptions.find((project) => project.key === selectedProjectKey)?.label ??
    environments.find((environment) => environment.environmentId === selectedEnvironmentId)
      ?.label ??
    "";
  const openNewTaskInProject = useCallback(
    (project: EnvironmentProject) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          title: project.title,
        },
      });
    },
    [navigation],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : { title: "", headerTitle: "", unstable_headerLeftItems: () => [] }
          }
        />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTaskDraft" })}
            />
          }
        />
        {Platform.OS === "android" ? (
          <AndroidScreenHeader title="Threads" leading={<AndroidWorkspaceSidebarButton />} />
        ) : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew" },
                  })
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible
              ? undefined
              : () => navigation.navigate("NewTaskSheet", { screen: "NewTaskDraft" })
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTaskDraft" })}
    >
      <>
        {/* No brand title on Home. Keep the bar so iOS can host the mail
            search toolbar and the settings item. */}
        <NativeStackScreenOptions
          optionsVersion={`${windowWidth}:${searchOpen ? "search" : "header"}`}
          options={{
            headerShown: !searchOpen,
          }}
        />
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          filterTitle={filterTitle}
          onClearFilter={filterActive ? handleClearFilter : undefined}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironments" },
            })
          }
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          // Android also keeps the Tasks Settled shelf on Home; Project agents list only on the Settled screen.
          onOpenSettled={() => navigation.navigate("Settled")}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTaskDraft" })}
          onStartSearch={() => setSearchOpen(true)}
          searchOpen={searchOpen}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironmentNew" },
            })
          }
          searchOpen={searchOpen}
          onCloseSearch={() => {
            setSearchOpen(false);
            setSearchQuery("");
          }}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={handleSelectThread}
          onNewThreadOnBranch={(thread) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(thread.environmentId),
                projectId: String(thread.projectId),
                branch: thread.branch,
                worktreePath: thread.worktreePath,
              },
            });
          }}
          onNewThreadInProject={openNewTaskInProject}
          onNewAgent={openNewTaskInProject}
          onAddWorkspace={() => {
            setAddProjectClosesSheet(true);
            navigation.navigate("NewTaskSheet", {
              screen: "AddProject",
              initial: true,
            });
          }}
          pendingTasks={homePendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
