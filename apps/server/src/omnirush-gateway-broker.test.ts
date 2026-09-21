import { describe, expect, test } from "bun:test";

import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import type { OmniRushGatewayCredentials } from "./types.js";

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
});

