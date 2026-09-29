/**
 * Project schedule invariants for the decider. Fork-owned and pure, so each
 * decider.ts hunk stays a single call.
 *
 * Users write the whole list through `project.meta.update` (like `scripts`),
 * echoing each existing entry's `updatedAt`; a stale echo refuses the write.
 * Agents change one entry per command, so a write built from a stale read
 * never touches another schedule, and an agent can never turn one on.
 */
import {
  PROJECT_SCHEDULE_LIMIT,
  PROJECT_SCHEDULE_NAME_MAX,
  PROJECT_SCHEDULE_PROMPT_MAX,
  agentManagerRole,
  isStandingAgent,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectAssistant,
  type ProjectId,
  type ProjectSchedule,
  type ProjectScheduleActor,
  type ProjectScheduleInput,
  type ProjectScheduleRun,
  type ProjectScheduleTarget,
  type ThreadId,
} from "@t3tools/contracts";
import { validateScheduleCron } from "@t3tools/shared/schedules";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase, type PlannedOrchestrationEvent } from "./eventBase.ts";

type ScheduleRecordCommand = Extract<OrchestrationCommand, { type: "project.schedule.record" }>;
type ScheduleAgentChangeCommand = Extract<
  OrchestrationCommand,
  { type: "project.schedule.agent-change" }
>;

type ScheduleFields = Pick<ProjectAssistant, "schedules" | "schedulePrompts" | "scheduleRuns">;

const SCHEDULE_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const SCHEDULES_CHANGED = "Schedules changed since they were loaded. Try again.";

interface ScheduleScope {
  readonly readModel: OrchestrationReadModel;
  readonly projectId: ProjectId;
  /** The coordinator once the command applies. */
  readonly coordinatorThreadId: ThreadId;
  readonly commandType: OrchestrationCommand["type"];
}

/** Own keys only: a schedule id such as "constructor" must not read Object.prototype. */
function entryOf<T>(record: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

function invariant(commandType: string, detail: string) {
  return new OrchestrationCommandInvariantError({ commandType, detail });
}

/** `"coordinator"` follows the role, so the coordinator's own id is stored as the role. */
function normalizeTarget(
  target: ProjectScheduleTarget,
  coordinatorThreadId: ThreadId,
): ProjectScheduleTarget {
  return target === coordinatorThreadId ? "coordinator" : target;
}

/** A new or retargeted schedule runs in the coordinator or a live standing agent. */
function targetError(scope: ScheduleScope, target: ProjectScheduleTarget): string | null {
  if (target === "coordinator") return null;
  const thread = scope.readModel.threads.find((entry) => entry.id === target);
  const standing =
    thread !== undefined &&
    thread.projectId === scope.projectId &&
    thread.deletedAt === null &&
    thread.archivedAt === null &&
    isStandingAgent({ assistant: { coordinatorThreadId: scope.coordinatorThreadId } }, thread);
  return standing
    ? null
    : `A schedule runs in the coordinator or a standing agent of its Project; '${target}' is neither.`;
}

function entryError(
  scope: ScheduleScope,
  entry: { readonly id: string; readonly name: string; readonly cron: string },
  prompt: string,
  target: ProjectScheduleTarget,
  retargeted: boolean,
): string | null {
  if (!SCHEDULE_ID_PATTERN.test(entry.id)) {
    return `Schedule id '${entry.id}' must be 1-40 lowercase letters, digits or hyphens.`;
  }
  if (entry.name.length > PROJECT_SCHEDULE_NAME_MAX) {
    return `Schedule names are at most ${PROJECT_SCHEDULE_NAME_MAX} characters.`;
  }
  if (prompt.trim().length === 0 || prompt.length > PROJECT_SCHEDULE_PROMPT_MAX) {
    return `Schedule '${entry.name}' needs a prompt of 1-${PROJECT_SCHEDULE_PROMPT_MAX} characters.`;
  }
  const cronError = validateScheduleCron(entry.cron);
  if (cronError !== null) return `Schedule '${entry.name}': ${cronError}`;
  return retargeted ? targetError(scope, target) : null;
}

/** Keeps prompts and runs only for listed schedules, and omits empty fields. */
function scheduleFields(
  schedules: ReadonlyArray<ProjectSchedule>,
  prompts: Readonly<Record<string, string>>,
  runs: Readonly<Record<string, ProjectScheduleRun>>,
): ScheduleFields {
  if (schedules.length === 0) return {};
  const keptPrompts: Record<string, string> = {};
  const keptRuns: Record<string, ProjectScheduleRun> = {};
  for (const schedule of schedules) {
    const prompt = entryOf(prompts, schedule.id);
    if (prompt !== undefined) keptPrompts[schedule.id] = prompt;
    const run = entryOf(runs, schedule.id);
    if (run !== undefined) keptRuns[schedule.id] = run;
  }
  return {
    schedules,
    schedulePrompts: keptPrompts,
    ...(Object.keys(keptRuns).length > 0 ? { scheduleRuns: keptRuns } : {}),
  };
}

function withScheduleFields(assistant: ProjectAssistant, fields: ScheduleFields): ProjectAssistant {
  const {
    schedules: _schedules,
    schedulePrompts: _prompts,
    scheduleRuns: _runs,
    ...marker
  } = assistant;
  return { ...marker, ...fields };
}

/**
 * The schedule fields of a marker that `project.meta.update` rebuilds. With no
 * `inputs` the stored schedules carry over; otherwise `inputs` is the whole
 * list, and each existing entry must echo its stored `updatedAt`. Unarchiving
 * re-arms every schedule, so slots missed while archived never run and old
 * misses stop asking for attention.
 */
export const mergeSchedules = ({
  current,
  inputs,
  now,
  unarchiving,
  ...scope
}: ScheduleScope & {
  readonly current: ProjectAssistant | null;
  readonly inputs: ReadonlyArray<ProjectScheduleInput> | undefined;
  readonly now: string;
  readonly unarchiving: boolean;
}): Effect.Effect<ScheduleFields, OrchestrationCommandInvariantError> =>
  Effect.gen(function* () {
    const stored = current?.schedules ?? [];
    const prompts = current?.schedulePrompts ?? {};
    const runs = current?.scheduleRuns ?? {};
    const carried = (schedule: ProjectSchedule): ProjectSchedule => ({
      ...schedule,
      target: normalizeTarget(schedule.target, scope.coordinatorThreadId),
      ...(unarchiving ? { updatedAt: now } : {}),
    });
    if (inputs === undefined) {
      return scheduleFields(stored.map(carried), prompts, runs);
    }
    if (inputs.length > PROJECT_SCHEDULE_LIMIT) {
      return yield* invariant(
        scope.commandType,
        `A Project has at most ${PROJECT_SCHEDULE_LIMIT} schedules.`,
      );
    }

    const storedById = new Map(stored.map((schedule) => [schedule.id, schedule]));
    const nextPrompts: Record<string, string> = {};
    const next: ProjectSchedule[] = [];
    for (const input of inputs) {
      if (Object.hasOwn(nextPrompts, input.id)) {
        return yield* invariant(scope.commandType, `Schedule id '${input.id}' is used twice.`);
      }
      const existing = storedById.get(input.id);
      if (input.updatedAt !== existing?.updatedAt) {
        return yield* invariant(scope.commandType, SCHEDULES_CHANGED);
      }
      const prompt =
        input.prompt ?? (existing === undefined ? undefined : entryOf(prompts, input.id));
      if (prompt === undefined) {
        return yield* invariant(scope.commandType, `New schedule '${input.name}' needs a prompt.`);
      }
      const target = normalizeTarget(input.target, scope.coordinatorThreadId);
      const retargeted =
        existing === undefined ||
        target !== normalizeTarget(existing.target, scope.coordinatorThreadId);
      const error = entryError(scope, input, prompt, target, retargeted);
      if (error !== null) return yield* invariant(scope.commandType, error);

      const changed =
        existing === undefined ||
        retargeted ||
        existing.name !== input.name ||
        existing.cron !== input.cron ||
        existing.enabled !== input.enabled ||
        prompt !== entryOf(prompts, input.id);
      next.push(
        changed
          ? {
              id: input.id,
              name: input.name,
              cron: input.cron,
              target,
              enabled: input.enabled,
              createdBy: existing?.createdBy ?? "user",
              updatedBy: "user",
              updatedAt: now,
            }
          : carried(existing),
      );
      nextPrompts[input.id] = prompt;
    }
    return scheduleFields(next, nextPrompts, runs);
  });

/**
 * One agent write. A new schedule is saved off, and a change to its prompt,
 * cron or target turns it off, so a single prompt injection can never become
 * a running job. Every other schedule stays exactly as stored.
 */
export const applyAgentScheduleChange = ({
  current,
  change,
  actorThreadId,
  now,
  ...scope
}: ScheduleScope & {
  readonly current: ProjectAssistant;
  readonly change: ScheduleAgentChangeCommand["change"];
  readonly actorThreadId: ThreadId;
  readonly now: string;
}): Effect.Effect<ProjectAssistant, OrchestrationCommandInvariantError> =>
  Effect.gen(function* () {
    const stored = current.schedules ?? [];
    const prompts = current.schedulePrompts ?? {};
    const runs = current.scheduleRuns ?? {};
    const existing = stored.find((schedule) => schedule.id === change.id);
    const actor: ProjectScheduleActor = actorThreadId;

    if (change.kind === "delete") {
      if (existing === undefined) {
        return yield* invariant(scope.commandType, `Schedule '${change.id}' does not exist.`);
      }
      return withScheduleFields(
        current,
        scheduleFields(
          stored.filter((schedule) => schedule.id !== change.id),
          prompts,
          runs,
        ),
      );
    }

    if (existing === undefined) {
      if (stored.length >= PROJECT_SCHEDULE_LIMIT) {
        return yield* invariant(
          scope.commandType,
          `A Project has at most ${PROJECT_SCHEDULE_LIMIT} schedules.`,
        );
      }
      const { name, prompt, cron } = change;
      if (name === undefined || prompt === undefined || cron === undefined) {
        return yield* invariant(
          scope.commandType,
          "A new schedule needs a name, a prompt and a cron.",
        );
      }
      const target = normalizeTarget(change.target ?? "coordinator", scope.coordinatorThreadId);
      const error = entryError(scope, { id: change.id, name, cron }, prompt, target, true);
      if (error !== null) return yield* invariant(scope.commandType, error);
      const created: ProjectSchedule = {
        id: change.id,
        name,
        cron,
        target,
        enabled: false,
        createdBy: actor,
        updatedBy: actor,
        updatedAt: now,
      };
      return withScheduleFields(
        current,
        scheduleFields([...stored, created], { ...prompts, [change.id]: prompt }, runs),
      );
    }

    const name = change.name ?? existing.name;
    const cron = change.cron ?? existing.cron;
    const prompt = change.prompt ?? entryOf(prompts, change.id) ?? "";
    const storedTarget = normalizeTarget(existing.target, scope.coordinatorThreadId);
    const target =
      change.target === undefined
        ? storedTarget
        : normalizeTarget(change.target, scope.coordinatorThreadId);
    const retargeted = target !== storedTarget;
    const turnsOff = retargeted || cron !== existing.cron || prompt !== entryOf(prompts, change.id);
    const enabled = turnsOff || change.enabled === false ? false : existing.enabled;
    const error = entryError(scope, { id: change.id, name, cron }, prompt, target, retargeted);
    if (error !== null) return yield* invariant(scope.commandType, error);

    const changed = turnsOff || name !== existing.name || enabled !== existing.enabled;
    const updated: ProjectSchedule = changed
      ? { ...existing, name, cron, target, enabled, updatedBy: actor, updatedAt: now }
      : existing;
    return withScheduleFields(
      current,
      scheduleFields(
        stored.map((schedule) => (schedule.id === change.id ? updated : schedule)),
        { ...prompts, [change.id]: prompt },
        runs,
      ),
    );
  });

/** `project.schedule.agent-change`: the resolved marker as a `project.meta-updated`. */
export const decideAgentScheduleChange = Effect.fn("decideAgentScheduleChange")(function* (
  readModel: OrchestrationReadModel,
  command: ScheduleAgentChangeCommand,
): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  const current = project?.assistant;
  if (project === undefined || project.deletedAt !== null || current == null) {
    return yield* invariant(command.type, `Project '${command.projectId}' has no schedules.`);
  }
  const actor = readModel.threads.find((thread) => thread.id === command.actorThreadId);
  // The schedule tools check this too; the decider keeps it true for any caller.
  if (
    actor === undefined ||
    actor.deletedAt !== null ||
    actor.archivedAt !== null ||
    agentManagerRole(project, actor) !== "coordinator"
  ) {
    return yield* invariant(command.type, "Only the Project's coordinator can manage schedules.");
  }
  const assistant = yield* applyAgentScheduleChange({
    readModel,
    projectId: command.projectId,
    coordinatorThreadId: current.coordinatorThreadId,
    commandType: command.type,
    current,
    change: command.change,
    actorThreadId: command.actorThreadId,
    now: command.createdAt,
  });
  return {
    ...(yield* withEventBase({
      aggregateKind: "project",
      aggregateId: command.projectId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    })),
    type: "project.meta-updated" as const,
    payload: { projectId: command.projectId, assistant, updatedAt: command.createdAt },
  };
});

/**
 * `project.schedule.record`: a run of a schedule that still exists. A record
 * never moves the last run back to an older slot; the same slot may be
 * recorded again (the single `:final` re-record).
 */
export const decideScheduleRecord = Effect.fn("decideScheduleRecord")(function* (
  readModel: OrchestrationReadModel,
  command: ScheduleRecordCommand,
): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  const assistant = project?.deletedAt === null ? project.assistant : undefined;
  if (!(assistant?.schedules ?? []).some((schedule) => schedule.id === command.scheduleId)) {
    return yield* invariant(
      command.type,
      `Schedule '${command.scheduleId}' does not exist in Project '${command.projectId}'.`,
    );
  }
  const last = entryOf(assistant?.scheduleRuns ?? {}, command.scheduleId);
  if (last !== undefined && Date.parse(command.run.slot) < Date.parse(last.slot)) {
    return yield* invariant(
      command.type,
      `Schedule '${command.scheduleId}' already has a run for a later slot.`,
    );
  }
  return {
    ...(yield* withEventBase({
      aggregateKind: "project",
      aggregateId: command.projectId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    })),
    type: "project.schedule-run-recorded" as const,
    payload: { projectId: command.projectId, scheduleId: command.scheduleId, run: command.run },
  };
});
