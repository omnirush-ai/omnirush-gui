// Ported from the CLI (omnirush-cli src/box/common.js,
// feat/local-box-backends); keep the two in step. Desktop differences, each
// marked "Desktop:": types; the helpers' folder is the desktop's sidecars
// (setToolsRoot) and there is no checkout box/bin fallback beyond
// OMNIRUSH_BOX_BIN_DIR (helperPath is null when missing); the shell link
// lives in <home>/shell-desktop (the CLI's own is <home>/shell); a
// container-name prefix override for test rigs (OMNIRUSH_BOX_CONTAINER_PREFIX).
//
// Shared by the box and its backends: where things are, the helper
// binaries, the box record, small file helpers.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { RuntimeInfo } from "./runtime.js";

type Env = NodeJS.ProcessEnv;
export type BoxLog = (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;

export const RECORD_SCHEMA = 2;
export const LABEL = "ai.omnirush.box";
export const BOX_PORT = 7777;
export const RUN_DIR = "/run/omnirush";
export const SHIMS_DIR = "/opt/omnirush/pkglog";
export const HOME_IN_BOX = "/root";
/** One snapshot tar past this is cut (system paths first, then dependency folders). */
export const TAR_MAX_BYTES = 256 * 1024 * 1024;
/** A single file past this is left out of a snapshot (listed with its size). */
export const FILE_MAX_BYTES = 128 * 1024 * 1024;
/** Project dependency folders (node_modules, .venv) go into a turn's snapshot up to this. */
export const DEPS_MAX_BYTES = 128 * 1024 * 1024;

/** What runs a box: a probed backend (runtime.ts RuntimeInfo), or the parts of one a caller has. */
export type BoxRuntime = Pick<RuntimeInfo, "name" | "bin"> & Partial<Omit<RuntimeInfo, "ok" | "name" | "bin">>;

/**
 * The install log (phase 1, context/install-log.ts boxInstallLogPaths), all on this machine: `tools` the wrappers'
 * and the pip hook's parent (read-only in a box), `raw` the folder the wrappers note calls in (writable), `bin`/`py`
 * the wrappers and the hook, `root` all of pkglog/ (what a box made before the read-only layout mounted read-write)
 * and `legacy` the copies such a box keeps there.
 */
export type BoxInstallLog = { root: string; tools: string; raw: string; bin: string; py: string; legacy?: { bin: string; py: string } };

// --- where things are ------------------------------------------------------

export function boxHome(env: Env = process.env, home = os.homedir()): string {
  return path.resolve(String(env.OMNIRUSH_BOX_HOME || "").trim() || path.join(home, ".omnirush", "box"));
}

/** The canonical form of a project folder (the box key hashes it). */
export function canonicalRoot(root: string, { platform = process.platform, realpath = realpathSync.native }: { platform?: NodeJS.Platform; realpath?: (file: string) => string } = {}): string {
  let resolved = path.resolve(root);
  try { resolved = realpath(resolved); } catch { /* keep */ }
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function boxKey(root: string, opts: { platform?: NodeJS.Platform; realpath?: (file: string) => string } = {}): string {
  return createHash("sha256").update(canonicalRoot(root, opts)).digest("hex").slice(0, 12);
}

/** Desktop: OMNIRUSH_BOX_CONTAINER_PREFIX renames the containers (test rigs on shared machines). */
export function containerName(key: string, env: Env = process.env): string {
  const prefix = String(env.OMNIRUSH_BOX_CONTAINER_PREFIX || "").trim();
  return `${/^[a-z0-9][a-z0-9_.-]*$/.test(prefix) ? prefix : "omnirush-box-"}${key}`;
}

/** Where the project folder is inside: the same path; on Windows C:\x\y -> /c/x/y. */
export function containerRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return root;
  const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(root);
  if (!match) return `/w/${root.replace(/[\\]+/g, "/").replace(/^\/+/, "")}`;
  return `/${match[1]!.toLowerCase()}/${match[2]!.replace(/[\\]+/g, "/")}`.replace(/\/+$/, "") || "/";
}

/**
 * The install log's folders a box gets, each at its own path inside (Windows: /c/...): the wrappers and the pip
 * hook read-only (the same files go first on this machine's engine PATH: nothing in a box may change them), and
 * the raw folder the wrappers note calls in, the only one a box writes.
 */
export function pkglogBinds(pkglog: Pick<BoxInstallLog, "tools" | "raw">, platform: NodeJS.Platform = process.platform): Array<{ source: string; target: string; readonly: boolean }> {
  return [
    { source: pkglog.tools, target: containerRoot(pkglog.tools, platform), readonly: true },
    { source: pkglog.raw, target: containerRoot(pkglog.raw, platform), readonly: false },
  ];
}

/** Where pkglogBinds() puts them inside, for a box's `mounts` list. */
export function pkglogMountPoints(pkglog: Pick<BoxInstallLog, "tools" | "raw">, platform: NodeJS.Platform = process.platform): string[] {
  return pkglogBinds(pkglog, platform).map((bind) => bind.target);
}

/** A container label: the install log's layout a box was made with (2: wrappers read-only). */
export const PKGLOG_LAYOUT_LABEL = `${LABEL}.pkglog`;
export const PKGLOG_LAYOUT = "2";

/**
 * Which install log a box can use, from the folders it was started with: "ro" (read-only wrappers, pkglogBinds),
 * "legacy" (a box made before: all of `pkglog.root` read-write, so it gets its own copies there, which this machine
 * never runs) or null (none).
 */
export function installLogLayout(mounts: unknown, pkglog: BoxInstallLog, platform: NodeJS.Platform = process.platform): "ro" | "legacy" | null {
  const list = Array.isArray(mounts) ? mounts : [];
  if (pkglogMountPoints(pkglog, platform).every((target) => list.includes(target))) return "ro";
  if (pkglog.root && list.includes(containerRoot(pkglog.root, platform))) return "legacy";
  return null;
}

export function recordFile(home: string, key: string): string {
  return path.join(home, "boxes", `${key}.json`);
}

export function runDir(home: string, key: string): string {
  return path.join(home, "projects", key);
}

export function writeJson(file: string, value: unknown, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, file);
}

export function readJson<T = Record<string, unknown>>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** The record boxsh reads (boxes/<key>.json). `runtime` is empty when the backend has no exec fallback. */
export type BoxRecord = {
  v: 1; key: string; root: string; croot: string; container: string; backend: string; runtime: string; runtime_args: string[];
  host: string; port: number; token: string; state: string; error: string; uid: number; gid: number;
  home: string; shell: string; path_prefix: string; env_file: string; updated: number; pid: number;
  /** The app restarts boxd when boxsh asks (boxes/<key>.revive). */
  revive?: boolean;
  /** The agent's box notice adds this line (plugin-lib.ts BOX_NOTE): the box's own build folders (macOS/Windows hosts). */
  shadows_note?: string;
};

export function readRecord(home: string, key: string): BoxRecord | null {
  return readJson<BoxRecord>(recordFile(home, key));
}

// --- helper binaries ---------------------------------------------------------

export const GOOS: Partial<Record<string, string>> = { linux: "linux", darwin: "darwin", win32: "windows" };
export const GOARCH: Partial<Record<string, string>> = { x64: "amd64", arm64: "arm64", amd64: "amd64", aarch64: "arm64" };

/**
 * Folders holding the helpers, best first: OMNIRUSH_BOX_BIN_DIR, then the
 * desktop's sidecars folder's box/ (setToolsRoot). Each has
 * <goos>-<goarch>/boxsh, linux-<arch>/boxd and linux-<arch>/boxrun.
 */
export function helperDirs({ env = process.env, toolsRoot = null }: { env?: Env; toolsRoot?: string | null } = {}): string[] {
  const asked = String(env.OMNIRUSH_BOX_BIN_DIR || "").trim();
  return [...(asked ? [asked] : []), ...(toolsRoot ? [path.join(toolsRoot, "box")] : [])];
}

// Desktop: the sidecars folder (the engine binary's folder), set by the server at start.
let platformTools: string | null = null;
export function setToolsRoot(dir: string | null | undefined): void {
  platformTools = dir || null;
}

/**
 * The sidecars folder the helpers ship in: the folder of the 1.x engine when
 * one still ships, else of the 2.x engine (OMNIRUSH_OPENCODE2_BIN, set by the
 * desktop on every OS). Null when neither is known.
 */
export function engineToolsRoot(opencodeBin: string | null | undefined, env: Env = process.env): string | null {
  const bin = [opencodeBin, env.OMNIRUSH_OPENCODE_BIN, env.OMNIRUSH_OPENCODE2_BIN].map((value) => String(value ?? "").trim()).find(Boolean);
  return bin ? path.dirname(bin) : null;
}

/** The sidecars folder set at start (null: none; tests, a dev server). */
export function toolsRoot(): string | null {
  return platformTools;
}

/** The helper's file, or null when no folder has it (the box is then unavailable). */
export function helperPath(name: string, { goos, goarch, env = process.env, toolsRoot = platformTools }: { goos: string | undefined; goarch: string | undefined; env?: Env; toolsRoot?: string | null }): string | null {
  if (!goos || !goarch) return null;
  const ext = goos === "windows" && name === "boxsh" ? ".exe" : "";
  const rel = path.join(`${goos}-${goarch}`, name + ext);
  return helperDirs({ env, toolsRoot }).map((dir) => path.join(dir, rel)).find((file) => existsSync(file)) ?? null;
}

/**
 * The shell file the engine is given: a link (Windows: a copy) named `bash`
 * to boxsh, so the engine describes its shell tool as bash.
 */
export function installShell(home: string, { platform = process.platform, arch = process.arch, env = process.env }: { platform?: NodeJS.Platform; arch?: string; env?: Env } = {}): string {
  const source = helperPath("boxsh", { goos: GOOS[platform], goarch: GOARCH[arch], env });
  if (!source) throw new Error(`the sandbox shell helper is missing (${GOOS[platform] ?? platform}-${GOARCH[arch] ?? arch}/boxsh)`);
  const dir = shellDir(home);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, platform === "win32" ? "bash.exe" : "bash");
  if (platform === "win32") {
    let same = false;
    try { same = statSync(target).size === statSync(source).size && statSync(target).mtimeMs >= statSync(source).mtimeMs; } catch { /* missing */ }
    if (!same) {
      const tmp = `${target}.${process.pid}.tmp`;
      copyFileSync(source, tmp);
      try { renameSync(tmp, target); } catch { rmSync(tmp, { force: true }); }
    }
    return target;
  }
  let current: string | null = null;
  try { current = lstatSync(target).isSymbolicLink() ? path.resolve(dir, readlinkSync(target)) : null; } catch { /* missing */ }
  if (current !== source) {
    const tmp = `${target}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    symlinkSync(source, tmp);
    renameSync(tmp, target);
  }
  return target;
}

/** Desktop: the shell link's folder (the CLI's is <home>/shell). */
export function shellDir(home: string): string {
  return path.join(home, "shell-desktop");
}

export function firstLine(text: unknown): string {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? "";
}

/** A Windows path as a WSL engine mounts it: C:\x\y -> /mnt/c/x/y. */
export function wslPath(p: string): string {
  const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(String(p));
  if (!match) return String(p).replace(/\\/g, "/");
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`.replace(/\/+$/, "");
}

/** A free TCP port on this machine's loopback (for a runtime that needs one named). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A token for a new box's boxd. */
export function newToken(): string {
  return randomBytes(24).toString("hex");
}
