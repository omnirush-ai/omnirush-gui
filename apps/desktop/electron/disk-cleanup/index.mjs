// What the desktop app lets go of so updates do not keep eating disk space:
//   - the update installer electron-updater keeps after it was installed
//     (<cache>/<updaterCacheDirName>/pending; the installed version's installer.exe
//     and current.blockmap stay as the base of the next differential update)
//   - our own installer cache (app-update-installer: a macOS DMG/zip) once that
//     version or a newer one runs
//   - with "Free up space" only: Linux packages (.deb/.rpm/.pacman) this app
//     itself downloaded into Downloads, once that version or a newer one runs
//     (only files it recorded, unchanged)
//   - update staging folders and swap scripts a stopped macOS update left in temp
//   - logs: update-install.log past 10 MB (one rotated copy), rotated logs past
//     30 days or over 50 MB together
//   - Chromium crash dumps (Crashpad) older than 30 days
//   - temp folders crashed runs left behind (3+ days old)
//
// Kept on purpose: the "Restore previous version" installer (app-recovery-cache,
// one version), a downloaded update not installed yet, chats, projects,
// settings, sign-in, browser logins, the upload and sync queues (what is not sent
// yet; they bound themselves), Reset app data backups, the engine's data.
// Sandbox images: the local server removes old ones itself (apps/server/src/box).
//
// The automatic pass runs in the background (async, yielding between steps) two minutes after the window
// opened (so a start that fails never cleans), at most once a day and at once
// after an update, under a lock, never while an update downloads or waits to
// install (the updater queues it), best effort; logged to the console log and
// <userData>/disk-cleanup.json.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireLock, capLogs, compareVersions, formatBytes, parseVersion, rotateLog, sizeOf, summarize } from "./retention.mjs";

export const MARKER_FILE = "disk-cleanup.json";
export const LOCK_FILE = "disk-cleanup.lock";
export const PACKAGES_FILE = "downloaded-packages.v1.json";
export const EVERY_MS = 24 * 3_600_000;
export const START_DELAY_MS = 2 * 60_000;
const INSTALLER_CACHE_DIRECTORY = "app-update-installer";
const DAY = 24 * 3_600_000;
const LOCKED = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
/** Temp names only this app makes; anything else in temp is never looked at. */
const TEMP_NAMES = [
  { prefix: "omnirush-update-", re: /^omnirush-update-[A-Za-z0-9]{6}$/, maxAgeMs: DAY },
  { prefix: "omnirush-swap-", re: /^omnirush-swap-\d+\.sh$/, maxAgeMs: DAY },
  { prefix: "omnirush-engine2-import-", re: /^omnirush-engine2-import-[A-Za-z0-9]{6}$/, maxAgeMs: 3 * DAY },
  { prefix: "omnirush-archive-ignore-", re: /^omnirush-archive-ignore-[A-Za-z0-9]{6}$/, maxAgeMs: 3 * DAY },
  { prefix: "omnirush-login-sync-", re: /^omnirush-login-sync-[A-Za-z0-9]{6}$/, maxAgeMs: 3 * DAY },
];
/** Lets the main process breathe between steps (the window stays responsive). */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort */ }
}

/** Bytes under `p`, without blocking the main process (links are not followed). */
async function sizeAsync(p) {
  let st;
  try { st = await lstat(p); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let names = [];
  try { names = await readdir(p); } catch { return 0; }
  let total = 0;
  for (const name of names) total += await sizeAsync(path.join(p, name));
  return total;
}

/** Remove a file or folder off the main thread's critical path; { ok, bytes, locked, error }. */
async function removeAsync(p, { dryRun = false } = {}) {
  const bytes = await sizeAsync(p);
  if (dryRun) return { ok: true, bytes, dryRun: true };
  try {
    await rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    return { ok: true, bytes };
  } catch (error) {
    const code = String(error?.code || "");
    return { ok: false, bytes: 0, locked: LOCKED.has(code), error: code || String(error?.message || error) };
  }
}

/**
 * Entries of `dir` starting with one of `prefixes`, owned by this user, not
 * touched for `maxAgeMs` (the entry and what is directly in it), holding no
 * socket. The same rule as retention.mjs staleTemp, without blocking.
 */
async function staleTempAsync(dir, prefixes, { now = Date.now(), maxAgeMs }) {
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const out = [];
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const p = path.join(dir, name);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || (uid !== null && st.uid !== uid)) continue;
      let newest = st.mtimeMs;
      let live = false;
      if (st.isDirectory()) {
        for (const child of await readdir(p)) {
          try {
            const c = await lstat(path.join(p, child));
            if (c.isSocket() || c.isFIFO()) { live = true; break; }
            newest = Math.max(newest, c.mtimeMs);
          } catch { /* gone */ }
        }
      }
      if (!live && now - newest > maxAgeMs) out.push(p);
    } catch { /* gone or unreadable */ }
  }
  return out;
}

const ARCH_OR_OS = /^(arm64|x64|x86_64|amd64|aarch64|ia32|armv7l|universal|mac|macos|darwin|win|win32|windows|linux|setup)$/i;
const INSTALLER_EXT = /\.(exe|dmg|zip|AppImage|deb|rpm|pacman|tar\.gz|tgz|blockmap|part|yml)(\.(blockmap|part))?$/i;

/**
 * The version in an installer's file name, pre-release included
 * (`omnirush-win-x64-3.6.4.exe` → 3.6.4, `…-3.6.5-alpha.2.exe` → 3.6.5-alpha.2,
 * `OmniRush.ai-3.6.4-arm64-mac.zip` → 3.6.4), else null.
 */
export function installerVersion(name) {
  const base = String(name || "").replace(INSTALLER_EXT, "");
  const m = /(?:^|[^0-9.])(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(base) ?? /(?:^|[^0-9.])(\d+\.\d+\.\d+)(?=[^0-9.]|$)/.exec(base);
  if (!m) return null;
  const pre = m[2] && !ARCH_OR_OS.test(m[2].split(/[-.]/)[0]) ? m[2] : null;
  const version = pre ? `${m[1]}-${pre}` : m[1];
  return parseVersion(version) ? version : null;
}

/** electron-updater's cache root for this OS (it appends updaterCacheDirName). */
export function updaterCacheBase({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "win32") return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  if (platform === "darwin") return path.join(home, "Library", "Caches");
  return String(env.XDG_CACHE_HOME || "").trim() || path.join(home, ".cache");
}

/** The updater cache folder name app-update.yml names (electron-builder writes it into resources). */
export function updaterCacheDirName({ resourcesPath = process.resourcesPath } = {}) {
  try {
    const text = readFileSync(path.join(resourcesPath || "", "app-update.yml"), "utf8");
    const m = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text);
    const name = m?.[1]?.trim();
    // A plain folder name only: never a path out of the cache root.
    return name && !/[\\/]|^\.\.?$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * The installer electron-updater downloaded, once it is not newer than the
 * running version (installed, or older than what runs; pre-releases in semver
 * order): pending/ and the installer/blockmap copies it keeps in the cache root.
 */
async function updaterCacheItems({ cacheDir, currentVersion, now, dryRun }) {
  const items = [];
  if (!cacheDir || !existsSync(cacheDir)) return items;
  const pending = path.join(cacheDir, "pending");
  if (existsSync(pending)) {
    const info = readJson(path.join(pending, "update-info.json"));
    let names = [];
    try { names = await readdir(pending); } catch { /* none */ }
    const fileName = typeof info?.fileName === "string" ? info.fileName : names.find((n) => /\.(exe|dmg|zip|AppImage|deb|rpm|pacman)$/i.test(n));
    const version = installerVersion(fileName);
    let old = false;
    if (version) old = compareVersions(version, currentVersion) <= 0;
    else {
      // No version to read: only when it is older than two weeks (a download never offered again).
      try { old = now - statSync(pending).mtimeMs > 14 * DAY; } catch { old = false; }
    }
    if (old) items.push({ kind: "installer", path: pending, reason: version ? `update ${version} installed` : "old update download", ...(await removeAsync(pending, { dryRun })) });
  }
  // installer.exe and current.blockmap stay: they are the installed version's
  // installer, the base the next Windows update downloads only the changes against.
  return items;
}

/** Our installer cache (manual DMG / mac swap zip): its installer once that version or a newer one runs. */
async function installerCacheItems({ userData, currentVersion, protect, dryRun }) {
  const dir = path.join(userData, INSTALLER_CACHE_DIRECTORY);
  const items = [];
  let names = [];
  try { names = await readdir(dir); } catch { return items; }
  for (const name of names) {
    const file = path.join(dir, name);
    if (protect.has(path.resolve(file))) continue;
    const version = installerVersion(name);
    const partial = name.endsWith(".part");
    if (partial || (version && compareVersions(version, currentVersion) <= 0)) {
      items.push({ kind: "installer", path: file, reason: partial ? "stopped download" : `update ${version} installed`, ...(await removeAsync(file, { dryRun })) });
    }
  }
  return items;
}

/**
 * Remember a Linux package this app itself wrote to the user's Downloads (the
 * updater calls it only when it downloaded the file, never for one that was
 * already there). Only "Free up space" removes recorded files, unchanged ones.
 */
export function rememberDownloadedPackage(userData, file, version) {
  try {
    const st = statSync(file);
    const list = readJson(path.join(userData, PACKAGES_FILE))?.packages ?? [];
    const next = [...list.filter((p) => p?.path !== file), { path: file, version: String(version), size: st.size, mtimeMs: Math.floor(st.mtimeMs) }].slice(-20);
    writeJsonAtomic(path.join(userData, PACKAGES_FILE), { packages: next });
  } catch { /* not recorded: never removed */ }
}

async function downloadedPackageItems({ userData, currentVersion, protect, dryRun }) {
  const file = path.join(userData, PACKAGES_FILE);
  const list = readJson(file)?.packages;
  if (!Array.isArray(list)) return [];
  const items = [];
  const keep = [];
  for (const p of list) {
    if (!p || typeof p.path !== "string" || !parseVersion(p.version)) continue;
    let st;
    try { st = lstatSync(p.path); } catch { continue; /* gone: forget it */ }
    const unchanged = st.isFile() && st.size === p.size && Math.floor(st.mtimeMs) === p.mtimeMs;
    if (!unchanged) continue; // the user moved, replaced or edited it: it is theirs now
    if (protect.has(path.resolve(p.path)) || compareVersions(p.version, currentVersion) > 0) { keep.push(p); continue; }
    const res = await removeAsync(p.path, { dryRun });
    items.push({ kind: "installer", path: p.path, reason: `package ${p.version} installed`, ...res });
    if (dryRun || !res.ok) keep.push(p);
  }
  if (!dryRun) writeJsonAtomic(file, { packages: keep });
  return items;
}

async function tempItems({ tmp, now, protect, dryRun }) {
  const items = [];
  for (const rule of TEMP_NAMES) {
    for (const p of await staleTempAsync(tmp, [rule.prefix], { now, maxAgeMs: rule.maxAgeMs })) {
      if (!rule.re.test(path.basename(p)) || protect.has(path.resolve(p))) continue;
      items.push({ kind: "temp", path: p, reason: "left by a run or update that stopped", ...(await removeAsync(p, { dryRun })) });
    }
  }
  return items;
}

/** Crashpad reports (minidumps) older than 30 days; the database files stay. */
async function crashItems({ userData, now, dryRun }) {
  const items = [];
  for (const sub of ["completed", "pending", "new"]) {
    const dir = path.join(userData, "Crashpad", sub);
    for (const p of await staleTempAsync(dir, [""], { now, maxAgeMs: 30 * DAY })) {
      if (!/\.(dmp|meta)$/i.test(p)) continue;
      items.push({ kind: "crash", path: p, reason: "old crash report", ...(await removeAsync(p, { dryRun })) });
    }
  }
  return items;
}

function logItems({ logsDir, now, dryRun }) {
  const items = [];
  if (!logsDir) return items;
  const install = path.join(logsDir, "update-install.log");
  const rotated = rotateLog(install, { dryRun });
  if (rotated && (rotated.bytes || rotated.locked || rotated.wouldRotate)) items.push({ kind: "log", path: `${install}.1`, reason: "log over 10 MB", ...rotated });
  items.push(...capLogs(logsDir, { match: (name) => /\.log\.\d+$/.test(name), now, dryRun }).map((item) => ({ kind: "log", ...item })));
  return items;
}

/**
 * One cleanup pass (the main process; async, it yields between steps).
 * `paths`: { userData, logs, temp, updaterCache } (updaterCache: the
 * electron-updater cache folder or null). `protect`: files/folders an update
 * in progress uses. `includeDownloads`: also the packages this app saved to
 * Downloads (only "Free up space" asks for it). Never throws.
 */
export async function cleanupPass({ paths, currentVersion, now = Date.now(), dryRun = false, protect = [], includeDownloads = false }) {
  const userData = paths.userData;
  if (!parseVersion(currentVersion)) return { items: [], freed: 0, locked: 0, skipped: "no-version" };
  const release = dryRun ? () => {} : acquireLock(path.join(userData, LOCK_FILE), { now });
  if (!release) return { items: [], freed: 0, locked: 0, skipped: "busy" };
  const kept = new Set(protect.filter(Boolean).map((p) => path.resolve(p)));
  const items = [];
  const step = async (fn) => {
    try { items.push(...(await fn())); } catch (error) { items.push({ kind: "error", path: "", bytes: 0, error: String(error?.message || error) }); }
    await breathe();
  };
  try {
    await step(() => updaterCacheItems({ cacheDir: paths.updaterCache, currentVersion, now, dryRun }));
    await step(() => installerCacheItems({ userData, currentVersion, protect: kept, dryRun }));
    if (includeDownloads) await step(() => downloadedPackageItems({ userData, currentVersion, protect: kept, dryRun }));
    await step(() => tempItems({ tmp: paths.temp, now, protect: kept, dryRun }));
    await step(() => crashItems({ userData, now, dryRun }));
    await step(() => logItems({ logsDir: paths.logs, now, dryRun }));
  } finally { release(); }
  const sum = summarize(items);
  return { items: items.map(({ ok, ...rest }) => rest), freed: sum.bytes, locked: sum.locked };
}

/** Due: never ran, ran over a day ago, or ran on another version (just updated). */
export function cleanupDue(userData, version, { now = Date.now(), env = process.env } = {}) {
  if (["0", "off", "false", "no"].includes(String(env.OMNIRUSH_DISK_CLEANUP ?? "").trim().toLowerCase())) return false;
  const last = readJson(path.join(userData, MARKER_FILE));
  if (!last || last.version !== version) return true;
  return !(Number.isFinite(last.at) && now - last.at < EVERY_MS && last.at <= now);
}

/** The automatic pass: marker + one log line. */
export async function runAutomatic({ paths, currentVersion, now = Date.now(), protect = [], log = console.info }) {
  if (!cleanupDue(paths.userData, currentVersion, { now })) return null;
  const result = await cleanupPass({ paths, currentVersion, now, protect });
  if (result.skipped) return result;
  writeJsonAtomic(path.join(paths.userData, MARKER_FILE), { at: now, version: currentVersion, freed: result.freed, removed: result.items.filter((i) => !i.locked && !i.error).length, locked: result.locked });
  if (result.items.length) log(`[disk-cleanup] freed ${formatBytes(result.freed)}: ${result.items.map((i) => `${i.kind}:${path.basename(String(i.path || ""))}${i.locked ? "(in use)" : ""}`).join(", ")}`);
  return result;
}

/** The paths of a running Electron app. */
export function appPaths(app, { resourcesPath = process.resourcesPath, platform = process.platform, env = process.env } = {}) {
  const name = app.isPackaged ? updaterCacheDirName({ resourcesPath }) : null;
  return {
    userData: app.getPath("userData"),
    logs: (() => { try { return app.getPath("logs"); } catch { return null; } })(),
    temp: os.tmpdir(),
    updaterCache: name ? path.join(updaterCacheBase({ platform, env, home: app.getPath("home") }), name) : null,
  };
}

/**
 * After the window opened: the automatic pass two minutes later, through
 * `whenIdle` (the updater's queue: never during a download or a pending
 * install). Never throws; never on the start path.
 */
export function scheduleDiskCleanup({ app, currentVersion, whenIdle = (fn) => fn(), protect = () => [], delayMs = START_DELAY_MS, log = console.info }) {
  try {
    if (!app.isPackaged && !process.env.OMNIRUSH_DISK_CLEANUP_DEV) return null;
    const paths = appPaths(app);
    if (!cleanupDue(paths.userData, currentVersion)) return null;
    const timer = setTimeout(() => {
      Promise.resolve(whenIdle(() => runAutomatic({ paths, currentVersion, protect: protect(), log })))
        .catch((error) => console.warn("[disk-cleanup] failed", error?.message ?? error));
    }, delayMs);
    timer.unref?.();
    return timer;
  } catch { return null; }
}

/** For the "Free up space" entry: what would go (dryRun) or what went. */
export async function freeUpSpace({ app, currentVersion, dryRun, protect = [] }) {
  const paths = appPaths(app);
  const result = await cleanupPass({ paths, currentVersion, dryRun, protect, includeDownloads: true });
  if (!dryRun && !result.skipped) writeJsonAtomic(path.join(paths.userData, MARKER_FILE), { at: Date.now(), version: currentVersion, freed: result.freed, removed: result.items.filter((i) => !i.locked && !i.error).length, locked: result.locked });
  return {
    ok: !result.skipped,
    skipped: result.skipped ?? null,
    dryRun: Boolean(dryRun),
    freedBytes: result.freed,
    freed: formatBytes(result.freed),
    items: result.items.filter((i) => i.kind !== "error").map((i) => ({ kind: i.kind, path: String(i.path || ""), bytes: Number(i.bytes) || 0, size: formatBytes(Number(i.bytes) || 0), reason: i.reason, inUse: Boolean(i.locked) })),
  };
}

export { sizeOf };
