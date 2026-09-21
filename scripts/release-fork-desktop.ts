#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Fork ship script spawns vp/gh with inherited stdio.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  FORK_DESKTOP_UPDATE_REPOSITORY,
  forkDesktopReleaseAssetNames,
  resolveNextForkDesktopVersion,
} from "./fork-desktop-version.ts";
import { updateReleasePackageVersions } from "./update-release-package-versions.ts";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const DesktopPackageJsonSchema = Schema.Struct({
  version: Schema.NonEmptyString,
});
const decodeDesktopPackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPackageJsonSchema),
);
const GitHubReleaseListSchema = Schema.Array(Schema.Struct({ tagName: Schema.String }));
const decodeGitHubReleaseList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubReleaseListSchema),
);

export class ForkDesktopReleasePackageError extends Schema.TaggedError<ForkDesktopReleasePackageError>()(
  "ForkDesktopReleasePackageError",
  {
    operation: Schema.Literals(["read", "decode"]),
    packageJsonPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} desktop package metadata at ${this.packageJsonPath}.`;
  }
}

export class ForkDesktopReleaseCommandError extends Schema.TaggedError<ForkDesktopReleaseCommandError>()(
  "ForkDesktopReleaseCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `\`${this.command}\` exited with code ${this.exitCode}.`;
  }
}

export class ForkDesktopReleaseArtifactError extends Schema.TaggedError<ForkDesktopReleaseArtifactError>()(
  "ForkDesktopReleaseArtifactError",
  {
    artifactPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing packaged artifact '${this.artifactPath}'.`;
  }
}

const readDesktopPackageVersion = Effect.fn("readDesktopPackageVersion")(function* (
  repoRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageJsonPath = path.join(repoRoot, "apps/desktop/package.json");
  const packageJsonSource = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.mapError(
      (cause) =>
        new ForkDesktopReleasePackageError({
          operation: "read",
          packageJsonPath,
          cause,
        }),
    ),
  );
  const packageJson = yield* decodeDesktopPackageJson(packageJsonSource).pipe(
    Effect.mapError(
      (cause) =>
        new ForkDesktopReleasePackageError({
          operation: "decode",
          packageJsonPath,
          cause,
        }),
    ),
  );
  return packageJson.version;
});

const runInheritedCommand = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(command, [...args], {
          cwd,
          env,
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (exitCode) => {
          if (exitCode === 0) {
            resolve();
            return;
          }
          reject(
            new ForkDesktopReleaseCommandError({
              command: [command, ...args].join(" "),
              exitCode: exitCode ?? 1,
            }),
          );
        });
      }),
    catch: (cause) =>
      cause instanceof ForkDesktopReleaseCommandError
        ? cause
        : new ForkDesktopReleaseCommandError({
            command: [command, ...args].join(" "),
            exitCode: 1,
          }),
  });

const readCommandStdout = (command: string, args: readonly string[], cwd: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const child = NodeChildProcess.spawn(command, [...args], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (exitCode) => {
          if (exitCode === 0) {
            resolve(stdout);
            return;
          }
          reject(
            new ForkDesktopReleaseCommandError({
              command: `${[command, ...args].join(" ")}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
              exitCode: exitCode ?? 1,
            }),
          );
        });
      }),
    catch: (cause) =>
      cause instanceof ForkDesktopReleaseCommandError
        ? cause
        : new ForkDesktopReleaseCommandError({
            command: [command, ...args].join(" "),
            exitCode: 1,
          }),
  });

const readPublishedReleaseTags = (repo: string, repoRoot: string) =>
  readCommandStdout(
    "gh",
    ["release", "list", "--repo", repo, "--limit", "50", "--json", "tagName"],
    repoRoot,
  ).pipe(
    Effect.flatMap((stdout) => decodeGitHubReleaseList(stdout)),
    Effect.map((releases) => releases.map((release) => release.tagName)),
  );

const releaseExists = (repo: string, tag: string, repoRoot: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve, reject) => {
        const child = NodeChildProcess.spawn("gh", ["release", "view", tag, "--repo", repo], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("exit", (exitCode) => {
          resolve(exitCode === 0);
        });
      }),
    catch: () => false,
  });

const signedBuildEnv = (version: string): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  env.T3CODE_DESKTOP_SIGNED = "true";
  env.T3CODE_DESKTOP_VERSION = version;
  if (!env.APPLE_APP_SPECIFIC_PASSWORD?.trim() && env.APPLE_PASSWORD?.trim()) {
    env.APPLE_APP_SPECIFIC_PASSWORD = env.APPLE_PASSWORD;
  }
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  delete env.T3CODE_SINGLE_ORIGIN_DEV;
  delete env.T3CODE_HOME;
  delete env.T3CODE_DESKTOP_SKIP_BUILD;
  return env;
};

export const releaseForkDesktopCommand = Command.make(
  "release-fork-desktop",
  {
    releaseVersion: Flag.String("release-version").pipe(
      Flag.withDescription("Ship this version instead of bumping the next patch."),
      Flag.optional,
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("GitHub repository that hosts desktop releases."),
      Flag.withDefault(FORK_DESKTOP_UPDATE_REPOSITORY),
    ),
    notes: Flag.String("notes").pipe(
      Flag.withDescription("GitHub release notes. Defaults to a short version title."),
      Flag.optional,
    ),
    bumpOnly: Flag.Boolean("bump-only").pipe(
      Flag.withDescription("Write the next version into package manifests and exit."),
      Flag.withDefault(false),
    ),
    skipBuild: Flag.Boolean("skip-build").pipe(
      Flag.withDescription("Skip the signed desktop packager and reuse existing artifacts."),
      Flag.withDefault(false),
    ),
    skipGithub: Flag.Boolean("skip-github").pipe(
      Flag.withDescription("Skip GitHub release lookup and upload."),
      Flag.withDefault(false),
    ),
  },
  ({ releaseVersion, repo, notes, bumpOnly, skipBuild, skipGithub }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = REPO_ROOT;
      const packageVersion = yield* readDesktopPackageVersion(repoRoot);
      const publishedVersions = skipGithub ? [] : yield* readPublishedReleaseTags(repo, repoRoot);
      const nextVersion =
        Option.getOrUndefined(releaseVersion)?.trim() ||
        resolveNextForkDesktopVersion({
          packageVersion,
          publishedVersions,
        });

      yield* updateReleasePackageVersions(nextVersion, { rootDir: repoRoot });
      yield* Console.log(`[fork-desktop] Version ${nextVersion}`);

      if (bumpOnly) {
        return;
      }

      if (!skipBuild) {
        yield* runInheritedCommand(
          "vp",
          ["run", "dist:desktop:dmg:arm64"],
          signedBuildEnv(nextVersion),
          repoRoot,
        );
      }

      const outputDir = path.join(repoRoot, "release");
      const artifacts = forkDesktopReleaseAssetNames(nextVersion).map((name) =>
        path.join(outputDir, name),
      );
      for (const artifactPath of artifacts) {
        if (!(yield* fs.exists(artifactPath))) {
          return yield* new ForkDesktopReleaseArtifactError({ artifactPath });
        }
      }

      if (skipGithub) {
        return;
      }

      const exists = yield* releaseExists(repo, nextVersion, repoRoot);
      const releaseNotes = Option.getOrUndefined(notes)?.trim() || `T3 Code ${nextVersion}`;
      const targetSha = (yield* readCommandStdout("git", ["rev-parse", "HEAD"], repoRoot)).trim();
      if (exists) {
        yield* runInheritedCommand(
          "gh",
          ["release", "upload", nextVersion, "--repo", repo, "--clobber", ...artifacts],
          process.env,
          repoRoot,
        );
      } else {
        yield* runInheritedCommand(
          "gh",
          [
            "release",
            "create",
            nextVersion,
            "--repo",
            repo,
            "--target",
            targetSha,
            "--title",
            `T3 Code ${nextVersion}`,
            "--notes",
            releaseNotes,
            ...artifacts,
          ],
          process.env,
          repoRoot,
        );
      }

      yield* Console.log(`https://github.com/${repo}/releases/tag/${nextVersion}`);
    }),
).pipe(
  Command.withDescription(
    "Bump the fork desktop patch version, sign an arm64 DMG, and publish a GitHub Release.",
  ),
);

if (import.meta.main) {
  Command.run(releaseForkDesktopCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
