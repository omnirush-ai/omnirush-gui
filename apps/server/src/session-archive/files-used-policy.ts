/**
 * Files used (backend spec 19.7, `policy.files_used`): each turn's state
 * document lists every file the agent's own tool calls used, and the chain
 * carries the bytes of the allowed ones, so a replay can stage what the
 * start snapshot lacks.
 *
 *   files_used: [{ path, scope, op, size, sha256, captured, reason, call_id? }]
 *
 * `path` is relative to the session folder for `scope: "project"`, else
 * absolute; `scope` is `project`, `tmp`, `home` or `outside`; `op` is the
 * strongest use seen (`write` > `exec` > `read`); `size` and `sha256` are
 * the file's when the turn ended (or when its copy was kept), null when it
 * was gone or, for `sha256`, over the per-file cap. `captured` says whether
 * the chain holds the bytes after this state; `reason` is `captured`, or
 * why not: `dependency_dir` (node_modules, .venv, vendor, package caches:
 * rebuilt from the state's `dependencies`), `build_output` (dist, build,
 * target, ...), `denylisted` (credentials, keys, .env, tokens, system
 * files, the app's own state), `not_allowlisted` (home files outside the
 * config allowlist), `too_large` (over the per-file or the session cap:
 * hash only) or `missing` (gone before it could be read).
 *
 * The sources are the agent's own actions only (no interception of what
 * other programs open): the paths of its file tools, the files its shell
 * commands name (files-used-shell.ts), and, at the end of each tool call,
 * the temp files those calls named or created in a temp folder they named.
 * Temp files and allowlisted home config are copied into a per-session
 * store when the call ends (a screenshot deleted later is kept), home
 * config scrubbed first; project and outside files are archived by the
 * chain's own scan. Any other home file is listed only (`not_allowlisted`).
 * The server's `policy.files_used` decides; there is no client override and
 * no per-user switch.
 *
 * This module is the pure part: the item shape, the reasons, the caps, where a
 * file is and what may happen to its bytes, the home config allowlist and
 * its line filters. No I/O and no uploader imports (the caller runs its own
 * secret scrubber over a scrubbed home config). Identical, byte for byte,
 * in the CLI (capture/session-archive/) and the desktop app
 * (apps/server/src/session-archive/).
 */
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

import { scrubGitConfig } from "./git-scrub.js";
import { isSecretFile, isSecretFolder } from "../context/privacy.js";

export type FilesUsedScope = "project" | "tmp" | "home" | "outside";
export type FilesUsedOp = "read" | "write" | "exec";
export type FilesUsedReason = "captured" | "dependency_dir" | "build_output" | "denylisted" | "not_allowlisted" | "too_large" | "missing";

/** One `files_used` item of a state document. */
export type FilesUsedItem = {
  path: string;
  scope: FilesUsedScope;
  op: FilesUsedOp;
  size: number | null;
  sha256: string | null;
  captured: boolean;
  reason: FilesUsedReason;
  /** The tool call that first used the file, when known. */
  call_id?: string;
};

/**
 * A use the tracker recorded, before the archive decides `captured`:
 * `plan` says how the bytes reach the chain (its own scan, a staged copy)
 * or why they never do.
 */
export type PendingUse = Omit<FilesUsedItem, "captured" | "reason"> & {
  plan: "scan" | "staged" | "hold";
  reason: FilesUsedReason;
  /** Where the chain holds the bytes (`__outside__/...` for a file outside the session folder). */
  archive_path?: string;
  /** The turn whose state lists it. */
  turn?: number;
};

export const FILES_USED_REASONS: readonly FilesUsedReason[] = ["captured", "dependency_dir", "build_output", "denylisted", "not_allowlisted", "too_large", "missing"];
/** A used file larger than this is listed with its size only (no copy, no hash). */
export const MAX_FILES_USED_FILE_BYTES = 64 * 1024 * 1024;
/** What staged copies may add to one session's chain; past it a file is `too_large`. */
export const MAX_FILES_USED_SESSION_BYTES = 256 * 1024 * 1024;
export type FilesUsedLimits = { maxFileBytes: number; maxSessionBytes: number };
export const DEFAULT_FILES_USED_LIMITS: FilesUsedLimits = { maxFileBytes: MAX_FILES_USED_FILE_BYTES, maxSessionBytes: MAX_FILES_USED_SESSION_BYTES };
/** Items per state document, and allowlisted home config read for scrubbing, at most. */
export const MAX_FILES_USED_ITEMS = 2_000;
export const MAX_HOME_CONFIG_BYTES = 256 * 1024;

const OP_RANK: Record<FilesUsedOp, number> = { write: 3, exec: 2, read: 1 };
export function strongerOp(left: FilesUsedOp, right: FilesUsedOp): FilesUsedOp {
  return OP_RANK[right] > OP_RANK[left] ? right : left;
}

// --- where a file is, and whether its bytes may be archived ------------------------------

/** Dependency and cache folders (any path component): hash only, rebuilt from the lockfiles. */
export const DEPENDENCY_DIR_NAMES = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".turbo", ".parcel-cache",
  ".cache", ".gradle", ".dart_tool", "Pods", "vendor", "bower_components", "site-packages", "dist-packages", ".pnpm-store", ".yarn",
]);
/** Build output folders (any path component): hash only. */
export const BUILD_OUTPUT_DIR_NAMES = new Set(["dist", "build", "target", "out", ".next", ".nuxt", ".svelte-kit", "DerivedData"]);

const PSEUDO = /^\/(?:proc|sys|dev|run)(?:\/|$)|^\/private\/var\/run(?:\/|$)|^\/System\/Volumes(?:\/|$)/;
const SYSTEM = /^\/(?:usr|etc|bin|sbin|lib|lib32|lib64|libx32|boot|snap|opt\/homebrew\/Cellar|var\/lib|var\/cache|var\/log|nix\/store|System|Library|Applications|private\/etc|private\/var\/db)(?:\/|$)/;
const WINDOWS_SYSTEM = /^[A-Za-z]:[\\/](?:Windows|Program Files|Program Files \(x86\)|ProgramData)(?:[\\/]|$)/i;
/** Under the home: caches, package stores and other apps' state (never archived; rebuilt or irrelevant). */
const HOME_CACHE_DIRS = [
  ".cache", ".npm", ".pnpm-store", ".yarn", ".bun/install", ".cargo/registry", ".cargo/git", ".rustup", ".gradle", ".m2", ".nuget",
  ".local/share/pnpm", ".local/share/opencode", ".local/state/opencode", ".config/opencode", ".omnirush", ".pi", ".config/omnirush",
  ".config/OmniRush", "Library/Application Support/OmniRush", "AppData/Roaming/OmniRush", "Library/Caches",
  "AppData/Local/npm-cache", "go/pkg/mod", ".pyenv/versions", ".nvm/versions", ".volta/tools", ".local/lib", ".local/pipx", ".conda/pkgs",
  "miniconda3/pkgs", "anaconda3/pkgs", ".vscode-server", ".vscode", ".cursor", ".codex", ".claude", ".agents", ".local/share/Trash",
];
/** Under the home: never read, whatever the allowlist says (credential stores, keychains, browser profiles). */
const HOME_SECRET_DIRS = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gh", ".config/gcloud", ".config/hub", ".password-store",
  ".local/share/keyrings", "Library/Keychains", "Library/Cookies", "Library/Application Support/Google", "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware", "Library/Safari", ".mozilla", ".config/google-chrome", ".config/chromium",
  "AppData/Roaming/Microsoft/Credentials", "AppData/Local/Microsoft/Credentials", "AppData/Local/Google", "AppData/Roaming/Mozilla",
];

export type HomeConfigKind = "git" | "npmrc" | "ini" | "text";

/**
 * Home config files whose scrubbed copy is archived when a tool or program
 * read them (scope P5): git's, the package managers' (registry lines only),
 * pip/uv index settings (no userinfo) and the config of known dev tools.
 * Shell rc files are not here: the session context records their aliases.
 */
export function homeConfigKind(homeRel: string): HomeConfigKind | null {
  const rel = homeRel.replaceAll("\\", "/");
  if ([".gitconfig", ".config/git/config"].includes(rel)) return "git";
  if ([".gitignore_global", ".gitignore", ".config/git/ignore", ".config/git/attributes", ".gitattributes"].includes(rel)) return "text";
  // .npmrc and .pypirc are credential files (the backend holds them back from every export): never allowlisted.
  if ([".yarnrc", ".yarnrc.yml", ".config/pnpm/rc", "Library/Preferences/pnpm/rc", "AppData/Local/pnpm/config/rc", ".bunfig.toml"].includes(rel)) return "npmrc";
  if ([".config/pip/pip.conf", ".pip/pip.conf", "pip/pip.ini", "AppData/Roaming/pip/pip.ini", "Library/Application Support/pip/pip.conf", ".config/uv/uv.toml", ".pydistutils.cfg", ".condarc", ".cargo/config.toml", ".cargo/config", ".m2/settings.xml"].includes(rel)) return "ini";
  if ([".editorconfig", ".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.yml", ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.yml", ".pylintrc", ".flake8", ".pycodestyle", ".isort.cfg", ".tool-versions", ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".mypy.ini", ".clang-format", ".rustfmt.toml", ".jshintrc", ".babelrc", ".browserslistrc"].includes(rel)) return "text";
  if (/^\.config\/(?:ruff|black|pnpm|starship|mise|rtx|yamllint|flake8|pycodestyle|pylintrc|mypy|direnv|bat|fd|ripgrep|jj|lazygit|helix|nvim|zellij|tmux|alacritty|kitty|wezterm|yarn|prettier|eslint|stylua|taplo|rustfmt|clangd|pre-commit|uv|pip|git)(?:\/[^/]+)*\/[^/]+$/.test(rel) && !/(?:^|\/)(?:hosts\.ya?ml|credentials?.*|auth.*|token.*|.*\.(?:key|pem|db|sqlite))$/i.test(rel)) return "text";
  if (/^\.config\/(?:starship|ruff|black|uv|mise)\.toml$/.test(rel)) return "text";
  return null;
}

export type UseContext = {
  /** The app's credential rule for a path relative to its folder (the uploader's denylist); the policy's own rules apply too. */
  isCredentialPath?: (relPath: string) => boolean;
  /** The session folder, as given and as its real path. */
  roots: readonly string[];
  home: string | null;
  /** Temp folders, as given and as real paths. */
  temps: readonly string[];
  /** App state folders: never listed. */
  appDirs: readonly string[];
  includeCredentialFiles?: boolean;
};

function within(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function inside(parent: string, child: string): boolean {
  return resolve(parent) === resolve(child) || within(parent, child) !== null;
}

/** Whether `path` lies below `dir` (not `dir` itself), in the style `dir` is written in: a drive path the Windows way (either slash, any case). */
export function belowDir(dir: string, path: string): boolean {
  const style = /^[A-Za-z]:[\\/]/.test(dir) ? win32 : posix;
  const rel = style.relative(dir, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${style.sep}`) && !style.isAbsolute(rel);
}

const ENV_FILE = /(?:^|\/)\.env(?:\.|$)|(?:^|\/)[^/]*\.env$/i;
const SECRET_WORD = /(?:^|[/._-])(?:secrets?|credentials?|tokens?|passwords?|passwd|private[_-]?key|api[_-]?keys?)(?:[/._-]|$)/i;

/** Whether a path names a file that must never be archived (anywhere). */
export function isSecretUsePath(absolute: string): boolean {
  const portable = absolute.replaceAll("\\", "/");
  if (ENV_FILE.test(portable)) return !/\.env\.(?:example|sample|template|dist|defaults?)$/i.test(portable);
  if (isSecretFile(portable) || isSecretFolder(portable)) return true;
  return SECRET_WORD.test(portable.split("/").at(-1) ?? "");
}

export type UseClass = {
  scope: FilesUsedScope;
  /** The item's path: project-relative, else absolute. */
  path: string;
  /** How the bytes reach the chain, or why they never do. */
  plan: "scan" | "stage" | "hold";
  reason: FilesUsedReason;
  /** For a staged home config: how its copy is scrubbed. */
  scrub?: HomeConfigKind;
  archivePath?: string;
};

/** Why a folder's files are rebuilt rather than archived: a dependency or cache folder, or build output. */
export function regenerableReason(portableRel: string): "dependency_dir" | "build_output" | null {
  const parts = portableRel.split("/").slice(0, -1);
  if (parts.some((part) => part === ".git")) return null;
  if (parts.some((part) => DEPENDENCY_DIR_NAMES.has(part))) return "dependency_dir";
  if (parts.some((part) => BUILD_OUTPUT_DIR_NAMES.has(part))) return "build_output";
  return null;
}

/** `/tmp/x` -> `__outside__/tmp/x`, `C:\\x\\y` -> `__outside__/C/x/y` (outside.ts outsideArchivePath); null when it cannot be one. */
export function usedArchivePath(absolute: string, win32 = sep === "\\"): string | null {
  if (!absolute || absolute.length > 4_096 || absolute.includes("\0")) return null;
  let parts: string[];
  if (win32) {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
    if (!match) return null;
    parts = [match[1]!.toUpperCase(), ...match[2]!.split(/[\\/]/)];
  } else {
    if (!absolute.startsWith("/")) return null;
    parts = absolute.slice(1).split("/");
  }
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return `__outside__/${parts.join("/")}`;
}

/**
 * Where an absolute (canonical) path is and what may happen to its bytes;
 * null for a path that is never listed (the app's own state, pseudo file
 * systems, a relative path).
 */
export function classifyUse(absolute: string, context: UseContext): UseClass | null {
  if (!isAbsolute(absolute)) return null;
  const portable = absolute.replaceAll("\\", "/");
  if (PSEUDO.test(portable)) return null;
  if (context.appDirs.some((dir) => inside(dir, absolute))) return null;
  const credentials = context.includeCredentialFiles !== true;
  for (const root of context.roots) {
    const rel = within(root, absolute);
    if (rel === null) continue;
    if (credentials && (isSecretUsePath(absolute) || context.isCredentialPath?.(rel) === true)) return { scope: "project", path: rel, plan: "hold", reason: "denylisted" };
    const regenerable = regenerableReason(rel);
    if (regenerable) return { scope: "project", path: rel, plan: "hold", reason: regenerable };
    return { scope: "project", path: rel, plan: "scan", reason: "captured" };
  }
  const archivePath = usedArchivePath(absolute) ?? undefined;
  const outsideRel = portable.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
  const secret = credentials && (isSecretUsePath(absolute) || context.isCredentialPath?.(outsideRel) === true);
  const hold = (scope: FilesUsedScope, reason: FilesUsedReason): UseClass => ({ scope, path: absolute, plan: "hold", reason });
  const homeRel = context.home ? within(context.home, absolute) : null;
  // The Windows temp folder under the home is a temp folder too, whatever spelling of it `temps` has (an 8.3 short name).
  if (context.temps.some((temp) => within(temp, absolute) !== null) || (homeRel !== null && /^AppData\/Local\/Temp\//i.test(homeRel))) {
    if (secret) return hold("tmp", "denylisted");
    const regenerable = regenerableReason(outsideRel);
    if (regenerable) return hold("tmp", regenerable);
    return archivePath ? { scope: "tmp", path: absolute, plan: "stage", reason: "captured", archivePath } : hold("tmp", "denylisted");
  }
  if (homeRel !== null) {
    if (HOME_SECRET_DIRS.some((dir) => homeRel === dir || homeRel.startsWith(`${dir}/`))) return hold("home", "denylisted");
    const kind = homeConfigKind(homeRel);
    // An allowlisted config is scrubbed before it is staged, so a name the secret checks would hold does not hold it.
    if (kind && archivePath) return { scope: "home", path: absolute, plan: "stage", reason: "captured", scrub: kind, archivePath };
    if (secret) return hold("home", "denylisted");
    if (HOME_CACHE_DIRS.some((dir) => homeRel === dir || homeRel.startsWith(`${dir}/`))) return hold("home", "dependency_dir");
    const regenerable = regenerableReason(homeRel);
    if (regenerable) return hold("home", regenerable);
    // Every other home file (settings and app data, but also ~/Downloads, ~/Documents, other projects) is
    // listed only: home bytes reach the chain through the config allowlist alone.
    return hold("home", "not_allowlisted");
  }
  if (secret) return hold("outside", "denylisted");
  if ((sep === "/" && SYSTEM.test(portable)) || WINDOWS_SYSTEM.test(absolute)) return hold("outside", "denylisted");
  const regenerable = regenerableReason(outsideRel);
  if (regenerable) return hold("outside", regenerable);
  return archivePath ? { scope: "outside", path: absolute, plan: "scan", reason: "captured", archivePath } : hold("outside", "denylisted");
}

// --- scrubbing an allowlisted home config -----------------------------------------------

const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@"']+@/gi;
const NPM_SECRET_LINE = /^\s*(?:\/\/|["']?\/\/)|(?:^|[\s.:@"'])(?:_auth|_authtoken|_authToken|_password|password|token|username|email|certfile|keyfile|cert|key|npmAuthToken|npmAuthIdent|npmAlwaysAuth|always-auth|otp)["']?\s*[=:]/i;
const INI_SECRET_KEY = /^\s*["']?[A-Za-z0-9_.@:/-]*(?:password|passwd|token|secret|auth|credential|username|user|cert|key|cookie|private)[A-Za-z0-9_.-]*["']?\s*[=:]/i;
const XML_SECRET = /<\s*(?:password|username|privateKey|passphrase|token)\b[^>]*>[^<]*<\s*\/\s*(?:password|username|privateKey|passphrase|token)\s*>/gi;

/**
 * An allowlisted home config as archived: git's with its credentials,
 * extraheaders and URL userinfo removed (git-scrub.ts); npm/yarn/pnpm rc
 * keeping no auth, scope-auth (`//host/:`), user or cert line; ini/toml
 * keeping no secret-named key; every URL without userinfo. The caller
 * runs its own secret scrubber over the result. Null for text that is too
 * large or not text: the file is held.
 */
export function scrubHomeConfig(kind: HomeConfigKind, text: string): string | null {
  if (text.length > MAX_HOME_CONFIG_BYTES || text.includes("\0") || text.includes("\uFFFD")) return null;
  if (kind === "git") text = scrubGitConfig(text).text;
  else if (kind === "npmrc") text = text.split("\n").map((line) => (NPM_SECRET_LINE.test(line) ? "# [omnirush: removed]" : line)).join("\n");
  else if (kind === "ini") text = text.split("\n").map((line) => (INI_SECRET_KEY.test(line) ? "# [omnirush: removed]" : line)).join("\n").replace(XML_SECRET, "<!-- [omnirush: removed] -->");
  return text.replace(URL_USERINFO, "$1");
}

/**
 * The state document's `files_used` for the pending items of an archive:
 * `captured` from what the chain holds after it (`held`: the archive paths
 * of every file the chain holds). A file the chain was to hold but does not
 * is `missing` when it was gone, else `too_large` (the scan's caps).
 */
export function finalizeFilesUsed(pending: readonly PendingUse[], held: ReadonlySet<string>): FilesUsedItem[] {
  const out: FilesUsedItem[] = [];
  for (const item of pending) {
    const { plan, archive_path: archivePath, turn: _turn, reason: planned, ...rest } = item;
    const where = archivePath ?? (item.scope === "project" ? item.path : usedArchivePath(item.path) ?? undefined);
    let captured = false;
    let reason: FilesUsedReason = planned;
    if (plan !== "hold") {
      captured = where !== undefined && held.has(where);
      reason = captured ? "captured" : item.size === null ? "missing" : planned === "captured" ? "too_large" : planned;
    }
    out.push({ ...rest, captured, reason });
  }
  return out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
