import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  countRunningAgents,
  rollupAssistantStatus,
} from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-status";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";

export type AssistantRollupStatus = SidebarThreadStatus | "unread" | null;

// The sidebar's status hues (amber approval, indigo input, sky working, red
// failed, emerald unread), so a Project reads the same color as its threads.
const DOT_PRESENTATION: Record<Exclude<AssistantRollupStatus, null>, [string, string]> = {
  approval: ["bg-amber-500", "Needs approval"],
  input: ["bg-indigo-500", "Needs input"],
  working: ["bg-sky-500", "Working"],
  monitoring: ["bg-sky-500", "Monitoring"],
  failed: ["bg-red-500", "Failed"],
  unread: ["bg-emerald-500", "Unread"],
  ready: ["bg-muted-foreground/40", "Ready"],
};

/** A Project's rolled-up status. Static on purpose: a roll-up never pulses. */
export function AssistantStatusDot(props: {
  readonly status: AssistantRollupStatus;
  readonly className?: string;
}) {
  const [colorClassName, label] = DOT_PRESENTATION[props.status ?? "ready"];
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("size-1.5 shrink-0 rounded-full", colorClassName, props.className)}
    />
  );
}

/** The dot and "N running" for a Project's coordinator and agents. */
export function useAssistantRollup(entry: {
  readonly coordinator: EnvironmentThreadShell | null;
  readonly agents: readonly EnvironmentThreadShell[];
}): { readonly status: AssistantRollupStatus; readonly running: number } {
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return useMemo(() => {
    const isUnread = (thread: EnvironmentThreadShell) =>
      hasUnseenCompletion({
        latestTurn: thread.latestTurn,
        lastVisitedAt:
          lastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      });
    const threads = entry.coordinator ? [entry.coordinator, ...entry.agents] : entry.agents;
    return {
      status: rollupAssistantStatus({
        statuses: threads.map(resolveSidebarThreadStatus),
        coordinatorUnread: entry.coordinator !== null && isUnread(entry.coordinator),
        agentsUnread: entry.agents.some(isUnread),
      }),
      running: countRunningAgents(entry.agents),
    };
  }, [entry.agents, entry.coordinator, lastVisitedAtById]);
}

/** "N running" (hidden at 0) and the rolled-up dot, as the palette shows a Project. */
export function AssistantRollupBadge(props: {
  readonly entry: {
    readonly coordinator: EnvironmentThreadShell | null;
    readonly agents: readonly EnvironmentThreadShell[];
  };
}) {
  const { status, running } = useAssistantRollup(props.entry);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {running > 0 ? `${running} running` : null}
      <AssistantStatusDot status={status} />
    </span>
  );
}
