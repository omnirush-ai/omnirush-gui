/**
 * The touched-files archive (policy `touched_files`, README "Touched
 * files"): in a session folder that is neither a git repository nor inside
 * one, only the files the agent touched there are archived, byte for byte.
 * The collector reports every path the session touched (the trace's tool
 * paths, the watcher's changes); TouchedPathStore keeps them per session on
 * disk, and scanTouchedFiles turns them into archive entries at capture
 * time: regular files inside the root only, never through a symlinked
 * folder, a touched folder never expanded, with the whole-folder scan's
 * exclusions, and never a file git ignores (`ignore.ts`). Nothing outside the root is ever opened or stat'ed: a path is
 * checked lexically first, then walked from the root one lstat at a time.
 */
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { appendFile, lstat, open, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  HASH_CONCURRENCY,
  HASH_READ_BYTES,
  OPEN_ENTRY_FLAGS,
  RESERVED_ROOT_NAME,
  STAT_CONCURRENCY,
  compareArchivePaths,
  decodeName,
  emptyExcludedCounts,
  excludedRelativeDirs,
  forEachBounded,
  isArchiveCredentialPath,
  isArchiveEntryModified,
  isSameFileIdentity,
  portable,
  statFields,
  type ArchiveEntry,
  type ArchiveHashCache,
  type ExcludedCounts,
  type ScannedEntry,
} from "./manifest.js";
import { stateKey } from "./files.js";
import { touchedIgnoredPaths } from "./ignore.js";
import type { ArchiveLog } from "./upload.js";

/** A session keeps at most this many touched paths; later ones are not archived (one log line). */
export const MAX_TOUCHED_PATHS = 100_000;
const MAX_TOUCHED_PATH_CHARS = 4_096;
/** A touched symlink is followed to a file inside the root through at most this many links. */
const MAX_LINK_HOPS = 8;
/** Reported paths reach the session's file within this long. */
const TOUCHED_FLUSH_MS = 2_000;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// --- scan -------------------------------------------------------------------------

export type TouchedScanOptions = {
  /** Absolute app state/temp/data directories; a path under one inside the root is counted as app_state. */
  excludedDirs?: readonly string[];
  /** archiveIncludeCredentialFiles: turns the credential filter off entirely. */
  includeCredentialFiles?: boolean;
  /** The root's hash cache; the scan looks up and adds entries and never prunes it (it sees only part of the root). */
  hashCache?: ArchiveHashCache;
  /** Stops the scan between paths: it then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Tests: every absolute path the scan lstats, reads a link of or opens, before it does. */
  onAccess?: (path: string) => void;
};

export type TouchedScanResult = {
  /** The touched regular files inside the root, sorted by UTF-8 bytes. */
  entries: ScannedEntry[];
  /**
   * Touched paths that hold no regular file inside the root any more: gone,
   * a folder, a symlink, a special file, or reached through a folder that is
   * no longer a real folder, or a file git now ignores. A delta deletes
   * those it archived before.
   */
  gone: Set<string>;
  excluded: ExcludedCounts;
  /** Touched files left out because git ignores them (not in `excluded`, section 5.6 is unchanged). */
  ignored: number;
};

/** A touched path's components when it is a plain relative path (portable `/`), else null. */
export function touchedPathParts(path: string): string[] | null {
  if (!path || path.length > MAX_TOUCHED_PATH_CHARS || path.includes("\0") || path.startsWith("/")) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  // Windows: no drive, no stream (`file:stream`), no separator inside a name.
  if (sep === "\\" && parts.some((part) => part.includes("\\") || part.includes(":"))) return null;
  return parts;
}

type DirState = "dir" | "gone" | "unreadable";

function missing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The root-relative path a symlink at `path` (absolute, under real folders)
 * points to, when it stays inside the root: resolved lexically against the
 * root as given and as its real path, so that nothing outside is looked at.
 * Null when it points outside, at the root itself, or cannot be read.
 */
function linkTargetInside(path: string, target: string, roots: readonly string[]): string | null {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
  for (const root of roots) {
    const rel = relative(root, absolute);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return portable(rel);
  }
  return null;
}

/**
 * Pass 1 of a touched-files capture: each path (and each symlink target
 * inside the root it leads to) walked from the root with lstat, never
 * following a link, then hashed; excluded like the whole-folder scan
 * (credential files, app state, reserved names, special files, unreadable
 * and non-UTF-8 names), and a file git ignores is left out (and deletes a
 * copy the chain holds, like a gone file). A path that is not plain, or whose link leads out of
 * the root, is skipped without touching the file system outside the root.
 */
export async function scanTouchedFiles(root: string, paths: Iterable<string>, options: TouchedScanOptions = {}): Promise<TouchedScanResult> {
  const { signal, hashCache: cache } = options;
  const access = options.onAccess ?? (() => undefined);
  const base = resolve(root);
  access(base);
  const roots = [base];
  const real = await realpath(base);
  if (real !== base) roots.push(real);
  const pruned = [...(await excludedRelativeDirs(base, options.excludedDirs ?? []))];
  const includeCredentials = options.includeCredentialFiles === true;
  const excluded = emptyExcludedCounts();
  const gone = new Set<string>();
  const entries: ScannedEntry[] = [];
  const seen = new Set<string>();
  const dirs = new Map<string, Promise<DirState>>();

  /** Whether `relDir` is a real folder under real folders (a symlink or a file in the way is "gone": the path is not inside the root). */
  const dirState = (parts: readonly string[], depth: number): Promise<DirState> => {
    const key = parts.slice(0, depth).join("/");
    let known = dirs.get(key);
    if (!known) {
      known = (async () => {
        if (depth > 1) {
          const parent = await dirState(parts, depth - 1);
          if (parent !== "dir") return parent;
        }
        const absolute = join(base, ...parts.slice(0, depth));
        access(absolute);
        try {
          const stats = await lstat(absolute);
          return stats.isDirectory() ? "dir" : "gone";
        } catch (error) {
          return missing(error) ? "gone" : "unreadable";
        }
      })();
      dirs.set(key, known);
    }
    return known;
  };

  const visit = async (path: string, hops: number): Promise<void> => {
    signal?.throwIfAborted();
    if (seen.has(path)) return;
    seen.add(path);
    const parts = touchedPathParts(path);
    if (!parts) return;
    if (LONE_SURROGATE.test(path)) {
      excluded.non_utf8 += 1;
      return;
    }
    if (parts[0] === RESERVED_ROOT_NAME) {
      excluded.reserved += 1;
      return;
    }
    if (pruned.some((dir) => path === dir || path.startsWith(`${dir}/`))) {
      excluded.app_state += 1;
      return;
    }
    if (!includeCredentials && isArchiveCredentialPath(path)) {
      excluded.credential += 1;
      return;
    }
    if (parts.length > 1) {
      const parent = await dirState(parts, parts.length - 1);
      if (parent === "unreadable") excluded.unreadable += 1;
      if (parent !== "dir") {
        if (parent === "gone") gone.add(path);
        return;
      }
    }
    const absolute = join(base, ...parts);
    let stats: BigIntStats;
    try {
      access(absolute);
      stats = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (missing(error)) gone.add(path);
      else excluded.unreadable += 1;
      return;
    }
    if (stats.isDirectory()) {
      // A touched folder is never expanded.
      gone.add(path);
      return;
    }
    if (stats.isSymbolicLink()) {
      gone.add(path);
      let target: string | null;
      try {
        access(absolute);
        target = decodeName(await readlink(absolute, { encoding: "buffer" }));
      } catch {
        excluded.unreadable += 1;
        return;
      }
      if (target === null) {
        excluded.non_utf8 += 1;
        return;
      }
      const inside = hops < MAX_LINK_HOPS ? linkTargetInside(absolute, target, roots) : null;
      // A link out of the root (or a chain too long) is skipped: its target is never looked at.
      if (inside === null) excluded.special += 1;
      else await visit(inside, hops + 1);
      return;
    }
    if (!stats.isFile()) {
      gone.add(path);
      excluded.special += 1;
      return;
    }
    entries.push({ path, type: "file", size: Number(stats.size), sha256: null, ...statFields(stats) });
  };

  await forEachBounded([...paths], STAT_CONCURRENCY, (path) => visit(path, 0));

  // Git's answer for just the files found, so the folder is never walked.
  const ignoredPaths = await touchedIgnoredPaths(base, entries.map((entry) => entry.path), signal);
  signal?.throwIfAborted();
  if (ignoredPaths.size > 0) {
    let kept = 0;
    for (const entry of entries) {
      if (ignoredPaths.has(entry.path)) gone.add(entry.path);
      else entries[kept++] = entry;
    }
    entries.length = kept;
  }

  const unreadable = new Set<ScannedEntry>();
  const buffers: Buffer[] = [];
  await forEachBounded(entries, HASH_CONCURRENCY, async (entry) => {
    signal?.throwIfAborted();
    const cached = cache?.lookup(entry) ?? null;
    if (cached) {
      entry.sha256 = cached;
      return;
    }
    const buffer = buffers.pop() ?? Buffer.allocUnsafe(HASH_READ_BYTES);
    try {
      const absolute = join(base, ...entry.path.split("/"));
      access(absolute);
      const sha256 = await hashTouchedFile(absolute, entry, buffer, signal);
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
  for (const path of gone) cache?.forget(path);
  excluded.unreadable += unreadable.size;
  const kept = unreadable.size > 0 ? entries.filter((entry) => !unreadable.has(entry)) : entries;
  kept.sort((left, right) => compareArchivePaths(left.path, right.path));
  return { entries: kept, gone, excluded, ignored: ignoredPaths.size };
}

/** SHA-256 of the first entry.size bytes of the very file pass 1 lstat'ed (same st_dev and st_ino), else null. */
async function hashTouchedFile(absolute: string, entry: ScannedEntry, buffer: Buffer, signal?: AbortSignal): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, OPEN_ENTRY_FLAGS);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || !isSameFileIdentity(entry, stats)) return null;
    const hash = createHash("sha256");
    let remaining = entry.size;
    while (remaining > 0) {
      if (signal?.aborted) return null;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type TouchedChange = {
  /** What the archive carries: every touched file for a base, the added and modified ones for a delta. */
  files: ScannedEntry[];
  /** Files an earlier archive of the chain holds that are gone from the folder. */
  deleted: string[];
  /** The chain's entry list after this archive: the next baseline. */
  next: ArchiveEntry[];
};

/**
 * A touched-files archive against the chain's baseline (empty for a base).
 * A baseline file the scan did not see and that is not gone (unreadable for
 * now) stays in the baseline as it was; only a gone one is deleted.
 */
export function touchedChange(baseline: readonly ArchiveEntry[], scan: TouchedScanResult): TouchedChange {
  const current = new Set(scan.entries.map((entry) => entry.path));
  const previous = new Map(baseline.map((entry) => [entry.path, entry]));
  const files = scan.entries.filter((entry) => {
    const old = previous.get(entry.path);
    return !old || isArchiveEntryModified(old, entry);
  });
  const kept = baseline.filter((entry) => !current.has(entry.path) && !scan.gone.has(entry.path));
  const deleted = baseline.filter((entry) => !current.has(entry.path) && scan.gone.has(entry.path)).map((entry) => entry.path);
  const next: ArchiveEntry[] = [...scan.entries, ...kept].sort((left, right) => compareArchivePaths(left.path, right.path));
  return { files, deleted: deleted.sort(compareArchivePaths), next };
}

// --- the touched set ------------------------------------------------------------------

type TouchedSession = {
  /** unknown until the gate has run for the session (paths wait in memory); ignored: not a touched-files chain. */
  mode: "unknown" | "tracked" | "ignored";
  /** The paths in the session's file (null until read) and those written since. */
  known: Set<string> | null;
  /** Reported and not in `known` yet. */
  pending: Set<string>;
  /** Being appended to the file right now. */
  writing: readonly string[];
  /** The file ends in a line torn by a crash: the next append starts a new line. */
  torn: boolean;
  capped: boolean;
};

/**
 * The paths each touched-files session touched, from its first prompt on:
 * appended to `<dir>/<session key>.jsonl` (a header line, then one JSON
 * string per line; a torn last line is skipped) a moment after they are
 * reported, so they survive an app restart. Paths of a session the gate has
 * not decided on yet wait in memory; `track` keeps them, `forget` drops them
 * and the file.
 */
export class TouchedPathStore {
  private readonly sessions = new Map<string, TouchedSession>();
  private readonly tails = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by clear(): writes started before it never land. */
  private epoch = 0;

  constructor(
    private readonly dir: string,
    private readonly options: {
      /** Resolves once the state dir is recovered. */
      ready: () => Promise<void>;
      /** What the session's record says it is: a touched-files chain, something else, or not known yet. */
      modeOf: (sessionId: string) => Promise<"tracked" | "ignored" | "unknown">;
      log: ArchiveLog;
      flushMs?: number;
    },
  ) {}

  /** A path the collector reported for the session (workspace-relative, portable). Cheap: a repeat is a lookup. */
  note(sessionId: string, path: string): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { mode: "unknown", known: null, pending: new Set(), writing: [], torn: false, capped: false };
      this.sessions.set(sessionId, session);
      const created = session;
      const epoch = this.epoch;
      void this.options.modeOf(sessionId).then((mode) => {
        if (epoch !== this.epoch || this.sessions.get(sessionId) !== created || created.mode !== "unknown" || mode === "unknown") return;
        if (mode === "tracked") this.track(sessionId);
        else this.drop(created);
      }, () => undefined);
    }
    if (session.mode === "ignored" || session.known?.has(path) || session.pending.has(path) || touchedPathParts(path) === null) return;
    if ((session.known?.size ?? 0) + session.pending.size + session.writing.length >= MAX_TOUCHED_PATHS) {
      if (!session.capped) this.options.log("warn", "OmniRush touched-files archive keeps a limited number of paths per session; later ones are not archived", { sessionId, limit: MAX_TOUCHED_PATHS });
      session.capped = true;
      return;
    }
    session.pending.add(path);
    if (session.mode === "tracked") this.schedule();
  }

  /** The session is a touched-files chain: its paths are kept on disk from now on. */
  track(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.mode = "tracked";
    else this.sessions.set(sessionId, { mode: "tracked", known: null, pending: new Set(), writing: [], torn: false, capped: false });
    this.schedule();
  }

  /** The session is not (or no longer) a touched-files chain: nothing more is kept, and its file goes. */
  forget(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.drop(session);
    else this.sessions.set(sessionId, { mode: "ignored", known: null, pending: new Set(), writing: [], torn: false, capped: false });
    const epoch = this.epoch;
    return this.serial(sessionId, async () => {
      if (epoch === this.epoch) await rm(this.file(sessionId), { force: true });
    });
  }

  /** Every path the session touched: its file and what is not written yet. The session counts as tracked from now on. */
  snapshot(sessionId: string): Promise<Set<string>> {
    this.track(sessionId);
    return this.serial(sessionId, async () => {
      await this.write(sessionId);
      const session = this.sessions.get(sessionId);
      return new Set([...(session?.known ?? []), ...(session?.pending ?? [])]);
    });
  }

  /** Whether the session has touched paths (in memory or on disk). */
  async has(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session && session.pending.size + (session.known?.size ?? 0) > 0) return true;
    return (await this.load(sessionId)).paths.size > 0;
  }

  /** Writes every tracked session's pending paths now. */
  async flush(): Promise<void> {
    this.clearTimer();
    await Promise.all([...this.sessions].filter(([, session]) => session.mode === "tracked" && session.pending.size > 0).map(([sessionId]) => this.serial(sessionId, () => this.write(sessionId))));
  }

  /** Sign-out: everything in memory goes, and no write started before lands. */
  clear(): void {
    this.epoch += 1;
    this.clearTimer();
    this.sessions.clear();
  }

  private drop(session: TouchedSession): void {
    session.mode = "ignored";
    session.known = null;
    session.pending = new Set();
  }

  private file(sessionId: string): string {
    return join(this.dir, `${stateKey(sessionId)}.jsonl`);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((error: unknown) => this.options.log("warn", "OmniRush touched-files paths could not be written", { error: error instanceof Error ? error.message : "unknown" }));
    }, this.options.flushMs ?? TOUCHED_FLUSH_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs `task` after the session's earlier file work. */
  private serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return run;
  }

  /**
   * The paths in the session's file; `fresh` when there is no usable file
   * (missing, or its header is not this session's), `torn` when its last
   * line has no end.
   */
  private async load(sessionId: string): Promise<{ paths: Set<string>; fresh: boolean; torn: boolean }> {
    await this.options.ready();
    const paths = new Set<string>();
    let text: string;
    try {
      text = await readFile(this.file(sessionId), "utf8");
    } catch {
      return { paths, fresh: true, torn: false };
    }
    const lines = text.split("\n");
    if (lines[0] !== this.header(sessionId)) return { paths, fresh: true, torn: false };
    for (const line of lines.slice(1)) {
      if (!line) continue;
      try {
        const path: unknown = JSON.parse(line);
        if (typeof path === "string" && touchedPathParts(path) !== null) paths.add(path);
      } catch {
        // A line torn by a crash.
      }
    }
    return { paths, fresh: false, torn: !text.endsWith("\n") };
  }

  private header(sessionId: string): string {
    return JSON.stringify({ v: 1, session_id: sessionId });
  }

  /** Appends the pending paths of a tracked session to its file (under serial()); a file that is not usable is started again. */
  private async write(sessionId: string): Promise<void> {
    const epoch = this.epoch;
    const session = this.sessions.get(sessionId);
    if (!session || session.mode !== "tracked") return;
    let header = "";
    if (!session.known) {
      const loaded = await this.load(sessionId);
      if (epoch !== this.epoch || session.mode !== "tracked") return;
      session.known = loaded.paths;
      for (const path of loaded.paths) session.pending.delete(path);
      if (loaded.fresh) header = `${this.header(sessionId)}\n`;
      session.torn = loaded.torn;
    }
    const known = session.known;
    if (session.pending.size === 0) return;
    const batch = [...session.pending];
    session.pending = new Set();
    session.writing = batch;
    try {
      const lines = `${batch.map((path) => JSON.stringify(path)).join("\n")}\n`;
      if (header) await writeFile(this.file(sessionId), `${header}${lines}`, { mode: 0o600 });
      else await appendFile(this.file(sessionId), `${session.torn ? "\n" : ""}${lines}`, { mode: 0o600 });
      session.torn = false;
      for (const path of batch) known.add(path);
    } catch (error) {
      for (const path of batch) if (!known.has(path)) session.pending.add(path);
      // Written from the start next time.
      if (header) session.known = null;
      throw error;
    } finally {
      session.writing = [];
    }
  }
}
