import { executionRules } from "./managed-policy-rules.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createManagedOpencodeV2Server,
  type ManagedOpencodeV2Server,
  type OpencodeV2ProviderSpec,
} from "./managed-opencode-v2.js";
import { resolveOpencodeModelsEnv } from "./opencode-models-url.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  isEngineGlobalRuntimeConfigId,
  onRuntimeOpencodeConfigWrite,
  readGlobalRuntimeOpencodeConfig,
  runtimeProviderMap,
} from "./runtime-opencode-config-store.js";
import type { EnvService } from "./env-file.js";
import { selectPrimaryCredentialEnvName } from "./managed-provider-auth.js";
import { isReleaseBuild } from "./release-guard.js";
import { webSearchSetting, webSearchToolOff } from "./web-search.js";
import { buildOmniRushRuntimeConfigObject, omnirushTitleModel } from "./omnirush-runtime-config.js";
import { OMNIRUSH_PROVIDER_ID } from "./provider-lock/provider-lock.mjs";
import { CLOUD_MCP_NAME, cloudMcpEntry, desiredV2Mcp, v2McpGate } from "./engine-v2-mcp.js";
import { runtimeMcpMap } from "./runtime-opencode-config-store.js";
import { engineDataDir } from "./engine-data-home.js";
import { computerUseEngineEnv } from "./computer-use/desktop.js";
import { engineV2Root, importMissingV1Chats, readMigratedSessions, seedV2StoreFromV1 } from "./engine-v2-migration.js";
import type { ServerConfig } from "./types.js";
import { boxServiceFor } from "./box/desktop.js";
import { omnirushBoxNextPluginPath } from "./omnirush-extensions-plugin-path.js";
import { stockMode, stockProviders } from "./stock-mode/stock-mode.mjs";

const PREVIEW_STATE_FILE = "engine-v2-preview.json";
const UNSET_API_KEY = "omnirush-engine-v2-preview-unset";
/** The local gateway broker's key for the engine (the 1.x engine reads the same variable). */
const ENGINE_TOKEN_ENV = "OMNIRUSH_ACCESS_TOKEN";
/** opencode-plugins/omnirush-session-next.ts's id (server modules never import plugin files). */
export const OMNIRUSH_SESSION_PLUGIN_ID = "omnirush.session";
/** How long a prompt waits for a project's MCP servers to connect. */
const MCP_READY_TIMEOUT_MS = 15_000;
// A cold sidecar can return HTTP 503 while its model catalog initializes for 17–20 seconds.
const CATALOG_MIRROR_TIMEOUT_MS = 60_000;

export interface EngineV2PreviewStatus {
  enabled: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  binSource?: "env";
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
}

export interface RuntimeProviderRecordLike {
  name?: string;
  npm?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
  };
  models?: Record<string, unknown>;
}

export interface EngineV2Preview {
  start(): void;
  status(): EngineV2PreviewStatus;
  setEnabled(enabled: boolean): Promise<EngineV2PreviewStatus>;
  setChatRouting(chatRouting: boolean): Promise<EngineV2PreviewStatus>;
  connection(): { url: string; username: string; password: string } | undefined;
  /** The connection once the engine is up, waiting while it starts (at most `timeoutMs`); null when it is not up by then or its start failed. */
  awaitConnection(timeoutMs: number): Promise<{ url: string; username: string; password: string } | null>;
  /** The account's providers and model catalog again (a catalog change); resolves once the engine has them. */
  refreshProviders(): Promise<void>;
  ensureWorkspaceReady(directory: string): Promise<void>;
  syncWorkspaceMcp(workspaceId: string, directory: string): Promise<void>;
  /** Whether a chat came from the 1.x store (engine-v2-migration.ts). */
  migratedFromV1(sessionId: string): boolean;
  stop(): Promise<void>;
}

export interface EngineV2PreviewState {
  enabled: boolean;
  chatRouting?: boolean;
}

/**
 * The 2.x engine runs every new chat: on, with chats routed to it, whatever an
 * earlier preview setting or switch said. `sidecar` leaves chats on the 1.x engine for the
 * server's 1.x test suites; a release build ignores it.
 */
export function resolveInitialEngineV2PreviewState(
  env: NodeJS.ProcessEnv,
  _persisted?: EngineV2PreviewState,
  release = isReleaseBuild(),
): EngineV2PreviewState {
  return { enabled: true, chatRouting: release || env.OMNIRUSH_ENGINE_V2_PREVIEW !== "sidecar" };
}

interface ResolvedBinary {
  bin: string;
  source: "env";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), PREVIEW_STATE_FILE);
}

export function readEngineV2PreviewState(config: ServerConfig): EngineV2PreviewState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(config), "utf8"));
    if (
      !isRecord(parsed)
      || typeof parsed.enabled !== "boolean"
      || (parsed.chatRouting !== undefined && typeof parsed.chatRouting !== "boolean")
    ) {
      return { enabled: false, chatRouting: false };
    }
    return { enabled: parsed.enabled, chatRouting: parsed.chatRouting === true };
  } catch {
    return { enabled: false, chatRouting: false };
  }
}

export async function writeEngineV2PreviewState(
  config: ServerConfig,
  state: EngineV2PreviewState,
): Promise<void> {
  await mkdir(runtimeStorageDir(config), { recursive: true });
  await writeFile(statePath(config), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function resolveBinary(config: ServerConfig): Promise<ResolvedBinary> {
  // Engines the preview downloaded before the 2.x engine shipped inside the app.
  await rm(join(runtimeStorageDir(config), "opencode-v2-verified"), { recursive: true, force: true }).catch(() => undefined);
  // The app's bundled engine (Electron main sets it; a release build checks its hash there and at launch).
  const bin = process.env.OMNIRUSH_OPENCODE2_BIN?.trim();
  if (!bin) throw new Error("The OmniRush engine was not found. Reinstall OmniRush.ai.");
  return { bin, source: "env" };
}

/**
 * The box's engine bits for the 2.x engine: the box shell as is, and the box plugin as its 2.x
 * module (omnirush-box-next.ts; the 1.x hook object it wraps is not loaded by 2.x). Null: no box.
 */
export function v2BoxBits(bits: { shell: string; plugin: string } | null): { shell: string; plugin: string } | null {
  return bits ? { shell: bits.shell, plugin: omnirushBoxNextPluginPath() } : null;
}

export function mapRuntimeProvidersToV2Specs(
  providerMap: Record<string, unknown>,
  storedCredentials: ReadonlyMap<string, string> = new Map(),
): { specs: OpencodeV2ProviderSpec[]; skippedProviderIds: string[] } {
  const specs: OpencodeV2ProviderSpec[] = [];
  const skippedProviderIds: string[] = [];

  for (const [id, value] of Object.entries(providerMap)) {
    if (!isRecord(value)) {
      skippedProviderIds.push(id);
      continue;
    }
    // Only built-in adapters: do not turn organization configuration into a
    // request to install an arbitrary runtime package.
    const packages: Record<string, string> = {
      "@ai-sdk/openai": "@opencode-ai/ai/providers/openai",
      "@ai-sdk/anthropic": "@opencode-ai/ai/providers/anthropic",
      "@openrouter/ai-sdk-provider": "@opencode-ai/ai/providers/openrouter",
      "@ai-sdk/openai-compatible": "@opencode-ai/ai/providers/openai-compatible",
    };
    const options = isRecord(value.options) ? value.options : {};
    // Catalog `api` metadata may use only the native adapter's trusted origin.
    // Custom destinations must use the existing explicit options.baseURL path.
    const explicitBaseUrl = typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL : undefined;
    if (!explicitBaseUrl && value.api !== undefined) {
      const nativeOrigins: Record<string, string> = {
        "@ai-sdk/openai": "https://api.openai.com",
        "@ai-sdk/anthropic": "https://api.anthropic.com",
        "@openrouter/ai-sdk-provider": "https://openrouter.ai",
      };
      let trusted = false;
      try {
        const url = new URL(typeof value.api === "string" ? value.api : "");
        trusted = typeof value.npm === "string" && Object.hasOwn(nativeOrigins, value.npm)
          && url.origin === nativeOrigins[value.npm] && !url.username && !url.password;
      } catch { /* Invalid endpoint metadata is never mirrored. */ }
      if (!trusted) { skippedProviderIds.push(id); continue; }
    }
    const endpoint = explicitBaseUrl ?? value.api;
    const baseUrl = typeof endpoint === "string" && endpoint.trim() ? endpoint : undefined;
    const packageName = typeof value.npm === "string" && Object.hasOwn(packages, value.npm) ? packages[value.npm] : undefined;
    if ((value.npm !== undefined && !packageName)
      || (!baseUrl && (!packageName || value.npm === "@ai-sdk/openai-compatible"))) {
      skippedProviderIds.push(id);
      continue;
    }
    const { apiKey, baseURL, headers, ...settings } = options;
    const envNames = Array.isArray(value.env)
      ? value.env.filter((name): name is string => typeof name === "string") : [];
    const credentialName = selectPrimaryCredentialEnvName(envNames, storedCredentials.keys());
    const storedKey = credentialName ? storedCredentials.get(credentialName) : undefined;
    // Resolve only this provider's declared credential, never inherit the
    // server environment or copy unrelated secrets into the sidecar.
    const explicitKey = typeof apiKey === "string" && apiKey.trim() !== "" && !apiKey.includes("{env:") ? apiKey : undefined;
    const resolvedKey = explicitKey ?? storedKey;
    if (envNames.length > 0 && !resolvedKey) {
      skippedProviderIds.push(id);
      continue;
    }
    const models = isRecord(value.models)
      ? Object.entries(value.models)
        .map(([modelId, model]) => ({
          id: modelId,
          name: isRecord(model) && typeof model.name === "string" ? model.name : modelId,
          ...(isRecord(model) ? { config: model } : {}),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
      : [];
    specs.push({
      id,
      name: typeof value.name === "string" ? value.name : id,
      ...(baseUrl ? { baseUrl } : {}),
      ...(packageName ? { package: packageName } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(isRecord(headers) ? { headers } : {}),
      apiKey: resolvedKey ?? UNSET_API_KEY,
      models,
    });
  }

  specs.sort((left, right) => left.id.localeCompare(right.id));
  skippedProviderIds.sort((left, right) => left.localeCompare(right));
  return { specs, skippedProviderIds };
}

function catalogModelIds(payload: unknown, mirroredProviderIds: string[]): string[] {
  const mirrored = new Set(mirroredProviderIds);
  const ids = new Set<string>();

  function visit(value: unknown, withinMirroredProvider: boolean): void {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, withinMirroredProvider);
      return;
    }
    if (!isRecord(value)) return;

    const providerId = typeof value.providerID === "string"
      ? value.providerID
      : typeof value.providerId === "string"
        ? value.providerId
        : undefined;
    const withinProvider = withinMirroredProvider || (providerId !== undefined && mirrored.has(providerId));
    if (withinProvider && typeof value.id === "string" && !mirrored.has(value.id)) ids.add(value.id);
    if (withinProvider && isRecord(value.models)) {
      for (const modelId of Object.keys(value.models)) ids.add(modelId);
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, withinProvider || mirrored.has(key));
    }
  }

  visit(payload, false);
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Chats bind to the gateway only through the session plugin's headers, and a 2.x plugin that
 * fails to load only warns: no chat starts in a location where it is not active.
 */
export async function assertSessionPluginActive(
  engine: Pick<ManagedOpencodeV2Server, "fetchJson">,
  directory: string,
): Promise<void> {
  const response = await engine.fetchJson("/api/plugin", { directory, timeoutMs: 5_000 });
  const plugins = isRecord(response.json) && Array.isArray(response.json.data) ? response.json.data : [];
  const ours = plugins.find((plugin) => isRecord(plugin) && plugin.id === OMNIRUSH_SESSION_PLUGIN_ID);
  const state = isRecord(ours) ? (isRecord(ours.state) ? ours.state.status ?? ours.state.type : ours.state) : undefined;
  if (response.status !== 200 || !ours || (state !== undefined && !["active", "loaded", "ready"].includes(String(state)))) {
    throw new Error("The OmniRush engine's session plugin is not active; chats cannot start.");
  }
}

/**
 * Waits for `probe.connection()` while the engine starts: re-checked when its start settles and every
 * `pollMs`, `timeoutMs` at most. Null when the time ran out, or no start is under way and the last one failed.
 */
export async function awaitEngineConnection<T>(
  probe: { connection(): T | undefined; starting(): Promise<unknown> | undefined; failed(): boolean },
  timeoutMs: number,
  pollMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = probe.connection();
    if (ready) return ready;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const starting = probe.starting();
    if (!starting && probe.failed()) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ...(starting ? [starting.then(() => undefined, () => undefined)] : []),
      new Promise<void>((resolveTick) => { timer = setTimeout(resolveTick, Math.min(pollMs, left)); }),
    ]);
    clearTimeout(timer);
  }
}

export function createEngineV2Preview(options: {
  config: ServerConfig; env?: Pick<EnvService, "list" | "onChange">; deferStart?: boolean;
  /** The Claude provider's spec (omnirush-runtime-config.ts claudeEngineProvider), null while the account has no Claude catalog. */
  claude?: () => Promise<OpencodeV2ProviderSpec | null>;
}): EngineV2Preview {
  const { config } = options;
  const rootDir = engineV2Root(runtimeStorageDir(config));
  const workspaceDir = join(rootDir, "workspace");
  const initialState = resolveInitialEngineV2PreviewState(process.env, readEngineV2PreviewState(config));
  let enabled = initialState.enabled;
  let chatRouting = initialState.chatRouting === true;
  let allowRunning = true;
  let running = false;
  let version: string | undefined;
  let pid: number | undefined;
  let binSource: EngineV2PreviewStatus["binSource"];
  let mirroredProviderIds: string[] = [];
  let skippedProviderIds: string[] = [];
  let currentCatalogModelIds: string[] = [];
  let lastMirroredAt: string | undefined;
  let lastError: string | undefined;
  let sidecar: ManagedOpencodeV2Server | undefined;
  let unsubscribe: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  let mirrorInFlight: Promise<void> | undefined;
  let mirrorDirty = false;
  const workspaceReadiness = new Map<string, Promise<void>>();
  let migrated = readMigratedSessions(rootDir);
  let mirroredSpecs: OpencodeV2ProviderSpec[] = [];
  const mcpCleaned = new Set<string>();
  const mcpInFlight = new Map<string, Promise<void>>();
  const mcpWorkspaces = new Map<string, string>();

  /** The org's cloud connector, as the app persisted it (engine-v2-mcp.ts). */
  const cloudConnector = async () => cloudMcpEntry(runtimeMcpMap(await readGlobalRuntimeOpencodeConfig(config).catch(() => ({}))));

  /**
   * The engine's gate is fixed at its start: when the org's cloud connector is turned on or off, the engine
   * starts again with the new gate, once no chat runs in any open folder.
   * shortcut: a busy engine keeps its gate until the next connector change or app start.
   */
  async function regateCloudWhenIdle(): Promise<void> {
    const active = sidecar;
    if (!active || Boolean(await cloudConnector()) === active.mcpGate.includes(CLOUD_MCP_NAME)) return;
    for (const directory of mcpWorkspaces.keys()) {
      const running = await active.fetchJson("/api/session/active", { directory, timeoutMs: 5_000 }).catch(() => null);
      if (!running || !isRecord(running.json) || !isRecord(running.json.data) || Object.keys(running.json.data).length > 0) {
        lastError = "The cloud connector applies once no chat is running.";
        return;
      }
    }
    if (sidecar !== active) return;
    await closeSidecar();
    await start();
  }

  async function syncWorkspaceMcp(workspaceId: string, directory: string): Promise<void> {
    mcpWorkspaces.set(directory, workspaceId);
    // Serialize each location, then re-read authoritative state. A queued call
    // must not reuse a snapshot taken before a removal or credential update.
    const previous = mcpInFlight.get(directory);
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      const active = sidecar;
      if (!active) throw new Error("OmniRush v2 is not running");
      if (mcpCleaned.has(directory)) return;
      // The allowed servers (engine-v2-mcp.ts) through the engine's runtime MCP API; every other one goes.
      const desired = await desiredV2Mcp(runtimeStorageDir(config), directory, active.env, active.mcpGate, await cloudConnector());
      const current = await active.fetchJson("/api/mcp", { directory, timeoutMs: 10_000 });
      if (current.status !== 200 || !isRecord(current.json) || !Array.isArray(current.json.data)) {
        throw new Error("OmniRush v2 MCP status is unavailable");
      }
      const names = current.json.data.flatMap((entry) => (
        isRecord(entry) && typeof entry.name === "string" && entry.name.trim() ? [entry.name] : []
      ));
      await Promise.all(names.filter((name) => !Object.hasOwn(desired, name)).map(async (name) => {
        const result = await active.fetchJson(`/api/experimental/mcp/${encodeURIComponent(name)}`, {
          method: "DELETE", directory, timeoutMs: 15_000,
        });
        if (result.status !== 204 && result.status !== 404) throw new Error(`OmniRush v2 MCP removal failed (${result.status})`);
      }));
      await Promise.all(Object.entries(desired).map(async ([name, serverConfig]) => {
        const result = await active.fetchJson(`/api/experimental/mcp/${encodeURIComponent(name)}`, {
          method: "PUT", directory, body: { config: serverConfig }, timeoutMs: 15_000,
        });
        if (result.status < 200 || result.status >= 300) throw new Error(`OmniRush v2 MCP setup failed (${result.status})`);
      }));
      // The first prompt waits (bounded) for the servers to connect: from engine r4 on, "connected" means their tools are ready.
      const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
      while (Object.keys(desired).length > 0 && Date.now() < deadline) {
        const status = await active.fetchJson("/api/mcp", { directory, timeoutMs: 5_000 });
        const servers = isRecord(status.json) && Array.isArray(status.json.data) ? status.json.data : [];
        const waiting = Object.keys(desired).some((name) => {
          const server = servers.find((entry) => isRecord(entry) && entry.name === name);
          return !isRecord(server) || (isRecord(server.status) && server.status.status === "pending");
        });
        if (!waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      mcpCleaned.add(directory);
    })();
    mcpInFlight.set(directory, pending);
    try { await pending; }
    catch (error) {
      mcpCleaned.delete(directory);
      throw error;
    }
    finally { if (mcpInFlight.get(directory) === pending) mcpInFlight.delete(directory); }
  }

  function status(): EngineV2PreviewStatus {
    return {
      enabled,
      chatRouting,
      running,
      ...(version === undefined ? {} : { version }),
      ...(pid === undefined ? {} : { pid }),
      ...(binSource === undefined ? {} : { binSource }),
      mirroredProviderIds: [...mirroredProviderIds],
      skippedProviderIds: [...skippedProviderIds],
      catalogModelIds: [...currentCatalogModelIds],
      ...(lastMirroredAt === undefined ? {} : { lastMirroredAt }),
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  async function mirrorProviders(): Promise<void> {
    const active = sidecar;
    if (!active) return;
    const providerMap = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    // The account's own provider (the local gateway broker, with the synced model catalog), as the 1.x engine
    // gets it. Its key stays in the engine's environment (blanked in agent shells), never in a config file.
    const injected = await buildOmniRushRuntimeConfigObject(config).catch(() => ({}) as Record<string, unknown>);
    const gateway = isRecord(injected.provider) ? injected.provider[OMNIRUSH_PROVIDER_ID] : undefined;
    if (isRecord(gateway) && config.omnirushEngineToken) {
      providerMap[OMNIRUSH_PROVIDER_ID] = gateway;
      credentials.set(ENGINE_TOKEN_ENV, `{env:${ENGINE_TOKEN_ENV}}`);
    }
    const mapped = mapRuntimeProvidersToV2Specs(providerMap, credentials);
    // Claude Code under the engine: its own spec (an `aisdk:file://` package the mapping above never takes).
    const claude = stockMode() ? null : await options.claude?.().catch(() => null);
    if (claude) mapped.specs.push(claude);
    // Stock mode (stock-mode.mjs): the gateway's GPT 6 Astra only, so the engine is not waited on for the rest.
    if (stockMode()) mapped.specs = stockProviders(mapped.specs);
    const nextMirroredProviderIds = mapped.specs.map((spec) => spec.id);
    await active.setProviders(mapped.specs);
    mirroredSpecs = mapped.specs;
    workspaceReadiness.clear();
    mirroredProviderIds = nextMirroredProviderIds;
    skippedProviderIds = [...mapped.skippedProviderIds];
    lastMirroredAt = new Date().toISOString();
    const expectedModelIds = mapped.specs.flatMap((spec) => spec.models.map((model) => model.id));
    const deadline = Date.now() + CATALOG_MIRROR_TIMEOUT_MS;
    let catalog = await active.fetchJson("/api/model", { directory: workspaceDir });
    let nextCatalogModelIds = catalogModelIds(catalog.json, nextMirroredProviderIds);
    while (expectedModelIds.some((modelId) => !nextCatalogModelIds.includes(modelId)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      catalog = await active.fetchJson("/api/model", { directory: workspaceDir });
      nextCatalogModelIds = catalogModelIds(catalog.json, nextMirroredProviderIds);
    }
    currentCatalogModelIds = nextCatalogModelIds;
    const missingModelIds = expectedModelIds.filter((modelId) => !nextCatalogModelIds.includes(modelId));
    const catalogMessage = isRecord(catalog.json) && typeof catalog.json.message === "string"
      ? ` ${catalog.json.message}`
      : "";
    lastError = missingModelIds.length === 0
      ? undefined
      : `catalog missing [${missingModelIds.join(", ")}] after ${CATALOG_MIRROR_TIMEOUT_MS}ms: ${catalog.status}${catalogMessage}`;
  }

  function scheduleMirror(): void {
    mirrorDirty = true;
    if (mirrorInFlight) return;
    mirrorInFlight = (async () => {
      try {
        while (mirrorDirty && allowRunning && sidecar) {
          mirrorDirty = false;
          try {
            await mirrorProviders();
          } catch (error) {
            lastError = errorMessage(error);
          }
        }
      } finally {
        mirrorInFlight = undefined;
        if (mirrorDirty && allowRunning && sidecar) scheduleMirror();
      }
    })();
    void mirrorInFlight;
  }

  async function closeSidecar(): Promise<void> {
    const active = sidecar;
    workspaceReadiness.clear();
    sidecar = undefined;
    mcpCleaned.clear();
    mcpWorkspaces.clear();
    running = false;
    version = undefined;
    pid = undefined;
    if (!active) return;
    try {
      await active.close();
    } catch (error) {
      lastError = errorMessage(error);
    }
  }

  async function startSidecar(): Promise<void> {
    const resolved = await resolveBinary(config);
    binSource = resolved.source;
    if (!enabled || !allowRunning) return;
    await mkdir(workspaceDir, { recursive: true });
    // First start next to a 1.x store: back it up and seed the 2.x store from a copy (the 1.x store is kept).
    // Later, 1.x chats the 2.x store does not have yet (made in a 1.x app after it was seeded) are brought over too.
    try {
      const v1Db = join(engineDataDir(process.env), "opencode.db");
      if (!await seedV2StoreFromV1(rootDir, v1Db)) await importMissingV1Chats(rootDir, v1Db);
    } catch (error) {
      lastError = `1.x chats were not brought over: ${errorMessage(error)}`;
    }
    migrated = readMigratedSessions(rootDir);
    const opencodeModelsEnv = await resolveOpencodeModelsEnv();
    const managed = await createManagedOpencodeV2Server({
      bin: resolved.bin,
      rootDir,
      env: {
        ...opencodeModelsEnv, OMNIRUSH_SERVER_URL: `http://127.0.0.1:${config.port}`, OMNIRUSH_POLICY_TOKEN: managedDesktopPolicy(config).evaluationToken,
        ...(config.omnirushEngineToken ? { [ENGINE_TOKEN_ENV]: config.omnirushEngineToken } : {}),
      },
      permissions: async () => executionRules((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy?.execution),
      webSearch: () => webSearchSetting({ env: process.env, stateDir: runtimeStorageDir(config) }).enabled,
      webSearchOff: () => webSearchToolOff(webSearchSetting({ env: process.env, stateDir: runtimeStorageDir(config) }), stockMode()),
      // The Linux sandbox (box/): the shell and box plugin follow BoxService.engineBits on every config write.
      box: async () => v2BoxBits(await boxServiceFor(config).engineBits()),
      titleModel: () => omnirushTitleModel(config),
      // Stock mode (stock-mode.mjs): no MCP server, the app's included.
      mcpGate: stockMode() ? [] : v2McpGate(runtimeStorageDir(config), { ...process.env, ...computerUseEngineEnv(runtimeStorageDir(config)) }, Boolean(await cloudConnector())),
    });
    sidecar = managed;
    if (!enabled || !allowRunning) {
      await closeSidecar();
      return;
    }
    try {
      const health = await managed.health();
      version = health.version;
      pid = health.pid;
      running = health.healthy;
      const unsubscribeConfig = onRuntimeOpencodeConfigWrite((_writeConfig, workspaceId) => {
        const global = isEngineGlobalRuntimeConfigId(workspaceId);
        if (global) scheduleMirror();
        if (global) void regateCloudWhenIdle();
        // Connections installed through OmniRush.ai also update already-open
        // locations while a conversation is active. Request admission joins
        // the same serialized reconciliation rather than racing it.
        for (const [directory, id] of mcpWorkspaces) {
          mcpCleaned.delete(directory);
          if (global || id === workspaceId) void syncWorkspaceMcp(id, directory).catch((error) => {
            if (sidecar) lastError = `MCP: ${errorMessage(error)}`;
          });
        }
      });
      const unsubscribeEnv = options.env?.onChange(scheduleMirror);
      unsubscribe = () => { unsubscribeConfig(); unsubscribeEnv?.(); };
      scheduleMirror();
      if (mirrorInFlight) await mirrorInFlight;
      if (!enabled || !allowRunning) {
        await closeSidecar();
        return;
      }
    } catch (error) {
      await closeSidecar();
      throw error;
    }
  }

  async function start(): Promise<void> {
    if (sidecar) return;
    if (startPromise) {
      await startPromise;
      return;
    }
    const pending = startSidecar();
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = undefined;
    }
  }

  function recordStartError(error: unknown): void {
    running = false;
    lastError = errorMessage(error);
  }

  async function stopRuntime(): Promise<void> {
    allowRunning = false;
    unsubscribe?.();
    unsubscribe = undefined;
    mirrorDirty = false;
    if (startPromise) await startPromise.catch(() => undefined);
    if (mirrorInFlight) await mirrorInFlight;
    await closeSidecar();
  }

  async function setEnabled(nextEnabled: boolean): Promise<EngineV2PreviewStatus> {
    if (!nextEnabled) throw new Error("The 2.x engine runs every chat and cannot be turned off.");
    if (nextEnabled && enabled && running) return status();
    await writeEngineV2PreviewState(config, { enabled: nextEnabled, chatRouting });
    enabled = nextEnabled;
    if (!enabled) {
      await stopRuntime();
      return status();
    }
    allowRunning = true;
    lastError = undefined;
    // Fire and forget: binary resolution can install from npm and boot can take
    // tens of seconds, while renderer config requests time out after 10s. The
    // status endpoint reports progress and records failures via lastError.
    void start().catch(recordStartError);
    return status();
  }

  async function setChatRouting(nextChatRouting: boolean): Promise<EngineV2PreviewStatus> {
    if (!nextChatRouting) throw new Error("The 2.x engine runs every chat and cannot be turned off.");
    await writeEngineV2PreviewState(config, { enabled, chatRouting: nextChatRouting });
    chatRouting = nextChatRouting;
    return status();
  }

  function connection(): { url: string; username: string; password: string } | undefined {
    if (!running || !sidecar) return undefined;
    return { url: sidecar.url, username: sidecar.username, password: sidecar.password };
  }

  async function ensureWorkspaceReady(directory: string): Promise<void> {
    if (mirrorInFlight) await mirrorInFlight;
    const active = sidecar;
    if (!active) throw new Error("OmniRush v2 is not running");
    const existing = workspaceReadiness.get(directory);
    if (existing) return existing;
    // V2 discovers configuration asynchronously for each new location. Its
    // initial catalog can be empty even after the preview location is ready.
    const pending = (async () => {
      const deadline = Date.now() + 8_000;
      do {
        const response = await active.fetchJson("/api/provider", { directory, timeoutMs: 5_000 });
        const payload = isRecord(response.json) ? response.json.data : undefined;
        if (response.status === 200 && Array.isArray(payload) && mirroredSpecs.every((spec) =>
          payload.some((provider) => isRecord(provider) && provider.id === spec.id
            // A key the engine reads from its environment shows resolved (or not at all): its presence is enough.
            && (spec.apiKey.startsWith("{env:") || (isRecord(provider.settings) && provider.settings.apiKey === spec.apiKey)))
        )) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error("OmniRush v2 workspace provider configuration did not become ready");
    })().then(() => assertSessionPluginActive(active, directory));
    workspaceReadiness.set(directory, pending);
    try { await pending; } catch (error) {
      if (workspaceReadiness.get(directory) === pending) workspaceReadiness.delete(directory);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    await stopRuntime();
  }

  function awaitConnection(timeoutMs: number) {
    return awaitEngineConnection({
      connection,
      starting: () => startPromise,
      // Turned off, stopped, or its last start failed (recordStartError): nothing to wait for.
      failed: () => !enabled || !allowRunning || (!running && lastError !== undefined),
    }, timeoutMs);
  }

  async function refreshProviders(): Promise<void> {
    if (!sidecar) return;
    scheduleMirror();
    if (mirrorInFlight) await mirrorInFlight;
  }

  function startWhenReady(): void {
    if (enabled) void start().catch(recordStartError);
  }
  if (!options.deferStart) startWhenReady();
  return { start: startWhenReady, status, setEnabled, setChatRouting, connection, awaitConnection, refreshProviders, ensureWorkspaceReady, syncWorkspaceMcp, migratedFromV1: (id) => migrated.has(id), stop };
}
