import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

export function threadJumpIndex(command: HardwareKeyboardCommand) {
  return THREAD_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
}

/** `threads` is the list's visible order, so filters and collapsed groups keep their order. */
export function threadJumpTarget(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  command: HardwareKeyboardCommand,
): EnvironmentThreadShell | null {
  const index = threadJumpIndex(command);
  return index < 0 ? null : (threads[index] ?? null);
}

export function useThreadJumpShortcuts(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
) {
  const jumpToThread = useCallback(
    (command: HardwareKeyboardCommand) => {
      const thread = threadJumpTarget(threads, command);
      if (thread !== null) onSelectThread(thread);
      return true;
    },
    [threads, onSelectThread],
  );
  useHardwareKeyboardCommand(THREAD_JUMP_KEYBINDING_COMMANDS, jumpToThread);
}
