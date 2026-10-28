// The model's own web search (web-search.ts): off unless the environment or
// the server's switch turns it on; only models with the capability (and on
// the server's list) get `options.hostedWebSearch`; off, the engine config is
// byte for byte what it was before.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendCatalogBody } from "./__fixtures__/omnirush-model-catalog.js";
import { engineModelsFromCatalog, sanitizeOmniRushModelCatalog } from "./omnirush-model-catalog.js";
import { buildOmniRushRuntimeConfigObjectFromSnapshot } from "./omnirush-runtime-config.js";
import {
  WEB_SEARCH_SERVER_FILE,
  modelHasWebSearch,
  rememberWebSearchSwitch,
  watchWebSearchSwitch,
  webSearchServerSwitch,
  webSearchSetting,
  webSearchToolOff,
  writeUserWebSearch,
} from "./web-search.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnirush-web-search-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const catalog = sanitizeOmniRushModelCatalog(backendCatalogBody())!;
const gateway = { baseUrl: "http://127.0.0.1:48123/omnirush-gateway/v1" };
const serverBlock = { search_context_size: "medium", models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"], clients: ["cli", "desktop"], rollout_percent: 100 };

describe("server switch", () => {
  test("only an explicit enabled:true block is on; clients and rollout are the server's", () => {
    expect(webSearchServerSwitch({})).toEqual({ enabled: false, searchContextSize: "medium", models: null });
    expect(webSearchServerSwitch(null)).toEqual({ enabled: false, searchContextSize: "medium", models: null });
    expect(webSearchServerSwitch({ web_search: true }).enabled).toBe(false);
    expect(webSearchServerSwitch({ web_search: { enabled: "true" } }).enabled).toBe(false);
    expect(webSearchServerSwitch({ web_search: { enabled: true, search_context_size: "huge" } }).searchContextSize).toBe("medium");
    expect(webSearchServerSwitch({ web_search: { ...serverBlock, enabled: true, models: ["gpt-6-astra", 3, "bad id"] } }).models).toEqual(["gpt-6-astra"]);
    expect(webSearchServerSwitch({ web_search: { ...serverBlock, enabled: false } }).enabled).toBe(false);
    expect(webSearchServerSwitch({ web_search: { ...serverBlock, enabled: true, rollout_percent: 0, clients: ["cli"] } }).enabled).toBe(true);
  });

  test("remembered from every answer (a missing block is off); whether it changed", () => {
    const dir = tmp();
    expect(webSearchSetting({ env: {}, stateDir: dir })).toEqual({ enabled: false, source: "default", searchContextSize: "medium", models: null });
    // The first answer without the block changes nothing.
    expect(rememberWebSearchSwitch(dir, { schema_versions: [1, 2, 3] })).toBe(false);
    expect(rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: true, search_context_size: "high" } })).toBe(true);
    expect(rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: true, search_context_size: "high" } })).toBe(false);
    expect(webSearchSetting({ env: {}, stateDir: dir })).toEqual({ enabled: true, source: "server", searchContextSize: "high", models: serverBlock.models });
    expect(statSync(join(dir, WEB_SEARCH_SERVER_FILE)).mode & 0o777).toBe(0o600);
    // No answer at all keeps the last one.
    expect(rememberWebSearchSwitch(dir, null)).toBe(false);
    expect(webSearchSetting({ env: {}, stateDir: dir }).enabled).toBe(true);
    // An older server (no block) turns it off.
    expect(rememberWebSearchSwitch(dir, { schema_versions: [1, 2, 3] })).toBe(true);
    expect(webSearchSetting({ env: {}, stateDir: dir }).enabled).toBe(false);
    // A broken file is no answer.
    writeFileSync(join(dir, WEB_SEARCH_SERVER_FILE), "{");
    expect(webSearchSetting({ env: {}, stateDir: dir }).source).toBe("default");
  });

  test("OMNIRUSH_WEB_SEARCH decides over the server", () => {
    const dir = tmp();
    rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: true } });
    for (const off of ["0", "off", " OFF ", "false", "no"]) expect(webSearchSetting({ env: { OMNIRUSH_WEB_SEARCH: off }, stateDir: dir }).enabled).toBe(false);
    rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: false } });
    expect(webSearchSetting({ env: { OMNIRUSH_WEB_SEARCH: "1" }, stateDir: dir })).toMatchObject({ enabled: true, source: "env" });
  });

  test("the watcher applies a change once and keeps the last answer when a read fails", async () => {
    const dir = tmp();
    const answers: Array<() => Promise<unknown>> = [
      async () => ({ web_search: { ...serverBlock, enabled: true } }),
      async () => { throw new Error("offline"); },
      async () => ({ web_search: { ...serverBlock, enabled: true } }),
    ];
    let applied = 0;
    const stop = watchWebSearchSwitch({ stateDir: dir, read: () => (answers.shift() ?? (async () => null))(), apply: async () => { applied += 1; }, everyMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();
    expect(applied).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, WEB_SEARCH_SERVER_FILE), "utf8")).enabled).toBe(true);
  });
});

describe("engine config", () => {
  test("models: the capability, then the server's list", () => {
    const on = { enabled: true, searchContextSize: "medium" as const, models: null };
    expect(modelHasWebSearch(catalog[0], on)).toBe(true);
    expect(modelHasWebSearch({ id: "x", capabilities: { ...catalog[0]!.capabilities, web_search: false } }, on)).toBe(false);
    expect(modelHasWebSearch(catalog[0], { ...on, enabled: false })).toBe(false);
    expect(modelHasWebSearch(catalog[1], { ...on, models: ["gpt-6-astra"] })).toBe(false);
    expect(modelHasWebSearch(catalog[0], null)).toBe(false);
    expect(modelHasWebSearch(undefined, on)).toBe(false);
  });

  test("off (no switch, an off switch, an off override): byte for byte the config without web search", () => {
    const before = JSON.stringify(buildOmniRushRuntimeConfigObjectFromSnapshot({}, gateway, {}, catalog));
    const dir = tmp();
    for (const setting of [
      null,
      webSearchSetting({ env: {}, stateDir: dir }),
      { enabled: false, searchContextSize: "high" as const, models: null },
      webSearchSetting({ env: { OMNIRUSH_WEB_SEARCH: "0" }, stateDir: dir }),
    ]) {
      expect(JSON.stringify(buildOmniRushRuntimeConfigObjectFromSnapshot({}, gateway, {}, catalog, undefined, undefined, setting))).toBe(before);
    }
    for (const model of Object.values(engineModelsFromCatalog(catalog))) expect(model.options).not.toHaveProperty("hostedWebSearch");
  });

  test("on: hostedWebSearch only on the models the server lists; nothing else changes", () => {
    const setting = { enabled: true, searchContextSize: "low" as const, models: serverBlock.models };
    const off = buildOmniRushRuntimeConfigObjectFromSnapshot({}, gateway, {}, catalog) as { provider: { omnirush: { models: Record<string, Record<string, unknown>> } } };
    const on = buildOmniRushRuntimeConfigObjectFromSnapshot({}, gateway, {}, catalog, undefined, undefined, setting) as typeof off;
    const models = on.provider.omnirush.models;
    for (const id of serverBlock.models) expect(models[id]!.options).toEqual({ reasoningEffort: "high", hostedWebSearch: { searchContextSize: "low" } });
    for (const id of ["meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]) expect(models[id]!.options).toEqual({ reasoningEffort: "high" });
    for (const [id, model] of Object.entries(models)) {
      // Only hostedWebSearch is added; the default effort and the rest stay as they were.
      const { hostedWebSearch: _search, ...options } = model.options as Record<string, unknown>;
      expect([id, { ...model, options } as Record<string, unknown>]).toEqual([id, off.provider.omnirush.models[id]!]);
    }
    const strip = (config: typeof off) => JSON.stringify({ ...config, provider: null });
    expect(strip(on)).toBe(strip(off));
  });
});

describe("the user's Settings switch", () => {
  test("off: no hosted web search on any model even with the server's switch on; on: the server decides", () => {
    const dir = tmp();
    rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: true } });
    const hosted = (setting: ReturnType<typeof webSearchSetting>) =>
      Object.entries(engineModelsFromCatalog(catalog, setting)).filter(([, model]) => (model.options as Record<string, unknown> | undefined)?.hostedWebSearch).map(([id]) => id);
    expect(webSearchSetting({ env: {}, stateDir: dir })).toMatchObject({ enabled: true, source: "server" });
    expect(hosted(webSearchSetting({ env: {}, stateDir: dir }))).toEqual(serverBlock.models);
    writeUserWebSearch(dir, false);
    expect(webSearchSetting({ env: {}, stateDir: dir })).toMatchObject({ enabled: false, source: "user" });
    expect(hosted(webSearchSetting({ env: {}, stateDir: dir }))).toEqual([]);
    // The user's off wins over a test rig's OMNIRUSH_WEB_SEARCH=1 too.
    expect(webSearchSetting({ env: { OMNIRUSH_WEB_SEARCH: "1" }, stateDir: dir })).toMatchObject({ enabled: false, source: "user" });
    writeUserWebSearch(dir, true);
    expect(hosted(webSearchSetting({ env: {}, stateDir: dir }))).toEqual(serverBlock.models);
    // The server's switch off wins over the user's on.
    rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: false } });
    expect(hosted(webSearchSetting({ env: {}, stateDir: dir }))).toEqual([]);
  });
});

test("no websearch tool: the user's off in both modes; the account's off outside stock mode only", () => {
  const dir = tmp();
  rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: true } });
  for (const stock of [false, true]) expect(webSearchToolOff(webSearchSetting({ env: {}, stateDir: dir }), stock)).toBe(false);
  rememberWebSearchSwitch(dir, { web_search: { ...serverBlock, enabled: false } });
  expect(webSearchToolOff(webSearchSetting({ env: {}, stateDir: dir }), false)).toBe(true);
  expect(webSearchToolOff(webSearchSetting({ env: {}, stateDir: dir }), true)).toBe(false);
  writeUserWebSearch(dir, false);
  for (const stock of [false, true]) expect(webSearchToolOff(webSearchSetting({ env: {}, stateDir: dir }), stock)).toBe(true);
});
