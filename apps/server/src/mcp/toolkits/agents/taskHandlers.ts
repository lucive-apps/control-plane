/**
 * The `cp_task_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * Callers: a Project's coordinator, or the Assistant (its "Today" thread and
 * pinned channels). A coordinator lists its Project's tasks, proposes new
 * ones and edits only its own proposals. The Assistant follows the user's
 * Assistant settings: `tasks` (off / read / edit) gates listing and editing,
 * and `newTasks` ("create" with edit access) adds new tasks directly instead
 * of proposing them. Only the user adds or dismisses a proposal. The decider
 * checks the caller's role again; settings are checked only here.
 *
 * @module taskHandlers
 */
import {
  addTaskDays,
  agentManagerRole,
  CommandId,
  isAssistantChannel,
  isProposedTask,
  isTaskLocalDate,
  localTaskDate,
  taskPeriodFor,
  TaskId,
  type AssistantSettings,
  type OrchestrationCommand,
  type Task,
  type TaskAgentPatch,
  type TaskHome,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Toolkit from "effect/unstable/ai/Toolkit";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type AgentsToolkit,
  AgentToolFailedError,
  TaskAccessDeniedError,
  type TaskProposeInput,
  type TaskUpdateInput,
  type TaskWhen,
} from "./tools.ts";

type TaskHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  "cp_task_list" | "cp_task_propose" | "cp_task_update"
>;

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read the user's tasks.", cause });

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

const writeFailed =
  (fallback: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
    const error = Cause.findErrorOption(cause);
    const detail =
      Option.isSome(error) && isInvariantError(error.value) ? error.value.detail : fallback;
    return Effect.fail(new AgentToolFailedError({ detail, cause }));
  };

const NOT_A_TASK_CALLER =
  "Only a Project's coordinator or the Assistant can use the task tools. Ask your coordinator.";
const ASSISTANT_TASKS_OFF =
  "The user turned off the Assistant's access to tasks (Assistant settings, Tasks: Off).";
const ASSISTANT_TASKS_READ_ONLY =
  "The user's Assistant settings allow reading tasks but not editing them (Tasks: Read only). Tell the user what to change instead.";

/** The tool's `when` as a task home, counted from the server's local today. */
export function taskHomeOf(when: TaskWhen | undefined, today: string): TaskHome {
  const period = (horizon: "week" | "month" | "year", next: boolean): TaskHome => {
    const current = taskPeriodFor(horizon, today);
    const anchor = next ? addTaskDays(current.endsOn, 1) : today;
    return { kind: "period", horizon, ...taskPeriodFor(horizon, anchor) };
  };
  switch (when) {
    case "today":
      return { kind: "date", date: today };
    case "tomorrow":
      return { kind: "date", date: addTaskDays(today, 1) };
    case "next-week":
      return period("week", true);
    case "this-month":
      return period("month", false);
    case "next-month":
      return period("month", true);
    case "this-year":
      return period("year", false);
    case "next-year":
      return period("year", true);
    case "backlog":
      return { kind: "backlog", horizon: null };
    case "week-backlog":
      return { kind: "backlog", horizon: "week" };
    case "month-backlog":
      return { kind: "backlog", horizon: "month" };
    case "year-backlog":
      return { kind: "backlog", horizon: "year" };
    case "this-week":
    case undefined:
      return period("week", false);
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface HomeFields {
  readonly when?: TaskWhen | undefined;
  readonly date?: string | undefined;
  readonly period?: "week" | "month" | "year" | undefined;
}

/**
 * The home the tool's fields name, null when they name none, or why they are
 * refused. `when` counts from `today`.
 */
export function resolveTaskHome(fields: HomeFields, today: string): TaskHome | null | string {
  if (fields.when !== undefined && fields.date !== undefined) {
    return "Give either `when` or `date`, not both.";
  }
  if (fields.period !== undefined && fields.date === undefined) {
    return "`period` needs a `date` inside that period. For the current or next one, use `when` (this-week, next-month, ...).";
  }
  if (fields.date !== undefined) {
    if (!isTaskLocalDate(fields.date)) {
      return `'${fields.date}' is not a real date. Use YYYY-MM-DD, such as 2026-11-16.`;
    }
    if (fields.period !== undefined) {
      return {
        kind: "period",
        horizon: fields.period,
        ...taskPeriodFor(fields.period, fields.date),
      };
    }
    return { kind: "date", date: fields.date };
  }
  if (fields.when !== undefined) return taskHomeOf(fields.when, today);
  return null;
}

/** `home` with the reminder applied: a time sets it, null clears it, undefined keeps it. */
export function withReminder(
  home: TaskHome,
  reminderTime: string | null | undefined,
): TaskHome | string {
  if (reminderTime === undefined) return home;
  if (reminderTime !== null && !TIME_PATTERN.test(reminderTime)) {
    return `'${reminderTime}' is not a time. Use 24h HH:MM, such as 09:30.`;
  }
  if (home.kind !== "date") {
    if (reminderTime === null) return home;
    return "A reminder needs a single day: pass `date` alone, or when: today or tomorrow.";
  }
  const { reminderTime: _previous, ...day } = home;
  return reminderTime === null ? day : { ...day, reminderTime };
}

export const makeTaskHandlers = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  /** The caller as a coordinator or the Assistant, with the Assistant's settings. */
  const requireCaller = Effect.fn("TaskTools.requireCaller")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) {
      return yield* new TaskAccessDeniedError({ detail: NOT_A_TASK_CALLER });
    }
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(project)) {
      return yield* new TaskAccessDeniedError({ detail: NOT_A_TASK_CALLER });
    }
    const assistant = isAssistantChannel(project.value, caller.value);
    if (!assistant && agentManagerRole(project.value, caller.value) !== "coordinator") {
      return yield* new TaskAccessDeniedError({ detail: NOT_A_TASK_CALLER });
    }
    const settings: AssistantSettings | null = assistant
      ? (yield* settingsService.getSettings.pipe(Effect.mapError(readFailed))).assistant
      : null;
    if (settings?.tasks === "off") {
      return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_OFF });
    }
    return { callerId: caller.value.id, projectId: project.value.id, settings };
  });

  const allTasks = snapshots.getCommandReadModel().pipe(
    Effect.mapError(readFailed),
    Effect.map((model): ReadonlyArray<Task> => model.tasks ?? []),
  );

  /** Open tasks the caller sees: every one for the Assistant, else its Project's. */
  const visibleTasks = (projectId: string, assistant: boolean) =>
    allTasks.pipe(
      Effect.map((tasks): Task[] =>
        tasks.filter(
          (task) =>
            task.status === "todo" &&
            (assistant ||
              task.links?.projectId === projectId ||
              task.proposal?.projectId === projectId),
        ),
      ),
    );

  const findTask = (taskId: string) =>
    allTasks.pipe(Effect.map((tasks) => tasks.find((entry) => entry.id === taskId)));

  const nowParts = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      iso: DateTime.formatIso(now),
      today: localTaskDate(DateTime.toEpochMillis(now)),
    };
  });

  const dispatch = (command: OrchestrationCommand, fallback: string) =>
    engine.dispatch(command).pipe(Effect.catchCause(writeFailed(fallback)));

  return {
    cp_task_list: () =>
      Effect.gen(function* () {
        const { projectId, settings } = yield* requireCaller();
        return { tasks: yield* visibleTasks(projectId, settings !== null) };
      }),

    cp_task_propose: (input: TaskProposeInput) =>
      Effect.gen(function* () {
        const { callerId, projectId, settings } = yield* requireCaller();
        const { iso, today } = yield* nowParts;
        const resolved = resolveTaskHome(input, today);
        if (typeof resolved === "string") {
          return yield* new AgentToolFailedError({ detail: resolved });
        }
        const home = withReminder(resolved ?? taskHomeOf(undefined, today), input.reminderTime);
        if (typeof home === "string") return yield* new AgentToolFailedError({ detail: home });
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const taskId = TaskId.make(uuid);
        const notes = input.notes !== undefined ? { notes: input.notes } : {};
        // The Assistant adds directly only when it may also edit tasks.
        const direct = settings?.newTasks === "create" && settings.tasks === "edit";
        if (direct) {
          yield* dispatch(
            {
              type: "task.agent.create",
              commandId: CommandId.make(`mcp-task:${uuid}`),
              taskId,
              actorThreadId: callerId,
              title: input.title,
              ...notes,
              home,
              createdAt: iso,
            },
            "Could not add the task.",
          );
        } else {
          yield* dispatch(
            {
              type: "task.propose",
              commandId: CommandId.make(`mcp-task:${uuid}`),
              taskId,
              projectId,
              actorThreadId: callerId,
              title: input.title,
              ...notes,
              home,
              ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
              createdAt: iso,
            },
            "Could not propose the task.",
          );
        }
        const task = yield* findTask(taskId);
        if (task === undefined) {
          return yield* new AgentToolFailedError({ detail: "The task was not saved." });
        }
        const tasks = yield* allTasks;
        return {
          task,
          added: direct,
          proposed: tasks.filter(
            (entry) => isProposedTask(entry) && entry.proposal?.projectId === projectId,
          ).length,
        };
      }),

    cp_task_update: (input: TaskUpdateInput) =>
      Effect.gen(function* () {
        const { callerId, settings } = yield* requireCaller();
        if (settings !== null && settings.tasks !== "edit") {
          return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_READ_ONLY });
        }
        const stored = yield* findTask(input.taskId);
        if (stored === undefined) {
          return yield* new AgentToolFailedError({ detail: "That task no longer exists." });
        }
        const { iso, today } = yield* nowParts;
        const resolved = resolveTaskHome(input, today);
        if (typeof resolved === "string") {
          return yield* new AgentToolFailedError({ detail: resolved });
        }
        // A move to another day keeps the task's reminder unless told otherwise.
        const keptReminder =
          resolved?.kind === "date" &&
          input.reminderTime === undefined &&
          stored.home.kind === "date" &&
          stored.home.reminderTime !== undefined
            ? stored.home.reminderTime
            : undefined;
        let home: TaskHome | string | undefined = resolved ?? undefined;
        if (input.reminderTime !== undefined || keptReminder !== undefined) {
          home = withReminder(
            resolved ?? stored.home,
            input.reminderTime !== undefined ? input.reminderTime : keptReminder,
          );
        }
        if (typeof home === "string") return yield* new AgentToolFailedError({ detail: home });
        const patch: TaskAgentPatch = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(home !== undefined ? { home } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        };
        if (Object.keys(patch).length === 0) {
          return yield* new AgentToolFailedError({ detail: "Nothing to change." });
        }
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* dispatch(
          {
            type: "task.agent.update",
            commandId: CommandId.make(`mcp-task:${uuid}`),
            taskId: stored.id,
            actorThreadId: callerId,
            patch,
            createdAt: iso,
          },
          "Could not edit the task.",
        );
        const task = yield* findTask(stored.id);
        if (task === undefined) {
          return yield* new AgentToolFailedError({ detail: "The task was not saved." });
        }
        return { task };
      }),
  } satisfies TaskHandlers;
});
