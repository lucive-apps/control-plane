import type { SidebarRollupStatus } from "@t3tools/client-runtime/state/assistant-lists";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";
import { rollupDotColor, rollupDotLabel, ThreadStatusDot } from "../threads/thread-status-dot";
import {
  buildProjectRowMenu,
  isProjectRowMenuAction,
  type ProjectRowMenuAction,
} from "./projectMenus";

// Fork-owned. One Project in the Home list: the row opens the coordinator,
// a long-press opens the Project menu, and the trailing chevron shows or
// hides its agents.

const PROJECT_ROW_MENU = buildProjectRowMenu(false);
const PROJECT_ROW_MENU_WITH_SCHEDULES = buildProjectRowMenu(true);
// iOS drops a menu's className, so the menu takes the row's flex slot by style.
const MENU_SLOT_STYLE = { flex: 1, minWidth: 0 } as const;
const CHEVRON_OPEN_STYLE = { transform: [{ rotate: "90deg" }] } as const;

export const ProjectListRow = memo(function ProjectListRow(props: {
  readonly pane: "screen" | "sidebar";
  /** A row of the iPhone Home's Projects section: icon, title, count, trailing chevron. */
  readonly grouped?: boolean;
  readonly project: EnvironmentProject;
  readonly expansionKey: string;
  readonly expanded: boolean;
  /** Search holds the Project open; the chevron does nothing meanwhile. */
  readonly forcedOpen: boolean;
  readonly running: number;
  readonly rollup: SidebarRollupStatus;
  /** Its server stores schedules, so the menu offers Schedules. */
  readonly canSchedule: boolean;
  /** The coordinator is open in the detail pane (iPad). */
  readonly selected: boolean;
  readonly onOpen: (project: EnvironmentProject) => void;
  readonly onToggleExpanded: (expansionKey: string) => void;
  readonly onMenuAction: (project: EnvironmentProject, action: ProjectRowMenuAction) => void;
}) {
  const { project, expanded, forcedOpen, running, selected, onMenuAction } = props;
  const sidebarPane = props.pane === "sidebar";
  const dotColor = rollupDotColor(props.rollup);
  // Selection uses the thread rows' filled surface and its paired foregrounds.
  const android = Platform.OS === "android";
  const accessibilityLabel = [
    project.title,
    running > 0 ? `${running} running` : null,
    rollupDotLabel(props.rollup),
  ]
    .filter(Boolean)
    .join(", ");
  const menuActions = props.canSchedule ? PROJECT_ROW_MENU_WITH_SCHEDULES : PROJECT_ROW_MENU;

  if (props.grouped === true && !sidebarPane) {
    return (
      <View className="flex-row items-center">
        <ControlPillMenu
          actions={menuActions}
          onPressAction={({ nativeEvent }) => {
            if (isProjectRowMenuAction(nativeEvent.event)) onMenuAction(project, nativeEvent.event);
          }}
          shouldOpenOnLongPress
          style={MENU_SLOT_STYLE}
        >
          <RowPressable
            accessibilityHint="Opens the coordinator. Long-press for Project actions"
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="button"
            onPress={() => props.onOpen(project)}
          >
            <View className="min-h-[54px] flex-row items-center gap-3 py-2 pl-5">
              <ProjectFavicon
                environmentId={project.environmentId}
                faviconPath={project.faviconPath}
                fallback="letter"
                projectIcon={project.projectIcon}
                projectTitle={project.title}
                size={20}
                workspaceRoot={project.workspaceRoot}
              />
              <Text className="flex-1 text-[17px] text-foreground" numberOfLines={1}>
                {project.title}
              </Text>
              {running > 0 ? (
                <Text className="text-[17px] tabular-nums text-foreground-muted">{running}</Text>
              ) : null}
              {dotColor !== null ? <ThreadStatusDot color={dotColor} grouped /> : null}
            </View>
          </RowPressable>
        </ControlPillMenu>
        <Pressable
          accessibilityLabel={`${expanded ? "Hide" : "Show"} agents in ${project.title}`}
          accessibilityRole="button"
          accessibilityState={{ expanded, disabled: forcedOpen }}
          className="min-h-[54px] items-center justify-center pr-5 pl-3"
          disabled={forcedOpen}
          hitSlop={{ left: 8 }}
          onPress={() => props.onToggleExpanded(props.expansionKey)}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <SymbolView
            name="chevron.right"
            size={14}
            style={expanded ? CHEVRON_OPEN_STYLE : undefined}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
    );
  }

  return (
    <View
      className={cn(
        "flex-row items-center",
        selected && (android ? "bg-thread-selected" : "bg-user-bubble"),
        sidebarPane ? "rounded-xl" : null,
      )}
    >
      <ControlPillMenu
        actions={menuActions}
        onPressAction={({ nativeEvent }) => {
          if (isProjectRowMenuAction(nativeEvent.event)) onMenuAction(project, nativeEvent.event);
        }}
        shouldOpenOnLongPress
        style={MENU_SLOT_STYLE}
      >
        <RowPressable
          accessibilityHint="Opens the coordinator. Long-press for Project actions"
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          className={sidebarPane ? "rounded-xl" : undefined}
          onPress={() => props.onOpen(project)}
        >
          <View
            className={cn(
              "flex-row items-center gap-2.5",
              sidebarPane ? "min-h-[44px] py-2.5 pl-3" : "min-h-[56px] py-3 pl-5",
            )}
          >
            <ProjectFavicon
              environmentId={project.environmentId}
              faviconPath={project.faviconPath}
              folderTintClassName={
                selected
                  ? android
                    ? "accent-thread-selected-foreground"
                    : "accent-user-bubble-foreground"
                  : "accent-foreground"
              }
              projectIcon={project.projectIcon}
              projectTitle={project.title}
              size={sidebarPane ? 18 : 22}
              workspaceRoot={project.workspaceRoot}
            />
            <Text
              className={cn(
                "flex-1 text-base font-t3-medium",
                selected
                  ? android
                    ? "text-thread-selected-foreground"
                    : "text-user-bubble-foreground"
                  : "text-foreground",
              )}
              numberOfLines={1}
            >
              {project.title}
            </Text>
            {running > 0 ? (
              <Text
                className={cn(
                  "text-sm tabular-nums",
                  selected
                    ? android
                      ? "text-thread-selected-foreground-muted"
                      : "text-user-bubble-foreground-muted"
                    : "text-foreground-tertiary",
                )}
              >
                {running} running
              </Text>
            ) : null}
            {dotColor !== null ? <ThreadStatusDot color={dotColor} /> : null}
          </View>
        </RowPressable>
      </ControlPillMenu>
      <Pressable
        accessibilityLabel={`${expanded ? "Hide" : "Show"} agents in ${project.title}`}
        accessibilityRole="button"
        accessibilityState={{ expanded, disabled: forcedOpen }}
        className="size-11 items-center justify-center"
        disabled={forcedOpen}
        onPress={() => props.onToggleExpanded(props.expansionKey)}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={13}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
});
