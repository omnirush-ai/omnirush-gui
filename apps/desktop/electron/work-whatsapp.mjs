// WhatsApp has no API for personal accounts (unofficial clients are banned
// here). The WhatsApp Mac app and WhatsApp Business keep plain SQLite in
// their group containers: ChatStorage.sqlite (Core Data: ZWAMESSAGE,
// ZWACHATSESSION, ZWAMEDIAITEM, ZWAGROUPMEMBER) and ContactsV2.sqlite for
// names. This copies them (same Full Disk Access as iMessage), reads the
// copy read-only and returns one record per chat per day, text plus
// captions and file names (no media bytes), private and group chats.
// The day and times are the Mac's wall clock, like a phone's "Export chat",
// and a chat is keyed by its name, so the backend gives the export and this
// sync the same record ids. macOS only.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { copyDatabase, probe } from "./work-imessage.mjs";

// Seconds between the Unix epoch (1970) and Core Data's (2001).
const CORE_DATA_EPOCH = 978_307_200;
const CONTAINERS = [
  { app: "whatsapp", dir: "group.net.whatsapp.WhatsApp.shared" },
  { app: "business", dir: "group.net.whatsapp.WhatsAppSMB.shared" },
];
// ZSESSIONTYPE: 0 a private chat, 1 a group (2 broadcast lists, 3 status: left out).
const CHAT_TYPES = "0, 1";
// ZMESSAGETYPE of media and the word shown for it; 6 (group events), 10
// (calls) and 14 (deleted) carry nothing to read.
const MEDIA = { 1: "image", 2: "video", 3: "audio", 4: "contact", 5: "location", 8: "document", 11: "gif", 15: "sticker" };
const SKIP_TYPES = new Set([6, 10, 14]);
const REQUIRED = {
  ZWAMESSAGE: ["Z_PK", "ZCHATSESSION", "ZMESSAGEDATE", "ZISFROMME", "ZTEXT", "ZMESSAGETYPE"],
  ZWACHATSESSION: ["Z_PK", "ZCONTACTJID", "ZPARTNERNAME", "ZSESSIONTYPE"],
};

/** A tagged error for the card: fda_required, no_whatsapp, unsupported_schema, unsupported_os. */
export class WhatsAppError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** The Mac's wall-clock day and time of a Core Data timestamp. */
function local(seconds) {
  const d = new Date((Number(seconds) + CORE_DATA_EPOCH) * 1000);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { day, at: `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
}

/** The local midnight before a Core Data timestamp, as a Core Data timestamp. */
function dayStart(seconds) {
  const d = new Date((Number(seconds) + CORE_DATA_EPOCH) * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000 - CORE_DATA_EPOCH;
}

function str(value) {
  if (value === null || value === undefined) return "";
  return (value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value)).trim();
}

/** `+<digits>` for a phone JID (`<digits>@s.whatsapp.net`); null for groups and linked ids (`@lid`). */
function phoneOf(jid) {
  const match = /^(\d{7,})@s\.whatsapp\.net$/.exec(str(jid));
  return match ? match[1] : null;
}

/** A contact's name by JID; ContactsV2 may keep the number without the domain. */
function nameOf(contacts, jid) {
  return contacts.get(jid) ?? contacts.get(jid.split("@")[0]) ?? "";
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

/** Names from ContactsV2.sqlite by JID and by number; empty when it is missing or unknown. */
function readContacts(file) {
  const names = new Map();
  if (!file) return names;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const have = columns(db, "ZWAADDRESSBOOKCONTACT");
    if (!have.has("ZFULLNAME") || !have.has("ZWHATSAPPID")) return names;
    for (const row of db.prepare("SELECT ZWHATSAPPID AS jid, ZFULLNAME AS name FROM ZWAADDRESSBOOKCONTACT").all()) {
      const name = str(row.name);
      const jid = str(row.jid);
      if (!name || !jid) continue;
      names.set(jid, name);
      names.set(jid.split("@")[0], name);
    }
  } catch {
    // shortcut: names fall back to WhatsApp's own; read ContactsV2 harder if users see numbers.
  } finally {
    db?.close();
  }
  return names;
}

/** What a message says: its text, or a media marker with its file name and caption. */
export function messageText(row) {
  const type = Number(row.type);
  const text = str(row.text);
  const kind = MEDIA[type];
  if (!kind) return text;
  const title = str(row.title);
  const file = type === 8 ? title || path.basename(str(row.path)) : path.basename(str(row.path));
  const caption = text || (type === 8 ? "" : title);
  return [`[${kind}${file ? `: ${file}` : ""}]`, caption].filter(Boolean).join(" ");
}

/**
 * Read one app's ChatStorage.sqlite (a copy) for the chats with messages
 * past `sincePk`, each whole day from the first new message on (the server
 * replaces a chat-day's record). `keyOf` gives a chat's key.
 * @param {DatabaseSync} db
 * @param {number} sincePk
 * @param {{ contacts: Map<string,string>, keyOf: (session: any) => string, sessions: any[] }} ctx
 */
function readMessages(db, sincePk, ctx) {
  const m = columns(db, "ZWAMESSAGE");
  const media = columns(db, "ZWAMEDIAITEM");
  const member = columns(db, "ZWAGROUPMEMBER");
  const col = (have, table, name) => (have.has(name) ? `${table}.${name}` : "NULL");
  const joinMedia = m.has("ZMEDIAITEM") && media.has("Z_PK");
  const joinMember = m.has("ZGROUPMEMBER") && member.has("Z_PK");
  const select = `
    SELECT m.Z_PK AS pk, m.ZCHATSESSION AS session, m.ZMESSAGEDATE AS date, m.ZISFROMME AS from_me,
           m.ZTEXT AS text, m.ZMESSAGETYPE AS type, ${col(m, "m", "ZPUSHNAME")} AS push_name,
           ${joinMedia ? `${col(media, "mi", "ZTITLE")} AS title, ${col(media, "mi", "ZMEDIALOCALPATH")} AS path` : "NULL AS title, NULL AS path"},
           ${joinMember ? `${col(member, "gm", "ZCONTACTNAME")} AS member_name, ${col(member, "gm", "ZFIRSTNAME")} AS member_first, ${col(member, "gm", "ZMEMBERJID")} AS member_jid` : "NULL AS member_name, NULL AS member_first, NULL AS member_jid"}
    FROM ZWAMESSAGE m
    ${joinMedia ? "LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM" : ""}
    ${joinMember ? "LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER" : ""}`;
  const fresh = db.prepare(`SELECT ZCHATSESSION AS session, MIN(ZMESSAGEDATE) AS date, MAX(Z_PK) AS pk FROM ZWAMESSAGE WHERE Z_PK > ? AND ZCHATSESSION IS NOT NULL GROUP BY ZCHATSESSION`).all(sincePk);
  const sessions = new Map(ctx.sessions.map((s) => [s.pk, s]));
  const day = db.prepare(`${select} WHERE m.ZCHATSESSION = ? AND m.ZMESSAGEDATE >= ? ORDER BY m.ZMESSAGEDATE, m.Z_PK`);
  const groups = new Map();
  let lastPk = sincePk;
  let messageCount = 0;
  for (const chat of fresh) {
    lastPk = Math.max(lastPk, Number(chat.pk));
    const session = sessions.get(Number(chat.session));
    if (!session) continue; // a broadcast list, status, or a chat not listed
    for (const row of day.all(chat.session, dayStart(chat.date ?? 0))) {
      if (SKIP_TYPES.has(Number(row.type)) || row.date === null) continue;
      const text = messageText(row);
      if (!text) continue;
      if (Number(row.pk) > sincePk) messageCount += 1;
      const when = local(row.date);
      const fromMe = Number(row.from_me) === 1;
      const jid = session.group ? str(row.member_jid) : session.jid;
      const sender = fromMe
        ? "Me"
        : session.group
          ? str(row.member_name) || str(row.member_first) || nameOf(ctx.contacts, jid) || str(row.push_name) || (phoneOf(jid) ? `+${phoneOf(jid)}` : "Unknown")
          : session.name;
      const key = `${session.pk}\u0000${when.day}`;
      let group = groups.get(key);
      if (!group) {
        group = { chat_key: ctx.keyOf(session), chat_name: session.name, is_group: session.group, day: when.day, messages: [], phones: new Set() };
        if (!session.group && phoneOf(session.jid)) group.phones.add(phoneOf(session.jid));
        groups.set(key, group);
      }
      group.messages.push({ at: when.at, sender, text });
      if (!fromMe && session.group && phoneOf(jid)) group.phones.add(phoneOf(jid));
    }
  }
  const records = [...groups.values()].map((group) => ({ ...group, phones: [...group.phones] }));
  return { records, lastPk, messageCount };
}

/** The listed chats of one ChatStorage copy: `{ pk, name, jid, group }`; throws unsupported_schema. */
function readSessions(db, contacts) {
  for (const [table, needed] of Object.entries(REQUIRED)) {
    const have = columns(db, table);
    if (needed.some((name) => !have.has(name))) throw new WhatsAppError("unsupported_schema");
  }
  return db.prepare(`SELECT Z_PK AS pk, ZPARTNERNAME AS name, ZCONTACTJID AS jid, ZSESSIONTYPE AS type FROM ZWACHATSESSION WHERE ZSESSIONTYPE IN (${CHAT_TYPES}) AND COALESCE(ZCONTACTJID, '') NOT LIKE '%@broadcast' ORDER BY Z_PK`).all().map((row) => {
    const jid = str(row.jid);
    const group = Number(row.type) === 1;
    const phone = phoneOf(jid);
    const name = str(row.name) || nameOf(contacts, jid) || (phone ? `+${phone}` : group ? "Group chat" : jid);
    return { pk: Number(row.pk), name, jid, group };
  });
}

/**
 * Read the given apps' databases (copies, already opened as `files`) past
 * each app's cursor. A chat's key is its name; a name two chats share
 * (across both apps) keeps the name only for the first, the others add
 * their JID so no chat-day overwrites another's.
 * @param {{ app: string, chat: string, contacts?: string }[]} files
 * @param {Record<string, number>} cursor
 */
export function readDatabases(files, cursor = {}) {
  const opened = [];
  try {
    for (const file of files) {
      const contacts = readContacts(file.contacts);
      let db;
      try {
        db = new DatabaseSync(file.chat, { readOnly: true });
      } catch (error) {
        throw new WhatsAppError("unsupported_schema", error);
      }
      opened.push({ app: file.app, db, contacts, sessions: [] });
      try {
        opened.at(-1).sessions = readSessions(db, contacts);
      } catch (error) {
        throw error instanceof WhatsAppError ? error : new WhatsAppError("unsupported_schema", error);
      }
    }
    const owner = new Map();
    for (const { app, sessions } of opened) for (const s of sessions) if (!owner.has(s.name)) owner.set(s.name, `${app}:${s.pk}`);
    const records = [];
    const next = { ...cursor };
    let messageCount = 0;
    for (const { app, db, contacts, sessions } of opened) {
      const keyOf = (s) => (owner.get(s.name) === `${app}:${s.pk}` ? s.name : `${s.name}\n${s.jid}`);
      let read;
      try {
        read = readMessages(db, Number(cursor[app]) || 0, { contacts, keyOf, sessions });
      } catch (error) {
        throw new WhatsAppError("unsupported_schema", error);
      }
      records.push(...read.records);
      next[app] = read.lastPk;
      messageCount += read.messageCount;
    }
    return { records, cursor: next, messageCount };
  } finally {
    for (const { db } of opened) db.close();
  }
}

/**
 * Copy and read the WhatsApp and WhatsApp Business Mac apps' databases.
 * Throws `WhatsAppError`: `fda_required` (no Full Disk Access),
 * `no_whatsapp` (neither app has a database here), `unsupported_schema`
 * (an unknown WhatsApp version), `unsupported_os` (not macOS).
 * @param {{ homeDir?: string, cursor?: Record<string, number>, platform?: string }} [options]
 */
export async function readWhatsApp(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") throw new WhatsAppError("unsupported_os");
  const root = path.join(options.homeDir || os.homedir(), "Library", "Group Containers");
  const found = CONTAINERS.map((c) => ({ ...c, chat: path.join(root, c.dir, "ChatStorage.sqlite"), contacts: path.join(root, c.dir, "ContactsV2.sqlite") }))
    .map((c) => ({ ...c, state: probe(c.chat) }));
  if (found.some((c) => c.state === "denied")) throw new WhatsAppError("fda_required");
  const present = found.filter((c) => c.state === "ok");
  if (!present.length) throw new WhatsAppError("no_whatsapp");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "omnirush-wa-"));
  try {
    const files = [];
    for (const c of present) {
      const dir = path.join(scratch, c.app);
      mkdirSync(dir);
      const chat = await copyDatabase(c.chat, dir);
      const contacts = probe(c.contacts) === "ok" ? await copyDatabase(c.contacts, dir).catch(() => undefined) : undefined;
      files.push({ app: c.app, chat, contacts });
    }
    return readDatabases(files, options.cursor);
  } catch (error) {
    const code = error && /** @type {any} */ (error).code;
    if (code === "EACCES" || code === "EPERM") throw new WhatsAppError("fda_required", error);
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
