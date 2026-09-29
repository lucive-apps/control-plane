// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_INLINE_CAP_BYTES,
  assistantRoleKey,
  buildAssistantRuntimeBlock,
  loadAssistantRuntimeBlock,
  noteProjectFileWritten,
} from "./assistantRuntime.ts";

const coordinatorId = ThreadId.make("coordinator");
let rootCounter = 0;

/** Each test gets its own folder, since file epochs are module state. */
function makeProject(overrides?: { readonly title?: string; readonly coordinator?: ThreadId }) {
  rootCounter += 1;
  return {
    id: "project-1",
    title: overrides?.title ?? "Acme Ops",
    workspaceRoot: NodePath.resolve(`/work/acme-${rootCounter}`),
    assistant: { coordinatorThreadId: overrides?.coordinator ?? coordinatorId },
  };
}

function makeThread(id: string, overrides?: { title?: string; pinnedAt?: string | null }) {
  return {
    id: ThreadId.make(id),
    title: overrides?.title ?? "Sales",
    pinnedAt: overrides?.pinnedAt ?? null,
  };
}

const PINNED_AT = "2026-09-28T10:00:00.000Z";

describe("buildAssistantRuntimeBlock", () => {
  it("inlines the coordinator's rules and Memory with the absolute MEMORY.md path", () => {
    const project = makeProject();
    const block = buildAssistantRuntimeBlock({
      project,
      thread: makeThread("coordinator", { title: "Acme Ops" }),
      memory: "- Route billing to Sales\n",
      roleFile: "",
    });
    const memoryPath = NodePath.join(project.workspaceRoot, "MEMORY.md");

    expect(block?.inline).toContain(
      `<control_plane_project role="coordinator" name="Acme Ops" folder="${project.workspaceRoot}">`,
    );
    expect(block?.inline).toContain(`Your memory is ${memoryPath}.`);
    expect(block?.inline).toContain("<memory>\n- Route billing to Sales\n</memory>");
    expect(block?.inline).toContain("cp_thread_send");
    expect(block?.inline).not.toMatch(/cp_agent_|schedule/i);
    expect(block?.pointer).toContain(`Read \`${memoryPath}\` before acting and keep it current.`);
    expect(block?.pointer).toContain("Do not reply to acknowledgements.");
    expect(block?.pointer).not.toContain("Route billing");
  });

  it("caps Memory on a UTF-8 boundary and points to the file for the rest", () => {
    // One ASCII byte shifts every two-byte "é" so the cap lands mid-character.
    const memory = `a${"é".repeat(ASSISTANT_INLINE_CAP_BYTES)}`;
    const project = makeProject();
    const block = buildAssistantRuntimeBlock({
      project,
      thread: makeThread("coordinator"),
      memory,
      roleFile: "",
    });
    const kept = `a${"é".repeat((ASSISTANT_INLINE_CAP_BYTES - 2) / 2)}`;

    expect(Buffer.byteLength(kept)).toBe(ASSISTANT_INLINE_CAP_BYTES - 1);
    expect(block?.inline).toContain(
      `<memory>\n${kept}\n[truncated: read ${NodePath.join(project.workspaceRoot, "MEMORY.md")} for the rest]\n</memory>`,
    );
    expect(block?.inline).not.toContain("�");
  });

  it("tells a one-off agent to end its turn with a question for the user", () => {
    const block = buildAssistantRuntimeBlock({
      project: makeProject(),
      thread: makeThread("agent"),
      memory: "",
      roleFile: "",
    });

    expect(block?.inline).toContain(
      "You are an agent in the Control Plane Project Acme Ops. When you need the user, end your turn with the question.",
    );
    expect(block?.inline).not.toContain("<role");
    expect(block?.inline).not.toContain("MEMORY.md");
  });

  it("inlines a standing agent's role file and points ACP providers to it", () => {
    const project = makeProject();
    const block = buildAssistantRuntimeBlock({
      project,
      thread: makeThread("agent", { title: "Sales Desk", pinnedAt: PINNED_AT }),
      memory: "",
      roleFile: "Qualify every lead.\n",
    });
    const rolePath = NodePath.join(project.workspaceRoot, "sales-desk", "AGENTS.md");

    expect(block?.inline).toContain(`<role file="${rolePath}">\nQualify every lead.\n</role>`);
    expect(block?.pointer).toContain(`Your role file: \`${rolePath}\``);
    expect(block?.pointer).not.toContain("Qualify every lead.");
  });

  it("gives a standing agent with an empty slug no role file", () => {
    const block = buildAssistantRuntimeBlock({
      project: makeProject(),
      thread: makeThread("agent", { title: "営業", pinnedAt: PINNED_AT }),
      memory: "",
      roleFile: "",
    });

    expect(block?.inline).not.toContain("<role");
    expect(block?.pointer).not.toContain("role file");
  });

  it("returns null outside a Project", () => {
    expect(
      buildAssistantRuntimeBlock({
        project: { ...makeProject(), assistant: null },
        thread: makeThread("agent"),
        memory: "anything",
        roleFile: "",
      }),
    ).toBeNull();
    expect(
      buildAssistantRuntimeBlock({
        project: undefined,
        thread: makeThread("agent"),
        memory: "",
        roleFile: "",
      }),
    ).toBeNull();
  });
});

describe("assistantRoleKey", () => {
  it("is none for a plain workspace", () => {
    expect(
      assistantRoleKey({ project: { ...makeProject(), assistant: null }, thread: makeThread("a") }),
    ).toBe("none");
  });

  it("changes on promote to coordinator and on Move to Tasks", () => {
    const project = makeProject();
    const thread = makeThread("agent");
    const asAgent = assistantRoleKey({ project, thread });
    const asCoordinator = assistantRoleKey({
      project: { ...project, assistant: { coordinatorThreadId: thread.id } },
      thread,
    });
    const movedToTasks = assistantRoleKey({ project: { ...project, assistant: null }, thread });

    expect(asCoordinator).not.toBe(asAgent);
    expect(movedToTasks).toBe("none");
    expect(asAgent).not.toBe("none");
    expect(asCoordinator).not.toBe("none");
  });

  it("changes on pin and unpin, and on a Project retitle", () => {
    const project = makeProject();
    const task = makeThread("agent", { title: "Sales" });
    const standing = makeThread("agent", { title: "Sales", pinnedAt: PINNED_AT });
    const taskKey = assistantRoleKey({ project, thread: task });

    expect(assistantRoleKey({ project, thread: standing })).not.toBe(taskKey);
    expect(assistantRoleKey({ project: { ...project, title: "Acme" }, thread: task })).not.toBe(
      taskKey,
    );
    expect(
      assistantRoleKey({
        project: { ...project, title: "Acme" },
        thread: makeThread("coordinator"),
      }),
    ).not.toBe(assistantRoleKey({ project, thread: makeThread("coordinator") }));
  });

  it("leaves a one-off agent's key alone when its own title changes", () => {
    const project = makeProject();

    expect(
      assistantRoleKey({ project, thread: makeThread("agent", { title: "New thread" }) }),
    ).toBe(
      assistantRoleKey({ project, thread: makeThread("agent", { title: "Fix the login bug" }) }),
    );
  });

  it("changes only the coordinator's key on a MEMORY.md save", () => {
    const project = makeProject();
    const coordinator = makeThread("coordinator");
    const standing = makeThread("agent", { title: "Sales", pinnedAt: PINNED_AT });
    const before = {
      coordinator: assistantRoleKey({ project, thread: coordinator }),
      standing: assistantRoleKey({ project, thread: standing }),
    };

    noteProjectFileWritten(project.workspaceRoot, "MEMORY.md");

    expect(assistantRoleKey({ project, thread: coordinator })).not.toBe(before.coordinator);
    expect(assistantRoleKey({ project, thread: standing })).toBe(before.standing);
  });

  it("changes only that standing agent's key on its role file save", () => {
    const project = makeProject();
    const coordinator = makeThread("coordinator");
    const sales = makeThread("sales", { title: "Sales", pinnedAt: PINNED_AT });
    const support = makeThread("support", { title: "Support", pinnedAt: PINNED_AT });
    const before = [coordinator, sales, support].map((thread) =>
      assistantRoleKey({ project, thread }),
    );

    // Windows clients may send backslashes.
    noteProjectFileWritten(`${project.workspaceRoot}/`, "sales\\AGENTS.md");

    const after = [coordinator, sales, support].map((thread) =>
      assistantRoleKey({ project, thread }),
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });
});

describe("loadAssistantRuntimeBlock", () => {
  effectIt.effect("keeps the key when the coordinator edits MEMORY.md itself", () =>
    Effect.gen(function* () {
      const project = makeProject();
      const thread = makeThread("coordinator");
      const load = (memory: string) =>
        loadAssistantRuntimeBlock({ project, thread, readFile: () => Effect.succeed(memory) });

      const first = yield* load("- one");
      const edited = yield* load("- one\n- two");

      expect(edited?.inline).toContain("- two");
      expect(edited?.roleKey).toBe(first?.roleKey);
      expect(assistantRoleKey({ project, thread })).toBe(first?.roleKey);
    }),
  );

  effectIt.effect("reads only the files the role uses", () =>
    Effect.gen(function* () {
      const project = makeProject();
      const read: Array<string> = [];
      const readFile = (path: string) => Effect.sync(() => (read.push(path), ""));

      yield* loadAssistantRuntimeBlock({ project, thread: makeThread("agent"), readFile });
      yield* loadAssistantRuntimeBlock({
        project,
        thread: makeThread("agent", { title: "Sales", pinnedAt: PINNED_AT }),
        readFile,
      });
      yield* loadAssistantRuntimeBlock({ project, thread: makeThread("coordinator"), readFile });

      expect(read).toEqual([
        NodePath.join(project.workspaceRoot, "sales", "AGENTS.md"),
        NodePath.join(project.workspaceRoot, "MEMORY.md"),
      ]);
    }),
  );

  effectIt.effect("stores a stale key when a save lands while the file is being read", () =>
    Effect.gen(function* () {
      const project = makeProject();
      const thread = makeThread("coordinator");
      const block = yield* loadAssistantRuntimeBlock({
        project,
        thread,
        readFile: () =>
          Effect.sync(() => {
            noteProjectFileWritten(project.workspaceRoot, "MEMORY.md");
            return "- old";
          }),
      });

      // The next turn sees the mismatch and restarts with the saved file.
      expect(block?.roleKey).not.toBe(assistantRoleKey({ project, thread }));
    }),
  );
});
