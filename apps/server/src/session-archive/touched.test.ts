import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

import { ArchiveHashCache, type ArchiveEntry } from "./manifest.js";
import { cleanupTempDirs, tempDir } from "./test-helpers.js";
import { scanTouchedFiles, touchedChange, TouchedPathStore, touchedPathParts } from "./touched.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Paths the scan looked at, and whether every one of them lies in `root`. */
function accessLog(root: string) {
  const paths: string[] = [];
  return { paths, onAccess: (path: string) => paths.push(path), outside: () => paths.filter((path) => path !== root && !path.startsWith(`${root}${sep}`)) };
}

describe("scanTouchedFiles", () => {
  test("only touched regular files inside the root, hashed from the file itself; nothing outside is looked at", async () => {
    const outside = await tempDir("touched-outside");
    await writeFile(join(outside, "secret.txt"), "OUTSIDE");
    await mkdir(join(outside, "dir"));
    await writeFile(join(outside, "dir/inner.txt"), "OUTSIDE INNER");
    const root = await tempDir("touched-root");
    const render = randomBytes(64 * 1024);
    const brief = randomBytes(48 * 1024);
    await writeFile(join(root, "render.png"), render);
    await writeFile(join(root, "brief.pdf"), brief);
    await writeFile(join(root, "untouched.txt"), "never touched");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub/a.txt"), "inside a touched folder");
    await writeFile(join(root, ".env"), "TOKEN=abc");
    await mkdir(join(root, "__omnirush__"));
    await writeFile(join(root, "__omnirush__/x"), "reserved");
    await mkdir(join(root, ".omnirush-state"));
    await writeFile(join(root, ".omnirush-state/ledger.json"), "{}");
    await mkdir(join(root, "real"));
    const data = Buffer.from("a,b\n1,2\n");
    await writeFile(join(root, "real/data.csv"), data);
    await symlink("real/data.csv", join(root, "alias.csv"));
    await symlink(join(outside, "secret.txt"), join(root, "link-out"));
    await symlink("../touched-outside-escape/x", join(root, "link-up"));
    await symlink(join(outside, "dir"), join(root, "linked-dir"));
    await execFileAsync("mkfifo", [join(root, "pipe")]);
    const access = accessLog(root);

    const scan = await scanTouchedFiles(root, [
      "render.png", "brief.pdf", "sub", ".env", "__omnirush__/x", ".omnirush-state/ledger.json", "alias.csv", "link-out", "link-up",
      "linked-dir/inner.txt", "missing.txt", "pipe", "../touched-outside/secret.txt", `${outside}/secret.txt`, "sub/./a.txt", "",
    ], { excludedDirs: [join(root, ".omnirush-state")], onAccess: access.onAccess });

    expect(scan.entries.map((entry) => [entry.path, entry.type, entry.size, entry.sha256])).toEqual([
      ["brief.pdf", "file", brief.length, sha256(brief)],
      ["real/data.csv", "file", data.length, sha256(data)],
      ["render.png", "file", render.length, sha256(render)],
    ]);
    expect([...scan.gone].sort()).toEqual(["alias.csv", "link-out", "link-up", "linked-dir/inner.txt", "missing.txt", "pipe", "sub"]);
    expect(scan.excluded).toEqual({ credential: 1, special: 3, app_state: 1, reserved: 1, unreadable: 0, non_utf8: 0 });
    expect(access.paths.length).toBeGreaterThan(0);
    expect(access.outside()).toEqual([]);
    // A touched folder is never expanded.
    expect(access.paths).not.toContain(join(root, "sub/a.txt"));
  });

  test("credentials are kept only with archiveIncludeCredentialFiles; the hash cache is used and never pruned", async () => {
    const root = await tempDir("touched-cache");
    await writeFile(join(root, ".env"), "TOKEN=abc");
    await writeFile(join(root, "a.bin"), randomBytes(1024));
    const cache = ArchiveHashCache.fromText(null);
    const first = await scanTouchedFiles(root, ["a.bin", ".env"], { includeCredentialFiles: true, hashCache: cache });
    expect(first.entries.map((entry) => entry.path)).toEqual([".env", "a.bin"]);
    const text = [...cache.jsonChunks()].join("");
    // A later scan of one path keeps the other's row, and takes a.bin from the cache.
    const reloaded = ArchiveHashCache.fromText(text);
    const second = await scanTouchedFiles(root, ["a.bin"], { hashCache: reloaded });
    expect(second.entries[0]!.sha256).toBe(first.entries[1]!.sha256);
    expect([...reloaded.jsonChunks()].join("")).toContain('".env"');
  });

  test("touched paths must be plain relative paths", () => {
    expect(touchedPathParts("docs/brief.pdf")).toEqual(["docs", "brief.pdf"]);
    for (const path of ["", "/etc/hosts", "../x", "a/../b", "a//b", "./a", "a/.", "a\0b"]) expect([path, touchedPathParts(path)]).toEqual([path, null]);
  });
});

describe("touchedChange", () => {
  test("a delta carries added and modified files, deletes only what is gone, and keeps what it could not read", () => {
    const entry = (path: string, sha: string): ArchiveEntry => ({ path, type: "file", mode: 0o644, size: 1, sha256: sha.repeat(64) });
    const scanned = (path: string, sha: string) => ({ ...entry(path, sha), mtime: 0, statKey: "1:0:0:1", dev: 1 });
    const baseline = [entry("doc.pdf", "a"), entry("gone.txt", "b"), entry("locked.bin", "c"), entry("same.png", "d")];
    const change = touchedChange(baseline, {
      entries: [scanned("doc.pdf", "e"), scanned("new.txt", "f"), scanned("same.png", "d")],
      gone: new Set(["gone.txt", "never-archived.txt"]),
      excluded: { credential: 0, special: 0, app_state: 0, reserved: 0, unreadable: 1, non_utf8: 0 },
    });
    expect(change.files.map((file) => file.path)).toEqual(["doc.pdf", "new.txt"]);
    expect(change.deleted).toEqual(["gone.txt"]);
    expect(change.next.map((file) => [file.path, file.sha256?.[0]])).toEqual([["doc.pdf", "e"], ["locked.bin", "c"], ["new.txt", "f"], ["same.png", "d"]]);
  });
});

describe("TouchedPathStore", () => {
  function store(dir: string, mode: "tracked" | "ignored" | "unknown" = "unknown") {
    const logs: string[] = [];
    return {
      logs,
      store: new TouchedPathStore(dir, { ready: async () => undefined, modeOf: async () => mode, log: (_level, message) => logs.push(message), flushMs: 60_000 }),
    };
  }

  test("paths wait in memory until the session is tracked, reach a file that a new store reads back, and go with forget", async () => {
    const dir = await tempDir("touched-store");
    const { store: first } = store(dir);
    first.note("ses_touched_01", "brief.pdf");
    first.note("ses_touched_01", "brief.pdf");
    first.note("ses_touched_01", "../outside.txt");
    await first.flush();
    expect(await readdir(dir)).toEqual([]);
    first.track("ses_touched_01");
    first.note("ses_touched_01", "out/render.png");
    await first.flush();
    const [file] = await readdir(dir);
    expect(file).toMatch(/\.jsonl$/);
    expect((await readFile(join(dir, file!), "utf8")).split("\n")).toEqual(['{"v":1,"session_id":"ses_touched_01"}', '"brief.pdf"', '"out/render.png"', ""]);

    // A torn last line (a crash while appending) is skipped.
    await appendFile(join(dir, file!), '"half');
    const { store: second } = store(dir, "tracked");
    expect([...(await second.snapshot("ses_touched_01"))].sort()).toEqual(["brief.pdf", "out/render.png"]);
    second.note("ses_touched_01", "brief.pdf");
    second.note("ses_touched_01", "notes.md");
    expect([...(await second.snapshot("ses_touched_01"))].sort()).toEqual(["brief.pdf", "notes.md", "out/render.png"]);
    expect(await second.has("ses_touched_01")).toBe(true);
    // The path written after the torn line is on a line of its own.
    const { store: third } = store(dir, "tracked");
    expect([...(await third.snapshot("ses_touched_01"))].sort()).toEqual(["brief.pdf", "notes.md", "out/render.png"]);

    await second.forget("ses_touched_01");
    expect(await readdir(dir)).toEqual([]);
    second.note("ses_touched_01", "later.txt");
    await second.flush();
    expect(await readdir(dir)).toEqual([]);
  });

  test("a session the record says is something else keeps nothing; clear() drops what is in memory", async () => {
    const dir = await tempDir("touched-ignored");
    const { store: ignored } = store(dir, "ignored");
    ignored.note("ses_git_000001", "src/app.ts");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    ignored.note("ses_git_000001", "src/other.ts");
    await ignored.flush();
    expect(await ignored.has("ses_git_000001")).toBe(false);
    const { store: cleared } = store(dir);
    cleared.note("ses_touched_02", "a.txt");
    cleared.clear();
    cleared.track("ses_touched_02");
    await cleared.flush();
    expect(await readdir(dir)).toEqual([]);
  });
});
