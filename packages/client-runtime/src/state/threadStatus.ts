import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

type SidebarThreadStatusInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must
  // see the failure, not a stale Working (review finding).
  if (thread.session?.status === "error") {
    return "failed";
  }
  // Background work outlives the turn: fleets read as working; monitoring
  // only when watch loops are the sole live work.
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}

export function hasUnseenCompletion(
  thread: Pick<OrchestrationThreadShell, "latestTurn"> & { lastVisitedAt?: string | undefined },
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}
