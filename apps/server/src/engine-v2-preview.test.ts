import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  awaitEngineConnection,
  createEngineV2Preview,
  mapRuntimeProvidersToV2Specs,
  readEngineV2PreviewState,
  resolveInitialEngineV2PreviewState,
  writeEngineV2PreviewState,
} from "./engine-v2-preview.js";
import type { ServerConfig } from "./types.js";
import { engineV2Root } from "./engine-v2-migration.js";
import { builtinOmniRushModelCatalog, writeOmniRushModelCatalog } from "./omnirush-model-catalog.js";
import { runtimeStorageDir } from "./runtime-db.js";
import { buildOmniRushV2Instructions, waitForOmniRushV2Skills } from "./opencode-v2-instructions.js";
import { workDir } from "./work/work.js";

const realV2Binary = process.env.OMNIRUSH_OPENCODE2_BIN?.trim()
  || join(resolve(import.meta.dir, "../../.."), "apps/desktop/resources/sidecars/opencode2-x86_64-unknown-linux-gnu");
const realV2Test = existsSync(realV2Binary) ? test : test.skip;

test("v2 app guidance fits the native entry limit and uses the current native tools", () => {
  for (const connected of [true, false]) {
    const value = buildOmniRushV2Instructions(connected);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(7 * 1024);
    expect(value.operatingInstructions).not.toContain("Sub-agent swarms");
    expect(value.operatingInstructions).toContain("## Editing files");
    expect(value.operatingInstructions).not.toContain("omnirush-cloud_search_capabilities");
    expect(value.operatingInstructions).not.toContain("omnirush-cloud_execute_capability");
    expect(value.operatingInstructions).toStartWith("You are the user's coding assistant.");
    expect(value.connect.includes("not connected")).toBe(!connected);
  }
});

test("native plugin skills do not block workspace skill synchronization", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-v2-plugin-skills-"));
  try {
    let reads = 0;
    await waitForOmniRushV2Skills(root, async () => {
      reads++;
      return { data: [{ name: "plugin-skill", description: "Plugin instructions", content: "Current plugin instructions",
        location: join(root, ".opencode", "plugins", "example", "SKILL.md") }] };
    });
    expect(reads).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function testConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(root, "omnirush-server.json"),
    approval: { mode: "manual", timeoutMs: 1_000 },
    corsOrigins: [],
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

test("the 2.x engine runs every chat, whatever an earlier preview setting said", () => {
  expect(resolveInitialEngineV2PreviewState({}, { enabled: false, chatRouting: false }, false)).toEqual({ enabled: true, chatRouting: true });
  expect(resolveInitialEngineV2PreviewState({ OMNIRUSH_ENGINE_V2_PREVIEW: "0" }, undefined, false)).toEqual({ enabled: true, chatRouting: true });
  expect(resolveInitialEngineV2PreviewState({ OMNIRUSH_ENGINE_V2_PREVIEW: "sidecar" }, undefined, false)).toEqual({ enabled: true, chatRouting: false });
  expect(resolveInitialEngineV2PreviewState({ OMNIRUSH_ENGINE_V2_PREVIEW: "sidecar" }, undefined, true)).toEqual({ enabled: true, chatRouting: true });
});

test("round trips enabled and chat routing state and defaults corrupt state", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-engine-v2-preview-"));
  const config = testConfig(root);
  try {
    await writeEngineV2PreviewState(config, { enabled: true, chatRouting: true });
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: true, chatRouting: true });

    await writeFile(join(root, "engine-v2-preview.json"), "{invalid", "utf8");
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: false, chatRouting: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the 2.x engine cannot be turned off", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-engine-v2-preview-"));
  const preview = createEngineV2Preview({ config: testConfig(root), deferStart: true });
  try {
    expect(preview.status().enabled).toBe(true);
    await expect(preview.setEnabled(false)).rejects.toThrow(/cannot be turned off/);
    await expect(preview.setChatRouting(false)).rejects.toThrow(/cannot be turned off/);
  } finally {
    await preview.stop();
    await rm(root, { recursive: true, force: true });
  }
});

realV2Test("removes a configured MCP from the real v2 engine before admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-engine-v2-mcp-ban-"));
  const previousBinary = process.env.OMNIRUSH_OPENCODE2_BIN;
  await writeEngineV2PreviewState(testConfig(root), { enabled: true, chatRouting: false });
  process.env.OMNIRUSH_OPENCODE2_BIN = realV2Binary;
  const config = testConfig(root);
  const preview = createEngineV2Preview({ config, deferStart: true });

  try {
    preview.start();
    const deadline = Date.now() + 60_000;
    let connection: ReturnType<typeof preview.connection>;
    while (!(connection = preview.connection()) && Date.now() < deadline) {
      if (preview.status().lastError) throw new Error(preview.status().lastError);
      await Bun.sleep(100);
    }
    if (!connection) throw new Error("Timed out waiting for the real v2 engine");

    const directory = encodeURIComponent(root);
    const request = (path: string, init?: RequestInit) => fetch(
      `${connection!.url}${path}${path.includes("?") ? "&" : "?"}location%5Bdirectory%5D=${directory}`,
      {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`${connection!.username}:${connection!.password}`).toString("base64")}`,
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      },
    );
    const configured = await request("/api/experimental/mcp/fixture", {
      method: "PUT",
      body: JSON.stringify({ config: { type: "remote", url: "https://example.invalid/mcp" } }),
    });
    expect(configured.status).toBe(204);

    const before = await (await request("/api/mcp")).json() as { data?: Array<{ name?: string }> };
    expect(before.data?.some((entry) => entry.name === "fixture")).toBe(true);

    await preview.syncWorkspaceMcp("ws_1", root);

    const after = await (await request("/api/mcp")).json() as { data?: Array<{ name?: string }> };
    expect(after.data?.some((entry) => entry.name === "fixture")).toBe(false);
  } finally {
    await preview.stop();
    if (previousBinary === undefined) delete process.env.OMNIRUSH_OPENCODE2_BIN;
    else process.env.OMNIRUSH_OPENCODE2_BIN = previousBinary;
    await rm(root, { recursive: true, force: true });
  }
});

realV2Test("a Work folder gets its server again when the engine has dropped it (an idle folder unloaded)", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-engine-v2-mcp-idle-"));
  const previousBinary = process.env.OMNIRUSH_OPENCODE2_BIN;
  const previousUserData = process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR;
  delete process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR;
  const config: ServerConfig = {
    ...testConfig(root),
    port: 9,
    omnirushGatewayCredentials: { gatewayUrl: "https://gateway.invalid", accessToken: "a", refreshToken: "r" },
    omnirushEngineToken: "engine-token",
  };
  await writeEngineV2PreviewState(config, { enabled: true, chatRouting: false });
  const folder = join(workDir(runtimeStorageDir(config)), "acct_1");
  await mkdir(folder, { recursive: true });
  await writeFile(join(workDir(runtimeStorageDir(config)), "server.json"), JSON.stringify({ block: { enabled: true } }));
  process.env.OMNIRUSH_OPENCODE2_BIN = realV2Binary;
  const preview = createEngineV2Preview({ config, deferStart: true });
  try {
    preview.start();
    const connection = await preview.awaitConnection(60_000);
    if (!connection) throw new Error(preview.status().lastError ?? "Timed out waiting for the real v2 engine");
    const request = (path: string, init?: RequestInit) => fetch(`${connection.url}${path}?location%5Bdirectory%5D=${encodeURIComponent(folder)}`, {
      ...init,
      headers: { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` },
    });
    const listed = async () => ((await (await request("/api/mcp")).json()) as { data?: Array<{ name?: string }> }).data?.map((entry) => entry.name) ?? [];

    await preview.syncWorkspaceMcp("ws_work", folder);
    expect(await listed()).toContain("omnirush-work");
    // What an idle hour does: the engine unloads the folder and forgets the servers added at runtime.
    expect((await request("/api/experimental/mcp/omnirush-work", { method: "DELETE" })).status).toBe(204);
    await preview.syncWorkspaceMcp("ws_work", folder);
    expect(await listed()).not.toContain("omnirush-work");
    // A prompt checks, and applies it again.
    const reapplied = await preview.syncWorkspaceMcp("ws_work", folder, { verify: true });
    expect(await listed()).toContain("omnirush-work");
    expect(reapplied).toEqual(["omnirush-work"]);
    expect(await preview.syncWorkspaceMcp("ws_work", folder, { verify: true })).toEqual([]);
  } finally {
    await preview.stop();
    if (previousBinary === undefined) delete process.env.OMNIRUSH_OPENCODE2_BIN;
    else process.env.OMNIRUSH_OPENCODE2_BIN = previousBinary;
    if (previousUserData !== undefined) process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR = previousUserData;
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("maps runtime provider fields and models to an OpenCode v2 spec", () => {
  expect(mapRuntimeProvidersToV2Specs({
    example: {
      name: "Example Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1", apiKey: "secret" },
      models: {
        "model-b": {},
        "model-a": { name: "Model A" },
      },
    },
  })).toEqual({
    specs: [{
      id: "example",
      name: "Example Provider",
      baseUrl: "https://example.test/v1",
      package: "@opencode-ai/ai/providers/openai-compatible",
      apiKey: "secret",
      models: [
        { id: "model-a", name: "Model A", config: { name: "Model A" } },
        { id: "model-b", name: "model-b", config: {} },
      ],
    }],
    skippedProviderIds: [],
  });
});

test("skips providers without a non-empty base URL", () => {
  const result = mapRuntimeProvidersToV2Specs({ missing: { options: { apiKey: "secret" } } });
  expect(result.skippedProviderIds).toEqual(["missing"]);
  expect(result.specs).toEqual([]);
});

test("maps providers without an API key using the preview sentinel", () => {
  expect(mapRuntimeProvidersToV2Specs({
    noKey: { options: { baseURL: "https://example.test/v1" } },
  }).specs).toEqual([{
    id: "noKey",
    name: "noKey",
    baseUrl: "https://example.test/v1",
    apiKey: "omnirush-engine-v2-preview-unset",
    models: [],
  }]);
});

test("skips non-record provider values without throwing", () => {
  expect(mapRuntimeProvidersToV2Specs({ array: [], nil: null, number: 42, text: "provider" })).toEqual({
    specs: [],
    skippedProviderIds: ["array", "nil", "number", "text"],
  });
});

test("sorts mapped and skipped provider IDs deterministically", () => {
  const result = mapRuntimeProvidersToV2Specs({
    zebra: { options: { baseURL: "https://zebra.test/v1" } },
    yak: {},
    alpha: { options: { baseURL: "https://alpha.test/v1" } },
    beta: null,
  });
  expect(result.specs.map((spec) => spec.id)).toEqual(["alpha", "zebra"]);
  expect(result.skippedProviderIds).toEqual(["beta", "yak"]);
});


test("native organization providers retain their transport without an endpoint override", () => {
  const result = mapRuntimeProvidersToV2Specs({
    lpr_openai: { npm: "@ai-sdk/openai", options: { apiKey: "fixture-key" }, models: { coding: { id: "wire-model", name: "Coding", tool_call: false, limit: { context: 1000000, output: 64000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } } } },
    lpr_anthropic: { npm: "@ai-sdk/anthropic" },
    lpr_router: { npm: "@openrouter/ai-sdk-provider" },
    unknown: { npm: "untrusted-package", options: { baseURL: "https://example.test" } },
  });
  expect(result.skippedProviderIds).toEqual(["unknown"]);
  expect(result.specs.map((spec) => spec.package)).toEqual([
    "@opencode-ai/ai/providers/anthropic", "@opencode-ai/ai/providers/openai", "@opencode-ai/ai/providers/openrouter",
  ]);
  expect(result.specs.every((spec) => spec.baseUrl === undefined)).toBe(true);
  expect(result.specs[1]?.models[0]?.config).toMatchObject({ id: "wire-model", tool_call: false, limit: { context: 1000000, output: 64000 } });
});

test("native provider api endpoint and headers survive conversion", () => {
  expect(mapRuntimeProvidersToV2Specs({ native: {
    npm: "@ai-sdk/openai", api: "https://api.openai.com/v1", options: { apiKey: "fixture", headers: { "x-tenant": "fixture" } },
  } }).specs[0]).toMatchObject({ baseUrl: "https://api.openai.com/v1", package: "@opencode-ai/ai/providers/openai", headers: { "x-tenant": "fixture" } });
});


test("resolves only each provider's declared stored credential and omits missing credentials", () => {
  const providers = {
    native: { npm: "@ai-sdk/openai", env: ["NATIVE_API_KEY"] },
    missing: { npm: "@ai-sdk/openai", env: ["MISSING_API_KEY"] },
  };
  const first = mapRuntimeProvidersToV2Specs(providers, new Map([["NATIVE_API_KEY", "key-one"], ["DATABASE_URL", "unrelated-secret"]]));
  expect(first.specs[0]?.apiKey).toBe("key-one");
  expect(first.skippedProviderIds).toEqual(["missing"]);
  expect(JSON.stringify(first)).not.toContain("unrelated-secret");
  const rotated = mapRuntimeProvidersToV2Specs(providers, new Map([["NATIVE_API_KEY", "key-two"]]));
  expect(rotated.specs[0]?.apiKey).toBe("key-two");
});


test("catalog api metadata cannot redirect a stored credential off the native trusted origin", () => {
  for (const api of ["http://127.0.0.1/v1", "https://attacker.example/v1", "https://api.openai.com.attacker.example/v1", "https://api.openai.com:444/v1", "https://user@api.openai.com/v1"]) {
    const result = mapRuntimeProvidersToV2Specs({ native: { npm: "@ai-sdk/openai", api, env: ["NATIVE_API_KEY"] } }, new Map([["NATIVE_API_KEY", "private-fixture-key"]]));
    expect(result.skippedProviderIds).toEqual(["native"]);
    expect(result.specs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-fixture-key");
  }
});


test("null or empty native endpoint overrides cannot bypass catalog origin validation", () => {
  for (const baseURL of [null, "", "  ", 0, false, {}]) {
    const result = mapRuntimeProvidersToV2Specs({ native: {
      npm: "@ai-sdk/openai", api: "https://untrusted.example/v1",
      options: { baseURL }, env: ["NATIVE_API_KEY"],
    } }, new Map([["NATIVE_API_KEY", "private-fixture-key"]]));
    expect(result.skippedProviderIds).toEqual(["native"]);
    expect(result.specs).toEqual([]);
  }
});

test("a request sent while the engine starts gets its connection once the engine is up", async () => {
  let up: { url: string } | undefined;
  let finish!: () => void;
  const starting = new Promise<void>((resolveStart) => { finish = () => { up = { url: "http://127.0.0.1:4097" }; resolveStart(); }; });
  setTimeout(finish, 150);
  const began = Date.now();
  const connection = await awaitEngineConnection({ connection: () => up, starting: () => (up ? undefined : starting), failed: () => false }, 5_000);
  expect(connection).toEqual({ url: "http://127.0.0.1:4097" });
  expect(Date.now() - began).toBeLessThan(2_000);
  // Before the start began (the server starts the engine after its routes): polled until it is up.
  let later: { url: string } | undefined;
  setTimeout(() => { later = { url: "http://127.0.0.1:4098" }; }, 120);
  expect(await awaitEngineConnection({ connection: () => later, starting: () => undefined, failed: () => false }, 5_000, 20)).toEqual({ url: "http://127.0.0.1:4098" });
});

test("an engine that never starts, or whose start failed, gives no connection within the bound", async () => {
  const began = Date.now();
  expect(await awaitEngineConnection({ connection: () => undefined, starting: () => new Promise<never>(() => undefined), failed: () => false }, 300, 50)).toBeNull();
  const waited = Date.now() - began;
  expect(waited).toBeGreaterThanOrEqual(250);
  expect(waited).toBeLessThan(1_500);
  const failedAt = Date.now();
  expect(await awaitEngineConnection({ connection: () => undefined, starting: () => undefined, failed: () => true }, 5_000)).toBeNull();
  expect(Date.now() - failedAt).toBeLessThan(500);
});

realV2Test("a request during start waits for the engine, and a catalog change brings its models to the running engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-engine-v2-catalog-"));
  const previousBinary = process.env.OMNIRUSH_OPENCODE2_BIN;
  const config: ServerConfig = {
    ...testConfig(root),
    port: 9,
    omnirushGatewayCredentials: { gatewayUrl: "https://gateway.invalid", accessToken: "a", refreshToken: "r" },
    omnirushEngineToken: "engine-token",
  };
  await writeEngineV2PreviewState(config, { enabled: true, chatRouting: false });
  process.env.OMNIRUSH_OPENCODE2_BIN = realV2Binary;
  const preview = createEngineV2Preview({ config, deferStart: true });
  const engineModels = async () => {
    const written = JSON.parse(await readFile(join(engineV2Root(runtimeStorageDir(config)), "config", "opencode.json"), "utf8"));
    return Object.keys(written.providers?.omnirush?.models ?? {}).sort();
  };
  try {
    preview.start();
    // Sent while it starts: answered once the engine is up, not refused.
    const connection = await preview.awaitConnection(60_000);
    expect(connection?.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    // Before the first catalog sync: the built-in catalog.
    expect(await engineModels()).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"]);
    const synced = builtinOmniRushModelCatalog();
    synced.push({ ...synced[0]!, id: "kimi-k3.1-pro", display_name: "Kimi K3.1 Pro", family: "Kimi", default: false });
    await writeOmniRushModelCatalog(config, synced);
    await preview.refreshProviders();
    expect(await engineModels()).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "kimi-k3.1-pro"]);
    // Under the gateway provider (our broker's address), the only one the engine may use.
    const written = JSON.parse(await readFile(join(engineV2Root(runtimeStorageDir(config)), "config", "opencode.json"), "utf8"));
    expect(Object.keys(written.providers)).toEqual(["omnirush"]);
    expect(written.providers.omnirush.settings.baseURL).toBe("http://127.0.0.1:9/omnirush-gateway/v1");
    expect(preview.status().catalogModelIds).toContain("kimi-k3.1-pro");
  } finally {
    await preview.stop();
    if (previousBinary === undefined) delete process.env.OMNIRUSH_OPENCODE2_BIN;
    else process.env.OMNIRUSH_OPENCODE2_BIN = previousBinary;
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
