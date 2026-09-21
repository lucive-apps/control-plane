export const UI_FONTS = ["dm-sans", "system"] as const;
export type UiFont = (typeof UI_FONTS)[number];

const DM_SANS_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Medium",
} as const;

export function normalizeUiFont(value: unknown): UiFont {
  return value === "system" ? "system" : "dm-sans";
}

export function resolveUiFontFamilies(
  uiFont: UiFont,
  os: string,
): {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
} {
  if (uiFont !== "system") return DM_SANS_FAMILIES;
  if (os === "android") {
    return {
      regular: "sans-serif",
      medium: "sans-serif-medium",
      bold: "sans-serif",
    };
  }
  return { regular: "System", medium: "System", bold: "System" };
}

export function resolveUiFontCssVariables(uiFont: UiFont, os: string): Record<string, string> {
  const families = resolveUiFontFamilies(uiFont, os);
  return {
    "--font-sans": families.regular,
    "--font-medium": families.medium,
    "--font-bold": families.bold,
  };
}
