import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { proxyOpencodeRequest, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

/**
 * Server-level collector behaviour: every session on every provider is
 * captured the same way (start / trace / end, prompt and turn triggers,
 * subagents), the sign-in gate refuses uncollected local sessions, and the
 * browser, attachment and artifact events are redacted and capped.
 */

const execFileAsync = promisify(execFile);

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

type Envelope = Record<string, unknown> & {
  snapshot_type: string;
  trigger: string;
  session_segment: number;
  session_resumed: boolean;
  session: { provider_id: string | null; model_id: string | null; variant: string | null; child_session_ids: string[] };
  environment: Record<string, unknown>;
  files: Array<{ path: string; content: string }>;
  trace?: Array<{ type: string; data?: Record<string, unknown> }>;
};

type Upload = { sessionId: string | null; envelope: Envelope };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const sha256 = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args]);
}

async function createWorkspace(): Promise<{ root: string; stateDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "omnirush-collector-server-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const stateDir = join(base, "state");
  await mkdir(join(root, ".opencode"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(root, "app.txt"), "hello\n");
  await git(root, "init", "-q");
  await git(root, "add", "app.txt");
  await git(root, "commit", "-q", "-m", "init");
  return { root, stateDir };
}

type EngineMessage = { info: Record<string, unknown>; parts: unknown[] };

/**
 * A fake engine with one root session and a two-level subagent tree. Each
 * prompt is a turn: the root gains a user + assistant message, the child gains
 * a message on turns 1 and 2, the grandchild on turns 1 and 3.
 */
function startMockEngine(input: { provider: string; model: string }) {
  let turn = 0;
  let busy = false;
  const root: EngineMessage[] = [];
  const child: EngineMessage[] = [];
  const grandchild: EngineMessage[] = [];
  const prompts: unknown[] = [];
  const received: string[] = [];
  const message = (session: string, id: string, role: "user" | "assistant", text: string): EngineMessage => ({
    info: {
      id,
      sessionID: session,
      role,
      time: role === "assistant" ? { created: turn, completed: turn + 1 } : { created: turn },
      ...(role === "assistant" ? { providerID: input.provider, modelID: input.model, mode: "build" } : { model: { providerID: input.provider, modelID: input.model }, variant: "high", agent: "build" }),
    },
    parts: [{ id: `${id}_part`, messageID: id, sessionID: session, type: "text", text }],
  });
  const session = (id: string, parentID?: string) => ({
    id,
    projectID: "proj",
    directory: "",
    title: parentID ? `Subtask ${id}` : "Root task",
    version: "1",
    time: { created: 1, updated: 2 },
    ...(parentID ? { parentID } : {}),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      received.push(`${request.method} ${url.pathname}`);
      // The real engine's router (Hono) decodes unreserved escapes before
      // matching, so "/session/ses_root/prompt%5Fasync" is a prompt dispatch.
      const pathname = decodeURI(url.pathname);
      if (pathname === "/session/status") return Response.json(busy ? { ses_root: { type: "busy" } } : {});
      if (["/permission", "/question"].includes(pathname)) return Response.json([]);
      if (pathname === "/session/ses_root/prompt_async" && request.method === "POST") {
        prompts.push(await request.json().catch(() => null));
        turn += 1;
        busy = true;
        root.push(message("ses_root", `user_${turn}`, "user", `prompt ${turn}`), message("ses_root", `assistant_${turn}`, "assistant", `answer ${turn}`));
        if (turn === 1 || turn === 2) child.push(message("ses_child", `child_${turn}`, "assistant", `child answer ${turn} for jane@example.com`));
        if (turn === 1 || turn === 3) grandchild.push(message("ses_grandchild", `grand_${turn}`, "assistant", `grandchild answer ${turn}`));
        setTimeout(() => { busy = false; }, 50);
        return new Response(null, { status: 204 });
      }
      if (pathname === "/session" && request.method === "GET") return Response.json([session("ses_root")]);
      if (pathname === "/session/ses_root") return Response.json(session("ses_root"));
      if (pathname === "/session/ses_root/message") return Response.json(root);
      if (pathname === "/session/ses_root/children") return Response.json([session("ses_child", "ses_root")]);
      if (pathname === "/session/ses_child/message") return Response.json(child);
      if (pathname === "/session/ses_child/children") return Response.json([session("ses_grandchild", "ses_child")]);
      if (pathname === "/session/ses_grandchild/message") return Response.json(grandchild);
      if (pathname === "/session/ses_grandchild/children") return Response.json([]);
      if (pathname === "/session/ses_root/todo") return Response.json([]);
      return Response.json({ code: "not_found", message: `Not found: ${request.method} ${pathname}` }, { status: 404 });
    },
  }) as Served;
  cleanups.push(() => server.stop(true));
  return { server, prompts, received, baseUrl: `http://127.0.0.1:${server.port}` };
}

/** The omnirush.ai collector endpoint, recording every decompressed envelope. */
function startMockGateway() {
  const uploads: Upload[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/omnirush/collect" && request.method === "POST") {
        if (request.headers.get("authorization") !== "Bearer access-token") return Response.json({ detail: "unauthorized" }, { status: 401 });
        const compressed = Buffer.from(await request.arrayBuffer());
        uploads.push({
          sessionId: request.headers.get("x-omnirush-session-id"),
          envelope: JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope,
        });
        return Response.json({ ok: true }, { status: 201 });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    },
  }) as Served;
  cleanups.push(() => server.stop(true));
  return { uploads, gatewayUrl: `http://127.0.0.1:${server.port}/omnirush/v1` };
}

function serverConfig(input: { root: string; stateDir: string; engineBaseUrl: string; gatewayUrl?: string; appVersion?: string }): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    configPath: join(input.stateDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: input.root, preset: "starter", workspaceType: "local", baseUrl: input.engineBaseUrl }],
    authorizedRoots: [input.root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "json",
    logRequests: false,
    ...(input.gatewayUrl
      ? {
          omnirushGatewayCredentials: { gatewayUrl: input.gatewayUrl, accessToken: "access-token", refreshToken: "refresh-token" },
          omnirushEngineToken: "engine-token",
        }
      : {}),
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
  };
}

async function startOmniRush(config: ServerConfig) {
  const server = await startServer(config) as Served;
  const stop = async () => { await server.stop(true); };
  cleanups.push(stop);
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      const index = cleanups.indexOf(stop);
      if (index >= 0) cleanups.splice(index, 1);
      await stop();
    },
  };
}

function prompt(base: string, body: unknown = { parts: [{ type: "text", text: "Do the task" }] }) {
  return fetch(`${base}/workspace/ws_1/opencode/session/ses_root/prompt_async`, {
    method: "POST",
    headers: { Authorization: "Bearer owt_test_token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for collector uploads");
}

function traces(uploads: Upload[]): Envelope[] {
  return uploads.filter((upload) => upload.envelope.snapshot_type === "trace").map((upload) => upload.envelope);
}

function events(envelope: Envelope | undefined): Array<{ type: string; data?: Record<string, unknown> }> {
  return envelope?.trace ?? [];
}

function setGateEnv(devMode: string | undefined, optional: string | undefined) {
  if (devMode === undefined) delete process.env.OMNIRUSH_DEV_MODE;
  else process.env.OMNIRUSH_DEV_MODE = devMode;
  if (optional === undefined) delete process.env.OMNIRUSH_COLLECTION_OPTIONAL;
  else process.env.OMNIRUSH_COLLECTION_OPTIONAL = optional;
}

/** Restores the process environment after the test, whatever the test set. */
function preserveGateEnv() {
  const previous = { devMode: process.env.OMNIRUSH_DEV_MODE, optional: process.env.OMNIRUSH_COLLECTION_OPTIONAL };
  cleanups.push(() => setGateEnv(previous.devMode, previous.optional));
}

/** One full turn on the given provider; returns the uploads once its trace landed. */
async function runTurn(provider: { provider: string; model: string }) {
  const { root, stateDir } = await createWorkspace();
  const engine = startMockEngine(provider);
  const gateway = startMockGateway();
  const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl, appVersion: "2.3.4" }));
  const response = await prompt(omnirush.base);
  expect(response.status).toBe(204);
  await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
  await omnirush.stop();
  return { uploads: gateway.uploads, engine, gateway, root, stateDir };
}

function shape(uploads: Upload[]) {
  return uploads.map((upload) => ({
    sessionId: upload.sessionId,
    keys: Object.keys(upload.envelope).sort(),
    snapshot: [upload.envelope.snapshot_type, upload.envelope.trigger],
    events: events(upload.envelope).map((event) => event.type),
    sessionKeys: Object.keys(upload.envelope.session).sort(),
  }));
}

describe("workspace collector server integration", () => {
  test("captures an external-provider session exactly like an omnirush.ai session, subagents included", async () => {
    const anthropic = await runTurn({ provider: "anthropic", model: "claude-sonnet-4-5" });
    const omnirush = await runTurn({ provider: "omnirush", model: "gpt-5.6-sol" });

    expect(shape(anthropic.uploads)).toEqual(shape(omnirush.uploads));
    for (const run of [anthropic, omnirush]) {
      expect(run.uploads.map((upload) => [upload.envelope.snapshot_type, upload.envelope.trigger])).toEqual([
        ["start", "session_start"],
        ["trace", "trace_flush"],
        ["end", "session_end"],
      ]);
      expect(run.uploads.every((upload) => upload.sessionId === "ses_root")).toBe(true);
      expect(run.uploads[0]?.envelope.environment.app_version).toBe("2.3.4");
      expect(run.uploads[0]?.envelope.session).toEqual({ provider_id: null, model_id: null, variant: null, child_session_ids: [] });
    }
    const trace = traces(anthropic.uploads)[0]!;
    const types = events(trace).map((event) => event.type);
    for (const type of ["engine.request", "engine.response", "collector.trigger", "session.model", "session.child", "session.idle", "turn.completed"]) {
      expect(types).toContain(type);
    }
    expect(events(trace).find((event) => event.type === "session.model")?.data).toEqual({
      provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", agent: "build",
    });
    expect(events(traces(omnirush.uploads)[0]).find((event) => event.type === "session.model")?.data).toEqual({
      provider_id: "omnirush", model_id: "gpt-5.6-sol", variant: "high", agent: "build",
    });
    const children = events(trace).filter((event) => event.type === "session.child");
    expect(children.map((event) => [event.data?.child_session_id, event.data?.parent_session_id, event.data?.title, event.data?.agent])).toEqual([
      ["ses_child", "ses_root", "Subtask ses_child", "build"],
      ["ses_grandchild", "ses_child", "Subtask ses_grandchild", "build"],
    ]);
    expect((children[0]?.data?.messages as unknown[]).length).toBe(1);
    expect(JSON.stringify(children)).not.toContain("jane@example.com");
    expect(trace.session).toEqual({ provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", child_session_ids: ["ses_child", "ses_grandchild"] });
    const end = anthropic.uploads.at(-1)!.envelope;
    expect(end.session.child_session_ids).toEqual(["ses_child", "ses_grandchild"]);
    expect(end.session.provider_id).toBe("anthropic");
    // The prompt and turn milestones are both recorded even though nothing changed.
    expect(events(trace).filter((event) => event.type === "collector.trigger").map((event) => event.data)).toEqual([
      { trigger: "prompt", captured: false },
      { trigger: "turn_completed", captured: false },
    ]);
  }, 90_000);

  test("uploads only new child messages per turn and resumes child checkpoints after a restart", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine({ provider: "openai", model: "gpt-5" });
    const gateway = startMockGateway();
    const config = serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl });
    const first = await startOmniRush(config);
    expect((await prompt(first.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    expect((await prompt(first.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 2 ? true : undefined));
    await first.stop();

    const [turnOne, turnTwo] = traces(gateway.uploads);
    const childEvents = (envelope: Envelope | undefined) => events(envelope)
      .filter((event) => event.type === "session.child")
      .map((event) => [event.data?.child_session_id, (event.data?.messages as Array<{ info: { id: string } }>).map((message) => message.info.id)]);
    expect(childEvents(turnOne)).toEqual([["ses_child", ["child_1"]], ["ses_grandchild", ["grand_1"]]]);
    // Turn 2: only the child spoke again, and only its new message is uploaded.
    expect(childEvents(turnTwo)).toEqual([["ses_child", ["child_2"]]]);
    expect(events(turnTwo).find((event) => event.type === "turn.completed")?.data).toEqual({
      messages: expect.arrayContaining([expect.objectContaining({ info: expect.objectContaining({ id: "assistant_2" }) })]),
    });
    expect((events(turnTwo).find((event) => event.type === "turn.completed")?.data?.messages as unknown[]).length).toBe(2);

    // Restart: the ledger carries the root and per-child checkpoints forward.
    const second = await startOmniRush({ ...config, startedAt: Date.now() });
    expect((await prompt(second.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 3 ? true : undefined));
    await second.stop();
    const resumedStart = gateway.uploads.find((upload) => upload.envelope.snapshot_type === "start" && upload.envelope.session_segment === 2)!;
    expect(resumedStart.envelope.session_resumed).toBe(true);
    expect(resumedStart.envelope.session).toEqual({ provider_id: "openai", model_id: "gpt-5", variant: "high", child_session_ids: ["ses_child", "ses_grandchild"] });
    const turnThree = traces(gateway.uploads)[2]!;
    expect(turnThree.session_resumed).toBe(true);
    expect(childEvents(turnThree)).toEqual([["ses_grandchild", ["grand_3"]]]);
    expect((events(turnThree).find((event) => event.type === "turn.completed")?.data?.messages as unknown[]).length).toBe(2);
    expect(events(turnThree).map((event) => event.type)).toContain("session.resumed");
  }, 90_000);

  test("refuses prompt dispatch on a local workspace without an account, unless both development flags are set", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine({ provider: "anthropic", model: "claude-sonnet-4-5" });
    const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl }));

    preserveGateEnv();
    setGateEnv(undefined, undefined);
    // The engine's router decodes the path before matching it, so every
    // encoded spelling of a dispatch route is refused like the plain one.
    const dispatchPaths = [
      "session/ses_root/prompt_async", "session/ses_root/prompt", "session/ses_root/command",
      "session/ses_root/prompt%5Fasync", "session/ses_root/promp%74", "session/ses_root/comman%64",
      "sessio%6E/ses_root/prompt_async", "session/ses%5Froot/prompt_async", "%73ession/ses_root/%70rompt_async/",
    ];
    for (const path of dispatchPaths) {
      const response = await fetch(`${omnirush.base}/workspace/ws_1/opencode/${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer owt_test_token", "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "Do the task" }] }),
      });
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toEqual({
        error: "omnirush_account_required",
        message: "Sign in to omnirush.ai from Settings to start a session.",
      });
    }
    expect(engine.prompts).toHaveLength(0);
    expect(engine.received.filter((entry) => entry.startsWith("POST"))).toEqual([]);
    // Reads and non-dispatch writes are not gated.
    const list = await fetch(`${omnirush.base}/workspace/ws_1/opencode/session`, { headers: { Authorization: "Bearer owt_test_token" } });
    expect(list.status).toBe(200);

    // One flag alone is not a bypass.
    setGateEnv("1", undefined);
    expect((await prompt(omnirush.base)).status).toBe(403);
    setGateEnv(undefined, "1");
    expect((await prompt(omnirush.base)).status).toBe(403);
    expect(engine.prompts).toHaveLength(0);

    setGateEnv("1", "1");
    expect((await prompt(omnirush.base)).status).toBe(204);
    expect(engine.prompts).toHaveLength(1);
  }, 30_000);

  test("collects a dispatch sent through an encoded path exactly like a plain one, and refuses a malformed session id", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine({ provider: "anthropic", model: "claude-sonnet-4-5" });
    const gateway = startMockGateway();
    const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl }));
    const send = (path: string) => fetch(`${omnirush.base}/workspace/ws_1/opencode/${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer owt_test_token", "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "Do the task" }] }),
    });

    const encoded = await send("sessio%6E/ses%5Froot/prompt%5Fasync");
    expect(encoded.status).toBe(204);
    // Forwarded verbatim: the engine decodes the path itself.
    expect(engine.received).toContain("POST /sessio%6E/ses%5Froot/prompt%5Fasync");
    expect(engine.prompts).toHaveLength(1);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    const trace = traces(gateway.uploads)[0]!;
    expect(gateway.uploads.every((upload) => upload.sessionId === "ses_root")).toBe(true);
    expect(events(trace).find((event) => event.type === "engine.request")?.data).toMatchObject({ method: "POST", path: "/session/ses_root/prompt_async" });
    expect(events(trace).filter((event) => event.type === "collector.trigger").map((event) => event.data?.trigger)).toEqual(["prompt", "turn_completed"]);
    expect(events(trace).map((event) => event.type)).toContain("session.model");

    // A dispatch whose session identifier the engine cannot decode is never
    // started uncollected: the route refuses it before it reaches the engine.
    const malformed = await send("session/ses%E0/prompt_async");
    expect(malformed.ok).toBe(false);
    expect(engine.prompts).toHaveLength(1);
    expect(engine.received.filter((entry) => entry.startsWith("POST"))).toEqual(["POST /sessio%6E/ses%5Froot/prompt%5Fasync"]);
    await omnirush.stop();
  }, 60_000);

  test("the proxy itself refuses a dispatch with a session identifier the engine cannot decode", async () => {
    // Even with the development bypass, a dispatch is either refused or
    // collected: an identifier the engine would not read as the client meant
    // is rejected before the request is forwarded.
    preserveGateEnv();
    setGateEnv("1", "1");
    const { root, stateDir } = await createWorkspace();
    const config = serverConfig({ root, stateDir, engineBaseUrl: "http://127.0.0.1:9" });
    const url = new URL("http://omnirush.invalid/workspace/ws_1/opencode/session/ses%E0/prompt_async");
    const response = await proxyOpencodeRequest({
      config,
      workspace: config.workspaces[0]!,
      proxyPath: "/opencode/session/ses%E0/prompt_async",
      url,
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [] }) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_session_id", message: "The session identifier is not valid." });
  });

  test("records redacted, capped browser visits, attachments and artifacts for the owning session", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine({ provider: "anthropic", model: "claude-sonnet-4-5" });
    const gateway = startMockGateway();
    const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl }));

    const noteText = `OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n${"attachment text ".repeat(20_000)}`;
    const noteUrl = `data:text/plain;base64,${Buffer.from(noteText).toString("base64")}`;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const response = await prompt(omnirush.base, {
      parts: [
        { type: "text", text: "Summarise the note" },
        { type: "file", mime: "text/plain", filename: "note.txt", url: noteUrl },
        { type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${pngBytes.toString("base64")}` },
      ],
    });
    expect(response.status).toBe(204);

    // The browser tools report visits for the subagent that made them; the
    // event lands on the root session the collector tracks.
    const pageText = `Contact jane@example.com ${"visible page text ".repeat(8_000)}`;
    const report = await fetch(`${omnirush.base}/collector/events`, {
      method: "POST",
      headers: { Authorization: "Bearer owt_test_token", "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "ses_child",
        ancestry: ["ses_root"],
        events: [
          { type: "web.visit", data: { url: "https://docs.example.com/guide?ref=1", title: "Guide", text: pageText } },
          { type: "web.visit", data: { url: "file:///Users/me/secret.html", title: "Local file", text: "local secret" } },
          { type: "web.visit", data: { url: "http://localhost:5173/app", title: "Dev app", text: "dev secret" } },
          { type: "web.visit", data: { url: "chrome://settings", title: "Settings", text: "browser internals" } },
          { type: "web.visit", data: { url: "data:text/html,<p>inline</p>", title: "Inline", text: "inline secret" } },
        ],
      }),
    });
    expect(response.status).toBe(204);
    expect(await report.json()).toEqual({ ok: true, recorded: 1 });
    const unknown = await fetch(`${omnirush.base}/collector/events`, {
      method: "POST",
      headers: { Authorization: "Bearer owt_test_token", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_other", events: [{ type: "web.visit", data: { url: "https://example.com/", text: "orphan" } }] }),
    });
    expect(await unknown.json()).toEqual({ ok: true, recorded: 0 });

    // The agent leaves an untracked output next to the tracked source. (An
    // agent writes files well after the turn's baseline was listed; give the
    // listing the same head start here.)
    await new Promise((resolve) => setTimeout(resolve, 150));
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out", "report.bin"), Buffer.from([7, 0, 9]));
    await writeFile(join(root, "summary.md"), "generated summary\n");

    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    await omnirush.stop();

    const all = traces(gateway.uploads).flatMap((envelope) => events(envelope));
    const attachments = all.filter((event) => event.type === "attachment").map((event) => event.data);
    expect(attachments.map((attachment) => [attachment?.name, attachment?.mime, attachment?.bytes, attachment?.sha256])).toEqual([
      ["note.txt", "text/plain", Buffer.byteLength(noteText), sha256(noteText)],
      ["shot.png", "image/png", pngBytes.length, sha256(pngBytes)],
    ]);
    expect(attachments[0]?.text_truncated).toBe(true);
    expect(Buffer.byteLength(String(attachments[0]?.text))).toBeLessThanOrEqual(256 * 1024);
    expect(String(attachments[0]?.text)).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(attachments[1]).toMatchObject({ text: null, text_truncated: false });

    const visits = all.filter((event) => event.type === "web.visit").map((event) => event.data);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ url: "https://docs.example.com/guide?ref=1", title: "Guide", text_truncated: true });
    expect(Buffer.byteLength(String(visits[0]?.text))).toBeLessThanOrEqual(64 * 1024);
    expect(String(visits[0]?.text)).not.toContain("jane@example.com");

    const artifacts = all.filter((event) => event.type === "artifact").map((event) => event.data);
    expect(artifacts.map((artifact) => artifact?.path).sort()).toEqual(["out/report.bin", "summary.md"]);
    expect(artifacts.find((artifact) => artifact?.path === "out/report.bin")).toEqual({ path: "out/report.bin", sha256: sha256(Buffer.from([7, 0, 9])), bytes: 3 });

    const serialized = JSON.stringify(gateway.uploads);
    expect(serialized).not.toContain("local secret");
    expect(serialized).not.toContain("dev secret");
    expect(serialized).not.toContain("browser internals");
    expect(serialized).not.toContain("inline secret");
    expect(serialized).not.toContain("orphan");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("sk-1234567890abcdefghijklmnop");
    // The request log never carries inline attachment payloads.
    const request = all.find((event) => event.type === "engine.request")?.data as { body?: { parts?: Array<{ url?: string }> } };
    expect(request.body?.parts?.map((part) => part.url ?? null)).toEqual([null, "data:text/plain;omitted", "data:image/png;omitted"]);
    expect(serialized).not.toContain(noteUrl.slice(0, 80));
  }, 60_000);
});
