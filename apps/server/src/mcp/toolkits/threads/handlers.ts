import {
  CommandId,
  MessageId,
  agentManagerRole,
  canManageAgent,
  type OrchestrationAgentMessageSource,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import { agentSendId } from "../../../orchestration/agentProtocol.ts";
import { isDeliveryIdle } from "../../../orchestration/agentPushes.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ThreadSendFailedError,
  ThreadSendSelfError,
  ThreadSendTargetAmbiguousError,
  ThreadSendTargetMissingError,
  ThreadSendTargetNotFoundError,
  ThreadsToolkit,
  type ThreadSendInput,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const lineage = yield* AgentLineage;
  const crypto = yield* Crypto.Crypto;

  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const mintId = (tag: string, threadId: ThreadId) =>
    randomUuid.pipe(Effect.map((uuid) => `${tag}:${threadId}:${uuid}`));

  const resolveTarget = Effect.fn("ThreadsToolkit.resolveTarget")(function* (
    input: ThreadSendInput,
    sender: OrchestrationThreadShell,
  ) {
    if (input.threadId !== undefined) {
      const thread = yield* snapshots
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
      if (Option.isNone(thread)) {
        return yield* new ThreadSendTargetNotFoundError({ query: input.threadId });
      }
      return thread.value;
    }
    const title = input.threadTitle?.trim();
    if (!title) {
      return yield* new ThreadSendTargetMissingError({});
    }
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
    const matches = snapshot.threads.filter(
      (thread) => thread.title.localeCompare(title, undefined, { sensitivity: "accent" }) === 0,
    );
    if (matches.length === 0) {
      return yield* new ThreadSendTargetNotFoundError({ query: title });
    }
    if (matches.length === 1) return matches[0]!;
    // Agents reuse short role titles across Projects: prefer the sender's own.
    const local = matches.filter((thread) => thread.projectId === sender.projectId);
    if (local.length === 1) return local[0]!;
    return yield* new ThreadSendTargetAmbiguousError({ title });
  });

  /**
   * Inside one active Project a manager's send is a request (its result comes
   * back), and a send to a busy thread waits for its turn to end instead of
   * steering it. Null outside a Project, where sends keep their M1 behavior.
   */
  const routeInProject = Effect.fn("ThreadsToolkit.routeInProject")(function* (
    sender: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
    now: string,
  ) {
    if (sender.projectId !== target.projectId) return null;
    const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(sender.projectId));
    if (project?.assistant == null || project.assistant.archivedAt != null) return null;
    const role = agentManagerRole(project, sender);
    // Only a standing manager's scope depends on who created the target.
    const createdByThreadId = role === "standing" ? yield* lineage.creatorOf(target.id) : undefined;
    const replyTo =
      role !== null && canManageAgent(project, sender, { ...target, createdByThreadId })
        ? sender.id
        : undefined;
    const pendingStart = yield* turns.getPendingTurnStartByThreadId({ threadId: target.id });
    return {
      replyTo,
      idle: isDeliveryIdle(target.session, Option.getOrNull(pendingStart), now),
    };
  });

  const toSendFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(new ThreadSendFailedError({ cause })),
      ),
    );

  return ThreadsToolkit.of({
    cp_thread_send: (input) =>
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const sender = yield* snapshots
          .getThreadShellById(invocation.threadId)
          .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
        if (Option.isNone(sender)) {
          return yield* new ThreadSendFailedError({
            cause: new Error("Sender thread was not found."),
          });
        }
        const target: OrchestrationThreadShell = yield* resolveTarget(input, sender.value);
        if (target.id === sender.value.id) {
          return yield* new ThreadSendSelfError({});
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const route = yield* toSendFailure(routeInProject(sender.value, target, createdAt));
        const source: OrchestrationAgentMessageSource = {
          kind: "agent",
          threadId: sender.value.id,
          threadTitle: sender.value.title,
          ...(route?.replyTo !== undefined ? { replyTo: route.replyTo } : {}),
        };
        if (route !== null && !route.idle) {
          // Held: the AgentCompletionReactor starts it once the target is idle.
          const id = agentSendId(target.id, yield* randomUuid);
          yield* toSendFailure(
            engine.dispatch({
              type: "thread.message.user.append",
              commandId: CommandId.make(id),
              threadId: target.id,
              message: {
                messageId: MessageId.make(id),
                text: input.message,
                attachments: [],
                source,
              },
              createdAt,
            }),
          );
          return { threadId: target.id, threadTitle: target.title, queued: true };
        }
        yield* toSendFailure(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* mintId("mcp-thread-send", target.id)),
            threadId: target.id,
            message: {
              messageId: MessageId.make(yield* mintId("agent-message", target.id)),
              role: "user",
              text: input.message,
              attachments: [],
              source,
            },
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt,
          }),
        );
        return { threadId: target.id, threadTitle: target.title, queued: false };
      }),
  });
});

/** Needs `AgentLineage` and `ProjectionTurnRepository`; tests provide stubs. */
export const ThreadsToolkitHandlers = ThreadsToolkit.toLayer(make);

export const ThreadsToolkitHandlersLive = ThreadsToolkitHandlers.pipe(
  Layer.provide(Layer.mergeAll(AgentLineage.layer, ProjectionTurnRepositoryLive)),
);
