import {
  agentMessageDisplayName,
  isAgentOriginatedUserMessage,
  type AssistantThreadRole,
  type OrchestrationAgentMessageSource,
  type ThreadId,
} from "@t3tools/contracts";

import type { ProjectFaviconProject } from "../ProjectFavicon";

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

/** The coordinator reads as a conversation, so it has no turn minimap. */
export function showsTurnMinimap(role: AssistantThreadRole | null): boolean {
  return role !== "coordinator";
}

/** The Project a timeline belongs to, for handoff rows between its coordinator and agents. */
export interface AssistantTimeline {
  readonly role: AssistantThreadRole;
  readonly coordinatorThreadId: ThreadId;
  readonly project: ProjectFaviconProject;
  /** The current title of a live thread in this Project, else null. Read when a row renders. */
  readonly projectThreadTitle: (threadId: ThreadId) => string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

export type AgentMessagePresentation =
  /** A coordinator message in an agent thread: a user bubble attributed to the Project. */
  | {
      readonly kind: "attributed-user";
      readonly displayName: string;
      readonly linkThreadId: ThreadId;
    }
  /** An agent's message in its coordinator's thread: "<Agent> replied", name linked. */
  | { readonly kind: "replied"; readonly displayName: string; readonly linkThreadId: ThreadId }
  | { readonly kind: "default" };

const DEFAULT_PRESENTATION: AgentMessagePresentation = { kind: "default" };

/**
 * How a user-role message renders in a Project thread. Only handoffs between
 * this Project's coordinator and its agents change; everything else keeps the
 * default presentation.
 */
export function resolveAgentMessagePresentation(input: {
  readonly message: {
    readonly role: string;
    readonly source?: OrchestrationAgentMessageSource | undefined;
  };
  readonly assistantTimeline:
    | (Pick<AssistantTimeline, "role" | "coordinatorThreadId" | "projectThreadTitle"> & {
        readonly project: { readonly title: string };
      })
    | null
    | undefined;
}): AgentMessagePresentation {
  const { message, assistantTimeline: timeline } = input;
  const source = message.source;
  if (!timeline || !isAgentOriginatedUserMessage(message) || source?.threadId === undefined) {
    return DEFAULT_PRESENTATION;
  }
  const senderThreadId = source.threadId;
  if (timeline.role === "agent" && senderThreadId === timeline.coordinatorThreadId) {
    return {
      kind: "attributed-user",
      displayName: timeline.project.title,
      linkThreadId: senderThreadId,
    };
  }
  if (timeline.role !== "coordinator" || senderThreadId === timeline.coordinatorThreadId) {
    return DEFAULT_PRESENTATION;
  }
  const senderTitle = timeline.projectThreadTitle(senderThreadId);
  if (senderTitle === null) return DEFAULT_PRESENTATION;
  return {
    kind: "replied",
    // The live title, so a reply sent before the agent's auto-title landed
    // (or before a rename) names the agent as it is now.
    displayName: agentMessageDisplayName({ ...source, threadTitle: senderTitle }),
    linkThreadId: senderThreadId,
  };
}
