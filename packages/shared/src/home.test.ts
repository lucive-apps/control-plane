// @effect-diagnostics nodeBuiltinImport:off - builds real home layouts on disk and probes them synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";

import {
  CplaneOwnerMarker,
  desktopProfileDirs,
  HomeMigrationRecord,
  isLegacyDefaultHome,
  resolveHome,
  resolveHomeSync,
  resolveLocalDevHome,
  selectDesktopProfileDir,
  writeOwnerMarker,
} from "./home.ts";
import { symlinksSupported } from "./testing/symlinks.ts";

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(HomeMigrationRecord));
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(CplaneOwnerMarker));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const movedRecord = (state: "complete" | "rolled-back", from: string) =>
  encodeRecord({
    state,
    from,
    environmentId: "environment-1",
    sourceMaxSequence: 42,
    at: "2026-01-01T00:00:00.000Z",
    version: "0.0.60",
  });

/** A throwaway user home directory. Nothing here ever looks at the real one. */
const makeUserHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-home-test-" });
  const at = (...segments: ReadonlyArray<string>) => NodePath.join(home, ...segments);
  const mkdir = (...segments: ReadonlyArray<string>) =>
    fs.makeDirectory(at(...segments), { recursive: true });
  const writeRecord = (contents: string) =>
    Effect.gen(function* () {
      yield* mkdir(".cplane", "userdata");
      yield* fs.writeFileString(at(".cplane", "userdata", "home-migration.json"), contents);
    });
  return { home, at, mkdir, writeRecord };
});

const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const logs: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    logs.push([message].flat().map(String).join(" "));
  });
  return effect.pipe(
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.map((value) => ({ value, logs })),
  );
};

const diskProbe = {
  exists: (path: string) => NodeFS.existsSync(path),
  isSymbolicLink: (path: string) => {
    try {
      return NodeFS.lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  readFileString: (path: string) => {
    try {
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  fileIdentity: (path: string) => {
    try {
      const stats = NodeFS.statSync(path);
      return { dev: stats.dev, ino: stats.ino };
    } catch {
      return undefined;
    }
  },
};

it.layer(NodeServices.layer)("resolveHome", (it) => {
  it.effect("uses ~/.t3 and creates nothing when there is no Control Plane home", () =>
    Effect.gen(function* () {
      const { home, at } = yield* makeUserHome;

      const resolution = yield* resolveHome({ homeDirectory: home, env: {} });

      assert.deepEqual(resolution, { baseDir: at(".t3"), explicit: false, warnings: [] });
      assert.isFalse(NodeFS.existsSync(at(".cplane")));
      assert.isFalse(NodeFS.existsSync(at(".t3")));
    }).pipe(Effect.scoped),
  );

  it.effect("ranks --home-dir over CPLANE_HOME over T3CODE_HOME and ignores blank values", () =>
    Effect.gen(function* () {
      const { home } = yield* makeUserHome;
      const resolve = (input: {
        readonly homeDir?: string;
        readonly CPLANE_HOME?: string;
        readonly T3CODE_HOME?: string;
      }) =>
        resolveHome({
          homeDirectory: home,
          homeDir: input.homeDir,
          env: { CPLANE_HOME: input.CPLANE_HOME, T3CODE_HOME: input.T3CODE_HOME },
        }).pipe(Effect.map(({ baseDir, explicit }) => ({ baseDir, explicit })));
      const all = { homeDir: "/flag", CPLANE_HOME: "/cplane", T3CODE_HOME: "/t3" };

      assert.deepEqual(yield* resolve(all), { baseDir: "/flag", explicit: true });
      assert.deepEqual(yield* resolve({ ...all, homeDir: "  " }), {
        baseDir: "/cplane",
        explicit: true,
      });
      assert.deepEqual(yield* resolve({ ...all, homeDir: "", CPLANE_HOME: " " }), {
        baseDir: "/t3",
        explicit: true,
      });
      assert.deepEqual(yield* resolve({ T3CODE_HOME: " /t3 " }), {
        baseDir: "/t3",
        explicit: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("uses an explicit home as given even when ~/.cplane exists", () =>
    Effect.gen(function* () {
      const { home, mkdir } = yield* makeUserHome;
      yield* mkdir(".cplane", "userdata");

      const resolution = yield* resolveHome({ homeDirectory: home, env: { T3CODE_HOME: "/t3" } });

      assert.deepEqual(resolution, { baseDir: "/t3", explicit: true, warnings: [] });
    }).pipe(Effect.scoped),
  );

  it.effect("redirects an explicit home that a completed move copied, warning once", () =>
    Effect.gen(function* () {
      const { home, at, writeRecord } = yield* makeUserHome;
      yield* writeRecord(movedRecord("complete", at(".t3")));

      const inherited = resolveHome({ homeDirectory: home, env: { T3CODE_HOME: at(".t3") } });
      const { value, logs } = yield* withLogs(
        Effect.gen(function* () {
          const first = yield* inherited;
          const second = yield* inherited;
          const trailingSeparator = yield* resolveHome({
            homeDirectory: home,
            env: { T3CODE_HOME: `${at(".t3")}${NodePath.sep}` },
          });
          const flag = yield* resolveHome({ homeDirectory: home, homeDir: at(".t3"), env: {} });
          return { first, second, trailingSeparator, flag };
        }),
      );

      assert.equal(value.first.baseDir, at(".cplane"));
      assert.isTrue(value.first.explicit);
      assert.lengthOf(value.first.warnings, 1);
      assert.include(value.first.warnings[0], "T3CODE_HOME");
      assert.equal(value.second.baseDir, at(".cplane"));
      assert.equal(value.trailingSeparator.baseDir, at(".cplane"));
      assert.equal(value.flag.baseDir, at(".cplane"));
      // The same warning is logged once per process however often it recurs.
      assert.lengthOf(
        logs.filter((log) => log === value.first.warnings[0]),
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an explicit home that no completed move copied", () =>
    Effect.gen(function* () {
      const { home, at, writeRecord } = yield* makeUserHome;
      const resolveLegacy = resolveHome({ homeDirectory: home, env: { T3CODE_HOME: at(".t3") } });

      yield* writeRecord(movedRecord("rolled-back", at(".t3")));
      assert.equal((yield* resolveLegacy).baseDir, at(".t3"));

      yield* writeRecord(movedRecord("complete", at("elsewhere")));
      assert.equal((yield* resolveLegacy).baseDir, at(".t3"));
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "redirects an explicit home that reaches the moved one through a symlink",
    () =>
      Effect.gen(function* () {
        const { home, at, mkdir, writeRecord } = yield* makeUserHome;
        yield* mkdir(".t3", "userdata");
        yield* writeRecord(movedRecord("complete", at(".t3")));
        NodeFS.symlinkSync(at(".t3"), at("alias"));
        yield* mkdir("elsewhere");

        const aliased = yield* resolveHome({
          homeDirectory: home,
          env: { T3CODE_HOME: at("alias") },
        });
        const other = yield* resolveHome({
          homeDirectory: home,
          env: { T3CODE_HOME: at("elsewhere") },
        });

        assert.equal(aliased.baseDir, at(".cplane"));
        assert.lengthOf(aliased.warnings, 1);
        assert.equal(other.baseDir, at("elsewhere"));
      }).pipe(Effect.scoped),
  );

  it.effect("follows a record carrying only state and from, as a later build may write", () =>
    Effect.gen(function* () {
      const { home, at, writeRecord } = yield* makeUserHome;
      const implicit = resolveHome({ homeDirectory: home, env: {} });
      const inherited = resolveHome({ homeDirectory: home, env: { T3CODE_HOME: at(".t3") } });

      yield* writeRecord(encodeJson({ state: "rolled-back", from: at(".t3"), extra: true }));
      assert.deepEqual(yield* implicit, { baseDir: at(".t3"), explicit: false, warnings: [] });

      yield* writeRecord(encodeJson({ state: "complete", from: at(".t3") }));
      const redirected = yield* inherited;
      assert.equal(redirected.baseDir, at(".cplane"));
      assert.lengthOf(redirected.warnings, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("uses ~/.cplane once its userdata exists, unless the move was rolled back", () =>
    Effect.gen(function* () {
      const { home, at, mkdir, writeRecord } = yield* makeUserHome;
      const implicit = resolveHome({ homeDirectory: home, env: {} });

      yield* mkdir(".cplane", "userdata");
      assert.deepEqual(yield* implicit, { baseDir: at(".cplane"), explicit: false, warnings: [] });

      yield* writeRecord(movedRecord("complete", at(".t3")));
      assert.equal((yield* implicit).baseDir, at(".cplane"));

      yield* writeRecord(encodeRecord({ state: "fresh" }));
      assert.equal((yield* implicit).baseDir, at(".cplane"));

      yield* writeRecord(movedRecord("rolled-back", at("previous-home")));
      assert.deepEqual(yield* implicit, {
        baseDir: at("previous-home"),
        explicit: false,
        warnings: [],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("treats an invalid or unreadable record as absent, with a warning", () =>
    Effect.gen(function* () {
      const { home, at, mkdir, writeRecord } = yield* makeUserHome;
      const implicit = resolveHome({ homeDirectory: home, env: {} });
      const explicitLegacy = resolveHome({ homeDirectory: home, env: { T3CODE_HOME: at(".t3") } });

      yield* writeRecord("{ not json");
      const invalidJson = yield* implicit;
      assert.equal(invalidJson.baseDir, at(".cplane"));
      assert.lengthOf(invalidJson.warnings, 1);
      assert.include(invalidJson.warnings[0], "not a valid home migration record");

      // A rolled-back record without `from` has nowhere to send the process.
      yield* writeRecord('{"state":"rolled-back"}');
      const missingFrom = yield* implicit;
      assert.equal(missingFrom.baseDir, at(".cplane"));
      assert.lengthOf(missingFrom.warnings, 1);

      const stillExplicit = yield* explicitLegacy;
      assert.equal(stillExplicit.baseDir, at(".t3"));
      assert.lengthOf(stillExplicit.warnings, 1);

      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(at(".cplane", "userdata", "home-migration.json"));
      yield* mkdir(".cplane", "userdata", "home-migration.json");
      const unreadable = yield* implicit;
      assert.equal(unreadable.baseDir, at(".cplane"));
      assert.lengthOf(unreadable.warnings, 1);
      assert.include(unreadable.warnings[0], "could not be read");
    }).pipe(Effect.scoped),
  );

  it.effect("logs warnings to stderr, so a CLI printing JSON keeps a clean stdout", () =>
    Effect.gen(function* () {
      const { home, writeRecord } = yield* makeUserHome;
      yield* writeRecord("{ not json");

      yield* resolveHome({ homeDirectory: home, env: {} });

      assert.lengthOf(yield* TestConsole.logLines, 0);
      const stderr = (yield* TestConsole.errorLines).map(String).join(" ");
      assert.include(stderr, "not a valid home migration record");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "pins a symlinked ~/.t3 or ~/.t3/userdata ahead of ~/.cplane",
    () =>
      Effect.gen(function* () {
        const { home, at, mkdir } = yield* makeUserHome;
        yield* mkdir(".cplane", "userdata");
        yield* mkdir("elsewhere", "userdata");
        const implicit = resolveHome({ homeDirectory: home, env: {} });

        NodeFS.symlinkSync(at("elsewhere"), at(".t3"));
        assert.deepEqual(yield* implicit, { baseDir: at(".t3"), explicit: false, warnings: [] });

        NodeFS.rmSync(at(".t3"));
        yield* mkdir(".t3");
        NodeFS.symlinkSync(at("elsewhere", "userdata"), at(".t3", "userdata"));
        assert.deepEqual(yield* implicit, { baseDir: at(".t3"), explicit: false, warnings: [] });

        // Still subject to a completed move of that path, like any pinned home.
        yield* mkdir(".cplane", "userdata");
        NodeFS.writeFileSync(
          at(".cplane", "userdata", "home-migration.json"),
          movedRecord("complete", at(".t3")),
        );
        const moved = yield* implicit;
        assert.equal(moved.baseDir, at(".cplane"));
        assert.lengthOf(moved.warnings, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the implicit dev home at ~/.t3 while explicit homes still win", () =>
    Effect.gen(function* () {
      const { home, at, mkdir, writeRecord } = yield* makeUserHome;
      yield* mkdir(".cplane", "dev");
      yield* writeRecord(movedRecord("complete", at(".t3")));

      const implicit = yield* resolveHome({ homeDirectory: home, env: {}, variant: "dev" });
      assert.deepEqual(implicit, { baseDir: at(".t3"), explicit: false, warnings: [] });

      const explicit = yield* resolveHome({
        homeDirectory: home,
        env: { T3CODE_HOME: "/work/.t3" },
        variant: "dev",
      });
      assert.deepEqual(explicit, { baseDir: "/work/.t3", explicit: true, warnings: [] });

      const inherited = yield* resolveHome({
        homeDirectory: home,
        env: { T3CODE_HOME: at(".t3") },
        variant: "dev",
      });
      assert.equal(inherited.baseDir, at(".cplane"));
      assert.isTrue(inherited.explicit);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("resolveHomeSync", (it) => {
  it.effect("decides like resolveHome for the pre-ready desktop", () =>
    Effect.gen(function* () {
      const { home, at, mkdir, writeRecord } = yield* makeUserHome;
      const compare = (input: {
        readonly env: { readonly T3CODE_HOME?: string; readonly CPLANE_HOME?: string };
        readonly variant?: "dev";
      }) =>
        Effect.gen(function* () {
          const expected = yield* resolveHome({ ...input, homeDirectory: home });
          const actual = resolveHomeSync(
            { ...input, homeDirectory: home, join: NodePath.join },
            diskProbe,
          );
          assert.deepEqual(actual, expected);
          return actual.baseDir;
        });

      assert.equal(yield* compare({ env: {} }), at(".t3"));
      yield* mkdir(".cplane", "userdata");
      assert.equal(yield* compare({ env: {} }), at(".cplane"));
      assert.equal(yield* compare({ env: {}, variant: "dev" }), at(".t3"));
      yield* writeRecord(movedRecord("complete", at(".t3")));
      assert.equal(yield* compare({ env: { T3CODE_HOME: at(".t3") } }), at(".cplane"));
      assert.equal(
        yield* compare({ env: { CPLANE_HOME: "/cplane", T3CODE_HOME: "/t3" } }),
        "/cplane",
      );
      yield* writeRecord(movedRecord("rolled-back", at(".t3")));
      assert.equal(yield* compare({ env: {} }), at(".t3"));
      yield* writeRecord("[]");
      assert.equal(yield* compare({ env: {} }), at(".cplane"));
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("resolveLocalDevHome", (it) => {
  it.effect("answers .t3 without creating it, and an existing .cplane wins", () =>
    Effect.gen(function* () {
      const { home, at, mkdir } = yield* makeUserHome;

      assert.equal(yield* resolveLocalDevHome(home), at(".t3"));
      assert.isFalse(NodeFS.existsSync(at(".t3")));
      assert.isFalse(NodeFS.existsSync(at(".cplane")));

      yield* mkdir(".cplane");
      assert.equal(yield* resolveLocalDevHome(home), at(".cplane"));
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("isLegacyDefaultHome", (it) => {
  it.effect("matches only ~/.t3", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isLegacyDefaultHome("/home/user/.t3", "/home/user"));
      assert.isTrue(yield* isLegacyDefaultHome("/home/user/.t3/", "/home/user"));
      assert.isFalse(yield* isLegacyDefaultHome("/home/user/.cplane", "/home/user"));
      assert.isFalse(yield* isLegacyDefaultHome("/srv/t3/.t3", "/home/user"));
    }),
  );
});

describe("desktop profile", () => {
  it("prefers an existing cplane profile, then the legacy one, then today's", () => {
    const join = NodePath.posix.join;
    const production = desktopProfileDirs({
      appDataDirectory: "/data",
      isDevelopment: false,
      join,
    });
    const development = desktopProfileDirs({
      appDataDirectory: "/data",
      isDevelopment: true,
      join,
    });

    assert.equal(
      selectDesktopProfileDir(production, { cplane: false, legacy: false }),
      "/data/t3code",
    );
    assert.equal(
      selectDesktopProfileDir(production, { cplane: false, legacy: true }),
      "/data/T3 Code (Alpha)",
    );
    assert.equal(
      selectDesktopProfileDir(production, { cplane: true, legacy: true }),
      "/data/cplane",
    );
    assert.equal(
      selectDesktopProfileDir(development, { cplane: false, legacy: false }),
      "/data/t3code-dev",
    );
    assert.equal(
      selectDesktopProfileDir(development, { cplane: false, legacy: true }),
      "/data/T3 Code (Dev)",
    );
    assert.equal(
      selectDesktopProfileDir(development, { cplane: true, legacy: false }),
      "/data/cplane-dev",
    );
  });
});

it.layer(NodeServices.layer)("writeOwnerMarker", (it) => {
  it.effect("writes the marker once and never overwrites it", () =>
    Effect.gen(function* () {
      const { home, at } = yield* makeUserHome;

      yield* writeOwnerMarker(home, "0.0.55");
      yield* writeOwnerMarker(home, "0.0.56");

      const marker = decodeMarker(NodeFS.readFileSync(at("cplane-owner"), "utf8"));
      assert.equal(marker.app, "control-plane");
      assert.equal(marker.version, "0.0.55");
    }).pipe(Effect.scoped),
  );

  it.effect("logs and carries on when the marker cannot be written", () =>
    Effect.gen(function* () {
      const { home, at } = yield* makeUserHome;

      const { logs } = yield* withLogs(writeOwnerMarker(at("missing"), "0.0.55"));

      assert.lengthOf(logs, 1);
      assert.include(logs[0], at("missing", "cplane-owner"));
      assert.isFalse(NodeFS.existsSync(at("missing")));
      assert.isTrue(NodeFS.existsSync(home));
    }).pipe(Effect.scoped),
  );
});
