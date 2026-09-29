import { describe, expect, it } from "vite-plus/test";

import { AGENT_RESULT_CAP_BYTES } from "./agentProtocol.ts";
import {
  formatAgentResult,
  isDeliveryIdle,
  openMessageQuestions,
  type AgentResultOutcome,
} from "./agentPushes.ts";

const header = (state: string) => `Result from agent "Compare" (threadId agent-1): ${state}`;

const format = (outcome: AgentResultOutcome, text: string | null, questions: string[] = []) =>
  formatAgentResult({
    agentTitle: "Compare",
    agentThreadId: "agent-1",
    outcome,
    text,
    questions,
  });

describe("formatAgentResult", () => {
  it("states how the request ended, then the agent's last reply", () => {
    expect(format({ kind: "finished" }, "WAL is faster.\n")).toBe(
      `${header("finished")}\n\nWAL is faster.`,
    );
    expect(format({ kind: "failed", lastError: "Model overloaded" }, "Partial")).toBe(
      `${header("failed: Model overloaded")}\n\nPartial`,
    );
    expect(format({ kind: "failed", lastError: null }, null)).toBe(
      `${header("failed")}\n\n(no final message)`,
    );
    expect(format({ kind: "stopped" }, "   ")).toBe(
      `${header("stopped before finishing")}\n\n(no final message)`,
    );
    expect(format({ kind: "failed-to-start", detail: "Provider unavailable" }, null)).toBe(
      `${header("failed to start: Provider unavailable")}\n\n(no final message)`,
    );
  });

  it("cuts a long error and a long reply at a character boundary", () => {
    const lastError = "é".repeat(400);
    const [firstLine] = format({ kind: "failed", lastError }, null).split("\n");
    expect(firstLine).toBe(header(`failed: ${"é".repeat(250)}...`));

    const reply = "€".repeat(AGENT_RESULT_CAP_BYTES);
    const body = format({ kind: "finished" }, reply).split("\n\n")[1]!;
    expect(body).toBe(
      `${"€".repeat(Math.floor(AGENT_RESULT_CAP_BYTES / 3))}\n[truncated: use cp_agent_read for the rest]`,
    );
  });

  it("lists open questions for the user after the reply", () => {
    expect(format({ kind: "finished" }, null, ["Which city?", "Which season?"])).toBe(
      `${header("finished")}\n\n(no final message)\n\nQuestions for the user:\n- Which city?\n- Which season?`,
    );
  });
});

describe("openMessageQuestions", () => {
  it("keeps unanswered message-mode questions only", () => {
    const requested = (requestId: string, question: string, responseMode?: "message") => ({
      kind: "user-input.requested",
      payload: {
        requestId,
        questions: [{ id: "q", header: "Q", question, options: [] }],
        ...(responseMode ? { responseMode } : {}),
      },
    });
    expect(
      openMessageQuestions([
        requested("native", "Approve the plan?"),
        requested("answered", "Which repo?", "message"),
        { kind: "user-input.resolved", payload: { requestId: "answered", answers: {} } },
        requested("open", "Which city?", "message"),
      ]),
    ).toEqual(["Which city?"]);
  });
});

describe("isDeliveryIdle", () => {
  const now = "2026-09-28T12:00:00.000Z";
  const ready = { status: "ready" };

  it("waits for a working session", () => {
    expect(isDeliveryIdle({ status: "running" }, null, now)).toBe(false);
    expect(isDeliveryIdle({ status: "starting" }, null, now)).toBe(false);
    expect(isDeliveryIdle(null, null, now)).toBe(true);
    expect(isDeliveryIdle(ready, null, now)).toBe(true);
  });

  it("waits for a fresh unadopted start but not a stale one", () => {
    expect(isDeliveryIdle(ready, { requestedAt: "2026-09-28T11:59:00.000Z" }, now)).toBe(false);
    expect(isDeliveryIdle(ready, { requestedAt: "2026-09-28T11:57:00.000Z" }, now)).toBe(true);
  });
});
