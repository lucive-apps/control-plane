/**
 * The home's record of agents it started on linked machines. One JSON file in
 * the state dir, written atomically: a fork migration would renumber on every
 * upstream sync, and the file holds a few dozen small records at most.
 * Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module RemoteAgentStore
 */
import { RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { AgentPhase } from "./agentPhase.ts";

/** Settled and lost records are kept this long, then pruned. */
export const REMOTE_AGENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const RemoteAgentRequest = Schema.Struct({
  /** `cp-remote:*`, the message id the peer stores. */
  messageId: Schema.String,
  /** The home thread the result goes to (the manager that asked). */
  replyTo: Schema.String,
  sentAt: Schema.String,
  /** The peer thread's latest turn before the send, so its own turn can be told apart. */
  baselineTurnId: Schema.NullOr(Schema.String),
  /** A stop cut the request off: its result is not pushed. */
  suppressed: Schema.Boolean,
});
export type RemoteAgentRequest = typeof RemoteAgentRequest.Type;

export const RemoteAgentQueuedSend = Schema.Struct({
  messageId: Schema.String,
  text: Schema.String,
  replyTo: Schema.String,
  queuedAt: Schema.String,
});
export type RemoteAgentQueuedSend = typeof RemoteAgentQueuedSend.Type;

export const RemoteAgentRecord = Schema.Struct({
  /** The peer thread's id, derived from the create like a local agent's. */
  threadId: Schema.String,
  machineId: Schema.String,
  machineLabel: Schema.String,
  peerProjectId: Schema.String,
  homeProjectId: Schema.String,
  title: Schema.String,
  /** The home thread that started it; ownership follows this. */
  creatorThreadId: Schema.String,
  runtimeMode: RuntimeMode,
  createdAt: Schema.String,
  /** `pending` until the peer accepted the create; `lost` when the peer thread is gone. */
  state: Schema.Literals(["pending", "open", "settled", "lost"]),
  /** When it reached `settled` or `lost`, for pruning. */
  endedAt: Schema.NullOr(Schema.String),
  inFlight: Schema.NullOr(RemoteAgentRequest),
  queuedSends: Schema.Array(RemoteAgentQueuedSend),
  lastPhase: AgentPhase,
  lastActivityAt: Schema.NullOr(Schema.String),
});
export type RemoteAgentRecord = typeof RemoteAgentRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  agents: Schema.Array(RemoteAgentRecord),
});

const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownOption(StoreFileJson);
const encodeStoreFile = Schema.encodeSync(StoreFileJson);

export class RemoteAgentStoreError extends Schema.TaggedError<RemoteAgentStoreError>()(
  "RemoteAgentStoreError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface RemoteAgentStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<RemoteAgentRecord>, RemoteAgentStoreError>;
  readonly get: (
    threadId: string,
  ) => Effect.Effect<Option.Option<RemoteAgentRecord>, RemoteAgentStoreError>;
  readonly put: (record: RemoteAgentRecord) => Effect.Effect<void, RemoteAgentStoreError>;
  /** Applies `change` to one record under the write lock; none when it is missing. */
  readonly update: (
    threadId: string,
    change: (record: RemoteAgentRecord) => RemoteAgentRecord,
  ) => Effect.Effect<Option.Option<RemoteAgentRecord>, RemoteAgentStoreError>;
  readonly remove: (threadId: string) => Effect.Effect<void, RemoteAgentStoreError>;
}

export class RemoteAgentStore extends Context.Service<RemoteAgentStore, RemoteAgentStoreShape>()(
  "t3/agentMachines/RemoteAgentStore",
) {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = `${config.stateDir}/remote-agents.json`;
  const lock = yield* Semaphore.make(1);
  let cache: Array<RemoteAgentRecord> | null = null;

  const fail = (detail: string) => (cause: unknown) => new RemoteAgentStoreError({ detail, cause });

  const load = Effect.gen(function* () {
    if (cache !== null) return cache;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.mapError(fail("read")));
    if (!exists) {
      cache = [];
      return cache;
    }
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.mapError(fail("read")));
    const decoded = decodeStoreFile(raw);
    if (Option.isNone(decoded)) {
      // A file this build cannot read is set aside, not overwritten silently.
      yield* Effect.logWarning("remote-agents.json could not be read; starting empty", {
        filePath,
      });
      yield* fileSystem
        .rename(filePath, `${filePath}.unreadable`)
        .pipe(Effect.catch(() => Effect.void));
      cache = [];
      return cache;
    }
    cache = [...decoded.value.agents];
    return cache;
  });

  const prune = (records: ReadonlyArray<RemoteAgentRecord>, nowMs: number) =>
    records.filter(
      (record) =>
        record.endedAt === null ||
        nowMs - DateTime.toEpochMillis(DateTime.makeUnsafe(record.endedAt)) <
          REMOTE_AGENT_RETENTION_MS,
    );

  const persist = (next: ReadonlyArray<RemoteAgentRecord>) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const kept = prune(next, DateTime.toEpochMillis(now));
      yield* writeFileStringAtomically({
        filePath,
        contents: encodeStoreFile({ version: 1, agents: kept }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(fail("write")),
      );
      cache = [...kept];
    });

  const list = lock.withPermits(1)(load.pipe(Effect.map((records) => [...records])));

  const get = (threadId: string) =>
    list.pipe(
      Effect.map((records) => Option.fromNullishOr(records.find((r) => r.threadId === threadId))),
    );

  const put = (record: RemoteAgentRecord) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* load;
        yield* persist([...records.filter((r) => r.threadId !== record.threadId), record]);
      }),
    );

  const update = (threadId: string, change: (record: RemoteAgentRecord) => RemoteAgentRecord) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* load;
        const current = records.find((r) => r.threadId === threadId);
        if (current === undefined) return Option.none<RemoteAgentRecord>();
        const next = change(current);
        yield* persist(records.map((r) => (r.threadId === threadId ? next : r)));
        return Option.some(next);
      }),
    );

  const remove = (threadId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* load;
        if (!records.some((r) => r.threadId === threadId)) return;
        yield* persist(records.filter((r) => r.threadId !== threadId));
      }),
    );

  return { list, get, put, update, remove } satisfies RemoteAgentStoreShape;
});

export const RemoteAgentStoreLive = Layer.effect(RemoteAgentStore, make);
