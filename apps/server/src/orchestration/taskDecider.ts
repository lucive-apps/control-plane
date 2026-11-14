/**
 * Task invariants for the decider. Fork-owned and pure, so each decider.ts
 * hunk stays a single call.
 *
 * Every write emits the whole record (`task.updated`), like Status. Client
 * commands create, edit and accept tasks. A coordinator proposes through
 * `cp_task_propose` and edits only its own Project's proposals through
 * `cp_task_update`; the Assistant may also add tasks directly and edit any
 * task (its settings are checked by the tool, which this pure decider cannot
 * read). Only the user adds or dismisses a proposal.
 */
import {
  TASK_INTENT_MAX,
  TASK_NOTES_MAX,
  TASK_PROPOSALS_PER_PROJECT_MAX,
  TASK_TITLE_MAX,
  TaskId,
  agentManagerRole,
  isAssistantChannel,
  isTaskLocalDate,
  isProposedTask,
  nextTaskOccurrence,
  taskIntentKey,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectId,
  type Task,
  type TaskHome,
  type TaskIntent,
  type TaskLinks,
  type TaskPatch,
  type TaskRecurrence,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase, type PlannedOrchestrationEvent } from "./eventBase.ts";

type TaskCreateCommand = Extract<OrchestrationCommand, { type: "task.create" }>;
type TaskUpdateCommand = Extract<OrchestrationCommand, { type: "task.update" }>;
type TaskDeleteCommand = Extract<OrchestrationCommand, { type: "task.delete" }>;
type TaskProposalRespondCommand = Extract<OrchestrationCommand, { type: "task.proposal.respond" }>;
type TaskHandoffCommand = Extract<OrchestrationCommand, { type: "task.handoff" }>;
type TaskIntentSetCommand = Extract<OrchestrationCommand, { type: "task.intent.set" }>;
type TaskProposeCommand = Extract<OrchestrationCommand, { type: "task.propose" }>;
type TaskSyncApplyCommand = Extract<OrchestrationCommand, { type: "task.sync.apply" }>;
type TaskAgentCreateCommand = Extract<OrchestrationCommand, { type: "task.agent.create" }>;
type TaskAgentUpdateCommand = Extract<OrchestrationCommand, { type: "task.agent.update" }>;
type TaskCommand =
  | TaskCreateCommand
  | TaskUpdateCommand
  | TaskDeleteCommand
  | TaskProposalRespondCommand
  | TaskHandoffCommand
  | TaskProposeCommand
  | TaskSyncApplyCommand
  | TaskAgentCreateCommand
  | TaskAgentUpdateCommand;

type Decided = Effect.fn.Return<
  PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
>;

function invariant(commandType: string, detail: string) {
  return new OrchestrationCommandInvariantError({ commandType, detail });
}

function findTask(readModel: OrchestrationReadModel, taskId: string): Task | undefined {
  return readModel.tasks?.find((task) => task.id === taskId);
}

/** Why `title` or `notes` is refused, or null. */
function textError(title: string | undefined, notes: string | undefined): string | null {
  if (title !== undefined) {
    if (title.length > TASK_TITLE_MAX)
      return `A task title is at most ${TASK_TITLE_MAX} characters.`;
    if (title.includes("\n")) return "A task title is one line.";
  }
  if (notes !== undefined && notes.trim().length > TASK_NOTES_MAX) {
    return `Task notes are at most ${TASK_NOTES_MAX} characters.`;
  }
  return null;
}

function homeError(home: TaskHome): string | null {
  // A real day: 2026-02-30 is refused, not rolled into March.
  const valid = isTaskLocalDate;
  if (home.kind === "date" && !valid(home.date)) return `'${home.date}' is not a date.`;
  if (home.kind === "period") {
    if (!valid(home.startsOn) || !valid(home.endsOn)) return "A period needs real dates.";
    if (home.endsOn < home.startsOn) return "A period cannot end before it starts.";
  }
  return null;
}

function recurrenceError(recurrence: TaskRecurrence | undefined, home: TaskHome): string | null {
  if (recurrence === undefined) return null;
  // The day is the anchor the next occurrence counts from.
  if (home.kind !== "date") return "Only a task scheduled on a day can repeat.";
  return null;
}

/**
 * The links as stored: a thread fills in its Project, and a workstream must
 * be on that Project's board. Or why they are refused.
 */
function resolveLinks(
  readModel: OrchestrationReadModel,
  links: TaskLinks | null | undefined,
): TaskLinks | undefined | string {
  if (links == null) return undefined;
  let projectId: ProjectId | undefined = links.projectId;
  if (links.threadId !== undefined) {
    const thread = readModel.threads.find((entry) => entry.id === links.threadId);
    if (thread === undefined || thread.deletedAt !== null) {
      return `'${links.threadId}' is not a thread.`;
    }
    if (projectId !== undefined && projectId !== thread.projectId) {
      return "That thread belongs to another Project.";
    }
    projectId = thread.projectId;
  }
  if (projectId !== undefined) {
    const project = readModel.projects.find((entry) => entry.id === projectId);
    if (project === undefined || project.deletedAt !== null) {
      return `'${projectId}' is not a Project.`;
    }
    if (
      links.statusId !== undefined &&
      !(project.assistant?.statuses ?? []).some((status) => status.id === links.statusId)
    ) {
      return `There is no workstream '${links.statusId}' in that Project.`;
    }
  } else if (links.statusId !== undefined) {
    return "A workstream link needs its Project.";
  }
  const resolved: TaskLinks = {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(links.threadId !== undefined ? { threadId: links.threadId } : {}),
    ...(links.statusId !== undefined ? { statusId: links.statusId } : {}),
  };
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

function taskEvent(command: TaskCommand | TaskIntentSetCommand, taskId: string, task: Task | null) {
  return Effect.map(
    withEventBase({
      aggregateKind: "task",
      aggregateId: TaskId.make(taskId),
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    (base): PlannedOrchestrationEvent => ({
      ...base,
      type: "task.updated" as const,
      payload: { taskId: TaskId.make(taskId), task },
    }),
  );
}

/** Applies a user edit to a stored task, or says why not. */
function applyPatch(
  readModel: OrchestrationReadModel,
  stored: Task,
  patch: TaskPatch,
  now: string,
): Task | string {
  const error = textError(patch.title, patch.notes);
  if (error !== null) return error;
  const home = patch.home ?? stored.home;
  const homeProblem = homeError(home);
  if (homeProblem !== null) return homeProblem;
  // Moving a repeating task off its day drops the repeat rather than refusing the move.
  const recurrence =
    patch.recurrence === null
      ? undefined
      : (patch.recurrence ?? (home.kind === "date" ? stored.recurrence : undefined));
  const recurrenceProblem = recurrenceError(recurrence, home);
  if (recurrenceProblem !== null) return recurrenceProblem;
  const links = patch.links === undefined ? stored.links : resolveLinks(readModel, patch.links);
  if (typeof links === "string") return links;
  const notes =
    patch.notes === undefined
      ? stored.notes
      : patch.notes.trim().length === 0
        ? undefined
        : patch.notes.trim();
  const status = patch.status ?? stored.status;
  const orderKey = patch.orderKey === undefined ? stored.orderKey : patch.orderKey;
  const promptDismissed =
    patch.completionPromptDismissedAt === undefined
      ? stored.completionPromptDismissedAt
      : (patch.completionPromptDismissedAt ?? undefined);
  const completedAt =
    status === "todo" ? undefined : status === stored.status ? stored.completedAt : now;
  const {
    notes: _notes,
    recurrence: _recurrence,
    links: _links,
    orderKey: _orderKey,
    completionPromptDismissedAt: _prompt,
    completedAt: _completedAt,
    ...rest
  } = stored;
  return {
    ...rest,
    title: patch.title ?? stored.title,
    status,
    home,
    ...(notes !== undefined ? { notes } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(orderKey !== undefined ? { orderKey } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(promptDismissed !== undefined ? { completionPromptDismissedAt: promptDismissed } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    updatedAt: now,
  };
}

/**
 * Completing a repeating task closes this occurrence and opens the next one
 * on its next day, keeping title, notes, links, reminder and order.
 */
const nextOccurrence = Effect.fn("nextOccurrence")(function* (completed: Task, now: string) {
  if (completed.recurrence === undefined || completed.home.kind !== "date") return null;
  const crypto = yield* Crypto.Crypto;
  const id = TaskId.make(yield* crypto.randomUUIDv4);
  const date = nextTaskOccurrence(completed.home.date, completed.recurrence);
  const {
    completedAt: _completedAt,
    handoff: _handoff,
    completionPromptDismissedAt: _prompt,
    importSource: _importSource,
    proposal: _proposal,
    ...rest
  } = completed;
  const next: Task = {
    ...rest,
    id,
    status: "todo",
    home: { ...completed.home, date },
    createdAt: now,
    updatedAt: now,
  };
  return next;
});

export const decideTaskCreate = Effect.fn("decideTaskCreate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskCreateCommand,
): Decided {
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, `Task '${command.taskId}' already exists.`);
  }
  if (
    command.importSource !== undefined &&
    (readModel.tasks ?? []).some(
      (task) =>
        task.importSource?.kind === command.importSource!.kind &&
        task.importSource.id === command.importSource!.id,
    )
  ) {
    return yield* invariant(command.type, "That task was already imported.");
  }
  const problem =
    textError(command.title, command.notes) ??
    homeError(command.home) ??
    recurrenceError(command.recurrence, command.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const links = resolveLinks(readModel, command.links);
  if (typeof links === "string") return yield* invariant(command.type, links);
  const notes = command.notes?.trim();
  const task: Task = {
    id: command.taskId,
    title: command.title,
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: command.home,
    ...(command.recurrence !== undefined ? { recurrence: command.recurrence } : {}),
    ...(command.orderKey != null ? { orderKey: command.orderKey } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(command.importSource !== undefined ? { importSource: command.importSource } : {}),
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, task.id, task);
});

export const decideTaskUpdate = Effect.fn("decideTaskUpdate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskUpdateCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  if (isProposedTask(stored)) {
    return yield* invariant(command.type, "Add the proposed task before editing it.");
  }
  const next = applyPatch(readModel, stored, command.patch, command.createdAt);
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* writeEdit(command, stored, next);
});

/** Writes an edited task; completing a repeating one also opens its next occurrence. */
const writeEdit = Effect.fn("writeEdit")(function* (
  command: TaskUpdateCommand | TaskAgentUpdateCommand,
  stored: Task,
  next: Task,
): Decided {
  const written = yield* taskEvent(command, next.id, next);
  if (stored.status === "completed" || next.status !== "completed") return written;
  const following = yield* nextOccurrence(next, command.createdAt);
  if (following === null) return written;
  // The closed occurrence stops repeating; the new one carries the rule.
  const { recurrence: _recurrence, ...closed } = next;
  return [
    yield* taskEvent(command, closed.id, closed),
    yield* taskEvent(command, following.id, following),
  ];
});

export const decideTaskDelete = Effect.fn("decideTaskDelete")(function* (
  readModel: OrchestrationReadModel,
  command: TaskDeleteCommand,
): Decided {
  if (findTask(readModel, command.taskId) === undefined) {
    return yield* invariant(command.type, "That task no longer exists.");
  }
  return yield* taskEvent(command, command.taskId, null);
});

/** `task.proposal.respond`: only the user adds or dismisses a proposal. */
export const decideTaskProposalRespond = Effect.fn("decideTaskProposalRespond")(function* (
  readModel: OrchestrationReadModel,
  command: TaskProposalRespondCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined || !isProposedTask(stored)) {
    return yield* invariant(command.type, "That proposal is no longer waiting.");
  }
  if (!command.accept) return yield* taskEvent(command, stored.id, null);
  const accepted: Task = {
    ...stored,
    proposal: { ...stored.proposal!, acceptedAt: command.createdAt },
    updatedAt: command.createdAt,
  };
  const next =
    command.patch === undefined
      ? accepted
      : applyPatch(readModel, accepted, command.patch, command.createdAt);
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* taskEvent(command, next.id, next);
});

/** `task.handoff`: links the task to the thread that now has it as its brief. */
export const decideTaskHandoff = Effect.fn("decideTaskHandoff")(function* (
  readModel: OrchestrationReadModel,
  command: TaskHandoffCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  if (isProposedTask(stored)) {
    return yield* invariant(command.type, "Add the proposed task before handing it off.");
  }
  if (command.handoff === null) {
    const { handoff: _handoff, ...rest } = stored;
    return yield* taskEvent(command, stored.id, { ...rest, updatedAt: command.createdAt });
  }
  const links = resolveLinks(readModel, {
    ...(stored.links?.statusId !== undefined && stored.links.projectId !== undefined
      ? { statusId: stored.links.statusId }
      : {}),
    threadId: command.handoff.threadId,
  });
  if (typeof links === "string") return yield* invariant(command.type, links);
  return yield* taskEvent(command, stored.id, {
    ...stored,
    ...(links !== undefined ? { links } : {}),
    handoff: command.handoff,
    updatedAt: command.createdAt,
  });
});

/** `task.propose`: one coordinator suggestion for the user's list. */
export const decideTaskPropose = Effect.fn("decideTaskPropose")(function* (
  readModel: OrchestrationReadModel,
  command: TaskProposeCommand,
): Decided {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  if (project === undefined || project.deletedAt !== null) {
    return yield* invariant(command.type, `'${command.projectId}' is not a Project.`);
  }
  const actor = readModel.threads.find((thread) => thread.id === command.actorThreadId);
  // The tool checks this too; the decider keeps it true for any caller.
  if (
    actor === undefined ||
    actor.deletedAt !== null ||
    actor.archivedAt !== null ||
    (agentManagerRole(project, actor) !== "coordinator" && !isAssistantChannel(project, actor))
  ) {
    return yield* invariant(command.type, "Only the Project's coordinator can propose tasks.");
  }
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, `Task '${command.taskId}' already exists.`);
  }
  const waiting = (readModel.tasks ?? []).filter(
    (task) => isProposedTask(task) && task.proposal?.projectId === command.projectId,
  );
  if (waiting.length >= TASK_PROPOSALS_PER_PROJECT_MAX) {
    return yield* invariant(
      command.type,
      `At most ${TASK_PROPOSALS_PER_PROJECT_MAX} proposed tasks wait at once. Let the user add or dismiss some first.`,
    );
  }
  const folded = command.title.toLowerCase();
  if (waiting.some((task) => task.title.toLowerCase() === folded)) {
    return yield* invariant(command.type, `'${command.title}' is already proposed.`);
  }
  const problem = textError(command.title, command.notes) ?? homeError(command.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const links = resolveLinks(readModel, {
    projectId: command.projectId,
    ...(command.statusId !== undefined ? { statusId: command.statusId } : {}),
  });
  if (typeof links === "string") return yield* invariant(command.type, links);
  const notes = command.notes?.trim();
  const task: Task = {
    id: command.taskId,
    title: command.title,
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: command.home,
    ...(links !== undefined ? { links } : {}),
    proposal: {
      projectId: command.projectId,
      threadId: command.actorThreadId,
      proposedAt: command.createdAt,
    },
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, task.id, task);
});

/** The live thread behind an agent command and its Project, or undefined. */
function liveActor(readModel: OrchestrationReadModel, threadId: string) {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
    return undefined;
  }
  const project = readModel.projects.find((entry) => entry.id === thread.projectId);
  if (project === undefined || project.deletedAt !== null) return undefined;
  return { thread, project };
}

/** `task.agent.create`: the Assistant adds a task straight to the user's list. */
export const decideTaskAgentCreate = Effect.fn("decideTaskAgentCreate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentCreateCommand,
): Decided {
  const actor = liveActor(readModel, command.actorThreadId);
  if (actor === undefined || !isAssistantChannel(actor.project, actor.thread)) {
    return yield* invariant(command.type, "Only the Assistant can add tasks directly.");
  }
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, `Task '${command.taskId}' already exists.`);
  }
  const problem = textError(command.title, command.notes) ?? homeError(command.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const notes = command.notes?.trim();
  const task: Task = {
    id: command.taskId,
    title: command.title,
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: command.home,
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, task.id, task);
});

/**
 * `task.agent.update`: the Assistant edits any task; a coordinator edits only
 * tasks its Project proposed, and never completes or reopens one. Nobody but
 * the user adds or dismisses a waiting proposal, so its status stays put.
 */
export const decideTaskAgentUpdate = Effect.fn("decideTaskAgentUpdate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentUpdateCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  const actor = liveActor(readModel, command.actorThreadId);
  const assistant = actor !== undefined && isAssistantChannel(actor.project, actor.thread);
  const coordinator =
    actor !== undefined && agentManagerRole(actor.project, actor.thread) === "coordinator";
  if (!assistant) {
    if (!coordinator || stored.proposal?.projectId !== actor.project.id) {
      return yield* invariant(
        command.type,
        "You can only edit tasks this Project proposed. Ask the user to change the others.",
      );
    }
    if (command.patch.status !== undefined && command.patch.status !== stored.status) {
      return yield* invariant(command.type, "Only the user completes or reopens a task.");
    }
  }
  if (
    isProposedTask(stored) &&
    command.patch.status !== undefined &&
    command.patch.status !== stored.status
  ) {
    return yield* invariant(
      command.type,
      "That task is still a proposal. Only the user adds or dismisses it.",
    );
  }
  const next = applyPatch(readModel, stored, command.patch, command.createdAt);
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* writeEdit(command, stored, next);
});

export const decideTaskIntentSet = Effect.fn("decideTaskIntentSet")(function* (
  readModel: OrchestrationReadModel,
  command: TaskIntentSetCommand,
): Decided {
  const text = command.text.trim();
  if (text.length > TASK_INTENT_MAX) {
    return yield* invariant(command.type, `An intent is at most ${TASK_INTENT_MAX} characters.`);
  }
  if (Number.isNaN(Date.parse(`${command.startsOn}T00:00:00Z`))) {
    return yield* invariant(command.type, `'${command.startsOn}' is not a date.`);
  }
  const stored = readModel.taskIntents?.find(
    (intent) => intent.horizon === command.horizon && intent.startsOn === command.startsOn,
  );
  if (text.length === 0 && stored === undefined) {
    return yield* invariant(command.type, "There is no intent to clear.");
  }
  const base = yield* withEventBase({
    aggregateKind: "task",
    aggregateId: taskIntentKey(command.horizon, command.startsOn),
    occurredAt: command.createdAt,
    commandId: command.commandId,
  });
  return {
    ...base,
    type: "task.intent-updated" as const,
    payload: {
      horizon: command.horizon,
      startsOn: command.startsOn,
      intent:
        text.length === 0
          ? null
          : {
              horizon: command.horizon,
              startsOn: command.startsOn,
              text,
              updatedAt: command.createdAt,
            },
    },
  } satisfies PlannedOrchestrationEvent;
});

/** Replaces or removes one task in a list, keeping order. */
export function withTask(
  tasks: ReadonlyArray<Task> | undefined,
  taskId: string,
  task: Task | null,
): Task[] {
  const list = tasks ?? [];
  if (task === null) return list.filter((entry) => entry.id !== taskId);
  return list.some((entry) => entry.id === taskId)
    ? list.map((entry) => (entry.id === taskId ? task : entry))
    : [...list, task];
}

/** Fields only Control Plane knows; a pulled record never carries them. */
function withLocalFields(remote: Task, stored: Task | undefined): Task {
  if (stored === undefined) return remote;
  return {
    ...remote,
    ...(stored.links !== undefined ? { links: stored.links } : {}),
    ...(stored.proposal !== undefined ? { proposal: stored.proposal } : {}),
    ...(stored.handoff !== undefined ? { handoff: stored.handoff } : {}),
    ...(stored.completionPromptDismissedAt !== undefined
      ? { completionPromptDismissedAt: stored.completionPromptDismissedAt }
      : {}),
  };
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * `task.sync.apply`: records pulled from the synced store. Only real
 * changes become events, so a quiet poll writes nothing.
 */
export const decideTaskSyncApply = Effect.fn("decideTaskSyncApply")(function* (
  readModel: OrchestrationReadModel,
  command: TaskSyncApplyCommand,
): Decided {
  const events: PlannedOrchestrationEvent[] = [];
  for (const remote of command.tasks) {
    const stored = findTask(readModel, remote.id);
    const next = withLocalFields(remote, stored);
    if (stored !== undefined && sameRecord(stored, next)) continue;
    events.push(yield* taskEvent(command, next.id, next));
  }
  for (const taskId of command.removedTaskIds) {
    if (findTask(readModel, taskId) === undefined) continue;
    events.push(yield* taskEvent(command, taskId, null));
  }
  for (const intent of command.intents) {
    const stored = readModel.taskIntents?.find(
      (entry) => entry.horizon === intent.horizon && entry.startsOn === intent.startsOn,
    );
    if (stored !== undefined && stored.text === intent.text) continue;
    events.push(yield* intentEvent(command, intent.horizon, intent.startsOn, intent));
  }
  for (const removed of command.removedIntents) {
    const stored = readModel.taskIntents?.find(
      (entry) => entry.horizon === removed.horizon && entry.startsOn === removed.startsOn,
    );
    if (stored === undefined) continue;
    events.push(yield* intentEvent(command, removed.horizon, removed.startsOn, null));
  }
  if (events.length === 0) {
    return yield* invariant(command.type, "Nothing changed.");
  }
  return events;
});

function intentEvent(
  command: TaskSyncApplyCommand | TaskIntentSetCommand,
  horizon: TaskIntent["horizon"],
  startsOn: string,
  intent: TaskIntent | null,
) {
  return Effect.map(
    withEventBase({
      aggregateKind: "task",
      aggregateId: taskIntentKey(horizon, startsOn),
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    (base): PlannedOrchestrationEvent => ({
      ...base,
      type: "task.intent-updated" as const,
      payload: { horizon, startsOn, intent },
    }),
  );
}
