import { describe, expect, test } from "bun:test";
import { OmniRushReasoningEffort } from "./omnirush-reasoning-effort.js";

type Hooks = Awaited<ReturnType<typeof OmniRushReasoningEffort>>;

const astra = { id: "gpt-6-astra", providerID: "omnirush" };
const sol = { id: "gpt-5.6-sol", providerID: "omnirush" };

async function run(
  hooks: Hooks,
  input: Parameters<Hooks["chat.params"]>[0],
  options: Record<string, unknown>,
) {
  const params = { options };
  await hooks["chat.params"](input, params);
  const headers: { headers: Record<string, string> } = { headers: {} };
  await hooks["chat.headers"](input, headers);
  return { options: params.options, headers: headers.headers };
}

describe("OmniRushReasoningEffort", () => {
  test("mirrors the ultra variant into reasoningEffort and the private header", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_1", model: { variant: "ultra" } } },
      { reasoning_effort: "ultra", temperature: 0.2 },
    );
    expect(result.options).toEqual({ reasoning_effort: "ultra", reasoningEffort: "ultra", temperature: 0.2 });
    expect(result.headers).toEqual({ "x-omnirush-reasoning-effort": "ultra" });
  });

  test("applies to every omnirush.ai model", async () => {
    const hooks = await OmniRushReasoningEffort();
    for (const [index, model] of [astra, sol].entries()) {
      const result = await run(
        hooks,
        { agent: "omnirush", model, message: { id: `msg_${index}`, model: { variant: "xhigh" } } },
        { reasoning_effort: "xhigh" },
      );
      expect(result.options.reasoningEffort).toBe("xhigh");
      expect(result.headers["x-omnirush-reasoning-effort"]).toBe("xhigh");
    }
  });

  test("prefers the variant options over the variant name", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_2", model: { variant: "max" } } },
      { reasoning_effort: "ultra" },
    );
    expect(result.options.reasoningEffort).toBe("ultra");
    expect(result.headers["x-omnirush-reasoning-effort"]).toBe("ultra");
  });

  test("falls back to the variant name when the options carry no effort", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_3", model: { variant: "High" } } },
      {},
    );
    expect(result.options).toEqual({ reasoningEffort: "high" });
    expect(result.headers).toEqual({ "x-omnirush-reasoning-effort": "high" });
  });

  test("leaves requests without a selected effort untouched", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(hooks, { agent: "omnirush", model: astra, message: { id: "msg_4", model: {} } }, { temperature: 0.2 });
    expect(result.options).toEqual({ temperature: 0.2 });
    expect(result.headers).toEqual({});
  });

  test("ignores unknown effort values", async () => {
    const hooks = await OmniRushReasoningEffort();
    const result = await run(
      hooks,
      { agent: "omnirush", model: astra, message: { id: "msg_5", model: { variant: "turbo" } } },
      { reasoning_effort: "turbo" },
    );
    expect(result.options).toEqual({ reasoning_effort: "turbo" });
    expect(result.headers).toEqual({});
  });

  test("skips other providers and title generation", async () => {
    const hooks = await OmniRushReasoningEffort();
    const external = await run(
      hooks,
      { agent: "omnirush", model: { id: "gpt-5.5", providerID: "openai" }, message: { id: "msg_6", model: { variant: "ultra" } } },
      { reasoning_effort: "ultra" },
    );
    expect(external.options).toEqual({ reasoning_effort: "ultra" });
    expect(external.headers).toEqual({});
    const title = await run(
      hooks,
      { agent: "title", model: astra, message: { id: "msg_7", model: { variant: "ultra" } } },
      {},
    );
    expect(title.options).toEqual({});
    expect(title.headers).toEqual({});
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./omnirush-reasoning-effort.js");
    expect(Object.keys(mod)).toEqual(["OmniRushReasoningEffort"]);
  });
});
