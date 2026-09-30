import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventTranslator } from "./events.js";
import { startEngineFacade, type EngineFacade } from "./facade.js";

type Tree = { session: Record<string, unknown>; messages: Array<Record<string, unknown>>; children: Tree[] };
const tree: Tree = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "v2-p1.json"), "utf8"));
const SESSION = String(tree.session.id);
// How many copies of the fixture's messages the mock engine serves (a long history spans several 200-message pages).
let LONG_REPEAT = 1;
const DIRECTORY = "/work/proj";

type Recorded = { method: string; path: string; query: Record<string, string>; body: unknown };
const recorded: Recorded[] = [];
let eventSink: ((event: unknown) => void) | null = null;
let upstream: ReturnType<typeof Bun.serve>;
let facade: EngineFacade;
let configDir = "";
const written: unknown[] = [];

const auth = { authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`, "x-opencode-directory": encodeURIComponent(DIRECTORY) };
const get = (path: string) => fetch(`${facade.url}${path}`, { headers: auth });
const post = (path: string, body: unknown) => fetch(`${facade.url}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("native preview goal admission uses the beta permission and question routes", async () => {
  const paths: string[] = [];
  const native = await startEngineFacade({
    upstreamUrl: "http://native.invalid", upstreamPassword: "engine-pw", username: "user", password: "secret",
    version: "beta", defaultDirectory: DIRECTORY, nativePreview: true,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/event") return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/api/session") {
        expect(url.searchParams.get("location[directory]")).toBe(DIRECTORY);
        return Response.json({ data: [tree.session] });
      }
      if (url.pathname === `/api/session/${SESSION}/permission`) return Response.json({ data: [{
        id: "per_native", sessionID: SESSION, action: "shell", resources: ["build"], metadata: {},
      }] });
      if (url.pathname === "/api/form/request") return Response.json({ data: [] });
      if (url.pathname === "/api/session/active") return Response.json({ data: { ses_busy: { type: "running" }, ses_idle: { type: "idle" } } });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect }),
  });
  try {
    const permission = await fetch(`${native.url}/permission`, { headers: auth });
    expect(permission.status).toBe(200);
    expect(await permission.json()).toMatchObject([{ id: "per_native", sessionID: SESSION }]);
    const question = await fetch(`${native.url}/question`, { headers: auth });
    expect(question.status).toBe(200);
    expect(await question.json()).toEqual([]);
    const status = await fetch(`${native.url}/session/status`, { headers: auth });
    expect(await status.json()).toEqual({ ses_busy: { type: "busy" } });
    expect(paths).not.toContain("/api/permission/request");
    expect(paths).not.toContain("/api/form");
  } finally { await native.close(); }
});

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "facade-test-"));
  const v1Config = join(configDir, "runtime.json");
  writeFileSync(v1Config, JSON.stringify({ model: "mock/mock-model", provider: { mock: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x/v1" }, models: { "mock-model": {} } } } }));
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:engine-pw").toString("base64")}`) return new Response("", { status: 401 });
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      recorded.push({ method: request.method, path: url.pathname, query, body });
      const json = (value: unknown, status = 200) => Response.json(value, { status });
      if (url.pathname === "/api/event") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            eventSink = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            eventSink({ id: "evt_0", type: "server.connected", data: {} });
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === `/api/session/${SESSION}` && request.method === "GET") return json({ data: tree.session });
      if (url.pathname === `/api/session/${SESSION}/message`) {
        // Like 2.0.18: a cursor carries its own direction, and naming `order` next to it is refused.
        if (query.cursor && query.order) return json({ name: "InvalidCursorError", data: { message: "Cursor cannot be combined with order" } }, 400);
        const long = Array.from({ length: LONG_REPEAT }, (_, round) =>
          tree.messages.map((message) => {
            const m = message as { id: string };
            return round === 0 ? message : { ...m, id: `${m.id}_r${String(round).padStart(3, "0")}` };
          }),
        ).flat();
        const [order, start] = query.cursor ? (JSON.parse(atob(query.cursor)) as [string, number]) : [query.order ?? "asc", 0];
        const messages = order === "desc" ? [...long].reverse() : long;
        const limit = Number(query.limit ?? 50);
        const end = start + limit;
        return json({ data: messages.slice(start, end), cursor: { next: end < messages.length ? btoa(JSON.stringify([order, end])) : null } });
      }
      if (url.pathname === "/api/session/active") return json({ data: {} });
      if (url.pathname === "/api/session" && request.method === "POST") return json({ data: { ...tree.session, id: "ses_new", title: undefined } });
      if (url.pathname === "/api/permission/request") {
        return json({ location: { directory: DIRECTORY }, data: [{ id: "per_1", sessionID: SESSION, action: "shell", resources: ["rm -rf build"], metadata: {} }] });
      }
      if (url.pathname === "/api/mcp") return json({ location: { directory: DIRECTORY }, data: [{ name: "cloud", status: { status: "connected" } }, { name: "broken", status: { status: "failed", error: "boom" } }] });
      if (url.pathname === "/api/agent") return json({ location: { directory: DIRECTORY }, data: [{ id: "general", description: "General", mode: "subagent", permissions: [{ action: "subagent", resource: "*", effect: "allow" }] }] });
      if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") return new Response(null, { status: 204 });
      return json({ data: null }, 404);
    },
  });
  facade = await startEngineFacade({
    upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    upstreamPassword: "engine-pw",
    username: "user",
    password: "secret",
    version: "2.0.18",
    defaultDirectory: DIRECTORY,
    v1ConfigPath: v1Config,
    writeEngineConfig: async (config) => {
      written.push(config);
    },
  });
});

afterAll(async () => {
  await facade?.close();
  upstream?.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

describe("1.x engine adapter over the 2.x engine", () => {
  test("requires the per-boot Basic credentials", async () => {
    const response = await fetch(`${facade.url}/global/health`);
    expect(response.status).toBe(401);
    expect(await (await get("/global/health")).json()).toEqual({ healthy: true, version: "2.0.18" });
  });

  test("renders the engine config from the 1.x runtime file at start", () => {
    const config = written.at(-1) as Record<string, unknown>;
    expect(config.model).toBe("mock/mock-model");
    expect((config.providers as Record<string, { package: string }>).mock.package).toBe("@opencode/ai/providers/openai-compatible");
  });

  test("message pages read newest first with the 1.x cursor", async () => {
    const all = (await (await get(`/session/${SESSION}/message`)).json()) as Array<{ info: { id: string; role: string } }>;
    expect(all.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant", "assistant", "assistant"]);
    const page = await get(`/session/${SESSION}/message?limit=2`);
    const newest = (await page.json()) as Array<{ info: { id: string } }>;
    expect(newest.map((message) => message.info.id)).toEqual(all.slice(3).map((message) => message.info.id));
    const cursor = page.headers.get("x-next-cursor");
    expect(cursor).toBeTruthy();
    const older = (await (await get(`/session/${SESSION}/message?limit=2&before=${cursor}`)).json()) as Array<{ info: { id: string } }>;
    expect(older.map((message) => message.info.id)).toEqual(all.slice(1, 3).map((message) => message.info.id));
    const one = (await (await get(`/session/${SESSION}/message/${all[0]!.info.id}`)).json()) as { info: { role: string } };
    expect(one.info.role).toBe("user");
  });

  test("a history longer than one engine page loads without naming order next to the cursor", async () => {
    LONG_REPEAT = 90;
    try {
      const response = await get(`/session/${SESSION}/message`);
      expect(response.status).toBe(200);
      const all = (await response.json()) as Array<{ info: { id: string } }>;
      expect(all.length).toBe(5 * 90); // the fixture's 6 engine messages read as 5 in 1.x form
      const paged = recorded.filter((r) => r.path === `/api/session/${SESSION}/message` && r.query.cursor);
      expect(paged.length).toBeGreaterThan(0);
      expect(paged.every((r) => r.query.order === undefined)).toBe(true);
    } finally {
      LONG_REPEAT = 1;
    }
  });

  test("a session reads with the agent and model of its latest step", async () => {
    const info = (await (await get(`/session/${SESSION}`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ id: SESSION, directory: DIRECTORY, agent: "build", model: { id: "mock-model", providerID: "mock", variant: "default" }, version: "2.0.18" });
  });

  test("prompt_async applies model, variant, agent and system, then sends text and files", async () => {
    recorded.length = 0;
    const response = await post(`/session/${SESSION}/prompt_async`, {
      messageID: "msg_client_1",
      model: { providerID: "omnirush", modelID: "gpt-6-astra" },
      variant: "high",
      agent: "omnirush",
      system: "Extra system",
      parts: [
        { type: "text", text: "hello" },
        { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(response.status).toBe(204);
    const calls = recorded.map((call) => `${call.method} ${call.path}`);
    expect(calls).toEqual([
      `POST /api/session/${SESSION}/model`,
      `POST /api/session/${SESSION}/agent`,
      `PUT /api/experimental/session/${SESSION}/instructions/entries/omnirush.system`,
      `POST /api/session/${SESSION}/prompt`,
    ]);
    expect(recorded[0]!.body).toEqual({ model: { providerID: "omnirush", id: "gpt-6-astra", variant: "high" } });
    expect(recorded[1]!.body).toEqual({ agent: "omnirush" });
    expect(recorded[2]!.body).toEqual({ value: "Extra system" });
    expect(recorded[3]!.body).toEqual({
      id: "msg_client_1",
      text: "hello",
      files: [{ uri: "data:image/png;base64,AAAA", name: "a.png" }],
      // The 1.x user message fields 2.x does not keep travel as message metadata.
      metadata: { omnirush: { agent: "omnirush", model: { providerID: "omnirush", modelID: "gpt-6-astra", variant: "high" }, system: "Extra system" } },
    });
    // The same selection is not sent again.
    recorded.length = 0;
    await post(`/session/${SESSION}/prompt_async`, { model: { providerID: "omnirush", modelID: "gpt-6-astra" }, variant: "high", agent: "omnirush", system: "Extra system", parts: [{ type: "text", text: "again" }] });
    expect(recorded.map((call) => call.path)).toEqual([`/api/session/${SESSION}/prompt`]);
  });

  test("a synthetic attachment note reaches the model and its text-part layout is kept", async () => {
    recorded.length = 0;
    const note = "Attached files were copied into this worker workspace for tool access:\n- image.png: .opencode/omnirush/inbox/chat-attachments/s/1-image.png (file:///home/u/p/.opencode/omnirush/inbox/chat-attachments/s/1-image.png)";
    const metadata = { omnirushAttachments: [] };
    await post(`/session/${SESSION}/prompt_async`, {
      model: { providerID: "omnirush", modelID: "gpt-6-astra" },
      variant: "high",
      agent: "omnirush",
      system: "Extra system",
      parts: [
        { type: "text", text: note, synthetic: true, metadata },
        { type: "text", text: "hi" },
        { type: "file", mime: "image/png", filename: "image.png", url: "data:image/png;base64,AAAA" },
      ],
    });
    const prompt = recorded.find((call) => call.path === `/api/session/${SESSION}/prompt`)!;
    expect(prompt.body).toMatchObject({
      text: `${note}\n\nhi`,
      metadata: { omnirush: { textParts: [{ length: note.length, synthetic: true, metadata }, { length: 2 }] } },
    });
  });

  test("permissions list and reply in 1.x form", async () => {
    const list = (await (await get("/permission")).json()) as Array<Record<string, unknown>>;
    expect(list).toEqual([{ id: "per_1", sessionID: SESSION, permission: "bash", patterns: ["rm -rf build"], metadata: {}, always: ["rm -rf build"] }]);
    recorded.length = 0;
    expect((await post("/permission/per_1/reply", { reply: "always" })).status).toBe(200);
    expect(recorded.at(-1)).toMatchObject({ method: "POST", path: `/api/session/${SESSION}/permission/per_1/reply`, body: { decision: "always" } });
  });

  test("MCP status and agents in 1.x form", async () => {
    expect(await (await get("/mcp")).json()).toEqual({ cloud: { status: "connected" }, broken: { status: "failed", error: "boom" } });
    const agents = (await (await get("/agent")).json()) as Array<Record<string, unknown>>;
    expect(agents).toEqual([{ name: "general", description: "General", mode: "subagent", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} }]);
  });

  test("provider keys delivered at runtime reach the engine config", async () => {
    expect((await fetch(`${facade.url}/auth/mock`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "api", key: "sk-1" }) })).status).toBe(200);
    const config = written.at(-1) as { providers: Record<string, { settings: Record<string, unknown> }> };
    expect(config.providers.mock.settings.apiKey).toBe("sk-1");
  });

  test("revert stages a reversible revert and unrevert clears it; neither commits", async () => {
    recorded.length = 0;
    const reverted = await post(`/session/${SESSION}/revert`, { messageID: "msg_b" });
    expect(reverted.status).toBe(200);
    const unreverted = await post(`/session/${SESSION}/unrevert`, {});
    expect(unreverted.status).toBe(200);
    const calls = recorded.filter((entry) => entry.path.includes("/revert")).map((entry) => `${entry.method} ${entry.path}`);
    expect(calls).toEqual([`POST /api/session/${SESSION}/revert/stage`, `DELETE /api/session/${SESSION}/revert`]);
    expect(recorded.find((entry) => entry.path.endsWith("/revert/stage"))!.body).toEqual({ messageID: "msg_b" });
  });

  test("a shell command or slash command makes a staged revert final first", async () => {
    recorded.length = 0;
    expect((await post(`/session/${SESSION}/shell`, { command: "ls", agent: "build" })).status).toBe(200);
    expect((await post(`/session/${SESSION}/command`, { command: "/review", arguments: "" })).status).toBe(204);
    const calls = recorded.filter((entry) => entry.method === "POST" && /\/(revert\/commit|shell|command)$/.test(entry.path)).map((entry) => entry.path.split("/").slice(4).join("/"));
    expect(calls).toEqual(["revert/commit", "shell", "revert/commit", "command"]);
  });

  test("the event stream speaks 1.x and keeps to the request's directory", async () => {
    const controller = new AbortController();
    const response = await fetch(`${facade.url}/event`, { headers: auth, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const pump = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
        }
      }
    })().catch(() => undefined);
    await Bun.sleep(100);
    eventSink!({ type: "session.execution.started", location: { directory: "/elsewhere" }, data: { sessionID: "ses_other" } });
    eventSink!({ type: "session.execution.started", location: { directory: DIRECTORY }, data: { sessionID: SESSION } });
    eventSink!({ type: "session.execution.succeeded", location: { directory: DIRECTORY }, data: { sessionID: SESSION } });
    await Bun.sleep(200);
    controller.abort();
    await pump;
    const mine = events.filter((event) => event.type !== "server.connected" && event.type !== "server.heartbeat");
    expect(mine.map((event) => `${event.type}:${String(event.properties.sessionID)}`)).toEqual([
      `session.status:${SESSION}`,
      `session.status:${SESSION}`,
      `session.idle:${SESSION}`,
    ]);
  });
});

describe("revert events", () => {
  const info = (revert?: Record<string, unknown>) => ({ data: { id: "ses_r", title: "T", location: { directory: DIRECTORY }, time: { created: 1, updated: 1 }, ...(revert ? { revert } : {}) } });
  const make = (current: { revert?: Record<string, unknown> }) => new EventTranslator({
    version: "2.0.18",
    lookupSession: async () => info(current.revert),
    messageIDs: async () => ["msg_a", "msg_a2", "msg_b", "msg_b2", "msg_c", "msg_c2"],
  });

  test("staged, cleared and committed reach the app as session.updated and message.removed", async () => {
    const current: { revert?: Record<string, unknown> } = {};
    const translator = make(current);
    const summary = (out: Awaited<ReturnType<EventTranslator["translate"]>>) => out.map((item) => {
      const properties = item.event.properties as Record<string, any>;
      return item.event.type === "message.removed" ? `removed:${properties.messageID}` : `${item.event.type}:${properties.info?.revert?.messageID ?? "-"}`;
    });

    current.revert = { messageID: "msg_b", snapshot: "abc" };
    const staged = await translator.translate({ type: "session.revert.staged", data: { sessionID: "ses_r", revert: { messageID: "msg_b", snapshot: "abc", files: [] } } });
    expect(summary(staged)).toEqual(["session.updated:msg_b"]);
    expect((staged[0]!.event.properties as any).info.revert).toEqual({ messageID: "msg_b", snapshot: "abc" });

    current.revert = undefined;
    expect(summary(await translator.translate({ type: "session.revert.cleared", data: { sessionID: "ses_r" } }))).toEqual(["session.updated:-"]);

    current.revert = { messageID: "msg_b" };
    await translator.translate({ type: "session.revert.staged", data: { sessionID: "ses_r", revert: { messageID: "msg_b" } } });
    current.revert = undefined;
    const committed = await translator.translate({ type: "session.revert.committed", data: { sessionID: "ses_r", to: "msg_b" } });
    expect(summary(committed)).toEqual(["removed:msg_b", "removed:msg_b2", "removed:msg_c", "removed:msg_c2", "session.updated:-"]);
  });

  test("a revert committed without a staged one seen removes the boundary message", async () => {
    const translator = make({});
    const out = await translator.translate({ type: "session.revert.committed", data: { sessionID: "ses_r", to: "msg_c" } });
    expect(out.map((item) => item.event.type)).toEqual(["message.removed", "session.updated"]);
  });
});
