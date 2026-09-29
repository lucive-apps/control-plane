import type { SidebarRollupStatus } from "@t3tools/client-runtime/state/assistant-lists";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { buildTaskFolderMenu, resolveTaskFolderMenuAction } from "../projects/projectMenus";
import { rollupDotColor, rollupDotLabel, ThreadStatusDot } from "../threads/thread-status-dot";

// Fork-owned. A Tasks folder (workspace) header in the Home list. Same look as
// the grouped list's folder header it replaces: favicon, title, count and a
// trailing "+", plus the rolled-up dot while collapsed. Long-press offers New
// thread and Convert to Project….

// iOS drops a menu's className, so the menu takes the toggle's flex slot by style.
const MENU_SLOT_STYLE = { flex: 1, minWidth: 0 } as const;
const CHEVRON_OPEN_STYLE = { transform: [{ rotate: "90deg" }] } as const;

export const TaskFolderHeader = memo(function TaskFolderHeader(props: {
  readonly pane: "screen" | "sidebar";
  /** A row of the grouped Home's Tasks card (iOS phone): chevron, outline
      folder (never the favicon) and name, with the dot only while collapsed.
      New thread stays on long-press. */
  readonly grouped?: boolean;
  readonly collapseKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly count: number;
  readonly collapsed: boolean;
  /** Search or the Workspace filter holds the folder open; tapping does nothing meanwhile. */
  readonly forcedOpen: boolean;
  readonly rollup: SidebarRollupStatus;
  readonly isFirst: boolean;
  /** Where the "+" starts a thread; null hides it and the long-press menu. */
  readonly newThreadTarget: EnvironmentProject | null;
  /** The folder's checkouts; Convert offers those on `convertEnvironmentIds`. */
  readonly members: ReadonlyArray<EnvironmentProject>;
  readonly convertEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly environmentLabelFor: (environmentId: EnvironmentId) => string | null;
  readonly onToggle: (collapseKey: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
  readonly onConvert: (project: EnvironmentProject) => void;
}) {
  const { newThreadTarget, members, convertEnvironmentIds, environmentLabelFor } = props;
  const compact = props.pane === "screen";
  const dotColor = props.collapsed ? rollupDotColor(props.rollup) : null;
  const statusLabel = props.collapsed ? rollupDotLabel(props.rollup) : null;
  // The "+" is a sibling of the toggle, not a child: nested touchables are
  // unreachable to VoiceOver and TalkBack. The row's vertical padding sits on
  // both touchables, not the row: on iOS the long-press menu wraps the toggle
  // and clips any hitSlop to its own bounds.
  const verticalPadding = {
    paddingTop: props.isFirst ? (compact ? 8 : 4) : compact ? 24 : 20,
    paddingBottom: compact ? 12 : 8,
  };

  const menuMembers = useMemo(
    () =>
      members.map((member) => ({
        key: scopedProjectKey(member.environmentId, member.id),
        title: member.title,
        workspaceRoot: member.workspaceRoot,
        environmentLabel: environmentLabelFor(member.environmentId),
        project: member,
      })),
    [environmentLabelFor, members],
  );
  const menu = useMemo(
    () =>
      newThreadTarget === null
        ? null
        : buildTaskFolderMenu({
            members: menuMembers,
            canConvert: (member) => convertEnvironmentIds.has(member.project.environmentId),
          }),
    [convertEnvironmentIds, menuMembers, newThreadTarget],
  );

  const grouped = props.grouped === true && compact;
  const toggleAccessibility = {
    accessibilityHint: props.forcedOpen
      ? undefined
      : props.collapsed
        ? "Expands the workspace"
        : "Collapses the workspace",
    accessibilityLabel: [
      props.title,
      `${props.count} ${props.count === 1 ? "thread" : "threads"}`,
      statusLabel,
    ]
      .filter(Boolean)
      .join(", "),
    accessibilityRole: "button",
    accessibilityState: { expanded: !props.collapsed, disabled: props.forcedOpen },
  } as const;

  const groupedToggle = (
    <Pressable
      {...toggleAccessibility}
      className="min-h-[52px] flex-row items-center gap-3 bg-card px-4 py-2"
      // Not `disabled`, which would also block the long-press menu on Android.
      onPress={props.forcedOpen ? undefined : () => props.onToggle(props.collapseKey)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name="chevron.right"
        size={14}
        style={props.collapsed ? undefined : CHEVRON_OPEN_STYLE}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
        weight="semibold"
      />
      {/* Every workspace shows the same outline folder here, never its favicon. */}
      <SymbolView
        name={{ ios: "folder", android: "folder" }}
        size={20}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      <Text className="flex-1 text-[17px] text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
      {dotColor !== null ? <ThreadStatusDot color={dotColor} grouped /> : null}
    </Pressable>
  );

  if (grouped) {
    return menu === null || newThreadTarget === null ? (
      groupedToggle
    ) : (
      <ControlPillMenu
        actions={menu}
        onPressAction={({ nativeEvent }) => {
          const selection = resolveTaskFolderMenuAction(menuMembers, nativeEvent.event);
          if (selection?.kind === "new-thread") props.onNewThread(newThreadTarget);
          if (selection?.kind === "convert") props.onConvert(selection.member.project);
        }}
        shouldOpenOnLongPress
      >
        {groupedToggle}
      </ControlPillMenu>
    );
  }

  const toggle = (
    <Pressable
      {...toggleAccessibility}
      className={
        compact ? "flex-1 flex-row items-center gap-2.5" : "flex-1 flex-row items-center gap-2"
      }
      // Not `disabled`, which would also block the long-press menu on Android.
      onPress={props.forcedOpen ? undefined : () => props.onToggle(props.collapseKey)}
      style={{ ...verticalPadding, paddingLeft: compact ? 20 : 12 }}
    >
      <ProjectFavicon
        environmentId={props.project.environmentId}
        faviconPath={props.project.faviconPath}
        folderTintClassName="accent-foreground-muted"
        open={!props.collapsed}
        projectIcon={props.project.projectIcon}
        projectTitle={props.project.title}
        size={compact ? 22 : 18}
        workspaceRoot={props.project.workspaceRoot === "" ? null : props.project.workspaceRoot}
      />
      <Text
        className={
          compact
            ? "flex-shrink text-base font-t3-bold tracking-[0.2px] text-foreground-muted"
            : "flex-shrink text-sm font-t3-bold tracking-[0.2px] text-foreground-muted"
        }
        numberOfLines={1}
      >
        {props.title}
      </Text>
      <Text
        className={
          compact
            ? "text-sm font-t3-medium text-foreground-tertiary"
            : "text-xs font-t3-medium text-foreground-tertiary"
        }
      >
        {props.count}
      </Text>
      {dotColor !== null ? <ThreadStatusDot color={dotColor} /> : null}
      <View className="flex-1" />
    </Pressable>
  );

  return (
    <View
      className="flex-row items-center"
      style={{
        minHeight: compact ? 44 : 36,
        // Centers the plus glyph on the thread rows' trailing column.
        paddingRight: compact ? 14 : 12,
      }}
    >
      {menu === null || newThreadTarget === null ? (
        toggle
      ) : (
        <ControlPillMenu
          actions={menu}
          onPressAction={({ nativeEvent }) => {
            const selection = resolveTaskFolderMenuAction(menuMembers, nativeEvent.event);
            if (selection?.kind === "new-thread") props.onNewThread(newThreadTarget);
            if (selection?.kind === "convert") props.onConvert(selection.member.project);
          }}
          shouldOpenOnLongPress
          style={MENU_SLOT_STYLE}
        >
          {toggle}
        </ControlPillMenu>
      )}
      {newThreadTarget !== null ? (
        <Pressable
          accessibilityLabel={`Create new thread in ${props.title}`}
          accessibilityRole="button"
          hitSlop={{ left: 10, right: 14 }}
          onPress={() => props.onNewThread(newThreadTarget)}
          style={({ pressed }) => ({
            opacity: pressed ? 0.5 : 1,
            paddingLeft: 12,
            ...verticalPadding,
          })}
        >
          <SymbolView
            name="plus"
            size={compact ? 20 : 16}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
            weight="medium"
          />
        </Pressable>
      ) : null}
    </View>
  );
});
