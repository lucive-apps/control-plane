import {
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  REMOTE_START_GRACE_MS,
  judgeRequest,
  machineLoad,
  remotePhase,
  remoteReadTurns,
  remoteResultText,
  remoteStartFailureDetail,
  type PeerThreadView,
} from "./remoteAgentState.ts";

const T0 = "2026-01-01T12:00:00.000Z";
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(Date.parse(T0) + offsetMs));

const session = (
  status: OrchestrationSession["status"],
  lastError: string | null = null,
): OrchestrationSession => ({
  threadId: ThreadId.make("agent-1"),
  status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError,
  updatedAt: T0,
});

const turn = (
  turnId: string,
  state: OrchestrationLatestTurn["state"],
  requestedAt = T0,
): OrchestrationLatestTurn => ({
  turnId: TurnId.make(turnId),
  state,
  requestedAt,
  startedAt: requestedAt,
  completedAt: state === "running" ? null : requestedAt,
  assistantMessageId: null,
});

const view = (overrides: Partial<PeerThreadView> = {}): PeerThreadView => ({
  latestTurn: null,
  session: session("ready"),
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  ...overrides,
});

const judge = (thread: PeerThreadView, baselineTurnId: string | null = "turn-0", sentAgeMs = 0) =>
  judgeRequest({ baselineTurnId, thread, sentAgeMs });

describe("judgeRequest", () => {
  it("waits while the agent is busy or blocked on the user, even after a new turn ended", () => {
    const ended = turn("turn-1", "completed");
    for (const thread of [
      view({ latestTurn: ended, hasPendingApprovals: true }),
      view({ latestTurn: ended, hasPendingUserInput: true }),
      view({ latestTurn: ended, session: session("starting") }),
      view({ latestTurn: ended, session: session("running") }),
    ]) {
      expect(judge(thread, "turn-0", 60_000)).toEqual({ kind: "waiting" });
    }
  });

  it("is done when a turn newer than the baseline finished, failed or was interrupted", () => {
    expect(judge(view({ latestTurn: turn("turn-1", "completed") }))).toEqual({
      kind: "done",
      outcome: { kind: "finished" },
      startFailure: false,
    });
    expect(
      judge(view({ latestTurn: turn("turn-1", "error"), session: session("ready", "Overloaded") })),
    ).toEqual({
      kind: "done",
      outcome: { kind: "failed", lastError: "Overloaded" },
      startFailure: false,
    });
    expect(judge(view({ latestTurn: turn("turn-1", "error"), session: null }))).toEqual({
      kind: "done",
      outcome: { kind: "failed", lastError: null },
      startFailure: false,
    });
    expect(judge(view({ latestTurn: turn("turn-1", "interrupted") }))).toEqual({
      kind: "done",
      outcome: { kind: "stopped" },
      startFailure: false,
    });
  });

  it("treats any turn as new when there was no baseline", () => {
    expect(judge(view({ latestTurn: turn("turn-1", "completed") }), null)).toMatchObject({
      kind: "done",
      outcome: { kind: "finished" },
    });
  });

  it("is not done when the latest turn is still the baseline", () => {
    for (const state of ["completed", "error", "interrupted"] as const) {
      expect(judge(view({ latestTurn: turn("turn-0", state) }), "turn-0", 10 * 60_000)).toEqual({
        kind: "waiting",
      });
    }
  });

  it("waits while the new turn is running", () => {
    expect(judge(view({ latestTurn: turn("turn-1", "running") }))).toEqual({ kind: "waiting" });
  });

  it("reads a session error with no new turn as a start failure at once", () => {
    expect(
      judge(
        view({ latestTurn: turn("turn-0", "completed"), session: session("error", "No model") }),
      ),
    ).toEqual({
      kind: "done",
      outcome: { kind: "failed-to-start", detail: "No model" },
      startFailure: true,
    });
  });

  it("reads a stopped or interrupted session with no new turn as a start failure only after the grace", () => {
    for (const status of ["stopped", "interrupted"] as const) {
      const thread = view({ latestTurn: turn("turn-0", "completed"), session: session(status) });
      expect(judge(thread, "turn-0", 1_000)).toEqual({ kind: "waiting" });
      expect(judge(thread, "turn-0", REMOTE_START_GRACE_MS)).toEqual({ kind: "waiting" });
      expect(judge(thread, "turn-0", REMOTE_START_GRACE_MS + 1)).toEqual({
        kind: "done",
        outcome: { kind: "failed-to-start", detail: null },
        startFailure: true,
      });
    }
  });

  it("waits with no session and no turn yet", () => {
    expect(judge(view({ session: null }), null, 10 * 60_000)).toEqual({ kind: "waiting" });
    expect(judge(view({ session: session("idle") }), null, 10 * 60_000)).toEqual({
      kind: "waiting",
    });
  });
});

describe("remotePhase", () => {
  const phase = (thread: PeerThreadView | null, reachable = true, requestPending = false) =>
    remotePhase({ thread, reachable, requestPending });

  it("is stale when the machine is unreachable or the thread is unknown", () => {
    expect(phase(view({ session: session("running") }), false)).toBe("stale");
    expect(phase(null)).toBe("stale");
  });

  it("maps pending approvals, input and live sessions first", () => {
    expect(phase(view({ hasPendingApprovals: true, hasPendingUserInput: true }))).toBe(
      "waiting_for_approval",
    );
    expect(phase(view({ hasPendingUserInput: true }))).toBe("waiting_for_input");
    expect(phase(view({ session: session("starting") }))).toBe("starting");
    expect(phase(view({ session: session("running"), latestTurn: turn("t", "error") }))).toBe(
      "running",
    );
  });

  it("reads a request the peer has not started as starting", () => {
    expect(phase(view({ latestTurn: turn("t", "completed") }), true, true)).toBe("starting");
  });

  it("maps the latest turn when idle", () => {
    expect(phase(view({ latestTurn: turn("t", "error") }))).toBe("failed");
    expect(phase(view({ latestTurn: turn("t", "completed") }))).toBe("completed");
    expect(phase(view({ latestTurn: turn("t", "interrupted") }))).toBe("idle");
    expect(phase(view({ session: null }))).toBe("idle");
  });
});

const shellThread = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    archivedAt: null,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: null,
    ...overrides,
  }) as OrchestrationThreadShell;

describe("machineLoad", () => {
  const snapshot = {
    updatedAt: T0,
    threads: [
      shellThread("running", { session: session("running") }),
      shellThread("approval", { hasPendingApprovals: true }),
      // A first message 30 seconds before the snapshot, no turn yet: counted as starting.
      shellThread("queued", { latestUserMessageAt: at(-30_000) }),
      // The same shape ten minutes before the snapshot: not counted.
      shellThread("old-queued", { latestUserMessageAt: at(-10 * 60_000) }),
      shellThread("idle", {
        session: session("ready"),
        latestTurn: turn("t", "completed", at(-60_000)),
        latestUserMessageAt: at(-61_000),
      }),
      shellThread("archived", {
        session: session("running"),
        archivedAt: at(-1_000),
      }),
    ],
  };

  it("counts running threads judged at the snapshot's own time, ignoring archived ones", () => {
    // The home clock (today) is months after T0, far past any grace; the
    // queued thread still counts because it is judged at the snapshot's time.
    expect(machineLoad({ snapshot, recentPlacements: [] })).toBe(3);
  });

  it("adds recent placements the snapshot does not show running yet", () => {
    expect(
      machineLoad({
        snapshot,
        recentPlacements: [{ threadId: "new-1" }, { threadId: "new-2" }, { threadId: "idle" }],
      }),
    ).toBe(6);
  });

  it("does not double count a placement the snapshot already shows running", () => {
    expect(
      machineLoad({
        snapshot,
        recentPlacements: [{ threadId: "running" }, { threadId: "queued" }, { threadId: "new" }],
      }),
    ).toBe(4);
  });

  it("is zero for an empty machine", () => {
    expect(machineLoad({ snapshot: { updatedAt: T0, threads: [] }, recentPlacements: [] })).toBe(0);
  });
});

const user = (text: string) => ({ role: "user", text, streaming: false });
const assistant = (text: string, streaming = false) => ({ role: "assistant", text, streaming });

describe("remoteReadTurns", () => {
  const messages = [
    assistant("greeting before any request"),
    user("A"),
    assistant("draft a"),
    assistant("a1"),
    user("B"),
    assistant("   "),
    user("C"),
    assistant("c so far", true),
  ];

  it("groups replies under requests; earlier turns read completed or interrupted", () => {
    expect(remoteReadTurns({ messages, latestTurnState: "running", limit: 10 })).toEqual([
      { state: "completed", request: "A", result: "a1" },
      { state: "interrupted", request: "B", result: null },
      { state: "running", request: "C", result: null },
    ]);
  });

  it("maps the latest turn's state", () => {
    const last = (latestTurnState: Parameters<typeof remoteReadTurns>[0]["latestTurnState"]) =>
      remoteReadTurns({ messages, latestTurnState, limit: 10 }).at(-1)?.state;
    expect(last(null)).toBe("queued");
    expect(last("error")).toBe("failed");
    expect(last("completed")).toBe("completed");
    expect(last("interrupted")).toBe("interrupted");
  });

  it("does not count a streaming reply as a result", () => {
    expect(
      remoteReadTurns({
        messages: [user("A"), assistant("done"), assistant("more", true)],
        latestTurnState: "running",
        limit: 5,
      }),
    ).toEqual([{ state: "running", request: "A", result: "done" }]);
  });

  it("keeps the latest `limit` requests, oldest first", () => {
    expect(
      remoteReadTurns({ messages, latestTurnState: "completed", limit: 2 }).map(
        (entry) => entry.request,
      ),
    ).toEqual(["B", "C"]);
  });

  it("is empty with no requests", () => {
    expect(
      remoteReadTurns({ messages: [assistant("hi")], latestTurnState: null, limit: 5 }),
    ).toEqual([]);
  });
});

describe("remoteResultText", () => {
  const messages = [
    { id: "u1", ...user("first") },
    { id: "a1", ...assistant("old reply") },
    { id: "req", ...user("the request") },
    { id: "a2", ...assistant("partial") },
    { id: "a3", ...assistant("final") },
    { id: "a4", ...assistant("   ") },
    { id: "a5", ...assistant("still writing", true) },
  ];

  it("is the last complete reply after the request", () => {
    expect(remoteResultText({ messages, requestMessageId: "req" })).toBe("final");
  });

  it("is null when nothing after the request is a complete reply", () => {
    expect(
      remoteResultText({ messages: messages.slice(0, 3), requestMessageId: "req" }),
    ).toBeNull();
  });

  it("falls back to the last complete reply when the request is outside the window", () => {
    expect(remoteResultText({ messages: messages.slice(3), requestMessageId: "req" })).toBe(
      "final",
    );
    expect(remoteResultText({ messages: messages.slice(0, 2), requestMessageId: "req" })).toBe(
      "old reply",
    );
  });
});

describe("remoteStartFailureDetail", () => {
  const failed = (payload: unknown) => ({ kind: "provider.turn.start.failed", payload });

  it("returns the detail of the start failure for this request", () => {
    expect(
      remoteStartFailureDetail({
        activities: [
          failed({ requestId: "other", detail: "Wrong request" }),
          { kind: "provider.turn.started", payload: { requestId: "req", detail: "Not a failure" } },
          failed({ requestId: "req", detail: "Model gpt-9 is not available" }),
        ],
        requestMessageId: "req",
      }),
    ).toBe("Model gpt-9 is not available");
  });

  it("prefers the latest matching failure", () => {
    expect(
      remoteStartFailureDetail({
        activities: [
          failed({ requestId: "req", detail: "first" }),
          failed({ requestId: "req", detail: "second" }),
        ],
        requestMessageId: "req",
      }),
    ).toBe("second");
  });

  it("is null without a matching failure or a usable detail", () => {
    const detail = (activities: ReadonlyArray<{ kind: string; payload: unknown }>) =>
      remoteStartFailureDetail({ activities, requestMessageId: "req" });
    expect(detail([])).toBeNull();
    expect(detail([failed(null), failed("req"), failed({ requestId: "other" })])).toBeNull();
    expect(detail([failed({ requestId: "req", detail: "" })])).toBeNull();
    expect(detail([failed({ requestId: "req", detail: 42 })])).toBeNull();
  });
});
