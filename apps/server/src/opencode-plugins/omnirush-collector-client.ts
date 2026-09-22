// Reports what the engine's browser tools saw to the OmniRush.ai server's
// workspace collector, for the session that owns the tool call. Best effort:
// a failed report never affects the tool result, and nothing is sent without
// the server address and token the server injects into the engine's environment.
const ANCESTRY_DEPTH = 4;
const REPORT_TIMEOUT_MS = 5_000;
/** Client-side bound on page text; the server redacts and applies the contract cap. */
const MAX_TEXT_CHARS = 96_000;

export type CollectorWebVisitReport = {
  url: string;
  title?: string | null;
  text?: string | null;
};

type SessionClient = {
  session?: { get?: (options: { path: { id: string } }) => Promise<unknown> };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverBase(): string | null {
  const base = String(process.env.OMNIRUSH_SERVER_URL || "").trim().replace(/\/+$/, "");
  return base || null;
}

function serverToken(): string | null {
  const token = String(process.env.OMNIRUSH_POLICY_TOKEN || process.env.OMNIRUSH_SERVER_TOKEN || "").trim();
  return token || null;
}

/** Mirrors the server-side rule: only public http(s) pages are ever traced. */
export function isCollectableWebUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || host === "::") return false;
  if (/^127\./.test(host)) return false;
  return true;
}

/**
 * Parent chain of a session (parent, grandparent, ...) so a subagent's visit
 * lands on the root session the collector tracks. Uses the engine SDK client
 * the plugin was created with; stops quietly when it is unavailable.
 */
export async function sessionAncestry(client: unknown, sessionId: string): Promise<string[]> {
  const ancestry: string[] = [];
  const sessions = isRecord(client) ? (client as SessionClient).session : undefined;
  const get = sessions?.get;
  if (typeof get !== "function") return ancestry;
  let current = sessionId;
  for (let depth = 0; depth < ANCESTRY_DEPTH; depth += 1) {
    let result: unknown;
    try {
      result = await get.call(sessions, { path: { id: current } });
    } catch {
      break;
    }
    const data = isRecord(result) && isRecord(result.data) ? result.data : isRecord(result) ? result : null;
    const parent = data && typeof data.parentID === "string" && data.parentID ? data.parentID : null;
    if (!parent || parent === sessionId || ancestry.includes(parent)) break;
    ancestry.push(parent);
    current = parent;
  }
  return ancestry;
}

export function reportWebVisit(client: unknown, sessionId: string, visit: CollectorWebVisitReport): void {
  const base = serverBase();
  const token = serverToken();
  if (!base || !token || !sessionId || typeof visit.url !== "string" || !isCollectableWebUrl(visit.url)) return;
  void (async () => {
    const ancestry = await sessionAncestry(client, sessionId);
    const text = typeof visit.text === "string" ? visit.text.slice(0, MAX_TEXT_CHARS) : null;
    await fetch(`${base}/collector/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ancestry,
        events: [{ type: "web.visit", data: { url: visit.url, title: typeof visit.title === "string" ? visit.title : null, text } }],
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  })().catch(() => undefined);
}
