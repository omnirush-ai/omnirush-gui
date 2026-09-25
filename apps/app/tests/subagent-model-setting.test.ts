import { describe, expect, test } from "bun:test";

import type { OmniRushSubagentModelState } from "../src/app/lib/omnirush-server";
import {
  SAME_AS_MAIN_LABEL,
  nextSubagentSetting,
  subagentEffortOptions,
  subagentModelUnavailable,
  subagentSummary,
} from "../src/react-app/domains/settings/subagent-model";
import { BUILTIN_OMNIRUSH_MODEL_IDS } from "../src/app/constants";
import { resolveModelDisplayName } from "../src/app/utils";

const codex = ["low", "high", "xhigh", "max"];
const state: OmniRushSubagentModelState = {
  setting: { model: null, effort: null },
  signedIn: true,
  models: [
    { id: "gpt-6-astra", name: "GPT 6 Astra", family: "OpenAI", default: true, efforts: codex },
    { id: "gpt-6-sol", name: "GPT 6 Sol", family: "OpenAI", default: false, efforts: codex },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", family: "OpenAI", default: false, efforts: codex },
    { id: "meta-muse-spark", name: "Meta Muse Spark", family: "Meta Muse", default: false, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
};

describe("sub-agent model setting (app)", () => {
  test("GPT 6 Sol is built in between Astra and GPT-5.6 Sol, with its display name", () => {
    expect([...BUILTIN_OMNIRUSH_MODEL_IDS]).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]);
    expect(resolveModelDisplayName("gpt-6-sol")).toBe("GPT 6 Sol");
    expect(resolveModelDisplayName("gpt-6-astra")).toBe("GPT 6 Astra");
    expect(resolveModelDisplayName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(resolveModelDisplayName("muse-spark-1.1")).toBe("Meta Muse Spark 1.1");
    expect(resolveModelDisplayName("meta-muse-spark")).toBe("Meta Muse Spark");
  });

  test("effort choices are the picked model's levels; same-as-main offers every catalog level", () => {
    expect(subagentEffortOptions(state, "gpt-6-sol")).toEqual(codex);
    expect(subagentEffortOptions(state, "meta-muse-spark")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(subagentEffortOptions(state, null)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(subagentEffortOptions(undefined, "gpt-6-sol")).toEqual([]);
  });

  test("switching model drops an effort the new model does not offer", () => {
    expect(nextSubagentSetting(state, { model: "gpt-6-sol", effort: "max" }, { model: "meta-muse-spark" })).toEqual({ model: "meta-muse-spark", effort: null });
    expect(nextSubagentSetting(state, { model: "gpt-6-sol", effort: "high" }, { model: "meta-muse-spark" })).toEqual({ model: "meta-muse-spark", effort: "high" });
    expect(nextSubagentSetting(state, { model: "gpt-6-sol", effort: null }, { effort: "xhigh" })).toEqual({ model: "gpt-6-sol", effort: "xhigh" });
    expect(nextSubagentSetting(state, { model: "gpt-6-sol", effort: "high" }, { model: null })).toEqual({ model: null, effort: "high" });
  });

  test("summaries and availability", () => {
    expect(subagentSummary(state, { model: null, effort: null })).toBe(SAME_AS_MAIN_LABEL);
    expect(subagentSummary(state, { model: "gpt-6-sol", effort: null })).toBe("GPT 6 Sol");
    expect(subagentSummary(state, { model: "meta-muse-spark", effort: "xhigh" })).toBe("Meta Muse Spark · Xhigh");
    expect(subagentSummary(state, { model: null, effort: "low" })).toBe("Main model · Low");
    expect(subagentModelUnavailable(state, { model: "muse-spark-1.3", effort: null })).toBe(true);
    expect(subagentModelUnavailable(state, { model: "gpt-6-sol", effort: null })).toBe(false);
    expect(subagentModelUnavailable({ ...state, signedIn: false }, { model: "gpt-6-sol", effort: null })).toBe(true);
  });
});
