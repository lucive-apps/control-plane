import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { agentCreateIds } from "../orchestration/agentProtocol.ts";
import { RemoteAgents, RemoteAgentsLive, type CreateRemoteInput } from "./RemoteAgents.ts";
import { RemoteAgentStore } from "./RemoteAgentStore.ts";
import {
  MemoryRemoteAgentStore,
  TEST_NOW,
  makeFakePeer,
  makePeerThread,
  makeRecord,
  type FakePeerOptions,
} from "./testFixtures.ts";

const ids = agentCreateIds("coordinator", "request-1");

const createInput = (overrides: Partial<CreateRemoteInput> = {}): CreateRemoteInput => ({
  machineId: "mini",
  machineLabel: "Mac Mini",
  peerProjectId: "peer-project",
  home: {
    project: { id: "project-1", title: "Acme", workspaceRoot: "/work/acme" },
    label: "This Mac",
  },
  creator: { id: "coordinator", title: "Acme" },
  ids,
  threadId: "remote-1",
  title: "Pricing",
  message: "Compare plans.",
  runtimeMode: "approval-required",
  baseModel: { instanceId: "codex" as never, model: "gpt-5.4" },
  requestedModel: undefined,
  createdAt: TEST_NOW,
  ...overrides,
});

const harness = (options?: FakePeerOptions) => {
  const peer = makeFakePeer(options);
  const layer = RemoteAgentsLive.pipe(
    Layer.provideMerge(peer.layer),
    Layer.provideMerge(MemoryRemoteAgentStore),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, RemoteAgents | RemoteAgentStore>) =>
    effect.pipe(Effect.provide(layer));
  return { peer, run };
};

describe("RemoteAgents.reserve and start", () => {
  it.effect("creates the peer thread and sends the first message with no creator or replyTo", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const record = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const reserved = yield* remote.reserve(createInput());
          expect(reserved.existed).toBe(false);
          expect(reserved.record.state).toBe("pending");
          return yield* remote.start(createInput(), reserved.record);
        }),
      );

      expect(peer.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      const [create, start] = peer.commands;
      expect(create).toMatchObject({
        commandId: ids.createCommandId,
        threadId: "remote-1",
        projectId: "peer-project",
        title: "Pricing",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
      });
      expect(create).not.toHaveProperty("createdByThreadId");
      expect(start?.type === "thread.turn.start" && start.message.source).toEqual({
        kind: "agent",
        threadId: "coordinator",
        threadTitle: "Acme",
      });
      if (start?.type === "thread.turn.start") {
        expect(start.message.messageId).toBe(ids.messageId);
        expect(start.message.text).toContain("You are running on Mac Mini");
        expect(start.message.text).toContain("Compare plans.");
        expect(start.runtimeMode).toBe("approval-required");
      }
      expect(record.state).toBe("open");
      expect(record.inFlight).toMatchObject({
        messageId: ids.messageId,
        replyTo: "coordinator",
        baselineTurnId: null,
        suppressed: false,
      });
    }),
  );

  it.effect(
    "uses the peer Project's default model, else the base; an explicit model keeps the base instance",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        yield* run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            const reserved = yield* remote.reserve(createInput({ requestedModel: "gpt-5.4-mini" }));
            yield* remote.start(createInput({ requestedModel: "gpt-5.4-mini" }), reserved.record);
          }),
        );
        expect(peer.commands[0]).toMatchObject({
          modelSelection: { instanceId: "codex", model: "gpt-5.4-mini" },
        });
      }),
  );

  it.effect("drops the record when the create never reached the peer", () =>
    Effect.gen(function* () {
      const { peer, run } = harness({ failOn: ["thread.create"] });
      const outcome = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const store = yield* RemoteAgentStore;
          const reserved = yield* remote.reserve(createInput());
          const failure = yield* Effect.flip(remote.start(createInput(), reserved.record));
          return { failure, left: yield* store.list };
        }),
      );
      expect(outcome.failure.stage).toBe("create");
      expect(outcome.left).toEqual([]);
      expect(peer.commands).toEqual([]);
    }),
  );

  it.effect(
    "keeps the record pending when only the first message failed, and a retry finishes it",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness({ failOn: ["thread.turn.start"] });
        const result = yield* run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            const store = yield* RemoteAgentStore;
            const reserved = yield* remote.reserve(createInput());
            const failure = yield* Effect.flip(remote.start(createInput(), reserved.record));
            const pending = yield* store.get("remote-1");
            return { failure, pending };
          }),
        );
        expect(result.failure.stage).toBe("start");
        expect(Option.getOrThrow(result.pending).state).toBe("pending");

        // The same ids on a healthy peer: reserve finds the record, start sends again.
        const retry = harness();
        const finished = yield* retry.run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            const store = yield* RemoteAgentStore;
            yield* store.put(Option.getOrThrow(result.pending));
            const again = yield* remote.reserve(createInput());
            expect(again.existed).toBe(true);
            return yield* remote.start(createInput(), again.record);
          }),
        );
        expect(finished.state).toBe("open");
        expect(peer.commands.map((command) => command.type)).toEqual(["thread.create"]);
      }),
  );

  it.effect(
    "returns an open record with a request in flight as it is (a retry after a landed start)",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        const record = makeRecord({
          state: "open",
          inFlight: {
            messageId: "cp-agent-message:x",
            replyTo: "coordinator",
            sentAt: TEST_NOW,
            baselineTurnId: null,
            suppressed: false,
          },
        });
        const result = yield* run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            return yield* remote.start(createInput(), record);
          }),
        );
        expect(result).toEqual(record);
        expect(peer.commands).toEqual([]);
      }),
  );
});

describe("RemoteAgents.openCount, find, list", () => {
  it.effect("counts pending agents and open agents with a request in flight, per Project", () =>
    Effect.gen(function* () {
      const { run } = harness();
      const inFlight = {
        messageId: "m",
        replyTo: "coordinator",
        sentAt: TEST_NOW,
        baselineTurnId: null,
        suppressed: false,
      };
      const counts = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord({ threadId: "a", state: "pending" }));
          yield* store.put(makeRecord({ threadId: "b", state: "open", inFlight }));
          yield* store.put(makeRecord({ threadId: "c", state: "open", inFlight: null }));
          yield* store.put(makeRecord({ threadId: "d", state: "settled" }));
          yield* store.put(makeRecord({ threadId: "e", state: "lost", inFlight }));
          yield* store.put(
            makeRecord({ threadId: "f", state: "pending", homeProjectId: "project-2" }),
          );
          return {
            first: yield* remote.openCount("project-1"),
            other: yield* remote.openCount("project-2"),
          };
        }),
      );
      expect(counts).toEqual({ first: 2, other: 1 });
    }),
  );

  it.effect("finds by id in any Project and by title only in the given Project", () =>
    Effect.gen(function* () {
      const { run } = harness();
      const found = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord({ threadId: "a", title: "Pricing" }));
          yield* store.put(
            makeRecord({ threadId: "b", title: "Pricing", homeProjectId: "project-2" }),
          );
          return {
            byId: yield* remote.find({ projectId: "project-1", ref: "b" }),
            byTitle: yield* remote.find({ projectId: "project-1", ref: " pricing " }),
          };
        }),
      );
      expect(found.byId.map((record) => record.threadId)).toEqual(["b"]);
      expect(found.byTitle.map((record) => record.threadId)).toEqual(["a"]);
    }),
  );

  it.effect("lists an open agent as stale while its machine is unreachable", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.state.reachable = false;
      const listed = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord({ threadId: "a", lastPhase: "running" }));
          yield* store.put(makeRecord({ threadId: "b", state: "settled", lastPhase: "completed" }));
          return yield* remote.list("project-1");
        }),
      );
      expect(listed.map((entry) => [entry.record.threadId, entry.phase])).toEqual([
        ["a", "stale"],
        ["b", "completed"],
      ]);
    }),
  );
});

describe("RemoteAgents.read", () => {
  it.effect("maps the peer's messages to requests and results", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.threads.set(
        "remote-1",
        makePeerThread("remote-1", {
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: TEST_NOW,
            startedAt: TEST_NOW,
            completedAt: TEST_NOW,
            assistantMessageId: null,
          },
        }),
      );
      peer.details.set("remote-1", {
        messages: [
          { id: "m1", role: "user", text: "Compare plans.", streaming: false },
          { id: "m2", role: "assistant", text: "Plan B wins.", streaming: false },
        ] as never,
      });
      const read = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          return yield* remote.read(makeRecord(), 1);
        }),
      );
      expect(read.turns).toEqual([
        { state: "completed", request: "Compare plans.", result: "Plan B wins." },
      ]);
      expect(read.phase).toBe("completed");
    }),
  );

  it.effect("says so when the peer thread is gone", () =>
    Effect.gen(function* () {
      const { run } = harness();
      const failure = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          return yield* Effect.flip(remote.read(makeRecord(), 1));
        }),
      );
      expect(failure.detail).toContain("no longer on Mac Mini");
    }),
  );

  it.effect("names the machine when it cannot be reached", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.state.reachable = false;
      const failure = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          return yield* Effect.flip(remote.read(makeRecord(), 1));
        }),
      );
      expect(failure.detail).toContain("Could not reach Mac Mini");
    }),
  );
});

describe("RemoteAgents.stop", () => {
  const inFlight = {
    messageId: "m",
    replyTo: "coordinator",
    sentAt: TEST_NOW,
    baselineTurnId: null,
    suppressed: false,
  };

  it.effect("suppresses the result first, interrupts a working agent, and stops its session", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const outcome = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(
            makeRecord({
              inFlight,
              queuedSends: [
                { messageId: "q", text: "later", replyTo: "coordinator", queuedAt: TEST_NOW },
              ],
            }),
          );
          const stopped = yield* remote.stop(
            makeRecord({
              inFlight,
              queuedSends: [
                { messageId: "q", text: "later", replyTo: "coordinator", queuedAt: TEST_NOW },
              ],
            }),
            { archive: false },
          );
          return { stopped, record: Option.getOrThrow(yield* store.get("remote-1")) };
        }),
      );
      expect(outcome.stopped).toEqual({ stopped: true, archived: false });
      expect(peer.commands.map((command) => command.type)).toEqual([
        "thread.turn.interrupt",
        "thread.session.stop",
      ]);
      expect(outcome.record.inFlight).toBeNull();
      expect(outcome.record.queuedSends).toEqual([]);
    }),
  );

  it.effect("does not interrupt an idle agent, and reports nothing was stopped", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const stopped = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord());
          return yield* remote.stop(makeRecord(), { archive: false });
        }),
      );
      expect(stopped.stopped).toBe(false);
      expect(peer.commands.map((command) => command.type)).toEqual(["thread.session.stop"]);
    }),
  );

  it.effect("archives on request and settles the record", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const record = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord());
          yield* remote.stop(makeRecord(), { archive: true });
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(peer.commands.map((command) => command.type)).toEqual([
        "thread.session.stop",
        "thread.archive",
      ]);
      expect(record.state).toBe("settled");
      expect(record.endedAt).not.toBeNull();
    }),
  );
});

describe("RemoteAgents.send and startQueued", () => {
  const sender = { id: "coordinator", title: "Acme" };

  it.effect(
    "starts a turn on an idle agent, recording the turn before the send as the baseline",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        peer.threads.set(
          "remote-1",
          makePeerThread("remote-1", {
            latestTurn: {
              turnId: "turn-1" as never,
              state: "completed",
              requestedAt: TEST_NOW,
              startedAt: TEST_NOW,
              completedAt: TEST_NOW,
              assistantMessageId: null,
            },
          }),
        );
        const outcome = yield* run(
          Effect.gen(function* () {
            const store = yield* RemoteAgentStore;
            const remote = yield* RemoteAgents;
            yield* store.put(makeRecord({ state: "settled", endedAt: TEST_NOW }));
            const sent = yield* remote.send(makeRecord(), {
              text: "Also compare annual pricing.",
              sender,
              replyTo: "coordinator",
              runtimeMode: "approval-required",
            });
            return { sent, record: Option.getOrThrow(yield* store.get("remote-1")) };
          }),
        );
        expect(outcome.sent).toEqual({ queued: false });
        expect(peer.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
        const start = peer.commands[0];
        expect(start?.type === "thread.turn.start" && start.message.messageId).toMatch(
          /^cp-remote-send:remote-1:/,
        );
        expect(outcome.record.state).toBe("open");
        expect(outcome.record.inFlight?.baselineTurnId).toBe("turn-1");
      }),
  );

  it.effect("queues a send while a request is in flight, and sends nothing", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.threads.set("remote-1", makePeerThread("remote-1"));
      const inFlightRecord = makeRecord({
        inFlight: {
          messageId: "m",
          replyTo: "coordinator",
          sentAt: TEST_NOW,
          baselineTurnId: null,
          suppressed: false,
        },
      });
      const outcome = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(inFlightRecord);
          const sent = yield* remote.send(inFlightRecord, {
            text: "Then do this.",
            sender,
            replyTo: "coordinator",
            runtimeMode: "approval-required",
          });
          return { sent, record: Option.getOrThrow(yield* store.get("remote-1")) };
        }),
      );
      expect(outcome.sent).toEqual({ queued: true });
      expect(peer.commands).toEqual([]);
      expect(outcome.record.queuedSends.map((entry) => entry.text)).toEqual(["Then do this."]);
    }),
  );

  it.effect(
    "starts the oldest queued send once the peer is idle, and takes it off the queue first",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        const queuedRecord = makeRecord({
          queuedSends: [
            {
              messageId: "cp-remote-send:remote-1:q1",
              text: "First.",
              replyTo: "coordinator",
              queuedAt: TEST_NOW,
            },
            {
              messageId: "cp-remote-send:remote-1:q2",
              text: "Second.",
              replyTo: "coordinator",
              queuedAt: TEST_NOW,
            },
          ],
        });
        const view = makePeerThread("remote-1");
        const record = yield* run(
          Effect.gen(function* () {
            const store = yield* RemoteAgentStore;
            const remote = yield* RemoteAgents;
            yield* store.put(queuedRecord);
            yield* remote.startQueued(queuedRecord, view);
            return Option.getOrThrow(yield* store.get("remote-1"));
          }),
        );
        const start = peer.commands[0];
        expect(start?.type === "thread.turn.start" && start.message.text).toBe("First.");
        expect(record.queuedSends.map((entry) => entry.text)).toEqual(["Second."]);
        expect(record.inFlight?.messageId).toBe("cp-remote-send:remote-1:q1");
      }),
  );

  it.effect("does not start a queued send while the peer is busy", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const queuedRecord = makeRecord({
        queuedSends: [
          {
            messageId: "cp-remote-send:remote-1:q1",
            text: "First.",
            replyTo: "coordinator",
            queuedAt: TEST_NOW,
          },
        ],
      });
      const busy = makePeerThread("remote-1", { hasPendingApprovals: true });
      yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(queuedRecord);
          yield* remote.startQueued(queuedRecord, busy);
        }),
      );
      expect(peer.commands).toEqual([]);
    }),
  );
});
