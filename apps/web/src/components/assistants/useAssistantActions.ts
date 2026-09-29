import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectAssistantPatch,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readLocalApi } from "../../localApi";
import { useRightPanelStore } from "../../rightPanelStore";
import { readProject, readThreadShell, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { shellEnvironment } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openDeleteProject } from "./assistantDialogStore";
import {
  buildAssistantProjectMenuItems,
  isAssistantProjectMenuAction,
} from "./assistantMenu.logic";

export type AssistantActionProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot" | "assistant"
>;

/** Toasts a failed command under `title`. True when the command failed. */
export function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
  return true;
}

export async function confirm(message: string, destructive = false): Promise<boolean> {
  const api = readLocalApi();
  if (!api) return false;
  const result = await settlePromise(() =>
    api.dialogs.confirm(message, destructive ? { variant: "destructive" } : undefined),
  );
  return result._tag === "Success" && result.value;
}

/**
 * Project actions shared by the sidebar row, the coordinator crumb, the
 * palette and Project settings. Each is one dispatch; the server does the
 * title, pin and session bookkeeping.
 */
export function useAssistantActions() {
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  const updateAssistant = useCallback(
    async (
      projectRef: ScopedProjectRef,
      assistant: ProjectAssistantPatch | null,
      failureTitle: string,
    ): Promise<boolean> => {
      const result = await updateProject({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, assistant },
      });
      return !reportFailure(failureTitle, result);
    },
    [updateProject],
  );

  return useMemo(
    () => ({
      /** Rename the Project; the server retitles its coordinator to match. */
      rename: async (projectRef: ScopedProjectRef, nextTitle: string): Promise<boolean> => {
        const title = nextTitle.trim();
        if (title.length === 0) {
          toastManager.add({ type: "warning", title: "Project name cannot be empty" });
          return false;
        }
        if (readProject(projectRef)?.title === title) return true;
        const result = await updateProject({
          environmentId: projectRef.environmentId,
          input: { projectId: projectRef.projectId, title },
        });
        return !reportFailure("Failed to rename Project", result);
      },
      openSettings: (project: AssistantActionProject) =>
        navigate({
          to: "/projects/$projectKey",
          params: { projectKey: derivePhysicalProjectKey(project) },
        }),
      /** The Project's server stores schedules; absent on older and upstream servers. */
      canSchedule: (environmentId: EnvironmentId): boolean =>
        serverConfigs.get(environmentId)?.environment.capabilities.projectSchedules !== undefined,
      /** Opens the Schedules panel beside the coordinator. */
      openSchedules: async (project: AssistantActionProject): Promise<void> => {
        const coordinatorThreadId = project.assistant?.coordinatorThreadId;
        if (coordinatorThreadId === undefined) return;
        const threadRef = scopeThreadRef(project.environmentId, coordinatorThreadId);
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        useRightPanelStore.getState().open(threadRef, "schedules");
      },
      canOpenFolder: (environmentId: EnvironmentId): boolean =>
        serverConfigs.get(environmentId)?.availableEditors.includes("file-manager") === true,
      openFolder: async (project: AssistantActionProject): Promise<void> => {
        const result = await openInEditor({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot, editor: "file-manager" },
        });
        reportFailure("Could not open the Project folder", result);
      },
      archive: (projectRef: ScopedProjectRef) =>
        updateAssistant(projectRef, { archived: true }, "Failed to archive Project"),
      unarchive: (projectRef: ScopedProjectRef) =>
        updateAssistant(projectRef, { archived: false }, "Failed to unarchive Project"),
      moveToTasks: async (project: AssistantActionProject): Promise<boolean> => {
        const scheduleCount = project.assistant?.schedules?.length ?? 0;
        const confirmed = await confirm(
          [
            `Move "${project.title}" to Tasks?`,
            "It becomes a plain workspace: the coordinator and agents stay as ordinary threads, and the files stay on disk.",
            ...(scheduleCount > 0
              ? [
                  `${scheduleCount} ${scheduleCount === 1 ? "schedule" : "schedules"} will be deleted.`,
                ]
              : []),
          ].join("\n"),
        );
        if (!confirmed) return false;
        return updateAssistant(
          scopeProjectRef(project.environmentId, project.id),
          null,
          "Failed to move Project to Tasks",
        );
      },
      requestDelete: (projectRef: ScopedProjectRef) => openDeleteProject(projectRef),
      /** Promote a Local agent; the old coordinator stays as a pinned agent. */
      setCoordinator: async (threadRef: ScopedThreadRef): Promise<boolean> => {
        const thread = readThreadShell(threadRef);
        if (thread === null) return false;
        if (thread.worktreePath !== null) {
          toastManager.add({
            type: "warning",
            title: "Only a Local thread can be the coordinator",
          });
          return false;
        }
        const projectRef = scopeProjectRef(threadRef.environmentId, thread.projectId);
        const project = readProject(projectRef);
        const confirmed = await confirm(
          [
            `Make "${thread.title}" the coordinator of ${project?.title ?? "this Project"}?`,
            "It takes the Project name. The current coordinator stays as a pinned agent, so you can switch back.",
          ].join("\n"),
        );
        if (!confirmed) return false;
        return updateAssistant(
          projectRef,
          { coordinatorThreadId: threadRef.threadId },
          "Failed to set the coordinator",
        );
      },
      stopAgent: async (threadRef: ScopedThreadRef): Promise<boolean> => {
        const result = await stopSession({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
        return !reportFailure("Failed to stop agent", result);
      },
      newAgent: (projectRef: ScopedProjectRef) => handleNewThread(projectRef),
      openCoordinator: (project: AssistantActionProject) => {
        const coordinatorThreadId = project.assistant?.coordinatorThreadId;
        if (coordinatorThreadId === undefined) return Promise.resolve();
        return navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(project.environmentId, coordinatorThreadId),
          ),
        });
      },
    }),
    [
      handleNewThread,
      navigate,
      openInEditor,
      serverConfigs,
      stopSession,
      updateAssistant,
      updateProject,
    ],
  );
}

export type AssistantActions = ReturnType<typeof useAssistantActions>;

/**
 * Shows the Project menu (mock 6a) and routes the choice. Rename is inline
 * wherever the menu opens, so the caller supplies it.
 */
export function useAssistantProjectMenu() {
  const actions = useAssistantActions();
  return useCallback(
    async (input: {
      readonly project: AssistantActionProject;
      readonly position?: { readonly x: number; readonly y: number };
      readonly onRename: () => void;
    }): Promise<void> => {
      const api = readLocalApi();
      if (!api) return;
      const { project } = input;
      const clicked = await api.contextMenu.show(
        buildAssistantProjectMenuItems({
          canOpenFolder: actions.canOpenFolder(project.environmentId),
          canSchedule: actions.canSchedule(project.environmentId),
        }),
        input.position,
      );
      if (clicked === null || !isAssistantProjectMenuAction(clicked)) return;
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      switch (clicked) {
        case "rename":
          input.onRename();
          return;
        case "settings":
          await actions.openSettings(project);
          return;
        case "schedules":
          await actions.openSchedules(project);
          return;
        case "open-folder":
          await actions.openFolder(project);
          return;
        case "archive":
          await actions.archive(projectRef);
          return;
        case "move-to-tasks":
          await actions.moveToTasks(project);
          return;
        case "delete":
          actions.requestDelete(projectRef);
          return;
      }
    },
    [actions],
  );
}
