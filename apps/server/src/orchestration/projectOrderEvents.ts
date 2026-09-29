/**
 * A `project.meta-updated` payload that only arranges the sidebar. Reactors that reconcile
 * schedules or held runs on project edits skip these: a drag must not re-apply OS schedule
 * entries, and a seed writes one per project.
 */
export function isProjectReorderOnlyPayload(payload: object): boolean {
  return Object.keys(payload).every(
    (key) => key === "projectId" || key === "orderKey" || key === "updatedAt",
  );
}
