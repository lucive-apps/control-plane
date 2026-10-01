// Fork-owned. An in-memory Creator Micro 2 for tests: it decodes the real wire
// format, answers like firmware 0.6.2 (including `{"ok":1}` for any lighting
// payload), keeps files with SHA-1 checksums, and can unplug, refuse access,
// corrupt writes, push key presses or answer another app's calls.

import * as NodeCrypto from "node:crypto";

import type { CreatorMicroDeviceInfo, CreatorMicroHid } from "../CreatorMicroController.ts";
import type { CreatorMicroTransport } from "../CreatorMicroRpc.ts";

const sha1 = (text: string) => NodeCrypto.createHash("sha1").update(text, "utf8").digest("hex");

function toReports(message: unknown): Uint8Array[] {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const reports: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += 61) {
    const length = Math.min(61, payload.length - offset);
    const report = Buffer.alloc(64);
    report[0] = 0x06;
    report[1] = 2;
    report[2] = length;
    payload.copy(report, 3, offset, offset + length);
    reports.push(new Uint8Array(report));
  }
  return reports;
}

export interface FakeCall {
  readonly method: string;
  readonly params: unknown;
}

export class FakeCreatorMicro implements CreatorMicroHid {
  readonly info: CreatorMicroDeviceInfo = {
    path: "DevSrvsID:1",
    productId: 0x8298,
    serialNumber: "TEST",
    product: "Creator Micro 2",
  };
  files = new Map<string, string>();
  attached = true;
  permissionDenied = false;
  /** Replace what `fs.write` stores, to simulate a write the device mangles. */
  corruptWrite: ((data: string) => string) | null = null;
  calls: FakeCall[] = [];
  /** Last lighting state per key id, from `v.oai.thstatus`. */
  keyLights = new Map<number, Record<string, unknown>>();
  openCount = 0;
  private handles: FakeHandle[] = [];

  constructor(keymap: string, smartActions = '{"version":1,"smartActions":{}}') {
    this.files.set("keymap.json", keymap);
    this.files.set("smart_actions.json", smartActions);
  }

  get flashWrites(): FakeCall[] {
    return this.calls.filter((call) => call.method === "fs.write");
  }

  get lightingCalls(): FakeCall[] {
    return this.calls.filter((call) => call.method === "v.oai.thstatus");
  }

  async list(): Promise<ReadonlyArray<CreatorMicroDeviceInfo>> {
    return this.attached ? [this.info] : [];
  }

  async open(device: CreatorMicroDeviceInfo): Promise<CreatorMicroTransport> {
    if (this.permissionDenied) {
      throw new Error(
        `cannot open device with path ${device.path}: (0xE00002E2) (iokit/common) not permitted`,
      );
    }
    if (!this.attached) throw new Error("device not found");
    this.openCount += 1;
    const handle = new FakeHandle(this);
    this.handles.push(handle);
    return handle;
  }

  unplug(): void {
    this.attached = false;
    for (const handle of this.handles) handle.fail(new Error("device disconnected"));
    this.handles = [];
  }

  plugIn(): void {
    this.attached = true;
  }

  pressKey(index: number, act: 0 | 1 = 1): void {
    this.broadcast({ m: "v.oai.hid", p: { k: `AG${String(index).padStart(2, "0")}`, act, ag: 0 } });
  }

  /** Another app's lighting call, whose reply every shared handle sees. */
  foreignLightingWrite(): void {
    for (let id = 0; id < 6; id++) this.keyLights.set(id, { id, b: 0, e: 0 });
    this.broadcast({ result: { ok: 1 }, id: 999, method: "v.oai.thstatus" });
  }

  get openHandles(): number {
    return this.handles.filter((handle) => !handle.closed).length;
  }

  private broadcast(message: unknown): void {
    for (const handle of this.handles) if (!handle.closed) handle.emit(message);
  }

  /** Firmware behaviour for one request. */
  answer(method: string, params: unknown): unknown {
    switch (method) {
      case "sys.version":
        return { version: "0.6.2" };
      case "device.status":
        return { version: "0.6.2", profile_index: 0, layer_index: 1 };
      case "fs.list":
        return [...this.files].map(([name, text]) => ({
          name,
          size: Buffer.byteLength(text),
          checksum: sha1(text),
        }));
      case "fs.read": {
        const file = (params as { file: string }).file;
        const text = this.files.get(file);
        return text === undefined ? null : { data: text };
      }
      case "fs.write": {
        const { file, data } = params as { file: string; data: string };
        this.files.set(file, this.corruptWrite ? this.corruptWrite(data) : data);
        return { ok: 1 };
      }
      case "v.oai.thstatus":
        for (const entry of params as Array<Record<string, unknown>>) {
          this.keyLights.set(entry.id as number, entry);
        }
        return { ok: 1 };
      default:
        return { ok: 1 };
    }
  }
}

class FakeHandle implements CreatorMicroTransport {
  closed = false;
  private dataListeners: Array<(report: Uint8Array) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private text = "";
  private readonly device: FakeCreatorMicro;

  constructor(device: FakeCreatorMicro) {
    this.device = device;
  }

  write(report: number[]): void {
    if (this.closed) throw new Error("write on closed handle");
    if (!this.device.attached) throw new Error("could not write: device disconnected");
    const length = report[2]!;
    this.text += Buffer.from(report.slice(3, 3 + length)).toString("utf8");
    let request: { method: string; params: unknown; id: number };
    try {
      request = JSON.parse(this.text);
    } catch {
      return;
    }
    this.text = "";
    this.device.calls.push({ method: request.method, params: request.params });
    const result = this.device.answer(request.method, request.params);
    queueMicrotask(() => this.emit({ result, id: request.id, method: request.method }));
  }

  emit(message: unknown): void {
    if (this.closed) return;
    for (const report of toReports(message)) {
      for (const listener of this.dataListeners) listener(report);
    }
  }

  fail(error: Error): void {
    if (this.closed) return;
    for (const listener of this.errorListeners) listener(error);
    this.closed = true;
  }

  onData(listener: (report: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  close(): void {
    this.closed = true;
  }
}

/** A Creator Micro 2 keymap shaped like Work Louder Input writes it. */
export function makeKeymap(topSix: ReadonlyArray<string>): string {
  return JSON.stringify({
    version: 1,
    activeProfileId: 0,
    language: "us",
    profiles: [
      {
        id: 0,
        name: "Default",
        layers: [
          {
            id: 0,
            name: "Layer",
            color: 16711680,
            layout: {
              keymap: [
                [topSix[0], topSix[1]],
                [topSix[2], topSix[3], topSix[4], topSix[5]],
                ["KA_A7", "KA_A8", "KA_A9", "KA_A6"],
                ["KC_ESC", "KC_ENT", "KA_A10"],
              ],
              encoders: [["KA_A11", "KA_A12", "KC_NONE"]],
              joystick: {
                type: "RADIAL",
                sectors: [
                  { k: "KI_X", a1: 0.1875, a2: 0.3125 },
                  { k: "SA_2", a1: 0.3125, a2: 0.6041666666666667 },
                  { k: "SA_1", a1: 0.6041666666666667, a2: 0.8958333333333335 },
                  { k: "SA_3", a1: 0.8958333333333334, a2: 0.1875 },
                ],
              },
            },
            lights: {
              backlight: { effect: "solid", brightness: 1, speed: 0.5, magic: 1, color: 16777215 },
              underglow: {
                effect: "gradient",
                brightness: 1,
                speed: 0.55,
                magic: 1,
                color: 16777215,
              },
            },
          },
        ],
        macrosUsed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        multiActionsUsed: [],
      },
    ],
    multiActions: [],
    macros: Array.from({ length: 6 }, (_, id) => ({
      id,
      name: `Cmd ${id + 1}`,
      color: null,
      actions: [
        { kc: "KC_LGUI", delay: 0, act: 1 },
        { kc: `KC_${id + 1}`, delay: 0, act: 2 },
        { kc: "KC_LGUI", delay: 0, act: 0 },
      ],
    })),
    macrosGroups: [],
    multiActionsGroups: [],
    linkedApps: [],
  });
}

export const ORIGINAL_TOP_SIX = ["KA_A0", "KA_A1", "KA_A2", "KA_A3", "KA_A4", "KA_A5"];
