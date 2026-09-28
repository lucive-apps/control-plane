/**
 * Where Control Plane keeps its data (the "home") and its desktop profile.
 *
 * Control Plane and upstream T3 Code both default to `~/.t3`. The R1 release
 * copies a Control Plane home to `~/.cplane` and records the move in
 * `~/.cplane/userdata/home-migration.json`. Every build from M1 on follows that
 * record, so a downgrade from R1 cannot split state across two homes.
 * Resolving never moves data or creates `~/.cplane`; `writeOwnerMarker` is the
 * only write in this module.
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HostProcessHomeDirectory } from "./hostProcess.ts";

const LEGACY_HOME_DIR_NAME = ".t3";
const HOME_DIR_NAME = ".cplane";
const HOME_MIGRATION_FILE = "home-migration.json";
const OWNER_MARKER_FILE = "cplane-owner";

/** Explicit home variables, highest precedence first. Read only: nothing sets `CPLANE_HOME`. */
export const HOME_ENV_NAMES = ["CPLANE_HOME", "T3CODE_HOME"] as const;
type HomeEnv = { readonly [Name in (typeof HOME_ENV_NAMES)[number]]?: string | undefined };

type JoinPath = (first: string, ...segments: string[]) => string;

const MovedHomeRecord = Schema.Struct({
  state: Schema.Literals(["complete", "rolled-back"]),
  /** The home the move copied. */
  from: Schema.NonEmptyString,
  // Only `state` and `from` steer resolution. The rest describes the move and
  // stays optional, so a record from a later build still steers this one.
  environmentId: Schema.optionalKey(Schema.String),
  sourceMaxSequence: Schema.optionalKey(Schema.Finite),
  at: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
// "Start fresh" records only the choice: there is no source to point back to.
const FreshHomeRecord = Schema.Struct({
  state: Schema.Literal("fresh"),
  at: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
/** `~/.cplane/userdata/home-migration.json`, written by the R1 move. */
export const HomeMigrationRecord = Schema.Union([MovedHomeRecord, FreshHomeRecord]);
const decodeHomeMigrationRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(HomeMigrationRecord),
);

/** `cplane-owner`: Control Plane has run on the directory holding it. */
export const CplaneOwnerMarker = Schema.Struct({
  app: Schema.Literal("control-plane"),
  version: Schema.String,
  at: Schema.String,
});
const encodeCplaneOwnerMarker = Schema.encodeSync(Schema.fromJsonString(CplaneOwnerMarker));

/** `dev` for a dev server or dev desktop, whose implicit state lives in `<home>/dev`. */
export type HomeVariant = "userdata" | "dev";

interface HomeInput {
  /** `--home-dir` (the server CLI's `--base-dir`). */
  readonly homeDir?: string | undefined;
  readonly env: HomeEnv;
  readonly variant?: HomeVariant | undefined;
}

export interface HomeResolution {
  readonly baseDir: string;
  /**
   * Chosen by a flag or variable, even when a completed move redirected it.
   * An explicit home keeps its state in `userdata`, never `dev`. A symlinked
   * `~/.t3` is pinned like an explicit home but reports false here, so it keeps
   * today's state directory; the R1 move probes for the symlink itself.
   */
  readonly explicit: boolean;
  /** Also logged, once per process, by `resolveHome`. */
  readonly warnings: ReadonlyArray<string>;
}

const withoutTrailingSeparators = (value: string): string => {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
};

/** Device and inode: two paths with equal ones name the same directory. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** The reads the resolver makes. None of them writes. */
interface HomeReads {
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly isSymbolicLink: (path: string) => Effect.Effect<boolean>;
  /** Undefined when the file is absent; fails with the reason when it cannot be read. */
  readonly readFileString: (path: string) => Effect.Effect<string | undefined, string>;
  /** Undefined when `path` cannot be inspected. */
  readonly fileIdentity: (path: string) => Effect.Effect<FileIdentity | undefined>;
}

const decideHome = Effect.fn(function* (
  input: HomeInput & {
    readonly homeDirectory: string;
    readonly join: JoinPath;
    readonly reads: HomeReads;
  },
) {
  const { join, reads } = input;
  const legacyHome = join(input.homeDirectory, LEGACY_HOME_DIR_NAME);
  const home = join(input.homeDirectory, HOME_DIR_NAME);
  const recordPath = join(home, "userdata", HOME_MIGRATION_FILE);
  const warnings: Array<string> = [];
  const resolved = (baseDir: string, explicit: boolean): HomeResolution => ({
    baseDir,
    explicit,
    warnings,
  });

  // The same directory: equal text, else equal device and inode, so a
  // different letter case or a symlink on either side still matches.
  const sameDirectory = Effect.fn(function* (left: string, right: string) {
    if (withoutTrailingSeparators(join(left)) === withoutTrailingSeparators(join(right))) {
      return true;
    }
    const leftId = yield* reads.fileIdentity(left);
    const rightId = yield* reads.fileIdentity(right);
    return (
      leftId !== undefined &&
      rightId !== undefined &&
      leftId.ino !== 0 &&
      leftId.dev === rightId.dev &&
      leftId.ino === rightId.ino
    );
  });

  // An unreadable or invalid record counts as absent: it cannot be trusted to
  // send this process anywhere but where it would go without one.
  const readRecord = reads.readFileString(recordPath).pipe(
    Effect.map((raw) => {
      if (raw === undefined) return undefined;
      const record = decodeHomeMigrationRecord(raw);
      if (Option.isNone(record)) {
        warnings.push(`Ignoring ${recordPath}: it is not a valid home migration record.`);
      }
      return Option.getOrUndefined(record);
    }),
    Effect.catch((reason) => {
      warnings.push(`Ignoring ${recordPath}: it could not be read (${reason}).`);
      return Effect.undefined;
    }),
  );

  // A pinned home is used as-is, unless a completed move copied it: then the
  // copy is the live one, and an inherited `T3CODE_HOME=~/.t3` must follow it.
  const followMove = Effect.fn(function* (baseDir: string, label: string, explicit: boolean) {
    const record = yield* readRecord;
    if (record?.state === "complete" && (yield* sameDirectory(baseDir, record.from))) {
      warnings.push(
        `${label} points at ${baseDir}, which Control Plane moved to ${home}. Using ${home}.`,
      );
      return resolved(home, explicit);
    }
    return resolved(baseDir, explicit);
  });

  const configured: ReadonlyArray<readonly [label: string, value: string | undefined]> = [
    ["--home-dir", input.homeDir],
    ...HOME_ENV_NAMES.map((name) => [name, input.env[name]] as const),
  ];
  for (const [label, value] of configured) {
    const baseDir = value?.trim();
    if (baseDir) {
      return yield* followMove(baseDir, label, true);
    }
  }

  // Dev state is never moved, so M1 leaves the implicit dev home at `~/.t3/dev`.
  if (input.variant === "dev") {
    return resolved(legacyHome, false);
  }

  // A symlinked home or userdata is the user's own layout: pinned, never moved.
  if (
    (yield* reads.isSymbolicLink(legacyHome)) ||
    (yield* reads.isSymbolicLink(join(legacyHome, "userdata")))
  ) {
    return yield* followMove(legacyHome, `Symlinked ${legacyHome}`, false);
  }

  if (!(yield* reads.exists(join(home, "userdata")))) {
    return resolved(legacyHome, false);
  }
  const record = yield* readRecord;
  return resolved(record?.state === "rolled-back" ? record.from : home, false);
});

const warned = new Set<string>();

/** Logs each warning once per process, to stderr. */
export const logHomeWarnings = (warnings: ReadonlyArray<string>) =>
  Effect.forEach(
    warnings.filter((warning) => !warned.has(warning)),
    (warning) =>
      Effect.sync(() => warned.add(warning)).pipe(Effect.andThen(Effect.logWarning(warning))),
    { discard: true },
  ).pipe(
    // Diagnostics, never program output: a CLI printing JSON keeps a clean stdout.
    Effect.provideService(Logger.LogToStderr, true),
  );

/**
 * The home for this process. Precedence: `--home-dir`, `CPLANE_HOME`,
 * `T3CODE_HOME` (used as given), then a symlinked `~/.t3` or `~/.t3/userdata`,
 * then `~/.cplane` when its `userdata` exists (or the recorded `from` after a
 * rollback), then `~/.t3`. Any of the pinned homes that a completed move copied
 * redirects to `~/.cplane` with a warning. Explicit values come back trimmed
 * but otherwise untouched, so callers keep their own `~` expansion.
 */
export const resolveHome = Effect.fn("resolveHome")(function* (
  input: HomeInput & { readonly homeDirectory?: string | undefined },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = input.homeDirectory ?? (yield* HostProcessHomeDirectory);
  const resolution = yield* decideHome({
    ...input,
    homeDirectory,
    join: path.join,
    reads: {
      exists: (target) => fs.exists(target).pipe(Effect.orElseSucceed(() => false)),
      isSymbolicLink: (target) =>
        fs.readLink(target).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      readFileString: (target) =>
        fs
          .readFileString(target)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(error.message),
            ),
          ),
      fileIdentity: (target) =>
        fs.stat(target).pipe(
          Effect.map((info) =>
            Option.isSome(info.ino) ? { dev: info.dev, ino: info.ino.value } : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        ),
    },
  });
  yield* logHomeWarnings(resolution.warnings);
  return resolution;
});

/** Synchronous reads for `resolveHomeSync`. */
export interface HomeProbe {
  readonly exists: (path: string) => boolean;
  readonly isSymbolicLink: (path: string) => boolean;
  /** Undefined when the file is absent; throws when it cannot be read. */
  readonly readFileString: (path: string) => string | undefined;
  /** Device and inode (`fs.statSync`), or undefined when `path` cannot be inspected. */
  readonly fileIdentity: (path: string) => FileIdentity | undefined;
}

/**
 * `resolveHome` without awaiting, for Electron's main process: everything
 * before `ready` must run synchronously. Returns warnings without logging
 * them; pass them to `logHomeWarnings` once a runtime exists.
 */
export const resolveHomeSync = (
  input: HomeInput & { readonly homeDirectory: string; readonly join: JoinPath },
  probe: HomeProbe,
): HomeResolution =>
  decideHome({
    ...input,
    reads: {
      exists: (path) => Effect.sync(() => probe.exists(path)),
      isSymbolicLink: (path) => Effect.sync(() => probe.isSymbolicLink(path)),
      readFileString: (path) =>
        Effect.try({
          try: () => probe.readFileString(path),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }),
      fileIdentity: (path) => Effect.sync(() => probe.fileIdentity(path)),
    },
  }).pipe(Effect.runSync);

/**
 * A dev home inside `directory` (a git worktree): an existing `.cplane`, else
 * `.t3`. Never created here, and dev state is never copied between them.
 */
export const resolveLocalDevHome = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(directory, HOME_DIR_NAME);
  return (yield* fs.exists(home).pipe(Effect.orElseSucceed(() => false)))
    ? home
    : path.join(directory, LEGACY_HOME_DIR_NAME);
});

/** Whether `baseDir` is `~/.t3`, the default home Control Plane shares with upstream T3 Code. */
export const isLegacyDefaultHome = Effect.fn(function* (baseDir: string, homeDirectory: string) {
  const path = yield* Path.Path;
  return path.resolve(baseDir) === path.resolve(homeDirectory, LEGACY_HOME_DIR_NAME);
});

interface DesktopProfileDirs {
  /** Created only by the R1 move. */
  readonly cplane: string;
  /** Today's profile. */
  readonly current: string;
  /** From before the profile was renamed to `t3code`. */
  readonly legacy: string;
}

export const desktopProfileDirs = (input: {
  readonly appDataDirectory: string;
  readonly isDevelopment: boolean;
  readonly join: JoinPath;
}): DesktopProfileDirs => ({
  cplane: input.join(input.appDataDirectory, input.isDevelopment ? "cplane-dev" : "cplane"),
  current: input.join(input.appDataDirectory, input.isDevelopment ? "t3code-dev" : "t3code"),
  legacy: input.join(
    input.appDataDirectory,
    input.isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
  ),
});

/** The Electron userData dir: an existing `cplane` profile, else legacy, else today's. */
export const selectDesktopProfileDir = (
  dirs: DesktopProfileDirs,
  exists: { readonly cplane: boolean; readonly legacy: boolean },
): string => (exists.cplane ? dirs.cplane : exists.legacy ? dirs.legacy : dirs.current);

/**
 * Marks `directory` (a home's `userdata` or a desktop profile) as used by
 * Control Plane. The R1 move reads it: a `~/.t3` or profile carrying the
 * marker is Control Plane's to copy to `~/.cplane`, while one without it may
 * belong only to upstream T3 Code and is left alone until the user chooses.
 * Written once and never overwritten; a failure is logged and ignored.
 */
export const writeOwnerMarker = Effect.fn("writeOwnerMarker")(function* (
  directory: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(directory, OWNER_MARKER_FILE);
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* fs
    .writeFileString(
      markerPath,
      `${encodeCplaneOwnerMarker({ app: "control-plane", version, at })}\n`,
      // `wx` fails when the file exists, so a marker is never rewritten.
      { flag: "wx" },
    )
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists"
          ? Effect.void
          : Effect.logWarning(`Could not write ${markerPath}: ${error.message}`),
      ),
    );
});
