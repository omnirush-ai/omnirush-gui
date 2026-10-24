// Install log (reproducible environments, phase 1): what the agent's own shell
// installed or fetched in each turn, at the exact version, so a turn's
// environment can be rebuilt with pinned installs.
//
//   wrappers   prepareInstallLog() writes the package-manager wrappers once
//              (install-log-assets.ts: a POSIX sh script linked as npm, uv,
//              cargo, apt-get, curl ...; on Windows a small exe copied as
//              npm.exe ...; plus a pip hook loaded through PYTHONPATH).
//              installLogEnv() puts their folder first on PATH in the
//              engine's environment only (the shells it starts for tool
//              calls), never the user's terminal or the system PATH. A
//              wrapper runs the real tool with the same arguments, streams
//              and exit code; for an install it notes the call in a folder
//              under the instance's raw folder (no tool is run then: copies
//              and listings only).
//   records    InstallLog reads those folders after the call, outside it:
//              it matches each to the session and shell call that ran it (by
//              time and folder), resolves the exact versions (pip's own
//              report, the hidden lockfile before and after, the package
//              folders), strips credentials from every argument and URL, and
//              hands one `context.install` line per call to the trace.
//   per turn   `context.env_turn`: OS, arch, runtime versions and version
//              managers (re-probed only when a cheap key changed) and the
//              files written outside the project during the turn (path,
//              size, sha256; never content).
//
// The server decides: GET /collect/capabilities `install_log: {enabled,
// sample_percent}`. Off (or an older server that does not say), nothing is
// noted and nothing is sent; the wrappers then only run the tool. Locally,
// OMNIRUSH_INSTALL_LOG=0 keeps the wrappers off PATH altogether.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { quietEnv, runCommand, type Runner } from "./exec.js";
import { POSIX_WRAPPER, PYTHON_HOOK, WINDOWS_WRAPPER_BASE64, WINDOWS_WRAPPER_SHA256 } from "./install-log-assets.js";
import { cleanUrl, isSecretFile, isSecretFolder, isSecretKey, tildeText, type PrivacyContext, type Scrubber } from "./privacy.js";
import { redactCredentials, redactionRaw } from "./redact-policy.js";

export const INSTALL_LOG_SCHEMA = "omnirush.install-log.v1";
export const ENV_TURN_SCHEMA = "omnirush.env-turn.v1";

/** The tools wrapped on Linux, macOS and WSL (pip itself is also seen by the hook, however it is started). */
export const POSIX_TOOLS = [
  "npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "corepack",
  "pip", "pip3", "uv", "pipx", "poetry", "pipenv", "conda", "mamba", "micromamba",
  "cargo", "rustup", "go", "gem", "bundle", "bundler", "composer",
  "apt", "apt-get", "aptitude", "dnf", "yum", "microdnf", "apk", "pacman", "brew",
  "curl", "wget",
] as const;

/** The tools wrapped on Windows (PowerShell, cmd and Git Bash all find `<tool>.exe`). */
export const WINDOWS_TOOLS = [
  "npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "corepack",
  "pip", "pip3", "uv", "pipx", "poetry", "pipenv", "conda", "mamba",
  "cargo", "rustup", "go", "gem", "bundle", "composer",
  "winget", "choco", "scoop", "curl", "wget",
] as const;

const MAX_ARGS = 128;
const MAX_ARG_BYTES = 2048;
const MAX_PACKAGES = 5000;
const MAX_DOWNLOAD_HASH_BYTES = 512 * 1024 * 1024;
/** A call still without its exit code after this long is reported as it is (killed, or still running in the background). */
const STALE_CALL_MS = 10 * 60_000;
/** Raw folders of instances that have ended are removed after this long. */
const STALE_INSTANCE_MS = 2 * 24 * 3600_000;
/** How much later than a shell call's end its wrapper may still be finishing its notes. */
const MATCH_SLACK_MS = 3_000;

// --- switches ------------------------------------------------------------------

/** OMNIRUSH_INSTALL_LOG=0 (or false/off/no) keeps the wrappers off the engine's PATH. On by default. */
export function installLogLocallyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|false|off|no)$/i.test((env.OMNIRUSH_INSTALL_LOG ?? "").trim());
}

export type InstallLogGate = { enabled: boolean; samplePercent: number };
export const INSTALL_LOG_OFF: InstallLogGate = { enabled: false, samplePercent: 0 };

/** The server's switch from a GET /collect/capabilities answer; a missing key is off. */
export function installLogGate(capabilities: unknown): InstallLogGate {
  if (!capabilities || typeof capabilities !== "object") return INSTALL_LOG_OFF;
  const record = capabilities as Record<string, unknown>;
  const block = record.install_log;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const value = block as Record<string, unknown>;
    if (value.enabled !== true) return INSTALL_LOG_OFF;
    const percent = typeof value.sample_percent === "number" && Number.isFinite(value.sample_percent) ? Math.max(0, Math.min(100, Math.floor(value.sample_percent))) : 100;
    return { enabled: percent > 0, samplePercent: percent };
  }
  if (block === true) return { enabled: true, samplePercent: 100 };
  return INSTALL_LOG_OFF;
}

/** Whether a session is in the server's sample (a stable hash of its id). */
export function inInstallLogSample(sessionId: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return createHash("sha256").update(sessionId).digest().readUInt32BE(0) % 100 < percent;
}

// --- wrappers on disk ---------------------------------------------------------------

export type InstallLogPaths = {
  /** The wrapper folder (first on the engine's PATH). */
  bin: string;
  /** The folder holding the pip hook (first on the engine's PYTHONPATH). */
  py: string;
  /** This instance's raw folder: the wrappers note calls here; `on` in it switches noting on. */
  raw: string;
};

function digestOf(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 12);
}

async function isComplete(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".complete"));
    return true;
  } catch {
    return false;
  }
}

/** Writes `dir` through a temporary folder renamed into place (several processes may race; the first one wins). */
async function materialize(dir: string, write: (tmp: string) => Promise<void>): Promise<void> {
  if (await isComplete(dir)) return;
  const tmp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.mkdir(tmp, { recursive: true });
  try {
    await write(tmp);
    await fs.writeFile(path.join(tmp, ".complete"), "");
    try {
      await fs.rename(tmp, dir);
    } catch {
      if (!(await isComplete(dir))) {
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmp, dir);
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writePosixWrappers(dir: string): Promise<void> {
  const main = path.join(dir, "omnirush-pkg");
  await fs.writeFile(main, POSIX_WRAPPER, { mode: 0o755 });
  await fs.chmod(main, 0o755);
  for (const tool of POSIX_TOOLS) {
    const target = path.join(dir, tool);
    try {
      await fs.symlink("omnirush-pkg", target);
    } catch {
      await fs.copyFile(main, target);
      await fs.chmod(target, 0o755);
    }
  }
}

async function writeWindowsWrappers(dir: string): Promise<void> {
  const exe = Buffer.from(WINDOWS_WRAPPER_BASE64, "base64");
  if (createHash("sha256").update(exe).digest("hex") !== WINDOWS_WRAPPER_SHA256) throw new Error("install log: the Windows wrapper does not match its digest");
  const main = path.join(dir, "omnirush-pkg.exe");
  await fs.writeFile(main, exe);
  // The marker tells every wrapper (of any version) that this folder holds wrappers, never the real tool.
  await fs.writeFile(path.join(dir, "omnirush-pkg.marker"), "");
  for (const tool of WINDOWS_TOOLS) {
    const target = path.join(dir, `${tool}.exe`);
    try {
      await fs.link(main, target);
    } catch {
      await fs.copyFile(main, target);
    }
  }
}

/** Removes raw folders of instances that ended long ago (their process is gone). */
async function sweepRaw(rawRoot: string, keep: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(rawRoot);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(rawRoot, name);
    if (full === keep) continue;
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > STALE_INSTANCE_MS) await fs.rm(full, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
}

/**
 * Writes the wrappers and the pip hook under `<stateDir>/pkglog/` (once per
 * version) and makes this instance's raw folder. Null when the platform has
 * no wrappers or anything fails: the engine then starts without them.
 */
export async function prepareInstallLog(options: { stateDir: string; platform?: NodeJS.Platform }): Promise<InstallLogPaths | null> {
  const platform = options.platform ?? process.platform;
  try {
    const root = path.join(options.stateDir, "pkglog");
    const windows = platform === "win32";
    const bin = path.join(root, `bin-${digestOf(windows ? WINDOWS_WRAPPER_SHA256 : POSIX_WRAPPER, (windows ? WINDOWS_TOOLS : POSIX_TOOLS).join(","))}`);
    const py = path.join(root, `py-${digestOf(PYTHON_HOOK)}`);
    await fs.mkdir(root, { recursive: true });
    await materialize(bin, windows ? writeWindowsWrappers : writePosixWrappers);
    await materialize(py, (tmp) => fs.writeFile(path.join(tmp, "sitecustomize.py"), PYTHON_HOOK));
    const rawRoot = path.join(root, "raw");
    const raw = path.join(rawRoot, `${process.pid}-${randomBytes(4).toString("hex")}`);
    await fs.mkdir(raw, { recursive: true });
    void sweepRaw(rawRoot, raw);
    return { bin, py, raw };
  } catch {
    return null;
  }
}

/** The name an environment uses for `name` (Windows keys are case-insensitive: `Path`). */
export function envKey(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return name;
  return Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name;
}

/**
 * The variables the engine's environment gets: the wrapper folder first on
 * PATH, the hook first on PYTHONPATH, and the raw folder. Keys keep the
 * spelling `base` uses (Windows `Path`), so a child never gets two PATHs.
 */
export function installLogEnv(paths: InstallLogPaths, base: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const sep = platform === "win32" ? ";" : ":";
  const pathKey = envKey(base, "PATH", platform);
  const pyKey = envKey(base, "PYTHONPATH", platform);
  const current = base[pathKey] ?? "";
  const pythonPath = base[pyKey] ?? "";
  const without = (value: string, entry: string) => value.split(sep).filter((item) => item && item !== entry).join(sep);
  const restPath = without(current, paths.bin);
  const restPy = without(pythonPath, paths.py);
  return {
    [pathKey]: restPath ? `${paths.bin}${sep}${restPath}` : paths.bin,
    [pyKey]: restPy ? `${paths.py}${sep}${restPy}` : paths.py,
    OMNIRUSH_PKGLOG_DIR: paths.raw,
  };
}

/** Switches noting on or off for every wrapper of the instance (the `on` file; nothing restarts). */
export async function setInstallLogActive(raw: string, on: boolean): Promise<void> {
  const marker = path.join(raw, "on");
  try {
    if (on) await fs.writeFile(marker, "");
    else await fs.rm(marker, { force: true });
  } catch {
    /* best effort */
  }
}

// --- reading a noted call ---------------------------------------------------------

/** A Windows command-line tail split as the C runtime does (CommandLineToArgvW rules). */
export function splitWindowsArgs(tail: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tail.length) {
    while (tail[i] === " " || tail[i] === "\t") i++;
    if (i >= tail.length) break;
    let word = "";
    let quoted = false;
    while (i < tail.length) {
      const ch = tail[i]!;
      if (!quoted && (ch === " " || ch === "\t")) break;
      if (ch === "\\") {
        let j = i;
        while (tail[j] === "\\") j++;
        const slashes = j - i;
        if (tail[j] === '"') {
          word += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2) {
            word += '"';
            i = j + 1;
          } else i = j;
        } else {
          word += "\\".repeat(slashes);
          i = j;
        }
        continue;
      }
      if (ch === '"') {
        if (quoted && tail[i + 1] === '"') {
          word += '"';
          i += 2;
          continue;
        }
        quoted = !quoted;
        i++;
        continue;
      }
      word += ch;
      i++;
    }
    out.push(word);
  }
  return out;
}

function parseMeta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function readText(file: string, max = 64 * 1024 * 1024): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > max) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function sha256File(file: string, max = MAX_DOWNLOAD_HASH_BYTES): Promise<{ sha256: string; size: number } | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    if (stat.size > max) return { sha256: "", size: stat.size };
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve()).on("error", reject);
    });
    return { sha256: hash.digest("hex"), size: stat.size };
  } catch {
    return null;
  }
}

/** One call as its wrapper (or the pip hook) noted it. */
export type RawCall = {
  dir: string;
  meta: Record<string, string>;
  /** The pip hook's notes inside the call (pip run by the wrapped tool, or the call itself). */
  hooks: Array<{ meta: Record<string, string>; argv: string[]; report: unknown; removed: string[] }>;
  argv: string[];
  exit: number | null;
  start: number;
  end: number | null;
  complete: boolean;
};

async function readArgv(dir: string, name: string): Promise<string[] | null> {
  try {
    const buffer = await fs.readFile(path.join(dir, name));
    const text = buffer.toString("utf8");
    return text.split("\0").filter((_, index, all) => index < all.length - 1 || all[index] !== "");
  } catch {
    return null;
  }
}

async function readRc(file: string): Promise<{ exit: number | null; at: number | null } | null> {
  const text = await readText(file, 4096);
  if (text === null) return null;
  const [code, at] = text.split(/\r?\n/);
  const exit = code !== undefined && /^-?\d+$/.test(code.trim()) ? Number(code.trim()) : null;
  const when = at !== undefined && /^\d+$/.test(at.trim()) ? Number(at.trim()) : await mtimeMs(file);
  // A Windows exit code is unsigned (0xC000013A after Ctrl+C): keep it as the signed 32-bit value tools print.
  return { exit: exit !== null && exit > 0x7fffffff ? exit - 0x100000000 : exit, at: when };
}

/** Reads one noted call folder (null when it is not one, or not readable yet). */
export async function readRawCall(dir: string, now = Date.now()): Promise<RawCall | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const hooks: RawCall["hooks"] = [];
  for (const name of names.filter((item) => item === "hook" || item.startsWith("hook."))) {
    const tag = name === "hook" ? "" : name.slice(4);
    const metaText = await readText(path.join(dir, name), 64 * 1024);
    if (metaText === null) continue;
    const meta = parseMeta(metaText);
    const report = meta.report ? await readJson(path.join(dir, meta.report)) : null;
    const removedText = await readText(path.join(dir, `removed${tag}`), 1024 * 1024);
    const rc = await readRc(path.join(dir, `rc${tag}`));
    if (rc) meta.exit = rc.exit === null ? "" : String(rc.exit);
    if (rc?.at) meta.t1 = String(rc.at);
    hooks.push({ meta, argv: (await readArgv(dir, `argv${tag}`)) ?? [], report, removed: removedText ? removedText.split(/\r?\n/).filter(Boolean) : [] });
  }
  const metaText = await readText(path.join(dir, "meta"), 64 * 1024);
  let meta: Record<string, string>;
  let argv: string[];
  let rc: { exit: number | null; at: number | null } | null;
  let start: number | null;
  if (metaText !== null) {
    meta = parseMeta(metaText);
    const win = await readText(path.join(dir, "argv.win"), 1024 * 1024);
    argv = win !== null ? splitWindowsArgs(win) : (await readArgv(dir, "argv")) ?? [];
    rc = await readRc(path.join(dir, "rc"));
    start = meta.t0 && /^\d+$/.test(meta.t0) ? Number(meta.t0) : await mtimeMs(path.join(dir, "meta"));
  } else if (hooks.length > 0 && !hooks[0]!.meta.via?.startsWith("shim")) {
    // A pip the hook noted on its own (python -m pip, a venv's pip after `activate`).
    const hook = hooks[0]!;
    meta = { ...hook.meta, kind: "pip" };
    argv = hook.argv;
    rc = hook.meta.exit !== undefined ? { exit: hook.meta.exit === "" ? null : Number(hook.meta.exit), at: hook.meta.t1 ? Number(hook.meta.t1) : null } : null;
    start = hook.meta.t0 && /^\d+$/.test(hook.meta.t0) ? Number(hook.meta.t0) : await mtimeMs(path.join(dir, "hook"));
  } else {
    return null;
  }
  if (start === null) return null;
  const complete = rc !== null;
  if (!complete && now - start < STALE_CALL_MS) return { dir, meta, hooks, argv, exit: null, start, end: null, complete: false };
  return { dir, meta, hooks, argv, exit: rc?.exit ?? null, start, end: rc?.at ?? null, complete };
}

// --- what a call did ------------------------------------------------------------------

export type Ecosystem =
  | "pypi" | "npm" | "cargo" | "go" | "gem" | "composer" | "apt" | "rpm" | "apk" | "pacman" | "brew"
  | "winget" | "choco" | "scoop" | "conda" | "rustup" | "corepack" | "browsers" | "url" | "runtime" | "psgallery";
export type Scope = "project" | "global" | "user" | "target" | "system";

export type Package = { name: string; version: string; source?: string; sha256?: string; integrity?: string; path?: string };
export type Download = { url: string; path: string; path_rel?: string | null; sha256?: string; size?: number };

/** One `context.install` line (the ledger's v1 line, see the converter's ledger.py). */
export type InstallLine = {
  v: 1;
  schema: typeof INSTALL_LOG_SCHEMA;
  ts: string;
  end: string | null;
  dur_ms: number | null;
  turn: number | null;
  call: string | null;
  tool: string;
  via: "shim" | "python-hook" | "command";
  real: string | null;
  argv: string[];
  cwd: string;
  cwd_rel: string | null;
  exit: number | null;
  os: "linux" | "darwin" | "windows";
  scope: Scope;
  ecosystem: Ecosystem;
  target: string | null;
  target_rel: string | null;
  python: string | null;
  requested: string[];
  resolved: Package[];
  removed: Array<{ name: string; version?: string }>;
  downloads: Download[];
  lockfile: string | null;
  lockfile_rel: string | null;
  lockfile_sha256: string | null;
  truncated?: boolean;
};

/** Flags whose value is the next word, per tool family (so values never count as package names). */
const VALUE_FLAGS: Record<string, Set<string>> = {
  npm: new Set(["--prefix", "-C", "--cwd", "--dir", "--registry", "--cache", "--userconfig", "--tag", "-w", "--workspace", "--filter", "-F", "--save-prefix", "--omit", "--include", "--install-strategy", "--loglevel", "--network-concurrency", "--modules-folder", "--global-folder", "--cwd", "--config"]),
  pip: new Set(["-r", "--requirement", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "-t", "--target", "--prefix", "--root", "--platform", "--python-version", "--implementation", "--abi", "--src", "--upgrade-strategy", "--report", "--log", "--cache-dir", "--trusted-host", "--progress-bar", "--python", "-p", "--group", "--extra", "--index", "--default-index", "--project", "--directory", "--with", "--from", "--source", "--suffix", "--pip-args", "--spec", "--include-deps"]),
  cargo: new Set(["--version", "--vers", "--git", "--branch", "--tag", "--rev", "--path", "--root", "--features", "-F", "--bin", "--example", "--registry", "--index", "--target", "--profile", "-j", "--jobs", "--manifest-path", "--package", "-p", "--rename"]),
  go: new Set(["-tags", "-ldflags", "-gcflags", "-mod", "-modfile", "-o", "-C", "-pgo", "-overlay", "-p"]),
  gem: new Set(["-v", "--version", "-s", "--source", "-i", "--install-dir", "-n", "--bindir", "--platform", "-g", "--file", "--gemfile", "--path", "--group", "--without", "--with", "-j", "--jobs"]),
  composer: new Set(["--working-dir", "-d"]),
  apt: new Set(["-o", "--option", "-t", "--target-release", "-c", "--config-file"]),
  brew: new Set(["--formula-version"]),
  winget: new Set(["--id", "-q", "--query", "--name", "--moniker", "-v", "--version", "-s", "--source", "--scope", "-a", "--architecture", "-l", "--location", "--locale", "--log", "-o", "--override", "--custom", "--header", "--authentication-mode", "--installer-type"]),
  choco: new Set(["--version", "-s", "--source", "--params", "--package-parameters", "--install-arguments", "--ia", "-u", "--user", "-p", "--password"]),
  conda: new Set(["-n", "--name", "-p", "--prefix", "-c", "--channel", "--file"]),
  rustup: new Set(["--profile", "--target", "-t", "--component", "-c", "--toolchain"]),
  url: new Set(["-o", "--output", "-O", "--output-document", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "-u", "--user", "-x", "--proxy", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-X", "--request", "-T", "--upload-file", "-F", "--form", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "-P", "--directory-prefix", "--retry", "--resolve", "--cacert", "--cert", "--key", "-K", "--config"]),
};

function familyOf(tool: string): string {
  if (["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "corepack"].includes(tool)) return "npm";
  if (/^pip/.test(tool) || ["uv", "pipx", "poetry", "pipenv", "python", "python3", "py"].includes(tool)) return "pip";
  if (["conda", "mamba", "micromamba"].includes(tool)) return "conda";
  if (["apt", "apt-get", "aptitude", "dnf", "yum", "microdnf", "apk", "pacman"].includes(tool)) return "apt";
  if (["gem", "bundle", "bundler"].includes(tool)) return "gem";
  if (["curl", "wget"].includes(tool)) return "url";
  return tool;
}

/** Positional words (flags and their values left out). */
export function positionals(tool: string, argv: string[]): string[] {
  const flags = VALUE_FLAGS[familyOf(tool)] ?? new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--") {
      out.push(...argv.slice(i + 1));
      break;
    }
    if (word.startsWith("-")) {
      if (!word.includes("=") && flags.has(word)) i++;
      continue;
    }
    if (/^\d*[<>]|^&>|^[<>|&;]$/.test(word)) continue; // a shell redirect that reached the tool's words (never a package)
    out.push(word);
  }
  return out;
}

function hasFlag(argv: string[], ...names: string[]): boolean {
  return argv.some((word) => names.includes(word) || names.some((name) => name.startsWith("--") && word.startsWith(`${name}=`)));
}

function flagValue(argv: string[], ...names: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    for (const name of names) {
      if (word === name && i + 1 < argv.length) return argv[i + 1]!;
      if (name.startsWith("--") && word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    }
  }
  return null;
}

export type Classified = { ecosystem: Ecosystem; scope: Scope; sub: string; requested: string[] };

/** What kind of install a call is (null: not an install). The wrappers' own check is a looser superset of this one. */
export function classifyCall(tool: string, argv: string[]): Classified | null {
  tool = tool.toLowerCase().replace(/\.exe$/, "");
  const words = positionals(tool, argv);
  const [s1 = "", s2 = ""] = words;
  const after = (n: number) => words.slice(n);
  const npmLike = (pm: string, list: string[], offset: number): Classified | null => {
    const sub = list[offset] ?? "";
    const verbs: Record<string, string[]> = {
      npm: ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "install-clean", "ic", "uninstall", "un", "unlink", "remove", "rm", "r", "update", "up", "upgrade", "udpate", "link", "ln"],
      pnpm: ["add", "install", "i", "remove", "rm", "un", "uninstall", "update", "up", "upgrade"],
      yarn: ["", "install", "add", "remove", "upgrade", "up", "global"],
      bun: ["add", "a", "install", "i", "remove", "rm", "update", "link"],
    };
    if (!(verbs[pm] ?? []).includes(sub)) return null;
    const global = hasFlag(argv, "-g", "--global", "--location=global") || (pm === "yarn" && sub === "global");
    const requested = list.slice(offset + (pm === "yarn" && sub === "global" ? 2 : 1));
    return { ecosystem: "npm", scope: global ? "global" : "project", sub, requested };
  };
  switch (tool) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return npmLike(tool, words, 0);
    case "corepack":
      if (["npm", "pnpm", "yarn"].includes(s1)) return npmLike(s1, words, 1);
      if (["enable", "prepare", "install", "use", "up"].includes(s1)) return { ecosystem: "corepack", scope: "global", sub: s1, requested: after(1) };
      return null;
    case "npx":
    case "pnpx":
    case "bunx": {
      const at = words.findIndex((word) => /^(?:@playwright\/test|playwright(?:-core)?)(?:@.*)?$/.test(word));
      if (at >= 0 && words[at + 1] === "install") return { ecosystem: "browsers", scope: "global", sub: "install", requested: words.slice(at + 2).length ? words.slice(at + 2) : ["(default browsers)"] };
      return null;
    }
    case "pip":
    case "python":
    case "python3":
    case "py":
      if (s1 === "install" || s1 === "uninstall") {
        const scope: Scope = hasFlag(argv, "--user") ? "user" : hasFlag(argv, "--target", "-t", "--prefix", "--root") ? "target" : "project";
        const requested = after(1);
        const reqFiles = [flagValue(argv, "-r", "--requirement")].filter((item): item is string => Boolean(item)).map((file) => `-r ${file}`);
        return { ecosystem: "pypi", scope, sub: s1, requested: [...requested, ...reqFiles] };
      }
      return null;
    case "uv":
      if (s1 === "pip" && ["install", "uninstall", "sync"].includes(s2)) return { ecosystem: "pypi", scope: hasFlag(argv, "--system") ? "global" : "project", sub: `pip ${s2}`, requested: after(2) };
      if (["add", "remove", "sync", "lock"].includes(s1)) return { ecosystem: "pypi", scope: "project", sub: s1, requested: after(1) };
      if (s1 === "tool" && ["install", "uninstall", "upgrade"].includes(s2)) return { ecosystem: "pypi", scope: "global", sub: `tool ${s2}`, requested: after(2) };
      if (s1 === "python" && s2 === "install") return { ecosystem: "runtime", scope: "global", sub: "python install", requested: after(2).map((v) => `python@${v}`) };
      return null;
    case "pipx":
      if (["install", "uninstall", "inject", "upgrade", "reinstall"].includes(s1)) return { ecosystem: "pypi", scope: "global", sub: s1, requested: after(1) };
      return null;
    case "poetry":
      if (["add", "install", "remove", "update", "sync", "lock"].includes(s1)) return { ecosystem: "pypi", scope: "project", sub: s1, requested: after(1) };
      return null;
    case "pipenv":
      if (["install", "uninstall", "sync", "update", "lock"].includes(s1)) return { ecosystem: "pypi", scope: "project", sub: s1, requested: after(1) };
      return null;
    case "conda":
    case "mamba":
    case "micromamba":
      if (["install", "create", "remove", "uninstall", "update", "upgrade"].includes(s1)) return { ecosystem: "conda", scope: "global", sub: s1, requested: after(1) };
      return null;
    case "cargo":
      if (["install", "uninstall", "binstall"].includes(s1)) {
        const version = flagValue(argv, "--version", "--vers");
        const names = after(1).map((name) => (version && !name.includes("@") ? `${name}@${version}` : name));
        return { ecosystem: "cargo", scope: "global", sub: s1, requested: names };
      }
      if (["add", "remove", "fetch", "update"].includes(s1)) return { ecosystem: "cargo", scope: "project", sub: s1, requested: after(1) };
      return null;
    case "rustup":
      if (["install", "default", "toolchain", "target", "component", "update"].includes(s1)) return { ecosystem: "rustup", scope: "global", sub: s1, requested: s1 === "toolchain" || s1 === "target" || s1 === "component" ? after(2) : after(1) };
      return null;
    case "go":
      if (s1 === "install") return { ecosystem: "go", scope: "global", sub: s1, requested: after(1) };
      if (s1 === "get") return { ecosystem: "go", scope: "project", sub: s1, requested: after(1) };
      if (s1 === "mod" && ["download", "tidy", "vendor"].includes(s2)) return { ecosystem: "go", scope: "project", sub: `mod ${s2}`, requested: after(2) };
      return null;
    case "gem":
      if (["install", "i", "uninstall", "update"].includes(s1)) {
        const version = flagValue(argv, "-v", "--version");
        return { ecosystem: "gem", scope: hasFlag(argv, "--user-install") ? "user" : "global", sub: s1, requested: after(1).map((name) => (version ? `${name}@${version}` : name)) };
      }
      return null;
    case "bundle":
    case "bundler":
      if (["", "install", "add", "update"].includes(s1)) return { ecosystem: "gem", scope: "project", sub: s1 || "install", requested: after(1) };
      return null;
    case "composer":
      if (s1 === "global" && ["require", "install", "update", "remove"].includes(s2)) return { ecosystem: "composer", scope: "global", sub: s2, requested: after(2) };
      if (["require", "install", "update", "remove"].includes(s1)) return { ecosystem: "composer", scope: "project", sub: s1, requested: after(1) };
      return null;
    case "apt":
    case "apt-get":
    case "aptitude":
      if (["install", "remove", "purge", "reinstall", "upgrade", "dist-upgrade", "full-upgrade", "autoremove"].includes(s1)) return { ecosystem: "apt", scope: "system", sub: s1, requested: after(1) };
      return null;
    case "dnf":
    case "yum":
    case "microdnf":
      if (["install", "remove", "erase", "upgrade", "update", "reinstall", "downgrade"].includes(s1)) return { ecosystem: "rpm", scope: "system", sub: s1, requested: after(1) };
      return null;
    case "apk":
      if (s1 === "add" || s1 === "del") return { ecosystem: "apk", scope: "system", sub: s1, requested: after(1) };
      return null;
    case "pacman": {
      const op = argv.find((word) => /^-[SRU]/.test(word));
      return op ? { ecosystem: "pacman", scope: "system", sub: op, requested: words } : null;
    }
    case "brew":
      if (["install", "uninstall", "reinstall", "upgrade", "remove", "rm", "tap"].includes(s1)) return { ecosystem: "brew", scope: "system", sub: s1, requested: after(1).map((name) => (hasFlag(argv, "--cask") ? `cask:${name}` : name)) };
      return null;
    case "winget": {
      if (!["install", "add", "uninstall", "remove", "rm", "upgrade", "update", "import"].includes(s1)) return null;
      const id = flagValue(argv, "--id", "-q", "--query", "--name", "--moniker");
      const version = flagValue(argv, "-v", "--version");
      const names = [...new Set([...(id ? [id] : []), ...after(1)])].filter((name) => !/^--?/.test(name));
      return { ecosystem: "winget", scope: "system", sub: s1, requested: names.map((name) => (version ? `${name}@${version}` : name)) };
    }
    case "choco":
      if (["install", "uninstall", "upgrade", "update"].includes(s1)) {
        const version = flagValue(argv, "--version");
        return { ecosystem: "choco", scope: "system", sub: s1, requested: after(1).map((name) => (version ? `${name}@${version}` : name)) };
      }
      return null;
    case "scoop":
      if (["install", "uninstall", "update"].includes(s1)) return { ecosystem: "scoop", scope: "user", sub: s1, requested: after(1) };
      return null;
    case "curl":
    case "wget":
      return argv.some((word) => /^(?:https?|ftp):\/\//i.test(word)) ? { ecosystem: "url", scope: "project", sub: "", requested: [] } : null;
    default:
      return null;
  }
}

// --- privacy ------------------------------------------------------------------------

const SECRET_FLAG = /^--?(?:token|password|passwd|pass|pwd|secret|api[-_]?key|auth|auth[-_]?token|access[-_]?token|otp|client[-_]?secret|private[-_]?key|key)$/i;
const SECRET_HEADER = /^\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-[a-z0-9-]*(?:token|key|secret|auth)[a-z0-9-]*|private-token|job-token)\s*:/i;

/** One argument without credentials: URL userinfo and secret query values, `key=secret`, header values. */
function cleanArg(word: string): string {
  let out = word;
  // A whole-word URL: userinfo and secret query values (the rest of the query stays).
  if (/^[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(out)) return cleanUrl(out);
  // URLs inside a word (--index-url=https://u:p@host/simple): the same, in place.
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(out)) out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, "$1").replace(/((?:https?|ftp):\/\/\S+)/gi, (url) => cleanUrl(url));
  const flag = /^(--header=|-H)(?=\S)/.exec(out)?.[0] ?? "";
  const header = SECRET_HEADER.exec(out.slice(flag.length));
  if (header) return `${out.slice(0, flag.length + header[0].length)} [REDACTED]`;
  // name=value (npm config set //registry/:_authToken=..., NPM_TOKEN=..., --password=...)
  const assign = /^(-{0,2})([^=\s]+)=(.+)$/.exec(out);
  if (assign && /:\/\//.test(assign[3]!)) return out; // --index-url=<url>: cleaned above
  if (assign && (isSecretKey(assign[2]!.split(/[:/]/).at(-1) ?? "") || SECRET_FLAG.test(`--${assign[2]}`) || /_auth(?:token)?$/i.test(assign[2]!))) return `${assign[1]}${assign[2]}=[REDACTED]`;
  return out;
}

/** The call's arguments without credentials (a secret flag's value is replaced; capped). */
export function sanitizeArgs(argv: string[]): { args: string[]; truncated: boolean } {
  // client-raw: the arguments as run (the cap stays).
  if (redactionRaw()) return { args: argv.slice(0, MAX_ARGS), truncated: argv.length > MAX_ARGS };
  const out: string[] = [];
  let truncated = argv.length > MAX_ARGS;
  for (let i = 0; i < Math.min(argv.length, MAX_ARGS); i++) {
    const word = argv[i]!;
    const prev = i > 0 ? argv[i - 1]! : "";
    let clean: string;
    if (SECRET_FLAG.test(prev) || /^-(?:u|-user|-proxy-user|U)$/.test(prev) && word.includes(":")) {
      clean = SECRET_FLAG.test(prev) ? "[REDACTED]" : `${word.split(":")[0]}:[REDACTED]`;
    } else if (/^-(?:H|-header)$/.test(prev) && SECRET_HEADER.test(word)) {
      clean = cleanArg(word);
    } else if (/^npm_config_|^NPM_TOKEN$|^NODE_AUTH_TOKEN$/i.test(prev)) {
      clean = "[REDACTED]";
    } else {
      clean = cleanArg(word);
    }
    // The client redaction policy over each argument (credential shapes the rules above do not name).
    clean = redactCredentials(clean, { mode: "config" }).text;
    if (Buffer.byteLength(clean) > MAX_ARG_BYTES) {
      clean = Buffer.from(clean).subarray(0, MAX_ARG_BYTES).toString("utf8");
      truncated = true;
    }
    out.push(clean);
  }
  return { args: out, truncated };
}

// --- resolving versions -----------------------------------------------------------

function normPy(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** `requests-2.32.3.dist-info` → requests / 2.32.3. */
export function parseDistInfo(name: string): { name: string; version: string } | null {
  const match = /^(.+)-([^-]+)\.dist-info$/.exec(name.trim());
  return match ? { name: normPy(match[1]!), version: match[2]! } : null;
}

function distDiff(before: string | null, after: string | null): { resolved: Package[]; removed: Array<{ name: string; version?: string }> } {
  const parse = (text: string | null) => new Map((text ?? "").split(/\r?\n/).map(parseDistInfo).filter((item): item is { name: string; version: string } => item !== null).map((item) => [item.name, item.version]));
  const b = parse(before);
  const a = parse(after);
  const resolved: Package[] = [];
  for (const [name, version] of a) if (b.get(name) !== version) resolved.push({ name, version });
  const removed = [...b].filter(([name]) => !a.has(name)).map(([name, version]) => ({ name, version }));
  return { resolved, removed };
}

/** pip's installation report → packages (exact version, URL, sha256). */
export function pipReport(report: unknown): Package[] {
  if (!report || typeof report !== "object") return [];
  const install = (report as { install?: unknown }).install;
  if (!Array.isArray(install)) return [];
  const out: Package[] = [];
  for (const item of install) {
    if (!item || typeof item !== "object") continue;
    const metadata = (item as { metadata?: { name?: unknown; version?: unknown } }).metadata ?? {};
    const info = (item as { download_info?: { url?: unknown; archive_info?: { hashes?: Record<string, unknown>; hash?: unknown } } }).download_info ?? {};
    if (typeof metadata.name !== "string" || typeof metadata.version !== "string") continue;
    const pkg: Package = { name: normPy(metadata.name), version: metadata.version };
    if (typeof info.url === "string" && !info.url.startsWith("file:")) pkg.source = info.url;
    const sha = info.archive_info?.hashes?.sha256 ?? (typeof info.archive_info?.hash === "string" && info.archive_info.hash.startsWith("sha256=") ? info.archive_info.hash.slice(7) : undefined);
    if (typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)) pkg.sha256 = sha;
    out.push(pkg);
  }
  return out;
}

type NpmEntry = { name: string; version: string; resolved?: string; integrity?: string };

function npmTree(text: string | null): Map<string, NpmEntry> {
  const out = new Map<string, NpmEntry>();
  if (!text) return out;
  try {
    const lock = JSON.parse(text) as { packages?: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string; link?: boolean }> };
    for (const [key, value] of Object.entries(lock.packages ?? {})) {
      if (!key || !value || value.link) continue;
      const name = value.name ?? key.replace(/^.*node_modules\//, "");
      out.set(key, { name, version: value.version ?? "", ...(value.resolved ? { resolved: value.resolved } : {}), ...(value.integrity ? { integrity: value.integrity } : {}) });
    }
  } catch {
    /* not JSON */
  }
  return out;
}

/** The hidden lockfile before and after an npm install → what it added or changed, and what it removed. */
export function npmDiff(before: string | null, after: string | null): { resolved: Package[]; removed: Array<{ name: string; version?: string }> } {
  const b = npmTree(before);
  const a = npmTree(after);
  const resolved: Package[] = [];
  for (const [key, entry] of a) {
    const old = b.get(key);
    if (old && old.version === entry.version) continue;
    resolved.push({ name: entry.name, version: entry.version, ...(entry.resolved ? { source: entry.resolved } : {}), ...(entry.integrity ? { integrity: entry.integrity } : {}), path: key });
  }
  const removed = [...b].filter(([key]) => !a.has(key)).map(([, entry]) => ({ name: entry.name, version: entry.version }));
  return { resolved, removed };
}

/** `lodash@^4` → lodash; `@types/node@20` → @types/node; `pkg==1.2` → pkg. */
export function packageName(spec: string): string {
  let s = spec.trim();
  if (s.startsWith("cask:")) s = s.slice(5);
  if (/^(?:git\+|https?:|file:|\.{0,2}\/|[A-Za-z]:\\|-r )/.test(s)) return "";
  if (s.startsWith("@")) {
    const at = s.indexOf("@", 1);
    return at > 0 ? s.slice(0, at) : s;
  }
  return s.split(/[@=<>!~;\[ ]/)[0] ?? "";
}

async function readPackageVersion(dir: string): Promise<{ version: string } | null> {
  const json = (await readJson(path.join(dir, "package.json"))) as { version?: unknown } | null;
  return json && typeof json.version === "string" ? { version: json.version } : null;
}

const LOCKFILES: Record<string, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"],
  pypi: ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock"],
  cargo: ["Cargo.lock"],
  go: ["go.sum"],
  gem: ["Gemfile.lock"],
  composer: ["composer.lock"],
};

async function findUp(start: string, names: string[], stop: string | null): Promise<string | null> {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    for (const name of names) if (await exists(path.join(dir, name))) return path.join(dir, name);
    if (stop && path.resolve(dir) === path.resolve(stop)) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export type ResolveContext = {
  platform: NodeJS.Platform;
  home: string | null;
  env: NodeJS.ProcessEnv;
  run: Runner;
  root: string;
};

async function globalNpmRoots(tool: string, real: string | null, ctx: ResolveContext): Promise<string[]> {
  const roots: string[] = [];
  const prefix = ctx.env.npm_config_prefix ?? ctx.env.NPM_CONFIG_PREFIX;
  if (prefix) roots.push(ctx.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules"));
  if (real) {
    const bin = path.dirname(real);
    roots.push(ctx.platform === "win32" ? path.join(bin, "node_modules") : path.join(path.dirname(bin), "lib", "node_modules"));
    try {
      const resolved = await fs.realpath(real);
      if (ctx.platform !== "win32") {
        const at = resolved.indexOf(`${path.sep}lib${path.sep}node_modules${path.sep}`);
        if (at > 0) roots.push(resolved.slice(0, at + `${path.sep}lib${path.sep}node_modules`.length));
      }
    } catch {
      /* not a link */
    }
  }
  if (ctx.home) {
    if (ctx.platform === "win32") roots.push(path.join(ctx.env.APPDATA ?? path.join(ctx.home, "AppData", "Roaming"), "npm", "node_modules"));
    roots.push(path.join(ctx.home, ".npm-global", "lib", "node_modules"), path.join(ctx.home, ".bun", "install", "global", "node_modules"), path.join(ctx.home, ".config", "yarn", "global", "node_modules"));
    if (tool === "pnpm") roots.push(path.join(ctx.home, ".local", "share", "pnpm", "global", "5", "node_modules"));
  }
  return [...new Set(roots)];
}

function pythonSitePackages(prefix: string, platform: NodeJS.Platform): Promise<string[]> {
  return (async () => {
    if (platform === "win32") return [path.join(prefix, "Lib", "site-packages")];
    try {
      const libs = await fs.readdir(path.join(prefix, "lib"));
      return libs.filter((name) => /^python\d/.test(name)).map((name) => path.join(prefix, "lib", name, "site-packages"));
    } catch {
      return [];
    }
  })();
}

async function distVersion(sitePackages: string[], name: string): Promise<string | null> {
  const wanted = normPy(name);
  for (const dir of sitePackages) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const info = parseDistInfo(entry);
      if (info && info.name === wanted) return info.version;
    }
  }
  return null;
}

/** Exact versions of what a call installed (best effort; never throws). */
async function resolveCall(call: RawCall, cls: Classified, tool: string, ctx: ResolveContext): Promise<{
  resolved: Package[]; removed: Array<{ name: string; version?: string }>; downloads: Download[]; target: string | null; python: string | null; lockfile: string | null;
}> {
  const read = (name: string) => readText(path.join(call.dir, name));
  let resolved: Package[] = [];
  let removed: Array<{ name: string; version?: string }> = [];
  const downloads: Download[] = [];
  let target: string | null = null;
  let python: string | null = null;
  let lockfile: string | null = null;
  const names = cls.requested.map(packageName).filter(Boolean);
  const cwd = call.meta.cwd || ctx.root;
  const real = call.meta.real || null;
  try {
    switch (cls.ecosystem) {
      case "pypi": {
        const reports = call.hooks.flatMap((hook) => pipReport(hook.report));
        if (reports.length) resolved = reports;
        for (const hook of call.hooks) {
          for (const line of hook.removed) {
            const [name, version] = line.split("\t");
            if (name) removed.push({ name: normPy(name), ...(version ? { version } : {}) });
          }
        }
        const hook = call.hooks[0];
        if (hook) {
          target = hook.meta.prefix || null;
          python = hook.meta.version || null;
        }
        const venv = call.meta.venv_dir || null;
        if (venv) target ??= venv;
        if (!reports.length) {
          const diff = distDiff(await read("b.dist"), await read("a.dist"));
          if (diff.resolved.length || diff.removed.length) {
            resolved = diff.resolved;
            removed = diff.removed.length ? diff.removed : removed;
          }
        }
        // pipx / uv tool: the tool's own environment.
        if (!resolved.length && cls.scope === "global" && ctx.home && (tool === "pipx" || tool === "uv")) {
          for (const name of names) {
            const base = tool === "pipx"
              ? [path.join(ctx.env.PIPX_HOME ?? path.join(ctx.home, ".local", "share", "pipx"), "venvs", normPy(name)), path.join(ctx.home, "pipx", "venvs", normPy(name))]
              : [path.join(ctx.env.UV_TOOL_DIR ?? (ctx.platform === "win32" ? path.join(ctx.env.APPDATA ?? ctx.home, "uv", "tools") : path.join(ctx.home, ".local", "share", "uv", "tools")), normPy(name))];
            for (const env of base) {
              const version = await distVersion(await pythonSitePackages(env, ctx.platform), name);
              if (version) {
                resolved.push({ name: normPy(name), version });
                target ??= env;
                break;
              }
            }
          }
        }
        if (cls.scope === "project") {
          const lock = await findUp(cwd, LOCKFILES.pypi!, ctx.root);
          if (lock && (tool === "uv" || tool === "poetry" || tool === "pipenv")) lockfile = lock;
        }
        break;
      }
      case "npm": {
        if (cls.scope === "global") {
          target = "global";
          const roots = await globalNpmRoots(tool, real, ctx);
          for (const name of names) {
            for (const root of roots) {
              const found = await readPackageVersion(path.join(root, name));
              if (found) {
                resolved.push({ name, version: found.version, path: `node_modules/${name}` });
                break;
              }
            }
          }
          break;
        }
        const root = call.meta.root || (await findUp(call.meta.prefix_arg || cwd, ["package.json"], null).then((file) => (file ? path.dirname(file) : null)));
        target = root ?? cwd;
        const after = await read("a.npm");
        if (after !== null) ({ resolved, removed } = npmDiff(await read("b.npm"), after));
        if (!resolved.length && root) {
          for (const name of names) {
            const found = await readPackageVersion(path.join(root, "node_modules", name));
            if (found) resolved.push({ name, version: found.version, path: `node_modules/${name}` });
          }
        }
        if (root) {
          for (const name of LOCKFILES.npm!) {
            if (await exists(path.join(root, name))) {
              lockfile = path.join(root, name);
              break;
            }
          }
        }
        break;
      }
      case "cargo": {
        if (cls.scope === "global" && ctx.home) {
          const crates = (await readJson(path.join(ctx.env.CARGO_HOME ?? path.join(ctx.home, ".cargo"), ".crates2.json"))) as { installs?: Record<string, unknown> } | null;
          const keys = Object.keys(crates?.installs ?? {});
          for (const name of names) {
            const key = keys.find((item) => item.split(" ")[0] === name);
            if (!key) continue;
            const [, version, source] = /^\S+ (\S+) \((.*)\)$/.exec(key) ?? [];
            if (version) resolved.push({ name, version, ...(source ? { source } : {}) });
          }
        } else lockfile = await findUp(cwd, LOCKFILES.cargo!, ctx.root);
        break;
      }
      case "go": {
        if (cls.scope === "global") {
          const envOut = await ctx.run(real ?? "go", ["env", "GOBIN", "GOPATH"], { timeoutMs: 5_000, env: quietEnv({ ...ctx.env, OMNIRUSH_PKGLOG_OFF: "1" }) });
          const [gobin = "", gopath = ""] = (envOut?.stdout ?? "").split(/\r?\n/);
          const bin = gobin.trim() || (gopath.trim() ? path.join(gopath.trim().split(path.delimiter)[0]!, "bin") : "");
          for (const spec of cls.requested) {
            const [pkg = "", version = ""] = spec.split("@");
            if (!pkg) continue;
            const parts = pkg.split("/").filter((part) => !/^v\d+$/.test(part));
            const exe = parts.at(-1) ?? "";
            if (/^v\d+\.\d+\.\d+/.test(version)) {
              resolved.push({ name: pkg, version });
              continue;
            }
            if (!bin || !exe) continue;
            const info = await ctx.run(real ?? "go", ["version", "-m", path.join(bin, ctx.platform === "win32" ? `${exe}.exe` : exe)], { timeoutMs: 5_000, env: quietEnv({ ...ctx.env, OMNIRUSH_PKGLOG_OFF: "1" }) });
            const mod = /^\s*mod\s+(\S+)\s+(\S+)(?:\s+(\S+))?/m.exec(info?.stdout ?? "");
            if (mod) resolved.push({ name: pkg, version: mod[2]!, ...(mod[3] ? { integrity: mod[3] } : {}) });
          }
        } else lockfile = await findUp(cwd, LOCKFILES.go!, ctx.root);
        break;
      }
      case "gem": {
        if (cls.scope === "project") {
          lockfile = await findUp(cwd, LOCKFILES.gem!, ctx.root);
          break;
        }
        for (const spec of cls.requested.slice(0, 10)) {
          const [name = "", wanted = ""] = spec.split("@");
          if (!name) continue;
          const listed = await ctx.run(real ?? "gem", ["list", "--local", "--exact", name], { timeoutMs: 10_000, env: quietEnv({ ...ctx.env, OMNIRUSH_PKGLOG_OFF: "1" }) });
          const versions = /\(([^)]*)\)/.exec(listed?.stdout ?? "")?.[1]?.split(",").map((item) => item.trim().replace(/^default:\s*/, "").split(" ")[0]!) ?? [];
          const version = wanted && versions.includes(wanted) ? wanted : versions[0];
          if (version) resolved.push({ name, version });
        }
        break;
      }
      case "composer":
        if (cls.scope === "project") lockfile = await findUp(cwd, LOCKFILES.composer!, ctx.root);
        break;
      case "apt": {
        const parse = (text: string | null) => {
          const out = new Map<string, string>();
          for (const block of (text ?? "").split(/\n\n+/)) {
            const name = /^Package: (.+)$/m.exec(block)?.[1];
            const version = /^Version: (.+)$/m.exec(block)?.[1];
            const status = /^Status: (.+)$/m.exec(block)?.[1] ?? "";
            const arch = /^Architecture: (.+)$/m.exec(block)?.[1];
            if (name && version && status.includes("installed") && !status.includes("not-installed") && !status.includes("config-files")) out.set(arch && arch !== "all" ? `${name}:${arch}` : name, version);
          }
          return out;
        };
        const before = parse(await read("b.dpkg"));
        const after = parse(await read("a.dpkg"));
        for (const [name, version] of after) if (before.get(name) !== version) resolved.push({ name: name.replace(/:(?:amd64|arm64|i386|armhf)$/, ""), version });
        for (const [name, version] of before) if (!after.has(name)) removed.push({ name: name.replace(/:(?:amd64|arm64|i386|armhf)$/, ""), version });
        break;
      }
      case "apk": {
        const parse = (text: string | null) => {
          const out = new Map<string, string>();
          for (const block of (text ?? "").split(/\n\n+/)) {
            const name = /^P:(.+)$/m.exec(block)?.[1];
            const version = /^V:(.+)$/m.exec(block)?.[1];
            if (name && version) out.set(name, version);
          }
          return out;
        };
        const before = parse(await read("b.apk"));
        const after = parse(await read("a.apk"));
        for (const [name, version] of after) if (before.get(name) !== version) resolved.push({ name, version });
        for (const [name, version] of before) if (!after.has(name)) removed.push({ name, version });
        break;
      }
      case "rpm":
      case "pacman": {
        if (!names.length) break;
        const probe = cls.ecosystem === "rpm" ? ["rpm", ["-q", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n", ...names.slice(0, 50)]] as const : ["pacman", ["-Q", ...names.slice(0, 50)]] as const;
        const out = await ctx.run(probe[0], [...probe[1]], { timeoutMs: 10_000 });
        for (const line of (out?.stdout ?? "").split(/\r?\n/)) {
          const [name, version] = line.split(/[\t ]+/);
          if (name && version && !/not installed|was not found/.test(line)) resolved.push({ name, version });
        }
        break;
      }
      case "brew": {
        if (!real) break;
        let prefix: string;
        try {
          prefix = path.dirname(path.dirname(await fs.realpath(real)));
        } catch {
          prefix = path.dirname(path.dirname(real));
        }
        for (const spec of cls.requested) {
          const cask = spec.startsWith("cask:");
          const name = packageName(spec).split("/").at(-1) ?? "";
          if (!name) continue;
          const dir = path.join(prefix, cask ? "Caskroom" : "Cellar", name);
          let versions: string[] = [];
          try {
            versions = await fs.readdir(dir);
          } catch {
            continue;
          }
          let newest: { version: string; at: number } | null = null;
          for (const version of versions) {
            const at = (await mtimeMs(path.join(dir, version))) ?? 0;
            if (!newest || at > newest.at) newest = { version, at };
          }
          if (newest) resolved.push({ name: cask ? `cask:${name}` : name, version: newest.version });
        }
        break;
      }
      case "winget": {
        if (ctx.platform !== "win32") break;
        for (const spec of cls.requested.slice(0, 3)) {
          const id = spec.split("@")[0]!;
          const out = await ctx.run("winget", ["list", "--id", id, "--exact", "--accept-source-agreements", "--disable-interactivity"], { timeoutMs: 20_000 });
          const row = (out?.stdout ?? "").split(/\r?\n/).find((line) => line.includes(id));
          const version = row?.slice(row.indexOf(id) + id.length).trim().split(/\s+/)[0];
          if (version && /\d/.test(version)) resolved.push({ name: id, version });
        }
        break;
      }
      case "choco": {
        const base = ctx.env.ChocolateyInstall ?? "C:\\ProgramData\\chocolatey";
        for (const name of names) {
          const nuspec = await readText(path.join(base, "lib", name, `${name}.nuspec`), 1024 * 1024);
          const version = nuspec ? /<version>([^<]+)<\/version>/.exec(nuspec)?.[1] : undefined;
          if (version) resolved.push({ name, version });
        }
        break;
      }
      case "scoop": {
        if (!ctx.home) break;
        const base = ctx.env.SCOOP ?? path.join(ctx.home, "scoop");
        for (const name of names) {
          const manifest = (await readJson(path.join(base, "apps", name.split("/").at(-1)!, "current", "manifest.json"))) as { version?: unknown } | null;
          if (manifest && typeof manifest.version === "string") resolved.push({ name, version: manifest.version });
        }
        break;
      }
      case "browsers": {
        if (!ctx.home) break;
        const dir = ctx.env.PLAYWRIGHT_BROWSERS_PATH && ctx.env.PLAYWRIGHT_BROWSERS_PATH !== "0" ? ctx.env.PLAYWRIGHT_BROWSERS_PATH
          : ctx.platform === "darwin" ? path.join(ctx.home, "Library", "Caches", "ms-playwright")
            : ctx.platform === "win32" ? path.join(ctx.env.LOCALAPPDATA ?? path.join(ctx.home, "AppData", "Local"), "ms-playwright")
              : path.join(ctx.home, ".cache", "ms-playwright");
        let entries: string[] = [];
        try {
          entries = await fs.readdir(dir);
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const match = /^(.+)-(\d+)$/.exec(entry);
          const at = await mtimeMs(path.join(dir, entry));
          if (match && at !== null && at >= call.start - 5_000) resolved.push({ name: match[1]!, version: match[2]! });
        }
        target = tildeText(dir, { home: ctx.home, user: null });
        break;
      }
      case "corepack": {
        for (const spec of cls.requested) {
          const [name = "", version = ""] = spec.startsWith("@") ? [spec] : spec.split("@");
          if (name && version) resolved.push({ name, version });
        }
        break;
      }
      case "runtime":
      case "rustup":
      case "conda":
        break;
      case "url": {
        const url = call.argv.find((word) => /^(?:https?|ftp):\/\//i.test(word));
        if (!url) break;
        let out: string | null;
        if (tool === "curl") {
          out = flagValue(call.argv, "-o", "--output");
          if (out === null) {
            const combined = call.argv.findIndex((word) => /^-[^-]*o$/.test(word));
            if (combined >= 0) out = call.argv[combined + 1] ?? null;
          }
          if (out === null && (hasFlag(call.argv, "-O", "--remote-name", "--remote-name-all") || call.argv.some((word) => /^-[^-]*O$/.test(word)))) out = "@remote";
        } else {
          out = flagValue(call.argv, "-O", "--output-document") ?? "@remote";
        }
        if (out === "-") out = null;
        if (out !== null) {
          let file = out;
          if (out === "@remote") {
            let base = "index.html";
            try {
              base = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "") || "index.html";
            } catch {
              /* keep */
            }
            const dir = tool === "wget" ? flagValue(call.argv, "-P", "--directory-prefix") ?? "" : "";
            file = path.join(dir, base);
          }
          const absolute = path.resolve(cwd, file);
          const hashed = await sha256File(absolute);
          downloads.push({ url, path: absolute, ...(hashed?.sha256 ? { sha256: hashed.sha256 } : {}), ...(hashed ? { size: hashed.size } : {}) });
        } else {
          downloads.push({ url, path: "(stdout)" });
        }
        break;
      }
    }
  } catch {
    /* what was found so far */
  }
  return { resolved: resolved.slice(0, MAX_PACKAGES), removed: removed.slice(0, MAX_PACKAGES), downloads, target, python, lockfile };
}

function osName(platform: NodeJS.Platform): InstallLine["os"] {
  return platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
}

/** `child` relative to `root` with `/`, "" for the root itself, null when outside it. */
export function relativeTo(root: string, child: string | null, platform: NodeJS.Platform = process.platform): string | null {
  if (!child || !root) return null;
  const mod = platform === "win32" ? path.win32 : path.posix;
  const rel = mod.relative(mod.resolve(root), mod.resolve(child));
  if (rel === "") return "";
  if (rel.startsWith("..") || mod.isAbsolute(rel)) return null;
  return rel.split(mod.sep).join("/");
}

/** The calls the wrappers noted, as ledger lines (credentials stripped, the home as `~`). */
export async function lineOf(call: RawCall, options: { root: string; turn: number | null; callId: string | null; command: string | null; privacy: PrivacyContext; scrub: Scrubber; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; run: Runner }): Promise<InstallLine | null> {
  const tool = (call.meta.tool || "pip").toLowerCase();
  const cls = classifyCall(tool, call.argv);
  if (!cls) return null;
  const ctx: ResolveContext = { platform: options.platform, home: options.privacy.home, env: options.env, run: options.run, root: options.root };
  const found = await resolveCall(call, cls, tool, ctx);
  if (cls.ecosystem === "url") {
    const download = found.downloads[0];
    if (!download) return null;
    if (download.path === "(stdout)") {
      // Only a script piped into an interpreter is an install; a plain request is not.
      const piped = options.command && /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b|\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|iex|bash)\b/.test(options.command);
      if (!piped) return null;
      download.path = "(piped)";
    }
  }
  const tilde = (text: string | null) => (text === null ? null : options.scrub.text(tildeText(text, options.privacy)));
  const { args, truncated } = sanitizeArgs(call.argv);
  const cwd = call.meta.cwd || options.root;
  const hook = call.hooks[0];
  const exit = call.exit ?? (hook?.meta.exit ? Number(hook.meta.exit) : null);
  const end = call.end ?? (hook?.meta.t1 ? Number(hook.meta.t1) : null);
  const lockSha = found.lockfile ? (await sha256File(found.lockfile, 64 * 1024 * 1024))?.sha256 || null : null;
  const line: InstallLine = {
    v: 1,
    schema: INSTALL_LOG_SCHEMA,
    ts: new Date(call.start).toISOString(),
    end: end ? new Date(end).toISOString() : null,
    dur_ms: end ? Math.max(0, Math.round(end - call.start)) : null,
    turn: options.turn,
    call: options.callId,
    tool,
    via: call.meta.via === "python-hook" ? "python-hook" : "shim",
    real: tilde(call.meta.real || hook?.meta.python || null),
    argv: args.map((arg) => options.scrub.text(tildeText(arg, options.privacy))),
    cwd: tilde(cwd)!,
    cwd_rel: relativeTo(options.root, cwd, options.platform),
    exit: Number.isFinite(exit) ? exit : null,
    os: osName(options.platform),
    scope: hook && cls.ecosystem === "pypi" && cls.scope === "project" && hook.meta.prefix && hook.meta.base_prefix && hook.meta.prefix === hook.meta.base_prefix ? "global" : cls.scope,
    ecosystem: cls.ecosystem,
    target: found.target === "global" ? "global" : tilde(found.target),
    target_rel: found.target && found.target !== "global" ? relativeTo(options.root, found.target, options.platform) : null,
    python: found.python,
    requested: cls.requested.slice(0, 500).map((spec) => options.scrub.text(tildeText(redactionRaw() ? spec : cleanArg(spec), options.privacy))),
    resolved: found.resolved.map((pkg) => ({ ...pkg, ...(pkg.source && !redactionRaw() ? { source: cleanUrl(pkg.source) } : {}) })),
    removed: found.removed,
    downloads: found.downloads.map((download) => ({
      url: redactionRaw() ? download.url : cleanUrl(download.url),
      path: download.path.startsWith("(") ? download.path : tilde(download.path)!,
      path_rel: download.path.startsWith("(") ? null : relativeTo(options.root, download.path, options.platform),
      ...(download.sha256 ? { sha256: download.sha256 } : {}),
      ...(download.size !== undefined ? { size: download.size } : {}),
    })),
    lockfile: found.lockfile ? path.basename(found.lockfile) : null,
    lockfile_rel: found.lockfile ? relativeTo(options.root, found.lockfile, options.platform) : null,
    lockfile_sha256: lockSha,
    ...(truncated || found.resolved.length >= MAX_PACKAGES ? { truncated: true } : {}),
  };
  return line;
}

// --- PowerShell downloads (cmdlets no PATH wrapper sees) ----------------------------

// PowerShell's download and install cmdlets and their aliases. No PATH wrapper sees a cmdlet,
// and the engine starts PowerShell with -NoProfile (no function wrapper can be loaded only for
// the agent's shells without changing the engine or the execution policy), so they are read from
// the call's command text. The names are put together here so that the package scanner
// (scripts/scan-package.mjs), which looks for download-and-run code in what ships, never takes
// this reader of the agent's commands for such code.
const PS_WEB = ["Invoke-" + "WebRequest", "iwr", "Invoke-" + "RestMethod", "irm", "Start-" + "BitsTransfer", "wget", "curl"];
const PS_DOWNLOAD = new RegExp(`(?:^|[\\s(&|{])(${PS_WEB.join("|")})(?=\\s|$)(.*)$`, "i");
const PS_RUN = new RegExp(`\\|\\s*(?:iex|Invoke-${"Expression"})\\b|^\\s*(?:iex|Invoke-${"Expression"})\\b|[;&]\\s*(?:iex|Invoke-${"Expression"})\\b`, "i");
const PS_CLIENT = new RegExp(`(?:New-Object\\s+(?:-TypeName\\s+)?["']?(?:System\\.)?Net\\.${"WebClient"}["']?\\)?|\\[(?:System\\.)?Net\\.${"WebClient"}\\]::new\\(\\)\\)?)[^.]*\\.(Download${"String"}|Download${"File"})\\(\\s*([^)]*)\\)`, "i");
const PS_MODULE = /\b(Install-Module|Install-Package|Install-Script|Install-PSResource|Update-Module)\b(.*)$/i;

/** `$name = "value"` assignments of a PowerShell command (so `-Uri $url` can be read). */
function psVariables(command: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of command.matchAll(/\$([A-Za-z_][\w]*)\s*=\s*(["'])([^"'\r\n]*)\2/g)) vars.set(match[1]!.toLowerCase(), match[3]!);
  return vars;
}

/** A word of a PowerShell segment: quotes removed, `$var` from the command's own assignments. */
function psWord(raw: string | undefined, vars: Map<string, string>): string | null {
  if (!raw) return null;
  let word = raw.trim().replace(/^["']|["']$/g, "");
  word = word.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name: string) => vars.get(name.toLowerCase()) ?? all);
  return word || null;
}

function psFlag(rest: string, names: string[]): string | undefined {
  const re = new RegExp(`-(?:${names.join("|")})(?::|\\s+)("[^"]*"|'[^']*'|[^\\s;|)]+)`, "i");
  return re.exec(rest)?.[1];
}

/** Downloads a PowerShell command makes (cmdlets, their aliases, the .NET web client): url + file, or piped into a run. */
export function powershellDownloads(command: string): Array<{ url: string; out: string | null; piped: boolean; unresolved?: boolean }> {
  const out: Array<{ url: string; out: string | null; piped: boolean; unresolved?: boolean }> = [];
  const vars = psVariables(command);
  const isUrl = (word: string | null): word is string => Boolean(word && /^(?:https?|ftp):\/\/\S+$/i.test(word));
  for (const segment of command.split(/;|\r?\n|&&|\|\|/)) {
    const client = PS_CLIENT.exec(segment);
    if (client) {
      const args = client[2]!.split(",").map((part) => psWord(part, vars));
      if (isUrl(args[0] ?? null)) {
        const file = client[1]!.toLowerCase().endsWith("file") ? args[1] ?? null : null;
        if (file || PS_RUN.test(segment)) out.push({ url: args[0]!, out: file, piped: !file });
      }
      continue;
    }
    const match = PS_DOWNLOAD.exec(segment);
    if (!match) continue;
    const cmdlet = match[1]!;
    const rest = match[2]!;
    // curl/wget without PowerShell's own parameters are the real programs: their wrapper saw them.
    if (/^(?:curl|wget)$/i.test(cmdlet) && !/-(?:Uri|OutFile|UseBasicParsing|Method|Headers)\b/i.test(rest)) continue;
    let url = psWord(psFlag(rest, ["Uri", "Source"]), vars);
    if (!isUrl(url)) {
      const positional = /^\s+("[^"]*"|'[^']*'|[^\s;|)-][^\s;|)]*)/.exec(rest)?.[1];
      url = psWord(positional, vars);
    }
    // A URL given after other parameters (iwr -UseBasicParsing https://...).
    if (!isUrl(url)) url = psWord(/(?:^|\s)(["']?(?:https?|ftp):\/\/[^\s"'|;)]+["']?)/i.exec(rest)?.[1], vars);
    const file = psWord(psFlag(rest, ["OutFile", "Destination"]), vars);
    const piped = PS_RUN.test(rest) || PS_RUN.test(segment.slice(0, match.index));
    if (!file && !piped) continue;
    if (isUrl(url)) {
      out.push({ url, out: file, piped: piped && !file });
      continue;
    }
    // The URL is a loop variable or built at run time: the command's literal URLs, the file unknown.
    for (const found of command.matchAll(/["'\s(=,@]((?:https?|ftp):\/\/[^\s"'|;)$,]+)/gi)) {
      if (!out.some((item) => item.url === found[1])) out.push({ url: found[1]!, out: null, piped: false, unresolved: true });
    }
  }
  return out;
}

/** PowerShell Gallery installs a command makes: module or script names, the version asked for, and the scope. */
export function powershellModules(command: string): Array<{ cmdlet: string; names: string[]; version: string | null; scope: "user" | "system" }> {
  const out: Array<{ cmdlet: string; names: string[]; version: string | null; scope: "user" | "system" }> = [];
  const vars = psVariables(command);
  for (const segment of command.split(/;|\r?\n|&&|\|\|/)) {
    const match = PS_MODULE.exec(segment);
    if (!match) continue;
    const rest = match[2]!;
    let names = psWord(psFlag(rest, ["Name"]), vars);
    if (!names) names = psWord(/^\s+("[^"]*"|'[^']*'|[^\s;|)-][^\s;|)]*)/.exec(rest)?.[1], vars);
    const list = (names ?? "").split(",").map((name) => name.trim().replace(/^["']|["']$/g, "")).filter((name) => /^[\w.-]+$/.test(name));
    if (!list.length) continue;
    const version = psWord(psFlag(rest, ["RequiredVersion", "Version", "MinimumVersion"]), vars);
    const scope = /-Scope(?::|\s+)["']?AllUsers/i.test(rest) ? "system" : "user";
    out.push({ cmdlet: match[1]!, names: list, version: version && /^[\w.-]+$/.test(version) ? version : null, scope });
  }
  return out;
}

/** The installed versions of a PowerShell module (newest first): the user's and the machine's module folders. */
export async function powershellModuleVersions(name: string, env: NodeJS.ProcessEnv, home: string | null): Promise<string[]> {
  const docs = [env.OneDrive ? path.join(env.OneDrive, "Documents") : null, home ? path.join(home, "Documents") : null].filter((dir): dir is string => Boolean(dir));
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const roots = [
    ...docs.flatMap((dir) => [path.join(dir, "WindowsPowerShell", "Modules"), path.join(dir, "PowerShell", "Modules")]),
    path.join(programFiles, "WindowsPowerShell", "Modules"),
    path.join(programFiles, "PowerShell", "Modules"),
  ];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(path.join(root, name));
    } catch {
      continue;
    }
    const versions: Array<{ version: string; at: number }> = [];
    for (const entry of entries) if (/^\d+(?:\.\d+)+/.test(entry)) versions.push({ version: entry, at: (await mtimeMs(path.join(root, name, entry))) ?? 0 });
    if (versions.length) return versions.sort((a, b) => b.at - a.at).map((item) => item.version);
  }
  return [];
}

/** A PowerShell path word on this machine: $env:NAME, $HOME and ~ expanded. */
export function powershellPath(word: string, env: NodeJS.ProcessEnv, home: string | null): string {
  let out = word.replace(/\$env:([A-Za-z_]\w*)/gi, (all, name: string) => {
    const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? env[key] ?? all : all;
  });
  if (home) out = out.replace(/^(?:\$HOME|~)(?=$|[\\/])/i, home);
  return out;
}

// --- per-turn environment ---------------------------------------------------------

const RUNTIMES: Array<{ name: string; commands: string[]; args: string[]; pattern: RegExp }> = [
  { name: "node", commands: ["node"], args: ["--version"], pattern: /v?(\d+\.\d+\.\d+)/ },
  { name: "python", commands: ["python3", "python"], args: ["--version"], pattern: /Python (\d+\.\d+\.\d+)/ },
  { name: "go", commands: ["go"], args: ["version"], pattern: /go(\d+\.\d+(?:\.\d+)?)/ },
  { name: "rustc", commands: ["rustc"], args: ["--version"], pattern: /rustc (\d+\.\d+\.\d+)/ },
  { name: "java", commands: ["java"], args: ["-version"], pattern: /version "?(\d+(?:\.\d+)*)/ },
  { name: "ruby", commands: ["ruby"], args: ["--version"], pattern: /ruby (\d+\.\d+\.\d+)/ },
];
const PIN_FILES = [".nvmrc", ".node-version", ".python-version", ".tool-versions", "mise.toml", ".mise.toml", "rust-toolchain", "rust-toolchain.toml", ".ruby-version", ".java-version", ".sdkmanrc"];
const MANAGER_ENV: Array<[string, string]> = [
  ["NVM_DIR", "nvm"], ["PYENV_ROOT", "pyenv"], ["PYENV_SHELL", "pyenv"], ["MISE_SHELL", "mise"], ["ASDF_DIR", "asdf"], ["ASDF_DATA_DIR", "asdf"],
  ["VOLTA_HOME", "volta"], ["FNM_DIR", "fnm"], ["FNM_MULTISHELL_PATH", "fnm"], ["RBENV_ROOT", "rbenv"], ["SDKMAN_DIR", "sdkman"], ["CONDA_PREFIX", "conda"], ["NVM_HOME", "nvm-windows"],
];
const MANAGER_PATH: Array<[RegExp, string]> = [
  [/[\\/]\.nvm[\\/]/, "nvm"], [/[\\/]\.pyenv[\\/]|[\\/]pyenv-win[\\/]/, "pyenv"], [/[\\/]mise[\\/](?:installs|shims)[\\/]/, "mise"], [/[\\/]\.asdf[\\/]/, "asdf"],
  [/[\\/]\.volta[\\/]/, "volta"], [/fnm/, "fnm"], [/[\\/]\.rbenv[\\/]/, "rbenv"], [/[\\/]\.sdkman[\\/]/, "sdkman"], [/conda|miniforge|mambaforge/i, "conda"], [/[\\/]\.local[\\/]share[\\/]uv[\\/]python[\\/]/, "uv"],
];

async function which(command: string, pathValue: string, platform: NodeJS.Platform, skip: string | null): Promise<string | null> {
  const sep = platform === "win32" ? ";" : ":";
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(sep)) {
    if (!dir || (skip && path.resolve(dir) === path.resolve(skip))) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${command}${ext}`);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) return file;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export type EnvTurn = {
  schema: typeof ENV_TURN_SCHEMA;
  turn: number;
  at: string;
  os: InstallLine["os"];
  arch: string;
  os_version: string | null;
  runtimes: Record<string, string>;
  paths: Record<string, string>;
  managers: string[];
  pins: Record<string, string>;
  changed: boolean;
  installs: number;
  outside_writes: Array<{ path: string; size: number; sha256: string | null; mtime: string }>;
  outside_truncated: boolean;
  timings_ms: Record<string, number>;
};

/** Runtime versions are probed again only when this key (binaries on PATH, their mtime, the version pins) changes. */
const fingerprintCache = new Map<string, { key: string; runtimes: Record<string, string> }>();

type EnvFingerprint = Omit<EnvTurn, "schema" | "turn" | "at" | "installs" | "outside_writes" | "outside_truncated" | "timings_ms">;

/** The box's machine, kernel and the runtimes on its PATH (`<command> <path>` lines). */
// PATH is walked by hand so the install log's wrappers (~/.omnirush/pkglog/bin-*, the box's
// /opt/omnirush/pkglog) are skipped, as `skipDir` does on this machine. It always exits 0: a
// loop whose last command is missing would end 127, which reads as "no box".
const BOX_WHICH = `uname -m; uname -r; IFS=:; for c in ${[...new Set(["mise", ...RUNTIMES.flatMap((runtime) => runtime.commands)])].join(" ")}; do for d in $PATH; do case "$d" in */pkglog|*/pkglog/*) continue;; esac; if [ -f "$d/$c" ] && [ -x "$d/$c" ]; then echo "$c $d/$c"; break; fi; done; done; true`;

/**
 * The fingerprint of a session whose shell tool runs in its box (src/box):
 * the runtimes the agent's commands run with are the box's, so they are
 * found and probed there (`run`: a runner for commands inside it); the
 * version pins are the project's files, the same in and out of the box.
 */
async function boxEnvFingerprint(options: { root: string; privacy: PrivacyContext; run: Runner }): Promise<EnvFingerprint> {
  const result = await options.run("sh", ["-c", BOX_WHICH], { timeoutMs: 5_000, cwd: options.root, maxBytes: 64 * 1024 });
  const lines = (result && result.code === 0 ? result.stdout : "").split("\n").map((line) => line.trim());
  const machine = lines[0] ?? "";
  const found = new Map<string, string>();
  for (const line of lines.slice(2)) {
    const match = /^(\S+) (\/\S+)$/.exec(line);
    if (match) found.set(match[1]!, match[2]!);
  }
  const paths: Record<string, string> = {};
  for (const runtime of RUNTIMES) {
    const command = runtime.commands.find((name) => found.has(name));
    if (command) paths[runtime.name] = found.get(command)!;
  }
  const pins: Record<string, string> = {};
  for (const name of PIN_FILES) {
    const text = await readText(path.join(options.root, name), 4096);
    if (text !== null) pins[name] = text.trim().slice(0, 512);
  }
  const managers = new Set<string>();
  for (const file of Object.values(paths)) for (const [pattern, manager] of MANAGER_PATH) if (pattern.test(file)) managers.add(manager);
  if (found.has("mise")) managers.add("mise");
  const key = `${JSON.stringify(paths)}|${JSON.stringify(pins)}`;
  const cacheKey = `box\0${options.root}`;
  const cached = fingerprintCache.get(cacheKey);
  let runtimes: Record<string, string>;
  let changed = true;
  if (cached && cached.key === key) {
    runtimes = cached.runtimes;
    changed = false;
  } else {
    runtimes = {};
    await Promise.all(RUNTIMES.map(async (runtime) => {
      const file = paths[runtime.name];
      if (!file) return;
      const probe = await options.run(file, runtime.args, { timeoutMs: 5_000, cwd: options.root, maxBytes: 64 * 1024 });
      const match = runtime.pattern.exec(`${probe?.stdout ?? ""}\n${probe?.stderr ?? ""}`);
      if (match) runtimes[runtime.name] = match[1]!;
    }));
    fingerprintCache.set(cacheKey, { key, runtimes });
    changed = !cached || JSON.stringify(cached.runtimes) !== JSON.stringify(runtimes);
  }
  return {
    os: "linux",
    arch: machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : machine || "unknown",
    os_version: lines[1] || null,
    runtimes,
    paths: Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, tildeText(file, options.privacy)])),
    managers: [...managers].sort(),
    pins,
    changed,
  };
}

export async function envFingerprint(options: { root: string; pathValue: string; skipDir: string | null; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; arch: string; osVersion: string | null; privacy: PrivacyContext; run: Runner; box?: Runner | null }): Promise<EnvFingerprint> {
  if (options.box) return boxEnvFingerprint({ root: options.root, privacy: options.privacy, run: options.box });
  const paths: Record<string, string> = {};
  const keyParts: string[] = [];
  for (const runtime of RUNTIMES) {
    for (const command of runtime.commands) {
      const found = await which(command, options.pathValue, options.platform, options.skipDir);
      if (!found) continue;
      let real = found;
      let stamp = "";
      try {
        real = await fs.realpath(found);
        const stat = await fs.stat(real);
        stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
      } catch {
        /* keep */
      }
      paths[runtime.name] = found;
      keyParts.push(`${runtime.name}=${real}@${stamp}`);
      break;
    }
  }
  const pins: Record<string, string> = {};
  for (const name of PIN_FILES) {
    const text = await readText(path.join(options.root, name), 4096);
    if (text !== null) pins[name] = text.trim().slice(0, 512);
  }
  keyParts.push(JSON.stringify(pins));
  const managers = new Set<string>();
  for (const [name, manager] of MANAGER_ENV) if (options.env[name]) managers.add(manager);
  for (const found of Object.values(paths)) for (const [pattern, manager] of MANAGER_PATH) if (pattern.test(found)) managers.add(manager);
  if (await which("mise", options.pathValue, options.platform, options.skipDir)) managers.add("mise");
  const key = keyParts.join("|");
  const cacheKey = `${options.root}\0${options.pathValue}`;
  const cached = fingerprintCache.get(cacheKey);
  let runtimes: Record<string, string>;
  let changed = true;
  if (cached && cached.key === key) {
    runtimes = cached.runtimes;
    changed = false;
  } else {
    runtimes = {};
    await Promise.all(RUNTIMES.map(async (runtime) => {
      const file = paths[runtime.name];
      if (!file) return;
      const result = await options.run(file, runtime.args, { timeoutMs: 5_000, cwd: options.root, env: quietEnv({ ...options.env, OMNIRUSH_PKGLOG_OFF: "1" }), maxBytes: 64 * 1024 });
      const match = runtime.pattern.exec(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
      if (match) runtimes[runtime.name] = match[1]!;
    }));
    fingerprintCache.set(cacheKey, { key, runtimes });
    changed = !cached || JSON.stringify(cached.runtimes) !== JSON.stringify(runtimes);
  }
  return {
    os: osName(options.platform),
    arch: options.arch,
    os_version: options.osVersion,
    runtimes,
    paths: Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, tildeText(file, options.privacy)])),
    managers: [...managers].sort(),
    pins,
    changed,
  };
}

// Folders whose churn is caches, package trees, app or editor state: never part of the outside manifest.
const SKIP_NAMES = new Set([
  "node_modules", "site-packages", "dist-packages", "__pycache__", ".cache", ".npm", ".pnpm-store", ".yarn", ".bun", "registry", ".rustup", "pkg", ".gradle", ".m2",
  "Library", "ms-playwright", ".git", ".venv", "venv", ".tox", ".vscode", ".vscode-server", ".cursor", ".cursor-server", "Code", "google-chrome", "chromium", "mozilla", ".mozilla",
  "Trash", "systemd", "pulse", "dconf", "omnirush", "OmniRush.ai", "opencode", "pip", "uv", "pypoetry", "go-build", "JetBrains", "Cache", "CachedData", "logs", "Temp", "snap",
  ".ssh", ".gnupg", ".aws", ".kube", ".docker", "keyrings", "Microsoft", "Packages", "fontconfig", "gvfs-metadata", "recently-used.xbel", "tracker3", "nvim", ".local/state",
]);

/** One file or symlink scanOutside found written in a turn's window. */
export type OutsideEntry = {
  /** Absolute. */
  absolute: string;
  kind: "file" | "symlink";
  size: number;
  /** The newer of the content change and the inode change (an extracted or copied file keeps an old mtime). */
  changedMs: number;
  mtimeMs: number;
};

export type OutsideScanOptions = {
  root: string;
  since: number;
  until: number;
  home: string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exclude: string[];
  /** More folders to look in (a turn's command targets), each with its depth; scanned before the temp folders. */
  extraRoots?: Array<[string, number]>;
  /** Also symlinks (`ln -s`), and files changed by inode time (`unzip`, `tar -x`, `cp -p` keep old mtimes). */
  inodeTimes?: boolean;
  maxEntries?: number;
  maxFiles?: number;
  budgetMs?: number;
};

/**
 * Files written outside the project during a turn, within a time and entry
 * budget: the home's dotfiles and config, ~/.local and ~/bin, /usr/local and
 * /opt, the temp folders (and `extraRoots`). Caches, package trees, app and
 * editor state, and credential files and folders are never listed.
 */
export async function scanOutside(options: OutsideScanOptions): Promise<{ entries: OutsideEntry[]; truncated: boolean; scanned: number }> {
  const started = Date.now();
  const maxEntries = options.maxEntries ?? 4000;
  const maxFiles = options.maxFiles ?? 200;
  const budget = options.budgetMs ?? 250;
  const home = options.home;
  const roots: Array<[string, number]> = [];
  if (home) {
    roots.push([home, 1], [path.join(home, ".config"), 3], [path.join(home, ".local", "bin"), 1], [path.join(home, "bin"), 1]);
    if (options.platform === "win32") {
      if (options.env.APPDATA) roots.push([options.env.APPDATA, 2]);
      if (options.env.LOCALAPPDATA) roots.push([path.join(options.env.LOCALAPPDATA, "Programs"), 2]);
    } else roots.push([path.join(home, ".local", "share"), 2]);
  }
  if (options.platform !== "win32") roots.push(["/usr/local/bin", 1], ["/usr/local/lib", 2], ["/opt", 2]);
  for (const extra of options.extraRoots ?? []) roots.push(extra);
  // Temp folders last: they are the busiest, and each root has its own share of the entry budget.
  const tmp = tmpdir();
  roots.push([tmp, 2]);
  if (options.platform !== "win32" && tmp !== "/tmp") roots.push(["/tmp", 2]);
  const excluded = [path.resolve(options.root), ...options.exclude.map((dir) => path.resolve(dir))];
  const isExcluded = (file: string) => excluded.some((dir) => file === dir || file.startsWith(dir + path.sep));
  const entries: OutsideEntry[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let truncated = false;
  // Each root gets its own share of the entry budget: a crowded temp folder never hides the home's config files.
  const perRoot = Math.max(200, Math.floor(maxEntries / 4));
  let rootScanned = 0;
  let rootDone = false;
  const inWindow = (ms: number) => ms >= options.since - 1_000 && ms <= options.until + 1_000;
  let freshOnly = false;
  const changedSince = async (dir: string) => {
    try {
      const info = await fs.stat(dir);
      return Math.max(info.mtimeMs, info.ctimeMs) >= options.since - 1_000;
    } catch {
      return false;
    }
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (rootDone) return;
    let listed: import("node:fs").Dirent[];
    try {
      listed = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listed) {
      scanned += 1;
      if (++rootScanned > perRoot || scanned > maxEntries || Date.now() - started > budget || entries.length >= maxFiles) {
        truncated = true;
        rootDone = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (seen.has(full) || isExcluded(full) || SKIP_NAMES.has(entry.name) || entry.name.startsWith("omnirush")) continue;
      seen.add(full);
      if (entry.isDirectory()) {
        // A busy temp folder: only folders that changed in the window are looked into (with inode times).
        if (depth > 1 && !isSecretFolder(full) && (!freshOnly || (await changedSince(full)))) await walk(full, depth - 1);
        if (rootDone) return;
        continue;
      }
      const link = entry.isSymbolicLink();
      if ((!entry.isFile() && !(link && options.inodeTimes)) || isSecretFile(full)) continue;
      let stat: import("node:fs").Stats;
      try {
        stat = link ? await fs.lstat(full) : await fs.stat(full);
      } catch {
        continue;
      }
      const changedMs = options.inodeTimes ? Math.max(stat.mtimeMs, stat.ctimeMs) : stat.mtimeMs;
      if (!inWindow(changedMs)) continue;
      entries.push({ absolute: full, kind: link ? "symlink" : "file", size: stat.size, changedMs, mtimeMs: stat.mtimeMs });
    }
  };
  const temps = new Set([path.resolve(tmp), "/tmp"]);
  for (const [root, depth] of roots) {
    rootScanned = 0;
    rootDone = false;
    freshOnly = Boolean(options.inodeTimes) && temps.has(path.resolve(root));
    await walk(root, depth);
    if (scanned > maxEntries || Date.now() - started > budget || entries.length >= maxFiles) break;
  }
  return { entries, truncated, scanned };
}

/** Files written outside the project during a turn (path, size, sha256; never content), within a time and entry budget. */
export async function outsideWrites(options: { root: string; since: number; until: number; home: string | null; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; privacy: PrivacyContext; scrub: Scrubber; exclude: string[]; maxEntries?: number; maxFiles?: number; budgetMs?: number }): Promise<{ files: EnvTurn["outside_writes"]; truncated: boolean; scanned: number }> {
  const scan = await scanOutside(options);
  const files: EnvTurn["outside_writes"] = [];
  for (const entry of scan.entries) {
    const hashed = entry.size <= 4 * 1024 * 1024 ? await sha256File(entry.absolute, 4 * 1024 * 1024) : null;
    files.push({ path: options.scrub.text(tildeText(entry.absolute, options.privacy)), size: entry.size, sha256: hashed?.sha256 || null, mtime: new Date(entry.mtimeMs).toISOString() });
  }
  return { files, truncated: scan.truncated, scanned: scan.scanned };
}

// --- the per-instance reader -------------------------------------------------------

export type InstallLogHost = {
  /** The instance's raw folder (prepareInstallLog().raw); the engine's PATH has the wrappers. */
  raw: string;
  /** The wrapper folder, left out of PATH lookups for the fingerprint. */
  bin?: string | null;
  /** The server's switch (the host caches GET /collect/capabilities). */
  gate: () => Promise<InstallLogGate>;
  /** Folders of the app itself, never part of the outside manifest. */
  appDirs?: string[];
};

/** A shell call a session's engine ran (its tool events): the window a noted call must fall in. */
export type CallWindow = { sessionId: string; callId: string | null; start: number; end: number | null; cwd: string | null; command: string | null; turn: number };

export class InstallLogReader {
  private draining: Promise<unknown> = Promise.resolve();

  constructor(private readonly raw: string) {}

  /** Complete noted calls, oldest first (folders still being written are left for later). */
  async pending(now = Date.now()): Promise<RawCall[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.raw);
    } catch {
      return [];
    }
    const out: RawCall[] = [];
    for (const name of names) {
      if (name === "on") continue;
      const call = await readRawCall(path.join(this.raw, name), now);
      if (call && (call.complete || now - call.start >= STALE_CALL_MS)) out.push(call);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Runs `work` after the previous drain (one at a time). */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.draining.then(work, work);
    this.draining = next.catch(() => undefined);
    return next;
  }

  async remove(call: RawCall): Promise<void> {
    await fs.rm(call.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The engine's shell call a noted call ran under, as the wrapper read it from its environment (OMNIRUSH_CALL; the engine's shell.env hook), or null. */
export function notedCallId(call: RawCall): string | null {
  const id = call.meta.call ?? call.hooks[0]?.meta.call;
  return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) ? id : null;
}

/**
 * Which session and shell call a noted call belongs to: the call its wrapper
 * names (OMNIRUSH_CALL: parallel calls, a sub-agent's, a background command
 * a call started), else its start inside one call window (strictly first,
 * then with slack; folder breaks ties).
 */
export function matchCall(call: RawCall, windows: CallWindow[], now = Date.now()): CallWindow | null {
  const named = notedCallId(call);
  if (named) {
    const exact = windows.find((window) => window.callId === named);
    if (exact) return exact;
  }
  const pick = (inside: CallWindow[]): CallWindow | null | undefined => {
    if (inside.length === 1) return inside[0]!;
    if (inside.length === 0) return undefined;
    const cwd = call.meta.cwd ? path.resolve(call.meta.cwd) : null;
    const byFolder = cwd ? inside.filter((window) => window.cwd && (cwd === path.resolve(window.cwd) || cwd.startsWith(path.resolve(window.cwd) + path.sep))) : [];
    if (byFolder.length === 1) return byFolder[0]!;
    const sessions = new Set(inside.map((window) => window.sessionId));
    if (sessions.size === 1) return { ...inside[0]!, callId: null };
    return null;
  };
  // The engine's own start and end of each call (the same clock): a wrapper starts inside its call.
  const strict = pick(windows.filter((window) => call.start >= window.start - 20 && call.start <= (window.end ?? now) + 20));
  if (strict !== undefined) return strict;
  // Late or early event times: the call that started last before it, within the slack.
  const near = windows.filter((window) => call.start >= window.start - 1_000 && call.start <= (window.end ?? now) + MATCH_SLACK_MS);
  if (near.length === 0) return null;
  const latest = Math.max(...near.map((window) => window.start));
  return pick(near.filter((window) => window.start === latest)) ?? null;
}

export const DEFAULT_RUNNER: Runner = runCommand;
export { homedir as installLogHome };
