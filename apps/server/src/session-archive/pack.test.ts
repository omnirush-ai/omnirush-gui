import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildManifestBytes, emptyExcludedCounts, scanArchiveTree, type ScannedEntry } from "./manifest.js";
import { MANIFEST_MEMBER, UNSTABLE_MEMBER, packArchiveTar, tarMemberHeader, writeSealedArchive } from "./pack.js";
import { cleanupTempDirs, openArchive, readTar, tempDir, testKeys } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

const LONG_DIR = `deep/${"d".repeat(60)}/${"e".repeat(60)}`;
const LONG_FILE = `${LONG_DIR}/${"f".repeat(80)}.txt`;
const UNICODE_FILE = "naïve/日本語 ファイル 😀.md";
const LONG_TARGET = `../${"t".repeat(120)}/target`;

async function buildTree(root: string): Promise<void> {
  await mkdir(join(root, LONG_DIR), { recursive: true });
  await mkdir(join(root, "naïve"), { recursive: true });
  await mkdir(join(root, "empty/inner"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, LONG_FILE), "long path content\n");
  await writeFile(join(root, UNICODE_FILE), "unicode ✓\n");
  await writeFile(join(root, "a.txt"), "alpha\n");
  await writeFile(join(root, "bin/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  await writeFile(join(root, "big.bin"), Buffer.alloc(3 * 1024 * 1024 + 17, 7));
  await symlink("a.txt", join(root, "link-short"));
  await symlink(LONG_TARGET, join(root, "link-long"));
  await symlink("naïve/日本語 ファイル 😀.md", join(root, "link-unicode"));
  await symlink("/usr/bin/env", join(root, "link-absolute"));
}

/** Scans, runs `mutate`, then packs; `afterFirstBlock` runs once pass 2 has emitted its first block. */
async function packTree(root: string, mutate?: () => Promise<void>, afterFirstBlock?: () => Promise<void>) {
  const { entries } = await scanArchiveTree(root);
  const manifest = buildManifestBytes({
    kind: "base",
    archiveId: "5d0c6f9e-1d8e-4b5c-9a53-0e8f2b7c1a44",
    sessionId: "ses_pack_test",
    sequence: 0,
    turn: 0,
    createdAt: new Date("2026-09-23T10:15:30.123Z"),
    parentArchiveId: null,
    label: "project",
    marker: ".git",
    git: null,
    files: entries,
    excluded: emptyExcludedCounts(),
  });
  await mutate?.();
  const tar = packArchiveTar({ root, manifest, createdAtSeconds: 1790158530, entries });
  const pieces: Buffer[] = [];
  let pending = afterFirstBlock;
  for await (const piece of tar.stream) {
    pieces.push(Buffer.from(piece));
    const run = pending;
    pending = undefined;
    await run?.();
  }
  const bytes = Buffer.concat(pieces);
  return { entries, manifest, bytes, outcome: tar.outcome() };
}

const IN_TREE_CONFIG = "in-tree config, 41 bytes long...........\n";
const OUTSIDE_CONFIG = "Host prod\n  IdentityFile ~/.ssh/prod_key\n";

/** Replaces root/sub with a symlink to `outside`, as `npm link` or a tool might. */
async function swapForSymlink(root: string, outside: string): Promise<void> {
  await rename(join(root, "sub"), join(root, "sub.old"));
  await symlink(outside, join(root, "sub"));
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("pax tar writer", () => {
  test("member order: manifest first, then the manifest's files in order", async () => {
    const root = await tempDir("pack-order");
    await buildTree(root);
    const { entries, manifest, bytes, outcome } = await packTree(root);
    expect(outcome.unstable).toEqual([]);
    expect(outcome.tarBytes).toBe(bytes.length);
    expect(bytes.length % 512).toBe(0);
    expect(bytes.subarray(bytes.length - 1024).every((byte) => byte === 0)).toBe(true);
    const members = readTar(bytes);
    expect(members[0]!.name).toBe(MANIFEST_MEMBER);
    expect(members[0]!.content.equals(manifest)).toBe(true);
    expect(members[0]!.mode).toBe(0o644);
    expect(members[0]!.mtime).toBe(1790158530);
    expect(members.slice(1).map((member) => member.name)).toEqual(entries.map((entry) => entry.path));
    for (const member of members) {
      expect(member.uid).toBe(0);
      expect(member.gid).toBe(0);
      expect(["0", "2", "5"]).toContain(member.typeflag);
    }
    const byName = new Map(members.map((member) => [member.name, member]));
    expect(byName.get("big.bin")!.content.equals(await readFile(join(root, "big.bin")))).toBe(true);
    expect(byName.get("bin/run.sh")!.mode).toBe(0o755);
    expect(byName.get("link-long")!.linkname).toBe(LONG_TARGET);
    expect(byName.get("link-unicode")!.linkname).toBe("naïve/日本語 ファイル 😀.md");
    expect(byName.get(UNICODE_FILE)!.content.toString()).toBe("unicode ✓\n");
    expect(byName.get("empty/inner")!.typeflag).toBe("5");
    // Directories precede their content.
    const order = members.map((member) => member.name);
    expect(order.indexOf("naïve")).toBeLessThan(order.indexOf(UNICODE_FILE));
  });

  test("round trip through the system tar: long paths, unicode, symlinks, empty directories", async () => {
    const root = await tempDir("pack-src");
    await buildTree(root);
    const { bytes } = await packTree(root);
    const work = await tempDir("pack-out");
    await writeFile(join(work, "archive.tar"), bytes);
    const out = join(work, "out");
    await mkdir(out);
    await execFileAsync("tar", ["-xf", join(work, "archive.tar"), "-C", out]);
    expect(await readFile(join(out, LONG_FILE), "utf8")).toBe("long path content\n");
    expect(await readFile(join(out, UNICODE_FILE), "utf8")).toBe("unicode ✓\n");
    expect(sha256(await readFile(join(out, "big.bin")))).toBe(sha256(await readFile(join(root, "big.bin"))));
    expect(await readlink(join(out, "link-long"))).toBe(LONG_TARGET);
    // bsdtar on macOS NFD-normalizes extracted link targets; the raw bytes are checked by the other readers.
    expect((await readlink(join(out, "link-unicode"))).normalize("NFC")).toBe("naïve/日本語 ファイル 😀.md");
    expect(await readlink(join(out, "link-absolute"))).toBe("/usr/bin/env");
    expect((await lstat(join(out, "empty/inner"))).isDirectory()).toBe(true);
    expect((await lstat(join(out, "bin/run.sh"))).mode & 0o777).toBe(0o755);
    const manifest = JSON.parse(await readFile(join(out, MANIFEST_MEMBER), "utf8"));
    expect(manifest.schema).toBe("omnirush.archive.v1");
  });

  test("Python tarfile reads the stream the way the server does (mode r|)", async () => {
    const python = await execFileAsync("python3", ["--version"]).then(() => true, () => false);
    if (!python) return;
    const root = await tempDir("pack-py");
    await buildTree(root);
    const { bytes, entries } = await packTree(root);
    const work = await tempDir("pack-py-out");
    await writeFile(join(work, "archive.tar"), bytes);
    const script = [
      "import hashlib, json, sys, tarfile",
      "out = []",
      "with open(sys.argv[1], 'rb') as f:",
      "    with tarfile.open(fileobj=f, mode='r|') as t:",
      "        for m in t:",
      "            data = t.extractfile(m).read() if m.isfile() else b''",
      "            out.append([m.name, m.type.decode(), m.mode, m.size, m.linkname, hashlib.sha256(data).hexdigest() if m.isfile() else None, m.uid, m.gid, m.uname, m.gname])",
      "print(json.dumps(out))",
    ].join("\n");
    const { stdout } = await execFileAsync("python3", ["-c", script, join(work, "archive.tar")], { maxBuffer: 16 * 1024 * 1024 });
    const listed: Array<[string, string, number, number, string, string | null, number, number, string, string]> = JSON.parse(stdout);
    expect(listed[0]![0]).toBe(MANIFEST_MEMBER);
    const byPath = new Map<string, ScannedEntry>(entries.map((entry) => [entry.path, entry]));
    for (const [name, type, mode, size, linkname, digest, uid, gid, uname, gname] of listed.slice(1)) {
      const entry = byPath.get(name);
      expect(entry).toBeDefined();
      expect(mode).toBe(entry!.mode);
      expect([uid, gid, uname, gname]).toEqual([0, 0, "", ""]);
      if (entry!.type === "file") {
        expect(type).toBe("0");
        expect(size).toBe(entry!.size);
        expect(digest).toBe(entry!.sha256);
      } else if (entry!.type === "symlink") {
        expect(type).toBe("2");
        expect(linkname).toBe(entry!.target!);
      } else {
        expect(type).toBe("5");
      }
    }
    expect(listed.length).toBe(entries.length + 1);
  });

  test("a file that changes between the passes keeps its manifest size and is listed as unstable", async () => {
    const root = await tempDir("pack-unstable");
    await writeFile(join(root, "grows.txt"), "0123456789");
    await writeFile(join(root, "shrinks.txt"), "0123456789");
    await writeFile(join(root, "vanishes.txt"), "0123456789");
    await writeFile(join(root, "same.txt"), "0123456789");
    await symlink("same.txt", join(root, "retarget"));
    const { entries, bytes, outcome } = await packTree(root, async () => {
      await writeFile(join(root, "grows.txt"), "0123456789ABCDEFGHIJ");
      await writeFile(join(root, "shrinks.txt"), "0123");
      await rm(join(root, "vanishes.txt"));
      await rm(join(root, "retarget"));
      await symlink("grows.txt", join(root, "retarget"));
    });
    expect(outcome.unstable).toEqual(["grows.txt", "retarget", "shrinks.txt", "vanishes.txt"]);
    const members = readTar(bytes);
    const byName = new Map(members.map((member) => [member.name, member]));
    expect(byName.get("grows.txt")!.content.toString()).toBe("0123456789");
    expect(byName.get("shrinks.txt")!.content.toString()).toBe("0123\0\0\0\0\0\0");
    expect(byName.get("vanishes.txt")!.content.equals(Buffer.alloc(10))).toBe(true);
    expect(byName.get("retarget")!.linkname).toBe("same.txt");
    expect(byName.get("same.txt")!.content.toString()).toBe("0123456789");
    const last = members.at(-1)!;
    expect(last.name).toBe(UNSTABLE_MEMBER);
    expect(JSON.parse(last.content.toString())).toEqual({
      schema: "omnirush.archive.unstable.v1",
      paths: ["grows.txt", "retarget", "shrinks.txt", "vanishes.txt"],
    });
    expect(members.length).toBe(entries.length + 2);
  });

  test("a directory swapped for a symlink before pass 2: nothing is read from outside the root", async () => {
    const root = await tempDir("pack-swap");
    const outside = await tempDir("pack-swap-outside");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub/config"), IN_TREE_CONFIG);
    await symlink("config", join(root, "sub/alias"));
    await writeFile(join(outside, "config"), OUTSIDE_CONFIG);
    await symlink("config", join(outside, "alias"));
    const { bytes, outcome } = await packTree(root, () => swapForSymlink(root, outside));
    expect(bytes.includes("IdentityFile")).toBe(false);
    expect(outcome.unstable).toEqual(["sub/alias", "sub/config"]);
    const byName = new Map(readTar(bytes).map((member) => [member.name, member]));
    expect(byName.get("sub/config")!.content.equals(Buffer.alloc(IN_TREE_CONFIG.length))).toBe(true);
    expect(byName.get("sub/alias")!.linkname).toBe("config");
  });

  test("a directory swapped while pass 2 is inside it: the file behind the symlink is zero-filled", async () => {
    const root = await tempDir("pack-swap-live");
    const outside = await tempDir("pack-swap-live-outside");
    await mkdir(join(root, "sub"));
    // Pass 2 is still streaming a.bin when the first block arrives: the stream buffers at most a few MiB.
    await writeFile(join(root, "sub/a.bin"), randomBytes(8 * 1024 * 1024));
    await writeFile(join(root, "sub/config"), IN_TREE_CONFIG);
    await writeFile(join(outside, "config"), OUTSIDE_CONFIG);
    const { bytes, outcome } = await packTree(root, undefined, () => swapForSymlink(root, outside));
    expect(bytes.includes("IdentityFile")).toBe(false);
    expect(outcome.unstable).toEqual(["sub/config"]);
    const byName = new Map(readTar(bytes).map((member) => [member.name, member]));
    expect(byName.get("sub/a.bin")!.content.equals(await readFile(join(root, "sub.old/a.bin")))).toBe(true);
    expect(byName.get("sub/config")!.content.equals(Buffer.alloc(IN_TREE_CONFIG.length))).toBe(true);
  });

  test("a file replaced by a FIFO between the passes does not block pass 2", async () => {
    if (process.platform === "win32") return;
    const root = await tempDir("pack-fifo");
    await writeFile(join(root, "pipe"), "0123456789");
    await writeFile(join(root, "same.txt"), "0123456789");
    const { bytes, outcome } = await packTree(root, async () => {
      await rm(join(root, "pipe"));
      await execFileAsync("mkfifo", [join(root, "pipe")]);
    });
    expect(outcome.unstable).toEqual(["pipe"]);
    const byName = new Map(readTar(bytes).map((member) => [member.name, member]));
    expect(byName.get("pipe")!.content.equals(Buffer.alloc(10))).toBe(true);
    expect(byName.get("same.txt")!.content.toString()).toBe("0123456789");
  });

  test("headers: pax records for long or non-ASCII names and targets, ASCII fallbacks, size field", () => {
    const plain = tarMemberHeader({ name: "src/app.ts", mode: 0o644, size: 5, mtime: 100, typeflag: "0" });
    expect(plain.length).toBe(512);
    const exactly100 = tarMemberHeader({ name: "x".repeat(100), mode: 0o644, size: 0, mtime: 0, typeflag: "0" });
    expect(exactly100.length).toBe(512);
    const long = tarMemberHeader({ name: "y".repeat(101), mode: 0o644, size: 0, mtime: 0, typeflag: "0" });
    expect(long.length).toBe(1536);
    expect(long.subarray(0, 14).toString()).toBe("././@PaxHeader");
    expect(long.subarray(512, 1024).toString("utf8")).toContain(` path=${"y".repeat(101)}\n`);
    const unicode = tarMemberHeader({ name: "é.txt", mode: 0o644, size: 0, mtime: -5, typeflag: "0" });
    const main = unicode.subarray(1024);
    expect(main.subarray(0, 6).toString("latin1")).toBe("__.txt");
    const [parsed] = readTar(Buffer.concat([unicode, Buffer.alloc(1024)]));
    expect(parsed!.name).toBe("é.txt");
    expect(parsed!.mtime).toBe(0);
    const huge = tarMemberHeader({ name: "huge.bin", mode: 0o644, size: 8 ** 11, mtime: 0, typeflag: "0" });
    expect(huge.subarray(512, 1024).toString()).toContain(` size=${8 ** 11}\n`);
    expect(huge.subarray(1024 + 124, 1024 + 136).toString()).toBe("00000000000\0");
  });

  test("writeSealedArchive: a multi-MiB tree survives tar -> zstd -> seal with recycled blocks", async () => {
    const root = await tempDir("pack-sealed");
    await mkdir(join(root, "many"), { recursive: true });
    await writeFile(join(root, "random.bin"), randomBytes(6 * 1024 * 1024 + 333));
    await writeFile(join(root, "text.log"), "line of compressible log text\n".repeat(150_000));
    for (let index = 0; index < 300; index += 1) await writeFile(join(root, `many/f${index}.txt`), randomBytes(1 + index * 37));
    const { entries } = await scanArchiveTree(root);
    const manifest = buildManifestBytes({
      kind: "base",
      archiveId: "5d0c6f9e-1d8e-4b5c-9a53-0e8f2b7c1a44",
      sessionId: "ses_pack_sealed",
      sequence: 0,
      turn: 0,
      createdAt: new Date(),
      parentArchiveId: null,
      label: "project",
      marker: ".git",
      git: null,
      files: entries,
      excluded: emptyExcludedCounts(),
    });
    const out = join(await tempDir("pack-sealed-out"), "archive.orseal");
    const sealed = await writeSealedArchive({ root, manifest, createdAtSeconds: 0, entries }, { publicKey: testKeys.publicKey }, out);
    const bytes = await readFile(out);
    expect(sealed.size).toBe(bytes.length);
    expect(sealed.sha256).toBe(sha256(bytes));
    expect(sealed.kid).toBe(testKeys.kid);
    expect(sealed.unstable).toEqual([]);
    expect(sealed.tarBytes).toBeGreaterThan(10 * 1024 * 1024);
    const members = await openArchive(bytes);
    expect(members.map((member) => member.name)).toEqual([MANIFEST_MEMBER, ...entries.map((entry) => entry.path)]);
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      expect(sha256(members.find((member) => member.name === entry.path)!.content)).toBe(entry.sha256!);
    }
    // The payload is one zstd frame with a content checksum, readable by the zstd CLI too.
    const zstd = await execFileAsync("zstd", ["--version"]).then(() => true, () => false);
    if (zstd) {
      const { zstdDecompressSync } = await import("node:zlib");
      const { openSealedBuffer } = await import("./seal.js");
      const payload = join(await tempDir("pack-sealed-zst"), "payload.tar.zst");
      await writeFile(payload, await openSealedBuffer(bytes, testKeys.keyring));
      await execFileAsync("zstd", ["-t", "-q", payload]);
      expect(zstdDecompressSync(await readFile(payload)).length).toBe(sealed.tarBytes);
    }
    // An existing output file is never overwritten.
    await expect(writeSealedArchive({ root, manifest, createdAtSeconds: 0, entries }, { publicKey: testKeys.publicKey }, out)).rejects.toThrow();
    // A stopped writer (the shutdown budget spent) rejects instead of finishing.
    const stopped = new AbortController();
    stopped.abort(new Error("shutdown budget spent"));
    const cut = join(await tempDir("pack-sealed-cut"), "archive.orseal");
    await expect(writeSealedArchive({ root, manifest, createdAtSeconds: 0, entries, signal: stopped.signal }, { publicKey: testKeys.publicKey }, cut)).rejects.toThrow("shutdown budget spent");
  });
});
