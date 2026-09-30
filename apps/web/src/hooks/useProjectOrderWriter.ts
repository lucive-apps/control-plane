import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ProjectOrderWrite } from "../components/sidebar/projectArrange";
import { toastManager } from "../components/ui/toast";
import { holdProjectOrder } from "../projectOrderOverrides";
import { readEnvironmentSupportsProjectReorder } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Writes order keys to the servers that own the projects. A drop shows at once (see
 * `holdProjectOrder`) and rolls back if a write fails. A seed (`ifKeyless`) is silent: a
 * server that already holds an arrangement refuses it, which is the expected outcome.
 */
export function useProjectOrderWriter() {
  const reorderProject = useAtomCommand(projectEnvironment.reorder, { reportFailure: false });
  return useCallback(
    async (
      writes: readonly ProjectOrderWrite[],
      options: { readonly ifKeyless?: boolean } = {},
    ): Promise<boolean> => {
      const supported = writes.filter((write) =>
        readEnvironmentSupportsProjectReorder(write.environmentId as EnvironmentId),
      );
      if (supported.length === 0) return false;
      const seeding = options.ifKeyless === true;
      const hold = seeding ? null : holdProjectOrder(supported);
      let succeeded = true;
      for (const write of supported) {
        const result = await reorderProject({
          environmentId: write.environmentId as EnvironmentId,
          input: {
            projectId: ProjectId.make(write.projectId),
            orderKey: write.orderKey,
            ...(seeding ? { ifKeyless: true as const } : {}),
          },
        });
        if (result._tag === "Success") continue;
        succeeded = false;
        if (seeding) continue;
        hold?.release();
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to reorder",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return false;
      }
      hold?.releaseSoon();
      return succeeded;
    },
    [reorderProject],
  );
}
