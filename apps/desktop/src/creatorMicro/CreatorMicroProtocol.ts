// Fork-owned. Wire format of the Work Louder Creator Micro 2 vendor channel.
//
// The pad speaks JSON-RPC over 64-byte raw HID reports on its vendor
// collection (usage page 0xFF00, usage 1):
//
//   byte 0   report id, always 0x06
//   byte 1   channel: 1 = firmware debug log, 2 = JSON-RPC
//   byte 2   payload length in this report, at most 61
//   bytes 3+ UTF-8 fragment of a JSON message
//
// Messages longer than 61 bytes span several reports with no sequence number
// or end marker, so the reader reassembles by scanning for balanced top-level
// braces. Responses carry `method`/`params`/`id`; device-pushed notifications
// use the short envelope `{m, p}` with no id.

export const WORK_LOUDER_VENDOR_ID = 0x303a;
/** Creator Micro 2 product ids (USB and Bluetooth variants). */
export const CREATOR_MICRO_2_PRODUCT_IDS: ReadonlySet<number> = new Set([0x8297, 0x8298]);
export const VENDOR_USAGE_PAGE = 0xff00;
export const VENDOR_USAGE = 1;

const REPORT_ID = 0x06;
const CHANNEL_DEBUG = 1;
const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const CHUNK = 61;
/** Unfinished input past this size is garbage; drop it rather than grow forever. */
const MAX_PENDING_TEXT = 64 * 1024;
/** The firmware rejects call ids of 1000 and above. */
export const MAX_CALL_ID = 999;

export interface RpcRequest {
  readonly method: string;
  readonly params: unknown;
  readonly id: number;
}

export type DeviceMessage =
  | {
      readonly kind: "response";
      readonly id: number;
      readonly method: string | null;
      readonly result: unknown;
      readonly error: { readonly message: string } | null;
    }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown };

/** Splits one request into the output reports that carry it. */
export function encodeRequest(request: RpcRequest): number[][] {
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  const reports: number[][] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const length = Math.min(CHUNK, payload.length - offset);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CHANNEL_RPC;
    report[2] = length;
    payload.copy(report, 3, offset, offset + length);
    reports.push(Array.from(report));
  }
  return reports;
}

function toMessage(value: unknown): DeviceMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.m === "string" && record.id === undefined) {
    return { kind: "notification", method: record.m, params: record.p };
  }
  if (typeof record.id === "number") {
    const error =
      typeof record.error === "object" && record.error !== null
        ? { message: String((record.error as { message?: unknown }).message ?? "rpc error") }
        : null;
    return {
      kind: "response",
      id: record.id,
      method: typeof record.method === "string" ? record.method : null,
      result: record.result,
      error,
    };
  }
  if (typeof record.method === "string") {
    return { kind: "notification", method: record.method, params: record.params };
  }
  return null;
}

/**
 * Reassembles the device's input reports into JSON messages. Debug-channel
 * reports are ignored. node-hid may or may not keep the report id as byte 0,
 * so both offsets are tried.
 */
export class DeviceMessageDecoder {
  private text = "";

  push(report: Uint8Array): DeviceMessage[] {
    for (const offset of [1, 0]) {
      const channel = report[offset];
      const length = report[offset + 1];
      if (channel !== CHANNEL_DEBUG && channel !== CHANNEL_RPC) continue;
      if (length === undefined || length > CHUNK) continue;
      if (channel === CHANNEL_DEBUG) return [];
      this.text += Buffer.from(report.subarray(offset + 2, offset + 2 + length)).toString("utf8");
      return this.drain();
    }
    return [];
  }

  private drain(): DeviceMessage[] {
    const messages: DeviceMessage[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    let consumed = 0;
    for (let index = 0; index < this.text.length; index++) {
      const char = this.text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        if (depth > 0) inString = true;
      } else if (char === "{") {
        if (depth++ === 0) start = index;
      } else if (char === "}" && depth > 0 && --depth === 0) {
        try {
          const message = toMessage(JSON.parse(this.text.slice(start, index + 1)));
          if (message) messages.push(message);
        } catch {
          // A torn or malformed message: skip it and keep reading.
        }
        consumed = index + 1;
      }
    }
    this.text = depth === 0 ? "" : this.text.slice(Math.max(consumed, start));
    if (this.text.length > MAX_PENDING_TEXT) this.text = "";
    return messages;
  }
}

/** Key press notification: `{m:"v.oai.hid", p:{k:"AG03", act:1}}`. */
export interface AgentKeyEvent {
  readonly keyIndex: number;
  readonly pressed: boolean;
}

export const NOTIFY_HID = "v.oai.hid";

export function parseAgentKeyEvent(method: string, params: unknown): AgentKeyEvent | null {
  if (method !== NOTIFY_HID || typeof params !== "object" || params === null) return null;
  const { k, act } = params as { k?: unknown; act?: unknown };
  if (typeof k !== "string") return null;
  const match = /^AG(\d{2})$/.exec(k);
  if (!match) return null;
  if (act !== 0 && act !== 1) return null;
  return { keyIndex: Number(match[1]), pressed: act === 1 };
}
