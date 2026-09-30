import { describe, expect, it } from "@effect/vitest";

import { matchPeerProject } from "./projectMatch.ts";

type Project = Parameters<typeof matchPeerProject>[0];

const REPO = "github.com/nick/control-plane";

const project = (
  id: string,
  title: string,
  workspaceRoot: string,
  extra: Partial<Project> = {},
): Project => ({ id, title, workspaceRoot, ...extra });

const withRepo = (canonicalKey: string) => ({ repositoryIdentity: { canonicalKey } });
const archived = { assistant: { archivedAt: "2026-09-01T00:00:00.000Z" } };

const home = project("home", "Control Plane", "/Users/nick/Code/control-plane", withRepo(REPO));
const homeNoRepo = project("home", "Control Plane", "/Users/nick/Code/control-plane");

describe("matchPeerProject by repository", () => {
  it("matches the one peer Project with the same canonicalKey, whatever its title or folder", () => {
    const peers = [
      project("other", "Other", "/srv/other", withRepo("github.com/nick/other")),
      project("peer", "CP on the Mini", "/Volumes/work/cp", withRepo(REPO)),
    ];
    expect(matchPeerProject(home, peers)).toEqual({ kind: "matched", projectId: "peer" });
  });

  it("narrows by title when several peer Projects share the repository", () => {
    const peers = [
      project("scratch", "Scratch", "/srv/cp-scratch", withRepo(REPO)),
      project("main", "control plane", "/srv/cp", withRepo(REPO)),
    ];
    expect(matchPeerProject(home, peers)).toEqual({ kind: "matched", projectId: "main" });
  });

  it("is ambiguous when several share the repository and the title does not single one out", () => {
    expect(
      matchPeerProject(home, [
        project("a", "Scratch", "/srv/a", withRepo(REPO)),
        project("b", "Experiments", "/srv/b", withRepo(REPO)),
      ]),
    ).toEqual({ kind: "ambiguous", count: 2 });
    expect(
      matchPeerProject(home, [
        project("a", "Control Plane", "/srv/a", withRepo(REPO)),
        project("b", "Control Plane", "/srv/b", withRepo(REPO)),
        project("c", "Scratch", "/srv/c", withRepo(REPO)),
      ]),
    ).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("falls back to title and folder when no peer shares the repository", () => {
    const peers = [project("peer", "Control Plane", "/Volumes/work/control-plane")];
    expect(matchPeerProject(home, peers)).toEqual({ kind: "matched", projectId: "peer" });
  });
});

describe("matchPeerProject by title and folder", () => {
  it("matches the same title (ignoring case) and the same folder basename", () => {
    const peers = [
      project("wrong-folder", "Control Plane", "/srv/cp"),
      project("peer", "control plane", "/home/nick/src/control-plane"),
    ];
    expect(matchPeerProject(homeNoRepo, peers)).toEqual({ kind: "matched", projectId: "peer" });
  });

  it("ignores trailing slashes and reads backslash paths", () => {
    for (const workspaceRoot of [
      "/srv/control-plane/",
      "/srv/control-plane//",
      "C:\\Users\\nick\\control-plane",
      "C:\\Users\\nick\\control-plane\\",
    ]) {
      expect(
        matchPeerProject(homeNoRepo, [project("peer", "Control Plane", workspaceRoot)]),
      ).toEqual({ kind: "matched", projectId: "peer" });
    }
    const windowsHome = project("home", "Control Plane", "D:\\code\\control-plane\\");
    expect(
      matchPeerProject(windowsHome, [project("peer", "Control Plane", "/srv/control-plane")]),
    ).toEqual({ kind: "matched", projectId: "peer" });
  });

  it("is missing when the title matches but the folder does not, or the other way round", () => {
    expect(
      matchPeerProject(homeNoRepo, [
        project("a", "Control Plane", "/srv/control-plane-2"),
        project("b", "Control Plane Fork", "/srv/control-plane"),
      ]),
    ).toEqual({ kind: "missing" });
  });

  it("is ambiguous when several peers share the title and folder", () => {
    expect(
      matchPeerProject(homeNoRepo, [
        project("a", "Control Plane", "/srv/control-plane"),
        project("b", "Control Plane", "/Volumes/x/control-plane"),
      ]),
    ).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("is missing with no peer Projects", () => {
    expect(matchPeerProject(home, [])).toEqual({ kind: "missing" });
  });
});

describe("matchPeerProject and archived Projects", () => {
  it("never matches an archived peer Project, by repository or by title", () => {
    expect(
      matchPeerProject(home, [
        project("gone", "Control Plane", "/srv/control-plane", {
          ...withRepo(REPO),
          ...archived,
        }),
      ]),
    ).toEqual({ kind: "missing" });
    expect(
      matchPeerProject(homeNoRepo, [
        project("gone", "Control Plane", "/srv/control-plane", archived),
      ]),
    ).toEqual({ kind: "missing" });
  });

  it("an archived twin does not make a live match ambiguous", () => {
    expect(
      matchPeerProject(home, [
        project("gone", "Control Plane", "/srv/old", { ...withRepo(REPO), ...archived }),
        project("live", "Control Plane", "/srv/new", withRepo(REPO)),
      ]),
    ).toEqual({ kind: "matched", projectId: "live" });
  });

  it("a live assistant marker with a null archivedAt still matches", () => {
    expect(
      matchPeerProject(home, [
        project("live", "CP", "/srv/cp", { ...withRepo(REPO), assistant: { archivedAt: null } }),
      ]),
    ).toEqual({ kind: "matched", projectId: "live" });
  });
});
