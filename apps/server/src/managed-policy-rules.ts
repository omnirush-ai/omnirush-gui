import type { DesktopConfig, DesktopExecutionPolicy, DesktopPolicyKey } from "@omnirush/types/den/desktop-policies";
import { z } from "zod";
import type { ApprovalMode } from "./approval-mode.js";
import { gitWorkflowPermissionRules } from "./git-command-policy.js";
import permissionModes from "./permissions/permission-modes.json" with { type: "json" };

export const managedPolicyActionSchema = z.enum([
  "sync", "shell", "terminal", "saved_command", "file_write", "engine_config", "browser_external",
  "model", "webfetch", "websearch", "browser", "extensions", "settings", "provider", "workspace",
  // The engine is about to record a commit in a repository; the server
  // defaults the identity from the omnirush.ai account or refuses clearly.
  "git_identity",
]);
export type ManagedPolicyAction = z.infer<typeof managedPolicyActionSchema>;

// Every existing Den control must have an explicit owner. Adding a key without
// mapping it is a type error; UI-only fields cannot pretend to be tool rules.
export const desktopPolicyTargets = {
  allowCustomProviders: "provider", allowZenModel: "provider",
  allowMultipleWorkspaces: "workspace", allowControlSettings: "settings",
  allowManageExtensions: "extensions", allowBuiltInExtensions: "builtins",
  allowAlphaUpdates: "app", showWelcomePage: "app",
} satisfies Record<DesktopPolicyKey, string>;

export const executionPolicyTargets = {
  commands: ["engine.shell", "tool.before", "shell.before", "engine.proxy"],
  blockedCommands: ["engine.shell", "tool.before", "shell.before", "engine.proxy"],
  browserOrigins: ["engine.webfetch", "tool.before", "browser.request"],
  blockBrowserUploads: ["browser.request"],
} satisfies Record<keyof DesktopExecutionPolicy, readonly string[]>;

export type EnginePermissionRule = { action: string; resource: string; effect: "allow" | "deny" };
export function executionRules(policy: DesktopExecutionPolicy | undefined): EnginePermissionRule[] {
  if (!policy) return [];
  const rules: EnginePermissionRule[] = [];
  if (policy.commands === "deny") rules.push({ action: "shell", resource: "*", effect: "deny" });
  for (const resource of policy.blockedCommands) rules.push({ action: "shell", resource, effect: "deny" });
  if (policy.browserOrigins !== undefined) {
    rules.push({ action: "webfetch", resource: "*", effect: "deny" });
    rules.push({ action: "websearch", resource: "*", effect: "deny" });
  }
  return rules;
}
type PermissionAction = "allow" | "ask" | "deny";
export type LegacyExecutionPermissions = {
  bash: Record<string, PermissionAction>;
  /** Full mode: a catch-all allow after the engine's default `read *.env` asks; careful and guarded: the shared secret-file asks. */
  read?: Record<string, PermissionAction>;
  webfetch?: PermissionAction;
  websearch?: PermissionAction;
  edit?: PermissionAction;
  doom_loop?: PermissionAction;
  external_directory?: "allow";
  /** Careful's catch-all and plain tool names. */
  [permission: string]: PermissionAction | Record<string, PermissionAction> | undefined;
};

type SharedModeRules = Record<string, PermissionAction | Record<string, PermissionAction>>;
const SHARED_MODES = permissionModes.rules as unknown as { careful: SharedModeRules; normal: SharedModeRules };

function cloneRules(rules: SharedModeRules): SharedModeRules {
  return JSON.parse(JSON.stringify(rules)) as SharedModeRules;
}

/**
 * Engine permission block for every managed desktop, by approval mode:
 *
 *   full     a single catch-all allow for bash, a catch-all allow for read
 *            (the engine's own defaults ask before reading `*.env` and
 *            `*.env.*`; the later `read *` allow wins) and allow for every
 *            other permission category the pinned engine exposes, so nothing
 *            asks.
 *   guarded  (Normal) the shared Normal rules for bash and read
 *            (permissions/permission-modes.json, the CLI's file), then the
 *            built-in git and PR workflow rules (read-only commands run,
 *            write commands ask once per session per command family,
 *            destructive commands always ask). MCP tools get their rules
 *            from the MCP plugin (mcp-allow). The shared
 *            top-level catch-all and external_directory rules are left out:
 *            the engine's own external_directory handling and the
 *            authorized-folder grants stay in charge of other folders.
 *   careful  the shared Careful rules without external_directory: a "*" ask
 *            catch-all (the runtime config moves it ahead of the user's
 *            rules) with reads and searches allowed, every edit and command
 *            asking.
 *
 * All are followed by the organization's execution policy. The engine picks
 * the last matching rule, so an organization deny always wins over a
 * workflow or mode allow.
 */
export function legacyExecutionPermissions(
  policy: DesktopExecutionPolicy | undefined,
  mode: ApprovalMode = "guarded",
): LegacyExecutionPermissions {
  let permissions: LegacyExecutionPermissions;
  if (mode === "full") {
    permissions = { bash: { "*": "allow" }, read: { "*": "allow" }, edit: "allow", webfetch: "allow", websearch: "allow", doom_loop: "allow", external_directory: "allow" };
  } else if (mode === "careful") {
    const { external_directory: _external, ...careful } = cloneRules(SHARED_MODES.careful);
    permissions = { ...careful, bash: { ...(careful.bash as Record<string, PermissionAction>) } } as LegacyExecutionPermissions;
  } else {
    const normal = cloneRules(SHARED_MODES.normal);
    const bash = { ...(normal.bash as Record<string, PermissionAction>) };
    // Re-insert every git workflow rule after the shared ones, so a pattern
    // both lists use keeps the git rules' own order (the last match wins).
    for (const [pattern, action] of Object.entries(gitWorkflowPermissionRules())) {
      delete bash[pattern];
      bash[pattern] = action;
    }
    permissions = { bash, read: normal.read as Record<string, PermissionAction> };
  }
  for (const rule of executionRules(policy)) {
    if (rule.action === "shell") {
      // Re-insert so a pattern the workflow rules already use moves after them.
      delete permissions.bash[rule.resource];
      permissions.bash[rule.resource] = rule.effect;
    } else if (rule.action === "webfetch" || rule.action === "websearch") {
      // The pinned engine accepts only scalar actions for these two tools.
      permissions[rule.action] = rule.effect;
    }
  }
  return permissions;
}
// Glob matching without a regular expression: repeated wildcard patterns must
// not create catastrophic backtracking on a long command.
function matches(pattern: string, value: string): boolean {
  const rule = pattern.toLowerCase();
  const command = value.toLowerCase();
  let ruleIndex = 0;
  let commandIndex = 0;
  let star = -1;
  let retry = 0;
  while (commandIndex < command.length) {
    if (rule[ruleIndex] === "?" || rule[ruleIndex] === command[commandIndex]) { ruleIndex++; commandIndex++; }
    else if (rule[ruleIndex] === "*") { star = ruleIndex++; retry = commandIndex; }
    else if (star >= 0) { ruleIndex = star + 1; commandIndex = ++retry; }
    else return false;
  }
  while (rule[ruleIndex] === "*") ruleIndex++;
  return ruleIndex === rule.length;
}

export function policyDenial(policy: DesktopConfig, action: ManagedPolicyAction, input: Record<string, unknown>): string | null {
  const execution = policy.execution;
  if (action === "terminal" && (execution?.commands === "deny" || execution?.blockedCommands.length)) return "Interactive terminals are blocked by your team's command policy.";
  if (action === "saved_command" && (execution?.commands === "deny" || execution?.blockedCommands.length)) return "Saved commands are blocked by your team's command policy.";
  if (action === "shell") {
    if (execution?.commands === "deny") return "Your organization has blocked OS commands for your team.";
    const command = typeof input.command === "string" ? input.command : "";
    if (execution?.blockedCommands.some((pattern) => matches(pattern, command))) return "This command is blocked by your team's policy.";
  }
  if (action === "file_write" && (hasExecutionLimits(execution) || policy.allowCustomProviders === false || policy.allowManageExtensions === false || policy.allowControlSettings === false)) {
    const paths: unknown[] = [input.filePath, input.path];
    for (const patch of [input.patchText, input.patch]) {
      if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
    }
    if (Array.isArray(input.operations)) for (const operation of input.operations) {
      if (typeof operation === "object" && operation !== null) {
        for (const [key, value] of Object.entries(operation)) if (["path", "from", "to"].includes(key)) paths.push(value);
      }
    }
    if (paths.some((path) => typeof path === "string" && /(?:^|[\\/])(?:opencode\.jsonc?$|runtime-opencode-config\.json$|\.opencode(?:[\\/]|$)|opencode[\\/](?:plugins?|tools?|skills?|agents?)(?:[\\/]|$))/i.test(path.trim()))) return "Your organization manages this configuration. Change access in Den.";
  }
  if (action === "engine_config" && (hasExecutionLimits(execution) || policy.allowCustomProviders === false || policy.allowManageExtensions === false || policy.allowControlSettings === false)) return "Your organization manages engine configuration. Change access in Den.";
  if (action === "browser_external" && (execution?.browserOrigins !== undefined || execution?.blockBrowserUploads || policy.allowBuiltInExtensions === false)) return "Open this site in the managed browser.";
  if ((action === "model" || action === "provider") && input.providerID === "opencode") {
    return policy.allowZenModel === false ? "Your organization has disabled this AI provider." : null;
  }
  // Native fetch follows redirects inside the engine. Until it exposes a
  // per-hop hook, approved-site browsing must use the intercepted browser.
  if ((action === "webfetch" || action === "websearch") && execution?.browserOrigins !== undefined) return "Use OmniRush.ai's built-in browser to open approved websites.";
  if (action === "browser" || action === "webfetch") {
    if (action === "browser" && policy.allowBuiltInExtensions === false) return "Built-in extensions are disabled by your organization.";
    const url = typeof input.url === "string" ? input.url : "";
    if (execution?.browserOrigins !== undefined) {
      try {
        const target = new URL(url);
        if (target.username || target.password || !execution.browserOrigins.includes(target.origin)) return "This website is not approved by your organization.";
      } catch { return "This website is not approved by your organization."; }
    }
    if (execution?.blockBrowserUploads && (/^wss?:/i.test(url) || input.hasUpload === true || (typeof input.method === "string" && !["GET", "HEAD", "OPTIONS"].includes(input.method)))) return "Browser uploads are blocked by your team's policy.";
  }
  if (action === "extensions" && policy.allowManageExtensions === false) return "Your organization has disabled local extension management.";
  if (action === "settings" && policy.allowControlSettings === false) return "Your organization has disabled changing these settings.";
  if (action === "provider" && policy.allowCustomProviders === false) return "Your organization only allows its assigned AI providers.";
  if (action === "workspace" && policy.allowMultipleWorkspaces === false) return "Your organization has restricted additional workspaces.";
  return null;
}

export function hasExecutionLimits(execution: DesktopExecutionPolicy | undefined): boolean {
  return !!execution && (execution.commands === "deny" || execution.blockedCommands.length > 0 || execution.browserOrigins !== undefined || execution.blockBrowserUploads);
}

export function policyRequestActions(method: string, path: string): ManagedPolicyAction[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return [];
  const actions: ManagedPolicyAction[] = [];
  if (/^\/workspaces\/(local|remote)$/.test(path)) actions.push("workspace");
  if (/^\/runtime-config\/providers$/.test(path)) actions.push("provider");
  if (/^\/runtime-config\/(?:approvals|best-practices)$/.test(path)) actions.push("settings");
  if (path === "/omnirush/subagent-model" || path === "/omnirush/web-search") actions.push("settings");
  if (/^\/workspace\/[^/]+\/(?:cloud-plugins|claude-plugins|plugins|skills|commands|mcp)(?:\/|$)/.test(path)
    && !/\/mcp\/[^/]+\/(?:auth|managed\/connect)$/.test(path)) actions.push("extensions");
  if (/^\/workspace\/[^/]+\/(?:config|opencode-config|runtime-config|permissions|authorized-folders|box)(?:\/|$)/.test(path)) actions.push("settings");
  if (path === "/experimental/engine-v2-preview") actions.push("settings");
  if (/\/opencode-config$/.test(path)) actions.push("engine_config");
  return actions;
}
