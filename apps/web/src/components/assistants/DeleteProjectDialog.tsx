import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { clearRemovedProjectLocalState } from "../../lib/composerDraftUploads";
import { useProject, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Typed-name confirmation, then one force delete. Files on disk are kept. */
export default function DeleteProjectDialog(props: {
  readonly projectRef: ScopedProjectRef;
  readonly onClose: () => void;
}) {
  const id = useId();
  const project = useProject(props.projectRef);
  const threads = useThreadShells();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const settingsProjectKey = useLocation({
    select: (location): string | null => {
      const key = (location.search as { readonly project?: unknown }).project;
      return typeof key === "string" ? key : null;
    },
  });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const [typedName, setTypedName] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const projectThreads = threads.filter(
    (thread) =>
      thread.environmentId === props.projectRef.environmentId &&
      thread.projectId === props.projectRef.projectId,
  );
  const agentCount = projectThreads.filter(
    (thread) => thread.id !== project?.assistant?.coordinatorThreadId,
  ).length;
  const name = project?.title ?? "";
  const canDelete = project !== null && typedName.trim() === name && !isDeleting;

  const submit = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    const result = await deleteProject({
      environmentId: props.projectRef.environmentId,
      input: { projectId: props.projectRef.projectId, force: true },
    });
    setIsDeleting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete Project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }
    const threadRefs = projectThreads.map((thread) =>
      scopeThreadRef(thread.environmentId, thread.id),
    );
    clearRemovedProjectLocalState(props.projectRef, threadRefs);
    props.onClose();
    const viewingProject = threadRefs.some(
      (ref) => pathname === `/${ref.environmentId}/${ref.threadId}`,
    );
    const viewingSettings =
      project !== null &&
      pathname.startsWith("/settings") &&
      settingsProjectKey === derivePhysicalProjectKey(project);
    if (viewingProject || viewingSettings) {
      void navigate({ to: "/", replace: true });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              {project === null
                ? "This Project no longer exists."
                : `Deletes "${name}", its coordinator and ${agentCount} agent ${agentCount === 1 ? "thread" : "threads"}. Files on disk stay.`}
            </DialogDescription>
          </DialogHeader>
          {project !== null ? (
            <DialogPanel className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Type the Project name to confirm</Label>
              <Input
                nativeInput
                id={`${id}-name`}
                autoComplete="off"
                autoFocus
                placeholder={name}
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
              />
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canDelete}>
              Delete
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
