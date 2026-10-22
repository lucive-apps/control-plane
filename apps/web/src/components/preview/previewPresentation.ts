import type { PreviewAutomationStatus } from "@t3tools/contracts";

/**
 * Explains a tab's `visible` flag to the agent. An `open: true` preview lives in
 * its thread, so it is only on screen while the human is viewing that thread.
 */
export function resolvePreviewPresentation(input: {
  readonly visible: boolean;
  readonly shownInThread: boolean;
}): NonNullable<PreviewAutomationStatus["presentation"]> {
  if (input.visible) return "on-screen";
  return input.shownInThread ? "shown-in-thread" : "background";
}
