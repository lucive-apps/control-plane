import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlers } from "./handlers.ts";
import { ThreadSendResult, ThreadsToolkit } from "./tools.ts";

const NOW = "2026-08-20T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const WORKSPACE_ID = ProjectId.make("workspace-1");
const SENDER_ID = ThreadId.make("sender-1");
const TARGET_ID = ThreadId.make("target-1");

const COORDINATOR = ThreadId.make("coordinator");
const STANDING = ThreadId.make("standing-research");
const PEER_STANDING = ThreadId.make("standing-writer");
const ONE_OFF = ThreadId.make("one-off-compare");
const OWN_HELPER = ThreadId.make("one-off-research-helper");
const PEER_HELPER = ThreadId.make("one-off-writer-helper");
const PLAIN = ThreadId.make("plain-task");
const PLAIN_TARGET = ThreadId.make("plain-other-task");

const isThreadSendResult = Schema.is(ThreadSendResult);

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function invocationFor(threadId: ThreadId): McpInvocationContext.McpInvocationScope {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("grok"),
    capabilities: new Set(),
    issuedAt: 1,
  };
}

function makeThread(
  id: ThreadId,
  title: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
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
    ...overrides,
  };
}

function makeProject(
  id: ProjectId,
  assistant: OrchestrationProjectShell["assistant"],
): OrchestrationProjectShell {
  return {
    id,
    title: id,
    workspaceRoot: `/workspace/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
    assistant,
  };
}

function running(threadId: ThreadId): OrchestrationThreadShell["session"] {
  return {
    threadId,
    status: "running",
    providerName: "grok",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

const sender = makeThread(SENDER_ID, "Coordinator");
const target = makeThread(TARGET_ID, "weekly-daily-plan");

const pinnedAt = "2026-08-02T00:00:00.000Z";
const projectThreads = [
  makeThread(COORDINATOR, "Personal"),
  makeThread(STANDING, "Research", { pinnedAt }),
  makeThread(PEER_STANDING, "Writer", { pinnedAt }),
  makeThread(ONE_OFF, "Compare"),
  makeThread(OWN_HELPER, "Research helper"),
  makeThread(PEER_HELPER, "Writer helper"),
  makeThread(PLAIN, "Plain", { projectId: WORKSPACE_ID }),
  makeThread(PLAIN_TARGET, "Other plain", { projectId: WORKSPACE_ID }),
];
const projects = [
  makeProject(PROJECT_ID, { coordinatorThreadId: COORDINATOR }),
  makeProject(WORKSPACE_ID, null),
];
const creators = new Map([
  [ONE_OFF, COORDINATOR],
  [OWN_HELPER, STANDING],
  [PEER_HELPER, PEER_STANDING],
]);

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: {
    readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
    readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
    /** requestedAt of a sent message no turn has adopted yet, per thread. */
    readonly pendingStarts?: ReadonlyMap<ThreadId, string>;
  } = {},
) {
  yield* TestClock.setTime(Date.parse(NOW));
  const threads = options.threads ?? [sender, target];
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const projectById = new Map((options.projects ?? []).map((project) => [project.id, project]));
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(byId.get(threadId))),
      getProjectShellById: (projectId) =>
        Effect.succeed(Option.fromNullishOr(projectById.get(projectId))),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [...projectById.values()],
          threads,
          updatedAt: NOW,
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
  const repositories = Layer.mergeAll(
    Layer.mock(AgentLineage)({
      creatorOf: (threadId) => Effect.succeed(creators.get(threadId) ?? null),
    }),
    Layer.mock(ProjectionTurnRepository)({
      getPendingTurnStartByThreadId: ({ threadId }) => {
        const requestedAt = options.pendingStarts?.get(threadId);
        return Effect.succeed(
          requestedAt === undefined
            ? Option.none()
            : Option.some({
                threadId,
                messageId: MessageId.make(`pending-${threadId}`),
                sourceProposedPlanThreadId: null,
                sourceProposedPlanId: null,
                requestedAt,
              }),
        );
      },
    }),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(
      ThreadsToolkitHandlers.pipe(Layer.provide(Layer.merge(dependencies, repositories))),
    ),
  );
  return {
    commands,
    send: (
      params: Parameters<typeof toolkit.handle<"cp_thread_send">>[1],
      from: ThreadId = SENDER_ID,
    ) =>
      toolkit.handle("cp_thread_send", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.flatMap((chunk) => {
          const result = chunk.at(-1)!.result;
          return isThreadSendResult(result)
            ? Effect.succeed(result)
            : Effect.die(new Error("cp_thread_send returned a failure result"));
        }),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(from)),
        Effect.provide(dependencies),
      ),
  };
});

const projectHarness = (
  options: {
    readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
    readonly pendingStarts?: ReadonlyMap<ThreadId, string>;
  } = {},
) => makeHarness({ threads: projectThreads, projects, ...options });

/** The single command a send dispatched. */
const onlyCommand = (commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) =>
  Ref.get(commands).pipe(
    Effect.map((recorded) => {
      expect(recorded).toHaveLength(1);
      return recorded[0]!;
    }),
  );

describe("threads toolkit handlers", () => {
  it.effect("sends a tagged agent message by thread title", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.send({
        message: "Scheduled specialist results are ready.",
        threadTitle: "weekly-daily-plan",
      });
      expect(result).toEqual({
        threadId: TARGET_ID,
        threadTitle: "weekly-daily-plan",
        queued: false,
      });
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

  it.effect("asks for a result only when the sender manages the target", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly from: ThreadId;
        readonly to: ThreadId;
        readonly replyTo: ThreadId | undefined;
      }> = [
        { from: COORDINATOR, to: ONE_OFF, replyTo: COORDINATOR },
        { from: STANDING, to: OWN_HELPER, replyTo: STANDING },
        { from: ONE_OFF, to: COORDINATOR, replyTo: undefined },
        { from: STANDING, to: PEER_HELPER, replyTo: undefined },
        { from: STANDING, to: PEER_STANDING, replyTo: undefined },
        { from: PLAIN, to: PLAIN_TARGET, replyTo: undefined },
      ];
      for (const { from, to, replyTo } of cases) {
        const harness = yield* projectHarness();
        const result = yield* harness.send({ message: "Compare the options", threadId: to }, from);
        expect(result.queued).toBe(false);
        const command = yield* onlyCommand(harness.commands);
        assertTrue(command.type === "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        expect({ from, to, replyTo: command.message.source?.replyTo }).toEqual({
          from,
          to,
          replyTo,
        });
      }
    }),
  );

  it.effect("holds a send to a busy thread in the same Project until its turn ends", () =>
    Effect.gen(function* () {
      const busy = projectThreads.map((thread) =>
        thread.id === ONE_OFF || thread.id === PLAIN_TARGET
          ? { ...thread, session: running(thread.id) }
          : thread,
      );

      const held = yield* projectHarness({ threads: busy });
      const heldResult = yield* held.send(
        { message: "Also print done", threadId: ONE_OFF },
        COORDINATOR,
      );
      expect(heldResult).toEqual({ threadId: ONE_OFF, threadTitle: "Compare", queued: true });
      const append = yield* onlyCommand(held.commands);
      assertTrue(append.type === "thread.message.user.append");
      if (append.type !== "thread.message.user.append") return;
      expect(append.threadId).toBe(ONE_OFF);
      expect(append.message.messageId.startsWith(`cp-send:${ONE_OFF}:`)).toBe(true);
      expect(append.commandId).toBe(append.message.messageId);
      expect(append.message.source?.replyTo).toBe(COORDINATOR);

      // A message no turn has adopted yet counts as busy too.
      const queued = yield* projectHarness({ pendingStarts: new Map([[ONE_OFF, NOW]]) });
      const queuedResult = yield* queued.send({ message: "Next", threadId: ONE_OFF }, COORDINATOR);
      expect(queuedResult.queued).toBe(true);

      const idle = yield* projectHarness();
      const idleResult = yield* idle.send({ message: "Start", threadId: ONE_OFF }, COORDINATOR);
      expect(idleResult.queued).toBe(false);
      expect((yield* onlyCommand(idle.commands)).type).toBe("thread.turn.start");

      // Outside a Project a send steers a busy thread, as before.
      const plain = yield* projectHarness({ threads: busy });
      const plainResult = yield* plain.send({ message: "Steer", threadId: PLAIN_TARGET }, PLAIN);
      expect(plainResult.queued).toBe(false);
      expect((yield* onlyCommand(plain.commands)).type).toBe("thread.turn.start");
    }),
  );

  it.effect("resolves a title shared across Projects to the sender's own Project", () =>
    Effect.gen(function* () {
      const elsewhere = makeThread(ThreadId.make("research-elsewhere"), "Research", {
        projectId: WORKSPACE_ID,
      });
      const harness = yield* projectHarness({ threads: [...projectThreads, elsewhere] });
      const result = yield* harness.send({ message: "Hi", threadTitle: "Research" }, COORDINATOR);
      expect(result.threadId).toBe(STANDING);

      const twin = makeThread(ThreadId.make("research-twin"), "Research");
      const ambiguous = yield* projectHarness({ threads: [...projectThreads, elsewhere, twin] });
      const error = yield* ambiguous
        .send({ message: "Hi", threadTitle: "Research" }, COORDINATOR)
        .pipe(Effect.flip);
      expect(error._tag).toBe("ThreadSendTargetAmbiguousError");
    }),
  );
});

function assertTrue(value: unknown): asserts value is true {
  expect(value).toBe(true);
}
