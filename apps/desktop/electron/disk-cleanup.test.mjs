import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cleanupDue, cleanupPass, installerVersion, LOCK_FILE, MARKER_FILE, PACKAGES_FILE, rememberDownloadedPackage, runAutomatic, scheduleDiskCleanup, updaterCacheDirName } from "./disk-cleanup/index.mjs";
import { acquireLock, versionsToRemove } from "./disk-cleanup/retention.mjs";

const DAY = 86_400_000;
const MB = 1024 * 1024;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-clean-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { userData: path.join(root, "userData"), logs: path.join(root, "userData", "logs"), temp: path.join(root, "tmp"), updaterCache: path.join(root, "cache", "omnirush-updater") };
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  return { root, paths };
}

function write(file, bytes = 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  return file;
}

function age(p, ms) {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(p, at, at);
}

/** What the cleanup must never touch. */
function userData(paths) {
  const files = [
    "app-recovery-cache/OmniRush-Setup-3.6.3.exe", "app-recovery-cache/metadata.json", "app-recovery.v1.json",
    "engine-data/omnirush/opencode.db", "Partitions/omnirush-browser/Cookies", "IndexedDB/x/1.ldb", "Local Storage/leveldb/1.log",
    "start-reset-20261001/settings.json", "logs/omnirush-server.log", "start-reports.json",
  ].map((rel) => write(path.join(paths.userData, rel)));
  for (const f of files) age(f, 400 * DAY);
  return files;
}

test("the shared retention module is the CLI's (PARITY.sha256)", () => {
  const dir = path.join(HERE, "disk-cleanup");
  const rows = fs.readFileSync(path.join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    const [hash, name] = row.split(/\s+/);
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"), hash, `${name}: port it to omnirush-cli (src/disk-cleanup/) and update PARITY.sha256 in both`);
  }
});

test("installer versions are read from the file names electron-builder writes", () => {
  assert.equal(installerVersion("OmniRush.ai-Setup-3.6.4.exe"), "3.6.4");
  assert.equal(installerVersion("OmniRush.ai-3.7.0-arm64-mac.zip"), "3.7.0");
  assert.equal(installerVersion("omnirush-desktop_3.6.10_amd64.deb"), "3.6.10");
  // The names this repo's releases publish.
  for (const name of ["omnirush-linux-amd64-3.6.4.deb", "omnirush-linux-x86_64-3.6.4.AppImage", "omnirush-linux-aarch64-3.6.4.rpm", "omnirush-mac-arm64-3.6.4.dmg", "omnirush-win-x64-3.6.4.exe"]) assert.equal(installerVersion(name), "3.6.4", name);
  assert.equal(installerVersion("installer.exe"), null);
  assert.equal(installerVersion("omnirush-win-x64-3.6.5-alpha.2.exe"), "3.6.5-alpha.2");
  assert.equal(installerVersion("OmniRush.ai-3.6.4-arm64-mac.zip"), "3.6.4");
  assert.deepEqual(versionsToRemove(["3.6.1", "3.6.2", "3.6.3", "3.6.4"], { current: "3.6.4" }), ["3.6.1", "3.6.2"]);
});

test("updaterCacheDirName comes from app-update.yml and is never a path", async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "app-update.yml"), "provider: github\nupdaterCacheDirName: omnirushdesktop-updater\n");
  assert.equal(updaterCacheDirName({ resourcesPath: root }), "omnirushdesktop-updater");
  fs.writeFileSync(path.join(root, "app-update.yml"), "updaterCacheDirName: ../../home\n");
  assert.equal(updaterCacheDirName({ resourcesPath: root }), null);
  assert.equal(updaterCacheDirName({ resourcesPath: path.join(root, "none") }), null);
});

test("three successive updates: the installed installers go, a newer downloaded one and the recovery installer stay; user data never touched; idempotent", async (t) => {
  const { paths } = fixture(t);
  const data = userData(paths);
  // 3.6.2 → 3.6.3 → 3.6.4: what each update left.
  write(path.join(paths.updaterCache, "pending", "OmniRush.ai-Setup-3.6.4.exe"), 3 * MB);
  fs.writeFileSync(path.join(paths.updaterCache, "pending", "update-info.json"), JSON.stringify({ fileName: "OmniRush.ai-Setup-3.6.4.exe" }));
  write(path.join(paths.updaterCache, "installer.exe"), 2 * MB);
  write(path.join(paths.updaterCache, "current.blockmap"), 1000);
  write(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.3-arm64.dmg"), 2 * MB);
  write(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.5-arm64.dmg.part"), MB);
  const dry = await cleanupPass({ paths, currentVersion: "3.6.4", dryRun: true });
  assert.ok(dry.freed >= 6 * MB, String(dry.freed));
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "pending")), "dry run removes nothing");
  const pass = await cleanupPass({ paths, currentVersion: "3.6.4" });
  assert.ok(!fs.existsSync(path.join(paths.updaterCache, "pending")));
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "installer.exe")), "the differential update base stays");
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "current.blockmap")));
  assert.ok(!fs.existsSync(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.3-arm64.dmg")));
  assert.ok(!fs.existsSync(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.5-arm64.dmg.part")));
  assert.equal(pass.freed, dry.freed);
  for (const file of data) assert.ok(fs.existsSync(file), `${file} kept`);
  assert.equal((await cleanupPass({ paths, currentVersion: "3.6.4" })).items.length, 0, "a second pass has nothing to do");
});

test("an update downloaded but not installed yet (newer than the running version) stays", async (t) => {
  const { paths } = fixture(t);
  write(path.join(paths.updaterCache, "pending", "OmniRush.ai-Setup-3.6.5.exe"), MB);
  fs.writeFileSync(path.join(paths.updaterCache, "pending", "update-info.json"), JSON.stringify({ fileName: "OmniRush.ai-Setup-3.6.5.exe" }));
  write(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.5-arm64.dmg"), MB);
  await cleanupPass({ paths, currentVersion: "3.6.4" });
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "pending", "OmniRush.ai-Setup-3.6.5.exe")));
  assert.ok(fs.existsSync(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.5-arm64.dmg")));
  // Protected paths (an update in progress) stay even when old.
  const staged = write(path.join(paths.userData, "app-update-installer", "OmniRush.ai-3.6.3-arm64.zip"));
  await cleanupPass({ paths, currentVersion: "3.6.4", protect: [staged] });
  assert.ok(fs.existsSync(staged));
});

test("Linux packages in Downloads: only with Free up space, only the ones this app recorded, unchanged and installed", async (t) => {
  const { root, paths } = fixture(t);
  const downloads = path.join(root, "Downloads");
  const old = write(path.join(downloads, "omnirush-desktop_3.6.3_amd64.deb"), 2 * MB);
  const edited = write(path.join(downloads, "omnirush-desktop_3.6.2_amd64.deb"), MB);
  const newer = write(path.join(downloads, "omnirush-desktop_3.6.5_amd64.deb"), MB);
  const theirs = write(path.join(downloads, "omnirush-desktop_3.6.1_amd64.deb"), MB);
  rememberDownloadedPackage(paths.userData, old, "3.6.3");
  rememberDownloadedPackage(paths.userData, edited, "3.6.2");
  rememberDownloadedPackage(paths.userData, newer, "3.6.5");
  fs.appendFileSync(edited, "changed by the user");
  await cleanupPass({ paths, currentVersion: "3.6.4" });
  assert.ok(fs.existsSync(old), "the automatic pass never touches Downloads");
  await cleanupPass({ paths, currentVersion: "3.6.4", includeDownloads: true });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(edited), "changed since: the user's file");
  assert.ok(fs.existsSync(newer), "not installed yet");
  assert.ok(fs.existsSync(theirs), "never recorded: never touched");
  const left = JSON.parse(fs.readFileSync(path.join(paths.userData, PACKAGES_FILE), "utf8")).packages.map((p) => path.basename(p.path));
  assert.deepEqual(left, ["omnirush-desktop_3.6.5_amd64.deb"]);
});

test("temp leftovers of stopped updates and runs go by exact name and age; other temp files stay", async (t) => {
  const { paths } = fixture(t);
  const make = (name, days, dir = true) => { const p = path.join(paths.temp, name); if (dir) { fs.mkdirSync(p); age(write(path.join(p, "f")), days * DAY); } else write(p); age(p, days * DAY); return p; };
  const gone = [make("omnirush-update-Ab12Cd", 2), make("omnirush-swap-4242.sh", 2, false), make("omnirush-engine2-import-x1y2z3", 4), make("omnirush-login-sync-abcdef", 4)];
  const kept = [make("omnirush-update-Fresh1", 0.1), make("omnirush-engine2-import-young1", 1), make("omnirush-upload-4242", 30), make("omnirush-update-notmine-x", 30), make("someone-else", 30)];
  await cleanupPass({ paths, currentVersion: "3.6.4" });
  for (const p of gone) assert.ok(!fs.existsSync(p), p);
  for (const p of kept) assert.ok(fs.existsSync(p), p);
});

test("logs: update-install.log rotates past 10 MB; rotated logs over 30 days go; the server log stays", async (t) => {
  const { paths } = fixture(t);
  const install = write(path.join(paths.logs, "update-install.log"), 11 * MB);
  const oldRotated = write(path.join(paths.logs, "omnirush-server.log.3"), MB);
  age(oldRotated, 40 * DAY);
  const server = write(path.join(paths.logs, "omnirush-server.log"), 5 * MB);
  age(server, 40 * DAY);
  await cleanupPass({ paths, currentVersion: "3.6.4" });
  assert.ok(!fs.existsSync(install));
  assert.equal(fs.statSync(`${install}.1`).size, 11 * MB);
  assert.ok(!fs.existsSync(oldRotated));
  assert.ok(fs.existsSync(server), "a live log is never removed");
});

test("crash dumps older than 30 days go; the Crashpad database and fresh dumps stay", async (t) => {
  const { paths } = fixture(t);
  const old = write(path.join(paths.userData, "Crashpad", "completed", "a.dmp"));
  age(old, 40 * DAY);
  const fresh = write(path.join(paths.userData, "Crashpad", "completed", "b.dmp"));
  const settings = write(path.join(paths.userData, "Crashpad", "settings.dat"));
  age(settings, 400 * DAY);
  await cleanupPass({ paths, currentVersion: "3.6.4" });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh) && fs.existsSync(settings));
});

test("Windows-locked files are kept and reported as in use, never thrown; the rest still goes", { skip: process.getuid?.() === 0 }, async (t) => {
  const { paths } = fixture(t);
  write(path.join(paths.updaterCache, "pending", "OmniRush.ai-Setup-3.6.3.exe"), MB);
  fs.writeFileSync(path.join(paths.updaterCache, "pending", "update-info.json"), JSON.stringify({ fileName: "OmniRush.ai-Setup-3.6.3.exe" }));
  write(path.join(paths.updaterCache, "installer.exe"), MB);
  fs.chmodSync(path.join(paths.updaterCache, "pending"), 0o500);
  const pass = await cleanupPass({ paths, currentVersion: "3.6.4" });
  fs.chmodSync(path.join(paths.updaterCache, "pending"), 0o700);
  assert.ok(pass.items.some((i) => i.path.endsWith("pending") && i.locked));
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "installer.exe")));
  assert.equal(pass.locked, 1);
});

test("one pass at a time; the automatic pass is due once a day and at once after an update; off switch", async (t) => {
  const { paths } = fixture(t);
  const release = acquireLock(path.join(paths.userData, LOCK_FILE));
  assert.equal((await cleanupPass({ paths, currentVersion: "3.6.4" })).skipped, "busy");
  release();
  assert.equal(cleanupDue(paths.userData, "3.6.4"), true);
  await runAutomatic({ paths, currentVersion: "3.6.4", log: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.userData, MARKER_FILE), "utf8")).version, "3.6.4");
  assert.equal(cleanupDue(paths.userData, "3.6.4"), false);
  assert.equal(cleanupDue(paths.userData, "3.6.5"), true);
  assert.equal(cleanupDue(paths.userData, "3.6.5", { env: { OMNIRUSH_DISK_CLEANUP: "off" } }), false);
});

test("scheduleDiskCleanup runs later, through the updater's queue, never at start", async (t) => {
  const { paths } = fixture(t);
  const app = { isPackaged: true, getPath: (name) => ({ userData: paths.userData, logs: paths.logs, home: path.dirname(paths.userData) })[name] };
  const queued = [];
  const timer = scheduleDiskCleanup({ app, currentVersion: "3.6.4", delayMs: 5, whenIdle: (fn) => { queued.push(fn); return { skipped: "update-pending" }; }, log: () => {} });
  assert.ok(timer);
  assert.equal(queued.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(queued.length, 1, "handed to the updater queue");
  assert.ok(!fs.existsSync(path.join(paths.userData, MARKER_FILE)), "skipped while an update waits");
});

test("pre-releases: a waiting alpha.2 stays while alpha.1 runs; a waiting stable stays while its alpha runs; an installed alpha goes", async (t) => {
  const { paths } = fixture(t);
  const pending = (name) => {
    fs.rmSync(path.join(paths.updaterCache, "pending"), { recursive: true, force: true });
    write(path.join(paths.updaterCache, "pending", name), 1000);
    fs.writeFileSync(path.join(paths.updaterCache, "pending", "update-info.json"), JSON.stringify({ fileName: name }));
  };
  pending("omnirush-win-x64-3.6.5-alpha.2.exe");
  await cleanupPass({ paths, currentVersion: "3.6.5-alpha.1" });
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "pending")), "alpha.2 waits");
  pending("omnirush-win-x64-3.6.4.exe");
  await cleanupPass({ paths, currentVersion: "3.6.4-alpha.3" });
  assert.ok(fs.existsSync(path.join(paths.updaterCache, "pending")), "the stable waits");
  pending("omnirush-win-x64-3.6.5-alpha.2.exe");
  await cleanupPass({ paths, currentVersion: "3.6.5-alpha.2" });
  assert.ok(!fs.existsSync(path.join(paths.updaterCache, "pending")), "installed");
});

test("a temp folder with a socket in it (a live channel) stays however old", { skip: process.platform === "win32" }, async (t) => {
  const { paths } = fixture(t);
  const net = await import("node:net");
  const dir = path.join(paths.temp, "omnirush-login-sync-Sock01");
  fs.mkdirSync(dir);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(path.join(dir, "s.sock"), () => resolve(undefined)));
  age(dir, 10 * DAY);
  await cleanupPass({ paths, currentVersion: "3.6.4" });
  server.close();
  assert.ok(fs.existsSync(dir));
});
