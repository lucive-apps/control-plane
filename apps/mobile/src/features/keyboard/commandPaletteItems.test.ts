import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  buildCommandPaletteProjectRows,
  filterCommandPaletteItems,
  nextPaletteIndex,
  type CommandPaletteItem,
} from "./commandPaletteItems";

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return { key, title, kind, searchTerms, run: () => {} };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread", ["Mobile app", "Siva"]),
  item("mac:one", "Mobile app", "thread", ["Mac"]),
];
const emptyMatches = new Set<string>();

describe("filterCommandPaletteItems", () => {
  it("shows actions and recent threads in their original order when the query is empty", () => {
    expect(filterCommandPaletteItems(items, "", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
      "siva:one",
      "mac:one",
    ]);
  });

  it("matches query tokens across titles and metadata and ranks exact titles first", () => {
    expect(
      filterCommandPaletteItems(items, " MOBILE app ", emptyMatches).map((item) => item.key),
    ).toEqual(["project", "mac:one", "siva:one"]);
    expect(
      filterCommandPaletteItems(items, "siva keyboard", emptyMatches).map((item) => item.key),
    ).toEqual(["siva:one"]);
  });

  it("supports the desktop actions-only prefix and action aliases", () => {
    expect(filterCommandPaletteItems(items, ">", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
    ]);
    expect(
      filterCommandPaletteItems(items, "> preferences", emptyMatches).map((item) => item.key),
    ).toEqual(["settings"]);
    expect(
      filterCommandPaletteItems(items, "> new thread", emptyMatches).map((item) => item.key),
    ).toEqual(["new"]);
  });

  it("includes server content matches scoped to the correct environment, except in actions-only mode", () => {
    const matches = new Set(["siva:one", "project"]);
    expect(
      filterCommandPaletteItems(items, "message content", matches).map((item) => item.key),
    ).toEqual(["siva:one"]);
    expect(filterCommandPaletteItems(items, "> message content", matches)).toEqual([]);
  });
});

describe("buildCommandPaletteProjectRows", () => {
  const mac = EnvironmentId.make("mac");
  const mini = EnvironmentId.make("mini");
  const local = {
    environmentId: mac,
    title: "t3code",
    workspaceRoot: "/Users/nick/Code/t3code",
  };
  const remote = {
    environmentId: mini,
    title: "t3code",
    workspaceRoot: "/Users/nick/t3code",
  };

  it("lists one row per logical repo and keeps the current-machine checkout", () => {
    const [row] = buildCommandPaletteProjectRows({
      scopes: [
        {
          key: "github.com/pingdotgg/t3code",
          title: "t3code",
          representative: local,
          projects: [local, remote],
        },
      ],
      preferredEnvironmentId: mini,
      environmentLabelById: new Map([
        [mac, "MacBook Pro"],
        [mini, "Mac Mini"],
      ]),
    });

    expect(row?.title).toBe("t3code");
    expect(row?.detail).toBe("/Users/nick/t3code");
    expect(row?.detail).not.toContain("Mac Mini");
    expect(row?.target).toBe(remote);
    expect(row?.searchTerms).toEqual(
      expect.arrayContaining([
        "MacBook Pro",
        "Mac Mini",
        "/Users/nick/Code/t3code",
        "/Users/nick/t3code",
      ]),
    );
  });
});

describe("nextPaletteIndex", () => {
  it("wraps arrow navigation in both directions and handles empty results", () => {
    expect(nextPaletteIndex(0, -1, 3)).toBe(2);
    expect(nextPaletteIndex(2, 1, 3)).toBe(0);
    expect(nextPaletteIndex(0, 1, 3)).toBe(1);
    expect(nextPaletteIndex(0, -1, 0)).toBe(0);
    expect(nextPaletteIndex(0, 1, 0)).toBe(0);
  });
});
