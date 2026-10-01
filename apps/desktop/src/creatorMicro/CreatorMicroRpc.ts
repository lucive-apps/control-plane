// @effect-diagnostics globalTimers:off globalRandom:off -- Call deadlines and the random starting call id live at the HID callback boundary, outside any Effect fiber.
// Fork-owned. JSON-RPC calls to the Creator Micro 2 over a shared HID handle.
//
// The vendor interface is opened shared, because Work Louder Input and the
// Codex app hold it too. Shared means this client also sees the replies to
// their calls; a reply whose id this client never issued (or whose method does
// not match) is someone else's, and is reported as foreign traffic so the
// lighting can be repainted after another app overwrites it.

import {
  DeviceMessageDecoder,
  type DeviceMessage,
  encodeRequest,
  MAX_CALL_ID,
} from "./CreatorMicroProtocol.ts";

/** One open HID handle on the vendor collection. */
export interface CreatorMicroTransport {
  write(report: number[]): void;
  onData(listener: (report: Uint8Array) => void): void;
  onError(listener: (error: Error) => void): void;
  close(): void;
}

export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly kind: "timeout" | "device" | "transport" | "closed";

  constructor(message: string, kind: RpcError["kind"]) {
    super(message);
    this.kind = kind;
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: RpcError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RpcClientOptions {
  readonly timeoutMs?: number;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** A reply to a call another app made on the same device. */
  readonly onForeignResponse?: (method: string | null) => void;
  /** The handle failed; the client is closed after this. */
  readonly onTransportError?: (error: Error) => void;
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class CreatorMicroRpcClient {
  private readonly decoder = new DeviceMessageDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1 + Math.floor(Math.random() * MAX_CALL_ID);
  private closed = false;
  private readonly timeoutMs: number;
  private readonly setTimer: NonNullable<RpcClientOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<RpcClientOptions["clearTimer"]>;

  private readonly transport: CreatorMicroTransport;
  private readonly options: RpcClientOptions;

  constructor(transport: CreatorMicroTransport, options: RpcClientOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    transport.onData((report) => {
      for (const message of this.decoder.push(report)) this.dispatch(message);
    });
    transport.onError((error) => {
      this.fail(new RpcError(error.message, "transport"));
      options.onTransportError?.(error);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call(method: string, params: unknown = null, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError("device handle is closed", "closed"));
    const id = this.allocateId();
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (this.pending.delete(id))
          reject(new RpcError(`timed out waiting for ${method}`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        for (const report of encodeRequest({ method, params, id })) this.transport.write(report);
      } catch (cause) {
        this.pending.delete(id);
        this.clearTimer(timer);
        const error = cause instanceof Error ? cause : new Error(String(cause));
        reject(new RpcError(error.message, "transport"));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.fail(new RpcError("device handle is closed", "closed"));
    try {
      this.transport.close();
    } catch {
      // Already gone with the device.
    }
  }

  private fail(error: RpcError): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.clearTimer(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private allocateId(): number {
    // Ids wrap below 1000; skip any still in flight.
    for (let attempt = 0; attempt < MAX_CALL_ID; attempt++) {
      const id = this.nextId;
      this.nextId = this.nextId >= MAX_CALL_ID ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new RpcError("too many calls in flight", "device");
  }

  private dispatch(message: DeviceMessage): void {
    if (message.kind === "notification") {
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || (message.method !== null && message.method !== pending.method)) {
      this.options.onForeignResponse?.(message.method);
      return;
    }
    this.pending.delete(message.id);
    this.clearTimer(pending.timer);
    if (message.error) pending.reject(new RpcError(message.error.message, "device"));
    else pending.resolve(message.result);
  }
}
