// Fork-owned. Settings for the Work Louder Creator Micro 2 integration.

import type { CreatorMicroState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function useCreatorMicroState() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.creatorMicro;
  const [state, setState] = useState<CreatorMicroState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const unsubscribe = bridge.onState((next) => {
      if (!cancelled) setState(next);
    });
    bridge.getState().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  const run = useCallback(async (label: string, action: () => Promise<CreatorMicroState>) => {
    try {
      const next = await action();
      setState(next);
      if (next.lastError) {
        toastManager.add({ type: "error", title: `${label} failed`, description: next.lastError });
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `${label} failed`,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
  }, []);
  return { bridge, state, run };
}

function connectionLabel(state: CreatorMicroState): string {
  switch (state.connection) {
    case "disabled":
      return "Off";
    case "searching":
      return "Looking for the pad. Plug it in or wake it.";
    case "connecting":
      return "Connecting…";
    case "connected":
      return state.firmware ? `Connected, firmware ${state.firmware}` : "Connected";
    case "permission-denied":
      return "Needs Input Monitoring permission";
    case "error":
      return "Could not reach the pad";
  }
}

/** Rendered only in a desktop build with the Creator Micro bridge. */
export function CreatorMicroSettings() {
  const { bridge, state, run } = useCreatorMicroState();
  if (!bridge || state === null) return null;
  const busy = state.busy !== null;
  const keysUnbound =
    state.enabled && state.connection === "connected" && state.keymap !== "agent-keys";

  const setEnabled = (enabled: boolean) =>
    void run(enabled ? "Turning on the Creator Micro 2" : "Turning off the Creator Micro 2", () =>
      enabled ? bridge.enable() : bridge.disable(),
    );

  const restore = async () => {
    const confirmed = await requestConfirmDialog(
      "Restore the pad's original configuration?\nThis writes the backup taken before the integration first changed the pad, including the original Cmd+1 to Cmd+6 keys, and turns the integration off.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await run("Restoring the original config", () => bridge.restoreBackup());
  };

  return (
    <SettingsSection id="creator-micro" title="Work Louder Creator Micro 2">
      <SettingsRow
        {...searchableSetting("creator-micro")}
        description={
          <>
            The six top keys glow with the status of the chats on ⌘1 to ⌘6 and open them when
            pressed. Turning this on backs up the pad and rebinds those six keys once; turning it
            off puts ⌘1 to ⌘6 back. The dial, joystick and other keys keep their Work Louder Input
            settings.
          </>
        }
        status={
          state.busy === "enabling"
            ? "Backing up and rebinding the keys…"
            : state.busy === "disabling"
              ? "Restoring ⌘1 to ⌘6…"
              : state.busy === "restoring"
                ? "Restoring the original config…"
                : connectionLabel(state)
        }
        control={
          <Switch
            checked={state.enabled}
            disabled={busy}
            onCheckedChange={(checked) => setEnabled(checked)}
            aria-label="Creator Micro 2 agent keys"
          />
        }
      />
      {state.connection === "permission-denied" ? (
        <SettingsRow
          title="Input Monitoring"
          description="macOS only lets apps with Input Monitoring talk to the pad. Allow Control Plane, then turn the integration off and on."
          control={
            <Button
              size="compact"
              variant="outline"
              onClick={() => void bridge.openPermissionSettings()}
            >
              Open System Settings
            </Button>
          }
        />
      ) : null}
      {keysUnbound ? (
        <SettingsRow
          title="Agent keys are not bound"
          description="Another app changed the six top keys (Work Louder Input?), so they cannot light up. Rebind them with one write to the pad."
          control={
            <Button
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={() => setEnabled(true)}
            >
              Rebind keys
            </Button>
          }
        />
      ) : null}
      {state.enabled && state.otherAppDetected ? (
        <SettingsRow
          title="Another app is lighting the pad"
          description="Codex or Work Louder Input also writes to the keys. Control Plane repaints its six keys shortly after, at most a few times a minute. In Codex, set Codex Micro agent keys to Custom with nothing assigned to stop it."
        />
      ) : null}
      {state.lastError && !busy ? (
        <SettingsRow title="Last problem" description={state.lastError} />
      ) : null}
      <SettingsRow
        title="Restore original device config"
        description={
          state.hasBackup
            ? `Writes back the backup taken before the first change${state.backupDir ? ` (${state.backupDir})` : ""}.`
            : "Available after the integration has been turned on once."
        }
        control={
          <Button
            size="compact"
            variant="outline"
            disabled={busy || !state.hasBackup}
            onClick={() => void restore()}
          >
            Restore
          </Button>
        }
      />
    </SettingsSection>
  );
}
