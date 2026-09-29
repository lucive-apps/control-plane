import {
  buildScheduleInputs,
  planPauseAllSchedules,
  type ScheduleDraft,
  type ScheduleListChange,
} from "@t3tools/client-runtime/state/schedules";
import type {
  EnvironmentId,
  ProjectId,
  ProjectScheduleInput,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { readProject, readProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { confirm as confirmAction, reportFailure } from "../assistants/useAssistantActions";
import { toastManager } from "../ui/toast";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Schedule writes and Run now. Writes send the Project's whole list through
 * `project.meta.update`, built from the latest shell, like M2's assistant patches.
 */
export function useScheduleActions() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const runSchedule = useAtomCommand(projectEnvironment.schedulesRun, { reportFailure: false });

  const write = useCallback(
    async (
      environmentId: EnvironmentId,
      projectId: ProjectId,
      schedules: ProjectScheduleInput[],
      failureTitle: string,
    ): Promise<boolean> => {
      const result = await updateProject({
        environmentId,
        input: { projectId, assistant: { schedules } },
      });
      return !reportFailure(failureTitle, result);
    },
    [updateProject],
  );

  return useMemo(() => {
    const apply = (projectRef: ScopedProjectRef, change: ScheduleListChange, failure: string) =>
      write(
        projectRef.environmentId,
        projectRef.projectId,
        buildScheduleInputs(readProject(projectRef)?.assistant?.schedules ?? [], change),
        failure,
      );
    return {
      save: (projectRef: ScopedProjectRef, schedule: ScheduleDraft) =>
        apply(projectRef, { kind: "save", schedule }, "Failed to save schedule"),
      setEnabled: (projectRef: ScopedProjectRef, id: string, enabled: boolean) =>
        apply(
          projectRef,
          { kind: "set-enabled", ids: [id], enabled },
          enabled ? "Failed to resume schedule" : "Failed to pause schedule",
        ),
      remove: async (
        projectRef: ScopedProjectRef,
        schedule: { readonly id: string; readonly name: string },
      ): Promise<boolean> => {
        if (!(await confirmAction(`Delete the schedule "${schedule.name}"?`, true))) return false;
        return apply(projectRef, { kind: "delete", id: schedule.id }, "Failed to delete schedule");
      },
      /** Runs one schedule now; a busy target holds it for up to 15 minutes. */
      runNow: async (
        projectRef: ScopedProjectRef,
        scheduleId: string,
        targetTitle: string,
      ): Promise<void> => {
        const result = await runSchedule({
          environmentId: projectRef.environmentId,
          input: { projectId: projectRef.projectId, scheduleId },
        });
        if (reportFailure("Could not run the schedule", result) || result._tag !== "Success") {
          return;
        }
        if (result.value.outcome === "held") {
          toastManager.add({ type: "info", title: `Queued until ${targetTitle} is idle` });
        } else if (result.value.outcome === "missed") {
          toastManager.add({
            type: "warning",
            title: "Schedule missed",
            description:
              result.value.reason === "target-missing"
                ? "The thread it runs in is gone. Edit the schedule to pick another."
                : "It could not start.",
          });
        }
      },
      /**
       * "Remove from this host": pauses every enabled schedule in the
       * environment's Projects, which empties the host's entry. Each row's
       * switch turns a schedule back on.
       */
      pauseAll: async (environmentId: EnvironmentId): Promise<void> => {
        const plan = planPauseAllSchedules(
          readProjects().filter((project) => project.environmentId === environmentId),
        );
        if (plan.scheduleCount === 0) {
          toastManager.add({ type: "info", title: "No schedules are on for this host." });
          return;
        }
        const confirmed = await confirmAction(
          [
            `Pause ${plural(plan.scheduleCount, "schedule")} in ${plural(plan.writes.length, "Project")}?`,
            "Turn each back on from its Schedules panel.",
          ].join("\n"),
        );
        if (!confirmed) return;
        for (const entry of plan.writes) {
          await write(environmentId, entry.projectId, entry.schedules, "Failed to pause schedules");
        }
      },
    };
  }, [runSchedule, write]);
}
