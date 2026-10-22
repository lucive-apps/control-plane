import type { PreviewAutomationStatus } from "@t3tools/contracts";

/**
 * Explains a tab's `visible` flag to the agent. An `open: true` preview lives in
 * its thread (floating player or right panel), so it is only on screen while the
 * human is viewing that thread and the app window itself is showing.
 */
export function resolvePreviewPresentation(input: {
  readonly visible: boolean;
  readonly windowVisible: boolean;
  readonly shownInThread: boolean;
}): NonNullable<PreviewAutomationStatus["presentation"]> {
  if (input.visible && input.windowVisible) return "on-screen";
  return input.visible || input.shownInThread ? "shown-in-thread" : "background";
}
