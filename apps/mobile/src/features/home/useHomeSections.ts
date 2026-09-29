import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { partitionAssistants } from "@t3tools/client-runtime/state/assistants";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ServerConfig,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Preferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { usePendingThreadOrder } from "../../state/thread-order";
import { useThreadVisitMap } from "../../state/thread-visits";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import {
  getThreadListV2OrderedSection,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
} from "../threads/threadListV2";
import { createThreadMovePlanner } from "../threads/threadOrder";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import { buildHomeSections, type HomeSelectionReveal } from "./homeSections";
import type { HomeProjectSortOrder } from "./homeThreadList";

// Fork-owned. The state both Home panes feed into `buildHomeSections`: server
// capabilities, device preferences, clocks and per-session paging.

type Capabilities = ServerConfig["environment"]["capabilities"];

const EMPTY_KEYS: readonly string[] = [];

function environmentIdsWith(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  supported: (capabilities: Capabilities) => boolean,
): ReadonlySet<EnvironmentId> {
  const ids = new Set<EnvironmentId>();
  for (const [environmentId, config] of serverConfigs) {
    if (supported(config.environment.capabilities)) ids.add(environmentId);
  }
  return ids;
}

/** Which environments support each list action, from their server configs. */
function useHomeCapabilities() {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useWorkspaceState();
  const connectedKey = environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .join("\0");
  const capabilities = useMemo(
    () => ({
      settlement: environmentIdsWith(serverConfigs, (value) => value.threadSettlement === true),
      snooze: environmentIdsWith(serverConfigs, (value) => value.threadSnooze === true),
      pinning: environmentIdsWith(serverConfigs, (value) => value.threadPinning === true),
      pinReorder: environmentIdsWith(serverConfigs, (value) => value.threadPinReorder === true),
      activeReorder: environmentIdsWith(
        serverConfigs,
        (value) => value.threadActiveReorder === true,
      ),
      titleRegeneration: environmentIdsWith(
        serverConfigs,
        (value) => value.threadTitleRegeneration === true,
      ),
      schedules: environmentIdsWith(serverConfigs, (value) => value.projectSchedules !== undefined),
      machineByEnvironmentId: new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, resolveEnvironmentMachineKind(config)] as const,
        ),
      ),
    }),
    [serverConfigs],
  );
  // Connected servers split by whether their config advertises Projects. One
  // with a config but no flag predates Projects, so Home can say so.
  const { assistants, assistantsUnsupported } = useMemo(() => {
    const connected = new Set(connectedKey.length === 0 ? [] : connectedKey.split("\0"));
    const supported = new Set<EnvironmentId>();
    const unsupported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (!connected.has(environmentId)) continue;
      if (config.environment.capabilities.assistants === true) supported.add(environmentId);
      else unsupported.add(environmentId);
    }
    return {
      assistants: supported as ReadonlySet<EnvironmentId>,
      assistantsUnsupported: unsupported as ReadonlySet<EnvironmentId>,
    };
  }, [connectedKey, serverConfigs]);
  // One identity per change: rows and the list's extraData key off it.
  return useMemo(
    () => ({ serverConfigs, ...capabilities, assistants, assistantsUnsupported }),
    [assistants, assistantsUnsupported, capabilities, serverConfigs],
  );
}

export type HomeCapabilities = ReturnType<typeof useHomeCapabilities>;

/**
 * Collapsed sections and folders, and expanded Projects, saved per device.
 * Updates read the latest optimistic value, so quick repeated taps toggle
 * from what they last wrote.
 */
function useHomeSectionPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const setPreferences = useAtomSet(updateMobilePreferencesAtom);
  // useAtomSet calls a function argument with the atom's own value (this
  // updater's last result, not the preferences), so hand the updater over in a
  // thunk. It then runs on the latest preferences, optimistic writes included.
  const savePreferences = useCallback(
    (update: (current: Preferences) => Partial<Preferences>) => setPreferences(() => update),
    [setPreferences],
  );
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const collapsedList = loaded
    ? (preferencesResult.value.collapsedProjectGroups ?? EMPTY_KEYS)
    : EMPTY_KEYS;
  const expandedList = loaded
    ? (preferencesResult.value.expandedAssistantKeys ?? EMPTY_KEYS)
    : EMPTY_KEYS;
  const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);
  const expandedAssistantKeys = useMemo(() => new Set(expandedList), [expandedList]);

  const toggleCollapsed = useCallback(
    (key: string) => {
      if (!loaded) return;
      savePreferences((current: Preferences): Partial<Preferences> => {
        const keys = current.collapsedProjectGroups ?? EMPTY_KEYS;
        return {
          collapsedProjectGroups: keys.includes(key)
            ? keys.filter((candidate) => candidate !== key)
            : [...keys, key],
        };
      });
    },
    [loaded, savePreferences],
  );
  const toggleAssistantExpanded = useCallback(
    (key: string) => {
      if (!loaded) return;
      savePreferences((current: Preferences): Partial<Preferences> => {
        const keys = current.expandedAssistantKeys ?? EMPTY_KEYS;
        return {
          expandedAssistantKeys: keys.includes(key)
            ? keys.filter((candidate) => candidate !== key)
            : [...keys, key],
        };
      });
    },
    [loaded, savePreferences],
  );
  const reveal = useCallback(
    (target: HomeSelectionReveal) => {
      if (!loaded || (target.collapsedKeys.length === 0 && target.assistantKey === null)) return;
      savePreferences((current: Preferences): Partial<Preferences> => {
        const collapsed = current.collapsedProjectGroups ?? EMPTY_KEYS;
        const expanded = current.expandedAssistantKeys ?? EMPTY_KEYS;
        const { assistantKey } = target;
        return {
          ...(target.collapsedKeys.length > 0
            ? {
                collapsedProjectGroups: collapsed.filter(
                  (key) => !target.collapsedKeys.includes(key),
                ),
              }
            : {}),
          ...(assistantKey !== null && !expanded.includes(assistantKey)
            ? { expandedAssistantKeys: [...expanded, assistantKey] }
            : {}),
        };
      });
    },
    [loaded, savePreferences],
  );
  return {
    loaded,
    collapsedKeys,
    expandedAssistantKeys,
    toggleCollapsed,
    toggleAssistantExpanded,
    reveal,
  };
}

/**
 * Builds the Projects and Tasks list for one pane. The partition is memoized
 * on the shell's identity; `nowMinute` is the pane's clock.
 */
export function useHomeSections(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly workspaceKey: string | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly nowMinute: string;
}) {
  const capabilities = useHomeCapabilities();
  const queuedThreadKeys = useQueuedThreadKeys();
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const pendingOrder = usePendingThreadOrder(input.nowMinute, snoozeWakeTick);
  const shelf = useThreadListV2ShelfPreferences();
  const sectionPreferences = useHomeSectionPreferences();
  const lastVisitedAtById = useThreadVisitMap();

  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const settledResetKey = `${input.environmentId ?? "all"}:${input.workspaceKey ?? "all"}:${input.searchQuery.trim()}`;
  const [settledPaging, setSettledPaging] = useState({
    resetKey: settledResetKey,
    count: THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  });
  if (settledPaging.resetKey !== settledResetKey) {
    setSettledPaging({ resetKey: settledResetKey, count: THREAD_LIST_V2_SETTLED_INITIAL_COUNT });
  }
  const showMoreSettled = useCallback(
    () =>
      setSettledPaging((current) => ({
        ...current,
        count: current.count + THREAD_LIST_V2_SETTLED_PAGE_COUNT,
      })),
    [],
  );
  // Settled agents page per Project for the session, like the settled tail.
  const [assistantSettledCounts, setAssistantSettledCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const setAssistantSettledCount = useCallback((key: string, count: number) => {
    setAssistantSettledCounts((current) => {
      const next = new Map(current);
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  }, []);

  const partition = useMemo(
    () => partitionAssistants(input.projects, input.threads, null),
    [input.projects, input.threads],
  );
  const sections = useMemo(() => {
    // The clocks re-run the build: snoozeWakeTick exactly at a wake boundary.
    void input.nowMinute;
    void snoozeWakeTick;
    return buildHomeSections({
      partition,
      threads: input.threads,
      pendingTasks: input.pendingTasks,
      environmentId: input.environmentId,
      workspaceKey: input.workspaceKey,
      searchQuery: input.searchQuery,
      matchedThreadKeys: input.matchedThreadKeys,
      projectGroupingMode: input.projectGroupingMode,
      projectSortOrder: input.projectSortOrder,
      assistantsEnvironmentIds: capabilities.assistants,
      assistantsUnsupportedEnvironmentIds: capabilities.assistantsUnsupported,
      settlementEnvironmentIds: capabilities.settlement,
      snoozeEnvironmentIds: capabilities.snooze,
      queuedThreadKeys,
      pendingOrder,
      now: new Date().toISOString(),
      snoozeLabelNow: `${input.nowMinute}:00.000Z`,
      settledLimit: settledPaging.count,
      snoozedShelfExpanded: shelf.snoozedShelfExpanded,
      settledShelfExpanded: shelf.settledShelfExpanded,
      collapsedKeys: sectionPreferences.collapsedKeys,
      expandedAssistantKeys: sectionPreferences.expandedAssistantKeys,
      assistantSettledCounts,
      selectedThreadKey: input.selectedThreadKey,
      lastVisitedAtById,
    });
  }, [
    assistantSettledCounts,
    capabilities.assistants,
    capabilities.assistantsUnsupported,
    capabilities.settlement,
    capabilities.snooze,
    input.environmentId,
    input.matchedThreadKeys,
    input.nowMinute,
    input.pendingTasks,
    input.projectGroupingMode,
    input.projectSortOrder,
    input.searchQuery,
    input.selectedThreadKey,
    input.threads,
    input.workspaceKey,
    lastVisitedAtById,
    partition,
    pendingOrder,
    queuedThreadKeys,
    sectionPreferences.collapsedKeys,
    sectionPreferences.expandedAssistantKeys,
    settledPaging.count,
    shelf.settledShelfExpanded,
    shelf.snoozedShelfExpanded,
    snoozeWakeTick,
  ]);

  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = sections.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire the boundary string is identical and
    // the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);

  // Menu availability for Move up/down, planned over the Tasks section only
  // (the list never offers moves while a move is pending).
  const threadMovePlanners = useMemo(() => {
    void input.nowMinute;
    void snoozeWakeTick;
    const now = new Date().toISOString();
    const planner = (section: "pinned" | "active") =>
      createThreadMovePlanner({
        allThreads: input.threads,
        section,
        reorderableEnvironmentIds:
          section === "pinned" ? capabilities.pinReorder : capabilities.activeReorder,
        ordered: getThreadListV2OrderedSection({
          threads: partition.workspaceThreads,
          section,
          now,
          settlementEnvironmentIds: capabilities.settlement,
          snoozeEnvironmentIds: capabilities.snooze,
          queuedThreadKeys,
        }),
      });
    return { pinned: planner("pinned"), active: planner("active") };
  }, [
    capabilities.activeReorder,
    capabilities.pinReorder,
    capabilities.settlement,
    capabilities.snooze,
    input.nowMinute,
    input.threads,
    partition.workspaceThreads,
    queuedThreadKeys,
    snoozeWakeTick,
  ]);

  return {
    sections,
    /** The Environment filter, where New Project starts. */
    environmentId: input.environmentId,
    workspaceProjects: partition.workspaceProjects,
    capabilities,
    queuedThreadKeys,
    pendingOrder,
    threadMovePlanners,
    shelf,
    sectionPreferences,
    showMoreSettled,
    setAssistantSettledCount,
  };
}

export type HomeSectionsModel = ReturnType<typeof useHomeSections>;
