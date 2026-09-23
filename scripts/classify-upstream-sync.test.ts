import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { listUpstreamCommits } from "./classify-upstream-sync.ts";

const repositories: string[] = [];
afterEach(() => {
  for (const cwd of repositories.splice(0)) {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

function repository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upstream-policy-"));
  repositories.push(cwd);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--initial-branch=base", "--quiet");
  git("config", "user.name", "Policy Test");
  git("config", "user.email", "policy-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = (path: string, content: string, subject: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
    git("add", "--all");
    git("commit", "--quiet", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  commit("README.md", "base\n", "initial");
  return { cwd, git, commit };
}

describe("listUpstreamCommits", () => {
  it("includes merged UI changes in the first-parent report", () => {
    const { cwd, git, commit } = repository();
    git("checkout", "--quiet", "-b", "upstream");
    commit("apps/server/server.ts", "server\n", "infra");
    git("checkout", "--quiet", "-b", "feature");
    commit("apps/web/view.tsx", "UI\n", "UI feature");
    git("checkout", "--quiet", "upstream");
    git("merge", "--quiet", "--no-ff", "feature", "-m", "merge feature");
    const commits = listUpstreamCommits("base", "upstream", cwd);
    expect(
      commits.map(({ subject, class: classification, files }) => ({
        subject,
        classification,
        files,
      })),
    ).toEqual([
      { subject: "infra", classification: "infra", files: ["apps/server/server.ts"] },
      { subject: "merge feature", classification: "ui", files: ["apps/web/view.tsx"] },
    ]);
  });

  it("retains the protected source path when a UI file moves into infrastructure", () => {
    const { cwd, git, commit } = repository();
    commit("apps/web/view.tsx", "shared content\n", "UI base");
    git("checkout", "--quiet", "-b", "upstream");
    NodeFS.mkdirSync(NodePath.join(cwd, "apps/server"), { recursive: true });
    git("mv", "apps/web/view.tsx", "apps/server/view.tsx");
    git("commit", "--quiet", "-m", "move UI");
    git("config", "diff.renames", "true");
    const [commitResult] = listUpstreamCommits("base", "upstream", cwd);
    expect(commitResult?.files).toEqual(["apps/server/view.tsx", "apps/web/view.tsx"]);
    expect(commitResult?.class).toBe("ui");
  });

  it("excludes patches already picked into the fork but retains pending changes", () => {
    const { cwd, git, commit } = repository();
    git("checkout", "--quiet", "-b", "upstream");
    const picked = commit("apps/server/fix.ts", "fix\n", "upstream fix");
    const pending = commit("apps/server/pending.ts", "pending\n", "pending fix");
    git("checkout", "--quiet", "base");
    commit("fork.md", "fork\n", "fork customization");
    git("cherry-pick", picked);
    expect(listUpstreamCommits("base", "upstream", cwd).map(({ sha }) => sha)).toEqual([pending]);
  });
});
