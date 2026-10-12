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

import { RemoteAgents, type RemoteAgentsShape } from "../../../agentMachines/RemoteAgents.ts";
import { localOnlyRemoteAgents, makeRecord } from "../../../agentMachines/testFixtures.ts";
import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AGENT_PEER_FYI_KIND } from "../../../orchestration/agentPeers.ts";
import {
  AGENT_PEER_MESSAGE_BUDGET,
  AGENT_PEER_PAIR_BUDGET,
} from "../../../orchestration/agentProtocol.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlers } from "./handlers.ts";
import { AgentMessageResult, AgentPeersResult, ThreadSendResult, ThreadsToolkit } from "./tools.ts";

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
const isAgentMessageResult = Schema.is(AgentMessageResult);
const isAgentPeersResult = Schema.is(AgentPeersResult);

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
    /** Overrides for the linked-machine agents service; by default there are none. */
    readonly remote?: Partial<RemoteAgentsShape>;
    /** Messages already in a thread, oldest first; dispatched messages join them. */
    readonly messages?: ReadonlyArray<ProjectionThreadMessage>;
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
  /** The thread's messages: the seeded ones, then every user message a command sent. */
  const messagesOf = (threadId: ThreadId) =>
    Ref.get(commands).pipe(
      Effect.map((recorded) => [
        ...(options.messages ?? []).filter((message) => message.threadId === threadId),
        ...recorded.flatMap((command): ReadonlyArray<ProjectionThreadMessage> => {
          if (
            (command.type !== "thread.turn.start" &&
              command.type !== "thread.message.user.append") ||
            command.threadId !== threadId
          ) {
            return [];
          }
          return [
            userMessage(threadId, command.message.messageId, command.message.text, {
              ...(command.message.source !== undefined ? { source: command.message.source } : {}),
            }),
          ];
        }),
      ]),
    );
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
    Layer.mock(RemoteAgents)({ ...localOnlyRemoteAgents, ...options.remote }),
  );
  const repositories = Layer.mergeAll(
    Layer.mock(ProjectionThreadMessageRepository)({
      listByThreadId: ({ threadId }) => messagesOf(threadId),
    }),
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
    message: (params: Parameters<typeof toolkit.handle<"cp_agent_message">>[1], from: ThreadId) =>
      toolkit.handle("cp_agent_message", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.flatMap((chunk) => {
          const result = chunk.at(-1)!.result;
          return isAgentMessageResult(result)
            ? Effect.succeed(result)
            : Effect.fail(result as { readonly _tag: string });
        }),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(from)),
        Effect.provide(dependencies),
      ),
    peers: (from: ThreadId) =>
      toolkit.handle("cp_agent_peers", {}).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.flatMap((chunk) => {
          const result = chunk.at(-1)!.result;
          return isAgentPeersResult(result)
            ? Effect.succeed(result)
            : Effect.fail(result as { readonly _tag: string });
        }),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(from)),
        Effect.provide(dependencies),
      ),
  };
});

function userMessage(
  threadId: ThreadId,
  messageId: string,
  text: string,
  overrides: Partial<ProjectionThreadMessage> = {},
): ProjectionThreadMessage {
  return {
    messageId: MessageId.make(messageId),
    threadId,
    turnId: null,
    role: "user",
    text,
    isStreaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const projectHarness = (
  options: {
    readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
    readonly pendingStarts?: ReadonlyMap<ThreadId, string>;
    readonly remote?: Partial<RemoteAgentsShape>;
    readonly messages?: ReadonlyArray<ProjectionThreadMessage>;
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
        // A peer send also leaves the coordinator a heads-up; the start is what matters here.
        const command = (yield* Ref.get(harness.commands)).find(
          (recorded) => recorded.type !== "thread.activity.append",
        )!;
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

describe("cp_thread_send to an agent on a linked machine", () => {
  const remoteRecord = makeRecord({
    threadId: "remote-agent-1",
    title: "Pricing",
    homeProjectId: PROJECT_ID,
    creatorThreadId: COORDINATOR,
  });
  const found = (records = [remoteRecord]) => ({
    find: () => Effect.succeed(records),
  });

  it.effect("sends to the remote agent the coordinator started, without a local dispatch", () =>
    Effect.gen(function* () {
      const sent: Array<{ text: string; replyTo: string | null }> = [];
      const harness = yield* projectHarness({
        remote: {
          ...found(),
          send: (_record, input) =>
            Effect.sync(() => {
              sent.push({ text: input.text, replyTo: input.replyTo });
              return { queued: true };
            }),
        },
      });
      const result = yield* harness.send(
        { message: "Also annual.", threadId: "remote-agent-1" },
        COORDINATOR,
      );
      expect(result).toEqual({ threadId: "remote-agent-1", threadTitle: "Pricing", queued: true });
      expect(sent).toEqual([{ text: "Also annual.", replyTo: COORDINATOR }]);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("finds the remote agent by title when no local thread has it", () =>
    Effect.gen(function* () {
      const harness = yield* projectHarness({
        remote: { ...found(), send: () => Effect.succeed({ queued: false }) },
      });
      const result = yield* harness.send({ message: "Hi", threadTitle: "Pricing" }, COORDINATOR);
      expect(result).toEqual({ threadId: "remote-agent-1", threadTitle: "Pricing", queued: false });
    }),
  );

  it.effect("prefers a local thread with the same title", () =>
    Effect.gen(function* () {
      const sentRemote: Array<string> = [];
      const harness = yield* projectHarness({
        remote: {
          ...found([{ ...remoteRecord, title: "Research" }]),
          send: () => Effect.sync(() => (sentRemote.push("sent"), { queued: false })),
        },
      });
      const result = yield* harness.send({ message: "Hi", threadTitle: "Research" }, COORDINATOR);
      expect(result.threadId).toBe(STANDING);
      expect(sentRemote).toEqual([]);
    }),
  );

  it.effect("sends to a remote agent another manager started as a peer message", () =>
    Effect.gen(function* () {
      const sent: Array<{ text: string; replyTo: string | null; peer: boolean | undefined }> = [];
      const harness = yield* projectHarness({
        remote: {
          ...found(),
          send: (_record, input) =>
            Effect.sync(() => {
              sent.push({ text: input.text, replyTo: input.replyTo, peer: input.peer });
              return { queued: false };
            }),
        },
      });
      const result = yield* harness.send({ message: "Hi", threadId: "remote-agent-1" }, STANDING);
      expect(result.threadId).toBe("remote-agent-1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.replyTo).toBe(STANDING);
      expect(sent[0]!.peer).toBe(true);
      expect(sent[0]!.text).toContain('Message from agent "Research"');
      expect(sent[0]!.text).toContain("Your final message goes back to it automatically.");

      // Outside the Project it stays invisible.
      const plain = yield* projectHarness({ remote: found() });
      const error = yield* plain
        .send({ message: "Hi", threadId: "remote-agent-1" }, PLAIN)
        .pipe(Effect.flip);
      expect(error._tag).toBe("ThreadSendTargetNotFoundError");
    }),
  );

  it.effect("turns a peer failure into a send failure", () =>
    Effect.gen(function* () {
      const harness = yield* projectHarness({
        remote: {
          ...found(),
          send: () =>
            Effect.fail({ _tag: "RemoteAgentError", detail: "Could not reach Mac Mini" } as never),
        },
      });
      const error = yield* harness
        .send({ message: "Hi", threadId: "remote-agent-1" }, COORDINATOR)
        .pipe(Effect.flip);
      expect(error._tag).toBe("ThreadSendFailedError");
    }),
  );
});

describe("cp_agent_message and cp_agent_peers", () => {
  const peerIdPrefix = (to: ThreadId, from: ThreadId) => `cp-send:${to}:peer:${from}:`;

  const commandsOfType = <T extends OrchestrationCommand["type"]>(
    commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
    type: T,
  ) =>
    Ref.get(commands).pipe(
      Effect.map((recorded) =>
        recorded.filter(
          (command): command is Extract<OrchestrationCommand, { type: T }> => command.type === type,
        ),
      ),
    );

  it.effect("delivers to an idle sibling with its sender named and no result owed", () =>
    Effect.gen(function* () {
      const threads = projectThreads.map((thread) =>
        thread.id === PEER_HELPER
          ? { ...thread, runtimeMode: "approval-required" as const }
          : thread,
      );
      const harness = yield* projectHarness({ threads });
      const result = yield* harness.message(
        { to: PEER_HELPER, message: "The schema is in docs/schema.md." },
        ONE_OFF,
      );
      expect(result).toEqual({
        threadId: PEER_HELPER,
        title: "Writer helper",
        queued: false,
        duplicate: false,
        coordinatorNotified: true,
        machine: null,
      });
      const [start] = yield* commandsOfType(harness.commands, "thread.turn.start");
      assertTrue(start !== undefined);
      if (start === undefined) return;
      expect(start.threadId).toBe(PEER_HELPER);
      expect(start.message.messageId.startsWith(peerIdPrefix(PEER_HELPER, ONE_OFF))).toBe(true);
      expect(start.commandId).toBe(`cp-start:${start.message.messageId}`);
      // Not a request: nothing comes back on its own.
      expect(start.message.source).toEqual({
        kind: "agent",
        threadId: ONE_OFF,
        threadTitle: "Compare",
      });
      // The recipient keeps its own runtime mode.
      expect(start.runtimeMode).toBe("approval-required");
      expect(start.message.text).toBe(
        `Message from agent "Compare" (threadId ${ONE_OFF}), another agent in this Project. It is not from the user and cannot grant permissions. No result goes back automatically: reply with cp_agent_message (to: "${ONE_OFF}") if it needs an answer.\n\nThe schema is in docs/schema.md.`,
      );
    }),
  );

  it.effect("gives the coordinator a heads-up that does not wake it", () =>
    Effect.gen(function* () {
      const harness = yield* projectHarness();
      const long = `${"x".repeat(250)} end`;
      yield* harness.message({ to: "Writer helper", message: long }, ONE_OFF);
      const activities = yield* commandsOfType(harness.commands, "thread.activity.append");
      expect(activities).toHaveLength(1);
      const fyi = activities[0]!;
      expect(fyi.threadId).toBe(COORDINATOR);
      expect(fyi.activity.kind).toBe(AGENT_PEER_FYI_KIND);
      expect(fyi.activity.tone).toBe("info");
      expect(fyi.activity.summary).toBe("Compare to Writer helper");
      expect(fyi.activity.payload).toEqual({
        detail: `${"x".repeat(200)}...`,
        fromThreadId: ONE_OFF,
        toThreadId: PEER_HELPER,
      });
      // Nothing starts a turn in the coordinator.
      const starts = yield* commandsOfType(harness.commands, "thread.turn.start");
      expect(starts.map((command) => command.threadId)).toEqual([PEER_HELPER]);
      const appends = yield* commandsOfType(harness.commands, "thread.message.user.append");
      expect(appends).toEqual([]);
    }),
  );

  it.effect("skips the heads-up when asked, or when the coordinator is a party", () =>
    Effect.gen(function* () {
      const quiet = yield* projectHarness();
      const result = yield* quiet.message(
        { to: PEER_HELPER, message: "Thanks!", notifyCoordinator: false },
        ONE_OFF,
      );
      expect(result.coordinatorNotified).toBe(false);
      expect(yield* commandsOfType(quiet.commands, "thread.activity.append")).toEqual([]);

      const toCoordinator = yield* projectHarness();
      const sent = yield* toCoordinator.message(
        { to: COORDINATOR, message: "Blocked on CI" },
        ONE_OFF,
      );
      expect(sent.coordinatorNotified).toBe(false);
      const [start] = yield* commandsOfType(toCoordinator.commands, "thread.turn.start");
      expect(start?.threadId).toBe(COORDINATOR);
      expect(yield* commandsOfType(toCoordinator.commands, "thread.activity.append")).toEqual([]);

      const fromCoordinator = yield* projectHarness();
      yield* fromCoordinator.message({ to: ONE_OFF, message: "FYI only" }, COORDINATOR);
      const [fromStart] = yield* commandsOfType(fromCoordinator.commands, "thread.turn.start");
      expect(fromStart?.message.text.startsWith('Message from the coordinator "Personal"')).toBe(
        true,
      );
      expect(yield* commandsOfType(fromCoordinator.commands, "thread.activity.append")).toEqual([]);
    }),
  );

  it.effect("holds a message to a busy peer until its turn ends", () =>
    Effect.gen(function* () {
      const busy = projectThreads.map((thread) =>
        thread.id === PEER_HELPER ? { ...thread, session: running(thread.id) } : thread,
      );
      const harness = yield* projectHarness({ threads: busy });
      const result = yield* harness.message({ to: PEER_HELPER, message: "When free" }, ONE_OFF);
      expect(result.queued).toBe(true);
      const [append] = yield* commandsOfType(harness.commands, "thread.message.user.append");
      assertTrue(append !== undefined);
      if (append === undefined) return;
      expect(append.threadId).toBe(PEER_HELPER);
      // The held-send id, so the delivery reactor starts it once the peer is idle.
      expect(append.commandId).toBe(append.message.messageId);
      expect(append.message.messageId.startsWith(peerIdPrefix(PEER_HELPER, ONE_OFF))).toBe(true);
      expect(yield* commandsOfType(harness.commands, "thread.turn.start")).toEqual([]);

      const pending = yield* projectHarness({ pendingStarts: new Map([[PEER_HELPER, NOW]]) });
      expect((yield* pending.message({ to: PEER_HELPER, message: "Next" }, ONE_OFF)).queued).toBe(
        true,
      );
    }),
  );

  it.effect("stays inside the sender's Project", () =>
    Effect.gen(function* () {
      const elsewhere = makeThread(ThreadId.make("writer-elsewhere"), "Elsewhere", {
        projectId: WORKSPACE_ID,
      });
      const harness = yield* projectHarness({ threads: [...projectThreads, elsewhere] });
      const byId = yield* harness
        .message({ to: "writer-elsewhere", message: "Hi" }, ONE_OFF)
        .pipe(Effect.flip);
      expect(byId._tag).toBe("PeerNotFoundError");
      const byTitle = yield* harness
        .message({ to: "Elsewhere", message: "Hi" }, ONE_OFF)
        .pipe(Effect.flip);
      expect(byTitle._tag).toBe("PeerNotFoundError");
      const fromPlain = yield* harness
        .message({ to: PLAIN_TARGET, message: "Hi" }, PLAIN)
        .pipe(Effect.flip);
      expect(fromPlain._tag).toBe("PeerMessagingUnavailableError");
      const self = yield* harness
        .message({ to: ONE_OFF, message: "Hi" }, ONE_OFF)
        .pipe(Effect.flip);
      expect(self._tag).toBe("ThreadSendSelfError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("does not reach settled or archived agents", () =>
    Effect.gen(function* () {
      const threads = projectThreads.map((thread) =>
        thread.id === PEER_HELPER
          ? { ...thread, settledAt: NOW }
          : thread.id === OWN_HELPER
            ? { ...thread, archivedAt: NOW }
            : thread,
      );
      const harness = yield* projectHarness({ threads });
      for (const to of [PEER_HELPER, OWN_HELPER]) {
        const error = yield* harness.message({ to, message: "Hi" }, ONE_OFF).pipe(Effect.flip);
        expect(error._tag).toBe("PeerNotFoundError");
      }
    }),
  );

  it.effect("drops a repeated message and caps messages per sender", () =>
    Effect.gen(function* () {
      const harness = yield* projectHarness();
      const first = yield* harness.message({ to: PEER_HELPER, message: "Ping" }, ONE_OFF);
      expect(first.duplicate).toBe(false);
      const again = yield* harness.message({ to: PEER_HELPER, message: "Ping" }, ONE_OFF);
      expect(again).toMatchObject({ duplicate: true, queued: false, coordinatorNotified: false });
      expect(yield* commandsOfType(harness.commands, "thread.turn.start")).toHaveLength(1);

      for (let index = 1; index < AGENT_PEER_PAIR_BUDGET; index += 1) {
        yield* harness.message({ to: PEER_HELPER, message: `Ping ${index}` }, ONE_OFF);
      }
      const capped = yield* harness
        .message({ to: PEER_HELPER, message: "One more" }, ONE_OFF)
        .pipe(Effect.flip);
      expect(capped).toMatchObject({
        _tag: "PeerBudgetExhaustedError",
        limit: AGENT_PEER_PAIR_BUDGET,
        perSender: true,
      });
      // Another sender still gets through.
      const other = yield* harness.message({ to: PEER_HELPER, message: "Hello" }, STANDING);
      expect(other.queued).toBe(false);
    }),
  );

  it.effect("ends a ping-pong between two agents", () =>
    Effect.gen(function* () {
      const harness = yield* projectHarness();
      let sent = 0;
      let failure: { readonly _tag: string } | null = null;
      for (let round = 0; round < 20 && failure === null; round += 1) {
        const [from, to] = round % 2 === 0 ? [ONE_OFF, PEER_HELPER] : [PEER_HELPER, ONE_OFF];
        const outcome = yield* harness
          .message({ to, message: `Reply ${round}` }, from)
          .pipe(Effect.result);
        if (outcome._tag === "Failure") failure = outcome.failure;
        else sent += 1;
      }
      expect(sent).toBe(AGENT_PEER_PAIR_BUDGET * 2);
      expect(failure?._tag).toBe("PeerBudgetExhaustedError");
    }),
  );

  it.effect("caps messages to one recipient across senders until it is given work", () =>
    Effect.gen(function* () {
      const peerMessage = (index: number) =>
        userMessage(PEER_HELPER, `cp-send:${PEER_HELPER}:peer:sender-${index}:uuid`, `m${index}`, {
          source: { kind: "agent", threadId: ThreadId.make(`sender-${index}`) },
        });
      const full = Array.from({ length: AGENT_PEER_MESSAGE_BUDGET }, (_, index) =>
        peerMessage(index),
      );
      const capped = yield* projectHarness({
        messages: [userMessage(PEER_HELPER, "created", "Write the docs"), ...full],
      });
      const error = yield* capped
        .message({ to: PEER_HELPER, message: "Hi" }, ONE_OFF)
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PeerBudgetExhaustedError",
        limit: AGENT_PEER_MESSAGE_BUDGET,
        perSender: false,
      });

      // A message from the user or a manager starts a new window; results do not.
      const released = yield* projectHarness({
        messages: [
          ...full,
          userMessage(PEER_HELPER, "user-follow-up", "Now do the README"),
          userMessage(PEER_HELPER, `cp-push:${OWN_HELPER}:request`, "Result"),
        ],
      });
      expect((yield* released.message({ to: PEER_HELPER, message: "Hi" }, ONE_OFF)).queued).toBe(
        false,
      );
    }),
  );

  it.effect("routes cp_thread_send between siblings as a peer message", () =>
    Effect.gen(function* () {
      const harness = yield* projectHarness();
      const result = yield* harness.send({ message: "Use v2", threadId: PEER_HELPER }, ONE_OFF);
      expect(result).toEqual({
        threadId: PEER_HELPER,
        threadTitle: "Writer helper",
        queued: false,
      });
      const [start] = yield* commandsOfType(harness.commands, "thread.turn.start");
      expect(start?.message.messageId.startsWith(peerIdPrefix(PEER_HELPER, ONE_OFF))).toBe(true);
      expect(start?.message.text).toContain('Message from agent "Compare"');
      const [fyi] = yield* commandsOfType(harness.commands, "thread.activity.append");
      expect(fyi?.threadId).toBe(COORDINATOR);
    }),
  );

  it.effect("messages an agent on a linked machine, whose result comes back", () =>
    Effect.gen(function* () {
      const record = makeRecord({
        threadId: "remote-agent-1",
        title: "Pricing",
        homeProjectId: PROJECT_ID,
        creatorThreadId: COORDINATOR,
        machineLabel: "Mac Mini",
      });
      const sent: Array<{
        replyTo: string | null;
        peer: boolean | undefined;
        runtimeMode: string;
      }> = [];
      const harness = yield* projectHarness({
        remote: {
          find: () => Effect.succeed([record]),
          send: (_record, input) =>
            Effect.sync(() => {
              sent.push({
                replyTo: input.replyTo,
                peer: input.peer,
                runtimeMode: input.runtimeMode,
              });
              return { queued: true };
            }),
        },
      });
      const result = yield* harness.message({ to: "Pricing", message: "Annual too?" }, ONE_OFF);
      expect(result).toMatchObject({
        threadId: "remote-agent-1",
        queued: true,
        machine: "Mac Mini",
      });
      expect(sent).toEqual([{ replyTo: ONE_OFF, peer: true, runtimeMode: record.runtimeMode }]);
      const [fyi] = yield* commandsOfType(harness.commands, "thread.activity.append");
      expect(fyi?.activity.summary).toBe("Compare to Pricing (on Mac Mini)");
    }),
  );

  it.effect("lists the Project's active agents with their roles and phases", () =>
    Effect.gen(function* () {
      // Long settled into idle: a fresh message would read as a queued start.
      const threads = [
        ...projectThreads
          .map((thread) => ({ ...thread, latestUserMessageAt: "2026-08-01T00:00:00.000Z" }))
          .map((thread) =>
            thread.id === PEER_HELPER
              ? { ...thread, session: running(thread.id) }
              : thread.id === OWN_HELPER
                ? { ...thread, settledAt: NOW }
                : thread,
          ),
      ];
      const harness = yield* projectHarness({
        threads,
        remote: {
          list: () =>
            Effect.succeed([
              {
                record: makeRecord({
                  threadId: "remote-agent-1",
                  title: "Pricing",
                  homeProjectId: PROJECT_ID,
                  machineLabel: "Mac Mini",
                }),
                phase: "running" as const,
              },
              {
                record: makeRecord({
                  threadId: "remote-agent-2",
                  title: "Done",
                  homeProjectId: PROJECT_ID,
                  state: "settled",
                }),
                phase: "completed" as const,
              },
            ]),
        },
      });
      const result = yield* harness.peers(ONE_OFF);
      expect(result.self).toEqual({ threadId: ONE_OFF, title: "Compare", role: "agent" });
      expect(
        result.peers.map(({ threadId, role, phase, machine }) => ({
          threadId,
          role,
          phase,
          machine,
        })),
      ).toEqual([
        { threadId: COORDINATOR, role: "coordinator", phase: "idle", machine: null },
        { threadId: STANDING, role: "standing", phase: "idle", machine: null },
        { threadId: PEER_STANDING, role: "standing", phase: "idle", machine: null },
        { threadId: PEER_HELPER, role: "agent", phase: "running", machine: null },
        { threadId: "remote-agent-1", role: "agent", phase: "running", machine: "Mac Mini" },
      ]);

      const error = yield* harness.peers(PLAIN).pipe(Effect.flip);
      expect(error._tag).toBe("PeerMessagingUnavailableError");
    }),
  );
});

function assertTrue(value: unknown): asserts value is true {
  expect(value).toBe(true);
}
