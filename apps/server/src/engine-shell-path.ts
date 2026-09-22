/**
 * PATH resolution for the engine's bash tool.
 *
 * The packaged desktop app cannot rely on the PATH it inherits from the
 * Finder or the login session, so apps/desktop/electron/runtime.mjs parses
 * the macOS login-shell PATH (path_helper) and adds the well-known tool
 * directories (/opt/homebrew/bin, version managers, user bins) before it
 * starts the server. This module applies the same resolution inside the
 * engine process, so `git` and `gh` are visible to the bash tool whether the
 * engine was spawned by the packaged app or by a dev server. Keep the entry
 * list identical to runtime.mjs (a test compares the two).
 *
 * Unlike runtime.mjs, entries are appended after the inherited PATH: the
 * packaged app already placed them first for the server, and a developer's
 * terminal PATH keeps its own precedence.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function nvmVersionBinPaths(home: string): string[] {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, "bin"))
      .filter(isDirectory)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** `PATH="..."; export PATH;` as printed by /usr/libexec/path_helper -s. */
export function parsePathHelperOutput(stdout: string): string[] {
  const match = stdout.match(/PATH="([^"]+)"/) ?? stdout.match(/PATH=([^;\n]+)/);
  return match?.[1]?.split(path.delimiter).filter(Boolean) ?? [];
}

export function pathHelperEntries(platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  const result = spawnSync("/usr/libexec/path_helper", ["-s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return [];
  return parsePathHelperOutput(String(result.stdout ?? ""));
}

export interface PathEntryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Login-shell entries; defaults to path_helper on macOS. */
  loginShellEntries?: string[];
}

/** Candidate directories in runtime.mjs order, before the existence filter. */
export function wellKnownPathEntries(options: PathEntryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const candidates: Array<string | null> = [];
  if (platform === "darwin") {
    candidates.push(
      ...(options.loginShellEntries ?? pathHelperEntries(platform)),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }
  if (platform === "linux") {
    candidates.push(
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }
  if (platform === "win32") {
    candidates.push(
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      env.APPDATA ? path.join(env.APPDATA, "npm") : null,
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "pnpm") : null,
    );
  }
  return candidates.filter((entry): entry is string => Boolean(entry));
}

export function extraPathEntries(options: PathEntryOptions = {}): string[] {
  return wellKnownPathEntries(options).filter(isDirectory);
}

/** The inherited PATH followed by every well-known directory it lacks. */
export function enrichedPath(currentPath: string | undefined, options: PathEntryOptions = {}): string | null {
  const entries = [
    ...String(currentPath ?? "").split(path.delimiter).filter(Boolean),
    ...extraPathEntries(options),
  ];
  const deduped = entries.filter((entry, index) => entries.indexOf(entry) === index);
  return deduped.length > 0 ? deduped.join(path.delimiter) : null;
}

export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.prototype.hasOwnProperty.call(env, "PATH") || !Object.prototype.hasOwnProperty.call(env, "Path") ? "PATH" : "Path";
}

/** Apply the enriched PATH to an environment (the engine process by default). */
export function applyEnginePath(env: NodeJS.ProcessEnv = process.env, options: PathEntryOptions = {}): string | null {
  const key = pathKey(env);
  const next = enrichedPath(env[key], options);
  if (next) env[key] = next;
  return next;
}
