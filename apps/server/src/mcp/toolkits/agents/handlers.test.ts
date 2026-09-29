import {
  EnvironmentId,
  isOpaqueThreadId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ServerProvider,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../../../orchestration/Errors.ts";
import { AGENT_RUNNING_CAP } from "../../../orchestration/agentProtocol.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../../persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../../../persistence/Services/ProjectionTurns.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AGENT_READ_REQUEST_CAP_BYTES, AGENT_READ_RESULT_CAP_BYTES } from "./agentScope.ts";
import { AgentsToolkitHandlers } from "./handlers.ts";
import {
  AgentCreateResult,
  AgentListResult,
  AgentReadResult,
  AgentStopResult,
  AgentsToolkit,
} from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const COORDINATOR_ID = ThreadId.make("coordinator");
const RESEARCH_ID = ThreadId.make("research");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
// TestClock starts at the epoch; this timestamp is "now" for queued-start checks.
const NOW = "1970-01-01T00:00:00.000Z";
const LONG_AGO = "2026-08-20T00:00:00.000Z";

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: LONG_AGO,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const running = (id: string, overrides: Partial<OrchestrationThreadShell> = {}) =>
  makeThread(id, {
    session: {
      threadId: ThreadId.make(id),
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: LONG_AGO,
    },
    ...overrides,
  });

/** `count` running agents with distinct ids, for filling the Project's running cap. */
const runningAgents = (count: number) =>
  Array.from({ length: count }, (_, index) => running(`agent-${index + 1}`));

const coordinator = makeThread("coordinator", { title: "Acme" });
const research = makeThread("research", { title: "Research", pinnedAt: LONG_AGO });

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Acme",
  workspaceRoot: "/work/acme",
  defaultModelSelection: null,
  assistant: { coordinatorThreadId: COORDINATOR_ID },
  scripts: [],
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
};

function makeProvider(
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<{ slug: string; name: string; aliases?: ReadonlyArray<string> }>,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(instanceId),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: LONG_AGO,
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

const providers = [
  makeProvider(CODEX, [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini", aliases: ["mini"] },
  ]),
  makeProvider(CLAUDE, [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6" }]),
];

function makeMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  source?: OrchestrationMessage["source"],
  streaming = false,
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    ...(source ? { source } : {}),
    turnId: null,
    streaming,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
  };
}

interface TurnInput {
  /** Null for a turn start the provider has not picked up yet. */
  readonly turnId: string | null;
  readonly request: string | null;
  readonly result?: string;
  readonly state: ProjectionTurn["state"];
  readonly requestedAt: string;
}

function makeTurn(threadId: string, turn: TurnInput): ProjectionTurn {
  return {
    threadId: ThreadId.make(threadId),
    turnId: turn.turnId === null ? null : TurnId.make(turn.turnId),
    pendingMessageId: turn.request === null ? null : MessageId.make(turn.request),
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: turn.result === undefined ? null : MessageId.make(turn.result),
    state: turn.state,
    requestedAt: turn.requestedAt,
    startedAt: turn.turnId === null ? null : turn.requestedAt,
    completedAt: null,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
  };
}

interface HarnessInput {
  readonly caller: ThreadId;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly project?: OrchestrationProjectShell;
  readonly creators?: Readonly<Record<string, ThreadId>>;
  readonly messages?: Readonly<Record<string, ReadonlyArray<OrchestrationMessage>>>;
  readonly turns?: Readonly<Record<string, ReadonlyArray<TurnInput>>>;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  /** Fails this command type once, as a dispatch that crashed or was cancelled. */
  readonly failOnce?: OrchestrationCommand["type"];
  /** Rejects this command type once; like the engine, its id then stays rejected. */
  readonly rejectOnce?: OrchestrationCommand["type"];
  /** Holds `thread.create` until the gate opens; `reached` fires when it gets there. */
  readonly createGate?: {
    readonly reached: Deferred.Deferred<void>;
    readonly open: Deferred.Deferred<void>;
  };
}

/**
 * Fake engine and projections: dispatched creates, pins and first messages
 * update the shells the next call reads, as the real projection does inside
 * dispatch, so the cap sees agents created a moment ago.
 */
const makeHarness = Effect.fn("makeAgentsToolkitHarness")(function* (input: HarnessInput) {
  const threads = new Map(input.threads.map((thread) => [thread.id, thread]));
  const creators = new Map(Object.entries(input.creators ?? {}));
  const projects = [input.project ?? project, { ...project, id: OTHER_PROJECT_ID }];
  const commands: Array<OrchestrationCommand> = [];
  const live = () => [...threads.values()];
  const messages = new Map<string, ProjectionThreadMessage>();
  const addMessage = (threadId: string, message: OrchestrationMessage) =>
    messages.set(message.id, {
      messageId: message.id,
      threadId: ThreadId.make(threadId),
      turnId: message.turnId,
      role: message.role,
      text: message.text,
      ...(message.source ? { source: message.source } : {}),
      isStreaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    });
  for (const [threadId, list] of Object.entries(input.messages ?? {})) {
    for (const message of list) addMessage(threadId, message);
  }
  const turns = new Map(
    Object.entries(input.turns ?? {}).map(([threadId, list]) => [
      threadId,
      list.map((turn) => makeTurn(threadId, turn)),
    ]),
  );
  let failOnce = input.failOnce;
  let rejectOnce = input.rejectOnce;
  const rejectedIds = new Set<string>();

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      // Lets a concurrent create run its cap check between these steps.
      yield* Effect.yieldNow;
      if (command.type === "thread.create" && input.createGate) {
        yield* Deferred.succeed(input.createGate.reached, undefined);
        yield* Deferred.await(input.createGate.open);
      }
      if (command.type === failOnce) {
        failOnce = undefined;
        return yield* Effect.die(new Error(`${command.type} failed`));
      }
      if (rejectedIds.has(command.commandId)) {
        return yield* new OrchestrationCommandPreviouslyRejectedError({
          commandId: command.commandId,
          detail: "Previously rejected.",
        });
      }
      if (command.type === rejectOnce) {
        rejectOnce = undefined;
        rejectedIds.add(command.commandId);
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Rejected.",
        });
      }
      commands.push(command);
      if (command.type === "thread.create") {
        threads.set(
          command.threadId,
          makeThread(command.threadId, {
            projectId: command.projectId,
            title: command.title,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            latestUserMessageAt: null,
          }),
        );
        if (command.createdByThreadId) creators.set(command.threadId, command.createdByThreadId);
      } else if (command.type === "thread.pin") {
        const thread = threads.get(command.threadId)!;
        threads.set(command.threadId, { ...thread, pinnedAt: NOW });
      } else if (command.type === "thread.turn.start") {
        const thread = threads.get(command.threadId)!;
        threads.set(command.threadId, { ...thread, latestUserMessageAt: command.createdAt });
        addMessage(command.threadId, {
          ...makeMessage(command.message.messageId, "user", command.message.text),
          ...(command.message.source ? { source: command.message.source } : {}),
        });
        // The projection records a start the provider has not picked up yet.
        turns.set(command.threadId, [
          ...(turns.get(command.threadId) ?? []),
          makeTurn(command.threadId, {
            turnId: null,
            request: command.message.messageId,
            state: "pending",
            requestedAt: command.createdAt,
          }),
        ]);
      }
      return { sequence: commands.length };
    });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          Option.fromNullishOr(threads.get(threadId)).pipe(
            Option.filter((thread) => thread.archivedAt === null),
          ),
        ),
      getProjectShellById: (projectId) =>
        Effect.succeed(Option.fromNullishOr(projects.find((entry) => entry.id === projectId))),
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 1, projects, threads: live(), updatedAt: LONG_AGO }),
    }),
    Layer.mock(ProjectionTurnRepository)({
      listByThreadId: ({ threadId }) => Effect.succeed(turns.get(threadId) ?? []),
    }),
    // Read only by the schedule tools, which scheduleHandlers.test.ts covers.
    Layer.mock(ProjectionProjectRepository)({}),
    Layer.mock(ProjectionThreadMessageRepository)({
      getByMessageId: ({ messageId }) =>
        Effect.succeed(Option.fromNullishOr(messages.get(messageId))),
      listByThreadId: ({ threadId }) =>
        Effect.succeed([...messages.values()].filter((message) => message.threadId === threadId)),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(AgentLineage, {
      creatorOf: (threadId) => Effect.succeed(creators.get(threadId) ?? null),
    }),
    makeProviderRegistryLayer(providers),
    NodeServices.layer,
  );
  const toolkit = yield* AgentsToolkit.pipe(
    Effect.provide(AgentsToolkitHandlers.pipe(Layer.provide(dependencies))),
  );
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: input.caller,
    providerSessionId: "provider-session-1",
    providerInstanceId: CODEX,
    capabilities: new Set(input.capabilities ?? ["agents"]),
    issuedAt: 1,
  };
  /**
   * Runs a handler as the caller. A failure fails the effect; the final result
   * is decoded with the tool's success schema, which also checks its shape.
   */
  const run = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
    handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
    success: S,
  ) =>
    handled.pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => Schema.decodeUnknownSync(success)(chunk.at(-1)!.result)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(dependencies),
    );
  return {
    commands,
    threads,
    create: (params: Parameters<typeof toolkit.handle<"cp_agent_create">>[1]) =>
      run(toolkit.handle("cp_agent_create", params), AgentCreateResult),
    list: (params: Parameters<typeof toolkit.handle<"cp_agent_list">>[1] = {}) =>
      run(toolkit.handle("cp_agent_list", params), AgentListResult),
    read: (params: Parameters<typeof toolkit.handle<"cp_agent_read">>[1]) =>
      run(toolkit.handle("cp_agent_read", params), AgentReadResult),
    stop: (params: Parameters<typeof toolkit.handle<"cp_agent_stop">>[1]) =>
      run(toolkit.handle("cp_agent_stop", params), AgentStopResult),
  };
});

const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) => command.type);

function createCommand(commands: ReadonlyArray<OrchestrationCommand>) {
  const command = commands.find((entry) => entry.type === "thread.create");
  if (command?.type !== "thread.create") throw new Error("No thread.create was dispatched.");
  return command;
}

describe("cp_agent_create", () => {
  it.effect("starts a one-off agent that reports back to its creator", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });

      const result = yield* harness.create({ title: "Pricing", message: "Compare plans." });

      expect(result.created).toBe(true);
      expect(isOpaqueThreadId(result.threadId)).toBe(true);
      expect(commandTypes(harness.commands)).toEqual(["thread.create", "thread.turn.start"]);
      const create = createCommand(harness.commands);
      expect(create).toMatchObject({
        threadId: result.threadId,
        projectId: PROJECT_ID,
        title: "Pricing",
        createdByThreadId: COORDINATOR_ID,
        branch: null,
        worktreePath: null,
        interactionMode: "default",
      });
      const start = harness.commands[1];
      if (start?.type !== "thread.turn.start") throw new Error("Expected a turn start.");
      expect(start.message.text).toBe("Compare plans.");
      expect(start.message.source).toEqual({
        kind: "agent",
        threadId: COORDINATOR_ID,
        threadTitle: "Acme",
        replyTo: COORDINATOR_ID,
      });
    }),
  );

  it.effect("pins a standing agent between its creation and its first message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });

      yield* harness.create({ title: "Research", message: "Stand by.", standing: true });

      expect(commandTypes(harness.commands)).toEqual([
        "thread.create",
        "thread.pin",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("refuses a standing agent from a standing agent and dispatches nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: RESEARCH_ID, threads: [coordinator, research] });

      const error = yield* harness
        .create({ title: "Archive", message: "Keep records.", standing: true })
        .pipe(Effect.flip);

      expect(error._tag).toBe("StandingAgentNotAllowedError");
      expect(harness.commands).toEqual([]);
    }),
  );

  it.effect("fails at the running cap, counting a first message no turn adopted yet", () =>
    Effect.gen(function* () {
      const busy = runningAgents(AGENT_RUNNING_CAP - 1);
      const atCap = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [running("coordinator", { title: "Acme" }), ...busy, running("last")],
      });
      const justCreated = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, ...busy, makeThread("fresh", { latestUserMessageAt: NOW })],
      });

      for (const harness of [atCap, justCreated]) {
        const error = yield* harness
          .create({ title: "Over the cap", message: "Go." })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ConcurrencyLimitError",
          limit: AGENT_RUNNING_CAP,
          running: AGENT_RUNNING_CAP,
        });
        expect(harness.commands).toEqual([]);
      }
    }),
  );

  it.effect("lets exactly one of two concurrent creates past the last slot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, ...runningAgents(AGENT_RUNNING_CAP - 1)],
      });

      const exits = yield* Effect.all(
        [
          Effect.exit(harness.create({ title: "One", message: "Go." })),
          Effect.exit(harness.create({ title: "Two", message: "Go." })),
        ],
        { concurrency: "unbounded" },
      );

      expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
      expect(harness.commands.filter((command) => command.type === "thread.create")).toHaveLength(
        1,
      );
    }),
  );

  it.effect("returns the same agent for a repeated clientRequestId, even at the cap", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, ...runningAgents(AGENT_RUNNING_CAP - 1)],
      });
      const params = { title: "Pricing", message: "Compare plans.", clientRequestId: "req-1" };

      const first = yield* harness.create(params);
      const dispatched = harness.commands.length;
      const second = yield* harness.create(params);
      const conflict = yield* harness
        .create({ ...params, title: "Something else" })
        .pipe(Effect.flip);

      expect(first.created).toBe(true);
      expect(second).toEqual({ ...first, created: false });
      expect(harness.commands).toHaveLength(dispatched);
      expect(conflict).toMatchObject({
        _tag: "ClientRequestIdConflictError",
        clientRequestId: "req-1",
        threadId: first.threadId,
      });
    }),
  );

  it.effect("refuses a clientRequestId whose agent was archived or deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });
      const params = { title: "Pricing", message: "Compare plans.", clientRequestId: "req-2" };
      const first = yield* harness.create(params);
      harness.threads.delete(first.threadId);

      const error = yield* harness.create(params).pipe(Effect.flip);

      expect(error._tag).toBe("AgentToolFailedError");
    }),
  );

  it.effect("a retry sends the first message a failed create never delivered, once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator],
        failOnce: "thread.turn.start",
      });
      const params = {
        title: "Research",
        message: "Stand by.",
        standing: true,
        clientRequestId: "req-3",
      };

      const failed = yield* harness.create(params).pipe(Effect.flip);
      const retried = yield* harness.create(params);
      const again = yield* harness.create(params);

      expect(failed._tag).toBe("AgentToolFailedError");
      expect(retried.created).toBe(false);
      expect(again).toEqual(retried);
      // The pin landed the first time; only the missing first message is sent.
      expect(commandTypes(harness.commands)).toEqual([
        "thread.create",
        "thread.pin",
        "thread.turn.start",
      ]);
      const start = harness.commands[2];
      if (start?.type !== "thread.turn.start") throw new Error("Expected a turn start.");
      expect(start.commandId).toBe("cp-agent-start:coordinator:req-3");
      expect(start.message.messageId).toBe("cp-agent-message:coordinator:req-3");
    }),
  );

  it.effect("a retry that still owes the first message waits for a free slot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, ...runningAgents(AGENT_RUNNING_CAP - 1)],
        failOnce: "thread.turn.start",
      });
      const params = { title: "Pricing", message: "Compare plans.", clientRequestId: "req-4" };

      yield* harness.create(params).pipe(Effect.flip);
      harness.threads.set(ThreadId.make("last"), running("last"));
      const atCap = yield* harness.create(params).pipe(Effect.flip);
      harness.threads.delete(ThreadId.make("last"));
      const retried = yield* harness.create(params);

      expect(atCap).toMatchObject({ _tag: "ConcurrencyLimitError", running: AGENT_RUNNING_CAP });
      expect(retried.created).toBe(false);
      expect(commandTypes(harness.commands)).toEqual(["thread.create", "thread.turn.start"]);
    }),
  );

  it.effect("tells a retry to use a new clientRequestId when the engine rejected a step", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator],
        rejectOnce: "thread.turn.start",
      });
      const params = { title: "Pricing", message: "Compare plans.", clientRequestId: "req-5" };

      const rejected = yield* harness.create(params).pipe(Effect.flip);
      const retried = yield* harness.create(params).pipe(Effect.flip);

      expect(rejected._tag).toBe("AgentToolFailedError");
      expect(rejected.message).not.toContain("clientRequestId");
      expect(retried._tag).toBe("AgentToolFailedError");
      expect(retried.message).toContain("Use a new clientRequestId.");
    }),
  );

  it.effect("a cancelled create still sends the first message of the agent it made", () =>
    Effect.gen(function* () {
      const createGate = {
        reached: yield* Deferred.make<void>(),
        open: yield* Deferred.make<void>(),
      };
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator],
        createGate,
      });

      const call = yield* Effect.forkChild(
        harness.create({ title: "Pricing", message: "Compare plans." }),
      );
      yield* Deferred.await(createGate.reached);
      const cancel = yield* Effect.forkChild(Fiber.interrupt(call));
      yield* Deferred.succeed(createGate.open, undefined);
      yield* Fiber.join(cancel);

      expect(commandTypes(harness.commands)).toEqual(["thread.create", "thread.turn.start"]);
    }),
  );

  it.effect("uses the Project default model, then the coordinator's, and resolves aliases", () =>
    Effect.gen(function* () {
      const projectDefault: ModelSelection = { instanceId: CLAUDE, model: "claude-opus-4-6" };
      const withDefault = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator],
        project: { ...project, defaultModelSelection: projectDefault },
      });
      yield* withDefault.create({ title: "A", message: "Go." });
      expect(createCommand(withDefault.commands).modelSelection).toEqual(projectDefault);

      const withOptions: ModelSelection = {
        instanceId: CODEX,
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const fromCoordinator = yield* makeHarness({
        caller: RESEARCH_ID,
        threads: [{ ...coordinator, modelSelection: withOptions }, research],
      });
      yield* fromCoordinator.create({ title: "B", message: "Go." });
      expect(createCommand(fromCoordinator.commands).modelSelection).toEqual(withOptions);

      const byAlias = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [{ ...coordinator, modelSelection: withOptions }],
      });
      yield* byAlias.create({ title: "C", message: "Go.", model: "mini" });
      // A different model drops the base model's options.
      expect(createCommand(byAlias.commands).modelSelection).toEqual({
        instanceId: CODEX,
        model: "gpt-5.4-mini",
      });

      const elsewhere = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });
      yield* elsewhere.create({ title: "D", message: "Go.", model: "Claude Opus 4.6" });
      expect(createCommand(elsewhere.commands).modelSelection).toEqual({
        instanceId: CLAUDE,
        model: "claude-opus-4-6",
      });

      const unknown = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });
      const error = yield* unknown
        .create({ title: "E", message: "Go.", model: "gpt-9" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "UnknownModelError",
        model: "gpt-9",
        available: ["gpt-5.4", "gpt-5.4-mini"],
      });
      expect(unknown.commands).toEqual([]);
    }),
  );

  it.effect("never starts an agent looser than its creator", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly coordinator: RuntimeMode;
        readonly caller: "coordinator" | "research";
        readonly callerMode: RuntimeMode;
        readonly requested?: RuntimeMode;
        readonly expected: RuntimeMode;
      }> = [
        { coordinator: "auto", caller: "coordinator", callerMode: "auto", expected: "auto" },
        {
          coordinator: "approval-required",
          caller: "coordinator",
          callerMode: "approval-required",
          requested: "full-access",
          expected: "approval-required",
        },
        {
          coordinator: "full-access",
          caller: "research",
          callerMode: "auto-accept-edits",
          expected: "auto-accept-edits",
        },
        // A standing agent looser than the coordinator gets the coordinator's mode by default.
        {
          coordinator: "auto-accept-edits",
          caller: "research",
          callerMode: "full-access",
          expected: "auto-accept-edits",
        },
      ];
      for (const entry of cases) {
        const coordinatorThread = {
          ...coordinator,
          runtimeMode: entry.caller === "coordinator" ? entry.callerMode : entry.coordinator,
        };
        const harness = yield* makeHarness({
          caller: entry.caller === "coordinator" ? COORDINATOR_ID : RESEARCH_ID,
          threads: [coordinatorThread, { ...research, runtimeMode: entry.callerMode }],
        });
        const result = yield* harness.create({
          title: "Agent",
          message: "Go.",
          ...(entry.requested ? { runtimeMode: entry.requested } : {}),
        });
        expect(result.runtimeMode).toBe(entry.expected);
        expect(createCommand(harness.commands).runtimeMode).toBe(entry.expected);
      }
    }),
  );
});

describe("agents capability and role", () => {
  it.effect("refuses a caller without the capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: ThreadId.make("helper"),
        threads: [coordinator, makeThread("helper")],
        capabilities: ["pull-requests"],
      });

      const error = yield* harness.list().pipe(Effect.flip);

      expect(error._tag).toBe("McpCapabilityUnavailableError");
    }),
  );

  it.effect("refuses a caller that holds the capability but was unpinned since", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: RESEARCH_ID,
        threads: [coordinator, { ...research, pinnedAt: null }],
      });

      const error = yield* harness.create({ title: "A", message: "Go." }).pipe(Effect.flip);

      expect(error._tag).toBe("AgentsUnavailableError");
      expect(harness.commands).toEqual([]);
    }),
  );
});

describe("agent scope", () => {
  const helper = makeThread("helper", { title: "Helper" });
  const coordinatorAgent = makeThread("drafts", { title: "Drafts" });
  const foreign = makeThread("foreign", { projectId: OTHER_PROJECT_ID, title: "Foreign" });
  const threads = [coordinator, research, helper, coordinatorAgent, foreign];
  const creators = { helper: RESEARCH_ID, drafts: COORDINATOR_ID };

  it.effect("a standing agent manages only the one-off agents it created", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: RESEARCH_ID, threads, creators });

      const listed = yield* harness.list();
      const readOther = yield* harness.read({ agent: "Drafts" }).pipe(Effect.flip);
      const stopOther = yield* harness.stop({ agent: coordinatorAgent.id }).pipe(Effect.flip);
      const readCoordinator = yield* harness.read({ agent: COORDINATOR_ID }).pipe(Effect.flip);

      expect(listed.agents.map((agent) => agent.threadId)).toEqual([helper.id]);
      expect(readOther._tag).toBe("NotYourAgentError");
      expect(stopOther._tag).toBe("NotYourAgentError");
      expect(readCoordinator._tag).toBe("NotYourAgentError");
      expect(harness.commands).toEqual([]);
    }),
  );

  it.effect("the coordinator manages every thread in its Project but itself", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: COORDINATOR_ID, threads, creators });

      const listed = yield* harness.list();
      const self = yield* harness.read({ agent: COORDINATOR_ID }).pipe(Effect.flip);
      const other = yield* harness.read({ agent: foreign.id }).pipe(Effect.flip);
      const missing = yield* harness.read({ agent: "Nobody" }).pipe(Effect.flip);

      expect(listed.agents.map((agent) => agent.threadId)).toEqual([
        research.id,
        helper.id,
        coordinatorAgent.id,
      ]);
      expect(listed.agents[0]).toMatchObject({ standing: true, phase: "idle", settled: false });
      expect(self._tag).toBe("NotYourAgentError");
      expect(other._tag).toBe("NotYourAgentError");
      expect(missing._tag).toBe("AgentNotFoundError");
    }),
  );

  it.effect("lists settled agents only on request, and archived ones never", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [
          coordinator,
          makeThread("settled", { settledAt: LONG_AGO }),
          makeThread("archived", { archivedAt: LONG_AGO }),
          running("busy"),
        ],
      });

      const active = yield* harness.list();
      const all = yield* harness.list({ includeSettled: true });

      expect(active.agents.map((agent) => [agent.threadId, agent.phase])).toEqual([
        ["busy", "running"],
      ]);
      expect(all.agents.map((agent) => [agent.threadId, agent.settled])).toEqual([
        ["settled", true],
        ["busy", false],
      ]);
    }),
  );

  it.effect("lists an agent created a moment ago as starting, as the cap counts it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });

      const created = yield* harness.create({ title: "Pricing", message: "Compare plans." });
      const listed = yield* harness.list();

      expect(listed.agents).toMatchObject([{ threadId: created.threadId, phase: "starting" }]);
    }),
  );
});

const agentRequest = (id: string, text = "Compare plans.") =>
  makeMessage(id, "user", text, {
    kind: "agent",
    threadId: COORDINATOR_ID,
    threadTitle: "Acme",
    replyTo: COORDINATOR_ID,
  });

describe("cp_agent_read", () => {
  it.effect("reads the requested number of recent turns within the caps", () =>
    Effect.gen(function* () {
      const longRequest = "r".repeat(AGENT_READ_REQUEST_CAP_BYTES + 500);
      const longResult = "é".repeat(AGENT_READ_RESULT_CAP_BYTES);
      const numbers = [1, 2, 3, 4, 5];
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, makeThread("worker", { title: "Worker" })],
        messages: {
          worker: numbers.flatMap((turn) => [
            makeMessage(`user-${turn}`, "user", turn === 5 ? longRequest : `request ${turn}`),
            makeMessage(
              `assistant-${turn}`,
              "assistant",
              turn >= 3 ? longResult : `result ${turn}`,
            ),
          ]),
        },
        turns: {
          worker: numbers.map((turn) => ({
            turnId: `turn-${turn}`,
            request: `user-${turn}`,
            result: `assistant-${turn}`,
            state: "completed" as const,
            requestedAt: `2026-09-0${turn}T00:00:00.000Z`,
          })),
        },
      });

      const one = yield* harness.read({ agent: "worker" });
      const five = yield* harness.read({ agent: "Worker", turns: 5 });

      expect(one.turns).toHaveLength(1);
      const latest = one.turns[0]!;
      expect(latest.state).toBe("completed");
      expect(Buffer.byteLength(latest.request)).toBeLessThanOrEqual(
        AGENT_READ_REQUEST_CAP_BYTES + 20,
      );
      expect(latest.request).toMatch(/\[truncated\]$/);
      expect(Buffer.byteLength(latest.result ?? "")).toBeLessThanOrEqual(
        AGENT_READ_RESULT_CAP_BYTES + 20,
      );
      expect(latest.result).not.toContain("�");

      // Three long turns fill the 24 KB total; the older turns are left out.
      const total = five.turns.reduce(
        (sum, turn) => sum + Buffer.byteLength(turn.request) + Buffer.byteLength(turn.result ?? ""),
        0,
      );
      expect(total).toBeLessThanOrEqual(24 * 1_024);
      expect(five.turns.length).toBeGreaterThan(1);
      expect(five.turns.length).toBeLessThan(5);
      expect(five.turns.at(-1)).toEqual(latest);
    }),
  );

  it.effect("pairs each request with the turn it started, not with message order", () =>
    Effect.gen(function* () {
      // The follow-up was appended while the first turn ran, so it sorts
      // before the first answer; a restart continued the follow-up's turn.
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, running("worker", { title: "Worker" })],
        messages: {
          worker: [
            agentRequest("request-1", "Compare plans."),
            agentRequest("request-2", "Also check tax."),
            makeMessage("answer-1", "assistant", "Plan B is cheaper."),
            makeMessage("answer-2", "assistant", "Tax is"),
            makeMessage("answer-3", "assistant", "Tax is 8%, still", undefined, true),
          ],
        },
        turns: {
          worker: [
            {
              turnId: "turn-1",
              request: "request-1",
              result: "answer-1",
              state: "completed",
              requestedAt: "2026-09-01T00:00:00.000Z",
            },
            {
              turnId: "turn-2",
              request: "request-2",
              result: "answer-2",
              state: "error",
              requestedAt: "2026-09-02T00:00:00.000Z",
            },
            {
              turnId: "turn-3",
              request: null,
              result: "answer-3",
              state: "running",
              requestedAt: "2026-09-03T00:00:00.000Z",
            },
          ],
        },
      });

      const read = yield* harness.read({ agent: "worker", turns: 5 });

      expect(read.turns).toEqual([
        { state: "completed", request: "Compare plans.", result: "Plan B is cheaper." },
        // Still being written, so no result yet.
        { state: "running", request: "Also check tax.", result: null },
      ]);
    }),
  );
});

describe("cp_agent_stop", () => {
  const request = agentRequest("request-1");
  const followUp = agentRequest("request-2", "Also check tax.");
  const userMessage = makeMessage("user-note", "user", "Thanks.");
  const withActiveTurn = (turnId: string) =>
    running("worker", {
      session: {
        threadId: ThreadId.make("worker"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make(turnId),
        lastError: null,
        updatedAt: LONG_AGO,
      },
    });

  it.effect("names the request the running turn started, not a follow-up held behind it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, withActiveTurn("turn-1")],
        messages: { worker: [request, followUp] },
        turns: {
          worker: [
            {
              turnId: "turn-1",
              request: "request-1",
              state: "running",
              requestedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
        },
      });

      const result = yield* harness.stop({ agent: "worker" });

      expect(result).toEqual({ threadId: "worker", stopped: true, archived: false });
      expect(commandTypes(harness.commands)).toEqual([
        "thread.turn.interrupt",
        "thread.session.stop",
      ]);
      expect(harness.commands[0]?.commandId).toBe("cp-agent-stop:coordinator:worker:request-1");
    }),
  );

  it.effect("names the continued request when a restart resumed its turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, withActiveTurn("turn-2")],
        messages: { worker: [request] },
        turns: {
          worker: [
            {
              turnId: "turn-1",
              request: "request-1",
              state: "completed",
              requestedAt: "2026-09-01T00:00:00.000Z",
            },
            {
              turnId: "turn-2",
              request: null,
              state: "running",
              requestedAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        },
      });

      yield* harness.stop({ agent: "worker" });

      expect(harness.commands[0]?.commandId).toBe("cp-agent-stop:coordinator:worker:request-1");
    }),
  );

  it.effect("keeps the result of an earlier request when the user's own turn is stopped", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, withActiveTurn("turn-2")],
        messages: { worker: [request, userMessage] },
        turns: {
          worker: [
            {
              turnId: "turn-1",
              request: "request-1",
              state: "completed",
              requestedAt: "2026-09-01T00:00:00.000Z",
            },
            {
              turnId: "turn-2",
              request: "user-note",
              state: "running",
              requestedAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        },
      });

      yield* harness.stop({ agent: "worker" });

      expect(harness.commands[0]?.type).toBe("thread.turn.interrupt");
      expect(harness.commands[0]?.commandId).toMatch(/^mcp-agent-stop:worker:/);
    }),
  );

  it.effect("drops the caller's queued messages first, so they never restart the agent", () =>
    Effect.gen(function* () {
      const startedSend = agentRequest("cp-send:worker:started", "Also check tax.");
      const heldSend = agentRequest("cp-send:worker:held", "Then check fees.");
      const peerSend = makeMessage("cp-send:worker:peer", "user", "FYI.", {
        kind: "agent",
        threadId: RESEARCH_ID,
        threadTitle: "Research",
      });
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, research, withActiveTurn("turn-2")],
        messages: { worker: [request, startedSend, heldSend, peerSend] },
        turns: {
          worker: [
            {
              turnId: "turn-1",
              request: "request-1",
              state: "completed",
              requestedAt: "2026-09-01T00:00:00.000Z",
            },
            {
              turnId: "turn-2",
              request: "cp-send:worker:started",
              state: "running",
              requestedAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        },
      });

      const result = yield* harness.stop({ agent: "worker" });

      expect(result.stopped).toBe(true);
      // Only the caller's unstarted message is dropped; the delivery reactor
      // starts a held message under this id, so it never starts.
      expect(harness.commands.map((command) => [command.type, command.commandId])).toEqual([
        ["thread.activity.append", "cp-start:cp-send:worker:held"],
        ["thread.turn.interrupt", "cp-agent-stop:coordinator:worker:cp-send:worker:started"],
        ["thread.session.stop", expect.stringMatching(/^mcp-agent-session-stop:/)],
      ]);
    }),
  );

  it.effect("interrupts an agent created a moment ago, before its session starts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: COORDINATOR_ID, threads: [coordinator] });
      const created = yield* harness.create({ title: "Pricing", message: "Compare plans." });
      const start = harness.commands.at(-1);
      if (start?.type !== "thread.turn.start") throw new Error("Expected a turn start.");

      const result = yield* harness.stop({ agent: created.threadId });

      expect(result.stopped).toBe(true);
      expect(harness.commands.slice(2).map((command) => command.commandId)).toEqual([
        `cp-agent-stop:coordinator:${created.threadId}:${start.message.messageId}`,
        expect.stringMatching(/^mcp-agent-session-stop:/),
      ]);
    }),
  );

  it.effect("only stops the session of an idle agent, and archives on request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [coordinator, makeThread("worker")],
      });

      const idle = yield* harness.stop({ agent: "worker" });
      const archived = yield* harness.stop({ agent: "worker", archive: true });

      expect(idle).toEqual({ threadId: "worker", stopped: false, archived: false });
      expect(archived).toEqual({ threadId: "worker", stopped: false, archived: true });
      expect(commandTypes(harness.commands)).toEqual([
        "thread.session.stop",
        "thread.session.stop",
        "thread.archive",
      ]);
    }),
  );
});
