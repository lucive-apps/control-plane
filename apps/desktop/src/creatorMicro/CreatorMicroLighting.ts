// @effect-diagnostics globalTimers:off -- Write coalescing runs on HID callbacks outside any Effect fiber; tests inject fake timers.
// Fork-owned. Per-key lighting for the six agent keys, written only on change.
//
// `v.oai.thstatus` is volatile (RAM) lighting: it never touches the device's
// files, and it is lost when the pad powers off. Even so, every write is a USB
// round trip that other apps see, so the scheduler keeps the last state the
// device acknowledged per key, coalesces bursts, and sends only the keys whose
// wanted state differs. When another app (Codex) repaints the keys, the
// acknowledged state is forgotten and the wanted state is sent again after a
// quiet period, with a rate limit so two apps can never ping-pong.

import { AGENT_SLOT_COUNT } from "./CreatorMicroKeymap.ts";

/** Firmware effect numbers for `v.oai.*` calls. */
export const Effect = { off: 0, solid: 1, breathing: 4 } as const;

export interface KeyLight {
  /** Packed 0xRRGGBB. */
  readonly color: number;
  readonly effect: number;
  readonly brightness: number;
  readonly speed: number;
}

export const KEY_OFF: KeyLight = { color: 0, effect: Effect.off, brightness: 0, speed: 0 };

/** One `v.oai.thstatus` entry. Zone mirroring is always off: these are per-key only. */
export function threadEntry(id: number, light: KeyLight) {
  return {
    id,
    c: light.color,
    b: light.brightness,
    e: light.effect,
    s: light.speed,
    sk: 0,
    sa: 0,
  };
}

const sameLight = (a: KeyLight | null, b: KeyLight) =>
  a !== null &&
  a.color === b.color &&
  a.effect === b.effect &&
  a.brightness === b.brightness &&
  a.speed === b.speed;

export interface LightingSchedulerOptions {
  /** Sends one `v.oai.thstatus` batch; resolves when the device acknowledged it. */
  readonly send: (entries: ReturnType<typeof threadEntry>[]) => Promise<void>;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  /** Delay that merges bursts of slot updates into one write. */
  readonly coalesceMs?: number;
  /** Quiet time after another app's lighting write before repainting. */
  readonly repaintDelayMs?: number;
  /** At most this many repaints per `repaintWindowMs`; later ones wait. */
  readonly maxRepaintsPerWindow?: number;
  readonly repaintWindowMs?: number;
  /** Retry delay after a failed write (screen lock, transient USB error). */
  readonly retryMs?: number;
  readonly onWriteError?: (error: unknown) => void;
}

export class LightingScheduler {
  private wanted: KeyLight[] = Array.from({ length: AGENT_SLOT_COUNT }, () => KEY_OFF);
  /** What the device last acknowledged per key; null when unknown. */
  private applied: Array<KeyLight | null> = Array.from({ length: AGENT_SLOT_COUNT }, () => null);
  private timer: unknown = null;
  private timerDue = Number.POSITIVE_INFINITY;
  private writing: Promise<void> | null = null;
  private active = false;
  private repaintTimes: number[] = [];
  private repaintPending = false;
  /** After a failed write, no retry before this time. */
  private backoffUntil = 0;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly coalesceMs: number;
  private readonly repaintDelayMs: number;
  private readonly maxRepaintsPerWindow: number;
  private readonly repaintWindowMs: number;
  private readonly retryMs: number;
  /** Count of `v.oai.thstatus` calls sent, for diagnostics and tests. */
  writeCount = 0;

  private readonly options: LightingSchedulerOptions;

  constructor(options: LightingSchedulerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.coalesceMs = options.coalesceMs ?? 60;
    this.repaintDelayMs = options.repaintDelayMs ?? 400;
    this.maxRepaintsPerWindow = options.maxRepaintsPerWindow ?? 6;
    this.repaintWindowMs = options.repaintWindowMs ?? 60_000;
    this.retryMs = options.retryMs ?? 5_000;
  }

  /** Starts writing to a freshly connected device, whose key state is unknown. */
  attach(): void {
    this.active = true;
    this.applied = this.applied.map(() => null);
    this.schedule(0);
  }

  /** Stops writing (device gone). Pending work is dropped. */
  detach(): void {
    this.active = false;
    this.cancelTimer();
  }

  setWanted(lights: ReadonlyArray<KeyLight>): void {
    this.wanted = Array.from({ length: AGENT_SLOT_COUNT }, (_, slot) => lights[slot] ?? KEY_OFF);
    if (this.hasDifference()) this.schedule(this.coalesceMs);
  }

  /** Another app wrote lighting: forget what the keys show and repaint soon. */
  noteForeignLightingWrite(): void {
    this.applied = this.applied.map(() => null);
    if (!this.active) return;
    this.repaintPending = true;
    const now = this.now();
    this.repaintTimes = this.repaintTimes.filter((time) => now - time < this.repaintWindowMs);
    let delay = this.repaintDelayMs;
    if (this.repaintTimes.length >= this.maxRepaintsPerWindow) {
      // Over budget: wait until the oldest repaint leaves the window.
      delay = Math.max(delay, this.repaintTimes[0]! + this.repaintWindowMs - now);
    }
    this.reschedule(delay);
  }

  /** Turns the six keys off now, for disable and shutdown. */
  async clear(): Promise<void> {
    this.cancelTimer();
    this.backoffUntil = 0;
    await this.writing?.catch(() => undefined);
    this.wanted = this.wanted.map(() => KEY_OFF);
    this.applied = this.applied.map(() => null);
    await this.flush();
  }

  private hasDifference(): boolean {
    return this.wanted.some((light, slot) => !sameLight(this.applied[slot] ?? null, light));
  }

  private schedule(delay: number): void {
    if (!this.active) return;
    const due = Math.max(this.now() + delay, this.backoffUntil);
    if (this.timer !== null && this.timerDue <= due) return;
    this.cancelTimer();
    this.timerDue = due;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerDue = Number.POSITIVE_INFINITY;
      void this.flush();
    }, due - this.now());
  }

  /** Like schedule, but a later deadline replaces an earlier one (debounce). */
  private reschedule(delay: number): void {
    this.cancelTimer();
    this.schedule(delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerDue = Number.POSITIVE_INFINITY;
  }

  private async flush(): Promise<void> {
    if (this.writing) {
      await this.writing.catch(() => undefined);
      if (this.hasDifference()) this.schedule(0);
      return;
    }
    const slots = this.wanted
      .map((light, slot) => ({ light, slot }))
      .filter(({ light, slot }) => !sameLight(this.applied[slot] ?? null, light));
    if (slots.length === 0) return;
    const batch = slots.map(({ light, slot }) => threadEntry(slot, light));
    this.writeCount += 1;
    if (this.repaintPending) {
      this.repaintPending = false;
      this.repaintTimes.push(this.now());
    }
    this.writing = this.options.send(batch);
    let failed = false;
    try {
      await this.writing;
      for (const { light, slot } of slots) this.applied[slot] = light;
      this.backoffUntil = 0;
    } catch (error) {
      failed = true;
      this.options.onWriteError?.(error);
      this.backoffUntil = this.now() + this.retryMs;
    } finally {
      this.writing = null;
    }
    if (failed || this.hasDifference()) this.schedule(this.coalesceMs);
  }
}
