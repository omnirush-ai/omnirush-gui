// Reads a skill folder the user picked (or dropped) for upload.
//
// The renderer cannot see links in a folder it reads through <input
// webkitdirectory> or drag and drop (Chromium follows them), so on the desktop
// the main process walks the folder itself with lstat: a link anywhere in the
// skill refuses the read with the offending paths, OS/VCS litter and dependency
// trees are skipped without descending into them, and the same count and size
// caps as the local server apply, so a mistaken pick (a home folder) stops
// early instead of buffering gigabytes. The local server re-validates
// everything it is sent.
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export const SKILL_FOLDER_LIMITS = Object.freeze({
  maxFiles: 200,
  maxRawEntries: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxDepth: 16,
});

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized"]);
const JUNK_DIRS = new Set(["__macosx", ".git", "node_modules", "__pycache__", ".svn", ".hg", ".venv", ".idea", ".vscode"]);

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function isJunkFile(name) {
  const lower = name.toLowerCase();
  return JUNK_NAMES.has(lower) || lower.startsWith("._") || lower.endsWith(".pyc");
}

async function readCapped(file, size) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} root absolute folder path
 * @param {{ limits?: { [K in keyof typeof SKILL_FOLDER_LIMITS]: number } }} [options]
 * @returns {Promise<{ root: string; name: string; files: Array<{ path: string; contentBase64: string; executable: boolean }>; skipped: string[] }>}
 */
export async function readSkillFolder(root, options = {}) {
  const limits = options.limits ?? SKILL_FOLDER_LIMITS;
  const source = String(root ?? "").trim();
  if (!source || !path.isAbsolute(source)) throw new Error("Choose a skill folder");
  const top = await lstat(source);
  if (top.isSymbolicLink()) throw new Error("The chosen folder is a link; choose the folder it points to");
  if (!top.isDirectory()) throw new Error("The chosen item is not a folder");

  /** @type {Array<{ path: string; full: string; size: number; executable: boolean }>} */
  const found = [];
  const skipped = [];
  const links = [];
  let entries = 0;
  let total = 0;

  const walk = async (dir, depth) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      entries += 1;
      if (entries > limits.maxRawEntries) throw new Error(`The folder has more than ${limits.maxRawEntries} entries; a skill folder holds at most ${limits.maxFiles} files`);
      const full = path.join(dir, item.name);
      const rel = path.relative(source, full).split(path.sep).join("/");
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        links.push(rel);
        continue;
      }
      if (info.isDirectory()) {
        if (JUNK_DIRS.has(item.name.toLowerCase())) {
          skipped.push(`${rel}/`);
          continue;
        }
        if (depth >= limits.maxDepth) throw new Error(`The folder is nested too deep at ${rel}`);
        await walk(full, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        skipped.push(rel);
        continue;
      }
      if (isJunkFile(item.name)) {
        skipped.push(rel);
        continue;
      }
      if (info.size > limits.maxFileBytes) throw new Error(`${rel} is larger than ${formatBytes(limits.maxFileBytes)}`);
      total += info.size;
      if (total > limits.maxTotalBytes) throw new Error(`The folder is larger than ${formatBytes(limits.maxTotalBytes)}`);
      found.push({ path: rel, full, size: info.size, executable: process.platform !== "win32" && (info.mode & 0o111) !== 0 });
      if (found.length > limits.maxFiles) throw new Error(`The folder has more than ${limits.maxFiles} files`);
    }
  };
  await walk(source, 1);
  if (links.length) {
    throw new Error(`Skills cannot contain links (symlinks or shortcuts). Replace them with the real files: ${links.slice(0, 10).join(", ")}${links.length > 10 ? `, and ${links.length - 10} more` : ""}`);
  }
  const files = [];
  for (const file of found) {
    const bytes = await readCapped(file.full, Math.min(file.size, limits.maxFileBytes));
    files.push({ path: file.path, contentBase64: bytes.toString("base64"), executable: file.executable });
  }
  return { root: source, name: path.basename(source), files, skipped };
}
