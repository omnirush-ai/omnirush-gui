import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

function validCredentials(value) {
  if (!value || typeof value !== "object") return null;
  const gatewayUrl = normalizeGatewayUrl(value.gatewayUrl);
  const accessToken = normalizeCredential(value.accessToken);
  const refreshToken = normalizeCredential(value.refreshToken);
  if (!gatewayUrl || !accessToken || !refreshToken) return null;
  return { gatewayUrl, accessToken, refreshToken };
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

export function createDesktopOmniRushAccountStore({
  filePath,
  loadSafeStorage,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = /** @type {SecurityCommandRunner} */ (execFileAsync),
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  let cached = null;
  let refreshInFlight = null;
  const signedOutPath = `${filePath}.signed-out`;
  const runSecurity = (args) => execFileImpl(SECURITY_TOOL, args, { timeout: 5_000, maxBuffer: 64 * 1024 });

  async function safeStorage() {
    const storage = loadSafeStorage();
    if (!storage || !(await storage.isAsyncEncryptionAvailable())) return null;
    if (platform === "linux" && storage.getSelectedStorageBackend() === "basic_text") return null;
    return storage;
  }

  async function loadFile() {
    try {
      const storage = await safeStorage();
      if (!storage) return null;
      const encrypted = await readFile(filePath);
      const decrypted = await storage.decryptStringAsync(encrypted);
      const credentials = validCredentials(JSON.parse(decrypted.result));
      if (credentials && decrypted.shouldReEncrypt) await save(credentials);
      return credentials;
    } catch {
      return null;
    }
  }

  async function load() {
    if (cached) return cached;
    const stored = await loadFile();
    if (stored) {
      cached = stored;
      return stored;
    }
    try {
      await readFile(signedOutPath);
      return null;
    } catch {
      // No sign-out sentinel: legacy credentials may be imported once.
    }
    const imported = validCredentials({
      gatewayUrl: env.OMNIRUSH_GATEWAY_URL ?? await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity),
      accessToken: env.OMNIRUSH_ACCESS_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.accessToken, platform, runSecurity),
      refreshToken: env.OMNIRUSH_REFRESH_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.refreshToken, platform, runSecurity),
    });
    if (imported) {
      cached = imported;
      await save(imported);
    }
    return imported;
  }

  async function save(credentials) {
    const normalized = validCredentials(credentials);
    if (!normalized) throw new Error("Invalid OmniRush account credential bundle");
    const storage = await safeStorage();
    if (!storage) throw new Error("Secure desktop credential storage is unavailable");
    const encrypted = await storage.encryptStringAsync(JSON.stringify(normalized));
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, filePath).catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
    await rm(signedOutPath, { force: true });
    cached = normalized;
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

  async function refresh(credentials) {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const refreshUrl = controlPlaneBase(credentials.gatewayUrl);
      refreshUrl.pathname += "/device/refresh";
      const response = await fetchImpl(refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: credentials.refreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error(`Account refresh unavailable (${response.status})`);
      const payload = await response.json();
      const refreshed = validCredentials({
        gatewayUrl: payload.gateway_url ?? credentials.gatewayUrl,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
      });
      if (!refreshed) throw new Error("Account service returned invalid credentials");
      await save(refreshed);
      return refreshed;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
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

  async function fetchProfile(credentials, allowRefresh = true) {
    const profileUrl = controlPlaneBase(credentials.gatewayUrl);
    profileUrl.pathname += "/device/me";
    const response = await fetchImpl(profileUrl, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 && allowRefresh) {
      const refreshed = await refresh(credentials);
      if (!refreshed) throw new InvalidAccountCredentialsError("Device session expired");
      return fetchProfile(refreshed, false);
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
      await save(credentials);
      return /** @type {const} */ ({ connected: true, userCode: String(issued.user_code ?? "") });
    }
    throw new Error("Account link expired before it was approved");
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
    if (!credentials) return { connected: false, gatewayConfigured, ...server };
    try {
      const profile = await fetchProfile(credentials);
      return {
        connected: true,
        gatewayConfigured,
        ...server,
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
          reauthorizationRequired: true,
          email: null,
          displayName: null,
          accountStatus: null,
          usage: null,
        };
      }
      // Offline profile lookup must not make a securely stored account look
      // signed out. Model requests will still use the broker's refresh path.
      return {
        connected: true,
        gatewayConfigured,
        ...server,
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
    const credentials = cached ?? await load();
    /** @type {SignOutOutcome} */
    const outcome = credentials && revokeRemote
      ? await remoteLogout(credentials)
      : { remoteRevoked: true, reason: "already_revoked" };
    cached = null;
    await rm(filePath, { force: true });
    await mkdir(path.dirname(signedOutPath), { recursive: true });
    await writeFile(signedOutPath, "signed-out\n", { mode: 0o600 });
    if (revokeRemote) await deleteMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity);
    return outcome;
  }

  return { load, save, authorize, status, clear };
}
