import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builtinOmniRushModelCatalog,
  canonicalOmniRushModelCatalog,
  clearOmniRushModelCatalog,
  engineModelsFromCatalog,
  OMNIRUSH_DEFAULT_EFFORT,
  omnirushDefaultEffort,
  omnirushDefaultModelId,
  omnirushModelCatalogPath,
  omnirushModelWantsReasoningSummary,
  readOmniRushModelCatalog,
  sanitizeOmniRushModelCatalog,
  writeOmniRushModelCatalog,
  type OmniRushModelCatalog,
  omnirushCompactInputLimit,
} from "./omnirush-model-catalog.js";
import type { ServerConfig } from "./types.js";
import { backendCatalogBody } from "./__fixtures__/omnirush-model-catalog.js";

const roots: string[] = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
  else process.env.OMNIRUSH_RUNTIME_DB = previousDb;
});

async function setupConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-model-catalog-"));
  roots.push(root);
  previousDb = process.env.OMNIRUSH_RUNTIME_DB;
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

/** Every key path of a JSON value, e.g. "0.capabilities.web_search". */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => keyPaths(entry, `${prefix}${index}.`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`)]);
}

describe("omnirush model catalog sanitizer", () => {
  test("reads the backend catalog: Astra first and default, Muse under its family with its own efforts", () => {
    const catalog = sanitizeOmniRushModelCatalog(backendCatalogBody());
    expect(catalog?.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]);
    expect(catalog && omnirushDefaultModelId(catalog)).toBe("gpt-6-astra");
    expect(catalog?.filter((model) => model.default).map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(catalog?.[5]).toEqual({
      id: "muse-spark-1.3",
      display_name: "Meta Muse Spark 1.3",
      family: "Meta Muse",
      status: "beta",
      default: false,
      reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"],
      limits: { context: 99_000, output: 16_000 },
      capabilities: { reasoning: true, tool_call: true, web_search: true, image_input: false, file_input: false },
    });
  });

  test("Astra, GPT 6.1 Sol and GPT 6 Sol from the backend equal the built-in catalog, so a Muse-less account never reloads", () => {
    const body = backendCatalogBody();
    const openaiOnly = { ...body, data: body.data.slice(0, 3) };
    const catalog = sanitizeOmniRushModelCatalog(openaiOnly);
    expect(catalog).not.toBeNull();
    expect(canonicalOmniRushModelCatalog(catalog!)).toBe(canonicalOmniRushModelCatalog(builtinOmniRushModelCatalog()));
  });

  test("never takes provider plumbing from the backend, at any depth", () => {
    const body = backendCatalogBody();
    const hostile = {
      ...body,
      npm: "evil-sdk",
      baseURL: "https://attacker.example",
      provider: { npm: "evil-sdk" },
      data: body.data.map((model) => ({
        ...model,
        npm: "evil-sdk",
        baseURL: "https://attacker.example/v1",
        headers: { authorization: "Bearer stolen" },
        env: ["AWS_SECRET_ACCESS_KEY"],
        options: { baseURL: "https://attacker.example/v1" },
        provider: { npm: "evil-sdk", api: "https://attacker.example" },
        upstream_model: "internal-codename",
        limits: { ...model.limits, input: 5, url: "https://attacker.example" },
        capabilities: { ...model.capabilities, attachment: true, shell: true },
      })),
    };
    const catalog = sanitizeOmniRushModelCatalog(hostile);
    const allowed = new Set([
      "id", "display_name", "family", "status", "default", "reasoning_levels", "limits", "limits.context", "limits.output",
      "capabilities", "capabilities.reasoning", "capabilities.tool_call", "capabilities.web_search",
      "capabilities.image_input", "capabilities.file_input", "switch_group",
    ]);
    const paths = keyPaths(catalog).map((path) => path.replace(/^\d+\./, "")).filter((path) => !/^\d+$/.test(path));
    expect(paths.filter((path) => !allowed.has(path) && !/^reasoning_levels\.\d+$/.test(path))).toEqual([]);
    const text = JSON.stringify(catalog);
    for (const leaked of ["evil-sdk", "attacker.example", "stolen", "AWS_SECRET", "internal-codename"]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("drops bad ids, duplicates, non-Responses models and wrong types; clamps limits", () => {
    const catalog = sanitizeOmniRushModelCatalog({
      data: [
        { id: "../../etc/passwd", display_name: "Path" },
        { id: "z-ai/glm-5.2", display_name: "Slash" },
        { id: "-leading-dash", display_name: "Dash" },
        { id: "a".repeat(129), display_name: "Long" },
        { id: 42, display_name: "Number" },
        "not-an-object",
        { id: "chat-only", display_name: "Chat", api: "chat" },
        {
          id: "new-model:v2",
          display_name: "  New\u0007 Model‮  ",
          family: "x".repeat(40),
          status: "retired",
          default: "yes",
          reasoning_levels: ["ultra", "high", "HIGH", "low", 3, "low"],
          limits: { context: 10, output: 9_999_999 },
          capabilities: { reasoning: "true", tool_call: false },
        },
        { id: "new-model:v2", display_name: "Duplicate" },
      ],
    });
    expect(catalog).toEqual([{
      id: "new-model:v2",
      display_name: "New Model",
      family: null,
      status: "active",
      default: true,
      reasoning_levels: ["low", "high"],
      limits: { context: 1_000, output: 1_000 },
      capabilities: { reasoning: true, tool_call: false, web_search: true, image_input: true, file_input: true },
    }]);
  });

  test("an older backend's four fields give Astra and both Sols the shared metadata", () => {
    const catalog = sanitizeOmniRushModelCatalog({
      object: "list",
      data: [
        { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: true, reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", default: false, reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "gpt-6-sol", display_name: "GPT 6 Sol", default: false, reasoning_levels: ["low", "high", "xhigh", "max"] },
      ],
    });
    // The shared metadata; an older backend names no switch group (only the built-ins carry the Codex route's).
    expect(catalog).toEqual(builtinOmniRushModelCatalog().map(({ switch_group: _group, ...model }) => model));
  });

  test("before the first sync, a chat on Astra may switch to either Sol: the built-ins are one provider", () => {
    expect(builtinOmniRushModelCatalog().map((model) => model.switch_group)).toEqual(["openai", "openai", "openai"]);
  });

  test("the built-ins are only the fallback (the backend's list); the catalog decides what is served", () => {
    expect(builtinOmniRushModelCatalog().map((model) => [model.id, model.display_name, model.default])).toEqual([
      ["gpt-6-astra", "GPT 6 Astra", true],
      ["gpt-6.1-sol", "GPT 6.1 Sol", false],
      ["gpt-6-sol", "GPT 6 Sol", false],
    ]);
    const body = backendCatalogBody();
    const catalog = sanitizeOmniRushModelCatalog({ ...body, data: body.data.filter((model) => model.id === "gpt-6-astra" || model.id === "gpt-6-sol") });
    expect(catalog).toEqual(builtinOmniRushModelCatalog().filter((model) => model.id !== "gpt-6.1-sol"));
  });

  test("takes any catalog model: an id with dots, an id never seen before, a new default", () => {
    const catalog = sanitizeOmniRushModelCatalog({
      object: "list",
      data: [
        { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: false, family: "OpenAI", reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "nova-9.0.1-preview", display_name: "Nova 9.0.1 Preview", default: true, family: "Nova", reasoning_levels: ["low", "high"] },
        { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", default: false, family: "OpenAI", reasoning_levels: ["low", "high", "xhigh", "max"] },
      ],
    })!;
    expect(catalog.map((model) => [model.id, model.display_name])).toEqual([
      ["gpt-6-astra", "GPT 6 Astra"],
      ["nova-9.0.1-preview", "Nova 9.0.1 Preview"],
      ["gpt-6.1-sol", "GPT 6.1 Sol"],
    ]);
    expect(omnirushDefaultModelId(catalog)).toBe("nova-9.0.1-preview");
    const engine = engineModelsFromCatalog(catalog);
    expect(Object.keys(engine)).toEqual(["gpt-6-astra", "nova-9.0.1-preview", "gpt-6.1-sol"]);
    expect(engine["gpt-6.1-sol"]?.name).toBe("GPT 6.1 Sol");
    expect(engine["nova-9.0.1-preview"]?.family).toBe("Nova");
  });

  test("reasoning summaries follow the catalog: every Codex-route reasoning model, not a fixed pair of ids", () => {
    const catalog = sanitizeOmniRushModelCatalog(backendCatalogBody())!;
    expect(omnirushModelWantsReasoningSummary(catalog, "gpt-6-astra")).toBe(true);
    expect(omnirushModelWantsReasoningSummary(catalog, "gpt-6.1-sol")).toBe(true);
    expect(omnirushModelWantsReasoningSummary(catalog, "gpt-6-sol")).toBe(true);
    expect(omnirushModelWantsReasoningSummary(catalog, "meta-muse-spark")).toBe(false);
    expect(omnirushModelWantsReasoningSummary(catalog, "not-in-catalog")).toBe(false);
    expect(omnirushModelWantsReasoningSummary(catalog, undefined)).toBe(false);
    const withNew = sanitizeOmniRushModelCatalog({ data: [{ id: "gpt-7.2-nova", family: "OpenAI", reasoning_levels: ["low", "high"] }] })!;
    expect(omnirushModelWantsReasoningSummary(withNew, "gpt-7.2-nova")).toBe(true);
  });

  test("keeps exactly one default, and at most 32 models", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `model-${index}`, display_name: `Model ${index}`, default: index >= 3 }));
    const catalog = sanitizeOmniRushModelCatalog({ data: many });
    expect(catalog).toHaveLength(32);
    expect(catalog?.filter((model) => model.default).map((model) => model.id)).toEqual(["model-3"]);

    const none = sanitizeOmniRushModelCatalog({ data: [{ id: "first" }, { id: "second" }] });
    expect(none?.map((model) => model.default)).toEqual([true, false]);
  });

  test("an unusable body is no catalog, so the last good one stays", () => {
    for (const body of [null, "list", [], {}, { data: {} }, { data: [] }, { data: [{ id: "" }, { nope: true }] }]) {
      expect(sanitizeOmniRushModelCatalog(body)).toBeNull();
    }
  });
});

describe("omnirush model catalog cache", () => {
  test("round-trips through the file, re-sanitized on read, and falls back to the built-ins", async () => {
    const config = await setupConfig();
    expect(await readOmniRushModelCatalog(config)).toEqual(builtinOmniRushModelCatalog());

    const catalog = sanitizeOmniRushModelCatalog(backendCatalogBody())!;
    await writeOmniRushModelCatalog(config, catalog);
    expect(await readOmniRushModelCatalog(config)).toEqual(catalog);

    // The file is re-read through the sanitizer: a tampered entry is dropped, not trusted.
    const stored = JSON.parse(await readFile(omnirushModelCatalogPath(config), "utf8")) as { data: Array<Record<string, unknown>> };
    stored.data.push({ id: "bad id", npm: "evil-sdk" });
    await writeFile(omnirushModelCatalogPath(config), JSON.stringify(stored));
    expect(await readOmniRushModelCatalog(config)).toEqual(catalog);

    await writeFile(omnirushModelCatalogPath(config), "{not json");
    expect(await readOmniRushModelCatalog(config)).toEqual(builtinOmniRushModelCatalog());

    await writeOmniRushModelCatalog(config, catalog);
    await clearOmniRushModelCatalog(config);
    expect(await readOmniRushModelCatalog(config)).toEqual(builtinOmniRushModelCatalog());
  });
});

describe("omnirush engine models from the catalog", () => {
  const enabled = (model: Record<string, unknown>) => Object.entries(model.variants as Record<string, { disabled?: boolean }>)
    .filter(([, options]) => options.disabled !== true)
    .map(([key]) => key);
  const disabled = (model: Record<string, unknown>) => Object.entries(model.variants as Record<string, { disabled?: boolean }>)
    .filter(([, options]) => options.disabled === true)
    .map(([key]) => key);

  test("gives every model its own effort variants and disables the rest", () => {
    const models = engineModelsFromCatalog(sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    expect(enabled(models["gpt-6-astra"]!)).toEqual(["low", "high", "xhigh", "max"]);
    expect(disabled(models["gpt-6-astra"]!)).toEqual(["none", "minimal", "medium"]);
    for (const id of ["meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]) {
      expect(enabled(models[id]!)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
      expect(disabled(models[id]!)).toEqual(["none", "max"]);
      expect(models[id]!.variants).toMatchObject({ xhigh: { reasoningEffort: "xhigh" } });
    }
  });

  test("variants carry the camelCase reasoningEffort the engine's OpenAI adapter reads", () => {
    const models = engineModelsFromCatalog(sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    for (const model of Object.values(models)) {
      for (const [level, options] of Object.entries(model.variants as Record<string, Record<string, unknown>>)) {
        // An unsupported level is only ever disabled; a supported one names itself.
        expect(options).toEqual(options.disabled === true ? { disabled: true } : { reasoningEffort: level });
        expect(options).not.toHaveProperty("reasoning_effort");
      }
    }
  });

  test("every model with efforts gets a model-level default: high where offered, else the level nearest medium", () => {
    const catalog = sanitizeOmniRushModelCatalog({
      data: [
        { id: "gpt-6-astra", reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "muse", reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"] },
        { id: "nova", reasoning_levels: ["low", "high"] },
        { id: "tiny", reasoning_levels: ["minimal", "low", "xhigh"] },
        { id: "mid", reasoning_levels: ["none", "medium", "max"] },
        { id: "plain", reasoning_levels: [], capabilities: { reasoning: false } },
      ],
    })!;
    const models = engineModelsFromCatalog(catalog);
    const defaults: Record<string, string | null> = Object.fromEntries(Object.entries(models).map(([id, model]) => [id, (model.options as { reasoningEffort?: string } | undefined)?.reasoningEffort ?? null]));
    expect(defaults).toEqual({ "gpt-6-astra": "high", muse: "high", nova: "high", tiny: "low", mid: "medium", plain: null });
    expect(models.plain!.options).toBeUndefined();
    expect(models.nova!.options).not.toHaveProperty("reasoning_effort");
    for (const model of catalog) expect<string | null>(omnirushDefaultEffort(model.reasoning_levels)).toBe(defaults[model.id] ?? null);
    expect(OMNIRUSH_DEFAULT_EFFORT).toBe("high");
  });

  test("labels Muse by family, keeps 1.3 beta and text-only, and never sets attachment", () => {
    const models = engineModelsFromCatalog(sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    expect(models["meta-muse-spark"]).toMatchObject({
      name: "Meta Muse Spark",
      family: "Meta Muse",
      limit: { context: 158_000, input: 146_000, output: 32_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models["meta-muse-spark"]!.status).toBeUndefined();
    expect(models["muse-spark-1.3"]).toMatchObject({ status: "beta", modalities: { input: ["text"], output: ["text"] } });
    for (const model of Object.values(models)) expect(model.attachment).toBeUndefined();
    expect(models["gpt-6-astra"]!.family).toBeUndefined();
  });

  test("a deprecated model stays active in the engine, which would otherwise delete it", () => {
    const catalog: OmniRushModelCatalog = builtinOmniRushModelCatalog().map((model) => ({ ...model, status: "deprecated" as const }));
    for (const model of Object.values(engineModelsFromCatalog(catalog))) expect(model.status).toBeUndefined();
  });

  test("a model without effort control offers no variant", () => {
    const [model] = sanitizeOmniRushModelCatalog({ data: [{ id: "plain", display_name: "Plain", reasoning_levels: [], capabilities: { reasoning: false } }] })!;
    const engine = engineModelsFromCatalog([model!]).plain!;
    expect(enabled(engine)).toEqual([]);
    expect(engine.reasoning).toBe(false);
  });
});

test("compaction input limit: about 245k for a 400k window, never later than the engine's own point for a smaller one", () => {
  // The engine compacts at input - min(20k, max output) with an input limit, else at context - max output (max output = min(output, 32k)).
  const compactsAt = (limit: { context: number; output: number; input?: number }) => {
    const maxOut = Math.min(limit.output, 32_000);
    return limit.input ? limit.input - Math.min(20_000, maxOut) : limit.context - maxOut;
  };
  expect(omnirushCompactInputLimit({ context: 400_000, output: 128_000 })).toBe(265_000);
  expect(omnirushCompactInputLimit({ context: 128_000, output: 32_000 })).toBe(116_000);
  for (const limits of [{ context: 128_000, output: 32_000 }, { context: 158_000, output: 32_000 }, { context: 99_000, output: 16_000 }, { context: 296_000, output: 128_000 }, { context: 400_000, output: 128_000 }, { context: 1_000_000, output: 8_000 }]) {
    expect(compactsAt({ ...limits, input: omnirushCompactInputLimit(limits) })).toBeLessThanOrEqual(compactsAt(limits));
  }
});
