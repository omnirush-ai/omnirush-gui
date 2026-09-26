import { VOICE_SAMPLE_RATE } from "./types";

/** RMS of Int16 samples, normalized to 0..1. */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]! / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** A display level 0..1 for a normalized RMS: square-root scaled so quiet speech still moves the bars. */
export function levelFromRms(value: number): number {
  return Math.min(1, Math.sqrt((value * 32768) / 2000));
}

/** The rolling 16-bar level history the waveform draws. */
export class LevelMeter {
  private readonly history: number[];

  constructor(readonly bars = 16) {
    this.history = new Array<number>(bars).fill(0);
  }

  push(value: number): void {
    this.history.push(levelFromRms(value));
    if (this.history.length > this.bars) this.history.shift();
  }

  levels(): number[] {
    return [...this.history];
  }
}

export type Segment = {
  index: number;
  /** 16 kHz mono PCM, including a short lead-in before the first speech frame. */
  samples: Int16Array;
  startMs: number;
  endMs: number;
  /** Frames classified as speech, in ms. */
  speechMs: number;
  /** Highest frame RMS in the segment, 0..1. */
  peakRms: number;
  /** The speech threshold when the segment closed, for the hallucination filter. */
  threshold: number;
};

export type SegmenterOptions = {
  sampleRate?: number;
  /** Analysis frame length. */
  frameMs?: number;
  /** A pause at least this long ends a segment. */
  pauseMs?: number;
  /** A segment is cut here even mid-speech. */
  maxSegmentMs?: number;
  /** A segment shorter than this is held open across a normal pause (short segments transcribe badly). */
  minSegmentMs?: number;
  /** A pause this long ends even a short segment. */
  longPauseMs?: number;
  /** Less speech than this (a click, a cough) is dropped as noise. */
  minSpeechMs?: number;
  /** Audio kept before the first speech frame, so onsets are not clipped. */
  prerollMs?: number;
  /** Silence kept after the last speech frame. */
  tailMs?: number;
  /** Absolute speech floor (normalized RMS); the adaptive threshold never goes below it. */
  minThreshold?: number;
  /** Speech is this many times above the running noise floor. */
  noiseMultiplier?: number;
};

const DEFAULTS: Required<SegmenterOptions> = {
  sampleRate: VOICE_SAMPLE_RATE,
  frameMs: 20,
  pauseMs: 600,
  maxSegmentMs: 12_000,
  minSegmentMs: 1_000,
  longPauseMs: 1_500,
  minSpeechMs: 120,
  prerollMs: 200,
  tailMs: 250,
  minThreshold: 0.01,
  noiseMultiplier: 3,
};

/**
 * Energy VAD with an adaptive noise floor that splits a PCM stream into
 * speech segments at pauses. Silence outside a segment is discarded as it
 * arrives: a silent recording produces no segment at all, so nothing is ever
 * uploaded for it.
 */
export class Segmenter {
  readonly options: Required<SegmenterOptions>;
  private readonly frameSize: number;
  private pendingFrame: Int16Array = new Int16Array(0);
  private noiseFloor = 0.004;
  private frames: Int16Array[] = [];
  private frameRms: number[] = [];
  /** Frames before the first speech of the next segment, capped at the preroll. */
  private preroll: Int16Array[] = [];
  private inSegment = false;
  private speechFrames = 0;
  private silenceRun = 0;
  private segmentStartFrame = 0;
  private framesSeen = 0;
  private nextIndex = 0;
  /** Highest frame RMS of the whole stream. */
  maxRms = 0;
  /** Speech frames of the whole stream (including dropped noise bursts). */
  totalSpeechFrames = 0;

  constructor(options: SegmenterOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.frameSize = Math.round((this.options.sampleRate * this.options.frameMs) / 1000);
  }

  get threshold(): number {
    return Math.max(this.options.minThreshold, this.noiseFloor * this.options.noiseMultiplier);
  }

  /** Feeds PCM; returns segments that closed. `onFrame` sees every analysis frame's RMS (the level meter). */
  push(samples: Int16Array, onFrame?: (frameRms: number) => void): Segment[] {
    const closed: Segment[] = [];
    let data = samples;
    if (this.pendingFrame.length > 0) {
      data = new Int16Array(this.pendingFrame.length + samples.length);
      data.set(this.pendingFrame);
      data.set(samples, this.pendingFrame.length);
    }
    let offset = 0;
    for (; offset + this.frameSize <= data.length; offset += this.frameSize) {
      const frame = data.slice(offset, offset + this.frameSize);
      const value = rms(frame);
      onFrame?.(value);
      const segment = this.frame(frame, value);
      if (segment) closed.push(segment);
    }
    this.pendingFrame = data.slice(offset);
    return closed;
  }

  /** Ends the stream: the open segment, if it holds enough speech. */
  flush(): Segment | null {
    this.pendingFrame = new Int16Array(0);
    if (!this.inSegment) return null;
    return this.close(true);
  }

  private frame(frame: Int16Array, value: number): Segment | null {
    this.framesSeen += 1;
    this.maxRms = Math.max(this.maxRms, value);
    const speech = value > this.threshold;
    if (speech) this.totalSpeechFrames += 1;
    else this.noiseFloor = Math.min(0.05, Math.max(0.001, this.noiseFloor * 0.95 + value * 0.05));
    const { frameMs } = this.options;

    if (!this.inSegment) {
      if (!speech) {
        this.preroll.push(frame);
        if (this.preroll.length * frameMs > this.options.prerollMs) this.preroll.shift();
        return null;
      }
      this.inSegment = true;
      this.frames = [...this.preroll, frame];
      this.frameRms = [...this.preroll.map(rms), value];
      this.segmentStartFrame = this.framesSeen - this.frames.length;
      this.preroll = [];
      this.speechFrames = 1;
      this.silenceRun = 0;
      return null;
    }

    this.frames.push(frame);
    this.frameRms.push(value);
    if (speech) {
      this.speechFrames += 1;
      this.silenceRun = 0;
    } else {
      this.silenceRun += 1;
    }
    const lengthMs = this.frames.length * frameMs;
    const silenceMs = this.silenceRun * frameMs;
    if (lengthMs >= this.options.maxSegmentMs) return this.close(false);
    if (silenceMs >= this.options.longPauseMs) return this.close(true);
    if (silenceMs >= this.options.pauseMs && lengthMs - silenceMs >= this.options.minSegmentMs) return this.close(true);
    return null;
  }

  private close(trimSilence: boolean): Segment | null {
    const { frameMs } = this.options;
    let frames = this.frames;
    let frameRms = this.frameRms;
    if (trimSilence && this.silenceRun > 0) {
      const keep = Math.ceil(this.options.tailMs / frameMs);
      const drop = Math.max(0, this.silenceRun - keep);
      frames = frames.slice(0, frames.length - drop);
      frameRms = frameRms.slice(0, frameRms.length - drop);
      // The trimmed silence may lead into the next segment's preroll.
      this.preroll = this.frames.slice(this.frames.length - Math.min(drop, Math.ceil(this.options.prerollMs / frameMs)));
    } else {
      this.preroll = [];
    }
    const speechMs = this.speechFrames * frameMs;
    const startFrame = this.segmentStartFrame;
    this.inSegment = false;
    this.frames = [];
    this.frameRms = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
    if (speechMs < this.options.minSpeechMs) return null;
    const length = frames.reduce((total, frame) => total + frame.length, 0);
    const samples = new Int16Array(length);
    let at = 0;
    for (const frame of frames) {
      samples.set(frame, at);
      at += frame.length;
    }
    return {
      index: this.nextIndex++,
      samples,
      startMs: startFrame * frameMs,
      endMs: (startFrame + frames.length) * frameMs,
      speechMs,
      peakRms: Math.max(0, ...frameRms),
      threshold: this.threshold,
    };
  }
}
