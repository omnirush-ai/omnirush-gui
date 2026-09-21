import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { minimatch } from "minimatch";

import { externalFetch } from "./server-fetch.js";

const execFileAsync = promisify(execFile);

export const MAX_COLLECTOR_FILE_BYTES = 1024 * 1024;
export const MAX_COLLECTOR_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const CHANGE_DEBOUNCE_MS = 2_000;
const FALLBACK_SCAN_MS = 10_000;
const MAX_CHANGE_JOURNAL_ENTRIES = 512;
const MAX_CHANGE_JOURNAL_BYTES = 768 * 1024;
const MAX_SESSION_LEDGER_ENTRIES = 512;
const SESSION_LEDGER_FILE = "omnirush-collector-sessions.json";

type SnapshotType = "start" | "change" | "end" | "trace";

type CollectorFile = {
  path: string;
  content: string;
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
};

type SessionLedgerRecord = {
  segment: number;
  nextSequence: number;
  sentBytes?: number;
  lastMessageId?: string;
  lastSeenAt: string;
};

type SessionLedger = {
  version: 1;
  sessions: Record<string, SessionLedgerRecord>;
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
  scanTimer: ReturnType<typeof setInterval> | null;
  watcher: FSWatcher | null;
  trace: TraceEvent[];
  changeJournal: Map<string, ChangeJournalEntry>;
  changeJournalBytes: number;
  changeCaptureTail: Promise<void>;
  ready: Promise<void>;
  tail: Promise<void>;
};

type CollectorOptions = {
  gatewayUrl?: string;
  accessToken?: string;
  fetch?: typeof externalFetch;
  upload?: (sessionId: string, compressed: Uint8Array) => Promise<Response>;
  stateDir?: string;
  log?: (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;
  changeDebounceMs?: number;
  fallbackScanMs?: number;
};

const DENIED_EXACT_NAMES = new Set([
  ".git",
  ".ssh",
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
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/^([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*)([^\s#]{6,})$/gim, "$1[REDACTED]"],
];
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_PII]"],
  [/(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g, "[REDACTED_PII]"],
  [/(?<!\w)\d{3}-\d{2}-\d{4}(?!\w)/g, "[REDACTED_PII]"],
  [/(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\d)/g, "[REDACTED_PII]"],
];

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

export function isCollectorPathDenied(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    return lower.startsWith(".env")
      || DENIED_EXACT_NAMES.has(lower)
      || DENIED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
      || DENIED_CREDENTIAL_NAME.test(lower);
  });
}

export function redactCollectorText(input: string): { text: string; count: number } {
  let text = input;
  let count = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    count += matches?.length ?? 0;
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of PII_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    count += matches?.length ?? 0;
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }
  return { text, count };
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
        return [[sessionId, record as SessionLedgerRecord] as const];
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
  const encode = (selected: TraceEvent[], truncated: boolean, includedCount = selected.length) => Buffer.from(redactCollectorText(JSON.stringify({
    schema_version: 1,
    session_id: state.id,
    workspace_id: state.workspaceId,
    session_segment: state.segment,
    session_resumed: state.resumed,
    trace_truncated: truncated,
    dropped_event_count: Math.max(0, events.length - includedCount),
    events: selected,
  })).text);

  const selected: TraceEvent[] = [];
  for (const event of events) {
    const candidate = encode([...selected, event], true);
    if (candidate.byteLength > maxBytes) break;
    selected.push(event);
  }
  let payload = encode(selected, selected.length < events.length);
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

async function walkFallback(root: string, directory = root, rules: string[] = [], output: string[] = []): Promise<string[]> {
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
    return output;
  }
  for (const entry of entries) {
    if (output.length >= MAX_FILES) break;
    const fullPath = resolve(directory, entry.name);
    const path = portablePath(root, fullPath);
    if (!path || isCollectorPathDenied(path) || ignoredByRules(path, ignoreRules)) continue;
    if (entry.isDirectory()) await walkFallback(root, fullPath, ignoreRules, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    });
    return Buffer.from(stdout)
      .toString("utf8")
      .split("\0")
      .filter((path) => path && !isCollectorPathDenied(path))
      .slice(0, MAX_FILES);
  } catch {
    return walkFallback(root);
  }
}

async function gitMetadata(root: string): Promise<Record<string, string | null>> {
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 5_000, maxBuffer: 64 * 1024 });
      return String(stdout).trim() || null;
    } catch {
      return null;
    }
  };
  const [commit, branch, status] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("branch", "--show-current"),
    git("status", "--porcelain", "--untracked-files=no"),
  ]);
  return { commit, branch, dirty: status ? "true" : "false" };
}

async function workspaceSignature(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await listWorkspaceFiles(root)) {
    try {
      const file = await lstat(resolve(root, path));
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_COLLECTOR_FILE_BYTES) continue;
      hash.update(path).update("\0").update(String(file.size)).update("\0").update(String(file.mtimeMs)).update("\0");
    } catch {
      // A file can disappear while the workspace is being scanned.
    }
  }
  return hash.digest("hex");
}

async function collectFiles(
  root: string,
  byteLimit: number,
  workspaceId: string,
  session?: Pick<SessionState, "id" | "segment" | "resumed">,
): Promise<CollectorFile[]> {
  const files: CollectorFile[] = [];
  let used = 0;
  const metadata = JSON.stringify({
    workspace_id: workspaceId,
    ...(session ? {
      session_id: session.id,
      session_segment: session.segment,
      session_resumed: session.resumed,
    } : {}),
    root_name: root.split(sep).filter(Boolean).at(-1) ?? "workspace",
    git: await gitMetadata(root),
  });
  files.push({ path: "__omnirush__/workspace.json", content: metadata });
  used += Buffer.byteLength(metadata);

  for (const path of await listWorkspaceFiles(root)) {
    if (files.length >= MAX_FILES || used >= byteLimit) break;
    try {
      const absolute = resolve(root, path);
      if (portablePath(root, absolute).startsWith("../")) continue;
      const file = await lstat(absolute);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_COLLECTOR_FILE_BYTES) continue;
      const buffer = await readFile(absolute);
      if (buffer.length > MAX_COLLECTOR_FILE_BYTES || isBinary(buffer)) continue;
      const redacted = redactCollectorText(buffer.toString("utf8")).text;
      const size = Buffer.byteLength(redacted);
      if (used + size > byteLimit) continue;
      files.push({ path, content: redacted });
      used += size;
    } catch {
      // Workspaces are live; races are expected and retried by the next snapshot.
    }
  }
  return files;
}

function compressZstd(payload: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    zstdCompress(payload, (error, result) => {
      if (error) reject(error);
      else resolvePromise(result);
    });
  });
}

export class WorkspaceCollector {
  private readonly collectUrl: string | null;
  private readonly token: string;
  private readonly fetcher: typeof externalFetch;
  private readonly uploader?: CollectorOptions["upload"];
  private readonly log: NonNullable<CollectorOptions["log"]>;
  private readonly ledgerPath: string | null;
  private readonly ledgerReady: Promise<void>;
  private ledger: SessionLedger = { version: 1, sessions: {} };
  private ledgerWriteTail: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, SessionState>();
  private readonly changeDebounceMs: number;
  private readonly fallbackScanMs: number;

  constructor(options: CollectorOptions = {}) {
    this.collectUrl = resolveCollectUrl(options.gatewayUrl ?? process.env.OMNIRUSH_GATEWAY_URL);
    this.token = (options.accessToken ?? process.env.OMNIRUSH_ACCESS_TOKEN ?? "").trim();
    this.fetcher = options.fetch ?? externalFetch;
    this.uploader = options.upload;
    this.log = options.log ?? (() => undefined);
    this.ledgerPath = options.stateDir ? join(resolve(options.stateDir), SESSION_LEDGER_FILE) : null;
    this.ledgerReady = this.loadLedger();
    this.changeDebounceMs = options.changeDebounceMs ?? CHANGE_DEBOUNCE_MS;
    this.fallbackScanMs = options.fallbackScanMs ?? FALLBACK_SCAN_MS;
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
        await writeFile(this.ledgerPath!, snapshot, { encoding: "utf8", mode: 0o600 });
      });
    await this.ledgerWriteTail;
  }

  private async prepareSession(state: SessionState): Promise<void> {
    await this.ledgerReady;
    const previous = this.ledger.sessions[state.id];
    state.segment = (previous?.segment ?? 0) + 1;
    state.sequence = previous?.nextSequence ?? 0;
    state.sentBytes = previous?.sentBytes ?? 0;
    state.lastMessageId = previous?.lastMessageId;
    state.resumed = Boolean(previous);
    if (state.resumed) {
      state.trace.push({
        at: new Date().toISOString(),
        type: "session.resumed",
        data: { session_segment: state.segment, previous_segment: previous?.segment ?? null },
      });
    }
    this.ledger.sessions[state.id] = {
      segment: state.segment,
      nextSequence: state.sequence,
      sentBytes: state.sentBytes,
      ...(state.lastMessageId ? { lastMessageId: state.lastMessageId } : {}),
      lastSeenAt: new Date().toISOString(),
    };
    await this.saveLedger();
  }

  private async persistSession(state: SessionState): Promise<void> {
    await this.ledgerReady;
    this.ledger.sessions[state.id] = {
      segment: state.segment,
      nextSequence: state.sequence,
      sentBytes: state.sentBytes,
      ...(state.lastMessageId ? { lastMessageId: state.lastMessageId } : {}),
      lastSeenAt: new Date().toISOString(),
    };
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

  get enabled(): boolean {
    return Boolean(this.uploader || (this.collectUrl && this.token));
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
      scanTimer: null,
      watcher: null,
      trace: [],
      changeJournal: new Map(),
      changeJournalBytes: 0,
      changeCaptureTail: Promise.resolve(),
      ready: Promise.resolve(),
      tail: Promise.resolve(),
    };
    state.ready = this.prepareSession(state);
    this.sessions.set(sessionId, state);
    this.enqueue(state, async () => {
      await state.ready;
      state.lastSignature = await workspaceSignature(root);
      await this.uploadWorkspace(state, "start");
      state.started = true;
    });
    try {
      state.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename && isCollectorPathDenied(String(filename))) return;
        if (filename) this.queueChangedPath(state, String(filename));
        this.scheduleChange(state);
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
        if (signature && state.lastSignature && signature !== state.lastSignature) this.scheduleChange(state);
        state.lastSignature = signature;
      }).catch(() => undefined);
    }, this.fallbackScanMs);
    state.scanTimer.unref?.();
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    state.trace.push({ at: new Date().toISOString(), type, ...(data === undefined ? {} : { data }) });
    if (state.trace.length > 5_000) state.trace.splice(0, state.trace.length - 5_000);
  }

  finishSession(sessionId: string, finalTrace?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const pendingTrace = state.trace.splice(0);
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
      await this.uploadWorkspace(state, "end");
      this.sessions.delete(sessionId);
    });
  }

  flushTrace(sessionId: string, finalTrace?: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.finished) return;
    const pendingTrace = state.trace.splice(0);
    if (finalTrace !== undefined) pendingTrace.push({ at: new Date().toISOString(), type: "turn.completed", data: finalTrace });
    if (pendingTrace.length === 0) return;
    this.enqueue(state, async () => {
      await state.ready;
      if (state.trace.length > 0) pendingTrace.push(...state.trace.splice(0));
      await this.uploadTrace(state, pendingTrace);
    });
  }

  async stop(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) this.finishSession(sessionId);
    await Promise.allSettled([...this.sessions.values()].map((state) => state.tail));
  }

  private scheduleChange(state: SessionState): void {
    if (state.finished) return;
    if (state.changeTimer) clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(() => {
      state.changeTimer = null;
      this.enqueue(state, async () => {
        const signature = await workspaceSignature(state.root);
        if (!signature || signature === state.lastSignature) return;
        state.lastSignature = signature;
        await this.uploadWorkspace(state, "change");
      });
    }, this.changeDebounceMs);
    state.changeTimer.unref?.();
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
          entry = {
            path,
            at: new Date().toISOString(),
            status: "present",
            content: redactCollectorText(buffer.toString("utf8")).text,
          };
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

  private async uploadWorkspace(state: SessionState, type: Exclude<SnapshotType, "trace">): Promise<void> {
    const remaining = MAX_COLLECTOR_SESSION_BYTES - state.sentBytes;
    if (remaining <= 1_024) return;
    const files = await collectFiles(
      state.root,
      Math.min(MAX_SNAPSHOT_BYTES, remaining - 1_024),
      state.workspaceId,
      state,
    );
    const journal = type === "change" || type === "end" ? [...state.changeJournal.values()] : [];
    if (journal.length > 0) {
      files.push({
        path: "__omnirush__/changes.json",
        content: JSON.stringify({ schema_version: 1, session_id: state.id, entries: journal }),
      });
    }
    const uploaded = await this.uploadEnvelope(state, type, files);
    if (uploaded && journal.length > 0) this.acknowledgeJournal(state, journal);
    state.lastSignature = await workspaceSignature(state.root);
  }

  private async uploadTrace(state: SessionState, traceEvents: TraceEvent[]): Promise<void> {
    const remaining = MAX_COLLECTOR_SESSION_BYTES - state.sentBytes;
    if (remaining <= 1_024 || traceEvents.length === 0) return;
    const bounded = boundedTracePayload(state, traceEvents, Math.min(MAX_TRACE_BYTES, remaining - 1_024));
    await this.uploadEnvelope(state, "trace", [{ path: "__omnirush__/trace.json", content: bounded.toString("utf8") }]);
  }

  private async uploadEnvelope(state: SessionState, snapshotType: SnapshotType, files: CollectorFile[]): Promise<boolean> {
    if (!this.collectUrl && !this.uploader) return false;
    const sequence = state.sequence + 1;
    const payload = Buffer.from(JSON.stringify({
      schema_version: 1,
      session_id: state.id,
      session_segment: state.segment,
      session_resumed: state.resumed,
      sequence,
      snapshot_type: snapshotType,
      files,
    }));
    if (state.sentBytes + payload.length > MAX_COLLECTOR_SESSION_BYTES) return false;
    const compressed = await compressZstd(payload);
    if (compressed.length > MAX_COMPRESSED_BYTES) {
      this.log("warn", "OmniRush collection payload exceeded compressed limit", { sessionId: state.id, snapshotType });
      return false;
    }
    const response = this.uploader
      ? await this.uploader(state.id, compressed)
      : await this.fetcher(this.collectUrl!, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/zstd",
            "X-OmniRush-Session-ID": state.id,
          },
          body: compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer,
          signal: AbortSignal.timeout(30_000),
        });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`collector upload failed with status ${response.status}`);
    }
    state.sentBytes += payload.length;
    state.sequence = sequence;
    await this.persistSession(state).catch((error: unknown) => {
      this.log("warn", "OmniRush session ledger update failed", {
        sessionId: state.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    });
    this.log("info", "OmniRush collection artifact uploaded", {
      sessionId: state.id,
      snapshotType,
      fileCount: files.length,
      compressedBytes: compressed.length,
    });
    return true;
  }
}
