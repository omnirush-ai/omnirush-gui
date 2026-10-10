// "Good session ★" from the server (GET /omnirush/integrity/:sessionId, the
// integrity record's `good_session`). The copy is settled and the same, word
// for word, as the CLI's (integrity-api-contract.md, "Good-session copy").
// Never "Good session" before the server confirms it; never a raw code.

import type { OmniRushGoodSession } from "./omnirush-server";

export const GOOD_SESSION_CONFIRMED = "Good session ★";
export const GOOD_SESSION_CHECKING = "Checking session…";
export const REWARDS_GUIDE_LABEL = "How rewards work";
export const REWARDS_GUIDE_URL = "https://omnirush.ai/console/guide/rewards";

const FIX_UPLOADS = "Keep the app open until uploads finish.";
const FIX_QUALITY = "Give the agent a real task and see it through.";
const QUALITY_FALLBACK = "it didn't pass the quality check";

const UPLOAD_REASONS: Readonly<Record<string, string>> = Object.freeze({
  trace_failed: "the session record failed to save",
  archive_no_base: "the project copy is incomplete",
  archive_gap: "the project copy is incomplete",
  archive_failed: "the project copy is incomplete",
  sequence_gaps: "parts of the session are missing",
  segment_start_missing: "parts of the session are missing",
  no_trace: "parts of the session are missing",
});

export type GoodSessionCopy =
  | { state: "good"; text: string }
  | { state: "pending"; text: string }
  | { state: "not-good"; text: string; reason: string; fix: string; link: { label: string; url: string } };

/** The reason text and its one fix; anything outside the upload table is a quality reason. */
function reasonCopy(code: string | undefined, messages: Readonly<Record<string, string>> | undefined): { reason: string; fix: string } {
  const upload = code ? UPLOAD_REASONS[code] : undefined;
  if (upload) return { reason: upload, fix: FIX_UPLOADS };
  // The server's sentence, without its own full stop (the line adds one).
  const human = code ? messages?.[code]?.trim().replace(/[.\s]+$/, "") : undefined;
  return { reason: human || QUALITY_FALLBACK, fix: FIX_QUALITY };
}

/**
 * The line for one chat: "Good session ★" (true), "Checking session…"
 * (pending, unknown, 404, 429, offline) or "Not a good session: <main
 * reason>. <one fix>" with the rewards guide (false). The main reason is the
 * first of `good_session_reasons`, else the first of `reasons`.
 */
export function goodSessionCopy(result: OmniRushGoodSession | null | undefined): GoodSessionCopy {
  if (result?.good_session === true) return { state: "good", text: GOOD_SESSION_CONFIRMED };
  if (result?.good_session !== false) return { state: "pending", text: GOOD_SESSION_CHECKING };
  const code = result.good_session_reasons[0] ?? result.reasons[0];
  const { reason, fix } = reasonCopy(code, result.messages);
  return {
    state: "not-good",
    text: `Not a good session: ${reason}. ${fix}`,
    reason,
    fix,
    link: { label: REWARDS_GUIDE_LABEL, url: REWARDS_GUIDE_URL },
  };
}

/** After a turn ends, the first check waits this long (late uploads land first). */
export const GOOD_SESSION_TURN_END_DELAY_MS = 5_000;
/** While "pending": 30 s, 1 m, 2 m, 5 m, then every 10 m. */
export const GOOD_SESSION_BACKOFF_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000, 300_000, 600_000]);
/** Pending is retried for up to a day after the last turn. */
export const GOOD_SESSION_RETRY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * When to check again after `pendingChecks` answers in a row were pending:
 * the backoff step, or null once that would pass 24 h after the last turn
 * ended (or the answer is final).
 */
export function nextGoodSessionCheckMs({ result, pendingChecks, lastTurnEndedAt, now }: {
  result: OmniRushGoodSession | null | undefined;
  pendingChecks: number;
  lastTurnEndedAt: number;
  now: number;
}): number | null {
  if (result?.good_session === true || result?.good_session === false) return null;
  const step = GOOD_SESSION_BACKOFF_MS[Math.min(Math.max(pendingChecks, 1), GOOD_SESSION_BACKOFF_MS.length) - 1] ?? 600_000;
  return now + step > lastTurnEndedAt + GOOD_SESSION_RETRY_WINDOW_MS ? null : step;
}
