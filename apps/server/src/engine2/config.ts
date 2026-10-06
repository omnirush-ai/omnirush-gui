/**
 * The runtime engine config OmniRush.ai renders in the 1.x dialect
 * (omnirush-runtime-config.ts) as the 2.x engine's `opencode.json`.
 *
 * The 2.x engine can read most 1.x keys itself, but a few of them are lost in
 * its own migration and matter here: plugin file paths are dropped (2.x loads
 * plugins from `<config dir>/plugins/`), the top-level `subagent_depth` is
 * unsupported (it lives under `experimental`), MCP servers default to
 * "code mode" (tools reachable only through a JavaScript `execute` tool
 * instead of as `<server>_<tool>` tools), and provider keys delivered at
 * runtime (`PUT /auth/:id` in 1.x) have no config home. The whole file is
 * therefore written in 2.x keys here, following the engine's own 1.x
 * migration (core/src/v1/config/migrate.ts) for everything else.
 */
import { isRecord, omitUndefined, type JsonRecord } from "./util.js";

export type EngineConfigInput = {
  /** The 1.x runtime config object (the file handed to the engine as OPENCODE_CONFIG). */
  v1: JsonRecord;
  /** API keys delivered for providers at runtime (1.x `PUT /auth/:providerID` with `{type:"api", key}`). */
  apiKeys?: Record<string, string>;
  /** Plugin directories the engine loads (OmniRush.ai's plugin bridge). */
  plugins?: string[];
};

/** 1.x tool / permission names in 2.x (core/src/v1/config/migrate.ts normalizeAction). */
export function v2Action(action: string): string {
  if (action === "write" || action === "patch") return "edit";
  if (action === "task") return "subagent";
  if (action === "bash") return "shell";
  return action;
}

type Rule = { action: string; resource: string; effect: string };

function isEffect(value: unknown): value is "allow" | "deny" | "ask" {
  return value === "allow" || value === "deny" || value === "ask";
}

/** A 1.x permission map (`{bash: {"git *": "allow"}, edit: "ask", …}`) and `tools` flags as 2.x rules, in order. */
export function v2Permissions(permission: unknown, tools?: unknown): Rule[] | undefined {
  const rules: Rule[] = [];
  if (isRecord(tools)) {
    for (const [action, enabled] of Object.entries(tools)) {
      if (typeof enabled === "boolean") rules.push({ action: v2Action(action), resource: "*", effect: enabled ? "allow" : "deny" });
    }
  }
  if (isRecord(permission)) {
    for (const [key, rule] of Object.entries(permission)) {
      const action = v2Action(key);
      if (isEffect(rule)) {
        rules.push({ action, resource: "*", effect: rule });
        continue;
      }
      if (!isRecord(rule)) continue;
      for (const [resource, effect] of Object.entries(rule)) if (isEffect(effect)) rules.push({ action, resource, effect });
    }
  }
  return rules.length ? rules : undefined;
}

function modelSelection(input: unknown, variant?: unknown): JsonRecord | undefined {
  if (typeof input !== "string" || !/^[^/#]+\/[^#]+$/.test(input)) return undefined;
  const separator = input.indexOf("/");
  return omitUndefined({
    providerID: input.slice(0, separator),
    model: input.slice(separator + 1),
    variant: typeof variant === "string" && variant && !variant.includes("#") ? variant : undefined,
  });
}

function v2Agent(info: JsonRecord): JsonRecord {
  const options = isRecord(info.options) ? info.options : {};
  const body = omitUndefined({
    ...options,
    temperature: typeof info.temperature === "number" ? info.temperature : undefined,
    top_p: typeof info.top_p === "number" ? info.top_p : undefined,
  });
  return omitUndefined({
    model: modelSelection(info.model, info.variant),
    request: Object.keys(body).length ? { body } : undefined,
    system: typeof info.prompt === "string" ? info.prompt : undefined,
    description: typeof info.description === "string" ? info.description : undefined,
    mode: info.mode === "primary" || info.mode === "subagent" || info.mode === "all" ? info.mode : undefined,
    hidden: typeof info.hidden === "boolean" ? info.hidden : undefined,
    color: typeof info.color === "string" ? (info.color.startsWith("#") ? info.color : "#aaaaaa") : undefined,
    steps: typeof info.steps === "number" ? info.steps : typeof info.maxSteps === "number" ? info.maxSteps : undefined,
    disabled: info.disable === true ? true : undefined,
    permissions: v2Permissions(info.permission, info.tools),
  });
}

/** A 1.x MCP server entry as a 2.x one; tools stay direct (`<server>_<tool>`), not behind code mode. */
export function v2Mcp(info: unknown): JsonRecord | undefined {
  if (!isRecord(info)) return undefined;
  const disabled = typeof info.enabled === "boolean" ? !info.enabled : typeof info.disabled === "boolean" ? info.disabled : undefined;
  const timeout = typeof info.timeout === "number" ? { catalog: info.timeout, execution: info.timeout } : isRecord(info.timeout) ? info.timeout : undefined;
  if (info.type === "local") {
    return omitUndefined({
      type: "local",
      command: Array.isArray(info.command) ? info.command : undefined,
      cwd: typeof info.cwd === "string" ? info.cwd : undefined,
      environment: isRecord(info.environment) ? info.environment : undefined,
      disabled,
      timeout,
      codemode: false,
    });
  }
  if (info.type === "remote") {
    const oauth = isRecord(info.oauth)
      ? omitUndefined({
          client_id: info.oauth.clientId ?? info.oauth.client_id,
          client_secret: info.oauth.clientSecret ?? info.oauth.client_secret,
          scope: info.oauth.scope,
          callback_port: info.oauth.callbackPort ?? info.oauth.callback_port,
          redirect_uri: info.oauth.redirectUri ?? info.oauth.redirect_uri,
        })
      : info.oauth === false ? false : undefined;
    return omitUndefined({
      type: "remote",
      url: typeof info.url === "string" ? info.url : undefined,
      headers: isRecord(info.headers) ? info.headers : undefined,
      oauth,
      disabled,
      timeout,
      codemode: false,
    });
  }
  return undefined;
}

/** 1.x AI SDK package names the 2.x engine ships natively (core/src/aisdk-native.ts). */
const NATIVE_PACKAGES: Record<string, string> = {
  "@ai-sdk/amazon-bedrock": "@opencode/ai/providers/amazon-bedrock",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
  "@ai-sdk/cerebras": "@opencode/ai/providers/cerebras",
  "@ai-sdk/deepinfra": "@opencode/ai/providers/deepinfra",
  "@ai-sdk/google": "@opencode/ai/providers/google",
  "@ai-sdk/google-vertex": "@opencode/ai/providers/google-vertex",
  "@ai-sdk/groq": "@opencode/ai/providers/groq",
  "@ai-sdk/mistral": "@opencode/ai/providers/mistral",
  "@ai-sdk/openai": "@opencode/ai/providers/openai",
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
  "@ai-sdk/togetherai": "@opencode/ai/providers/togetherai",
  "@ai-sdk/xai": "@opencode/ai/providers/xai",
  "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
};

export function v2Package(npm: unknown): string | undefined {
  if (typeof npm !== "string" || !npm.trim()) return undefined;
  if (npm.startsWith("@opencode/") || npm.startsWith("aisdk:")) return npm;
  if (npm.startsWith("@opencode-ai/ai/")) return npm.replace("@opencode-ai/", "@opencode/");
  return NATIVE_PACKAGES[npm] ?? `aisdk:${npm}`;
}

function splitOptions(options: unknown): { settings: JsonRecord; headers?: Record<string, string>; body?: JsonRecord } {
  if (!isRecord(options)) return { settings: {} };
  const { headers, body, ...settings } = options;
  return {
    settings,
    headers: isRecord(headers)
      ? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined,
    body: isRecord(body) ? { ...body } : undefined,
  };
}

function v2Model(info: JsonRecord): JsonRecord {
  const cost = isRecord(info.cost) ? info.cost : undefined;
  const modalities = isRecord(info.modalities) ? info.modalities : undefined;
  const capabilities = info.tool_call !== undefined || modalities?.input !== undefined || modalities?.output !== undefined
    ? {
        tools: info.tool_call !== false,
        input: Array.isArray(modalities?.input) ? modalities.input : ["text"],
        output: Array.isArray(modalities?.output) ? modalities.output : ["text"],
      }
    : undefined;
  const limit = isRecord(info.limit) ? info.limit : undefined;
  const provider = isRecord(info.provider) ? info.provider : undefined;
  const options = isRecord(info.options) ? { ...info.options } : undefined;
  const interleaved = info.interleaved;
  return omitUndefined({
    modelID: typeof info.id === "string" ? info.id : undefined,
    family: typeof info.family === "string" ? info.family : undefined,
    name: typeof info.name === "string" ? info.name : undefined,
    compatibility: isRecord(interleaved) && typeof interleaved.field === "string" ? { reasoningField: interleaved.field } : undefined,
    package: provider ? v2Package(provider.npm) : undefined,
    settings: provider && typeof provider.api === "string" ? { ...(options ?? {}), baseURL: provider.api } : options,
    capabilities,
    headers: isRecord(info.headers) ? info.headers : undefined,
    variants: isRecord(info.variants)
      ? Object.entries(info.variants).filter(([, value]) => isRecord(value) && value.disabled !== true).map(([id, value]) => ({ id, settings: { ...(value as JsonRecord) } }))
      : undefined,
    cost: cost
      ? [
          omitUndefined({
            input: typeof cost.input === "number" ? cost.input : 0,
            output: typeof cost.output === "number" ? cost.output : 0,
            cache: { read: typeof cost.cache_read === "number" ? cost.cache_read : 0, write: typeof cost.cache_write === "number" ? cost.cache_write : 0 },
          }),
        ]
      : undefined,
    disabled: info.status === "deprecated" ? true : undefined,
    limit: limit
      ? omitUndefined({
          context: typeof limit.context === "number" ? Math.trunc(limit.context) : undefined,
          input: typeof limit.input === "number" ? Math.trunc(limit.input) : undefined,
          output: typeof limit.output === "number" ? Math.trunc(limit.output) : undefined,
        })
      : undefined,
  });
}

function v2Provider(info: JsonRecord, apiKey?: string): JsonRecord {
  const { settings, headers, body } = splitOptions(info.options);
  const merged = omitUndefined({
    ...settings,
    ...(typeof info.api === "string" ? { baseURL: info.api } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  return omitUndefined({
    name: typeof info.name === "string" ? info.name : undefined,
    env: Array.isArray(info.env) ? info.env.filter((item) => typeof item === "string") : undefined,
    package: v2Package(info.npm),
    settings: Object.keys(merged).length ? merged : undefined,
    headers: headers && Object.keys(headers).length ? headers : undefined,
    body,
    models: isRecord(info.models)
      ? Object.fromEntries(Object.entries(info.models).filter(([, model]) => isRecord(model)).map(([id, model]) => [id, v2Model(model as JsonRecord)]))
      : undefined,
  });
}

/** The 2.x config for a 1.x runtime config. */
export function buildEngine2Config(input: EngineConfigInput): JsonRecord {
  const v1 = input.v1;
  const apiKeys = input.apiKeys ?? {};
  const providers: JsonRecord = {};
  if (isRecord(v1.provider)) {
    for (const [id, provider] of Object.entries(v1.provider)) {
      if (isRecord(provider)) providers[id] = v2Provider(provider, apiKeys[id]);
    }
  }
  // Keys delivered for catalog providers the config does not describe still need a home.
  for (const [id, key] of Object.entries(apiKeys)) {
    if (!providers[id]) providers[id] = { settings: { apiKey: key } };
  }
  const agents: JsonRecord = {};
  for (const source of [v1.agent, v1.mode]) {
    if (!isRecord(source)) continue;
    for (const [name, agent] of Object.entries(source)) {
      if (!isRecord(agent)) continue;
      agents[name] = v2Agent(source === v1.mode ? { ...agent, mode: "primary" } : agent);
    }
  }
  const small = modelSelection(v1.small_model);
  if (small) agents.title = { model: small, ...(isRecord(agents.title) ? agents.title : {}) };
  // MCP is intentionally never copied into the managed engine config.
  const servers: JsonRecord = {};
  const policies = [
    ...(Array.isArray(v1.enabled_providers)
      ? [
          { action: "provider.use", resource: "*", effect: "deny" },
          ...v1.enabled_providers.filter((id): id is string => typeof id === "string").map((resource) => ({ action: "provider.use", resource, effect: "allow" })),
        ]
      : []),
    ...(Array.isArray(v1.disabled_providers)
      ? v1.disabled_providers.filter((id): id is string => typeof id === "string").map((resource) => ({ action: "provider.use", resource, effect: "deny" }))
      : []),
  ];
  const depth = typeof v1.subagent_depth === "number"
    ? v1.subagent_depth
    : isRecord(v1.experimental) && typeof v1.experimental.subagent_depth === "number" ? v1.experimental.subagent_depth : undefined;
  const skills = isRecord(v1.skills)
    ? [...(Array.isArray(v1.skills.paths) ? v1.skills.paths : []), ...(Array.isArray(v1.skills.urls) ? v1.skills.urls : [])].filter((item) => typeof item === "string")
    : Array.isArray(v1.skills) ? v1.skills : undefined;
  const commands = isRecord(v1.command)
    ? Object.fromEntries(Object.entries(v1.command).filter(([, value]) => isRecord(value)).map(([id, value]) => {
        const command = value as JsonRecord;
        return [id, omitUndefined({
          template: command.template,
          description: command.description,
          agent: command.agent,
          model: modelSelection(command.model, command.variant),
          subagent: command.subtask,
        })];
      }))
    : undefined;
  const permissions = v2Permissions(v1.permission, v1.tools) ?? [];
  return omitUndefined({
    $schema: "https://opencode.ai/config.json",
    model: typeof v1.model === "string" ? v1.model : undefined,
    default_agent: typeof v1.default_agent === "string" ? v1.default_agent : undefined,
    username: typeof v1.username === "string" ? v1.username : undefined,
    shell: typeof v1.shell === "string" ? v1.shell : undefined,
    share: v1.share === "manual" || v1.share === "auto" || v1.share === "disabled" ? v1.share : undefined,
    update: "disable",
    // The code-mode `execute` tool is not offered: the agent calls tools directly, as with 1.x.
    permissions: [...permissions, { action: "execute", resource: "*", effect: "deny" }],
    agents: Object.keys(agents).length ? agents : undefined,
    mcp: Object.keys(servers).length ? { servers } : undefined,
    skills: skills && skills.length ? skills : undefined,
    commands,
    instructions: Array.isArray(v1.instructions) ? v1.instructions : undefined,
    formatter: v1.formatter === false || isRecord(v1.formatter) ? v1.formatter : undefined,
    lsp: v1.lsp === false || isRecord(v1.lsp) ? v1.lsp : undefined,
    watcher: isRecord(v1.watcher) ? v1.watcher : undefined,
    snapshots: typeof v1.snapshot === "boolean" ? v1.snapshot : undefined,
    plugins: input.plugins && input.plugins.length ? input.plugins : undefined,
    experimental: depth !== undefined || policies.length
      ? omitUndefined({ subagent_depth: depth, policies: policies.length ? policies : undefined })
      : undefined,
    providers: Object.keys(providers).length ? providers : undefined,
  });
}
