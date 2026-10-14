/**
 * MuseAdapter: Muse Code (`muse serve`) over its MSP protocol, on the V1
 * provider runtime.
 *
 * One `muse serve` host per thread owns one native Muse session. Muse
 * reports work as revisioned items (`item/started|updated|completed`) plus
 * text deltas; this adapter turns them into canonical runtime events.
 *
 * Upstream T3 Code runs Muse on orchestration V2. This fork keeps the V1
 * adapter contract, so native subagents and workflows show as tool rows in
 * the parent thread instead of opening child threads, and Muse's
 * self-started report turns join the active turn (or start one of their own).
 *
 * @module MuseAdapter
 */
import { MspError } from "@muse-code/sdk";
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  EventId,
  MUSE_DEFAULT_MODEL,
  type ModelSelection,
  type MuseSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ServerProviderModel,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { museItemStatus, museItemText, museToolPresentation } from "../museItemPresentation.ts";
import { museModelCapabilities, resolveMuseReasoningEffort } from "../museModelCatalog.ts";
import {
  MuseApproval,
  MuseContextUsage,
  MuseDelta,
  type MuseItem,
  MuseItemEvent,
  MuseSessionResult,
  MuseSubscriptionUsage,
  MuseTodoList,
  MuseTokenUsageEvent,
  MuseTurnCompleted,
  MuseTurnRetryScheduled,
  MuseTurnStartResult,
  MuseUserInput,
  museApprovalChoices,
  museApprovalDecision,
  museApprovalOptions,
} from "../museProtocol.ts";
import {
  createMuseSdkHost,
  createMuseSdkHostEffect,
  museApprovalMode,
  type MuseSdkHost,
} from "../museSdk.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { museUsageToLimitsUpdate } from "./museUsageLimits.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const MUSE_RESUME_VERSION = 1 as const;
const HARNESS = "Muse Code";
const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
const responseAnswerSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
// Notifications that only add detail. A malformed one is skipped instead of ending the session.
const INFORMATIONAL_NOTIFICATIONS = new Set([
  "session/contextUsage",
  "session/tokenUsage",
  "usage/changed",
  "session/todoListChanged",
  "turn/retryScheduled",
]);
// Tools whose results already show as their own rows: the todo list, questions, and the
// workflow item a `workflow` call launches.
const TOOLS_WITH_NATIVE_ROWS = new Set(["write_todos", "request_user_input", "workflow"]);

export interface MuseAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly createHost?: typeof createMuseSdkHost;
  readonly requestTimeoutMs?: number;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

interface MuseTurn {
  readonly turnId: TurnId;
  readonly nativeId: string;
  /** Turns Muse started on its own while this one ran, which this turn shows. */
  readonly joined: Set<string>;
  readonly items: Map<string, MuseItem>;
  /** Items whose lifecycle started in T3, and how much of their text was streamed. */
  readonly streamed: Map<string, number>;
  readonly started: Set<string>;
  interruptRequested: boolean;
  tokenUsage?: TurnTokenUsage;
}

interface PendingRequest {
  readonly native:
    | { readonly type: "approval"; readonly value: MuseApproval }
    | { readonly type: "question"; readonly value: MuseUserInput };
  readonly turnId: TurnId | undefined;
  readonly requestType: CanonicalRequestType;
  decided?: ProviderApprovalDecision;
}

interface MuseSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly host: MuseSdkHost;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  model: string | undefined;
  active: MuseTurn | undefined;
  /** Workflows and subagents that outlive their turn, by item id. */
  readonly children: Map<string, MuseTurn>;
  readonly pending: Map<ApprovalRequestId, PendingRequest>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly commands: Semaphore.Semaphore;
  /** The full Project block went out once on this host; later turns get the pointer. */
  projectBlockSent: boolean;
  contextUsage: ThreadTokenUsageSnapshot | undefined;
  stopped: boolean;
}

function parseMuseResume(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== MUSE_RESUME_VERSION) return undefined;
  return typeof record.sessionId === "string" && record.sessionId.trim()
    ? record.sessionId.trim()
    : undefined;
}

function approvalRequestType(approval: MuseApproval): CanonicalRequestType {
  const subject = approval.subject;
  if (subject.kind === "shell") return "command_execution_approval";
  if (subject.kind === "fileAccess")
    return subject.access === "read" ? "file_read_approval" : "file_change_approval";
  return "dynamic_tool_call";
}

function approvalDetail(approval: MuseApproval): string {
  const subject = approval.subject;
  return (
    subject.command ??
    subject.path ??
    subject.host ??
    subject.target ??
    approval.toolName ??
    "Muse requests permission"
  );
}

/** Text a Muse message or reasoning item shows. */
function streamText(item: MuseItem): string {
  return item.text ?? item.summary?.join("\n") ?? "";
}

export const makeMuseAdapter = Effect.fn("makeMuseAdapter")(function* (
  options: MuseAdapterOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const sessions = new Map<ThreadId, MuseSessionContext>();
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const stamp = () =>
    Effect.all({ eventId: Effect.map(randomId, (id) => EventId.make(id)), createdAt: nowIso });
  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
  /** Builds and publishes one event for a session's thread. */
  const publish = <E extends ProviderRuntimeEvent>(
    ctx: Pick<MuseSessionContext, "threadId">,
    event: Omit<E, "eventId" | "createdAt" | "provider" | "threadId">,
  ) =>
    Effect.gen(function* () {
      yield* emit({
        ...(event as object),
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
      } as ProviderRuntimeEvent);
    });

  const requestError = (method: string, detail: string, cause?: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /** One MSP call scoped to the session; commands carry idempotency ids, reads do not. */
  const call = (
    ctx: MuseSessionContext,
    method: string,
    params: Record<string, unknown>,
    options_?: { readonly read?: boolean; readonly commandId?: string },
  ) =>
    Effect.tryPromise({
      try: () =>
        options_?.read
          ? ctx.host.connection.request(method, { sessionId: ctx.nativeSessionId, ...params })
          : ctx.host.connection.command(
              method,
              { sessionId: ctx.nativeSessionId, ...params },
              {
                ...(method === "turn/start" ? {} : { maxAttempts: 1 }),
                ...(options_?.commandId ? { commandId: options_.commandId } : {}),
              },
            ),
      catch: (cause) =>
        requestError(
          method,
          cause instanceof Error && cause.message ? cause.message : `Muse ${method} failed`,
          cause,
        ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: requestTimeoutMs,
        orElse: () => Effect.fail(requestError(method, `Muse ${method} timed out`)),
      }),
    );

  const decode = <A, I>(method: string, schema: Schema.Codec<A, I>, data: unknown) =>
    Schema.decodeUnknownEffect(schema)(data).pipe(
      Effect.mapError((cause) => requestError(method, "Invalid Muse protocol payload", cause)),
    );

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return !ctx || ctx.stopped
      ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
      : Effect.succeed(ctx);
  };

  // "default" is the catalog's default model. Without one, Muse keeps the session's model.
  const resolveModel = Effect.fnUntraced(function* (model: string | undefined) {
    if (model !== MUSE_DEFAULT_MODEL) return model;
    const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
    return catalog.find((entry) => entry.isDefault && !entry.isCustom)?.slug;
  });

  const resolveEffort = Effect.fnUntraced(function* (
    model: string | undefined,
    selection: ModelSelection | undefined,
  ) {
    const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
    const selected = selection
      ? getModelSelectionStringOptionValue(selection, "reasoningEffort")
      : undefined;
    return resolveMuseReasoningEffort(
      catalog.find((entry) => entry.slug === model)?.capabilities ?? museModelCapabilities(),
      selected,
    );
  });

  const setSessionState = (
    ctx: MuseSessionContext,
    status: ProviderSession["status"],
    lastError?: string,
  ) =>
    Effect.gen(function* () {
      ctx.session = {
        ...ctx.session,
        status,
        updatedAt: yield* nowIso,
        ...(lastError ? { lastError } : {}),
      };
    });

  /** Streams the new tail of a message or reasoning item's text. */
  const syncStreamText = (ctx: MuseSessionContext, turn: MuseTurn, item: MuseItem) =>
    Effect.gen(function* () {
      const text = streamText(item);
      const sent = turn.streamed.get(item.itemId) ?? 0;
      if (text.length <= sent) return;
      turn.streamed.set(item.itemId, text.length);
      yield* publish(ctx, {
        type: "content.delta",
        turnId: turn.turnId,
        itemId: RuntimeItemId.make(item.itemId),
        payload: {
          streamKind: item.kind === "reasoning" ? "reasoning_text" : "assistant_text",
          delta: text.slice(sent),
        },
      });
    });

  /** Publishes one Muse item's current state as V1 item lifecycle events. */
  const publishItem = (
    ctx: MuseSessionContext,
    turn: MuseTurn,
    item: MuseItem,
    terminal?: "failed" | "declined",
  ) =>
    Effect.gen(function* () {
      // Muse's skill-reminder child runs on every model step; it is housekeeping, not work.
      if (item.kind === "userMessage" || item.kind === "reminderChild") return;
      if (
        item.kind === "toolCall" &&
        item.tool &&
        TOOLS_WITH_NATIVE_ROWS.has(item.tool) &&
        item.status !== "failed"
      )
        return;
      const status = terminal ?? museItemStatus(item);
      const settled = status !== "inProgress";
      if (item.kind === "subagent" || item.kind === "workflow") {
        if (!settled) ctx.children.set(item.itemId, turn);
        else ctx.children.delete(item.itemId);
      }
      const itemId = RuntimeItemId.make(item.itemId);
      const first = !turn.started.has(item.itemId);
      turn.started.add(item.itemId);

      if (item.kind === "agentMessage" || item.kind === "reasoning") {
        const itemType = item.kind === "agentMessage" ? "assistant_message" : "reasoning";
        if (first)
          yield* publish(ctx, {
            type: "item.started",
            turnId: turn.turnId,
            itemId,
            payload: { itemType, status: "inProgress" },
          });
        yield* syncStreamText(ctx, turn, item);
        if (settled)
          yield* publish(ctx, {
            type: "item.completed",
            turnId: turn.turnId,
            itemId,
            payload: { itemType, status },
          });
        return;
      }

      if (item.kind === "compaction") {
        const summary = museItemText(item).trim() || item.reason?.trim();
        yield* publish(ctx, {
          type: settled ? "item.completed" : first ? "item.started" : "item.updated",
          turnId: turn.turnId,
          itemId,
          payload: {
            itemType: "context_compaction",
            status,
            title: "Compacted context",
            ...(summary ? { detail: summary } : {}),
          },
        });
        return;
      }

      const presentation = museToolPresentation(item, status);
      yield* publish(ctx, {
        type: settled ? "item.completed" : first ? "item.started" : "item.updated",
        turnId: turn.turnId,
        itemId,
        payload: {
          itemType: presentation.itemType,
          status: presentation.status,
          title: presentation.title,
          ...(presentation.detail?.trim() ? { detail: presentation.detail.trim() } : {}),
          data: presentation.data,
        },
      });
    });

  const resolvePending = (
    ctx: MuseSessionContext,
    requestId: ApprovalRequestId,
    entry: PendingRequest,
    resolution: { readonly decision?: ProviderApprovalDecision; readonly answers?: unknown },
  ) =>
    Effect.gen(function* () {
      ctx.pending.delete(requestId);
      if (entry.native.type === "approval")
        yield* publish(ctx, {
          type: "request.resolved",
          turnId: entry.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: entry.requestType,
            ...(resolution.decision ? { decision: resolution.decision } : {}),
          },
        });
      else
        yield* publish(ctx, {
          type: "user-input.resolved",
          turnId: entry.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: (resolution.answers as Record<string, unknown>) ?? {} },
        });
    });

  /** Ends the active turn once, with Muse's terminal state and usage. */
  const finishTurn = (
    ctx: MuseSessionContext,
    turn: MuseTurn,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ) =>
    Effect.gen(function* () {
      if (ctx.active !== turn) return;
      ctx.active = undefined;
      for (const item of turn.items.values()) {
        // Workflows and subagents outlive a completed turn; a stopped or failed one ends them.
        if (
          (item.kind === "subagent" || item.kind === "workflow") &&
          item.status === "inProgress" &&
          state === "completed"
        )
          continue;
        if (item.status === "inProgress")
          yield* publishItem(ctx, turn, item, state === "failed" ? "failed" : "declined");
      }
      for (const [requestId, entry] of ctx.pending)
        if (entry.turnId === turn.turnId) yield* resolvePending(ctx, requestId, entry, {});
      ctx.turns.push({ id: turn.turnId, items: [...turn.items.values()] });
      yield* setSessionState(ctx, state === "failed" ? "error" : "ready", errorMessage);
      ctx.session = { ...ctx.session, activeTurnId: undefined };
      if (ctx.contextUsage)
        yield* publish(ctx, {
          type: "thread.token-usage.updated",
          turnId: turn.turnId,
          payload: { usage: ctx.contextUsage },
        });
      yield* publish(ctx, {
        type: "turn.completed",
        turnId: turn.turnId,
        payload: {
          state,
          ...(errorMessage?.trim() ? { errorMessage: errorMessage.trim() } : {}),
          ...(turn.tokenUsage ? { tokenUsage: turn.tokenUsage } : {}),
        },
      });
    });

  const startTurnRecord = (ctx: MuseSessionContext, nativeId: string, model?: string) =>
    Effect.gen(function* () {
      const turn: MuseTurn = {
        turnId: TurnId.make(nativeId),
        nativeId,
        joined: new Set(),
        items: new Map(),
        streamed: new Map(),
        started: new Set(),
        interruptRequested: false,
      };
      ctx.active = turn;
      ctx.session = { ...ctx.session, activeTurnId: turn.turnId, updatedAt: yield* nowIso };
      yield* setSessionState(ctx, "running");
      yield* publish(ctx, {
        type: "turn.started",
        turnId: turn.turnId,
        payload: model ? { model } : {},
      });
      return turn;
    });

  const owns = (turn: MuseTurn, turnId: string | undefined | null) =>
    turnId === turn.nativeId || (turnId != null && turn.joined.has(turnId));

  const publishRequest = (ctx: MuseSessionContext, native: PendingRequest["native"]) =>
    Effect.gen(function* () {
      const turn = ctx.active;
      const nativeId =
        native.type === "approval" ? native.value.approvalId : native.value.userInputId;
      const requestId = ApprovalRequestId.make(`${native.type}:${nativeId}`);
      if (ctx.pending.has(requestId)) {
        // A revised approval replaces the choices the user sees.
        ctx.pending.set(requestId, { ...ctx.pending.get(requestId)!, native });
        return;
      }
      const entry: PendingRequest =
        native.type === "approval"
          ? { native, turnId: turn?.turnId, requestType: approvalRequestType(native.value) }
          : { native, turnId: turn?.turnId, requestType: "tool_user_input" };
      ctx.pending.set(requestId, entry);
      yield* setSessionState(ctx, "running");
      if (native.type === "approval") {
        // Muse does not give workflow children the session's allowAll mode, so in full
        // access T3 approves for them.
        if (native.value.subagentOrigin !== undefined && ctx.runtimeMode === "full-access") {
          yield* decideApproval(ctx, requestId, entry, "accept").pipe(Effect.ignore);
          return;
        }
        const detail = approvalDetail(native.value);
        yield* publish(ctx, {
          type: "request.opened",
          turnId: entry.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: entry.requestType,
            ...(detail.trim() ? { detail: detail.trim() } : {}),
            options: museApprovalOptions(native.value).filter((option) => option.label.trim()),
            args: native.value,
          },
        });
        return;
      }
      yield* publish(ctx, {
        type: "user-input.requested",
        turnId: entry.turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          questions: native.value.questions.map((question) => ({
            id: question.id,
            header: question.header.trim() || "Question",
            question: question.question.trim() || question.header.trim() || "Question",
            options: question.options
              .filter((option) => option.label.trim())
              .map((option) => ({
                label: option.label,
                description: option.description || option.label,
              })),
            multiSelect: question.selection.mode === "multiple",
            allowCustomAnswer: true,
          })),
        },
      });
    });

  /** Sends T3's decision for a pending approval to Muse. */
  const decideApproval = (
    ctx: MuseSessionContext,
    requestId: ApprovalRequestId,
    entry: PendingRequest,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.gen(function* () {
      if (entry.native.type !== "approval") return;
      const approval = entry.native.value;
      const choice = museApprovalChoices(approval).get(decision);
      if (!choice)
        return yield* requestError("approval/decide", "Muse did not offer this approval decision");
      // Recorded first: Muse can settle the approval before it acknowledges the command.
      entry.decided = decision;
      yield* call(ctx, "approval/decide", {
        approvalId: approval.approvalId,
        requirementId: approval.currentRequirementId,
        choiceId: choice.choiceId,
      }).pipe(Effect.tapError(() => Effect.sync(() => delete entry.decided)));
      void requestId;
    });

  const handleNotification = (ctx: MuseSessionContext, method: string, data: unknown) =>
    Effect.gen(function* () {
      const params = yield* decode(method, recordSchema, data);
      // Subscription quota is connection scoped: it carries no sessionId and
      // folds into the account's published Limits like Claude's sparse updates.
      if (method === "usage/changed") {
        const usage = yield* decode(method, MuseSubscriptionUsage, params);
        yield* publish(ctx, {
          type: "account.rate-limits.updated",
          payload: { limits: museUsageToLimitsUpdate(usage) },
        });
        return;
      }
      if (params.sessionId !== ctx.nativeSessionId) return;
      if (method === "view/gap")
        return yield* requestError(method, "Muse delivery gap requires session recovery");

      switch (method) {
        case "session/contextUsage": {
          const usage = yield* decode(method, MuseContextUsage, params);
          ctx.contextUsage = {
            ...ctx.contextUsage,
            usedTokens: usage.usedTokens,
            ...(usage.windowTokens ? { maxTokens: usage.windowTokens } : {}),
          };
          yield* publish(ctx, {
            type: "thread.token-usage.updated",
            turnId: ctx.active?.turnId,
            payload: { usage: ctx.contextUsage },
          });
          return;
        }
        case "approval/requested":
        case "approval/updated": {
          const approval = yield* decode(method, MuseApproval, params);
          if (
            method === "approval/updated" &&
            !ctx.pending.has(ApprovalRequestId.make(`approval:${approval.approvalId}`))
          )
            return;
          if (approval.subagentOrigin === undefined && approval.turnId && ctx.active) {
            if (!owns(ctx.active, approval.turnId)) return;
          }
          return yield* publishRequest(ctx, { type: "approval", value: approval });
        }
        case "userInput/requested":
          return yield* publishRequest(ctx, {
            type: "question",
            value: yield* decode(method, MuseUserInput, params),
          });
        case "approval/resolved":
        case "userInput/settled": {
          const isApproval = method === "approval/resolved";
          const id = isApproval ? params.approvalId : params.userInputId;
          if (typeof id !== "string") return;
          const requestId = ApprovalRequestId.make(`${isApproval ? "approval" : "question"}:${id}`);
          const entry = ctx.pending.get(requestId);
          if (!entry) return;
          // An approval settled outside T3 still shows Muse's own decision.
          const decision =
            entry.decided ??
            (isApproval && typeof params.decision === "string"
              ? museApprovalDecision({ decision: params.decision, scope: "once" })
              : undefined);
          yield* resolvePending(ctx, requestId, entry, {
            ...(decision ? { decision } : {}),
            ...(params.answers !== undefined ? { answers: params.answers } : {}),
          });
          return;
        }
      }

      const itemEvent = ["item/started", "item/updated", "item/completed"].includes(method)
        ? (yield* decode(method, MuseItemEvent, params)).item
        : undefined;
      // Workflows and subagents report after their turn ended; their rows stay on that turn.
      if (itemEvent) {
        const owner = ctx.children.get(itemEvent.itemId);
        if (owner && owner !== ctx.active && itemEvent.turnId === owner.nativeId) {
          const previous = owner.items.get(itemEvent.itemId);
          if (!previous || itemEvent.revision > previous.revision) {
            owner.items.set(itemEvent.itemId, itemEvent);
            yield* publishItem(ctx, owner, itemEvent);
          }
          return;
        }
      }

      // Muse starts a turn on its own when a workflow finishes, to report its result.
      if (method === "turn/started" && typeof params.turnId === "string") {
        const nativeTurnId = params.turnId;
        if (ctx.active && !owns(ctx.active, nativeTurnId)) ctx.active.joined.add(nativeTurnId);
        else if (!ctx.active) yield* startTurnRecord(ctx, nativeTurnId, ctx.model);
        return;
      }

      const turn = ctx.active;
      if (!turn) return;
      const eventTurnId = typeof params.turnId === "string" ? params.turnId : itemEvent?.turnId;
      if (eventTurnId && !owns(turn, eventTurnId)) return;

      switch (method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = itemEvent!;
          const previous = turn.items.get(item.itemId);
          if (previous && previous.revision >= item.revision) return;
          turn.items.set(item.itemId, item);
          yield* publishItem(ctx, turn, item);
          return;
        }
        case "item/delta": {
          const delta = yield* decode(method, MuseDelta, params);
          const previous = turn.items.get(delta.itemId);
          if (!previous || previous.status !== "inProgress") return;
          const field = delta.field ?? "text";
          let item = previous;
          if (field === "text") item = { ...previous, text: (previous.text ?? "") + delta.delta };
          else if (field === "output" || field === "visibleOutput")
            item = { ...previous, visibleOutput: (previous.visibleOutput ?? "") + delta.delta };
          else if (field.startsWith("summary.")) {
            const index = Number(field.slice(8));
            if (Number.isSafeInteger(index) && index >= 0 && index < 100) {
              const summary = [...(previous.summary ?? [])];
              summary[index] = (summary[index] ?? "") + delta.delta;
              item = { ...previous, summary };
            }
          }
          if (item === previous) return;
          turn.items.set(item.itemId, item);
          if (item.kind === "agentMessage" || item.kind === "reasoning")
            yield* publishItem(ctx, turn, item);
          else if (field === "output" || field === "visibleOutput")
            yield* publish(ctx, {
              type: "content.delta",
              turnId: turn.turnId,
              itemId: RuntimeItemId.make(item.itemId),
              payload: { streamKind: "command_output", delta: delta.delta },
            });
          return;
        }
        case "turn/completed": {
          const result = yield* decode(method, MuseTurnCompleted, params);
          // A joined Muse turn ending does not end this turn; its own turn does.
          if (result.turnId !== turn.nativeId) return;
          if (result.usage) {
            const usage = result.usage;
            turn.tokenUsage = {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: [...turn.items.values()].some((item) => item.kind === "subagent"),
              inputTokens: turn.tokenUsage?.inputTokens ?? usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cacheReadTokens ?? usage.cachedTokens,
              reasoningTokens: usage.reasoningTokens,
              ...(usage.cacheWriteTokens === undefined
                ? {}
                : { cacheCreationTokens: usage.cacheWriteTokens }),
            };
          }
          const state =
            result.terminal === "completed"
              ? "completed"
              : result.terminal === "cancelled"
                ? turn.interruptRequested
                  ? "interrupted"
                  : "cancelled"
                : "failed";
          yield* finishTurn(ctx, turn, state, result.error?.message ?? result.reason);
          return;
        }
        case "session/tokenUsage": {
          const usage = yield* decode(method, MuseTokenUsageEvent, params);
          const previous = turn.tokenUsage;
          turn.tokenUsage = {
            usageScope: "main_agent",
            usageStatus: "partial",
            hasSubagents: [...turn.items.values()].some((item) => item.kind === "subagent"),
            inputTokens: (previous?.inputTokens ?? 0) + usage.promptTokens,
            outputTokens: (previous?.outputTokens ?? 0) + usage.usage.outputTokens,
            cachedInputTokens:
              (previous?.cachedInputTokens ?? 0) +
              (usage.usage.cacheReadTokens ?? usage.usage.cachedTokens),
            reasoningTokens: (previous?.reasoningTokens ?? 0) + usage.usage.reasoningTokens,
          };
          if (ctx.contextUsage) {
            ctx.contextUsage = {
              ...ctx.contextUsage,
              inputTokens: usage.usage.inputTokens,
              outputTokens: usage.usage.outputTokens,
              cachedInputTokens: usage.usage.cacheReadTokens ?? usage.usage.cachedTokens,
              reasoningOutputTokens: usage.usage.reasoningTokens,
            };
          }
          return;
        }
        case "session/todoListChanged": {
          const todo = yield* decode(method, MuseTodoList, params);
          yield* publish(ctx, {
            type: "turn.plan.updated",
            turnId: turn.turnId,
            payload: {
              plan: todo.items
                .filter((item) => item.text.trim() && item.status !== "cancelled")
                .map((item) => ({
                  step: item.text.trim(),
                  status:
                    item.status === "completed"
                      ? "completed"
                      : item.status === "inProgress"
                        ? "inProgress"
                        : "pending",
                })),
            },
          });
          return;
        }
        case "turn/retryScheduled": {
          const retry = yield* decode(method, MuseTurnRetryScheduled, params);
          yield* publish(ctx, {
            type: "runtime.warning",
            turnId: turn.turnId,
            payload: {
              message: `Muse is retrying this turn (attempt ${retry.nextAttempt} of ${retry.maxAttempts}): ${retry.reason}`,
            },
          });
          return;
        }
      }
    });

  /** Ends a session whose host failed or exited, reporting why. */
  const failSession = (ctx: MuseSessionContext, detail: string) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      if (ctx.active) yield* finishTurn(ctx, ctx.active, "failed", detail);
      for (const [requestId, entry] of ctx.pending)
        yield* resolvePending(ctx, requestId, entry, {});
      yield* setSessionState(ctx, "error", detail);
      sessions.delete(ctx.threadId);
      yield* publish(ctx, {
        type: "runtime.error",
        payload: { message: detail, class: "transport_error" },
      });
      yield* publish(ctx, {
        type: "session.exited",
        payload: { reason: detail, exitKind: "error", recoverable: true },
      });
      yield* Effect.forkDetach(Scope.close(ctx.scope, Exit.void));
    });

  const stopSessionInternal = (ctx: MuseSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      if (ctx.active) yield* finishTurn(ctx, ctx.active, "interrupted", "Muse session stopped");
      for (const [requestId, entry] of ctx.pending)
        yield* resolvePending(ctx, requestId, entry, {});
      sessions.delete(ctx.threadId);
      yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      yield* publish(ctx, { type: "session.exited", payload: { exitKind: "graceful" } });
    });

  const startSession: MuseAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      if (!options.settings.enabled)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Muse Code is disabled in Settings.",
        });
      const requestedCwd = input.cwd?.trim() || serverConfig.cwd;
      // Muse rejects non-canonical workspace roots (for example macOS /tmp).
      const cwd = yield* fileSystem
        .realPath(requestedCwd)
        .pipe(Effect.orElseSucceed(() => requestedCwd));
      const existing = sessions.get(input.threadId);
      if (existing) yield* stopSessionInternal(existing);

      const processError = (detail: string, cause?: unknown) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const scope = yield* Scope.make("sequential");
      return yield* Effect.gen(function* () {
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const environment = McpProviderSession.withAgentDeviceEnvironment(
          options.environment,
          mcpSession,
        );
        const host = yield* Effect.acquireRelease(
          createMuseSdkHostEffect(
            {
              binaryPath: options.settings.binaryPath || "muse",
              cwd,
              environment,
              runtimeMode: input.runtimeMode,
            },
            options.createHost,
          ).pipe(
            Effect.mapError((error) =>
              processError(
                error.cause instanceof Error ? error.cause.message : "Muse Code failed to start.",
                error.cause,
              ),
            ),
          ),
          (created) => Effect.promise(() => created.close().catch(() => undefined)),
        ).pipe(Scope.provide(scope));

        const inbox = yield* Queue.unbounded<
          | { readonly type: "notification"; readonly method: string; readonly params: unknown }
          | { readonly type: "failure"; readonly detail: string }
        >();
        host.connection.onNotification((notification) => {
          Queue.offerUnsafe(inbox, {
            type: "notification",
            method: notification.method,
            params: notification.params,
          });
        });
        host.connection.onProtocolError((error) => {
          Queue.offerUnsafe(inbox, {
            type: "failure",
            detail: `Muse protocol error: ${error.message}`,
          });
        });
        // Presentation receipts only; decisions travel as `approval/decide` and
        // `userInput/answer` commands, driven by the matching notifications.
        host.connection.onServerRequest(async (request) => {
          if (request.method === "approval/request" || request.method === "userInput/request")
            return {};
          throw new Error(`Unsupported Muse server request: ${request.method}`);
        });
        void host.exited.then((exit) => {
          const reason = host
            .stderrTail?.()
            .findLast((line) => line.trim())
            ?.trim();
          Queue.offerUnsafe(inbox, {
            type: "failure",
            detail: `Muse exited unexpectedly (${exit.code ?? exit.signal})${reason ? `: ${reason}` : ""}`,
          });
        });

        const resumeSessionId = parseMuseResume(input.resumeCursor);
        const requestedModel =
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection.model
            : undefined;
        const startModel = yield* resolveModel(requestedModel);
        if (mcpSession && !host.initializeResult.grantedCapabilities.includes("sessionMcp"))
          return yield* processError(
            "Update Muse Code to a version that supports session MCP servers.",
          );
        const config = mcpSession
          ? {
              mcpServers: {
                // Muse defaults to "required", which fails the whole run when the
                // Control Plane tools cannot be reached. The agent still works without them.
                [McpProviderSession.MCP_SERVER_NAME]: {
                  transport: "streamableHttp",
                  mode: "optional",
                  url: mcpSession.endpoint,
                  headers: { Authorization: mcpSession.authorizationHeader },
                },
              },
            }
          : undefined;

        const draft = {
          threadId: input.threadId,
          host,
          cwd,
          runtimeMode: input.runtimeMode,
        };
        const open = (sessionId: string, resume: boolean) =>
          Effect.tryPromise({
            try: () =>
              host.connection.command(
                resume ? "session/resume" : "session/start",
                resume
                  ? // Control Plane already has the transcript; skip Muse's history payload.
                    { sessionId, excludeItems: true, ...(config ? { config } : {}) }
                  : {
                      sessionId,
                      workspaceRoot: cwd,
                      ...(config ? { config } : {}),
                      ...(startModel ? { modelId: startModel } : {}),
                      providerId: "meta",
                      approvalMode: museApprovalMode(input.runtimeMode),
                    },
                { maxAttempts: 1 },
              ),
            catch: (cause) =>
              requestError(
                "session/start",
                cause instanceof Error && cause.message
                  ? cause.message
                  : "Muse could not open the session.",
                cause,
              ),
          }).pipe(
            Effect.timeoutOrElse({
              duration: requestTimeoutMs,
              orElse: () =>
                Effect.fail(requestError("session/start", "Muse session start timed out")),
            }),
            Effect.flatMap((value) => decode("session/start", MuseSessionResult, value)),
          );
        let nativeSessionId = resumeSessionId ?? host.connection.mintCommandId();
        let resumed = resumeSessionId !== undefined;
        const opened = yield* open(nativeSessionId, resumed).pipe(
          Effect.catch((cause) => {
            // A session Muse no longer has starts over; the transcript stays in Control Plane.
            if (
              resumed &&
              cause.cause instanceof MspError &&
              (cause.cause.kind === "sessionNotFound" || cause.cause.kind === "notFound")
            ) {
              resumed = false;
              nativeSessionId = host.connection.mintCommandId();
              return open(nativeSessionId, false);
            }
            return Effect.fail(cause);
          }),
          Effect.mapError((cause) => processError(cause.detail, cause)),
        );
        if (opened.session.sessionId !== nativeSessionId)
          return yield* processError("Muse returned a different session identity.");

        const now = yield* nowIso;
        const ctx: MuseSessionContext = {
          ...draft,
          nativeSessionId,
          scope,
          session: {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(requestedModel ? { model: requestedModel } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: MUSE_RESUME_VERSION, sessionId: nativeSessionId },
            createdAt: now,
            updatedAt: now,
          },
          model: opened.session.modelId ?? startModel,
          active: undefined,
          children: new Map(),
          pending: new Map(),
          turns: [],
          commands: yield* Semaphore.make(1),
          projectBlockSent: false,
          contextUsage: undefined,
          stopped: false,
        };
        if (resumed)
          yield* call(ctx, "session/setApprovalMode", {
            mode: museApprovalMode(input.runtimeMode),
          }).pipe(Effect.mapError((cause) => processError(cause.detail, cause)));

        yield* Stream.fromQueue(inbox).pipe(
          Stream.runForEach((entry) =>
            Effect.gen(function* () {
              if (ctx.stopped) return;
              if (entry.type === "failure") return yield* failSession(ctx, entry.detail);
              if (options.nativeEventLogger && entry.method !== "item/delta")
                yield* options.nativeEventLogger.write(
                  {
                    observedAt: yield* nowIso,
                    event: {
                      provider: PROVIDER,
                      method: entry.method,
                      threadId: ctx.threadId,
                      payload: entry.params,
                    },
                  },
                  ctx.threadId,
                );
              yield* handleNotification(ctx, entry.method, entry.params).pipe(
                Effect.catch((cause) =>
                  INFORMATIONAL_NOTIFICATIONS.has(entry.method)
                    ? Effect.logWarning(`Skipped an unreadable Muse ${entry.method}`, cause)
                    : failSession(ctx, cause.detail),
                ),
              );
            }),
          ),
          Effect.forkIn(scope),
        );
        sessions.set(input.threadId, ctx);

        yield* publish(ctx, {
          type: "session.started",
          payload: { resume: ctx.session.resumeCursor },
        });
        yield* publish(ctx, {
          type: "session.state.changed",
          payload: { state: "ready", reason: "Muse Code session ready" },
        });
        yield* publish(ctx, {
          type: "thread.started",
          payload: { providerThreadId: nativeSessionId },
        });
        return { ...ctx.session };
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });

  /** The text and image parts of one user turn. */
  const promptParts = (input: Parameters<MuseAdapterShape["sendTurn"]>[0]) =>
    Effect.gen(function* () {
      const parts: Array<Record<string, unknown>> = [];
      const text = input.input?.trim();
      if (text) parts.push({ type: "text", text });
      for (const attachment of input.attachments ?? []) {
        // Muse ingests images natively; other files reach it through the path line
        // ProviderService puts in the prompt.
        if (attachment.type !== "image") continue;
        const path = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!path)
          return yield* requestError("turn/start", `Invalid attachment id '${attachment.id}'.`);
        const bytes = yield* fileSystem
          .readFile(path)
          .pipe(Effect.mapError((cause) => requestError("turn/start", cause.message, cause)));
        parts.push({
          type: "image",
          base64Data: Buffer.from(bytes).toString("base64"),
          mediaType: attachment.mimeType,
        });
      }
      return parts;
    });

  const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      if (input.interactionMode === "plan")
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Muse Code does not support Plan mode.",
        });
      const parts = yield* promptParts(input);
      if (parts.length === 0)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or an image.",
        });
      return yield* ctx.commands.withPermits(1)(
        Effect.gen(function* () {
          // A message while Muse is working steers the running turn.
          const running = ctx.active;
          if (running) {
            const result = yield* call(ctx, "turn/steer", {
              expectedTurnId: running.nativeId,
              input: parts,
            }).pipe(Effect.flatMap((value) => decode("turn/steer", MuseTurnStartResult, value)));
            if (result.turnId !== running.nativeId)
              return yield* requestError("turn/steer", "Muse steered a different turn.");
            return {
              threadId: input.threadId,
              turnId: running.turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }
          const selection =
            input.modelSelection?.instanceId === options.instanceId
              ? input.modelSelection
              : undefined;
          const targetModel = yield* resolveModel(selection?.model ?? ctx.session.model);
          if (targetModel && ctx.model !== targetModel) {
            yield* call(ctx, "session/setModel", {
              model: { modelId: targetModel, providerId: "meta" },
            });
            ctx.model = targetModel;
          }
          if (selection) ctx.session = { ...ctx.session, model: selection.model };
          const effort = yield* resolveEffort(targetModel ?? ctx.model, selection);
          // Muse takes no system prompt, so the runtime and Project block lead the turn.
          // The full block goes out once per host; later turns repeat the short pointer.
          const instructions = buildRuntimeInstructions({
            harness: HARNESS,
            model: ctx.model,
            reasoningEffort: effort,
            threadId: input.threadId,
            projectForm: ctx.projectBlockSent ? "pointer" : "inline",
          });
          const nativeId = ctx.host.connection.mintCommandId();
          const turn = yield* startTurnRecord(ctx, nativeId, ctx.model);
          const started = yield* call(
            ctx,
            "turn/start",
            {
              // Muse joins input parts with no separator.
              input: [{ type: "text", text: `${instructions}\n\n` }, ...parts],
              displayText: input.input?.trim() || "Image attachment",
              workspaceRoots: [ctx.cwd],
              ifBusy: "queue",
              ...(effort ? { reasoningEffort: effort } : {}),
            },
            { commandId: nativeId },
          ).pipe(
            Effect.flatMap((value) => decode("turn/start", MuseTurnStartResult, value)),
            Effect.tapError((error) => finishTurn(ctx, turn, "failed", error.detail)),
          );
          if (started.turnId !== nativeId) {
            yield* finishTurn(ctx, turn, "failed", "Muse admitted an unexpected turn.");
            return yield* requestError("turn/start", "Muse admitted an unexpected turn.");
          }
          ctx.projectBlockSent = true;
          return {
            threadId: input.threadId,
            turnId: turn.turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );
    });

  const interruptTurn: MuseAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const turn = ctx.active;
      if (!turn) return;
      turn.interruptRequested = true;
      // Muse runs a joined turn first, so Stop must end it too.
      for (const joined of turn.joined)
        yield* call(ctx, "turn/interrupt", { turnId: joined }).pipe(Effect.ignore);
      yield* call(ctx, "turn/interrupt", { turnId: turn.nativeId });
    });

  const respondToRequest: MuseAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const entry = ctx.pending.get(requestId);
      if (!entry || entry.native.type !== "approval")
        return yield* requestError(
          "approval/decide",
          `Unknown pending approval request: ${requestId}`,
        );
      yield* decideApproval(ctx, requestId, entry, decision);
    });

  const respondToUserInput: MuseAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const entry = ctx.pending.get(requestId);
      if (!entry || entry.native.type !== "question")
        return yield* requestError(
          "userInput/answer",
          `Unknown pending user-input request: ${requestId}`,
        );
      const questionRequest = entry.native.value;
      const nativeAnswers = [];
      for (const question of questionRequest.questions) {
        const raw = yield* decode("userInput/answer", responseAnswerSchema, answers[question.id]);
        const values = typeof raw === "string" ? [raw] : [...new Set(raw)];
        const selected = values.filter((value) =>
          question.options.some((option) => option.label === value),
        );
        const freeText = values.filter((value) => !selected.includes(value)).join("\n");
        if (freeText.length > 500 || (!freeText && !selected.length))
          return yield* requestError(
            "userInput/answer",
            "Muse needs a nonempty answer with at most 500 custom characters.",
          );
        nativeAnswers.push({
          questionId: question.id,
          ...(selected.length
            ? question.selection.mode === "single"
              ? { selectedLabel: selected[0]! }
              : { selectedLabels: selected }
            : {}),
          ...(freeText ? (selected.length ? { note: freeText } : { freeText }) : {}),
        });
      }
      yield* call(ctx, "userInput/answer", {
        userInputId: questionRequest.userInputId,
        answers: nativeAnswers,
      });
      // Muse confirms with `userInput/settled`; resolve now so the answers show either way.
      if (ctx.pending.has(requestId)) yield* resolvePending(ctx, requestId, entry, { answers });
    });

  const readThread: MuseAdapterShape["readThread"] = (threadId) =>
    Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: [...ctx.turns] }));

  const rollbackThread: MuseAdapterShape["rollbackThread"] = (threadId) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      // Muse rejects forks at completed-turn boundaries (InvalidCut).
      return yield* requestError(
        "thread/rollback",
        "Muse Code does not support conversation rollback.",
      );
    });

  const stopSession: MuseAdapterShape["stopSession"] = (threadId) =>
    Effect.flatMap(requireSession(threadId), stopSessionInternal);

  const listSessions: MuseAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

  const hasSession: MuseAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      return ctx !== undefined && !ctx.stopped;
    });

  const stopAll: MuseAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], stopSessionInternal, { discard: true }).pipe(
      Effect.ignore,
      Effect.andThen(PubSub.shutdown(runtimeEvents)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies MuseAdapterShape;
});
