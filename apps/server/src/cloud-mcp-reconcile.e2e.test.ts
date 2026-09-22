import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OMNIRUSH_CLOUD_EXPECTED_TOOLS, OMNIRUSH_CLOUD_PLUGIN_CANARIES, clearOmniRushCloudMcpProbeFlights, cloudMcpDeliveryState } from "./cloud-mcp-health.js";
import {
  CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
  CONNECT_MCP_SERVER_INDEX_URI,
  readOmniRushConnectMcpAppHostCatalog,
  type OmniRushConnectMcpServerIndexInput,
} from "./connect-mcp-server-catalog.js";
import { readGlobalRuntimeOpencodeConfig, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { inspectEngineMcpRegistration, registerTrustedOpencodeProcess, startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type EngineRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
};

type MockOpencodeOptions = {
  toolIds?: string[];
  providerToolIds?: string[];
  cloudToolNames?: string[];
  cloudToolsAsSse?: boolean;
  providerToolCalling?: boolean;
  providerModelExists?: boolean;
  unsupportedToolIds?: boolean;
  initialConnected?: boolean;
  connectAfterStatusReads?: number;
  hangHealth?: boolean;
  delayMcpStatusMs?: number;
  postFailure?: { status: number; body: unknown };
  cloudFailedError?: string;
  connectServers?: OmniRushConnectMcpServerIndexInput["servers"];
  appHostAuthorization?: string;
};

type CloudConfig = {
  type: "remote";
  url: string;
  enabled: true;
  headers: { Authorization: string };
  oauth: false;
};

const CLIENT_TOKEN = "owt_cloud_mcp_client";
const HOST_TOKEN = "owt_cloud_mcp_host";
const APP_HOST_AUTHORIZATION = "Bearer owt_secret_app_host_token";
const previousRuntimeDb = process.env.OMNIRUSH_RUNTIME_DB;
const previousDevMode = process.env.OMNIRUSH_DEV_MODE;
const previousBootstrapPath = process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH;
/** Administrator-activated enterprise Den origin: trusted for collaborator reconciles. */
const DEN = "https://den.example.com";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const runtimeDbRoots: string[] = [];
const cloudConfigsByOmniRushBase = new Map<string, CloudConfig>();

afterEach(async () => {
  cloudMcpDeliveryState.clear();
  clearOmniRushCloudMcpProbeFlights();
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (process.platform === "win32") {
    // Bun keeps runtime-opencode-config-store SQLite handles open for the process lifetime on Windows.
    // Skip only those DB temp dirs; workspace roots and mock servers are still cleaned every test.
    runtimeDbRoots.length = 0;
  } else {
    while (runtimeDbRoots.length) await rm(runtimeDbRoots.pop() ?? "", { recursive: true, force: true });
  }
  cloudConfigsByOmniRushBase.clear();
  if (previousRuntimeDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
  else process.env.OMNIRUSH_RUNTIME_DB = previousRuntimeDb;
  if (previousDevMode === undefined) delete process.env.OMNIRUSH_DEV_MODE;
  else process.env.OMNIRUSH_DEV_MODE = previousDevMode;
  if (previousBootstrapPath === undefined) delete process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH;
  else process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH = previousBootstrapPath;
});

beforeEach(async () => {
  // Trust decisions read desktop activation state; never read the real one.
  const root = await createRoot("omnirush-cloud-mcp-bootstrap-");
  const path = join(root, "desktop-bootstrap.json");
  await writeFile(path, JSON.stringify({
    baseUrl: DEN,
    enterpriseActivation: { activatedAt: "2026-09-22T00:00:00.000Z", denBaseUrl: DEN },
  }), "utf8");
  process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH = path;
});

async function createRoot(prefix = "omnirush-cloud-mcp-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createRuntimeDbRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-cloud-mcp-runtime-"));
  runtimeDbRoots.push(root);
  return root;
}

function allReadyToolIds(): string[] {
  return [...OMNIRUSH_CLOUD_EXPECTED_TOOLS, ...OMNIRUSH_CLOUD_PLUGIN_CANARIES];
}

function startMockOpencode(options: MockOpencodeOptions = {}) {
  const requests: EngineRequest[] = [];
  let registerCount = 0;
  let statusReads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/global/health") {
        if (options.hangHealth) return await new Promise<Response>(() => {});
        return Response.json({ healthy: true, version: "1.17.11" });
      }
      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (url.pathname === "/session/status") return Response.json({});
      if (url.pathname === "/mcp" && request.method === "POST") {
        if (options.postFailure) return Response.json(options.postFailure.body, { status: options.postFailure.status });
        registerCount += 1;
        return Response.json({});
      }
      if (url.pathname.startsWith("/mcp/") && url.pathname.endsWith("/disconnect") && request.method === "POST") {
        // OpenCode closes the client and keeps the config; status is no longer
        // connected until a later POST /mcp re-registers it.
        if (url.pathname === "/mcp/omnirush-cloud/disconnect") registerCount = 0;
        return Response.json(true);
      }
      if (url.pathname === "/mcp" && request.method === "GET") {
        statusReads += 1;
        if (options.delayMcpStatusMs) await new Promise((resolve) => setTimeout(resolve, options.delayMcpStatusMs));
        if (options.cloudFailedError) {
          return Response.json({ "omnirush-cloud": { status: "failed", error: options.cloudFailedError } });
        }
        if (options.connectAfterStatusReads && statusReads < options.connectAfterStatusReads) {
          return Response.json({ "omnirush-cloud": { status: "failed", error: "slow connect" } });
        }
        return Response.json(registerCount > 0 || options.initialConnected ? { "omnirush-cloud": { status: "connected" } } : {});
      }
      if (url.pathname === "/experimental/tool/ids") {
        if (options.unsupportedToolIds) return Response.json({ code: "not_found" }, { status: 404 });
        return Response.json(options.toolIds ?? allReadyToolIds());
      }
      if (url.pathname === "/experimental/tool") {
        const ids = options.providerToolIds ?? options.toolIds ?? allReadyToolIds();
        return Response.json(ids.map((id) => ({ id, description: id, parameters: {} })));
      }
      if (url.pathname === "/provider") {
        const toolcall = options.providerToolCalling ?? true;
        const models = options.providerModelExists === false
          ? {}
          : {
              "claude-sonnet-4": { id: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet", capabilities: { toolcall } },
              claude: { id: "claude", providerID: "anthropic", name: "Claude", capabilities: { toolcall } },
              "gpt-5": { id: "gpt-5", providerID: "omnirush", name: "GPT-5", capabilities: { toolcall } },
            };
        return Response.json({
          all: [
            { id: "anthropic", name: "Anthropic", source: "config", env: [], options: {}, models },
            { id: "omnirush", name: "OmniRush.ai", source: "config", env: [], options: {}, models },
          ],
          default: {},
          connected: ["anthropic", "omnirush"],
        });
      }
      if (url.pathname.endsWith("/mcp/agent") && request.method === "POST") {
        const authorization = request.headers.get("authorization");
        if (authorization !== "Bearer owt_secret_cloud_token" && authorization !== options.appHostAuthorization) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const rpc = isRecord(body) ? body : {};
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        const id = rpc.id ?? 1;
        const result = rpc.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "omnirush-cloud-test", version: "1.0.0" },
            }
          : rpc.method === "tools/list"
            ? { tools: (options.cloudToolNames ?? ["search_capabilities", "execute_capability"]).map((name) => ({ name, description: name, inputSchema: {} })) }
            : rpc.method === "resources/read" && isRecord(rpc.params) && rpc.params.uri === CONNECT_MCP_SERVER_INDEX_URI
              ? {
                  contents: [{
                    uri: CONNECT_MCP_SERVER_INDEX_URI,
                    mimeType: "application/json",
                    text: JSON.stringify({
                      schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
                      servers: options.connectServers ?? [],
                    }),
                  }],
                }
            : {};
        const payload = { jsonrpc: "2.0", id, result };
        if (options.cloudToolsAsSse && rpc.method === "tools/list") {
          return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json(payload, {
          headers: rpc.method === "initialize"
            ? { "mcp-session-id": "session_12345678901234567890", "mcp-protocol-version": "2025-06-18" }
            : {},
        });
      }
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { server, requests };
}

function workspace(id: string, path: string, baseUrl: string, extra?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id,
    name: id,
    path,
    preset: "starter",
    workspaceType: "local",
    baseUrl,
    ...extra,
  };
}

async function startOmniRush(workspaces: WorkspaceInfo[]): Promise<{ base: string; config: ServerConfig }> {
  const runtimeRoot = await createRuntimeDbRoot();
  process.env.OMNIRUSH_RUNTIME_DB = join(runtimeRoot, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(runtimeRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((item) => item.path),
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  cloudConfigsByOmniRushBase.set(base, cloudConfig(cloudUrlFromBase(workspaces[0]?.baseUrl)));
  return { base, config };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${CLIENT_TOKEN}`, "Content-Type": "application/json" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} was not an object`);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`${label} was not an array`);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  return requireRecord(await response.json(), "response");
}

function expectDirectoryQuery(search: string | undefined, directory: string): void {
  if (search === undefined) throw new Error("request search was missing");
  expect(new URLSearchParams(search).getAll("directory")).toEqual([directory]);
}

function firstFailure(body: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(body.firstFailure, "firstFailure");
}

function delivery(body: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(body.delivery, "delivery");
}

const CLOUD_CONFIG: CloudConfig = {
  type: "remote",
  url: `${DEN}/mcp/agent`,
  enabled: true,
  headers: { Authorization: "Bearer owt_secret_cloud_token" },
  oauth: false,
};

function cloudConfig(url: string): CloudConfig {
  return { ...CLOUD_CONFIG, url };
}

function cloudUrlFromBase(baseUrl: string | undefined): string {
  if (!baseUrl) return CLOUD_CONFIG.url;
  return new URL("/mcp/agent", baseUrl).toString();
}

function cloudConfigForOmniRush(base: string): CloudConfig {
  return cloudConfigsByOmniRushBase.get(base) ?? CLOUD_CONFIG;
}

async function reconcile(base: string, workspaceId = "ws_1", body: Record<string, unknown> = {}): Promise<Response> {
  const config = body.config ?? cloudConfigsByOmniRushBase.get(base) ?? CLOUD_CONFIG;
  return fetch(`${base}/workspace/${workspaceId}/mcp/omnirush-cloud/reconcile`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ config, ...body }),
  });
}

async function getHealth(base: string, workspaceId = "ws_1", query = ""): Promise<Response> {
  return fetch(`${base}/workspace/${workspaceId}/mcp/omnirush-cloud/health${query}`, { headers: headers() });
}

describe("omnirush-cloud MCP strict reconcile", () => {
  test("clean ready persists desired config, verifies tools, and redacts the token", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const response = await reconcile(omnirush.base, "ws_1", {
      tokenMetadata: { expiresAt: "2026-07-13T00:00:00.000Z" },
      org: { id: "org_1", name: "Acme" },
      provider: "anthropic",
      model: "claude-sonnet-4",
      trigger: "test",
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("owt_secret_cloud_token");
    expect(text).not.toContain("Bearer owt_secret_cloud_token");

    const body = requireRecord(JSON.parse(text), "health");
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(body.usableByCurrentModel).toBe(true);
    const tools = requireRecord(body.tools, "tools");
    expect(requireArray(tools.present, "tools.present").sort()).toEqual([...OMNIRUSH_CLOUD_EXPECTED_TOOLS].sort());
    expect(requireRecord(tools.direct, "tools.direct")).toMatchObject({
      checked: true,
      present: ["search_capabilities", "execute_capability"],
      missing: [],
    });
    expect(requireRecord(tools.providerProjection, "providerProjection")).toMatchObject({
      source: "experimental_tool",
      missing: [],
    });
    expect(delivery(body).appliedRevision).toBe(delivery(body).desiredRevision);
    expect(requireRecord(body.workspace, "workspace").directory).toBe(root);
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").opencode, "opencode").actualVersion).toBe("1.17.11");
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").opencode, "opencode").expectedVersion).toBeTruthy();
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalToolIds, "experimentalToolIds")).toMatchObject({ includesMcpTools: true });
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalProviderTools, "experimentalProviderTools")).toMatchObject({ includesMcpTools: true });
    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]?.url).toBe(cloudConfigForOmniRush(omnirush.base).url);
    expect((await readRuntimeOpencodeConfig(omnirush.config, "ws_1")).mcp?.["omnirush-cloud"]).toBeUndefined();

    const mcpPosts = mock.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp");
    expect(mcpPosts.length).toBe(1);
    expectDirectoryQuery(mcpPosts[0]?.search, root);
    const directProbeMethods = mock.requests
      .filter((request) => request.pathname.endsWith("/mcp/agent") && isRecord(request.body) && typeof request.body.method === "string")
      .map((request) => isRecord(request.body) && typeof request.body.method === "string" ? request.body.method : "unknown");
    expect(directProbeMethods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    console.info(`cloud-mcp-reconcile-operation-benchmark pre=6 post=${directProbeMethods.length}`);
  });

  test("keeps provider descriptors private while purging stale runtime endpoints", async () => {
    process.env.OMNIRUSH_DEV_MODE = "1";
    const root = await createRoot();
    const connectionId = "emc_01privateapphostcatalog";
    const mockOptions: MockOpencodeOptions = {
      appHostAuthorization: APP_HOST_AUTHORIZATION,
    };
    const mock = startMockOpencode(mockOptions);
    mockOptions.connectServers = [{
      connectionId,
      name: "Private fixture provider",
      description: "Native MCP App fixture",
      url: `http://127.0.0.1:${mock.server.port}/mcp/agent/connections/emc_01privateapphostcatalog`,
    }];
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(omnirush.config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "omnirush-connect-stale": { type: "remote", url: "https://cloud.example/stale" },
      },
    }));

    const response = await reconcile(omnirush.base, "ws_1", {
      appHostAuthorization: APP_HOST_AUTHORIZATION,
    });
    expect((await responseRecord(response)).phase).toBe("ready");

    const runtime = await readRuntimeOpencodeConfig(omnirush.config, "ws_1");
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(runtime.mcp?.["omnirush-cloud"]).toBeUndefined();
    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]).toBeTruthy();
    expect(Object.keys(runtime.mcp ?? {}).filter((name) => name.startsWith("omnirush-connect-"))).toEqual([]);
    expect((await readOmniRushConnectMcpAppHostCatalog(omnirush.config, "ws_1")).servers).toEqual([
      expect.objectContaining({ connectionId, name: "Private fixture provider" }),
    ]);

    const registrations = mock.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp");
    expect(registrations.map((request) => requireRecord(request.body, "registration").name)).toEqual(["omnirush-cloud"]);
    expect(mock.requests.some((request) => request.pathname === "/mcp/omnirush-connect-stale/disconnect")).toBe(true);
  });

  test("live status read heals a failed registration record after reconcile returns early", async () => {
    const root = await createRoot();
    // Registration now probes liveness before POSTing; keep the first
    // post-registration health read failed, then heal on the next read.
    const mock = startMockOpencode({ connectAfterStatusReads: 3 });
    const baseUrl = `http://127.0.0.1:${mock.server.port}`;
    const omnirush = await startOmniRush([workspace("ws_1", root, baseUrl)]);
    registerTrustedOpencodeProcess(omnirush.config, {
      baseUrl,
      identity: "cloud-reconcile-live-heal",
      isAlive: () => true,
    });

    const response = await reconcile(omnirush.base);
    const body = await responseRecord(response);
    expect(response.status).toBe(200);
    expect(firstFailure(body).code).toBe("opencode_mcp_sync_failed");
    expect(inspectEngineMcpRegistration(
      omnirush.config,
      omnirush.config.workspaces[0]!,
      "omnirush-cloud",
      cloudConfigForOmniRush(omnirush.base),
    )).toBe("connected");

    const health = await responseRecord(await getHealth(omnirush.base));
    expect(health.phase).toBe("ready");
    expect(health.usable).toBe(true);
    expect(mock.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp").length).toBe(1);
  });

  test("rejects malformed desired config without persisting or registering it", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const cases: Array<{ config: Record<string, unknown>; code: string }> = [
      { config: { ...CLOUD_CONFIG, url: `${DEN}/mcp` }, code: "cloud_endpoint_invalid" },
      { config: { ...CLOUD_CONFIG, enabled: false }, code: "cloud_mcp_disabled" },
      { config: { ...CLOUD_CONFIG, headers: {} }, code: "invalid_mcp_token" },
      { config: { ...CLOUD_CONFIG, oauth: {} }, code: "invalid_mcp_token" },
    ];

    for (const item of cases) {
      const body = await responseRecord(await reconcile(omnirush.base, "ws_1", { config: item.config }));
      expect(firstFailure(body).code).toBe(item.code);
      expect(firstFailure(body).stage).toBe("desired_config");
    }

    const mismatch = await responseRecord(await reconcile(omnirush.base, "ws_1", {
      tokenMetadata: { organizationId: "org_token" },
      org: { id: "org_active" },
    }));
    expect(firstFailure(mismatch).code).toBe("cloud_token_org_mismatch");
    expect(firstFailure(mismatch).stage).toBe("desired_config");

    expect((await readRuntimeOpencodeConfig(omnirush.config, "ws_1")).mcp?.["omnirush-cloud"]).toBeUndefined();
    expect(mock.requests.some((request) => request.method === "POST" && request.pathname === "/mcp")).toBe(false);
  });

  test("a collaborator token cannot globally persist an untrusted Cloud MCP endpoint", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    // The primary client token is collaborator-scoped. The desired config is
    // account-global, so persisting a non-built-in, non-enterprise, non-loopback
    // endpoint must require the owner: a collaborator on one shared workspace
    // must not be able to redirect Connect for every workspace on this server.
    const response = await reconcile(omnirush.base, "ws_1", {
      config: { ...CLOUD_CONFIG, url: "https://evil.example/mcp/agent" },
    });
    expect(response.status).toBe(403);

    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]).toBeUndefined();
    expect((await readRuntimeOpencodeConfig(omnirush.config, "ws_1")).mcp?.["omnirush-cloud"]).toBeUndefined();
    expect(mock.requests.some((request) => request.method === "POST" && request.pathname === "/mcp")).toBe(false);
  });

  test("a collaborator token cannot globally persist a retired hosted Cloud MCP endpoint", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    // These hosted origins were built-in trusted before the hosted Den was
    // retired; they are not ours any more and need the owner like any other.
    for (const url of [
      "https://api.omnirushlabs.com/mcp/agent",
      "https://api.app.omnirushlabs.com/mcp/agent",
      "https://app.omnirushlabs.com/api/den/mcp/agent",
      "https://api.omnirush.software/mcp/agent",
      "https://app.omnirush.software/api/den/mcp/agent",
    ]) {
      const response = await reconcile(omnirush.base, "ws_1", { config: { ...CLOUD_CONFIG, url } });
      expect(response.status).toBe(403);
    }

    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]).toBeUndefined();
    expect((await readRuntimeOpencodeConfig(omnirush.config, "ws_1")).mcp?.["omnirush-cloud"]).toBeUndefined();
    expect(mock.requests.some((request) => request.method === "POST" && request.pathname === "/mcp")).toBe(false);
  });

  test("normalizes a harmless trailing slash on the Cloud MCP endpoint", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    const url = `http://127.0.0.1:${mock.server.port}/api/den/mcp/agent/`;

    const body = await responseRecord(await reconcile(omnirush.base, "ws_1", {
      config: { ...CLOUD_CONFIG, url },
    }));
    expect(body.phase).toBe("ready");
    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]?.url).toBe(url.slice(0, -1));
  });

  test("GET health reports persisted malformed desired config even when the engine looks live", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(omnirush.config, "ws_1", (current) => ({
      ...current,
      mcp: { "omnirush-cloud": { ...CLOUD_CONFIG, url: `${DEN}/mcp` } },
    }));

    const body = await responseRecord(await getHealth(omnirush.base));
    expect(body.usable).toBe(false);
    expect(firstFailure(body).code).toBe("cloud_endpoint_invalid");
    expect(firstFailure(body).stage).toBe("desired_config");
  });

  test("GET health safely adopts a live exact match before reporting ready", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(omnirush.config, "ws_1", (current) => ({
      ...current,
      mcp: { "omnirush-cloud": cloudConfigForOmniRush(omnirush.base) },
    }));

    const body = await responseRecord(await getHealth(omnirush.base));
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(delivery(body).appliedRevision).toBe(delivery(body).desiredRevision);
  });

  test("GET health runs the direct Cloud endpoint probe only when requested", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(omnirush.config, "ws_1", (current) => ({
      ...current,
      mcp: { "omnirush-cloud": cloudConfigForOmniRush(omnirush.base) },
    }));

    const defaultBody = await responseRecord(await getHealth(omnirush.base));
    expect(defaultBody.phase).toBe("ready");
    expect(mock.requests.filter((request) => request.pathname.endsWith("/mcp/agent")).length).toBe(0);

    const probedBody = await responseRecord(await getHealth(omnirush.base, "ws_1", "?probe=1"));
    expect(probedBody.phase).toBe("ready");
    expect(mock.requests.filter((request) => request.pathname.endsWith("/mcp/agent")).length).toBeGreaterThan(0);
  });

  test("health probe timeout is bounded", async () => {
    const previousTimeout = process.env.OMNIRUSH_CLOUD_MCP_PROBE_TIMEOUT_MS;
    process.env.OMNIRUSH_CLOUD_MCP_PROBE_TIMEOUT_MS = "25";
    try {
      const root = await createRoot();
      const mock = startMockOpencode({ initialConnected: true, delayMcpStatusMs: 100 });
      const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
      await writeRuntimeOpencodeConfig(omnirush.config, "ws_1", (current) => ({
        ...current,
        mcp: { "omnirush-cloud": cloudConfigForOmniRush(omnirush.base) },
      }));

      const body = await responseRecord(await getHealth(omnirush.base));
      expect(body.usable).toBe(false);
      expect(firstFailure(body).code).toBe("opencode_engine_unreachable");
    } finally {
      if (previousTimeout === undefined) delete process.env.OMNIRUSH_CLOUD_MCP_PROBE_TIMEOUT_MS;
      else process.env.OMNIRUSH_CLOUD_MCP_PROBE_TIMEOUT_MS = previousTimeout;
    }
  });

  test("unreachable engine leaves desired config persisted but not applied", async () => {
    const root = await createRoot();
    const omnirush = await startOmniRush([workspace("ws_1", root, "http://127.0.0.1:9")]);

    const response = await reconcile(omnirush.base);
    const body = await responseRecord(response);
    expect(response.status).toBe(200);
    expect(firstFailure(body).code).toBe("opencode_mcp_sync_failed");
    expect(delivery(body).appliedRevision).toBeNull();
    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]?.url).toBe(cloudConfigForOmniRush(omnirush.base).url);
  });

  test("uses the exact secondary workspace directory", async () => {
    const rootA = await createRoot("omnirush-cloud-primary-");
    const rootB = await createRoot("omnirush-cloud-secondary-");
    const mock = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${mock.server.port}`;
    const omnirush = await startOmniRush([
      workspace("ws_1", rootA, baseUrl),
      workspace("ws_2", rootB, baseUrl),
    ]);

    const response = await reconcile(omnirush.base, "ws_2");
    const body = await responseRecord(response);
    expect(body.phase).toBe("ready");
    const post = mock.requests.find((request) => request.method === "POST"
      && request.pathname === "/mcp"
      && new URLSearchParams(request.search).get("directory") === rootB);
    expectDirectoryQuery(post?.search, rootB);
    expect(mock.requests.some((request) => request.method === "POST"
      && request.pathname === "/mcp"
      && new URLSearchParams(request.search).get("directory") === rootA)).toBe(true);
  });

  test("removes global desired state and disconnects every workspace directory", async () => {
    const rootA = await createRoot("omnirush-cloud-remove-a-");
    const rootB = await createRoot("omnirush-cloud-remove-b-");
    const mock = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${mock.server.port}`;
    const omnirush = await startOmniRush([
      workspace("ws_1", rootA, baseUrl),
      workspace("ws_2", rootB, baseUrl),
    ]);
    expect((await responseRecord(await reconcile(omnirush.base))).phase).toBe("ready");
    const disconnectsBeforeRemoval = mock.requests
      .filter((request) => request.pathname === "/mcp/omnirush-cloud/disconnect").length;

    const removed = await fetch(`${omnirush.base}/workspace/ws_1/mcp/omnirush-cloud`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(removed.status).toBe(200);
    expect((await readGlobalRuntimeOpencodeConfig(omnirush.config)).mcp?.["omnirush-cloud"]).toBeUndefined();
    const disconnectDirectories = mock.requests
      .filter((request) => request.pathname === "/mcp/omnirush-cloud/disconnect")
      .slice(disconnectsBeforeRemoval)
      .map((request) => new URLSearchParams(request.search).get("directory"))
      .sort();
    expect(disconnectDirectories).toEqual([rootA, rootB].sort());
  });

  test("uses an explicit remote workspace directory and refuses ambiguous remotes", async () => {
    const root = await createRoot();
    const explicitDirectory = join(root, "remote-project");
    const mock = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${mock.server.port}`;
    const omnirush = await startOmniRush([
      workspace("ws_remote", root, baseUrl, { workspaceType: "remote", directory: explicitDirectory }),
      workspace("ws_ambiguous", root, baseUrl, { workspaceType: "remote" }),
    ]);

    const ready = await reconcile(omnirush.base, "ws_remote");
    expect((await responseRecord(ready)).phase).toBe("ready");
    expectDirectoryQuery(mock.requests.find((request) => request.method === "POST"
      && request.pathname === "/mcp"
      && new URLSearchParams(request.search).get("directory") === explicitDirectory)?.search, explicitDirectory);

    const catalogReadsBeforeAmbiguous = mock.requests.filter((request) => (
      isRecord(request.body) && request.body.method === "resources/read"
    )).length;
    const ambiguous = await reconcile(omnirush.base, "ws_ambiguous");
    const body = await responseRecord(ambiguous);
    expect(firstFailure(body).code).toBe("workspace_directory_ambiguous");
    expect(delivery(body).appliedRevision).toBeNull();
    expect(mock.requests.filter((request) => (
      isRecord(request.body) && request.body.method === "resources/read"
    )).length).toBe(catalogReadsBeforeAmbiguous);
  });

  test("connected engine with direct Cloud endpoint missing a tool reports cloud_tools_missing without re-registering", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ cloudToolNames: ["search_capabilities"] });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base));
    expect(firstFailure(body).code).toBe("cloud_tools_missing");
    expect(requireRecord(requireRecord(body.tools, "tools").direct, "direct").missing).toEqual(["execute_capability"]);
    expect(requireArray(requireRecord(body.tools, "tools").present, "tools.present")).toEqual([]);
    expect(mock.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp").length).toBe(1);
  });

  test("current OpenCode engines that exclude MCP tool IDs use direct tools/list plus provider capability", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({
      toolIds: [...OMNIRUSH_CLOUD_PLUGIN_CANARIES],
      providerToolIds: [...OMNIRUSH_CLOUD_PLUGIN_CANARIES],
      cloudToolsAsSse: true,
    });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base, "ws_1", { provider: "anthropic", model: "claude" }));
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(body.usableByCurrentModel).toBe(true);
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalToolIds, "experimentalToolIds")).toMatchObject({ includesMcpTools: false });
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalProviderTools, "experimentalProviderTools")).toMatchObject({ includesMcpTools: false });
    expect(requireRecord(requireRecord(body.tools, "tools").providerProjection, "projection")).toMatchObject({
      source: "provider_capability",
      modelExists: true,
      toolCalling: true,
      missing: [...OMNIRUSH_CLOUD_EXPECTED_TOOLS],
    });
    expect(requireArray(requireRecord(body.tools, "tools").present, "tools.present").sort()).toEqual([...OMNIRUSH_CLOUD_EXPECTED_TOOLS].sort());
  });

  test("reports provider projection missing when fallback provider model lacks tool calling", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({
      toolIds: [...OMNIRUSH_CLOUD_PLUGIN_CANARIES],
      providerToolIds: [...OMNIRUSH_CLOUD_PLUGIN_CANARIES],
      providerToolCalling: false,
    });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base, "ws_1", { provider: "anthropic", model: "claude" }));
    expect(firstFailure(body).code).toBe("provider_tool_projection_missing");
    expect(firstFailure(body).recommendedAction).toBe("Choose a model that can use OmniRush.ai Cloud tools");
    expect(requireRecord(requireRecord(body.tools, "tools").providerProjection, "projection")).toMatchObject({
      source: "provider_capability",
      modelExists: true,
      toolCalling: false,
      missing: [...OMNIRUSH_CLOUD_EXPECTED_TOOLS],
    });
  });

  test("falls back to provider capability when global MCP tool IDs exist but per-model experimental projection omits them", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({
      // Global IDs include Cloud MCP tools…
      toolIds: allReadyToolIds(),
      // …but the per-model experimental list does not (OpenCode ToolRegistry quirk).
      providerToolIds: [...OMNIRUSH_CLOUD_PLUGIN_CANARIES],
      providerToolCalling: true,
      cloudToolsAsSse: true,
    });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base, "ws_1", { provider: "anthropic", model: "claude" }));
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(body.usableByCurrentModel).toBe(true);
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalToolIds, "experimentalToolIds")).toMatchObject({
      includesMcpTools: true,
    });
    expect(requireRecord(requireRecord(body.tools, "tools").providerProjection, "projection")).toMatchObject({
      source: "provider_capability",
      modelExists: true,
      toolCalling: true,
    });
  });

  test("reports extension canary missing when docs canary is present but extension canary is absent", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ toolIds: [...OMNIRUSH_CLOUD_EXPECTED_TOOLS, "omnirush_docs_search"] });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base));
    expect(firstFailure(body).code).toBe("extensions_plugin_missing");
    expect(requireArray(requireRecord(body.pluginCanaries, "pluginCanaries").missing, "missing")).toContain("omnirush_query");
  });

  test("old engines without tool.ids return Update OmniRush.ai guidance", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ unsupportedToolIds: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base));
    expect(firstFailure(body).code).toBe("opencode_tool_ids_unsupported");
    expect(firstFailure(body).recommendedAction).toBe("Update OmniRush.ai");
  });

  test("health detects project tool denies while generic MCP add remains best-effort", async () => {
    const root = await createRoot();
    await writeFile(join(root, "opencode.jsonc"), JSON.stringify({ tools: { deny: ["omnirush-cloud_*"] } }), "utf8");
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const strictBody = await responseRecord(await reconcile(omnirush.base));
    expect(firstFailure(strictBody).code).toBe("cloud_tools_denied");
    expect(requireArray(strictBody.toolDenies, "toolDenies").length).toBeGreaterThan(0);

    const generic = await fetch(`${omnirush.base}/workspace/ws_1/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "posthog", config: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } }),
    });
    expect(generic.status).toBe(200);
    const genericBody = await responseRecord(generic);
    expect(requireArray(genericBody.items, "items").some((item) => isRecord(item) && item.name === "posthog")).toBe(true);
  });
});

async function engineRefresh(base: string, workspaceId = "ws_1", body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/workspace/${workspaceId}/mcp/omnirush-cloud/engine-refresh`, {
    method: "POST",
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("omnirush-cloud MCP engine refresh", () => {
  test("disconnects the engine client, re-registers, and returns ordered refresh steps with probed health", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const seeded = await reconcile(omnirush.base, "ws_1", { trigger: "seed" });
    expect(seeded.status).toBe(200);
    const registersBeforeRefresh = mock.requests.filter((request) => request.pathname === "/mcp" && request.method === "POST").length;

    const response = await engineRefresh(omnirush.base, "ws_1", { trigger: "support-call" });
    expect(response.status).toBe(200);
    const body = await responseRecord(response);

    const refresh = requireRecord(body.refresh, "refresh");
    expect(refresh.performed).toBe(true);
    expect(refresh.trigger).toBe("support-call");
    const steps = requireArray(refresh.steps, "refresh.steps").map((step) => requireRecord(step, "step"));
    expect(steps.map((step) => step.step)).toEqual(["engine_disconnect", "reapply"]);
    expect(steps.every((step) => step.ok === true)).toBe(true);
    expect(steps.every((step) => typeof step.latencyMs === "number")).toBe(true);

    const health = requireRecord(body.health, "health");
    expect(health.phase).toBe("ready");
    expect(health.usable).toBe(true);
    expect(delivery(health).state).toBe("ready");

    const disconnects = mock.requests.filter((request) => request.pathname === "/mcp/omnirush-cloud/disconnect");
    expect(disconnects).toHaveLength(1);
    expectDirectoryQuery(disconnects[0]?.search, root);
    const registersAfterRefresh = mock.requests.filter((request) => request.pathname === "/mcp" && request.method === "POST").length;
    expect(registersAfterRefresh).toBeGreaterThan(registersBeforeRefresh);
  });

  test("reports desired_missing without touching the engine when no config is persisted", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const response = await engineRefresh(omnirush.base);
    expect(response.status).toBe(200);
    const body = await responseRecord(response);

    const refresh = requireRecord(body.refresh, "refresh");
    expect(refresh.performed).toBe(false);
    expect(refresh.reason).toBe("desired_missing");
    expect(requireArray(refresh.steps, "refresh.steps")).toHaveLength(0);
    expect(requireRecord(body.health, "health").usable).toBe(false);
    expect(mock.requests.filter((request) => request.pathname === "/mcp/omnirush-cloud/disconnect")).toHaveLength(0);
  });

  test("rejects malformed JSON on engine refresh instead of silently ignoring it", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const response = await fetch(`${omnirush.base}/workspace/ws_1/mcp/omnirush-cloud/engine-refresh`, {
      method: "POST",
      headers: headers(),
      body: "not-json",
    });
    expect(response.status).toBe(400);
    expect((await responseRecord(response)).code).toBe("invalid_json");
    expect(mock.requests.filter((request) => request.pathname === "/mcp/omnirush-cloud/disconnect")).toHaveLength(0);
  });

  test("richer engine cert/TLS error strings stay classified as connection failures, not token problems", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({
      cloudFailedError: "fetch failed; caused by: certificate has expired (CERT_HAS_EXPIRED)",
    });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base));
    const failure = firstFailure(body);
    // A transport/cert failure must never be classified as an expired token:
    // "Reconnect OmniRush.ai Cloud" cannot repair a broken TLS path.
    expect(failure.code).toBe("opencode_mcp_sync_failed");
    expect(failure.recommendedAction).toBe("Retry reconcile or reconnect OmniRush.ai Cloud");
  });

  test("token-expired engine errors keep their token classification", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ cloudFailedError: "omnirush-cloud bearer token expired" });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(omnirush.base));
    expect(firstFailure(body).code).toBe("invalid_mcp_token");
  });

  test("keeps step-level failure detail when the engine goes down between seed and refresh", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const omnirush = await startOmniRush([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const seeded = await reconcile(omnirush.base, "ws_1", { trigger: "seed" });
    expect(seeded.status).toBe(200);
    mock.server.stop(true);

    const response = await engineRefresh(omnirush.base, "ws_1", { trigger: "engine-down" });
    expect(response.status).toBe(200);
    const body = await responseRecord(response);

    const refresh = requireRecord(body.refresh, "refresh");
    expect(refresh.performed).toBe(true);
    const steps = requireArray(refresh.steps, "refresh.steps").map((step) => requireRecord(step, "step"));
    expect(steps.map((step) => step.step)).toEqual(["engine_disconnect", "reapply"]);
    expect(steps.every((step) => step.ok === false)).toBe(true);

    const health = requireRecord(body.health, "health");
    expect(health.usable).toBe(false);
    expect(typeof firstFailure(health).code).toBe("string");
  });
});
