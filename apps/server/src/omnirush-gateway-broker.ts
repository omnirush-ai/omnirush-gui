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
 */
const TERMINAL_EVENT_PATTERN = /"type":"(?:response\.(?:completed|failed|incomplete)|error)"/;
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
export type StreamInterruption = "truncated" | "idle";

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

export function guardEventStream(
  body: ReadableStream<Uint8Array>,
  options: { idleMs?: number; onInterrupted?: (reason: StreamInterruption) => void } = {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleMs = options.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  let tail = "";
  let terminal = false;
  const interrupt = (controller: ReadableStreamDefaultController<Uint8Array>, reason: StreamInterruption) => {
    options.onInterrupted?.(reason);
    controller.enqueue(interruptedEvent(reason));
    controller.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<{ idle: true }>((resolve) => {
        timer = setTimeout(() => resolve({ idle: true }), idleMs);
        timer.unref?.();
      });
      const result = await Promise.race([reader.read(), idle]);
      if (timer) clearTimeout(timer);
      if ("idle" in result) {
        await reader.cancel().catch(() => undefined);
        interrupt(controller, "idle");
        return;
      }
      if (result.done) {
        if (terminal) controller.close();
        else interrupt(controller, "truncated");
        return;
      }
      const chunk = result.value;
      if (!terminal) {
        // Test the join of the previous tail and the whole new chunk BEFORE
        // trimming: the response.completed frame carries the full response
        // object (often well over 4 KiB), so trimming first would drop the
        // marker that sits at the start of that frame and every completed
        // stream would be reported as interrupted.
        const window = tail + decoder.decode(chunk, { stream: true });
        if (TERMINAL_EVENT_PATTERN.test(window)) terminal = true;
        tail = window.slice(-4096);
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

type CredentialState = {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string;
};

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

function collectorUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/collect";
  url.search = "";
  url.hash = "";
  return url.toString();
}

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
  private readonly fetcher: typeof externalFetch;
  private readonly log?: BrokerOptions["log"];
  private refreshInFlight: Promise<boolean> | null = null;

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
    this.persist = options.credentials?.persist;
    this.invalidate = options.credentials?.invalidate;
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
    const tokenUsed = this.state.accessToken;
    let response = await this.forward(request, normalizedPath, body, tokenUsed);
    const credentialAlreadyRotated = this.state?.accessToken !== tokenUsed;
    if (response.status === 401 && this.state && (credentialAlreadyRotated || await this.refresh(tokenUsed))) {
      await response.body?.cancel().catch(() => undefined);
      response = await this.forward(request, normalizedPath, body);
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

  async collect(sessionId: string, body: Uint8Array): Promise<Response> {
    if (!this.state) return Response.json({ error: "omnirush_account_required" }, { status: 401 });
    const tokenUsed = this.state.accessToken;
    const send = () => this.fetcher(collectorUrl(this.state!.gatewayUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.state!.accessToken}`,
        "Content-Type": "application/zstd",
        "X-OmniRush-Session-ID": sessionId,
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: AbortSignal.timeout(30_000),
    });
    let response = await send();
    const credentialAlreadyRotated = this.state?.accessToken !== tokenUsed;
    if (response.status === 401 && this.state && (credentialAlreadyRotated || await this.refresh(tokenUsed))) {
      await response.body?.cancel().catch(() => undefined);
      response = await send();
    }
    return response;
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

  private async performRefresh(expectedAccessToken: string): Promise<boolean> {
    if (!this.state) return false;
    if (this.state.accessToken !== expectedAccessToken) return true;
    const response = await this.fetcher(refreshUrl(this.state.gatewayUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: this.state.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        this.state = null;
        void this.invalidate?.().catch(() => undefined);
      }
      return false;
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return false;
    const accessToken = Reflect.get(payload, "access_token");
    const refreshToken = Reflect.get(payload, "refresh_token");
    const gatewayUrl = normalizedGatewayUrl(String(Reflect.get(payload, "gateway_url") ?? this.state.gatewayUrl));
    if (typeof accessToken !== "string" || typeof refreshToken !== "string" || !gatewayUrl) return false;
    this.state = { accessToken, refreshToken, gatewayUrl };
    void this.persistLatest({ accessToken, refreshToken, gatewayUrl });
    return true;
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
