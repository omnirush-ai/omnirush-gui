import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builtinOmniRushModelCatalog,
  canonicalOmniRushModelCatalog,
  clearOmniRushModelCatalog,
  engineModelsFromCatalog,
  omnirushDefaultModelId,
  omnirushModelCatalogPath,
  readOmniRushModelCatalog,
  sanitizeOmniRushModelCatalog,
  writeOmniRushModelCatalog,
  type OmniRushModelCatalog,
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
    expect(catalog?.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]);
    expect(catalog && omnirushDefaultModelId(catalog)).toBe("gpt-6-astra");
    expect(catalog?.filter((model) => model.default).map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(catalog?.[4]).toEqual({
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

  test("Astra and Sol from the backend equal the built-in catalog, so a Muse-less account never reloads", () => {
    const body = backendCatalogBody();
    const openaiOnly = { ...body, data: body.data.slice(0, 2) };
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
      "capabilities.image_input", "capabilities.file_input",
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

  test("an older backend's four fields give Astra and Sol their v1.0.9 metadata", () => {
    const catalog = sanitizeOmniRushModelCatalog({
      object: "list",
      data: [
        { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: true, reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", default: false, reasoning_levels: ["low", "high", "xhigh", "max"] },
      ],
    });
    expect(catalog).toEqual(builtinOmniRushModelCatalog());
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
      expect(models[id]!.variants).toMatchObject({ xhigh: { reasoning_effort: "xhigh" } });
    }
  });

  test("labels Muse by family, keeps 1.3 beta and text-only, and never sets attachment", () => {
    const models = engineModelsFromCatalog(sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    expect(models["meta-muse-spark"]).toMatchObject({
      name: "Meta Muse Spark",
      family: "Meta Muse",
      limit: { context: 158_000, output: 32_000 },
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
