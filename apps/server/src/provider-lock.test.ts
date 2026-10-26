import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManagedOpencodeServer } from "./managed-opencode.js";
import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { buildOmniRushRuntimeConfigObjectFromSnapshot } from "./omnirush-runtime-config.js";
import { builtinOmniRushModelCatalog } from "./omnirush-model-catalog.js";
import {
  applyProviderLockAnswer,
  assertConfigWithinLock,
  assertConfigWithinProviderLock,
  assertPluginsUnlocked,
  assertProxiedEngineRequestWithinProviderLock,
  currentProviderLockPolicy,
  engineRequestProviderLockDenial,
  engineStartedUnlocked,
  lockedEngineEnv,
  providerAllowed,
  providerLockConfigViolations,
  assertEngineStartedWithinLock,
  assertProviderWritable,
  noteEngineStarted,
  resetEngineStarts,
  resetProviderLock,
  watchProviderLock,
} from "./provider-lock.js";
import { providerLockPolicy } from "./provider-lock/provider-lock.mjs";

const UNLOCKED = { providers: { locked: false, message: "Any provider." } };
const LOCKED = providerLockPolicy({ providers: { locked: true, allow: ["omnirush"], message: "Only OmniRush models are available." } });
const roots: string[] = [];

afterEach(async () => {
  resetProviderLock();
  resetEngineStarts();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("provider lock: fails closed", () => {
  test("locked at start, and for every answer that is not a clear `locked: false`", () => {
    expect(currentProviderLockPolicy()).toMatchObject({ locked: true, allow: ["omnirush", "omnirush-claude"] });
    for (const answer of [null, undefined, {}, { schema_versions: [1, 2] }, { providers: null }, { providers: { locked: "false" } }, { providers: { locked: 0 } }, { providers: [] }]) {
      applyProviderLockAnswer(answer);
      expect(currentProviderLockPolicy().locked).toBe(true);
    }
  });

  test("a `locked: false` answer unlocks in memory; the next failed read locks again", () => {
    expect(applyProviderLockAnswer(UNLOCKED)).toBe(true);
    expect(currentProviderLockPolicy().locked).toBe(false);
    expect(applyProviderLockAnswer(UNLOCKED)).toBe(false);
    expect(applyProviderLockAnswer(null)).toBe(true);
    expect(currentProviderLockPolicy().locked).toBe(true);
  });

  test("the server's message is taken; only the app's providers count as allowed, whatever the list says", () => {
    applyProviderLockAnswer({ providers: { locked: true, allow: ["acme", "openai", "BAD ID", 7], message: "Ask your admin." } });
    expect(currentProviderLockPolicy()).toMatchObject({ locked: true, allow: ["omnirush", "omnirush-claude"], message: "Ask your admin." });
    expect(providerAllowed("omnirush-claude")).toBe(true);
    expect(providerAllowed("acme")).toBe(false);
    expect(providerAllowed("openai")).toBe(false);
    expect(providerAllowed("omnirush")).toBe(true);
  });

  test("the watcher re-reads, applies a change, and locks on a failed read", async () => {
    const answers: Array<() => Promise<unknown>> = [async () => UNLOCKED, async () => UNLOCKED, async () => { throw new Error("offline"); }];
    let applied = 0;
    const stop = watchProviderLock({ read: () => (answers.shift() ?? (async () => null))(), apply: async () => { applied += 1; }, everyMs: 5 });
    try {
      for (let i = 0; i < 100 && applied < 2; i += 1) await Bun.sleep(5);
    } finally {
      stop();
    }
    expect(applied).toBe(2);
    expect(currentProviderLockPolicy().locked).toBe(true);
  });
});

describe("provider lock: gateway broker", () => {
  test("passes the server's providers block on (a field-by-field rebuild would drop it)", async () => {
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "a", refreshToken: "r" },
      engineToken: "local-engine-token",
      fetch: async () => Response.json({ schema_versions: [1, 2, 3], canonical_trace: true, providers: { locked: false, allow: [], message: "x" } }),
    });
    const capabilities = await broker.sessionUploadCapabilities({ strict: true });
    expect(capabilities.providers).toEqual({ locked: false, allow: [], message: "x" });
    expect(applyProviderLockAnswer(capabilities)).toBe(true);
    expect(currentProviderLockPolicy().locked).toBe(false);
  });

  test("signed out the strict read throws, which is locked", async () => {
    const broker = new OmniRushGatewayBroker({ engineToken: "t", fetch: async () => Response.json({}) });
    const answer = await broker.sessionUploadCapabilities({ strict: true }).catch(() => null);
    applyProviderLockAnswer(answer);
    expect(currentProviderLockPolicy().locked).toBe(true);
  });
});

describe("provider lock: engine config", () => {
  const gateway = { baseUrl: "http://127.0.0.1:1/omnirush-gateway/v1" };
  const userProviders = {
    openai: { npm: "@ai-sdk/openai", options: { apiKey: "sk-fake" }, models: { "gpt-x": {} } },
    lpr_org1: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://org.example" }, models: { m: {} } },
    opencode: { models: {} },
  };

  function build(runtime: Record<string, unknown>, env: NodeJS.ProcessEnv = {}, signedIn = true) {
    return buildOmniRushRuntimeConfigObjectFromSnapshot(runtime, signedIn ? gateway : undefined, env, builtinOmniRushModelCatalog());
  }

  test("a signed-in user without other providers gets the same config locked and unlocked", () => {
    const locked = build({});
    applyProviderLockAnswer(UNLOCKED);
    const unlocked = build({});
    expect(JSON.stringify(locked)).toBe(JSON.stringify(unlocked));
    expect(locked.enabled_providers).toEqual(["omnirush"]);
    expect(Object.keys(locked.provider as object)).toEqual(["omnirush"]);
  });

  test("locked: only the allowed providers, whatever env, org policy, zen or org providers say", () => {
    const cases: Array<[Record<string, unknown>, NodeJS.ProcessEnv]> = [
      [{ provider: userProviders }, {}],
      [{ provider: userProviders }, { OMNIRUSH_ALLOW_OTHER_PROVIDERS: "1" }],
      [{ provider: userProviders, managedPolicy: { allowCustomProviders: true } }, {}],
      [{ provider: userProviders, managedPolicy: { allowCustomProviders: false, allowZenModel: true } }, {}],
      [{ provider: userProviders, disabled_providers: ["anthropic"], model: "openai/gpt-x", small_model: "openai/gpt-x", command: { c: { model: "openai/gpt-x", template: "t" } } }, {}],
    ];
    for (const [runtime, env] of cases) {
      const config = build(runtime, env);
      expect(config.enabled_providers).toEqual(["omnirush"]);
      expect(Object.keys(config.provider as object)).toEqual(["omnirush"]);
      expect(config).not.toHaveProperty("disabled_providers");
      expect(String(config.model)).toStartWith("omnirush/");
      expect(config).not.toHaveProperty("small_model");
      expect(providerLockConfigViolations(config, LOCKED)).toEqual([]);
    }
  });

  test("locked: the user's plugins stay out of the engine config; the app's own stay", () => {
    const locked = build({ plugin: ["opencode-wakatime", "file:///home/u/evil.ts"] });
    const plugins = locked.plugin as string[];
    expect(plugins.some((entry) => entry.includes("wakatime") || entry.includes("evil"))).toBe(false);
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins).toEqual(build({}).plugin as string[]);
    applyProviderLockAnswer(UNLOCKED);
    expect(build({ plugin: ["opencode-wakatime"] }).plugin as string[]).toContain("opencode-wakatime");
  });

  test("locked and signed out: still only the allowed providers, and no other provider's map", () => {
    const config = build({ provider: userProviders }, { OMNIRUSH_ALLOW_OTHER_PROVIDERS: "1" }, false);
    expect(config.enabled_providers).toEqual(["omnirush"]);
    expect(config).not.toHaveProperty("provider");
  });

  test("unlocked by the server: the earlier behaviour (org and env switches apply)", () => {
    applyProviderLockAnswer(UNLOCKED);
    expect(build({ provider: userProviders }).enabled_providers).toEqual(["lpr_org1", "omnirush"]);
    expect(build({ provider: userProviders }, { OMNIRUSH_ALLOW_OTHER_PROVIDERS: "1" })).not.toHaveProperty("enabled_providers");
    expect(build({ provider: userProviders, managedPolicy: { allowCustomProviders: true } })).not.toHaveProperty("enabled_providers");
    expect(build({ provider: userProviders, managedPolicy: { allowCustomProviders: false } }).enabled_providers).toEqual(["lpr_org1", "omnirush", "opencode"]);
    expect(Object.keys(build({ provider: userProviders }).provider as object).sort()).toEqual(["lpr_org1", "omnirush", "openai", "opencode"]);
  });
});

describe("provider lock: engine environment", () => {
  test("inherited config injection is removed, the app's own config folder stays, the lock is set", () => {
    const env = lockedEngineEnv(
      { OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_DIR: "/user/dir", OPENCODE_MODELS_URL: "https://x", OPENCODE_MODELS_PATH: "/m.json", HOME: "/h" },
      { OPENCODE_CONFIG_DIR: "/app/dir", OPENCODE_MODELS_URL: "http://localhost:8791/models" },
    );
    expect(env).toMatchObject({
      HOME: "/h",
      OPENCODE_CONFIG_DIR: "/app/dir",
      OMNIRUSH_PROVIDER_LOCK: "1",
      OMNIRUSH_PROVIDER_ALLOW: "omnirush,omnirush-claude",
      OMNIRUSH_PROVIDER_LOCK_MESSAGE: "Only OmniRush models are available.",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    });
    for (const key of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_MODELS_URL", "OPENCODE_MODELS_PATH"]) expect(env).not.toHaveProperty(key);
  });

  test("unlocked: the environment as it was", () => {
    applyProviderLockAnswer(UNLOCKED);
    expect(lockedEngineEnv({ OPENCODE_CONFIG_CONTENT: "{}", OMNIRUSH_PROVIDER_LOCK: "1" }, { A: "1" })).toEqual({ OPENCODE_CONFIG_CONTENT: "{}", A: "1", OMNIRUSH_PROVIDER_LOCK: "0" });
  });

  test("every managed engine spawn gets the lock, also over the caller's and the user's values", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-provider-lock-"));
    roots.push(root);
    const dumpPath = join(root, "env.json");
    const bin = join(root, "dump-env.mjs");
    await writeFile(bin, [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "const keys = ['OMNIRUSH_PROVIDER_LOCK', 'OMNIRUSH_PROVIDER_ALLOW', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_MODELS_URL', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR'];",
      "writeFileSync(process.env.ENV_DUMP_PATH, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ].join("\n"));
    await chmod(bin, 0o755);
    const previous = { content: process.env.OPENCODE_CONFIG_CONTENT, dir: process.env.OPENCODE_CONFIG_DIR };
    process.env.OPENCODE_CONFIG_CONTENT = '{"provider":{"openai":{}}}';
    process.env.OPENCODE_CONFIG_DIR = join(root, "user-config");
    try {
      const managed = await createManagedOpencodeServer({
        bin,
        cwd: root,
        env: { ENV_DUMP_PATH: dumpPath, OPENCODE_MODELS_URL: "https://models.example", OPENCODE_DISABLE_MODELS_FETCH: "0" },
      });
      try {
        const dumped = JSON.parse(await readFile(dumpPath, "utf8"));
        expect(dumped).toMatchObject({
          OMNIRUSH_PROVIDER_LOCK: "1",
          OMNIRUSH_PROVIDER_ALLOW: "omnirush,omnirush-claude",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_MODELS_URL: null,
          OPENCODE_CONFIG_CONTENT: null,
        });
        expect(dumped.OPENCODE_CONFIG_DIR).not.toBe(join(root, "user-config"));
      } finally {
        await managed.close();
      }
    } finally {
      if (previous.content === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = previous.content;
      if (previous.dir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous.dir;
    }
  });
});

describe("provider lock: refusals", () => {
  test("engine requests: other providers' keys, sign-ins, config and models are refused", () => {
    const refused: Array<[string, string, Record<string, unknown>]> = [
      ["PUT", "/auth/openai", { type: "api", key: "sk-fake" }],
      ["POST", "/provider/anthropic/oauth/authorize", { method: 0 }],
      ["POST", "/provider/anthropic/oauth/callback", { method: 0, code: "c" }],
      ["PATCH", "/config", { provider: { openai: { options: { apiKey: "sk-fake" } } } }],
      ["PATCH", "/global/config", { model: "anthropic/claude-x" }],
      ["PATCH", "/config", { agent: { build: { model: "openai/gpt-x" } } }],
      ["POST", "/session/ses_1/prompt_async", { model: { providerID: "openai", modelID: "gpt-x" }, parts: [] }],
      ["POST", "/session/ses_1/message", { providerID: "openai", modelID: "gpt-x", parts: [] }],
      ["POST", "/session/ses_1/command", { command: "c", model: "openai/gpt-x" }],
      ["POST", "/api/session/ses_1/prompt", { model: { providerID: "opencode", modelID: "zen" } }],
      ["POST", "/session", { model: { providerID: "lpr_org1", id: "m" } }],
      ["POST", "/SESSION/ses_1/prompt_async", { model: { providerID: "openai", modelID: "gpt-x" } }],
      ["PUT", "/Auth/openai", { type: "api", key: "sk-fake" }],
      ["PATCH", "/API/Config", { model: "openai/gpt-x" }],
      ["POST", "/session/ses_1/prompt_async", { parts: [{ type: "subtask", prompt: "p", model: { providerID: "openai", modelID: "gpt-x" } }] }],
    ];
    for (const [method, path, body] of refused) expect([method, path, engineRequestProviderLockDenial(method, path, body)]).toEqual([method, path, "Only OmniRush models are available."]);
    const allowed: Array<[string, string, Record<string, unknown>]> = [
      ["GET", "/provider", {}],
      ["DELETE", "/auth/openai", {}],
      ["PUT", "/auth/omnirush", { type: "api", key: "k" }],
      ["PATCH", "/config", { disabled_providers: ["openai"], share: "disabled" }],
      ["POST", "/session/ses_1/prompt_async", { model: { providerID: "omnirush", modelID: "gpt-5" }, parts: [] }],
      ["POST", "/session/ses_1/prompt_async", { parts: [{ type: "text", text: "use openai/gpt-x" }] }],
    ];
    for (const [method, path, body] of allowed) expect([method, path, engineRequestProviderLockDenial(method, path, body)]).toEqual([method, path, null]);
    applyProviderLockAnswer(UNLOCKED);
    for (const [method, path, body] of refused) expect(engineRequestProviderLockDenial(method, path, body)).toBeNull();
  });

  test("a proxied request is read from a clone and refused with 403 provider_locked", async () => {
    const request = new Request("http://x/opencode/session/s/prompt_async", { method: "POST", body: JSON.stringify({ model: { providerID: "openai", modelID: "m" } }) });
    const error = await assertProxiedEngineRequestWithinProviderLock(request, "/opencode/session/s/prompt_async").catch((e) => e);
    expect(error).toMatchObject({ status: 403, code: "provider_locked", message: "Only OmniRush models are available." });
    expect(await request.json()).toEqual({ model: { providerID: "openai", modelID: "m" } });
    const ok = new Request("http://x/opencode/session/s/prompt_async", { method: "POST", body: JSON.stringify({ model: { providerID: "omnirush", modelID: "m" } }) });
    await assertProxiedEngineRequestWithinProviderLock(ok, "/opencode/session/s/prompt_async");
  });

  test("plugins: config and engine writes that add a user plugin are refused while locked", () => {
    expect(() => assertConfigWithinLock({ plugin: ["opencode-wakatime"] })).toThrow("Custom plugins are off while OmniRush models are locked.");
    expect(() => assertConfigWithinLock({ plugin: [] })).not.toThrow();
    expect(() => assertPluginsUnlocked()).toThrow("Custom plugins are off while OmniRush models are locked.");
    expect(engineRequestProviderLockDenial("PATCH", "/config", { plugin: ["x"] })).toBe("Custom plugins are off while OmniRush models are locked.");
    applyProviderLockAnswer(UNLOCKED);
    expect(() => assertConfigWithinLock({ plugin: ["opencode-wakatime"] })).not.toThrow();
    expect(() => assertPluginsUnlocked()).not.toThrow();
  });

  test("config writes that add another provider or its model are refused", () => {
    expect(() => assertConfigWithinProviderLock({ provider: { ollama: {} } })).toThrow("Only OmniRush models are available.");
    expect(() => assertConfigWithinProviderLock({ enabled_providers: ["openai"] })).toThrow();
    expect(() => assertConfigWithinProviderLock({ $schema: "x", mcp: {}, disabled_providers: ["openai"] })).not.toThrow();
    expect(() => assertConfigWithinProviderLock(null)).not.toThrow();
  });
});

describe("provider lock: the app's own provider and engines started unlocked", () => {
  test("no route writes the omnirush provider, locked or not", () => {
    expect(() => assertProviderWritable("omnirush")).toThrow("The OmniRush provider is set by the app only.");
    expect(() => assertProviderWritable("OmniRush")).toThrow();
    applyProviderLockAnswer(UNLOCKED);
    expect(() => assertProviderWritable("omnirush")).toThrow("The OmniRush provider is set by the app only.");
    expect(() => assertProviderWritable("openai")).not.toThrow();
  });

  test("an omnirush entry stored in the runtime row never reaches the engine config", () => {
    const stored = { provider: { omnirush: { npm: "@ai-sdk/openai", options: { baseURL: "https://evil.example/v1" }, models: { m: {} } } } };
    const signedIn = buildOmniRushRuntimeConfigObjectFromSnapshot(stored, { baseUrl: "http://127.0.0.1:1/omnirush-gateway/v1" }, {}, builtinOmniRushModelCatalog());
    expect(((signedIn.provider as Record<string, { options: { baseURL: string } }>).omnirush).options.baseURL).toBe("http://127.0.0.1:1/omnirush-gateway/v1");
    const signedOut = buildOmniRushRuntimeConfigObjectFromSnapshot(stored, undefined, {}, builtinOmniRushModelCatalog());
    expect(signedOut).not.toHaveProperty("provider");
    applyProviderLockAnswer(UNLOCKED);
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot(stored, undefined, {}, builtinOmniRushModelCatalog())).not.toHaveProperty("provider");
  });

  test("while locked, an engine that started unlocked takes no model work until the app restarts", () => {
    applyProviderLockAnswer(UNLOCKED);
    noteEngineStarted("http://127.0.0.1:4001");
    resetProviderLock();
    noteEngineStarted("http://127.0.0.1:4002");
    for (const [method, path] of [["POST", "/session"], ["POST", "/session/ses_1/prompt_async"], ["POST", "/opencode/session/ses_1/message"], ["POST", "/api/session/ses_1/command"], ["POST", "/session/ses_1/shell"], ["POST", "/session/ses_1/summarize"], ["POST", "/session/ses_1/revert"], ["POST", "/session/ses_1/unrevert"], ["POST", "/Session/ses_1/Prompt_Async"]] as const) {
      expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4001/", method, path)).toThrow("Only OmniRush models are available. Restart the app to continue.");
      expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4002", method, path)).not.toThrow();
    }
    expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4001", "GET", "/session/ses_1/message")).not.toThrow();
    expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4001", "POST", "/session/ses_1/abort")).not.toThrow();
    expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4999", "POST", "/session")).not.toThrow();
    expect(engineStartedUnlocked("http://127.0.0.1:4001/x")).toBe(true);
    expect(engineStartedUnlocked("http://127.0.0.1:4002")).toBe(false);
    applyProviderLockAnswer(UNLOCKED);
    expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4001", "POST", "/session")).not.toThrow();
  });

  test("while a locked engine takes over, a draining unlocked one answers retry with 503", () => {
    applyProviderLockAnswer(UNLOCKED);
    noteEngineStarted("http://127.0.0.1:4001");
    resetProviderLock();
    const error = (() => {
      try {
        assertEngineStartedWithinLock("http://127.0.0.1:4001", "POST", "/session/ses_1/prompt_async", currentProviderLockPolicy(), { switching: true });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toMatchObject({ status: 503, code: "provider_locked", message: "Switching to OmniRush models, retry in a moment." });
  });
});

describe("provider lock: engine route paths", () => {
  const send = (path: string, body: Record<string, unknown>, method = "POST") =>
    assertProxiedEngineRequestWithinProviderLock(new Request(`http://x${path.startsWith("/") ? "" : "/"}${path}`, { method, body: JSON.stringify(body) }), path).then(() => "ok", (error: { status?: number; code?: string }) => `${error.status} ${error.code}`);
  test("dot segments, encoded slashes or dots, backslashes, `;` and NUL are refused; repeated slashes still match", async () => {
    const plugin = { plugin: ["opencode-wakatime"] };
    const provider = { provider: { openai: { options: { apiKey: "sk-fake" } } } };
    expect(await send("/opencode/x/../config", plugin)).toBe("400 invalid_engine_path");
    expect(await send("/opencode/x/%2e%2e/config", plugin)).toBe("400 invalid_engine_path");
    expect(await send("/opencode/x/../auth/openai", { type: "api", key: "sk-fake" }, "PUT")).toBe("400 invalid_engine_path");
    expect(await send("/opencode/auth%2fopenai", { type: "api", key: "sk-fake" }, "PUT")).toBe("400 invalid_engine_path");
    expect(await send("/opencode/config;x", provider, "PATCH")).toBe("400 invalid_engine_path");
    expect(await send("/opencode/global//config", provider, "PATCH")).toBe("403 provider_locked");
    expect(await send("/opencode/config//", provider, "PATCH")).toBe("403 provider_locked");
    expect(await send("/opencode//global//config", provider, "PATCH")).toBe("403 provider_locked");
    expect(await send("/opencode/api//global//config", provider, "PATCH")).toBe("403 provider_locked");
    expect(await send("/opencode/provider//openai/oauth/authorize", { method: 0 })).toBe("403 provider_locked");
    expect(await send("/opencode/global//config", { plugin: ["x"] }, "PATCH")).toBe("403 plugins_locked");
    expect(await send("/opencode/session/ses_1/prompt_async", { model: { providerID: "omnirush", modelID: "m" } })).toBe("ok");
  });

  test("provider ids compare in lower case; an engine started unlocked is found behind an odd path too", () => {
    expect(providerAllowed("OmniRush")).toBe(true);
    applyProviderLockAnswer(UNLOCKED);
    noteEngineStarted("http://127.0.0.1:4010");
    resetProviderLock();
    expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4010", "POST", "/opencode//session/ses_1//prompt_async")).toThrow("Restart the app to continue.");
    expect(() => assertEngineStartedWithinLock("http://127.0.0.1:4010", "POST", "/opencode/x/../session")).toThrow("This engine route is not accepted.");
  });
});
