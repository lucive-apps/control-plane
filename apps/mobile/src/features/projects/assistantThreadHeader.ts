import { resolveAssistantThreadChrome } from "@t3tools/client-runtime/state/assistant-thread-view";
import type { AssistantThreadRole } from "@t3tools/contracts";

// Fork-owned. What a Project thread's header offers on phone and iPad, on top
// of the shared thread chrome. The header items themselves live in
// `useAssistantThreadHeader`.

export interface AssistantHeaderActions {
  /** Git and pull request controls, including the iPad Git inspector. */
  readonly showGitControls: boolean;
  /** The coordinator's Memory button (MEMORY.md). */
  readonly memory: boolean;
  /** The coordinator's Schedules button, when its server stores schedules. */
  readonly schedules: boolean;
  /** The coordinator's Project menu; native titles are not tappable, so it replaces the crumb. */
  readonly projectMenu: boolean;
  /** An agent's way to its coordinator. */
  readonly openProject: boolean;
}

export function resolveAssistantHeaderActions(input: {
  readonly role: AssistantThreadRole | null;
  readonly isStanding: boolean;
  readonly worktreePath: string | null;
  readonly isGitRepo: boolean;
  /** The Project's server has the `projectSchedules` capability. */
  readonly canSchedule: boolean;
}): AssistantHeaderActions {
  const chrome = resolveAssistantThreadChrome(input);
  return {
    showGitControls: chrome.showGitControls,
    memory: input.role === "coordinator",
    schedules: input.role === "coordinator" && input.canSchedule,
    projectMenu: input.role === "coordinator",
    openProject: input.role === "agent",
  };
}
