import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentPlacementSettings,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  AgentMachines,
  type AgentMachinesShape,
  type PlacementInputs,
} from "../../../agentMachines/AgentMachines.ts";
import { RemoteAgents, RemoteAgentsLive } from "../../../agentMachines/RemoteAgents.ts";
import { RemoteAgentStore } from "../../../agentMachines/RemoteAgentStore.ts";
import {
  MemoryRemoteAgentStore,
  TEST_NOW,
  makeFakePeer,
  makePeerThread,
  makeRecord,
} from "../../../agentMachines/testFixtures.ts";
import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import { AGENT_RUNNING_CAP } from "../../../orchestration/agentProtocol.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlers } from "./handlers.ts";
import {
  AgentCreateResult,
  AgentListResult,
  AgentReadResult,
  AgentStopResult,
  AgentsToolkit,
} from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const COORDINATOR_ID = ThreadId.make("coordinator");
const STANDING_ID = ThreadId.make("standing");
const CODEX = ProviderInstanceId.make("codex");
const LONG_AGO = "2026-08-20T00:00:00.000Z";

const homeThread = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  makePeerThread(id, { projectId: PROJECT_ID, runtimeMode: "full-access", ...overrides });

const running = (id: string) =>
  homeThread(id, {
    session: {
      threadId: ThreadId.make(id),
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: LONG_AGO,
    },
  });

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

const provider: ServerProvider = {
  instanceId: CODEX,
  driver: ProviderDriverKind.make(CODEX),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: LONG_AGO,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const settings = (overrides: Partial<AgentPlacementSettings> = {}): AgentPlacementSettings => ({
  mode: "local",
  singleMachineId: null,
  localPreference: 50,
  allowLocalFallback: true,
  machines: {},
  ...overrides,
});

const mini = {
  label: "Mac Mini",
  baseUrl: "https://mini.tail1234.ts.net",
  enabled: true,
  preference: 50,
} as const;

interface HarnessInput {
  readonly caller: ThreadId;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly placement: PlacementInputs;
  readonly failPeerOn?: ReadonlyArray<"thread.create" | "thread.turn.start">;
}

const makeHarness = Effect.fn("makeRemoteAgentsHarness")(function* (input: HarnessInput) {
  const threads = new Map(
    (input.threads ?? [homeThread("coordinator", { title: "Acme" })]).map(
      (thread) => [thread.id, thread] as const,
    ),
  );
  const commands: Array<OrchestrationCommand> = [];
  const creators = new Map<string, ThreadId>();
  const peer = makeFakePeer({ ...(input.failPeerOn ? { failOn: input.failPeerOn } : {}) });
  const machines = Layer.succeed(AgentMachines, {
    ...peer.service,
    placementInputs: () => Effect.succeed(input.placement),
  } satisfies AgentMachinesShape);
  // Built once and shared: layers rebuild on every `provide`, and the store
  // must be the same instance for the handlers and the test.
  const built = yield* Layer.build(
    RemoteAgentsLive.pipe(Layer.provideMerge(machines), Layer.provideMerge(MemoryRemoteAgentStore)),
  );
  const store = Context.get(built, RemoteAgentStore);
  const remoteLayer = Layer.mergeAll(
    Layer.succeed(RemoteAgents, Context.get(built, RemoteAgents)),
    Layer.succeed(RemoteAgentStore, store),
  );

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
      getProjectShellById: (projectId) =>
        Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [project],
          threads: [...threads.values()],
          updatedAt: LONG_AGO,
        }),
    }),
    Layer.mock(ProjectionTurnRepository)({ listByThreadId: () => Effect.succeed([]) }),
    Layer.mock(ProjectionProjectRepository)({}),
    Layer.mock(ProjectionThreadMessageRepository)({
      getByMessageId: () => Effect.succeed(Option.none()),
      listByThreadId: () => Effect.succeed([]),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.create") {
            threads.set(
              command.threadId,
              homeThread(command.threadId, {
                title: command.title,
                runtimeMode: command.runtimeMode,
                latestUserMessageAt: null,
              }),
            );
            if (command.createdByThreadId)
              creators.set(command.threadId, command.createdByThreadId);
          }
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(AgentLineage, {
      creatorOf: (threadId) => Effect.succeed(creators.get(threadId) ?? null),
    }),
    makeProviderRegistryLayer([provider]),
    remoteLayer,
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
    capabilities: new Set(["agents"]),
    issuedAt: 1,
  };
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
  const seedRecord = (overrides: Parameters<typeof makeRecord>[0] = {}) =>
    store.put(makeRecord({ homeProjectId: PROJECT_ID, ...overrides }));
  return {
    commands,
    peer,
    threads,
    seedRecord,
    records: store.list,
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

const localCandidate = (load = 0) => ({
  id: "local",
  label: "This Mac",
  ineligibleReason: null,
  load,
});
const miniCandidate = (load = 0, ineligibleReason: string | null = null) => ({
  id: "mini",
  label: "Mac Mini",
  ineligibleReason,
  load,
});

const placement = (
  overrides: Partial<AgentPlacementSettings>,
  candidates: PlacementInputs["candidates"],
): PlacementInputs => ({
  settings: settings(overrides),
  localOnly: false,
  candidates,
  peerProjectIds: new Map([["mini", "peer-project"]]),
});

const types = (commands: ReadonlyArray<{ readonly type: string }>) =>
  commands.map((command) => command.type);

describe("cp_agent_create placement", () => {
  it.effect("sends every agent to the one chosen machine and records it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const result = yield* h.create({ title: "Pricing", message: "Compare plans." });

      expect(result).toMatchObject({ title: "Pricing", created: true, machineLabel: "Mac Mini" });
      expect(types(h.peer.commands)).toEqual(["thread.create", "thread.turn.start"]);
      expect(types(h.commands)).toEqual([]);
      const records = yield* h.records;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        threadId: result.threadId,
        machineId: "mini",
        homeProjectId: PROJECT_ID,
        creatorThreadId: "coordinator",
        state: "open",
      });
      expect(result.placement).toBeUndefined();
    }),
  );

  it.effect("balances by load across this machine and a linked one", () =>
    Effect.gen(function* () {
      const busyHome = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "balanced", machines: { mini } }, [
          localCandidate(3),
          miniCandidate(0),
        ]),
      });
      expect((yield* busyHome.create({ title: "A", message: "go" })).machineLabel).toBe("Mac Mini");

      const busyPeer = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "balanced", machines: { mini } }, [
          localCandidate(0),
          miniCandidate(3),
        ]),
      });
      const local = yield* busyPeer.create({ title: "B", message: "go" });
      expect(local.machineLabel).toBeNull();
      expect(types(busyPeer.commands)).toContain("thread.create");
      expect(busyPeer.peer.commands).toEqual([]);
    }),
  );

  it.effect("never asks for looser runtime mode than the caller, on a linked machine either", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [homeThread("coordinator", { title: "Acme", runtimeMode: "approval-required" })],
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const result = yield* h.create({
        title: "Pricing",
        message: "go",
        runtimeMode: "full-access",
      });
      expect(result.runtimeMode).toBe("approval-required");
      expect(h.peer.commands[0]).toMatchObject({ runtimeMode: "approval-required" });
    }),
  );

  it.effect("falls back to this machine when the linked one cannot be reached, and says so", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        failPeerOn: ["thread.create"],
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const result = yield* h.create({ title: "Pricing", message: "go" });
      expect(result.machineLabel).toBeNull();
      expect(result.placement).toContain("Started on this machine instead");
      expect(types(h.commands)).toContain("thread.create");
      expect(yield* h.records).toEqual([]);
    }),
  );

  it.effect("does not fall back when fallback is off", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        failPeerOn: ["thread.create"],
        placement: placement(
          {
            mode: "single",
            singleMachineId: "mini",
            allowLocalFallback: false,
            machines: { mini },
          },
          [localCandidate(), miniCandidate()],
        ),
      });
      const error = yield* Effect.flip(h.create({ title: "Pricing", message: "go" }));
      expect(error.message).toContain("Could not reach");
      expect(types(h.commands)).toEqual([]);
    }),
  );

  it.effect("never falls back for an explicit machine", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        failPeerOn: ["thread.create"],
        placement: placement({ mode: "balanced", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const error = yield* Effect.flip(
        h.create({ title: "Pricing", message: "go", machine: "Mac Mini" }),
      );
      expect(error.message).toContain("Could not reach");
      expect(types(h.commands)).toEqual([]);
    }),
  );

  it.effect("rejects a named machine when the settings keep agents on this one", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "local", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const error = yield* Effect.flip(
        h.create({ title: "Pricing", message: "go", machine: "mini" }),
      );
      expect(error.message).toContain("Agents run on this machine only");
    }),
  );

  it.effect("starts on this machine when the named machine is 'local'", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const result = yield* h.create({ title: "Pricing", message: "go", machine: "local" });
      expect(result.machineLabel).toBeNull();
      expect(h.peer.commands).toEqual([]);
    }),
  );

  it.effect("keeps standing agents on this machine, and refuses a remote one", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      const local = yield* h.create({ title: "Sales", message: "go", standing: true });
      expect(local.machineLabel).toBeNull();
      expect(h.peer.commands).toEqual([]);
      const error = yield* Effect.flip(
        h.create({ title: "Ops", message: "go", standing: true, machine: "Mac Mini" }),
      );
      expect(error.message).toContain("standing agent runs on this machine");
    }),
  );

  it.effect("counts remote agents toward the Project's cap", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        threads: [
          homeThread("coordinator", { title: "Acme" }),
          ...Array.from({ length: AGENT_RUNNING_CAP - 1 }, (_, index) => running(`agent-${index}`)),
        ],
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      // The last free slot goes to a remote agent...
      yield* h.create({ title: "One", message: "go" });
      // ...so the next one, anywhere, is over the cap.
      const error = yield* Effect.flip(h.create({ title: "Two", message: "go" }));
      expect(error._tag).toBe("ConcurrencyLimitError");
    }),
  );

  it.effect(
    "a retry with the same clientRequestId returns the agent it started and sends nothing more",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          caller: COORDINATOR_ID,
          placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
            localCandidate(),
            miniCandidate(),
          ]),
        });
        const first = yield* h.create({
          title: "Pricing",
          message: "go",
          clientRequestId: "req-1",
        });
        const sent = h.peer.commands.length;
        const again = yield* h.create({
          title: "Pricing",
          message: "go",
          clientRequestId: "req-1",
        });
        expect(again.threadId).toBe(first.threadId);
        expect(again.created).toBe(false);
        expect(h.peer.commands).toHaveLength(sent);
        expect(yield* h.records).toHaveLength(1);
      }),
  );

  it.effect("stays on the machine it started on when the settings change before a retry", () =>
    Effect.gen(function* () {
      const remoteSettings = placement(
        { mode: "single", singleMachineId: "mini", machines: { mini } },
        [localCandidate(), miniCandidate()],
      );
      const h = yield* makeHarness({ caller: COORDINATOR_ID, placement: remoteSettings });
      const first = yield* h.create({ title: "Pricing", message: "go", clientRequestId: "req-2" });
      expect(first.machineLabel).toBe("Mac Mini");
      // A retry after the user switched to "this machine only" must not start a second agent here.
      const h2 = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "local" }, [localCandidate()]),
      });
      yield* h2.seedRecord({
        threadId: first.threadId,
        title: "Pricing",
        state: "open",
        inFlight: {
          messageId: "m",
          replyTo: "coordinator",
          sentAt: TEST_NOW,
          baselineTurnId: null,
          suppressed: false,
        },
      });
      const again = yield* h2.create({ title: "Pricing", message: "go", clientRequestId: "req-2" });
      expect(again.threadId).toBe(first.threadId);
      expect(types(h2.commands)).toEqual([]);
    }),
  );

  it.effect("refuses a clientRequestId reused with a different title", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        caller: COORDINATOR_ID,
        placement: placement({ mode: "single", singleMachineId: "mini", machines: { mini } }, [
          localCandidate(),
          miniCandidate(),
        ]),
      });
      yield* h.create({ title: "Pricing", message: "go", clientRequestId: "req-3" });
      const error = yield* Effect.flip(
        h.create({ title: "Other", message: "go", clientRequestId: "req-3" }),
      );
      expect(error._tag).toBe("ClientRequestIdConflictError");
    }),
  );
});

describe("cp_agent_list, cp_agent_read and cp_agent_stop with remote agents", () => {
  const seededHarness = (caller: ThreadId = COORDINATOR_ID) =>
    makeHarness({
      caller,
      threads: [
        homeThread("coordinator", { title: "Acme" }),
        homeThread("standing", { title: "Sales", pinnedAt: LONG_AGO }),
        homeThread("local-agent", { title: "Local agent" }),
      ],
      placement: placement({ mode: "local" }, [localCandidate()]),
    });

  it.effect("lists remote agents next to local ones, with their machine", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness();
      yield* h.seedRecord({ lastPhase: "running" });
      const { agents } = yield* h.list();
      expect(agents.map((agent) => [agent.title, agent.machine])).toEqual(
        expect.arrayContaining([
          ["Pricing", "Mac Mini"],
          ["Local agent", null],
        ]),
      );
      expect(agents.find((agent) => agent.title === "Pricing")).toMatchObject({
        threadId: "remote-1",
        phase: "running",
        standing: false,
        settled: false,
      });
    }),
  );

  it.effect("hides settled remote agents unless asked", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness();
      yield* h.seedRecord({ state: "settled", endedAt: TEST_NOW });
      expect((yield* h.list()).agents.some((agent) => agent.title === "Pricing")).toBe(false);
      expect(
        (yield* h.list({ includeSettled: true })).agents.find((agent) => agent.title === "Pricing")
          ?.settled,
      ).toBe(true);
    }),
  );

  it.effect("a standing agent lists only the remote agents it started", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness(STANDING_ID);
      yield* h.seedRecord({ threadId: "mine", title: "Mine", creatorThreadId: "standing" });
      yield* h.seedRecord({ threadId: "theirs", title: "Theirs", creatorThreadId: "coordinator" });
      const titles = (yield* h.list()).agents.map((agent) => agent.title);
      expect(titles).toContain("Mine");
      expect(titles).not.toContain("Theirs");
    }),
  );

  it.effect("reads a remote agent by title", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness();
      yield* h.seedRecord();
      h.peer.threads.set("remote-1", makePeerThread("remote-1"));
      h.peer.details.set("remote-1", {
        messages: [
          { id: "m1", role: "user", text: "Compare plans.", streaming: false },
          { id: "m2", role: "assistant", text: "Plan B wins.", streaming: false },
        ] as never,
      });
      const read = yield* h.read({ agent: "Pricing" });
      expect(read.threadId).toBe("remote-1");
      expect(read.turns.at(-1)).toMatchObject({
        request: "Compare plans.",
        result: "Plan B wins.",
      });
    }),
  );

  it.effect("refuses a remote agent that another manager started", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness(STANDING_ID);
      yield* h.seedRecord({ threadId: "theirs", title: "Theirs", creatorThreadId: "coordinator" });
      const byId = yield* Effect.flip(h.read({ agent: "theirs" }));
      const byTitle = yield* Effect.flip(h.read({ agent: "Theirs" }));
      expect(byId._tag).toBe("NotYourAgentError");
      expect(byTitle._tag).toBe("NotYourAgentError");
    }),
  );

  it.effect("reports several agents with one title, local and remote, as ambiguous", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness();
      yield* h.seedRecord({ title: "Local agent" });
      const error = yield* Effect.flip(h.read({ agent: "Local agent" }));
      expect(error._tag).toBe("AgentAmbiguousError");
    }),
  );

  it.effect("stops a remote agent on its machine, and only touches the peer", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness();
      yield* h.seedRecord({
        inFlight: {
          messageId: "m",
          replyTo: "coordinator",
          sentAt: TEST_NOW,
          baselineTurnId: null,
          suppressed: false,
        },
      });
      const stopped = yield* h.stop({ agent: "Pricing" });
      expect(stopped).toEqual({ threadId: "remote-1", stopped: true, archived: false });
      expect(types(h.peer.commands)).toEqual(["thread.turn.interrupt", "thread.session.stop"]);
      expect(types(h.commands)).toEqual([]);
    }),
  );

  it.effect("finds nothing for an unknown agent", () =>
    Effect.gen(function* () {
      const h = yield* seededHarness();
      const error = yield* Effect.flip(h.read({ agent: "Nobody" }));
      expect(error._tag).toBe("AgentNotFoundError");
    }),
  );
});
