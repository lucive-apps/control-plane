/**
 * Test doubles for the linked-machine services. Fork-owned.
 */
import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AgentMachines, type AgentMachinesShape } from "./AgentMachines.ts";
import { PeerError, type PeerCommand } from "./AgentMachineClient.ts";
import {
  RemoteAgentStore,
  type RemoteAgentRecord,
  type RemoteAgentStoreShape,
} from "./RemoteAgentStore.ts";
import { RemoteAgents, type RemoteAgentsShape } from "./RemoteAgents.ts";

/** Every agent stays on this machine and no remote agent exists. */
export const localOnlyRemoteAgents = {
  plan: () =>
    Effect.succeed({
      decision: { kind: "placed" as const, machineId: "local", label: "This Mac" },
      peerProjectId: null,
      allowLocalFallback: true,
      localOnly: true,
    }),
  homeLabel: Effect.succeed("This Mac"),
  get: () => Effect.succeed(Option.none()),
  find: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
  openCount: () => Effect.succeed(0),
} satisfies Partial<RemoteAgentsShape>;

export const RemoteAgentsLocalOnly = Layer.mock(RemoteAgents)(localOnlyRemoteAgents);

// ── In-memory store and a fake linked machine ──────────────────────

export const TEST_NOW = "1970-01-01T00:00:00.000Z";
const LONG_AGO = "2026-08-20T00:00:00.000Z";

/** A store that keeps records in a Map, for tests that do not need the file. */
export const makeMemoryRemoteAgentStore = Effect.sync(() => {
  const records = new Map<string, RemoteAgentRecord>();
  return {
    list: Effect.sync(() => [...records.values()]),
    get: (threadId) => Effect.sync(() => Option.fromNullishOr(records.get(threadId))),
    put: (record) => Effect.sync(() => void records.set(record.threadId, record)),
    update: (threadId, change) =>
      Effect.sync(() => {
        const current = records.get(threadId);
        if (current === undefined) return Option.none<RemoteAgentRecord>();
        const next = change(current);
        records.set(threadId, next);
        return Option.some(next);
      }),
    remove: (threadId) => Effect.sync(() => void records.delete(threadId)),
  } satisfies RemoteAgentStoreShape;
});

export const MemoryRemoteAgentStore = Layer.effect(RemoteAgentStore, makeMemoryRemoteAgentStore);

export function makeRecord(overrides: Partial<RemoteAgentRecord> = {}): RemoteAgentRecord {
  return {
    threadId: "remote-1",
    machineId: "mini",
    machineLabel: "Mac Mini",
    peerProjectId: "peer-project",
    homeProjectId: "project-1",
    title: "Pricing",
    creatorThreadId: "coordinator",
    runtimeMode: "approval-required",
    createdAt: TEST_NOW,
    state: "open",
    endedAt: null,
    inFlight: null,
    queuedSends: [],
    lastPhase: "idle",
    lastActivityAt: null,
    ...overrides,
  };
}

export function makePeerThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("peer-project"),
    title: id,
    modelSelection: { instanceId: "codex" as never, model: "gpt-5.4" },
    runtimeMode: "approval-required",
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

export const peerProject: OrchestrationProjectShell = {
  id: ProjectId.make("peer-project"),
  title: "Acme",
  workspaceRoot: "/peer/acme",
  defaultModelSelection: null,
  assistant: { coordinatorThreadId: ThreadId.make("peer-coordinator") },
  scripts: [],
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
};

export interface FakePeerOptions {
  /** Fails these command types with an unreachable error. */
  readonly failOn?: ReadonlyArray<PeerCommand["type"]>;
  readonly machineId?: string;
}

/**
 * A linked machine in memory: its threads are whatever the test sets, and the
 * commands the home sends are recorded. `detail` builds the thread snapshot a
 * read returns.
 */
export function makeFakePeer(options: FakePeerOptions = {}) {
  const machineId = options.machineId ?? "mini";
  const threads = new Map<string, OrchestrationThreadShell>();
  const details = new Map<string, Partial<OrchestrationThread>>();
  const commands: Array<PeerCommand> = [];
  const failOn = new Set(options.failOn ?? []);
  const state = { reachable: true, unauthorized: false, needsRelink: false };

  const guard = <A>(effect: Effect.Effect<A, PeerError>): Effect.Effect<A, PeerError> =>
    state.unauthorized
      ? Effect.fail(
          new PeerError({ kind: "unauthorized", detail: "The linked machine rejected the token." }),
        )
      : state.reachable
        ? effect
        : Effect.fail(
            new PeerError({ kind: "unreachable", detail: "Could not reach the linked machine." }),
          );

  const snapshot = (): OrchestrationShellSnapshot => ({
    snapshotSequence: 1,
    projects: [peerProject],
    threads: [...threads.values()],
    updatedAt: TEST_NOW,
  });

  const shellApi: AgentMachinesShape["shell"] = () => guard(Effect.sync(snapshot));
  const threadApi: AgentMachinesShape["thread"] = (_machine, threadId) =>
    guard(
      Effect.sync(() => {
        const shell = threads.get(threadId);
        if (shell === undefined) return Option.none<OrchestrationThreadDetailSnapshot>();
        return Option.some({
          snapshotSequence: 1,
          thread: {
            ...shell,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: shell.session,
            ...details.get(threadId),
          } as unknown as OrchestrationThread,
        } as OrchestrationThreadDetailSnapshot);
      }),
    );
  const dispatchApi: AgentMachinesShape["dispatch"] = (_machine, command) =>
    guard(
      failOn.has(command.type)
        ? Effect.fail(new PeerError({ kind: "unreachable", detail: `${command.type} failed` }))
        : Effect.sync(() => {
            commands.push(command);
            if (command.type === "thread.create") {
              threads.set(
                command.threadId,
                makePeerThread(command.threadId, {
                  projectId: command.projectId,
                  title: command.title,
                  runtimeMode: command.runtimeMode,
                  modelSelection: command.modelSelection,
                }),
              );
            }
          }),
    );

  const service: AgentMachinesShape = {
    manage: () => Effect.die("not stubbed"),
    placementInputs: () => Effect.die("not stubbed"),
    shell: shellApi,
    thread: threadApi,
    dispatch: dispatchApi,
    markNeedsRelink: () => Effect.sync(() => void (state.needsRelink = true)),
    isReachable: () => Effect.sync(() => state.reachable && !state.unauthorized),
    homeLabel: Effect.succeed("This Mac"),
  };

  return {
    machineId,
    threads,
    details,
    commands,
    state,
    layer: Layer.succeed(AgentMachines, service),
    service,
  };
}
