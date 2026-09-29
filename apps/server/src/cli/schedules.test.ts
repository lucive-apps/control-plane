import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { verifyScheduleFireToken } from "../schedules/fireToken.ts";
import { ScheduleHostBackend } from "../schedules/ScheduleHost.ts";
import {
  SCHEDULE_FIRE_EXIT_OK,
  SCHEDULE_FIRE_EXIT_REJECTED,
  SCHEDULE_FIRE_EXIT_SERVER_DOWN,
  runScheduleFire,
} from "./schedules.ts";

const NOW = Date.parse("2026-09-28T13:00:02.000Z");
const STATE_DIR = "/homes/personal/userdata";
const KEY_PATH = `${STATE_DIR}/secrets/server-signing-key.bin`;
const RUNTIME_PATH = `${STATE_DIR}/server-runtime.json`;
const ATTEMPTS_PATH = `${STATE_DIR}/logs/schedules/attempts.jsonl`;
const secret = new Uint8Array(32).fill(9);
const RUNTIME_STATE = JSON.stringify({
  version: 1,
  pid: process.pid,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-09-28T12:00:00.000Z",
});

/**
 * The home's files in memory, so every step of a fire is synchronous and the
 * test clock alone decides when retries happen. Records every path written.
 */
const makeHome = (options: {
  readonly serverRunning: boolean;
  /** `exists` fails as it does for a folder the fire has no permission to read. */
  readonly permissionDenied?: boolean;
}) => {
  const files = new Map<string, Uint8Array | string>([[KEY_PATH, secret]]);
  if (options.serverRunning) {
    files.set(RUNTIME_PATH, RUNTIME_STATE);
  }
  const written = new Set<string>();
  const missing = FileSystem.makeNoop({});
  const fileSystem = FileSystem.makeNoop({
    exists: (path) =>
      options.permissionDenied
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "access",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed(
            files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
          ),
    makeDirectory: () => Effect.void,
    readFile: (path) => {
      const contents = files.get(path);
      if (contents === undefined) return missing.readFile(path);
      return Effect.succeed(
        typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
      );
    },
    readFileString: (path) => {
      const contents = files.get(path);
      if (contents === undefined) return missing.readFileString(path);
      return Effect.succeed(
        typeof contents === "string" ? contents : new TextDecoder().decode(contents),
      );
    },
    writeFileString: (path, data, writeOptions) =>
      Effect.sync(() => {
        written.add(path);
        const previous = files.get(path);
        files.set(
          path,
          writeOptions?.flag === "a" && typeof previous === "string" ? previous + data : data,
        );
      }),
  });
  const attempts = () =>
    String(files.get(ATTEMPTS_PATH) ?? "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  return { fileSystem, written, attempts };
};

/** An HTTP client answering each POST with the next of `answers`; `null` never answers. */
const scriptedClient = (answers: ReadonlyArray<number | null>) => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const client = HttpClient.make((request) =>
    Effect.suspend(() => {
      const status = answers[requests.length] ?? null;
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return status === null
        ? Effect.never
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
    }),
  );
  return { client, requests };
};

/** An OS backend that records the labels it is asked to remove, and touches nothing. */
const makeRemovals = () => {
  const removed: Array<string> = [];
  const backend = ScheduleHostBackend.of({
    scheduler: "launchd",
    mode: "os",
    apply: () => Effect.die("a fire never installs"),
    probe: () => Effect.die("a fire never probes"),
    remove: (label) => Effect.sync(() => void removed.push(label)),
  });
  return { removed, backend };
};

const fire = (
  home: ReturnType<typeof makeHome>,
  client: HttpClient.HttpClient,
  options: {
    readonly stateDir?: string;
    readonly label?: string;
    readonly retrySeconds?: number;
    readonly removals?: ReturnType<typeof makeRemovals>;
  } = {},
) =>
  runScheduleFire({
    stateDir: options.stateDir ?? STATE_DIR,
    label: options.label,
    retrySeconds: options.retrySeconds ?? 600,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(FileSystem.FileSystem, home.fileSystem),
    Effect.provideService(ScheduleHostBackend, (options.removals ?? makeRemovals()).backend),
  );

/** Lets the forked fire run up to its next wait on the clock. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, {
  discard: true,
});
const advance = (duration: `${number} seconds`) =>
  settle.pipe(Effect.andThen(TestClock.adjust(duration)), Effect.andThen(settle));

const test = <E>(name: string, body: Effect.Effect<void, E, NodeServices.NodeServices>) =>
  it.effect(name, () => body.pipe(Effect.provide(NodeServices.layer)));

describe("schedules fire", () => {
  test(
    "exits 0 without a request when the state dir is gone",
    Effect.gen(function* () {
      const home = makeHome({ serverRunning: true });
      const { client, requests } = scriptedClient([202]);
      const removals = makeRemovals();

      assert.strictEqual(
        yield* fire(home, client, { stateDir: "/homes/removed/userdata", removals }),
        SCHEDULE_FIRE_EXIT_OK,
      );
      assert.deepStrictEqual(requests, []);
      assert.deepStrictEqual([...home.written], []);
      // Without --label there is no entry to name, so nothing is removed.
      assert.deepStrictEqual(removals.removed, []);
    }),
  );

  test(
    "removes its own entry when the state dir is gone, and only a schedule entry",
    Effect.gen(function* () {
      const home = makeHome({ serverRunning: true });
      const { client, requests } = scriptedClient([202]);
      const removals = makeRemovals();
      const label = "com.lucive.controlplane.schedules.0a1b2c3d";

      yield* fire(home, client, { stateDir: "/homes/removed/userdata", label, removals });
      // A hand-typed label for another job is ignored.
      yield* fire(home, client, {
        stateDir: "/homes/removed/userdata",
        label: "com.t3tools.t3code.service",
        removals,
      });
      // A home that still exists keeps its entry.
      yield* fire(home, client, { label, removals });

      assert.deepStrictEqual(removals.removed, [label]);
      assert.lengthOf(requests, 1);
    }),
  );

  test(
    "keeps its entry when it may not read the state dir, and still fires",
    Effect.gen(function* () {
      const home = makeHome({ serverRunning: true, permissionDenied: true });
      const { client, requests } = scriptedClient([202]);
      const removals = makeRemovals();

      const exitCode = yield* fire(home, client, {
        label: "com.lucive.controlplane.schedules.0a1b2c3d",
        removals,
      });

      // A permission error is not a deleted home.
      assert.deepStrictEqual(removals.removed, []);
      assert.strictEqual(exitCode, SCHEDULE_FIRE_EXIT_OK);
      assert.lengthOf(requests, 1);
    }),
  );

  test(
    "retries a down server every 30 seconds, then logs server-down and exits 75",
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const home = makeHome({ serverRunning: false });
      const { client, requests } = scriptedClient([]);

      const running = yield* fire(home, client, { retrySeconds: 60 }).pipe(Effect.forkChild);
      yield* advance("30 seconds");
      yield* advance("30 seconds");
      assert.strictEqual(yield* Fiber.join(running), SCHEDULE_FIRE_EXIT_SERVER_DOWN);

      assert.deepStrictEqual(requests, []);
      assert.deepStrictEqual(home.attempts(), [
        { v: 1, startedAt: "2026-09-28T13:00:02.000Z", result: "server-down" },
      ]);
      // The fire writes its attempt log and nothing else: no database, no config.
      assert.deepStrictEqual([...home.written], [ATTEMPTS_PATH]);
    }),
  );

  test(
    "retries a request that times out, with a fresh schedule-fire token",
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const home = makeHome({ serverRunning: true });
      const { client, requests } = scriptedClient([null, 202]);

      const running = yield* fire(home, client).pipe(Effect.forkChild);
      yield* advance("15 seconds");
      assert.lengthOf(requests, 1);
      yield* advance("30 seconds");
      assert.strictEqual(yield* Fiber.join(running), SCHEDULE_FIRE_EXIT_OK);

      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [
          "http://127.0.0.1:3773/api/orchestration/schedules/fire",
          "http://127.0.0.1:3773/api/orchestration/schedules/fire",
        ],
      );
      const token = requests[1]!.authorization!.replace(/^Bearer /, "");
      assert.isTrue(verifyScheduleFireToken(token, secret, NOW + 45_000));
      assert.deepStrictEqual(home.attempts(), []);
    }),
  );

  test(
    "exits 1 and logs the attempt when the server refuses the token",
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const home = makeHome({ serverRunning: true });
      const { client, requests } = scriptedClient([401]);

      assert.strictEqual(yield* fire(home, client), SCHEDULE_FIRE_EXIT_REJECTED);
      assert.lengthOf(requests, 1);
      assert.deepStrictEqual(home.attempts(), [
        { v: 1, startedAt: "2026-09-28T13:00:02.000Z", result: "rejected" },
      ]);
    }),
  );

  test(
    "leaves a real state dir with its attempt log added and no database",
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-schedules-fire-" });
      yield* fs.makeDirectory(path.join(stateDir, "secrets"));
      yield* fs.writeFile(path.join(stateDir, "secrets", "server-signing-key.bin"), secret);
      yield* fs.writeFileString(path.join(stateDir, "server-runtime.json"), RUNTIME_STATE);
      const { client } = scriptedClient([401]);

      const exitCode = yield* runScheduleFire({ stateDir, retrySeconds: 600 }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ScheduleHostBackend, makeRemovals().backend),
      );

      assert.strictEqual(exitCode, SCHEDULE_FIRE_EXIT_REJECTED);
      assert.deepStrictEqual((yield* fs.readDirectory(stateDir, { recursive: true })).sort(), [
        "logs",
        path.join("logs", "schedules"),
        path.join("logs", "schedules", "attempts.jsonl"),
        "secrets",
        path.join("secrets", "server-signing-key.bin"),
        "server-runtime.json",
      ]);
    }).pipe(Effect.scoped),
  );
});
