import { lazy, Suspense } from "react";

import { useAssistantDialogStore } from "./assistantDialogStore";

// Loaded on first use: the dialogs pull in the model picker and form controls.
const NewProjectDialog = lazy(() => import("./NewProjectDialog"));
const DeleteProjectDialog = lazy(() => import("./DeleteProjectDialog"));

/** Renders the open Project dialog (New Project, Convert, Delete). */
export function AssistantDialogsHost() {
  const request = useAssistantDialogStore((state) => state.request);
  const close = useAssistantDialogStore((state) => state.close);
  if (request === null) return null;
  return (
    <Suspense fallback={null}>
      {request.kind === "delete" ? (
        <DeleteProjectDialog
          key={`${request.projectRef.environmentId}:${request.projectRef.projectId}`}
          projectRef={request.projectRef}
          onClose={close}
        />
      ) : (
        <NewProjectDialog
          key={
            request.kind === "convert"
              ? `convert:${request.projectRef.environmentId}:${request.projectRef.projectId}`
              : `new:${request.environmentId ?? ""}`
          }
          request={request}
          onClose={close}
        />
      )}
    </Suspense>
  );
}
