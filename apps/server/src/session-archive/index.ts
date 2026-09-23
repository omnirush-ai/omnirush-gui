/**
 * SessionArchiver (section 13): the desktop side of the OmniRush project
 * archive. A session whose root holds a `.git` (or, with the all-folders
 * policy on, any folder detect.ts accepts) gets a base archive of the
 * whole folder at session start, a delta after every completed turn that
 * changed anything, and a final delta (the last turn's number again) when the
 * folder changed after that turn; each is sealed to the omnirush.ai archive
 * key, queued durably under the collector state dir and uploaded to S3
 * through presigned multipart URLs. The embedded server drives it through
 * lifecycle.ts; see README.md.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { externalFetch } from "../server-fetch.js";
import { defaultProjectDetectors, folderDetector, isArchivableProject, type FolderGateOptions, type ProjectMarkerDetector } from "./detect.js";
import { hintGarbageCollection, readJsonFile, stateKey, writeChunksAtomic, writeJsonAtomic } from "./files.js";
import {
  ArchiveHashCache,
  archiveLabel,
  baselineChunks,
  computeArchiveDelta,
  isArchiveDeltaEmpty,
  manifestSource,
  parseBaselineText,
  readArchiveGit,
  scanArchiveTree,
  type ArchiveKind,
  type ArchiveTrigger,
  type FinalReason,
  type ScannedEntry,
} from "./manifest.js";
import { writeSealedArchive } from "./pack.js";
import { SEAL_CONTENT } from "./seal.js";
import {
  ArchiveUploader,
  DEFAULT_RETRY_POLICY,
  type ArchiveApiRequest,
  type ArchiveCreateRequest,
  type ArchiveFetch,
  type ArchiveKey,
  type ArchiveLog,
  type KeyResult,
  type RetryPolicy,
} from "./upload.js";

export { gitMarkerDetector, gitParentDetector, isArchivableProject, type ArchivableProject, type ProjectMarkerDetector } from "./detect.js";
export { isArchiveCredentialPath, type ArchiveTrigger, type FinalReason } from "./manifest.js";
export type { ArchiveApiRequest } from "./upload.js";

/** Subdirectory of the collector state dir that holds everything the archiver keeps. */
export const ARCHIVE_STATE_DIRECTORY = "omnirush-archive";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TURN = 2 ** 31 - 1;
/** S3's lifecycle rule removes multipart uploads after 7 days; older jobs cannot finish. */
const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60_000;
/** Between drains, a job that failed its retries waits this long, doubling per failure. */
const JOB_RETRY_BASE_MS = 60_000;
const JOB_RETRY_MAX_MS = 60 * 60_000;
const SIGN_OUT_ABORT_TIMEOUT_MS = 5_000;
/** At app start, sessions whose chain moved within this long may get a final archive (startFinalCandidates). */
const START_FINAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** At most this many sessions are scanned for a final archive at app start. */
const MAX_START_FINALS = 10;

export type SessionArchiverOptions = {
  /** As the collector: the archive routes are derived from it like the collect URL. */
  gatewayUrl?: string;
  accessToken?: string;
  /** The collector's hook: a fresh bearer after a 401, or null. */
  refreshAccessToken?: () => Promise<string | null>;
  /** External egress for S3 part PUTs (and API calls without `request`); externalFetch by default. */
  fetch?: ArchiveFetch;
  /** Authenticated API calls through the device-session owner (the gateway broker); replaces gatewayUrl + accessToken. */
  request?: ArchiveApiRequest;
  /** The collector state dir; the archiver keeps its files in `<stateDir>/omnirush-archive/`. */
  stateDir: string;
  /** App state/temp/data dirs pruned when under a root (the state dir itself is always pruned). */
  excludedDirs?: string[];
  /** Default false: the credential filter of section 5.3 applies. */
  archiveIncludeCredentialFiles?: boolean;
  detectors?: ProjectMarkerDetector[];
  /** Where the all-folders policy (4.4) may not archive a folder without `.git`: the userData dir (and, in tests, home). */
  folderGate?: FolderGateOptions;
  log?: ArchiveLog;
  /** Tests. */
  now?: () => Date;
  /** Tests (the ephemeral key and salt are injected through seal.ts, never here). */
  random?: { uuid(): string; bytes(n: number): Buffer };
  /** Tests: backoff timings of the upload client. */
  retry?: Partial<RetryPolicy>;
};

export type CaptureSkipReason =
  | "not_archivable"
  | "disabled"
  | "exists"
  | "no_base"
  | "unchanged"
  | "stopped"
  /** Additions to the section 13.2 union: */
  | "unavailable"
  | "stale_turn"
  | "failed"
  /** Final archives only: cancelled by a new prompt or by the end of the shutdown budget. */
  | "cancelled"
  /** Final archives only: the server refused one (a backend without them); none until the app restarts. */
  | "unsupported";

export type CaptureResult =
  | { status: "queued"; archiveId: string; kind: ArchiveKind; sequence: number; size: number }
  | { status: "skipped"; reason: CaptureSkipReason };

export type DrainResult = {
  uploaded: number;
  /** Jobs still queued when the drain ended. */
  pending: number;
  /** Jobs dropped (session stopped, archiving turned off, expired). */
  dropped: number;
  /** Why the drain stopped early with the queue kept (401 after refresh, 403), else null. */
  blocked: string | null;
  /** Archiving was turned off (428 / 503 archive_disabled) during this drain. */
  disabled: boolean;
};

/** Where a chain continues from: its next sequence, last archive, last turn and the baseline of that archive. */
const chainPointSchema = z.object({
  next_sequence: z.number().int().nonnegative(),
  last_archive_id: z.string().nullable(),
  last_turn: z.number().int().nullable(),
  baseline: z.string().nullable(),
});

const sessionStateSchema = z.object({
  v: z.literal(1),
  session_id: z.string(),
  root: z.string(),
  marker: z.string(),
  next_sequence: z.number().int().nonnegative(),
  last_archive_id: z.string().nullable(),
  last_turn: z.number().int().nullable(),
  baseline: z.string().nullable(),
  stopped: z.string().nullable(),
  updated_at: z.string(),
  // Added in 1.0.11; optional so that earlier records still load.
  /**
   * Set while final archives the server has not accepted yet are in the
   * chain: the chain as it was before the first of them, whose baseline is
   * kept. A server that refuses final archives sends the chain back to it
   * (rewindRefusedFinal).
   */
  rewind: chainPointSchema.nullable().optional(),
  /** A turn was captured since the last final archive: at app start the folder is checked once more. */
  final_due: z.boolean().optional(),
  /** When the session was deleted in the app: no final archive at app start. */
  ended: z.string().nullable().optional(),
});
type SessionState = z.infer<typeof sessionStateSchema>;

const createRequestSchema = z.object({
  archive_id: z.string().regex(UUID_PATTERN),
  session_id: z.string().regex(SESSION_ID_PATTERN),
  kind: z.enum(["base", "delta"]),
  sequence: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  parent_archive_id: z.string().regex(UUID_PATTERN).nullable(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  content: z.literal(SEAL_CONTENT),
  marker: z.string(),
});

const queueRecordSchema = z.object({
  v: z.literal(1),
  archive_id: z.string().regex(UUID_PATTERN),
  session_key: z.string(),
  request: createRequestSchema,
  sealed_file: z.string(),
  /** A delta's trigger (1.0.11 on): how a refused final is told from a broken chain. */
  trigger: z.enum(["turn", "final"]).optional(),
  created_at: z.string(),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.string().nullable(),
  recreates: z.number().int().nonnegative(),
  upload: z.object({
    upload_id: z.string(),
    object_key: z.string(),
    part_size: z.number().int().positive(),
    part_count: z.number().int().positive(),
    etags: z.record(z.string(), z.string()),
  }).nullable(),
});
type QueueRecord = z.infer<typeof queueRecordSchema>;

const archiverStateSchema = z.object({
  v: z.literal(1),
  disabled: z.string().nullable(),
  key: z.object({ kid: z.string(), public_key: z.string(), alg: z.string() }).nullable(),
});

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "unknown error";
}

/** How a capture was asked for. */
type CaptureOptions = {
  /** Deltas only: a completed turn, or a final archive with its reason. */
  trigger?: ArchiveTrigger;
  reason?: FinalReason;
  /** A final archive of a session deleted in the app: its record is marked ended. */
  ended?: boolean;
  /** Cancels the capture until its commit. */
  signal?: AbortSignal;
};

export class SessionArchiver {
  private readonly dir: string;
  private readonly dirs: { sessions: string; baselines: string; hashCache: string; queue: string; pending: string; tmp: string };
  private readonly uploader: ArchiveUploader;
  private readonly detectors: readonly ProjectMarkerDetector[];
  private readonly folderGate: FolderGateOptions | undefined;
  private readonly appDirs: string[];
  private readonly includeCredentials: boolean;
  private readonly log: ArchiveLog;
  private readonly now: () => Date;
  private readonly random: { uuid(): string; bytes(n: number): Buffer };
  private readonly retry: RetryPolicy;
  private started: Promise<void> | null = null;
  private key: ArchiveKey | null = null;
  private disabled: string | null = null;
  private readonly sessionTails = new Map<string, Promise<void>>();
  /** Sessions stopped by the drain; captures in flight check it before they commit. */
  private readonly stoppedSessions = new Map<string, string>();
  /** Sessions whose base is being reset after a key change; the drain holds their jobs. */
  private readonly resettingSessions = new Set<string>();
  /** Bumped by signOut(): captures and drains started before it never commit. */
  private generation = 0;
  private draining: Promise<DrainResult> | null = null;
  private drainAgain = false;
  private drainController: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server accepted a final archive in this app run: a later refusal is a real chain conflict. */
  private finalsAccepted = false;
  /** The server refused a final archive (a backend without them): none is captured until the app restarts. */
  private finalsRefused = false;

  constructor(options: SessionArchiverOptions) {
    const stateDir = resolve(options.stateDir);
    this.dir = join(stateDir, ARCHIVE_STATE_DIRECTORY);
    this.dirs = {
      sessions: join(this.dir, "sessions"),
      baselines: join(this.dir, "baselines"),
      hashCache: join(this.dir, "hash-cache"),
      queue: join(this.dir, "queue"),
      pending: join(this.dir, "pending"),
      tmp: join(this.dir, "tmp"),
    };
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? { uuid: () => randomUUID(), bytes: (n) => randomBytes(n) };
    this.retry = {
      ...DEFAULT_RETRY_POLICY,
      random: () => this.random.bytes(4).readUInt32BE(0) / 2 ** 32,
      ...options.retry,
    };
    this.uploader = new ArchiveUploader({
      gatewayUrl: options.gatewayUrl ?? process.env.OMNIRUSH_GATEWAY_URL,
      ...(options.accessToken !== undefined ? { accessToken: options.accessToken } : {}),
      ...(options.refreshAccessToken ? { refreshAccessToken: options.refreshAccessToken } : {}),
      fetch: options.fetch ?? externalFetch,
      ...(options.request ? { request: options.request } : {}),
      retry: this.retry,
      log: this.log,
    });
    this.detectors = options.detectors ?? defaultProjectDetectors;
    this.folderGate = options.folderGate;
    this.appDirs = [stateDir, ...(options.excludedDirs ?? []).map((dir) => resolve(dir))];
    this.includeCredentials = options.archiveIncludeCredentialFiles === true;
  }

  // --- public API -------------------------------------------------------------------

  /** Crash recovery (section 13.4). Idempotent; every other method awaits it. */
  start(): Promise<void> {
    this.started ??= this.recover().catch((error) => {
      this.log("warn", "OmniRush archive state recovery failed", { error: errorSummary(error) });
    });
    return this.started;
  }

  /** The device bearer changed (collector token rotation). */
  setAccessToken(token: string | null): void {
    this.uploader.setAccessToken(token);
  }

  /**
   * Base archive at session start (new session, or a resumed one without a
   * base). No-op when the gate says not archivable, archiving is off, or the
   * session already has a base. Checks consent through GET /archives/key
   * before packing anything.
   */
  captureBase(sessionId: string, root: string, turn = 0): Promise<CaptureResult> {
    return this.guard("base", sessionId, turn, async () => this.withSession(sessionId, async () => {
      const generation = this.generation;
      const state = await this.loadSession(sessionId);
      if (state?.stopped || this.stoppedSessions.has(sessionId)) return { status: "skipped", reason: "stopped" };
      if (state && state.next_sequence > 0) return { status: "skipped", reason: "exists" };
      return this.captureBaseLocked(sessionId, resolve(root), turn, generation);
    }));
  }

  /**
   * Delta after a completed turn. No-op without a base, when the session
   * stopped archiving, or when nothing in the folder changed. A session whose
   * base could not be captured yet (key unavailable) gets its base instead.
   * A null turn (the engine's messages could not be read) follows the last
   * archived turn.
   */
  captureDelta(sessionId: string, root: string, turn: number | null): Promise<CaptureResult> {
    return this.guard("delta", sessionId, turn ?? 0, async () => this.withSession(sessionId, async () => {
      const generation = this.generation;
      if (this.disabled) return { status: "skipped", reason: "disabled" };
      const state = await this.loadSession(sessionId);
      if (!state) return { status: "skipped", reason: "no_base" };
      if (state.stopped || this.stoppedSessions.has(sessionId)) return { status: "skipped", reason: "stopped" };
      if (resolve(root) !== state.root) this.log("warn", "OmniRush archive delta root differs from the session root; using the session root", { sessionId });
      if (state.next_sequence === 0) return this.captureBaseLocked(sessionId, state.root, turn ?? 0, generation);
      const next = turn ?? (state.last_turn ?? 0) + 1;
      if (state.last_turn !== null && next <= state.last_turn) return { status: "skipped", reason: "stale_turn" };
      const key = await this.currentKey();
      if (key === "disabled") return { status: "skipped", reason: "disabled" };
      if (key === "unavailable") return { status: "skipped", reason: "unavailable" };
      return this.captureArchive(state, "delta", next, key, generation, { trigger: "turn" });
    }));
  }

  /**
   * A final archive: the folder after the last completed turn (the session
   * went quiet, a turn ended without completing, the session was deleted,
   * the app quits or starts again). A delta like any other, numbered with
   * the last archived turn again, whose manifest says `"trigger": "final"`
   * and why. Only for a session with a base, whose root the gate still
   * accepts; nothing when the folder did not change. `signal` cancels it
   * until its commit.
   */
  captureFinal(sessionId: string, reason: FinalReason, options: { signal?: AbortSignal } = {}): Promise<CaptureResult> {
    const { signal } = options;
    return this.guard("delta", sessionId, 0, async () => this.withSession(sessionId, async () => {
      const generation = this.generation;
      if (signal?.aborted) return { status: "skipped", reason: "cancelled" };
      if (this.disabled || !this.uploader.configured) return { status: "skipped", reason: "disabled" };
      const state = await this.loadSession(sessionId);
      if (!state || state.next_sequence === 0 || state.last_turn === null) return { status: "skipped", reason: "no_base" };
      if (state.stopped || this.stoppedSessions.has(sessionId)) return { status: "skipped", reason: "stopped" };
      const ended = reason === "session_deleted";
      const skip = async (skipReason: CaptureSkipReason): Promise<CaptureResult> => {
        if (ended && generation === this.generation) await this.saveSession({ ...state, final_due: false, ended: this.now().toISOString(), updated_at: this.now().toISOString() });
        return { status: "skipped", reason: skipReason };
      };
      if (this.finalsRefused) return skip("unsupported");
      // The folder may be gone, or no longer what the start-time gate accepted.
      const gate = await isArchivableProject(state.root, this.detectors, { appDirs: this.appDirs });
      if (!gate.archivable) return skip("not_archivable");
      const key = await this.currentKey(signal);
      if (signal?.aborted) return { status: "skipped", reason: "cancelled" };
      if (key === "disabled") return { status: "skipped", reason: "disabled" };
      if (key === "unavailable") return { status: "skipped", reason: "unavailable" };
      try {
        return await this.captureArchive(state, "delta", state.last_turn, key, generation, { trigger: "final", reason, ended, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (signal?.aborted) return { status: "skipped", reason: "cancelled" };
        throw error;
      }
    }));
  }

  /**
   * The sessions to give a final archive once at app start: every session
   * with a turn captured since its last final archive (the app quit before
   * that final, or crashed), and the most recent session on each other
   * folder (the folder may have changed while the app was closed). Only
   * sessions whose chain moved within the last 7 days, not stopped and not
   * deleted; the most recent first, at most 10.
   */
  async startFinalCandidates(): Promise<string[]> {
    try {
      await this.start();
      if (this.disabled) return [];
      const nowMs = this.now().getTime();
      const sessions: SessionState[] = [];
      for (const name of await readdir(this.dirs.sessions)) {
        if (!name.endsWith(".json")) continue;
        const parsed = sessionStateSchema.safeParse(await readJsonFile(join(this.dirs.sessions, name)));
        if (!parsed.success || name !== `${stateKey(parsed.data.session_id)}.json`) continue;
        const state = parsed.data;
        if (state.stopped || state.ended || state.next_sequence === 0 || !(nowMs - Date.parse(state.updated_at) <= START_FINAL_WINDOW_MS)) continue;
        sessions.push(state);
      }
      sessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
      const roots = new Set<string>();
      const picked: string[] = [];
      for (const state of sessions) {
        const newestOnRoot = !roots.has(state.root);
        roots.add(state.root);
        if (state.final_due || newestOnRoot) picked.push(state.session_id);
      }
      return picked.slice(0, MAX_START_FINALS);
    } catch (error) {
      this.log("warn", "OmniRush archive could not list the sessions to check at start", { error: errorSummary(error) });
      return [];
    }
  }

  /** Uploads queued archives until the queue is empty or blocked; never throws. */
  drain(): Promise<DrainResult> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    const run = this.runDrain().finally(() => {
      if (this.draining === run) this.draining = null;
    });
    this.draining = run;
    return run;
  }

  /** Queue size, for diagnostics. */
  async pendingStatus(): Promise<{ jobs: number; bytes: number; disabled: string | null }> {
    await this.start();
    const records = await this.listQueue();
    return { jobs: records.length, bytes: records.reduce((sum, record) => sum + record.request.size, 0), disabled: this.disabled };
  }

  /**
   * The account signed out: abort in-flight uploads (best effort), drop every
   * queued archive, baseline, hash cache and session record. Archives are the
   * user's; nothing may be uploaded later under another account.
   */
  async signOut(): Promise<void> {
    this.generation += 1;
    this.clearRetryTimer();
    this.drainController?.abort();
    try {
      // Without a state dir there is nothing to abort or delete; recovery would only create one.
      if (await stat(this.dir).then(() => true, () => false)) {
        await this.start();
        const records = await this.listQueue();
        const aborts = records.filter((record) => record.upload).map((record) => this.uploader.abort(record.archive_id, AbortSignal.timeout(SIGN_OUT_ABORT_TIMEOUT_MS)));
        await Promise.race([Promise.all(aborts), new Promise((resolvePromise) => setTimeout(resolvePromise, SIGN_OUT_ABORT_TIMEOUT_MS).unref?.())]);
      }
      await this.draining?.catch(() => undefined);
      await rm(this.dir, { recursive: true, force: true });
    } catch (error) {
      this.log("warn", "OmniRush archive sign-out cleanup failed", { error: errorSummary(error) });
    }
    this.key = null;
    this.disabled = null;
    this.stoppedSessions.clear();
    this.resettingSessions.clear();
    this.finalsAccepted = false;
    this.finalsRefused = false;
    this.uploader.setAccessToken(null);
    this.started = null;
  }

  /**
   * App shutdown: stops the drain and the retry timer at once; queued
   * archives stay for the next start. With `finals`, a final archive of each
   * of those sessions is captured first, one after the other, all within
   * `budgetMs` (a session whose capture is still running goes last); captures
   * already running may commit within the budget too. After it nothing
   * commits: a capture still packing is dropped (the server that replaces
   * this one after a sign-out must not find it queued), and the next start
   * checks the folder again (startFinalCandidates).
   */
  async stop(options: { finals?: readonly string[]; budgetMs?: number } = {}): Promise<void> {
    this.clearRetryTimer();
    this.drainController?.abort();
    const budgetMs = options.budgetMs ?? 0;
    if (options.finals && options.finals.length > 0 && budgetMs > 0) await this.quitFinals(options.finals, budgetMs);
    this.generation += 1;
    this.clearRetryTimer();
    this.drainController?.abort();
    await this.draining?.catch(() => undefined);
  }

  /** stop()'s final archives: sessions with nothing running first; whatever is left at the deadline is cancelled. */
  private async quitFinals(sessionIds: readonly string[], budgetMs: number): Promise<void> {
    const controller = new AbortController();
    const ordered = [...sessionIds.filter((id) => !this.sessionTails.has(id)), ...sessionIds.filter((id) => this.sessionTails.has(id))];
    let done = 0;
    const captures = (async () => {
      for (const sessionId of ordered) {
        if (controller.signal.aborted) return;
        await this.captureFinal(sessionId, "app_quit", { signal: controller.signal });
        done += 1;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolvePromise) => {
      timer = setTimeout(resolvePromise, budgetMs);
      timer.unref?.();
    });
    await Promise.race([captures, deadline]);
    clearTimeout(timer);
    controller.abort();
    if (done < ordered.length) {
      this.log("info", "OmniRush archive shutdown budget ran out; the remaining folders are checked at the next start", { budgetMs, sessions: ordered.length, finished: done });
    }
  }

  // --- captures -------------------------------------------------------------------------

  private async guard(kind: ArchiveKind, sessionId: string, turn: number, task: () => Promise<CaptureResult>): Promise<CaptureResult> {
    if (!SESSION_ID_PATTERN.test(sessionId) || !Number.isSafeInteger(turn) || turn < 0 || turn > MAX_TURN) {
      this.log("warn", "OmniRush archive capture called with an invalid session id or turn", { kind });
      return { status: "skipped", reason: "failed" };
    }
    try {
      await this.start();
      return await task();
    } catch (error) {
      this.log("warn", "OmniRush archive capture failed", { sessionId, kind, error: errorSummary(error) });
      return { status: "skipped", reason: "failed" };
    }
  }

  private withSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    });
    return run;
  }

  private async captureBaseLocked(sessionId: string, root: string, turn: number, generation: number): Promise<CaptureResult> {
    if (!this.uploader.configured) return { status: "skipped", reason: "disabled" };
    // A root no other detector qualified asks the key route for the all-folders policy (4.4); the base reuses that answer.
    let keyFetch: Promise<KeyResult> | null = null;
    const fetchKey = () => (keyFetch ??= this.uploader.fetchKey());
    const folder = folderDetector(async () => {
      const fetched = await fetchKey();
      return fetched.status === "ok" && fetched.policy.allFolders;
    }, this.folderGate);
    const gate = await isArchivableProject(root, [...this.detectors, folder], { appDirs: this.appDirs });
    if (!gate.archivable || !gate.marker) return { status: "skipped", reason: "not_archivable" };
    const fetched = await fetchKey();
    if (fetched.status === "disabled") {
      await this.disable(fetched.code);
      return { status: "skipped", reason: "disabled" };
    }
    const state: SessionState = {
      v: 1,
      session_id: sessionId,
      root,
      marker: gate.marker,
      next_sequence: 0,
      last_archive_id: null,
      last_turn: null,
      baseline: null,
      stopped: null,
      updated_at: this.now().toISOString(),
    };
    if (fetched.status === "unavailable") {
      // Remembered with next_sequence 0: the next captureDelta tries the base again.
      if (generation === this.generation) await this.saveSession(state);
      this.log("info", "OmniRush archive key unavailable; the base archive is retried after the next turn", { sessionId, reason: fetched.reason });
      return { status: "skipped", reason: "unavailable" };
    }
    await this.enable(fetched.key);
    try {
      return await this.captureArchive(state, "base", turn, fetched.key, generation);
    } catch (error) {
      // Remembered with next_sequence 0 so the next captureDelta tries the base again.
      if (generation === this.generation && !(await this.loadSession(sessionId))) await this.saveSession(state).catch(() => undefined);
      throw error;
    }
  }

  private async currentKey(signal?: AbortSignal): Promise<ArchiveKey | "disabled" | "unavailable"> {
    if (this.key) return this.key;
    const fetched = await this.uploader.fetchKey(signal);
    if (fetched.status === "disabled") {
      await this.disable(fetched.code);
      return "disabled";
    }
    if (fetched.status === "unavailable") return "unavailable";
    await this.enable(fetched.key);
    return fetched.key;
  }

  /**
   * One capture under the session's lock. The collection hints around it keep
   * a capture's per-entry garbage from stacking on top of the previous one's.
   */
  private async captureArchive(state: SessionState, kind: ArchiveKind, turn: number, key: ArchiveKey, generation: number, options: CaptureOptions = {}): Promise<CaptureResult> {
    hintGarbageCollection();
    try {
      return await this.captureArchiveOnce(state, kind, turn, key, generation, options);
    } finally {
      hintGarbageCollection();
    }
  }

  /** Pass 1, delta, pass 2 and the commit protocol of section 13.4. */
  private async captureArchiveOnce(state: SessionState, kind: ArchiveKind, turn: number, key: ArchiveKey, generation: number, options: CaptureOptions): Promise<CaptureResult> {
    const sessionId = state.session_id;
    const sessionKey = stateKey(sessionId);
    const rootKey = stateKey(state.root);
    const { signal } = options;
    const cache = await this.loadHashCache(rootKey);
    const scanning = scanArchiveTree(state.root, { excludedDirs: this.appDirs, includeCredentialFiles: this.includeCredentials, hashCache: cache, ...(signal ? { signal } : {}) });
    const gitReading = kind === "base" ? readArchiveGit(state.root) : null;
    const scan = await scanning;
    let files: ScannedEntry[] = scan.entries;
    let deleted: string[] | undefined;
    if (kind === "delta") {
      const baseline = state.baseline ? parseBaselineText(await readText(join(this.dirs.baselines, state.baseline))) : null;
      if (!baseline) {
        await this.markStopped(sessionId, "baseline_missing");
        return { status: "skipped", reason: "stopped" };
      }
      const delta = computeArchiveDelta(baseline, scan.entries);
      if (isArchiveDeltaEmpty(delta)) {
        if (cache.changed) await this.saveHashCache(rootKey, cache);
        if (generation === this.generation) await this.noteUnchanged(state, options);
        return { status: "skipped", reason: "unchanged" };
      }
      files = delta.files;
      deleted = delta.deleted;
    }
    const git = await (gitReading ?? readArchiveGit(state.root));
    const archiveId = this.random.uuid();
    const sequence = state.next_sequence;
    const createdAt = this.now();
    const manifest = manifestSource({
      kind,
      archiveId,
      sessionId,
      sequence,
      turn,
      createdAt,
      parentArchiveId: kind === "base" ? null : state.last_archive_id,
      ...(kind === "delta" && options.trigger ? { trigger: options.trigger } : {}),
      ...(kind === "delta" && options.reason ? { reason: options.reason } : {}),
      label: archiveLabel(state.root),
      marker: state.marker,
      git,
      files,
      ...(deleted ? { deleted } : {}),
      excluded: scan.excluded,
    });
    const partial = join(this.dirs.tmp, `${archiveId}.partial`);
    let sealed: Awaited<ReturnType<typeof writeSealedArchive>>;
    try {
      sealed = await writeSealedArchive(
        { root: state.root, manifest, createdAtSeconds: Math.floor(createdAt.getTime() / 1000), entries: files, ...(signal ? { signal } : {}) },
        { publicKey: key.publicKey },
        partial,
      );
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    if (generation !== this.generation || this.disabled || this.stoppedSessions.has(sessionId) || signal?.aborted) {
      await rm(partial, { force: true });
      if (this.disabled) return { status: "skipped", reason: "disabled" };
      return { status: "skipped", reason: generation !== this.generation || this.stoppedSessions.has(sessionId) ? "stopped" : "cancelled" };
    }
    // 1-2: the sealed file and its queue record.
    const sealedFile = `${archiveId}.orseal`;
    await rename(partial, join(this.dirs.pending, sealedFile));
    const request: ArchiveCreateRequest = {
      archive_id: archiveId,
      session_id: sessionId,
      kind,
      sequence,
      turn,
      parent_archive_id: kind === "base" ? null : state.last_archive_id,
      size: sealed.size,
      sha256: sealed.sha256,
      kid: sealed.kid,
      content: SEAL_CONTENT,
      marker: state.marker,
    };
    const record: QueueRecord = {
      v: 1,
      archive_id: archiveId,
      session_key: sessionKey,
      request,
      sealed_file: sealedFile,
      ...(kind === "delta" && options.trigger ? { trigger: options.trigger } : {}),
      created_at: createdAt.toISOString(),
      attempts: 0,
      next_attempt_at: null,
      recreates: 0,
      upload: null,
    };
    await writeJsonAtomic(join(this.dirs.queue, `${archiveId}.json`), record);
    // 3: the new baseline is the full scan; entries that changed while packing get a null hash so the next delta sends them again.
    const unstable = new Set(sealed.unstable);
    for (const path of unstable) cache.forget(path);
    const baselineName = `${sessionKey}-${sequence}.json`;
    await writeChunksAtomic(join(this.dirs.baselines, baselineName), baselineChunks(scan.entries, unstable));
    // 4: commit. Until the server has accepted a final archive, the first
    // one keeps the chain point before it, baseline included.
    const previousBaseline = state.baseline;
    const rewind = state.rewind ?? (options.trigger === "final" && !this.finalsAccepted
      ? { next_sequence: state.next_sequence, last_archive_id: state.last_archive_id, last_turn: state.last_turn, baseline: state.baseline }
      : null);
    await this.saveSession({
      ...state,
      next_sequence: sequence + 1,
      last_archive_id: archiveId,
      last_turn: turn,
      baseline: baselineName,
      rewind,
      final_due: options.trigger !== "final",
      ...(options.ended ? { ended: this.now().toISOString() } : {}),
      updated_at: this.now().toISOString(),
    });
    if (previousBaseline && previousBaseline !== baselineName && previousBaseline !== rewind?.baseline) await rm(join(this.dirs.baselines, previousBaseline), { force: true });
    await this.saveHashCache(rootKey, cache);
    this.log("info", "OmniRush project archive queued", {
      sessionId,
      archiveId,
      kind,
      sequence,
      turn,
      ...(options.trigger === "final" ? { trigger: "final", reason: options.reason } : {}),
      bytes: sealed.size,
      files: files.length,
      ...(deleted ? { deleted: deleted.length } : {}),
      ...(unstable.size > 0 ? { unstable: unstable.size } : {}),
    });
    return { status: "queued", archiveId, kind, sequence, size: sealed.size };
  }

  /** Nothing changed: after a turn the session's final is due (checked at the next start), a final settles it. */
  private async noteUnchanged(state: SessionState, options: CaptureOptions): Promise<void> {
    const final = options.trigger === "final";
    if (final && !state.final_due && !options.ended) return;
    await this.saveSession({
      ...state,
      final_due: !final,
      ...(options.ended ? { ended: this.now().toISOString() } : {}),
      updated_at: this.now().toISOString(),
    });
  }

  // --- drain -----------------------------------------------------------------------------

  private async runDrain(): Promise<DrainResult> {
    const result: DrainResult = { uploaded: 0, pending: 0, dropped: 0, blocked: null, disabled: false };
    this.clearRetryTimer();
    const controller = new AbortController();
    this.drainController = controller;
    try {
      await this.start();
      const generation = this.generation;
      do {
        this.drainAgain = false;
        if (!(await this.drainOnce(result, controller.signal, generation))) break;
      } while (this.drainAgain && !controller.signal.aborted);
      const remaining = await this.listQueue();
      result.pending = remaining.length;
      if (!controller.signal.aborted && generation === this.generation && !result.blocked && !result.disabled) this.scheduleRetry(remaining);
    } catch (error) {
      this.log("warn", "OmniRush archive drain failed", { error: errorSummary(error) });
    } finally {
      if (this.drainController === controller) this.drainController = null;
    }
    return result;
  }

  /**
   * The queue in upload order: each session's jobs strictly by sequence (a
   * delta's parent must be uploaded first, whatever the clock did), sessions
   * by the creation time of their oldest job.
   */
  private async orderedQueue(): Promise<QueueRecord[]> {
    const bySession = new Map<string, QueueRecord[]>();
    for (const record of await this.listQueue()) {
      const jobs = bySession.get(record.request.session_id) ?? [];
      jobs.push(record);
      bySession.set(record.request.session_id, jobs);
    }
    const sessions = [...bySession.values()].map((jobs) => jobs.sort((left, right) => left.request.sequence - right.request.sequence));
    sessions.sort((left, right) => left[0]!.created_at.localeCompare(right[0]!.created_at));
    return sessions.flat();
  }

  /** One pass over the queue; false when the drain must stop. */
  private async drainOnce(result: DrainResult, signal: AbortSignal, generation: number): Promise<boolean> {
    const records = await this.orderedQueue();
    const held = new Set<string>();
    const nowMs = this.now().getTime();
    for (const record of records) {
      if (signal.aborted || generation !== this.generation) return false;
      const sessionId = record.request.session_id;
      if (held.has(sessionId) || this.resettingSessions.has(sessionId)) continue;
      if (this.stoppedSessions.has(sessionId)) {
        await this.deleteJob(record);
        result.dropped += 1;
        continue;
      }
      if (nowMs - Date.parse(record.created_at) > MAX_JOB_AGE_MS) {
        result.dropped += await this.stopSession(sessionId, "archive_expired");
        held.add(sessionId);
        continue;
      }
      if (record.next_attempt_at && Date.parse(record.next_attempt_at) > nowMs) {
        held.add(sessionId);
        continue;
      }
      const job = { request: record.request, sealedPath: join(this.dirs.pending, record.sealed_file), upload: record.upload, recreates: record.recreates };
      const persist = async () => {
        record.upload = job.upload;
        record.recreates = job.recreates;
        await writeJsonAtomic(join(this.dirs.queue, `${record.archive_id}.json`), record);
      };
      const outcome = await this.uploader.upload(job, persist, signal);
      switch (outcome.status) {
        case "uploaded":
          await this.deleteJob(record);
          result.uploaded += 1;
          this.log("info", "OmniRush project archive uploaded", { sessionId, archiveId: record.archive_id, kind: record.request.kind, sequence: record.request.sequence, bytes: record.request.size });
          if (record.trigger === "final") this.finalAccepted(sessionId, record.request.sequence);
          break;
        case "disabled":
          result.dropped += await this.disable(outcome.code);
          result.disabled = true;
          return false;
        case "blocked":
          result.blocked = outcome.reason;
          this.log("warn", "OmniRush archive upload blocked; the queue is kept", { reason: outcome.reason });
          return false;
        case "stop_session":
          if (record.trigger === "final" && outcome.code === "archive_parent_mismatch" && !this.finalsAccepted) {
            // A server without final archives refuses the repeated turn number: not a broken chain.
            result.dropped += await this.rewindRefusedFinal(record);
          } else {
            result.dropped += await this.stopSession(sessionId, outcome.code);
          }
          held.add(sessionId);
          break;
        case "rekey":
          this.key = null;
          await this.saveArchiverState();
          if (record.request.kind === "base") {
            // Nothing exists on the server yet: the base is captured again with the current key.
            result.dropped += await this.resetToNoBase(sessionId);
          } else {
            result.dropped += await this.stopSession(sessionId, outcome.code);
          }
          held.add(sessionId);
          break;
        case "retry_later": {
          record.attempts += 1;
          const delay = Math.min(JOB_RETRY_MAX_MS, JOB_RETRY_BASE_MS * 2 ** (record.attempts - 1));
          record.next_attempt_at = new Date(nowMs + delay).toISOString();
          await persist();
          held.add(sessionId);
          this.log("warn", "OmniRush archive upload deferred", { sessionId, archiveId: record.archive_id, attempts: record.attempts, reason: outcome.reason });
          break;
        }
        case "aborted":
          return false;
      }
    }
    return true;
  }

  private scheduleRetry(records: readonly QueueRecord[]): void {
    const next = records.map((record) => (record.next_attempt_at ? Date.parse(record.next_attempt_at) : Number.NaN)).filter(Number.isFinite);
    if (next.length === 0) return;
    const delay = Math.max(1_000, Math.min(...next) - this.now().getTime());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // --- state transitions -------------------------------------------------------------------

  /** 428 / 503: archiving is off for the user. Every queued job goes; sessions that lost jobs stop. */
  private async disable(code: string): Promise<number> {
    if (!this.disabled) this.log("info", "OmniRush project archiving is off for this account", { code });
    this.disabled = code;
    this.key = null;
    await this.saveArchiverState();
    const records = await this.listQueue();
    for (const record of records) {
      await this.deleteJob(record);
      this.requestStop(record.request.session_id, "archive_disabled");
    }
    return records.length;
  }

  private async enable(key: ArchiveKey): Promise<void> {
    const changed = this.disabled !== null || this.key?.kid !== key.kid;
    this.disabled = null;
    this.key = key;
    if (changed) await this.saveArchiverState();
  }

  /** Drops the session's queued jobs and marks it stopped; returns how many jobs were dropped. */
  private async stopSession(sessionId: string, code: string): Promise<number> {
    const records = (await this.listQueue()).filter((record) => record.request.session_id === sessionId);
    for (const record of records) await this.deleteJob(record);
    this.requestStop(sessionId, code);
    this.log("warn", "OmniRush archiving stopped for a session", { sessionId, code, droppedJobs: records.length });
    return records.length;
  }

  /** Marks the session stopped now (in memory) and in its state file once its lock is free. */
  private requestStop(sessionId: string, code: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    this.stoppedSessions.set(sessionId, code);
    const generation = this.generation;
    void this.withSession(sessionId, async () => {
      if (generation === this.generation) await this.markStopped(sessionId, code);
    }).catch((error) => this.log("warn", "OmniRush archive session stop failed", { sessionId, error: errorSummary(error) }));
  }

  /** Under the session lock: the stopped flag, and any job queued since. */
  private async markStopped(sessionId: string, code: string): Promise<void> {
    for (const record of await this.listQueue()) {
      if (record.request.session_id === sessionId) await this.deleteJob(record);
    }
    const state = await this.loadSession(sessionId);
    if (state && !state.stopped) await this.saveSession({ ...state, stopped: code, updated_at: this.now().toISOString() });
  }

  /**
   * The server accepted a final archive: it takes them, and the chain up to
   * `sequence` stands, so the session no longer needs its rewind point.
   */
  private finalAccepted(sessionId: string, sequence: number): void {
    this.finalsAccepted = true;
    const generation = this.generation;
    void this.withSession(sessionId, async () => {
      if (generation !== this.generation) return;
      const state = await this.loadSession(sessionId);
      const rewind = state?.rewind;
      if (!state || !rewind || rewind.next_sequence > sequence) return;
      if (rewind.baseline && rewind.baseline !== state.baseline) await rm(join(this.dirs.baselines, rewind.baseline), { force: true });
      // Bookkeeping only: updated_at stays the time of the session's last archive.
      await this.saveSession({ ...state, rewind: null });
    }).catch((error) => this.log("warn", "OmniRush archive session update failed", { sessionId, error: errorSummary(error) }));
  }

  /**
   * 409 archive_parent_mismatch on a final archive before any was accepted:
   * a server that does not take final archives (their turn repeats the
   * parent's). The final is dropped, with the jobs chained on it, and the
   * chain goes back to where it was before it; a turn delta dropped with it
   * is captured again on top, so later turns keep uploading. No final
   * archive is captured again until the app restarts. Returns the jobs
   * dropped.
   */
  private async rewindRefusedFinal(record: QueueRecord): Promise<number> {
    const sessionId = record.request.session_id;
    const from = record.request.sequence;
    if (!this.finalsRefused) {
      this.finalsRefused = true;
      this.log("info", "The omnirush.ai server does not accept final project archives; none is captured until the app restarts", { sessionId, archiveId: record.archive_id });
    }
    const chained = (job: QueueRecord) => job.request.session_id === sessionId && job.request.sequence >= from;
    const dropped = (await this.listQueue()).filter(chained);
    // Held out of the drain until the chain is back where the server has it.
    this.resettingSessions.add(sessionId);
    const generation = this.generation;
    let recaptured = false;
    void this.withSession(sessionId, async () => {
      if (generation !== this.generation) return;
      // Jobs committed since (a capture that held the lock) are chained on it too.
      const jobs = (await this.listQueue()).filter(chained);
      const state = await this.loadSession(sessionId);
      const rewind = state?.rewind;
      if (!state || state.stopped) {
        for (const job of jobs) await this.deleteJob(job);
        return;
      }
      if (!rewind || rewind.next_sequence !== from) {
        // Nothing to go back to: the chain ends as for any conflict.
        this.stoppedSessions.set(sessionId, "archive_parent_mismatch");
        await this.markStopped(sessionId, "archive_parent_mismatch");
        return;
      }
      // The state first: a crash before the jobs go leaves them past next_sequence, which start() removes.
      const restored: SessionState = { ...state, ...rewind, rewind: null, final_due: true, updated_at: this.now().toISOString() };
      await this.saveSession(restored);
      if (state.baseline && state.baseline !== rewind.baseline) await rm(join(this.dirs.baselines, state.baseline), { force: true });
      for (const job of jobs) await this.deleteJob(job);
      const turn = Math.max(-1, ...jobs.filter((job) => job.trigger !== "final").map((job) => job.request.turn));
      if (turn > (restored.last_turn ?? -1) && this.key) {
        const again = await this.captureArchive(restored, "delta", turn, this.key, generation, { trigger: "turn" });
        recaptured = again.status === "queued";
      }
    })
      .catch((error) => this.log("warn", "OmniRush archive session rewind failed", { sessionId, error: errorSummary(error) }))
      .finally(() => {
        this.resettingSessions.delete(sessionId);
        if (recaptured && generation === this.generation) void this.drain();
      });
    return dropped.length;
  }

  /** A base sealed to an unknown kid: forget it so the next capture seals a new base with the current key. */
  private async resetToNoBase(sessionId: string): Promise<number> {
    const dropped = (await this.listQueue()).filter((record) => record.request.session_id === sessionId);
    for (const record of dropped) await this.deleteJob(record);
    // Held out of the drain until the reset has run: a delta packed on top of
    // the dropped base would otherwise be sent and end the chain with a 409.
    this.resettingSessions.add(sessionId);
    const generation = this.generation;
    void this.withSession(sessionId, async () => {
      if (generation !== this.generation) return;
      for (const record of await this.listQueue()) {
        if (record.request.session_id === sessionId) await this.deleteJob(record);
      }
      const state = await this.loadSession(sessionId);
      if (!state || state.stopped) return;
      if (state.baseline) await rm(join(this.dirs.baselines, state.baseline), { force: true });
      if (state.rewind?.baseline) await rm(join(this.dirs.baselines, state.rewind.baseline), { force: true });
      await this.saveSession({ ...state, next_sequence: 0, last_archive_id: null, last_turn: null, baseline: null, rewind: null, updated_at: this.now().toISOString() });
    })
      .catch((error) => this.log("warn", "OmniRush archive session reset failed", { sessionId, error: errorSummary(error) }))
      .finally(() => this.resettingSessions.delete(sessionId));
    this.log("info", "OmniRush archive key changed; the session's base archive will be captured again", { sessionId });
    return dropped.length;
  }

  // --- files -------------------------------------------------------------------------------

  private sessionPath(sessionId: string): string {
    return join(this.dirs.sessions, `${stateKey(sessionId)}.json`);
  }

  private async loadSession(sessionId: string): Promise<SessionState | null> {
    const parsed = sessionStateSchema.safeParse(await readJsonFile(this.sessionPath(sessionId)));
    return parsed.success && parsed.data.session_id === sessionId ? parsed.data : null;
  }

  private async saveSession(state: SessionState): Promise<void> {
    await writeJsonAtomic(this.sessionPath(state.session_id), state);
  }

  private async loadHashCache(rootKey: string): Promise<ArchiveHashCache> {
    return ArchiveHashCache.fromText(await readText(join(this.dirs.hashCache, `${rootKey}.json`)));
  }

  private async saveHashCache(rootKey: string, cache: ArchiveHashCache): Promise<void> {
    await writeChunksAtomic(join(this.dirs.hashCache, `${rootKey}.json`), cache.jsonChunks());
  }

  private async saveArchiverState(): Promise<void> {
    await writeJsonAtomic(join(this.dir, "state.json"), {
      v: 1,
      disabled: this.disabled,
      key: this.key ? { kid: this.key.kid, public_key: this.key.publicKey.toString("base64"), alg: this.key.alg } : null,
    });
  }

  private async listQueue(): Promise<QueueRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dirs.queue);
    } catch {
      return [];
    }
    const records: QueueRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const parsed = queueRecordSchema.safeParse(await readJsonFile(join(this.dirs.queue, name)));
      if (parsed.success && name === `${parsed.data.archive_id}.json`) records.push(parsed.data);
    }
    return records;
  }

  private async deleteJob(record: QueueRecord): Promise<void> {
    await rm(join(this.dirs.pending, record.sealed_file), { force: true });
    await rm(join(this.dirs.queue, `${record.archive_id}.json`), { force: true });
  }

  /** Startup (section 13.4): tmp emptied, uncommitted and orphaned files removed, stale jobs dropped. */
  private async recover(): Promise<void> {
    for (const dir of Object.values(this.dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
    await rm(this.dirs.tmp, { recursive: true, force: true });
    await mkdir(this.dirs.tmp, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) {
      if (name.endsWith(".tmp")) await rm(join(this.dir, name), { force: true });
    }

    const saved = archiverStateSchema.safeParse(await readJsonFile(join(this.dir, "state.json")));
    if (saved.success) {
      this.disabled = saved.data.disabled;
      const publicKey = saved.data.key ? Buffer.from(saved.data.key.public_key, "base64") : null;
      if (saved.data.key && publicKey?.length === 32) this.key = { kid: saved.data.key.kid, publicKey, alg: saved.data.key.alg };
    }

    const sessions = new Map<string, SessionState>();
    for (const name of await readdir(this.dirs.sessions)) {
      const path = join(this.dirs.sessions, name);
      if (!name.endsWith(".json")) {
        await rm(path, { force: true });
        continue;
      }
      const parsed = sessionStateSchema.safeParse(await readJsonFile(path));
      if (parsed.success && name === `${stateKey(parsed.data.session_id)}.json`) sessions.set(stateKey(parsed.data.session_id), parsed.data);
      else await rm(path, { force: true });
    }

    const pendingFiles = new Set(await readdir(this.dirs.pending));
    const kept = new Set<string>();
    const nowMs = this.now().getTime();
    const stop = async (session: SessionState, code: string) => {
      if (session.stopped) return;
      session.stopped = code;
      session.updated_at = this.now().toISOString();
      await this.saveSession(session);
    };
    for (const name of await readdir(this.dirs.queue)) {
      const path = join(this.dirs.queue, name);
      const parsed = name.endsWith(".json") ? queueRecordSchema.safeParse(await readJsonFile(path)) : null;
      if (!parsed?.success || name !== `${parsed.data.archive_id}.json`) {
        await rm(path, { force: true });
        continue;
      }
      const record = parsed.data;
      const session = sessions.get(record.session_key);
      if (!session || session.stopped || record.request.sequence >= session.next_sequence) {
        // A crash before the session commit (step 4), or a stopped session: never uploaded.
        await this.deleteJob(record);
        continue;
      }
      if (!pendingFiles.has(record.sealed_file)) {
        await this.deleteJob(record);
        await stop(session, "archive_file_missing");
        continue;
      }
      if (nowMs - Date.parse(record.created_at) > MAX_JOB_AGE_MS) {
        await this.deleteJob(record);
        await stop(session, "archive_expired");
        continue;
      }
      kept.add(record.sealed_file);
    }
    for (const name of pendingFiles) if (!kept.has(name)) await rm(join(this.dirs.pending, name), { force: true });

    const namedBaselines = new Set([...sessions.values()].flatMap((session) => [session.baseline, session.rewind?.baseline ?? null]).filter((name) => name !== null));
    for (const name of await readdir(this.dirs.baselines)) {
      if (!namedBaselines.has(name)) await rm(join(this.dirs.baselines, name), { force: true });
    }
    for (const name of await readdir(this.dirs.hashCache)) {
      if (name.endsWith(".tmp")) await rm(join(this.dirs.hashCache, name), { force: true });
    }
  }
}
