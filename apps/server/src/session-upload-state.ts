/**
 * Names of the session uploader's files under the app state directory, and
 * the one-time move from the names versions up to 2.2.1 used.
 *
 * Until 2.2.1 these were `omnirush-collector-*`. The session ledger holds each
 * session's segment, next sequence and message checkpoint, so without it a
 * resumed chat would start a new segment and upload its full start snapshot
 * and its whole transcript again; the spool holds uploads still owed; the
 * bases hold the scrubbed texts `turn.diff` is measured against. So the old
 * entries are moved, never dropped, before the uploader reads any of them.
 */
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic-write.js";

export const UPLOAD_TEMP_DIRECTORY = "omnirush-upload-tmp";
export const UPLOAD_SESSION_LEDGER_FILE = "omnirush-upload-sessions.json";
export const UPLOAD_SPOOL_DIRECTORY = "omnirush-upload-spool";
export const UPLOAD_BASE_DIRECTORY = "omnirush-upload-bases";
/** Each live chat's trace events not yet handed to an upload, so a crash loses none (session-uploader.ts). */
export const UPLOAD_JOURNAL_DIRECTORY = "omnirush-upload-journal";

/** The same files under the names used up to 2.2.1. */
export const LEGACY_UPLOAD_STATE_NAMES = {
  temp: "omnirush-collector-tmp",
  ledger: "omnirush-collector-sessions.json",
  spool: "omnirush-collector-spool",
  bases: "omnirush-collector-bases",
} as const;

type LedgerFile = { version: number; sessions: Record<string, { lastSeenAt?: unknown }> };

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function parseLedger(text: string): LedgerFile | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || !("sessions" in parsed)) return null;
    const { version, sessions } = parsed;
    if (typeof version !== "number" || typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) return null;
    return { version, sessions: Object.fromEntries(Object.entries(sessions)) };
  } catch {
    return null;
  }
}

function lastSeen(record: { lastSeenAt?: unknown } | undefined): string {
  return typeof record?.lastSeenAt === "string" ? record.lastSeenAt : "";
}

/**
 * Both ledgers exist (an older version ran after this one had moved the
 * files): every session either knows is kept, the more recently seen record
 * winning, so no session loses its sequence or checkpoint.
 */
async function mergeLedger(legacy: string, current: string): Promise<void> {
  const [oldText, newText] = await Promise.all([readFile(legacy, "utf8"), readFile(current, "utf8")]);
  const oldLedger = parseLedger(oldText);
  const newLedger = parseLedger(newText);
  if (oldLedger && (!newLedger || newLedger.version === oldLedger.version)) {
    const sessions = { ...oldLedger.sessions };
    for (const [id, record] of Object.entries(newLedger?.sessions ?? {})) {
      if (lastSeen(record) >= lastSeen(sessions[id])) sessions[id] = record;
    }
    await writeFileAtomic(current, JSON.stringify({ version: oldLedger.version, sessions }), { mode: 0o600 });
  }
  await rm(legacy, { force: true });
}

/**
 * Both spools exist: the old one's pending uploads join the new spool (their
 * ids are unique: a timestamp, a counter and random bytes), so each is still
 * delivered exactly once.
 */
async function mergeSpool(legacy: string, current: string): Promise<void> {
  for (const name of await readdir(legacy)) {
    const target = join(current, name);
    if (!(await exists(target))) await rename(join(legacy, name), target);
  }
  await rm(legacy, { recursive: true, force: true });
}

async function migrateOne(stateDir: string, legacyName: string, name: string, merge: ((legacy: string, current: string) => Promise<void>) | null): Promise<void> {
  const legacy = join(stateDir, legacyName);
  if (!(await exists(legacy))) return;
  const current = join(stateDir, name);
  if (!(await exists(current))) {
    await rename(legacy, current);
    return;
  }
  if (merge) await merge(legacy, current);
  // A second temp dir holds only crash leftovers, and a second base store
  // only cached texts (a missing base makes a `no_base` entry, not an upload).
  else await rm(legacy, { recursive: true, force: true });
}

/**
 * Moves the uploader's state from the old names to the new ones. Each step
 * stands alone: a failure leaves that entry where it was (logged) and the
 * next run tries again, and sign-out removes the old spool and bases too.
 */
export async function migrateLegacyUploadState(
  stateDir: string,
  log: (message: string, details: Record<string, unknown>) => void = () => undefined,
): Promise<void> {
  if (!(await exists(stateDir))) return;
  const steps: Array<[string, string, ((legacy: string, current: string) => Promise<void>) | null]> = [
    [LEGACY_UPLOAD_STATE_NAMES.ledger, UPLOAD_SESSION_LEDGER_FILE, mergeLedger],
    [LEGACY_UPLOAD_STATE_NAMES.spool, UPLOAD_SPOOL_DIRECTORY, mergeSpool],
    [LEGACY_UPLOAD_STATE_NAMES.bases, UPLOAD_BASE_DIRECTORY, null],
    [LEGACY_UPLOAD_STATE_NAMES.temp, UPLOAD_TEMP_DIRECTORY, null],
  ];
  for (const [legacyName, name, merge] of steps) {
    try {
      await migrateOne(stateDir, legacyName, name, merge);
    } catch (error) {
      log("OmniRush session upload state could not be moved to its new name", {
        from: legacyName,
        to: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Sign-out: whatever is left under the old names goes too. */
export async function removeLegacyUploadContent(stateDir: string): Promise<void> {
  await Promise.all([
    rm(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool), { recursive: true, force: true }),
    rm(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases), { recursive: true, force: true }),
  ]);
}
