import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { describe, expect, it } from "vite-plus/test";

import { buildCreatorMicroSlots, creatorMicroJumpOrder } from "./creatorMicroSlots.logic";

type Session = { status: "idle" | "starting" | "running" | "ready" | "error" };

function thread(
  id: string,
  options: {
    session?: Session["status"];
    approval?: boolean;
    input?: boolean;
    completedAt?: string;
    pinOrderKey?: string;
  } = {},
) {
  return {
    environmentId: "env",
    id,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinOrderKey: options.pinOrderKey ?? null,
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: options.input ?? false,
    backgroundLiveness: null,
    session: options.session ? { status: options.session } : null,
    latestTurn: options.completedAt ? { completedAt: options.completedAt } : null,
  } as unknown as Parameters<typeof buildCreatorMicroSlots>[0][number] & {
    pinOrderKey: string | null;
    createdAt: string;
  };
}

const keys = (slots: ReturnType<typeof buildCreatorMicroSlots>) =>
  slots.map((slot) => slot?.threadKey ?? null);

describe("buildCreatorMicroSlots", () => {
  it("maps the first six chats of the Cmd+N order to slots 0..5", () => {
    const order = ["a", "b", "c", "d", "e", "f", "g"].map((id) => thread(id));
    const slots = buildCreatorMicroSlots(order, {});
    expect(slots).toHaveLength(6);
    expect(keys(slots)).toEqual(["env:a", "env:b", "env:c", "env:d", "env:e", "env:f"]);
  });

  it("leaves missing slots empty", () => {
    expect(keys(buildCreatorMicroSlots([thread("a"), thread("b")], {}))).toEqual([
      "env:a",
      "env:b",
      null,
      null,
      null,
      null,
    ]);
    expect(keys(buildCreatorMicroSlots([], {}))).toEqual([null, null, null, null, null, null]);
  });

  it("uses the sidebar row status for each chat", () => {
    const slots = buildCreatorMicroSlots(
      [
        thread("working", { session: "running" }),
        thread("approval", { approval: true, session: "running" }),
        thread("input", { input: true }),
        thread("failed", { session: "error" }),
        thread("unread", { session: "ready", completedAt: "2026-10-01T10:00:00.000Z" }),
        thread("idle", { session: "ready", completedAt: "2026-10-01T09:00:00.000Z" }),
      ],
      {
        "env:unread": "2026-10-01T09:30:00.000Z",
        "env:idle": "2026-10-01T09:30:00.000Z",
      },
    );
    expect(slots.map((slot) => slot?.status)).toEqual([
      "working",
      "approval",
      "input",
      "failed",
      "unread",
      "ready",
    ]);
  });

  it("matches the sidebar's Done rule: only a completion after the last visit is unread", () => {
    const done = { session: "ready" as const, completedAt: "2026-10-01T10:00:00.000Z" };
    const status = (lastVisitedAt?: string) =>
      buildCreatorMicroSlots(
        [thread("b", done)],
        lastVisitedAt === undefined ? {} : { "env:b": lastVisitedAt },
      )[0]?.status;
    // A chat whose first turn finishes before it was ever read reads as idle,
    // exactly like its sidebar row (never visited counts as read).
    expect(status()).toBe("ready");
    // Read at an earlier completion, then finished again while away: Done.
    expect(status("2026-10-01T09:00:00.000Z")).toBe("unread");
    // Open (stamped at this completion): read again.
    expect(status("2026-10-01T10:00:00.000Z")).toBe("ready");
  });

  it("follows pin reorders, new pins at the top, and unpins", () => {
    const a = thread("a", { pinOrderKey: "a0" });
    const b = thread("b", { pinOrderKey: "a1" });
    const c = thread("c", { pinOrderKey: "a2" });
    const pinned = (threads: ReturnType<typeof thread>[]) =>
      keys(buildCreatorMicroSlots(sortPinnedThreadsByOrderKey(threads), {})).slice(0, 3);

    expect(pinned([a, b, c])).toEqual(["env:a", "env:b", "env:c"]);
    // Drag c above a.
    expect(pinned([a, b, { ...c, pinOrderKey: "Zz" }])).toEqual(["env:c", "env:a", "env:b"]);
    // A new pin lands at the top.
    expect(pinned([a, b, c, thread("d", { pinOrderKey: "Z0" })])).toEqual([
      "env:d",
      "env:a",
      "env:b",
    ]);
    // Unpin b: everything below moves up a key.
    expect(pinned([a, c])).toEqual(["env:a", "env:c", null]);
  });
});

describe("creatorMicroJumpOrder", () => {
  it("puts Project threads before task folders, like Cmd+N", () => {
    expect(creatorMicroJumpOrder({ assistantThreads: [1, 2], folderThreads: [3] })).toEqual([
      1, 2, 3,
    ]);
    expect(creatorMicroJumpOrder({ assistantThreads: [], folderThreads: [3] })).toEqual([3]);
  });
});
