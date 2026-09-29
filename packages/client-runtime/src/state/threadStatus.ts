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

// Most urgent first. Failed sits below working so a live turn elsewhere in a
// group still reads as work in progress.
const ROLLUP_PRIORITY: readonly SidebarThreadStatus[] = [
  "approval",
  "input",
  "working",
  "failed",
  "monitoring",
  "ready",
];

/**
 * The most urgent status in a group of threads (a collapsed folder, a
 * Project), or null for an empty group. A roll-up is static: callers never
 * pulse its dot.
 */
export function rollupSidebarThreadStatus(
  statuses: Iterable<SidebarThreadStatus>,
): SidebarThreadStatus | null {
  let rollup: SidebarThreadStatus | null = null;
  let rank = ROLLUP_PRIORITY.length;
  for (const status of statuses) {
    const statusRank = ROLLUP_PRIORITY.indexOf(status);
    if (statusRank < rank) {
      rollup = status;
      rank = statusRank;
      if (rank === 0) break;
    }
  }
  return rollup;
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
