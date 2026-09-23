/**
 * The "turn.diff" trace event: at the end of each turn, a unified diff per
 * workspace file the turn changed, of the scrubbed text the collector last
 * sent for it before the turn against the scrubbed text it sent after, so the
 * trace pairs the turn with exactly what it changed. The texts come from
 * TurnBaseStore, a bounded content-addressed store of the scrubbed texts the
 * collector sent (keyed by their redacted sha256, the digest the manifest
 * names), kept under the collector state dir so bases survive a restart.
 * Everything here runs on the capture worker (see capture-host.ts).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A file diff is cut at this many bytes (as JSON-encoded in the event). */
export const MAX_TURN_DIFF_FILE_BYTES = 256 * 1024;
/** One "turn.diff" trace event, JSON-encoded with its envelope, is at most this many bytes. */
export const MAX_TURN_DIFF_EVENT_BYTES = 2 * 1024 * 1024;
/** A turn's diffs get this much time in all; the files still waiting once it is spent are only counted. */
export const MAX_TURN_DIFF_MS = 250;
/** Budget of the base store, least recently used out first. */
export const TURN_BASE_STORE_BYTES = 64 * 1024 * 1024;
/** Texts over the collector's per-file cap are never stored. */
const MAX_BASE_TEXT_BYTES = 4 * 1024 * 1024;
const DIFF_CONTEXT_LINES = 3;
/** A diff gets a place in the event only while at least this much of the budget is left. */
const MIN_DIFF_ROOM_BYTES = 1024;
/** Past this edit distance, or this much work, the exact diff gives way to a greedy one. */
const MAX_EDIT_DISTANCE = 1_500;
/**
 * Line comparisons one file's diff may make, exact and greedy passes together;
 * past them the rest of the change is written as removed and added.
 */
const MAX_DIFF_COMPARISONS = 5_000_000;
/** How far ahead the greedy diff looks, on each side, for the lines to line up again. */
const GREEDY_WINDOW = 32;
/** The event around its entries, as the trace carries it, every count at its widest. */
const EVENT_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({
  at: new Date(0).toISOString(),
  type: "turn.diff",
  data: { schema_version: 1, files: [], file_count: Number.MAX_SAFE_INTEGER, omitted_file_count: Number.MAX_SAFE_INTEGER, truncated: false },
}));
const BASE_WRITE_CONCURRENCY = 8;
/** Texts waiting to be written beyond this make writable() wait, so a start snapshot never holds more. */
const BASE_PENDING_HIGH_WATER = 8 * 1024 * 1024;
const BASE_INDEX_FILE = "index.json";
const BASE_INDEX_SAVE_MS = 2_000;
const SHA256_NAME = /^[0-9a-f]{64}$/;

export type TurnDiffStatus = "added" | "modified" | "deleted" | "skipped" | "no_base";

/** One file of a "turn.diff" event. */
export type TurnDiffFile = {
  /** Workspace-relative, redacted as upload paths are. */
  path: string;
  status: TurnDiffStatus;
  /**
   * Redacted sha256 of the text before the turn: null for an added or skipped
   * file, and for a no_base one the collector first saw already changed by the turn.
   */
  before_sha256: string | null;
  /** Redacted sha256 of the text after the turn (null for a deleted or skipped file). */
  after_sha256: string | null;
  /** Lines added and removed: exact, or an upper bound where the diff's comparison budget ran out (a correct patch still). */
  additions: number | null;
  deletions: number | null;
  /** Unified diff of the scrubbed texts; null when a side is unavailable (no_base) or the file was skipped. */
  diff: string | null;
  /** The diff was cut at MAX_TURN_DIFF_FILE_BYTES or at the event's remaining budget. */
  truncated: boolean;
};

export type TurnDiffEvent = {
  schema_version: 1;
  files: TurnDiffFile[];
  /** Files the turn changed, including any the event cap left out of `files`. */
  file_count: number;
  /** Files left out of `files`: past the event cap, or waiting for a diff once the turn's diff time was spent. */
  omitted_file_count: number;
  /** A diff was cut or a file left out. */
  truncated: boolean;
};

/**
 * A changed file with its texts resolved: null where that side has no text
 * (added, deleted, skipped, no base) or where the texts were not read (the
 * event could take no further diff).
 */
export type TurnDiffInput = {
  path: string;
  status: TurnDiffStatus;
  before_sha256: string | null;
  after_sha256: string | null;
  before: string | null;
  after: string | null;
};

type Lines = { lines: string[]; eofNewline: boolean };

function splitLines(text: string): Lines {
  if (text === "") return { lines: [], eofNewline: true };
  const lines = text.split("\n");
  const eofNewline = lines.at(-1) === "";
  if (eofNewline) lines.pop();
  return { lines, eofNewline };
}

/**
 * Integer ids for the lines between the common prefix and suffix, equal
 * lines sharing one. A line gets its id only once the diff first reaches it,
 * so a diff that stops at its budget never pays for the lines past that point.
 */
class LineIds {
  private readonly ids = new Map<string, number>();
  private readonly a: Int32Array;
  private readonly b: Int32Array;
  private doneA = 0;
  private doneB = 0;

  constructor(private readonly keyA: (index: number) => string, private readonly keyB: (index: number) => string, n: number, m: number) {
    this.a = new Int32Array(n);
    this.b = new Int32Array(m);
  }

  private intern(text: string): number {
    let id = this.ids.get(text);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(text, id);
    }
    return id;
  }

  idA(index: number): number {
    for (; this.doneA <= index; this.doneA += 1) this.a[this.doneA] = this.intern(this.keyA(this.doneA));
    return this.a[index]!;
  }

  idB(index: number): number {
    for (; this.doneB <= index; this.doneB += 1) this.b[this.doneB] = this.intern(this.keyB(this.doneB));
    return this.b[index]!;
  }
}

/**
 * Marks the lines outside a longest common subsequence of the `n` lines of
 * one side and the `m` of the other (Myers' O(ND) algorithm), or, once the
 * edit distance or the work passes its bound, outside a greedy matching: a
 * correct diff either way, only not always a minimal one.
 */
function markChanges(ids: LineIds, n: number, m: number, removed: Uint8Array, added: Uint8Array, offset: number, budget: number): void {
  if (n === 0 || m === 0) {
    removed.fill(1, offset, offset + n);
    added.fill(1, offset, offset + m);
    return;
  }
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const middle = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  // The exact search gets half the budget, the greedy pass (which starts over from the top) the rest.
  const exactBudget = budget / 2;
  exact: for (let d = 0; d <= limit; d += 1) {
    // What round d reads of round d-1: v[k-1] and v[k+1] for k in [-d, d].
    trace.push(v.slice(middle - d - 1, middle + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[middle + k - 1]! < v[middle + k + 1]!) ? v[middle + k + 1]! : v[middle + k - 1]! + 1;
      let y = x - k;
      const start = x;
      while (x < n && y < m && ids.idA(x) === ids.idB(y)) {
        x += 1;
        y += 1;
      }
      work += 1 + x - start;
      v[middle + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, removed, added, offset);
      if (work > exactBudget) break exact;
    }
  }
  greedy(ids, n, m, removed, added, offset, budget - work);
}

/**
 * Walks both sides together; at a mismatch, the nearest point within the
 * window where they line up again ends the edit. Linear in the lines times
 * the window squared, whatever the edit distance, and stops once `budget`
 * comparisons are spent: everything past that point is removed and added.
 */
function greedy(ids: LineIds, n: number, m: number, removed: Uint8Array, added: Uint8Array, offset: number, budget: number): void {
  let i = 0;
  let j = 0;
  let work = 0;
  while (i < n && j < m && work < budget) {
    work += 1;
    if (ids.idA(i) === ids.idB(j)) {
      i += 1;
      j += 1;
      continue;
    }
    let skipA = 1;
    let skipB = 1;
    search: for (let distance = 1; distance <= 2 * GREEDY_WINDOW; distance += 1) {
      for (let x = Math.max(0, distance - GREEDY_WINDOW); x <= Math.min(distance, GREEDY_WINDOW); x += 1) {
        work += 1;
        if (i + x < n && j + distance - x < m && ids.idA(i + x) === ids.idB(j + distance - x)) {
          skipA = x;
          skipB = distance - x;
          break search;
        }
      }
    }
    removed.fill(1, offset + i, offset + i + skipA);
    added.fill(1, offset + j, offset + j + skipB);
    i += skipA;
    j += skipB;
  }
  removed.fill(1, offset + i, offset + n);
  added.fill(1, offset + j, offset + m);
}

/** Walks the recorded rounds back from the end, marking the one edit each round made. */
function backtrack(trace: Int32Array[], n: number, m: number, removed: Uint8Array, added: Uint8Array, offset: number): void {
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousX = at(down ? k + 1 : k - 1);
    const previousY = previousX - (down ? k + 1 : k - 1);
    if (down) added[offset + previousY] = 1;
    else removed[offset + previousX] = 1;
    x = previousX;
    y = previousY;
  }
}

/** Bytes a line costs in the event: JSON-escaped, with its escaped newline in place of the quotes. */
function lineCost(line: string): number {
  return Buffer.byteLength(JSON.stringify(line));
}

/**
 * A unified diff (3 lines of context) of `before` into `after`, a null side
 * standing for /dev/null. The counts cover the whole change (exact, or an
 * upper bound once `maxComparisons` cut the line matching short); the text
 * stops at the last whole line within `maxBytes` (measured JSON-encoded),
 * marked truncated. The patch always turns `before` into `after`.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, maxBytes = MAX_TURN_DIFF_FILE_BYTES, maxComparisons = MAX_DIFF_COMPARISONS): { diff: string; additions: number; deletions: number; truncated: boolean; bytes: number } {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  // A last line without a newline differs from the same line with one.
  const key = (side: Lines, index: number) => (index === side.lines.length - 1 && !side.eofNewline ? `${side.lines[index]}\u0000` : side.lines[index]!);
  const nA = a.lines.length;
  const nB = b.lines.length;
  let prefix = 0;
  while (prefix < nA && prefix < nB && key(a, prefix) === key(b, prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < nA - prefix && suffix < nB - prefix && key(a, nA - 1 - suffix) === key(b, nB - 1 - suffix)) suffix += 1;
  const n = nA - prefix - suffix;
  const m = nB - prefix - suffix;
  const ids = new LineIds((index) => key(a, prefix + index), (index) => key(b, prefix + index), n, m);
  const removed = new Uint8Array(nA);
  const added = new Uint8Array(nB);
  markChanges(ids, n, m, removed, added, prefix, maxComparisons);

  type Block = { aStart: number; aEnd: number; bStart: number; bEnd: number };
  const blocks: Block[] = [];
  let additions = 0;
  let deletions = 0;
  for (let i = prefix, j = prefix; i < nA - suffix || j < nB - suffix;) {
    if (i < nA && j < nB && !removed[i] && !added[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const block = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    while (i < nA && removed[i]) i += 1;
    while (j < nB && added[j]) j += 1;
    block.aEnd = i;
    block.bEnd = j;
    deletions += i - block.aStart;
    additions += j - block.bStart;
    blocks.push(block);
  }

  const out: string[] = [];
  let bytes = 0;
  let truncated = false;
  const push = (line: string): boolean => {
    const cost = lineCost(line);
    if (bytes + cost > maxBytes) {
      truncated = true;
      return false;
    }
    out.push(line);
    bytes += cost;
    return true;
  };
  const noNewline = "\\ No newline at end of file";
  const emit = (prefixChar: string, side: Lines, index: number): boolean => {
    if (!push(`${prefixChar}${side.lines[index]}`)) return false;
    return index === side.lines.length - 1 && !side.eofNewline ? push(noNewline) : true;
  };
  const range = (start: number, length: number) => (length === 1 ? `${start + 1}` : `${length === 0 ? start : start + 1},${length}`);
  if (blocks.length > 0 && push(`--- ${before === null ? "/dev/null" : `a/${path}`}`) && push(`+++ ${after === null ? "/dev/null" : `b/${path}`}`)) {
    hunks: for (let index = 0; index < blocks.length;) {
      // A hunk runs over every block within twice the context of the one before.
      let last = index;
      while (last + 1 < blocks.length && blocks[last + 1]!.aStart - blocks[last]!.aEnd <= 2 * DIFF_CONTEXT_LINES) last += 1;
      const first = blocks[index]!;
      const end = blocks[last]!;
      const lead = Math.min(DIFF_CONTEXT_LINES, first.aStart);
      const trail = Math.min(DIFF_CONTEXT_LINES, nA - end.aEnd);
      const aStart = first.aStart - lead;
      const bStart = first.bStart - lead;
      const aLength = end.aEnd + trail - aStart;
      const bLength = end.bEnd + trail - bStart;
      if (!push(`@@ -${range(aStart, aLength)} +${range(bStart, bLength)} @@`)) break;
      let i = aStart;
      let j = bStart;
      for (let at = index; at <= last; at += 1) {
        const block = blocks[at]!;
        for (; i < block.aStart; i += 1, j += 1) if (!emit(" ", b, j)) break hunks;
        for (; i < block.aEnd; i += 1) if (!emit("-", a, i)) break hunks;
        for (; j < block.bEnd; j += 1) if (!emit("+", b, j)) break hunks;
      }
      for (let count = 0; count < trail; count += 1, i += 1, j += 1) if (!emit(" ", b, j)) break hunks;
      index = last + 1;
    }
  }
  return { diff: out.length > 0 ? `${out.join("\n")}\n` : "", additions, deletions, truncated, bytes };
}

/**
 * Assembles one "turn.diff" event under the event cap: each file's diff gets
 * at most MAX_TURN_DIFF_FILE_BYTES and what is left of the event's budget.
 * Once no further diff fits, in the event or in the turn's diff time, a file
 * that needs one is only counted, while an entry without diff text (skipped,
 * no_base) still goes in as long as it fits.
 */
export class TurnDiffBuilder {
  private readonly files: TurnDiffFile[] = [];
  /** Bytes of the event so far, its envelope reserved from the start. */
  private used = EVENT_ENVELOPE_BYTES;
  private omitted = 0;
  private truncated = false;
  /** Time spent diffing so far. */
  private diffMs = 0;

  constructor(
    private readonly maxEventBytes = MAX_TURN_DIFF_EVENT_BYTES,
    private readonly maxFileBytes = MAX_TURN_DIFF_FILE_BYTES,
    private readonly maxDiffMs = MAX_TURN_DIFF_MS,
  ) {}

  /** No further diff fits: the caller need not resolve texts. */
  get full(): boolean {
    return this.used + MIN_DIFF_ROOM_BYTES > this.maxEventBytes || this.diffMs >= this.maxDiffMs;
  }

  omit(): void {
    this.omitted += 1;
    this.truncated = true;
  }

  add(input: TurnDiffInput): void {
    const diffed = input.status === "added" || input.status === "modified" || input.status === "deleted";
    if (diffed && this.full) return this.omit();
    const before = input.status === "added" ? null : input.before;
    const after = input.status === "deleted" ? null : input.after;
    const hasText = diffed && (before !== null || after !== null);
    const file: TurnDiffFile = {
      path: input.path,
      status: input.status,
      before_sha256: input.before_sha256,
      after_sha256: input.after_sha256,
      // At their widest while the entry is measured: a count never exceeds its text's length.
      additions: hasText ? after?.length ?? 0 : null,
      deletions: hasText ? before?.length ?? 0 : null,
      diff: null,
      truncated: false,
    };
    // The entry without its diff, plus the comma between entries.
    const overhead = Buffer.byteLength(JSON.stringify(file)) + 1;
    const room = this.maxEventBytes - this.used - overhead;
    if (room < (hasText ? MIN_DIFF_ROOM_BYTES : 0)) return this.omit();
    if (hasText) {
      const started = performance.now();
      const result = unifiedDiff(input.path, before, after, Math.min(this.maxFileBytes, room));
      this.diffMs += performance.now() - started;
      file.additions = result.additions;
      file.deletions = result.deletions;
      file.diff = result.diff;
      file.truncated = result.truncated;
      if (result.truncated) this.truncated = true;
    }
    this.files.push(file);
    this.used += Buffer.byteLength(JSON.stringify(file)) + 1;
  }

  finish(): TurnDiffEvent {
    return {
      schema_version: 1,
      files: this.files,
      file_count: this.files.length + this.omitted,
      omitted_file_count: this.omitted,
      truncated: this.truncated,
    };
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The scrubbed texts the collector sent, by redacted sha256, least recently
 * used out first once `budget` bytes are held. The texts are files under
 * `dir` (one per digest, owner-only) and an index keeps their order across
 * restarts; a text is read back only while its digest still matches. Writes
 * happen in the background with bounded concurrency, and a text still being
 * written is served from memory.
 */
export class TurnBaseStore {
  /** Digest -> bytes, least recently used first. */
  private readonly index = new Map<string, number>();
  private readonly pending = new Map<string, { text: string; bytes: number }>();
  private readonly queue: string[] = [];
  private pendingBytes = 0;
  private used = 0;
  private active = 0;
  private generation = 0;
  /** The index changed since it was last saved. */
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private waiters: Array<{ limit: number; resolve: () => void }> = [];
  /** Removals of evicted texts still under way, by digest: a write of the same digest waits for its removal. */
  private readonly removals = new Map<string, Promise<void>>();
  /** Writes under way: clear() lets them settle before it removes the directory. */
  private readonly writing = new Set<Promise<void>>();

  constructor(private readonly dir: string, private readonly budget = TURN_BASE_STORE_BYTES) {
    this.ready = this.load(dir);
  }

  private async load(dir: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, BASE_INDEX_FILE), "utf8"));
      const entries = typeof parsed === "object" && parsed !== null && "entries" in parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !SHA256_NAME.test(entry[0]) || typeof entry[1] !== "number") continue;
        if (entry[1] < 0 || entry[1] > MAX_BASE_TEXT_BYTES || this.index.has(entry[0])) continue;
        this.index.set(entry[0], entry[1]);
        this.used += entry[1];
      }
    } catch {
      // No index yet, or an unreadable one: start empty.
    }
    try {
      // Texts no index names (written just before a crash) are never read: remove them.
      for (const name of await readdir(dir)) {
        if (name !== BASE_INDEX_FILE && !this.index.has(name)) await rm(join(dir, name), { force: true });
      }
    } catch {
      // No directory yet.
    }
    this.evict();
  }

  private touch(sha256: string, bytes: number): void {
    this.index.delete(sha256);
    this.index.set(sha256, bytes);
    this.dirty = true;
  }

  private evict(): void {
    for (const [sha256, bytes] of this.index) {
      if (this.used <= this.budget) break;
      this.index.delete(sha256);
      this.used -= bytes;
      const removal: Promise<void> = rm(join(this.dir, sha256), { force: true }).catch(() => undefined).finally(() => {
        if (this.removals.get(sha256) === removal) this.removals.delete(sha256);
      });
      this.removals.set(sha256, removal);
    }
  }

  /** Whether a text is held under `sha256`, without reading it back. */
  async has(sha256: string): Promise<boolean> {
    if (this.pending.has(sha256)) return true;
    await this.ready;
    return this.index.has(sha256);
  }

  /** Remembers `text` (the scrubbed text whose redacted sha256 is `sha256`, `bytes` long). */
  put(sha256: string, text: string, bytes: number): void {
    if (bytes > MAX_BASE_TEXT_BYTES) return;
    if (this.index.has(sha256)) return this.touch(sha256, bytes);
    // Writes that cannot keep up are dropped rather than held: a missing base only costs a no_base entry.
    if (this.pending.has(sha256) || this.pendingBytes + bytes > this.budget) return;
    this.pending.set(sha256, { text, bytes });
    this.pendingBytes += bytes;
    this.queue.push(sha256);
    this.pump();
  }

  private pump(): void {
    while (this.active < BASE_WRITE_CONCURRENCY && this.queue.length > 0) {
      const sha256 = this.queue.shift()!;
      this.active += 1;
      const writing: Promise<void> = this.write(sha256).finally(() => {
        this.writing.delete(writing);
        this.active -= 1;
        const held = this.pending.get(sha256);
        if (held) {
          this.pending.delete(sha256);
          this.pendingBytes -= held.bytes;
        }
        this.pump();
        this.wake();
      });
      this.writing.add(writing);
    }
  }

  private wake(): void {
    const outstanding = this.active > 0 || this.queue.length > 0 ? this.pendingBytes + 1 : 0;
    this.waiters = this.waiters.filter((waiter) => {
      if (outstanding > waiter.limit) return true;
      waiter.resolve();
      return false;
    });
  }

  /** Resolves once queued writes hold at most `limit` bytes (0: once none are left). */
  private below(limit: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ limit, resolve });
      this.wake();
    });
  }

  /** Resolves once the write queue has room again: a caller putting many texts awaits it between puts. */
  writable(): Promise<void> {
    return this.pendingBytes <= BASE_PENDING_HIGH_WATER ? Promise.resolve() : this.below(BASE_PENDING_HIGH_WATER);
  }

  private async write(sha256: string): Promise<void> {
    const generation = this.generation;
    const held = this.pending.get(sha256);
    const dir = this.dir;
    try {
      await this.ready;
      // An evicted copy of the same digest is removed first, or its late removal would take this one.
      await this.removals.get(sha256);
      if (!held || generation !== this.generation) return;
      const { text, bytes } = held;
      if (this.index.has(sha256)) return this.touch(sha256, bytes);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, sha256), text, { mode: 0o600 });
      if (generation !== this.generation) {
        await rm(join(dir, sha256), { force: true });
        return;
      }
      this.index.set(sha256, bytes);
      this.used += bytes;
      this.dirty = true;
      this.evict();
      this.scheduleSave();
    } catch {
      // A text that could not be written is simply not a base.
    }
  }

  /** The text stored under `sha256`, or null. */
  async get(sha256: string): Promise<string | null> {
    const pending = this.pending.get(sha256);
    if (pending) return pending.text;
    await this.ready;
    const bytes = this.index.get(sha256);
    if (bytes === undefined) return null;
    try {
      const text = await readFile(join(this.dir, sha256), "utf8");
      if (sha256Hex(text) !== sha256) throw new Error("base text changed on disk");
      if (this.index.has(sha256)) this.touch(sha256, bytes);
      return text;
    } catch {
      if (this.index.get(sha256) === bytes) {
        this.index.delete(sha256);
        this.used -= bytes;
      }
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, BASE_INDEX_SAVE_MS);
    this.saveTimer.unref?.();
  }

  private save(): Promise<void> {
    const dir = this.dir;
    const generation = this.generation;
    this.dirty = false;
    const index = JSON.stringify({ version: 1, entries: [...this.index] });
    this.saveTail = this.saveTail.then(async () => {
      if (generation !== this.generation) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, `${BASE_INDEX_FILE}.tmp`), index, { mode: 0o600 });
      await rename(join(dir, `${BASE_INDEX_FILE}.tmp`), join(dir, BASE_INDEX_FILE));
    }).catch(() => undefined);
    return this.saveTail;
  }

  /** Waits for queued writes and saves the index (shutdown). */
  async flush(): Promise<void> {
    await this.below(0);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.ready;
    if (this.dirty) await this.save();
  }

  /** Forgets every text and removes the directory (sign-out). */
  async clear(): Promise<void> {
    this.generation += 1;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Queued texts are never written. One already being written sees the new
    // generation and removes itself, and settles before the directory goes:
    // nothing it does can recreate the directory afterwards.
    this.queue.length = 0;
    const writing = [...this.writing];
    // After the load, which would otherwise fill the index again.
    await this.ready;
    this.index.clear();
    this.pending.clear();
    this.pendingBytes = 0;
    this.used = 0;
    this.dirty = false;
    this.wake();
    await Promise.all(writing);
    await Promise.all(this.removals.values());
    await this.saveTail;
    await rm(this.dir, { recursive: true, force: true });
  }
}
