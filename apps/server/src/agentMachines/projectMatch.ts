/**
 * Finds the Project on a linked machine that matches a Project on this one.
 * Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module projectMatch
 */

interface MatchableProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
  readonly assistant?: { readonly archivedAt?: string | null | undefined } | null | undefined;
}

export type ProjectMatch =
  | { readonly kind: "matched"; readonly projectId: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly count: number };

const basename = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(index + 1);
};

const sameText = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

const resolve = (matches: ReadonlyArray<MatchableProject>): ProjectMatch | null =>
  matches.length === 0
    ? null
    : matches.length === 1
      ? { kind: "matched", projectId: matches[0]!.id }
      : { kind: "ambiguous", count: matches.length };

/**
 * The same repository (`canonicalKey`) wins when the home Project has one,
 * narrowed by title if several peers share it. Otherwise the same title and
 * the same folder name. Archived Projects never match. Nothing is created.
 */
export function matchPeerProject(
  home: MatchableProject,
  peers: ReadonlyArray<MatchableProject>,
): ProjectMatch {
  const live = peers.filter((peer) => peer.assistant?.archivedAt == null);
  const key = home.repositoryIdentity?.canonicalKey;
  if (key !== undefined) {
    const sameRepo = live.filter((peer) => peer.repositoryIdentity?.canonicalKey === key);
    const byRepo =
      sameRepo.length > 1
        ? (resolve(sameRepo.filter((peer) => sameText(peer.title, home.title))) ??
          ({ kind: "ambiguous", count: sameRepo.length } as const))
        : resolve(sameRepo);
    if (byRepo !== null) return byRepo;
  }
  const folder = basename(home.workspaceRoot);
  return (
    resolve(
      live.filter(
        (peer) =>
          sameText(peer.title, home.title) && sameText(basename(peer.workspaceRoot), folder),
      ),
    ) ?? { kind: "missing" }
  );
}
