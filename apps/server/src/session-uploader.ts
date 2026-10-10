import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, watch, type FSWatcher, type WriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { homedir, release as osRelease, tmpdir } from "node:os";
import nodePath, { basename, dirname, extname, join, relative, resolve, sep, type PlatformPath } from "node:path";
import { promisify } from "node:util";
import { createZstdCompress } from "node:zlib";
import { isUtf8 } from "node:buffer";
import { minimatch } from "minimatch";

import { SESSION_UPLOAD_BUDGET, SESSION_UPLOAD_ENDPOINT_PATH, sessionUploadTimeoutMs, type SessionUploadBudget } from "./session-upload-budget.js";
import { externalFetch } from "./server-fetch.js";
import {
  UPLOAD_BASE_DIRECTORY,
  UPLOAD_SESSION_LEDGER_FILE,
  UPLOAD_SPOOL_DIRECTORY,
  UPLOAD_TEMP_DIRECTORY,
  migrateLegacyUploadState,
  removeLegacyUploadContent,
} from "./session-upload-state.js";
import { TurnBaseStore, TurnDiffBuilder, type TurnDiffInput } from "./turn-diff.js";
import { binaryReason, isKnownBinaryPath } from "./session-archive/binary.js";
import { captureGitEnv } from "./session-archive/repos.js";
import { SUBAGENT_MODEL_FALLBACK_TRACE } from "./omnirush-swarm.js";
import { writeFileAtomic } from "./atomic-write.js";
import { XCODE_CLT_MISSING, gitSkipReason } from "./command-guard.js";
import { ExcludedFiles, listGitIgnored, type HashCache } from "./excluded-files.js";
import { ToolchainCache, type CollectOptions as ToolchainOptions, type UploadToolchain } from "./toolchain.js";
import { engine2ImportedFrom } from "./engine2/imported.js";
import { ContextCapture, captureContextEnabled, type ContextOptions } from "./context/index.js";
import bundledBestPractices from "./bundled-best-practices.json" with { type: "json" };
import serverPackage from "../package.json" with { type: "json" };
import { BUNDLED_ENGINE_VERSION, BUNDLED_HARNESS, type Harness } from "./engine-identity.js";

const execFileAsync = promisify(execFile);

export const UPLOAD_SCHEMA_VERSION = 2;
export const TRACE_SCHEMA_VERSION = 3;
// Caps shared with the omnirush.ai session upload endpoint, /omnirush/collect (contract v2); the
// backend enforces identical values, so a change here must land on both sides.
// Every cap is per file or per request: there is no per-session storage cap, so
// a session keeps uploading snapshots however much it has sent before.
export const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 50_000;
export const MAX_UPLOAD_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_TRACE_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_COMPRESSED_BYTES = 64 * 1024 * 1024;
/** Visible page text carried by one "web.visit" trace event, after redaction. */
export const MAX_UPLOAD_WEB_VISIT_TEXT_BYTES = 64 * 1024;
/** Extracted text carried by one "attachment" trace event, after redaction. */
export const MAX_UPLOAD_ATTACHMENT_TEXT_BYTES = 256 * 1024;
/** Task-tool subagent nesting captured below a root session (children, grandchildren, ...). */
export const MAX_UPLOAD_CHILD_SESSION_DEPTH = 3;
// Events kept per session between trace flushes; older events are dropped
// first. Every push site goes through appendTrace so the cap holds for the
// model, child, browser, attachment and artifact events too.
export const MAX_UPLOAD_TRACE_EVENTS = 5_000;
const MAX_FILES = MAX_UPLOAD_FILES;
const MAX_SNAPSHOT_BYTES = MAX_UPLOAD_SNAPSHOT_BYTES;
// Uncompressed room kept free inside MAX_SNAPSHOT_BYTES for what surrounds
// files[]: the session and environment blocks, touched paths, the metadata and
// change-journal files. The manifest and the git block are measured instead,
// since either can be several MiB on its own.
const SNAPSHOT_WRAPPER_MARGIN_BYTES = 2 * 1024 * 1024;
// JSON punctuation plus the sha256 field of one files[] entry, on top of its
// path and serialised content.
const SNAPSHOT_FILE_ENTRY_OVERHEAD_BYTES = 128;
const MAX_TRACE_BYTES = MAX_UPLOAD_TRACE_BYTES;
const MAX_COMPRESSED_BYTES = MAX_UPLOAD_COMPRESSED_BYTES;
const MAX_ARTIFACT_EVENTS_PER_TURN = 500;
const MAX_ARTIFACT_HASH_BYTES = 64 * 1024 * 1024;
const MAX_CHILD_SESSIONS = 200;
const MAX_WEB_VISIT_URL_CHARS = 2048;
const MAX_WEB_VISIT_TITLE_CHARS = 512;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_ATTACHMENT_MIME_CHARS = 128;
const CHANGE_DEBOUNCE_MS = 2_000;
// While a workspace is watched, a reconcile pass (listing + lstat, no reads)
// runs this often to catch events the watcher missed; a polled workspace (see
// MAX_UPLOAD_WATCHED_FILES) is rescanned on snapshots only, never on a timer.
const FALLBACK_SCAN_MS = 60_000;
/** Change snapshots are at least this far apart; triggers inside the window merge into one deferred capture. */
export const MIN_UPLOAD_CHANGE_INTERVAL_MS = 30_000;
/** A workspace with more eligible files than this is polled on snapshots instead of watched. */
export const MAX_UPLOAD_WATCHED_FILES = 20_000;
// Paths the watcher reported since the last capture. Past the cap the set is
// dropped and the next capture rescans the whole tree.
const MAX_DIRTY_PATHS = 8_192;
// Top-level directories watched recursively; a workspace with more is polled.
const MAX_WATCH_ROOTS = 64;
// Reads and stats in flight during a scan, and how long synchronous scan work
// (redaction, hashing) may run before the event loop gets a turn.
const SCAN_CONCURRENCY = 8;
const EVENT_LOOP_YIELD_MS = 12;
// A read slot holds any ordinary source file; larger ones are read whole.
const READ_SLOT_BYTES = 256 * 1024;
// Watcher-reported paths the manifest does not know are put to git's ignore
// rules in batches: one spawn per burst instead of one per event.
const IGNORE_CHECK_BATCH_MS = 50;
// A prompt or turn milestone can land milliseconds after the edit that
// matters; the watcher delivers within tens of milliseconds, so a milestone
// capture waits this long for it before consulting the dirty set.
const MILESTONE_SETTLE_MS = 100;
const IGNORE_CHECK_BATCH_MAX = 2_000;
const MAX_IGNORED_CACHE_ENTRIES = 8_192;
const ENVELOPE_WRITE_CHUNK_BYTES = 64 * 1024;
const MAX_CHANGE_JOURNAL_ENTRIES = 512;
const MAX_CHANGE_JOURNAL_BYTES = 768 * 1024;
const MAX_SESSION_LEDGER_ENTRIES = 512;
const MAX_TOUCHED_PATHS = 128;
const MAX_GIT_STATUS_ENTRIES = 500;
const MAX_GIT_RECENT_COMMITS = 50;
const MAX_GIT_REMOTES = 10;
const GIT_DIFF_READ_BYTES = 8 * 1024 * 1024;
// Field limits enforced by the omnirush.ai session upload endpoint, /omnirush/collect (counted in code
// points). A longer value is rejected with 400, which is never retried or
// spooled, so every free-text field is clamped here *after* redaction: a
// replacement marker can be longer than the text it replaces.
const MAX_GIT_SUBJECT_CHARS = 1024;
const MAX_GIT_REF_CHARS = 512;
const MAX_GIT_REMOTE_NAME_CHARS = 128;
const MAX_GIT_REMOTE_URL_CHARS = 2048;
const MAX_GIT_PATH_CHARS = 4096;
const MAX_ROOT_NAME_CHARS = 255;
const MAX_ENVIRONMENT_FIELD_CHARS = 256;
// Redacted text of files the scrubber changed, kept so a later full upload of
// the same bytes (a new chat on the same workspace) skips the regex pipeline.
const REDACTED_TEXT_CACHE_BYTES = 32 * 1024 * 1024;
/**
 * An mtime this far ahead of the clock (an unpacked archive, a share on
 * another machine) is no write of the current turn's.
 */
const TURN_CLOCK_SLACK_MS = 1_000;
const MAX_SPOOL_BYTES = 128 * 1024 * 1024;
const MAX_SPOOL_ENTRIES = 200;
const MAX_SPOOL_ATTEMPTS = 24;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 250;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const TRACE_CAPABILITY_TTL_MS = 5 * 60_000;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
// Spooled entries one drain may see fail before it leaves the rest to the
// next one: enough to get past a stuck entry, few enough not to hammer a link
// that is down for every entry in the spool.
const MAX_DRAIN_FAILURES = 3;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
/** The longest Retry-After honoured: a server asking for more is tried again after this. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** A Retry-After header (delta-seconds or an HTTP date) in ms from now, capped; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  const text = value?.trim();
  if (!text) return null;
  let ms: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    ms = at - now;
  }
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms))) : null;
}

/**
 * Whether an upload refused with `status` may go through later, so the
 * envelope is kept (spooled) rather than dropped: a timeout or rate limit
 * (408, 425, 429), any server-side failure (5xx: a 507 is the server's disk
 * filling up) except 501 and 505, which no retry changes, and a 413 that
 * says when to come back (Retry-After: the server is shedding load).
 */
export function isRetryableUploadStatus(status: number, retryAfter: number | null = null): boolean {
  if (RETRYABLE_STATUSES.has(status)) return true;
  if (status >= 500 && status <= 599) return status !== 501 && status !== 505;
  return status === 413 && retryAfter !== null;
}
// A rejected bearer. The body tells a stale device token (refreshed once and
// retried, spooled if still rejected) from the sign-in gate, which is final.
const UNAUTHORIZED_STATUSES = new Set([401, 403]);
const ACCOUNT_REQUIRED_MARKER = "omnirush_account_required";

type SnapshotType = "start" | "change" | "end" | "trace";

export type UploadTrigger =
  | "session_start"
  | "resume"
  | "prompt"
  | "turn_completed"
  | "fs_change"
  | "periodic"
  | "session_end"
  | "trace_flush";

/** How a turn ended, when not as answered: "aborted" is a turn the user stopped (Esc, Stop). */
export type TurnEndOutcome = "aborted";
type ChangeTrigger = Extract<UploadTrigger, "prompt" | "turn_completed" | "fs_change" | "periodic">;

type UploadFile = {
  path: string;
  content: string;
  sha256: string;
};

type GitRemote = { name: string; url: string };
type GitCommit = { sha: string; at: string; subject: string };
type GitStatusEntry = { code: string; path: string };

export type UploadGitBlock = {
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  remotes: GitRemote[];
  recent_commits: GitCommit[];
  status: GitStatusEntry[];
  diff: string | null;
  diff_truncated: boolean;
};

export type UploadEnvironment = {
  os: string;
  os_version: string;
  arch: string;
  /** Never null: the desktop's version, else the server package's. */
  app_version: string;
  /** Never null: "opencode/1.18.32-r2" for the bundled engine (engine-identity.ts). */
  engine_version: string;
  /** Which engine and harness produced the upload; the same shape the CLI sends. */
  harness: Harness;
  node_version: string;
  shell: string | null;
  locale: string | null;
  timezone: string | null;
  git_version: string | null;
  /** Exact toolchain versions of the session's project (toolchain.ts); absent on older clients. */
  toolchain?: UploadToolchain;
  /**
   * A session imported from the opencode 2.x engine's store and continued
   * here: its earlier turns are the 2.x engine's ("opencode 2.0.18").
   */
  imported_from?: string;
};

type TraceEvent = {
  at: string;
  type: string;
  data?: unknown;
};

type ChangeJournalEntry = {
  path: string;
  at: string;
  status: "present" | "deleted" | "skipped";
  content?: string;
  sha256?: string;
};

/** Latest model selection observed for a session (from the turn's first assistant message). */
export type UploadSessionModel = {
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
  agent: string | null;
};

/** Envelope-level "session" block: latest known values for every snapshot type. */
export type UploadSessionBlock = {
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
  child_session_ids: string[];
};

/** A "subagent.model_fallback" trace event of kind "gateway", as the session uploader keeps it. */
type SubagentModelFallback = { requested: string; used: string; effort: string | null; at: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subagentModelFallback(data: unknown): { child: string; fallback: SubagentModelFallback } | null {
  if (!isRecord(data) || data.kind !== "gateway" || data.ok === false) return null;
  const child = typeof data.child_session_id === "string" ? data.child_session_id : "";
  const requested = typeof data.requested_model === "string" ? data.requested_model : "";
  const used = typeof data.used_model === "string" ? data.used_model : "";
  const at = typeof data.at === "number" && Number.isFinite(data.at) ? data.at : Date.now();
  if (!child || !requested || !used || requested === used) return null;
  return { child, fallback: { requested, used, effort: typeof data.used_effort === "string" ? data.used_effort : null, at } };
}

/**
 * The child's engine messages with the model that really answered: an
 * omnirush.ai assistant message on the picked model that was still running
 * when the broker moved its session to the main model (or started after)
 * names the main model and effort, and keeps the picked one under
 * `omnirushModelFallback`. Other messages pass unchanged (same objects).
 */
function withSubagentFallbacks(messages: unknown[], fallbacks: readonly SubagentModelFallback[] | undefined): unknown[] {
  if (!fallbacks?.length) return messages;
  return messages.map((message) => {
    if (!isRecord(message) || !isRecord(message.info)) return message;
    const info = message.info;
    if (info.role !== "assistant" || info.providerID !== "omnirush" || typeof info.modelID !== "string") return message;
    const time = isRecord(info.time) ? info.time : {};
    const completed = typeof time.completed === "number" ? time.completed : Number.POSITIVE_INFINITY;
    const fallback = fallbacks.find((entry) => entry.requested === info.modelID && completed >= entry.at);
    if (!fallback) return message;
    return {
      ...message,
      info: {
        ...info,
        modelID: fallback.used,
        ...(fallback.effort ? { variant: fallback.effort } : {}),
        omnirushModelFallback: { requested: fallback.requested, ...(typeof info.variant === "string" ? { requestedVariant: info.variant } : {}), reason: "gateway_refused" },
      },
    };
  });
}

export type UploadChildSession = {
  childSessionId: string;
  parentSessionId: string;
  /** Sub-agent layer below the root session: 1 for a child, 2 for a grandchild, ... */
  depth?: number;
  title: string | null;
  agent: string | null;
  /** Engine messages of the child that are new since the last checkpoint. */
  messages: unknown[];
  /** Id of the child's last message, persisted as the child's checkpoint. */
  lastMessageId: string | null;
};

export type UploadWebVisit = {
  url: string;
  title?: string | null;
  text?: string | null;
};

export type UploadAttachment = {
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  text: string | null;
  /** Whether the extractor already cut the text short of the whole document. */
  textTruncated?: boolean;
};

type FileSignature = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
};

type ArtifactStat = FileSignature;

function fileSignature(file: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }): FileSignature {
  return {
    size: file.size,
    mtimeMs: file.mtimeMs,
    ctimeMs: file.ctimeMs,
    ino: file.ino,
    dev: file.dev,
  };
}

function sameFileSignature(left: FileSignature | undefined, right: FileSignature): boolean {
  return Boolean(left
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino
    && left.dev === right.dev);
}

type SessionLedgerRecord = {
  segment: number;
  nextSequence: number;
  sentBytes?: number;
  lastMessageId?: string;
  lastSeenAt: string;
  failureCount?: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  model?: UploadSessionModel;
  childSessionIds?: string[];
  /** child session id -> id of its last captured message */
  childCheckpoints?: Record<string, string>;
};

type SessionLedger = {
  version: 1;
  sessions: Record<string, SessionLedgerRecord>;
};

type HashCacheEntry = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  binary: boolean;
  sha256: string;
  /** UTF-8 bytes of the redacted content: the manifest size. */
  bytes: number;
  /** Bytes of that content once JSON-encoded: what a files[] entry costs. */
  json: number;
  /** Redaction changed nothing, so the raw bytes are the upload form (verified by digest on upload). */
  clean: boolean;
  uploadPath: string;
  /** Capture v2: the file's permission bits (the executable bit included). */
  mode?: number;
};

/**
 * Capture v2: a manifest entry that carries no text: a binary file (its raw
 * size and SHA-256; its bytes go to the byte-exact project archive) or a
 * symlink (its target, also when broken; sha256 and size are those of the
 * target string).
 */
type ExtraManifestEntry = {
  uploadPath: string;
  kind: "binary" | "symlink";
  sha256: string;
  size: number;
  mode: number;
  target?: string;
  broken?: boolean;
};


type SpoolMeta = {
  id: string;
  session_id: string;
  snapshot_type: SnapshotType;
  trigger: UploadTrigger;
  sequence: number;
  bytes: number;
  created_at: string;
  attempts: number;
  last_attempt_at?: string;
  /** Not sent again before this (a Retry-After the server gave). */
  not_before?: string;
};

type SessionState = {
  id: string;
  root: string;
  workspaceId: string;
  /** Uncompressed bytes accepted for this session so far (diagnostics only; never gates an upload). */
  sentBytes: number;
  segment: number;
  sequence: number;
  resumed: boolean;
  lastMessageId?: string;
  started: boolean;
  finished: boolean;
  changeTimer: ReturnType<typeof setTimeout> | null;
  changeTrigger: ChangeTrigger | null;
  /** A capture held back by the minimum change interval, and the reason it will run for. */
  deferTimer: ReturnType<typeof setTimeout> | null;
  deferTrigger: ChangeTrigger | null;
  /** The reconcile pass, while watching. */
  scanTimer: ReturnType<typeof setInterval> | null;
  watchers: FSWatcher[];
  watchMode: "starting" | "watching" | "polling";
  /** Workspace-relative directories under a watcher ("." for the root). */
  watchedPaths: string[];
  /** Watchers still being added for top-level directories the listing did not name. */
  watchSetup: Promise<void>;
  trace: TraceEvent[];
  /** The session's trace has this process's `client.launch` event (which engine and harness ran it). */
  launchRecorded?: boolean;
  changeJournal: Map<string, ChangeJournalEntry>;
  touchedPaths: Set<string>;
  changeJournalBytes: number;
  changeCaptureTail: Promise<void>;
  /** Paths whose journal capture is queued but not started. */
  pendingJournal: Set<string>;
  ignoreBatch: Map<string, Array<(ignored: boolean) => void>>;
  ignoreTimer: ReturnType<typeof setTimeout> | null;
  ignoredCache: Map<string, boolean>;
  /** The last accepted manifest: what the next change snapshot is measured against. */
  manifest: Manifest | null;
  /** The workspace as the current turn began: what its "turn.diff" is measured against. */
  turnManifest: TurnBaseline | null;
  /** When the current turn's prompt was sent (null before the first). */
  turnStartedAt: number | null;
  /** A prompt was dispatched and its turn has not completed (its turn_completed milestone ends it). */
  turnInProgress: boolean;
  /**
   * Edits were made on this session's root while it had no turn in progress
   * and another session on the root had one: they are that turn's, and this
   * session's own filesystem and periodic captures wait for its next milestone.
   */
  changesHeld: boolean;
  /**
   * Files the journal saw the turn write that may be binary or over the size
   * cap, with their mtime: "skipped" in its "turn.diff".
   */
  turnSkipped: Map<string, number>;
  /** Paths observed as changed during the current turn, even if their mtime was restored. */
  turnWrittenPaths: Map<string, number>;
  /** Lowest relevance rank observed from known tool trace events for a path. */
  relevance: Map<string, number>;
  /** The per-root hash cache, shared with every other session open on the same root. */
  cache: Map<string, HashCacheEntry>;
  listing: { denied: number; truncated: boolean };
  /** Paths the watcher (or a trace) reported since the last capture. */
  dirty: Set<string>;
  /** The dirty set cannot be trusted; the next capture scans the whole tree. */
  dirtyOverflow: boolean;
  lastHead: string | null;
  lastChangeAt: number;
  /** Untracked-but-not-ignored files as they stood when the current turn began. */
  artifactBaseline: Promise<Map<string, ArtifactStat>> | null;
  model: UploadSessionModel | null;
  childSessionIds: string[];
  childCheckpoints: Map<string, string>;
  /**
   * Sub-agent requests the gateway broker moved from the picked sub-agent
   * model to the main model, per sub-agent session (in memory only): the
   * engine still names the picked model on those messages, so the recorded
   * child messages are corrected to the model that answered.
   */
  subagentFallbacks: Map<string, SubagentModelFallback[]>;
  failureCount: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  ready: Promise<void>;
  tail: Promise<void>;
  /** Capture v2: the binary files and symlinks of the workspace as last scanned (manifest entries without text). */
  extras: Map<string, ExtraManifestEntry>;
};

type SessionUploaderOptions = {
  gatewayUrl?: string;
  accessToken?: string;
  fetch?: typeof externalFetch;
  /** Sends one envelope; `signal` aborts at the upload deadline (session-upload-budget.ts) or when the spool is cleared. */
  upload?: (sessionId: string, compressed: Uint8Array, signal?: AbortSignal) => Promise<Response>;
  /** Sends an immutable compressed envelope directly from its spool/temp path. */
  uploadFile?: (sessionId: string, path: string, size: number, signal?: AbortSignal) => Promise<Response>;
  /** Negotiates the canonical structured trace envelope. Failures fall back to schema v2. */
  capabilities?: () => Promise<TraceCapabilities>;
  /**
   * Asks the account layer for a fresh access token once the gateway rejects
   * an upload as unauthorized. Resolves with the bearer to send next, or null
   * when none can be issued; the upload is retried once when a token arrives
   * and spooled when it does not.
   */
  refreshAccessToken?: () => Promise<string | null>;
  stateDir?: string;
  log?: (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;
  changeDebounceMs?: number;
  fallbackScanMs?: number;
  appVersion?: string;
  engineVersion?: string;
  uploadRetryDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** The upload deadline's parameters; SESSION_UPLOAD_BUDGET unless a test shrinks it. */
  uploadBudget?: SessionUploadBudget;
  spoolMaxEntries?: number;
  spoolMaxBytes?: number;
  /** Uncompressed envelope cap; the backend's MAX_SNAPSHOT_BYTES unless a test lowers it. */
  snapshotMaxBytes?: number;
  /** Minimum spacing between change snapshots; MIN_UPLOAD_CHANGE_INTERVAL_MS unless a test lowers it. */
  minChangeIntervalMs?: number;
  /** Watcher cap; MAX_UPLOAD_WATCHED_FILES unless a test lowers it. */
  maxWatchedFiles?: number;
  /** Budget of the redacted-text cache; REDACTED_TEXT_CACHE_BYTES unless a test changes it. */
  redactedTextCacheBytes?: number;
  /** Toolchain capture (toolchain.ts); false turns it off, an object overrides its probes. */
  toolchain?: false | (ToolchainOptions & { waitMs?: number });
  /** Called once a finished session's last upload settled and its state is gone. */
  onSessionClosed?: (sessionId: string) => void;
  /**
   * Every workspace-relative path (portable `/`) a session touched, before
   * any denylist: a tool's path in the trace, a change the watcher saw, a
   * file a capture or the reconcile pass found changed. The project archive's
   * touched-files mode keeps them; it applies its own exclusions.
   */
  onPathTouched?: (sessionId: string, path: string) => void;
  /**
   * Capture v2: a binary file of the workspace within the per-file cap
   * (workspace-relative). It is never sent as text: the host hands it to the
   * byte-exact project archive.
   */
  onBinaryFile?: (sessionId: string, path: string) => void;
  /**
   * Capture context (context/): an object turns it on (the capture host
   * always passes one) and overrides its options; absent or false: off.
   */
  context?: false | Partial<ContextOptions>;
};

export type TraceCapabilities = {
  schema_versions: number[];
  canonical_trace: boolean;
};

type TransmitOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string; unsupportedSchema?: boolean; retryAfterMs?: number };

type CompressedArtifact = { path: string; size: number };

// --- privacy rails -----------------------------------------------------------
// The omnirush.ai backend applies the same denylist and scrubber server-side;
// a rule changed here must land there too, and the desktop side may only ever
// be the stricter of the two.

// Unconditional denials, applied to every path component (directories too).
const DENIED_EXACT_NAMES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  "node_modules",
  "keys",
  "secrets",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

const DENIED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const DENIED_CREDENTIAL_NAME = /(^|[._-])(?:credentials?|secrets?|private[_-]?keys?)([._-]|$)/i;
// Words (a component split on space, "_", "-" and ".") that mark a file as a
// credential store: "AWS master key", "prod tokens.csv", "wallet.dat". A file
// with a source-code or docs extension is kept and scrubbed instead.
const DENIED_WORDS = new Set([
  "key", "keys", "secret", "secrets", "token", "tokens", "password", "passwords", "passwd", "credential", "credentials",
  "id_rsa", "id_ed25519", "netrc", "npmrc", "pypirc", "kubeconfig", "wallet", "seed", "mnemonic",
]);
const SCRUBBED_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".md", ".adoc", ".txt", ".json", ".yml", ".yaml", ".toml", ".cmake", ".sh", ".sql", ".css", ".html",
]);

const REDACTED = "[REDACTED]";
const REDACTED_PII = "[REDACTED_PII]";

/**
 * Start-of-token guard shared by the text patterns: a match may not begin
 * inside a word and never on the letter of a backslash escape, so a redaction
 * can never eat that letter and leave a dangling `\` behind (which once turned
 * the JSON-escaped `\n@app.function` into the invalid escape `\[REDACTED_PII]`).
 * A token that directly follows an escape (`\njane@example.com`) still matches.
 */
function tokenPattern(source: string, flags = "g", notAfter = String.raw`[\w\\]`): RegExp {
  return new RegExp(String.raw`(?:(?<!${notAfter})|(?<=\\[nrt]))${source}`, flags);
}

type Redaction = [RegExp, string | ((match: string, group: string) => string)];

const PRIVATE_KEY_BLOCK: Redaction = [
  /(?<!\\)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  REDACTED,
];

/**
 * One `key = value` assignment in INI, YAML, JSON, dotenv, shell (`export
 * KEY=`) or source spelling: an optionally quoted key, `=` or `:` with
 * optional blanks, then one run of 8+ non-space characters, optionally quoted
 * (a JSON-escaped `\"` counts as a quote, for JSON carried inside a string).
 * A backslash escape counts as one unit so the match never splits it. Whether
 * the key names a secret is decided by isSecretAssignmentKey; the value by
 * isSecretAssignmentValue. Every quantifier is bounded or anchored so a 1 MiB
 * line costs linear time. Where the key may start depends on the mode: see
 * ASSIGNMENT_PATTERN (CONFIG) and SOURCE_ASSIGNMENT_PATTERN (SOURCE).
 */
// Pre-filter for the assignment regex: the key must at least contain a keyword
// substring, so an ordinary assignment never consumes a value that holds a
// secret one (`"text": "{\"password\":...}"`). The exact, segment-bounded
// decision is isSecretAssignmentKey.
const ASSIGNMENT_KEYWORD_SOURCE = String.raw`secret|passw(?:or)?d|pwd|token|credential|auth|(?:api|access|private|client|session|signing|master|encryption)[_.:-]?key`;
// Python's `\s` (the backend's regexes run on str): JS `\s` minus U+FEFF, plus
// U+001C-U+001F and U+0085. The assignment rule spells whitespace this way so a
// value ends, and is rejected for holding whitespace, exactly where the
// backend's does.
const PYTHON_WHITESPACE = String.raw`\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const PYTHON_WHITESPACE_CHAR = new RegExp(String.raw`[${PYTHON_WHITESPACE}]`);
const ASSIGNMENT_BODY_SOURCE = String.raw`(\\?["']?)((?=[\w.-]{0,63}?(?:${ASSIGNMENT_KEYWORD_SOURCE}))[A-Za-z_-][\w.-]{0,63})\1[ \t]*[=:][ \t]*`
  + String.raw`(?:"((?:[^"${PYTHON_WHITESPACE}\\]|\\[^${PYTHON_WHITESPACE}]){8,})"`
  + String.raw`|'((?:[^'${PYTHON_WHITESPACE}\\]|\\[^${PYTHON_WHITESPACE}]){8,})'`
  + String.raw`|\\"((?:[^"${PYTHON_WHITESPACE}\\]|\\[^"${PYTHON_WHITESPACE}]){8,})\\"`
  + String.raw`|((?:[^${PYTHON_WHITESPACE}"',;&\\]|\\[^${PYTHON_WHITESPACE}]){8,}))`;
// CONFIG mode: the key starts a word (not after a word character, `.`, `-` or
// a backslash), so `#TOKEN=` on a commented-out line and `?token=` or
// `&token=` in a query string still count.
const ASSIGNMENT_PATTERN = new RegExp(String.raw`(?:(?<![\w.\\-])|(?<=\\[nrt]))` + ASSIGNMENT_BODY_SOURCE, "gi");
// SOURCE mode: the key starts the text or follows whitespace, `{`, `,`, `(`, a
// quote (`"`, `'`, backtick), a `+` diff marker (a .patch file is source) or
// `#`; never `-`, `.`, a word character or any other punctuation, so `token:`
// after a `/`, `:` or `[` inside a string literal and `?token=` in a URL
// literal are not read as assignments. Both modes accept a key right after a
// `\n`, `\r` or `\t` escape. The backend's _SOURCE_ASSIGNMENT_PATTERN, except
// that any non-ASCII character also counts as a delimiter: the backend's `\w`
// is Unicode, so its key runs through `café_token` from the `c`, while a JS key
// (ASCII `\w`) can only start after the `é`. This keeps every value the
// backend redacts redacted here too (and a key right after a byte order mark,
// the first line of a BOM-prefixed file, still counts on the desktop).
const SOURCE_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:(?<![^${PYTHON_WHITESPACE}\x80-\uffff{,("'\x60+#])|(?<=\\[nrt]))` + ASSIGNMENT_BODY_SOURCE,
  "gi",
);
/**
 * Keyword families, matched against whole key segments (see keySegments): a
 * key names a secret when one segment is listed here, or two adjacent
 * segments (or one segment spelling both) form a listed pair, and its last
 * segment is not an excluded word. So `auth_token`, `basic-auth`, `AUTH`,
 * `authorization`, `oauth_client_secret`, `APIKey`, `accessKey` qualify;
 * `author`, `authored`, `oauth_client_id`, `tokenizer_class`, `keyboard`,
 * `keywords`, `pwdir`, `accessKeyId`, `token_url` do not.
 */
const SECRET_KEY_SEGMENTS = new Set([
  "secret", "secrets", "password", "passwords", "passwd", "pwd", "token", "credential", "credentials",
  "auth", "authorization", "authtoken", "authkey", "apikey",
]);
const SECRET_KEY_PAIRS: Array<[string, string]> = [
  ["api", "key"], ["access", "key"], ["secret", "key"], ["private", "key"], ["client", "key"], ["client", "secret"],
  ["session", "key"], ["signing", "key"], ["master", "key"], ["encryption", "key"],
];
const EXCLUDED_LAST_SEGMENTS = new Set([
  "length", "ttl", "seconds", "count", "size", "url", "path", "name", "id", "header",
  "file", "filename", "dir", "mode", "method", "role", "owner", "type", "kind", "enabled", "estimate", "hash", "digest", "at",
  "config", "client", "prefix", "suffix", "format", "scheme", "provider", "status", "state", "label", "description", "title",
  "class", "field", "fields", "list", "names", "version", "timeout", "limit", "max", "min", "interval", "retries", "port",
  // Added after the second production sample (`refresh_token_expires_in`,
  // `password_encryption`, `provider_credential_ref`, `secret_envelope`).
  // `code` and `plaintext` are deliberately absent: `auth_code` and
  // `password_plaintext` name secrets.
  "in", "out", "percent", "pct", "ms", "secs", "minutes", "hours", "days", "expires", "expiry", "expiration", "bytes", "len",
  "width", "height", "offset", "index", "idx", "pos", "total", "sum", "avg", "ratio", "rate", "threshold", "weight", "score",
  "encryption", "algorithm", "algo", "cipher", "strategy", "policy", "source", "target", "origin", "backend", "engine", "driver",
  "handler", "callback", "event", "action", "reason", "message", "error", "envelope", "ref", "reference", "link", "pointer", "alias",
]);

/**
 * Value rule v2 (the backend applies the identical rule). A file whose
 * extension names a programming language is scrubbed in SOURCE mode, where an
 * assignment's value must look like a generated literal; everything else
 * (.env*, ini, cfg, conf, yml, yaml, toml, json, properties, txt, md, no or
 * unknown extension), plus the trace, is scrubbed in CONFIG mode with the
 * permissive rule. A `.patch` or `.diff` workspace file carries code and is
 * SOURCE. The file text the trace and the envelope's git diff carry (file
 * tool content, diffs, read output: see fileAwareRecord and filterUploadDiff)
 * gets the mode of the file it belongs to.
 */
export type RedactMode = "source" | "config";
const SOURCE_EXTENSIONS = new Set([
  "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt", "c", "cc", "cpp", "h", "hpp", "rb", "php", "swift",
  "cs", "scala", "sh", "bash", "zsh", "ps1", "lua", "dart", "vue", "svelte", "map", "patch", "diff",
]);

/** SOURCE for a programming-language extension (case-insensitive), CONFIG otherwise. */
export function redactModeForPath(path: string): RedactMode {
  return SOURCE_EXTENSIONS.has(extname(path).slice(1).toLowerCase()) ? "source" : "config";
}

// The value side of the assignment rule (see isSecretAssignmentValue).
const CODE_EXPRESSION_VALUE = /^(?:process\.|os\.|env\.)/;
const IDENTIFIER_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const PATH_VALUE = /^(?:\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])/;
// The shape of an unquoted SOURCE value that can be a literal token: letters,
// digits and `_ . / + = ~ -` only (`abc-123-def`, base64 with `+/=`). A `?`,
// `:`, `[`, `]`, `!`, `|`, `&`, `,`, `;`, `)`, quote, backtick, `*`, `<` or
// `>` makes it code (`stagedClient?.plaintext`, `params[8]`, `[0-9a-f]{16}`,
// `session:trial-123`).
const TOKEN_SHAPE_VALUE = /^[A-Za-z0-9_./+=~-]+$/;
// A JSON key that looks like a file path or filename: holds a `/` or `\`, or
// ends in a dot extension of one to five letters or digits. `\n?` mirrors
// Python's `$`, which also matches before one trailing newline.
const PATH_LIKE_KEY = /[/\\]|\.[A-Za-z0-9]{1,5}\n?$/;
const MAX_ASSIGNMENT_DEPTH = 4;

// An AWS secret access key is 40 base64 characters with no shape of its own,
// so a candidate only counts near an access key id or an aws/secret key name.
// The quick check only tries a position that starts a run of those characters,
// so it costs one pass over the text instead of one per character of every run.
const AWS_SECRET_QUICK = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}/;
const AWS_SECRET_CANDIDATE = tokenPattern(String.raw`[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`, "g", String.raw`[A-Za-z0-9/+\\]`);
const AWS_SECRET_CONTEXT = /(?:AKIA|ASIA)[0-9A-Z]{16}|aws|secret/i;
const AWS_SECRET_CONTEXT_LINES = 3;
// The proximity pass needs neighbouring lines to mean anything: a single-line
// document (compact JSON, the trace) relies on its JSON key instead.
const AWS_SECRET_MIN_LINES = 3;

// `scheme://user:pass@host`: the userinfo is redacted only when it holds a
// password (a `:` after the user), replaced whole by `[REDACTED]`; a bare
// `postgres://live@host/db` in a fixture stays. The user may be empty:
// `redis://:<password>@host` is Redis's own AUTH form. Runs before the
// assignment rule so `https://oauth2:<token>@host/...` keeps its host instead
// of being read as an `oauth2:` assignment. Whitespace is Python's, as in the
// backend's _URL_USERINFO_TEXT; unlike it (at 46ee95e), the user part may be
// empty, so the desktop is the stricter side there.
const URL_USERINFO: Redaction = [
  tokenPattern(
    String.raw`([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^${PYTHON_WHITESPACE}/@:\\]|\\[^${PYTHON_WHITESPACE}])*:(?:[^${PYTHON_WHITESPACE}/@\\]|\\[^${PYTHON_WHITESPACE}])+@`,
    "gi",
  ),
  (_match, scheme) => `${scheme}${REDACTED}@`,
];

const SECRET_PATTERNS: Redaction[] = [
  [tokenPattern(String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}\b`), REDACTED],
  [tokenPattern(String.raw`gh[pousr]_[A-Za-z0-9]{16,}\b`), REDACTED],
  [tokenPattern(String.raw`github_pat_[A-Za-z0-9_]{16,}\b`), REDACTED],
  [tokenPattern(String.raw`xox[abpr]-[A-Za-z0-9-]{10,}`), REDACTED],
  [tokenPattern(String.raw`AIza[0-9A-Za-z_-]{30,}`), REDACTED],
  [tokenPattern(String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b`), REDACTED],
  [tokenPattern(String.raw`sk-ant-[A-Za-z0-9_-]{16,}`), REDACTED],
  [tokenPattern(String.raw`(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b`), REDACTED],
  [tokenPattern(String.raw`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), REDACTED],
  [tokenPattern(String.raw`[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`), REDACTED],
];
// `Bearer <token>`: the token part is decided by isBearerSecret. The character
// class already excludes `${...}` and `<...>` placeholders.
const BEARER_TOKEN = tokenPattern(String.raw`(Bearer[ \t]+)([A-Za-z0-9_.~+/=-]{16,})`, "gi");
/**
 * Personal-data matches kept as written: code and docs are full of addresses
 * and e-mails that identify nobody. IPv4: unspecified and "this network"
 * (0.0.0.0/8), loopback (127/8), private (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16), the documentation ranges (192.0.2/24,
 * 198.51.100/24, 203.0.113/24) and netmask-shaped values (ones, then zeros:
 * 255.255.255.0, 255.255.255.255). Every other (public) address is redacted.
 * The backend's is_kept_ipv4.
 */
const IPV4_KEPT_PREFIXES: number[][] = [[0], [10], [127], [169, 254], [192, 168], [192, 0, 2], [198, 51, 100], [203, 0, 113]];
export function isKeptIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return false;
  if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) return true;
  if (IPV4_KEPT_PREFIXES.some((prefix) => prefix.every((octet, index) => octets[index] === octet))) return true;
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const inverted = ~value >>> 0;
  // A netmask: ones, then zeros (255.255.255.255 included).
  return ((inverted & (inverted + 1)) >>> 0) === 0;
}

/**
 * E-mails kept as written: the reserved example and test domains (RFC 2606,
 * RFC 6761), placeholder domains (`user@domain.com`, `you@yourdomain.com`)
 * and no-reply senders. Every other address is redacted. The backend's
 * is_kept_email.
 */
const EMAIL_KEPT_DOMAINS = new Set(["example.com", "example.org", "example.net", "test", "localhost"]);
const EMAIL_KEPT_SUFFIXES = [".example.com", ".example.org", ".example.net", ".invalid", ".test", ".example", ".localhost"];
const EMAIL_PLACEHOLDER_LABELS = new Set([
  "domain", "yourdomain", "your-domain", "mydomain", "my-domain", "yourcompany", "your-company", "yoursite", "your-site",
  "yourapp", "your-app", "yourorg", "your-org", "yourname",
]);
const EMAIL_KEPT_LOCALS = new Set(["noreply", "no-reply", "no_reply", "donotreply", "do-not-reply"]);
export function isKeptEmail(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  if (EMAIL_KEPT_LOCALS.has(local)) return true;
  if (EMAIL_KEPT_DOMAINS.has(domain) || EMAIL_KEPT_SUFFIXES.some((suffix) => domain.endsWith(suffix))) return true;
  const labels = domain.split(".");
  return labels.length >= 2 && EMAIL_PLACEHOLDER_LABELS.has(labels[labels.length - 2]!);
}

const PII_PATTERNS: Redaction[] = [
  [tokenPattern(String.raw`[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,}\b`, "gi"), (match) => (isKeptEmail(match) ? match : REDACTED_PII)],
  [tokenPattern(String.raw`(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)`), REDACTED_PII],
  [tokenPattern(String.raw`\d{3}-\d{2}-\d{4}(?!\w)`), REDACTED_PII],
  // IPv4. Not inside a longer version token: never right after a letter
  // (`ubuntu1.22.04.1`, `v1.2.3.4`), after an alphanumeric and `.~+-`
  // (`16.15-0ubuntu0.24.04.1`), after a dpkg epoch (`1:2.3.4.5`), nor
  // followed by another `.digit` group (`1.2.3.4.5`) or a package release
  // (`1.2.15.3-1`). The backend's `ipv4`. Kept as written: see isKeptIpv4.
  [tokenPattern(String.raw`(?<![A-Za-z0-9][.~+-])(?<!\d:)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\.?\d)(?!-\d+(?![\d.]))`, "g", String.raw`[\dA-Za-z.\\]`), (match) => (isKeptIpv4(match) ? match : REDACTED_PII)],
];

const PRIVACY_POLICY = {
  capture_policy: "consented_workspace_session",
  gitignored_paths_excluded: true,
  git_internals_excluded: true,
  environment_variables_excluded: true,
  denied_path_classes: [".env*", "credentials", "keys", "secrets", "tokens", "passwords", ".aws", ".ssh", ".gnupg", ".git", "node_modules", "binaries_over_4MiB"],
  redaction: ["provider_secrets", "secret_assignments", "private_keys", "pii"],
  manifest_hash_basis: "sha256_of_redacted_utf8",
  max_file_bytes: MAX_UPLOAD_FILE_BYTES,
  max_files: MAX_FILES,
  max_diff_bytes: MAX_UPLOAD_DIFF_BYTES,
} as const;

/**
 * SessionUploader's `enabled` for these options, without building one: an
 * upload hook, or an upload URL and a bearer (from the options or the
 * environment, as the constructor reads them).
 */
export function sessionUploaderEnabled(input: { upload: boolean; gatewayUrl?: string; accessToken?: string }): boolean {
  if (input.upload) return true;
  const token = (input.accessToken ?? process.env.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
  return Boolean(resolveUploadUrl(input.gatewayUrl ?? process.env.OMNIRUSH_GATEWAY_URL) && token);
}

function resolveUploadUrl(rawGatewayUrl: string | undefined): string | null {
  const value = rawGatewayUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + `/${SESSION_UPLOAD_ENDPOINT_PATH}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * `candidate` (absolute, or relative to the root) as a portable path strictly
 * inside the workspace root, or null for the root itself, a parent, another
 * drive or a UNC share. path.relative returns a path on another Windows drive
 * as it is (`D:\data\x.csv`, portable `D:/data/x.csv`), which a `../` check
 * lets through; here any absolute result is refused, and the path it
 * resolves to must start with the root and a separator, as inspectFile
 * requires of every file it reads. `paths` is the platform's path module
 * (path.win32 in tests).
 */
export function workspaceRelativePath(root: string, candidate: string, paths: PlatformPath = nodePath): string | null {
  const base = paths.resolve(root);
  const path = paths.relative(base, paths.resolve(base, candidate));
  if (!path || paths.isAbsolute(path) || path === ".." || path.startsWith(`..${paths.sep}`)) return null;
  if (!paths.resolve(base, path).startsWith(base.endsWith(paths.sep) ? base : `${base}${paths.sep}`)) return null;
  return path.split(paths.sep).join("/");
}

export function portablePathForUpload(path: string): string {
  return redactUploadText(path).text;
}

/**
 * Truncates text to `limit` code points without splitting a surrogate pair.
 * The backend counts code points, so this never exceeds its limit.
 */
export function clampUploadText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** The upload-safe workspace name: basename only, redacted, then clamped. */
/**
 * Clamps text to a UTF-8 byte budget without splitting a code point. Used for
 * the free-text fields of trace events whose caps are expressed in bytes.
 */
export function clampUploadBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let cut = text.slice(0, low);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/** Redacts then clamps free text destined for a trace event. */
function uploadTextForTrace(text: string | null | undefined, maxBytes: number): { text: string | null; truncated: boolean } {
  if (typeof text !== "string") return { text: null, truncated: false };
  return clampUploadBytes(redactUploadText(text).text, maxBytes);
}

/**
 * Whether a browser visit may be traced. Local pages, inline documents and
 * browser-internal URLs never leave the machine.
 */
export function isUploadableWebUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || host === "::") return false;
  if (/^127\./.test(host)) return false;
  return true;
}

function workspaceRootName(root: string): string {
  return clampUploadText(portablePathForUpload(root.split(sep).filter(Boolean).at(-1) ?? "workspace"), MAX_ROOT_NAME_CHARS);
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function fileReadableBody(path: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const source = createReadStream(path, { highWaterMark: 64 * 1024 });
  const abort = () => source.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
  const cleanup = () => signal?.removeEventListener("abort", abort);
  return new globalThis.ReadableStream<Uint8Array>({
    start(controller) {
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      source.on("data", (chunk: string | Buffer) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      source.on("end", () => {
        cleanup();
        controller.close();
      });
      source.on("error", (error: Error) => {
        cleanup();
        controller.error(error);
      });
    },
    cancel(reason) {
      cleanup();
      source.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}

function pathComponents(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

/** The unconditional denials that apply to any component, directories included. */
function hasDeniedComponent(parts: string[]): boolean {
  return parts.some((part, index) => {
    const lower = part.toLowerCase();
    return lower.startsWith(".env")
      || DENIED_EXACT_NAMES.has(lower)
      || DENIED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
      || DENIED_CREDENTIAL_NAME.test(lower)
      || (lower === "config.json" && parts[index - 1]?.toLowerCase() === ".docker");
  });
}

function hasDeniedWords(lower: string): boolean {
  const words = lower.split(/[\s._-]+/).filter(Boolean);
  return words.some((word, index) => DENIED_WORDS.has(word) || (index > 0 && DENIED_WORDS.has(`${words[index - 1]}_${word}`)));
}

function hasScrubbedExtension(lower: string): boolean {
  const dot = lower.lastIndexOf(".");
  return dot > 0 && SCRUBBED_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Whether the session uploader denies every file under this directory path, whatever
 * the file is called: one of its components meets the unconditional rules
 * (`.ssh`, `.aws`, `.gnupg`, `keys`, `secrets`, `credentials*`, `.env*`,
 * `node_modules`, `.git`, a key-store suffix, ...). The project archive
 * refuses such a folder as the root of an all-folders archive.
 */
export function isUploadDirectoryDenied(path: string): boolean {
  return hasDeniedComponent(pathComponents(path));
}

/**
 * Whether a workspace-relative path may never leave the machine. Repository
 * internals, dependency trees and the classic credential files are denied by
 * name; beyond those, any component carrying a credential word ("AWS master
 * key", "tokens/prod.csv") denies the file unless it has a source-code or docs
 * extension, in which case it is kept and scrubbed like any other source file.
 */
export function isUploadPathDenied(path: string): boolean {
  const parts = pathComponents(path);
  if (hasDeniedComponent(parts)) return true;
  const name = parts.at(-1)?.toLowerCase();
  if (!name || hasScrubbedExtension(name)) return false;
  return parts.some((part) => hasDeniedWords(part.toLowerCase()));
}

/**
 * Splits a key on `_`, `-`, `.`, `:`, whitespace, camelCase and letter/digit
 * boundaries, lower-cased: `oauth_client_id` -> oauth, client, id;
 * `accessKeyId` -> access, key, id; `HTTPSecret2` -> http, secret, 2.
 */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.:-]+/)
    .filter(Boolean);
}

/** Whether an assignment key (or JSON object key) names a secret; the backend's is_secret_assignment_key. */
export function isSecretAssignmentKey(key: string): boolean {
  const segments = keySegments(key);
  const last = segments.at(-1);
  if (last === undefined || EXCLUDED_LAST_SEGMENTS.has(last)) return false;
  return segments.some((segment, index) => SECRET_KEY_SEGMENTS.has(segment)
    || SECRET_KEY_PAIRS.some(([first, second]) => segment === `${first}${second}` || (segment === first && segments[index + 1] === second)));
}

/**
 * Whether a JSON object key looks like a file path or filename: it holds a `/`
 * or `\`, or ends in `.` plus one to five letters or digits
 * (`src/admin_auth.py`, `admin_auth.py`, `C:\x`). Such a key never names a
 * secret (a source-hashes document maps paths to digests), so the JSON rail
 * skips the key rule for it; its value still gets the text scrub, so a
 * provider shape under it is caught. The text rule is unaffected:
 * `admin_auth.py: abcdefgh1234` in YAML is still an assignment. The backend's
 * is_path_like_key.
 */
export function isPathLikeKey(key: string): boolean {
  return PATH_LIKE_KEY.test(key);
}

/**
 * A filesystem path: an absolute, relative, home or drive-letter prefix, or a
 * `/` anywhere with no digit anywhere (`/run/secrets/x`, `C:/Users/me`).
 */
function isFilesystemPathValue(value: string): boolean {
  return PATH_VALUE.test(value) || (value.includes("/") && !/\d/.test(value));
}

/**
 * Whether the value of a secret-named assignment is redacted (value rule v2).
 * In both modes it must be 8+ characters with no whitespace, not a code
 * expression (a `(`, `${` or `$(` anywhere, or a `process.` / `os.` / `env.`
 * prefix), not an angle-bracket placeholder (`<your-token>`, a tokenizer's
 * `<|endoftext|>`), not an earlier redaction and not a filesystem path.
 * SOURCE mode then wants a literal that looks generated: an unquoted value
 * with identifier or member-expression syntax is a reference (`config.token`,
 * `tokenFile`, `req.headers.authorization`), never a literal; an unquoted value
 * must also be a token shape (TOKEN_SHAPE_VALUE: `stagedClient?.plaintext`,
 * `params[8]`, `[0-9a-f]{16}` and `session:trial-123` are code); and the value
 * must carry a digit or be 20+ characters of mixed case, so `'synthetic'`
 * and `'github-app'` stay. CONFIG mode keeps the permissive rule (a letter
 * anywhere), skipping only an unquoted dotted identifier such as YAML's
 * `token: config.token`. The backend's is_secret_assignment_value.
 */
export function isSecretAssignmentValue(value: string, mode: RedactMode, quoted: boolean): boolean {
  if (value.length < 8 || PYTHON_WHITESPACE_CHAR.test(value) || value.startsWith("[REDACTED") || isPlaceholderValue(value)) return false;
  if (value.includes("(") || value.includes("${") || value.includes("$(") || CODE_EXPRESSION_VALUE.test(value)) return false;
  if (value.startsWith("<") && value.endsWith(">")) return false;
  if (isFilesystemPathValue(value)) return false;
  const identifier = !quoted && IDENTIFIER_VALUE.test(value);
  if (mode === "source") {
    return !identifier
      && (quoted || TOKEN_SHAPE_VALUE.test(value))
      && (/\d/.test(value) || (value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value)));
  }
  return /[A-Za-z]/.test(value) && !(identifier && value.includes("."));
}

/**
 * Placeholder assignment values, never secrets: a value made only of these
 * words, digit runs of up to four digits or counting up (`12345678`) and runs
 * of one repeated character (`xxxx`, `0000`), at least one of them a marker
 * (PLACEHOLDER_MARKERS, or a repeated-character run of 3+): `your-token-here`,
 * `changeme`, `fake-not-a-real-token-0000`, `YOUR_API_KEY`, `xxxxxxxxxxxx`.
 * Segments as keySegments splits a key. The backend's is_placeholder_value.
 */
const PLACEHOLDER_MARKERS = new Set([
  "your", "yours", "here", "fake", "dummy", "example", "sample", "placeholder", "changeme", "replaceme", "replace", "insert",
  "todo", "fixme", "tbd", "mock", "demo", "redacted", "notreal", "test", "testing",
]);
const PLACEHOLDER_WORDS = new Set([
  "my", "the", "a", "an", "not", "real", "is", "goes", "go", "put", "enter", "set", "this", "to", "with", "of", "for", "in", "me",
  "change", "secret", "secrets", "token", "tokens", "key", "keys", "api", "apikey", "password", "passwd", "pass", "pwd", "value",
  "access", "auth", "private", "client", "id", "string", "foo", "bar", "baz", "qux", "abc", "xyz", "default", "dev", "local",
]);
const REPEATED_CHAR = /^(.)\1*$/su;
export function isPlaceholderValue(value: string): boolean {
  const segments = keySegments(value);
  if (segments.length === 0) return false;
  let marked = false;
  for (const segment of segments) {
    if (PLACEHOLDER_MARKERS.has(segment) || ([...segment].length >= 3 && REPEATED_CHAR.test(segment))) marked = true;
    else if (PLACEHOLDER_WORDS.has(segment) || (/^[0-9]+$/.test(segment) && (segment.length <= 4 || "0123456789".includes(segment)))) continue;
    else return false;
  }
  return marked;
}

/**
 * The token after `Bearer` is a secret when it carries a digit, or is 20+
 * characters of mixed case that are not a bare identifier or member
 * expression (`Bearer yourAccessTokenGoesHere` is a placeholder; so is
 * `Bearer test-token`, too short and digitless).
 */
function isBearerSecret(token: string): boolean {
  if (/\d/.test(token)) return true;
  return token.length >= 20 && /[a-z]/.test(token) && /[A-Z]/.test(token) && !IDENTIFIER_VALUE.test(token);
}

function applyRedaction(text: string, [pattern, replacement]: Redaction, tally: { count: number }): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, (match: string, group?: string) => {
    const replaced = typeof replacement === "string" ? replacement : replacement(match, typeof group === "string" ? group : "");
    // A kept match (isKeptEmail, isKeptIpv4) is returned as it was and is no redaction.
    if (replaced !== match) tally.count += 1;
    return replaced;
  });
}

/** Redacts the value of every secret-named assignment; one redaction per assignment. */
function redactAssignments(text: string, tally: { count: number }, mode: RedactMode, depth = 0): string {
  const pattern = mode === "source" ? SOURCE_ASSIGNMENT_PATTERN : ASSIGNMENT_PATTERN;
  pattern.lastIndex = 0;
  return text.replace(pattern, (match: string, _quote: string, key: string, doubleQuoted?: string, singleQuoted?: string, escapedQuoted?: string, bare?: string) => {
    const value = doubleQuoted ?? singleQuoted ?? escapedQuoted ?? bare ?? "";
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : escapedQuoted !== undefined ? '\\"' : "";
    const prefix = match.slice(0, match.length - value.length - quote.length * 2);
    if (isSecretAssignmentKey(key) && isSecretAssignmentValue(value, mode, bare === undefined)) {
      tally.count += 1;
      return `${prefix}${quote}${REDACTED}${quote}`;
    }
    // An excluded key (`token_url=https://x/?token=...`) or a code expression
    // can still carry a secret assignment inside its value.
    if (depth >= MAX_ASSIGNMENT_DEPTH) return match;
    return `${prefix}${quote}${redactAssignments(value, tally, mode, depth + 1)}${quote}`;
  });
}

/** Redacts `Bearer <token>` when the token part passes isBearerSecret. */
function redactBearerTokens(text: string, tally: { count: number }): string {
  BEARER_TOKEN.lastIndex = 0;
  return text.replace(BEARER_TOKEN, (match: string, prefix: string, token: string) => {
    if (!isBearerSecret(token)) return match;
    tally.count += 1;
    return `${prefix}${REDACTED}`;
  });
}

/**
 * Redacts 40-character mixed-case base64 runs that sit within three lines of
 * an AWS access key id or of the words aws/secret (or whose surrounding
 * context, such as the file path or JSON key, names them). Only a document of
 * three or more lines (two or more line breaks) is scanned, unless the
 * enclosing JSON object or array names an AWS key (`awsContext`, the JSON
 * container rail), which vouches for a single string. The backend's
 * _redact_aws_secrets.
 */
function redactAwsSecrets(text: string, context: string | undefined, tally: { count: number }, awsContext = false): string {
  const nearContext = awsContext || (context !== undefined && AWS_SECRET_CONTEXT.test(context));
  // No context anywhere in the text or around it means no line can qualify.
  // Both checks must pass; this one goes first because a literal scan is
  // many times cheaper than looking for a 40-character run.
  if (!nearContext && !AWS_SECRET_CONTEXT.test(text)) return text;
  if (!AWS_SECRET_QUICK.test(text)) return text;
  const lines = text.split("\n");
  if (lines.length < AWS_SECRET_MIN_LINES && !awsContext) return text;
  const contextual: Array<boolean | undefined> = new Array(lines.length);
  const hasContext = (index: number): boolean => {
    if (contextual[index] === undefined) contextual[index] = AWS_SECRET_CONTEXT.test(lines[index]!);
    return contextual[index]!;
  };
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length < 40 || !AWS_SECRET_QUICK.test(line)) continue;
    let nearby = nearContext;
    const last = Math.min(lines.length - 1, index + AWS_SECRET_CONTEXT_LINES);
    for (let other = Math.max(0, index - AWS_SECRET_CONTEXT_LINES); !nearby && other <= last; other += 1) nearby = hasContext(other);
    if (!nearby) continue;
    AWS_SECRET_CANDIDATE.lastIndex = 0;
    lines[index] = line.replace(AWS_SECRET_CANDIDATE, (candidate: string) => {
      if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate) || !/\d/.test(candidate)) return candidate;
      tally.count += 1;
      changed = true;
      return REDACTED;
    });
  }
  return changed ? lines.join("\n") : text;
}

// Substring gates for the text scrubber: each rule needs a literal the text
// must contain, so a text without it skips that regex pass outright. A gate is
// sound (it never skips a text its rule could match) and changes nothing about
// what is redacted; it only spares the scan's dominant CPU cost. A pattern
// without a gate always runs.
// The assignment rule's key must contain one of these (case-insensitively).
const ASSIGNMENT_LINE_GATE = /secret|passw|pwd|token|credential|auth|key/gi;
const BEARER_GATE = /bearer/i;
const DIGIT_GATE = /\d/;
const DISCORD_TOKEN_GATE = /[MN][\w-]{23,}\./;
const SECRET_PATTERN_GATES: Array<(text: string) => boolean> = [
  (text) => text.includes("AKIA") || text.includes("ASIA"),
  (text) => /gh[pousr]_/.test(text),
  (text) => text.includes("github_pat_"),
  (text) => /xox[abpr]-/.test(text),
  (text) => text.includes("AIza"),
  (text) => /[sr]k_(?:live|test)_/.test(text),
  (text) => text.includes("sk-ant-"),
  (text) => /(?:sk|rk|pk)-/.test(text),
  (text) => text.includes("eyJ"),
  (text) => DISCORD_TOKEN_GATE.test(text),
];
// Every literal the gates above look for, in one scan: when none occurs (and
// no Discord-shaped run either) no provider-token rule can run, so the text
// each later gate would see is unchanged and the whole loop is skipped.
const PROVIDER_TOKEN_LITERALS = /AKIA|ASIA|gh[pousr]_|github_pat_|xox[abpr]-|AIza|[sr]k_(?:live|test)_|sk-ant-|(?:sk|rk|pk)-|eyJ/;

/**
 * Runs `redact` over each line holding a gate match and leaves every other
 * line as it is. Sound only for a rule whose matches never contain a line
 * break and always contain a gate match: the assignment and e-mail rules admit
 * no "\n" in any character class, their keys (or "@") are part of the match's
 * line, and their lookbehinds see a line start's "\n" exactly as they see the
 * start of the text. The result is identical to running the rule over the
 * whole text; only lines that could match pay for the rule's regex.
 */
function redactGatedLines(text: string, nextGate: (from: number) => number, redact: (line: string) => string): string {
  let output = "";
  let copied = 0;
  let changed = false;
  let at = nextGate(0);
  while (at !== -1) {
    const start = text.lastIndexOf("\n", at) + 1;
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    const redacted = redact(line);
    if (redacted !== line) {
      output += text.slice(copied, start) + redacted;
      copied = end;
      changed = true;
    }
    if (newline === -1) break;
    at = nextGate(newline + 1);
  }
  return changed ? output + text.slice(copied) : text;
}

function nextAssignmentKeyword(text: string, from: number): number {
  ASSIGNMENT_LINE_GATE.lastIndex = from;
  return ASSIGNMENT_LINE_GATE.exec(text)?.index ?? -1;
}

export type RedactUploadTextOptions = {
  /** Text that counts as context for context-dependent rules: the file path, or the JSON key a value sits under. */
  context?: string;
  /** Value rule mode; CONFIG when omitted (the trace, JSON). See redactModeForPath. */
  mode?: RedactMode;
  /** The enclosing JSON object or array names an AWS key: the AWS rule runs whatever the line count. */
  awsContext?: boolean;
};

/**
 * Scrubs free text before upload: private key blocks, secret-named
 * assignments, provider token shapes and personal identifiers. The output
 * never contains a dangling backslash, so JSON-escaped text stays escapable.
 */
export function redactUploadText(input: string, options: RedactUploadTextOptions = {}): { text: string; count: number } {
  const tally = { count: 0 };
  let text = input.includes("-----BEGIN ") ? applyRedaction(input, PRIVATE_KEY_BLOCK, tally) : input;
  if (text.includes("://")) text = applyRedaction(text, URL_USERINFO, tally);
  const mode = options.mode ?? "config";
  const assigned = text;
  text = redactGatedLines(assigned, (from) => nextAssignmentKeyword(assigned, from), (line) => redactAssignments(line, tally, mode));
  text = redactAwsSecrets(text, options.context, tally, options.awsContext);
  if (PROVIDER_TOKEN_LITERALS.test(text) || DISCORD_TOKEN_GATE.test(text)) {
    SECRET_PATTERNS.forEach((redaction, index) => {
      const gate = SECRET_PATTERN_GATES[index];
      if (!gate || gate(text)) text = applyRedaction(text, redaction, tally);
    });
  }
  if (BEARER_GATE.test(text)) text = redactBearerTokens(text, tally);
  // The e-mail rule needs an "@" on the line; the phone, SSN and IP rules need a digit.
  const mailed = text;
  text = redactGatedLines(mailed, (from) => mailed.indexOf("@", from), (line) => applyRedaction(line, PII_PATTERNS[0]!, tally));
  if (DIGIT_GATE.test(text)) {
    // A JSON value under a `version` key (`"version": "3.192.1.7"`, a package list) is a version, never an address.
    const versionField = options.context !== undefined && keySegments(options.context).at(-1) === "version";
    for (const redaction of PII_PATTERNS.slice(1)) {
      if (versionField && redaction === PII_PATTERNS[3]) continue;
      text = applyRedaction(text, redaction, tally);
    }
  }
  return { text, count: tally.count };
}

/**
 * A JSON object with a repeated key, kept as its (key, value) pairs in order.
 * JSON.parse keeps only the last value of a repeated key, so a secret in a
 * shadowed value (merge-conflict leftovers, generated configs) would pass the
 * structural scrub untouched and, with nothing else to redact, leave the
 * machine byte for byte. The backend's _Pairs.
 */
class JsonPairs {
  constructor(readonly pairs: Array<[string, unknown]>) {}
}

/** A `.json` file nested deeper than this is scrubbed as text instead (the backend's MAX_TRACE_DEPTH). */
const MAX_JSON_FILE_DEPTH = 512;

class JsonTooDeep extends Error {}

/** Redaction count, plus the object members visited: a repeated key shows up as a shortfall against the text. */
type JsonTally = { count: number; members: number };

/** Whether a JSON item is a string naming an AWS key. */
function namesAws(item: unknown): boolean {
  return typeof item === "string" && AWS_SECRET_CONTEXT.test(item);
}

/**
 * Whether an object's keys or direct string values, or an array's string
 * items, name an AWS key. The backend's _names_aws.
 */
function membersNameAws(members: ReadonlyArray<readonly [string, unknown]>): boolean {
  return members.some(([key, item]) => namesAws(key) || namesAws(item));
}

function redactJsonValue(
  value: unknown,
  key: string | undefined,
  tally: JsonTally,
  depth = 0,
  awsContext = false,
  maxDepth = Infinity,
  fileAware = false,
): unknown {
  if (depth > maxDepth) throw new JsonTooDeep();
  if (value instanceof Prescrubbed) return value.text;
  if (typeof value === "string") {
    // A JSON string is always a quoted literal, scrubbed in CONFIG mode.
    // A path-like key (`{"src/admin_auth.py": "<sha256>"}`) names a file, never a secret.
    if (key !== undefined && !isPathLikeKey(key) && isSecretAssignmentKey(key) && isSecretAssignmentValue(value, "config", true)) {
      tally.count += 1;
      return REDACTED;
    }
    const result = redactUploadText(value, { context: key, awsContext });
    tally.count += result.count;
    return result.text;
  }
  if (!value || typeof value !== "object") return value;
  // The enclosing object or array is AWS context once one of its keys or
  // string items names an AWS key, the structural counterpart of the text
  // rule's three-line window: `{"name": "AWS_SECRET_ACCESS_KEY", "value":
  // "<40 characters>"}` (task definitions, k8s env lists, Postman
  // environments) is redacted although `value` names nothing.
  if (Array.isArray(value)) {
    const context = awsContext || value.some(namesAws);
    return value.map((item) => redactJsonValue(item, key, tally, depth + 1, context, maxDepth, fileAware));
  }
  if (value instanceof JsonPairs) {
    tally.members += value.pairs.length;
    const context = awsContext || membersNameAws(value.pairs);
    return new JsonPairs(value.pairs.map(([childKey, childValue]) => {
      const scrubbedKey = redactUploadText(childKey, { awsContext: context });
      tally.count += scrubbedKey.count;
      return [scrubbedKey.text, redactJsonValue(childValue, childKey, tally, depth + 1, context, maxDepth, fileAware)];
    }));
  }
  const serializable = value as { toJSON?: unknown };
  if (typeof serializable.toJSON === "function") return redactJsonValue((serializable.toJSON as () => unknown)(), key, tally, depth, awsContext, maxDepth, fileAware);
  const record = fileAware ? fileAwareRecord(value as Record<string, unknown>, tally) : value as Record<string, unknown>;
  const entries = Object.entries(record);
  tally.members += entries.length;
  const context = awsContext || membersNameAws(entries);
  // No prototype, so a `__proto__` key stays an ordinary member.
  const output: Record<string, unknown> = Object.create(null);
  for (const [childKey, childValue] of entries) {
    const scrubbedKey = redactUploadText(childKey, { awsContext: context });
    tally.count += scrubbedKey.count;
    output[scrubbedKey.text] = redactJsonValue(childValue, childKey, tally, depth + 1, context, maxDepth, fileAware);
  }
  return output;
}

/**
 * Scrubs a JSON value structurally: every string (keys included) goes through
 * the text scrubber, a string under a secret-named key is redacted whole,
 * exactly as the `key: value` text rule would treat it, and an object or array
 * naming an AWS key makes its values AWS context. Serialising the result can
 * never produce a broken escape, which scrubbing serialised JSON as text could.
 * The backend's _redact_json_value.
 */
export function redactUploadJson(value: unknown, options: { fileAware?: boolean } = {}): { value: unknown; count: number } {
  const tally: JsonTally = { count: 0, members: 0 };
  return { value: redactJsonValue(value, undefined, tally, 0, false, Infinity, options.fileAware === true), count: tally.count };
}

/**
 * Object members in valid JSON text: every `:` outside a string separates one.
 * Fewer members in the parsed value than here means a repeated key.
 */
function countJsonMembers(text: string): number {
  let members = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index += 1;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x3a) {
      members += 1;
    }
  }
  return members;
}

const JSON_STRING_TOKEN = /"[^"\\]*(?:\\.[^"\\]*)*"/y;
const JSON_NUMBER_TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_WHITESPACE = /[ \t\n\r]*/y;

/**
 * Parses text JSON.parse has already accepted, keeping every object as its
 * (key, value) pairs so a repeated key loses nothing. Only used for a document
 * that has one: JSON.parse is several times faster.
 */
function parseJsonPairs(text: string): unknown {
  let at = 0;
  const token = (pattern: RegExp): string => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) throw new SyntaxError(`unexpected JSON at ${at}`);
    at = pattern.lastIndex;
    return match[0];
  };
  const skip = () => token(JSON_WHITESPACE);
  const value = (depth: number): unknown => {
    if (depth > MAX_JSON_FILE_DEPTH) throw new JsonTooDeep();
    skip();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const pairs: Array<[string, unknown]> = [];
      skip();
      if (text[at] === "}") {
        at += 1;
        return new JsonPairs(pairs);
      }
      for (;;) {
        skip();
        const key = JSON.parse(token(JSON_STRING_TOKEN)) as string;
        skip();
        at += 1; // ":"
        pairs.push([key, value(depth + 1)]);
        skip();
        if (text[at++] === "}") return new JsonPairs(pairs);
      }
    }
    if (char === "[") {
      at += 1;
      const items: unknown[] = [];
      skip();
      if (text[at] === "]") {
        at += 1;
        return items;
      }
      for (;;) {
        items.push(value(depth + 1));
        skip();
        if (text[at++] === "]") return items;
      }
    }
    if (char === '"') return JSON.parse(token(JSON_STRING_TOKEN)) as string;
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return parsed;
      }
    }
    return Number(token(JSON_NUMBER_TOKEN));
  };
  return value(0);
}

/** JSON.stringify(value, null, indent) for a value that may hold JsonPairs. */
function stringifyJsonPairs(value: unknown, indent: string | undefined, current = ""): string {
  const container = (items: string[], open: string, close: string): string => {
    if (items.length === 0) return `${open}${close}`;
    if (!indent) return `${open}${items.join(",")}${close}`;
    const inner = `${current}${indent}`;
    return `${open}\n${inner}${items.join(`,\n${inner}`)}\n${current}${close}`;
  };
  const nested = `${current}${indent ?? ""}`;
  const member = ([key, item]: [string, unknown]) => `${JSON.stringify(key)}:${indent ? " " : ""}${stringifyJsonPairs(item, indent, nested)}`;
  if (value instanceof JsonPairs) return container(value.pairs.map(member), "{", "}");
  if (Array.isArray(value)) return container(value.map((item) => stringifyJsonPairs(item, indent, nested)), "[", "]");
  if (value && typeof value === "object") return container(Object.entries(value).map(member), "{", "}");
  return JSON.stringify(value);
}

/**
 * Scrubs a JSON document as JSON, keeping its indentation style. The AWS rule
 * runs over the raw text first, where it sees the same lines it sees in a text
 * file; the document is then scrubbed value by value (repeated keys kept, pair
 * by pair). The text comes back untouched when nothing needed redacting (the
 * AWS pass aside), and null when it is not valid JSON or is nested deeper than
 * MAX_JSON_FILE_DEPTH, which the caller scrubs as text. The backend's
 * sanitize_json_file.
 */
export function redactUploadJsonText(text: string, path?: string): string | null {
  const raw = redactAwsSecrets(text, path, { count: 0 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const tally: JsonTally = { count: 0, members: 0 };
  let value: unknown;
  let pairs = false;
  try {
    value = redactJsonValue(parsed, undefined, tally, 0, false, MAX_JSON_FILE_DEPTH);
    if (tally.members !== countJsonMembers(raw)) {
      pairs = true;
      tally.count = 0;
      value = redactJsonValue(parseJsonPairs(raw), undefined, tally, 0, false, MAX_JSON_FILE_DEPTH);
    }
  } catch (error) {
    if (error instanceof JsonTooDeep) return null;
    throw error;
  }
  if (tally.count === 0) return raw;
  const indent = /\n([ \t]+)\S/.exec(raw)?.[1]?.slice(0, 10);
  const serialized = pairs ? stringifyJsonPairs(value, indent) : JSON.stringify(value, null, indent);
  return `${serialized}${raw.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Scrubs one workspace file for upload: `.json` files structurally (falling
 * back to text when they do not parse), everything else as text with the path
 * as context and the value rule mode the extension selects.
 */
export function redactUploadContent(path: string, text: string): string {
  return redactUploadContentCounted(path, text).text;
}

/** redactUploadContent plus how many redactions it made (0 means the text is byte-identical). */
function redactUploadContentCounted(path: string, text: string): { text: string; count: number } {
  if (/\.json$/i.test(path)) {
    const json = redactUploadJsonText(text, path);
    if (json !== null) return { text: json, count: json === text ? 0 : 1 };
  }
  return redactUploadText(text, { context: path, mode: redactModeForPath(path) });
}

// --- file-aware trace scrub --------------------------------------------------
// The trace is scrubbed in CONFIG mode, except for the strings that carry a
// workspace file's text: the content a file tool writes or replaces, the
// diffs and patches it reports, a read tool's output, and every file diff
// entry wherever it sits (an opencode message's `summary.diffs`, a
// `session.diff` item, a "turn.diff" event's hunks). Those are scrubbed
// with the mode the target file's path selects (redactModeForPath), exactly
// as a snapshot of that file is, so `f(token:string){...}` in a .ts file
// survives a write tool call the way it survives the file upload. A diff or
// patch naming several files is scrubbed file by file. Everything else
// (shell commands and output, chat text, other tools' input and output, a
// file tool call or diff with no path) stays CONFIG. The backend's
// _file_aware_* helpers apply the identical rule, at collection and in its
// export-time pass; a change here must land there too.

/** A string the file-aware pass already scrubbed: the JSON walker keeps it as it is. */
class Prescrubbed {
  constructor(readonly text: string) {}
}

const FILE_WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);
const FILE_PATCH_TOOLS = new Set(["patch", "apply_patch"]);
const FILE_READ_TOOLS = new Set(["read"]);
/** A file tool's target path, in the order looked for (opencode, pi, other engines). */
const FILE_TOOL_PATH_KEYS = ["filePath", "path", "file_path"];
/** A file tool input's whole-file text: scrubbed as the file's snapshot is. */
const FILE_TOOL_CONTENT_KEYS = ["content"];
/** A file tool input's replaced and replacing text. */
const FILE_TOOL_FRAGMENT_KEYS = ["oldString", "newString", "oldText", "newText", "old_string", "new_string"];
/** A patch tool input's patch text. */
const FILE_TOOL_PATCH_KEYS = ["patchText", "patch", "input"];
/** A file entry's path in tool metadata (apply_patch `files`, edit `filediff`). */
const FILE_ENTRY_PATH_KEYS = ["filePath", "file", "relativePath", "path"];
/** A file diff entry's path outside a tool part (summary.diffs[], session.diff, turn.diff files[]). */
const FILE_DIFF_PATH_KEYS = ["filePath", "file", "path", "file_path", "filename", "relativePath"];
// A diff or patch starts a new file at a git header, a jsdiff `Index:` line
// (opencode's edit and apply_patch metadata) or an apply_patch file marker.
const FILE_SEGMENT_START = /(?:^|(?<=\n))(?=diff --git |Index: |\*\*\* (?:Add|Update|Delete) File: )/;
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: ([\s\S]*)$/;
const MAX_TOOL_PATH_CHARS = 4096;

function fileToolPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > MAX_TOOL_PATH_CHARS || value.includes("\n") || value.includes("\r")) return null;
  return value;
}

function firstFilePath(records: readonly Record<string, unknown>[], keys: readonly string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const path = fileToolPath(record[key]);
      if (path !== null) return path;
    }
  }
  return null;
}

function trimBlanks(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** The path a diff segment names in its first line, or `fallback` for a segment with no file header. */
function diffSegmentPath(segment: string, fallback: string | null): string | null {
  const newline = segment.indexOf("\n");
  let first = newline === -1 ? segment : segment.slice(0, newline);
  if (first.endsWith("\r")) first = first.slice(0, -1);
  if (first.startsWith("diff --git ")) return diffHeaderPath(first);
  if (first.startsWith("Index: ")) return fileToolPath(trimBlanks(first.slice("Index: ".length)));
  const patch = PATCH_FILE_HEADER.exec(first);
  if (patch) return fileToolPath(trimBlanks(patch[1] ?? ""));
  return fallback;
}

/** Scrubs `text` as a file's text: the mode the path selects, CONFIG with no path. */
function redactFileText(text: string, path: string | null, tally: { count: number }): string {
  const result = path === null ? redactUploadText(text) : redactUploadText(text, { context: path, mode: redactModeForPath(path) });
  tally.count += result.count;
  return result.text;
}

/** Scrubs `text` as a whole file is uploaded: a `.json` file structurally, anything else as file text. */
function redactFileContent(text: string, path: string | null, tally: { count: number }): string {
  if (path !== null && extname(path).toLowerCase() === ".json") {
    const json = redactUploadJsonText(text, path);
    if (json !== null) {
      if (json !== text) tally.count += 1;
      return json;
    }
  }
  return redactFileText(text, path, tally);
}

/**
 * Scrubs a unified diff or patch file by file: each segment that starts with
 * a file header (`diff --git`, `Index:`, `*** Update File:`) under the mode
 * its own path selects, a segment with no header (a single-file diff, a
 * patch's preamble) under the mode of `fallback`. The backend's
 * redact_diff_by_file.
 */
export function redactDiffByFile(text: string, fallback: string | null, tally: { count: number } = { count: 0 }): string {
  let output = "";
  for (const segment of text.split(FILE_SEGMENT_START)) {
    if (segment) output += redactFileText(segment, diffSegmentPath(segment, fallback), tally);
  }
  return output;
}

function prescrub(record: Record<string, unknown>, key: string, scrub: (text: string) => string): void {
  const value = record[key];
  if (typeof value === "string") record[key] = new Prescrubbed(scrub(value));
}

/** A tool input with its file text prescrubbed (a copy; the original is left alone). */
function fileAwareToolInput(input: Record<string, unknown>, name: string, path: string | null, tally: { count: number }): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...input };
  if (FILE_PATCH_TOOLS.has(name)) {
    for (const key of FILE_TOOL_PATCH_KEYS) prescrub(copy, key, (text) => redactDiffByFile(text, null, tally));
    return copy;
  }
  if (path === null) return copy;
  for (const key of FILE_TOOL_CONTENT_KEYS) prescrub(copy, key, (text) => redactFileContent(text, path, tally));
  for (const key of FILE_TOOL_FRAGMENT_KEYS) prescrub(copy, key, (text) => redactFileText(text, path, tally));
  const edits = copy.edits;
  // Some models send `edits` as a JSON string: it is scrubbed as it stands,
  // escapes and all (SOURCE mode never reads past a `\n` escape).
  if (typeof edits === "string") copy.edits = new Prescrubbed(redactFileText(edits, path, tally));
  else if (Array.isArray(edits)) {
    copy.edits = edits.map((edit) => {
      if (!isRecord(edit)) return edit;
      const editPath = firstFilePath([edit], FILE_TOOL_PATH_KEYS) ?? path;
      const item: Record<string, unknown> = { ...edit };
      for (const key of FILE_TOOL_FRAGMENT_KEYS) prescrub(item, key, (text) => redactFileText(text, editPath, tally));
      return item;
    });
  }
  return copy;
}

/** A file entry of tool metadata (`filediff`, an apply_patch `files` item) with its texts prescrubbed. */
function fileAwareFileEntry(entry: Record<string, unknown>, path: string | null, tally: { count: number }): Record<string, unknown> {
  const entryPath = firstFilePath([entry], FILE_ENTRY_PATH_KEYS) ?? path;
  const copy: Record<string, unknown> = { ...entry };
  for (const key of ["patch", "diff"]) prescrub(copy, key, (text) => redactDiffByFile(text, entryPath, tally));
  if (entryPath !== null) {
    for (const key of ["before", "after"]) prescrub(copy, key, (text) => redactFileContent(text, entryPath, tally));
  }
  return copy;
}

/** File tool metadata (opencode's, pi's details, the 2.x engine's under `v2`) with its diffs prescrubbed. */
function fileAwareToolMetadata(metadata: Record<string, unknown>, path: string | null, tally: { count: number }, depth = 0): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...metadata };
  for (const key of ["diff", "patch"]) prescrub(copy, key, (text) => redactDiffByFile(text, path, tally));
  if (isRecord(copy.filediff)) copy.filediff = fileAwareFileEntry(copy.filediff, path, tally);
  if (Array.isArray(copy.files)) copy.files = copy.files.map((entry) => (isRecord(entry) ? fileAwareFileEntry(entry, path, tally) : entry));
  if (depth === 0) {
    // multiedit: one edit's metadata per edit.
    if (Array.isArray(copy.results)) copy.results = copy.results.map((entry) => (isRecord(entry) ? fileAwareToolMetadata(entry, path, tally, 1) : entry));
    if (isRecord(copy.v2)) copy.v2 = fileAwareToolMetadata(copy.v2, path, tally, 1);
  }
  return copy;
}

/** A read tool's state with the file text it returned prescrubbed. */
function fileAwareReadState(state: Record<string, unknown>, path: string, tally: { count: number }): void {
  prescrub(state, "output", (text) => redactFileText(text, path, tally));
  if (Array.isArray(state.content)) {
    state.content = state.content.map((item) => {
      if (!isRecord(item) || item.type !== "text") return item;
      const copy: Record<string, unknown> = { ...item };
      prescrub(copy, "text", (text) => redactFileText(text, path, tally));
      return copy;
    });
  }
  if (isRecord(state.metadata)) {
    const metadata: Record<string, unknown> = { ...state.metadata };
    prescrub(metadata, "preview", (text) => redactFileText(text, path, tally));
    if (isRecord(metadata.display)) {
      const display: Record<string, unknown> = { ...metadata.display };
      prescrub(display, "text", (text) => redactFileText(text, path, tally));
      metadata.display = display;
    }
    state.metadata = metadata;
  }
}

/** The lower-cased tool name of an engine tool part (`tool`, else the 2.x `name`), or null. */
function fileToolName(part: Record<string, unknown>): string | null {
  const raw = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : null;
  if (raw === null) return null;
  const name = raw.toLowerCase().split(".").at(-1) ?? "";
  return FILE_WRITE_TOOLS.has(name) || FILE_PATCH_TOOLS.has(name) || FILE_READ_TOOLS.has(name) ? name : null;
}

/**
 * The path of a file diff entry found anywhere in the trace, or null: a
 * record naming a file (`filePath`, `file`, `path`, `file_path`,
 * `filename`, `relativePath`) next to a `patch` or `diff` string, or next to
 * whole-file `before`/`after` texts with `additions`/`deletions` counts.
 * That is an opencode message's `summary.diffs[]` item and a `session.diff`
 * event's item (`{file, patch|before|after, additions, deletions, status}`)
 * and a "turn.diff" event's `files[]` item (`{path, diff}`).
 */
function fileDiffEntryPath(record: Record<string, unknown>): string | null {
  const hasDiff = typeof record.patch === "string" || typeof record.diff === "string";
  const hasTexts = (typeof record.before === "string" || typeof record.after === "string")
    && (typeof record.additions === "number" || typeof record.deletions === "number");
  return hasDiff || hasTexts ? firstFilePath([record], FILE_DIFF_PATH_KEYS) : null;
}

/** A tool's state (an engine tool part's `state`) with the file text it carries prescrubbed. */
function fileAwareToolState(source: Record<string, unknown>, name: string, tally: { count: number }): Record<string, unknown> {
  const state: Record<string, unknown> = { ...source };
  const v2 = isRecord(state.v2) ? { ...state.v2 } : null;
  const inputs = [state.input, v2?.input].filter(isRecord);
  const path = firstFilePath(inputs, FILE_TOOL_PATH_KEYS);
  if (FILE_READ_TOOLS.has(name)) {
    if (path !== null) fileAwareReadState(state, path, tally);
    return state;
  }
  if (isRecord(state.input)) state.input = fileAwareToolInput(state.input, name, path, tally);
  if (isRecord(state.metadata)) state.metadata = fileAwareToolMetadata(state.metadata, path, tally);
  if (v2 !== null) {
    if (isRecord(v2.input)) v2.input = fileAwareToolInput(v2.input, name, path, tally);
    state.v2 = v2;
  }
  return state;
}

/**
 * The record with the strings that carry file text prescrubbed under their
 * file's mode, or the record itself when it carries none. The walker calls
 * it on every object of the trace, at any depth, so a shape is handled
 * wherever it sits (a "turn.completed" or "turn.messages" event's
 * `data.messages[].parts[]`, a "session.child" event's messages, an
 * envelope's events):
 *
 * - an engine tool part of a file tool, `{type: "tool", tool|name, state}`
 *   (opencode, pi, 2.x natives under `state.v2`);
 * - a pi tool call, `{type: "toolCall", name, arguments}`;
 * - a file diff entry (fileDiffEntryPath): message `summary.diffs[]`,
 *   `session.diff` items, "turn.diff" `files[]`.
 *
 * The backend's _file_aware_record.
 */
function fileAwareRecord(record: Record<string, unknown>, tally: { count: number }): Record<string, unknown> {
  if (record.type === "tool" && isRecord(record.state)) {
    const name = fileToolName(record);
    return name === null ? record : { ...record, state: fileAwareToolState(record.state, name, tally) };
  }
  if (record.type === "toolCall" && isRecord(record.arguments)) {
    const name = fileToolName(record);
    if (name === null || FILE_READ_TOOLS.has(name)) return record;
    const path = firstFilePath([record.arguments], FILE_TOOL_PATH_KEYS);
    return { ...record, arguments: fileAwareToolInput(record.arguments, name, path, tally) };
  }
  const path = fileDiffEntryPath(record);
  if (path === null) return record;
  const copy: Record<string, unknown> = { ...record };
  for (const key of ["patch", "diff"]) prescrub(copy, key, (text) => redactDiffByFile(text, path, tally));
  for (const key of ["before", "after"]) prescrub(copy, key, (text) => redactFileContent(text, path, tally));
  return copy;
}

/**
 * Removes the userinfo (`user:password@`) from a git remote URL. Both
 * scheme URLs (`https://token@host/...`) and scp-like remotes
 * (`git@host:org/repo.git`) lose their userinfo so an embedded access token
 * can never travel with a snapshot.
 */
export function stripRemoteUserinfo(url: string): string {
  const trimmed = url.trim();
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?(.*)$/i);
  if (scheme) return `${scheme[1]}${scheme[3] ?? ""}`;
  const scp = trimmed.match(/^([^/@:\s]+@)([^/:\s]+:.*)$/);
  if (scp) return scp[2] ?? trimmed;
  return trimmed;
}

const PATH_FIELD_NAMES = new Set([
  "path",
  "file_path",
  "filepath",
  "filename",
  "file_name",
  "target_path",
  "targetpath",
  "workspace_path",
  "workspacepath",
  "old_path",
  "oldpath",
  "new_path",
  "newpath",
]);

const TOOL_READ_TRACE_TYPES = new Set([
  "file.read",
  "file.open",
  "tool.read",
  "tool.file_read",
]);
const TOOL_WRITE_TRACE_TYPES = new Set([
  "file.write",
  "file.create",
  "file.edit",
  "file.patch",
  "file.delete",
  "file.remove",
  "tool.write",
  "tool.create",
  "tool.edit",
  "tool.patch",
  "tool.apply_patch",
  "tool.delete",
]);

type TracePathEvidence = { path: string; relevance: number };

function pathValue(value: unknown, key: string): string | null {
  if (typeof value !== "string" || !PATH_FIELD_NAMES.has(key.toLowerCase())) return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048 || candidate.includes("\n") || candidate.includes("\r") || candidate.includes("://")) return null;
  return candidate;
}

const KNOWN_READ_TOOLS = new Set(["cat", "file_read", "open", "read", "read_file", "view"]);
const KNOWN_WRITE_TOOLS = new Set(["apply_patch", "create", "delete", "edit", "file_write", "move", "patch", "remove", "rename", "rm", "write", "write_file"]);

function pathEvidenceFromContainers(relevance: number, containers: readonly Record<string, unknown>[]): TracePathEvidence[] {
  const output: TracePathEvidence[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    for (const [key, value] of Object.entries(container)) {
      const candidate = pathValue(value, key);
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        output.push({ path: candidate, relevance });
      }
    }
  }
  return output.slice(0, 128);
}

function patchPaths(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 256 * 1024) return [];
  const paths: string[] = [];
  for (const match of value.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to):[ \t]*(.+)$/gm)) {
    const path = match[1]?.trim();
    if (path) paths.push(path.split(/\s+->\s+/u)[0] ?? path);
  }
  return paths;
}

function patchPathsFromContainers(values: readonly unknown[]): string[] {
  const paths: string[] = [];
  for (const value of values) {
    paths.push(...patchPaths(value));
    if (!isRecord(value)) continue;
    for (const key of ["patch", "content", "text", "diff"]) paths.push(...patchPaths(value[key]));
  }
  return paths;
}

function toolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().split(".").at(-1) ?? "";
  return normalized || null;
}

function messageToolPathEvidence(value: Record<string, unknown>): TracePathEvidence[] {
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const output: TracePathEvidence[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const name = toolName(part.tool ?? part.name);
      const relevance = name && KNOWN_WRITE_TOOLS.has(name) ? 0 : name && KNOWN_READ_TOOLS.has(name) ? 1 : null;
      if (relevance === null) continue;
      const containers: Record<string, unknown>[] = [];
      for (const key of ["input", "arguments", "args", "params", "output", "result"]) {
        const child = part[key];
        if (isRecord(child)) containers.push(child);
      }
      const state = part.state;
      if (isRecord(state)) {
        for (const key of ["input", "output", "metadata"]) {
          const child = state[key];
          if (isRecord(child)) containers.push(child);
          if (name === "apply_patch") {
            for (const path of patchPathsFromContainers([child])) output.push({ path, relevance });
          }
        }
      }
      if (name === "apply_patch") {
        for (const key of ["patch", "content", "text"]) {
          for (const path of patchPathsFromContainers([part[key]])) output.push({ path, relevance });
        }
      }
      output.push(...pathEvidenceFromContainers(relevance, containers));
    }
  }
  return output.slice(0, 128);
}

/**
 * Only tool events with a known read/write/delete meaning may attribute a
 * path. Generic trace payloads are deliberately opaque: a random `path` key
 * in a model message must never turn into file relevance or a workspace read.
 */
function knownToolPathEvidence(type: string, data: unknown): TracePathEvidence[] {
  const relevance = TOOL_WRITE_TRACE_TYPES.has(type) ? 0 : TOOL_READ_TRACE_TYPES.has(type) ? 1 : null;
  if (relevance === null || !isRecord(data)) {
    if (!["turn.messages", "turn.completed", "session.completed", "engine.request"].includes(type) || !isRecord(data)) return [];
    return messageToolPathEvidence(data);
  }
  const containers: Record<string, unknown>[] = [data];
  for (const key of ["input", "arguments", "args", "params", "output", "result"]) {
    const child = data[key];
    if (isRecord(child)) containers.push(child);
  }
  return pathEvidenceFromContainers(relevance, containers);
}

/** The rules of a .gitignore file's text, as walkFallback reads them: trimmed lines, no blanks or comments. */
export function parseGitignoreRules(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function readGitignoreFile(directory: string): Promise<string[]> {
  try {
    return parseGitignoreRules(await readFile(resolve(directory, ".gitignore"), "utf8"));
  } catch {
    return [];
  }
}

/** A directory's .gitignore rules re-rooted at the workspace, as walkFallback applies them. */
export function scopedIgnoreRules(prefix: string, localRules: string[]): string[] {
  return localRules.map((rule) => {
    const negated = rule.startsWith("!");
    const body = negated ? rule.slice(1) : rule;
    const scoped = prefix ? `${prefix}/${body}` : body;
    return negated ? `!${scoped}` : scoped;
  });
}

export function ignoredByRules(path: string, rules: readonly string[]): boolean {
  let ignored = false;
  for (const raw of rules) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\//, "").replace(/\/$/, "/**");
    if (!pattern) continue;
    if (minimatch(path, pattern, { dot: true, matchBase: !pattern.includes("/") })) ignored = !negated;
  }
  return ignored;
}

/**
 * Asks git which of `paths` its ignore rules cover, in one process: the
 * ignored paths come back NUL-separated. Null when git cannot answer (not a
 * repository, missing, timed out): the caller applies the .gitignore files
 * itself, exactly as the listing walker does.
 */
async function gitIgnoredPaths(root: string, paths: string[]): Promise<Set<string> | null> {
  return (await gitSkipReason()) ? null : gitIgnoredPathsNow(root, paths);
}

function gitIgnoredPathsNow(root: string, paths: string[]): Promise<Set<string> | null> {
  return new Promise((resolvePromise) => {
    const ignored = new Set<string>();
    if (paths.length === 0) {
      resolvePromise(ignored);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch {
      resolvePromise(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    // Exit 0: some paths are ignored; 1: none are; anything else: no answer.
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!answered) {
        resolvePromise(null);
        return;
      }
      for (const path of Buffer.concat(chunks).toString("utf8").split("\0")) {
        if (path) ignored.add(path);
      }
      resolvePromise(ignored);
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (total >= 16 * 1024 * 1024) return;
      chunks.push(chunk);
      total += chunk.length;
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 || code === 1));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${paths.join("\0")}\0`);
  });
}

/**
 * gitIgnoredPaths for a batch in which git may refuse single paths: one path
 * beyond a symbolic link (`linked/util.ts`) makes the whole batch exit 128. A
 * refused batch is split in halves until every refusal is a single path, so
 * one bad path never changes the answer for the others (and never sends them
 * to the .gitignore-only fallback, which knows nothing of `.git/info/exclude`
 * or `core.excludesFile`). A path git refuses on its own counts as ignored:
 * it is never uploaded. Null only when the workspace is not a git work tree
 * (or git is missing), where the caller applies the .gitignore files itself.
 * `onSpawn` counts each `git check-ignore` run.
 */
async function gitIgnoredPathsIsolated(root: string, paths: string[], onSpawn: () => void): Promise<Set<string> | null> {
  onSpawn();
  const whole = await gitIgnoredPaths(root, paths);
  if (whole) return whole;
  if ((await gitText(root, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
  const ignored = new Set<string>();
  const isolate = async (refused: string[]): Promise<void> => {
    if (refused.length === 1) {
      ignored.add(refused[0]!);
      return;
    }
    const middle = refused.length >> 1;
    for (const half of [refused.slice(0, middle), refused.slice(middle)]) {
      onSpawn();
      const answer = await gitIgnoredPaths(root, half);
      if (!answer) await isolate(half);
      else for (const path of answer) ignored.add(path);
    }
  };
  await isolate(paths);
  return ignored;
}

/**
 * The listing walker's ignore decision for individual paths, for a workspace
 * git cannot answer for: a path is ignored when it, or any directory above
 * it, matches the .gitignore rules in force at that level.
 */
async function fallbackIgnoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  const rulesByDirectory = new Map<string, Promise<string[]>>();
  const rulesAt = (directory: string): Promise<string[]> => {
    let rules = rulesByDirectory.get(directory);
    if (!rules) {
      const slash = directory.lastIndexOf("/");
      const parent = slash === -1 ? "" : directory.slice(0, slash);
      rules = (async () => [
        ...(directory === "" ? [] : await rulesAt(parent)),
        ...scopedIgnoreRules(directory, await readGitignoreFile(resolve(root, directory))),
      ])();
      rulesByDirectory.set(directory, rules);
    }
    return rules;
  };
  const ignored = new Set<string>();
  for (const path of paths) {
    let directory = "";
    for (const part of pathComponents(path)) {
      const current = directory ? `${directory}/${part}` : part;
      if (ignoredByRules(current, await rulesAt(directory))) {
        ignored.add(path);
        break;
      }
      directory = current;
    }
  }
  return ignored;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ledgerModel(value: unknown): UploadSessionModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const model: UploadSessionModel = {
    provider_id: nullableString(record.provider_id),
    model_id: nullableString(record.model_id),
    variant: nullableString(record.variant),
    agent: nullableString(record.agent),
  };
  return model.provider_id || model.model_id ? model : undefined;
}

async function readSessionLedger(path: string | null): Promise<SessionLedger> {
  if (!path) return { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SessionLedger>;
    if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      return { version: 1, sessions: {} };
    }
    const sessions = Object.fromEntries(
      Object.entries(parsed.sessions as Record<string, unknown>).flatMap(([sessionId, value]) => {
        if (!value || typeof value !== "object") return [];
        const record = value as Partial<SessionLedgerRecord>;
        if (typeof record.segment !== "number" || !Number.isSafeInteger(record.segment) || record.segment < 1
          || typeof record.nextSequence !== "number" || !Number.isSafeInteger(record.nextSequence) || record.nextSequence < 0
          || (record.sentBytes !== undefined && (!Number.isSafeInteger(record.sentBytes) || record.sentBytes < 0))
          || typeof record.lastSeenAt !== "string") return [];
        const model = ledgerModel(record.model);
        const childSessionIds = Array.isArray(record.childSessionIds)
          ? record.childSessionIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX_CHILD_SESSIONS)
          : [];
        const childCheckpoints = record.childCheckpoints && typeof record.childCheckpoints === "object"
          ? Object.fromEntries(Object.entries(record.childCheckpoints as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
              .slice(0, MAX_CHILD_SESSIONS))
          : {};
        const cleaned: SessionLedgerRecord = {
          segment: record.segment,
          nextSequence: record.nextSequence,
          lastSeenAt: record.lastSeenAt,
          ...(record.sentBytes !== undefined ? { sentBytes: record.sentBytes } : {}),
          ...(optionalString(record.lastMessageId) ? { lastMessageId: record.lastMessageId } : {}),
          ...(optionalCount(record.failureCount) !== undefined ? { failureCount: record.failureCount } : {}),
          ...(optionalString(record.lastFailureAt) ? { lastFailureAt: record.lastFailureAt } : {}),
          ...(optionalString(record.lastSuccessAt) ? { lastSuccessAt: record.lastSuccessAt } : {}),
          ...(model ? { model } : {}),
          ...(childSessionIds.length > 0 ? { childSessionIds } : {}),
          ...(Object.keys(childCheckpoints).length > 0 ? { childCheckpoints } : {}),
        };
        return [[sessionId, cleaned] as const];
      }),
    );
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

type BoundedTraceBatch = { content: string; events: unknown[] };

/**
 * Scrubs once, then partitions a trace in arrival order. A large event is
 * represented by a small explicit marker; later completion and diff events
 * still get a batch of their own instead of being lost with a longest-prefix
 * cut.
 */
function boundedTraceBatches(
  state: Pick<SessionState, "id" | "workspaceId" | "segment" | "resumed">,
  events: TraceEvent[],
  maxBytes = MAX_TRACE_BYTES,
): BoundedTraceBatch[] {
  // The trace is scrubbed as a JSON value, never as serialised text: a text
  // redaction inside an escaped string (`\n@app.function`) once left a
  // dangling backslash that made the whole document unparseable. Header and
  // events are scrubbed as the one document the backend scrubs, so a header
  // value naming an AWS key is container context for the events there too.
  const { events: scrubbed, ...header } = redactUploadJson({
    schema_version: 1,
    session_id: state.id,
    workspace_id: state.workspaceId,
    session_segment: state.segment,
    session_resumed: state.resumed,
    events,
  }, { fileAware: true }).value as Record<string, unknown> & { events: TraceEvent[] };
  const encode = (selected: unknown[], truncated: boolean, dropped: number): BoundedTraceBatch & { byteLength: number } => {
    const content = JSON.stringify({
    ...header,
    trace_truncated: truncated,
    dropped_event_count: dropped,
    events: selected,
    });
    return { content, events: selected, byteLength: Buffer.byteLength(content) };
  };
  const eventTexts = scrubbed.map((event) => JSON.stringify(event));
  const wrapperBytes = (truncated: boolean, dropped: number): number => encode([], truncated, dropped).byteLength;
  const batches: BoundedTraceBatch[] = [];
  let selected: unknown[] = [];
  let selectedBytes = 0;
  let dropped = 0;
  const flush = (): void => {
    if (selected.length === 0) return;
    const payload = encode(selected, dropped > 0, dropped);
    batches.push({ content: payload.content, events: payload.events });
    selected = [];
    selectedBytes = 0;
  };
  for (let index = 0; index < scrubbed.length; index += 1) {
    const event = scrubbed[index];
    const text = eventTexts[index] ?? "null";
    const eventBytes = Buffer.byteLength(text);
    const commaBytes = selected.length > 0 ? 1 : 0;
    if (wrapperBytes(dropped > 0, dropped) + selectedBytes + commaBytes + eventBytes <= maxBytes) {
      selected.push(event);
      selectedBytes += commaBytes + eventBytes;
      continue;
    }
    flush();
    if (wrapperBytes(dropped > 0, dropped) + eventBytes <= maxBytes) {
      selected.push(event);
      selectedBytes = eventBytes;
      continue;
    }
    dropped += 1;
    const marker: TraceEvent = {
      at: new Date().toISOString(),
      type: "trace.truncated",
      data: { dropped_event_count: 1, reason: "oversize_single_event" },
    };
    const markerText = JSON.stringify(marker);
    if (wrapperBytes(true, dropped) + Buffer.byteLength(markerText) <= maxBytes) {
      if (wrapperBytes(true, dropped) + selectedBytes + (selected.length > 0 ? 1 : 0) + Buffer.byteLength(markerText) > maxBytes) flush();
      selected.push(marker);
      selectedBytes += (selected.length > 1 ? 1 : 0) + Buffer.byteLength(markerText);
    }
  }
  flush();
  return batches;
}

/** Eligible files plus the number of non-ignored paths the denylist dropped. */
type WorkspaceListing = {
  paths: string[];
  denied: number;
  truncated: boolean;
  /** excluded-files.ts: the denied paths (a denied folder as `dir/`) and those past the listing cap, up to MAX_LISTED_EXCLUSIONS each. */
  deniedPaths?: string[];
  overflowPaths?: string[];
};
const MAX_LISTED_EXCLUSIONS = 5_000;
const MAX_RAW_LISTING_FILES = MAX_FILES * 4;

async function walkFallback(
  root: string,
  directory = root,
  rules: string[] = [],
  listing: WorkspaceListing = { paths: [], denied: 0, truncated: false },
  priorityPaths: ReadonlySet<string> = new Set(),
): Promise<WorkspaceListing> {
  const ignoreRules = [...rules, ...scopedIgnoreRules(portablePath(root, directory), await readGitignoreFile(directory))];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return listing;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    const path = portablePath(root, fullPath);
    if (!path || ignoredByRules(path, ignoreRules)) continue;
    const uploadPath = portablePathForUpload(path);
    const priorityBelow = [...priorityPaths].some((candidate) => candidate === uploadPath || candidate.startsWith(`${uploadPath}/`));
    if (listing.paths.length >= MAX_RAW_LISTING_FILES && !priorityBelow && !priorityPaths.has(uploadPath)) {
      listing.truncated = true;
      continue;
    }
    if (entry.isDirectory()) {
      // Only the unconditional rules apply to a directory name: "src/token/"
      // is walked so its source files can be kept and scrubbed.
      if (hasDeniedComponent(pathComponents(path))) {
        listing.denied += 1;
        if ((listing.deniedPaths ??= []).length < MAX_LISTED_EXCLUSIONS) listing.deniedPaths.push(`${path}/`);
      } else await walkFallback(root, fullPath, ignoreRules, listing, priorityPaths);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // Capture v2: a symlink is listed too (never followed; the scan records its target).
      if (isUploadPathDenied(path)) {
        listing.denied += 1;
        if ((listing.deniedPaths ??= []).length < MAX_LISTED_EXCLUSIONS) listing.deniedPaths.push(path);
      } else listing.paths.push(path);
    }
  }
  return listing;
}

function filterListing(candidates: string[], priorityPaths: ReadonlySet<string> = new Set(), limit = MAX_RAW_LISTING_FILES): WorkspaceListing {
  const eligible: string[] = [];
  const deniedPaths: string[] = [];
  let denied = 0;
  for (const path of candidates) {
    if (!path) continue;
    if (isUploadPathDenied(path)) {
      denied += 1;
      if (deniedPaths.length < MAX_LISTED_EXCLUSIONS) deniedPaths.push(path);
    } else eligible.push(path);
  }
  const prioritized = eligible.filter((path) => priorityPaths.has(portablePathForUpload(path)));
  const ordinary = eligible.filter((path) => !priorityPaths.has(portablePathForUpload(path)));
  const kept = Math.max(0, limit - prioritized.length);
  const paths = [...prioritized, ...ordinary.slice(0, kept)];
  const overflowPaths = ordinary.slice(kept, kept + MAX_LISTED_EXCLUSIONS);
  return { paths, denied, truncated: eligible.length > paths.length, deniedPaths, overflowPaths };
}

/** How deep repositories inside repositories are followed, and how many listed paths they may add. */
const MAX_NESTED_REPO_DEPTH = 4;
const MAX_NESTED_REPO_PATHS = MAX_RAW_LISTING_FILES;

async function gitListing(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });
  return Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
}

/** The `path = ...` values of a `.gitmodules` (a submodule's folder), or none. */
async function submodulePaths(dir: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(dir, ".gitmodules"), "utf8");
    return new Set([...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((match) => match[1]!.replace(/\/+$/, "")));
  } catch {
    return new Set();
  }
}

/**
 * Git lists a repository inside the work tree (a clone, a `git init` in a
 * subfolder) as one `dir/` entry and a submodule as its bare path, so their
 * files were in neither the snapshot nor excluded_files. Each is listed from
 * its own index instead (its own ignore rules apply; never its `.git`),
 * nested ones too, bounded in depth and count. A folder git cannot list is
 * left as it was.
 */
export async function expandNestedRepos(root: string, listed: string[], depth = 0, budget = { left: MAX_NESTED_REPO_PATHS }): Promise<string[]> {
  const submodules = await submodulePaths(root);
  const out: string[] = [];
  for (const path of listed) {
    const bare = path.replace(/\/+$/, "");
    const nested = path.endsWith("/") || submodules.has(bare);
    if (!nested || depth >= MAX_NESTED_REPO_DEPTH || budget.left <= 0) {
      out.push(path);
      continue;
    }
    const dir = join(root, ...bare.split("/"));
    let inner: string[];
    try {
      await lstat(join(dir, ".git"));
      if ((await lstat(dir)).isSymbolicLink()) throw new Error("symlink");
      inner = await gitListing(dir);
    } catch {
      out.push(path);
      continue;
    }
    inner = inner.slice(0, Math.max(0, budget.left));
    budget.left -= inner.length;
    for (const child of await expandNestedRepos(dir, inner, depth + 1, budget)) out.push(`${bare}/${child}`);
  }
  return out;
}

async function listWorkspaceFiles(root: string, priorityPaths: ReadonlySet<string> = new Set(), limit = MAX_FILES): Promise<WorkspaceListing> {
  try {
    if (await gitSkipReason()) throw new Error(XCODE_CLT_MISSING);
    return filterListing(await expandNestedRepos(root, await gitListing(root)), priorityPaths, limit);
  } catch {
    const raw = await walkFallback(root, root, [], { paths: [], denied: 0, truncated: false }, priorityPaths);
    const limited = filterListing(raw.paths, priorityPaths, limit);
    return { paths: limited.paths, denied: raw.denied, truncated: raw.truncated || limited.truncated, deniedPaths: raw.deniedPaths, overflowPaths: limited.overflowPaths };
  }
}

type GitRunResult = { stdout: Buffer; ok: boolean; truncated: boolean };

/**
 * Runs a read-only git command with a hard output cap and timeout. Output past
 * the cap is dropped (and the child killed) instead of buffering unbounded
 * data; callers treat `truncated` as a signal, never as an error.
 */
async function runGit(root: string, args: string[], options: { maxBytes: number; timeoutMs: number }): Promise<GitRunResult> {
  return (await gitSkipReason()) ? { stdout: Buffer.alloc(0), ok: false, truncated: false } : runGitNow(root, args, options);
}

function runGitNow(root: string, args: string[], options: { maxBytes: number; timeoutMs: number }): Promise<GitRunResult> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout: Buffer.concat(chunks), ok, truncated });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();
    try {
      // Capture v2: no inherited GIT_DIR/GIT_WORK_TREE (a server started from a git hook), no fsmonitor, and
      // the session's own root accepted when another user owns it (git's dubious-ownership refusal left
      // the git block empty while the agent's own git commands worked). See session-archive/repos.ts.
      child = spawn("git", ["-C", root, "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", `safe.directory=${resolve(root)}`, ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: { ...captureGitEnv(), GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES ?? "", LC_ALL: process.env.LC_ALL ?? "" },
      });
    } catch {
      finish(false);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = options.maxBytes - total;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(!timedOut && (truncated || code === 0)));
  });
}

async function gitText(root: string, args: string[], maxBytes = 64 * 1024, timeoutMs = 5_000): Promise<string | null> {
  const result = await runGit(root, args, { maxBytes, timeoutMs });
  if (!result.ok || result.truncated) return null;
  const text = result.stdout.toString("utf8").trim();
  return text || null;
}

async function gitHead(root: string): Promise<string | null> {
  return gitText(root, ["rev-parse", "--verify", "-q", "HEAD"]);
}

/**
 * Parses `git status --porcelain=v1 -z`. Porcelain paths are always relative
 * to the repository root, so when the workspace is a subdirectory (`prefix`,
 * as printed by `git rev-parse --show-prefix`) the prefix is stripped and any
 * entry outside it is dropped: nothing outside the workspace root may leave
 * the machine, and paths must match the workspace-relative manifest.
 */
function parseGitStatus(raw: string, prefix = ""): { entries: GitStatusEntry[]; dirty: boolean } {
  const entries: GitStatusEntry[] = [];
  let dirty = false;
  for (const record of raw.split("\0")) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const repoPath = record.slice(3);
    if (!repoPath) continue;
    if (prefix && !repoPath.startsWith(prefix)) continue;
    const path = repoPath.slice(prefix.length);
    if (!path) continue;
    if (code !== "??" && code !== "!!") dirty = true;
    if (isUploadPathDenied(path)) continue;
    if (entries.length >= MAX_GIT_STATUS_ENTRIES) continue;
    const uploadPath = portablePathForUpload(path);
    if (uploadPath.length > MAX_GIT_PATH_CHARS) continue;
    entries.push({ code, path: uploadPath });
  }
  return { entries, dirty };
}

function parseGitRemotes(raw: string): GitRemote[] {
  const remotes = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\t(.+?)(?:\s+\(((?:fetc|pus)h)\))?$/);
    if (!match?.[1] || !match[2]) continue;
    if (remotes.has(match[1]) && match[3] === "push") continue;
    remotes.set(match[1], match[2]);
  }
  return [...remotes.entries()]
    .slice(0, MAX_GIT_REMOTES)
    .map(([name, url]) => ({
      name: clampUploadText(portablePathForUpload(name), MAX_GIT_REMOTE_NAME_CHARS),
      url: clampUploadText(portablePathForUpload(stripRemoteUserinfo(url)), MAX_GIT_REMOTE_URL_CHARS),
    }));
}

function parseGitLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split("\0")) {
    const [sha, at, subject] = record.replace(/^\n/, "").split("\x1f");
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha) || !at) continue;
    commits.push({ sha, at, subject: clampUploadText(portablePathForUpload(subject ?? ""), MAX_GIT_SUBJECT_CHARS) });
    if (commits.length >= MAX_GIT_RECENT_COMMITS) break;
  }
  return commits;
}

/**
 * Decodes a C-style quoted git path (`"a/caf\303\251.txt"`), returning the
 * unquoted string and the index just past the closing quote, or null when the
 * quoting is malformed.
 */
function unquoteGitPath(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  const bytes: number[] = [];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') return { value: Buffer.from(bytes).toString("utf8"), end: index + 1 };
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) return null;
      const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
      if (simple[next] !== undefined) {
        bytes.push(simple[next]!);
        index += 2;
        continue;
      }
      const octal = text.slice(index + 1, index + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        index += 4;
        continue;
      }
      return null;
    }
    for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
    index += 1;
  }
  return null;
}

/** Extracts the b-side path from a `diff --git a/<p> b/<p>` header. */
export function diffHeaderPath(header: string): string | null {
  const prefix = "diff --git ";
  if (!header.startsWith(prefix)) return null;
  const rest = header.slice(prefix.length).replace(/\r$/, "");
  if (rest.startsWith('"')) {
    const quoted = unquoteGitPath(rest, 0);
    if (!quoted || !quoted.value.startsWith("a/")) return null;
    return quoted.value.slice(2);
  }
  if (!rest.startsWith("a/")) return null;
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length < 0) return null;
  const left = rest.slice(2, 2 + length);
  if (rest.slice(2 + length, 5 + length) !== " b/" || rest.slice(5 + length) !== left) return null;
  return left;
}

/**
 * Keeps only the diff sections that belong to eligible text files, redacts
 * them, and caps the result. Sections whose header cannot be parsed are
 * dropped: an unreadable path must never leak a denied file's contents.
 */
export function filterUploadDiff(raw: string, inputTruncated = false): { diff: string | null; truncated: boolean } {
  let output = "";
  let used = 0;
  let truncated = inputTruncated;
  for (const section of raw.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue;
    const headerEnd = section.indexOf("\n");
    const path = diffHeaderPath(headerEnd === -1 ? section : section.slice(0, headerEnd));
    if (!path || isUploadPathDenied(path)) continue;
    if (/^(?:Binary files .* differ|GIT binary patch)/m.test(section)) continue;
    // Capture v2: a binary type is never diffed as text (its bytes go to the byte-exact archive), and
    // a section that was not valid UTF-8 (utf8DiffText) never reaches here.
    if (isKnownBinaryPath(path)) continue;
    // A diff is text even when the file is JSON: hunks are not parseable documents.
    // Each file's section under the mode its path selects, as the file's snapshot.
    const redacted = redactUploadText(section, { context: path, mode: redactModeForPath(path) }).text;
    const size = Buffer.byteLength(redacted);
    if (used + size > MAX_UPLOAD_DIFF_BYTES) {
      truncated = true;
      if (used === 0) {
        output = Buffer.from(redacted).subarray(0, MAX_UPLOAD_DIFF_BYTES).toString("utf8").replace(/�+$/, "");
      }
      break;
    }
    output += redacted;
    used += size;
  }
  return { diff: output || null, truncated };
}

/**
 * Capture v2: git's diff output as text, without the file sections that are
 * not valid UTF-8. git diffs any file without a NUL in its first 8000 bytes
 * as text (a PDF, a latin-1 file); decoding those would replace their bytes
 * with U+FFFD, so they are dropped here (their bytes are in the byte-exact
 * archive). A truncated last section may end inside a character.
 */
export function utf8DiffText(raw: Buffer): string {
  if (isUtf8(raw)) return raw.toString("utf8");
  const marker = Buffer.from("\ndiff --git ");
  const sections: Buffer[] = [];
  let start = 0;
  for (;;) {
    const next = raw.indexOf(marker, start);
    const end = next === -1 ? raw.length : next + 1;
    sections.push(raw.subarray(start, end));
    if (next === -1) break;
    start = end;
  }
  return sections.filter((section, index) => isUtf8(section) || (index === sections.length - 1 && binaryReason(null, section, true) === null))
    .map((section) => section.toString("utf8")).join("");
}

/**
 * Combined staged + unstaged text diff of the workspace. `--relative` with the
 * `.` pathspec limits the diff to the workspace subtree and makes every header
 * path workspace-relative, so a workspace that is a subdirectory of a larger
 * repository (a monorepo package, a project under a home-directory dotfiles
 * repo) never ships changes from outside its own root.
 */
async function gitDiff(root: string, hasHead: boolean): Promise<{ diff: string | null; truncated: boolean }> {
  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];
  const scope = ["--", "."];
  const options = { maxBytes: GIT_DIFF_READ_BYTES, timeoutMs: 20_000 };
  if (hasHead) {
    const result = await runGit(root, ["diff", "HEAD", ...common, ...scope], options);
    if (result.ok) return filterUploadDiff(utf8DiffText(result.stdout), result.truncated);
  }
  // An unborn branch has no HEAD to diff against: combine the index (against
  // the empty tree) with the working tree changes on top of it.
  const [staged, unstaged] = await Promise.all([
    runGit(root, ["diff", "--cached", ...common, ...scope], options),
    runGit(root, ["diff", ...common, ...scope], options),
  ]);
  if (!staged.ok && !unstaged.ok) return { diff: null, truncated: false };
  const text = `${staged.ok ? utf8DiffText(staged.stdout) : ""}${unstaged.ok ? utf8DiffText(unstaged.stdout) : ""}`;
  return filterUploadDiff(text, staged.truncated || unstaged.truncated);
}

/**
 * Builds the safe git summary of a workspace with the git CLI only. Nothing is
 * read from `.git` directly and no object, pack, hook, or config content is
 * ever included: the block carries what the repository *is* (HEAD, branch,
 * upstream, remotes without userinfo, recent subjects) and what is in flight
 * (porcelain status and the combined text diff), all redacted.
 */
export async function collectGitBlock(root: string): Promise<UploadGitBlock | null> {
  // 20 s, not 5: under load (a full scan hashing the tree) rev-parse timed out and the block was dropped.
  const inside = await gitText(root, ["rev-parse", "--is-inside-work-tree"], 64 * 1024, 20_000);
  if (inside !== "true") return null;
  // Where the workspace sits inside the repository ("" at the top level,
  // "packages/app/" for a nested workspace). Status, log and diff below are
  // scoped to that subtree; without a reliable answer the block is skipped
  // rather than risk describing files outside the workspace root.
  const prefixResult = await runGit(root, ["rev-parse", "--show-prefix"], { maxBytes: 64 * 1024, timeoutMs: 20_000 });
  if (!prefixResult.ok || prefixResult.truncated) return null;
  const prefix = prefixResult.stdout.toString("utf8").trim().replaceAll("\\", "/");
  const scope = prefix ? ["--", "."] : [];
  const [commit, branch, upstream, status, remotes, log] = await Promise.all([
    gitHead(root),
    gitText(root, ["branch", "--show-current"]),
    gitText(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    runGit(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--", "."], { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
    gitText(root, ["remote", "-v"]),
    runGit(root, ["log", `--max-count=${MAX_GIT_RECENT_COMMITS}`, "--no-color", "-z", "--format=%H%x1f%cI%x1f%s", ...scope], { maxBytes: 256 * 1024, timeoutMs: 5_000 }),
  ]);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = await gitText(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const match = counts?.match(/^(\d+)\s+(\d+)$/);
    if (match) {
      ahead = Number.parseInt(match[1]!, 10);
      behind = Number.parseInt(match[2]!, 10);
    }
  }
  const parsedStatus = status.ok ? parseGitStatus(status.stdout.toString("utf8"), prefix) : { entries: [], dirty: false };
  const diff = await gitDiff(root, Boolean(commit));
  return {
    commit,
    branch: branch ? clampUploadText(portablePathForUpload(branch), MAX_GIT_REF_CHARS) : null,
    dirty: parsedStatus.dirty,
    upstream: upstream ? clampUploadText(portablePathForUpload(upstream), MAX_GIT_REF_CHARS) : null,
    ahead,
    behind,
    remotes: remotes ? parseGitRemotes(remotes) : [],
    recent_commits: log.ok ? parseGitLog(log.stdout.toString("utf8")) : [],
    status: parsedStatus.entries,
    diff: diff.diff,
    diff_truncated: diff.truncated,
  };
}

/** Cheap pre-scan git evidence used before the listing/file-count cap. */
async function gitPriorityPaths(root: string): Promise<Set<string>> {
  if (await gitText(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return new Set();
  const prefixResult = await runGit(root, ["rev-parse", "--show-prefix"], { maxBytes: 64 * 1024, timeoutMs: 5_000 });
  if (!prefixResult.ok || prefixResult.truncated) return new Set();
  const prefix = prefixResult.stdout.toString("utf8").trim().replaceAll("\\", "/");
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--", "."], {
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 15_000,
  });
  if (!status.ok) return new Set();
  return new Set(parseGitStatus(status.stdout.toString("utf8"), prefix).entries.map((entry) => entry.path));
}

/**
 * Folders whose content is reinstalled or rebuilt from the lockfiles (the
 * reproducible-task rule's "not needed"): a touched or locked path in one is
 * never archived for being ignored, and an ignored output in one is never an
 * artifact.
 */
export const REGENERABLE_DIR_NAMES = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "dist", "build", "target", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
  ".gradle", ".dart_tool", "Pods", "DerivedData", "vendor", "bower_components", "site-packages",
]);

/** Whether a workspace-relative portable path lies in a regenerable folder (or is `.git/` content). */
export function inRegenerableDir(path: string): boolean {
  const parts = path.split("/");
  return parts.slice(0, -1).some((part) => part === ".git" || REGENERABLE_DIR_NAMES.has(part));
}

/**
 * Files inside the workspace that git does not track but does not ignore
 * either: the outputs an agent leaves next to the source. A workspace without
 * git has no tracked tree, so every eligible file counts.
 */
async function listUntrackedFiles(root: string): Promise<string[]> {
  try {
    if (await gitSkipReason()) throw new Error(XCODE_CLT_MISSING);
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    });
    return filterListing(Buffer.from(stdout).toString("utf8").split("\0")).paths;
  } catch {
    return (await walkFallback(root)).paths;
  }
}

const MAX_IGNORED_OUTPUT_FILES = 5_000;

/**
 * The gitignored untracked files outside the regenerable folders (a build's
 * `outputs/plot.png`, a downloaded `data.pdf`): `git ls-files --ignored
 * --directory` names a wholly ignored folder once, and only the folders that
 * are not regenerable are listed further. Empty outside a git work tree
 * (walkFallback already lists every file there) or when git fails.
 */
async function listIgnoredOutputFiles(root: string): Promise<string[]> {
  const listed = async (args: string[]): Promise<string[]> => {
    if (await gitSkipReason()) throw new Error(XCODE_CLT_MISSING);
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", ...args], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    });
    return Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
  };
  try {
    const paths: string[] = [];
    for (const path of await listed(["--directory"])) {
      if (paths.length >= MAX_IGNORED_OUTPUT_FILES) break;
      if (!path.endsWith("/")) {
        if (!inRegenerableDir(path)) paths.push(path);
        continue;
      }
      const dir = path.slice(0, -1);
      if (inRegenerableDir(`${dir}/x`)) continue;
      for (const inner of await listed(["--", dir])) {
        if (paths.length >= MAX_IGNORED_OUTPUT_FILES) break;
        if (!inRegenerableDir(inner)) paths.push(inner);
      }
    }
    return filterListing(paths).paths;
  } catch {
    return [];
  }
}

async function artifactStats(root: string): Promise<Map<string, ArtifactStat>> {
  const stats = new Map<string, ArtifactStat>();
  for (const path of [...(await listUntrackedFiles(root)), ...(await listIgnoredOutputFiles(root))]) {
    try {
      if (workspaceRelativePath(root, path) === null) continue;
      const absolute = resolve(root, path);
      const file = await lstat(absolute);
      if (!file.isFile() || file.isSymbolicLink()) continue;
      stats.set(path, fileSignature(file));
    } catch {
      // Live workspace: a listed file can vanish before it is inspected.
    }
  }
  return stats;
}

async function sha256File(absolute: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

// --- scanning ----------------------------------------------------------------

/** Lets the event loop run once a stretch of synchronous scan work has gone on long enough. */
class LoopYielder {
  private last = performance.now();

  async pause(): Promise<void> {
    if (performance.now() - this.last < EVENT_LOOP_YIELD_MS) return;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    this.last = performance.now();
  }
}

/**
 * Reads a whole file into a pooled buffer, so a scan recycles a few buffers
 * instead of allocating and freeing one per file (which leaves the allocator
 * holding hundreds of megabytes of freed pages). A pool lives for one scan or
 * upload pass and is garbage afterwards, so nothing stays allocated between
 * captures. The view handed to `use` is valid until the same slot is used
 * again, so nothing of it may outlive the call except through `toString` or
 * hashing. Null when the file is larger than the cap.
 */
class ReadPool {
  private readonly free: Buffer[] = [];
  private readonly waiters: Array<(buffer: Buffer) => void> = [];
  private allocated = 0;
  /** One buffer at the file cap for the rare file larger than a slot; such reads take turns. */
  private large: Buffer | null = null;
  private largeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly slots: number, private readonly capacity = READ_SLOT_BYTES) {}

  private acquire(): Promise<Buffer> {
    const buffer = this.free.pop();
    if (buffer) return Promise.resolve(buffer);
    if (this.allocated < this.slots) {
      this.allocated += 1;
      return Promise.resolve(Buffer.allocUnsafeSlow(this.capacity));
    }
    return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
  }

  private release(buffer: Buffer): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(buffer);
    else this.free.push(buffer);
  }

  /** Runs `use` with the file's bytes; the view must not escape `use`. */
  async read<T>(absolute: string, expectedSize: number, use: (bytes: Buffer) => Promise<T> | T): Promise<T | null> {
    if (expectedSize > MAX_UPLOAD_FILE_BYTES) return null;
    if (expectedSize < this.capacity) {
      const buffer = await this.acquire();
      try {
        const length = await readInto(absolute, buffer);
        if (length < buffer.length) return await use(buffer.subarray(0, length));
      } finally {
        this.release(buffer);
      }
      // The file grew past its slot since the stat: read it with the large buffer.
    }
    return this.readLarge(absolute, use);
  }

  private readLarge<T>(absolute: string, use: (bytes: Buffer) => Promise<T> | T): Promise<T | null> {
    const run = this.largeTail.then(async () => {
      this.large ??= Buffer.allocUnsafeSlow(MAX_UPLOAD_FILE_BYTES + 1);
      const length = await readInto(absolute, this.large);
      // Past the cap by now: not a file the session uploader takes.
      return length > MAX_UPLOAD_FILE_BYTES ? null : await use(this.large.subarray(0, length));
    });
    this.largeTail = run.catch(() => undefined);
    return run;
  }
}

/**
 * The redacted text of files the scrubber changed, by absolute path, least
 * recently used first out once the budget is spent. An entry is used only
 * for the exact bytes it was made from (their digest) and only while the
 * per-root cache still describes the file with the same redacted digest, so
 * it never changes what is sent: it spares the regex pipeline when the same
 * bytes are uploaded again (a new chat on a workspace another chat already
 * captured). Clean files are not kept: their upload form is the file itself.
 */
class RedactedTextCache {
  private readonly entries = new Map<string, { raw: string; sha256: string; text: string; bytes: number }>();
  private used = 0;

  constructor(private readonly budget: number) {}

  get size(): number {
    return this.entries.size;
  }

  remember(absolute: string, raw: string, entry: HashCacheEntry, text: string): void {
    this.forget(absolute);
    // One file may take at most an eighth of the budget, so a few large files never flush the rest.
    if (entry.bytes > this.budget / 8) return;
    this.entries.set(absolute, { raw, sha256: entry.sha256, text, bytes: entry.bytes });
    this.used += entry.bytes;
    for (const [key, held] of this.entries) {
      if (this.used <= this.budget) break;
      this.entries.delete(key);
      this.used -= held.bytes;
    }
  }

  /** The redacted text of `raw` (the digest of the bytes just read) when it redacts to `sha256`. */
  lookup(absolute: string, raw: string, sha256: string): string | null {
    const held = this.entries.get(absolute);
    if (!held || held.raw !== raw || held.sha256 !== sha256) return null;
    this.entries.delete(absolute);
    this.entries.set(absolute, held);
    return held.text;
  }

  forget(absolute: string): void {
    const held = this.entries.get(absolute);
    if (!held) return;
    this.entries.delete(absolute);
    this.used -= held.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }
}

/** Reads a file from the start into `buffer`, up to its length; resolves with the bytes read. */
async function readInto(absolute: string, buffer: Buffer): Promise<number> {
  const handle = await open(absolute, "r");
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return length;
}

/**
 * Runs `operation` over `items` with at most `limit` calls in flight and
 * returns the results in item order, so a 50,000-file scan holds a handful of
 * descriptors instead of a burst of them.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

type AdmissionWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
};

/** One bounded pool shared by scans and uploads from every active session. */
class CaptureAdmission {
  private active = 0;
  private readonly waiters: AdmissionWaiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolvePromise, reject) => {
      const waiter: AdmissionWaiter = {
        resolve: (release) => resolvePromise(release),
        reject,
        signal,
        onAbort: undefined,
      };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.active += 1;
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.releaseOnce());
    }
  }
}

const GLOBAL_CAPTURE_ADMISSION = new CaptureAdmission(4);

/** Work counters for tests and profiling; never uploaded. */
export type UploadMetrics = {
  fileStats: number;
  fileReads: number;
  fileRedactions: number;
  fullScans: number;
  dirtyScans: number;
  reconciles: number;
  capturesSkipped: number;
  capturesDeferred: number;
  /** Filesystem and periodic captures left to another session on the same root (its turn made the edits). */
  capturesHeld: number;
  ignoreCheckSpawns: number;
  watchEvents: number;
  envelopesWritten: number;
  /** Upload reads served from the redacted-text cache instead of the scrubber. */
  redactedTextHits: number;
};

function freshMetrics(): UploadMetrics {
  return {
    fileStats: 0, fileReads: 0, fileRedactions: 0, fullScans: 0, dirtyScans: 0, reconciles: 0,
    capturesSkipped: 0, capturesDeferred: 0, capturesHeld: 0, ignoreCheckSpawns: 0, watchEvents: 0, envelopesWritten: 0, redactedTextHits: 0,
  };
}

/**
 * Redacts one file's bytes and describes the result for the cache and the
 * manifest. A text the scrubber changed goes into `texts` (when given) under
 * the digest of the bytes it came from.
 */
function redactedCacheEntry(
  path: string,
  buffer: Buffer,
  signature: FileSignature,
  uploadPath: string,
  metrics: UploadMetrics,
  texts?: { cache: RedactedTextCache; absolute: string },
): { entry: HashCacheEntry; text: string } {
  const redacted = redactUploadContentCounted(path, buffer.toString("utf8"));
  metrics.fileRedactions += 1;
  const entry: HashCacheEntry = {
    ...signature,
    binary: false,
    sha256: sha256Hex(redacted.text),
    bytes: Buffer.byteLength(redacted.text),
    json: Buffer.byteLength(JSON.stringify(redacted.text)),
    clean: redacted.count === 0,
    uploadPath,
  };
  if (texts) {
    if (entry.clean) texts.cache.forget(texts.absolute);
    else texts.cache.remember(texts.absolute, sha256Hex(buffer), entry, redacted.text);
  }
  return { text: redacted.text, entry };
}

/** The redacted upload path, sharing the listing's string when redaction left it unchanged. */
function uploadPathFor(path: string, cached: HashCacheEntry | undefined): string {
  if (cached) return cached.uploadPath;
  const uploadPath = portablePathForUpload(path);
  return uploadPath === path ? path : uploadPath;
}

/** Per-pass answers of hasRealAncestors, by workspace-relative directory. */
type AncestorCache = Map<string, Promise<boolean>>;

/**
 * Whether no directory between the root and `path` is a symlink (or a Windows
 * junction, which lstat reports as one). A path reached through one
 * (`linked/util.ts` with `linked -> ../shared-lib`) names a file outside the
 * workspace, which git's listing never holds and nothing may upload; checking
 * only the last component, or the resolved path as a string, lets it through.
 * A missing ancestor passes: the file cannot exist either, which the caller's
 * own lstat reports. `seen` shares the answer per directory for one pass.
 */
async function hasRealAncestors(root: string, path: string, seen: AncestorCache = new Map()): Promise<boolean> {
  const parts = pathComponents(path);
  let directory = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    directory = directory ? `${directory}/${parts[index]}` : parts[index]!;
    let real = seen.get(directory);
    if (!real) {
      real = lstat(resolve(root, directory)).then((entry) => !entry.isSymbolicLink(), () => true);
      seen.set(directory, real);
    }
    if (!(await real)) return false;
  }
  return true;
}

/** What one scan pass shares across the files it inspects. */
type ScanContext = {
  root: string;
  /** The resolved root with a trailing separator: every file inspected must start with it. */
  sessionSubdir: string;
  cache: Map<string, HashCacheEntry>;
  texts: RedactedTextCache;
  metrics: UploadMetrics;
  yielder: LoopYielder;
  pool: ReadPool;
  ancestors: AncestorCache;
  /** Capture v2: the binary files and symlinks the scan met, by path. */
  extras: Map<string, ExtraManifestEntry>;
};

/**
 * Concurrent sessions still stat independently, but identical path signatures
 * share the expensive read, scrub and digest pass. Entries leave this map as
 * soon as the pass settles, so it is not a stale cache or TTL.
 */
const FILE_SCAN_IN_FLIGHT = new Map<string, Promise<HashCacheEntry | null>>();

/** Bound metadata retained by long sessions that create and delete many paths. */
class FileHashCache extends Map<string, HashCacheEntry> {
  override set(path: string, entry: HashCacheEntry): this {
    if (!this.has(path) && this.size >= MAX_FILES) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(path, entry);
  }
}

function scanContext(root: string, cache: Map<string, HashCacheEntry>, texts: RedactedTextCache, metrics: UploadMetrics): ScanContext {
  const base = resolve(root);
  return {
    root,
    sessionSubdir: base.endsWith(sep) ? base : `${base}${sep}`,
    cache,
    texts,
    metrics,
    yielder: new LoopYielder(),
    pool: new ReadPool(SCAN_CONCURRENCY),
    ancestors: new Map(),
    extras: new Map(),
  };
}

/**
 * Stats one eligible path and, unless the per-root cache already knows the
 * file at this robust signature, reads, redacts and hashes it. Null for anything
 * that is not a regular file within the size cap (gone, a directory, a
 * symlink, too large) or that resolves outside the root, lexically or through
 * a symlinked directory; a binary file comes back as its binary entry. Content
 * is never kept: the upload pass re-reads what it sends.
 */
async function inspectFile(context: ScanContext, path: string): Promise<HashCacheEntry | null> {
  const { cache, metrics, pool } = context;
  const absolute = resolve(context.root, path);
  if (!absolute.startsWith(context.sessionSubdir) || !(await hasRealAncestors(context.root, path, context.ancestors))) return null;
  let file;
  try {
    file = await lstat(absolute);
  } catch {
    return null;
  }
  metrics.fileStats += 1;
  if (file.isSymbolicLink()) {
    // Capture v2: a symlink is listed with its target, also a broken one; never followed.
    const link = await symlinkExtra(absolute, uploadPathFor(path, undefined), file.mode);
    if (link) context.extras.set(path, link);
    return null;
  }
  if (!file.isFile() || file.size > MAX_UPLOAD_FILE_BYTES) return null;
  const cached = cache.get(path);
  const signature = fileSignature(file);
  if (cached && sameFileSignature(cached, signature)) {
    if (cached.binary) context.extras.set(path, binaryExtra(cached));
    return cached;
  }
  const scanKey = [
    resolve(context.root),
    path,
    signature.size,
    signature.mtimeMs,
    signature.ctimeMs,
    signature.ino,
    signature.dev,
  ].join("\0");
  const existing = FILE_SCAN_IN_FLIGHT.get(scanKey);
  if (existing) {
    const entry = await existing;
    if (entry) cache.set(path, entry);
    await context.yielder.pause();
    return entry;
  }
  const uploadPath = uploadPathFor(path, cached);
  const mode = file.mode & 0o7777;
  const inFlight = pool.read(absolute, file.size, (buffer): HashCacheEntry => {
    metrics.fileReads += 1;
    // Capture v2: a known binary type or signature is binary too (a PDF that is all ASCII); its raw digest is kept.
    if (binaryReason(path, buffer) !== null) {
      return { ...signature, binary: true, sha256: sha256Hex(buffer), bytes: buffer.length, json: 0, clean: false, uploadPath, mode };
    }
    return { ...redactedCacheEntry(path, buffer, signature, uploadPath, metrics, { cache: context.texts, absolute }).entry, mode };
  }).catch(() => null);
  FILE_SCAN_IN_FLIGHT.set(scanKey, inFlight);
  try {
    const entry = await inFlight;
    if (entry) cache.set(path, entry);
    if (entry?.binary) context.extras.set(path, binaryExtra(entry));
    await context.yielder.pause();
    return entry;
  } finally {
    if (FILE_SCAN_IN_FLIGHT.get(scanKey) === inFlight) FILE_SCAN_IN_FLIGHT.delete(scanKey);
  }
}

/** Capture v2: the manifest entry of a binary file the scan read (its raw digest, size and mode). */
function binaryExtra(entry: HashCacheEntry): ExtraManifestEntry {
  return { uploadPath: entry.uploadPath, kind: "binary", sha256: entry.sha256, size: entry.bytes, mode: entry.mode ?? 0o644 };
}

/** Capture v2: the manifest entry of a symlink (its target as written, also when it is broken), or null when unreadable. */
async function symlinkExtra(absolute: string, uploadPath: string, mode: number): Promise<ExtraManifestEntry | null> {
  let target: string;
  try {
    target = await readlink(absolute);
  } catch {
    return null;
  }
  let broken = false;
  try {
    await stat(absolute);
  } catch {
    broken = true;
  }
  const clamped = clampUploadText(redactUploadText(target).text, 4_096);
  return { uploadPath, kind: "symlink", sha256: sha256Hex(Buffer.from(clamped, "utf8")), size: Buffer.byteLength(clamped), mode: mode & 0o7777, target: clamped, broken };
}

/** One manifest line of a binary file or symlink. */
function extraEntryJson(entry: ExtraManifestEntry): string {
  const head = `{"path":${JSON.stringify(entry.uploadPath)},"sha256":"${entry.sha256}","size":${entry.size},"mode":${entry.mode}`;
  if (entry.kind === "symlink") return `${head},"type":"symlink","target":${JSON.stringify(entry.target ?? "")},"broken":${entry.broken === true}}`;
  return `${head},"binary":true,"archived":"byte_exact"}`;
}


/** One file as files[] carries it, re-read at upload time. */
type UploadContent = { content: string; entry: HashCacheEntry };

/**
 * Reads a file for files[]. A file the scan saw unchanged by redaction is sent
 * as read once its raw bytes hash to the cached digest, which skips the regex
 * pipeline; so is a file the scrubber touched whose redacted text for these
 * exact bytes is still in `texts`. Anything else (changed since the scan, or
 * no longer held) is redacted again, and the cache learns the result when it
 * differs.
 */
async function readUploadContent(
  root: string,
  path: string,
  cache: Map<string, HashCacheEntry>,
  texts: RedactedTextCache,
  metrics: UploadMetrics,
  pool: ReadPool,
  ancestors: AncestorCache,
): Promise<UploadContent | null> {
  const absolute = resolve(root, path);
  // A directory swapped for a symlink since the scan must not be followed either.
  if (workspaceRelativePath(root, path) === null || !(await hasRealAncestors(root, path, ancestors))) return null;
  let file;
  try {
    file = await lstat(absolute);
  } catch {
    return null;
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_UPLOAD_FILE_BYTES) return null;
  const signature = fileSignature(file);
  const cached = cache.get(path);
  try {
    return await pool.read(absolute, file.size, (buffer): UploadContent | null => {
      metrics.fileReads += 1;
      if (cached && !cached.binary && sameFileSignature(cached, signature)) {
        if (cached.clean) {
          if (cached.bytes === buffer.length && sha256Hex(buffer) === cached.sha256) return { content: buffer.toString("utf8"), entry: cached };
        } else if (texts.size > 0) {
          const text = texts.lookup(absolute, sha256Hex(buffer), cached.sha256);
          if (text !== null) {
            metrics.redactedTextHits += 1;
            return { content: text, entry: cached };
          }
        }
      }
      if (binaryReason(path, buffer) !== null) return null;
      const { entry, text } = redactedCacheEntry(path, buffer, signature, uploadPathFor(path, cached), metrics, { cache: texts, absolute });
      // The same digest keeps the cached entry, which the manifest may share.
      if (cached && cached.sha256 === entry.sha256 && sameFileSignature(cached, signature)) {
        return { content: text, entry: cached };
      }
      cache.set(path, entry);
      return { content: text, entry };
    });
  } catch {
    return null;
  }
}

/**
 * Eligible text files by workspace path, in listing order. Entries are the
 * per-root cache's own (immutable) objects: path (redacted) as `uploadPath`,
 * redacted digest as `sha256`, redacted size as `bytes`.
 */
type Manifest = Map<string, HashCacheEntry>;

type ScanResult = {
  /** Every eligible file: the manifest, and the next baseline once accepted. */
  manifest: Manifest;
  /** Paths whose digest differs from the previous manifest; null when every manifest entry counts (a start snapshot). */
  changed: Set<string> | null;
  /** Previous manifest entries no longer present. */
  removed: number;
  deniedCount: number;
  manifestTruncated: boolean;
  /** excluded-files.ts (full scans): denied, binary, oversized and capped paths (sizes by path). */
  deniedPaths?: string[];
  binaryPaths?: Map<string, number>;
  tooLargePaths?: Map<string, number>;
  cappedPaths?: string[];
  /** Capture v2: binary files and symlinks found; `extrasScope` says whether that is all of them (a full scan) or the inspected paths only. */
  extras: Map<string, ExtraManifestEntry>;
  extrasScope: "full" | ReadonlySet<string>;
};

/** A changed file competing for the snapshot's content budget. */
type SnapshotCandidate = {
  path: string;
  uploadPath: string;
  /** Redacted bytes: the sort key, and what a cap omission reports. */
  bytes: number;
  /** Serialised files[] cost: overhead, path and JSON-encoded content. */
  cost: number;
  /** Lower ranks are more relevant and survive caps first. */
  relevance: number;
};

/**
 * The workspace as a turn began, by path: null for a file the session uploader only
 * ever saw once the turn had written it (it was there, but what it held
 * before the turn is unknown).
 */
type TurnBaseline = ReadonlyMap<string, HashCacheEntry | null>;

/**
 * A file whose digest moved over a turn: null where it is not in that
 * manifest; `unseen` when it was there before the turn, in a form never seen.
 */
type TurnChange = { path: string; before: HashCacheEntry | null; after: HashCacheEntry | null; unseen: boolean };

/** Whether a file last modified at `mtimeMs` was written at or after `since` (and not in the future). */
function writtenSince(mtimeMs: number, since: number, now = Date.now()): boolean {
  return mtimeMs >= since && mtimeMs <= now + TURN_CLOCK_SLACK_MS;
}

/**
 * `manifest` as the workspace stood when the turn prompted at `since` began.
 * A file written since then (the agent's edit, landing while an earlier
 * upload held the queue and this snapshot waited) gives way to what
 * `earlier` (newest first) last knew of it from before: its entry there, its
 * absence (a file the turn created), or null when every one saw it only once
 * written, so the edit stays in the turn.
 */
function turnBaseline(
  manifest: Manifest,
  since: number | null,
  earlier: ReadonlyArray<TurnBaseline | null>,
  forcePaths: ReadonlySet<string> = new Set(),
): TurnBaseline {
  if (since === null) return manifest;
  const now = Date.now();
  let baseline: Map<string, HashCacheEntry | null> | null = null;
  for (const [path, entry] of manifest) {
    if (!forcePaths.has(path) && !writtenSince(entry.mtimeMs, since, now) && !writtenSince(entry.ctimeMs, since, now)) continue;
    baseline ??= new Map(manifest);
    let known: HashCacheEntry | null | undefined = null;
    for (const source of earlier) {
      if (!source) continue;
      const seen = source.get(path);
      if (seen === null || (seen && (writtenSince(seen.mtimeMs, since, now) || writtenSince(seen.ctimeMs, since, now)))) continue;
      known = seen;
      break;
    }
    if (known === undefined) baseline.delete(path);
    else baseline.set(path, known);
  }
  return baseline ?? manifest;
}

/**
 * Whether the file `file` describes is a write of the current turn's (a
 * traced read or an attachment journals a path too): written since the
 * turn's prompt, or, before any prompt, moved since the cache last saw it.
 */
function writtenThisTurn(turnStartedAt: number | null, cached: HashCacheEntry | undefined, file: FileSignature): boolean {
  if (cached && !sameFileSignature(cached, file)) return true;
  if (turnStartedAt !== null) return writtenSince(file.mtimeMs, turnStartedAt);
  return cached !== undefined && !sameFileSignature(cached, file);
}

/** Whether the first 8 KiB of a file read as binary (false when it cannot be read). */
async function startsBinary(absolute: string): Promise<boolean> {
  const head = Buffer.alloc(8_192);
  try {
    const read = await readInto(absolute, head);
    return binaryReason(absolute, head.subarray(0, read), read === head.length) !== null;
  } catch {
    return false;
  }
}

/** The manifest entry as the envelope carries it: path (redacted), sha256, size. */
function manifestEntryJson(entry: HashCacheEntry | ExtraManifestEntry): string {
  if ("kind" in entry) return extraEntryJson(entry);
  return `{"path":${JSON.stringify(entry.uploadPath)},"sha256":"${entry.sha256}","size":${entry.bytes}${entry.mode !== undefined ? `,"mode":${entry.mode}` : ""}}`;
}

function candidateCost(entry: HashCacheEntry): number {
  return SNAPSHOT_FILE_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(entry.uploadPath) + entry.json;
}

/** The changed entries of a manifest as candidates, in manifest order. */
const GENERATED_PATH_PATTERN = /(^|\/)(?:dist|build|out|coverage|\.next|\.cache|target)(?:\/|$)|(?:\.min|\.map)$/i;
const ASSOCIATED_PATH_PATTERN = /(^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)|\.(?:test|spec)\.[^.]+$|(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^/]+)?\.json|vitest\.config\.[^.]+|jest\.config\.[^.]+|webpack\.config\.[^.]+|vite\.config\.[^.]+|manifest\.[^.]+)$/i;

function relevanceForPath(path: string, toolRelevance: ReadonlyMap<string, number>, gitPaths: ReadonlySet<string>): number {
  const portable = portablePathForUpload(path);
  const tool = toolRelevance.get(path) ?? toolRelevance.get(portable);
  if (tool !== undefined) return tool;
  if (ASSOCIATED_PATH_PATTERN.test(portable)) return 2;
  if (gitPaths.has(portable)) return 3;
  if (GENERATED_PATH_PATTERN.test(portable)) return 5;
  return 4;
}

function candidatesFor(scan: ScanResult, toolRelevance: ReadonlyMap<string, number>, gitPaths: ReadonlySet<string>): SnapshotCandidate[] {
  const candidates: SnapshotCandidate[] = [];
  for (const [path, entry] of scan.manifest) {
    if (scan.changed && !scan.changed.has(path)) continue;
    candidates.push({
      path,
      uploadPath: entry.uploadPath,
      bytes: entry.bytes,
      cost: candidateCost(entry),
      relevance: relevanceForPath(path, toolRelevance, gitPaths),
    });
  }
  return candidates;
}

function countRemoved(previous: Manifest | null, manifest: Manifest): number {
  let removed = 0;
  for (const path of previous?.keys() ?? []) {
    if (!manifest.has(path)) removed += 1;
  }
  return removed;
}

/**
 * Lists and inspects every eligible file. Unchanged files are recognised by
 * robust file signatures through the per-root cache, so a rescan of a settled tree costs
 * a stat per file and no reads. Only paths the current listing names are
 * selected. The metadata cache is bounded to MAX_FILES and shared by
 * overlapping sessions; entries are retained because every reuse
 * checks the complete stat signature, including ctime/inode/device. `onListing`
 * sees the listing before any file is read.
 */
async function scanWorkspaceFull(
  root: string,
  cache: Map<string, HashCacheEntry>,
  texts: RedactedTextCache,
  previous: Manifest | null,
  includeAll: boolean,
  metrics: UploadMetrics,
  priorityPaths: ReadonlySet<string> = new Set(),
  onListing?: (paths: readonly string[]) => void,
  listFiles: () => Promise<WorkspaceListing> = () => listWorkspaceFiles(root, priorityPaths),
): Promise<ScanResult> {
  metrics.fullScans += 1;
  const listing = await listFiles();
  onListing?.(listing.paths);
  const context = scanContext(root, cache, texts, metrics);
  const entries = await mapBounded(listing.paths, SCAN_CONCURRENCY, (path) => inspectFile(context, path));
  const manifest: Manifest = new Map();
  const changed = includeAll ? null : new Set<string>();
  const binaryPaths = new Map<string, number>();
  const unreadPaths: string[] = [];
  const cappedPaths = [...(listing.overflowPaths ?? [])];
  listing.paths.forEach((path, index) => {
    const entry = entries[index];
    if (!entry) {
      if (unreadPaths.length < MAX_LISTED_EXCLUSIONS) unreadPaths.push(path);
      return;
    }
    cache.set(path, entry);
    if (entry.binary) {
      binaryPaths.set(path, entry.size);
      return;
    }
    if (manifest.size >= MAX_FILES) {
      if (cappedPaths.length < MAX_LISTED_EXCLUSIONS) cappedPaths.push(path);
      return;
    }
    manifest.set(path, entry);
    if (changed && previous?.get(path)?.sha256 !== entry.sha256) changed.add(path);
  });
  // A listed file the scan did not read: over the per-file cap, or gone.
  const tooLargePaths = new Map<string, number>();
  await mapBounded(unreadPaths, SCAN_CONCURRENCY, async (path) => {
    const file = await lstat(resolve(root, path)).catch(() => null);
    if (file?.isFile() && file.size > MAX_UPLOAD_FILE_BYTES) tooLargePaths.set(path, file.size);
  });
  return {
    manifest,
    changed,
    removed: countRemoved(previous, manifest),
    deniedCount: listing.denied,
    manifestTruncated: listing.truncated || listing.paths.length >= MAX_FILES,
    deniedPaths: listing.deniedPaths,
    binaryPaths,
    tooLargePaths,
    cappedPaths,
    extras: context.extras,
    extrasScope: "full",
  };
}

/**
 * Inspects only the paths the watcher reported since the last capture and
 * folds them into a copy of the previous manifest: no listing, no stat of the
 * rest of the tree. `ignored` is git's current answer for every reported path
 * (the caller asks in one batch before anything is read): an ignored path is
 * never read, and leaves the manifest if it was there, since a file the user
 * has just added to `.gitignore` or `.git/info/exclude` may not stay listed. A
 * reported path that is no longer a file may have been a directory moved or
 * deleted as a whole (one event, no events for its files): the manifest
 * entries under it are inspected too.
 */
async function scanDirtyPaths(
  root: string,
  cache: Map<string, HashCacheEntry>,
  texts: RedactedTextCache,
  previous: Manifest,
  dirty: readonly string[],
  ignored: ReadonlySet<string>,
  listing: { denied: number; truncated: boolean },
  metrics: UploadMetrics,
): Promise<ScanResult> {
  metrics.dirtyScans += 1;
  const context = scanContext(root, cache, texts, metrics);
  const targets = dirty.filter((path) => !ignored.has(path));
  const inspect = (paths: string[]) => mapBounded(paths, SCAN_CONCURRENCY, (path) => inspectFile(context, path));
  const entries = await inspect(targets);
  const manifest: Manifest = new Map(previous);
  for (const path of dirty) {
    if (!ignored.has(path)) continue;
    manifest.delete(path);
    cache.delete(path);
  }
  const changed = new Set<string>();
  const vanished = new Set<string>();
  const fold = (path: string, entry: HashCacheEntry | null) => {
    if (!entry || entry.binary) {
      if (!manifest.delete(path) && !entry) vanished.add(path);
      return;
    }
    if (!manifest.has(path) && manifest.size >= MAX_FILES) return;
    manifest.set(path, entry);
    if (previous.get(path)?.sha256 !== entry.sha256) changed.add(path);
  };
  targets.forEach((path, index) => fold(path, entries[index] ?? null));
  if (vanished.size > 0) {
    const reported = new Set(dirty);
    const inside: string[] = [];
    for (const path of manifest.keys()) {
      if (reported.has(path)) continue;
      for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
        if (vanished.has(path.slice(0, slash))) {
          inside.push(path);
          break;
        }
      }
    }
    const insideEntries = await inspect(inside);
    inside.forEach((path, index) => fold(path, insideEntries[index] ?? null));
  }
  return {
    manifest,
    changed,
    removed: countRemoved(previous, manifest),
    deniedCount: listing.denied,
    manifestTruncated: listing.truncated || manifest.size >= MAX_FILES,
    extras: context.extras,
    extrasScope: new Set(targets),
  };
}

/**
 * Paths that were touched by the session or named by git, keyed the way
 * files[] names them. The weighted candidate ranking adds associated and
 * generated-file rules after this early evidence is collected.
 */
function snapshotPriorityPaths(touched: Iterable<string>, git: UploadGitBlock | null): Set<string> {
  const paths = new Set<string>();
  for (const path of touched) paths.add(portablePathForUpload(path));
  for (const entry of git?.status ?? []) paths.add(entry.path);
  for (const line of git?.diff?.split("\n") ?? []) {
    const path = diffHeaderPath(line);
    if (path) paths.add(portablePathForUpload(path));
  }
  return paths;
}

/**
 * Picks which changed files carry content, smallest first within each
 * priority tier, against a budget measured on the JSON a file becomes, so
 * escaping cannot push the envelope past what the raw byte count promised.
 */
function selectSnapshotContent(candidates: SnapshotCandidate[], budget: number): { selected: Set<string>; omittedCount: number; omittedBytes: number } {
  // Relevance wins before size. Path order makes equal inputs reproducible
  // across sessions whose filesystem listing order differs.
  const ordered = [...candidates].sort((a, b) => a.relevance - b.relevance || a.bytes - b.bytes || a.path.localeCompare(b.path));
  const selected = new Set<string>();
  let used = 0;
  let omittedCount = 0;
  let omittedBytes = 0;
  for (const candidate of ordered) {
    if (used + candidate.cost <= budget) {
      selected.add(candidate.path);
      used += candidate.cost;
    } else {
      omittedCount += 1;
      omittedBytes += candidate.bytes;
    }
  }
  return { selected, omittedCount, omittedBytes };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Whether an unauthorized response is the sign-in gate (the broker's or the
 * gateway's `omnirush_account_required`) rather than a stale device token.
 * Reading the body also releases the connection.
 */
async function boundedResponseText(response: Response, maxBytes = MAX_RESPONSE_BODY_BYTES): Promise<string> {
  try {
    if (!response.body) return (await response.text()).slice(0, maxBytes);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (bytes < maxBytes) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        const take = Math.min(chunk.byteLength, maxBytes - bytes);
        if (take > 0) {
          chunks.push(chunk.subarray(0, take));
          bytes += take;
        }
        if (take < chunk.byteLength) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  } catch {
    return "";
  }
}

async function responseSignalsAccountRequired(response: Response): Promise<boolean> {
  return (await boundedResponseText(response)).includes(ACCOUNT_REQUIRED_MARKER);
}

async function responseSignalsUnsupportedSchema(response: Response): Promise<boolean> {
  const body = (await boundedResponseText(response)).toLowerCase();
  return body.includes("unsupported_schema")
    || body.includes("unsupported schema")
    || (body.includes("schema") && (body.includes("unsupported") || body.includes("not supported")));
}

/**
 * Top-level directories holding at least one listed file: the ones worth a
 * recursive watcher. The listing is git's (tracked plus untracked-but-not-
 * ignored) filtered by the denylist, so an ignored or denied directory never
 * appears here.
 */
function watchRootsFor(paths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash > 0) roots.add(path.slice(0, slash));
  }
  return [...roots];
}

// --- envelope streaming ------------------------------------------------------

const utf8Encoder = new TextEncoder();

/**
 * Streams one envelope as JSON text through zstd into a file, piece by piece.
 * Text is encoded into one reusable chunk, and a full chunk is handed to the
 * compressor and reused only once the compressor has consumed it (which also
 * carries the file's backpressure): nothing larger than one file's serialised
 * entry exists in memory at a time, and writing allocates no buffer per chunk.
 * The compressed result is read back from disk only for the upload.
 */
class EnvelopeWriter {
  /** Uncompressed bytes written so far. */
  bytes = 0;
  private readonly zstd = createZstdCompress();
  private readonly file: WriteStream;
  private readonly finished: Promise<void>;
  private failure: Error | null = null;
  private readonly chunk = Buffer.allocUnsafeSlow(ENVELOPE_WRITE_CHUNK_BYTES);
  private used = 0;

  constructor(readonly path: string) {
    this.file = createWriteStream(path, { mode: 0o600 });
    this.finished = new Promise<void>((resolvePromise, reject) => {
      const fail = (error: Error) => {
        this.failure ??= error;
        reject(error);
      };
      this.file.on("finish", resolvePromise);
      this.file.on("error", fail);
      this.zstd.on("error", fail);
    });
    this.finished.catch(() => undefined);
    this.zstd.pipe(this.file);
  }

  async write(text: string): Promise<void> {
    let rest = text;
    while (rest.length > 0) {
      const { read, written } = utf8Encoder.encodeInto(rest, this.chunk.subarray(this.used));
      this.used += written;
      this.bytes += written;
      rest = read === rest.length ? "" : rest.slice(read);
      // What is left did not fit (or the next code point did not): pass the chunk on.
      if (rest.length > 0) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.used === 0) return;
    const view = this.chunk.subarray(0, this.used);
    await new Promise<void>((resolvePromise, reject) => {
      const fail = (error: Error) => {
        this.zstd.off("error", fail);
        this.file.off("error", fail);
        reject(error);
      };
      this.zstd.once("error", fail);
      this.file.once("error", fail);
      this.zstd.write(view, (error) => {
        this.zstd.off("error", fail);
        this.file.off("error", fail);
        if (error) reject(error);
        else resolvePromise();
      });
    });
    this.used = 0;
  }

  /** Ends the stream and resolves with the compressed size on disk. */
  async finish(): Promise<number> {
    await this.flush();
    this.zstd.end();
    await this.finished;
    return (await stat(this.path)).size;
  }

  async abort(): Promise<void> {
    this.zstd.destroy();
    this.file.destroy();
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}

type EnvelopeBody = {
  /** Envelope fields written before files[]: workspace, environment, touched paths, scope. */
  extras: Record<string, unknown>;
  /** Streams files[] one entry at a time through `emit`. */
  writeFiles: (emit: (file: UploadFile) => Promise<void>) => Promise<void>;
  manifest: () => Iterable<HashCacheEntry | ExtraManifestEntry>;
  /** Computed once files[] is written, so cap omissions are known. */
  privacy: () => Record<string, unknown>;
  /** Fields written after privacy, once files[] is out (excluded_files). */
  trailer?: () => Promise<Record<string, unknown>>;
  trace?: readonly unknown[];
  schemaVersion?: 2 | 3;
};

/** The part of SNAPSHOT_WRAPPER_MARGIN_BYTES excluded_files may use beyond the content budget's leftover. */
const EXCLUDED_FILES_MARGIN_BYTES = 256 * 1024;

/** How long a session's last snapshot waits for a toolchain collection still running. */
const FINAL_TOOLCHAIN_WAIT_MS = 3_000;

/** `{ git_skipped: "xcode_clt_missing" }` when capture may not run git here (command-guard.ts), else nothing. */
/**
 * Why the project archive leaves this session folder out on purpose (a
 * credential store such as `~/.aws`, the home directory, app data, a system
 * directory), for the start upload: `{project_archive: {status: "skipped",
 * reason}}`, so the export can say why it has no project. The archive gate's
 * own check (session-archive/detect.ts), loaded on demand (detect.ts imports
 * this module).
 */
async function projectArchiveField(root: string): Promise<{ project_archive?: { status: "skipped"; reason: string } }> {
  try {
    const { projectArchiveSkip } = await import("./session-archive/detect.js");
    const userDataDir = process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR?.trim();
    const skip = await projectArchiveSkip(root, userDataDir ? { userDataDir } : {});
    return skip ? { project_archive: skip } : {};
  } catch {
    return {};
  }
}

async function gitSkippedField(): Promise<{ git_skipped?: string }> {
  const reason = await gitSkipReason();
  return reason ? { git_skipped: reason } : {};
}

const SERVER_PACKAGE_VERSION: string = serverPackage.version;

/** The desktop's `client.launch` trace data: the CLI's keys, plus the harness. */
export function clientLaunchData(): { mode: "app"; engine: "opencode"; engine_version: string; harness: Harness } {
  return { mode: "app", engine: "opencode", engine_version: BUNDLED_ENGINE_VERSION, harness: { ...BUNDLED_HARNESS } };
}

function uploadEnvironment(appVersion: string | undefined, engineVersion: string | undefined, gitVersion: string | null): UploadEnvironment {
  let locale: string | null = null;
  let timezone: string | null = null;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    locale = resolved.locale || null;
    timezone = resolved.timeZone || null;
  } catch {
    // Intl data can be missing in trimmed runtimes.
  }
  const shellPath = process.platform === "win32" ? process.env.COMSPEC : process.env.SHELL;
  const field = (value: string | null | undefined): string | null =>
    value?.trim() ? clampUploadText(value.trim(), MAX_ENVIRONMENT_FIELD_CHARS) : null;
  return {
    os: process.platform,
    os_version: field(osRelease()) ?? "",
    arch: process.arch,
    app_version: field(appVersion) ?? field(SERVER_PACKAGE_VERSION) ?? "unknown",
    engine_version: field(engineVersion) ?? BUNDLED_ENGINE_VERSION,
    harness: { ...BUNDLED_HARNESS },
    node_version: field(process.versions.node ?? process.version.replace(/^v/, "")) ?? "",
    shell: shellPath?.trim() ? field(basename(shellPath.trim())) : null,
    locale: field(locale),
    timezone: field(timezone),
    git_version: field(gitVersion),
  };
}

/**
 * Settles like `response`, or rejects once `signal` aborts, so an upload hook
 * that does not watch its signal still ends at the deadline.
 */
function untilAborted(response: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    response.then((value) => {
      signal.removeEventListener("abort", onAbort);
      // An answer after the deadline is dropped like an aborted fetch's.
      if (signal.aborted) void value.body?.cancel().catch(() => undefined);
      resolvePromise(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function spoolId(counter: number): string {
  return `${Date.now().toString(16).padStart(12, "0")}-${counter.toString(16).padStart(6, "0")}-${randomBytes(4).toString("hex")}`;
}

function writePrivateFileAtomic(path: string, data: Buffer | string): Promise<void> {
  return writeFileAtomic(path, data, { mode: 0o600 });
}

function parseSpoolMeta(value: unknown): SpoolMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SpoolMeta>;
  if (typeof record.id !== "string" || typeof record.session_id !== "string" || typeof record.snapshot_type !== "string"
    || typeof record.trigger !== "string" || typeof record.sequence !== "number" || typeof record.bytes !== "number"
    || typeof record.created_at !== "string") return null;
  return {
    id: record.id,
    session_id: record.session_id,
    snapshot_type: record.snapshot_type as SnapshotType,
    trigger: record.trigger as UploadTrigger,
    sequence: record.sequence,
    bytes: record.bytes,
    created_at: record.created_at,
    attempts: optionalCount(record.attempts) ?? 0,
    ...(optionalString(record.last_attempt_at) ? { last_attempt_at: record.last_attempt_at } : {}),
    ...(optionalString(record.not_before) ? { not_before: record.not_before } : {}),
  };
}

export class SessionUploader {
  private readonly uploadUrl: string | null;
  private token: string;
  private readonly fetcher: typeof externalFetch;
  private readonly uploader?: SessionUploaderOptions["upload"];
  private readonly refreshAccessToken?: SessionUploaderOptions["refreshAccessToken"];
  private readonly log: NonNullable<SessionUploaderOptions["log"]>;
  private readonly ledgerPath: string | null;
  private readonly spoolDir: string | null;
  private readonly ledgerReady: Promise<void>;
  private readonly stateDir: string | null;
  /** The move of pre-2.2.2 state names (session-upload-state.ts); every state read waits for it. */
  private readonly stateMigrated: Promise<void>;
  private ledger: SessionLedger = { version: 1, sessions: {} };
  private ledgerWriteTail: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, SessionState>();
  private readonly changeDebounceMs: number;
  private readonly fallbackScanMs: number;
  private readonly appVersion?: string;
  private readonly engineVersion?: string;
  private readonly uploadRetryDelayMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly uploadBudget: SessionUploadBudget;
  private readonly spoolMaxEntries: number;
  private readonly spoolMaxBytes: number;
  private readonly snapshotMaxBytes: number;
  private environmentCache: Promise<UploadEnvironment> | null = null;
  private readonly toolchains: ToolchainCache | null;
  private readonly excludedHashes: HashCache = new Map();
  private spoolCounter = 0;
  private spoolTail: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryFailures = 0;
  /** The drain in progress: one at a time, and aborted by stop() and clearSpool(). */
  private draining: { run: Promise<{ delivered: number; pending: number }>; controller: AbortController } | null = null;
  private drainQueued: Promise<{ delivered: number; pending: number }> | null = null;
  /**
   * The signed-in account's uploads: clearSpool() (sign-out) aborts it and
   * starts a new one, ending every upload in flight, and an envelope such an
   * upload carried is not spooled.
   */
  private account = new AbortController();
  /** Aborted once by abortUploads(): a shutdown out of time ends every upload in flight and sends nothing more. */
  private readonly halted = new AbortController();
  private stopped = false;
  private readonly minChangeIntervalMs: number;
  private readonly maxWatchedFiles: number;
  /** Envelopes are streamed into this directory and deleted once uploaded or spooled. */
  private readonly tempDir: string;
  /**
   * Per workspace root, shared by every session open on it: the hash cache,
   * and when the reconcile pass last ran (one pass serves every session).
   */
  private readonly caches = new Map<string, {
    refs: number;
    entries: Map<string, HashCacheEntry>;
    listingInFlight: Map<string, Promise<WorkspaceListing>>;
    reconcileInFlight: Promise<void> | null;
  }>();
  /** Redacted text of the files the scrubber changed, shared by every root. */
  private readonly texts: RedactedTextCache;
  /** The scrubbed texts sent, by redacted digest: the bases of "turn.diff" events. */
  private readonly bases: TurnBaseStore;
  private readonly onSessionClosed?: (sessionId: string) => void;
  private readonly onPathTouched?: (sessionId: string, path: string) => void;
  private readonly onBinaryFile?: (sessionId: string, path: string) => void;
  private readonly fileUploader?: SessionUploaderOptions["uploadFile"];
  private readonly capabilityProbe?: SessionUploaderOptions["capabilities"];
  private traceSchemaCache: { version: 2 | 3; expiresAt: number } | null = null;
  private traceSchemaProbe: Promise<2 | 3> | null = null;
  /** Work counters for tests and profiling. */
  readonly metrics: UploadMetrics = freshMetrics();
  /** Capture context (context/), null when off. */
  readonly context: ContextCapture | null;

  constructor(options: SessionUploaderOptions = {}) {
    this.uploadUrl = resolveUploadUrl(options.gatewayUrl ?? process.env.OMNIRUSH_GATEWAY_URL);
    this.token = (options.accessToken ?? process.env.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
    this.fetcher = options.fetch ?? externalFetch;
    this.uploader = options.upload;
    this.fileUploader = options.uploadFile;
    this.capabilityProbe = options.capabilities;
    this.refreshAccessToken = options.refreshAccessToken;
    this.log = options.log ?? (() => undefined);
    const stateDir = options.stateDir ? resolve(options.stateDir) : null;
    this.stateDir = stateDir;
    this.ledgerPath = stateDir ? join(stateDir, UPLOAD_SESSION_LEDGER_FILE) : null;
    this.spoolDir = stateDir ? join(stateDir, UPLOAD_SPOOL_DIRECTORY) : null;
    // State left under the pre-2.2.2 names is moved before anything reads it.
    this.stateMigrated = stateDir
      ? migrateLegacyUploadState(stateDir, (message, details) => this.log("warn", message, details))
      : Promise.resolve();
    this.ledgerReady = this.stateMigrated.then(() => this.loadLedger());
    this.changeDebounceMs = options.changeDebounceMs ?? CHANGE_DEBOUNCE_MS;
    this.fallbackScanMs = options.fallbackScanMs ?? FALLBACK_SCAN_MS;
    this.appVersion = options.appVersion;
    this.engineVersion = options.engineVersion;
    this.uploadRetryDelayMs = options.uploadRetryDelayMs ?? UPLOAD_RETRY_DELAY_MS;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.uploadBudget = options.uploadBudget ?? SESSION_UPLOAD_BUDGET;
    this.spoolMaxEntries = options.spoolMaxEntries ?? MAX_SPOOL_ENTRIES;
    this.spoolMaxBytes = options.spoolMaxBytes ?? MAX_SPOOL_BYTES;
    this.snapshotMaxBytes = options.snapshotMaxBytes ?? MAX_SNAPSHOT_BYTES;
    this.minChangeIntervalMs = options.minChangeIntervalMs ?? MIN_UPLOAD_CHANGE_INTERVAL_MS;
    this.maxWatchedFiles = options.maxWatchedFiles ?? MAX_UPLOAD_WATCHED_FILES;
    this.texts = new RedactedTextCache(options.redactedTextCacheBytes ?? REDACTED_TEXT_CACHE_BYTES);
    this.toolchains = options.toolchain === false
      ? null
      : new ToolchainCache({
        checks: { isSecretName: isSecretAssignmentKey, scrubText: (text) => redactUploadText(text).text, isDenied: isUploadPathDenied },
        ...(options.toolchain ?? {}),
        scrub: (toolchain) => redactUploadJson(toolchain).value as UploadToolchain,
      });
    this.onSessionClosed = options.onSessionClosed;
    this.onPathTouched = options.onPathTouched;
    this.onBinaryFile = options.onBinaryFile;
    this.tempDir = stateDir ? join(stateDir, UPLOAD_TEMP_DIRECTORY) : join(tmpdir(), `omnirush-upload-${process.pid}`);
    this.bases = new TurnBaseStore(
      stateDir ? join(stateDir, UPLOAD_BASE_DIRECTORY) : join(this.tempDir, UPLOAD_BASE_DIRECTORY),
      undefined,
      this.stateMigrated,
    );
    void this.stateMigrated.then(() => this.cleanTempDir(60 * 60_000)).catch(() => undefined);
    this.context = !options.context || !this.enabled ? null : this.createContext(stateDir, options.context);
    if (this.spoolDir) {
      if (this.enabled) {
        // Uploads spooled by a previous process are retried once this one is up.
        this.scheduleRetry(this.retryBaseMs);
      } else {
        // Without an account there is nobody to deliver queued snapshots to;
        // a sign-out must not leave workspace content waiting on disk.
        void this.clearSpool().catch(() => undefined);
      }
    }
  }

  /** Capture context wired to this uploader: its trace, its scrub, the project archive and the archive's exclusions. */
  private createContext(stateDir: string | null, overrides: Partial<ContextOptions>): ContextCapture | null {
    // Off (OMNIRUSH_CAPTURE_CONTEXT=0): nothing is loaded or read.
    if (overrides.enabled === false || (overrides.enabled === undefined && !captureContextEnabled(overrides.env ?? process.env))) return null;
    let exclusion: ((absolute: string) => string | null) | null = null;
    // Loaded lazily: session-archive/outside.ts imports this module.
    void import("./session-archive/outside.js").then((module) => {
      const home = (() => {
        try {
          return homedir() || null;
        } catch {
          return null;
        }
      })();
      const appDirs = stateDir ? [stateDir] : [];
      exclusion = (absolute) => module.outsideExclusion(absolute, { appDirs, home });
    }, () => undefined);
    const bundle = bundledBestPractices as { source?: { commit?: string }; skills?: Array<{ name?: string; content?: string }> };
    const bundledSkills = (bundle.skills ?? []).filter((skill) => typeof skill.name === "string" && typeof skill.content === "string").map((skill) => ({
      name: skill.name!,
      version: bundle.source?.commit ? bundle.source.commit.slice(0, 12) : null,
      sha256: createHash("sha256").update(skill.content!).digest("hex"),
    }));
    const capture = new ContextCapture({
      client: "gui",
      appVersion: this.appVersion ?? null,
      engineVersion: this.engineVersion ?? BUNDLED_ENGINE_VERSION,
      cacheDir: stateDir ? join(stateDir, "context") : null,
      scrub: {
        text: (text) => redactUploadText(text).text,
        json: (value) => redactUploadJson(value).value as typeof value,
        content: (path, text) => redactUploadContent(path, text),
      },
      record: (sessionId, type, data) => this.recordContext(sessionId, type, data),
      reportPath: (sessionId, absolute) => this.onPathTouched?.(sessionId, absolute),
      // Until the archive's rules are loaded nothing outside is archived.
      exclusion: (absolute) => (exclusion ? exclusion(absolute) : "pending"),
      denied: (relPath) => isUploadPathDenied(relPath),
      model: (sessionId) => this.sessions.get(sessionId)?.model ?? null,
      bundledSkills,
      // The app's own runtime skills and engine config live in its state directory (omnirush-runtime-config.ts).
      bundledSkillDirs: stateDir ? [join(stateDir, "skills")] : [],
      configFiles: stateDir ? [join(stateDir, "runtime-opencode-config.json")] : [],
      log: this.log,
      ...overrides,
    });
    return capture.enabled ? capture : null;
  }

  /** Appends a capture-context event; also while a finished session's last upload is being prepared. */
  private recordContext(sessionId: string, type: string, data: unknown): void {
    const state = this.sessions.get(sessionId);
    if (state) this.appendTrace(state, type, data);
  }

  private async loadLedger(): Promise<void> {
    this.ledger = await readSessionLedger(this.ledgerPath);
  }

  private async saveLedger(): Promise<void> {
    if (!this.ledgerPath) return;
    await this.ledgerReady;
    const entries = Object.entries(this.ledger.sessions)
      .sort(([, left], [, right]) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, MAX_SESSION_LEDGER_ENTRIES);
    this.ledger.sessions = Object.fromEntries(entries);
    const snapshot = JSON.stringify(this.ledger);
    this.ledgerWriteTail = this.ledgerWriteTail
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.ledgerPath!), { recursive: true, mode: 0o700 });
        await writePrivateFileAtomic(this.ledgerPath!, snapshot);
      });
    await this.ledgerWriteTail;
  }

  private ledgerRecord(state: SessionState): SessionLedgerRecord {
    return {
      segment: state.segment,
      nextSequence: state.sequence,
      sentBytes: state.sentBytes,
      ...(state.lastMessageId ? { lastMessageId: state.lastMessageId } : {}),
      lastSeenAt: new Date().toISOString(),
      failureCount: state.failureCount,
      ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
      ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.childSessionIds.length > 0 ? { childSessionIds: [...state.childSessionIds] } : {}),
      ...(state.childCheckpoints.size > 0 ? { childCheckpoints: Object.fromEntries(state.childCheckpoints) } : {}),
    };
  }

  private async prepareSession(state: SessionState): Promise<void> {
    await this.ledgerReady;
    const previous = this.ledger.sessions[state.id];
    state.segment = (previous?.segment ?? 0) + 1;
    state.sequence = previous?.nextSequence ?? 0;
    state.sentBytes = previous?.sentBytes ?? 0;
    state.lastMessageId = previous?.lastMessageId;
    state.failureCount = previous?.failureCount ?? 0;
    state.lastFailureAt = previous?.lastFailureAt;
    state.lastSuccessAt = previous?.lastSuccessAt;
    // Events recorded before the ledger loaded take precedence over what the
    // previous segment left behind; nothing recorded so far is discarded.
    state.model = state.model ?? previous?.model ?? null;
    state.childSessionIds = [...new Set([...(previous?.childSessionIds ?? []), ...state.childSessionIds])];
    state.childCheckpoints = new Map([...Object.entries(previous?.childCheckpoints ?? {}), ...state.childCheckpoints]);
    state.resumed = Boolean(previous);
    if (state.resumed) {
      this.appendTrace(state, "session.resumed", { session_segment: state.segment, previous_segment: previous?.segment ?? null });
    }
    this.ledger.sessions[state.id] = this.ledgerRecord(state);
    await this.saveLedger();
  }

  private async persistSession(state: SessionState): Promise<void> {
    await this.ledgerReady;
    this.ledger.sessions[state.id] = this.ledgerRecord(state);
    await this.saveLedger();
  }

  private async recordLedgerOutcome(sessionId: string, outcome: "success" | "failure"): Promise<void> {
    const now = new Date().toISOString();
    const state = this.sessions.get(sessionId);
    if (state) {
      if (outcome === "success") state.lastSuccessAt = now;
      else {
        state.failureCount += 1;
        state.lastFailureAt = now;
      }
      await this.persistSession(state);
      return;
    }
    await this.ledgerReady;
    const record = this.ledger.sessions[sessionId];
    if (!record) return;
    if (outcome === "success") record.lastSuccessAt = now;
    else {
      record.failureCount = (record.failureCount ?? 0) + 1;
      record.lastFailureAt = now;
    }
    record.lastSeenAt = now;
    await this.saveLedger();
  }

  async sessionCheckpoint(sessionId: string): Promise<{ resumed: boolean; segment?: number; lastMessageId?: string }> {
    const state = this.sessions.get(sessionId);
    if (!state) return { resumed: false };
    await state.ready;
    return { resumed: state.resumed, segment: state.segment, lastMessageId: state.lastMessageId };
  }

  async setSessionCheckpoint(sessionId: string, messageId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    await state.ready;
    state.lastMessageId = messageId;
    await this.persistSession(state);
  }

  async sessionDeliveryStatus(sessionId: string): Promise<{ failureCount: number; lastFailureAt: string | null; lastSuccessAt: string | null } | null> {
    await this.ledgerReady;
    const state = this.sessions.get(sessionId);
    if (state) {
      await state.ready;
      return { failureCount: state.failureCount, lastFailureAt: state.lastFailureAt ?? null, lastSuccessAt: state.lastSuccessAt ?? null };
    }
    const record = this.ledger.sessions[sessionId];
    if (!record) return null;
    return { failureCount: record.failureCount ?? 0, lastFailureAt: record.lastFailureAt ?? null, lastSuccessAt: record.lastSuccessAt ?? null };
  }

  get enabled(): boolean {
    return Boolean(this.uploader || this.fileUploader || (this.uploadUrl && this.token));
  }

  private environment(): Promise<UploadEnvironment> {
    this.environmentCache ??= (async () => {
      let gitVersion: string | null = null;
      try {
        if (await gitSkipReason()) throw new Error(XCODE_CLT_MISSING);
        const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5_000, maxBuffer: 16 * 1024 });
        gitVersion = String(stdout).trim().replace(/^git version\s+/i, "") || null;
      } catch {
        gitVersion = null;
      }
      return uploadEnvironment(this.appVersion, this.engineVersion, gitVersion);
    })();
    return this.environmentCache;
  }

  /**
   * excluded-files.ts: what this snapshot left out. A full scan names the
   * denied, binary, oversized, gitignored and capped files; a targeted one
   * only what it inspected.
   */
  private async excludedFiles(root: string, scan: ScanResult, omitted: readonly SnapshotCandidate[], ignoredListing: readonly string[] | null, maxBytes: number): Promise<unknown> {
    const excluded = new ExcludedFiles(root, { uploadPath: portablePathForUpload, hashes: this.excludedHashes });
    for (const path of scan.deniedPaths ?? []) excluded.add(path, "privacy");
    for (const [path, size] of scan.tooLargePaths ?? []) excluded.add(path, "too_large", { size });
    for (const [path, size] of scan.binaryPaths ?? []) excluded.add(path, "binary", { size });
    // A full scan (`ignoredListing` given): the gitignored files, a denied one as privacy.
    for (const path of ignoredListing ?? []) excluded.add(path, isUploadPathDenied(path.replace(/\/$/, "")) ? "privacy" : "gitignored");
    for (const path of scan.cappedPaths ?? []) excluded.add(path, "snapshot_cap");
    for (const candidate of omitted) excluded.add(candidate.path, "snapshot_cap", { size: candidate.bytes, sha256: scan.manifest.get(candidate.path)?.sha256 ?? null });
    return excluded.finish(maxBytes);
  }

  /**
   * The environment block plus the toolchain of the session's project root,
   * when one was captured, and where the session came from when it was
   * imported from the opencode 2.x engine (engine2/imported.ts).
   */
  private async sessionEnvironment(root: string, sessionId: string, waitMs?: number): Promise<UploadEnvironment> {
    const environment = await this.environment();
    const toolchain = this.toolchains ? await this.toolchains.get(root, waitMs).catch(() => null) : null;
    const importedFrom = engine2ImportedFrom(sessionId);
    return { ...environment, ...(toolchain ? { toolchain } : {}), ...(importedFrom ? { imported_from: importedFrom } : {}) };
  }

  private negotiatedTraceSchema(force = false): Promise<2 | 3> {
    if (!force && this.traceSchemaCache && this.traceSchemaCache.expiresAt > Date.now()) {
      return Promise.resolve(this.traceSchemaCache.version);
    }
    if (this.traceSchemaProbe) return this.traceSchemaProbe;
    this.traceSchemaProbe = (async () => {
      let version: 2 | 3 = 2;
      if (this.capabilityProbe) {
        try {
          const capabilities = await this.capabilityProbe();
          version = capabilities.canonical_trace
            && Array.isArray(capabilities.schema_versions)
            && capabilities.schema_versions.includes(TRACE_SCHEMA_VERSION)
            ? 3
            : 2;
        } catch {
          version = 2;
        }
      }
      this.traceSchemaCache = { version, expiresAt: Date.now() + TRACE_CAPABILITY_TTL_MS };
      return version;
    })().finally(() => {
      this.traceSchemaProbe = null;
    });
    return this.traceSchemaProbe;
  }

  private downgradeTraceSchema(): void {
    this.traceSchemaCache = { version: 2, expiresAt: Date.now() + TRACE_CAPABILITY_TTL_MS };
  }

  startSession(sessionId: string, workspaceId: string, root: string): void {
    if (!this.enabled || this.sessions.has(sessionId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(sessionId)) return;
    void this.toolchains?.get(root).catch(() => null); // toolchain.ts: collected in the background
    const state: SessionState = {
      id: sessionId,
      root,
      workspaceId,
      sentBytes: 0,
      segment: 1,
      sequence: 0,
      resumed: false,
      started: false,
      finished: false,
      changeTimer: null,
      changeTrigger: null,
      deferTimer: null,
      deferTrigger: null,
      scanTimer: null,
      watchers: [],
      watchMode: "starting",
      watchedPaths: [],
      watchSetup: Promise.resolve(),
      trace: [],
      changeJournal: new Map(),
      extras: new Map(),
      touchedPaths: new Set(),
      changeJournalBytes: 0,
      changeCaptureTail: Promise.resolve(),
      pendingJournal: new Set(),
      ignoreBatch: new Map(),
      ignoreTimer: null,
      ignoredCache: new Map(),
      manifest: null,
      turnManifest: null,
      turnStartedAt: null,
      turnInProgress: false,
      changesHeld: false,
      turnSkipped: new Map(),
      turnWrittenPaths: new Map(),
      relevance: new Map(),
      cache: this.acquireCache(root),
      listing: { denied: 0, truncated: false },
      dirty: new Set(),
      // Nothing is known about the tree yet: the first change capture rescans it.
      dirtyOverflow: true,
      lastHead: null,
      lastChangeAt: 0,
      artifactBaseline: null,
      model: null,
      childSessionIds: [],
      childCheckpoints: new Map(),
      subagentFallbacks: new Map(),
      failureCount: 0,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
    };
    state.ready = this.prepareSession(state);
    this.sessions.set(sessionId, state);
    // Capture context collects once the start snapshot is out.
    let startSnapshotDone: () => void = () => undefined;
    const startSnapshot = new Promise<void>((resolveStart) => (startSnapshotDone = resolveStart));
    this.context?.sessionStarted(sessionId, root, startSnapshot);
    this.enqueue(state, async () => {
      await state.ready;
      try {
        // The watchers go up as soon as the start snapshot's listing is in,
        // before any file is read: an edit made during the scan is either
        // seen by the scan or reported by a watcher.
        await this.uploadWorkspace(state, "start", state.resumed ? "resume" : "session_start");
      } finally {
        state.started = true;
        startSnapshotDone();
        // No listing reached the plan (a failed scan): poll.
        if (state.watchMode === "starting") this.installWatchers(state, null);
      }
    });
  }

  // --- watcher and dirty tracking --------------------------------------------

  /**
   * Plans the watchers from the start snapshot's listing: one non-recursive
   * watcher on the root plus a recursive one per top-level directory holding
   * listed files, so `.git/`, `node_modules/`, gitignored build output and
   * denied directories never reach a callback. The other top-level
   * directories (empty, or holding only denied or ignored files at the start)
   * are watched too, once git confirms they are not ignored themselves. A
   * workspace listing more files than the watched-files cap or more top-level
   * directories than MAX_WATCH_ROOTS, or with no listing at all, is polled on
   * snapshots instead.
   */
  private installWatchers(state: SessionState, paths: readonly string[] | null): void {
    this.closeWatchers(state);
    if (state.finished) return;
    const roots = paths && paths.length <= this.maxWatchedFiles ? watchRootsFor(paths) : null;
    if (roots && roots.length <= MAX_WATCH_ROOTS) {
      for (const prefix of ["", ...roots]) this.addWatcher(state, prefix);
    }
    if (state.watchers.length > 0) {
      state.watchMode = "watching";
      this.startReconcile(state);
      state.watchSetup = this.watchUnlistedRoots(state).catch(() => undefined);
      return;
    }
    this.pollInstead(state, paths?.length ?? null);
  }

  /**
   * Watches the top-level directories the listing gave no reason to: one that
   * was empty, or held only denied or ignored files, when the session started
   * (`scripts/`, `config/` next to a denied `.env`). A file a tool writes there
   * later is then seen as it lands, not only by the next reconcile pass. A
   * denied name (`.git`, `node_modules`, `secrets`) is never watched, nor is a
   * directory git ignores (`dist/`); past MAX_WATCH_ROOTS the rest are left to
   * the reconcile pass and the end-of-turn artifact scan.
   */
  private async watchUnlistedRoots(state: SessionState): Promise<void> {
    const entries = await readdir(state.root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && !hasDeniedComponent([entry.name]) && !state.watchedPaths.includes(entry.name))
      .map((entry) => entry.name);
    if (candidates.length === 0) return;
    const ignored = await this.ignoredPaths(state, candidates, true);
    for (const name of candidates) {
      if (state.finished || state.watchMode !== "watching" || state.watchers.length > MAX_WATCH_ROOTS) return;
      if (!ignored.has(name) && !state.watchedPaths.includes(name)) this.addWatcher(state, name);
    }
  }

  private pollInstead(state: SessionState, files: number | null): void {
    this.closeWatchers(state);
    state.watchMode = "polling";
    state.dirtyOverflow = true;
    this.stopReconcile(state);
    this.log("info", "OmniRush session upload polls this workspace on snapshots instead of watching it", {
      sessionId: state.id,
      files,
      limit: this.maxWatchedFiles,
    });
  }

  /** Watches the root itself (prefix "") non-recursively, or one top-level directory recursively. */
  private addWatcher(state: SessionState, prefix: string): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(prefix ? resolve(state.root, prefix) : state.root, { recursive: prefix !== "" }, (event, filename) => {
        this.handleWatchEvent(state, prefix, event, filename);
      });
    } catch {
      return;
    }
    watcher.on("error", () => {
      // One subtree went dark: the next capture rescans, the reconcile pass
      // keeps covering it, and a workspace with no watcher left is polled.
      watcher.close();
      const index = state.watchers.indexOf(watcher);
      if (index !== -1) {
        state.watchers.splice(index, 1);
        state.watchedPaths.splice(index, 1);
      }
      this.markDirtyOverflow(state);
      if (state.watchers.length === 0 && state.watchMode === "watching" && !state.finished) this.pollInstead(state, state.manifest?.size ?? null);
    });
    state.watchers.push(watcher);
    state.watchedPaths.push(prefix || ".");
  }

  private closeWatchers(state: SessionState): void {
    for (const watcher of state.watchers) watcher.close();
    state.watchers = [];
    state.watchedPaths = [];
  }

  private handleWatchEvent(state: SessionState, prefix: string, event: string, filename: string | Buffer | null): void {
    this.metrics.watchEvents += 1;
    if (state.finished) return;
    if (filename === null || filename === undefined) {
      // The platform lost events (a full ReadDirectoryChangesW buffer, for one).
      this.markDirtyOverflow(state);
      this.scheduleChange(state, "fs_change");
      return;
    }
    const relative = String(filename).replaceAll("\\", "/");
    const path = workspaceRelativePath(state.root, prefix ? `${prefix}/${relative}` : relative);
    if (!path) return;
    this.reportTouched(state, path);
    if (isUploadPathDenied(path)) return;
    if (path === ".gitignore" || path.endsWith("/.gitignore")) {
      // New ignore rules can hide or reveal any number of files: forget what
      // git answered so far and rescan the tree with the rules as they stand.
      state.ignoredCache.clear();
      this.markDirtyOverflow(state);
    } else if (this.knownIgnored(state, path)) {
      // Build output or a cache under a watched directory (`src/__pycache__/`):
      // git already said so, and a rewrite of it is no change worth a capture.
      // Should the rules change outside `.gitignore` (`.git/info/exclude`),
      // the reconcile pass still finds the file.
      return;
    }
    if (event === "rename" && !state.manifest?.has(path)) void this.noteRenamedPath(state, path, prefix === "" && !relative.includes("/"));
    this.markDirty(state, path);
    this.queueChangedPath(state, path);
    this.scheduleChange(state, "fs_change");
  }

  /**
   * A rename of something the manifest does not list may be a directory
   * appearing (or moving): its files arrive without events of their own, so
   * the next capture rescans, and a new top-level directory gets a watcher.
   * A directory git ignores (rebuilt build output) is neither.
   */
  private async noteRenamedPath(state: SessionState, path: string, topLevel: boolean): Promise<void> {
    try {
      if (!(await lstat(resolve(state.root, path))).isDirectory()) return;
    } catch {
      return;
    }
    if (await this.checkIgnored(state, path)) return;
    if (state.finished) return;
    this.markDirtyOverflow(state);
    if (topLevel && state.watchMode === "watching" && state.watchedPaths.includes(".") && !state.watchedPaths.includes(path)
      && state.watchers.length <= MAX_WATCH_ROOTS) {
      this.addWatcher(state, path);
    }
    this.scheduleChange(state, "fs_change");
  }

  /** Tells the project archive that the session touched `path` (workspace-relative). */
  private reportTouched(state: SessionState, path: string): void {
    const current = state.relevance.get(path);
    if (current === undefined || current > 4) state.relevance.set(path, 4);
    try {
      this.onPathTouched?.(state.id, path);
    } catch {
      // The archive's bookkeeping never stops a capture.
    }
  }

  private markDirty(state: SessionState, path: string): void {
    if (state.dirtyOverflow) return;
    if (state.dirty.size >= MAX_DIRTY_PATHS) {
      this.markDirtyOverflow(state);
      return;
    }
    state.dirty.add(path);
  }

  private markDirtyOverflow(state: SessionState): void {
    state.dirtyOverflow = true;
    state.dirty.clear();
  }

  private startReconcile(state: SessionState): void {
    if (state.scanTimer || state.finished) return;
    state.scanTimer = setInterval(() => void this.reconcile(state).catch(() => undefined), this.fallbackScanMs);
    state.scanTimer.unref?.();
  }

  private stopReconcile(state: SessionState): void {
    if (state.scanTimer) clearInterval(state.scanTimer);
    state.scanTimer = null;
  }

  /**
   * The safety net under the watcher: lists the tree and stats every file,
   * without reading any, and marks dirty whatever a session's manifest does
   * not describe as it stands. Runs on the fallback interval while watching;
   * one pass serves every session watching the same root, so a workspace
   * with several chats open is listed once per interval, not once per chat.
   */
  private async reconcile(state: SessionState): Promise<void> {
    if (state.finished || state.watchMode !== "watching" || !state.manifest) return;
    const shared = this.caches.get(resolve(state.root));
    if (!shared || shared.entries !== state.cache) return;
    if (shared.reconcileInFlight) {
      await shared.reconcileInFlight;
      return;
    }
    const sessions = [...this.sessions.values()]
      .filter((other) => other.cache === state.cache && !other.finished && other.watchMode === "watching" && other.manifest !== null);
    const releaseAdmission = await GLOBAL_CAPTURE_ADMISSION.acquire(this.account.signal);
    const pass = (async () => {
      this.metrics.reconciles += 1;
      const cache = state.cache;
      const listing = await this.listWorkspaceFilesShared(state.root, new Set());
      const yielder = new LoopYielder();
      await mapBounded(listing.paths, SCAN_CONCURRENCY, async (path) => {
        const file = await lstat(resolve(state.root, path)).catch(() => null);
        if (file) this.metrics.fileStats += 1;
        const eligible = file && file.isFile() && !file.isSymbolicLink() && file.size <= MAX_UPLOAD_FILE_BYTES ? file : null;
        const cached = cache.get(path);
        for (const session of sessions) {
          const known = session.manifest?.get(path);
          const signature = eligible ? fileSignature(eligible) : null;
          const stale = eligible === null
            ? known !== undefined
            : signature === null
              ? true
              : cached === undefined || !sameFileSignature(cached, signature)
              || (!cached.binary && known?.sha256 !== cached.sha256) || (cached.binary && known !== undefined);
          if (stale) {
            this.markDirty(session, path);
            this.reportTouched(session, path);
          }
        }
        await yielder.pause();
      });
      const listed = new Set(listing.paths);
      for (const session of sessions) {
        for (const path of session.manifest?.keys() ?? []) {
        if (listed.has(path)) continue;
          this.markDirty(session, path);
          this.reportTouched(session, path);
        }
      }
    })().finally(() => releaseAdmission());
    shared.reconcileInFlight = pass;
    await pass.finally(() => {
      if (shared.reconcileInFlight === pass) shared.reconcileInFlight = null;
    });
    for (const session of sessions) {
      if (!session.finished && (session.dirty.size > 0 || session.dirtyOverflow)) this.scheduleChange(session, "periodic");
    }
  }

  // --- git ignore checks, batched --------------------------------------------

  /** Whether git ignores `path`, answered from a short-lived cache or one batched `git check-ignore`. */
  private checkIgnored(state: SessionState, path: string): Promise<boolean> {
    const cached = state.ignoredCache.get(path);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolvePromise) => {
      let waiters = state.ignoreBatch.get(path);
      if (!waiters) {
        waiters = [];
        state.ignoreBatch.set(path, waiters);
      }
      waiters.push(resolvePromise);
      if (state.ignoreBatch.size >= IGNORE_CHECK_BATCH_MAX) {
        void this.flushIgnoreBatch(state);
        return;
      }
      if (!state.ignoreTimer) {
        state.ignoreTimer = setTimeout(() => void this.flushIgnoreBatch(state), IGNORE_CHECK_BATCH_MS);
        state.ignoreTimer.unref?.();
      }
    });
  }

  private async flushIgnoreBatch(state: SessionState): Promise<void> {
    if (state.ignoreTimer) clearTimeout(state.ignoreTimer);
    state.ignoreTimer = null;
    const batch = state.ignoreBatch;
    if (batch.size === 0) return;
    state.ignoreBatch = new Map();
    const ignored = await this.ignoredPaths(state, [...batch.keys()]);
    for (const [path, waiters] of batch) {
      const result = ignored.has(path);
      for (const waiter of waiters) waiter(result);
    }
  }

  /** Whether git's last answer (still cached) ignores `path` or a directory above it. */
  private knownIgnored(state: SessionState, path: string): boolean {
    for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
      if (state.ignoredCache.get(path.slice(0, end)) === true) return true;
    }
    return false;
  }

  /**
   * The subset of `paths` git ignores, with one spawn (see
   * gitIgnoredPathsIsolated) for whatever the cache does not know. `fresh`
   * asks git about every path whatever the cache holds, and refreshes the
   * cache with the answers: a snapshot decides what leaves the machine on
   * that answer, since `.git/info/exclude` or `core.excludesFile` can change
   * with no event the session uploader sees.
   */
  private async ignoredPaths(state: SessionState, paths: string[], fresh = false): Promise<Set<string>> {
    const ignored = new Set<string>();
    const unknown: string[] = [];
    for (const path of paths) {
      const cached = fresh ? undefined : state.ignoredCache.get(path);
      if (cached === undefined) unknown.push(path);
      else if (cached) ignored.add(path);
    }
    if (unknown.length > 0) {
      const answer = (await gitIgnoredPathsIsolated(state.root, unknown, () => { this.metrics.ignoreCheckSpawns += 1; }))
        ?? (await fallbackIgnoredPaths(state.root, unknown));
      for (const path of unknown) {
        const result = answer.has(path);
        if (result) ignored.add(path);
        if (state.ignoredCache.size >= MAX_IGNORED_CACHE_ENTRIES) {
          const oldest = state.ignoredCache.keys().next().value;
          if (oldest !== undefined) state.ignoredCache.delete(oldest);
        }
        state.ignoredCache.set(path, result);
      }
    }
    return ignored;
  }

  // --- per-root hash cache ---------------------------------------------------

  private acquireCache(root: string): Map<string, HashCacheEntry> {
    const key = resolve(root);
    let shared = this.caches.get(key);
    if (!shared) {
      shared = { refs: 0, entries: new FileHashCache(), listingInFlight: new Map(), reconcileInFlight: null };
      this.caches.set(key, shared);
    }
    shared.refs += 1;
    return shared.entries;
  }

  private listingKey(priorityPaths: ReadonlySet<string>): string {
    return [...priorityPaths].map(portablePathForUpload).sort().join("\0");
  }

  private async listWorkspaceFilesShared(root: string, priorityPaths: ReadonlySet<string>): Promise<WorkspaceListing> {
    const shared = this.caches.get(resolve(root));
    if (!shared) return listWorkspaceFiles(root, priorityPaths);
    const key = this.listingKey(priorityPaths);
    let inFlight = shared.listingInFlight.get(key);
    if (!inFlight) {
      inFlight = listWorkspaceFiles(root, priorityPaths, MAX_RAW_LISTING_FILES);
      shared.listingInFlight.set(key, inFlight);
      void inFlight.finally(() => {
        if (shared.listingInFlight.get(key) === inFlight) shared.listingInFlight.delete(key);
      }).catch(() => undefined);
    }
    const raw = await inFlight;
    const limited = filterListing(raw.paths, priorityPaths, MAX_FILES);
    return {
      paths: limited.paths,
      denied: raw.denied,
      truncated: raw.truncated || limited.truncated,
      deniedPaths: raw.deniedPaths,
      overflowPaths: [...(raw.overflowPaths ?? []), ...(limited.overflowPaths ?? [])].slice(0, MAX_LISTED_EXCLUSIONS),
    };
  }

  private releaseCache(state: SessionState): void {
    const key = resolve(state.root);
    const shared = this.caches.get(key);
    if (!shared || shared.entries !== state.cache) return;
    shared.refs -= 1;
    if (shared.refs <= 0) this.caches.delete(key);
  }

  /** Shared per-root hash caches still held: none once every session on a root has finished. */
  cacheStatus(): { roots: number; entries: number } {
    let entries = 0;
    for (const shared of this.caches.values()) entries += shared.entries.size;
    return { roots: this.caches.size, entries };
  }

  /** Watcher, dirty-set and cache state of a session, for tests and profiling. */
  sessionDiagnostics(sessionId: string): {
    watchMode: SessionState["watchMode"];
    watchedPaths: string[];
    dirtyPaths: number;
    dirtyOverflow: boolean;
    manifestEntries: number;
    cacheEntries: number;
    journalEntries: number;
    traceEvents: number;
    lastChangeAt: number;
  } | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      watchMode: state.watchMode,
      watchedPaths: [...state.watchedPaths],
      dirtyPaths: state.dirty.size,
      dirtyOverflow: state.dirtyOverflow,
      manifestEntries: state.manifest?.size ?? 0,
      cacheEntries: state.cache.size,
      journalEntries: state.changeJournal.size,
      traceEvents: state.trace.length,
      lastChangeAt: state.lastChangeAt,
    };
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    for (const evidence of knownToolPathEvidence(type, data)) this.recordTouchedPath(state, evidence.path, evidence.relevance);
    if (type === SUBAGENT_MODEL_FALLBACK_TRACE) {
      const entry = subagentModelFallback(data);
      if (entry) {
        const list = state.subagentFallbacks.get(entry.child) ?? [];
        list.push(entry.fallback);
        state.subagentFallbacks.set(entry.child, list.slice(-32));
        while (state.subagentFallbacks.size > MAX_CHILD_SESSIONS) {
          state.subagentFallbacks.delete(state.subagentFallbacks.keys().next().value as string);
        }
      }
    }
    // A session's first trace event in this process follows the engine and
    // harness that ran it, like the CLI's `client.launch` (an opaque event
    // type, kept as sent); it shares the trace's event cap.
    if (!state.launchRecorded) {
      state.launchRecorded = true;
      this.appendTrace(state, "client.launch", clientLaunchData());
    }
    this.appendTrace(state, type, data);
    if (type === "turn.messages" && isRecord(data)) this.context?.turnMessages(sessionId, data.messages);
  }

  /** Appends one trace event, keeping only the newest MAX_UPLOAD_TRACE_EVENTS. */
  private appendTrace(state: SessionState, type: string, data?: unknown): void {
    state.trace.push({ at: new Date().toISOString(), type, ...(data === undefined ? {} : { data }) });
    if (state.trace.length > MAX_UPLOAD_TRACE_EVENTS) state.trace.splice(0, state.trace.length - MAX_UPLOAD_TRACE_EVENTS);
  }

  private recordTouchedPath(state: SessionState, candidate: string, relevance = 4): void {
    const path = workspaceRelativePath(state.root, candidate.replaceAll("\\", "/"));
    if (!path) return;
    this.reportTouched(state, path);
    const current = state.relevance.get(path);
    if (current === undefined || relevance < current) state.relevance.set(path, relevance);
    if (relevance === 0 && state.turnStartedAt !== null) state.turnWrittenPaths.set(path, Date.now());
    if (isUploadPathDenied(path) || state.touchedPaths.has(path)) return;
    state.touchedPaths.add(path);
    this.markDirty(state, path);
    this.queueChangedPath(state, path);
    this.scheduleChange(state, "fs_change");
  }

  /** Whether the session uploader is currently tracking this session. */
  hasSession(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return Boolean(state && !state.finished);
  }

  /**
   * Records the model the turn ran on (from the turn's first assistant
   * message) as a "session.model" event and remembers it for the envelope's
   * "session" block. Identical for omnirush.ai and every external provider.
   */
  recordSessionModel(sessionId: string, model: UploadSessionModel): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const clamp = (value: string | null) => (value ? clampUploadText(value, MAX_ENVIRONMENT_FIELD_CHARS) : null);
    const cleaned: UploadSessionModel = {
      provider_id: clamp(model.provider_id),
      model_id: clamp(model.model_id),
      variant: clamp(model.variant),
      agent: clamp(model.agent),
    };
    state.model = cleaned;
    this.appendTrace(state, "session.model", { ...cleaned });
    void this.persistOnceReady(state);
  }

  /** Per-child message checkpoints, so a resumed session only uploads new child messages. */
  async childCheckpoints(sessionId: string): Promise<Record<string, string>> {
    const state = this.sessions.get(sessionId);
    if (!state) return {};
    await state.ready;
    return Object.fromEntries(state.childCheckpoints);
  }

  /** Session ids of the subagent sessions known below this root session. */
  async childSessionIds(sessionId: string): Promise<string[]> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    await state.ready;
    return [...state.childSessionIds];
  }

  /**
   * Notes the subagent session ids seen below this root session while its
   * turn still runs: ids only (their messages still come when the turn
   * settles), kept in the ledger so the next envelope lists them even when
   * the app quits before the turn settles. Returns how many were new.
   */
  noteChildSessionIds(sessionId: string, ids: readonly string[]): number {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return 0;
    let added = 0;
    for (const id of ids) {
      if (id === sessionId || !/^[A-Za-z0-9._:-]{1,256}$/.test(id) || state.childSessionIds.includes(id)) continue;
      if (state.childSessionIds.length >= MAX_CHILD_SESSIONS) break;
      state.childSessionIds.push(id);
      added += 1;
    }
    if (added > 0) void this.persistOnceReady(state);
    return added;
  }

  /**
   * Records a task-tool subagent session (child, grandchild, ...) captured
   * once the root turn settled: one "session.child" event carrying the child's
   * new messages, plus the child's checkpoint for the next capture.
   */
  recordChildSession(sessionId: string, child: UploadChildSession): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(child.childSessionId)) return;
    if (!state.childSessionIds.includes(child.childSessionId)) {
      if (state.childSessionIds.length >= MAX_CHILD_SESSIONS) return;
      state.childSessionIds.push(child.childSessionId);
    }
    if (child.lastMessageId) state.childCheckpoints.set(child.childSessionId, child.lastMessageId);
    this.appendTrace(state, "session.child", {
      child_session_id: child.childSessionId,
      parent_session_id: child.parentSessionId,
      ...(Number.isSafeInteger(child.depth) && child.depth! >= 1 && child.depth! <= MAX_UPLOAD_CHILD_SESSION_DEPTH ? { depth: child.depth } : {}),
      title: child.title ? clampUploadText(child.title, MAX_GIT_SUBJECT_CHARS) : null,
      agent: child.agent ? clampUploadText(child.agent, MAX_ENVIRONMENT_FIELD_CHARS) : null,
      messages: withSubagentFallbacks(child.messages, state.subagentFallbacks.get(child.childSessionId)),
    });
    void this.persistOnceReady(state);
  }

  /**
   * Records a page the browser tools visited. Local, inline and
   * browser-internal URLs are never traced; page text is redacted and capped.
   * Returns whether the visit was recorded.
   */
  recordWebVisit(sessionId: string, visit: UploadWebVisit): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return false;
    if (typeof visit.url !== "string" || !isUploadableWebUrl(visit.url)) return false;
    const url = new URL(visit.url);
    url.username = "";
    url.password = "";
    const title = uploadTextForTrace(visit.title ?? null, MAX_WEB_VISIT_TITLE_CHARS * 4);
    const text = uploadTextForTrace(visit.text ?? null, MAX_UPLOAD_WEB_VISIT_TEXT_BYTES);
    this.appendTrace(state, "web.visit", {
      url: clampUploadText(redactUploadText(url.toString()).text, MAX_WEB_VISIT_URL_CHARS),
      title: title.text === null ? null : clampUploadText(title.text, MAX_WEB_VISIT_TITLE_CHARS),
      text: text.text,
      text_truncated: text.truncated,
    });
    return true;
  }

  /** Records a file attached to a prompt: identity, size, and redacted, capped text when extractable. */
  recordAttachment(sessionId: string, attachment: UploadAttachment): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const text = uploadTextForTrace(attachment.text, MAX_UPLOAD_ATTACHMENT_TEXT_BYTES);
    this.appendTrace(state, "attachment", {
      name: clampUploadText(redactUploadText(basename(attachment.name || "attachment")).text, MAX_ATTACHMENT_NAME_CHARS),
      mime: clampUploadText(attachment.mime || "application/octet-stream", MAX_ATTACHMENT_MIME_CHARS),
      bytes: Math.max(0, Math.floor(attachment.bytes)),
      sha256: attachment.sha256,
      text: text.text,
      text_truncated: text.truncated || attachment.textTruncated === true,
    });
  }

  private async persistOnceReady(state: SessionState): Promise<void> {
    try {
      await state.ready;
      if (!state.finished) await this.persistSession(state);
    } catch (error) {
      this.log("warn", "OmniRush session ledger update failed", {
        sessionId: state.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private sessionBlock(state: SessionState): UploadSessionBlock {
    return {
      provider_id: state.model?.provider_id ?? null,
      model_id: state.model?.model_id ?? null,
      variant: state.model?.variant ?? null,
      child_session_ids: [...state.childSessionIds],
    };
  }

  /**
   * Emits one "artifact" event per untracked file (gitignored ones outside the
   * regenerable folders too) the turn created or modified. Tracked files are already covered by the change
   * snapshot and touched_paths; this adds the outputs git would not list.
   */
  private async captureArtifacts(state: SessionState): Promise<void> {
    const baselinePromise = state.artifactBaseline;
    const current = await artifactStats(state.root);
    state.artifactBaseline = Promise.resolve(current);
    if (!baselinePromise) return;
    const baseline = await baselinePromise.catch(() => null);
    if (!baseline) return;
    let emitted = 0;
    for (const [path, stat] of current) {
      const previous = baseline.get(path);
      if (previous && sameFileSignature(previous, stat)) continue;
      // The turn's change snapshot must carry it even where no watcher saw it
      // land (a tool writing into a directory beyond MAX_WATCH_ROOTS).
      this.markDirty(state, path);
      this.reportTouched(state, path);
      state.relevance.set(path, 0);
      if (state.turnStartedAt !== null) state.turnWrittenPaths.set(path, Date.now());
      if (emitted >= MAX_ARTIFACT_EVENTS_PER_TURN || stat.size > MAX_ARTIFACT_HASH_BYTES) continue;
      try {
        const sha256 = await sha256File(resolve(state.root, path));
        this.appendTrace(state, "artifact", { path: portablePathForUpload(path), sha256, bytes: stat.size });
        state.touchedPaths.add(path);
        emitted += 1;
      } catch {
        // The file changed or disappeared while being hashed; the next turn sees its final form.
      }
    }
  }

  /**
   * Captures a change snapshot for an engine milestone: right as a prompt is
   * dispatched, or once a turn completes. When nothing changed since the last
   * snapshot only the trigger is recorded in the trace, so the backend still
   * sees the milestone without a redundant upload. `outcome: "aborted"`: the
   * turn was stopped by the user (Esc, Stop; the engine's
   * MessageAbortedError), recorded on its collector.trigger event (the
   * snapshot's own trigger stays turn_completed, which every backend takes).
   */
  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed", outcome?: TurnEndOutcome): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    if (trigger === "prompt") {
      state.relevance.clear();
      state.turnWrittenPaths.clear();
      // After the turn's artifact baseline (set just below) is listed.
      this.context?.turnStarted(sessionId, Promise.resolve().then(() => state.artifactBaseline));
    } else {
      this.context?.turnEnded(sessionId);
    }
    // The artifact baseline must reflect the workspace as the turn begins, not
    // once the queued start snapshot has finished uploading.
    if (trigger === "prompt") state.artifactBaseline = artifactStats(state.root);
    // So must the turn's start: what the agent writes while an earlier upload
    // still holds the queue belongs to this turn. It is the first whole
    // millisecond after the prompt: Date.now() rounds down, and a file written
    // just before may carry a later fraction of the same millisecond.
    if (trigger === "prompt") state.turnStartedAt = Date.now() + 1;
    const startedAt = state.turnStartedAt;
    state.turnInProgress = trigger === "prompt";
    // The milestone carries whatever edits were held back for another session's turn.
    state.changesHeld = false;
    if (state.changeTimer) {
      clearTimeout(state.changeTimer);
      state.changeTimer = null;
      state.changeTrigger = null;
    }
    this.enqueue(state, async () => {
      const previous = state.manifest;
      await this.captureChange(state, trigger, false, trigger === "turn_completed" && outcome === "aborted" ? outcome : undefined);
      const current = state.manifest;
      if (trigger === "turn_completed") {
        // A prompt sent since the turn ended (this job waited behind an
        // upload) began the next turn: what it wrote belongs to that one.
        const next = state.turnStartedAt !== startedAt ? state.turnStartedAt : null;
        if (!current || next === null) return this.recordTurnDiff(state, current, null);
        const taken = turnBaseline(current, next, [previous, state.turnManifest]);
        // A file nothing saw from before the next turn keeps its entry here.
        return this.recordTurnDiff(state, new Map([...taken].map(([path, entry]) => [path, entry ?? current.get(path)!])), next);
      }
      // The turn is measured from the workspace as its prompt found it.
      const forcePaths = new Set(
        [...state.turnWrittenPaths].filter(([, at]) => startedAt === null || at >= startedAt).map(([path]) => path),
      );
      state.turnManifest = current && turnBaseline(current, startedAt, [previous, state.turnManifest], forcePaths);
      for (const [path, at] of state.turnSkipped) if (startedAt !== null && at < startedAt) state.turnSkipped.delete(path);
    });
  }

  /**
   * Appends the "turn.diff" event of the turn that just completed: a unified
   * diff of the scrubbed texts of every file whose redacted digest moved
   * between the workspace the turn began on and `after` (added, modified,
   * deleted, or no_base when the text from before the turn is not held or
   * was never seen), and each binary or oversized file the turn wrote as
   * skipped, without content. The next turn is measured from here; the
   * skipped files of a next turn already under way (written since `next`,
   * its prompt) are left to it.
   */
  private async recordTurnDiff(state: SessionState, after: Manifest | null, next: number | null): Promise<void> {
    const before = state.turnManifest;
    const skipped = state.turnSkipped;
    state.turnManifest = after;
    state.turnSkipped = new Map(next === null ? [] : [...skipped].filter(([, at]) => at >= next));
    state.turnWrittenPaths = new Map(next === null ? [] : [...state.turnWrittenPaths].filter(([, at]) => at >= next));
    if (state.finished || !before || !after) return;
    const changes: TurnChange[] = [];
    if (before !== after) {
      for (const [path, entry] of after) {
        const previous = before.get(path);
        if (previous?.sha256 !== entry.sha256) changes.push({ path, before: previous ?? null, after: entry, unseen: previous === null });
      }
      for (const [path, entry] of before) if (!after.has(path)) changes.push({ path, before: entry, after: null, unseen: false });
    }
    for (const [path, at] of skipped) {
      if ((next === null || at < next) && !after.has(path) && !before.has(path)) changes.push({ path, before: null, after: null, unseen: false });
    }
    changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const builder = new TurnDiffBuilder();
    const pool = new ReadPool(1);
    const ancestors: AncestorCache = new Map();
    const yielder = new LoopYielder();
    for (const change of changes) {
      // Once no further diff fits (the event's cap, or the turn's diff time),
      // no text is read: an entry without one still goes in while it fits.
      const input = await this.turnDiffInput(state, change, pool, ancestors, !builder.full);
      if (input) builder.add(input);
      await yielder.pause();
    }
    this.appendTrace(state, "turn.diff", builder.finish());
  }

  /** The entry `change` makes, with its texts when `texts` is set (without, it only needs a status). */
  private async turnDiffInput(state: SessionState, change: TurnChange, pool: ReadPool, ancestors: AncestorCache, texts: boolean): Promise<TurnDiffInput | null> {
    const { path, before, after, unseen } = change;
    const input = {
      path: (after ?? before)?.uploadPath ?? portablePathForUpload(path),
      before_sha256: before?.sha256 ?? null,
      after_sha256: after?.sha256 ?? null,
      before: null,
      after: null,
    };
    if (after) {
      // Changed by the turn from a form the session uploader never saw: nothing to diff against.
      if (unseen) return { ...input, status: "no_base" };
      if (before && !(await this.bases.has(before.sha256))) return { ...input, status: "no_base" };
      if (!texts) return { ...input, status: before ? "modified" : "added" };
      const base = before ? await this.bases.get(before.sha256) : null;
      if (before && base === null) return { ...input, status: "no_base" };
      const text = await this.bases.get(after.sha256) ?? await this.rereadSentText(state, path, after, pool, ancestors);
      // Without the text after the turn (the file moved on since) there is nothing to diff.
      return { ...input, status: before ? "modified" : "added", before: text === null ? null : base, after: text };
    }
    // Gone from the manifest (or never in it): deleted, or a binary or oversized file now.
    const absolute = resolve(state.root, path);
    const file = await hasRealAncestors(state.root, path, ancestors) ? await lstat(absolute).catch(() => null) : null;
    if (!file) {
      if (!before) return null;
      if (!(await this.bases.has(before.sha256))) return { ...input, status: "no_base" };
      if (!texts) return { ...input, status: "deleted" };
      const base = await this.bases.get(before.sha256);
      return base === null ? { ...input, status: "no_base" } : { ...input, status: "deleted", before: base };
    }
    if (!file.isFile() || file.isSymbolicLink()) return null;
    if (file.size > MAX_UPLOAD_FILE_BYTES) return { ...input, after_sha256: null, status: "skipped", reason: "too_large" };
    if (!state.cache.get(path)?.binary && !(await startsBinary(absolute))) return null;
    return { ...input, after_sha256: null, status: "skipped", reason: "binary" };
  }

  /** The text a manifest entry describes when the base store no longer holds it: read again, if the file still hashes to it. */
  private async rereadSentText(state: SessionState, path: string, entry: HashCacheEntry, pool: ReadPool, ancestors: AncestorCache): Promise<string | null> {
    const read = await readUploadContent(state.root, path, state.cache, this.texts, this.metrics, pool, ancestors);
    if (!read || read.entry.sha256 !== entry.sha256) return null;
    this.bases.put(entry.sha256, read.content, entry.bytes);
    return read.content;
  }

  finishSession(sessionId: string, finalTrace?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const pendingTrace = state.trace.splice(0);
    if (finalTrace !== undefined) {
      for (const evidence of knownToolPathEvidence("session.completed", finalTrace)) {
        this.recordTouchedPath(state, evidence.path, evidence.relevance);
      }
      // Capture context: the turn's last messages (its tool calls) arrive here, not as turn.messages.
      if (isRecord(finalTrace)) this.context?.turnMessages(sessionId, finalTrace.messages, true);
    }
    state.finished = true;
    this.context?.sessionEnded(sessionId);
    if (state.changeTimer) clearTimeout(state.changeTimer);
    if (state.deferTimer) clearTimeout(state.deferTimer);
    state.changeTimer = null;
    state.deferTimer = null;
    this.stopReconcile(state);
    this.closeWatchers(state);
    // Journal captures still waiting on an ignore answer get it now, in one spawn.
    void this.flushIgnoreBatch(state);
    this.enqueue(state, async () => {
      await state.ready;
      // Capture context still collecting (bounded wait) rides along with the last trace.
      await this.context?.settled(sessionId);
      if (state.trace.length > 0) pendingTrace.push(...state.trace.splice(0));
      await state.changeCaptureTail;
      if (finalTrace !== undefined) pendingTrace.push({ at: new Date().toISOString(), type: "session.completed", data: finalTrace });
      try {
        await this.uploadTrace(state, pendingTrace);
        await this.uploadWorkspace(state, "end", "session_end");
      } finally {
        this.releaseCache(state);
        this.sessions.delete(sessionId);
        this.onSessionClosed?.(sessionId);
      }
    });
  }

  flushTrace(sessionId: string, finalTrace?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const pendingTrace = state.trace.splice(0);
    if (finalTrace !== undefined) {
      for (const evidence of knownToolPathEvidence("turn.completed", finalTrace)) {
        this.recordTouchedPath(state, evidence.path, evidence.relevance);
      }
      // Capture context: the turn's last messages (its tool calls) arrive here, not as turn.messages.
      if (isRecord(finalTrace)) this.context?.turnMessages(sessionId, finalTrace.messages, true);
      pendingTrace.push({ at: new Date().toISOString(), type: "turn.completed", data: finalTrace });
    }
    if (pendingTrace.length === 0) return;
    this.enqueue(state, async () => {
      await state.ready;
      if (state.trace.length > 0) pendingTrace.push(...state.trace.splice(0));
      await this.uploadTrace(state, pendingTrace);
    });
  }

  /** Resolves once every queued capture and upload for the session has settled, and its watchers are up. */
  async idle(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await state.changeCaptureTail.catch(() => undefined);
    await state.tail.catch(() => undefined);
    await state.watchSetup;
  }

  /** idle() for every session, including those still finishing. */
  async idleAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) await this.idle(sessionId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // A spooled upload in flight stays spooled for the next start.
    this.draining?.controller.abort();
    for (const sessionId of [...this.sessions.keys()]) this.finishSession(sessionId);
    await Promise.allSettled([...this.sessions.values()].map((state) => state.tail));
    await this.draining?.run.catch(() => undefined);
    await this.spoolTail.catch(() => undefined);
    await this.ledgerWriteTail.catch(() => undefined);
    await this.bases.flush().catch(() => undefined);
    this.texts.clear();
    if (!this.ledgerPath) await rm(this.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * A shutdown that ran out of time and has no worker thread to terminate
   * (capture-client.ts, capture in-process): every upload in flight, live or
   * from the spool, ends now, and any envelope still to go out is spooled
   * without being sent, all of it for the next start. stop() still settles
   * the sessions; this only keeps their uploads from outliving it by up to
   * an upload deadline.
   */
  abortUploads(): void {
    this.halted.abort(new DOMException("The capture is shutting down", "AbortError"));
  }

  private scheduleChange(state: SessionState, trigger: Extract<ChangeTrigger, "fs_change" | "periodic">): void {
    if (state.finished) return;
    if (!state.turnInProgress && this.turnOnRootElsewhere(state)) state.changesHeld = true;
    if (state.changeTimer) clearTimeout(state.changeTimer);
    // A filesystem change is the more specific reason; keep it when the
    // periodic scan also notices the same edit.
    state.changeTrigger = state.changeTrigger === "fs_change" ? "fs_change" : trigger;
    state.changeTimer = setTimeout(() => {
      state.changeTimer = null;
      const reason = state.changeTrigger ?? trigger;
      state.changeTrigger = null;
      this.enqueue(state, () => this.captureChange(state, reason));
    }, this.changeDebounceMs);
    state.changeTimer.unref?.();
  }

  /**
   * Runs one change capture. Nothing dirty, journaled or committed since the
   * last accepted snapshot means no scan at all. A prompt or turn milestone
   * captures at once; a filesystem or periodic trigger due inside the minimum
   * interval since the last change snapshot is deferred and merged with
   * whatever else arrives before the interval elapses.
   */
  private async captureChange(state: SessionState, trigger: ChangeTrigger, deferred = false, outcome?: TurnEndOutcome): Promise<void> {
    await state.ready;
    const milestone = trigger === "prompt" || trigger === "turn_completed";
    if (milestone && state.watchMode === "watching") await new Promise((resolvePromise) => setTimeout(resolvePromise, MILESTONE_SETTLE_MS));
    // Journal captures waiting on an ignore answer get it now rather than on the batch timer.
    void this.flushIgnoreBatch(state);
    await state.changeCaptureTail;
    // A finished session is about to upload its end snapshot, which already
    // carries everything a queued change capture would.
    if (state.finished) return;
    if (!milestone && this.changesLeftToOthers(state)) {
      this.metrics.capturesHeld += 1;
      return;
    }
    if (trigger === "turn_completed") {
      await this.captureArtifacts(state).catch((error: unknown) => {
        this.log("warn", "OmniRush artifact capture failed", {
          sessionId: state.id,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
    }
    if (!(await this.hasPendingChanges(state))) {
      this.metrics.capturesSkipped += 1;
      if (milestone) this.appendTrace(state, "collector.trigger", { trigger, captured: false, ...(outcome ? { outcome } : {}) });
      return;
    }
    const wait = !milestone && !deferred && state.lastChangeAt > 0 ? this.minChangeIntervalMs - (Date.now() - state.lastChangeAt) : 0;
    if (wait > 0) {
      this.deferChange(state, trigger, wait);
      return;
    }
    const captured = await this.uploadWorkspace(state, "change", trigger);
    if (milestone) this.appendTrace(state, "collector.trigger", { trigger, captured, ...(outcome ? { outcome } : {}) });
  }

  /** Whether another live session on `state`'s root has a turn in progress. */
  private turnOnRootElsewhere(state: SessionState): boolean {
    for (const other of this.sessions.values()) {
      if (other !== state && !other.finished && other.cache === state.cache && other.turnInProgress) return true;
    }
    return false;
  }

  /**
   * Whether a filesystem or periodic capture of `state` is left to the other
   * sessions open on its root, so that one agent's edits are not uploaded
   * again by every chat open on the same folder. It is when `state` has no
   * turn in progress and another session on the root has one, and, once
   * edits were held back that way, until `state`'s own next milestone
   * (which carries them) as long as another session on the root still
   * uploads its own changes. A session alone on its root is never held.
   */
  private changesLeftToOthers(state: SessionState): boolean {
    if (state.turnInProgress) return false;
    let uploading = false;
    let shared = false;
    for (const other of this.sessions.values()) {
      if (other === state || other.finished || other.cache !== state.cache) continue;
      if (other.turnInProgress) {
        state.changesHeld = true;
        return true;
      }
      shared = true;
      if (!other.changesHeld) uploading = true;
    }
    if (!shared) state.changesHeld = false;
    return state.changesHeld && uploading;
  }

  /** Whether anything could have moved since the last accepted snapshot; one `git rev-parse` at most. */
  private async hasPendingChanges(state: SessionState): Promise<boolean> {
    if (state.dirtyOverflow || state.watchMode !== "watching" || state.dirty.size > 0 || this.journalHasChanges(state)) return true;
    return (await gitHead(state.root)) !== state.lastHead;
  }

  private deferChange(state: SessionState, trigger: ChangeTrigger, wait: number): void {
    this.metrics.capturesDeferred += 1;
    // A filesystem change is the more specific reason; keep it over the periodic pass.
    if (state.deferTrigger !== "fs_change") state.deferTrigger = trigger;
    if (state.deferTimer) return;
    state.deferTimer = setTimeout(() => {
      state.deferTimer = null;
      const reason = state.deferTrigger ?? trigger;
      state.deferTrigger = null;
      this.enqueue(state, () => this.captureChange(state, reason, true));
    }, wait);
    state.deferTimer.unref?.();
  }

  /**
   * Whether the journal holds a real change against the last captured
   * manifest. Watchers replay events for files written just before they
   * started, and a traced read of an unchanged file is not an edit; neither
   * should cost an upload.
   */
  private journalHasChanges(state: SessionState): boolean {
    if (!state.manifest) return state.changeJournal.size > 0;
    for (const entry of state.changeJournal.values()) {
      const previous = state.manifest.get(entry.path)?.sha256;
      if (entry.status === "present" ? previous !== (entry.sha256 ?? sha256Hex(entry.content ?? "")) : previous !== undefined) {
        return true;
      }
    }
    return false;
  }

  private queueChangedPath(state: SessionState, filename: string): void {
    if (state.finished) return;
    const path = workspaceRelativePath(state.root, filename);
    if (!path || isUploadPathDenied(path)) return;
    // Several events for one path before its capture starts collapse into one read.
    if (state.pendingJournal.has(path)) return;
    state.pendingJournal.add(path);
    // The ignore check is registered as the event arrives, not when the
    // serial capture reaches the path, so a burst of events shares one spawn.
    // A path the manifest lists is checked too: the user may just have added
    // it to `.gitignore` or `.git/info/exclude`. (The snapshot asks git again
    // before any journal entry leaves; this check spares the read.)
    const ignored = this.checkIgnored(state, path);
    ignored.catch(() => undefined);
    state.changeCaptureTail = state.changeCaptureTail
      .catch(() => undefined)
      .then(async () => {
        state.pendingJournal.delete(path);
        if (await ignored) return;
        await this.captureChangedPath(state, path);
      })
      .catch((error: unknown) => {
        this.log("warn", "OmniRush changed-file capture failed", {
          sessionId: state.id,
          path,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  }

  private async captureChangedPath(state: SessionState, path: string): Promise<void> {
    if (state.finished) return;
    const absolute = resolve(state.root, path);
    // Outside the root (another drive), or reached through a symlinked
    // directory: a file outside the workspace (a traced read of
    // `linked/util.ts`), never journaled.
    if (workspaceRelativePath(state.root, path) === null || !(await hasRealAncestors(state.root, path))) return;
    let entry: ChangeJournalEntry;
    try {
      const file = await lstat(absolute);
      const written = writtenThisTurn(state.turnStartedAt, state.cache.get(path), file);
      if (written && state.turnStartedAt !== null) state.turnWrittenPaths.set(path, Date.now());
      if (file.isFile() && !file.isSymbolicLink() && file.size > MAX_CHANGE_JOURNAL_BYTES && written) state.turnSkipped.set(path, file.mtimeMs);
      if (!file.isFile() || file.isSymbolicLink()) {
        // A directory or a symlink is not a workspace file (the snapshot lists
        // neither): nothing to journal, and a file it replaced leaves the manifest.
        const previous = state.changeJournal.get(path);
        if (previous) {
          state.changeJournalBytes -= Buffer.byteLength(JSON.stringify(previous));
          state.changeJournal.delete(path);
        }
        return;
      }
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        entry = { path, at: new Date().toISOString(), status: "skipped" };
      } else if (file.size > MAX_CHANGE_JOURNAL_BYTES) {
        // Larger than the whole journal: it could only evict every other entry
        // and itself. The dirty set carries it to the next capture, so a file
        // appended to many times a second is not re-read and re-scrubbed per write.
        return;
      } else {
        const buffer = await readFile(absolute);
        this.metrics.fileReads += 1;
        if (buffer.length > MAX_UPLOAD_FILE_BYTES || binaryReason(path, buffer) !== null) {
          if (written) {
            state.turnWrittenPaths.set(path, Date.now());
            state.turnSkipped.set(path, file.mtimeMs);
          }
          entry = { path, at: new Date().toISOString(), status: "skipped" };
        } else {
          // The journal's read doubles as the snapshot's: the cache learns the
          // file now, so the next capture only stats it.
          const redacted = redactedCacheEntry(path, buffer, fileSignature(file), uploadPathFor(path, state.cache.get(path)), this.metrics, { cache: this.texts, absolute });
          state.cache.set(path, redacted.entry);
          entry = { path, at: new Date().toISOString(), status: "present", content: redacted.text, sha256: redacted.entry.sha256 };
        }
      }
    } catch {
      entry = { path, at: new Date().toISOString(), status: "deleted" };
    }
    const previous = state.changeJournal.get(path);
    if (previous) state.changeJournalBytes -= Buffer.byteLength(JSON.stringify(previous));
    state.changeJournal.set(path, entry);
    state.changeJournalBytes += Buffer.byteLength(JSON.stringify(entry));
    while (state.changeJournal.size > MAX_CHANGE_JOURNAL_ENTRIES || state.changeJournalBytes > MAX_CHANGE_JOURNAL_BYTES) {
      const oldest = state.changeJournal.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = state.changeJournal.get(oldest);
      if (removed) state.changeJournalBytes -= Buffer.byteLength(JSON.stringify(removed));
      state.changeJournal.delete(oldest);
    }
  }

  private acknowledgeJournal(state: SessionState, entries: ChangeJournalEntry[]): void {
    for (const entry of entries) {
      if (state.changeJournal.get(entry.path)?.at === entry.at) {
        state.changeJournal.delete(entry.path);
        state.changeJournalBytes -= Buffer.byteLength(JSON.stringify(entry));
      }
    }
  }

  private enqueue(state: SessionState, operation: () => Promise<void>): void {
    state.tail = state.tail.then(operation).catch((error: unknown) => {
      this.log("warn", "OmniRush session upload operation failed", {
        sessionId: state.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    });
  }

  private touchedPathsForUpload(state: SessionState): string[] {
    return [...state.touchedPaths].slice(0, MAX_TOUCHED_PATHS).map(portablePathForUpload);
  }

  /**
   * Captures one workspace snapshot. A start snapshot, a new session's or a
   * resumed one's, scans the whole tree and carries every eligible file's
   * content (files_scope "full", up to the cap): the backend stores no scope,
   * so a start is always the whole workspace. Change and end snapshots carry
   * only the files whose digest moved since the last accepted snapshot
   * (files_scope "changed") plus the full manifest and the changed paths. The
   * scan is targeted at the watcher's dirty set whenever that set is trusted,
   * and covers the whole tree otherwise. Resolves with whether a snapshot went
   * out.
   */
  private async uploadWorkspace(state: SessionState, type: Exclude<SnapshotType, "trace">, trigger: UploadTrigger): Promise<boolean> {
    const cache = state.cache;
    // Paths reported from here on belong to the next capture.
    const dirty = state.dirty;
    state.dirty = new Set();
    const previous = state.manifest;
    const targeted = type === "change" && !state.dirtyOverflow && state.watchMode === "watching";
    if (state.watchMode !== "polling") state.dirtyOverflow = false;
    let accepted = false;
    try {
      // git's current answer for everything this snapshot could carry that no
      // listing vouches for (the paths a targeted scan inspects, and every
      // journal entry), in one batch: nothing git ignores now leaves the
      // machine, whatever it answered when the event arrived.
      const reported = targeted && previous !== null ? [...dirty].filter((path) => !isUploadPathDenied(path)) : [];
      const journaled = type === "change" || type === "end" ? [...state.changeJournal.values()] : [];
      const checked = [...new Set([...reported, ...journaled.map((entry) => entry.path)])];
      const ignored = checked.length > 0 ? await this.ignoredPaths(state, checked, true) : new Set<string>();
      const journal = journaled.filter((entry) => !ignored.has(entry.path));
      if (journal.length < journaled.length) {
        const dropped = journaled.filter((entry) => ignored.has(entry.path));
        this.acknowledgeJournal(state, dropped);
        for (const entry of dropped) cache.delete(entry.path);
      }
      // Collect the cheap relevance evidence before the listing cap. A late
      // alphabetical path named by a tool or git status must not disappear
      // merely because the workspace has many files.
      const preGitPaths = targeted ? new Set<string>() : await gitPriorityPaths(state.root);
      const preScanPaths = new Set<string>([
        ...state.relevance.keys(),
        ...state.touchedPaths,
        ...preGitPaths,
      ].map(portablePathForUpload));
      const releaseScan = await GLOBAL_CAPTURE_ADMISSION.acquire(this.account.signal);
      let scan: ScanResult;
      try {
        scan = targeted && previous !== null
          ? await scanDirtyPaths(state.root, cache, this.texts, previous, reported, ignored, state.listing, this.metrics)
          : await scanWorkspaceFull(state.root, cache, this.texts, previous, type === "start", this.metrics,
            preScanPaths,
            type === "start" ? (paths) => this.installWatchers(state, paths) : undefined,
            () => this.listWorkspaceFilesShared(state.root, preScanPaths));
      } finally {
        releaseScan();
      }
      // Capture v2: the binary files and symlinks the manifest lists next to the text files.
      const extraEntries = scan.extrasScope === "full" ? new Map(scan.extras) : new Map(state.extras);
      if (scan.extrasScope !== "full") {
        for (const path of scan.extrasScope) extraEntries.delete(path);
        for (const path of ignored) extraEntries.delete(path);
        for (const [path, entry] of scan.extras) extraEntries.set(path, entry);
      }
      // A binary file goes to the byte-exact project archive (never as text).
      for (const [path, entry] of extraEntries) if (entry.kind === "binary") this.onBinaryFile?.(state.id, path);
      // What moved on disk since the last snapshot, where no watcher may have
      // seen it (a polled workspace). Only against an accepted snapshot: with
      // none yet (the start one was refused), every file counts as changed.
      if (previous !== null) {
        for (const path of scan.changed ?? []) {
          this.reportTouched(state, path);
          if (state.turnStartedAt !== null) state.turnWrittenPaths.set(path, Date.now());
        }
      }
      // A change capture that found nothing moved stops at one `git rev-parse`
      // (a commit changes history without touching a file); the full git block
      // with its status, log and diff is read only for a snapshot that goes out.
      if (type === "change" && scan.changed !== null && scan.changed.size === 0 && scan.removed === 0 && !this.journalHasChanges(state)
        && (await gitHead(state.root)) === state.lastHead) {
        accepted = true;
        return false;
      }
      // Its status and diff name the files a capped snapshot must keep.
      const git = await collectGitBlock(state.root);
      const gitPaths = new Set<string>([
        ...preGitPaths,
        ...snapshotPriorityPaths([], git),
      ]);
      const candidates = candidatesFor(scan, state.relevance, gitPaths);
      // A full listing names the gitignored files too: a denied one (a gitignored
      // `.env`) is left out for privacy and counted with the denied files, so
      // denied_file_count and excluded_files' privacy count agree.
      const ignoredListing = !(targeted && previous !== null) ? await listGitIgnored(state.root) : null;
      const deniedCount = scan.deniedCount + (ignoredListing ?? []).filter((path) => isUploadPathDenied(path.replace(/\/$/, ""))).length;
      // The last snapshot waits briefly for a collection still running (toolchain.ts).
      const environment = await this.sessionEnvironment(state.root, state.id, type === "end" ? FINAL_TOOLCHAIN_WAIT_MS : undefined);
      const rootName = workspaceRootName(state.root);
      const touchedPaths = this.touchedPathsForUpload(state);
      const metadata = JSON.stringify({
        schema_version: UPLOAD_SCHEMA_VERSION,
        workspace_id: state.workspaceId,
        session_id: state.id,
        session_segment: state.segment,
        session_resumed: state.resumed,
        trigger,
        touched_paths: touchedPaths,
        ...PRIVACY_POLICY,
        denied_file_count: deniedCount,
        root_name: rootName,
        git: { commit: git?.commit ?? null, branch: git?.branch ?? null, dirty: git ? String(git.dirty) : "false" },
      });
      const leading: UploadFile[] = [{ path: "__omnirush__/workspace.json", content: metadata, sha256: sha256Hex(metadata) }];
      if (journal.length > 0) {
        const changes = JSON.stringify({
          schema_version: 1,
          session_id: state.id,
          entries: journal.map((entry) => ({ ...entry, path: portablePathForUpload(entry.path) })),
        });
        leading.push({ path: "__omnirush__/changes.json", content: changes, sha256: sha256Hex(changes) });
      }
      const filesScope: "full" | "changed" = type === "start" ? "full" : "changed";
      const extras: Record<string, unknown> = {
        workspace: { root_name: rootName, git, ...(git ? {} : await gitSkippedField()), ...(type === "start" && !git ? await projectArchiveField(state.root) : {}) },
        environment,
        touched_paths: touchedPaths,
        files_scope: filesScope,
        ...(filesScope === "changed" ? { changed_paths: candidates.map((candidate) => candidate.uploadPath) } : {}),
      };
      // Everything around files[] is measured (the manifest entry by entry, so
      // it never has to exist as one string); the rest of the cap is content.
      let fixedBytes = serializedBytes(extras) + SNAPSHOT_WRAPPER_MARGIN_BYTES;
      for (const file of leading) fixedBytes += serializedBytes(file) + 1;
      for (const entry of scan.manifest.values()) fixedBytes += Buffer.byteLength(manifestEntryJson(entry)) + 1;
      for (const entry of extraEntries.values()) fixedBytes += Buffer.byteLength(manifestEntryJson(entry)) + 1;
      const budget = Math.max(0, this.snapshotMaxBytes - fixedBytes);
      const selection = selectSnapshotContent(candidates, budget);
      const capOmitted: SnapshotCandidate[] = [];
      // excluded_files gets what the content budget left plus a slice of the
      // wrapper margin (EXCLUDED_FILES_MARGIN_BYTES), so a full snapshot still lists some.
      let contentUsed = 0;
      let omittedCount = selection.omittedCount;
      let omittedBytes = selection.omittedBytes;
      const manifest = scan.manifest;
      const uploaded = await this.uploadEnvelope(state, type, trigger, {
        extras,
        writeFiles: async (emit) => {
          for (const file of leading) await emit(file);
          let reserved = 0;
          for (const candidate of candidates) {
            if (selection.selected.has(candidate.path)) reserved += candidate.cost;
          }
          let used = 0;
          const yielder = new LoopYielder();
          const pool = new ReadPool(1);
          const ancestors: AncestorCache = new Map();
          for (const candidate of candidates) {
            if (!selection.selected.has(candidate.path)) continue;
            reserved -= candidate.cost;
            const read = await readUploadContent(state.root, candidate.path, cache, this.texts, this.metrics, pool, ancestors);
            await yielder.pause();
            // Changed underneath the scan; the next snapshot sees its final form.
            if (!read) continue;
            const cost = candidateCost(read.entry);
            if (used + cost + reserved > budget) {
              omittedCount += 1;
              omittedBytes += read.entry.bytes;
              capOmitted.push(candidate);
              continue;
            }
            // files[] and the manifest describe the same bytes even if the
            // file moved between the scan and this read.
            if (read.entry.sha256 !== manifest.get(candidate.path)?.sha256) manifest.set(candidate.path, read.entry);
            await emit({ path: candidate.uploadPath, content: read.content, sha256: read.entry.sha256 });
            used += cost;
            contentUsed = used;
            this.bases.put(read.entry.sha256, read.content, read.entry.bytes);
            await this.bases.writable();
          }
        },
        manifest: function* () {
          yield* manifest.values();
          yield* extraEntries.values();
        },
        privacy: () => ({
          ...PRIVACY_POLICY,
          denied_file_count: deniedCount,
          manifest_truncated: scan.manifestTruncated,
          files_truncated: omittedCount > 0,
          diff_truncated: git?.diff_truncated ?? false,
          snapshot_cap_omitted_count: omittedCount,
          snapshot_cap_omitted_bytes: omittedBytes,
          binary_file_count: scan.binaryPaths?.size ?? 0,
          too_large_file_count: scan.tooLargePaths?.size ?? 0,
        }),
        trailer: async () => ({
          excluded_files: await this.excludedFiles(state.root, scan, [
            ...candidates.filter((candidate) => !selection.selected.has(candidate.path)),
            ...capOmitted,
          ], ignoredListing, budget - contentUsed + EXCLUDED_FILES_MARGIN_BYTES),
        }),
      });
      if (omittedCount > 0) {
        this.appendTrace(state, "collector.snapshot_cap", {
          snapshot_type: type,
          trigger,
          omitted_count: omittedCount,
          omitted_bytes: omittedBytes,
          budget_bytes: budget,
        });
        this.log("warn", "OmniRush session upload snapshot trimmed to the snapshot cap", {
          sessionId: state.id,
          snapshotType: type,
          trigger,
          omittedCount,
          omittedBytes,
          budgetBytes: budget,
        });
      }
      if (!uploaded) return false;
      // The baseline is the last *accepted* manifest (uploaded or spooled): the
      // next change snapshot reports exactly what moved since this one.
      accepted = true;
      state.manifest = manifest;
      state.extras = extraEntries;
      state.turnManifest ??= turnBaseline(manifest, state.turnStartedAt, [previous]);
      state.listing = { denied: scan.deniedCount, truncated: scan.manifestTruncated };
      state.lastHead = git?.commit ?? null;
      if (journal.length > 0) this.acknowledgeJournal(state, journal);
      if (type === "change") state.lastChangeAt = Date.now();
      return true;
    } finally {
      // Nothing was accepted: the same files must go out with the next capture.
      if (!accepted) this.markDirtyOverflow(state);
    }
  }

  private async uploadTrace(state: SessionState, events: TraceEvent[]): Promise<void> {
    if (events.length === 0) return;
    // A session imported from the opencode 2.x engine's store says so in each
    // trace upload (an opaque event type: kept as sent), so a reader can tell
    // why its earlier turns look like 2.x (engine2/imported.ts).
    const importedFrom = engine2ImportedFrom(state.id);
    const traceEvents: TraceEvent[] = importedFrom
      ? [{ at: events[0]!.at, type: "session.imported", data: { from: importedFrom } }, ...events]
      : events;
    let schemaVersion = await this.negotiatedTraceSchema();
    let downgraded = false;
    const batches = boundedTraceBatches(state, traceEvents, MAX_TRACE_BYTES);
    for (const batch of batches) {
      const makeBody = async (version: 2 | 3): Promise<EnvelopeBody> => ({
          schemaVersion: version,
          extras: {
            workspace: { root_name: workspaceRootName(state.root), git: null, ...(await gitSkippedField()) },
            environment: await this.sessionEnvironment(state.root, state.id),
            touched_paths: this.touchedPathsForUpload(state),
            files_scope: "full",
          },
          writeFiles: version === TRACE_SCHEMA_VERSION
            ? async () => undefined
            : async (emit) => {
                await emit({ path: "__omnirush__/trace.json", content: batch.content, sha256: sha256Hex(batch.content) });
              },
          manifest: () => [],
          privacy: () => ({ ...PRIVACY_POLICY }),
          trace: batch.events,
        });
      let uploaded = await this.uploadEnvelope(state, "trace", "trace_flush", await makeBody(schemaVersion));
      if (uploaded === "unsupported_schema" && schemaVersion === TRACE_SCHEMA_VERSION && !downgraded) {
        downgraded = true;
        schemaVersion = 2;
        this.downgradeTraceSchema();
        uploaded = await this.uploadEnvelope(state, "trace", "trace_flush", await makeBody(schemaVersion));
      }
    }
  }

  /**
   * One POST of an envelope, ended by `deadline` (the attempt's size-scaled
   * deadline, session-upload-budget.ts: fetch reports no upload progress, so
   * sending the body and the gateway's answer share one deadline) or sooner
   * by `cancel`.
   */
  private uploadPathOwned(path: string): boolean {
    const absolute = resolve(path);
    return [this.tempDir, this.spoolDir]
      .filter((directory): directory is string => directory !== null)
      .some((directory) => {
        const relativePath = relative(resolve(directory), absolute);
        return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.includes(sep + sep);
      });
  }

  private async validateCompressedArtifact(compressed: CompressedArtifact): Promise<void> {
    if (!this.uploadPathOwned(compressed.path)) throw new Error("session upload artifact is outside its owned directory");
    const file = await lstat(compressed.path);
    if (!file.isFile() || file.isSymbolicLink() || file.size !== compressed.size) {
      throw new Error("session upload artifact changed or is not a regular file");
    }
  }

  private async send(sessionId: string, compressed: Uint8Array | CompressedArtifact, deadline: AbortSignal, cancel?: AbortSignal): Promise<Response> {
    const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline;
    if (signal.aborted) return Promise.reject(signal.reason);
    if ("path" in compressed) {
      await this.validateCompressedArtifact(compressed);
      if (this.fileUploader) return untilAborted(this.fileUploader(sessionId, compressed.path, compressed.size, signal), signal);
      if (!this.uploader) {
        const body = fileReadableBody(compressed.path, signal);
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/zstd",
            "X-OmniRush-Session-ID": sessionId,
          },
          body,
          duplex: "half",
          signal,
        };
        return this.fetcher(this.uploadUrl!, init);
      }
      return untilAborted(readFile(compressed.path).then((bytes) => this.uploader!(sessionId, bytes, signal)), signal);
    }
    if (this.uploader) return untilAborted(this.uploader(sessionId, compressed, signal), signal);
    return this.fetcher(this.uploadUrl!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/zstd",
        "X-OmniRush-Session-ID": sessionId,
      },
      body: compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer,
      signal,
    });
  }

  /** Asks the account layer for a fresh bearer; false when none arrived. */
  private async refreshToken(): Promise<{ refreshed: boolean; error?: string }> {
    if (!this.refreshAccessToken) return { refreshed: false };
    try {
      const token = (await this.refreshAccessToken())?.trim() ?? "";
      if (!token) return { refreshed: false };
      this.token = token;
      return { refreshed: true };
    } catch (error) {
      return { refreshed: false, error: error instanceof Error ? error.message : "unknown" };
    }
  }

  /**
   * Sends an envelope, up to `attempts` times. A quick failure (a dropped
   * connection, a 5xx) is tried again after a short delay; an attempt that
   * ran out its deadline is not: at a size-scaled deadline one more attempt
   * could hold the session's queue for many minutes, so the envelope goes to
   * the spool at once and the spool drain retries it on its own backoff.
   */
  private async transmit(
    sessionId: string,
    compressed: Uint8Array | CompressedArtifact,
    attempts = UPLOAD_ATTEMPTS,
    cancel?: AbortSignal,
    schemaVersion: 2 | 3 = 2,
  ): Promise<TransmitOutcome> {
    const timeoutMs = sessionUploadTimeoutMs("path" in compressed ? compressed.size : compressed.byteLength, this.uploadBudget);
    let lastReason = "session upload unavailable";
    let refreshAttempted = false;
    let attempt = 0;
    while (attempt < attempts) {
      // Each attempt, the retry with a refreshed bearer too, gets a deadline of its own.
      const deadline = AbortSignal.timeout(timeoutMs);
      try {
        const response = await this.send(sessionId, compressed, deadline, cancel);
        if (response.ok) return { ok: true };
        lastReason = `sessionUploader upload failed with status ${response.status}`;
        if (UNAUTHORIZED_STATUSES.has(response.status)) {
          // The sign-in gate is final: nothing is queued for an account that
          // is gone. Any other rejection is a device token the gateway broker
          // rotates moments later, so the upload gets one fresh token and one
          // more try, and is spooled rather than dropped if still refused.
          if (await responseSignalsAccountRequired(response)) {
            return { ok: false, retryable: false, reason: `${lastReason} (${ACCOUNT_REQUIRED_MARKER})` };
          }
          if (refreshAttempted) return { ok: false, retryable: true, reason: lastReason };
          refreshAttempted = true;
          const refresh = await this.refreshToken();
          this.log("warn", "OmniRush session upload rejected as unauthorized", {
            sessionId,
            status: response.status,
            refreshed: refresh.refreshed,
            ...(refresh.error ? { refreshError: refresh.error } : {}),
          });
          if (!refresh.refreshed) return { ok: false, retryable: true, reason: lastReason };
          // The retry with the fresh token is not one of the transport attempts.
          continue;
        }
        if (response.status === 422 && schemaVersion === TRACE_SCHEMA_VERSION && await responseSignalsUnsupportedSchema(response)) {
          return { ok: false, retryable: false, reason: lastReason, unsupportedSchema: true };
        }
        await response.body?.cancel().catch(() => undefined);
        const retryAfter = retryAfterMs(response.headers?.get?.("retry-after"));
        if (!isRetryableUploadStatus(response.status, retryAfter)) return { ok: false, retryable: false, reason: lastReason };
        // A full disk (507) or a server that said when to come back is not
        // asked again within the second: the spool sends it after its backoff
        // (and not before the Retry-After), now or at the next start.
        if (retryAfter !== null || response.status === 507 || response.status === 413) {
          return { ok: false, retryable: true, reason: lastReason, ...(retryAfter !== null ? { retryAfterMs: retryAfter } : {}) };
        }
      } catch (error) {
        lastReason = error instanceof Error ? error.message : "session upload unavailable";
        if (cancel?.aborted) return { ok: false, retryable: true, reason: lastReason };
        // Out of time: this attempt's deadline, or the gateway broker's own
        // (the same size-scaled budget, reported across the worker boundary by name).
        if (deadline.aborted || (error instanceof Error && error.name === "TimeoutError")) {
          return { ok: false, retryable: true, reason: lastReason };
        }
      }
      attempt += 1;
      if (attempt < attempts && !cancel?.aborted) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, this.uploadRetryDelayMs * 2 ** (attempt - 1)));
      }
    }
    return { ok: false, retryable: true, reason: lastReason };
  }

  private async envelopeTempPath(): Promise<string> {
    await this.stateMigrated;
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    return join(this.tempDir, `${spoolId(++this.spoolCounter)}.zst.tmp`);
  }

  /** Removes envelope temp files a crashed process left behind. */
  private async cleanTempDir(olderThanMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.tempDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - olderThanMs;
    for (const name of names) {
      if (!name.endsWith(".zst.tmp")) continue;
      const path = join(this.tempDir, name);
      try {
        if ((await lstat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // Already gone, or in use by another instance.
      }
    }
  }

  /**
   * Streams one envelope through zstd into a temp file under the state
   * directory, uploads the compressed bytes from that file and deletes it; a
   * retryable failure moves the file into the spool instead. Resolves with
   * whether the envelope was accepted (delivered or spooled).
   */
  private async uploadEnvelope(
    state: SessionState,
    snapshotType: SnapshotType,
    trigger: UploadTrigger,
    body: EnvelopeBody,
  ): Promise<boolean | "unsupported_schema"> {
    if (!this.uploadUrl && !this.uploader && !this.fileUploader) return false;
    const sequence = state.sequence + 1;
    const path = await this.envelopeTempPath();
    const writer = new EnvelopeWriter(path);
    let fileCount = 0;
    let compressedBytes: number;
    try {
      const head = JSON.stringify({
        schema_version: body.schemaVersion ?? UPLOAD_SCHEMA_VERSION,
        session_id: state.id,
        session_segment: state.segment,
        session_resumed: state.resumed,
        sequence,
        snapshot_type: snapshotType,
        trigger,
        captured_at: new Date().toISOString(),
        session: this.sessionBlock(state),
        ...body.extras,
      });
      await writer.write(`${head.slice(0, -1)},"files":[`);
      await body.writeFiles(async (file) => {
        await writer.write(`${fileCount > 0 ? "," : ""}${JSON.stringify(file)}`);
        fileCount += 1;
      });
      await writer.write('],"manifest":[');
      let first = true;
      for (const entry of body.manifest()) {
        await writer.write(`${first ? "" : ","}${manifestEntryJson(entry)}`);
        first = false;
      }
      await writer.write(`],"privacy":${JSON.stringify(body.privacy())}`);
      for (const [key, value] of Object.entries(body.trailer ? await body.trailer() : {})) {
        await writer.write(`,${JSON.stringify(key)}:${JSON.stringify(value)}`);
      }
      if (body.trace) {
        await writer.write(',"trace":[');
        for (let index = 0; index < body.trace.length; index += 1) {
          await writer.write(`${index > 0 ? "," : ""}${JSON.stringify(body.trace[index]) ?? "null"}`);
        }
        await writer.write("]");
      }
      await writer.write("}");
      compressedBytes = await writer.finish();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    this.metrics.envelopesWritten += 1;
    const bytes = writer.bytes;
    try {
      if (bytes > this.snapshotMaxBytes) {
        // The backend answers an oversized envelope with 422, which is never
        // retried. The scan budget keeps this from happening; reaching it means
        // the wrapper outgrew its margin, which deserves a loud line here rather
        // than a lost upload and a rejection upstream.
        this.log("warn", "OmniRush session upload payload exceeded the snapshot cap", {
          sessionId: state.id,
          snapshotType,
          trigger,
          bytes,
          capBytes: this.snapshotMaxBytes,
        });
        return false;
      }
      if (compressedBytes > MAX_COMPRESSED_BYTES) {
        this.log("warn", "OmniRush session upload payload exceeded compressed limit", { sessionId: state.id, snapshotType, trigger });
        return false;
      }
      const compressed: CompressedArtifact = { path, size: compressedBytes };
      const account = this.account.signal;
      const uploadSignal = AbortSignal.any([account, this.halted.signal]);
      const spoolArtifact = async (reason: string, retryAfter?: number): Promise<boolean> => {
        const spooled = await this.spoolEnvelopeFile({
          id: "", session_id: state.id, snapshot_type: snapshotType, trigger, sequence, bytes: compressedBytes, created_at: new Date().toISOString(), attempts: 1,
          ...(retryAfter !== undefined ? { not_before: new Date(Date.now() + retryAfter).toISOString() } : {}),
        }, path, account);
        if (!spooled) {
          // Signed out during the upload: the envelope is deleted, never queued for the next account.
          this.log("info", "OmniRush session upload artifact discarded at sign-out", { sessionId: state.id, snapshotType, trigger, sequence });
          return false;
        }
        state.sentBytes += bytes;
        state.sequence = sequence;
        state.failureCount += 1;
        state.lastFailureAt = new Date().toISOString();
        await this.persistSession(state).catch(() => undefined);
        this.log("warn", "OmniRush session upload artifact spooled for retry", {
          sessionId: state.id,
          snapshotType,
          trigger,
          sequence,
          compressedBytes,
          reason,
        });
        this.retryFailures += 1;
        this.scheduleRetry();
        return true;
      };
      let releaseUpload: (() => void) | null = null;
      try {
        releaseUpload = await GLOBAL_CAPTURE_ADMISSION.acquire(uploadSignal);
      } catch (error) {
        if (!this.halted.signal.aborted || account.aborted) throw error;
        return await spoolArtifact("capture shutdown");
      }
      let outcome: TransmitOutcome;
      try {
        outcome = await this.transmit(state.id, compressed, UPLOAD_ATTEMPTS, uploadSignal, body.schemaVersion ?? UPLOAD_SCHEMA_VERSION);
      } finally {
        releaseUpload();
      }
      if (!outcome.ok && outcome.unsupportedSchema) return "unsupported_schema";
      if (!outcome.ok) {
        if ((!outcome.retryable || !this.spoolDir) && !account.aborted) {
          await this.recordLedgerOutcome(state.id, "failure").catch(() => undefined);
          throw new Error(outcome.reason);
        }
        return await spoolArtifact(outcome.reason, outcome.retryAfterMs);
      }
      state.sentBytes += bytes;
      state.sequence = sequence;
      state.lastSuccessAt = new Date().toISOString();
      await this.persistSession(state).catch((error: unknown) => {
        this.log("warn", "OmniRush session ledger update failed", {
          sessionId: state.id,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
      this.log("info", "OmniRush session upload artifact uploaded", {
        sessionId: state.id,
        snapshotType,
        trigger,
        sequence,
        fileCount,
        compressedBytes,
      });
      return true;
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  // --- durable retry spool -------------------------------------------------

  private spoolLocked<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.spoolTail.catch(() => undefined).then(() => this.stateMigrated).then(operation);
    this.spoolTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async listSpool(): Promise<SpoolMeta[]> {
    if (!this.spoolDir) return [];
    await this.stateMigrated;
    let names: string[];
    try {
      names = await readdir(this.spoolDir);
    } catch {
      return [];
    }
    const entries: SpoolMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const meta = parseSpoolMeta(JSON.parse(await readFile(join(this.spoolDir, name), "utf8")));
        if (!meta || meta.id !== id) throw new Error("invalid spool entry");
        await lstat(join(this.spoolDir, `${id}.zst`));
        entries.push(meta);
      } catch {
        await this.removeSpoolEntry(id);
      }
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async removeSpoolEntry(id: string): Promise<void> {
    if (!this.spoolDir) return;
    await Promise.all([
      rm(join(this.spoolDir, `${id}.json`), { force: true }),
      rm(join(this.spoolDir, `${id}.zst`), { force: true }),
    ]).catch(() => undefined);
  }

  private async writeSpoolMeta(meta: SpoolMeta): Promise<void> {
    await writePrivateFileAtomic(join(this.spoolDir!, `${meta.id}.json`), JSON.stringify(meta));
  }

  /**
   * Moves an already-compressed envelope file into the spool (same
   * filesystem: a rename, no copy). Resolves false, the file deleted, when
   * the account it was captured for signed out (checked under the spool
   * lock, so clearSpool() never runs between the check and the move).
   */
  private spoolEnvelopeFile(meta: SpoolMeta, sourcePath: string, account: AbortSignal): Promise<boolean> {
    return this.spoolLocked(async () => {
      if (!this.spoolDir || account.aborted) {
        await rm(sourcePath, { force: true }).catch(() => undefined);
        return false;
      }
      await mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
      const id = spoolId(++this.spoolCounter);
      const target = join(this.spoolDir, `${id}.zst`);
      try {
        await rename(sourcePath, target);
      } catch {
        await writePrivateFileAtomic(target, await readFile(sourcePath));
      }
      await this.writeSpoolMeta({ ...meta, id });
      await this.enforceSpoolBounds();
      return true;
    });
  }

  private async enforceSpoolBounds(): Promise<void> {
    const entries = await this.listSpool();
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (count <= this.spoolMaxEntries && total <= this.spoolMaxBytes) break;
      await this.removeSpoolEntry(entry.id);
      total -= entry.bytes;
      count -= 1;
      this.log("warn", "OmniRush session upload spool dropped its oldest entry", {
        sessionId: entry.session_id,
        snapshotType: entry.snapshot_type,
        sequence: entry.sequence,
      });
    }
  }

  private scheduleRetry(delayMs?: number): void {
    if (!this.spoolDir || this.stopped || this.retryTimer) return;
    // Never past the retry cap: a delay computed from a spool entry dated in
    // the future (the clock went back) must not park the spool for days, or
    // overflow setTimeout into a 1 ms loop.
    const delay = Math.min(this.retryMaxMs, Math.max(0, delayMs ?? this.jitteredBackoffMs()));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drainSpool().catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  /** The wait after `failures` failures in a row: the retry base, doubling up to the retry cap. */
  private backoffMs(failures: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, failures - 1));
  }

  private jitteredBackoffMs(): number {
    return Math.round(this.backoffMs(this.retryFailures) * (0.85 + Math.random() * 0.3));
  }

  /**
   * When a spooled entry may be sent again: at once until a drain has tried
   * it, then after its own backoff (its first attempt was the upload that
   * spooled it).
   */
  private spoolEntryDueAt(entry: SpoolMeta): number {
    const now = Date.now();
    // Never before a Retry-After the server gave (unless the clock went back past it by more than the cap).
    const notBefore = entry.not_before ? Date.parse(entry.not_before) : Number.NaN;
    const floor = Number.isFinite(notBefore) && notBefore - now <= MAX_RETRY_AFTER_MS ? notBefore : 0;
    const last = entry.last_attempt_at ? Date.parse(entry.last_attempt_at) : Number.NaN;
    if (!Number.isFinite(last)) return floor;
    // A last attempt after now means the clock went back: due at once, and
    // the attempt then records a sane time.
    return Math.max(floor, last > now ? 0 : last + this.backoffMs(entry.attempts - 1));
  }

  /**
   * Delivers spooled uploads oldest first. An entry that fails waits out its
   * own backoff while the entries behind it go on, so one upload that keeps
   * failing holds back no other; a drain stops trying after
   * MAX_DRAIN_FAILURES failures and leaves the rest to the next one. The
   * gateway orders a session's envelopes by their capture sequence, not by
   * arrival. Uploads run outside the spool lock, so spooling, spoolStatus()
   * and clearSpool() never wait for one; stop() and clearSpool() abort it.
   * A call while a drain runs gets one more drain right after it, for
   * entries spooled since that one listed the spool.
   */
  drainSpool(): Promise<{ delivered: number; pending: number }> {
    if (this.draining) {
      this.drainQueued ??= this.draining.run.catch(() => undefined).then(() => {
        this.drainQueued = null;
        return this.drainSpool();
      });
      return this.drainQueued;
    }
    const controller = new AbortController();
    const run = this.runDrain(AbortSignal.any([controller.signal, this.halted.signal])).finally(() => {
      if (this.draining?.controller === controller) this.draining = null;
    });
    this.draining = { run, controller };
    return run;
  }

  private async runDrain(signal: AbortSignal): Promise<{ delivered: number; pending: number }> {
    let delivered = 0;
    const spoolDir = this.spoolDir;
    if (!spoolDir || !this.enabled) return { delivered, pending: 0 };
    const entries = await this.spoolLocked(() => this.listSpool());
    let pending = entries.length;
    let failures = 0;
    let nextDueAt = Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      if (this.stopped || signal.aborted) break;
      const dueAt = this.spoolEntryDueAt(entry);
      if (failures >= MAX_DRAIN_FAILURES || dueAt > Date.now()) {
        nextDueAt = Math.min(nextDueAt, dueAt);
        continue;
      }
      let compressed: CompressedArtifact;
      try {
        const spoolPath = join(spoolDir, `${entry.id}.zst`);
        const file = await stat(spoolPath);
        if (!file.isFile() || file.size !== entry.bytes) throw new Error("spool artifact size changed");
        compressed = { path: spoolPath, size: file.size };
      } catch {
        await this.spoolLocked(() => this.removeSpoolEntry(entry.id));
        pending -= 1;
        continue;
      }
      const releaseUpload = await GLOBAL_CAPTURE_ADMISSION.acquire(signal);
      let outcome: TransmitOutcome;
      try {
        outcome = await this.transmit(entry.session_id, compressed, 1, signal);
      } finally {
        releaseUpload();
      }
      if (outcome.ok) {
        await this.spoolLocked(() => this.removeSpoolEntry(entry.id));
        await this.recordLedgerOutcome(entry.session_id, "success").catch(() => undefined);
        this.retryFailures = 0;
        delivered += 1;
        pending -= 1;
        this.log("info", "OmniRush session upload artifact delivered from spool", {
          sessionId: entry.session_id,
          snapshotType: entry.snapshot_type,
          trigger: entry.trigger,
          sequence: entry.sequence,
          attempts: entry.attempts + 1,
        });
        continue;
      }
      // Stopped or signed out mid-upload: the entry stays as it was, or goes with the spool.
      if (signal.aborted) break;
      if (!outcome.retryable || entry.attempts + 1 >= MAX_SPOOL_ATTEMPTS) {
        await this.spoolLocked(() => this.removeSpoolEntry(entry.id));
        pending -= 1;
        this.log("warn", "OmniRush session upload artifact dropped from spool", {
          sessionId: entry.session_id,
          snapshotType: entry.snapshot_type,
          sequence: entry.sequence,
          reason: outcome.reason,
        });
        continue;
      }
      failures += 1;
      const { not_before: _previous, ...rest } = entry;
      const attempted: SpoolMeta = {
        ...rest,
        attempts: entry.attempts + 1,
        last_attempt_at: new Date().toISOString(),
        ...(outcome.retryAfterMs !== undefined ? { not_before: new Date(Date.now() + outcome.retryAfterMs).toISOString() } : {}),
      };
      await this.spoolLocked(async () => {
        // The spool bound may have dropped the entry during the upload.
        await lstat(join(spoolDir, `${entry.id}.zst`));
        await this.writeSpoolMeta(attempted);
      }).catch(() => undefined);
      await this.recordLedgerOutcome(entry.session_id, "failure").catch(() => undefined);
      nextDueAt = Math.min(nextDueAt, this.spoolEntryDueAt(attempted));
    }
    if (failures > 0) this.retryFailures += 1;
    if (pending > 0 && !signal.aborted) {
      this.scheduleRetry(Math.max(this.jitteredBackoffMs(), Number.isFinite(nextDueAt) ? nextDueAt - Date.now() : 0));
    }
    return { delivered, pending };
  }

  /** Number of spooled uploads and their compressed size on disk. */
  spoolStatus(): Promise<{ entries: number; bytes: number }> {
    return this.spoolLocked(async () => {
      const entries = await this.listSpool();
      return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
    });
  }

  /**
   * Discards every spooled upload and the stored turn-diff bases, and aborts
   * every upload in flight without spooling it. Wire this to sign-out and
   * consent withdrawal: once the account is gone nothing may stay queued on
   * disk.
   */
  clearSpool(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.draining?.controller.abort();
    this.account.abort();
    this.account = new AbortController();
    this.traceSchemaCache = null;
    this.traceSchemaProbe = null;
    this.retryFailures = 0;
    return this.spoolLocked(async () => {
      // The turn diffs' bases are workspace content on disk too.
      await this.bases.clear();
      if (!this.spoolDir) return;
      await rm(this.spoolDir, { recursive: true, force: true });
      if (this.stateDir) await removeLegacyUploadContent(this.stateDir);
    });
  }
}
