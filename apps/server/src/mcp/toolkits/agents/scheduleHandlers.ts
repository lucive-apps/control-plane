/**
 * The `cp_schedule_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * Coordinator only: M3 also grants `agents` to standing agents, so every call
 * checks the caller's live role. Each write is one
 * `project.schedule.agent-change`, so an agent never touches a schedule it did
 * not name, and the decider keeps a schedule an agent creates, re-prompts,
 * re-times or retargets paused until the user turns it on.
 *
 * @module scheduleHandlers
 */
import {
  agentManagerRole,
  CommandId,
  isStandingAgent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectAssistant,
  type ProjectScheduleAgentChange,
  type ProjectScheduleTarget,
} from "@t3tools/contracts";
import { describeCadence, newScheduleId } from "@t3tools/shared/schedules";
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
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { agentRefCandidates } from "./agentScope.ts";
import {
  AgentAmbiguousError,
  AgentNotFoundError,
  type AgentsToolkit,
  AgentToolFailedError,
  ScheduleNotFoundError,
  SchedulesCoordinatorOnlyError,
} from "./tools.ts";

type ScheduleToolName =
  | "cp_schedule_list"
  | "cp_schedule_create"
  | "cp_schedule_update"
  | "cp_schedule_delete";

type ScheduleHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  ScheduleToolName
>;

interface Coordinator {
  readonly caller: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
}

type ScheduleTargetResolution =
  | { readonly kind: "found"; readonly target: ProjectScheduleTarget }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not-standing" };

/**
 * `"coordinator"`, or a live standing agent of the Project named by threadId
 * or exact title. The coordinator named by its own id or title reads as
 * `"coordinator"`, which follows the role.
 */
function resolveScheduleTarget(
  ref: string,
  input: {
    readonly project: Pick<OrchestrationProjectShell, "id" | "assistant">;
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  },
): ScheduleTargetResolution {
  const trimmed = ref.trim();
  if (trimmed.toLowerCase() === "coordinator") return { kind: "found", target: "coordinator" };
  const { project } = input;
  const coordinatorId = project.assistant?.coordinatorThreadId;
  const candidates = agentRefCandidates(trimmed, {
    threads: input.threads.filter(
      (thread) => thread.projectId === project.id && thread.archivedAt === null,
    ),
    projectId: project.id,
  });
  const eligible = candidates.filter(
    (thread) => thread.id === coordinatorId || isStandingAgent(project, thread),
  );
  const [only] = eligible;
  if (eligible.length === 1 && only !== undefined) {
    return { kind: "found", target: only.id === coordinatorId ? "coordinator" : only.id };
  }
  if (eligible.length > 1) return { kind: "ambiguous" };
  return { kind: candidates.length === 0 ? "not-found" : "not-standing" };
}

/** Own keys only: a schedule id such as "constructor" must not read Object.prototype. */
function entryOf<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;
}

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read this Project's schedules.", cause });

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

/** The decider's reason (a bad cron, target or length) reaches the agent as written. */
const changeFailed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
  const error = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(error) && isInvariantError(error.value)
      ? error.value.detail
      : "Could not save the schedule.";
  return Effect.fail(new AgentToolFailedError({ detail, cause }));
};

/** Needs the project repository: the shell leaves out prompts. */
export const makeScheduleHandlers = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projects = yield* ProjectionProjectRepository;
  const crypto = yield* Crypto.Crypto;

  /** The role is checked live, so a replaced coordinator, or one whose Project was archived, is refused. */
  const requireCoordinator = Effect.fn("ScheduleTools.requireCoordinator")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) return yield* new SchedulesCoordinatorOnlyError();
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(project) || agentManagerRole(project.value, caller.value) !== "coordinator") {
      return yield* new SchedulesCoordinatorOnlyError();
    }
    return { caller: caller.value, project: project.value } satisfies Coordinator;
  });

  /** The full marker, prompts included. */
  const readMarker = (coordinator: Coordinator) =>
    projects.getById({ projectId: coordinator.project.id }).pipe(
      Effect.mapError(readFailed),
      Effect.map((row): ProjectAssistant | null => Option.getOrUndefined(row)?.assistant ?? null),
    );

  const requireSchedule = Effect.fn("ScheduleTools.requireSchedule")(function* (
    coordinator: Coordinator,
    id: string,
  ) {
    const marker = yield* readMarker(coordinator);
    const schedule = marker?.schedules?.find((entry) => entry.id === id);
    if (schedule === undefined) return yield* new ScheduleNotFoundError({ id });
    return { schedule, prompt: entryOf(marker?.schedulePrompts, id) };
  });

  const requireTarget = Effect.fn("ScheduleTools.requireTarget")(function* (
    coordinator: Coordinator,
    ref: string,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
    const resolved = resolveScheduleTarget(ref, {
      project: coordinator.project,
      threads: snapshot.threads,
    });
    switch (resolved.kind) {
      case "found":
        return resolved.target;
      case "ambiguous":
        return yield* new AgentAmbiguousError({ agent: ref });
      case "not-found":
        return yield* new AgentNotFoundError({ agent: ref });
      case "not-standing":
        return yield* new AgentToolFailedError({
          detail: `Schedules run in the coordinator or a standing agent. '${ref}' is neither.`,
        });
    }
  });

  const dispatchChange = Effect.fn("ScheduleTools.dispatchChange")(function* (
    coordinator: Coordinator,
    change: ProjectScheduleAgentChange,
  ) {
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine
      .dispatch({
        type: "project.schedule.agent-change",
        commandId: CommandId.make(`mcp-schedule:${uuid}`),
        projectId: coordinator.project.id,
        actorThreadId: coordinator.caller.id,
        change,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.catchCause(changeFailed));
  });

  return {
    cp_schedule_list: () =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator();
        const marker = yield* readMarker(coordinator);
        const schedules = (marker?.schedules ?? []).map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          prompt: entryOf(marker?.schedulePrompts, schedule.id) ?? "",
          cron: schedule.cron,
          cadence: describeCadence(schedule.cron),
          target: schedule.target,
          enabled: schedule.enabled,
          createdBy: schedule.createdBy,
          updatedBy: schedule.updatedBy,
          lastRun: entryOf(marker?.scheduleRuns, schedule.id) ?? null,
        }));
        return { schedules };
      }),

    cp_schedule_create: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator();
        const target =
          input.target === undefined ? undefined : yield* requireTarget(coordinator, input.target);
        const taken = new Set(
          ((yield* readMarker(coordinator))?.schedules ?? []).map((schedule) => schedule.id),
        );
        // An upsert on a taken id would edit that schedule instead.
        let id = newScheduleId(input.name);
        while (taken.has(id)) id = newScheduleId(input.name);
        yield* dispatchChange(coordinator, {
          kind: "upsert",
          id,
          name: input.name,
          prompt: input.prompt,
          cron: input.cron,
          ...(target === undefined ? {} : { target }),
        });
        return { id, enabled: false as const, note: "Saved off until the user turns it on." };
      }),

    cp_schedule_update: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator();
        const { schedule: existing, prompt } = yield* requireSchedule(coordinator, input.id);
        const target =
          input.target === undefined ? undefined : yield* requireTarget(coordinator, input.target);
        const storedTarget =
          existing.target === coordinator.project.assistant?.coordinatorThreadId
            ? "coordinator"
            : existing.target;
        // Values equal to the stored ones are dropped: any write, even one that
        // changes nothing, moves the Project in the sidebar.
        const fields = {
          ...(input.name === undefined || input.name === existing.name ? {} : { name: input.name }),
          ...(input.prompt === undefined || input.prompt === prompt
            ? {}
            : { prompt: input.prompt }),
          ...(input.cron === undefined || input.cron === existing.cron ? {} : { cron: input.cron }),
          ...(target === undefined || target === storedTarget ? {} : { target }),
          ...(input.pause === true && existing.enabled ? { enabled: false as const } : {}),
        };
        if (Object.keys(fields).length === 0) {
          return { id: existing.id, enabled: existing.enabled };
        }
        yield* dispatchChange(coordinator, { kind: "upsert", id: existing.id, ...fields });
        const { schedule: updated } = yield* requireSchedule(coordinator, existing.id);
        return { id: updated.id, enabled: updated.enabled };
      }),

    cp_schedule_delete: (input) =>
      Effect.gen(function* () {
        const coordinator = yield* requireCoordinator();
        const { schedule: existing } = yield* requireSchedule(coordinator, input.id);
        yield* dispatchChange(coordinator, { kind: "delete", id: existing.id });
        return { id: existing.id, deleted: true as const };
      }),
  } satisfies ScheduleHandlers;
});
