/**
 * Work mode's local routes, for the app (client scope). The account's credential stays in this server: the
 * app and the engine reach /omnirush/work/* only through here.
 *
 *   GET   /work/state                      { enabled, sources, message, autopilot, full_access, writes_paused, workspaceId }
 *   POST  /work/workspace                  makes the account's Work folder a workspace: { workspaceId, path }
 *   GET   /work/connectors                 GET /omnirush/work/connectors (also remembered for the upload)
 *   POST  /work/connectors/:id/start       { auth_url }
 *   POST  /work/connectors/:id/disconnect
 *   PATCH /work/connectors/:id             { sync_enabled }
 *   GET   /work/health[?source=]           the sources' health checks
 *   GET   /work/entities?q=&kind=&limit=&cursor=, GET /work/entities/:id   the context graph
 *   GET   /work/facts?entity_id=&status=, POST /work/facts, PATCH /work/facts/:id (retire: status)
 *   POST  /work/enable                     turns Work on for the account (the "Try Work" offer, while `available`)
 *   GET   /work/onboarding, POST /work/onboarding {company, domain?, size?, industry?, role?, tools}
 *   POST  /work/demo, DELETE /work/demo    seeds or removes the sample data
 *   POST  /work/org/invites {email}, POST /work/org/invites/accept {token}, GET /work/org/members
 *   PATCH /work/org, PATCH /work/org/me, DELETE /work/org/invites/:id, DELETE /work/org/members/:id,
 *   POST  /work/org/transfer {user_id}, POST /work/org/leave                   the organization (contract Addendum C1)
 *   GET   /work/org/insights?days=         the owner's team insights
 *   GET   /work/settings, PATCH /work/settings {autopilot?, full_access?, writes_paused?}   the action layer (Addendum F)
 *   GET   /work/actions?limit=, POST /work/actions/:id/undo                    the activity log and an action's undo
 *   GET   /work/imessage, POST /work/imessage {records}                        the Mac's iMessage records (macOS desktop)
 *   GET   /work/feed?source=&tz=&limit=    the Today home's feed
 *   POST  /work/connectors/:id/sync        a sync now (429 too_soon within a minute)
 *   GET   /work/chat-tools, POST /work/chat-tools/fix   whether the Work chats' engine has the hosted tools; fix re-reads the switch and re-syncs
 *   GET   /work/graph?focus=&depth=&kinds=&limit=, GET /work/timeline?focus=&cursor=&limit=   the graph explorer
 *   GET   /work/answer-style, PUT /work/answer-style { style: "brief"|"detailed" }   (local: the Work prompt's style)
 *
 * The engine's hosted MCP calls (POST /omnirush/work/mcp with the engine's token) are forwarded by server.ts.
 */
import { mkdir } from "node:fs/promises";

import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { rememberAnswerStyle, rememberedAnswerStyle, rememberedWorkActions, rememberedWorkConnectors, rememberedWorkSwitch, rememberWorkConnectors, rememberWorkSwitch, WORK_PRESET, WORK_SOURCE_ID, workHome } from "./work.js";

export type WorkBroker = {
  workRequest: (path: string, init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  accountId: () => Promise<string | null>;
  /** `maxAgeMs`: an answer older than that is asked again. */
  capabilities: (options?: { maxAgeMs?: number }) => Promise<unknown>;
};

export type WorkRouteDeps = {
  routes: Route[];
  config: ServerConfig;
  workDir: () => string;
  broker: () => WorkBroker | null;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  addWorkspace: (folderPath: string) => Promise<WorkspaceInfo>;
  /** The engine picks up a changed switch (the Work folder's server comes or goes). */
  applyEngine: () => Promise<unknown>;
  /** The engine lists the hosted server's tools again (a source was connected or disconnected). */
  refreshMcp?: () => void;
  /** Whether the Work folder's engine has the hosted server; `fix` re-reads the switch and re-syncs first. */
  chatTools?: (fix: boolean) => Promise<{ attached: boolean; reason: string | null }>;
};

const WORK_ERRORS: Record<string, string> = {
  work_disabled: "Work is turned off for your account.",
  unknown_connector: "This connector is not available.",
  connector_unavailable: "This connector is not available on this server right now.",
  not_connected: "Connect this source first.",
  work_not_available: "Work is not available for your account yet.",
  no_org: "Set up your company first.",
  too_many_invites: "Too many open invites. Wait for some to be accepted.",
  invite_email_mismatch: "This invite is for another e-mail address. Sign in with the address it was sent to.",
  unknown_invite: "This invite link is not valid. Ask for a new one.",
  invite_used: "This invite was already used. Ask for a new one.",
  invite_expired: "This invite has expired. Ask for a new one.",
  omnirush_account_required: "Sign in to omnirush.ai to use Work.",
  not_owner: "Only the organization's owner can do that.",
  cannot_remove_self: "You can't remove yourself. Leave the organization instead.",
  transfer_first: "Make someone else the owner before you leave.",
  too_soon: "A sync just ran. Try again in a minute.",
  reconnect_required: "Sign-in expired or access was revoked. Reconnect this source.",
  rate_limited: "The service asked us to slow down. Try again in a minute.",
  provider_error: "The service returned an error. Try again.",
  provider_unreachable: "The service could not be reached. Try again.",
  unreadable_answer: "omnirush.ai answered with something unexpected. Try again.",
  bad_arguments: "Something in that request wasn't accepted. Try again.",
  unknown_member: "That person is no longer in the organization.",
  unknown_action: "That action no longer exists.",
  not_undoable: "This action can't be undone.",
  cannot_undo: "This action can't be undone.",
  unknown_entity: "That item no longer exists.",
  unknown_fact: "That item no longer exists.",
  unknown_node: "That item no longer exists.",
  bad_import: "Those messages couldn't be read.",
  body_too_large: "That's too much at once. Try with less.",
  token_exchange_failed: "The service didn't accept the sign-in. Reconnect.",
  unsupported_work_path: "This needs a newer version of the app.",
};

const CONNECTOR = WORK_SOURCE_ID;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FACT_KINDS = ["decision", "preference", "policy", "fact", "contact_note"];
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;

/** The query a list route forwards: only the named parameters, each short. */
function forwardQuery(url: URL, names: string[]): string {
  const out = new URLSearchParams();
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value) out.set(name, value.slice(0, 200));
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}

/** The Work workspace among the server's: preset "work" in the Work folder. */
export function findWorkWorkspace(workspaces: WorkspaceInfo[]): WorkspaceInfo | null {
  return workspaces.find((workspace) => workspace.preset === WORK_PRESET && workspace.workspaceType !== "remote") ?? null;
}

async function passThrough(response: Response, jsonResponse: WorkRouteDeps["jsonResponse"]): Promise<{ status: number; data: unknown; response: Response }> {
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: "unreadable_answer" }; }
  // The app's client reads `code` and `message` (never a bare code); the server's own `detail` is kept as it came.
  if (response.status >= 400 && data && typeof data === "object" && !Array.isArray(data)) {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === "string") data = { ...data, code: detail, message: WORK_ERRORS[detail] ?? "That didn't work. Try again." };
    else if (Array.isArray(detail)) data = { ...data, code: "invalid_request", message: "That request wasn't accepted." };
  }
  return { status: response.status, data, response: jsonResponse(data, response.status) };
}

export function registerWorkRoutes(deps: WorkRouteDeps): void {
  const { routes, jsonResponse } = deps;
  // A work_disabled answer: the switch went off since the capabilities were cached (up to 5 min), so the next
  // /work/state asks again instead of showing Work until the cache expires.
  let switchStale = false;
  const pass = async (response: Response) => {
    const answer = await passThrough(response, jsonResponse);
    if ((answer.data as { code?: unknown } | null)?.code === "work_disabled") switchStale = true;
    return answer;
  };
  const signedOut = () => jsonResponse({ detail: "omnirush_account_required", code: "omnirush_account_required", message: WORK_ERRORS.omnirush_account_required }, 401);

  // The switch, read again from the server (at most as old as the capabilities cache), so the toggle follows it.
  addRoute(routes, "GET", "/work/state", "client", async () => {
    const found = deps.broker();
    if (found) {
      const capabilities = await found.capabilities(switchStale ? { maxAgeMs: 0 } : undefined).catch(() => null);
      if (capabilities) switchStale = false;
      if (rememberWorkSwitch(deps.workDir(), capabilities)) void deps.applyEngine().catch(() => undefined);
    }
    const setting = rememberedWorkSwitch(deps.workDir());
    return jsonResponse({ ...setting, ...rememberedWorkActions(deps.workDir()), workspaceId: findWorkWorkspace(deps.config.workspaces)?.id ?? null });
  });

  addRoute(routes, "POST", "/work/workspace", "client", async () => {
    if (!rememberedWorkSwitch(deps.workDir()).enabled) return jsonResponse({ detail: "work_disabled", code: "work_disabled", message: WORK_ERRORS.work_disabled }, 404);
    const found = deps.broker();
    const accountId = found ? await found.accountId() : null;
    const home = accountId ? workHome(deps.workDir(), accountId) : null;
    if (!home) return signedOut();
    await mkdir(home, { recursive: true, mode: 0o700 });
    const workspace = await deps.addWorkspace(home);
    return jsonResponse({ workspaceId: workspace.id, path: workspace.path });
  });

  addRoute(routes, "GET", "/work/connectors", "client", async () => {
    const found = deps.broker();
    if (!found) return signedOut();
    const answer = await pass(await found.workRequest("connectors", { method: "GET" }));
    if (answer.status === 200) {
      const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort().join(",");
      const before = ids(rememberedWorkConnectors(deps.workDir()));
      if (ids(rememberWorkConnectors(deps.workDir(), answer.data)) !== before) deps.refreshMcp?.();
    }
    return answer.response;
  });

  for (const action of ["start", "disconnect", "sync"] as const) {
    addRoute(routes, "POST", `/work/connectors/:id/${action}`, "client", async (ctx) => {
      if (!CONNECTOR.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_connector" }, 404);
      const found = deps.broker();
      if (!found) return signedOut();
      return (await pass(await found.workRequest(`connectors/${ctx.params.id}/${action}`, { method: "POST", body: "{}" }))).response;
    });
  }

  addRoute(routes, "PATCH", "/work/connectors/:id", "client", async (ctx) => {
    if (!CONNECTOR.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_connector" }, 404);
    const body = await deps.readJsonBody(ctx.request);
    if (typeof body.sync_enabled !== "boolean") return jsonResponse({ detail: "sync_enabled must be true or false" }, 400);
    const found = deps.broker();
    if (!found) return signedOut();
    return (await pass(await found.workRequest(`connectors/${ctx.params.id}`, { method: "PATCH", body: JSON.stringify({ sync_enabled: body.sync_enabled }) }))).response;
  });

  // Connector health, the context graph and saved knowledge (Work > Knowledge): forwarded as they are.
  const forward = async (path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => {
    const found = deps.broker();
    if (!found) return signedOut();
    return (await pass(await found.workRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }))).response;
  };
  const invalid = (detail: string) => jsonResponse({ detail, code: "invalid_request", message: detail }, 400);
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

  addRoute(routes, "GET", "/work/health", "client", async (ctx) => {
    const source = ctx.url.searchParams.get("source");
    if (source && !CONNECTOR.test(source)) return jsonResponse({ detail: "unknown_connector" }, 404);
    return forward(`health${forwardQuery(ctx.url, ["source"])}`, "GET");
  });

  addRoute(routes, "GET", "/work/entities", "client", async (ctx) => forward(`entities${forwardQuery(ctx.url, ["q", "kind", "limit", "cursor"])}`, "GET"));

  addRoute(routes, "GET", "/work/entities/:id", "client", async (ctx) => {
    if (!RECORD_ID.test(ctx.params.id ?? "")) return jsonResponse({ detail: "not_found" }, 404);
    return forward(`entities/${ctx.params.id}`, "GET");
  });

  addRoute(routes, "GET", "/work/graph", "client", async (ctx) => forward(`graph${forwardQuery(ctx.url, ["focus", "depth", "kinds", "limit"])}`, "GET"));
  addRoute(routes, "GET", "/work/timeline", "client", async (ctx) => forward(`timeline${forwardQuery(ctx.url, ["focus", "cursor", "limit"])}`, "GET"));

  // The answer style lives with the app (the engine reads it when it builds a Work chat's prompt).
  addRoute(routes, "GET", "/work/answer-style", "client", async () => jsonResponse({ style: rememberedAnswerStyle(deps.workDir()) }));
  addRoute(routes, "PUT", "/work/answer-style", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request);
    if (body.style !== "brief" && body.style !== "detailed") return invalid("style must be brief or detailed");
    rememberAnswerStyle(deps.workDir(), body.style);
    void deps.applyEngine().catch(() => undefined);
    return jsonResponse({ style: body.style });
  });

  addRoute(routes, "GET", "/work/facts", "client", async (ctx) => forward(`facts${forwardQuery(ctx.url, ["entity_id", "status"])}`, "GET"));

  addRoute(routes, "POST", "/work/facts", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request);
    const fact = text(body.text);
    if (!fact || fact.length > 4000) return invalid("A fact needs text (at most 4000 characters).");
    if (typeof body.kind !== "string" || !FACT_KINDS.includes(body.kind)) return invalid(`kind must be one of ${FACT_KINDS.join(", ")}`);
    const entity = body.entity_id === undefined || body.entity_id === null ? null : String(body.entity_id);
    if (entity !== null && !RECORD_ID.test(entity)) return invalid("entity_id is not valid");
    return forward("facts", "POST", { text: fact, kind: body.kind, ...(entity ? { entity_id: entity } : {}) });
  });

  addRoute(routes, "PATCH", "/work/facts/:id", "client", async (ctx) => {
    if (!RECORD_ID.test(ctx.params.id ?? "")) return jsonResponse({ detail: "not_found" }, 404);
    const body = await deps.readJsonBody(ctx.request);
    const patch: Record<string, unknown> = {};
    if (body.text !== undefined) {
      const fact = text(body.text);
      if (!fact || fact.length > 4000) return invalid("A fact needs text (at most 4000 characters).");
      patch.text = fact;
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "retired") return invalid("status must be active or retired");
      patch.status = body.status;
    }
    if (Object.keys(patch).length === 0) return invalid("Nothing to change.");
    return forward(`facts/${ctx.params.id}`, "PATCH", patch);
  });

  // The tryout: Work turns on for this account; the next /work/state asks the server again instead of its cached switch.
  addRoute(routes, "POST", "/work/enable", "client", async () => {
    const answer = await forward("enable", "POST", {});
    if (answer.ok) switchStale = true;
    return answer;
  });

  // Company setup: the profile, sample data and teammates.
  addRoute(routes, "GET", "/work/onboarding", "client", async () => forward("onboarding", "GET"));

  /** The company fields of a body, checked (an error's text, or what to forward); `tools` only when sent unless `toolsAlways`. */
  const orgFields = (body: Record<string, unknown>, fields: readonly string[], toolsAlways: boolean): string | Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const domain = text(body.domain)?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? null;
    if (domain) {
      if (!DOMAIN.test(domain)) return "The domain is not valid (like example.com).";
      out.domain = domain;
    }
    for (const field of fields) {
      const value = text(body[field]);
      if (value && value.length > 100) return `${field} is too long (at most 100 characters).`;
      if (value) out[field] = value;
    }
    if (toolsAlways || body.tools !== undefined) {
      const tools = Array.isArray(body.tools) ? body.tools : [];
      if (tools.length > 32 || !tools.every((id) => typeof id === "string" && CONNECTOR.test(id))) return "tools must be connector ids";
      out.tools = [...new Set(tools)];
    }
    return out;
  };

  addRoute(routes, "POST", "/work/onboarding", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request);
    const company = text(body.company);
    if (!company || company.length > 200) return invalid("A company name is needed (at most 200 characters).");
    const fields = orgFields(body, ["size", "industry", "role"], true);
    if (typeof fields === "string") return invalid(fields);
    return forward("onboarding", "POST", { company, ...fields });
  });

  // The organization (Settings > Work > Organization): the owner edits it, every member their own role and tools.
  addRoute(routes, "PATCH", "/work/org", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request);
    const name = body.name === undefined ? null : text(body.name);
    if (body.name !== undefined && (!name || name.length > 200)) return invalid("A company name is needed (at most 200 characters).");
    const fields = orgFields(body, ["size", "industry"], false);
    if (typeof fields === "string") return invalid(fields);
    return forward("org", "PATCH", { ...(name ? { name } : {}), ...fields });
  });

  addRoute(routes, "PATCH", "/work/org/me", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request);
    const fields = orgFields({ job_role: body.job_role, tools: body.tools }, ["job_role"], false);
    if (typeof fields === "string") return invalid(fields);
    // An emptied role is sent as "" so it can be cleared.
    if (body.job_role !== undefined && !("job_role" in fields)) fields.job_role = "";
    return forward("org/me", "PATCH", fields);
  });

  addRoute(routes, "DELETE", "/work/org/invites/:id", "client", async (ctx) => {
    if (!RECORD_ID.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_invite", code: "unknown_invite", message: WORK_ERRORS.unknown_invite }, 404);
    return forward(`org/invites/${ctx.params.id}`, "DELETE");
  });

  addRoute(routes, "DELETE", "/work/org/members/:id", "client", async (ctx) => {
    if (!RECORD_ID.test(ctx.params.id ?? "")) return jsonResponse({ detail: "not_found" }, 404);
    return forward(`org/members/${ctx.params.id}`, "DELETE");
  });

  addRoute(routes, "POST", "/work/org/transfer", "client", async (ctx) => {
    const userId = text((await deps.readJsonBody(ctx.request)).user_id);
    if (!userId || !RECORD_ID.test(userId)) return invalid("user_id is not valid");
    return forward("org/transfer", "POST", { user_id: userId });
  });

  addRoute(routes, "POST", "/work/org/leave", "client", async () => forward("org/leave", "POST", {}));

  // The Today home: the server's feed for the person's local day.
  addRoute(routes, "GET", "/work/feed", "client", async (ctx) => {
    const source = ctx.url.searchParams.get("source");
    if (source && !CONNECTOR.test(source)) return jsonResponse({ detail: "unknown_connector" }, 404);
    return forward(`feed${forwardQuery(ctx.url, ["source", "tz", "limit"])}`, "GET");
  });

  // A Work chat without the hosted tools: the banner asks here, its Fix posts.
  addRoute(routes, "GET", "/work/chat-tools", "client", async () => jsonResponse(deps.chatTools ? await deps.chatTools(false) : { attached: true, reason: null }));
  addRoute(routes, "POST", "/work/chat-tools/fix", "client", async () => {
    switchStale = true;
    return jsonResponse(deps.chatTools ? await deps.chatTools(true) : { attached: true, reason: null });
  });

  addRoute(routes, "POST", "/work/demo", "client", async () => forward("demo", "POST", {}));
  addRoute(routes, "DELETE", "/work/demo", "client", async () => forward("demo", "DELETE"));

  addRoute(routes, "POST", "/work/org/invites", "client", async (ctx) => {
    const email = text((await deps.readJsonBody(ctx.request)).email);
    if (!email || email.length > 254 || !EMAIL.test(email)) return invalid("Enter an e-mail address.");
    return forward("org/invites", "POST", { email });
  });

  // Joining a teammate's company: the pasted link (or its token) as it came; the server reads the token from it.
  addRoute(routes, "POST", "/work/org/invites/accept", "client", async (ctx) => {
    const token = text((await deps.readJsonBody(ctx.request)).token);
    if (!token || token.length > 2048) return invalid("Paste the invite link.");
    const answer = await forward("org/invites/accept", "POST", { token });
    if (answer.ok) switchStale = true;
    return answer;
  });

  addRoute(routes, "GET", "/work/org/members", "client", async () => forward("org/members", "GET"));
  addRoute(routes, "GET", "/work/org/insights", "client", async (ctx) => forward(`org/insights${forwardQuery(ctx.url, ["days"])}`, "GET"));

  // The action layer: autopilot, full access, the pause switch, and the log of writes with their undo.
  addRoute(routes, "GET", "/work/settings", "client", async () => forward("settings", "GET"));
  addRoute(routes, "PATCH", "/work/settings", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request);
    const patch: Record<string, boolean> = {};
    for (const key of ["autopilot", "full_access", "writes_paused"]) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return invalid(`${key} must be true or false`);
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return invalid("Nothing to change.");
    const answer = await forward("settings", "PATCH", patch);
    // The switches ride in the capabilities' work block (GET /work/state): read it fresh next time.
    if (answer.ok) switchStale = true;
    return answer;
  });
  addRoute(routes, "GET", "/work/actions", "client", async (ctx) => forward(`actions${forwardQuery(ctx.url, ["limit"])}`, "GET"));
  addRoute(routes, "POST", "/work/actions/:id/undo", "client", async (ctx) => {
    if (!RECORD_ID.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_action", code: "unknown_action", message: WORK_ERRORS.unknown_action }, 404);
    return forward(`actions/${ctx.params.id}/undo`, "POST", {});
  });

  // iMessage (macOS desktop): the records the desktop read from the Mac's Messages database, and how many the server has.
  addRoute(routes, "GET", "/work/imessage", "client", async () => forward("imessage", "GET"));
  addRoute(routes, "POST", "/work/imessage", "client", async (ctx) => {
    const records = (await deps.readJsonBody(ctx.request)).records;
    if (!Array.isArray(records)) return invalid("records must be a list");
    return forward("imessage", "POST", { records });
  });
}

/**
 * The engine's hosted MCP call, forwarded as it is (streamable HTTP, JSON answers) with the account's
 * credential: POST only (the hosted server answers GET and DELETE with 405 anyway), the MCP headers kept.
 */
export async function forwardWorkMcp(request: Request, broker: WorkBroker): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const headers: Record<string, string> = { Accept: request.headers.get("accept") ?? "application/json, text/event-stream" };
  const version = request.headers.get("mcp-protocol-version");
  if (version) headers["mcp-protocol-version"] = version;
  const upstream = await broker.workRequest("mcp", { method: "POST", body: await request.text(), headers, signal: request.signal });
  const out = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
  const session = upstream.headers.get("mcp-session-id");
  if (session) out.set("mcp-session-id", session);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
