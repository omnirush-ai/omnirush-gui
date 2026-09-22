import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OmniRushGatewayBroker, guardEventStream } from "./omnirush-gateway-broker.js";
import { OmniRushReasoningEffort } from "./opencode-plugins/omnirush-reasoning-effort.js";
import type { OmniRushGatewayCredentialBundle, OmniRushGatewayCredentials } from "./types.js";

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
    const persisted: Array<Omit<OmniRushGatewayCredentials, "persist">> = [];
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
        persist: async (credentials) => { persisted.push(credentials); },
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
    await Bun.sleep(1);
    expect(persisted.at(-1)?.refreshToken).toBe("new-refresh");
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
    expect(calls[0]?.body).toEqual({ model: "gpt-6-astra", input: "test", reasoning: { effort: "max" } });
    expect(calls[0]?.headers.has("x-omnirush-reasoning-effort")).toBe(false);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-token");
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
      { model: "gpt-6-astra", input: "c" },
      { model: "gpt-6-astra", input: "d" },
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

describe("OmniRush gateway broker credential adoption", () => {
  const gatewayUrl = "https://gateway.example/omnirush/v1";
  /** The pair after n-1 rotations of one device session. */
  const bundle = (n: number) => ({ gatewayUrl, accessToken: `access-${n}`, refreshToken: `refresh-${n}`, rotation: n - 1 });

  /** Upstream accepts only `validAccess`; the refresh endpoint retires `deadRefresh` and rotates anything else to 3. */
  function rotatingFetcher(validAccess: string, deadRefresh: string, refreshCalls: string[]) {
    return async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/device/refresh")) {
        const body = JSON.parse(String(init?.body)) as { refresh_token: string };
        refreshCalls.push(body.refresh_token);
        return body.refresh_token === deadRefresh
          ? Response.json({ detail: "refresh_token_invalid_or_expired" }, { status: 401 })
          : Response.json({ access_token: "access-3", refresh_token: "refresh-3", gateway_url: gatewayUrl });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === `Bearer ${validAccess}`
        ? Response.json({ output: [] })
        : Response.json({ error: "expired" }, { status: 401 });
    };
  }

  function adoptingBroker(latest: () => Promise<ReturnType<typeof bundle> | null>, refreshCalls: string[], onInvalidate: () => void) {
    return new OmniRushGatewayBroker({
      credentials: { ...bundle(1), latest, invalidate: async () => onInvalidate() },
      engineToken: "local-engine-token",
      fetch: rotatingFetcher("access-2", "refresh-1", refreshCalls),
    });
  }

  test("adopts credentials the desktop rotated instead of signing the device out", async () => {
    const refreshCalls: string[] = [];
    let invalidated = 0;
    const broker = adoptingBroker(async () => bundle(2), refreshCalls, () => { invalidated += 1; });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(200);
    expect(refreshCalls).toEqual([]);
    expect(invalidated).toBe(0);
    // A later refresh spends the adopted token, not the retired one.
    expect(await broker.refreshAccessToken()).toBe("access-3");
    expect(refreshCalls).toEqual(["refresh-2"]);
  });

  test("adopts a rotation that landed while its own refresh was in flight", async () => {
    const refreshCalls: string[] = [];
    let invalidated = 0;
    let reads = 0;
    const broker = adoptingBroker(async () => (reads++ === 0 ? bundle(1) : bundle(2)), refreshCalls, () => { invalidated += 1; });
    const response = await broker.collect("session-1234", new Uint8Array([1, 2, 3]));
    expect(response.status).toBe(200);
    expect(refreshCalls).toEqual(["refresh-1"]);
    expect(invalidated).toBe(0);
  });

  test("still signs the device out when the store agrees the session is gone", async () => {
    const refreshCalls: string[] = [];
    let invalidated = 0;
    const broker = adoptingBroker(async () => bundle(1), refreshCalls, () => { invalidated += 1; });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("omnirush_account_required");
    expect(refreshCalls).toEqual(["refresh-1"]);
    await Bun.sleep(1);
    expect(invalidated).toBe(1);
  });

  test("keeps its own pair when the store still holds the one it rotated away from", async () => {
    // The broker rotated 1 -> 2 but its persist failed, so the store is behind, not ahead.
    const refreshCalls: string[] = [];
    let invalidated = 0;
    const broker = new OmniRushGatewayBroker({
      credentials: { ...bundle(2), latest: async () => bundle(1), invalidate: async () => { invalidated += 1; } },
      engineToken: "local-engine-token",
      fetch: rotatingFetcher("access-3", "refresh-1", refreshCalls),
    });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(200);
    expect(refreshCalls).toEqual(["refresh-2"]);
    expect(invalidated).toBe(0);
  });

  test("never signs out on a contended refresh (409) and adopts the rotation that won it", async () => {
    const refreshCalls: string[] = [];
    let invalidated = 0;
    let stored = bundle(1);
    const broker = new OmniRushGatewayBroker({
      credentials: { ...bundle(1), latest: async () => stored, invalidate: async () => { invalidated += 1; } },
      engineToken: "local-engine-token",
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/device/refresh")) {
          refreshCalls.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
          return Response.json({ detail: "refresh_token_already_used" }, { status: 409 });
        }
        return new Headers(init?.headers).get("authorization") === "Bearer access-2"
          ? Response.json({ output: [] })
          : Response.json({ error: "expired" }, { status: 401 });
      },
    });
    // Nothing has landed in the store yet: the request fails without a sign-out.
    const contended = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(contended.status).toBe(401);
    expect(await contended.text()).not.toContain("omnirush_account_required");
    expect(refreshCalls).toEqual(["refresh-1"]);
    expect(invalidated).toBe(0);
    // The other holder's rotation lands; the next request adopts it without spending anything.
    stored = bundle(2);
    const adopted = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(adopted.status).toBe(200);
    expect(refreshCalls).toEqual(["refresh-1"]);
    expect(invalidated).toBe(0);
  });

  test("falls back to the pair it held before adopting when the adopted pair is dead too", async () => {
    const refreshCalls: string[] = [];
    let invalidated = 0;
    // The store claims a newer pair the server does not know; the broker's own still rotates.
    const broker = new OmniRushGatewayBroker({
      credentials: { ...bundle(1), latest: async () => bundle(2), invalidate: async () => { invalidated += 1; } },
      engineToken: "local-engine-token",
      fetch: rotatingFetcher("access-3", "refresh-2", refreshCalls),
    });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(200);
    expect(refreshCalls).toEqual(["refresh-2", "refresh-1"]);
    expect(invalidated).toBe(0);
  });

  test("signs out promptly when the adopted pair and its own are both dead", async () => {
    const refreshCalls: string[] = [];
    let invalidated = 0;
    const broker = new OmniRushGatewayBroker({
      credentials: { ...bundle(1), latest: async () => bundle(2), invalidate: async () => { invalidated += 1; } },
      engineToken: "local-engine-token",
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/device/refresh")) {
          refreshCalls.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token);
          return Response.json({ detail: "refresh_token_invalid_or_expired" }, { status: 401 });
        }
        return Response.json({ error: "expired" }, { status: 401 });
      },
    });
    const response = await broker.handle(gatewayRequest({ model: "gpt-6-astra", input: "test" }), "responses");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("omnirush_account_required");
    expect(refreshCalls).toEqual(["refresh-2", "refresh-1"]);
    await Bun.sleep(1);
    expect(invalidated).toBe(1);
  });
});

/**
 * The embedded broker and the desktop account store share one device
 * session: whichever holder gets a 401 first rotates the refresh token, and
 * the server retires the token it spent. These run the real store against
 * the real broker, wired as apps/desktop/electron/runtime.mjs wires them.
 */
describe("OmniRush gateway broker sharing a device session with the desktop account store", () => {
  const gatewayUrl = "https://gateway.example/omnirush/v1";
  type StoredBundle = OmniRushGatewayCredentialBundle & { rotation: number };
  type AccountStore = {
    load: () => Promise<StoredBundle | null>;
    save: (credentials: OmniRushGatewayCredentialBundle) => Promise<void>;
    status: () => Promise<{ connected: boolean; reauthorizationRequired?: boolean; email?: string | null }>;
    clear: (options?: { revokeRemote?: boolean }) => Promise<unknown>;
  };
  type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  /** The account server: one live pair per session; a rotation retires the refresh token it spent. */
  function accountServer() {
    const server = {
      access: "access-1",
      refresh: "refresh-1",
      generation: 1,
      expired: new Set<string>(),
      refreshCalls: [] as string[],
      holdProfile: null as Promise<void> | null,
      contendNext: false,
      onRotate: () => {},
    };
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      const bearer = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      if (url.pathname.endsWith("/device/me")) {
        if (server.holdProfile) await server.holdProfile;
        return bearer === server.access && !server.expired.has(bearer)
          ? Response.json({ email: "person@example.com", status: "active" })
          : Response.json({ detail: "device_token_invalid" }, { status: 401 });
      }
      if (url.pathname.endsWith("/device/refresh")) {
        const { refresh_token: token } = JSON.parse(String(init?.body)) as { refresh_token: string };
        server.refreshCalls.push(token);
        if (server.contendNext) {
          server.contendNext = false;
          return Response.json({ detail: "refresh_token_already_used" }, { status: 409 });
        }
        if (token !== server.refresh) return Response.json({ detail: "refresh_token_invalid_or_expired" }, { status: 401 });
        server.generation += 1;
        server.access = `access-${server.generation}`;
        server.refresh = `refresh-${server.generation}`;
        server.onRotate();
        return Response.json({ access_token: server.access, refresh_token: server.refresh, gateway_url: gatewayUrl });
      }
      return bearer === server.access && !server.expired.has(bearer)
        ? Response.json({ output: [] })
        : Response.json({ error: "expired" }, { status: 401 });
    };
    return { server, fetcher };
  }

  const storeModule = fileURLToPath(new URL("../../desktop/electron/omnirush-account.mjs", import.meta.url));

  async function desktopStore(fetcher: Fetcher, options: { encryptDelayMs?: number; saveFails?: { value: boolean } } = {}): Promise<AccountStore> {
    const { createDesktopOmniRushAccountStore } = await import(storeModule) as {
      createDesktopOmniRushAccountStore: (options: Record<string, unknown>) => AccountStore;
    };
    const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-shared-session-"));
    const storage = {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptStringAsync: async (value: string) => {
        if (options.encryptDelayMs) await Bun.sleep(options.encryptDelayMs);
        if (options.saveFails?.value) throw new Error("secure storage unavailable");
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
        persist: (rotated) => store.save(rotated),
        invalidate: () => store.clear({ revokeRemote: false }).then(() => undefined),
        latest: () => store.load(),
      },
      engineToken: "local-engine-token",
      fetch: fetcher,
    });
  }

  const prompt = () => gatewayRequest({ model: "gpt-6-astra", input: "test" });

  test("the desktop keeps the session the broker rotated while its profile check was in flight", async () => {
    const { server, fetcher } = accountServer();
    const store = await desktopStore(fetcher);
    const broker = await brokerFor(store, fetcher);
    server.expired.add("access-1");
    let releaseProfile = () => {};
    server.holdProfile = new Promise<void>((resolve) => { releaseProfile = resolve; });
    const status = store.status(); // GET /device/me with the expired token is now in flight
    await Bun.sleep(5);
    expect((await broker.handle(prompt(), "responses")).status).toBe(200); // rotates 1 -> 2 and persists
    await Bun.sleep(5);
    expect((await store.load())?.refreshToken).toBe("refresh-2");
    server.holdProfile = null;
    releaseProfile();
    const result = await status; // 401: the closure's refresh-1 is retired; the store's refresh-2 is used instead
    expect(result.connected).toBe(true);
    expect(result.email).toBe("person@example.com");
    expect(result.reauthorizationRequired).toBeUndefined();
    expect(server.refreshCalls).toEqual(["refresh-1"]);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-2", rotation: 1 });
  });

  test("the broker adopts the desktop's rotation while its save is still landing", async () => {
    const { server, fetcher } = accountServer();
    const store = await desktopStore(fetcher, { encryptDelayMs: 30 });
    const broker = await brokerFor(store, fetcher);
    server.expired.add("access-1");
    const rotated = new Promise<void>((resolve) => { server.onRotate = resolve; });
    const status = store.status(); // 401 -> refresh -> (access-2, refresh-2) -> slow save()
    await rotated;
    const response = await broker.handle(prompt(), "responses"); // its own refresh-1 is retired by now
    expect(response.status).toBe(200);
    expect(server.refreshCalls).toEqual(["refresh-1"]);
    expect((await status).connected).toBe(true);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-2", rotation: 1 });
  });

  test("the broker spends its own valid pair when its persist failed and the store is behind", async () => {
    const { server, fetcher } = accountServer();
    const saveFails = { value: false };
    const store = await desktopStore(fetcher, { saveFails });
    const broker = await brokerFor(store, fetcher);
    saveFails.value = true; // secure storage is unavailable from now on
    server.expired.add("access-1");
    expect((await broker.handle(prompt(), "responses")).status).toBe(200); // 1 -> 2 in memory only
    await Bun.sleep(5);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1", rotation: 0 });
    server.expired.add("access-2"); // an hour later
    expect((await broker.handle(prompt(), "responses")).status).toBe(200); // spends refresh-2, not the store's retired refresh-1
    expect((await broker.handle(prompt(), "responses")).status).toBe(200);
    expect(server.refreshCalls).toEqual(["refresh-1", "refresh-2"]);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1" });
    // Once storage is back, the next rotation catches the store up.
    saveFails.value = false;
    server.expired.add("access-3");
    expect((await broker.handle(prompt(), "responses")).status).toBe(200);
    await Bun.sleep(5);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-4", rotation: 3 });
  });

  test("a contended refresh (409) never signs the device out; the next request adopts the rotation that won", async () => {
    const { server, fetcher } = accountServer();
    const store = await desktopStore(fetcher);
    const broker = await brokerFor(store, fetcher);
    server.expired.add("access-1");
    server.contendNext = true;
    const contended = await broker.handle(prompt(), "responses");
    expect(contended.status).toBe(401);
    expect(await contended.text()).not.toContain("omnirush_account_required");
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1" });
    // The desktop's rotation lands in the store...
    expect((await store.status()).connected).toBe(true);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-2", rotation: 1 });
    // ...and the broker adopts it without spending anything.
    expect((await broker.handle(prompt(), "responses")).status).toBe(200);
    expect(server.refreshCalls).toEqual(["refresh-1", "refresh-1"]);
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
    expect((await store.status()).connected).toBe(false);
  });
});
