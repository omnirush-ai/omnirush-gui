import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  ArchiveHashCache,
  archiveEntry,
  buildManifestBytes,
  compareArchivePaths,
  computeArchiveDelta,
  emptyScanMetrics,
  isArchiveCredentialPath,
  readArchiveGit,
  scanArchiveTree,
  type ScannedEntry,
} from "./manifest.js";
import { cleanupTempDirs, tempDir } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
  return stdout.trim();
}

const paths = (entries: readonly { path: string }[]) => entries.map((entry) => entry.path);

describe("path order", () => {
  test("compareArchivePaths is UTF-8 byte order", () => {
    const alphabet = ["a", "b", "-", ".", "/", "é", "\u{ff21}", "\u{e000}", "\u{1f600}", "\u{10348}", "z", "0"];
    const strings = Array.from({ length: 400 }, (_, index) => {
      let text = "";
      for (let char = 0; char < 1 + (index % 5); char += 1) text += alphabet[(index * 7 + char * 13) % alphabet.length];
      return text;
    });
    const expected = [...strings].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    expect([...strings].sort(compareArchivePaths)).toEqual(expected);
    expect(compareArchivePaths("a", "a/b")).toBeLessThan(0);
    expect(compareArchivePaths("\u{ff21}", "\u{1f600}")).toBeLessThan(0);
  });
});

describe("credential filter", () => {
  test("git internals are exempt and node_modules is not a denial", () => {
    expect(isArchiveCredentialPath(".env")).toBe(true);
    expect(isArchiveCredentialPath("config/.env.production")).toBe(true);
    expect(isArchiveCredentialPath("id_rsa")).toBe(true);
    expect(isArchiveCredentialPath("certs/server.pem")).toBe(true);
    expect(isArchiveCredentialPath(".ssh/config")).toBe(true);
    expect(isArchiveCredentialPath(".git/refs/heads/token-fix")).toBe(false);
    expect(isArchiveCredentialPath(".git/config")).toBe(false);
    expect(isArchiveCredentialPath("node_modules/pkg/index.js")).toBe(false);
    expect(isArchiveCredentialPath("src/app.ts")).toBe(false);
    expect(isArchiveCredentialPath("dist/bundle.js")).toBe(false);
  });
});

describe("scan", () => {
  test("the whole folder: .git, ignored and build content present; exclusions counted", async () => {
    const root = await tempDir("scan");
    const state = join(root, ".omnirush-state");
    await mkdir(join(root, ".git/refs/heads"), { recursive: true });
    await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git/refs/heads/token-fix"), "0".repeat(40));
    await mkdir(join(root, "node_modules/js-tokens"), { recursive: true });
    await writeFile(join(root, "node_modules/js-tokens/index.js"), "module.exports = 1;\n");
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await symlink("/usr/bin/python3", join(root, ".venv/bin/python"));
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/out.js"), "built\n");
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build/app.o"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\nbuild/\n.venv/\n");
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await writeFile(join(root, "id_rsa"), "key\n");
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh/config"), "Host x\n");
    await mkdir(join(root, "__omnirush__"));
    await mkdir(join(state, "omnirush-archive"), { recursive: true });
    await writeFile(join(state, "omnirush-archive/state.json"), "{}");
    await execFileAsync("mkfifo", [join(root, "pipe")]);
    await mkdir(join(root, "locked/inner"), { recursive: true });
    await writeFile(join(root, "locked/inner/file.txt"), "x");
    await chmod(join(root, "locked"), 0o000);
    try {
      const { entries, excluded } = await scanArchiveTree(root, { excludedDirs: [state] });
      const listed = paths(entries);
      for (const present of [".git", ".git/HEAD", ".git/refs/heads/token-fix", "node_modules/js-tokens/index.js", ".venv/bin/python", "dist/out.js", "build/app.o", ".gitignore", ".ssh", "locked"]) {
        expect(listed).toContain(present);
      }
      for (const absent of [".env", "id_rsa", ".ssh/config", "__omnirush__", ".omnirush-state", "pipe", "locked/inner"]) {
        expect(listed).not.toContain(absent);
      }
      const running = typeof process.getuid === "function" ? process.getuid() : -1;
      expect(excluded).toEqual({ credential: 3, special: 1, app_state: 1, reserved: 1, unreadable: running === 0 ? 0 : 1, non_utf8: 0 });
      expect(listed).toEqual([...listed].sort(compareArchivePaths));
      const link = entries.find((entry) => entry.path === ".venv/bin/python")!;
      expect(link).toMatchObject({ type: "symlink", size: 0, sha256: null, target: "/usr/bin/python3" });
      const dir = entries.find((entry) => entry.path === "dist")!;
      expect(dir).toMatchObject({ type: "dir", size: 0, sha256: null });
      const file = entries.find((entry) => entry.path === "build/app.o")!;
      expect(file).toMatchObject({ type: "file", size: 4, sha256: "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8" });

      const everything = await scanArchiveTree(root, { excludedDirs: [state], includeCredentialFiles: true });
      expect(paths(everything.entries)).toEqual(expect.arrayContaining([".env", "id_rsa", ".ssh/config"]));
      expect(everything.excluded.credential).toBe(0);
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });

  test("names that are not valid UTF-8 are excluded, never decoded lossily", async () => {
    const root = await tempDir("scan-bytes");
    await writeFile(join(root, "ok.txt"), "x");
    const bad = Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0xff, 0xfe]), Buffer.from(".txt")]);
    let created = true;
    try {
      await writeFile(bad, "x");
    } catch {
      created = false; // APFS and most macOS volumes reject such names outright.
    }
    const { entries, excluded } = await scanArchiveTree(root);
    expect(paths(entries)).toEqual(["ok.txt"]);
    expect(excluded.non_utf8).toBe(created ? 1 : 0);
  });

  test("cache hits read no content; a writer that keeps mtime is still caught", async () => {
    const root = await tempDir("scan-cache");
    for (let index = 0; index < 20; index += 1) await writeFile(join(root, `f${index}.txt`), `content ${index}`);
    const cache = new ArchiveHashCache();
    const first = emptyScanMetrics();
    await scanArchiveTree(root, { hashCache: cache, metrics: first });
    expect(first.fileReads).toBe(20);
    // Round trip through the JSON form, as between captures.
    const text = [...cache.jsonChunks()].join("");
    expect(JSON.parse(text).entries).toHaveLength(20);
    const reloaded = ArchiveHashCache.fromText(text);
    expect(reloaded.size).toBe(20);
    const second = emptyScanMetrics();
    const unchanged = await scanArchiveTree(root, { hashCache: reloaded, metrics: second });
    expect(second).toMatchObject({ fileReads: 0, cacheHits: 20, bytesHashed: 0 });
    const before = await stat(join(root, "f3.txt"));
    await writeFile(join(root, "f3.txt"), "CONTENT 3");
    await utimes(join(root, "f3.txt"), before.atime, before.mtime);
    const third = emptyScanMetrics();
    const changed = await scanArchiveTree(root, { hashCache: reloaded, metrics: third });
    expect(third.fileReads).toBe(1);
    const delta = computeArchiveDelta(unchanged.entries.map(archiveEntry), changed.entries);
    expect(paths(delta.files)).toEqual(["f3.txt"]);
  });
});

describe("delta", () => {
  async function scan(root: string): Promise<ScannedEntry[]> {
    return (await scanArchiveTree(root)).entries;
  }

  test("add, modify (content and mode), delete, rename and type changes", async () => {
    const root = await tempDir("delta");
    await writeFile(join(root, "keep.txt"), "same");
    await writeFile(join(root, "edit.txt"), "before");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o644 });
    await writeFile(join(root, "gone.txt"), "bye");
    await writeFile(join(root, "old-name.txt"), "moved");
    await writeFile(join(root, "becomes-dir"), "file");
    await mkdir(join(root, "becomes-file/sub"), { recursive: true });
    await writeFile(join(root, "becomes-file/sub/x.txt"), "x");
    await mkdir(join(root, "mode-dir"));
    await symlink("keep.txt", join(root, "link"));
    const baseline = (await scan(root)).map(archiveEntry);

    expect(computeArchiveDelta(baseline, await scan(root))).toEqual({ files: [], deleted: [] });

    await writeFile(join(root, "edit.txt"), "after!");
    await chmod(join(root, "run.sh"), 0o755);
    await rm(join(root, "gone.txt"));
    await rename(join(root, "old-name.txt"), join(root, "new-name.txt"));
    await rm(join(root, "becomes-dir"));
    await mkdir(join(root, "becomes-dir"));
    await writeFile(join(root, "becomes-dir/inside.txt"), "in");
    await rm(join(root, "becomes-file"), { recursive: true });
    await writeFile(join(root, "becomes-file"), "now a file");
    await chmod(join(root, "mode-dir"), 0o700);
    await rm(join(root, "link"));
    await symlink("edit.txt", join(root, "link"));
    await writeFile(join(root, "added.txt"), "new");

    const delta = computeArchiveDelta(baseline, await scan(root));
    expect(paths(delta.files)).toEqual(["added.txt", "becomes-dir", "becomes-dir/inside.txt", "becomes-file", "edit.txt", "link", "mode-dir", "new-name.txt", "run.sh"]);
    expect(delta.deleted).toEqual(["becomes-file/sub", "becomes-file/sub/x.txt", "gone.txt", "old-name.txt"]);
    expect(delta.files.find((entry) => entry.path === "becomes-dir")!.type).toBe("dir");
    expect(delta.files.find((entry) => entry.path === "becomes-file")!.type).toBe("file");
    expect(delta.files.find((entry) => entry.path === "link")!.target).toBe("edit.txt");
  });

  test("a baseline entry with a null hash (unstable) is always sent again", async () => {
    const root = await tempDir("delta-unstable");
    await writeFile(join(root, "a.txt"), "a");
    const baseline = (await scan(root)).map((entry) => ({ ...archiveEntry(entry), sha256: null }));
    expect(paths(computeArchiveDelta(baseline, await scan(root)).files)).toEqual(["a.txt"]);
  });

  test("changes inside .git (a new commit) are a delta", async () => {
    const root = await tempDir("delta-git");
    await git(root, "init", "-q", "-b", "main");
    await writeFile(join(root, "a.txt"), "a");
    await git(root, "add", "a.txt");
    await git(root, "commit", "-q", "-m", "one");
    const baseline = (await scan(root)).map(archiveEntry);
    await git(root, "commit", "-q", "--allow-empty", "-m", "two");
    const delta = computeArchiveDelta(baseline, await scan(root));
    expect(delta.files.some((entry) => entry.path === ".git/refs/heads/main" || entry.path.startsWith(".git/objects/"))).toBe(true);
    expect(delta.files.every((entry) => entry.path.startsWith(".git"))).toBe(true);
  });
});

describe("manifest and git block", () => {
  test("manifest JSON: key order, base without deleted, delta with deleted", () => {
    const common = {
      archiveId: "5d0c6f9e-1d8e-4b5c-9a53-0e8f2b7c1a44",
      sessionId: "ses_manifest",
      turn: 7,
      createdAt: new Date("2026-09-23T10:15:30.123Z"),
      label: "my-app",
      marker: ".git",
      git: { head: "a".repeat(40), branch: "main", remote: "https://github.com/acme/my-app.git", dirty: true },
      files: [
        { path: "current", type: "symlink" as const, mode: 493, size: 0, sha256: null, target: "releases/v2" },
        { path: "src/new", type: "dir" as const, mode: 493, size: 0, sha256: null },
      ],
      excluded: { credential: 2, special: 0, app_state: 0, reserved: 0, unreadable: 0, non_utf8: 0 },
    };
    const base = JSON.parse(buildManifestBytes({ ...common, kind: "base", sequence: 0, parentArchiveId: null }).toString("utf8"));
    expect(Object.keys(base)).toEqual(["schema", "kind", "archive_id", "session_id", "sequence", "turn", "created_at", "parent_archive_id", "workspace", "files", "excluded"]);
    expect(base.created_at).toBe("2026-09-23T10:15:30.123Z");
    expect(base.files[0]).toEqual({ path: "current", type: "symlink", mode: 493, size: 0, sha256: null, target: "releases/v2" });
    expect(Object.keys(base.files[1])).toEqual(["path", "type", "mode", "size", "sha256"]);
    const delta = JSON.parse(buildManifestBytes({ ...common, kind: "delta", sequence: 3, parentArchiveId: "0b1f0f7a-6f2e-4c8e-8d8a-3a4d2c9e7b10", deleted: ["src/old.ts"] }).toString("utf8"));
    expect(delta.deleted).toEqual(["src/old.ts"]);
    expect(Object.keys(delta).slice(-3)).toEqual(["files", "deleted", "excluded"]);
  });

  test("workspace.git: head, branch, origin without userinfo, dirty; null outside a repository", async () => {
    const root = await tempDir("git-block");
    expect(await readArchiveGit(root)).toBeNull();
    await git(root, "init", "-q", "-b", "main");
    expect(await readArchiveGit(root)).toEqual({ head: null, branch: "main", remote: null, dirty: false });
    await writeFile(join(root, "a.txt"), "a");
    await git(root, "add", "a.txt");
    await git(root, "commit", "-q", "-m", "one");
    await git(root, "remote", "add", "upstream", "https://example.com/upstream.git");
    await git(root, "remote", "add", "origin", "https://user:ghp_secret@github.com/acme/my-app.git");
    const head = await git(root, "rev-parse", "HEAD");
    expect(await readArchiveGit(root)).toEqual({ head, branch: "main", remote: "https://github.com/acme/my-app.git", dirty: false });
    await writeFile(join(root, "untracked.txt"), "u");
    expect((await readArchiveGit(root))!.dirty).toBe(true);
    await git(root, "checkout", "-q", "--detach");
    expect((await readArchiveGit(root))!.branch).toBeNull();
  });

  test("reading the git block does not rewrite .git/index (no spurious delta)", async () => {
    const root = await tempDir("git-locks");
    await git(root, "init", "-q", "-b", "main");
    await writeFile(join(root, "a.txt"), "a");
    await git(root, "add", "a.txt");
    await git(root, "commit", "-q", "-m", "one");
    // A touched tracked file makes a plain `git status` refresh and rewrite the index.
    const later = new Date(Date.now() + 5_000);
    await utimes(join(root, "a.txt"), later, later);
    const before = (await scanArchiveTree(root)).entries.map(archiveEntry);
    await readArchiveGit(root);
    const after = await scanArchiveTree(root);
    expect(computeArchiveDelta(before, after.entries)).toEqual({ files: [], deleted: [] });
  });
});
