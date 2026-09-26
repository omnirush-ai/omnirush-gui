import { describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  RemoteTranscriber,
  Segmenter,
  VoiceError,
  VoiceSession,
  WavFileSource,
  applyKeyterms,
  buildKeyterms,
  countWords,
  decodeWav,
  encodeWav,
  padInsertion,
  resampleTo16k,
  stitch,
  voiceInputFileFromEnv,
  type TranscribeRequest,
  type Transcriber,
  type VoiceResult,
  type VoiceSnapshot,
} from "../src/app/lib/voice-core";

const RATE = 16_000;

/** Speech stand-in: a voiced tone with a little vibrato at `amplitude`; silence: faint noise. */
function tone(ms: number, amplitude = 0.3): Int16Array {
  const out = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    out[i] = Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * (180 + 20 * Math.sin(2 * Math.PI * 5 * t)) * t));
  }
  return out;
}

function quiet(ms: number, amplitude = 0.001): Int16Array {
  const out = new Int16Array(Math.round((RATE * ms) / 1000));
  let seed = 7;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amplitude * 32767);
  }
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function segmentsOf(pcm: Int16Array, options = {}) {
  const segmenter = new Segmenter(options);
  const out = [];
  // Feed in odd-sized chunks, like an audio callback would.
  for (let at = 0; at < pcm.length; at += 777) out.push(...segmenter.push(pcm.slice(at, at + 777)));
  const last = segmenter.flush();
  if (last) out.push(last);
  return out;
}

describe("segmenter", () => {
  test("silence produces no segment at all", () => {
    expect(segmentsOf(quiet(5_000))).toHaveLength(0);
    expect(segmentsOf(new Int16Array(RATE * 3))).toHaveLength(0);
  });

  test("speech is cut at pauses of 600 ms or more", () => {
    const segments = segmentsOf(concat(quiet(300), tone(1_500), quiet(800), tone(1_400), quiet(900), tone(1_200), quiet(300)));
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    for (const segment of segments) {
      expect(segment.speechMs).toBeGreaterThan(1_000);
      // Lead-in kept, trailing silence trimmed to the tail.
      expect(segment.samples.length / RATE).toBeLessThan(1.5 + 0.2 + 0.3);
    }
    expect(segments[1]!.startMs).toBeGreaterThan(segments[0]!.endMs);
  });

  test("a short phrase is held open across a normal pause so it is not sent alone", () => {
    const segments = segmentsOf(concat(tone(400), quiet(700), tone(1_500), quiet(900)));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.speechMs).toBeGreaterThan(1_800);
  });

  test("a long pause ends even a short phrase", () => {
    expect(segmentsOf(concat(tone(400), quiet(1_700), tone(1_500), quiet(900)))).toHaveLength(2);
  });

  test("continuous speech is cut at 12 s", () => {
    const segments = segmentsOf(tone(15_000));
    expect(segments).toHaveLength(2);
    expect(segments[0]!.samples.length).toBe(12 * RATE);
  });

  test("a click is dropped as noise", () => {
    expect(segmentsOf(concat(quiet(500), tone(60), quiet(2_000)))).toHaveLength(0);
  });

  test("the noise floor adapts: speech over steady room noise still segments, the noise alone does not", () => {
    expect(segmentsOf(quiet(4_000, 0.008))).toHaveLength(0);
    const noisy = concat(quiet(2_000, 0.008), tone(1_500, 0.2), quiet(1_000, 0.008));
    expect(segmentsOf(noisy)).toHaveLength(1);
  });
});

describe("wav", () => {
  test("encode then decode round-trips 16 kHz mono PCM", () => {
    const pcm = tone(250);
    const wav = encodeWav(pcm);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + pcm.length * 2);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.samples.length).toBe(pcm.length);
    expect(Math.round(decoded.samples[100]! * 32768)).toBe(pcm[100]!);
  });

  test("48 kHz float stereo resamples to 16 kHz mono", () => {
    const frames = 4_800;
    const bytes = new Uint8Array(44 + frames * 2 * 4);
    const view = new DataView(bytes.buffer);
    const put = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    put(0, "RIFF");
    view.setUint32(4, bytes.length - 8, true);
    put(8, "WAVE");
    put(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 48_000 * 8, true);
    view.setUint16(32, 8, true);
    view.setUint16(34, 32, true);
    put(36, "data");
    view.setUint32(40, frames * 8, true);
    for (let i = 0; i < frames; i += 1) {
      view.setFloat32(44 + i * 8, 0.5, true);
      view.setFloat32(48 + i * 8, 0.1, true);
    }
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.samples[10]).toBeCloseTo(0.3, 5);
    const pcm = resampleTo16k(decoded.samples, decoded.sampleRate);
    expect(pcm.length).toBe(1_600);
    expect(pcm[5]! / 32767).toBeCloseTo(0.3, 3);
  });

  test("the file input hook is read from the environment", () => {
    expect(voiceInputFileFromEnv({ OMNIRUSH_VOICE_INPUT_FILE: " /tmp/clip.wav " })).toBe("/tmp/clip.wav");
    expect(voiceInputFileFromEnv({})).toBeNull();
  });
});

describe("text", () => {
  test("stitch joins segment texts in order with the right spacing", () => {
    expect(stitch(["And so, my fellow Americans,", "ask not", " ", "what your country can do."])).toBe(
      "And so, my fellow Americans, ask not what your country can do.",
    );
    expect(stitch(["Hello", ", world", "!"])).toBe("Hello, world!");
    expect(stitch(["東京に", "行きます"])).toBe("東京に行きます");
  });

  test("insertion at the cursor gets separating spaces only where needed", () => {
    expect(padInsertion("Fix the", "parser bug", "please")).toBe(" parser bug ");
    expect(padInsertion("Fix the ", "parser bug", " please")).toBe("parser bug");
    expect(padInsertion("", "hello", "")).toBe("hello");
    expect(padInsertion("(", "note", ")")).toBe("note");
    expect(padInsertion("日本", "語", "")).toBe("語");
  });

  test("words are counted with CJK characters one by one", () => {
    expect(countWords("refactor the OAuth middleware")).toBe(4);
    expect(countWords("東京に行きます")).toBe(7);
    expect(countWords("  ")).toBe(0);
  });
});

describe("keyterms", () => {
  test("built from the repository, branch and files, capped at 50 terms / 1024 chars", () => {
    const terms = buildKeyterms({ repo: "omnirush-gui", branch: "feat/voice-mode", files: ["src/useVoiceDictation.ts", "a/b/segmenter.ts"] });
    expect(terms).toContain("omnirush-gui");
    expect(terms).toContain("voice");
    expect(terms).toContain("useVoiceDictation.ts");
    expect(terms).toContain("Dictation");
    expect(terms.filter((t) => t.toLowerCase() === "omnirush")).toHaveLength(1);
    const many = buildKeyterms({ files: Array.from({ length: 200 }, (_, i) => `file${"x".repeat(40)}${i}.ts`) });
    expect(many.length).toBeLessThanOrEqual(50);
    expect(many.join(" ").length).toBeLessThanOrEqual(1024);
  });

  test("post-correction fixes spoken dev terms conservatively", () => {
    expect(applyKeyterms("refactor the oh auth middleware in auth dot ts")).toBe("refactor the OAuth middleware in auth.ts");
    expect(applyKeyterms("push it to git hub and open local host")).toBe("push it to GitHub and open localhost");
    expect(applyKeyterms("open the voice dictation hook", ["VoiceDictation"])).toBe("open the VoiceDictation hook");
    // Plain words and short terms are never rewritten.
    expect(applyKeyterms("the jason file", ["gRPC", "api"])).toBe("the jason file");
  });
});

type Call = { request: TranscribeRequest; signal: AbortSignal };

function fakeTranscriber(answer: (request: TranscribeRequest, attempt: number) => Promise<string> | string): Transcriber & { calls: Call[]; maxActive: number } {
  let active = 0;
  const attempts = new Map<number, number>();
  const self = {
    calls: [] as Call[],
    maxActive: 0,
    async transcribe(request: TranscribeRequest, signal: AbortSignal) {
      self.calls.push({ request, signal });
      active += 1;
      self.maxActive = Math.max(self.maxActive, active);
      const attempt = attempts.get(request.segmentIndex) ?? 0;
      attempts.set(request.segmentIndex, attempt + 1);
      try {
        return { text: await answer(request, attempt) };
      } finally {
        active -= 1;
      }
    },
  };
  return self;
}

async function dictate(pcm: Int16Array, transcriber: Transcriber, options: Partial<ConstructorParameters<typeof VoiceSession>[0]> = {}) {
  const snapshots: VoiceSnapshot[] = [];
  let resolveDone!: (result: VoiceResult) => void;
  const done = new Promise<VoiceResult>((resolve) => {
    resolveDone = resolve;
  });
  const session: VoiceSession = new VoiceSession({
    source: new WavFileSource(encodeWav(pcm), { realtime: false }),
    transcriber,
    retryDelaysMs: [5, 10],
    ...options,
    onChange: (snapshot) => {
      snapshots.push(snapshot);
      if (snapshot.phase === "done" || snapshot.phase === "cancelled" || snapshot.phase === "error") void session.stop().then(resolveDone);
    },
  });
  await session.start();
  return { session, snapshots, result: await done };
}

const THREE_PHRASES = concat(tone(1_500), quiet(800), tone(1_500), quiet(800), tone(1_500), quiet(400));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("voice session", () => {
  test("uploads each segment as a valid 16 kHz WAV and stitches the texts in recording order even when answers arrive out of order", async () => {
    const words = ["refactor the", "OAuth middleware", "in auth dot ts"];
    const transcriber = fakeTranscriber(async (request) => {
      await sleep(40 - request.segmentIndex * 15);
      return words[request.segmentIndex]!;
    });
    const { result, snapshots } = await dictate(THREE_PHRASES, transcriber);
    expect(transcriber.calls).toHaveLength(3);
    expect(transcriber.maxActive).toBeLessThanOrEqual(2);
    for (const { request } of transcriber.calls) {
      const decoded = decodeWav(request.wav);
      expect(decoded.sampleRate).toBe(RATE);
      expect(request.recordingId).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(result.text).toBe("refactor the OAuth middleware in auth.ts");
    expect(result.words).toBe(6);
    expect(result.error).toBeNull();
    // Partial text only ever grows from the start (never shows segment 2 before segment 1).
    const partials = snapshots.map((s) => s.text).filter(Boolean);
    for (const partial of partials) expect(result.text.startsWith(partial.replace(" dot ts", ""))).toBe(true);
  });

  test("a silent recording uploads nothing and reports no signal", async () => {
    const transcriber = fakeTranscriber(() => "Thank you.");
    const { result } = await dictate(new Int16Array(RATE * 3), transcriber);
    expect(transcriber.calls).toHaveLength(0);
    expect(result.text).toBe("");
    expect(result.error?.kind).toBe("no_signal");
  });

  test("room noise without speech uploads nothing and reports no speech", async () => {
    const transcriber = fakeTranscriber(() => "x");
    const { result } = await dictate(quiet(3_000, 0.006), transcriber);
    expect(transcriber.calls).toHaveLength(0);
    expect(result.error?.kind).toBe("no_speech");
  });

  test("a stock hallucination from short audio is dropped", async () => {
    const transcriber = fakeTranscriber(() => "Thank you.");
    const { result } = await dictate(concat(tone(400), quiet(2_000)), transcriber);
    expect(transcriber.calls).toHaveLength(1);
    expect(result.text).toBe("");
    expect(result.error?.kind).toBe("no_speech");
  });

  test("transient failures are retried with backoff", async () => {
    const transcriber = fakeTranscriber((request, attempt) => {
      if (attempt < 2) throw new VoiceError("network", "down", { retryable: true, status: 502 });
      return `part ${request.segmentIndex}`;
    });
    const { result } = await dictate(THREE_PHRASES, transcriber);
    expect(transcriber.calls).toHaveLength(9);
    expect(result.text).toBe("part 0 part 1 part 2");
    expect(result.error).toBeNull();
  });

  test("a segment that keeps failing is lost but the rest of the text is kept", async () => {
    const transcriber = fakeTranscriber((request) => {
      if (request.segmentIndex === 1) throw new VoiceError("unreadable", "bad audio", { status: 422 });
      return `part ${request.segmentIndex}`;
    });
    const { result } = await dictate(THREE_PHRASES, transcriber);
    expect(transcriber.calls).toHaveLength(3);
    expect(result.text).toBe("part 0 part 2");
    expect(result.error?.kind).toBe("unreadable");
  });

  test("voice unavailable is not retried", async () => {
    const transcriber = fakeTranscriber(() => {
      throw new VoiceError("unavailable", "off", { status: 503 });
    });
    const { result } = await dictate(concat(tone(1_500), quiet(900)), transcriber);
    expect(transcriber.calls).toHaveLength(1);
    expect(result.error?.kind).toBe("unavailable");
  });

  test("cancel aborts uploads in flight and returns no text", async () => {
    const transcriber = fakeTranscriber(async () => {
      await sleep(5_000);
      return "late";
    });
    const session = new VoiceSession({
      source: new WavFileSource(encodeWav(concat(tone(1_500), quiet(900), tone(20_000))), { realtime: true, chunkMs: 20 }),
      transcriber,
    });
    await session.start();
    while (transcriber.calls.length === 0) await sleep(20);
    session.cancel();
    expect(session.phase).toBe("cancelled");
    expect(transcriber.calls[0]!.signal.aborted).toBe(true);
    const result = await session.stop();
    expect(result.text).toBe("");
    expect(session.snapshot().pending).toBe(0);
  });

  test("a finished recording leaves no timer pending (the finalize deadline is cleared)", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Map<unknown, number>();
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...args: unknown[]) => {
      const id = realSetTimeout(() => {
        pending.delete(id);
        handler();
      }, ms, ...args);
      pending.set(id, ms ?? 0);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(id);
      realClearTimeout(id);
    }) as typeof clearTimeout;
    try {
      const transcriber = fakeTranscriber(async (request) => {
        await sleep(20);
        return `part ${request.segmentIndex}`;
      });
      const { result } = await dictate(THREE_PHRASES, transcriber, { finalizeTimeoutMs: 45_000 });
      expect(result.text).toBe("part 0 part 1 part 2");
      await sleep(10);
      expect([...pending.values()].filter((ms) => ms >= 1_000)).toEqual([]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("the breaker opens after three failures in ten seconds", async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(3, 10_000, 30_000, () => now);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    const session = new VoiceSession({ source: new WavFileSource(encodeWav(tone(100))), transcriber: fakeTranscriber(() => ""), breaker });
    await expect(session.start()).rejects.toMatchObject({ kind: "breaker_open" });
    now += 31_000;
    expect(breaker.isOpen()).toBe(false);
  });

  test("tap mode stops by itself after the silence limit", async () => {
    const reasons: string[] = [];
    const transcriber = fakeTranscriber(() => "hello there");
    const session = new VoiceSession({
      source: new WavFileSource(encodeWav(concat(tone(1_200), quiet(3_000))), { realtime: true, chunkMs: 20 }),
      transcriber,
      silenceAutoStopMs: 900,
      onAutoStop: (reason) => reasons.push(reason),
    });
    await session.start();
    const started = Date.now();
    while (session.phase === "recording" && Date.now() - started < 4_000) await sleep(25);
    const result = await session.stop();
    expect(reasons).toEqual(["silence"]);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.text).toBe("hello there");
  });
});

describe("remote transcriber", () => {
  const request: TranscribeRequest = {
    wav: encodeWav(tone(100)),
    segmentIndex: 2,
    recordingId: "abc",
    language: "en",
    keyterms: ["OmniRush", "voice"],
    durationMs: 100,
  };

  test("posts a multipart segment and reads the text", async () => {
    let seen: Request | null = null;
    const transcriber = new RemoteTranscriber({
      url: "http://127.0.0.1:1/omnirush/voice/transcribe",
      headers: () => ({ Authorization: "Bearer t" }),
      fetch: async (url, init) => {
        // Plain bytes, never a Blob (a browser may page Blobs to disk).
        expect(init.body).toBeInstanceOf(Uint8Array);
        seen = new Request(url, init);
        return Response.json({ text: "hello", provider: "primary", duration_ms: 100 });
      },
    });
    expect(await transcriber.transcribe(request, new AbortController().signal)).toEqual({ text: "hello" });
    const upload = seen as unknown as Request;
    expect(upload.headers.get("authorization")).toBe("Bearer t");
    const form = await upload.formData();
    expect(form.get("segment_index")).toBe("2");
    expect(form.get("recording_id")).toBe("abc");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt_terms")).toBe("OmniRush, voice");
    const file = form.get("file") as File;
    expect(file.type).toMatch(/wav/);
    expect(file.size).toBe(request.wav.length);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(request.wav);
  });

  test.each([
    [503, { detail: "voice_unavailable" }, "unavailable", false],
    [503, { error: { code: "transcription_unavailable" } }, "network", true],
    [422, { detail: "audio_unreadable" }, "unreadable", false],
    [429, { detail: "rate_limited" }, "rate_limited", true],
    [429, { detail: "voice_daily_budget_exhausted" }, "rate_limited", false],
    [429, { detail: "voice_concurrency_limited" }, "rate_limited", true],
    [413, { detail: "audio_too_long" }, "too_large", false],
    [415, { detail: "unsupported_audio_format" }, "unreadable", false],
    [400, { detail: "invalid_multipart" }, "unreadable", false],
    [429, { detail: "daily_grant_exhausted" }, "rate_limited", false],
    [503, { detail: "voice_budget_unavailable" }, "network", true],
    [401, { error: "omnirush_account_required" }, "signed_out", false],
    [413, { detail: "audio_too_large" }, "too_large", false],
  ] as const)("HTTP %i %j → %s", async (status, body, kind, retryable) => {
    const transcriber = new RemoteTranscriber({
      url: "http://x",
      fetch: async () => new Response(JSON.stringify(body), { status, headers: { "retry-after": "2" } }),
    });
    const error = await transcriber.transcribe(request, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as VoiceError).kind).toBe(kind);
    expect((error as VoiceError).retryable).toBe(retryable);
    if (status === 429) expect((error as VoiceError).retryAfterMs).toBe(2_000);
  });

  test("a connection failure is a retryable network error", async () => {
    const transcriber = new RemoteTranscriber({ url: "http://x", fetch: async () => { throw new TypeError("fetch failed"); } });
    const error = await transcriber.transcribe(request, new AbortController().signal).catch((e: unknown) => e);
    expect((error as VoiceError).kind).toBe("network");
    expect((error as VoiceError).retryable).toBe(true);
  });
});
