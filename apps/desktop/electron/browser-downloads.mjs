// Downloads from the person's own tabs in the Work browser: saved straight to the Downloads folder (no Save dialog for
// each file), listed in the browser's ".." menu (the last 5 of this session), and marked as coming from the internet
// the way the system expects (macOS `com.apple.quarantine`, Windows `Zone.Identifier`), so Gatekeeper and SmartScreen
// still check a file before it runs. The list lives in memory on this computer; nothing about it is sent anywhere.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Downloads the ".." menu lists. */
export const DOWNLOADS_SHOWN = 5;
/** Finished downloads kept in memory; older ones drop off (they stay in the Downloads folder). */
const DOWNLOADS_KEPT = 20;
const PROGRESS_EVERY_MS = 250;

// Characters no file name may hold on Windows, macOS or Linux, and control characters.
const UNSAFE_NAME = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file name that is safe on every system: no folders, no reserved or hidden names, at most 180 characters. */
export function safeDownloadName(name) {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base.replace(UNSAFE_NAME, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 180);
  if (!clean) return "download";
  return RESERVED_NAME.test(clean) ? `download_${clean}` : clean;
}

/** `dir/name`, or `name (1)`, `name (2)` ... when a file already has that name. Never replaces a file. */
export function uniqueDownloadPath(dir, name, taken) {
  const safe = safeDownloadName(name);
  const double = /\.tar\.(gz|bz2|xz|zst)$/i.exec(safe);
  const ext = double ? double[0] : path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || "download";
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(dir, index === 0 ? `${stem}${ext}` : `${stem} (${index})${ext}`);
    if (!taken(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

function webAddress(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}

/** macOS quarantine: downloaded from the internet (0081, as browsers write it), when, and by which app. */
export function quarantineValue(now = Date.now(), agent = "OmniRush") {
  return `0081;${Math.floor(now / 1000).toString(16)};${agent.replace(/;/g, " ")};`;
}

/**
 * Windows mark of the web: the Internet zone, the page it came from and its address (no user names or passwords).
 * @param {{ url?: string, referrer?: string }} [source]
 */
export function zoneIdentifier({ url, referrer } = {}) {
  const host = webAddress(url) ?? "about:internet";
  const from = webAddress(referrer);
  return ["[ZoneTransfer]", "ZoneId=3", ...(from ? [`ReferrerUrl=${from}`] : []), `HostUrl=${host}`, ""].join("\r\n");
}

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

/**
 * Mark a finished download as coming from the internet, unless the system already did. Resolves to which mark the
 * file has and whether it was added here. Linux has no such mark.
 * @param {string} filePath
 * @param {{ platform?: string, url?: string, referrer?: string, now?: number, agent?: string,
 *   run?: (file: string, args: string[]) => Promise<string>,
 *   read?: (file: string, encoding: "utf8") => Promise<string>,
 *   write?: (file: string, data: string) => Promise<void> }} [options]
 */
export async function markDownloaded(filePath, { platform = process.platform, url, referrer, now = Date.now(), agent, run = runFile, read = readFile, write = writeFile } = {}) {
  if (platform === "darwin") {
    const existing = await run("/usr/bin/xattr", ["-p", "com.apple.quarantine", filePath]).then((value) => value.trim(), () => "");
    if (existing) return { mark: "quarantine", added: false };
    await run("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantineValue(now, agent), filePath]);
    return { mark: "quarantine", added: true };
  }
  if (platform === "win32") {
    const stream = `${filePath}:Zone.Identifier`;
    const existing = await read(stream, "utf8").catch(() => "");
    if (/ZoneId\s*=\s*[34]/i.test(existing)) return { mark: "zone", added: false };
    await write(stream, zoneIdentifier({ url, referrer }));
    return { mark: "zone", added: true };
  }
  return { mark: null, added: false };
}

/**
 * @typedef {{ id: string, filename: string, state: "progressing" | "completed" | "cancelled" | "failed",
 *   receivedBytes: number, totalBytes: number, startedAt: number }} BrowserDownload
 * @typedef {{ getFilename(): string, getURL(): string, getTotalBytes(): number, getReceivedBytes(): number,
 *   setSavePath(path: string): void, cancel(): void,
 *   on(event: string, listener: (...args: any[]) => void): unknown,
 *   once(event: string, listener: (...args: any[]) => void): unknown }} DownloadLike Electron's DownloadItem, as used here.
 */

/**
 * The person's downloads this session.
 * @param {{
 *   downloadsDir: () => string,
 *   platform?: string,
 *   mark?: typeof markDownloaded,
 *   exists?: (filePath: string) => boolean,
 *   onChange?: (downloads: BrowserDownload[]) => void,
 *   onFinished?: (filePath: string) => void,
 *   now?: () => number,
 * }} options
 */
export function createBrowserDownloads({ downloadsDir, platform = process.platform, mark = markDownloaded, exists = existsSync, onChange = () => {}, onFinished = () => {}, now = Date.now }) {
  let counter = 0;
  /** @type {Array<{ id: string, item: DownloadLike, path: string, url: string, referrer: string, state: BrowserDownload["state"], receivedBytes: number, totalBytes: number, startedAt: number, sentAt: number }>} */
  const entries = [];

  /** @returns {BrowserDownload[]} */
  function list() {
    return entries.slice(0, DOWNLOADS_SHOWN).map((entry) => ({
      id: entry.id,
      filename: path.basename(entry.path),
      state: entry.state,
      receivedBytes: entry.receivedBytes,
      totalBytes: entry.totalBytes,
      startedAt: entry.startedAt,
    }));
  }

  const changed = () => onChange(list());

  function prune() {
    for (let index = entries.length - 1; index >= 0 && entries.length > DOWNLOADS_KEPT; index -= 1) {
      if (entries[index].state !== "progressing") entries.splice(index, 1);
    }
  }

  /**
   * Save `item` to the Downloads folder under a name no file has yet. Call it inside `will-download`, before Electron
   * would ask where to save. `referrer`: the page it came from.
   * @param {DownloadLike} item
   * @param {{ referrer?: string }} [source]
   */
  function track(item, { referrer = "" } = {}) {
    const busy = new Set(entries.filter((entry) => entry.state === "progressing").map((entry) => entry.path));
    const target = uniqueDownloadPath(downloadsDir(), item.getFilename(), (candidate) => busy.has(candidate) || exists(candidate));
    item.setSavePath(target);
    counter += 1;
    const entry = {
      id: `download_${counter}`, item, path: target, url: item.getURL(), referrer,
      state: /** @type {BrowserDownload["state"]} */ ("progressing"),
      receivedBytes: 0, totalBytes: Math.max(0, item.getTotalBytes()), startedAt: now(), sentAt: 0,
    };
    entries.unshift(entry);
    prune();
    item.on("updated", () => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = Math.max(0, item.getTotalBytes());
      if (now() - entry.sentAt < PROGRESS_EVERY_MS) return;
      entry.sentAt = now();
      changed();
    });
    item.once("done", (_event, state) => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = Math.max(0, item.getTotalBytes());
      if (state !== "completed") {
        entry.state = state === "cancelled" ? "cancelled" : "failed";
        changed();
        return;
      }
      // Marked before the list offers it, so the system knows where the file came from before anyone opens it.
      void Promise.resolve()
        .then(() => mark(entry.path, { platform, url: entry.url, referrer: entry.referrer }))
        .catch((error) => console.warn("[browser-downloads] could not mark a download as from the internet", error instanceof Error ? error.message : error))
        .finally(() => {
          entry.state = "completed";
          changed();
          onFinished(entry.path);
        });
    });
    changed();
    return entry.id;
  }

  const find = (id) => entries.find((entry) => entry.id === id) ?? null;

  /** The saved file of a finished download, for Show in Finder or Explorer. */
  function savedPath(id) {
    const entry = find(String(id ?? ""));
    return entry?.state === "completed" ? entry.path : null;
  }

  function cancel(id) {
    const entry = find(String(id ?? ""));
    if (entry?.state === "progressing") entry.item.cancel();
  }

  /** Forget finished downloads (Clear browsing data). The files stay in the Downloads folder. */
  function clear() {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].state !== "progressing") entries.splice(index, 1);
    }
    changed();
    return list();
  }

  return { track, list, savedPath, cancel, clear };
}
