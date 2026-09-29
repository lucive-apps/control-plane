/**
 * AgentCompletionReactor - delivers each agent request's result to the thread
 * that asked for it. Fork-owned.
 *
 * A pass over a Project has two phases:
 * 1. Every finished request whose result is still owed is appended into its
 *    recipient at once (frozen when the agent finished), and a one-off agent
 *    settles. A request that ended with no reply, and was answered by a later
 *    turn no message started, owes that reply once more.
 * 2. Each idle thread starts its oldest appended delivery: a pushed result, a
 *    `cp_thread_send` that was held for it, or a Project schedule's prompt.
 *    Pushes pause after a budget until the user, a manager or a schedule
 *    starts a turn in the recipient.
 *
 * Receipts are the ledger (see `agentProtocol.ts`), so a pass is idempotent
 * and a restart recomputes what is owed. There are no timers: a pass runs when
 * an event can change the answer.
 *
 * @module AgentCompletionReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  canManageAgent,
  isScheduleMessageId,
  type OrchestrationEvent,
  type OrchestrationThreadActivityTone,
  type ProjectAssistant,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { forkParked } from "../serverActivation.ts";
import { AgentLineage } from "./agentLineage.ts";
import {
  AGENT_PUSH_BUDGET,
  AGENT_SEND_MESSAGE_PREFIX,
  agentDeliveryRetryId,
  agentDeliveryStartId,
  agentPushFailedId,
  agentPushId,
  agentPushPausedId,
  agentPushSettleId,
} from "./agentProtocol.ts";
import {
  formatAgentResult,
  isBudgetedPush,
  isDeliveryIdle,
  makeAgentPushQueries,
  openMessageQuestions,
  type AgentDelivery,
  type OwedResult,
} from "./agentPushes.ts";
import { isOrchestrationCommandRejection } from "./Errors.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export class AgentCompletionReactor extends Context.Service<
  AgentCompletionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every event committed so far has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/AgentCompletionReactor") {}

interface ActiveProject {
  readonly id: ProjectId;
  readonly assistant: ProjectAssistant;
}

/** Log and continue, so one bad request or recipient never blocks the rest. */
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

const managedThread = (thread: ProjectionThread) => ({
  id: thread.threadId,
  projectId: thread.projectId,
  pinnedAt: thread.pinnedAt,
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  const sessions = yield* ProjectionThreadSessionRepository;
  const turns = yield* ProjectionTurnRepository;
  const activities = yield* ProjectionThreadActivityRepository;
  const lineage = yield* AgentLineage;
  const queries = makeAgentPushQueries(yield* SqlClient.SqlClient);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const getThread = (threadId: ThreadId) =>
    threads.getById({ threadId }).pipe(Effect.map(Option.getOrNull));

  const appendActivity = (input: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly tone: OrchestrationThreadActivityTone;
    readonly kind: string;
    readonly summary: string;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(input.id),
      threadId: input.threadId,
      activity: {
        id: EventId.make(input.id),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: { detail: input.detail },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  /** The recipient if it can still take the result, else the coordinator. */
  const resolveTarget = Effect.fn("AgentCompletionReactor.resolveTarget")(function* (
    project: ActiveProject,
    agent: ProjectionThread,
    replyTo: ThreadId,
  ) {
    const coordinatorId = project.assistant.coordinatorThreadId;
    const recipient = yield* getThread(replyTo);
    if (
      recipient === null ||
      recipient.deletedAt !== null ||
      recipient.archivedAt !== null ||
      recipient.projectId !== project.id
    ) {
      return coordinatorId;
    }
    if (replyTo === coordinatorId) return replyTo;
    const createdByThreadId = yield* lineage.creatorOf(agent.threadId);
    return canManageAgent(project, managedThread(recipient), {
      ...managedThread(agent),
      createdByThreadId,
    })
      ? replyTo
      : coordinatorId;
  });

  const deliverResult = Effect.fn("AgentCompletionReactor.deliverResult")(function* (
    project: ActiveProject,
    owed: OwedResult,
  ) {
    const { agentThreadId, requestId } = owed;
    const [agent, result] = yield* Effect.all([
      getThread(agentThreadId),
      queries.readAgentResult({ agentThreadId, requestId }),
    ]);
    if (agent === null || result === null) return;
    const pushId = agentPushId(agentThreadId, requestId);
    const createdAt = yield* nowIso;
    const target = yield* resolveTarget(project, agent, owed.replyTo);
    if (target === agentThreadId) {
      // Set as coordinator promoted the agent, so the result has nowhere to go.
      // The activity takes the push id, which marks the request handled.
      yield* appendActivity({
        id: pushId,
        threadId: agentThreadId,
        tone: "info",
        kind: "agent-results.undelivered",
        summary: "Result not delivered",
        detail:
          "This thread became the coordinator, so its result for an earlier request was not sent.",
        createdAt,
      });
      return;
    }
    const questions = openMessageQuestions(
      yield* activities.listUserInputLifecycleByThreadId({ threadId: agentThreadId }),
    );
    const appended = yield* engine
      .dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(pushId),
        threadId: target,
        message: {
          messageId: MessageId.make(pushId),
          text: formatAgentResult({
            agentTitle: agent.title,
            agentThreadId,
            outcome: result.outcome,
            text: result.text,
            questions,
          }),
          attachments: [],
          // No replyTo: a pushed turn never owes a result of its own.
          source: {
            kind: "agent",
            threadId: agentThreadId,
            ...(agent.title.trim().length > 0 ? { threadTitle: agent.title } : {}),
          },
        },
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchIf(isOrchestrationCommandRejection, (error) =>
          Effect.logWarning("agent result append rejected", {
            agentThreadId,
            requestId,
            targetThreadId: target,
            detail: error.message,
          }).pipe(
            Effect.andThen(
              appendActivity({
                id: agentPushFailedId(agentThreadId, requestId),
                threadId: agentThreadId,
                tone: "error",
                kind: "agent-results.undelivered",
                summary: "Result not delivered",
                detail: error.message,
                createdAt,
              }),
            ),
            Effect.as(false),
          ),
        ),
      );
    // A later message to the agent is new work, so it stays unsettled.
    if (!appended || agent.pinnedAt !== null || !result.isLatestRequest) return;
    yield* engine
      .dispatch({
        type: "thread.settle",
        commandId: CommandId.make(agentPushSettleId(agentThreadId, requestId)),
        threadId: agentThreadId,
      })
      .pipe(
        Effect.catchIf(isOrchestrationCommandRejection, (error) =>
          Effect.logDebug("agent not settled after its result", {
            agentThreadId,
            detail: error.message,
          }),
        ),
      );
  });

  const startDelivery = (delivery: AgentDelivery, commandId: string, createdAt: string) =>
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(commandId),
      threadId: delivery.threadId,
      // The decider reuses the appended message; this copy is not stored again.
      message: {
        messageId: delivery.messageId,
        role: "user",
        text: delivery.text,
        attachments: [],
        ...(delivery.source !== null ? { source: delivery.source } : {}),
      },
      runtimeMode: delivery.runtimeMode,
      interactionMode: delivery.interactionMode,
      createdAt,
    });

  const notifyPaused = Effect.fn("AgentCompletionReactor.notifyPaused")(function* (
    coordinatorId: ThreadId | null,
    recipientId: ThreadId,
    releaseMessageId: string | null,
    createdAt: string,
  ) {
    const recipient = yield* getThread(recipientId);
    if (recipient === null) return;
    // Ids are per release, so a paused recipient is told once until released.
    yield* appendActivity({
      id: agentPushPausedId(recipientId, recipientId, releaseMessageId),
      threadId: recipientId,
      tone: "info",
      kind: "agent-results.paused",
      summary: "Agent results paused",
      detail: `Agent results paused after ${AGENT_PUSH_BUDGET} in a row. The rest start after your next message here.`,
      createdAt,
    });
    if (coordinatorId === null || recipientId === coordinatorId) return;
    yield* appendActivity({
      id: agentPushPausedId(coordinatorId, recipientId, releaseMessageId),
      threadId: coordinatorId,
      tone: "info",
      kind: "agent-results.paused",
      summary: "Agent results paused",
      detail: `Results for ${recipient.title} paused after ${AGENT_PUSH_BUDGET} in a row. Message ${recipient.title} to continue.`,
      createdAt,
    });
  });

  /** Starts at most one delivery, and only into an idle thread. */
  const startNextDelivery = Effect.fn("AgentCompletionReactor.startNextDelivery")(function* (
    coordinatorId: ThreadId | null,
    recipientId: ThreadId,
    deliveries: ReadonlyArray<AgentDelivery>,
  ) {
    const createdAt = yield* nowIso;
    const [session, pendingStart] = yield* Effect.all([
      sessions.getByThreadId({ threadId: recipientId }),
      turns.getPendingTurnStartByThreadId({ threadId: recipientId }),
    ]);
    if (!isDeliveryIdle(Option.getOrNull(session), Option.getOrNull(pendingStart), createdAt)) {
      return;
    }
    const retry = deliveries.find((delivery) => delivery.started);
    if (retry !== undefined) {
      return yield* startDelivery(retry, agentDeliveryRetryId(retry.messageId), createdAt);
    }
    const head = deliveries[0];
    if (head === undefined) return;
    if (isBudgetedPush(head.messageId)) {
      const budget = yield* queries.pushBudget(recipientId);
      if (budget.pushedSinceRelease >= AGENT_PUSH_BUDGET) {
        yield* notifyPaused(coordinatorId, recipientId, budget.releaseMessageId, createdAt);
        // A held send or scheduled prompt still starts, and releases the pause.
        const unbudgeted = deliveries.find((delivery) => !isBudgetedPush(delivery.messageId));
        if (unbudgeted !== undefined) {
          yield* startDelivery(unbudgeted, agentDeliveryStartId(unbudgeted.messageId), createdAt);
        }
        return;
      }
    }
    yield* startDelivery(head, agentDeliveryStartId(head.messageId), createdAt);
  });

  const processProject = Effect.fn("AgentCompletionReactor.processProject")(function* (
    projectId: ProjectId,
  ) {
    const row = Option.getOrNull(yield* projects.getById({ projectId }));
    if (row === null || row.deletedAt !== null) return;
    const assistant = row.assistant;
    // Archive holds everything; Unarchive delivers.
    if (assistant?.archivedAt != null) return;
    if (assistant != null) {
      const project: ActiveProject = { id: projectId, assistant };
      for (const owed of yield* queries.listOwedResults(projectId)) {
        yield* deliverResult(project, owed).pipe(
          warnOnFailure("agent result not delivered", {
            agentThreadId: owed.agentThreadId,
            requestId: owed.requestId,
          }),
        );
      }
      // After the requests: a continuation is owed only once its request's own
      // (empty) result is appended.
      for (const owed of yield* queries.listOwedContinuations(projectId)) {
        yield* deliverResult(project, owed).pipe(
          warnOnFailure("agent continuation result not delivered", {
            agentThreadId: owed.agentThreadId,
            requestId: owed.requestId,
          }),
        );
      }
    }
    // Without a marker (Move to Tasks) nothing new is owed, but what was
    // already held still starts, so a queued send is never stranded.
    const coordinatorId = assistant?.coordinatorThreadId ?? null;
    const deliveries = yield* queries.listDeliveries(projectId);
    for (const [recipientId, pending] of Map.groupBy(deliveries, (delivery) => delivery.threadId)) {
      yield* startNextDelivery(coordinatorId, recipientId, pending).pipe(
        warnOnFailure("agent delivery not started", { threadId: recipientId }),
      );
    }
  });

  // Project ids with a pass queued but not begun. That pass reads everything
  // after it begins, so it covers later events for the same Project too.
  const queued = new Set<ProjectId>();
  const worker = yield* makeDrainableWorker((projectId: ProjectId) =>
    Effect.sync(() => queued.delete(projectId)).pipe(
      Effect.andThen(processProject(projectId)),
      warnOnFailure("agent result pass failed", { projectId }),
    ),
  );
  const enqueue = (projectId: ProjectId) =>
    Effect.suspend(() => {
      if (queued.has(projectId)) return Effect.void;
      queued.add(projectId);
      return worker.enqueue(projectId);
    });

  /**
   * Queues a pass for the Project of `threadId`, resolving archived and
   * deleted threads too: their Project still decides. A plain workspace only
   * runs when `always`, or when this thread still holds a delivery.
   */
  const enqueueThreadProject = (threadId: ThreadId, always: boolean) =>
    Effect.gen(function* () {
      const thread = Option.getOrNull(yield* threads.getById({ threadId }));
      if (thread === null) return;
      const project = Option.getOrNull(yield* projects.getById({ projectId: thread.projectId }));
      if (project === null || project.deletedAt !== null) return;
      if (project.assistant != null || always || (yield* queries.hasHeldDelivery(threadId))) {
        yield* enqueue(thread.projectId);
      }
    });

  /** The events that can make a result owed or a thread idle for delivery. */
  const processEvent = (event: OrchestrationEvent) => {
    if (event.metadata.historyImport === true) return Effect.void;
    switch (event.type) {
      // Turn ends are frequent, so a plain workspace checks for a held delivery
      // first; the rest are rare.
      case "thread.session-set":
        return event.payload.session.status === "starting" ||
          event.payload.session.status === "running"
          ? Effect.void
          : enqueueThreadProject(event.payload.threadId, false);
      case "thread.message-sent":
        return event.payload.messageId.startsWith(AGENT_SEND_MESSAGE_PREFIX) ||
          isScheduleMessageId(event.payload.messageId)
          ? enqueueThreadProject(event.payload.threadId, true)
          : Effect.void;
      case "thread.activity-appended":
        return event.payload.activity.kind === "provider.turn.start.failed"
          ? enqueueThreadProject(event.payload.threadId, true)
          : Effect.void;
      case "thread.unarchived":
        return enqueueThreadProject(event.payload.threadId, true);
      // Unarchive, Set as coordinator, and Move to Tasks (a null marker).
      case "project.meta-updated":
        return event.payload.assistant !== undefined
          ? enqueue(event.payload.projectId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  // Highest event sequence the subscriber has handled; -1 until it runs.
  const seenSequence = yield* SubscriptionRef.make(-1);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: AgentCompletionReactor["Service"]["start"] = Effect.fn(
    "AgentCompletionReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    // After activation, so startup has settled orphaned sessions before the
    // first pass. Events that arrive meanwhile wait in the subscription.
    yield* forkParked(
      Effect.gen(function* () {
        const head = yield* engine.latestSequence;
        yield* Effect.gen(function* () {
          const rows = yield* projects.listAll();
          const withMarker = rows.filter((row) => row.deletedAt === null && row.assistant != null);
          const withHeld = yield* queries.listProjectsWithHeldDeliveries();
          yield* Effect.forEach([...withMarker.map((row) => row.projectId), ...withHeld], enqueue, {
            discard: true,
          });
        }).pipe(warnOnFailure("agent result startup pass skipped", {}));
        yield* noteSeen(head);
        yield* Stream.runForEach(events, (event) =>
          processEvent(event).pipe(
            warnOnFailure("agent completion reactor skipped an event", {
              eventType: event.type,
            }),
            Effect.andThen(noteSeen(event.sequence)),
          ),
        );
      }),
    );
  });

  // The worker's own dispatches can make more work, so drain until a pass
  // commits nothing new.
  const drain: AgentCompletionReactor["Service"]["drain"] = Effect.gen(function* () {
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

  return { start, drain } satisfies AgentCompletionReactor["Service"];
});

const RepositoriesLive = Layer.mergeAll(
  ProjectionProjectRepositoryLive,
  ProjectionThreadRepositoryLive,
  ProjectionThreadSessionRepositoryLive,
  ProjectionTurnRepositoryLive,
  ProjectionThreadActivityRepositoryLive,
);

/** Needs `AgentLineage`; tests provide a stub. */
export const layerWithoutLineage = Layer.effect(AgentCompletionReactor, make).pipe(
  Layer.provide(RepositoriesLive),
);

export const layer = layerWithoutLineage.pipe(Layer.provide(AgentLineage.layer));
