// Hackathon events in the desktop app: the parser shared with the CLI (PARITY), the start's mode from the kept
// answer (no opt-out while an event runs, back to normal once it ends), and what the window gets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { accountEvents, applyEventStock, readEventsRecord } from "./events/app-events.mjs";
import { eventsRecord, parseEvents } from "./events/events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-30T10:00:00Z");
const UTC = { timeZone: "UTC", locale: "en-US" };
const BIOS = { name: "BIOS V2", code: "BIOS10M", starts_at: "2026-10-29T09:00:00Z", ends_at: "2026-10-30T18:00:00Z", stock_required: true };
const ME = {
  events: { active: [BIOS], history: [{ name: "BIOS V2", code: "BIOS10M", joined_at: "2026-10-29T12:00:00Z" }] },
  stock_mode: { required: true, reason: "event", event: "BIOS V2" },
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-events-"));
const status = (me) => ({ connected: true, email: "a@b.c", eventsRecord: eventsRecord(me) });

test("CLI/desktop parity: events/PARITY.sha256 matches its files", () => {
  const dir = path.join(here, "events");
  const rows = fs.readFileSync(path.join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const [hash, name] = row.split(/\s+/);
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"), hash, `${name} changed: port it to the CLI and update PARITY.sha256 in both`);
  }
});

test("parse: absent, empty, malformed, not started or ended read as no event", () => {
  for (const me of [null, {}, { events: null }, { events: [] }, { events: { active: "x" } }, { events: { active: [{ name: "A", ends_at: "x" }] } }]) {
    assert.deepEqual(parseEvents(me, NOW), { active: [], history: [], stock: null });
  }
  assert.equal(parseEvents(ME, Date.parse("2026-10-29T08:00:00Z")).active.length, 0);
  assert.equal(parseEvents(ME, Date.parse("2026-10-30T18:00:01Z")).stock, null);
  assert.equal(parseEvents(ME, NOW).stock.event, "BIOS V2");
});

test("start: an event's mode is on whatever the launch env says, and off again once the event ends", () => {
  const dir = tmp();
  // Nothing kept: the env decides.
  assert.deepEqual(applyEventStock(dir, { OMNIRUSH_FARM: "1" }, NOW), { asked: true, event: false, stock: true });
  assert.deepEqual(applyEventStock(dir, {}, NOW), { asked: false, event: false, stock: false });
  // The answer kept by a status read; the opt-out (OMNIRUSH_FARM=0) is ignored while the event runs.
  accountEvents(status(ME), { dir, started: { stock: false }, now: NOW });
  assert.deepEqual(readEventsRecord(dir), eventsRecord(ME));
  const env = { OMNIRUSH_FARM: "0" };
  assert.deepEqual(applyEventStock(dir, env, NOW), { asked: false, event: true, stock: true });
  assert.equal(env.OMNIRUSH_FARM, "1");
  assert.equal(env.OMNIRUSH_STOCK_REASON, "event");
  // A relaunch inherits that env: after the event it is a normal start again.
  assert.deepEqual(applyEventStock(dir, env, Date.parse("2026-10-30T18:00:00Z")), { asked: false, event: false, stock: false });
  assert.equal(env.OMNIRUSH_FARM, undefined);
  assert.equal(env.OMNIRUSH_STOCK_REASON, undefined);
  // The person's own stock mode stays theirs.
  const own = { OMNIRUSH_FARM: "1" };
  applyEventStock(dir, own, NOW);
  assert.equal(own.OMNIRUSH_STOCK_REASON, "event-asked");
  assert.deepEqual(applyEventStock(dir, own, Date.parse("2026-10-31T00:00:00Z")), { asked: true, event: false, stock: true });
  // The server dropping the flag: the next start is normal.
  accountEvents(status({ ...ME, stock_mode: { required: false } }), { dir, started: { stock: true, event: true }, now: NOW });
  assert.deepEqual(applyEventStock(dir, {}, NOW), { asked: false, event: false, stock: false });
});

test("window: display values, the restart note, nothing for a plain stock run or signed out", () => {
  const dir = tmp();
  const shown = accountEvents(status(ME), { dir, started: { stock: true, event: true }, now: NOW, local: UTC });
  assert.equal(shown.eventsRecord, undefined, "the raw part stays in the main process");
  assert.deepEqual(shown.events, {
    active: [{ name: "BIOS V2", endsAt: "2026-10-30T18:00:00.000Z", title: "BIOS V2 hackathon", detail: "You're participating · ends today 6:00 PM" }],
    joined: [{ name: "BIOS V2", joinedAt: "2026-10-29T12:00:00.000Z", date: "Oct 29, 2026" }],
    restart: false,
  });
  assert.doesNotMatch(JSON.stringify(shown.events), /stock|farm/i);
  // Joined while this run is normal: it applies from the next start.
  assert.equal(accountEvents(status(ME), { dir, started: { stock: false }, now: NOW }).events.restart, true);
  // Stock for another reason, and the event does not ask for it: nothing at all.
  assert.equal(accountEvents(status({ events: ME.events }), { dir, started: { stock: true, asked: true, event: false }, now: NOW }).events, null);
  // No block: empty lists (Settings shows its empty state; no badge).
  assert.deepEqual(accountEvents({ connected: true, eventsRecord: eventsRecord({}) }, { dir: tmp(), started: { stock: false }, now: NOW }).events, { active: [], joined: [], restart: false });
  assert.equal(accountEvents({ connected: false }, { dir, started: { stock: false }, now: NOW }).events, null);
  // Offline (no answer this time): the kept one.
  assert.equal(accountEvents({ connected: true }, { dir, started: { stock: true, event: true }, now: NOW }).events.active[0].name, "BIOS V2");
});
