import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICES = {
  gatewayUrl: "ai.omnirush.desktop.gateway-url",
  accessToken: "ai.omnirush.desktop.gateway-access",
  refreshToken: "ai.omnirush.desktop.gateway-refresh",
};
const DEFAULT_GATEWAY_URL = "https://api.omnirush.ai/omnirush/v1";
const DEV_GATEWAY_URL = "http://localhost:8090/omnirush/v1";

function normalizeCredential(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeGatewayUrl(value) {
  const normalized = normalizeCredential(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) return null;
    return url.toString().replace(/\/+$/, "");
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

async function readMacKeychain(service, platform) {
  if (platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return normalizeCredential(stdout);
  } catch {
    return null;
  }
}

export function createDesktopOmniRushAccountStore({
  filePath,
  loadSafeStorage,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  let cached = null;
  const signedOutPath = `${filePath}.signed-out`;

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
      gatewayUrl: env.OMNIRUSH_GATEWAY_URL ?? await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform),
      accessToken: env.OMNIRUSH_ACCESS_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.accessToken, platform),
      refreshToken: env.OMNIRUSH_REFRESH_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.refreshToken, platform),
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
    return normalizeGatewayUrl(env.OMNIRUSH_GATEWAY_URL)
      ?? normalizeGatewayUrl(await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform))
      ?? (env.OMNIRUSH_DEV_MODE === "1" ? DEV_GATEWAY_URL : DEFAULT_GATEWAY_URL);
  }

  async function refresh(credentials) {
    const refreshUrl = controlPlaneBase(credentials.gatewayUrl);
    refreshUrl.pathname += "/device/refresh";
    const response = await fetchImpl(refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: credentials.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const refreshed = validCredentials({
      gatewayUrl: payload.gateway_url ?? credentials.gatewayUrl,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
    });
    if (!refreshed) return null;
    await save(refreshed);
    return refreshed;
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

  async function status() {
    const credentials = await load();
    const gatewayConfigured = Boolean(await configuredGatewayUrl());
    if (!credentials) return { connected: false, gatewayConfigured };
    try {
      const profile = await fetchProfile(credentials);
      return {
        connected: true,
        gatewayConfigured,
        email: profile?.email ?? null,
        displayName: profile?.displayName ?? null,
        accountStatus: profile?.status ?? null,
        usage: profile?.usage ?? null,
      };
    } catch (error) {
      if (error instanceof InvalidAccountCredentialsError) {
        return {
          connected: false,
          gatewayConfigured,
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
        email: null,
        displayName: null,
        accountStatus: null,
        usage: null,
      };
    }
  }

  async function clear() {
    cached = null;
    await rm(filePath, { force: true });
    await writeFile(signedOutPath, "signed-out\n", { mode: 0o600 });
  }

  return { load, save, authorize, status, clear };
}
