import {
  Platform,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
} from "react-native";

import { useUiFont } from "../features/settings/appearance/AppearancePreferencesProvider";
import { cn } from "../lib/cn";
import { resolveUiFontFamilies } from "../lib/uiFont";

export type AppTextProps = RNTextProps & { readonly className?: string };

function useSystemFontStyle(): { fontFamily: string } | undefined {
  const uiFont = useUiFont();
  if (uiFont !== "system") return undefined;
  return { fontFamily: resolveUiFontFamilies("system", Platform.OS).regular };
}

/**
 * Thin wrapper around RN Text with default font-family and foreground color.
 * Uses Uniwind className — no manual style parsing.
 */
export function AppText({ className, style, ...props }: AppTextProps) {
  const systemFontStyle = useSystemFontStyle();
  return (
    <RNText
      className={cn("font-sans text-foreground", className)}
      selectionColorClassName={Platform.OS === "android" ? "accent-primary/32" : undefined}
      {...props}
      style={systemFontStyle ? [systemFontStyle, style] : style}
    />
  );
}

export type AppTextInputProps = Omit<RNTextInputProps, "placeholderTextColor"> & {
  readonly className?: string;
  readonly ref?: React.Ref<RNTextInput>;
};

/**
 * Thin wrapper around RN TextInput with default input styling.
 * Uses Uniwind className — no manual style parsing.
 */
export function AppTextInput({ className, ref, style, ...props }: AppTextInputProps) {
  const systemFontStyle = useSystemFontStyle();
  return (
    <RNTextInput
      ref={ref}
      className={cn(
        "min-h-13.5 rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground",
        className,
      )}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName={
        Platform.OS === "android" ? "accent-primary/32" : "accent-foreground-secondary"
      }
      cursorColorClassName={
        Platform.OS === "android" ? "accent-primary" : "accent-foreground-secondary"
      }
      selectionHandleColorClassName={Platform.OS === "android" ? "accent-primary" : undefined}
      {...props}
      style={systemFontStyle ? [systemFontStyle, style] : style}
    />
  );
}
