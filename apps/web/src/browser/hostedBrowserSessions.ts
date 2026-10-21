import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadPreviewState } from "~/previewStateStore";

import { previewRuntimeTabId } from "./previewRuntimeTabId";

export interface HostedBrowserSession {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
  readonly runtimeTabId: string;
  readonly pictureInPicture: boolean;
  readonly zoomFactor: number;
}

/**
 * Every live preview tab, in a fixed render order. Electron destroys a
 * webview's guest when its element moves in the DOM, so following the server's
 * list order (which changes as tabs update) would blank tabs and drop their
 * debugger sessions mid-automation. Any stable order works; this is not a
 * display order.
 */
export function hostedBrowserSessions(
  previewByThreadKey: Readonly<Record<string, ThreadPreviewState>>,
): HostedBrowserSession[] {
  return Object.entries(previewByThreadKey)
    .flatMap(([threadKey, previewState]) => {
      const threadRef = parseScopedThreadKey(threadKey);
      return threadRef
        ? Object.values(previewState.sessions).map((snapshot) => ({
            threadRef,
            snapshot,
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
        : [];
    })
    .toSorted((left, right) =>
      left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
    );
}
