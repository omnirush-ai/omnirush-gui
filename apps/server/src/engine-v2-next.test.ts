import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSessionPluginActive, OMNIRUSH_SESSION_PLUGIN_ID } from "./engine-v2-preview.js";
import { importMissingV1Chats, readMigratedSessions, seedV2StoreFromV1 } from "./engine-v2-migration.js";
import { pluginDirectories } from "./managed-opencode-v2.js";
import sessionPlugin from "./opencode-plugins/omnirush-session-next.js";
import { startsV1Chat } from "./server.js";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "v2-next-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a 1.x store seeds the 2.x store once, keeps a backup and stays untouched", () => withDir(async (dir) => {
  const v1 = join(dir, "v1", "opencode.db");
  await Bun.write(join(dir, "v1", ".keep"), "");
  const db = new Database(v1, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY)");
  db.run("INSERT INTO session VALUES ('ses_a'), ('ses_b')");
  const root = join(dir, "v2", "state");
  const seeded = await seedV2StoreFromV1(root, v1, new Date("2026-10-25T00:00:00Z"));
  db.close();
  expect(seeded?.sessions.sort()).toEqual(["ses_a", "ses_b"]);
  expect(existsSync(seeded!.backup)).toBe(true);
  // The copy holds the rows still in the WAL.
  const copy = new Database(join(root, "opencode.db"), { readonly: true });
  expect(copy.query("SELECT count(*) AS n FROM session").get()).toEqual({ n: 2 });
  copy.close();
  expect(readMigratedSessions(root)).toEqual(new Set(["ses_a", "ses_b"]));
  // Nothing was written beside the 1.x store.
  expect((await readdir(join(dir, "v1"))).filter((name) => !/^(\.keep|opencode\.db(-wal|-shm)?)$/.test(name))).toEqual([]);
  // Never again once the 2.x store exists.
  expect(await seedV2StoreFromV1(root, v1)).toBeNull();
  expect(await seedV2StoreFromV1(join(dir, "other"), join(dir, "missing.db"))).toBeNull();
  expect(readMigratedSessions(join(dir, "other"))).toEqual(new Set());
}));

test("the session plugin names the chat on gateway requests and blanks secrets in shells", async () => {
  const hooks: Record<string, (event: never) => Promise<void> | void> = {};
  const modelHooks: { providerID?: string; callback: (event: never) => Promise<void> }[] = [];
  process.env.OMNIRUSH_USER_XDG_DATA_HOME = "/home/me/.data";
  process.env.OMNIRUSH_USER_XDG_STATE_HOME = "";
  try {
    await sessionPlugin.setup({
      session: {
        get: async ({ sessionID }) => ({ id: sessionID, parentID: sessionID === "ses_child" ? "ses_parent" : undefined, model: sessionID === "ses_claude" ? { id: "claude-opus-5-5", providerID: "omnirush-claude" } : { id: "gpt-6-astra" }, location: { directory: "/p" } }),
        hook: async (name, callback, options) => { modelHooks.push({ providerID: options?.providerID, callback: callback as never }); },
      },
      shell: { hook: async (name, callback) => { hooks[name] = callback as never; } },
    });
  } finally {
    delete process.env.OMNIRUSH_USER_XDG_DATA_HOME;
    delete process.env.OMNIRUSH_USER_XDG_STATE_HOME;
  }
  const request = async (sessionID: string, kind: string, providerID = "omnirush", agent?: string) => {
    const event = { sessionID, kind, agent, model: { id: "cheap", providerID }, headers: {} as Record<string, string> };
    for (const hook of modelHooks) if (!hook.providerID || hook.providerID === providerID) await (hook.callback as (e: typeof event) => Promise<void>)(event);
    return event.headers;
  };
  expect(await request("ses_main", "primary")).toEqual({ "x-omnirush-session-id": "ses_main" });
  expect(await request("ses_child", "primary")).toEqual({ "x-omnirush-session-id": "ses_child", "x-parent-session-id": "ses_parent" });
  expect(await request("ses_main", "title")).toEqual({ "x-omnirush-session-id": "ses_main", "x-omnirush-title": "1", "x-omnirush-chat-model": "gpt-6-astra" });
  expect(await request("ses_main", "primary", "openai")).toEqual({});
  // A Claude chat: its turns name its folder and agent; its title (on the gateway's title model) names no chat.
  expect(await request("ses_claude", "primary", "omnirush-claude", "build")).toEqual({ "x-omnirush-agent": "build", "x-omnirush-directory": "/p" });
  expect(await request("ses_claude", "compaction", "omnirush-claude", "build")).toMatchObject({ "x-omnirush-agent": "compaction" });
  expect(await request("ses_claude", "title")).toEqual({});
  const env: Record<string, string | undefined> = { OPENCODE_PASSWORD: "pw", OMNIRUSH_POLICY_TOKEN: "t", XDG_DATA_HOME: "/engine/data", XDG_STATE_HOME: "/engine/state", PATH: "/bin" };
  await (hooks["create.before"] as (e: { env: typeof env }) => void)({ env });
  expect(env).toMatchObject({ OPENCODE_PASSWORD: "", OMNIRUSH_POLICY_TOKEN: "", XDG_DATA_HOME: "/home/me/.data", XDG_STATE_HOME: undefined, PATH: "/bin" });
});

test("chats do not start unless the session plugin is active", async () => {
  expect(sessionPlugin.id).toBe(OMNIRUSH_SESSION_PLUGIN_ID);
  const engine = (data: unknown, status = 200) => ({ fetchJson: async () => ({ status, json: { data } }) });
  await assertSessionPluginActive(engine([{ id: "omnirush.session", state: { status: "active" } }]), "/p");
  await expect(assertSessionPluginActive(engine([{ id: "opencode.agent", state: { status: "active" } }]), "/p")).rejects.toThrow(/not active/);
  await expect(assertSessionPluginActive(engine([{ id: "omnirush.session", state: { status: "failed" } }]), "/p")).rejects.toThrow(/not active/);
  await expect(assertSessionPluginActive(engine([], 500), "/p")).rejects.toThrow(/not active/);
});

test("each plugin module gets a directory the 2.x engine loads", () => withDir(async (dir) => {
  const [plugin] = await pluginDirectories(dir, ["/app/opencode-plugins/omnirush-session-next.js"]);
  expect(plugin).toBe(join(dir, "omnirush-session-next"));
  expect(await readFile(join(plugin!, "server.js"), "utf8")).toBe('export { default } from "file:///app/opencode-plugins/omnirush-session-next.js";\n');
}));

test("the 1.x engine starts no chat and no turn", () => {
  for (const path of ["/session", "/opencode/session", "/session/ses_1/prompt_async", "/session/ses_1/message", "/session/ses_1/command", "/session/ses_1/shell", "/session/ses_1/summarize", "/session/ses_1/fork"]) {
    expect(startsV1Chat("POST", path)).toBe(true);
  }
  for (const [method, path] of [["GET", "/session"], ["GET", "/session/ses_1/message"], ["POST", "/session/ses_1/abort"], ["DELETE", "/session/ses_1"], ["POST", "/session/ses_1/permissions/p1"]]) {
    expect(startsV1Chat(method!, path!)).toBe(false);
  }
});

test("MCP on the 2.x engine: the gate lists the server list's ids, entries stay direct tools without the app's secrets", () => withDir(async (dir) => {
  const { v2McpConfig, v2McpGate, desiredV2Mcp } = await import("./engine-v2-mcp.js");
  const { writePolicyFile } = await import("./mcp-allow/mcp-allow.mjs");
  const { mcpPolicyFile, writeWorkspaceMcp } = await import("./mcp-allow/state.js");
  expect(v2McpGate(dir)).toEqual([]);
  const engineEnv = { OPENCODE_PASSWORD: "pw", OMNIRUSH_POLICY_TOKEN: "tok", PATH: "/bin" };
  expect(v2McpConfig({ type: "local", command: ["node", "s.js"], environment: { A: "1" }, timeout: 2000 }, engineEnv)).toEqual({
    type: "local", command: ["node", "s.js"], environment: { A: "1", OPENCODE_PASSWORD: "", OMNIRUSH_POLICY_TOKEN: "" },
    codemode: false, timeout: { startup: 2000, catalog: 2000, execution: 2000 },
  });
  expect(v2McpConfig({ type: "remote", url: "https://x.test/mcp", oauth: false, enabled: false }, engineEnv)).toEqual({ type: "remote", url: "https://x.test/mcp", oauth: false, disabled: true, codemode: false });
  expect(v2McpConfig({ type: "local", command: [] }, engineEnv)).toBeNull();
  writePolicyFile(mcpPolicyFile(dir), JSON.parse(await readFile(join(import.meta.dir, "mcp-allow", "mcp-policy.fixture.json"), "utf8")));
  expect(v2McpGate(dir)).toContain("memory");
  const root = join(dir, "proj");
  writeWorkspaceMcp(dir, root, { memory: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory"] }, rogue: { type: "local", command: ["sh", "-c", "curl evil"] } });
  const desired = await desiredV2Mcp(dir, root, engineEnv, v2McpGate(dir));
  expect(Object.keys(desired)).toEqual(["memory"]);
  expect(desired.memory).toMatchObject({ type: "local", codemode: false });
  expect((desired.memory!.environment as Record<string, string>).OPENCODE_PASSWORD).toBe("");
  // Not on the gate: left out.
  expect(await desiredV2Mcp(dir, root, engineEnv, [])).toEqual({});
}));

test("steering and automatic compaction use the 2.x engine's routes", async () => {
  const { createSteerTracker } = await import("./turn-steer.js");
  const { desktopAutoCompactEngine } = await import("./auto-compact-engine.js");
  const calls: string[] = [];
  let last: unknown = { type: "assistant", id: "msg_a" };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/session/active") return Response.json({ data: { ses_busy: {} } });
    if (url.pathname.endsWith("/message")) return Response.json({ data: [last] });
    if (url.pathname.endsWith("/compact")) return Response.json({ data: { id: "cmp_1" } });
    return new Response(null, { status: 204 });
  };
  const target = { baseUrl: "http://127.0.0.1:1", headers: [], search: "", engine: "v2" as const };
  const tracker = createSteerTracker(target, { fetchImpl: fetchImpl as typeof fetch });
  expect(await tracker.classify("ses_idle")).toMatchObject({ steer: false, reason: "idle" });
  expect(await tracker.classify("ses_busy")).toMatchObject({ steer: true, reason: "working" });
  last = { type: "compaction" };
  expect(await tracker.classify("ses_busy")).toMatchObject({ steer: false, reason: "compacting" });
  const engine = desktopAutoCompactEngine(target, "ses_busy", fetchImpl as never);
  expect(await engine.busy()).toBe(true);
  await engine.removeMessage!("cmp_1_summary");
  await engine.abort!();
  expect(calls).toContain("DELETE /api/session/ses_busy/inbox/cmp_1");
  expect(calls).toContain("POST /api/session/ses_busy/interrupt");
});

test("the quota wrap on the 2.x engine: asked only while idle, an accepted offer compacts, a declined one is gone", async () => {
  const { createV2BudgetWrap } = await import("./engine-v2-budget-wrap.js");
  const asked: string[] = [];
  const compacted: string[] = [];
  let busy = true;
  let answer = "accept";
  const wrap = createV2BudgetWrap({
    control: async (_id, args) => { asked.push(`${args.sessionID}:${args.operation}`); return args.operation === "offer" ? answer : "ok"; },
    busy: async () => busy,
    compact: async (sessionId) => { compacted.push(sessionId); },
    sleep: async () => { busy = false; },
    idleSettleMs: 0,
  });
  const offer = new Headers({ "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "off_1" });
  wrap.noteResponse("ses_a", offer);
  for (let i = 0; i < 50 && compacted.length === 0; i += 1) await Bun.sleep(1);
  expect(compacted).toEqual(["ses_a"]);
  expect(asked).toEqual(["ses_a:offer", "ses_a:finish"]);
  expect(wrap.contextWrap("ses_a")).toBe(false);

  answer = "decline";
  asked.length = 0;
  busy = false;
  wrap.noteResponse("ses_b", new Headers({ "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "off_2" }));
  for (let i = 0; i < 50 && asked.length === 0; i += 1) await Bun.sleep(1);
  await Bun.sleep(5);
  expect(asked).toEqual(["ses_b:offer"]);
  expect(compacted).toEqual(["ses_a"]);
});

test("office attachments reach the 2.x engine as their text; other files stay files", () => withDir(async (dir) => {
  const { convertOfficeAttachments } = await import("./engine-v2-attachments.js");
  const made = Bun.spawnSync(["python3", "-c", `
import zipfile, sys
d = sys.argv[1]
zipfile.ZipFile(d + "/doc.docx", "w").writestr("word/document.xml", "<w:document><w:body><w:t>DOCX-4711</w:t></w:body></w:document>")
zipfile.ZipFile(d + "/deck.pptx", "w").writestr("ppt/slides/slide1.xml", "<p:sld><a:t>PPTX-4712</a:t></p:sld>")
z = zipfile.ZipFile(d + "/book.xlsx", "w")
z.writestr("xl/workbook.xml", '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
z.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
z.writestr("xl/sharedStrings.xml", "<sst><si><t>XLSX-4713</t></si></sst>")
z.writestr("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>')
z.close()
`, dir]);
  if (made.exitCode !== 0) return;
  const docx = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${(await Bun.file(join(dir, "doc.docx")).bytes()).toBase64()}`;
  const body = await convertOfficeAttachments({
    text: "read these",
    files: [
      { uri: docx, name: "doc.docx" },
      { uri: `file://${join(dir, "deck.pptx")}`, name: "deck.pptx" },
      { uri: `file://${join(dir, "book.xlsx")}`, name: "book.xlsx" },
      { uri: "data:text/plain;base64,aGk=", name: "note.txt" },
    ],
  }, dir);
  expect(String(body.text)).toStartWith("read these");
  for (const sentinel of ["DOCX-4711", "PPTX-4712", "XLSX-4713"]) expect(String(body.text)).toContain(sentinel);
  expect(body.files).toEqual([{ uri: "data:text/plain;base64,aGk=", name: "note.txt" }]);
  const plain = { text: "no office", files: [{ uri: "data:image/png;base64,AA==", name: "a.png" }] };
  expect(await convertOfficeAttachments(plain, dir)).toBe(plain);
}));

test("the org's cloud connector reaches the 2.x engine only when it is set up and gated", () => withDir(async (dir) => {
  const { cloudMcpEntry, desiredV2Mcp, v2McpGate, CLOUD_MCP_NAME } = await import("./engine-v2-mcp.js");
  const cloud = { type: "remote", url: "https://den.example.com/mcp", headers: { Authorization: "Bearer org-token" }, timeout: 3000 };
  expect(cloudMcpEntry({ [CLOUD_MCP_NAME]: cloud })).toEqual(cloud);
  expect(cloudMcpEntry({ [CLOUD_MCP_NAME]: { ...cloud, enabled: false } })).toBeNull();
  expect(cloudMcpEntry({ [CLOUD_MCP_NAME]: { ...cloud, url: "http://den.example.com/mcp" } })).toBeNull();
  expect(cloudMcpEntry({ [CLOUD_MCP_NAME]: { ...cloud, url: "http://127.0.0.1:8790/mcp" } })).not.toBeNull();
  expect(cloudMcpEntry({})).toBeNull();
  expect(v2McpGate(dir)).not.toContain(CLOUD_MCP_NAME);
  expect(v2McpGate(dir, process.env, true)).toContain(CLOUD_MCP_NAME);
  const root = join(dir, "proj");
  const engineEnv = { OPENCODE_PASSWORD: "pw" };
  expect(await desiredV2Mcp(dir, root, engineEnv, [CLOUD_MCP_NAME], cloud)).toEqual({
    [CLOUD_MCP_NAME]: { type: "remote", url: "https://den.example.com/mcp", headers: { Authorization: "Bearer org-token" }, codemode: false, timeout: { startup: 3000, catalog: 3000, execution: 3000 } },
  });
  expect(await desiredV2Mcp(dir, root, engineEnv, [], cloud)).toEqual({});
}));

test("archived chats are the app's own flag, applied to session reads", () => withDir(async (dir) => {
  const { archivedAt, setArchived, withArchived } = await import("./archived-chats.js");
  expect(archivedAt(dir, "ses_a")).toBeUndefined();
  setArchived(dir, "ses_a", 1_700);
  expect(archivedAt(dir, "ses_a")).toBe(1_700);
  expect(withArchived(dir, { id: "ses_a", time: { created: 1 } })).toEqual({ id: "ses_a", time: { created: 1, archived: 1_700 } });
  // The engine's own value never wins over the app's flag.
  expect(withArchived(dir, { id: "ses_b", time: { created: 1, archived: 5 } })).toEqual({ id: "ses_b", time: { created: 1 } });
  setArchived(dir, "ses_a", null);
  expect(withArchived(dir, { id: "ses_a", time: { created: 1 } })).toEqual({ id: "ses_a", time: { created: 1 } });
}));

test("the 2.x engine's agent prompt: its own tool names, no todo list; nothing else changes", async () => {
  const { OMNIRUSH_AGENT_PROMPT, V2_PROMPT_EDITS, v2AgentPrompt } = await import("./omnirush-agent-prompt.js");
  const { buildOmniRushV2Instructions } = await import("./opencode-v2-instructions.js");
  const v1 = OMNIRUSH_AGENT_PROMPT;
  const v2 = v2AgentPrompt(v1);
  // Every 1.x sentence it adapts is in the 1.x text (the desktop's prompt has no web-off note).
  for (const [from] of V2_PROMPT_EDITS) if (!from.startsWith("There is no web search")) expect(v1.includes(from)).toBe(true);
  for (const word of ["apply_patch", "bash tool", "task tool", "task-tool", "todo list", "web_search"]) expect(v2.includes(word)).toBe(false);
  // The same text otherwise: only the pinned edits differ.
  let back = v2;
  for (const [from, to] of V2_PROMPT_EDITS) if (to) back = back.split(to).join(from);
  expect(back.replace(V2_PROMPT_EDITS[1][0], "")).toBe(v1.replace(V2_PROMPT_EDITS[1][0], ""));
  const instructions = JSON.stringify(buildOmniRushV2Instructions(false));
  expect(instructions).toContain("smaller patch (or edit) calls");
  for (const word of ["apply_patch", "bash tool", "task tool", "todo list"]) expect(instructions.includes(word)).toBe(false);
});

test("1.x chats made after the 2.x store was seeded come over once; chats the 2.x store has or had stay as they are", () => withDir(async (dir) => {
  const v1 = join(dir, "v1", "opencode.db");
  await Bun.write(join(dir, "v1", ".keep"), "");
  const old = new Database(v1, { create: true });
  old.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)");
  old.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, extra_v1 TEXT)");
  old.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
  old.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
  // ses_a came over at the seed and goes on in 2.x; ses_d came over and was deleted there; ses_c was made in 1.x later.
  for (const id of ["ses_a", "ses_c", "ses_d"]) {
    old.run(`INSERT INTO session VALUES ('${id}', 'p1', '/w', '${id} in 1.x', 'x')`);
    old.run(`INSERT INTO message VALUES ('msg_${id}', '${id}', 1, 1, '{}')`);
    old.run(`INSERT INTO part VALUES ('prt_${id}', 'msg_${id}', '${id}', 1, 1, '{}')`);
  }
  old.close();
  const root = join(dir, "v2", "state");
  const seeded = await seedV2StoreFromV1(root, v1, new Date("2026-10-25T00:00:00Z"));
  expect(seeded?.sessions.sort()).toEqual(["ses_a", "ses_c", "ses_d"]);
  // As 3.7.6 left it: the seed list without ses_c (made in 3.7.5 afterwards), the engine's migration done.
  await Bun.write(join(root, "v1-migrated-sessions.json"), JSON.stringify({ from: "1.18.32", at: "2026-10-25", backup: seeded!.backup, sessions: ["ses_a", "ses_d"] }));
  const store = new Database(join(root, "opencode.db"));
  store.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT)");
  store.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
  store.run("INSERT INTO session_v2 VALUES ('ses_a', 'continued in 2.x'), ('ses_b', 'made in 2.x')");
  store.run("INSERT INTO kv VALUES ('migration.v1-v2', '{\"phase\":\"completed\"}', 1, 1)");
  store.run("DELETE FROM session WHERE id = 'ses_c'");
  store.close();

  const imported = await importMissingV1Chats(root, v1, new Date("2026-10-26T00:00:00Z"));
  expect(imported?.sessions).toEqual(["ses_c"]);
  expect(existsSync(imported!.backup)).toBe(true);
  const after = new Database(join(root, "opencode.db"), { readonly: true });
  expect(after.query("SELECT id, title FROM session").all()).toEqual([{ id: "ses_c", title: "ses_c in 1.x" }]);
  expect(after.query("SELECT session_id FROM message").all()).toEqual([{ session_id: "ses_c" }]);
  expect(after.query("SELECT session_id FROM part").all()).toEqual([{ session_id: "ses_c" }]);
  expect(after.query("SELECT id, title FROM session_v2 ORDER BY id").all()).toEqual([{ id: "ses_a", title: "continued in 2.x" }, { id: "ses_b", title: "made in 2.x" }]);
  expect(after.query("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()).toEqual({ value: "{\"phase\":\"sessions\"}" });
  after.close();
  expect(readMigratedSessions(root)).toEqual(new Set(["ses_a", "ses_d", "ses_c"]));
  // Once over, never again; nothing to do without a 1.x store.
  expect(await importMissingV1Chats(root, v1)).toBeNull();
  expect(await importMissingV1Chats(root, join(dir, "missing.db"))).toBeNull();
}));

test("a 2.x store made without a 1.x store gets the 1.x tables for chats a 1.x app made later", () => withDir(async (dir) => {
  const v1 = join(dir, "v1", "opencode.db");
  await Bun.write(join(dir, "v1", ".keep"), "");
  const old = new Database(v1, { create: true });
  old.run("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)");
  old.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)");
  old.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL)");
  old.run("INSERT INTO session VALUES ('ses_new', '/w'), ('ses_twice', '/w')");
  old.run("INSERT INTO message VALUES ('msg_1', 'ses_new', '{}')");
  old.close();
  const root = join(dir, "v2", "state");
  await Bun.write(join(root, ".keep"), "");
  const store = new Database(join(root, "opencode.db"), { create: true });
  store.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)");
  store.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
  // A chat 3.7.5 copied from the 2.x store into 1.x keeps its id: it is already here.
  store.run("INSERT INTO session_v2 VALUES ('ses_twice')");
  store.close();
  expect((await importMissingV1Chats(root, v1))?.sessions).toEqual(["ses_new"]);
  const after = new Database(join(root, "opencode.db"), { readonly: true });
  expect(after.query("SELECT id FROM session").all()).toEqual([{ id: "ses_new" }]);
  expect(after.query("SELECT id FROM message").all()).toEqual([{ id: "msg_1" }]);
  expect(after.query("SELECT value FROM kv").get()).toEqual({ value: "{\"phase\":\"sessions\"}" });
  after.close();
}));
