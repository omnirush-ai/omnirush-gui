/**
 * Skill folders: a skill is a directory holding `SKILL.md` plus optional
 * helper files (`scripts/`, `references/`, `assets/`, ...). The engine loads
 * `<skills dir>/<name>/SKILL.md`, tells the model the skill's base directory,
 * and the model reads or runs the helpers by path relative to it.
 *
 * The desktop uploads a folder or a .zip as a flat list of relative paths and
 * bytes. Everything the client checked is checked again here, because this is
 * the only place that writes the files:
 *
 * - paths are relative, `/`-separated, with no `..`, `.`, empty, absolute,
 *   drive-letter, backslash, colon, control-character or Windows-reserved
 *   component, and no two paths collide case-insensitively (or as file vs dir);
 * - OS/VCS junk (`.DS_Store`, `__MACOSX/`, `.git/`, `node_modules/`, ...) is
 *   dropped and reported as skipped;
 * - anything on the collector's credential denylist (`.env*`, `*.pem`,
 *   `id_rsa`, `secrets/`, "api token.txt", ...) or holding a private-key block
 *   refuses the upload, so a skill never carries a secret into the workspace
 *   (and from there into a project archive);
 * - `SKILL.md` must sit at the root, or inside a single top-level folder that
 *   is then stripped, with YAML frontmatter carrying a kebab-case `name` and a
 *   1-1024 character `description`;
 * - at most {@link SKILL_BUNDLE_LIMITS} files and bytes.
 *
 * Only regular files are ever written (symlinks cannot be expressed in the
 * upload format; the client refuses them earlier with a clearer message), and
 * an install lands atomically: files are staged outside the engine's skill
 * scan directories and renamed into place.
 */
import { chmod, lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ApiError } from "./errors.js";
import { buildFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { listSkills } from "./skills.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { isCollectorPathDenied } from "./workspace-collector.js";
import { projectSkillsDir } from "./workspace-files.js";
import { renameWithRetry } from "./atomic-write.js";

export const SKILL_BUNDLE_LIMITS = {
  /** Files kept after junk is dropped (SKILL.md included). */
  maxFiles: 200,
  /** Entries in the raw upload, junk included. */
  maxRawEntries: 2_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxPathLength: 512,
  maxDepth: 16,
  maxSegmentBytes: 255,
} as const;

/** Upper bound of a bundle request body: base64 inflates by 4/3, plus JSON framing. */
export const SKILL_BUNDLE_MAX_REQUEST_BYTES = Math.ceil(SKILL_BUNDLE_LIMITS.maxTotalBytes * 4 / 3) + 2 * 1024 * 1024;

export const SKILL_MD = "SKILL.md";

export type SkillBundleInputFile = {
  path: string;
  /** File bytes, base64. */
  contentBase64: string;
  /** The source had an executable bit (zip unix mode, local stat). */
  executable?: boolean;
};

export type PreparedSkillFile = {
  path: string;
  bytes: Buffer;
  executable: boolean;
};

export type PreparedSkillBundle = {
  name: string;
  description: string;
  files: PreparedSkillFile[];
  skipped: string[];
  /** The single top-level folder that wrapped SKILL.md and was stripped. */
  strippedRoot: string | null;
  totalBytes: number;
};

export type SkillBundleFileSummary = { path: string; size: number; executable: boolean };

export type SkillConflict = {
  name: string;
  path: string;
  scope: "project" | "global";
  /** Only a skill folder in this workspace's .opencode/skills can be replaced in place. */
  replaceable: boolean;
};

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized", "icon\r"]);
const JUNK_DIRS = new Set(["__macosx", ".git", "node_modules", "__pycache__", ".svn", ".hg", ".venv", ".idea", ".vscode"]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

function invalid(code: string, message: string, paths?: string[]): ApiError {
  return new ApiError(422, code, message, paths && paths.length ? { paths } : undefined);
}

/** Whether a (normalized) relative path is OS/VCS litter that is dropped, not refused. */
export function isSkillBundleJunk(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  if (JUNK_NAMES.has(name) || name.startsWith("._") || name.endsWith(".pyc")) return true;
  return parts.slice(0, -1).some((part) => JUNK_DIRS.has(part.toLowerCase()));
}

/**
 * Normalizes one upload path or throws. A leading "./" is tolerated; nothing
 * else is rewritten, so what the preview shows is what lands on disk.
 */
export function normalizeSkillBundlePath(raw: string): string {
  if (typeof raw !== "string" || !raw) throw invalid("invalid_skill_path", "A file in the upload has no path");
  const path = raw.startsWith("./") ? raw.slice(2) : raw;
  const refuse = (why: string) => invalid("invalid_skill_path", `Unsafe path in upload (${why}): ${raw.slice(0, 200)}`, [raw.slice(0, 200)]);
  if (path.length > SKILL_BUNDLE_LIMITS.maxPathLength) throw refuse("too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw refuse("control character");
  if (path.includes("\\")) throw refuse("backslash");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw refuse("absolute path");
  if (path.includes(":")) throw refuse("colon");
  const parts = path.split("/");
  if (parts.length > SKILL_BUNDLE_LIMITS.maxDepth) throw refuse("nested too deep");
  for (const part of parts) {
    if (!part) throw refuse("empty component");
    if (part === "." || part === "..") throw refuse("parent or current directory reference");
    if (Buffer.byteLength(part) > SKILL_BUNDLE_LIMITS.maxSegmentBytes) throw refuse("name too long");
    if (WINDOWS_RESERVED.test(part) || /[. ]$/.test(part)) throw refuse("name not valid on Windows");
  }
  return parts.join("/");
}

/** Credential-like paths, by the collector's denylist (git internals and node_modules are junk, handled before). */
export function isSkillBundleCredentialPath(path: string): boolean {
  return isCollectorPathDenied(path);
}

function decodeBase64(value: unknown, path: string): Buffer {
  if (typeof value !== "string") throw invalid("invalid_skill_file", `File has no content: ${path}`, [path]);
  if (value.length > Math.ceil(SKILL_BUNDLE_LIMITS.maxFileBytes * 4 / 3) + 4) {
    throw invalid("skill_file_too_large", `File is larger than ${formatBytes(SKILL_BUNDLE_LIMITS.maxFileBytes)}: ${path}`, [path]);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid("invalid_skill_file", `File content is not base64: ${path}`, [path]);
  return Buffer.from(value, "base64");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

type CheckedFile = { path: string; bytes: Buffer; executable: boolean };

/**
 * Normalizes, de-junks and checks a set of files against the path, collision,
 * credential and size rules. Shared by a fresh upload and by adding helper
 * files to an installed skill (`existing` are the paths already there).
 */
function checkFiles(
  input: unknown,
  options: { existing?: SkillBundleFileSummary[] } = {},
): { files: CheckedFile[]; skipped: string[] } {
  if (!Array.isArray(input)) throw invalid("invalid_skill_bundle", "Upload has no file list");
  if (input.length > SKILL_BUNDLE_LIMITS.maxRawEntries) {
    throw invalid("skill_bundle_too_many_files", `Upload has more than ${SKILL_BUNDLE_LIMITS.maxRawEntries} entries`);
  }
  const files: CheckedFile[] = [];
  const skipped: string[] = [];
  const credentials: string[] = [];
  const keyed = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const entry of options.existing ?? []) {
    keyed.set(entry.path.toLowerCase(), entry.path);
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.set(parts.slice(0, i).join("/").toLowerCase(), entry.path);
  }
  const existingKeys = new Set(keyed.keys());
  const uploaded = new Set<string>();
  for (const raw of input) {
    const item = raw as Partial<SkillBundleInputFile> | null;
    const path = normalizeSkillBundlePath(String(item?.path ?? ""));
    if (isSkillBundleJunk(path)) {
      skipped.push(path);
      continue;
    }
    if (isSkillBundleCredentialPath(path)) {
      credentials.push(path);
      continue;
    }
    const key = path.toLowerCase();
    if (uploaded.has(key) || (keyed.has(key) && !existingKeys.has(key))) {
      throw invalid("skill_path_collision", `Two files in the upload share a path (letter case differs at most): ${path}`, [path]);
    }
    uploaded.add(key);
    if (dirs.has(key)) throw invalid("skill_path_collision", `A file and a folder share a path: ${path}`, [path]);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join("/").toLowerCase();
      if (keyed.has(prefix)) throw invalid("skill_path_collision", `A file and a folder share a path: ${parts.slice(0, i).join("/")}`, [path]);
      dirs.set(prefix, path);
    }
    keyed.set(key, path);
    const bytes = decodeBase64(item?.contentBase64, path);
    if (bytes.length > SKILL_BUNDLE_LIMITS.maxFileBytes) {
      throw invalid("skill_file_too_large", `File is larger than ${formatBytes(SKILL_BUNDLE_LIMITS.maxFileBytes)}: ${path}`, [path]);
    }
    if (PRIVATE_KEY_BLOCK.test(bytes.toString("latin1"))) {
      credentials.push(path);
      continue;
    }
    const shebang = bytes.length > 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
    files.push({ path, bytes, executable: item?.executable === true || shebang });
  }
  if (credentials.length) {
    throw invalid(
      "skill_bundle_credentials",
      `The upload contains credential-like files, which skills must not carry. Remove them and try again: ${credentials.slice(0, 10).join(", ")}${credentials.length > 10 ? `, and ${credentials.length - 10} more` : ""}`,
      credentials,
    );
  }
  return { files, skipped };
}

function checkTotals(files: Array<{ bytes?: Buffer; size?: number }>): number {
  if (files.length > SKILL_BUNDLE_LIMITS.maxFiles) {
    throw invalid("skill_bundle_too_many_files", `A skill can hold at most ${SKILL_BUNDLE_LIMITS.maxFiles} files (this one has ${files.length})`);
  }
  const total = files.reduce((sum, file) => sum + (file.bytes?.length ?? file.size ?? 0), 0);
  if (total > SKILL_BUNDLE_LIMITS.maxTotalBytes) {
    throw invalid("skill_bundle_too_large", `A skill can hold at most ${formatBytes(SKILL_BUNDLE_LIMITS.maxTotalBytes)} (this one is ${formatBytes(total)})`);
  }
  return total;
}

/** Parses SKILL.md and returns its frontmatter name/description, or throws a readable 422. */
export function readSkillFrontmatter(content: string): { name: string; description: string; data: Record<string, unknown>; body: string } {
  let data: Record<string, unknown>;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(content.replace(/^﻿/, "")));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    throw invalid("invalid_skill_frontmatter", `SKILL.md frontmatter is not valid YAML: ${reason}`, [SKILL_MD]);
  }
  if (!/^﻿?---\r?\n/.test(content)) {
    throw invalid("invalid_skill_frontmatter", "SKILL.md must start with YAML frontmatter (--- name: ... description: ... ---)", [SKILL_MD]);
  }
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name) throw invalid("invalid_skill_frontmatter", "SKILL.md frontmatter needs a name", [SKILL_MD]);
  if (!description) throw invalid("invalid_skill_frontmatter", "SKILL.md frontmatter needs a description", [SKILL_MD]);
  try {
    validateDescription(description);
  } catch {
    throw invalid("invalid_skill_frontmatter", "SKILL.md description must be 1-1024 characters", [SKILL_MD]);
  }
  return { name, description, data, body };
}

/**
 * Validates an upload and resolves the skill's name. `nameOverride` renames
 * the skill (the frontmatter `name` is rewritten to match, since the engine
 * registers a skill under its frontmatter name).
 */
export function prepareSkillBundle(input: { files: unknown; name?: string | null }): PreparedSkillBundle {
  const { files: checked, skipped } = checkFiles(input.files);
  if (!checked.length) throw invalid("skill_md_missing", "The upload is empty (nothing left after skipping system files)");

  let strippedRoot: string | null = null;
  let files = checked;
  if (!files.some((file) => file.path === SKILL_MD)) {
    const tops = new Set(files.map((file) => (file.path.includes("/") ? file.path.split("/")[0]! : "")));
    const [top] = [...tops];
    if (tops.size === 1 && top && files.some((file) => file.path === `${top}/${SKILL_MD}`)) {
      strippedRoot = top;
      files = files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }));
    } else {
      const nearMiss = files.find((file) => /(^|\/)skill\.md$/i.test(file.path));
      throw invalid(
        "skill_md_missing",
        nearMiss
          ? `SKILL.md must be at the top of the skill folder (found ${nearMiss.path}; the name is case-sensitive)`
          : "No SKILL.md at the top of the upload. A skill is a folder with SKILL.md at its root (or a .zip of that folder).",
      );
    }
  }
  const totalBytes = checkTotals(files);

  const skillFile = files.find((file) => file.path === SKILL_MD)!;
  const text = skillFile.bytes.toString("utf8");
  const frontmatter = readSkillFrontmatter(text);
  const override = typeof input.name === "string" ? input.name.trim() : "";
  const name = override || frontmatter.name;
  try {
    validateSkillName(name);
  } catch {
    throw invalid(
      "invalid_skill_name",
      override
        ? "Skill name must be kebab-case (lowercase letters, digits and single hyphens, 1-64 chars)"
        : `SKILL.md name "${frontmatter.name.slice(0, 80)}" must be kebab-case (lowercase letters, digits and single hyphens, 1-64 chars). Choose another name to install it.`,
      [SKILL_MD],
    );
  }
  if (name !== frontmatter.name) {
    const rewritten = buildFrontmatter({ ...frontmatter.data, name }) + frontmatter.body.replace(/^\r?\n/, "");
    skillFile.bytes = Buffer.from(rewritten, "utf8");
  }
  return {
    name,
    description: frontmatter.description,
    files: files.sort((a, b) => (a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path.localeCompare(b.path))),
    skipped,
    strippedRoot,
    totalBytes,
  };
}

export function summarizeSkillBundle(bundle: PreparedSkillBundle) {
  return {
    name: bundle.name,
    description: bundle.description,
    files: bundle.files.map((file) => ({ path: file.path, size: file.bytes.length, executable: file.executable })),
    skipped: bundle.skipped,
    strippedRoot: bundle.strippedRoot,
    totalBytes: bundle.totalBytes,
    limits: SKILL_BUNDLE_LIMITS,
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/** An installed skill with the same name, anywhere the engine would load it from. */
export async function findSkillConflict(workspaceRoot: string, name: string): Promise<SkillConflict | null> {
  const flatDir = join(projectSkillsDir(workspaceRoot), name);
  const items = await listSkills(workspaceRoot, true);
  const item = items.find((skill) => skill.name === name);
  if (item) {
    const replaceable = item.scope === "project" && resolve(dirname(item.path)) === resolve(flatDir);
    return { name, path: item.path, scope: item.scope, replaceable };
  }
  // A leftover folder without a loadable SKILL.md still blocks the rename.
  if (await exists(flatDir)) return { name, path: flatDir, scope: "project", replaceable: true };
  return null;
}

async function writeTree(dir: string, files: Array<{ path: string; bytes: Buffer; executable: boolean }>): Promise<void> {
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    if (!isInside(dir, target)) throw invalid("invalid_skill_path", `Unsafe path in upload: ${file.path}`, [file.path]);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
    if (file.executable && process.platform !== "win32") await chmod(target, 0o755);
  }
}

function stagingRoot(workspaceRoot: string): string {
  // Beside, not inside, the skill scan directories: a half-written skill must
  // never be visible to the engine or the Library.
  return join(workspaceRoot, ".opencode", `.skill-upload-${randomBytes(6).toString("hex")}`);
}

export async function installSkillBundle(
  workspaceRoot: string,
  bundle: PreparedSkillBundle,
  options: { onConflict: "fail" | "replace" },
): Promise<{ path: string; dir: string; action: "added" | "updated" }> {
  const skillsDir = projectSkillsDir(workspaceRoot);
  const target = join(skillsDir, bundle.name);
  const conflict = await findSkillConflict(workspaceRoot, bundle.name);
  if (conflict && (options.onConflict !== "replace" || !conflict.replaceable)) {
    throw new ApiError(
      409,
      "skill_exists",
      conflict.replaceable
        ? `A skill named ${bundle.name} already exists in this workspace`
        : `A skill named ${bundle.name} is already installed (${conflict.scope === "global" ? "globally" : "in another skill folder"}); choose another name`,
      conflict,
    );
  }
  const staging = stagingRoot(workspaceRoot);
  const fresh = join(staging, "new");
  const previous = join(staging, "old");
  await mkdir(fresh, { recursive: true });
  try {
    await writeTree(fresh, bundle.files);
    await mkdir(skillsDir, { recursive: true });
    const replacing = await exists(target);
    if (replacing) await renameWithRetry(target, previous);
    try {
      await renameWithRetry(fresh, target);
    } catch (error) {
      if (replacing) await rename(previous, target).catch(() => undefined);
      throw error;
    }
    return { path: join(target, SKILL_MD), dir: target, action: replacing ? "updated" : "added" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// --- helper files of an installed skill --------------------------------------------

/** The directory of a project skill (the only kind the desktop edits). */
export async function resolveProjectSkillDir(workspaceRoot: string, name: string): Promise<string> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const items = await listSkills(workspaceRoot, false);
  const item = items.find((skill) => skill.name === trimmed && skill.scope === "project");
  if (!item) throw new ApiError(404, "skill_not_found", `Skill not found in this workspace: ${trimmed}`);
  const dir = dirname(item.path);
  if (!isInside(workspaceRoot, dir)) throw new ApiError(404, "skill_not_found", `Skill not found in this workspace: ${trimmed}`);
  return dir;
}

export type SkillTreeEntry = SkillBundleFileSummary & { kind: "file" | "symlink" | "other" };

/** Lists a skill folder without following links; stops at the bundle caps. */
export async function listSkillTree(dir: string): Promise<{ files: SkillTreeEntry[]; truncated: boolean }> {
  const files: SkillTreeEntry[] = [];
  let truncated = false;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= SKILL_BUNDLE_LIMITS.maxRawEntries) {
        truncated = true;
        return;
      }
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (depth < SKILL_BUNDLE_LIMITS.maxDepth) await walk(full, depth + 1);
        continue;
      }
      const info = await lstat(full);
      files.push({
        path: rel,
        size: info.size,
        executable: info.isFile() && (info.mode & 0o111) !== 0,
        kind: info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other",
      });
    }
  };
  await walk(dir, 1);
  files.sort((a, b) => (a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path.localeCompare(b.path)));
  return { files, truncated };
}

/**
 * Adds, replaces and removes helper files of an installed skill. SKILL.md is
 * edited through the skill upsert (it carries the frontmatter the engine
 * needs), so it can be neither added nor removed here.
 */
export async function updateSkillFiles(
  dir: string,
  input: { add?: unknown; remove?: unknown },
): Promise<{ added: string[]; removed: string[] }> {
  const removeRaw = input.remove === undefined ? [] : input.remove;
  if (!Array.isArray(removeRaw)) throw invalid("invalid_skill_bundle", "remove must be a list of paths");
  const remove = removeRaw.map((path) => normalizeSkillBundlePath(String(path)));
  const tree = await listSkillTree(dir);
  const existing = tree.files.filter((file) => !remove.includes(file.path));
  const { files: add } = checkFiles(input.add ?? [], { existing });
  for (const path of [...remove, ...add.map((file) => file.path)]) {
    if (path.toLowerCase() === SKILL_MD.toLowerCase()) {
      throw invalid("skill_md_protected", "Edit SKILL.md with the skill editor; it cannot be uploaded or removed as a helper file", [path]);
    }
  }
  for (const path of remove) {
    if (!tree.files.some((file) => file.path === path)) throw new ApiError(404, "skill_file_not_found", `No such file in the skill: ${path}`);
  }
  const replaced = new Set(add.map((file) => file.path.toLowerCase()));
  const kept = existing.filter((file) => !replaced.has(file.path.toLowerCase()));
  checkTotals([...kept, ...add.map((file) => ({ size: file.bytes.length }))]);

  for (const path of remove) {
    const target = join(dir, ...path.split("/"));
    if (!isInside(dir, target)) continue;
    await rm(target, { force: true });
    await pruneEmptyDirs(dir, dirname(target));
  }
  for (const file of add) {
    const target = join(dir, ...file.path.split("/"));
    if (!isInside(dir, target)) throw invalid("invalid_skill_path", `Unsafe path: ${file.path}`, [file.path]);
    // Never write through a link that sits in the way.
    for (let cursor = dirname(target); isInside(dir, cursor) && cursor !== resolve(dir); cursor = dirname(cursor)) {
      const info = await lstat(cursor).catch(() => null);
      if (info?.isSymbolicLink()) throw invalid("invalid_skill_path", `A folder on this path is a link: ${file.path}`, [file.path]);
    }
    // Replacing "scripts/Run.sh" with "scripts/run.sh" must not leave both behind on a case-sensitive disk.
    const caseVariant = tree.files.find((entry) => entry.path !== file.path && entry.path.toLowerCase() === file.path.toLowerCase());
    if (caseVariant?.kind === "file") await rm(join(dir, ...caseVariant.path.split("/")), { force: true });
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) throw invalid("invalid_skill_path", `Cannot replace a non-file: ${file.path}`, [file.path]);
    if (info) await rm(target, { force: true });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
    if (file.executable && process.platform !== "win32") await chmod(target, 0o755);
  }
  return { added: add.map((file) => file.path), removed: remove };
}

async function pruneEmptyDirs(root: string, from: string): Promise<void> {
  for (let cursor = from; isInside(root, cursor) && resolve(cursor) !== resolve(root); cursor = dirname(cursor)) {
    const entries = await readdir(cursor).catch(() => null);
    if (!entries || entries.length) return;
    await rmdir(cursor).catch(() => undefined);
  }
}

/** Reads a JSON request body, refusing one larger than `maxBytes` before buffering it all. */
export async function readBoundedJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const tooLarge = () => new ApiError(413, "skill_bundle_too_large", `Upload is larger than ${formatBytes(maxBytes)}`);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) throw new ApiError(400, "invalid_json", "Invalid JSON body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}
