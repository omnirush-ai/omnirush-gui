import { managedPolicyPluginPath, sessionNextPluginPath } from "./managed-policy-plugin.js";
import type { EnginePermissionRule } from "./managed-policy-rules.js";
// Parallel v2 lane prototype: provider injection is a watched-config write. This module
// deliberately has no reload/dispose call, unlike managed-opencode.ts and server.ts reloadOpencodeEngine.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";


import { loopbackFetch } from "./server-fetch.js";
import { writeFileAtomic } from "./atomic-write.js";
import { currentProviderLockPolicy, noteEngineStarted, providerAllowed } from "./provider-lock.js";
import { APP_PROVIDER_IDS, providerLockEnv } from "./provider-lock/provider-lock.mjs";
import { gateEnv } from "./engine-gates/engine-gates.mjs";
import { STOCK_ENV, STOCK_PROVIDER, STOCK_SHELL_ENV, stockMode, stockProviders } from "./stock-mode/stock-mode.mjs";
import { releaseEngineBinary } from "./release-guard.js";

export interface OpencodeV2ModelSpec {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface OpencodeV2ProviderSpec {
  id: string;
  name: string;
  baseUrl?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  apiKey: string;
  models: OpencodeV2ModelSpec[];
}

/** One app model as the 2.x engine config entry. */
export function v2ModelConfig(model: OpencodeV2ModelSpec): Record<string, unknown> {
  const config = model.config ?? {};
  const modalities = isRecord(config.modalities) ? config.modalities : {};
  // The catalog's efforts (its enabled variants), as the CLI's engine-v2.js v2Model.
  const efforts = isRecord(config.variants)
    ? Object.entries(config.variants).filter(([, value]) => isRecord(value) && value.disabled !== true).map(([id]) => id)
    : [];
  return {
    name: model.name,
    ...(typeof config.id === "string" ? { modelID: config.id } : {}),
    capabilities: {
      tools: typeof config.tool_call === "boolean" ? config.tool_call : true,
      input: modalities.input ?? ["text"],
      output: modalities.output ?? ["text"],
      ...(config.reasoning ? { reasoning: { supported: true, ...(efforts.length ? { effort: efforts } : {}) } } : {}),
    },
    // A mid-chat effort change goes as the request's own reasoning.effort (what the gateway meters), not only
    // as a configuration_update item the engine would add for gpt-6+ ids while keeping the chat's first effort.
    ...(config.reasoning ? { compatibility: { supportsEffortUpdates: false } } : {}),
    // No catalog limit: the engine's own default, as stock (an output cap of 32000 tokens).
    ...(isRecord(config.limit) ? { limit: config.limit } : {}),
    ...(typeof config.family === "string" ? { family: config.family } : {}),
    ...(isRecord(config.options) ? { settings: config.options } : {}),
    ...(isRecord(config.headers) ? { headers: config.headers } : {}),
    ...(config.status === "deprecated" ? { disabled: true } : {}),
  };
}

export interface ManagedOpencodeV2ServerOptions {
  bin: string;
  rootDir: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string>;
  bootTimeoutMs?: number;
  permissions?: () => Promise<EnginePermissionRule[]>;
  /** Whether the server's web-search switch is on (web-search.ts): the stock websearch tool then searches. */
  webSearch?: () => boolean;
  /** The MCP servers the engine's gate allows (engine-v2-mcp.ts); none when absent. */
  mcpGate?: string[];
  /** The Linux sandbox's engine bits (engine-v2-preview.ts v2BoxBits): the box shell and the 2.x box plugin; null: none. */
  box?: () => Promise<{ shell: string; plugin: string } | null>;
  /** "omnirush/<default model>": the title agent's model while the Claude provider is listed. */
  titleModel?: () => Promise<string | null>;
}

export interface OpencodeV2Health {
  healthy: boolean;
  version: string;
  pid: number;
}

export interface ManagedOpencodeV2Server {
  url: string;
  username: string;
  password: string;
  childPid: number | undefined;
  /** The environment the engine runs with (MCP servers inherit it under their own). */
  readonly env: Record<string, string>;
  readonly mcpGate: string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  health(): Promise<OpencodeV2Health>;
  fetchJson(path: string, init?: { method?: string; body?: unknown; directory?: string; timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  injectProvider(spec: OpencodeV2ProviderSpec): Promise<void>;
  setProviders(specs: OpencodeV2ProviderSpec[]): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnostics(exitCode: number | null, stdout: string, stderr: string): Error {
  const tail = (value: string) => value.slice(-4_000);
  return new Error(
    `OmniRush v2 server exited with code ${String(exitCode)}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
  );
}

/**
 * Writes `text` to `file` only when the file does not already hold it. The 2.x engine watches its config: a rewrite
 * with the same content still reloads it, and a reload during a turn drops the model streams in flight (the gateway
 * then settles them as disconnects). Returns whether it wrote.
 */
export async function writeIfChanged(file: string, text: string, write: (file: string, text: string) => Promise<void>): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === text) return false;
  await write(file, text);
  return true;
}

/**
 * The 2.x engine loads a configured plugin only from a directory (a file path is skipped with a
 * warning): each plugin module gets one, whose server.js re-exports it.
 */
export async function pluginDirectories(root: string, modules: string[]): Promise<string[]> {
  return Promise.all(modules.map(async (module) => {
    const directory = join(root, basename(module, extname(module)));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeIfChanged(join(directory, "server.js"), `export { default } from ${JSON.stringify(pathToFileURL(module).href)};\n`, (file, text) => writeFile(file, text, { mode: 0o600 }));
    return directory;
  }));
}

/**
 * The engine's environment with its gates last (engine-gates.mjs): only the gateway provider and the
 * listed MCP servers. The engine fails open without the gate variables, so the spawn is refused when
 * they are missing.
 */
/** The app's gateway provider: the only one the engine may use (its gate, and the config's policies). */
const GATEWAY_PROVIDER_ID = "omnirush";
const CLAUDE_PROVIDER_ID = "omnirush-claude";

export function engineV2SpawnEnv(env: Record<string, string>, mcp: readonly string[] = []): Record<string, string> {
  // Both app providers pass the gate (a comma list): the gateway's and Claude Code in the box (opencode-plugins/claude-provider).
  // Stock mode (stock-mode.mjs): the gateway's only, and no MCP server.
  const stock = stockMode(env);
  return assertEngineGates({ ...env, ...gateEnv({ provider: GATEWAY_PROVIDER_ID, mcp: stock ? [] : mcp }), OMNIRUSH_GATE_PROVIDERS: stock ? STOCK_PROVIDER : APP_PROVIDER_IDS.join(",") });
}

export function assertEngineGates(env: Record<string, string | undefined>): Record<string, string> {
  if (!env.OMNIRUSH_GATE_PROVIDERS || env.OMNIRUSH_NO_SYSTEM_CONFIG !== "1" || typeof env.OMNIRUSH_GATE_MCP !== "string") {
    throw new Error("The OmniRush engine's gates are missing; it was not started.");
  }
  return env as Record<string, string>;
}

export async function createManagedOpencodeV2Server(
  options: ManagedOpencodeV2ServerOptions,
): Promise<ManagedOpencodeV2Server> {
  // A release build runs only the engine it bundles, checked by its sha256 (release-guard.ts).
  const bin = await releaseEngineBinary(options.bin) ?? options.bin;
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  const configDir = join(options.rootDir, "config");
  const password = randomBytes(24).toString("base64url");
  const username = "opencode";
  let url = "";
  const providers = new Map<string, OpencodeV2ProviderSpec>();
  // Model providers (provider-lock.ts): while locked no model list source and the lock's keys.
  const providerLock = currentProviderLockPolicy();
  const opencodeModelsUrl = providerLock.locked ? undefined : (options.env?.OPENCODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL)?.replace(/\/+$/, "");
  const disableModelsFetch = options.env?.OPENCODE_DISABLE_MODELS_FETCH ?? process.env.OPENCODE_DISABLE_MODELS_FETCH;
  // The engine needs OS paths and locale settings, not the server's provider,
  // cloud, database, or control-plane credentials. Unknown keys stay private.
  const inherited: Record<string, string> = {};
  for (const key of [
    "OMNIRUSH_SERVER_URL", "OMNIRUSH_POLICY_TOKEN", "OMNIRUSH_ACCESS_TOKEN", "OMNIRUSH_BOX_HOME",
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", STOCK_ENV, STOCK_SHELL_ENV,
  ]) {
    const value = options.env?.[key] ?? process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  if (!stockMode(inherited)) delete inherited[STOCK_SHELL_ENV];
  // A caller may deliberately provide a config file; never inherit the server's
  // OPENCODE_CONFIG or OPENCODE_PURE settings implicitly.
  if (options.env?.OPENCODE_CONFIG) inherited.OPENCODE_CONFIG = options.env.OPENCODE_CONFIG;

  await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
  await chmod(options.rootDir, 0o700);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  // The user's global opencode config (~/.config/opencode) is not read either: its MCP servers would start with
  // this environment (the password and the policy token) before the app removes them. Its own empty folder instead.
  const configHome = join(options.rootDir, "xdg-config");
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await chmod(configHome, 0o700);
  // Load enforcement on the first boot, before any session can run.
  await writeProviders();
  const env = engineV2SpawnEnv({
    ...inherited,
    OPENCODE_PASSWORD: password,
    OPENCODE_DB: join(options.rootDir, "opencode.db"),
    OPENCODE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: configHome,
    // Its data and state (snapshots, logs, sign-ins) stay in its own folder, never the CLI's
    // <XDG data>/omnirush; agent shells get the user's back (omnirush-session-next.ts).
    XDG_DATA_HOME: join(options.rootDir, "data"),
    XDG_STATE_HOME: join(options.rootDir, "state"),
    OMNIRUSH_USER_XDG_DATA_HOME: inherited.XDG_DATA_HOME ?? "",
    OMNIRUSH_USER_XDG_STATE_HOME: inherited.XDG_STATE_HOME ?? "",
    OMNIRUSH_USER_XDG_CONFIG_HOME: inherited.XDG_CONFIG_HOME ?? "",
    // Claude Code's global files (~/.claude) are not read either.
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    // The engine's update check reads only the user's own global config, not ours: never replace the bundled engine.
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    // A project's own config stays on (its AGENTS.md is stock behaviour); the engine keeps only its
    // descriptive keys there and loads none of its plugins, MCP servers or providers.
    ...(opencodeModelsUrl === undefined ? {} : { OPENCODE_MODELS_URL: opencodeModelsUrl }),
    ...(disableModelsFetch === undefined ? {} : { OPENCODE_DISABLE_MODELS_FETCH: disableModelsFetch }),
    ...providerLockEnv(providerLock).set,
  }, options.mcpGate ?? []);
  const child = spawn(bin, ["serve", "--hostname", hostname, "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  async function fetchJson(
    path: string,
    init: { method?: string; body?: unknown; directory?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown }> {
    if (!url) throw new Error("OmniRush v2 has not announced its listener");
    const separator = path.includes("?") ? "&" : "?";
    const requestPath = init.directory === undefined
      ? path
      : `${path}${separator}location%5Bdirectory%5D=${encodeURIComponent(init.directory)}`;
    const response = await loopbackFetch(`${url}${requestPath}`, {
      method: init.method,
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.timeoutMs === undefined ? undefined : AbortSignal.timeout(init.timeoutMs),
    });
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON engine responses remain observable as raw text.
    }
    return { status: response.status, json };
  }

  async function health(): Promise<OpencodeV2Health> {
    // 2.0.x has no health route: its info answers 200 once the server serves.
    const response = await fetchJson("/api/info", { timeoutMs: 5_000 });
    if (response.status !== 200 || !isRecord(response.json)) {
      throw new Error(`OmniRush v2 health returned HTTP ${response.status}`);
    }
    const { version, pid } = response.json;
    if (typeof version !== "string" || typeof pid !== "number") {
      throw new Error("OmniRush v2 health returned an invalid payload");
    }
    if (pid !== child.pid) throw new Error("OmniRush v2 health did not match the spawned child");
    return { healthy: true, version, pid };
  }

  async function writeProviders(): Promise<void> {
    const providerConfig: Record<string, unknown> = {};
    const stock = stockMode(process.env);
    for (const provider of stock ? stockProviders([...providers.values()]) : providers.values()) {
      // Only the providers the lock allows (provider-lock.ts) reach the v2 engine.
      if (!providerAllowed(provider.id)) continue;
      const models: Record<string, unknown> = {};
      for (const model of provider.models) {
        models[model.id] = v2ModelConfig(model);
      }
      providerConfig[provider.id] = {
        name: provider.name,
        package: provider.package ?? "@opencode-ai/ai/providers/openai-compatible",
        settings: {
          ...provider.settings,
          ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
          apiKey: provider.apiKey,
          name: provider.id,
        },
        ...(provider.headers ? { headers: provider.headers } : {}),
        models,
      };
    }
    const titleModel = providerConfig[CLAUDE_PROVIDER_ID] ? await options.titleModel?.().catch(() => null) : null;
    const target = join(configDir, "opencode.json");
    // The box shell runs each command in its project's box (boxsh; natively for a project without one).
    const box = await options.box?.().catch(() => null) ?? null;
    await writeIfChanged(target, `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      // No session sharing to an outside service; the bundled engine never replaces itself.
      share: "disabled",
      update: "disable",
      providers: providerConfig,
      // As the CLI's v2 config (engine-v2.js toV2Config): only the app's providers may run a model,
      // beside the engine's gate (OMNIRUSH_GATE_PROVIDERS, engineV2SpawnEnv), which no config can widen.
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        ...APP_PROVIDER_IDS.map((id) => ({ action: "provider.use", resource: id, effect: "allow" })),
      ],
      // Titles on the gateway's default model while Claude is listed: a Claude turn is a Claude Code run, never a title.
      ...(titleModel ? { agents: { title: { model: titleModel } } } : {}),
      ...(options.permissions ? { permissions: await options.permissions() } : {}),
      // On: the stock websearch tool searches through Exa (the engine's keyless default), like the CLI.
      // Off: no provider is picked (never `false`, which would take the tool out of the stock list).
      // shortcut: Exa until the gateway serves a search integration of its own.
      ...(!stock && options.webSearch?.() ? { websearch: { provider: "exa" } } : {}),
      ...(box ? { shell: box.shell } : {}),
      plugins: await pluginDirectories(join(options.rootDir, "plugins"), [sessionNextPluginPath(), ...(options.env?.OMNIRUSH_SERVER_URL ? [managedPolicyPluginPath(true)] : []), ...(box ? [box.plugin] : [])]),
    }, null, 2)}\n`, (file, text) => writeFileAtomic(file, text, { mode: 0o600 }));
  }

  async function close(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const exited = await Promise.race([
      exit.then(() => true),
      sleep(2_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }

  const managed: ManagedOpencodeV2Server = {
    get url() { return url; },
    username,
    password,
    childPid: child.pid,
    env,
    mcpGate: [...(options.mcpGate ?? [])],
    get exitCode() {
      return child.exitCode;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    health,
    fetchJson,
    async injectProvider(spec) {
      providers.set(spec.id, spec);
      await writeProviders();
    },
    async setProviders(specs) {
      providers.clear();
      for (const spec of specs) {
        providers.set(spec.id, spec);
      }
      await writeProviders();
    },
    close,
  };

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await close();
      throw new Error(`Failed to start OmniRush v2 server: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) throw diagnostics(child.exitCode, stdout, stderr);
    // Only the child can write its stdout pipe. Do not send the generated
    // credential to a probed port before that child confirms it has bound.
    if (!url) {
      const announced = stdout.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      if (announced) {
        const endpoint = new URL(announced);
        if (endpoint.hostname !== hostname || !endpoint.port || endpoint.port === "0"
          || endpoint.username || endpoint.password || endpoint.pathname !== "/"
          || endpoint.search || endpoint.hash
          || (port !== 0 && Number(endpoint.port) !== port)) {
          await close();
          throw new Error("OmniRush v2 announced an unexpected listener");
        }
        url = endpoint.origin;
        // Model providers (provider-lock.ts): whether this engine started locked.
        noteEngineStarted(url, providerLock);
      }
    }
    try {
      const state = await health();
      if (state.healthy) return managed;
    } catch {
      // The engine can return 503 or refuse connections while booting.
    }
    await sleep(250);
  }

  await close();
  throw new Error(`Timed out waiting ${bootTimeoutMs}ms for OmniRush v2 health\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
}
