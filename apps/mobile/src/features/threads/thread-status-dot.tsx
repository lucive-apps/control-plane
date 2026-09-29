import type { SidebarRollupStatus } from "@t3tools/client-runtime/state/assistant-lists";
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

const UNREAD_DOT = { label: "Unread completion", color: "#10b981" } as const;

/** The static dot of a Project row or a collapsed section or folder. Null draws none. */
export function rollupDotColor(status: SidebarRollupStatus): string | null {
  if (status === null) return null;
  return status === "unread" ? UNREAD_DOT.color : STATUS_DOTS[status].color;
}

/** What that dot says to a screen reader; null when it draws none. */
export function rollupDotLabel(status: SidebarRollupStatus): string | null {
  if (status === null) return null;
  const dot = status === "unread" ? UNREAD_DOT : STATUS_DOTS[status];
  return dot.color === null ? null : dot.label;
}

export function useThreadStatusDot(thread: EnvironmentThreadShell) {
  const threadKey = `${thread.environmentId}:${thread.id}`;
  const getVisit = useCallback(() => getThreadVisitMap()[threadKey], [threadKey]);
  const lastVisitedAt = useSyncExternalStore(subscribeThreadVisits, getVisit);
  const status = resolveSidebarThreadStatus(thread);
  if (status === "ready" && hasUnseenCompletion({ latestTurn: thread.latestTurn, lastVisitedAt })) {
    return UNREAD_DOT;
  }
  return STATUS_DOTS[status];
}

const GROUPED_DOT_STYLE = { width: 7, height: 7, borderRadius: 3.5 } as const;

/**
 * The parent row announces the status alongside its title. `grouped` draws the
 * bare 7pt dot of the grouped Home cards instead of the 16pt slot.
 */
export function ThreadStatusDot({
  color,
  grouped = false,
}: {
  readonly color: string | null;
  readonly grouped?: boolean;
}) {
  if (grouped) {
    return (
      <View
        accessible={false}
        className={color === null ? "shrink-0 bg-foreground-muted/40" : "shrink-0"}
        style={
          color === null ? GROUPED_DOT_STYLE : { ...GROUPED_DOT_STYLE, backgroundColor: color }
        }
      />
    );
  }
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
