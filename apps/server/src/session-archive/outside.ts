/**
 * Files outside the session's workspace that the agent touched (read,
 * wrote or edited with its file tools, or named in a shell command it ran).
 * They are archived byte for byte with the session's project archive, under
 * `__outside__/<absolute path>`: `/tmp/x/a.bin` is `__outside__/tmp/x/a.bin`,
 * `C:\data\a.bin` is `__outside__/C/data/a.bin`. Only the specific files
 * touched are ever looked at (a touched folder is never expanded), with the
 * archive's exclusions: credential files and stores, the app's own state
 * directories, dependency and cache folders, the kernel's pseudo file
 * systems, symlinks (never followed), special files, and files larger than
 * MAX_OUTSIDE_FILE_BYTES.
 */
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  HASH_CONCURRENCY,
  HASH_READ_BYTES,
  OPEN_ENTRY_FLAGS,
  OUTSIDE_ROOT_NAME,
  STAT_CONCURRENCY,
  compareArchivePaths,
  emptyExcludedCounts,
  forEachBounded,
  isArchiveCredentialPath,
  isSameFileIdentity,
  statFields,
  type ArchiveHashCache,
  type ScannedEntry,
} from "./manifest.js";
import type { TouchedScanResult } from "./touched.js";
import { isHomeSettingsFolder, isSecretFile } from "../context/privacy.js";
import { REGENERABLE_DIR_NAMES } from "../session-uploader.js";

/** The regenerable folders that hold build output: a file there may be the agent's own (not a dependency or cache). */
const BUILD_OUTPUT_DIR_NAMES = new Set(["dist", "build", "target", "out", ".next", ".nuxt", ".svelte-kit"]);

/** Whether a portable path lies in a dependency or cache folder (regenerable, not build output), or is `.git/` content. */
function inDependencyDir(path: string): boolean {
  return path.split("/").slice(0, -1).some((part) => part === ".git" || (REGENERABLE_DIR_NAMES.has(part) && !BUILD_OUTPUT_DIR_NAMES.has(part)));
}

export { OUTSIDE_ROOT_NAME };
/** An outside file larger than this is left out (1 GiB, the cap of a session's own build output). */
export const MAX_OUTSIDE_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_OUTSIDE_PATH_CHARS = 4_096;
/** Pseudo and device file systems: nothing under them is a file the agent made or read as data. */
const SYSTEM_PREFIXES = ["/proc", "/sys", "/dev", "/run", "/private/var/run", "/System/Volumes"];
/**
 * Folders under the home directory that only hold caches, package stores or
 * other apps' state (dependency and cache folders, beyond the per-component
 * names inDependencyDir knows).
 */
const HOME_CACHE_DIRS = [
  ".cache", ".npm", ".pnpm-store", ".yarn", ".bun/install", ".cargo/registry", ".cargo/git", ".rustup", ".gradle", ".m2",
  ".nuget", ".local/share/pnpm", ".local/share/opencode", ".local/state/opencode", ".config/opencode", ".omnirush", ".pi",
  ".config/omnirush", ".config/OmniRush", "Library/Application Support/OmniRush", "AppData/Roaming/OmniRush",
  "Library/Caches", "AppData/Local/npm-cache", "go/pkg/mod",
];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isOutsideArchivePath(path: string): boolean {
  return path.startsWith(`${OUTSIDE_ROOT_NAME}/`);
}

/**
 * The archive path of an absolute file path, or null when it cannot be one
 * (relative, a UNC share or device path, `.`/`..`/empty components, NUL).
 * `win32` forces the Windows form (tests).
 */
export function outsideArchivePath(absolute: string, win32 = sep === "\\"): string | null {
  if (!absolute || absolute.length > MAX_OUTSIDE_PATH_CHARS || absolute.includes("\0") || LONE_SURROGATE.test(absolute)) return null;
  let parts: string[];
  if (win32) {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
    if (!match) return null;
    parts = [match[1]!.toUpperCase(), ...match[2]!.split(/[\\/]/)];
    if (parts.slice(1).some((part) => part.includes(":"))) return null;
  } else {
    if (!absolute.startsWith("/")) return null;
    parts = absolute.slice(1).split("/");
  }
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return `${OUTSIDE_ROOT_NAME}/${parts.join("/")}`;
}

/** The absolute file path an outside archive path stands for (the inverse of outsideArchivePath), or null. */
export function outsideSourcePath(archivePath: string, win32 = sep === "\\"): string | null {
  if (!isOutsideArchivePath(archivePath)) return null;
  const parts = archivePath.slice(OUTSIDE_ROOT_NAME.length + 1).split("/");
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (win32) {
    if (!/^[A-Z]$/.test(parts[0]!)) return null;
    return `${parts[0]}:\\${parts.slice(1).join("\\")}`;
  }
  return `/${parts.join("/")}`;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Forms of a directory to compare against: as given and its real path. */
async function forms(dir: string): Promise<string[]> {
  const out = new Set([resolve(dir)]);
  try {
    out.add(await realpath(dir));
  } catch {
    // Not there (yet): only its resolved form can contain anything.
  }
  return [...out];
}

export type OutsideScanOptions = {
  /** The workspace root: a path inside it is a workspace file, never an outside one. */
  root: string;
  /** Absolute app state/temp/data directories: nothing under them is archived. */
  excludedDirs?: readonly string[];
  /** archiveIncludeCredentialFiles: turns the credential filter off entirely. */
  includeCredentialFiles?: boolean;
  /** Hash cache for outside files (looked up and added to, never pruned). */
  hashCache?: ArchiveHashCache;
  signal?: AbortSignal;
  /** The home directory whose cache folders are excluded (os.homedir() by default). */
  home?: string;
  /** Tests: every absolute path the scan lstats or opens, before it does. */
  onAccess?: (path: string) => void;
  maxFileBytes?: number;
};

export type OutsideExclusion = "credential" | "app_state" | "dependency" | "system" | "too_large";

/**
 * Why an absolute (canonical) outside path must not be archived, else null:
 * the same rules as a workspace file (credential files and stores, the app's
 * state), plus dependency/cache folders and pseudo file systems.
 */
export function outsideExclusion(absolute: string, context: { appDirs: readonly string[]; home: string | null; includeCredentialFiles?: boolean }): OutsideExclusion | null {
  const portablePath = absolute.replaceAll("\\", "/");
  if (sep === "/" && SYSTEM_PREFIXES.some((prefix) => portablePath === prefix || portablePath.startsWith(`${prefix}/`))) return "system";
  if (context.appDirs.some((dir) => inside(dir, absolute))) return "app_state";
  const rel = portablePath.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
  if (context.includeCredentialFiles !== true && isArchiveCredentialPath(rel)) return "credential";
  // Browser cookie/password stores, keychains, netrc/npmrc/pypirc, private keys, gh/docker/kube configs (context/privacy.ts): never.
  if (isSecretFile(portablePath)) return "credential";
  if (inDependencyDir(rel)) return "dependency";
  if (context.home && HOME_CACHE_DIRS.some((dir) => inside(join(context.home!, ...dir.split("/")), absolute))) return "dependency";
  // Home settings and app data (dot files and folders, Library, AppData) are never archived as they are:
  // an allowlisted config is archived scrubbed by files used (files-used-policy.ts), the rest not at all.
  if (context.includeCredentialFiles !== true && isHomeSettingsFolder(absolute, context.home)) return "credential";
  return null;
}

/**
 * Pass 1 for the outside files: each absolute path lstat'ed (never followed
 * if it is a symlink; its folder taken as its real path), excluded by
 * outsideExclusion, then hashed with the identity check of the workspace
 * scan. Paths inside the workspace root are skipped (the workspace scan has
 * them). `gone` holds the archive paths of the paths that hold no regular
 * file any more, so a delta deletes what an earlier archive carried.
 */
export async function scanOutsideFiles(paths: Iterable<string>, options: OutsideScanOptions): Promise<TouchedScanResult> {
  const { signal, hashCache: cache } = options;
  const access = options.onAccess ?? (() => undefined);
  const maxBytes = options.maxFileBytes ?? MAX_OUTSIDE_FILE_BYTES;
  const roots = await forms(options.root);
  const appDirs = (await Promise.all((options.excludedDirs ?? []).map((dir) => forms(dir)))).flat();
  let home: string | null = options.home ?? null;
  if (home === null) {
    try {
      home = (await import("node:os")).homedir() || null;
    } catch {
      home = null;
    }
  }
  const context = { appDirs, home, includeCredentialFiles: options.includeCredentialFiles === true };
  const excluded = emptyExcludedCounts();
  const gone = new Set<string>();
  const entries: Array<ScannedEntry & { source: string }> = [];
  const seen = new Set<string>();

  const visit = async (candidate: string): Promise<void> => {
    signal?.throwIfAborted();
    if (typeof candidate !== "string" || !isAbsolute(candidate)) return;
    const given = resolve(candidate);
    if (roots.some((root) => inside(root, given))) return;
    const lexical = outsideArchivePath(given);
    if (!lexical) return;
    const early = outsideExclusion(given, context);
    if (early) {
      count(early);
      return;
    }
    // The file's folder as its real path: a symlinked folder (macOS /tmp) is
    // resolved, the file itself never is.
    let folder: string;
    try {
      access(dirname(given));
      folder = await realpath(dirname(given));
    } catch {
      gone.add(lexical);
      return;
    }
    const absolute = join(folder, basename(given));
    const path = outsideArchivePath(absolute);
    if (!path) return;
    if (path !== lexical) gone.add(lexical);
    if (seen.has(path)) return;
    seen.add(path);
    if (roots.some((root) => inside(root, absolute))) return;
    const reason = outsideExclusion(absolute, context);
    if (reason) {
      count(reason);
      return;
    }
    let stats: BigIntStats;
    try {
      access(absolute);
      stats = await lstat(absolute, { bigint: true });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") gone.add(path);
      else excluded.unreadable += 1;
      return;
    }
    if (stats.isDirectory()) {
      // A touched folder is never expanded.
      gone.add(path);
      return;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      gone.add(path);
      excluded.special += 1;
      return;
    }
    if (stats.size > BigInt(maxBytes)) {
      gone.add(path);
      return;
    }
    entries.push({ path, type: "file", size: Number(stats.size), sha256: null, ...statFields(stats), source: absolute });
  };
  const count = (reason: OutsideExclusion): void => {
    if (reason === "credential") excluded.credential += 1;
    else if (reason === "app_state") excluded.app_state += 1;
    else if (reason === "system") excluded.special += 1;
    // Dependency/cache folders and oversized files are left out like the regenerable folders: not counted.
  };

  await forEachBounded([...new Set(paths)], STAT_CONCURRENCY, visit);

  const unreadable = new Set<ScannedEntry>();
  const buffers: Buffer[] = [];
  await forEachBounded(entries, HASH_CONCURRENCY, async (entry) => {
    signal?.throwIfAborted();
    const cached = cache?.lookup(entry) ?? null;
    if (cached) {
      entry.sha256 = cached;
      return;
    }
    const buffer = buffers.pop() ?? Buffer.allocUnsafe(HASH_READ_BYTES);
    try {
      access(entry.source);
      const sha256 = await hashIdentical(entry.source, entry, buffer, signal);
      if (sha256 === null) {
        unreadable.add(entry);
        cache?.forget(entry.path);
        return;
      }
      entry.sha256 = sha256;
      cache?.remember(entry);
    } finally {
      buffers.push(buffer);
    }
  });
  signal?.throwIfAborted();
  excluded.unreadable += unreadable.size;
  const kept: ScannedEntry[] = entries.filter((entry) => !unreadable.has(entry)).map(({ source: _source, ...entry }) => entry);
  kept.sort((left, right) => compareArchivePaths(left.path, right.path));
  for (const entry of kept) gone.delete(entry.path);
  return { entries: kept, gone, excluded, ignored: 0 };
}

/** SHA-256 of the first entry.size bytes of the very file pass 1 lstat'ed (same st_dev and st_ino), else null. */
async function hashIdentical(absolute: string, entry: ScannedEntry, buffer: Buffer, signal?: AbortSignal): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, OPEN_ENTRY_FLAGS);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || !isSameFileIdentity(entry, stats)) return null;
    const hash = createHash("sha256");
    let remaining = entry.size;
    while (remaining > 0) {
      if (signal?.aborted) return null;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return remaining === 0 ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Pack time: whether the folder of an outside file is still its real path
 * (no folder on the way was swapped for a symlink since pass 1). The file
 * itself is opened with O_NOFOLLOW and checked against pass 1's identity.
 */
export async function outsideFolderIsReal(absolute: string): Promise<boolean> {
  try {
    return (await realpath(dirname(absolute))) === dirname(absolute);
  } catch {
    return false;
  }
}

/** The absolute paths an archive baseline holds outside the workspace (to see them change or go). */
export function outsideSourcesOf(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const source = outsideSourcePath(path);
    if (source) out.push(source);
  }
  return out;
}
