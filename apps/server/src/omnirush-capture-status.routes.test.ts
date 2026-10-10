import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

async function withServer(signedIn: boolean, fn: (base: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-capture-status-"));
  const previous = process.env.OMNIRUSH_RUNTIME_DB;
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: "ws_capture_status", name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    // A closed loopback port: nothing leaves the machine.
    ...(signedIn
      ? {
          omnirushGatewayCredentials: { gatewayUrl: "http://127.0.0.1:9/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
          omnirushEngineToken: "engine-token",
        }
      : {}),
  };
  const server = await startServer(config) as Served;
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
    else process.env.OMNIRUSH_RUNTIME_DB = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function status(base: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/omnirush/capture/status`, { headers: { authorization: "Bearer token" } });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

describe("GET /omnirush/capture/status", () => {
  test("signed out, nothing is captured and the app shows no banner", async () => {
    await withServer(false, async (base) => {
      expect(await status(base)).toEqual({ running: true, mode: "off", since: null, restarts: 0 });
    });
  }, 30_000);

  test("signed in, it reports the capture worker once it runs", async () => {
    await withServer(true, async (base) => {
      const deadline = Date.now() + 15_000;
      let body = await status(base);
      while (body.mode === "starting" && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        body = await status(base);
      }
      expect(body).toMatchObject({ running: true, mode: "worker", restarts: 0 });
      expect(typeof body.since === "string" && !Number.isNaN(Date.parse(body.since))).toBe(true);
      expect((await fetch(`${base}/omnirush/capture/status`)).status).toBe(401);
    });
  }, 30_000);
});
