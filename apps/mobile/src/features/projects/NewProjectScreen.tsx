import type { MenuAction } from "@react-native-menu/menu";
import {
  StackActions,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  planNewProjectCommands,
  readShowsFilePresent,
  resolveNewProjectFolderBase,
  resolveTypedProjectFolder,
  runNewProjectPlan,
  typedProjectFolderError,
  type FolderResolution,
  type NewFolderBase,
} from "@t3tools/client-runtime/state/assistant-flows";
import {
  convertSummary,
  defaultProjectFolder,
  localCoordinatorCandidates,
} from "@t3tools/client-runtime/state/assistants";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProjectIconOverride,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { showConfirmDialog, showTextInputDialog } from "../../components/ConfirmDialogHost";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SegmentedControl } from "../../components/SegmentedControl";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  convertSummaryText,
  defaultCoordinatorMode,
  resolveNewProjectStatus,
  selectProjectEnvironments,
  type CoordinatorMode,
} from "./newProjectSheet.logic";
import { Footnote, MenuRow, ValueText } from "./ProjectFormRows";
import { leadingEmoji } from "./projectMenus";

// Fork-owned. New Project and Convert (design A1 and A2) in the Project
// sheet: the desktop dialog's flow on native grouped rows. Every path is
// resolved to an absolute host path before it is matched, dispatched or
// written to.

export type NewProjectRouteParams = {
  readonly mode?: "new" | "convert";
  /** Convert: the workspace checkout to convert. New: the environment to start on. */
  readonly environmentId?: string;
  readonly projectId?: string;
  /** Set by the folder picker, with `pickedAt` so choosing the same folder again applies. */
  readonly existingPath?: string;
  readonly pickedAt?: string;
};

type FolderMode = "new" | "existing";
type SymbolName = ComponentProps<typeof SymbolView>["name"];

const RESOLVE_DEBOUNCE_MS = 250;
const MODEL_ICON: SymbolName = { ios: "sparkles", android: "auto_awesome" };

function describeFailure(failure: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/** One emoji for the Project icon. Resolves null when cancelled. */
function promptEmoji(current: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      Alert.prompt(
        "Project icon",
        "Type one emoji.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
          { text: "Save", onPress: (value?: string) => resolve(value ?? "") },
        ],
        "plain-text",
        current,
      );
      return;
    }
    showTextInputDialog({
      title: "Project icon",
      message: "Type one emoji.",
      initialValue: current,
      confirmText: "Save",
      onConfirm: resolve,
      onCancel: () => resolve(null),
    });
  });
}

function confirmDiscard(onDiscard: () => void): void {
  const title = "Discard this Project?";
  const message = "What you entered will be lost.";
  if (Platform.OS === "ios") {
    Alert.alert(title, message, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onDiscard },
    ]);
    return;
  }
  showConfirmDialog({
    title,
    message,
    cancelText: "Keep editing",
    confirmText: "Discard",
    destructive: true,
    onConfirm: onDiscard,
  });
}

export function NewProjectScreen({ route }: StaticScreenProps<NewProjectRouteParams | undefined>) {
  const params = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();

  const browse = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const listEntries = useAtomQueryRunner(projectEnvironment.listEntries, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const fileExists = useCallback(
    async (environmentId: EnvironmentId, cwd: string, relativePath: string) =>
      readShowsFilePresent(await readFile({ environmentId, input: { cwd, relativePath } })),
    [readFile],
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  // Convert keeps the checkout it was opened on, even if it is renamed meanwhile.
  const [convertProject] = useState(() =>
    params?.mode === "convert"
      ? (projects.find(
          (project) =>
            project.environmentId === params.environmentId && project.id === params.projectId,
        ) ?? null)
      : null,
  );
  const isConvert = convertProject !== null;

  const assistantEnvironments = useMemo(
    () => selectProjectEnvironments(environments),
    [environments],
  );
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(
    () =>
      convertProject?.environmentId ??
      (params?.environmentId ? EnvironmentId.make(params.environmentId) : null),
  );
  const environmentId = chosenEnvironmentId ?? assistantEnvironments[0]?.environmentId ?? null;
  // A chosen environment that dropped off (disconnected) stays chosen, never
  // silently swapped for another host, but the row stays up so it can be changed.
  const showEnvironmentRow =
    !isConvert &&
    (assistantEnvironments.length > 1 ||
      (assistantEnvironments.length > 0 &&
        !assistantEnvironments.some((entry) => entry.environmentId === environmentId)));
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const serverConfig = environment?.serverConfig ?? null;
  const environmentReady =
    environment?.connection.phase === "connected" &&
    serverConfig?.environment.capabilities.assistants === true;

  const [name, setName] = useState(convertProject?.title ?? "");
  // Undefined until the user picks, so an existing workspace keeps its icon.
  const [chosenIcon, setChosenIcon] = useState<ProjectIconOverride | undefined>(undefined);
  const [folderMode, setFolderMode] = useState<FolderMode>(isConvert ? "existing" : "new");
  // Null follows the default folder; a string is the user's own path.
  const [typedNewPath, setTypedNewPath] = useState<string | null>(null);
  const [existingPath, setExistingPath] = useState(
    convertProject?.workspaceRoot ?? params?.existingPath ?? "",
  );
  // The folder picker hands its choice back through the route params.
  const pickedAt = params?.pickedAt ?? null;
  const [appliedPick, setAppliedPick] = useState(pickedAt);
  if (pickedAt !== appliedPick) {
    setAppliedPick(pickedAt);
    if (params?.existingPath !== undefined) {
      setExistingPath(params.existingPath);
      setFolderMode("existing");
    }
  }
  // Null follows the default: Existing when Convert has a Local thread (A2).
  const [chosenCoordinatorMode, setChosenCoordinatorMode] = useState<CoordinatorMode | null>(null);
  const [chosenCoordinatorId, setChosenCoordinatorId] = useState<ThreadId | null>(null);
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(null);
  const [instructions, setInstructions] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Two taps in one frame both see the pre-render `isSubmitting`.
  const submittingRef = useRef(false);

  // ----- host path resolution -----
  const [base, setBase] = useState<NewFolderBase | null>(null);
  const [typedResolution, setTypedResolution] = useState<{
    readonly key: string;
    readonly value: FolderResolution;
  } | null>(null);
  const addProjectBaseDirectory = serverConfig?.settings.addProjectBaseDirectory?.trim() ?? "";

  useEffect(() => {
    if (environmentId === null || !environmentReady) return;
    let cancelled = false;
    void resolveNewProjectFolderBase({ environmentId, addProjectBaseDirectory, browse }).then(
      (next) => {
        if (!cancelled) setBase(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [addProjectBaseDirectory, browse, environmentId, environmentReady]);

  const typedInput = (folderMode === "new" ? typedNewPath : existingPath)?.trim() ?? null;
  const typedInputError = typedInput === null ? null : typedProjectFolderError(typedInput);
  const typedKey =
    typedInput === null || typedInputError !== null
      ? null
      : JSON.stringify([environmentId, folderMode, typedInput]);

  useEffect(() => {
    if (typedInput === null || typedKey === null || environmentId === null || !environmentReady) {
      return;
    }
    const input = typedInput;
    let cancelled = false;
    const timer = setTimeout(() => {
      void resolveTypedProjectFolder({
        environmentId,
        mode: folderMode,
        input,
        browse,
        fileExists,
      }).then((value) => {
        if (!cancelled) setTypedResolution({ key: typedKey, value });
      });
    }, RESOLVE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [browse, environmentId, environmentReady, fileExists, folderMode, typedInput, typedKey]);

  const environmentBase = base !== null && base.environmentId === environmentId ? base : null;
  const defaultNewPath =
    environmentBase?.kind === "ok"
      ? defaultProjectFolder({
          parentPath: environmentBase.parentPath,
          existingNames: environmentBase.existingNames,
          name,
        })
      : null;
  const folder: FolderResolution =
    folderMode === "new" && typedNewPath === null
      ? environmentBase === null
        ? { kind: "pending" }
        : defaultNewPath === null
          ? { kind: "error", message: "Choose a folder." }
          : { kind: "ok", path: defaultNewPath, hasAgentsFile: false }
      : typedInputError !== null
        ? { kind: "error", message: typedInputError }
        : typedResolution !== null && typedResolution.key === typedKey
          ? typedResolution.value
          : { kind: "pending" };

  // ----- what the folder already is -----
  const matchedProject =
    folder.kind === "ok"
      ? (findProjectByPath(
          projects.filter((project) => project.environmentId === environmentId),
          folder.path,
        ) ?? null)
      : null;
  const alreadyProject = matchedProject?.assistant != null ? matchedProject : null;
  const existingWorkspace =
    matchedProject !== null && alreadyProject === null ? matchedProject : null;
  const workspaceThreads = useMemo(
    () =>
      existingWorkspace === null
        ? []
        : threads.filter(
            (thread) =>
              thread.environmentId === existingWorkspace.environmentId &&
              thread.projectId === existingWorkspace.id,
          ),
    [existingWorkspace, threads],
  );
  const coordinatorCandidates = useMemo(
    () => localCoordinatorCandidates(workspaceThreads),
    [workspaceThreads],
  );
  const coordinatorMode =
    chosenCoordinatorMode ??
    defaultCoordinatorMode({
      mode: isConvert ? "convert" : "new",
      candidateCount: coordinatorCandidates.length,
    });
  const existingCoordinator =
    existingWorkspace !== null && coordinatorMode === "existing"
      ? (coordinatorCandidates.find((thread) => thread.id === chosenCoordinatorId) ??
        coordinatorCandidates[0] ??
        null)
      : null;
  const summary = convertSummary(workspaceThreads, existingCoordinator?.id ?? null);
  // Submit converts exactly when the resolved folder is a live workspace. Until
  // the folder resolves, keep the kind the sheet was opened as.
  const convertsWorkspace = folder.kind === "ok" ? existingWorkspace !== null : isConvert;
  // Like desktop: no pick keeps the workspace's own icon, which the emoji-only
  // picker could not bring back.
  const icon = chosenIcon ?? existingWorkspace?.projectIcon ?? null;
  const hasAgentsFile = folder.kind === "ok" && folder.hasAgentsFile;

  // ----- model -----
  const settings = useMemo(
    () =>
      resolveProjectSettings(
        serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        existingWorkspace?.id ?? null,
        existingWorkspace,
      ).settings,
    [existingWorkspace, serverConfig?.settings],
  );
  const projectDefaultModel = resolveDefaultableModelSelection(
    serverConfig,
    settings.defaultModelSelection,
  );
  const modelOptions = useMemo(
    () => buildModelOptions(serverConfig, chosenModel ?? projectDefaultModel),
    [chosenModel, projectDefaultModel, serverConfig],
  );
  const modelSelection = resolveNewTaskModelSelection({
    draftSelection: chosenModel,
    projectDefaultSelection: projectDefaultModel,
    stickySelection: null,
    modelOptions,
  });
  const currentModel =
    modelSelection === null
      ? null
      : (modelOptions.find(
          (option) =>
            option.selection.instanceId === modelSelection.instanceId &&
            option.selection.model === modelSelection.model,
        ) ?? null);
  const providerGroups = groupByProvider(modelOptions);
  const currentProvider =
    providerGroups.find((group) => group.providerKey === currentModel?.providerKey) ?? null;

  const trimmedName = name.trim();
  const status = resolveNewProjectStatus({
    environmentReady,
    name: trimmedName,
    folder,
    existingProjectTitle: alreadyProject?.title ?? null,
    hasModel: modelSelection !== null,
    isSubmitting,
  });

  // Swiping the sheet down, Cancel or back never drops typed text silently.
  const dirty =
    !isSubmitting &&
    (name !== (convertProject?.title ?? "") ||
      typedNewPath !== null ||
      instructions.trim().length > 0);
  usePreventRemove(dirty, ({ data }) => {
    // A submit that finished before this render still closes the sheet.
    if (submittingRef.current) {
      navigation.dispatch(data.action);
      return;
    }
    confirmDiscard(() => navigation.dispatch(data.action));
  });

  const submit = async () => {
    if (
      !status.canSubmit ||
      folder.kind !== "ok" ||
      environmentId === null ||
      modelSelection === null
    ) {
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    const plan = planNewProjectCommands({
      newProjectId: ProjectId.make(uuidv4()),
      newThreadId: ThreadId.make(uuidv4()),
      name: trimmedName,
      resolvedPath: folder.path,
      projectIcon: icon,
      modelSelection,
      runtimeMode: settings.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      existingWorkspace,
      existingCoordinatorThreadId: existingCoordinator?.id ?? null,
    });
    const outcome = await runNewProjectPlan({
      environmentId,
      plan,
      folderPath: folder.path,
      instructions,
      modelSelection,
      supportsOverrides: serverConfig?.environment.capabilities.projectSettingsOverrides === true,
      overrides: serverConfig?.settings.projectSettingsOverrides ?? {},
      run: {
        createProject,
        createThread,
        updateProject,
        updateSettings,
        listEntries,
        readFile,
        writeFile,
      },
    });
    if (!outcome.ok) {
      submittingRef.current = false;
      setIsSubmitting(false);
      if (!isAtomCommandInterrupted(outcome.failure)) {
        Alert.alert(outcome.title, describeFailure(outcome.failure));
      }
      return;
    }
    // Replacing the sheet's root route closes it and opens the coordinator.
    (navigation.getParent() ?? navigation).dispatch(
      StackActions.replace("Thread", {
        environmentId: String(environmentId),
        threadId: String(plan.coordinatorThreadId),
      }),
    );
    const [first] = outcome.warnings;
    if (first !== undefined) {
      Alert.alert(
        outcome.warnings.length === 1 ? first.title : "Project created with problems",
        outcome.warnings
          .map((warning) =>
            outcome.warnings.length === 1
              ? describeFailure(warning.failure)
              : `${warning.title}: ${describeFailure(warning.failure)}`,
          )
          .join("\n"),
      );
    }
  };

  const chooseIcon = async (id: string) => {
    if (id === "automatic") {
      setChosenIcon(undefined);
      return;
    }
    const value = await promptEmoji(icon?.kind === "emoji" ? icon.emoji : "");
    if (value === null || value.trim().length === 0) return;
    const emoji = leadingEmoji(value);
    if (emoji === null) {
      Alert.alert("Could not change the icon", "Type one emoji to use as the Project icon.");
      return;
    }
    setChosenIcon({ kind: "emoji", emoji });
  };

  const openFolderPicker = () => {
    if (environmentId === null) return;
    navigation.dispatch(
      StackActions.push("NewProjectFolder", {
        environmentId: String(environmentId),
        ...(existingPath.trim().length > 0 ? { initialPath: existingPath.trim() } : {}),
      }),
    );
  };

  const title = convertsWorkspace ? "Convert to Project" : "New Project";
  const submitLabel = convertsWorkspace ? "Convert" : "Create";
  const iconActions: MenuAction[] = [
    { id: "choose", title: "Choose emoji…", image: "face.smiling" },
    {
      id: "automatic",
      title: existingWorkspace?.projectIcon ? "Keep workspace icon" : "Use automatic icon",
      image: "arrow.uturn.backward",
      ...(chosenIcon === undefined ? { attributes: { disabled: true } } : {}),
    },
  ];
  const environmentActions: MenuAction[] = assistantEnvironments.map((entry) => ({
    id: `environment:${entry.environmentId}`,
    title: entry.label,
    state: entry.environmentId === environmentId ? ("on" as const) : ("off" as const),
  }));
  const coordinatorActions: MenuAction[] = coordinatorCandidates.map((thread) => ({
    id: `thread:${thread.id}`,
    title: thread.title,
    state: thread.id === existingCoordinator?.id ? ("on" as const) : ("off" as const),
  }));
  const providerActions: MenuAction[] = providerGroups.map((group) => ({
    id: `provider:${group.providerKey}`,
    title: group.providerLabel,
    state: group.providerKey === currentProvider?.providerKey ? ("on" as const) : ("off" as const),
  }));
  const modelActions: MenuAction[] = (currentProvider?.models ?? []).map((option) => ({
    id: `model:${option.key}`,
    title: option.label,
    ...(option.subtitle.length > 0 ? { subtitle: option.subtitle } : {}),
    state: option.key === currentModel?.key ? ("on" as const) : ("off" as const),
    ...(option.isUnavailable === true ? { attributes: { disabled: true } } : {}),
  }));
  const folderValue = folderMode === "new" ? (typedNewPath ?? defaultNewPath ?? "") : existingPath;
  const previewTitle = trimmedName || "Project";

  return (
    <View className="flex-1 bg-sheet">
      {/* An iOS formSheet resizes the first ScrollView on its first-subview path to
          the whole sheet (react-native-screens applyFrameCorrectionForDescendantScrollView),
          which pushed this form below the sheet when it opens as the sheet's first
          screen. The nested stack already bounds the screen, so this empty view ends
          that path. */}
      <View collapsable={false} pointerEvents="none" />
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android", title }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          actions={[
            {
              accessibilityLabel: submitLabel,
              icon: "checkmark",
              onPress: () => void submit(),
              disabled: !status.canSubmit,
            },
          ]}
          onBack={() => navigation.goBack()}
        />
      ) : (
        <>
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="Cancel"
              disabled={isSubmitting}
              label="Cancel"
              onPress={() => navigation.goBack()}
            />
          </NativeHeaderToolbar>
          <NativeHeaderToolbar placement="right">
            <NativeHeaderToolbar.Button
              accessibilityLabel={submitLabel}
              disabled={!status.canSubmit}
              label={submitLabel}
              onPress={() => void submit()}
            />
          </NativeHeaderToolbar>
        </>
      )}
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {showEnvironmentRow ? (
          <SettingsSection>
            <MenuRow
              icon="desktopcomputer"
              label="Environment"
              title="Environment"
              actions={environmentActions}
              onPressAction={(id) => {
                const next = assistantEnvironments.find(
                  (entry) => `environment:${entry.environmentId}` === id,
                );
                if (next === undefined || next.environmentId === environmentId) return;
                setChosenEnvironmentId(next.environmentId);
                setChosenModel(null);
                setBase(null);
              }}
              trailing={<ValueText>{environment?.label ?? "Choose"}</ValueText>}
            />
          </SettingsSection>
        ) : null}

        <SettingsSection>
          <MenuRow
            icon="face.smiling"
            label="Icon"
            title="Project icon"
            actions={iconActions}
            onPressAction={(id) => void chooseIcon(id)}
            trailing={
              environmentId === null ? null : (
                <ProjectFavicon
                  environmentId={environmentId}
                  projectTitle={previewTitle}
                  projectIcon={icon}
                  workspaceRoot={existingWorkspace?.workspaceRoot ?? null}
                  faviconPath={existingWorkspace?.faviconPath ?? null}
                  size={22}
                />
              )
            }
          />
          <View className="gap-2 px-4 pb-4">
            <Text className="text-sm font-t3-medium text-foreground-muted">Name</Text>
            <AppTextInput
              accessibilityLabel="Project name"
              autoCorrect={false}
              className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              editable={!isSubmitting}
              onChangeText={setName}
              placeholder="Personal"
              returnKeyType="done"
              value={name}
            />
          </View>
        </SettingsSection>

        <SettingsSection title="Folder">
          <View className="gap-3 p-4">
            <SegmentedControl
              options={[
                { value: "new", label: "New folder" },
                { value: "existing", label: "Existing folder" },
              ]}
              selected={folderMode}
              size="compact"
              onSelect={setFolderMode}
            />
            {folderMode === "new" ? (
              <AppTextInput
                accessibilityLabel="New folder path"
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
                editable={!isSubmitting}
                onChangeText={setTypedNewPath}
                placeholder="~/Projects/personal"
                spellCheck={false}
                value={folderValue}
              />
            ) : (
              <Pressable
                accessibilityHint="Browses the host's folders"
                accessibilityLabel={
                  existingPath.trim().length > 0 ? `Folder ${existingPath}` : "Choose a folder"
                }
                accessibilityRole="button"
                className="min-h-11 flex-row items-center gap-3 rounded-xl bg-card px-3 active:opacity-70"
                disabled={isSubmitting || environmentId === null}
                onPress={openFolderPicker}
              >
                <SymbolView
                  name="folder"
                  size={17}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
                <Text
                  className={
                    existingPath.trim().length > 0
                      ? "min-w-0 flex-1 text-base text-foreground"
                      : "min-w-0 flex-1 text-base text-foreground-muted"
                  }
                  ellipsizeMode="head"
                  numberOfLines={1}
                >
                  {existingPath.trim().length > 0 ? existingPath : "Choose a folder"}
                </Text>
                <SymbolView
                  name="chevron.right"
                  size={13}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
            )}
            {status.folderMessage !== null ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {status.folderMessage}
              </Text>
            ) : null}
          </View>
        </SettingsSection>

        {existingWorkspace !== null ? (
          <>
            <SettingsSection title="Coordinator">
              {coordinatorCandidates.length > 0 ? (
                <View className="p-4">
                  <SegmentedControl
                    options={[
                      { value: "new", label: "New thread" },
                      { value: "existing", label: "Existing thread" },
                    ]}
                    selected={coordinatorMode}
                    size="compact"
                    onSelect={setChosenCoordinatorMode}
                  />
                </View>
              ) : (
                // No Local thread to promote, so a new one is the only choice.
                <MenuRow
                  icon="text.bubble"
                  label="Thread"
                  title="Coordinator thread"
                  actions={[]}
                  disabled
                  onPressAction={() => {}}
                  trailing={<ValueText>New thread</ValueText>}
                />
              )}
              {existingCoordinator !== null ? (
                <MenuRow
                  icon="text.bubble"
                  label="Thread"
                  title="Coordinator thread"
                  actions={coordinatorActions}
                  onPressAction={(id) => {
                    const thread = coordinatorCandidates.find(
                      (candidate) => `thread:${candidate.id}` === id,
                    );
                    if (thread) setChosenCoordinatorId(thread.id);
                  }}
                  trailing={<ValueText>{existingCoordinator.title}</ValueText>}
                />
              ) : null}
            </SettingsSection>
            <Footnote>
              {existingCoordinator !== null
                ? "Its history carries over and it becomes the coordinator. "
                : ""}
              {convertSummaryText(summary)}
            </Footnote>
          </>
        ) : null}

        <SettingsSection
          title={existingCoordinator !== null ? "Default model for new agents" : "Model"}
        >
          <MenuRow
            icon="cpu"
            label="Provider"
            title="Provider"
            actions={providerActions}
            disabled={providerGroups.length === 0}
            onPressAction={(id) => {
              const group = providerGroups.find((entry) => `provider:${entry.providerKey}` === id);
              if (group === undefined || group.providerKey === currentProvider?.providerKey) return;
              const option =
                group.models.find((entry) => entry.isDefault && entry.isUnavailable !== true) ??
                group.models.find((entry) => entry.isUnavailable !== true);
              if (option) setChosenModel(option.selection);
            }}
            trailing={<ValueText>{currentProvider?.providerLabel ?? "None available"}</ValueText>}
          />
          <MenuRow
            icon={MODEL_ICON}
            label="Model"
            title="Model"
            actions={modelActions}
            disabled={modelActions.length === 0}
            onPressAction={(id) => {
              const option = currentProvider?.models.find((entry) => `model:${entry.key}` === id);
              if (option) setChosenModel(option.selection);
            }}
            trailing={<ValueText>{currentModel?.label ?? "Not set"}</ValueText>}
          />
        </SettingsSection>

        <SettingsSection title="Shared instructions">
          {hasAgentsFile ? (
            <Text className="p-4 text-base text-foreground-muted">
              AGENTS.md exists and is kept.
            </Text>
          ) : (
            <AppTextInput
              accessibilityLabel="Shared instructions for the coordinator and all agents"
              className="min-h-32 rounded-none border-0 bg-card px-4 py-3 text-base"
              editable={!isSubmitting}
              multiline
              onChangeText={setInstructions}
              placeholder="Write concisely. Cite sources. Never send email or spend money without asking."
              scrollEnabled={false}
              textAlignVertical="top"
              value={instructions}
            />
          )}
        </SettingsSection>
        <Footnote>
          {hasAgentsFile
            ? "Read by the coordinator and every agent."
            : "Read by the coordinator and every agent. Saved as AGENTS.md."}
        </Footnote>

        {status.formMessage !== null ? <ErrorBanner message={status.formMessage} /> : null}
      </ScrollView>
    </View>
  );
}
