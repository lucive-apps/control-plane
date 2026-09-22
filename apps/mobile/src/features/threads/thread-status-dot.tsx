import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-status";
import { useCallback, useSyncExternalStore } from "react";
import { View } from "react-native";

import { getThreadVisitMap, subscribeThreadVisits } from "../../state/thread-visits";

const STATUS_DOTS = {
  approval: { label: "Approval", color: "#f59e0b" },
  input: { label: "Input", color: "#6366f1" },
  working: { label: "Working", color: "#0ea5e9" },
  monitoring: { label: "Monitoring", color: "#0ea5e9" },
  failed: { label: "Failed", color: "#ef4444" },
  ready: { label: "Ready", color: null },
} as const;

export function useThreadStatusDot(thread: EnvironmentThreadShell) {
  const threadKey = `${thread.environmentId}:${thread.id}`;
  const getVisit = useCallback(() => getThreadVisitMap()[threadKey], [threadKey]);
  const lastVisitedAt = useSyncExternalStore(subscribeThreadVisits, getVisit);
  const status = resolveSidebarThreadStatus(thread);
  if (status === "ready" && hasUnseenCompletion({ latestTurn: thread.latestTurn, lastVisitedAt })) {
    return { label: "Unread completion", color: "#10b981" };
  }
  return STATUS_DOTS[status];
}

/** The parent row announces the status alongside its title. */
export function ThreadStatusDot({ color }: { readonly color: string | null }) {
  return (
    <View className="size-4 shrink-0 items-center justify-center" accessible={false}>
      <View
        className={
          color === null ? "size-1.5 rounded-full bg-foreground-muted/40" : "size-1.5 rounded-full"
        }
        style={color === null ? undefined : { backgroundColor: color }}
      />
    </View>
  );
}
