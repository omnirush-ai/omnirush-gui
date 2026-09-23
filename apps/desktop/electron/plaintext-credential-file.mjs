import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
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
 * The file's text, or null when it does not exist. Never follows a symlink
 * (O_NOFOLLOW), and tightens permissions on the opened file itself when they
 * were loosened since it was written.
 * @param {string} filePath
 */
export async function readPlaintextCredentialFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    await handle.chmod(0o600).catch(() => undefined);
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
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

/**
 * Remove the private file once its contents are safely elsewhere. A failure
 * is logged, not thrown: the caller's newer copy is already in place, and a
 * stale file only means the next load migrates it again.
 * @param {string} filePath
 * @param {string} kind
 * @param {(message: string) => void} log
 */
export async function discardPlaintextCredentialFile(filePath, kind, log) {
  try {
    await removePlaintextCredentialFile(filePath);
    return true;
  } catch (error) {
    log(`[omnirush] Could not delete the private file for the ${kind} (${error?.code ?? "error"}); it will be retried.`);
    return false;
  }
}
