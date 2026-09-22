import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApiError } from "./errors.js";
import {
  accountIdentityFromProfile,
  displayNameFromEmail,
  ensureWorkspaceGitIdentity,
  forgetAccountIdentity,
  readWorkspaceGitIdentity,
  resolveAccountIdentity,
} from "./managed-git-identity.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, token: "owt_client", hostToken: "owt_host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli",
    hostTokenSource: "cli", logFormat: "pretty", logRequests: false, ...overrides,
  };
}

/** Fake git: a repository with the given identity, recording config writes. */
function fakeGit(identity: { name?: string; email?: string }, repository = true) {
  const writes: string[][] = [];
  const state = { ...identity };
  const runGit = async (args: string[]) => {
    if (args[2] === "rev-parse") return { stdout: repository ? "true\n" : "", code: repository ? 0 : 128 };
    if (args[2] === "config" && args[3] === "--get") {
      const value = args[4] === "user.name" ? state.name : state.email;
      return value ? { stdout: `${value}\n`, code: 0 } : { stdout: "", code: 1 };
    }
    if (args[2] === "config" && args[3] === "--local") {
      writes.push(args.slice(3));
      if (args[4] === "user.name") state.name = args[5];
      if (args[4] === "user.email") state.email = args[5];
      return { stdout: "", code: 0 };
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { runGit, writes };
}

describe("workspace git identity", () => {
  test("applies the connected account's name and email to the repository only", async () => {
    const git = fakeGit({});
    const profile = async () => ({ email: "sam@example.com", displayName: "Sam Example" });
    const cfg = config({ omnirushGatewayCredentials: { gatewayUrl: "https://gw.example/v1", accessToken: "a", refreshToken: "r", profile } });
    const result = await ensureWorkspaceGitIdentity(cfg, "/repo", { runGit: git.runGit, env: {} });
    expect(result).toEqual({ status: "applied", name: "Sam Example", email: "sam@example.com", source: "omnirush_account" });
    expect(git.writes).toEqual([["--local", "user.name", "Sam Example"], ["--local", "user.email", "sam@example.com"]]);
    expect(git.writes.every((write) => !write.includes("--global"))).toBe(true);
  });

  test("fills only the missing half and keeps an existing identity", async () => {
    const partial = fakeGit({ name: "Repo Owner" });
    const profile = async () => ({ email: "sam@example.com", displayName: "Sam Example" });
    const cfg = config({ omnirushGatewayCredentials: { gatewayUrl: "https://gw.example/v1", accessToken: "a", refreshToken: "r", profile } });
    expect(await ensureWorkspaceGitIdentity(cfg, "/repo", { runGit: partial.runGit, env: {} }))
      .toEqual({ status: "applied", name: "Repo Owner", email: "sam@example.com", source: "omnirush_account" });
    expect(partial.writes).toEqual([["--local", "user.email", "sam@example.com"]]);

    const complete = fakeGit({ name: "Repo Owner", email: "owner@example.com" });
    expect(await ensureWorkspaceGitIdentity(config(), "/repo", { runGit: complete.runGit, env: {} }))
      .toEqual({ status: "configured", name: "Repo Owner", email: "owner@example.com" });
    expect(complete.writes).toEqual([]);
  });

  test("refuses clearly when no account is connected, and ignores directories that are not repositories", async () => {
    const git = fakeGit({});
    const attempt = ensureWorkspaceGitIdentity(config(), "/repo", { runGit: git.runGit, env: {} });
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({ status: 412, code: "git_identity_required" });
    await expect(attempt).rejects.toThrow(/never --global/);
    expect(git.writes).toEqual([]);
    expect(await ensureWorkspaceGitIdentity(config(), "/elsewhere", { runGit: fakeGit({}, false).runGit, env: {} })).toEqual({ status: "not_a_repository" });
    await expect(ensureWorkspaceGitIdentity(config(), "relative/path", { runGit: git.runGit })).rejects.toMatchObject({ status: 400 });
  });

  test("honours an identity supplied through the environment", async () => {
    const git = fakeGit({});
    const env = { GIT_AUTHOR_NAME: "Env Name", GIT_AUTHOR_EMAIL: "env@example.com", GIT_COMMITTER_NAME: "Env Name", GIT_COMMITTER_EMAIL: "env@example.com" };
    expect(await ensureWorkspaceGitIdentity(config(), "/repo", { runGit: git.runGit, env })).toEqual({ status: "configured", name: "Env Name", email: "env@example.com" });
  });

  test("a standalone server reads the control plane profile with environment credentials and caches it", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ email: "iamsam.jones42@example.com", status: "active" });
    };
    const cfg = config();
    const env = { OMNIRUSH_GATEWAY_URL: "https://gateway.example/omnirush/v1", OMNIRUSH_ACCESS_TOKEN: "env-access" };
    expect(await resolveAccountIdentity(cfg, { fetchImpl, env })).toEqual({ name: "Sam Jones", email: "iamsam.jones42@example.com" });
    expect(await resolveAccountIdentity(cfg, { fetchImpl, env })).toEqual({ name: "Sam Jones", email: "iamsam.jones42@example.com" });
    expect(requests).toEqual([{ url: "https://gateway.example/omnirush/device/me", authorization: "Bearer env-access" }]);
    forgetAccountIdentity(cfg);
    expect(await resolveAccountIdentity(config(), { fetchImpl, env: {} })).toBeNull();
  });

  test("profile parsing mirrors the desktop account store", () => {
    expect(displayNameFromEmail("iamsam.jones42@example.com")).toBe("Sam Jones");
    expect(displayNameFromEmail("sam_jones@example.com")).toBe("Sam Jones");
    expect(accountIdentityFromProfile({ email: " a@b.c ", display_name: "A B" })).toEqual({ name: "A B", email: "a@b.c" });
    expect(accountIdentityFromProfile({ email: "a@b.c" })).toEqual({ name: "A", email: "a@b.c" });
    expect(accountIdentityFromProfile({ displayName: "No Email" })).toBeNull();
    expect(accountIdentityFromProfile(null)).toBeNull();
  });

  test("reads a real repository without touching the global configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omnirush-git-identity-"));
    roots.push(root);
    await writeFile(path.join(root, "gitconfig"), "", "utf8");
    const repo = path.join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const previous = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      expect(await readWorkspaceGitIdentity(repo)).toEqual({ repository: true, name: null, email: null });
      expect(await readWorkspaceGitIdentity(root)).toEqual({ repository: false, name: null, email: null });
      const profile = async () => ({ email: "sam@example.com", displayName: "Sam Example" });
      const cfg = config({ omnirushGatewayCredentials: { gatewayUrl: "https://gw.example/v1", accessToken: "a", refreshToken: "r", profile } });
      // The plugin reaches this through the policy service's "git_identity" action.
      await managedDesktopPolicy(cfg).assert("git_identity", { directory: repo });
      expect(await readWorkspaceGitIdentity(repo)).toEqual({ repository: true, name: "Sam Example", email: "sam@example.com" });
      expect(execFileSync("cat", [path.join(root, "gitconfig")], { encoding: "utf8" })).toBe("");
    } finally {
      if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous.global;
      if (previous.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = previous.nosystem;
    }
  });
});
