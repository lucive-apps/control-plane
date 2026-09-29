import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildScheduleEditorDraft,
  formatScheduleRunTime,
  initialScheduleEditorForm,
  resolveScheduleEditor,
  resolveScheduleHost,
  SCHEDULE_PRESET_KINDS,
  SCHEDULE_PRESET_LABELS,
  SCHEDULE_WEEK_DAYS,
  scheduleEditorChange,
  scheduleEditorChangeText,
  scheduleTargetOptions,
  storedSchedulePrompt,
  switchSchedulePreset,
  toggleScheduleDay,
  type ScheduleEditorForm,
  type SchedulePreset,
} from "@t3tools/client-runtime/state/schedules";
import {
  EnvironmentId,
  PROJECT_SCHEDULE_NAME_MAX,
  PROJECT_SCHEDULE_PROMPT_MAX,
  ProjectId,
  type ProjectSchedule,
} from "@t3tools/contracts";
import { describeCron } from "@t3tools/shared/schedules";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { Footnote, MenuRow, ValueText } from "./ProjectFormRows";
import { ScheduleTimeField } from "./ScheduleTimeField";
import { confirm } from "./useProjectActions";
import { useScheduleActions } from "./useScheduleActions";

// Fork-owned. New and edit schedule (design S5b and S5c), pushed inside the
// Schedules sheet. The form and its rules are client-runtime's, shared with
// the web editor: presets first, Custom takes a cron, and an untouched
// cadence saves the stored cron as it is. Save echoes the version the editor
// opened, so a schedule changed meanwhile is refused rather than overwritten.

type ProjectScheduleEditorRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
  /** Absent for a new schedule. */
  readonly scheduleId?: string;
};

const HOUR_STEPS = Array.from({ length: 12 }, (_, index) => index + 1);
const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hoursText = (hours: number) => `${hours} ${hours === 1 ? "hour" : "hours"}`;

export function ProjectScheduleEditorScreen({
  route,
}: StaticScreenProps<ProjectScheduleEditorRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const scheduleId = route.params.scheduleId ?? null;
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId, projectId),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const assistant = project?.assistant ?? null;
  const capability =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.projectSchedules ?? null;
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const threads = useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(projectRefs));

  // The version the editor opened; saves echo its `updatedAt`.
  const [opened] = useState<ProjectSchedule | null>(
    () => assistant?.schedules?.find((schedule) => schedule.id === scheduleId) ?? null,
  );
  const missing = scheduleId !== null && opened === null;
  const [form, setForm] = useState<ScheduleEditorForm>(() => initialScheduleEditorForm(opened));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const actions = useScheduleActions();

  // The prompt lives in `schedules.status`; read it fresh as the editor opens.
  const schedulable = assistant !== null && capability !== null;
  const statusAtom = useMemo(
    () =>
      schedulable
        ? projectEnvironment.schedulesStatus({ environmentId, input: { projectId } })
        : null,
    [environmentId, projectId, schedulable],
  );
  const statusQuery = useEnvironmentQuery(statusAtom);
  const refreshStatus = statusQuery.refresh;
  useEffect(() => {
    if (schedulable) refreshStatus();
  }, [refreshStatus, schedulable]);

  const host =
    capability === null
      ? null
      : resolveScheduleHost({ capability, host: statusQuery.data?.host ?? null });
  const timeZone = host?.timeZone ?? "UTC";
  const targetOptions = useMemo(
    () =>
      assistant === null
        ? []
        : scheduleTargetOptions({
            coordinatorThreadId: assistant.coordinatorThreadId,
            threads,
            current: opened?.target ?? null,
          }),
    [assistant, opened, threads],
  );
  const promptPending = statusQuery.isPending;
  const view = resolveScheduleEditor({
    opened,
    form,
    storedPrompt:
      opened === null ? undefined : storedSchedulePrompt(statusQuery.data?.prompts, opened.id),
    targetOptions,
    changed: scheduleEditorChange(opened, assistant?.schedules ?? []),
    saving,
    now: new Date(),
    timeZone,
  });
  const { preset } = form;
  const unavailable = project === null || assistant === null || capability === null || missing;
  const canSave = !unavailable && view.canSave;

  const update = (next: Partial<ScheduleEditorForm>) =>
    setForm((current) => ({ ...current, ...next }));
  const changePreset = (next: Partial<SchedulePreset>) =>
    setForm((current) => ({
      ...current,
      cadenceTouched: true,
      preset: { ...current.preset, ...next },
    }));

  // Swiping the sheet down, Cancel or back never drops an edit silently.
  usePreventRemove(view.dirty && !saving, ({ data }) => {
    void confirm({
      title: "Discard changes?",
      message: "Your edits to this schedule have not been saved.",
      confirmText: "Discard",
      destructive: true,
    }).then((discard) => {
      if (discard) navigation.dispatch(data.action);
    });
  });

  const save = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const saved = await actions.save(
      { environmentId, projectId },
      buildScheduleEditorDraft({ opened, form, view }),
    );
    if (saved) {
      // Left while saving: going back again would close the sheet beneath.
      if (navigation.isFocused()) navigation.goBack();
      return;
    }
    savingRef.current = false;
    setSaving(false);
  };

  const remove = async () => {
    if (opened === null || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const deleted = await actions.remove({ environmentId, projectId }, opened);
    if (deleted) {
      if (navigation.isFocused()) navigation.goBack();
      return;
    }
    savingRef.current = false;
    setSaving(false);
  };

  const title = scheduleId === null ? "New schedule" : "Edit schedule";
  const targetLabel =
    targetOptions.find((option) => option.value === form.target)?.label ?? "Pick where it runs";
  const targetActions: MenuAction[] = targetOptions.map((option) => ({
    id: `target:${option.value}`,
    title: option.label,
    state: option.value === form.target ? ("on" as const) : ("off" as const),
  }));
  const cadenceActions: MenuAction[] = SCHEDULE_PRESET_KINDS.map((kind) => ({
    id: `preset:${kind}`,
    title: SCHEDULE_PRESET_LABELS[kind],
    state: kind === preset.kind ? ("on" as const) : ("off" as const),
  }));
  const hourActions: MenuAction[] = HOUR_STEPS.map((hours) => ({
    id: `hours:${hours}`,
    title: hoursText(hours),
    state: hours === preset.everyHours ? ("on" as const) : ("off" as const),
  }));
  const dayActions: MenuAction[] = MONTH_DAYS.map((day) => ({
    id: `day:${day}`,
    title: `${day}`,
    state: day === preset.dayOfMonth ? ("on" as const) : ("off" as const),
  }));
  const promptEditable =
    !saving && !(opened !== null && form.typedPrompt === null && promptPending);
  const promptPlaceholder =
    view.promptUnknown && promptPending
      ? "Loading…"
      : view.promptUnknown && statusQuery.error !== null
        ? "Couldn't load the prompt. It stays as it is unless you type a new one."
        : "Summarize what changed since yesterday and what needs me today.";

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          headerBackVisible: false,
          title,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          actions={[
            {
              accessibilityLabel: "Save",
              icon: "checkmark",
              onPress: () => void save(),
              disabled: !canSave,
            },
          ]}
          onBack={() => navigation.goBack()}
        />
      ) : (
        <>
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="Cancel"
              disabled={saving}
              label="Cancel"
              onPress={() => navigation.goBack()}
            />
          </NativeHeaderToolbar>
          <NativeHeaderToolbar placement="right">
            <NativeHeaderToolbar.Button
              accessibilityLabel="Save"
              disabled={!canSave}
              label="Save"
              onPress={() => void save()}
            />
          </NativeHeaderToolbar>
        </>
      )}
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {unavailable ? (
          <EmptyState
            title="Schedule unavailable"
            detail={
              missing
                ? "It was deleted since the list loaded."
                : "Reconnect to its environment. It may also have been deleted."
            }
          />
        ) : (
          <>
            {view.changed !== null ? (
              <Text accessibilityRole="alert" className="px-2 text-sm text-warning-foreground">
                {scheduleEditorChangeText(view.changed)}
              </Text>
            ) : null}

            <SettingsSection title="Name">
              <AppTextInput
                accessibilityLabel="Schedule name"
                autoFocus={opened === null}
                className="min-h-12 rounded-none border-0 bg-card px-4 text-base"
                editable={!saving}
                maxLength={PROJECT_SCHEDULE_NAME_MAX}
                onChangeText={(name) => update({ name })}
                placeholder="Morning brief"
                returnKeyType="done"
                value={form.name}
              />
            </SettingsSection>

            <SettingsSection>
              <MenuRow
                icon="text.bubble"
                label="Runs in"
                title="Runs in"
                accessibilityLabel={`Runs in, ${targetLabel}`}
                actions={targetActions}
                disabled={saving}
                onPressAction={(id) => {
                  const option = targetOptions.find((entry) => `target:${entry.value}` === id);
                  if (option) update({ target: option.value });
                }}
                trailing={<ValueText>{targetLabel}</ValueText>}
              />
            </SettingsSection>

            <SettingsSection
              title="Prompt"
              trailing={
                view.promptUnknown ? null : (
                  <Text className="px-2 text-sm tabular-nums text-foreground-muted">
                    {view.prompt.length}/{PROJECT_SCHEDULE_PROMPT_MAX}
                  </Text>
                )
              }
            >
              <AppTextInput
                accessibilityLabel="Prompt"
                className="min-h-32 rounded-none border-0 bg-card px-4 py-3 text-base"
                editable={promptEditable}
                maxLength={PROJECT_SCHEDULE_PROMPT_MAX}
                multiline
                onChangeText={(typedPrompt) => update({ typedPrompt })}
                placeholder={promptPlaceholder}
                scrollEnabled={false}
                textAlignVertical="top"
                value={view.prompt}
              />
            </SettingsSection>

            <SettingsSection title="Cadence">
              <MenuRow
                icon="arrow.clockwise"
                label="Repeats"
                title="Cadence"
                accessibilityLabel={`Repeats, ${SCHEDULE_PRESET_LABELS[preset.kind]}`}
                actions={cadenceActions}
                disabled={saving}
                onPressAction={(id) => {
                  const kind = SCHEDULE_PRESET_KINDS.find((entry) => `preset:${entry}` === id);
                  if (kind !== undefined)
                    changePreset(switchSchedulePreset(preset, kind, view.cron));
                }}
                trailing={<ValueText>{SCHEDULE_PRESET_LABELS[preset.kind]}</ValueText>}
              />
              {preset.kind === "weekly" ? (
                <View accessibilityLabel="Days" className="flex-row justify-between px-4 pb-4">
                  {SCHEDULE_WEEK_DAYS.map(([day, label]) => {
                    const on = preset.days.includes(day);
                    return (
                      <Pressable
                        key={day}
                        accessibilityLabel={DAY_NAMES[day]}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on, disabled: saving }}
                        className={cn(
                          "size-9 items-center justify-center rounded-full active:opacity-70",
                          on ? "bg-primary" : "bg-subtle",
                        )}
                        disabled={saving}
                        hitSlop={4}
                        onPress={() => changePreset({ days: toggleScheduleDay(preset.days, day) })}
                      >
                        <Text
                          className={cn(
                            "text-xs font-t3-medium",
                            on ? "text-primary-foreground" : "text-foreground",
                          )}
                        >
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              {preset.kind === "hourly" ? (
                <MenuRow
                  icon="clock"
                  label="Every"
                  title="Hours between runs"
                  accessibilityLabel={`Every ${hoursText(preset.everyHours)}`}
                  actions={hourActions}
                  disabled={saving}
                  onPressAction={(id) => {
                    const hours = HOUR_STEPS.find((entry) => `hours:${entry}` === id);
                    if (hours !== undefined) changePreset({ everyHours: hours });
                  }}
                  trailing={<ValueText>{hoursText(preset.everyHours)}</ValueText>}
                />
              ) : null}
              {preset.kind === "monthly" ? (
                <MenuRow
                  icon="square.grid.2x2"
                  label="On day"
                  title="Day of the month"
                  accessibilityLabel={`On day ${preset.dayOfMonth} of the month`}
                  actions={dayActions}
                  disabled={saving}
                  onPressAction={(id) => {
                    const day = MONTH_DAYS.find((entry) => `day:${entry}` === id);
                    if (day !== undefined) changePreset({ dayOfMonth: day });
                  }}
                  trailing={<ValueText>{`${preset.dayOfMonth}`}</ValueText>}
                />
              ) : null}
              {preset.kind !== "hourly" && preset.kind !== "custom" ? (
                <ScheduleTimeField
                  hour={preset.hour}
                  minute={preset.minute}
                  disabled={saving}
                  onChange={(hour, minute) => changePreset({ hour, minute })}
                />
              ) : null}
              {preset.kind === "custom" ? (
                <AppTextInput
                  accessibilityLabel="Cron expression"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-h-12 rounded-none border-0 bg-card px-4 font-mono text-base"
                  editable={!saving}
                  onChangeText={(cron) => changePreset({ cron })}
                  placeholder="0 7 * * 1-5"
                  spellCheck={false}
                  value={preset.cron}
                />
              ) : null}
            </SettingsSection>
            {view.cadenceError !== null ? (
              <Text accessibilityRole="alert" className="-mt-1 px-2 text-sm text-danger-foreground">
                {view.cadenceError}
              </Text>
            ) : preset.kind === "custom" ? (
              <Footnote>{describeCron(preset.cron)}</Footnote>
            ) : null}

            {view.nextRuns.length > 0 ? (
              <>
                <SettingsSection title="Next runs">
                  <View className="gap-2 p-4">
                    {view.nextRuns.map((run) => (
                      <Text
                        key={run.toISOString()}
                        className="text-base tabular-nums text-foreground"
                      >
                        {formatScheduleRunTime(run, timeZone)}
                      </Text>
                    ))}
                  </View>
                </SettingsSection>
                <Footnote>Times are in {timeZone} (host).</Footnote>
              </>
            ) : view.cadenceError === null ? (
              <Footnote>Next runs are unavailable.</Footnote>
            ) : null}

            {opened !== null ? (
              <SettingsSection>
                <SettingsActionRow
                  icon="trash"
                  label="Delete schedule"
                  tone="danger"
                  disabled={saving}
                  onPress={() => void remove()}
                />
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
