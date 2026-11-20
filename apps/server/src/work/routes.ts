/**
 * Work mode's local routes, for the app (client scope). The account's credential stays in this server: the
 * app and the engine reach /omnirush/work/* only through here.
 *
 *   GET   /work/state[?account=1]          { enabled, sources, message, autopilot, full_access, writes_paused, workspaceId, account? }
 *                                          (account: "<server origin> <account id>", for the desktop's chat sync)
 *   POST  /work/workspace                  makes the account's Work folder a workspace: { workspaceId, path }
 *   GET   /work/connectors                 GET /omnirush/work/connectors (also remembered for the upload)
 *   POST  /work/connectors/:id/start       { auth_url }
 *   POST  /work/connectors/:id/connect     { preset, host?, port?, security?, url?, username?, password?, api_key? } -> { ok, account }
 *                                          (imap and caldav, and the pasted-key sources: the server tries the login or key, then saves and syncs)
 *   POST  /work/connectors/:id/hook        { url }: a new inbound URL for Zapier, Make or n8n (hook, hook_org), shown once
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
 *   GET   /work/whatsapp-local, POST /work/whatsapp-local {records}            the WhatsApp Mac app's chat-days (macOS desktop)
 *   GET   /work/telegram, POST /work/telegram {records}                        Telegram chat-days from the user's own login (desktop)
 *   GET   /work/feed?source=&tz=&limit=    the Today home's feed
 *   POST  /work/connectors/:id/sync        a sync now (429 too_soon within a minute)
 *   GET   /work/chat-tools, POST /work/chat-tools/fix   whether the Work chats' engine has the hosted tools; fix re-reads the switch and re-syncs
 *   GET   /work/graph?focus=&depth=&kinds=&limit=, GET /work/timeline?focus=&cursor=&limit=   the graph explorer
 *   GET   /work/answer-style, PUT /work/answer-style { style: "brief"|"detailed" }   (local: the Work prompt's style)
 *   GET   /work/search?q=&channels=&from=&to=&mode=&limit=   every channel at once (contract D1)
 *   GET   /work/coverage                   the channel groups Ask sees (D6)
 *   GET   /work/deals?filter=&owner=, GET /work/deals/:id    deals with last touch and risk (D3)
 *   GET   /work/imports, POST /work/imports (multipart: file, kind whatsapp|telegram)   chat exports (D5)
 *   POST  /work/meetings {title?, started_at?}, GET /work/meetings/:id, PATCH /work/meetings/:id {title?, ended_at?}
 *   POST  /work/meetings/:id/audio?speaker=me|them&part=&offset_ms=   one audio part (raw 16 kHz mono WAV, <= 2 MiB), transcribed
 *                                                                     while it waits (meetings, contract D4)
 *
 * The engine's hosted MCP calls (POST /omnirush/work/mcp with the engine's token) are forwarded by server.ts.
 */
import { mkdir } from "node:fs/promises";

import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { rememberAnswerStyle, rememberedAnswerStyle, rememberedWorkActions, rememberedWorkConnectors, rememberedWorkSwitch, rememberWorkConnectors, rememberWorkSwitch, WORK_PRESET, WORK_SOURCE_ID, workHome } from "./work.js";

export type WorkBroker = {
  workRequest: (path: string, init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: string | FormData | Uint8Array<ArrayBuffer>; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  accountId: () => Promise<string | null>;
  /** The account's server (gateway origin), so a key per server and account can be made. */
  readonly serverOrigin?: string | null;
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
  unknown_deal: "That deal no longer exists.",
  too_many_imports: "That's 20 imports today. Try again tomorrow.",
  parse_failed: "That file couldn't be read. Export the chat again and pick the .txt or .zip.",
  empty_import: "No messages were found in that file.",
  unsupported_kind: "That kind of file can't be imported yet.",
  file_too_large: "That file is over 50 MB.",
  unsupported_work_path: "This needs a newer version of the app.",
  not_found: "That item no longer exists.",
  meetings_off: "Meeting notes are not available right now.",
  notice_required: "Your company asks you to tell everyone before you record.",
  part_in_progress: "This part is still being transcribed.",
  meeting_budget: "You have used today's meeting minutes. Notes still work.",
  transcribe_busy: "Transcript is catching up.",
  transcribe_unavailable: "Transcript is catching up.",
  audio_too_large: "That audio part is too large.",
  bad_audio: "That audio couldn't be read.",
  login_failed: "The server said the password is wrong. Most providers need an app password here.",
  server_unreachable: "Could not reach the server. Check its address and port.",
  address_refused: "That server address is not allowed. Use the provider's public address.",
  tls_failed: "The server's secure connection could not be checked.",
  not_caldav: "No calendar server answered at that address. Check the URL.",
  no_calendars: "That account has no calendars with events.",
  not_calendar: "That link is not a calendar. Copy the .ics link again.",
  too_many_tries: "Too many tries. Wait a few minutes and try again.",
  key_refused: "The service did not accept that key. Copy it again, all of it.",
  key_not_restricted: "Use a restricted key (it starts with rk_), not your secret key.",
  missing_permission: "That key cannot read everything needed. Give it Read on Customers, Invoices, Charges and Events.",
};

const CONNECTOR = WORK_SOURCE_ID;
/** The server refuses a chat export over 50 MB (contract D5). */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
/** One meeting audio part: 28 s of 16 kHz mono 16-bit is under 1 MiB; the plan's cap is 2 MiB. */
const MEETING_PART_MAX_BYTES = 2 * 1024 * 1024;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FACT_KINDS = ["decision", "preference", "policy", "fact", "contact_note"];
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;

/** The query a list route forwards: only the named parameters, each short. */
function forwardQuery(url: URL, names: string[], max = 200): string {
  const out = new URLSearchParams();
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value) out.set(name, value.slice(0, max));
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
  addRoute(routes, "GET", "/work/state", "client", async (ctx) => {
    const found = deps.broker();
    if (found) {
      const capabilities = await found.capabilities(switchStale ? { maxAgeMs: 0 } : undefined).catch(() => null);
      if (capabilities) switchStale = false;
      if (rememberWorkSwitch(deps.workDir(), capabilities)) void deps.applyEngine().catch(() => undefined);
    }
    const setting = rememberedWorkSwitch(deps.workDir());
    // Only asked for by the desktop's chat sync: learning the account can take a network call.
    const accountId = ctx.url.searchParams.has("account") && setting.enabled && found ? await found.accountId() : null;
    const account = accountId ? { account: `${found?.serverOrigin ?? ""} ${accountId}`.trim() } : {};
    return jsonResponse({ ...setting, ...rememberedWorkActions(deps.workDir()), workspaceId: findWorkWorkspace(deps.config.workspaces)?.id ?? null, ...account });
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

  // hook: a new inbound URL (Zapier, Make, n8n), passed to the app once and not kept here.
  for (const action of ["start", "disconnect", "sync", "hook"] as const) {
    addRoute(routes, "POST", `/work/connectors/:id/${action}`, "client", async (ctx) => {
      if (!CONNECTOR.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_connector" }, 404);
      const found = deps.broker();
      if (!found) return signedOut();
      return (await pass(await found.workRequest(`connectors/${ctx.params.id}/${action}`, { method: "POST", body: "{}" }))).response;
    });
  }

  // A connector signed in to with a server and a password (imap, caldav) or a pasted key: only the form's own fields go on.
  addRoute(routes, "POST", "/work/connectors/:id/connect", "client", async (ctx) => {
    if (!CONNECTOR.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_connector" }, 404);
    const body = await deps.readJsonBody(ctx.request);
    const form: Record<string, string | number> = {};
    for (const key of ["preset", "host", "security", "url", "username", "password", "api_key"]) {
      const value = body[key];
      if (typeof value === "string" && value) form[key] = value;
    }
    if (typeof body.port === "number" && Number.isInteger(body.port)) form.port = body.port;
    const found = deps.broker();
    if (!found) return signedOut();
    return (await pass(await found.workRequest(`connectors/${ctx.params.id}/connect`, { method: "POST", body: JSON.stringify(form) }))).response;
  });

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

  // Search, coverage and deals (contract D1, D3, D6): forwarded as they are. A search query may be 500 characters.
  addRoute(routes, "GET", "/work/search", "client", async (ctx) => forward(`search${forwardQuery(ctx.url, ["q", "channels", "from", "to", "mode", "limit"], 500)}`, "GET"));
  addRoute(routes, "GET", "/work/coverage", "client", async () => forward("coverage", "GET"));
  addRoute(routes, "GET", "/work/deals", "client", async (ctx) => forward(`deals${forwardQuery(ctx.url, ["filter", "owner"])}`, "GET"));
  addRoute(routes, "GET", "/work/deals/:id", "client", async (ctx) => {
    if (!RECORD_ID.test(ctx.params.id ?? "")) return jsonResponse({ detail: "unknown_deal", code: "unknown_deal", message: WORK_ERRORS.unknown_deal }, 404);
    return forward(`deals/${ctx.params.id}`, "GET");
  });

  // Chat exports (WhatsApp `.txt`/`.zip`, Telegram `result.json`): the file goes on as it came, with its kind.
  addRoute(routes, "GET", "/work/imports", "client", async () => forward("imports", "GET"));
  addRoute(routes, "POST", "/work/imports", "client", async (ctx) => {
    const form = await ctx.request.formData().catch(() => null);
    const file = form?.get("file");
    const kind = form?.get("kind");
    if (kind !== "whatsapp" && kind !== "telegram") return invalid("kind must be whatsapp or telegram");
    if (!file || typeof file === "string") return invalid("Pick a file to import.");
    if (file.size > IMPORT_MAX_BYTES) return jsonResponse({ detail: "file_too_large", code: "file_too_large", message: WORK_ERRORS.file_too_large }, 413);
    const found = deps.broker();
    if (!found) return signedOut();
    const body = new FormData();
    body.set("kind", kind);
    body.set("file", file, file.name || "chat.txt");
    return (await pass(await found.workRequest("imports", { method: "POST", body, signal: AbortSignal.timeout(300_000) }))).response;
  });

  // Meetings (contract D4): the meeting, its end, and its audio parts. A part is raw WAV bytes and waits on the server's
  // transcriber (up to about 2 min), so it gets a longer timeout than the default minute.
  const meetingFields = (body: Record<string, unknown>, timeField: "started_at" | "ended_at"): string | Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const title = text(body.title);
      if (!title || title.length > 300) return "A title needs text (at most 300 characters).";
      out.title = title;
    }
    if (body[timeField] !== undefined) {
      if (typeof body[timeField] !== "string" || !ISO_TIME.test(body[timeField])) return `${timeField} must be an ISO time`;
      out[timeField] = body[timeField];
    }
    return out;
  };
  addRoute(routes, "POST", "/work/meetings", "client", async (ctx) => {
    const fields = meetingFields(await deps.readJsonBody(ctx.request), "started_at");
    return typeof fields === "string" ? invalid(fields) : forward("meetings", "POST", fields);
  });
  const meetingId = (id: string | undefined) => (RECORD_ID.test(id ?? "") ? id : null);
  const notFound = () => jsonResponse({ detail: "not_found", code: "not_found", message: WORK_ERRORS.not_found }, 404);
  addRoute(routes, "GET", "/work/meetings/:id", "client", async (ctx) => {
    const id = meetingId(ctx.params.id);
    return id ? forward(`meetings/${id}`, "GET") : notFound();
  });
  addRoute(routes, "PATCH", "/work/meetings/:id", "client", async (ctx) => {
    const id = meetingId(ctx.params.id);
    if (!id) return notFound();
    const fields = meetingFields(await deps.readJsonBody(ctx.request), "ended_at");
    if (typeof fields === "string") return invalid(fields);
    if (Object.keys(fields).length === 0) return invalid("Nothing to change.");
    return forward(`meetings/${id}`, "PATCH", fields);
  });
  addRoute(routes, "POST", "/work/meetings/:id/audio", "client", async (ctx) => {
    const id = meetingId(ctx.params.id);
    if (!id) return notFound();
    const speaker = ctx.url.searchParams.get("speaker");
    const part = Number(ctx.url.searchParams.get("part") ?? "x");
    const offset = Number(ctx.url.searchParams.get("offset_ms") ?? "x");
    if (speaker !== "me" && speaker !== "them") return invalid("speaker must be me or them");
    if (!Number.isInteger(part) || part < 0 || part > 1_000_000) return invalid("part must be a whole number from 0");
    if (!Number.isInteger(offset) || offset < 0 || offset > 2_000_000_000) return invalid("offset_ms must be a whole number from 0");
    const tooLarge = () => jsonResponse({ detail: "audio_too_large", code: "audio_too_large", message: WORK_ERRORS.audio_too_large }, 413);
    if (Number(ctx.request.headers.get("content-length") ?? 0) > MEETING_PART_MAX_BYTES) return tooLarge();
    const bytes = new Uint8Array(await ctx.request.arrayBuffer());
    if (bytes.length > MEETING_PART_MAX_BYTES) return tooLarge();
    if (bytes.length < 44) return invalid("The audio part is empty.");
    const found = deps.broker();
    if (!found) return signedOut();
    const path = `meetings/${id}/audio?speaker=${speaker}&part=${part}&offset_ms=${offset}`;
    return (await pass(await found.workRequest(path, { method: "POST", body: bytes, headers: { "Content-Type": "audio/wav" }, signal: AbortSignal.timeout(150_000) }))).response;
  });

  // iMessage (macOS desktop): the records the desktop read from the Mac's Messages database, and how many the server has.
  addRoute(routes, "GET", "/work/imessage", "client", async () => forward("imessage", "GET"));
  addRoute(routes, "POST", "/work/imessage", "client", async (ctx) => {
    const records = (await deps.readJsonBody(ctx.request)).records;
    if (!Array.isArray(records)) return invalid("records must be a list");
    return forward("imessage", "POST", { records });
  });
  // WhatsApp (macOS desktop): the chat-days the desktop read from the WhatsApp Mac app's database.
  addRoute(routes, "GET", "/work/whatsapp-local", "client", async () => forward("whatsapp-local", "GET"));
  addRoute(routes, "POST", "/work/whatsapp-local", "client", async (ctx) => {
    const records = (await deps.readJsonBody(ctx.request)).records;
    if (!Array.isArray(records)) return invalid("records must be a list");
    return forward("whatsapp-local", "POST", { records });
  });
  // Telegram (desktop): the chat-days the desktop read with the user's own Telegram login (the login stays on the device).
  addRoute(routes, "GET", "/work/telegram", "client", async () => forward("telegram", "GET"));
  addRoute(routes, "POST", "/work/telegram", "client", async (ctx) => {
    const records = (await deps.readJsonBody(ctx.request)).records;
    if (!Array.isArray(records)) return invalid("records must be a list");
    return forward("telegram", "POST", { records });
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
