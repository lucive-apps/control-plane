import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { formatScheduleClock } from "@t3tools/client-runtime/state/schedules";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ValueText } from "./ProjectFormRows";

// Fork-owned. The schedule editor's time row. Android (and any platform
// without the SwiftUI picker in ScheduleTimeField.ios.tsx) shows the time and
// opens the system time dialog on tap.

export interface ScheduleTimeFieldProps {
  /** Wall-clock time on the host, 0-23 and 0-59. */
  readonly hour: number;
  readonly minute: number;
  readonly disabled?: boolean;
  readonly onChange: (hour: number, minute: number) => void;
}

/** The picker edits a device-local date; only its hour and minute are read back. */
export function scheduleTimePickerDate(hour: number, minute: number): Date {
  return new Date(2000, 0, 1, hour, minute);
}

export function ScheduleTimeField(props: ScheduleTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const time = formatScheduleClock(props.hour, props.minute);
  return (
    <>
      <Pressable
        accessibilityLabel={`Time, ${time}`}
        accessibilityRole="button"
        className="flex-row items-center gap-4 p-4 android:min-h-14 android:py-3"
        disabled={props.disabled}
        onPress={() => setOpen(true)}
      >
        <SymbolView
          name="clock"
          size={Platform.OS === "android" ? 24 : 22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <Text className="shrink-0 text-lg text-foreground android:text-base">Time</Text>
        <View className="min-w-0 flex-1 items-end">
          <ValueText>{time}</ValueText>
        </View>
      </Pressable>
      {open ? (
        <DateTimePicker
          mode="time"
          is24Hour
          value={scheduleTimePickerDate(props.hour, props.minute)}
          onDismiss={() => setOpen(false)}
          onValueChange={(_, date) => {
            setOpen(false);
            props.onChange(date.getHours(), date.getMinutes());
          }}
        />
      ) : null}
    </>
  );
}
