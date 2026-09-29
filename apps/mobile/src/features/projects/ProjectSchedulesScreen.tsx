import { useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildScheduleRows,
  resolveScheduleHost,
  scheduleHostSummary,
  SCHEDULES_HELP_URL,
  type ScheduleRowView,
} from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  PROJECT_SCHEDULE_LIMIT,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { SettingsSection } from "../settings/components/SettingsSection";
import { rollupDotColor, ThreadStatusDot } from "../threads/thread-status-dot";
import { Footnote } from "./ProjectFormRows";
import { useScheduleActions } from "./useScheduleActions";

// Fork-owned. The Schedules sheet (design S5): the web panel's list as grouped
// rows. The switch pauses and resumes, Run now sends one run, and a tap opens
// the editor. Open at login, the fire command and Remove from this host stay
// on the desktop, so the host line here is read-only.

type ProjectSchedulesRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
};

const MINUTE_MS = 60_000;
const RUNNING_DOT_COLOR = rollupDotColor("working");

export function ProjectSchedulesScreen({ route }: StaticScreenProps<ProjectSchedulesRouteParams>) {
  const navigation = useNavigation();
  // The same screen serves the Project sheet and the Settings sheet.
  const routeName = useRoute().name;
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId, projectId),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const assistant = project?.assistant ?? null;
  const capability =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.projectSchedules ?? null;
  const available = assistant !== null && capability !== null;
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const threads = useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(projectRefs));
  const { environments } = useEnvironments();
  const hostLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "its host";

  const statusAtom = useMemo(
    () =>
      available
        ? projectEnvironment.schedulesStatus({ environmentId, input: { projectId } })
        : null,
    [available, environmentId, projectId],
  );
  const statusQuery = useEnvironmentQuery(statusAtom);
  const status = statusQuery.data;
  const refreshStatus = statusQuery.refresh;
  const [now, setNow] = useState(() => new Date());
  // Status reads fresh on open and once a minute, so held rows update, but not
  // under the editor: it read status as it opened, and a refresh would
  // disable its prompt field mid-edit. The minute tick re-renders next runs.
  useEffect(() => {
    if (!isFocused || statusAtom === null) return;
    refreshStatus();
    const interval = setInterval(() => {
      refreshStatus();
      setNow(new Date());
    }, MINUTE_MS);
    return () => clearInterval(interval);
  }, [isFocused, refreshStatus, statusAtom]);
  // Back from the editor, "in 14h" and "Ran at" read the clock again.
  useEffect(() => navigation.addListener("focus", () => setNow(new Date())), [navigation]);

  const actions = useScheduleActions();
  // One write at a time: each sends the whole list, so a second built before
  // the first lands would echo stale versions and be refused. The switch
  // being written shows its new position until the write settles.
  const [writing, setWriting] = useState<{ readonly id: string; readonly enabled: boolean } | null>(
    null,
  );
  const writingRef = useRef(false);
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      if (writingRef.current) return;
      writingRef.current = true;
      setWriting({ id, enabled });
      await actions.setEnabled({ environmentId, projectId }, id, enabled);
      writingRef.current = false;
      setWriting(null);
    },
    [actions, environmentId, projectId],
  );

  const runNow = useCallback(
    async (row: ScheduleRowView) => {
      const id = row.schedule.id;
      setRunning((current) => new Set(current).add(id));
      await actions.runNow({ environmentId, projectId }, id, row.targetTitle);
      setRunning((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      refreshStatus();
    },
    [actions, environmentId, projectId, refreshStatus],
  );

  const editorRoute =
    routeName === "SettingsProjectSchedules"
      ? "SettingsProjectScheduleEditor"
      : "ProjectScheduleEditor";
  const openEditor = (scheduleId: string | null) =>
    navigation.dispatch(
      StackActions.push(editorRoute, {
        environmentId: String(environmentId),
        projectId: String(projectId),
        ...(scheduleId === null ? {} : { scheduleId }),
      }),
    );
  const threadById = useMemo(
    () => new Map<ThreadId, EnvironmentThreadShell>(threads.map((thread) => [thread.id, thread])),
    [threads],
  );

  const statusHost = status?.host ?? null;
  const host = useMemo(
    () => (capability === null ? null : resolveScheduleHost({ capability, host: statusHost })),
    [capability, statusHost],
  );
  const schedules = assistant?.schedules ?? [];
  const projectTitle = project?.title ?? "";
  const held = status?.held;
  const timeZone = host?.timeZone ?? null;
  // Writes, runs and status reads re-render the list; the rows only follow their inputs.
  const rows = useMemo(
    () =>
      assistant === null || timeZone === null
        ? []
        : buildScheduleRows({ assistant, projectTitle, threads, held, now, timeZone }),
    [assistant, held, now, projectTitle, threads, timeZone],
  );
  // A Mac host that was closed at a slot is fixed by Open at login, which only its desktop app sets.
  const openAtLoginHint =
    host?.scheduler === "launchd"
      ? `Turn on Open at login in Control Plane on ${hostLabel} to keep schedules running.`
      : null;
  const summary =
    host === null
      ? null
      : scheduleHostSummary({
          scheduler: host.scheduler,
          backend: status?.host.backend ?? null,
          hostLabel,
        });
  const unsupported = host?.unsupportedText != null;
  const canCreate = available && !unsupported && schedules.length < PROJECT_SCHEDULE_LIMIT;
  // The first screen of the Project sheet closes it; inside Settings the
  // native back button returns to Project settings.
  const isSheetRoot = navigation.getState()?.index === 0;
  const title = "Schedules";

  return (
    <View className="flex-1 bg-sheet">
      {/* An iOS formSheet resizes the first ScrollView on its first-subview path to
          the whole sheet (react-native-screens applyFrameCorrectionForDescendantScrollView),
          which pushed this list below the sheet when it opens as the sheet's first
          screen. The nested stack already bounds the screen, so this empty view ends
          that path. */}
      <View collapsable={false} pointerEvents="none" />
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title,
          unstable_headerSubtitle: Platform.OS === "ios" ? project?.title : undefined,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          subtitle={project?.title ?? null}
          actions={[
            {
              accessibilityLabel: "New schedule",
              icon: "plus",
              onPress: () => openEditor(null),
              disabled: !canCreate,
            },
          ]}
          onBack={() => navigation.goBack()}
        />
      ) : (
        <>
          {isSheetRoot ? (
            <NativeHeaderToolbar placement="left">
              <NativeHeaderToolbar.Button
                accessibilityLabel="Close"
                label="Done"
                onPress={() => navigation.goBack()}
              />
            </NativeHeaderToolbar>
          ) : null}
          <NativeHeaderToolbar placement="right">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New schedule"
              disabled={!canCreate}
              icon="plus"
              onPress={() => openEditor(null)}
            />
          </NativeHeaderToolbar>
        </>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!available || host === null ? (
          <EmptyState
            title="Schedules unavailable"
            detail={
              project === null || assistant === null
                ? "Reconnect to its environment. It may also have been deleted."
                : "This Project's host does not store schedules. Update Control Plane there."
            }
          />
        ) : host.unsupportedText !== null ? (
          <EmptyState
            title="Schedules don't run on this host"
            detail={host.unsupportedText}
            actionLabel="How to fix"
            onAction={() => void Linking.openURL(SCHEDULES_HELP_URL).catch(() => undefined)}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            detail="Send a prompt on a cadence, such as a weekday morning brief."
            actionLabel="New schedule"
            onAction={() => openEditor(null)}
          />
        ) : (
          <SettingsSection>
            {rows.map((row) => {
              const linkThread =
                row.state.linkThreadId === null
                  ? null
                  : (threadById.get(row.state.linkThreadId) ?? null);
              return (
                <ScheduleListRow
                  key={row.schedule.id}
                  row={row}
                  writing={writing !== null}
                  enabled={writing?.id === row.schedule.id ? writing.enabled : row.schedule.enabled}
                  running={running.has(row.schedule.id)}
                  hint={
                    row.state.suggestOpenAtLogin && row.state.attention ? openAtLoginHint : null
                  }
                  onEdit={() => openEditor(row.schedule.id)}
                  onRunNow={() => void runNow(row)}
                  onSetEnabled={(enabled) => void setEnabled(row.schedule.id, enabled)}
                  onOpenThread={linkThread === null ? null : () => selectThread(linkThread)}
                />
              );
            })}
          </SettingsSection>
        )}
        {available && host !== null && host.unsupportedText === null ? (
          <View className="gap-1.5 px-2">
            {summary !== null ? (
              <Text className="text-sm text-foreground-muted">{summary}</Text>
            ) : null}
            {host.problems.map((problem) => (
              <Text
                key={problem}
                accessibilityRole="alert"
                className="text-sm text-warning-foreground"
              >
                {problem}
              </Text>
            ))}
            <Text className="text-sm text-foreground-muted">
              Times are in {host.timeZone} (host).
            </Text>
          </View>
        ) : null}
        {statusQuery.error !== null && status === null && available && !unsupported ? (
          <Footnote>Couldn't read the host's status: {statusQuery.error}</Footnote>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * One schedule: name, cadence and target, then its last result, red while it
 * needs attention. The result links to the thread it ran in.
 */
function ScheduleListRow(props: {
  readonly row: ScheduleRowView;
  readonly writing: boolean;
  /** The switch's position: the stored one, or the one being written. */
  readonly enabled: boolean;
  readonly running: boolean;
  /** Under a "Control Plane was closed" miss: how to keep the host running schedules. */
  readonly hint: string | null;
  readonly onEdit: () => void;
  readonly onRunNow: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onOpenThread: (() => void) | null;
}) {
  const { schedule, state, detail, author } = props.row;
  const stateText = (
    <Text
      className={cn(
        "min-w-0 shrink text-sm",
        state.attention ? "text-danger-foreground" : "text-foreground-muted",
      )}
      numberOfLines={1}
    >
      {state.text}
    </Text>
  );
  const openThread = props.onOpenThread;
  return (
    <View className="flex-row items-center gap-3 pr-4">
      <Pressable
        accessibilityActions={
          openThread === null ? undefined : [{ name: "open-thread", label: "Open its thread" }]
        }
        accessibilityHint="Edits the schedule"
        accessibilityLabel={[schedule.name, detail, state.text, props.hint, author]
          .filter(Boolean)
          .join(", ")}
        accessibilityRole="button"
        className="min-w-0 flex-1 py-4 pl-4"
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "open-thread") openThread?.();
        }}
        onPress={props.onEdit}
      >
        <View className={cn("gap-0.5", !schedule.enabled && "opacity-60")}>
          <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>
            {schedule.name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {detail}
          </Text>
          <View className="flex-row items-center">
            {state.kind === "running" ? <ThreadStatusDot color={RUNNING_DOT_COLOR} /> : null}
            {openThread !== null ? (
              <Pressable className="min-w-0 shrink" hitSlop={6} onPress={openThread}>
                {stateText}
              </Pressable>
            ) : (
              stateText
            )}
          </View>
          {props.hint !== null ? (
            <Text className="text-sm text-foreground-muted">{props.hint}</Text>
          ) : null}
          {author !== null ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {author}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityLabel={`Run ${schedule.name} now`}
        accessibilityRole="button"
        className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-40"
        disabled={props.running}
        hitSlop={4}
        onPress={props.onRunNow}
      >
        <SymbolView
          name="play"
          size={15}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
      <ThemedSwitch
        accessibilityLabel={props.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
        disabled={props.writing}
        onValueChange={props.onSetEnabled}
        value={props.enabled}
      />
    </View>
  );
}
