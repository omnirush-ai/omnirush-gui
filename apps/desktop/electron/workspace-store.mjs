// Desktop workspace persistence and bootstrap configuration. This module owns
// on-disk workspace state, per-workspace omnirush.json files, remote workspace
// normalization/discovery, and the workspace-facing command operations.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  desktopBootstrapPath as resolveDesktopBootstrapPath,
  legacyDesktopBootstrapPath as resolveLegacyDesktopBootstrapPath,
  normalizeWorkspaceRootPath,
  omnirushServerConfigPath as resolveOmniRushServerConfigPath,
} from "@omnirush/paths";

import { omnirushWorkspaceDisplayName, selectOmniRushWorkspaceForConnection } from "./remote-workspace.mjs";
import { exportWorkspaceConfig, importWorkspaceConfig } from "./workspace-archive.mjs";

const EMPTY_WORKSPACE_LIST = Object.freeze({
  selectedId: "",
  watchedId: null,
  activeId: null,
  workspaces: [],
});

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseFirstJsonObject(raw) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          return { ok: true, value: JSON.parse(raw.slice(start, index + 1)) };
        } catch {
          return { ok: false, value: null };
        }
      }
    }
  }

  return { ok: false, value: null };
}

const RENAME_RETRY_DELAYS_MS = [50, 150, 400, 1_000];

// Windows refuses to replace a file another process holds open for a moment
// (antivirus, indexer, a concurrent reader): EPERM, EACCES or EBUSY. Those
// clear on their own, and a lost write here brings a removed workspace back.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function writeJsonFileAtomic(outputPath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    await renameWithRetry(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      const recovered = parseFirstJsonObject(raw);
      if (recovered.ok) {
        console.warn(`[json] recovered ${targetPath} from trailing invalid data`, error);
        await writeJsonFileAtomic(targetPath, recovered.value);
        return recovered.value;
      }
      throw error;
    }
  } catch {
    return fallback;
  }
}

// Resolved once at module load so a mid-session process.env mutation
// (runtime.mjs buildChildEnv -> Object.assign(process.env)) can never retarget
// reads to a different file.
const DEFAULT_DESKTOP_BOOTSTRAP_PATH = resolveDesktopBootstrapPath({ homeDir: os.homedir() });

// Older builds resolved the default as ~/.config on every OS, ignoring
// LOCALAPPDATA and XDG_CONFIG_HOME. Keep reading that file when the canonical one
// is missing so existing installs keep their deployment config.
const LEGACY_DESKTOP_BOOTSTRAP_PATH = resolveLegacyDesktopBootstrapPath({ homeDir: os.homedir() });
// The retired hosted control plane. omnirush.ai has no hosted Den, and these
// hosts no longer resolve in DNS: older builds materialized them as the
// bootstrap default, so a file that still points at them is a stale artifact,
// not a configuration. It is rejected on read (defaults apply instead) and on
// write, and nothing here ever contacts these hosts. The omnirush.software
// hosts are the upstream product's hosted origins; they were never ours and
// have no DNS, so they are rejected the same way.
const RETIRED_HOSTED_CONTROL_PLANE_HOSTS = new Set([
  "omnirushlabs.com",
  "app.omnirushlabs.com",
  "api.omnirushlabs.com",
  "api.app.omnirushlabs.com",
  "omnirush.software",
  "app.omnirush.software",
  "api.omnirush.software",
]);

export function isRetiredHostedControlPlaneUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return RETIRED_HOSTED_CONTROL_PLANE_HOSTS.has(new URL(value.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function createWorkspaceStore({
  app,
  defaultDenBaseUrl,
  defaultRequireSignin,
  forceRequireSignin,
}) {
  function desktopBootstrapPath() {
    if (process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH?.trim()) {
      return resolveDesktopBootstrapPath({ env: process.env, homeDir: os.homedir(), userDataDir: app.getPath("userData") });
    }
    // Dev mode swaps process.env.HOME to the sandboxed dev-data home midway
    // through startup (runtime.mjs buildChildEnv -> Object.assign(process.env)),
    // which changes what os.homedir() returns. Resolve the dev-data home
    // deterministically so early and late IPC reads target the same file.
    if (process.env.OMNIRUSH_DEV_MODE === "1") {
      return resolveDesktopBootstrapPath({ env: process.env, homeDir: os.homedir(), userDataDir: app.getPath("userData") });
    }
    return DEFAULT_DESKTOP_BOOTSTRAP_PATH;
  }

  function legacyDesktopBootstrapPath() {
    // An explicit bootstrap path defines an isolated installation boundary.
    // Never let a legacy global config cross that boundary: it may contain a
    // completed activation from another distribution or deployment.
    if (process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH?.trim()) return null;
    const primary = desktopBootstrapPath();
    if (primary === DEFAULT_DESKTOP_BOOTSTRAP_PATH && LEGACY_DESKTOP_BOOTSTRAP_PATH !== primary) {
      return LEGACY_DESKTOP_BOOTSTRAP_PATH;
    }
    return null;
  }

  function workspaceStatePath() {
    const override = process.env.OMNIRUSH_DESKTOP_WORKSPACE_STATE_PATH?.trim();
    if (override) return path.resolve(override);
    return path.join(app.getPath("userData"), "omnirush-workspaces.json");
  }

  function omnirushServerTokenStorePath() {
    const override = process.env.OMNIRUSH_SERVER_TOKEN_STORE_PATH?.trim();
    if (override) return path.resolve(override);
    return path.join(app.getPath("userData"), "omnirush-server-tokens.json");
  }

  function omnirushServerConfigPath() {
    return resolveOmniRushServerConfigPath({ env: process.env, homeDir: os.homedir() });
  }

  // Earlier Electron alpha builds copied Tauri's omnirush-workspaces.json into
  // an Electron-only workspace-state.json. Keep importing that file when the
  // shared canonical file is missing, but write omnirush-workspaces.json going
  // forward so Tauri rollback and Electron both read the same desktop state.
  function legacyElectronWorkspaceStatePath() {
    return path.join(app.getPath("userData"), "workspace-state.json");
  }

  async function migrateLegacyElectronWorkspaceStateIfNeeded() {
    const current = workspaceStatePath();
    const legacy = legacyElectronWorkspaceStatePath();
    try {
      if (existsSync(current)) return false;
      if (!existsSync(legacy)) return false;
      await mkdir(path.dirname(current), { recursive: true });
      const raw = await readFile(legacy, "utf8");
      await writeFile(current, raw, "utf8");
      console.info("[migration] copied workspace-state.json to omnirush-workspaces.json");
      return true;
    } catch (error) {
      console.warn("[migration] legacy Electron workspace-state copy failed", error);
      return false;
    }
  }

  function normalizeDesktopBootstrapConfig(input) {
    const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }
    if (isRetiredHostedControlPlaneUrl(baseUrl) || isRetiredHostedControlPlaneUrl(input?.apiBaseUrl)) {
      throw new Error("baseUrl points at the retired hosted control plane, which no longer exists");
    }

    // The handoff grant is a one-time, short-lived (~5 min) desktop sign-in
    // token written to this machine-local config by the bootstrap CLI. The app
    // exchanges it once on boot and then rewrites this file with `handoff: null`
    // (see den-auth-provider) so it is never reusable. It is intentionally kept
    // in plaintext here because it is single-use and local-only; do not persist
    // long-lived secrets in this file.
    const handoffInput = input?.handoff;
    const handoff = handoffInput && typeof handoffInput === "object"
      ? {
          grant: typeof handoffInput.grant === "string" ? handoffInput.grant.trim() : "",
          denBaseUrl: typeof handoffInput.denBaseUrl === "string" ? handoffInput.denBaseUrl.trim() : "",
          orgId: typeof handoffInput.orgId === "string" ? handoffInput.orgId.trim() : "",
          orgName: typeof handoffInput.orgName === "string" ? handoffInput.orgName.trim() : "",
          orgSlug: typeof handoffInput.orgSlug === "string" ? handoffInput.orgSlug.trim() : "",
          skillId: typeof handoffInput.skillId === "string" ? handoffInput.skillId.trim() : "",
          skillTitle: typeof handoffInput.skillTitle === "string" ? handoffInput.skillTitle.trim() : "",
          createdAt: typeof handoffInput.createdAt === "string" ? handoffInput.createdAt.trim() : "",
        }
      : null;
    const normalizedHandoff = handoff?.grant && handoff.denBaseUrl && handoff.orgId && handoff.orgName && handoff.skillId && handoff.skillTitle
      ? handoff
      : null;
    const preparedInput = input?.prepared;
    const prepared = preparedInput && typeof preparedInput === "object"
      ? {
          orgId: typeof preparedInput.orgId === "string" ? preparedInput.orgId.trim() : "",
          orgName: typeof preparedInput.orgName === "string" ? preparedInput.orgName.trim() : "",
          orgSlug: typeof preparedInput.orgSlug === "string" ? preparedInput.orgSlug.trim() : "",
          skillId: typeof preparedInput.skillId === "string" ? preparedInput.skillId.trim() : "",
          skillTitle: typeof preparedInput.skillTitle === "string" ? preparedInput.skillTitle.trim() : "",
          skillsDir: typeof preparedInput.skillsDir === "string" ? preparedInput.skillsDir.trim() : "",
          skillPath: typeof preparedInput.skillPath === "string" ? preparedInput.skillPath.trim() : "",
          preparedAt: typeof preparedInput.preparedAt === "string" ? preparedInput.preparedAt.trim() : "",
        }
      : null;
    const normalizedPrepared = prepared?.orgId && prepared.orgName && prepared.skillId && prepared.skillTitle && prepared.skillPath
      ? prepared
      : null;
    const claimLinksInput = Array.isArray(input?.claimLinks) ? input.claimLinks : [];
    const claimLinks = claimLinksInput.flatMap((link) => {
      if (!link || typeof link !== "object") return [];
      const id = typeof link.id === "string" ? link.id.trim() : "";
      const role = typeof link.role === "string" ? link.role.trim() : "";
      const token = typeof link.token === "string" ? link.token.trim() : "";
      const url = typeof link.url === "string" ? link.url.trim() : "";
      const expiresAt = typeof link.expiresAt === "string" ? link.expiresAt.trim() : "";
      return id && role && url && expiresAt ? [{ id, role, ...(token ? { token } : {}), url, expiresAt }] : [];
    });
    const writtenAt = typeof input?.writtenAt === "string" ? input.writtenAt.trim() : "";
    const apiBaseUrl = typeof input?.apiBaseUrl === "string" ? input.apiBaseUrl.trim() : "";
    const brandAppName = typeof input?.brandAppName === "string" ? input.brandAppName.trim().slice(0, 64) : "";
    const brandLogoUrl = typeof input?.brandLogoUrl === "string" ? input.brandLogoUrl.trim() : "";
    const brandIconUrl = typeof input?.brandIconUrl === "string" ? input.brandIconUrl.trim() : "";
    const enterpriseActivationInput = input?.enterpriseActivation;
    const enterpriseActivation = enterpriseActivationInput && typeof enterpriseActivationInput === "object"
      ? {
          activatedAt: typeof enterpriseActivationInput.activatedAt === "string"
            ? enterpriseActivationInput.activatedAt.trim()
            : "",
          denBaseUrl: typeof enterpriseActivationInput.denBaseUrl === "string"
            ? enterpriseActivationInput.denBaseUrl.trim()
            : "",
        }
      : null;
    const normalizedEnterpriseActivation = enterpriseActivation?.activatedAt && enterpriseActivation.denBaseUrl
      ? enterpriseActivation
      : null;
    return {
      baseUrl,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      requireSignin: forceRequireSignin || input?.requireSignin === true,
      // Only an explicit policy is carried. The artifact default is never
      // materialized here: desktop-bootstrap.json is shared by both flavors
      // (one application identifier, one user-data directory), so persisting
      // the enterprise default would gate the public artifact on the same
      // machine. Consumers fall back to their own build default when the key
      // is absent, which is exactly the documented precedence.
      ...(typeof input?.requireActivation === "boolean"
        ? { requireActivation: input.requireActivation }
        : {}),
      ...(brandAppName ? { brandAppName } : {}),
      ...(brandLogoUrl ? { brandLogoUrl } : {}),
      ...(brandIconUrl ? { brandIconUrl } : {}),
      ...(writtenAt ? { writtenAt } : {}),
      ...(claimLinks.length > 0 ? { claimLinks } : {}),
      ...(normalizedHandoff ? { handoff: normalizedHandoff } : {}),
      ...(normalizedPrepared ? { prepared: normalizedPrepared } : {}),
      ...(normalizedEnterpriseActivation ? { enterpriseActivation: normalizedEnterpriseActivation } : {}),
    };
  }

  function desktopBootstrapCandidateTimeMs(candidate) {
    const writtenAt = typeof candidate.parsed?.writtenAt === "string" ? candidate.parsed.writtenAt.trim() : "";
    const writtenAtMs = writtenAt ? Date.parse(writtenAt) : Number.NaN;
    return Number.isFinite(writtenAtMs) ? writtenAtMs : candidate.mtimeMs;
  }

  function compareDesktopBootstrapCandidates(left, right) {
    return desktopBootstrapCandidateTimeMs(left) - desktopBootstrapCandidateTimeMs(right);
  }

  async function readDesktopBootstrapCandidate(candidatePath) {
    let exists = false;
    let mtimeMs = 0;
    try {
      const stats = await stat(candidatePath);
      exists = true;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Missing paths are normal; keep the read error below for diagnostics.
    }

    try {
      const raw = await readFile(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        path: candidatePath,
        exists: true,
        raw,
        parsed,
        normalized: normalizeDesktopBootstrapConfig(parsed),
        mtimeMs,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        path: candidatePath,
        exists,
        raw: null,
        parsed: null,
        normalized: null,
        mtimeMs,
        error,
      };
    }
  }

  function readDesktopBootstrapCandidateSync(candidatePath) {
    let exists = false;
    let mtimeMs = 0;
    try {
      const stats = statSync(candidatePath);
      exists = true;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Missing paths are normal; keep the read error below for diagnostics.
    }

    try {
      const raw = readFileSync(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        path: candidatePath,
        exists: true,
        raw,
        parsed,
        normalized: normalizeDesktopBootstrapConfig(parsed),
        mtimeMs,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        path: candidatePath,
        exists,
        raw: null,
        parsed: null,
        normalized: null,
        mtimeMs,
        error,
      };
    }
  }

  async function migrateLegacyDesktopBootstrapConfig(configPath, legacyCandidate) {
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, legacyCandidate.raw, "utf8");
      console.info("[desktop-bootstrap] migrated legacy config", {
        from: legacyCandidate.path,
        to: configPath,
      });
    } catch (migrationError) {
      console.warn("[desktop-bootstrap] legacy config migration failed", migrationError);
    }
  }

  async function getDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    const primary = await readDesktopBootstrapCandidate(configPath);
    const legacyPath = legacyDesktopBootstrapPath();
    const legacy = legacyPath ? await readDesktopBootstrapCandidate(legacyPath) : null;

    if (primary.ok && legacy?.ok) {
      if (compareDesktopBootstrapCandidates(legacy, primary) > 0) {
        await migrateLegacyDesktopBootstrapConfig(configPath, legacy);
        return { ...legacy.normalized, fromFile: true };
      }
      return { ...primary.normalized, fromFile: true };
    }

    if (primary.ok) return { ...primary.normalized, fromFile: true };

    if (legacy?.ok) {
      await migrateLegacyDesktopBootstrapConfig(configPath, legacy);
      return { ...legacy.normalized, fromFile: true };
    }

    console.warn("[desktop-bootstrap] falling back to defaults", {
      path: configPath,
      error: primary.error instanceof Error ? primary.error.message : String(primary.error),
    });
    return {
      baseUrl: defaultDenBaseUrl,
      requireSignin: defaultRequireSignin,
      fromFile: false,
    };
  }

  function readDesktopBootstrapConfigSync() {
    const configPath = desktopBootstrapPath();
    const primary = readDesktopBootstrapCandidateSync(configPath);
    const legacyPath = legacyDesktopBootstrapPath();
    const legacy = legacyPath ? readDesktopBootstrapCandidateSync(legacyPath) : null;

    if (primary.ok && legacy?.ok) {
      return {
        ...(compareDesktopBootstrapCandidates(legacy, primary) > 0 ? legacy.normalized : primary.normalized),
        fromFile: true,
      };
    }

    if (primary.ok) return { ...primary.normalized, fromFile: true };
    if (legacy?.ok) return { ...legacy.normalized, fromFile: true };

    return {
      baseUrl: defaultDenBaseUrl,
      requireSignin: defaultRequireSignin,
      fromFile: false,
    };
  }

  async function debugDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    const legacyPath = legacyDesktopBootstrapPath();
    const result = {
      path: configPath,
      legacyPath,
      legacyExists: legacyPath ? existsSync(legacyPath) : false,
      home: os.homedir(),
      envHome: process.env.HOME ?? null,
      envOverride: process.env.OMNIRUSH_DESKTOP_BOOTSTRAP_PATH ?? null,
      exists: existsSync(configPath),
      raw: null,
      parsed: null,
      normalized: null,
      error: null,
    };

    try {
      result.raw = await readFile(configPath, "utf8");
      result.parsed = JSON.parse(result.raw);
      result.normalized = normalizeDesktopBootstrapConfig(result.parsed);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  async function setDesktopBootstrapConfig(config) {
    const normalized = normalizeDesktopBootstrapConfig(config);
    const outputPath = desktopBootstrapPath();
    const stamped = { ...normalized, writtenAt: new Date().toISOString() };
    await writeJsonFileAtomic(outputPath, stamped);
    return stamped;
  }

  async function clearDesktopBootstrapFiles() {
    await rm(desktopBootstrapPath(), { force: true });
    const legacyPath = legacyDesktopBootstrapPath();
    if (legacyPath) {
      await rm(legacyPath, { force: true });
    }
  }

  async function clearDesktopBootstrapConfig() {
    await clearDesktopBootstrapFiles();
    return undefined;
  }

  function defaultWorkspaceOmniRushConfig(workspacePath, preset = null) {
    return {
      version: 1,
      workspace: workspacePath
        ? {
            name: path.basename(workspacePath) || "Workspace",
            createdAt: Date.now(),
            preset: preset || null,
          }
        : null,
      authorizedRoots: workspacePath ? [workspacePath] : [],
      reload: null,
    };
  }

  async function normalizeLocalWorkspacePath(rawPath) {
    const trimmed = String(rawPath ?? "").trim();
    if (!trimmed) return "";
    const expanded = trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
    const normalized = normalizeWorkspaceRootPath(expanded, { platform: process.platform });
    const resolved = path.resolve(normalized);
    return realpath(resolved).catch(() => resolved);
  }

  function normalizeWorkspacePathKey(value) {
    try {
      const normalized = normalizeWorkspaceRootPath(value, { platform: process.platform });
      return normalized ? path.resolve(normalized).replace(/\\/g, "/").toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function normalizeRecoveredWorkspacePath(value) {
    try {
      return normalizeWorkspaceRootPath(value, { platform: process.platform });
    } catch {
      return "";
    }
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }

  async function recoverWorkspacesFromTokenStore() {
    const store = await readJsonFile(omnirushServerTokenStorePath(), null);
    if (!isRecord(store) || !isRecord(store.workspaces)) return [];

    const candidates = [];
    for (const [rawPath, entry] of Object.entries(store.workspaces)) {
      const normalizedInput = normalizeRecoveredWorkspacePath(rawPath);
      if (!normalizedInput) continue;
      const workspacePath = await normalizeLocalWorkspacePath(normalizedInput);
      if (!(await pathExists(workspacePath))) continue;
      candidates.push({
        path: workspacePath,
        updatedAt: isRecord(entry) && typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      });
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const seen = new Set();
    return candidates.flatMap((candidate) => {
      const key = normalizeWorkspacePathKey(candidate.path);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [normalizeWorkspaceEntry({
        id: localWorkspaceId(candidate.path),
        name: path.basename(candidate.path) || "Workspace",
        displayName: path.basename(candidate.path) || "Workspace",
        path: candidate.path,
        preset: "starter",
        workspaceType: "local",
      })];
    });
  }

  async function forgetWorkspaceToken(workspacePath) {
    const workspaceKey = normalizeWorkspacePathKey(workspacePath);
    if (!workspaceKey) return;

    const store = await readJsonFile(omnirushServerTokenStorePath(), null);
    if (!isRecord(store) || !isRecord(store.workspaces)) return;

    const workspaces = { ...store.workspaces };
    let changed = false;
    for (const storedPath of Object.keys(workspaces)) {
      if (normalizeWorkspacePathKey(normalizeRecoveredWorkspacePath(storedPath)) !== workspaceKey) continue;
      delete workspaces[storedPath];
      changed = true;
    }
    if (changed) {
      await writeJsonFileAtomic(omnirushServerTokenStorePath(), { ...store, workspaces });
    }
  }

  async function recoverWorkspacesFromServerConfig() {
    const config = await readJsonFile(omnirushServerConfigPath(), null);
    if (!isRecord(config) || !Array.isArray(config.workspaces)) return [];

    const seen = new Set();
    const workspaces = [];
    for (const entry of config.workspaces) {
      if (!isRecord(entry)) continue;
      const workspaceType = entry.workspaceType === "remote" ? "remote" : "local";
      const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
      const normalizedPath = workspaceType === "local"
        ? await normalizeLocalWorkspacePath(normalizeRecoveredWorkspacePath(rawPath))
        : rawPath;
      if (workspaceType === "local" && (!normalizedPath || !(await pathExists(normalizedPath)))) continue;

      const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
      const directory = typeof entry.directory === "string" && entry.directory.trim() ? entry.directory.trim() : null;
      const remoteType = entry.remoteType === "opencode" ? "opencode" : "omnirush";
      const omnirushWorkspaceId = typeof entry.omnirushWorkspaceId === "string" ? entry.omnirushWorkspaceId.trim() : "";
      const id = typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : workspaceType === "remote"
          ? remoteType === "omnirush"
            ? omnirushRemoteWorkspaceId(baseUrl, omnirushWorkspaceId)
            : remoteWorkspaceId(baseUrl, directory)
          : localWorkspaceId(normalizedPath);
      const key = workspaceType === "remote" ? id : normalizeWorkspacePathKey(normalizedPath);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      workspaces.push(normalizeWorkspaceEntry({
        ...entry,
        id,
        path: normalizedPath,
        name: typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : path.basename(normalizedPath) || "Workspace",
        displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
        preset: typeof entry.preset === "string" && entry.preset.trim() ? entry.preset.trim() : "starter",
        workspaceType,
        ...(workspaceType === "remote" ? { remoteType, baseUrl, directory } : {}),
      }));
    }
    return workspaces;
  }

  async function recoverWorkspacesFromKnownState() {
    const fromServerConfig = await recoverWorkspacesFromServerConfig();
    if (fromServerConfig.length > 0) return fromServerConfig;
    return recoverWorkspacesFromTokenStore();
  }

  function stableWorkspaceId(value) {
    return `ws_${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
  }

  function localWorkspaceId(workspacePath) {
    return stableWorkspaceId(workspacePath);
  }

  function remoteWorkspaceId(baseUrl, directory) {
    const key = String(directory ?? "").trim()
      ? `remote::${baseUrl}::${String(directory).trim()}`
      : `remote::${baseUrl}`;
    return stableWorkspaceId(key);
  }

  function parseOmniRushWorkspaceIdFromUrl(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const segments = url.pathname.split("/").filter(Boolean);
      const workspaceIndex = segments.indexOf("workspace");
      const legacyIndex = segments.indexOf("w");
      const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
      return mountIndex >= 0 && segments[mountIndex + 1]
        ? decodeURIComponent(segments[mountIndex + 1])
        : null;
    } catch {
      const match = raw.match(/\/(?:workspace|w)\/([^/?#]+)/);
      if (!match?.[1]) return null;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }

  function stripOmniRushWorkspaceMount(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const segments = url.pathname.split("/").filter(Boolean);
      const workspaceIndex = segments.indexOf("workspace");
      const legacyIndex = segments.indexOf("w");
      const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
      if (mountIndex >= 0 && segments[mountIndex + 1]) {
        const prefix = segments.slice(0, mountIndex).join("/");
        url.pathname = prefix ? `/${prefix}` : "/";
      }
      return url.toString().replace(/\/+$/, "");
    } catch {
      return raw.replace(/\/(?:workspace|w)\/[^/?#]+.*$/, "").replace(/\/+$/, "") || raw;
    }
  }

  function omnirushRemoteWorkspaceId(hostUrl, workspaceId) {
    const remoteWorkspaceId = String(workspaceId ?? "").trim() || parseOmniRushWorkspaceIdFromUrl(hostUrl);
    if (remoteWorkspaceId) return `rem_${remoteWorkspaceId}`;
    return `rem_${createHash("sha256").update(`omnirush::${hostUrl}`).digest("hex").slice(0, 12)}`;
  }

  async function fetchOmniRushWorkspaceList(hostUrl, token, hostToken) {
    const url = `${String(hostUrl ?? "").replace(/\/+$/, "")}/workspaces`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const headers = new Headers();
    const bearerToken = String(token ?? "").trim();
    const hostAuthToken = String(hostToken ?? "").trim();
    if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
    if (hostAuthToken) headers.set("X-OmniRush-Host-Token", hostAuthToken);

    try {
      const electron = await import("electron").catch(() => null);
      const fetcher = typeof electron?.net?.fetch === "function" ? electron.net.fetch.bind(electron.net) : fetch;
      const response = await fetcher(url, {
        headers,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`OmniRush.ai workspace discovery failed (${response.status} ${response.statusText || "HTTP error"})`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function discoverOmniRushWorkspace({ hostUrl, token, hostToken, directory }) {
    const list = await fetchOmniRushWorkspaceList(hostUrl, token, hostToken);
    return selectOmniRushWorkspaceForConnection(list, directory);
  }

  function normalizeWorkspaceEntry(input) {
    return {
      id: String(input.id),
      name: String(input.name ?? "Workspace"),
      path: String(input.path ?? ""),
      preset: String(input.preset ?? "starter"),
      workspaceType: input.workspaceType === "remote" ? "remote" : "local",
      remoteType: input.remoteType ?? null,
      baseUrl: input.baseUrl ?? null,
      directory: input.directory ?? null,
      displayName: input.displayName ?? null,
      omnirushHostUrl: input.omnirushHostUrl ?? null,
      omnirushToken: input.omnirushToken ?? null,
      omnirushClientToken: input.omnirushClientToken ?? null,
      omnirushHostToken: input.omnirushHostToken ?? null,
      omnirushWorkspaceId: input.omnirushWorkspaceId ?? null,
      omnirushWorkspaceName: input.omnirushWorkspaceName ?? null,
      sandboxBackend: input.sandboxBackend ?? null,
      sandboxRunId: input.sandboxRunId ?? null,
      sandboxContainerName: input.sandboxContainerName ?? null,
    };
  }

  async function readWorkspaceOmniRushConfig(workspacePath) {
    const omnirushPath = path.join(workspacePath, ".opencode", "omnirush.json");
    if (!(await pathExists(omnirushPath))) {
      return defaultWorkspaceOmniRushConfig(workspacePath);
    }
    const raw = await readFile(omnirushPath, "utf8");
    return JSON.parse(raw);
  }

  async function writeWorkspaceOmniRushConfig(workspacePath, config) {
    const omnirushPath = path.join(workspacePath, ".opencode", "omnirush.json");
    await mkdir(path.dirname(omnirushPath), { recursive: true });
    await writeFile(omnirushPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return execResult(true, `Wrote ${omnirushPath}`);
  }

  async function writeWorkspaceState(nextState) {
    const outputPath = workspaceStatePath();
    const selectedId = String(nextState?.selectedId ?? nextState?.activeId ?? "");
    const watchedId = typeof nextState?.watchedId === "string" ? nextState.watchedId : "";
    const output = {
      ...nextState,
      // Tauri's Rust state uses selectedWorkspaceId/watchedWorkspaceId on disk
      // with activeId as a legacy alias. Keep Electron's selectedId/watchedId
      // too so older Electron builds can still read the same file.
      selectedId,
      selectedWorkspaceId: selectedId,
      watchedId: watchedId || null,
      watchedWorkspaceId: watchedId,
      activeId: selectedId || null,
    };
    await writeJsonFileAtomic(outputPath, output);
    return output;
  }

  async function readWorkspaceState() {
    const workspaceStateExists = existsSync(workspaceStatePath());
    const state = await readJsonFile(workspaceStatePath(), EMPTY_WORKSPACE_LIST);
    let selectedId =
      typeof state?.selectedId === "string"
        ? state.selectedId
        : typeof state?.selectedWorkspaceId === "string"
          ? state.selectedWorkspaceId
          : typeof state?.activeId === "string"
            ? state.activeId
            : "";
    let watchedId =
      typeof state?.watchedId === "string"
        ? state.watchedId
        : typeof state?.watchedWorkspaceId === "string"
          ? state.watchedWorkspaceId
          : null;
    let activeId = typeof state?.activeId === "string" ? state.activeId : null;
    let workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
    let changed = false;
    if (!workspaceStateExists && process.env.OMNIRUSH_DESKTOP_DISABLE_WORKSPACE_RECOVERY !== "1") {
      const recoveredWorkspaces = await recoverWorkspacesFromKnownState();
      if (recoveredWorkspaces.length > 0) {
        const selectedWorkspace = recoveredWorkspaces[0];
        console.info("[migration] recovered desktop workspaces from persisted OmniRush.ai state", {
          count: recoveredWorkspaces.length,
          selectedWorkspaceId: selectedWorkspace.id,
        });
        selectedId = selectedWorkspace.id;
        watchedId = selectedWorkspace.id;
        activeId = selectedWorkspace.id;
        workspaces = recoveredWorkspaces;
        changed = true;
      }
    }
    const idMap = new Map();
    const migratedWorkspaces = workspaces.map((entry) => {
      const workspace = entry && typeof entry === "object" ? entry : normalizeWorkspaceEntry(entry ?? {});
      if (workspace.workspaceType !== "remote" || workspace.remoteType !== "omnirush") return workspace;

      const remoteWorkspaceId = String(workspace.omnirushWorkspaceId ?? "").trim()
        || parseOmniRushWorkspaceIdFromUrl(workspace.omnirushHostUrl)
        || parseOmniRushWorkspaceIdFromUrl(workspace.baseUrl);
      if (!remoteWorkspaceId) return workspace;

      const hostUrl = stripOmniRushWorkspaceMount(workspace.omnirushHostUrl) || stripOmniRushWorkspaceMount(workspace.baseUrl);
      const nextId = omnirushRemoteWorkspaceId(hostUrl ?? workspace.baseUrl, remoteWorkspaceId);
      idMap.set(workspace.id, nextId);
      const nextWorkspace = {
        ...workspace,
        id: nextId,
        baseUrl: hostUrl,
        omnirushWorkspaceId: remoteWorkspaceId,
        omnirushHostUrl: hostUrl,
      };
      if (workspace.id !== nextWorkspace.id || workspace.baseUrl !== nextWorkspace.baseUrl || workspace.omnirushWorkspaceId !== nextWorkspace.omnirushWorkspaceId || workspace.omnirushHostUrl !== nextWorkspace.omnirushHostUrl) {
        changed = true;
      }
      return nextWorkspace;
    });
    // Older desktop state can contain multiple OmniRush.ai remote entries that
    // normalize to the same rem_<workspaceId> after stripping worker mounts.
    // Collapse them here so React never receives duplicate workspace keys.
    const workspaceIndexById = new Map();
    const dedupedWorkspaces = [];
    for (const workspace of migratedWorkspaces) {
      const workspaceId = String(workspace?.id ?? "").trim();
      if (!workspaceId) {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const existingIndex = workspaceIndexById.get(workspaceId);
      if (existingIndex === undefined) {
        workspaceIndexById.set(workspaceId, dedupedWorkspaces.length);
        dedupedWorkspaces.push(workspace);
        continue;
      }
      // Keep the later entry: normal mutations replace-then-push refreshed
      // remote workspaces, and there is no persisted updatedAt to compare.
      dedupedWorkspaces[existingIndex] = workspace;
      changed = true;
    }

    const migratedSelectedId = idMap.get(selectedId) ?? selectedId;
    const migratedWatchedId = watchedId ? idMap.get(watchedId) ?? watchedId : null;
    const migratedActiveId = activeId ? idMap.get(activeId) ?? activeId : null;
    if (migratedSelectedId !== selectedId || migratedWatchedId !== watchedId || migratedActiveId !== activeId) changed = true;

    const nextState = {
      selectedId: migratedSelectedId,
      watchedId: migratedWatchedId,
      activeId: migratedActiveId,
      workspaces: dedupedWorkspaces,
    };

    if (changed) {
      return writeWorkspaceState(nextState);
    }
    return nextState;
  }

  // One read-modify-write at a time: two overlapping ones (a removal and a
  // selection change) would let the later write put back what the earlier
  // one removed.
  let workspaceStateMutations = Promise.resolve();
  function mutateWorkspaceState(mutator) {
    const run = workspaceStateMutations.catch(() => undefined).then(async () => {
      const current = await readWorkspaceState();
      const next = await mutator({ ...current, workspaces: [...current.workspaces] });
      return writeWorkspaceState(next);
    });
    workspaceStateMutations = run;
    return run;
  }

  async function bootstrapFirstLaunchWorkspace() {
    const state = await readWorkspaceState();
    // Recovery and an explicitly saved empty list both take precedence.
    if (state.workspaces.length > 0 || existsSync(workspaceStatePath())) return null;
    const home = process.env.OMNIRUSH_DEV_MODE === "1" && process.env.OMNIRUSH_DEV_SHARED_STATE !== "1"
      ? path.join(app.getPath("userData"), "omnirush-dev-data", "home")
      : os.homedir();
    const folderPath = await normalizeLocalWorkspacePath(path.join(home, "omnirush.ai"));
    try {
      await createWorkspace({ folderPath });
      return null;
    } catch (error) {
      // A blocked default folder is recoverable by choosing another folder.
      // Never hide registry writes or unexpected initialization failures.
      if (
        !["EEXIST", "ENOTDIR", "EACCES", "EPERM", "EROFS"].includes(error?.code)
        || typeof error.path !== "string"
        || (error.path !== folderPath && !error.path.startsWith(`${folderPath}${path.sep}`))
      ) throw error;
      return { folderPath, error: error.message };
    }
  }

  async function listLocalWorkspacePaths() {
    return (await readWorkspaceState())
      .workspaces
      .filter((entry) => entry?.workspaceType !== "remote")
      .map((entry) => String(entry?.path ?? "").trim())
      .filter(Boolean);
  }

  // Binary transfers must derive authority only from app-owned state in
  // userData, never from workspace-writable configuration, so this list is
  // intentionally not exposed to that surface (see listLocalWorkspacePaths).
  async function listRemoteWorkspaceUrlPrefixes() {
    const prefixes = new Set();
    for (const workspace of (await readWorkspaceState()).workspaces) {
      if (workspace?.workspaceType !== "remote") continue;
      for (const value of [workspace.baseUrl, workspace.omnirushHostUrl]) {
        const raw = typeof value === "string" ? value.trim() : "";
        if (raw) prefixes.add(raw);
      }
    }
    return [...prefixes];
  }

  function workspacePathKey(workspace) {
    return normalizeWorkspacePathKey(workspace.path);
  }

  async function setSelectedWorkspace(workspaceId) {
    return mutateWorkspaceState((state) => {
      state.selectedId = workspaceId;
      state.activeId = workspaceId || null;
      return state;
    });
  }

  async function setRuntimeActiveWorkspace(workspaceId) {
    return mutateWorkspaceState((state) => {
      state.watchedId = typeof workspaceId === "string" && workspaceId.trim() ? workspaceId : null;
      return state;
    });
  }

  async function createWorkspace(input = {}) {
    const rawFolderPath = String(input.folderPath ?? "").trim();
    if (!rawFolderPath) throw new Error("folderPath is required");
    const folderPath = await normalizeLocalWorkspacePath(rawFolderPath);
    await mkdir(folderPath, { recursive: true });
    const preset = String(input.preset ?? "starter");
    const workspace = normalizeWorkspaceEntry({
      id: localWorkspaceId(folderPath),
      name: String(input.name ?? (path.basename(folderPath) || "Workspace")),
      displayName: String(input.name ?? (path.basename(folderPath) || "Workspace")),
      path: folderPath,
      preset,
      workspaceType: "local",
    });
    await mkdir(path.join(folderPath, ".opencode"), { recursive: true });
    if (!(await pathExists(path.join(folderPath, ".opencode", "omnirush.json")))) {
      await writeWorkspaceOmniRushConfig(folderPath, defaultWorkspaceOmniRushConfig(folderPath, preset));
    }

    return mutateWorkspaceState((state) => {
      const key = workspacePathKey(workspace);
      state.workspaces = state.workspaces.filter(
        (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== key,
      );
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      state.watchedId = workspace.id;
      return state;
    });
  }

  async function createRemoteWorkspace(input = {}) {
    const baseUrl = String(input.baseUrl ?? "").trim();
    if (!baseUrl) throw new Error("baseUrl is required");
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      throw new Error("baseUrl must start with http:// or https://");
    }
    const remoteType = input.remoteType === "opencode" ? "opencode" : "omnirush";
    const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
    const rawOmniRushHostUrl = typeof input.omnirushHostUrl === "string" && input.omnirushHostUrl.trim()
      ? input.omnirushHostUrl.trim()
      : null;
    const omnirushHostUrl = remoteType === "omnirush"
      ? stripOmniRushWorkspaceMount(rawOmniRushHostUrl ?? baseUrl)
      : rawOmniRushHostUrl;
    const omnirushWorkspaceId = typeof input.omnirushWorkspaceId === "string" && input.omnirushWorkspaceId.trim()
      ? input.omnirushWorkspaceId.trim()
      : remoteType === "omnirush"
        ? parseOmniRushWorkspaceIdFromUrl(rawOmniRushHostUrl) || parseOmniRushWorkspaceIdFromUrl(baseUrl)
        : null;
    let resolvedOmniRushWorkspaceId = omnirushWorkspaceId;
    let resolvedOmniRushWorkspaceName = input.omnirushWorkspaceName ?? null;
    if (remoteType === "omnirush" && !resolvedOmniRushWorkspaceId) {
      const discovered = await discoverOmniRushWorkspace({
        hostUrl: omnirushHostUrl ?? baseUrl,
        token: input.omnirushToken,
        hostToken: input.omnirushHostToken,
        directory,
      });
      if (!discovered?.id) {
        throw new Error(
          directory
            ? `OmniRush.ai server has no workspace matching ${directory}.`
            : "OmniRush.ai server returned no workspaces.",
        );
      }
      resolvedOmniRushWorkspaceId = String(discovered.id).trim();
      resolvedOmniRushWorkspaceName = omnirushWorkspaceDisplayName(discovered);
    }
    const id = remoteType === "omnirush"
      ? omnirushRemoteWorkspaceId(omnirushHostUrl ?? baseUrl, resolvedOmniRushWorkspaceId)
      : remoteWorkspaceId(baseUrl, directory);
    const workspace = normalizeWorkspaceEntry({
      id,
      name: String(input.displayName ?? resolvedOmniRushWorkspaceName ?? "Remote workspace"),
      displayName: input.displayName ?? null,
      path: directory ?? "",
      preset: "remote",
      workspaceType: "remote",
      remoteType,
      baseUrl: remoteType === "omnirush" ? (omnirushHostUrl ?? baseUrl) : baseUrl,
      directory,
      omnirushHostUrl,
      omnirushToken: input.omnirushToken ?? null,
      omnirushClientToken: input.omnirushClientToken ?? null,
      omnirushHostToken: input.omnirushHostToken ?? null,
      omnirushWorkspaceId: resolvedOmniRushWorkspaceId,
      omnirushWorkspaceName: resolvedOmniRushWorkspaceName,
      sandboxBackend: input.sandboxBackend ?? null,
      sandboxRunId: input.sandboxRunId ?? null,
      sandboxContainerName: input.sandboxContainerName ?? null,
    });
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.filter((entry) => entry.id !== workspace.id);
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      return state;
    });
  }

  async function updateRemoteWorkspace(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    const { workspaceId: _workspaceId, ...patch } = input;
    return mutateWorkspaceState(async (state) => {
      const existing = state.workspaces.find((entry) => entry.id === workspaceId);
      if (!existing) return state;

      let nextWorkspace = { ...existing, ...patch };
      const nextRemoteType = nextWorkspace.remoteType === "opencode" ? "opencode" : "omnirush";
      if (nextRemoteType === "omnirush") {
        const rawHostUrl = typeof nextWorkspace.omnirushHostUrl === "string" && nextWorkspace.omnirushHostUrl.trim()
          ? nextWorkspace.omnirushHostUrl.trim()
          : null;
        const nextBaseUrl = String(nextWorkspace.baseUrl ?? "").trim();
        const hostUrl = stripOmniRushWorkspaceMount(rawHostUrl ?? nextBaseUrl);
        const directory = typeof nextWorkspace.directory === "string" && nextWorkspace.directory.trim()
          ? nextWorkspace.directory.trim()
          : null;
        const parsedWorkspaceId = parseOmniRushWorkspaceIdFromUrl(rawHostUrl) || parseOmniRushWorkspaceIdFromUrl(nextBaseUrl);
        let remoteWorkspaceId = parsedWorkspaceId || (
          typeof nextWorkspace.omnirushWorkspaceId === "string" && nextWorkspace.omnirushWorkspaceId.trim()
            ? nextWorkspace.omnirushWorkspaceId.trim()
            : null
        );
        let remoteWorkspaceName = nextWorkspace.omnirushWorkspaceName ?? null;
        if (!remoteWorkspaceId) {
          const discovered = await discoverOmniRushWorkspace({
            hostUrl: hostUrl ?? nextBaseUrl,
            token: nextWorkspace.omnirushToken,
            hostToken: nextWorkspace.omnirushHostToken,
            directory,
          });
          if (!discovered?.id) {
            throw new Error(
              directory
                ? `OmniRush.ai server has no workspace matching ${directory}.`
                : "OmniRush.ai server returned no workspaces.",
            );
          }
          remoteWorkspaceId = String(discovered.id).trim();
          remoteWorkspaceName = omnirushWorkspaceDisplayName(discovered);
        }
        const nextId = omnirushRemoteWorkspaceId(hostUrl ?? nextBaseUrl, remoteWorkspaceId);
        nextWorkspace = normalizeWorkspaceEntry({
          ...nextWorkspace,
          id: nextId,
          baseUrl: hostUrl ?? nextBaseUrl,
          omnirushHostUrl: hostUrl,
          directory,
          remoteType: "omnirush",
          omnirushWorkspaceId: remoteWorkspaceId,
          omnirushWorkspaceName: remoteWorkspaceName,
        });
        if (nextId !== workspaceId) {
          if (state.selectedId === workspaceId) state.selectedId = nextId;
          if (state.activeId === workspaceId) state.activeId = nextId;
          if (state.watchedId === workspaceId) state.watchedId = nextId;
        }
      }

      state.workspaces = state.workspaces.map((entry) =>
        entry.id === workspaceId ? nextWorkspace : entry,
      );
      return state;
    });
  }

  async function updateWorkspaceDisplayName(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.map((entry) =>
        entry.id === workspaceId ? { ...entry, displayName: input.displayName ?? null } : entry,
      );
      return state;
    });
  }

  async function forgetWorkspace(workspaceId) {
    if (!workspaceId) throw new Error("workspaceId is required");
    let workspacePath = "";
    const nextState = await mutateWorkspaceState((state) => {
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      if (workspace?.workspaceType !== "remote") workspacePath = String(workspace?.path ?? "");
      state.workspaces = state.workspaces.filter((entry) => entry.id !== workspaceId);
      if (state.selectedId === workspaceId) state.selectedId = "";
      if (state.activeId === workspaceId) state.activeId = null;
      if (state.watchedId === workspaceId) state.watchedId = null;
      return state;
    });
    await forgetWorkspaceToken(workspacePath);
    return nextState;
  }

  async function addAuthorizedRoot(input = {}) {
    const workspacePath = String(input.workspacePath ?? "").trim();
    const authorizedRoot = String(input.folderPath ?? input.authorizedRoot ?? "").trim();
    if (!workspacePath || !authorizedRoot) {
      throw new Error("workspacePath and folderPath are required");
    }
    const config = await readWorkspaceOmniRushConfig(workspacePath);
    if (!Array.isArray(config.authorizedRoots)) {
      config.authorizedRoots = [];
    }
    if (!config.authorizedRoots.includes(authorizedRoot)) {
      config.authorizedRoots.push(authorizedRoot);
    }
    return writeWorkspaceOmniRushConfig(workspacePath, config);
  }

  async function exportConfig(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    const outputPath = String(input.outputPath ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    if (!outputPath) throw new Error("outputPath is required");
    const state = await readWorkspaceState();
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("Unknown workspaceId");
    return exportWorkspaceConfig({ workspace, outputPath });
  }

  async function importConfig(input = {}) {
    const archivePath = String(input.archivePath ?? "").trim();
    const targetDirRaw = String(input.targetDir ?? "").trim();
    if (!archivePath) throw new Error("archivePath is required");
    if (!targetDirRaw) throw new Error("targetDir is required");
    const targetDir = await normalizeLocalWorkspacePath(targetDirRaw);
    const imported = await importWorkspaceConfig({
      archivePath,
      targetDir,
      name: input.name ?? null,
    });
    const workspace = normalizeWorkspaceEntry({
      id: localWorkspaceId(targetDir),
      name: imported.workspaceName,
      displayName: null,
      path: targetDir,
      preset: imported.preset,
      workspaceType: "local",
    });
    return mutateWorkspaceState((state) => {
      const key = workspacePathKey(workspace);
      state.workspaces = state.workspaces.filter(
        (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== key,
      );
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      state.watchedId = workspace.id;
      return state;
    });
  }

  async function resetOmniRushState() {
    await rm(workspaceStatePath(), { force: true });
    await clearDesktopBootstrapFiles();
    return undefined;
  }

  return {
    addAuthorizedRoot,
    bootstrapFirstLaunchWorkspace,
    createRemoteWorkspace,
    createWorkspace,
    clearDesktopBootstrapConfig,
    debugDesktopBootstrapConfig,
    defaultWorkspaceOmniRushConfig,
    exportConfig,
    forgetWorkspace,
    getDesktopBootstrapConfig,
    importConfig,
    listLocalWorkspacePaths,
    listRemoteWorkspaceUrlPrefixes,
    migrateLegacyElectronWorkspaceStateIfNeeded,
    readDesktopBootstrapConfigSync,
    readWorkspaceOmniRushConfig,
    readWorkspaceState,
    resetOmniRushState,
    setDesktopBootstrapConfig,
    setRuntimeActiveWorkspace,
    setSelectedWorkspace,
    updateRemoteWorkspace,
    updateWorkspaceDisplayName,
    writeWorkspaceOmniRushConfig,
    writeWorkspaceState,
  };
}
