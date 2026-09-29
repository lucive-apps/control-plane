import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The desktop app's "Open at login", read from its bridge. Null until read,
 * and always null outside the desktop app or on builds without the bridge
 * method. Schedules run only while Control Plane is open on their host.
 */
export function useOpenAtLogin(): {
  readonly state: DesktopOpenAtLoginState | null;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
} {
  const [state, setState] = useState<DesktopOpenAtLoginState | null>(null);
  useEffect(() => {
    const read = window.desktopBridge?.getOpenAtLogin;
    if (!read) return;
    let cancelled = false;
    read().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {
        if (!cancelled) setState(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const setEnabled = useCallback(async (enabled: boolean) => {
    const write = window.desktopBridge?.setOpenAtLogin;
    if (!write) return;
    try {
      setState(await write(enabled));
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change Open at login",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
  }, []);
  return { state, setEnabled };
}

/** Rendered only by an installed desktop app that can register itself. */
export function OpenAtLoginSetting() {
  const { state, setEnabled } = useOpenAtLogin();
  if (state === null || !state.supported) return null;
  return (
    <SettingsRow
      {...searchableSetting("open-at-login")}
      description={
        state.requiresApproval
          ? "Allow Control Plane in System Settings → General → Login Items to finish turning it on."
          : "Start Control Plane when you log in, so Project schedules on this computer keep running."
      }
      control={
        <Switch
          checked={state.enabled}
          onCheckedChange={(checked) => void setEnabled(checked)}
          aria-label="Open at login"
        />
      }
    />
  );
}
