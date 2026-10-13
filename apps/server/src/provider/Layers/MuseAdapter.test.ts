import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { MspError } from "@muse-code/sdk";
import {
  ApprovalRequestId,
  EnvironmentId,
  MUSE_DEFAULT_MODEL,
  MuseSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { clearAssistantRuntime, setAssistantRuntime } from "../assistantRuntime.ts";
import type { MuseItem } from "../museProtocol.ts";
import type { MuseSdkHost } from "../museSdk.ts";
import { makeMuseAdapter, type MuseAdapterOptions } from "./MuseAdapter.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "muse-adapter-test" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const INSTANCE_ID = ProviderInstanceId.make("muse");
const THREAD_ID = ThreadId.make("thread-muse-test");
const MODEL = "muse-spark-1.3";
const museSettings = Schema.decodeSync(MuseSettings)({ enabled: true });
const disabledSettings = Schema.decodeSync(MuseSettings)({ enabled: false });

interface NativeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly commandId?: string;
}

function pendingPromise<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** SDK-shaped transport fake: registration returns void, as the SDK does. */
const makeFakeMuse = Effect.fnUntraced(function* (options?: { readonly sessionMcp?: boolean }) {
  const requests = yield* Queue.unbounded<NativeCall>();
  const calls: NativeCall[] = [];
  const closed = pendingPromise<void>();
  const exited = pendingPromise<Awaited<MuseSdkHost["exited"]>>();
  let notify: Parameters<MuseSdkHost["connection"]["onNotification"]>[0] = () => {};
  let sequence = 0;
  let sessionId = "";
  let closeCount = 0;
  const responses = new Map<string, Array<Record<string, unknown> | Error>>();
  const respond = async (call: NativeCall): Promise<Record<string, unknown>> => {
    calls.push(call);
    Queue.offerUnsafe(requests, call);
    if (["session/start", "session/resume"].includes(call.method))
      sessionId = String(call.params.sessionId);
    const queued = responses.get(call.method)?.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    switch (call.method) {
      case "session/start":
      case "session/resume":
        return { session: { sessionId, modelId: MODEL, activeTurnId: null } };
      case "turn/start":
        return { turnId: call.commandId };
      case "turn/steer":
        return { turnId: call.params.expectedTurnId };
      default:
        return {};
    }
  };
  const host: MuseSdkHost = {
    connection: {
      mintCommandId: () => `native-${++sequence}`,
      command: (method, params, commandOptions) =>
        respond({
          method,
          params,
          ...(commandOptions?.commandId ? { commandId: commandOptions.commandId } : {}),
        }),
      request: (method, params = {}) => respond({ method, params }),
      onNotification: (handler) => {
        notify = handler;
      },
      onProtocolError: () => {},
      onServerRequest: () => {},
      closed: closed.promise,
    },
    initializeResult: { grantedCapabilities: options?.sessionMcp === false ? [] : ["sessionMcp"] },
    exited: exited.promise,
    close: async () => {
      closeCount += 1;
      closed.resolve();
    },
  };
  return {
    host,
    calls,
    closeCount: () => closeCount,
    crash: (code = 1) => Effect.sync(() => exited.resolve({ code, signal: null })),
    queueResponse: (method: string, result: Record<string, unknown> | Error) => {
      responses.set(method, [...(responses.get(method) ?? []), result]);
    },
    emit: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        notify({ jsonrpc: "2.0", method, params: { sessionId, ...params } });
      }),
    takeCall: Effect.fnUntraced(function* (method: string) {
      while (true) {
        const call = yield* Queue.take(requests);
        if (call.method === method) return call;
      }
    }),
  };
});
type FakeMuse = Effect.Success<ReturnType<typeof makeFakeMuse>>;

const makeHarness = Effect.fnUntraced(function* (
  fake: FakeMuse,
  overrides: Partial<Pick<MuseAdapterOptions, "modelCatalog" | "settings">> = {},
) {
  const adapter = yield* makeMuseAdapter({
    instanceId: INSTANCE_ID,
    settings: overrides.settings ?? museSettings,
    environment: {},
    createHost: async () => fake.host,
    requestTimeoutMs: 2_000,
    ...(overrides.modelCatalog ? { modelCatalog: overrides.modelCatalog } : {}),
  });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const takeEvent = Effect.fnUntraced(function* <T extends ProviderRuntimeEvent["type"]>(type: T) {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === type) return event as Extract<ProviderRuntimeEvent, { type: T }>;
    }
  });
  return { adapter, events, takeEvent };
});

const start = (harness: Effect.Success<ReturnType<typeof makeHarness>>, resumeCursor?: unknown) =>
  harness.adapter.startSession({
    threadId: THREAD_ID,
    cwd: process.cwd(),
    runtimeMode: "full-access",
    modelSelection: { instanceId: INSTANCE_ID, model: MODEL },
    ...(resumeCursor ? { resumeCursor } : {}),
  });

const textOf = (call: NativeCall) =>
  (call.params.input as ReadonlyArray<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("");

const item = (fields: Partial<MuseItem> & Pick<MuseItem, "itemId" | "kind">): MuseItem => ({
  status: "inProgress",
  revision: 1,
  ...fields,
});

describe("MuseAdapter", () => {
  it.effect("starts a native session and streams a turn's reply to completion", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const session = yield* start(harness);
      const opened = fake.calls.find((call) => call.method === "session/start")!;
      assert.strictEqual(opened.params.approvalMode, "allowAll");
      assert.strictEqual(opened.params.providerId, "meta");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: opened.params.sessionId,
      });
      assert.strictEqual(
        (yield* harness.takeEvent("thread.started")).payload.providerThreadId,
        opened.params.sessionId,
      );

      const result = yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "List files" });
      const turnStart = yield* fake.takeCall("turn/start");
      assert.strictEqual(result.turnId, turnStart.commandId);
      assert.strictEqual(turnStart.params.displayText, "List files");
      assert.strictEqual(turnStart.params.ifBusy, "queue");
      assert.ok(textOf(turnStart).endsWith("\n\nList files"));
      assert.strictEqual((yield* harness.takeEvent("turn.started")).turnId, result.turnId);

      const turnId = turnStart.commandId!;
      yield* fake.emit("item/started", {
        item: item({ itemId: "msg", kind: "agentMessage", turnId, text: "" }),
      });
      yield* fake.emit("item/delta", { turnId, itemId: "msg", delta: "Hello" });
      yield* fake.emit("item/delta", { turnId, itemId: "msg", delta: " there" });
      yield* fake.emit("item/completed", {
        item: item({
          itemId: "msg",
          kind: "agentMessage",
          turnId,
          status: "completed",
          revision: 2,
          text: "Hello there!",
        }),
      });
      yield* fake.emit("turn/completed", {
        turnId,
        terminal: "completed",
        usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 2, reasoningTokens: 1 },
      });
      const completed = yield* harness.takeEvent("turn.completed");
      assert.strictEqual(completed.payload.state, "completed");
      assert.deepInclude(completed.payload.tokenUsage, { inputTokens: 10, outputTokens: 4 });

      const deltas = (yield* harness.adapter.readThread(THREAD_ID)).turns;
      assert.strictEqual(deltas.length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("streams message text exactly once across deltas and full revisions", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      const turnId = (yield* fake.takeCall("turn/start")).commandId!;
      yield* fake.emit("item/started", {
        item: item({ itemId: "msg", kind: "agentMessage", turnId, text: "Hel" }),
      });
      yield* fake.emit("item/delta", { turnId, itemId: "msg", delta: "lo" });
      yield* fake.emit("item/completed", {
        item: item({
          itemId: "msg",
          kind: "agentMessage",
          turnId,
          status: "completed",
          revision: 2,
          text: "Hello",
        }),
      });
      yield* fake.emit("turn/completed", { turnId, terminal: "completed" });
      const seen: ProviderRuntimeEvent[] = [];
      while (seen.at(-1)?.type !== "turn.completed") seen.push(yield* Queue.take(harness.events));
      const text = seen.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );
      assert.strictEqual(text.join(""), "Hello");
      assert.deepStrictEqual(
        seen.filter((event) => event.itemId === "msg").map((event) => event.type),
        ["item.started", "content.delta", "content.delta", "item.completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("sends the full Project block on the first turn and the pointer after", () =>
    Effect.gen(function* () {
      setAssistantRuntime(THREAD_ID, {
        roleKey: "agent",
        inline: "<project>FULL BLOCK</project>",
        pointer: "<project>POINTER</project>",
      });
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
      const first = yield* fake.takeCall("turn/start");
      assert.include(textOf(first), "FULL BLOCK");
      assert.include(textOf(first), "Muse Code harness");
      yield* fake.emit("turn/completed", { turnId: first.commandId, terminal: "completed" });
      yield* harness.takeEvent("turn.completed");

      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "second" });
      const second = yield* fake.takeCall("turn/start");
      assert.include(textOf(second), "POINTER");
      assert.notInclude(textOf(second), "FULL BLOCK");
    }).pipe(
      Effect.ensuring(Effect.sync(() => clearAssistantRuntime(THREAD_ID))),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect("connects the thread's MCP credential as an optional server", () =>
    Effect.gen(function* () {
      setMcpProviderSession({
        environmentId: EnvironmentId.make("env"),
        threadId: THREAD_ID,
        providerSessionId: "provider-session",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: "Bearer secret",
        capabilities: new Set(),
      });
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      const opened = fake.calls.find((call) => call.method === "session/start")!;
      assert.deepStrictEqual(opened.params.config, {
        mcpServers: {
          cplane: {
            transport: "streamableHttp",
            mode: "optional",
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      });

      const old = yield* makeFakeMuse({ sessionMcp: false });
      const oldHarness = yield* makeHarness(old);
      const failure = yield* Effect.flip(start(oldHarness));
      assert.include(failure.message, "session MCP");
    }).pipe(
      Effect.ensuring(Effect.sync(() => clearMcpProviderSession(THREAD_ID))),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect("resumes a stored session and starts over when Muse no longer has it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness, { schemaVersion: 1, sessionId: "kept" });
      const resume = fake.calls.find((call) => call.method === "session/resume")!;
      assert.strictEqual(resume.params.sessionId, "kept");
      assert.strictEqual(resume.params.excludeItems, true);
      assert.ok(fake.calls.some((call) => call.method === "session/setApprovalMode"));

      const gone = yield* makeFakeMuse();
      gone.queueResponse(
        "session/resume",
        new MspError({ code: -32004, message: "gone", data: { kind: "sessionNotFound" } } as never),
      );
      const goneHarness = yield* makeHarness(gone);
      const session = yield* start(goneHarness, { schemaVersion: 1, sessionId: "lost" });
      const fresh = gone.calls.find((call) => call.method === "session/start");
      assert.ok(fresh, "a missing session starts a fresh one");
      assert.notStrictEqual((session.resumeCursor as { sessionId: string }).sessionId, "lost");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resolves the default model from the catalog and switches models between turns", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const catalog: ReadonlyArray<ServerProviderModel> = [
        { slug: "muse-wonder-1.0", name: "Wonder", isCustom: false, capabilities: null },
        { slug: MODEL, name: "Spark", isCustom: false, isDefault: true, capabilities: null },
      ];
      const harness = yield* makeHarness(fake, { modelCatalog: Effect.succeed(catalog) });
      yield* harness.adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: INSTANCE_ID, model: MUSE_DEFAULT_MODEL },
      });
      const opened = fake.calls.find((call) => call.method === "session/start")!;
      assert.strictEqual(opened.params.modelId, MODEL);
      assert.strictEqual(opened.params.approvalMode, "promptUnmatched");

      yield* harness.adapter.sendTurn({
        threadId: THREAD_ID,
        input: "go",
        modelSelection: { instanceId: INSTANCE_ID, model: "muse-wonder-1.0" },
      });
      const setModel = yield* fake.takeCall("session/setModel");
      assert.deepStrictEqual(setModel.params.model, {
        modelId: "muse-wonder-1.0",
        providerId: "meta",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("opens approvals, sends the chosen native choice, and keeps the user's decision", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "rm" });
      const turnId = (yield* fake.takeCall("turn/start")).commandId!;
      yield* fake.emit("approval/requested", {
        approvalId: "ap-1",
        turnId,
        toolName: "shell",
        currentRequirementId: { approvalId: "ap-1", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "c-yes", label: "Allow once", decision: "approved", scope: "once" },
          {
            choiceId: "c-session",
            label: "Allow for session",
            decision: "approvedForSession",
            scope: "session",
          },
          { choiceId: "c-no", label: "Reject", decision: "abort", scope: "once" },
        ],
        subject: { kind: "shell", command: "rm -rf build" },
      });
      const opened = yield* harness.takeEvent("request.opened");
      assert.strictEqual(opened.payload.requestType, "command_execution_approval");
      assert.strictEqual(opened.payload.detail, "rm -rf build");
      assert.deepStrictEqual(
        opened.payload.options?.map((option) => option.decision),
        ["accept", "acceptForSession", "decline"],
      );

      yield* harness.adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(String(opened.requestId)),
        "decline",
      );
      const decide = yield* fake.takeCall("approval/decide");
      assert.strictEqual(decide.params.choiceId, "c-no");
      yield* fake.emit("approval/resolved", { approvalId: "ap-1", decision: "abort" });
      const resolved = yield* harness.takeEvent("request.resolved");
      assert.strictEqual(resolved.payload.decision, "decline");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("approves a workflow child's approval in full access", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* fake.emit("approval/requested", {
        approvalId: "child-ap",
        turnId: "child-run",
        subagentOrigin: { subagentId: "child" },
        currentRequirementId: { approvalId: "child-ap", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "c-yes", label: "Allow", decision: "approved", scope: "once" },
        ],
        subject: { kind: "shell", command: "ls" },
      });
      const decide = yield* fake.takeCall("approval/decide");
      assert.strictEqual(decide.params.choiceId, "c-yes");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("validates structured answers and keeps selected labels with a custom note", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "ask" });
      const turnId = (yield* fake.takeCall("turn/start")).commandId!;
      yield* fake.emit("userInput/requested", {
        userInputId: "q-1",
        turnId,
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Which colors?",
            options: [{ label: "Red" }, { label: "Blue", description: "Cool" }],
            selection: { mode: "multiple", minSelections: 1 },
          },
        ],
      });
      const requested = yield* harness.takeEvent("user-input.requested");
      assert.strictEqual(requested.payload.questions[0]?.multiSelect, true);
      const requestId = ApprovalRequestId.make(String(requested.requestId));

      const tooLong = yield* Effect.flip(
        harness.adapter.respondToUserInput(THREAD_ID, requestId, { color: "x".repeat(501) }),
      );
      assert.include(tooLong.message, "500");
      yield* harness.adapter.respondToUserInput(THREAD_ID, requestId, {
        color: ["Red", "Blue", "teal please"],
      });
      const answer = yield* fake.takeCall("userInput/answer");
      assert.deepStrictEqual(answer.params.answers, [
        { questionId: "color", selectedLabels: ["Red", "Blue"], note: "teal please" },
      ]);
      yield* harness.takeEvent("user-input.resolved");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers a running turn and interrupts it, joined turns included", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      const first = yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "work" });
      const turnId = (yield* fake.takeCall("turn/start")).commandId!;
      const steered = yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "faster" });
      assert.strictEqual(steered.turnId, first.turnId);
      const steer = yield* fake.takeCall("turn/steer");
      assert.strictEqual(steer.params.expectedTurnId, turnId);

      // Muse starts a report turn on its own; the running turn shows it.
      yield* fake.emit("turn/started", { turnId: "muse-report" });
      // Notifications run in order; the todo list confirms the join was handled.
      yield* fake.emit("session/todoListChanged", { items: [] });
      yield* harness.takeEvent("turn.plan.updated");
      yield* harness.adapter.interruptTurn(THREAD_ID);
      const interrupts = [
        yield* fake.takeCall("turn/interrupt"),
        yield* fake.takeCall("turn/interrupt"),
      ];
      assert.deepStrictEqual(
        interrupts.map((call) => call.params.turnId),
        ["muse-report", turnId],
      );
      yield* fake.emit("turn/completed", { turnId, terminal: "cancelled" });
      assert.strictEqual((yield* harness.takeEvent("turn.completed")).payload.state, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows tools and todos, and keeps a workflow's rows after its turn ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "go" });
      const turnId = (yield* fake.takeCall("turn/start")).commandId!;
      yield* fake.emit("item/started", {
        item: item({ itemId: "sh", kind: "userShell", turnId, commandText: "ls" }),
      });
      const started = yield* harness.takeEvent("item.started");
      assert.strictEqual(started.payload.itemType, "command_execution");
      yield* fake.emit("item/completed", {
        item: item({
          itemId: "sh",
          kind: "userShell",
          turnId,
          status: "completed",
          revision: 2,
          commandText: "ls",
          visibleOutput: "a.txt",
          exitCode: 0,
        }),
      });
      assert.strictEqual((yield* harness.takeEvent("item.completed")).payload.status, "completed");

      yield* fake.emit("session/todoListChanged", {
        items: [
          { text: "Read", status: "completed" },
          { text: "Write", status: "inProgress" },
          { text: "Skip", status: "cancelled" },
        ],
      });
      const plan = yield* harness.takeEvent("turn.plan.updated");
      assert.deepStrictEqual(plan.payload.plan, [
        { step: "Read", status: "completed" },
        { step: "Write", status: "inProgress" },
      ]);

      yield* fake.emit("item/started", {
        item: item({ itemId: "wf", kind: "workflow", turnId, entryId: "review" }),
      });
      yield* harness.takeEvent("item.started");
      yield* fake.emit("turn/completed", { turnId, terminal: "completed" });
      yield* harness.takeEvent("turn.completed");
      yield* fake.emit("item/completed", {
        item: item({
          itemId: "wf",
          kind: "workflow",
          turnId,
          status: "completed",
          revision: 2,
          entryId: "review",
          finalSummary: "All good",
        }),
      });
      const workflowDone = yield* harness.takeEvent("item.completed");
      assert.strictEqual(workflowDone.itemId, "wf");
      assert.strictEqual(workflowDone.turnId, turnId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the active turn and ends the session when Muse exits", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "go" });
      yield* fake.takeCall("turn/start");
      yield* fake.crash(7);
      const completed = yield* harness.takeEvent("turn.completed");
      assert.strictEqual(completed.payload.state, "failed");
      assert.include(completed.payload.errorMessage, "Muse exited unexpectedly (7)");
      assert.strictEqual((yield* harness.takeEvent("session.exited")).payload.exitKind, "error");
      assert.isFalse(yield* harness.adapter.hasSession(THREAD_ID));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("surfaces a failed turn's error, and skips unreadable usage notifications", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "go" });
      const turnId = (yield* fake.takeCall("turn/start")).commandId!;
      yield* fake.emit("session/tokenUsage", { turnId, promptTokens: "lots" });
      yield* fake.emit("turn/completed", {
        turnId,
        terminal: "failed",
        error: { message: "API error 402: Billing verification failed." },
      });
      const completed = yield* harness.takeEvent("turn.completed");
      assert.strictEqual(completed.payload.state, "failed");
      assert.include(completed.payload.errorMessage, "402");
      assert.isTrue(yield* harness.adapter.hasSession(THREAD_ID));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects Plan mode, a disabled instance, and closes its host on stop", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* start(harness);
      const plan = yield* Effect.flip(
        harness.adapter.sendTurn({ threadId: THREAD_ID, input: "plan", interactionMode: "plan" }),
      );
      assert.include(plan.message, "Plan mode");
      yield* harness.adapter.stopSession(THREAD_ID);
      assert.strictEqual(fake.closeCount(), 1);
      assert.strictEqual((yield* harness.takeEvent("session.exited")).payload.exitKind, "graceful");

      const disabled = yield* makeHarness(yield* makeFakeMuse(), {
        settings: disabledSettings,
      });
      const failure = yield* Effect.flip(start(disabled));
      assert.include(failure.message, "disabled");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
