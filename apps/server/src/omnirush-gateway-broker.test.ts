import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OmniRushGatewayBroker, grantExhaustedCopy, guardEventStream, type GrantClock } from "./omnirush-gateway-broker.js";
import { OmniRushReasoningEffort } from "./opencode-plugins/omnirush-reasoning-effort.js";
import type { OmniRushGatewayCredentialBundle } from "./types.js";

type UpstreamCall = { body: Record<string, unknown>; headers: Headers };

function capturingBroker(calls: UpstreamCall[]) {
  return new OmniRushGatewayBroker({
    credentials: {
      gatewayUrl: "https://gateway.example/omnirush/v1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    },
    engineToken: "local-engine-token",
    fetch: async (_input, init) => {
      // Untouched bodies are forwarded as the original ArrayBuffer; injected ones as JSON text.
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      calls.push({ body: JSON.parse(text), headers: new Headers(init?.headers) });
      return Response.json({ output: [] });
    },
  });
}

function gatewayRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, path = "responses") {
  return new Request(`http://127.0.0.1/omnirush-gateway/v1/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("OmniRush gateway broker", () => {
  test("refreshes one expired credential and retries concurrent requests with the rotated token", async () => {
    let refreshCalls = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/device/refresh")) {
        refreshCalls += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          gateway_url: "https://gateway.example/omnirush/v1",
        });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer new-access"
        ? Response.json({ output: [{ type: "output_text", text: "ok" }] }, { headers: { "x-omnirush-model": "gpt-6-astra" } })
        : Response.json({ error: "expired" }, { status: 401 });
    };
    const broker = new OmniRushGatewayBroker({
      credentials: {
        gatewayUrl: "https://gateway.example/omnirush/v1",
        accessToken: "expired-access",
        refreshToken: "old-refresh",
      },
      engineToken: "local-engine-token",
      fetch: fetcher,
    });
    const request = () => broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "test" }),
    }), "responses");

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(refreshCalls).toBe(1);
    expect(responses[0]?.headers.get("x-omnirush-model")).toBe("gpt-6-astra");
  });

  test("rejects unsupported compatibility endpoints", async () => {
    const broker = new OmniRushGatewayBroker({
      credentials: {
        gatewayUrl: "https://gateway.example/omnirush/v1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      engineToken: "local-engine-token",
      fetch: async () => Response.json({ ok: true }),
    });
    const response = await broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer local-engine-token" },
    }), "chat/completions");
    expect(response.status).toBe(404);
  });

  test("caches capabilities per credential pair, expires them, and falls back on a 404", async () => {
    const originalNow = Date.now;
    let now = originalNow();
    let supported = true;
    let probes = 0;
    Date.now = () => now;
    try {
      const broker = new OmniRushGatewayBroker({
        credentials: {
          gatewayUrl: "https://gateway.example/omnirush/v1",
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
        engineToken: "local-engine-token",
        fetch: async (input) => {
          if (new URL(String(input)).pathname.endsWith("/collect/capabilities")) {
            probes += 1;
            return supported
              ? Response.json({ schema_versions: [1, 2, 3], canonical_trace: true })
              : new Response("not found", { status: 404 });
          }
          return Response.json({ output: [] });
        },
      });

      const first = await Promise.all([broker.sessionUploadCapabilities(), broker.sessionUploadCapabilities()]);
      expect(first).toEqual([
        { schema_versions: [1, 2, 3], canonical_trace: true },
        { schema_versions: [1, 2, 3], canonical_trace: true },
      ]);
      expect(probes).toBe(1);

      now += 5 * 60_000 + 1;
      supported = false;
      expect(await broker.sessionUploadCapabilities()).toEqual({ schema_versions: [1, 2], canonical_trace: false });
      expect(probes).toBe(2);

      broker.resetCapabilities();
      supported = true;
      expect(await broker.sessionUploadCapabilities()).toEqual({ schema_versions: [1, 2, 3], canonical_trace: true });
      expect(probes).toBe(3);
    } finally {
      Date.now = originalNow;
    }
  });

  test("ends a file-aware upload callback promptly when its request is aborted", async () => {
    let started!: () => void;
    const uploadStarted = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    let callbackSignal: AbortSignal | undefined;
    const broker = new OmniRushGatewayBroker({
      credentials: {
        gatewayUrl: "https://gateway.example/omnirush/v1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      engineToken: "local-engine-token",
      uploadFile: async (_url, init) => {
        callbackSignal = init.signal;
        started();
        return new Promise<Response>(() => undefined);
      },
      fetch: async () => Response.json({ output: [] }),
    });
    const controller = new AbortController();
    const pending = broker.uploadSessionFile("session-file-abort-1", "/tmp/synthetic-capture.zst", 64, controller.signal);
    await uploadStarted;
    controller.abort(new DOMException("test abort", "AbortError"));
    let rejection: unknown;
    try {
      await pending;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeDefined();
    expect(callbackSignal?.aborted).toBe(true);
  });

  test("invalidates a revoked device session and returns a professional sign-in error", async () => {
    let invalidated = 0;
    const broker = new OmniRushGatewayBroker({
      credentials: {
        gatewayUrl: "https://gateway.example/omnirush/v1",
        accessToken: "revoked-access",
        refreshToken: "revoked-refresh",
        invalidate: async () => { invalidated += 1; },
      },
      engineToken: "local-engine-token",
      fetch: async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/device/refresh")) {
          return Response.json({ detail: "device_token_invalid" }, { status: 401 });
        }
        return Response.json({ detail: "device_token_invalid" }, { status: 401 });
      },
    });
    const response = await broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "test" }),
    }), "responses");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        message: "Your omnirush.ai session has expired. Sign in again from Settings.",
        type: "authentication_error",
        code: "omnirush_account_required",
      },
    });
    await Bun.sleep(1);
    expect(invalidated).toBe(1);
  });

  test("sends the max variant selected in the desktop as reasoning.effort", async () => {
    const calls: UpstreamCall[] = [];
    const broker = capturingBroker(calls);
    // The engine merges the variant options and runs the plugin hooks before
    // its OpenAI adapter builds the body; for gpt-6-astra that adapter emits
    // no reasoning block at all, so only the private header carries the level.
    const hooks = await OmniRushReasoningEffort();
    const headers: { headers: Record<string, string> } = { headers: {} };
    const hookInput = {
      agent: "omnirush",
      model: { id: "gpt-6-astra", providerID: "omnirush" },
      message: { id: "msg_max", model: { variant: "max" } },
    };
    await hooks["chat.params"](hookInput, { options: { reasoning_effort: "max" } });
    await hooks["chat.headers"](hookInput, headers);

    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }, headers.headers), "responses");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ model: "gpt-6-astra", input: "test", reasoning: { effort: "max", summary: "auto" } });
    expect(calls[0]?.headers.has("x-omnirush-reasoning-effort")).toBe(false);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-token");
  });

  test("requests GPT-6 summaries without an effort header and preserves explicit options", async () => {
    const calls: UpstreamCall[] = [];
    const broker = capturingBroker(calls);
    const bodies = [
      { model: "gpt-6-astra", input: "default" },
      { model: "gpt-6.1-sol", input: "new sol", reasoning: { effort: "high" } },
      { model: "gpt-6-sol", input: "selected", reasoning: { effort: "high" } },
      { model: "gpt-6-astra", input: "legacy", reasoning_effort: "xhigh" },
      { model: "gpt-6-astra", input: "explicit", reasoning: { effort: "low", summary: "detailed" } },
      { model: "gpt-6-sol", input: "disabled", reasoning: { summary: null } },
      { model: "gpt-5.6-sol", input: "sol" },
      { model: "meta-muse", input: "other" },
    ];
    for (const body of bodies) await broker.handle(gatewayRequest(body), "responses");
    expect(calls.map((call) => call.body)).toEqual([
      { ...bodies[0], reasoning: { summary: "auto" } },
      { ...bodies[1], reasoning: { effort: "high", summary: "auto" } },
      { ...bodies[2], reasoning: { effort: "high", summary: "auto" } },
      { ...bodies[3], reasoning: { summary: "auto" } },
      ...bodies.slice(4),
    ]);
  });

  test("leaves compaction and malformed request bodies without a summary default", async () => {
    const calls: UpstreamCall[] = [];
    const broker = capturingBroker(calls);
    const compact = { model: "gpt-6-astra", input: "compact", reasoning: { effort: "high" } };
    const malformed = { model: "gpt-6-astra", input: "invalid", reasoning: "invalid" };
    await broker.handle(gatewayRequest(compact, {}, "responses/compact"), "responses/compact");
    await broker.handle(gatewayRequest(malformed), "responses");
    expect(calls.map((call) => call.body)).toEqual([compact, malformed]);
  });

  test("keeps an effort the engine already emitted and the legacy top-level field", async () => {
    const calls: UpstreamCall[] = [];
    const broker = capturingBroker(calls);
    const header = { "x-omnirush-reasoning-effort": "max" };

    await broker.handle(gatewayRequest({ model: "gpt-5.6-sol", input: "a", reasoning: { effort: "max", summary: "auto" } }, header), "responses");
    await broker.handle(gatewayRequest({ model: "gpt-5.6-sol", input: "b", reasoning_effort: "high" }, header), "responses/compact");
    await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "c" }, { "x-omnirush-reasoning-effort": "turbo" }), "responses");
    await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "d" }), "responses");

    expect(calls.map((call) => call.body)).toEqual([
      { model: "gpt-5.6-sol", input: "a", reasoning: { effort: "max", summary: "auto" } },
      { model: "gpt-5.6-sol", input: "b", reasoning_effort: "high" },
      { model: "gpt-6-astra", input: "c", reasoning: { summary: "auto" } },
      { model: "gpt-6-astra", input: "d", reasoning: { summary: "auto" } },
    ]);
  });
});


function sseBroker(chunks: string[]) {
  return new OmniRushGatewayBroker({
    credentials: {
      gatewayUrl: "https://gateway.example/omnirush/v1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    },
    engineToken: "local-engine-token",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
}

async function readAll(response: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
}

describe("upstream stream guard", () => {
  const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n';
  const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n';

  test("passes a completed stream through untouched", async () => {
    const response = await sseBroker([created, completed]).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi", stream: true }), "responses");
    const text = await readAll(response);
    expect(text).toBe(created + completed);
    expect(text).not.toContain("upstream_stream_interrupted");
  });

  test("appends an error event when the upstream closes before a terminal event", async () => {
    const partial = 'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"patch"}\n\n';
    const response = await sseBroker([created, partial]).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi", stream: true }), "responses");
    const text = await readAll(response);
    expect(text.startsWith(created + partial)).toBe(true);
    const tailEvent = text.slice((created + partial).length);
    expect(tailEvent).toMatch(/^event: error\ndata: /);
    const payload = JSON.parse(tailEvent.replace(/^event: error\ndata: /, "").trim()) as { type: string; error: { code: string; message: string } };
    expect(payload.type).toBe("error");
    expect(payload.error.code).toBe("upstream_stream_interrupted");
    expect(payload.error.message).toContain("omnirush.ai");
  });

  test("treats response.failed and response.incomplete as terminal", async () => {
    for (const terminal of ['data: {"type":"response.failed"}\n\n', 'data: {"type":"response.incomplete"}\n\n']) {
      const response = await sseBroker([created, terminal]).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi", stream: true }), "responses");
      expect(await readAll(response)).toBe(created + terminal);
    }
  });

  test("closes a stalled stream with an error event after the idle timeout", async () => {
    const reasons: string[] = [];
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(created)); },
    });
    const guarded = guardEventStream(stalled, { idleMs: 50, onInterrupted: (reason) => reasons.push(reason) });
    const text = await readAll(new Response(guarded));
    expect(reasons).toEqual(["idle"]);
    expect(text.startsWith(created)).toBe(true);
    expect(text).toContain("upstream_stream_interrupted");
    expect(text).toContain("stalled");
  });

  test("does not wrap non-streamed JSON responses", async () => {
    const calls: UpstreamCall[] = [];
    const response = await capturingBroker(calls).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi" }), "responses");
    expect(await response.json()).toEqual({ output: [] });
  });
});


describe("upstream stream guard with realistic frame sizes", () => {
  test("recognises a completion frame larger than the rolling window delivered in one chunk", async () => {
    const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_big"}}\n\n';
    const text = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi again! What would you like to work on?"}\n\n';
    // Real completed frames embed the whole response object; make this one ~12 KiB.
    const padding = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(12_000) }] }] });
    const completed = 'event: response.completed\ndata: {"type":"response.completed","response":' + padding + '}\n\n';
    const response = await sseBroker([created, text, completed]).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi", stream: true }), "responses");
    const body = await readAll(response);
    expect(body).toBe(created + text + completed);
    expect(body).not.toContain("upstream_stream_interrupted");
  });

  test("recognises a completion marker split across chunk boundaries", async () => {
    const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_split"}}\n\n';
    const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_split","status":"completed"}}\n\n';
    const cut = completed.indexOf("response.comp") + 8;
    const response = await sseBroker([created, completed.slice(0, cut), completed.slice(cut)]).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi", stream: true }), "responses");
    const body = await readAll(response);
    expect(body).toBe(created + completed);
    expect(body).not.toContain("upstream_stream_interrupted");
  });
});

describe("OmniRush gateway broker with a refresh owner", () => {
  const gatewayUrl = "https://gateway.example/omnirush/v1";
  /** The pair after n-1 rotations of one device session. */
  const bundle = (n: number) => ({ gatewayUrl, accessToken: `access-${n}`, refreshToken: `refresh-${n}`, rotation: n - 1 });

  /** Upstream accepts only the access tokens in `valid`; a refresh request fails the test. */
  function upstream(valid: Set<string>, bearers: string[]) {
    return async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/device/refresh")) throw new Error("the broker sent a refresh token");
      const bearer = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      bearers.push(bearer);
      return valid.has(bearer) ? Response.json({ output: [] }) : Response.json({ error: "expired" }, { status: 401 });
    };
  }

  function ownedBroker(owner: (rejected: string) => Promise<ReturnType<typeof bundle> | null>, valid: Set<string>, bearers: string[], onInvalidate = () => {}) {
    return new OmniRushGatewayBroker({
      credentials: { ...bundle(1), refresh: owner, invalidate: async () => onInvalidate() },
      engineToken: "local-engine-token",
      fetch: upstream(valid, bearers),
    });
  }

  test("asks the owner after a 401 and never sends a refresh token itself", async () => {
    const asked: string[] = [];
    const bearers: string[] = [];
    const broker = ownedBroker(async (rejected) => {
      asked.push(rejected);
      return bundle(2);
    }, new Set(["access-2"]), bearers);
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(200);
    expect(asked).toEqual(["access-1"]);
    expect(bearers).toEqual(["access-1", "access-2"]);
  });

  test("a later 401 hands the owner the pair it gave last, so only the current pair is ever rotated", async () => {
    const asked: string[] = [];
    const valid = new Set(["access-2"]);
    const broker = ownedBroker(async (rejected) => {
      asked.push(rejected);
      return bundle(Number(rejected.slice("access-".length)) + 1);
    }, valid, []);
    expect((await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses")).status).toBe(200);
    valid.delete("access-2");
    valid.add("access-3");
    expect((await broker.modelCatalog()).status).toBe(200);
    expect(await broker.refreshAccessToken()).toBe("access-4");
    expect(asked).toEqual(["access-1", "access-2", "access-3"]);
  });

  test("concurrent 401s ask the owner once", async () => {
    let asked = 0;
    const broker = ownedBroker(async () => {
      asked += 1;
      await Bun.sleep(10);
      return bundle(2);
    }, new Set(["access-2"]), []);
    const responses = await Promise.all([
      broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "one" }), "responses"),
      broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "two" }), "responses"),
      broker.uploadSession("session-1234", new Uint8Array([1, 2, 3])),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(asked).toBe(1);
  });

  test("signs the device out when the owner reports the session gone", async () => {
    let invalidated = 0;
    const broker = ownedBroker(async () => null, new Set(), [], () => { invalidated += 1; });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("omnirush_account_required");
    await Bun.sleep(1);
    expect(invalidated).toBe(1);
  });

  test("an owner that cannot rotate right now keeps the session and answers a retryable 503", async () => {
    let invalidated = 0;
    let offline = true;
    const broker = ownedBroker(async () => {
      if (offline) throw new Error("Account refresh unavailable (ENOTFOUND)");
      return bundle(2);
    }, new Set(["access-2"]), [], () => { invalidated += 1; });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("device_refresh_unavailable");
    expect(invalidated).toBe(0);
    offline = false;
    expect((await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses")).status).toBe(200);
  });
});

/**
 * The embedded broker and the desktop account store share one device
 * session. The store is its one refresh owner: the broker asks it after a
 * 401 and never refreshes on its own. These run the real store against the
 * real broker, wired as apps/desktop/electron/runtime.mjs wires them. The
 * account server accepts the refresh token its latest rotation replaced for
 * 120 s; any other superseded token it receives reads as a copied sign-in.
 */
describe("OmniRush gateway broker sharing a device session with the desktop account store", () => {
  const gatewayUrl = "https://gateway.example/omnirush/v1";
  type StoredBundle = OmniRushGatewayCredentialBundle & { rotation: number };
  type AccountStore = {
    load: () => Promise<StoredBundle | null>;
    save: (credentials: OmniRushGatewayCredentialBundle) => Promise<void>;
    refresh: (rejectedAccessToken: string) => Promise<StoredBundle | null>;
    status: () => Promise<{ connected: boolean; reauthorizationRequired?: boolean; email?: string | null }>;
    clear: (options?: { revokeRemote?: boolean }) => Promise<unknown>;
  };
  type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  /** The account server: a rotation demotes the spent token to `previous` (120 s grace) and retires the one before. */
  function accountServer() {
    const server = {
      access: "access-1",
      refresh: "refresh-1",
      previous: null as string | null,
      generation: 1,
      expired: new Set<string>(),
      refreshCalls: [] as string[],
      /** Superseded refresh tokens presented outside the grace: the backend's copied-sign-in signal. */
      superseded: [] as string[],
      holdRefresh: null as Promise<void> | null,
    };
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      const bearer = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      if (url.pathname.endsWith("/device/me")) {
        return bearer === server.access && !server.expired.has(bearer)
          ? Response.json({ email: "person@example.com", status: "active" })
          : Response.json({ detail: "device_token_invalid" }, { status: 401 });
      }
      if (url.pathname.endsWith("/device/refresh")) {
        const { refresh_token: token } = JSON.parse(String(init?.body)) as { refresh_token: string };
        server.refreshCalls.push(token);
        const hold = server.holdRefresh;
        server.holdRefresh = null;
        if (hold) await hold;
        // Every call here happens well inside the 120 s grace.
        if (token !== server.refresh && token !== server.previous) {
          if (/^refresh-\d+$/.test(token)) server.superseded.push(token);
          return Response.json({ detail: "refresh_token_invalid_or_expired" }, { status: 401 });
        }
        server.previous = server.refresh;
        server.generation += 1;
        server.access = `access-${server.generation}`;
        server.refresh = `refresh-${server.generation}`;
        return Response.json({ access_token: server.access, refresh_token: server.refresh, gateway_url: gatewayUrl });
      }
      return bearer === server.access && !server.expired.has(bearer)
        ? Response.json({ output: [] })
        : Response.json({ error: "expired" }, { status: 401 });
    };
    return { server, fetcher };
  }

  /** The broker's own fetch: model and API calls only; it must never reach the refresh endpoint. */
  function brokerFetch(fetcher: Fetcher): Fetcher {
    return async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/device/refresh")) throw new Error("the broker sent a refresh token");
      return fetcher(input, init);
    };
  }

  const storeModule = fileURLToPath(new URL("../../desktop/electron/omnirush-account.mjs", import.meta.url));

  async function desktopStore(fetcher: Fetcher, options: { saveFails?: { value: boolean }; logs?: string[]; where?: { filePath: string } } = {}): Promise<AccountStore> {
    const { createDesktopOmniRushAccountStore } = await import(storeModule) as {
      createDesktopOmniRushAccountStore: (options: Record<string, unknown>) => AccountStore;
    };
    const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-shared-session-"));
    if (options.where) options.where.filePath = path.join(directory, "account.bin");
    const storage = {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptStringAsync: async (value: string) => {
        if (options.saveFails?.value) throw new Error("Secure desktop credential storage is unavailable");
        return Buffer.from(value, "utf8");
      },
      decryptStringAsync: async (value: Buffer) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
    };
    const store = createDesktopOmniRushAccountStore({
      filePath: path.join(directory, "account.bin"),
      loadSafeStorage: () => storage,
      platform: "linux",
      env: { OMNIRUSH_DEV_MODE: "1" },
      fetchImpl: fetcher,
      sleep: async () => undefined,
      execFileImpl: async () => { throw new Error("no keychain"); },
      log: (line: string) => options.logs?.push(line),
      persistRetryBaseMs: 5,
    });
    await store.save({ gatewayUrl, accessToken: "access-1", refreshToken: "refresh-1" });
    return store;
  }

  async function brokerFor(store: AccountStore, fetcher: Fetcher) {
    const credentials = await store.load();
    if (!credentials) throw new Error("store is signed out");
    return new OmniRushGatewayBroker({
      credentials: {
        ...credentials,
        refresh: (rejectedAccessToken) => store.refresh(rejectedAccessToken),
        invalidate: () => store.clear({ revokeRemote: false }).then(() => undefined),
        latest: () => store.load(),
      },
      engineToken: "local-engine-token",
      fetch: brokerFetch(fetcher),
    });
  }

  const prompt = () => gatewayRequest({ model: "gpt-6-astra", input: "test" });

  test("the store and the broker racing a refresh spend the token once and end on the same pair", async () => {
    const { server, fetcher } = accountServer();
    const store = await desktopStore(fetcher);
    const broker = await brokerFor(store, fetcher);
    server.expired.add("access-1");
    let release = () => {};
    server.holdRefresh = new Promise<void>((resolve) => { release = resolve; });
    // The profile check and two model requests all see access-1 refused at once.
    const racing = Promise.all([store.status(), broker.handle(prompt(), "responses"), broker.handle(prompt(), "responses")]);
    await Bun.sleep(10);
    release();
    const [status, first, second] = await racing;
    expect(status.email).toBe("person@example.com");
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(server.refreshCalls).toEqual(["refresh-1"]);
    expect(await store.load()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
    expect(await broker.refreshAccessToken()).toBe("access-3"); // the broker holds the store's pair: it rotates refresh-2
    expect(server.refreshCalls).toEqual(["refresh-1", "refresh-2"]);
    expect(server.superseded).toEqual([]);
  });

  test("a broker 401 after the store rotated uses the store's pair; the old refresh token is never sent", async () => {
    const { server, fetcher } = accountServer();
    const store = await desktopStore(fetcher);
    const broker = await brokerFor(store, fetcher);
    server.expired.add("access-1");
    expect((await store.status()).email).toBe("person@example.com"); // the store rotates 1 -> 2
    expect((await broker.handle(prompt(), "responses")).status).toBe(200); // access-1 refused, access-2 used
    expect((await broker.modelCatalog()).status).toBe(200);
    expect(server.refreshCalls).toEqual(["refresh-1"]);
    expect(server.superseded).toEqual([]);
  });

  test("a failed save keeps the rotated pair in use by both and retries it; the pair it replaced is never sent", async () => {
    const { server, fetcher } = accountServer();
    const saveFails = { value: false };
    const logs: string[] = [];
    const where = { filePath: "" };
    const store = await desktopStore(fetcher, { saveFails, logs, where });
    const broker = await brokerFor(store, fetcher);
    saveFails.value = true; // secure storage is unavailable from now on
    server.expired.add("access-1");
    expect((await broker.handle(prompt(), "responses")).status).toBe(200); // 1 -> 2, kept in memory
    expect((await store.status()).email).toBe("person@example.com");
    expect(logs.some((line) => line.includes("Could not save the renewed omnirush.ai sign-in"))).toBe(true);
    server.expired.add("access-2"); // an hour later
    expect((await broker.handle(prompt(), "responses")).status).toBe(200); // spends refresh-2, not refresh-1
    expect(server.refreshCalls).toEqual(["refresh-1", "refresh-2"]);
    // Once storage is back, the retry saves the current pair.
    saveFails.value = false;
    for (let waited = 0; waited < 200 && !(await readFile(where.filePath, "utf8")).includes("refresh-3"); waited += 1) await Bun.sleep(5);
    expect(JSON.parse(await readFile(where.filePath, "utf8"))).toMatchObject({ refreshToken: "refresh-3", rotation: 2 });
    expect(server.superseded).toEqual([]);
    expect(logs.some((line) => /(access|refresh)-\d/.test(line))).toBe(false);
  });

  test("a revoked session the store agrees on still signs the device out promptly", async () => {
    const { server, fetcher } = accountServer();
    const store = await desktopStore(fetcher);
    const broker = await brokerFor(store, fetcher);
    server.expired.add("access-1");
    server.refresh = "revoked-elsewhere"; // the server no longer knows refresh-1
    const response = await broker.handle(prompt(), "responses");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("omnirush_account_required");
    expect(server.refreshCalls).toEqual(["refresh-1"]);
    await Bun.sleep(5);
    expect(await store.load()).toBeNull();
    const status = await store.status();
    expect(status.connected).toBe(false);
    expect(status.reauthorizationRequired).toBe(true);
  });
});

describe("OmniRush gateway broker project archive requests", () => {
  const archiveId = "0f6c2a7e-5b1d-4c8e-9a3f-2d7b6e1c4a90";

  test("reach the gateway root with the device bearer and refresh an expired one like uploadSession()", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; contentType: string | null; body: unknown }> = [];
    const refreshCalls: string[] = [];
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1/", accessToken: "access-1", refreshToken: "refresh-1" },
      engineToken: "local-engine-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/device/refresh")) {
          refreshCalls.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
          return Response.json({ access_token: "access-2", refresh_token: "refresh-2", gateway_url: "https://gateway.example/omnirush/v1" });
        }
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), contentType: headers.get("content-type"), body: init?.body });
        return headers.get("authorization") === "Bearer access-2"
          ? Response.json({ ok: true })
          : Response.json({ detail: "invalid_token" }, { status: 401 });
      },
    });

    expect((await broker.archiveRequest("archives/key", { method: "GET" })).status).toBe(200);
    const body = JSON.stringify({ parts: [{ part_number: 1, etag: "\"e1\"" }] });
    expect((await broker.archiveRequest(`archives/${archiveId}/complete`, { method: "POST", body })).status).toBe(200);

    expect(refreshCalls).toEqual(["refresh-1"]);
    expect(calls).toEqual([
      { url: "https://gateway.example/omnirush/archives/key", method: "GET", authorization: "Bearer access-1", contentType: null, body: undefined },
      { url: "https://gateway.example/omnirush/archives/key", method: "GET", authorization: "Bearer access-2", contentType: null, body: undefined },
      { url: `https://gateway.example/omnirush/archives/${archiveId}/complete`, method: "POST", authorization: "Bearer access-2", contentType: "application/json", body },
    ]);
  });

  test("refresh: false (the archiver's policy probe) sends once and returns a 401 as it is, with no refresh", async () => {
    const calls: string[] = [];
    const refreshCalls: string[] = [];
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1/", accessToken: "access-1", refreshToken: "refresh-1" },
      engineToken: "local-engine-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/device/refresh")) {
          refreshCalls.push(url);
          return Response.json({ access_token: "access-2", refresh_token: "refresh-2", gateway_url: "https://gateway.example/omnirush/v1" });
        }
        calls.push(`${init?.method ?? "GET"} ${url} ${new Headers(init?.headers).get("authorization")}`);
        return Response.json({ detail: "invalid_token" }, { status: 401 });
      },
    });
    const response = await broker.archiveRequest("archives/key", { method: "GET", refresh: false });
    expect(response.status).toBe(401);
    expect(calls).toEqual(["GET https://gateway.example/omnirush/archives/key Bearer access-1"]);
    expect(refreshCalls).toEqual([]);
  });

  test("never leave the archive routes, and answer 401 without an account", async () => {
    const urls: string[] = [];
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-1", refreshToken: "refresh-1" },
      engineToken: "local-engine-token",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json({ ok: true });
      },
    });
    for (const path of ["collect", "archives/../device/refresh", "archives/not-a-uuid/parts", `archives/${archiveId}/delete`, "https://elsewhere.example/archives"]) {
      expect([path, (await broker.archiveRequest(path, { method: "POST", body: "{}" })).status]).toEqual([path, 404]);
    }
    expect(urls).toEqual([]);
    expect((await broker.archiveRequest("archives", { method: "POST", body: "{}" })).status).toBe(200);
    expect(urls).toEqual(["https://gateway.example/omnirush/archives"]);

    const signedOut = new OmniRushGatewayBroker({ engineToken: "local-engine-token" });
    const response = await signedOut.archiveRequest("archives/key", { method: "GET" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "omnirush_account_required" });
  });
});

/** Feeds `bytes` through the guard in `chunkSize` pieces; returns what the engine reads and why it was cut. */
async function replayStream(bytes: Uint8Array, chunkSize: number) {
  const reasons: string[] = [];
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.slice(index, index + chunkSize));
      }
      controller.close();
    },
  });
  const out = new Uint8Array(await new Response(guardEventStream(upstream, { onInterrupted: (reason) => reasons.push(reason) })).arrayBuffer());
  return { out, text: new TextDecoder().decode(out), reasons };
}

/** The data payloads of every event in an SSE text, in order. */
function eventPayloads(text: string): unknown[] {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as unknown];
  });
}

describe("upstream stream guard with recorded Muse streams", () => {
  // A live meta Muse web-search stream (muse-spark-1.3, search_context_size
  // medium) with its content scrubbed: model names, reasoning, text, queries,
  // URLs and titles are replaced; the framing is as recorded. Sorted-key JSON
  // puts `type` at the end of each frame; the stream carries a `: keepalive`
  // comment, url_citation annotations and commentary-phase messages, and ends
  // with response.completed and a bare `data: [DONE]`.
  const fixture = readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "muse-web-search.sse"));
  const cutBefore = (text: string, marker: string) => new TextEncoder().encode(text.slice(0, text.lastIndexOf(marker)));

  test("forwards a recorded Muse stream byte for byte and never reports it truncated", async () => {
    const bytes = new Uint8Array(await fixture);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("\n\n: keepalive\n\n");
    expect(text).toContain('"type":"response.web_search_call.completed"}');
    expect(text.trimEnd().endsWith('"type":"response.completed"}\n\ndata: [DONE]')).toBe(true);
    for (const chunkSize of [1, 3, 64, 1024, 16_384, bytes.length]) {
      const { out, reasons } = await replayStream(bytes, chunkSize);
      expect([chunkSize, reasons]).toEqual([chunkSize, []]);
      expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  test("still reports a recorded stream cut before its terminal event", async () => {
    const text = new TextDecoder().decode(await fixture);
    const completed = text.lastIndexOf("event: response.completed");
    // Cut at an event boundary, and in the middle of the final response.completed frame.
    for (const cut of [completed, completed + 200]) {
      const { text: out, reasons } = await replayStream(new TextEncoder().encode(text.slice(0, cut)), 512);
      expect(reasons).toEqual(["truncated"]);
      // A partial event is never forwarded, so the interruption frame stays well formed.
      expect(out).toBe(text.slice(0, completed) + out.slice(completed));
      const last = eventPayloads(out).at(-1) as { type: string; error: { code: string } };
      expect(last).toMatchObject({ type: "error", sequence_number: -1, error: { code: "upstream_stream_interrupted" } });
    }
  });

  test("a bare data: [DONE] ends a stream on its own", async () => {
    const text = new TextDecoder().decode(await fixture);
    const withoutCompleted = text.slice(0, text.lastIndexOf("event: response.completed")) + "data: [DONE]\n\n";
    const { text: out, reasons } = await replayStream(new TextEncoder().encode(withoutCompleted), 4096);
    expect(reasons).toEqual([]);
    expect(out).toBe(withoutCompleted);
  });

  test("comments are not data, even when they look like a terminal event", async () => {
    const created = 'event: response.created\ndata: {"response":{"id":"resp_1"},"sequence_number":0,"type":"response.created"}\n\n';
    const comments = ': keepalive\n\n: {"sequence_number":9,"type":"response.completed"}\n\n: data: [DONE]\n\n';
    const { text, reasons } = await replayStream(new TextEncoder().encode(created + comments), 7);
    expect(reasons).toEqual(["truncated"]);
    expect(text.startsWith(created + comments)).toBe(true);
  });

  test("CRLF-framed streams are framed and completed the same way", async () => {
    const text = new TextDecoder().decode(await fixture).replace(/\n/g, "\r\n");
    const bytes = new TextEncoder().encode(text);
    const { out, reasons } = await replayStream(bytes, 333);
    expect(reasons).toEqual([]);
    expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
  });

  test("the backend's error frame ends the stream, carrying readable copy under its own code", async () => {
    const created = 'event: response.created\ndata: {"response":{"id":"resp_1"},"sequence_number":0,"type":"response.created"}\n\n';
    for (const [code, copy] of [
      ["upstream_idle_timeout", "stopped responding before it finished"],
      ["upstream_provider_unavailable", "temporarily unavailable"],
      ["upstream_stream_interrupted", "ended before the response completed"],
    ]) {
      const frame = `event: error\ndata: ${JSON.stringify({ type: "error", sequence_number: -1, error: { type: "server_error", code, message: "Upstream stopped sending data" } })}\n\n`;
      const { text, reasons } = await replayStream(new TextEncoder().encode(created + frame), 50);
      expect(reasons).toEqual([]);
      const events = eventPayloads(text);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        type: "error",
        sequence_number: -1,
        error: { type: "server_error", code, message: expect.stringContaining(copy) },
      });
      expect(JSON.stringify(events[1])).toContain("omnirush.ai: ");
    }
  });

  test("a relay error frame that was not rewritten becomes one the engine parses", async () => {
    const created = 'event: response.created\ndata: {"response":{"id":"resp_1"},"sequence_number":0,"type":"response.created"}\n\n';
    const relay = 'event: error\ndata: {"error":{"code":"idle_timeout","message":"Upstream stopped sending data","request_id":"req_1","type":"timeout"}}\n\n';
    const { text, reasons } = await replayStream(new TextEncoder().encode(created + relay), 16);
    expect(reasons).toEqual([]);
    expect(text).toMatch(/\n\nevent: error\ndata: \{/);
    expect(eventPayloads(text)[1]).toEqual({
      type: "error",
      sequence_number: -1,
      error: { type: "timeout", code: "idle_timeout", message: expect.stringContaining("stopped responding") },
    });
  });

  test("an error frame the engine already parses keeps its bytes when there is no better copy", async () => {
    const frame = 'event: error\ndata: {"type":"error","sequence_number":4,"code":"server_error","message":"The server had an error while processing your request.","param":null}\n\n';
    const { text, reasons } = await replayStream(new TextEncoder().encode(frame), 8);
    expect(reasons).toEqual([]);
    expect(text).toBe(frame);
  });

  const recordedDir = process.env.OMNIRUSH_RECORDED_SSE_DIR?.trim();
  test.skipIf(!recordedDir)("replays every recorded stream in OMNIRUSH_RECORDED_SSE_DIR unchanged and complete", async () => {
    const names = (await readdir(recordedDir!)).filter((name) => name.endsWith(".sse")).sort();
    let replayed = 0;
    for (const name of names) {
      const bytes = new Uint8Array(await readFile(path.join(recordedDir!, name)));
      // A refused request is recorded as its JSON error body, not a stream.
      if (!/^(?:event|data):/.test(new TextDecoder().decode(bytes.slice(0, 16)))) continue;
      for (const chunkSize of [1, 7, 512, 4096, bytes.length]) {
        const { out, reasons } = await replayStream(bytes, chunkSize);
        expect([name, chunkSize, reasons]).toEqual([name, chunkSize, []]);
        expect([name, Buffer.from(out).equals(Buffer.from(bytes))]).toEqual([name, true]);
      }
      const text = new TextDecoder().decode(bytes);
      const cut = await replayStream(cutBefore(text, "event: response.completed"), 999);
      expect([name, cut.reasons]).toEqual([name, ["truncated"]]);
      replayed += 1;
    }
    expect(replayed).toBeGreaterThan(0);
  });
});

describe("readable gateway errors", () => {
  function refusingBroker(status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
    return new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      fetch: async () => new Response(body, { status, headers }),
    });
  }

  test("turn the backend's and the relay's refusal codes into copy the engine shows, keeping status and Retry-After", async () => {
    const cases: Array<{ status: number; body: unknown; headers?: Record<string, string>; code: string; copy: string }> = [
      { status: 400, body: { detail: "model_unavailable" }, code: "model_unavailable", copy: "not available on your account" },
      { status: 429, body: { detail: "model_concurrency_limited" }, headers: { "retry-after": "5" }, code: "model_concurrency_limited", copy: "Wait for one to finish" },
      { status: 429, body: { detail: "daily_grant_exhausted" }, code: "daily_grant_exhausted", copy: "today's model allowance" },
      { status: 502, body: { detail: "model_upstream_auth_failed" }, code: "model_upstream_auth_failed", copy: "temporarily unavailable" },
      {
        status: 503,
        body: { error: { type: "upstream_error", code: "provider_unavailable", message: "Upstream is temporarily unavailable", request_id: "req_1" } },
        headers: { "retry-after": "60" },
        code: "provider_unavailable",
        copy: "temporarily unavailable",
      },
      // What muse-spark-1.2 answered while it was down.
      {
        status: 500,
        body: { error: { type: "upstream_error", code: "provider_error", message: "Upstream returned an error", request_id: "req_2" } },
        code: "provider_error",
        copy: "the model provider could not complete this request.",
      },
    ];
    for (const entry of cases) {
      const response = await refusingBroker(entry.status, JSON.stringify(entry.body), { "content-type": "application/json", ...entry.headers })
        .handle(gatewayRequest({ model: "meta-muse-spark", input: "hi", stream: true }), "responses");
      expect([entry.code, response.status]).toEqual([entry.code, entry.status]);
      expect(response.headers.get("retry-after")).toBe(entry.headers?.["retry-after"] ?? null);
      const payload = await response.json() as { error: { message: string; code: string } };
      expect(payload.error.code).toBe(entry.code);
      expect(payload.error.message).toStartWith("omnirush.ai: ");
      expect(payload.error.message).toContain(entry.copy);
    }
  });

  test("a spent grant says which limit ran out and when it resets, and is never resent", async () => {
    const spent = (headers: Record<string, string>) => refusingBroker(429, JSON.stringify({ detail: "daily_grant_exhausted" }), {
      "content-type": "application/json",
      "retry-after": "60",
      "x-ratelimit-limit-tokens": "5000000",
      "x-ratelimit-remaining-tokens": "0",
      ...headers,
    }).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi", stream: true }), "responses");

    const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const day = await spent({ "x-omnirush-grant-scope": "day", "x-omnirush-grant-resets-at": resetsAt });
    expect(day.status).toBe(429);
    // The engine would otherwise resend it ten times, a Retry-After apart.
    expect(day.headers.get("x-should-retry")).toBe("false");
    expect(day.headers.get("retry-after")).toBe("60");
    expect(day.headers.get("x-omnirush-grant-scope")).toBe("day");
    const dayError = (await day.json() as { error: { message: string; code: string } }).error;
    expect(dayError.code).toBe("daily_grant_exhausted");
    expect(dayError.message).toMatch(/^omnirush\.ai: today's tokens are used up\. They refill at \d{1,2}:\d{2}( [AP]M)? \(in 3 h\)\.$/);

    const week = await spent({ "x-omnirush-grant-scope": "week", "x-omnirush-grant-resets-at": new Date(Date.now() + 4 * 86_400_000).toISOString() });
    expect((await week.json() as { error: { message: string } }).error.message)
      .toMatch(/^omnirush\.ai: this week's cap is reached\. It resets [A-Z][a-z]+day \d{1,2}:\d{2}( [AP]M)? \(in 4 days\)\.$/);

    const empty = await spent({ "x-omnirush-grant-scope": "empty" });
    expect((await empty.json() as { error: { message: string } }).error.message).toBe(
      "omnirush.ai: you have no tokens left. Link Discord or connect GitHub in the console to earn tokens every day: https://gateway.example/console/account",
    );

    // An older gateway without the headers: the general copy, still not resent.
    const older = await spent({});
    expect(older.headers.get("x-should-retry")).toBe("false");
    expect((await older.json() as { error: { message: string } }).error.message).toBe(
      "omnirush.ai: you have used today's model allowance. It refills at 00:00 UTC.",
    );
  });

  test("grant copy on the user's clock: local time, then how long until it", () => {
    const now = Date.parse("2026-09-30T21:00:00Z");
    const headers = (scope: string, resetsAt?: string) => new Headers({
      "x-omnirush-grant-scope": scope,
      ...(resetsAt ? { "x-omnirush-grant-resets-at": resetsAt } : {}),
    });
    const india: GrantClock = { now, timeZone: "Asia/Kolkata", hourCycle: "h12" };
    expect(grantExhaustedCopy(headers("day", "2026-10-01T00:00:00Z"), null, india))
      .toBe("Today's tokens are used up. They refill at 5:30 AM (in 3 h).");
    expect(grantExhaustedCopy(headers("week", "2026-10-05T00:00:00Z"), null, india))
      .toBe("This week's cap is reached. It resets Monday 5:30 AM (in 4 days).");
    // West of UTC the week resets on Sunday afternoon; 24-hour clocks stay 24-hour.
    expect(grantExhaustedCopy(headers("week", "2026-10-05T00:00:00Z"), null, { now, timeZone: "America/Los_Angeles", hourCycle: "h12" }))
      .toBe("This week's cap is reached. It resets Sunday 5:00 PM (in 4 days).");
    expect(grantExhaustedCopy(headers("day", "2026-09-30T21:40:00Z"), null, { now, timeZone: "Europe/Berlin", hourCycle: "h23" }))
      .toBe("Today's tokens are used up. They refill at 23:40 (in 40 min).");
    // Without a reset time the known UTC reset; a scope in another case still reads.
    expect(grantExhaustedCopy(headers("DAY"), null, india)).toBe("Today's tokens are used up. They refill at 00:00 UTC.");
    expect(grantExhaustedCopy(headers("week"), null, india)).toBe("This week's cap is reached. It resets Monday 00:00 UTC.");
    expect(grantExhaustedCopy(headers("empty"), null, india))
      .toBe("You have no tokens left. Link Discord or connect GitHub in the console to earn tokens every day.");
    // No scope, or one this app does not know: the caller's general copy.
    expect(grantExhaustedCopy(new Headers(), null, india)).toBeNull();
    expect(grantExhaustedCopy(headers("month", "2026-10-01T00:00:00Z"), null, india)).toBeNull();
  });

  test("keep what a provider error names as refused", async () => {
    const body = { error: { type: "upstream_error", code: "provider_error", message: "Upstream returned an error: Unknown parameter: 'stop'.", param: "stop" } };
    const response = await refusingBroker(400, JSON.stringify(body)).handle(gatewayRequest({ model: "meta-muse-spark", input: "hi" }), "responses");
    expect(await response.json()).toEqual({
      error: {
        message: "omnirush.ai: the model provider could not complete this request. (Unknown parameter: 'stop'.)",
        type: "upstream_error",
        code: "provider_error",
        param: "stop",
      },
    });
  });

  test("leave errors without a known code as they came", async () => {
    const openai = JSON.stringify({ error: { message: "Invalid input", type: "invalid_request_error", code: null } });
    const response = await refusingBroker(400, openai).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi" }), "responses");
    expect(await response.text()).toBe(openai);
    const plain = await refusingBroker(502, "Bad Gateway", { "content-type": "text/plain" }).handle(gatewayRequest({ model: "gpt-6-astra", input: "hi" }), "responses");
    expect([plain.status, await plain.text()]).toEqual([502, "Bad Gateway"]);
  });
});

describe("OmniRush gateway broker model catalog requests", () => {
  test("read GET <gateway>/models with the device bearer and refresh an expired one once", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const refreshCalls: string[] = [];
    const catalog = { object: "list", data: [{ id: "gpt-6-astra", default: true }] };
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1/", accessToken: "access-1", refreshToken: "refresh-1" },
      engineToken: "local-engine-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/device/refresh")) {
          refreshCalls.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
          return Response.json({ access_token: "access-2", refresh_token: "refresh-2", gateway_url: "https://gateway.example/omnirush/v1" });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        calls.push({ url, method: init?.method ?? "GET", authorization });
        return authorization === "Bearer access-2" ? Response.json(catalog) : Response.json({ detail: "invalid_token" }, { status: 401 });
      },
    });

    const response = await broker.modelCatalog();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    expect(refreshCalls).toEqual(["refresh-1"]);
    expect(calls).toEqual([
      { url: "https://gateway.example/omnirush/v1/models", method: "GET", authorization: "Bearer access-1" },
      { url: "https://gateway.example/omnirush/v1/models", method: "GET", authorization: "Bearer access-2" },
    ]);
  });

  test("answer 401 without an account", async () => {
    const response = await new OmniRushGatewayBroker({ engineToken: "local-engine-token" }).modelCatalog();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "omnirush_account_required" });
  });
});

describe("OmniRush gateway broker session upload deadline", () => {
  const gatewayUrl = "https://gateway.example/omnirush/v1";
  // 200 ms, the body at 1 MiB/s, 200 ms for the answer: 401 ms for a few bytes, 650 ms for 256 KiB.
  const sessionUploadBudget = { baseMs: 200, bytesPerSecond: 1024 * 1024, maxSendMs: 5_000, responseMs: 200 };

  /** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolvePromise, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolvePromise, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

  type Attempt = { authorization: string | null; signal: AbortSignal };

  /** The gateway accepts `access-2` only; `answer` decides how each upload attempt goes. */
  function uploadBroker(attempts: Attempt[], refreshCalls: string[], answer: (attempt: Attempt) => Promise<Response>) {
    return new OmniRushGatewayBroker({
      credentials: { gatewayUrl, accessToken: "access-1", refreshToken: "refresh-1" },
      engineToken: "local-engine-token",
      sessionUploadBudget,
      fetch: async (input, init) => {
        if (String(input).endsWith("/device/refresh")) {
          refreshCalls.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
          return Response.json({ access_token: "access-2", refresh_token: "refresh-2", gateway_url: gatewayUrl });
        }
        const attempt = { authorization: new Headers(init?.headers).get("authorization"), signal: init!.signal! };
        attempts.push(attempt);
        return answer(attempt);
      },
    });
  }

  test("ends at the deadline its body's size sets", async () => {
    const attempts: Attempt[] = [];
    const broker = uploadBroker(attempts, [], async ({ signal }) => {
      // Accepted bearer, but the answer never comes.
      await new Promise((_resolvePromise, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return Response.json({ ok: true });
    });
    const started = performance.now();
    const ended = async (bytes: number) => {
      const error = await broker.uploadSession("session-deadline-1", new Uint8Array(bytes)).catch((reason: unknown) => reason);
      return { name: (error as Error).name, afterMs: performance.now() - started };
    };
    const [small, large] = await Promise.all([ended(64), ended(256 * 1024)]);
    expect(small.name).toBe("TimeoutError");
    expect(large.name).toBe("TimeoutError");
    expect(small.afterMs).toBeGreaterThanOrEqual(401 - 20);
    expect(large.afterMs).toBeGreaterThanOrEqual(650 - 20);
    expect(small.afterMs).toBeLessThan(large.afterMs);
    expect(attempts).toHaveLength(2);
  });

  test("gives the retry with a refreshed bearer a deadline of its own", async () => {
    const attempts: Attempt[] = [];
    const refreshCalls: string[] = [];
    const broker = uploadBroker(attempts, refreshCalls, async ({ authorization, signal }) => {
      // Each try takes 250 ms of its 401: together they outlast one shared deadline.
      await sleep(250, signal);
      return authorization === "Bearer access-2"
        ? Response.json({ ok: true }, { status: 201 })
        : Response.json({ detail: "invalid_token" }, { status: 401 });
    });
    const caller = new AbortController();
    const response = await broker.uploadSession("session-deadline-2", new Uint8Array(64), caller.signal);
    expect(response.status).toBe(201);
    expect(refreshCalls).toEqual(["refresh-1"]);
    expect(attempts.map((attempt) => attempt.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(attempts[1]!.signal).not.toBe(attempts[0]!.signal);
    expect(attempts[1]!.signal.aborted).toBe(false);
  });

  test("ends at once when the caller's signal aborts, on the retry with a refreshed bearer too", async () => {
    const attempts: Attempt[] = [];
    const caller = new AbortController();
    const reason = new DOMException("The session uploader's deadline", "TimeoutError");
    const broker = uploadBroker(attempts, [], async ({ authorization, signal }) => {
      if (authorization !== "Bearer access-2") return Response.json({ detail: "invalid_token" }, { status: 401 });
      setTimeout(() => caller.abort(reason), 50);
      await sleep(10_000, signal);
      return Response.json({ ok: true }, { status: 201 });
    });
    const started = performance.now();
    const error = await broker.uploadSession("session-deadline-3", new Uint8Array(64), caller.signal).catch((cause: unknown) => cause);
    expect(error).toBe(reason);
    expect(performance.now() - started).toBeLessThan(401 - 100);
    expect(attempts.map((attempt) => attempt.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(attempts[1]!.signal.reason).toBe(reason);
  });
});

describe("OmniRush gateway broker: sub-agent model fallback", () => {
  type Reply = (body: Record<string, unknown>) => Response;
  function fallbackBroker(reply: Reply, refused: (model: string) => boolean = () => false) {
    const calls: UpstreamCall[] = [];
    const events: Array<Record<string, unknown>> = [];
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      subagentRetryDelayMs: 1,
      subagentModelRefused: refused,
      onSubagentFallback: (event) => events.push(event),
      fetch: async (_input, init) => {
        const raw = init?.body;
        const body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as Record<string, unknown>;
        calls.push({ body, headers: new Headers(init?.headers) });
        return reply(body);
      },
    });
    return { broker, calls, events };
  }
  const subagentHeaders = {
    "x-omnirush-subagent-fallback-model": "gpt-6-astra",
    "x-omnirush-subagent-fallback-effort": "max",
    "x-omnirush-subagent-root": "ses_main",
    "x-omnirush-session-id": "ses_child",
    "x-omnirush-task-id": "msg_1",
  };
  const refuse = (status: number, code: string) => Response.json({ detail: code }, { status });

  test("a picked model the gateway does not serve moves to the main model at once, with the main effort", async () => {
    const { broker, calls, events } = fallbackBroker((body) => body.model === "meta-muse-spark"
      ? refuse(400, "model_unavailable")
      : Response.json({ output: [{ type: "output_text", text: "ok" }] }));
    const response = await broker.handle(gatewayRequest(
      { model: "meta-muse-spark", input: "x", reasoning: { effort: "medium", summary: "auto" } },
      subagentHeaders,
    ), "responses");

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.body)).toEqual([
      { model: "meta-muse-spark", input: "x", reasoning: { effort: "medium", summary: "auto" } },
      { model: "gpt-6-astra", input: "x", reasoning: { summary: "auto", effort: "max" } },
    ]);
    // The private headers never leave the machine.
    for (const call of calls) {
      expect([...call.headers.keys()].filter((name) => name.startsWith("x-omnirush-subagent"))).toEqual([]);
      expect(call.headers.get("x-omnirush-session-id")).toBe("ses_child");
    }
    expect(events).toEqual([expect.objectContaining({
      sessionId: "ses_child",
      rootSessionId: "ses_main",
      messageId: "msg_1",
      requested: "meta-muse-spark",
      used: "gpt-6-astra",
      effort: "max",
      reason: "model_unavailable",
      status: 200,
      ok: true,
    })]);
  });

  test("adds the summary default when an unrelated model falls back to Astra", async () => {
    const { broker, calls } = fallbackBroker((body) => body.model === "meta-muse-spark"
      ? refuse(400, "model_unavailable")
      : Response.json({ output: [] }));
    await broker.handle(gatewayRequest({ model: "meta-muse-spark", input: "fallback" }, subagentHeaders), "responses");
    expect(calls.map((call) => call.body)).toEqual([
      { model: "meta-muse-spark", input: "fallback" },
      { model: "gpt-6-astra", input: "fallback", reasoning: { effort: "max", summary: "auto" } },
    ]);
  });

  test("a busy picked model is tried once more, then moves; a second success stays on it", async () => {
    let busy = 2;
    const stays = fallbackBroker((body) => body.model === "gpt-6-sol" && busy-- > 1
      ? refuse(429, "model_concurrency_limited")
      : Response.json({ output: [] }));
    expect((await stays.broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "a" }, subagentHeaders), "responses")).status).toBe(200);
    expect(stays.calls.map((call) => call.body.model)).toEqual(["gpt-6-sol", "gpt-6-sol"]);
    expect(stays.events).toEqual([]);

    const moves = fallbackBroker((body) => body.model === "gpt-6-sol"
      ? new Response("upstream down", { status: 503 })
      : Response.json({ output: [] }));
    expect((await moves.broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "b", reasoning_effort: "high", reasoning: { summary: "auto" } }, subagentHeaders), "responses")).status).toBe(200);
    expect(moves.calls.map((call) => call.body)).toEqual([
      { model: "gpt-6-sol", input: "b", reasoning_effort: "high", reasoning: { summary: "auto" } },
      { model: "gpt-6-sol", input: "b", reasoning_effort: "high", reasoning: { summary: "auto" } },
      { model: "gpt-6-astra", input: "b", reasoning: { effort: "max", summary: "auto" } },
    ]);
    expect(moves.events.map((event) => event.reason)).toEqual(["http_503"]);
  });

  test("account-wide refusals, other errors and requests without the header pass through untouched", async () => {
    const account = fallbackBroker(() => refuse(429, "daily_grant_exhausted"));
    const refused = await account.broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "a" }, subagentHeaders), "responses");
    expect(refused.status).toBe(429);
    expect(account.calls).toHaveLength(1);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("daily_grant_exhausted");

    const main = fallbackBroker(() => refuse(400, "model_unavailable"));
    expect((await main.broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "a" }), "responses")).status).toBe(400);
    expect(main.calls).toHaveLength(1);

    const same = fallbackBroker(() => refuse(400, "model_unavailable"));
    expect((await same.broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "a" }, subagentHeaders), "responses")).status).toBe(400);
    expect(same.calls).toHaveLength(1);
    expect(same.events).toEqual([]);
  });

  test("when the main model refuses too, its error reaches the engine readably", async () => {
    const { broker, calls, events } = fallbackBroker(() => refuse(400, "model_unavailable"));
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "a" }, subagentHeaders), "responses");
    expect(response.status).toBe(400);
    expect(calls.map((call) => call.body.model)).toEqual(["gpt-6-sol", "gpt-6-astra"]);
    expect(events.map((event) => event.ok)).toEqual([false]);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("not available");
  });

  test("a picked model in its refusal cooldown goes straight to the main model", async () => {
    const { broker, calls, events } = fallbackBroker(() => Response.json({ output: [] }), (model) => model === "gpt-6-sol");
    expect((await broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "a" }, subagentHeaders), "responses")).status).toBe(200);
    expect(calls.map((call) => call.body)).toEqual([{ model: "gpt-6-astra", input: "a", reasoning: { effort: "max", summary: "auto" } }]);
    expect(events.map((event) => [event.requested, event.used, event.reason, event.ok])).toEqual([["gpt-6-sol", "gpt-6-astra", "refused_recently", true]]);
    // Without the fallback header (the main agent, or an untouched setting) nothing moves.
    expect((await broker.handle(gatewayRequest({ model: "gpt-6-sol", input: "b" }), "responses")).status).toBe(200);
    expect(calls.at(-1)?.body.model).toBe("gpt-6-sol");
  });
});

describe("OmniRush gateway broker: connection failures never become a bare 500", () => {
  const credentials = { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" };
  const request = (body: Record<string, unknown> = { model: "muse-spark-1.1", input: "x" }) => gatewayRequest(body);

  test("a request whose connection fails before an answer is sent again, and answers when one lands", async () => {
    let calls = 0;
    const logs: string[] = [];
    const broker = new OmniRushGatewayBroker({
      credentials,
      engineToken: "local-engine-token",
      log: (_level, message) => logs.push(message),
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", message: "socket hang up" } });
        return Response.json({ output: [] });
      },
    });
    const response = await broker.handle(request(), "responses");
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(logs.filter((line) => line.includes("failed before an answer"))).toHaveLength(2);
  });

  test("a connection that keeps failing answers a retryable 503 with readable copy", async () => {
    const broker = new OmniRushGatewayBroker({
      credentials,
      engineToken: "local-engine-token",
      fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }); },
    });
    const response = await broker.handle(request(), "responses");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("gateway_unreachable");
    expect(body.error.message).toContain("could not be reached (UND_ERR_SOCKET)");
  });

  test("a refresh that cannot reach omnirush.ai keeps the session and answers every waiting request with a retryable 503", async () => {
    let refreshes = 0;
    let invalidated = false;
    const broker = new OmniRushGatewayBroker({
      credentials: { ...credentials, invalidate: async () => { invalidated = true; } },
      engineToken: "local-engine-token",
      fetch: async (input) => {
        if (String(input).endsWith("/device/refresh")) {
          refreshes += 1;
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () => broker.handle(request(), "responses")));
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503, 503, 503]);
    expect(((await responses[0]!.json()) as { error: { code: string } }).error.code).toBe("device_refresh_unavailable");
    expect(refreshes).toBe(1);
    expect(invalidated).toBe(false);
    expect(broker.enabled).toBe(true);
  });

  test("an upstream stream that fails mid-way ends with the readable interrupted event", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
          return;
        }
        controller.error(new TypeError("terminated"));
      },
    });
    const text = await new Response(guardEventStream(body)).text();
    expect(text).toContain("response.created");
    expect(text).toContain("upstream_stream_interrupted");
  });
});
