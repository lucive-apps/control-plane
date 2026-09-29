import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import { useProjectActions } from "../projects/useProjectActions";
import { selectArchivedProjectRows } from "./archivedProjects";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";

export function ArchivedThreadsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
  // Archived Project ages count from the last time the screen came into view.
  const [now, setNow] = useState(() => Date.now());
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }),
    [environmentLabels, searchQuery, selectedEnvironmentId, snapshots, sortOrder],
  );
  const refreshChangedEnvironment = useCallback(
    (thread: { readonly environmentId: EnvironmentId }) => {
      refreshArchivedThreadsForEnvironment(thread.environmentId);
    },
    [],
  );
  const { unarchiveThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);

  // Archived Projects come from the live shell: their threads stay unarchived.
  // Each row selects its own agent count, so running threads elsewhere do not
  // re-render this screen.
  const navigation = useNavigation();
  const projects = useProjects();
  const projectActions = useProjectActions();
  const archivedProjects = useMemo(
    () =>
      selectArchivedProjectRows({
        projects,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
        now,
      }),
    [now, projects, searchQuery, selectedEnvironmentId, sortOrder],
  );
  const openArchivedProject = useCallback(
    (project: EnvironmentProject) =>
      navigation.dispatch(
        StackActions.push("SettingsProject", {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        }),
      ),
    [navigation],
  );
  const unarchiveProject = useCallback(
    (project: EnvironmentProject) => void projectActions.unarchive(project),
    [projectActions],
  );

  useFocusEffect(
    useCallback(() => {
      refresh();
      setNow(Date.now());
    }, [refresh]),
  );

  return (
    <ArchivedThreadsScreen
      archivedProjects={archivedProjects}
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      onDeleteThread={confirmDeleteThread}
      onEnvironmentChange={setSelectedEnvironmentId}
      onOpenArchivedProject={openArchivedProject}
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveProject={unarchiveProject}
      onUnarchiveThread={unarchiveThread}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
