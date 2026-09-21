import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyHomeThread } from "./classifyHomeThread";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("classifyHomeThread", () => {
  it("counts an unvisited completed thread as needing attention", () => {
    expect(
      classifyHomeThread(
        makeThread({
          id: ThreadId.make("t1"),
          title: "Done",
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: "2026-06-02T00:00:00.000Z",
            startedAt: "2026-06-02T00:00:00.000Z",
            completedAt: "2026-06-02T00:01:00.000Z",
            assistantMessageId: MessageId.make("msg-1"),
          },
        }),
      ),
    ).toBe("attention");
  });

  it("does not count a settled thread as needing attention", () => {
    expect(
      classifyHomeThread(
        makeThread({
          id: ThreadId.make("t2"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: "2026-06-02T00:02:00.000Z",
          hasPendingApprovals: true,
          latestTurn: {
            turnId: TurnId.make("turn-2"),
            state: "completed",
            requestedAt: "2026-06-02T00:00:00.000Z",
            startedAt: "2026-06-02T00:00:00.000Z",
            completedAt: "2026-06-02T00:01:00.000Z",
            assistantMessageId: MessageId.make("msg-2"),
          },
        }),
      ),
    ).toBeNull();
  });
});
