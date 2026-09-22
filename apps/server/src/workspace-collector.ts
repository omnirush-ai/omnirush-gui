import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { minimatch } from "minimatch";

import { externalFetch } from "./server-fetch.js";

const execFileAsync = promisify(execFile);

export const COLLECTOR_SCHEMA_VERSION = 2;
// Caps shared with the omnirush.ai collector endpoint (contract v2); the
// backend enforces identical values, so a change here must land on both sides.
export const MAX_COLLECTOR_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_COLLECTOR_SESSION_BYTES = 512 * 1024 * 1024;
export const MAX_COLLECTOR_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_COLLECTOR_FILES = 50_000;
export const MAX_COLLECTOR_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_COLLECTOR_TRACE_BYTES = 16 * 1024 * 1024;
export const MAX_COLLECTOR_COMPRESSED_BYTES = 64 * 1024 * 1024;
/** Visible page text carried by one "web.visit" trace event, after redaction. */
export const MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES = 64 * 1024;
/** Extracted text carried by one "attachment" trace event, after redaction. */
export const MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES = 256 * 1024;
/** Task-tool subagent nesting captured below a root session (children, grandchildren, ...). */
export const MAX_COLLECTOR_CHILD_SESSION_DEPTH = 3;
// Events kept per session between trace flushes; older events are dropped
// first. Every push site goes through appendTrace so the cap holds for the
// model, child, browser, attachment and artifact events too.
export const MAX_COLLECTOR_TRACE_EVENTS = 5_000;
const MAX_FILES = MAX_COLLECTOR_FILES;
const MAX_SNAPSHOT_BYTES = MAX_COLLECTOR_SNAPSHOT_BYTES;
// Uncompressed room kept free inside MAX_SNAPSHOT_BYTES for what surrounds
// files[]: the session and environment blocks, touched paths, the metadata and
// change-journal files. The manifest and the git block are measured instead,
// since either can be several MiB on its own.
const SNAPSHOT_WRAPPER_MARGIN_BYTES = 2 * 1024 * 1024;
// JSON punctuation plus the sha256 field of one files[] entry, on top of its
// path and serialised content.
const SNAPSHOT_FILE_ENTRY_OVERHEAD_BYTES = 128;
const MAX_TRACE_BYTES = MAX_COLLECTOR_TRACE_BYTES;
const MAX_COMPRESSED_BYTES = MAX_COLLECTOR_COMPRESSED_BYTES;
const MAX_ARTIFACT_EVENTS_PER_TURN = 500;
const MAX_ARTIFACT_HASH_BYTES = 64 * 1024 * 1024;
const MAX_CHILD_SESSIONS = 200;
const MAX_WEB_VISIT_URL_CHARS = 2048;
const MAX_WEB_VISIT_TITLE_CHARS = 512;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_ATTACHMENT_MIME_CHARS = 128;
const CHANGE_DEBOUNCE_MS = 2_000;
const FALLBACK_SCAN_MS = 10_000;
const MAX_CHANGE_JOURNAL_ENTRIES = 512;
const MAX_CHANGE_JOURNAL_BYTES = 768 * 1024;
const MAX_SESSION_LEDGER_ENTRIES = 512;
const MAX_TOUCHED_PATHS = 128;
const MAX_GIT_STATUS_ENTRIES = 500;
const MAX_GIT_RECENT_COMMITS = 50;
const MAX_GIT_REMOTES = 10;
const GIT_DIFF_READ_BYTES = 8 * 1024 * 1024;
// Field limits enforced by the omnirush.ai collector endpoint (counted in code
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
const SESSION_LEDGER_FILE = "omnirush-collector-sessions.json";
const SPOOL_DIRECTORY = "omnirush-collector-spool";
const MAX_SPOOL_BYTES = 128 * 1024 * 1024;
const MAX_SPOOL_ENTRIES = 200;
const MAX_SPOOL_ATTEMPTS = 24;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 250;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// A rejected bearer. The body tells a stale device token (refreshed once and
// retried, spooled if still rejected) from the sign-in gate, which is final.
const UNAUTHORIZED_STATUSES = new Set([401, 403]);
const ACCOUNT_REQUIRED_MARKER = "omnirush_account_required";

type SnapshotType = "start" | "change" | "end" | "trace";

export type CollectorTrigger =
  | "session_start"
  | "resume"
  | "prompt"
  | "turn_completed"
  | "fs_change"
  | "periodic"
  | "session_end"
  | "trace_flush";

type ChangeTrigger = Extract<CollectorTrigger, "prompt" | "turn_completed" | "fs_change" | "periodic">;

type CollectorFile = {
  path: string;
  content: string;
  sha256: string;
};

type ManifestEntry = {
  path: string;
  sha256: string;
  size: number;
};

type GitRemote = { name: string; url: string };
type GitCommit = { sha: string; at: string; subject: string };
type GitStatusEntry = { code: string; path: string };

export type CollectorGitBlock = {
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

export type CollectorEnvironment = {
  os: string;
  os_version: string;
  arch: string;
  app_version: string | null;
  engine_version: string | null;
  node_version: string;
  shell: string | null;
  locale: string | null;
  timezone: string | null;
  git_version: string | null;
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
export type CollectorSessionModel = {
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
  agent: string | null;
};

/** Envelope-level "session" block: latest known values for every snapshot type. */
export type CollectorSessionBlock = {
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
  child_session_ids: string[];
};

export type CollectorChildSession = {
  childSessionId: string;
  parentSessionId: string;
  title: string | null;
  agent: string | null;
  /** Engine messages of the child that are new since the last checkpoint. */
  messages: unknown[];
  /** Id of the child's last message, persisted as the child's checkpoint. */
  lastMessageId: string | null;
};

export type CollectorWebVisit = {
  url: string;
  title?: string | null;
  text?: string | null;
};

export type CollectorAttachment = {
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  text: string | null;
  /** Whether the extractor already cut the text short of the whole document. */
  textTruncated?: boolean;
};

type ArtifactStat = { size: number; mtimeMs: number };

type SessionLedgerRecord = {
  segment: number;
  nextSequence: number;
  sentBytes?: number;
  lastMessageId?: string;
  lastSeenAt: string;
  failureCount?: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  model?: CollectorSessionModel;
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
  binary: boolean;
  sha256: string;
  bytes: number;
};

type SpoolMeta = {
  id: string;
  session_id: string;
  snapshot_type: SnapshotType;
  trigger: CollectorTrigger;
  sequence: number;
  bytes: number;
  created_at: string;
  attempts: number;
  last_attempt_at?: string;
};

type SessionState = {
  id: string;
  root: string;
  workspaceId: string;
  sentBytes: number;
  segment: number;
  sequence: number;
  resumed: boolean;
  lastMessageId?: string;
  lastSignature: string;
  started: boolean;
  finished: boolean;
  changeTimer: ReturnType<typeof setTimeout> | null;
  changeTrigger: ChangeTrigger | null;
  scanTimer: ReturnType<typeof setInterval> | null;
  watcher: FSWatcher | null;
  trace: TraceEvent[];
  changeJournal: Map<string, ChangeJournalEntry>;
  touchedPaths: Set<string>;
  changeJournalBytes: number;
  changeCaptureTail: Promise<void>;
  hashCache: Map<string, HashCacheEntry>;
  baseline: Map<string, string> | null;
  /** Untracked-but-not-ignored files as they stood when the current turn began. */
  artifactBaseline: Promise<Map<string, ArtifactStat>> | null;
  model: CollectorSessionModel | null;
  childSessionIds: string[];
  childCheckpoints: Map<string, string>;
  failureCount: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  ready: Promise<void>;
  tail: Promise<void>;
};

type CollectorOptions = {
  gatewayUrl?: string;
  accessToken?: string;
  fetch?: typeof externalFetch;
  upload?: (sessionId: string, compressed: Uint8Array) => Promise<Response>;
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
  spoolMaxEntries?: number;
  spoolMaxBytes?: number;
  /** Uncompressed envelope cap; the backend's MAX_SNAPSHOT_BYTES unless a test lowers it. */
  snapshotMaxBytes?: number;
};

type TransmitOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

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
 * line costs linear time.
 */
// Pre-filter for the assignment regex: the key must at least contain a keyword
// substring, so an ordinary assignment never consumes a value that holds a
// secret one (`"text": "{\"password\":...}"`). The exact, segment-bounded
// decision is isSecretAssignmentKey.
const ASSIGNMENT_KEYWORD_SOURCE = String.raw`secret|passw(?:or)?d|pwd|token|credential|auth|(?:api|access|private|client|session|signing|master|encryption)[_.:-]?key`;
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:(?<![\w.\\-])|(?<=\\[nrt]))(\\?["']?)((?=[\w.-]{0,63}?(?:${ASSIGNMENT_KEYWORD_SOURCE}))[A-Za-z_-][\w.-]{0,63})\1[ \t]*[=:][ \t]*`
    + String.raw`(?:"((?:[^"\s\\]|\\\S){8,})"|'((?:[^'\s\\]|\\\S){8,})'|\\"((?:[^"\s\\]|\\[^"\s]){8,})\\"|((?:[^\s"',;&\\]|\\\S){8,}))`,
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
]);

/**
 * Value rule v2 (the backend applies the identical rule). A file whose
 * extension names a programming language is scrubbed in SOURCE mode, where an
 * assignment's value must look like a generated literal; everything else
 * (.env*, ini, cfg, conf, yml, yaml, toml, json, properties, txt, md, no or
 * unknown extension), plus git diffs and the trace, is scrubbed in CONFIG
 * mode with the permissive rule.
 */
export type RedactMode = "source" | "config";
const SOURCE_EXTENSIONS = new Set([
  "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt", "c", "cc", "cpp", "h", "hpp", "rb", "php", "swift",
  "cs", "scala", "sh", "bash", "zsh", "ps1", "lua", "dart", "vue", "svelte", "map",
]);

/** SOURCE for a programming-language extension (case-insensitive), CONFIG otherwise. */
export function redactModeForPath(path: string): RedactMode {
  return SOURCE_EXTENSIONS.has(extname(path).slice(1).toLowerCase()) ? "source" : "config";
}

// The value side of the assignment rule (see isSecretAssignmentValue).
const CODE_EXPRESSION_VALUE = /^(?:process\.|os\.|env\.)/;
const IDENTIFIER_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const PATH_VALUE = /^(?:\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])/;
const MAX_ASSIGNMENT_DEPTH = 4;

// An AWS secret access key is 40 base64 characters with no shape of its own,
// so a candidate only counts near an access key id or an aws/secret key name.
const AWS_SECRET_QUICK = /[A-Za-z0-9/+]{40}/;
const AWS_SECRET_CANDIDATE = tokenPattern(String.raw`[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`, "g", String.raw`[A-Za-z0-9/+\\]`);
const AWS_SECRET_CONTEXT = /(?:AKIA|ASIA)[0-9A-Z]{16}|aws|secret/i;
const AWS_SECRET_CONTEXT_LINES = 3;
// The proximity pass needs neighbouring lines to mean anything: a single-line
// document (compact JSON, the trace) relies on its JSON key instead.
const AWS_SECRET_MIN_LINES = 3;

// Runs before the assignment rule so `https://oauth2:<token>@host/...` keeps
// its host instead of being read as an `oauth2:` assignment.
const URL_USERINFO: Redaction = [
  tokenPattern(String.raw`([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/@\\]|\\\S)+@`, "gi"),
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
const PII_PATTERNS: Redaction[] = [
  [tokenPattern(String.raw`[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,}\b`, "gi"), REDACTED_PII],
  [tokenPattern(String.raw`(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)`), REDACTED_PII],
  [tokenPattern(String.raw`\d{3}-\d{2}-\d{4}(?!\w)`), REDACTED_PII],
  [tokenPattern(String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\d)`, "g", String.raw`[\d.\\]`), REDACTED_PII],
];

const PRIVACY_POLICY = {
  capture_policy: "consented_workspace_session",
  gitignored_paths_excluded: true,
  git_internals_excluded: true,
  environment_variables_excluded: true,
  denied_path_classes: [".env*", "credentials", "keys", "secrets", "tokens", "passwords", ".aws", ".ssh", ".gnupg", ".git", "node_modules", "binaries_over_4MiB"],
  redaction: ["provider_secrets", "secret_assignments", "private_keys", "pii"],
  manifest_hash_basis: "sha256_of_redacted_utf8",
  max_file_bytes: MAX_COLLECTOR_FILE_BYTES,
  max_session_bytes: MAX_COLLECTOR_SESSION_BYTES,
  max_files: MAX_FILES,
  max_diff_bytes: MAX_COLLECTOR_DIFF_BYTES,
} as const;

function resolveCollectUrl(rawGatewayUrl: string | undefined): string | null {
  const value = rawGatewayUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/collect";
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

export function collectorPathForUpload(path: string): string {
  return redactCollectorText(path).text;
}

/**
 * Truncates text to `limit` code points without splitting a surrogate pair.
 * The backend counts code points, so this never exceeds its limit.
 */
export function clampCollectorText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** The upload-safe workspace name: basename only, redacted, then clamped. */
/**
 * Clamps text to a UTF-8 byte budget without splitting a code point. Used for
 * the free-text fields of trace events whose caps are expressed in bytes.
 */
export function clampCollectorBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
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
function collectorTextForTrace(text: string | null | undefined, maxBytes: number): { text: string | null; truncated: boolean } {
  if (typeof text !== "string") return { text: null, truncated: false };
  return clampCollectorBytes(redactCollectorText(text).text, maxBytes);
}

/**
 * Whether a browser visit may be traced. Local pages, inline documents and
 * browser-internal URLs never leave the machine.
 */
export function isCollectableWebUrl(raw: string): boolean {
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
  return clampCollectorText(collectorPathForUpload(root.split(sep).filter(Boolean).at(-1) ?? "workspace"), MAX_ROOT_NAME_CHARS);
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
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
 * Whether a workspace-relative path may never leave the machine. Repository
 * internals, dependency trees and the classic credential files are denied by
 * name; beyond those, any component carrying a credential word ("AWS master
 * key", "tokens/prod.csv") denies the file unless it has a source-code or docs
 * extension, in which case it is kept and scrubbed like any other source file.
 */
export function isCollectorPathDenied(path: string): boolean {
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

function isSecretAssignmentKey(key: string): boolean {
  const segments = keySegments(key);
  const last = segments.at(-1);
  if (last === undefined || EXCLUDED_LAST_SEGMENTS.has(last)) return false;
  return segments.some((segment, index) => SECRET_KEY_SEGMENTS.has(segment)
    || SECRET_KEY_PAIRS.some(([first, second]) => segment === `${first}${second}` || (segment === first && segments[index + 1] === second)));
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
 * `tokenFile`, `req.headers.authorization`), never a literal, and the value
 * must carry a digit or be 20+ characters of mixed case, so `'synthetic'`
 * and `'github-app'` stay. CONFIG mode keeps the permissive rule (a letter
 * anywhere), skipping only an unquoted dotted identifier such as YAML's
 * `token: config.token`.
 */
function isSecretAssignmentValue(value: string, mode: RedactMode, quoted: boolean): boolean {
  if (value.length < 8 || /\s/.test(value) || value.startsWith("[REDACTED")) return false;
  if (value.includes("(") || value.includes("${") || value.includes("$(") || CODE_EXPRESSION_VALUE.test(value)) return false;
  if (value.startsWith("<") && value.endsWith(">")) return false;
  if (isFilesystemPathValue(value)) return false;
  const identifier = !quoted && IDENTIFIER_VALUE.test(value);
  if (mode === "source") {
    return !identifier && (/\d/.test(value) || (value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value)));
  }
  return /[A-Za-z]/.test(value) && !(identifier && value.includes("."));
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
    tally.count += 1;
    return typeof replacement === "string" ? replacement : replacement(match, group ?? "");
  });
}

/** Redacts the value of every secret-named assignment; one redaction per assignment. */
function redactAssignments(text: string, tally: { count: number }, mode: RedactMode, depth = 0): string {
  ASSIGNMENT_PATTERN.lastIndex = 0;
  return text.replace(ASSIGNMENT_PATTERN, (match: string, _quote: string, key: string, doubleQuoted?: string, singleQuoted?: string, escapedQuoted?: string, bare?: string) => {
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
 * three or more lines (two or more line breaks) is scanned.
 */
function redactAwsSecrets(text: string, context: string | undefined, tally: { count: number }): string {
  if (!AWS_SECRET_QUICK.test(text)) return text;
  const lines = text.split("\n");
  if (lines.length < AWS_SECRET_MIN_LINES) return text;
  const contextual: Array<boolean | undefined> = new Array(lines.length);
  const hasContext = (index: number): boolean => {
    if (contextual[index] === undefined) contextual[index] = AWS_SECRET_CONTEXT.test(lines[index]!);
    return contextual[index]!;
  };
  const nearContext = context !== undefined && AWS_SECRET_CONTEXT.test(context);
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

export type RedactCollectorTextOptions = {
  /** Text that counts as context for context-dependent rules: the file path, or the JSON key a value sits under. */
  context?: string;
  /** Value rule mode; CONFIG when omitted (git diffs, the trace, JSON). See redactModeForPath. */
  mode?: RedactMode;
};

/**
 * Scrubs free text before upload: private key blocks, secret-named
 * assignments, provider token shapes and personal identifiers. The output
 * never contains a dangling backslash, so JSON-escaped text stays escapable.
 */
export function redactCollectorText(input: string, options: RedactCollectorTextOptions = {}): { text: string; count: number } {
  const tally = { count: 0 };
  let text = applyRedaction(input, PRIVATE_KEY_BLOCK, tally);
  text = applyRedaction(text, URL_USERINFO, tally);
  text = redactAssignments(text, tally, options.mode ?? "config");
  text = redactAwsSecrets(text, options.context, tally);
  for (const redaction of SECRET_PATTERNS) text = applyRedaction(text, redaction, tally);
  text = redactBearerTokens(text, tally);
  for (const redaction of PII_PATTERNS) text = applyRedaction(text, redaction, tally);
  return { text, count: tally.count };
}

function redactJsonValue(value: unknown, key: string | undefined, tally: { count: number }): unknown {
  if (typeof value === "string") {
    // A JSON string is always a quoted literal, scrubbed in CONFIG mode.
    if (key !== undefined && isSecretAssignmentKey(key) && isSecretAssignmentValue(value, "config", true)) {
      tally.count += 1;
      return REDACTED;
    }
    const result = redactCollectorText(value, { context: key });
    tally.count += result.count;
    return result.text;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, key, tally));
  const serializable = value as { toJSON?: unknown };
  if (typeof serializable.toJSON === "function") return redactJsonValue((serializable.toJSON as () => unknown)(), key, tally);
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    const scrubbedKey = redactCollectorText(childKey);
    tally.count += scrubbedKey.count;
    output[scrubbedKey.text] = redactJsonValue(childValue, childKey, tally);
  }
  return output;
}

/**
 * Scrubs a JSON value structurally: every string (keys included) goes through
 * the text scrubber, and a string under a secret-named key is redacted whole,
 * exactly as the `key: value` text rule would treat it. Serialising the result
 * can never produce a broken escape, which scrubbing serialised JSON as text
 * could.
 */
export function redactCollectorJson(value: unknown): { value: unknown; count: number } {
  const tally = { count: 0 };
  return { value: redactJsonValue(value, undefined, tally), count: tally.count };
}

/**
 * Scrubs a JSON document as JSON, keeping its indentation style; the original
 * text comes back untouched when nothing needed redacting, and null when the
 * text is not valid JSON.
 */
export function redactCollectorJsonText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = redactCollectorJson(parsed);
  if (result.count === 0) return text;
  const indent = /\n([ \t]+)\S/.exec(text)?.[1]?.slice(0, 10);
  return `${JSON.stringify(result.value, null, indent)}${text.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Scrubs one workspace file for upload: `.json` files structurally (falling
 * back to text when they do not parse), everything else as text with the path
 * as context and the value rule mode the extension selects.
 */
export function redactCollectorContent(path: string, text: string): string {
  if (/\.json$/i.test(path)) {
    const json = redactCollectorJsonText(text);
    if (json !== null) return json;
  }
  return redactCollectorText(text, { context: path, mode: redactModeForPath(path) }).text;
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

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

const PATH_FIELD_NAMES = new Set([
  "path",
  "file_path",
  "filepath",
  "filename",
  "target_path",
  "workspace_path",
]);

function pathCandidates(value: unknown, key = "", output: string[] = [], depth = 0): string[] {
  if (output.length >= 128 || depth > 6) return output;
  if (typeof value === "string") {
    const candidate = value.trim();
    if (PATH_FIELD_NAMES.has(key.toLowerCase()) && candidate && candidate.length <= 2_048
      && !candidate.includes("\n") && !candidate.includes("\r") && !candidate.includes("://")) {
      output.push(candidate);
    }
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) pathCandidates(item, key, output, depth + 1);
    return output;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    pathCandidates(childValue, childKey, output, depth + 1);
    if (output.length >= 128) break;
  }
  return output;
}

async function readGitignoreFile(directory: string): Promise<string[]> {
  try {
    return (await readFile(resolve(directory, ".gitignore"), "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function ignoredByRules(path: string, rules: string[]): boolean {
  let ignored = false;
  for (const raw of rules) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\//, "").replace(/\/$/, "/**");
    if (!pattern) continue;
    if (minimatch(path, pattern, { dot: true, matchBase: !pattern.includes("/") })) ignored = !negated;
  }
  return ignored;
}

async function gitIgnoresPath(root: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", path], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    // Exit status 1 means the path is not ignored. A non-git workspace also
    // falls through here and is handled by the normal snapshot walker.
    return false;
  }
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

function ledgerModel(value: unknown): CollectorSessionModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const model: CollectorSessionModel = {
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

function boundedTracePayload(
  state: Pick<SessionState, "id" | "workspaceId" | "segment" | "resumed">,
  events: TraceEvent[],
  maxBytes = MAX_TRACE_BYTES,
): Buffer {
  // The trace is scrubbed as a JSON value, never as serialised text: a text
  // redaction inside an escaped string (`\n@app.function`) once left a
  // dangling backslash that made the whole document unparseable.
  const header = redactCollectorJson({
    schema_version: 1,
    session_id: state.id,
    workspace_id: state.workspaceId,
    session_segment: state.segment,
    session_resumed: state.resumed,
  }).value as Record<string, unknown>;
  const scrubbed = redactCollectorJson(events).value as TraceEvent[];
  const encode = (selected: TraceEvent[], truncated: boolean, includedCount = selected.length) => Buffer.from(JSON.stringify({
    ...header,
    trace_truncated: truncated,
    dropped_event_count: Math.max(0, events.length - includedCount),
    events: selected,
  }));

  // One encode settles the common case. Only an oversized trace pays for the
  // search, which bisects on the prefix length: every probe is a full
  // serialisation, so probing once per event stalled the event loop for
  // seconds at the MAX_COLLECTOR_TRACE_EVENTS cap.
  let payload = encode(scrubbed, false);
  if (payload.byteLength <= maxBytes) return payload;
  let fits = 0;
  let overflow = scrubbed.length;
  while (overflow - fits > 1) {
    const middle = Math.floor((fits + overflow) / 2);
    if (encode(scrubbed.slice(0, middle), true).byteLength <= maxBytes) fits = middle;
    else overflow = middle;
  }
  const selected = scrubbed.slice(0, fits);
  payload = encode(selected, true);
  while (payload.byteLength > maxBytes && selected.length > 0) {
    selected.pop();
    payload = encode(selected, true);
  }
  if (selected.length === 0 && events.length > 0) {
    const marker: TraceEvent = {
      at: new Date().toISOString(),
      type: "trace.truncated",
      data: { dropped_event_count: events.length },
    };
    const marked = encode([marker], true, 0);
    if (marked.byteLength <= maxBytes) return marked;
  }
  return payload;
}

/** Eligible files plus the number of non-ignored paths the denylist dropped. */
type WorkspaceListing = { paths: string[]; denied: number };

async function walkFallback(root: string, directory = root, rules: string[] = [], listing: WorkspaceListing = { paths: [], denied: 0 }): Promise<WorkspaceListing> {
  const localRules = await readGitignoreFile(directory);
  const prefix = portablePath(root, directory);
  const ignoreRules = [...rules, ...localRules.map((rule) => {
    const negated = rule.startsWith("!");
    const body = negated ? rule.slice(1) : rule;
    const scoped = prefix ? `${prefix}/${body}` : body;
    return negated ? `!${scoped}` : scoped;
  })];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return listing;
  }
  for (const entry of entries) {
    if (listing.paths.length >= MAX_FILES) break;
    const fullPath = resolve(directory, entry.name);
    const path = portablePath(root, fullPath);
    if (!path || ignoredByRules(path, ignoreRules)) continue;
    if (entry.isDirectory()) {
      // Only the unconditional rules apply to a directory name: "src/token/"
      // is walked so its source files can be kept and scrubbed.
      if (hasDeniedComponent(pathComponents(path))) listing.denied += 1;
      else await walkFallback(root, fullPath, ignoreRules, listing);
    } else if (entry.isFile()) {
      if (isCollectorPathDenied(path)) listing.denied += 1;
      else listing.paths.push(path);
    }
  }
  return listing;
}

function filterListing(candidates: string[]): WorkspaceListing {
  const listing: WorkspaceListing = { paths: [], denied: 0 };
  for (const path of candidates) {
    if (!path) continue;
    if (isCollectorPathDenied(path)) listing.denied += 1;
    else if (listing.paths.length < MAX_FILES) listing.paths.push(path);
  }
  return listing;
}

async function listWorkspaceFiles(root: string): Promise<WorkspaceListing> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    });
    return filterListing(Buffer.from(stdout).toString("utf8").split("\0"));
  } catch {
    return walkFallback(root);
  }
}

type GitRunResult = { stdout: Buffer; ok: boolean; truncated: boolean };

/**
 * Runs a read-only git command with a hard output cap and timeout. Output past
 * the cap is dropped (and the child killed) instead of buffering unbounded
 * data; callers treat `truncated` as a signal, never as an error.
 */
function runGit(root: string, args: string[], options: { maxBytes: number; timeoutMs: number }): Promise<GitRunResult> {
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
      child = spawn("git", ["-C", root, "-c", "core.quotePath=false", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
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
    if (isCollectorPathDenied(path)) continue;
    if (entries.length >= MAX_GIT_STATUS_ENTRIES) continue;
    const uploadPath = collectorPathForUpload(path);
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
      name: clampCollectorText(collectorPathForUpload(name), MAX_GIT_REMOTE_NAME_CHARS),
      url: clampCollectorText(collectorPathForUpload(stripRemoteUserinfo(url)), MAX_GIT_REMOTE_URL_CHARS),
    }));
}

function parseGitLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split("\0")) {
    const [sha, at, subject] = record.replace(/^\n/, "").split("\x1f");
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha) || !at) continue;
    commits.push({ sha, at, subject: clampCollectorText(collectorPathForUpload(subject ?? ""), MAX_GIT_SUBJECT_CHARS) });
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
export function filterCollectorDiff(raw: string, inputTruncated = false): { diff: string | null; truncated: boolean } {
  let output = "";
  let used = 0;
  let truncated = inputTruncated;
  for (const section of raw.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue;
    const headerEnd = section.indexOf("\n");
    const path = diffHeaderPath(headerEnd === -1 ? section : section.slice(0, headerEnd));
    if (!path || isCollectorPathDenied(path)) continue;
    if (/^(?:Binary files .* differ|GIT binary patch)/m.test(section)) continue;
    // A diff is text even when the file is JSON: hunks are not parseable documents.
    const redacted = redactCollectorText(section, { context: path }).text;
    const size = Buffer.byteLength(redacted);
    if (used + size > MAX_COLLECTOR_DIFF_BYTES) {
      truncated = true;
      if (used === 0) {
        output = Buffer.from(redacted).subarray(0, MAX_COLLECTOR_DIFF_BYTES).toString("utf8").replace(/�+$/, "");
      }
      break;
    }
    output += redacted;
    used += size;
  }
  return { diff: output || null, truncated };
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
    if (result.ok) return filterCollectorDiff(result.stdout.toString("utf8"), result.truncated);
  }
  // An unborn branch has no HEAD to diff against: combine the index (against
  // the empty tree) with the working tree changes on top of it.
  const [staged, unstaged] = await Promise.all([
    runGit(root, ["diff", "--cached", ...common, ...scope], options),
    runGit(root, ["diff", ...common, ...scope], options),
  ]);
  if (!staged.ok && !unstaged.ok) return { diff: null, truncated: false };
  const text = `${staged.ok ? staged.stdout.toString("utf8") : ""}${unstaged.ok ? unstaged.stdout.toString("utf8") : ""}`;
  return filterCollectorDiff(text, staged.truncated || unstaged.truncated);
}

/**
 * Builds the safe git summary of a workspace with the git CLI only. Nothing is
 * read from `.git` directly and no object, pack, hook, or config content is
 * ever included: the block carries what the repository *is* (HEAD, branch,
 * upstream, remotes without userinfo, recent subjects) and what is in flight
 * (porcelain status and the combined text diff), all redacted.
 */
export async function collectGitBlock(root: string): Promise<CollectorGitBlock | null> {
  const inside = await gitText(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;
  // Where the workspace sits inside the repository ("" at the top level,
  // "packages/app/" for a nested workspace). Status, log and diff below are
  // scoped to that subtree; without a reliable answer the block is skipped
  // rather than risk describing files outside the workspace root.
  const prefixResult = await runGit(root, ["rev-parse", "--show-prefix"], { maxBytes: 64 * 1024, timeoutMs: 5_000 });
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
    branch: branch ? clampCollectorText(collectorPathForUpload(branch), MAX_GIT_REF_CHARS) : null,
    dirty: parsedStatus.dirty,
    upstream: upstream ? clampCollectorText(collectorPathForUpload(upstream), MAX_GIT_REF_CHARS) : null,
    ahead,
    behind,
    remotes: remotes ? parseGitRemotes(remotes) : [],
    recent_commits: log.ok ? parseGitLog(log.stdout.toString("utf8")) : [],
    status: parsedStatus.entries,
    diff: diff.diff,
    diff_truncated: diff.truncated,
  };
}

/**
 * Files inside the workspace that git does not track but does not ignore
 * either: the outputs an agent leaves next to the source. A workspace without
 * git has no tracked tree, so every eligible file counts.
 */
async function listUntrackedFiles(root: string): Promise<string[]> {
  try {
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

async function artifactStats(root: string): Promise<Map<string, ArtifactStat>> {
  const stats = new Map<string, ArtifactStat>();
  for (const path of await listUntrackedFiles(root)) {
    try {
      const absolute = resolve(root, path);
      if (portablePath(root, absolute).startsWith("../")) continue;
      const file = await lstat(absolute);
      if (!file.isFile() || file.isSymbolicLink()) continue;
      stats.set(path, { size: file.size, mtimeMs: file.mtimeMs });
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

async function workspaceSignature(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of (await listWorkspaceFiles(root)).paths) {
    try {
      const file = await lstat(resolve(root, path));
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_COLLECTOR_FILE_BYTES) continue;
      hash.update(path).update("\0").update(String(file.size)).update("\0").update(String(file.mtimeMs)).update("\0");
    } catch {
      // A file can disappear while the workspace is being scanned.
    }
  }
  // A commit changes the repository without touching any eligible file; fold
  // HEAD in so the next prompt or turn still captures the new history.
  hash.update("HEAD\0").update((await gitHead(root)) ?? "").update("\0");
  return hash.digest("hex");
}

type WorkspaceScan = {
  manifest: ManifestEntry[];
  files: CollectorFile[];
  manifestTruncated: boolean;
  contentTruncated: boolean;
  /** Non-ignored paths the denylist kept out of the snapshot. */
  deniedCount: number;
  /** Changed files whose content the snapshot cap left out of files[]; their manifest entries remain. */
  capOmittedCount: number;
  /** Redacted bytes of those files. */
  capOmittedBytes: number;
};

/** A changed file competing for the snapshot's content budget. */
type SnapshotCandidate = {
  path: string;
  uploadPath: string;
  absolute: string;
  /** Position in the workspace listing; files[] keeps that order. */
  order: number;
  bytes: number;
  /** Touched this session, or named by git status or the diff. */
  priority: boolean;
  /** Kept from the hashing read while the running total allowed it; re-read otherwise. */
  content?: string;
};

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Paths whose content a capped snapshot keeps first: what the session touched
 * plus what git reports as modified, keyed the way files[] names them.
 */
function snapshotPriorityPaths(touched: Iterable<string>, git: CollectorGitBlock | null): Set<string> {
  const paths = new Set<string>();
  for (const path of touched) paths.add(collectorPathForUpload(path));
  for (const entry of git?.status ?? []) paths.add(entry.path);
  for (const line of git?.diff?.split("\n") ?? []) {
    const path = diffHeaderPath(line);
    if (path) paths.add(collectorPathForUpload(path));
  }
  return paths;
}

/**
 * Picks which changed files carry content, smallest first within each
 * priority tier, and materialises them in listing order. Costs are measured
 * on the JSON a file becomes, so escaping cannot push the envelope past what
 * the raw byte count promised.
 */
async function selectSnapshotContent(
  candidates: SnapshotCandidate[],
  budget: number,
): Promise<{ files: CollectorFile[]; omittedCount: number; omittedBytes: number }> {
  const ordered = [...candidates].sort((a, b) => Number(b.priority) - Number(a.priority) || a.bytes - b.bytes || a.order - b.order);
  const kept: Array<{ order: number; file: CollectorFile }> = [];
  let used = 0;
  let omittedCount = 0;
  let omittedBytes = 0;
  for (const candidate of ordered) {
    const overhead = SNAPSHOT_FILE_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(candidate.uploadPath);
    // Serialised content is never shorter than the raw bytes, so a file that
    // fails this estimate is omitted without being read.
    if (used + overhead + candidate.bytes <= budget) {
      let content = candidate.content;
      if (content === undefined) {
        try {
          content = redactCollectorContent(candidate.path, (await readFile(candidate.absolute)).toString("utf8"));
        } catch {
          // Changed underneath the scan; the next snapshot sees its final form.
          continue;
        }
      }
      const cost = overhead + serializedBytes(content);
      if (used + cost <= budget) {
        kept.push({ order: candidate.order, file: { path: candidate.uploadPath, content, sha256: sha256Hex(content) } });
        used += cost;
        continue;
      }
    }
    omittedCount += 1;
    omittedBytes += candidate.bytes;
  }
  kept.sort((a, b) => a.order - b.order);
  return { files: kept.map((item) => item.file), omittedCount, omittedBytes };
}

/**
 * Walks every eligible workspace file, hashes its uploadable (redacted) form
 * for the manifest, and gathers content for either the whole tree (start
 * snapshots) or only the files whose hash differs from the previous manifest.
 * Unchanged files are recognised by size + mtime through the per-session hash
 * cache, so repeated snapshots cost a stat per file instead of a read.
 *
 * `byteLimit` bounds the serialised manifest plus files[] together. When the
 * changed files do not all fit, content goes to `priorityPaths` first and to
 * the smallest remaining files next; whatever is left out keeps its manifest
 * entry so the backend still learns the file exists and what it hashes to.
 */
async function scanWorkspace(
  root: string,
  cache: Map<string, HashCacheEntry>,
  baseline: Map<string, string> | null,
  byteLimit: number,
  includeAll: boolean,
  priorityPaths: ReadonlySet<string> = new Set(),
): Promise<WorkspaceScan> {
  const manifest: ManifestEntry[] = [];
  const candidates: SnapshotCandidate[] = [];
  const seen = new Set<string>();
  let retained = 0;
  const listing = await listWorkspaceFiles(root);
  const paths = listing.paths;
  for (const path of paths) {
    if (manifest.length >= MAX_FILES) break;
    try {
      const absolute = resolve(root, path);
      if (portablePath(root, absolute).startsWith("../")) continue;
      const file = await lstat(absolute);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_COLLECTOR_FILE_BYTES) continue;
      seen.add(path);
      const cached = cache.get(path);
      let entry: HashCacheEntry | undefined = cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs ? cached : undefined;
      let redacted: string | undefined;
      if (!entry) {
        const buffer = await readFile(absolute);
        if (buffer.length > MAX_COLLECTOR_FILE_BYTES || isBinary(buffer)) {
          cache.set(path, { size: file.size, mtimeMs: file.mtimeMs, binary: true, sha256: "", bytes: 0 });
          continue;
        }
        redacted = redactCollectorContent(path, buffer.toString("utf8"));
        entry = { size: file.size, mtimeMs: file.mtimeMs, binary: false, sha256: sha256Hex(redacted), bytes: Buffer.byteLength(redacted) };
        cache.set(path, entry);
      }
      if (entry.binary) continue;
      manifest.push({ path, sha256: entry.sha256, size: entry.bytes });
      const changed = includeAll || baseline?.get(path) !== entry.sha256;
      if (!changed) continue;
      // Content already in hand stays in memory while it could still fit, so a
      // snapshot under the budget never reads a file twice; beyond that point
      // it is dropped and re-read only if the selection picks the file.
      const keep = retained + entry.bytes <= byteLimit;
      if (keep) retained += entry.bytes;
      const uploadPath = collectorPathForUpload(path);
      candidates.push({
        path,
        uploadPath,
        absolute,
        order: candidates.length,
        bytes: entry.bytes,
        priority: priorityPaths.has(uploadPath),
        ...(keep && redacted !== undefined ? { content: redacted } : {}),
      });
    } catch {
      // Workspaces are live; races are expected and retried by the next snapshot.
    }
  }
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key);
  }
  const selected = await selectSnapshotContent(candidates, Math.max(0, byteLimit - serializedBytes(manifest)));
  return {
    manifest,
    files: selected.files,
    manifestTruncated: paths.length >= MAX_FILES,
    contentTruncated: selected.omittedCount > 0,
    deniedCount: listing.denied,
    capOmittedCount: selected.omittedCount,
    capOmittedBytes: selected.omittedBytes,
  };
}

/**
 * Whether an unauthorized response is the sign-in gate (the broker's or the
 * gateway's `omnirush_account_required`) rather than a stale device token.
 * Reading the body also releases the connection.
 */
async function responseSignalsAccountRequired(response: Response): Promise<boolean> {
  try {
    return (await response.text()).includes(ACCOUNT_REQUIRED_MARKER);
  } catch {
    return false;
  }
}

function compressZstd(payload: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    zstdCompress(payload, (error, result) => {
      if (error) reject(error);
      else resolvePromise(result);
    });
  });
}

function collectorEnvironment(appVersion: string | undefined, engineVersion: string | undefined, gitVersion: string | null): CollectorEnvironment {
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
    value?.trim() ? clampCollectorText(value.trim(), MAX_ENVIRONMENT_FIELD_CHARS) : null;
  return {
    os: process.platform,
    os_version: field(osRelease()) ?? "",
    arch: process.arch,
    app_version: field(appVersion),
    engine_version: field(engineVersion),
    node_version: field(process.versions.node ?? process.version.replace(/^v/, "")) ?? "",
    shell: shellPath?.trim() ? field(basename(shellPath.trim())) : null,
    locale: field(locale),
    timezone: field(timezone),
    git_version: field(gitVersion),
  };
}

function spoolId(counter: number): string {
  return `${Date.now().toString(16).padStart(12, "0")}-${counter.toString(16).padStart(6, "0")}-${randomBytes(4).toString("hex")}`;
}

async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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
    trigger: record.trigger as CollectorTrigger,
    sequence: record.sequence,
    bytes: record.bytes,
    created_at: record.created_at,
    attempts: optionalCount(record.attempts) ?? 0,
    ...(optionalString(record.last_attempt_at) ? { last_attempt_at: record.last_attempt_at } : {}),
  };
}

export class WorkspaceCollector {
  private readonly collectUrl: string | null;
  private token: string;
  private readonly fetcher: typeof externalFetch;
  private readonly uploader?: CollectorOptions["upload"];
  private readonly refreshAccessToken?: CollectorOptions["refreshAccessToken"];
  private readonly log: NonNullable<CollectorOptions["log"]>;
  private readonly ledgerPath: string | null;
  private readonly spoolDir: string | null;
  private readonly ledgerReady: Promise<void>;
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
  private readonly spoolMaxEntries: number;
  private readonly spoolMaxBytes: number;
  private readonly snapshotMaxBytes: number;
  private environmentCache: Promise<CollectorEnvironment> | null = null;
  private spoolCounter = 0;
  private spoolTail: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryFailures = 0;
  private stopped = false;

  constructor(options: CollectorOptions = {}) {
    this.collectUrl = resolveCollectUrl(options.gatewayUrl ?? process.env.OMNIRUSH_GATEWAY_URL);
    this.token = (options.accessToken ?? process.env.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
    this.fetcher = options.fetch ?? externalFetch;
    this.uploader = options.upload;
    this.refreshAccessToken = options.refreshAccessToken;
    this.log = options.log ?? (() => undefined);
    const stateDir = options.stateDir ? resolve(options.stateDir) : null;
    this.ledgerPath = stateDir ? join(stateDir, SESSION_LEDGER_FILE) : null;
    this.spoolDir = stateDir ? join(stateDir, SPOOL_DIRECTORY) : null;
    this.ledgerReady = this.loadLedger();
    this.changeDebounceMs = options.changeDebounceMs ?? CHANGE_DEBOUNCE_MS;
    this.fallbackScanMs = options.fallbackScanMs ?? FALLBACK_SCAN_MS;
    this.appVersion = options.appVersion;
    this.engineVersion = options.engineVersion;
    this.uploadRetryDelayMs = options.uploadRetryDelayMs ?? UPLOAD_RETRY_DELAY_MS;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.spoolMaxEntries = options.spoolMaxEntries ?? MAX_SPOOL_ENTRIES;
    this.spoolMaxBytes = options.spoolMaxBytes ?? MAX_SPOOL_BYTES;
    this.snapshotMaxBytes = options.snapshotMaxBytes ?? MAX_SNAPSHOT_BYTES;
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
        await writeFileAtomic(this.ledgerPath!, snapshot);
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
    return Boolean(this.uploader || (this.collectUrl && this.token));
  }

  private environment(): Promise<CollectorEnvironment> {
    this.environmentCache ??= (async () => {
      let gitVersion: string | null = null;
      try {
        const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5_000, maxBuffer: 16 * 1024 });
        gitVersion = String(stdout).trim().replace(/^git version\s+/i, "") || null;
      } catch {
        gitVersion = null;
      }
      return collectorEnvironment(this.appVersion, this.engineVersion, gitVersion);
    })();
    return this.environmentCache;
  }

  startSession(sessionId: string, workspaceId: string, root: string): void {
    if (!this.enabled || this.sessions.has(sessionId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(sessionId)) return;
    const state: SessionState = {
      id: sessionId,
      root,
      workspaceId,
      sentBytes: 0,
      segment: 1,
      sequence: 0,
      resumed: false,
      lastSignature: "",
      started: false,
      finished: false,
      changeTimer: null,
      changeTrigger: null,
      scanTimer: null,
      watcher: null,
      trace: [],
      changeJournal: new Map(),
      touchedPaths: new Set(),
      changeJournalBytes: 0,
      changeCaptureTail: Promise.resolve(),
      hashCache: new Map(),
      baseline: null,
      artifactBaseline: null,
      model: null,
      childSessionIds: [],
      childCheckpoints: new Map(),
      failureCount: 0,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
    };
    state.ready = this.prepareSession(state);
    this.sessions.set(sessionId, state);
    this.enqueue(state, async () => {
      await state.ready;
      state.lastSignature = await workspaceSignature(root);
      await this.uploadWorkspace(state, "start", state.resumed ? "resume" : "session_start");
      state.started = true;
    });
    try {
      state.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename && isCollectorPathDenied(String(filename))) return;
        if (filename) this.queueChangedPath(state, String(filename));
        this.scheduleChange(state, "fs_change");
      });
      state.watcher.on("error", () => {
        state.watcher?.close();
        state.watcher = null;
      });
    } catch {
      state.watcher = null;
    }
    state.scanTimer = setInterval(() => {
      void workspaceSignature(root).then((signature) => {
        if (signature && state.lastSignature && signature !== state.lastSignature) this.scheduleChange(state, "periodic");
        state.lastSignature = signature;
      }).catch(() => undefined);
    }, this.fallbackScanMs);
    state.scanTimer.unref?.();
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    for (const candidate of pathCandidates(data)) this.recordTouchedPath(state, candidate);
    this.appendTrace(state, type, data);
  }

  /** Appends one trace event, keeping only the newest MAX_COLLECTOR_TRACE_EVENTS. */
  private appendTrace(state: SessionState, type: string, data?: unknown): void {
    state.trace.push({ at: new Date().toISOString(), type, ...(data === undefined ? {} : { data }) });
    if (state.trace.length > MAX_COLLECTOR_TRACE_EVENTS) state.trace.splice(0, state.trace.length - MAX_COLLECTOR_TRACE_EVENTS);
  }

  private recordTouchedPath(state: SessionState, candidate: string): void {
    let path = candidate.replaceAll("\\", "/");
    if (path.startsWith("/")) {
      path = portablePath(state.root, resolve(path));
    } else {
      path = portablePath(state.root, resolve(state.root, path));
    }
    if (!path || path.startsWith("../") || isCollectorPathDenied(path) || state.touchedPaths.has(path)) return;
    state.touchedPaths.add(path);
    this.queueChangedPath(state, path);
    this.scheduleChange(state, "fs_change");
  }

  /** Whether the collector is currently tracking this session. */
  hasSession(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return Boolean(state && !state.finished);
  }

  /**
   * Records the model the turn ran on (from the turn's first assistant
   * message) as a "session.model" event and remembers it for the envelope's
   * "session" block. Identical for omnirush.ai and every external provider.
   */
  recordSessionModel(sessionId: string, model: CollectorSessionModel): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const clamp = (value: string | null) => (value ? clampCollectorText(value, MAX_ENVIRONMENT_FIELD_CHARS) : null);
    const cleaned: CollectorSessionModel = {
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
   * Records a task-tool subagent session (child, grandchild, ...) captured
   * once the root turn settled: one "session.child" event carrying the child's
   * new messages, plus the child's checkpoint for the next capture.
   */
  recordChildSession(sessionId: string, child: CollectorChildSession): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(child.childSessionId)) return;
    if (!state.childSessionIds.includes(child.childSessionId)) {
      if (state.childSessionIds.length >= MAX_CHILD_SESSIONS) return;
      state.childSessionIds.push(child.childSessionId);
    }
    if (child.lastMessageId) state.childCheckpoints.set(child.childSessionId, child.lastMessageId);
    for (const candidate of pathCandidates(child.messages)) this.recordTouchedPath(state, candidate);
    this.appendTrace(state, "session.child", {
      child_session_id: child.childSessionId,
      parent_session_id: child.parentSessionId,
      title: child.title ? clampCollectorText(child.title, MAX_GIT_SUBJECT_CHARS) : null,
      agent: child.agent ? clampCollectorText(child.agent, MAX_ENVIRONMENT_FIELD_CHARS) : null,
      messages: child.messages,
    });
    void this.persistOnceReady(state);
  }

  /**
   * Records a page the browser tools visited. Local, inline and
   * browser-internal URLs are never traced; page text is redacted and capped.
   * Returns whether the visit was recorded.
   */
  recordWebVisit(sessionId: string, visit: CollectorWebVisit): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return false;
    if (typeof visit.url !== "string" || !isCollectableWebUrl(visit.url)) return false;
    const url = new URL(visit.url);
    url.username = "";
    url.password = "";
    const title = collectorTextForTrace(visit.title ?? null, MAX_WEB_VISIT_TITLE_CHARS * 4);
    const text = collectorTextForTrace(visit.text ?? null, MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES);
    this.appendTrace(state, "web.visit", {
      url: clampCollectorText(redactCollectorText(url.toString()).text, MAX_WEB_VISIT_URL_CHARS),
      title: title.text === null ? null : clampCollectorText(title.text, MAX_WEB_VISIT_TITLE_CHARS),
      text: text.text,
      text_truncated: text.truncated,
    });
    return true;
  }

  /** Records a file attached to a prompt: identity, size, and redacted, capped text when extractable. */
  recordAttachment(sessionId: string, attachment: CollectorAttachment): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const text = collectorTextForTrace(attachment.text, MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES);
    this.appendTrace(state, "attachment", {
      name: clampCollectorText(redactCollectorText(basename(attachment.name || "attachment")).text, MAX_ATTACHMENT_NAME_CHARS),
      mime: clampCollectorText(attachment.mime || "application/octet-stream", MAX_ATTACHMENT_MIME_CHARS),
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

  private sessionBlock(state: SessionState): CollectorSessionBlock {
    return {
      provider_id: state.model?.provider_id ?? null,
      model_id: state.model?.model_id ?? null,
      variant: state.model?.variant ?? null,
      child_session_ids: [...state.childSessionIds],
    };
  }

  /**
   * Emits one "artifact" event per untracked-but-not-ignored file the turn
   * created or modified. Tracked files are already covered by the change
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
      if (emitted >= MAX_ARTIFACT_EVENTS_PER_TURN) break;
      const previous = baseline.get(path);
      if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
      if (stat.size > MAX_ARTIFACT_HASH_BYTES) continue;
      try {
        const sha256 = await sha256File(resolve(state.root, path));
        this.appendTrace(state, "artifact", { path: collectorPathForUpload(path), sha256, bytes: stat.size });
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
   * sees the milestone without a redundant upload.
   */
  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed"): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    // The artifact baseline must reflect the workspace as the turn begins, not
    // once the queued start snapshot has finished uploading.
    if (trigger === "prompt") state.artifactBaseline = artifactStats(state.root);
    if (state.changeTimer) {
      clearTimeout(state.changeTimer);
      state.changeTimer = null;
      state.changeTrigger = null;
    }
    this.enqueue(state, () => this.captureChange(state, trigger));
  }

  finishSession(sessionId: string, finalTrace?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const pendingTrace = state.trace.splice(0);
    if (finalTrace !== undefined) {
      for (const candidate of pathCandidates(finalTrace)) this.recordTouchedPath(state, candidate);
    }
    state.finished = true;
    if (state.changeTimer) clearTimeout(state.changeTimer);
    if (state.scanTimer) clearInterval(state.scanTimer);
    state.watcher?.close();
    this.enqueue(state, async () => {
      await state.ready;
      if (state.trace.length > 0) pendingTrace.push(...state.trace.splice(0));
      await state.changeCaptureTail;
      if (finalTrace !== undefined) pendingTrace.push({ at: new Date().toISOString(), type: "session.completed", data: finalTrace });
      await this.uploadTrace(state, pendingTrace);
      await this.uploadWorkspace(state, "end", "session_end");
      this.sessions.delete(sessionId);
    });
  }

  flushTrace(sessionId: string, finalTrace?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const pendingTrace = state.trace.splice(0);
    if (finalTrace !== undefined) {
      for (const candidate of pathCandidates(finalTrace)) this.recordTouchedPath(state, candidate);
      pendingTrace.push({ at: new Date().toISOString(), type: "turn.completed", data: finalTrace });
    }
    if (pendingTrace.length === 0) return;
    this.enqueue(state, async () => {
      await state.ready;
      if (state.trace.length > 0) pendingTrace.push(...state.trace.splice(0));
      await this.uploadTrace(state, pendingTrace);
    });
  }

  /** Resolves once every queued capture and upload for the session has settled. */
  async idle(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await state.changeCaptureTail.catch(() => undefined);
    await state.tail.catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const sessionId of [...this.sessions.keys()]) this.finishSession(sessionId);
    await Promise.allSettled([...this.sessions.values()].map((state) => state.tail));
    await this.spoolTail.catch(() => undefined);
    await this.ledgerWriteTail.catch(() => undefined);
  }

  private scheduleChange(state: SessionState, trigger: Extract<ChangeTrigger, "fs_change" | "periodic">): void {
    if (state.finished) return;
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

  private async captureChange(state: SessionState, trigger: ChangeTrigger): Promise<void> {
    await state.ready;
    await state.changeCaptureTail;
    // A finished session is about to upload its end snapshot, which already
    // carries everything a queued change capture would.
    if (state.finished) return;
    if (trigger === "turn_completed") {
      await this.captureArtifacts(state).catch((error: unknown) => {
        this.log("warn", "OmniRush artifact capture failed", {
          sessionId: state.id,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
    }
    const signature = await workspaceSignature(state.root);
    const changed = Boolean(signature) && (signature !== state.lastSignature || this.journalHasChanges(state));
    if (trigger === "prompt" || trigger === "turn_completed") {
      this.appendTrace(state, "collector.trigger", { trigger, captured: changed });
    }
    if (!changed) return;
    state.lastSignature = signature;
    await this.uploadWorkspace(state, "change", trigger);
  }

  /**
   * Whether the journal holds a real change against the last captured
   * manifest. Watchers replay events for files written just before they
   * started, and a traced read of an unchanged file is not an edit; neither
   * should cost an upload.
   */
  private journalHasChanges(state: SessionState): boolean {
    if (!state.baseline) return state.changeJournal.size > 0;
    for (const entry of state.changeJournal.values()) {
      const previous = state.baseline.get(entry.path);
      if (entry.status === "present" ? previous !== (entry.sha256 ?? sha256Hex(entry.content ?? "")) : previous !== undefined) {
        return true;
      }
    }
    return false;
  }

  private queueChangedPath(state: SessionState, filename: string): void {
    if (state.finished) return;
    state.changeCaptureTail = state.changeCaptureTail
      .catch(() => undefined)
      .then(() => this.captureChangedPath(state, filename))
      .catch((error: unknown) => {
        this.log("warn", "OmniRush changed-file capture failed", {
          sessionId: state.id,
          path: filename,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  }

  private async captureChangedPath(state: SessionState, filename: string): Promise<void> {
    const absolute = resolve(state.root, filename);
    const path = portablePath(state.root, absolute);
    if (!path || path.startsWith("../") || isCollectorPathDenied(path) || await gitIgnoresPath(state.root, path)) return;
    let entry: ChangeJournalEntry;
    try {
      const file = await lstat(absolute);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_COLLECTOR_FILE_BYTES) {
        entry = { path, at: new Date().toISOString(), status: "skipped" };
      } else {
        const buffer = await readFile(absolute);
        if (buffer.length > MAX_COLLECTOR_FILE_BYTES || isBinary(buffer)) {
          entry = { path, at: new Date().toISOString(), status: "skipped" };
        } else {
          const content = redactCollectorContent(path, buffer.toString("utf8"));
          entry = { path, at: new Date().toISOString(), status: "present", content, sha256: sha256Hex(content) };
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
      this.log("warn", "OmniRush collection operation failed", {
        sessionId: state.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    });
  }

  private touchedPathsForUpload(state: SessionState): string[] {
    return [...state.touchedPaths].slice(0, MAX_TOUCHED_PATHS).map(collectorPathForUpload);
  }

  private async uploadWorkspace(state: SessionState, type: Exclude<SnapshotType, "trace">, trigger: CollectorTrigger): Promise<void> {
    const remaining = MAX_COLLECTOR_SESSION_BYTES - state.sentBytes;
    if (remaining <= 1_024) return;
    // The git block comes first: its status and diff name the files a capped
    // snapshot must keep, and its measured size (the diff alone may reach its
    // own cap) is what the fixed wrapper margin cannot promise to cover.
    const git = await collectGitBlock(state.root);
    const budget = Math.min(this.snapshotMaxBytes - SNAPSHOT_WRAPPER_MARGIN_BYTES - serializedBytes(git), remaining - 1_024);
    const [scan, environment] = await Promise.all([
      scanWorkspace(state.root, state.hashCache, state.baseline, budget, type === "start", snapshotPriorityPaths(state.touchedPaths, git)),
      this.environment(),
    ]);
    if (scan.capOmittedCount > 0) {
      this.appendTrace(state, "collector.snapshot_cap", {
        snapshot_type: type,
        trigger,
        omitted_count: scan.capOmittedCount,
        omitted_bytes: scan.capOmittedBytes,
        budget_bytes: budget,
      });
      this.log("warn", "OmniRush collection snapshot trimmed to the snapshot cap", {
        sessionId: state.id,
        snapshotType: type,
        trigger,
        omittedCount: scan.capOmittedCount,
        omittedBytes: scan.capOmittedBytes,
        budgetBytes: budget,
      });
    }
    // The baseline is the last *captured* manifest: the next change snapshot
    // reports exactly what moved since this one, whatever the upload outcome.
    state.baseline = new Map(scan.manifest.map((entry) => [entry.path, entry.sha256]));
    const rootName = workspaceRootName(state.root);
    const touchedPaths = this.touchedPathsForUpload(state);
    const metadata = JSON.stringify({
      schema_version: COLLECTOR_SCHEMA_VERSION,
      workspace_id: state.workspaceId,
      session_id: state.id,
      session_segment: state.segment,
      session_resumed: state.resumed,
      trigger,
      touched_paths: touchedPaths,
      ...PRIVACY_POLICY,
      denied_file_count: scan.deniedCount,
      root_name: rootName,
      git: { commit: git?.commit ?? null, branch: git?.branch ?? null, dirty: git ? String(git.dirty) : "false" },
    });
    const files: CollectorFile[] = [
      { path: "__omnirush__/workspace.json", content: metadata, sha256: sha256Hex(metadata) },
      ...scan.files,
    ];
    const journal = type === "change" || type === "end" ? [...state.changeJournal.values()] : [];
    if (journal.length > 0) {
      const changes = JSON.stringify({
        schema_version: 1,
        session_id: state.id,
        entries: journal.map((entry) => ({ ...entry, path: collectorPathForUpload(entry.path) })),
      });
      files.push({ path: "__omnirush__/changes.json", content: changes, sha256: sha256Hex(changes) });
    }
    const uploaded = await this.uploadEnvelope(state, type, trigger, files, {
      workspace: { root_name: rootName, git },
      environment,
      manifest: scan.manifest.map((entry) => ({ ...entry, path: collectorPathForUpload(entry.path) })),
      privacy: {
        ...PRIVACY_POLICY,
        denied_file_count: scan.deniedCount,
        manifest_truncated: scan.manifestTruncated,
        files_truncated: scan.contentTruncated,
        diff_truncated: git?.diff_truncated ?? false,
        snapshot_cap_omitted_count: scan.capOmittedCount,
        snapshot_cap_omitted_bytes: scan.capOmittedBytes,
      },
      touched_paths: touchedPaths,
    });
    if (uploaded && journal.length > 0) this.acknowledgeJournal(state, journal);
    state.lastSignature = await workspaceSignature(state.root);
  }

  private async uploadTrace(state: SessionState, traceEvents: TraceEvent[]): Promise<void> {
    const remaining = MAX_COLLECTOR_SESSION_BYTES - state.sentBytes;
    if (remaining <= 1_024 || traceEvents.length === 0) return;
    const bounded = boundedTracePayload(state, traceEvents, Math.min(MAX_TRACE_BYTES, remaining - 1_024));
    const content = bounded.toString("utf8");
    let events: unknown[] = [];
    try {
      const parsed = JSON.parse(content) as { events?: unknown };
      if (Array.isArray(parsed.events)) events = parsed.events;
    } catch {
      events = [];
    }
    await this.uploadEnvelope(state, "trace", "trace_flush", [{ path: "__omnirush__/trace.json", content, sha256: sha256Hex(content) }], {
      workspace: { root_name: workspaceRootName(state.root), git: null },
      environment: await this.environment(),
      manifest: [],
      privacy: { ...PRIVACY_POLICY },
      touched_paths: this.touchedPathsForUpload(state),
      trace: events,
    });
  }

  private send(sessionId: string, compressed: Uint8Array): Promise<Response> {
    if (this.uploader) return this.uploader(sessionId, compressed);
    return this.fetcher(this.collectUrl!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/zstd",
        "X-OmniRush-Session-ID": sessionId,
      },
      body: compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer,
      signal: AbortSignal.timeout(30_000),
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

  private async transmit(sessionId: string, compressed: Uint8Array, attempts = UPLOAD_ATTEMPTS): Promise<TransmitOutcome> {
    let lastReason = "collector upload unavailable";
    let refreshAttempted = false;
    let attempt = 0;
    while (attempt < attempts) {
      try {
        const response = await this.send(sessionId, compressed);
        if (response.ok) return { ok: true };
        lastReason = `collector upload failed with status ${response.status}`;
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
          this.log("warn", "OmniRush collection upload rejected as unauthorized", {
            sessionId,
            status: response.status,
            refreshed: refresh.refreshed,
            ...(refresh.error ? { refreshError: refresh.error } : {}),
          });
          if (!refresh.refreshed) return { ok: false, retryable: true, reason: lastReason };
          // The retry with the fresh token is not one of the transport attempts.
          continue;
        }
        await response.body?.cancel().catch(() => undefined);
        if (!RETRYABLE_STATUSES.has(response.status)) return { ok: false, retryable: false, reason: lastReason };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : "collector upload unavailable";
      }
      attempt += 1;
      if (attempt < attempts) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, this.uploadRetryDelayMs * 2 ** (attempt - 1)));
      }
    }
    return { ok: false, retryable: true, reason: lastReason };
  }

  private async uploadEnvelope(
    state: SessionState,
    snapshotType: SnapshotType,
    trigger: CollectorTrigger,
    files: CollectorFile[],
    extras: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.collectUrl && !this.uploader) return false;
    const sequence = state.sequence + 1;
    const payload = Buffer.from(JSON.stringify({
      schema_version: COLLECTOR_SCHEMA_VERSION,
      session_id: state.id,
      session_segment: state.segment,
      session_resumed: state.resumed,
      sequence,
      snapshot_type: snapshotType,
      trigger,
      captured_at: new Date().toISOString(),
      session: this.sessionBlock(state),
      ...extras,
      files,
    }));
    if (state.sentBytes + payload.length > MAX_COLLECTOR_SESSION_BYTES) return false;
    if (payload.length > this.snapshotMaxBytes) {
      // The backend answers an oversized envelope with 422, which is never
      // retried. The scan budget keeps this from happening; reaching it means
      // the wrapper outgrew its margin, which deserves a loud line here rather
      // than a lost upload and a rejection upstream.
      this.log("warn", "OmniRush collection payload exceeded the snapshot cap", {
        sessionId: state.id,
        snapshotType,
        trigger,
        bytes: payload.length,
        capBytes: this.snapshotMaxBytes,
      });
      return false;
    }
    const compressed = await compressZstd(payload);
    if (compressed.length > MAX_COMPRESSED_BYTES) {
      this.log("warn", "OmniRush collection payload exceeded compressed limit", { sessionId: state.id, snapshotType, trigger });
      return false;
    }
    const outcome = await this.transmit(state.id, compressed);
    if (!outcome.ok) {
      if (!outcome.retryable || !this.spoolDir) {
        await this.recordLedgerOutcome(state.id, "failure").catch(() => undefined);
        throw new Error(outcome.reason);
      }
      await this.spoolEnvelope({ id: "", session_id: state.id, snapshot_type: snapshotType, trigger, sequence, bytes: compressed.length, created_at: new Date().toISOString(), attempts: 1 }, compressed);
      state.sentBytes += payload.length;
      state.sequence = sequence;
      state.failureCount += 1;
      state.lastFailureAt = new Date().toISOString();
      await this.persistSession(state).catch(() => undefined);
      this.log("warn", "OmniRush collection artifact spooled for retry", {
        sessionId: state.id,
        snapshotType,
        trigger,
        sequence,
        compressedBytes: compressed.length,
        reason: outcome.reason,
      });
      this.retryFailures += 1;
      this.scheduleRetry();
      return true;
    }
    state.sentBytes += payload.length;
    state.sequence = sequence;
    state.lastSuccessAt = new Date().toISOString();
    await this.persistSession(state).catch((error: unknown) => {
      this.log("warn", "OmniRush session ledger update failed", {
        sessionId: state.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    });
    this.log("info", "OmniRush collection artifact uploaded", {
      sessionId: state.id,
      snapshotType,
      trigger,
      sequence,
      fileCount: files.length,
      compressedBytes: compressed.length,
    });
    return true;
  }

  // --- durable retry spool -------------------------------------------------

  private spoolLocked<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.spoolTail.catch(() => undefined).then(operation);
    this.spoolTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async listSpool(): Promise<SpoolMeta[]> {
    if (!this.spoolDir) return [];
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
    await writeFileAtomic(join(this.spoolDir!, `${meta.id}.json`), JSON.stringify(meta));
  }

  private spoolEnvelope(meta: SpoolMeta, compressed: Uint8Array): Promise<void> {
    return this.spoolLocked(async () => {
      if (!this.spoolDir) return;
      await mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
      const id = spoolId(++this.spoolCounter);
      // Payload first, then the metadata that makes the entry visible: a crash
      // in between leaves an orphan that the next listing removes.
      await writeFileAtomic(join(this.spoolDir, `${id}.zst`), Buffer.from(compressed));
      await this.writeSpoolMeta({ ...meta, id });
      await this.enforceSpoolBounds();
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
      this.log("warn", "OmniRush collection spool dropped its oldest entry", {
        sessionId: entry.session_id,
        snapshotType: entry.snapshot_type,
        sequence: entry.sequence,
      });
    }
  }

  private scheduleRetry(delayMs?: number): void {
    if (!this.spoolDir || this.stopped || this.retryTimer) return;
    const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, this.retryFailures - 1));
    const delay = delayMs ?? Math.round(backoff * (0.85 + Math.random() * 0.3));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drainSpool().catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Delivers spooled uploads oldest first, stopping at the first failure. */
  drainSpool(): Promise<{ delivered: number; pending: number }> {
    return this.spoolLocked(async () => {
      let delivered = 0;
      if (!this.spoolDir || !this.enabled) return { delivered, pending: 0 };
      const entries = await this.listSpool();
      let pending = entries.length;
      for (const entry of entries) {
        if (this.stopped) break;
        let compressed: Buffer;
        try {
          compressed = await readFile(join(this.spoolDir, `${entry.id}.zst`));
        } catch {
          await this.removeSpoolEntry(entry.id);
          pending -= 1;
          continue;
        }
        const outcome = await this.transmit(entry.session_id, compressed, 1);
        if (outcome.ok) {
          await this.removeSpoolEntry(entry.id);
          await this.recordLedgerOutcome(entry.session_id, "success").catch(() => undefined);
          this.retryFailures = 0;
          delivered += 1;
          pending -= 1;
          this.log("info", "OmniRush collection artifact delivered from spool", {
            sessionId: entry.session_id,
            snapshotType: entry.snapshot_type,
            trigger: entry.trigger,
            sequence: entry.sequence,
            attempts: entry.attempts + 1,
          });
          continue;
        }
        if (!outcome.retryable || entry.attempts + 1 >= MAX_SPOOL_ATTEMPTS) {
          await this.removeSpoolEntry(entry.id);
          pending -= 1;
          this.log("warn", "OmniRush collection artifact dropped from spool", {
            sessionId: entry.session_id,
            snapshotType: entry.snapshot_type,
            sequence: entry.sequence,
            reason: outcome.reason,
          });
          continue;
        }
        await this.writeSpoolMeta({ ...entry, attempts: entry.attempts + 1, last_attempt_at: new Date().toISOString() }).catch(() => undefined);
        await this.recordLedgerOutcome(entry.session_id, "failure").catch(() => undefined);
        this.retryFailures += 1;
        this.scheduleRetry();
        break;
      }
      return { delivered, pending };
    });
  }

  /** Number of spooled uploads and their compressed size on disk. */
  spoolStatus(): Promise<{ entries: number; bytes: number }> {
    return this.spoolLocked(async () => {
      const entries = await this.listSpool();
      return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
    });
  }

  /**
   * Discards every spooled upload. Wire this to sign-out and consent
   * withdrawal: once the account is gone nothing may stay queued on disk.
   */
  clearSpool(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryFailures = 0;
    return this.spoolLocked(async () => {
      if (!this.spoolDir) return;
      await rm(this.spoolDir, { recursive: true, force: true });
    });
  }
}
