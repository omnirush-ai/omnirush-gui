import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { firstPartyRemote } from "../mcp-allow/mcp-allow.mjs";
import { applyWork, v2WorkPermissions, withV2WorkPermissions } from "./engine.js";
import { desiredV2Mcp, v2McpGate } from "../engine-v2-mcp.js";
import { writeWorkspaceMcp } from "../mcp-allow/state.js";
import { workPrompt } from "./prompt.js";
import { forwardWorkMcp, registerWorkRoutes, type WorkBroker } from "./routes.js";
import { isWorkRoot, rememberAnswerStyle, rememberedAnswerStyle, rememberedWorkActions, rememberedWorkSwitch, rememberWorkConnectors, rememberWorkSwitch, WORK_PATH, WORK_READ_TOOLS, workEnvironment, workHome } from "./work.js";
import type { Route } from "../routes/registry.js";
import type { ServerConfig } from "../types.js";

const temp = () => mkdtempSync(join(tmpdir(), "work-"));

describe("work switch", () => {
  test("off unless the server says enabled; a missing block turns it off; no answer keeps it", () => {
    const dir = temp();
    expect(rememberedWorkSwitch(dir).enabled).toBe(false);
    expect(rememberWorkSwitch(dir, { work: { enabled: true, allow_users: "all", sources: ["google", "mock", "jira", "zendesk", "../x", 7] } })).toBe(true);
    expect(rememberedWorkSwitch(dir)).toEqual({ enabled: true, available: false, sources: ["google", "mock", "jira", "zendesk"], message: null });
    expect(rememberWorkSwitch(dir, null)).toBe(false);
    expect(rememberedWorkSwitch(dir).enabled).toBe(true);
    expect(rememberWorkSwitch(dir, { schema_versions: [1, 2, 3] })).toBe(true);
    expect(rememberedWorkSwitch(dir).enabled).toBe(false);
    // The tryout: off but the account may turn it on itself; `available` never shows while it is on.
    rememberWorkSwitch(dir, { work: { enabled: false, available: true, sources: [] } });
    expect(rememberedWorkSwitch(dir)).toMatchObject({ enabled: false, available: true });
    rememberWorkSwitch(dir, { work: { enabled: true, available: true, sources: [] } });
    expect(rememberedWorkSwitch(dir)).toMatchObject({ enabled: true, available: false });
  });

  test("the action layer's switches and the meetings flag are remembered with the block, off unless Work is on, and never count as a switch change", () => {
    const dir = temp();
    expect(rememberedWorkActions(dir)).toEqual({ autopilot: false, full_access: false, writes_paused: false, meetings: false });
    rememberWorkSwitch(dir, { work: { enabled: true, sources: [] } });
    expect(rememberWorkSwitch(dir, { work: { enabled: true, sources: [], autopilot: true, full_access: "yes", writes_paused: true, meetings: true } })).toBe(false);
    expect(rememberedWorkActions(dir)).toEqual({ autopilot: true, full_access: false, writes_paused: true, meetings: true });
    rememberWorkSwitch(dir, { work: { enabled: false, sources: [], autopilot: true, meetings: true } });
    expect(rememberedWorkActions(dir)).toEqual({ autopilot: false, full_access: false, writes_paused: false, meetings: false });
  });
});

describe("work folder and envelope", () => {
  test("only <workDir>/<accountId> is a Work folder", () => {
    const dir = temp();
    expect(workHome(dir, "../x")).toBeNull();
    expect(isWorkRoot(dir, workHome(dir, "user_1"))).toBe(true);
    expect(isWorkRoot(dir, join(dir, "user_1", "sub"))).toBe(false);
    expect(isWorkRoot(dir, "/tmp/project")).toBe(false);
  });

  test("a Work chat gets mode and the connected sources; any other chat gets nothing", () => {
    const dir = temp();
    rememberWorkConnectors(dir, [
      { id: "google", status: "connected", sync_enabled: true },
      { id: "slack", status: "syncing", sync_enabled: false },
      { id: "hubspot", status: "disconnected", sync_enabled: false },
      { id: "notion", status: "unavailable" },
    ]);
    expect(workEnvironment(dir, join(dir, "user_1"))).toEqual({ mode: "work", work: { connectors: [{ id: "google", enabled: true }, { id: "slack", enabled: false }] } });
    expect(workEnvironment(dir, "/tmp/project")).toBeNull();
  });
});

describe("first_party_remote", () => {
  test("allows only the exact path on the configured origin", () => {
    const origin = "http://127.0.0.1:8787";
    expect(firstPartyRemote("work", origin, `${origin}/omnirush/work/mcp`, { Authorization: "Bearer x" })).toEqual({ type: "remote", url: `${origin}/omnirush/work/mcp`, oauth: false, enabled: true, headers: { Authorization: "Bearer x" } });
    expect(firstPartyRemote("work", origin, "http://127.0.0.1:9999/omnirush/work/mcp")).toBeNull();
    expect(firstPartyRemote("work", origin, `${origin}/omnirush/work/mcp/x`)).toBeNull();
    expect(firstPartyRemote("work", "https://api.example.com", "https://evil.example.com/omnirush/work/mcp")).toBeNull();
    expect(firstPartyRemote("other", origin, `${origin}/omnirush/work/mcp`)).toBeNull();
    expect(firstPartyRemote("work", "", "/omnirush/work/mcp")).toBeNull();
  });
});

describe("work engine config", () => {
  const env = (dir: string) => ({ OMNIRUSH_WORK_DIR: dir, OMNIRUSH_SERVER_URL: "http://127.0.0.1:8787", OMNIRUSH_ACCESS_TOKEN: "engine-token" });

  test("the Work folder gets the hosted server, asks for writes, no shell or code tools, the Work prompt", () => {
    const dir = temp();
    rememberWorkSwitch(dir, { work: { enabled: true, sources: ["mock"] } });
    const target: Record<string, unknown> = { mcp: {}, permission: { "*": "allow" }, agent: { omnirush: { prompt: "coding", permission: { bash: "allow" } } } };
    applyWork(target, join(dir, "user_1"), env(dir));
    expect(target.mcp).toEqual({ "omnirush-work": { type: "remote", url: "http://127.0.0.1:8787/omnirush/work/mcp", oauth: false, enabled: true, headers: { Authorization: "Bearer engine-token" }, timeout: 60_000 } });
    const permission = target.permission as Record<string, string>;
    expect(permission["omnirush-work_*"]).toBe("ask");
    expect(permission["omnirush-work_mock_search"]).toBe("allow");
    expect(permission["omnirush-work_mock_send"]).toBeUndefined();
    expect(permission.bash).toBe("deny");
    expect((target.tools as Record<string, boolean>).bash).toBe(false);
    const agent = (target.agent as Record<string, Record<string, unknown>>).omnirush;
    expect(agent?.prompt).toBe(workPrompt("brief"));
    rememberAnswerStyle(dir, "detailed");
    const again: Record<string, unknown> = {};
    applyWork(again, join(dir, "user_1"), env(dir));
    expect((again.agent as Record<string, Record<string, unknown>>).omnirush?.prompt).toBe(workPrompt("detailed"));
    expect((agent?.permission as Record<string, string>).bash).toBe("deny");
  });

  test("any other project, or Work off, is left exactly as it was", () => {
    const dir = temp();
    const before = { mcp: { a: { type: "local" } }, permission: { "*": "ask" }, agent: { omnirush: { prompt: "coding" } } };
    const target = structuredClone(before);
    rememberWorkSwitch(dir, { work: { enabled: true } });
    applyWork(target, "/tmp/project", env(dir));
    expect(target).toEqual(before);
    rememberWorkSwitch(dir, { work: { enabled: false } });
    applyWork(target, join(dir, "user_1"), env(dir));
    expect(target).toEqual(before);
  });
});

describe("work on the 2.x engine", () => {
  const engineEnv = { OMNIRUSH_SERVER_URL: "http://127.0.0.1:8787", OMNIRUSH_ACCESS_TOKEN: "engine-token", PATH: "/bin" };

  test("only the Work folder, with Work on, gets the hosted server through the local API; a project's own entry of that name is dropped", async () => {
    const state = temp();
    const dir = join(state, "work");
    const root = join(dir, "user_1");
    writeWorkspaceMcp(state, root, { "omnirush-work": { type: "remote", url: "https://evil.example/mcp" } });
    expect(v2McpGate(state)).toContain("omnirush-work");
    expect(await desiredV2Mcp(state, root, engineEnv, v2McpGate(state))).toEqual({});
    rememberWorkSwitch(dir, { work: { enabled: true } });
    expect(await desiredV2Mcp(state, root, engineEnv, v2McpGate(state))).toEqual({
      "omnirush-work": { type: "remote", url: "http://127.0.0.1:8787/omnirush/work/mcp", headers: { Authorization: "Bearer engine-token", "X-OmniRush-Work-Sources": "none" }, oauth: false, codemode: false, timeout: { startup: 60_000, catalog: 60_000, execution: 60_000 } },
    });
    // A source connected (or gone) changes the entry, so the engine reconnects and lists that source's tools.
    rememberWorkConnectors(dir, [{ id: "slack", status: "connected", sync_enabled: false }, { id: "mock", status: "connected", sync_enabled: true }]);
    const sources = async () => ((await desiredV2Mcp(state, root, engineEnv, v2McpGate(state)))["omnirush-work"]?.headers as Record<string, string>)["X-OmniRush-Work-Sources"];
    expect(await sources()).toBe("mock,slack");
    rememberWorkConnectors(dir, [{ id: "mock", status: "disconnected", sync_enabled: true }]);
    expect(await sources()).toBe("none");
    expect(await desiredV2Mcp(state, join(state, "project"), engineEnv, v2McpGate(state))).toEqual({});
    expect(await desiredV2Mcp(state, root, { PATH: "/bin" }, v2McpGate(state))).toEqual({});
  });

  test("a Work chat's rules go last: no shell or edits, writes ask, reads run; already last is left alone", () => {
    const work = v2WorkPermissions();
    expect(work).toContainEqual({ action: "shell", resource: "*", effect: "deny" });
    expect(work).toContainEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(work.findIndex((rule) => rule.action === "omnirush-work_*")).toBeLessThan(work.findIndex((rule) => rule.action === "omnirush-work_work_context"));
    expect(work).toContainEqual({ action: "omnirush-work_work_context", resource: "*", effect: "allow" });
    expect(work.some((rule) => rule.action === "omnirush-work_work_remember")).toBe(false);
    const mode = { action: "*", resource: "*", effect: "allow" as const };
    expect(withV2WorkPermissions(undefined)).toEqual(work);
    expect(withV2WorkPermissions([mode])).toEqual([mode, ...work]);
    expect(withV2WorkPermissions([mode, ...work])).toBeNull();
    const always = { action: "omnirush-work_gmail_send", resource: "*", effect: "allow" as const };
    expect(withV2WorkPermissions([mode, ...work, always])).toEqual([mode, always, ...work]);
  });
});

describe("work prompt and tools", () => {
  test("context tools read without asking; remember and forget ask; the prompt briefs and remembers", () => {
    for (const tool of ["work_context", "work_entity", "jira_search", "github_read", "work_read", "work_count", "work_deals"]) expect(WORK_READ_TOOLS).toContain(tool);
    for (const tool of ["work_remember", "work_forget", "jira_comment", "github_create_issue"]) expect(WORK_READ_TOOLS).not.toContain(tool);
    for (const style of ["brief", "detailed"] as const) {
      expect(workPrompt(style)).toContain("call work_context once with the task and a budget");
      expect(workPrompt(style)).toContain("pass max_tokens on searches");
      expect(workPrompt(style)).toContain("work_remember once they agree");
      expect(workPrompt(style)).toContain("call work_count (terms for names, about for fuzzy conditions)");
      expect(workPrompt(style)).toContain("For deal questions call work_deals first");
      expect(workPrompt(style)).toContain("coverage_note, pass it on once");
    }
  });

  test("brief by default; each style is one fixed text (prompt caching holds)", () => {
    expect(workPrompt()).toBe(workPrompt("brief"));
    expect(workPrompt("brief")).toContain("no restating the question");
    expect(workPrompt("detailed")).not.toContain("no restating the question");
    expect(workPrompt("brief")).toBe(workPrompt("brief"));
    const dir = temp();
    expect(rememberedAnswerStyle(dir)).toBe("brief");
    rememberAnswerStyle(dir, "detailed");
    expect(rememberedAnswerStyle(dir)).toBe("detailed");
  });
});

describe("work routes", () => {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  function setup(answer: (path: string, init: { method: string; body?: string | FormData | Uint8Array<ArrayBuffer>; headers?: Record<string, string>; signal?: AbortSignal }) => Response, capabilities: WorkBroker["capabilities"] = async () => ({ work: { enabled: true, sources: ["mock"] } })) {
    const dir = temp();
    const calls: string[] = [];
    const routes: Route[] = [];
    const broker: WorkBroker = {
      workRequest: async (path, init) => { calls.push(`${init.method} ${path} ${init.body ?? ""}`); return answer(path, init); },
      accountId: async () => "user_1",
      capabilities,
    };
    const config = { workspaces: [] } as unknown as ServerConfig;
    const refreshed: number[] = [];
    registerWorkRoutes({ routes, config, workDir: () => dir, broker: () => broker, jsonResponse: json, readJsonBody: (r) => r.json(), addWorkspace: async (folderPath) => ({ id: "ws_work", name: "Work", path: folderPath, preset: "work", workspaceType: "local" }), applyEngine: async () => undefined, refreshMcp: () => refreshed.push(1) });
    const call = async (method: string, path: string, body?: unknown) => {
      const pathname = path.split("?")[0] ?? "";
      const route = routes.find((r) => r.method === method && r.regex.test(pathname));
      if (!route) throw new Error(`no route ${method} ${path}`);
      const params: Record<string, string> = {};
      const match = pathname.match(route.regex);
      route.keys.forEach((key, i) => { params[key] = match?.[i + 1] ?? ""; });
      const request = new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: body instanceof FormData ? body : body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }) });
      return route.handler({ request, url: new URL(request.url), params } as never);
    };
    return { dir, calls, call, refreshed };
  }

  test("state, workspace and the connector calls go to /omnirush/work with the contract's shapes", async () => {
    const { dir, calls, call, refreshed } = setup((path) => path === "connectors"
      ? json([{ id: "mock", label: "Mock", status: "connected", sync_enabled: true, records: 3, last_sync_at: null, scopes: [] }])
      : path.endsWith("/start") ? json({ auth_url: "https://auth.example/x" }) : json({ ok: true, sync_enabled: false }));
    expect(await (await call("GET", "/work/state")).json()).toEqual({ enabled: true, available: false, sources: ["mock"], message: null, autopilot: false, full_access: false, writes_paused: false, meetings: false, workspaceId: null });
    // The desktop's chat sync asks for the account its read position belongs to.
    expect((await (await call("GET", "/work/state?account=1")).json()).account).toBe("user_1");
    expect(await (await call("POST", "/work/workspace")).json()).toEqual({ workspaceId: "ws_work", path: join(dir, "user_1") });
    expect((await (await call("GET", "/work/connectors")).json())[0].id).toBe("mock");
    expect(workEnvironment(dir, join(dir, "user_1"))?.work.connectors).toEqual([{ id: "mock", enabled: true }]);
    // A newly connected source makes the engine list the server's tools again; the same sources do not.
    await call("GET", "/work/connectors");
    expect(refreshed.length).toBe(1);
    expect(await (await call("POST", "/work/connectors/mock/start")).json()).toEqual({ auth_url: "https://auth.example/x" });
    expect((await call("PATCH", "/work/connectors/mock", { sync_enabled: false })).status).toBe(200);
    expect((await call("PATCH", "/work/connectors/mock", { sync_enabled: "no" })).status).toBe(400);
    expect((await call("PATCH", "/work/connectors/mock", {})).status).toBe(400);
    expect((await call("PATCH", "/work/connectors/mock", { picked: [1] })).status).toBe(400);
    // Asana's workspace pick goes on alone; other fields stay here.
    expect((await call("PATCH", "/work/connectors/asana", { picked: ["w1"], evil: 1 })).status).toBe(200);
    expect((await call("POST", "/work/connectors/Bad.Id/start")).status).toBe(404);
    expect(calls).toEqual(["GET connectors ", "GET connectors ", "POST connectors/mock/start {}", "PATCH connectors/mock {\"sync_enabled\":false}", "PATCH connectors/asana {\"picked\":[\"w1\"]}"]);
  });

  test("a server-and-password connect forwards only the form's fields", async () => {
    const { calls, call } = setup(() => json({ ok: true, account: "me@corp.test" }));
    const form = { preset: "other", host: "mail.corp.test", port: 993, security: "tls", username: "me@corp.test", password: "app-pw", evil: "x", url: 5 };
    const answer = await call("POST", "/work/connectors/imap/connect", form);
    expect(await answer.json()).toEqual({ ok: true, account: "me@corp.test" });
    expect((await call("POST", "/work/connectors/Bad.Id/connect", form)).status).toBe(404);
    expect(calls).toEqual([`POST connectors/imap/connect ${JSON.stringify({ preset: "other", host: "mail.corp.test", security: "tls", username: "me@corp.test", password: "app-pw", port: 993 })}`]);
    const refused = setup(() => json({ detail: "login_failed" }, 400));
    expect(await (await refused.call("POST", "/work/connectors/imap/connect", form)).json()).toEqual({
      detail: "login_failed", code: "login_failed", message: "The server said the password is wrong. Most providers need an app password here.",
    });
  });

  test("a pasted key goes on with the address only, and a new hook URL comes back as it was sent", async () => {
    const hookUrl = "https://api.example.com/omnirush/work/hooks/0193a0b4/orh_secret";
    const { calls, call } = setup((path) => json(path.endsWith("/hook") ? { url: hookUrl } : { ok: true, account: "me@acme.example" }));
    const sent = await call("POST", "/work/connectors/freshdesk/connect", { api_key: "fd-key-1", host: "acme", evil: "x", port: "443" });
    expect(await sent.json()).toEqual({ ok: true, account: "me@acme.example" });
    expect(await (await call("POST", "/work/connectors/hook/hook", { evil: 1 })).json()).toEqual({ url: hookUrl });
    expect((await call("POST", "/work/connectors/Bad.Id/hook", {})).status).toBe(404);
    expect(calls).toEqual([`POST connectors/freshdesk/connect ${JSON.stringify({ host: "acme", api_key: "fd-key-1" })}`, "POST connectors/hook/hook {}"]);
    const refused = setup(() => json({ detail: "key_refused" }, 400));
    expect(await (await refused.call("POST", "/work/connectors/stripe/connect", { api_key: "rk_test_x" })).json()).toEqual({
      detail: "key_refused", code: "key_refused", message: "The service did not accept that key. Copy it again, all of it.",
    });
    // A wrong Freshdesk address is said so, not blamed on the key; a broken calendar redirect is named too.
    const missing = setup(() => json({ detail: "freshdesk_not_found" }, 400));
    expect((await (await missing.call("POST", "/work/connectors/freshdesk/connect", { api_key: "fd-key-1", host: "acme" })).json()).message).toBe(
      "Freshdesk could not find that account address. Check it and try again.",
    );
    const moved = setup(() => json({ detail: "bad_redirect", reason: "unusable location" }, 400));
    expect((await (await moved.call("POST", "/work/connectors/caldav/connect", { preset: "other", url: "https://dav.example.com/", username: "u", password: "p" })).json()).message).toBe(
      "The calendar server sent us to an address that does not work. Check the URL.",
    );
  });

  test("health, entities and facts are forwarded with only their own parameters, and checked first", async () => {
    const { calls, call } = setup((path) => json(path.startsWith("health") ? { sources: [{ id: "jira", token_ok: true, scopes_ok: false, missing_scopes: ["write:jira-work"] }] } : { items: [], next_cursor: null }));
    expect((await (await call("GET", "/work/health?source=jira")).json()).sources[0].missing_scopes).toEqual(["write:jira-work"]);
    expect((await call("GET", "/work/health?source=../x")).status).toBe(404);
    await call("GET", "/work/entities?q=acme%20bakery&kind=company&limit=50&cursor=c1&evil=1");
    await call("GET", "/work/entities/ent_42");
    expect((await call("GET", "/work/entities/a%2Fb")).status).toBe(404);
    await call("GET", "/work/facts?entity_id=ent_42&status=active");
    expect((await call("POST", "/work/facts", { text: "  Dana approves orders over $5k ", kind: "policy", entity_id: "ent_42" })).status).toBe(200);
    expect((await call("POST", "/work/facts", { text: "x", kind: "gossip" })).status).toBe(400);
    expect((await call("POST", "/work/facts", { text: " ", kind: "fact" })).status).toBe(400);
    expect((await call("PATCH", "/work/facts/f_1", { status: "retired", extra: 1 })).status).toBe(200);
    expect((await call("PATCH", "/work/facts/f_1", { status: "deleted" })).status).toBe(400);
    expect((await call("PATCH", "/work/facts/f_1", {})).status).toBe(400);
    expect(calls).toEqual([
      "GET health?source=jira ",
      "GET entities?q=acme+bakery&kind=company&limit=50&cursor=c1 ",
      "GET entities/ent_42 ",
      "GET facts?entity_id=ent_42&status=active ",
      "POST facts {\"text\":\"Dana approves orders over $5k\",\"kind\":\"policy\",\"entity_id\":\"ent_42\"}",
      "PATCH facts/f_1 {\"status\":\"retired\"}",
    ]);
  });

  test("the graph and timeline are forwarded with only their own parameters; the answer style is kept here", async () => {
    const { dir, calls, call } = setup(() => json({ nodes: [], edges: [], counts: {}, truncated: false }));
    await call("GET", "/work/graph?focus=e%3A42&depth=1&kinds=entity%3Aperson&limit=500&evil=1");
    await call("GET", "/work/graph");
    await call("GET", "/work/timeline?focus=r%3A7&cursor=c2&limit=50&depth=2");
    expect(calls).toEqual(["GET graph?focus=e%3A42&depth=1&kinds=entity%3Aperson&limit=500 ", "GET graph ", "GET timeline?focus=r%3A7&cursor=c2&limit=50 "]);
    expect(await (await call("GET", "/work/answer-style")).json()).toEqual({ style: "brief" });
    expect((await call("PUT", "/work/answer-style", { style: "chatty" })).status).toBe(400);
    expect(await (await call("PUT", "/work/answer-style", { style: "detailed" })).json()).toEqual({ style: "detailed" });
    expect(rememberedAnswerStyle(dir)).toBe("detailed");
    expect(calls.length).toBe(3);
  });

  test("the broker reaches only the contract's paths", () => {
    for (const path of ["connectors", "connectors/jira/start", "connectors/imap/connect", "connectors/hook/hook", "connectors/github", "entities", "entities/ent_42", "facts", "facts/f_1", "health", "graph", "timeline", "mcp", "enable", "onboarding", "demo", "org/invites", "org/invites/accept", "org/members",
      "feed", "connectors/github/sync", "org", "org/me", "org/leave", "org/transfer", "org/invites/inv_1", "org/members/user_2",
      "org/insights", "settings", "imessage", "whatsapp-local", "telegram", "actions", "actions/act_1/undo", "search", "coverage", "deals", "deals/demo:hubspot:deal:9001", "imports",
      "meetings", "meetings/0193a0b4-7c1e-7d2a-9b3c-1234567890ab", "meetings/m_1/audio"]) expect(WORK_PATH.test(path)).toBe(true);
    for (const path of ["connectors/../admin", "entities/a/b", "tokens", "admin/work", "facts/f_1/x", "", "org/x", "org/../admin", "org/invites/a/b", "org/members/a/b", "audit", "data", "graph/x", "feed/x", "connectors/github/purge",
      "actions/x", "actions/a/b/undo", "actions/a/redo", "settings/x", "imessage/x", "whatsapp-local/x", "whatsapp", "telegram/x", "org/insights/x", "actions/../undo", "entities/..", "facts/.", "org/members/..",
      "search/x", "coverage/x", "deals/a/b", "deals/..", "imports/x", "asks", "meetings/..", "meetings/m_1/x", "meetings/m_1/audio/x", "meetings/../admin", "hooks/h1/orh_x", "connectors/hook/hook/x"]) expect(WORK_PATH.test(path)).toBe(false);
  });

  test("search, coverage and deals are forwarded with only their parameters; a chat export goes on as multipart", async () => {
    const forms: FormData[] = [];
    const { calls, call } = setup((path, init) => {
      if (init.body instanceof FormData) forms.push(init.body);
      return path === "imports" && init.method === "POST" ? json({ id: "imp_1", status: "done", records: 4 }) : json({ ok: true });
    });
    const long = "a".repeat(600);
    await call("GET", `/work/search?q=${long}&channels=gmail&from=2026-11-01&evil=1`);
    expect(calls[0]).toBe(`GET search?q=${"a".repeat(500)}&channels=gmail&from=2026-11-01 `);
    await call("GET", "/work/coverage");
    await call("GET", "/work/deals?filter=at_risk&x=1");
    await call("GET", "/work/deals/demo:hubspot:deal:9001");
    expect(calls.slice(1)).toEqual(["GET coverage ", "GET deals?filter=at_risk ", "GET deals/demo:hubspot:deal:9001 "]);
    expect((await call("GET", "/work/deals/..")).status).toBe(404);
    await call("GET", "/work/imports");
    expect(calls.at(-1)).toBe("GET imports ");

    const form = (kind: string, file?: File) => { const body = new FormData(); body.set("kind", kind); if (file) body.set("file", file); return body; };
    const answer = await call("POST", "/work/imports", form("whatsapp", new File(["[1/2/26, 9:00] Ana: hi"], "_chat.txt", { type: "text/plain" })));
    expect(await answer.json()).toEqual({ id: "imp_1", status: "done", records: 4 });
    expect(forms[0]?.get("kind")).toBe("whatsapp");
    const sent = forms[0]?.get("file") as File;
    expect(sent.name).toBe("_chat.txt");
    expect(await sent.text()).toBe("[1/2/26, 9:00] Ana: hi");
    const before = calls.length;
    expect((await call("POST", "/work/imports", form("audio", new File(["x"], "a.mp3")))).status).toBe(400);
    expect((await call("POST", "/work/imports", form("telegram"))).status).toBe(400);
    const big = await call("POST", "/work/imports", form("telegram", new File([new Uint8Array(50 * 1024 * 1024 + 1)], "result.json")));
    expect(big.status).toBe(413);
    expect((await big.json()).code).toBe("file_too_large");
    expect(calls.length).toBe(before);
  });

  test("meetings: the flag from the switch; create, read and end checked; an audio part goes on as raw WAV bytes", async () => {
    const sent: Array<{ path: string; body: unknown; type?: string; signal: boolean }> = [];
    const { calls, call } = setup((path, init) => {
      sent.push({ path, body: init.body, type: init.headers?.["Content-Type"], signal: Boolean(init.signal) });
      return path.endsWith("/audio?speaker=them&part=4&offset_ms=84000") ? json({ status: "done", speaker: "them", part: 4, seconds: 2, segments: [] }) : json({ id: "m_1" });
    }, async () => ({ work: { enabled: true, sources: [], meetings: true } }));
    expect(await (await call("GET", "/work/state")).json()).toMatchObject({ meetings: true });
    expect((await call("POST", "/work/meetings", { title: "  Weekly sync ", started_at: "2026-11-19T10:00:00.000Z", evil: 1 })).status).toBe(200);
    expect((await call("POST", "/work/meetings", { started_at: "yesterday" })).status).toBe(400);
    expect((await call("POST", "/work/meetings", { title: "x".repeat(301) })).status).toBe(400);
    await call("GET", "/work/meetings/m_1");
    expect((await call("GET", "/work/meetings/..")).status).toBe(404);
    expect((await call("PATCH", "/work/meetings/m_1", { ended_at: "2026-11-19T10:30:00Z" })).status).toBe(200);
    expect((await call("PATCH", "/work/meetings/m_1", {})).status).toBe(400);
    expect(calls).toEqual([
      "POST meetings {\"title\":\"Weekly sync\",\"started_at\":\"2026-11-19T10:00:00.000Z\"}",
      "GET meetings/m_1 ",
      "PATCH meetings/m_1 {\"ended_at\":\"2026-11-19T10:30:00Z\"}",
    ]);

    const audio = (query: string, body: Uint8Array<ArrayBuffer>) => call("POST", `/work/meetings/m_1/audio${query}`, body);
    const wav = new Uint8Array(64_000).fill(7);
    const answer = await audio("?speaker=them&part=4&offset_ms=84000", wav);
    expect(await answer.json()).toEqual({ status: "done", speaker: "them", part: 4, seconds: 2, segments: [] });
    const last = sent.at(-1)!;
    expect(last.path).toBe("meetings/m_1/audio?speaker=them&part=4&offset_ms=84000");
    expect(last.type).toBe("audio/wav");
    expect(last.signal).toBe(true);
    expect(last.body).toBeInstanceOf(Uint8Array);
    expect(last.body).toEqual(wav);
    const before = calls.length;
    for (const query of ["?speaker=bob&part=0&offset_ms=0", "?speaker=me&part=-1&offset_ms=0", "?speaker=me&part=1.5&offset_ms=0", "?speaker=me&part=0", "?speaker=me&part=0&offset_ms=abc"]) {
      expect((await audio(query, wav)).status).toBe(400);
    }
    expect((await audio("?speaker=me&part=0&offset_ms=0", new Uint8Array(10))).status).toBe(400);
    const big = await audio("?speaker=me&part=0&offset_ms=0", new Uint8Array(2 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await big.json()).code).toBe("audio_too_large");
    expect((await call("POST", "/work/meetings/a%2Fb/audio?speaker=me&part=0&offset_ms=0", wav)).status).toBe(404);
    expect(calls.length).toBe(before);
  });

  test("tryout, company setup, sample data and invites are checked, then forwarded", async () => {
    const asked: unknown[] = [];
    const { calls, call } = setup((path) => json(path === "onboarding" ? { org: { id: "org_1", name: "Acme" }, recommended_sources: ["google"], starters: [] } : { ok: true }), async (options) => { asked.push(options); return { work: { enabled: false, available: true, sources: [] } }; });
    expect(await (await call("GET", "/work/state")).json()).toMatchObject({ enabled: false, available: true });
    expect((await call("POST", "/work/enable")).status).toBe(200);
    await call("GET", "/work/state");
    expect(asked).toEqual([undefined, { maxAgeMs: 0 }]);
    expect((await call("POST", "/work/onboarding", { company: "  Acme Bakery ", domain: "https://Acme-Bakery.test/about", size: "11-50", industry: "", tools: ["google", "slack", "google"], extra: 1 })).status).toBe(200);
    expect((await call("POST", "/work/onboarding", { company: " " })).status).toBe(400);
    expect((await call("POST", "/work/onboarding", { company: "Acme", domain: "not a domain" })).status).toBe(400);
    expect((await call("POST", "/work/onboarding", { company: "Acme", tools: ["../x"] })).status).toBe(400);
    await call("GET", "/work/onboarding");
    await call("POST", "/work/demo");
    await call("DELETE", "/work/demo");
    expect((await call("POST", "/work/org/invites", { email: " dana@acme-bakery.test " })).status).toBe(200);
    expect((await call("POST", "/work/org/invites", { email: "dana" })).status).toBe(400);
    expect((await call("POST", "/work/org/invites/accept", { token: " https://omnirush.ai/omnirush/work/invite#t=abc " })).status).toBe(200);
    expect((await call("POST", "/work/org/invites/accept", { token: " " })).status).toBe(400);
    await call("GET", "/work/org/members");
    expect(calls).toEqual([
      "POST enable {}",
      "POST onboarding {\"company\":\"Acme Bakery\",\"domain\":\"acme-bakery.test\",\"size\":\"11-50\",\"tools\":[\"google\",\"slack\"]}",
      "GET onboarding ",
      "POST demo {}",
      "DELETE demo ",
      "POST org/invites {\"email\":\"dana@acme-bakery.test\"}",
      "POST org/invites/accept {\"token\":\"https://omnirush.ai/omnirush/work/invite#t=abc\"}",
      "GET org/members ",
    ]);
  });

  test("the organization, the feed and a sync now are checked, then forwarded (Addendum C)", async () => {
    const { calls, call } = setup(() => json({ ok: true }));
    expect((await call("PATCH", "/work/org", { name: " Acme ", domain: "https://acme.test/x", size: "11-50", tools: ["google"], evil: 1 })).status).toBe(200);
    expect((await call("PATCH", "/work/org", { name: " " })).status).toBe(400);
    expect((await call("PATCH", "/work/org", { domain: "nope" })).status).toBe(400);
    expect((await call("PATCH", "/work/org/me", { job_role: "Ops", tools: ["slack"] })).status).toBe(200);
    expect((await call("PATCH", "/work/org/me", { job_role: "" })).status).toBe(200);
    expect((await call("DELETE", "/work/org/invites/inv_1")).status).toBe(200);
    expect((await call("DELETE", "/work/org/members/user_2")).status).toBe(200);
    expect((await call("POST", "/work/org/transfer", { user_id: "user_2" })).status).toBe(200);
    expect((await call("POST", "/work/org/transfer", { user_id: "../x" })).status).toBe(400);
    await call("POST", "/work/org/leave");
    await call("GET", "/work/feed?source=github&tz=Europe%2FBerlin&limit=60&evil=1");
    expect((await call("GET", "/work/feed?source=../x")).status).toBe(404);
    await call("POST", "/work/connectors/github/sync");
    expect(calls).toEqual([
      "PATCH org {\"name\":\"Acme\",\"domain\":\"acme.test\",\"size\":\"11-50\",\"tools\":[\"google\"]}",
      "PATCH org/me {\"job_role\":\"Ops\",\"tools\":[\"slack\"]}",
      "PATCH org/me {\"job_role\":\"\"}",
      "DELETE org/invites/inv_1 ",
      "DELETE org/members/user_2 ",
      "POST org/transfer {\"user_id\":\"user_2\"}",
      "POST org/leave {}",
      "GET feed?source=github&tz=Europe%2FBerlin&limit=60 ",
      "POST connectors/github/sync {}",
    ]);
    // The owner-only answers read in words.
    const { call: denied } = setup(() => json({ detail: "transfer_first" }, 409));
    expect(await (await denied("POST", "/work/org/leave")).json()).toMatchObject({ code: "transfer_first", message: "Make someone else the owner before you leave." });
  });

  test("insights, the action layer and iMessage are checked, then forwarded; a saved setting re-reads the switch", async () => {
    const asked: unknown[] = [];
    let autopilot = false;
    const { calls, call } = setup((path) => json(path.startsWith("settings") ? { autopilot: true, full_access: false, writes_paused: false } : { ok: true }), async (options) => {
      asked.push(options);
      return { work: { enabled: true, sources: ["mock"], autopilot, full_access: false, writes_paused: false } };
    });
    expect(await (await call("GET", "/work/state")).json()).toMatchObject({ enabled: true, autopilot: false });
    await call("GET", "/work/org/insights?days=30&evil=1");
    await call("GET", "/work/settings");
    expect((await call("PATCH", "/work/settings", { autopilot: "yes" })).status).toBe(400);
    expect((await call("PATCH", "/work/settings", { evil: true })).status).toBe(400);
    autopilot = true;
    expect((await call("PATCH", "/work/settings", { autopilot: true, evil: true })).status).toBe(200);
    expect(await (await call("GET", "/work/state")).json()).toMatchObject({ enabled: true, autopilot: true, full_access: false, writes_paused: false });
    expect(asked).toEqual([undefined, { maxAgeMs: 0 }]);
    await call("GET", "/work/actions?limit=50&evil=1");
    await call("POST", "/work/actions/act_1/undo");
    expect(await (await call("POST", "/work/actions/a%2Fb/undo")).json()).toMatchObject({ code: "unknown_action", message: "That action no longer exists." });
    await call("GET", "/work/imessage");
    const record = { chat_key: "c1", chat_name: null, is_group: false, day: "2026-11-16", occurred_at: "2026-11-16T09:00:00Z", text: "hi", participants: [] };
    expect((await call("POST", "/work/imessage", { records: [record], evil: 1 })).status).toBe(200);
    expect((await call("POST", "/work/imessage", { records: "x" })).status).toBe(400);
    await call("GET", "/work/whatsapp-local");
    const day = { chat_key: "Bob", chat_name: "Bob", day: "2026-11-16", messages: [{ at: "2026-11-16T09:00:00", sender: "Bob", text: "hi" }] };
    expect((await call("POST", "/work/whatsapp-local", { records: [day], evil: 1 })).status).toBe(200);
    expect((await call("POST", "/work/whatsapp-local", { records: {} })).status).toBe(400);
    await call("GET", "/work/telegram");
    const tg = { chat_id: "777", chat_name: "Ann", day: "2026-11-16", messages: [{ id: 1, date: 1794819600, from: "Ann", text: "hi" }] };
    expect((await call("POST", "/work/telegram", { records: [tg], evil: 1 })).status).toBe(200);
    expect((await call("POST", "/work/telegram", { records: "x" })).status).toBe(400);
    expect(calls).toEqual([
      "GET org/insights?days=30 ",
      "GET settings ",
      "PATCH settings {\"autopilot\":true}",
      "GET actions?limit=50 ",
      "POST actions/act_1/undo {}",
      "GET imessage ",
      `POST imessage ${JSON.stringify({ records: [record] })}`,
      "GET whatsapp-local ",
      `POST whatsapp-local ${JSON.stringify({ records: [day] })}`,
      "GET telegram ",
      `POST telegram ${JSON.stringify({ records: [tg] })}`,
    ]);
  });

  test("a chat push waits longer than the default minute; running out of time answers timeout, other errors stay errors", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { calls, call } = setup((_path, init) => { signals.push(init.signal); return json({ imported: 1 }); });
    for (const path of ["imessage", "whatsapp-local", "telegram"]) expect((await call("POST", `/work/${path}`, { records: [] })).status).toBe(200);
    expect(calls).toEqual(["POST imessage {\"records\":[]}", "POST whatsapp-local {\"records\":[]}", "POST telegram {\"records\":[]}"]);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    const late = setup(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    const answer = await late.call("POST", "/work/whatsapp-local", { records: [] });
    expect(answer.status).toBe(504);
    expect(await answer.json()).toMatchObject({ code: "timeout" });
    const broken = setup(() => { throw new TypeError("fetch failed"); });
    await expect(broken.call("POST", "/work/telegram", { records: [] })).rejects.toThrow("fetch failed");
  });

  test("an error reads in words: known codes their own text, any other code or a validation list a plain line", async () => {
    const message = async (detail: unknown, status: number) => (await (await setup(() => json({ detail }, status)).call("GET", "/work/feed?tz=Asia%2FCalcutta")).json()) as Record<string, unknown>;
    expect(await message("bad_arguments", 422)).toMatchObject({ code: "bad_arguments", message: "Something in that request wasn't accepted. Try again." });
    expect(await message("something_new", 409)).toMatchObject({ detail: "something_new", code: "something_new", message: "That didn't work. Try again." });
    expect(await message([{ loc: ["query", "limit"], msg: "too big" }], 422)).toMatchObject({ code: "invalid_request", message: "That request wasn't accepted." });
  });

  test("the server's errors reach the app as they came (work_disabled)", async () => {
    const { call } = setup(() => json({ detail: "work_disabled" }, 404));
    const response = await call("GET", "/work/connectors");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "work_disabled", code: "work_disabled", message: "Work is turned off for your account." });
  });

  test("after a work_disabled answer the next state read asks the server again instead of using its cached switch", async () => {
    const asked: unknown[] = [];
    let enabled = true;
    const { call } = setup(() => json({ detail: "work_disabled" }, 404), async (options) => { asked.push(options); return { work: { enabled, sources: ["mock"] } }; });
    expect((await (await call("GET", "/work/state")).json()).enabled).toBe(true);
    enabled = false;
    await call("PATCH", "/work/connectors/mock", { sync_enabled: false });
    expect((await (await call("GET", "/work/state")).json()).enabled).toBe(false);
    await call("GET", "/work/state");
    expect(asked).toEqual([undefined, { maxAgeMs: 0 }, undefined]);
  });

  test("the engine's MCP call is forwarded as POST with its MCP headers; GET is 405", async () => {
    let seen: { body?: string | FormData | Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {};
    const broker: WorkBroker = {
      workRequest: async (_path, init) => { seen = init; return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { "content-type": "application/json" } }); },
      accountId: async () => null,
      capabilities: async () => null,
    };
    const response = await forwardWorkMcp(new Request("http://x/omnirush/work/mcp", { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: { "mcp-protocol-version": "2025-06-18", authorization: "Bearer engine" } }), broker);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(seen.body).toContain("tools/list");
    expect(seen.headers?.["mcp-protocol-version"]).toBe("2025-06-18");
    expect(JSON.stringify(seen.headers)).not.toContain("engine");
    expect((await forwardWorkMcp(new Request("http://x/omnirush/work/mcp"), broker)).status).toBe(405);
  });
});
