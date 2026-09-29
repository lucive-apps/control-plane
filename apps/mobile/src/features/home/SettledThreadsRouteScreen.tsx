import { partitionAssistants } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useProjects, useThreadShells } from "../../state/entities";
import { GROUPED_CHILD_INSET, ThreadListV2Row } from "../threads/thread-list-v2-items";
import { resolveThreadProviderInstance } from "../threads/thread-provider-instance";
import { useHomeListOptions } from "./home-list-options";
import { buildSettledWorkspaceGroups } from "./settledThreads";
import { useHomeCapabilities } from "./useHomeSections";
import { useThreadListActions } from "./useThreadListActions";

// Fork-owned. Settled Tasks threads, off the iPhone Home: one group per
// workspace in the Home's plain row style, collapsed until tapped so a large
// repo doesn't bury the rest. Swipe or long-press unsettles.

type SettledItem =
  | {
      readonly type: "group";
      readonly key: string;
      readonly title: string;
      readonly first: boolean;
      readonly count: number;
      readonly expanded: boolean;
    }
  | { readonly type: "thread"; readonly key: string; readonly thread: EnvironmentThreadShell };

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();
const SEPARATOR_STYLE = { marginLeft: GROUPED_CHILD_INSET, marginRight: 20 } as const;
const itemType = (item: SettledItem) => item.type;
const itemKey = (item: SettledItem) => item.key;
const minuteNow = () => new Date().toISOString().slice(0, 16);

export function SettledThreadsRouteScreen() {
  const navigation = useNavigation();
  const projects = useProjects();
  const threads = useThreadShells();
  const capabilities = useHomeCapabilities();
  const { projectGroupingMode } = useHomeListOptions(NO_ENVIRONMENTS).options;
  const actions = useThreadListActions();
  // Refreshed on focus so relative times and snooze presets are current.
  const [nowMinute, setNowMinute] = useState(minuteNow);
  useFocusEffect(useCallback(() => setNowMinute(minuteNow()), []));
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const items = useMemo(() => {
    const partition = partitionAssistants(projects, threads, null);
    const groups = buildSettledWorkspaceGroups({
      projects: partition.workspaceProjects,
      threads: partition.workspaceThreads,
      projectGroupingMode,
      settlementEnvironmentIds: capabilities.settlement,
      now: `${nowMinute}:00.000Z`,
    });
    return groups.flatMap((group, index): SettledItem[] => {
      const key = `group:${group.key}`;
      const expanded = expandedGroups.has(key);
      return [
        {
          type: "group",
          key,
          title: group.title,
          first: index === 0,
          count: group.threads.length,
          expanded,
        },
        ...(expanded
          ? group.threads.map((thread): SettledItem => ({
              type: "thread",
              key: `thread:${thread.environmentId}:${thread.id}`,
              thread,
            }))
          : []),
      ];
    });
  }, [capabilities.settlement, expandedGroups, nowMinute, projectGroupingMode, projects, threads]);

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
  const openThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      openSwipeableRef.current?.close();
      navigation.dispatch(
        StackActions.push("Thread", { environmentId: thread.environmentId, threadId: thread.id }),
      );
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { readonly item: SettledItem }) => {
      if (item.type === "group") {
        return (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: item.expanded }}
              onPress={() => toggleGroup(item.key)}
              className="min-h-[54px] flex-row items-center gap-3 px-5 py-2"
              style={item.first ? undefined : { marginTop: 16 }}
            >
              <SymbolView
                name={{ ios: "folder", android: "folder" }}
                size={20}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text className="flex-1 text-[17px] text-foreground" numberOfLines={1}>
                {item.title}
              </Text>
              <Text className="text-[15px] tabular-nums text-foreground-muted">{item.count}</Text>
              <View style={{ transform: [{ rotate: item.expanded ? "90deg" : "0deg" }] }}>
                <SymbolView
                  name={{ ios: "chevron.right", android: "chevron_right" }}
                  size={13}
                  tintColorClassName="accent-foreground-muted"
                  type="monochrome"
                />
              </View>
            </Pressable>
            <View className="h-px bg-border" style={SEPARATOR_STYLE} />
          </View>
        );
      }
      const { thread } = item;
      return (
        <View>
          <ThreadListV2Row
            thread={thread}
            variant="slim"
            grouped
            snoozePresetMinute={nowMinute}
            project={null}
            providerInstance={resolveThreadProviderInstance(capabilities.serverConfigs, thread)}
            environmentLabel={null}
            onSelectThread={openThread}
            onDeleteThread={actions.confirmDeleteThread}
            onRenameThread={actions.renameThread}
            onRegenerateThreadTitle={actions.regenerateThreadTitle}
            onSettleThread={actions.settleThread}
            onSnoozeThread={actions.snoozeThread}
            onUnsnoozeThread={actions.unsnoozeThread}
            onUnsettleThread={actions.unsettleThread}
            onArchiveThread={actions.archiveThread}
            onPinThread={actions.pinThread}
            onUnpinThread={actions.unpinThread}
            settlementSupported={capabilities.settlement.has(thread.environmentId)}
            snoozeSupported={capabilities.snooze.has(thread.environmentId)}
            pinningSupported={capabilities.pinning.has(thread.environmentId)}
            titleRegenerationSupported={capabilities.titleRegeneration.has(thread.environmentId)}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            onSwipeableClose={handleSwipeableClose}
          />
          <View className="h-px bg-border" style={SEPARATOR_STYLE} />
        </View>
      );
    },
    [
      actions,
      capabilities,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      nowMinute,
      openThread,
      toggleGroup,
    ],
  );

  return (
    <View className="flex-1 bg-screen">
      <LegendList
        data={items}
        estimatedItemSize={48}
        extraData={capabilities}
        getItemType={itemType}
        keyExtractor={itemKey}
        renderItem={renderItem}
        recycleItems
        automaticallyAdjustsScrollIndicatorInsets
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={
          items.length === 0 ? { flexGrow: 1, justifyContent: "center" } : { paddingBottom: 32 }
        }
        onScrollBeginDrag={() => openSwipeableRef.current?.close()}
        ListEmptyComponent={
          <EmptyState
            title="Nothing settled yet"
            detail="Settled threads from your workspaces show up here."
            variant="plain"
          />
        }
        style={{ flex: 1 }}
      />
    </View>
  );
}
