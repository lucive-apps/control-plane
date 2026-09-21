#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  classifyUpstreamCommitFiles,
  countUpstreamSyncClasses,
  recommendUpstreamSync,
  renderUpstreamSyncReport,
  type UpstreamSyncCommit,
} from "./lib/upstream-sync-policy.ts";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

function readFlag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return argv[index + 1] ?? fallback;
}

function git(args: readonly string[], cwd: string): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function listUpstreamCommits(
  baseRef: string,
  upstreamRef: string,
  cwd: string,
): UpstreamSyncCommit[] {
  const log = git(
    [
      "log",
      "--reverse",
      "--first-parent",
      "--no-merges",
      "--format=%H\t%s",
      `${baseRef}..${upstreamRef}`,
    ],
    cwd,
  ).trim();
  if (log.length === 0) {
    return [];
  }
  return log.split("\n").map((line) => {
    const [sha, ...subjectParts] = line.split("\t");
    const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha ?? ""], cwd)
      .split("\n")
      .map((filePath) => filePath.trim())
      .filter((filePath) => filePath.length > 0);
    return {
      sha: sha ?? "",
      subject: subjectParts.join("\t"),
      files,
      class: classifyUpstreamCommitFiles(files),
    };
  });
}

function shortSha(ref: string, cwd: string): string {
  return git(["rev-parse", "--short", ref], cwd).trim();
}

const argv = process.argv.slice(2);
const baseRef = readFlag(argv, "base", "origin/main");
const upstreamRef = readFlag(argv, "upstream", "upstream/main");
const json = argv.includes("--json");
const commits = listUpstreamCommits(baseRef, upstreamRef, REPO_ROOT);
const classes = commits.map((commit) => commit.class);
const report = {
  baseRef,
  upstreamRef,
  compareUrl: `https://github.com/pingdotgg/t3code/compare/${shortSha(baseRef, REPO_ROOT)}...${shortSha(upstreamRef, REPO_ROOT)}`,
  recommendation: recommendUpstreamSync(classes),
  counts: countUpstreamSyncClasses(classes),
  commits,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderUpstreamSyncReport(report));
}
