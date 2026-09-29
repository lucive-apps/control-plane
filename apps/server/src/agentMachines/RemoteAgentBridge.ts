/**
 * Collects the results of agents running on linked machines. One poll per
 * machine reads its shell snapshot; a finished request is appended into the
 * home thread that asked for it, as a `cp-push:` message with the same id the
 * local reactor would use, and the reactor is nudged to start it. Command
 * receipts make each step idempotent across restarts. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module RemoteAgentBridge
 */
import {
  CommandId,
  MessageId,
  ThreadId,
  canManageAgent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import type * as Scope from "effect/Scope";

import { AgentCompletionReactor } from "../orchestration/AgentCompletionReactor.ts";
import { isOrchestrationCommandRejection } from "../orchestration/Errors.ts";
import { agentPushId, agentPushSettleId } from "../orchestration/agentProtocol.ts";
import { formatAgentResult, type AgentResultOutcome } from "../orchestration/agentPushes.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { AgentMachines } from "./AgentMachines.ts";
import { PeerError } from "./AgentMachineClient.ts";
import { RemoteAgents } from "./RemoteAgents.ts";
import {
  judgeRequest,
  remotePhase,
  remoteResultText,
  remoteStartFailureDetail,
  type PeerThreadView,
} from "./remoteAgentState.ts";
import { RemoteAgentStore, type RemoteAgentRecord } from "./RemoteAgentStore.ts";

export const BRIDGE_ACTIVE_INTERVAL = Duration.seconds(3);
export const BRIDGE_IDLE_INTERVAL = Duration.seconds(15);
const BACKOFF_MAX_MS = 60_000;
/** A machine unreachable this long loses its agents. */
export const REMOTE_LOST_AFTER_MS = 24 * 60 * 60 * 1000;
/** A record whose start never landed is dropped after this. */
const PENDING_LIMIT_MS = 2 * 60 * 1000;

export class RemoteAgentBridge extends Context.Service<
  RemoteAgentBridge,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every machine with open agents. Exposed for tests. */
    readonly pollOnce: Effect.Effect<void>;
  }
>()("t3/agentMachines/RemoteAgentBridge") {}

const isBusyRecord = (record: RemoteAgentRecord) =>
  record.state === "pending" || record.state === "open";

export const makeRemoteAgentBridge = Effect.gen(function* () {
  const machines = yield* AgentMachines;
  const remote = yield* RemoteAgents;
  const store = yield* RemoteAgentStore;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const reactor = yield* AgentCompletionReactor;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const toMs = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

  // Per machine: when it may be polled again, and since when it has been down.
  const nextPollAt = new Map<string, number>();
  const backoffMs = new Map<string, number>();
  const downSince = new Map<string, number>();

  const update = (
    record: RemoteAgentRecord,
    change: (current: RemoteAgentRecord) => RemoteAgentRecord,
  ) => store.update(record.threadId, change).pipe(Effect.ignore);

  const setPhase = (
    record: RemoteAgentRecord,
    phase: RemoteAgentRecord["lastPhase"],
    at: string | null,
  ) =>
    phase === record.lastPhase && at === null
      ? Effect.void
      : update(record, (current) => ({
          ...current,
          lastPhase: phase,
          lastActivityAt: at ?? current.lastActivityAt,
        }));

  /** The recipient the reactor would pick: the asker if live and allowed, else the coordinator. */
  const resolveRecipient = Effect.fn("RemoteAgentBridge.resolveRecipient")(function* (
    record: RemoteAgentRecord,
    replyTo: string,
  ) {
    const project = Option.getOrUndefined(
      yield* snapshots.getProjectShellById(record.homeProjectId as OrchestrationProjectShell["id"]),
    );
    const assistant = project?.assistant;
    // Archive holds everything; Unarchive delivers.
    if (project === undefined || assistant == null || assistant.archivedAt != null) return null;
    const coordinatorId = assistant.coordinatorThreadId;
    const recipient = Option.getOrNull(yield* snapshots.getThreadShellById(ThreadId.make(replyTo)));
    const usable =
      recipient !== null &&
      recipient.archivedAt === null &&
      recipient.projectId === project.id &&
      (recipient.id === coordinatorId ||
        canManageAgent(project, recipient, {
          id: ThreadId.make(record.threadId),
          projectId: project.id,
          pinnedAt: null,
          createdByThreadId: ThreadId.make(record.creatorThreadId),
        }));
    return { project, target: usable ? recipient.id : coordinatorId };
  });

  const deliver = Effect.fn("RemoteAgentBridge.deliver")(function* (
    record: RemoteAgentRecord,
    request: NonNullable<RemoteAgentRecord["inFlight"]>,
    outcome: AgentResultOutcome,
    text: string | null,
    idSuffix = "",
  ) {
    const resolved = yield* resolveRecipient(record, request.replyTo);
    // No live Project to deliver into: keep the request open and try again.
    if (resolved === null) return false;
    const createdAt = yield* nowIso;
    const pushId = `${agentPushId(record.threadId, request.messageId)}${idSuffix}`;
    const appended = yield* engine
      .dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(pushId),
        threadId: resolved.target,
        message: {
          messageId: MessageId.make(pushId),
          text: formatAgentResult({
            agentTitle: `${record.title} (on ${record.machineLabel})`,
            agentThreadId: record.threadId,
            outcome,
            text,
            questions: [],
          }),
          attachments: [],
          // No replyTo: a pushed turn never owes a result of its own.
          source: {
            kind: "agent",
            threadId: ThreadId.make(record.threadId),
            threadTitle: `${record.title} (on ${record.machineLabel})`,
          },
        },
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchIf(isOrchestrationCommandRejection, (error) =>
          Effect.logWarning("remote agent result append rejected", {
            agentThreadId: record.threadId,
            targetThreadId: resolved.target,
            detail: error.message,
          }).pipe(Effect.as(true)),
        ),
      );
    if (appended) yield* reactor.enqueueProject(resolved.project.id);
    return appended;
  });

  const finishRequest = Effect.fn("RemoteAgentBridge.finishRequest")(function* (
    record: RemoteAgentRecord,
    view: PeerThreadView,
    verdict: Extract<ReturnType<typeof judgeRequest>, { kind: "done" }>,
  ) {
    const request = record.inFlight;
    if (request === null) return;
    if (!request.suppressed) {
      let outcome = verdict.outcome;
      let text: string | null = null;
      const detail = yield* machines
        .thread(record.machineId, record.threadId, 2)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(detail)) {
        text = remoteResultText({
          messages: detail.value.thread.messages,
          requestMessageId: request.messageId,
        });
        if (verdict.startFailure) {
          const failure = remoteStartFailureDetail({
            activities: detail.value.thread.activities,
            requestMessageId: request.messageId,
          });
          outcome = { kind: "failed-to-start", detail: failure ?? view.session?.lastError ?? null };
        }
      } else if (verdict.startFailure) {
        outcome = { kind: "failed-to-start", detail: view.session?.lastError ?? null };
      }
      const delivered = yield* deliver(record, request, outcome, text);
      if (!delivered) return;
    }
    const latest = record.queuedSends.length === 0;
    yield* update(record, (current) => ({
      ...current,
      inFlight: null,
      lastPhase: verdict.outcome.kind === "finished" ? "completed" : "failed",
    }));
    // The peer has no `replyTo` to settle a one-off agent, so the home does it,
    // unless a later message is queued behind this one.
    if (latest) {
      const createdAt = yield* nowIso;
      yield* machines
        .dispatch(record.machineId, {
          type: "thread.settle",
          commandId: CommandId.make(agentPushSettleId(record.threadId, request.messageId)),
          threadId: ThreadId.make(record.threadId),
        })
        .pipe(Effect.ignore);
      yield* update(record, (current) => ({ ...current, state: "settled", endedAt: createdAt }));
    }
  });

  const markLost = Effect.fn("RemoteAgentBridge.markLost")(function* (
    record: RemoteAgentRecord,
    reason: string,
  ) {
    const createdAt = yield* nowIso;
    const request = record.inFlight;
    if (request !== null && !request.suppressed) {
      // Its own id: a real result that arrives if the machine returns still lands.
      yield* deliver(record, request, { kind: "failed", lastError: reason }, null, ":lost");
    }
    yield* update(record, (current) => ({
      ...current,
      state: "lost",
      endedAt: createdAt,
      inFlight: null,
      queuedSends: [],
      lastPhase: "failed",
    }));
  });

  const pollMachine = Effect.fn("RemoteAgentBridge.pollMachine")(function* (
    machineId: string,
    records: ReadonlyArray<RemoteAgentRecord>,
  ) {
    const now = yield* nowMs;
    if ((nextPollAt.get(machineId) ?? 0) > now) return;
    const snapshot = yield* Effect.result(machines.shell(machineId, { fresh: true }));
    if (snapshot._tag === "Failure") {
      const error: PeerError = snapshot.failure;
      if (error.kind === "unauthorized") {
        // Hold: a machine that needs a fresh link does not fail healthy agents.
        nextPollAt.set(machineId, now + BACKOFF_MAX_MS);
        return;
      }
      const wait = Math.min((backoffMs.get(machineId) ?? 3_000) * 2, BACKOFF_MAX_MS);
      backoffMs.set(machineId, wait);
      nextPollAt.set(machineId, now + wait);
      const since = downSince.get(machineId) ?? now;
      downSince.set(machineId, since);
      for (const record of records) {
        yield* setPhase(record, "stale", null);
        if (now - since >= REMOTE_LOST_AFTER_MS) {
          yield* markLost(record, `${record.machineLabel} has been unreachable for 24 hours.`);
        }
      }
      return;
    }
    backoffMs.delete(machineId);
    downSince.delete(machineId);
    nextPollAt.delete(machineId);

    for (const record of records) {
      const thread: OrchestrationThreadShell | undefined = snapshot.success.threads.find(
        (candidate) => candidate.id === record.threadId && candidate.archivedAt === null,
      );
      const age = now - toMs(record.createdAt);
      if (thread === undefined) {
        if (record.state === "pending" && age < PENDING_LIMIT_MS) continue;
        yield* markLost(record, `${record.title} is gone from ${record.machineLabel}.`);
        continue;
      }
      if (record.state === "pending" && record.inFlight === null) {
        // The start never landed and no retry finished it.
        if (age >= PENDING_LIMIT_MS) yield* markLost(record, "The agent never started.");
        continue;
      }
      const request = record.inFlight;
      const verdict =
        request === null
          ? null
          : judgeRequest({
              baselineTurnId: request.baselineTurnId,
              thread,
              sentAgeMs: now - toMs(request.sentAt),
            });
      yield* setPhase(
        record,
        remotePhase({
          thread,
          reachable: true,
          requestPending: verdict !== null && verdict.kind === "waiting",
        }),
        thread.updatedAt,
      );
      if (verdict?.kind === "done") {
        yield* finishRequest(record, thread, verdict);
        continue;
      }
      if (request === null && record.queuedSends.length > 0) {
        yield* remote.startQueued(record, thread).pipe(
          Effect.catch((error) =>
            Effect.logWarning("queued send to a remote agent was not started", {
              agentThreadId: record.threadId,
              detail: error.detail,
            }),
          ),
        );
      }
    }
  });

  const pollOnce = Effect.gen(function* () {
    const open = (yield* store.list).filter(isBusyRecord);
    const byMachine = Map.groupBy(open, (record) => record.machineId);
    yield* Effect.forEach(
      [...byMachine],
      ([machineId, records]) =>
        pollMachine(machineId, records).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("remote agent poll failed", { machineId, cause: String(cause) }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("remote agent bridge pass failed", { cause: String(cause) }),
    ),
  );

  const loop = Effect.gen(function* () {
    while (true) {
      yield* pollOnce;
      const any = (yield* store.list.pipe(Effect.orElseSucceed(() => []))).some(isBusyRecord);
      const base = any ? BRIDGE_ACTIVE_INTERVAL : BRIDGE_IDLE_INTERVAL;
      // Jitter, so several homes do not poll a machine in step.
      const jitter = yield* Random.next;
      yield* Effect.sleep(Duration.millis(Duration.toMillis(base) * (0.8 + jitter * 0.4)));
    }
  });

  return {
    start: () => forkParked(loop),
    pollOnce,
  } satisfies Context.Service.Shape<typeof RemoteAgentBridge>;
});

/** Starts polling when built, parked behind server activation like the reactors. */
export const RemoteAgentBridgeLive = Layer.effect(
  RemoteAgentBridge,
  Effect.gen(function* () {
    const bridge = yield* makeRemoteAgentBridge;
    yield* bridge.start();
    return bridge;
  }),
);
