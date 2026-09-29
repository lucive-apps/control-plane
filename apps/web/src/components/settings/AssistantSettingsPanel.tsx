import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isArchivedAssistant, type ProjectIconOverride } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ArchiveX, FolderOpenIcon, FolderTreeIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useRightPanelStore } from "../../rightPanelStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { openDeleteProject } from "../assistants/assistantDialogStore";
import { useAssistantActions } from "../assistants/useAssistantActions";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

/**
 * Project settings (mock frame 7). A Project is a single workspace, so every
 * edit targets its one project record; its default model is the project's
 * settings override, the same value the composer uses for new agents.
 */
export function AssistantSettingsPanel({ group }: { group: SidebarProjectSnapshot }) {
  const project = group.memberProjects[0]!;
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  const navigate = useNavigate();
  const actions = useAssistantActions();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const { environments } = useEnvironments();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const nameEditedRef = useRef(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  const providers =
    environments.find((environment) => environment.environmentId === project.environmentId)
      ?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const coordinatorThreadId = project.assistant?.coordinatorThreadId ?? null;
  const canOpenFolder = actions.canOpenFolder(project.environmentId);
  const isArchived = isArchivedAssistant(project);

  const setIcon = async (projectIcon: ProjectIconOverride) => {
    const result = await updateProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, faviconPath: null, projectIcon },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update Project icon",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const openSharedInstructions = async () => {
    if (coordinatorThreadId === null) return;
    const threadRef = scopeThreadRef(project.environmentId, coordinatorThreadId);
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    useRightPanelStore.getState().openFile(threadRef, "AGENTS.md");
  };

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <SettingsSection id="project-overview" title="Project" hideTitle>
          <SettingsRow
            title="Name"
            description="The Project name. Its coordinator thread always carries it."
            control={
              <Input
                key={`${group.projectKey}:${project.title}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                defaultValue={project.title}
                onChange={() => {
                  nameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  if (!nameEditedRef.current) return;
                  nameEditedRef.current = false;
                  void actions.rename(projectRef, event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Icon"
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={project} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a Project icon"
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Folder"
            description={project.workspaceRoot}
            control={
              canOpenFolder ? (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void actions.openFolder(project)}
                >
                  <FolderOpenIcon />
                  Open folder
                </Button>
              ) : null
            }
          />
          <SettingsRow
            title="Default model for new agents"
            description="The coordinator's own model is changed in its composer."
            control={
              selection ? (
                <ProviderModelPicker
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptions}
                  triggerVariant="outline"
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    updateSettings({
                      defaultModelSelection: createModelSelection(instanceId, model),
                    })
                  }
                />
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            title="Shared instructions"
            description="AGENTS.md, read by the coordinator and every agent."
            control={
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={coordinatorThreadId === null}
                onClick={() => void openSharedInstructions()}
              >
                Open
              </Button>
            }
          />
        </SettingsSection>
        <SettingsSection title="Danger zone">
          {isArchived ? (
            <SettingsRow
              title="Unarchive Project"
              description="Returns it to the sidebar and the command palette."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void actions.unarchive(projectRef)}
                >
                  <ArchiveX />
                  Unarchive
                </Button>
              }
            />
          ) : (
            <SettingsRow
              title="Archive Project"
              description="Stops its agents and hides it from the sidebar. Files stay."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void actions.archive(projectRef)}
                >
                  <ArchiveIcon />
                  Archive
                </Button>
              }
            />
          )}
          <SettingsRow
            title="Move to Tasks"
            description="Makes it a plain workspace again. Its threads stay, as ordinary threads."
            control={
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void actions.moveToTasks(project)}
              >
                <FolderTreeIcon />
                Move to Tasks
              </Button>
            }
          />
          <SettingsRow
            title="Delete Project"
            description="Deletes the coordinator and all agent threads. Files on disk stay."
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                type="button"
                onClick={() => openDeleteProject(projectRef)}
              >
                <Trash2Icon />
                Delete
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={project.projectIcon ?? null}
            projectName={project.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setIcon(icon)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
