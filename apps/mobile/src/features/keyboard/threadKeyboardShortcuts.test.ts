import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadJumpIndex, threadJumpTarget } from "./threadKeyboardShortcuts";

function makeThread(id: string): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("threadJumpTarget", () => {
  const visible = ["coordinator", "agent", "task"].map(makeThread);

  it("jumps by position in the visible order", () => {
    expect(threadJumpTarget(visible, "thread.jump.1")?.id).toBe("coordinator");
    expect(threadJumpTarget(visible, "thread.jump.3")?.id).toBe("task");
  });

  it("returns nothing past the end or for other commands", () => {
    expect(threadJumpTarget(visible, "thread.jump.4")).toBeNull();
    expect(threadJumpTarget([], "thread.jump.1")).toBeNull();
    expect(threadJumpIndex("commandPalette")).toBe(-1);
    expect(threadJumpTarget(visible, "commandPalette")).toBeNull();
  });
});
