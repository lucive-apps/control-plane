import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getAdjacentFavoriteModel, resolveModelPickerSelection } from "./modelPickerSelection";
import type { ModelEsque } from "./providerIconUtils";

function entry(driver: string, id = driver, overrides: Partial<ServerProvider> = {}) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-23T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...overrides,
    },
  ])[0]!;
}

const codex = entry("codex");
const claude = entry("claudeAgent");
const models = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
  [claude.instanceId, [{ slug: "opus", name: "Opus" }]],
  [
    codex.instanceId,
    [
      { slug: "gpt-b", name: "B" },
      { slug: "gpt-a", name: "A" },
    ],
  ],
]);
const favorites = [
  { provider: claude.instanceId, model: "opus" },
  { provider: codex.instanceId, model: "gpt-a" },
  { provider: codex.instanceId, model: "gpt-b" },
];
const base = {
  instanceEntries: [codex, claude],
  modelOptionsByInstance: models,
  favorites,
  activeInstanceId: codex.instanceId,
  model: "gpt-b",
  direction: 1 as const,
  lockedProvider: null,
};

describe("getAdjacentFavoriteModel", () => {
  it("uses the favorites tab's provider and catalog order, not storage insertion order", () => {
    expect(getAdjacentFavoriteModel(base)).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-a",
    });
  });

  it("cycles across providers and wraps in either direction", () => {
    expect(getAdjacentFavoriteModel({ ...base, model: "gpt-a" })).toEqual({
      instanceId: claude.instanceId,
      model: "opus",
    });
    expect(
      getAdjacentFavoriteModel({ ...base, activeInstanceId: claude.instanceId, model: "opus" }),
    ).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-b",
    });
    expect(getAdjacentFavoriteModel({ ...base, direction: -1 })).toEqual({
      instanceId: claude.instanceId,
      model: "opus",
    });
  });

  it("starts at the first or last favorite when the current model is not a favorite", () => {
    expect(getAdjacentFavoriteModel({ ...base, model: "other" })).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-b",
    });
    expect(getAdjacentFavoriteModel({ ...base, model: "other", direction: -1 })).toEqual({
      instanceId: claude.instanceId,
      model: "opus",
    });
  });

  it("does nothing for no favorites or no available favorites", () => {
    expect(getAdjacentFavoriteModel({ ...base, favorites: [] })).toBeNull();
    expect(getAdjacentFavoriteModel({ ...base, modelOptionsByInstance: new Map() })).toBeNull();
    expect(
      getAdjacentFavoriteModel({
        ...base,
        favorites: [{ provider: codex.instanceId, model: "removed" }],
      }),
    ).toBeNull();
  });

  it.each([1, -1] as const)("selects the single favorite for direction %s", (direction) => {
    const only = [{ provider: claude.instanceId, model: "opus" }];
    expect(getAdjacentFavoriteModel({ ...base, favorites: only, direction })).toEqual({
      instanceId: claude.instanceId,
      model: "opus",
    });
    expect(
      getAdjacentFavoriteModel({
        ...base,
        favorites: only,
        direction,
        activeInstanceId: claude.instanceId,
        model: "opus",
      }),
    ).toEqual({
      instanceId: claude.instanceId,
      model: "opus",
    });
  });

  it("skips unavailable models and composer-disabled choices", () => {
    const unavailable = new Map(models);
    unavailable.set(codex.instanceId, [
      { slug: "gpt-b", name: "B" },
      { slug: "gpt-a", name: "A", isUnavailable: true },
    ]);
    expect(getAdjacentFavoriteModel({ ...base, modelOptionsByInstance: unavailable })).toEqual({
      instanceId: claude.instanceId,
      model: "opus",
    });
    expect(
      getAdjacentFavoriteModel({
        ...base,
        getModelDisabledReason: (_, model) => (model === "gpt-a" ? "Blocked" : null),
      }),
    ).toEqual({ instanceId: claude.instanceId, model: "opus" });
  });

  it.each([
    { enabled: false },
    { status: "error" as const },
    { availability: "unavailable" as const },
  ])("skips unavailable instances: %j", (overrides) => {
    const unavailableClaude = entry("claudeAgent", "claudeAgent", overrides);
    expect(
      getAdjacentFavoriteModel({
        ...base,
        model: "gpt-a",
        instanceEntries: [codex, unavailableClaude],
      }),
    ).toEqual({ instanceId: codex.instanceId, model: "gpt-b" });
  });

  it("respects provider and continuation group locks", () => {
    expect(
      getAdjacentFavoriteModel({
        ...base,
        model: "gpt-a",
        lockedProvider: codex.driverKind,
      }),
    ).toEqual({ instanceId: codex.instanceId, model: "gpt-b" });
    expect(
      getAdjacentFavoriteModel({
        ...base,
        lockedProvider: codex.driverKind,
        lockedContinuationGroupKey: "different",
      }),
    ).toBeNull();
  });

  it("resolves Antigravity's active default marker before advancing and never offers the marker", () => {
    const antigravity = entry("antigravity");
    expect(
      getAdjacentFavoriteModel({
        ...base,
        instanceEntries: [antigravity],
        activeInstanceId: antigravity.instanceId,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        modelOptionsByInstance: new Map([
          [
            antigravity.instanceId,
            [
              { slug: ANTIGRAVITY_DEFAULT_MODEL, name: "Default" },
              { slug: "gemini-fast", name: "Fast", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
              { slug: "gemini-pro", name: "Pro" },
            ],
          ],
        ]),
        favorites: [
          { provider: antigravity.instanceId, model: ANTIGRAVITY_DEFAULT_MODEL },
          { provider: antigravity.instanceId, model: "gemini-fast" },
          { provider: antigravity.instanceId, model: "gemini-pro" },
        ],
      }),
    ).toEqual({ instanceId: antigravity.instanceId, model: "gemini-pro" });
  });

  it("keeps custom instances of the same provider distinct", () => {
    const personal = entry("codex", "codex_personal");
    expect(
      getAdjacentFavoriteModel({
        ...base,
        instanceEntries: [codex, personal],
        modelOptionsByInstance: new Map([
          ...models,
          [personal.instanceId, models.get(codex.instanceId)!],
        ]),
        favorites: [
          { provider: codex.instanceId, model: "gpt-b" },
          { provider: personal.instanceId, model: "gpt-b" },
        ],
      }),
    ).toEqual({ instanceId: personal.instanceId, model: "gpt-b" });
  });

  it("advances each time when repeated dial turns use the resulting selection", () => {
    let selection = { instanceId: base.activeInstanceId, model: base.model };
    const sequence = [];
    for (let index = 0; index < 7; index++) {
      selection = getAdjacentFavoriteModel({
        ...base,
        activeInstanceId: selection.instanceId,
        model: selection.model,
      })!;
      sequence.push(selection.model);
    }
    expect(sequence).toEqual(["gpt-a", "opus", "gpt-b", "gpt-a", "opus", "gpt-b", "gpt-a"]);
  });
});

describe("resolveModelPickerSelection", () => {
  it("uses the driver's picker normalization for custom instances and aliases", () => {
    expect(
      resolveModelPickerSelection({
        entry: entry("codex", "codex_personal"),
        options: [{ slug: "gpt-5", name: "GPT Five", aliases: ["five"] }],
        model: "FIVE",
      }),
    ).toBe("gpt-5");
  });

  it("rejects missing catalogs and disabled selections", () => {
    expect(
      resolveModelPickerSelection({ entry: codex, options: undefined, model: "gpt-b" }),
    ).toBeNull();
    expect(
      resolveModelPickerSelection({
        entry: codex,
        options: models.get(codex.instanceId),
        model: "gpt-b",
        getModelDisabledReason: () => "Blocked",
      }),
    ).toBeNull();
  });
});
