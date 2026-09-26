import { VoiceError, type TranscribeRequest, type TranscribeResult, type Transcriber } from "./types";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RemoteTranscriberOptions = {
  /** POST target: the backend's /omnirush/v1/audio/transcriptions, or a local broker route in front of it. */
  url: string;
  /** Called per request, so a rotated bearer is picked up. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: FetchLike;
  /** Per-request deadline. */
  timeoutMs?: number;
};

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** The error code of a JSON error body: `{"detail":"x"}`, `{"error":"x"}`, `{"error":{"code":"x"}}` or `{"code":"x"}`. */
export function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const value of [record.detail, record.error, record.code]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const code = (value as Record<string, unknown>).code;
      if (typeof code === "string" && code.trim()) return code.trim();
    }
  }
  return null;
}

/** Maps a transcription service answer to the error the user reads. */
export function voiceErrorFromResponse(status: number, code: string | null, retryAfter: number | null): VoiceError {
  if (status === 401 || code === "omnirush_account_required") {
    return new VoiceError("signed_out", "Sign in to omnirush.ai to use voice.", { status });
  }
  if (code === "voice_unavailable" || code === "voice_disabled" || status === 404) {
    return new VoiceError("unavailable", "Voice input is not available on this account yet.", { status });
  }
  if (status === 422 || code === "audio_unreadable") {
    return new VoiceError("unreadable", "The recording could not be read. Try again.", { status });
  }
  if (status === 400 || status === 415) {
    return new VoiceError("unreadable", "The recording was not in a format the transcription service accepts.", { status });
  }
  if (status === 413 || code === "audio_too_long" || code === "audio_too_large") {
    return new VoiceError("too_large", "That recording is too long to transcribe.", { status });
  }
  if (status === 429) {
    const budget = code === "voice_daily_budget_exhausted" || code === "daily_grant_exhausted";
    return new VoiceError(
      "rate_limited",
      code === "daily_grant_exhausted"
        ? "You have used today's model allowance, which voice falls back on. It refills at 00:00 UTC."
        : budget ? "You have used today's voice allowance. It refills at 00:00 UTC." : "Voice is busy. Try again in a moment.",
      { status, retryable: !budget, retryAfterMs: retryAfter },
    );
  }
  return new VoiceError("network", "The transcription service did not answer. Try again.", {
    status,
    retryable: status >= 500 || status === 408 || status === 0,
    retryAfterMs: retryAfter,
  });
}

/**
 * A Transcriber over HTTP: one multipart POST per segment (`file`,
 * `language`, `prompt_terms`, `segment_index`, `recording_id`), answered
 * with `{"text": "..."}`. The audio lives only in the request body.
 */
export class RemoteTranscriber implements Transcriber {
  constructor(private readonly options: RemoteTranscriberOptions) {}

  async transcribe(request: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult> {
    const form = new FormData();
    const wav = request.wav;
    form.append("file", new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], { type: "audio/wav" }), `segment-${request.segmentIndex}.wav`);
    if (request.language) form.append("language", request.language);
    if (request.keyterms.length > 0) form.append("prompt_terms", request.keyterms.join(", "));
    form.append("segment_index", String(request.segmentIndex));
    form.append("recording_id", request.recordingId);
    const fetcher = this.options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await fetcher(this.options.url, {
        method: "POST",
        headers: { Accept: "application/json", ...(await this.options.headers?.()) },
        body: form,
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new VoiceError("network", "The transcription service could not be reached.", { retryable: true, status: 0 });
    }
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw voiceErrorFromResponse(response.status, errorCode(body), retryAfterMs(response));
    const value = body && typeof body === "object" ? (body as Record<string, unknown>).text : null;
    if (typeof value !== "string") {
      throw new VoiceError("network", "The transcription service sent an unexpected answer.", { retryable: true, status: response.status });
    }
    return { text: value };
  }
}
