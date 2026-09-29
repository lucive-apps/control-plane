import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildScheduleInputs,
  scheduleRunNotice,
  type ScheduleDraft,
  type ScheduleListChange,
} from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { confirm, reportResult } from "./useProjectActions";

// Fork-owned. The mobile counterpart of web `useScheduleActions`. A write
// sends the Project's whole list through `project.meta.update`, built from the
// latest shell and echoing each entry's `updatedAt`, so the server refuses a
// write built from a stale list instead of overwriting a newer change.

export interface ScheduleProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function useScheduleActions() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const runSchedule = useAtomCommand(projectEnvironment.schedulesRun, { reportFailure: false });

  return useMemo(() => {
    const apply = async (
      ref: ScheduleProjectRef,
      change: ScheduleListChange,
      failureTitle: string,
    ): Promise<boolean> => {
      const project = appAtomRegistry.get(
        environmentProjects.projectAtom(scopeProjectRef(ref.environmentId, ref.projectId)),
      );
      const schedules = buildScheduleInputs(project?.assistant?.schedules ?? [], change);
      return reportResult(
        await updateProject({
          environmentId: ref.environmentId,
          input: { projectId: ref.projectId, assistant: { schedules } },
        }),
        failureTitle,
        "The schedules could not be saved.",
      );
    };

    return {
      save: (ref: ScheduleProjectRef, schedule: ScheduleDraft) =>
        apply(ref, { kind: "save", schedule }, "Could not save the schedule"),

      setEnabled: (ref: ScheduleProjectRef, id: string, enabled: boolean) =>
        apply(
          ref,
          { kind: "set-enabled", ids: [id], enabled },
          enabled ? "Could not resume the schedule" : "Could not pause the schedule",
        ),

      /** Asks first; true once deleted. */
      remove: async (
        ref: ScheduleProjectRef,
        schedule: { readonly id: string; readonly name: string },
      ): Promise<boolean> => {
        const confirmed = await confirm({
          title: `Delete "${schedule.name}"?`,
          message: "The schedule stops running and its prompt is deleted.",
          confirmText: "Delete",
          destructive: true,
        });
        if (!confirmed) return false;
        return apply(ref, { kind: "delete", id: schedule.id }, "Could not delete the schedule");
      },

      /**
       * Runs one schedule now. A busy target holds it for up to 15 minutes,
       * which the row shows once status is read again; only a miss alerts.
       */
      runNow: async (
        ref: ScheduleProjectRef,
        scheduleId: string,
        targetTitle: string,
      ): Promise<void> => {
        const result = await runSchedule({
          environmentId: ref.environmentId,
          input: { projectId: ref.projectId, scheduleId },
        });
        if (!reportResult(result, "Could not run the schedule", "The schedule could not run.")) {
          return;
        }
        if (result._tag !== "Success") return;
        const notice = scheduleRunNotice(result.value, targetTitle);
        if (notice?.tone === "warning") Alert.alert(notice.title, notice.description);
      },
    };
  }, [runSchedule, updateProject]);
}
