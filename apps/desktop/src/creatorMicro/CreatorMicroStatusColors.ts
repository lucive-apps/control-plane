// Fork-owned. How each chat status looks on an agent key.
//
// Colours are the sidebar's own status hues (THREAD_INDICATOR_STATUS_RGB), so
// a key reads the same as the chat's dot. Working breathes, like the sidebar's
// pulsing working dot; everything else is solid. Ready (idle) is a dim white
// so a key with a chat is visibly assigned; a key with no chat is off.

import type { CreatorMicroSlot } from "@t3tools/contracts";
import { THREAD_INDICATOR_STATUS_RGB } from "@t3tools/client-runtime/state/thread-status";

import { Effect, KEY_OFF, type KeyLight } from "./CreatorMicroLighting.ts";

const IDLE_BRIGHTNESS = 0.12;
const BREATHING_SPEED = 0.4;

export function slotLight(slot: CreatorMicroSlot | null): KeyLight {
  if (slot === null) return KEY_OFF;
  const color = THREAD_INDICATOR_STATUS_RGB[slot.status];
  switch (slot.status) {
    case "working":
      return { color, effect: Effect.breathing, brightness: 1, speed: BREATHING_SPEED };
    case "ready":
      return { color, effect: Effect.solid, brightness: IDLE_BRIGHTNESS, speed: 0 };
    case "monitoring":
      return { color, effect: Effect.solid, brightness: 0.5, speed: 0 };
    default:
      return { color, effect: Effect.solid, brightness: 1, speed: 0 };
  }
}
