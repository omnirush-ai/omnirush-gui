// The Mac's wall clock decides a message's day (like a phone's "Export chat"):
// run the reader in a zone where UTC and local days differ.
process.env.TZ = "Asia/Kolkata";

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { messageText, readDatabases, readWhatsApp, WhatsAppError } from "./work-whatsapp.mjs";

// The tables the WhatsApp Mac app (and WhatsApp Business) ship in
// ChatStorage.sqlite and ContactsV2.sqlite, with their real columns
// (Core Data: Z_PK, Z_ENT, Z_OPT, then the attributes).
const CHAT_STORAGE = `
  CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
  CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
  CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZARCHIVED INTEGER, ZCONTACTABID INTEGER, ZFLAGS INTEGER, ZHIDDEN INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZMESSAGECOUNTER INTEGER, ZREMOVED INTEGER, ZSESSIONTYPE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZUNREADCOUNT INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER, ZPROPERTIES INTEGER, ZLASTMESSAGEDATE TIMESTAMP, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTJID VARCHAR, ZETAG VARCHAR, ZLASTMESSAGETEXT VARCHAR, ZPARTNERNAME VARCHAR, ZSAVEDINPUT VARCHAR);
  CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER, ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER, ZDOCID INTEGER, ZENCRETRYCOUNT INTEGER, ZFILTEREDRECIPIENTCOUNT INTEGER, ZFLAGS INTEGER, ZGROUPEVENTTYPE INTEGER, ZISFROMME INTEGER, ZMESSAGEERRORSTATUS INTEGER, ZMESSAGESTATUS INTEGER, ZMESSAGETYPE INTEGER, ZSORT INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSTARRED INTEGER, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER, ZPARENTMESSAGE INTEGER, ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZFROMJID VARCHAR, ZMEDIASECTIONID VARCHAR, ZPHASH VARCHAR, ZPUSHNAME VARCHAR, ZSTANZAID VARCHAR, ZTEXT VARCHAR, ZTOJID VARCHAR);
  CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCLOUDSTATUS INTEGER, ZFILESIZE INTEGER, ZMEDIAORIGIN INTEGER, ZMOVIEDURATION INTEGER, ZMESSAGE INTEGER, ZASPECTRATIO FLOAT, ZHACCURACY FLOAT, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZMEDIAURLDATE TIMESTAMP, ZAUTHORNAME VARCHAR, ZCOLLECTIONNAME VARCHAR, ZMEDIALOCALPATH VARCHAR, ZMEDIAURL VARCHAR, ZTHUMBNAILLOCALPATH VARCHAR, ZTITLE VARCHAR, ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZXMPPTHUMBPATH VARCHAR, ZMEDIAKEY BLOB, ZMETADATA BLOB);
  CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTABID INTEGER, ZISACTIVE INTEGER, ZISADMIN INTEGER, ZSENDERKEYSENT INTEGER, ZCHATSESSION INTEGER, ZRECENTGROUPCHAT INTEGER, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTNAME VARCHAR, ZFIRSTNAME VARCHAR, ZMEMBERJID VARCHAR);
  CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR);
`;
const CONTACTS = `
  CREATE TABLE ZWAADDRESSBOOKCONTACT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZABUSERID INTEGER, ZFULLNAME VARCHAR, ZGIVENNAME VARCHAR, ZBUSINESSNAME VARCHAR, ZIDENTIFIER VARCHAR, ZLID VARCHAR, ZPHONENUMBER VARCHAR, ZPHONENUMBERLABEL VARCHAR, ZWHATSAPPID VARCHAR);
`;

/** Core Data seconds (since 2001) of an ISO time. */
const cd = (iso) => Date.parse(iso) / 1000 - 978_307_200;

function chat(db, pk, type, jid, name) {
  db.prepare("INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME) VALUES (?, 2, ?, ?, ?)").run(pk, type, jid, name);
}

function message(db, pk, session, iso, fields = {}) {
  db.prepare("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, ZCHATSESSION, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZTEXT, ZMEDIAITEM, ZGROUPMEMBER, ZPUSHNAME) VALUES (?, 9, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(pk, session, cd(iso), fields.fromMe ? 1 : 0, fields.type ?? 0, fields.text ?? null, fields.media ?? null, fields.member ?? null, fields.push ?? null);
}

/** A home with the WhatsApp (and optionally Business) group containers; returns the open writers. */
function home({ business = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wa-home-"));
  const container = (name) => {
    const at = path.join(dir, "Library", "Group Containers", name);
    mkdirSync(at, { recursive: true });
    const db = new DatabaseSync(path.join(at, "ChatStorage.sqlite"));
    db.exec(CHAT_STORAGE);
    const contacts = new DatabaseSync(path.join(at, "ContactsV2.sqlite"));
    contacts.exec(CONTACTS);
    return { at, db, contacts };
  };
  const personal = container("group.net.whatsapp.WhatsApp.shared");
  const smb = business ? container("group.net.whatsapp.WhatsAppSMB.shared") : null;
  return { dir, personal, smb, close: () => [personal, smb].forEach((c) => { c?.db.close(); c?.contacts.close(); }) };
}

function seedPersonal({ db, contacts }) {
  contacts.prepare("INSERT INTO ZWAADDRESSBOOKCONTACT (Z_PK, ZFULLNAME, ZWHATSAPPID) VALUES (1, 'Carol Diaz', '447700900333')").run();
  chat(db, 1, 0, "15551230000@s.whatsapp.net", "Alice");
  chat(db, 2, 1, "120363000000000001@g.us", "Warehouse");
  chat(db, 3, 3, "status@broadcast", null); // status updates: never read
  db.exec(`
    INSERT INTO ZWAGROUPMEMBER (Z_PK, ZCHATSESSION, ZCONTACTNAME, ZMEMBERJID) VALUES (1, 2, 'Bob', '15559876543@s.whatsapp.net');
    INSERT INTO ZWAGROUPMEMBER (Z_PK, ZCHATSESSION, ZCONTACTNAME, ZMEMBERJID) VALUES (2, 2, NULL, '447700900333@s.whatsapp.net');
    INSERT INTO ZWAGROUPMEMBER (Z_PK, ZCHATSESSION, ZCONTACTNAME, ZMEMBERJID) VALUES (3, 2, NULL, '123456789012345@lid');
    INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE) VALUES (1, 3, 'Media/15551230000@s.whatsapp.net/a/b/IMG-0001.jpg', NULL);
    INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE) VALUES (2, 4, 'Media/15551230000@s.whatsapp.net/c/d/5c1e.pdf', 'Q3 report.pdf');
  `);
  // 2026-11-14 in Kolkata (UTC+5:30): 09:00Z is 14:30 local.
  message(db, 1, 1, "2026-11-14T09:00:00Z", { text: "are we still on for the quote?" });
  message(db, 2, 1, "2026-11-14T09:01:00Z", { fromMe: true, text: "yes, sending it" });
  message(db, 3, 1, "2026-11-14T09:02:00Z", { type: 1, text: "the receipt", media: 1 });
  message(db, 4, 1, "2026-11-14T09:03:00Z", { fromMe: true, type: 8, media: 2 });
  message(db, 5, 1, "2026-11-14T09:04:00Z", { type: 6 }); // a system line
  // 20:00Z on the 14th is already the 15th on the Mac's clock.
  message(db, 6, 2, "2026-11-14T20:00:00Z", { text: "stock count done", member: 1 });
  message(db, 7, 2, "2026-11-14T20:05:00Z", { text: "thanks", member: 2 });
  message(db, 8, 2, "2026-11-14T20:06:00Z", { text: "on my way", member: 3, push: "Dan" });
  message(db, 9, 3, "2026-11-14T10:00:00Z", { text: "my status" });
}

test("messageText keeps captions and file names, never media bytes", () => {
  assert.equal(messageText({ type: 0, text: "hi" }), "hi");
  assert.equal(messageText({ type: 1, text: "look", path: "Media/x/IMG-1.jpg" }), "[image: IMG-1.jpg] look");
  assert.equal(messageText({ type: 8, title: "deck.pdf", path: "Media/x/9f.pdf" }), "[document: deck.pdf]");
  assert.equal(messageText({ type: 3, path: null }), "[audio]");
  assert.equal(messageText({ type: 7, text: "https://example.com" }), "https://example.com");
});

test("readWhatsApp: private and group chats, one record per chat per local day", async () => {
  const h = home();
  try {
    seedPersonal(h.personal);
    const { records, cursor, messageCount } = await readWhatsApp({ platform: "darwin", homeDir: h.dir });
    assert.deepEqual(cursor, { whatsapp: 9 });
    assert.equal(messageCount, 7);
    assert.equal(records.length, 2); // the status update is left out
    const alice = records.find((r) => r.chat_key === "Alice");
    assert.equal(alice.day, "2026-11-14");
    assert.equal(alice.is_group, false);
    assert.deepEqual(alice.phones, ["15551230000"]);
    assert.deepEqual(alice.messages, [
      { at: "2026-11-14T14:30:00", sender: "Alice", text: "are we still on for the quote?" },
      { at: "2026-11-14T14:31:00", sender: "Me", text: "yes, sending it" },
      { at: "2026-11-14T14:32:00", sender: "Alice", text: "[image: IMG-0001.jpg] the receipt" },
      { at: "2026-11-14T14:33:00", sender: "Me", text: "[document: Q3 report.pdf]" },
    ]);
    const group = records.find((r) => r.is_group);
    assert.equal(group.chat_name, "Warehouse");
    assert.equal(group.day, "2026-11-15");
    // a member's saved name, then ContactsV2, then the push name
    assert.deepEqual(group.messages.map((m) => m.sender), ["Bob", "Carol Diaz", "Dan"]);
    assert.deepEqual(group.phones.sort(), ["15559876543", "447700900333"]);
  } finally {
    h.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("readWhatsApp sees a message still only in the write-ahead log", async () => {
  const h = home();
  try {
    seedPersonal(h.personal);
    const db = h.personal.db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    message(db, 10, 1, "2026-11-14T10:00:00Z", { text: "only in the log" });
    // The writer stays open, so the row is in ChatStorage.sqlite-wal, not the main file.
    assert.ok(statSync(path.join(h.personal.at, "ChatStorage.sqlite-wal")).size > 0);
    const { records, cursor, messageCount } = await readWhatsApp({ platform: "darwin", homeDir: h.dir, cursor: { whatsapp: 9 } });
    assert.deepEqual(cursor, { whatsapp: 10 });
    assert.equal(messageCount, 1);
    // the whole day is sent again, so the server's record keeps the earlier messages
    assert.equal(records.length, 1);
    assert.equal(records[0].messages.length, 5);
    assert.equal(records[0].messages.at(-1).text, "only in the log");
  } finally {
    h.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("readWhatsApp reads WhatsApp Business too; a name both apps use stays two chats", async () => {
  const h = home({ business: true });
  try {
    seedPersonal(h.personal);
    chat(h.smb.db, 1, 0, "15550001111@s.whatsapp.net", "Alice");
    chat(h.smb.db, 2, 0, "15550002222@s.whatsapp.net", "Shop supplier");
    message(h.smb.db, 1, 1, "2026-11-14T09:00:00Z", { text: "order ready" });
    message(h.smb.db, 2, 2, "2026-11-14T09:30:00Z", { text: "invoice sent" });
    const { records, cursor } = await readWhatsApp({ platform: "darwin", homeDir: h.dir, cursor: { whatsapp: 9 } });
    assert.deepEqual(cursor, { whatsapp: 9, business: 2 });
    assert.deepEqual(records.map((r) => r.chat_key).sort(), ["Alice\n15550001111@s.whatsapp.net", "Shop supplier"]);
    assert.ok(records.every((r) => r.chat_name !== "Alice" || r.messages[0].text === "order ready"));
  } finally {
    h.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a chat-day over the server's caps is cut to fit, so it never fails the push", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wa-big-"));
  try {
    const file = path.join(dir, "ChatStorage.sqlite");
    const db = new DatabaseSync(file);
    db.exec(CHAT_STORAGE);
    chat(db, 1, 1, "120363000000000002@g.us", "Big group");
    chat(db, 2, 0, "15551230000@s.whatsapp.net", "Alice");
    db.exec("BEGIN");
    // 5,001 messages from 300 members with 300-character names in one day.
    for (let i = 1; i <= 300; i += 1) {
      db.prepare("INSERT INTO ZWAGROUPMEMBER (Z_PK, ZCHATSESSION, ZCONTACTNAME, ZMEMBERJID) VALUES (?, 1, ?, ?)").run(i, `m${i}`.padEnd(300, "x"), `1555${String(i).padStart(7, "0")}@s.whatsapp.net`);
    }
    for (let pk = 1; pk <= 5001; pk += 1) message(db, pk, 1, "2026-11-14T06:00:00Z", { text: `hi ${pk}`, member: ((pk - 1) % 300) + 1 });
    // 250,000 characters in one private day.
    message(db, 5002, 2, "2026-11-14T06:00:00Z", { text: "a".repeat(150_000) });
    message(db, 5003, 2, "2026-11-14T06:01:00Z", { text: "b".repeat(100_000) });
    message(db, 5004, 2, "2026-11-14T06:02:00Z", { text: "dropped" });
    db.exec("COMMIT");
    db.close();
    const { records, cursor } = readDatabases([{ app: "whatsapp", chat: file }]);
    assert.deepEqual(cursor, { whatsapp: 5004 });
    const group = records.find((r) => r.is_group);
    assert.equal(group.messages.length, 5000);
    assert.equal(group.phones.length, 256);
    assert.ok(group.messages.every((m) => m.sender.length <= 256));
    assert.equal("chars" in group, false);
    const alice = records.find((r) => r.chat_key === "Alice");
    assert.deepEqual(alice.messages.map((m) => m.text.length), [150_000, 50_000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWhatsApp fails soft on an unknown schema", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wa-old-"));
  try {
    const db = new DatabaseSync(path.join(dir, "ChatStorage.sqlite"));
    db.exec("CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID VARCHAR, ZPARTNERNAME VARCHAR, ZSESSIONTYPE INTEGER); CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZMESSAGEDATE TIMESTAMP, ZBODY VARCHAR);");
    db.close();
    assert.throws(() => readDatabases([{ app: "whatsapp", chat: path.join(dir, "ChatStorage.sqlite") }]), (e) => e instanceof WhatsAppError && e.code === "unsupported_schema");
    const junk = path.join(dir, "junk.sqlite");
    new DatabaseSync(junk).close();
    assert.throws(() => readDatabases([{ app: "whatsapp", chat: junk }]), (/** @type {any} */ e) => e.code === "unsupported_schema");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWhatsApp: no app, no Full Disk Access, not macOS", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wa-none-"));
  try {
    await assert.rejects(() => readWhatsApp({ platform: "win32", homeDir: dir }), (/** @type {any} */ e) => e.code === "unsupported_os");
    await assert.rejects(() => readWhatsApp({ platform: "darwin", homeDir: dir }), (e) => e instanceof WhatsAppError && e.code === "no_whatsapp");
    const locked = path.join(dir, "Library", "Group Containers", "group.net.whatsapp.WhatsApp.shared");
    mkdirSync(locked, { recursive: true });
    new DatabaseSync(path.join(locked, "ChatStorage.sqlite")).close();
    chmodSync(locked, 0o000); // what a container looks like without Full Disk Access
    if (process.getuid?.() !== 0) {
      await assert.rejects(() => readWhatsApp({ platform: "darwin", homeDir: dir }), (/** @type {any} */ e) => e.code === "fda_required");
    }
    chmodSync(locked, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
