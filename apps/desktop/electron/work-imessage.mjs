// iMessage has no API and nothing on a server: the only copy of a
// person's messages is the local Messages database on their Mac. This
// reads a copy of ~/Library/Messages/chat.db (the live file is locked by
// Messages and needs Full Disk Access), turns rows into one record per
// chat per day, and hands them to the chat sync (work-chat-sync.mjs) to
// push to the backend. macOS only.

import { constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Seconds between the Unix epoch (1970) and the Apple/Cocoa epoch (2001).
const APPLE_EPOCH_OFFSET = 978_307_200;

/** A tagged error so the UI can show the right step (grant Full Disk
 *  Access, no Messages database, not macOS). */
export class IMessageError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * `message.date` is nanoseconds since 2001-01-01 on modern macOS and
 * whole seconds on very old databases; both become a UTC Date.
 * @param {number|bigint|null} raw
 * @returns {Date|null}
 */
export function appleDateToDate(raw) {
  if (raw === null || raw === undefined) return null;
  let value = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(value) || value === 0) return null;
  // Legacy rows store seconds (~5e8); modern rows store nanoseconds (~7e17).
  const seconds = value > 1e11 ? value / 1e9 : value;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
}

/**
 * On newer macOS the message body is not in `text` but inside the
 * `attributedBody` blob, an NSAttributedString in Apple's typedstream
 * (streamtyped) format. The displayed text is the first NSString in it,
 * stored as `+ <length> <utf8 bytes>`, where a length >= 128 is prefixed
 * by 0x81 (int16) or 0x82 (int32), exactly like typedstream integers.
 * shortcut: first-NSString heuristic, not a full typedstream parser;
 * upgrade to one if attributed messages (mentions, links) come back empty.
 * @param {Uint8Array|Buffer|null} blob
 * @returns {string|null}
 */
export function decodeAttributedBody(blob) {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const cls = buf.indexOf("NSString", 0, "latin1");
  if (cls === -1) return null;
  let i = buf.indexOf(0x2b, cls); // '+' marks the start of the string value
  if (i === -1) return null;
  i += 1;
  if (i >= buf.length) return null;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(i);
    i += 4;
  } else if (len > 0x82) {
    return null;
  }
  if (len <= 0 || i + len > buf.length) return null;
  return buf.toString("utf8", i, i + len) || null;
}

function dayOf(date) {
  // shortcut: day buckets are UTC; a message near local midnight may land
  // on the neighbouring day. Switch to the Mac's zone if users notice.
  return date.toISOString().slice(0, 10);
}

function hhmm(date) {
  return date.toISOString().slice(11, 16);
}

/**
 * Whether a protected file is there: `missing`, `denied` (no Full Disk
 * Access: macOS answers EPERM even to a stat) or `ok`.
 * @param {string} file
 */
export function probe(file) {
  try {
    statSync(file);
    return "ok";
  } catch (error) {
    const code = error && /** @type {any} */ (error).code;
    return code === "EPERM" || code === "EACCES" ? "denied" : "missing";
  }
}

/**
 * Copy a live SQLite database (`file`, `-wal`, `-shm`) into `scratch` and
 * return the copy's path. The write-ahead log goes first: a checkpoint
 * between the copies then leaves the main file newer, never older, than
 * the log (older would lose the checkpointed rows). APFS clones the files.
 * @param {string} file
 * @param {string} scratch
 */
export async function copyDatabase(file, scratch) {
  const copy = path.join(scratch, path.basename(file));
  for (const suffix of ["-wal", "", "-shm"]) {
    if (suffix && probe(file + suffix) === "missing") continue;
    await copyFile(file + suffix, copy + suffix, constants.COPYFILE_FICLONE);
  }
  return copy;
}

const COLUMNS = `
    m.ROWID              AS rowid,
    cmj.chat_id          AS chat_id,
    m.text               AS text,
    m.attributedBody     AS attributedBody,
    m.is_from_me         AS is_from_me,
    m.date               AS date,
    m.service            AS service,
    h.id                 AS handle,
    c.guid               AS chat_guid,
    c.chat_identifier    AS chat_identifier,
    c.display_name       AS chat_display_name,
    c.style              AS chat_style`;
const FROM = `
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h         ON h.ROWID = m.handle_id`;
const NEW_ROWS = `SELECT cmj.chat_id AS chat_id, MIN(m.date) AS date, MAX(m.ROWID) AS rowid ${FROM} WHERE m.ROWID > ? GROUP BY cmj.chat_id`;

/** The UTC day start of an Apple `date`, in the same unit (nanoseconds or legacy seconds). */
function dayStart(raw) {
  const value = BigInt(raw);
  const nanos = value > 100_000_000_000n;
  const seconds = nanos ? value / 1_000_000_000n : value;
  const start = seconds - ((seconds + BigInt(APPLE_EPOCH_OFFSET)) % 86_400n);
  return nanos ? start * 1_000_000_000n : start;
}

/**
 * Group raw message rows into one record per chat per day.
 * @param {any[]} rows
 * @param {number} [newAfter] `messageCount` counts only rows past this ROWID
 * @returns {{ records: object[], lastRowid: number, messageCount: number }}
 */
export function groupRows(rows, newAfter = 0) {
  const byKey = new Map();
  let lastRowid = 0;
  let messageCount = 0;
  for (const row of rows) {
    const rowid = Number(row.rowid);
    if (rowid > lastRowid) lastRowid = rowid;
    const when = appleDateToDate(row.date);
    if (!when) continue;
    const body = (row.text && String(row.text)) || decodeAttributedBody(row.attributedBody);
    if (!body) continue; // attachment-only / system rows carry no text
    if (rowid > newAfter) messageCount += 1;
    const chatKey = String(row.chat_guid || row.chat_identifier || "unknown");
    const day = dayOf(when);
    const key = `${chatKey}\u0000${day}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        chat_key: chatKey,
        chat_name: (row.chat_display_name && String(row.chat_display_name)) || null,
        is_group: Number(row.chat_style) === 43,
        day,
        occurred_at: when.toISOString(),
        lines: [],
        participants: new Map(),
      };
      byKey.set(key, group);
    }
    if (when.toISOString() > group.occurred_at) group.occurred_at = when.toISOString();
    const fromMe = Number(row.is_from_me) === 1;
    const handle = row.handle ? String(row.handle) : null;
    const who = fromMe ? "Me" : handle || "Unknown";
    group.lines.push({ at: when.getTime(), text: `${hhmm(when)} ${who}: ${body}` });
    if (!fromMe && handle && !group.participants.has(handle)) {
      group.participants.set(handle, {
        name: null,
        handle,
        service: (row.service && String(row.service)) || null,
      });
    }
  }
  const records = [...byKey.values()].map((group) => ({
    chat_key: group.chat_key,
    chat_name: group.chat_name,
    is_group: group.is_group,
    day: group.day,
    occurred_at: group.occurred_at,
    text: group.lines
      .sort((a, b) => a.at - b.at)
      .map((line) => line.text)
      .join("\n"),
    participants: [...group.participants.values()],
  }));
  return { records, lastRowid, messageCount };
}

/** Read the chat.db at `dbPath` for the chats with messages past
 *  `sinceRowid`, each whole day from the first new message on: the server
 *  replaces a chat-day's record, so a record never holds only the new
 *  messages. Opens read-only; the caller gives a copy. */
export function readDatabase(dbPath, sinceRowid = 0) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const since = Number(sinceRowid) || 0;
    const fresh = db.prepare(NEW_ROWS);
    // Nanosecond timestamps (~8e17) overflow a JS double; read integers as
    // BigInt. groupRows coerces each column it needs.
    fresh.setReadBigInts(true);
    const chats = fresh.all(since);
    if (!chats.length) return { records: [], lastRowid: since, messageCount: 0 };
    const rows = [];
    const stmt = db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE cmj.chat_id = ? AND m.date >= ? ORDER BY m.ROWID`);
    stmt.setReadBigInts(true);
    for (const chat of chats) rows.push(...stmt.all(chat.chat_id, chat.date === null ? 0n : dayStart(chat.date)));
    const grouped = groupRows(rows, since);
    const lastRowid = Math.max(since, ...chats.map((chat) => Number(chat.rowid)));
    return { ...grouped, lastRowid };
  } finally {
    db.close();
  }
}

/**
 * Copy the live Messages database (locked by Messages, so never opened in
 * place) and read it. Throws `IMessageError('fda_required')` when Full
 * Disk Access is missing, `'no_messages_db'` when Messages was never used,
 * and `'unsupported_os'` off macOS. The copy is async: chat.db can be
 * hundreds of MB, and this runs in the Electron main process.
 * @param {{ homeDir?: string, sinceRowid?: number, platform?: string }} [options]
 */
export async function readIMessage(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") throw new IMessageError("unsupported_os");
  const homeDir = options.homeDir || os.homedir();
  const src = path.join(homeDir, "Library", "Messages", "chat.db");
  const found = probe(src);
  if (found === "missing") throw new IMessageError("no_messages_db");
  if (found === "denied") throw new IMessageError("fda_required");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "omnirush-imsg-"));
  try {
    // The write-ahead log and shared-memory file carry messages not yet
    // checkpointed into chat.db; copy them so the read sees recent chats.
    return readDatabase(await copyDatabase(src, scratch), options.sinceRowid);
  } catch (error) {
    const code = error && error.code;
    if (code === "EACCES" || code === "EPERM") {
      throw new IMessageError("fda_required", error);
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
