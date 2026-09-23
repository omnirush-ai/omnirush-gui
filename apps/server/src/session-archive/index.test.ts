import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { gitMarkerDetector, gitParentDetector } from "./detect.js";
import { FakeArchiveServer, slowPartTwo } from "./fake-archive-server.js";
import { ARCHIVE_STATE_DIRECTORY, POLICY_TTL_MS, SessionArchiver, type SessionArchiverOptions } from "./index.js";
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

  test("a folder without .git is not archived while the all-folders policy is off or absent; only the key is read", async () => {
    for (const policy of [undefined, { all_folders: false }, { all_folders: "true" }]) {
      const server = new FakeArchiveServer();
      server.policy = policy;
      const home = await tempDir("home");
      const root = join(home, "plain");
      await mkdir(root);
      await writeFile(join(root, "notes.md"), "hello");
      const state = await tempDir("state");
      const subject = archiver(server, state, { folderGate: { homeDir: home } });
      expect(await subject.captureBase("ses_plain_folder", root)).toEqual({ status: "skipped", reason: "not_archivable" });
      expect(await subject.captureDelta("ses_plain_folder", root, 1)).toEqual({ status: "skipped", reason: "no_base" });
      expect(server.callPaths()).toEqual(["GET archives/key 200"]);
      expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "sessions"))).toEqual([]);
    }
  });

  test("with the all-folders policy on, home itself, the app's userData dir and a system directory are refused and nothing is sent", async () => {
    const server = new FakeArchiveServer();
    server.policy = { all_folders: true };
    const home = await tempDir("home");
    const userData = join(home, "Library/Application Support/OmniRush.ai");
    await mkdir(userData, { recursive: true });
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: home, userDataDir: userData } });
    for (const root of [home, userData, join(home, "Library"), "/usr"]) {
      expect({ root, result: await subject.captureBase("ses_refused_folder", root) }).toEqual({ root, result: { status: "skipped", reason: "not_archivable" } });
    }
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
    // At most the all-folders policy is asked (it is off); nothing is created.
    expect(server.calls.filter((call) => call.path !== "archives/key")).toEqual([]);

    // The archive's git, with this folder as the OS home, stops below home: no git block for the folder, nor for
    // proj itself, whose empty .git passes the gate as git_dir.
    const script = `const { readArchiveGit } = await import(${JSON.stringify(join(import.meta.dir, "manifest.ts"))});
      console.log(JSON.stringify(await Promise.all(JSON.parse(process.env.ARCHIVE_GIT_ROOTS).map((dir) => readArchiveGit(dir)))));`;
    const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
      env: { ...process.env, HOME: home, ARCHIVE_GIT_ROOTS: JSON.stringify([root, join(home, "proj")]) },
    });
    expect(JSON.parse(stdout)).toEqual([null, null]);
  });

  test("with the all-folders policy on, a folder without .git is archived whole: binaries and ignored-looking files kept, credentials left out", async () => {
    const server = new FakeArchiveServer();
    server.policy = { all_folders: true };
    const home = await tempDir("home");
    const root = join(home, "render-job");
    await mkdir(join(root, "node_modules/left-pad"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n*.blend1\n");
    await writeFile(join(root, "node_modules/left-pad/index.js"), "module.exports = (s) => s;\n");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/bundle.js"), "console.log(1);\n");
    await mkdir(join(root, "assets"));
    const blend = randomBytes(300 * 1024);
    await writeFile(join(root, "assets/scene.blend"), blend);
    const backup = randomBytes(64 * 1024);
    await writeFile(join(root, "assets/scene.blend1"), backup);
    await writeFile(join(root, ".env"), "API_KEY=sk-live-1234567890\n");
    await writeFile(join(root, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: home } });

    const base = await subject.captureBase("ses_plain_folder", root);
    expect(base).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect((await subject.drain()).uploaded).toBe(1);
    // One key read serves the policy and the seal.
    expect(server.callPaths()[0]).toBe("GET archives/key 200");
    expect(server.calls.filter((call) => call.path === "archives/key")).toHaveLength(1);
    const [first] = server.objects();
    expect(first!.request).toMatchObject({ session_id: "ses_plain_folder", kind: "base", sequence: 0, marker: "folder" });
    const members = await openArchive(first!.object!);
    const names = members.map((member) => member.name);
    expect(names).toEqual(expect.arrayContaining([".gitignore", "node_modules/left-pad/index.js", "dist/bundle.js", "assets/scene.blend", "assets/scene.blend1"]));
    expect(names).not.toContain(".env");
    expect(names).not.toContain("id_rsa");
    expect(members.find((member) => member.name === "assets/scene.blend")!.content.equals(blend)).toBe(true);
    expect(members.find((member) => member.name === "assets/scene.blend1")!.content.equals(backup)).toBe(true);
    expect(manifestOf(members)).toMatchObject({ kind: "base", workspace: { label: "render-job", marker: "folder", git: null }, excluded: { credential: 2 } });

    const edited = randomBytes(1024);
    await writeFile(join(root, "assets/scene.blend"), edited);
    expect(await subject.captureDelta("ses_plain_folder", root, 1)).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    expect((await subject.drain()).uploaded).toBe(1);
    const second = server.objects()[1]!;
    expect(second.request).toMatchObject({ kind: "delta", sequence: 1, marker: "folder", parent_archive_id: first!.request.archive_id });
    const changed = (await openArchive(second.object!)).slice(1);
    expect(changed.map((member) => member.name)).toEqual(["assets/scene.blend"]);
    expect(changed[0]!.content.equals(edited)).toBe(true);
  });

  test("with the all-folders policy on, a git project is still archived as git", async () => {
    const server = new FakeArchiveServer();
    server.policy = { all_folders: true };
    const { root } = await project();
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: await tempDir("home") } });
    expect(await subject.captureBase("ses_git_first", root)).toMatchObject({ status: "queued", kind: "base" });
    await subject.drain();
    expect(server.objects()[0]!.request.marker).toBe(".git");
    expect(manifestOf(await openArchive(server.objects()[0]!.object!))).toMatchObject({ workspace: { marker: ".git" } });
    expect(server.calls.filter((call) => call.path === "archives/key")).toHaveLength(1);
  });

  test("with the all-folders policy on, a session started in a credential or app-data folder is refused and nothing is sent", async () => {
    const server = new FakeArchiveServer();
    server.policy = { all_folders: true };
    const home = await tempDir("home");
    const files: Record<string, string> = {
      ".gnupg/secring.gpg": "old-style secret keyring",
      ".gnupg/pubring.kbx": "keybox",
      ".aws/config": "[default]\nregion = us-east-1\n",
      ".aws/sso/cache/abc.json": "{\"accessToken\":\"aoa-sso-token\"}",
      ".docker/config.json": "{\"auths\":{\"ghcr.io\":{\"auth\":\"dXNlcjpwYXNz\"}}}",
      ".ssh/config": "Host *\n",
      ".ssh/known_hosts": "github.com ssh-ed25519 AAAA\n",
      ".kube/config": "apiVersion: v1\n",
      ".config/gh/hosts.yml": "github.com:\n  oauth_token: gho_x\n",
      ".config/gcloud/credentials.db": "sqlite",
      ".local/share/keyrings/login.keyring": "keyring",
      ".password-store/bank.gpg": "gpg",
      "Library/Keychains/login.keychain-db": "keychain",
      "Library/Application Support/Google/Chrome/Default/Cookies": "cookies",
      "AppData/Roaming/gcloud/access_tokens.db": "tokens",
      "work/secrets/prod.txt": "prod",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(home, path, ".."), { recursive: true });
      await writeFile(join(home, path), content);
    }
    const state = await tempDir("state");
    const subject = archiver(server, state, { folderGate: { homeDir: home } });
    const roots = [...new Set(Object.keys(files).map((path) => join(home, path, "..")))];
    roots.push(join(home, ".aws"), join(home, ".config"), join(home, ".local"), join(home, "Library"), join(home, "AppData"));
    for (const [index, root] of roots.entries()) {
      expect({ root, result: await subject.captureBase(`ses_credential_${index}`, root) }).toEqual({ root, result: { status: "skipped", reason: "not_archivable" } });
    }
    expect(server.calls).toEqual([]);
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "sessions"))).toEqual([]);
  });

  test("with the policy off and the API failing, a folder session costs one GET with no backoff and no refresh, and does not change archiving", async () => {
    const failures: Array<[string, Response | "network"]> = [
      ["502", new Response("bad gateway", { status: 502 })],
      ["401", Response.json({ detail: "invalid_token" }, { status: 401 })],
      ["428", Response.json({ detail: "archive_consent_required" }, { status: 428 })],
      ["503 archive_disabled", Response.json({ detail: "archive_disabled" }, { status: 503 })],
      ["network", "network"],
    ];
    for (const [name, failure] of failures) {
      const server = new FakeArchiveServer();
      let keyAttempts = 0;
      server.apiHook = ({ path }) => {
        if (path !== "archives/key") return undefined;
        keyAttempts += 1;
        return failure === "network" ? "network" : failure.clone();
      };
      const home = await tempDir("home");
      for (const dir of ["notes", "drafts", "scratch"]) await mkdir(join(home, dir));
      const sleeps: number[] = [];
      const refreshes: string[] = [];
      const state = await tempDir("state");
      const subject = archiver(server, state, {
        folderGate: { homeDir: home },
        retry: { baseMs: 1_000, maxMs: 300_000, attempts: 8, sleep: async (ms) => void sleeps.push(ms) },
        refreshAccessToken: async () => (refreshes.push("refresh"), server.token),
      });
      const started = Date.now();
      for (const dir of ["notes", "drafts", "scratch"]) {
        expect({ name, result: await subject.captureBase(`ses_${dir}_folder`, join(home, dir)) }).toEqual({ name, result: { status: "skipped", reason: "not_archivable" } });
      }
      expect(Date.now() - started).toBeLessThan(2_000);
      // One probe for the burst, kept as off; nothing slept, refreshed, written or switched off.
      expect({ name, keyAttempts, sleeps, refreshes }).toEqual({ name, keyAttempts: 1, sleeps: [], refreshes: [] });
      expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "sessions"))).toEqual([]);
      expect((await subject.pendingStatus()).disabled).toBeNull();
      // A git session right after is exactly as without the policy: its own full key fetch.
      server.apiHook = null;
      const { root } = await project();
      expect(await subject.captureBase("ses_git_after", root)).toMatchObject({ status: "queued", kind: "base" });
      expect(server.callPaths().filter((call) => call.endsWith(" 200"))).toEqual(["GET archives/key 200"]);
    }
  });

  test("the policy answer is kept with the key for POLICY_TTL_MS: one probe per burst, and a change on omnirush.ai is seen after it", async () => {
    const server = new FakeArchiveServer();
    let clock = Date.parse("2026-09-24T10:00:00Z");
    const home = await tempDir("home");
    const folders = ["a", "b", "c", "d", "e", "f", "g"];
    for (const dir of folders) {
      await mkdir(join(home, dir));
      await writeFile(join(home, dir, "notes.md"), `${dir}\n`);
    }
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: home }, now: () => new Date(clock) });
    const keyReads = () => server.calls.filter((call) => call.path === "archives/key").length;
    const creates = () => server.calls.filter((call) => call.method === "POST" && call.path === "archives").length;

    // Off: a burst of folder sessions sends one probe.
    for (const dir of ["a", "b"]) expect(await subject.captureBase(`ses_ttl_${dir}_folder`, join(home, dir))).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(keyReads()).toBe(1);
    // Turned on for this user: not seen until the kept answer is POLICY_TTL_MS old.
    server.policy = { all_folders: true };
    clock += POLICY_TTL_MS - 1;
    expect(await subject.captureBase("ses_ttl_c_folder", join(home, "c"))).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(keyReads()).toBe(1);
    clock += 1;
    expect(await subject.captureBase("ses_ttl_d_folder", join(home, "d"))).toMatchObject({ status: "queued", kind: "base" });
    // The probe's key served the base.
    expect(keyReads()).toBe(2);
    // On and kept: the next folder base checks consent with a full key fetch, like a git base.
    clock += 60_000;
    expect(await subject.captureBase("ses_ttl_e_folder", join(home, "e"))).toMatchObject({ status: "queued", kind: "base" });
    expect(keyReads()).toBe(3);
    await subject.drain();
    expect(server.objects().map((archive) => archive.request.marker)).toEqual(["folder", "folder"]);

    // Turned off again: that full fetch sees it, the folder is not archived, and the answer is kept as off.
    server.policy = { all_folders: false };
    expect(await subject.captureBase("ses_ttl_f_folder", join(home, "f"))).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(await subject.captureBase("ses_ttl_g_folder", join(home, "g"))).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(keyReads()).toBe(4);
    // A folder session's deltas pause while it is off, and catch up once it is on again.
    await writeFile(join(home, "d", "notes.md"), "d, edited\n");
    const createsBefore = creates();
    expect(await subject.captureDelta("ses_ttl_d_folder", join(home, "d"), 1)).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(creates()).toBe(createsBefore);
    server.policy = { all_folders: true };
    clock += POLICY_TTL_MS;
    expect(await subject.captureDelta("ses_ttl_d_folder", join(home, "d"), 2)).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    expect(keyReads()).toBe(5);

    // Sign-out forgets the answer: the next account's first folder session asks again.
    await subject.signOut();
    subject.setAccessToken(server.token);
    expect(await subject.captureBase("ses_ttl_g_folder", join(home, "g"))).toMatchObject({ status: "queued", kind: "base" });
    expect(keyReads()).toBe(6);
  });

  test("a folder inside a larger git repository is archived as a plain folder: marker folder and workspace.git null", async () => {
    const server = new FakeArchiveServer();
    server.policy = { all_folders: true };
    const home = await tempDir("home");
    const repo = join(home, "dotfiles");
    await mkdir(join(repo, "work/proj"), { recursive: true });
    await git(repo, "init", "-q", "-b", "dotfiles");
    await git(repo, "remote", "add", "origin", "https://github.com/me/dotfiles.git");
    await writeFile(join(repo, "work/proj/plan.md"), "# plan\n");
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: home } });
    expect(await subject.captureBase("ses_nested_folder", join(repo, "work/proj"))).toMatchObject({ status: "queued", kind: "base" });
    await writeFile(join(repo, "work/proj/plan.md"), "# plan, edited\n");
    expect(await subject.captureDelta("ses_nested_folder", join(repo, "work/proj"), 1)).toMatchObject({ status: "queued", kind: "delta" });
    await subject.drain();
    const [base, delta] = server.objects();
    expect(base!.request.marker).toBe("folder");
    expect(delta!.request.marker).toBe("folder");
    expect(manifestOf(await openArchive(base!.object!))).toMatchObject({ workspace: { label: "proj", marker: "folder", git: null } });
    expect(manifestOf(await openArchive(delta!.object!))).toMatchObject({ workspace: { marker: "folder", git: null } });
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

  test("a plain folder's final archives pass the all-folders refusals and policy again: one while it is on, none while it is off", async () => {
    const server = new FakeArchiveServer();
    server.policy = { all_folders: true };
    const home = await tempDir("home");
    const root = join(home, "drafts");
    await mkdir(root);
    await writeFile(join(root, "chapter.md"), "one\n");
    let now = Date.parse("2026-09-23T10:00:00Z");
    const subject = archiver(server, await tempDir("state"), { folderGate: { homeDir: home }, now: () => new Date(now) });
    expect(await subject.captureBase("ses_folder_final", root, 1)).toMatchObject({ status: "queued", kind: "base" });
    await writeFile(join(root, "chapter.md"), "two\n");
    expect(await subject.captureFinal("ses_folder_final", "idle")).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    await subject.drain();
    expect(server.objects().map((object) => [object.request.marker, object.request.turn])).toEqual([["folder", 1], ["folder", 1]]);
    expect(manifestOf(await openArchive(server.objects()[1]!.object!))).toMatchObject({ trigger: "final", reason: "idle", workspace: { marker: "folder", git: null } });

    server.policy = { all_folders: false };
    now += POLICY_TTL_MS;
    await writeFile(join(root, "chapter.md"), "three\n");
    expect(await subject.captureFinal("ses_folder_final", "app_quit")).toEqual({ status: "skipped", reason: "not_archivable" });
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

describe("SessionArchiver touched files", () => {
  const TOUCHED_ON = { touched_files: true };

  /** A folder without .git in a home folder of its own, and the archiver whose folder gate knows that home. */
  async function touchedSetup(options: Partial<SessionArchiverOptions> & { policy?: unknown } = {}) {
    const server = new FakeArchiveServer();
    server.policy = "policy" in options ? options.policy : TOUCHED_ON;
    const home = await tempDir("home");
    const root = join(home, "report");
    await mkdir(root);
    const state = options.stateDir ?? (await tempDir("state"));
    const logs: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> = [];
    const make = (extra: Partial<SessionArchiverOptions> = {}) => archiver(server, state, {
      folderGate: { homeDir: home },
      touchedFlushMs: 5,
      log: (level, message, attributes) => logs.push({ level, message, ...(attributes ? { attributes } : {}) }),
      ...options,
      ...extra,
    });
    return { server, home, root, state, logs, make, subject: make() };
  }

  const names = async (object: { object: Buffer | null }) => (await openArchive(object.object!)).map((member) => member.name);

  test("a folder without .git: only the files the agent touched, byte for byte; untouched files, credentials and links out of the folder never", async () => {
    const { server, root, subject } = await touchedSetup();
    const outside = await tempDir("outside");
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_MARKER");
    const brief = randomBytes(200 * 1024);
    await writeFile(join(root, "brief.pdf"), brief);
    await writeFile(join(root, "notes.txt"), "never touched\n");
    await writeFile(join(root, ".env"), "API_KEY=sk-live-1234567890\n");
    await symlink(join(outside, "secret.txt"), join(root, "link-out"));
    const id = "ses_touched_files";

    // Session start registers the session; nothing is packed yet.
    expect(await subject.captureBase(id, root)).toEqual({ status: "skipped", reason: "unchanged" });
    expect(server.callPaths()).toEqual(["GET archives/key 200"]);
    // The agent reads the PDF, writes a binary, and names a credential file and a link out of the folder.
    subject.recordTouched(id, "brief.pdf");
    const render = randomBytes(300 * 1024);
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out/render.png"), render);
    subject.recordTouched(id, "out/render.png");
    subject.recordTouched(id, "out");
    subject.recordTouched(id, ".env");
    subject.recordTouched(id, "link-out");

    expect(await subject.captureDelta(id, root, 1)).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect((await subject.drain()).uploaded).toBe(1);
    const [base] = server.objects();
    expect(base!.request).toMatchObject({ session_id: id, kind: "base", sequence: 0, turn: 1, parent_archive_id: null, marker: "touched" });
    const members = await openArchive(base!.object!);
    expect(members.map((member) => member.name)).toEqual(["__omnirush__/manifest.json", "brief.pdf", "out/render.png"]);
    expect(members[1]!.content.equals(brief)).toBe(true);
    expect(members[2]!.content.equals(render)).toBe(true);
    const manifest = manifestOf(members);
    expect(manifest).toMatchObject({ kind: "base", turn: 1, scope: "touched", workspace: { label: "report", marker: "touched", git: null }, excluded: { credential: 1, special: 1 } });
    expect(manifest.files).toEqual([
      { path: "brief.pdf", type: "file", mode: expect.any(Number), size: brief.length, sha256: sha256(brief) },
      { path: "out/render.png", type: "file", mode: expect.any(Number), size: render.length, sha256: sha256(render) },
    ]);
    expect("deleted" in manifest).toBe(false);

    // The next turn: the binary is rewritten, the PDF deleted, a new file created; notes.txt is still untouched.
    const rerender = randomBytes(1024);
    await writeFile(join(root, "out/render.png"), rerender);
    await rm(join(root, "brief.pdf"));
    await writeFile(join(root, "summary.md"), "# summary\n");
    subject.recordTouched(id, "summary.md");
    subject.recordTouched(id, "brief.pdf");
    expect(await subject.captureDelta(id, root, 2)).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    expect((await subject.drain()).uploaded).toBe(1);
    const delta = server.objects()[1]!;
    expect(delta.request).toMatchObject({ kind: "delta", sequence: 1, turn: 2, marker: "touched", parent_archive_id: base!.request.archive_id });
    const deltaMembers = await openArchive(delta.object!);
    expect(deltaMembers.slice(1).map((member) => member.name)).toEqual(["out/render.png", "summary.md"]);
    expect(deltaMembers[1]!.content.equals(rerender)).toBe(true);
    expect(manifestOf(deltaMembers)).toMatchObject({ kind: "delta", trigger: "turn", scope: "touched", deleted: ["brief.pdf"] });

    // Nothing touched changed: nothing is sent, even though an untouched file did.
    await writeFile(join(root, "notes.txt"), "edited by the user, never touched by the agent\n");
    expect(await subject.captureDelta(id, root, 3)).toEqual({ status: "skipped", reason: "unchanged" });
    for (const object of server.objects()) {
      expect(await names(object)).not.toContain("notes.txt");
      expect(object.object!.includes(Buffer.from("OUTSIDE_MARKER"))).toBe(false);
    }
  });

  test("a git folder is archived as today with touched_files on, and keeps no touched paths", async () => {
    const { server, state, make } = await touchedSetup();
    const { root } = await project();
    const subject = make();
    expect(await subject.captureBase("ses_git_touched", root)).toMatchObject({ status: "queued", kind: "base" });
    subject.recordTouched("ses_git_touched", "src/app.ts");
    await subject.drain();
    expect(server.objects()[0]!.request.marker).toBe(".git");
    expect(await names(server.objects()[0]!)).toEqual(expect.arrayContaining([".git/HEAD", "assets/scene.blend", "src/app.ts"]));
    expect(manifestOf(await openArchive(server.objects()[0]!.object!))).not.toHaveProperty("scope");
    await subject.stop();
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "touched"))).toEqual([]);
  });

  test("all_folders wins over touched_files: the whole folder", async () => {
    const { server, root, subject } = await touchedSetup({ policy: { all_folders: true, touched_files: true } });
    await writeFile(join(root, "a.txt"), "a\n");
    expect(await subject.captureBase("ses_all_and_touched", root)).toMatchObject({ status: "queued", kind: "base" });
    await subject.drain();
    expect(server.objects()[0]!.request.marker).toBe("folder");
  });

  test("with the policy off or absent nothing is uploaded or kept, and the refused folders never are with it on", async () => {
    for (const policy of [undefined, { touched_files: false }, { touched_files: "true" }, { all_folders: false }]) {
      const { server, root, state, subject } = await touchedSetup({ policy });
      await writeFile(join(root, "brief.pdf"), randomBytes(1024));
      expect(await subject.captureBase("ses_touched_off", root)).toEqual({ status: "skipped", reason: "not_archivable" });
      subject.recordTouched("ses_touched_off", "brief.pdf");
      expect(await subject.captureDelta("ses_touched_off", root, 1)).toEqual({ status: "skipped", reason: "no_base" });
      expect(await subject.captureFinal("ses_touched_off", "app_quit")).toEqual({ status: "skipped", reason: "no_base" });
      await subject.stop();
      expect(server.callPaths()).toEqual(["GET archives/key 200"]);
      expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "sessions"))).toEqual([]);
      expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "touched"))).toEqual([]);
    }

    // The folder refusals: home, a credential folder, the userData dir, a system folder, and a folder inside the app's own state.
    const { server, home, state, make } = await touchedSetup();
    const userData = join(home, "work/OmniRush.ai");
    for (const dir of [".ssh", "work/OmniRush.ai/workdir", "Library/Application Support/x"]) await mkdir(join(home, dir), { recursive: true });
    const subject = make({ folderGate: { homeDir: home, userDataDir: userData } });
    for (const root of [home, join(home, ".ssh"), userData, join(userData, "workdir"), join(home, "Library/Application Support/x"), "/usr/share", join(state, ARCHIVE_STATE_DIRECTORY)]) {
      expect({ root, result: await subject.captureBase("ses_touched_refused", root) }).toEqual({ root, result: { status: "skipped", reason: "not_archivable" } });
    }
    expect(server.calls).toEqual([]);
  });

  test("finals and app start for touched chains, and the chain and its touched paths survive a restart", async () => {
    let now = Date.parse("2026-09-23T10:00:00Z");
    const { server, root, state, make } = await touchedSetup({ now: () => new Date(now) });
    const first = make();
    const id = "ses_touched_final";
    const unbased = "ses_touched_nobase";
    expect(await first.captureBase(id, root, 4)).toEqual({ status: "skipped", reason: "unchanged" });
    // A final archive with nothing touched yet: nothing, and still no base.
    expect(await first.captureFinal(id, "idle")).toEqual({ status: "skipped", reason: "unchanged" });
    await writeFile(join(root, "draft.md"), "draft one\n");
    first.recordTouched(id, "draft.md");
    // The idle final is the first capture with a touched file: the base, numbered with the turns seen.
    expect(await first.captureFinal(id, "idle")).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    await writeFile(join(root, "chart.svg"), "<svg/>\n");
    first.recordTouched(id, "chart.svg");
    expect(await first.captureFinal(id, "app_quit")).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    // Another session on the folder touches a file, and the app quits before any capture of it.
    now += 1_000;
    expect(await first.captureBase(unbased, root, 0)).toEqual({ status: "skipped", reason: "unchanged" });
    await writeFile(join(root, "table.csv"), "a,b\n");
    first.recordTouched(unbased, "table.csv");
    await first.stop();

    // Edited while the app was closed.
    await writeFile(join(root, "draft.md"), "draft two, while the app was closed\n");
    now += 60_000;
    const second = make();
    expect(await second.startFinalCandidates()).toEqual([unbased, id]);
    expect(await second.captureFinal(unbased, "app_start")).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect(await second.captureFinal(id, "app_start")).toMatchObject({ status: "queued", kind: "delta", sequence: 2 });
    // The touched paths from before the restart still count: the next turn's edit of draft.md goes out.
    await writeFile(join(root, "draft.md"), "draft three\n");
    expect(await second.captureDelta(id, root, 5)).toMatchObject({ status: "queued", kind: "delta", sequence: 3 });
    expect((await second.drain()).uploaded).toBe(5);

    const chain = server.objects().filter((object) => object.request.session_id === id);
    expect(chain.map((object) => [object.request.kind, object.request.sequence, object.request.turn, object.request.marker])).toEqual([
      ["base", 0, 4, "touched"], ["delta", 1, 4, "touched"], ["delta", 2, 4, "touched"], ["delta", 3, 5, "touched"],
    ]);
    const manifests = await Promise.all(chain.map(async (object) => manifestOf(await openArchive(object.object!))));
    expect(manifests.map((manifest) => [manifest.trigger, manifest.reason, manifest.scope])).toEqual([
      [undefined, undefined, "touched"], ["final", "app_quit", "touched"], ["final", "app_start", "touched"], ["turn", undefined, "touched"],
    ]);
    expect(await Promise.all(chain.map(names))).toEqual([
      ["__omnirush__/manifest.json", "draft.md"], ["__omnirush__/manifest.json", "chart.svg"], ["__omnirush__/manifest.json", "draft.md"], ["__omnirush__/manifest.json", "draft.md"],
    ]);
    const other = server.objects().find((object) => object.request.session_id === unbased)!;
    expect(other.request).toMatchObject({ kind: "base", turn: 0, marker: "touched" });
    expect(await names(other)).toEqual(["__omnirush__/manifest.json", "table.csv"]);

    // Deleted in the app: its final, then its touched paths are gone.
    await writeFile(join(root, "table.csv"), "a,b\n1,2\n");
    expect(await second.captureFinal(unbased, "session_deleted")).toMatchObject({ status: "queued", kind: "delta" });
    expect((await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "touched"))).length).toBe(1);
  });

  test("a restart whose key probe fails keeps a touched chain without a base and its paths: it catches up once the policy answers", async () => {
    let now = Date.parse("2026-09-23T10:00:00Z");
    const { server, root, state, make } = await touchedSetup({ now: () => new Date(now) });
    const first = make();
    const id = "ses_touched_offline";
    expect(await first.captureBase(id, root, 0)).toEqual({ status: "skipped", reason: "unchanged" });
    await writeFile(join(root, "draft.md"), "draft\n");
    first.recordTouched(id, "draft.md");
    await first.stop();

    // The next start is offline: GET archives/key fails.
    server.apiHook = ({ path }) => (path === "archives/key" ? "network" : undefined);
    now += 60_000;
    const second = make();
    expect(await second.startFinalCandidates()).toEqual([id]);
    expect((await second.captureFinal(id, "app_start")).status).toBe("skipped");
    // The session is resumed: its registration asks nothing again and drops nothing, and what it touches now is kept too.
    const calls = server.calls.length;
    expect(await second.captureBase(id, root, 1)).toEqual({ status: "skipped", reason: "unchanged" });
    expect(server.calls.length).toBe(calls);
    await writeFile(join(root, "chart.svg"), "<svg/>\n");
    second.recordTouched(id, "chart.svg");
    expect(await second.captureDelta(id, root, 2)).toEqual({ status: "skipped", reason: "not_archivable" });
    await second.stop();
    expect(await readdir(join(state, ARCHIVE_STATE_DIRECTORY, "touched"))).toHaveLength(1);

    // Online again, and the kept answer is old: the base carries every path from both runs, numbered with the turns seen.
    server.apiHook = null;
    now += POLICY_TTL_MS;
    const third = make();
    expect(await third.captureFinal(id, "idle")).toMatchObject({ status: "queued", kind: "base", sequence: 0 });
    expect((await third.drain()).uploaded).toBe(1);
    const [base] = server.objects();
    expect(base!.request).toMatchObject({ session_id: id, kind: "base", turn: 1, marker: "touched" });
    expect(await names(base!)).toEqual(["__omnirush__/manifest.json", "chart.svg", "draft.md"]);
  });

  test("a touched chain pauses while its policy is off and catches up once it is on again", async () => {
    let now = Date.parse("2026-09-23T10:00:00Z");
    const { server, root, subject } = await touchedSetup({ now: () => new Date(now) });
    const id = "ses_touched_pause";
    await subject.captureBase(id, root, 0);
    await writeFile(join(root, "a.bin"), randomBytes(512));
    subject.recordTouched(id, "a.bin");
    expect(await subject.captureDelta(id, root, 1)).toMatchObject({ status: "queued", kind: "base" });
    server.policy = { touched_files: false };
    now += POLICY_TTL_MS;
    await writeFile(join(root, "a.bin"), randomBytes(512));
    expect(await subject.captureDelta(id, root, 2)).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(await subject.captureFinal(id, "idle")).toEqual({ status: "skipped", reason: "not_archivable" });
    server.policy = TOUCHED_ON;
    now += POLICY_TTL_MS;
    expect(await subject.captureDelta(id, root, 3)).toMatchObject({ status: "queued", kind: "delta", sequence: 1 });
    expect((await subject.drain()).uploaded).toBe(2);
  });

  test("422 archive_marker_not_allowed drops the session's chain once, with no retry, and no other touched chain starts until the policy is asked again", async () => {
    let now = Date.parse("2026-09-23T10:00:00Z");
    const { server, root, logs, subject } = await touchedSetup({ now: () => new Date(now) });
    const id = "ses_touched_refuse";
    await subject.captureBase(id, root, 0);
    await writeFile(join(root, "a.bin"), randomBytes(512));
    subject.recordTouched(id, "a.bin");
    expect(await subject.captureDelta(id, root, 1)).toMatchObject({ status: "queued", kind: "base" });
    await writeFile(join(root, "a.bin"), randomBytes(512));
    expect(await subject.captureDelta(id, root, 2)).toMatchObject({ status: "queued", kind: "delta" });
    // The server turned the policy off after the key was read: it refuses the create.
    server.policy = { touched_files: false };
    expect(await subject.drain()).toMatchObject({ uploaded: 0, dropped: 2, pending: 0 });
    expect(server.calls.filter((call) => call.method === "POST")).toEqual([expect.objectContaining({ path: "archives", status: 422 })]);
    expect(logs.filter((log) => log.message === "OmniRush archiving stopped for a session")).toEqual([
      { level: "warn", message: "OmniRush archiving stopped for a session", attributes: { sessionId: id, code: "archive_marker_not_allowed", droppedJobs: 2 } },
    ]);
    await writeFile(join(root, "a.bin"), randomBytes(512));
    expect(await subject.captureDelta(id, root, 3)).toEqual({ status: "skipped", reason: "stopped" });
    expect(await subject.drain()).toMatchObject({ uploaded: 0, dropped: 0, pending: 0 });
    // The kept policy is off for touched files now: another folder session is not archivable, without a request.
    const calls = server.calls.length;
    expect(await subject.captureBase("ses_touched_other", root, 0)).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(server.calls.length).toBe(calls);
    now += POLICY_TTL_MS;
    expect(await subject.captureBase("ses_touched_later", root, 0)).toEqual({ status: "skipped", reason: "not_archivable" });
    expect(server.callPaths().at(-1)).toBe("GET archives/key 200");
  });
});
