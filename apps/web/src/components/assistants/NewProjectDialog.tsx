import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  convertSummary,
  defaultProjectFolder,
  localCoordinatorCandidates,
  planAssistantScaffold,
} from "@t3tools/client-runtime/state/assistants";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectIconOverride,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpenIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { mergeEnvironmentSettings, useClientSettings } from "../../hooks/useSettings";
import { ensureBrowseDirectoryPath, findProjectByPath } from "../../lib/projectPaths";
import { cn, newProjectId, newThreadId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectMonogram } from "../ProjectMonogram";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { AssistantDialogRequest } from "./assistantDialogStore";
import {
  expandHomePath,
  isAbsoluteOrHomePath,
  planDefaultModelOverridePatch,
  planNewProjectCommands,
  readShowsFilePresent,
  writeMissingScaffoldFiles,
} from "./newProject.logic";

const ProjectIconPickerDialog = lazy(() =>
  import("../settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

const DEFAULT_PROJECTS_DIRECTORY = "~/Projects";
const RESOLVE_DEBOUNCE_MS = 250;

type FolderMode = "new" | "existing";

type FolderResolution =
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ok";
      /** Absolute on the host. */
      readonly path: string;
      readonly hasAgentsFile: boolean;
    };

type NewFolderBase =
  | {
      readonly kind: "ok";
      readonly environmentId: EnvironmentId;
      readonly parentPath: string;
      readonly existingNames: readonly string[];
    }
  | { readonly kind: "error"; readonly environmentId: EnvironmentId };

function describeFailure(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * New Project and Convert (mock frames 4a to 4c). Every path is resolved to
 * an absolute host path before it is matched, dispatched or written to.
 */
export default function NewProjectDialog(props: {
  readonly request: Extract<AssistantDialogRequest, { kind: "new" | "convert" }>;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const id = useId();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threads = useThreadShells();
  const clientSettings = useClientSettings();

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

  // Convert keeps the workspace it was opened on, even if it is renamed meanwhile.
  const [convertProject] = useState(() =>
    request.kind === "convert"
      ? (projects.find(
          (project) =>
            project.environmentId === request.projectRef.environmentId &&
            project.id === request.projectRef.projectId,
        ) ?? null)
      : null,
  );
  const isConvert = convertProject !== null;

  const assistantEnvironments = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.connection.phase === "connected" &&
            environment.serverConfig?.environment.capabilities.assistants === true,
        )
        .sort(
          (left, right) =>
            Number(right.environmentId === primaryEnvironmentId) -
              Number(left.environmentId === primaryEnvironmentId) ||
            left.label.localeCompare(right.label),
        ),
    [environments, primaryEnvironmentId],
  );
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(
    convertProject?.environmentId ??
      (request.kind === "new" ? (request.environmentId ?? null) : null),
  );
  const environmentId = chosenEnvironmentId ?? assistantEnvironments[0]?.environmentId ?? null;
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const serverConfig = environment?.serverConfig ?? null;
  const environmentReady =
    environment?.connection.phase === "connected" &&
    serverConfig?.environment.capabilities.assistants === true;

  const [name, setName] = useState(convertProject?.title ?? "");
  // Null until the user picks one, so an existing workspace keeps its icon.
  const [chosenIcon, setChosenIcon] = useState<ProjectIconOverride | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [folderMode, setFolderMode] = useState<FolderMode>(isConvert ? "existing" : "new");
  // Null follows the default folder; a string is the user's own path.
  const [typedNewPath, setTypedNewPath] = useState<string | null>(null);
  const [existingPath, setExistingPath] = useState(convertProject?.workspaceRoot ?? "");
  const [coordinatorMode, setCoordinatorMode] = useState<"new" | "existing">("new");
  const [chosenCoordinatorId, setChosenCoordinatorId] = useState<ThreadId | null>(null);
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(null);
  const [instructions, setInstructions] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    const resolveHome = async (): Promise<string | null> => {
      const result = await browse({ environmentId, input: { partialPath: "~/" } });
      return result._tag === "Success" ? result.value.parentPath : null;
    };
    void (async () => {
      const directory = addProjectBaseDirectory || DEFAULT_PROJECTS_DIRECTORY;
      const listed = await browse({
        environmentId,
        input: { partialPath: ensureBrowseDirectoryPath(directory) },
      });
      // Without a resolvable parent the user has to type a folder.
      let next: NewFolderBase = { kind: "error", environmentId };
      if (listed._tag === "Success") {
        next = {
          kind: "ok",
          environmentId,
          parentPath: listed.value.parentPath,
          existingNames: listed.value.entries.map((entry) => entry.name),
        };
      } else if (isAbsoluteOrHomePath(directory)) {
        // Not created yet: project.create makes it along with the Project folder.
        const home = directory.startsWith("~") ? await resolveHome() : "";
        if (home !== null) {
          next = {
            kind: "ok",
            environmentId,
            parentPath: expandHomePath(directory, home).replace(/(?<=.)[\\/]+$/, ""),
            existingNames: [],
          };
        }
      }
      if (!cancelled) setBase(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [addProjectBaseDirectory, browse, environmentId, environmentReady]);

  const typedInput = (folderMode === "new" ? typedNewPath : existingPath)?.trim() ?? null;
  const typedInputError =
    typedInput === null
      ? null
      : typedInput.length === 0
        ? "Choose a folder."
        : isAbsoluteOrHomePath(typedInput)
          ? null
          : "Enter an absolute path or one starting with ~/.";
  const typedKey =
    typedInput === null || typedInputError !== null
      ? null
      : JSON.stringify([environmentId, folderMode, typedInput]);

  useEffect(() => {
    if (typedInput === null || typedKey === null || environmentId === null || !environmentReady) {
      return;
    }
    const input = typedInput;
    const settle = (value: FolderResolution) => setTypedResolution({ key: typedKey, value });
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const listed = await browse({
          environmentId,
          input: { partialPath: ensureBrowseDirectoryPath(input) },
        });
        let value: FolderResolution;
        if (folderMode === "existing") {
          if (listed._tag !== "Success") {
            value = { kind: "error", message: "Folder not found." };
          } else {
            const path = listed.value.parentPath;
            value = {
              kind: "ok",
              path,
              hasAgentsFile: await fileExists(environmentId, path, "AGENTS.md"),
            };
          }
        } else if (listed._tag === "Success") {
          value = { kind: "error", message: "Folder exists. Choose Existing folder." };
        } else {
          const homeResult = input.startsWith("~")
            ? await browse({ environmentId, input: { partialPath: "~/" } })
            : null;
          value =
            homeResult !== null && homeResult._tag !== "Success"
              ? { kind: "error", message: "Could not resolve ~ on this host." }
              : {
                  kind: "ok",
                  path: expandHomePath(
                    input,
                    homeResult?._tag === "Success" ? homeResult.value.parentPath : "",
                  ).replace(/(?<=.)[\\/]+$/, ""),
                  hasAgentsFile: false,
                };
        }
        if (!cancelled) settle(value);
      })();
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
  const isAlreadyProject = matchedProject?.assistant != null;
  const existingWorkspace = matchedProject !== null && !isAlreadyProject ? matchedProject : null;
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
  const existingCoordinator =
    existingWorkspace !== null && coordinatorMode === "existing"
      ? (coordinatorCandidates.find((thread) => thread.id === chosenCoordinatorId) ??
        coordinatorCandidates[0] ??
        null)
      : null;
  const summary = convertSummary(workspaceThreads, existingCoordinator?.id ?? null);
  // Submit converts exactly when the resolved folder is a live workspace. Until
  // the folder resolves, keep the kind the dialog was opened as.
  const convertsWorkspace = folder.kind === "ok" ? existingWorkspace !== null : isConvert;
  const icon = chosenIcon ?? existingWorkspace?.projectIcon ?? null;
  const hasAgentsFile = folder.kind === "ok" && folder.hasAgentsFile;

  // ----- model -----
  const settings = useMemo(
    () =>
      mergeEnvironmentSettings(
        resolveProjectSettings(
          serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
          existingWorkspace?.id ?? null,
          existingWorkspace,
        ).settings,
        clientSettings,
      ),
    [clientSettings, existingWorkspace, serverConfig?.settings],
  );
  const providers = serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const modelSelection = resolveDefaultProviderModelSelection(
    providers,
    chosenModel ?? settings.defaultModelSelection,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    modelSelection?.instanceId,
    modelSelection?.model,
  );

  const trimmedName = name.trim();
  const blocker = !environmentReady
    ? "Connect an environment that supports Projects."
    : trimmedName.length === 0
      ? null
      : folder.kind === "error"
        ? folder.message
        : isAlreadyProject
          ? `This folder is already the Project "${matchedProject?.title}".`
          : modelSelection === null
            ? "No providers are available on this environment."
            : null;
  const canSubmit =
    !isSubmitting && trimmedName.length > 0 && folder.kind === "ok" && blocker === null;

  const reportError = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));

  const submit = async () => {
    if (!canSubmit || folder.kind !== "ok" || environmentId === null || modelSelection === null) {
      return;
    }
    setIsSubmitting(true);
    const plan = planNewProjectCommands({
      newProjectId: newProjectId(),
      newThreadId: newThreadId(),
      name: trimmedName,
      resolvedPath: folder.path,
      projectIcon: icon,
      modelSelection,
      runtimeMode: settings.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      existingWorkspace,
      existingCoordinatorThreadId: existingCoordinator?.id ?? null,
    });
    const failureTitle =
      existingWorkspace !== null ? "Failed to convert to a Project" : "Failed to create Project";
    for (const command of plan.commands) {
      const result =
        command.type === "project.create"
          ? await createProject({ environmentId, input: command.input })
          : command.type === "thread.create"
            ? await createThread({ environmentId, input: command.input })
            : await updateProject({ environmentId, input: command.input });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) reportError(failureTitle, describeFailure(result));
        setIsSubmitting(false);
        return;
      }
    }

    if (serverConfig?.environment.capabilities.projectSettingsOverrides === true) {
      const saved = await updateSettings({
        environmentId,
        input: {
          patch: planDefaultModelOverridePatch({
            overrides: serverConfig.settings.projectSettingsOverrides,
            projectId: plan.projectId,
            modelSelection,
          }),
        },
      });
      if (saved._tag === "Failure") {
        reportError("Default model for new agents not saved", describeFailure(saved));
      }
    }

    // Re-list right before writing so a file created since the dialog opened is kept.
    const listed = await listEntries({
      environmentId,
      input: { cwd: folder.path, directoryPath: "" },
    });
    if (listed._tag === "Failure") {
      reportError("Project files not added", describeFailure(listed));
    } else {
      const files = planAssistantScaffold({
        existingNames: listed.value.entries.map(
          (entry) => entry.path.split(/[\\/]/).pop() ?? entry.path,
        ),
        instructions,
      });
      const scaffold = await writeMissingScaffoldFiles({
        files,
        read: (relativePath) =>
          readFile({ environmentId, input: { cwd: folder.path, relativePath } }),
        write: (relativePath, contents) =>
          writeFile({ environmentId, input: { cwd: folder.path, relativePath, contents } }),
      });
      for (const { relativePath, result } of scaffold.failed) {
        reportError(`${relativePath} not written`, describeFailure(result));
      }
      // The listing above is cached too, and the file view's root crumb reads it.
      if (scaffold.written.length > 0) {
        await listEntries({ environmentId, input: { cwd: folder.path, directoryPath: "" } });
      }
    }

    props.onClose();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, plan.coordinatorThreadId)),
    });
  };

  const canBrowse =
    environmentId !== null &&
    environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const pickFolder = async () => {
    const api = readLocalApi();
    if (!api) return;
    const picked = await api.dialogs
      .pickFolder(existingPath.trim() ? { initialPath: existingPath.trim() } : undefined)
      .catch(() => null);
    if (picked) setExistingPath(picked);
  };

  const automaticIdentity = deriveProjectIdentity(trimmedName || "Project");
  const iconPreview =
    environmentId !== null && icon !== null ? (
      <ProjectFavicon
        project={{
          environmentId,
          workspaceRoot:
            existingWorkspace?.workspaceRoot ??
            (environmentBase?.kind === "ok" ? environmentBase.parentPath : ""),
          title: trimmedName || "Project",
          faviconPath: null,
          projectIcon: icon,
        }}
        className="size-5"
      />
    ) : existingWorkspace !== null ? (
      <ProjectFavicon project={existingWorkspace} className="size-5" />
    ) : (
      <ProjectMonogram
        text={automaticIdentity.monogram}
        color={automaticIdentity.color}
        className="size-5"
      />
    );
  const showWorkspaceChoices = existingWorkspace !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{convertsWorkspace ? "Convert to Project" : "New Project"}</DialogTitle>
            <DialogDescription>
              A coordinator thread and its agents, working in one folder.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            {assistantEnvironments.length > 1 && !isConvert ? (
              <Field label="Environment" htmlFor={`${id}-environment`}>
                <Select
                  value={environmentId ?? ""}
                  items={Object.fromEntries(
                    assistantEnvironments.map((entry) => [entry.environmentId, entry.label]),
                  )}
                  onValueChange={(value) => {
                    if (!value) return;
                    setChosenEnvironmentId(value as EnvironmentId);
                    setChosenModel(null);
                    setBase(null);
                  }}
                >
                  <SelectTrigger id={`${id}-environment`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {assistantEnvironments.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            ) : null}

            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Icon</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Choose a Project icon"
                  onClick={() => setIconPickerOpen(true)}
                >
                  {iconPreview}
                </Button>
              </div>
              <Field label="Name" htmlFor={`${id}-name`} className="flex-1">
                <Input
                  nativeInput
                  id={`${id}-name`}
                  autoFocus
                  autoComplete="off"
                  placeholder="Personal"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-folder`}>Folder</Label>
              <ToggleGroup
                aria-label="Folder"
                variant="segmented"
                value={[folderMode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "new" || value === "existing") setFolderMode(value);
                }}
              >
                <Toggle value="new">New folder</Toggle>
                <Toggle value="existing">Existing folder</Toggle>
              </ToggleGroup>
              <div className="flex items-center gap-2">
                <Input
                  nativeInput
                  id={`${id}-folder`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={folderMode === "new" ? "~/Projects/personal" : "~/code/website"}
                  value={
                    folderMode === "new" ? (typedNewPath ?? defaultNewPath ?? "") : existingPath
                  }
                  onChange={(event) =>
                    folderMode === "new"
                      ? setTypedNewPath(event.target.value)
                      : setExistingPath(event.target.value)
                  }
                />
                {folderMode === "existing" && canBrowse ? (
                  <Button type="button" variant="outline" onClick={() => void pickFolder()}>
                    <FolderOpenIcon />
                    Browse
                  </Button>
                ) : null}
              </div>
              {folder.kind === "error" ? (
                <p role="alert" className="text-destructive">
                  {folder.message}
                </p>
              ) : isAlreadyProject ? (
                <p role="alert" className="text-destructive">
                  This folder is already the Project "{matchedProject?.title}".
                </p>
              ) : null}
            </div>

            {showWorkspaceChoices ? (
              <div className="flex flex-col gap-1.5">
                <Label>Coordinator</Label>
                {coordinatorCandidates.length > 0 ? (
                  <ToggleGroup
                    aria-label="Coordinator"
                    variant="segmented"
                    value={[coordinatorMode]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "new" || value === "existing") setCoordinatorMode(value);
                    }}
                  >
                    <Toggle value="new">New thread</Toggle>
                    <Toggle value="existing">Existing thread</Toggle>
                  </ToggleGroup>
                ) : null}
                {existingCoordinator !== null ? (
                  <>
                    <Select
                      value={existingCoordinator.id}
                      items={Object.fromEntries(
                        coordinatorCandidates.map((thread) => [thread.id, thread.title]),
                      )}
                      onValueChange={(value) => {
                        if (value) setChosenCoordinatorId(value as ThreadId);
                      }}
                    >
                      <SelectTrigger aria-label="Coordinator thread">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {coordinatorCandidates.map((thread) => (
                          <SelectItem key={thread.id} value={thread.id}>
                            {thread.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <p className="text-muted-foreground">
                      Its history carries over and it becomes the coordinator.
                    </p>
                  </>
                ) : null}
                <p className="text-muted-foreground">
                  {summary.agents} {summary.agents === 1 ? "thread" : "threads"} in this folder
                  {summary.agents === 1 ? " becomes an agent" : " become agents"}
                  {summary.standing > 0 ? ` (${summary.standing} pinned stay standing)` : ""}.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label>
                {existingCoordinator !== null ? "Default model for new agents" : "Model"}
              </Label>
              {modelSelection !== null ? (
                <ProviderModelPicker
                  activeInstanceId={modelSelection.instanceId}
                  model={modelSelection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptions}
                  triggerVariant="outline"
                  triggerClassName="w-full justify-between"
                  onInstanceModelChange={(instanceId, model) =>
                    setChosenModel(createModelSelection(instanceId, model))
                  }
                />
              ) : (
                <p className="text-muted-foreground">No providers available.</p>
              )}
            </div>

            {hasAgentsFile ? (
              <div className="flex flex-col gap-1.5">
                <Label>Shared instructions (coordinator and all agents)</Label>
                <p className="text-muted-foreground">AGENTS.md exists and is kept.</p>
              </div>
            ) : (
              <Field
                label="Shared instructions (coordinator and all agents)"
                htmlFor={`${id}-instructions`}
                hint="Saved as AGENTS.md in the folder."
              >
                <Textarea
                  id={`${id}-instructions`}
                  rows={4}
                  placeholder="Write concisely. Cite sources. Never send email or spend money without asking."
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </Field>
            )}

            {blocker !== null && folder.kind !== "error" && !isAlreadyProject ? (
              <p role="alert" className="text-destructive">
                {blocker}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {convertsWorkspace ? "Convert" : "Create Project"}
            </Button>
          </DialogFooter>
        </form>
        {iconPickerOpen ? (
          <Suspense fallback={null}>
            <ProjectIconPickerDialog
              current={icon}
              projectName={trimmedName || "Project"}
              open
              onOpenChange={setIconPickerOpen}
              onSelect={setChosenIcon}
            />
          </Suspense>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", props.className)}>
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
      {props.hint ? <p className="text-muted-foreground text-xs">{props.hint}</p> : null}
    </div>
  );
}
