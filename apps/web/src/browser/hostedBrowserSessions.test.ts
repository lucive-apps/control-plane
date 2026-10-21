import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { __testing, type ThreadPreviewState } from "~/previewStateStore";

import { hostedBrowserSessions } from "./hostedBrowserSessions";

const threadA = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-a" as ScopedThreadRef["threadId"],
};
const threadB = { ...threadA, threadId: "thread-b" as ScopedThreadRef["threadId"] };

const snapshot = (
  threadRef: ScopedThreadRef,
  tabId: string,
  updatedAt: string,
): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `http://localhost:3000/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

const threadState = (sessions: PreviewSessionSnapshot[]): ThreadPreviewState => ({
  ...__testing.EMPTY_THREAD_PREVIEW_STATE,
  sessions: Object.fromEntries(sessions.map((session) => [session.tabId, session])),
  serverEpoch: "epoch-1",
});

describe("hostedBrowserSessions", () => {
  it("keeps webview order fixed when the server reorders tabs and threads", () => {
    const first = hostedBrowserSessions({
      [scopedThreadKey(threadA)]: threadState([
        snapshot(threadA, "tab-1", "2026-10-21T10:00:00.000Z"),
        snapshot(threadA, "tab-2", "2026-10-21T10:00:01.000Z"),
      ]),
      [scopedThreadKey(threadB)]: threadState([
        snapshot(threadB, "tab-3", "2026-10-21T10:00:02.000Z"),
      ]),
    });
    // A newer update moves tab-1 to the end of the server list and thread B first.
    const reordered = hostedBrowserSessions({
      [scopedThreadKey(threadB)]: threadState([
        snapshot(threadB, "tab-3", "2026-10-21T10:00:02.000Z"),
      ]),
      [scopedThreadKey(threadA)]: threadState([
        snapshot(threadA, "tab-2", "2026-10-21T10:00:01.000Z"),
        snapshot(threadA, "tab-1", "2026-10-21T10:00:05.000Z"),
      ]),
    });

    expect(reordered.map((session) => session.runtimeTabId)).toEqual(
      first.map((session) => session.runtimeTabId),
    );
    expect(first.map((session) => session.snapshot.tabId)).toHaveLength(3);
  });

  it("adding a tab does not move the tabs already rendered before it", () => {
    const before = hostedBrowserSessions({
      [scopedThreadKey(threadA)]: threadState([
        snapshot(threadA, "tab-1", "2026-10-21T10:00:00.000Z"),
      ]),
    });
    const after = hostedBrowserSessions({
      [scopedThreadKey(threadA)]: threadState([
        snapshot(threadA, "tab-9", "2026-10-21T10:00:09.000Z"),
        snapshot(threadA, "tab-1", "2026-10-21T10:00:00.000Z"),
      ]),
    });
    const kept = after.filter((session) =>
      before.some((existing) => existing.runtimeTabId === session.runtimeTabId),
    );
    expect(kept.map((session) => session.runtimeTabId)).toEqual(
      before.map((session) => session.runtimeTabId),
    );
  });
});
