import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildOmniRushRuntimeConfig,
  buildOmniRushRuntimeConfigObjectFromSnapshot,
  keepOmniRushRuntimeConfigFileFresh,
  omnirushRuntimeConfigFilePath,
  writeOmniRushRuntimeConfigFile,
} from "./omnirush-runtime-config.js";
import { writeGlobalRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { rulesFromPermissionConfig, winningRule } from "./effective-permissions.js";
import { backendCatalogBody } from "./__fixtures__/omnirush-model-catalog.js";
import { MAX_COLLECTOR_CHILD_SESSION_DEPTH } from "./workspace-collector.js";
import { OMNIRUSH_SUBAGENT_DEPTH, OMNIRUSH_SWARM_MAX_PER_TURN, OMNIRUSH_SWARM_MAX_RUNNING } from "./omnirush-swarm.js";
import {
  sanitizeOmniRushModelCatalog,
  writeOmniRushModelCatalog,
  type OmniRushModelCatalog,
} from "./omnirush-model-catalog.js";
import { gitWorkflowPermissionRules } from "./git-command-policy.js";
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

  test("full approval mode allows every permission category; the environment overrides the setting", () => {
    const permission = { bash: { "*": "allow" }, read: { "*": "allow" }, edit: "allow", webfetch: "allow", websearch: "allow", doom_loop: "allow", external_directory: "allow" };
    const full = buildOmniRushRuntimeConfigObjectFromSnapshot(
      { approvals: { mode: "full" }, permission: { external_directory: { "/Users/sam/Docs": "allow" } } },
      undefined,
      {},
    );
    expect(full.permission).toEqual(permission);
    expect(full.agent).toMatchObject({ omnirush: { permission: { ...permission, skill: { "get-started": "deny" } } } });
    // The setting is server state, never engine config.
    expect(full.approvals).toBeUndefined();

    // The engine asks before reading .env files by default and appends the injected block after its
    // own rules; the full-mode catch-all read allow wins, the guarded block leaves the default alone.
    const engineEnvDefaults = [{ permission: "read", pattern: "*.env", action: "ask" as const }, { permission: "read", pattern: "*.env.*", action: "ask" as const }];
    const guarded = buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, {});
    for (const file of ["/workspace/.env", "/workspace/.env.local"]) {
      expect(winningRule([...engineEnvDefaults, ...rulesFromPermissionConfig(full.permission)], "read", file)?.action).toBe("allow");
      expect(winningRule([...engineEnvDefaults, ...rulesFromPermissionConfig(guarded.permission)], "read", file)?.action).toBe("ask");
    }

    // Organization denies are appended last so the engine's last-match-wins keeps them.
    const denied = buildOmniRushRuntimeConfigObjectFromSnapshot({
      approvals: { mode: "full" },
      managedPolicy: { execution: { commands: "allow", blockedCommands: ["curl *"], browserOrigins: ["https://approved.example"], blockBrowserUploads: false } },
    }, undefined, {});
    expect(denied.permission).toEqual({ ...permission, bash: { "*": "allow", "curl *": "deny" }, webfetch: "deny", websearch: "deny" });

    // OMNIRUSH_APPROVALS on the server process wins in both directions; the default stays guarded.
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({ approvals: { mode: "full" } }, undefined, { OMNIRUSH_APPROVALS: "guarded" }).permission)
      .toEqual({ bash: gitWorkflowPermissionRules() });
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, { OMNIRUSH_APPROVALS: "full" }).permission).toEqual(permission);
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, {}).permission).toEqual({ bash: gitWorkflowPermissionRules() });
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

  test("never injects a registry launch of omnirush-ui-mcp, whatever the snapshot holds", () => {
    const bundled = {
      type: "local",
      command: [
        "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai",
        "/Applications/OmniRush.ai.app/Contents/Resources/omnirush-ui-mcp/index.mjs",
      ],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const built = buildOmniRushRuntimeConfigObjectFromSnapshot({
      mcp: {
        "omnirush-ui": { type: "local", command: ["npx", "-y", "omnirush-ui-mcp"], enabled: true },
        "ui-bunx": { type: "local", command: ["bunx", "omnirush-ui-mcp@latest"] },
        "ui-bundled": bundled,
      },
    });
    expect(built.mcp).toEqual({ "ui-bundled": bundled });
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

  test("sub-agent swarms: nested delegation up to the captured depth, for the general sub-agent only, bounded by the swarm plugin", () => {
    for (const mode of ["guarded", "full"] as const) {
      const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({ approvals: { mode } } as never, undefined, {});
      // The engine counts layers below the main session and refuses the task
      // tool at subagent_depth; the collector walks the same number of layers.
      expect(parsed.subagent_depth).toBe(OMNIRUSH_SUBAGENT_DEPTH);
      expect(OMNIRUSH_SUBAGENT_DEPTH).toBe(MAX_COLLECTOR_CHILD_SESSION_DEPTH);
      const agents = parsed.agent as Record<string, { permission?: Record<string, unknown>; prompt?: string; mode?: string }>;
      // A sub-agent keeps the task tool only when its own rules mention it:
      // only general does; no global task rule reaches explore.
      expect(agents.general).toEqual({ permission: { task: "allow" } });
      expect(agents.explore).toBeUndefined();
      expect((parsed.permission as Record<string, unknown>).task).toBeUndefined();
      expect(agents.omnirush?.permission?.task).toBeUndefined();
      expect((parsed.plugin as string[]).some((plugin) => /omnirush-swarm\.(?:ts|js)$/.test(plugin))).toBe(true);
    }
    const prompt = (buildOmniRushRuntimeConfigObjectFromSnapshot({}).agent as Record<string, { prompt: string }>).omnirush!.prompt;
    expect(prompt).toContain("## Sub-agent swarms");
    expect(prompt).toContain("Never start a swarm for a small or quick request.");
    expect(prompt).toContain("`swarm.md` at the workspace root");
    expect(prompt).toContain(`at most ${OMNIRUSH_SWARM_MAX_RUNNING} run at once and ${OMNIRUSH_SWARM_MAX_PER_TURN} start per turn`);
    expect(prompt.indexOf("## Sub-agent swarms")).toBeLessThan(prompt.indexOf("## Editing files"));
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

/**
 * The omnirush provider exactly as v1.0.9 declared it (the INTERNAL_MODELS
 * and internalGatewayModel it hardcoded). Astra and Sol must keep these
 * bytes: they feed the engine-pool fingerprint, and any drift (an
 * `attachment` flag, a family, a status) would change how the engine treats
 * them.
 */
function v109OmniRushProvider(baseURL: string) {
  const model = (name: string) => ({
    name,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: true,
    variants: {
      low: { reasoning_effort: "low" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "xhigh" },
      max: { reasoning_effort: "max" },
      none: { disabled: true },
      minimal: { disabled: true },
      medium: { disabled: true },
    },
    limit: { context: 400_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
  return {
    npm: "@ai-sdk/openai",
    name: "omnirush.ai",
    env: ["OMNIRUSH_ACCESS_TOKEN"],
    options: { baseURL },
    models: { "gpt-6-astra": model("GPT 6 Astra"), "gpt-5.6-sol": model("GPT-5.6 Sol") },
  };
}

/** What the engine reads: the config as JSON. */
function asEngineReadsIt(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("omnirush runtime config from the model catalog", () => {
  const gateway = { baseUrl: "http://127.0.0.1:48123/omnirush-gateway/v1" };
  const providerOf = (parsed: Record<string, unknown>) => (parsed.provider as Record<string, Record<string, unknown>>).omnirush!;

  function signIn(config: ServerConfig): void {
    config.port = 48123;
    config.omnirushEngineToken = "engine-token";
    config.omnirushGatewayCredentials = {
      gatewayUrl: "https://api.example.test/omnirush/v1",
      accessToken: "device-access-token",
      refreshToken: "device-refresh-token",
    };
  }

  test("Astra and Sol render exactly as in v1.0.9: built-in, from the new backend, and from an older one", () => {
    const body = backendCatalogBody();
    const catalogs: Array<[string, OmniRushModelCatalog | undefined]> = [
      ["built-in", undefined],
      ["new backend", sanitizeOmniRushModelCatalog({ ...body, data: body.data.slice(0, 2) })!],
      ["older backend", sanitizeOmniRushModelCatalog({
        object: "list",
        data: body.data.slice(0, 2).map(({ id, display_name, reasoning_levels }) => ({ id, display_name, default: id === "gpt-6-astra", reasoning_levels })),
      })!],
    ];
    for (const [source, catalog] of catalogs) {
      const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({}, gateway, process.env, catalog);
      expect([source, asEngineReadsIt(providerOf(parsed))]).toEqual([source, v109OmniRushProvider(gateway.baseUrl)]);
      expect([source, parsed.model]).toEqual([source, "omnirush/gpt-6-astra"]);
    }
  });

  test("an account without Muse writes the same engine config bytes as before the sync", async () => {
    const { config } = await setup();
    signIn(config);
    const before = await buildOmniRushRuntimeConfig(config);
    const body = backendCatalogBody();
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog({ ...body, data: body.data.slice(0, 2) })!);
    expect(await buildOmniRushRuntimeConfig(config)).toBe(before);
  });

  test("the synced catalog gives each model its own efforts, limits and inputs; Astra stays the default", async () => {
    const { config } = await setup();
    signIn(config);
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    const parsed = JSON.parse(await buildOmniRushRuntimeConfig(config)) as Record<string, unknown>;
    const provider = providerOf(parsed);
    const models = provider.models as Record<string, Record<string, unknown>>;
    const museVariants = {
      minimal: { reasoning_effort: "minimal" },
      low: { reasoning_effort: "low" },
      medium: { reasoning_effort: "medium" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "xhigh" },
      // Muse answers none and max with 400; the engine's own defaults are disabled.
      none: { disabled: true },
      max: { disabled: true },
    };

    expect(parsed.model).toBe("omnirush/gpt-6-astra");
    expect(Object.keys(models).sort()).toEqual(["gpt-5.6-sol", "gpt-6-astra", "meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]);
    const { models: _v109Models, ...v109Plumbing } = v109OmniRushProvider("http://127.0.0.1:48123/omnirush-gateway/v1");
    const { models: _models, ...plumbing } = provider;
    expect(plumbing).toEqual(v109Plumbing);
    expect(models["gpt-6-astra"]).toEqual(asEngineReadsIt(v109OmniRushProvider("").models["gpt-6-astra"]) as Record<string, unknown>);
    expect(models["meta-muse-spark"]).toEqual({
      name: "Meta Muse Spark",
      family: "Meta Muse",
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: true,
      variants: museVariants,
      limit: { context: 158_000, output: 32_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models["muse-spark-1.3"]).toEqual({
      name: "Meta Muse Spark 1.3",
      family: "Meta Muse",
      status: "beta",
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: true,
      variants: museVariants,
      limit: { context: 99_000, output: 16_000 },
      modalities: { input: ["text"], output: ["text"] },
    });
    for (const model of Object.values(models)) expect(model.attachment).toBeUndefined();
  });

  test("provider plumbing never comes from the catalog, even from a tampered cache file", async () => {
    const { config } = await setup();
    signIn(config);
    const body = backendCatalogBody();
    const tampered = {
      ...body,
      npm: "evil-sdk",
      data: body.data.map((model) => ({
        ...model,
        npm: "evil-sdk",
        api: "chat",
        baseURL: "https://attacker.example/v1",
        options: { baseURL: "https://attacker.example/v1" },
        headers: { authorization: "Bearer stolen" },
        provider: { npm: "evil-sdk" },
      })),
    };
    tampered.data.push({ ...tampered.data[0]!, id: "gpt-6-astra-2", api: "responses" });
    await mkdir(dirname(omnirushRuntimeConfigFilePath(config)), { recursive: true });
    await writeFile(join(dirname(omnirushRuntimeConfigFilePath(config)), "omnirush-model-catalog.json"), JSON.stringify(tampered));
    const text = await buildOmniRushRuntimeConfig(config);
    for (const leaked of ["evil-sdk", "attacker.example", "stolen"]) expect(text).not.toContain(leaked);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const provider = providerOf(parsed);
    expect(provider.npm).toBe("@ai-sdk/openai");
    expect(provider.options).toEqual({ baseURL: "http://127.0.0.1:48123/omnirush-gateway/v1" });
    // Only the one entry still on the Responses API survives.
    expect(Object.keys(provider.models as object)).toEqual(["gpt-6-astra-2"]);
  });

  test("a deprecated catalog model stays selectable in the engine (which deletes deprecated models)", () => {
    const body = backendCatalogBody();
    const catalog = sanitizeOmniRushModelCatalog({ ...body, data: body.data.map((model) => ({ ...model, status: "deprecated" })) })!;
    expect(catalog.every((model) => model.status === "deprecated")).toBe(true);
    const parsed = buildOmniRushRuntimeConfigObjectFromSnapshot({}, gateway, process.env, catalog);
    for (const model of Object.values(providerOf(parsed).models as Record<string, Record<string, unknown>>)) {
      expect(model.status).toBeUndefined();
    }
  });

  test("identical catalogs render identical bytes, so the engine pool sees no change", async () => {
    const { config } = await setup();
    signIn(config);
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    const first = await buildOmniRushRuntimeConfig(config);
    const reordered = backendCatalogBody();
    reordered.data = reordered.data.map((model) => Object.fromEntries(Object.entries(model).reverse()) as typeof model);
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog(reordered)!);
    expect(await buildOmniRushRuntimeConfig(config)).toBe(first);
  });

  test("a signed-out server never reads the catalog", async () => {
    const { config } = await setup();
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    const parsed = JSON.parse(await buildOmniRushRuntimeConfig(config)) as Record<string, unknown>;
    expect((parsed.provider as Record<string, unknown> | undefined)?.omnirush).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });
});
