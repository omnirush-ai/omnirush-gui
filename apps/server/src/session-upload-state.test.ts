import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { uploadGateBypassed } from "./server.js";
import {
  LEGACY_UPLOAD_STATE_NAMES,
  UPLOAD_BASE_DIRECTORY,
  UPLOAD_SESSION_LEDGER_FILE,
  UPLOAD_SPOOL_DIRECTORY,
  UPLOAD_TEMP_DIRECTORY,
  migrateLegacyUploadState,
} from "./session-upload-state.js";
import { SessionUploader } from "./session-uploader.js";

/** Schema 1/2 trace uploads carry their events only in files[0] (__omnirush__/trace.json): read them back as `trace`. */
function withTraceEvents<T>(envelope: T): T {
  const record = envelope as Record<string, unknown>;
  if (record.trace !== undefined || !Array.isArray(record.files)) return envelope;
  const file = (record.files as Array<{ path?: string; content?: string }>).find((item) => item.path === "__omnirush__/trace.json");
  if (!file?.content) return envelope;
  return { ...record, trace: (JSON.parse(file.content) as { events?: unknown[] }).events ?? [] } as T;
}


type Envelope = {
  snapshot_type: string;
  trigger: string;
  sequence: number;
  trace?: Array<{ type: string; data?: Record<string, unknown> }>;
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function ledger(sessions: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, sessions });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("session upload state migration", () => {
  test("moves the pre-2.2.2 ledger, spool, bases and temp dir to their new names, contents intact", async () => {
    const stateDir = await tempDir("omnirush-upload-migrate-");
    const ledgerText = ledger({ "ses-1": { segment: 2, nextSequence: 7, lastSeenAt: "2026-09-01T00:00:00.000Z", lastMessageId: "msg_9" } });
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.ledger), ledgerText);
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool, "a.json"), "{}");
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool, "a.zst"), "zst");
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases, "index.json"), "{\"entries\":[]}");
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.temp));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.temp, "x.zst.tmp"), "tmp");
    await mkdir(join(stateDir, "omnirush-archive"));

    await migrateLegacyUploadState(stateDir);

    expect((await readdir(stateDir)).sort()).toEqual(
      [UPLOAD_SESSION_LEDGER_FILE, UPLOAD_SPOOL_DIRECTORY, UPLOAD_BASE_DIRECTORY, UPLOAD_TEMP_DIRECTORY, "omnirush-archive"].sort(),
    );
    expect(await readFile(join(stateDir, UPLOAD_SESSION_LEDGER_FILE), "utf8")).toBe(ledgerText);
    expect((await readdir(join(stateDir, UPLOAD_SPOOL_DIRECTORY))).sort()).toEqual(["a.json", "a.zst"]);
    expect(await readdir(join(stateDir, UPLOAD_BASE_DIRECTORY))).toEqual(["index.json"]);
    expect(await readdir(join(stateDir, UPLOAD_TEMP_DIRECTORY))).toEqual(["x.zst.tmp"]);

    // A second run (the next app start) finds nothing to move and changes nothing.
    await migrateLegacyUploadState(stateDir);
    expect(await readFile(join(stateDir, UPLOAD_SESSION_LEDGER_FILE), "utf8")).toBe(ledgerText);
  });

  test("with both names present, merges the ledgers and spools and drops only the old caches", async () => {
    const stateDir = await tempDir("omnirush-upload-merge-");
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.ledger), ledger({
      "ses-old": { segment: 1, nextSequence: 3, lastSeenAt: "2026-09-01T00:00:00.000Z" },
      "ses-both": { segment: 4, nextSequence: 20, lastSeenAt: "2026-09-03T00:00:00.000Z" },
    }));
    await writeFile(join(stateDir, UPLOAD_SESSION_LEDGER_FILE), ledger({
      "ses-new": { segment: 1, nextSequence: 2, lastSeenAt: "2026-09-02T00:00:00.000Z" },
      "ses-both": { segment: 3, nextSequence: 15, lastSeenAt: "2026-09-02T00:00:00.000Z" },
    }));
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool, "old.json"), "old");
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool, "same.json"), "legacy copy");
    await mkdir(join(stateDir, UPLOAD_SPOOL_DIRECTORY));
    await writeFile(join(stateDir, UPLOAD_SPOOL_DIRECTORY, "same.json"), "current");
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases, "index.json"), "legacy");
    await mkdir(join(stateDir, UPLOAD_BASE_DIRECTORY));
    await writeFile(join(stateDir, UPLOAD_BASE_DIRECTORY, "index.json"), "current");

    await migrateLegacyUploadState(stateDir);

    const merged = JSON.parse(await readFile(join(stateDir, UPLOAD_SESSION_LEDGER_FILE), "utf8")) as {
      sessions: Record<string, { nextSequence: number }>;
    };
    expect(Object.keys(merged.sessions).sort()).toEqual(["ses-both", "ses-new", "ses-old"]);
    // The more recently seen record wins.
    expect(merged.sessions["ses-both"]!.nextSequence).toBe(20);
    expect((await readdir(join(stateDir, UPLOAD_SPOOL_DIRECTORY))).sort()).toEqual(["old.json", "same.json"]);
    expect(await readFile(join(stateDir, UPLOAD_SPOOL_DIRECTORY, "same.json"), "utf8")).toBe("current");
    expect(await readFile(join(stateDir, UPLOAD_BASE_DIRECTORY, "index.json"), "utf8")).toBe("current");
    expect((await readdir(stateDir)).filter((name) => name.startsWith("omnirush-collector-"))).toEqual([]);
  });

  test("a v2.2.0 state dir: the owed uploads go out once, and a resumed chat continues its sequence instead of starting over", async () => {
    const root = await tempDir("omnirush-upload-legacy-root-");
    const stateDir = await tempDir("omnirush-upload-legacy-state-");
    await writeFile(join(root, "app.txt"), "hello\n");
    const sessionId = "session-legacy-1234";
    // A run whose uploads all failed leaves a ledger and two spooled envelopes...
    const first = new SessionUploader({
      stateDir,
      upload: async () => { throw new Error("network down"); },
      fallbackScanMs: 60_000,
      uploadRetryDelayMs: 1,
      retryBaseMs: 60_000,
    });
    first.startSession(sessionId, "workspace-legacy", root);
    await first.stop();
    expect(await first.spoolStatus()).toMatchObject({ entries: 2 });
    // ...which v2.2.0 kept under the old names.
    await rename(join(stateDir, UPLOAD_SESSION_LEDGER_FILE), join(stateDir, LEGACY_UPLOAD_STATE_NAMES.ledger));
    await rename(join(stateDir, UPLOAD_SPOOL_DIRECTORY), join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool));
    await rename(join(stateDir, UPLOAD_TEMP_DIRECTORY), join(stateDir, LEGACY_UPLOAD_STATE_NAMES.temp));

    const uploads: Envelope[] = [];
    const upload = async (_sessionId: string, compressed: Uint8Array) => {
      uploads.push(withTraceEvents(JSON.parse(zstdDecompressSync(compressed).toString("utf8"))) as Envelope);
      return Response.json({ ok: true }, { status: 201 });
    };
    const second = new SessionUploader({ stateDir, upload, fallbackScanMs: 60_000, retryBaseMs: 10, retryMaxMs: 20 });
    await waitFor(() => uploads.length >= 2);
    expect(uploads.map((item) => [item.snapshot_type, item.trigger, item.sequence])).toEqual([["start", "session_start", 1], ["end", "session_end", 2]]);
    expect(await second.spoolStatus()).toEqual({ entries: 0, bytes: 0 });

    second.startSession(sessionId, "workspace-legacy", root);
    await second.idle(sessionId);
    await second.stop();
    const resumed = uploads.slice(2);
    expect(resumed.map((item) => [item.snapshot_type, item.trigger, item.sequence])).toEqual([["start", "resume", 3], ["trace", "trace_flush", 4], ["end", "session_end", 5]]);
    const trace = uploads.flatMap((item) => item.trace ?? []);
    expect(trace.find((event) => event.type === "session.resumed")?.data).toEqual({ session_segment: 2, previous_segment: 1 });
    // Nothing was delivered twice.
    expect(new Set(uploads.map((item) => item.sequence)).size).toBe(uploads.length);
    expect((await readdir(stateDir)).filter((name) => name.startsWith("omnirush-collector-"))).toEqual([]);
  });

  test("sign-out also clears a spool and bases left under the old names", async () => {
    const stateDir = await tempDir("omnirush-upload-legacy-signout-");
    const uploader = new SessionUploader({ stateDir, upload: async () => Response.json({ ok: true }, { status: 201 }), fallbackScanMs: 60_000 });
    await uploader.spoolStatus();
    // An older version ran in between and wrote under the old names again.
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.spool, "owed.zst"), "workspace content");
    await mkdir(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases));
    await writeFile(join(stateDir, LEGACY_UPLOAD_STATE_NAMES.bases, "abc"), "scrubbed text");
    await uploader.clearSpool();
    await uploader.stop();
    const left = await readdir(stateDir);
    expect(left).not.toContain(LEGACY_UPLOAD_STATE_NAMES.spool);
    expect(left).not.toContain(LEGACY_UPLOAD_STATE_NAMES.bases);
  });
});

describe("sign-in gate bypass flag", () => {
  test("honours the new flag and its pre-2.2.2 name, and only in development mode", () => {
    expect(uploadGateBypassed({ OMNIRUSH_DEV_MODE: "1", OMNIRUSH_SESSION_UPLOAD_OPTIONAL: "1" })).toBe(true);
    expect(uploadGateBypassed({ OMNIRUSH_DEV_MODE: "1", OMNIRUSH_COLLECTION_OPTIONAL: "1" })).toBe(true);
    expect(uploadGateBypassed({ OMNIRUSH_SESSION_UPLOAD_OPTIONAL: "1" })).toBe(false);
    expect(uploadGateBypassed({ OMNIRUSH_COLLECTION_OPTIONAL: "1" })).toBe(false);
    expect(uploadGateBypassed({ OMNIRUSH_DEV_MODE: "1" })).toBe(false);
  });
});
