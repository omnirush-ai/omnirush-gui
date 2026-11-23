import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { backoffMs, batches, createChatSync, MIN_GAP_MS, SYNC_EVERY_MS, WATCH_QUIET_MS } from "./work-chat-sync.mjs";

/**
 * A chat sync against a fake local server; `server` and `reads` are what the test steers and inspects.
 * @param {{ read?: (source: string, cursor: any) => any }} [options]
 */
function rig({ read } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chat-sync-"));
  const file = path.join(dir, "work-chat-sync.json");
  const server = { enabled: true, account: "https://omnirush.ai acct_a", fail: null, pushed: [], onPush: null, sources: undefined };
  const reads = [];
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const timers = [];
  const watchers = [];
  let active = 0;
  let overlap = false;
  const reader = (source) => async (cursor, account) => {
    reads.push({ source, cursor, account });
    active += 1;
    if (active > 1) overlap = true;
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (read) return read(source, cursor);
    return { records: [{ chat_key: "c", day: "2026-11-20" }], cursor: (Number(cursor) || 0) + 1, messageCount: 1 };
  };
  const fetchImpl = async (url, init = {}) => {
    const route = url.replace("http://127.0.0.1:1", "");
    assert.equal(init.headers.Authorization, "Bearer client-token");
    if (route === "/work/state?account=1") return Response.json({ enabled: server.enabled, ...(server.enabled ? { account: server.account } : {}), ...(server.sources ? { sources: server.sources } : {}) });
    // A push lands in the account the server has when it arrives; onPush may switch it after.
    const account = server.account;
    server.onPush?.();
    if (server.fail) return Response.json({ code: server.fail }, { status: 502 });
    server.pushed.push({ route, account, records: JSON.parse(init.body).records });
    return Response.json({ imported: 1 });
  };
  const sync = createChatSync(/** @type {any} */ ({
    file,
    localServer: async () => ({ baseUrl: "http://127.0.0.1:1", token: "client-token" }),
    sources: {
      imessage: { route: "/work/imessage", read: reader("imessage"), watch: [{ dir: "/msgs", file: "chat.db-wal" }] },
      whatsapp: { route: "/work/whatsapp-local", read: reader("whatsapp") },
    },
    fetchImpl,
    now: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    setRepeat: (fn, ms) => ({ fn, ms }),
    clearRepeat: () => undefined,
    watch: (watched, listener) => { const handle = { dir: watched, listener, closed: false, close() { this.closed = true; } }; watchers.push(handle); return handle; },
    log: () => undefined,
  }));
  return {
    sync, server, reads, timers, watchers, file,
    advance: (ms) => { clock += ms; },
    saved: () => JSON.parse(readFileSync(file, "utf8")),
    overlapped: () => overlap,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("batches stay under the server's limits and never split a record", () => {
  const records = Array.from({ length: 2001 }, (_, index) => ({ day: "2026-11-15", text: `m${index}` }));
  const out = batches(records);
  assert.deepEqual(out.flat(), records);
  assert.ok(Math.max(...out.map((batch) => batch.length)) <= 500);
  assert.deepEqual(batches([{ text: "x".repeat(40) }, { text: "y".repeat(40) }, { text: "z" }], 500, 70).map((b) => b.length), [1, 2]);
});

test("backoff doubles from 10 minutes up to 6 hours", () => {
  assert.equal(backoffMs(1), SYNC_EVERY_MS);
  assert.equal(backoffMs(2), 2 * SYNC_EVERY_MS);
  assert.equal(backoffMs(40), 6 * 60 * 60_000);
});

test("off until the first good read; Sync now turns it on, then it syncs on its own", async () => {
  const r = rig();
  try {
    assert.deepEqual(await r.sync.run("imessage"), { status: "skipped", reason: "off" });
    assert.equal(r.reads.length, 0);
    assert.equal((await r.sync.run("imessage", { manual: true })).status, "ok");
    assert.equal(r.server.pushed[0].route, "/work/imessage");
    const status = await r.sync.status();
    assert.equal(status.imessage.enabled, true);
    assert.equal(status.imessage.lastSyncAt, "2026-11-20T10:00:00.000Z");
    assert.equal(status.whatsapp.enabled, null);
    assert.equal((await r.sync.run("imessage")).status, "ok");
    assert.deepEqual(r.reads.map((read) => read.cursor), [undefined, 1]);
    // The Data sync switch off: no more automatic reads; Sync now still reads.
    await r.sync.setEnabled("imessage", false);
    assert.equal((await r.sync.run("imessage")).reason, "off");
    assert.equal(r.reads.length, 2);
    assert.equal((await r.sync.run("imessage", { manual: true })).status, "ok");
    assert.equal((await r.sync.status()).imessage.enabled, false);
  } finally {
    r.done();
  }
});

test("a read Telegram slowed down saves what it got and waits the time it was told", async () => {
  const r = rig({ read: (_source, cursor) => ({ records: [{ chat_id: "1", day: "2026-11-20" }], cursor: (Number(cursor) || 0) + 1, messageCount: 1, retryAfterMs: 3_600_000 }) });
  try {
    assert.equal((await r.sync.run("whatsapp", { manual: true })).status, "ok");
    // The reader learns the Work account it reads for (Telegram's login belongs to one).
    assert.equal(r.reads[0].account, "https://omnirush.ai acct_a");
    assert.equal(r.server.pushed.length, 1);
    const entry = r.saved().accounts["https://omnirush.ai acct_a"].whatsapp;
    assert.equal(entry.lastError, "flood_wait");
    assert.equal(entry.cursor, 1);
    r.advance(SYNC_EVERY_MS);
    assert.deepEqual(await r.sync.run("whatsapp"), { status: "skipped", reason: "flood_wait" });
    // Sync now and the switch wait too: Telegram is not asked again before its time.
    assert.deepEqual(await r.sync.run("whatsapp", { manual: true }), { status: "skipped", reason: "flood_wait" });
    await r.sync.setEnabled("whatsapp", false);
    assert.deepEqual(await r.sync.setEnabled("whatsapp", true), { status: "skipped", reason: "flood_wait" });
    assert.equal(r.reads.length, 1);
    r.advance(3_600_000);
    assert.equal((await r.sync.run("whatsapp")).status, "ok");
    assert.equal(r.reads.length, 2);
  } finally {
    r.done();
  }
});

test("Work off or signed out: nothing is read", async () => {
  const r = rig();
  try {
    r.server.enabled = false;
    assert.deepEqual(await r.sync.run("whatsapp", { manual: true }), { status: "skipped", reason: "work_off" });
    assert.equal(await r.sync.status(), null);
    assert.equal(await r.sync.setEnabled("whatsapp", true), null);
    assert.equal(r.reads.length, 0);
  } finally {
    r.done();
  }
});

test("one read at a time; a second ask for the same source shares the run", async () => {
  const r = rig();
  try {
    const runs = [r.sync.run("imessage", { manual: true }), r.sync.run("whatsapp", { manual: true }), r.sync.run("imessage", { manual: true })];
    assert.equal(runs[0], runs[2]);
    const results = await Promise.all(runs);
    assert.deepEqual(results.map((result) => result.status), ["ok", "ok", "ok"]);
    assert.equal(r.reads.length, 2);
    assert.equal(r.overlapped(), false);
  } finally {
    r.done();
  }
});

test("errors back off and keep the read position; the next good read clears them", async () => {
  let fail = "fda_required";
  const r = rig({
    read: (_source, cursor) => {
      if (fail) throw Object.assign(new Error("x"), { code: fail });
      return { records: [], cursor: (Number(cursor) || 0) + 5, messageCount: 0 };
    },
  });
  try {
    await r.sync.setEnabled("whatsapp", true);
    let status = (await r.sync.status()).whatsapp;
    assert.equal(status.lastError, "fda_required");
    assert.equal(status.failures, 1);
    // Automatic reads wait out the backoff; Sync now does not.
    assert.equal((await r.sync.run("whatsapp")).reason, "off");
    r.advance(backoffMs(1));
    fail = "unsupported_schema";
    assert.equal((await r.sync.run("whatsapp")).code, "unsupported_schema");
    status = (await r.sync.status()).whatsapp;
    assert.equal(status.failures, 2);
    assert.equal(r.saved().accounts["https://omnirush.ai acct_a"].whatsapp.nextAt, Date.parse("2026-11-20T10:00:00Z") + backoffMs(1) + backoffMs(2));
    fail = null;
    assert.equal((await r.sync.run("whatsapp", { manual: true })).status, "ok");
    status = (await r.sync.status()).whatsapp;
    assert.deepEqual([status.lastError, status.failures, status.enabled], [null, 0, true]);
    assert.equal(r.saved().accounts["https://omnirush.ai acct_a"].whatsapp.cursor, 5);
  } finally {
    r.done();
  }
});

test("a failed push keeps the read position, so the messages go again next time", async () => {
  const r = rig();
  try {
    await r.sync.run("imessage", { manual: true });
    r.server.fail = "bad_import";
    assert.deepEqual(await r.sync.run("imessage", { manual: true }), { status: "error", code: "bad_import" });
    assert.equal(r.saved().accounts["https://omnirush.ai acct_a"].imessage.cursor, 1);
    r.server.fail = null;
    await r.sync.run("imessage", { manual: true });
    assert.deepEqual(r.reads.map((read) => read.cursor), [undefined, 1, 1]);
  } finally {
    r.done();
  }
});

test("a source the company turned off is not read again until the Work sources list it again", async () => {
  const r = rig();
  try {
    r.server.sources = ["google", "whatsapp"];
    assert.equal((await r.sync.run("whatsapp", { manual: true })).status, "ok");
    r.server.fail = "connector_off";
    r.server.sources = ["google"];
    r.advance(SYNC_EVERY_MS);
    assert.deepEqual(await r.sync.run("whatsapp"), { status: "error", code: "connector_off" });
    assert.equal(r.reads.length, 2);
    // Off for the company: the automatic runs read nothing, however long it stays off.
    r.advance(7 * 60 * 60_000);
    assert.deepEqual(await r.sync.run("whatsapp"), { status: "skipped", reason: "turned_off" });
    assert.equal(r.reads.length, 2);
    // Other sources go on.
    r.server.fail = null;
    assert.equal((await r.sync.setEnabled("imessage", true)).status, "ok");
    assert.equal(r.reads.length, 3);
    // On again: the next run reads and clears the error.
    r.server.sources = ["google", "whatsapp"];
    assert.equal((await r.sync.run("whatsapp")).status, "ok");
    assert.equal((await r.sync.status()).whatsapp.lastError, null);
    // A server with no sources in the state (an older app server) keeps today's backoff only.
    r.server.fail = "connector_off";
    r.server.sources = undefined;
    r.advance(SYNC_EVERY_MS);
    assert.equal((await r.sync.run("whatsapp")).code, "connector_off");
    r.advance(backoffMs(1));
    assert.equal((await r.sync.run("whatsapp")).code, "connector_off");
  } finally {
    r.done();
  }
});

test("each server and account has its own read position; a switch mid-run saves nothing", async () => {
  const r = rig();
  try {
    await r.sync.run("imessage", { manual: true });
    await r.sync.run("imessage", { manual: true });
    r.server.account = "https://omnirush.ai acct_b";
    await r.sync.run("imessage", { manual: true });
    // acct_b starts from the beginning; acct_a's position is kept
    assert.deepEqual(r.reads.map((read) => read.cursor), [undefined, 1, undefined]);
    const saved = r.saved().accounts;
    assert.equal(saved["https://omnirush.ai acct_a"].imessage.cursor, 2);
    assert.equal(saved["https://omnirush.ai acct_b"].imessage.cursor, 1);
    // The account changes while a run pushes: its position stays where it was.
    r.server.onPush = () => { r.server.account = "https://omnirush.ai acct_a"; };
    assert.equal((await r.sync.run("imessage", { manual: true })).reason, "account_changed");
    assert.equal(r.saved().accounts["https://omnirush.ai acct_b"].imessage.cursor, 1);
  } finally {
    r.done();
  }
});

test("an account switch between pushes: no later batch reaches the new account", async () => {
  const records = Array.from({ length: 1001 }, (_, index) => ({ chat_key: `c${index}`, day: "2026-11-20" }));
  const r = rig({ read: () => ({ records, cursor: 1001, messageCount: 1001 }) });
  try {
    r.server.onPush = () => { r.server.account = "https://omnirush.ai acct_b"; };
    assert.equal((await r.sync.run("imessage", { manual: true })).reason, "account_changed");
    // three batches were due; only the first went, to the account that read them
    assert.deepEqual(r.server.pushed.map((push) => [push.account, push.records.length]), [["https://omnirush.ai acct_a", 500]]);
    assert.equal(existsSync(r.file), false); // no read position saved for either account
  } finally {
    r.done();
  }
});

test("start: a first read soon, every 10 minutes, and after a quiet minute of log writes", async () => {
  const r = rig();
  try {
    r.sync.start();
    // No folder is opened before the source is on and read.
    assert.equal(r.watchers.length, 0);
    assert.equal((await r.sync.setEnabled("imessage", false)).reason, "off");
    assert.equal((await r.sync.run("imessage", { manual: true })).status, "ok");
    assert.equal(r.watchers.length, 0);
    await r.sync.setEnabled("imessage", true);
    assert.equal(r.watchers.length, 1);
    assert.equal(r.watchers[0].dir, "/msgs");
    // Right after a read, the next waits out the gap.
    r.watchers[0].listener("change", "chat.db-wal");
    assert.equal(r.timers.at(-1).ms, MIN_GAP_MS);
    r.advance(MIN_GAP_MS);
    const before = r.timers.length;
    r.watchers[0].listener("change", "chat.db");
    assert.equal(r.timers.length, before); // the main file is not the log
    r.watchers[0].listener("change", "chat.db-wal");
    r.watchers[0].listener("change", "chat.db-wal");
    const waits = r.timers.slice(before);
    assert.equal(waits.length, 2);
    assert.equal(waits[0].cleared, true); // debounced
    assert.equal(waits[1].ms, WATCH_QUIET_MS);
    r.sync.stop();
    assert.equal(r.watchers[0].closed, true);
  } finally {
    r.done();
  }
});

test("start: while the local server is not up yet, the first read is tried again a minute later", async () => {
  const r = rig();
  try {
    r.server.enabled = false;
    r.sync.start();
    const first = r.timers[0];
    first.fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(r.timers.at(-1).ms, 60_000);
    r.sync.stop();
  } finally {
    r.done();
  }
});
