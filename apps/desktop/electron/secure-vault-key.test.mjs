import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDesktopVaultKeyProvider } from "./secure-vault-key.mjs";

/**
 * @param {Partial<import("electron").SafeStorage>} overrides
 * @param {string} marker fake OS keychain secret; payloads sealed with a different marker fail to decrypt
 * @returns {import("electron").SafeStorage}
 */
function fakeSafeStorage(overrides = {}, marker = "sealed") {
  return /** @type {import("electron").SafeStorage} */ ({
    decryptString: () => { throw new Error("sync safe storage is not used"); },
    encryptString: () => { throw new Error("sync safe storage is not used"); },
    isAsyncEncryptionAvailable: async () => true,
    isEncryptionAvailable: () => true,
    setUsePlainTextEncryption: () => {},
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (plaintext) => Buffer.from(`${marker}:${Buffer.from(plaintext).toString("hex")}`),
    decryptStringAsync: async (encrypted) => {
      const payload = encrypted.toString();
      if (!payload.startsWith(`${marker}:`)) {
        throw new Error("safe storage cannot decrypt this payload");
      }
      return {
        result: Buffer.from(payload.slice(`${marker}:`.length), "hex").toString(),
        shouldReEncrypt: false,
      };
    },
    ...overrides,
  });
}

/**
 * @param {string} filePath
 */
async function backupSiblings(filePath) {
  const prefix = `${path.basename(filePath)}.omnirush-backup-`;
  return (await readdir(path.dirname(filePath))).filter((name) => name.startsWith(prefix));
}

describe("desktop managed MCP vault key", () => {
  it("persists only an OS-protected blob and restores the same key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
    const filePath = path.join(root, "vault-key.bin");
    try {
      const safeStorage = fakeSafeStorage();
      const firstProvider = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => safeStorage });
      const first = await firstProvider();
      assert.equal(first.byteLength, 32);
      assert.deepEqual(await firstProvider(), first);

      const protectedBlob = await readFile(filePath);
      assert.equal(protectedBlob.includes(first.toString("base64")), false);
      if (process.platform !== "win32") {
        assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      }

      const restartedProvider = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => safeStorage });
      assert.deepEqual(await restartedProvider(), first);
      assert.deepEqual(await backupSiblings(filePath), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines a blob the OS keychain can no longer decrypt and mints a fresh key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
    const filePath = path.join(root, "vault-key.bin");
    try {
      const oldKey = await createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => fakeSafeStorage() })();
      const originalBlob = await readFile(filePath);

      const rotatedStorage = fakeSafeStorage({}, "resealed");
      const providerB = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => rotatedStorage });
      const newKey = await providerB();
      assert.equal(newKey.byteLength, 32);
      assert.notDeepEqual(newKey, oldKey);

      const backups = await backupSiblings(filePath);
      assert.equal(backups.length, 1);
      assert.deepEqual(await readFile(path.join(root, backups[0])), originalBlob);

      const providerC = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => rotatedStorage });
      assert.deepEqual(await providerC(), newKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Electron's insecure Linux basic-text backend (no fallback path)", async () => {
    const filePath = path.join(os.tmpdir(), "unused-omnirush-vault-key.bin");
    const provider = createDesktopVaultKeyProvider({
      filePath,
      loadSafeStorage: () => fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
      platform: "linux",
    });
    await assert.rejects(provider(), /secure Linux password store/);
    assert.deepEqual(await backupSiblings(filePath), []);
  });

  it("fails closed when OS secure storage is unavailable", async () => {
    const filePath = path.join(os.tmpdir(), "unused-omnirush-vault-key.bin");
    const provider = createDesktopVaultKeyProvider({
      filePath,
      loadSafeStorage: () => fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }),
    });
    await assert.rejects(provider(), /secure storage is unavailable/);
    assert.deepEqual(await backupSiblings(filePath), []);
  });

  describe("Linux without a usable keyring", () => {
    /** @param {string} root */
    function paths(root) {
      return { filePath: path.join(root, "vault-key.bin"), fallbackFilePath: path.join(root, "private-credentials", "vault-key.json") };
    }
    /** @param {string} filePath */
    const exists = (filePath) => access(filePath).then(() => true, () => false);
    const basicText = () => fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" });
    const quiet = () => undefined;

    it("keeps the key in an owner-only private file and restores it", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
      const { filePath, fallbackFilePath } = paths(root);
      try {
        const options = { filePath, fallbackFilePath, loadSafeStorage: basicText, platform: /** @type {const} */ ("linux"), log: quiet };
        const key = await createDesktopVaultKeyProvider(options)();
        assert.equal(key.byteLength, 32);
        assert.equal(await exists(filePath), false);
        assert.equal(JSON.parse(await readFile(fallbackFilePath, "utf8")).key, key.toString("base64"));
        if (process.platform !== "win32") {
          assert.equal((await stat(fallbackFilePath)).mode & 0o777, 0o600);
          assert.equal((await stat(path.dirname(fallbackFilePath))).mode & 0o777, 0o700);
        }
        assert.deepEqual(await createDesktopVaultKeyProvider(options)(), key);

        const unavailable = { ...options, loadSafeStorage: () => fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }) };
        assert.deepEqual(await createDesktopVaultKeyProvider(unavailable)(), key);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("moves the key into a keyring that appears later and deletes the private file", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
      const { filePath, fallbackFilePath } = paths(root);
      try {
        const base = { filePath, fallbackFilePath, platform: /** @type {const} */ ("linux"), log: quiet };
        const key = await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: basicText })();
        const keyring = fakeSafeStorage();
        assert.deepEqual(await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => keyring })(), key);
        assert.equal(await exists(fallbackFilePath), false);
        assert.equal((await readFile(filePath)).includes(key.toString("base64")), false);
        assert.deepEqual(await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => keyring })(), key);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("mints a file key when the keyring that sealed the old one is gone, leaving the sealed blob", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
      const { filePath, fallbackFilePath } = paths(root);
      try {
        const base = { filePath, fallbackFilePath, platform: /** @type {const} */ ("linux"), log: quiet };
        const sealedKey = await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => fakeSafeStorage() })();
        const sealedBlob = await readFile(filePath);
        const fileKey = await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: basicText })();
        assert.notDeepEqual(fileKey, sealedKey);
        assert.deepEqual(await readFile(filePath), sealedBlob);

        // When the keyring returns, the key the vault now uses wins; the old blob is kept as a backup.
        assert.deepEqual(await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => fakeSafeStorage() })(), fileKey);
        assert.equal((await backupSiblings(filePath)).length, 1);
        assert.equal(await exists(fallbackFilePath), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("keeps the private file until the sealed key reads back, then records the store", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
      const { filePath, fallbackFilePath } = paths(root);
      try {
        const recorded = [];
        const base = { filePath, fallbackFilePath, platform: /** @type {const} */ ("linux"), log: quiet, onKeyringSealed: (backend) => { recorded.push(backend); } };
        const key = await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: basicText })();
        const broken = fakeSafeStorage({ decryptStringAsync: async () => { throw new Error("locked"); } });
        assert.deepEqual(await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => broken })(), key);
        assert.equal(await exists(fallbackFilePath), true);
        assert.deepEqual(recorded, []);

        assert.deepEqual(await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => fakeSafeStorage() })(), key);
        assert.equal(await exists(fallbackFilePath), false);
        assert.deepEqual(recorded, ["gnome_libsecret"]);
        assert.deepEqual(await createDesktopVaultKeyProvider({ ...base, loadSafeStorage: () => fakeSafeStorage() })(), key);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    for (const platform of /** @type {const} */ (["darwin", "win32"])) {
      it(`${platform}: unavailable secure storage still fails closed and writes no private file`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-vault-key-"));
        const { filePath, fallbackFilePath } = paths(root);
        try {
          const provider = createDesktopVaultKeyProvider({
            filePath,
            fallbackFilePath,
            platform,
            log: quiet,
            loadSafeStorage: () => fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }),
          });
          await assert.rejects(provider(), /secure storage is unavailable/);
          assert.equal(await exists(fallbackFilePath), false);
          assert.equal(await exists(filePath), false);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  });
});
