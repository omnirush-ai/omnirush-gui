import type { AnalyticsProperties } from "./analytics";

/**
 * Which omnirush.ai refusal an error card shows, for product analytics:
 * a spent allowance or cap (`limit_shown`) or the request policy
 * (`policy_refusal_shown`). Keys on the gateway's stable `error.omnirush`
 * code; an error without one (an older backend) falls back to the error's
 * title and technical details. Returns coarse labels, never the text.
 */
export type GatewayRefusalEvent = { event: "limit_shown" | "policy_refusal_shown"; properties: AnalyticsProperties };

/** The fields of the gateway's `error.omnirush` this reads (session-error.ts parses it). */
type OmniRushErrorDetails = { code: string; scope?: string; retry?: boolean };

const POLICY = /request_policy_refused|OmniRush can[’']t help with this request/i;
const GRANT_DAY = /today[’']s tokens are used up|used today[’']s model allowance/i;
const GRANT_WEEK = /this week[’']s cap is reached/i;
const GRANT_EMPTY = /you have no tokens left/i;
const GRANT = /daily_grant_exhausted/i;
// An OmniRush Work company account's usage limit (the local server's words for it).
const COMPANY = /company[’']s usage limit is reached/i;
const SESSION_CAP = /session_quality_cap/i;

/** `error.omnirush.code` -> the event and its `limit_type` (null: the policy refusal). */
const BY_CODE: Record<string, { event: GatewayRefusalEvent["event"]; limitType: string | null; scope: string | null }> = {
  request_policy_refused: { event: "policy_refusal_shown", limitType: null, scope: null },
  limit_tokens: { event: "limit_shown", limitType: "tokens", scope: "unknown" },
  limit_session_cap: { event: "limit_shown", limitType: "session_cap", scope: "session" },
  limit_concurrency: { event: "limit_shown", limitType: "concurrency", scope: "unknown" },
  limit_rate: { event: "limit_shown", limitType: "rate", scope: "unknown" },
  queue_timeout: { event: "limit_shown", limitType: "queue_timeout", scope: null },
};

function fromCode(details: OmniRushErrorDetails): GatewayRefusalEvent | null {
  const known = BY_CODE[details.code];
  if (!known) return null;
  const properties: AnalyticsProperties = { code: details.code, source: "code" };
  if (typeof details.retry === "boolean") properties.retry = details.retry;
  if (known.event === "policy_refusal_shown") return { event: known.event, properties: { reason: "request_policy", ...properties } };
  const scope = details.scope ?? known.scope;
  return { event: known.event, properties: { limit_type: known.limitType, ...(scope ? { scope } : {}), ...properties } };
}

function fromText(text: string): GatewayRefusalEvent | null {
  const fallback = { source: "text" } as const;
  if (POLICY.test(text)) return { event: "policy_refusal_shown", properties: { reason: "request_policy", ...fallback } };
  if (GRANT_DAY.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "day", ...fallback } };
  if (GRANT_WEEK.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "week", ...fallback } };
  if (GRANT_EMPTY.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "empty", ...fallback } };
  if (GRANT.test(text) || COMPANY.test(text)) return { event: "limit_shown", properties: { limit_type: "tokens", scope: "unknown", ...fallback } };
  if (SESSION_CAP.test(text)) return { event: "limit_shown", properties: { limit_type: "session_cap", scope: "session", ...fallback } };
  return null;
}

export function gatewayRefusalEvent(
  error: { title?: string | null; technicalDetails?: string | null; omnirush?: OmniRushErrorDetails | null } | null | undefined,
): GatewayRefusalEvent | null {
  if (!error) return null;
  // A code this app does not know is an ordinary error, unless its text says otherwise.
  const coded = error.omnirush ? fromCode(error.omnirush) : null;
  return coded ?? fromText(`${error.title ?? ""}\n${error.technicalDetails ?? ""}`);
}
