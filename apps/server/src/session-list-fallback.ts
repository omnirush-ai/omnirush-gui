/**
 * Keep a local workspace's session list answerable.
 *
 * The engine's GET /session is instance-scoped: the first request for a
 * directory waits for that directory's instance to boot (git probes, config,
 * plugin installs), which can take well over the app's request timeout on a
 * cold Windows start. It also matches sessions by the stored project id AND
 * the exact canonical directory string, so a renamed, re-cased or re-rooted
 * folder, or a recreated .git, lists as empty although its sessions exist.
 *
 * The fallback answers from the engine's global session index instead
 * (GET /experimental/session, served by the engine's already-booted default
 * instance), filtered here by directory with platform-aware comparison.
 */

export const SESSION_LIST_FALLBACK_DEADLINE_ENV = "OMNIRUSH_SESSION_LIST_FALLBACK_MS";
const DEFAULT_DEADLINE_MS = 6_000;
const PAGE_SIZE = 500;
const MAX_SCANNED = 5_000;
const EMPTY_RESULT_TTL_MS = 60_000;

export type SessionListFallbackCause = "slow" | "empty" | "failed";

export function sessionListFallbackDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SESSION_LIST_FALLBACK_DEADLINE_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

export function isSessionListRequest(method: string, normalizedPath: string): boolean {
  return method.toUpperCase() === "GET" && normalizedPath === "/session";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Comparable form of a directory. Windows paths are case-insensitive and may
 * arrive with backslashes, a `\\?\` prefix, a lower-case drive letter or a
 * trailing separator; the engine stores forward slashes. macOS volumes are
 * case-insensitive by default, so a case-only rename must still match there.
 */
export function directoryMatchKey(directory: string, platform: NodeJS.Platform = process.platform): string {
  let value = directory.trim();
  if (platform === "win32") {
    value = value.replace(/\\/g, "/");
    value = value.replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
    const unc = value.startsWith("//");
    value = (unc ? "//" : "") + value.slice(unc ? 2 : 0).replace(/\/{2,}/g, "/");
  } else {
    value = value.replace(/\/{2,}/g, "/");
  }
  if (value.length > 1 && value.endsWith("/") && !/^[A-Za-z]:\/$/.test(value)) value = value.replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
}

export type SessionListFallbackQuery = {
  roots?: boolean;
  start?: number;
  search?: string;
  limit: number;
};

export function sessionListFallbackQuery(search: string): SessionListFallbackQuery {
  const params = new URLSearchParams(search);
  const limit = Number(params.get("limit"));
  const start = Number(params.get("start"));
  const searchText = params.get("search")?.trim();
  return {
    roots: params.get("roots") === "true" ? true : undefined,
    start: Number.isFinite(start) && start > 0 ? start : undefined,
    search: searchText ? searchText : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100,
  };
}

export type GlobalSessionPage = { items: unknown[]; nextCursor: string | null };

/**
 * Page through the engine's global session index (newest first) and keep the
 * sessions whose directory matches one of `directories`. Archived sessions are
 * included because the instance list includes them too.
 */
export async function listSessionsByDirectory(input: {
  fetchPage: (params: URLSearchParams) => Promise<GlobalSessionPage>;
  directories: string[];
  query: SessionListFallbackQuery;
  platform?: NodeJS.Platform;
  maxScanned?: number;
}): Promise<Record<string, unknown>[]> {
  const platform = input.platform ?? process.platform;
  const keys = new Set(input.directories.filter((entry) => entry.trim()).map((entry) => directoryMatchKey(entry, platform)));
  const matches: Record<string, unknown>[] = [];
  const maxScanned = input.maxScanned ?? MAX_SCANNED;
  let scanned = 0;
  let cursor: string | null = null;
  while (matches.length < input.query.limit && scanned < maxScanned) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), archived: "true" });
    if (input.query.roots) params.set("roots", "true");
    if (input.query.start !== undefined) params.set("start", String(input.query.start));
    if (input.query.search) params.set("search", input.query.search);
    if (cursor) params.set("cursor", cursor);
    const page = await input.fetchPage(params);
    scanned += page.items.length;
    for (const item of page.items) {
      if (!isRecord(item) || typeof item.directory !== "string") continue;
      if (!keys.has(directoryMatchKey(item.directory, platform))) continue;
      const { project: _project, ...session } = item;
      matches.push(session);
      if (matches.length >= input.query.limit) break;
    }
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return matches;
}

type PrimaryOutcome = { ok: true; response: Response } | { ok: false; error: unknown };

function jsonList(items: unknown[]): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Serve a session list: the engine's own answer when it is quick and
 * non-empty, otherwise the directory index. A slow instance boot keeps
 * running in the background, so the next list is served by the engine again.
 */
export async function serveSessionListWithFallback(input: {
  primary: Promise<Response>;
  /** `cause` says why the index is consulted; "empty" may answer from a negative cache. */
  fallback: (cause: SessionListFallbackCause) => Promise<Record<string, unknown>[]>;
  deadlineMs: number;
  onFallback?: (event: { cause: SessionListFallbackCause; count: number }) => void;
}): Promise<Response> {
  const primary: Promise<PrimaryOutcome> = input.primary.then(
    (response) => ({ ok: true, response }),
    (error: unknown) => ({ ok: false, error }),
  );
  let fallbackRun: Promise<Record<string, unknown>[] | null> | null = null;
  const fallback = (cause: SessionListFallbackCause) => {
    fallbackRun ??= input.fallback(cause).catch(() => null);
    return fallbackRun;
  };
  const served = (cause: SessionListFallbackCause, items: Record<string, unknown>[]) => {
    input.onFallback?.({ cause, count: items.length });
    return jsonList(items);
  };

  const finish = async (outcome: PrimaryOutcome): Promise<Response> => {
    if (!outcome.ok) {
      const items = await fallback("failed");
      if (items) return served("failed", items);
      throw outcome.error;
    }
    const { response } = outcome;
    if (!response.ok) {
      const items = await fallback("failed");
      return items ? served("failed", items) : response;
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      const items = await fallback("empty");
      if (items && items.length > 0) return served("empty", items);
    }
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.deadlineMs);
    timer.unref?.();
  });
  const first = await Promise.race([primary, deadline]);
  if (timer) clearTimeout(timer);
  if (first) return finish(first);

  type Winner = { source: "primary"; outcome: PrimaryOutcome } | { source: "fallback"; items: Record<string, unknown>[] };
  const fromPrimary = primary.then((outcome): Winner => ({ source: "primary", outcome }));
  const winner = await Promise.race<Winner>([
    fromPrimary,
    fallback("slow").then((items): Winner | Promise<Winner> => items ? { source: "fallback", items } : fromPrimary),
  ]);
  if (winner.source === "primary") return finish(winner.outcome);
  // The engine keeps booting the instance; release its eventual answer.
  void primary.then((outcome) => {
    if (outcome.ok) void outcome.response.body?.cancel().catch(() => undefined);
  });
  return served("slow", winner.items);
}

/** Directories known to have no sessions anywhere, so repeated empty lists skip the index scan. */
export class EmptySessionDirectoryCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = EMPTY_RESULT_TTL_MS) {}

  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (this.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  remember(key: string): void {
    this.entries.set(key, this.now());
  }

  forget(key: string): void {
    this.entries.delete(key);
  }
}
