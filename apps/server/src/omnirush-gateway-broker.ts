import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

import { SESSION_UPLOAD_BUDGET, SESSION_UPLOAD_ENDPOINT_PATH, sessionUploadTimeoutMs, type SessionUploadBudget } from "./session-upload-budget.js";
import { externalFetch } from "./server-fetch.js";
import type { OmniRushGatewayCredentials } from "./types.js";
import type { TraceCapabilities, UploadRequestOptions } from "./session-uploader.js";
import {
  SUBAGENT_FALLBACK_EFFORT_HEADER,
  SUBAGENT_FALLBACK_MODEL_HEADER,
  SUBAGENT_ROOT_SESSION_HEADER,
  PARENT_SESSION_HEADER,
} from "./omnirush-swarm.js";
import { builtinOmniRushModelCatalog, omnirushModelWantsReasoningSummary } from "./omnirush-model-catalog.js";
import { RejectedAttachments, isRejectedAttachmentError, type Attachment } from "./rejected-attachments.js";

/** A refused attachment is left out and the model request sent again, at most this often per request. */
const MAX_ATTACHMENT_RETRIES = 2;
const MAX_ATTACHMENT_ERROR_BYTES = 256 * 1024;

const TRACE_CAPABILITY_TTL_MS = 5 * 60_000;

/** Without the account's catalog (a standalone broker): the built-in catalog decides. */
function defaultReasoningSummaryFor(model: string): boolean {
  return omnirushModelWantsReasoningSummary(builtinOmniRushModelCatalog(), model);
}

/** A sub-agent request the gateway refused on the picked model and that was sent again on the main model. */
export type SubagentModelFallbackEvent = {
  /** The sub-agent session (x-omnirush-session-id), when the request named it. */
  sessionId: string | null;
  /** The main session above it, when the swarm plugin named it. */
  rootSessionId: string | null;
  /** The engine message id of the prompt (x-omnirush-task-id). */
  messageId: string | null;
  requested: string;
  used: string;
  effort: string | null;
  /** The gateway's error code, or `http_<status>` without one. */
  reason: string;
  status: number;
  /** Whether the main model answered. */
  ok: boolean;
  at: number;
};

type BrokerOptions = {
  credentials?: OmniRushGatewayCredentials;
  engineToken?: string;
  fetch?: typeof externalFetch;
  /** Electron's file-aware transport. Standalone runtimes use the bounded Node stream fallback. */
  uploadFile?: (url: string, init: {
    method: "POST";
    headers: Record<string, string>;
    path: string;
    size: number;
    signal?: AbortSignal;
  }) => Promise<Response>;
  log?: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
  /** uploadSession()'s deadline parameters; SESSION_UPLOAD_BUDGET unless a test shrinks it. */
  sessionUploadBudget?: SessionUploadBudget;
  /** Hears every sub-agent request moved to the main model (see subagentFallback). */
  onSubagentFallback?: (event: SubagentModelFallbackEvent) => void;
  /** The pause before a busy picked model is tried once more; tests shrink it. */
  subagentRetryDelayMs?: number;
  /** Whether a picked sub-agent model is in its refusal cooldown (sent straight to the main model). */
  subagentModelRefused?: (model: string) => boolean;
  /**
   * Whether a Responses request for this model asks for reasoning summaries
   * (the account's catalog decides; the built-in catalog when unset).
   */
  reasoningSummaryFor?: (model: string) => boolean | Promise<boolean>;
  /** Hears the gateway's mandatory-update signals (see GatewayUpdateSignal). */
  onUpdateSignal?: (signal: GatewayUpdateSignal) => void;
  /**
   * The desktop app's version: every request to omnirush.ai then names it in
   * `X-OmniRush-Client: gui/<version>`, so the backend knows an updated app
   * from its first call. Unset (a standalone server) sends no header.
   */
  clientVersion?: string;
};

export const CLIENT_HEADER = "X-OmniRush-Client";

/** `gui/<version>` for a plain version string, or null. */
export function guiClientHeaderValue(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, "") ?? "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(trimmed) ? `gui/${trimmed}` : null;
}

/** `init` with the client header added; every other header and option is kept. */
function withClientHeader(init: RequestInit | undefined, value: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(CLIENT_HEADER, value);
  return { ...init, headers };
}

/**
 * omnirush.ai asking this app to update: before the deadline every gateway
 * answer carries `x-omnirush-update-required: <minimum>; deadline=<iso>`;
 * after it, model requests from an outdated app get HTTP 426
 * `update_required`. Session uploads, project archives, sign-in, refresh and
 * the profile are never refused, so nothing here stops them.
 */
export type GatewayUpdateSignal =
  | { kind: "header"; value: string }
  | { kind: "rejection"; message: string | null };

export const UPDATE_REQUIRED_HEADER = "x-omnirush-update-required";
export const UPDATE_REQUIRED_CODE = "update_required";

/**
 * Upstream model streams have been observed to end mid-response (the proxy
 * closes the connection while a function call is still streaming). Without a
 * terminal event the engine keeps the turn open forever and the UI shows
 * nothing. The guard appends a synthetic Responses-API error event when the
 * upstream closes early or stalls, so the turn fails visibly and can be retried.
 *
 * Terminal is decided per SSE event, on its data: a Responses
 * `response.completed`, `response.incomplete` or `response.failed`, the bare
 * `data: [DONE]` sentinel (every Muse stream ends with one), or an error
 * frame. Comment lines such as `: keepalive` carry no data and are never
 * terminal.
 */
const TERMINAL_RESPONSE_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);
const TERMINAL_OR_ERROR_MARKER = /"(?:response\.(?:completed|incomplete|failed)|error)"/;
/** An event larger than this passes through unread; the marker scan below then decides terminality. */
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const TERMINAL_EVENT_PATTERN = /"type":"(?:response\.(?:completed|failed|incomplete)|error)"|(?:^|[\r\n])data: ?\[DONE\][\r\n]/;
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
export type StreamInterruption = "truncated" | "idle";

const LF = 0x0a;
const CR = 0x0d;

function interruptedEvent(reason: StreamInterruption): Uint8Array {
  const message = reason === "idle"
    ? "omnirush.ai: the model stream stalled and was closed. Retry the request."
    : "omnirush.ai: the model stream ended before the response completed. Retry the request.";
  const payload = {
    type: "error",
    sequence_number: -1,
    error: { type: "server_error", code: "upstream_stream_interrupted", message },
  };
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
}

const UNAVAILABLE_COPY = "this model is temporarily unavailable. Try again in a minute, or pick another model.";
const BUSY_COPY = "this model is busy right now. Try again in a moment.";
const STALLED_COPY = "the model stopped responding before it finished. Retry the request, or pick a lower effort.";
const SETUP_COPY = "the model route is being set up. Try again later.";

/**
 * What the user reads for an omnirush.ai gateway error: the backend's own
 * codes, and the relay codes it passes through (mid-stream as
 * `upstream_<code>`). Kept in step with the console's chat copy.
 */
const GATEWAY_ERROR_COPY: Record<string, string> = {
  model_unavailable: "this model is not available on your account right now. Pick another model.",
  model_not_allowed: "this model is not available to your account. Pick another model.",
  model_not_found: "this model is not available right now. Pick another model.",
  model_input_not_supported: "this model cannot read that attachment. Remove the image or PDF, or pick another model.",
  model_concurrency_limited: "too many answers are already running on this model. Wait for one to finish, then try again.",
  model_request_too_large: "this request is too large to send. Remove an attachment or start a new session.",
  reasoning_effort_not_allowed: "this model does not offer the selected effort. Pick another effort.",
  unsupported_model_endpoint: "this model cannot run this kind of request. Pick another model.",
  daily_grant_exhausted: "you have used today's model allowance. It refills at 00:00 UTC.",
  grant_check_unavailable: "your model allowance could not be checked. Try again in a moment.",
  account_inactive: "model access is paused for this account. Open your omnirush.ai dashboard to see why.",
  consent_required: "accept the omnirush.ai data terms on your dashboard, then try again.",
  consent_version_outdated: "the omnirush.ai data terms were updated. Accept the new version on your dashboard, then try again.",
  internal_proxy_unavailable: "the model service did not respond. Try again in a moment.",
  internal_proxy_not_configured: SETUP_COPY,
  internal_proxy_ca_missing: SETUP_COPY,
  muse_relay_not_configured: UNAVAILABLE_COPY,
  model_upstream_auth_failed: UNAVAILABLE_COPY,
  model_upstream_misconfigured: UNAVAILABLE_COPY,
  model_upstream_unavailable: "the model service could not be reached. Try again in a moment.",
  stream_interrupted: "the model stream ended before the response completed. Retry the request.",
  idle_timeout: STALLED_COPY,
  first_byte_timeout: STALLED_COPY,
  request_timeout: STALLED_COPY,
  provider_error: "the model provider could not complete this request.",
  provider_unavailable: UNAVAILABLE_COPY,
  provider_auth_error: UNAVAILABLE_COPY,
  capacity_unavailable: UNAVAILABLE_COPY,
  circuit_open: UNAVAILABLE_COPY,
  maintenance: UNAVAILABLE_COPY,
  draining: UNAVAILABLE_COPY,
  auth_unavailable: UNAVAILABLE_COPY,
  token_capacity: BUSY_COPY,
  gateway_overload: BUSY_COPY,
  queue_timeout: BUSY_COPY,
  omni_queue_timeout: "every model seat is taken right now, and this turn waited in line too long. Send your message again; your place in line is kept for a few minutes.",
  provider_rate_limited: BUSY_COPY,
  voice_unavailable: "voice input is not available on this account yet.",
  transcription_unavailable: "the transcription service did not answer. Try again in a moment.",
  audio_unreadable: "the recording could not be read. Try again.",
  update_required: "this version of OmniRush.ai is no longer supported. Update the app to keep using models; your sessions are kept.",
};

/** Readable copy for a gateway error code, or null for a code it does not know. */
export function gatewayErrorMessage(code: string, detail?: string | null): string | null {
  const copy = GATEWAY_ERROR_COPY[code] ?? GATEWAY_ERROR_COPY[code.replace(/^upstream_/, "")];
  if (!copy) return null;
  // A provider error names what it refused ("Upstream returned an error: <why>").
  const why = code.endsWith("provider_error")
    ? detail?.replace(/^\s*upstream returned an error:?/i, "").trim().slice(0, 300)
    : "";
  return why ? `omnirush.ai: ${copy} (${why})` : `omnirush.ai: ${copy}`;
}

/** The user's clock for a grant reset; tests pin it, the app uses the system's. */
export type GrantClock = { now?: number; timeZone?: string; hourCycle?: Intl.DateTimeFormatOptions["hourCycle"] };

/**
 * What a `daily_grant_exhausted` refusal ran out of, from the gateway's
 * `x-omnirush-grant-scope` ('day' | 'week' | 'empty') and
 * `x-omnirush-grant-resets-at` (UTC ISO 8601), with the reset on the user's
 * clock: "Today's tokens are used up. They refill at 5:30 AM (in 3 h)."
 * Null without a known scope (an older gateway): the caller keeps its
 * general copy.
 */
export function grantExhaustedCopy(headers: Headers, consoleUrl: string | null, clock: GrantClock = {}): string | null {
  const scope = headers.get("x-omnirush-grant-scope")?.trim().toLowerCase();
  if (scope === "empty") {
    return `You have no tokens left. Link Discord or connect GitHub in the console to earn tokens every day${consoleUrl ? `: ${consoleUrl}` : "."}`;
  }
  if (scope !== "day" && scope !== "week") return null;
  const at = Date.parse(headers.get("x-omnirush-grant-resets-at") ?? "");
  const when = Number.isFinite(at) ? localReset(at, scope, clock) : scope === "day" ? "00:00 UTC" : "Monday 00:00 UTC";
  return scope === "day" ? `Today's tokens are used up. They refill at ${when}.` : `This week's cap is reached. It resets ${when}.`;
}

/** "5:30 AM (in 3 h)", or "Monday 5:30 AM (in 4 days)" for the week: English words, the user's time zone and 12/24-hour style. */
function localReset(at: number, scope: "day" | "week", clock: GrantClock): string {
  const { timeZone } = clock;
  const hourCycle = clock.hourCycle ?? new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hourCycle, timeZone }).format(at);
  const local = scope === "week" ? `${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(at)} ${time}` : time;
  const left = at - (clock.now ?? Date.now());
  if (left <= 0) return local;
  const minutes = Math.max(1, Math.round(left / 60_000));
  const hours = Math.round(minutes / 60);
  const relative = minutes < 60 ? `${minutes} min` : hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
  return `${local} (in ${relative})`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * An error frame the engine can show: the gateway's
 * `{type:"error",sequence_number,error:{...}}`, OpenAI's flat
 * `{type:"error",sequence_number,code,message}`, or a relay `event: error` /
 * `{"error":{...}}` that reached the broker unrewritten. A frame the engine's
 * AI SDK already parses and that has no readable copy passes unchanged;
 * anything else becomes the nested shape with the copy. The SDK drops an
 * error chunk without a numeric sequence_number (or with a non-string error
 * type, code or message), which would end the turn silently, and the engine
 * shows only a nested error's message.
 */
/**
 * Codes that end the turn instead of being retried by the engine. A turn the
 * gateway's omni queue held past its maximum wait (`omni_queue_timeout`,
 * sent inside the committed stream) would otherwise be retried up to five
 * times by the engine, each retry waiting in line again: the chat shows
 * "running" for many minutes with nothing happening. The engine retries any
 * stream error except a few codes; `invalid_prompt` is one it shows as it is
 * and never retries (provider/error.ts, session/retry.ts), as long as the
 * message names nothing its retry patterns match.
 */
const TURN_ENDING_STREAM_CODES = new Set(["omni_queue_timeout"]);
const QUEUE_TIMEOUT_COPY = "omnirush.ai: every model seat is taken right now, and this turn waited in line too long. Send your message again; your place in line is kept for a few minutes.";

function turnEndingEvent(code: string, sequence: unknown): Uint8Array {
  const frame = {
    type: "error",
    sequence_number: typeof sequence === "number" && Number.isFinite(sequence) ? sequence : -1,
    error: { type: "invalid_request_error", code: "invalid_prompt", message: QUEUE_TIMEOUT_COPY, param: code },
  };
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(frame)}\n\n`);
}

function errorEvent(block: Uint8Array, payload: Record<string, unknown>): Uint8Array {
  const nested = isRecord(payload.error) ? payload.error : null;
  const code = stringField(nested ? nested.code : payload.code);
  const baseCode = code?.replace(/^upstream_/, "") ?? null;
  if (baseCode && TURN_ENDING_STREAM_CODES.has(baseCode)) return turnEndingEvent(baseCode, payload.sequence_number);
  const original = stringField(nested ? nested.message : payload.message);
  const readable = code ? gatewayErrorMessage(code, original) : null;
  const sequence = payload.sequence_number;
  const parsed = payload.type === "error"
    && typeof sequence === "number"
    && (nested
      ? typeof nested.type === "string" && typeof nested.code === "string" && typeof nested.message === "string"
      : typeof payload.message === "string");
  if (parsed && !readable) return block;
  const param = stringField(nested ? nested.param : payload.param);
  const frame = {
    type: "error",
    sequence_number: typeof sequence === "number" && Number.isFinite(sequence) ? sequence : -1,
    error: {
      type: stringField(nested?.type) ?? "server_error",
      code: code ?? "upstream_error",
      message: readable ?? original ?? `omnirush.ai: the model request failed (${code ?? "upstream_error"}).`,
      ...(param ? { param } : {}),
    },
  };
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(frame)}\n\n`);
}

function sseEventFields(block: Uint8Array): { name: string | null; data: string | null } {
  let name: string | null = null;
  const data: string[] = [];
  for (const line of new TextDecoder().decode(block).split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  return { name, data: data.length > 0 ? data.join("\n") : null };
}

/**
 * Splits an SSE byte stream into whole events, forwarding each unchanged
 * except error frames, which are normalized (errorEvent). A partial event is
 * held until its blank line arrives; the engine cannot act on it earlier.
 */
class SseEventFramer {
  terminal = false;
  private buffer = new Uint8Array(4096);
  private length = 0;
  /** Where the blank-line scan resumes, and whether that offset starts a line. */
  private scanned = 0;
  private lineStart = true;
  private unframed = false;
  private tail = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.unframed) {
      this.scanUnframed(chunk);
      return [chunk];
    }
    this.append(chunk);
    const events: Uint8Array[] = [];
    let start = 0;
    for (let end = this.nextBoundary(); end >= 0; end = this.nextBoundary()) {
      events.push(this.event(this.buffer.slice(start, end)));
      start = end;
    }
    if (start > 0) {
      this.buffer.copyWithin(0, start, this.length);
      this.length -= start;
      this.scanned -= start;
    }
    if (this.length > MAX_EVENT_BYTES) {
      const oversized = this.buffer.slice(0, this.length);
      this.length = 0;
      this.unframed = true;
      this.scanUnframed(oversized);
      events.push(oversized);
    }
    return events;
  }

  /**
   * The upstream closed: an event still missing its blank line is kept only
   * when the stream already ended (a final `data: [DONE]` without one);
   * otherwise it is dropped so the interruption frame stays well formed.
   */
  finish(): Uint8Array | null {
    if (this.length === 0) return null;
    const rest = this.buffer.slice(0, this.length);
    this.length = 0;
    const event = this.event(rest);
    return this.terminal ? event : null;
  }

  private append(chunk: Uint8Array): void {
    if (this.length + chunk.length > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  /** The offset just past the next blank line (CRLF, LF or CR line endings), or -1. */
  private nextBoundary(): number {
    let index = this.scanned;
    while (index < this.length) {
      const byte = this.buffer[index];
      if (byte !== LF && byte !== CR) {
        this.lineStart = false;
        index += 1;
        continue;
      }
      let end = index + 1;
      if (byte === CR) {
        // CR or CRLF: the next byte decides.
        if (end === this.length) break;
        if (this.buffer[end] === LF) end += 1;
      }
      if (this.lineStart) {
        this.scanned = end;
        return end;
      }
      this.lineStart = true;
      index = end;
    }
    this.scanned = index;
    return -1;
  }

  private event(block: Uint8Array): Uint8Array {
    const { name, data } = sseEventFields(block);
    if (data === null) return block;
    if (data.trim() === "[DONE]") {
      this.terminal = true;
      return block;
    }
    // Only a terminal or error payload can hold one of these as raw JSON (a
    // quote inside a string value is escaped), so the text deltas that make
    // up most of a stream are never parsed.
    if (name !== "error" && !TERMINAL_OR_ERROR_MARKER.test(data)) return block;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return block;
    }
    if (!isRecord(payload)) return block;
    const type = payload.type;
    if (typeof type === "string" && TERMINAL_RESPONSE_EVENTS.has(type)) {
      this.terminal = true;
      return block;
    }
    if (type === "error" || (type === undefined && (name === "error" || isRecord(payload.error)))) {
      this.terminal = true;
      return errorEvent(block, payload);
    }
    return block;
  }

  private scanUnframed(chunk: Uint8Array): void {
    if (this.terminal) return;
    // Test the join of the previous tail and the whole new chunk BEFORE
    // trimming, so a marker split across chunks is still seen.
    const window = this.tail + this.decoder.decode(chunk, { stream: true });
    if (TERMINAL_EVENT_PATTERN.test(window)) this.terminal = true;
    this.tail = window.slice(-4096);
  }
}

export function guardEventStream(
  body: ReadableStream<Uint8Array>,
  options: { idleMs?: number; onInterrupted?: (reason: StreamInterruption) => void } = {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const idleMs = options.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const events = new SseEventFramer();
  const interrupt = (controller: ReadableStreamDefaultController<Uint8Array>, reason: StreamInterruption) => {
    options.onInterrupted?.(reason);
    controller.enqueue(interruptedEvent(reason));
    controller.close();
  };
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<{ idle: true }>((resolve) => {
      timer = setTimeout(() => resolve({ idle: true }), idleMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Read until at least one whole event can be forwarded: a pull that
      // enqueues nothing would not be called again.
      for (;;) {
        let result: Awaited<ReturnType<typeof read>>;
        try {
          result = await read();
        } catch {
          // The upstream connection failed mid-stream (reset, network change):
          // end with the same readable, retryable error as an early close.
          await reader.cancel().catch(() => undefined);
          interrupt(controller, "truncated");
          return;
        }
        if ("idle" in result) {
          await reader.cancel().catch(() => undefined);
          interrupt(controller, "idle");
          return;
        }
        if (result.done) {
          const rest = events.finish();
          if (!events.terminal) {
            interrupt(controller, "truncated");
            return;
          }
          if (rest) controller.enqueue(rest);
          controller.close();
          return;
        }
        const ready = events.push(result.value);
        for (const event of ready) controller.enqueue(event);
        if (ready.length > 0) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * A gateway error body with readable copy for the codes the gateway and the
 * relay use (`{"detail":"<code>"}` from the gateway itself, or an
 * OpenAI-shaped `{"error":{code,message}}`), in the OpenAI shape the engine
 * reads its message from. Null leaves the body as it came. `grant` is a
 * spent grant's copy (grantExhaustedCopy), used for `daily_grant_exhausted`.
 */
function readableErrorBody(text: string, grant: string | null): { body: string; code: string } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.error) ? payload.error : null;
  const bareCode = stringField(payload.detail) ?? stringField(payload.error);
  const code = bareCode ?? stringField(nested?.code);
  if (!code) return null;
  const message = (grant && code === "daily_grant_exhausted" ? `omnirush.ai: ${grant.charAt(0).toLowerCase()}${grant.slice(1)}` : null)
    // The server names the version to install; keep its words.
    ?? (code === UPDATE_REQUIRED_CODE ? stringField(nested?.message) ?? stringField(payload.message) : null)
    ?? gatewayErrorMessage(code, stringField(nested?.message))
    ?? (bareCode ? `omnirush.ai could not complete the model request (${code}).` : null);
  if (!message) return null;
  const param = stringField(nested?.param);
  return {
    body: JSON.stringify({
      error: { message, type: stringField(nested?.type) ?? "omnirush_error", code, ...(param ? { param } : {}) },
    }),
    code,
  };
}

async function readableErrorResponse(response: Response, consoleUrl: string | null): Promise<Response> {
  const text = await response.text().catch(() => "");
  const readable = readableErrorBody(text, grantExhaustedCopy(response.headers, consoleUrl));
  const headers = responseHeaders(response.headers);
  // A spent grant stays spent until its reset: the engine would otherwise
  // resend the request ten times, each after the 429's Retry-After (60 s).
  // An outdated app stays refused until it is updated.
  if (readable?.code === "daily_grant_exhausted" || readable?.code === UPDATE_REQUIRED_CODE || response.status === 426) {
    headers.set("x-should-retry", "false");
  }
  return new Response(readable?.body ?? text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A streamed refusal is one small error frame; anything longer is a real stream. */
const MAX_STREAMED_REFUSAL_BYTES = 64 * 1024;

/**
 * A streamed refusal as a 403 the engine shows once: the gateway refuses a
 * capped session or a Windows cut-off with HTTP 200, one `event: error`
 * frame naming its `detail`, and `x-should-retry: false`. The engine
 * retries any stream error it does not recognise (and never sees that
 * header), so the same refusal would be sent again and again. The message
 * is kept word for word: one ending on the console link keeps the app's
 * "Open console" button. Null for anything but exactly one such frame.
 */
function streamedRefusalResponse(text: string, headers: Headers): Response | null {
  const events = text.split(/\r\n\r\n|\n\n|\r\r/).filter((block) => block.trim());
  if (events.length !== 1) return null;
  const { name, data } = sseEventFields(new TextEncoder().encode(events[0]));
  if (data === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(payload) || (name !== "error" && payload.type !== "error")) return null;
  const detail = stringField(payload.detail);
  if (!detail) return null;
  const nested = isRecord(payload.error) ? payload.error : null;
  const message = stringField(nested?.message) ?? stringField(payload.message)
    ?? gatewayErrorMessage(detail) ?? `omnirush.ai could not complete the model request (${detail}).`;
  const result = responseHeaders(headers);
  result.set("content-type", "application/json");
  result.set("x-should-retry", "false");
  return new Response(JSON.stringify({ error: { message, type: stringField(nested?.type) ?? "invalid_request_error", code: detail } }), {
    status: 403,
    headers: result,
  });
}

/**
 * A stream marked `x-should-retry: false`: the refusal as a 403
 * (streamedRefusalResponse), or the stream's bytes unchanged.
 */
async function streamedRefusalOrBody(response: Response, body: ReadableStream<Uint8Array>): Promise<Response | ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total <= MAX_STREAMED_REFUSAL_BYTES) {
    const result = await reader.read();
    if (result.done) {
      done = true;
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  if (done) {
    const decoder = new TextDecoder();
    const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
    const refusal = streamedRefusalResponse(text, response.headers);
    if (refusal) return refusal;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large").catch(() => undefined);
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

type CredentialState = {
  gatewayUrl: string;
  accessToken: string;
  /** Spent only without a refresh owner (see OmniRushGatewayCredentials.refresh). */
  refreshToken: string;
};

/** What the refresh endpoint said about the token that was spent. */
type RefreshOutcome =
  | { kind: "rotated" }
  /** 401/403: the server retired or revoked the token. */
  | { kind: "retired" }
  /** 409 refresh_token_already_used: this very token is being rotated right now. */
  | { kind: "contended" }
  /** Anything else (5xx, malformed payload): nothing is known about the session. */
  | { kind: "unavailable" };

function normalizedGatewayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The feature flags of a /collect/capabilities answer, each true only when the backend says so. */
function uploadFeatureFlags(payload: Record<string, unknown>): Pick<TraceCapabilities, "idempotency_key" | "body_sha256" | "integrity" | "integrity_summary" | "recovered_segments"> {
  return {
    idempotency_key: payload.idempotency_key === true,
    body_sha256: payload.body_sha256 === true,
    integrity: payload.integrity === true,
    integrity_summary: payload.integrity_summary === true,
    recovered_segments: payload.recovered_segments === true,
  };
}

/** Integrity reads per minute this device makes, under the route's 30 per account. */
const INTEGRITY_CALLS_PER_MINUTE = 24;

export type SessionIntegrityOptions = { summary?: boolean; turns?: number };

function refreshUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/device/refresh";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function upstreamUrl(gatewayUrl: string, path: string): string {
  const url = new URL(gatewayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** `<gateway root>/<path>`: the gateway URL with its trailing `/` and `/v1` stripped, as for every omnirush.ai API route. */
function apiUrl(gatewayUrl: string, path: string): string {
  const url = new URL(gatewayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function untilAborted(response: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    response.then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) void value.body?.cancel().catch(() => undefined);
      resolvePromise(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function fileReadableBody(path: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const source = createReadStream(path, { highWaterMark: 64 * 1024 });
  const abort = () => source.destroy(signal.reason instanceof Error ? signal.reason : undefined);
  const cleanup = () => signal.removeEventListener("abort", abort);
  return new globalThis.ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      source.on("data", (chunk: string | Buffer) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      source.on("end", () => {
        cleanup();
        controller.close();
      });
      source.on("error", (error: Error) => {
        cleanup();
        controller.error(error);
      });
    },
    cancel(reason) {
      cleanup();
      source.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}

/** The backend's voice route, relative to the gateway URL (…/omnirush/v1/audio/transcriptions). */
export const VOICE_TRANSCRIPTIONS_PATH = "audio/transcriptions";
/** The backend allows 20 s for its primary provider and 30 s for the fallback. */
const VOICE_TRANSCRIBE_TIMEOUT_MS = 35_000;

/** The project archive routes the session archiver calls (archives, archives/key, archives/<id>/parts|complete|abort). */
const ARCHIVE_API_PATH = /^archives(?:\/key|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:parts|complete|abort))?$/;

/**
 * Set by the omnirush-reasoning-effort engine plugin; keep the two
 * definitions identical. The header is consumed here and never forwarded.
 */
const REASONING_EFFORT_HEADER = "x-omnirush-reasoning-effort";
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestedReasoningEffort(request: Request): string | null {
  const effort = request.headers.get(REASONING_EFFORT_HEADER)?.trim().toLowerCase() ?? "";
  return REASONING_EFFORTS.has(effort) ? effort : null;
}

/**
 * Guarantee the selected effort reaches omnirush.ai as Responses-API
 * `reasoning.effort`. The engine's OpenAI adapter only emits it for model ids
 * it recognises as reasoning models; an effort it already emitted (or a legacy
 * top-level `reasoning_effort`) is left untouched.
 */
function withReasoningEffort(body: ArrayBuffer, effort: string): ArrayBuffer | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return body;
  }
  if (!isRecord(parsed) || typeof parsed.reasoning_effort === "string") return body;
  const reasoning = isRecord(parsed.reasoning) ? parsed.reasoning : {};
  if (typeof reasoning.effort === "string") return body;
  return JSON.stringify({ ...parsed, reasoning: { ...reasoning, effort } });
}

/**
 * OpenCode currently opts into OpenAI summaries only for GPT-5 model IDs.
 * Ask for the summaries the transcript displays for every catalog model that
 * wants them (`wantsSummary`: the account's catalog decides, see
 * omnirushModelWantsReasoningSummary), preserving any explicit summary
 * option. Apply this at the final forwarding boundary so sub-agent fallbacks
 * use the destination model's options.
 */
async function withReasoningSummary(
  body: ArrayBuffer | string,
  wantsSummary: (model: string) => boolean | Promise<boolean>,
): Promise<ArrayBuffer | string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    return body;
  }
  if (!isRecord(parsed) || typeof parsed.model !== "string") return body;
  let wanted = false;
  try {
    wanted = await wantsSummary(parsed.model);
  } catch {
    wanted = false;
  }
  if (!wanted) return body;
  if (parsed.reasoning != null && !isRecord(parsed.reasoning)) return body;
  const reasoning = isRecord(parsed.reasoning) ? parsed.reasoning : {};
  if ("summary" in reasoning) return body;
  return JSON.stringify({ ...parsed, reasoning: { ...reasoning, summary: "auto" } });
}

/**
 * Gateway refusals of a sub-agent's picked model that move the request to
 * the main model at once: the model is not served to this account (or at
 * all), cannot take this request, or its route is not set up.
 */
const SUBAGENT_MODEL_REFUSED = new Set([
  "model_unavailable",
  "model_not_allowed",
  "model_not_found",
  "model_input_not_supported",
  "reasoning_effort_not_allowed",
  "unsupported_model_endpoint",
  "muse_relay_not_configured",
  "model_upstream_auth_failed",
  "model_upstream_misconfigured",
]);
/** Busy or down: the picked model is tried once more, then the request moves to the main model. */
const SUBAGENT_MODEL_BUSY = new Set([
  "model_concurrency_limited",
  "model_upstream_unavailable",
  "internal_proxy_unavailable",
  "provider_unavailable",
  "provider_rate_limited",
  "capacity_unavailable",
  "circuit_open",
  "maintenance",
  "draining",
  "auth_unavailable",
  "token_capacity",
  "gateway_overload",
  "queue_timeout",
]);
/** Account-wide refusals: another model would be refused the same way, so nothing moves. */
const ACCOUNT_REFUSED = new Set([
  "daily_grant_exhausted",
  "grant_check_unavailable",
  "account_inactive",
  "consent_required",
  "consent_version_outdated",
  "omnirush_account_required",
  "model_request_too_large",
  "update_required",
]);
const SUBAGENT_BUSY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Pauses before a model request whose connection to omnirush.ai failed
 * (no response at all: reset, refused, network change, TLS or HTTP/2 session
 * failure) is sent again. Once they are spent the engine gets a retryable
 * 503 with readable copy instead of a bare 500.
 */
const UNREACHABLE_RETRY_DELAYS_MS = [500, 2_000];

/** The failure's name, code and cause code, for the log: never a URL, header or body. */
function fetchFailure(error: unknown): { name: string; message: string; code: string | null } {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = (value as { code?: unknown }).code;
  const cause = (value as { cause?: { code?: unknown; message?: unknown } }).cause;
  const causeCode = cause && typeof cause.code === "string" ? cause.code : null;
  const causeMessage = cause && typeof cause.message === "string" ? cause.message : "";
  return {
    name: value.name,
    message: `${value.message}${causeMessage && !value.message.includes(causeMessage) ? ` (${causeMessage})` : ""}`.slice(0, 300),
    code: typeof code === "string" ? code : causeCode,
  };
}

function unreachableResponse(code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "omnirush_error", code } }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "2" },
  });
}
const SUBAGENT_RETRY_DELAY_MS = 1_500;
const FALLBACK_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type SubagentRefusal = { move: "now" | "after_retry" | "never"; reason: string };

/** The gateway error code of a refused response, read from a clone so the body stays readable. */
async function refusalCode(response: Response): Promise<string | null> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return null;
  const text = await response.clone().text().catch(() => "");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.error) ? payload.error : null;
  const code = stringField(payload.detail) ?? stringField(payload.error) ?? stringField(nested?.code) ?? stringField(payload.code);
  return code ? code.replace(/^upstream_/, "") : null;
}

async function subagentRefusal(response: Response): Promise<SubagentRefusal> {
  const code = await refusalCode(response);
  const reason = code ?? `http_${response.status}`;
  if (code && ACCOUNT_REFUSED.has(code)) return { move: "never", reason };
  if (code && SUBAGENT_MODEL_REFUSED.has(code)) return { move: "now", reason };
  if ((code && SUBAGENT_MODEL_BUSY.has(code)) || SUBAGENT_BUSY_STATUSES.has(response.status)) return { move: "after_retry", reason };
  return { move: "never", reason };
}

function requestedModel(body: ArrayBuffer | string): string | null {
  try {
    const parsed: unknown = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    return isRecord(parsed) ? stringField(parsed.model) : null;
  } catch {
    return null;
  }
}

/** The same request on another model: its effort replaced (or dropped for the model's default). */
function withModel(body: ArrayBuffer | string, model: string, effort: string | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { reasoning_effort: _legacy, ...rest } = parsed;
  const reasoning = isRecord(rest.reasoning) ? { ...rest.reasoning } : null;
  if (reasoning) delete reasoning.effort;
  const nextReasoning = effort ? { ...(reasoning ?? {}), effort } : reasoning;
  return JSON.stringify({ ...rest, model, ...(nextReasoning ? { reasoning: nextReasoning } : {}) });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function responseHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) {
    if (["content-type", "cache-control", "x-request-id", "openai-processing-ms", "retry-after"].includes(name)
      || name.startsWith("x-ratelimit-")
      || name.startsWith("x-omnirush-")) {
      result.set(name, value);
    }
  }
  return result;
}

export class OmniRushGatewayBroker {
  private state: CredentialState | null;
  private knownAccountId: string | null = null;
  /** When the last integrity reads went out (one minute's worth), and a Retry-After the route gave. */
  private integrityCalls: number[] = [];
  private integrityBlockedUntil = 0;
  private accountIdLookup: Promise<string | null> | null = null;
  private readonly engineToken: string;
  private readonly invalidate?: OmniRushGatewayCredentials["invalidate"];
  private readonly refreshOwner?: OmniRushGatewayCredentials["refresh"];
  private readonly fetcher: typeof externalFetch;
  private readonly fileUploader?: BrokerOptions["uploadFile"];
  private readonly log?: BrokerOptions["log"];
  private readonly sessionUploadBudget: SessionUploadBudget;
  private readonly onSubagentFallback?: BrokerOptions["onSubagentFallback"];
  private readonly subagentRetryDelayMs: number;
  private readonly subagentModelRefused?: (model: string) => boolean;
  private readonly onUpdateSignal?: (signal: GatewayUpdateSignal) => void;
  private readonly reasoningSummaryFor: (model: string) => boolean | Promise<boolean>;
  private readonly clientHeader: string | null;
  private refreshInFlight: Promise<boolean> | null = null;
  /** Whether the last failed refresh left the session as it was (unreachable, 5xx, contended). */
  private lastRefreshTransient = false;
  /**
   * Attachments the model refused (a corrupt PDF the read tool returned, an
   * image that is not one): replaced by "[file could not be read: <name>]" in
   * every later request, so one bad file cannot fail the rest of a session.
   */
  private readonly rejectedAttachments = new RejectedAttachments();
  private capabilityCache: { gatewayUrl: string; accountKey: string; capabilities: TraceCapabilities; expiresAt: number } | null = null;
  private capabilityProbe: { key: string; promise: Promise<TraceCapabilities> } | null = null;

  constructor(options: BrokerOptions) {
    const gatewayUrl = options.credentials ? normalizedGatewayUrl(options.credentials.gatewayUrl) : null;
    this.state = gatewayUrl && options.credentials?.accessToken && options.credentials.refreshToken
      ? {
          gatewayUrl,
          accessToken: options.credentials.accessToken,
          refreshToken: options.credentials.refreshToken,
        }
      : null;
    this.engineToken = options.engineToken?.trim() ?? "";
    this.invalidate = options.credentials?.invalidate;
    this.refreshOwner = options.credentials?.refresh;
    const fetcher = options.fetch ?? externalFetch;
    this.clientHeader = guiClientHeaderValue(options.clientVersion);
    const clientHeader = this.clientHeader;
    // Every call the broker makes goes to omnirush.ai (model, upload, archive
    // API, catalog, voice, refresh); presigned S3 part uploads never pass here.
    this.fetcher = clientHeader ? (input, init) => fetcher(input, withClientHeader(init, clientHeader)) : fetcher;
    this.fileUploader = options.uploadFile;
    this.log = options.log;
    this.sessionUploadBudget = options.sessionUploadBudget ?? SESSION_UPLOAD_BUDGET;
    this.onSubagentFallback = options.onSubagentFallback;
    this.subagentRetryDelayMs = options.subagentRetryDelayMs ?? SUBAGENT_RETRY_DELAY_MS;
    this.subagentModelRefused = options.subagentModelRefused;
    this.onUpdateSignal = options.onUpdateSignal;
    this.reasoningSummaryFor = options.reasoningSummaryFor ?? defaultReasoningSummaryFor;
  }

  /**
   * Passes the gateway's update signals on: the header from any answer, and
   * a 426 / `update_required` refusal of a model request. Read from a clone,
   * so the response itself is untouched; a listener that throws is ignored.
   */
  private async noteUpdateSignals(response: Response, modelRequest: boolean): Promise<void> {
    if (!this.onUpdateSignal) return;
    try {
      const header = response.headers.get(UPDATE_REQUIRED_HEADER)?.trim();
      if (header) this.onUpdateSignal({ kind: "header", value: header });
      if (!modelRequest || response.ok) return;
      let code = response.status === 426 ? UPDATE_REQUIRED_CODE : null;
      let message: string | null = null;
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        const text = await response.clone().text().catch(() => "");
        try {
          const payload: unknown = JSON.parse(text);
          if (isRecord(payload)) {
            const nested = isRecord(payload.error) ? payload.error : null;
            const bodyCode = stringField(nested?.code) ?? stringField(payload.detail) ?? stringField(payload.error);
            if (bodyCode === UPDATE_REQUIRED_CODE) code = bodyCode;
            message = stringField(nested?.message) ?? stringField(payload.message);
          }
        } catch {
          // Not JSON: the status alone decides.
        }
      }
      if (code === UPDATE_REQUIRED_CODE) {
        this.log?.("warn", "omnirush.ai refused a model request: this app version must be updated", { status: response.status });
        this.onUpdateSignal({ kind: "rejection", message });
      }
    } catch {
      // The update gate is advisory; the response goes on as it came.
    }
  }

  get enabled(): boolean {
    return Boolean(this.state && this.engineToken);
  }

  /** The console's Account page on the account's server (where Discord and GitHub are linked). */
  get consoleUrl(): string | null {
    return this.state ? new URL("/console/account", this.state.gatewayUrl).toString() : null;
  }

  async handle(request: Request, path: string): Promise<Response> {
    if (!this.enabled || !this.state) return Response.json({ error: "omnirush_account_required" }, { status: 401 });
    if (!secureEqual(bearerToken(request), this.engineToken)) {
      return Response.json({ error: "invalid_local_gateway_credential" }, { status: 401 });
    }
    const normalizedPath = path.replace(/^\/+/, "");
    const allowed = (request.method === "GET" && (normalizedPath === "models" || normalizedPath === VOICE_TRANSCRIPTIONS_PATH))
      || (request.method === "POST" && (normalizedPath === "responses" || normalizedPath === "responses/compact" || normalizedPath === VOICE_TRANSCRIPTIONS_PATH));
    if (!allowed) return Response.json({ error: "unsupported_gateway_path" }, { status: 404 });

    const requestBody = request.method === "GET"
      ? undefined
      : await this.requestBody(request, normalizedPath);
    // A picked sub-agent model the gateway refused moments ago is not tried
    // again for every step of a running sub-agent: it goes to the main model.
    const skipped = requestBody === undefined ? null : this.skipRefusedSubagentModel(request, normalizedPath, requestBody);
    let body = skipped?.body ?? requestBody;
    const attachments = this.leaveOutRefusedAttachments(normalizedPath, body);
    if (attachments) body = attachments.body;
    let spent = this.state.accessToken;
    let response = await this.forwardModelRequest(request, normalizedPath, body, spent);
    // Two rounds at most: the first may only adopt a pair the desktop rotated,
    // whose own access token can have expired while the app was idle.
    let refreshUnavailable = false;
    for (let round = 0; round < 2 && response.status === 401 && this.state; round += 1) {
      const credentialAlreadyRotated = this.state.accessToken !== spent;
      if (!credentialAlreadyRotated && !(await this.refresh(spent))) {
        refreshUnavailable = this.state !== null && this.lastRefreshTransient;
        break;
      }
      if (!this.state) break;
      await response.body?.cancel().catch(() => undefined);
      spent = this.state.accessToken;
      response = await this.forwardModelRequest(request, normalizedPath, body, spent);
    }
    if (response.status === 401 && refreshUnavailable) {
      // The session is intact but the refresh could not reach omnirush.ai:
      // a retryable answer, not a sign-in error that ends the turn.
      await response.body?.cancel().catch(() => undefined);
      return unreachableResponse(
        "device_refresh_unavailable",
        "omnirush.ai: the session could not be renewed right now (the service did not answer). Retrying shortly.",
      );
    }
    if (response.status === 401 && !this.state) {
      await response.body?.cancel().catch(() => undefined);
      return Response.json({
        error: {
          message: "Your omnirush.ai session has expired. Sign in again from Settings.",
          type: "authentication_error",
          code: "omnirush_account_required",
        },
      }, { status: 401 });
    }
    if (attachments) {
      const retried = await this.retryWithoutRefusedAttachments(request, normalizedPath, attachments, response);
      response = retried.response;
      body = retried.body;
    }
    if (skipped) {
      this.reportSubagentFallback(request, { ...skipped.event, status: response.status, ok: response.ok });
    } else if (!response.ok && response.status !== 401 && body !== undefined) {
      response = await this.subagentFallback(request, normalizedPath, body, response);
    }
    await this.noteUpdateSignals(response, true);
    const contentType = response.headers.get("content-type") ?? "";
    // Sign-in failures keep their own answer above; every other gateway
    // refusal reaches the user as readable copy instead of a bare code.
    if (!response.ok && response.status !== 401 && contentType.includes("application/json")) {
      return await readableErrorResponse(response, this.consoleUrl);
    }
    const streamed = response.ok && response.body && contentType.includes("text/event-stream");
    let upstreamBody: ReadableStream<Uint8Array> | null = response.body;
    if (streamed && upstreamBody && response.headers.get("x-should-retry") === "false") {
      const refusal = await streamedRefusalOrBody(response, upstreamBody);
      if (refusal instanceof Response) return refusal;
      upstreamBody = refusal;
    }
    const responseBody = streamed && upstreamBody
      ? guardEventStream(upstreamBody, {
          onInterrupted: (reason) => this.log?.("warn", "omnirush.ai model stream interrupted", { reason, path: normalizedPath }),
        })
      : upstreamBody;
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
    });
  }

  /**
   * A model request's attachments, with the ones the model refused earlier
   * replaced; null for a request that is not JSON or carries none.
   */
  private leaveOutRefusedAttachments(path: string, body: ArrayBuffer | string | undefined): { parsed: unknown; attachments: Attachment[]; body: ArrayBuffer | string } | null {
    if (body === undefined || (path !== "responses" && path !== "responses/compact")) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const prepared = this.rejectedAttachments.prepare(parsed);
    if (prepared.attachments.length === 0) return null;
    if (prepared.replaced.length > 0) {
      this.log?.("info", "omnirush.ai: left out attachments the model refused earlier", { count: prepared.replaced.length });
      return { parsed, attachments: prepared.attachments, body: JSON.stringify(prepared.body) };
    }
    return { parsed, attachments: prepared.attachments, body };
  }

  /**
   * The model refused an attachment (400 "The file you uploaded is badly
   * formatted or corrupted"): the suspects are left out and the request sent
   * again, so the turn goes on with a "[file could not be read: x]" note. An
   * answer the model accepted marks its attachments as good.
   */
  private async retryWithoutRefusedAttachments(
    request: Request,
    path: string,
    state: { parsed: unknown; attachments: Attachment[]; body: ArrayBuffer | string },
    first: Response,
  ): Promise<{ response: Response; body: ArrayBuffer | string }> {
    let response = first;
    let { attachments, body } = state;
    for (let round = 0; response.status === 400 && round < MAX_ATTACHMENT_RETRIES && this.state; round += 1) {
      const raw = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const kept = new Response(raw.byteLength ? raw : null, { status: response.status, statusText: response.statusText, headers: response.headers });
      const message = new TextDecoder().decode(raw.subarray(0, MAX_ATTACHMENT_ERROR_BYTES));
      const suspects = isRejectedAttachmentError(response.status, message) ? this.rejectedAttachments.reject(attachments, message) : [];
      if (suspects.length === 0) return { response: kept, body };
      const prepared = this.rejectedAttachments.prepare(state.parsed);
      attachments = prepared.attachments;
      body = JSON.stringify(prepared.body);
      this.log?.("warn", "omnirush.ai: the model refused an attachment; sending the request again without it", { path, left_out: suspects.length });
      response = await this.forwardModelRequest(request, path, body, this.state.accessToken);
    }
    if (response.ok) this.rejectedAttachments.accept(attachments.filter((item) => !this.rejectedAttachments.isBad(item.fingerprint)));
    return { response, body };
  }

  /**
   * One session uploader envelope. The deadline grows with the envelope's size
   * (session-upload-budget.ts), and the retry with a refreshed bearer gets a
   * deadline of its own; `signal`, the session uploader's own deadline or cancel,
   * ends either sooner.
   */
  uploadSession(sessionId: string, body: Uint8Array, signal?: AbortSignal, options: UploadRequestOptions = {}): Promise<Response> {
    const timeoutMs = sessionUploadTimeoutMs(body.byteLength, this.sessionUploadBudget);
    return this.withDeviceBearer((state) => this.fetcher(apiUrl(state.gatewayUrl, SESSION_UPLOAD_ENDPOINT_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        "Content-Type": "application/zstd",
        "X-OmniRush-Session-ID": sessionId,
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    }));
  }

  uploadSessionFile(sessionId: string, path: string, size: number, signal?: AbortSignal, options: UploadRequestOptions = {}): Promise<Response> {
    const timeoutMs = sessionUploadTimeoutMs(size, this.sessionUploadBudget);
    return this.withDeviceBearer(async (state) => {
      const requestSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
      const url = apiUrl(state.gatewayUrl, SESSION_UPLOAD_ENDPOINT_PATH);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${state.accessToken}`,
        "Content-Type": "application/zstd",
        "X-OmniRush-Session-ID": sessionId,
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      };
      // The Electron file transport bypasses this.fetcher.
      if (this.clientHeader) headers[CLIENT_HEADER] = this.clientHeader;
      if (this.fileUploader) {
        return untilAborted(this.fileUploader(url, { method: "POST", headers, path, size, signal: requestSignal }), requestSignal);
      }
      const bodyAbort = new AbortController();
      const bodySignal = AbortSignal.any([requestSignal, bodyAbort.signal]);
      const body = fileReadableBody(path, bodySignal);
      try {
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          headers,
          body,
          duplex: "half",
          signal: requestSignal,
        };
        return await this.fetcher(url, init);
      } finally {
        bodyAbort.abort(new DOMException("The upload response arrived", "AbortError"));
      }
    });
  }

  async sessionUploadCapabilities(): Promise<TraceCapabilities> {
    if (!this.state) return { schema_versions: [1, 2, 3], canonical_trace: false };
    const state = this.state;
    const gatewayUrl = state.gatewayUrl;
    const key = this.capabilityKey(state);
    if (this.capabilityCache?.gatewayUrl === gatewayUrl
      && this.capabilityCache.accountKey === key
      && this.capabilityCache.expiresAt > Date.now()) {
      return this.capabilityCache.capabilities;
    }
    const pending = this.capabilityProbe?.key === key
      ? this.capabilityProbe.promise
      : this.probeSessionUploadCapabilities(gatewayUrl);
    if (!this.capabilityProbe || this.capabilityProbe.key !== key) {
      this.capabilityProbe = { key, promise: pending };
      void pending.finally(() => {
        if (this.capabilityProbe?.promise === pending) this.capabilityProbe = null;
      }).catch(() => undefined);
    }
    const capabilities = await pending;
    if (this.state && this.capabilityKey(this.state) === key) {
      this.capabilityCache = { gatewayUrl, accountKey: key, capabilities, expiresAt: Date.now() + TRACE_CAPABILITY_TTL_MS };
    }
    return capabilities;
  }

  resetCapabilities(): void {
    this.capabilityCache = null;
    this.capabilityProbe = null;
  }

  /**
   * The server's integrity record of one chat (GET
   * `<gateway root>/me/sessions/{id}/integrity`), with the device bearer and
   * the same bounded 401 refresh as uploadSession(). `turns` is the client's
   * count of completed turns; `summary` leaves out the per-upload rows. The
   * route allows 30 calls a minute per account: past INTEGRITY_CALLS_PER_MINUTE
   * here, or before a Retry-After it gave, the answer is a local 429.
   */
  async sessionIntegrity(sessionId: string, options: SessionIntegrityOptions = {}): Promise<Response> {
    // A backend without the route answers like one that holds nothing (the callers' "pending").
    const features = await this.sessionUploadCapabilities();
    if (features.integrity !== true) return Response.json({ detail: "integrity_unavailable" }, { status: 404 });
    const summary = options.summary === true && features.integrity_summary === true;
    const now = Date.now();
    this.integrityCalls = this.integrityCalls.filter((at) => now - at < 60_000);
    const waitMs = Math.max(this.integrityBlockedUntil - now, this.integrityCalls.length >= INTEGRITY_CALLS_PER_MINUTE ? this.integrityCalls[0]! + 60_000 - now : 0);
    if (waitMs > 0) {
      return Response.json({ detail: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(waitMs / 1_000)) } });
    }
    this.integrityCalls.push(now);
    const response = await this.withDeviceBearer((state) => {
      const url = new URL(apiUrl(state.gatewayUrl, `me/sessions/${encodeURIComponent(sessionId)}/integrity`));
      if (summary) url.searchParams.set("summary", "1");
      if (options.turns !== undefined && Number.isSafeInteger(options.turns) && options.turns >= 0) url.searchParams.set("turns", String(options.turns));
      return this.fetcher(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${state.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      this.integrityBlockedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3_600) * 1_000 : 60_000);
    }
    return response;
  }

  /**
   * The id of the account behind the device bearer (`<gateway root>/device/me`),
   * learned once: an account change restarts the server. Null while it
   * cannot be learned (signed out, offline, an unexpected answer).
   */
  accountId(): Promise<string | null> {
    if (this.knownAccountId) return Promise.resolve(this.knownAccountId);
    this.accountIdLookup ??= (async () => {
      try {
        const response = await this.withDeviceBearer((state) => this.fetcher(apiUrl(state.gatewayUrl, "device/me"), {
          method: "GET",
          headers: { Authorization: `Bearer ${state.accessToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        }));
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        const text = await boundedText(response, 256 * 1024);
        const payload: unknown = text === null ? null : JSON.parse(text);
        const id = isRecord(payload) && typeof payload.id === "string" ? payload.id.trim() : "";
        if (id) this.knownAccountId = id;
        return id || null;
      } catch {
        return null;
      } finally {
        this.accountIdLookup = null;
      }
    })();
    return this.accountIdLookup;
  }

  private capabilityKey(state: CredentialState): string {
    return `${state.gatewayUrl}\0${state.refreshToken}`;
  }

  /**
   * The backend's /collect/capabilities: the trace schema and the features
   * it has (a key it does not name is false). A failed read is the oldest
   * backend: schema 2 and no features, asked again once the cache expires.
   */
  private async probeSessionUploadCapabilities(gatewayUrl: string): Promise<TraceCapabilities> {
    const none: TraceCapabilities = { schema_versions: [1, 2], canonical_trace: false };
    try {
      if (this.state?.gatewayUrl !== gatewayUrl) return none;
      const response = await this.withDeviceBearer((state) => this.fetcher(apiUrl(state.gatewayUrl, "collect/capabilities"), {
        method: "GET",
        headers: { Authorization: `Bearer ${state.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      }));
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return none;
      }
      const text = await boundedText(response, 64 * 1024);
      if (text === null) return none;
      const payload: unknown = JSON.parse(text);
      if (!isRecord(payload)) return none;
      const v3 = payload.canonical_trace === true && Array.isArray(payload.schema_versions) && payload.schema_versions.some((version) => version === 3);
      const triggers = Array.isArray(payload.triggers) ? payload.triggers.filter((item): item is string => typeof item === "string") : null;
      return {
        schema_versions: v3 ? [1, 2, 3] : [1, 2],
        canonical_trace: v3,
        ...uploadFeatureFlags(payload),
        ...(triggers ? { triggers } : {}),
      };
    } catch {
      return none;
    }
  }

  /**
   * A project archive API call for the session archiver (`archives/key`,
   * `archives`, `archives/<id>/parts|complete|abort`), authenticated like
   * uploadSession(): the device bearer and the same bounded 401 refresh. S3 part
   * uploads never come through here; they go to their presigned URLs. With
   * `refresh: false` (the archiver's all-folders policy probe) it is one
   * request: a 401 is returned as it is, with no refresh and no second try.
   */
  archiveRequest(path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal; refresh?: false }): Promise<Response> {
    if (!ARCHIVE_API_PATH.test(path)) return Promise.resolve(Response.json({ error: "unsupported_archive_path" }, { status: 404 }));
    return this.withDeviceBearer((state) => this.fetcher(apiUrl(state.gatewayUrl, path), {
      method: init.method,
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal ? { signal: init.signal } : {}),
    }), { refresh: init.refresh !== false });
  }

  /**
   * The account's model catalog (`<gateway>/models`, the backend's
   * GET /omnirush/v1/models), authenticated like uploadSession(): the device bearer
   * and the same bounded 401 refresh. Read by the model catalog sync.
   */
  modelCatalog(): Promise<Response> {
    return this.withDeviceBearer((state) => this.fetcher(upstreamUrl(state.gatewayUrl, "models"), {
      method: "GET",
      headers: { Authorization: `Bearer ${state.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    }));
  }

  /**
   * One voice segment for the backend's POST /omnirush/v1/audio/transcriptions,
   * authenticated like uploadSession(): the device bearer and the same bounded 401
   * refresh. The multipart body goes through as it came and is held only
   * for this call.
   */
  /** GET /omnirush/v1/audio/transcriptions: whether this account may dictate, its limits and today's usage. */
  voiceStatus(): Promise<Response> {
    return this.withDeviceBearer((state) => this.fetcher(upstreamUrl(state.gatewayUrl, VOICE_TRANSCRIPTIONS_PATH), {
      method: "GET",
      headers: { Authorization: `Bearer ${state.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    }));
  }

  transcribe(body: ArrayBuffer, contentType: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(VOICE_TRANSCRIBE_TIMEOUT_MS);
    return this.withDeviceBearer((state) => this.fetcher(upstreamUrl(state.gatewayUrl, VOICE_TRANSCRIPTIONS_PATH), {
      method: "POST",
      headers: { Authorization: `Bearer ${state.accessToken}`, "Content-Type": contentType, Accept: "application/json" },
      body,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    }));
  }

  /**
   * Sends with the current device bearer; a 401 is retried bounded like
   * handle(): adopt, then spend the adopted refresh token. `refresh: false`
   * sends once and returns whatever came back.
   */
  private async withDeviceBearer(send: (state: CredentialState) => Promise<Response>, options: { refresh: boolean } = { refresh: true }): Promise<Response> {
    if (!this.state) return Response.json({ error: "omnirush_account_required" }, { status: 401 });
    let spent = this.state.accessToken;
    let response = await send(this.state);
    if (!options.refresh) return response;
    for (let round = 0; round < 2 && response.status === 401 && this.state; round += 1) {
      const credentialAlreadyRotated = this.state.accessToken !== spent;
      if (!credentialAlreadyRotated && !(await this.refresh(spent))) break;
      if (!this.state) break;
      await response.body?.cancel().catch(() => undefined);
      spent = this.state.accessToken;
      response = await send(this.state);
    }
    // Uploads and archives are never refused for the version; only the header counts here.
    await this.noteUpdateSignals(response, false);
    return response;
  }

  /**
   * Rotates the device access token through the refresh endpoint and returns
   * the bearer to use next, or null once the account is signed out. The
   * session uploader asks for this when an upload comes back unauthorized
   * after the retry inside uploadSession() has already failed to rotate it.
   */
  async refreshAccessToken(): Promise<string | null> {
    if (!this.state) return null;
    const refreshed = await this.refresh(this.state.accessToken);
    return refreshed ? this.state?.accessToken ?? null : null;
  }

  private async requestBody(request: Request, path: string): Promise<ArrayBuffer | string> {
    const body = await request.arrayBuffer();
    const effort = requestedReasoningEffort(request);
    if (!effort || (path !== "responses" && path !== "responses/compact")) return body;
    return withReasoningEffort(body, effort);
  }

  /**
   * A sub-agent runs on a model picked for sub-agents, and the swarm plugin
   * names the main model it falls back to (SUBAGENT_FALLBACK_MODEL_HEADER).
   * When the gateway refuses the picked model before answering (the model is
   * not served, or it stays busy or down on a second try), the same request
   * goes to the main model instead, so the sub-agent's task continues rather
   * than failing. Account-wide refusals and every other error pass through.
   */
  private async subagentFallback(request: Request, path: string, body: ArrayBuffer | string, response: Response): Promise<Response> {
    const fallback = request.headers.get(SUBAGENT_FALLBACK_MODEL_HEADER)?.trim() ?? "";
    if (!fallback || !FALLBACK_MODEL_ID.test(fallback) || (path !== "responses" && path !== "responses/compact")) return response;
    const requested = requestedModel(body);
    if (!requested || requested === fallback) return response;
    let refusal = await subagentRefusal(response);
    if (refusal.move === "never") return response;
    if (refusal.move === "after_retry") {
      await response.body?.cancel().catch(() => undefined);
      await pause(this.subagentRetryDelayMs, request.signal);
      if (request.signal.aborted || !this.state) return response;
      const again = await this.forwardModelRequest(request, path, body);
      if (again.ok || again.status === 401) return again;
      refusal = await subagentRefusal(again);
      if (refusal.move === "never") return again;
      response = again;
    }
    const effortHeader = request.headers.get(SUBAGENT_FALLBACK_EFFORT_HEADER)?.trim().toLowerCase() ?? "";
    const effort = REASONING_EFFORTS.has(effortHeader) ? effortHeader : null;
    const moved = withModel(body, fallback, effort);
    if (moved === null || !this.state) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = await this.forwardModelRequest(request, path, moved);
    this.log?.("warn", "omnirush.ai sub-agent model refused; sent on the main model", {
      requested,
      used: fallback,
      reason: refusal.reason,
      status: next.status,
    });
    this.reportSubagentFallback(request, { requested, used: fallback, effort, reason: refusal.reason, status: next.status, ok: next.ok });
    return next;
  }

  /** The request moved to the main model up front when its picked model is in its refusal cooldown. */
  private skipRefusedSubagentModel(
    request: Request,
    path: string,
    body: ArrayBuffer | string,
  ): { body: string; event: { requested: string; used: string; effort: string | null; reason: string } } | null {
    const fallback = request.headers.get(SUBAGENT_FALLBACK_MODEL_HEADER)?.trim() ?? "";
    if (!fallback || !FALLBACK_MODEL_ID.test(fallback) || !this.subagentModelRefused || (path !== "responses" && path !== "responses/compact")) return null;
    const requested = requestedModel(body);
    if (!requested || requested === fallback || !this.subagentModelRefused(requested)) return null;
    const effortHeader = request.headers.get(SUBAGENT_FALLBACK_EFFORT_HEADER)?.trim().toLowerCase() ?? "";
    const effort = REASONING_EFFORTS.has(effortHeader) ? effortHeader : null;
    const moved = withModel(body, fallback, effort);
    return moved === null ? null : { body: moved, event: { requested, used: fallback, effort, reason: "refused_recently" } };
  }

  private reportSubagentFallback(
    request: Request,
    event: { requested: string; used: string; effort: string | null; reason: string; status: number; ok: boolean },
  ): void {
    try {
      this.onSubagentFallback?.({
        sessionId: request.headers.get("x-omnirush-session-id"),
        rootSessionId: request.headers.get(SUBAGENT_ROOT_SESSION_HEADER),
        messageId: request.headers.get("x-omnirush-task-id"),
        ...event,
        at: Date.now(),
      });
    } catch {
      // A listener never breaks the request.
    }
  }

  /**
   * forward() for a model request, never throwing: a connection that fails
   * before any response is sent again after a short pause (the request never
   * reached, or never got an answer from, omnirush.ai), and once the retries
   * are spent the engine gets a retryable 503 with readable copy. Previously
   * the exception escaped the route and the engine saw a bare
   * `500 {"error":"internal_error"}` from the local server.
   */
  private async forwardModelRequest(
    request: Request,
    path: string,
    body: ArrayBuffer | string | undefined,
    accessToken?: string,
  ): Promise<Response> {
    const forwardedBody = path === "responses" && body !== undefined
      ? await withReasoningSummary(body, this.reasoningSummaryFor)
      : body;
    let failure: ReturnType<typeof fetchFailure> | null = null;
    for (let attempt = 0; attempt <= UNREACHABLE_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) {
        await pause(UNREACHABLE_RETRY_DELAYS_MS[attempt - 1]!, request.signal);
        if (request.signal.aborted) break;
      }
      if (!this.state) break;
      try {
        return await this.forward(request, path, forwardedBody, attempt === 0 ? accessToken : this.state.accessToken);
      } catch (error) {
        if (request.signal.aborted) throw error;
        failure = fetchFailure(error);
        this.log?.("warn", "omnirush.ai model request failed before an answer", {
          path,
          attempt: attempt + 1,
          error: failure.name,
          code: failure.code,
          message: failure.message,
        });
      }
    }
    if (request.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (!this.state) return Response.json({ error: "omnirush_account_required" }, { status: 401 });
    return unreachableResponse(
      "gateway_unreachable",
      `omnirush.ai: the model service could not be reached${failure?.code ? ` (${failure.code})` : ""}. Retrying shortly.`,
    );
  }

  private forward(request: Request, path: string, body: ArrayBuffer | string | undefined, accessToken?: string): Promise<Response> {
    if (!this.state) throw new Error("OmniRush gateway credentials are unavailable");
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${accessToken ?? this.state.accessToken}`);
    headers.set("Content-Type", request.headers.get("content-type") || "application/json");
    headers.set("Accept", request.headers.get("accept") || "application/json");
    for (const name of ["x-omnirush-session-id", "x-omnirush-task-id", PARENT_SESSION_HEADER]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return this.fetcher(upstreamUrl(this.state.gatewayUrl, path), {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      signal: request.signal,
    });
  }

  private refresh(expectedAccessToken: string): Promise<boolean> {
    if (this.state?.accessToken !== expectedAccessToken) return Promise.resolve(true);
    this.refreshInFlight ??= (this.refreshOwner
      ? this.refreshFromOwner(this.refreshOwner, expectedAccessToken)
      : this.performRefresh(expectedAccessToken))
      .then((rotated) => {
        if (rotated) this.lastRefreshTransient = false;
        return rotated;
      }, (error: unknown) => {
        // Never shared as a rejection: every request waiting on this refresh
        // would otherwise fail with an unhandled 500 at once.
        this.lastRefreshTransient = true;
        const failure = fetchFailure(error);
        this.log?.("warn", "omnirush.ai device refresh failed; keeping the session", { error: failure.name, code: failure.code, message: failure.message });
        return false;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  /**
   * The desktop account store owns the device session: it alone spends the
   * refresh token, one rotation at a time, and saves the result before it
   * answers. After a 401 the broker hands it the access token that was
   * refused and takes the pair it gets back (one it rotated earlier, or a new
   * rotation): the broker never sends a refresh token, and never acts on a
   * pair of its own that can go stale. A rejection leaves the session as it
   * is (the owner could not rotate right now); null means the session is gone.
   */
  private async refreshFromOwner(owner: NonNullable<OmniRushGatewayCredentials["refresh"]>, rejectedAccessToken: string): Promise<boolean> {
    const asked = this.state;
    if (!asked) return false;
    const current = await owner(rejectedAccessToken);
    if (this.state !== asked) return Boolean(this.state);
    if (!current) {
      this.state = null;
      void this.invalidate?.().catch(() => undefined);
      return false;
    }
    if (current.accessToken === rejectedAccessToken) {
      this.lastRefreshTransient = true;
      return false;
    }
    this.state = {
      gatewayUrl: normalizedGatewayUrl(current.gatewayUrl) ?? asked.gatewayUrl,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
    };
    if (this.state.gatewayUrl !== asked.gatewayUrl) this.resetCapabilities();
    return true;
  }

  /**
   * One refresh round trip of a broker that holds its credentials alone (the
   * standalone server with credentials from the environment): sign out only
   * when the server retired the token.
   */
  private async performRefresh(expectedAccessToken: string): Promise<boolean> {
    if (!this.state) return false;
    if (this.state.accessToken !== expectedAccessToken) return true;
    const spent = this.state;
    const outcome = await this.rotate(spent);
    if (outcome.kind === "rotated") return true;
    this.lastRefreshTransient = outcome.kind === "unavailable" || outcome.kind === "contended";
    if (outcome.kind !== "retired") return false;
    if (this.state !== spent) return Boolean(this.state);
    this.state = null;
    this.resetCapabilities();
    void this.invalidate?.().catch(() => undefined);
    return false;
  }

  /** Spends `from.refreshToken`; on success the state is the rotated pair. */
  private async rotate(from: CredentialState): Promise<RefreshOutcome> {
    const response = await this.fetcher(refreshUrl(from.gatewayUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: from.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return { kind: "retired" };
      if (response.status === 409) return { kind: "contended" };
      return { kind: "unavailable" };
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return { kind: "unavailable" };
    const accessToken = Reflect.get(payload, "access_token");
    const refreshToken = Reflect.get(payload, "refresh_token");
    const gatewayUrl = normalizedGatewayUrl(String(Reflect.get(payload, "gateway_url") ?? from.gatewayUrl));
    if (typeof accessToken !== "string" || typeof refreshToken !== "string" || !gatewayUrl) return { kind: "unavailable" };
    if (!this.state) return { kind: "unavailable" };
    this.state = { accessToken, refreshToken, gatewayUrl };
    if (gatewayUrl !== from.gatewayUrl) this.resetCapabilities();
    return { kind: "rotated" };
  }
}
