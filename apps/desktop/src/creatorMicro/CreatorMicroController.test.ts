// @effect-diagnostics globalTimers:off globalDate:off -- These tests drive the controller with real short timers.
import type { CreatorMicroSlot, CreatorMicroState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CreatorMicroController,
  DEFAULT_PERSISTED,
  type CreatorMicroPersisted,
} from "./CreatorMicroController.ts";
import { AGENT_KEYCODES, analyzeKeymap, bindAgentKeys } from "./CreatorMicroKeymap.ts";
import { FakeCreatorMicro, makeKeymap, ORIGINAL_TOP_SIX } from "./testing/FakeCreatorMicro.ts";

const original = makeKeymap(ORIGINAL_TOP_SIX);

async function waitFor(condition: () => boolean, ms = 1_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function setup(options: { keymap?: string; persisted?: CreatorMicroPersisted } = {}) {
  const device = new FakeCreatorMicro(options.keymap ?? original);
  let persisted = options.persisted ?? DEFAULT_PERSISTED;
  const backups: Array<{ dir: string; keymap: string; reason: string }> = [];
  const presses: Array<[number, string | null]> = [];
  const states: CreatorMicroState[] = [];
  const controller = new CreatorMicroController({
    hid: device,
    loadPersisted: async () => persisted,
    savePersisted: async (next) => {
      persisted = next;
    },
    writeBackup: async (files) => {
      const dir = `/backups/${backups.length}`;
      backups.push({ dir, keymap: files.keymap, reason: files.reason });
      return { dir, createdAt: "2026-10-01T00:00:00.000Z" };
    },
    readBackupKeymap: async (dir) => backups.find((backup) => backup.dir === dir)!.keymap,
    onStateChanged: (state) => states.push(state),
    onKeyPressed: (slot, threadKey) => presses.push([slot, threadKey]),
    pollIntervalMs: 20,
    lightingOptions: { coalesceMs: 5, repaintDelayMs: 10, retryMs: 50 },
  });
  return {
    device,
    controller,
    backups,
    presses,
    states,
    persisted: () => persisted,
  };
}

const slot = (threadKey: string, status: CreatorMicroSlot["status"]): CreatorMicroSlot => ({
  threadKey,
  status,
});

describe("CreatorMicroController enable", () => {
  it("backs up, writes the six agent keys once, verifies and starts lighting", async () => {
    const { device, controller, backups, persisted } = setup();
    await controller.start();
    expect(device.openCount).toBe(0);

    const state = await controller.enable();
    expect(state).toMatchObject({
      enabled: true,
      connection: "connected",
      keymap: "agent-keys",
      lastError: null,
      flashWritesThisSession: 1,
    });
    expect(backups).toHaveLength(1);
    expect(backups[0]!.keymap).toBe(original);
    expect(device.flashWrites).toHaveLength(1);
    expect(device.files.get("keymap.json")).toBe(bindAgentKeys(original));
    expect(persisted()).toMatchObject({
      enabled: true,
      originalSlotKeycodes: ORIGINAL_TOP_SIX,
      backupDir: "/backups/0",
    });
    // The backup was taken before the write.
    const writeIndex = device.calls.findIndex((call) => call.method === "fs.write");
    const lastReadBefore = device.calls.slice(0, writeIndex).map((call) => call.method);
    expect(lastReadBefore).toContain("fs.list");

    controller.setSlots([slot("env:a", "working")]);
    await waitFor(() => device.keyLights.get(0)?.c === 0x0ea5e9);
    expect(device.keyLights.get(0)).toMatchObject({ e: 4, b: 1 });
    expect(device.keyLights.get(1)).toMatchObject({ e: 0, b: 0 });
    await controller.stop();
  });

  it("does not write when the keys are already bound", async () => {
    const { device, controller } = setup({ keymap: bindAgentKeys(original) });
    await controller.start();
    const state = await controller.enable();
    expect(state.keymap).toBe("agent-keys");
    expect(device.flashWrites).toHaveLength(0);
    await controller.stop();
  });

  it("aborts and writes the previous file back when the readback does not match", async () => {
    const { device, controller, persisted } = setup();
    await controller.start();
    device.corruptWrite = (data) => data.replace('"KC_ESC"', '"KC_NONE"');
    const state = await controller.enable();
    expect(state.enabled).toBe(false);
    expect(state.lastError).toMatch(/Keymap change aborted/);
    expect(state.lastError).toMatch(/unexpected change/);
    // The revert writes the exact previous text.
    expect(device.flashWrites).toHaveLength(2);
    expect((device.flashWrites[1]!.params as { data: string }).data).toBe(original);
    expect(persisted().enabled).toBe(false);
    expect(device.openHandles).toBe(0);
    await controller.stop();
  });

  it("refuses a half-bound layout without writing", async () => {
    const mixed = makeKeymap(["KV_OAI_AG00", ...ORIGINAL_TOP_SIX.slice(1)]);
    const { device, controller } = setup({ keymap: mixed });
    await controller.start();
    const state = await controller.enable();
    expect(state.enabled).toBe(false);
    expect(state.lastError).toMatch(/Some of the six top keys/);
    expect(device.flashWrites).toHaveLength(0);
    await controller.stop();
  });

  it("reports missing Input Monitoring permission", async () => {
    const { device, controller } = setup();
    device.permissionDenied = true;
    let requests = 0;
    device.requestInputMonitoring = async () => {
      requests += 1;
    };
    await controller.start();
    const state = await controller.enable();
    expect(state.enabled).toBe(false);
    expect(state.connection).toBe("permission-denied");
    expect(state.lastError).toMatch(/Input Monitoring/);
    await controller.enable();
    expect(requests).toBe(1);
    expect(device.flashWrites).toHaveLength(0);
    await controller.stop();
  });

  it("fails cleanly when no pad is attached", async () => {
    const { device, controller } = setup();
    device.attached = false;
    await controller.start();
    const state = await controller.enable();
    expect(state).toMatchObject({ enabled: false, connection: "disabled" });
    expect(state.lastError).toMatch(/not connected/);
  });
});

describe("CreatorMicroController disable and restore", () => {
  it("disable turns the keys off and puts Cmd+1..Cmd+6 back, verified", async () => {
    const { device, controller, persisted } = setup();
    await controller.start();
    await controller.enable();
    controller.setSlots([slot("env:a", "unread")]);
    await waitFor(() => device.keyLights.get(0)?.c === 0x10b981);

    const state = await controller.disable();
    expect(state).toMatchObject({ enabled: false, connection: "disabled", lastError: null });
    expect(device.files.get("keymap.json")).toBe(original);
    expect(device.flashWrites).toHaveLength(2);
    expect(device.keyLights.get(0)).toMatchObject({ e: 0, b: 0 });
    expect(persisted().enabled).toBe(false);
    expect(device.openHandles).toBe(0);
  });

  it("restore writes the backed-up file back byte for byte", async () => {
    const { device, controller } = setup();
    await controller.start();
    await controller.enable();
    const state = await controller.restoreBackup();
    expect(state).toMatchObject({ enabled: false, keymap: "original", lastError: null });
    expect(device.files.get("keymap.json")).toBe(original);
  });

  it("disable while unplugged keeps the error visible and writes nothing", async () => {
    const { device, controller } = setup();
    await controller.start();
    await controller.enable();
    device.unplug();
    const state = await controller.disable();
    expect(state.enabled).toBe(false);
    expect(state.lastError).toMatch(/not connected/);
    expect(device.flashWrites).toHaveLength(1);
  });
});

describe("CreatorMicroController connection", () => {
  it("reconnects after an unplug, repaints, and never writes flash on its own", async () => {
    const { device, controller } = setup({
      keymap: bindAgentKeys(original),
      persisted: { enabled: true, originalSlotKeycodes: ORIGINAL_TOP_SIX, backupDir: "/b" },
    });
    await controller.start();
    controller.setSlots([slot("env:a", "approval"), slot("env:b", "input")]);
    await waitFor(() => device.keyLights.get(1)?.c === 0x6366f1);

    device.unplug();
    await waitFor(() => controller.getState().connection === "searching");
    device.keyLights.clear();
    device.plugIn();
    await waitFor(() => controller.getState().connection === "connected");
    await waitFor(() => device.keyLights.get(0)?.c === 0xf59e0b);
    expect(device.openCount).toBe(2);
    expect(device.flashWrites).toHaveLength(0);
    await controller.stop();
  });

  it("starts with the pad absent and connects when it appears", async () => {
    const { device, controller } = setup({
      keymap: bindAgentKeys(original),
      persisted: { enabled: true, originalSlotKeycodes: ORIGINAL_TOP_SIX, backupDir: "/b" },
    });
    device.attached = false;
    await controller.start();
    expect(controller.getState().connection).toBe("searching");
    device.plugIn();
    await waitFor(() => controller.getState().connection === "connected");
    await controller.stop();
  });

  it("does not light keys another app unbound, and does not rebind them by itself", async () => {
    const { device, controller } = setup({
      keymap: original,
      persisted: { enabled: true, originalSlotKeycodes: ORIGINAL_TOP_SIX, backupDir: "/b" },
    });
    await controller.start();
    controller.setSlots([slot("env:a", "working")]);
    await settle();
    expect(controller.getState()).toMatchObject({ connection: "connected", keymap: "original" });
    expect(device.lightingCalls).toHaveLength(0);
    expect(device.flashWrites).toHaveLength(0);
    await controller.stop();
  });

  it("shutdown turns the keys off, closes the handle, and leaves the keymap alone", async () => {
    const { device, controller } = setup({
      keymap: bindAgentKeys(original),
      persisted: { enabled: true, originalSlotKeycodes: ORIGINAL_TOP_SIX, backupDir: "/b" },
    });
    await controller.start();
    controller.setSlots([slot("env:a", "failed")]);
    await waitFor(() => device.keyLights.get(0)?.c === 0xef4444);
    await controller.stop();
    expect(device.keyLights.get(0)).toMatchObject({ e: 0, b: 0 });
    expect(device.openHandles).toBe(0);
    expect(analyzeKeymap(device.files.get("keymap.json")!).slotKeycodes).toEqual(AGENT_KEYCODES);
    expect(device.flashWrites).toHaveLength(0);
  });
});

describe("CreatorMicroController keys and lighting", () => {
  const enabledSetup = () =>
    setup({
      keymap: bindAgentKeys(original),
      persisted: { enabled: true, originalSlotKeycodes: ORIGINAL_TOP_SIX, backupDir: "/b" },
    });

  it("routes a key press to its slot's chat, including empty slots", async () => {
    const { device, controller, presses } = enabledSetup();
    await controller.start();
    controller.setSlots([slot("env:a", "ready"), null, slot("env:c", "working")]);
    device.pressKey(2);
    device.pressKey(2, 0);
    device.pressKey(1);
    device.pressKey(9);
    await waitFor(() => presses.length === 2);
    await settle();
    expect(presses).toEqual([
      [2, "env:c"],
      [1, null],
    ]);
    await controller.stop();
  });

  it("follows reorders, pins and unpins with one small write each", async () => {
    const { device, controller } = enabledSetup();
    await controller.start();
    controller.setSlots([slot("env:a", "working"), slot("env:b", "ready")]);
    await waitFor(() => device.keyLights.get(1)?.b === 0.12);
    const before = device.lightingCalls.length;

    // Reorder: a and b swap keys.
    controller.setSlots([slot("env:b", "ready"), slot("env:a", "working")]);
    await waitFor(() => device.lightingCalls.length === before + 1);
    expect((device.lightingCalls.at(-1)!.params as unknown[]).length).toBe(2);

    // Same statuses again: nothing to send.
    controller.setSlots([slot("env:b", "ready"), slot("env:a", "working")]);
    await settle();
    expect(device.lightingCalls.length).toBe(before + 1);

    // Unpin b: slot 0 empties and goes dark.
    controller.setSlots([null, slot("env:a", "working")]);
    await waitFor(() => device.keyLights.get(0)?.e === 0);
    expect(device.lightingCalls.length).toBe(before + 2);
    await controller.stop();
  });

  it("repaints after Codex overwrites the keys, and notes the other app", async () => {
    const { device, controller } = enabledSetup();
    await controller.start();
    controller.setSlots([slot("env:a", "approval")]);
    await waitFor(() => device.keyLights.get(0)?.c === 0xf59e0b);
    device.foreignLightingWrite();
    expect(device.keyLights.get(0)).toMatchObject({ b: 0 });
    await waitFor(() => device.keyLights.get(0)?.c === 0xf59e0b);
    expect(controller.getState().otherAppDetected).toBe(true);
    expect(device.flashWrites).toHaveLength(0);
    await controller.stop();
  });
});
