import { planDefaultModelOverridePatch } from "@t3tools/client-runtime/state/assistant-flows";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scheduleDeletionWarning } from "@t3tools/client-runtime/state/schedules";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isRunningAgent, type ModelSelection, type ProjectIconOverride } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useMemo } from "react";
import { Alert, Platform } from "react-native";

import { showConfirmDialog, showTextInputDialog } from "../../components/ConfirmDialogHost";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppNavigation } from "../threads/sidebar-navigation-shell";
import { leadingEmoji, matchesProjectName, type ProjectMenuAction } from "./projectMenus";

// Fork-owned. The mobile counterpart of web `useAssistantActions`. Each action
// is one dispatch or one navigation; the server does the title, pin and
// session bookkeeping (archiving a Project stops its sessions server-side).

export type ProjectActionTarget = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "projectIcon" | "assistant"
>;

/** The Project files mobile opens in the file sheet. */
export type ProjectFilePath = "MEMORY.md" | "AGENTS.md";

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  if (result._tag !== "Failure") return fallback;
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/** Alerts on failure (not on interruption); true when the command succeeded. */
export function reportResult(
  result: AtomCommandResult<unknown, unknown>,
  title: string,
  fallback: string,
): boolean {
  if (result._tag !== "Failure") return true;
  if (!isAtomCommandInterrupted(result)) Alert.alert(title, failureMessage(result, fallback));
  return false;
}

export function confirm(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      Alert.alert(input.title, input.message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: input.confirmText,
          style: input.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ]);
      return;
    }
    showConfirmDialog({
      title: input.title,
      message: input.message,
      confirmText: input.confirmText,
      ...(input.destructive ? { destructive: true } : {}),
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/** A one-line text prompt. Resolves null when cancelled. */
function promptText(input: {
  readonly title: string;
  readonly message?: string;
  readonly initialValue: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      Alert.prompt(
        input.title,
        input.message,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
          {
            text: input.confirmText,
            style: input.destructive ? "destructive" : "default",
            onPress: (value?: string) => resolve(value ?? ""),
          },
        ],
        "plain-text",
        input.initialValue,
      );
      return;
    }
    showTextInputDialog({
      title: input.title,
      ...(input.message === undefined ? {} : { message: input.message }),
      initialValue: input.initialValue,
      confirmText: input.confirmText,
      ...(input.destructive ? { destructive: true } : {}),
      onConfirm: resolve,
      onCancel: () => resolve(null),
    });
  });
}

function projectThreads(project: ProjectActionTarget): EnvironmentThreadShell[] {
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter(
      (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
    );
}

function agentCount(project: ProjectActionTarget): number {
  const coordinatorThreadId = project.assistant?.coordinatorThreadId;
  return projectThreads(project).filter((thread) => thread.id !== coordinatorThreadId).length;
}

/**
 * Project actions for the Home rows, Project settings and the coordinator
 * header. Self-contained (dispatch plus navigation), so callers pass only
 * the Project or thread.
 */
export function useProjectActions() {
  // The Home rows also render in the iPad sidebar's independent nav tree.
  const navigation = useAppNavigation();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  return useMemo(() => {
    const updateAssistant = async (
      project: ProjectActionTarget,
      assistant: { readonly archived: boolean } | null,
      failureTitle: string,
    ) =>
      reportResult(
        await updateProject({
          environmentId: project.environmentId,
          input: { projectId: project.id, assistant },
        }),
        failureTitle,
        "The Project could not be updated.",
      );

    const writeIcon = async (
      project: ProjectActionTarget,
      projectIcon: ProjectIconOverride | null,
    ): Promise<boolean> => {
      if (JSON.stringify(projectIcon) === JSON.stringify(project.projectIcon ?? null)) {
        return true;
      }
      return reportResult(
        await updateProject({
          environmentId: project.environmentId,
          input: { projectId: project.id, faviconPath: null, projectIcon },
        }),
        "Could not change the icon",
        "The Project icon could not be changed.",
      );
    };

    return {
      /** Prompts for a new name; the server retitles the coordinator to match. */
      rename: async (project: ProjectActionTarget): Promise<boolean> => {
        const value = await promptText({
          title: "Rename Project",
          initialValue: project.title,
          confirmText: "Rename",
        });
        if (value === null) return false;
        const title = value.trim();
        if (title.length === 0) {
          Alert.alert("Could not rename Project", "Project name cannot be empty.");
          return false;
        }
        if (title === project.title) return true;
        return reportResult(
          await updateProject({
            environmentId: project.environmentId,
            input: { projectId: project.id, title },
          }),
          "Could not rename Project",
          "The Project could not be renamed.",
        );
      },

      /**
       * Prompts for one emoji and keeps its first one, as web does. An empty
       * answer changes nothing ("Use automatic icon" is `resetIcon`). Clears
       * any favicon, as on web.
       */
      setIcon: async (project: ProjectActionTarget): Promise<boolean> => {
        const current = project.projectIcon?.kind === "emoji" ? project.projectIcon.emoji : "";
        const value = await promptText({
          title: "Project icon",
          message: "Type one emoji.",
          initialValue: current,
          confirmText: "Save",
        });
        if (value === null || value.trim().length === 0) return false;
        const emoji = leadingEmoji(value);
        if (emoji === null) {
          Alert.alert("Could not change the icon", "Type one emoji to use as the Project icon.");
          return false;
        }
        return writeIcon(project, { kind: "emoji", emoji });
      },

      /** Back to the automatic icon (a monogram of the name). */
      resetIcon: (project: ProjectActionTarget) => writeIcon(project, null),

      /**
       * The default model for new agents. Writes only the project settings
       * override when the host resolves overrides (as web does); older hosts
       * read the project's own field.
       */
      setDefaultModel: async (
        project: ProjectActionTarget,
        modelSelection: ModelSelection,
      ): Promise<boolean> => {
        const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
        const result =
          config?.environment.capabilities.projectSettingsOverrides === true
            ? await updateSettings({
                environmentId: project.environmentId,
                input: {
                  patch: planDefaultModelOverridePatch({
                    overrides: config.settings.projectSettingsOverrides,
                    projectId: project.id,
                    modelSelection,
                  }),
                },
              })
            : await updateProject({
                environmentId: project.environmentId,
                input: { projectId: project.id, defaultModelSelection: modelSelection },
              });
        return reportResult(
          result,
          "Could not change the model",
          "The default model could not be saved.",
        );
      },

      openSettings: (project: ProjectActionTarget) =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: {
            screen: "SettingsProject",
            params: {
              environmentId: String(project.environmentId),
              projectId: String(project.id),
            },
          },
        }),

      /** The composer on the Project folder; a Project draft always starts Local. */
      newAgent: (project: ProjectActionTarget) =>
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        }),

      /** Archiving stops the Project's sessions, so a running one asks first. */
      archive: async (project: ProjectActionTarget): Promise<boolean> => {
        const running = projectThreads(project).filter(isRunningAgent).length;
        if (running > 0) {
          const confirmed = await confirm({
            title: `Archive "${project.title}"?`,
            message: `${running} ${running === 1 ? "agent is" : "agents are"} running. Archiving stops ${running === 1 ? "it" : "them"}. Files stay.`,
            confirmText: "Archive",
            destructive: true,
          });
          if (!confirmed) return false;
        }
        return updateAssistant(project, { archived: true }, "Could not archive Project");
      },

      unarchive: (project: ProjectActionTarget) =>
        updateAssistant(project, { archived: false }, "Could not unarchive Project"),

      moveToTasks: async (project: ProjectActionTarget): Promise<boolean> => {
        const scheduleWarning = scheduleDeletionWarning(project.assistant);
        const confirmed = await confirm({
          title: `Move "${project.title}" to Tasks?`,
          message: [
            "It becomes a plain workspace: the coordinator and agents stay as ordinary threads, and the files stay on disk.",
            ...(scheduleWarning === null ? [] : [scheduleWarning]),
          ].join(" "),
          confirmText: "Move to Tasks",
        });
        if (!confirmed) return false;
        return updateAssistant(project, null, "Could not move Project to Tasks");
      },

      /**
       * Typed-name confirmation, then one force delete. Files on disk stay.
       * Resolves true once deleted, so a settings screen can pop.
       */
      requestDelete: async (project: ProjectActionTarget): Promise<boolean> => {
        const agents = agentCount(project);
        const typed = await promptText({
          title: `Delete "${project.title}"?`,
          message: `Deletes its coordinator and ${agents} agent ${agents === 1 ? "thread" : "threads"}. Files on disk stay. Type the Project name to confirm.`,
          initialValue: "",
          confirmText: "Delete",
          destructive: true,
        });
        if (typed === null) return false;
        if (!matchesProjectName(typed, project.title)) {
          Alert.alert(
            "Name does not match",
            `Type "${project.title}" exactly to delete this Project.`,
          );
          return false;
        }
        return reportResult(
          await deleteProject({
            environmentId: project.environmentId,
            input: { projectId: project.id, force: true },
          }),
          "Could not delete Project",
          "The Project could not be deleted.",
        );
      },

      /** Promotes a Local agent; the old coordinator stays as a pinned agent. */
      setCoordinator: async (thread: EnvironmentThreadShell): Promise<boolean> => {
        if (thread.worktreePath !== null) {
          Alert.alert(
            "Could not set the coordinator",
            "Only a Local thread can be the coordinator.",
          );
          return false;
        }
        const confirmed = await confirm({
          title: `Make "${thread.title}" the coordinator?`,
          message:
            "It takes the Project name. The current coordinator stays as a pinned agent, so you can switch back.",
          confirmText: "Set as coordinator",
        });
        if (!confirmed) return false;
        return reportResult(
          await updateProject({
            environmentId: thread.environmentId,
            input: { projectId: thread.projectId, assistant: { coordinatorThreadId: thread.id } },
          }),
          "Could not set the coordinator",
          "The coordinator could not be changed.",
        );
      },

      stopAgent: async (thread: EnvironmentThreadShell): Promise<boolean> =>
        reportResult(
          await stopSession({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          }),
          "Could not stop agent",
          "The agent could not be stopped.",
        ),

      openProjectFile: (project: ProjectActionTarget, path: ProjectFilePath) =>
        navigation.navigate("ProjectSheet", {
          screen: "ProjectFile",
          params: {
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            path,
          },
        }),

      /** The Schedules sheet over the workspace, from the coordinator header and the Home row. */
      openSchedules: (project: ProjectActionTarget) =>
        navigation.navigate("ProjectSheet", {
          screen: "ProjectSchedules",
          params: {
            environmentId: String(project.environmentId),
            projectId: String(project.id),
          },
        }),
    };
  }, [deleteProject, navigation, stopSession, updateProject, updateSettings]);
}

export type ProjectActions = ReturnType<typeof useProjectActions>;

/**
 * Runs a Project menu item (New agent is the caller's). Resolves true once
 * the action went through, so the coordinator header can leave after Delete.
 */
export async function runProjectMenuAction(
  actions: ProjectActions,
  project: ProjectActionTarget,
  action: Exclude<ProjectMenuAction, "new-agent">,
): Promise<boolean> {
  switch (action) {
    case "rename":
      return actions.rename(project);
    case "settings":
      actions.openSettings(project);
      return true;
    case "schedules":
      actions.openSchedules(project);
      return true;
    case "archive":
      return actions.archive(project);
    case "unarchive":
      return actions.unarchive(project);
    case "move-to-tasks":
      return actions.moveToTasks(project);
    case "delete":
      return actions.requestDelete(project);
  }
}
