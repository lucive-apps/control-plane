import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatTimeUntil,
  resolveScheduleRowState,
  scheduleAuthorLabel,
  scheduleTargetOptions,
  type ScheduleRowState,
} from "@t3tools/client-runtime/state/schedules";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  PROJECT_SCHEDULE_LIMIT,
  type ProjectSchedule,
  type ProjectScheduler,
  type ProjectScheduleRun,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { describeCadence, nextScheduleRuns } from "@t3tools/shared/schedules";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useRightPanelStore } from "../../rightPanelStore";
import { useServerConfigs, useThreadShellsForProjectRefs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { ScheduleHostLine, useHostOpenAtLogin } from "./ScheduleHostLine";
import { useScheduleActions } from "./useScheduleActions";

const HOW_TO_FIX_URL =
  "https://github.com/lucive-apps/control-plane/blob/main/docs/user/projects.md#schedules";
const MINUTE_MS = 60_000;

/** Own keys only: a schedule id such as "constructor" must not read Object.prototype. */
function entryOf<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * The Schedules right-panel surface. Closes itself when the thread's Project
 * is gone (Move to Tasks) or its server does not store schedules.
 */
export function SchedulesPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly project: EnvironmentProject | null;
}) {
  const { threadRef, project } = props;
  const serverConfig = useServerConfigs().get(threadRef.environmentId) ?? null;
  const capability = serverConfig?.environment.capabilities.projectSchedules;
  const available = project?.assistant != null && capability !== undefined;
  const settled = project !== null && serverConfig !== null;
  useEffect(() => {
    if (settled && !available) useRightPanelStore.getState().closeSurface(threadRef, "schedules");
  }, [available, settled, threadRef]);
  if (!available || project === null || capability === undefined) return null;
  return (
    <SchedulesPanelContent
      key={`${project.environmentId}:${project.id}`}
      project={project}
      scheduler={capability.scheduler}
      capabilityZone={capability.timeZone}
    />
  );
}

type Editing = { readonly schedule: ProjectSchedule | null };

function SchedulesPanelContent(props: {
  readonly project: EnvironmentProject;
  readonly scheduler: ProjectScheduler;
  readonly capabilityZone: string;
}) {
  const { project } = props;
  const assistant = project.assistant!;
  const navigate = useNavigate();
  const actions = useScheduleActions();
  const projectRef = useMemo(
    () => scopeProjectRef(project.environmentId, project.id),
    [project.environmentId, project.id],
  );
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const statusQuery = useEnvironmentQuery(
    projectEnvironment.schedulesStatus({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const status = statusQuery.data;
  const refreshStatus = statusQuery.refresh;
  const [now, setNow] = useState(() => new Date());
  const [editing, setEditing] = useState<Editing | null>(null);
  // Schedules with a write in flight: their switch waits, so a second click
  // cannot resend the same change against a list the first one already moved.
  const [writing, setWriting] = useState<ReadonlySet<string>>(() => new Set());
  const openAtLogin = useHostOpenAtLogin(project.environmentId);

  // A minute tick re-renders next runs.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => window.clearInterval(interval);
  }, []);
  // Status reads fresh on open and once a minute, so held rows update. Not while
  // the editor is open: it read status as it opened, and a refresh would
  // disable its prompt field mid-edit.
  const editorOpen = editing !== null;
  useEffect(() => {
    if (editorOpen) return;
    refreshStatus();
    const interval = window.setInterval(refreshStatus, MINUTE_MS);
    return () => window.clearInterval(interval);
  }, [editorOpen, refreshStatus]);

  const timeZone = status?.host.timeZone ?? props.capabilityZone;
  const scheduler = status?.host.scheduler ?? props.scheduler;
  const schedules = assistant.schedules ?? [];
  const threadById = useMemo(
    () => new Map<ThreadId, EnvironmentThreadShell>(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const coordinator = threadById.get(assistant.coordinatorThreadId) ?? null;
  const titleOf = useCallback(
    (threadId: ThreadId) => threadById.get(threadId)?.title ?? null,
    [threadById],
  );
  const openThread = useCallback(
    (threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
      }),
    [navigate, project.environmentId],
  );
  const openEditor = (schedule: ProjectSchedule | null) => {
    // The editor reads the prompt from status, so read it fresh.
    refreshStatus();
    setEditing({ schedule });
  };

  const setEnabled = async (id: string, enabled: boolean) => {
    setWriting((current) => new Set(current).add(id));
    await actions.setEnabled(projectRef, id, enabled);
    setWriting((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const unsupported = scheduler === "none";
  const problems = status?.host.problems ?? [];
  // A closed app on a Mac is fixed by Open at login, unless it is already on.
  const suggestOpenAtLogin =
    scheduler === "launchd" && !(openAtLogin.onThisHost && openAtLogin.state?.enabled === true);
  // The editor saves against the version it opened; say so when the stored one moved on.
  const opened = editing?.schedule ?? null;
  const stored = opened === null ? undefined : schedules.find(({ id }) => id === opened.id);
  const editingChanged =
    opened === null
      ? null
      : stored === undefined
        ? "deleted"
        : stored.updatedAt !== opened.updatedAt
          ? "edited"
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex items-center gap-2 border-border/70 border-b px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate font-medium">Schedules</h2>
        {!unsupported && schedules.length > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={schedules.length >= PROJECT_SCHEDULE_LIMIT}
            onClick={() => openEditor(null)}
          >
            <PlusIcon />
            New schedule
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {unsupported ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4 text-muted-foreground">
            <p>
              {problems.includes("unsupported-platform")
                ? "Schedules aren't available on Windows yet."
                : "This host doesn't run schedules. They run from the Control Plane desktop app."}
            </p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void readLocalApi()?.shell.openExternal(HOW_TO_FIX_URL)}
            >
              How to fix
            </Button>
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4 text-muted-foreground">
            <p>No schedules yet.</p>
            <Button type="button" size="xs" variant="outline" onClick={() => openEditor(null)}>
              <PlusIcon />
              New schedule
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col py-1">
            {schedules.map((schedule) => {
              const targetThread =
                schedule.target === "coordinator"
                  ? coordinator
                  : (threads.find(
                      (thread) => thread.id === schedule.target && thread.archivedAt === null,
                    ) ?? null);
              const targetTitle =
                schedule.target === "coordinator"
                  ? (coordinator?.title ?? project.title)
                  : (targetThread?.title ?? "its agent");
              return (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  targetLabel={
                    schedule.target === "coordinator"
                      ? "Coordinator"
                      : (targetThread?.title ?? "Missing agent")
                  }
                  state={resolveScheduleRowState({
                    schedule,
                    run: entryOf<ProjectScheduleRun>(assistant.scheduleRuns, schedule.id),
                    held: entryOf(status?.held, schedule.id),
                    targetTitle,
                    targetThread,
                    now,
                    timeZone,
                  })}
                  nextRun={
                    schedule.enabled
                      ? (nextScheduleRuns(schedule.cron, timeZone, now, 1)[0] ?? null)
                      : null
                  }
                  now={now}
                  writing={writing.has(schedule.id)}
                  suggestOpenAtLogin={suggestOpenAtLogin}
                  author={scheduleAuthorLabel(schedule, titleOf)}
                  onOpenThread={openThread}
                  onRunNow={async () => {
                    await actions.runNow(projectRef, schedule.id, targetTitle);
                    refreshStatus();
                  }}
                  onEdit={() => openEditor(schedule)}
                  onSetEnabled={(enabled) => void setEnabled(schedule.id, enabled)}
                  onDelete={() => void actions.remove(projectRef, schedule)}
                />
              );
            })}
          </ul>
        )}
      </ScrollArea>
      <div className="flex flex-col gap-1.5 border-border/70 border-t px-3 py-2 text-muted-foreground text-xs">
        {!unsupported ? (
          <ScheduleHostLine
            environmentId={project.environmentId}
            scheduler={scheduler}
            host={status?.host ?? null}
            openAtLogin={openAtLogin}
          />
        ) : null}
        <p>Times are in {timeZone} (host).</p>
      </div>
      {editing !== null ? (
        <ScheduleEditorDialog
          schedule={editing.schedule}
          prompt={
            editing.schedule === null ? undefined : entryOf(status?.prompts, editing.schedule.id)
          }
          promptPending={statusQuery.isPending}
          promptFailed={statusQuery.error !== null}
          changed={editingChanged}
          targetOptions={scheduleTargetOptions({
            coordinatorThreadId: assistant.coordinatorThreadId,
            threads,
            current: editing.schedule?.target ?? null,
          })}
          timeZone={timeZone}
          onSave={(draft) => actions.save(projectRef, draft)}
          onDelete={(schedule) => actions.remove(projectRef, schedule)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function ScheduleRow(props: {
  readonly schedule: ProjectSchedule;
  readonly targetLabel: string;
  readonly state: ScheduleRowState;
  readonly nextRun: Date | null;
  readonly now: Date;
  readonly writing: boolean;
  readonly suggestOpenAtLogin: boolean;
  readonly author: string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onRunNow: () => Promise<void>;
  readonly onEdit: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onDelete: () => void;
}) {
  const { schedule, state } = props;
  const [running, setRunning] = useState(false);
  const runNow = async () => {
    setRunning(true);
    await props.onRunNow();
    setRunning(false);
  };
  const cadence = [
    describeCadence(schedule.cron),
    props.targetLabel,
    schedule.enabled
      ? props.nextRun
        ? formatTimeUntil(props.nextRun, props.now)
        : null
      : "Paused",
  ].filter((part): part is string => part !== null);
  const linkThreadId = state.linkThreadId;
  return (
    <li className="group/schedule relative flex items-start gap-2 px-3 py-2 hover:bg-accent/30">
      <div
        className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !schedule.enabled && "opacity-60")}
      >
        <p className="truncate font-medium">{schedule.name}</p>
        <p className="truncate text-muted-foreground text-xs">{cadence.join(" · ")}</p>
        <p
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs",
            state.attention ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {state.kind === "running" ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sky-500" />
          ) : null}
          {linkThreadId !== null || state.kind === "pick-target" ? (
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate text-start underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
              onClick={() =>
                linkThreadId !== null ? props.onOpenThread(linkThreadId) : props.onEdit()
              }
            >
              {state.text}
            </button>
          ) : (
            <span className="min-w-0 truncate">{state.text}</span>
          )}
        </p>
        {state.suggestOpenAtLogin && state.attention && props.suggestOpenAtLogin ? (
          <p className="text-muted-foreground text-xs">
            Turn on Open at login to keep schedules running.
          </p>
        ) : null}
        {props.author ? (
          <p className="truncate text-muted-foreground text-xs">{props.author}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Run ${schedule.name} now`}
                disabled={running}
                className="opacity-0 focus-visible:opacity-100 group-hover/schedule:opacity-100 pointer-coarse:opacity-100"
                onClick={() => void runNow()}
              />
            }
          >
            <PlayIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Run now</TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`More actions for ${schedule.name}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-40">
            <MenuItem onClick={() => void runNow()}>Run now</MenuItem>
            <MenuItem onClick={props.onEdit}>Edit</MenuItem>
            <MenuItem
              disabled={props.writing}
              onClick={() => props.onSetEnabled(!schedule.enabled)}
            >
              {schedule.enabled ? "Pause" : "Resume"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onDelete}>
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Switch
          size="sm"
          checked={schedule.enabled}
          disabled={props.writing}
          onCheckedChange={(checked) => props.onSetEnabled(checked)}
          aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
        />
      </div>
    </li>
  );
}
