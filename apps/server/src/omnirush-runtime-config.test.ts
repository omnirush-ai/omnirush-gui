import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOmniRushRuntimeConfig,
  buildOmniRushRuntimeConfigObjectFromSnapshot,
  keepOmniRushRuntimeConfigFileFresh,
  omnirushRuntimeConfigFilePath,
  writeOmniRushRuntimeConfigFile,
} from "./omnirush-runtime-config.js";
import { writeGlobalRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { gitWorkflowPermissionRules } from "./opencode-plugins/managed-policy-git.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
  else process.env.OMNIRUSH_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-runtime-config-file-"));
  roots.push(root);
  previousDb = process.env.OMNIRUSH_RUNTIME_DB;
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

async function readConfigFile(config: ServerConfig): Promise<Record<string, unknown>> {
  const raw = await readFile(omnirushRuntimeConfigFilePath(config), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("omnirush runtime config file", () => {
  test("managed browser restrictions use scalar actions in global and agent permissions", () => {
    const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({
      managedPolicy: {
        execution: {
          commands: "deny", blockedCommands: ["curl *"],
          browserOrigins: ["https://approved.example"], blockBrowserUploads: true,
        },
      },
    });
    // The built-in git workflow rules come first; the organization's execution
    // rules are appended last so the engine's last-match-wins evaluation keeps them.
    const permission = { bash: { ...gitWorkflowPermissionRules(), "*": "deny", "curl *": "deny" }, webfetch: "deny", websearch: "deny" };
    expect(parsed.permission).toEqual(permission);
    expect(Object.keys((parsed.permission as { bash: Record<string, string> }).bash).slice(-2)).toEqual(["*", "curl *"]);
    expect(parsed.agent).toMatchObject({ omnirush: { permission } });
    expect(parsed.managedPolicy).toBeUndefined();
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({}).permission).toEqual({ bash: gitWorkflowPermissionRules() });
  });

  test("writes global-row MCPs and omnirush defaults into the file", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: {
        posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        "omnirush-connect-stale": { type: "remote", url: "https://cloud.example/stale", enabled: true },
      },
    }));

    const { path } = await writeOmniRushRuntimeConfigFile(config);
    expect(path).toBe(omnirushRuntimeConfigFilePath(config));

    const parsed = await readConfigFile(config);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.posthog?.enabled).toBe(true);
    expect(mcp["omnirush-connect-stale"]).toBeUndefined();
    expect(parsed.default_agent).toBe("omnirush");
    expect(Array.isArray(parsed.plugin)).toBe(true);
    if (!Array.isArray(parsed.plugin)) throw new Error("Expected runtime plugins");
    expect(parsed.plugin).not.toContain("opencode-chrome-devtools");
    expect(parsed.plugin.some(
      (plugin) => typeof plugin === "string" && /omnirush-chrome-devtools\.(?:ts|js)$/.test(plugin),
    )).toBe(true);
    expect(parsed.agent).toMatchObject({
      omnirush: {
        permission: {
          skill: {
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    });
  });

  test("injects the account-scoped internal gateway without persisting its access token", () => {
    const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({}, {
      baseUrl: "http://127.0.0.1:8090/omnirush/v1",
    });
    const providers = parsed.provider as Record<string, Record<string, unknown>>;

    expect(parsed.model).toBe("omnirush/gpt-6-astra");
    expect(providers.omnirush).toMatchObject({
      npm: "@ai-sdk/openai",
      name: "omnirush.ai",
      env: ["OMNIRUSH_ACCESS_TOKEN"],
      options: { baseURL: "http://127.0.0.1:8090/omnirush/v1" },
    });
    expect(JSON.stringify(parsed)).not.toContain("access-token");
  });

  test("exposes every omnirush.ai model with the shared effort levels, default first", () => {
    const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({}, {
      baseUrl: "http://127.0.0.1:8090/omnirush/v1",
    });
    const providers = parsed.provider as Record<string, { models: Record<string, Record<string, unknown>> }>;
    const models = providers.omnirush!.models;
    const variants = {
      low: { reasoning_effort: "low" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "xhigh" },
      max: { reasoning_effort: "max" },
      // The engine merges its own OpenAI reasoning defaults into a model's
      // variants and only drops entries marked disabled; these keep the
      // resolved picker at exactly the four levels above.
      none: { disabled: true },
      minimal: { disabled: true },
      medium: { disabled: true },
    };
    const enabledVariants = (model: Record<string, unknown>) => Object.entries(model.variants as Record<string, { disabled?: boolean }>)
      .filter(([, options]) => options.disabled !== true)
      .map(([key]) => key);

    expect(Object.keys(models)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
    expect(models["gpt-6-astra"]).toMatchObject({ name: "GPT 6 Astra", reasoning: true, tool_call: true, variants });
    expect(models["gpt-5.6-sol"]).toMatchObject({ name: "GPT-5.6 Sol", reasoning: true, tool_call: true, variants });
    for (const id of ["gpt-6-astra", "gpt-5.6-sol"]) {
      expect(Object.keys(models[id]!.variants as object).sort()).toEqual(Object.keys(variants).sort());
      expect(enabledVariants(models[id]!)).toEqual(["low", "high", "xhigh", "max"]);
    }
    expect(parsed.model).toBe("omnirush/gpt-6-astra");
    expect((parsed.plugin as string[]).some((plugin) => /omnirush-reasoning-effort\.(?:ts|js)$/.test(plugin))).toBe(true);
  });

  test("derives the desktop loopback gateway from the server config without process-global credentials", async () => {
    const { config } = await setup();
    config.port = 48123;
    config.omnirushEngineToken = "ephemeral-engine-token";
    config.omnirushGatewayCredentials = {
      gatewayUrl: "https://api.example.test/omnirush/v1",
      accessToken: "device-access-token",
      refreshToken: "device-refresh-token",
    };
    const previous = {
      engineGateway: process.env.OMNIRUSH_ENGINE_GATEWAY_URL,
      gateway: process.env.OMNIRUSH_GATEWAY_URL,
      access: process.env.OMNIRUSH_ACCESS_TOKEN,
    };
    try {
      delete process.env.OMNIRUSH_ENGINE_GATEWAY_URL;
      delete process.env.OMNIRUSH_GATEWAY_URL;
      delete process.env.OMNIRUSH_ACCESS_TOKEN;

      const parsed = JSON.parse(await buildOmniRushRuntimeConfig(config)) as Record<string, unknown>;
      const providers = parsed.provider as Record<string, Record<string, unknown>>;

      expect(parsed.model).toBe("omnirush/gpt-6-astra");
      expect(providers.omnirush).toMatchObject({
        env: ["OMNIRUSH_ACCESS_TOKEN"],
        options: { baseURL: "http://127.0.0.1:48123/omnirush-gateway/v1" },
      });
      expect(JSON.stringify(parsed)).not.toContain("device-access-token");
      expect(JSON.stringify(parsed)).not.toContain("device-refresh-token");
      expect(JSON.stringify(parsed)).not.toContain("ephemeral-engine-token");
    } finally {
      if (previous.engineGateway === undefined) delete process.env.OMNIRUSH_ENGINE_GATEWAY_URL;
      else process.env.OMNIRUSH_ENGINE_GATEWAY_URL = previous.engineGateway;
      if (previous.gateway === undefined) delete process.env.OMNIRUSH_GATEWAY_URL;
      else process.env.OMNIRUSH_GATEWAY_URL = previous.gateway;
      if (previous.access === undefined) delete process.env.OMNIRUSH_ACCESS_TOKEN;
      else process.env.OMNIRUSH_ACCESS_TOKEN = previous.access;
    }
  });

  test("reserves the internal provider id for the account-scoped gateway", () => {
    const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({
      provider: {
        omnirush: { npm: "untrusted-override", name: "Wrong route" },
      },
    }, {
      baseUrl: "https://api.omnirush.ai/omnirush/v1",
    });
    const providers = parsed.provider as Record<string, Record<string, unknown>>;

    expect(parsed.model).toBe("omnirush/gpt-6-astra");
    expect(providers.omnirush).toMatchObject({
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://api.omnirush.ai/omnirush/v1" },
    });
  });

  test("workspace runtime rows never reach the injected file", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
    }));

    await writeOmniRushRuntimeConfigFile(config);

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.posthog).toBeUndefined();
  });

  test("omnirush prompt states identity, repo memory, artifacts, and Connect routing once, without the removed Memory Bank", async () => {
    const { config } = await setup();
    await writeOmniRushRuntimeConfigFile(config);

    const parsed = await readConfigFile(config);
    const agent = parsed.agent as Record<string, { prompt?: string }>;
    const prompt = agent.omnirush?.prompt ?? "";

    expect(prompt.startsWith("You are omnirush.ai.")).toBe(true);
    expect(prompt).toContain("## Memory\n");
    expect(prompt).toContain("## OmniRush.ai Artifacts");
    expect(prompt).toContain("## Connected work");
    expect(prompt).toContain("delegate bounded, independent work to subagents");
    expect(prompt).toContain("make that many distinct task-tool calls");
    expect(prompt).toContain("Never replace an explicit delegation request with a simulated multi-role answer");
    expect(prompt).toContain("Wait for every delegated task");
    // Den removed the Memory Bank; the prompt must not teach capabilities that
    // the live catalog can no longer return.
    expect(prompt).not.toContain("Memory Bank");
    expect(prompt).not.toContain("postMemory");
    expect(prompt).not.toContain("getMemorySearch");
    // Connect tool names appear exactly once each, in the base prompt's own
    // routing paragraph; the diagnostics prompt markers key on them.
    expect(prompt.match(/omnirush-cloud_search_capabilities/g)).toHaveLength(1);
    expect(prompt.match(/omnirush-cloud_execute_capability/g)).toHaveLength(1);
    expect(prompt).not.toContain("2-4 keyword variants");
    // Skill capture defers to the runtime skill-authoring mode instead of
    // contradicting it with a workspace-only default.
    expect(prompt).toContain("`Skill creation:` instruction");
    expect(prompt).not.toContain("factor them into a skill");
  });

  test("keepOmniRushRuntimeConfigFileFresh rewrites the file on ENGINE_GLOBAL writes", async () => {
    const { config } = await setup();
    await writeOmniRushRuntimeConfigFile(config);
    cleanups.push(keepOmniRushRuntimeConfigFileFresh(config));

    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: { stripe: { type: "remote", url: "https://mcp.stripe.com", enabled: false } },
    }));

    // The refresh is fire-and-forget; poll briefly for the rewrite.
    let mcp: Record<string, Record<string, unknown>> = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const parsed = await readConfigFile(config);
      mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
      if (mcp.stripe) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mcp.stripe?.enabled).toBe(false);
  });

  test("workspace runtime writes do not rewrite the file", async () => {
    const { config } = await setup();
    await writeOmniRushRuntimeConfigFile(config);
    cleanups.push(keepOmniRushRuntimeConfigFileFresh(config));

    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { other: { type: "remote", url: "https://example.com/mcp", enabled: true } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.other).toBeUndefined();
  });

  test("builds byte-stable config for repeated snapshots", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp" } },
    }));

    const first = await buildOmniRushRuntimeConfig(config);
    const second = await buildOmniRushRuntimeConfig(config);

    expect(second).toBe(first);
  });

  test("builds byte-stable config for equivalent snapshots with different key order", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, () => ({
      mcp: {
        zeta: { url: "https://z.example/mcp", type: "remote" },
        alpha: { type: "remote", url: "https://a.example/mcp" },
      },
      provider: {
        zeta: { npm: "@ai-sdk/openai-compatible", name: "Zeta" },
        alpha: { name: "Alpha", npm: "@ai-sdk/openai-compatible" },
      },
    }));
    const first = await buildOmniRushRuntimeConfig(config);

    await writeGlobalRuntimeOpencodeConfig(config, () => ({
      provider: {
        alpha: { npm: "@ai-sdk/openai-compatible", name: "Alpha" },
        zeta: { name: "Zeta", npm: "@ai-sdk/openai-compatible" },
      },
      mcp: {
        alpha: { url: "https://a.example/mcp", type: "remote" },
        zeta: { type: "remote", url: "https://z.example/mcp" },
      },
    }));
    const second = await buildOmniRushRuntimeConfig(config);

    expect(second).toBe(first);
  });
});
