import { Platform } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { resolveUiFontFamilies } from "./uiFont";

const FONT_WEIGHTS = ["regular", "medium", "bold"] as const;
type FontWeight = (typeof FONT_WEIGHTS)[number];

/**
 * Resolves a font family for APIs that require a style object or native prop.
 * Prefer Uniwind font classes when the target component accepts `className`.
 */
export function useFontFamily(weight: FontWeight): string {
  const { appearance } = useAppearancePreferences();
  return resolveUiFontFamilies(appearance.uiFont, Platform.OS)[weight];
}
