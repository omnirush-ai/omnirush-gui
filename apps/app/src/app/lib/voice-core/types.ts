/** 16 kHz mono signed 16-bit PCM: the only format voice-core produces and uploads. */
export const VOICE_SAMPLE_RATE = 16_000;

export type VoiceErrorKind =
  /** The microphone delivered only silence (RMS never rose above the no-signal floor). */
  | "no_signal"
  /** There was sound, but nothing that transcribed to words. */
  | "no_speech"
  /** The transcription service could not be reached, or kept failing. */
  | "network"
  /** Voice is switched off for this account or server (503 voice_unavailable). */
  | "unavailable"
  /** The service could not decode the audio (422 audio_unreadable). */
  | "unreadable"
  /** Too many requests or the daily audio budget is spent (429). */
  | "rate_limited"
  /** The account is signed out or its session expired (401). */
  | "signed_out"
  /** The OS or the user refused microphone access. */
  | "permission_denied"
  /** No microphone is connected, or the chosen one is gone. */
  | "no_device"
  /** The microphone exists but could not be opened (in use, driver error). */
  | "capture_failed"
  /** Three failures in a short window: voice pauses for a moment. */
  | "breaker_open"
  /** The recording or a segment was larger than the service accepts. */
  | "too_large";

export class VoiceError extends Error {
  readonly kind: VoiceErrorKind;
  readonly retryable: boolean;
  /** How long the service asked to wait before the next try, when it said. */
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(kind: VoiceErrorKind, message: string, options: { retryable?: boolean; retryAfterMs?: number | null; status?: number | null } = {}) {
    super(message);
    this.name = "VoiceError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
  }
}

export function isVoiceError(value: unknown): value is VoiceError {
  return value instanceof VoiceError;
}

/** One speech segment's upload. */
export type TranscribeRequest = {
  /** A complete RIFF/WAVE file, 16 kHz mono s16le. */
  wav: Uint8Array;
  segmentIndex: number;
  recordingId: string;
  /** BCP-47 hint, or null for auto-detect. */
  language: string | null;
  keyterms: readonly string[];
  durationMs: number;
};

export type TranscribeResult = { text: string };

export interface Transcriber {
  /** Resolves with the segment's text; rejects with a VoiceError (or anything, read as a network failure). */
  transcribe(request: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult>;
}

/**
 * Where PCM comes from: a microphone, a WAV file (tests), a native recorder
 * (CLI). Frames are 16 kHz mono Int16 of any length.
 */
export interface AudioSource {
  start(onFrames: (frames: Int16Array) => void, onEnd?: (error?: VoiceError) => void): Promise<void>;
  stop(): void;
}

export type VoicePhase = "idle" | "arming" | "recording" | "finalizing" | "done" | "cancelled" | "error";

export type VoiceSnapshot = {
  phase: VoicePhase;
  /** The last 16 input levels, 0..1, oldest first. */
  levels: number[];
  elapsedMs: number;
  /** Text of the finished segments, in order, stopped at the first one still in flight. */
  text: string;
  /** Segments uploaded (or queued) whose text has not arrived yet. */
  pending: number;
  /** Segments that failed for good; their audio is lost, the rest of the text is kept. */
  failed: number;
  error: VoiceError | null;
};

export type VoiceResult = {
  text: string;
  /** Words in `text`, counting CJK characters one by one. */
  words: number;
  segments: number;
  /** Set when nothing usable came back (no signal, no speech, service down) or part of it was lost. */
  error: VoiceError | null;
};
