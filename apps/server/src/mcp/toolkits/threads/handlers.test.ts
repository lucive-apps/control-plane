import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const SENDER_ID = ThreadId.make("sender-1");
const TARGET_ID = ThreadId.make("target-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: SENDER_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("grok"),
  capabilities: new Set(),
  issuedAt: 1,
};

function makeThread(id: ThreadId, title: string): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const sender = makeThread(SENDER_ID, "Coordinator");
const target = makeThread(TARGET_ID, "weekly-daily-plan");

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  threads: ReadonlyArray<OrchestrationThreadShell> = [sender, target],
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(byId.get(threadId))),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads,
          updatedAt: "2026-08-20T00:00:00.000Z",
        }),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  return {
    commands,
    send: (params: Parameters<typeof toolkit.handle<"t3_thread_send">>[1]) =>
      toolkit.handle("t3_thread_send", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunk) => chunk.at(-1)!.result),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(dependencies),
      ),
  };
});

describe("threads toolkit handlers", () => {
  it.effect("sends a tagged agent message by thread title", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.send({
        message: "Scheduled specialist results are ready.",
        threadTitle: "weekly-daily-plan",
      });
      expect(result).toEqual({ threadId: TARGET_ID, threadTitle: "weekly-daily-plan" });
      const commands = yield* Ref.get(harness.commands);
      expect(commands).toHaveLength(1);
      const command = commands[0];
      assertTrue(command?.type === "thread.turn.start");
      if (command?.type !== "thread.turn.start") return;
      expect(command.threadId).toBe(TARGET_ID);
      expect(command.message.text).toBe("Scheduled specialist results are ready.");
      expect(command.message.source).toEqual({
        kind: "agent",
        threadId: SENDER_ID,
        threadTitle: "Coordinator",
      });
    }),
  );

  it.effect("refuses to message the sending thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.send({ message: "loop", threadId: SENDER_ID }).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadSendSelfError");
    }),
  );

  it.effect("does not use a thread id as the displayed name", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.send({ message: "hello", threadId: TARGET_ID });
      const commands = yield* Ref.get(harness.commands);
      const command = commands[0];
      assertTrue(command?.type === "thread.turn.start");
      if (command?.type !== "thread.turn.start") return;
      expect(command.message.source?.threadTitle).toBe("Coordinator");
      expect(command.message.source?.threadTitle).not.toBe(SENDER_ID);
    }),
  );
});

function assertTrue(value: unknown): asserts value is true {
  expect(value).toBe(true);
}
