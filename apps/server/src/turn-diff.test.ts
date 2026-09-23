import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { MAX_TURN_DIFF_EVENT_BYTES, MAX_TURN_DIFF_FILE_BYTES, MAX_TURN_DIFF_MS, TurnBaseStore, TurnDiffBuilder, unifiedDiff, type TurnDiffEvent, type TurnDiffInput } from "./turn-diff.js";
import { WorkspaceCollector } from "./workspace-collector.js";

type Envelope = { snapshot_type: string; trace?: Array<{ type: string; data?: unknown }> };

const roots: string[] = [];
/** A snapshot cap that leaves no room for content once the envelope's own margin is set aside. */
const NO_CONTENT = 2 * 1024 * 1024;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bytes of the event as the trace carries it. */
function traceEventBytes(event: TurnDiffEvent): number {
  return Buffer.byteLength(JSON.stringify({ at: new Date().toISOString(), type: "turn.diff", data: event }));
}

/** A text of short lines, all numbered from `prefix`, just under 4 MiB (the collector's per-file cap). */
function shortLines(prefix: string): string {
  const lines: string[] = [];
  for (let bytes = 0; bytes < 4 * 1024 * 1024 - 16;) {
    const line = `${prefix}${lines.length}`;
    lines.push(line);
    bytes += line.length + 1;
  }
  return `${lines.join("\n")}\n`;
}

function turnDiffEvents(uploads: Envelope[]): TurnDiffEvent[] {
  return uploads.filter((item) => item.snapshot_type === "trace").flatMap((item) => item.trace ?? []).filter((event) => event.type === "turn.diff").map((event) => event.data as TurnDiffEvent);
}

/**
 * A collector over `root` that records every envelope it uploads; `hold`
 * sees each one first and may keep the upload (and the session's queue
 * behind it) waiting.
 */
function recordingCollector(options: { stateDir?: string; snapshotMaxBytes?: number; hold?: (envelope: Envelope) => Promise<void> } = {}): { collector: WorkspaceCollector; uploads: Envelope[] } {
  const { hold, ...rest } = options;
  const uploads: Envelope[] = [];
  const collector = new WorkspaceCollector({
    upload: async (_sessionId, compressed) => {
      const envelope = JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope;
      uploads.push(envelope);
      await hold?.(envelope);
      return Response.json({ ok: true }, { status: 201 });
    },
    changeDebounceMs: 60_000,
    fallbackScanMs: 60_000,
    ...rest,
  });
  return { collector, uploads };
}

/** Runs one turn (prompt, `edit`, turn end) on a collector over `root` and returns the turn's "turn.diff" event. */
async function turnDiff(root: string, edit: (collector: WorkspaceCollector, sessionId: string) => Promise<void>, options: { stateDir?: string; snapshotMaxBytes?: number } = {}): Promise<TurnDiffEvent> {
  const { collector, uploads } = recordingCollector(options);
  const sessionId = `session-turn-diff-${Math.random().toString(36).slice(2, 10)}`;
  collector.startSession(sessionId, "workspace-turn-diff", root);
  collector.captureSnapshot(sessionId, "prompt");
  await collector.idle(sessionId);
  await edit(collector, sessionId);
  collector.captureSnapshot(sessionId, "turn_completed");
  collector.flushTrace(sessionId, { messages: [] });
  await collector.idle(sessionId);
  await collector.stop();
  const events = turnDiffEvents(uploads);
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** A small seeded generator, so a failing case can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Applies a diff unifiedDiff wrote to `before`, checking every context and removed line against it. */
function applyPatch(before: string, diff: string): string {
  const source = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const lines = diff.split("\n");
  lines.pop();
  const out: string[] = [];
  let at = 0;
  for (let index = 2; index < lines.length;) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(lines[index]!);
    expect(header).not.toBeNull();
    const start = Number(header![1]);
    const from = header![2] === "0" ? start : start - 1;
    while (at < from) out.push(source[at++]!);
    for (index += 1; index < lines.length && !lines[index]!.startsWith("@@");) {
      const line = lines[index]!;
      const noNewline = lines[index + 1] === "\\ No newline at end of file";
      const text = noNewline ? line.slice(1) : `${line.slice(1)}\n`;
      if (line[0] === "+") out.push(text);
      else {
        expect(source[at]).toBe(text);
        if (line[0] === " ") out.push(text);
        at += 1;
      }
      index += noNewline ? 2 : 1;
    }
  }
  while (at < source.length) out.push(source[at++]!);
  return out.join("");
}

/** A random text over a few distinct lines, so any two share many of them. */
function randomText(next: () => number, lines: number): string {
  const vocabulary = ["", "}", "  return value;", "const a = 1;", "// note", "x", "y y", "\ttabbed"];
  const text = Array.from({ length: lines }, () => vocabulary[Math.floor(next() * vocabulary.length)]!).join("\n");
  return lines > 0 && next() < 0.8 ? `${text}\n` : text;
}

/** `text` with a few random runs of lines removed, replaced or inserted. */
function randomEdit(next: () => number, text: string): string {
  const lines = text.split("\n");
  for (let edits = Math.floor(next() * 6); edits > 0; edits -= 1) {
    const at = Math.floor(next() * (lines.length + 1));
    const removed = Math.floor(next() * 4);
    const inserted = Array.from({ length: Math.floor(next() * 4) }, () => `edit ${Math.floor(next() * 5)}`);
    lines.splice(at, removed, ...inserted);
  }
  return lines.join("\n");
}

describe("unified diff", () => {
  test("writes hunks with context, counts and the missing-newline marker", () => {
    const before = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n") + "\n";
    const after = ["one", "two", "THREE", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"].join("\n");
    const result = unifiedDiff("notes.txt", before, after);
    expect(result).toMatchObject({ additions: 2, deletions: 1, truncated: false });
    expect(result.diff).toBe([
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,6 +1,6 @@",
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
      " five",
      " six",
      "@@ -8,3 +8,4 @@",
      " eight",
      " nine",
      " ten",
      "+eleven",
      "\\ No newline at end of file",
      "",
    ].join("\n"));
    expect(unifiedDiff("new.txt", null, "a\nb\n").diff).toBe("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(unifiedDiff("old.txt", "a\n", null).diff).toBe("--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n");
  });

  test("finds the minimal edit inside a long file and stays close to it past the exact bound", () => {
    const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index}`);
    const edited = lines.map((line, index) => (index % 1_000 === 500 ? `${line} edited` : line));
    const small = unifiedDiff("long.txt", `${lines.join("\n")}\n`, `${edited.join("\n")}\n`);
    expect(small).toMatchObject({ additions: 5, deletions: 5, truncated: false });
    const rewritten = lines.map((line, index) => (index % 2 === 0 ? `${line} edited` : line));
    const large = unifiedDiff("long.txt", `${lines.join("\n")}\n`, `${rewritten.join("\n")}\n`);
    // 2,500 edits are past the exact search; the greedy pass still pairs each edited line with its original.
    expect(large).toMatchObject({ additions: 2_500, deletions: 2_500 });
    expect(large.diff).toContain("-line 0\n+line 0 edited\n line 1\n-line 2\n+line 2 edited\n");
  });

  test("writes a patch that turns the old text into the new one exactly, within any comparison budget", () => {
    const next = random(20_260_923);
    for (let round = 0; round < 600; round += 1) {
      const before = randomText(next, Math.floor(next() * 60));
      const after = next() < 0.1 ? randomText(next, Math.floor(next() * 60)) : randomEdit(next, before);
      // The default budget (exact or greedy matching) and budgets that cut the matching short at every depth.
      const budget = round % 3 === 0 ? undefined : Math.floor(next() * 200);
      const result = unifiedDiff("fuzz.txt", before, after, Number.POSITIVE_INFINITY, budget);
      expect(result.truncated).toBe(false);
      expect(applyPatch(before, result.diff)).toBe(after);
      const changed = result.diff.split("\n").slice(2);
      expect(result.additions).toBe(changed.filter((line) => line.startsWith("+")).length);
      expect(result.deletions).toBe(changed.filter((line) => line.startsWith("-")).length);
      if (before === after) expect(result.diff).toBe("");
    }
  });

  test("bounds the work on a file rewritten line by line", () => {
    const before = shortLines("old ");
    const after = shortLines("new ");
    const lines = before.split("\n").length - 1;
    unifiedDiff("warm.txt", "a\nb\n", "a\nc\n");
    const started = performance.now();
    const result = unifiedDiff("rewritten.txt", before, after);
    // Unbounded, the greedy search alone took over a second here.
    expect(performance.now() - started).toBeLessThan(100);
    expect(result).toMatchObject({ additions: lines, deletions: lines, truncated: true });
    expect(result.diff.startsWith(`--- a/rewritten.txt\n+++ b/rewritten.txt\n@@ -1,${lines} +1,${lines} @@\n-old 0\n-old 1\n`)).toBe(true);
    // Past the budget the rest is still a correct patch, only a longer one.
    const small = unifiedDiff("small.txt", "a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n", Number.POSITIVE_INFINITY, 2);
    expect(applyPatch("a\nb\nc\nd\ne\n", small.diff)).toBe("a\nB\nc\nD\ne\n");
    expect(small.additions).toBeGreaterThanOrEqual(2);
  });
});

describe("turn.diff events", () => {
  test("pairs a turn with its added, modified and deleted files", async () => {
    const root = await tempDir("omnirush-turn-diff-");
    await writeFile(join(root, "keep.txt"), "unchanged\n");
    await writeFile(join(root, "app.ts"), "export const answer = 41;\nexport const name = \"omnirush\";\n");
    await writeFile(join(root, "old.md"), "retired\n");
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "app.ts"), "export const answer = 42;\nexport const name = \"omnirush\";\n");
      await writeFile(join(root, "new.md"), "fresh\nnotes\n");
      await unlink(join(root, "old.md"));
    });
    expect(event).toMatchObject({ schema_version: 1, file_count: 3, omitted_file_count: 0, truncated: false });
    expect(event.files).toEqual([
      {
        path: "app.ts",
        status: "modified",
        before_sha256: sha256("export const answer = 41;\nexport const name = \"omnirush\";\n"),
        after_sha256: sha256("export const answer = 42;\nexport const name = \"omnirush\";\n"),
        additions: 1,
        deletions: 1,
        diff: "--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,2 @@\n-export const answer = 41;\n+export const answer = 42;\n export const name = \"omnirush\";\n",
        truncated: false,
      },
      {
        path: "new.md",
        status: "added",
        before_sha256: null,
        after_sha256: sha256("fresh\nnotes\n"),
        additions: 2,
        deletions: 0,
        diff: "--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+fresh\n+notes\n",
        truncated: false,
      },
      {
        path: "old.md",
        status: "deleted",
        before_sha256: sha256("retired\n"),
        after_sha256: null,
        additions: 0,
        deletions: 1,
        diff: "--- a/old.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-retired\n",
        truncated: false,
      },
    ]);
  });

  test("leaves out binary and oversized files the turn only read", async () => {
    const root = await tempDir("omnirush-turn-diff-read-");
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff]));
    await writeFile(join(root, "dump.log"), "x".repeat(5 * 1024 * 1024));
    const event = await turnDiff(root, async (collector, sessionId) => {
      // Traced reads journal the paths as edits do.
      collector.recordTrace(sessionId, "tool.read", { path: join(root, "logo.png") });
      collector.recordTrace(sessionId, "tool.read", { file_path: join(root, "dump.log") });
      await collector.idle(sessionId);
    });
    expect(event).toEqual({ schema_version: 1, files: [], file_count: 0, omitted_file_count: 0, truncated: false });
  });

  test("marks a binary file the turn wrote as skipped, without content", async () => {
    const root = await tempDir("omnirush-turn-diff-binary-");
    await writeFile(join(root, "readme.txt"), "hello\n");
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff]));
    });
    expect(event.files).toEqual([
      { path: "chart.png", status: "skipped", before_sha256: null, after_sha256: null, additions: null, deletions: null, diff: null, truncated: false },
    ]);
  });

  test("keeps a redacted secret redacted on both sides of the diff", async () => {
    const root = await tempDir("omnirush-turn-diff-secret-");
    await writeFile(join(root, "config.txt"), "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\nmode=dev\n");
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "config.txt"), "OPENAI_API_KEY=sk-abcdefghijklmnop1234567890\nmode=prod\n");
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(serialized).not.toContain("sk-abcdefghijklmnop1234567890");
    const [file] = event.files;
    expect(file).toMatchObject({ path: "config.txt", status: "modified", additions: 1, deletions: 1 });
    // The key changed but both sides scrub to the same line: only the real edit shows.
    expect(file!.diff).toContain(" OPENAI_API_KEY=[REDACTED]\n-mode=dev\n+mode=prod\n");
  });

  test("marks a changed or deleted file whose base is not held as no_base, and a new one as added", async () => {
    const root = await tempDir("omnirush-turn-diff-no-base-");
    await writeFile(join(root, "big.txt"), "before\n");
    await writeFile(join(root, "gone.txt"), "gone\n");
    // A snapshot with no room for content sends no text, so nothing is stored as a base.
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "big.txt"), "after\n");
      await writeFile(join(root, "added.txt"), "brand new\n");
      await unlink(join(root, "gone.txt"));
    }, { snapshotMaxBytes: NO_CONTENT });
    expect(event.files).toEqual([
      { path: "added.txt", status: "added", before_sha256: null, after_sha256: sha256("brand new\n"), additions: 1, deletions: 0, diff: "--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+brand new\n", truncated: false },
      { path: "big.txt", status: "no_base", before_sha256: sha256("before\n"), after_sha256: sha256("after\n"), additions: null, deletions: null, diff: null, truncated: false },
      { path: "gone.txt", status: "no_base", before_sha256: sha256("gone\n"), after_sha256: null, additions: null, deletions: null, diff: null, truncated: false },
    ]);
  });

  test("marks a file the turn wrote before the collector first read it as no_base", async () => {
    const root = await tempDir("omnirush-turn-diff-unseen-");
    await writeFile(join(root, "early.txt"), "written by the turn\n");
    await writeFile(join(root, "steady.txt"), "untouched\n");
    // As if the agent wrote it right after the prompt, before the start snapshot's scan reached it.
    const later = new Date(Date.now() + 300);
    await utimes(join(root, "early.txt"), later, later);
    const event = await turnDiff(root, async () => undefined);
    expect(event.files).toEqual([
      { path: "early.txt", status: "no_base", before_sha256: null, after_sha256: sha256("written by the turn\n"), additions: null, deletions: null, diff: null, truncated: false },
    ]);
  });

  test("keeps an edit made while the start snapshot was still uploading in the turn", async () => {
    const root = await tempDir("omnirush-turn-diff-queued-");
    await writeFile(join(root, "app.txt"), "before\n");
    let startUploading!: () => void;
    const uploading = new Promise<void>((resolve) => { startUploading = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const { collector, uploads } = recordingCollector({
      hold: async (envelope) => {
        if (envelope.snapshot_type !== "start") return;
        startUploading();
        await released;
      },
    });
    const sessionId = "session-turn-diff-queued";
    collector.startSession(sessionId, "workspace-turn-diff", root);
    await uploading;
    // The prompt goes out while the start snapshot is in flight; its own snapshot waits behind it.
    collector.captureSnapshot(sessionId, "prompt");
    await delay(5);
    await writeFile(join(root, "app.txt"), "after\n");
    release();
    await collector.idle(sessionId);
    collector.captureSnapshot(sessionId, "turn_completed");
    collector.flushTrace(sessionId, { messages: [] });
    await collector.idle(sessionId);
    await collector.stop();
    expect(turnDiffEvents(uploads)).toEqual([{
      schema_version: 1,
      files: [{
        path: "app.txt",
        status: "modified",
        before_sha256: sha256("before\n"),
        after_sha256: sha256("after\n"),
        additions: 1,
        deletions: 1,
        diff: "--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-before\n+after\n",
        truncated: false,
      }],
      file_count: 1,
      omitted_file_count: 0,
      truncated: false,
    }]);
  });

  test("leaves what the next turn wrote to it when a turn's snapshot ran late", async () => {
    const root = await tempDir("omnirush-turn-diff-late-");
    await writeFile(join(root, "first.txt"), "one\n");
    await writeFile(join(root, "second.txt"), "two\n");
    let traceUploading!: () => void;
    const uploading = new Promise<void>((resolve) => { traceUploading = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const { collector, uploads } = recordingCollector({
      hold: async (envelope) => {
        if (envelope.snapshot_type !== "trace" || held) return;
        held = true;
        traceUploading();
        await released;
      },
    });
    const sessionId = "session-turn-diff-late";
    collector.startSession(sessionId, "workspace-turn-diff", root);
    collector.captureSnapshot(sessionId, "prompt");
    await collector.idle(sessionId);
    await delay(5);
    await writeFile(join(root, "first.txt"), "one edited\n");
    // A trace upload holds the queue: the first turn's snapshot waits behind it...
    collector.flushTrace(sessionId);
    await uploading;
    collector.captureSnapshot(sessionId, "turn_completed");
    // ...while the next prompt goes out and its turn writes.
    await delay(5);
    collector.captureSnapshot(sessionId, "prompt");
    await delay(5);
    await writeFile(join(root, "second.txt"), "two edited\n");
    await writeFile(join(root, "third.txt"), "three\n");
    release();
    await collector.idle(sessionId);
    collector.captureSnapshot(sessionId, "turn_completed");
    collector.flushTrace(sessionId, { messages: [] });
    await collector.idle(sessionId);
    await collector.stop();
    const events = turnDiffEvents(uploads);
    expect(events.map((event) => event.files.map((file) => [file.path, file.status]))).toEqual([
      [["first.txt", "modified"]],
      [["second.txt", "modified"], ["third.txt", "added"]],
    ]);
    expect(events[1]!.files[0]!.diff).toBe("--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-two\n+two edited\n");
  });

  test("keeps bases in the state dir across a restart", async () => {
    const root = await tempDir("omnirush-turn-diff-restart-");
    const stateDir = await tempDir("omnirush-turn-diff-state-");
    await writeFile(join(root, "app.txt"), "first\n");
    await turnDiff(root, async () => undefined, { stateDir });
    expect((await readdir(join(stateDir, "omnirush-collector-bases"))).sort()).toEqual([sha256("first\n"), "index.json"].sort());
    // The next process sends no content at all: the base can only come from disk.
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "app.txt"), "second\n");
    }, { stateDir, snapshotMaxBytes: NO_CONTENT });
    expect(event.files).toMatchObject([{ path: "app.txt", status: "modified", diff: "--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-first\n+second\n" }]);

    // A sign-out deletes the bases with the spool.
    const signedOut = new WorkspaceCollector({ upload: async () => Response.json({ ok: true }, { status: 201 }), stateDir });
    await signedOut.clearSpool();
    await signedOut.stop();
    expect(await readdir(stateDir)).not.toContain("omnirush-collector-bases");
  });

  test("cuts a file diff at 256 KiB and the event at its cap, marked truncated", async () => {
    const root = await tempDir("omnirush-turn-diff-cap-");
    await writeFile(join(root, "huge.txt"), "");
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "huge.txt"), Array.from({ length: 40_000 }, (_, index) => `generated line ${index}`).join("\n"));
    });
    const [file] = event.files;
    expect(file).toMatchObject({ path: "huge.txt", status: "modified", additions: 40_000, deletions: 0, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(file!.diff))).toBeLessThanOrEqual(MAX_TURN_DIFF_FILE_BYTES + 2);
    expect(file!.diff!.endsWith("\n")).toBe(true);
    expect(event.truncated).toBe(true);

    const builder = new TurnDiffBuilder(4 * 1024, 1024);
    for (let index = 0; index < 10; index += 1) {
      builder.add({ path: `f${index}.txt`, status: "added", before_sha256: null, after_sha256: null, before: null, after: "line\n".repeat(1_000) });
    }
    // No diff fits any more, but entries without one still do.
    expect(builder.full).toBe(true);
    builder.add({ path: "logo.png", status: "skipped", before_sha256: null, after_sha256: null, before: null, after: null });
    builder.add({ path: "evicted.txt", status: "no_base", before_sha256: sha256("a"), after_sha256: sha256("b"), before: null, after: null });
    const capped = builder.finish();
    expect(capped).toMatchObject({ file_count: 12, omitted_file_count: 7 });
    expect(capped.files.map((entry) => entry.path)).toEqual(["f0.txt", "f1.txt", "f2.txt", "logo.png", "evicted.txt"]);
    expect(capped.files.slice(0, 3).every((entry) => entry.truncated)).toBe(true);
    expect(traceEventBytes(capped)).toBeLessThanOrEqual(4 * 1024);
    expect(capped.truncated).toBe(true);
  });

  test("keeps the whole event within its cap, counts and envelope included", () => {
    const next = random(1_024);
    for (let round = 0; round < 200; round += 1) {
      const cap = 512 + Math.floor(next() * 8 * 1024);
      const builder = new TurnDiffBuilder(cap, 256 + Math.floor(next() * 4 * 1024));
      for (let index = 0; index < 12; index += 1) {
        const lines = Math.floor(next() * 3_000);
        const pick = next();
        const input: TurnDiffInput = pick < 0.7
          ? { path: `src/${index}.txt`, status: "added", before_sha256: null, after_sha256: sha256(`${index}`), before: null, after: "1\n".repeat(lines) }
          : { path: `bin/${index}.dat`, status: pick < 0.85 ? "skipped" : "no_base", before_sha256: null, after_sha256: null, before: null, after: null };
        builder.add(input);
      }
      const event = builder.finish();
      expect(event.file_count).toBe(12);
      expect(traceEventBytes(event)).toBeLessThanOrEqual(cap);
    }
  });

  test("spends at most the turn's diff time, then only counts the files still waiting", () => {
    const before = shortLines("old ");
    const after = shortLines("new ");
    const digests = { before_sha256: sha256(before), after_sha256: sha256(after) };
    const changed = (index: number): TurnDiffInput => ({ path: `f${index}.txt`, status: "modified", ...digests, before, after });
    // Out of time after the first diff: the rest need one and are only counted; entries without one still go in.
    const hurried = new TurnDiffBuilder(MAX_TURN_DIFF_EVENT_BYTES, MAX_TURN_DIFF_FILE_BYTES, 1);
    hurried.add(changed(0));
    expect(hurried.full).toBe(true);
    hurried.add(changed(1));
    hurried.add({ path: "logo.png", status: "skipped", before_sha256: null, after_sha256: null, before: null, after: null });
    hurried.add(changed(2));
    const event = hurried.finish();
    expect(event).toMatchObject({ file_count: 4, omitted_file_count: 2, truncated: true });
    expect(event.files.map((entry) => [entry.path, entry.diff === null])).toEqual([["f0.txt", false], ["logo.png", true]]);

    // Ten rewritten 4 MiB files: unbounded, this took seconds.
    const builder = new TurnDiffBuilder();
    const started = performance.now();
    for (let index = 0; index < 10; index += 1) builder.add(changed(index));
    expect(performance.now() - started).toBeLessThan(4 * MAX_TURN_DIFF_MS);
    const ten = builder.finish();
    expect(ten.file_count).toBe(10);
    expect(ten.omitted_file_count).toBeGreaterThan(0);
    expect(traceEventBytes(ten)).toBeLessThanOrEqual(MAX_TURN_DIFF_EVENT_BYTES);
  });
});

describe("turn base store", () => {
  test("keeps a text evicted and stored again readable", async () => {
    const dir = join(await tempDir("omnirush-turn-bases-"), "bases");
    const store = new TurnBaseStore(dir, 10);
    for (let round = 0; round < 20; round += 1) {
      store.put(sha256("alpha\n"), "alpha\n", 6);
      await store.flush();
      // Storing the other evicts this one; storing this one again must survive that eviction's removal.
      store.put(sha256("bravo\n"), "bravo\n", 6);
      await store.flush();
      store.put(sha256("alpha\n"), "alpha\n", 6);
      await store.flush();
      expect(await store.get(sha256("alpha\n"))).toBe("alpha\n");
      expect(await store.get(sha256("bravo\n"))).toBeNull();
    }
  });

  test("a sign-out racing a text being written leaves no directory behind", async () => {
    const parent = await tempDir("omnirush-turn-bases-clear-");
    for (let turns = 0; turns < 12; turns += 1) {
      const dir = join(parent, `bases-${turns}`);
      const store = new TurnBaseStore(dir);
      store.put(sha256("secret\n"), "secret\n", 7);
      // Sign out at a different point of the write each time.
      for (let spin = 0; spin < turns; spin += 1) await new Promise((resolve) => setImmediate(resolve));
      await store.clear();
      await store.flush();
      await delay(5);
      expect(await stat(dir).then(() => true, () => false)).toBe(false);
    }
  });
});
