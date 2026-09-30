import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendCatalogBody } from "./__fixtures__/omnirush-model-catalog.js";
import { builtinOmniRushModelCatalog, sanitizeOmniRushModelCatalog } from "./omnirush-model-catalog.js";
import {
  SubagentModelRefusals,
  nearestEffort,
  readSubagentModelSetting,
  resolveSubagentModel,
  sanitizeSubagentModelSetting,
  subagentFallbackNote,
  subagentModelSettingPath,
  subagentSettingFor,
  writeSubagentModelSetting,
} from "./omnirush-subagent-model.js";
import type { ServerConfig } from "./types.js";

const catalog = sanitizeOmniRushModelCatalog(backendCatalogBody())!;
const astra = { providerID: "omnirush", modelID: "gpt-6-astra" };
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function config(): Promise<ServerConfig> {
  const dir = await mkdtemp(join(tmpdir(), "omnirush-subagent-model-"));
  dirs.push(dir);
  return { configPath: join(dir, "server.json"), workspaces: [] } as unknown as ServerConfig;
}

describe("sub-agent model setting", () => {
  test("missing settings default to GPT-5.6 Sol; explicit values remain safe", async () => {
    const cfg = await config();
    expect(await readSubagentModelSetting(cfg)).toEqual({ model: "gpt-5.6-sol", effort: null });
    expect(sanitizeSubagentModelSetting({ model: "gpt-6-sol", effort: "HIGH" })).toEqual({ model: "gpt-6-sol", effort: "high" });
    expect(sanitizeSubagentModelSetting({ model: "../etc", effort: "turbo" })).toEqual({ model: null, effort: null });
    expect(sanitizeSubagentModelSetting({ model: "", effort: "ultra" })).toEqual({ model: null, effort: "max" });
    expect(sanitizeSubagentModelSetting("nope")).toEqual({ model: "gpt-5.6-sol", effort: null });
  });

  test("persists atomically and survives a corrupt file", async () => {
    const cfg = await config();
    await writeSubagentModelSetting(cfg, { model: "meta-muse-spark", effort: "medium" });
    expect(await readSubagentModelSetting(cfg)).toEqual({ model: "meta-muse-spark", effort: "medium" });
    await writeFile(subagentModelSettingPath(cfg), "{not json", "utf8");
    expect(await readSubagentModelSetting(cfg)).toEqual({ model: "gpt-5.6-sol", effort: null });
  });
});

describe("nearest effort", () => {
  const codex = ["low", "high", "xhigh", "max"];
  const muse = ["minimal", "low", "medium", "high", "xhigh"];
  test("keeps an offered effort and maps the rest to the closest (ties go higher)", () => {
    expect(nearestEffort("high", codex)).toBe("high");
    expect(nearestEffort("max", muse)).toBe("xhigh");
    expect(nearestEffort("none", muse)).toBe("minimal");
    expect(nearestEffort("medium", codex)).toBe("high");
    expect(nearestEffort("minimal", codex)).toBe("low");
    expect(nearestEffort("ultra", muse)).toBe("xhigh");
    expect(nearestEffort("bogus", codex)).toBeNull();
    expect(nearestEffort(null, codex)).toBeNull();
    expect(nearestEffort("high", [])).toBeNull();
  });
});

describe("resolve a sub-agent prompt", () => {
  test("a model the user named for a sub-agent replaces the pick and is checked like one", () => {
    const stored = { model: "gpt-6-sol", effort: "high" } as const;
    expect(subagentSettingFor(stored, null)).toEqual(stored);
    // Its own effort wins; without one the setting's effort applies.
    expect(subagentSettingFor(stored, { providerID: "omnirush", modelID: "meta-muse-spark", variant: "low" })).toEqual({ model: "meta-muse-spark", effort: "low" });
    expect(subagentSettingFor(stored, { providerID: "omnirush", modelID: "meta-muse-spark", variant: null })).toEqual({ model: "meta-muse-spark", effort: "high" });
    expect(subagentSettingFor({ model: null, effort: null }, { providerID: "omnirush", modelID: "gpt-6-sol" })).toEqual({ model: "gpt-6-sol", effort: null });
    // Another provider's model needs no omnirush.ai checks: kept as the engine started it.
    expect(subagentSettingFor(stored, { providerID: "anthropic", modelID: "claude-x" })).toBeNull();

    // Resolved like a pick: served, it runs; not in the account's catalog, the main model runs instead.
    const named = subagentSettingFor(stored, { providerID: "omnirush", modelID: "meta-muse-spark", variant: "low" })!;
    expect(resolveSubagentModel({ setting: named, catalog, gateway: true, inherited: { ...astra, variant: "max" }, main: { ...astra, variant: "max" } }).model)
      .toEqual({ providerID: "omnirush", modelID: "meta-muse-spark" });
    const unknown = subagentSettingFor(stored, { providerID: "omnirush", modelID: "not-served-model" })!;
    const resolved = resolveSubagentModel({ setting: unknown, catalog, gateway: true, inherited: astra, main: astra });
    expect(resolved.model).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
    expect(resolved.fallback?.reason).toBe("not_in_catalog");
  });

  test("untouched setting changes nothing", () => {
    expect(resolveSubagentModel({
      setting: { model: null, effort: null },
      catalog,
      gateway: true,
      inherited: { ...astra, variant: "max" },
    })).toEqual({});
  });

  test("a picked catalog model runs the sub-agent; the main effort maps to the model's nearest level", () => {
    expect(resolveSubagentModel({
      setting: { model: "meta-muse-spark", effort: null },
      catalog,
      gateway: true,
      inherited: { ...astra, variant: "max" },
      main: { ...astra, variant: "max" },
    })).toEqual({
      model: { providerID: "omnirush", modelID: "meta-muse-spark" },
      variant: "xhigh",
      gatewayFallback: { model: "gpt-6-astra", effort: "max" },
    });
  });

  test("a picked effort is used on the picked model and mapped for the fallback", () => {
    expect(resolveSubagentModel({
      setting: { model: "gpt-6-sol", effort: "high" },
      catalog,
      gateway: true,
      inherited: { ...astra, variant: "low" },
      main: { ...astra, variant: "low" },
    })).toEqual({
      model: { providerID: "omnirush", modelID: "gpt-6-sol" },
      variant: "high",
      gatewayFallback: { model: "gpt-6-astra", effort: "high" },
    });
    expect(resolveSubagentModel({
      setting: { model: "muse-spark-1.1", effort: "medium" },
      catalog,
      gateway: true,
      inherited: astra,
      main: astra,
    })).toMatchObject({ variant: "medium", gatewayFallback: { model: "gpt-6-astra", effort: "high" } });
  });

  test("effort only: the sub-agent keeps the delegating agent's model", () => {
    expect(resolveSubagentModel({
      setting: { model: null, effort: "low" },
      catalog,
      gateway: true,
      inherited: { providerID: "omnirush", modelID: "meta-muse-spark", variant: "high" },
    })).toEqual({ model: { providerID: "omnirush", modelID: "meta-muse-spark" }, variant: "low" });
    // Another provider's model: nothing to map, the prompt stays as it is.
    expect(resolveSubagentModel({
      setting: { model: null, effort: "low" },
      catalog,
      gateway: true,
      inherited: { providerID: "openai", modelID: "gpt-5", variant: "high" },
    })).toEqual({});
  });

  test("a model outside the account's catalog, a refused model, or no account falls back to the main model", () => {
    const withoutMuse = builtinOmniRushModelCatalog();
    const notListed = resolveSubagentModel({
      setting: { model: "meta-muse-spark", effort: null },
      catalog: withoutMuse,
      gateway: true,
      inherited: { ...astra, variant: "xhigh" },
      main: { ...astra, variant: "xhigh" },
    });
    expect(notListed).toEqual({
      model: astra,
      variant: "xhigh",
      fallback: {
        requested: "meta-muse-spark",
        requestedName: "meta-muse-spark",
        used: "gpt-6-astra",
        usedName: "GPT 6 Astra",
        reason: "not_in_catalog",
      },
    });
    expect(subagentFallbackNote(notListed.fallback!)).toBe("ran on GPT 6 Astra: meta-muse-spark is not available to this account");

    const refusals = new SubagentModelRefusals(() => 1_000, 60_000);
    refusals.mark("gpt-6-sol", "model_unavailable");
    const refused = resolveSubagentModel({
      setting: { model: "gpt-6-sol", effort: "max" },
      catalog,
      gateway: true,
      inherited: astra,
      main: { ...astra, variant: "low" },
      refused: (model) => refusals.isRefused(model),
    });
    expect(refused).toMatchObject({ model: astra, variant: "max", fallback: { reason: "refused", usedName: "GPT 6 Astra", requestedName: "GPT 6 Sol" } });

    expect(resolveSubagentModel({
      setting: { model: "gpt-6-sol", effort: null },
      catalog,
      gateway: false,
      inherited: astra,
    }).fallback?.reason).toBe("signed_out");
  });

  test("nested layers fall back to the main session's model, not the delegating sub-agent's", () => {
    // A grandchild inherits the picked model from its parent sub-agent.
    const nested = resolveSubagentModel({
      setting: { model: "gpt-6-sol", effort: null },
      catalog,
      gateway: true,
      inherited: { providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" },
      main: { ...astra, variant: "xhigh" },
    });
    expect(nested).toEqual({
      model: { providerID: "omnirush", modelID: "gpt-6-sol" },
      variant: "xhigh",
      gatewayFallback: { model: "gpt-6-astra", effort: "xhigh" },
    });
    // Without the main session's model, the catalog default stands in.
    expect(resolveSubagentModel({
      setting: { model: "gpt-6-sol", effort: null },
      catalog,
      gateway: true,
      inherited: { providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" },
    }).gatewayFallback).toEqual({ model: "gpt-6-astra", effort: null });
  });

  test("the picked model equal to the main one needs no gateway fallback", () => {
    expect(resolveSubagentModel({
      setting: { model: "gpt-6-astra", effort: "low" },
      catalog,
      gateway: true,
      inherited: { ...astra, variant: "max" },
      main: { ...astra, variant: "max" },
    })).toEqual({ model: astra, variant: "low" });
  });

  test("refusals expire after the cooldown", () => {
    let now = 0;
    const refusals = new SubagentModelRefusals(() => now, 1_000);
    refusals.mark("meta-muse-spark", "http_503");
    expect(refusals.isRefused("meta-muse-spark")).toBe(true);
    now = 1_001;
    expect(refusals.isRefused("meta-muse-spark")).toBe(false);
  });
});
