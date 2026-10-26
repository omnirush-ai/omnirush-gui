import { createHash } from "node:crypto";

export const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
export type ClaudeBudgetSnapshot = {
  status: "known" | "unknown"; model: string; revision?: string;
  asOf?: string; limitTokens?: number | null; remainingTokens?: number | null; resetAt?: string | null;
  sessionLimitTokens?: number | null; sessionUsedTokens?: number; sessionRemainingTokens?: number | null;
  accountLimitTokens?: number; accountRemainingTokens?: number; accountScope?: "day" | "week"; accountResetAt?: string;
};
export type ClaudeAccess = { owner: string; capabilities?: string[]; budget?: ClaudeBudgetSnapshot; models?: string[]; catalog?: {id: string; name: string}[]; reason?: string | null };
export type ClaudeAuthorization = { sessionId: string; owner: string; model: string; workspaceId: string; contractSha256: string; refresh?: boolean };
export type ClaudeGrant = {
  owner: string; baseUrl: string; token: string; sessionId: string; model: string;
  upstreamModel: string; client: string; bindingId: string; contractSha256: string; budget: ClaudeBudgetSnapshot;
};

export type ClaudeDeviceRequest = (route: string, init?: { method: "POST"; body: string }, owner?: string) => Promise<Response>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const limit = (value: unknown): value is number | null => value === null || tokens(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
/** A picker entry of the server's `claude_code.catalog`. */
export type ClaudeCatalogEntry = { id: string; name: string };
/** The catalog's valid entries (catalog ids, visible names), first of each id kept. */
export function claudeCatalog(value: unknown): ClaudeCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ClaudeCatalogEntry[] = [];
  for (const item of value.slice(0, 16)) {
    if (!record(item) || typeof item.id !== "string" || !CLAUDE_MODEL_ID.test(item.id) || entries.some(entry => entry.id === item.id)) continue;
    const name = typeof item.display_name === "string" ? item.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64) : "";
    entries.push({id: item.id, name: name || item.id});
  }
  return entries;
}
/** Neutral quota metadata is useful to the SDK; provider and credential headers stay private. */
export function claudeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "retry-after", "x-should-retry", "x-omnirush-grant-scope", "x-omnirush-grant-bucket", "x-omnirush-grant-resets-at", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}
export class ClaudeAccessError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string, readonly responseHeaders: Record<string, string> = {}) { super(message); }
}

function budgetSnapshot(value: unknown, context: ClaudeAuthorization): ClaudeBudgetSnapshot {
  if (value === undefined || value === null) return {status: "unknown", model: context.model};
  if (!record(value) || !record(value.allowance) || !record(value.model) || !record(value.session)) throw new Error("Invalid Claude budget response");
  const {allowance, model, session} = value;
  if (!timestamp(value.as_of) || !["day", "week"].includes(String(allowance.scope)) || !tokens(allowance.limit) || !tokens(allowance.remaining) || !timestamp(allowance.resets_at)
    || model.key !== context.model || !limit(model.limit) || !limit(model.remaining) || !(model.resets_at === null || timestamp(model.resets_at))
    || session.root_session_id !== context.sessionId || !limit(session.limit) || !tokens(session.used) || !limit(session.remaining)
    || (model.limit === null) !== (model.remaining === null) || (session.limit === null) !== (session.remaining === null)) throw new Error("Claude budget does not match this session");
  return {
    status: "known", model: context.model, asOf: value.as_of,
    limitTokens: model.limit, remainingTokens: model.remaining, resetAt: model.resets_at,
    sessionLimitTokens: session.limit, sessionUsedTokens: session.used, sessionRemainingTokens: session.remaining,
    accountLimitTokens: allowance.limit, accountRemainingTokens: allowance.remaining,
    accountScope: allowance.scope === "day" ? "day" : "week", accountResetAt: allowance.resets_at,
  };
}

async function read(response: Response): Promise<unknown> {
  // Device responses contain credentials. Never include their bodies in errors.
  if (!response.ok) {
    const reason = response.status === 409 ? "The session's model or capture contract conflicts with its backend binding"
      : response.status === 429 ? response.headers.get("x-should-retry") === "false"
        ? "The Claude allowance is exhausted; wait for its reset" : "Claude is busy; retry after the indicated delay"
      : response.status === 401 ? "Sign in to OmniRush to use Claude Code"
      : "Claude Code is unavailable for this account";
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    await response.body?.cancel();
    throw new ClaudeAccessError(response.status, `${reason} (${response.status})`, retryAfter, claudeResponseHeaders(response.headers));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Claude authorization response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 64 * 1024) throw new Error("Invalid Claude authorization response");
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Invalid Claude authorization response"); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The same session-bound device contract is used by the CLI and desktop. */
export class ClaudeDeviceAccess {
  private readonly grants = new Map<string, { grant: ClaudeGrant; refreshAt: number }>();
  private readonly pending = new Map<string, Promise<ClaudeGrant>>();
  private capability?: {owner: string; expiresAt: number; models: string[]; catalog: ClaudeCatalogEntry[]; reason: string | null};
  constructor(private readonly request: ClaudeDeviceRequest, private readonly client: string) {}

  async access(): Promise<ClaudeAccess> {
    const account = await read(await this.request("device/me"));
    if (!record(account) || typeof account.id !== "string" || !account.id) throw new Error("Sign in to OmniRush to use Claude Code");
    if (!this.capability || this.capability.owner !== account.id || Date.now() >= this.capability.expiresAt) {
      let models: string[] = [], catalog: ClaudeCatalogEntry[] = [], reason: string | null = "unavailable";
      try {
        const value = await read(await this.request("collect/capabilities"));
        const code = record(value) ? value.claude_code : null;
        if (record(code)) {
          // The catalog is shown to every account; `models` (what may run) only to allowed ones.
          catalog = claudeCatalog(code.catalog);
          const access = record(code.access) ? code.access : {};
          reason = typeof access.reason === "string" ? access.reason : code.enabled === true ? null : "not_allowed";
          // Claude Code is the provider's own pinned build (assets/claude-provider); the relay checks the client's
          // version. An enabled relay with an empty model list is not permission to run it.
          if (code.enabled === true && Array.isArray(code.models)) models = [...new Set(code.models.filter((model): model is string => typeof model === "string" && CLAUDE_MODEL_ID.test(model)))];
          if (code.enabled === true && !models.length) reason = "no_models";
        }
      } catch { /* Failed eligibility checks deny new sessions, but never hide saved evidence. */ }
      this.capability = {owner: account.id, expiresAt: Date.now() + 30_000, models, catalog, reason: models.length ? null : reason};
    }
    const {models, catalog, reason} = this.capability;
    return { owner: account.id, capabilities: models.length ? ["claude-code"] : [], models, catalog, reason };
  }

  async authorize(context: ClaudeAuthorization): Promise<ClaudeGrant> {
    const key = `${context.owner}/${context.sessionId}/${context.model}/${context.contractSha256}`;
    if (context.refresh) this.grants.delete(key);
    const cached = this.grants.get(key);
    if (cached && Date.now() < cached.refreshAt) return cached.grant;
    const existing = this.pending.get(key); if (existing) return existing;
    const pending = this.mint(context, key);
    this.pending.set(key, pending);
    try { return await pending; } finally { this.pending.delete(key); }
  }

  private async mint(context: ClaudeAuthorization, key: string): Promise<ClaudeGrant> {
    const requestedAt = Date.now();
    const value = await read(await this.request("device/claude-token", {
      method: "POST", body: JSON.stringify({
        session_id: context.sessionId,
        project_key: createHash("sha256").update(context.workspaceId).digest("hex").slice(0, 12),
        model: context.model, contract_hash: context.contractSha256, client: this.client,
      }),
    }, context.owner));
    if (!record(value) || !record(value.binding)) throw new ClaudeAccessError(409, "Claude authorization has no immutable session binding");
    const binding = value.binding;
    if (binding.session_id !== context.sessionId || binding.root_session_id !== context.sessionId || binding.model !== context.model || binding.contract_hash !== context.contractSha256
      || typeof binding.binding_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.binding_id) || binding.upstream_model !== context.model) {
      throw new ClaudeAccessError(409, "Claude authorization does not match this session's fixed model and capture contract");
    }
    if (typeof value.token !== "string" || !/^orc_[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.base_url !== "string"
      || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 900
      || typeof value.refresh_after !== "number" || !Number.isFinite(value.refresh_after) || value.refresh_after < 1 || value.refresh_after > value.expires_in) {
      throw new Error("Invalid short-lived Claude authorization");
    }
    const base = new URL(value.base_url);
    if (base.username || base.password || base.search || base.hash || !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) throw new Error("Invalid Claude relay address");
    const grant: ClaudeGrant = {
      owner: context.owner, sessionId: context.sessionId, model: context.model,
      bindingId: binding.binding_id, contractSha256: context.contractSha256, baseUrl: value.base_url, token: value.token,
      upstreamModel: binding.upstream_model, client: this.client,
      budget: budgetSnapshot(value.budget, context),
    };
    this.grants.set(key, { grant, refreshAt: requestedAt + Math.min(value.refresh_after, Math.max(0, value.expires_in - 5)) * 1000 });
    return grant;
  }

  async revoke(context: ClaudeAuthorization): Promise<void> {
    const prefix = `${context.owner}/${context.sessionId}/`;
    for (const key of this.grants.keys()) if (key.startsWith(prefix)) this.grants.delete(key);
    const response = await this.request("device/claude-token/revoke", { method: "POST", body: JSON.stringify({session_id: context.sessionId}) }, context.owner);
    if (!response.ok) await read(response);
    else await response.body?.cancel();
  }
}
