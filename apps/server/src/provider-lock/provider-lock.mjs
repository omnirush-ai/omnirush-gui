// Model providers in the managed engine: only OmniRush's own provider (the
// account gateway) unless the server says otherwise.
//
// The server's switch is GET /collect/capabilities `providers`
// ({ locked, allow, message }). It is LOCKED unless an answer from the server
// says `locked: false` in so many words: no answer (offline, an error, an
// older server), no block or a malformed block is locked. Nothing on this
// computer (environment, settings, a remembered answer) can unlock it.
//
// While locked:
//   - the engine runs with OMNIRUSH_PROVIDER_LOCK=1 and the allowed provider
//     ids (OMNIRUSH_PROVIDER_ALLOW), and the engine itself keeps every other
//     provider out: config files, environment keys, saved logins, plugins and
//     the public model list (engine-1.18.32-ux4-pl1 and later);
//   - the engine config the app writes lists only the allowed providers and
//     names no model of another provider;
//   - a model asked for by name (`--model`, an agent's config) must belong to
//     an allowed provider, or the app refuses it with `message`.
//
// The same file ships in omnirush-cli (src/provider-lock/) and omnirush-gui
// (apps/server/src/provider-lock/); PARITY.sha256 lists it in both. No imports,
// so the desktop's bundler and the CLI's plain node both load it as is.

export const OMNIRUSH_PROVIDER_ID = "omnirush";
/** The app's own providers: the gateway's, and Claude Code in the box (assets/claude-provider). */
export const APP_PROVIDER_IDS = Object.freeze([OMNIRUSH_PROVIDER_ID, "omnirush-claude"]);
export const PROVIDER_LOCK_MESSAGE = "Only OmniRush models are available.";
export const PLUGINS_OFF_MESSAGE = "Custom plugins are off while OmniRush models are locked.";
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_MESSAGE = 300;

/**
 * Engine environment keys that inject configuration from outside the app's
 * own config file. While locked the app removes them from the engine's
 * environment (the engine would drop their provider settings anyway).
 */
export const ENGINE_CONFIG_INJECTION_ENV = Object.freeze([
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_MODELS_URL",
  "OPENCODE_MODELS_PATH",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanMessage(value) {
  if (typeof value !== "string") return PROVIDER_LOCK_MESSAGE;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_MESSAGE) : PROVIDER_LOCK_MESSAGE;
}

/** The locked policy every missing, failed or malformed answer means. */
export function lockedProviderPolicy(source = "default") {
  return { locked: true, allow: [...APP_PROVIDER_IDS], message: PROVIDER_LOCK_MESSAGE, source };
}

/**
 * The policy in a /collect/capabilities answer. `capabilities` null/undefined
 * (no answer) or without a well-formed `providers` block is locked.
 * Returns { locked, allow, message, source } with `allow` always naming
 * "omnirush" first.
 */
export function providerLockPolicy(capabilities) {
  const block = isRecord(capabilities) ? capabilities.providers : null;
  if (!isRecord(block)) return lockedProviderPolicy(isRecord(capabilities) ? "missing" : "default");
  const message = cleanMessage(block.message);
  if (block.locked === false) return { locked: false, allow: [], message, source: "server" };
  // Only OmniRush's own provider can be allowed: other ids in `allow` are ignored (the engine would not
  // trust their definitions anyway).
  const allow = [...APP_PROVIDER_IDS];
  return { locked: true, allow, message, source: "server" };
}

/** The provider id of a "provider/model" reference; null for a bare model id or a non-string. */
export function modelProvider(ref) {
  if (typeof ref !== "string") return null;
  const text = ref.trim();
  const slash = text.indexOf("/");
  return slash > 0 ? text.slice(0, slash) : null;
}

/**
 * Whether a model reference may be used under `policy`. A bare id (no
 * provider) is the app's own catalog's to resolve, so it passes here.
 */
export function modelRefAllowed(policy, ref) {
  if (policy && policy.locked === false) return true;
  const provider = modelProvider(ref);
  return provider === null || (policy ?? lockedProviderPolicy()).allow.includes(provider);
}

/**
 * The engine environment changes for `policy`: `set` to add, `remove` to
 * delete from the inherited environment. Unlocked: only OMNIRUSH_PROVIDER_LOCK=0
 * (the app runs as it did before the lock existed). No policy is locked.
 */
export function providerLockEnv(policy = null) {
  policy = policy ?? lockedProviderPolicy();
  // Unlocked by the server: the engine is told so (it is locked unless OMNIRUSH_PROVIDER_LOCK=0).
  if (policy && policy.locked === false) return { set: { OMNIRUSH_PROVIDER_LOCK: "0" }, remove: [] };
  return {
    set: {
      OMNIRUSH_PROVIDER_LOCK: "1",
      OMNIRUSH_PROVIDER_ALLOW: policy.allow.join(","),
      OMNIRUSH_PROVIDER_LOCK_MESSAGE: policy.message,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    remove: [...ENGINE_CONFIG_INJECTION_ENV],
  };
}

/** Applies providerLockEnv(policy) to a copy of `env`. */
export function withProviderLockEnv(env, policy) {
  const { set, remove } = providerLockEnv(policy);
  const out = { ...env };
  for (const key of remove) delete out[key];
  return Object.assign(out, set);
}

/**
 * Locks an engine config object the app is about to write: `provider` keeps
 * only allowed ids, `enabled_providers` is exactly the allowed ids,
 * `disabled_providers` is dropped, and `model`, `small_model`, every agent's
 * and command's `model` that names another provider is removed. Returns
 * { config, removed } where `removed` lists what was taken out
 * ("provider:<id>", "model", "agent.<name>.model", ...). Unlocked: the config
 * as it is.
 */
export function lockEngineConfig(config, policy) {
  policy = policy ?? lockedProviderPolicy();
  if (policy.locked === false || !isRecord(config)) return { config, removed: [] };
  const removed = [];
  const out = { ...config };
  if (isRecord(out.provider)) {
    const kept = {};
    for (const [id, value] of Object.entries(out.provider)) {
      if (policy.allow.includes(id)) kept[id] = value;
      else removed.push(`provider:${id}`);
    }
    out.provider = kept;
  }
  // The gateway's provider always; another app provider only where this config defines it.
  out.enabled_providers = policy.allow.filter((id) => id === OMNIRUSH_PROVIDER_ID || (isRecord(out.provider) && id in out.provider));
  if ("disabled_providers" in out) {
    delete out.disabled_providers;
    removed.push("disabled_providers");
  }
  for (const key of ["model", "small_model"]) {
    if (key in out && !modelRefAllowed(policy, out[key])) {
      delete out[key];
      removed.push(key);
    }
  }
  for (const group of ["agent", "mode", "command"]) {
    if (!isRecord(out[group])) continue;
    const next = {};
    for (const [name, entry] of Object.entries(out[group])) {
      if (isRecord(entry) && "model" in entry && !modelRefAllowed(policy, entry.model)) {
        const { model: _model, ...rest } = entry;
        next[name] = rest;
        removed.push(`${group}.${name}.model`);
      } else {
        next[name] = entry;
      }
    }
    out[group] = next;
  }
  return { config: out, removed };
}
