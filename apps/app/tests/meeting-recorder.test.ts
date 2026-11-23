import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createOmniRushServerClient, OmniRushServerError, type OmniRushWorkMeetingPartAnswer } from "../src/app/lib/omnirush-server";
import type { AudioSource } from "../src/app/lib/voice-core";
import { MeetingRecorder, PartCutter, PartUploader, type MeetingClient, type Part, type RecorderState, type Speaker } from "../src/react-app/domains/meetings/recorder";
import { MEETINGS_IN_APP, WORK_MEETINGS_ROUTE } from "../src/react-app/domains/work/work-mode";

const RATE = 16_000;
const samplesOf = (ms: number) => Math.round((RATE * ms) / 1000);

/** A seeded generator, so every run cuts the same audio. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/**
 * Speech stand-in: words of voiced syllables (short dips between them), sentences of words, pauses of 400 to 900 ms
 * between sentences; returns the float signal and the pause intervals (in samples).
 */
function speech(seconds: number, seed = 3): { signal: Float32Array; pauses: Array<[number, number]> } {
  const next = random(seed);
  const signal = new Float32Array(samplesOf(seconds * 1000));
  const pauses: Array<[number, number]> = [];
  let at = samplesOf(300);
  let sound = 0;
  while (at < signal.length) {
    pauses.push([sound, at]);
    const words = 4 + Math.floor(next() * 10);
    for (let word = 0; word < words && at < signal.length; word += 1) {
      const syllables = 1 + Math.floor(next() * 3);
      for (let syllable = 0; syllable < syllables && at < signal.length; syllable += 1) {
        const length = samplesOf(120 + next() * 160);
        const pitch = 110 + next() * 120;
        for (let i = 0; i < length && at + i < signal.length; i += 1) {
          const envelope = Math.sin((Math.PI * i) / length);
          const t = (at + i) / RATE;
          signal[at + i] = 0.3 * envelope * (Math.sin(2 * Math.PI * pitch * t) + 0.4 * Math.sin(4 * Math.PI * pitch * t));
        }
        sound = at + length;
        at += length + samplesOf(20 + next() * 40);
      }
      at += samplesOf(40 + next() * 80);
    }
    // The pause runs from the end of the sentence's last sound to the next sentence.
    at += samplesOf(400 + next() * 500);
  }
  pauses.push([sound, signal.length]);
  return { signal, pauses };
}

function rmsOf(signal: Float32Array): number {
  let sum = 0;
  for (const value of signal) sum += value * value;
  return Math.sqrt(sum / signal.length);
}

/** Steady fan noise (smoothed white noise) at `snrDb` under the speech. */
function noise(length: number, level: number, seed = 11): Float32Array {
  const next = random(seed);
  const out = new Float32Array(length);
  let smooth = 0;
  for (let i = 0; i < length; i += 1) {
    smooth = 0.7 * smooth + 0.3 * (next() * 2 - 1);
    out[i] = smooth;
  }
  const scale = level / rmsOf(out);
  for (let i = 0; i < length; i += 1) out[i]! *= scale;
  return out;
}

/** Background music: a four-chord loop with a soft beat, like the W1 bench's music fixture. */
function music(length: number, level: number): Float32Array {
  const out = new Float32Array(length);
  const roots = [261.63, 392, 440, 349.23];
  for (let i = 0; i < length; i += 1) {
    const t = i / RATE;
    const root = roots[Math.floor(t / 2) % 4]!;
    const beat = 0.75 + 0.25 * Math.cos(2 * Math.PI * 2 * t);
    out[i] = beat * (Math.sin(2 * Math.PI * root * t) + 0.5 * Math.sin(2 * Math.PI * root * 1.25 * t) + 0.4 * Math.sin(2 * Math.PI * root * 1.5 * t));
  }
  const scale = level / rmsOf(out);
  for (let i = 0; i < length; i += 1) out[i]! *= scale;
  return out;
}

function mix(voice: Float32Array, background: Float32Array | null, snrDb: number): Int16Array {
  const scale = background ? rmsOf(voice) / 10 ** (snrDb / 20) / rmsOf(background) : 0;
  const out = new Int16Array(voice.length);
  for (let i = 0; i < voice.length; i += 1) out[i] = Math.round(Math.max(-1, Math.min(1, voice[i]! + (background ? background[i]! * scale : 0))) * 32767);
  return out;
}

/** Feeds `input` in uneven chunks, as the audio worklet does, and flushes at the end. */
function cutAll(input: Int16Array, cutter = new PartCutter()): Part[] {
  const next = random(5);
  const parts: Part[] = [];
  for (let at = 0; at < input.length;) {
    const size = 64 + Math.floor(next() * 4000);
    parts.push(...cutter.push(input.subarray(at, at + size)));
    at += size;
  }
  const last = cutter.flush();
  if (last) parts.push(last);
  return parts;
}

describe("meeting part cutter (never drops audio)", () => {
  const { signal, pauses } = speech(150);
  const cases: Array<[string, Int16Array]> = [
    ["clean speech", mix(signal, null, 0)],
    ["speech with fan noise (SNR 15 dB)", mix(signal, noise(signal.length, 1), 15)],
    ["speech with music (SNR 10 dB)", mix(signal, music(signal.length, 1), 10)],
  ];

  for (const [name, input] of cases) {
    test(`${name}: every sample lands in exactly one part, in order; parts 8 to 28 s; cuts in pauses`, () => {
      const parts = cutAll(input);
      expect(parts.reduce((total, part) => total + part.samples.length, 0)).toBe(input.length);
      const joined = new Int16Array(input.length);
      let at = 0;
      for (const part of parts) {
        expect(part.startMs).toBeCloseTo((at * 1000) / RATE, 6);
        joined.set(part.samples, at);
        at += part.samples.length;
      }
      expect(joined).toEqual(input);
      for (const part of parts.slice(0, -1)) {
        expect(part.samples.length).toBeGreaterThanOrEqual(samplesOf(8_000));
        expect(part.samples.length).toBeLessThanOrEqual(samplesOf(28_000));
      }
      // Each cut sits inside a pause of the speech, never in a word.
      let cut = 0;
      for (const part of parts.slice(0, -1)) {
        cut += part.samples.length;
        expect(pauses.some(([from, to]) => cut >= from && cut <= to)).toBe(true);
      }
      expect(parts.length).toBeGreaterThan(4);
    });
  }

  test("without a pause, a part is cut at 28 s at its quietest moment; a gap moves the clock", () => {
    const steady = mix(music(samplesOf(70_000), 0.2), null, 0);
    const parts = cutAll(steady);
    expect(parts.slice(0, -1).every((part) => part.samples.length >= samplesOf(8_000) && part.samples.length <= samplesOf(28_000))).toBe(true);
    expect(parts.reduce((total, part) => total + part.samples.length, 0)).toBe(steady.length);

    const cutter = new PartCutter();
    expect(cutter.push(steady.subarray(0, samplesOf(3_000)))).toEqual([]);
    const before = cutter.skipTo(10_000);
    expect(before?.startMs).toBe(0);
    expect(before?.samples.length).toBe(samplesOf(3_000));
    expect(cutter.positionMs).toBe(10_000);
    expect(cutter.flush()).toBeNull();
    cutter.push(steady.subarray(0, samplesOf(1_000)));
    expect(cutter.flush()?.startMs).toBe(10_000);
  });
});

function answer(speaker: string, part: number): OmniRushWorkMeetingPartAnswer {
  return { status: "done", speaker, part, segments: [] };
}

function partOf(ms: number, startMs: number): Part {
  return { samples: new Int16Array(samplesOf(ms)).fill(1000), startMs, peakRms: 0.03 };
}

describe("meeting part uploader", () => {
  test("parts count from 0 per stream with their offsets; busy, in progress and network errors retry the same part until done", async () => {
    const calls: string[] = [];
    const failures = [new OmniRushServerError(503, "transcribe_busy", "busy"), new OmniRushServerError(429, "rate_limited", "slow down"), new OmniRushServerError(409, "part_in_progress", "wait"), new TypeError("Failed to fetch")];
    const waits: number[] = [];
    const uploader = new PartUploader("them", async (speaker, part, offsetMs, wav) => {
      calls.push(`${speaker}:${part}@${offsetMs}:${wav.length}`);
      expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
      const failure = part === 1 ? failures.shift() : undefined;
      if (failure) throw failure;
      return answer(speaker, part);
    }, { sleep: async (ms) => { waits.push(ms); }, retryDelaysMs: [10, 20] });
    uploader.add(partOf(9_000, 0));
    uploader.add(partOf(12_000, 9_000));
    uploader.add(partOf(8_000, 21_000.4));
    await uploader.drained();
    const bytes = (ms: number) => 44 + samplesOf(ms) * 2;
    expect(calls).toEqual([
      `them:0@0:${bytes(9_000)}`,
      `them:1@9000:${bytes(12_000)}`, `them:1@9000:${bytes(12_000)}`, `them:1@9000:${bytes(12_000)}`, `them:1@9000:${bytes(12_000)}`, `them:1@9000:${bytes(12_000)}`,
      `them:2@21000:${bytes(8_000)}`,
    ]);
    // 503 and 429 wait at least the server's Retry-After (5 s); in progress and network errors keep the short ladder.
    expect(waits).toEqual([5_000, 5_000, 20, 20]);
    expect(uploader.gaps).toEqual([]);
    expect(uploader.backlogMs).toBe(0);
  });

  test("a duplicate counts as done; a refusal drops that part as a gap and says why", async () => {
    const uploader = new PartUploader("me", async (speaker, part) => {
      if (part === 1) return { status: "duplicate", speaker, part };
      if (part === 2) throw new OmniRushServerError(429, "meeting_budget", "budget");
      return answer(speaker, part);
    }, { sleep: async () => undefined });
    uploader.add(partOf(9_000, 0));
    uploader.add(partOf(9_000, 9_000));
    uploader.add(partOf(9_000, 18_000));
    uploader.add(partOf(9_000, 27_000));
    await uploader.drained();
    expect(uploader.gaps).toEqual([{ speaker: "me", fromMs: 18_000, toMs: 27_000 }]);
    expect(uploader.lastError).toBe("meeting_budget");
  });

  test("over the backlog cap the oldest waiting part is dropped (a gap), never the one on the wire", async () => {
    let release: () => void = () => undefined;
    const sent: number[] = [];
    const uploader = new PartUploader("them", async (speaker, part) => {
      sent.push(part);
      if (part === 0) await new Promise<void>((resolve) => { release = resolve; });
      return answer(speaker, part);
    }, { backlogMs: 30_000 });
    for (let index = 0; index < 5; index += 1) uploader.add(partOf(10_000, index * 10_000));
    // 50 s waiting with a 30 s cap: part 0 is on the wire, parts 1 and 2 go.
    expect(uploader.backlogMs).toBe(30_000);
    expect(uploader.gaps).toEqual([{ speaker: "them", fromMs: 10_000, toMs: 30_000 }]);
    release();
    await uploader.drained();
    expect(sent).toEqual([0, 3, 4]);
  });
});

class FakeSource implements AudioSource {
  static all: FakeSource[] = [];
  onFrames: ((frames: Int16Array) => void) | null = null;
  onEnd: (() => void) | null = null;
  stopped = false;
  constructor(readonly speaker: Speaker, private readonly fail = false) {
    FakeSource.all.push(this);
  }
  async start(onFrames: (frames: Int16Array) => void, onEnd?: () => void) {
    if (this.fail) throw new Error("NotReadableError");
    this.onFrames = onFrames;
    this.onEnd = onEnd ?? null;
  }
  stop() {
    this.stopped = true;
  }
  /** `ms` of a loud tone. */
  play(ms: number) {
    const out = new Int16Array(samplesOf(ms));
    for (let i = 0; i < out.length; i += 1) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / RATE));
    this.onFrames?.(out);
  }
}

function fakeClient() {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const hold = { on: false };
  const client: MeetingClient = {
    createMeeting: async () => { calls.push("create"); return { id: "m1" }; },
    endMeeting: async (id, endedAt) => { calls.push(`end ${id} ${endedAt.length > 0}`); },
    uploadPart: async (id, speaker, part, offsetMs) => {
      if (hold.on) await new Promise<void>((resolve) => { release = resolve; });
      calls.push(`part ${id} ${speaker} ${part} ${offsetMs}`);
      return answer(speaker, part);
    },
  };
  return { calls, client, hold, release: () => release() };
}

describe("meeting recorder", () => {
  test("mic only when system audio is not available; Stop sets ended_at, and again once the backlog drains", async () => {
    FakeSource.all = [];
    let now = 0;
    const states: RecorderState[] = [];
    const { calls, client, hold, release } = fakeClient();
    const recorder = new MeetingRecorder({
      client,
      sources: { me: () => new FakeSource("me"), them: () => new FakeSource("them", true) },
      watchDevices: () => () => undefined,
      now: () => now,
      tickMs: 60_000,
      onChange: (state) => states.push(state),
    });
    await recorder.start();
    expect(recorder.snapshot).toMatchObject({ phase: "recording", meetingId: "m1", me: "on", them: "off" });
    const me = FakeSource.all[0]!;
    me.play(5_000);
    now = 5_000;
    hold.on = true;
    await recorder.stop();
    expect(calls).toEqual(["create", "end m1 true"]);
    expect(recorder.snapshot.phase).toBe("done");
    expect(me.stopped).toBe(true);
    release();
    await recorder.finished;
    expect(calls).toEqual(["create", "end m1 true", "part m1 me 0 0", "end m1 true"]);
    expect(states.some((state) => state.them === "off")).toBe(true);
  });

  test("an output device change restarts the system stream; its next part starts at the meeting's clock; Pause drops audio", async () => {
    FakeSource.all = [];
    let now = 0;
    let deviceChanged: () => void = () => undefined;
    const { calls, client } = fakeClient();
    const recorder = new MeetingRecorder({
      client,
      sources: { me: () => new FakeSource("me"), them: () => new FakeSource("them") },
      watchDevices: (onChange) => { deviceChanged = onChange; return () => undefined; },
      now: () => now,
      tickMs: 60_000,
    });
    await recorder.start();
    expect(recorder.snapshot).toMatchObject({ me: "on", them: "on" });
    const [me, them] = FakeSource.all;
    me!.play(9_000);
    them!.play(9_000);
    now = 9_000;
    // Two seconds of the system stream are lost while the device switches.
    now = 11_000;
    deviceChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(them!.stopped).toBe(true);
    const newThem = FakeSource.all[2]!;
    expect(newThem.speaker).toBe("them");
    newThem.play(9_000);
    me!.play(2_000);
    now = 20_000;
    recorder.pause();
    me!.play(5_000);
    newThem.play(5_000);
    now = 25_000;
    recorder.resume();
    me!.play(1_000);
    now = 26_000;
    await recorder.stop();
    await recorder.finished;
    expect(calls.filter((call) => call.startsWith("part")).sort()).toEqual([
      "part m1 me 0 0",
      "part m1 me 1 11000",
      "part m1 them 0 0",
      "part m1 them 1 11000",
    ]);
  });
});

describe("meetings: all four Work layers", () => {
  test("route, page branch and nav only with the meetings flag; local routes; the broker's path; client methods with raw bytes", async () => {
    expect(WORK_MEETINGS_ROUTE).toBe("/work/meetings");
    const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
    expect(route).toContain("const meetingsShown = MEETINGS_IN_APP && workState.data?.meetings === true;");
    expect(route).toContain("location.pathname.startsWith(WORK_MEETINGS_ROUTE) && meetingsShown ? (");
    expect(route).toContain("meetingsShown ? { onOpenMeetings");
    expect(route).not.toContain("workState.data?.meetings ?");
    // Kept off until meeting audio is checked on real Macs and Windows PCs.
    expect(MEETINGS_IN_APP).toBe(false);
    const local = readFileSync(new URL("../../server/src/work/routes.ts", import.meta.url), "utf8");
    for (const path of ["/work/meetings", "/work/meetings/:id", "/work/meetings/:id/audio"]) expect(local).toContain(`"${path}"`);
    const broker = readFileSync(new URL("../../server/src/work/work.ts", import.meta.url), "utf8");
    expect(broker).toContain("`meetings(?:/${ID}(?:/audio)?)?`");

    const seen: { url: string; method: string; body: unknown; type: string | null }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body, type: new Headers(init?.headers).get("content-type") });
      return Response.json(String(input).includes("/audio") ? answer("me", 3) : { id: "m1", title: "Call", status: "created", started_at: "2026-11-19T10:00:00Z", ended_at: null });
    }) as typeof fetch;
    const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    try {
      const client = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:9" });
      expect(await client.createWorkMeeting({ title: "Call", started_at: "2026-11-19T10:00:00Z" })).toMatchObject({ id: "m1" });
      await client.getWorkMeeting("m1");
      await client.updateWorkMeeting("m1", { ended_at: "2026-11-19T10:30:00Z" });
      expect(await client.uploadWorkMeetingAudio("m1", { speaker: "me", part: 3, offsetMs: 42_000 }, wav)).toEqual(answer("me", 3));
    } finally {
      globalThis.fetch = saved;
    }
    expect(seen.map((call) => `${call.method} ${call.url.replace("http://127.0.0.1:9", "")}`)).toEqual([
      "POST /work/meetings",
      "GET /work/meetings/m1",
      "PATCH /work/meetings/m1",
      "POST /work/meetings/m1/audio?speaker=me&part=3&offset_ms=42000",
    ]);
    // The audio is the bytes themselves (never a Blob or FormData), typed as WAV.
    expect(seen[3]?.body).toBe(wav);
    expect(seen[3]?.type).toBe("audio/wav");
    expect(seen[2]?.body).toBe(JSON.stringify({ ended_at: "2026-11-19T10:30:00Z" }));
  });
});
