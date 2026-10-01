// @effect-diagnostics globalTimers:off -- The device poll and shutdown deadline run on HID callbacks outside any Effect fiber; tests inject fake timers.
// Fork-owned. Drives a Work Louder Creator Micro 2 so its six top keys show
// the live status of the chats on Cmd+1..Cmd+6, and open them when pressed.
//
// Flash writes (`fs.write keymap.json`) happen only from explicit user actions:
// enable, disable and restore. Each one is preceded by a backup and followed
// by a readback that must match byte for byte and change nothing but the six
// agent keys; a mismatch writes the previous file back. Everything that runs
// on its own (connect, reconnect, slot updates) is read-only or volatile
// lighting.

import type {
  CreatorMicroConnection,
  CreatorMicroKeymapState,
  CreatorMicroSlot,
  CreatorMicroState,
} from "@t3tools/contracts";

import {
  AGENT_KEYCODES,
  AGENT_SLOT_COUNT,
  analyzeKeymap,
  bindAgentKeys,
  restoreSlotKeycodes,
  sha1,
  storedZoneLighting,
  verifySlotChange,
} from "./CreatorMicroKeymap.ts";
import { KEY_OFF, LightingScheduler, type KeyLight } from "./CreatorMicroLighting.ts";
import { parseAgentKeyEvent } from "./CreatorMicroProtocol.ts";
import { CreatorMicroRpcClient, type CreatorMicroTransport } from "./CreatorMicroRpc.ts";
import { slotLight } from "./CreatorMicroStatusColors.ts";

export interface CreatorMicroDeviceInfo {
  readonly path: string;
  readonly productId: number;
  readonly serialNumber: string | null;
  readonly product: string | null;
}

/** The HID layer: node-hid in the app, a fake in tests. */
export interface CreatorMicroHid {
  /** Vendor-interface candidates currently attached. */
  list(): Promise<ReadonlyArray<CreatorMicroDeviceInfo>>;
  /** Opens one shared (non-exclusive) handle. */
  open(device: CreatorMicroDeviceInfo): Promise<CreatorMicroTransport>;
  /**
   * Asks macOS for Input Monitoring, which shows the system prompt for this
   * app (once) and lists it in Privacy & Security. Absent off macOS.
   */
  requestInputMonitoring?(): Promise<void>;
}

export interface CreatorMicroPersisted {
  readonly enabled: boolean;
  /** Keycodes the six agent keys had before enable, to put back on disable. */
  readonly originalSlotKeycodes: ReadonlyArray<string> | null;
  /** Directory of the backup taken just before the first flash write. */
  readonly backupDir: string | null;
}

export const DEFAULT_PERSISTED: CreatorMicroPersisted = {
  enabled: false,
  originalSlotKeycodes: null,
  backupDir: null,
};

export interface CreatorMicroBackup {
  readonly dir: string;
  readonly createdAt: string;
}

export interface CreatorMicroControllerDeps {
  readonly hid: CreatorMicroHid;
  readonly loadPersisted: () => Promise<CreatorMicroPersisted>;
  readonly savePersisted: (state: CreatorMicroPersisted) => Promise<void>;
  /** Saves device files into a fresh timestamped backup directory. */
  readonly writeBackup: (files: {
    readonly keymap: string;
    readonly smartActions: string | null;
    readonly fileList: unknown;
    readonly firmware: unknown;
    readonly reason: string;
  }) => Promise<CreatorMicroBackup>;
  readonly readBackupKeymap: (dir: string) => Promise<string>;
  readonly onStateChanged: (state: CreatorMicroState) => void;
  /** A pressed agent key; `threadKey` is null for an empty slot. */
  readonly onKeyPressed: (slot: number, threadKey: string | null) => void;
  readonly log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  /** Wire-level diagnostics (lighting batches and acks, device notifications). */
  readonly trace?: (line: string) => void;
  readonly pollIntervalMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly now?: () => number;
  readonly lightingOptions?: {
    readonly coalesceMs?: number;
    readonly repaintDelayMs?: number;
    readonly retryMs?: number;
  };
}

const KEYMAP_FILE = "keymap.json";
const SMART_ACTIONS_FILE = "smart_actions.json";
const FLASH_TIMEOUT_MS = 20_000;
/** Raw bytes per `fs.writebin` chunk: 4096 base64 characters, as Input sends. */
const WRITE_CHUNK_BYTES = 3072;
const LIGHTING_METHOD = "v.oai.thstatus";

export class CreatorMicroError extends Error {
  override readonly name = "CreatorMicroError";
}

const isPermissionError = (error: unknown) =>
  /not permitted|privilege|0xE00002E2|access denied/i.test(
    error instanceof Error ? error.message : String(error),
  );

interface Connection {
  readonly device: CreatorMicroDeviceInfo;
  readonly rpc: CreatorMicroRpcClient;
}

export class CreatorMicroController {
  private persisted: CreatorMicroPersisted = DEFAULT_PERSISTED;
  private connection: Connection | null = null;
  private connecting: Promise<Connection | null> | null = null;
  private status: CreatorMicroConnection = "disabled";
  private keymap: CreatorMicroKeymapState = "unknown";
  private busy: CreatorMicroState["busy"] = null;
  private lastError: string | null = null;
  private firmware: string | null = null;
  private otherAppDetected = false;
  private flashWrites = 0;
  private slots: ReadonlyArray<CreatorMicroSlot | null> = [];
  private pollTimer: unknown = null;
  private started = false;
  private lightingAttached = false;
  /** The user's Input lighting for the active layer, as rgbcfg zones. */
  private storedZones: ReturnType<typeof storedZoneLighting> = null;
  private permissionRequested = false;
  private stopped = false;
  private readonly lighting: LightingScheduler;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly pollIntervalMs: number;

  private readonly deps: CreatorMicroControllerDeps;

  constructor(deps: CreatorMicroControllerDeps) {
    this.deps = deps;
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.pollIntervalMs = deps.pollIntervalMs ?? 2_000;
    this.lighting = new LightingScheduler({
      send: async (entries) => {
        const rpc = this.connection?.rpc;
        if (!rpc) throw new CreatorMicroError("not connected");
        const ack = await rpc.call(LIGHTING_METHOD, entries, 4_000);
        this.deps.trace?.(`thstatus ${JSON.stringify(entries)} -> ${JSON.stringify(ack)}`);
      },
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      ...(deps.now ? { now: deps.now } : {}),
      ...deps.lightingOptions,
      onWriteError: (error) => this.log("warn", "lighting write failed", error),
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.persisted = await this.deps.loadPersisted();
    if (this.persisted.enabled) {
      this.status = "searching";
      this.emit();
      await this.ensureConnected();
      this.schedulePoll();
    } else {
      this.emit();
    }
  }

  /** App shutdown: keys go dark, the handle closes. The keymap is left alone. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelPoll();
    if (this.connection) {
      await withTimeout(this.lighting.clear(), 1_500).catch(() => undefined);
    }
    this.disconnect();
  }

  getState(): CreatorMicroState {
    return {
      enabled: this.persisted.enabled,
      connection: this.status,
      keymap: this.keymap,
      busy: this.busy,
      lastError: this.lastError,
      firmware: this.firmware,
      otherAppDetected: this.otherAppDetected,
      hasBackup: this.persisted.backupDir !== null,
      backupDir: this.persisted.backupDir,
      flashWritesThisSession: this.flashWrites,
      lightingWritesThisSession: this.lighting.writeCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Slots and keys

  /** The chats on Cmd+1..Cmd+6 and their statuses; index = slot. */
  setSlots(slots: ReadonlyArray<CreatorMicroSlot | null>): void {
    this.slots = Array.from({ length: AGENT_SLOT_COUNT }, (_, slot) => slots[slot] ?? null);
    this.syncLighting();
  }

  /** Lights only while enabled, connected and bound; otherwise writes nothing. */
  private syncLighting(): void {
    const ready =
      this.persisted.enabled && this.keymap === "agent-keys" && this.connection !== null;
    if (ready && !this.lightingAttached) {
      this.lightingAttached = true;
      this.restoreZoneLighting();
      this.lighting.attach();
    } else if (!ready && this.lightingAttached) {
      this.lightingAttached = false;
      this.lighting.detach();
    }
    this.lighting.setWanted(this.wantedLights());
  }

  /**
   * With agent keycodes active the firmware lights everything but the agent
   * keys from the volatile rgbcfg zones, which start dark. Put the user's own
   * Input lighting (backlight, underglow) there, so only the six agent keys
   * change. Volatile, like thstatus: nothing is written to flash.
   */
  private restoreZoneLighting(): void {
    const rpc = this.connection?.rpc;
    const zones = this.storedZones;
    if (!rpc || !zones) return;
    rpc.call("v.oai.rgbcfg", zones, 4_000).then(
      (ack) => this.deps.trace?.(`rgbcfg ${JSON.stringify(zones)} -> ${JSON.stringify(ack)}`),
      (error: unknown) => this.log("warn", "zone lighting write failed", error),
    );
  }

  private wantedLights(): KeyLight[] {
    if (!this.persisted.enabled || this.keymap !== "agent-keys") {
      return Array.from({ length: AGENT_SLOT_COUNT }, () => KEY_OFF);
    }
    return Array.from({ length: AGENT_SLOT_COUNT }, (_, slot) =>
      slotLight(this.slots[slot] ?? null),
    );
  }

  private handleNotification(method: string, params: unknown): void {
    this.deps.trace?.(`notify ${method} ${JSON.stringify(params)}`);
    const event = parseAgentKeyEvent(method, params);
    if (!event || !event.pressed || event.keyIndex >= AGENT_SLOT_COUNT) return;
    if (!this.persisted.enabled || this.keymap !== "agent-keys") return;
    this.deps.onKeyPressed(event.keyIndex, this.slots[event.keyIndex]?.threadKey ?? null);
  }

  private handleForeignResponse(method: string | null): void {
    if (method !== LIGHTING_METHOD && method !== "v.oai.rgbcfg") return;
    if (!this.otherAppDetected) {
      this.otherAppDetected = true;
      this.emit();
    }
    // Zone writes never cover per-key colours; only thread writes do.
    if (method === LIGHTING_METHOD) this.lighting.noteForeignLightingWrite();
  }

  // ---------------------------------------------------------------------------
  // Connection

  private schedulePoll(): void {
    this.cancelPoll();
    if (this.stopped || !this.persisted.enabled) return;
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      void this.ensureConnected().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private cancelPoll(): void {
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
  }

  private async ensureConnected(): Promise<Connection | null> {
    if (this.connection && !this.connection.rpc.isClosed) {
      // Cheap liveness check: is the device still attached?
      const devices = await this.deps.hid.list().catch(() => []);
      if (devices.some((device) => device.path === this.connection?.device.path)) {
        return this.connection;
      }
      this.handleLost("device detached");
    }
    if (this.stopped) return null;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<Connection | null> {
    let devices: ReadonlyArray<CreatorMicroDeviceInfo>;
    try {
      devices = await this.deps.hid.list();
    } catch (error) {
      this.setStatus("error", `HID enumeration failed: ${message(error)}`);
      return null;
    }
    const device = devices[0];
    if (!device) {
      this.keymap = "unknown";
      this.setStatus("searching", null);
      return null;
    }
    this.setStatus("connecting", null);
    let transport: CreatorMicroTransport;
    try {
      transport = await this.deps.hid.open(device);
    } catch (error) {
      if (isPermissionError(error)) {
        if (!this.permissionRequested) {
          this.permissionRequested = true;
          await this.deps.hid.requestInputMonitoring?.().catch(() => undefined);
        }
        this.setStatus("permission-denied", "Control Plane needs Input Monitoring permission.");
      } else {
        this.setStatus("error", `Could not open the pad: ${message(error)}`);
      }
      return null;
    }
    if (this.stopped) {
      transport.close();
      return null;
    }
    const rpc = new CreatorMicroRpcClient(transport, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onForeignResponse: (method) => this.handleForeignResponse(method),
      onTransportError: (error) => this.handleLost(error.message),
      setTimer: this.setTimer as never,
      clearTimer: this.clearTimer as never,
    });
    const connection = { device, rpc };
    this.connection = connection;
    try {
      const version = (await rpc.call("sys.version")) as { version?: unknown } | null;
      this.firmware = typeof version?.version === "string" ? version.version : null;
      await this.refreshKeymapState(rpc);
    } catch (error) {
      this.log("warn", "pad did not answer after open", error);
      this.handleLost(`The pad did not answer: ${message(error)}`);
      return null;
    }
    this.setStatus("connected", null);
    this.log("info", `connected, firmware ${this.firmware}, keymap ${this.keymap}`);
    this.syncLighting();
    return connection;
  }

  /** Read-only: which layout the six keys carry right now. */
  private async refreshKeymapState(rpc: CreatorMicroRpcClient): Promise<string> {
    const text = await readFile(rpc, KEYMAP_FILE);
    const analysis = analyzeKeymap(text);
    this.storedZones = safeZones(text);
    this.keymap = analysis.agentKeysBound
      ? "agent-keys"
      : analysis.agentKeysFree
        ? "original"
        : "mixed";
    return text;
  }

  private handleLost(reason: string): void {
    if (!this.connection) return;
    this.log("info", "pad connection lost", reason);
    this.disconnect();
    if (!this.stopped && this.persisted.enabled) this.setStatus("searching", null);
  }

  private disconnect(): void {
    this.lightingAttached = false;
    this.lighting.detach();
    const connection = this.connection;
    this.connection = null;
    connection?.rpc.close();
  }

  // ---------------------------------------------------------------------------
  // User actions (the only flash writes)

  /** Turns the integration on: backup, bind the six keys, verify, light. */
  async enable(): Promise<CreatorMicroState> {
    return this.runExclusive("enabling", async () => {
      const { rpc } = await this.requireConnection();
      const before = await readFile(rpc, KEYMAP_FILE);
      const analysis = analyzeKeymap(before);
      this.storedZones = safeZones(before);
      if (!analysis.agentKeysBound && !analysis.agentKeysFree) {
        throw new CreatorMicroError(
          "Some of the six top keys already carry agent keycodes and some do not. " +
            "Fix the layout in Work Louder Input, or restore the original config.",
        );
      }
      const backup = await this.backup(rpc, before, "before enabling");
      let original = this.persisted.originalSlotKeycodes;
      if (analysis.agentKeysFree) {
        original = analysis.slotKeycodes;
        await this.writeVerified(rpc, before, bindAgentKeys(before), AGENT_KEYCODES);
      }
      this.persisted = {
        enabled: true,
        originalSlotKeycodes: original,
        backupDir: this.persisted.backupDir ?? backup.dir,
      };
      await this.deps.savePersisted(this.persisted);
      this.keymap = "agent-keys";
      this.syncLighting();
      this.schedulePoll();
    });
  }

  /** Turns the integration off: keys dark, original Cmd+1..Cmd+6 keycodes back. */
  async disable(): Promise<CreatorMicroState> {
    return this.runExclusive("disabling", async () => {
      this.persisted = { ...this.persisted, enabled: false };
      const connection = this.connection ?? (await this.ensureConnected());
      if (connection) {
        await this.lighting.clear().catch(() => undefined);
        const before = await readFile(connection.rpc, KEYMAP_FILE);
        const analysis = analyzeKeymap(before);
        const original = this.persisted.originalSlotKeycodes;
        if (analysis.agentKeysBound && original) {
          await this.backup(connection.rpc, before, "before disabling");
          await this.writeVerified(
            connection.rpc,
            before,
            restoreSlotKeycodes(before, original),
            original,
          );
          this.keymap = "original";
        } else if (analysis.agentKeysBound) {
          this.lastError =
            "The original key mapping is unknown, so the agent keys were left in place. " +
            "Use Restore original device config.";
        }
      } else {
        this.lastError =
          "The pad is not connected, so its keys still carry the agent keycodes. " +
          "Reconnect it and turn the integration on and off again, or restore the backup.";
      }
      await this.deps.savePersisted(this.persisted);
    });
  }

  /** Writes the backed-up keymap.json back exactly, and turns the integration off. */
  async restoreBackup(): Promise<CreatorMicroState> {
    return this.runExclusive("restoring", async () => {
      const dir = this.persisted.backupDir;
      if (!dir) throw new CreatorMicroError("There is no backup to restore.");
      const target = await this.deps.readBackupKeymap(dir);
      analyzeKeymap(target);
      const { rpc } = await this.requireConnection();
      await this.lighting.clear().catch(() => undefined);
      const before = await readFile(rpc, KEYMAP_FILE);
      if (sha1(before) !== sha1(target)) {
        await this.backup(rpc, before, "before restoring the original config");
        await this.flashWrite(rpc, target);
        const readback = await readFile(rpc, KEYMAP_FILE);
        if (sha1(readback) !== sha1(target)) {
          throw new CreatorMicroError(
            "The pad did not keep the restored config (readback differs).",
          );
        }
      }
      const analysis = analyzeKeymap(target);
      this.keymap = analysis.agentKeysBound
        ? "agent-keys"
        : analysis.agentKeysFree
          ? "original"
          : "mixed";
      this.persisted = { ...this.persisted, enabled: false };
      await this.deps.savePersisted(this.persisted);
    });
  }

  private async requireConnection(): Promise<Connection> {
    const connection = await this.ensureConnected();
    if (!connection) {
      throw new CreatorMicroError(
        this.status === "permission-denied"
          ? "Control Plane needs Input Monitoring permission to reach the pad."
          : "The Creator Micro 2 is not connected.",
      );
    }
    return connection;
  }

  private async backup(rpc: CreatorMicroRpcClient, keymap: string, reason: string) {
    const fileList = await rpc.call("fs.list", { checksum: true, rec: true });
    const smartActions = await readFile(rpc, SMART_ACTIONS_FILE).catch(() => null);
    const backup = await this.deps.writeBackup({
      keymap,
      smartActions,
      fileList,
      firmware: this.firmware,
      reason,
    });
    this.log("info", `backup saved to ${backup.dir}`);
    return backup;
  }

  /**
   * Writes keymap.json the way Work Louder Input does: base64 chunks over
   * `fs.writebin`, the last one marked `completed`. On firmware 0.6.2 a plain
   * `fs.write` stores the file but the running keymap stays the old one until
   * the pad restarts; the completed chunked write is what makes it take
   * effect, so the agent keys can light without a power cycle.
   */
  private async flashWrite(rpc: CreatorMicroRpcClient, text: string): Promise<void> {
    this.flashWrites += 1;
    this.log("info", `flash write keymap.json (${text.length} bytes, sha1 ${sha1(text)})`);
    const bytes = Buffer.from(text, "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      chunks.push(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES));
    }
    let written = 0;
    for (const [index, chunk] of chunks.entries()) {
      const result = (await rpc.call(
        "fs.writebin",
        {
          file: KEYMAP_FILE,
          data: chunk.toString("base64"),
          append: true,
          completed: index === chunks.length - 1,
          offset: index * WRITE_CHUNK_BYTES,
        },
        FLASH_TIMEOUT_MS,
      )) as { data_written?: unknown } | null;
      if (typeof result?.data_written === "number") written += result.data_written;
    }
    if (written !== 0 && written !== bytes.length) {
      throw new CreatorMicroError(`The pad stored ${written} of ${bytes.length} bytes.`);
    }
  }

  /**
   * Writes `next`, reads it back, and checks the readback is byte-identical
   * and differs from `before` only in the six agent keys (now `expected`).
   * On any mismatch the previous file is written back and verified.
   */
  private async writeVerified(
    rpc: CreatorMicroRpcClient,
    before: string,
    next: string,
    expected: ReadonlyArray<string>,
  ): Promise<void> {
    const planned = verifySlotChange(before, next, expected);
    if (planned.length > 0) {
      throw new CreatorMicroError(`Refusing to write an unexpected change: ${planned.join("; ")}`);
    }
    let problems: string[];
    try {
      await this.flashWrite(rpc, next);
      const readback = await readFile(rpc, KEYMAP_FILE);
      const files = (await rpc.call("fs.list", { checksum: true, rec: true })) as unknown;
      problems = [
        ...(sha1(readback) === sha1(next) ? [] : ["readback differs from what was written"]),
        ...verifySlotChange(before, readback, expected),
        ...checksumProblems(files, sha1(next)),
      ];
    } catch (error) {
      problems = [`write or readback failed: ${message(error)}`];
    }
    if (problems.length === 0) return;
    this.log("error", "keymap verification failed, writing the previous file back", problems);
    try {
      await this.flashWrite(rpc, before);
      const reverted = await readFile(rpc, KEYMAP_FILE);
      if (sha1(reverted) !== sha1(before)) problems.push("the previous file could not be restored");
    } catch (error) {
      problems.push(`restoring the previous file failed: ${message(error)}`);
    }
    throw new CreatorMicroError(`Keymap change aborted: ${problems.join("; ")}`);
  }

  private async runExclusive(
    busy: NonNullable<CreatorMicroState["busy"]>,
    action: () => Promise<void>,
  ): Promise<CreatorMicroState> {
    if (this.busy) throw new CreatorMicroError(`Busy ${this.busy}; try again in a moment.`);
    this.busy = busy;
    this.lastError = null;
    this.emit();
    try {
      await action();
    } catch (error) {
      this.lastError = message(error);
      this.log("error", `${busy} failed`, error);
    } finally {
      this.busy = null;
      if (!this.persisted.enabled) {
        // Off: release the pad entirely so other apps have it to themselves.
        // A missing permission stays visible so the panel can explain it.
        this.cancelPoll();
        this.disconnect();
        if (this.status !== "permission-denied") this.status = "disabled";
      }
      this.emit();
    }
    return this.getState();
  }

  // ---------------------------------------------------------------------------

  private setStatus(status: CreatorMicroConnection, error: string | null): void {
    const changed = this.status !== status || (error !== null && this.lastError !== error);
    this.status = this.persisted.enabled || this.busy ? status : "disabled";
    if (error !== null) this.lastError = error;
    else if (status === "connected") this.lastError = null;
    if (changed) this.emit();
  }

  private emit(): void {
    this.deps.onStateChanged(this.getState());
  }

  private log(level: "info" | "warn" | "error", text: string, detail?: unknown): void {
    this.deps.trace?.(`${level} ${text}${detail === undefined ? "" : ` ${String(detail)}`}`);
    this.deps.log?.(level, `[creator-micro] ${text}`, detail);
  }
}

async function readFile(rpc: CreatorMicroRpcClient, file: string): Promise<string> {
  const result = (await rpc.call("fs.read", { file }, FLASH_TIMEOUT_MS)) as {
    data?: unknown;
  } | null;
  if (typeof result?.data !== "string") {
    throw new CreatorMicroError(`The pad returned no contents for ${file}`);
  }
  return result.data;
}

function checksumProblems(files: unknown, expected: string): string[] {
  if (!Array.isArray(files)) return [];
  const entry = files.find(
    (file): file is { name: string; checksum?: unknown } =>
      typeof file === "object" &&
      file !== null &&
      (file as { name?: unknown }).name === KEYMAP_FILE,
  );
  if (!entry || typeof entry.checksum !== "string") return [];
  return entry.checksum === expected
    ? []
    : [`device checksum ${entry.checksum} is not ${expected}`];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function safeZones(text: string): ReturnType<typeof storedZoneLighting> {
  try {
    return storedZoneLighting(text);
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
