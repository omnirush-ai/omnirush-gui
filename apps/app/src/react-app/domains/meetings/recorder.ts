/**
 * Meeting audio (contract D4, plan M1): two streams recorded on this computer and uploaded in parts while the
 * call runs. "Me" is the microphone (echo cancellation on); "Them" is the system audio, through Electron's
 * display-media loopback (main sets `audio: "loopback"`; Core Audio tap on macOS 14.2+, WASAPI loopback on
 * Windows, the default sink's monitor on Linux). Without system audio only the mic is transcribed.
 *
 *   source → PartCutter (8 to 28 s, cut at pauses, every sample kept) → PartUploader (raw WAV, retry, backlog cap)
 *          → POST /work/meetings/{id}/audio?speaker=&part=&offset_ms= → the server transcribes it while it waits
 *
 * Audio lives only in memory: a part stays in RAM until the server answers done or duplicate, or the backlog cap
 * drops it (a gap). Nothing is written to disk.
 */
import { Downsampler, encodeWav, levelFromRms, rms, VOICE_SAMPLE_RATE, type AudioSource, VoiceError } from "@/app/lib/voice-core";
import { OmniRushServerError, type OmniRushWorkMeetingPartAnswer } from "@/app/lib/omnirush-server";
import { attachPcm, ensureMicrophonePermission } from "@/react-app/domains/voice/mic-source";

export type Speaker = "me" | "them";

/** One part of one stream: 16 kHz mono PCM. `startMs` is its place on the meeting's clock. */
export type Part = { samples: Int16Array; startMs: number; peakRms: number };

export type PartCutterOptions = { frameMs?: number; minPartMs?: number; maxPartMs?: number; pauseMs?: number };

/** A frame this quiet is a pause whatever the background (about -54 dBFS). */
const ABSOLUTE_QUIET = 0.002;

/**
 * Cuts one stream into parts of `minPartMs` to `maxPartMs` (8 to 28 s), at the first pause after the minimum,
 * else at the quietest moment before the maximum. Unlike voice-core's Segmenter it never drops a sample: every
 * sample pushed lands in exactly one part (the W1 bench: the Segmenter's rising noise floor dropped speech under
 * music and noise). A pause is `pauseMs` of frames at most twice the part's 10th-percentile level and at most half
 * its median.
 */
export class PartCutter {
  private readonly rate = VOICE_SAMPLE_RATE;
  private readonly frameSize: number;
  private readonly minFrames: number;
  private readonly maxFrames: number;
  private readonly pauseFrames: number;
  private readonly buffer: Int16Array;
  private length = 0;
  private frames: number[] = [];
  private quiet = ABSOLUTE_QUIET;
  private startMs = 0;

  constructor(options: PartCutterOptions = {}) {
    const frameMs = options.frameMs ?? 20;
    this.frameSize = Math.round((this.rate * frameMs) / 1000);
    this.minFrames = Math.round((options.minPartMs ?? 8_000) / frameMs);
    this.maxFrames = Math.round((options.maxPartMs ?? 28_000) / frameMs);
    this.pauseFrames = Math.max(2, Math.round((options.pauseMs ?? 300) / frameMs));
    this.buffer = new Int16Array(this.maxFrames * this.frameSize);
  }

  /** Where the next sample sits on the meeting's clock. */
  get positionMs(): number {
    return this.startMs + (this.length * 1000) / this.rate;
  }

  push(samples: Int16Array): Part[] {
    const out: Part[] = [];
    let at = 0;
    while (at < samples.length) {
      const take = Math.min(this.frameSize - (this.length % this.frameSize), samples.length - at);
      this.buffer.set(samples.subarray(at, at + take), this.length);
      this.length += take;
      at += take;
      if (this.length % this.frameSize !== 0) continue;
      this.frames.push(rms(this.buffer.subarray(this.length - this.frameSize, this.length)));
      const cut = this.cutPoint();
      if (cut !== null) out.push(this.cut(cut * this.frameSize));
    }
    return out;
  }

  /** The open part, whatever its length (Pause, Stop). */
  flush(): Part | null {
    return this.length > 0 ? this.cut(this.length) : null;
  }

  /** The stream restarted after a gap: the open part ends here, the next one starts at `ms`. */
  skipTo(ms: number): Part | null {
    const part = this.flush();
    this.startMs = Math.max(this.startMs, ms);
    return part;
  }

  /** The frame to cut at, or null to keep listening. */
  private cutPoint(): number | null {
    const count = this.frames.length;
    const half = Math.floor(this.pauseFrames / 2);
    if (count < this.minFrames + half) return null;
    if (count % 25 === 0 || count === this.minFrames + half) {
      // Near the part's floor and well under its typical level: a steady sound (a tone, music alone) has no pause.
      const sorted = [...this.frames].sort((a, b) => a - b);
      this.quiet = Math.max(ABSOLUTE_QUIET, Math.min(2 * sorted[Math.floor(count * 0.1)]!, 0.5 * sorted[Math.floor(count * 0.5)]!));
    }
    if (count >= this.maxFrames) return this.quietest(half);
    for (let index = count - this.pauseFrames; index < count; index += 1) if (this.frames[index]! > this.quiet) return null;
    return count - half;
  }

  /** The middle of the quietest pause-long window whose middle lies between the minimum and the end. */
  private quietest(half: number): number {
    let best = this.minFrames;
    let bestSum = Infinity;
    let sum = 0;
    const first = this.minFrames - half;
    for (let index = first; index < this.frames.length; index += 1) {
      sum += this.frames[index]!;
      if (index - first >= this.pauseFrames) sum -= this.frames[index - this.pauseFrames]!;
      if (index - first >= this.pauseFrames - 1 && sum < bestSum) {
        bestSum = sum;
        best = index - this.pauseFrames + 1 + half;
      }
    }
    return Math.min(best, this.frames.length);
  }

  private cut(at: number): Part {
    const samples = this.buffer.slice(0, at);
    const frames = Math.floor(at / this.frameSize);
    const part = { samples, startMs: this.startMs, peakRms: Math.max(0, ...this.frames.slice(0, frames), at % this.frameSize ? rms(samples.subarray(frames * this.frameSize)) : 0) };
    this.buffer.copyWithin(0, at, this.length);
    this.length -= at;
    this.frames = this.frames.slice(frames);
    this.startMs += (at * 1000) / this.rate;
    return part;
  }
}

// ---------------------------------------------------------------------------------------------- the uploader

export type UploadPart = (speaker: Speaker, part: number, offsetMs: number, wav: Uint8Array<ArrayBuffer>) => Promise<OmniRushWorkMeetingPartAnswer>;

export type PartUploaderOptions = {
  /** Audio kept waiting per stream before the oldest part is dropped (plan 1.7: 20 min, about 38 MB). */
  backlogMs?: number;
  /** Waits before each retry; the last one repeats. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

/** Audio that will never be transcribed: dropped by the backlog cap, or refused by the server. */
export type Gap = { speaker: Speaker; fromMs: number; toMs: number };

type Queued = { part: number; startMs: number; samples: Int16Array };

/** Errors worth sending the same part again for: the worker busy or down, a reload, the network. */
function retryable(error: unknown): boolean {
  if (!(error instanceof OmniRushServerError)) return true;
  if (error.status === 409) return error.code === "part_in_progress";
  if (error.status === 429) return error.code !== "meeting_budget";
  return error.status >= 500 || error.status === 408 || error.status === 401;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The server's Retry-After on 503 transcribe_busy/transcribe_unavailable and retryable 429. */
const BUSY_RETRY_MS = 5_000;

/**
 * One stream's parts, sent one at a time in order (`part` from 0, `offset_ms` on the meeting's clock). A part stays
 * in RAM until the server answers done or duplicate; busy, in progress and network errors are retried with backoff.
 * Over the backlog cap the oldest waiting part is dropped and becomes a gap.
 */
export class PartUploader {
  private readonly queue: Queued[] = [];
  private nextPart = 0;
  private running = false;
  private idle: Array<() => void> = [];
  readonly gaps: Gap[] = [];
  /** The last refusal that dropped a part (meeting_budget, notice_required, …). */
  lastError: string | null = null;
  /** Retrying right now (the worker is busy or the network is down). */
  retrying = false;

  constructor(
    readonly speaker: Speaker,
    private readonly upload: UploadPart,
    private readonly options: PartUploaderOptions = {},
  ) {}

  /** Audio waiting to be transcribed, in ms. */
  get backlogMs(): number {
    return this.queue.reduce((total, item) => total + (item.samples.length * 1000) / VOICE_SAMPLE_RATE, 0);
  }

  add(part: Part): void {
    this.queue.push({ part: this.nextPart++, startMs: Math.round(part.startMs), samples: part.samples });
    const cap = this.options.backlogMs ?? 20 * 60_000;
    // The head may be on the wire: drop the oldest one behind it.
    while (this.backlogMs > cap && this.queue.length > (this.running ? 2 : 1)) this.dropAt(this.running ? 1 : 0, null);
    void this.run();
  }

  /** Resolves once every part is done, duplicate or dropped (Stop waits for it, then sets ended_at again). */
  drained(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private dropAt(index: number, error: string | null): void {
    const [item] = this.queue.splice(index, 1);
    if (!item) return;
    if (error) this.lastError = error;
    const toMs = item.startMs + Math.round((item.samples.length * 1000) / VOICE_SAMPLE_RATE);
    const last = this.gaps.at(-1);
    if (last && last.toMs >= item.startMs - 1) last.toMs = Math.max(last.toMs, toMs);
    else this.gaps.push({ speaker: this.speaker, fromMs: item.startMs, toMs });
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const delays = this.options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
    const sleep = this.options.sleep ?? sleepFor;
    let attempt = 0;
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      try {
        await this.upload(this.speaker, item.part, item.startMs, encodeWav(item.samples));
        if (this.queue[0] === item) this.queue.shift();
        attempt = 0;
        this.retrying = false;
      } catch (error) {
        if (!retryable(error)) {
          if (this.queue[0] === item) this.dropAt(0, error instanceof OmniRushServerError ? error.code : "upload_failed");
          attempt = 0;
          continue;
        }
        this.retrying = true;
        const delay = delays[Math.min(attempt, delays.length - 1)]!;
        // Busy answers carry Retry-After: 5 (the local server drops the header): never send sooner. Network errors keep the short waits.
        const busy = error instanceof OmniRushServerError && (error.status === 503 || error.status === 429);
        await sleep(busy ? Math.max(delay, BUSY_RETRY_MS) : delay);
        attempt += 1;
      }
    }
    this.running = false;
    this.retrying = false;
    for (const resolve of this.idle.splice(0)) resolve();
  }
}

// ---------------------------------------------------------------------------------------------- the sources

/** Start waits this long for the system audio (an unanswered macOS prompt leaves getDisplayMedia pending). */
export const SYSTEM_AUDIO_TIMEOUT_MS = 30_000;

/** A MediaStream's first audio track as a voice-core AudioSource (16 kHz Int16). */
export function streamSource(open: () => Promise<MediaStream>): AudioSource {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let stopped = false;
  return {
    async start(onFrames, onEnd) {
      stopped = false;
      stream = await open();
      if (stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      try {
        context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      } catch {
        context = new AudioContext();
      }
      const downsampler = new Downsampler(context.sampleRate);
      await attachPcm(context, context.createMediaStreamSource(stream), (samples) => {
        if (!stopped) onFrames(downsampler.push(samples));
      });
      if (context.state === "suspended") await context.resume().catch(() => undefined);
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (!stopped) onEnd?.(new VoiceError("no_device", "The audio stream ended."));
      }, { once: true });
    },
    stop() {
      stopped = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => undefined);
      stream = null;
      context = null;
    },
  };
}

/** The microphone, echo cancellation on (it only removes what this app plays; the server drops leaked lines). */
export async function openMicrophoneStream(): Promise<MediaStream> {
  if ((await ensureMicrophonePermission()) === "denied") throw new VoiceError("permission_denied", "Microphone access is turned off.");
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

/**
 * The system audio: the desktop's display-media handler answers with this window as the video (stopped at once,
 * no Screen Recording) and loopback audio. Processing stays off: echo cancellation and noise suppression all but
 * erase a remote voice (M0: peak -50 dBFS with them on). Rejects when it is denied, missing or not answered in time.
 */
export async function openSystemAudioStream(timeoutMs = SYSTEM_AUDIO_TIMEOUT_MS): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("no_display_media");
  const request = navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("system_audio_timeout")), timeoutMs);
  });
  // A late answer after the timeout still opened a stream: close it.
  request.then((late) => { if (timer === null) for (const track of late.getTracks()) track.stop(); }, () => undefined);
  let stream: MediaStream;
  try {
    stream = await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  for (const track of stream.getVideoTracks()) track.stop();
  const audio = stream.getAudioTracks().filter((track) => track.readyState === "live");
  if (audio.length === 0) {
    // macOS: denied, or the app has no NSAudioCaptureUsageDescription; the track arrives already ended.
    for (const track of stream.getTracks()) track.stop();
    throw new Error("no_system_audio");
  }
  return new MediaStream(audio);
}

// ---------------------------------------------------------------------------------------------- the recorder

export type RecorderPhase = "idle" | "starting" | "recording" | "paused" | "stopping" | "done" | "error";
/** A stream: waiting to start (system audio: the macOS prompt may be up), recording, or not available. */
export type StreamState = "pending" | "on" | "off";

export type RecorderState = {
  phase: RecorderPhase;
  meetingId: string | null;
  me: StreamState;
  them: StreamState;
  /** The current input levels, 0..1. */
  levels: Record<Speaker, number>;
  elapsedMs: number;
  /** Audio waiting to be transcribed, both streams. */
  backlogMs: number;
  /** An upload is being retried (the transcriber is busy or the network is down). */
  catchingUp: boolean;
  gaps: Gap[];
  /** The server refused a part or the start: meeting_budget, notice_required, no_audio, … */
  error: string | null;
};

export type MeetingClient = {
  createMeeting: (body: { title?: string; started_at: string }) => Promise<{ id: string }>;
  endMeeting: (id: string, endedAt: string) => Promise<unknown>;
  uploadPart: (id: string, speaker: Speaker, part: number, offsetMs: number, wav: Uint8Array<ArrayBuffer>) => Promise<OmniRushWorkMeetingPartAnswer>;
};

export type MeetingRecorderOptions = {
  client: MeetingClient;
  onChange?: (state: RecorderState) => void;
  /** The two sources; tests pass fakes. */
  sources?: Record<Speaker, () => AudioSource>;
  /** Subscribes to output/input device changes; returns the unsubscribe. */
  watchDevices?: (onChange: () => void) => () => void;
  uploader?: PartUploaderOptions;
  cutter?: PartCutterOptions;
  now?: () => number;
  /** How often levels and the clock are reported. */
  tickMs?: number;
};

/**
 * A part whose loudest frame is this quiet holds no speech (about -54 dBFS: digital silence, a quiet room through
 * noise suppression): it is not sent, so a silent stream costs no transcription minutes.
 */
const SILENT_PART_RMS = ABSOLUTE_QUIET;
/** A system stream that ends this soon after it started is not available (denied), not a device change. */
const RESTART_MIN_LIFE_MS = 2_000;

const defaultSources: Record<Speaker, () => AudioSource> = {
  me: () => streamSource(openMicrophoneStream),
  them: () => streamSource(() => openSystemAudioStream()),
};

function watchMediaDevices(onChange: () => void): () => void {
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!devices?.addEventListener) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The event fires several times for one plug or switch.
  const handler = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 1_000);
  };
  devices.addEventListener("devicechange", handler);
  return () => {
    if (timer) clearTimeout(timer);
    devices.removeEventListener("devicechange", handler);
  };
}

type Stream = {
  speaker: Speaker;
  cutter: PartCutter;
  uploader: PartUploader;
  source: AudioSource | null;
  startedAt: number;
  level: number;
};

/**
 * One meeting's recording: Start creates the meeting and opens both streams (the mic at once, the system audio when
 * it answers), Pause drops audio and closes the open parts, Stop sends the last parts, sets `ended_at`, and sets it
 * again once every part is transcribed (the server ingests the meeting on each).
 */
export class MeetingRecorder {
  private state: RecorderState = { phase: "idle", meetingId: null, me: "pending", them: "pending", levels: { me: 0, them: 0 }, elapsedMs: 0, backlogMs: 0, catchingUp: false, gaps: [], error: null };
  private readonly streams: Record<Speaker, Stream>;
  private readonly sources: Record<Speaker, () => AudioSource>;
  private readonly now: () => number;
  private clockBase = 0;
  private clockStart: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unwatch: (() => void) | null = null;
  private endedAt: string | null = null;
  /** Resolves when the second `ended_at` has been sent (tests and the page wait on it). */
  finished: Promise<void> = Promise.resolve();

  constructor(private readonly options: MeetingRecorderOptions) {
    this.sources = options.sources ?? defaultSources;
    this.now = options.now ?? (() => performance.now());
    const upload: UploadPart = (speaker, part, offsetMs, wav) => options.client.uploadPart(this.state.meetingId!, speaker, part, offsetMs, wav);
    const stream = (speaker: Speaker): Stream => ({ speaker, cutter: new PartCutter(options.cutter), uploader: new PartUploader(speaker, upload, options.uploader), source: null, startedAt: 0, level: 0 });
    this.streams = { me: stream("me"), them: stream("them") };
  }

  get snapshot(): RecorderState {
    return this.state;
  }

  async start(title?: string): Promise<void> {
    if (this.state.phase !== "idle") return;
    this.set({ phase: "starting" });
    try {
      const { id } = await this.options.client.createMeeting({ ...(title ? { title } : {}), started_at: new Date().toISOString() });
      this.set({ meetingId: id });
    } catch (error) {
      this.set({ phase: "error", error: error instanceof OmniRushServerError ? error.code : "start_failed" });
      return;
    }
    this.clockStart = this.now();
    this.set({ phase: "recording" });
    this.ticker = setInterval(() => this.tick(), this.options.tickMs ?? 200);
    this.unwatch = (this.options.watchDevices ?? watchMediaDevices)(() => {
      if (this.state.them === "on") void this.restart("them");
    });
    await Promise.all([this.open("me"), this.open("them")]);
    const { me: mic, them: system, phase } = this.snapshot;
    if (mic === "off" && system === "off" && phase === "recording") {
      this.set({ error: "no_audio" });
      await this.stop();
    }
  }

  pause(): void {
    if (this.state.phase !== "recording") return;
    this.clockBase = this.clock();
    this.clockStart = null;
    for (const stream of Object.values(this.streams)) this.send(stream, stream.cutter.flush());
    this.set({ phase: "paused", levels: { me: 0, them: 0 } });
  }

  resume(): void {
    if (this.state.phase !== "paused") return;
    this.clockStart = this.now();
    this.set({ phase: "recording" });
  }

  /** Ends the recording. Resolves once `ended_at` is set the first time; `finished` once it is set again. */
  async stop(): Promise<void> {
    if (this.state.phase !== "recording" && this.state.phase !== "paused") return;
    this.set({ phase: "stopping" });
    this.unwatch?.();
    for (const stream of Object.values(this.streams)) {
      stream.source?.stop();
      stream.source = null;
      this.send(stream, stream.cutter.flush());
    }
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    const id = this.state.meetingId;
    if (!id) {
      this.set({ phase: "done" });
      return;
    }
    this.endedAt = new Date().toISOString();
    const end = () => this.options.client.endMeeting(id, this.endedAt!).catch(() => undefined);
    const waiting = this.backlogMs() > 0;
    await end();
    this.set({ phase: "done" });
    this.tick();
    this.finished = Promise.all([this.streams.me.uploader.drained(), this.streams.them.uploader.drained()]).then(async () => {
      // Parts that finished after Stop are in the transcript only once the meeting is ingested again.
      if (waiting) await end();
      this.tick();
    });
  }

  private clock(): number {
    return this.clockBase + (this.clockStart === null ? 0 : this.now() - this.clockStart);
  }

  private backlogMs(): number {
    return this.streams.me.uploader.backlogMs + this.streams.them.uploader.backlogMs;
  }

  private async open(speaker: Speaker): Promise<void> {
    const stream = this.streams[speaker];
    const source = this.sources[speaker]();
    stream.source = source;
    stream.startedAt = this.now();
    try {
      await source.start((samples) => this.frames(stream, samples), () => {
        if (stream.source !== source) return;
        // Ended right after it started: denied or not available, not a device change.
        if (this.now() - stream.startedAt < RESTART_MIN_LIFE_MS) this.off(stream);
        else void this.restart(speaker);
      });
    } catch {
      if (stream.source === source) this.off(stream);
      return;
    }
    if (stream.source !== source) return source.stop();
    stream.startedAt = this.now();
    this.send(stream, stream.cutter.skipTo(this.clock()));
    this.set(speaker === "me" ? { me: "on" } : { them: "on" });
  }

  private off(stream: Stream): void {
    stream.source?.stop();
    stream.source = null;
    this.send(stream, stream.cutter.flush());
    this.set(stream.speaker === "me" ? { me: "off" } : { them: "off" });
  }

  /** The output (or input) device changed or the stream ended: the open part is sent, the stream opens again. */
  private async restart(speaker: Speaker): Promise<void> {
    if (this.state.phase !== "recording" && this.state.phase !== "paused") return;
    const stream = this.streams[speaker];
    stream.source?.stop();
    stream.source = null;
    this.send(stream, stream.cutter.flush());
    await this.open(speaker);
  }

  private frames(stream: Stream, samples: Int16Array): void {
    if (this.state.phase !== "recording" || samples.length === 0) return;
    stream.level = Math.max(stream.level, rms(samples));
    for (const part of stream.cutter.push(samples)) this.send(stream, part);
  }

  private send(stream: Stream, part: Part | null): void {
    if (!part || part.peakRms < SILENT_PART_RMS) return;
    stream.uploader.add(part);
  }

  private tick(): void {
    const { me, them } = this.streams;
    this.set({
      elapsedMs: Math.round(this.clock()),
      levels: this.state.phase === "recording" ? { me: levelFromRms(me.level), them: levelFromRms(them.level) } : { me: 0, them: 0 },
      backlogMs: Math.round(this.backlogMs()),
      catchingUp: me.uploader.retrying || them.uploader.retrying,
      gaps: [...me.uploader.gaps, ...them.uploader.gaps],
      error: this.state.error ?? me.uploader.lastError ?? them.uploader.lastError,
    });
    me.level = 0;
    them.level = 0;
  }

  private set(patch: Partial<RecorderState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange?.(this.state);
  }
}
