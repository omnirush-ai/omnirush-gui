import type { ProviderListItem } from "../types";
import type { ModelBehaviorOption } from "../types";
import { OMNIRUSH_REASONING_EFFORTS } from "../constants";
import { t } from "../../i18n";

type ProviderModel = ProviderListItem["models"][string];

const WELL_KNOWN_VARIANT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
] as const;

const VARIANT_DEFAULT_TARGET = 3;
const VARIANT_DEFAULT_SCORE: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: VARIANT_DEFAULT_TARGET,
  high: 4,
  xhigh: 5,
  ultra: 6,
  max: 6,
};

function defaultBehaviorOption(): ModelBehaviorOption {
  return {
    value: null,
    label: t("settings.provider_default_label"),
    description: t("settings.provider_default_desc"),
  };
}

export const normalizeModelBehaviorValue = (value: string | null) => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "balance" ||
    normalized === "balanced" ||
    normalized === "default" ||
    normalized === "provider-default"
  ) {
    return null;
  }
  return normalized;
};

const getVariantKeys = (model: ProviderModel) => {
  const keys = Object.keys(model.variants ?? {}).flatMap((key) => {
    const normalized = normalizeModelBehaviorValue(key);
    return normalized ? [normalized] : [];
  });
  return Array.from(new Set(keys));
};

const sortVariantKeys = (keys: string[]) =>
  keys.slice().sort((a, b) => {
    const aIndex = WELL_KNOWN_VARIANT_ORDER.indexOf(a as (typeof WELL_KNOWN_VARIANT_ORDER)[number]);
    const bIndex = WELL_KNOWN_VARIANT_ORDER.indexOf(b as (typeof WELL_KNOWN_VARIANT_ORDER)[number]);
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    return a.localeCompare(b);
  });

const getDefaultVariantKey = (keys: string[]) => {
  let selected: string | null = null;
  let selectedScore: number | null = null;

  for (const key of keys) {
    const score = VARIANT_DEFAULT_SCORE[key];
    if (score == null) continue;
    if (selectedScore == null) {
      selected = key;
      selectedScore = score;
      continue;
    }

    const distance = Math.abs(score - VARIANT_DEFAULT_TARGET);
    const selectedDistance = Math.abs(selectedScore - VARIANT_DEFAULT_TARGET);
    if (distance < selectedDistance || (distance === selectedDistance && score > selectedScore)) {
      selected = key;
      selectedScore = score;
    }
  }

  return selected ?? keys[0] ?? null;
};

const providerFamily = (providerID: string, providerName?: string | null) => {
  const normalizedId = providerID.trim().toLowerCase();
  if (["anthropic", "openai", "google", "opencode"].includes(normalizedId)) {
    return normalizedId;
  }

  const normalizedName = providerName?.trim().toLowerCase() ?? "";
  if (normalizedName.includes("anthropic")) return "anthropic";
  if (normalizedName.includes("openai")) return "openai";
  if (normalizedName.includes("google")) return "google";
  if (normalizedName.includes("opencode")) return "opencode";
  return normalizedId;
};

const isOmniRushProvider = (providerID: string) => providerID.trim().toLowerCase() === "omnirush";

const usesGlmDisplayAliases = (
  providerID: string,
  model: ProviderModel,
  _providerName?: string | null,
) => {
  return !isOmniRushProvider(providerID) && [model.id, model.name].some(
    (value) => value?.trim().toLowerCase().includes("gpt") === true,
  );
};

/**
 * omnirush.ai models offer their own catalog effort levels. The server
 * disables every other known effort, so the engine reports exactly those; the
 * filter only keeps an engine default outside the known set off the picker.
 */
const omnirushVariantKeys = (keys: string[]) =>
  keys.filter((key) => (OMNIRUSH_REASONING_EFFORTS as readonly string[]).includes(key));

const getBehaviorTitle = (
  providerID: string,
  model: ProviderModel,
  variantKeys: string[],
  providerName?: string | null,
) => {
  const family = providerFamily(providerID, providerName);
  if (variantKeys.length > 0) {
    if (family === "anthropic") return t("model_behavior.title_extended_thinking");
    if (family === "google") return t("model_behavior.title_reasoning_budget");
    if (
      family === "openai" ||
      family === "opencode" ||
      variantKeys.some((key) => ["none", "minimal", "low", "medium", "high", "xhigh"].includes(key))
    ) {
      return t("model_behavior.title_reasoning_effort");
    }
    return t("app.model_behavior_title");
  }
  if (model.capabilities?.reasoning) return t("model_behavior.title_builtin_reasoning");
  return t("model_behavior.title_standard_generation");
};

const getVariantLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

export const formatGenericBehaviorLabel = (value: string | null) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return defaultBehaviorOption().label;
  return getVariantLabel(normalized);
};

/** Return the next explicit thinking/reasoning variant, wrapping at the end. */
export const nextModelBehaviorValue = (
  options: readonly Pick<ModelBehaviorOption, "value">[],
  current: string | null,
) => {
  const values = options.flatMap((option) => option.value == null ? [] : [option.value]);
  if (values.length < 2) return null;
  const currentIndex = current == null ? -1 : values.indexOf(current);
  return values[(currentIndex + 1) % values.length] ?? null;
};

/** Return the previous explicit thinking/reasoning variant, wrapping at the start. */
export const previousModelBehaviorValue = (
  options: readonly Pick<ModelBehaviorOption, "value">[],
  current: string | null,
) => {
  const values = options.flatMap((option) => option.value == null ? [] : [option.value]);
  if (values.length < 2) return null;
  const currentIndex = current == null ? -1 : values.indexOf(current);
  if (currentIndex === -1) return values[values.length - 1] ?? null;
  return values[(currentIndex - 1 + values.length) % values.length] ?? null;
};

const getVariantDescription = (
  providerID: string,
  key: string,
  label: string,
  providerName?: string | null,
) => {
  const family = providerFamily(providerID, providerName);
  if (key === "none") return t("model_behavior.desc_none");
  if (key === "minimal") return t("model_behavior.desc_minimal");
  if (key === "low") return family === "google"
    ? t("model_behavior.desc_low_google")
    : t("model_behavior.desc_low");
  if (key === "medium") return t("model_behavior.desc_medium");
  if (key === "high") return family === "anthropic"
    ? t("model_behavior.desc_high_anthropic")
    : t("model_behavior.desc_high");
  if (key === "xhigh" || key === "ultra" || key === "max") return family === "anthropic"
    ? t("model_behavior.desc_max_anthropic")
    : t("model_behavior.desc_max");
  return t("model_behavior.desc_generic", { label: label.toLowerCase() });
};

export const getModelBehaviorOptions = (
  providerID: string,
  model: ProviderModel,
  providerName?: string | null,
): ModelBehaviorOption[] => {
  const reportedVariantKeys = sortVariantKeys(getVariantKeys(model));
  const variantKeys = isOmniRushProvider(providerID)
    ? omnirushVariantKeys(reportedVariantKeys)
    : usesGlmDisplayAliases(providerID, model, providerName)
      ? reportedVariantKeys.filter((key) => key === "low" || key === "high" || key === "xhigh")
      : reportedVariantKeys;
  if (!variantKeys.length) return [];
  return variantKeys.map((key) => {
    const label = getVariantLabel(key);
    return {
      value: key,
      label,
      description: getVariantDescription(providerID, key, label, providerName),
    };
  });
};

export const sanitizeModelBehaviorValue = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return null;
  return getModelBehaviorOptions(providerID, model, providerName).some((option) => option.value === normalized)
    ? normalized
    : null;
};

export const getModelBehaviorSummary = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  const options = getModelBehaviorOptions(providerID, model, providerName);
  const sanitized = sanitizeModelBehaviorValue(providerID, model, value, providerName);
  const selectedValue = sanitized ?? getDefaultVariantKey(
    options.flatMap((option) => option.value == null ? [] : [option.value]),
  );
  const selected = options.find((option) => option.value === selectedValue) ?? options[0] ?? null;
  const title = getBehaviorTitle(providerID, model, getVariantKeys(model), providerName);

  if (options.length > 0) {
    return {
      title,
      label: selected?.label ?? defaultBehaviorOption().label,
      description: selected?.description ?? defaultBehaviorOption().description,
      value: selected?.value ?? null,
      options,
    };
  }

  if (model.capabilities?.reasoning) {
    return {
      title,
      label: t("model_behavior.label_builtin"),
      description: t("model_behavior.desc_builtin"),
      value: null,
      options,
    };
  }

  return {
    title,
    label: t("model_behavior.label_standard"),
    description: t("model_behavior.desc_standard"),
    value: null,
    options,
  };
};
