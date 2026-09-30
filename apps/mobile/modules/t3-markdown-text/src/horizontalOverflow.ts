/** Sub-point differences are layout rounding, not scrollable content. */
const OVERFLOW_TOLERANCE = 1;

export interface HorizontalOverflowEdges {
  /** Content is wider than the viewport, so the block scrolls. */
  readonly overflows: boolean;
  /** Content is hidden past the leading edge. */
  readonly leading: boolean;
  /** Content is hidden past the trailing edge. */
  readonly trailing: boolean;
}

export function horizontalOverflowEdges(input: {
  readonly viewportWidth: number;
  readonly contentWidth: number;
  readonly offsetX: number;
}): HorizontalOverflowEdges {
  const maxOffset = input.contentWidth - input.viewportWidth;
  const overflows = input.viewportWidth > 0 && maxOffset > OVERFLOW_TOLERANCE;
  return {
    overflows,
    leading: overflows && input.offsetX > OVERFLOW_TOLERANCE,
    trailing: overflows && input.offsetX < maxOffset - OVERFLOW_TOLERANCE,
  };
}

/**
 * CSS gradient that fades content into an opaque surface at one edge. Only
 * six-digit hex colours can take the transparent `00` alpha suffix, so other
 * formats get no fade rather than a gradient through transparent black.
 */
export function horizontalOverflowFadeGradient(
  color: string | undefined,
  edge: "leading" | "trailing",
): string | undefined {
  if (color === undefined || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  const direction = edge === "leading" ? "to left" : "to right";
  return `linear-gradient(${direction}, ${color}00 0%, ${color} 100%)`;
}
