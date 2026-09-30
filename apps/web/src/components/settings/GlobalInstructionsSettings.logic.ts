import { GLOBAL_INSTRUCTIONS_CAP_CHARS } from "@t3tools/contracts";

export type GlobalInstructionsUsageTone = "normal" | "near" | "over";

export interface GlobalInstructionsUsage {
  readonly count: number;
  readonly cap: number;
  readonly tone: GlobalInstructionsUsageTone;
  /** "1,204 / 8,000 characters". */
  readonly label: string;
  /** Set only when some of the text will not reach prompts. */
  readonly warning: string | null;
}

/** Warn from 90% of the cap, before anything is cut. */
const NEAR_CAP_RATIO = 0.9;

/**
 * Counts what the server caps: the trimmed text in UTF-16 units, which is
 * what `String.length` and the server's `capChars` both measure.
 */
export function globalInstructionsUsage(
  text: string,
  cap: number = GLOBAL_INSTRUCTIONS_CAP_CHARS,
): GlobalInstructionsUsage {
  const count = text.trim().length;
  const format = (value: number) => value.toLocaleString("en-US");
  const tone: GlobalInstructionsUsageTone =
    count > cap ? "over" : count >= cap * NEAR_CAP_RATIO ? "near" : "normal";
  return {
    count,
    cap,
    tone,
    label: `${format(count)} / ${format(cap)} characters`,
    warning:
      tone === "over"
        ? `Over the cap by ${format(count - cap)}. Only the first ${format(cap)} characters reach prompts; agents are told to read the file for the rest.`
        : null,
  };
}

export function globalInstructionsErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.trim()
  ) {
    return error.detail;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "An error occurred.";
}
