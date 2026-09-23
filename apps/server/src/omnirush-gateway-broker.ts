import { timingSafeEqual } from "node:crypto";

import { externalFetch } from "./server-fetch.js";
import type { OmniRushGatewayCredentialBundle, OmniRushGatewayCredentials } from "./types.js";

type BrokerOptions = {
  credentials?: OmniRushGatewayCredentials;
  engineToken?: string;
  fetch?: typeof externalFetch;
  log?: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

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
  provider_rate_limited: BUSY_COPY,
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
function errorEvent(block: Uint8Array, payload: Record<string, unknown>): Uint8Array {
  const nested = isRecord(payload.error) ? payload.error : null;
  const code = stringField(nested ? nested.code : payload.code);
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
        const result = await read();
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
 * reads its message from. Null leaves the body as it came.
 */
function readableErrorBody(text: string): string | null {
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
  const message = gatewayErrorMessage(code, stringField(nested?.message))
    ?? (bareCode ? `omnirush.ai could not complete the model request (${code}).` : null);
  if (!message) return null;
  const param = stringField(nested?.param);
  return JSON.stringify({
    error: { message, type: stringField(nested?.type) ?? "omnirush_error", code, ...(param ? { param } : {}) },
  });
}

async function readableErrorResponse(response: Response): Promise<Response> {
  const text = await response.text().catch(() => "");
  return new Response(readableErrorBody(text) ?? text, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  });
}

type CredentialState = {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string;
  /** See OmniRushGatewayCredentialBundle.rotation; always known in memory. */
  rotation: number;
};

function rotationOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** What the refresh endpoint said about the token that was spent. */
type RefreshOutcome =
  | { kind: "rotated" }
  /** 401/403: the server retired or revoked the token. */
  | { kind: "retired" }
  /** 409 refresh_token_already_used: another holder is rotating this very token right now. */
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
  private readonly engineToken: string;
  private readonly persist?: OmniRushGatewayCredentials["persist"];
  private readonly invalidate?: OmniRushGatewayCredentials["invalidate"];
  private readonly latest?: OmniRushGatewayCredentials["latest"];
  private readonly fetcher: typeof externalFetch;
  private readonly log?: BrokerOptions["log"];
  private refreshInFlight: Promise<boolean> | null = null;
  /**
   * The pair this broker held before it adopted one from the store. Spent as
   * a last resort when the adopted pair turns out to be dead too, so a stale
   * store entry cannot sign out a session this broker still holds.
   */
  private previous: CredentialState | null = null;

  constructor(options: BrokerOptions) {
    const gatewayUrl = options.credentials ? normalizedGatewayUrl(options.credentials.gatewayUrl) : null;
    this.state = gatewayUrl && options.credentials?.accessToken && options.credentials.refreshToken
      ? {
          gatewayUrl,
          accessToken: options.credentials.accessToken,
          refreshToken: options.credentials.refreshToken,
          rotation: rotationOf(options.credentials.rotation),
        }
      : null;
    this.engineToken = options.engineToken?.trim() ?? "";
    this.persist = options.credentials?.persist;
    this.invalidate = options.credentials?.invalidate;
    this.latest = options.credentials?.latest;
    this.fetcher = options.fetch ?? externalFetch;
    this.log = options.log;
  }

  get enabled(): boolean {
    return Boolean(this.state && this.engineToken);
  }

  async handle(request: Request, path: string): Promise<Response> {
    if (!this.enabled || !this.state) return Response.json({ error: "omnirush_account_required" }, { status: 401 });
    if (!secureEqual(bearerToken(request), this.engineToken)) {
      return Response.json({ error: "invalid_local_gateway_credential" }, { status: 401 });
    }
    const normalizedPath = path.replace(/^\/+/, "");
    const allowed = (request.method === "GET" && normalizedPath === "models")
      || (request.method === "POST" && (normalizedPath === "responses" || normalizedPath === "responses/compact"));
    if (!allowed) return Response.json({ error: "unsupported_gateway_path" }, { status: 404 });

    const body = request.method === "GET"
      ? undefined
      : await this.requestBody(request, normalizedPath);
    let spent = this.state.accessToken;
    let response = await this.forward(request, normalizedPath, body, spent);
    // Two rounds at most: the first may only adopt a pair the desktop rotated,
    // whose own access token can have expired while the app was idle.
    for (let round = 0; round < 2 && response.status === 401 && this.state; round += 1) {
      const credentialAlreadyRotated = this.state.accessToken !== spent;
      if (!credentialAlreadyRotated && !(await this.refresh(spent))) break;
      if (!this.state) break;
      await response.body?.cancel().catch(() => undefined);
      spent = this.state.accessToken;
      response = await this.forward(request, normalizedPath, body, spent);
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
    const contentType = response.headers.get("content-type") ?? "";
    // Sign-in failures keep their own answer above; every other gateway
    // refusal reaches the user as readable copy instead of a bare code.
    if (!response.ok && response.status !== 401 && contentType.includes("application/json")) {
      return await readableErrorResponse(response);
    }
    const streamed = response.ok && response.body && contentType.includes("text/event-stream");
    const responseBody = streamed && response.body
      ? guardEventStream(response.body, {
          onInterrupted: (reason) => this.log?.("warn", "omnirush.ai model stream interrupted", { reason, path: normalizedPath }),
        })
      : response.body;
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
    });
  }

  collect(sessionId: string, body: Uint8Array): Promise<Response> {
    return this.withDeviceBearer((state) => this.fetcher(apiUrl(state.gatewayUrl, "collect"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        "Content-Type": "application/zstd",
        "X-OmniRush-Session-ID": sessionId,
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: AbortSignal.timeout(30_000),
    }));
  }

  /**
   * A project archive API call for the session archiver (`archives/key`,
   * `archives`, `archives/<id>/parts|complete|abort`), authenticated like
   * collect(): the device bearer and the same bounded 401 refresh. S3 part
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
   * GET /omnirush/v1/models), authenticated like collect(): the device bearer
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
    return response;
  }

  /**
   * Rotates the device access token through the refresh endpoint and returns
   * the bearer to use next, or null once the account is signed out. The
   * workspace collector asks for this when an upload comes back unauthorized
   * after the retry inside collect() has already failed to rotate it.
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

  private forward(request: Request, path: string, body: ArrayBuffer | string | undefined, accessToken?: string): Promise<Response> {
    if (!this.state) throw new Error("OmniRush gateway credentials are unavailable");
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${accessToken ?? this.state.accessToken}`);
    headers.set("Content-Type", request.headers.get("content-type") || "application/json");
    headers.set("Accept", request.headers.get("accept") || "application/json");
    for (const name of ["x-omnirush-session-id", "x-omnirush-task-id"]) {
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
    this.refreshInFlight ??= this.performRefresh(expectedAccessToken).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /**
   * Adopts a rotation performed by another holder of the same device session
   * (the desktop account store refreshes on its own when it checks the
   * profile). The server retires the previous refresh token on rotation and
   * answers it with 401, which this broker would otherwise read as a revoked
   * device and sign the user out. Only a pair rotated more often than this
   * broker's own is newer: a store that still holds the pair this broker
   * already rotated away from (its persist failed) must not win, or the
   * broker would spend a retired token while its own live one goes unused.
   * True when the state changed.
   */
  private async adoptRotatedCredentials(): Promise<boolean> {
    const current = this.state;
    if (!this.latest || !current) return false;
    let stored: OmniRushGatewayCredentialBundle | null;
    try {
      stored = await this.latest();
    } catch {
      return false;
    }
    if (this.state !== current || !stored?.accessToken || !stored.refreshToken) return false;
    if (stored.refreshToken === current.refreshToken) return false;
    const rotation = rotationOf(stored.rotation);
    if (rotation <= current.rotation) return false;
    this.previous = current;
    this.state = {
      gatewayUrl: normalizedGatewayUrl(stored.gatewayUrl) ?? current.gatewayUrl,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      rotation,
    };
    this.log?.("info", "omnirush.ai device credentials adopted from the account store", { rotation });
    return true;
  }

  /**
   * One refresh round trip, bounded: adopt a newer stored pair, otherwise
   * spend our own; on rejection adopt again (the store may have settled in
   * the meantime), then fall back once to the pair held before an adoption,
   * and sign out only when every holder agrees the session is gone.
   */
  private async performRefresh(expectedAccessToken: string): Promise<boolean> {
    if (!this.state) return false;
    if (this.state.accessToken !== expectedAccessToken) return true;
    if (await this.adoptRotatedCredentials()) return true;
    const spent = this.state;
    const outcome = await this.rotate(spent);
    if (outcome.kind === "rotated") return true;
    if (outcome.kind === "unavailable") return false;
    if (this.state !== spent) return Boolean(this.state);
    // The token may have been spent elsewhere while this call was in flight;
    // a 409 means it is being spent right now. The store settles before it
    // answers, so a rotation that landed there is adopted instead.
    if (await this.adoptRotatedCredentials()) return true;
    if (outcome.kind === "contended") {
      this.log?.("warn", "omnirush.ai device refresh contended; keeping the session for the next attempt");
      return false;
    }
    const previous = this.previous;
    this.previous = null;
    if (previous && previous.refreshToken !== spent.refreshToken) {
      this.log?.("info", "omnirush.ai adopted device credentials rejected; trying the pair held before");
      const fallback = await this.rotate({ ...previous, rotation: Math.max(previous.rotation, spent.rotation) });
      if (fallback.kind === "rotated") return true;
      if (fallback.kind !== "retired") return false;
      if (this.state !== spent) return Boolean(this.state);
    }
    this.state = null;
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
    const rotated = { accessToken, refreshToken, gatewayUrl, rotation: from.rotation + 1 };
    this.state = rotated;
    this.previous = null;
    void this.persistLatest(rotated);
    return { kind: "rotated" };
  }

  private async persistLatest(credentials: OmniRushGatewayCredentialBundle, attempt = 0): Promise<void> {
    if (!this.persist) return;
    try {
      await this.persist(credentials);
    } catch {
      if (attempt >= 5 || this.state?.refreshToken !== credentials.refreshToken) return;
      const timer = setTimeout(() => {
        void this.persistLatest(credentials, attempt + 1);
      }, Math.min(30_000, 1_000 * 2 ** attempt));
      timer.unref?.();
    }
  }
}
