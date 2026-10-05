/**
 * The 1.x engine HTTP API served in front of the 2.x engine.
 *
 * OmniRush.ai's server, renderer and turn observer speak the opencode 1.x
 * API (`/session`, `/session/:id/prompt_async`, `/event`, `/permission`, …).
 * The bundled 2.x engine only serves its own contract under `/api/*`. The
 * facade is a loopback HTTP server that answers the 1.x routes the app uses by
 * calling the 2.x engine and reshaping the result with engine2/shapes.ts and
 * engine2/events.ts, so everything above the engine (and the uploaded
 * traces) keeps the 1.x shapes. Requests to `/api/*` are passed through with
 * the few 1.x-era `/api` routes the renderer uses (session permissions) mapped.
 *
 * Auth mirrors the 1.x engine: HTTP Basic with the per-boot username and
 * password managed-opencode.ts generates; the facade authenticates to the
 * engine with the engine's own password. The directory a request is for comes
 * from `x-opencode-directory` / `?directory=` as with 1.x and is sent to the
 * engine as `location[directory]`.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname as parentDir, join as joinPath } from "node:path";
import { homedir } from "node:os";
import { buildEngine2Config, v2Mcp } from "./config.js";
import { EventTranslator, v1EventEnvelope, type ScopedV1Event, type V1Event } from "./events.js";
import {
  v1Agent,
  v1Command,
  v1McpStatus,
  v1Messages,
  v1PermissionRequest,
  v1PermissionV2Request,
  v1ProviderList,
  v1QuestionRequest,
  v1Session,
  v2FormAnswer,
  type V1Message,
} from "./shapes.js";
import { arr, isRecord, num, omitUndefined, record, str, unwrap, type JsonRecord } from "./util.js";

export type EngineFacadeOptions = {
  /** The 2.x engine's base URL and password (user `opencode`). */
  upstreamUrl: string;
  upstreamPassword: string;
  /** Credentials the facade itself requires (the 1.x engine's per-boot Basic auth). */
  username: string;
  password: string;
  hostname?: string;
  port?: number;
  /** The engine's version (reported as `version` in 1.x session records and health). */
  version: string;
  /** The directory used when a request names none (the engine process cwd). */
  defaultDirectory: string;
  /** The 1.x runtime config file (OPENCODE_CONFIG) the engine config is rendered from. */
  v1ConfigPath?: string;
  /** Writes the rendered 2.x config (the engine watches it and reloads). */
  writeEngineConfig?: (config: JsonRecord) => Promise<void>;
  /** Plugin directories the rendered config names (OmniRush.ai's plugin bridge). */
  plugins?: string[];
  /** Whether MCP servers may be rendered into the 2.x config. */
  mcpAllowed?: boolean;
  /** Engine state paths reported by `/path`. */
  paths?: { state?: string; config?: string };
  log?: (message: string, attributes?: Record<string, unknown>) => void;
  fetch?: typeof globalThis.fetch;
  /** How long a prompt waits for the engine to serve its model (see ensureModelServed). */
  modelWaitMs?: number;
  /** How often a location reload deferred behind a running session checks for an idle engine. */
  reloadPollMs?: number;
};

export type EngineFacade = {
  url: string;
  close: () => Promise<void>;
  /** Re-renders the engine config from the 1.x runtime file (as `/instance/dispose` does). */
  refreshConfig: () => Promise<void>;
};

/** The tools a 2.x engine offers before the plugin bridge has reported its list (1.x names). */
const BUILTIN_TOOL_IDS = ["question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "websearch", "skill", "apply_patch"];

/** Opens a URL in the user's browser, as the 1.x engine did for MCP OAuth. */
function openInBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser launcher: the app shows the URL for manual completion.
  }
}

const roots = new Map<string, string>();
/** The worktree root 1.x reported in `path.root` / relative paths: the enclosing git root, else "/". */
export function worktreeRoot(directory: string | undefined): string {
  if (!directory) return "/";
  const known = roots.get(directory);
  if (known) return known;
  let current = directory;
  let root = "/";
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(joinPath(current, ".git"))) {
      root = current;
      break;
    }
    const parent = parentDir(current);
    if (parent === current) break;
    current = parent;
  }
  if (roots.size > 256) roots.clear();
  roots.set(directory, root);
  return root;
}

class UpstreamError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`engine answered ${status}`);
  }
}

type Json = unknown;

function json(res: http.ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

function noContent(res: http.ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function namedError(res: http.ServerResponse, status: number, name: string, message: string): void {
  json(res, status, { name, data: { message } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}

function decodeCursor(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return value.startsWith("msg_") ? value : null;
  }
}

function decodeDirectory(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type ModelRef = { providerID: string; modelID: string; variant?: string };

export async function startEngineFacade(options: EngineFacadeOptions): Promise<EngineFacade> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const upstream = options.upstreamUrl.replace(/\/+$/, "");
  const upstreamAuth = `Basic ${Buffer.from(`opencode:${options.upstreamPassword}`).toString("base64")}`;
  const expectedAuth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  const log = options.log ?? (() => undefined);
  const modelWaitMs = options.modelWaitMs ?? 20_000;
  const apiKeys: Record<string, string> = {};
  /** Session model/agent last sent to the engine, to skip redundant switch records. */
  const selected = new Map<string, { model?: string; agent?: string; system?: string }>();
  const archived = new Map<string, number>();
  const todos = new Map<string, JsonRecord[]>();

  const call = async (
    method: string,
    path: string,
    init: { directory?: string; query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> => {
    const url = new URL(`${upstream}${path}`);
    if (init.directory) url.searchParams.set("location[directory]", init.directory);
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const send = () => fetchImpl(url, {
      method,
      headers: { authorization: upstreamAuth, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
    // Reads are retried through a transient engine failure (a 5xx or a dropped connection).
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await send();
        if (method !== "GET" || response.status < 500 || attempt >= 2) break;
        log("engine read failed, retrying", { path, status: response.status });
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (method !== "GET" || attempt >= 2 || init.signal?.aborted) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) throw new UpstreamError(response.status, payload);
    return payload;
  };

  const translator = new EventTranslator({
    version: options.version,
    rootFor: worktreeRoot,
    lookupSession: (sessionID) => call("GET", `/api/session/${encodeURIComponent(sessionID)}`),
    messageIDs: async (sessionID) => (await sessionMessages(sessionID)).map((message) => String(message.info.id)),
  });
  /**
   * Makes a staged revert final (as a 2.x prompt does before it runs); a
   * no-op without one. A busy session (409) cannot hold a staged revert: the
   * app stops a run before it reverts, and a prompt commits it.
   */
  const commitRevert = async (encodedSessionID: string) => {
    await call("POST", `/api/session/${encodedSessionID}/revert/commit`, { body: {} }).catch((error) => {
      if (error instanceof UpstreamError && (error.status === 404 || error.status === 409)) return undefined;
      throw error;
    });
  };

  // ---- config rendering ---------------------------------------------------
  const readV1Config = async (): Promise<JsonRecord> => {
    if (!options.v1ConfigPath) return {};
    try {
      const parsed: unknown = JSON.parse(await readFile(options.v1ConfigPath, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  let v1ConfigCache: JsonRecord = await readV1Config();
  const refreshConfig = async (): Promise<void> => {
    v1ConfigCache = await readV1Config();
    if (options.writeEngineConfig) await options.writeEngineConfig(buildEngine2Config({ v1: v1ConfigCache, apiKeys, plugins: options.plugins, mcpAllowed: options.mcpAllowed }));
  };

  // ---- location reloads ---------------------------------------------------
  /*
   * `/instance/dispose` is a 2.x `location/reload`, which closes every cached
   * location, not just the requested one. A step running when its location
   * closes keeps the old services, whose permission service now declines
   * every request: each tool call of that step fails with "Interaction
   * cancelled because the location shut down" (a subagent call fails before
   * it creates its child session). So a reload asked while any session runs
   * waits until no session runs: it is retried on a timer, and the next
   * prompt runs it first when the engine is idle by then. The config itself
   * is re-rendered at once; the engine applies config changes live.
   */
  const reloadPollMs = options.reloadPollMs ?? 500;
  let reloadPending = false;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadChain: Promise<void> = Promise.resolve();
  let facadeClosed = false;
  /** Whether any session runs; an unreadable answer counts as running. */
  const engineBusy = async (): Promise<boolean> => {
    try {
      const active = unwrap(await call("GET", "/api/session/active"));
      return isRecord(active) && Object.keys(active).length > 0;
    } catch {
      return true;
    }
  };
  /** Reloads now; reloads are serialized so a later request never joins one that read older config. */
  const reloadLocations = (directory?: string): Promise<void> => {
    reloadPending = false;
    const run = reloadChain.then(() => call("POST", "/api/location/reload", { directory, body: {} }).then(() => undefined, () => undefined));
    reloadChain = run;
    return run;
  };
  const scheduleDeferredReload = () => {
    if (reloadTimer || facadeClosed) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void (async () => {
        if (!reloadPending || facadeClosed) return;
        if (await engineBusy()) {
          scheduleDeferredReload();
          return;
        }
        if (reloadPending) await reloadLocations();
      })();
    }, reloadPollMs);
    reloadTimer.unref?.();
  };
  /** `/instance/dispose`: reloads now when no session runs, else once none does. */
  const requestLocationReload = async (directory: string): Promise<"reloaded" | "deferred"> => {
    if (await engineBusy()) {
      if (!reloadPending) log("location reload deferred while a session runs", { directory });
      reloadPending = true;
      scheduleDeferredReload();
      return "deferred";
    }
    await reloadLocations(directory);
    return "reloaded";
  };
  /** Before a prompt: a deferred reload runs now if the engine went idle. */
  const settleDeferredReload = async (): Promise<void> => {
    if (!reloadPending) return;
    if (await engineBusy()) return;
    if (reloadPending) await reloadLocations();
  };

  // ---- sessions & messages -----------------------------------------------
  const sessionInfo = async (sessionID: string, directory?: string): Promise<JsonRecord | null> => {
    const info = v1Session(await call("GET", `/api/session/${encodeURIComponent(sessionID)}`), { version: options.version, directory });
    if (!info) return null;
    const archivedAt = archived.get(sessionID) ?? num(record(info, "metadata"), "omnirushArchivedAt");
    if (archivedAt) info.time = { ...(record(info, "time") ?? {}), archived: archivedAt };
    const picked = selected.get(sessionID);
    if (picked?.model) {
      // The model and agent this adapter last selected for the session (its next step runs on them).
      const [ref, variant] = picked.model.split("#");
      const slash = ref!.indexOf("/");
      info.model = { id: ref!.slice(slash + 1), providerID: ref!.slice(0, slash), variant: variant || "default" };
    }
    if (picked?.agent) info.agent = picked.agent;
    if (!info.agent || !info.model) {
      // 2.x records the agent and model on each step, not on the session: take the latest step's.
      const recent = await call("GET", `/api/session/${encodeURIComponent(sessionID)}/message`, { query: { order: "desc", limit: "20" } }).catch(() => undefined);
      const step = arr(recent, "data").find((message) => str(message, "type") === "assistant");
      const variant = selected.get(sessionID)?.model?.split("#")[1];
      if (step) {
        info.agent ??= str(step, "agent");
        const model = record(step, "model");
        if (!info.model && model && str(model, "id") && str(model, "providerID")) {
          info.model = { id: str(model, "id"), providerID: str(model, "providerID"), variant: str(model, "variant") ?? (variant || "default") };
        }
      }
      if (!info.parentID) info.agent ??= "build";
    }
    translator.noteSession(sessionID, {
      directory: String(info.directory || "") || null,
      parentID: str(info, "parentID"),
      agent: str(info, "agent"),
      model: isRecord(info.model) && str(info.model, "id") ? { providerID: String(str(info.model, "providerID")), modelID: String(str(info.model, "id")), variant: str(info.model, "variant") } : undefined,
      info,
    });
    return info;
  };

  const rawMessages = async (sessionID: string): Promise<unknown[]> => {
    const all: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 500; page++) {
      const payload = await call("GET", `/api/session/${encodeURIComponent(sessionID)}/message`, {
        // 2.x rejects `order` next to a cursor (InvalidCursorError: the cursor
        // already carries the direction), so only the first page names it.
        query: cursor ? { limit: "200", cursor } : { order: "asc", limit: "200" },
      });
      const items = arr(payload, "data");
      all.push(...items);
      const next = str(record(payload, "cursor"), "next");
      if (items.length < 200 || !next || next === cursor) break;
      cursor = next;
    }
    return all;
  };

  // The turn observer and the renderer page a long history newest-first, one request per page.
  // A history read is reused while the session's newest message is the same completed record
  // (and the session's busy state is unchanged): one small read instead of the whole history.
  const messageCache = new Map<string, { key: string; value: V1Message[] }>();
  const inflight = new Map<string, Promise<V1Message[]>>();
  const sessionMessages = async (sessionID: string): Promise<V1Message[]> => {
    const pending = inflight.get(sessionID);
    if (pending) return pending;
    const run = (async () => {
      const newest = await call("GET", `/api/session/${encodeURIComponent(sessionID)}/message`, { query: { order: "desc", limit: "1" } }).catch(() => undefined);
      const head = arr(newest, "data")[0];
      const completed = isRecord(head) && (str(head, "type") !== "assistant" || num(record(head, "time"), "completed") !== undefined);
      const key = isRecord(head) && completed ? `${str(head, "id")}|${translator.statusOf(sessionID)?.type ?? "idle"}` : "";
      const cached = messageCache.get(sessionID);
      if (key && cached?.key === key) return cached.value;
      const value = await readSessionMessages(sessionID);
      if (key) messageCache.set(sessionID, { key, value });
      else messageCache.delete(sessionID);
      if (messageCache.size > 64) messageCache.delete(messageCache.keys().next().value as string);
      return value;
    })();
    inflight.set(sessionID, run);
    try {
      return await run;
    } finally {
      inflight.delete(sessionID);
    }
  };
  const readSessionMessages = async (sessionID: string): Promise<V1Message[]> => {
    const info = await sessionInfo(sessionID).catch(() => null);
    const directory = info ? String(info.directory || "") || undefined : undefined;
    const variant = str(info?.model, "variant");
    const model = isRecord(info?.model) && str(info!.model, "id")
      ? omitUndefined({ providerID: String(str(info!.model, "providerID")), modelID: String(str(info!.model, "id")), variant: variant && variant !== "default" ? variant : undefined })
      : undefined;
    const mapped = v1Messages(await rawMessages(sessionID), {
      sessionID,
      directory,
      root: worktreeRoot(directory),
      agent: info ? str(info, "agent") : undefined,
      model,
      child: Boolean(info && str(info, "parentID")),
      // A running sub-agent call keeps the child session its progress named (the read leaves it out).
      childSessionOf: (callID) => translator.childSessionOf(sessionID, callID),
    });
    await attachTurnDiffs(sessionID, mapped);
    return mapped;
  };

  // 1.x put each prompt's turn diff (whole-file patches) on the user message as `summary.diffs`.
  const turnDiffs = new Map<string, JsonRecord[]>();
  const attachTurnDiffs = async (sessionID: string, messages: V1Message[]): Promise<void> => {
    const busy = translator.statusOf(sessionID)?.type === "busy";
    // A prompt may carry synthetic notes beside what was typed; a message of synthetic text alone is not a prompt.
    const prompts = messages.filter((message) => message.info.role === "user"
      && !(message.parts.length > 0 && message.parts.every((part) => part.type === "text" && part.synthetic === true)));
    for (const [index, message] of prompts.entries()) {
      const id = String(message.info.id);
      const key = `${sessionID}\u0000${id}`;
      let diffs = turnDiffs.get(key);
      const current = index === prompts.length - 1;
      if (!diffs && !(current && busy)) {
        const payload = await call("GET", `/api/session/${encodeURIComponent(sessionID)}/diff`, { query: { from: id } }).catch(() => undefined);
        const list = unwrap(payload);
        if (Array.isArray(list)) {
          diffs = list.filter(isRecord).map((diff) => omitUndefined({
            file: str(diff, "file"),
            patch: str(diff, "patch"),
            additions: num(diff, "additions") ?? 0,
            deletions: num(diff, "deletions") ?? 0,
            status: str(diff, "status"),
          }));
          if (!current) turnDiffs.set(key, diffs);
          if (turnDiffs.size > 4096) turnDiffs.delete(turnDiffs.keys().next().value as string);
        }
      }
      if (diffs) message.info.summary = { diffs };
    }
  };

  const listSessions = async (directory: string | undefined, query: URLSearchParams, rootsOnly: boolean): Promise<JsonRecord[]> => {
    const limit = Math.max(1, Math.min(Number(query.get("limit") ?? "") || 10_000, 10_000));
    const out: JsonRecord[] = [];
    let cursor: string | undefined;
    const includeArchived = query.get("archived") === "true";
    for (let page = 0; page < 200 && out.length < limit; page++) {
      const payload = await call("GET", "/api/session", {
        query: {
          limit: String(Math.min(200, limit - out.length + 10)),
          directory: directory,
          parentID: rootsOnly ? "null" : undefined,
          search: query.get("search") ?? undefined,
          cursor,
        },
      });
      const items = arr(payload, "data");
      for (const item of items) {
        const info = v1Session(item, { version: options.version, directory });
        if (!info) continue;
        const archivedAt = archived.get(String(info.id)) ?? num(record(info, "metadata"), "omnirushArchivedAt");
        if (archivedAt) info.time = { ...(record(info, "time") ?? {}), archived: archivedAt };
        if (archivedAt && !includeArchived && query.has("archived")) continue;
        const start = Number(query.get("start") ?? "");
        if (Number.isFinite(start) && start > 0 && Number(record(info, "time")?.updated ?? 0) < start) continue;
        translator.noteSession(String(info.id), { directory: String(info.directory || "") || null, parentID: str(info, "parentID") });
        out.push(info);
        if (out.length >= limit) break;
      }
      const next = str(record(payload, "cursor"), "next");
      if (items.length === 0 || !next || next === cursor) break;
      cursor = next;
    }
    return out;
  };

  const modelRefFromBody = (body: JsonRecord): ModelRef | undefined => {
    const model = record(body, "model");
    const providerID = str(model, "providerID");
    const modelID = str(model, "modelID") ?? str(model, "id");
    if (!providerID || !modelID) return undefined;
    const variant = str(body, "variant") ?? str(model, "variant") ?? str(body, "reasoning_effort");
    return variant ? { providerID, modelID, variant } : { providerID, modelID };
  };

  /** The `provider/model` ids the engine serves for a folder; null when it cannot tell. */
  const engineModelIds = async (directory: string): Promise<Set<string> | null> => {
    try {
      const models = unwrap(await call("GET", "/api/model", { directory }));
      if (!Array.isArray(models)) return null;
      const ids = new Set<string>();
      for (const provider of v1ProviderList([], models, {}).all as JsonRecord[]) {
        for (const id of Object.keys(record(provider, "models") ?? {})) ids.add(`${String(provider.id)}/${id}`);
      }
      return ids;
    } catch {
      return null;
    }
  };

  /**
   * A prompt for a model of a provider the runtime config defines (the
   * omnirush.ai catalog) waits while the engine does not list it yet: a
   * config change it is applying live (a catalog that just arrived). The 2.x
   * engine accepts a session model it does not know and then never starts the
   * run, so a model still missing after the wait is refused with a clear
   * error instead of a turn that silently never answers. A failed lookup never
   * blocks the prompt.
   */
  const ensureModelServed = async (directory: string, model: ModelRef): Promise<void> => {
    if (!isRecord(record(v1ConfigCache, "provider")?.[model.providerID])) return;
    const key = `${model.providerID}/${model.modelID}`;
    const deadline = Date.now() + modelWaitMs;
    for (;;) {
      const served = await engineModelIds(directory);
      if (!served || served.has(key)) return;
      if (Date.now() >= deadline) {
        log("prompt refused: model not served", { model: key });
        throw new UpstreamError(400, {
          name: "ProviderModelNotFoundError",
          data: {
            providerID: model.providerID,
            modelID: model.modelID,
            message: `The model ${key} is not available yet. Pick another model or try again in a moment.`,
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  /** Applies a 1.x prompt's model, agent and system prompt to the session before it is sent. */
  const prepareSession = async (sessionID: string, body: JsonRecord, directory: string): Promise<void> => {
    await settleDeferredReload();
    const current = selected.get(sessionID) ?? {};
    const model = modelRefFromBody(body);
    if (model) {
      const key = `${model.providerID}/${model.modelID}#${model.variant ?? ""}`;
      if (current.model !== key) {
        await ensureModelServed(directory, model);
        await call("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, {
          body: { model: omitUndefined({ providerID: model.providerID, id: model.modelID, variant: model.variant && model.variant !== "default" ? model.variant : undefined }) },
        });
        current.model = key;
        translator.noteSession(sessionID, { model });
      }
    }
    const agent = str(body, "agent");
    if (agent && current.agent !== agent) {
      await call("POST", `/api/session/${encodeURIComponent(sessionID)}/agent`, { body: { agent } });
      current.agent = agent;
      translator.noteSession(sessionID, { agent });
    }
    const system = str(body, "system") ?? "";
    if ((current.system ?? "") !== system) {
      const path = `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/omnirush.system`;
      if (system) await call("PUT", path, { body: { value: system } });
      else await call("DELETE", path).catch(() => undefined);
      current.system = system;
    }
    selected.set(sessionID, current);
  };

  /** A 1.x prompt's parts as the 2.x prompt (text, files, agent mentions). */
  const v2Prompt = (body: JsonRecord): JsonRecord => {
    const texts: string[] = [];
    // 2.x keeps one text per prompt: the layout of the 1.x text parts lets reads split it back,
    // so synthetic notes (attachment paths, mention instructions) reach the model but stay out
    // of the user's bubble and the trace's typed prompt.
    const textParts: JsonRecord[] = [];
    let splitText = false;
    const files: JsonRecord[] = [];
    const agents: JsonRecord[] = [];
    for (const part of arr(body, "parts")) {
      if (!isRecord(part)) continue;
      const type = str(part, "type");
      if (type === "text" && typeof part.text === "string") {
        texts.push(part.text);
        const synthetic = part.synthetic === true || undefined;
        const metadata = isRecord(part.metadata) && Object.keys(part.metadata).length ? part.metadata : undefined;
        if (synthetic || metadata) splitText = true;
        textParts.push(omitUndefined({ length: part.text.length, synthetic, metadata }));
      }
      else if (type === "file" && typeof part.url === "string") files.push(omitUndefined({ uri: part.url, name: str(part, "filename") }));
      else if (type === "agent" && typeof part.name === "string") agents.push({ id: part.name });
      else if (type === "subtask" && typeof part.prompt === "string") {
        texts.push(part.prompt);
        textParts.push({ length: part.prompt.length });
      }
    }
    // The 1.x user message fields 2.x does not keep (system prompt, agent and model as picked,
    // tool switches) travel in the message metadata, so reads return them field for field.
    const model = modelRefFromBody(body);
    const v1 = omitUndefined({
      agent: str(body, "agent"),
      model: model ? omitUndefined({ providerID: model.providerID, modelID: model.modelID, variant: model.variant && model.variant !== "default" ? model.variant : undefined }) : undefined,
      system: str(body, "system"),
      tools: isRecord(body.tools) ? body.tools : undefined,
      textParts: splitText ? textParts : undefined,
    });
    return omitUndefined({
      id: str(body, "messageID"),
      text: texts.join("\n\n"),
      files: files.length ? files : undefined,
      agents: agents.length ? agents : undefined,
      metadata: Object.keys(v1).length ? { omnirush: v1 } : undefined,
      resume: body.noReply === true ? false : undefined,
    });
  };

  const waitIdle = async (sessionID: string, timeoutMs = 30 * 60_000): Promise<void> => {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 250));
    while (Date.now() - started < timeoutMs) {
      const active = unwrap(await call("GET", "/api/session/active").catch(() => ({})));
      if (!isRecord(active) || !(sessionID in active)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const permissionSessions = new Map<string, string>();
  const pendingPermissions = async (directory?: string): Promise<JsonRecord[]> => {
    const payload = await call("GET", "/api/permission/request", { directory });
    const out: JsonRecord[] = [];
    for (const item of arr(payload, "data").length ? arr(payload, "data") : Array.isArray(unwrap(payload)) ? (unwrap(payload) as unknown[]) : []) {
      const mapped = v1PermissionRequest(item);
      if (!mapped) continue;
      permissionSessions.set(String(mapped.id), String(mapped.sessionID));
      out.push(mapped);
    }
    return out;
  };

  const pendingQuestions = async (directory?: string): Promise<JsonRecord[]> => {
    const payload = await call("GET", "/api/form", { directory });
    const list = unwrap(payload);
    const out: JsonRecord[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const state = str(item, "state") ?? str(record(item, "state"), "status");
      if (state && state !== "pending" && state !== "open") continue;
      const mapping = v1QuestionRequest(item);
      if (!mapping) continue;
      translator.rememberQuestion(String(mapping.request.id), mapping);
      out.push(mapping.request);
    }
    return out;
  };

  const replyPermission = async (requestID: string, reply: string, message: string | undefined, sessionID?: string, directory?: string) => {
    let session = sessionID ?? permissionSessions.get(requestID);
    if (!session) {
      await pendingPermissions(directory).catch(() => []);
      session = permissionSessions.get(requestID);
    }
    if (!session) throw new UpstreamError(404, { name: "NotFoundError", data: { message: `Permission request ${requestID} not found` } });
    await call("POST", `/api/session/${encodeURIComponent(session)}/permission/${encodeURIComponent(requestID)}/reply`, {
      body: omitUndefined({ decision: reply === "always" || reply === "reject" ? reply : "once", message }),
    });
    permissionSessions.delete(requestID);
  };

  const findQuestion = async (requestID: string, directory?: string) => {
    let mapping = translator.questionMapping(requestID);
    if (!mapping) {
      await pendingQuestions(directory).catch(() => []);
      mapping = translator.questionMapping(requestID);
    }
    return mapping;
  };

  // ---- MCP ----------------------------------------------------------------
  const mcpAttempts = new Map<string, { integrationID: string; attemptID: string }>();
  const engineTools = new Map<string, Array<{ id: string; description: string; parameters: JsonRecord }>>();
  const mcpServers = async (directory: string): Promise<JsonRecord[]> => {
    const list = unwrap(await call("GET", "/api/mcp", { directory }));
    return (Array.isArray(list) ? list : []).filter(isRecord);
  };
  const settledMcpDirectories = new Set<string>();
  const mcpStatuses = async (directory: string): Promise<Record<string, JsonRecord>> => {
    let servers = await mcpServers(directory);
    const deadline = Date.now() + 5_000;
    if (!settledMcpDirectories.has(directory)) {
      // A location's config (and its MCP servers) loads on first use: wait for the list to settle.
      let previous = JSON.stringify(servers.map((server) => server.name));
      const started = Date.now();
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        servers = await mcpServers(directory);
        const current = JSON.stringify(servers.map((server) => server.name));
        if (current === previous && (servers.length > 0 || Date.now() - started > 1_200)) break;
        previous = current;
      }
      settledMcpDirectories.add(directory);
    }
    // 2.x reports servers still connecting as pending; 1.x answered once they settled.
    while (servers.some((server) => str(record(server, "status"), "status") === "pending") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      servers = await mcpServers(directory);
    }
    const out: Record<string, JsonRecord> = {};
    for (const server of servers) {
      const name = str(server, "name");
      if (name) out[name] = v1McpStatus(server);
    }
    return out;
  };
  const mcpIntegration = async (name: string, directory: string): Promise<JsonRecord | undefined> => {
    const server = (await mcpServers(directory)).find((entry) => str(entry, "name") === name);
    const integrationID = str(server, "integrationID");
    if (!integrationID) return undefined;
    const integration = unwrap(await call("GET", `/api/integration/${encodeURIComponent(integrationID)}`, { directory }).catch(() => undefined));
    return isRecord(integration) ? integration : undefined;
  };
  const waitMcpAttempt = async (attempt: { integrationID: string; attemptID: string }, directory: string, timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = unwrap(await call("GET", `/api/integration/${attempt.integrationID}/connect/oauth/${encodeURIComponent(attempt.attemptID)}`, { directory }).catch(() => undefined));
      const state = str(status, "status");
      if (state && state !== "pending") return state;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return "pending";
  };

  // ---- events -------------------------------------------------------------
  type Subscriber = { directory: string | null; global: boolean; write: (event: V1Event, directory: string | null) => void; end: () => void };
  const subscribers = new Set<Subscriber>();
  const streamController = new AbortController();
  let streamStarted = false;
  const dispatch = (items: ScopedV1Event[]) => {
    for (const item of items) {
      const touched = str(item.event.properties, "sessionID") ?? str(record(item.event.properties, "info"), "sessionID") ?? str(record(item.event.properties, "part"), "sessionID");
      if (touched) messageCache.delete(touched);
      for (const subscriber of subscribers) {
        if (!subscriber.global && subscriber.directory && item.directory && item.directory !== subscriber.directory) continue;
        subscriber.write(item.event, item.directory);
      }
    }
  };
  const runStream = async () => {
    let backoff = 250;
    while (!streamController.signal.aborted) {
      try {
        const response = await fetchImpl(`${upstream}/api/event`, { headers: { authorization: upstreamAuth, accept: "text/event-stream" }, signal: streamController.signal });
        if (!response.ok || !response.body) throw new Error(`event stream answered ${response.status}`);
        backoff = 250;
        const decoder = new TextDecoder();
        let buffer = "";
        const reader = response.body.getReader();
        // Events are translated in order: a translation may await a session lookup.
        let chain: Promise<void> = Promise.resolve();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            chain = chain.then(async () => {
              try {
                dispatch(await translator.translate(parsed));
              } catch (error) {
                log("engine event translation failed", { error: error instanceof Error ? error.message : String(error) });
              }
            });
          }
        }
      } catch (error) {
        if (streamController.signal.aborted) return;
        log("engine event stream interrupted", { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 5_000);
    }
  };
  const ensureStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    void runStream();
  };

  const serveEvents = (req: http.IncomingMessage, res: http.ServerResponse, directory: string | null, global: boolean) => {
    ensureStream();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (event: V1Event, eventDirectory: string | null) => {
      const envelope = v1EventEnvelope(event);
      const payload = global ? { directory: eventDirectory ?? "global", payload: envelope } : envelope;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    write({ type: "server.connected", properties: {} }, null);
    const subscriber: Subscriber = { directory, global, write, end: () => res.end() };
    subscribers.add(subscriber);
    const heartbeat = setInterval(() => {
      const beat = { type: "server.heartbeat", properties: {} };
      write(beat, null);
    }, 10_000);
    const close = () => {
      clearInterval(heartbeat);
      subscribers.delete(subscriber);
    };
    req.on("close", close);
    res.on("close", close);
  };

  // ---- routing ------------------------------------------------------------
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://engine.local");
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const directory = decodeDirectory(req.headers["x-opencode-directory"] as string | undefined) ?? url.searchParams.get("directory") ?? undefined;
    const dir = directory ?? options.defaultDirectory;
    const segments = path.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));

    if (path === "/global/health" || path === "/api/health") {
      json(res, 200, { healthy: true, version: options.version });
      return;
    }
    if (method === "GET" && path === "/event") return serveEvents(req, res, dir, false);
    if (method === "GET" && path === "/global/event") return serveEvents(req, res, null, true);

    // /session ...
    if (segments[0] === "session") {
      if (segments.length === 1) {
        if (method === "GET") {
          json(res, 200, await listSessions(directory, url.searchParams, url.searchParams.get("roots") === "true"));
          return;
        }
        if (method === "POST") {
          const body = (await readBody(req)) as JsonRecord | undefined;
          const created = await call("POST", "/api/session", {
            body: omitUndefined({ title: str(body, "title"), location: { directory: dir } }),
          });
          const info = v1Session(created, { version: options.version, directory: dir });
          if (!info) throw new UpstreamError(502, { message: "engine created no session" });
          translator.noteSession(String(info.id), { directory: dir, info });
          json(res, 200, info);
          return;
        }
      }
      if (segments[1] === "status" && segments.length === 2 && method === "GET") {
        const active = unwrap(await call("GET", "/api/session/active", { directory }));
        const out: Record<string, JsonRecord> = {};
        if (isRecord(active)) for (const id of Object.keys(active)) out[id] = translator.statusOf(id)?.type === "retry" ? translator.statusOf(id)! : { type: "busy" };
        if (directory) {
          for (const id of Object.keys(out)) {
            const known = translator.directoryOf(id);
            if (known && known !== directory) delete out[id];
          }
        }
        json(res, 200, out);
        return;
      }
      const sessionID = segments[1]!;
      const encoded = encodeURIComponent(sessionID);
      const action = segments[2];
      if (!action) {
        if (method === "GET") {
          const info = await sessionInfo(sessionID, directory);
          if (!info) return namedError(res, 404, "NotFoundError", `Session not found: ${sessionID}`);
          json(res, 200, info);
          return;
        }
        if (method === "DELETE") {
          await call("POST", `/api/session/${encoded}/interrupt`, { query: { resume: "false" } }).catch(() => undefined);
          await call("DELETE", `/api/session/${encoded}`);
          json(res, 200, true);
          return;
        }
        if (method === "PATCH") {
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          const patch: JsonRecord = {};
          if (typeof body.title === "string") patch.title = body.title;
          const time = record(body, "time");
          if (time && "archived" in time) {
            const at = typeof time.archived === "number" ? time.archived : undefined;
            if (at) archived.set(sessionID, at);
            else archived.delete(sessionID);
            patch.metadata = { omnirushArchivedAt: at ?? null };
          }
          if (Object.keys(patch).length) await call("PATCH", `/api/session/${encoded}`, { body: patch });
          const info = await sessionInfo(sessionID, directory);
          json(res, 200, info);
          return;
        }
      }
      switch (action) {
        case "children": {
          const payload = await call("GET", "/api/session", { query: { parentID: sessionID, limit: "200" } });
          json(res, 200, arr(payload, "data").map((item) => v1Session(item, { version: options.version, directory })).filter(Boolean));
          return;
        }
        case "message": {
          if (method === "GET" && segments.length === 3) {
            const messages = await sessionMessages(sessionID);
            const limit = Number(url.searchParams.get("limit") ?? "");
            const before = decodeCursor(url.searchParams.get("before"));
            let end = messages.length;
            if (before) {
              const index = messages.findIndex((message) => message.info.id === before);
              if (index >= 0) end = index;
            }
            if (!Number.isFinite(limit) || limit <= 0) {
              json(res, 200, messages.slice(0, end));
              return;
            }
            const start = Math.max(0, end - limit);
            const page = messages.slice(start, end);
            const headers: Record<string, string> = { "access-control-expose-headers": "Link, X-Next-Cursor" };
            if (start > 0 && page[0]) headers["x-next-cursor"] = encodeCursor(String(page[0].info.id));
            json(res, 200, page, headers);
            return;
          }
          if (method === "GET" && segments.length === 4) {
            const messages = await sessionMessages(sessionID);
            const found = messages.find((message) => message.info.id === segments[3]);
            if (!found) return namedError(res, 404, "NotFoundError", `Message not found: ${segments[3]}`);
            json(res, 200, found);
            return;
          }
          if (method === "POST" && segments.length === 3) {
            // Synchronous prompt: send, wait for the run to settle, answer with the last reply.
            const body = ((await readBody(req)) ?? {}) as JsonRecord;
            await prepareSession(sessionID, body, dir);
            await call("POST", `/api/session/${encoded}/prompt`, { body: v2Prompt(body) });
            await waitIdle(sessionID);
            const messages = await sessionMessages(sessionID);
            const last = [...messages].reverse().find((message) => message.info.role === "assistant");
            json(res, 200, last ?? null);
            return;
          }
          break;
        }
        case "prompt_async": {
          if (method !== "POST") break;
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await prepareSession(sessionID, body, dir);
          await call("POST", `/api/session/${encoded}/prompt`, { body: v2Prompt(body) });
          noContent(res);
          return;
        }
        case "prompt": {
          if (method !== "POST") break;
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await prepareSession(sessionID, body, dir);
          await call("POST", `/api/session/${encoded}/prompt`, { body: v2Prompt(body) });
          await waitIdle(sessionID);
          const messages = await sessionMessages(sessionID);
          const last = [...messages].reverse().find((message) => message.info.role === "assistant");
          json(res, 200, last ?? null);
          return;
        }
        case "command": {
          if (method !== "POST") break;
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await prepareSession(sessionID, body, dir);
          await commitRevert(encoded);
          const name = String(body.command ?? "").replace(/^\//, "");
          if (name === "compact" || name === "summarize") {
            await call("POST", `/api/session/${encoded}/compact`, { body: {} });
          } else {
            await call("POST", `/api/session/${encoded}/command`, { body: { name, text: typeof body.arguments === "string" ? body.arguments : "" } });
          }
          noContent(res);
          return;
        }
        case "shell": {
          if (method !== "POST") break;
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await settleDeferredReload();
          await commitRevert(encoded);
          await call("POST", `/api/session/${encoded}/shell`, { body: { command: String(body.command ?? "") } });
          json(res, 200, { id: "", sessionID, role: "assistant" });
          return;
        }
        case "abort": {
          const result = await call("POST", `/api/session/${encoded}/interrupt`, { query: { resume: "false" } }).catch((error) => {
            if (error instanceof UpstreamError && error.status === 404) return { interrupted: false };
            throw error;
          });
          json(res, 200, isRecord(result) ? result.interrupted !== false : true);
          return;
        }
        case "summarize": {
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await prepareSession(sessionID, body, dir);
          await call("POST", `/api/session/${encoded}/compact`, { body: {} });
          json(res, 200, true);
          return;
        }
        case "revert": {
          // 2.x stages a reversible revert: the files go back to before the
          // message, the session carries the revert point and the later
          // messages stay until a prompt commits it (1.x's cleanup) or
          // unrevert clears it. 1.x's partID (a revert inside a message)
          // has no 2.x equivalent: the whole message is the boundary.
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          const messageID = str(body, "messageID");
          if (messageID) await call("POST", `/api/session/${encoded}/revert/stage`, { body: { messageID } });
          json(res, 200, await sessionInfo(sessionID, directory));
          return;
        }
        case "unrevert": {
          // Restores the files and the hidden messages; a no-op once a prompt committed the revert.
          await call("DELETE", `/api/session/${encoded}/revert`);
          json(res, 200, await sessionInfo(sessionID, directory));
          return;
        }
        case "fork": {
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          const created = await call("POST", `/api/session/${encoded}/fork`, { body: omitUndefined({ before: str(body, "messageID") }) });
          json(res, 200, v1Session(created, { version: options.version, directory }));
          return;
        }
        case "todo": {
          if (!todos.has(sessionID)) {
            // Rebuilt from the session's last todo list call when the adapter has not seen one yet.
            const messages = await sessionMessages(sessionID).catch(() => []);
            const last = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "todowrite").at(-1);
            const input = record(record(last, "state"), "input");
            todos.set(sessionID, arr(input, "todos").filter(isRecord));
          }
          json(res, 200, todos.get(sessionID) ?? []);
          return;
        }
        case "diff":
          json(res, 200, []);
          return;
        case "init":
          json(res, 200, true);
          return;
        case "share":
        case "unshare":
          json(res, 200, await sessionInfo(sessionID, directory));
          return;
        case "permissions": {
          // 1.x legacy reply: POST /session/:id/permissions/:permissionID {response}
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await replyPermission(String(segments[3] ?? ""), String(body.response ?? "once"), undefined, sessionID, directory);
          json(res, 200, true);
          return;
        }
        default:
          break;
      }
    }

    if (segments[0] === "experimental" && segments[1] === "session" && segments.length === 2 && method === "GET") {
      json(res, 200, await listSessions(directory, url.searchParams, url.searchParams.get("roots") === "true"));
      return;
    }

    if (segments[0] === "permission") {
      if (segments.length === 1 && method === "GET") {
        json(res, 200, await pendingPermissions(directory));
        return;
      }
      if (segments[2] === "reply" && method === "POST") {
        const body = ((await readBody(req)) ?? {}) as JsonRecord;
        await replyPermission(String(segments[1]), String(body.reply ?? "once"), str(body, "message"), undefined, directory);
        json(res, 200, true);
        return;
      }
    }

    if (segments[0] === "question") {
      if (segments.length === 1 && method === "GET") {
        json(res, 200, await pendingQuestions(directory));
        return;
      }
      const requestID = String(segments[1] ?? "");
      if ((segments[2] === "reply" || segments[2] === "reject") && method === "POST") {
        const body = ((await readBody(req)) ?? {}) as JsonRecord;
        const mapping = await findQuestion(requestID, directory);
        if (!mapping) return namedError(res, 404, "NotFoundError", `Question ${requestID} not found`);
        const session = encodeURIComponent(String(mapping.request.sessionID));
        if (segments[2] === "reject") {
          await call("DELETE", `/api/session/${session}/form/${encodeURIComponent(requestID)}`);
        } else {
          await call("POST", `/api/session/${session}/form/${encodeURIComponent(requestID)}/reply`, {
            body: { answer: v2FormAnswer(mapping.fields, arr(body, "answers")) },
          });
        }
        json(res, 200, true);
        return;
      }
    }

    // 1.x-era /api routes the renderer and engine pool use.
    if (segments[0] === "api") {
      if (segments[1] === "session" && segments[3] === "permission") {
        const sessionID = String(segments[2]);
        if (segments.length === 4 && method === "GET") {
          const payload = await call("GET", `/api/session/${encodeURIComponent(sessionID)}/permission`);
          const list = unwrap(payload);
          json(res, 200, (Array.isArray(list) ? list : []).map(v1PermissionV2Request).filter(Boolean));
          return;
        }
        if (segments[5] === "reply" && method === "POST") {
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          await replyPermission(String(segments[4]), String(body.reply ?? body.decision ?? "once"), str(body, "message"), sessionID, directory);
          json(res, 200, true);
          return;
        }
      }
      if (segments[1] === "permission" && segments[2] === "request" && method === "GET") {
        const payload = await call("GET", "/api/permission/request", { directory });
        const list = unwrap(payload);
        json(res, 200, (Array.isArray(list) ? list : []).map(v1PermissionV2Request).filter(Boolean));
        return;
      }
      if (segments[1] === "question" && segments[2] === "request" && method === "GET") {
        json(res, 200, await pendingQuestions(directory));
        return;
      }
      // Anything else under /api is the 2.x contract itself.
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      try {
        const query: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });
        const payload = await call(method, path, { directory: query["location[directory]"] ? undefined : directory, query, body });
        if (payload === undefined) noContent(res);
        else json(res, 200, payload);
      } catch (error) {
        if (error instanceof UpstreamError) json(res, error.status, error.body ?? null);
        else throw error;
      }
      return;
    }

    if (method === "GET" && path === "/agent") {
      const payload = await call("GET", "/api/agent", { directory: dir });
      const list = unwrap(payload);
      json(res, 200, (Array.isArray(list) ? list : []).map(v1Agent).filter(Boolean));
      return;
    }
    if (method === "GET" && path === "/command") {
      const payload = await call("GET", "/api/command", { directory: dir });
      const list = unwrap(payload);
      json(res, 200, (Array.isArray(list) ? list : []).map(v1Command).filter(Boolean));
      return;
    }
    if (method === "GET" && path === "/skill") {
      const payload = await call("GET", "/api/skill", { directory: dir });
      const list = unwrap(payload);
      json(res, 200, (Array.isArray(list) ? list : []).filter(isRecord).map((skill) => omitUndefined({
        name: str(skill, "name") ?? str(skill, "id") ?? "",
        description: str(skill, "description") ?? "",
        location: str(skill, "location") ?? str(skill, "path") ?? str(skill, "directory") ?? "",
        content: str(skill, "content"),
      })));
      return;
    }
    if (method === "GET" && (path === "/provider" || path === "/config/providers")) {
      const [providers, models, defaults] = await Promise.all([
        call("GET", "/api/provider", { directory: dir }),
        call("GET", "/api/model", { directory: dir }),
        call("GET", "/api/model/default", { directory: dir }).catch(() => undefined),
      ]);
      const def = unwrap(defaults);
      const defaultMap: Record<string, string> = {};
      if (isRecord(def) && typeof def.providerID === "string" && typeof def.id === "string") defaultMap[def.providerID] = def.id;
      const list = v1ProviderList(Array.isArray(unwrap(providers)) ? (unwrap(providers) as unknown[]) : [], Array.isArray(unwrap(models)) ? (unwrap(models) as unknown[]) : [], defaultMap);
      for (const provider of list.all as JsonRecord[]) {
        const models = record(provider, "models") ?? {};
        if (!defaultMap[String(provider.id)]) {
          const first = Object.keys(models)[0];
          if (first) defaultMap[String(provider.id)] = first;
        }
      }
      if (path === "/config/providers") json(res, 200, { providers: list.all, default: defaultMap });
      else json(res, 200, { ...list, default: defaultMap });
      return;
    }
    if (method === "GET" && path === "/provider/auth") {
      json(res, 200, {});
      return;
    }
    if (segments[0] === "auth" && segments.length === 2) {
      const providerID = String(segments[1]);
      if (method === "PUT" || method === "POST") {
        const body = ((await readBody(req)) ?? {}) as JsonRecord;
        const key = str(body, "key") ?? str(body, "access");
        if (key) apiKeys[providerID] = key;
        await refreshConfig();
        json(res, 200, true);
        return;
      }
      if (method === "DELETE") {
        delete apiKeys[providerID];
        await refreshConfig();
        json(res, 200, true);
        return;
      }
    }
    if (method === "GET" && path === "/config") {
      json(res, 200, v1ConfigCache);
      return;
    }
    if (method === "PATCH" && path === "/config") {
      namedError(res, 400, "UnsupportedError", "Engine config is managed by OmniRush.ai");
      return;
    }
    if (method === "GET" && path === "/mcp") {
      json(res, 200, await mcpStatuses(dir));
      return;
    }
    if (segments[0] === "mcp") {
      if (segments.length === 1 && method === "POST") {
        const body = ((await readBody(req)) ?? {}) as JsonRecord;
        const name = str(body, "name");
        const config = v2Mcp(body.config);
        if (!name || !config) return namedError(res, 400, "BadRequestError", "name and config are required");
        await call("PUT", `/api/experimental/mcp/${encodeURIComponent(name)}`, { directory: dir, body: { config } });
        json(res, 200, await mcpStatuses(dir));
        return;
      }
      const name = String(segments[1] ?? "");
      const encodedName = encodeURIComponent(name);
      if ((segments[2] === "connect" || segments[2] === "disconnect") && method === "POST") {
        await call("POST", `/api/experimental/mcp/${encodedName}/${segments[2]}`, { directory: dir, body: {} });
        json(res, 200, true);
        return;
      }
      if (segments[2] === "auth") {
        const integration = await mcpIntegration(name, dir);
        if (method === "DELETE" && segments.length === 3) {
          for (const connection of arr(integration, "connections")) {
            if (str(connection, "type") === "credential" && str(connection, "id")) {
              await call("DELETE", `/api/credential/${encodeURIComponent(String(str(connection, "id")))}`).catch(() => undefined);
            }
          }
          json(res, 200, { success: true });
          return;
        }
        if (!integration) return namedError(res, 400, "UnsupportedOAuthError", `MCP server ${name} does not support OAuth`);
        const integrationID = encodeURIComponent(String(str(integration, "id")));
        const method0 = arr(integration, "methods").find((candidate) => str(candidate, "type") === "oauth");
        const start = async (): Promise<JsonRecord> => {
          const attempt = unwrap(await call("POST", `/api/integration/${integrationID}/connect/oauth`, {
            directory: dir,
            body: { methodID: str(method0, "id") ?? "oauth" },
          }));
          const record0 = isRecord(attempt) ? attempt : {};
          mcpAttempts.set(`${dir}\u0000${name}`, { integrationID, attemptID: String(str(record0, "attemptID") ?? str(record0, "id") ?? "") });
          return record0;
        };
        if (segments.length === 3 && method === "POST") {
          const attempt = await start();
          json(res, 200, { authorizationUrl: str(attempt, "url") ?? "" });
          return;
        }
        if (segments[3] === "callback" && method === "POST") {
          const body = ((await readBody(req)) ?? {}) as JsonRecord;
          const pending = mcpAttempts.get(`${dir}\u0000${name}`);
          if (!pending) return namedError(res, 400, "BadRequestError", "No OAuth attempt is pending for this server");
          await call("POST", `/api/integration/${pending.integrationID}/connect/oauth/${encodeURIComponent(pending.attemptID)}/complete`, {
            directory: dir,
            body: omitUndefined({ code: str(body, "code") }),
          }).catch(() => undefined);
          await waitMcpAttempt(pending, dir, 30_000);
          await call("POST", `/api/experimental/mcp/${encodedName}/connect`, { directory: dir, body: {} }).catch(() => undefined);
          json(res, 200, (await mcpStatuses(dir))[name] ?? { status: "failed", error: "unknown server" });
          return;
        }
        if (segments[3] === "authenticate" && method === "POST") {
          const attempt = await start();
          const url0 = str(attempt, "url");
          if (url0) openInBrowser(url0);
          const pending = mcpAttempts.get(`${dir}\u0000${name}`)!;
          await waitMcpAttempt(pending, dir, 5 * 60_000);
          await call("POST", `/api/experimental/mcp/${encodedName}/connect`, { directory: dir, body: {} }).catch(() => undefined);
          json(res, 200, (await mcpStatuses(dir))[name] ?? { status: "failed", error: "unknown server" });
          return;
        }
      }
    }
    if (method === "POST" && path === "/omnirush/todos") {
      // The plugin bridge's todo list tool: remembered per session and announced as the 1.x event.
      const body = ((await readBody(req)) ?? {}) as JsonRecord;
      const sessionID = str(body, "sessionID");
      if (sessionID) {
        const list = arr(body, "todos").filter(isRecord);
        todos.set(sessionID, list);
        dispatch([{ directory: translator.directoryOf(sessionID), event: { type: "todo.updated", properties: { sessionID, todos: list } } }]);
      }
      json(res, 200, true);
      return;
    }
    if (method === "POST" && path === "/omnirush/engine-tools") {
      // The plugin bridge reports the tools the engine offers (1.x names) for the tool listing routes.
      const body = ((await readBody(req)) ?? {}) as JsonRecord;
      const tools = arr(body, "tools").filter(isRecord).map((tool) => ({ id: String(tool.id ?? ""), description: String(tool.description ?? ""), parameters: isRecord(tool.parameters) ? tool.parameters : {} })).filter((tool) => tool.id);
      engineTools.set(str(body, "directory") ?? dir, tools);
      json(res, 200, true);
      return;
    }
    if (method === "GET" && path === "/path") {
      json(res, 200, { home: homedir(), state: options.paths?.state ?? "", config: options.paths?.config ?? "", worktree: dir, directory: dir });
      return;
    }
    if (method === "GET" && (path === "/project/current" || path === "/project")) {
      const location = unwrap(await call("GET", "/api/location", { directory: dir }).catch(() => undefined));
      const project = record(location, "project");
      const info = omitUndefined({
        id: str(project, "id") ?? "global",
        worktree: str(project, "canonical") ?? str(project, "worktree") ?? dir,
        vcs: str(project, "vcs") === "git" ? "git" : undefined,
        time: { created: num(record(project, "time"), "created") ?? Date.now(), updated: num(record(project, "time"), "updated") ?? Date.now() },
        sandboxes: [],
      });
      json(res, 200, path === "/project" ? [info] : info);
      return;
    }
    if (method === "GET" && path === "/vcs") {
      const branch = unwrap(await call("GET", "/api/vcs/branch", { directory: dir }).catch(() => undefined));
      json(res, 200, { branch: typeof branch === "string" ? branch : str(branch, "branch") ?? str(branch, "name") ?? null, default_branch: null });
      return;
    }
    if (method === "GET" && (path === "/lsp" || path === "/formatter" || path === "/file/status")) {
      json(res, 200, []);
      return;
    }
    if (method === "GET" && path === "/find/file") {
      const payload = await call("GET", "/api/fs/find", { directory: dir, query: { query: url.searchParams.get("query") ?? "", limit: url.searchParams.get("limit") ?? "50" } });
      const list = unwrap(payload);
      json(res, 200, (Array.isArray(list) ? list : []).map((item) => (typeof item === "string" ? item : str(item, "path") ?? str(item, "file") ?? "")).filter(Boolean));
      return;
    }
    if (method === "GET" && path === "/file") {
      const payload = await call("GET", "/api/fs/list", { directory: dir, query: { path: url.searchParams.get("path") ?? "." } });
      const list = unwrap(payload);
      json(res, 200, (Array.isArray(list) ? list : arr(list, "entries")).filter(isRecord).map((entry) => ({
        name: str(entry, "name") ?? "",
        path: str(entry, "path") ?? str(entry, "name") ?? "",
        absolute: str(entry, "absolute") ?? "",
        type: str(entry, "type") === "directory" ? "directory" : "file",
        ignored: entry.ignored === true,
      })));
      return;
    }
    if (method === "GET" && path === "/experimental/tool/ids") {
      const tools = engineTools.get(dir);
      json(res, 200, tools ? tools.map((tool) => tool.id) : [...BUILTIN_TOOL_IDS]);
      return;
    }
    if (method === "GET" && path === "/experimental/tool") {
      json(res, 200, engineTools.get(dir) ?? []);
      return;
    }
    if (method === "POST" && (path === "/instance/dispose" || path === "/global/dispose")) {
      await refreshConfig();
      await requestLocationReload(dir);
      json(res, 200, true);
      return;
    }
    if (method === "POST" && (path === "/log" || path.startsWith("/tui/"))) {
      await readBody(req);
      json(res, 200, true);
      return;
    }
    namedError(res, 404, "NotFoundError", `${method} ${path} is not served by the OmniRush.ai engine adapter`);
  };

  const server = http.createServer((req, res) => {
    if ((req.headers.authorization ?? "") !== expectedAuth) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="opencode"' });
      res.end();
      return;
    }
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof UpstreamError) {
        if (error.status >= 500) log("engine request failed", { url: req.url, status: error.status });
        const body = error.body;
        const message = isRecord(body) ? str(body, "message") ?? str(record(body, "data"), "message") ?? JSON.stringify(body) : String(body ?? error.message);
        const name = isRecord(body) ? str(body, "name") ?? str(body, "_tag") ?? str(body, "code") ?? "EngineError" : "EngineError";
        json(res, error.status, { name, data: { message } });
        return;
      }
      log("engine adapter request failed", { url: req.url, error: error instanceof Error ? error.message : String(error) });
      json(res, 500, { name: "UnknownError", data: { message: error instanceof Error ? error.message : String(error) } });
    });
  });
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("engine adapter did not bind");
  const host = options.hostname ?? "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  await refreshConfig().catch((error) => log("engine config render failed", { error: error instanceof Error ? error.message : String(error) }));
  ensureStream();

  return {
    url,
    refreshConfig,
    close: async () => {
      facadeClosed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = null;
      streamController.abort();
      // Event streams stay open until ended; end them so the server can close.
      for (const subscriber of subscribers) {
        subscribers.delete(subscriber);
        try {
          subscriber.end();
        } catch {
          // already closed
        }
      }
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref?.())]);
    },
  };
}
