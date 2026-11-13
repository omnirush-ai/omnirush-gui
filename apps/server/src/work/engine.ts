// Work chats' engine config (Work mode), applied by the MCP plugin (opencode-plugins/omnirush-mcp-policy.ts).
import { FIRST_PARTY_REMOTE, firstPartyRemote, toolPrefix } from "../mcp-allow/mcp-allow.mjs";
import { workPrompt } from "./prompt.js";
import { isWorkRoot, rememberedAnswerStyle, rememberedWorkConnectors, rememberedWorkSwitch, WORK_DIR_ENV, WORK_DISABLED_TOOLS, WORK_READ_TOOLS } from "./work.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Work chat (the account's Work folder, Work on for the account): the hosted connector server through the
 * app's local API (it adds the account's credential; the engine never holds it), every tool but the read ones
 * asking first in every mode, no shell or code tools, and the Work prompt. Every other project: untouched.
 */
export function applyWork(target: Record<string, unknown>, root: string, env: Record<string, string | undefined> = process.env): void {
  const dir = env[WORK_DIR_ENV];
  if (!dir || !isWorkRoot(dir, root) || !rememberedWorkSwitch(dir).enabled) return;
  const origin = String(env.OMNIRUSH_SERVER_URL ?? "").trim();
  const token = String(env.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
  const id = FIRST_PARTY_REMOTE.work.id;
  const entry = token ? firstPartyRemote("work", origin, `${origin.replace(/\/+$/, "")}${FIRST_PARTY_REMOTE.work.path}`, { Authorization: `Bearer ${token}` }) : null;
  if (entry) target.mcp = { ...(isRecord(target.mcp) ? target.mcp : {}), [id]: { ...entry, timeout: 60_000 } };
  const permission: Record<string, unknown> = typeof target.permission === "string" ? { "*": target.permission } : isRecord(target.permission) ? { ...target.permission } : {};
  const prefix = toolPrefix(id);
  delete permission[`${prefix}*`];
  permission[`${prefix}*`] = "ask";
  for (const tool of WORK_READ_TOOLS) permission[`${prefix}${tool}`] = "allow";
  permission.bash = "deny";
  permission.edit = "deny";
  target.permission = permission;
  target.tools = { ...(isRecord(target.tools) ? target.tools : {}), ...Object.fromEntries(WORK_DISABLED_TOOLS.map((tool) => [tool, false])) };
  const agents = isRecord(target.agent) ? { ...target.agent } : {};
  const main = isRecord(agents.omnirush) ? { ...agents.omnirush } : {};
  // The agent's own rules would otherwise win over the ones above (they are read after the global ones).
  if (isRecord(main.permission)) main.permission = { ...main.permission, ...permission };
  agents.omnirush = { ...main, prompt: workPrompt(rememberedAnswerStyle(dir)) };
  target.agent = agents;
}


// ---------------------------------------------------------------- 2.x engine
// The 2.x engine has no config hook: the app's server gives a Work chat its hosted server through the runtime MCP
// API (engine-v2-mcp.ts), its rules as the chat's own permissions and the Work prompt as its instruction entry
// (server.ts, before each prompt).

/** Whether `root` is the account's Work folder with Work on (the 2.x engine's Work chats). */
export function isV2WorkRoot(dir: string, root: string): boolean {
  return isWorkRoot(dir, root) && rememberedWorkSwitch(dir).enabled;
}

/**
 * The hosted server as a 2.x runtime MCP entry, through the app's local API with the engine's own token; null without either.
 * Its tools follow the connected sources, and the engine lists them only when the entry changes: the sources as last
 * listed go in a header (the local API does not forward it), so connecting or disconnecting one reconnects the server.
 */
export function v2WorkMcp(engineEnv: Record<string, string | undefined>, dir?: string): Record<string, unknown> | null {
  const origin = String(engineEnv.OMNIRUSH_SERVER_URL ?? "").trim();
  const token = String(engineEnv.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
  const sources = dir ? rememberedWorkConnectors(dir).map((row) => row.id).sort().join(",") : "";
  const entry = token ? firstPartyRemote("work", origin, `${origin.replace(/\/+$/, "")}${FIRST_PARTY_REMOTE.work.path}`, { Authorization: `Bearer ${token}`, "X-OmniRush-Work-Sources": sources || "none" }) : null;
  if (!entry) return null;
  return { type: "remote", url: entry.url, headers: entry.headers, oauth: false, codemode: false, timeout: { startup: 60_000, catalog: 60_000, execution: 60_000 } };
}

export type V2PermissionRule = { action: string; resource: string; effect: "allow" | "ask" | "deny" };

/**
 * A Work chat's own 2.x rules (last match wins, so they go last): no shell, file edits, sub-agents or code tools;
 * the hosted server's tools ask, its read tools run.
 */
export function v2WorkPermissions(): V2PermissionRule[] {
  const prefix = toolPrefix(FIRST_PARTY_REMOTE.work.id);
  return [
    ...["shell", "edit", "subagent", "lsp", "codesearch"].map((action) => ({ action, resource: "*", effect: "deny" as const })),
    { action: `${prefix}*`, resource: "*", effect: "ask" },
    ...WORK_READ_TOOLS.map((tool) => ({ action: `${prefix}${tool}`, resource: "*", effect: "allow" as const })),
  ];
}

/** A chat's rules with the Work rules last (moved there if anything came after them); null when they already are. */
export function withV2WorkPermissions(current: unknown): V2PermissionRule[] | null {
  const work = v2WorkPermissions();
  const rules = (Array.isArray(current) ? current : []).filter(isRecord) as V2PermissionRule[];
  const tail = rules.slice(-work.length);
  if (tail.length === work.length && tail.every((rule, index) => rule.action === work[index]!.action && rule.resource === work[index]!.resource && rule.effect === work[index]!.effect)) return null;
  const isWork = (rule: V2PermissionRule) => work.some((item) => item.action === rule.action && item.resource === rule.resource && item.effect === rule.effect);
  return [...rules.filter((rule) => !isWork(rule)), ...work];
}
