import type { AssistantThreadRole, ThreadId } from "@t3tools/contracts";

import type { ProjectFaviconProject } from "../ProjectFavicon";

export {
  resolveAgentMessagePresentation,
  resolveAssistantThreadChrome,
  type AgentMessagePresentation,
  type AssistantThreadChrome,
} from "@t3tools/client-runtime/state/assistant-thread-view";

/** The coordinator reads as a conversation, so it has no turn minimap. */
export function showsTurnMinimap(role: AssistantThreadRole | null): boolean {
  return role !== "coordinator";
}

/** The Project a timeline belongs to, for handoff rows between its threads. */
export interface AssistantTimeline {
  readonly role: AssistantThreadRole;
  readonly coordinatorThreadId: ThreadId;
  readonly project: ProjectFaviconProject;
  /** The current title of a live thread in this Project, else null. Read when a row renders. */
  readonly projectThreadTitle: (threadId: ThreadId) => string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}
