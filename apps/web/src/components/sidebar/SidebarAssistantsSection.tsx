import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  countRunningAgents,
  sectionAssistantAgents,
  type AssistantAgentSections,
  type AssistantEntry,
} from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasScheduleAttention } from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef, ServerConfig } from "@t3tools/contracts";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  resolveSectionExpanded,
  SIDEBAR_ASSISTANTS_SECTION_KEY,
  useUiStateStore,
} from "../../uiStateStore";
import { AssistantStatusDot } from "../assistants/AssistantStatusDot";
import { useAssistantProjectMenu } from "../assistants/useAssistantActions";
import { ProjectFavicon } from "../ProjectFavicon";
import type { SidebarSection } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  assistantExpansionKey,
  assistantSettledToggle,
  isAssistantExpanded,
  rollupAssistantsStatus,
  rollupThreadGroupStatus,
  visibleAssistantAgentRows,
  type SidebarRollupStatus,
} from "./sidebarAssistants.logic";

// Fork-owned. The sidebar's Projects section: one row per Project, which is
// its coordinator, with the agents nested under it.

export interface SidebarAssistantModel {
  readonly entry: AssistantEntry<EnvironmentProject, EnvironmentThreadShell>;
  /** `assistantExpansionKey` of the Project. */
  readonly key: string;
  readonly coordinator: EnvironmentThreadShell | null;
  /** Scoped key of the coordinator thread, known even before its shell arrives. */
  readonly coordinatorKey: string;
  readonly agentKeys: ReadonlySet<string>;
  readonly sections: AssistantAgentSections<EnvironmentThreadShell>;
  /** A missed or failed schedule, which reads as failed on the dot. */
  readonly scheduleAttention: boolean;
}

// Without Projects the section's state keeps one identity, so the sidebar's
// memos that read it do not rerun on every clock tick.
const EMPTY_MODELS: readonly SidebarAssistantModel[] = [];

/**
 * The dot of a collapsed group of threads. Selects a primitive so visits to
 * other threads do not re-render the caller, and does no work while the group
 * is expanded.
 */
export function useThreadGroupRollup(
  threads: readonly EnvironmentThreadShell[],
  enabled: boolean,
): SidebarRollupStatus {
  return useUiStateStore((state) =>
    enabled ? rollupThreadGroupStatus(threads, state.threadLastVisitedAtById) : null,
  );
}

/**
 * The Projects section's state: one model per Project with its agents
 * sectioned like threads (snoozed, settled, standing, active), plus the
 * section and per-Project expansion that jump order and rendering share.
 */
export function useSidebarAssistants(input: {
  readonly entries: readonly AssistantEntry<EnvironmentProject, EnvironmentThreadShell>[];
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly environments: readonly Pick<EnvironmentPresentation, "connection" | "serverConfig">[];
  /** A Workspace filter shows one folder, so it hides the Projects section. */
  readonly workspaceFilterActive: boolean;
  /** The sidebar's snooze clocks: sections are recomputed when either ticks. */
  readonly nowMinute: string;
  readonly snoozeWakeTick: number;
}) {
  const { entries, serverConfigs, nowMinute, snoozeWakeTick } = input;
  const models = useMemo((): readonly SidebarAssistantModel[] => {
    void nowMinute;
    void snoozeWakeTick;
    if (entries.length === 0) return EMPTY_MODELS;
    // Snooze wakes are second-precise, like the Tasks classification.
    const now = new Date().toISOString();
    return entries.flatMap((entry) => {
      const { project } = entry;
      const coordinatorThreadId = project.assistant?.coordinatorThreadId;
      if (coordinatorThreadId === undefined) return [];
      const capabilities = serverConfigs.get(project.environmentId)?.environment.capabilities;
      return [
        {
          entry,
          key: assistantExpansionKey(project.environmentId, project.id),
          coordinator: entry.coordinator,
          coordinatorKey: scopedThreadKey(
            scopeThreadRef(project.environmentId, coordinatorThreadId),
          ),
          agentKeys: new Set(
            entry.agents.map((agent) =>
              scopedThreadKey(scopeThreadRef(agent.environmentId, agent.id)),
            ),
          ),
          sections: sectionAssistantAgents(entry.agents, {
            now,
            supportsSnooze: capabilities?.threadSnooze === true,
            supportsSettlement: capabilities?.threadSettlement === true,
          }),
          scheduleAttention: hasScheduleAttention(project.assistant),
        },
      ];
    });
  }, [entries, nowMinute, serverConfigs, snoozeWakeTick]);
  const coordinatorKeys = useMemo(
    () => new Set(models.map((model) => model.coordinatorKey)),
    [models],
  );
  const canCreate = input.environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.assistants === true,
  );
  // Projects already in the shell stay listed while their environment reconnects.
  const visible = !input.workspaceFilterActive && (canCreate || models.length > 0);
  const sectionExpanded = useUiStateStore((state) =>
    resolveSectionExpanded(state.projectExpandedById, [SIDEBAR_ASSISTANTS_SECTION_KEY]),
  );
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const toggleSection = useCallback(
    () => setProjectExpanded(SIDEBAR_ASSISTANTS_SECTION_KEY, !sectionExpanded),
    [sectionExpanded, setProjectExpanded],
  );
  // One joined string, so toggling a Tasks folder does not re-render the sidebar.
  const expandedKeyList = useUiStateStore((state) =>
    models
      .filter((model) => isAssistantExpanded(state.projectExpandedById, model.key))
      .map((model) => model.key)
      .join("\0"),
  );
  const expandedKeys = useMemo(
    () => new Set(expandedKeyList.length === 0 ? [] : expandedKeyList.split("\0")),
    [expandedKeyList],
  );
  // Settled paging is per session, like the Tasks settled tail.
  const [settledCounts, setSettledCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const setSettledCount = useCallback((key: string, count: number) => {
    setSettledCounts((current) => {
      const next = new Map(current);
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  }, []);
  const rollupStatus = useAssistantSectionRollup(models, visible && !sectionExpanded);
  return {
    models,
    coordinatorKeys,
    canCreate,
    visible,
    sectionExpanded,
    toggleSection,
    expandedKeys,
    settledCounts,
    setSettledCount,
    rollupStatus,
  };
}

/**
 * The dot of the collapsed Projects section. Selects a primitive, like
 * `useThreadGroupRollup`, so visits elsewhere do not re-render the sidebar.
 */
function useAssistantSectionRollup(
  models: readonly SidebarAssistantModel[],
  enabled: boolean,
): SidebarRollupStatus {
  return useUiStateStore((state) =>
    enabled ? rollupAssistantsStatus(models, state.threadLastVisitedAtById) : null,
  );
}

/**
 * The Projects section with no Projects: one quiet "Add project" row that opens
 * the New Project dialog. Renders nothing where Projects can't be created.
 */
export function SidebarAssistantsEmptyRow(props: { readonly onNewProject: (() => void) | null }) {
  if (props.onNewProject === null) return null;
  return (
    <li className="list-none" data-testid="sidebar-assistants-empty">
      <button
        type="button"
        onClick={props.onNewProject}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Add project</span>
      </button>
    </li>
  );
}

export function SidebarAssistantsSection(props: {
  readonly models: readonly SidebarAssistantModel[];
  readonly snapshotByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  /** From `useSidebarAssistants`, so rows and jump order agree. */
  readonly expandedKeys: ReadonlySet<string>;
  readonly settledCounts: ReadonlyMap<string, number>;
  readonly onSettledCountChange: (key: string, count: number) => void;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly routeThreadKey: string | null;
  readonly routeDraft: {
    readonly environmentId: string;
    readonly projectId: string;
  } | null;
  readonly onOpenCoordinator: (project: EnvironmentProject) => void;
  readonly onNewAgent: (project: EnvironmentProject) => void;
  /** `useAssistantActions().rename`, shared with the sidebar's instance. */
  readonly onRenameProject: (projectRef: ScopedProjectRef, title: string) => unknown;
  readonly renderJumpHint: (coordinatorKey: string) => ReactNode;
  readonly renderDrafts: (snapshot: SidebarProjectSnapshot) => ReactNode;
  readonly renderThreadRow: (thread: EnvironmentThreadShell, section: SidebarSection) => ReactNode;
}) {
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const openProjectMenu = useAssistantProjectMenu();
  const [renamingKey, setRenamingKey] = useState<string | null>(null);

  const { onRenameProject } = props;
  const handleRename = useCallback(
    (project: EnvironmentProject, title: string) => {
      setRenamingKey(null);
      void onRenameProject(scopeProjectRef(project.environmentId, project.id), title);
    },
    [onRenameProject],
  );
  const handleContextMenu = useCallback(
    (model: SidebarAssistantModel, position: { x: number; y: number }) => {
      void openProjectMenu({
        project: model.entry.project,
        position,
        onRename: () => setRenamingKey(model.key),
      });
    },
    [openProjectMenu],
  );

  return (
    <>
      {props.models.map((model) => {
        const { project } = model.entry;
        const routeDraft = props.routeDraft;
        return (
          <SidebarAssistantRow
            key={model.key}
            model={model}
            snapshot={props.snapshotByKey.get(model.entry.projectKey) ?? null}
            expanded={props.expandedKeys.has(model.key)}
            settledCount={props.settledCounts.get(model.key) ?? 0}
            environmentLabel={
              project.environmentId === props.primaryEnvironmentId
                ? null
                : (props.snapshotByKey.get(model.entry.projectKey)?.memberProjects[0]
                    ?.environmentLabel ?? null)
            }
            isActive={props.routeThreadKey === model.coordinatorKey}
            containsRoute={
              (props.routeThreadKey !== null && model.agentKeys.has(props.routeThreadKey)) ||
              (routeDraft !== null &&
                routeDraft.environmentId === project.environmentId &&
                routeDraft.projectId === project.id)
            }
            routeThreadKey={props.routeThreadKey}
            isRenaming={renamingKey === model.key}
            jumpHint={props.renderJumpHint(model.coordinatorKey)}
            onOpen={props.onOpenCoordinator}
            onNewAgent={props.onNewAgent}
            onContextMenu={handleContextMenu}
            onSetExpanded={setProjectExpanded}
            onSettledCountChange={props.onSettledCountChange}
            onRename={handleRename}
            onCancelRename={() => setRenamingKey(null)}
            renderDrafts={props.renderDrafts}
            renderThreadRow={props.renderThreadRow}
          />
        );
      })}
    </>
  );
}

function SidebarAssistantRow(props: {
  readonly model: SidebarAssistantModel;
  readonly snapshot: SidebarProjectSnapshot | null;
  readonly expanded: boolean;
  readonly settledCount: number;
  readonly environmentLabel: string | null;
  readonly isActive: boolean;
  readonly containsRoute: boolean;
  readonly routeThreadKey: string | null;
  readonly isRenaming: boolean;
  readonly jumpHint: ReactNode;
  readonly onOpen: (project: EnvironmentProject) => void;
  readonly onNewAgent: (project: EnvironmentProject) => void;
  readonly onContextMenu: (
    model: SidebarAssistantModel,
    position: { x: number; y: number },
  ) => void;
  readonly onSetExpanded: (key: string, expanded: boolean) => void;
  readonly onSettledCountChange: (key: string, count: number) => void;
  readonly onRename: (project: EnvironmentProject, title: string) => void;
  readonly onCancelRename: () => void;
  readonly renderDrafts: (snapshot: SidebarProjectSnapshot) => ReactNode;
  readonly renderThreadRow: (thread: EnvironmentThreadShell, section: SidebarSection) => ReactNode;
}) {
  const { model, expanded, onSetExpanded } = props;
  const { project } = model.entry;
  const status = useUiStateStore((state) =>
    rollupAssistantsStatus([model], state.threadLastVisitedAtById),
  );
  const running = useMemo(() => countRunningAgents(model.entry.agents), [model.entry.agents]);

  // Opening an agent (or a draft in the Project) reveals it, like a Tasks
  // folder does; opening the coordinator leaves the agents as they are.
  const containedRouteRef = useRef(false);
  useEffect(() => {
    if (props.containsRoute && !containedRouteRef.current && !expanded) {
      onSetExpanded(model.key, true);
    }
    containedRouteRef.current = props.containsRoute;
  }, [expanded, model.key, onSetExpanded, props.containsRoute]);

  const handleClick = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    props.onOpen(project);
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onOpen(project);
  };

  const { rows, hiddenSettledCount } = expanded
    ? visibleAssistantAgentRows(model.sections, {
        settledCount: props.settledCount,
        routeThreadKey: props.routeThreadKey,
      })
    : { rows: [], hiddenSettledCount: 0 };
  const settledToggle = expanded
    ? assistantSettledToggle({
        settledCount: props.settledCount,
        settledTotal: model.sections.settled.length,
        hiddenSettledCount,
      })
    : null;

  return (
    <li className="list-none" data-testid="sidebar-assistant">
      <div
        role="button"
        tabIndex={0}
        aria-current={props.isActive ? "page" : undefined}
        aria-label={`Open ${project.title}`}
        className={cn(
          "group/assistant relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[length:1em] leading-tight text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(model, { x: event.clientX, y: event.clientY });
        }}
      >
        <ProjectFavicon project={project} className="size-4 shrink-0" />
        {props.isRenaming ? (
          <AssistantRenameInput
            title={project.title}
            onCommit={(title) => props.onRename(project, title)}
            onCancel={props.onCancelRename}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{project.title}</span>
        )}
        {props.environmentLabel ? (
          <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground/70">
            {props.environmentLabel}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="sidebar-assistant-new-agent"
                aria-label={`New agent in ${project.title}`}
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none pointer-events-none transition-opacity hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/assistant:pointer-events-auto group-hover/assistant:opacity-100"
                onClick={() => props.onNewAgent(project)}
              />
            }
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">New agent in {project.title}</TooltipPopup>
        </Tooltip>
        {running > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {running} running
          </span>
        ) : null}
        <AssistantStatusDot status={status} />
        <button
          type="button"
          data-testid="sidebar-assistant-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} agents in ${project.title}`}
          className="-mr-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--sidebar-icon-color)] outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onSetExpanded(model.key, !expanded)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")}
          />
        </button>
        {props.jumpHint}
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-px pl-4">
          {props.snapshot !== null ? props.renderDrafts(props.snapshot) : null}
          {rows.map((row) => props.renderThreadRow(row.thread, row.section))}
          {settledToggle !== null ? (
            <li className="list-none">
              <button
                type="button"
                data-testid="sidebar-assistant-settled-toggle"
                className="flex h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-xs text-sidebar-muted-foreground/75 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  props.onSettledCountChange(model.key, settledToggle.nextSettledCount)
                }
              >
                {settledToggle.label}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function AssistantRenameInput(props: {
  readonly title: string;
  readonly onCommit: (title: string) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(props.title);
  const settledRef = useRef(false);
  return (
    <input
      autoFocus
      value={value}
      aria-label="Project name"
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          settledRef.current = true;
          props.onCommit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          settledRef.current = true;
          props.onCancel();
        }
      }}
      onBlur={() => {
        if (!settledRef.current) props.onCommit(value);
      }}
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-[length:1em] font-medium leading-tight text-card-foreground outline-none focus:border-foreground"
    />
  );
}
