import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFs } from "./atomic-write.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { policyRequestActions } from "./managed-policy-rules.js";
import { readSubagentModelSetting } from "./omnirush-subagent-model.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const ENV_KEYS = ["OMNIRUSH_RUNTIME_DB", "OPENCODE_CONFIG_DIR", "OMNIRUSH_ENGINE_GATEWAY_URL", "OMNIRUSH_ACCESS_TOKEN"] as const;

async function withServer(fn: (input: { base: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-subagent-routes-"));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENCODE_CONFIG_DIR = join(root, "global-opencode");
  // The engine config names the omnirush.ai provider (a signed-in account).
  process.env.OMNIRUSH_ENGINE_GATEWAY_URL = "http://127.0.0.1:9/omnirush-gateway/v1";
  process.env.OMNIRUSH_ACCESS_TOKEN = "engine-token";
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: "ws_subagents", name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
  const server = await startServer(config) as Served;
  try {
    await fn({ base: `http://127.0.0.1:${server.port}`, config });
  } finally {
    await server.stop(true);
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

describe("sub-agent model routes", () => {
  test("the app reads and writes the setting; the engine plugin resolves sub-agent prompts against it", async () => {
    await withServer(async ({ base, config }) => {
      const client = { authorization: "Bearer token", "content-type": "application/json" };
      const policy = { authorization: `Bearer ${managedDesktopPolicy(config).evaluationToken}`, "content-type": "application/json" };
      const read = async () => (await fetch(`${base}/omnirush/subagent-model`, { headers: client })).json() as Promise<Record<string, unknown>>;
      const resolve = async (body: unknown) => {
        const response = await fetch(`${base}/omnirush/subagent-model/resolve`, { method: "POST", headers: policy, body: JSON.stringify(body) });
        expect(response.status).toBe(200);
        return response.json() as Promise<Record<string, unknown>>;
      };
      const main = { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" };

      const initial = await read();
      expect(initial.setting).toEqual({ model: null, effort: null });
      expect(initial.signedIn).toBe(true);
      expect((initial.models as Array<{ id: string; name: string; efforts: string[] }>).map((model) => [model.id, model.name, model.efforts.join(",")])).toEqual([
        ["gpt-6-astra", "GPT 6 Astra", "low,high,xhigh,max"],
        ["gpt-6-sol", "GPT 6 Sol", "low,high,xhigh,max"],
        ["gpt-5.6-sol", "GPT-5.6 Sol", "low,high,xhigh,max"],
      ]);
      // Untouched: sub-agent prompts stay as the engine made them.
      expect(await resolve({ sessionId: "ses_child", rootSessionId: "ses_main", inherited: main, main })).toEqual({});

      const bad = await fetch(`${base}/omnirush/subagent-model`, { method: "PUT", headers: client, body: JSON.stringify({ model: "gpt-6-sol", effort: "turbo" }) });
      expect(bad.status).toBe(400);
      const put = await fetch(`${base}/omnirush/subagent-model`, { method: "PUT", headers: client, body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }) });
      expect(await put.json()).toEqual({ ok: true, setting: { model: "gpt-6-sol", effort: "high" } });
      expect(await readSubagentModelSetting(config)).toEqual({ model: "gpt-6-sol", effort: "high" });

      expect(await resolve({ sessionId: "ses_child", rootSessionId: "ses_main", inherited: main, main })).toEqual({
        model: { providerID: "omnirush", modelID: "gpt-6-sol" },
        variant: "high",
        gatewayFallback: { model: "gpt-6-astra", effort: "high" },
      });

      // Meta Muse is not in this account's catalog: the sub-agent stays on the main model.
      await fetch(`${base}/omnirush/subagent-model`, { method: "PUT", headers: client, body: JSON.stringify({ model: "meta-muse-spark", effort: null }) });
      expect(await resolve({ sessionId: "ses_child", rootSessionId: "ses_main", inherited: main, main })).toMatchObject({
        model: { providerID: "omnirush", modelID: "gpt-6-astra" },
        variant: "max",
        fallback: { requested: "meta-muse-spark", used: "gpt-6-astra", reason: "not_in_catalog" },
      });

      // Back to "same as main".
      await fetch(`${base}/omnirush/subagent-model`, { method: "PUT", headers: client, body: JSON.stringify({ model: null, effort: null }) });
      expect((await read()).setting).toEqual({ model: null, effort: null });

      // The plugin's routes need the evaluation (or a client) token.
      const anonymous = await fetch(`${base}/omnirush/subagent-model/resolve`, { method: "POST", body: JSON.stringify({ inherited: main }) });
      expect(anonymous.status).toBe(401);
      const fallbacks = await fetch(`${base}/omnirush/subagent-model/fallbacks?session=ses_child`, { headers: policy });
      expect(await fallbacks.json()).toEqual({ fallbacks: [] });
    });
  });

  test("a save the disk keeps refusing answers a readable error and keeps the previous setting", async () => {
    await withServer(async ({ base, config }) => {
      const client = { authorization: "Bearer token", "content-type": "application/json" };
      const put = (body: unknown) => fetch(`${base}/omnirush/subagent-model`, { method: "PUT", headers: client, body: JSON.stringify(body) });
      expect((await put({ model: "gpt-6-astra", effort: "low" })).status).toBe(200);

      const original = { ...atomicWriteFs };
      let renames = 0;
      // Windows: antivirus or the indexer holds the file for longer than the retries last.
      atomicWriteFs.rename = async () => {
        renames += 1;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      };
      atomicWriteFs.sleep = async () => undefined;
      let failed: Response;
      try {
        failed = await put({ model: "gpt-6-sol", effort: "high" });
      } finally {
        Object.assign(atomicWriteFs, original);
      }
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({
        code: "settings_write_failed",
        message: "The sub-agent setting could not be saved: EPERM",
        details: { code: "EPERM" },
      });
      expect(renames).toBe(10);

      const read = await fetch(`${base}/omnirush/subagent-model`, { headers: client });
      expect(((await read.json()) as { setting: unknown }).setting).toEqual({ model: "gpt-6-astra", effort: "low" });
      expect(await readSubagentModelSetting(config)).toEqual({ model: "gpt-6-astra", effort: "low" });
    });
  });

  test("organizations that lock settings lock the sub-agent setting too", () => {
    expect(policyRequestActions("PUT", "/omnirush/subagent-model")).toEqual(["settings"]);
    expect(policyRequestActions("POST", "/omnirush/subagent-model/resolve")).toEqual([]);
    expect(policyRequestActions("GET", "/omnirush/subagent-model")).toEqual([]);
  });
});
