import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { OmniRushVoiceService, VOICE_MAX_UPLOAD_BYTES, voiceFlagFromCatalog, voiceProjectContext } from "./omnirush-voice.js";

type Call = { url: string; headers: Headers; body: ArrayBuffer | null };

function broker(answer: (call: Call) => Response | Promise<Response>, calls: Call[] = []) {
  return new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "device-access", refreshToken: "device-refresh" },
    engineToken: "local-engine-token",
    fetch: async (input, init) => {
      const call = { url: String(input), headers: new Headers(init?.headers), body: (init?.body as ArrayBuffer | undefined) ?? null };
      calls.push(call);
      return answer(call);
    },
  });
}

function segmentUpload(bytes = 2_000): Request {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "segment-0.wav");
  form.append("segment_index", "0");
  form.append("recording_id", "abc");
  return new Request("http://127.0.0.1/omnirush/voice/transcribe", { method: "POST", body: form });
}

describe("voice catalog flag", () => {
  test("reads features.voice, voice and voice.enabled; null when absent", () => {
    expect(voiceFlagFromCatalog({ object: "list", data: [], features: { voice: true } })).toBe(true);
    expect(voiceFlagFromCatalog({ features: { voice: { enabled: false } } })).toBe(false);
    expect(voiceFlagFromCatalog({ voice: false })).toBe(false);
    expect(voiceFlagFromCatalog({ voice: { enabled: true } })).toBe(true);
    expect(voiceFlagFromCatalog({ object: "list", data: [] })).toBeNull();
    expect(voiceFlagFromCatalog(null)).toBeNull();
  });
});

describe("voice through the gateway broker", () => {
  test("forwards the multipart segment unchanged with the device bearer", async () => {
    const calls: Call[] = [];
    const service = new OmniRushVoiceService(broker(() => Response.json({ text: "hello world", provider: "primary", duration_ms: 900 }), calls));
    const upload = segmentUpload();
    const expected = new Uint8Array(await upload.clone().arrayBuffer());
    const response = await service.transcribe(upload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "hello world", provider: "primary", duration_ms: 900 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.example/omnirush/v1/audio/transcriptions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer device-access");
    expect(calls[0]!.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
    expect(new Uint8Array(calls[0]!.body!)).toEqual(expected);
    expect((await service.availability()).available).toBe(true);
  });

  test("an expired device token is refreshed once and the segment is sent again", async () => {
    const calls: Call[] = [];
    const service = new OmniRushVoiceService(broker((call) => {
      if (call.url.endsWith("/device/refresh")) {
        return Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", gateway_url: "https://gateway.example/omnirush/v1" });
      }
      return call.headers.get("authorization") === "Bearer rotated"
        ? Response.json({ text: "ok" })
        : Response.json({ error: "expired" }, { status: 401 });
    }, calls));
    const response = await service.transcribe(segmentUpload());
    expect(response.status).toBe(200);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/omnirush/v1/audio/transcriptions",
      "/omnirush/device/refresh",
      "/omnirush/v1/audio/transcriptions",
    ]);
    expect(calls[2]!.body!.byteLength).toBe(calls[0]!.body!.byteLength);
  });

  test("503 voice_unavailable is passed on and turns the mic off until it expires", async () => {
    let now = 0;
    const service = new OmniRushVoiceService(
      broker(() => Response.json({ detail: "voice_unavailable" }, { status: 503 })),
      { now: () => now },
    );
    const response = await service.transcribe(segmentUpload());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "voice_unavailable" });
    expect(await service.availability()).toEqual({ available: false, reason: "voice_unavailable" });
    now += 3 * 60_000;
    // Expired: the catalog is asked again (here it answers 503 too, so still unknown).
    expect((await service.availability()).available).toBeNull();
  });

  test("a spent model grant says which limit ran out; without its headers the answer passes as it came", async () => {
    const refusal = (headers: Record<string, string>) => new OmniRushVoiceService(broker(() => Response.json(
      { detail: "daily_grant_exhausted" },
      { status: 429, headers: { "retry-after": "60", ...headers } },
    )));
    const empty = await refusal({ "x-omnirush-grant-scope": "empty" }).transcribe(segmentUpload());
    expect(empty.status).toBe(429);
    expect(empty.headers.get("retry-after")).toBe("60");
    expect(await empty.json()).toEqual({
      error: {
        code: "daily_grant_exhausted",
        message: "You have no tokens left. Link Discord or connect GitHub in the console to earn tokens every day: https://gateway.example/console/account",
      },
    });
    const day = await refusal({ "x-omnirush-grant-scope": "day" }).transcribe(segmentUpload());
    expect(((await day.json()) as { error: { message: string } }).error.message).toBe("Today's tokens are used up. They refill at 00:00 UTC.");
    const older = await refusal({}).transcribe(segmentUpload());
    expect(await older.json()).toEqual({ detail: "daily_grant_exhausted" });
  });

  test("an older backend without the route (404) reads as voice unavailable", async () => {
    const service = new OmniRushVoiceService(broker(() => new Response("not found", { status: 404 })));
    const response = await service.transcribe(segmentUpload());
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("voice_unavailable");
  });

  test("availability comes from the backend's voice status route", async () => {
    const calls: Call[] = [];
    const on = new OmniRushVoiceService(broker((call) => call.url.endsWith("/audio/transcriptions")
      ? Response.json({ object: "voice.status", available: true, reason: null, privacy: { audio_stored_by_omnirush: false, provider_retention_days: 30 }, usage: { remaining_seconds_today: 3_540 } })
      : Response.json({ object: "list", data: [] }), calls));
    expect(await on.availability()).toEqual({ available: true, reason: null, providerRetentionDays: 30, remainingSecondsToday: 3_540 });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/omnirush/v1/audio/transcriptions"]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer device-access");
    // Cached: no second request.
    await on.availability();
    expect(calls).toHaveLength(1);

    const off = new OmniRushVoiceService(broker(() => Response.json({ available: false, reason: "voice_unavailable" })));
    expect((await off.availability()).available).toBe(false);
  });

  test("a backend without the voice route (404) has no voice; one that cannot answer falls back to the catalog flag", async () => {
    const old = new OmniRushVoiceService(broker((call) => call.url.endsWith("/audio/transcriptions")
      ? Response.json({ detail: "Not Found" }, { status: 404 })
      : Response.json({ object: "list", data: [] })));
    expect(await old.availability()).toEqual({ available: false, reason: "voice_unavailable" });
    const flagged = new OmniRushVoiceService(broker((call) => call.url.endsWith("/audio/transcriptions")
      ? new Response("bad gateway", { status: 502 })
      : Response.json({ object: "list", data: [], features: { voice: false } })));
    expect(await flagged.availability()).toEqual({ available: false, reason: "voice_unavailable" });
    const unknown = new OmniRushVoiceService(broker(() => new Response("bad gateway", { status: 502 })));
    expect(await unknown.availability()).toEqual({ available: null, reason: null });
  });

  test("oversize and non-multipart uploads are refused locally, and nothing is sent", async () => {
    const calls: Call[] = [];
    const service = new OmniRushVoiceService(broker(() => Response.json({ text: "x" }), calls));
    expect((await service.transcribe(segmentUpload(VOICE_MAX_UPLOAD_BYTES + 1))).status).toBe(413);
    const json = new Request("http://127.0.0.1/omnirush/voice/transcribe", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await service.transcribe(json)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("signed out: 401 and no upstream call", async () => {
    const service = new OmniRushVoiceService(new OmniRushGatewayBroker({ engineToken: "t" }));
    expect((await service.transcribe(segmentUpload())).status).toBe(401);
    expect(await service.availability()).toEqual({ available: false, reason: "omnirush_account_required" });
  });

  test("logs carry sizes and status only, never the transcript", async () => {
    const lines: string[] = [];
    const service = new OmniRushVoiceService(broker(() => Response.json({ text: "my secret sentence" })), {
      log: (level, message, attributes) => lines.push(JSON.stringify({ level, message, attributes })),
    });
    await service.transcribe(segmentUpload());
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).toContain("\"status\":200");
  });

  test("the engine-facing broker mount allows the transcription path", async () => {
    const calls: Call[] = [];
    const gateway = broker(() => Response.json({ text: "via mount" }), calls);
    const upload = segmentUpload();
    const response = await gateway.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer local-engine-token", "content-type": upload.headers.get("content-type")! },
      body: await upload.arrayBuffer(),
    }), "audio/transcriptions");
    expect(response.status).toBe(200);
    expect(calls[0]!.url).toBe("https://gateway.example/omnirush/v1/audio/transcriptions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer device-access");
  });
});

describe("voice project context", () => {
  test("names the repository and branch of a git folder, or just the folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "voice-ctx-"));
    const repo = path.join(root, "my-repo");
    execFileSync("git", ["init", "-q", "-b", "feat/voice-mode", repo]);
    expect(await voiceProjectContext(repo)).toEqual({ repo: "my-repo", branch: "feat/voice-mode" });
    expect(await voiceProjectContext(root)).toEqual({ repo: path.basename(root), branch: null });
    expect(await voiceProjectContext(null)).toEqual({ repo: null, branch: null });
  });
});

describe("voice for an OmniRush Work company account", () => {
  function companyBroker(answer: () => Response, company: boolean) {
    return new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "device-access", refreshToken: "device-refresh" },
      engineToken: "local-engine-token",
      fetch: async () => answer(),
      companyAccount: () => company,
    });
  }
  const COMPANY = /^Your company's usage limit is reached for now\. It resets \d{1,2}:\d{2}( [AP]M)? \(in 3 h\)\.$/;

  test("a spent voice budget or grant is the company's usage limit, by the gateway's mark or enterprise mode", async () => {
    const now = Date.parse("2037-09-23T21:00:00Z");
    const budget = (headers: Record<string, string>, company: boolean) => new OmniRushVoiceService(companyBroker(() => Response.json(
      { detail: "voice_daily_budget_exhausted" },
      { status: 429, headers: { "retry-after": "10800", ...headers } },
    ), company), { now: () => now });
    for (const [headers, company] of [[{ "x-omnirush-limit-owner": "company" }, false], [{}, true]] as const) {
      const answer = await budget(headers, company).transcribe(segmentUpload());
      expect(answer.status).toBe(429);
      expect(answer.headers.get("retry-after")).toBe("10800");
      const body = (await answer.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("voice_daily_budget_exhausted");
      // 21:00 UTC + 3 h: the next UTC midnight, on this machine's clock.
      expect(body.error.message).toStartWith("Your company's usage limit is reached for now. It resets ");
      expect(body.error.message).toEndWith("(in 3 h).");
    }
    const grant = new OmniRushVoiceService(companyBroker(() => Response.json(
      { detail: "daily_grant_exhausted" },
      { status: 429, headers: { "retry-after": "10800", "x-omnirush-grant-scope": "day", "x-omnirush-grant-resets-at": new Date(Date.now() + 3 * 3_600_000).toISOString(), "x-omnirush-limit-owner": "company" } },
    ), false));
    const spent = (await (await grant.transcribe(segmentUpload())).json()) as { error: { message: string } };
    expect(spent.error.message).toMatch(COMPANY);
  });

  test("a consumer's spent voice budget passes as it came", async () => {
    const service = new OmniRushVoiceService(companyBroker(() => Response.json(
      { detail: "voice_daily_budget_exhausted" },
      { status: 429, headers: { "retry-after": "10800" } },
    ), false));
    const answer = await service.transcribe(segmentUpload());
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ detail: "voice_daily_budget_exhausted" });
  });
});
