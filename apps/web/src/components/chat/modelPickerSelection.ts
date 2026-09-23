import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import type { ModelEsque } from "./providerIconUtils";

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

export function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    (input.entry.driverKind === "opencode" || input.entry.driverKind === "antigravity") &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

/** Resolve a picker choice with the instance's driver normalization and composer restrictions. */
export function resolveModelPickerSelection(input: {
  entry: ProviderInstanceEntry | undefined;
  options: ReadonlyArray<ModelEsque> | undefined;
  model: string;
  getModelDisabledReason?:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
}): string | null {
  if (!input.entry || !input.options) return null;
  if (input.getModelDisabledReason?.(input.entry.instanceId, input.model)) return null;
  return resolveSelectableModel(input.entry.driverKind, input.model, input.options);
}

/** Cycle in the same instance and catalog order displayed by the favorites tab. */
export function getAdjacentFavoriteModel(input: {
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  favorites: ReadonlyArray<{ provider: ProviderInstanceId; model: string }>;
  activeInstanceId: ProviderInstanceId;
  model: string;
  direction: 1 | -1;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null | undefined;
  getModelDisabledReason?:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
}): { instanceId: ProviderInstanceId; model: string } | null {
  const favorites = new Set(
    input.favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model)),
  );
  const activeEntry = input.instanceEntries.find(
    (entry) => entry.instanceId === input.activeInstanceId,
  );
  const activeModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: input.model,
      options: input.modelOptionsByInstance.get(input.activeInstanceId) ?? [],
    })?.slug ?? input.model;
  const candidates = input.instanceEntries.flatMap((entry) => {
    if (
      input.lockedProvider !== null &&
      (entry.driverKind !== input.lockedProvider ||
        (input.lockedContinuationGroupKey &&
          entry.continuationGroupKey !== input.lockedContinuationGroupKey))
    )
      return [];
    const options = input.modelOptionsByInstance.get(entry.instanceId) ?? [];
    return options.flatMap((option) => {
      if (
        option.isUnavailable ||
        !favorites.has(providerModelKey(entry.instanceId, option.slug)) ||
        !shouldIncludeModelPickerOption({
          entry,
          option,
          activeInstanceId: input.activeInstanceId,
          activeModel,
        })
      )
        return [];
      const model = resolveModelPickerSelection({
        entry,
        options,
        model: option.slug,
        getModelDisabledReason: input.getModelDisabledReason,
      });
      return model ? [{ instanceId: entry.instanceId, slug: model }] : [];
    });
  });
  const ordered = sortProviderModelItems(candidates, {
    instanceOrder: input.instanceEntries.map((entry) => entry.instanceId),
  });
  if (ordered.length === 0) return null;
  const currentIndex = ordered.findIndex(
    (candidate) =>
      candidate.instanceId === input.activeInstanceId && candidate.slug === activeModel,
  );
  const index =
    currentIndex < 0
      ? input.direction === 1
        ? 0
        : ordered.length - 1
      : (currentIndex + input.direction + ordered.length) % ordered.length;
  const selected = ordered[index]!;
  return { instanceId: selected.instanceId, model: selected.slug };
}
