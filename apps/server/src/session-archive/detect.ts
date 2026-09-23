/**
 * The project gate (section 4): a session is archived only when the folder
 * the agent started in is a project. v1 recognises one marker, a `.git`
 * entry, in the folder itself or in the nearest parent that may hold one
 * (a folder inside a repository); further markers plug in as detectors. The
 * all-folders and touched-files policies (4.4) add one more,
 * `folderDetector`: any other folder that is not too broad to be one project
 * and is not, or is not inside, a credential, app-data or system location.
 * Git roots never get those refusals.
 */
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path, { isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "node:path";

import { isCollectorDirectoryDenied } from "../workspace-collector.js";
import type { ArchivePolicy } from "./policy.js";

export type ArchivableProject = {
  archivable: boolean;
  /** git_dir | git_file | git_parent | folder | touched | no_marker | gitfile_invalid | root_not_directory | root_too_broad */
  reason: string;
  /** The marker that qualified the root (".git", "folder", "touched"), null when not archivable. */
  marker: string | null;
};

/** Looks at the root (and, for gitParentDetector, its parents), never below it; null when its marker is absent. Never throws. */
export type ProjectMarkerDetector = (root: string, options?: ProjectGateOptions) => Promise<ArchivableProject | null>;

const MAX_GITFILE_BYTES = 4096;

async function readSmallFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `.git` as a directory, or as a worktree/submodule gitfile (`gitdir: ...`). */
export const gitMarkerDetector: ProjectMarkerDetector = async (root) => {
  try {
    const marker = join(root, ".git");
    const stats = await lstat(marker);
    if (stats.isDirectory()) return { archivable: true, reason: "git_dir", marker: ".git" };
    if (!stats.isFile()) return null;
    const invalid: ArchivableProject = { archivable: false, reason: "gitfile_invalid", marker: null };
    if (stats.size > MAX_GITFILE_BYTES) return invalid;
    const content = await readSmallFile(marker, MAX_GITFILE_BYTES);
    if (!content) return null;
    const firstLine = content.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
    return /^gitdir: .+/.test(firstLine) ? { archivable: true, reason: "git_file", marker: ".git" } : invalid;
  } catch {
    return null;
  }
};

export type ProjectGateOptions = {
  /** The desktop's own state, temp and data directories; a root equal to or inside one is refused. */
  appDirs?: readonly string[];
  /** Tests only; defaults to os.homedir(). */
  homeDir?: string;
  /** Tests only; replaces the system and app directories gitParentDetector never looks in. */
  systemDirs?: readonly string[];
};

async function pathForms(target: string): Promise<string[]> {
  const forms = [resolve(target)];
  try {
    const real = await realpath(target);
    if (!forms.includes(real)) forms.push(real);
  } catch {
    // A directory that does not exist yet is compared by its resolved form only.
  }
  return forms;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function isFilesystemRoot(path: string): boolean {
  if (parse(path).root === path) return true;
  // macOS volume mount points: /Volumes and /Volumes/<name>.
  return /^\/Volumes(?:\/[^/]+)?\/?$/.test(path);
}

/** Why a root may never be archived even with a marker (section 4.3), or null when it may. */
async function refusedRoot(root: string, options: ProjectGateOptions): Promise<string | null> {
  if (!isAbsolute(root)) return "root_not_directory";
  try {
    if (!(await lstat(root)).isDirectory()) return "root_not_directory";
  } catch {
    return "root_not_directory";
  }
  const roots = await pathForms(root);
  const homes = await pathForms(options.homeDir ?? homedir());
  const appDirs = (await Promise.all((options.appDirs ?? []).map(pathForms))).flat();
  for (const candidate of roots) {
    if (isFilesystemRoot(candidate)) return "root_too_broad";
    if (homes.some((home) => samePath(candidate, home))) return "root_too_broad";
    if (appDirs.some((dir) => isSameOrInside(candidate, dir))) return "root_too_broad";
  }
  return null;
}

// --- a folder inside a repository ---------------------------------------------

type PathApi = Pick<typeof path, "dirname" | "join" | "parse" | "relative" | "isAbsolute" | "sep">;

/** System and app directories: a `.git` in one, or anywhere inside one, never qualifies a folder below it. */
const POSIX_SYSTEM_DIRS = ["/System", "/Library", "/Applications", "/usr", "/private", "/var", "/etc", "/opt"];
/** The same on Windows, on every drive and share. */
const WIN32_SYSTEM_NAMES = ["Windows", "Program Files", "Program Files (x86)", "ProgramData"];

function sameOrInsideFolded(child: string, parent: string, p: PathApi): boolean {
  const rel = p.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith(`..${p.sep}`) && rel !== ".." && !p.isAbsolute(rel));
}

/** Linux system folders guarded under a UNC share root too (a WSL distro: \\wsl$\<distro>\etc, \\wsl.localhost\<distro>\root). */
const UNC_POSIX_SYSTEM_NAMES = ["usr", "etc", "var", "opt", "root"];

/** The root that `dir`'s home and system folders hang off: its drive or UNC share root, or /Volumes/<name>/ on posix. */
function volumeRoot(dir: string, p: PathApi): string {
  if (p.sep === "/") {
    const mounted = /^\/Volumes\/[^/]+/i.exec(dir);
    if (mounted) return `${mounted[0]}/`;
  }
  return p.parse(dir).root;
}

/** Why the parent walk must stop at `dir` without looking for `.git` in it, or null. Case-insensitive, so it errs on the side of stopping. */
function parentWalkStop(dir: string, homes: readonly string[], p: PathApi, systemDirs?: readonly string[]): string | null {
  if (p.parse(dir).root === dir || (p.sep === "/" && /^\/Volumes(?:\/[^/]+)?\/?$/i.test(dir))) return "filesystem_root";
  if (homes.some((home) => p.relative(home.toLowerCase(), dir.toLowerCase()) === "")) return "home";
  // Any account's home on any volume: /Users/<name>, /home/<name>, <drive>:\Users\<name>,
  // /Volumes/<disk>/Users/<name>, \\wsl$\<distro>\home\<name>.
  const vroot = volumeRoot(dir, p);
  if (/^(?:users|home)$/i.test(p.relative(vroot, p.dirname(dir)))) return "home";
  const unc = p.sep === "\\" && /^[\\/]{2}[^\\/?.]/.test(vroot);
  // A share of home folders: \\nas\homes\<name>, \\server\users\<name>.
  if (unc && p.relative(vroot, p.dirname(dir)) === "" && /[\\/](?:users|homes?)[\\/]?$/i.test(vroot)) return "home";
  const system =
    systemDirs ?? (p.sep === "/" ? POSIX_SYSTEM_DIRS : [...WIN32_SYSTEM_NAMES, ...(unc ? UNC_POSIX_SYSTEM_NAMES : [])].map((name) => p.join(vroot, name)));
  if (system.some((guarded) => sameOrInsideFolded(dir, guarded, p))) return "system_dir";
  return null;
}

/**
 * The parents of `root` that gitParentDetector may look in for `.git`,
 * nearest first. The walk stops before the home directory or any account's home on any volume (dotfiles repos),
 * a filesystem, drive or UNC share root, or a system or app directory, so
 * none of those, nor anything above them, can qualify the root.
 */
export function gitParentCandidates(
  root: string,
  homes: readonly string[],
  p: PathApi = path,
  systemDirs?: readonly string[],
): string[] {
  // Win32 namespace prefixes: \\?\UNC\server\share -> \\server\share, \\?\C:\ -> C:\.
  const start = p.sep === "\\" ? root.replace(/^\\\\[?.]\\UNC\\/i, "\\\\").replace(/^\\\\[?.]\\(?=[a-z]:)/i, "") : root;
  const candidates: string[] = [];
  let current = start;
  for (;;) {
    const parent = p.dirname(current);
    if (parent === current || parentWalkStop(parent, homes, p, systemDirs)) return candidates;
    candidates.push(parent);
    current = parent;
  }
}

/** A mount point (the root of another filesystem) is a drive root too. Errs on the side of true. */
async function isMountPoint(dir: string): Promise<boolean> {
  try {
    const [own, above] = await Promise.all([lstat(dir), lstat(path.dirname(dir))]);
    return own.dev !== above.dev;
  } catch {
    return true;
  }
}

/**
 * A root without `.git` that sits inside a repository, e.g. `~/proj/packages/app`
 * with `~/proj/.git`: archivable as git_parent when the nearest parent holding
 * `.git` (a directory with HEAD, or a valid gitfile) lies before any stop of
 * gitParentCandidates or a mount point. Only the root is archived; the
 * parent's `.git` is not. A `.git` of any other kind in the root, or at the
 * nearest parent, and a root inside that `.git`, qualify nothing.
 */
export const gitParentDetector: ProjectMarkerDetector = async (root, options = {}) => {
  try {
    if (await lstat(join(root, ".git")).then(() => true, () => false)) return null;
    const start = await realpath(root).catch(() => resolve(root));
    const homes = await pathForms(options.homeDir ?? homedir());
    for (const dir of gitParentCandidates(start, homes, path, options.systemDirs)) {
      if (await isMountPoint(dir)) return null;
      if (!(await lstat(join(dir, ".git")).then(() => true, () => false))) continue;
      // A root inside the repository's own .git (hooks, worktrees) would upload its history.
      if (relative(dir, start).split(sep).some((part) => part.toLowerCase() === ".git")) return null;
      const found = await gitMarkerDetector(dir);
      if (!found?.archivable) return null;
      // A .git folder without HEAD is one git itself skips, walking on up to a repository the walk never reached.
      if (found.reason === "git_dir" && !(await lstat(join(dir, ".git", "HEAD")).then((stats) => stats.isFile(), () => false))) return null;
      return { archivable: true, reason: "git_parent", marker: ".git" };
    }
    return null;
  } catch {
    return null;
  }
};

/** The gate's detectors: `.git` in the root first, then in the nearest parent. */
export const defaultProjectDetectors: readonly ProjectMarkerDetector[] = [gitMarkerDetector, gitParentDetector];

// --- a folder without git (the all-folders and touched-files policies) ----------

/** The marker of a folder archived by the all-folders policy (4.4); the server accepts it only while that policy is on. */
export const FOLDER_MARKER = "folder";
/** The marker of the files the agent touched in a plain folder (touched-files policy); the server accepts it only while that policy is on. */
export const TOUCHED_MARKER = "touched";

/** Top-level system and app directories of macOS and Linux (one list: the other system's names are absent). */
const FOLDER_POSIX_SYSTEM_DIRS = [
  "/System", "/Library", "/Applications", "/private", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/cores",
  "/proc", "/sys", "/dev", "/boot", "/lib", "/lib64", "/run", "/root", "/snap", "/nix",
];
/** Windows system directories, on every drive. */
const WINDOWS_SYSTEM_DIRS = ["Windows", "Windows.old", "Program Files", "Program Files (x86)", "ProgramData", "$Recycle.Bin", "System Volume Information", "Recovery", "PerfLogs"];
/** Where POSIX systems mount other disks: /Volumes/<disk> (macOS), /mnt/<disk> (Linux, WSL), /media/<user>/<disk>. */
const POSIX_MOUNT_ROOT = /^\/(?:(?:volumes|mnt)(?:\/[^/]+)?|media(?:\/[^/]+){0,2})$/i;
/** Credential stores, wherever they are: a root that is one, or is inside one, is refused (names compared without case). */
const CREDENTIAL_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".password-store", "keychains"]);
/** The same for these folder pairs, wherever they are. */
const CREDENTIAL_DIR_PAIRS: ReadonlyArray<readonly [string, string]> = [[".config", "gcloud"]];
/** App-data folders, wherever they are (Windows' AppData, and macOS' Library/Application Support outside a home too). */
const APP_DATA_DIRS = new Set(["appdata"]);
const APP_DATA_DIR_PAIRS: ReadonlyArray<readonly [string, string]> = [["library", "application support"]];

export type FolderRefusal = "root_too_broad" | "root_app_data" | "root_credentials" | "root_system";

/** What the all-folders gate compares a root with; every path absolute, in `platform`'s syntax. */
export type FolderGateContext = {
  platform: NodeJS.Platform;
  /** The home directory, as given and resolved through symlinks. */
  homes: readonly string[];
  /** The Electron userData directory, the same way; empty when unknown. */
  userData: readonly string[];
};

/**
 * `path` absolute and normalised in `platform`'s syntax; macOS and Windows
 * compare without case. On Windows, `\\?\C:\x` and `\\.\C:\x` are `C:\x`,
 * `\\?\UNC\server\share` is `\\server\share`, and a name loses its trailing
 * dots and spaces (`C:\Users\sam.` is `C:\Users\sam`), as Windows does.
 */
export function foldGatePath(path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    const resolved = posix.resolve(path);
    return platform === "darwin" ? resolved.toLowerCase() : resolved;
  }
  let value = path.replaceAll("/", "\\");
  if (/^\\\\[?.]\\unc\\/i.test(value)) value = `\\\\${value.slice(8)}`;
  else if (/^\\\\[?.]\\[a-z]:/i.test(value)) value = value.slice(4);
  const resolved = win32.resolve(value);
  const { root } = win32.parse(resolved);
  const names = resolved.slice(root.length).split("\\").map((name) => name.replace(/[. ]+$/, "")).filter(Boolean);
  return win32.join(root, ...names).toLowerCase();
}

/**
 * Why `root` may not be archived as a plain folder, or null when it may.
 * Refused, and anything inside them:
 * - a disk or share root, and the home directory or anything above it;
 * - the Electron userData directory, and anything above it;
 * - a credential store wherever it is (`.ssh`, `.aws`, `.gnupg`, `.kube`,
 *   `.docker`, `.azure`, `.password-store`, `Keychains`, `.config/gcloud`),
 *   and any folder the collector's denylist denies as a whole (`keys`,
 *   `secrets`, `credentials*`, `.env*`, `node_modules`, `.git`, ...);
 * - app data wherever it is (`AppData`, `Library/Application Support`);
 * - in the home directory, and in the other folders beside it (other
 *   accounts, Shared, Public; which are refused themselves too): every
 *   folder whose name starts with `.` (config, caches, credentials), and
 *   `Library` on macOS and `snap` on Linux;
 * - outside the home directory, the system and app directories.
 * Every other folder inside the home directory may be archived.
 */
export function refusedFolderRoot(root: string, context: FolderGateContext): FolderRefusal | null {
  const paths = context.platform === "win32" ? win32 : posix;
  const fold = (path: string) => foldGatePath(path, context.platform);
  const within = (child: string, parent: string) => {
    const rel = paths.relative(parent, child);
    return rel === "" || (!rel.startsWith(`..${paths.sep}`) && rel !== ".." && !paths.isAbsolute(rel));
  };
  const isDiskRoot = (path: string) => paths.parse(path).root === path;
  const target = fold(root);
  const homes = context.homes.map(fold);
  if (isDiskRoot(target) || (paths === posix && POSIX_MOUNT_ROOT.test(target))) return "root_too_broad";
  if (homes.some((home) => within(home, target))) return "root_too_broad";
  if (context.userData.map(fold).some((dir) => within(target, dir) || within(dir, target))) return "root_app_data";

  const names = target.slice(paths.parse(target).root.length).split(paths.sep).filter(Boolean).map((name) => name.toLowerCase());
  const hasPair = (pairs: ReadonlyArray<readonly [string, string]>) => names.some((name, index) => pairs.some(([first, second]) => name === first && names[index + 1] === second));
  if (names.some((name) => CREDENTIAL_DIRS.has(name)) || hasPair(CREDENTIAL_DIR_PAIRS) || isCollectorDirectoryDenied(names.join("/"))) return "root_credentials";
  if (names.some((name) => APP_DATA_DIRS.has(name)) || hasPair(APP_DATA_DIR_PAIRS)) return "root_app_data";

  for (const home of homes) {
    if (isDiskRoot(home)) continue;
    // The account folder the root is in: home, or a folder beside it (unless home sits right at a disk root).
    const parent = paths.dirname(home);
    const base = isDiskRoot(parent) ? home : parent;
    if (!within(target, base)) continue;
    const account = base === home ? home : paths.join(parent, paths.relative(parent, target).split(paths.sep)[0]!);
    if (target === account) return "root_too_broad";
    const first = paths.relative(account, target).split(paths.sep)[0]!.toLowerCase();
    if (first.startsWith(".") || (context.platform === "darwin" && first === "library") || (context.platform === "linux" && first === "snap")) return "root_app_data";
  }
  if (homes.some((home) => !isDiskRoot(home) && within(target, home))) return null;
  const systemDirs = paths === win32 ? WINDOWS_SYSTEM_DIRS.map((dir) => paths.join(paths.parse(target).root, dir)) : FOLDER_POSIX_SYSTEM_DIRS;
  return systemDirs.some((dir) => within(target, fold(dir))) ? "root_system" : null;
}

export type FolderGateOptions = {
  /** The Electron userData directory (the desktop sets OMNIRUSH_DESKTOP_USER_DATA_DIR); unknown outside the desktop app. */
  userDataDir?: string;
  /** Tests only; defaults to os.homedir(). */
  homeDir?: string;
};

/**
 * Why `root` may not be archived as a plain folder, in any form of it (as
 * given and resolved through symlinks), or null when it may: the folder
 * refusals shared by the all-folders and the touched-files policies.
 */
export async function folderRootRefusal(root: string, options: FolderGateOptions = {}): Promise<FolderRefusal | null> {
  const context: FolderGateContext = {
    platform: process.platform,
    homes: await pathForms(options.homeDir ?? homedir()),
    userData: options.userDataDir ? await pathForms(options.userDataDir) : [],
  };
  for (const form of await pathForms(root)) {
    const refused = refusedFolderRoot(form, context);
    if (refused) return refused;
  }
  return null;
}

/**
 * The folder markers (4.4): a root with no `.git` entry at all, that
 * folderRootRefusal accepts, is a project with marker `folder` while
 * `policy()` has `allFolders` on, or else with marker `touched` (only the
 * files the agent touches there) while it has `touchedFiles` on. The policy
 * is asked last, only for such a root. Never throws.
 */
export function folderDetector(policy: () => Promise<ArchivePolicy>, options: FolderGateOptions = {}): ProjectMarkerDetector {
  return async (root) => {
    try {
      if (await lstat(join(root, ".git")).then(() => true, () => false)) return null;
      if (await folderRootRefusal(root, options)) return null;
      const answer = await policy();
      if (answer.allFolders) return { archivable: true, reason: "folder", marker: FOLDER_MARKER };
      return answer.touchedFiles ? { archivable: true, reason: "touched", marker: TOUCHED_MARKER } : null;
    } catch {
      return null;
    }
  };
}

/**
 * Whether the session root is a project to archive: the root checks first,
 * then the detectors in order; the first archivable result wins, else the
 * first non-null one, else no_marker.
 */
export async function isArchivableProject(
  root: string,
  detectors: readonly ProjectMarkerDetector[] = defaultProjectDetectors,
  options: ProjectGateOptions = {},
): Promise<ArchivableProject> {
  const refused = await refusedRoot(root, options);
  if (refused) return { archivable: false, reason: refused, marker: null };
  let first: ArchivableProject | null = null;
  for (const detector of detectors) {
    let result: ArchivableProject | null = null;
    try {
      result = await detector(root, options);
    } catch {
      result = null;
    }
    if (!result) continue;
    if (result.archivable) return result;
    first ??= result;
  }
  return first ?? { archivable: false, reason: "no_marker", marker: null };
}
