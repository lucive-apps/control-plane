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
  homeSectionItemsAreEqual,
  withSectionActions,
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
// draws full-width rows with inset hairlines, each open section closed by an
// action row (New Project, Add Repo); the iPad sidebar and Android keep their
// own row surfaces and header "+" buttons.

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;

type HomeSectionListProps = Pick<
  LegendListProps<HomeSectionItem>,
  | "automaticallyAdjustsScrollIndicatorInsets"
  | "contentContainerStyle"
  | "contentInsetAdjustmentBehavior"
  | "ListEmptyComponent"
  | "ListHeaderComponent"
  | "style"
>;

const SECTION_LABELS = { projects: "Projects", tasks: "Tasks" } as const;
const GROUPED_HEADER_CHEVRON_COLLAPSED = { transform: [{ rotate: "-90deg" }] } as const;

const NO_ITEMS: readonly HomeSectionItem[] = [];
const itemType = (item: HomeSectionItem) => item.type;
const itemKey = (item: HomeSectionItem) => item.key;

/** Screen-edge padding of the iPhone rows; titles start at GROUPED_CHILD_INSET. */
const GROUPED_INSET = 20;
const CHILD_INSET_STYLE = { paddingLeft: GROUPED_CHILD_INSET } as const;
const SEPARATOR_STYLE = {
  marginLeft: GROUPED_CHILD_INSET,
  marginRight: GROUPED_INSET,
} as const;

/**
 * Section headers, shelf labels, and a section's closing action sit between rows;
 * every other row draws a hairline under it.
 */
function drawsSeparator(item: HomeSectionItem) {
  return (
    item.type !== "section" &&
    item.type !== "section-action" &&
    item.type !== "v2-snoozed-shelf" &&
    item.type !== "v2-settled-shelf" &&
    item.type !== "v2-show-more"
  );
}

/** A section's closing action: an icon in the icon column and a muted label. */
function SectionActionRow(props: {
  readonly icon: "plus" | "folder.badge.plus";
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-[54px] flex-row items-center gap-3 py-2"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingHorizontal: GROUPED_INSET })}
    >
      <View className="size-5 items-center justify-center">
        <SymbolView
          name={props.icon}
          size={props.icon === "plus" ? 18 : 20}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
      <Text className="flex-1 text-[17px] text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
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
    // No "+" here: each open section ends in its own action row.
    return (
      <View
        className="flex-row items-center pb-1"
        style={{
          paddingTop: props.section === "projects" ? 8 : 24,
          paddingHorizontal: GROUPED_INSET,
        }}
      >
        <Pressable
          {...toggleAccessibility}
          className="min-h-8 flex-row items-center gap-1"
          disabled={props.forcedOpen}
          hitSlop={8}
          onPress={() => props.onToggle(props.collapseKey)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text className="text-[15px] text-foreground-muted">{label}</Text>
          <SymbolView
            name="chevron.down"
            size={10}
            style={props.collapsed ? GROUPED_HEADER_CHEVRON_COLLAPSED : undefined}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
            weight="semibold"
          />
          {dotColor !== null ? <ThreadStatusDot color={dotColor} grouped /> : null}
        </Pressable>
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
    // The section's action row below offers the way forward.
    return (
      <View
        className="min-h-[54px] justify-center py-2"
        style={{ paddingLeft: GROUPED_CHILD_INSET, paddingRight: GROUPED_INSET }}
      >
        <Text className="text-[17px] text-foreground-muted">{props.label}</Text>
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
  // New Project needs an environment whose cached or live config supports Projects.
  const canCreateProject = capabilities.assistants.size > 0;
  // The iPhone closes each open section with its action row; search shows hits only.
  const searching = searchQuery.trim().length > 0;
  const listItems = useMemo(
    () =>
      grouped && !searching
        ? withSectionActions(items, { newProject: canCreateProject, addWorkspace: true })
        : items,
    [canCreateProject, grouped, items, searching],
  );
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

  const { showMoreSettled, threadMovePlanners } = model;
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
              {...(canCreateProject && !grouped
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
        case "section-action":
          return item.action === "new-project" ? (
            <SectionActionRow icon="plus" label="New Project" onPress={openNewProjectHere} />
          ) : (
            <SectionActionRow icon="folder.badge.plus" label="Add Repo" onPress={onAddWorkspace} />
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
      shelf.loaded,
      shelf.toggleSettledShelf,
      shelf.toggleSnoozedShelf,
      showMoreSettled,
      threadMovePlanners,
    ],
  );
  // The row just above a section's closing action runs straight into it, with no hairline.
  const rowsBeforeAction = useMemo(() => {
    const keys = new Set<string>();
    listItems.forEach((item, index) => {
      if (item.type === "section-action" && index > 0) keys.add(listItems[index - 1]!.key);
    });
    return keys;
  }, [listItems]);
  const renderItem = useCallback(
    ({ item }: { readonly item: HomeSectionItem }) =>
      grouped && drawsSeparator(item) && !rowsBeforeAction.has(item.key) ? (
        <View>
          {renderRow(item)}
          <View className="h-px bg-border" style={SEPARATOR_STYLE} />
        </View>
      ) : (
        renderRow(item)
      ),
    [grouped, renderRow, rowsBeforeAction],
  );

  // Everything rows read besides their item. A changed identity re-renders
  // the visible rows; memoized rows whose props match skip the work.
  const extraData = useMemo(
    () => ({
      capabilities,
      pendingOrder,
      rowsBeforeAction,
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
      rowsBeforeAction,
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
      data={props.ready === false ? NO_ITEMS : listItems}
      drawDistance={500}
      estimatedItemSize={64}
      extraData={extraData}
      getItemType={itemType}
      itemsAreEqual={homeSectionItemsAreEqual}
      keyExtractor={itemKey}
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
