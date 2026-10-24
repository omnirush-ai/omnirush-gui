// Durable capture-gap log (`context.capture_gaps`): what could not be
// captured for a session and why, kept on disk per session so a crash or a
// restart does not lose it. Each note is one JSON line in
// <dir>/<session>.jsonl; the session's whole list (open and resolved) is
// sent again at every session start, resume and recovery included, and at
// each turn end that noted something. Identical in the CLI and the desktop app.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const CAPTURE_GAPS_SCHEMA = "omnirush.capture-gaps.v1";
/** Logs untouched this long are removed (the session is long over). */
export const CAPTURE_GAPS_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** Distinct gaps kept per session (by `what`); later ones only count. */
const MAX_GAPS = 200;
const SESSION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export type CaptureGap = {
  /** What is missing: a section, an event kind, an upload. */
  what: string;
  /** Why: timeout, failed, refused, spooled, ... */
  why: string;
  turn: number | null;
  first_at: string;
  last_at: string;
  count: number;
  /** What brings it back, when anything does (spool_retry, chain_reopen_next_prompt, ...). */
  recovery?: string | null;
  detail?: string | null;
  resolved_at?: string | null;
};

type Line = { at: string; what: string; why?: string; turn?: number | null; recovery?: string | null; detail?: string | null; resolved?: boolean };

/** The session's gaps from its log lines, by `what` (a resolve line closes the open one). */
export function foldGaps(lines: Line[]): CaptureGap[] {
  const gaps = new Map<string, CaptureGap>();
  for (const line of lines) {
    if (!line || typeof line.what !== "string" || typeof line.at !== "string") continue;
    const known = gaps.get(line.what);
    if (line.resolved) {
      if (known && !known.resolved_at) known.resolved_at = line.at;
      continue;
    }
    if (known && !known.resolved_at) {
      known.last_at = line.at;
      known.count += 1;
      known.why = line.why ?? known.why;
      if (line.detail) known.detail = line.detail;
      continue;
    }
    if (!known && gaps.size >= MAX_GAPS) continue;
    gaps.set(line.what, { what: line.what, why: line.why ?? "unknown", turn: line.turn ?? null, first_at: line.at, last_at: line.at, count: 1, recovery: line.recovery ?? null, detail: line.detail ?? null, resolved_at: null });
  }
  return [...gaps.values()];
}

export class CaptureGapLog {
  private readonly written = new Map<string, Promise<void>>();
  /** Sessions with a note since their gaps were last sent. */
  private readonly dirty = new Set<string>();
  /** Open gaps (by `what`) per session this process noted or read back. */
  private readonly open = new Map<string, Set<string>>();

  constructor(private readonly dir: string | null, private readonly now: () => number = Date.now) {}

  private file(sessionId: string): string | null {
    return this.dir && SESSION_ID.test(sessionId) ? join(this.dir, `${sessionId}.jsonl`) : null;
  }

  private append(sessionId: string, line: Line): Promise<void> {
    this.dirty.add(sessionId);
    const file = this.file(sessionId);
    const previous = this.written.get(sessionId) ?? Promise.resolve();
    // One write after another per session: lines never interleave.
    const next = previous.then(async () => {
      if (!file || !this.dir) return;
      await mkdir(this.dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
    }).catch(() => undefined);
    this.written.set(sessionId, next);
    return next;
  }

  note(sessionId: string, gap: { what: string; why: string; turn?: number | null; recovery?: string | null; detail?: string | null }): Promise<void> {
    const open = this.open.get(sessionId) ?? new Set<string>();
    open.add(gap.what);
    this.open.set(sessionId, open);
    return this.append(sessionId, { at: new Date(this.now()).toISOString(), ...gap, detail: gap.detail ? String(gap.detail).slice(0, 300) : null });
  }

  /** Closes an open gap; nothing is written when the session has none of that name (the common case). */
  resolve(sessionId: string, what: string): Promise<void> {
    const open = this.open.get(sessionId);
    if (open ? !open.delete(what) : !(this.file(sessionId) && existsSync(this.file(sessionId)!))) return Promise.resolve();
    return this.append(sessionId, { at: new Date(this.now()).toISOString(), what, resolved: true });
  }

  /** How many gaps of the session are open whose name starts with `prefix` (this process's view). */
  openCount(sessionId: string, prefix = ""): number {
    return [...(this.open.get(sessionId) ?? [])].filter((what) => what.startsWith(prefix)).length;
  }

  /** Whether the session noted something since `taken` last ran for it. */
  pending(sessionId: string): boolean {
    return this.dirty.has(sessionId);
  }

  /** The session's gaps (all of them, from disk), marking them sent. */
  async take(sessionId: string): Promise<CaptureGap[]> {
    this.dirty.delete(sessionId);
    await this.written.get(sessionId);
    const file = this.file(sessionId);
    if (!file) return [];
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const lines: Line[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw));
      } catch {
        // A line cut by a crash.
      }
    }
    const gaps = foldGaps(lines);
    this.open.set(sessionId, new Set(gaps.filter((gap) => !gap.resolved_at).map((gap) => gap.what)));
    return gaps;
  }

  /** Removes logs untouched for CAPTURE_GAPS_MAX_AGE_MS. Never throws. */
  async prune(maxAgeMs = CAPTURE_GAPS_MAX_AGE_MS): Promise<void> {
    if (!this.dir) return;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(this.dir, name);
      const info = await stat(file).catch(() => null);
      if (info && this.now() - info.mtimeMs > maxAgeMs) await rm(file, { force: true }).catch(() => undefined);
    }
  }
}
