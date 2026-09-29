import {
  agentManagerRole,
  canManageAgent,
  CommandId,
  EventId,
  isRunningAgent,
  isStandingAgent,
  LOCAL_AGENT_MACHINE,
  MessageId,
  type AgentManagerRole,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { McpServer } from "effect/unstable/ai";

import { type RemoteAgentRecord } from "../../../agentMachines/RemoteAgentStore.ts";
import { RemoteAgentError, RemoteAgents } from "../../../agentMachines/RemoteAgents.ts";
import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import {
  AGENT_RUNNING_CAP,
  agentCreateIds,
  agentDeliveryStartId,
  agentStopId,
} from "../../../orchestration/agentProtocol.ts";
import {
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationThreadSettleBlockedError,
} from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../../../orchestration/ThreadSettlementPolicy.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  agentRefCandidates,
  agentRequestTurns,
  agentThreadIdFromDigest,
  capAgentReadTurns,
  hasPendingTurnStart,
  heldRequestIds,
  inFlightRequestId,
  isAgentCountedRunning,
  resolveAgentModel,
  resolveAgentRef,
  stricterRuntimeMode,
} from "./agentScope.ts";
import { makeScheduleHandlers } from "./scheduleHandlers.ts";
import {
  AgentAmbiguousError,
  AgentBusyError,
  AgentNotFoundError,
  AgentsToolkit,
  AgentsUnavailableError,
  AgentToolFailedError,
  ClientRequestIdConflictError,
  ConcurrencyLimitError,
  NotYourAgentError,
  SettleCoordinatorOnlyError,
  StandingAgentNotAllowedError,
  UnknownModelError,
  type AgentPhase,
} from "./tools.ts";

interface Manager {
  readonly invocation: McpInvocationContext.McpInvocationScope;
  readonly caller: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly role: AgentManagerRole;
}

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read this Project's threads.", cause });

const START_FAILED = "Could not start the agent.";
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const isSettleBlocked = Schema.is(OrchestrationThreadSettleBlockedError);

/** Keeps interrupts as interrupts; any other dispatch failure becomes a tool error. */
const dispatchFailed =
  (detail: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new AgentToolFailedError({ detail, cause }));

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const lineage = yield* AgentLineage;
  const turnRows = yield* ProjectionTurnRepository;
  const messageRows = yield* ProjectionThreadMessageRepository;
  const crypto = yield* Crypto.Crypto;
  // Serializes creates so two calls cannot both pass the running cap.
  const createLock = yield* Semaphore.make(1);
  const scheduleHandlers = yield* makeScheduleHandlers;
  const remote = yield* RemoteAgents;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const dispatch = (command: OrchestrationCommand, detail: string) =>
    engine.dispatch(command).pipe(Effect.catchCause(dispatchFailed(detail)));

  /**
   * Dispatches a create step. With a clientRequestId the ids repeat, so a step
   * the engine rejected once is rejected on every retry: the caller needs a new id.
   */
  const dispatchCreateStep = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.findErrorOption(cause);
        return Option.isSome(error) && isPreviouslyRejected(error.value)
          ? Effect.fail(
              new AgentToolFailedError({
                detail: `${START_FAILED} An earlier call with this clientRequestId was rejected (${error.value.detail}). Use a new clientRequestId.`,
                cause: error.value,
              }),
            )
          : dispatchFailed(START_FAILED)(cause);
      }),
    );

  /** Fails when the Project's agents, the coordinator aside, already fill the running cap. */
  const requireFreeSlot = Effect.fn("AgentsToolkit.requireFreeSlot")(function* (
    manager: Manager,
    now: string,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
    const running = snapshot.threads.filter(
      (thread) =>
        thread.projectId === manager.project.id &&
        thread.id !== manager.project.assistant?.coordinatorThreadId &&
        isAgentCountedRunning(thread, now),
    ).length;
    // Agents on linked machines share the Project's cap.
    const total = running + (yield* remote.openCount(manager.project.id));
    if (total >= AGENT_RUNNING_CAP) {
      return yield* new ConcurrencyLimitError({ limit: AGENT_RUNNING_CAP, running: total });
    }
  });

  /**
   * The capability is minted at session start; the role is checked live, so a
   * caller demoted (Unpin, Set as coordinator) or archived mid-session is refused.
   */
  const requireManager = Effect.fn("AgentsToolkit.requireManager")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) return yield* new AgentsUnavailableError();
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(project)) return yield* new AgentsUnavailableError();
    const role = agentManagerRole(project.value, caller.value);
    if (role === null) return yield* new AgentsUnavailableError();
    return { invocation, caller: caller.value, project: project.value, role } satisfies Manager;
  });

  /**
   * Whether `manager` manages each of `threads`. Creators are read only for a
   * standing manager, and only for threads it could have created: each read
   * walks that thread's event stream, so callers narrow `threads` first.
   */
  const managesThread = Effect.fn("AgentsToolkit.managesThread")(function* (
    manager: Manager,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    const creators = new Map<ThreadId, ThreadId | null>();
    if (manager.role === "standing") {
      for (const thread of threads) {
        if (
          thread.projectId === manager.project.id &&
          thread.pinnedAt == null &&
          thread.id !== manager.caller.id &&
          thread.id !== manager.project.assistant?.coordinatorThreadId
        ) {
          creators.set(
            thread.id,
            yield* lineage.creatorOf(thread.id).pipe(Effect.mapError(readFailed)),
          );
        }
      }
    }
    return (thread: OrchestrationThreadShell) =>
      canManageAgent(manager.project, manager.caller, {
        ...thread,
        createdByThreadId: creators.get(thread.id) ?? null,
      });
  });

  const remoteAsManaged = (manager: Manager, record: RemoteAgentRecord) => ({
    id: ThreadId.make(record.threadId),
    projectId: manager.project.id,
    pinnedAt: null,
    createdByThreadId: ThreadId.make(record.creatorThreadId),
  });

  /**
   * An agent a tool names: a local thread, or one the registry knows on a
   * linked machine. Local wins a title unless a remote agent the caller manages
   * has the same title too, which is ambiguous like two local ones.
   */
  const requireTarget = Effect.fn("AgentsToolkit.requireTarget")(function* (
    manager: Manager,
    ref: string,
  ) {
    const found = yield* remote.find({ projectId: manager.project.id, ref });
    const managed = found.filter(
      (record) =>
        record.homeProjectId === manager.project.id &&
        canManageAgent(manager.project, manager.caller, remoteAsManaged(manager, record)),
    );
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
    const candidates = agentRefCandidates(ref, {
      threads: snapshot.threads,
      projectId: manager.project.id,
    });
    const byRemoteId = found.find((record) => record.threadId === ref.trim());
    if (byRemoteId !== undefined) {
      return managed.includes(byRemoteId)
        ? ({ kind: "remote", record: byRemoteId } as const)
        : yield* new NotYourAgentError({ agent: ref });
    }
    const canManage = yield* managesThread(manager, candidates);
    const resolved = resolveAgentRef(ref, {
      threads: candidates,
      projectId: manager.project.id,
      canManage,
    });
    switch (resolved.kind) {
      case "found":
        return managed.length > 0
          ? yield* new AgentAmbiguousError({ agent: ref })
          : ({ kind: "local", thread: resolved.thread } as const);
      case "ambiguous":
        return yield* new AgentAmbiguousError({ agent: ref });
      case "not-yours":
      case "not-found":
        if (managed.length === 1) return { kind: "remote", record: managed[0]! } as const;
        if (managed.length > 1) return yield* new AgentAmbiguousError({ agent: ref });
        if (resolved.kind === "not-yours" || found.length > 0) {
          return yield* new NotYourAgentError({ agent: ref });
        }
        return yield* new AgentNotFoundError({ agent: ref });
    }
  });

  const toolFailed = (error: RemoteAgentError) =>
    new AgentToolFailedError({ detail: error.detail });

  /** The Project's coordinator, or the caller when it is the coordinator or the thread is gone. */
  const resolveCoordinator = Effect.fn("AgentsToolkit.resolveCoordinator")(function* (
    manager: Manager,
  ) {
    const coordinatorId = manager.project.assistant?.coordinatorThreadId;
    if (manager.role === "coordinator" || coordinatorId === undefined) return manager.caller;
    return Option.getOrElse(
      yield* snapshots.getThreadShellById(coordinatorId).pipe(Effect.mapError(readFailed)),
      () => manager.caller,
    );
  });

  /** A first message no turn has adopted yet reads as starting: the cap already counts it. */
  const phaseOf = (manager: Manager, thread: OrchestrationThreadShell, now: string): AgentPhase => {
    const phase = projectThreadAwareness({
      environmentId: manager.invocation.environmentId,
      project: manager.project,
      thread,
    })?.phase;
    const busy =
      phase === "starting" ||
      phase === "running" ||
      phase === "waiting_for_approval" ||
      phase === "waiting_for_input";
    if (!busy && threadHasQueuedTurnStart(thread, now)) return "starting";
    return phase ?? "idle";
  };

  /**
   * Pins a standing agent, then sends its first message. Both ids are derived
   * from the create's, so a retry that repeats a step the engine already
   * accepted gets the same receipt back instead of a duplicate.
   */
  const pinAndStart = (input: {
    readonly manager: Manager;
    readonly ids: ReturnType<typeof agentCreateIds>;
    readonly threadId: ThreadId;
    readonly pin: boolean;
    readonly message: string;
    readonly runtimeMode: RuntimeMode;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const { caller } = input.manager;
      if (input.pin) {
        yield* dispatchCreateStep({
          type: "thread.pin",
          commandId: CommandId.make(input.ids.pinCommandId),
          threadId: input.threadId,
        });
      }
      yield* dispatchCreateStep({
        type: "thread.turn.start",
        commandId: CommandId.make(input.ids.startCommandId),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(input.ids.messageId),
          role: "user",
          text: input.message,
          attachments: [],
          source: {
            kind: "agent",
            threadId: caller.id,
            threadTitle: caller.title,
            replyTo: caller.id,
          },
        },
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        createdAt: input.createdAt,
      });
    });

  return AgentsToolkit.of({
    ...scheduleHandlers,
    cp_agent_create: (input) =>
      Effect.gen(function* () {
        const manager = yield* requireManager();
        const { caller, project } = manager;
        if (manager.role === "standing" && input.standing === true) {
          return yield* new StandingAgentNotAllowedError();
        }
        const ids = agentCreateIds(caller.id, input.clientRequestId ?? (yield* randomUuid));
        const threadId = ThreadId.make(
          input.clientRequestId === undefined
            ? yield* randomUuid
            : agentThreadIdFromDigest(
                yield* crypto
                  .digest("SHA-256", new TextEncoder().encode(ids.threadIdSeed))
                  .pipe(Effect.orDie),
              ),
        );

        const createLocal = (note: string | undefined) =>
          createLock
            .withPermits(1)(
              Effect.gen(function* () {
                if (input.clientRequestId !== undefined) {
                  const existing = yield* snapshots
                    .getThreadShellById(threadId)
                    .pipe(Effect.mapError(readFailed));
                  if (Option.isSome(existing)) {
                    if (existing.value.title !== input.title) {
                      return yield* new ClientRequestIdConflictError({
                        clientRequestId: input.clientRequestId,
                        threadId,
                      });
                    }
                    // The earlier call stopped after creating the thread (a cancel
                    // or a crash): finish it, or the agent never gets its message.
                    // Its first message starts it running, so the cap applies.
                    if (existing.value.latestUserMessageAt === null) {
                      const createdAt = yield* nowIso;
                      yield* requireFreeSlot(manager, createdAt);
                      yield* Effect.uninterruptible(
                        pinAndStart({
                          manager,
                          ids,
                          threadId,
                          pin: input.standing === true && existing.value.pinnedAt == null,
                          message: input.message,
                          runtimeMode: existing.value.runtimeMode,
                          createdAt,
                        }),
                      );
                    }
                    return {
                      threadId,
                      title: existing.value.title,
                      runtimeMode: existing.value.runtimeMode,
                      created: false,
                    };
                  }
                  // Created before but no longer live: archived or deleted.
                  if (
                    (yield* lineage.creatorOf(threadId).pipe(Effect.mapError(readFailed))) !== null
                  ) {
                    return yield* new AgentToolFailedError({
                      detail:
                        "The agent this clientRequestId started was archived or deleted. Use a new clientRequestId.",
                    });
                  }
                }

                const coordinator = yield* resolveCoordinator(manager);
                const model = resolveAgentModel({
                  requested: input.model,
                  base: project.defaultModelSelection ?? coordinator.modelSelection,
                  providers: yield* registry.getProviders,
                });
                if (model.kind === "unknown") {
                  return yield* new UnknownModelError({
                    model: input.model ?? "",
                    available: model.available,
                  });
                }
                // Never looser than the caller, whatever it asks for.
                const runtimeMode = stricterRuntimeMode(
                  input.runtimeMode ??
                    stricterRuntimeMode(coordinator.runtimeMode, caller.runtimeMode),
                  caller.runtimeMode,
                );

                const createdAt = yield* nowIso;
                yield* requireFreeSlot(manager, createdAt);

                // A cancelled call must not leave an agent created without its
                // first message, so the three dispatches run to the end.
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* dispatchCreateStep({
                      type: "thread.create",
                      commandId: CommandId.make(ids.createCommandId),
                      threadId,
                      projectId: project.id,
                      title: input.title,
                      modelSelection: model.modelSelection,
                      runtimeMode,
                      interactionMode: "default",
                      branch: null,
                      worktreePath: null,
                      createdAt,
                      createdByThreadId: caller.id,
                    });
                    yield* pinAndStart({
                      manager,
                      ids,
                      threadId,
                      pin: input.standing === true,
                      message: input.message,
                      runtimeMode,
                      createdAt,
                    });
                  }),
                );
                // Returns at once: the result arrives later as a message.
                return { threadId, title: input.title, runtimeMode, created: true };
              }),
            )
            .pipe(
              Effect.map((result) => ({
                ...result,
                machineLabel: null,
                ...(note === undefined ? {} : { placement: note }),
              })),
            );

        /** Where this agent runs: here, or a linked machine the settings allow. */
        const route = Effect.gen(function* () {
          const named = input.machine?.trim();
          const asksForLocal = named !== undefined && named.toLowerCase() === LOCAL_AGENT_MACHINE;
          // A retry, or an agent this call already made, stays where it started.
          if (input.clientRequestId !== undefined) {
            if (Option.isSome(yield* remote.get(threadId)))
              return { kind: "remote-retry" } as const;
            const local = yield* snapshots
              .getThreadShellById(threadId)
              .pipe(Effect.mapError(readFailed));
            if (Option.isSome(local)) return { kind: "local", note: undefined } as const;
          }
          if (input.standing === true) {
            if (named !== undefined && !asksForLocal) {
              return yield* new AgentToolFailedError({
                detail: 'A standing agent runs on this machine. Omit machine, or use "local".',
              });
            }
            return { kind: "local", note: undefined } as const;
          }
          const plan = yield* remote
            .plan({
              project: {
                id: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                repositoryIdentity: project.repositoryIdentity,
              },
              requested: named,
            })
            .pipe(Effect.mapError((error) => new AgentToolFailedError({ detail: error.detail })));
          if (plan.decision.kind === "rejected") {
            return yield* new AgentToolFailedError({ detail: plan.decision.detail });
          }
          if (plan.decision.machineId === LOCAL_AGENT_MACHINE) {
            return { kind: "local", note: plan.decision.note } as const;
          }
          if (plan.peerProjectId === null) {
            return yield* new AgentToolFailedError({
              detail: `${plan.decision.label} has no matching Project.`,
            });
          }
          return {
            kind: "remote",
            machineId: plan.decision.machineId,
            machineLabel: plan.decision.label,
            peerProjectId: plan.peerProjectId,
            // An explicit machine never falls back.
            fallbackAllowed: named === undefined && plan.allowLocalFallback,
          } as const;
        });

        const createRemote = (target: {
          readonly machineId: string;
          readonly machineLabel: string;
          readonly peerProjectId: string;
        }) =>
          Effect.gen(function* () {
            const homeLabel = yield* remote.homeLabel;
            const coordinator = yield* resolveCoordinator(manager);
            const runtimeMode = stricterRuntimeMode(
              input.runtimeMode ?? stricterRuntimeMode(coordinator.runtimeMode, caller.runtimeMode),
              caller.runtimeMode,
            );
            const createdAt = yield* nowIso;
            const request = {
              machineId: target.machineId,
              machineLabel: target.machineLabel,
              peerProjectId: target.peerProjectId,
              home: {
                project: {
                  id: project.id,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                },
                label: homeLabel,
              },
              creator: { id: caller.id, title: caller.title },
              ids,
              threadId,
              title: input.title,
              message: input.message,
              runtimeMode,
              baseModel: project.defaultModelSelection ?? coordinator.modelSelection,
              requestedModel: input.model,
              createdAt,
            };
            // Only the cap check and the record are under the lock: the peer calls are slow.
            const reserved = yield* createLock.withPermits(1)(
              Effect.gen(function* () {
                const found = yield* remote.get(threadId);
                if (Option.isSome(found) && found.value.title !== input.title) {
                  return yield* new ClientRequestIdConflictError({
                    clientRequestId: input.clientRequestId ?? "",
                    threadId,
                  });
                }
                if (Option.isNone(found)) yield* requireFreeSlot(manager, createdAt);
                return yield* remote
                  .reserve(request)
                  .pipe(
                    Effect.mapError((error) => new AgentToolFailedError({ detail: error.detail })),
                  );
              }),
            );
            const record = yield* Effect.uninterruptible(remote.start(request, reserved.record));
            return {
              threadId,
              title: input.title,
              runtimeMode: record.runtimeMode,
              created: !reserved.existed,
              machineLabel: record.machineLabel,
            };
          });

        const routed = yield* route;
        if (routed.kind === "local") return yield* createLocal(routed.note);
        if (routed.kind === "remote-retry") {
          const record = yield* remote.get(threadId);
          if (Option.isNone(record)) return yield* createLocal(undefined);
          return yield* createRemote(record.value).pipe(
            Effect.catchTag("RemoteAgentError", (error) => Effect.fail(toolFailed(error))),
          );
        }
        return yield* createRemote(routed).pipe(
          Effect.catchTag("RemoteAgentError", (error) =>
            error.stage === "create" && routed.fallbackAllowed
              ? createLocal(
                  `Could not start on ${routed.machineLabel}: ${error.detail} Started on this machine instead.`,
                )
              : Effect.fail(toolFailed(error)),
          ),
        );
      }),

    cp_agent_list: (input) =>
      Effect.gen(function* () {
        const manager = yield* requireManager();
        const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
        const now = yield* nowIso;
        const listed = snapshot.threads.filter(
          (thread) =>
            thread.archivedAt === null &&
            (input.includeSettled === true || thread.settledAt === null),
        );
        const canManage = yield* managesThread(manager, listed);
        const local = listed
          .filter((thread) => canManage(thread))
          .map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            standing: isStandingAgent(manager.project, thread),
            phase: phaseOf(manager, thread, now),
            settled: thread.settledAt !== null,
            lastActivityAt: thread.updatedAt,
            machine: null,
          }));
        const onMachines = (yield* remote.list(manager.project.id))
          .filter(
            ({ record }) =>
              (input.includeSettled === true ||
                record.state === "open" ||
                record.state === "pending") &&
              canManageAgent(manager.project, manager.caller, remoteAsManaged(manager, record)),
          )
          .map(({ record, phase }) => ({
            threadId: ThreadId.make(record.threadId),
            title: record.title,
            standing: false,
            phase,
            settled: record.state === "settled" || record.state === "lost",
            lastActivityAt: record.lastActivityAt ?? record.createdAt,
            machine: record.machineLabel,
          }));
        return { agents: [...local, ...onMachines] };
      }),

    cp_agent_read: (input) =>
      Effect.gen(function* () {
        const manager = yield* requireManager();
        const target = yield* requireTarget(manager, input.agent);
        if (target.kind === "remote") {
          const read = yield* remote
            .read(target.record, input.turns ?? 1)
            .pipe(Effect.mapError(toolFailed));
          return {
            threadId: ThreadId.make(target.record.threadId),
            title: target.record.title,
            phase: read.phase,
            turns: capAgentReadTurns(read.turns),
          };
        }
        const agent = target.thread;
        const turns = yield* turnRows
          .listByThreadId({ threadId: agent.id })
          .pipe(Effect.mapError(readFailed));
        const textOf = (messageId: MessageId | null) =>
          messageId === null
            ? Effect.succeed(Option.none<{ text: string; streaming: boolean }>())
            : messageRows
                .getByMessageId({ messageId })
                .pipe(
                  Effect.mapError(readFailed),
                  Effect.map(
                    Option.flatMap((message) =>
                      message.threadId === agent.id
                        ? Option.some({ text: message.text, streaming: message.isStreaming })
                        : Option.none(),
                    ),
                  ),
                );
        const read = yield* Effect.forEach(agentRequestTurns(turns, input.turns ?? 1), (turn) =>
          Effect.gen(function* () {
            const request = yield* textOf(turn.requestId);
            const result = yield* textOf(turn.resultId);
            return {
              state: turn.state,
              request: Option.match(request, { onNone: () => "", onSome: ({ text }) => text }),
              // The last finished message: a streaming one is still being written.
              result: Option.match(result, {
                onNone: () => null,
                onSome: ({ text, streaming }) => (streaming ? null : text),
              }),
            };
          }),
        );
        return {
          threadId: agent.id,
          title: agent.title,
          phase: phaseOf(manager, agent, yield* nowIso),
          turns: capAgentReadTurns(read),
        };
      }),

    cp_agent_stop: (input) =>
      Effect.gen(function* () {
        const manager = yield* requireManager();
        const target = yield* requireTarget(manager, input.agent);
        if (target.kind === "remote") {
          const stopped = yield* remote
            .stop(target.record, { archive: input.archive === true })
            .pipe(Effect.mapError(toolFailed));
          return { threadId: ThreadId.make(target.record.threadId), ...stopped };
        }
        const agent = target.thread;
        const createdAt = yield* nowIso;
        const turns = yield* turnRows
          .listByThreadId({ threadId: agent.id })
          .pipe(Effect.mapError(readFailed));
        const held = heldRequestIds({
          agentId: agent.id,
          managerId: manager.caller.id,
          messages: yield* messageRows
            .listByThreadId({ threadId: agent.id })
            .pipe(Effect.mapError(readFailed)),
          turns,
        });
        // Before the interrupt, while the agent is still busy: the delivery
        // reactor starts a held message under this same id once the agent is
        // idle, so taking the id first means the message never starts.
        for (const messageId of held) {
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(agentDeliveryStartId(messageId)),
              threadId: agent.id,
              activity: {
                id: EventId.make(yield* randomUuid),
                tone: "info",
                kind: "agent-send.dropped",
                summary: "Queued message dropped: the agent was stopped",
                payload: { messageId, stoppedBy: manager.caller.id },
                turnId: null,
                createdAt,
              },
              createdAt,
            })
            .pipe(
              // A start the engine rejected already counts as handled.
              Effect.catchTag("OrchestrationCommandPreviouslyRejectedError", () => Effect.void),
              Effect.catchCause(dispatchFailed("Could not stop the agent.")),
            );
        }
        // A start the provider has not picked up yet still runs unless it is
        // interrupted: the provider reactor handles the start before the stop.
        const working = isRunningAgent(agent) || hasPendingTurnStart(turns);
        if (working) {
          // The stop id names the request whose turn it cuts off, so that
          // request's result is not pushed: the manager asked for the stop.
          // Any other turn (the user's, or a request already finished) keeps
          // its result.
          const requestId = inFlightRequestId({ turns, session: agent.session });
          const request =
            requestId === null
              ? Option.none()
              : yield* messageRows
                  .getByMessageId({ messageId: requestId })
                  .pipe(Effect.mapError(readFailed));
          const ownRequest = Option.filter(
            request,
            (message) =>
              message.threadId === agent.id && message.source?.replyTo === manager.caller.id,
          );
          yield* dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make(
                Option.isSome(ownRequest)
                  ? agentStopId(manager.caller.id, agent.id, ownRequest.value.messageId)
                  : `mcp-agent-stop:${agent.id}:${yield* randomUuid}`,
              ),
              threadId: agent.id,
              createdAt,
            },
            "Could not stop the agent.",
          );
        }
        yield* dispatch(
          {
            type: "thread.session.stop",
            commandId: CommandId.make(`mcp-agent-session-stop:${agent.id}:${yield* randomUuid}`),
            threadId: agent.id,
            createdAt,
          },
          "Could not stop the agent.",
        );
        if (input.archive === true) {
          yield* dispatch(
            {
              type: "thread.archive",
              commandId: CommandId.make(`mcp-agent-archive:${agent.id}:${yield* randomUuid}`),
              threadId: agent.id,
            },
            "Stopped the agent, but could not archive it.",
          );
        }
        return {
          threadId: agent.id,
          stopped: working || held.length > 0,
          archived: input.archive === true,
        };
      }),

    cp_agent_settle: (input) =>
      Effect.gen(function* () {
        const manager = yield* requireManager();
        // Settling is the coordinator's call: a standing agent manages one-offs
        // it started, but does not decide when their work is done.
        if (manager.role !== "coordinator") return yield* new SettleCoordinatorOnlyError();
        const agent = yield* requireAgent(manager, input.agent);
        if (isStandingAgent(manager.project, agent)) {
          return yield* new AgentToolFailedError({
            detail: `'${input.agent}' is a standing agent, and standing agents do not settle.`,
          });
        }
        const turns = yield* turnRows
          .listByThreadId({ threadId: agent.id })
          .pipe(Effect.mapError(readFailed));
        const phase = phaseOf(manager, agent, yield* nowIso);
        const busy =
          phase === "starting" ||
          phase === "running" ||
          phase === "waiting_for_approval" ||
          phase === "waiting_for_input";
        if (busy || hasPendingTurnStart(turns)) {
          return yield* new AgentBusyError({
            agent: input.agent,
            phase: busy ? phase : "starting",
          });
        }
        // The same command the Settle button sends. The decider re-checks that
        // the agent is idle, so a turn that began after the read above blocks it.
        yield* engine
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(`mcp-agent-settle:${agent.id}:${yield* randomUuid}`),
            threadId: agent.id,
          })
          .pipe(
            Effect.catchCause(
              (cause): Effect.Effect<never, AgentBusyError | AgentToolFailedError> => {
                const error = Cause.findErrorOption(cause);
                return Option.isSome(error) && isSettleBlocked(error.value)
                  ? Effect.fail(new AgentBusyError({ agent: input.agent, phase: "busy" }))
                  : dispatchFailed("Could not settle the agent.")(cause);
              },
            ),
          );
        if (input.archive === true) {
          yield* dispatch(
            {
              type: "thread.archive",
              commandId: CommandId.make(`mcp-agent-archive:${agent.id}:${yield* randomUuid}`),
              threadId: agent.id,
            },
            "Settled the agent, but could not archive it.",
          );
        }
        return { threadId: agent.id, settled: true as const, archived: input.archive === true };
      }),
  });
});

/** Needs `AgentLineage` and the turn, message and project repositories; tests provide stubs. */
export const AgentsToolkitHandlers = AgentsToolkit.toLayer(make);

export const AgentsToolkitHandlersLive = AgentsToolkitHandlers.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentLineage.layer,
      ProjectionTurnRepositoryLive,
      ProjectionThreadMessageRepositoryLive,
      ProjectionProjectRepositoryLive,
    ),
  ),
);

/** Registered in `McpHttpServer.ts`; kept here so the upstream file gains one line. */
export const AgentsToolkitRegistrationLive = McpServer.toolkit(AgentsToolkit).pipe(
  Layer.provide(AgentsToolkitHandlersLive),
);
