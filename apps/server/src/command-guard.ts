// Which external commands capture may run without side effects on screen.
//
// macOS: /usr/bin/{git,python3,cc,clang,make,…} are Command Line Tools shims.
// When the tools are not installed, running one opens the "install the
// command line developer tools" dialog. `xcode-select -p` (which never opens
// it) is asked once per process; when it fails, a shim that resolves to
// /usr/bin is never executed and the caller records `xcode_clt_missing`
// instead. A Homebrew, pyenv or other binary outside /usr/bin is fine to run.

import { spawn } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import nodePath from "node:path";

export const XCODE_CLT_MISSING = "xcode_clt_missing";

/** /usr/bin commands that are Command Line Tools shims on macOS. */
export const CLT_SHIM_COMMANDS: ReadonlySet<string> = new Set([
  "git", "python3", "python", "pip3", "pip", "pydoc3", "cc", "c++", "gcc", "g++", "clang", "clang++", "cpp",
  "make", "gnumake", "ld", "as", "ar", "nm", "ranlib", "strip", "lipo", "otool", "libtool", "swift", "swiftc",
  "lldb", "gdb", "bison", "flex", "m4", "yacc", "lex", "svn", "dsymutil", "xcrun", "xcodebuild", "llvm-gcc",
  "llvm-g++", "gcov", "indent", "unifdef", "ctags", "mig", "rpcgen", "size", "strings", "c89", "c99",
]);

const XCODE_SELECT_TIMEOUT_MS = 2_000;

// --- command resolution ------------------------------------------------------

export type ResolveOptions = {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  pathExt?: string;
  isFile?: (path: string) => boolean;
};

function isDirectory(path: string): boolean {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // An App Execution Alias (WindowsApps) is a reparse point stat may not open; it is there all the same.
    if (process.platform !== "win32") return false;
    try {
      return !lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * The absolute path `command` runs from, searching PATH the way the shell
 * would (PATHEXT on Windows), or null when it is not installed. Relative PATH
 * entries are ignored (they would resolve against the project). On Windows a
 * `WindowsApps` folder is searched like any other: its App Execution Aliases
 * are real programs there (winget, Store Python). The Store's `python.exe`
 * stub, when no Python is installed, exits 9009 with arguments (every probe
 * passes some), so its probe is just left out.
 */
export function resolveCommand(command: string, options: ResolveOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const pathEnv = options.pathEnv ?? (platform === "win32" ? (process.env.Path ?? process.env.PATH) : process.env.PATH) ?? "";
  const isFile = options.isFile ?? defaultIsFile;
  const extensions = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext === ".exe" || ext === ".cmd" || ext === ".bat" || ext === ".com")
    : [""];
  for (const raw of pathEnv.split(platform === "win32" ? ";" : ":")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// --- the Command Line Tools guard --------------------------------------------

export type CltProbe = {
  platform?: NodeJS.Platform;
  /** Whether `xcode-select -p` succeeds; the real one runs /usr/bin/xcode-select. */
  xcodeSelect?: () => Promise<boolean>;
  /** The xcode-select binary the real check runs (/usr/bin/xcode-select). */
  xcodeSelectBin?: string;
  resolve?: (command: string) => string | null;
};

let probe: CltProbe = {};
let cltMissing: Promise<boolean> | null = null;
let gitReason: Promise<string | null> | null = null;

/** Test hook: replaces the platform, xcode-select and PATH lookup, and clears the per-process cache. */
export function configureCltProbe(next: CltProbe | null): void {
  probe = next ?? {};
  cltMissing = null;
  gitReason = null;
}

function runXcodeSelect(bin = "/usr/bin/xcode-select"): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (installed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(installed);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["-p"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolvePromise(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, XCODE_SELECT_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => finish(false));
    let printed = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (printed.length < 4096) printed += chunk.toString("utf8");
    });
    // Installed only when it succeeds AND the folder it prints exists (as the
    // engine's guard checks): a removed CLT or a stale DEVELOPER_DIR exits 0
    // with a path that is gone, and the /usr/bin shims then fail or prompt.
    child.on("close", (code) => finish(code === 0 && isDirectory(printed.trim())));
  });
}

/** Whether this is macOS without the Command Line Tools (asked once per process; false elsewhere). */
export function xcodeCltMissing(): Promise<boolean> {
  if ((probe.platform ?? process.platform) !== "darwin") return Promise.resolve(false);
  cltMissing ??= (probe.xcodeSelect ?? (() => runXcodeSelect(probe.xcodeSelectBin)))().then((installed) => !installed, () => true);
  return cltMissing;
}

/** Whether `resolvedPath` is a /usr/bin Command Line Tools shim for `command` (no check that the tools are missing). */
export function isCltShim(command: string, resolvedPath: string | null | undefined, platform: NodeJS.Platform = probe.platform ?? process.platform): boolean {
  if (platform !== "darwin" || !resolvedPath) return false;
  return resolvedPath.startsWith("/usr/bin/") && CLT_SHIM_COMMANDS.has(nodePath.posix.basename(command));
}

/**
 * `xcode_clt_missing` when running `command` (resolved on PATH unless
 * `resolvedPath` is given) would open the install dialog, else null.
 */
export async function cltSkipReason(command: string, resolvedPath?: string | null): Promise<string | null> {
  const platform = probe.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const path = resolvedPath !== undefined ? resolvedPath : (probe.resolve ?? ((name: string) => resolveCommand(name, { platform })))(command);
  if (!isCltShim(command, path, platform)) return null;
  return (await xcodeCltMissing()) ? XCODE_CLT_MISSING : null;
}

/** Why capture must not run `git` here (`xcode_clt_missing`), or null; cached per process. */
export function gitSkipReason(): Promise<string | null> {
  if ((probe.platform ?? process.platform) !== "darwin") return Promise.resolve(null);
  gitReason ??= cltSkipReason("git").catch(() => XCODE_CLT_MISSING);
  return gitReason;
}
