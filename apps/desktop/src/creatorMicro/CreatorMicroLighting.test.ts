import { describe, expect, it } from "vite-plus/test";

import { Effect, KEY_OFF, LightingScheduler, type KeyLight } from "./CreatorMicroLighting.ts";

/** A manual clock: timers fire only when the test advances time. */
function makeClock() {
  let now = 0;
  let timers: Array<{ due: number; callback: () => void; id: number }> = [];
  let nextId = 0;
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ due: now + ms, callback, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.due - b.due);
        const next = timers[0];
        if (!next || next.due > target) break;
        timers = timers.slice(1);
        now = next.due;
        next.callback();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      now = target;
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

const green: KeyLight = { color: 0x10b981, effect: Effect.solid, brightness: 1, speed: 0 };
const blue: KeyLight = { color: 0x0ea5e9, effect: Effect.breathing, brightness: 1, speed: 0.4 };

function setup(send: (entries: unknown[]) => Promise<void> = async () => undefined) {
  const clock = makeClock();
  const batches: unknown[][] = [];
  const scheduler = new LightingScheduler({
    send: async (entries) => {
      batches.push(entries);
      await send(entries);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    coalesceMs: 50,
    repaintDelayMs: 400,
    maxRepaintsPerWindow: 3,
    repaintWindowMs: 60_000,
    retryMs: 5_000,
  });
  return { clock, batches, scheduler };
}

describe("LightingScheduler", () => {
  it("paints all six keys once on attach, then only what changed", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.setWanted([green, blue]);
    scheduler.attach();
    await clock.advance(100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(6);

    scheduler.setWanted([green, green]);
    await clock.advance(100);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([{ id: 1, c: green.color, b: 1, e: 1, s: 0, sk: 0, sa: 0 }]);
  });

  it("never writes when nothing changed", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.attach();
    scheduler.setWanted([green]);
    await clock.advance(100);
    const writes = batches.length;
    for (let i = 0; i < 20; i++) scheduler.setWanted([green]);
    await clock.advance(1_000);
    expect(batches.length).toBe(writes);
  });

  it("coalesces a burst of updates into one write", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.attach();
    await clock.advance(10);
    batches.length = 0;
    scheduler.setWanted([green]);
    scheduler.setWanted([blue]);
    scheduler.setWanted([green, blue]);
    await clock.advance(100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("repaints after another app's write, after a quiet period", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.setWanted([green, blue]);
    scheduler.attach();
    await clock.advance(10);
    batches.length = 0;
    scheduler.noteForeignLightingWrite();
    await clock.advance(399);
    expect(batches).toHaveLength(0);
    await clock.advance(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(6);
  });

  it("debounces a run of foreign writes into one repaint", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.attach();
    await clock.advance(10);
    batches.length = 0;
    for (let i = 0; i < 5; i++) {
      scheduler.noteForeignLightingWrite();
      await clock.advance(100);
    }
    await clock.advance(400);
    expect(batches).toHaveLength(1);
  });

  it("rate-limits repaints when another app keeps overwriting", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.attach();
    await clock.advance(10);
    batches.length = 0;
    for (let i = 0; i < 6; i++) {
      scheduler.noteForeignLightingWrite();
      await clock.advance(1_000);
    }
    // Budget is 3 repaints a minute; the rest wait for the window to roll.
    expect(batches.length).toBe(3);
    await clock.advance(60_000);
    expect(batches.length).toBe(4);
  });

  it("retries a failed write later instead of hammering", async () => {
    let fail = true;
    const { clock, batches, scheduler } = setup(async () => {
      if (fail) throw new Error("IOHIDDeviceSetReport failed: not permitted");
    });
    scheduler.setWanted([green]);
    scheduler.attach();
    await clock.advance(1_000);
    expect(batches).toHaveLength(1);
    fail = false;
    await clock.advance(5_000);
    expect(batches).toHaveLength(2);
    await clock.advance(30_000);
    expect(batches).toHaveLength(2);
  });

  it("writes nothing while detached, and clear turns every key off", async () => {
    const { clock, batches, scheduler } = setup();
    scheduler.setWanted([green]);
    await clock.advance(1_000);
    expect(batches).toHaveLength(0);
    scheduler.attach();
    await clock.advance(100);
    await scheduler.clear();
    const last = batches.at(-1) as Array<{ e: number; b: number }>;
    expect(last).toHaveLength(6);
    expect(last.every((entry) => entry.e === KEY_OFF.effect && entry.b === 0)).toBe(true);
  });
});
