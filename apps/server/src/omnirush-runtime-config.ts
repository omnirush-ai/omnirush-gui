import { resolveApprovalMode } from "./approval-mode.js";
import { legacyExecutionPermissions } from "./managed-policy-rules.js";
import { managedPolicyPluginPath } from "./managed-policy-plugin.js";
/**
 * Runtime OpenCode configuration injected via a server-managed config file
 * passed to the engine as OPENCODE_CONFIG.
 *
 * This is the single source of truth for the omnirush agent definition,
 * plugins, and any other config that should be injected at runtime rather
 * than written to the user's own config files. Both cli.ts and embedded.ts
 * use this.
 *
 * The engine re-reads the OPENCODE_CONFIG file from disk on every instance
 * rebuild (e.g. /instance/dispose), so the file is synchronized on every
 * runtime-DB write — unlike the previous OPENCODE_CONFIG_CONTENT env var,
 * which was frozen at spawn and reverted MCP state on each dispose.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  omnirushExtensionsPreviewPluginPath,
  omnirushCapabilitiesKnowledgePluginPath,
  omnirushAnthropicAdaptiveThinkingPluginPath,
  omnirushAnthropicToolSchemaPluginPath,
  omnirushTitleRecoveryPluginPath,
  omnirushReasoningEffortPluginPath,
  omnirushSwarmPluginPath,
  omnirushOfficeAttachmentsPluginPath,
  omnirushSpreadsheetsPluginPath,
  omnirushChromeDevtoolsPluginPath,
  omnirushPdfAttachmentsPluginPath,
} from "./omnirush-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  onRuntimeOpencodeConfigWrite,
  isEngineGlobalRuntimeConfigId,
  readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeMcpMap,
  runtimeProviderMap,
  runtimePluginList,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { CONNECT_MCP_SERVER_NAME_PREFIX } from "./connect-mcp-server-catalog.js";
import { isOmniRushUiMcpRegistryEntry } from "./omnirush-ui-mcp-command.js";
import { OMNIRUSH_AGENT_PROMPT } from "./omnirush-agent-prompt.js";
import { OMNIRUSH_SUBAGENT_DEPTH, OMNIRUSH_SWARM_SKILL_NAME, OMNIRUSH_SWARM_TOOL_NAME, omnirushSwarmSkillMarkdown } from "./omnirush-swarm.js";
import {
  builtinOmniRushModelCatalog,
  engineModelsFromCatalog,
  omnirushDefaultModelId,
  readOmniRushModelCatalog,
  type OmniRushModelCatalog,
} from "./omnirush-model-catalog.js";
import { writeFileAtomic } from "./atomic-write.js";

const INTERNAL_PROVIDER_ID = "omnirush";

type InternalGatewayRuntime = {
  baseUrl: string;
};

function resolveInternalGatewayRuntime(
  env: NodeJS.ProcessEnv = process.env,
): InternalGatewayRuntime | undefined {
  const baseUrl = (env.OMNIRUSH_ENGINE_GATEWAY_URL ?? env.OMNIRUSH_GATEWAY_URL)?.trim().replace(/\/+$/, "");
  const accessToken = env.OMNIRUSH_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) return undefined;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    return undefined;
  }
  return { baseUrl: url.toString().replace(/\/$/, "") };
}

function resolveConfiguredInternalGatewayRuntime(
  config: ServerConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): InternalGatewayRuntime | undefined {
  if (config?.omnirushGatewayCredentials && config.omnirushEngineToken) {
    const rawHostname = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const hostname = rawHostname.includes(":") && !rawHostname.startsWith("[")
      ? `[${rawHostname}]`
      : rawHostname;
    const baseUrl = `http://${hostname}:${config.port}/omnirush-gateway/v1`;
    return { baseUrl };
  }
  return resolveInternalGatewayRuntime(env);
}

/** Whether the engine config carries the omnirush.ai provider (an account is signed in). */
export function omnirushGatewayConfigured(config: ServerConfig | undefined): boolean {
  return resolveConfiguredInternalGatewayRuntime(config) !== undefined;
}

function internalGatewayProvider(runtime: InternalGatewayRuntime, catalog: OmniRushModelCatalog): Record<string, unknown> {
  return {
    // The native OpenAI provider uses the Responses API, which preserves
    // reasoning summaries, tool calls, and delegated task events. The generic
    // compatibility provider only emits /chat/completions and loses those
    // capabilities.
    npm: "@ai-sdk/openai",
    name: "omnirush.ai",
    env: ["OMNIRUSH_ACCESS_TOKEN"],
    options: { baseURL: runtime.baseUrl },
    // Only models come from the account's catalog; the provider fields above
    // never do, so a catalog cannot route the engine past the local broker.
    models: engineModelsFromCatalog(catalog),
  };
}

export async function buildOmniRushRuntimeConfigObject(
  config?: ServerConfig,
): Promise<Record<string, unknown>> {
  // Workspace-independent by design: the injected engine config file is
  // rendered from the ENGINE_GLOBAL runtime row, the synced model catalog and
  // static built-ins only, so workspace activation rewrites identical bytes
  // and never varies the engine-pool fingerprint. Per-workspace MCPs reach the
  // engine through the dynamic push path instead.
  const runtimeConfig = config ? await readGlobalRuntimeOpencodeConfig(config) : {};
  const internalGateway = resolveConfiguredInternalGatewayRuntime(config);
  return buildOmniRushRuntimeConfigObjectFromSnapshot(
    runtimeConfig,
    internalGateway,
    process.env,
    internalGateway && config ? await readOmniRushModelCatalog(config) : undefined,
    config ? omnirushRuntimeSkillsDir(config) : undefined,
  );
}

/**
 * The folder of omnirush.ai's own on-demand skills (the omnirush-swarm skill),
 * handed to the engine through `skills.paths`. It lives beside the runtime
 * config file, outside every workspace, so it never shows up in a project.
 */
export function omnirushRuntimeSkillsDir(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "skills");
}

/** Writes the built-in skills the config points at; unchanged files are left alone. */
async function writeOmniRushRuntimeSkills(config: ServerConfig): Promise<void> {
  const directory = join(omnirushRuntimeSkillsDir(config), OMNIRUSH_SWARM_SKILL_NAME);
  const path = join(directory, "SKILL.md");
  const content = omnirushSwarmSkillMarkdown();
  if ((await readFile(path, "utf8").catch(() => undefined)) === content) return;
  await mkdir(directory, { recursive: true });
  await writeFileAtomic(path, content);
}

export function buildOmniRushRuntimeConfigObjectFromSnapshot(
  runtimeConfig: RuntimeOpencodeConfig,
  internalGateway?: InternalGatewayRuntime,
  env: NodeJS.ProcessEnv = process.env,
  catalog: OmniRushModelCatalog = builtinOmniRushModelCatalog(),
  skillsDir?: string,
): Record<string, unknown> {
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  // OMNIRUSH_APPROVALS in the server environment wins over the persisted setting.
  const permissions = legacyExecutionPermissions(runtimeConfig.managedPolicy?.execution, resolveApprovalMode(runtimeConfig, env).mode);
  const { managedPolicy: _managedPolicy, approvals: _approvals, ...engineConfig } = runtimeConfig;
  const provider = {
    ...runtimeProviderMap(runtimeConfig),
    ...(internalGateway
      ? { [INTERNAL_PROVIDER_ID]: internalGatewayProvider(internalGateway, catalog) }
      : {}),
  };
  return {
    ...engineConfig,
    ...(internalGateway
      ? { model: `${INTERNAL_PROVIDER_ID}/${omnirushDefaultModelId(catalog)}` }
      : {}),
    ...(runtimeConfig.managedPolicy?.allowCustomProviders === false ? { enabled_providers: [
      ...Object.keys(provider).filter((id) => /^(?:lpr_|omnirush$)/i.test(id)),
      ...(runtimeConfig.managedPolicy.allowZenModel !== false ? ["opencode"] : []),
    ] } : {}),
    permission: { ...engineConfig.permission, ...permissions },
    // omnirush.ai's own on-demand skills (the swarm procedure).
    ...(skillsDir ? { skills: { paths: [skillsDir] } } : {}),
    default_agent: runtimeConfig.default_agent ?? "omnirush",
    // Sub-agent swarms: sub-agents may delegate again, up to this many layers
    // below the main session (the engine's default of 1 forbids nesting).
    // The omnirush-swarm plugin bounds how many run and start.
    subagent_depth: OMNIRUSH_SUBAGENT_DEPTH,
    agent: {
      omnirush: {
        description: "omnirush.ai default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: OMNIRUSH_AGENT_PROMPT,
        permission: {
          ...permissions,
          skill: {
            // OmniRush.ai supplies its own current skill routing and no longer
            // supports these engine or legacy workspace skills.
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
          // The swarm plugin's board tool is for sub-agents: the main agent
          // writes and reads the board itself, and never pays for the tool
          // definition on its requests.
          [OMNIRUSH_SWARM_TOOL_NAME]: "deny",
        },
      },
      // The engine hides the task tool from a sub-agent unless the sub-agent's
      // own permissions mention `task`. Only the general sub-agent gets it;
      // explore stays read-only (a global task rule would reach every agent).
      // Sub-agents never start a swarm (a running swarm's sub-agents get the
      // board note from the swarm plugin), so the swarm skill is not listed
      // in their prompts.
      general: {
        permission: { task: "allow", skill: { [OMNIRUSH_SWARM_SKILL_NAME]: "deny" } },
      },
    },
    plugin: [
      managedPolicyPluginPath(),
      omnirushChromeDevtoolsPluginPath(),
      // Registration order is prompt order: the knowledge plugin appends the
      // operating rules first, then the extensions plugin adds app-control
      // mechanics, live Connect steering, and the remote skill and Automation
      // catalogs, so rules precede state and state precedes data.
      omnirushCapabilitiesKnowledgePluginPath(),
      omnirushExtensionsPreviewPluginPath(),
      omnirushOfficeAttachmentsPluginPath(),
      omnirushSpreadsheetsPluginPath(),
      omnirushPdfAttachmentsPluginPath(),
      omnirushAnthropicAdaptiveThinkingPluginPath(),
      omnirushAnthropicToolSchemaPluginPath(),
      omnirushReasoningEffortPluginPath(),
      omnirushTitleRecoveryPluginPath(),
      omnirushSwarmPluginPath(),
      ...runtimePluginList(runtimeConfig),
    ],
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    // Registry launches of omnirush-ui-mcp are never delivered, whatever the
    // runtime DB holds: the MCP ships inside the desktop app, not on npm.
    mcp: Object.fromEntries(Object.entries(runtimeMcpMap(runtimeConfig))
      .filter(([name, entry]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX)
        && !isOmniRushUiMcpRegistryEntry(entry))),
    ...(Object.keys(provider).length ? { provider } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export async function buildOmniRushRuntimeConfig(config?: ServerConfig): Promise<string> {
  return stableStringify(await buildOmniRushRuntimeConfigObject(config));
}

export function omnirushRuntimeConfigFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "runtime-opencode-config.json");
}

// Serialize file writes per path so a slow older write can never land after
// (and clobber) a newer one. Content is built inside the queued job so each
// job reads the latest runtime-DB state.
export interface OmniRushRuntimeConfigWriteResult {
  path: string;
  changed: boolean;
}

const fileWriteQueue = new Map<string, Promise<OmniRushRuntimeConfigWriteResult>>();

/**
 * Rebuild the engine-visible runtime config file from the runtime DB.
 * Atomic (temp file + rename) so the engine never reads a partial file
 * mid-dispose.
 */
export async function writeOmniRushRuntimeConfigFile(
  config: ServerConfig,
): Promise<OmniRushRuntimeConfigWriteResult> {
  const path = omnirushRuntimeConfigFilePath(config);
  const job = async () => {
    // The config names the skills folder: write it first, so the engine
    // never loads a config whose built-in skill is missing.
    await writeOmniRushRuntimeSkills(config);
    const content = await buildOmniRushRuntimeConfig(config);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === content) return { path, changed: false };
    await mkdir(runtimeStorageDir(config), { recursive: true });
    await writeFileAtomic(path, content);
    return { path, changed: true };
  };
  const previous = fileWriteQueue.get(path) ?? Promise.resolve();
  const next = previous.then(job, job);
  fileWriteQueue.set(path, next);
  return await next;
}

/**
 * Keep the runtime config file in sync with the runtime DB so every engine
 * instance rebuild reads fresh state instead of a spawn-time snapshot.
 * Returns an unsubscribe function.
 */
export function keepOmniRushRuntimeConfigFileFresh(config: ServerConfig): () => void {
  return onRuntimeOpencodeConfigWrite((writeConfig, writtenWorkspaceId) => {
    if (!isEngineGlobalRuntimeConfigId(writtenWorkspaceId)) return;
    void writeOmniRushRuntimeConfigFile(writeConfig).catch(() => undefined);
  });
}
