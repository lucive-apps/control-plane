import { describe, expect, it } from "vite-plus/test";

import {
  classifyUpstreamCommitFiles,
  classifyUpstreamPath,
  recommendUpstreamSync,
  renderUpstreamSyncReport,
} from "./upstream-sync-policy.ts";

describe("classifyUpstreamPath", () => {
  it("treats web, mobile, and brand assets as UI", () => {
    expect(classifyUpstreamPath("apps/web/src/components/Sidebar.tsx")).toBe("ui");
    expect(classifyUpstreamPath("apps/mobile/src/features/home/HomeScreen.tsx")).toBe("ui");
    expect(classifyUpstreamPath("assets/prod/black-macos-1024.png")).toBe("ui");
    expect(classifyUpstreamPath("packages/shared/src/themePalettes.ts")).toBe("ui");
  });

  it("treats server, relay, CI, and packaging as infra", () => {
    expect(classifyUpstreamPath("apps/server/src/orchestration/Agent.ts")).toBe("infra");
    expect(classifyUpstreamPath("infra/relay/src/http/Api.ts")).toBe("infra");
    expect(classifyUpstreamPath(".github/workflows/release.yml")).toBe("infra");
    expect(classifyUpstreamPath("scripts/build-desktop-artifact.ts")).toBe("infra");
  });

  it("treats shared dependencies and lint tooling as mixed", () => {
    expect(classifyUpstreamPath("pnpm-lock.yaml")).toBe("mixed");
    expect(classifyUpstreamPath("pnpm-workspace.yaml")).toBe("mixed");
    expect(classifyUpstreamPath("oxlint-plugin-t3code/rules/example.ts")).toBe("mixed");
    expect(classifyUpstreamPath("unknown/path.ts")).toBe("mixed");
  });

  it("treats contracts and client-runtime as mixed", () => {
    expect(classifyUpstreamPath("packages/contracts/src/server.ts")).toBe("mixed");
    expect(classifyUpstreamPath("packages/client-runtime/src/thread.ts")).toBe("mixed");
    expect(classifyUpstreamPath("apps/desktop/src/electron/ElectronWindow.ts")).toBe("mixed");
  });
});

describe("classifyUpstreamCommitFiles", () => {
  it("marks a commit UI when any file is UI", () => {
    expect(
      classifyUpstreamCommitFiles([
        "apps/server/src/bin.ts",
        "apps/web/src/components/chat/ChatComposer.tsx",
      ]),
    ).toBe("ui");
  });

  it("marks server-only commits infra", () => {
    expect(
      classifyUpstreamCommitFiles(["apps/server/src/bin.ts", ".github/workflows/ci.yml"]),
    ).toBe("infra");
  });

  it("does not label missing changed paths as infrastructure", () => {
    expect(classifyUpstreamCommitFiles([])).toBe("mixed");
    expect(classifyUpstreamCommitFiles([""])).toBe("mixed");
  });

  it("marks contract-only commits mixed", () => {
    expect(classifyUpstreamCommitFiles(["packages/contracts/src/settings.ts"])).toBe("mixed");
  });
});

describe("recommendUpstreamSync", () => {
  it("requires review even for infra-only or empty ranges", () => {
    expect(recommendUpstreamSync([])).toBe("review-infra");
    expect(recommendUpstreamSync(["infra", "infra"])).toBe("review-infra");
    expect(recommendUpstreamSync(["infra", "mixed"])).toBe("review-mixed");
    expect(recommendUpstreamSync(["infra", "ui"])).toBe("review-ui");
  });
});

describe("renderUpstreamSyncReport", () => {
  it("lists infrastructure as unverified candidates when UI is present", () => {
    const report = renderUpstreamSyncReport({
      baseRef: "origin/main",
      upstreamRef: "upstream/main",
      compareUrl: "https://github.com/pingdotgg/t3code/compare/aaa...bbb",
      commits: [
        {
          sha: "111111111aaaa",
          subject: "fix(server): retry git checkpoint capture",
          files: ["apps/server/src/git.ts"],
          class: "infra",
        },
        {
          sha: "222222222bbbb",
          subject: "feat(web): undo snooze with mod+z",
          files: ["apps/web/src/components/Sidebar.tsx"],
          class: "ui",
        },
      ],
    });
    expect(report).toContain("**Recommendation: hold UI.**");
    expect(report).toContain("### Infra (review candidates)");
    expect(report).toContain("not a verified safe subset");
    expect(report).toContain("Path classification never authorizes a merge");
    expect(report).toContain("fix(server): retry git checkpoint capture");
    expect(report).toContain("### UI (hold)");
    expect(report).toContain("feat(web): undo snooze with mod+z");
  });
});
