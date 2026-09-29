import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, disabled, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { scheduleTimePickerDate, type ScheduleTimeFieldProps } from "./ScheduleTimeField.shared";

// Fork-owned. The schedule editor's time row on iOS: the system's compact
// time picker at the end of a grouped row, as in Settings and Calendar.

export function ScheduleTimeField(props: ScheduleTimeFieldProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  return (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView name="clock" size={22} tintColorClassName="accent-icon" type="monochrome" />
      <Text className="min-w-0 flex-1 text-lg text-foreground">Time</Text>
      <Host matchContents colorScheme={themeAppearance} seedColor={colors["--color-primary"]}>
        <DatePicker
          title="Time"
          selection={scheduleTimePickerDate(props.hour, props.minute)}
          displayedComponents={["hourAndMinute"]}
          onDateChange={(date) => props.onChange(date.getHours(), date.getMinutes())}
          modifiers={[
            datePickerStyle("compact"),
            labelsHidden(),
            disabled(props.disabled === true),
          ]}
        />
      </Host>
    </View>
  );
}
