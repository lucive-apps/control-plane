/**
 * Pure rules for agents that run on a linked machine: when a request is done,
 * what phase an agent reads as, and how busy a machine is. Everything reads
 * the peer's own timestamps, never the home clock. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module remoteAgentState
 */
import {
  isRunningAgent,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { isAgentCountedRunning } from "../mcp/toolkits/agents/agentScope.ts";
import type { AgentResultOutcome } from "../orchestration/agentPushes.ts";
import type { AgentPhase } from "./agentPhase.ts";

/** The slice of a peer thread's shell the bridge reads. */
export type PeerThreadView = Pick<
  OrchestrationThreadShell,
  "latestTurn" | "session" | "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt"
>;

export type RequestVerdict =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "done";
      readonly outcome: AgentResultOutcome;
      /** The request never became a turn: the caller looks for the start failure's detail. */
      readonly startFailure: boolean;
    };

/** A stopped session with no turn this soon after the send may still be starting. */
export const REMOTE_START_GRACE_MS = 15_000;

/**
 * Whether the request in flight has finished. A request is matched to its
 * turn by `baselineTurnId`, the peer thread's latest turn before the request
 * was sent, because the peer stores its own message times and does not report
 * which message started a turn. `sentAgeMs` is measured on the home clock and
 * only bounds how long a stopped session may still be starting.
 */
export function judgeRequest(input: {
  readonly baselineTurnId: string | null;
  readonly thread: PeerThreadView;
  readonly sentAgeMs: number;
}): RequestVerdict {
  const { thread, baselineTurnId } = input;
  const status = thread.session?.status;
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    status === "starting" ||
    status === "running"
  ) {
    return { kind: "waiting" };
  }
  const turn = thread.latestTurn;
  if (turn !== null && turn.turnId !== baselineTurnId) {
    switch (turn.state) {
      case "running":
        return { kind: "waiting" };
      case "completed":
        return { kind: "done", outcome: { kind: "finished" }, startFailure: false };
      case "error":
        return {
          kind: "done",
          outcome: { kind: "failed", lastError: thread.session?.lastError ?? null },
          startFailure: false,
        };
      case "interrupted":
        return { kind: "done", outcome: { kind: "stopped" }, startFailure: false };
    }
  }
  // No turn took the request: the start failed, or the agent was stopped first.
  if (
    status === "error" ||
    ((status === "stopped" || status === "interrupted") && input.sentAgeMs > REMOTE_START_GRACE_MS)
  ) {
    return {
      kind: "done",
      outcome: { kind: "failed-to-start", detail: thread.session?.lastError ?? null },
      startFailure: true,
    };
  }
  return { kind: "waiting" };
}

/**
 * A remote agent's phase from its peer thread; `stale` when the machine is
 * unreachable. `requestPending` is a request in flight that `judgeRequest`
 * still reads as waiting, so a send the peer has not started yet reads as
 * starting.
 */
export function remotePhase(input: {
  readonly thread: PeerThreadView | null;
  readonly reachable: boolean;
  readonly requestPending: boolean;
}): AgentPhase {
  const { thread } = input;
  if (!input.reachable || thread === null) return "stale";
  if (thread.hasPendingApprovals) return "waiting_for_approval";
  if (thread.hasPendingUserInput) return "waiting_for_input";
  const status = thread.session?.status;
  if (status === "starting") return "starting";
  if (status === "running") return "running";
  if (input.requestPending) return "starting";
  if (thread.latestTurn?.state === "error") return "failed";
  if (thread.latestTurn?.state === "completed") return "completed";
  return "idle";
}

/** How long a placement counts toward a machine's load before its snapshot must show it. */
export const PLACEMENT_GRACE_MS = 120_000;

/**
 * Running agents on a machine: every non-archived thread the snapshot counts
 * as running, judged at the snapshot's own time, plus this home's recent
 * placements the snapshot does not show running yet (so a burst of creates
 * spreads before the peer catches up).
 */
export function machineLoad(input: {
  readonly snapshot: Pick<OrchestrationShellSnapshot, "threads" | "updatedAt">;
  readonly recentPlacements: ReadonlyArray<{ readonly threadId: string }>;
}): number {
  const { snapshot } = input;
  const running = new Set<string>();
  for (const thread of snapshot.threads) {
    if (thread.archivedAt === null && isAgentCountedRunning(thread, snapshot.updatedAt)) {
      running.add(thread.id);
    }
  }
  const unseen = input.recentPlacements.filter((placement) => !running.has(placement.threadId));
  return running.size + unseen.length;
}

/** For the local machine, whose threads carry the home clock. */
export function isThreadBusy(thread: PeerThreadView): boolean {
  return isRunningAgent(thread);
}

export type RemoteReadState = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface RemoteReadTurn {
  readonly state: RemoteReadState;
  readonly request: string;
  readonly result: string | null;
}

/**
 * The latest `limit` requests of a peer thread, oldest first, for
 * `cp_agent_read`. Over HTTP only the latest turn has a state, so earlier
 * requests read as completed when they got a reply and interrupted when not.
 * A streaming reply is still being written and does not count as a result.
 */
export function remoteReadTurns(input: {
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>;
  readonly latestTurnState: "running" | "completed" | "error" | "interrupted" | null;
  readonly limit: number;
}): ReadonlyArray<RemoteReadTurn> {
  const groups: Array<{ request: string; result: string | null }> = [];
  for (const message of input.messages) {
    if (message.role === "user") {
      groups.push({ request: message.text, result: null });
    } else if (
      message.role === "assistant" &&
      groups.length > 0 &&
      !message.streaming &&
      message.text.trim().length > 0
    ) {
      groups[groups.length - 1]!.result = message.text;
    }
  }
  const latest: RemoteReadState =
    input.latestTurnState === null
      ? "queued"
      : input.latestTurnState === "error"
        ? "failed"
        : input.latestTurnState;
  return groups
    .map((group, index): RemoteReadTurn => ({
      state:
        index === groups.length - 1 ? latest : group.result === null ? "interrupted" : "completed",
      request: group.request,
      result: group.result,
    }))
    .slice(-input.limit);
}

/**
 * The agent's last complete reply after the request, from a peer thread's
 * messages. Falls back to the last complete reply when the request is outside
 * the window the peer returned.
 */
export function remoteResultText(input: {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>;
  readonly requestMessageId: string;
}): string | null {
  const at = input.messages.findIndex((message) => message.id === input.requestMessageId);
  const after = at === -1 ? input.messages : input.messages.slice(at + 1);
  const reply = after.findLast(
    (message) =>
      message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
  );
  return reply?.text ?? null;
}

/** The detail the peer recorded when the provider could not start the request's turn. */
export function remoteStartFailureDetail(input: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
  readonly requestMessageId: string;
}): string | null {
  const failure = input.activities.findLast((activity) => {
    const payload = activity.payload as { readonly requestId?: unknown } | null;
    return (
      activity.kind === "provider.turn.start.failed" &&
      payload !== null &&
      typeof payload === "object" &&
      payload.requestId === input.requestMessageId
    );
  });
  const detail = (failure?.payload as { readonly detail?: unknown } | undefined)?.detail;
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}
