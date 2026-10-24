import { describe, expect, test } from "bun:test";
import type { Session } from "@opencode-ai/sdk/v2/client";

import { createClient, createPromptMessageID, isSendStopped, setSandboxSetupHold } from "../src/app/lib/opencode";
import { interruptSessionTurn, sessionNeedsStop, submitAfterInterruption } from "../src/app/lib/opencode-interruption";

const baseUrl = "https://worker.example/workspace/ws-held/opencode";
const root = { id: "ses_held_stop", projectID: "p", directory: "/workspace/held", title: "t", version: "1", time: { created: 1, updated: 2 } } as Session;

describe("a send held for the sandbox setup", () => {
  test("Stop releases it at once, and the prompt never reaches the engine, even once the box is ready", async () => {
    const boxReady = Promise.withResolvers<void>();
    const engineCalls: string[] = [];
    let held: Request | null = null;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/prompt_async")) {
          // The local server holds the prompt until the box is ready, unless the request is given up first.
          held = request;
          return new Promise<Response>((resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            void boxReady.promise.then(() => {
              if (request.signal.aborted) return;
              engineCalls.push(path);
              resolve(new Response(null, { status: 204 }));
            });
          });
        }
        if (path.endsWith(`/session/${root.id}`)) return Promise.resolve(Response.json(root));
        if (path.endsWith("/message")) return Promise.resolve(Response.json([]));
        if (path.endsWith("/abort")) return Promise.resolve(Response.json(true));
        if (path.endsWith("/status")) return Promise.resolve(Response.json({}));
        return Promise.reject(new Error(`Unexpected request: ${request.method} ${path}`));
      },
    });
    setSandboxSetupHold("ws-held", true);
    try {
      const client = createClient(baseUrl, root.directory);
      const messageID = createPromptMessageID();
      const send = submitAfterInterruption(baseUrl, root.id, () => client.session.promptAsync({
        sessionID: root.id, directory: root.directory, messageID, parts: [{ type: "text", text: "hi" }],
      } as never), messageID);
      const sent = send.then(() => null, (error: unknown) => error);
      for (let i = 0; i < 50 && !held; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(held).not.toBeNull();

      const started = Date.now();
      await interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 15_000 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(isSendStopped(await sent)).toBe(true);
      expect(held!.signal.aborted).toBe(true);
      expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);

      boxReady.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(engineCalls).toEqual([]);
    } finally {
      setSandboxSetupHold("ws-held", false);
      globalThis.fetch = originalFetch;
    }
  });
});
