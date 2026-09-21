import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadStatus } from "../threads/threadPresentation";

export function classifyHomeThread(
  thread: EnvironmentThreadShell,
  lastVisitedAt?: string,
): "working" | "attention" | null {
  if (thread.settledOverride === "settled") return null;
  const status = resolveThreadStatus(thread);
  if (status?.kind === "working" || status?.kind === "connecting") return "working";
  if (
    status?.kind === "awaiting-input" ||
    status?.kind === "pending-approval" ||
    status?.kind === "plan-ready" ||
    status?.kind === "error"
  ) {
    return "attention";
  }
  const completedAt = thread.latestTurn?.completedAt;
  if (!completedAt || thread.session?.status === "running") return null;
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs)) return null;
  if (lastVisitedAt === undefined) return "attention";
  const visitedMs = Date.parse(lastVisitedAt);
  if (!Number.isFinite(visitedMs) || completedMs > visitedMs) return "attention";
  return null;
}
