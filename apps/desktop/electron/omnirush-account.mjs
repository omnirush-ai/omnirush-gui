import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  discardPlaintextCredentialFile,
  logPlaintextCredentialsOnce,
  readPlaintextCredentialFile,
  removePlaintextCredentialFile,
  usableSafeStorage,
  writePlaintextCredentialFile,
} from "./plaintext-credential-file.mjs";

const execFileAsync = promisify(execFile);

/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushAccountStatus} AccountStatus */
/** @typedef {import("@omnirush/types/desktop-ipc").OmniRushAccountSignOutReason} SignOutReason */
/** @typedef {{ remoteRevoked: boolean, reason: SignOutReason }} SignOutOutcome */
/**
 * Runs the macOS `security` tool; injectable so tests never touch a keychain.
 * @typedef {(file: string, args: string[], options: { timeout: number, maxBuffer: number }) => Promise<{ stdout: string | Buffer, stderr: string | Buffer }>} SecurityCommandRunner
 */

export const KEYCHAIN_SERVICES = {
  gatewayUrl: "ai.omnirush.desktop.gateway-url",
  accessToken: "ai.omnirush.desktop.gateway-access",
  refreshToken: "ai.omnirush.desktop.gateway-refresh",
};
const DEFAULT_GATEWAY_URL = "https://omnirush.ai/omnirush/v1";
const DEV_GATEWAY_URL = "http://localhost:8090/omnirush/v1";
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];
const SECURITY_TOOL = "/usr/bin/security";
/** Upper bound on duplicate keychain items removed per service during sign-out. */
const MAX_KEYCHAIN_DELETES = 8;
/**
 * The account server still accepts the refresh token its latest rotation
 * replaced for this long (omnirush_device_rotation_grace_seconds). Any other
 * superseded refresh token it receives reads as a sign-in copied to a second
 * device, so this store never sends one.
 */
const SERVER_ROTATION_GRACE_MS = 120_000;
const REFRESH_TIMEOUT_MS = 20_000;
/**
 * A refresh token that may already have been rotated (the answer was lost)
 * is sent again only while that attempt, timeout included, ends inside the
 * server's grace, counted from the first time it was sent.
 */
const REFRESH_RETRY_WINDOW_MS = SERVER_ROTATION_GRACE_MS - REFRESH_TIMEOUT_MS;
const REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const PERSIST_RETRY_MAX_MS = 60_000;
/**
 * Connection failures that prove a request never reached the account server
 * (Node fetch and Electron net spellings), so nothing was rotated.
 */
const NEVER_SENT = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_CERT_\w+|ERR_TLS_CERT_\w+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_\w+|CERT_HAS_EXPIRED)\b/;
const PLAINTEXT_KIND = "omnirush.ai sign-in";
const PLAINTEXT_NOTE = "Unencrypted at rest: this system has no keyring. Owner-only file; signing out deletes it.";

function sameCredentials(left, right) {
  return left.gatewayUrl === right.gatewayUrl
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken;
}

function normalizeCredential(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeGatewayUrl(value) {
  const normalized = normalizeCredential(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTNAMES.includes(url.hostname))) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Human-readable account server for a gateway URL: the host (with a
 * non-default port), marked "(local API)" for loopback development servers.
 * Examples: "omnirush.ai", "localhost:8090 (local API)".
 */
export function accountServerLabel(gatewayUrl) {
  const normalized = normalizeGatewayUrl(gatewayUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  return LOOPBACK_HOSTNAMES.includes(url.hostname) ? `${url.host} (local API)` : url.host;
}

/**
 * Classify the account server's answer to POST /device/logout.
 *
 * - 2xx (the service answers 204): the device session was revoked now.
 * - 401/403: the credentials are already unknown, so the session is gone.
 * - 404 that names the session (any detail other than the framework's
 *   default "Not Found"): the session is gone as well.
 * - 404 with the framework default or no JSON body, 405, 410, 501: the
 *   server has no device sign-out route.
 * - Everything else (5xx, unexpected 4xx): the revocation did not happen.
 * @param {number} status
 * @param {string | null} [detail]
 * @returns {SignOutOutcome}
 */
export function classifyRemoteLogout(status, detail = null) {
  if (status >= 200 && status < 300) return { remoteRevoked: true, reason: "revoked" };
  if (status === 401 || status === 403) return { remoteRevoked: true, reason: "already_revoked" };
  if (status === 404) {
    const named = typeof detail === "string" && detail.trim() && !/^not found\.?$/i.test(detail.trim());
    return named
      ? { remoteRevoked: true, reason: "already_revoked" }
      : { remoteRevoked: false, reason: "endpoint_missing" };
  }
  if (status === 405 || status === 410 || status === 501) return { remoteRevoked: false, reason: "endpoint_missing" };
  return { remoteRevoked: false, reason: "unreachable" };
}

async function responseDetail(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    const payload = JSON.parse(text);
    if (typeof payload === "string") return normalizeCredential(payload);
    if (!payload || typeof payload !== "object") return null;
    return normalizeCredential(payload.detail) ?? normalizeCredential(payload.error) ?? normalizeCredential(payload.message);
  } catch {
    return null;
  }
}

/**
 * A credential bundle as persisted and handed to the embedded broker. The
 * `rotation` counter says how often this store refreshed the device session;
 * a bundle written before the counter existed loads as 0.
 * @returns {{ gatewayUrl: string, accessToken: string, refreshToken: string, rotation: number } | null}
 */
function validCredentials(value) {
  if (!value || typeof value !== "object") return null;
  const gatewayUrl = normalizeGatewayUrl(value.gatewayUrl);
  const accessToken = normalizeCredential(value.accessToken);
  const refreshToken = normalizeCredential(value.refreshToken);
  if (!gatewayUrl || !accessToken || !refreshToken) return null;
  const rotation = Number.isSafeInteger(value.rotation) && value.rotation >= 0 ? value.rotation : 0;
  return { gatewayUrl, accessToken, refreshToken, rotation };
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Names a failure for the log: its code, name or message, never a URL, header or body. */
function failureLabel(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string") return code;
  if (error?.name && error.name !== "Error" && error.name !== "TypeError") return String(error.name);
  return String(error?.message ?? error).slice(0, 160);
}

function neverSent(error) {
  const cause = error?.cause;
  const text = [error?.code, error?.message, cause?.code, cause?.message].filter((value) => typeof value === "string").join(" ");
  return NEVER_SENT.test(text);
}

function controlPlaneBase(gatewayUrl) {
  const base = new URL(gatewayUrl);
  base.pathname = base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return base;
}

function displayNameFromEmail(email) {
  const localPart = String(email).split("@", 1)[0] ?? "";
  const withoutCommonPrefix = localPart.replace(/^i[._-]?am(?=[a-z])/i, "");
  const words = withoutCommonPrefix
    .replace(/\d+$/, "")
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function accountProfile(value) {
  if (!value || typeof value !== "object") return null;
  const email = normalizeCredential(value.email);
  if (!email) return null;
  const usage = value.usage && typeof value.usage === "object"
    ? {
        tokenLimit: Number(value.usage.token_limit) || 0,
        usedTokens: Number(value.usage.used_tokens) || 0,
        remainingTokens: Number(value.usage.remaining_tokens) || 0,
      }
    : null;
  return {
    email,
    displayName: normalizeCredential(value.display_name) ?? displayNameFromEmail(email),
    status: normalizeCredential(value.status),
    usage,
  };
}

class InvalidAccountCredentialsError extends Error {}

async function readMacKeychain(service, platform, runSecurity) {
  if (platform !== "darwin") return null;
  try {
    const { stdout } = await runSecurity(["find-generic-password", "-s", service, "-w"]);
    return normalizeCredential(stdout);
  } catch {
    return null;
  }
}

/**
 * Remove every keychain item stored under `service`. Only macOS has these
 * legacy entries; other platforms have nothing to delete. `security` removes
 * one matching item per call and fails once none is left, which ends the loop.
 * Returns the number of items removed.
 */
async function deleteMacKeychain(service, platform, runSecurity) {
  if (platform !== "darwin") return 0;
  let removed = 0;
  while (removed < MAX_KEYCHAIN_DELETES) {
    try {
      await runSecurity(["delete-generic-password", "-s", service]);
      removed += 1;
    } catch {
      break;
    }
  }
  return removed;
}

/**
 * Whether this launch may read, and on sign-out remove, the legacy macOS
 * keychain entries (KEYCHAIN_SERVICES). They hold the owner's real
 * account, and belong to the default production profile alone: a dev,
 * eval, test or blank-slate profile, a custom OMNIRUSH_ELECTRON_USERDATA or
 * OMNIRUSH_ELECTRON_APP_IDENTIFIER, or the mock keychain must never import
 * them.
 * @param {{ appIdentifier: string, productionAppIdentifier: string, blankSlate: boolean, env?: NodeJS.ProcessEnv }} launch
 */
export function legacyKeychainAllowed({ appIdentifier, productionAppIdentifier, blankSlate, env = process.env }) {
  return appIdentifier === productionAppIdentifier
    && !blankSlate
    && !env.OMNIRUSH_ELECTRON_USERDATA?.trim()
    && !env.OMNIRUSH_ELECTRON_APP_IDENTIFIER?.trim()
    && env.OMNIRUSH_ELECTRON_USE_MOCK_KEYCHAIN !== "1";
}

export function createDesktopOmniRushAccountStore({
  filePath,
  loadSafeStorage,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = /** @type {SecurityCommandRunner} */ (execFileAsync),
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  // Only the default production profile may use the legacy keychain entries (legacyKeychainAllowed).
  legacyKeychain = false,
  // Linux only: where the sign-in is kept, unencrypted at rest with owner-only
  // permissions, while no keyring is usable (see plaintext-credential-file.mjs).
  fallbackFilePath = null,
  // Linux only: told which safeStorage backend sealed the sign-in once it is
  // written and read back, so later launches keep that --password-store.
  onKeyringSealed = null,
  log = (message) => console.warn(message),
  now = () => Date.now(),
  // First pause before a failed save of a rotated pair is tried again; tests shrink it.
  persistRetryBaseMs = 1_000,
}) {
  // This store is the one owner of the device session's refresh token: its
  // own profile check and the embedded broker (runtime.mjs wires the
  // broker's `refresh` to refresh() below) both come here, and only here is
  // a refresh token sent. Both run in the Electron main process.
  /** The current pair: the owner's truth, ahead of the disk while a save of it keeps failing. */
  let cached = null;
  /** The pair a restart would load (the saved file, or the environment/keychain import). */
  let persisted = null;
  /**
   * The current pair's refresh token was sent at `firstSentAt` and no answer
   * settled it: the rotation may have happened with the answer lost.
   * @type {{ hash: string, firstSentAt: number } | null}
   */
  let inFlight = null;
  /** The store dropped a pair it may not present any more; the user signs in again. */
  let signInRequired = false;
  let persistRetry = null;
  let persistRetryAttempt = 0;
  let loading = null;
  const fileFallback = platform === "linux" && Boolean(fallbackFilePath);
  let keyringLossLogged = false;
  let sealedBackendRecorded = null;
  // Every writer is tracked so a reader, the broker's latest() in
  // particular, observes a settled store rather than the pair a rotation is
  // about to replace.
  let refreshInFlight = null;
  let saveInFlight = null;
  let clearInFlight = null;
  /** Whether the sign-out in flight revokes the session (see save()). */
  let clearRevokesRemote = false;
  const signedOutPath = `${filePath}.signed-out`;
  /**
   * Written before a refresh token is sent and removed once the rotated pair
   * is saved: after a crash or quit mid-refresh, the next launch knows the
   * token on disk may have been rotated already. It holds a hash of the
   * token, never the token.
   */
  const refreshingPath = `${filePath}.refreshing`;
  const runSecurity = (args) => (legacyKeychain
    ? execFileImpl(SECURITY_TOOL, args, { timeout: 5_000, maxBuffer: 64 * 1024 })
    : Promise.reject(new Error("The legacy keychain entries belong to the default production profile")));

  /**
   * Resolves once every in-flight refresh, save and sign-out has finished.
   * A refresh ends in a save and a save may queue behind another, so this
   * re-checks a bounded number of times instead of trusting one snapshot.
   * @param {{ includeRefresh?: boolean, includeClear?: boolean }} [options]
   * `refresh()` and `clear()` must not wait for their own promise; a refresh
   * also never waits for a sign-out (which waits for the refresh).
   */
  async function settle({ includeRefresh = true, includeClear = true } = {}) {
    for (let round = 0; round < 8; round += 1) {
      const pending = [includeRefresh ? refreshInFlight : null, saveInFlight, includeClear ? clearInFlight : null].filter(Boolean);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  async function safeStorage() {
    return usableSafeStorage(loadSafeStorage, platform);
  }

  async function loadFallbackFile() {
    try {
      const contents = await readPlaintextCredentialFile(fallbackFilePath);
      return contents ? validCredentials(JSON.parse(contents)?.credentials) : null;
    } catch {
      return null;
    }
  }

  /** Tell main which backend sealed the sign-in (once per backend per process). */
  async function noteKeyringSealed(storage) {
    if (!fileFallback || !onKeyringSealed) return;
    const backend = storage.getSelectedStorageBackend();
    if (sealedBackendRecorded === backend) return;
    try {
      await onKeyringSealed(backend);
      sealedBackendRecorded = backend;
    } catch {
      // Best effort: without the record the startup probe still decides.
    }
  }

  async function modifiedAt(file) {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async function decryptKeyringCopy(storage) {
    try {
      const decrypted = await storage.decryptStringAsync(await readFile(filePath));
      const credentials = validCredentials(JSON.parse(decrypted.result));
      return credentials ? { credentials, shouldReEncrypt: Boolean(decrypted.shouldReEncrypt) } : null;
    } catch {
      return null;
    }
  }

  async function loadFile() {
    try {
      const storage = await safeStorage();
      if (!storage) {
        if (!fileFallback) return null;
        const credentials = await loadFallbackFile();
        if (credentials) logPlaintextCredentialsOnce(PLAINTEXT_KIND, log);
        return credentials;
      }
      const sealed = await decryptKeyringCopy(storage);
      const unprotected = fileFallback ? await loadFallbackFile() : null;
      // The private file is written only while no keyring is usable, so it is
      // normally the newest copy; a readable keyring copy written after it
      // wins (the file is then a leftover whose delete failed).
      if (unprotected && !(sealed && await modifiedAt(filePath) > await modifiedAt(fallbackFilePath))) {
        // A keyring is usable now: move the sign-in out of the private file.
        // writeCredentials deletes the file only once the encrypted copy has
        // been written and read back; otherwise the file stays and keeps the
        // user signed in, and a later load retries.
        await enqueueWrite(unprotected).then(
          () => log("[omnirush] Moved the omnirush.ai sign-in from the private file into the system keyring."),
          () => undefined,
        );
        return unprotected;
      }
      if (!sealed) return null;
      if (unprotected) await discardPlaintextCredentialFile(fallbackFilePath, PLAINTEXT_KIND, log);
      await noteKeyringSealed(storage);
      if (sealed.shouldReEncrypt) await enqueueWrite(sealed.credentials);
      return sealed.credentials;
    } catch {
      return null;
    }
  }

  /**
   * The stored credentials once the store is settled. This is also the
   * broker's `latest()`: it must never answer with a pair that an in-flight
   * refresh, save or sign-out is about to replace.
   */
  async function load() {
    await settle();
    return readCredentials();
  }

  async function readCredentials() {
    if (cached) return cached;
    loading ??= loadCredentials().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function exists(file) {
    return access(file).then(() => true, () => false);
  }

  async function loadCredentials() {
    const stored = await loadFile();
    const imported = stored ? null : await legacyCredentials();
    const credentials = stored ?? imported;
    if (!credentials) return null;
    if (!(await usableAfterRestart(credentials))) {
      return forget("The saved omnirush.ai sign-in was being renewed when the app stopped, longer ago than the account server accepts that token again.");
    }
    cached = credentials;
    persisted = credentials;
    // A refresh the last exit cut off is finished now, while the server still
    // accepts its token (its access token may keep working a little longer).
    if (inFlight) void refresh(credentials.accessToken).catch(() => undefined);
    if (imported) {
      await enqueueWrite(imported);
      // Imported once: an old keychain copy must never come back later.
      if (!env.OMNIRUSH_REFRESH_TOKEN) {
        await deleteMacKeychain(KEYCHAIN_SERVICES.accessToken, platform, runSecurity);
        await deleteMacKeychain(KEYCHAIN_SERVICES.refreshToken, platform, runSecurity);
      }
    }
    return credentials;
  }

  /**
   * Environment or legacy keychain credentials, imported only while no
   * sign-in is on disk at all: never over a saved sign-in this launch cannot
   * read (a locked or replaced keyring), whose pair is newer, and never after
   * a sign-out.
   */
  async function legacyCredentials() {
    if (await exists(filePath) || (fileFallback && await exists(fallbackFilePath))) return null;
    if (await exists(signedOutPath)) return null;
    return validCredentials({
      gatewayUrl: env.OMNIRUSH_GATEWAY_URL ?? await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity),
      accessToken: env.OMNIRUSH_ACCESS_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.accessToken, platform, runSecurity),
      refreshToken: env.OMNIRUSH_REFRESH_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.refreshToken, platform, runSecurity),
    });
  }

  /** @returns {Promise<{ hash: string, rotation: number, firstSentAt: number } | null>} */
  async function readRefreshing() {
    try {
      const value = JSON.parse(await readFile(refreshingPath, "utf8"));
      const valid = typeof value?.refreshTokenSha256 === "string"
        && Number.isSafeInteger(value.rotation) && value.rotation >= 0
        && Number.isSafeInteger(value.firstSentAt) && value.firstSentAt >= 0;
      return valid ? { hash: value.refreshTokenSha256, rotation: value.rotation, firstSentAt: value.firstSentAt } : null;
    } catch {
      return null;
    }
  }

  /** Atomic (temporary file, then rename). `firstSentAt: 0` marks a token never to be sent again. */
  async function writeRefreshing({ hash, rotation, firstSentAt }) {
    await mkdir(path.dirname(refreshingPath), { recursive: true });
    const temporary = `${refreshingPath}.${process.pid}.tmp`;
    const record = { note: "A device sign-in renewal was in flight. Hash only; no token.", refreshTokenSha256: hash, rotation, firstSentAt };
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, refreshingPath).catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
  }

  function withinRetryWindow(firstSentAt, delay = 0) {
    return firstSentAt > 0 && now() + delay - firstSentAt <= REFRESH_RETRY_WINDOW_MS;
  }

  /**
   * Whether a pair read at launch may be used. A refresh of it that was in
   * flight when the app stopped (crash, quit, update) may have rotated it
   * with the answer lost: it is sent again only inside the server's grace,
   * and a pair behind a rotation that was recorded is never used.
   */
  async function usableAfterRestart(credentials) {
    const record = await readRefreshing();
    if (!record) return true;
    const hash = tokenHash(credentials.refreshToken);
    if (record.hash === hash) {
      if (!withinRetryWindow(record.firstSentAt)) return false;
      inFlight = { hash, firstSentAt: record.firstSentAt };
      return true;
    }
    if (record.rotation > credentials.rotation) return false;
    // Left behind by a pair that has since been saved.
    await rm(refreshingPath, { force: true });
    return true;
  }

  /**
   * Ends the local sign-in without sending its refresh token anywhere, not
   * even to /device/logout: it may be superseded, and a superseded token the
   * server receives reads as a copied sign-in. The user signs in again.
   */
  async function forget(reason) {
    log(`[omnirush] ${reason} Asking to sign in again.`);
    await serialize(removeLocalSignIn);
    signInRequired = true;
    return null;
  }

  async function removeLocalSignIn() {
    cached = null;
    persisted = null;
    inFlight = null;
    stopPersistRetry();
    // Sentinel first: a reader that slips in between never sees the file
    // without the sentinel and resurrects the account from disk.
    await mkdir(path.dirname(signedOutPath), { recursive: true });
    await writeFile(signedOutPath, "signed-out\n", { mode: 0o600 });
    await rm(filePath, { force: true });
    if (fileFallback) await removePlaintextCredentialFile(fallbackFilePath);
    await rm(refreshingPath, { force: true });
  }

  /**
   * Persist a bundle (a sign-in; this store's own rotations save themselves).
   * A bundle rotated fewer times than the current pair is older and is never
   * written over it. A save that arrives while the user is signing out is
   * dropped, that session is being revoked; one that arrives during a
   * server-driven sign-out lands afterwards.
   */
  async function save(credentials) {
    const normalized = validCredentials(credentials);
    if (!normalized) throw new Error("Invalid OmniRush account credential bundle");
    if (clearInFlight) {
      const revoked = clearRevokesRemote;
      await clearInFlight;
      if (revoked) return;
    }
    const current = cached ?? await loadFile();
    if (current && normalized.rotation < current.rotation) {
      log(`[omnirush] Kept the current omnirush.ai sign-in (rotation ${current.rotation}); an older one (rotation ${normalized.rotation}) was not saved over it.`);
      return;
    }
    await enqueueWrite(normalized);
  }

  /**
   * Serialized disk writer: sign-ins, rotations and the refresh record share
   * one queue (and temporary files). Internal writes (legacy import,
   * re-encryption) use it directly since they can run inside a sign-out.
   */
  function serialize(task) {
    const previous = saveInFlight;
    const write = (async () => {
      if (previous) await previous.catch(() => undefined);
      return task();
    })();
    saveInFlight = write;
    return write.finally(() => {
      if (saveInFlight === write) saveInFlight = null;
    });
  }

  function enqueueWrite(normalized) {
    return serialize(() => writeCredentials(normalized));
  }

  async function writeCredentials(normalized) {
    const storage = await safeStorage();
    if (!storage) {
      if (!fileFallback) throw new Error("Secure desktop credential storage is unavailable");
      // Unencrypted at rest, protected only by owner-only permissions: Linux
      // without a usable keyring. The next load with a keyring migrates it.
      await writePlaintextCredentialFile(
        fallbackFilePath,
        `${JSON.stringify({ note: PLAINTEXT_NOTE, credentials: normalized }, null, 2)}\n`,
      );
      logPlaintextCredentialsOnce(PLAINTEXT_KIND, log);
    } else {
      const encrypted = await storage.encryptStringAsync(JSON.stringify(normalized));
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, filePath).catch(async (error) => {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      });
      if (fileFallback) {
        // Linux: only trust the keyring copy once it reads back. Until then
        // the private file keeps the sign-in (a keyring that encrypts but
        // cannot decrypt, a locked or half-started Secret Service).
        const readBack = await decryptKeyringCopy(storage);
        if (readBack && sameCredentials(readBack.credentials, normalized)) {
          await discardPlaintextCredentialFile(fallbackFilePath, PLAINTEXT_KIND, log);
          await noteKeyringSealed(storage);
        } else {
          log("[omnirush] The system keyring did not return the saved omnirush.ai sign-in; keeping it in the private file.");
          await writePlaintextCredentialFile(
            fallbackFilePath,
            `${JSON.stringify({ note: PLAINTEXT_NOTE, credentials: normalized }, null, 2)}\n`,
          );
          logPlaintextCredentialsOnce(PLAINTEXT_KIND, log);
        }
      }
    }
    await rm(signedOutPath, { force: true });
    cached = normalized;
    persisted = normalized;
    signInRequired = false;
  }

  async function configuredGatewayUrl() {
    // Development builds keep using omnirush.ai. Only an explicit
    // OMNIRUSH_GATEWAY_URL, or OMNIRUSH_DEV_MODE=1 together with
    // OMNIRUSH_LOCAL_API=1, points the account service at a local API.
    const localApiSelected = env.OMNIRUSH_DEV_MODE === "1" && env.OMNIRUSH_LOCAL_API === "1";
    return normalizeGatewayUrl(env.OMNIRUSH_GATEWAY_URL)
      ?? normalizeGatewayUrl(await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity))
      ?? (localApiSelected ? DEV_GATEWAY_URL : DEFAULT_GATEWAY_URL);
  }

  /**
   * The only place a refresh token is sent. The embedded broker and this
   * store's profile check both come here after a 401, with the access token
   * that was refused. One refresh runs at a time; a caller that arrives
   * during one waits for it, then decides against the pair it left, so a
   * refresh token is never spent twice.
   *
   * Resolves the current pair: the one already past `rejectedAccessToken`
   * (no request), or a new rotation, saved before it is handed out. Resolves
   * null once the session is gone and the user has to sign in again. Rejects
   * when no rotation happened right now (offline, refused); the pair is kept.
   * @param {string} rejectedAccessToken
   */
  async function refresh(rejectedAccessToken) {
    while (refreshInFlight) await refreshInFlight.catch(() => undefined);
    refreshInFlight = (async () => {
      await settle({ includeRefresh: false, includeClear: false });
      const current = await readCredentials();
      if (!current || current.accessToken !== rejectedAccessToken) return current;
      return rotate(current);
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  /**
   * Sends the current pair's refresh token until an answer settles it. After
   * an answer that was lost the same token is sent again, only while inside
   * the server's grace; past it the token is never sent again.
   */
  async function rotate(current) {
    const started = await beginRefresh(current);
    if (!started) {
      return forget("Renewing the omnirush.ai sign-in got no answer, longer ago than the account server accepts that token again.");
    }
    // Whether an earlier attempt may have rotated the token with its answer lost.
    let unsettled = !started.fresh;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await sendRefresh(current);
      if (outcome.kind === "rotated") {
        inFlight = null;
        cached = outcome.credentials;
        await persistCurrent();
        return outcome.credentials;
      }
      if (outcome.kind === "retired") {
        return forget("The account server no longer accepts this device's omnirush.ai sign-in.");
      }
      if (outcome.kind === "unchanged" && !unsettled) {
        await endRefresh(current);
        throw new Error(`Account refresh unavailable (${outcome.detail})`);
      }
      // Lost, or refused after an earlier attempt that may have rotated the
      // token: only another attempt inside the grace can settle it.
      unsettled = true;
      const delay = REFRESH_RETRY_DELAYS_MS[Math.min(attempt, REFRESH_RETRY_DELAYS_MS.length - 1)];
      if (!withinRetryWindow(started.firstSentAt, delay)) {
        return forget(`Renewing the omnirush.ai sign-in got no usable answer (${outcome.detail}) before the account server's grace for sending it again ran out.`);
      }
      log(`[omnirush] Renewing the omnirush.ai sign-in got no usable answer (${outcome.detail}); sending the same token again inside the server's grace.`);
      await sleep(delay);
      // A sign-out is waiting for this refresh; it revokes the pair as it is.
      if (clearInFlight) throw new Error("Account refresh stopped for a sign-out");
    }
  }

  /**
   * Records, on disk before it is sent, that `current`'s refresh token is in
   * flight. Resolves null when it may not be sent any more; `fresh` is false
   * when it is being sent again after an attempt that settled nothing.
   * @returns {Promise<{ fresh: boolean, firstSentAt: number } | null>}
   */
  async function beginRefresh(current) {
    const hash = tokenHash(current.refreshToken);
    if (inFlight?.hash === hash) {
      return withinRetryWindow(inFlight.firstSentAt) ? { fresh: false, firstSentAt: inFlight.firstSentAt } : null;
    }
    const firstSentAt = now();
    try {
      await serialize(() => writeRefreshing(persisted.refreshToken === current.refreshToken
        ? { hash, rotation: current.rotation, firstSentAt }
        // The pair a restart would load is already behind this one (its save
        // keeps failing); after this rotation it is two behind and must never
        // be sent again.
        : { hash: tokenHash(persisted.refreshToken), rotation: persisted.rotation, firstSentAt: 0 }));
    } catch (error) {
      log(`[omnirush] Could not record the omnirush.ai sign-in renewal before sending it (${failureLabel(error)}); not renewing now.`);
      throw error;
    }
    inFlight = { hash, firstSentAt };
    return { fresh: true, firstSentAt };
  }

  /** The token was answered without a rotation, or never reached the server: it stays current. */
  async function endRefresh(current) {
    inFlight = null;
    // Otherwise the record guards an older pair on disk and stays.
    if (persisted?.refreshToken === current.refreshToken) await serialize(() => rm(refreshingPath, { force: true }));
  }

  /**
   * One POST /device/refresh. `rotated` carries the new pair; `retired`: the
   * server does not know the token (401/403); `unchanged`: answered without
   * a rotation, or never reached the server; `unknown`: the rotation may
   * have happened with its answer lost (timeout, reset, 408, 409, 5xx other
   * than 503, an unreadable success).
   */
  async function sendRefresh(credentials) {
    const refreshUrl = controlPlaneBase(credentials.gatewayUrl);
    refreshUrl.pathname += "/device/refresh";
    let response;
    try {
      response = await fetchImpl(refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: credentials.refreshToken }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: neverSent(error) ? "unchanged" : "unknown", detail: failureLabel(error) };
    }
    if (response.status === 401 || response.status === 403) return { kind: "retired" };
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const lost = (response.status >= 500 && response.status !== 503) || response.status === 408 || response.status === 409;
      return { kind: lost ? "unknown" : "unchanged", detail: `HTTP ${response.status}` };
    }
    try {
      const payload = await response.json();
      const rotated = validCredentials({
        gatewayUrl: payload.gateway_url ?? credentials.gatewayUrl,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        rotation: credentials.rotation + 1,
      });
      if (rotated) return { kind: "rotated", credentials: rotated };
    } catch {
      // An answer cut off or unreadable counts as lost.
    }
    return { kind: "unknown", detail: "unreadable answer" };
  }

  /**
   * Saves the pair this store just rotated to. Until a save lands the pair
   * stays the in-memory truth (never swapped back for the pair on disk, which
   * it superseded), the refresh record keeps that older pair from being sent
   * after a restart, and the save is retried.
   */
  async function persistCurrent() {
    const pair = cached;
    if (!pair || persisted === pair) return;
    try {
      await serialize(async () => {
        if (cached !== pair) return;
        // Sent already without an answer: its record moves to this pair before the pair lands on disk.
        const unsettled = inFlight?.hash === tokenHash(pair.refreshToken) ? inFlight : null;
        if (unsettled) await writeRefreshing({ hash: unsettled.hash, rotation: pair.rotation, firstSentAt: unsettled.firstSentAt });
        await writeCredentials(pair);
        if (!unsettled) await rm(refreshingPath, { force: true });
      });
      stopPersistRetry();
    } catch (error) {
      persistRetryAttempt += 1;
      log(`[omnirush] Could not save the renewed omnirush.ai sign-in (${failureLabel(error)}, attempt ${persistRetryAttempt}); keeping it in memory and trying again.`);
      schedulePersistRetry();
    }
  }

  function schedulePersistRetry() {
    if (persistRetry) return;
    const delay = Math.min(PERSIST_RETRY_MAX_MS, persistRetryBaseMs * 2 ** Math.min(persistRetryAttempt - 1, 10));
    persistRetry = setTimeout(() => {
      persistRetry = null;
      // A refresh in flight saves its own result; a sign-out drops the pair.
      if (refreshInFlight || clearInFlight) schedulePersistRetry();
      else void persistCurrent();
    }, delay);
    persistRetry.unref?.();
  }

  function stopPersistRetry() {
    if (persistRetry) clearTimeout(persistRetry);
    persistRetry = null;
    persistRetryAttempt = 0;
  }

  /**
   * Revoke the device session on the account server. Never throws: the
   * caller clears local credentials either way and reports the outcome.
   * @returns {Promise<SignOutOutcome>}
   */
  async function remoteLogout(credentials) {
    const logoutUrl = controlPlaneBase(credentials.gatewayUrl);
    logoutUrl.pathname += "/device/logout";
    let response;
    try {
      response = await fetchImpl(logoutUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: credentials.refreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { remoteRevoked: false, reason: "unreachable" };
    }
    const detail = response.status === 404 ? await responseDetail(response) : null;
    return classifyRemoteLogout(response.status, detail);
  }

  /**
   * @param {number} refreshesLeft Bounded: one refresh may only hand back a
   * pair rotated earlier (for the broker), whose access token can itself have
   * expired while the app was idle, so a second one is allowed before the
   * session counts as gone.
   */
  async function fetchProfile(credentials, refreshesLeft = 2) {
    const profileUrl = controlPlaneBase(credentials.gatewayUrl);
    profileUrl.pathname += "/device/me";
    const response = await fetchImpl(profileUrl, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 && refreshesLeft > 0) {
      const refreshed = await refresh(credentials.accessToken);
      if (!refreshed) throw new InvalidAccountCredentialsError("Device session expired");
      return fetchProfile(refreshed, refreshesLeft - 1);
    }
    if (response.status === 401 || response.status === 403) {
      throw new InvalidAccountCredentialsError("Device session expired");
    }
    if (!response.ok) return null;
    return accountProfile(await response.json());
  }

  async function authorize({ gatewayUrl, deviceName, openVerification }) {
    const explicitGateway = normalizeCredential(gatewayUrl);
    const configured = explicitGateway ? normalizeGatewayUrl(explicitGateway) : await configuredGatewayUrl();
    if (!configured) throw new Error("OmniRush account service is not configured");
    const base = controlPlaneBase(configured);
    const authorizeUrl = new URL(base);
    authorizeUrl.pathname += "/device/authorize";
    const issuedResponse = await fetchImpl(authorizeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: deviceName, platform }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!issuedResponse.ok) throw new Error(`Could not start account link (${issuedResponse.status})`);
    const issued = await issuedResponse.json();
    if (!issued?.device_code || !issued?.verification_uri_complete) throw new Error("Account service returned an invalid device link");
    await openVerification(issued.verification_uri_complete);

    const tokenUrl = new URL(base);
    tokenUrl.pathname += "/device/token";
    const interval = Math.max(2, Number(issued.interval) || 3) * 1_000;
    const deadline = Date.now() + Math.max(60, Number(issued.expires_in) || 600) * 1_000;
    while (Date.now() < deadline) {
      await sleep(interval);
      const tokenResponse = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: issued.device_code }),
        signal: AbortSignal.timeout(20_000),
      });
      if (tokenResponse.status === 428) continue;
      if (!tokenResponse.ok) throw new Error(`Account link failed (${tokenResponse.status})`);
      const payload = await tokenResponse.json();
      const credentials = validCredentials({
        gatewayUrl: payload.gateway_url ?? configured,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
      });
      if (!credentials) throw new Error("Account service returned invalid credentials");
      // A brand-new session always lands, even next to a sign-out of the old one.
      await serialize(async () => {
        await writeCredentials(credentials);
        // The refresh record belonged to the session this one replaces.
        inFlight = null;
        stopPersistRetry();
        await rm(refreshingPath, { force: true }).catch(() => undefined);
      });
      return /** @type {const} */ ({ connected: true, userCode: String(issued.user_code ?? "") });
    }
    throw new Error("Account link expired before it was approved");
  }

  /**
   * Whether a sign-in encrypted with a keyring is on disk while no keyring is
   * usable (the keyring was removed or is not running): the user is asked to
   * sign in again rather than shown as silently signed out.
   */
  async function keyringCopyUnreadable() {
    try {
      await readFile(filePath);
    } catch {
      return false;
    }
    if (!keyringLossLogged) {
      keyringLossLogged = true;
      log("[omnirush] The saved sign-in is encrypted with a system keyring that is not usable now; asking to sign in again.");
    }
    return true;
  }

  /** @returns {Promise<AccountStatus>} */
  async function status() {
    const credentials = await load();
    const configured = await configuredGatewayUrl();
    const gatewayConfigured = Boolean(configured);
    // A connected account reports the server it is actually linked to; a
    // signed-out app reports the server the next sign-in will use.
    const gatewayUrl = credentials?.gatewayUrl ?? configured ?? null;
    const server = { gatewayUrl, gatewayHost: accountServerLabel(gatewayUrl) };
    // Linux without a usable keyring: the sign-in is (or will be) kept in the private file.
    const fileBacked = fileFallback && !(await safeStorage());
    const storage = fileBacked ? { credentialStorage: /** @type {const} */ ("file") } : {};
    if (!credentials) {
      if (fileBacked && await keyringCopyUnreadable()) {
        return { connected: false, gatewayConfigured, ...server, ...storage, reauthorizationRequired: true, keyringUnavailable: true };
      }
      if (signInRequired) return { connected: false, gatewayConfigured, ...server, ...storage, reauthorizationRequired: true };
      return { connected: false, gatewayConfigured, ...server, ...storage };
    }
    try {
      const profile = await fetchProfile(credentials);
      return {
        connected: true,
        gatewayConfigured,
        ...server,
        ...storage,
        email: profile?.email ?? null,
        displayName: profile?.displayName ?? null,
        accountStatus: profile?.status ?? null,
        usage: profile?.usage ?? null,
      };
    } catch (error) {
      if (error instanceof InvalidAccountCredentialsError) {
        await clear({ revokeRemote: false });
        return {
          connected: false,
          gatewayConfigured,
          ...server,
          ...storage,
          reauthorizationRequired: true,
          email: null,
          displayName: null,
          accountStatus: null,
          usage: null,
        };
      }
      // Offline profile lookup must not make a securely stored account look
      // signed out. The next 401 (here or in the broker) refreshes again.
      return {
        connected: true,
        gatewayConfigured,
        ...server,
        ...storage,
        email: null,
        displayName: null,
        accountStatus: null,
        usage: null,
      };
    }
  }

  /**
   * Sign out locally and, for a user-initiated sign-out, revoke the device
   * session remotely and forget the keychain gateway URL so the next sign-in
   * uses the configured default. `revokeRemote: false` is the server-driven
   * invalidation path (the session is already gone), which keeps the gateway
   * URL so re-authorization returns to the same server.
   * @returns {Promise<SignOutOutcome>}
   */
  async function clear({ revokeRemote = true } = {}) {
    // Claim the gate first (synchronously, so no persist slips in), then wait
    // for a rotation still in flight: signing out under it would revoke a
    // retired token (the live session survives) or let its persist land
    // right over the sign-out. A second sign-out waits for the first.
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const signOut = new Promise((resolvePromise) => { release = resolvePromise; });
    const previous = clearInFlight;
    clearInFlight = signOut;
    clearRevokesRemote = revokeRemote;
    try {
      if (previous) await previous;
      await settle({ includeClear: false });
      const credentials = cached ?? await readCredentials();
      /** @type {SignOutOutcome} */
      const outcome = credentials && revokeRemote
        ? await remoteLogout(credentials)
        : { remoteRevoked: true, reason: "already_revoked" };
      await serialize(removeLocalSignIn);
      if (revokeRemote) {
        signInRequired = false;
        await deleteMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity);
      }
      return outcome;
    } finally {
      if (clearInFlight === signOut) clearInFlight = null;
      release();
    }
  }

  return { load, save, refresh, authorize, status, clear };
}
