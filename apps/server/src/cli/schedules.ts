/**
 * `schedules fire` - what the host's OS scheduler entry runs. Hidden.
 *
 * It signs a two-minute `schedule-fire` token with the home's signing key and
 * POSTs the parameterless fire route of the server in `server-runtime.json`;
 * the server decides what is due. It builds no `ServerConfig` and never opens
 * `state.sqlite`, so a fire can never create, migrate or lock a database.
 *
 * A fire for a state dir that is gone removes its own OS entry (`--label`), so
 * a deleted home stops firing.
 *
 * Exit codes: 0 when the server took the fire or the state dir is gone, 1 when
 * the server refused it, 75 (`EX_TEMPFAIL`) when no server answered in time.
 * Both failures leave a line in `logs/schedules/attempts.jsonl`, which lets
 * the server record `missed: not-running` when it next starts.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { appendScheduleAttempt } from "../schedules/attemptLog.ts";
import {
  ScheduleHostBackend,
  entryRemovalBackendLayer,
  isScheduleEntryLabel,
} from "../schedules/ScheduleHost.ts";
import {
  SCHEDULE_FIRE_ROUTE_PATH,
  SCHEDULE_FIRE_SIGNING_SECRET,
  issueScheduleFireToken,
} from "../schedules/fireToken.ts";

export const SCHEDULE_FIRE_EXIT_OK = 0;
export const SCHEDULE_FIRE_EXIT_REJECTED = 1;
/** sysexits `EX_TEMPFAIL`. */
export const SCHEDULE_FIRE_EXIT_SERVER_DOWN = 75;

const REQUEST_TIMEOUT = Duration.seconds(15);
const RETRY_INTERVAL = Duration.seconds(30);
const DEFAULT_RETRY_SECONDS = 600;

type AttemptResult = "accepted" | "rejected" | "down";

/**
 * Paths inside `--state-dir`, laid out as `deriveServerPaths` in `config.ts`
 * does. Passing the exact state dir, not a base dir, keeps a dev home's entry
 * from firing another install.
 */
const statePaths = (path: Path.Path, stateDir: string) => ({
  signingKey: path.join(stateDir, "secrets", `${SCHEDULE_FIRE_SIGNING_SECRET}.bin`),
  runtime: path.join(stateDir, "server-runtime.json"),
  logsDir: path.join(stateDir, "logs"),
});

export const runScheduleFire = Effect.fn("schedules.fire")(function* (input: {
  readonly stateDir: string;
  /** The entry that ran this fire, removed when the state dir is gone. */
  readonly label?: string | undefined;
  readonly retrySeconds: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  // Checked before anything writes: a removed home stays removed. Only a
  // clear "not found" counts; a state dir this fire may not read (a
  // permission error) is still there, and keeps its entry.
  const stateDirExists = yield* fs.exists(input.stateDir).pipe(Effect.option);
  if (Option.isSome(stateDirExists) && !stateDirExists.value) {
    // Only a schedule label: a hand-typed `--label` must not unload another job.
    if (input.label !== undefined && isScheduleEntryLabel(input.label)) {
      yield* (yield* ScheduleHostBackend).remove(input.label);
    }
    return SCHEDULE_FIRE_EXIT_OK;
  }
  const paths = statePaths(path, input.stateDir);
  const startedAt = yield* DateTime.now;
  const deadline = DateTime.toEpochMillis(startedAt) + input.retrySeconds * 1000;

  const attempt: Effect.Effect<AttemptResult, never, FileSystem.FileSystem> = Effect.gen(
    function* () {
      const secret = yield* fs.readFile(paths.signingKey).pipe(Effect.option);
      const runtime = yield* readPersistedServerRuntimeState(paths.runtime);
      if (Option.isNone(secret) || Option.isNone(runtime) || !isProcessAlive(runtime.value.pid)) {
        return "down";
      }
      const token = issueScheduleFireToken(secret.value, yield* Clock.currentTimeMillis);
      const status = yield* client
        .execute(
          HttpClientRequest.post(new URL(SCHEDULE_FIRE_ROUTE_PATH, runtime.value.origin)).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        )
        .pipe(
          Effect.map((response) => response.status),
          Effect.timeout(REQUEST_TIMEOUT),
          // A refused connection or a timeout: the server is not answering yet.
          Effect.option,
        );
      if (Option.isNone(status) || status.value >= 500) return "down";
      return status.value === 202 ? "accepted" : "rejected";
    },
  );

  const logAttempt = (result: "server-down" | "rejected") =>
    appendScheduleAttempt(paths.logsDir, {
      v: 1,
      startedAt: DateTime.formatIso(startedAt),
      result,
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("schedule fire attempt not logged", { cause })),
    );

  while (true) {
    const result = yield* attempt;
    if (result === "accepted") return SCHEDULE_FIRE_EXIT_OK;
    if (result === "rejected") {
      yield* logAttempt("rejected");
      return SCHEDULE_FIRE_EXIT_REJECTED;
    }
    const nextAttemptAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(RETRY_INTERVAL);
    if (nextAttemptAt > deadline) {
      yield* logAttempt("server-down");
      return SCHEDULE_FIRE_EXIT_SERVER_DOWN;
    }
    yield* Effect.sleep(RETRY_INTERVAL);
  }
});

const fireCommand = Command.make("fire", {
  stateDir: Flag.String("state-dir"),
  label: Flag.String("label").pipe(Flag.optional),
  retrySeconds: Flag.Int("retry-seconds").pipe(
    Flag.withDefault(DEFAULT_RETRY_SECONDS),
    Flag.withHidden,
  ),
}).pipe(
  Command.withDescription("Run the Project schedules that are due. The OS scheduler calls this."),
  Command.withHandler(({ stateDir, label, retrySeconds }) =>
    runScheduleFire({ stateDir, label: Option.getOrUndefined(label), retrySeconds }).pipe(
      Effect.provide(Layer.mergeAll(FetchHttpClient.layer, entryRemovalBackendLayer)),
      Effect.flatMap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = exitCode;
        }),
      ),
    ),
  ),
);

export const schedulesCommand = Command.make("schedules").pipe(
  Command.unlisted,
  Command.withSubcommands([fireCommand]),
);
