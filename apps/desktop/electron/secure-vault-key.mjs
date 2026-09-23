import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  discardPlaintextCredentialFile,
  logPlaintextCredentialsOnce,
  readPlaintextCredentialFile,
  writePlaintextCredentialFile,
} from "./plaintext-credential-file.mjs";

const KEY_BYTES = 32;
const PLAINTEXT_KIND = "MCP credential vault key";

/**
 * @param {string} filePath
 * @param {Buffer} encrypted
 */
async function replaceProtectedKey(filePath, encrypted) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Compact filename-safe UTC timestamp mirroring the `*.omnirush-backup-<ts>`
 * naming used by the server legacy-config sweep.
 *
 * @param {Date} date
 */
function backupTimestamp(date) {
  const parts = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("");
}

/**
 * @param {string} encoded
 */
function decodeKey(encoded) {
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("The protected OmniRush.ai credential key is invalid.");
  }
  return key;
}

/**
 * Creates a lazy key provider so Electron does not initialize secure storage
 * until a user opts into OmniRush.ai-managed OAuth.
 *
 * @param {{
 *   filePath: string;
 *   loadSafeStorage: () => import("electron").SafeStorage;
 *   platform?: NodeJS.Platform;
 *   fallbackFilePath?: string | null;
 *   onKeyringSealed?: ((backend: string) => unknown) | null;
 *   log?: (message: string) => void;
 * }} options `fallbackFilePath`: Linux only, where the key is kept,
 * unencrypted at rest with owner-only permissions, while no keyring is usable
 * (see plaintext-credential-file.mjs). `onKeyringSealed`: Linux only, told
 * which safeStorage backend sealed the key, so later launches keep that
 * --password-store.
 */
export function createDesktopVaultKeyProvider({
  filePath,
  loadSafeStorage,
  platform = process.platform,
  fallbackFilePath = null,
  onKeyringSealed = null,
  log = (message) => console.warn(message),
}) {
  /** @type {Promise<Buffer> | null} */
  let pending = null;
  const fileFallback = platform === "linux" && Boolean(fallbackFilePath);

  /** @param {import("electron").SafeStorage} safeStorage */
  async function noteKeyringSealed(safeStorage) {
    if (!fileFallback || !onKeyringSealed) return;
    try {
      await onKeyringSealed(safeStorage.getSelectedStorageBackend());
    } catch {
      // Best effort: without the record the startup probe still decides.
    }
  }

  /**
   * The key sealed in `filePath`, or null when it is missing or unreadable.
   * @param {import("electron").SafeStorage} safeStorage
   */
  async function readSealedKey(safeStorage) {
    try {
      return decodeKey((await safeStorage.decryptStringAsync(await readFile(filePath))).result);
    } catch {
      return null;
    }
  }

  /** The key kept in the private file, or null when there is none or it is invalid. */
  async function readUnprotectedKey() {
    try {
      const contents = await readPlaintextCredentialFile(fallbackFilePath);
      return contents ? decodeKey(JSON.parse(contents).key) : null;
    } catch {
      return null;
    }
  }

  /**
   * Linux without a usable keyring: the key lives in an owner-only file,
   * unencrypted at rest. A key sealed by a keyring that is gone cannot be
   * read, so a fresh key is minted and the vault recovers as it does after a
   * keyring change; the sealed blob is left for the keyring's return.
   */
  async function loadUnprotectedKey() {
    logPlaintextCredentialsOnce(PLAINTEXT_KIND, log);
    const stored = await readUnprotectedKey();
    if (stored) return stored;
    const key = randomBytes(KEY_BYTES);
    await writePlaintextCredentialFile(
      fallbackFilePath,
      `${JSON.stringify({ note: "Unencrypted at rest: this system has no keyring. Owner-only file.", key: key.toString("base64") }, null, 2)}\n`,
    );
    return key;
  }

  async function loadKey() {
    const safeStorage = loadSafeStorage();
    const encryptionAvailable = Boolean(safeStorage) && await safeStorage.isAsyncEncryptionAvailable();
    const basicText = encryptionAvailable && platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text";
    if (fileFallback && (!encryptionAvailable || basicText)) return loadUnprotectedKey();
    if (!encryptionAvailable) {
      throw new Error("Operating-system secure storage is unavailable for OmniRush.ai-managed OAuth.");
    }
    if (basicText) {
      throw new Error("A secure Linux password store is required for OmniRush.ai-managed OAuth.");
    }

    const unprotected = fileFallback ? await readUnprotectedKey() : null;
    if (unprotected) {
      // A keyring is usable now: seal the key the vault uses with it, keep
      // any older, different sealed blob as a backup, and delete the private
      // file only once the sealed copy reads back as the same key. Until
      // then the file keeps the vault usable and a later launch retries.
      const existing = await readSealedKey(safeStorage);
      if (!existing?.equals(unprotected)) {
        await rename(filePath, `${filePath}.omnirush-backup-${backupTimestamp(new Date())}`).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await replaceProtectedKey(filePath, await safeStorage.encryptStringAsync(unprotected.toString("base64")));
      }
      const readBack = existing?.equals(unprotected) ? existing : await readSealedKey(safeStorage);
      if (readBack?.equals(unprotected)) {
        await discardPlaintextCredentialFile(fallbackFilePath, PLAINTEXT_KIND, log);
        await noteKeyringSealed(safeStorage);
        log("[omnirush] Moved the MCP credential vault key from the private file into the system keyring.");
      } else {
        log("[omnirush] The system keyring did not return the MCP credential vault key; keeping it in the private file.");
      }
      return unprotected;
    }

    /** @type {Buffer | undefined} */
    let encrypted;
    try {
      encrypted = await readFile(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (encrypted) {
      /** @type {Awaited<ReturnType<typeof safeStorage.decryptStringAsync>> | undefined} */
      let decrypted;
      /** @type {Buffer | undefined} */
      let key;
      try {
        decrypted = await safeStorage.decryptStringAsync(encrypted);
        key = decodeKey(decrypted.result);
      } catch {
        // Secure storage is available but can no longer decrypt the blob (for
        // example the OS keychain secret changed), so quarantine the original
        // bytes and mint a fresh key instead of failing on every launch.
        await rename(filePath, `${filePath}.omnirush-backup-${backupTimestamp(new Date())}`);
      }
      if (decrypted && key) {
        if (decrypted.shouldReEncrypt) {
          await replaceProtectedKey(filePath, await safeStorage.encryptStringAsync(decrypted.result));
        }
        await noteKeyringSealed(safeStorage);
        return key;
      }
    }

    const key = randomBytes(KEY_BYTES);
    await replaceProtectedKey(filePath, await safeStorage.encryptStringAsync(key.toString("base64")));
    await noteKeyringSealed(safeStorage);
    return key;
  }

  return async () => {
    pending ??= loadKey();
    try {
      return Buffer.from(await pending);
    } catch (error) {
      pending = null;
      throw error;
    }
  };
}
