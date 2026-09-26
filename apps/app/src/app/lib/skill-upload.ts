/**
 * Reading a skill for upload: a folder (picker, `<input webkitdirectory>`,
 * drag and drop), a .zip, or loose files. Everything becomes a flat list of
 * `/`-separated relative paths + bytes that the local server validates and
 * installs (`POST /workspace/:id/skills/bundle`), so the rules live in one
 * place. The client only does what the server cannot see or should not have
 * to receive: it refuses zip entries that are symlinks or encrypted, skips OS
 * and VCS litter before reading it, and stops at the same caps early.
 */

/** Mirrors apps/server/src/skill-bundle.ts SKILL_BUNDLE_LIMITS. */
export const SKILL_UPLOAD_LIMITS = {
  maxFiles: 200,
  maxRawEntries: 2_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  /** A .zip larger than this is refused before it is read. */
  maxZipBytes: 30 * 1024 * 1024,
} as const;

export type SkillUploadFile = {
  path: string;
  contentBase64: string;
  executable?: boolean;
};

export type SkillUploadSource = {
  kind: "folder" | "zip" | "files";
  /** What the user picked, for display (folder or archive name). */
  label: string;
  files: SkillUploadFile[];
  /** Litter dropped before upload (.DS_Store, __MACOSX/, .git/, node_modules/, ...). */
  skipped: string[];
};

export class SkillUploadError extends Error {}

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized"]);
const JUNK_DIRS = new Set(["__macosx", ".git", "node_modules", "__pycache__", ".svn", ".hg", ".venv", ".idea", ".vscode"]);

export function isSkillUploadJunk(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const name = parts.at(-1)?.toLowerCase() ?? "";
  if (JUNK_NAMES.has(name) || name.startsWith("._") || name.endsWith(".pyc")) return true;
  return parts.slice(0, -1).some((part) => JUNK_DIRS.has(part.toLowerCase()));
}

export function isJunkDirectoryName(name: string): boolean {
  return JUNK_DIRS.has(name.toLowerCase());
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function isZipName(name: string): boolean {
  return /\.zip$/i.test(name.trim());
}

/** Running totals shared by every reader so a huge pick stops early. */
class Budget {
  entries = 0;
  files = 0;
  bytes = 0;

  entry() {
    this.entries += 1;
    if (this.entries > SKILL_UPLOAD_LIMITS.maxRawEntries) {
      throw new SkillUploadError(`That has more than ${SKILL_UPLOAD_LIMITS.maxRawEntries} entries. A skill holds at most ${SKILL_UPLOAD_LIMITS.maxFiles} files.`);
    }
  }

  file(path: string, size: number) {
    if (size > SKILL_UPLOAD_LIMITS.maxFileBytes) {
      throw new SkillUploadError(`${path} is larger than ${formatUploadBytes(SKILL_UPLOAD_LIMITS.maxFileBytes)}.`);
    }
    this.files += 1;
    this.bytes += size;
    if (this.files > SKILL_UPLOAD_LIMITS.maxFiles) {
      throw new SkillUploadError(`A skill holds at most ${SKILL_UPLOAD_LIMITS.maxFiles} files.`);
    }
    if (this.bytes > SKILL_UPLOAD_LIMITS.maxTotalBytes) {
      throw new SkillUploadError(`A skill holds at most ${formatUploadBytes(SKILL_UPLOAD_LIMITS.maxTotalBytes)} of files.`);
    }
  }
}

async function fileEntry(path: string, file: Blob, budget: Budget): Promise<SkillUploadFile> {
  budget.file(path, file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { path, contentBase64: bytesToBase64(bytes) };
}

// --- <input webkitdirectory> / <input multiple> -----------------------------------

type RelativeFile = File & { webkitRelativePath?: string };

/**
 * Files from a directory input (paths from `webkitRelativePath`, which start
 * with the picked folder's name) or a plain multi-file input (bare names).
 */
export async function readSkillFromFileList(list: ArrayLike<RelativeFile>): Promise<SkillUploadSource> {
  const files = Array.from(list);
  if (files.length === 1 && isZipName(files[0]!.name) && !files[0]!.webkitRelativePath) {
    return readSkillFromZipFile(files[0]!);
  }
  const budget = new Budget();
  const out: SkillUploadFile[] = [];
  const skipped: string[] = [];
  const folder = files.find((file) => file.webkitRelativePath)?.webkitRelativePath?.split("/")[0] ?? "";
  for (const file of files) {
    budget.entry();
    const path = (file.webkitRelativePath || file.name).replace(/^\/+/, "");
    if (isSkillUploadJunk(path)) {
      skipped.push(path);
      continue;
    }
    out.push(await fileEntry(path, file, budget));
  }
  return { kind: folder ? "folder" : "files", label: folder || `${out.length} files`, files: out, skipped };
}

// --- drag and drop ------------------------------------------------------------------

type EntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void) => void };
};

function entryFile(entry: EntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file!(resolve, reject));
}

async function readAllEntries(entry: EntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader!();
  const all: EntryLike[] = [];
  // readEntries returns batches (100 in Chromium) until an empty one.
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** What a drop carries: a zip, a folder (with its local path on the desktop), or loose files. */
export type DroppedSkill =
  | { kind: "zip"; file: File }
  | { kind: "folder"; entry: EntryLike; file: File | null }
  | { kind: "files"; entries: EntryLike[]; files: File[] };

export function classifyDrop(dataTransfer: DataTransfer): DroppedSkill | null {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  const entries: EntryLike[] = [];
  for (const item of items) {
    const entry = (item.webkitGetAsEntry?.() ?? null) as unknown as EntryLike | null;
    if (entry) entries.push(entry);
  }
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length === 1 && isZipName(files[0]!.name) && !(entries[0]?.isDirectory)) return { kind: "zip", file: files[0]! };
  if (entries.length === 1 && entries[0]!.isDirectory) return { kind: "folder", entry: entries[0]!, file: files[0] ?? null };
  if (entries.some((entry) => entry.isDirectory)) {
    throw new SkillUploadError("Drop one skill folder (or its .zip) at a time.");
  }
  if (!files.length) return null;
  return { kind: "files", entries, files };
}

export async function readSkillFromDroppedFolder(root: EntryLike): Promise<SkillUploadSource> {
  const budget = new Budget();
  const out: SkillUploadFile[] = [];
  const skipped: string[] = [];
  const prefix = root.fullPath.replace(/\/+$/, "");
  const relativeOf = (entry: EntryLike) => `${root.name}${entry.fullPath.slice(prefix.length)}`;
  const walk = async (dir: EntryLike) => {
    for (const entry of await readAllEntries(dir)) {
      budget.entry();
      const path = relativeOf(entry);
      if (entry.isDirectory) {
        if (isJunkDirectoryName(entry.name)) {
          skipped.push(`${path}/`);
          continue;
        }
        await walk(entry);
        continue;
      }
      if (isSkillUploadJunk(path)) {
        skipped.push(path);
        continue;
      }
      out.push(await fileEntry(path, await entryFile(entry), budget));
    }
  };
  await walk(root);
  return { kind: "folder", label: root.name, files: out, skipped };
}

// --- .zip -----------------------------------------------------------------------------

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  executable: boolean;
};

async function inflateRaw(data: Uint8Array, expected: number, name: string): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > expected) {
      await reader.cancel().catch(() => undefined);
      throw new SkillUploadError(`${name} in the .zip is larger than it claims to be.`);
    }
    out.set(value, offset);
    offset += value.length;
  }
  if (offset !== expected) throw new SkillUploadError(`${name} in the .zip is damaged.`);
  return out;
}

/** Parses a .zip in memory (no ZIP64, no encryption), refusing symlink entries. */
export async function readSkillFromZipBytes(bytes: Uint8Array, label = "archive.zip"): Promise<SkillUploadSource> {
  if (bytes.length > SKILL_UPLOAD_LIMITS.maxZipBytes) {
    throw new SkillUploadError(`The .zip is larger than ${formatUploadBytes(SKILL_UPLOAD_LIMITS.maxZipBytes)}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 0xffff); index -= 1) {
    if (view.getUint32(index, true) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new SkillUploadError("That file is not a .zip archive.");
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new SkillUploadError("ZIP64 archives are not supported. Upload the folder instead.");
  }
  if (centralOffset + centralSize > bytes.length) throw new SkillUploadError("The .zip is damaged.");

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  const links: string[] = [];
  const budget = new Budget();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL) throw new SkillUploadError("The .zip is damaged.");
    budget.entry();
    const madeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const external = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const isDir = name.endsWith("/") || (unixMode & S_IFMT) === S_IFDIR || (madeBy >> 8 === 0 && (external & 0x10) !== 0);
    if (isDir) continue;
    if ((unixMode & S_IFMT) === S_IFLNK) {
      links.push(name);
      continue;
    }
    if (isSkillUploadJunk(name)) {
      skipped.push(name);
      continue;
    }
    if (flags & 0x1) throw new SkillUploadError("Encrypted .zip archives are not supported.");
    if (method !== 0 && method !== 8) throw new SkillUploadError(`${name} uses an unsupported .zip compression method.`);
    budget.file(name, size);
    entries.push({ name, method, compressedSize, size, localOffset, executable: (unixMode & 0o111) !== 0 });
  }
  if (links.length) {
    throw new SkillUploadError(`Skills cannot contain links (symlinks). Replace them with the real files: ${links.slice(0, 10).join(", ")}`);
  }

  const files: SkillUploadFile[] = [];
  for (const entry of entries) {
    const at = entry.localOffset;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL) throw new SkillUploadError("The .zip is damaged.");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (data.length !== entry.compressedSize) throw new SkillUploadError("The .zip is damaged.");
    let content: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new SkillUploadError("The .zip is damaged.");
      content = data;
    } else {
      content = await inflateRaw(data, entry.size, entry.name);
    }
    files.push({ path: entry.name, contentBase64: bytesToBase64(content), ...(entry.executable ? { executable: true } : {}) });
  }
  return { kind: "zip", label, files, skipped };
}

export async function readSkillFromZipFile(file: File): Promise<SkillUploadSource> {
  if (file.size > SKILL_UPLOAD_LIMITS.maxZipBytes) {
    throw new SkillUploadError(`The .zip is larger than ${formatUploadBytes(SKILL_UPLOAD_LIMITS.maxZipBytes)}.`);
  }
  return readSkillFromZipBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

// --- server payloads -----------------------------------------------------------------

export type SkillBundleSummary = {
  name: string;
  description: string;
  files: Array<{ path: string; size: number; executable: boolean }>;
  skipped: string[];
  strippedRoot: string | null;
  totalBytes: number;
};

export type SkillConflict = {
  name: string;
  path: string;
  scope: "project" | "global";
  replaceable: boolean;
};

export type SkillBundlePreview = SkillBundleSummary & { conflict: SkillConflict | null };

export type SkillBundleInstallResult = SkillBundleSummary & {
  path: string;
  dir: string;
  action: "added" | "updated";
};

export type SkillFileEntry = { path: string; size: number; executable: boolean; kind: "file" | "symlink" | "other" };

export type SkillFileTree = { name: string; dir: string; files: SkillFileEntry[]; truncated: boolean };

/** Groups a flat path list into folders for the preview ("" = the skill root). */
export function groupSkillFiles<T extends { path: string }>(files: T[]): Array<{ folder: string; files: T[] }> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const folder = slash < 0 ? "" : file.path.slice(0, slash);
    const list = groups.get(folder) ?? [];
    list.push(file);
    groups.set(folder, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, files: list }));
}
