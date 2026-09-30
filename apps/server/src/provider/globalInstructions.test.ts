// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  GLOBAL_INSTRUCTIONS_CAP_CHARS,
  type GlobalInstructionsScopes,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearAssistantRuntime,
  globalInstructionsScopeOf,
  prepareAssistantRuntime,
  readAssistantRuntime,
  withGlobalInstructions,
} from "./assistantRuntime.ts";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";
import {
  buildGlobalInstructionsBlock,
  globalInstructionsPath,
  manageGlobalInstructions,
  type GlobalInstructionsSource,
} from "./globalInstructions.ts";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

const PATH = NodePath.resolve("/state/GLOBAL_AGENTS.md");
const RULES = "- Never use em dashes.\n- Run tests locally.";
const ALL_ON: GlobalInstructionsScopes = { coordinators: true, projectAgents: true, tasks: true };

const source = (
  text = RULES,
  scopes: Partial<GlobalInstructionsScopes> = {},
): GlobalInstructionsSource => ({ path: PATH, text, scopes: { ...ALL_ON, ...scopes } });

describe("buildGlobalInstructionsBlock", () => {
  it.each(["", "  \n\t"])("is null for an empty file (%j), so prompts are unchanged", (text) => {
    expect(buildGlobalInstructionsBlock(source(text), "coordinator")).toBeNull();
    expect(buildGlobalInstructionsBlock(undefined, "tasks")).toBeNull();
  });

  it("inlines the text with its path and the precedence rule", () => {
    const block = buildGlobalInstructionsBlock(source(`\n${RULES}\n`), "agent")!;
    expect(block.inline).toBe(
      [
        `<global_instructions file="${PATH}">`,
        "These are the user's own instructions for every session. Instructions closer to the work (a repository's or Project's AGENTS.md, MEMORY.md, role files) take precedence where they conflict.",
        RULES,
        "</global_instructions>",
      ].join("\n"),
    );
  });

  it("points at the file instead of inlining it", () => {
    const block = buildGlobalInstructionsBlock(source(), "tasks")!;
    expect(block.pointer).toContain(`Read \`${PATH}\` before acting.`);
    expect(block.pointer).not.toContain("em dashes");
  });

  it.each([
    ["coordinator", { coordinators: false }],
    ["agent", { projectAgents: false }],
    ["tasks", { tasks: false }],
  ] as const)("honors the %s scope toggle", (scope, off) => {
    expect(buildGlobalInstructionsBlock(source(RULES, off), scope)).toBeNull();
    // The other scopes are unaffected.
    for (const other of ["coordinator", "agent", "tasks"] as const) {
      if (other === scope) continue;
      expect(buildGlobalInstructionsBlock(source(RULES, off), other)).not.toBeNull();
    }
  });

  it("caps the inlined text and says where the rest is", () => {
    const long = "a".repeat(GLOBAL_INSTRUCTIONS_CAP_CHARS) + "TAIL";
    const inline = buildGlobalInstructionsBlock(source(long), "coordinator")!.inline;
    expect(inline).not.toContain("TAIL");
    expect(inline).toContain(`a\n[truncated: read ${PATH} for the rest]`);

    const exact = "b".repeat(GLOBAL_INSTRUCTIONS_CAP_CHARS);
    expect(buildGlobalInstructionsBlock(source(exact), "coordinator")!.inline).not.toContain(
      "[truncated",
    );
  });

  it("never splits a surrogate pair at the cap", () => {
    const text = "a".repeat(GLOBAL_INSTRUCTIONS_CAP_CHARS - 1) + "😀" + "tail";
    const inline = buildGlobalInstructionsBlock(source(text), "coordinator")!.inline;
    expect(inline).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(inline).toContain("[truncated");
  });
});

describe("withGlobalInstructions", () => {
  const projectBlock = { roleKey: "k", inline: "PROJECT", pointer: "PROJECT_PTR", agents: true };

  it("returns the Project block untouched when there is nothing to add", () => {
    expect(withGlobalInstructions(projectBlock, source(""), "coordinator")).toBe(projectBlock);
    expect(withGlobalInstructions(null, source(""), "tasks")).toBeNull();
  });

  it("puts the global block first and keeps the role key and capability", () => {
    const merged = withGlobalInstructions(projectBlock, source(), "coordinator")!;
    expect(merged.roleKey).toBe("k");
    expect(merged.agents).toBe(true);
    expect(merged.inline.indexOf("<global_instructions")).toBe(0);
    expect(merged.inline.endsWith("</global_instructions>\n\nPROJECT")).toBe(true);
    expect(merged.pointer.endsWith("</global_instructions>\n\nPROJECT_PTR")).toBe(true);
  });

  it("gives a Tasks thread its own block under the 'none' key", () => {
    const block = withGlobalInstructions(null, source(), "tasks")!;
    expect(block.roleKey).toBe("none");
    expect(block.agents).toBe(false);
    expect(block.inline).toContain(RULES);
  });
});

describe("globalInstructionsScopeOf", () => {
  const coordinatorThreadId = ThreadId.make("coordinator");
  const project = {
    id: "p",
    title: "Acme",
    workspaceRoot: "/work/acme",
    assistant: { coordinatorThreadId },
  };
  const thread = (id: string) => ({ id: ThreadId.make(id), title: "T", pinnedAt: null });

  it("classifies coordinators, Project agents and Tasks threads", () => {
    expect(globalInstructionsScopeOf({ project, thread: thread("coordinator") })).toBe(
      "coordinator",
    );
    expect(globalInstructionsScopeOf({ project, thread: thread("agent") })).toBe("agent");
    expect(
      globalInstructionsScopeOf({ project: { ...project, assistant: null }, thread: thread("x") }),
    ).toBe("tasks");
  });
});

describe("prepareAssistantRuntime with global instructions", () => {
  const coordinatorThreadId = ThreadId.make("gi-coordinator");
  const agentThreadId = ThreadId.make("gi-agent");
  const taskThreadId = ThreadId.make("gi-task");
  const threads = [coordinatorThreadId, agentThreadId, taskThreadId];
  afterEach(() => threads.forEach(clearAssistantRuntime));

  const projects = {
    assistant: {
      id: "assistant-project",
      title: "Acme",
      workspaceRoot: NodePath.resolve("/work/gi-acme"),
      assistant: { coordinatorThreadId },
    },
    repo: {
      id: "repo-project",
      title: "Repo",
      workspaceRoot: NodePath.resolve("/work/gi-repo"),
      assistant: null,
    },
  };
  const threadShells = {
    [coordinatorThreadId]: {
      id: coordinatorThreadId,
      title: "Acme",
      projectId: "assistant-project",
    },
    [agentThreadId]: { id: agentThreadId, title: "Fix it", projectId: "assistant-project" },
    [taskThreadId]: { id: taskThreadId, title: "Task", projectId: "repo-project" },
  } as Record<string, { id: ThreadId; title: string; projectId: string }>;
  const projection = {
    getThreadShellById: (id: ThreadId) => Effect.succeed(Option.fromNullishOr(threadShells[id])),
    getProjectShellById: (id: string) =>
      Effect.succeed(
        Option.fromNullishOr(Object.values(projects).find((project) => project.id === id)),
      ),
  } as unknown as Parameters<typeof prepareAssistantRuntime>[0]["projection"];

  const prepare = (threadId: ThreadId, global: GlobalInstructionsSource | undefined) =>
    prepareAssistantRuntime({
      threadId,
      projection,
      readFile: (path) => Effect.succeed(path.endsWith("MEMORY.md") ? "- memory rule" : ""),
      global,
    });

  /** Every provider path, as the adapters call it. */
  const promptsFor = (threadId: ThreadId) => ({
    claude: buildRuntimeInstructions({ harness: "Claude Code", threadId }),
    codex: buildCodexDeveloperInstructions("default", {
      model: "gpt-5.5",
      reasoningEffort: "high",
      threadId,
    }),
    opencode: buildRuntimeInstructions({ harness: "OpenCode", model: "a/b", threadId }),
    cursor: buildRuntimeInstructions({ harness: "Cursor", model: "m", threadId }),
    grok: buildRuntimeInstructions({ harness: "Grok", threadId }),
    antigravity: buildRuntimeInstructions({ harness: "Antigravity", model: "m", threadId }),
  });

  effectIt.effect(
    "reaches every provider: inline for Claude, Codex, OpenCode; pointer otherwise",
    () =>
      Effect.gen(function* () {
        for (const threadId of threads) {
          yield* prepare(threadId, source());
          const prompts = promptsFor(threadId);
          for (const inline of [prompts.claude, prompts.codex, prompts.opencode]) {
            expect(inline).toContain(RULES);
          }
          for (const pointer of [prompts.cursor, prompts.grok, prompts.antigravity]) {
            expect(pointer).toContain(`Read \`${PATH}\` before acting.`);
            expect(pointer).not.toContain(RULES);
          }
        }
      }),
  );

  effectIt.effect("orders global, then the Project block with its MEMORY.md", () =>
    Effect.gen(function* () {
      yield* prepare(coordinatorThreadId, source());
      const prompt = promptsFor(coordinatorThreadId).claude;
      const globalAt = prompt.indexOf(RULES);
      const projectAt = prompt.indexOf("<control_plane_project");
      const memoryAt = prompt.indexOf("- memory rule");
      expect(globalAt).toBeGreaterThan(prompt.indexOf("</pull_request_linking>"));
      expect(projectAt).toBeGreaterThan(globalAt);
      expect(memoryAt).toBeGreaterThan(projectAt);
    }),
  );

  effectIt.effect("leaves every prompt unchanged by default (empty file)", () =>
    Effect.gen(function* () {
      for (const threadId of threads) {
        yield* prepare(threadId, undefined);
        const before = promptsFor(threadId);
        const beforeKey = readAssistantRuntime(threadId)?.roleKey;
        yield* prepare(threadId, source(""));
        expect(promptsFor(threadId)).toEqual(before);
        expect(readAssistantRuntime(threadId)?.roleKey).toBe(beforeKey);
      }
      expect(readAssistantRuntime(taskThreadId)).toBeUndefined();
    }),
  );

  effectIt.effect("drops the block for scopes that are off", () =>
    Effect.gen(function* () {
      const off = source(RULES, { coordinators: false, projectAgents: false, tasks: false });
      for (const threadId of threads) {
        yield* prepare(threadId, off);
        expect(promptsFor(threadId).claude).not.toContain("<global_instructions");
      }
      yield* prepare(taskThreadId, source(RULES, { coordinators: false, projectAgents: false }));
      expect(promptsFor(taskThreadId).claude).toContain(RULES);
      yield* prepare(agentThreadId, source(RULES, { tasks: false, coordinators: false }));
      expect(promptsFor(agentThreadId).claude).toContain(RULES);
    }),
  );
});

describe("manageGlobalInstructions", () => {
  effectIt.effect("reads an absent file as empty and round-trips a write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-global-instructions-" });
      const path = globalInstructionsPath(stateDir);

      const empty = yield* manageGlobalInstructions(stateDir, { action: "read" });
      expect(empty).toEqual({ path, text: "", capChars: GLOBAL_INSTRUCTIONS_CAP_CHARS });

      const written = yield* manageGlobalInstructions(stateDir, { action: "write", text: RULES });
      expect(written.text).toBe(RULES);
      expect(yield* fs.readFileString(path)).toBe(RULES);
      expect((yield* manageGlobalInstructions(stateDir, { action: "read" })).text).toBe(RULES);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
