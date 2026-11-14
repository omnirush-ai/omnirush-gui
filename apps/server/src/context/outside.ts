// #10 Folders outside the project the agent built or ran things in, and the
// scripts outside the project it executed; #21 files it wrote under a temp
// folder and used again later.
//
//   - A folder a command created (mkdir, git clone, npm create, cargo new, a
//     recursive copy, an extraction) is captured whole; a folder it only
//     worked in (cd, a tool's workdir) contributes the files created or
//     changed since the session started. Each file is reported to the
//     project archive (byte-exact under `__outside__/`, with the archive's
//     policy, denylist and caps), regenerable folders (node_modules, .venv,
//     build output, .git, …) are left out, and the session's total is capped
//     (200 MiB). A `context.outside_folder` event describes each folder.
//   - A script outside the project the agent ran (bash x.sh, python x.py,
//     ./x, source x) and a temp file it wrote and later read or ran are
//     recorded as `context.outside_file` with their text (scrubbed, 256 KiB
//     per file, 4 MiB per session) and reported to the archive too.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

import { commandEffects, toolKind, toolPaths, type FolderVia, type ToolCall } from "./commands.js";
import { belowDir } from "../session-archive/files-used-policy.js";
import { capUtf8, isHomeSettingsFolder, isSecretFile, isSecretFolder, isTextBuffer, tildePath, tildeText, type PrivacyContext, type Scrubber } from "./privacy.js";

export const MAX_OUTSIDE_FOLDER_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_OUTSIDE_FOLDER_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_INLINE_FILE_BYTES = 256 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FOLDER_ENTRIES = 20_000;
const MAX_FOLDER_DEPTH = 12;
const MAX_FOLDERS = 100;
const MAX_TRACKED_TEMP = 5_000;

export const SKIPPED_DIR_NAMES = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "dist", "build", "target", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".gradle", ".dart_tool",
  "Pods", "DerivedData", "vendor", "bower_components", "site-packages", ".pnpm-store", ".yarn",
]);

export type OutsideFolderEvent = {
  path: string;
  reason: "created" | "modified";
  via: FolderVia;
  tool_call_id: string | null;
  files: number;
  bytes: number;
  truncated: boolean;
  excluded_regenerable: number;
};

export type OutsideFileEvent = {
  kind: "temp" | "executed";
  path: string;
  tool_call_id: string | null;
  written_by: string | null;
  sha256: string;
  bytes: number;
  content: string | null;
  binary?: true;
  truncated?: true;
};

/** The real path (Windows: long names for 8.3 short ones like `SNEHAS~1`); throws when it is not there. */
type RealPath = (path: string) => string;

/** The temp folders of this machine (as given, and on Windows as real paths). */
export function tempRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, real: RealPath = realpathSync.native): string[] {
  const roots = new Set<string>();
  const path = platform === "win32" ? win32 : posix;
  const add = (value: string | undefined) => {
    if (!value || !path.isAbsolute(value)) return;
    roots.add(path.resolve(value));
    // Windows: the long form too (TEMP is often written with an 8.3 short name, the paths with the long one).
    if (platform !== "win32") return;
    try {
      roots.add(real(value));
    } catch {
      // Not on this machine.
    }
  };
  add(tmpdir());
  add(env.TMPDIR);
  add(env.TEMP);
  add(env.TMP);
  if (platform !== "win32") {
    add("/tmp");
    add("/var/tmp");
    add("/private/tmp");
    add("/private/var/tmp");
  } else {
    add(env.SystemRoot ? join(env.SystemRoot, "Temp") : "C:\\Windows\\Temp");
  }
  return [...roots];
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * A Windows path with an 8.3 short name in it (`C:\\Users\\SNEHAS~1\\...`) in long form: its deepest existing
 * folder's real path with the rest appended. Any other path as it is.
 */
export function longPath(path: string, real: RealPath = realpathSync.native): string {
  if (!/^[A-Za-z]:[\\/]/.test(path) || !/~\d/.test(path)) return path;
  for (let head = path, rest = ""; ; ) {
    try {
      return rest ? win32.join(real(head), rest) : real(head);
    } catch {
      const parent = win32.dirname(head);
      if (parent === head) return path;
      rest = win32.join(win32.basename(head), rest);
      head = parent;
    }
  }
}

/** macOS per-user temp folders: /private/var/folders/xx/yyyy/T (and /var/folders/…). Short names compare as long ones. */
export function isTempPath(path: string, roots: readonly string[], real: RealPath = realpathSync.native): boolean {
  if (/^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(path)) return true;
  const long = longPath(path, real);
  return roots.some((root) => belowDir(root, path) || (long !== path && belowDir(root, long)));
}

export type OutsideOptions = {
  root: string;
  sessionStartMs: number;
  privacy: PrivacyContext;
  scrub: Scrubber;
  /**
   * The archive's exclusion of an absolute path (credential files and
   * stores, the app's state, dependency/cache folders, pseudo file systems),
   * or null when it may be archived.
   */
  exclusion: (absolute: string) => string | null;
  /** Reports a file to the project archive (byte-exact copy under `__outside__/`). */
  reportPath: (absolute: string) => void;
  tempRoots?: string[];
  /** This account's uid (tests; process.getuid() by default, none on Windows). */
  uid?: number | null;
  maxFolderBytes?: number;
  maxInlineBytes?: number;
};

type Folder = { path: string; via: FolderVia; created: boolean; callId: string | null; reported: Set<string>; bytes: number; regenerable: number; truncated: boolean };

/** Per-session tracker; feed it each turn's tool calls in order. */
export class OutsideTracker {
  private readonly roots: string[];
  private readonly temps: string[];
  private readonly folders = new Map<string, Folder>();
  private readonly tempWrites = new Map<string, string | null>();
  private readonly tempFolders = new Map<string, string | null>();
  private readonly inlined = new Set<string>();
  private folderBytes = 0;
  private inlineBytes = 0;
  private realRoot: string | null = null;

  constructor(private readonly options: OutsideOptions) {
    this.roots = [resolve(options.root)];
    this.temps = options.tempRoots ?? tempRoots();
  }

  private outsideProject(path: string): boolean {
    return !this.roots.some((root) => within(root, path)) && !(this.realRoot && within(this.realRoot, path));
  }

  /** A folder that must never be expanded: the home, a file system root, an ancestor of the project, a system or excluded folder. */
  private unsafeFolder(path: string): boolean {
    const home = this.options.privacy.home;
    if (home && (path === resolve(home) || within(path, resolve(home)))) return true;
    if (resolve(path) === resolve(path, "/") || /^[A-Za-z]:\\?$/.test(path)) return true;
    if (this.roots.some((root) => within(path, root))) return true;
    if (this.temps.some((temp) => path === temp || within(path, temp))) return true;
    if (/^\/[^/]*$/.test(path)) return true;
    if (/^\/(?:usr|etc|bin|sbin|lib|lib32|lib64|proc|sys|dev|run|boot|System|Library|private\/etc|private\/var\/db)(?:\/|$)/.test(path)) return true;
    if (/^[A-Za-z]:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData)(?:\\|$)/i.test(path)) return true;
    return this.options.exclusion(path) !== null;
  }

  /**
   * A folder the agent only worked in (did not create this session) whose
   * files are never captured: the user's settings and app data under home
   * (home dot-folders, ~/Library, AppData, ~/snap), browser profiles,
   * password managers and keychains, and any folder inside a git work tree
   * owned by another account.
   */
  async refusedWorkFolder(path: string): Promise<string | null> {
    if (isHomeSettingsFolder(path, this.options.privacy.home)) return "home_settings";
    if (isSecretFolder(path)) return "secret_store";
    const uid = this.options.uid !== undefined ? this.options.uid : typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null) {
      for (let dir = path, depth = 0; depth < 64; depth += 1) {
        try {
          const git = await stat(join(dir, ".git"));
          if (git.uid !== uid) return "foreign_git";
          break;
        } catch {
          // No .git here: look further up.
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return null;
  }

  /** Whether a file outside the project may be captured: the archive's exclusions plus the credential files. */
  private fileExcluded(path: string): boolean {
    return isSecretFile(path) || this.options.exclusion(path) !== null;
  }

  /** The outside folders of the session (created or worked in, not refused), absolute. */
  folderPaths(): string[] {
    return [...this.folders.keys()];
  }

  /** Processes one turn's tool calls; returns the events to record. */
  async processCalls(calls: ToolCall[]): Promise<{ folders: OutsideFolderEvent[]; files: OutsideFileEvent[] }> {
    if (this.realRoot === null) {
      try {
        this.realRoot = await realpath(this.options.root);
      } catch {
        this.realRoot = resolve(this.options.root);
      }
    }
    const home = this.options.privacy.home;
    const files: OutsideFileEvent[] = [];
    const touchedFolders = new Set<Folder>();
    const useTemp = async (path: string, call: ToolCall, kind: "temp" | "executed") => {
      const writer = this.tempWrites.get(path) ?? [...this.tempFolders].find(([folder]) => within(folder, path))?.[1];
      const known = this.tempWrites.has(path) || [...this.tempFolders.keys()].some((folder) => within(folder, path));
      if (!known) return;
      const event = await this.inline(path, kind === "executed" ? "temp" : kind, call.callId, writer ?? null);
      if (event) files.push(event);
    };
    for (const call of calls) {
      const kind = toolKind(call.tool);
      if (call.cwd && this.outsideProject(call.cwd) && resolve(call.cwd) !== resolve(this.options.root)) {
        const folder = this.addFolder(call.cwd, "workdir", false, call.callId);
        if (folder) touchedFolders.add(folder);
      }
      if (kind === "write") {
        for (const path of toolPaths(call, home)) if (isTempPath(path, this.temps)) this.trackTemp(path, call.callId);
        continue;
      }
      if (kind === "read") {
        for (const path of toolPaths(call, home)) await useTemp(path, call, "temp");
        continue;
      }
      if (kind !== "shell" || !call.command) continue;
      const effects = commandEffects(call.command, call.cwd, home);
      // Uses first (a read of a file written by an earlier call), then this call's own writes.
      for (const path of new Set(effects.named)) if (!effects.writes.includes(path)) await useTemp(path, call, "temp");
      for (const path of effects.writes) if (isTempPath(path, this.temps)) this.trackTemp(path, call.callId);
      for (const entry of effects.folders) {
        if (isTempPath(entry.path, this.temps) && entry.created) this.tempFolders.set(entry.path, call.callId);
        if (!this.outsideProject(entry.path)) continue;
        const folder = this.addFolder(entry.path, entry.via, entry.created, call.callId);
        if (folder) touchedFolders.add(folder);
      }
      for (const path of new Set(effects.executed)) {
        if (!this.outsideProject(path)) continue;
        if (isTempPath(path, this.temps)) {
          await useTemp(path, call, "temp");
          if (!this.tempWrites.has(path)) {
            const event = await this.inline(path, "executed", call.callId, null);
            if (event) files.push(event);
          }
          continue;
        }
        const event = await this.inline(path, "executed", call.callId, null);
        if (event) files.push(event);
      }
    }
    const folders: OutsideFolderEvent[] = [];
    for (const folder of touchedFolders) {
      const event = await this.scanFolder(folder);
      if (event) folders.push(event);
    }
    return { folders, files };
  }

  private trackTemp(path: string, callId: string | null): void {
    if (this.tempWrites.size >= MAX_TRACKED_TEMP) return;
    this.tempWrites.set(path, callId);
  }

  private addFolder(path: string, via: FolderVia, created: boolean, callId: string | null): Folder | null {
    const existing = this.folders.get(path);
    if (existing) {
      if (created && !existing.created) {
        existing.created = true;
        existing.via = via;
      }
      return existing;
    }
    // Inside a folder already tracked: that one covers it.
    for (const folder of this.folders.values()) if (within(folder.path, path) && (folder.created || !created)) return folder;
    if (this.folders.size >= MAX_FOLDERS || this.unsafeFolder(path)) return null;
    // Only worked in: never the user's settings, app data or secret stores (checked again at scan time).
    if (!created && (isHomeSettingsFolder(path, this.options.privacy.home) || isSecretFolder(path))) return null;
    const folder: Folder = { path, via, created, callId, reported: new Set(), bytes: 0, regenerable: 0, truncated: false };
    this.folders.set(path, folder);
    return folder;
  }

  /** Reports the folder's files (all for a created folder, those changed this session otherwise) within the budget. */
  private async scanFolder(folder: Folder): Promise<OutsideFolderEvent | null> {
    const limit = this.options.maxFolderBytes ?? MAX_OUTSIDE_FOLDER_TOTAL_BYTES;
    let rootStats;
    try {
      rootStats = await lstat(folder.path);
    } catch {
      return null;
    }
    if (!rootStats.isDirectory()) return null;
    // A folder older than the session that a command claims to create (mkdir -p on an existing one) is only "modified".
    const createdNow = folder.created && (rootStats.birthtimeMs || rootStats.ctimeMs) >= this.options.sessionStartMs - 1_000;
    // Not made this session: a work folder, which must not be a settings folder, a secret store or someone else's repository.
    if (!createdNow && (await this.refusedWorkFolder(folder.path)) !== null) {
      this.folders.delete(folder.path);
      return null;
    }
    let entries = 0;
    let regenerable = 0;
    let added = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_FOLDER_DEPTH || entries >= MAX_FOLDER_ENTRIES) {
        folder.truncated = true;
        return;
      }
      let children;
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        entries += 1;
        if (entries >= MAX_FOLDER_ENTRIES) {
          folder.truncated = true;
          return;
        }
        const path = join(dir, child.name);
        if (child.isDirectory()) {
          // Browser profiles, password managers, keychains, ~/.ssh-like folders: never, even inside a folder the agent made.
          if (isSecretFolder(child.name)) continue;
          if (SKIPPED_DIR_NAMES.has(child.name)) {
            regenerable += 1;
            continue;
          }
          await walk(path, depth + 1);
          continue;
        }
        if (!child.isFile() || folder.reported.has(path)) continue;
        let stats;
        try {
          stats = await lstat(path);
        } catch {
          continue;
        }
        // Modified: written since the session started (mtime; ctime also moves on a chmod or a metadata change).
        if (!createdNow && stats.mtimeMs < this.options.sessionStartMs) continue;
        if (stats.size > MAX_OUTSIDE_FOLDER_FILE_BYTES || this.fileExcluded(path)) continue;
        if (this.folderBytes + stats.size > limit) {
          folder.truncated = true;
          continue;
        }
        this.folderBytes += stats.size;
        folder.bytes += stats.size;
        folder.reported.add(path);
        added += 1;
        try {
          this.options.reportPath(path);
        } catch {
          // The archive's bookkeeping never stops capture.
        }
      }
    };
    await walk(folder.path, 0);
    folder.regenerable = Math.max(folder.regenerable, regenerable);
    if (added === 0 && folder.reported.size === 0) return null;
    if (added === 0) return null;
    return {
      path: tildePath(folder.path, this.options.privacy),
      reason: createdNow ? "created" : "modified",
      via: folder.via,
      tool_call_id: folder.callId,
      files: folder.reported.size,
      bytes: folder.bytes,
      truncated: folder.truncated,
      excluded_regenerable: folder.regenerable,
    };
  }

  /** One file's text for the record (once per content), reported to the archive as well. */
  private async inline(path: string, kind: "temp" | "executed", callId: string | null, writer: string | null): Promise<OutsideFileEvent | null> {
    if (isSecretFile(path)) return null;
    const reason = this.options.exclusion(path);
    if (reason && !(reason === "dependency" && isTempPath(path, this.temps))) return null;
    let buffer: Buffer;
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.size > 64 * 1024 * 1024) return null;
      buffer = await readFile(path);
    } catch {
      return null;
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const key = `${path}\0${sha256}`;
    if (this.inlined.has(key)) return null;
    this.inlined.add(key);
    if (!reason) {
      try {
        this.options.reportPath(path);
      } catch {
        // Ignored.
      }
    }
    const text = isTextBuffer(buffer);
    let content: string | null = null;
    let truncated = false;
    if (text) {
      const room = Math.min(MAX_INLINE_FILE_BYTES, (this.options.maxInlineBytes ?? MAX_INLINE_TOTAL_BYTES) - this.inlineBytes);
      if (room > 0) {
        const capped = capUtf8(buffer.toString("utf8"), room);
        truncated = capped.truncated;
        this.inlineBytes += Buffer.byteLength(capped.text);
        content = tildeText(this.options.scrub.content(path, capped.text), this.options.privacy);
      } else {
        truncated = true;
      }
    }
    return {
      kind,
      path: tildePath(path, this.options.privacy),
      tool_call_id: callId,
      written_by: writer,
      sha256,
      bytes: buffer.length,
      content,
      ...(text ? {} : { binary: true as const }),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }
}
