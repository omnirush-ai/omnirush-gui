import { describe, expect, test } from "bun:test";

import type { ProviderListItem } from "../src/app/types";
import { OMNIRUSH_REASONING_EFFORTS } from "../src/app/constants";
import {
  getModelBehaviorOptions,
  getModelBehaviorSummary,
  nextModelBehaviorValue,
  previousModelBehaviorValue,
} from "../src/app/lib/model-behavior";
import {
  dedupeModelOptions,
  resolveModelDisplayName,
  resolveModelProviderDisplayName,
  resolveModelProviderIconId,
} from "../src/app/utils";
import {
  isDirectModelProvider,
  isInternalModelProvider,
  isSupportedModelProvider,
  providerCatalogRank,
} from "../src/app/lib/provider-catalog";

type ProviderModel = ProviderListItem["models"][string];

const model: ProviderModel = {
  id: "gpt-5.3-codex",
  providerID: "openai",
  api: {
    id: "gpt-5.3-codex",
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "GPT-5.3 Codex",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 1,
    output: 1,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {
    none: {},
    low: {},
    medium: {},
    high: {},
    xhigh: {},
    max: {},
  },
};

const omnirushModel = (id: string, name: string): ProviderModel => ({
  ...model,
  id,
  name,
  providerID: "omnirush",
  api: { id, url: "http://127.0.0.1:8090/omnirush-gateway/v1", npm: "@ai-sdk/openai" },
  variants: {
    low: { reasoning_effort: "low" },
    high: { reasoning_effort: "high" },
    xhigh: { reasoning_effort: "xhigh" },
    max: { reasoning_effort: "max" },
  },
});

const OMNIRUSH_MODELS = [
  omnirushModel("gpt-6-astra", "GPT 6 Astra"),
  omnirushModel("gpt-5.6-sol", "GPT-5.6 Sol"),
];

describe("model behavior options", () => {
  test("offers low, high, xhigh and max for every omnirush.ai model", () => {
    for (const internal of OMNIRUSH_MODELS) {
      const options = getModelBehaviorOptions("omnirush", internal, "omnirush.ai");
      expect(options.map(({ value, label }) => ({ value, label }))).toEqual([
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Xhigh" },
        { value: "max", label: "Max" },
      ]);
      expect(nextModelBehaviorValue(options, "xhigh")).toBe("max");
      expect(nextModelBehaviorValue(options, "max")).toBe("low");
      expect(previousModelBehaviorValue(options, "low")).toBe("max");

      const summary = getModelBehaviorSummary("omnirush", internal, "max", "omnirush.ai");
      expect(summary.value).toBe("max");
      expect(summary.label).toBe("Max");
      expect(getModelBehaviorSummary("omnirush", internal, null, "omnirush.ai").value).toBe("high");
    }
  });

  test("hides the effort levels the engine adds on its own to omnirush.ai models", () => {
    expect([...OMNIRUSH_REASONING_EFFORTS]).toEqual(["low", "high", "xhigh", "max"]);
    for (const internal of OMNIRUSH_MODELS) {
      // What GET /config/providers reports once the engine has merged its
      // OpenAI reasoning defaults into the configured variants.
      const reported: ProviderModel = {
        ...internal,
        variants: {
          ...internal.variants,
          none: { reasoningEffort: "none", reasoningSummary: "auto" },
          minimal: { reasoningEffort: "minimal" },
          medium: { reasoningEffort: "medium", reasoningSummary: "auto" },
          max: { reasoningEffort: "max" },
        },
      };
      const options = getModelBehaviorOptions("omnirush", reported, "omnirush.ai");
      expect(options.map((option) => option.value)).toEqual(["low", "high", "xhigh", "max"]);
      expect(getModelBehaviorSummary("omnirush", reported, null, "omnirush.ai").value).toBe("high");
      expect(getModelBehaviorSummary("omnirush", reported, "medium", "omnirush.ai").value).toBe("high");
      expect(getModelBehaviorSummary("omnirush", reported, "max", "omnirush.ai").value).toBe("max");
    }
  });

  test("shows both omnirush.ai models under the omnirush.ai provider with their display names", () => {
    expect(OMNIRUSH_MODELS.map((internal) => resolveModelDisplayName(internal.id, internal.name)))
      .toEqual(["GPT 6 Astra", "GPT-5.6 Sol"]);
    for (const internal of OMNIRUSH_MODELS) {
      expect(resolveModelProviderDisplayName("omnirush", internal.id, "omnirush.ai", internal.name)).toBe("omnirush.ai");
      expect(resolveModelProviderIconId("omnirush", internal.id, internal.name)).toBe("omnirush");
    }
    expect(dedupeModelOptions([
      { providerID: "omnirush", modelID: "gpt-6-astra" },
      { providerID: "omnirush", modelID: "gpt-5.6-sol" },
      { providerID: "omnirush", modelID: "gpt-6-astra" },
    ])).toEqual([
      { providerID: "omnirush", modelID: "gpt-6-astra" },
      { providerID: "omnirush", modelID: "gpt-5.6-sol" },
    ]);
  });

  test("uses only the raw effort values reported by the model", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(options.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Xhigh" },
    ]);
  });

  test("keeps model and provider identities truthful", () => {
    expect(resolveModelDisplayName("gpt-6-astra", "GPT-6 Astra")).toBe("GPT 6 Astra");
    expect(resolveModelProviderDisplayName("omnirush", "gpt-6-astra")).toBe("omnirush.ai");
    expect(resolveModelProviderDisplayName("omnirush", "gpt-5.6-sol")).toBe("omnirush.ai");
    expect(resolveModelDisplayName("gpt-5.6-sol", "GPT-5.6 Sol")).toBe("GPT-5.6 Sol");
    expect(resolveModelDisplayName("gpt-5.6-terra", "GPT-5.6 Terra")).toBe("GPT-5.6 Terra");
    expect(resolveModelDisplayName("claude-sonnet-4", "Claude Sonnet 4")).toBe("Claude Sonnet 4");
    expect(resolveModelProviderDisplayName("openai", "gpt-5.6-sol", "OpenAI", "GPT-5.6 Sol")).toBe("OpenAI");
    expect(resolveModelProviderIconId("openai", "gpt-5.6-sol", "GPT-5.6 Sol")).toBe("openai");
    expect(dedupeModelOptions([
      { providerID: "openai", modelID: "gpt-5.6-sol" },
      { providerID: "openai", modelID: "gpt-5.6-terra" },
      { providerID: "openai", modelID: "gpt-5.6-sol" },
    ])).toEqual([
      { providerID: "openai", modelID: "gpt-5.6-sol" },
      { providerID: "openai", modelID: "gpt-5.6-terra" },
    ]);
  });

  test("allows only internal and mainstream model providers", () => {
    expect(isInternalModelProvider("omnirush")).toBe(true);
    expect(isInternalModelProvider("lpr_team")).toBe(true);
    expect(isDirectModelProvider("openai")).toBe(true);
    expect(isDirectModelProvider("anthropic")).toBe(true);
    expect(isSupportedModelProvider("google")).toBe(true);
    expect(isSupportedModelProvider("openrouter")).toBe(true);
    expect(isSupportedModelProvider("opencode")).toBe(false);
    expect(isSupportedModelProvider("ollama")).toBe(false);
    expect(providerCatalogRank("omnirush")).toBeLessThan(providerCatalogRank("openai"));
  });

  test("cycles explicit effort values and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(nextModelBehaviorValue(options, "low")).toBe("high");
    expect(nextModelBehaviorValue(options, "xhigh")).toBe("low");
    expect(nextModelBehaviorValue(options, null)).toBe("low");
  });

  test("does not cycle models with fewer than two effort values", () => {
    expect(nextModelBehaviorValue([], null)).toBeNull();
    expect(nextModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });

  test("cycles explicit effort values backward and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(previousModelBehaviorValue(options, "high")).toBe("low");
    expect(previousModelBehaviorValue(options, "low")).toBe("xhigh");
    expect(previousModelBehaviorValue(options, null)).toBe("xhigh");
  });

  test("does not cycle backward with fewer than two effort values", () => {
    expect(previousModelBehaviorValue([], null)).toBeNull();
    expect(previousModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });
});
