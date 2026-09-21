export type UpstreamSyncClass = "infra" | "mixed" | "ui";

export type UpstreamSyncRecommendation = "merge" | "review-mixed" | "review-ui";

export interface UpstreamSyncCommit {
  readonly sha: string;
  readonly subject: string;
  readonly files: readonly string[];
  readonly class: UpstreamSyncClass;
}

const UI_PREFIXES = [
  "apps/web/",
  "apps/mobile/",
  "apps/marketing/",
  "assets/",
  "apps/desktop/src/window/",
  "apps/desktop/src/preview/Annotation",
  "patches/expo-",
  "patches/@clerk__expo",
  "patches/@expo__",
  "patches/react-native",
  "patches/uniwind",
] as const;

const UI_PATHS = new Set([
  "packages/shared/src/themePalettes.ts",
  "packages/shared/src/keybindings.ts",
]);

const INFRA_PREFIXES = [
  "apps/server/",
  "infra/",
  "native/",
  "scripts/",
  "packaging/",
  ".github/",
  "oxlint-plugin-t3code/",
  "packages/ssh/",
  "packages/tailscale/",
  "packages/effect-acp/",
  "packages/effect-codex-app-server/",
  "apps/desktop/src/backend/",
  "apps/desktop/src/updates/",
  "apps/desktop/src/telemetry/",
  "apps/desktop/src/wsl/",
  "apps/desktop/src/ssh/",
  "docs/operations/",
  "docs/internals/",
] as const;

const INFRA_PATHS = new Set([
  "knip.jsonc",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "third-party-licenses.config.json",
]);

function normalizeRepoPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesPrefix(filePath: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => filePath === prefix.replace(/\/$/, "") || filePath.startsWith(prefix),
  );
}

export function classifyUpstreamPath(filePath: string): UpstreamSyncClass {
  const normalized = normalizeRepoPath(filePath);
  if (normalized.length === 0) {
    return "mixed";
  }
  if (UI_PATHS.has(normalized) || matchesPrefix(normalized, UI_PREFIXES)) {
    return "ui";
  }
  if (INFRA_PATHS.has(normalized) || matchesPrefix(normalized, INFRA_PREFIXES)) {
    return "infra";
  }
  return "mixed";
}

export function classifyUpstreamCommitFiles(files: readonly string[]): UpstreamSyncClass {
  let sawMixed = false;
  for (const filePath of files) {
    const fileClass = classifyUpstreamPath(filePath);
    if (fileClass === "ui") {
      return "ui";
    }
    if (fileClass === "mixed") {
      sawMixed = true;
    }
  }
  return sawMixed ? "mixed" : "infra";
}

export function recommendUpstreamSync(
  classes: readonly UpstreamSyncClass[],
): UpstreamSyncRecommendation {
  if (classes.includes("ui")) {
    return "review-ui";
  }
  if (classes.includes("mixed")) {
    return "review-mixed";
  }
  return "merge";
}

export function countUpstreamSyncClasses(
  classes: readonly UpstreamSyncClass[],
): Record<UpstreamSyncClass, number> {
  const counts: Record<UpstreamSyncClass, number> = { infra: 0, mixed: 0, ui: 0 };
  for (const syncClass of classes) {
    counts[syncClass] += 1;
  }
  return counts;
}

export function formatUpstreamCommitLine(commit: UpstreamSyncCommit): string {
  return `- \`${commit.sha.slice(0, 9)}\` ${commit.subject}`;
}

export function renderUpstreamSyncReport(input: {
  readonly baseRef: string;
  readonly upstreamRef: string;
  readonly compareUrl: string;
  readonly commits: readonly UpstreamSyncCommit[];
}): string {
  const classes = input.commits.map((commit) => commit.class);
  const counts = countUpstreamSyncClasses(classes);
  const recommendation = recommendUpstreamSync(classes);
  const recommendationLine =
    recommendation === "merge"
      ? "**Recommendation: merge.** Infra only. No UI files."
      : recommendation === "review-mixed"
        ? "**Recommendation: review mixed.** Protocol or shared runtime changed. No web/mobile UI files."
        : "**Recommendation: hold UI.** Do not merge the full range. Infra commits below are the safe subset.";

  const byClass = {
    infra: input.commits.filter((commit) => commit.class === "infra"),
    mixed: input.commits.filter((commit) => commit.class === "mixed"),
    ui: input.commits.filter((commit) => commit.class === "ui"),
  };

  const sections = [
    "## Upstream sync",
    "",
    `${input.commits.length} commit(s) from \`${input.upstreamRef}\` onto \`${input.baseRef}\`.`,
    "",
    recommendationLine,
    "",
    `- Compare: ${input.compareUrl}`,
    `- Infra: ${counts.infra}`,
    `- Mixed: ${counts.mixed}`,
    `- UI: ${counts.ui}`,
    "",
    "Rules: merge infra. Review mixed. Hold UI unless T3 shipped something we specifically want.",
  ];

  if (byClass.infra.length > 0) {
    sections.push("", "### Infra (merge)", "", ...byClass.infra.map(formatUpstreamCommitLine));
  }
  if (byClass.mixed.length > 0) {
    sections.push("", "### Mixed (review)", "", ...byClass.mixed.map(formatUpstreamCommitLine));
  }
  if (byClass.ui.length > 0) {
    sections.push("", "### UI (hold)", "", ...byClass.ui.map(formatUpstreamCommitLine));
  }

  return `${sections.join("\n")}\n`;
}
