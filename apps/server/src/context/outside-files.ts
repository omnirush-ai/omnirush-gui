/**
 * Files a turn's commands wrote OUTSIDE the project's tracked files
 * (`context.outside_files`, one event per turn): the temp folders, the
 * home's dotfiles and config, ~/.local and ~/bin, /usr/local and /opt,
 * folders the turn's commands created or extracted into (unzip -d, tar -C,
 * git clone, mkdir), symlinks (ln -s), and gitignored output inside the
 * project (build output, generated files). A rebuild of the turn restores
 * them; the project archive does not hold them.
 *
 * Each file: its path (home as ~, scrubbed), size, sha256 and the shell call
 * whose time window it was written in; its content only when it is a small
 * text file (OUTSIDE_FILE_CONTENT_BYTES, OUTSIDE_TURN_CONTENT_BYTES in all),
 * passed through the upload's credential rules (`scrub.content`). Credential
 * files and folders (keys, .env files, netrc, cloud and package manager
 * credentials, browser and password stores) are never listed, let alone
 * read.
 *
 * Not gated by the install log: it runs whenever capture context is on,
 * unless OMNIRUSH_OUTSIDE_FILES=0. Additive: a server that does not know the
 * event keeps it as an opaque trace event.
 *
 * The same file in omnirush-cli (assets/extensions/omnirush/capture/context/)
 * and omnirush-gui (apps/server/src/context/), listed in PARITY.sha256.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUILD_OUTPUT_DIR_NAMES, DEPENDENCY_DIR_NAMES, isSecretUsePath } from "../session-archive/files-used-policy.js";
import { scanOutside, type OutsideEntry } from "./install-log.js";
import { isSecretFile, isSecretFolder, isTextBuffer, tildeText, type PrivacyContext, type Scrubber } from "./privacy.js";

export const OUTSIDE_FILES_SCHEMA = "omnirush.outside-files.v1";
/** A text file at most this big rides along whole; a bigger one is listed with its hash only. */
export const OUTSIDE_FILE_CONTENT_BYTES = 1024 * 1024;
/** Content per turn, in all, counted as it is written in the event (JSON): half the trace upload cap (16 MiB) at most. */
export const OUTSIDE_TURN_CONTENT_BYTES = 8 * 1024 * 1024;
/** Files hashed at most this big. */
const HASH_MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_PROJECT_FILES = 200;
const SCAN_BUDGET_MS = 400;
const GIT_TIMEOUT_MS = 3_000;

export type OutsideFileScope = "tmp" | "home" | "system" | "command_target" | "project_ignored";

export type OutsideFileItem = {
  /** Outside: absolute, home as `~`; project_ignored: relative to the project root, `/`-separated. */
  path: string;
  scope: OutsideFileScope;
  kind: "file" | "symlink";
  size: number;
  sha256: string | null;
  mtime: string;
  /** A symlink's target (home as `~`). */
  link_target?: string;
  /** The shell call it was written during, when exactly one matches. */
  tool_call_id?: string;
  /** The file's text (credential rules applied), for a small text file. */
  content?: string;
  /** Why the content is not here. */
  withheld?: "too_large" | "binary" | "budget" | "unreadable" | "not_attributed";
};

export type OutsideFilesEvent = {
  schema: typeof OUTSIDE_FILES_SCHEMA;
  turn: number;
  at: string;
  since: string;
  files: OutsideFileItem[];
  truncated: boolean;
  scanned: number;
  content_bytes: number;
  /** Another session's turn ran at the same time: a file may be its. */
  shared_window: boolean;
  /** Whether the host's temp, home and system folders were scanned; not for a session in the box. */
  host_scan: boolean;
  /** Why they were not: "box" (the session's commands write to the box's own filesystem, not the host's). */
  host_scan_reason?: "box";
  timings_ms: Record<string, number>;
};

/** A turn's shell call, for attributing a file to it. */
export type OutsideCallWindow = { callId: string | null; start: number | null; end: number | null };

/** OMNIRUSH_OUTSIDE_FILES=0 (false, no, off) turns the step off. */
export function outsideFilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "no", "off"].includes(String(env.OMNIRUSH_OUTSIDE_FILES ?? "").trim().toLowerCase());
}

/** Never listed, never read: a credential file or folder, a `.env` file, a name that says secret/token/password. */
export function isWithheldPath(absolute: string): boolean {
  return isSecretUsePath(absolute) || isSecretFile(absolute) || isSecretFolder(absolute);
}

function scopeOf(absolute: string, home: string | null, extraRoots: readonly string[], tmpRoots: readonly string[]): OutsideFileScope {
  const under = (dir: string) => absolute === dir || absolute.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  if (tmpRoots.some(under)) return "tmp";
  if (extraRoots.some(under)) return "command_target";
  if (home && under(home)) return "home";
  return "system";
}

/** The shell calls running when a file changed: the one (when exactly one) and whether any. */
function attribute(changedMs: number, calls: readonly OutsideCallWindow[]): { callId: string | undefined; during: boolean } {
  const within = (slack: number) => calls.filter((call) => call.start !== null && changedMs >= call.start - slack && changedMs <= (call.end ?? Number.POSITIVE_INFINITY) + slack);
  // Inside one call's own window first; quick calls one after another overlap once given slack.
  const strict = within(0);
  const loose = within(1_000);
  const one = strict.length === 1 ? strict[0] : loose.length === 1 ? loose[0] : undefined;
  return { callId: one?.callId ?? undefined, during: loose.length > 0 };
}

async function sha256Of(file: string, size: number): Promise<string | null> {
  if (size > HASH_MAX_BYTES) return null;
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

// The environment git gets here: the basics a program needs and git's own settings that carry no credential
// (no app tokens, no engine password, no other keys); the same list as the desktop's git-env.ts, kept in this
// shared file so the CLI and the desktop stay byte-identical.
const GIT_ENV_KEEP = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "TZ", "TERM",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE", "ALLUSERSPROFILE",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES",
]);

function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string" || /^(?:OMNIRUSH_|OPENCODE_SERVER_|OPENCODE_PASSWORD$)/i.test(key)) continue;
    if (GIT_ENV_KEEP.has(key.toUpperCase()) || /^(?:LC_|XDG_)/i.test(key)) out[key] = value;
  }
  return out;
}

// A listing only: no fsmonitor program from the repository's config (core.fsmonitor can name any program).
function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: gitEnvironment() }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/**
 * Gitignored files inside the project changed in the window (build output,
 * generated files), never dependency folders or caches. Through git (its
 * own ignore rules); none without a repository.
 */
export async function ignoredProjectWrites(root: string, since: number, until: number, budgetMs = SCAN_BUDGET_MS, max = MAX_PROJECT_FILES): Promise<{ entries: OutsideEntry[]; truncated: boolean; scanned: number }> {
  const started = Date.now();
  const listed = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  if (listed === null) return { entries: [], truncated: false, scanned: 0 };
  const entries: OutsideEntry[] = [];
  let scanned = 0;
  let truncated = false;
  const skipPart = (part: string) => DEPENDENCY_DIR_NAMES.has(part) || part === ".git" || part.startsWith("omnirush");
  const consider = async (absolute: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (entries.length >= max || Date.now() - started > budgetMs) {
      truncated = true;
      return;
    }
    scanned += 1;
    let info: import("node:fs").Stats;
    try {
      info = await lstat(absolute);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      if (depth <= 0 || isSecretFolder(absolute)) return;
      let names: string[];
      try {
        names = await readdir(absolute);
      } catch {
        return;
      }
      for (const name of names) {
        if (skipPart(name)) continue;
        await consider(path.join(absolute, name), depth - 1);
        if (truncated) return;
      }
      return;
    }
    if (!info.isFile() && !info.isSymbolicLink()) return;
    const changedMs = Math.max(info.mtimeMs, info.ctimeMs);
    if (changedMs < since - 1_000 || changedMs > until + 1_000) return;
    entries.push({ absolute, kind: info.isSymbolicLink() ? "symlink" : "file", size: info.size, changedMs, mtimeMs: info.mtimeMs });
  };
  for (const item of listed.split("\0")) {
    const rel = item.replace(/\/+$/, "");
    if (!rel) continue;
    const parts = rel.split("/");
    if (parts.some(skipPart)) continue;
    // An ignored folder is looked into (a build output folder deepest); an ignored file is itself.
    const depth = parts.some((part) => BUILD_OUTPUT_DIR_NAMES.has(part)) ? 8 : item.endsWith("/") ? 4 : 0;
    await consider(path.join(root, ...parts), depth);
    if (truncated) break;
  }
  return { entries, truncated, scanned };
}

export type OutsideFilesInput = {
  root: string;
  turn: number;
  since: number;
  until: number;
  home: string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  privacy: PrivacyContext;
  scrub: Scrubber;
  /** App state, install log and cache folders: never listed. */
  exclude: string[];
  /** Folders the turn's commands created or extracted into (OutsideTracker.folderPaths(), commandEffects folders). */
  commandFolders: string[];
  /** Files the turn's shell commands name as written (redirects, cp, tee, curl -o: commandEffects writes). */
  commandFiles?: string[];
  calls: readonly OutsideCallWindow[];
  sharedWindow: boolean;
  /**
   * The session's shell runs in the box: only the project (bind-mounted, same path) is the host's, so no
   * host scan and no command target outside the project (another process's files, not the session's).
   */
  box?: boolean;
  /** Tests. */
  tmpRoots?: string[];
  budgetMs?: number;
};

/** The turn's `context.outside_files` event; null when it found nothing. */
export async function outsideFilesOfTurn(input: OutsideFilesInput): Promise<OutsideFilesEvent | null> {
  const started = Date.now();
  const timings: Record<string, number> = {};
  const rootReal = path.resolve(input.root);
  const commandFolders = [...new Set(input.commandFolders.map((dir) => path.resolve(dir)))]
    .filter((dir) => dir !== rootReal && !dir.startsWith(rootReal + path.sep) && !isWithheldPath(dir))
    .slice(0, 16);
  const outside = input.box ? { entries: [] as OutsideEntry[], truncated: false, scanned: 0 } : await scanOutside({
    root: input.root,
    since: input.since,
    until: input.until,
    home: input.home,
    platform: input.platform,
    env: input.env,
    exclude: input.exclude,
    extraRoots: commandFolders.map((dir) => [dir, 4] as [string, number]),
    inodeTimes: true,
    maxFiles: MAX_FILES,
    budgetMs: input.budgetMs ?? SCAN_BUDGET_MS,
  });
  timings.outside = Date.now() - started;
  let at = Date.now();
  const ignored = await ignoredProjectWrites(input.root, input.since, input.until, input.budgetMs ?? SCAN_BUDGET_MS);
  timings.project_ignored = Date.now() - at;
  at = Date.now();
  const tmpRoots = input.tmpRoots ?? [...new Set([path.resolve(tmpdir()), ...(input.platform === "win32" ? [] : ["/tmp"])])];
  // The files the commands named as written: found even where a busy folder's scan ran out of budget.
  const scanned = new Set(outside.entries.map((entry) => entry.absolute));
  const excluded = input.exclude.map((dir) => path.resolve(dir));
  for (const file of [...new Set((input.box ? [] : input.commandFiles ?? []).map((item) => path.resolve(item)))].slice(0, MAX_FILES)) {
    if (scanned.has(file) || file === rootReal || file.startsWith(rootReal + path.sep) || excluded.some((dir) => file === dir || file.startsWith(dir + path.sep))) continue;
    const info = await lstat(file).catch(() => null);
    if (!info || (!info.isFile() && !info.isSymbolicLink())) continue;
    const changedMs = Math.max(info.mtimeMs, info.ctimeMs);
    if (changedMs < input.since - 1_000 || changedMs > input.until + 1_000) continue;
    outside.entries.push({ absolute: file, kind: info.isSymbolicLink() ? "symlink" : "file", size: info.size, changedMs, mtimeMs: info.mtimeMs });
    scanned.add(file);
  }
  const files: OutsideFileItem[] = [];
  let contentBytes = 0;
  let encodedBytes = 0;
  const describe = async (entry: OutsideEntry, scope: OutsideFileScope, shownPath: string): Promise<void> => {
    if (isWithheldPath(entry.absolute)) return;
    const item: OutsideFileItem = { path: shownPath, scope, kind: entry.kind, size: entry.size, sha256: null, mtime: new Date(entry.mtimeMs).toISOString() };
    const { callId, during } = attribute(entry.changedMs, input.calls);
    if (callId) item.tool_call_id = callId;
    if (entry.kind === "symlink") {
      const target = await readlink(entry.absolute).catch(() => null);
      if (target !== null) item.link_target = input.scrub.text(tildeText(target, input.privacy));
      files.push(item);
      return;
    }
    item.sha256 = await sha256Of(entry.absolute, entry.size);
    // Content only for what the agent's own commands wrote: a file in the home or the temp folders that
    // changed while no shell call of the turn ran is another program's (an editor, a browser), listed only.
    const agents = during || scope === "command_target" || scope === "project_ignored";
    if (!agents) item.withheld = "not_attributed";
    else if (entry.size > OUTSIDE_FILE_CONTENT_BYTES) item.withheld = "too_large";
    else if (encodedBytes + entry.size > OUTSIDE_TURN_CONTENT_BYTES) item.withheld = "budget";
    else {
      const bytes = await readFile(entry.absolute).catch(() => null);
      if (!bytes) item.withheld = "unreadable";
      else if (!isTextBuffer(bytes)) item.withheld = "binary";
      else {
        const text = tildeText(input.scrub.content(entry.absolute, bytes.toString("utf8")), input.privacy);
        const encoded = Buffer.byteLength(JSON.stringify(text), "utf8");
        if (encodedBytes + encoded > OUTSIDE_TURN_CONTENT_BYTES) item.withheld = "budget";
        else {
          item.content = text;
          contentBytes += Buffer.byteLength(text, "utf8");
          encodedBytes += encoded;
        }
      }
    }
    files.push(item);
  };
  for (const entry of outside.entries) {
    await describe(entry, scopeOf(entry.absolute, input.home, commandFolders, tmpRoots), input.scrub.text(tildeText(entry.absolute, input.privacy)));
  }
  for (const entry of ignored.entries) {
    const rel = path.relative(rootReal, entry.absolute).split(path.sep).join("/");
    await describe(entry, "project_ignored", input.scrub.text(rel));
  }
  timings.read = Date.now() - at;
  if (files.length === 0) return null;
  return {
    schema: OUTSIDE_FILES_SCHEMA,
    turn: input.turn,
    at: new Date(input.until).toISOString(),
    since: new Date(input.since).toISOString(),
    files,
    truncated: outside.truncated || ignored.truncated,
    scanned: outside.scanned + ignored.scanned,
    content_bytes: contentBytes,
    shared_window: input.sharedWindow,
    host_scan: !input.box,
    ...(input.box ? { host_scan_reason: "box" as const } : {}),
    timings_ms: timings,
  };
}
