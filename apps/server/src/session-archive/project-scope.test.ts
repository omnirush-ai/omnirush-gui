import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { SessionUploader } from "../session-uploader.js";
import { looksLikeProject, projectArchiveSkip } from "./detect.js";
import { SessionArchiver } from "./index.js";
import { parseArchivePolicy } from "./policy.js";
import { openSealedBuffer, SEAL_ALG, sealKeyring } from "./seal.js";
import { readTar } from "./test-helpers.js";

// A folder without git: a project-looking one is archived whole (marker
// `project`), any other in touched-files scope lists every file it leaves out,
// and a credential store is refused with a reason the start upload carries.

const cleanups: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}
function write(file: string, content: string | Buffer): Buffer {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

type Item = { path: string; type: string; reason: string; size?: number; sha256?: string; mtime?: number };
function rig(policy: Record<string, unknown>) {
  const stateDir = temp("omnirush-scope-state-");
  const keyring = sealKeyring([randomBytes(32)]);
  const { publicRaw, kid } = [...keyring.values()][0]!;
  const created: Array<Record<string, unknown>> = [];
  const request = async (route: string, init?: { body?: unknown }) => {
    if (route === "archives/key") return Response.json({ public_key: publicRaw.toString("base64"), kid, alg: SEAL_ALG, policy });
    if (route === "archives" && init?.body) created.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 404 });
  };
  const archiver = new SessionArchiver({ stateDir, request: request as never, excludedDirs: [stateDir], log: () => undefined, touchedFlushMs: 10 });
  stops.push(() => archiver.stop({ budgetMs: 1000 }));
  const open = async (result: Awaited<ReturnType<SessionArchiver["captureBase"]>>) => {
    if (result.status !== "queued") throw new Error(`not queued: ${JSON.stringify(result)}`);
    const sealed = readFileSync(join(stateDir, "omnirush-archive", "pending", `${result.archiveId}.orseal`));
    const members = new Map(readTar(zstdDecompressSync(await openSealedBuffer(sealed, keyring))).map((member) => [member.name.replace(/\/$/, ""), member]));
    const json = (name: string) => JSON.parse(members.get(name)!.content.toString("utf8"));
    return { members, manifest: json("__omnirush__/manifest.json"), state: json("__omnirush__/state.json") as { excluded: Item[]; excluded_truncated: boolean; excluded_truncated_count: number } };
  };
  return { archiver, open, created };
}

describe("looksLikeProject", () => {
  test("a manifest or lockfile in the root or two levels down, or src/ with code, makes a project; deeper or in node_modules does not", async () => {
    for (const [file, expected] of [
      ["package.json", "package.json"], ["requirements-dev.txt", "requirements-dev.txt"], ["app/pyproject.toml", "app/pyproject.toml"],
      ["services/api/go.mod", "services/api/go.mod"], ["x/App.csproj", "x/App.csproj"], ["build.gradle.kts", "build.gradle.kts"],
      ["Makefile", "Makefile"], ["CMakeLists.txt", "CMakeLists.txt"], ["web/Cargo.toml", "web/Cargo.toml"],
    ] as const) {
      const root = temp("omnirush-project-");
      write(join(root, file), "x");
      expect((await looksLikeProject(root))?.path).toBe(expected);
    }
    const src = temp("omnirush-project-src-");
    write(join(src, "src", "main.py"), "print(1)\n");
    expect(await looksLikeProject(src)).toEqual({ path: "src", kind: "src" });
    const none = temp("omnirush-project-none-");
    write(join(none, "a", "b", "c", "package.json"), "{}");
    write(join(none, "node_modules", "package.json"), "{}");
    write(join(none, ".cache", "package.json"), "{}");
    write(join(none, "src", "notes.txt"), "not code");
    write(join(none, "notes.txt"), "hello");
    expect(await looksLikeProject(none)).toBeNull();
  });

  test("bounded on a big folder: 20,000 files without a manifest are judged in milliseconds", async () => {
    const root = temp("omnirush-project-big-");
    for (let bucket = 0; bucket < 40; bucket += 1) for (let n = 0; n < 500; n += 1) write(join(root, `bucket_${bucket}`, `f_${n}.txt`), `${bucket}/${n}\n`);
    const started = performance.now();
    expect(await looksLikeProject(root)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("credential roots", () => {
  test("a session in ~/.aws (or inside it) is skipped with reason credential_root; a plain folder or a git repository is not", async () => {
    const home = temp("omnirush-home-");
    write(join(home, ".aws", "config"), "[default]\n");
    write(join(home, ".aws", "sso", "cache", "x.json"), "{}");
    write(join(home, "work", "notes.txt"), "hi");
    expect(await projectArchiveSkip(join(home, ".aws"), { homeDir: home })).toEqual({ status: "skipped", reason: "credential_root" });
    expect(await projectArchiveSkip(join(home, ".aws", "sso", "cache"), { homeDir: home })).toEqual({ status: "skipped", reason: "credential_root" });
    expect(await projectArchiveSkip(home, { homeDir: home })).toEqual({ status: "skipped", reason: "root_too_broad" });
    expect(await projectArchiveSkip(join(home, "work"), { homeDir: home })).toBeNull();
    mkdirSync(join(home, "work", ".git"));
    expect(await projectArchiveSkip(join(home, "work"), { homeDir: home })).toBeNull();
  });
});

describe("policy", () => {
  test("project_folders is on only as the boolean true", () => {
    expect(parseArchivePolicy({ policy: { all_folders: false, touched_files: true, project_folders: true } }).projectFolders).toBe(true);
    for (const policy of [{}, { project_folders: false }, { project_folders: "true" }]) expect(parseArchivePolicy({ policy }).projectFolders).toBeUndefined();
  });
});

describe("a folder without git", () => {
  test("a project folder is archived whole with marker project: regenerable folders and credentials listed, no git block", async () => {
    const { archiver, open } = rig({ all_folders: false, touched_files: true, project_folders: true, capture_v2: true });
    const root = temp("omnirush-scope-project-");
    write(join(root, "package.json"), '{"name":"demo"}\n');
    write(join(root, "src", "index.ts"), "export const x = 1;\n");
    for (let n = 0; n < 50; n += 1) write(join(root, "data", `row_${n}.csv`), `${n}\n`);
    write(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    write(join(root, ".env"), "API_KEY=sk-live-secret\n");
    const sessionId = "ses_scope_project";
    expect(await archiver.startManifest(sessionId, root)).toBe("complete");
    const base = await open(await archiver.captureBase(sessionId, root, 0));
    expect(base.manifest.workspace.marker).toBe("project");
    expect(base.manifest.workspace.git).toBeNull();
    expect(base.members.has("data/row_49.csv")).toBe(true);
    expect(base.members.has("src/index.ts")).toBe(true);
    expect(base.members.has("node_modules/dep/index.js") || base.members.has(".env")).toBe(false);
    const reasons = new Map(base.state.excluded.map((item) => [item.path, item.reason]));
    expect([reasons.get("node_modules"), reasons.get(".env")]).toEqual(["regenerable", "credential"]);
  });

  test("without project_folders (an older backend) a project folder stays in touched scope", async () => {
    const { archiver } = rig({ all_folders: false, touched_files: true, capture_v2: true });
    const root = temp("omnirush-scope-oldbackend-");
    write(join(root, "package.json"), "{}");
    expect(await archiver.captureBase("ses_scope_oldbackend", root, 0)).toEqual({ status: "skipped", reason: "unchanged" });
  });

  test("touched scope lists every file it does not archive with size and sha256 (a big one with its mtime), never silently", async () => {
    const { archiver, open } = rig({ all_folders: false, touched_files: true, project_folders: true, capture_v2: true });
    const root = temp("omnirush-scope-touched-");
    for (let n = 0; n < 30; n += 1) write(join(root, "bucket", `f_${n}.txt`), `file ${n}\n`);
    const huge = join(root, "huge.bin");
    write(huge, Buffer.alloc(0));
    // Sparse 65 MiB: over the hash cap without writing it.
    const { truncateSync } = await import("node:fs");
    truncateSync(huge, 65 * 1024 * 1024);
    write(join(root, ".env"), "TOKEN=abcdefgh123\n");
    write(join(root, "node_modules", "x", "i.js"), "1\n");
    const sessionId = "ses_scope_touched";
    expect(await archiver.captureBase(sessionId, root, 0)).toEqual({ status: "skipped", reason: "unchanged" });
    write(join(root, "NOTES.txt"), "the agent wrote this\n");
    archiver.recordTouched(sessionId, "NOTES.txt");
    const base = await open(await archiver.captureDelta(sessionId, root, 1));
    expect(base.manifest.scope).toBe("touched");
    expect(base.members.has("NOTES.txt")).toBe(true);
    const items = new Map(base.state.excluded.map((item) => [item.path, item]));
    expect(items.has("NOTES.txt")).toBe(false);
    for (let n = 0; n < 30; n += 1) {
      const item = items.get(`bucket/f_${n}.txt`)!;
      expect(item).toEqual({ path: `bucket/f_${n}.txt`, type: "file", reason: "not_archived_touched_scope", size: `file ${n}\n`.length, sha256: sha256(`file ${n}\n`) });
    }
    const big = items.get("huge.bin")!;
    expect([big.reason, big.size, big.sha256, typeof big.mtime]).toEqual(["not_archived_touched_scope", 65 * 1024 * 1024, undefined, "number"]);
    expect(items.get(".env")!.reason).toBe("credential");
    expect(items.get("node_modules")!.reason).toBe("regenerable");
    expect(base.state.excluded_truncated).toBe(false);
    expect(base.state.excluded_truncated_count).toBe(0);
  });

  test("a non-project folder is not prescanned once the policy says touched scope", async () => {
    const { archiver } = rig({ all_folders: false, touched_files: true, project_folders: true, capture_v2: true });
    const root = temp("omnirush-scope-noprescan-");
    write(join(root, "a.txt"), "a\n");
    // The first session learns the policy; the next one's start gate takes no whole-folder scan.
    await archiver.captureBase("ses_scope_learn_1", root, 0);
    expect(await archiver.startManifest("ses_scope_learn_2", root)).toBe("skipped");
  });
});

describe("start upload", () => {
  test("a session in a credential store says why it has no project archive; a plain folder says nothing", async () => {
    const parent = temp("omnirush-scope-upload-");
    const results: Record<string, unknown> = {};
    for (const name of [".aws", "plain"]) {
      const root = join(parent, name);
      write(join(root, "config"), "[default]\nregion = eu-west-1\n");
      const uploads: Array<Record<string, any>> = [];
      const upload = async (_sessionId: string, compressed: Uint8Array) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")));
        return Response.json({ ok: true }, { status: 201 });
      };
      const uploader = new SessionUploader({ upload, fallbackScanMs: 60_000 });
      uploader.startSession(`ses_scope_upload_${name.replace(".", "")}`, "ws", root);
      await uploader.stop();
      const start = uploads.find((item) => item.snapshot_type === "start")!;
      results[name] = start.workspace.project_archive ?? null;
    }
    expect(results).toEqual({ ".aws": { status: "skipped", reason: "credential_root" }, plain: null });
  });
});

void homedir;
