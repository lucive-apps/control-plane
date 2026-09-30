import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import {
  DEMO_APPROVAL_REQUEST_ID,
  DEMO_PROJECT_IDS,
  DEMO_QUESTION_REQUEST_ID,
  DEMO_THREAD_IDS,
  DEMO_UNAVAILABLE_MESSAGE,
} from "./demoFixtures";
import {
  DEMO_APPROVAL_REPLY_TEXT,
  DEMO_REPLY_TEXT,
  DemoModeUnavailableError,
  DemoServer,
} from "./demoServer";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function makeServer() {
  const timers: Array<() => void> = [];
  const server = new DemoServer({
    now: () => NOW,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const flushReplies = () => {
    for (const callback of timers.splice(0)) callback();
  };
  return { server, timers, flushReplies };
}

function shellRow(server: DemoServer, threadId: string) {
  return server.shellSnapshot().threads.find((thread) => thread.id === threadId);
}

describe("DemoServer commands", () => {
  it("answers a sent message with a canned reply", () => {
    const { server, flushReplies } = makeServer();
    const threadId = ThreadId.make(DEMO_THREAD_IDS.rateLimit);
    const before = server.thread(threadId)!.messages.length;

    const receipt = server.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("demo-command-1"),
      threadId,
      message: {
        messageId: MessageId.make("demo-user-message"),
        role: "user",
        text: "Can you also cover /signup?",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date(NOW).toISOString(),
    });

    assert.isAbove(receipt.sequence, 1);
    assert.strictEqual(server.thread(threadId)!.messages.length, before + 1);
    assert.strictEqual(server.thread(threadId)!.latestTurn?.state, "running");

    flushReplies();
    const thread = server.thread(threadId)!;
    assert.strictEqual(thread.messages.length, before + 2);
    assert.strictEqual(thread.messages.at(-1)?.text, DEMO_REPLY_TEXT);
    assert.strictEqual(thread.latestTurn?.state, "completed");
    assert.strictEqual(thread.session?.status, "ready");
  });

  it("creates a new task's thread from the bootstrap and replies", () => {
    const { server, flushReplies } = makeServer();
    const threadId = ThreadId.make("demo-new-task");
    server.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("demo-command-new"),
      threadId,
      message: {
        messageId: MessageId.make("demo-new-message"),
        role: "user",
        text: "Add a changelog page",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make(DEMO_PROJECT_IDS.web),
          title: "Add a changelog page",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date(NOW).toISOString(),
        },
      },
      createdAt: new Date(NOW).toISOString(),
    });

    assert.strictEqual(shellRow(server, threadId)?.title, "Add a changelog page");
    flushReplies();
    assert.strictEqual(server.thread(threadId)!.messages.at(-1)?.text, DEMO_REPLY_TEXT);
  });

  it("resolves the pending approval locally", () => {
    const { server, flushReplies } = makeServer();
    const threadId = ThreadId.make(DEMO_THREAD_IDS.darkMode);
    assert.isTrue(shellRow(server, threadId)?.hasPendingApprovals);

    server.dispatch({
      type: "thread.approval.respond",
      commandId: CommandId.make("demo-command-2"),
      threadId,
      requestId: ApprovalRequestId.make(DEMO_APPROVAL_REQUEST_ID),
      decision: "accept",
      createdAt: new Date(NOW).toISOString(),
    });

    assert.isFalse(shellRow(server, threadId)?.hasPendingApprovals);
    flushReplies();
    assert.strictEqual(server.thread(threadId)!.messages.at(-1)?.text, DEMO_APPROVAL_REPLY_TEXT);
  });

  it("resolves the pending question locally", () => {
    const { server } = makeServer();
    const threadId = ThreadId.make(DEMO_THREAD_IDS.pricingCopy);
    assert.isTrue(shellRow(server, threadId)?.hasPendingUserInput);

    server.dispatch({
      type: "thread.user-input.respond",
      commandId: CommandId.make("demo-command-3"),
      threadId,
      requestId: ApprovalRequestId.make(DEMO_QUESTION_REQUEST_ID),
      answers: { tone: "Direct" },
      createdAt: new Date(NOW).toISOString(),
    });

    assert.isFalse(shellRow(server, threadId)?.hasPendingUserInput);
  });

  it("settles and pins threads", () => {
    const { server } = makeServer();
    const threadId = ThreadId.make(DEMO_THREAD_IDS.slowSearch);
    server.dispatch({ type: "thread.pin", commandId: CommandId.make("c-pin"), threadId });
    assert.isNotNull(shellRow(server, threadId)?.pinnedAt);
    server.dispatch({ type: "thread.settle", commandId: CommandId.make("c-settle"), threadId });
    assert.isNotNull(shellRow(server, threadId)?.settledAt);
  });

  it("stops pending replies on dispose", () => {
    const { server, timers } = makeServer();
    server.dispatch({
      type: "thread.approval.respond",
      commandId: CommandId.make("demo-command-4"),
      threadId: ThreadId.make(DEMO_THREAD_IDS.darkMode),
      requestId: ApprovalRequestId.make(DEMO_APPROVAL_REQUEST_ID),
      decision: "accept",
      createdAt: new Date(NOW).toISOString(),
    });
    assert.strictEqual(timers.length, 1);
    server.dispose();
    assert.strictEqual(timers.length, 0);
  });
});

describe("DemoServer session", () => {
  it.effect("streams the shell snapshot, then the completion marker", () =>
    Effect.gen(function* () {
      const { server } = makeServer();
      const items = yield* server
        .makeSession()
        .client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true })
        .pipe(Stream.take(2), Stream.runCollect);
      const [first, second] = Array.from(items);
      assert.strictEqual(first?.kind, "snapshot");
      assert.strictEqual(second?.kind, "synchronized");
    }),
  );

  it.effect("pushes live thread updates to subscribers", () =>
    Effect.gen(function* () {
      const { server } = makeServer();
      const threadId = ThreadId.make(DEMO_THREAD_IDS.pricingCopy);
      const session = server.makeSession();
      const fiber = yield* session.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId,
      }).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      // Let the subscription register before the command lands.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      server.dispatch({ type: "thread.settle", commandId: CommandId.make("c-live"), threadId });
      const [initial, update] = Array.from(yield* Fiber.join(fiber));
      assert.strictEqual(initial?.kind, "snapshot");
      assert.strictEqual(update?.kind, "snapshot");
      if (update?.kind === "snapshot") assert.isNotNull(update.snapshot.thread.settledAt);
    }),
  );

  it.effect("serves the server config without a network", () =>
    Effect.gen(function* () {
      const { server } = makeServer();
      const session = server.makeSession();
      const config = yield* session.initialConfig;
      assert.strictEqual(config.environment.label, "Demo Mac");
      const events = yield* session
        .subscribeServerConfig({})
        .pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(Array.from(events)[0]?.type, "snapshot");
      yield* session.client[WS_METHODS.serverProbe]({});
    }),
  );

  it.effect("fails unsupported requests with a friendly demo message", () =>
    Effect.gen(function* () {
      const { server } = makeServer();
      // The demo fails requests the real schema declares infallible.
      const error: unknown = yield* server
        .makeSession()
        .client[WS_METHODS.vcsListRefs]({ cwd: "/Users/demo/Code/acme-web" })
        .pipe(Effect.flip);
      assert.instanceOf(error, DemoModeUnavailableError);
      assert.strictEqual((error as DemoModeUnavailableError).message, DEMO_UNAVAILABLE_MESSAGE);
    }),
  );
});
