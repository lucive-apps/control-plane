import { CommandId, MessageId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  const crypto = yield* Crypto.Crypto;

  const mintId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => `${tag}:${threadId}:${uuid}`),
    );

  const resolveTarget = Effect.fn("ThreadsToolkit.resolveTarget")(function* (
    input: ThreadSendInput,
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
    if (matches.length > 1) {
      return yield* new ThreadSendTargetAmbiguousError({ title });
    }
    return matches[0]!;
  });

  return ThreadsToolkit.of({
    t3_thread_send: (input) =>
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
        const target: OrchestrationThreadShell = yield* resolveTarget(input);
        if (target.id === sender.value.id) {
          return yield* new ThreadSendSelfError({});
        }
        const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const commandId = CommandId.make(yield* mintId("mcp-thread-send", target.id));
        const messageId = MessageId.make(yield* mintId("agent-message", target.id));
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: target.id,
            message: {
              messageId,
              role: "user",
              text: input.message,
              attachments: [],
              source: {
                kind: "agent",
                threadId: sender.value.id,
                threadTitle: sender.value.title,
              },
            },
            createdAt,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(new ThreadSendFailedError({ cause })),
            ),
          );
        return { threadId: target.id, threadTitle: target.title };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
