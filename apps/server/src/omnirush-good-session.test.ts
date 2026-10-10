import { describe, expect, test } from "bun:test";

import { PENDING_GOOD_SESSION, readGoodSession } from "./omnirush-good-session.js";

const ID = "ses_good_session_1";

function answer(response: Response | Error) {
  const calls: Array<{ sessionId: string; summary: boolean }> = [];
  const read = async (sessionId: string, options: { summary: boolean }) => {
    calls.push({ sessionId, summary: options.summary });
    if (response instanceof Error) throw response;
    return response;
  };
  return { read, calls };
}

describe("GET /omnirush/integrity/:sessionId", () => {
  test("passes a 200 through as the compact status, in summary mode", async () => {
    const { read, calls } = answer(Response.json({
      session_id: ID,
      integrity: "ok",
      reasons: [],
      segments: [],
      quality: { verdict: "not_usable", reasons: ["too_short"], messages: { too_short: "The session was too short." } },
      good_session: false,
      good_session_reasons: ["too_short"],
      checked_at: "2026-10-10T10:00:00+00:00",
    }));
    expect(await readGoodSession(read, ID)).toEqual({
      good_session: false,
      reasons: [],
      good_session_reasons: ["too_short"],
      integrity: "ok",
      checked_at: "2026-10-10T10:00:00+00:00",
      messages: { too_short: "The session was too short." },
    });
    expect(calls).toEqual([{ sessionId: ID, summary: true }]);
    const good = await readGoodSession(answer(Response.json({ integrity: "ok", reasons: [], good_session: true, good_session_reasons: [], checked_at: "t" })).read, ID);
    expect(good).toEqual({ good_session: true, reasons: [], good_session_reasons: [], integrity: "ok", checked_at: "t" });
  });

  test("404, 429, errors, odd bodies, no account and bad ids read pending", async () => {
    expect(await readGoodSession(answer(Response.json({ detail: "session_not_found" }, { status: 404 })).read, ID)).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(answer(Response.json({ detail: "rate_limited" }, { status: 429, headers: { "Retry-After": "30" } })).read, ID)).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(answer(new Response("oops", { status: 500 })).read, ID)).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(answer(new TypeError("fetch failed")).read, ID)).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(answer(new Response("not json", { status: 200 })).read, ID)).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(answer(Response.json({ good_session: "yes" })).read, ID)).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(null, ID)).toEqual(PENDING_GOOD_SESSION);
    const bad = answer(Response.json({ good_session: true }));
    expect(await readGoodSession(bad.read, "short")).toEqual(PENDING_GOOD_SESSION);
    expect(await readGoodSession(bad.read, "ses/../x1234")).toEqual(PENDING_GOOD_SESSION);
    expect(bad.calls).toEqual([]);
  });
});
