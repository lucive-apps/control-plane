// Fork-owned. The Creator Micro 2 keymap file and the agent-key rebinding.
//
// The device keeps its configuration in `keymap.json` (read and written over
// the RPC channel; `fs.write` is a flash write). A key can only be lit on its
// own when the active layer binds it to a `KV_OAI_AGnn` keycode, and such a key
// stops sending its keystroke and reports itself over HID instead. So the
// integration rebinds exactly the six top keys, and nothing else: every other
// key, the dial, the joystick, macros and the stored lighting stay as they are.

import * as NodeCrypto from "node:crypto";

export const AGENT_SLOT_COUNT = 6;

/**
 * Matrix positions of the six agent keys, by slot. The matrix rows are
 * [2, 4, 4, 3] and key index n sits at row-major position n, so slot n is key
 * index n: the key that typed Cmd+(n+1) in the user's original layout.
 */
export const AGENT_KEY_POSITIONS: ReadonlyArray<{ readonly row: number; readonly column: number }> =
  [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 1, column: 0 },
    { row: 1, column: 1 },
    { row: 1, column: 2 },
    { row: 1, column: 3 },
  ];

export const agentKeycode = (slot: number): string => `KV_OAI_AG${String(slot).padStart(2, "0")}`;

export const AGENT_KEYCODES: ReadonlyArray<string> = AGENT_KEY_POSITIONS.map((_, slot) =>
  agentKeycode(slot),
);

export class KeymapError extends Error {
  override readonly name = "KeymapError";
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The firmware's checksum for a file is the SHA-1 of its text. */
export function sha1(text: string): string {
  return NodeCrypto.createHash("sha1").update(text, "utf8").digest("hex");
}

function parseConfig(text: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new KeymapError(`keymap.json is not valid JSON: ${String(cause)}`);
  }
  if (!isRecord(parsed)) throw new KeymapError("keymap.json is not an object");
  return parsed;
}

/** The base layer's key matrix of the active profile, which is the live layer. */
function activeKeymap(config: JsonRecord): string[][] {
  const profiles = config.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new KeymapError("keymap.json has no profiles");
  }
  const activeId = typeof config.activeProfileId === "number" ? config.activeProfileId : 0;
  const profile =
    profiles.find((candidate) => isRecord(candidate) && candidate.id === activeId) ??
    profiles[activeId] ??
    profiles[0];
  const layers = isRecord(profile) ? profile.layers : undefined;
  const layer = Array.isArray(layers) ? layers[0] : undefined;
  const layout = isRecord(layer) ? layer.layout : undefined;
  const keymap = isRecord(layout) ? layout.keymap : undefined;
  if (
    !Array.isArray(keymap) ||
    !keymap.every((row) => Array.isArray(row) && row.every((key) => typeof key === "string"))
  ) {
    throw new KeymapError("keymap.json has no key matrix on its active layer");
  }
  for (const { row, column } of AGENT_KEY_POSITIONS) {
    if (keymap[row]?.[column] === undefined) {
      throw new KeymapError(`keymap.json has no key at row ${row}, column ${column}`);
    }
  }
  return keymap as string[][];
}

export interface KeymapAnalysis {
  /** Current keycodes of the six agent positions, by slot. */
  readonly slotKeycodes: ReadonlyArray<string>;
  /** Every agent position carries its AG keycode: the keys can light. */
  readonly agentKeysBound: boolean;
  /** No agent position carries an AG keycode: the user's own layout. */
  readonly agentKeysFree: boolean;
}

export function analyzeKeymap(text: string): KeymapAnalysis {
  const keymap = activeKeymap(parseConfig(text));
  const slotKeycodes = AGENT_KEY_POSITIONS.map(({ row, column }) => keymap[row]![column]!);
  return {
    slotKeycodes,
    agentKeysBound: slotKeycodes.every((code, slot) => code === agentKeycode(slot)),
    agentKeysFree: slotKeycodes.every((code) => !code.startsWith("KV_OAI_AG")),
  };
}

function withSlotKeycodes(text: string, codes: ReadonlyArray<string>): string {
  const config = parseConfig(text);
  const keymap = activeKeymap(config);
  AGENT_KEY_POSITIONS.forEach(({ row, column }, slot) => {
    keymap[row]![column] = codes[slot]!;
  });
  return JSON.stringify(config);
}

/** Binds the six agent keys. Returns the new file text. */
export function bindAgentKeys(text: string): string {
  return withSlotKeycodes(text, AGENT_KEYCODES);
}

/** Puts the user's original keycodes back on the six agent keys. */
export function restoreSlotKeycodes(text: string, original: ReadonlyArray<string>): string {
  if (
    original.length !== AGENT_SLOT_COUNT ||
    original.some((code) => code.startsWith("KV_OAI_AG"))
  ) {
    throw new KeymapError("the saved original keycodes are not a usable layout");
  }
  return withSlotKeycodes(text, original);
}

export interface KeymapChange {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Every leaf that differs between two configs, as JSON paths. */
export function diffConfigs(beforeText: string, afterText: string): KeymapChange[] {
  const changes: KeymapChange[] = [];
  const walk = (before: unknown, after: unknown, path: string) => {
    if (Array.isArray(before) && Array.isArray(after)) {
      const length = Math.max(before.length, after.length);
      for (let index = 0; index < length; index++) {
        walk(before[index], after[index], `${path}[${index}]`);
      }
      return;
    }
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        walk(before[key], after[key], `${path}.${key}`);
      }
      return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ path, before, after });
  };
  walk(JSON.parse(beforeText), JSON.parse(afterText), "$");
  return changes;
}

/**
 * Checks that `after` differs from `before` in nothing but the six agent key
 * positions, and that those now hold `expected`. Returns the problems found,
 * empty when the change is exactly what was intended.
 */
export function verifySlotChange(
  beforeText: string,
  afterText: string,
  expected: ReadonlyArray<string>,
): string[] {
  const problems: string[] = [];
  let analysis: KeymapAnalysis;
  try {
    analysis = analyzeKeymap(afterText);
  } catch (cause) {
    return [String(cause instanceof Error ? cause.message : cause)];
  }
  analysis.slotKeycodes.forEach((code, slot) => {
    if (code !== expected[slot])
      problems.push(`slot ${slot} holds ${code}, expected ${expected[slot]}`);
  });
  const config = parseConfig(beforeText);
  const profiles = config.profiles as unknown[];
  const activeId = typeof config.activeProfileId === "number" ? config.activeProfileId : 0;
  const profileIndex = Math.max(
    0,
    profiles.findIndex((candidate) => isRecord(candidate) && candidate.id === activeId),
  );
  const allowed = new Set(
    AGENT_KEY_POSITIONS.map(
      ({ row, column }) => `$.profiles[${profileIndex}].layers[0].layout.keymap[${row}][${column}]`,
    ),
  );
  for (const change of diffConfigs(beforeText, afterText)) {
    if (!allowed.has(change.path)) problems.push(`unexpected change at ${change.path}`);
  }
  return problems;
}
