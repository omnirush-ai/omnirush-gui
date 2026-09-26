/**
 * Gitignored content is never archived (README "Gitignored content"): what
 * git would ignore can be reproduced (`node_modules/`, build output, venvs,
 * caches), so base, delta and final archives leave it out, and so does a
 * touched-files capture.
 *
 * Git answers with its own rules (every `.gitignore`, `.git/info/exclude`,
 * `core.excludesFile`), once per repository:
 *
 * - a root inside a git work tree: `git ls-files --others --ignored
 *   --exclude-standard --directory` in the root. An ignored directory comes
 *   back as one `dir/` line, so the scan prunes it without walking it. A
 *   tracked file is never ignored (git does not list it);
 * - any other root (an all-folders or touched-files folder): the same command
 *   with a private, empty bare repository as `GIT_DIR` (a fresh temp dir,
 *   removed once the scan is done) and the root as the work tree, so the
 *   folder's `.gitignore` files apply exactly as git would apply them, and
 *   nothing is written in the folder;
 * - a nested repository (a folder below the root holding `.git`, such as a
 *   submodule or a cloned dependency) gets its own answer, from its own
 *   repository, when the scan enters it: git never looks inside it from the
 *   outer one;
 * - without a working git (missing, timed out, too many ignored paths): the
 *   `.gitignore` files, applied with the collector's walkFallback rules.
 *
 * `.git` itself and the `.gitignore` files are never ignored.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { ignoredByRules, parseGitignoreRules, scopedIgnoreRules } from "../workspace-collector.js";

/** One `git ls-files` or `git check-ignore` run may take this long before the rules fallback. */
export const IGNORE_GIT_TIMEOUT_MS = 120_000;
/** More ignored paths than this from one repository and git's answer is dropped for the rules fallback. */
export const MAX_IGNORED_PATHS = 2_000_000;
const MAX_GITIGNORE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);

/**
 * GIT_CEILING_DIRECTORIES with the real home directory appended: git never
 * climbs into home, so a folder whose nearest `.git` git rejects (an empty
 * folder, say) cannot pick up a dotfiles repository there.
 */
export function gitCeilingDirectories(): string {
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    // An unreadable home is used as given.
  }
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  if (!home) return existing ?? "";
  return existing ? `${existing}${delimiter}${home}` : home;
}

/** The environment of every archive git run: never above home, no prompt, no optional lock, no pager, C locale. */
export function archiveGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
  // A repository chosen by the caller's environment never answers for the root.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) delete env[name];
  return { ...env, ...extra };
}

type NulRun = { status: "ok" | "failed" | "timeout" | "overflow"; code: number | null; paths: Set<string> };

/**
 * Runs git and collects its NUL-separated output as a set, streaming (a
 * listing of a million ignored files is never one string). A trailing `/`
 * (an ignored directory) is dropped. At most MAX_IGNORED_PATHS are kept.
 */
function gitNulSet(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, input?: string, signal?: AbortSignal): Promise<NulRun> {
  return new Promise((resolvePromise) => {
    const paths = new Set<string>();
    let pending: Buffer | null = null;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (status: NulRun["status"], code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({ status, code, paths });
    };
    const onAbort = () => {
      child?.kill("SIGKILL");
      finish("failed", null);
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish("timeout", null);
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      finish("failed", null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn("git", ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], {
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        windowsHide: true,
        env,
      });
    } catch {
      finish("failed", null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      let data = pending ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (let end = data.indexOf(0, start); end !== -1; end = data.indexOf(0, start)) {
        let path = data.toString("utf8", start, end);
        start = end + 1;
        if (path.endsWith("/")) path = path.slice(0, -1);
        if (path) paths.add(path);
      }
      data = data.subarray(start);
      pending = data.length > 0 ? Buffer.from(data) : null;
      if (paths.size > MAX_IGNORED_PATHS) {
        child?.kill("SIGKILL");
        finish("overflow", null);
      }
    });
    child.on("error", () => finish("failed", null));
    child.on("close", (code) => finish(code === 0 ? "ok" : "failed", code));
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });
}

// --- the private repository for folders that are not in one -----------------------------

/**
 * Runs `use` with an empty bare repository in a fresh private temp dir
 * (null without a working git), removed afterwards.
 */
async function withScratchRepository<T>(use: (gitDir: string | null) => Promise<T>): Promise<T> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "omnirush-archive-ignore-"));
  } catch {
    return use(null);
  }
  try {
    const init = await gitNulSet(dir, ["init", "-q", "--bare", "--template=", dir], archiveGitEnv(), PROBE_TIMEOUT_MS);
    return await use(init.status === "ok" ? dir : null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- scopes ---------------------------------------------------------------------------

/**
 * What decides ignoring below a directory: git's answer for a repository
 * (paths relative to `prefix`, the repository's folder under the root, with a
 * trailing `/` unless it is the root), the `.gitignore` rules in force
 * (fallback), or nothing (inside `.git`).
 */
export type IgnoreScope =
  | { kind: "git"; prefix: string; ignored: ReadonlySet<string> }
  | { kind: "rules"; rules: readonly string[] }
  | { kind: "none" };

const NO_IGNORE: IgnoreScope = { kind: "none" };
const NO_RULES: IgnoreScope = { kind: "rules", rules: [] };

function isGitName(part: string): boolean {
  return part.toLowerCase() === ".git";
}

/** How the root's answer was worked out: its repository, the private one, the .gitignore rules, or nothing to go on. */
export type IgnoreSource = "repository" | "folder" | "rules";

/**
 * Whether `scope` ignores `rel` (a root-relative path whose parent the scope
 * belongs to). `.git` and `.gitignore` never are.
 */
export function scopeIgnores(scope: IgnoreScope, rel: string, isDir: boolean): boolean {
  if (scope.kind === "none") return false;
  const slash = rel.lastIndexOf("/");
  const name = slash === -1 ? rel : rel.slice(slash + 1);
  if (isGitName(name) || name === ".gitignore") return false;
  if (scope.kind === "git") return rel.startsWith(scope.prefix) && scope.ignored.has(rel.slice(scope.prefix.length));
  if (scope.rules.length === 0) return false;
  return ignoredByRules(rel, scope.rules) || (isDir && ignoredByRules(`${rel}/`, scope.rules));
}

/** A folder's `.gitignore` rules; none when it is missing, not a regular file, or too large. */
async function readGitignoreRules(absDir: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(join(absDir, ".gitignore"), READ_FLAGS);
  } catch {
    return [];
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_GITIGNORE_BYTES) return [];
    return parseGitignoreRules(await handle.readFile("utf8"));
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `git ls-files` listing every untracked ignored path, an ignored directory as one line. */
const LIST_IGNORED = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"] as const;

/**
 * The ignore decisions of one scan of a root. `rootScope` is asked once, at
 * the root; `enter` for each folder the scan walks into, with what its
 * listing showed (`.git`, `.gitignore`).
 */
export class ArchiveIgnore {
  /** Entries left out as ignored (whole directories count once). */
  ignored = 0;
  source: IgnoreSource = "rules";

  constructor(private readonly root: string, private readonly signal?: AbortSignal) {}

  /** The root's scope: its repository's answer, the private repository's, or its `.gitignore` rules. */
  async rootScope(hasGitignore: boolean): Promise<IgnoreScope> {
    const own = await gitNulSet(this.root, LIST_IGNORED, archiveGitEnv(), IGNORE_GIT_TIMEOUT_MS, undefined, this.signal);
    this.signal?.throwIfAborted();
    if (own.status === "ok") {
      this.source = "repository";
      return { kind: "git", prefix: "", ignored: own.paths };
    }
    if (own.status === "failed") {
      const folder = await withScratchRepository(async (scratch) => scratch
        ? gitNulSet(this.root, LIST_IGNORED, archiveGitEnv({ GIT_DIR: scratch, GIT_WORK_TREE: this.root }), IGNORE_GIT_TIMEOUT_MS, undefined, this.signal)
        : null);
      this.signal?.throwIfAborted();
      if (folder?.status === "ok") {
        this.source = "folder";
        return { kind: "git", prefix: "", ignored: folder.paths };
      }
    }
    this.source = "rules";
    return hasGitignore ? { kind: "rules", rules: scopedIgnoreRules("", await readGitignoreRules(this.root)) } : NO_RULES;
  }

  /** The scope below `rel` (not the root), a folder whose parent had `parent`. */
  async enter(rel: string, abs: string, parent: IgnoreScope, listing: { git: boolean; gitignore: boolean }): Promise<IgnoreScope> {
    if (parent.kind === "none" || rel.split("/").some(isGitName)) return NO_IGNORE;
    if (listing.git) {
      const nested = await gitNulSet(abs, LIST_IGNORED, archiveGitEnv({ GIT_CEILING_DIRECTORIES: `${gitCeilingDirectories()}${delimiter}${join(abs, "..")}` }), IGNORE_GIT_TIMEOUT_MS, undefined, this.signal);
      this.signal?.throwIfAborted();
      if (nested.status === "ok") return { kind: "git", prefix: `${rel}/`, ignored: nested.paths };
    }
    if (parent.kind === "rules" && listing.gitignore) {
      const local = await readGitignoreRules(abs);
      if (local.length > 0) return { kind: "rules", rules: [...parent.rules, ...scopedIgnoreRules(rel, local)] };
    }
    return parent;
  }
}

/**
 * The touched files (root-relative, each a regular file the scan lstat'ed)
 * that git ignores: `git check-ignore` over just those paths, in the root's
 * repository or, for a folder in none, in the private repository with the
 * root as work tree (a nested repository's `.gitignore` files apply there
 * too). Nothing but those paths is looked at, so the folder is never walked.
 * Without git, each path's folders are checked against their `.gitignore`
 * rules. A path git refuses on its own (a race with a symlink swap) is kept.
 */
export async function touchedIgnoredPaths(root: string, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const inRepository = await gitNulSet(root, ["rev-parse", "--is-inside-work-tree"], archiveGitEnv(), PROBE_TIMEOUT_MS, undefined, signal);
  signal?.throwIfAborted();
  const answer = inRepository.status === "ok"
    ? await checkIgnoreIsolated(root, [...paths], archiveGitEnv(), signal)
    : await withScratchRepository(async (scratch) => scratch ? checkIgnoreIsolated(root, [...paths], archiveGitEnv({ GIT_DIR: scratch, GIT_WORK_TREE: root }), signal) : null);
  signal?.throwIfAborted();
  return answer ?? rulesIgnoredPaths(root, paths);
}

/** `git check-ignore` for a batch, halved around a path git refuses (exit 128) so one never changes the others' answer. */
async function checkIgnoreIsolated(root: string, paths: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Set<string> | null> {
  const ask = async (batch: string[]): Promise<Set<string> | null> => {
    const run = await gitNulSet(root, ["check-ignore", "-z", "--stdin"], env, IGNORE_GIT_TIMEOUT_MS, `${batch.join("\0")}\0`, signal);
    if (run.status === "ok" || (run.status === "failed" && run.code === 1)) return run.paths;
    if (run.status === "failed" && run.code === 128) return null;
    throw new Error("git check-ignore failed");
  };
  const ignored = new Set<string>();
  const isolate = async (batch: string[]): Promise<void> => {
    signal?.throwIfAborted();
    const answer = await ask(batch);
    if (answer) {
      for (const path of answer) ignored.add(path);
      return;
    }
    if (batch.length === 1) return;
    const middle = batch.length >> 1;
    await isolate(batch.slice(0, middle));
    await isolate(batch.slice(middle));
  };
  try {
    await isolate(paths);
  } catch {
    return null;
  }
  return ignored;
}

/** The walkFallback decision for single paths: a path is ignored when it, or a folder above it, matches the rules in force there. */
async function rulesIgnoredPaths(root: string, paths: readonly string[]): Promise<Set<string>> {
  const rulesByDirectory = new Map<string, Promise<IgnoreScope>>();
  const scopeAt = (directory: string): Promise<IgnoreScope> => {
    let scope = rulesByDirectory.get(directory);
    if (!scope) {
      scope = (async (): Promise<IgnoreScope> => {
        if (directory === "") return { kind: "rules", rules: scopedIgnoreRules("", await readGitignoreRules(root)) };
        const slash = directory.lastIndexOf("/");
        const parent = await scopeAt(slash === -1 ? "" : directory.slice(0, slash));
        if (parent.kind !== "rules" || directory.split("/").some(isGitName)) return NO_IGNORE;
        const local = await readGitignoreRules(join(root, ...directory.split("/")));
        return local.length > 0 ? { kind: "rules", rules: [...parent.rules, ...scopedIgnoreRules(directory, local)] } : parent;
      })();
      rulesByDirectory.set(directory, scope);
    }
    return scope;
  };
  const ignored = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      if (scopeIgnores(await scopeAt(parts.slice(0, depth - 1).join("/")), parts.slice(0, depth).join("/"), depth < parts.length)) {
        ignored.add(path);
        break;
      }
    }
  }
  return ignored;
}
