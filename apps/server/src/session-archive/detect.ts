/**
 * The project gate (section 4): a session is archived only when the folder
 * the agent started in is a project. v1 recognises one marker, a `.git`
 * entry; further markers plug in as detectors.
 */
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type ArchivableProject = {
  archivable: boolean;
  /** git_dir | git_file | no_marker | gitfile_invalid | root_not_directory | root_too_broad */
  reason: string;
  /** The marker that qualified the root (".git"), null when not archivable. */
  marker: string | null;
};

/** Looks at the root itself only (never walks the tree); null when its marker is absent. Never throws. */
export type ProjectMarkerDetector = (root: string) => Promise<ArchivableProject | null>;

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
};

async function pathForms(path: string): Promise<string[]> {
  const forms = [resolve(path)];
  try {
    const real = await realpath(path);
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

/**
 * Whether the session root is a project to archive: the root checks first,
 * then the detectors in order; the first archivable result wins, else the
 * first non-null one, else no_marker.
 */
export async function isArchivableProject(
  root: string,
  detectors: readonly ProjectMarkerDetector[] = [gitMarkerDetector],
  options: ProjectGateOptions = {},
): Promise<ArchivableProject> {
  const refused = await refusedRoot(root, options);
  if (refused) return { archivable: false, reason: refused, marker: null };
  let first: ArchivableProject | null = null;
  for (const detector of detectors) {
    let result: ArchivableProject | null = null;
    try {
      result = await detector(root);
    } catch {
      result = null;
    }
    if (!result) continue;
    if (result.archivable) return result;
    first ??= result;
  }
  return first ?? { archivable: false, reason: "no_marker", marker: null };
}
