/**
 * Cloud tasks' local routes (backend docs/work-cloud.md), for the app (client scope): forwarded to
 * /omnirush/work/cloud/* and /omnirush/work/org/cloud* with the account's credential, only the contract's fields.
 * The server answers 403 cloud_off unless staff, the company and the global switch have Cloud tasks on, so nothing
 * here changes anything for anyone else.
 *
 *   GET    /work/cloud/tasks?q=&filter=&limit=&cursor=, POST /work/cloud/tasks
 *   GET    /work/cloud/tasks/:id, PATCH /work/cloud/tasks/:id, DELETE /work/cloud/tasks/:id, POST /work/cloud/tasks/:id/run
 *   GET    /work/cloud/runs?task_id=&status=&limit=&cursor=, GET /work/cloud/runs/:id
 *   GET    /work/cloud/runs/:id/steps?from=&limit=, GET /work/cloud/runs/:id/steps/:n/shot (an image)
 *   GET    /work/cloud/runs/:id/files/:name   a run's file, always as a download
 *   POST   /work/cloud/runs/:id/cancel|takeover|approve|deny, /handback {note?}, /input {code} (never logged or kept)
 *   POST   /work/cloud/runs/:id/live {mode: view|control} -> {url, expires_at}: only a live page on the account's server
 *   GET    /work/org/cloud, PATCH /work/org/cloud {enabled?, hosts?, creators?, notify?, retention_days?}
 *   GET    /work/org/cloud/signins, POST /work/org/cloud/signins, PUT|DELETE /work/org/cloud/signins/:id (values write only)
 */
import { addRoute } from "../routes/registry.js";
import type { WorkRouteDeps } from "./routes.js";

/** routes.ts's answer reader: the server's JSON as the app reads it (`code`, `message`, `details`). */
type PassThrough = (response: Response, jsonResponse: WorkRouteDeps["jsonResponse"]) => Promise<{ status: number; data: unknown; response: Response }>;

/** Cloud tasks' codes in words (the app words them again in the person's language). */
export const CLOUD_ERRORS: Record<string, string> = {
  cloud_off: "Cloud tasks are turned off for your company.",
  not_allowed: "Only the task's owner or a company admin can do that.",
  vault_off: "Saved sign-ins are not turned on for your company.",
  not_found: "That task or run no longer exists.",
  run_open: "This task is already running.",
  limit_month: "Your company has used this month's cloud task time.",
  profile_busy: "Another run is using this sign-in. This one starts when it ends.",
  host_not_allowed: "That site is not on your company's list. An admin can add it in Organization.",
  bad_schedule: "That schedule can't be used. A company can have up to 20 schedules.",
  needs_enterprise: "Cloud tasks are for enterprise companies only.",
  live_unavailable: "The live view is not available right now.",
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** A run's file as the worker names it: no path, no control characters. */
const FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,200}$/;
const OUTPUTS = ["invoice", "order", "ticket", "row", "files", "answer"];
const EVERY = ["once", "day", "week", "month"];
const FILTERS = ["all", "scheduled", "needs_you", "failed"];
const STATUSES = ["queued", "starting", "running", "waiting", "done", "failed", "stopped", "limit", "timed_out"];
/** A company site: a host, or `*.` and a domain. */
export const CLOUD_HOST = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IMAGE = /^image\/(?:webp|png|jpeg)(?:;|$)/i;
const FILE_TYPES = /^(?:application\/pdf|text\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|image\/png|image\/jpeg)(?:;|$)/i;

type Fields = Record<string, unknown>;
type Checked = { ok: true; value: Fields } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const words = (value: unknown, max: number) => (typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null);

/** An https start page with a host and no user name or password. */
export function cloudStartUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null;
}

/** A schedule the server may take: null (run when asked), or every once|day|week|month at HH:MM in a zone. */
export function cloudSchedule(value: unknown): { ok: true; value: Fields | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value) || typeof value.every !== "string" || !EVERY.includes(value.every)) return { ok: false };
  if (typeof value.at !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.at)) return { ok: false };
  const tz = words(value.tz, 64);
  if (!tz || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return { ok: false };
  const out: Fields = { every: value.every, at: value.at, tz };
  if (value.every === "week") {
    if (!Number.isInteger(value.weekday) || Number(value.weekday) < 0 || Number(value.weekday) > 6) return { ok: false };
    out.weekday = value.weekday;
  }
  if (value.every === "month") {
    if (!Number.isInteger(value.day) || Number(value.day) < 1 || Number(value.day) > 28) return { ok: false };
    out.day = value.day;
  }
  return { ok: true, value: out };
}

/** A task's fields, checked: every one on create (`full`), any subset on a change; unknown fields stay here. */
export function cloudTaskFields(body: Fields, full: boolean): Checked {
  const out: Fields = {};
  const need = (key: string) => full || body[key] !== undefined;
  if (need("title")) {
    const title = words(body.title, 200);
    if (!title) return { ok: false, error: "A title is needed (at most 200 characters)." };
    out.title = title;
  }
  if (need("instructions")) {
    const text = words(body.instructions, 4000);
    if (!text) return { ok: false, error: "Say what to do (at most 4,000 characters)." };
    out.instructions = text;
  }
  if (need("start_url")) {
    const url = cloudStartUrl(body.start_url);
    if (!url) return { ok: false, error: "Use an https:// start page." };
    out.start_url = url;
  }
  if (need("signin_mode")) {
    if (body.signin_mode !== "saved" && body.signin_mode !== "person" && body.signin_mode !== "none") return { ok: false, error: "signin_mode must be saved, person or none" };
    out.signin_mode = body.signin_mode;
  }
  if (body.signin_id !== undefined) {
    if (body.signin_id !== null && (typeof body.signin_id !== "string" || !ID.test(body.signin_id))) return { ok: false, error: "signin_id is not valid" };
    out.signin_id = body.signin_id;
  }
  if (out.signin_mode === "saved" && !out.signin_id) return { ok: false, error: "Pick a saved sign-in." };
  if (need("output")) {
    if (!isRecord(body.output) || typeof body.output.kind !== "string" || !OUTPUTS.includes(body.output.kind)) return { ok: false, error: `output.kind must be one of ${OUTPUTS.join(", ")}` };
    out.output = { kind: body.output.kind };
  }
  if (need("write_mode")) {
    if (body.write_mode !== "read" && body.write_mode !== "ask") return { ok: false, error: "write_mode must be read or ask" };
    out.write_mode = body.write_mode;
  }
  if (need("schedule")) {
    const schedule = cloudSchedule(body.schedule === undefined ? null : body.schedule);
    if (!schedule.ok) return { ok: false, error: "That schedule is not valid." };
    out.schedule = schedule.value;
  }
  if (!full && body.paused !== undefined) {
    if (typeof body.paused !== "boolean") return { ok: false, error: "paused must be true or false" };
    out.paused = body.paused;
  }
  if (!full && body.owner !== undefined) {
    if (body.owner !== "me") return { ok: false, error: "owner must be me" };
    out.owner = "me";
  }
  if (!full && !Object.keys(out).length) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
}

/** The company's settings change: any of the switch, its sites, who creates, who hears about waiting runs, how long
 *  screenshots stay. */
export function orgCloudFields(body: Fields): Checked {
  const out: Fields = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
    out.enabled = body.enabled;
  }
  if (body.hosts !== undefined) {
    const hosts = Array.isArray(body.hosts) ? body.hosts.map((host) => (typeof host === "string" ? host.trim().toLowerCase() : "")) : null;
    if (!hosts || hosts.length > 20 || !hosts.every((host) => CLOUD_HOST.test(host))) return { ok: false, error: "hosts must be up to 20 sites like portal.example.com or *.example.com" };
    out.hosts = [...new Set(hosts)];
  }
  if (body.creators !== undefined) {
    if (body.creators !== "admins" && body.creators !== "everyone") return { ok: false, error: "creators must be admins or everyone" };
    out.creators = body.creators;
  }
  if (body.notify !== undefined) {
    if (body.notify !== "owner" && body.notify !== "owner_and_admins") return { ok: false, error: "notify must be owner or owner_and_admins" };
    out.notify = body.notify;
  }
  if (body.retention_days !== undefined) {
    if (body.retention_days !== 7 && body.retention_days !== 30 && body.retention_days !== 90) return { ok: false, error: "retention_days must be 7, 30 or 90" };
    out.retention_days = body.retention_days;
  }
  if (!Object.keys(out).length) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
}

/** A saved sign-in: label, sites, user name and password on add (`full`); any of them on a replace. */
export function signinFields(body: Fields, full: boolean): Checked {
  const out: Fields = {};
  const need = (key: string) => full || body[key] !== undefined;
  if (need("label")) {
    const label = words(body.label, 100);
    if (!label) return { ok: false, error: "A name is needed (at most 100 characters)." };
    out.label = label;
  }
  if (need("hosts")) {
    const hosts = Array.isArray(body.hosts) ? body.hosts.map((host) => (typeof host === "string" ? host.trim().toLowerCase() : "")) : null;
    if (!hosts || !hosts.length || hosts.length > 20 || !hosts.every((host) => CLOUD_HOST.test(host))) return { ok: false, error: "Add the site it signs in to, like portal.example.com." };
    out.hosts = [...new Set(hosts)];
  }
  // Values as typed (a password may start or end with a space); only their size is checked here.
  if (need("username")) {
    if (typeof body.username !== "string" || !body.username.trim() || body.username.length > 254) return { ok: false, error: "A user name is needed." };
    out.username = body.username;
  }
  if (need("password")) {
    if (typeof body.password !== "string" || !body.password.length || body.password.length > 1024) return { ok: false, error: "A password is needed." };
    out.password = body.password;
  }
  if (body.use !== undefined) {
    if (body.use !== "admins" && body.use !== "everyone") return { ok: false, error: "use must be admins or everyone" };
    out.use = body.use;
  }
  if (!full && !Object.keys(out).length) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
}

/** Whether a live page may be shown: `/omnirush/work/live/v/` with its ticket in the fragment, on the account's server
 *  or a host under it (a live host of its own), https unless the server itself is a loopback http one. */
export function liveUrlAllowed(value: unknown, serverOrigin: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length > 4096 || !serverOrigin) return false;
  let url: URL;
  let server: URL;
  try { url = new URL(value); server = new URL(serverOrigin); } catch { return false; }
  if (url.username || url.password || url.search || url.pathname !== "/omnirush/work/live/v/" || !/^#t=[A-Za-z0-9_.-]{16,2048}$/.test(url.hash)) return false;
  const loopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && server.protocol === "http:" && loopback(server.hostname))) return false;
  return url.origin === server.origin || (url.protocol === "https:" && url.hostname.endsWith(`.${server.hostname}`));
}

export function registerWorkCloudRoutes(deps: WorkRouteDeps, options: { markStale: () => void; passThrough: PassThrough }): void {
  const { routes, jsonResponse } = deps;
  const signedOut = () => jsonResponse({ detail: "omnirush_account_required", code: "omnirush_account_required", message: "Sign in to omnirush.ai to use Work." }, 401);
  const invalid = (detail: string) => jsonResponse({ detail, code: "invalid_request", message: detail }, 400);
  const notFound = () => jsonResponse({ detail: "not_found", code: "not_found", message: CLOUD_ERRORS.not_found }, 404);
  const query = (url: URL, rules: Record<string, (value: string) => boolean>) => {
    const out = new URLSearchParams();
    for (const [name, ok] of Object.entries(rules)) {
      const value = url.searchParams.get(name)?.trim();
      if (value && value.length <= 200 && ok(value)) out.set(name, value);
    }
    return out.size ? `?${out}` : "";
  };
  const count = (min: number, max: number) => (value: string) => /^\d{1,6}$/.test(value) && Number(value) >= min && Number(value) <= max;
  const anyText = () => true;

  /** The server's answer as it came, its codes in Cloud tasks' words; a 204 becomes {ok: true}. */
  const answerOf = async (upstream: Response) => {
    if (upstream.status === 204) return { status: 200, data: { ok: true }, response: jsonResponse({ ok: true }) };
    const answer = await options.passThrough(upstream, jsonResponse);
    const data = answer.data;
    if (answer.status >= 400 && isRecord(data) && typeof data.code === "string" && CLOUD_ERRORS[data.code]) {
      const worded = { ...data, message: CLOUD_ERRORS[data.code] };
      return { status: answer.status, data: worded, response: jsonResponse(worded, answer.status) };
    }
    return answer;
  };
  const forward = async (path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: Fields) => {
    const found = deps.broker();
    if (!found) return { status: 401, data: null, response: signedOut() };
    return answerOf(await found.workRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  };
  const send = async (path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: Fields) => (await forward(path, method, body)).response;
  /** A run's screenshot or file: only the listed types, never shown as a page. */
  const bytes = async (path: string, types: RegExp, download: boolean) => {
    const found = deps.broker();
    if (!found) return signedOut();
    const upstream = await found.workRequest(path, { method: "GET", signal: AbortSignal.timeout(120_000) });
    if (!upstream.ok) return (await answerOf(upstream)).response;
    const type = upstream.headers.get("content-type") ?? "";
    if (!types.test(type)) return jsonResponse({ detail: "not_found", code: "not_found", message: CLOUD_ERRORS.not_found }, 404);
    const headers = new Headers({
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
      ...(download ? { "content-disposition": upstream.headers.get("content-disposition")?.startsWith("attachment") ? upstream.headers.get("content-disposition")! : "attachment" } : {}),
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(upstream.body, { status: 200, headers });
  };

  addRoute(routes, "GET", "/work/cloud/tasks", "client", async (ctx) => send(`cloud/tasks${query(ctx.url, { q: anyText, filter: (v) => FILTERS.includes(v), limit: count(1, 50), cursor: (v) => /^[A-Za-z0-9_.:=-]+$/.test(v) })}`, "GET"));
  addRoute(routes, "POST", "/work/cloud/tasks", "client", async (ctx) => {
    const fields = cloudTaskFields(await deps.readJsonBody(ctx.request), true);
    return fields.ok ? send("cloud/tasks", "POST", fields.value) : invalid(fields.error);
  });
  addRoute(routes, "GET", "/work/cloud/tasks/:id", "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`cloud/tasks/${ctx.params.id}`, "GET") : notFound()));
  addRoute(routes, "PATCH", "/work/cloud/tasks/:id", "client", async (ctx) => {
    if (!ID.test(ctx.params.id ?? "")) return notFound();
    const fields = cloudTaskFields(await deps.readJsonBody(ctx.request), false);
    return fields.ok ? send(`cloud/tasks/${ctx.params.id}`, "PATCH", fields.value) : invalid(fields.error);
  });
  addRoute(routes, "DELETE", "/work/cloud/tasks/:id", "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`cloud/tasks/${ctx.params.id}`, "DELETE") : notFound()));
  addRoute(routes, "POST", "/work/cloud/tasks/:id/run", "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`cloud/tasks/${ctx.params.id}/run`, "POST", {}) : notFound()));

  addRoute(routes, "GET", "/work/cloud/runs", "client", async (ctx) => send(`cloud/runs${query(ctx.url, { task_id: (v) => ID.test(v), status: (v) => STATUSES.includes(v), limit: count(1, 50), cursor: (v) => /^[A-Za-z0-9_.:=-]+$/.test(v) })}`, "GET"));
  addRoute(routes, "GET", "/work/cloud/runs/:id", "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`cloud/runs/${ctx.params.id}`, "GET") : notFound()));
  addRoute(routes, "GET", "/work/cloud/runs/:id/steps", "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`cloud/runs/${ctx.params.id}/steps${query(ctx.url, { from: count(0, 100000), limit: count(1, 200) })}`, "GET") : notFound()));
  addRoute(routes, "GET", "/work/cloud/runs/:id/steps/:n/shot", "client", async (ctx) => {
    const n = ctx.params.n ?? "";
    return ID.test(ctx.params.id ?? "") && /^\d{1,5}$/.test(n) ? bytes(`cloud/runs/${ctx.params.id}/steps/${Number(n)}/shot`, IMAGE, false) : notFound();
  });
  addRoute(routes, "GET", "/work/cloud/runs/:id/files/:name", "client", async (ctx) => {
    const name = ctx.params.name ?? "";
    return ID.test(ctx.params.id ?? "") && FILE_NAME.test(name) && name !== "." && name !== ".." ? bytes(`cloud/runs/${ctx.params.id}/files/${encodeURIComponent(name)}`, FILE_TYPES, true) : notFound();
  });
  for (const action of ["cancel", "takeover", "approve", "deny"] as const) {
    addRoute(routes, "POST", `/work/cloud/runs/:id/${action}`, "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`cloud/runs/${ctx.params.id}/${action}`, "POST", {}) : notFound()));
  }
  addRoute(routes, "POST", "/work/cloud/runs/:id/handback", "client", async (ctx) => {
    if (!ID.test(ctx.params.id ?? "")) return notFound();
    const note = (await deps.readJsonBody(ctx.request)).note;
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) return invalid("A note is at most 500 characters.");
    return send(`cloud/runs/${ctx.params.id}/handback`, "POST", typeof note === "string" && note.trim() ? { note: note.trim() } : {});
  });
  // A sign-in code: checked for shape only, sent on once, never logged or kept.
  addRoute(routes, "POST", "/work/cloud/runs/:id/input", "client", async (ctx) => {
    if (!ID.test(ctx.params.id ?? "")) return notFound();
    const code = (await deps.readJsonBody(ctx.request)).code;
    if (typeof code !== "string" || !/^[A-Za-z0-9-]{3,12}$/.test(code.trim())) return invalid("Enter the code from the site.");
    return send(`cloud/runs/${ctx.params.id}/input`, "POST", { code: code.trim() });
  });
  addRoute(routes, "POST", "/work/cloud/runs/:id/live", "client", async (ctx) => {
    if (!ID.test(ctx.params.id ?? "")) return notFound();
    const mode = (await deps.readJsonBody(ctx.request)).mode;
    if (mode !== "view" && mode !== "control") return invalid("mode must be view or control");
    const answer = await forward(`cloud/runs/${ctx.params.id}/live`, "POST", { mode });
    if (answer.status !== 200) return answer.response;
    // Only a live page on the account's own server goes to the app's frame.
    const data = answer.data;
    if (!isRecord(data) || !liveUrlAllowed(data.url, deps.broker()?.gatewayOrigin?.())) {
      return jsonResponse({ detail: "live_unavailable", code: "live_unavailable", message: CLOUD_ERRORS.live_unavailable }, 502);
    }
    return jsonResponse({ url: data.url, expires_at: typeof data.expires_at === "string" ? data.expires_at : null });
  });

  addRoute(routes, "GET", "/work/org/cloud", "client", async () => send("org/cloud", "GET"));
  addRoute(routes, "PATCH", "/work/org/cloud", "client", async (ctx) => {
    const fields = orgCloudFields(await deps.readJsonBody(ctx.request));
    if (!fields.ok) return invalid(fields.error);
    const answer = await forward("org/cloud", "PATCH", fields.value);
    // The company switch rides in the capabilities' cloud block: the next /work/state reads it fresh.
    if (answer.status === 200) options.markStale();
    return answer.response;
  });
  addRoute(routes, "GET", "/work/org/cloud/signins", "client", async () => send("org/cloud/signins", "GET"));
  addRoute(routes, "POST", "/work/org/cloud/signins", "client", async (ctx) => {
    const fields = signinFields(await deps.readJsonBody(ctx.request), true);
    return fields.ok ? send("org/cloud/signins", "POST", fields.value) : invalid(fields.error);
  });
  addRoute(routes, "PUT", "/work/org/cloud/signins/:id", "client", async (ctx) => {
    if (!ID.test(ctx.params.id ?? "")) return notFound();
    const fields = signinFields(await deps.readJsonBody(ctx.request), false);
    return fields.ok ? send(`org/cloud/signins/${ctx.params.id}`, "PUT", fields.value) : invalid(fields.error);
  });
  addRoute(routes, "DELETE", "/work/org/cloud/signins/:id", "client", async (ctx) => (ID.test(ctx.params.id ?? "") ? send(`org/cloud/signins/${ctx.params.id}`, "DELETE") : notFound()));
}
