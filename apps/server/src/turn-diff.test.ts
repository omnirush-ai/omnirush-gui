import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { MAX_TURN_DIFF_FILE_BYTES, TurnDiffBuilder, unifiedDiff, type TurnDiffEvent } from "./turn-diff.js";
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

/** Runs one turn (prompt, `edit`, turn end) on a collector over `root` and returns the turn's "turn.diff" event. */
async function turnDiff(root: string, edit: () => Promise<void>, options: { stateDir?: string; snapshotMaxBytes?: number } = {}): Promise<TurnDiffEvent> {
  const uploads: Envelope[] = [];
  const collector = new WorkspaceCollector({
    upload: async (_sessionId, compressed) => {
      uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope);
      return Response.json({ ok: true }, { status: 201 });
    },
    changeDebounceMs: 60_000,
    fallbackScanMs: 60_000,
    ...options,
  });
  const sessionId = `session-turn-diff-${Math.random().toString(36).slice(2, 10)}`;
  collector.startSession(sessionId, "workspace-turn-diff", root);
  collector.captureSnapshot(sessionId, "prompt");
  await collector.idle(sessionId);
  await edit();
  collector.captureSnapshot(sessionId, "turn_completed");
  collector.flushTrace(sessionId, { messages: [] });
  await collector.idle(sessionId);
  await collector.stop();
  const events = uploads.filter((item) => item.snapshot_type === "trace").flatMap((item) => item.trace ?? []).filter((event) => event.type === "turn.diff");
  expect(events).toHaveLength(1);
  return events[0]!.data as TurnDiffEvent;
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

  test("marks a file whose base is no longer held as no_base and an unseen one as added", async () => {
    const root = await tempDir("omnirush-turn-diff-no-base-");
    await writeFile(join(root, "big.txt"), "before\n");
    // A snapshot with no room for content sends no text, so nothing is stored as a base.
    const event = await turnDiff(root, async () => {
      await writeFile(join(root, "big.txt"), "after\n");
      await writeFile(join(root, "added.txt"), "brand new\n");
    }, { snapshotMaxBytes: NO_CONTENT });
    expect(event.files).toEqual([
      { path: "added.txt", status: "added", before_sha256: null, after_sha256: sha256("brand new\n"), additions: 1, deletions: 0, diff: "--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+brand new\n", truncated: false },
      { path: "big.txt", status: "no_base", before_sha256: sha256("before\n"), after_sha256: sha256("after\n"), additions: null, deletions: null, diff: null, truncated: false },
    ]);
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
    const capped = builder.finish();
    expect(capped).toMatchObject({ file_count: 10, omitted_file_count: 7 });
    expect(capped.files).toHaveLength(3);
    expect(capped.files.every((entry) => entry.truncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(capped.files))).toBeLessThanOrEqual(4 * 1024);
    expect(capped.truncated).toBe(true);
  });
});
