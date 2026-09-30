// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_RUNNING_CAP } from "../orchestration/agentProtocol.ts";
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
    expect(block?.pointer).toContain(`Read \`${memoryPath}\` before acting and keep it current.`);
    expect(block?.pointer).toContain("Do not reply to acknowledgements.");
    expect(block?.pointer).not.toContain("Route billing");
  });

  it("teaches each role the agent tools it may use", () => {
    const project = makeProject();
    const build = (thread: ReturnType<typeof makeThread>) =>
      buildAssistantRuntimeBlock({ project, thread, memory: "", roleFile: "" });
    const coordinator = build(makeThread("coordinator"));
    const standing = build(makeThread("agent", { title: "Research", pinnedAt: PINNED_AT }));
    const oneOff = build(makeThread("agent"));

    for (const tool of ["cp_agent_create", "cp_agent_list", "cp_agent_read", "cp_agent_stop"]) {
      expect(coordinator?.inline).toContain(tool);
    }
    expect(coordinator?.inline).toContain("cp_thread_send");
    expect(coordinator?.inline).toContain(
      `first write its role to \`${NodePath.join(project.workspaceRoot, "<slug>", "AGENTS.md")}\``,
    );
    expect(coordinator?.inline).toContain(
      `At most ${AGENT_RUNNING_CAP} agents run at once in this Project.`,
    );
    expect(coordinator?.pointer).toContain(
      "Delegate with cp_agent_create; results arrive as messages, so end your turn after delegating.",
    );
    // Cursor, Grok and Antigravity see only the pointer, so it keeps each role's delivery rules.
    expect(coordinator?.pointer).toContain(
      `write the agent's role to \`${NodePath.join(project.workspaceRoot, "<slug>", "AGENTS.md")}\``,
    );

    expect(standing?.inline).toContain(
      "You are a standing agent in the Control Plane Project Acme Ops.",
    );
    expect(standing?.inline).toContain("cp_agent_create (never standing ones)");
    const sendCombined =
      "send the combined result to the coordinator (threadId coordinator) with cp_thread_send.";
    expect(standing?.inline).toContain(`After your agents report back, ${sendCombined}`);
    expect(standing?.inline).not.toMatch(/cp_agent_(list|read|stop)/);
    expect(standing?.pointer).toContain(
      `You may start one-off agents with cp_agent_create; you count toward the Project's ${AGENT_RUNNING_CAP} running agents.`,
    );
    expect(standing?.pointer).toContain(
      `Only turns the coordinator asked for report back automatically; after your agents report, ${sendCombined}`,
    );

    expect(oneOff?.inline).toContain(
      "your final message goes back to it automatically, so do not also send it with cp_thread_send.",
    );
    expect(oneOff?.inline).not.toContain("cp_agent_");
    // Cursor, Grok and Antigravity see only the pointer, and must not send their result twice.
    expect(oneOff?.pointer).toContain("so do not also send it with cp_thread_send.");
    expect(oneOff?.pointer).not.toContain("coordinator (threadId");
    expect(oneOff?.pointer).not.toContain("cp_agent_");
  });

  it("tells only the coordinator to schedule when asked, and that schedules start paused", () => {
    const project = makeProject();
    const build = (thread: ReturnType<typeof makeThread>) =>
      buildAssistantRuntimeBlock({ project, thread, memory: "", roleFile: "" });
    const rule =
      "Create or edit schedules with cp_schedule_* only when the user asks; they stay paused until the user turns them on.";

    const coordinator = build(makeThread("coordinator"));
    expect(coordinator?.inline).toContain(rule);
    // Cursor, Grok and Antigravity see only the pointer.
    expect(coordinator?.pointer).toContain(rule);
    for (const agent of [
      build(makeThread("agent", { title: "Research", pinnedAt: PINNED_AT })),
      build(makeThread("agent")),
    ]) {
      expect(agent?.inline).not.toMatch(/schedule/i);
      expect(agent?.pointer).not.toMatch(/schedule/i);
    }
  });

  it("gives coordinators and agents their own thread browser instructions", () => {
    const project = makeProject();
    const build = (thread: ReturnType<typeof makeThread>) =>
      buildAssistantRuntimeBlock({ project, thread, memory: "", roleFile: "" });
    const coordinatorRule =
      "Every delegation message must tell the agent to use its own built-in Control Plane browser (preview_* tools) for all browsing, including logged-in sites, and never the user's desktop browsers. Each coordinator and agent has its own browser tabs; do not send browser work to another coordinator or reuse another thread's browser.";
    const agentRule =
      "Always use your own thread's built-in Control Plane browser via the preview_* tools for all browsing, testing and screenshots, including logged-in sites. Load the tools if they are not loaded yet, then call preview_status or preview_open (without tabId) before preview_navigate, preview_snapshot and the other preview_* tools. Never open or drive the user's desktop browsers: never run `open <url>`, never AppleScript a browser, never use computer-use tools for one. Logins persist in the built-in browser profile. If a site needs a login you don't have, stop and ask the user to sign in once in the Control Plane browser panel (or import from their browser with the browser's import option), then continue. If preview_open reports no automation host, report the tool error; switching to another thread's browser does not repair the host connection.";

    const coordinator = build(makeThread("coordinator"));
    expect(coordinator?.inline).toContain(coordinatorRule);
    expect(coordinator?.pointer).toContain(coordinatorRule);
    expect(coordinator?.inline).toContain(agentRule);
    expect(coordinator?.pointer).toContain(agentRule);

    for (const agent of [
      build(makeThread("agent", { title: "Research", pinnedAt: PINNED_AT })),
      build(makeThread("agent")),
    ]) {
      expect(agent?.inline).toContain(agentRule);
      // Cursor, Grok and Antigravity see only the pointer.
      expect(agent?.pointer).toContain(agentRule);
      expect(agent?.inline).not.toContain(coordinatorRule);
    }
    for (const block of [
      coordinator,
      build(makeThread("agent", { title: "Research", pinnedAt: PINNED_AT })),
      build(makeThread("agent")),
    ]) {
      expect(block?.inline).not.toMatch(/chrome|safari|helium|firefox/i);
      expect(block?.inline).not.toContain("\u2014");
    }
  });

  it("tells the coordinator to settle finished agents with cp_agent_settle, and no agent to", () => {
    const project = makeProject();
    const build = (thread: ReturnType<typeof makeThread>) =>
      buildAssistantRuntimeBlock({ project, thread, memory: "", roleFile: "" });
    const rule =
      "Settle agents with cp_agent_settle once their work is complete (for example, merged) and no follow-ups remain. Reporting a result does not settle an agent. It fails while an agent is working; a settled agent wakes on a new message.";

    const coordinator = build(makeThread("coordinator"));
    expect(coordinator?.inline).toContain(rule);
    expect(coordinator?.inline).toContain(
      "An agent is one-off by default and stays available for follow-ups after it reports.",
    );
    expect(coordinator?.inline).not.toContain("settles after it reports");
    // Cursor, Grok and Antigravity see only the pointer.
    expect(coordinator?.pointer).toContain(rule);
    for (const agent of [
      build(makeThread("agent", { title: "Research", pinnedAt: PINNED_AT })),
      build(makeThread("agent")),
    ]) {
      expect(agent?.inline).not.toContain("cp_agent_settle");
      expect(agent?.pointer).not.toContain("cp_agent_settle");
    }
  });

  it("tells every agent never to end its turn just to wait, and no coordinator", () => {
    const project = makeProject();
    const build = (thread: ReturnType<typeof makeThread>) =>
      buildAssistantRuntimeBlock({ project, thread, memory: "", roleFile: "" });
    const rule =
      "Never end your turn just to wait for a command, test run, or sub-agent. Run it in the foreground or keep polling until it finishes. Your turn ending is what reports back to the coordinator, so end only with your final report or a question for the user.";
    const exception =
      "The exception is agents you start with cp_agent_create: end your turn after starting them, and their results arrive as messages.";

    const standing = build(makeThread("agent", { title: "Research", pinnedAt: PINNED_AT }));
    const oneOff = build(makeThread("agent"));
    for (const agent of [standing, oneOff]) {
      expect(agent?.inline).toContain(rule);
      // Cursor, Grok and Antigravity see only the pointer.
      expect(agent?.pointer).toContain(rule);
      expect(agent?.inline).not.toContain("\u2014");
    }
    // Only a standing agent starts agents, so only it needs the exception.
    expect(standing?.inline).toContain(exception);
    expect(standing?.pointer).toContain(exception);
    expect(oneOff?.inline).not.toContain(exception);
    expect(oneOff?.pointer).not.toContain(exception);

    const coordinator = build(makeThread("coordinator"));
    expect(coordinator?.inline).not.toContain(rule);
    expect(coordinator?.pointer).not.toContain(rule);
  });

  it("grants the agents capability to the coordinator and standing agents only", () => {
    const project = makeProject();
    const agentsOf = (thread: ReturnType<typeof makeThread>) =>
      buildAssistantRuntimeBlock({ project, thread, memory: "", roleFile: "" })?.agents;

    expect(agentsOf(makeThread("coordinator"))).toBe(true);
    expect(agentsOf(makeThread("agent", { pinnedAt: PINNED_AT }))).toBe(true);
    expect(agentsOf(makeThread("agent", { title: "営業", pinnedAt: PINNED_AT }))).toBe(true);
    expect(agentsOf(makeThread("agent"))).toBe(false);
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

  it("tells a one-off agent to end its turn with its result or a question for the user", () => {
    const block = buildAssistantRuntimeBlock({
      project: makeProject(),
      thread: makeThread("agent"),
      memory: "",
      roleFile: "",
    });

    expect(block?.inline).toContain(
      "You are an agent in the Control Plane Project Acme Ops. End your turn with your result, or with your question when you need the user.",
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
    const oneOff = makeThread("agent", { title: "Sales" });
    const standing = makeThread("agent", { title: "Sales", pinnedAt: PINNED_AT });
    const oneOffKey = assistantRoleKey({ project, thread: oneOff });

    expect(assistantRoleKey({ project, thread: standing })).not.toBe(oneOffKey);
    expect(assistantRoleKey({ project: { ...project, title: "Acme" }, thread: oneOff })).not.toBe(
      oneOffKey,
    );
    expect(
      assistantRoleKey({
        project: { ...project, title: "Acme" },
        thread: makeThread("coordinator"),
      }),
    ).not.toBe(assistantRoleKey({ project, thread: makeThread("coordinator") }));
  });

  it("changes a standing agent's key, and no one-off agent's, on Set as coordinator", () => {
    const project = makeProject();
    const promoted = { ...project, assistant: { coordinatorThreadId: ThreadId.make("promoted") } };
    const standing = makeThread("agent", { title: "Sales", pinnedAt: PINNED_AT });
    const oneOff = makeThread("agent", { title: "Sales" });

    // A standing agent's text names the coordinator by threadId.
    expect(assistantRoleKey({ project: promoted, thread: standing })).not.toBe(
      assistantRoleKey({ project, thread: standing }),
    );
    expect(assistantRoleKey({ project: promoted, thread: oneOff })).toBe(
      assistantRoleKey({ project, thread: oneOff }),
    );
  });

  it("changes on pin and unpin for a standing agent whose title has no slug", () => {
    const project = makeProject();
    const oneOff = assistantRoleKey({ project, thread: makeThread("agent", { title: "営業" }) });
    const standing = assistantRoleKey({
      project,
      thread: makeThread("agent", { title: "営業", pinnedAt: PINNED_AT }),
    });

    expect(standing).not.toBe(oneOff);
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
