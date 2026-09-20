import { View } from "react-native";

import { AppText as Text } from "../../../../components/AppText";
import { SegmentedControl } from "../../../../components/SegmentedControl";
import type { UiFont } from "../../../../lib/uiFont";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const FONT_OPTIONS: ReadonlyArray<{ readonly value: UiFont; readonly label: string }> = [
  { value: "dm-sans", label: "Default" },
  { value: "system", label: "System" },
];

export function FontAppearanceSection() {
  const { isReady, appearance, setUiFont } = useAppearancePreferences();

  return (
    <SettingsSection card title="Font">
      <View className="gap-3 p-4">
        <SegmentedControl
          options={FONT_OPTIONS}
          selected={appearance.uiFont}
          onSelect={(value) => {
            if (isReady) setUiFont(value);
          }}
        />
        <Text className="text-sm text-foreground-muted">
          {appearance.uiFont === "system"
            ? "Uses the system font."
            : "Uses the app's default typeface."}
        </Text>
      </View>
    </SettingsSection>
  );
}
