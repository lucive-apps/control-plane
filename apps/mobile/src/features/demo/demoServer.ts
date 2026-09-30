import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ServerConfig,
  type ServerConfigStreamEvent,
  TurnId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import {
  DEMO_UNAVAILABLE_MESSAGE,
  type DemoData,
  demoThreadShell,
  makeDemoData,
} from "./demoFixtures";

/** What an unsupported demo request fails with. The message is safe to show as-is. */
export class DemoModeUnavailableError extends Schema.TaggedError<DemoModeUnavailableError>()(
  "DemoModeUnavailableError",
  { message: Schema.String },
) {}

export const DEMO_REPLY_TEXT = [
  "This is demo mode, so no agent is running on a real computer.",
  "",
  "To put agents to work on your own code, install Control Plane on your Mac, then pair this phone in **Settings > Connections > Environments**.",
].join("\n");

export const DEMO_APPROVAL_REPLY_TEXT =
  "Approved. In a real session the agent would run the command on your computer and report back here.";
export const DEMO_DECLINE_REPLY_TEXT =
  "Declined. The agent skips the command and asks how you want to continue.";
export const DEMO_ANSWER_REPLY_TEXT =
  "Thanks, I will use that. In demo mode nothing changes on a real computer.";

type Listener<A> = (item: A) => void;

export interface DemoServerOptions {
  readonly now?: () => number;
  /** How long the canned agent reply takes to arrive. */
  readonly replyDelayMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

type DispatchCommand = Parameters<
  WsRpcProtocolClient[typeof ORCHESTRATION_WS_METHODS.dispatchCommand]
>[0];

function isStreamTag(tag: string): boolean {
  const rpc = WsRpcGroup.requests.get(tag);
  return rpc !== undefined && RpcSchema.isStreamSchema(rpc.successSchema);
}

/**
 * An in-memory stand-in for a paired computer. It owns the demo projects and
 * threads, answers the subscriptions the app opens, and applies the commands a
 * reviewer can reasonably try (send, approve, answer, settle, pin, rename).
 * Anything else fails with a friendly `DemoModeUnavailableError` instead of
 * touching the network.
 */
export class DemoServer {
  private readonly now: () => number;
  private readonly replyDelayMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly timers = new Set<unknown>();
  private readonly shellListeners = new Set<Listener<OrchestrationShellStreamItem>>();
  private readonly threadListeners = new Map<
    string,
    Set<Listener<OrchestrationThreadStreamItem>>
  >();
  private readonly data: DemoData;
  private readonly threads = new Map<string, OrchestrationThread>();
  private sequence = 1;
  private idCounter = 0;
  private disposed = false;

  constructor(options: DemoServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.replyDelayMs = options.replyDelayMs ?? 1_200;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.data = makeDemoData(this.now());
    for (const thread of this.data.threads) this.threads.set(thread.id, thread);
  }

  get serverConfig(): ServerConfig {
    return this.data.serverConfig;
  }

  shellSnapshot(): OrchestrationShellSnapshot {
    return {
      snapshotSequence: this.sequence,
      projects: this.data.projects,
      threads: [...this.threads.values()]
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => this.shellFor(thread)),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  threadSnapshot(threadId: string): OrchestrationThreadDetailSnapshot | null {
    const thread = this.threads.get(threadId);
    return thread === undefined ? null : { snapshotSequence: this.sequence, thread };
  }

  thread(threadId: string): OrchestrationThread | null {
    return this.threads.get(threadId) ?? null;
  }

  /** Stops pending replies and drops listeners. The instance is unusable afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers) this.clearTimer(handle);
    this.timers.clear();
    this.shellListeners.clear();
    this.threadListeners.clear();
  }

  subscribeShell(listener: Listener<OrchestrationShellStreamItem>): () => void {
    this.shellListeners.add(listener);
    return () => this.shellListeners.delete(listener);
  }

  subscribeThread(threadId: string, listener: Listener<OrchestrationThreadStreamItem>): () => void {
    const listeners = this.threadListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.threadListeners.set(threadId, listeners);
    return () => listeners.delete(listener);
  }

  dispatch(command: DispatchCommand): { readonly sequence: number } {
    if (this.disposed) return { sequence: this.sequence };
    const at = new Date(this.now()).toISOString();
    switch (command.type) {
      case "thread.create":
        this.createThread(command.threadId, command);
        break;
      case "thread.turn.start": {
        // New tasks create their thread in the same command.
        const created = command.bootstrap?.createThread;
        if (created !== undefined) {
          this.createThread(command.threadId, {
            ...created,
            branch: created.branch ?? command.bootstrap?.prepareWorktree?.branch ?? null,
          });
        }
        const turnId = TurnId.make(this.nextId("demo-turn"));
        const message: OrchestrationMessage = {
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
          turnId,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        };
        this.update(command.threadId, (thread) => ({
          ...thread,
          ...(command.titleSeed !== undefined && thread.messages.length === 0
            ? { title: command.titleSeed }
            : {}),
          messages: [...thread.messages, message],
          latestTurn: {
            turnId,
            state: "running",
            requestedAt: at,
            startedAt: at,
            completedAt: null,
            assistantMessageId: null,
          },
          session: this.sessionFor(thread, "running", turnId, at),
          settledAt: null,
          settledOverride: thread.settledAt === null ? thread.settledOverride : "active",
          updatedAt: at,
        }));
        this.scheduleReply(command.threadId, turnId, DEMO_REPLY_TEXT);
        break;
      }
      case "thread.approval.respond": {
        const accepted = command.decision !== "decline" && command.decision !== "cancel";
        this.resolveRequest(command.threadId, {
          kind: "approval.resolved",
          summary: accepted ? "Approved" : "Declined",
          requestId: command.requestId,
          at,
        });
        this.scheduleReply(
          command.threadId,
          TurnId.make(this.nextId("demo-turn")),
          accepted ? DEMO_APPROVAL_REPLY_TEXT : DEMO_DECLINE_REPLY_TEXT,
        );
        break;
      }
      case "thread.user-input.respond": {
        this.resolveRequest(command.threadId, {
          kind: "user-input.resolved",
          summary: "Answered",
          requestId: command.requestId,
          answers: command.answers,
          at,
        });
        this.scheduleReply(
          command.threadId,
          TurnId.make(this.nextId("demo-turn")),
          DEMO_ANSWER_REPLY_TEXT,
        );
        break;
      }
      case "thread.user-input.dismiss": {
        this.resolveRequest(command.threadId, {
          kind: "user-input.resolved",
          summary: "Dismissed",
          requestId: command.requestId,
          at,
        });
        break;
      }
      case "thread.turn.interrupt":
      case "thread.session.stop": {
        this.update(command.threadId, (thread) => this.completeTurn(thread, at, "interrupted"));
        break;
      }
      case "thread.settle":
        this.update(command.threadId, (thread) => ({
          ...thread,
          settledAt: at,
          settledOverride: "settled",
          pinnedAt: null,
        }));
        break;
      case "thread.unsettle":
        this.update(command.threadId, (thread) => ({
          ...thread,
          settledAt: null,
          settledOverride: "active",
          unsettledAt: at,
        }));
        break;
      case "thread.pin":
        this.update(command.threadId, (thread) => ({ ...thread, pinnedAt: at }));
        break;
      case "thread.unpin":
        this.update(command.threadId, (thread) => ({ ...thread, pinnedAt: null }));
        break;
      case "thread.snooze":
        this.update(command.threadId, (thread) => ({
          ...thread,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: at,
        }));
        break;
      case "thread.unsnooze":
        this.update(command.threadId, (thread) => ({
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
        }));
        break;
      case "thread.archive":
        this.update(command.threadId, (thread) => ({ ...thread, archivedAt: at }));
        break;
      case "thread.unarchive":
        this.update(command.threadId, (thread) => ({ ...thread, archivedAt: null }));
        break;
      case "thread.meta.update":
        this.update(command.threadId, (thread) => ({
          ...thread,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
        }));
        break;
      case "thread.runtime-mode.set":
        this.update(command.threadId, (thread) => ({
          ...thread,
          runtimeMode: command.runtimeMode,
        }));
        break;
      case "thread.interaction-mode.set":
        this.update(command.threadId, (thread) => ({
          ...thread,
          interactionMode: command.interactionMode,
        }));
        break;
      default:
        // Accepted but ignored: the demo has no computer to act on.
        break;
    }
    return { sequence: this.sequence };
  }

  /** The RPC session the connection supervisor sees for the demo environment. */
  makeSession(): RpcSession {
    const handlers: Record<string, (input: never) => unknown> = {
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.concat(
          Stream.succeed<ServerConfigStreamEvent>({
            version: 1,
            type: "snapshot",
            config: this.serverConfig,
          }),
          Stream.never,
        ),
      [WS_METHODS.serverGetConfig]: () => Effect.succeed(this.serverConfig),
      [WS_METHODS.serverProbe]: () => Effect.succeed({}),
      [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: {
        readonly requestCompletionMarker?: boolean;
      }) =>
        Stream.callback<OrchestrationShellStreamItem>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const offer = (item: OrchestrationShellStreamItem) => {
                Queue.offerUnsafe(queue, item);
              };
              offer({ kind: "snapshot", snapshot: this.shellSnapshot() });
              if (input.requestCompletionMarker === true) offer({ kind: "synchronized" });
              return this.subscribeShell(offer);
            }),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: {
        readonly threadId: string;
        readonly requestCompletionMarker?: boolean;
      }) =>
        Stream.callback<OrchestrationThreadStreamItem>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const offer = (item: OrchestrationThreadStreamItem) => {
                Queue.offerUnsafe(queue, item);
              };
              const snapshot = this.threadSnapshot(input.threadId);
              if (snapshot !== null) offer({ kind: "snapshot", snapshot });
              if (input.requestCompletionMarker === true) offer({ kind: "synchronized" });
              return this.subscribeThread(input.threadId, offer);
            }),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: DispatchCommand) =>
        Effect.sync(() => this.dispatch(command)),
      [ORCHESTRATION_WS_METHODS.searchThreads]: () => Effect.succeed({ matches: [] }),
      [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () =>
        Effect.sync(() => {
          const snapshot = this.shellSnapshot();
          return {
            ...snapshot,
            threads: snapshot.threads.filter((thread) => thread.archivedAt !== null),
          };
        }),
    };
    const unavailable = () =>
      Effect.fail(new DemoModeUnavailableError({ message: DEMO_UNAVAILABLE_MESSAGE }));
    const client = new Proxy(
      {},
      {
        get: (_target, tag) => {
          if (typeof tag !== "string") return undefined;
          const handler = handlers[tag];
          if (handler !== undefined) return handler;
          // Streams the demo cannot feed stay quiet rather than erroring.
          return isStreamTag(tag) ? () => Stream.never : unavailable;
        },
      },
    ) as WsRpcProtocolClient;
    const initialConfig = Effect.succeed(this.serverConfig);
    return {
      client,
      initialConfig,
      subscribeServerConfig: (input) =>
        (
          handlers[WS_METHODS.subscribeServerConfig] as (
            value: typeof input,
          ) => ReturnType<RpcSession["subscribeServerConfig"]>
        )(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
  }

  private createThread(
    threadId: OrchestrationThread["id"],
    input: Pick<
      OrchestrationThread,
      | "projectId"
      | "title"
      | "modelSelection"
      | "runtimeMode"
      | "interactionMode"
      | "branch"
      | "worktreePath"
      | "createdAt"
    >,
  ): void {
    if (this.threads.has(threadId)) return;
    this.threads.set(threadId, {
      ...input,
      id: threadId,
      pullRequests: [],
      latestTurn: null,
      updatedAt: input.createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    });
    this.publish(threadId);
  }

  private shellFor(thread: OrchestrationThread) {
    return demoThreadShell(thread, this.data.planProgressByThreadId.get(thread.id) ?? null);
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.now()}-${this.idCounter}`;
  }

  private sessionFor(
    thread: OrchestrationThread,
    status: "running" | "ready" | "interrupted",
    activeTurnId: TurnId | null,
    at: string,
  ): OrchestrationThread["session"] {
    return {
      threadId: thread.id,
      status,
      providerName: thread.session?.providerName ?? null,
      ...(thread.session?.providerInstanceId !== undefined
        ? { providerInstanceId: thread.session.providerInstanceId }
        : {}),
      runtimeMode: thread.runtimeMode,
      activeTurnId,
      lastError: null,
      updatedAt: at,
    };
  }

  private completeTurn(
    thread: OrchestrationThread,
    at: string,
    state: "completed" | "interrupted",
    assistantMessageId: MessageId | null = null,
  ): OrchestrationThread {
    return {
      ...thread,
      latestTurn:
        thread.latestTurn === null
          ? null
          : {
              ...thread.latestTurn,
              state,
              completedAt: at,
              ...(assistantMessageId !== null ? { assistantMessageId } : {}),
            },
      session: this.sessionFor(thread, state === "completed" ? "ready" : "interrupted", null, at),
      updatedAt: at,
    };
  }

  private resolveRequest(
    threadId: string,
    input: {
      readonly kind: "approval.resolved" | "user-input.resolved";
      readonly summary: string;
      readonly requestId: string;
      readonly answers?: Readonly<Record<string, unknown>>;
      readonly at: string;
    },
  ): void {
    this.update(threadId, (thread) => {
      const activity: OrchestrationThreadActivity = {
        id: EventId.make(this.nextId("demo-activity")),
        tone: input.kind === "approval.resolved" ? "approval" : "info",
        kind: input.kind,
        summary: input.summary,
        payload: {
          requestId: input.requestId,
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        },
        turnId: thread.latestTurn?.turnId ?? null,
        createdAt: input.at,
      };
      return { ...thread, activities: [...thread.activities, activity], updatedAt: input.at };
    });
  }

  private scheduleReply(threadId: string, turnId: TurnId, text: string): void {
    const handle = this.setTimer(() => {
      this.timers.delete(handle);
      if (this.disposed) return;
      const at = new Date(this.now()).toISOString();
      const messageId = MessageId.make(this.nextId("demo-message"));
      this.update(threadId, (thread) => {
        const withTurn: OrchestrationThread =
          thread.latestTurn?.state === "running"
            ? thread
            : {
                ...thread,
                latestTurn: {
                  turnId,
                  state: "running",
                  requestedAt: at,
                  startedAt: at,
                  completedAt: null,
                  assistantMessageId: null,
                },
              };
        const activeTurnId = withTurn.latestTurn?.turnId ?? turnId;
        const reply: OrchestrationMessage = {
          id: messageId,
          role: "assistant",
          text,
          turnId: activeTurnId,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        };
        return this.completeTurn(
          { ...withTurn, messages: [...withTurn.messages, reply] },
          at,
          "completed",
          messageId,
        );
      });
    }, this.replyDelayMs);
    this.timers.add(handle);
  }

  private update(
    threadId: string,
    transform: (thread: OrchestrationThread) => OrchestrationThread,
  ): void {
    const current = this.threads.get(threadId);
    if (current === undefined) return;
    this.threads.set(threadId, transform(current));
    this.publish(threadId);
  }

  private publish(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return;
    this.sequence += 1;
    const sequence = this.sequence;
    const snapshot: OrchestrationThreadDetailSnapshot = { snapshotSequence: sequence, thread };
    for (const listener of this.threadListeners.get(threadId) ?? []) {
      listener({ kind: "snapshot", snapshot });
    }
    const item: OrchestrationShellStreamItem = {
      kind: "thread-upserted",
      sequence,
      thread: this.shellFor(thread),
    };
    for (const listener of this.shellListeners) listener(item);
  }
}
