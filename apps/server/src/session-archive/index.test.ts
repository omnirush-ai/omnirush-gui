import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { gitMarkerDetector, gitParentDetector } from "./detect.js";
import { FakeArchiveServer, slowPartTwo } from "./fake-archive-server.js";
import { ARCHIVE_STATE_DIRECTORY, SessionArchiver, type SessionArchiverOptions } from "./index.js";
import { cleanupTempDirs, manifestOf, openArchive, tempDir } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
  return stdout.trim();
}

function archiver(server: FakeArchiveServer, stateDir: string, options: Partial<SessionArchiverOptions> = {}) {
  return new SessionArchiver({
    gatewayUrl: server.gatewayUrl,
    accessToken: server.token,
    fetch: server.respond,
    stateDir,
    retry: { baseMs: 1, maxMs: 2, attempts: 2 },
    ...options,
  });
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A git project with ignored dependencies and build output, a binary asset and two credential files. */
async function project(): Promise<{ root: string; blend: Buffer; head: string }> {
  const root = await tempDir("project");
  await git(root, "init", "-q", "-b", "main");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.ts"), "export const app = 1;\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
  await mkdir(join(root, "node_modules/left-pad"), { recursive: true });
  await writeFile(join(root, "node_modules/left-pad/index.js"), "module.exports = (s) => s;\n");
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/bundle.js"), "console.log(1);\n");
  await mkdir(join(root, "assets"));
  const blend = randomBytes(300 * 1024);
  await writeFile(join(root, "assets/scene.blend"), blend);
  await writeFile(join(root, ".env"), "API_KEY=sk-live-1234567890\n");
  await writeFile(join(root, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  await git(root, "add", "src", ".gitignore", "assets");
  await git(root, "commit", "-q", "-m", "initial");
  await git(root, "branch", "token-fix");
  await git(root, "remote", "add", "origin", "https://user:ghp_token@github.com/acme/app.git");
  return { root, blend, head: await git(root, "rev-parse", "HEAD") };
}

describe("SessionArchiver", () => {
  test("whole folder: base with .git and ignored content, credentials left out, then a delta after a change", async () => {
    const server = new FakeArchiveServer();
    const { root, blend, head } = await project();
    const state = await tempDir("state");
    const logs: string[] = [];
    const subject = archiver(server, state, { log: (_level, message) => logs.push(message) });

    const base = await subject.captureBase("ses_whole_folder", root);
    expect(base).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect(await subject.drain()).toEqual({ uploaded: 1, pending: 0, dropped: 0, blocked: null, disabled: false });

    const [first] = server.objects();
    expect(first!.request).toMatchObject({ session_id: "ses_whole_folder", kind: "base", sequence: 0, turn: 0, parent_archive_id: null, marker: ".git", content: "tar+zstd", kid: "f900b070cdd3a117" });
    expect(first!.request.size).toBe(first!.object!.length);
    expect(first!.request.sha256).toBe(sha256(first!.object!));
    const members = await openArchive(first!.object!);
    const names = members.map((member) => member.name);
    for (const present of [".git/HEAD", ".git/config", ".git/refs/heads/main", ".git/refs/heads/token-fix", "node_modules/left-pad/index.js", "dist/bundle.js", "assets/scene.blend", "src/app.ts", ".gitignore"]) {
      expect(names).toContain(present);
    }
    expect(names).not.toContain(".env");
    expect(names).not.toContain("id_rsa");
    expect(members.find((member) => member.name === "assets/scene.blend")!.content.equals(blend)).toBe(true);
    const manifest = manifestOf(members);
    expect(manifest).toMatchObject({
      schema: "omnirush.archive.v1",
      kind: "base",
      archive_id: base.status === "queued" ? base.archiveId : "",
      session_id: "ses_whole_folder",
      sequence: 0,
      turn: 0,
      parent_archive_id: null,
      workspace: { label: basename(root), marker: ".git", git: { head, branch: "main", remote: "https://github.com/acme/app.git", dirty: true, path: "" } },
      excluded: { credential: 2, special: 0, app_state: 0, reserved: 0, unreadable: 0, non_utf8: 0 },
    });
    expect("deleted" in manifest).toBe(false);
    expect(Array.isArray(manifest.files) ? manifest.files.length : -1).toBe(members.length - 1);

    // A turn edits, adds, deletes and commits.
    await writeFile(join(root, "src/app.ts"), "export const app = 2;\n");
    await writeFile(join(root, "src/new.ts"), "export const added = true;\n");
    await rm(join(root, "dist/bundle.js"));
    await git(root, "add", "src");
    await git(root, "commit", "-q", "-m", "turn one");
    const delta = await subject.captureDelta("ses_whole_folder", root, 1);
    expect(delta).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    expect((await subject.drain()).uploaded).toBe(1);
    const second = server.objects()[1]!;
    expect(second.request).toMatchObject({ kind: "delta", sequence: 1, turn: 1, parent_archive_id: first!.request.archive_id });
    const deltaMembers = await openArchive(second.object!);
    const deltaManifest = manifestOf(deltaMembers);
    expect(deltaManifest).toMatchObject({ kind: "delta", sequence: 1, turn: 1, parent_archive_id: first!.request.archive_id, deleted: ["dist/bundle.js"] });
    const changed = deltaMembers.slice(1).map((member) => member.name);
    expect(changed).toEqual(expect.arrayContaining(["src/app.ts", "src/new.ts", ".git/refs/heads/main", ".git/index"]));
    expect(changed).not.toContain("node_modules/left-pad/index.js");
    expect(changed).not.toContain("assets/scene.blend");
    expect(deltaMembers.find((member) => member.name === "src/app.ts")!.content.toString()).toBe("export const app = 2;\n");

    // Nothing changed: no archive and no sequence number used.
    expect(await subject.captureDelta("ses_whole_folder", root, 2)).toEqual({ status: "skipped", reason: "unchanged" });
    expect(await subject.captureDelta("ses_whole_folder", root, 1)).toEqual({ status: "skipped", reason: "stale_turn" });
    expect(await subject.captureBase("ses_whole_folder", root)).toEqual({ status: "skipped", reason: "exists" });
    await writeFile(join(root, "src/app.ts"), "export const app = 3;\n");
    expect(await subject.captureDelta("ses_whole_folder", root, 3)).toMatchObject({ status: "queued", sequence: 2 });
    expect((await subject.drain()).uploaded).toBe(1);
    expect(server.objects().map((archive) => archive.request.sequence)).toEqual([0, 1, 2]);
    // Nothing is left behind in the state dir once uploaded.
    const archiveDir = join(state, ARCHIVE_STATE_DIRECTORY);
    expect(await readdir(join(archiveDir, "pending"))).toEqual([]);
    expect(await readdir(join(archiveDir, "queue"))).toEqual([]);
    expect(await readdir(join(archiveDir, "tmp"))).toEqual([]);
    expect(await readdir(join(archiveDir, "baselines"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("X-Amz-Signature");
  });

  test("archiveIncludeCredentialFiles keeps .env and id_rsa", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const subject = archiver(server, await tempDir("state"), { archiveIncludeCredentialFiles: true });
    expect((await subject.captureBase("ses_with_credentials", root)).status).toBe("queued");
    await subject.drain();
    const names = (await openArchive(server.objects()[0]!.object!)).map((member) => member.name);
    expect(names).toEqual(expect.arrayContaining([".env", "id_rsa"]));
  });

  test("a folder without .git is not archived and nothing is sent", async () => {
    const server = new FakeArchiveServer();
    const root = await tempDir("plain");
    await writeFile(join(root, "notes.md"), "hello");
    const subject = archiver(server, await tempDir("state"));
    expect(await subject.captureBase("ses_plain_folder", root)).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(await subject.captureDelta("ses_plain_folder", root, 1)).toEqual({ status: "skipped", reason: "no_base" });
    expect(server.calls).toEqual([]);
  });

  test("a folder inside a repository: the whole folder with every subfolder, nothing from the parent or its .git, git block from the parent", async () => {
    const server = new FakeArchiveServer();
    const { root: repo, head } = await project();
    const root = join(repo, "packages/app");
    await mkdir(join(root, "src/deep/deeper"), { recursive: true });
    await writeFile(join(root, "src/main.ts"), "export const main = 1;\n");
    await writeFile(join(root, "src/deep/deeper/data.bin"), randomBytes(4096));
    await mkdir(join(root, "node_modules/dep"), { recursive: true });
    await writeFile(join(root, "node_modules/dep/index.js"), "module.exports = 1;\n");
    await mkdir(join(root, "dist"));
    const binary = randomBytes(200 * 1024);
    await writeFile(join(root, "dist/app.wasm"), binary);
    await writeFile(join(root, ".env"), "TOKEN=abc\n");
    await mkdir(join(repo, "packages/other"), { recursive: true });
    await writeFile(join(repo, "packages/other/sibling.ts"), "export {};\n");
    // Temp folders sit under /private or /var on macOS, where the parent walk never looks.
    const detectors = [gitMarkerDetector, (dir: string) => gitParentDetector(dir, { systemDirs: [] })];
    const subject = archiver(server, await tempDir("state"), { detectors });

    expect(await subject.captureBase("ses_repo_subfolder", root)).toMatchObject({ status: "queued", kind: "base" });
    await subject.drain();
    const [first] = server.objects();
    expect(first!.request).toMatchObject({ kind: "base", marker: ".git" });
    const members = await openArchive(first!.object!);
    const names = members.map((member) => member.name);
    expect(names).toEqual(expect.arrayContaining(["src/main.ts", "src/deep/deeper/data.bin", "node_modules/dep/index.js", "dist/app.wasm"]));
    expect(names.filter((name) => name.split("/").includes(".git"))).toEqual([]);
    for (const outside of ["src/app.ts", ".gitignore", "assets/scene.blend", "sibling.ts", "packages/other/sibling.ts", ".env"]) expect(names).not.toContain(outside);
    expect(names.every((name) => !name.startsWith("/") && !name.split("/").includes(".."))).toBe(true);
    expect(members.find((member) => member.name === "dist/app.wasm")!.content.equals(binary)).toBe(true);
    expect(manifestOf(members)).toMatchObject({
      workspace: { label: "app", marker: ".git", git: { head, branch: "main", remote: "https://github.com/acme/app.git", dirty: true, path: "packages/app" } },
      excluded: { credential: 1 },
    });

    await writeFile(join(root, "src/main.ts"), "export const main = 2;\n");
    await git(repo, "add", "packages/app/src");
    await git(repo, "commit", "-q", "-m", "turn one");
    expect((await subject.captureDelta("ses_repo_subfolder", root, 1)).status).toBe("queued");
    await subject.drain();
    const deltaMembers = await openArchive(server.objects()[1]!.object!);
    expect(deltaMembers.slice(1).map((member) => member.name)).toEqual(["src/main.ts"]);
    expect(manifestOf(deltaMembers)).toMatchObject({ workspace: { git: { head: await git(repo, "rev-parse", "HEAD"), branch: "main", path: "packages/app" } } });
  });

  test("an empty .git between the folder and a dotfiles repository at home: nothing archived, and git never reports the dotfiles repository", async () => {
    const server = new FakeArchiveServer();
    const home = await tempDir("dotfiles-home");
    await git(home, "init", "-q", "-b", "dotfiles");
    await writeFile(join(home, ".zshrc"), "export EDITOR=vi\n");
    await git(home, "add", ".zshrc");
    await git(home, "commit", "-q", "-m", "dotfiles");
    await git(home, "remote", "add", "origin", "https://example.com/me/dotfiles.git");
    await mkdir(join(home, "proj/.git"), { recursive: true });
    const root = join(home, "proj/packages/app");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "main.ts"), "export {};\n");
    // Plain git skips the empty .git and climbs to the dotfiles repository.
    expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe("dotfiles");

    const detectors = [gitMarkerDetector, (dir: string) => gitParentDetector(dir, { systemDirs: [], homeDir: home })];
    const subject = archiver(server, await tempDir("state"), { detectors });
    expect(await subject.captureBase("ses_empty_git", root)).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(server.calls).toEqual([]);

    // The archive's git, with this folder as the OS home, stops below home: no git block for the folder, nor for
    // proj itself, whose empty .git passes the gate as git_dir.
    const script = `const { readArchiveGit } = await import(${JSON.stringify(join(import.meta.dir, "manifest.ts"))});
      console.log(JSON.stringify(await Promise.all(JSON.parse(process.env.ARCHIVE_GIT_ROOTS).map((dir) => readArchiveGit(dir)))));`;
    const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
      env: { ...process.env, HOME: home, ARCHIVE_GIT_ROOTS: JSON.stringify([root, join(home, "proj")]) },
    });
    expect(JSON.parse(stdout)).toEqual([null, null]);
  });

  test("428 at /archives/key: nothing is packed, archiving stays off until a later captureBase succeeds", async () => {
    const server = new FakeArchiveServer();
    server.gate = { status: 428, detail: "archive_consent_required" };
    const { root } = await project();
    const state = await tempDir("state");
    const subject = archiver(server, state);
    expect(await subject.captureBase("ses_no_consent", root)).toEqual({ status: "skipped", reason: "disabled" });
    expect(await subject.captureDelta("ses_no_consent", root, 1)).toEqual({ status: "skipped", reason: "disabled" });
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "pending"))).toEqual([]);
    expect(server.calls.map((call) => call.path)).toEqual(["archives/key"]);
    server.gate = null;
    expect((await subject.captureBase("ses_consented_now", root)).status).toBe("queued");
  });

  test("428 during a drain drops every queued archive and stops the sessions that lost one", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const subject = archiver(server, state);
    expect((await subject.captureBase("ses_withdrawn", root)).status).toBe("queued");
    server.gate = { status: 428, detail: "archive_consent_required" };
    expect(await subject.drain()).toEqual({ uploaded: 0, pending: 0, dropped: 1, blocked: null, disabled: true });
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "pending"))).toEqual([]);
    server.gate = null;
    await writeFile(join(root, "src/app.ts"), "changed");
    expect(await subject.captureDelta("ses_withdrawn", root, 1)).toEqual({ status: "skipped", reason: "disabled" });
    // A new session re-checks consent and starts over with a new base; the old chain stays stopped.
    expect((await subject.captureBase("ses_after_consent", root)).status).toBe("queued");
    expect(await subject.captureDelta("ses_withdrawn", root, 2)).toEqual({ status: "skipped", reason: "stopped" });
  });

  test("app start resumes queued and half-uploaded archives from the state dir", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const first = archiver(server, state);
    expect((await first.captureBase("ses_resumed_upload", root)).status).toBe("queued");
    let failing = true;
    server.putHook = ({ partNumber }) => (failing && partNumber === 3 ? "network" : undefined);
    const interrupted = await first.drain();
    expect(interrupted).toMatchObject({ uploaded: 0, pending: 1 });
    await first.stop();
    const sentBefore = server.puts.filter((put) => put.status === 200).map((put) => put.partNumber);
    expect(sentBefore).toEqual([1, 2]);

    // Leftovers of a crash: a partial capture and an orphan sealed file.
    const archiveDir = join(state, ARCHIVE_STATE_DIRECTORY);
    await writeFile(join(archiveDir, "tmp", "dead.partial"), "x");
    await writeFile(join(archiveDir, "pending", "orphan.orseal"), "x");

    failing = false;
    server.puts.length = 0;
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    const second = archiver(server, state, { now: () => later });
    expect(await second.drain()).toEqual({ uploaded: 1, pending: 0, dropped: 0, blocked: null, disabled: false });
    expect(server.puts[0]!.partNumber).toBe(3);
    expect(server.puts.some((put) => put.partNumber === 1 || put.partNumber === 2)).toBe(false);
    expect(await readdir(join(archiveDir, "tmp"))).toEqual([]);
    expect(await readdir(join(archiveDir, "pending"))).toEqual([]);
    const members = await openArchive(server.objects()[0]!.object!);
    expect(members.map((member) => member.name)).toContain("src/app.ts");
  });

  test("a capture that crashed before its session commit is discarded at start", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const first = archiver(server, state);
    const base = await first.captureBase("ses_crash_commit", root);
    if (base.status !== "queued") throw new Error("base not queued");
    const queueDir = join(state, ARCHIVE_STATE_DIRECTORY, "queue");
    const record = JSON.parse(await readFile(join(queueDir, `${base.archiveId}.json`), "utf8"));
    const ghostId = "11111111-2222-4333-8444-555555555555";
    await writeFile(join(queueDir, `${ghostId}.json`), JSON.stringify({ ...record, archive_id: ghostId, sealed_file: `${ghostId}.orseal`, request: { ...record.request, archive_id: ghostId, kind: "delta", sequence: 1, turn: 1, parent_archive_id: base.archiveId } }));
    await writeFile(join(state, ARCHIVE_STATE_DIRECTORY, "pending", `${ghostId}.orseal`), "sealed");
    const second = archiver(server, state);
    expect((await second.drain()).uploaded).toBe(1);
    expect(await readdir(queueDir)).toEqual([]);
    expect(server.objects().map((archive) => archive.request.archive_id)).toEqual([base.archiveId]);
  });

  test("a chain-ending conflict stops the session; an unknown kid on a base captures the base again", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const subject = archiver(server, await tempDir("state"));
    expect((await subject.captureBase("ses_conflicted", root)).status).toBe("queued");
    server.apiHook = ({ path }) => (path === "archives" ? new Response(JSON.stringify({ detail: "archive_sequence_conflict" }), { status: 409 }) : undefined);
    expect(await subject.drain()).toMatchObject({ uploaded: 0, dropped: 1, pending: 0 });
    await writeFile(join(root, "src/app.ts"), "changed");
    expect(await subject.captureDelta("ses_conflicted", root, 1)).toEqual({ status: "skipped", reason: "stopped" });

    let rotated = false;
    server.apiHook = ({ path }) => {
      if (path !== "archives" || rotated) return undefined;
      rotated = true;
      return new Response(JSON.stringify({ detail: "archive_kid_unknown" }), { status: 409 });
    };
    const firstBase = await subject.captureBase("ses_rotated_key", root);
    expect(firstBase.status).toBe("queued");
    expect(await subject.drain()).toMatchObject({ uploaded: 0, dropped: 1 });
    const again = await subject.captureDelta("ses_rotated_key", root, 1);
    expect(again).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect(again.status === "queued" && firstBase.status === "queued" && again.archiveId !== firstBase.archiveId).toBe(true);
    expect((await subject.drain()).uploaded).toBe(1);
    expect(server.objects().at(-1)!.request).toMatchObject({ session_id: "ses_rotated_key", kind: "base", turn: 1 });
  });

  test("signOut aborts uploads in flight and removes every queued archive and record", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const subject = archiver(server, state);
    const base = await subject.captureBase("ses_signed_out", root);
    server.putHook = ({ partNumber }) => (partNumber === 2 ? "network" : undefined);
    await subject.drain();
    await subject.signOut();
    expect(server.callPaths()).toContain(`POST archives/${base.status === "queued" ? base.archiveId : ""}/abort 200`);
    const archiveDir = join(state, ARCHIVE_STATE_DIRECTORY);
    await expect(readdir(archiveDir)).rejects.toThrow();
    // After sign-in the archiver starts clean.
    subject.setAccessToken(server.token);
    server.putHook = null;
    expect(await subject.captureDelta("ses_signed_out", root, 1)).toEqual({ status: "skipped", reason: "no_base" });
    expect((await subject.captureBase("ses_signed_back_in", root)).status).toBe("queued");
  });

  test("signOut aborts the part PUT in flight within a second, aborts the upload with the credentials it still holds, and sends nothing more", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const slow = slowPartTwo(server);
    const subject = archiver(server, state, { fetch: slow.fetch });
    const base = await subject.captureBase("ses_slow_sign_out", root);
    const archiveId = base.status === "queued" ? base.archiveId : "";
    const draining = subject.drain();
    await slow.started;

    slow.markCommand();
    await subject.signOut();
    const signOutMs = Date.now() - slow.commandAt;
    expect(slow.puts).toEqual([{ part: 2, bytes: server.partSize, abortedAfterMs: expect.any(Number), completed: false }]);
    expect(slow.puts[0]!.abortedAfterMs!).toBeLessThan(1_000);
    expect(signOutMs).toBeLessThan(1_000);
    expect(await draining).toMatchObject({ uploaded: 0 });
    // The abort went out with a bearer the server still accepted, and nothing completed the archive.
    expect(server.callPaths()).toContain(`POST archives/${archiveId}/abort 200`);
    expect(server.callPaths().filter((path) => path.includes("/complete"))).toEqual([]);
    expect(server.archives.get(archiveId)!.status).toBe("aborted");
    await expect(readdir(join(state, ARCHIVE_STATE_DIRECTORY))).rejects.toThrow();
    await Bun.sleep(50);
    expect(slow.puts).toHaveLength(1);
    expect(server.puts.filter((put) => put.partNumber > 1)).toEqual([]);
  });

  test("stop aborts the part PUT in flight within a second; the job stays queued and the next start resumes it", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const slow = slowPartTwo(server);
    const subject = archiver(server, state, { fetch: slow.fetch });
    const base = await subject.captureBase("ses_slow_stop_0001", root);
    const archiveId = base.status === "queued" ? base.archiveId : "";
    const draining = subject.drain();
    await slow.started;

    slow.markCommand();
    await subject.stop();
    expect(Date.now() - slow.commandAt).toBeLessThan(1_000);
    expect(slow.puts[0]!.abortedAfterMs!).toBeLessThan(1_000);
    await draining;
    // An app quit is not a sign-out: the upload is kept on both sides.
    expect(server.callPaths().filter((path) => path.includes("/abort") || path.includes("/complete"))).toEqual([]);
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "queue"))).toEqual([`${archiveId}.json`]);

    const next = archiver(server, state);
    expect(await next.drain()).toMatchObject({ uploaded: 1, pending: 0 });
    expect(server.objects().map((archive) => archive.request.archive_id)).toEqual([archiveId]);
  });

  test("the app's own state directory under the root is pruned", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = join(root, ".omnirush-state");
    const subject = archiver(server, state);
    expect((await subject.captureBase("ses_state_inside", root)).status).toBe("queued");
    await subject.drain();
    const members = await openArchive(server.objects()[0]!.object!);
    expect(members.some((member) => member.name.startsWith(".omnirush-state"))).toBe(false);
    expect(manifestOf(members).excluded).toMatchObject({ app_state: 1 });
  });
});

describe("SessionArchiver final archives", () => {
  const archiveIdOf = (result: Awaited<ReturnType<SessionArchiver["captureFinal"]>>) => (result.status === "queued" ? result.archiveId : "");

  test("a final archive is a delta that repeats the last turn, says why in its manifest, and chains; nothing when unchanged, none without a base", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const subject = archiver(server, state);
    const id = "ses_final_chain_1";

    expect(await subject.captureFinal(id, "idle")).toEqual({ status: "skipped", reason: "no_base" });
    expect((await subject.captureBase(id, root)).status).toBe("queued");
    // Nothing changed since the base: no archive, no request.
    expect(await subject.captureFinal(id, "idle")).toEqual({ status: "skipped", reason: "unchanged" });
    await writeFile(join(root, "src/app.ts"), "export const app = 2;\n");
    expect(await subject.captureDelta(id, root, 3)).toMatchObject({ status: "queued", sequence: 1 });

    // The user edits after the turn: a final archive for turn 3, then another one.
    await writeFile(join(root, "src/user.ts"), "export const user = 1;\n");
    const idle = await subject.captureFinal(id, "idle");
    expect(idle).toMatchObject({ status: "queued", kind: "delta", sequence: 2 });
    await rm(join(root, "src/user.ts"));
    await writeFile(join(root, "notes.md"), "later\n");
    const quit = await subject.captureFinal(id, "app_quit");
    expect(quit).toMatchObject({ status: "queued", kind: "delta", sequence: 3 });
    // Turn 3 is archived: a delta for it again is stale; the next turn is 4.
    expect(await subject.captureDelta(id, root, 3)).toEqual({ status: "skipped", reason: "stale_turn" });
    await writeFile(join(root, "src/app.ts"), "export const app = 4;\n");
    expect(await subject.captureDelta(id, root, 4)).toMatchObject({ status: "queued", sequence: 4 });
    expect(await subject.drain()).toMatchObject({ uploaded: 5, pending: 0, dropped: 0 });

    const objects = server.objects();
    expect(objects.map((object) => [object.request.kind, object.request.sequence, object.request.turn])).toEqual([["base", 0, 0], ["delta", 1, 3], ["delta", 2, 3], ["delta", 3, 3], ["delta", 4, 4]]);
    for (let index = 1; index < objects.length; index += 1) expect(objects[index]!.request.parent_archive_id).toBe(objects[index - 1]!.request.archive_id);
    const manifests = await Promise.all(objects.map(async (object) => manifestOf(await openArchive(object.object!))));
    expect("trigger" in manifests[0]!).toBe(false);
    expect(manifests.slice(1).map((manifest) => [manifest.turn, manifest.trigger, manifest.reason])).toEqual([[3, "turn", undefined], [3, "final", "idle"], [3, "final", "app_quit"], [4, "turn", undefined]]);
    expect(manifests[2]).toMatchObject({ archive_id: archiveIdOf(idle), sequence: 2, parent_archive_id: objects[1]!.request.archive_id });
    expect((await openArchive(objects[2]!.object!)).map((member) => member.name)).toContain("src/user.ts");
    expect(manifests[3]).toMatchObject({ archive_id: archiveIdOf(quit), deleted: ["src/user.ts"] });

    // The server took a final archive: the chain point kept for a refusal is gone, one baseline is left.
    expect(await subject.captureFinal(id, "idle")).toEqual({ status: "skipped", reason: "unchanged" });
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "baselines"))).toHaveLength(1);
  });

  test("a server without final archives: the refused final is dropped once, the chain goes back, and the turn delta queued behind it is captured again", async () => {
    const server = new FakeArchiveServer();
    server.strictTurns = true;
    const { root } = await project();
    const state = await tempDir("state");
    const logs: Array<{ level: string; message: string }> = [];
    const subject = archiver(server, state, { log: (level, message) => logs.push({ level, message }) });
    const id = "ses_old_backend_1";

    expect((await subject.captureBase(id, root)).status).toBe("queued");
    await writeFile(join(root, "turn1.txt"), "turn 1\n");
    expect((await subject.captureDelta(id, root, 1)).status).toBe("queued");
    expect(await subject.drain()).toMatchObject({ uploaded: 2 });

    // Offline for a while: a final archive, then the next turn's delta chained on it.
    await writeFile(join(root, "user.txt"), "edited after turn 1\n");
    expect(await subject.captureFinal(id, "idle")).toMatchObject({ status: "queued", sequence: 2 });
    await writeFile(join(root, "turn2.txt"), "turn 2\n");
    expect(await subject.captureDelta(id, root, 2)).toMatchObject({ status: "queued", sequence: 3 });
    expect(await subject.drain()).toMatchObject({ uploaded: 0, dropped: 2, blocked: null, disabled: false });

    // Final archives are off until the app restarts (this also waits for the rewind).
    await writeFile(join(root, "user.txt"), "edited again\n");
    expect(await subject.captureFinal(id, "idle")).toEqual({ status: "skipped", reason: "unsupported" });
    expect(await subject.drain()).toMatchObject({ uploaded: 1, pending: 0 });
    const objects = server.objects();
    expect(objects.map((object) => [object.request.sequence, object.request.turn])).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(objects[2]!.request.parent_archive_id).toBe(objects[1]!.request.archive_id);
    const recaptured = await openArchive(objects[2]!.object!);
    expect(manifestOf(recaptured)).toMatchObject({ trigger: "turn", turn: 2, sequence: 2 });
    // Both the final's changes and the turn's are in the delta captured again.
    expect(recaptured.map((member) => member.name)).toEqual(expect.arrayContaining(["user.txt", "turn2.txt"]));

    // Later turns keep uploading on the restored chain.
    await writeFile(join(root, "turn3.txt"), "turn 3\n");
    expect(await subject.captureDelta(id, root, 3)).toMatchObject({ status: "queued", sequence: 3 });
    expect(await subject.drain()).toMatchObject({ uploaded: 1, pending: 0 });
    expect(server.objects().map((object) => object.request.turn)).toEqual([0, 1, 2, 3]);
    // One refused create, no retry loop; logged once, and the session was never stopped.
    expect(server.callPaths().filter((path) => path === "POST archives 409")).toHaveLength(1);
    expect(logs.filter((log) => log.message.includes("does not accept final"))).toHaveLength(1);
    expect(logs.filter((log) => log.level === "warn")).toEqual([]);
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "queue"))).toEqual([]);
  });

  test("shutdown captures final archives within its budget: a slow one is cut at the budget, and the next start checks that folder again", async () => {
    const server = new FakeArchiveServer();
    const fast = await project();
    const slow = await project();
    const state = await tempDir("state");
    // A gate that hangs for the slow folder while `hang` is set (a scan that never ends would do the same).
    let hang = true;
    const detectors = [
      async (root: string, options?: Parameters<typeof gitMarkerDetector>[1]) => {
        if (hang && root === slow.root) await new Promise(() => undefined);
        return gitMarkerDetector(root, options);
      },
      gitParentDetector,
    ];
    const first = archiver(server, state, { detectors });
    // The start-time gate let both in before anything hung.
    hang = false;
    expect((await first.captureBase("ses_quit_fast_01", fast.root)).status).toBe("queued");
    expect((await first.captureBase("ses_quit_slow_01", slow.root)).status).toBe("queued");
    expect(await first.drain()).toMatchObject({ uploaded: 2 });
    hang = true;
    await writeFile(join(fast.root, "after.txt"), "after the last turn\n");
    await writeFile(join(slow.root, "after.txt"), "after the last turn\n");

    const stoppedAt = Date.now();
    await first.stop({ finals: ["ses_quit_fast_01", "ses_quit_slow_01"], budgetMs: 400 });
    const elapsed = Date.now() - stoppedAt;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(1_500);
    // Only the fast folder's final made it into the queue, nothing was uploaded at shutdown.
    const queued = await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "queue"));
    expect(queued).toHaveLength(1);
    expect(server.objects()).toHaveLength(2);

    // The next app start: the slow folder's session still has its final due.
    hang = false;
    const second = archiver(server, state, { detectors });
    expect(await second.startFinalCandidates()).toEqual(expect.arrayContaining(["ses_quit_fast_01", "ses_quit_slow_01"]));
    expect(await second.captureFinal("ses_quit_fast_01", "app_start")).toEqual({ status: "skipped", reason: "unchanged" });
    expect(await second.captureFinal("ses_quit_slow_01", "app_start")).toMatchObject({ status: "queued", sequence: 1 });
    expect(await second.drain()).toMatchObject({ uploaded: 2, pending: 0 });
    const finals = await Promise.all(server.objects().slice(2).map(async (object) => [object.request.session_id, object.request.turn, manifestOf(await openArchive(object.object!)).reason]));
    expect(finals.sort()).toEqual([["ses_quit_fast_01", 0, "app_quit"], ["ses_quit_slow_01", 0, "app_start"]]);
  });

  test("app start: a final for sessions whose folder may have changed while the app was closed; not for deleted, stopped or old ones", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const other = await project();
    const state = await tempDir("state");
    let clock = Date.now() - 8 * 24 * 60 * 60_000;
    const subject = archiver(server, state, { now: () => new Date(clock) });
    // Eight days ago: a chat on the other folder.
    expect((await subject.captureBase("ses_start_old_01", other.root)).status).toBe("queued");
    // Earlier today, two chats on this folder: one ended its day with a turn, the other was archived after its turn.
    clock = Date.now() - 60 * 60_000;
    expect((await subject.captureBase("ses_start_due_01", root)).status).toBe("queued");
    await writeFile(join(root, "due.txt"), "turn\n");
    expect((await subject.captureDelta("ses_start_due_01", root, 1)).status).toBe("queued");
    expect((await subject.captureBase("ses_start_deleted", root)).status).toBe("queued");
    clock = Date.now() - 30 * 60_000;
    expect((await subject.captureBase("ses_start_last_01", root)).status).toBe("queued");
    await writeFile(join(root, "last.txt"), "turn\n");
    expect((await subject.captureDelta("ses_start_last_01", root, 2)).status).toBe("queued");
    await writeFile(join(root, "gone.txt"), "last edit\n");
    expect(await subject.captureFinal("ses_start_last_01", "app_quit")).toMatchObject({ status: "queued" });
    // Deleted in the app: its final, and it is ended.
    expect(await subject.captureFinal("ses_start_deleted", "session_deleted")).toMatchObject({ status: "queued" });
    expect(await subject.drain()).toMatchObject({ pending: 0 });
    await subject.stop();

    // Edited while the app was closed.
    await writeFile(join(root, "closed.txt"), "edited while closed\n");
    clock = Date.now();
    const next = archiver(server, state, { now: () => new Date(clock) });
    // The most recent session on the folder, and the one whose final never came; newest first.
    expect(await next.startFinalCandidates()).toEqual(["ses_start_last_01", "ses_start_due_01"]);
    const last = await next.captureFinal("ses_start_last_01", "app_start");
    expect(last).toMatchObject({ status: "queued", kind: "delta", sequence: 3 });
    expect(await next.drain()).toMatchObject({ uploaded: 1 });
    const object = server.objects().find((candidate) => candidate.request.archive_id === archiveIdOf(last))!;
    expect(object.request).toMatchObject({ session_id: "ses_start_last_01", kind: "delta", sequence: 3, turn: 2 });
    const members = await openArchive(object.object!);
    expect(manifestOf(members)).toMatchObject({ trigger: "final", reason: "app_start", turn: 2 });
    expect(members.map((member) => member.name)).toContain("closed.txt");
    // Its final settles the session whose last turn had none; the folder's most recent archive is now that one.
    clock += 1_000;
    expect(await next.captureFinal("ses_start_due_01", "app_start")).toMatchObject({ status: "queued", sequence: 2 });
    expect(await next.startFinalCandidates()).toEqual(["ses_start_due_01"]);
  });

  test("a session deleted with its folder gone gets no final, and is not checked at the next start", async () => {
    const server = new FakeArchiveServer();
    const { root } = await project();
    const state = await tempDir("state");
    const subject = archiver(server, state);
    expect((await subject.captureBase("ses_deleted_gone", root)).status).toBe("queued");
    await subject.drain();
    await rm(root, { recursive: true, force: true });
    expect(await subject.captureFinal("ses_deleted_gone", "session_deleted")).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(await subject.startFinalCandidates()).toEqual([]);
    expect(server.objects()).toHaveLength(1);
  });
});
