/**
 * The schedule attempt log, `<logsDir>/schedules/attempts.jsonl`. Fork-owned.
 *
 * It holds one JSON line per fire the CLI could not deliver, so the server
 * can record `missed: not-running` when it next starts. The OS entry's own
 * output never shares it (launchd writes `~/Library/Logs/<label>.log`, systemd
 * the journal), so trimming one to its last 256 KB never cuts the other's
 * lines.
 *
 * @module attemptLog
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export const SCHEDULE_LOG_MAX_BYTES = 256 * 1024;

export const ScheduleAttempt = Schema.Struct({
  v: Schema.Literal(1),
  startedAt: Schema.String,
  result: Schema.Literals(["server-down", "rejected"]),
});
export type ScheduleAttempt = typeof ScheduleAttempt.Type;

const attemptJson = Schema.fromJsonString(ScheduleAttempt);
const encodeAttempt = Schema.encodeSync(attemptJson);
const decodeAttempt = Schema.decodeUnknownOption(attemptJson);

export const scheduleLogPaths = (path: Path.Path, logsDir: string) => {
  const dir = path.join(logsDir, "schedules");
  return {
    dir,
    attempts: path.join(dir, "attempts.jsonl"),
  };
};

/** Keeps the last `maxBytes` of a log, cut at a line start. A missing file is left alone. */
export const trimScheduleLog = Effect.fn("trimScheduleLog")(function* (
  filePath: string,
  maxBytes: number = SCHEDULE_LOG_MAX_BYTES,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(filePath).pipe(Effect.option);
  if (Option.isNone(info) || Number(info.value.size) <= maxBytes) return;
  const bytes = yield* fs.readFile(filePath);
  const tail = bytes.subarray(bytes.length - maxBytes);
  const firstLineEnd = tail.indexOf(0x0a);
  const kept = firstLineEnd < 0 ? new Uint8Array() : tail.subarray(firstLineEnd + 1);
  yield* writeFileStringAtomically({
    filePath,
    contents: new TextDecoder().decode(kept),
  });
});

export const appendScheduleAttempt = Effect.fn("appendScheduleAttempt")(function* (
  logsDir: string,
  attempt: ScheduleAttempt,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = scheduleLogPaths(yield* Path.Path, logsDir);
  yield* fs.makeDirectory(paths.dir, { recursive: true });
  yield* fs.writeFileString(paths.attempts, `${encodeAttempt(attempt)}\n`, { flag: "a" });
  yield* trimScheduleLog(paths.attempts);
});

/** Every readable attempt, oldest first. A missing log reads as none. */
export const readScheduleAttempts = Effect.fn("readScheduleAttempts")(function* (logsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = scheduleLogPaths(yield* Path.Path, logsDir);
  const contents = yield* fs
    .readFileString(paths.attempts)
    .pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(cause),
      ),
    );
  return contents
    .split("\n")
    .flatMap((line) => (line.trim().length === 0 ? [] : Option.toArray(decodeAttempt(line))));
});
