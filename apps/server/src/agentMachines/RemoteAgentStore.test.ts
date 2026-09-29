import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  REMOTE_AGENT_RETENTION_MS,
  RemoteAgentRecord,
  RemoteAgentStore,
  RemoteAgentStoreLive,
  type RemoteAgentStoreShape,
} from "./RemoteAgentStore.ts";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const DAY_MS = 24 * 60 * 60 * 1000;

const record = (
  threadId: string,
  overrides: Partial<RemoteAgentRecord> = {},
): RemoteAgentRecord => ({
  threadId,
  machineId: "env-mini",
  machineLabel: "Mac Mini",
  peerProjectId: "peer-project",
  homeProjectId: "home-project",
  title: `Agent ${threadId}`,
  creatorThreadId: "coordinator",
  runtimeMode: "approval-required",
  createdAt: iso(NOW - DAY_MS),
  state: "open",
  endedAt: null,
  inFlight: null,
  queuedSends: [],
  lastPhase: "idle",
  lastActivityAt: null,
  ...overrides,
});

/** A store over a fixed base dir, so a second instance re-reads the same file. */
const withStore = <A, E>(
  baseDir: string,
  body: (store: RemoteAgentStoreShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const store = yield* RemoteAgentStore;
    return yield* body(store);
  }).pipe(
    Effect.provide(
      RemoteAgentStoreLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir))),
    ),
  );

/** A temp base dir, its state dir and the store file path. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-agent-store-test-" });
  const stateDir = yield* ServerConfig.ServerConfig.pipe(
    Effect.map((config) => config.stateDir),
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  yield* TestClock.setTime(NOW);
  return { fs, baseDir, stateDir, filePath: path.join(stateDir, "remote-agents.json") };
});

const decodeFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), agents: Schema.Array(RemoteAgentRecord) }),
  ),
);

it.layer(NodeServices.layer)("RemoteAgentStore", (it) => {
  it.effect("starts empty without a file", () =>
    Effect.gen(function* () {
      const { fs, baseDir, filePath } = yield* setup;
      const listed = yield* withStore(baseDir, (store) => store.list);
      assert.deepEqual(listed, []);
      assert.isFalse(yield* fs.exists(filePath));
    }),
  );

  it.effect("puts, gets, lists, updates and removes records", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* setup;
      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          yield* store.put(record("a"));
          yield* store.put(record("b", { state: "pending" }));
          assert.deepEqual(
            (yield* store.list).map((r) => r.threadId),
            ["a", "b"],
          );
          assert.deepEqual(yield* store.get("a"), Option.some(record("a")));
          assert.isTrue(Option.isNone(yield* store.get("missing")));

          // put replaces a record with the same thread id instead of adding one.
          yield* store.put(record("a", { title: "Renamed" }));
          assert.strictEqual((yield* store.list).length, 2);
          assert.strictEqual(Option.getOrThrow(yield* store.get("a")).title, "Renamed");

          const updated = yield* store.update("b", (r) => ({
            ...r,
            state: "open",
            lastPhase: "running",
          }));
          assert.deepEqual(
            updated,
            Option.some(record("b", { state: "open", lastPhase: "running" })),
          );
          assert.strictEqual(Option.getOrThrow(yield* store.get("b")).lastPhase, "running");

          yield* store.remove("a");
          yield* store.remove("never-there");
          assert.deepEqual(
            (yield* store.list).map((r) => r.threadId),
            ["b"],
          );
        }),
      );
    }),
  );

  it.effect("update on a missing record returns none and writes nothing", () =>
    Effect.gen(function* () {
      const { fs, baseDir, filePath } = yield* setup;
      let called = false;
      const result = yield* withStore(baseDir, (store) =>
        store.update("missing", (r) => {
          called = true;
          return r;
        }),
      );
      assert.isTrue(Option.isNone(result));
      assert.isFalse(called);
      assert.isFalse(yield* fs.exists(filePath));
    }),
  );

  it.effect("writes a decodable file that a fresh store instance reads back", () =>
    Effect.gen(function* () {
      const { fs, baseDir, stateDir, filePath } = yield* setup;
      const inFlight = {
        messageId: "cp-remote:req-1",
        replyTo: "coordinator",
        sentAt: iso(NOW - 1_000),
        baselineTurnId: null,
        suppressed: false,
      };
      const queued = {
        messageId: "cp-remote:req-2",
        text: "Then run the tests",
        replyTo: "coordinator",
        queuedAt: iso(NOW),
      };
      const full = record("a", { inFlight, queuedSends: [queued], lastPhase: "running" });
      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          yield* store.put(full);
          yield* store.put(record("b"));
          yield* store.remove("b");
        }),
      );

      const onDisk = decodeFile(yield* fs.readFileString(filePath));
      assert.deepEqual(onDisk, { version: 1, agents: [full] });
      // Atomic writes leave no temp files next to the store.
      assert.deepEqual(
        (yield* fs.readDirectory(stateDir)).filter((name) => name.startsWith("remote-agents.json")),
        ["remote-agents.json"],
      );

      const reread = yield* withStore(baseDir, (store) => store.list);
      assert.deepEqual(reread, [full]);
    }),
  );

  it.effect("prunes settled and lost records older than the retention on the next write", () =>
    Effect.gen(function* () {
      const { fs, baseDir, filePath } = yield* setup;
      const expired = iso(NOW - REMOTE_AGENT_RETENTION_MS - 1);
      const recent = iso(NOW - REMOTE_AGENT_RETENTION_MS + 60_000);
      const seeded = [
        record("old-settled", { state: "settled", endedAt: expired }),
        record("old-lost", { state: "lost", endedAt: iso(NOW - 30 * DAY_MS) }),
        record("new-settled", { state: "settled", endedAt: recent }),
        record("open", { createdAt: iso(NOW - 60 * DAY_MS) }),
      ];
      yield* fs.writeFileString(filePath, encodeJson({ version: 1, agents: seeded }));

      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          // Reading does not prune; the next write does.
          assert.strictEqual((yield* store.list).length, 4);
          yield* store.put(record("fresh"));
          assert.deepEqual(
            (yield* store.list).map((r) => r.threadId),
            ["new-settled", "open", "fresh"],
          );
        }),
      );
      assert.deepEqual(
        decodeFile(yield* fs.readFileString(filePath)).agents.map((r) => r.threadId),
        ["new-settled", "open", "fresh"],
      );
    }),
  );

  it.effect("sets an unreadable file aside and starts empty", () =>
    Effect.gen(function* () {
      const { fs, baseDir, filePath } = yield* setup;
      yield* fs.writeFileString(filePath, "{ not json");

      const listed = yield* withStore(baseDir, (store) => store.list);
      assert.deepEqual(listed, []);
      assert.isFalse(yield* fs.exists(filePath));
      assert.strictEqual(yield* fs.readFileString(`${filePath}.unreadable`), "{ not json");

      // A file from a newer build with an unknown version is set aside too.
      yield* fs.writeFileString(filePath, encodeJson({ version: 2, agents: [] }));
      yield* withStore(baseDir, (store) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* store.list, []);
          yield* store.put(record("a"));
        }),
      );
      assert.deepEqual(
        decodeFile(yield* fs.readFileString(filePath)).agents.map((r) => r.threadId),
        ["a"],
      );
      assert.strictEqual(
        yield* fs.readFileString(`${filePath}.unreadable`),
        encodeJson({ version: 2, agents: [] }),
      );
    }),
  );
});
