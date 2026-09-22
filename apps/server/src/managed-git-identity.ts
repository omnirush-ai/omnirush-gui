/**
 * Commit identity defaults for managed workspaces.
 *
 * Git silently invents `user@host` when user.name / user.email are unset, or
 * refuses the commit outright. When the engine is about to record a commit in
 * a repository without an identity, the managed-policy plugin asks the server
 * (action "git_identity"). With an omnirush.ai account connected, the account's
 * display name and email are written to that repository only (`git config
 * --local`, never `--global`); otherwise the request fails with a message that
 * tells the agent exactly what to ask the user.
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./errors.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const PROFILE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;

export interface AccountIdentity {
  name: string;
  email: string;
}

export interface WorkspaceGitIdentity {
  repository: boolean;
  name: string | null;
  email: string | null;
}

export type EnsureGitIdentityResult =
  | { status: "not_a_repository" }
  | { status: "configured"; name: string; email: string }
  | { status: "applied"; name: string; email: string; source: "omnirush_account" };

export const GIT_IDENTITY_REQUIRED_MESSAGE =
  "Git identity is not configured for this repository (user.name and user.email are unset) and no omnirush.ai account is connected to supply one. "
  + "Ask the user which name and email to commit with, then set them for this repository only: "
  + 'git config user.name "<name>" && git config user.email "<email>" (never --global).';

export interface GitIdentityDependencies {
  runGit?: (args: string[]) => Promise<{ stdout: string; code: number }>;
  fetchImpl?: typeof externalFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

async function defaultRunGit(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("git", args, { timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    return { stdout: typeof failure.stdout === "string" ? failure.stdout : "", code: typeof failure.code === "number" ? failure.code : -1 };
  }
}

/** Mirror of the desktop account store's display-name fallback. */
export function displayNameFromEmail(email: string): string | null {
  const localPart = email.split("@", 1)[0] ?? "";
  const words = localPart
    .replace(/^i[._-]?am(?=[a-z])/i, "")
    .replace(/\d+$/, "")
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ");
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

export function accountIdentityFromProfile(profile: unknown): AccountIdentity | null {
  if (typeof profile !== "object" || profile === null) return null;
  const record = profile as Record<string, unknown>;
  const email = trimmed(record.email);
  if (!email) return null;
  const name = trimmed(record.displayName) ?? trimmed(record.display_name) ?? displayNameFromEmail(email) ?? email;
  return { name, email };
}

function controlPlaneProfileUrl(gatewayUrl: string): string | null {
  try {
    const url = new URL(gatewayUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) return null;
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/device/me";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const profileCache = new WeakMap<ServerConfig, { value: AccountIdentity | null; expires: number }>();

/**
 * The connected omnirush.ai account's name and email. The desktop app answers
 * through the credential bundle's `profile` callback; a standalone server with
 * environment credentials reads the control plane directly. Null when no
 * account is connected or the lookup fails.
 */
export async function resolveAccountIdentity(config: ServerConfig, deps: GitIdentityDependencies = {}): Promise<AccountIdentity | null> {
  const now = deps.now ?? Date.now;
  const cached = profileCache.get(config);
  if (cached && cached.expires > now()) return cached.value;
  const value = await lookupAccountIdentity(config, deps);
  profileCache.set(config, { value, expires: now() + (value ? PROFILE_TTL_MS : FAILURE_TTL_MS) });
  return value;
}

export function forgetAccountIdentity(config: ServerConfig): void {
  profileCache.delete(config);
}

async function lookupAccountIdentity(config: ServerConfig, deps: GitIdentityDependencies): Promise<AccountIdentity | null> {
  const credentials = config.omnirushGatewayCredentials;
  if (credentials?.profile) {
    try {
      return accountIdentityFromProfile(await credentials.profile());
    } catch {
      return null;
    }
  }
  const env = deps.env ?? process.env;
  const gatewayUrl = credentials?.gatewayUrl ?? env.OMNIRUSH_GATEWAY_URL?.trim();
  const accessToken = credentials?.accessToken ?? env.OMNIRUSH_ACCESS_TOKEN?.trim();
  if (!gatewayUrl || !accessToken) return null;
  const url = controlPlaneProfileUrl(gatewayUrl);
  if (!url) return null;
  try {
    const response = await (deps.fetchImpl ?? externalFetch)(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return accountIdentityFromProfile(await response.json());
  } catch {
    return null;
  }
}

export async function readWorkspaceGitIdentity(directory: string, deps: GitIdentityDependencies = {}): Promise<WorkspaceGitIdentity> {
  const runGit = deps.runGit ?? defaultRunGit;
  const inside = await runGit(["-C", directory, "rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { repository: false, name: null, email: null };
  const name = await runGit(["-C", directory, "config", "--get", "user.name"]);
  const email = await runGit(["-C", directory, "config", "--get", "user.email"]);
  return {
    repository: true,
    name: name.code === 0 ? trimmed(name.stdout) : null,
    email: email.code === 0 ? trimmed(email.stdout) : null,
  };
}

/**
 * Make sure commits in `directory` carry an identity. Throws
 * `git_identity_required` (HTTP 412) when neither the repository nor a
 * connected omnirush.ai account provides one.
 */
export async function ensureWorkspaceGitIdentity(
  config: ServerConfig,
  directory: string,
  deps: GitIdentityDependencies = {},
): Promise<EnsureGitIdentityResult> {
  if (!directory || !isAbsolute(directory)) throw new ApiError(400, "invalid_payload", "directory must be an absolute path");
  const env = deps.env ?? process.env;
  const runGit = deps.runGit ?? defaultRunGit;
  const current = await readWorkspaceGitIdentity(directory, deps);
  if (!current.repository) return { status: "not_a_repository" };
  const envName = trimmed(env.GIT_AUTHOR_NAME) && trimmed(env.GIT_COMMITTER_NAME);
  const envEmail = trimmed(env.GIT_AUTHOR_EMAIL) && trimmed(env.GIT_COMMITTER_EMAIL);
  const name = current.name ?? (envName ? trimmed(env.GIT_COMMITTER_NAME) : null);
  const email = current.email ?? (envEmail ? trimmed(env.GIT_COMMITTER_EMAIL) : null);
  if (name && email) return { status: "configured", name, email };
  const account = await resolveAccountIdentity(config, deps);
  if (!account) throw new ApiError(412, "git_identity_required", GIT_IDENTITY_REQUIRED_MESSAGE);
  if (!name) {
    const result = await runGit(["-C", directory, "config", "--local", "user.name", account.name]);
    if (result.code !== 0) throw new ApiError(500, "git_identity_write_failed", "Could not write user.name to the repository configuration.");
  }
  if (!email) {
    const result = await runGit(["-C", directory, "config", "--local", "user.email", account.email]);
    if (result.code !== 0) throw new ApiError(500, "git_identity_write_failed", "Could not write user.email to the repository configuration.");
  }
  return { status: "applied", name: name ?? account.name, email: email ?? account.email, source: "omnirush_account" };
}
