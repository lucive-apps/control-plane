/**
 * Operations on agents that run on linked machines: start, read, stop, send.
 * The MCP handlers call this for any agent the registry knows; the bridge
 * calls it to start queued sends. Fork-owned; see
 * docs/internals/multi-machine-agents.md.
 *
 * @module RemoteAgents
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AgentMachines, type HomeProject } from "./AgentMachines.ts";
import { PeerError, type PeerCommand } from "./AgentMachineClient.ts";
import { placeAgent, type PlacementDecision } from "./placement.ts";
import {
  isThreadBusy,
  remotePhase,
  remoteReadTurns,
  type PeerThreadView,
  type RemoteReadTurn,
} from "./remoteAgentState.ts";
import {
  RemoteAgentStore,
  type RemoteAgentRecord,
  type RemoteAgentRequest,
} from "./RemoteAgentStore.ts";
import type { AgentPhase } from "./agentPhase.ts";
import type { agentCreateIds } from "../orchestration/agentProtocol.ts";

export class RemoteAgentError extends Schema.TaggedError<RemoteAgentError>()("RemoteAgentError", {
  detail: Schema.String,
  /**
   * `create`: nothing reached the peer and the record is gone, so the caller may
   * place the agent elsewhere. `start`: the peer thread may exist; only a retry
   * with the same ids is safe.
   */
  stage: Schema.optional(Schema.Literals(["create", "start"])),
}) {
  override get message(): string {
    return this.detail;
  }
}

const REMOTE_SEND_PREFIX = "cp-remote-send:";

const unavailable = (label: string, error: PeerError) =>
  new RemoteAgentError({
    detail:
      error.kind === "unauthorized"
        ? `${label} refused this machine's token. Link it again in Settings > Connections > Agent machines.`
        : `Could not reach ${label}: ${error.detail}`,
  });

export interface PlanResult {
  readonly decision: PlacementDecision;
  readonly peerProjectId: string | null;
  readonly allowLocalFallback: boolean;
  /** The settings put every agent on this machine; nothing was probed. */
  readonly localOnly: boolean;
}

export interface CreateRemoteInput {
  readonly machineId: string;
  readonly machineLabel: string;
  readonly peerProjectId: string;
  readonly home: { readonly project: HomeProject; readonly label: string };
  readonly creator: { readonly id: string; readonly title: string };
  readonly ids: ReturnType<typeof agentCreateIds>;
  readonly threadId: string;
  readonly title: string;
  readonly message: string;
  readonly runtimeMode: RuntimeMode;
  /** The Project's default, else the coordinator's; the peer Project's default wins over it. */
  readonly baseModel: ModelSelection;
  /** An explicit `model`: the slug on the base instance. */
  readonly requestedModel: string | undefined;
  readonly createdAt: string;
}

export interface RemoteAgentsShape {
  /** Where the agent should run. Probes linked machines only when the settings could pick one. */
  readonly plan: (input: {
    readonly project: HomeProject;
    readonly requested: string | undefined;
  }) => Effect.Effect<PlanResult, RemoteAgentError>;
  /**
   * Writes the `pending` record, or returns the one a retry with the same ids
   * left. Cheap and local, so the caller does it under its create lock and
   * the record counts toward the running cap at once.
   */
  readonly reserve: (
    input: CreateRemoteInput,
  ) => Effect.Effect<
    { readonly record: RemoteAgentRecord; readonly existed: boolean },
    RemoteAgentError
  >;
  /** Sends the create and first message to the peer. Idempotent: a retry finishes what landed. */
  readonly start: (
    input: CreateRemoteInput,
    record: RemoteAgentRecord,
  ) => Effect.Effect<RemoteAgentRecord, RemoteAgentError>;
  readonly homeLabel: Effect.Effect<string>;
  readonly get: (threadId: string) => Effect.Effect<Option.Option<RemoteAgentRecord>>;
  /** Records in a Project whose id or title matches `ref`. */
  readonly find: (input: {
    readonly projectId: string;
    readonly ref: string;
  }) => Effect.Effect<ReadonlyArray<RemoteAgentRecord>>;
  readonly list: (
    projectId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly record: RemoteAgentRecord; readonly phase: AgentPhase }>
  >;
  /** Remote agents in the Project that count toward its running cap. */
  readonly openCount: (projectId: string) => Effect.Effect<number>;
  readonly read: (
    record: RemoteAgentRecord,
    turns: number,
  ) => Effect.Effect<
    { readonly phase: AgentPhase; readonly turns: ReadonlyArray<RemoteReadTurn> },
    RemoteAgentError
  >;
  readonly stop: (
    record: RemoteAgentRecord,
    options: { readonly archive: boolean },
  ) => Effect.Effect<{ readonly stopped: boolean; readonly archived: boolean }, RemoteAgentError>;
  /** Settles an idle remote agent on its machine, and archives it on request. */
  readonly settle: (
    record: RemoteAgentRecord,
    options: { readonly archive: boolean },
  ) => Effect.Effect<{ readonly archived: boolean }, RemoteAgentError>;
  /** Starts the message when the agent is idle, else queues it for the bridge. */
  readonly send: (
    record: RemoteAgentRecord,
    input: {
      readonly text: string;
      readonly sender: { readonly id: string; readonly title: string };
      readonly replyTo: string | null;
      readonly runtimeMode: RuntimeMode;
    },
  ) => Effect.Effect<{ readonly queued: boolean }, RemoteAgentError>;
  /** Starts the oldest queued send if the peer thread is idle. Used by the bridge. */
  readonly startQueued: (
    record: RemoteAgentRecord,
    view: PeerThreadView,
  ) => Effect.Effect<void, RemoteAgentError>;
}

export class RemoteAgents extends Context.Service<RemoteAgents, RemoteAgentsShape>()(
  "t3/agentMachines/RemoteAgents",
) {}

const isCounted = (record: RemoteAgentRecord): boolean =>
  record.state === "pending" || (record.state === "open" && record.inFlight !== null);

const make = Effect.gen(function* () {
  const machines = yield* AgentMachines;
  const store = yield* RemoteAgentStore;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const storeFailed = () => new RemoteAgentError({ detail: "Could not read the remote agents." });
  const list = store.list.pipe(Effect.orElseSucceed((): ReadonlyArray<RemoteAgentRecord> => []));

  const send = (command: PeerCommand, record: RemoteAgentRecord) =>
    machines.dispatch(record.machineId, command).pipe(
      Effect.tapError((error) =>
        error.kind === "unauthorized" ? machines.markNeedsRelink(record.machineId) : Effect.void,
      ),
      Effect.mapError((error) => unavailable(record.machineLabel, error)),
    );

  const startRequest = (
    record: RemoteAgentRecord,
    input: {
      readonly messageId: string;
      readonly text: string;
      readonly replyTo: string;
      readonly sender: { readonly id: string; readonly title: string };
      readonly baselineTurnId: string | null;
      readonly createdAt: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* send(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(input.messageId),
          threadId: ThreadId.make(record.threadId),
          message: {
            messageId: MessageId.make(input.messageId),
            role: "user",
            text: input.text,
            attachments: [],
            source: {
              kind: "agent",
              threadId: ThreadId.make(input.sender.id),
              threadTitle: input.sender.title,
            },
          },
          runtimeMode: record.runtimeMode,
          interactionMode: "default",
          createdAt: input.createdAt,
        },
        record,
      );
      const request: RemoteAgentRequest = {
        messageId: input.messageId,
        replyTo: input.replyTo,
        sentAt: input.createdAt,
        baselineTurnId: input.baselineTurnId,
        suppressed: false,
      };
      yield* store
        .update(record.threadId, (current) => ({
          ...current,
          state: "open",
          endedAt: null,
          inFlight: request,
          lastPhase: "starting",
        }))
        .pipe(Effect.mapError(storeFailed));
    });

  const plan: RemoteAgentsShape["plan"] = ({ project, requested }) =>
    Effect.gen(function* () {
      const inputs = yield* machines
        .placementInputs(project, { requested })
        .pipe(Effect.mapError((error) => new RemoteAgentError({ detail: error.detail })));
      const decision = placeAgent({
        settings: inputs.settings,
        requested,
        candidates: inputs.candidates,
      });
      return {
        decision,
        peerProjectId:
          decision.kind === "placed"
            ? (inputs.peerProjectIds.get(decision.machineId) ?? null)
            : null,
        allowLocalFallback: inputs.settings.allowLocalFallback,
        localOnly: inputs.localOnly,
      } satisfies PlanResult;
    });

  const reserve: RemoteAgentsShape["reserve"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* store.get(input.threadId).pipe(Effect.mapError(storeFailed));
      if (Option.isSome(existing)) return { record: existing.value, existed: true };
      const record: RemoteAgentRecord = {
        threadId: input.threadId,
        machineId: input.machineId,
        machineLabel: input.machineLabel,
        peerProjectId: input.peerProjectId,
        homeProjectId: input.home.project.id,
        title: input.title,
        creatorThreadId: input.creator.id,
        runtimeMode: input.runtimeMode,
        createdAt: input.createdAt,
        state: "pending",
        endedAt: null,
        inFlight: null,
        queuedSends: [],
        lastPhase: "starting",
        lastActivityAt: null,
      };
      yield* store.put(record).pipe(Effect.mapError(storeFailed));
      return { record, existed: false };
    });

  const start: RemoteAgentsShape["start"] = (input, record) =>
    Effect.gen(function* () {
      // A retry after a start that landed finds the request already in flight.
      if (record.state === "open" && record.inFlight !== null) return record;

      const peerShell = yield* machines.shell(record.machineId).pipe(
        Effect.mapError((error) => unavailable(record.machineLabel, error)),
        Effect.tapError(() => store.remove(record.threadId).pipe(Effect.ignore)),
        Effect.mapError((error) => new RemoteAgentError({ detail: error.detail, stage: "create" })),
      );
      const peerProject = peerShell.projects.find((entry) => entry.id === record.peerProjectId);
      const modelSelection: ModelSelection =
        input.requestedModel !== undefined
          ? { instanceId: input.baseModel.instanceId, model: input.requestedModel }
          : (peerProject?.defaultModelSelection ?? input.baseModel);

      yield* send(
        {
          type: "thread.create",
          commandId: CommandId.make(input.ids.createCommandId),
          threadId: ThreadId.make(record.threadId),
          projectId: ProjectId.make(record.peerProjectId),
          title: record.title,
          modelSelection,
          runtimeMode: record.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: input.createdAt,
        },
        record,
      ).pipe(
        // Nothing reached the peer: drop the record so a retry places afresh.
        Effect.tapError(() => store.remove(record.threadId).pipe(Effect.ignore)),
        Effect.mapError((error) => new RemoteAgentError({ detail: error.detail, stage: "create" })),
      );

      const preamble = `You are running on ${record.machineLabel} for the Project "${input.home.project.title}", started by ${input.creator.title} on ${input.home.label}. This machine has its own copy of the Project folder: read its AGENTS.md here, and your changes stay on this machine.\n\n`;
      yield* startRequest(record, {
        messageId: input.ids.messageId,
        text: `${preamble}${input.message}`,
        replyTo: input.creator.id,
        sender: input.creator,
        baselineTurnId: null,
        createdAt: input.createdAt,
      }).pipe(
        Effect.mapError((error) => new RemoteAgentError({ detail: error.detail, stage: "start" })),
      );
      return (yield* store.get(record.threadId).pipe(Effect.mapError(storeFailed))).pipe(
        Option.getOrElse(() => record),
      );
    });

  const readView = (record: RemoteAgentRecord, turnLimit: number) =>
    machines.thread(record.machineId, record.threadId, turnLimit).pipe(
      Effect.tapError((error) =>
        error.kind === "unauthorized" ? machines.markNeedsRelink(record.machineId) : Effect.void,
      ),
      Effect.mapError((error) => unavailable(record.machineLabel, error)),
    );

  const lostError = (record: RemoteAgentRecord) =>
    new RemoteAgentError({
      detail: `${record.title} is no longer on ${record.machineLabel}: the thread was deleted or archived there.`,
    });

  const viewOf = (thread: {
    readonly latestTurn: PeerThreadView["latestTurn"];
    readonly session: PeerThreadView["session"];
  }): PeerThreadView => ({
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: null,
  });

  const read: RemoteAgentsShape["read"] = (record, turns) =>
    Effect.gen(function* () {
      const detail = yield* readView(record, turns);
      if (Option.isNone(detail)) return yield* lostError(record);
      const thread = detail.value.thread;
      const view = viewOf(thread);
      const waiting =
        record.lastPhase === "waiting_for_approval" || record.lastPhase === "waiting_for_input";
      return {
        phase: waiting
          ? record.lastPhase
          : remotePhase({
              thread: view,
              reachable: true,
              requestPending:
                record.inFlight !== null &&
                view.latestTurn?.turnId === record.inFlight.baselineTurnId,
            }),
        turns: remoteReadTurns({
          messages: thread.messages,
          latestTurnState: thread.latestTurn?.state ?? null,
          limit: turns,
        }),
      };
    });

  const stop: RemoteAgentsShape["stop"] = (record, options) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const working = record.inFlight !== null && !record.inFlight.suppressed;
      const dropped = record.queuedSends.length;
      // Before the interrupt: the bridge must not push the cut-off request's result.
      yield* store
        .update(record.threadId, (current) => ({
          ...current,
          inFlight: current.inFlight === null ? null : { ...current.inFlight, suppressed: true },
          queuedSends: [],
        }))
        .pipe(Effect.mapError(storeFailed));
      const key = `${record.threadId}:${createdAt}`;
      if (working) {
        yield* send(
          {
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`cp-remote-stop:${key}`),
            threadId: ThreadId.make(record.threadId),
            createdAt,
          },
          record,
        );
      }
      yield* send(
        {
          type: "thread.session.stop",
          commandId: CommandId.make(`cp-remote-session-stop:${key}`),
          threadId: ThreadId.make(record.threadId),
          createdAt,
        },
        record,
      );
      if (options.archive) {
        yield* send(
          {
            type: "thread.archive",
            commandId: CommandId.make(`cp-remote-archive:${key}`),
            threadId: ThreadId.make(record.threadId),
          },
          record,
        );
        yield* store
          .update(record.threadId, (current) => ({
            ...current,
            state: "settled",
            endedAt: createdAt,
            inFlight: null,
          }))
          .pipe(Effect.mapError(storeFailed));
      } else {
        yield* store
          .update(record.threadId, (current) => ({ ...current, inFlight: null }))
          .pipe(Effect.mapError(storeFailed));
      }
      return { stopped: working || dropped > 0, archived: options.archive };
    });

  const settle: RemoteAgentsShape["settle"] = (record, options) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const key = `${record.threadId}:${createdAt}`;
      yield* send(
        {
          type: "thread.settle",
          commandId: CommandId.make(`cp-remote-settle:${key}`),
          threadId: ThreadId.make(record.threadId),
        },
        record,
      );
      if (options.archive) {
        yield* send(
          {
            type: "thread.archive",
            commandId: CommandId.make(`cp-remote-archive:${key}`),
            threadId: ThreadId.make(record.threadId),
          },
          record,
        );
      }
      yield* store
        .update(record.threadId, (current) => ({
          ...current,
          state: "settled",
          endedAt: createdAt,
          inFlight: null,
          queuedSends: [],
        }))
        .pipe(Effect.mapError(storeFailed));
      return { archived: options.archive };
    });

  const sendMessage: RemoteAgentsShape["send"] = (record, input) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const messageId = `${REMOTE_SEND_PREFIX}${record.threadId}:${createdAt}:${record.queuedSends.length}`;
      const detail = yield* readView(record, 1);
      if (Option.isNone(detail)) return yield* lostError(record);
      const view = viewOf(detail.value.thread);
      const busy = record.inFlight !== null || isThreadBusy(view);
      if (busy) {
        yield* store
          .update(record.threadId, (current) => ({
            ...current,
            queuedSends: [
              ...current.queuedSends,
              {
                messageId,
                text: input.text,
                replyTo: input.replyTo ?? input.sender.id,
                queuedAt: createdAt,
              },
            ],
          }))
          .pipe(Effect.mapError(storeFailed));
        return { queued: true };
      }
      yield* startRequest(record, {
        messageId,
        text: input.text,
        replyTo: input.replyTo ?? input.sender.id,
        sender: input.sender,
        baselineTurnId: view.latestTurn?.turnId ?? null,
        createdAt,
      });
      return { queued: false };
    });

  const startQueued: RemoteAgentsShape["startQueued"] = (record, view) =>
    Effect.gen(function* () {
      const next = record.queuedSends[0];
      if (next === undefined || record.inFlight !== null || isThreadBusy(view)) return;
      const createdAt = yield* nowIso;
      // Off the queue first: a failed start is retried by the sender, never doubled.
      yield* store
        .update(record.threadId, (current) => ({
          ...current,
          queuedSends: current.queuedSends.filter((entry) => entry.messageId !== next.messageId),
        }))
        .pipe(Effect.mapError(storeFailed));
      yield* startRequest(record, {
        messageId: next.messageId,
        text: next.text,
        replyTo: next.replyTo,
        sender: { id: next.replyTo, title: "Coordinator" },
        baselineTurnId: view.latestTurn?.turnId ?? null,
        createdAt,
      });
    });

  return {
    plan,
    homeLabel: machines.homeLabel,
    reserve,
    start,
    get: (threadId) =>
      store.get(threadId).pipe(Effect.orElseSucceed(() => Option.none<RemoteAgentRecord>())),
    find: ({ projectId, ref }) =>
      list.pipe(
        Effect.map((records) => {
          const trimmed = ref.trim();
          const byId = records.find((record) => record.threadId === trimmed);
          if (byId !== undefined) return [byId];
          return records.filter(
            (record) =>
              record.homeProjectId === projectId &&
              record.title.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0,
          );
        }),
      ),
    list: (projectId) =>
      Effect.gen(function* () {
        const records = (yield* list).filter((record) => record.homeProjectId === projectId);
        return yield* Effect.forEach(records, (record) =>
          machines.isReachable(record.machineId).pipe(
            Effect.map((reachable) => ({
              record,
              phase: reachable || record.state !== "open" ? record.lastPhase : ("stale" as const),
            })),
          ),
        );
      }),
    openCount: (projectId) =>
      list.pipe(
        Effect.map(
          (records) =>
            records.filter((record) => record.homeProjectId === projectId && isCounted(record))
              .length,
        ),
      ),
    read,
    stop,
    settle,
    send: sendMessage,
    startQueued,
  } satisfies RemoteAgentsShape;
});

export const RemoteAgentsLive = Layer.effect(RemoteAgents, make);
