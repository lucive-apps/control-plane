import {
  agentMessageDisplayName,
  isAgentOriginatedUserMessage,
  isAgentPushMessageId,
  type AssistantThreadRole,
  type OrchestrationAgentMessageSource,
  type ThreadId,
} from "@t3tools/contracts";

// Fork-owned. How a thread in a Project renders, shared by the desktop chat
// view and the mobile thread screen.

/** What a thread view shows, given the thread's role in a Project (null for a plain workspace). */
export interface AssistantThreadChrome {
  /** Git actions in the header, plus the env-mode and branch controls under the composer. */
  readonly showGitControls: boolean;
  readonly showPullRequestControls: boolean;
  /** Multi-model fanout, which always creates worktrees. */
  readonly supportsMultipleModels: boolean;
  readonly keybindingSettle: boolean;
  readonly keybindingPin: boolean;
}

export function resolveAssistantThreadChrome(input: {
  readonly role: AssistantThreadRole | null;
  readonly isStanding: boolean;
  readonly isGitRepo: boolean;
  readonly worktreePath: string | null;
}): AssistantThreadChrome {
  const { role } = input;
  // Project threads work Local in the Project folder, so git and PR controls
  // are hidden. An agent that already has a worktree (converted from a Tasks
  // workspace) keeps them, so its in-flight PR work is not stranded.
  const showPullRequestControls =
    role === null || (role === "agent" && input.worktreePath !== null);
  return {
    showGitControls: showPullRequestControls && input.isGitRepo,
    showPullRequestControls,
    supportsMultipleModels: role === null,
    // Coordinators and standing agents never settle; the server rejects it too.
    keybindingSettle: role === null || (role === "agent" && !input.isStanding),
    keybindingPin: role !== "coordinator",
  };
}

/** The Project a thread's timeline belongs to, as the handoff presenter reads it. */
export interface AgentMessageTimeline {
  readonly role: AssistantThreadRole;
  readonly coordinatorThreadId: ThreadId;
  readonly project: { readonly title: string };
  /** The current title of a live thread in this Project, else null. Read when a row renders. */
  readonly projectThreadTitle: (threadId: ThreadId) => string | null;
}

export type AgentMessagePresentation =
  /** A prompt a Project schedule sent: "Scheduled · <name> · <time>" above the bubble. */
  | { readonly kind: "scheduled"; readonly name: string }
  /**
   * A manager's message in an agent thread: a user bubble attributed to the
   * Project (from the coordinator) or to the standing agent that asked.
   */
  | {
      readonly kind: "attributed-user";
      readonly displayName: string;
      readonly linkThreadId: ThreadId;
    }
  /**
   * An agent's message in its coordinator's thread, or an agent's result in
   * the thread that asked for it: "<Agent> replied", name linked.
   */
  | { readonly kind: "replied"; readonly displayName: string; readonly linkThreadId: ThreadId }
  | { readonly kind: "default" };

const DEFAULT_PRESENTATION: AgentMessagePresentation = { kind: "default" };

/**
 * How a user-role message renders in a Project thread. Only handoffs between
 * this Project's threads change: the coordinator and its agents, and in an
 * agent's thread, requests from its manager and results pushed to it. A
 * peer's plain message keeps the default presentation.
 */
export function resolveAgentMessagePresentation(input: {
  readonly message: {
    readonly id: string;
    readonly role: string;
    readonly source?: OrchestrationAgentMessageSource | undefined;
  };
  readonly assistantTimeline: AgentMessageTimeline | null | undefined;
}): AgentMessagePresentation {
  const { message, assistantTimeline: timeline } = input;
  const source = message.source;
  // A schedule has no sender thread, so it wins before any handoff reading.
  if (isAgentOriginatedUserMessage(message) && source?.scheduleId !== undefined) {
    return { kind: "scheduled", name: source.threadTitle ?? "Schedule" };
  }
  if (!timeline || !isAgentOriginatedUserMessage(message) || source?.threadId === undefined) {
    return DEFAULT_PRESENTATION;
  }
  const senderThreadId = source.threadId;
  // A pushed result stays a reply even after Set as coordinator promotes its sender.
  const isResult = isAgentPushMessageId(message.id);
  if (!isResult && senderThreadId === timeline.coordinatorThreadId) {
    return timeline.role === "agent"
      ? {
          kind: "attributed-user",
          displayName: timeline.project.title,
          linkThreadId: senderThreadId,
        }
      : DEFAULT_PRESENTATION;
  }
  const senderTitle = timeline.projectThreadTitle(senderThreadId);
  if (senderTitle === null) return DEFAULT_PRESENTATION;
  // The live title, so a message sent before the sender's auto-title landed
  // (or before a rename) names the sender as it is now.
  const displayName = agentMessageDisplayName({ ...source, threadTitle: senderTitle });
  if (isResult || timeline.role === "coordinator") {
    return { kind: "replied", displayName, linkThreadId: senderThreadId };
  }
  return source.replyTo === undefined
    ? DEFAULT_PRESENTATION
    : { kind: "attributed-user", displayName, linkThreadId: senderThreadId };
}
