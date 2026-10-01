import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_KEYCODES,
  analyzeKeymap,
  bindAgentKeys,
  diffConfigs,
  restoreSlotKeycodes,
  verifySlotChange,
} from "./CreatorMicroKeymap.ts";
import { makeKeymap, ORIGINAL_TOP_SIX } from "./testing/FakeCreatorMicro.ts";

const original = makeKeymap(ORIGINAL_TOP_SIX);

describe("analyzeKeymap", () => {
  it("reads the six top keys of the active layer", () => {
    expect(analyzeKeymap(original)).toEqual({
      slotKeycodes: ORIGINAL_TOP_SIX,
      agentKeysBound: false,
      agentKeysFree: true,
    });
    expect(analyzeKeymap(bindAgentKeys(original)).agentKeysBound).toBe(true);
  });

  it("flags a half-bound layout as neither bound nor free", () => {
    const mixed = makeKeymap(["KV_OAI_AG00", ...ORIGINAL_TOP_SIX.slice(1)]);
    expect(analyzeKeymap(mixed)).toMatchObject({ agentKeysBound: false, agentKeysFree: false });
  });

  it("rejects files that are not a usable keymap", () => {
    expect(() => analyzeKeymap("not json")).toThrow(/not valid JSON/);
    expect(() => analyzeKeymap('{"profiles":[]}')).toThrow(/no profiles/);
  });
});

describe("bindAgentKeys", () => {
  it("changes exactly the six top keys and nothing else", () => {
    const bound = bindAgentKeys(original);
    const changes = diffConfigs(original, bound);
    expect(changes.map((change) => [change.path, change.before, change.after])).toEqual([
      ["$.profiles[0].layers[0].layout.keymap[0][0]", "KA_A0", "KV_OAI_AG00"],
      ["$.profiles[0].layers[0].layout.keymap[0][1]", "KA_A1", "KV_OAI_AG01"],
      ["$.profiles[0].layers[0].layout.keymap[1][0]", "KA_A2", "KV_OAI_AG02"],
      ["$.profiles[0].layers[0].layout.keymap[1][1]", "KA_A3", "KV_OAI_AG03"],
      ["$.profiles[0].layers[0].layout.keymap[1][2]", "KA_A4", "KV_OAI_AG04"],
      ["$.profiles[0].layers[0].layout.keymap[1][3]", "KA_A5", "KV_OAI_AG05"],
    ]);
    expect(verifySlotChange(original, bound, AGENT_KEYCODES)).toEqual([]);
  });

  it("round-trips back to the byte-identical original", () => {
    expect(restoreSlotKeycodes(bindAgentKeys(original), ORIGINAL_TOP_SIX)).toBe(original);
  });

  it("refuses to restore agent keycodes as the 'original' layout", () => {
    expect(() => restoreSlotKeycodes(original, AGENT_KEYCODES)).toThrow(/not a usable layout/);
  });
});

describe("verifySlotChange", () => {
  it("reports any change outside the six keys", () => {
    const tampered = JSON.parse(bindAgentKeys(original));
    tampered.profiles[0].layers[0].layout.encoders[0][0] = "KC_VOLU";
    const problems = verifySlotChange(original, JSON.stringify(tampered), AGENT_KEYCODES);
    expect(problems).toEqual([
      "unexpected change at $.profiles[0].layers[0].layout.encoders[0][0]",
    ]);
  });

  it("reports a key that did not take", () => {
    const partial = makeKeymap([...AGENT_KEYCODES.slice(0, 5), "KA_A5"]);
    expect(verifySlotChange(original, partial, AGENT_KEYCODES)).toContain(
      "slot 5 holds KA_A5, expected KV_OAI_AG05",
    );
  });
});
