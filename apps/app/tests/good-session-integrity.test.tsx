import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GOOD_SESSION_BACKOFF_MS,
  GOOD_SESSION_RETRY_WINDOW_MS,
  goodSessionCopy,
  nextGoodSessionCheckMs,
} from "../src/app/lib/good-session-integrity";
import type { OmniRushGoodSession } from "../src/app/lib/omnirush-server";
import { GoodSessionLine } from "../src/react-app/domains/quality/good-session";

function result(input: Partial<OmniRushGoodSession> & Pick<OmniRushGoodSession, "good_session">): OmniRushGoodSession {
  return { reasons: [], good_session_reasons: [], integrity: null, checked_at: null, ...input };
}

const notGood = (reasons: string[], extra: Partial<OmniRushGoodSession> = {}) =>
  goodSessionCopy(result({ good_session: false, good_session_reasons: reasons, ...extra })).text;

const UPLOADS = "Keep the app open until uploads finish.";
const QUALITY = "Give the agent a real task and see it through.";

describe("goodSessionCopy", () => {
  test("true is the only Good session ★", () => {
    expect(goodSessionCopy(result({ good_session: true, integrity: "ok" }))).toEqual({ state: "good", text: "Good session ★" });
  });

  test("pending, unknown, 404, 429 and offline read Checking session…", () => {
    for (const value of [result({ good_session: "pending", reasons: ["archive_uploading"] }), null, undefined]) {
      expect(goodSessionCopy(value)).toEqual({ state: "pending", text: "Checking session…" });
    }
  });

  test("every row of the reason table", () => {
    expect(notGood(["trace_failed"])).toBe(`Not a good session: the session record failed to save. ${UPLOADS}`);
    for (const code of ["archive_no_base", "archive_gap", "archive_failed"]) {
      expect(notGood([code])).toBe(`Not a good session: the project copy is incomplete. ${UPLOADS}`);
    }
    for (const code of ["sequence_gaps", "segment_start_missing", "no_trace"]) {
      expect(notGood([code])).toBe(`Not a good session: parts of the session are missing. ${UPLOADS}`);
    }
    expect(notGood(["not_usable"])).toBe(`Not a good session: it didn't pass the quality check. ${QUALITY}`);
    expect(notGood(["too_short"])).toBe(`Not a good session: it didn't pass the quality check. ${QUALITY}`);
    expect(notGood([])).toBe(`Not a good session: it didn't pass the quality check. ${QUALITY}`);
  });

  test("false links the rewards guide", () => {
    const copy = goodSessionCopy(result({ good_session: false, good_session_reasons: ["trace_failed"] }));
    expect(copy).toMatchObject({ state: "not-good", link: { label: "How rewards work", url: "https://omnirush.ai/console/guide/rewards" } });
  });

  test("the main reason: good_session_reasons first, then reasons", () => {
    expect(notGood(["archive_gap", "trace_failed"], { reasons: ["trace_failed"] })).toContain("the project copy is incomplete.");
    expect(goodSessionCopy(result({ good_session: false, reasons: ["trace_failed", "archive_gap"] })).text)
      .toBe(`Not a good session: the session record failed to save. ${UPLOADS}`);
  });

  test("a quality reason uses the server's human message when there is one", () => {
    const messages = { too_short: "the session was too short.", trace_failed: "ignored" };
    expect(notGood(["too_short"], { messages })).toBe(`Not a good session: the session was too short. ${QUALITY}`);
    expect(notGood(["padding"], { messages })).toBe(`Not a good session: it didn't pass the quality check. ${QUALITY}`);
    // Upload reasons keep the table's words.
    expect(notGood(["trace_failed"], { messages })).toBe(`Not a good session: the session record failed to save. ${UPLOADS}`);
  });

  test("never shows a raw code", () => {
    const codes = ["trace_failed", "archive_no_base", "sequence_gaps", "no_trace", "not_usable", "too_short", "quality_unavailable", "trace_not_in_s3"];
    for (const code of codes) {
      for (const value of [true, false, "pending"] as const) {
        const text = goodSessionCopy(result({ good_session: value, reasons: [code], good_session_reasons: [code] })).text;
        expect(text).not.toContain(code);
      }
    }
  });

  test("the line renders each state", () => {
    expect(renderToStaticMarkup(<GoodSessionLine result={result({ good_session: true })} />)).toContain("Good session ★");
    const pending = renderToStaticMarkup(<GoodSessionLine result={null} />);
    expect(pending).toContain("Checking session…");
    expect(pending).toContain("text-muted-foreground");
    expect(pending).not.toContain("<svg");
    const bad = renderToStaticMarkup(<GoodSessionLine result={result({ good_session: false, good_session_reasons: ["no_trace"] })} />);
    expect(bad).toContain("Not a good session: parts of the session are missing.");
    expect(bad).toContain("How rewards work");
  });
});

describe("nextGoodSessionCheckMs", () => {
  const ended = 1_000_000;

  test("pending backs off 30 s, 1 m, 2 m, 5 m, then 10 m", () => {
    const waits = [1, 2, 3, 4, 5, 6, 9].map((pendingChecks) => nextGoodSessionCheckMs({ result: null, pendingChecks, lastTurnEndedAt: ended, now: ended }));
    expect(waits).toEqual([30_000, 60_000, 120_000, 300_000, 600_000, 600_000, 600_000]);
    expect(GOOD_SESSION_BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000, 600_000]);
    expect(nextGoodSessionCheckMs({ result: result({ good_session: "pending" }), pendingChecks: 1, lastTurnEndedAt: ended, now: ended })).toBe(30_000);
  });

  test("true and false are final", () => {
    for (const value of [true, false] as const) {
      expect(nextGoodSessionCheckMs({ result: result({ good_session: value }), pendingChecks: 1, lastTurnEndedAt: ended, now: ended })).toBeNull();
    }
  });

  test("stops 24 h after the last turn", () => {
    const late = ended + GOOD_SESSION_RETRY_WINDOW_MS - 600_000;
    expect(nextGoodSessionCheckMs({ result: null, pendingChecks: 9, lastTurnEndedAt: ended, now: late })).toBe(600_000);
    expect(nextGoodSessionCheckMs({ result: null, pendingChecks: 9, lastTurnEndedAt: ended, now: late + 1 })).toBeNull();
    expect(nextGoodSessionCheckMs({ result: null, pendingChecks: 1, lastTurnEndedAt: ended, now: ended + 3 * GOOD_SESSION_RETRY_WINDOW_MS })).toBeNull();
  });
});
