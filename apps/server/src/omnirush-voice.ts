/**
 * Voice dictation's local half. The renderer records and segments speech
 * itself (voice-core); each segment is POSTed here and forwarded, unchanged,
 * to omnirush.ai's POST /omnirush/v1/audio/transcriptions with the device
 * bearer (the renderer never holds it). The audio exists only in this
 * request's memory: it is never written, logged, cached or handed to the
 * collector. Only the text the user finally sends becomes a prompt.
 */
import { execFile } from "node:child_process";
import path from "node:path";

import type { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";

/** 125 s of 16 kHz mono WAV plus multipart overhead; the backend enforces the same cap. */
export const VOICE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const STATUS_TTL_MS = 5 * 60_000;
const UNAVAILABLE_TTL_MS = 2 * 60_000;

export type VoiceAvailabilityState = {
  /** Null when not known yet (the service did not answer); the first upload then decides. */
  available: boolean | null;
  reason: string | null;
  /** Days the speech provider keeps uploaded audio (for the privacy note), when the backend says. */
  providerRetentionDays?: number | null;
  /** Seconds of dictation left today, when the account has a daily cap. */
  remainingSecondsToday?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A boolean flag, or `{ enabled }`. */
function flagOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return isRecord(value) && typeof value.enabled === "boolean" ? value.enabled : null;
}

/**
 * The catalog's voice flag: `features.voice` or a top-level `voice`, each a
 * boolean or `{ enabled }`. Null when the catalog does not mention voice.
 */
export function voiceFlagFromCatalog(body: unknown): boolean | null {
  if (!isRecord(body)) return null;
  return (isRecord(body.features) ? flagOf(body.features.voice) : null) ?? flagOf(body.voice);
}

/** `{available, reason, privacy: {provider_retention_days}, usage: {remaining_seconds_today}}` from the backend's voice status. */
export function voiceStatusFromBody(body: unknown): VoiceAvailabilityState {
  if (!isRecord(body)) return { available: null, reason: null };
  const available = typeof body.available === "boolean" ? body.available : null;
  const retention = isRecord(body.privacy) ? body.privacy.provider_retention_days : null;
  const remaining = isRecord(body.usage) ? body.usage.remaining_seconds_today : null;
  return {
    available,
    reason: typeof body.reason === "string" ? body.reason : available === false ? "voice_unavailable" : null,
    providerRetentionDays: typeof retention === "number" ? retention : null,
    remainingSecondsToday: typeof remaining === "number" ? remaining : null,
  };
}

type VoiceBroker = Pick<OmniRushGatewayBroker, "enabled" | "modelCatalog" | "voiceStatus" | "transcribe">;
type VoiceLog = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;

export class OmniRushVoiceService {
  private cached: { state: VoiceAvailabilityState; until: number } | null = null;
  private inflight: Promise<VoiceAvailabilityState> | null = null;

  constructor(
    private readonly broker: VoiceBroker,
    private readonly options: { log?: VoiceLog; now?: () => number } = {},
  ) {}

  get signedIn(): boolean {
    return this.broker.enabled;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Whether the account may use voice, from the model catalog (cached) and the last transcription refusal. */
  async availability(): Promise<VoiceAvailabilityState> {
    if (!this.broker.enabled) return { available: false, reason: "omnirush_account_required" };
    if (this.cached && this.cached.until > this.now()) return this.cached.state;
    this.inflight ??= this.readCatalog().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * The backend's GET /omnirush/v1/audio/transcriptions answers for this
   * account. A backend without the route (404/405) has no voice. When it
   * cannot be asked, the model catalog's voice flag is the fallback.
   */
  private async readCatalog(): Promise<VoiceAvailabilityState> {
    let state: VoiceAvailabilityState = { available: null, reason: null };
    try {
      const response = await this.broker.voiceStatus();
      if (response.ok) {
        state = voiceStatusFromBody(await response.json().catch(() => null));
      } else {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404 || response.status === 405) state = { available: false, reason: "voice_unavailable" };
      }
    } catch {
      // Not answered: fall through to the catalog.
    }
    if (state.available === null) {
      try {
        const response = await this.broker.modelCatalog();
        if (response.ok) {
          const flag = voiceFlagFromCatalog(await response.json().catch(() => null));
          if (flag !== null) state = { available: flag, reason: flag ? null : "voice_unavailable" };
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
      } catch {
        // Unknown: the mic stays usable and the first upload decides.
      }
    }
    // An unknown answer is asked again soon; a known one lasts the TTL.
    this.cached = { state, until: this.now() + (state.available === null ? 30_000 : STATUS_TTL_MS) };
    return state;
  }

  /**
   * Forwards one segment. The multipart body is passed through byte for byte;
   * only its size is checked here. A refusal that says voice is off for the
   * account is remembered so the mic can be disabled.
   */
  async transcribe(request: Request): Promise<Response> {
    if (!this.broker.enabled) {
      return Response.json({ error: { code: "omnirush_account_required", message: "Sign in to omnirush.ai to use voice." } }, { status: 401 });
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return Response.json({ error: { code: "invalid_payload", message: "Expected a multipart audio upload." } }, { status: 400 });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > VOICE_MAX_UPLOAD_BYTES) return tooLarge();
    const body = await request.arrayBuffer();
    if (body.byteLength > VOICE_MAX_UPLOAD_BYTES) return tooLarge();
    const started = this.now();
    let response: Response;
    try {
      response = await this.broker.transcribe(body, contentType, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      this.options.log?.("warn", "omnirush.ai voice transcription unreachable", { bytes: body.byteLength });
      return Response.json(
        { error: { code: "transcription_unreachable", message: "The transcription service could not be reached." } },
        { status: 503, headers: { "retry-after": "1" } },
      );
    }
    const text = await response.text();
    const code = errorCodeOf(text);
    if (code === "voice_unavailable" || code === "voice_disabled" || (response.status === 404 && !code)) {
      this.cached = { state: { available: false, reason: "voice_unavailable" }, until: this.now() + UNAVAILABLE_TTL_MS };
    } else if (response.ok && this.cached?.state.available !== true) {
      this.cached = { state: { ...this.cached?.state, available: true, reason: null }, until: this.now() + STATUS_TTL_MS };
    }
    // Sizes, status and latency only: never the audio, never the text.
    this.options.log?.(response.ok ? "info" : "warn", "omnirush.ai voice segment transcribed", {
      status: response.status,
      bytes: body.byteLength,
      ms: this.now() - started,
      ...(code ? { code } : {}),
    });
    const headers = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    // A 404 from an older backend means the route does not exist yet.
    if (response.status === 404 && !code) {
      return Response.json({ error: { code: "voice_unavailable", message: "Voice input is not available on this account yet." } }, { status: 503 });
    }
    return new Response(text, { status: response.status, headers });
  }
}

function tooLarge(): Response {
  return Response.json({ error: { code: "audio_too_large", message: "That recording is too long to transcribe." } }, { status: 413 });
}

function errorCodeOf(text: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  for (const value of [body.detail, body.error, body.code]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (isRecord(value) && typeof value.code === "string" && value.code.trim()) return value.code.trim();
  }
  return null;
}

function gitLine(directory: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", directory, ...args],
      { timeout: 1_500, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

/** The repository name and branch of a folder, for the transcription hint. Best effort, bounded. */
export async function voiceProjectContext(directory: string | null | undefined): Promise<{ repo: string | null; branch: string | null }> {
  if (!directory) return { repo: null, branch: null };
  const [top, branch] = await Promise.all([
    gitLine(directory, ["rev-parse", "--show-toplevel"]),
    gitLine(directory, ["symbolic-ref", "--short", "-q", "HEAD"]),
  ]);
  const folder = path.basename(path.resolve(directory));
  return { repo: top ? path.basename(top) : folder || null, branch: top ? branch : null };
}
