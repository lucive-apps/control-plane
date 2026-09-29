import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { AgentCompletionReactor } from "../orchestration/AgentCompletionReactor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RemoteAgentBridge,
  makeRemoteAgentBridge,
  REMOTE_LOST_AFTER_MS,
} from "./RemoteAgentBridge.ts";
import { RemoteAgentsLive } from "./RemoteAgents.ts";
import { RemoteAgentStore, type RemoteAgentRecord } from "./RemoteAgentStore.ts";
import {
  MemoryRemoteAgentStore,
  TEST_NOW,
  makeFakePeer,
  makePeerThread,
  makeRecord,
} from "./testFixtures.ts";

const HOME_PROJECT = ProjectId.make("project-1");
const COORDINATOR = ThreadId.make("coordinator");
const STANDING = ThreadId.make("standing");

const homeThread = (id: ThreadId, overrides: Partial<OrchestrationThreadShell> = {}) =>
  makePeerThread(id, { projectId: HOME_PROJECT, ...overrides });

const homeProject = (
  assistant: OrchestrationProjectShell["assistant"] = { coordinatorThreadId: COORDINATOR },
): OrchestrationProjectShell => ({
  id: HOME_PROJECT,
  title: "Acme",
  workspaceRoot: "/work/acme",
  defaultModelSelection: null,
  assistant,
  scripts: [],
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
});

const request = (overrides: Partial<NonNullable<RemoteAgentRecord["inFlight"]>> = {}) => ({
  messageId: "cp-agent-message:coordinator:r1",
  replyTo: "coordinator",
  sentAt: TEST_NOW,
  baselineTurnId: null,
  suppressed: false,
  ...overrides,
});

const completedTurn = (turnId = "turn-1") => ({
  turnId: turnId as never,
  state: "completed" as const,
  requestedAt: TEST_NOW,
  startedAt: TEST_NOW,
  completedAt: TEST_NOW,
  assistantMessageId: null,
});

interface HarnessOptions {
  readonly project?: OrchestrationProjectShell;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
}

const harness = (options: HarnessOptions = {}) => {
  const peer = makeFakePeer();
  const appended: Array<OrchestrationCommand> = [];
  const enqueued: Array<string> = [];
  const threads = new Map(
    (
      options.threads ?? [homeThread(COORDINATOR), homeThread(STANDING, { pinnedAt: TEST_NOW })]
    ).map((thread) => [thread.id, thread] as const),
  );
  const project = options.project ?? homeProject();
  const bridgeDependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          appended.push(command);
          return { sequence: appended.length };
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: (projectId) =>
        Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
    }),
    Layer.mock(AgentCompletionReactor)({
      enqueueProject: (projectId) => Effect.sync(() => void enqueued.push(projectId)),
    }),
  );
  const services = RemoteAgentsLive.pipe(
    Layer.provideMerge(peer.layer),
    Layer.provideMerge(MemoryRemoteAgentStore),
    Layer.provideMerge(bridgeDependencies),
  );
  const layer = Layer.effect(RemoteAgentBridge, makeRemoteAgentBridge).pipe(
    Layer.provideMerge(services),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, RemoteAgentBridge | RemoteAgentStore>) =>
    effect.pipe(Effect.provide(layer));
  const pushes = () => appended.filter((command) => command.type === "thread.message.user.append");
  return { peer, run, appended, enqueued, pushes, threads };
};

/** Seeds one open agent with a request in flight and the peer thread it reads. */
const seed = (
  h: ReturnType<typeof harness>,
  record: Partial<RemoteAgentRecord>,
  peerThread: Partial<OrchestrationThreadShell> = {},
  messages: ReadonlyArray<{ id: string; role: string; text: string; streaming?: boolean }> = [],
) =>
  Effect.gen(function* () {
    const store = yield* RemoteAgentStore;
    yield* store.put(makeRecord({ inFlight: request(), ...record }));
    h.peer.threads.set("remote-1", makePeerThread("remote-1", peerThread));
    h.peer.details.set("remote-1", {
      messages: messages.map((message) => ({ streaming: false, ...message })) as never,
    });
  });

const finishedMessages = [
  { id: "cp-agent-message:coordinator:r1", role: "user", text: "Compare plans." },
  { id: "a1", role: "assistant", text: "Plan B wins." },
];

describe("RemoteAgentBridge delivery", () => {
  it.effect(
    "pushes a finished request into the coordinator, wakes the reactor, and settles the agent",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const record = yield* h.run(
          Effect.gen(function* () {
            const bridge = yield* RemoteAgentBridge;
            const store = yield* RemoteAgentStore;
            yield* seed(h, {}, { latestTurn: completedTurn() }, finishedMessages);
            yield* bridge.pollOnce;
            return Option.getOrThrow(yield* store.get("remote-1"));
          }),
        );
        const [push] = h.pushes();
        expect(push).toMatchObject({
          type: "thread.message.user.append",
          commandId: "cp-push:remote-1:cp-agent-message:coordinator:r1",
          threadId: "coordinator",
        });
        if (push?.type === "thread.message.user.append") {
          expect(push.message.messageId).toBe("cp-push:remote-1:cp-agent-message:coordinator:r1");
          expect(push.message.text).toContain('Result from agent "Pricing (on Mac Mini)"');
          expect(push.message.text).toContain("Plan B wins.");
          expect(push.message.source).toMatchObject({ kind: "agent", threadId: "remote-1" });
          // A pushed turn never owes a result of its own.
          expect(push.message.source).not.toHaveProperty("replyTo");
        }
        expect(h.enqueued).toEqual([HOME_PROJECT]);
        expect(h.peer.commands.map((command) => command.type)).toEqual(["thread.settle"]);
        expect(record.state).toBe("settled");
        expect(record.inFlight).toBeNull();
      }),
  );

  it.effect("does not deliver the same request twice", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          yield* seed(h, {}, { latestTurn: completedTurn() }, finishedMessages);
          yield* bridge.pollOnce;
          yield* bridge.pollOnce;
          yield* bridge.pollOnce;
        }),
      );
      expect(h.pushes()).toHaveLength(1);
    }),
  );

  it.effect(
    "repeats the same push id after a restart lost the record update, so the engine dedupes it",
    () =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.run(
          Effect.gen(function* () {
            const bridge = yield* RemoteAgentBridge;
            const store = yield* RemoteAgentStore;
            yield* seed(h, {}, { latestTurn: completedTurn() }, finishedMessages);
            yield* bridge.pollOnce;
            // The crash: the append landed but the record still shows the request.
            yield* store.put(makeRecord({ inFlight: request() }));
            yield* bridge.pollOnce;
          }),
        );
        const ids = h.pushes().map((command) => command.commandId);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(1);
      }),
  );

  it.effect("waits while the agent is still running, and reads its phase", () =>
    Effect.gen(function* () {
      const h = harness();
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* seed(
            h,
            {},
            {
              session: {
                threadId: "remote-1" as never,
                status: "running",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: TEST_NOW,
              },
            },
          );
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(h.pushes()).toEqual([]);
      expect(record.lastPhase).toBe("running");
      expect(record.inFlight).not.toBeNull();
    }),
  );

  it.effect("does not treat the turn from before the request as its result", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          yield* seed(
            h,
            { inFlight: request({ baselineTurnId: "turn-1" }) },
            { latestTurn: completedTurn("turn-1") },
            finishedMessages,
          );
          yield* bridge.pollOnce;
        }),
      );
      expect(h.pushes()).toEqual([]);
    }),
  );

  it.effect("drops a stopped request's result without pushing it", () =>
    Effect.gen(function* () {
      const h = harness();
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* seed(
            h,
            { inFlight: request({ suppressed: true }) },
            { latestTurn: { ...completedTurn(), state: "interrupted" } },
            finishedMessages,
          );
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(h.pushes()).toEqual([]);
      expect(record.inFlight).toBeNull();
    }),
  );

  it.effect("reports a request whose start failed, with the peer's detail", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          yield* seed(
            h,
            {},
            {
              session: {
                threadId: "remote-1" as never,
                status: "error",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: "provider missing" as never,
                updatedAt: TEST_NOW,
              },
            },
            finishedMessages.slice(0, 1),
          );
          h.peer.details.set("remote-1", {
            messages: [] as never,
            activities: [
              {
                kind: "provider.turn.start.failed",
                payload: {
                  requestId: "cp-agent-message:coordinator:r1",
                  detail: "Model gpt-9 is not installed on this machine.",
                },
              },
            ] as never,
          });
          yield* bridge.pollOnce;
        }),
      );
      const [push] = h.pushes();
      expect(push?.type === "thread.message.user.append" && push.message.text).toContain(
        "Model gpt-9 is not installed on this machine.",
      );
    }),
  );

  it.effect("keeps a queued send going: the agent is not settled and the next request starts", () =>
    Effect.gen(function* () {
      const h = harness();
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* seed(
            h,
            {
              queuedSends: [
                {
                  messageId: "cp-remote-send:remote-1:q1",
                  text: "Then annual.",
                  replyTo: "coordinator",
                  queuedAt: TEST_NOW,
                },
              ],
            },
            { latestTurn: completedTurn() },
            finishedMessages,
          );
          yield* bridge.pollOnce;
          // The next poll sees the request off the record and the peer idle.
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(h.pushes()).toHaveLength(1);
      expect(h.peer.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
      expect(record.state).toBe("open");
      expect(record.inFlight?.messageId).toBe("cp-remote-send:remote-1:q1");
    }),
  );
});

describe("RemoteAgentBridge routing", () => {
  it.effect("delivers to the standing agent that asked, when it may manage the agent", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          yield* seed(
            h,
            { creatorThreadId: "standing", inFlight: request({ replyTo: "standing" }) },
            { latestTurn: completedTurn() },
            finishedMessages,
          );
          yield* bridge.pollOnce;
        }),
      );
      expect(h.pushes()[0]).toMatchObject({ threadId: "standing" });
    }),
  );

  it.effect("falls back to the coordinator when the asker no longer manages the agent", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          // Another standing agent created it, so `standing` may not receive it.
          yield* seed(
            h,
            { creatorThreadId: "someone-else", inFlight: request({ replyTo: "standing" }) },
            { latestTurn: completedTurn() },
            finishedMessages,
          );
          yield* bridge.pollOnce;
        }),
      );
      expect(h.pushes()[0]).toMatchObject({ threadId: "coordinator" });
    }),
  );

  it.effect("falls back to the coordinator when the asker is archived", () =>
    Effect.gen(function* () {
      const h = harness({
        threads: [
          homeThread(COORDINATOR),
          homeThread(STANDING, { pinnedAt: TEST_NOW, archivedAt: TEST_NOW }),
        ],
      });
      yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          yield* seed(
            h,
            { creatorThreadId: "standing", inFlight: request({ replyTo: "standing" }) },
            { latestTurn: completedTurn() },
            finishedMessages,
          );
          yield* bridge.pollOnce;
        }),
      );
      expect(h.pushes()[0]).toMatchObject({ threadId: "coordinator" });
    }),
  );

  it.effect("holds while the Project is archived and delivers after it is unarchived", () =>
    Effect.gen(function* () {
      const h = harness({
        project: homeProject({ coordinatorThreadId: COORDINATOR, archivedAt: TEST_NOW }),
      });
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* seed(h, {}, { latestTurn: completedTurn() }, finishedMessages);
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(h.pushes()).toEqual([]);
      expect(record.inFlight).not.toBeNull();
      expect(record.state).toBe("open");
    }),
  );
});

describe("RemoteAgentBridge machine health", () => {
  it.effect("marks agents stale while the machine is down and delivers when it returns", () =>
    Effect.gen(function* () {
      const h = harness();
      const results = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* seed(h, {}, { latestTurn: completedTurn() }, finishedMessages);
          h.peer.state.reachable = false;
          yield* bridge.pollOnce;
          const down = Option.getOrThrow(yield* store.get("remote-1"));
          h.peer.state.reachable = true;
          // Back off, then the machine answers on the next allowed poll.
          yield* TestClock.adjust(Duration.minutes(2));
          yield* bridge.pollOnce;
          return { down, up: Option.getOrThrow(yield* store.get("remote-1")) };
        }),
      );
      expect(results.down.lastPhase).toBe("stale");
      expect(results.down.inFlight).not.toBeNull();
      expect(h.pushes()).toHaveLength(1);
      expect(results.up.state).toBe("settled");
    }),
  );

  it.effect("holds without failing agents when the machine refuses the token", () =>
    Effect.gen(function* () {
      const h = harness();
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* seed(h, {}, { latestTurn: completedTurn() }, finishedMessages);
          h.peer.state.unauthorized = true;
          yield* bridge.pollOnce;
          yield* TestClock.adjust(Duration.hours(30));
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(h.pushes()).toEqual([]);
      expect(record.state).toBe("open");
      expect(record.inFlight).not.toBeNull();
    }),
  );

  it.effect(
    "loses the agent and pushes one failed result after the machine is gone for 24 hours",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const record = yield* h.run(
          Effect.gen(function* () {
            const bridge = yield* RemoteAgentBridge;
            const store = yield* RemoteAgentStore;
            yield* seed(h, {}, {}, finishedMessages);
            h.peer.state.reachable = false;
            yield* bridge.pollOnce;
            yield* TestClock.adjust(Duration.millis(REMOTE_LOST_AFTER_MS + 120_000));
            yield* bridge.pollOnce;
            return Option.getOrThrow(yield* store.get("remote-1"));
          }),
        );
        expect(record.state).toBe("lost");
        const [push] = h.pushes();
        // Its own id, so a real result that arrives later is still delivered.
        expect(push?.commandId).toBe("cp-push:remote-1:cp-agent-message:coordinator:r1:lost");
        expect(push?.type === "thread.message.user.append" && push.message.text).toContain(
          "unreachable for 24 hours",
        );
      }),
  );

  it.effect("loses an agent whose thread is gone from the machine", () =>
    Effect.gen(function* () {
      const h = harness();
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* store.put(makeRecord({ inFlight: request() }));
          yield* TestClock.adjust(Duration.minutes(10));
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(record.state).toBe("lost");
      expect(h.pushes()).toHaveLength(1);
    }),
  );

  it.effect("drops a pending record whose start never landed", () =>
    Effect.gen(function* () {
      const h = harness();
      const record = yield* h.run(
        Effect.gen(function* () {
          const bridge = yield* RemoteAgentBridge;
          const store = yield* RemoteAgentStore;
          yield* store.put(makeRecord({ state: "pending", inFlight: null }));
          h.peer.threads.set("remote-1", makePeerThread("remote-1"));
          yield* TestClock.adjust(Duration.minutes(5));
          yield* bridge.pollOnce;
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(record.state).toBe("lost");
      expect(h.pushes()).toEqual([]);
    }),
  );
});
