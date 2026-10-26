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
import { pathToFileURL } from "node:url";
import { mergeSkillPaths, userGlobalSkillPaths } from "./user-skill-paths.js";
import {
  omnirushExtensionsPreviewPluginPath,
  omnirushCapabilitiesKnowledgePluginPath,
  omnirushAnthropicAdaptiveThinkingPluginPath,
  omnirushAnthropicToolSchemaPluginPath,
  omnirushTitleRecoveryPluginPath,
  omnirushReasoningEffortPluginPath,
  omnirushSwarmPluginPath,
  omnirushMcpPolicyPluginPath,
  omnirushBudgetWrapPluginPath,
  omnirushOfficeAttachmentsPluginPath,
  omnirushSpreadsheetsPluginPath,
  omnirushBuildathonPluginPath,
  omnirushChromeDevtoolsPluginPath,
  omnirushPdfAttachmentsPluginPath,
  omnirushPluginPath,
  omnirushAgentAssistPluginPath,
  omnirushClaudeProviderPath,
} from "./omnirush-extensions-plugin-path.js";
import { agentAssistFlags, agentAssistLspConfig, writeAgentAssistFile } from "./agent-assist-config.js";
import type { ServerConfig } from "./types.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  onRuntimeOpencodeConfigWrite,
  isEngineGlobalRuntimeConfigId,
  readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeProviderMap,
  runtimePluginList,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { OMNIRUSH_AGENT_PROMPT } from "./omnirush-agent-prompt.js";
import { LEGACY_SWARM_SKILL_NAME, OMNIRUSH_SUBAGENT_DEPTH, OMNIRUSH_SWARM_SKILL_NAME, OMNIRUSH_SWARM_TOOL_NAME, omnirushSwarmSkillMarkdown } from "./omnirush-swarm.js";
import {
  builtinOmniRushModelCatalog,
  engineModelsFromCatalog,
  omnirushDefaultModelId,
  readOmniRushModelCatalog,
  type OmniRushModelCatalog,
} from "./omnirush-model-catalog.js";
import { writeFileAtomic } from "./atomic-write.js";
import { webSearchSetting, type WebSearchSwitch } from "./web-search.js";
import { currentProviderLockPolicy, lockEngineConfig, type ProviderLockPolicy } from "./provider-lock.js";
import { boxServiceFor } from "./box/desktop.js";
import { engineConfig as withBoxEngineConfig } from "./box/launch.js";
import {
  OMNIRUSH_BEST_PRACTICES,
  bestPracticesEnabled,
  omnirushBestPracticesSkillsDir,
  removeGeneratedSkill,
  removeLegacyBestPracticesSkills,
  writeBestPracticesSkills,
} from "./best-practices.js";
import { gatewayUrlAllowed } from "./release-guard.js";

const INTERNAL_PROVIDER_ID = "omnirush";

type InternalGatewayRuntime = {
  baseUrl: string;
};

function resolveInternalGatewayRuntime(
  env: NodeJS.ProcessEnv = process.env,
): InternalGatewayRuntime | undefined {
  const baseUrl = (env.OMNIRUSH_ENGINE_GATEWAY_URL ?? env.OMNIRUSH_GATEWAY_URL)?.trim().replace(/\/+$/, "");
  // A release build's engine talks to omnirush.ai only (release-guard.ts); another address is not used.
  if (baseUrl && !gatewayUrlAllowed(baseUrl)) return undefined;
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

function internalGatewayProvider(runtime: InternalGatewayRuntime, catalog: OmniRushModelCatalog, webSearch: WebSearchSwitch | null): Record<string, unknown> {
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
    models: engineModelsFromCatalog(catalog, webSearch),
  };
}

/**
 * The Claude provider of the 2.x engine (opencode-plugins/claude-provider, the CLI's assets/claude-provider):
 * Claude's catalog models, each turn real Claude Code in the project's box, its events the engine's parts.
 * `entries`: the account's Claude catalog (every entry: picking one the account may not run explains);
 * `settings`: the provider's options (grantURL, grantKey, shell, boxHome, client, note). Null without entries.
 */
export function claudeEngineProvider(entries: { id: string; name: string }[], settings: Record<string, unknown>) {
  if (!entries.length) return null;
  return {
    id: "omnirush-claude",
    name: "Claude",
    package: `aisdk:${pathToFileURL(omnirushClaudeProviderPath()).href}`,
    // Long Claude Code turns: no request timeout (the provider streams until Claude Code ends).
    settings: { ...settings, timeout: false },
    apiKey: "unused",
    models: entries.map((entry) => ({ id: entry.id, name: entry.name, config: { family: "Claude", tool_call: true, limit: { context: 200_000, output: 64_000 }, modalities: { input: ["text", "image"], output: ["text"] } } })),
  };
}

/** The title agent's model while Claude is listed: the gateway's default ("omnirush/<id>"). */
export async function omnirushTitleModel(config: ServerConfig): Promise<string> {
  return `${INTERNAL_PROVIDER_ID}/${omnirushDefaultModelId(await readOmniRushModelCatalog(config))}`;
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
  const built = buildOmniRushRuntimeConfigObjectFromSnapshot(
    runtimeConfig,
    internalGateway,
    process.env,
    internalGateway && config ? await readOmniRushModelCatalog(config) : undefined,
    config ? omnirushRuntimeSkillsDir(config) : undefined,
    config ? omnirushBestPracticesSkillsDir(config) : undefined,
    // The model's own web search: the server's switch as last seen (web-search.ts).
    config ? webSearchSetting({ env: process.env, stateDir: runtimeStorageDir(config) }) : null,
    // The user's own skill folders from the engine's global config (user-skill-paths.ts).
    config ? await userGlobalSkillPaths(process.env) : [],
  );
  // The Linux sandbox (box/): the engine's shell is the box shell and the box plugin is
  // loaded once any workspace may use a box; every other project's commands run natively
  // through the same shell. The same bytes whichever workspace is active.
  return config ? withBoxEngineConfig(await boxServiceFor(config).engineBits(), built) : built;
}

/** omnirush.ai's own engine plugins that go before the user's, in registration order. */
function omnirushLeadingPluginPaths(): string[] {
  return [
    managedPolicyPluginPath(),
    omnirushChromeDevtoolsPluginPath(),
    // Registration order is prompt order: the knowledge plugin appends the
    // operating rules first, then the extensions plugin adds app-control
    // mechanics, live Connect steering, and the remote skill and Automation
    // catalogs, so rules precede state and state precedes data.
    omnirushCapabilitiesKnowledgePluginPath(),
    omnirushExtensionsPreviewPluginPath(),
    omnirushBudgetWrapPluginPath(),
    omnirushOfficeAttachmentsPluginPath(),
    omnirushSpreadsheetsPluginPath(),
    omnirushPdfAttachmentsPluginPath(),
    omnirushAnthropicAdaptiveThinkingPluginPath(),
    omnirushAnthropicToolSchemaPluginPath(),
    omnirushReasoningEffortPluginPath(),
    omnirushTitleRecoveryPluginPath(),
    omnirushSwarmPluginPath(),
    // Buildathon projects only (the app lists them): the event's reproducibility rules.
    omnirushBuildathonPluginPath(),
    // Self-check, project notes, diagnostics, compaction (agent-assist-config.ts); inert while all are off.
    omnirushAgentAssistPluginPath(),
  ];
}

/**
 * Every engine plugin file omnirush.ai ships. They are bundled and need no
 * npm install, so the engine is told (OMNIRUSH_PLUGINS_NO_DEPS) not to hold a
 * project's first request until its `.opencode` folder's background install
 * of @opencode-ai/plugin ends: on Windows that install took minutes, and
 * every prompt in a new project failed meanwhile. User plugins still wait.
 */
export function omnirushOwnPluginPaths(): string[] {
  return [
    ...omnirushLeadingPluginPaths(),
    managedPolicyPluginPath(true),
    omnirushMcpPolicyPluginPath(),
    omnirushPluginPath("omnirush-box"),
  ];
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
  await removeGeneratedSkill(omnirushRuntimeSkillsDir(config), LEGACY_SWARM_SKILL_NAME);
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
  bestPracticesDir?: string,
  webSearch: WebSearchSwitch | null = null,
  userSkillPaths: string[] = [],
  providerLock: ProviderLockPolicy = currentProviderLockPolicy(),
): Record<string, unknown> {
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  // OMNIRUSH_APPROVALS in the server environment wins over the persisted setting.
  const { "*": catchAll, ...permissions } = legacyExecutionPermissions(runtimeConfig.managedPolicy?.execution, resolveApprovalMode(runtimeConfig, env).mode);
  // A top-level `task` rule would reach every sub-agent (explore must not
  // delegate): Careful's task allow goes to the main agent only.
  const { task: mainAgentTask, ...topLevelPermissions } = permissions;
  // The global row's MCP entries are the account-linked Connect server, which
  // this app does not run; a project's own servers reach the engine through
  // its config files and the MCP plugin (opencode-plugins/omnirush-mcp-policy.ts).
  const { managedPolicy: _managedPolicy, approvals: _approvals, bestPractices: _bestPractices, agentAssist: _agentAssist, mcp: _mcp, provider: _rowProvider, ...engineConfig } = runtimeConfig;
  // Code diagnostics: the main languages' servers on, the rest off; the engine default (none) while off.
  const lsp = agentAssistFlags(runtimeConfig, env).diagnostics ? agentAssistLspConfig() : undefined;
  const enabled = bestPracticesEnabled(runtimeConfig);
  // The app's skill folders, then the user's from the engine's global config:
  // the engine replaces that file's list with this file's (user-skill-paths.ts).
  const skillPaths = mergeSkillPaths([
    ...(skillsDir ? [skillsDir] : []),
    ...(enabled && bestPracticesDir ? [bestPracticesDir] : []),
  ], userSkillPaths);
  // The app's own provider comes from the internal gateway only: an `omnirush` entry in the stored row is never used.
  const { [INTERNAL_PROVIDER_ID]: _storedOwnProvider, ...storedProviders } = runtimeProviderMap(runtimeConfig);
  const provider = {
    ...storedProviders,
    ...(internalGateway
      ? { [INTERNAL_PROVIDER_ID]: internalGatewayProvider(internalGateway, catalog, webSearch) }
      : {}),
  };
  const ownProviders = Object.keys(provider).filter((id) => /^(?:lpr_|omnirush$)/i.test(id));
  // Only when the server unlocked providers (provider-lock.ts): signed in,
  // the model picker lists only omnirush.ai (and org-assigned) models: the
  // engine would otherwise also load providers from the user's own opencode
  // config, whose models bypass the gateway and whose errors name upstream
  // relays. OMNIRUSH_ALLOW_OTHER_PROVIDERS=1 or an org policy with
  // allowCustomProviders: true lets them back in. While locked, none of them
  // does: lockEngineConfig() below keeps only the allowed providers.
  const onlyOwnProviders = ownProviders.length > 0
    && env.OMNIRUSH_ALLOW_OTHER_PROVIDERS !== "1"
    && runtimeConfig.managedPolicy?.allowCustomProviders !== true;
  return withoutEmptyProviderMap(lockEngineConfig({
    ...engineConfig,
    ...(internalGateway
      ? { model: `${INTERNAL_PROVIDER_ID}/${omnirushDefaultModelId(catalog)}` }
      : {}),
    ...(runtimeConfig.managedPolicy?.allowCustomProviders === false ? { enabled_providers: [
      ...ownProviders,
      ...(runtimeConfig.managedPolicy.allowZenModel !== false ? ["opencode"] : []),
    ] } : onlyOwnProviders ? { enabled_providers: ownProviders } : {}),
    // Careful's "*" ask goes first: after the engine's own allow-everything
    // default, but before the user's rules (authorized-folder grants) and
    // ours, which all stay in force. The main agent's own block below leaves
    // it out, or it would come after (and override) the user's grants.
    permission: { ...(catchAll ? { "*": catchAll } : {}), ...engineConfig.permission, ...topLevelPermissions },
    // omnirush.ai's own on-demand skills (the swarm procedure), then the user's skill folders.
    ...(skillPaths.length ? { skills: { paths: skillPaths } } : {}),
    default_agent: runtimeConfig.default_agent ?? "omnirush",
    // Sub-agent swarms: sub-agents may delegate again, up to this many layers
    // below the main session (the engine's default of 1 forbids nesting).
    // The omnirush-swarm plugin bounds how many run and start.
    subagent_depth: OMNIRUSH_SUBAGENT_DEPTH,
    // No session sharing: the engine's share would upload the chat to the
    // upstream project's share service (a third party). The engine also runs
    // with OPENCODE_DISABLE_SHARE=1 (managed-opencode.ts), so a project's
    // own config cannot turn it back on.
    share: "disabled",
    agent: {
      omnirush: {
        description: "omnirush.ai default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: enabled ? `${OMNIRUSH_AGENT_PROMPT}\n\n${OMNIRUSH_BEST_PRACTICES.systemPrompt}` : OMNIRUSH_AGENT_PROMPT,
        permission: {
          ...topLevelPermissions,
          ...(mainAgentTask ? { task: mainAgentTask } : {}),
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
          // The engine denies its question tool to every agent but its own
          // build and plan agents; the app answers questions, so the main
          // agent may ask (sub-agents still cannot).
          question: "allow",
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
      ...omnirushLeadingPluginPaths(),
      // The user's plugins only while model providers are unlocked (provider-lock.ts): locked, the
      // engine loads the app's own plugins and built-ins only.
      ...(providerLock.locked ? [] : runtimePluginList(runtimeConfig)),
      // This must be last: it applies the server's MCP list to the final
      // configuration, after every other plugin.
      omnirushMcpPolicyPluginPath(),
    ],
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    ...(lsp ? { lsp } : {}),
    ...(Object.keys(provider).length ? { provider } : {}),
  }, providerLock).config);
}

/** A provider map the lock emptied is left out, as when there was none. */
function withoutEmptyProviderMap(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.provider) || Object.keys(config.provider).length) return config;
  const { provider: _provider, ...rest } = config;
  return rest;
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
    await removeLegacyBestPracticesSkills(config);
    if (bestPracticesEnabled(await readGlobalRuntimeOpencodeConfig(config))) {
      await writeBestPracticesSkills(config);
    }
    // The agent assist plugin's switches: rewritten before the config, read by the plugin at its next hook.
    await writeAgentAssistFile(config, agentAssistFlags(await readGlobalRuntimeOpencodeConfig(config))).catch(() => undefined);
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
