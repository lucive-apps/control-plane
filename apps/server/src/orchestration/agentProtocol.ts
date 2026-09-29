/**
 * Ids, limits and text helpers for agents a Project's coordinator or standing
 * agents start. Fork-owned.
 *
 * Command receipts are the delivery ledger: the engine dedupes a command id,
 * and a rejection writes a receipt too. So every step of a result's delivery
 * uses an id derived from the request it answers, and "a receipt exists"
 * means "this step is done", across restarts. Every agent id is built here.
 *
 * @module agentProtocol
 */
import { AGENT_PUSH_MESSAGE_PREFIX } from "@t3tools/contracts";

export { AGENT_PUSH_MESSAGE_PREFIX, isAgentPushMessageId } from "@t3tools/contracts";

/** Running agents per Project, shared by every creator. The coordinator is not counted. */
export const AGENT_RUNNING_CAP = 10;
/** Pushed turns a recipient runs in a row before results pause until a release. */
export const AGENT_PUSH_BUDGET = 6;
/** Largest result text appended into a recipient. */
export const AGENT_RESULT_CAP_BYTES = 16_384;
/** How long a sent message counts as a queued start. Mirrors ThreadSettlementPolicy. */
export const AGENT_QUEUED_START_GRACE_MS = 120_000;

/** Message id prefix of a `cp_thread_send` held until its busy target goes idle. */
export const AGENT_SEND_MESSAGE_PREFIX = "cp-send:";
/** Command id prefix of the turn start of an appended delivery. */
export const AGENT_DELIVERY_START_PREFIX = "cp-start:";
/** Command id prefix of the single retry of a pushed delivery whose start failed. */
export const AGENT_DELIVERY_RETRY_PREFIX = "cp-retry:";
/** Command id prefix of the interrupt `cp_agent_stop` sends. */
export const AGENT_STOP_PREFIX = "cp-agent-stop:";

/**
 * Command id and message id of the result appended for `requestMessageId`,
 * a request made in `agentThreadId`. A receipt of any status means handled.
 */
export function agentPushId(agentThreadId: string, requestMessageId: string): string {
  return `${AGENT_PUSH_MESSAGE_PREFIX}${agentThreadId}:${requestMessageId}`;
}

/** Message id and command id of a `cp_thread_send` held for a busy target. */
export function agentSendId(targetThreadId: string, uuid: string): string {
  return `${AGENT_SEND_MESSAGE_PREFIX}${targetThreadId}:${uuid}`;
}

/** Command id of the turn start of an appended delivery (`cp-push:*` or `cp-send:*`). */
export function agentDeliveryStartId(deliveryMessageId: string): string {
  return `${AGENT_DELIVERY_START_PREFIX}${deliveryMessageId}`;
}

/** Command id of the single retry of a `cp-push:*` start that failed. */
export function agentDeliveryRetryId(deliveryMessageId: string): string {
  return `${AGENT_DELIVERY_RETRY_PREFIX}${deliveryMessageId}`;
}

/** Command id that settles a one-off agent after its result is appended. */
export function agentPushSettleId(agentThreadId: string, requestMessageId: string): string {
  return `cp-push-settle:${agentThreadId}:${requestMessageId}`;
}

/**
 * Id of the "results paused" notice in `threadId` for `recipientThreadId`:
 * one per release, so a paused recipient is told once until it is released.
 */
export function agentPushPausedId(
  threadId: string,
  recipientThreadId: string,
  releaseMessageId: string | null,
): string {
  return `cp-push-paused:${threadId}:${recipientThreadId}:${releaseMessageId ?? "start"}`;
}

/** Id of the activity on the agent when its result's append was rejected. */
export function agentPushFailedId(agentThreadId: string, requestMessageId: string): string {
  return `cp-push-failed:${agentThreadId}:${requestMessageId}`;
}

/**
 * Command id of the interrupt a manager sends with `cp_agent_stop`. Only an
 * accepted receipt with this id suppresses the stopped request's result.
 */
export function agentStopId(
  managerThreadId: string,
  agentThreadId: string,
  requestMessageId: string,
): string {
  return `${AGENT_STOP_PREFIX}${managerThreadId}:${agentThreadId}:${requestMessageId}`;
}

/**
 * Deterministic ids for `cp_agent_create` with a `clientRequestId`, so a
 * retried call finds the agent it already made. `threadIdSeed` is hashed into
 * a UUID so the thread id reads as opaque in the UI.
 */
export function agentCreateIds(callerThreadId: string, clientRequestId: string) {
  const key = `${callerThreadId}:${clientRequestId}`;
  return {
    createCommandId: `cp-agent-create:${key}`,
    pinCommandId: `cp-agent-pin:${key}`,
    startCommandId: `cp-agent-start:${key}`,
    messageId: `cp-agent-message:${key}`,
    threadIdSeed: `cp-agent:${key}`,
  } as const;
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character,
 * then appends `marker`. The marker is not counted in `maxBytes`. Text that
 * fits is returned unchanged.
 */
export function capUtf8(text: string, maxBytes: number, marker: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let cut = maxBytes;
  // Step back off UTF-8 continuation bytes (10xxxxxx) so no character is split.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return `${bytes.subarray(0, cut).toString("utf8")}${marker}`;
}
