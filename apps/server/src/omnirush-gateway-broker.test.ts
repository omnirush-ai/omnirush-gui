import { describe, expect, test } from "bun:test";

import { OmniRushGatewayBroker, guardEventStream } from "./omnirush-gateway-broker.js";
import { OmniRushReasoningEffort } from "./opencode-plugins/omnirush-reasoning-effort.js";
import type { OmniRushGatewayCredentials } from "./types.js";

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
