// Fork-owned. node-hid backend for the Creator Micro 2.
//
// node-hid wraps hidapi as an N-API addon with prebuilt binaries, so it needs
// no Electron rebuild. The vendor collection shares one IOHIDDevice with the
// pad's keyboard collection, and macOS refuses to let anyone seize a keyboard,
// so the handle must be opened non-exclusively; that also lets Work Louder
// Input and Codex keep their own handles. Opening needs Input Monitoring.

import type { CreatorMicroDeviceInfo, CreatorMicroHid } from "./CreatorMicroController.ts";
import {
  CREATOR_MICRO_2_PRODUCT_IDS,
  VENDOR_USAGE,
  VENDOR_USAGE_PAGE,
  WORK_LOUDER_VENDOR_ID,
} from "./CreatorMicroProtocol.ts";
import type { CreatorMicroTransport } from "./CreatorMicroRpc.ts";

type NodeHid = typeof import("node-hid");

let nodeHidPromise: Promise<NodeHid> | null = null;
const loadNodeHid = () => (nodeHidPromise ??= import("node-hid"));

export function makeNodeHidBackend(): CreatorMicroHid {
  return {
    async list() {
      const hid = await loadNodeHid();
      const devices = await hid.devicesAsync();
      // Match the usage pair, not the device: over USB each collection is its
      // own entry, and only the vendor one carries the RPC channel. USB first.
      return devices
        .filter(
          (device) =>
            device.vendorId === WORK_LOUDER_VENDOR_ID &&
            CREATOR_MICRO_2_PRODUCT_IDS.has(device.productId) &&
            device.usagePage === VENDOR_USAGE_PAGE &&
            device.usage === VENDOR_USAGE &&
            typeof device.path === "string",
        )
        .map((device): CreatorMicroDeviceInfo => ({
          path: device.path!,
          productId: device.productId,
          serialNumber: device.serialNumber ?? null,
          product: device.product ?? null,
        }));
    },
    async open(device) {
      const hid = await loadNodeHid();
      const handle = await hid.HIDAsync.open(device.path, { nonExclusive: true });
      return makeTransport(handle);
    },
  };
}

function makeTransport(handle: import("node-hid").HIDAsync): CreatorMicroTransport {
  const errorListeners: Array<(error: Error) => void> = [];
  let closed = false;
  const fail = (cause: unknown) => {
    if (closed) return;
    closed = true;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const listener of errorListeners) listener(error);
    void handle.close().catch(() => undefined);
  };
  handle.on("error", fail);
  return {
    write(report) {
      if (closed) throw new Error("device handle is closed");
      // Reports of one message are queued in order on the handle's worker.
      handle.write(report).catch(fail);
    },
    onData(listener) {
      handle.on("data", (data: Buffer) => listener(new Uint8Array(data)));
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      handle.removeAllListeners();
      void handle.close().catch(() => undefined);
    },
  };
}
