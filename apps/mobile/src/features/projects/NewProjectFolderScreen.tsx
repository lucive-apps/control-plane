import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  trimTrailingPathSeparators,
  typedProjectFolderError,
} from "@t3tools/client-runtime/state/assistant-flows";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { useCallback, useEffect, useRef } from "react";

import { EmptyState } from "../../components/EmptyState";
import {
  AddProjectShell,
  FolderBrowser,
  PrimaryActionButton,
  ProjectPathInput,
  useBrowsePathInput,
  useEnvironmentFromParam,
} from "./AddProjectScreen";

// Fork-owned. The Existing folder picker of the New Project sheet: a path
// input and the Add workspace folder browser. "Use this folder" hands the
// path back to New Project.

type NewProjectFolderRouteParams = {
  readonly environmentId: string;
  /** The folder already chosen, where browsing starts. */
  readonly initialPath?: string;
};

export function NewProjectFolderScreen({ route }: StaticScreenProps<NewProjectFolderRouteParams>) {
  const navigation = useNavigation();
  const environment = useEnvironmentFromParam(route.params.environmentId);
  const { isBrowseNavigating, navigateToBrowsePath, pathInput, setPathInput } =
    useBrowsePathInput(environment);

  // Start at the chosen folder once the environment resolves; the hook
  // itself starts at the host's base directory.
  const initialPath = route.params.initialPath?.trim() ?? "";
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || environment === null) return;
    startedRef.current = true;
    if (initialPath.length > 0) setPathInput(ensureBrowseDirectoryPath(initialPath));
  }, [environment, initialPath, setPathInput]);

  const invalid = typedProjectFolderError(pathInput) !== null;
  const chooseFolder = useCallback(() => {
    if (invalid || isBrowseNavigating) return;
    navigation.dispatch(
      StackActions.popTo(
        "NewProject",
        {
          existingPath: trimTrailingPathSeparators(pathInput.trim()),
          // Choosing the same folder again still replaces a path typed since.
          pickedAt: String(Date.now()),
        },
        { merge: true },
      ),
    );
  }, [invalid, isBrowseNavigating, navigation, pathInput]);

  return (
    <AddProjectShell title="Choose folder">
      {environment ? (
        <>
          <ProjectPathInput value={pathInput} onChangeText={setPathInput} onSubmit={chooseFolder} />
          <PrimaryActionButton
            label="Use this folder"
            disabled={invalid || isBrowseNavigating}
            onPress={chooseFolder}
          />
          <FolderBrowser
            environment={environment}
            navigateToBrowsePath={navigateToBrowsePath}
            pathInput={pathInput}
            setPathInput={setPathInput}
          />
        </>
      ) : (
        <EmptyState
          title="Environment unavailable"
          detail="Reconnect to the environment to browse its folders."
        />
      )}
    </AddProjectShell>
  );
}
