import { describe, expect, test } from "bun:test";

import {
  MODEL_PICKER_DEFAULT_SUBTITLE,
  MODEL_PICKER_UNAVAILABLE_SUBTITLE,
  resolveModelPickerSubtitle,
} from "../src/react-app/domains/session/modals/model-picker-modal";
import { compareGroupModels, providerDisplayGroup } from "../src/app/lib/provider-catalog";
import { resolveModelProviderDisplayName } from "../src/app/utils";

describe("model picker subtitle", () => {
  test("keeps the normal session subtitle by default", () => {
    expect(resolveModelPickerSubtitle(undefined)).toBe(MODEL_PICKER_DEFAULT_SUBTITLE);
  });

  test("supports the unavailable-model recovery subtitle", () => {
    expect(resolveModelPickerSubtitle(MODEL_PICKER_UNAVAILABLE_SUBTITLE)).toBe(
      "The model you were using is no longer available, please select a different model for this session.",
    );
  });
});

describe("Claude models under omnirush.ai", () => {
  test("one omnirush.ai group of 6, Claude after GPT and Kimi; picks keep their provider id", () => {
    const options = [
      { providerID: "omnirush-claude", modelID: "claude-opus-5-5", title: "Claude Opus 5.5" },
      { providerID: "omnirush", modelID: "kimi-k3.1-pro", title: "Kimi K3.1 Pro" },
      { providerID: "omnirush-claude", modelID: "claude-fable-5-2", title: "Claude Fable 5.2" },
      { providerID: "omnirush", modelID: "gpt-6-sol", title: "GPT 6 Sol" },
      { providerID: "omnirush", modelID: "gpt-6.1-sol", title: "GPT 6.1 Sol" },
      { providerID: "omnirush", modelID: "gpt-6-astra", title: "GPT 6 Astra" },
    ];
    expect(new Set(options.map((option) => providerDisplayGroup(option.providerID)))).toEqual(new Set(["omnirush"]));
    expect(new Set(options.map((option) => resolveModelProviderDisplayName(option.providerID, option.modelID, option.providerID === "omnirush" ? "omnirush.ai" : "Claude")))).toEqual(new Set(["omnirush.ai"]));
    expect([...options].sort(compareGroupModels).map((option) => `${option.providerID}/${option.title}`)).toEqual([
      "omnirush/GPT 6 Astra", "omnirush/GPT 6 Sol", "omnirush/GPT 6.1 Sol", "omnirush/Kimi K3.1 Pro",
      "omnirush-claude/Claude Fable 5.2", "omnirush-claude/Claude Opus 5.5",
    ]);
    expect(providerDisplayGroup("openai")).toBe("openai");
  });
});
