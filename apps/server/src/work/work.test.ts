import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { firstPartyRemote } from "../mcp-allow/mcp-allow.mjs";
import { applyWork, v2WorkPermissions, withV2WorkPermissions } from "./engine.js";
import { desiredV2Mcp, v2McpGate } from "../engine-v2-mcp.js";
import { writeWorkspaceMcp } from "../mcp-allow/state.js";
import { WORK_PROMPT } from "./prompt.js";
import { forwardWorkMcp, registerWorkRoutes, type WorkBroker } from "./routes.js";
import { isWorkRoot, rememberedWorkSwitch, rememberWorkConnectors, rememberWorkSwitch, WORK_PATH, WORK_READ_TOOLS, workEnvironment, workHome } from "./work.js";
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
    expect(agent?.prompt).toBe(WORK_PROMPT);
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
    for (const tool of ["work_context", "work_entity", "jira_search", "github_read"]) expect(WORK_READ_TOOLS).toContain(tool);
    for (const tool of ["work_remember", "work_forget", "jira_comment", "github_create_issue"]) expect(WORK_READ_TOOLS).not.toContain(tool);
    expect(WORK_PROMPT).toContain("call work_context");
    expect(WORK_PROMPT).toContain("work_remember once they agree");
  });
});

describe("work routes", () => {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  function setup(answer: (path: string, init: { method: string; body?: string; headers?: Record<string, string> }) => Response, capabilities: WorkBroker["capabilities"] = async () => ({ work: { enabled: true, sources: ["mock"] } })) {
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
      const request = new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return route.handler({ request, url: new URL(request.url), params } as never);
    };
    return { dir, calls, call, refreshed };
  }

  test("state, workspace and the connector calls go to /omnirush/work with the contract's shapes", async () => {
    const { dir, calls, call, refreshed } = setup((path) => path === "connectors"
      ? json([{ id: "mock", label: "Mock", status: "connected", sync_enabled: true, records: 3, last_sync_at: null, scopes: [] }])
      : path.endsWith("/start") ? json({ auth_url: "https://auth.example/x" }) : json({ ok: true, sync_enabled: false }));
    expect(await (await call("GET", "/work/state")).json()).toEqual({ enabled: true, available: false, sources: ["mock"], message: null, workspaceId: null });
    expect(await (await call("POST", "/work/workspace")).json()).toEqual({ workspaceId: "ws_work", path: join(dir, "user_1") });
    expect((await (await call("GET", "/work/connectors")).json())[0].id).toBe("mock");
    expect(workEnvironment(dir, join(dir, "user_1"))?.work.connectors).toEqual([{ id: "mock", enabled: true }]);
    // A newly connected source makes the engine list the server's tools again; the same sources do not.
    await call("GET", "/work/connectors");
    expect(refreshed.length).toBe(1);
    expect(await (await call("POST", "/work/connectors/mock/start")).json()).toEqual({ auth_url: "https://auth.example/x" });
    expect((await call("PATCH", "/work/connectors/mock", { sync_enabled: false })).status).toBe(200);
    expect((await call("PATCH", "/work/connectors/mock", { sync_enabled: "no" })).status).toBe(400);
    expect((await call("POST", "/work/connectors/Bad.Id/start")).status).toBe(404);
    expect(calls).toEqual(["GET connectors ", "GET connectors ", "POST connectors/mock/start {}", "PATCH connectors/mock {\"sync_enabled\":false}"]);
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

  test("the broker reaches only the contract's paths", () => {
    for (const path of ["connectors", "connectors/jira/start", "connectors/github", "entities", "entities/ent_42", "facts", "facts/f_1", "health", "mcp", "enable", "onboarding", "demo", "org/invites", "org/members"]) expect(WORK_PATH.test(path)).toBe(true);
    for (const path of ["connectors/../admin", "entities/a/b", "tokens", "admin/work", "facts/f_1/x", "", "org", "org/../admin", "audit", "data"]) expect(WORK_PATH.test(path)).toBe(false);
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
    await call("GET", "/work/org/members");
    expect(calls).toEqual([
      "POST enable {}",
      "POST onboarding {\"company\":\"Acme Bakery\",\"domain\":\"acme-bakery.test\",\"size\":\"11-50\",\"tools\":[\"google\",\"slack\"]}",
      "GET onboarding ",
      "POST demo {}",
      "DELETE demo ",
      "POST org/invites {\"email\":\"dana@acme-bakery.test\"}",
      "GET org/members ",
    ]);
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
    let seen: { body?: string; headers?: Record<string, string> } = {};
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
