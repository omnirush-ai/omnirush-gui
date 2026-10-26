/**
 * Model providers the managed engine may use: only OmniRush's own provider
 * (the account gateway) unless the server says otherwise. The shared rules
 * are provider-lock/provider-lock.mjs (the same file as the CLI's); this is
 * the desktop's side of them.
 *
 * The server's switch is GET /collect/capabilities `providers`
 * ({ locked, allow, message }), read through the gateway broker at start and
 * again every few minutes while the app runs. It is kept in memory only: the
 * app starts LOCKED and stays locked until an answer from the server says
 * `locked: false`; a failed read, no account, an older server or a malformed
 * block is locked again. Nothing on this computer unlocks it: no environment
 * variable (OMNIRUSH_ALLOW_OTHER_PROVIDERS), no organization setting
 * (allowCustomProviders, allowZenModel), no remembered answer.
 *
 * While locked:
 *   - the engine runs with the lock environment (withProviderLockEnv) and
 *     drops every other provider itself;
 *   - the engine config the app writes lists only the allowed providers
 *     (omnirush-runtime-config.ts, lockEngineConfig);
 *   - the app's routes that add a provider, store its key or sign in to it,
 *     and engine requests that name another provider's model, answer 403
 *     `provider_locked` with the server's message.
 */
import { parse as parseJsonc } from "jsonc-parser";

import { ApiError } from "./errors.js";
import {
  APP_PROVIDER_IDS,
  lockEngineConfig,
  lockedProviderPolicy,
  modelRefAllowed,
  PLUGINS_OFF_MESSAGE,
  providerLockEnv,
  providerLockPolicy,
  withProviderLockEnv,
  type ProviderLockPolicy,
} from "./provider-lock/provider-lock.mjs";

export type { ProviderLockPolicy } from "./provider-lock/provider-lock.mjs";
export { lockEngineConfig, modelRefAllowed, providerLockPolicy, withProviderLockEnv } from "./provider-lock/provider-lock.mjs";

export const PROVIDER_LOCKED_CODE = "provider_locked";
export const PLUGINS_LOCKED_CODE = "plugins_locked";
/** User plugins while locked: the engine loads only the app's own (owner decision). */
export const PLUGINS_LOCKED_MESSAGE: string = PLUGINS_OFF_MESSAGE;

let current: ProviderLockPolicy = lockedProviderPolicy("default");

/** The policy in force: locked until the server's answer says otherwise. */
export function currentProviderLockPolicy(): ProviderLockPolicy {
  return current;
}

function samePolicy(left: ProviderLockPolicy, right: ProviderLockPolicy): boolean {
  return left.locked === right.locked && left.message === right.message && left.allow.join(",") === right.allow.join(",");
}

/**
 * Takes the policy of a /collect/capabilities answer (null/undefined: no
 * answer, which is locked). Whether the policy in force changed.
 */
export function applyProviderLockAnswer(capabilities: unknown): boolean {
  const parsed = providerLockPolicy(capabilities ?? null);
  // Only OmniRush's own providers (the gateway's, Claude Code in the box) count as allowed, whatever else a server lists.
  const next = parsed.locked ? { ...parsed, allow: parsed.allow.filter((id) => (APP_PROVIDER_IDS as readonly string[]).includes(id)) } : parsed;
  const changed = !samePolicy(current, next);
  current = next;
  return changed;
}

/** Back to the locked start state (tests, sign-out). */
export function resetProviderLock(): void {
  current = lockedProviderPolicy("default");
}

/** Whether `providerId` may be used under `policy` (ids compare in lower case). */
export function providerAllowed(providerId: unknown, policy: ProviderLockPolicy = current): boolean {
  if (!policy.locked) return true;
  return typeof providerId === "string" && policy.allow.includes(providerId.trim().toLowerCase());
}

export const INVALID_ENGINE_PATH_CODE = "invalid_engine_path";

/**
 * The engine route an app request names, as the checks here match it: dot
 * segments, encoded slashes, backslashes, `;` and NUL are refused (400),
 * repeated slashes are collapsed, and the result is a plain URL path. The
 * same rules as the CLI's route fence.
 */
export function engineRoutePath(raw: string): string {
  const refuse = () => new ApiError(400, INVALID_ENGINE_PATH_CODE, "This engine route is not accepted.");
  const path = raw.split("?")[0] ?? "";
  if (/[\\;\u0000]/.test(path) || /%(?:2e|2f|5c|3b|00)/i.test(path)) throw refuse();
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw refuse();
  }
  if (/[\\;\u0000]/.test(decoded) || decoded.split("/").some((segment) => segment === "." || segment === "..")) throw refuse();
  const collapsed = decoded.replace(/\/{2,}/g, "/");
  return new URL(collapsed.startsWith("/") ? collapsed : `/${collapsed}`, "http://x").pathname;
}

export function providerLockedError(policy: ProviderLockPolicy = current): ApiError {
  return new ApiError(403, PROVIDER_LOCKED_CODE, policy.message);
}

/** Throws 403 provider_locked unless `providerId` is allowed. */
export function assertProviderAllowed(providerId: unknown, policy: ProviderLockPolicy = current): void {
  if (!providerAllowed(providerId, policy)) throw providerLockedError(policy);
}

export const PROVIDER_RESERVED_CODE = "provider_reserved";
export const PROVIDER_RESERVED_MESSAGE = "The OmniRush provider is set by the app only.";

/**
 * A provider a route may write into the app's runtime config: never the
 * app's own (`omnirush`, `omnirush-claude`: only the app sets them, locked or not), and only
 * allowed providers while locked. Throws 403 otherwise.
 */
export function assertProviderWritable(providerId: string, policy: ProviderLockPolicy = current): void {
  if ((APP_PROVIDER_IDS as readonly string[]).includes(providerId.trim().toLowerCase())) throw new ApiError(403, PROVIDER_RESERVED_CODE, PROVIDER_RESERVED_MESSAGE);
  assertProviderAllowed(providerId, policy);
}

/** Throws 403 provider_locked while locked (routes that only ever add another provider). */
export function assertProvidersUnlocked(policy: ProviderLockPolicy = current): void {
  if (policy.locked) throw providerLockedError(policy);
}

/**
 * The engine environment for a spawn: the lock applied to the inherited
 * environment (its config injection keys removed), then the app's own
 * values, then the lock's keys again so nothing the app or the user passed
 * turns the model list fetch or another config source back on.
 */
export function lockedEngineEnv<T extends Record<string, string | undefined>>(
  inherited: T,
  app: Record<string, string | undefined>,
  policy: ProviderLockPolicy = current,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...withProviderLockEnv(inherited, policy), ...app };
  return finishEngineEnv(env, policy);
}

/**
 * The last step of an engine environment built elsewhere: while locked, no
 * inline config, no model list source, and the lock's keys. The app's own
 * OPENCODE_CONFIG_DIR stays (it was set after the inherited value was taken
 * out).
 */
export function finishEngineEnv<T extends Record<string, string | undefined>>(env: T, policy: ProviderLockPolicy = current): T {
  const { set, remove } = providerLockEnv(policy);
  for (const key of remove) if (key !== "OPENCODE_CONFIG_DIR") delete env[key];
  return Object.assign(env, set);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What an engine config (a file's content, a config PATCH) would bring in
 * past the lock: other providers' definitions and model references
 * ("provider:<id>", "model", "agent.<name>.model", ...). Empty when unlocked
 * or when nothing does. A list that only disables providers is fine.
 */
export function providerLockConfigViolations(config: unknown, policy: ProviderLockPolicy = current): string[] {
  if (!policy.locked || !isRecord(config)) return [];
  const removed = lockEngineConfig(config, policy).removed.filter((item) => item !== "disabled_providers");
  if (Array.isArray(config.enabled_providers)) {
    for (const id of config.enabled_providers) if (!policy.allow.includes(String(id))) removed.push(`enabled_providers:${String(id)}`);
  }
  return removed;
}

/** An engine config file's content (JSON with comments) as an object; null when it is not one. */
export function parseJsoncContent(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = parseJsonc(content, [], { allowTrailingComma: true, disallowComments: false });
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a config (a file's content, a PATCH) names engine plugins of its own. */
export function configAddsPlugins(config: unknown): boolean {
  if (!isRecord(config) || !("plugin" in config)) return false;
  const plugin = config.plugin;
  return typeof plugin === "string" ? plugin.trim().length > 0 : Array.isArray(plugin) && plugin.length > 0;
}

/** Throws 403 plugins_locked while locked (routes that add or turn on a user plugin). */
export function assertPluginsUnlocked(policy: ProviderLockPolicy = current): void {
  if (policy.locked) throw new ApiError(403, PLUGINS_LOCKED_CODE, PLUGINS_LOCKED_MESSAGE);
}

/** Throws 403 when a config would add another provider (provider_locked) or plugins (plugins_locked) while locked. */
export function assertConfigWithinLock(config: unknown, policy: ProviderLockPolicy = current): void {
  assertConfigWithinProviderLock(config, policy);
  if (configAddsPlugins(config)) assertPluginsUnlocked(policy);
}

/** Throws 403 provider_locked when the config would bring in another provider. */
export function assertConfigWithinProviderLock(config: unknown, policy: ProviderLockPolicy = current): void {
  if (providerLockConfigViolations(config, policy).length) throw providerLockedError(policy);
}

function modelProviderOf(value: unknown): string | null | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    return slash > 0 ? value.slice(0, slash) : null;
  }
  if (isRecord(value) && typeof value.providerID === "string") return value.providerID;
  return undefined;
}

/**
 * Why an engine request (path without the /opencode prefix, parsed JSON
 * body) breaks the lock, or null. Refused: provider sign-in and API key
 * routes of other providers, config writes that add another provider or its
 * models, and session/prompt requests naming another provider's model.
 */
export function engineRequestProviderLockDenial(
  method: string,
  enginePath: string,
  body: Record<string, unknown>,
  policy: ProviderLockPolicy = current,
): string | null {
  if (!policy.locked) return null;
  const verb = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS", "DELETE"].includes(verb)) return null;
  const path = enginePath.replace(/^\/api(?=\/)/i, "");
  const auth = path.match(/^\/auth\/([^/]+)\/?$/i);
  if (auth) return providerAllowed(decodeURIComponent(auth[1] ?? ""), policy) ? null : policy.message;
  const oauth = path.match(/^\/provider\/([^/]+)\/oauth(?:\/|$)/i);
  if (oauth) return providerAllowed(decodeURIComponent(oauth[1] ?? ""), policy) ? null : policy.message;
  if (/^\/(?:global\/)?config\/?$/i.test(path)) {
    if (configAddsPlugins(body)) return PLUGINS_LOCKED_MESSAGE;
    return providerLockConfigViolations(body, policy).length ? policy.message : null;
  }
  if (/^\/session(?:\/|$)/i.test(path)) {
    // The prompt's model, and each part's own model (a sub-task part names one).
    const parts = Array.isArray(body.parts) ? body.parts.filter(isRecord).map((part) => part.model) : [];
    for (const value of [body.model, body.providerID === undefined ? undefined : { providerID: body.providerID }, ...parts]) {
      const provider = modelProviderOf(value);
      if (provider !== undefined && provider !== null && !providerAllowed(provider, policy)) return policy.message;
    }
  }
  return null;
}

/** Throws 403 provider_locked for engineRequestProviderLockDenial(). */
export function assertEngineRequestWithinProviderLock(method: string, enginePath: string, body: Record<string, unknown>, policy: ProviderLockPolicy = current): void {
  const denial = engineRequestProviderLockDenial(method, enginePath, body, policy);
  if (denial) throw new ApiError(403, denial === PLUGINS_LOCKED_MESSAGE ? PLUGINS_LOCKED_CODE : PROVIDER_LOCKED_CODE, denial);
}

/**
 * Reads the proxied engine request's JSON body (a clone; the request itself
 * is forwarded untouched) and applies engineRequestProviderLockDenial(). A
 * body that is not a JSON object carries no model and passes here.
 */
export async function assertProxiedEngineRequestWithinProviderLock(request: Request, path: string, policy: ProviderLockPolicy = current): Promise<void> {
  // Reads change nothing; every write with an odd path is refused whatever the lock says (engineRoutePath).
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const clean = engineRoutePath(path);
  if (!policy.locked || request.method === "DELETE") return;
  const enginePath = clean.replace(/^\/opencode2?(?=\/|$)/, "");
  let body: Record<string, unknown> = {};
  if (request.body) {
    const text = await request.clone().text().catch(() => "");
    if (text.trim()) {
      try {
        const value: unknown = JSON.parse(text);
        if (isRecord(value)) body = value;
      } catch {
        /* not JSON: no model in it */
      }
    }
  }
  assertEngineRequestWithinProviderLock(request.method, enginePath, body, policy);
}

/**
 * Reads the server's switch again every `everyMs` while the app runs, and
 * calls `apply` when the policy in force changed (an answer flipped it, or a
 * failed read locked it again). One read at a time. Returns the stop.
 */
export function watchProviderLock({ read, apply, everyMs }: { read: () => Promise<unknown>; apply: () => Promise<unknown>; everyMs: number }): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void read()
      .catch(() => null)
      .then((capabilities) => (applyProviderLockAnswer(capabilities) ? apply() : undefined))
      .catch(() => undefined)
      .finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Whether each engine this app started (by origin) started locked: its environment carries the lock from then on. */
const engineStarts = new Map<string, boolean>();

/** An engine started at `url` under `policy` (managed-opencode.ts, managed-opencode-v2.ts). */
/** An engine this app started before the lock applied (its prompts are refused, its runs closed). */
export function engineStartedUnlocked(url: string): boolean {
  return engineStarts.get(originOf(url)) === false;
}

export function noteEngineStarted(url: string, policy: ProviderLockPolicy = current): void {
  engineStarts.set(originOf(url), policy.locked);
}

/** Forgets the engines noted (tests). */
export function resetEngineStarts(): void {
  engineStarts.clear();
}

/** A request that makes the engine do model work: a new chat, a prompt, a command, a shell turn, a summary. */
export function isModelWorkRequest(method: string, enginePath: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = enginePath.replace(/^\/opencode2?(?=\/|$)/i, "").replace(/^\/api(?=\/)/i, "").replace(/\/+$/, "");
  return /^\/session$/i.test(path) || /^\/session\/[^/]+\/(?:prompt|prompt_async|message|command|shell|summarize|init|revert|unrevert)$/i.test(path);
}

/**
 * While locked, refuses model work on an engine this app started unlocked
 * (its environment has no lock; the switch to locked replaces it, but a
 * replacement that did not happen must not leave it serving other
 * providers): 403 provider_locked, asking for a restart. Engines the app
 * did not start, and every other request, pass.
 */
export const PROVIDER_SWITCHING_MESSAGE = "Switching to OmniRush models, retry in a moment.";

export function assertEngineStartedWithinLock(engineUrl: string | null | undefined, method: string, enginePath: string, policy: ProviderLockPolicy = current, options: { switching?: boolean } = {}): void {
  if (!policy.locked || !engineUrl || !isModelWorkRequest(method, engineRoutePath(enginePath))) return;
  if (engineStarts.get(originOf(engineUrl)) !== false) return;
  // A newer engine under the lock is already serving (this one drains): the request can be sent again.
  if (options.switching) throw new ApiError(503, PROVIDER_LOCKED_CODE, PROVIDER_SWITCHING_MESSAGE);
  throw new ApiError(403, PROVIDER_LOCKED_CODE, `${policy.message} Restart the app to continue.`);
}

/** The policy for the app's UI (GET /omnirush/provider-lock). */
export function providerLockStatus(policy: ProviderLockPolicy = current, userPlugins = 0): { locked: boolean; allow: string[]; message: string; source: string; plugins: { off: boolean; message: string | null; userPlugins: number } } {
  return {
    locked: policy.locked,
    allow: [...policy.allow],
    message: policy.message,
    source: policy.source,
    plugins: { off: policy.locked, message: policy.locked ? PLUGINS_LOCKED_MESSAGE : null, userPlugins },
  };
}
