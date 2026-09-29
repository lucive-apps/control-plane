import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { GitManager } from "../git/GitManager.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadSettlementReactor from "./ThreadSettlementReactor.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("assistant-project");
const WORKSPACE_ID = ProjectId.make("tasks-workspace");
const COORDINATOR = ThreadId.make("coordinator");

function makeProject(
  id: ProjectId,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell {
  return {
    id,
    title: id,
    workspaceRoot: `/workspace/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

// Idle since 2026-08-20: well past the 3 day threshold.
function makeThread(
  id: string,
  projectId: ProjectId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
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

const makeHarness = Effect.fn("makeAssistantSettlementHarness")(function* (
  snapshot: OrchestrationShellSnapshot,
) {
  const snapshotReads = yield* Queue.unbounded<void>();
  const settled = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () => Queue.offer(snapshotReads, undefined).pipe(Effect.as(snapshot)),
    }),
    Layer.mock(GitManager)({
      branchPullRequest: () => Effect.succeed(null),
      invalidateStatus: () => Effect.void,
    }),
    Layer.mock(PullRequestService)({
      summary: () => Effect.die(new Error("no linked pull requests")),
      subscribeMerges: Effect.succeed(Stream.never),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        command.type === "thread.auto-settle"
          ? Ref.update(settled, (ids) => [...ids, command.threadId]).pipe(
              Effect.as({ sequence: 1 }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      subscribeDomainEvents: Effect.succeed(Stream.never),
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        sidebarAutoSettleAfterDays: 3,
        sidebarAutoSettleOnMerge: false,
      }),
      subscribeChanges: Effect.succeed(Stream.never),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    FileSystem.layerNoop({}),
  );
  return {
    snapshotReads,
    settled,
    layer: ThreadSettlementReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

it.effect("auto-settlement skips coordinators and standing agents only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const fixture = yield* makeHarness({
        snapshotSequence: 1,
        projects: [
          makeProject(PROJECT_ID, { assistant: { coordinatorThreadId: COORDINATOR } }),
          makeProject(WORKSPACE_ID),
        ],
        threads: [
          makeThread(COORDINATOR, PROJECT_ID),
          makeThread("standing-agent", PROJECT_ID, { pinnedAt: "2026-08-02T00:00:00.000Z" }),
          makeThread("one-off-agent", PROJECT_ID),
          makeThread("pinned-task", WORKSPACE_ID, { pinnedAt: "2026-08-02T00:00:00.000Z" }),
        ],
        updatedAt: NOW,
      });

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
        yield* reactor.start();
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(
          [...(yield* Ref.get(fixture.settled))].sort((left, right) => left.localeCompare(right)),
          [ThreadId.make("one-off-agent"), ThreadId.make("pinned-task")],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);
