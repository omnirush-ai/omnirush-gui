/**
 * "Good session ★" for one chat, from the server's integrity record (GET
 * `<gateway root>/me/sessions/{id}/integrity?summary=1`, through the
 * broker's limiter). The app's checklist bar reads it from
 * GET /omnirush/integrity/:sessionId. Anything but a usable 200 (404, 429,
 * offline, signed out, an odd body) is "pending", never an error.
 */

export const GOOD_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type GoodSessionStatus = {
  good_session: true | false | "pending";
  reasons: string[];
  good_session_reasons: string[];
  integrity: string | null;
  checked_at: string | null;
  /** The server's human message per quality reason code, when it sends them. */
  messages?: Record<string, string>;
};

export const PENDING_GOOD_SESSION: GoodSessionStatus = Object.freeze({
  good_session: "pending",
  reasons: [],
  good_session_reasons: [],
  integrity: null,
  checked_at: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === "string" && code.length > 0).slice(0, 32) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function messages(...sources: unknown[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const [code, message] of Object.entries(source)) {
      const value = text(message);
      if (value && !(code in out)) out[code] = value.slice(0, 300);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** The compact status from one integrity answer; "pending" for anything but a well-formed 200. */
export async function goodSessionFromResponse(response: Response): Promise<GoodSessionStatus> {
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return PENDING_GOOD_SESSION;
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) return PENDING_GOOD_SESSION;
  const good = body.good_session;
  if (good !== true && good !== false && good !== "pending") return PENDING_GOOD_SESSION;
  const quality = isRecord(body.quality) ? body.quality : null;
  const human = messages(body.messages, quality?.messages);
  return {
    good_session: good,
    reasons: codes(body.reasons),
    good_session_reasons: codes(body.good_session_reasons),
    integrity: text(body.integrity),
    checked_at: text(body.checked_at),
    ...(human ? { messages: human } : {}),
  };
}

/** Reads one chat's status; any failure (no account, offline, limited) is "pending". */
export async function readGoodSession(
  sessionIntegrity: ((sessionId: string, options: { summary: boolean }) => Promise<Response>) | null,
  sessionId: string,
): Promise<GoodSessionStatus> {
  if (!sessionIntegrity || !GOOD_SESSION_ID_PATTERN.test(sessionId)) return PENDING_GOOD_SESSION;
  try {
    return await goodSessionFromResponse(await sessionIntegrity(sessionId, { summary: true }));
  } catch {
    return PENDING_GOOD_SESSION;
  }
}
