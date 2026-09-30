import type { AssistantAgentSections } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantExpansionKey,
  flattenAssistantJumpOrder,
  orderAssistantModels,
  orderAssistantsByPreference,
  selectableThreadKeys,
  settleableSelection,
} from "./sidebarAssistants.logic";

const env = EnvironmentId.make("env");

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    projectId: ProjectId.make("personal"),
    title: id,
    modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const ids = (threads: readonly EnvironmentThreadShell[]) => threads.map((value) => value.id);

function sections(
  input: Partial<AssistantAgentSections<EnvironmentThreadShell>>,
): AssistantAgentSections<EnvironmentThreadShell> {
  return { standing: [], active: [], snoozed: [], settled: [], ...input };
}

const settledAgents = Array.from({ length: 13 }, (_, index) => thread(`settled-${index + 1}`));

describe("flattenAssistantJumpOrder", () => {
  const personal = {
    key: assistantExpansionKey("env", "personal"),
    coordinator: thread("personal-coordinator"),
    sections: sections({
      standing: [thread("sales")],
      active: [thread("flights")],
      snoozed: [thread("later")],
      settled: settledAgents,
    }),
  };
  const work = {
    key: assistantExpansionKey("env", "work"),
    coordinator: thread("work-coordinator"),
    sections: sections({ active: [thread("research")] }),
  };

  it("puts each coordinator first and skips the agents of collapsed Projects", () => {
    expect(ids(flattenAssistantJumpOrder([personal, work], new Set()))).toEqual([
      "personal-coordinator",
      "work-coordinator",
    ]);
    expect(ids(flattenAssistantJumpOrder([personal, work], new Set([work.key])))).toEqual([
      "personal-coordinator",
      "work-coordinator",
      "research",
    ]);
  });

  it("follows the rendered order and leaves settled agents to the settled view", () => {
    expect(ids(flattenAssistantJumpOrder([personal], new Set([personal.key])))).toEqual([
      "personal-coordinator",
      "sales",
      "flights",
      "later",
    ]);
  });

  it("keeps the open settled agent in the list", () => {
    expect(
      ids(flattenAssistantJumpOrder([personal], new Set([personal.key]), "env:settled-3")),
    ).toEqual(["personal-coordinator", "sales", "flights", "later", "settled-3"]);
  });

  it("lists the agents of a Project whose coordinator shell has not arrived", () => {
    expect(
      ids(flattenAssistantJumpOrder([{ ...work, coordinator: null }], new Set([work.key]))),
    ).toEqual(["research"]);
  });
});

describe("selectableThreadKeys", () => {
  it("drops coordinators from the range-select order", () => {
    expect(
      selectableThreadKeys(["coordinator", "agent", "task"], new Set(["coordinator"])),
    ).toEqual(["agent", "task"]);
    expect(selectableThreadKeys(["a", "b"], new Set())).toEqual(["a", "b"]);
  });
});

describe("settleableSelection", () => {
  const coordinatorId = ThreadId.make("coordinator");
  const projectByKey = new Map([
    ["env:personal", { assistant: { coordinatorThreadId: coordinatorId } }],
    ["env:website", { assistant: null }],
  ]);
  const inProject = (id: string, pinnedAt: string | null) => ({
    environmentId: "env",
    projectId: "personal",
    id: ThreadId.make(id),
    pinnedAt,
  });

  it("excludes standing agents and coordinators, keeps one-off agents and plain threads", () => {
    const selection = [
      inProject("coordinator", null),
      inProject("standing", "2026-09-28T00:00:00.000Z"),
      inProject("one-off", null),
      {
        environmentId: "env",
        projectId: "website",
        id: ThreadId.make("pinned-task"),
        pinnedAt: "2026-09-28T00:00:00.000Z",
      },
      { environmentId: "env", projectId: "website", id: ThreadId.make("task"), pinnedAt: null },
    ];
    expect(settleableSelection(selection, projectByKey).map((value) => value.id)).toEqual([
      "one-off",
      "pinned-task",
      "task",
    ]);
  });
});

describe("orderAssistantsByPreference", () => {
  const rows = ["a", "b", "c"].map((key) => ({ key }));
  const keys = (list: readonly { key: string }[]) => list.map((row) => row.key);

  it("keeps the default order without a saved order", () => {
    expect(orderAssistantsByPreference(rows, [])).toBe(rows);
  });

  it("follows the saved order and drops stale keys", () => {
    expect(keys(orderAssistantsByPreference(rows, ["c", "gone", "a", "b"]))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("puts Projects without a saved place after the ordered ones", () => {
    expect(keys(orderAssistantsByPreference(rows, ["c", "b"]))).toEqual(["c", "b", "a"]);
  });
});

describe("orderAssistantModels", () => {
  const model = (key: string, orderKey?: string) => ({
    key,
    entry: { project: { orderKey } },
  });
  const keys = (list: readonly { key: string }[]) => list.map((row) => row.key);

  it("applies the saved order when nothing is arranged", () => {
    const rows = [model("a"), model("b"), model("c")];
    expect(keys(orderAssistantModels(rows, ["c", "a"]))).toEqual(["c", "a", "b"]);
  });

  it("lets arranged Projects lead and the saved order arrange only the rest", () => {
    // The partition hands arranged Projects over first and already in key order.
    const rows = [model("x", "d"), model("y", "m"), model("a"), model("b"), model("c")];
    expect(keys(orderAssistantModels(rows, ["c", "y", "a"]))).toEqual(["x", "y", "c", "a", "b"]);
  });
});
