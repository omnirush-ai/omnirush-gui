/**
 * Scanning a session root for the project archive (sections 5.2 to 5.8): the
 * whole folder, `.git/` and ignored content included, minus the exclusions of
 * 5.2; streaming SHA-256 with a (path, size, mtimeNs, ctimeNs, ino) cache;
 * delta computation against the previous archive's entry list; and the
 * `__omnirush__/manifest.json` document.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import { clampCollectorBytes, isCollectorPathDenied, stripRemoteUserinfo } from "../workspace-collector.js";
import { hintGarbageCollection } from "./files.js";

export const ARCHIVE_SCHEMA = "omnirush.archive.v1";
export const RESERVED_ROOT_NAME = "__omnirush__";
const STAT_CONCURRENCY = 64;
const HASH_CONCURRENCY = 6;
const HASH_READ_BYTES = 128 * 1024;
/** Bytes hashed, or entries inspected or hashed, between two garbage collection hints. */
const GC_HINT_BYTES = 64 * 1024 * 1024;
const GC_HINT_ENTRIES = 10_000;
const MAX_LABEL_BYTES = 255;
const GIT_TIMEOUT_MS = 15_000;
/**
 * Opens an entry for reading: never through a symlink in the last component
 * (O_NOFOLLOW), and never blocking when a FIFO replaced the file after lstat
 * (O_NONBLOCK, which regular files ignore; O_NOCTTY for a terminal). Callers
 * fstat the handle and read only a regular file.
 */
export const OPEN_ENTRY_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);

export type ArchiveKind = "base" | "delta";
/**
 * Why a delta was taken (manifest.json `trigger`): a completed turn, or a
 * final archive of the folder after the last completed turn, which carries
 * that turn's number again.
 */
export type ArchiveTrigger = "turn" | "final";
/** What prompted a final archive (manifest.json `reason`). */
export type FinalReason = "idle" | "turn_incomplete" | "session_deleted" | "app_quit" | "app_start";
export type ArchiveEntryType = "file" | "dir" | "symlink";

/** One manifest `files` item (section 5.4). */
export type ArchiveEntry = {
  path: string;
  type: ArchiveEntryType;
  mode: number;
  size: number;
  sha256: string | null;
  target?: string;
};

/** A scanned entry: the manifest fields plus what pass 2 and the hash cache need. */
export type ScannedEntry = ArchiveEntry & {
  /** Tar mtime: floor(mtimeMs / 1000), clamped at pack time. */
  mtime: number;
  /** `size:mtimeNs:ctimeNs:ino` from lstat: the hash cache key, and what pass 2 re-checks (size and mtimeNs). */
  statKey: string;
  /** st_dev from lstat: with the ino in statKey, the identity pass 2 requires of the file it reads. */
  dev: number;
};

/** The prefix of a stat key that pass 2 compares against fstat: size and mtimeNs. */
export function statKeyPrefix(size: bigint | number, mtimeNs: bigint): string {
  return `${size}:${mtimeNs}:`;
}

/** Whether `stats` (an fstat) describe the file pass 1 lstat'ed for `entry`: same st_dev and st_ino. */
export function isSameFileIdentity(entry: ScannedEntry, stats: BigIntStats): boolean {
  return entry.dev === Number(stats.dev) && entry.statKey.endsWith(`:${stats.ino}`);
}

export type ExcludedCounts = {
  credential: number;
  special: number;
  app_state: number;
  reserved: number;
  unreadable: number;
  non_utf8: number;
};

export type ArchiveGit = {
  head: string | null;
  branch: string | null;
  remote: string | null;
  dirty: boolean;
  /** The root's path inside the repository (`git rev-parse --show-prefix` without the trailing `/`), "" at its top level. */
  path?: string;
};

export type ArchiveManifest = {
  schema: typeof ARCHIVE_SCHEMA;
  kind: ArchiveKind;
  archive_id: string;
  session_id: string;
  sequence: number;
  turn: number;
  created_at: string;
  parent_archive_id: string | null;
  trigger?: ArchiveTrigger;
  reason?: FinalReason;
  workspace: { label: string; marker: string; git: ArchiveGit | null };
  files: ArchiveEntry[];
  deleted?: string[];
  excluded: ExcludedCounts;
};

export function emptyExcludedCounts(): ExcludedCounts {
  return { credential: 0, special: 0, app_state: 0, reserved: 0, unreadable: 0, non_utf8: 0 };
}

/**
 * Orders paths by their UTF-8 bytes (section 5.4) without encoding them:
 * UTF-16 order differs from code point order only where a surrogate meets a
 * unit in U+E000..U+FFFF, so the first differing units are remapped.
 */
export function compareArchivePaths(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    let a = left.charCodeAt(index);
    let b = right.charCodeAt(index);
    if (a === b) continue;
    if (a >= 0xd800) a = a >= 0xe000 ? a - 0x800 : a + 0x2000;
    if (b >= 0xd800) b = b >= 0xe000 ? b - 0x800 : b + 0x2000;
    return a - b;
  }
  return left.length - right.length;
}

/**
 * True when a file or symlink must be left out of the archive (section 5.3):
 * the collector's credential denylist, with git internals exempt and
 * `node_modules` not counted as a denial.
 */
export function isArchiveCredentialPath(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((part) => part.toLowerCase() === ".git")) return false;
  const rest = parts.filter((part) => part.toLowerCase() !== "node_modules");
  return rest.length > 0 && isCollectorPathDenied(rest.join("/"));
}

/** workspace.label: the root's basename, at most 255 UTF-8 bytes. */
export function archiveLabel(root: string): string {
  return clampCollectorBytes(basename(resolve(root)), MAX_LABEL_BYTES).text;
}

// --- hash cache -------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Iterates the entry rows of a state document written one JSON row per line
 * (`{"v":..,"entries":[` / rows / `]}`) without materialising the whole
 * parsed array next to the text.
 */
export function* jsonLineRows(text: string): Generator<unknown> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith(",")) line = line.slice(0, -1);
    if (!line.startsWith("[") && !line.startsWith("{\"path\"")) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A damaged row is skipped; the caller decides whether that matters.
    }
  }
}

function* jsonLineDocument<T>(header: string, rows: Iterable<T>, serialise: (row: T) => string, rowsPerChunk = 2_000): Generator<string> {
  yield header;
  let batch: string[] = [];
  let first = true;
  for (const row of rows) {
    batch.push(serialise(row));
    if (batch.length >= rowsPerChunk) {
      yield `${first ? "" : ","}\n${batch.join(",\n")}`;
      first = false;
      batch = [];
    }
  }
  if (batch.length > 0) yield `${first ? "" : ","}\n${batch.join(",\n")}`;
  yield "\n]}\n";
}

/**
 * path -> (size, mtimeNs, ctimeNs, ino, sha256), shared by the sessions of one
 * root. A hit requires the whole stat key to match, so a writer that
 * preserves mtime is still caught by ctime or inode. Rows loaded from disk
 * are packed into one string (sha256 then the stat key); rows of the current
 * scan are the scanned entries themselves, so a 200k-entry scan adds no
 * strings. During a scan, rows move from `previous` to `current`; paths the
 * scan did not see are dropped at commitScan() without a second index.
 */
export class ArchiveHashCache {
  /** Rows not yet seen by the running scan: packed strings from disk, or entries of the previous scan. */
  private previous = new Map<string, string | ScannedEntry>();
  private current = new Map<string, ScannedEntry>();
  private dirty = false;

  /** Loads the text written by jsonChunks(); anything unreadable is an empty cache. */
  static fromText(text: string | null): ArchiveHashCache {
    const cache = new ArchiveHashCache();
    if (!text?.startsWith('{"v":2,')) return cache;
    for (const row of jsonLineRows(text)) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [path, statKey, sha256] = row;
      if (typeof path !== "string" || typeof statKey !== "string" || typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) continue;
      cache.previous.set(path, [sha256, statKey].join(""));
    }
    return cache;
  }

  get changed(): boolean {
    return this.dirty;
  }

  get size(): number {
    return this.previous.size + this.current.size;
  }

  /** The cached SHA-256 when the entry's stat key matches; the scan sets entry.sha256 from it. */
  lookup(entry: ScannedEntry): string | null {
    const held = this.previous.get(entry.path);
    if (held === undefined) return null;
    this.previous.delete(entry.path);
    const sha256 = typeof held === "string"
      ? (held.length === 64 + entry.statKey.length && held.endsWith(entry.statKey) ? held.slice(0, 64) : null)
      : (held.statKey === entry.statKey ? held.sha256 : null);
    if (!sha256) {
      this.dirty = true;
      return null;
    }
    this.current.set(entry.path, entry);
    return sha256;
  }

  /** Records a freshly hashed entry (entry.sha256 already set). */
  remember(entry: ScannedEntry): void {
    this.previous.delete(entry.path);
    this.current.set(entry.path, entry);
    this.dirty = true;
  }

  forget(path: string): void {
    const had = this.previous.delete(path) || this.current.delete(path);
    if (had) this.dirty = true;
  }

  /** Ends a scan: paths the scan did not see are dropped. */
  commitScan(): void {
    if (this.previous.size > 0) this.dirty = true;
    this.previous = this.current;
    this.current = new Map();
  }

  /** The cache as JSON text pieces, one row per line, so it is never one giant string. */
  jsonChunks(): Generator<string> {
    this.dirty = false;
    // A path is in exactly one of the two maps (lookup and remember move it to current).
    const { previous, current } = this;
    function* rows(): Generator<string> {
      for (const [path, held] of previous) {
        if (typeof held === "string") yield JSON.stringify([path, held.slice(64), held.slice(0, 64)]);
        else if (held.sha256) yield JSON.stringify([path, held.statKey, held.sha256]);
      }
      for (const [path, entry] of current) if (entry.sha256) yield JSON.stringify([path, entry.statKey, entry.sha256]);
    }
    return jsonLineDocument('{"v":2,"entries":[', rows(), (row) => row);
  }
}

/** The baseline document: the full entry list after an archive, one entry per line; `unstable` paths get a null hash. */
export function baselineChunks(entries: readonly ArchiveEntry[], unstable: ReadonlySet<string> = new Set()): Generator<string> {
  return jsonLineDocument('{"v":1,"entries":[', entries, (entry) => {
    const out = archiveEntry(entry);
    if (unstable.has(entry.path)) out.sha256 = null;
    return JSON.stringify(out);
  });
}

const ENTRY_TYPES: ReadonlySet<string> = new Set(["file", "dir", "symlink"]);

/** Parses a baseline document; null when it is not one (the session cannot compute deltas any more). */
export function parseBaselineText(text: string | null): ArchiveEntry[] | null {
  if (!text?.startsWith('{"v":1,')) return null;
  const entries: ArchiveEntry[] = [];
  for (const row of jsonLineRows(text)) {
    if (typeof row !== "object" || row === null) return null;
    const path = "path" in row ? row.path : undefined;
    const type = "type" in row ? row.type : undefined;
    const mode = "mode" in row ? row.mode : undefined;
    const size = "size" in row ? row.size : undefined;
    const sha256 = "sha256" in row ? row.sha256 : undefined;
    const target = "target" in row ? row.target : undefined;
    if (typeof path !== "string" || typeof type !== "string" || !ENTRY_TYPES.has(type) || typeof mode !== "number" || typeof size !== "number") return null;
    if (sha256 !== null && typeof sha256 !== "string") return null;
    if (target !== undefined && typeof target !== "string") return null;
    const entry: ArchiveEntry = { path, type: type === "file" ? "file" : type === "dir" ? "dir" : "symlink", mode, size, sha256 };
    if (target !== undefined) entry.target = target;
    entries.push(entry);
  }
  return entries;
}

// --- scanning -----------------------------------------------------------------------

/** Work counters for tests and profiling. */
export type ScanMetrics = { stats: number; fileReads: number; bytesHashed: number; cacheHits: number };

export function emptyScanMetrics(): ScanMetrics {
  return { stats: 0, fileReads: 0, bytesHashed: 0, cacheHits: 0 };
}

export type ScanOptions = {
  /** Absolute app state/temp/data directories; pruned (and counted as app_state) when under the root. */
  excludedDirs?: readonly string[];
  /** archiveIncludeCredentialFiles: turns the credential filter off entirely. */
  includeCredentialFiles?: boolean;
  hashCache?: ArchiveHashCache;
  statConcurrency?: number;
  hashConcurrency?: number;
  metrics?: ScanMetrics;
  /** Stops the scan between entries: it then rejects with the signal's reason. */
  signal?: AbortSignal;
};

export type ScanResult = { entries: ScannedEntry[]; excluded: ExcludedCounts };

/**
 * Runs `operation` over `items` with at most `limit` in flight. The workers
 * pull plain data items, so a 200k-entry level costs 200k small objects, not
 * 200k suspended async frames.
 */
async function forEachBounded<T>(items: readonly T[], limit: number, operation: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await operation(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const NAME_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeName(raw: Buffer): string | null {
  try {
    return NAME_DECODER.decode(raw);
  } catch {
    return null;
  }
}

function portable(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** The excluded directories that lie strictly under the root, as root-relative paths. */
async function excludedRelativeDirs(root: string, dirs: readonly string[]): Promise<Set<string>> {
  const rootForms = new Set([resolve(root)]);
  try {
    rootForms.add(await realpath(root));
  } catch {
    // The scan reports an unreadable root itself.
  }
  const result = new Set<string>();
  for (const dir of dirs) {
    const forms = new Set([resolve(dir)]);
    try {
      forms.add(await realpath(dir));
    } catch {
      // Not created yet: only its resolved form can be under the root.
    }
    for (const form of forms) {
      for (const rootForm of rootForms) {
        const rel = relative(rootForm, form);
        const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
        if (rel && !outside) result.add(portable(rel));
      }
    }
  }
  return result;
}

// Strings kept per entry are built with join(), which yields one flat string;
// template concatenation in JSC yields a rope that keeps every piece alive,
// roughly doubling the per-entry cost on a 200k-entry tree.
function statFields(stats: BigIntStats) {
  return {
    mode: Number(stats.mode & 0o7777n),
    mtime: Number(stats.mtimeNs / 1_000_000_000n),
    statKey: [stats.size, stats.mtimeNs, stats.ctimeNs, stats.ino].join(":"),
    dev: Number(stats.dev),
  };
}

/** SHA-256 of the first `size` bytes (the lstat size): pass 2 streams exactly those and detects any change. */
async function hashFile(absolute: string, size: number, buffer: Buffer, metrics: ScanMetrics, signal?: AbortSignal): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, OPEN_ENTRY_FLAGS);
  } catch {
    return null;
  }
  metrics.fileReads += 1;
  if (metrics.fileReads % GC_HINT_ENTRIES === 0) hintGarbageCollection();
  try {
    if (!(await handle.stat()).isFile()) return null;
    const hash = createHash("sha256");
    let remaining = size;
    while (remaining > 0) {
      // A stopped scan does not finish a big file first (the scan rejects right after).
      if (signal?.aborted) return null;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      if (Math.floor((metrics.bytesHashed + bytesRead) / GC_HINT_BYTES) > Math.floor(metrics.bytesHashed / GC_HINT_BYTES)) hintGarbageCollection();
      metrics.bytesHashed += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Pass 1: walks the root with lstat (never following a symlink), applies the
 * exclusions of section 5.2 and hashes every file whose cache key changed.
 * Entries come back sorted by UTF-8 bytes.
 */
export async function scanArchiveTree(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const concurrency = options.statConcurrency ?? STAT_CONCURRENCY;
  const metrics = options.metrics ?? emptyScanMetrics();
  const cache = options.hashCache;
  const signal = options.signal;
  const excluded = emptyExcludedCounts();
  const prunedDirs = await excludedRelativeDirs(root, options.excludedDirs ?? []);
  const includeCredentials = options.includeCredentialFiles === true;
  const entries: ScannedEntry[] = [];
  const toHash: ScannedEntry[] = [];

  const inspect = async (relDir: string, absDir: string, name: string, next: Array<{ rel: string; abs: string }>): Promise<void> => {
    signal?.throwIfAborted();
    const rel = relDir ? [relDir, name].join("/") : name;
    const abs = join(absDir, name);
    let stats: BigIntStats;
    try {
      stats = await lstat(abs, { bigint: true });
      metrics.stats += 1;
      if (metrics.stats % GC_HINT_ENTRIES === 0) hintGarbageCollection();
    } catch {
      excluded.unreadable += 1;
      return;
    }
    if (stats.isDirectory()) {
      if (prunedDirs.has(rel)) {
        excluded.app_state += 1;
        return;
      }
      entries.push({ path: rel, type: "dir", size: 0, sha256: null, ...statFields(stats) });
      next.push({ rel, abs });
      return;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      excluded.special += 1;
      return;
    }
    if (!includeCredentials && isArchiveCredentialPath(rel)) {
      excluded.credential += 1;
      return;
    }
    if (stats.isSymbolicLink()) {
      let target: string | null;
      try {
        target = decodeName(await readlink(abs, { encoding: "buffer" }));
      } catch {
        excluded.unreadable += 1;
        return;
      }
      if (target === null) {
        excluded.non_utf8 += 1;
        return;
      }
      entries.push({ path: rel, type: "symlink", size: 0, sha256: null, target, ...statFields(stats) });
      return;
    }
    const entry: ScannedEntry = { path: rel, type: "file", size: Number(stats.size), sha256: null, ...statFields(stats) };
    const cached = cache?.lookup(entry) ?? null;
    if (cached) {
      entry.sha256 = cached;
      metrics.cacheHits += 1;
    } else {
      toHash.push(entry);
    }
    entries.push(entry);
  };

  // Breadth-first, one directory level at a time: list the level's
  // directories, then lstat every name found, both with bounded concurrency.
  let level: Array<{ rel: string; abs: string }> = [{ rel: "", abs: resolve(root) }];
  while (level.length > 0) {
    const names: Array<{ relDir: string; absDir: string; name: string }> = [];
    await forEachBounded(level, concurrency, async (dir) => {
      signal?.throwIfAborted();
      let raw: Buffer[];
      try {
        raw = await readdir(dir.abs, { encoding: "buffer" });
      } catch (error) {
        if (!dir.rel) throw error;
        // The directory itself is recorded; its content is not.
        excluded.unreadable += 1;
        return;
      }
      for (const bytes of raw) {
        const name = decodeName(bytes);
        if (name === null) excluded.non_utf8 += 1;
        else if (!dir.rel && name === RESERVED_ROOT_NAME) excluded.reserved += 1;
        else names.push({ relDir: dir.rel, absDir: dir.abs, name });
      }
    });
    const next: Array<{ rel: string; abs: string }> = [];
    await forEachBounded(names, concurrency, (item) => inspect(item.relDir, item.absDir, item.name, next));
    level = next;
  }

  const unreadable = new Set<ScannedEntry>();
  const buffers: Buffer[] = [];
  await forEachBounded(toHash, options.hashConcurrency ?? HASH_CONCURRENCY, async (entry) => {
    signal?.throwIfAborted();
    const buffer = buffers.pop() ?? Buffer.allocUnsafe(HASH_READ_BYTES);
    try {
      const sha256 = await hashFile(join(root, ...entry.path.split("/")), entry.size, buffer, metrics, signal);
      if (sha256 === null) {
        unreadable.add(entry);
        cache?.forget(entry.path);
        return;
      }
      entry.sha256 = sha256;
      cache?.remember(entry);
    } finally {
      buffers.push(buffer);
    }
  });
  signal?.throwIfAborted();
  excluded.unreadable += unreadable.size;
  const kept = unreadable.size > 0 ? entries.filter((entry) => !unreadable.has(entry)) : entries;
  kept.sort((left, right) => compareArchivePaths(left.path, right.path));
  cache?.commitScan();
  return { entries: kept, excluded };
}

// --- delta ----------------------------------------------------------------------

/** Whether `current` counts as modified against `previous` (section 5.8). */
export function isArchiveEntryModified(previous: ArchiveEntry, current: ArchiveEntry): boolean {
  if (previous.type !== current.type || previous.mode !== current.mode) return true;
  if (current.type === "file") return previous.sha256 !== current.sha256;
  if (current.type === "symlink") return previous.target !== current.target;
  return false;
}

export type ArchiveDelta<T extends ArchiveEntry> = { files: T[]; deleted: string[] };

function sortedByPath<T extends ArchiveEntry>(entries: readonly T[]): readonly T[] {
  for (let index = 1; index < entries.length; index += 1) {
    if (compareArchivePaths(entries[index - 1]!.path, entries[index]!.path) >= 0) {
      return [...entries].sort((left, right) => compareArchivePaths(left.path, right.path));
    }
  }
  return entries;
}

/**
 * Added and modified entries of the scan, plus every baseline path that is
 * gone, both sorted. A merge of two sorted lists: no index of either is built.
 */
export function computeArchiveDelta<T extends ArchiveEntry>(baseline: readonly ArchiveEntry[], current: readonly T[]): ArchiveDelta<T> {
  const previous = sortedByPath(baseline);
  const scanned = sortedByPath(current);
  const files: T[] = [];
  const deleted: string[] = [];
  let left = 0;
  let right = 0;
  while (left < previous.length || right < scanned.length) {
    const old = previous[left];
    const now = scanned[right];
    const order = old === undefined ? 1 : now === undefined ? -1 : compareArchivePaths(old.path, now.path);
    if (order < 0) {
      deleted.push(old!.path);
      left += 1;
    } else if (order > 0) {
      files.push(now!);
      right += 1;
    } else {
      if (isArchiveEntryModified(old!, now!)) files.push(now!);
      left += 1;
      right += 1;
    }
  }
  return { files, deleted };
}

export function isArchiveDeltaEmpty(delta: ArchiveDelta<ArchiveEntry>): boolean {
  return delta.files.length === 0 && delta.deleted.length === 0;
}

// --- manifest ---------------------------------------------------------------------

/** The manifest/baseline form of an entry: exactly the section 5.4 fields, in order. */
export function archiveEntry(entry: ArchiveEntry): ArchiveEntry {
  const out: ArchiveEntry = { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size, sha256: entry.sha256 };
  if (entry.type === "symlink") out.target = entry.target ?? "";
  return out;
}

export type ManifestInput = {
  kind: ArchiveKind;
  archiveId: string;
  sessionId: string;
  sequence: number;
  turn: number;
  createdAt: Date;
  parentArchiveId: string | null;
  /** Deltas only: a completed turn, or a final archive (then with its reason). */
  trigger?: ArchiveTrigger;
  reason?: FinalReason;
  label: string;
  marker: string;
  git: ArchiveGit | null;
  files: readonly ArchiveEntry[];
  deleted?: readonly string[];
  excluded: ExcludedCounts;
};

/** A manifest that is serialised on demand: its size first, then its bytes while the tar is written. */
export type ManifestSource = { size: number; chunks: () => Iterable<Buffer> };

/**
 * `__omnirush__/manifest.json`. The entries are serialised a batch at a time,
 * once to learn the size the tar header needs and again while the member is
 * written, so a 200k-entry manifest (about 165 bytes per entry) is never held
 * in memory whole. The entries must not change in between.
 */
export function manifestSource(input: ManifestInput): ManifestSource {
  const head = JSON.stringify({
    schema: ARCHIVE_SCHEMA,
    kind: input.kind,
    archive_id: input.archiveId,
    session_id: input.sessionId,
    sequence: input.sequence,
    turn: input.turn,
    created_at: input.createdAt.toISOString(),
    parent_archive_id: input.parentArchiveId,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    workspace: { label: input.label, marker: input.marker, git: input.git },
  });
  const deleted = input.kind === "delta" ? `,"deleted":${JSON.stringify(input.deleted ?? [])}` : "";
  const tail = `]${deleted},"excluded":${JSON.stringify(input.excluded)}}`;
  function* chunks(): Generator<Buffer> {
    yield Buffer.from(`${head.slice(0, -1)},"files":[`, "utf8");
    for (let index = 0; index < input.files.length; index += 2_000) {
      const batch = input.files.slice(index, index + 2_000).map((entry) => JSON.stringify(archiveEntry(entry)));
      yield Buffer.from(`${index === 0 ? "" : ","}${batch.join(",")}`, "utf8");
    }
    yield Buffer.from(tail, "utf8");
  }
  let size = 0;
  for (const chunk of chunks()) size += chunk.length;
  return { size, chunks };
}

export function buildManifestBytes(input: ManifestInput): Buffer {
  return Buffer.concat([...manifestSource(input).chunks()]);
}

// --- git ------------------------------------------------------------------------

type GitRun = { ok: boolean; stdout: string; truncated: boolean };

/**
 * GIT_CEILING_DIRECTORIES with the real home directory appended: git never
 * climbs into home, so a folder whose nearest `.git` git rejects (an empty
 * folder, say) cannot pick up a dotfiles repository there.
 */
function gitCeilingDirectories(): string {
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    // An unreadable home is used as given.
  }
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  if (!home) return existing ?? "";
  return existing ? `${existing}${delimiter}${home}` : home;
}

/** Runs git in the root without locks, prompts or fsmonitor hooks, never above home; reads at most `maxBytes` of stdout. */
function runGit(root: string, args: string[], maxBytes = 64 * 1024): Promise<GitRun> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok, stdout: Buffer.concat(chunks).toString("utf8"), truncated });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish(false);
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    try {
      child = spawn("git", ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: gitCeilingDirectories(),
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: "C",
        },
      });
    } catch {
      finish(false);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - total;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        total = maxBytes;
        truncated = true;
        child?.kill("SIGKILL");
        finish(true);
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

async function gitLine(root: string, args: string[]): Promise<string | null> {
  const result = await runGit(root, args);
  if (!result.ok || result.truncated) return null;
  return result.stdout.trim() || null;
}

/**
 * workspace.git (section 5.6): HEAD, branch, the origin (else first) remote
 * without userinfo, whether `git status --porcelain` prints anything, and the
 * root's path inside the repository ("" at its top level; a git_parent root
 * is a folder inside it).
 * Null when git cannot read the repository. GIT_OPTIONAL_LOCKS=0 keeps
 * `git status` from rewriting .git/index, which would otherwise show up as a
 * change in the next delta.
 */
export async function readArchiveGit(root: string): Promise<ArchiveGit | null> {
  if (!(await runGit(root, ["rev-parse", "--git-dir"])).ok) return null;
  const [head, branch, remotes, status, prefix] = await Promise.all([
    gitLine(root, ["rev-parse", "--verify", "-q", "HEAD"]),
    gitLine(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    gitLine(root, ["remote"]),
    runGit(root, ["status", "--porcelain", "--untracked-files=normal"], 1),
    runGit(root, ["rev-parse", "--show-prefix"]),
  ]);
  const names = remotes?.split(/\r?\n/).map((name) => name.trim()).filter(Boolean) ?? [];
  const remoteName = names.includes("origin") ? "origin" : names[0];
  const remoteUrl = remoteName ? await gitLine(root, ["remote", "get-url", remoteName]) : null;
  return {
    head: head && /^[0-9a-f]{40,64}$/.test(head) ? head : null,
    branch,
    remote: remoteUrl ? stripRemoteUserinfo(remoteUrl) : null,
    dirty: status.ok && status.stdout.length > 0,
    ...(prefix.ok && !prefix.truncated ? { path: prefix.stdout.replace(/\r?\n$/, "").replace(/\/$/, "") } : {}),
  };
}
