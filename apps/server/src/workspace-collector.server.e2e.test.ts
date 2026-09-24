import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { proxyOpencodeRequest, proxyOpencodeV2Request, startServer } from "./server.js";
import { FakeArchiveServer } from "./session-archive/fake-archive-server.js";
import { manifestOf, openArchive } from "./session-archive/test-helpers.js";
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

// Workflow state and audit logs live under the server data directory; keep
// them out of the developer's real one.
const previousDataDir = process.env.OMNIRUSH_DATA_DIR;
let dataDir = "";
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "omnirush-collector-server-data-"));
  process.env.OMNIRUSH_DATA_DIR = dataDir;
});
afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.OMNIRUSH_DATA_DIR;
  else process.env.OMNIRUSH_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
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
 * The engine's message paging (`?limit=&before=`): the newest `limit`
 * messages before the cursor, oldest first, with `X-Next-Cursor` while older
 * ones remain. Without `limit`, the whole list.
 */
function messagePage(url: URL, list: EngineMessage[]): Response {
  const limit = Number(url.searchParams.get("limit") ?? 0);
  if (!limit) return Response.json(list);
  const end = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : list.length;
  const start = Math.max(0, end - limit);
  return Response.json(list.slice(start, end), start > 0 ? { headers: { "X-Next-Cursor": String(start) } } : {});
}

/**
 * A fake engine with one root session and a two-level subagent tree. Each
 * prompt is a turn: the root gains a user + assistant message, the child gains
 * a message on turns 1 and 2, the grandchild on turns 1 and 3. It also serves
 * what a local workflow step needs: the provider catalog, session creation and
 * the synchronous prompt route on the "ses_workflow" session it creates. The
 * root session can start with an earlier `history`.
 */
function startMockEngine(input: { provider: string; model: string; history?: EngineMessage[] }) {
  let turn = 0;
  let busy = false;
  let workflowBusy = false;
  const root: EngineMessage[] = [...(input.history ?? [])];
  const child: EngineMessage[] = [];
  const grandchild: EngineMessage[] = [];
  // A swarm three layers deep, and a fourth layer past the capture depth.
  const great: EngineMessage[] = [];
  const tooDeep: EngineMessage[] = [];
  const workflow: EngineMessage[] = [];
  const prompts: unknown[] = [];
  const workflowPrompts: unknown[] = [];
  const received: string[] = [];
  /**
   * How long a prompt keeps the root session busy, the error status its
   * message route answers with (null: none), and a body the status route
   * answers with instead of JSON (null: none), which makes the observer fail.
   */
  const control: { busyMs: number; rootMessagesStatus: number | null; statusBody: string | null } = { busyMs: 50, rootMessagesStatus: null, statusBody: null };
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
      if (pathname === "/session/status") {
        if (control.statusBody !== null) return new Response(control.statusBody, { status: 200 });
        return Response.json({ ...(busy ? { ses_root: { type: "busy" } } : {}), ...(workflowBusy ? { ses_workflow: { type: "busy" } } : {}) });
      }
      if (["/permission", "/question"].includes(pathname)) return Response.json([]);
      if (pathname === "/provider") {
        return Response.json({ all: [{ id: input.provider, name: "Provider", models: { [input.model]: { name: input.model } } }], connected: [input.provider], default: {} });
      }
      if (pathname === "/session" && request.method === "POST") return Response.json(session("ses_workflow"));
      if (pathname === "/session/ses_workflow/prompt" && request.method === "POST") {
        workflowPrompts.push(await request.json().catch(() => null));
        turn += 1;
        workflowBusy = true;
        const answer = message("ses_workflow", `wf_assistant_${turn}`, "assistant", `workflow answer ${turn}`);
        workflow.push(message("ses_workflow", `wf_user_${turn}`, "user", `workflow prompt ${turn}`), answer);
        setTimeout(() => { workflowBusy = false; }, 50);
        return Response.json(answer);
      }
      if (pathname === "/session/ses_workflow") return Response.json(session("ses_workflow"));
      if (pathname === "/session/ses_workflow/message") return messagePage(url, workflow);
      if (pathname === "/session/ses_workflow/children") return Response.json([]);
      if (pathname === "/session/ses_workflow/abort" && request.method === "POST") return Response.json(true);
      if (pathname === "/session/ses_root/prompt_async" && request.method === "POST") {
        prompts.push(await request.json().catch(() => null));
        turn += 1;
        busy = true;
        root.push(message("ses_root", `user_${turn}`, "user", `prompt ${turn}`), message("ses_root", `assistant_${turn}`, "assistant", `answer ${turn}`));
        if (turn === 1 || turn === 2) child.push(message("ses_child", `child_${turn}`, "assistant", `child answer ${turn} for jane@example.com`));
        if (turn === 1 || turn === 3) grandchild.push(message("ses_grandchild", `grand_${turn}`, "assistant", `grandchild answer ${turn}`));
        if (turn === 1) great.push(message("ses_great", `great_${turn}`, "assistant", `great-grandchild answer ${turn}`));
        if (turn === 1) tooDeep.push(message("ses_toodeep", `deep_${turn}`, "assistant", `too deep ${turn}`));
        setTimeout(() => { busy = false; }, control.busyMs);
        return new Response(null, { status: 204 });
      }
      if (pathname === "/session" && request.method === "GET") return Response.json([session("ses_root")]);
      if (pathname === "/session/ses_root") return Response.json(session("ses_root"));
      if (pathname === "/session/ses_root/message") {
        return control.rootMessagesStatus ? Response.json({ code: "unavailable" }, { status: control.rootMessagesStatus }) : messagePage(url, root);
      }
      if (pathname === "/session/ses_root/children") return Response.json([session("ses_child", "ses_root")]);
      if (pathname === "/session/ses_child/message") return messagePage(url, child);
      if (pathname === "/session/ses_child/children") return Response.json([session("ses_grandchild", "ses_child")]);
      if (pathname === "/session/ses_grandchild/message") return messagePage(url, grandchild);
      if (pathname === "/session/ses_grandchild/children") return Response.json([session("ses_great", "ses_grandchild")]);
      if (pathname === "/session/ses_great/message") return messagePage(url, great);
      if (pathname === "/session/ses_great/children") return Response.json([session("ses_toodeep", "ses_great")]);
      if (pathname === "/session/ses_toodeep/message") return messagePage(url, tooDeep);
      if (pathname === "/session/ses_toodeep/children") return Response.json([]);
      if (pathname === "/session/ses_root/todo") return Response.json([]);
      return Response.json({ code: "not_found", message: `Not found: ${request.method} ${pathname}` }, { status: 404 });
    },
  }) as Served;
  cleanups.push(() => server.stop(true));
  return { server, prompts, workflowPrompts, received, control, baseUrl: `http://127.0.0.1:${server.port}` };
}

/**
 * A fake engine v2 daemon: the routes the v2 mount touches before admitting a
 * prompt (session ownership, MCP and skill catalogs, the managed instruction
 * entry) plus the prompt, activity and context routes the collector observes.
 */
function startMockV2Engine(input: { provider: string; model: string }) {
  let turn = 0;
  let busy = false;
  const context: Array<Record<string, unknown>> = [];
  const prompts: unknown[] = [];
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      received.push(`${request.method} ${url.pathname}`);
      const pathname = decodeURI(url.pathname);
      if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:v2-password").toString("base64")}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (pathname === "/api/session/active") return Response.json({ data: busy ? { ses_v2root: { type: "running" } } : {} });
      if (pathname === "/api/mcp" || pathname === "/api/skill") return Response.json({ data: [] });
      if (pathname === "/api/session/ses_v2root/instructions/entries/omnirush.context" && request.method === "PUT") return Response.json({ data: {} });
      if (pathname === "/api/session/ses_v2root/prompt" && request.method === "POST") {
        prompts.push(await request.json().catch(() => null));
        turn += 1;
        busy = true;
        context.push(
          { id: `v2_user_${turn}`, type: "user", text: `prompt ${turn}`, time: { created: turn } },
          {
            id: `v2_assistant_${turn}`, type: "assistant", agent: "build",
            model: { providerID: input.provider, id: input.model, variant: "high" },
            content: [{ type: "text", text: `answer ${turn}` }], time: { created: turn, completed: turn + 1 },
          },
        );
        setTimeout(() => { busy = false; }, 50);
        return Response.json({ data: { id: `in_${turn}`, admittedSeq: turn } });
      }
      if (pathname === "/api/session/ses_v2root/context") return Response.json({ data: context });
      if (pathname === "/api/session/ses_v2root" && request.method === "GET") {
        // The mount binds the workspace directory into the query; echo it back as the session's location.
        return Response.json({ data: { id: "ses_v2root", title: "Root task", location: { directory: url.searchParams.get("location[directory]") } } });
      }
      return Response.json({ error: `Not found: ${request.method} ${pathname}` }, { status: 404 });
    },
  }) as Served;
  cleanups.push(() => server.stop(true));
  return { prompts, received, connection: { url: `http://127.0.0.1:${server.port}`, username: "opencode", password: "v2-password" } };
}

/** A prompt dispatch on the v2 mount, as the mount handler forwards it to proxyOpencodeV2Request. */
function promptV2(config: ServerConfig, connection: { url: string; username: string; password: string }, path = "api/session/ses_v2root/prompt", body: unknown = { text: "Do the task" }) {
  const proxyPath = `/opencode2/${path}`;
  const url = new URL(`http://127.0.0.1/workspace/ws_1${proxyPath}`);
  return proxyOpencodeV2Request({
    config,
    request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    url,
    workspace: config.workspaces[0]!,
    proxyPath,
    connection,
  });
}

const clientHeaders = { Authorization: "Bearer owt_test_token", "content-type": "application/json" };

/** Creates a one-step workflow routed to the mock engine's model and returns its id. */
async function createWorkflow(base: string, model: { provider: string; model: string }): Promise<string> {
  const routing = await fetch(`${base}/workspace/ws_1/local-workflows/routing`, {
    method: "PUT", headers: clientHeaders,
    body: JSON.stringify({ enabled: true, defaultModel: { providerID: model.provider, modelID: model.model }, categories: {} }),
  });
  expect(routing.status).toBe(200);
  const created = await fetch(`${base}/workspace/ws_1/local-workflows`, {
    method: "POST", headers: clientHeaders,
    body: JSON.stringify({ name: "Nightly summary", steps: [{ id: "s1", name: "Summarise", prompt: "Summarise the repository", category: "auto", model: null }] }),
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

function runWorkflow(base: string, workflowId: string) {
  return fetch(`${base}/workspace/ws_1/local-workflows/${workflowId}/run`, { method: "POST", headers: clientHeaders });
}

async function settledRun(base: string, runId: string): Promise<{ status: string; error: string | null; steps: Array<{ status: string; sessionId: string | null; output: string }> }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/workspace/ws_1/local-workflows/runs/${runId}`, { headers: clientHeaders });
    const run = (await response.json()) as { status: string; error: string | null; steps: Array<{ status: string; sessionId: string | null; output: string }> };
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the workflow run did not settle");
}

/**
 * The omnirush.ai collector endpoint, recording every decompressed envelope.
 * With `archive`, it also serves the project archive routes from that fake,
 * with the presigned S3 part URLs pointing back here.
 */
function startMockGateway(archive?: FakeArchiveServer) {
  const uploads: Upload[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (archive && url.pathname.startsWith("/omnirush/archives")) {
        const body = request.method === "GET" ? undefined : await request.text();
        const response = await archive.respond(`https://api.omnirush.test${url.pathname}`, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
        const text = (await response.text()).replaceAll("https://bucket.s3.test/", `http://127.0.0.1:${server.port}/s3/`);
        return new Response(text, { status: response.status, headers: { "content-type": "application/json" } });
      }
      if (archive && url.pathname.startsWith("/s3/")) {
        return archive.respond(`https://bucket.s3.test/${url.pathname.slice("/s3/".length)}${url.search}`, { method: request.method, body: await request.arrayBuffer() });
      }
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
    // Every swarm layer the engine allows (3) is captured with its parent and
    // depth; a fourth layer is not walked.
    expect(children.map((event) => [event.data?.child_session_id, event.data?.parent_session_id, event.data?.depth, event.data?.title, event.data?.agent])).toEqual([
      ["ses_child", "ses_root", 1, "Subtask ses_child", "build"],
      ["ses_grandchild", "ses_child", 2, "Subtask ses_grandchild", "build"],
      ["ses_great", "ses_grandchild", 3, "Subtask ses_great", "build"],
    ]);
    expect(JSON.stringify(children)).not.toContain("ses_toodeep");
    expect((children[0]?.data?.messages as unknown[]).length).toBe(1);
    expect(JSON.stringify(children)).not.toContain("jane@example.com");
    expect(trace.session).toEqual({ provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", child_session_ids: ["ses_child", "ses_grandchild", "ses_great"] });
    const end = anthropic.uploads.at(-1)!.envelope;
    expect(end.session.child_session_ids).toEqual(["ses_child", "ses_grandchild", "ses_great"]);
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
    expect(childEvents(turnOne)).toEqual([["ses_child", ["child_1"]], ["ses_grandchild", ["grand_1"]], ["ses_great", ["great_1"]]]);
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
    expect(resumedStart.envelope.session).toEqual({ provider_id: "openai", model_id: "gpt-5", variant: "high", child_session_ids: ["ses_child", "ses_grandchild", "ses_great"] });
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

describe("collection gaps: the v2 mount and local workflow steps", () => {
  const provider = { provider: "anthropic", model: "claude-sonnet-4-5" };

  test("refuses a v2 prompt dispatch on a local workspace without an account, unless both development flags are set", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine(provider);
    const v2 = startMockV2Engine(provider);
    const config = serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl });
    await startOmniRush(config);

    preserveGateEnv();
    setGateEnv(undefined, undefined);
    // Encoded spellings are classified as the daemon's router decodes them.
    for (const path of ["api/session/ses_v2root/prompt", "api/session/ses_v2root/command", "api/session/ses_v2root/promp%74", "api/sessio%6E/ses_v2root/prompt"]) {
      const response = await promptV2(config, v2.connection, path);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toEqual({ error: "omnirush_account_required", message: "Sign in to omnirush.ai from Settings to start a session." });
    }
    // Nothing reached the daemon: no ownership lookup, no instruction sync, no prompt.
    expect(v2.received).toEqual([]);

    setGateEnv("1", undefined);
    expect((await promptV2(config, v2.connection)).status).toBe(403);
    setGateEnv(undefined, "1");
    expect((await promptV2(config, v2.connection)).status).toBe(403);
    expect(v2.received).toEqual([]);

    setGateEnv("1", "1");
    const bypassed = await promptV2(config, v2.connection);
    expect(bypassed.status).toBe(200);
    expect(v2.prompts).toEqual([{ text: "Do the task" }]);
    expect(v2.received).toContain("PUT /api/session/ses_v2root/instructions/entries/omnirush.context");
    // Even bypassed, a session identifier the daemon cannot decode is refused before the request is forwarded.
    const malformed = await promptV2(config, v2.connection, "api/session/ses%E0/prompt");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_session_id", message: "The session identifier is not valid." });
    expect(v2.prompts).toHaveLength(1);
  }, 30_000);

  test("collects a v2 prompt dispatch exactly like a v1 one: session start, prompt milestone, request/response trace and the settled turn", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine(provider);
    const v2 = startMockV2Engine(provider);
    const gateway = startMockGateway();
    const config = serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl });
    const omnirush = await startOmniRush(config);

    const noteText = "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop attached note";
    const noteUri = `data:text/plain;base64,${Buffer.from(noteText).toString("base64")}`;
    const response = await promptV2(config, v2.connection, "api/session/ses_v2root/prompt", { text: "Summarise the note", files: [{ uri: noteUri, mime: "text/plain", name: "note.txt" }] });
    expect(response.status).toBe(200);
    expect(v2.prompts).toHaveLength(1);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    await omnirush.stop();

    expect(gateway.uploads.map((upload) => [upload.sessionId, upload.envelope.snapshot_type, upload.envelope.trigger])).toEqual([
      ["ses_v2root", "start", "session_start"],
      ["ses_v2root", "trace", "trace_flush"],
      ["ses_v2root", "end", "session_end"],
    ]);
    const trace = traces(gateway.uploads)[0]!;
    const types = events(trace).map((event) => event.type);
    for (const type of ["engine.request", "engine.response", "collector.trigger", "session.model", "session.idle", "turn.completed"]) {
      expect(types).toContain(type);
    }
    expect(events(trace).find((event) => event.type === "engine.request")?.data).toEqual({
      method: "POST", path: "/api/session/ses_v2root/prompt",
      body: { text: "Summarise the note", files: [{ uri: "data:text/plain;omitted", omitted_uri_chars: noteUri.length, mime: "text/plain", name: "note.txt" }] },
    });
    expect(events(trace).find((event) => event.type === "engine.response")?.data).toEqual({ method: "POST", path: "/api/session/ses_v2root/prompt", status: 200 });
    expect(events(trace).filter((event) => event.type === "collector.trigger").map((event) => event.data?.trigger)).toEqual(["prompt", "turn_completed"]);
    expect(events(trace).find((event) => event.type === "session.model")?.data).toEqual({
      provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", agent: "build",
    });
    expect((events(trace).find((event) => event.type === "turn.completed")?.data?.messages as unknown[]).length).toBe(2);
    expect(trace.session).toEqual({ provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", child_session_ids: [] });
    // The observer used the daemon's own routes, and the inline attachment never left the client.
    expect(v2.received).toContain("GET /api/session/active");
    expect(v2.received).toContain("GET /api/session/ses_v2root/context");
    expect(JSON.stringify(gateway.uploads)).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(JSON.stringify(gateway.uploads)).not.toContain(noteUri.slice(0, 60));
  }, 60_000);

  test("refuses a local workflow run without an account, unless both development flags are set", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine(provider);
    const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl }));
    const workflowId = await createWorkflow(omnirush.base, provider);

    preserveGateEnv();
    setGateEnv(undefined, undefined);
    const refused = await runWorkflow(omnirush.base, workflowId);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "omnirush_account_required", message: "Sign in to omnirush.ai from Settings to start a session." });
    setGateEnv("1", undefined);
    expect((await runWorkflow(omnirush.base, workflowId)).status).toBe(403);
    setGateEnv(undefined, "1");
    expect((await runWorkflow(omnirush.base, workflowId)).status).toBe(403);
    // No engine session was created and no prompt was sent; no run was recorded.
    expect(engine.received.filter((entry) => entry.startsWith("POST"))).toEqual([]);
    const snapshot = await fetch(`${omnirush.base}/workspace/ws_1/local-workflows`, { headers: clientHeaders });
    expect(((await snapshot.json()) as { runs: unknown[] }).runs).toEqual([]);

    setGateEnv("1", "1");
    const accepted = await runWorkflow(omnirush.base, workflowId);
    expect(accepted.status).toBe(202);
    const run = await settledRun(omnirush.base, ((await accepted.json()) as { id: string }).id);
    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => [step.status, step.sessionId, step.output])).toEqual([["completed", "ses_workflow", "workflow answer 1"]]);
    expect(engine.workflowPrompts).toEqual([{ model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, parts: [{ type: "text", text: "Summarise the repository" }] }]);
  }, 30_000);

  test("collects a workflow step exactly like a prompt sent from the app", async () => {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine(provider);
    const gateway = startMockGateway();
    const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl }));
    const workflowId = await createWorkflow(omnirush.base, provider);
    const accepted = await runWorkflow(omnirush.base, workflowId);
    expect(accepted.status).toBe(202);
    const run = await settledRun(omnirush.base, ((await accepted.json()) as { id: string }).id);
    expect(run.status).toBe("completed");
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    await omnirush.stop();

    expect(gateway.uploads.map((upload) => [upload.sessionId, upload.envelope.snapshot_type, upload.envelope.trigger])).toEqual([
      ["ses_workflow", "start", "session_start"],
      ["ses_workflow", "trace", "trace_flush"],
      ["ses_workflow", "end", "session_end"],
    ]);
    const trace = traces(gateway.uploads)[0]!;
    const types = events(trace).map((event) => event.type);
    for (const type of ["engine.request", "engine.response", "collector.trigger", "session.model", "session.idle", "turn.completed"]) {
      expect(types).toContain(type);
    }
    expect(events(trace).find((event) => event.type === "engine.request")?.data).toEqual({
      method: "POST", path: "/session/ses_workflow/prompt",
      body: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, parts: [{ type: "text", text: "Summarise the repository" }] },
    });
    expect(events(trace).find((event) => event.type === "engine.response")?.data).toEqual({ method: "POST", path: "/session/ses_workflow/prompt", status: 200 });
    expect(events(trace).filter((event) => event.type === "collector.trigger").map((event) => event.data?.trigger)).toEqual(["prompt", "turn_completed"]);
    expect(events(trace).find((event) => event.type === "session.model")?.data).toEqual({
      provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", agent: "build",
    });
    expect((events(trace).find((event) => event.type === "turn.completed")?.data?.messages as unknown[]).length).toBe(2);
    expect(gateway.uploads.at(-1)?.envelope.session).toEqual({ provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", child_session_ids: [] });
  }, 60_000);
});

describe("project archive wiring", () => {
  /** A server whose gateway also serves the archive routes; `ses_root` has a two-level subagent tree. */
  async function archivedServer(setup: (archive: FakeArchiveServer) => void = () => undefined, history?: EngineMessage[]) {
    const { root, stateDir } = await createWorkspace();
    const engine = startMockEngine({ provider: "openai", model: "gpt-5", ...(history ? { history } : {}) });
    const archive = new FakeArchiveServer();
    archive.token = "access-token";
    setup(archive);
    const gateway = startMockGateway(archive);
    const omnirush = await startOmniRush(serverConfig({ root, stateDir, engineBaseUrl: engine.baseUrl, gatewayUrl: gateway.gatewayUrl }));
    return { root, stateDir, engine, archive, gateway, omnirush };
  }

  test("a git workspace's root session is archived through the device session: one base, then a delta for a turn that changed the folder", async () => {
    const { root, archive, gateway, omnirush } = await archivedServer();
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    const [base] = await waitFor(() => (archive.objects().length >= 1 ? archive.objects() : undefined));

    await writeFile(join(root, "feature.txt"), "new work\n");
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 2 ? true : undefined));
    const objects = await waitFor(() => (archive.objects().some((object) => object.request.turn === 2) ? archive.objects() : undefined));
    await omnirush.stop();

    expect(base!.request).toMatchObject({ session_id: "ses_root", kind: "base", sequence: 0, marker: ".git" });
    expect((await openArchive(base!.object!)).map((member) => member.name)).toEqual(expect.arrayContaining(["app.txt", ".git/HEAD"]));
    // One base however many prompts; the turn numbers are the engine's completed-turn count, strictly increasing.
    expect(objects.filter((object) => object.request.kind === "base")).toHaveLength(1);
    const turns = objects.map((object) => object.request.turn);
    expect(turns.every((turn, index) => index === 0 || turn > turns[index - 1]!)).toBe(true);
    const delta = objects.at(-1)!;
    expect(delta.request).toMatchObject({ kind: "delta", turn: 2 });
    const members = await openArchive(delta.object!);
    expect(members.map((member) => member.name)).toContain("feature.txt");
    expect(manifestOf(members)).toMatchObject({ session_id: "ses_root", turn: 2 });
    // The subagent sessions are never archived, and the key was fetched once.
    expect(new Set(objects.map((object) => object.request.session_id))).toEqual(new Set(["ses_root"]));
    expect(archive.calls.filter((call) => call.path === "archives/key")).toHaveLength(1);
  }, 60_000);

  test("a turn whose status the engine stops answering is waited out, not given up: once it answers, the turn gets its delta, numbered from the engine", async () => {
    const { root, engine, archive, gateway, omnirush } = await archivedServer();
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    await waitFor(() => (archive.objects().length >= 1 ? true : undefined));
    // The status route stops answering JSON: the observer retries with backoff instead of failing.
    engine.control.statusBody = "not json";
    await writeFile(join(root, "feature.txt"), "new work\n");
    const statusReads = () => engine.received.filter((request) => request === "GET /session/status").length;
    const before = statusReads();
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (statusReads() >= before + 2 ? true : undefined));
    engine.control.statusBody = null;
    const objects = await waitFor(() => (archive.objects().some((object) => object.request.turn === 2) ? archive.objects() : undefined));
    const settled = await waitFor(() => traces(gateway.uploads).slice(1).find((envelope) => events(envelope).some((event) => event.type === "turn.completed")));
    await omnirush.stop();

    // The turn settled as any other: its messages went out, and the observer neither failed nor timed out.
    const completed = events(settled).find((event) => event.type === "turn.completed")?.data?.messages as Array<{ info: { id: string } }>;
    expect(completed.map((entry) => entry.info.id)).toEqual(["user_2", "assistant_2"]);
    for (const envelope of traces(gateway.uploads)) {
      expect(events(envelope).map((event) => event.type)).not.toContain("session.observer_failed");
      expect(events(envelope).map((event) => event.type)).not.toContain("session.observer_timeout");
    }
    expect(objects.map((object) => [object.request.kind, object.request.turn])).toEqual([["base", 1], ["delta", 2]]);
    const members = await openArchive(objects[1]!.object!);
    expect(manifestOf(members)).toMatchObject({ kind: "delta", turn: 2, trigger: "turn" });
    expect(members.map((member) => member.name)).toContain("feature.txt");
  }, 60_000);

  test("a chat whose history is past the 8 MiB read cap keeps each turn's transcript, turn snapshot and archive delta, and gets its base; a turn whose messages cannot be read keeps its snapshot and delta", async () => {
    const message = (id: string, role: "user" | "assistant", part: Record<string, unknown>): EngineMessage => ({
      info: { id, sessionID: "ses_root", role, time: role === "assistant" ? { created: 1, completed: 2 } : { created: 1 } },
      parts: [{ id: `${id}_part`, messageID: id, sessionID: "ses_root", ...part }],
    });
    // A first prompt carrying a PDF the engine stored whole as a data URL, over
    // the read cap on its own, then thirty turns of 100 KB answers (over one page).
    const history = [
      message("old_user_0", "user", { type: "file", mime: "application/pdf", filename: "scan.pdf", url: `data:application/pdf;base64,${"A".repeat(9 * 1024 * 1024)}` }),
      message("old_assistant_0", "assistant", { type: "text", text: "read it" }),
      ...Array.from({ length: 30 }, (_, index) => [
        message(`old_user_${index + 1}`, "user", { type: "text", text: `question ${index + 1}` }),
        message(`old_assistant_${index + 1}`, "assistant", { type: "text", text: "x".repeat(100 * 1024) }),
      ]).flat(),
    ];
    const { root, engine, archive, gateway, omnirush } = await archivedServer(undefined, history);
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    await writeFile(join(root, "feature.txt"), "new work\n");
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 2 ? true : undefined));
    await waitFor(() => (archive.objects().some((object) => object.request.kind === "delta") ? true : undefined));
    // Then the engine stops answering for the messages (a turn long enough to be seen running).
    engine.control.rootMessagesStatus = 500;
    engine.control.busyMs = 2_500;
    await writeFile(join(root, "later.txt"), "more work\n");
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 3 ? true : undefined));
    const objects = await waitFor(() => (archive.objects().filter((object) => object.request.kind === "delta").length >= 2 ? archive.objects() : undefined));
    await omnirush.stop();

    const [turnOne, turnTwo, turnThree] = traces(gateway.uploads);
    const turnMessageIds = (envelope: Envelope | undefined) => (events(envelope).find((event) => event.type === "turn.completed")?.data?.messages as Array<{ info: { id: string } }>)
      .map((entry) => entry.info.id);
    // No checkpoint on the first turn: every message but the one too large to read, oldest first.
    expect(turnMessageIds(turnOne)).toEqual(history.slice(1).map((entry) => String(entry.info.id)).concat(["user_1", "assistant_1"]));
    expect(events(turnOne).find((event) => event.type === "session.messages_omitted")?.data).toEqual({ count: 1 });
    // The next turn carries just its own messages.
    expect(turnMessageIds(turnTwo)).toEqual(["user_2", "assistant_2"]);
    for (const envelope of [turnOne, turnTwo]) {
      const types = events(envelope).map((event) => event.type);
      expect(types).not.toContain("session.observer_failed");
      expect(types).not.toContain("session.messages_failed");
      expect(events(envelope).filter((event) => event.type === "collector.trigger").map((event) => event.data?.trigger)).toContain("turn_completed");
    }
    // Unreadable messages: no transcript, but the turn snapshot and the trace still go out.
    expect(events(turnThree).find((event) => event.type === "turn.completed")?.data).toEqual({ messages: { status: 500, unavailable: true } });
    expect(events(turnThree).find((event) => event.type === "session.messages_failed")?.data).toEqual({ error: "the engine answered 500" });
    expect(events(turnThree).filter((event) => event.type === "collector.trigger").map((event) => event.data?.trigger)).toContain("turn_completed");
    // The base counts every completed turn, the PDF turn included (read from
    // its info alone): 31 earlier ones plus the first prompt's. The changed
    // second turn gets its delta, and so does the third, numbered right after it.
    expect(objects.map((object) => [object.request.kind, object.request.turn])).toEqual([["base", 32], ["delta", 33], ["delta", 34]]);
    expect((await openArchive(objects[1]!.object!)).map((member) => member.name)).toContain("feature.txt");
    expect((await openArchive(objects[2]!.object!)).map((member) => member.name)).toContain("later.txt");
  }, 90_000);

  test("without archive consent (428) nothing is packed or uploaded, consent is checked once, and the chat carries on", async () => {
    const { stateDir, archive, gateway, omnirush } = await archivedServer((fake) => {
      fake.gate = { status: 428, detail: "archive_consent_required" };
    });
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 2 ? true : undefined));
    await omnirush.stop();
    expect(archive.callPaths()).toEqual(["GET archives/key 428"]);
    expect(await readdir(join(stateDir, "omnirush-archive", "pending"))).toEqual([]);
  }, 60_000);

  test("OMNIRUSH_ARCHIVE_ENABLED=0 turns the archive off on this device: no archive request at all", async () => {
    const previous = process.env.OMNIRUSH_ARCHIVE_ENABLED;
    process.env.OMNIRUSH_ARCHIVE_ENABLED = "0";
    cleanups.push(() => {
      if (previous === undefined) delete process.env.OMNIRUSH_ARCHIVE_ENABLED;
      else process.env.OMNIRUSH_ARCHIVE_ENABLED = previous;
    });
    const { stateDir, archive, gateway, omnirush } = await archivedServer();
    expect((await prompt(omnirush.base)).status).toBe(204);
    await waitFor(() => (traces(gateway.uploads).length >= 1 ? true : undefined));
    await omnirush.stop();
    expect(archive.calls).toEqual([]);
    expect(await readdir(stateDir)).not.toContain("omnirush-archive");
  }, 60_000);
});
