import type { SidebarRollupStatus } from "@t3tools/client-runtime/state/assistant-lists";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { LegendList, type LegendListProps } from "@legendapp/list/react-native";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import { GestureDetector, type NativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { ProjectListRow } from "../projects/ProjectListRow";
import type { ProjectRowMenuAction } from "../projects/projectMenus";
import { useOpenNewProject } from "../projects/useOpenNewProject";
import { runProjectMenuAction, useProjectActions } from "../projects/useProjectActions";
import {
  GROUPED_CHILD_INSET,
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import { resolveThreadProviderInstance } from "../threads/thread-provider-instance";
import { rollupDotColor, rollupDotLabel, ThreadStatusDot } from "../threads/thread-status-dot";
import type { ThreadMoveDestination } from "../threads/threadOrder";
import { useMaterialFabScroll } from "./MaterialFabScrollContext";
import {
  homeCardRows,
  homeSectionItemsAreEqual,
  type HomeCardEdge,
  type HomeCardRow,
  type HomeSectionItem,
  type HomeTaskThreadItem,
} from "./homeSections";
import { TaskFolderHeader } from "./TaskFolderHeader";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import type { HomeSectionsModel } from "./useHomeSections";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";

// Fork-owned. The one recycled list behind the phone Home and the iPad
// sidebar: Projects, then Tasks, from `buildHomeSections`. The iOS phone
// draws each section as one rounded card on the grouped screen background;
// the iPad sidebar and Android keep their own row surfaces.

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;

type HomeSectionListProps = Pick<
  LegendListProps<HomeCardRow>,
  | "automaticallyAdjustsScrollIndicatorInsets"
  | "contentContainerStyle"
  | "contentInsetAdjustmentBehavior"
  | "ListEmptyComponent"
  | "ListHeaderComponent"
  | "style"
>;

const SECTION_LABELS = { projects: "Projects", tasks: "Tasks" } as const;
const GROUPED_HEADER_CHEVRON_COLLAPSED = { transform: [{ rotate: "-90deg" }] } as const;

const NO_ROWS: readonly HomeCardRow[] = [];
const rowType = (row: HomeCardRow) => row.item.type;
const rowKey = (row: HomeCardRow) => row.key;
const rowsAreEqual = (previous: HomeCardRow, row: HomeCardRow) =>
  previous.edge === row.edge && homeSectionItemsAreEqual(previous.item, row.item);
const flatRows = (items: readonly HomeSectionItem[]): HomeCardRow[] =>
  items.map((item) => ({ key: item.key, item, edge: "none" }));

/** Grouped content inset from the screen edge; section labels sit 4pt further in. */
const GROUPED_INSET = 20;
const CHILD_INSET_STYLE = { paddingLeft: GROUPED_CHILD_INSET } as const;
const SEPARATOR_STYLE = { marginLeft: GROUPED_CHILD_INSET } as const;

/** One slice of a rounded card. Rows below the first draw an inset hairline. */
function CardSegment(props: { readonly edge: HomeCardEdge; readonly children: React.ReactNode }) {
  const { edge } = props;
  const top = edge === "top" || edge === "only";
  const bottom = edge === "bottom" || edge === "only";
  return (
    <View
      className={cn(
        "overflow-hidden border-x border-border bg-card",
        top && "rounded-t-2xl border-t",
        bottom && "rounded-b-2xl border-b",
      )}
      style={{ marginHorizontal: GROUPED_INSET }}
    >
      {top ? null : <View className="h-px bg-border" style={SEPARATOR_STYLE} />}
      {props.children}
    </View>
  );
}

const HomeSectionHeader = memo(function HomeSectionHeader(props: {
  readonly pane: "screen" | "sidebar";
  readonly section: "projects" | "tasks";
  readonly collapseKey: string;
  readonly collapsed: boolean;
  readonly forcedOpen: boolean;
  readonly rollup: SidebarRollupStatus;
  readonly onToggle: (collapseKey: string) => void;
  readonly onAdd?: () => void;
  readonly addLabel?: string;
  readonly grouped: boolean;
}) {
  const label = SECTION_LABELS[props.section];
  const dotColor = props.collapsed ? rollupDotColor(props.rollup) : null;
  const statusLabel = props.collapsed ? rollupDotLabel(props.rollup) : null;
  const toggleAccessibility = {
    accessibilityHint: props.forcedOpen
      ? undefined
      : props.collapsed
        ? `Shows ${label}`
        : `Hides ${label}`,
    accessibilityLabel: statusLabel === null ? label : `${label}, ${statusLabel}`,
    accessibilityRole: "button",
    accessibilityState: { expanded: !props.collapsed, disabled: props.forcedOpen },
  } as const;
  if (props.grouped) {
    return (
      <View
        className="flex-row items-center pb-2"
        style={{
          paddingTop: props.section === "projects" ? 12 : 28,
          paddingHorizontal: GROUPED_INSET + 4,
        }}
      >
        <Pressable
          {...toggleAccessibility}
          className="min-h-7 flex-1 flex-row items-center gap-1"
          disabled={props.forcedOpen}
          onPress={() => props.onToggle(props.collapseKey)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text className="text-sm text-foreground-muted">{label}</Text>
          <SymbolView
            name="chevron.down"
            size={12}
            style={props.collapsed ? GROUPED_HEADER_CHEVRON_COLLAPSED : undefined}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
            weight="semibold"
          />
          {dotColor !== null ? <ThreadStatusDot color={dotColor} grouped /> : null}
        </Pressable>
        {props.onAdd ? (
          <Pressable
            accessibilityLabel={props.addLabel}
            accessibilityRole="button"
            className="min-h-7 items-center justify-center"
            hitSlop={10}
            onPress={props.onAdd}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <SymbolView
              name="plus"
              size={20}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
              weight="regular"
            />
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View
      className={cn(
        "flex-row items-center pt-5 pb-1",
        props.pane === "sidebar" ? "pr-1 pl-3" : "pr-3.5 pl-5",
      )}
    >
      <Pressable
        {...toggleAccessibility}
        className="min-h-9 flex-1 flex-row items-center gap-1.5"
        disabled={props.forcedOpen}
        onPress={() => props.onToggle(props.collapseKey)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text className="text-sm font-t3-medium text-foreground-muted">{label}</Text>
        <SymbolView
          name={props.collapsed ? "chevron.right" : "chevron.down"}
          size={10}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        {dotColor !== null ? <ThreadStatusDot color={dotColor} /> : null}
      </Pressable>
      {props.onAdd ? (
        <Pressable
          accessibilityLabel={props.addLabel}
          accessibilityRole="button"
          className="size-9 items-center justify-center"
          onPress={props.onAdd}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <SymbolView
            name="plus"
            size={props.pane === "sidebar" ? 16 : 18}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
            weight="medium"
          />
        </Pressable>
      ) : null}
    </View>
  );
});

function EmptySectionRow(props: {
  readonly pane: "screen" | "sidebar";
  readonly grouped: boolean;
  readonly label: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  const { action } = props;
  if (props.grouped) {
    return (
      <View className="min-h-[52px] flex-row items-center gap-3 px-4 py-3">
        <Text className="flex-1 text-base text-foreground-muted">{props.label}</Text>
        {action ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={action.onPress}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text className="text-base font-t3-medium text-foreground">{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center gap-3",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
    >
      <Text className="flex-1 text-sm text-foreground-tertiary">{props.label}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={action.onPress}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Text className="text-sm font-t3-medium text-primary">{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Agent-side rows sit one step in under their Project row; grouped rows inset themselves. */
function AgentIndent(props: { readonly grouped: boolean; readonly children: React.ReactNode }) {
  return props.grouped ? props.children : <View className="pl-4">{props.children}</View>;
}

const NewAgentRow = memo(function NewAgentRow(props: {
  readonly pane: "screen" | "sidebar";
  readonly grouped: boolean;
  readonly project: EnvironmentProject;
  readonly onNewAgent: (project: EnvironmentProject) => void;
}) {
  return (
    <AgentIndent grouped={props.grouped}>
      <Pressable
        accessibilityLabel={`New agent in ${props.project.title}`}
        accessibilityRole="button"
        className={cn(
          "min-h-11 flex-row items-center",
          props.grouped ? "gap-2 pr-4" : "gap-2.5",
          props.grouped ? null : props.pane === "sidebar" ? "px-3" : "px-5",
        )}
        onPress={() => props.onNewAgent(props.project)}
        style={({ pressed }) => ({
          opacity: pressed ? 0.5 : 1,
          ...(props.grouped ? CHILD_INSET_STYLE : null),
        })}
      >
        <View
          className={
            props.grouped ? "items-center justify-center" : "size-4 items-center justify-center"
          }
        >
          <SymbolView
            name="plus"
            size={13}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </View>
        <Text className="text-base text-foreground-muted">New agent</Text>
      </Pressable>
    </AgentIndent>
  );
});

const AgentSettledToggleRow = memo(function AgentSettledToggleRow(props: {
  readonly pane: "screen" | "sidebar";
  readonly grouped: boolean;
  readonly expansionKey: string;
  readonly label: string;
  readonly nextSettledCount: number;
  readonly onPress: (expansionKey: string, count: number) => void;
}) {
  if (props.grouped) {
    const showsMore = props.nextSettledCount > 0;
    return (
      <Pressable
        accessibilityRole="button"
        className="min-h-10 flex-row items-center gap-1.5 pr-4"
        onPress={() => props.onPress(props.expansionKey, props.nextSettledCount)}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, ...CHILD_INSET_STYLE })}
      >
        <Text className="text-[13px] text-foreground-tertiary">{props.label}</Text>
        <SymbolView
          name={showsMore ? "chevron.down" : "chevron.up"}
          size={10}
          tintColorClassName="accent-foreground-tertiary"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    );
  }
  return (
    <AgentIndent grouped={false}>
      <Pressable
        accessibilityRole="button"
        className={cn("min-h-9 justify-center", props.pane === "sidebar" ? "px-3" : "px-5")}
        onPress={() => props.onPress(props.expansionKey, props.nextSettledCount)}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <Text className="text-sm text-foreground-tertiary">{props.label}</Text>
      </Pressable>
    </AgentIndent>
  );
});

export function HomeSectionList(
  props: HomeSectionListProps & {
    readonly pane: "screen" | "sidebar";
    readonly model: HomeSectionsModel;
    /** False until a shell snapshot arrives; the list then shows ListEmptyComponent. */
    readonly ready?: boolean;
    readonly searchQuery: string;
    readonly threadSearchMatchByKey: ReadonlyMap<string, EnvironmentThreadSearchMatch>;
    readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
    /** Minute clock the rows' snooze menus refresh against. */
    readonly nowMinute: string;
    readonly selectedThreadKey: string | null;
    readonly onSelectThread: (thread: ThreadSelection) => void;
    /** A Tasks folder's "+": the composer on that workspace. */
    readonly onNewThreadInProject: (project: EnvironmentProject) => void;
    /** A Project's New agent row: the composer on the Project folder. */
    readonly onNewAgent: (project: EnvironmentProject) => void;
    readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
    readonly onAddWorkspace: () => void;
    /** The iPad sidebar's native scroll gesture, so row swipes yield to it. */
    readonly scrollGesture?: NativeGesture;
    readonly fullSwipeWidth?: number;
  },
) {
  const {
    model,
    pane,
    fullSwipeWidth,
    nowMinute,
    scrollGesture,
    searchQuery,
    selectedThreadKey,
    threadSearchMatchByKey,
    onSelectThread,
    onNewAgent,
    onNewThreadInProject,
    onNewThreadOnBranch,
    onAddWorkspace,
  } = props;
  const { capabilities, pendingOrder, queuedThreadKeys, sectionPreferences, shelf } = model;
  const { items } = model.sections;
  // Android keeps its own row surfaces in the sidebar.
  const rowPane = pane === "sidebar" && Platform.OS !== "android" ? "sidebar" : "screen";
  const grouped = pane === "screen" && Platform.OS === "ios";
  const rows = useMemo(() => (grouped ? homeCardRows(items) : flatRows(items)), [grouped, items]);
  const {
    archiveThread,
    confirmDeleteThread,
    moveThread,
    pinThread,
    regenerateThreadTitle,
    renameThread,
    settleThread,
    snoozeThread,
    unpinThread,
    unsettleThread,
    unsnoozeThread,
  } = useThreadListActions();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const projectActions = useProjectActions();
  const { openNewProject, openConvertToProject } = useOpenNewProject();
  // New Project needs a connected environment that supports Projects.
  const canCreateProject = capabilities.assistants.size > 0;
  const filteredEnvironmentId = model.environmentId;
  const openNewProjectHere = useCallback(
    () => openNewProject(filteredEnvironmentId),
    [filteredEnvironmentId, openNewProject],
  );
  // One stable object, so memoized agent rows skip renders that change nothing.
  const agentRowActions = useMemo(
    () => ({
      onStop: (thread: EnvironmentThreadShell) => void projectActions.stopAgent(thread),
      onSetCoordinator: (thread: EnvironmentThreadShell) =>
        void projectActions.setCoordinator(thread),
    }),
    [projectActions],
  );
  const handleProjectMenuAction = useCallback(
    (project: EnvironmentProject, action: ProjectRowMenuAction) => {
      if (action === "new-agent") onNewAgent(project);
      else void runProjectMenuAction(projectActions, project, action);
    },
    [onNewAgent, projectActions],
  );

  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) openSwipeableRef.current = null;
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onMaterialFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  const handleSelectThread = useCallback(
    (thread: ThreadSelection) => {
      openSwipeableRef.current?.close();
      onSelectThread(thread);
    },
    [onSelectThread],
  );
  const handleOpenCoordinator = useCallback(
    (project: EnvironmentProject) => {
      const coordinatorThreadId = project.assistant?.coordinatorThreadId;
      // Known before the coordinator's shell arrives, as on web.
      if (coordinatorThreadId !== undefined) {
        handleSelectThread({ environmentId: project.environmentId, id: coordinatorThreadId });
      }
    },
    [handleSelectThread],
  );

  // Move up/down targets the folder neighbor. Rows keep a stable handler and
  // read their current destination here, so a rebuild never re-renders them.
  const taskRowByKeyRef = useRef<ReadonlyMap<string, HomeTaskThreadItem>>(new Map());
  useEffect(() => {
    taskRowByKeyRef.current = new Map(
      items.flatMap((item) => (item.type === "v2-thread" ? [[item.key, item] as const] : [])),
    );
  }, [items]);
  const handleMoveThread = useCallback(
    (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
      if (typeof direction !== "string") {
        void moveThread(thread, direction);
        return;
      }
      const row = taskRowByKeyRef.current.get(
        `v2-thread:${scopedThreadKey(thread.environmentId, thread.id)}`,
      );
      const destination = direction === "up" ? row?.moveUp : row?.moveDown;
      if (destination) void moveThread(thread, destination);
    },
    [moveThread],
  );

  const { selectionReveal } = model.sections;
  const { loaded: preferencesLoaded, reveal } = sectionPreferences;
  // Opening a thread reveals it once, like web: its Project expands and a
  // collapsed section or folder opens. Collapsing again afterwards sticks.
  const revealedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedThreadKey === null) {
      revealedSelectionRef.current = null;
      return;
    }
    if (
      !preferencesLoaded ||
      revealedSelectionRef.current === selectedThreadKey ||
      selectionReveal === null
    ) {
      return;
    }
    revealedSelectionRef.current = selectedThreadKey;
    reveal(selectionReveal);
  }, [preferencesLoaded, reveal, selectedThreadKey, selectionReveal]);

  const environmentLabelFor = useCallback(
    (environmentId: EnvironmentThreadShell["environmentId"]) =>
      Object.keys(props.savedConnectionsById).length > 1
        ? (props.savedConnectionsById[environmentId]?.environmentLabel ?? null)
        : null,
    [props.savedConnectionsById],
  );

  const renderThreadRow = useCallback(
    (
      thread: EnvironmentThreadShell,
      options: {
        readonly variant: "card" | "slim";
        readonly snoozed: boolean;
        readonly pinned: boolean;
        readonly snoozeWakeLabelText: string | undefined;
        readonly standing: boolean;
        readonly agent: boolean;
        readonly canMoveUp: boolean;
        readonly canMoveDown: boolean;
      },
    ) => {
      return (
        <ThreadListV2Row
          thread={thread}
          variant={options.variant}
          hasQueuedMessages={queuedThreadKeys.has(scopedThreadKey(thread.environmentId, thread.id))}
          snoozed={options.snoozed}
          pinned={options.pinned}
          standing={options.standing}
          snoozePresetMinute={nowMinute}
          snoozeWakeLabelText={options.snoozeWakeLabelText}
          project={null}
          providerInstance={resolveThreadProviderInstance(capabilities.serverConfigs, thread)}
          environmentLabel={environmentLabelFor(thread.environmentId)}
          environmentMachine={capabilities.machineByEnvironmentId.get(thread.environmentId)}
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
          )}
          searchQuery={searchQuery}
          pane={rowPane}
          grouped={grouped}
          selected={scopedThreadKey(thread.environmentId, thread.id) === selectedThreadKey}
          {...(fullSwipeWidth !== undefined ? { fullSwipeWidth } : {})}
          onSelectThread={handleSelectThread}
          onDeleteThread={confirmDeleteThread}
          {...(options.agent ? { agent: agentRowActions } : { onNewThreadOnBranch })}
          onArchiveThread={archiveThread}
          onRenameThread={renameThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          titleRegenerationSupported={capabilities.titleRegeneration.has(thread.environmentId)}
          settlementSupported={capabilities.settlement.has(thread.environmentId)}
          onSettleThread={settleThread}
          snoozeSupported={capabilities.snooze.has(thread.environmentId)}
          pinningSupported={capabilities.pinning.has(thread.environmentId)}
          reorderSupported={
            !options.agent &&
            (options.pinned
              ? capabilities.pinReorder.has(thread.environmentId)
              : capabilities.activeReorder.has(thread.environmentId))
          }
          canMoveUp={options.canMoveUp}
          canMoveDown={options.canMoveDown}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onMoveThread={handleMoveThread}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          {...(scrollGesture ? { simultaneousSwipeGesture: scrollGesture } : {})}
        />
      );
    },
    [
      agentRowActions,
      capabilities,
      environmentLabelFor,
      fullSwipeWidth,
      grouped,
      handleMoveThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      nowMinute,
      onNewThreadOnBranch,
      queuedThreadKeys,
      rowPane,
      scrollGesture,
      searchQuery,
      selectedThreadKey,
      archiveThread,
      confirmDeleteThread,
      pinThread,
      regenerateThreadTitle,
      renameThread,
      settleThread,
      snoozeThread,
      threadSearchMatchByKey,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );

  const { setAssistantSettledCount, showMoreSettled, threadMovePlanners } = model;
  const renderRow = useCallback(
    (item: HomeSectionItem) => {
      switch (item.type) {
        case "section":
          return (
            <HomeSectionHeader
              pane={rowPane}
              section={item.section}
              collapseKey={item.collapseKey}
              collapsed={item.collapsed}
              forcedOpen={item.forcedOpen}
              rollup={item.rollup}
              grouped={grouped}
              onToggle={sectionPreferences.toggleCollapsed}
              {...(item.section === "tasks"
                ? { onAdd: onAddWorkspace, addLabel: "Add workspace" }
                : canCreateProject
                  ? { onAdd: openNewProjectHere, addLabel: "New Project" }
                  : {})}
            />
          );
        case "projects-empty":
          return item.unsupported ? (
            <EmptySectionRow
              pane={rowPane}
              grouped={grouped}
              label="This server doesn't support Projects yet. Update Control Plane on it."
            />
          ) : (
            <EmptySectionRow
              pane={rowPane}
              grouped={grouped}
              label="No Projects yet"
              {...(canCreateProject
                ? { action: { label: "New Project", onPress: openNewProjectHere } }
                : {})}
            />
          );
        case "tasks-empty":
          return <EmptySectionRow pane={rowPane} grouped={grouped} label="No workspaces yet" />;
        case "project":
          return (
            <ProjectListRow
              pane={rowPane}
              grouped={grouped}
              project={item.project}
              expansionKey={item.expansionKey}
              expanded={item.expanded}
              forcedOpen={item.forcedOpen}
              running={item.running}
              rollup={item.rollup}
              canSchedule={capabilities.schedules.has(item.project.environmentId)}
              selected={item.selected}
              onOpen={handleOpenCoordinator}
              onToggleExpanded={sectionPreferences.toggleAssistantExpanded}
              onMenuAction={handleProjectMenuAction}
            />
          );
        case "new-agent":
          return (
            <NewAgentRow
              pane={rowPane}
              grouped={grouped}
              project={item.project}
              onNewAgent={onNewAgent}
            />
          );
        case "agent":
          return (
            <AgentIndent grouped={grouped}>
              {renderThreadRow(item.item.thread, {
                variant: item.item.variant,
                snoozed: item.item.snoozed,
                pinned: item.item.pinned,
                snoozeWakeLabelText: item.snoozeWakeLabelText,
                standing: item.standing,
                agent: true,
                canMoveUp: false,
                canMoveDown: false,
              })}
            </AgentIndent>
          );
        case "agent-pending":
          return (
            <AgentIndent grouped={grouped}>
              <ThreadListV2PendingRow
                grouped={grouped}
                pendingTask={item.pendingTask}
                project={null}
                environmentLabel={environmentLabelFor(item.pendingTask.environmentId)}
                environmentMachine={capabilities.machineByEnvironmentId.get(
                  item.pendingTask.environmentId,
                )}
                pane={pane}
                showPendingDivider={false}
                onSelectPendingTask={openPendingTask}
                onDeletePendingTask={confirmDeletePendingTask}
              />
            </AgentIndent>
          );
        case "agent-settled-toggle":
          return (
            <AgentSettledToggleRow
              pane={rowPane}
              grouped={grouped}
              expansionKey={item.expansionKey}
              label={item.label}
              nextSettledCount={item.nextSettledCount}
              onPress={setAssistantSettledCount}
            />
          );
        case "folder":
          return (
            <TaskFolderHeader
              pane={rowPane}
              grouped={grouped}
              collapseKey={item.collapseKey}
              title={item.title}
              project={item.project}
              count={item.count}
              collapsed={item.collapsed}
              forcedOpen={item.forcedOpen}
              rollup={item.rollup}
              isFirst={item.isFirst}
              newThreadTarget={item.newThreadTarget}
              members={item.members}
              convertEnvironmentIds={capabilities.assistants}
              environmentLabelFor={environmentLabelFor}
              onToggle={sectionPreferences.toggleCollapsed}
              onNewThread={onNewThreadInProject}
              onConvert={openConvertToProject}
            />
          );
        case "v2-thread": {
          const thread = item.item.thread;
          const movedId = scopedThreadKey(thread.environmentId, thread.id);
          const planner = item.item.pinned ? threadMovePlanners.pinned : threadMovePlanners.active;
          return renderThreadRow(thread, {
            variant: item.item.variant,
            snoozed: item.item.snoozed,
            pinned: item.item.pinned,
            snoozeWakeLabelText: item.snoozeWakeLabelText,
            standing: false,
            agent: false,
            canMoveUp:
              pendingOrder === null &&
              item.moveUp !== null &&
              planner(movedId, item.moveUp) !== null,
            canMoveDown:
              pendingOrder === null &&
              item.moveDown !== null &&
              planner(movedId, item.moveDown) !== null,
          });
        }
        case "v2-pending":
          return (
            <ThreadListV2PendingRow
              pendingTask={item.pendingTask}
              project={null}
              environmentLabel={environmentLabelFor(item.pendingTask.environmentId)}
              environmentMachine={capabilities.machineByEnvironmentId.get(
                item.pendingTask.environmentId,
              )}
              pane={pane}
              grouped={grouped}
              showPendingDivider={item.showPendingDivider}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              disabled={!shelf.loaded}
              expanded={item.expanded}
              onToggle={shelf.toggleSnoozedShelf}
              pane={rowPane}
            />
          );
        case "v2-settled-shelf":
          return (
            <ThreadListV2SettledShelfHeader
              count={item.count}
              disabled={!shelf.loaded}
              expanded={item.expanded}
              onToggle={shelf.toggleSettledShelf}
              pane={rowPane}
            />
          );
        case "v2-show-more":
          return (
            <ThreadListV2ShowMoreRow hiddenCount={item.hiddenCount} onPress={showMoreSettled} />
          );
      }
    },
    [
      canCreateProject,
      capabilities.assistants,
      capabilities.machineByEnvironmentId,
      capabilities.schedules,
      confirmDeletePendingTask,
      environmentLabelFor,
      grouped,
      handleOpenCoordinator,
      handleProjectMenuAction,
      onAddWorkspace,
      onNewAgent,
      onNewThreadInProject,
      openConvertToProject,
      openNewProjectHere,
      openPendingTask,
      pane,
      pendingOrder,
      renderThreadRow,
      rowPane,
      sectionPreferences.toggleAssistantExpanded,
      sectionPreferences.toggleCollapsed,
      setAssistantSettledCount,
      shelf.loaded,
      shelf.toggleSettledShelf,
      shelf.toggleSnoozedShelf,
      showMoreSettled,
      threadMovePlanners,
    ],
  );
  const renderItem = useCallback(
    ({ item: row }: { readonly item: HomeCardRow }) =>
      row.edge === "none" ? (
        renderRow(row.item)
      ) : (
        <CardSegment edge={row.edge}>{renderRow(row.item)}</CardSegment>
      ),
    [renderRow],
  );

  // Everything rows read besides their item. A changed identity re-renders
  // the visible rows; memoized rows whose props match skip the work.
  const extraData = useMemo(
    () => ({
      capabilities,
      pendingOrder,
      queuedThreadKeys,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery,
      selectedThreadKey,
      snoozePresetMinute: nowMinute,
      threadMovePlanners,
      threadSearchMatchByKey,
      // Header and shelf toggles are no-ops until preferences load. Rows
      // recycled before then must re-render to pick up the live handlers.
      preferencesLoaded: sectionPreferences.loaded,
      shelfLoaded: shelf.loaded,
    }),
    [
      capabilities,
      nowMinute,
      pendingOrder,
      props.savedConnectionsById,
      queuedThreadKeys,
      searchQuery,
      sectionPreferences.loaded,
      selectedThreadKey,
      shelf.loaded,
      threadMovePlanners,
      threadSearchMatchByKey,
    ],
  );

  const list = (
    <LegendList
      data={props.ready === false ? NO_ROWS : rows}
      drawDistance={500}
      estimatedItemSize={64}
      extraData={extraData}
      getItemType={rowType}
      itemsAreEqual={rowsAreEqual}
      keyExtractor={rowKey}
      renderItem={renderItem}
      automaticallyAdjustsScrollIndicatorInsets={props.automaticallyAdjustsScrollIndicatorInsets}
      contentInsetAdjustmentBehavior={props.contentInsetAdjustmentBehavior}
      contentContainerStyle={props.contentContainerStyle}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      {...scrollGateHandlers}
      recycleItems
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
      style={props.style}
      ListHeaderComponent={props.ListHeaderComponent}
      ListEmptyComponent={props.ListEmptyComponent}
    />
  );
  return (
    <SwipeableScrollGateProvider enabled={swipeEnabled}>
      {scrollGesture ? <GestureDetector gesture={scrollGesture}>{list}</GestureDetector> : list}
    </SwipeableScrollGateProvider>
  );
}
