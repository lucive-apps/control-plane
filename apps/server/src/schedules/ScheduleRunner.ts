/**
 * ScheduleRunner - turns a fire or Run now into scheduled prompts. Fork-owned.
 *
 * Nothing here runs a schedule on a timer: a fire from the host's OS entry, or
 * Run now, makes a slot due. A due run waits in memory until its target is
 * idle for delivery, for up to 15 minutes, and is then appended as
 * `cp-schedule:<key>`. M3's AgentCompletionReactor starts it, so every thread
 * keeps a single starter and a scheduled prompt never steers a running turn.
 * The 30-second re-check only re-tests runs a fire already made due.
 *
 * Every run is recorded with `project.schedule.record`. How a sent run ended
 * is read later from projections and receipts (`scheduleQueries.ts`), so a
 * restart mid-turn still records it. Held runs live only in memory; a restart
 * drops them.
 *
 * Ids (the projectId is in every key because schedule ids are per Project):
 * - run key: `<projectId>:<scheduleId>:<slotIso>`, or `...:manual:<uuid>`;
 * - append command and message: `cp-schedule:<key>`;
 * - records: `cp-schedule-run:<key>`, then `cp-schedule-run:<key>:final` for
 *   the single re-record as `failed` or `missed: rejected`.
 *
 * @module ScheduleRunner
 */
import {
  CommandId,
  MessageId,
  SCHEDULE_MESSAGE_PREFIX,
  ScheduleUnavailableError,
  type OrchestrationEvent,
  type ProjectAssistant,
  type ProjectId,
  type ProjectSchedule,
  type ProjectScheduleRun,
  type SchedulesRunResult,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  BUSY_HOLD_MS,
  HOLD_RECHECK_MS,
  LATE_LIMIT_MS,
  scheduleSlotAt,
} from "@t3tools/shared/schedules";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isDeliveryIdle } from "../orchestration/agentPushes.ts";
import {
  OrchestrationCommandPreviouslyRejectedError,
  isOrchestrationCommandRejection,
  type OrchestrationCommandRejection,
} from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { isProjectReorderOnlyPayload } from "../orchestration/projectOrderEvents.ts";
import { forkParked } from "../serverActivation.ts";
import { HostTimeZoneSource } from "./hostZone.ts";
import { makeScheduleQueries } from "./scheduleQueries.ts";

/** Sent runs are checked for a failed or refused start for this long. */
const OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;
const OUTCOME_SWEEP_MS = 60 * 60 * 1000;

export function cronRunKey(projectId: string, scheduleId: string, slotIso: string): string {
  return `${projectId}:${scheduleId}:${slotIso}`;
}

export function manualRunKey(projectId: string, scheduleId: string, uuid: string): string {
  return `${projectId}:${scheduleId}:manual:${uuid}`;
}

/** Command id and message id of a run's appended prompt. */
export function scheduleMessageId(runKey: string): string {
  return `${SCHEDULE_MESSAGE_PREFIX}${runKey}`;
}

/** Command id of a run's record. Never matches `cp-schedule:*`. */
export function scheduleRecordId(runKey: string, final = false): string {
  return `cp-schedule-run:${runKey}${final ? ":final" : ""}`;
}

/** The marker of a live, unarchived Project, or null. */
export function activeAssistant(row: ProjectionProject): ProjectAssistant | null {
  return row.deletedAt === null && row.assistant != null && row.assistant.archivedAt == null
    ? row.assistant
    : null;
}

/** Own keys only: a schedule id such as "constructor" must not read Object.prototype. */
function entryOf<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;
}

export function lastRunOf(
  assistant: ProjectAssistant,
  scheduleId: string,
): ProjectScheduleRun | undefined {
  return entryOf(assistant.scheduleRuns, scheduleId);
}

/** `"coordinator"` follows the role. */
function targetOf(assistant: ProjectAssistant, schedule: ProjectSchedule): ThreadId {
  return schedule.target === "coordinator" ? assistant.coordinatorThreadId : schedule.target;
}

const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);

/** The decider refused the command, now or when its id was first used. */
const isRejection = (
  error: unknown,
): error is OrchestrationCommandRejection | OrchestrationCommandPreviouslyRejectedError =>
  isOrchestrationCommandRejection(error) || isPreviouslyRejected(error);

const isUnavailable = Schema.is(ScheduleUnavailableError);

/** Records one run. A refused record (the schedule was deleted, or a newer run exists) is dropped. */
export const recordScheduleRun = (
  engine: OrchestrationEngineService["Service"],
  input: {
    readonly projectId: ProjectId;
    readonly scheduleId: string;
    readonly runKey: string;
    readonly run: ProjectScheduleRun;
    readonly final?: boolean;
  },
) =>
  Effect.gen(function* () {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "project.schedule.record",
        commandId: CommandId.make(scheduleRecordId(input.runKey, input.final)),
        projectId: input.projectId,
        scheduleId: input.scheduleId,
        run: input.run,
        createdAt,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchIf(isRejection, (error) =>
          Effect.logDebug("schedule run not recorded", {
            projectId: input.projectId,
            scheduleId: input.scheduleId,
            detail: error.message,
          }),
        ),
      );
  });

export class ScheduleRunner extends Context.Service<
  ScheduleRunner,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Queues a fire: every enabled schedule's slot at `now` runs once. */
    readonly requestFire: (now: Date) => Effect.Effect<void>;
    /** Sends a schedule's prompt once, enabled or not, holding it while the target is busy. */
    readonly runNow: (
      projectId: ProjectId,
      scheduleId: string,
    ) => Effect.Effect<SchedulesRunResult, ScheduleUnavailableError>;
    /** Runs waiting for a busy target, per schedule id. */
    readonly holds: (
      projectId: ProjectId,
    ) => Effect.Effect<Readonly<Record<string, { readonly since: string }>>>;
    /** Resolves once every event committed so far has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/schedules/ScheduleRunner") {}

interface Hold {
  readonly projectId: ProjectId;
  readonly scheduleId: string;
  readonly runKey: string;
  readonly slot: string;
  readonly trigger: ProjectScheduleRun["trigger"];
  readonly sinceMs: number;
  /** FIFO across schedules sharing a target. */
  readonly order: number;
  /** A pass left it waiting, so its record says it ran after the target was busy. */
  readonly waited: boolean;
}

interface WatchedRun {
  readonly projectId: ProjectId;
  readonly scheduleId: string;
  readonly threadId: ThreadId;
  readonly run: ProjectScheduleRun;
}

type ReleaseResult = "sent" | "missed" | "dropped";

type Work =
  | { readonly kind: "fire"; readonly now: Date }
  | {
      readonly kind: "run-now";
      readonly projectId: ProjectId;
      readonly scheduleId: string;
      readonly reply: Deferred.Deferred<SchedulesRunResult, ScheduleUnavailableError>;
    }
  | { readonly kind: "release" }
  | { readonly kind: "outcomes"; readonly threadId: ThreadId | null; readonly reload: boolean };

/** Log and continue, so one bad schedule or event never stops the runner. */
const warnOnFailure =
  (message: string, annotations: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { ...annotations, cause: Cause.pretty(cause) }),
      ),
    );

const holdKeyOf = (projectId: string, scheduleId: string) => `${projectId}:${scheduleId}`;

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  const sessions = yield* ProjectionThreadSessionRepository;
  const turns = yield* ProjectionTurnRepository;
  const crypto = yield* Crypto.Crypto;
  const hostZone = yield* HostTimeZoneSource;
  const queries = makeScheduleQueries(yield* SqlClient.SqlClient);

  // Keyed by holdKeyOf: at most one held run per schedule.
  const holds = new Map<string, Hold>();
  // Sent runs whose turn may still fail, keyed by holdKeyOf.
  const watched = new Map<string, WatchedRun>();
  let nextOrder = 0;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const record = (
    projectId: ProjectId,
    scheduleId: string,
    runKey: string,
    run: ProjectScheduleRun,
    final = false,
  ) => recordScheduleRun(engine, { projectId, scheduleId, runKey, run, final });

  /** A thread of the Project that is neither deleted nor archived. */
  const liveThread = (projectId: ProjectId, threadId: ThreadId) =>
    threads.getById({ threadId }).pipe(
      Effect.map(Option.getOrNull),
      Effect.map((thread): ProjectionThread | null =>
        thread !== null &&
        thread.projectId === projectId &&
        thread.deletedAt === null &&
        thread.archivedAt === null
          ? thread
          : null,
      ),
    );

  const hold = (input: Omit<Hold, "sinceMs" | "order" | "waited">) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((sinceMs) => {
        // Replaces the schedule's held run. A fire never holds an older slot
        // over a newer one, and Run now's slot is always the newest.
        holds.set(holdKeyOf(input.projectId, input.scheduleId), {
          ...input,
          sinceMs,
          order: nextOrder++,
          waited: false,
        });
      }),
    );

  /** What a held run needs to go out now, or null when it should be dropped. */
  const readyToSend = (row: ProjectionProject | null, held: Hold) =>
    Effect.gen(function* () {
      const assistant = row === null ? null : activeAssistant(row);
      const schedule = assistant?.schedules?.find((entry) => entry.id === held.scheduleId);
      if (assistant == null || schedule === undefined) return null;
      // Run now ignores the switch. An edit, pause or resume re-arms the
      // schedule, so a cron run held from before it no longer applies.
      // A cron slot the host has since recorded (as `missed: not-running`)
      // must not also run.
      const last = lastRunOf(assistant, schedule.id);
      if (
        held.trigger === "cron" &&
        (!schedule.enabled ||
          Date.parse(schedule.updatedAt) > Date.parse(held.slot) ||
          (last !== undefined && Date.parse(last.slot) >= Date.parse(held.slot)))
      ) {
        return null;
      }
      const prompt = entryOf(assistant.schedulePrompts, schedule.id);
      const target = yield* liveThread(held.projectId, targetOf(assistant, schedule));
      return prompt === undefined || target === null
        ? null
        : { assistant, schedule, prompt, target };
    });

  const isIdleForDelivery = (threadId: ThreadId, now: string) =>
    Effect.all([
      sessions.getByThreadId({ threadId }),
      turns.getPendingTurnStartByThreadId({ threadId }),
    ]).pipe(
      Effect.map(([session, pendingStart]) =>
        isDeliveryIdle(Option.getOrNull(session), Option.getOrNull(pendingStart), now),
      ),
    );

  const append = (
    held: Hold,
    ready: {
      readonly assistant: ProjectAssistant;
      readonly schedule: ProjectSchedule;
      readonly prompt: string;
      readonly target: ProjectionThread;
    },
    now: string,
  ) =>
    Effect.gen(function* () {
      const messageId = MessageId.make(scheduleMessageId(held.runKey));
      const threadId = ready.target.threadId;
      const coordinatorId = ready.assistant.coordinatorThreadId;
      const accepted = yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(messageId),
          threadId,
          message: {
            messageId,
            text: ready.prompt,
            attachments: [],
            source: {
              kind: "agent",
              threadTitle: ready.schedule.name,
              scheduleId: ready.schedule.id,
              // A standing agent's result goes to the coordinator.
              ...(threadId !== coordinatorId ? { replyTo: coordinatorId } : {}),
            },
          },
          createdAt: now,
        })
        .pipe(
          Effect.as(true),
          Effect.catchIf(isRejection, (error) =>
            Effect.logWarning("scheduled prompt refused", {
              projectId: held.projectId,
              scheduleId: held.scheduleId,
              detail: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
      yield* record(
        held.projectId,
        held.scheduleId,
        held.runKey,
        accepted
          ? {
              slot: held.slot,
              at: now,
              trigger: held.trigger,
              outcome: "sent",
              threadId,
              ...(held.waited ? { reason: "busy" as const } : {}),
            }
          : {
              slot: held.slot,
              at: now,
              trigger: held.trigger,
              outcome: "missed",
              reason: "rejected",
              threadId,
            },
      );
      return accepted ? ("sent" as const) : ("missed" as const);
    });

  /**
   * Appends at most one held run per idle target, oldest first. The rest keep
   * waiting, and any that waited 15 minutes are recorded `missed: busy`.
   */
  const release = Effect.fn("ScheduleRunner.release")(function* () {
    const results = new Map<string, ReleaseResult>();
    const nowMs = yield* Clock.currentTimeMillis;
    const now = isoAt(nowMs);
    const rows = new Map<ProjectId, ProjectionProject | null>();
    const rowOf = (projectId: ProjectId) =>
      rows.has(projectId)
        ? Effect.succeed(rows.get(projectId) ?? null)
        : projects.getById({ projectId }).pipe(
            Effect.map(Option.getOrNull),
            Effect.tap((row) => Effect.sync(() => rows.set(projectId, row))),
          );
    const served = new Set<ThreadId>();
    const busy = new Set<ThreadId>();
    const ordered = [...holds.entries()].sort(([, left], [, right]) => left.order - right.order);
    for (const [key, held] of ordered) {
      const ready = yield* readyToSend(yield* rowOf(held.projectId), held);
      if (ready === null) {
        holds.delete(key);
        results.set(held.runKey, "dropped");
        continue;
      }
      const threadId = ready.target.threadId;
      // Timed out before the idle test: the re-check timer stops while the
      // host sleeps, so a hold can wake up hours old to an idle target.
      if (nowMs - held.sinceMs >= BUSY_HOLD_MS) {
        holds.delete(key);
        yield* record(held.projectId, held.scheduleId, held.runKey, {
          slot: held.slot,
          at: now,
          trigger: held.trigger,
          outcome: "missed",
          reason: "busy",
          threadId,
        });
        results.set(held.runKey, "missed");
        continue;
      }
      if (!served.has(threadId) && !busy.has(threadId)) {
        if (yield* isIdleForDelivery(threadId, now)) {
          served.add(threadId);
          holds.delete(key);
          results.set(held.runKey, yield* append(held, ready, now));
          continue;
        }
        busy.add(threadId);
      }
      holds.set(key, { ...held, waited: true });
    }
    return results;
  });

  const fire = Effect.fn("ScheduleRunner.fire")(function* (at: Date) {
    const zone = hostZone().zone;
    for (const row of yield* projects.listAll()) {
      const assistant = activeAssistant(row);
      if (assistant === null) continue;
      for (const schedule of assistant.schedules ?? []) {
        if (!schedule.enabled) continue;
        const slot = scheduleSlotAt(schedule.cron, zone, at);
        // Slots before the arming time never run, and a recorded slot ran.
        if (slot === null || slot.getTime() < Date.parse(schedule.updatedAt)) continue;
        const last = lastRunOf(assistant, schedule.id);
        if (last !== undefined && Date.parse(last.slot) >= slot.getTime()) continue;
        // The newest slot wins: a hold for this slot or a later one (a Run now) stays.
        const held = holds.get(holdKeyOf(row.projectId, schedule.id));
        if (held !== undefined && Date.parse(held.slot) >= slot.getTime()) continue;
        const slotIso = slot.toISOString();
        const runKey = cronRunKey(row.projectId, schedule.id, slotIso);
        const missed = (reason: "late" | "target-missing") =>
          nowIso.pipe(
            Effect.flatMap((now) =>
              record(row.projectId, schedule.id, runKey, {
                slot: slotIso,
                at: now,
                trigger: "cron",
                outcome: "missed",
                reason,
              }),
            ),
          );
        if (at.getTime() - slot.getTime() > LATE_LIMIT_MS) {
          yield* missed("late");
        } else if ((yield* liveThread(row.projectId, targetOf(assistant, schedule))) === null) {
          yield* missed("target-missing");
        } else {
          yield* hold({
            projectId: row.projectId,
            scheduleId: schedule.id,
            runKey,
            slot: slotIso,
            trigger: "cron",
          });
        }
      }
    }
    yield* release();
  });

  const runNowWork = Effect.fn("ScheduleRunner.runNow")(function* (
    projectId: ProjectId,
    scheduleId: string,
  ) {
    const row = Option.getOrNull(yield* projects.getById({ projectId }));
    const assistant = row?.deletedAt === null ? row.assistant : null;
    const schedule = assistant?.schedules?.find((entry) => entry.id === scheduleId);
    if (assistant == null || schedule === undefined) {
      return yield* new ScheduleUnavailableError({ reason: "unknown-schedule" });
    }
    if (assistant.archivedAt != null) {
      return yield* new ScheduleUnavailableError({ reason: "archived" });
    }
    const now = yield* nowIso;
    const runKey = manualRunKey(projectId, scheduleId, yield* crypto.randomUUIDv4);
    if ((yield* liveThread(projectId, targetOf(assistant, schedule))) === null) {
      yield* record(projectId, scheduleId, runKey, {
        slot: now,
        at: now,
        trigger: "manual",
        outcome: "missed",
        reason: "target-missing",
      });
      return { outcome: "missed", reason: "target-missing" } satisfies SchedulesRunResult;
    }
    yield* hold({ projectId, scheduleId, runKey, slot: now, trigger: "manual" });
    const result = (yield* release()).get(runKey);
    switch (result) {
      case undefined:
        return { outcome: "held" } satisfies SchedulesRunResult;
      case "sent":
        return { outcome: "sent" } satisfies SchedulesRunResult;
      case "missed":
        return { outcome: "missed", reason: "rejected" } satisfies SchedulesRunResult;
      case "dropped":
        return { outcome: "missed" } satisfies SchedulesRunResult;
    }
  });

  const watch = (projectId: ProjectId, scheduleId: string, run: ProjectScheduleRun) => {
    const key = holdKeyOf(projectId, scheduleId);
    if (run.outcome === "sent" && run.threadId !== undefined) {
      watched.set(key, { projectId, scheduleId, threadId: run.threadId, run });
    } else {
      watched.delete(key);
    }
  };

  const reloadWatched = Effect.gen(function* () {
    watched.clear();
    for (const row of yield* projects.listAll()) {
      if (row.deletedAt !== null || row.assistant == null) continue;
      for (const schedule of row.assistant.schedules ?? []) {
        const run = lastRunOf(row.assistant, schedule.id);
        if (run !== undefined) watch(row.projectId, schedule.id, run);
      }
    }
  });

  /** Re-records sent runs whose turn errored (`failed`) or never started (`missed: rejected`). */
  const checkOutcomes = Effect.fn("ScheduleRunner.checkOutcomes")(function* (
    threadId: ThreadId | null,
    reload: boolean,
  ) {
    if (reload) yield* reloadWatched;
    const nowMs = yield* Clock.currentTimeMillis;
    // A copy: the event subscriber updates `watched` while this pass waits on queries.
    for (const [key, entry] of Array.from(watched)) {
      if (threadId !== null && entry.threadId !== threadId) continue;
      if (nowMs - Date.parse(entry.run.at) > OUTCOME_WINDOW_MS) {
        watched.delete(key);
        continue;
      }
      // A cron run's id is known. After a crash between append and record,
      // its message is older than the run's `at`, so only Run now matches by time.
      const messageId =
        entry.run.trigger === "cron"
          ? scheduleMessageId(cronRunKey(entry.projectId, entry.scheduleId, entry.run.slot))
          : yield* queries.manualRunMessageId({
              threadId: entry.threadId,
              projectId: entry.projectId,
              scheduleId: entry.scheduleId,
              at: entry.run.at,
            });
      if (messageId === null) continue;
      const outcome = yield* queries.runOutcome({ threadId: entry.threadId, messageId });
      if (outcome === null) continue;
      const kept = {
        slot: entry.run.slot,
        at: entry.run.at,
        trigger: entry.run.trigger,
        threadId: entry.threadId,
      };
      watched.delete(key);
      yield* record(
        entry.projectId,
        entry.scheduleId,
        messageId.slice(SCHEDULE_MESSAGE_PREFIX.length),
        outcome.kind === "failed"
          ? { ...kept, outcome: "failed", turnId: outcome.turnId }
          : { ...kept, outcome: "missed", reason: "rejected" },
        true,
      );
    }
  });

  let releaseQueued = false;
  const handle = (work: Work): Effect.Effect<void> => {
    switch (work.kind) {
      case "fire":
        return fire(work.now).pipe(warnOnFailure("schedule fire failed", {}));
      case "run-now":
        return runNowWork(work.projectId, work.scheduleId).pipe(
          Effect.catch((error) => (isUnavailable(error) ? Effect.fail(error) : Effect.die(error))),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(work.reply, exit)),
          Effect.asVoid,
        );
      case "release":
        return Effect.suspend(() => {
          releaseQueued = false;
          return holds.size === 0 ? Effect.void : release();
        }).pipe(warnOnFailure("held schedule runs not released", {}));
      case "outcomes":
        return checkOutcomes(work.threadId, work.reload).pipe(
          warnOnFailure("schedule run outcomes not checked", { threadId: work.threadId }),
        );
    }
  };

  const worker = yield* makeDrainableWorker(handle);
  const enqueueRelease = Effect.suspend(() => {
    if (releaseQueued || holds.size === 0) return Effect.void;
    releaseQueued = true;
    return worker.enqueue({ kind: "release" });
  });
  const isWatchedThread = (threadId: ThreadId) =>
    [...watched.values()].some((entry) => entry.threadId === threadId);
  const hasHoldIn = (projectId: ProjectId) =>
    [...holds.values()].some((held) => held.projectId === projectId);

  /** Turn ends can free a held target and settle a sent run; the rest are rare. */
  const processEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.session-set": {
        const status = event.payload.session.status;
        if (status === "starting" || status === "running") return Effect.void;
        const threadId = event.payload.threadId;
        return Effect.andThen(
          enqueueRelease,
          isWatchedThread(threadId)
            ? worker.enqueue({ kind: "outcomes", threadId, reload: false })
            : Effect.void,
        );
      }
      case "thread.activity-appended":
        return event.payload.activity.kind === "provider.turn.start.failed" &&
          isWatchedThread(event.payload.threadId)
          ? worker.enqueue({ kind: "outcomes", threadId: event.payload.threadId, reload: false })
          : Effect.void;
      case "project.schedule-run-recorded":
        return Effect.sync(() =>
          watch(event.payload.projectId, event.payload.scheduleId, event.payload.run),
        );
      // A pause, edit, delete or archive drops the Project's held runs.
      case "project.meta-updated":
        return !isProjectReorderOnlyPayload(event.payload) && hasHoldIn(event.payload.projectId)
          ? enqueueRelease
          : Effect.void;
      case "project.deleted":
        return hasHoldIn(event.payload.projectId) ? enqueueRelease : Effect.void;
      default:
        return Effect.void;
    }
  };

  // Highest event sequence the subscriber has handled; -1 until it runs.
  const seenSequence = yield* SubscriptionRef.make(-1);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ScheduleRunner["Service"]["start"] = Effect.fn("ScheduleRunner.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    // After activation, so startup has settled orphaned turns first.
    yield* forkParked(
      Effect.gen(function* () {
        const head = yield* engine.latestSequence;
        yield* worker.enqueue({ kind: "outcomes", threadId: null, reload: true });
        yield* noteSeen(head);
        yield* Stream.runForEach(events, (event) =>
          processEvent(event).pipe(
            warnOnFailure("schedule runner skipped an event", { eventType: event.type }),
            Effect.andThen(noteSeen(event.sequence)),
          ),
        );
      }),
    );
    // Only re-tests runs a fire or Run now already made due.
    yield* forkParked(
      Effect.sleep(HOLD_RECHECK_MS).pipe(Effect.andThen(enqueueRelease), Effect.forever),
    );
    yield* forkParked(
      Effect.sleep(OUTCOME_SWEEP_MS).pipe(
        Effect.andThen(worker.enqueue({ kind: "outcomes", threadId: null, reload: true })),
        Effect.forever,
      ),
    );
  });

  const requestFire: ScheduleRunner["Service"]["requestFire"] = (now) =>
    worker.enqueue({ kind: "fire", now }).pipe(Effect.asVoid);

  const runNow: ScheduleRunner["Service"]["runNow"] = (projectId, scheduleId) =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<SchedulesRunResult, ScheduleUnavailableError>();
      yield* worker.enqueue({ kind: "run-now", projectId, scheduleId, reply });
      return yield* Deferred.await(reply);
    });

  const heldRuns: ScheduleRunner["Service"]["holds"] = (projectId) =>
    Effect.sync(() => {
      const held: Record<string, { readonly since: string }> = {};
      for (const entry of holds.values()) {
        if (entry.projectId === projectId) {
          held[entry.scheduleId] = { since: isoAt(entry.sinceMs) };
        }
      }
      return held;
    });

  // The worker's own dispatches can make more work, so drain until a pass
  // commits nothing new.
  const drain: ScheduleRunner["Service"]["drain"] = Effect.gen(function* () {
    while (true) {
      const target = yield* engine.latestSequence;
      yield* SubscriptionRef.changes(seenSequence).pipe(
        Stream.filter((seen) => seen >= target),
        Stream.runHead,
      );
      yield* worker.drain;
      if ((yield* engine.latestSequence) === target) return;
    }
  });

  return {
    start,
    requestFire,
    runNow,
    holds: heldRuns,
    drain,
  } satisfies ScheduleRunner["Service"];
});

export const layer = Layer.effect(ScheduleRunner, make).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionProjectRepositoryLive,
      ProjectionThreadRepositoryLive,
      ProjectionThreadSessionRepositoryLive,
      ProjectionTurnRepositoryLive,
    ),
  ),
);
