import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  appleDateToDate,
  cut,
  decodeAttributedBody,
  groupRows,
  readDatabase,
  readIMessage,
  IMessageError,
} from "./work-imessage.mjs";

// A real streamtyped NSAttributedString body: the text is the first
// NSString, written as `+ <len> <utf8>`. 2001-epoch was 978307200.
function attributedBody(text) {
  const bytes = Buffer.from(text, "utf8");
  const len =
    bytes.length < 0x80
      ? Buffer.from([bytes.length])
      : Buffer.concat([Buffer.from([0x81]), (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16LE(bytes.length);
          return b;
        })()]);
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@", "latin1"),
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b]),
    len,
    bytes,
    Buffer.from([0x86]),
  ]);
}

// Nanoseconds since 2001-01-01, how modern macOS stores message.date.
function appleNanos(iso) {
  return Math.round((Date.parse(iso) / 1000 - 978307200) * 1e9);
}

function buildFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imsg-fixture-"));
  const dbPath = path.join(dir, "chat.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER, service TEXT, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  `);
  db.exec(`
    INSERT INTO handle VALUES (1, '+15551230000', 'iMessage');
    INSERT INTO handle VALUES (2, '+15559876543', 'SMS');
    INSERT INTO handle VALUES (3, 'bob@acme.com', 'iMessage');
    INSERT INTO chat VALUES (10, 'iMessage;-;+15551230000', '+15551230000', NULL, 45);
    INSERT INTO chat VALUES (11, 'iMessage;+;chat99', 'chat99', 'Warehouse', 43);
  `);
  const insMsg = db.prepare(
    "INSERT INTO message (ROWID, text, attributedBody, is_from_me, date, service, handle_id) VALUES (?,?,?,?,?,?,?)",
  );
  const insJoin = db.prepare("INSERT INTO chat_message_join VALUES (?,?)");
  // Direct chat: an incoming text, an outgoing reply, and an incoming
  // message whose text is NULL and body is in attributedBody.
  insMsg.run(1, "are we still on?", null, 0, appleNanos("2026-11-14T18:05:00Z"), "iMessage", 1);
  insJoin.run(10, 1);
  insMsg.run(2, "yes, sending it", null, 1, appleNanos("2026-11-14T18:06:00Z"), "iMessage", null);
  insJoin.run(10, 2);
  insMsg.run(3, null, attributedBody("from the blob"), 0, appleNanos("2026-11-14T18:07:00Z"), "iMessage", 1);
  insJoin.run(10, 3);
  // Group chat (style 43), an SMS sender, on a different day.
  insMsg.run(4, "the count is done", null, 0, appleNanos("2026-11-15T09:00:00Z"), "SMS", 2);
  insJoin.run(11, 4);
  db.close();
  return { dir, dbPath };
}

test("appleDateToDate converts nanoseconds and legacy seconds", () => {
  assert.equal(appleDateToDate(appleNanos("2026-11-14T18:05:00Z")).toISOString(), "2026-11-14T18:05:00.000Z");
  // Legacy second-based value (date before macOS High Sierra).
  assert.equal(appleDateToDate(500000000).toISOString(), "2016-11-05T00:53:20.000Z");
  assert.equal(appleDateToDate(0), null);
  assert.equal(appleDateToDate(null), null);
});

test("decodeAttributedBody extracts short and long strings", () => {
  assert.equal(decodeAttributedBody(attributedBody("Hello world")), "Hello world");
  const long = "x".repeat(400);
  assert.equal(decodeAttributedBody(attributedBody(long)), long);
  assert.equal(decodeAttributedBody(Buffer.from("no string here")), null);
  assert.equal(decodeAttributedBody(null), null);
});

test("readDatabase groups one record per chat per day with correct fields", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const { records, lastRowid, messageCount } = readDatabase(dbPath, 0);
    assert.equal(lastRowid, 4);
    assert.equal(messageCount, 4);
    assert.equal(records.length, 2);

    const direct = records.find((r) => r.chat_key === "iMessage;-;+15551230000");
    assert.equal(direct.is_group, false);
    assert.equal(direct.day, "2026-11-14");
    // ordered by time, is_from_me becomes "Me", NULL text read from the blob
    assert.equal(
      direct.text,
      "18:05 +15551230000: are we still on?\n18:06 Me: yes, sending it\n18:07 +15551230000: from the blob",
    );
    assert.deepEqual(direct.participants, [
      { name: null, handle: "+15551230000", service: "iMessage" },
    ]);

    const group = records.find((r) => r.is_group);
    assert.equal(group.chat_name, "Warehouse");
    assert.equal(group.day, "2026-11-15");
    assert.equal(group.participants[0].service, "SMS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDatabase reads only chats with rows past sinceRowid (incremental)", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const { records, messageCount, lastRowid } = readDatabase(dbPath, 3);
    assert.equal(messageCount, 1);
    assert.equal(lastRowid, 4);
    assert.equal(records.length, 1);
    assert.equal(records[0].is_group, true);
    // nothing new: nothing sent, the position stays
    assert.deepEqual(readDatabase(dbPath, 4), { records: [], lastRowid: 4, messageCount: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDatabase sends a chat's whole day again when a message joins it", () => {
  const { dir, dbPath } = buildFixture();
  try {
    // Rows 3 and 4 are new; rows 1 and 2 are row 3's chat and day, already
    // sent. The server replaces the chat-day's record, so all three go again.
    const { records, messageCount } = readDatabase(dbPath, 2);
    assert.equal(messageCount, 2);
    const direct = records.find((r) => r.chat_key === "iMessage;-;+15551230000");
    assert.equal(direct.text.split("\n").length, 3);
    assert.equal(records.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readIMessage refuses non-macOS platforms", async () => {
  await assert.rejects(() => readIMessage({ platform: "win32" }), (e) => e instanceof IMessageError && e.code === "unsupported_os");
});

test("readIMessage reads a copy of the Messages database", async () => {
  const { dir, dbPath } = buildFixture();
  const home = mkdtempSync(path.join(os.tmpdir(), "imsg-home-"));
  try {
    mkdirSync(path.join(home, "Library", "Messages"), { recursive: true });
    copyFileSync(dbPath, path.join(home, "Library", "Messages", "chat.db"));
    const { records, lastRowid } = await readIMessage({ platform: "darwin", homeDir: home, sinceRowid: 0 });
    assert.equal(records.length, 2);
    assert.equal(lastRowid, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("readIMessage reports a missing Messages database", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imsg-empty-"));
  try {
    await assert.rejects(
      () => readIMessage({ platform: "darwin", homeDir: dir }),
      (e) => e instanceof IMessageError && e.code === "no_messages_db",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chat-day over the server's caps is cut to fit, so it never fails the push", () => {
  // 300 people, ~306,000 characters in one day: the server takes 256 people and 200,000 characters.
  const rows = Array.from({ length: 300 }, (_, index) => ({
    rowid: index + 1,
    date: 815_000_000 + index,
    text: "x".repeat(1000),
    is_from_me: 0,
    handle: `+1555000${String(index).padStart(4, "0")}`,
    chat_guid: "iMessage;+;chat1",
    chat_style: 43,
    service: "iMessage",
  }));
  const [record] = groupRows(rows).records;
  assert.equal(record.text.length, 200_000);
  assert.equal(record.participants.length, 256);
  // a cut never leaves half of a surrogate pair
  assert.equal(cut("a\u{1F600}", 2), "a");
  assert.equal(cut("short", 10), "short");
});
