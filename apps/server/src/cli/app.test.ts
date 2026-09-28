// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture binds the same platform socket or named pipe as the CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import {
  HostProcessPlatform,
  HostProcessUserId,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import { HomeMigrationRecord } from "@t3tools/shared/home";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import { makeCli } from "../bin.ts";
import { DesktopAppUnreachableError } from "./app.ts";

// Hermetic by construction. The CLI derives the desktop control socket from
// the resolved home and `os.tmpdir()`, so a real home or temp dir here can
// reach the user's running desktop app: a resolver bug once sent it a live
// activation request and created a stray project. Every test runs in its own
// sandbox that points both `os.homedir()` and `os.tmpdir()` inside it, for the
// fake desktop and the CLI under test alike. Outside a sandbox both point at a
// path nothing listens on.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const unset = `${os.tmpdir()}/t3-app-test-unset`;
  return { ...os, homedir: vi.fn(() => `${unset}/home`), tmpdir: vi.fn(() => `${unset}/tmp`) };
});

afterEach(() => {
  vi.mocked(NodeOS.homedir).mockReset();
  vi.mocked(NodeOS.tmpdir).mockReset();
});

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

async function startFakeDesktop(input: {
  readonly baseDir: string;
  readonly stateSubdirectory?: "userdata" | "dev";
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  readonly reply?: (request: DesktopAppActivationRequest) => unknown;
}) {
  const target = resolveDesktopAppControlAddress({
    stateDir: NodePath.join(input.baseDir, input.stateSubdirectory ?? "userdata"),
    platform: input.platform,
    tempDir: NodeOS.tmpdir(),
    userId: input.userId,
    joinPath: NodePath.join,
  });
  if (target.directory !== null) {
    await NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  const received: DesktopAppActivationRequest[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
      received.push(request);
      const response = input.reply
        ? input.reply(request)
        : {
            version: 1,
            requestId: request.requestId,
            ok: true,
            projectId: "project-1",
            threadId: `thread-${received.length}`,
          };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.address, resolve);
  });

  return {
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.directory !== null) {
        await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

const fakeDesktop = Effect.fn(function* (
  input: Omit<Parameters<typeof startFakeDesktop>[0], "platform" | "userId">,
) {
  const platform = yield* HostProcessPlatform;
  const userId = yield* HostProcessUserId;
  return yield* Effect.acquireRelease(
    Effect.promise(() => startFakeDesktop({ ...input, platform, userId })),
    (server) => Effect.promise(() => server.close()),
  );
});

interface Sandbox {
  /** What `os.homedir()` returns, so the implicit home is `<home>/.t3`. */
  readonly home: string;
  /** What `os.tmpdir()` returns, where every desktop socket lives. */
  readonly tmp: string;
}

// Unix socket paths are capped near 104 bytes, and an isolated TMPDIR on macOS
// is already over half of that, so POSIX sandboxes live under `/tmp`. Windows
// uses named pipes, which ignore the temp dir.
const withSandbox = <A, E, R>(use: (sandbox: Sandbox) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const parent =
        platform === "win32"
          ? (yield* Effect.promise(() => vi.importActual<typeof NodeOS>("node:os"))).tmpdir()
          : "/tmp";
      const root = yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(parent, "t3a-")));
      const sandbox = { home: NodePath.join(root, "home"), tmp: NodePath.join(root, "tmp") };
      yield* Effect.promise(() => NodeFSP.mkdir(sandbox.home));
      yield* Effect.promise(() => NodeFSP.mkdir(sandbox.tmp));
      vi.mocked(NodeOS.homedir).mockReturnValue(sandbox.home);
      vi.mocked(NodeOS.tmpdir).mockReturnValue(sandbox.tmp);
      return { root, sandbox };
    }),
    ({ sandbox }) => use(sandbox),
    ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

const encodeHomeMigrationRecord = Schema.encodeSync(Schema.fromJsonString(HomeMigrationRecord));
const isDesktopAppUnreachable = Schema.is(DesktopAppUnreachableError);

/** Records that a move copied `from` to `<home>/.cplane`. */
const writeCompletedMove = (home: string, from: string) =>
  Effect.promise(async () => {
    const userdata = NodePath.join(home, ".cplane", "userdata");
    await NodeFSP.mkdir(userdata, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(userdata, "home-migration.json"),
      encodeHomeMigrationRecord({
        state: "complete",
        from,
        environmentId: "environment-1",
        sourceMaxSequence: 1,
        at: "2026-01-01T00:00:00.000Z",
        version: "0.0.60",
      }),
    );
  });

describe("t3 app", () => {
  it.effect("reaches only sockets inside its sandbox", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const error = yield* runCli(["app"]).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        const addresses = isDesktopAppUnreachable(error) ? error.candidateAddresses : [];
        expect(addresses).toHaveLength(2);
        if (platform !== "win32") {
          for (const address of addresses) {
            expect(address.startsWith(`${sandbox.tmp}${NodePath.sep}`)).toBe(true);
          }
        }
      }),
    ),
  );

  it.effect("rejects SSH before it tries to reach a desktop app", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir], {
          SSH_CONNECTION: "client server",
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppSshUnsupportedError",
          message:
            "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("rejects unsupported platforms without creating state", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(
          Effect.provideService(HostProcessPlatform, "freebsd"),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppPlatformUnsupportedError",
          platform: "freebsd",
          message: "`t3 app` is not supported on freebsd.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("does not create state when only a server or no desktop app is running", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppUnreachableError",
          candidateAddresses: [expect.any(String)],
          workspaceRoot: yield* HostProcessWorkingDirectory,
          message: expect.stringContaining("Could not reach the T3 Code desktop app."),
          cause: { code: "ENOENT" },
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("uses T3CODE_HOME or --base-dir and sends the default or explicit path", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, "t3-home");
        const explicitPath = NodePath.join(sandbox.home, "project");
        const platform = yield* HostProcessPlatform;
        const workingDirectory = yield* HostProcessWorkingDirectory;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app"], { T3CODE_HOME: baseDir });
        yield* runCli(["app", explicitPath, "--base-dir", baseDir]);

        expect(desktop.received.map((request) => request.workspaceRoot)).toEqual([
          workingDirectory,
          explicitPath,
        ]);
        expect(desktop.received.every((request) => request.platform === platform)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("ranks --base-dir over CPLANE_HOME over T3CODE_HOME", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const flagHome = NodePath.join(sandbox.home, "flag-home");
        const cplaneHome = NodePath.join(sandbox.home, "cplane-home");
        const t3Home = NodePath.join(sandbox.home, "t3-home");
        const flagDesktop = yield* fakeDesktop({ baseDir: flagHome });
        const cplaneDesktop = yield* fakeDesktop({ baseDir: cplaneHome });
        const t3Desktop = yield* fakeDesktop({ baseDir: t3Home });
        const env = { CPLANE_HOME: cplaneHome, T3CODE_HOME: t3Home };

        yield* runCli(["app", "--base-dir", flagHome], env);
        yield* runCli(["app"], env);
        yield* runCli(["app"], { CPLANE_HOME: "  ", T3CODE_HOME: t3Home });

        expect(flagDesktop.received).toHaveLength(1);
        expect(cplaneDesktop.received).toHaveLength(1);
        expect(t3Desktop.received).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("follows a completed move of an explicit home without searching dev state", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const legacyHome = NodePath.join(sandbox.home, ".t3");
        yield* writeCompletedMove(sandbox.home, legacyHome);
        const moved = yield* fakeDesktop({ baseDir: NodePath.join(sandbox.home, ".cplane") });
        const legacy = yield* fakeDesktop({ baseDir: legacyHome });
        const development = yield* fakeDesktop({ baseDir: legacyHome, stateSubdirectory: "dev" });

        yield* runCli(["app"], { T3CODE_HOME: legacyHome });

        expect(moved.received).toHaveLength(1);
        expect(legacy.received).toHaveLength(0);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("uses an existing ~/.cplane and still finds the dev desktop in ~/.t3/dev", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const legacyHome = NodePath.join(sandbox.home, ".t3");
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(sandbox.home, ".cplane", "userdata"), { recursive: true }),
        );
        const legacy = yield* fakeDesktop({ baseDir: legacyHome });
        const development = yield* fakeDesktop({ baseDir: legacyHome, stateSubdirectory: "dev" });

        yield* runCli(["app"]);

        expect(legacy.received).toHaveLength(0);
        expect(development.received).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, ".t3");
        const desktop = yield* fakeDesktop({ baseDir });
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);

        expect(desktop.received).toHaveLength(1);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("finds the dev desktop when the default desktop socket is absent", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);
        yield* runCli(["app"], { T3CODE_HOME: "   " });

        expect(development.received).toHaveLength(2);
        expect(yield* pathExists(baseDir)).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("never searches a dev state directory for an explicit T3 home", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(sandbox.home, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        const flagError = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);
        const envError = yield* runCli(["app"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);
        const cplaneEnvError = yield* runCli(["app"], { CPLANE_HOME: baseDir }).pipe(Effect.flip);

        expect(flagError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(envError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(cplaneEnvError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.scoped),
    ),
  );

  for (const responseKind of ["failure", "invalid"] as const) {
    it.effect(`never falls back after the default desktop sends a ${responseKind} response`, () =>
      withSandbox((sandbox) =>
        Effect.gen(function* () {
          const baseDir = NodePath.join(sandbox.home, ".t3");
          const desktop = yield* fakeDesktop({
            baseDir,
            reply: (request) =>
              responseKind === "failure"
                ? {
                    version: 1,
                    requestId: request.requestId,
                    ok: false,
                    code: "project-create-failed",
                    message: "The project path is not available.",
                  }
                : { invalid: true },
          });
          const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

          const error = yield* runCli(["app"]).pipe(Effect.flip);

          expect(desktop.received).toHaveLength(1);
          expect(development.received).toHaveLength(0);
          if (responseKind === "failure") {
            expect(error).toMatchObject({
              _tag: "DesktopAppRequestFailedError",
              code: "project-create-failed",
              requestId: desktop.received[0]?.requestId,
              workspaceRoot: yield* HostProcessWorkingDirectory,
              message: expect.stringContaining("project-create-failed"),
              cause: {
                ok: false,
                code: "project-create-failed",
                message: "The project path is not available.",
              },
            });
          } else {
            expect(error).toMatchObject({
              _tag: "DesktopAppUnreachableError",
              cause: { message: "The desktop app response is invalid." },
            });
          }
        }).pipe(Effect.scoped),
      ),
    );
  }
});
