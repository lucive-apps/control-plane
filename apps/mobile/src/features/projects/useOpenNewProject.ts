import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAppNavigation } from "../threads/sidebar-navigation-shell";

// Fork-owned. Opens the Project sheet on New Project (design A1) or on
// Convert for one workspace checkout (A2), from Home, the iPad sidebar or
// the command palette.

export function useOpenNewProject() {
  // Home rows also render in the iPad sidebar's independent nav tree.
  const navigation = useAppNavigation();
  return useMemo(
    () => ({
      /** Starts on `environmentId` (Home's Environment filter) when given. */
      openNewProject: (environmentId?: EnvironmentId | null) =>
        navigation.navigate("ProjectSheet", {
          screen: "NewProject",
          params: {
            mode: "new",
            ...(environmentId ? { environmentId: String(environmentId) } : {}),
          },
        }),
      openConvertToProject: (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
        navigation.navigate("ProjectSheet", {
          screen: "NewProject",
          params: {
            mode: "convert",
            environmentId: String(project.environmentId),
            projectId: String(project.id),
          },
        }),
    }),
    [navigation],
  );
}
