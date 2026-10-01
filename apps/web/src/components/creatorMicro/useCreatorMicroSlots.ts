// Fork-owned. Feeds the Creator Micro 2 the chats on Cmd+1..Cmd+6 and opens
// the chat behind a pressed agent key.

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useUiStateStore } from "../../uiStateStore";
import { buildCreatorMicroSlots } from "./creatorMicroSlots.logic";

export function useCreatorMicroSlots(
  jumpOrder: readonly EnvironmentThreadShell[],
  navigateToThread: (threadRef: ScopedThreadRef) => unknown,
): void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.creatorMicro;
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const slots = useMemo(
    () => (bridge ? buildCreatorMicroSlots(jumpOrder, lastVisitedAtById) : []),
    [bridge, jumpOrder, lastVisitedAtById],
  );
  // The slot list is rebuilt on every sidebar change; only a real difference
  // crosses IPC (the shell also skips unchanged keys before touching the pad).
  const slotsKey = JSON.stringify(slots);
  useEffect(() => {
    if (!bridge) return;
    void bridge.setSlots(JSON.parse(slotsKey)).catch(() => undefined);
  }, [bridge, slotsKey]);

  const latest = useRef({ jumpOrder, navigateToThread });
  useEffect(() => {
    latest.current = { jumpOrder, navigateToThread };
  }, [jumpOrder, navigateToThread]);
  useEffect(() => {
    if (!bridge) return;
    return bridge.onKeyPress((press) => {
      const { jumpOrder: threads, navigateToThread: navigate } = latest.current;
      // Open what the key showed when pressed; fall back to the slot's chat now.
      const target =
        (press.threadKey === null
          ? undefined
          : threads.find(
              (thread) =>
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                press.threadKey,
            )) ?? (press.threadKey === null ? undefined : threads[press.slot]);
      if (target) navigate(scopeThreadRef(target.environmentId, target.id));
    });
  }, [bridge]);
}
