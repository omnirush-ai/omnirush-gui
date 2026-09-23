import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Linux fallback for systems without a usable keyring (Electron's safeStorage
// reports the "basic_text" backend or no encryption at all). The secrets kept
// here are NOT encrypted at rest: they are protected only by owner-only file
// permissions (0600 file inside a 0700 folder under the app's userData), like
// an SSH key or a CLI tool's token file. The account store and the vault key
// provider use these files only on Linux, only while no keyring is reachable,
// and move their contents into safeStorage once one is.

const loggedKinds = new Set();

/**
 * Log once per process that `kind` is kept unencrypted. Never logs the secret.
 * @param {string} kind
 * @param {(message: string) => void} [log]
 */
export function logPlaintextCredentialsOnce(kind, log = console.warn) {
  if (loggedKinds.has(kind)) return;
  loggedKinds.add(kind);
  log(`[omnirush] No system keyring is available: the ${kind} is kept unencrypted at rest in an owner-only (0600) file in the app data folder.`);
}

/**
 * Usable safeStorage, or null. Linux's "basic_text" backend encrypts with a
 * constant key, so it counts as unavailable.
 * @param {() => import("electron").SafeStorage | null | undefined} loadSafeStorage
 * @param {NodeJS.Platform} platform
 */
export async function usableSafeStorage(loadSafeStorage, platform) {
  const storage = loadSafeStorage();
  if (!storage || !(await storage.isAsyncEncryptionAvailable())) return null;
  if (platform === "linux" && storage.getSelectedStorageBackend() === "basic_text") return null;
  return storage;
}

/**
 * The file's text, or null when it does not exist. Tightens permissions that
 * were loosened since the file was written.
 * @param {string} filePath
 */
export async function readPlaintextCredentialFile(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  await chmod(filePath, 0o600).catch(() => undefined);
  return contents;
}

/**
 * Write atomically: an owner-only temporary file renamed over the target in
 * an owner-only folder, so a reader never sees a partial file.
 * @param {string} filePath
 * @param {string} contents
 */
export async function writePlaintextCredentialFile(filePath, contents) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** @param {string} filePath */
export async function removePlaintextCredentialFile(filePath) {
  await rm(filePath, { force: true });
}
