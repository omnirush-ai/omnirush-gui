import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApprovalMode } from "./approval-mode.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { policyRequestActions } from "./managed-policy-rules.js";
import { addMcp, listMcp, setMcpEnabled } from "./mcp.js";
import { buildOmniRushRuntimeConfig } from "./omnirush-runtime-config.js";
import { readOmniRushWorkspaceConfig } from "./omnirush-workspace-config-store.js";
import { addPlugin, listPlugins, removePlugin } from "./plugins.js";
import {
  ENGINE_GLOBAL_RUNTIME_CONFIG_ID,
  migrateWorkspaceRuntimeConfigToEngineGlobal,
  onRuntimeOpencodeConfigWrite,
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  writeGlobalRuntimeOpencodeConfig,
  writeManagedDesktopPolicy,
  readEffectiveRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_runtime_test";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

function serverConfig(root: string, dbPath: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function withWorkspace(fn: (input: { root: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-runtime-config-"));
  const previousDb = process.env.OMNIRUSH_RUNTIME_DB;
  const previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const dbPath = join(root, "runtime.sqlite");
  process.env.OMNIRUSH_RUNTIME_DB = dbPath;
  // MCP listings merge the global OpenCode config layer, so point it at an
  // empty directory inside the fixture. Without this the assertions observe
  // whatever MCP servers the developer happens to have in ~/.config/opencode.
  process.env.OPENCODE_CONFIG_DIR = join(root, "global-opencode");
  await mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
  try {
    await fn({ root, config: serverConfig(root, dbPath) });
  } finally {
    if (previousDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
    else process.env.OMNIRUSH_RUNTIME_DB = previousDb;
    if (previousOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousOpencodeConfigDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toThrow();
}

describe("runtime OpenCode config store", () => {
  test("ordinary concurrent config writes preserve the verified policy in every workspace", async () => {
    await withWorkspace(async ({ config }) => {
      const policy: import("@omnirush/types/den/desktop-policies").DesktopConfig = { allowManageExtensions: false, execution: { commands: "deny", blockedCommands: [], blockBrowserUploads: true } };
      await writeManagedDesktopPolicy(config, policy);
      await Promise.all(Array.from({ length: 12 }, (_, index) => writeGlobalRuntimeOpencodeConfig(config, (current) => ({
        ...current, provider: { ...current.provider, [`provider-${index}`]: { name: `Provider ${index}` } },
        managedPolicy: { allowManageExtensions: true },
      }))));
      await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({ managedPolicy: { allowManageExtensions: true }, plugin: [] }));
      const global = await readGlobalRuntimeOpencodeConfig(config);
      expect(Object.keys(global.provider ?? {})).toHaveLength(12);
      expect(global.managedPolicy).toEqual(policy);
      expect((await readEffectiveRuntimeOpencodeConfig(config, WORKSPACE_ID)).managedPolicy).toEqual(policy);
    });
  });

  test("reports no-op writes without notifying listeners", async () => {
    await withWorkspace(async ({ config }) => {
      let writes = 0;
      const unsubscribe = onRuntimeOpencodeConfigWrite((writtenConfig, workspaceId) => {
        if (writtenConfig === config && workspaceId === WORKSPACE_ID) {
          writes += 1;
        }
      });

      try {
        const first = await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
          ...current,
          mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
        }));
        expect(first.changed).toBe(true);
        expect(writes).toBe(1);

        const second = await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
          ...current,
          mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
        }));
        expect(second.changed).toBe(false);
        expect(second.config).toEqual(first.config);
        expect(writes).toBe(1);

        const third = await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
          ...current,
          mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: false } },
        }));
        expect(third.changed).toBe(true);
        expect(writes).toBe(2);
      } finally {
        unsubscribe();
      }
    });
  });

  test("stores MCP changes in the OmniRush.ai runtime DB without rewriting workspace files", async () => {
    await withWorkspace(async ({ root, config }) => {
      const opencodePath = join(root, "opencode.jsonc");
      const opencode = '{\n  "mcp": {\n    "project": { "type": "remote", "url": "https://project.example/mcp" }\n  }\n}\n';
      await writeFile(opencodePath, opencode, "utf8");

      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp", enabled: true });
      await setMcpEnabled(config, WORKSPACE_ID, "runtime", false);

      expect(await readFile(opencodePath, "utf8")).toBe(opencode);
      await expectMissing(join(root, ".opencode", "omnirush.json"));
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.runtime?.enabled).toBe(false);

      const items = await listMcp(config, WORKSPACE_ID, root);
      expect(items.map((item) => `${item.name}:${item.source}`)).toContain("project:config.project");
      expect(items.map((item) => `${item.name}:${item.source}`)).toContain("runtime:config.remote");
    });
  });

  test("stores plugin changes in the OmniRush.ai runtime DB without rewriting workspace files", async () => {
    await withWorkspace(async ({ root, config }) => {
      const opencodePath = join(root, "opencode.jsonc");
      const opencode = '{\n  "plugin": ["project-plugin"]\n}\n';
      await writeFile(opencodePath, opencode, "utf8");

      expect(await addPlugin(config, "runtime-plugin")).toBe(true);
      expect(await removePlugin(config, "runtime-plugin")).toBe(true);
      expect(await addPlugin(config, "runtime-plugin")).toBe(true);

      expect(await readFile(opencodePath, "utf8")).toBe(opencode);
      await expectMissing(join(root, ".opencode", "omnirush.json"));
      // Runtime plugins are engine-global so the injected file carries them.
      expect((await readGlobalRuntimeOpencodeConfig(config)).plugin).toEqual(["runtime-plugin"]);

      const result = await listPlugins(config, WORKSPACE_ID, root, false);
      expect(result.items.map((item) => item.spec)).toEqual(["project-plugin", "runtime-plugin"]);

      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp", enabled: true });
      const runtimeConfig = JSON.parse(await buildOmniRushRuntimeConfig(config)) as {
        plugin?: string[];
        mcp?: Record<string, Record<string, unknown>>;
      };
      expect(runtimeConfig.plugin).toContain("runtime-plugin");
      // Per-workspace MCPs reach the engine via the dynamic push, not the file.
      expect(runtimeConfig.mcp?.runtime).toBeUndefined();
    });
  });

  test("malformed user opencode config does not block runtime config reads", async () => {
    await withWorkspace(async ({ root, config }) => {
      await writeFile(join(root, "opencode.jsonc"), '{ "mcp": {\n}\n}\n}\n', "utf8");
      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp", enabled: true });
      await addPlugin(config, "runtime-plugin");

      const mcpItems = await listMcp(config, WORKSPACE_ID, root);
      const pluginItems = await listPlugins(config, WORKSPACE_ID, root, false);

      expect(mcpItems.map((item) => item.name)).toEqual(["runtime"]);
      expect(pluginItems.items.map((item) => item.spec)).toEqual(["runtime-plugin"]);
    });
  });

  test("stores OmniRush.ai-owned workspace config in the runtime DB without writing legacy files", async () => {
    await withWorkspace(async ({ root, config }) => {
      const server = await startServer(config) as Served;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/config`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            omnirush: {
              cloudImports: {
                plugins: {
                  plugin_1: { pluginId: "plugin_1", name: "productivity", files: [] },
                },
              },
            },
          }),
        });
        expect(response.status).toBe(200);

        const legacyOmniRushPath = join(root, ".opencode", "omnirush.json");
        const legacyOmniRush = await readFile(legacyOmniRushPath, "utf8").catch(() => "");
        expect(legacyOmniRush).not.toContain("productivity");
        expect(legacyOmniRush).not.toContain("cloudImports");
        expect((await readOmniRushWorkspaceConfig(config, WORKSPACE_ID)).cloudImports).toEqual({
          plugins: {
            plugin_1: { pluginId: "plugin_1", name: "productivity", files: [] },
          },
        });

        const configResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/config`, {
          headers: { authorization: `Bearer ${config.token}` },
        });
        expect(configResponse.status).toBe(200);
        expect(await configResponse.json()).toMatchObject({
          omnirush: {
            cloudImports: {
              plugins: {
                plugin_1: { pluginId: "plugin_1", name: "productivity", files: [] },
              },
            },
          },
        });
      } finally {
        await server.stop(true);
      }
    });
  });

  test("folds workspace-scoped runtime config into the ENGINE_GLOBAL row once", async () => {
    await withWorkspace(async ({ config }) => {
      await writeRuntimeOpencodeConfig(config, "ws_a", () => ({
        plugin: ["plugin-a", "plugin-shared"],
        disabled_providers: ["anthropic"],
        permission: { external_directory: { "/folders/a": "allow" } },
        mcp: { notion: { type: "remote", url: "https://notion.example/mcp" } },
        provider: { "user-lmstudio": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://a.example/v1" } }, local: { npm: "stale-copy" } },
        default_agent: "omnirush",
      }));
      await Bun.sleep(2);
      await writeRuntimeOpencodeConfig(config, "ws_b", () => ({
        plugin: ["plugin-b", "plugin-shared"],
        disabled_providers: ["anthropic", "openai"],
        permission: { external_directory: { "/folders/b": "allow" } },
        provider: { "user-lmstudio": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://b.example/v1" } } },
      }));
      await writeGlobalRuntimeOpencodeConfig(config, () => ({
        plugin: ["plugin-global"],
        provider: { local: { npm: "@ai-sdk/openai-compatible" } },
      }));

      const first = await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
      expect(first.changed).toBe(true);

      const globalRuntime = await readGlobalRuntimeOpencodeConfig(config);
      expect(globalRuntime.plugin).toEqual(["plugin-global", "plugin-a", "plugin-shared", "plugin-b"]);
      expect(globalRuntime.disabled_providers).toEqual(["anthropic", "openai"]);
      expect(globalRuntime.permission?.external_directory).toEqual({
        "/folders/a": "allow",
        "/folders/b": "allow",
      });
      // Providers fold globally: the global row wins per key (cloud-managed
      // authority beats the stale ws_a copy of `local`), and the newest
      // workspace write wins between workspace rows.
      expect(globalRuntime.provider?.local).toEqual({ npm: "@ai-sdk/openai-compatible" });
      expect(globalRuntime.provider?.["user-lmstudio"]).toEqual({
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://b.example/v1" },
      });

      // Workspace rows are cleaned; mcp stays per-workspace (dynamic push owns delivery).
      const workspaceA = await readRuntimeOpencodeConfig(config, "ws_a");
      expect(workspaceA.plugin).toBeUndefined();
      expect(workspaceA.disabled_providers).toBeUndefined();
      expect(workspaceA.permission).toBeUndefined();
      expect(workspaceA.provider).toBeUndefined();
      expect(workspaceA.mcp?.notion?.url).toBe("https://notion.example/mcp");
      expect(workspaceA.default_agent).toBe("omnirush");
      expect(await readRuntimeOpencodeConfig(config, "ws_b")).toEqual({});

      const second = await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
      expect(second.changed).toBe(false);
      expect(await readGlobalRuntimeOpencodeConfig(config)).toEqual(globalRuntime);
    });
  });

  test("workspace-to-global migration does not touch a read-only runtime DB", async () => {
    await withWorkspace(async ({ config }) => {
      await writeRuntimeOpencodeConfig(config, "ws_a", () => ({ plugin: ["plugin-a"] }));
      const readOnlyConfig: ServerConfig = { ...config, readOnly: true };

      const result = await migrateWorkspaceRuntimeConfigToEngineGlobal(readOnlyConfig);

      expect(result.changed).toBe(false);
      expect((await readRuntimeOpencodeConfig(config, "ws_a")).plugin).toEqual(["plugin-a"]);
      expect(await readRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID)).toEqual({});
    });
  });

  test("runtime config status tolerates malformed legacy OmniRush.ai metadata", async () => {
    await withWorkspace(async ({ root, config }) => {
      await mkdir(join(root, ".opencode"), { recursive: true });
      await writeFile(join(root, ".opencode", "omnirush.json"), "{ invalid\n", "utf8");
      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp" });

      const server = await startServer(config) as Served;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/runtime-config`, {
          headers: { authorization: `Bearer ${config.token}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          runtimeKeys: ["mcp"],
        });
      } finally {
        await server.stop(true);
      }
    });
  });

  test("approval mode persists in the global row, OMNIRUSH_APPROVALS overrides it, and the engine plugin is told", async () => {
    await withWorkspace(async ({ config }) => {
      const previousMode = process.env.OMNIRUSH_APPROVALS;
      delete process.env.OMNIRUSH_APPROVALS;
      const server = await startServer(config) as Served;
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
      const readApprovals = async () => (await fetch(`${base}/runtime-config/approvals`, { headers })).json();
      const policyHeaders = { authorization: `Bearer ${managedDesktopPolicy(config).evaluationToken}`, "content-type": "application/json" };
      const evaluate = async () => (await fetch(`${base}/managed-policy/evaluate`, {
        method: "POST", headers: policyHeaders, body: JSON.stringify({ action: "shell", input: { command: "git status" } }),
      })).json();
      try {
        expect(await readApprovals()).toEqual({ mode: "guarded", source: "default", setting: null });
        expect(await evaluate()).toEqual({ allowed: true, approvalMode: "guarded" });

        const invalid = await fetch(`${base}/runtime-config/approvals`, { method: "PUT", headers, body: JSON.stringify({ mode: "yes" }) });
        expect(invalid.status).toBe(400);

        const enabled = await fetch(`${base}/runtime-config/approvals`, { method: "PUT", headers, body: JSON.stringify({ mode: "full" }) });
        expect(enabled.status).toBe(200);
        expect(await enabled.json()).toEqual({ ok: true, changed: true, mode: "full", source: "settings", setting: "full" });
        expect((await readGlobalRuntimeOpencodeConfig(config)).approvals).toEqual({ mode: "full" });
        // Workspace rows never carry the mode; the effective config inherits the global one.
        expect((await readEffectiveRuntimeOpencodeConfig(config, WORKSPACE_ID)).approvals).toEqual({ mode: "full" });
        // The injected engine config follows the row; the setting itself stays out of it.
        const injected = JSON.parse(await buildOmniRushRuntimeConfig(config)) as { permission?: { bash?: Record<string, string> }; approvals?: unknown };
        expect(injected.permission?.bash).toEqual({ "*": "allow" });
        expect(injected.approvals).toBeUndefined();
        // Every evaluate answer carries the mode, so the plugin needs no restart.
        expect(await evaluate()).toEqual({ allowed: true, approvalMode: "full" });

        // The environment wins over the setting; Settings shows the switch disabled.
        process.env.OMNIRUSH_APPROVALS = "guarded";
        expect(await readApprovals()).toEqual({ mode: "guarded", source: "environment", setting: "full" });
        expect(await evaluate()).toEqual({ allowed: true, approvalMode: "guarded" });
        const guarded = JSON.parse(await buildOmniRushRuntimeConfig(config)) as { permission?: { bash?: Record<string, string> } };
        expect(guarded.permission?.bash?.["*"]).toBeUndefined();

        expect(resolveApprovalMode({ approvals: { mode: "guarded" } }, { OMNIRUSH_APPROVALS: " FULL " })).toEqual({ mode: "full", source: "environment", setting: "guarded" });
        expect(resolveApprovalMode({}, { OMNIRUSH_APPROVALS: "yes" })).toEqual({ mode: "guarded", source: "default", setting: null });
        // Organizations that lock settings lock the switch as well.
        expect(policyRequestActions("PUT", "/runtime-config/approvals")).toEqual(["settings"]);
      } finally {
        if (previousMode === undefined) delete process.env.OMNIRUSH_APPROVALS;
        else process.env.OMNIRUSH_APPROVALS = previousMode;
        await server.stop(true);
      }
    });
  });
});
