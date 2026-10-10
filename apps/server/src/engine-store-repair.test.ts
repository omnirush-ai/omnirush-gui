import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { engineStorePath, repairEngineStore, repairEngineStoreBeforeStart, repairEngineStoresAfterServerError, resetEngineStoreRepairState } from "./engine-store-repair.js";

// The engine's (1.18.32) own tables, as it creates them.
const SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, icon_url text, icon_url_override text, icon_color text,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_initialized integer, sandboxes text NOT NULL, commands text);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL,
  path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
  summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

let dir: string;
let file: string;

function store(): Database {
  return new Database(file);
}

function addSession(db: Database, id: string, columns: Record<string, string | null> = {}) {
  const row: Record<string, string | number | null> = {
    id, project_id: "global", slug: id, directory: "/work", title: id, version: "1.18.32", time_created: 1, time_updated: 1, ...columns,
  };
  const names = Object.keys(row);
  db.query(`INSERT INTO session (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-store-repair-"));
  file = join(dir, "opencode.db");
  const db = store();
  db.exec(SCHEMA);
  db.query("INSERT INTO project VALUES ('global', '/', NULL, NULL, NULL, NULL, NULL, 1, 1, NULL, '[]', NULL)").run();
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repairEngineStore", () => {
  test("clears every session column the engine cannot read, keeps the sessions and the good values", async () => {
    const db = store();
    const good = {
      permission: JSON.stringify([{ permission: "edit", pattern: "*", action: "allow" }]),
      model: JSON.stringify({ id: "gpt-6-astra", providerID: "omnirush" }),
      revert: JSON.stringify({ messageID: "msg_1", snapshot: "abc" }),
      metadata: JSON.stringify({ a: 1 }),
      summary_diffs: "[]",
    };
    addSession(db, "ses_good", good);
    addSession(db, "ses_perm_object", { permission: '{"edit":"allow"}' });
    addSession(db, "ses_perm_rule", { permission: '[{"permission":"x"}]' });
    addSession(db, "ses_model_string", { model: '"gpt"' });
    addSession(db, "ses_model_partial", { model: '{"id":"x"}' });
    addSession(db, "ses_revert_empty", { revert: "{}" });
    addSession(db, "ses_metadata_text", { metadata: '"x"' });
    addSession(db, "ses_diffs_object", { summary_diffs: "{}" });
    addSession(db, "ses_model_cut", { model: '{"id":"gpt' });
    addSession(db, "ses_metadata_cut", { metadata: '{"a":1' });
    db.query("INSERT INTO message VALUES ('msg_ok', 'ses_good', 1, 1, '{\"role\":\"user\"}')").run();
    db.query("INSERT INTO message VALUES ('msg_cut', 'ses_good', 1, 1, '{\"role\":\"us')").run();
    db.query("INSERT INTO part VALUES ('prt_of_cut', 'msg_cut', 'ses_good', 1, 1, '{\"type\":\"text\"}')").run();
    db.query("INSERT INTO part VALUES ('prt_ok', 'msg_ok', 'ses_good', 1, 1, '{\"type\":\"text\"}')").run();
    db.query("INSERT INTO part VALUES ('prt_cut', 'msg_ok', 'ses_good', 1, 1, '{\"type\":')").run();
    db.close();

    const result = await repairEngineStore({ file, now: () => 0 });
    expect(result.error).toBeUndefined();
    expect(result.checked).toBe(true);
    expect(result.repaired.filter((item) => item.table === "session").map((item) => `${item.id}:${item.column}`).sort()).toEqual([
      "ses_diffs_object:summary_diffs",
      "ses_metadata_cut:metadata",
      "ses_metadata_text:metadata",
      "ses_model_cut:model",
      "ses_model_partial:model",
      "ses_model_string:model",
      "ses_perm_object:permission",
      "ses_perm_rule:permission",
      "ses_revert_empty:revert",
    ]);
    expect(result.backup && existsSync(result.backup)).toBe(true);
    expect(result.saved && existsSync(result.saved)).toBe(true);
    const saved = readFileSync(result.saved!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(saved.some((line) => line.row.id === "ses_perm_object" && line.row.permission === '{"edit":"allow"}')).toBe(true);

    const after = store();
    // No chat is gone.
    expect(Number((after.query("SELECT count(*) AS n FROM session").get() as { n: number }).n)).toBe(10);
    const goodRow = after.query("SELECT permission, model, revert, metadata, summary_diffs FROM session WHERE id = 'ses_good'").get();
    expect(goodRow).toEqual(good);
    const broken = after.query("SELECT permission, model, revert, metadata, summary_diffs FROM session WHERE id <> 'ses_good'").all() as Record<string, unknown>[];
    for (const row of broken) expect(Object.values(row).every((value) => value === null)).toBe(true);
    // The unreadable message (with its parts) and part are moved out; the rest stays.
    expect((after.query("SELECT id FROM message ORDER BY id").all() as { id: string }[]).map((row) => row.id)).toEqual(["msg_ok"]);
    expect((after.query("SELECT id FROM part ORDER BY id").all() as { id: string }[]).map((row) => row.id)).toEqual(["prt_ok"]);
    after.close();
  });

  test("a store with nothing damaged is left alone, with no backup", async () => {
    const db = store();
    addSession(db, "ses_good", { model: JSON.stringify({ id: "gpt", providerID: "omnirush" }) });
    db.close();
    const result = await repairEngineStore({ file });
    expect(result).toMatchObject({ checked: true, repaired: [], backup: null, saved: null });
  });

  test("resets a damaged project sandboxes list", async () => {
    const db = store();
    db.query("UPDATE project SET sandboxes = '{' WHERE id = 'global'").run();
    db.close();
    const result = await repairEngineStore({ file });
    expect(result.repaired).toEqual([{ table: "project", id: "global", column: "sandboxes", action: "reset" }]);
    const after = store();
    expect(after.query("SELECT sandboxes FROM project").get()).toEqual({ sandboxes: "[]" });
    after.close();
  });

  test("never throws: a missing store or a file that is not a database", async () => {
    expect(await repairEngineStore({ file: join(dir, "missing.db") })).toMatchObject({ checked: false });
    const junk = join(dir, "junk.db");
    await Bun.write(junk, "not a database at all, just text that is long enough");
    const result = await repairEngineStore({ file: junk });
    expect(result.checked).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  test("finds the desktop engine's store and shares one check between engines started together", async () => {
    const env = { OMNIRUSH_ENGINE_DATA_HOME: dir, OPENCODE_DB: file } as NodeJS.ProcessEnv;
    expect(engineStorePath(env)).toBe(file);
    expect(engineStorePath({ OMNIRUSH_ENGINE_DATA_HOME: dir } as NodeJS.ProcessEnv)).toBe(join(dir, "omnirush", "opencode.db"));
    expect(engineStorePath({ OPENCODE_DB: ":memory:" } as NodeJS.ProcessEnv)).toBeNull();
    const db = store();
    addSession(db, "ses_bad", { permission: "{}" });
    db.close();
    const first = repairEngineStoreBeforeStart(env);
    const second = repairEngineStoreBeforeStart(env);
    expect(second).toBe(first);
    expect((await first).repaired).toHaveLength(1);
  });
});

describe("repairEngineStoresAfterServerError", () => {
  afterEach(() => resetEngineStoreRepairState());

  test("repairs the stores of started engines while they run, at most every 30 s", async () => {
    const env = { OPENCODE_DB: file } as NodeJS.ProcessEnv;
    await repairEngineStoreBeforeStart(env);
    const db = store();
    addSession(db, "ses_later", { revert: "{}" });
    db.close();
    let clock = 1_000_000;
    expect(await repairEngineStoresAfterServerError(() => clock)).toBe(1);
    const again = store();
    addSession(again, "ses_later2", { revert: "{}" });
    again.close();
    clock += 5_000;
    expect(await repairEngineStoresAfterServerError(() => clock)).toBe(0);
    clock += 30_000;
    expect(await repairEngineStoresAfterServerError(() => clock)).toBe(1);
  });

  test("does nothing before an engine started", async () => {
    expect(await repairEngineStoresAfterServerError()).toBe(0);
  });
});
