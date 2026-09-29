/**
 * Pure rules behind the `cp_agent_*` tools: which thread a reference names,
 * which model and runtime mode a new agent gets, its deterministic id, which
 * requests a stop cuts off, and how `cp_agent_read` condenses a thread.
 * Fork-owned; the handlers stay thin.
 *
 * @module agentScope
 */
import {
  isProviderAvailable,
  isRunningAgent,
  type MessageId,
  type ModelSelection,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type RuntimeMode,
  RuntimeMode as RuntimeModeSchema,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";

import { agentSendId, capUtf8 } from "../../../orchestration/agentProtocol.ts";
import { threadHasQueuedTurnStart } from "../../../orchestration/ThreadSettlementPolicy.ts";
import type { ProjectionThreadMessage } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";

/**
 * Counts toward the Project's running cap: live work, work blocked on the
 * user, or a first message no turn has adopted yet (an agent created a moment
 * ago whose session has not started).
 */
export function isAgentCountedRunning(
  thread: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestUserMessageAt" | "latestTurn"
  >,
  now: string,
): boolean {
  return isRunningAgent(thread) || threadHasQueuedTurnStart(thread, now);
}

interface AgentRefThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

export type AgentRefResolution<T> =
  | { readonly kind: "found"; readonly thread: T }
  | { readonly kind: "not-yours" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" };

/**
 * The threads `ref` could name: the thread with that id, else the threads in
 * the caller's Project with that exact title (titles repeat across Projects).
 */
export function agentRefCandidates<T extends AgentRefThread>(
  ref: string,
  input: { readonly threads: ReadonlyArray<T>; readonly projectId: string },
): ReadonlyArray<T> {
  const trimmed = ref.trim();
  const byId = input.threads.find((thread) => thread.id === trimmed);
  if (byId !== undefined) return [byId];
  return input.threads.filter(
    (thread) =>
      thread.projectId === input.projectId &&
      thread.title.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0,
  );
}

/**
 * Resolves a threadId or exact title. An id matches any live thread, so an id
 * from another Project reads as "not yours". A title matches only in the
 * caller's Project and prefers threads the caller manages.
 */
export function resolveAgentRef<T extends AgentRefThread>(
  ref: string,
  input: {
    readonly threads: ReadonlyArray<T>;
    readonly projectId: string;
    readonly canManage: (thread: T) => boolean;
  },
): AgentRefResolution<T> {
  const candidates = agentRefCandidates(ref, input);
  const [first] = candidates;
  if (first === undefined) return { kind: "not-found" };
  if (first.id === ref.trim()) {
    return input.canManage(first) ? { kind: "found", thread: first } : { kind: "not-yours" };
  }
  const managed = candidates.filter(input.canManage);
  if (managed.length === 1) return { kind: "found", thread: managed[0]! };
  return managed.length === 0 ? { kind: "not-yours" } : { kind: "ambiguous" };
}

export type AgentModelResolution =
  | { readonly kind: "resolved"; readonly modelSelection: ModelSelection }
  | { readonly kind: "unknown"; readonly available: ReadonlyArray<string> };

const MAX_LISTED_MODELS = 20;

/**
 * The model a new agent runs. `base` is the Project's default model, else the
 * coordinator's. A requested model matches on the base instance first, then
 * on exactly one other enabled instance. Options belong to a model, so they
 * are kept only when the model is unchanged.
 */
export function resolveAgentModel(input: {
  readonly requested: string | undefined;
  readonly base: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
}): AgentModelResolution {
  const { requested, base, providers } = input;
  if (requested === undefined) return { kind: "resolved", modelSelection: base };
  const selectionOn = (provider: ServerProvider): ModelSelection | null => {
    const slug = resolveSelectableModel(provider.driver, requested, provider.models);
    if (slug === null) return null;
    if (provider.instanceId === base.instanceId && slug === base.model) return base;
    return { instanceId: provider.instanceId, model: slug };
  };
  const baseProvider = providers.find((provider) => provider.instanceId === base.instanceId);
  const onBase = baseProvider ? selectionOn(baseProvider) : null;
  if (onBase !== null) return { kind: "resolved", modelSelection: onBase };
  const elsewhere = providers
    .filter(
      (provider) =>
        provider.instanceId !== base.instanceId &&
        provider.enabled &&
        isProviderAvailable(provider),
    )
    .flatMap((provider) => {
      const selection = selectionOn(provider);
      return selection === null ? [] : [selection];
    });
  if (elsewhere.length === 1) return { kind: "resolved", modelSelection: elsewhere[0]! };
  return {
    kind: "unknown",
    available: (baseProvider?.models ?? []).slice(0, MAX_LISTED_MODELS).map((model) => model.slug),
  };
}

/** The stricter of two modes, in the order `RuntimeMode` declares them (strictest first). */
export function stricterRuntimeMode(a: RuntimeMode, b: RuntimeMode): RuntimeMode {
  const order = RuntimeModeSchema.literals;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/**
 * A UUIDv8 from a digest (sha256 of `agentCreateIds(...).threadIdSeed`), so a
 * retried create finds the same thread and the UI treats the id as opaque.
 */
export function agentThreadIdFromDigest(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error("A thread id needs at least 16 digest bytes.");
  const uuid = Array.from(bytes.subarray(0, 16));
  uuid[6] = (uuid[6]! & 0x0f) | 0x80;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  const hex = uuid.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The `projection_turns` fields the agent tools read. */
export type AgentTurnRow = Pick<
  ProjectionTurn,
  "turnId" | "pendingMessageId" | "assistantMessageId" | "state" | "requestedAt"
>;

/** Oldest first; a pending start (no turn id yet) sorts after turns requested at the same time. */
function inRequestOrder(turns: ReadonlyArray<AgentTurnRow>): ReadonlyArray<AgentTurnRow> {
  return [...turns].sort(
    (a, b) =>
      a.requestedAt.localeCompare(b.requestedAt) ||
      (a.turnId === null ? 1 : 0) - (b.turnId === null ? 1 : 0) ||
      (a.turnId ?? "").localeCompare(b.turnId ?? ""),
  );
}

/** A turn start the provider has not picked up yet. */
export function hasPendingTurnStart(turns: ReadonlyArray<AgentTurnRow>): boolean {
  return turns.some((turn) => turn.turnId === null && turn.pendingMessageId !== null);
}

/**
 * The message whose turn a stop would cut off: the one the active turn
 * started (for a continuation after a restart, which has no message of its
 * own, the request before it), else a turn start still waiting for the
 * provider, else, while a session starts or runs with no turn yet, the latest
 * request that started one. Null when the agent is working on nothing.
 */
export function inFlightRequestId(input: {
  readonly turns: ReadonlyArray<AgentTurnRow>;
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
}): MessageId | null {
  const ordered = inRequestOrder(input.turns);
  const latestStartedUpTo = (end: number) =>
    ordered.slice(0, end).findLast((turn) => turn.turnId !== null && turn.pendingMessageId !== null)
      ?.pendingMessageId ?? null;
  const activeTurnId =
    input.session?.status === "running" ? (input.session.activeTurnId ?? null) : null;
  const active =
    activeTurnId === null ? -1 : ordered.findIndex((turn) => turn.turnId === activeTurnId);
  if (active !== -1) return latestStartedUpTo(active + 1);
  const pending = ordered.findLast(
    (turn) => turn.turnId === null && turn.pendingMessageId !== null,
  );
  if (pending !== undefined) return pending.pendingMessageId;
  const status = input.session?.status;
  return status === "starting" || status === "running" ? latestStartedUpTo(ordered.length) : null;
}

/**
 * The manager's `cp_thread_send` messages held in the agent for its turn to
 * end that no turn has started yet. A stop drops them, or they would start
 * the agent again once it is idle.
 */
export function heldRequestIds(input: {
  readonly agentId: string;
  readonly managerId: string;
  readonly messages: ReadonlyArray<Pick<ProjectionThreadMessage, "messageId" | "role" | "source">>;
  readonly turns: ReadonlyArray<AgentTurnRow>;
}): ReadonlyArray<MessageId> {
  const heldPrefix = agentSendId(input.agentId, "");
  const started = new Set(input.turns.map((turn) => turn.pendingMessageId));
  return input.messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.messageId.startsWith(heldPrefix) &&
        message.source?.replyTo === input.managerId &&
        !started.has(message.messageId),
    )
    .map((message) => message.messageId);
}

export type AgentRequestState = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface AgentRequestTurn {
  readonly requestId: MessageId;
  /** The turn's latest assistant message; the handler drops it while it is still streaming. */
  readonly resultId: MessageId | null;
  readonly state: AgentRequestState;
}

const REQUEST_STATES: Record<AgentTurnRow["state"], AgentRequestState> = {
  pending: "queued",
  running: "running",
  completed: "completed",
  error: "failed",
  interrupted: "interrupted",
};

/**
 * The latest `limit` requests, oldest first, each paired with the turn it
 * started. Pairing goes through the turn, never message order: a message
 * appended while an earlier turn ran would otherwise take that turn's result.
 * A turn with no message of its own (a continuation after a restart) carries
 * on the request before it. Messages appended but not yet started do not show.
 */
export function agentRequestTurns(
  turns: ReadonlyArray<AgentTurnRow>,
  limit: number,
): ReadonlyArray<AgentRequestTurn> {
  const requests: Array<AgentRequestTurn> = [];
  for (const turn of inRequestOrder(turns)) {
    const state = REQUEST_STATES[turn.state];
    if (turn.pendingMessageId !== null) {
      requests.push({
        requestId: turn.pendingMessageId,
        resultId: turn.turnId === null ? null : turn.assistantMessageId,
        state,
      });
    } else if (turn.turnId !== null && requests.length > 0) {
      const previous = requests[requests.length - 1]!;
      requests[requests.length - 1] = {
        ...previous,
        resultId: turn.assistantMessageId ?? previous.resultId,
        state,
      };
    }
  }
  return requests.slice(-limit);
}

export const AGENT_READ_REQUEST_CAP_BYTES = 2_000;
export const AGENT_READ_RESULT_CAP_BYTES = 8_000;
export const AGENT_READ_TOTAL_CAP_BYTES = 24 * 1_024;
const READ_TRUNCATED = "\n[truncated]";

export interface AgentReadTurn {
  readonly state: AgentRequestState;
  readonly request: string;
  readonly result: string | null;
}

/**
 * Cuts each request and result to its own cap, newest first; older turns that
 * would push the total past its cap are left out whole.
 */
export function capAgentReadTurns(
  turns: ReadonlyArray<AgentReadTurn>,
): ReadonlyArray<AgentReadTurn> {
  const capped: Array<AgentReadTurn> = [];
  let remaining = AGENT_READ_TOTAL_CAP_BYTES;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const request = capUtf8(turn.request, AGENT_READ_REQUEST_CAP_BYTES, READ_TRUNCATED);
    const result =
      turn.result === null
        ? null
        : capUtf8(turn.result, AGENT_READ_RESULT_CAP_BYTES, READ_TRUNCATED);
    const bytes = Buffer.byteLength(request, "utf8") + Buffer.byteLength(result ?? "", "utf8");
    if (bytes > remaining) break;
    remaining -= bytes;
    capped.unshift({ state: turn.state, request, result });
  }
  return capped;
}
