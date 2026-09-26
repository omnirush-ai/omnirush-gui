import { applyKeyterms } from "./keyterms";
import { LevelMeter, Segmenter, type Segment, type SegmenterOptions } from "./segmenter";
import { countWords, isLikelyHallucination, stitch } from "./text";
import {
  VOICE_SAMPLE_RATE,
  VoiceError,
  isVoiceError,
  type AudioSource,
  type Transcriber,
  type VoicePhase,
  type VoiceResult,
  type VoiceSnapshot,
} from "./types";
import { encodeWav } from "./wav";

/** Pauses voice after `threshold` failures within `windowMs`, for `cooldownMs`. Shared by every recording. */
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;

  constructor(
    private readonly threshold = 3,
    private readonly windowMs = 10_000,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  recordFailure(): void {
    const at = this.now();
    this.failures = [...this.failures.filter((time) => at - time < this.windowMs), at];
    if (this.failures.length >= this.threshold) {
      this.openUntil = at + this.cooldownMs;
      this.failures = [];
    }
  }

  recordSuccess(): void {
    this.failures = [];
  }

  isOpen(): boolean {
    return this.now() < this.openUntil;
  }
}

export type VoiceSessionOptions = {
  source: AudioSource;
  transcriber: Transcriber;
  language?: string | null;
  keyterms?: readonly string[];
  /** Uploads in flight at once. */
  concurrency?: number;
  /** Pauses before each retry of a failed upload; its length is the retry count. */
  retryDelaysMs?: readonly number[];
  /** Hard cap on one recording. */
  maxRecordingMs?: number;
  /** Stop by itself after this much silence (tap mode); null never. */
  silenceAutoStopMs?: number | null;
  /** How long stop() waits for the last uploads. */
  finalizeTimeoutMs?: number;
  /** Below this peak RMS the microphone is reported as delivering no signal. */
  noSignalRms?: number;
  segmenter?: SegmenterOptions;
  breaker?: CircuitBreaker;
  recordingId?: string;
  /** Every state change, and level updates at most every `snapshotIntervalMs`. */
  onChange?: (snapshot: VoiceSnapshot) => void;
  /** The recording hit its cap or the silence limit and is finalizing on its own. */
  onAutoStop?: (reason: "max_duration" | "silence") => void;
  snapshotIntervalMs?: number;
  now?: () => number;
};

type SlotState =
  | { status: "pending" }
  | { status: "done"; text: string }
  | { status: "failed"; error: VoiceError };

type Job = { segment: Segment; wav: Uint8Array | null };

function randomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * One dictation: capture → VAD segments → one upload per segment while the
 * user keeps talking (at most `concurrency` at once, retried with backoff) →
 * texts stitched back in recording order.
 *
 * Audio is disposable: each segment's PCM is encoded, uploaded and dropped
 * as soon as its transcript (or final failure) is known; silence is dropped
 * as it arrives; cancel drops everything. Nothing is written anywhere.
 */
export class VoiceSession {
  readonly recordingId: string;
  private readonly options: VoiceSessionOptions;
  private readonly segmenter: Segmenter;
  private readonly meter = new LevelMeter();
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private phaseValue: VoicePhase = "idle";
  private slots: SlotState[] = [];
  private queue: Job[] = [];
  private active = 0;
  private startedAt = 0;
  private lastSpeechAt = 0;
  private lastSnapshotAt = 0;
  private error: VoiceError | null = null;
  private idleWaiters: Array<() => void> = [];
  private capTimer: ReturnType<typeof setInterval> | null = null;
  private result: VoiceResult | null = null;
  private stopping: Promise<VoiceResult> | null = null;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
    this.recordingId = options.recordingId ?? randomId();
    this.segmenter = new Segmenter({ sampleRate: VOICE_SAMPLE_RATE, ...options.segmenter });
    this.now = options.now ?? Date.now;
  }

  get phase(): VoicePhase {
    return this.phaseValue;
  }

  snapshot(): VoiceSnapshot {
    return {
      phase: this.phaseValue,
      levels: this.meter.levels(),
      elapsedMs: this.startedAt ? this.now() - this.startedAt : 0,
      text: this.orderedText(true),
      pending: this.slots.filter((slot) => slot.status === "pending").length,
      failed: this.slots.filter((slot) => slot.status === "failed").length,
      error: this.error,
    };
  }

  async start(): Promise<void> {
    if (this.phaseValue !== "idle") throw new Error("A voice session starts once");
    if (this.options.breaker?.isOpen()) {
      this.fail(new VoiceError("breaker_open", "Voice paused after repeated errors. Try again in a moment."));
      throw this.error;
    }
    this.setPhase("arming");
    try {
      await this.options.source.start(
        (frames) => this.onFrames(frames),
        (error) => {
          if (error) {
            this.abortAll();
            this.fail(error);
          } else if (this.phaseValue === "recording") {
            // The source ran dry (a file input): finalize like a release.
            void this.stop();
          }
        },
      );
    } catch (error) {
      this.options.source.stop();
      this.fail(isVoiceError(error) ? error : new VoiceError("capture_failed", "The microphone could not be opened."));
      throw this.error;
    }
    if (this.phase !== "arming") return;
    this.startedAt = this.now();
    this.lastSpeechAt = this.startedAt;
    this.setPhase("recording");
    this.capTimer = setInterval(() => this.checkCaps(), 250);
  }

  /** Ends capture and waits for the last segment's text. Idempotent. */
  stop(): Promise<VoiceResult> {
    if (this.result) return Promise.resolve(this.result);
    this.stopping ??= this.finalize();
    return this.stopping;
  }

  /** Drops the recording: capture stops, uploads are aborted, no text is returned. */
  cancel(): void {
    if (this.phaseValue === "done" || this.phaseValue === "cancelled") return;
    this.abortAll();
    this.slots = [];
    this.result = { text: "", words: 0, segments: 0, error: null };
    this.setPhase("cancelled");
    this.releaseWaiters();
  }

  private abortAll(): void {
    this.clearCapTimer();
    this.options.source.stop();
    this.abort.abort();
    for (const job of this.queue) job.wav = null;
    this.queue = [];
  }

  private async finalize(): Promise<VoiceResult> {
    if (this.phaseValue === "idle" || this.phaseValue === "arming") this.cancel();
    if (this.phaseValue === "cancelled" || this.phaseValue === "error") {
      this.result ??= { text: "", words: 0, segments: 0, error: this.error };
      return this.result;
    }
    this.clearCapTimer();
    this.options.source.stop();
    this.setPhase("finalizing");
    const last = this.segmenter.flush();
    if (last) this.enqueue(last);
    const deadline = this.options.finalizeTimeoutMs ?? 45_000;
    const timedOut = await Promise.race([
      this.whenIdle().then(() => false),
      wait(deadline, this.abort.signal).then(() => true),
    ]);
    if (this.phase === "cancelled") return this.result ?? { text: "", words: 0, segments: 0, error: null };
    if (timedOut && this.active + this.queue.length > 0) {
      this.abort.abort();
      this.queue = [];
      this.slots = this.slots.map((slot) => slot.status === "pending"
        ? { status: "failed", error: new VoiceError("network", "The transcription service took too long.") }
        : slot);
    }
    const text = this.orderedText(false);
    const error = this.outcomeError(text);
    this.result = { text, words: countWords(text), segments: this.slots.length, error };
    this.error = error;
    this.slots = [];
    this.setPhase("done");
    return this.result;
  }

  private outcomeError(text: string): VoiceError | null {
    const failed = this.slots.find((slot): slot is Extract<SlotState, { status: "failed" }> => slot.status === "failed");
    if (failed) return failed.error;
    if (text) return null;
    if (this.slots.length === 0 && this.segmenter.maxRms < (this.options.noSignalRms ?? 0.003)) {
      return new VoiceError("no_signal", "No audio came from the microphone. Check the input device in Settings → Voice.");
    }
    return new VoiceError("no_speech", "No speech was detected.");
  }

  private onFrames(frames: Int16Array): void {
    // A source may deliver its first frames before start() has resolved.
    if (this.phaseValue !== "recording" && this.phaseValue !== "arming") return;
    const threshold = this.segmenter.threshold;
    const closed = this.segmenter.push(frames, (value) => {
      this.meter.push(value);
      if (value > threshold) this.lastSpeechAt = this.now();
    });
    for (const segment of closed) this.enqueue(segment);
    const at = this.now();
    if (closed.length > 0 || at - this.lastSnapshotAt >= (this.options.snapshotIntervalMs ?? 50)) this.emit();
  }

  private checkCaps(): void {
    if (this.phaseValue !== "recording") return;
    const at = this.now();
    if (at - this.startedAt >= (this.options.maxRecordingMs ?? 120_000)) {
      this.options.onAutoStop?.("max_duration");
      void this.stop();
      return;
    }
    const silence = this.options.silenceAutoStopMs;
    if (silence != null && at - this.lastSpeechAt >= silence) {
      this.options.onAutoStop?.("silence");
      void this.stop();
    }
  }

  private enqueue(segment: Segment): void {
    this.slots[segment.index] = { status: "pending" };
    this.queue.push({ segment, wav: null });
    this.pump();
    this.emit();
  }

  private pump(): void {
    const limit = Math.max(1, this.options.concurrency ?? 2);
    while (this.active < limit && this.queue.length > 0 && !this.abort.signal.aborted) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
        if (this.active === 0 && this.queue.length === 0) this.releaseWaiters();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { segment } = job;
    job.wav = encodeWav(segment.samples);
    // The PCM is not needed once it is encoded.
    const segmentMeta = { peakRms: segment.peakRms, threshold: segment.threshold, speechMs: segment.speechMs };
    const durationMs = segment.endMs - segment.startMs;
    const delays = this.options.retryDelaysMs ?? [300, 1_200];
    const keyterms = this.options.keyterms ?? [];
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (this.abort.signal.aborted || !job.wav) return;
        try {
          const { text } = await this.options.transcriber.transcribe({
            wav: job.wav,
            segmentIndex: segment.index,
            recordingId: this.recordingId,
            language: this.options.language ?? null,
            keyterms,
            durationMs,
          }, this.abort.signal);
          if (this.abort.signal.aborted) return;
          this.options.breaker?.recordSuccess();
          const cleaned = isLikelyHallucination(text, segmentMeta) ? "" : applyKeyterms(text.trim(), keyterms);
          this.slots[segment.index] = { status: "done", text: cleaned };
          return;
        } catch (error) {
          if (this.abort.signal.aborted) return;
          const voiceError = isVoiceError(error)
            ? error
            : new VoiceError("network", "The transcription service could not be reached.", { retryable: true });
          if (voiceError.retryable && attempt < delays.length) {
            const pause = Math.min(5_000, Math.max(delays[attempt]!, voiceError.retryAfterMs ?? 0));
            await wait(pause, this.abort.signal);
            continue;
          }
          if (voiceError.kind === "network") this.options.breaker?.recordFailure();
          this.slots[segment.index] = { status: "failed", error: voiceError };
          return;
        }
      }
    } finally {
      // Disposable audio: the segment's bytes go as soon as its outcome is known.
      job.wav = null;
      segment.samples = new Int16Array(0);
      this.emit();
    }
  }

  /** Finished texts in order; with `stopAtPending`, up to the first segment still in flight. */
  private orderedText(stopAtPending: boolean): string {
    const parts: string[] = [];
    for (const slot of this.slots) {
      if (!slot) continue;
      if (slot.status === "pending") {
        if (stopAtPending) break;
        continue;
      }
      if (slot.status === "done") parts.push(slot.text);
    }
    return stitch(parts);
  }

  private whenIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private releaseWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private clearCapTimer(): void {
    if (this.capTimer) clearInterval(this.capTimer);
    this.capTimer = null;
  }

  private fail(error: VoiceError | null): void {
    this.error = error;
    this.clearCapTimer();
    this.slots = [];
    this.setPhase("error");
    this.releaseWaiters();
  }

  private setPhase(phase: VoicePhase): void {
    this.phaseValue = phase;
    this.emit();
  }

  private emit(): void {
    this.lastSnapshotAt = this.now();
    try {
      this.options.onChange?.(this.snapshot());
    } catch {
      // A listener never breaks the recording.
    }
  }
}
