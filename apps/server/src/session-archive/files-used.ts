/**
 * Files used, the app side (files-used-policy.ts has the format and the
 * rules): hashing, the per-session store of staged copies and pending
 * items, and FilesUsedTracker, which turns the agent's own tool calls into
 * `files_used` items: at the end of each tool call it keeps a copy of the
 * temp files the call named (or created in a temp folder it named) and of
 * the allowlisted home config it read (scrubbed); at the end of the turn it
 * lists every file the turn's calls used, reports the project and outside
 * ones to the archive as touched (the chain's own scan carries them), and
 * leaves the items for the next state document. Only the agent's tool calls
 * are looked at, never what other programs open.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { stateKey } from "./files.js";
import { HASH_READ_BYTES, OPEN_ENTRY_FLAGS, isArchiveCredentialPath, statFields, type ScannedEntry } from "./manifest.js";
import {
  belowDir,
  BUILD_OUTPUT_DIR_NAMES,
  classifyUse,
  DEPENDENCY_DIR_NAMES,
  DEFAULT_FILES_USED_LIMITS,
  MAX_FILES_USED_ITEMS,
  scrubHomeConfig,
  strongerOp,
  type FilesUsedLimits,
  type FilesUsedOp,
  type PendingUse,
  type UseClass,
  type UseContext,
} from "./files-used-policy.js";
import { shellCommandUses } from "./files-used-shell.js";
import { sseFrames } from "./tool-start.js";
import { lockfileEcosystem, MANIFEST_NAMES, MAX_LOCKFILE_BYTES, MAX_TOOLCHAIN_PROJECTS, sortToolchainProjects, toolchainProject, type ToolchainProject } from "./deps.js";
import { redactUploadContent } from "../session-uploader.js";
import type { FilesUsedSandbox, ViewFacts } from "./files-used-sandbox.js";

export { containerFilesUsedView, dockerExecRunner, sandboxFilesUsed, type FilesUsedSandbox, type FilesUsedView } from "./files-used-sandbox.js";

/** A regular file's bytes (never a link followed): `too_large` past `maxBytes`, null when it is not there or unreadable. */
async function readLocalFile(absolute: string, maxBytes: number): Promise<Buffer | "too_large" | null> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  if (stats.size > maxBytes) return "too_large";
  try {
    const handle = await open(absolute, OPEN_ENTRY_FLAGS);
    try {
      return await handle.readFile();
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/** A container path's facts as fileFacts gives them (`unreadable`: the sandbox could not be asked). */
function viewFacts(facts: ViewFacts | undefined): FileFacts | "missing" | "not_file" | "unreadable" {
  if (!facts || facts.kind === "unreadable") return "unreadable";
  if (facts.kind === "missing") return "missing";
  if (facts.kind !== "file") return "not_file";
  return { size: facts.size, sha256: facts.sha256, mtimeMs: facts.mtimeMs, dev: 0, ino: 0 };
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export * from "./files-used-policy.js";

// --- hashing ------------------------------------------------------------------------------

export type FileFacts = { size: number; sha256: string | null; mtimeMs: number; dev: number; ino: number };

/**
 * Size and SHA-256 of a regular file (never a symlink followed), hashing at
 * most `maxHashBytes` (a larger one has its size only): "missing" when
 * nothing is there, "not_file" for a folder, link or special file.
 */
export async function fileFacts(absolute: string, maxHashBytes: number): Promise<FileFacts | "missing" | "not_file"> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return "missing";
  }
  if (!stats.isFile()) return "not_file";
  const facts: FileFacts = { size: stats.size, sha256: null, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino };
  if (stats.size > maxHashBytes) return facts;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, OPEN_ENTRY_FLAGS);
  } catch {
    return facts;
  }
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(HASH_READ_BYTES, Math.max(1, stats.size)));
    let remaining = stats.size;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    if (remaining === 0) facts.sha256 = hash.digest("hex");
  } catch {
    // Unreadable: size only.
  } finally {
    await handle.close().catch(() => undefined);
  }
  return facts;
}

// --- the per-session store of staged copies and pending items ---------------------------

export type StagedFile = {
  /** Archive path (`__outside__/...`). */
  path: string;
  size: number;
  sha256: string;
  /** The copy under the store (absolute). */
  blob: string;
  /** An allowlisted home config whose copy had secrets removed. */
  scrubbed?: boolean;
};

type SessionIndex = { v: 1; staged: StagedFile[]; bytes: number; pending: PendingUse[] };

/**
 * Staged copies (content-addressed blobs) and the items recorded since the
 * chain's last archive, per session, under `<dir>/<session key>/`. Every
 * capture of a files-used chain holds the staged copies (so a delta sends
 * each once), and the next state document takes the pending items.
 */
export class FilesUsedStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string, private limits: FilesUsedLimits = DEFAULT_FILES_USED_LIMITS) {}

  setLimits(limits: Partial<FilesUsedLimits>): void {
    this.limits = { ...this.limits, ...Object.fromEntries(Object.entries(limits).filter(([, value]) => typeof value === "number" && value > 0)) };
  }

  get currentLimits(): FilesUsedLimits {
    return this.limits;
  }

  private sessionDir(sessionId: string): string {
    return join(this.dir, stateKey(sessionId));
  }

  private serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.tails.set(sessionId, run.catch(() => undefined));
    return run;
  }

  private async load(sessionId: string): Promise<SessionIndex> {
    try {
      const value = JSON.parse(await readFile(join(this.sessionDir(sessionId), "index.json"), "utf8")) as SessionIndex;
      if (value && value.v === 1 && Array.isArray(value.staged) && Array.isArray(value.pending)) return value;
    } catch {
      // None yet.
    }
    return { v: 1, staged: [], bytes: 0, pending: [] };
  }

  private async save(sessionId: string, index: SessionIndex): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "index.json");
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(index), { mode: 0o600 });
    await rename(temp, file);
  }

  /**
   * Stages `bytes` as the archive path's copy (replacing an older one of
   * that path). Returns the record, or `too_large` past the per-file or
   * the session cap.
   */
  stage(sessionId: string, path: string, bytes: Buffer, scrubbed = false): Promise<StagedFile | "too_large"> {
    return this.serial(sessionId, async () => {
      if (bytes.length > this.limits.maxFileBytes) return "too_large" as const;
      const index = await this.load(sessionId);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const known = index.staged.find((item) => item.path === path);
      if (known && known.sha256 === sha256) return known;
      const blobKnown = index.staged.some((item) => item.sha256 === sha256);
      if (!blobKnown && index.bytes + bytes.length > this.limits.maxSessionBytes) return "too_large" as const;
      const dir = this.sessionDir(sessionId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const blob = join(dir, `${sha256}.bin`);
      if (!blobKnown) {
        const temp = `${blob}.${process.pid}.tmp`;
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, blob);
        index.bytes += bytes.length;
      }
      const record: StagedFile = { path, size: bytes.length, sha256, blob, ...(scrubbed ? { scrubbed: true } : {}) };
      index.staged = [...index.staged.filter((item) => item.path !== path), record];
      await this.save(sessionId, index);
      return record;
    });
  }

  /** The session's staged copies. */
  async staged(sessionId: string): Promise<StagedFile[]> {
    return this.serial(sessionId, async () => (await this.load(sessionId)).staged);
  }

  /** Adds items for the next state document (a path seen again keeps its first item, with the stronger op). */
  addPending(sessionId: string, items: readonly PendingUse[]): Promise<void> {
    return this.serial(sessionId, async () => {
      const index = await this.load(sessionId);
      const byKey = new Map(index.pending.map((item) => [`${item.turn ?? ""}\0${item.path}`, item]));
      for (const item of items) {
        const key = `${item.turn ?? ""}\0${item.path}`;
        const known = byKey.get(key);
        if (known) {
          known.op = strongerOp(known.op, item.op);
          if (item.sha256) {
            known.sha256 = item.sha256;
            known.size = item.size;
          }
          continue;
        }
        if (byKey.size >= MAX_FILES_USED_ITEMS) break;
        byKey.set(key, { ...item });
      }
      index.pending = [...byKey.values()];
      await this.save(sessionId, index);
    });
  }

  /** The pending items (not removed: `commit` removes those a queued archive carried). */
  async pending(sessionId: string): Promise<PendingUse[]> {
    return this.serial(sessionId, async () => (await this.load(sessionId)).pending);
  }

  /** Removes the pending items an archive carried. */
  commit(sessionId: string, carried: readonly PendingUse[]): Promise<void> {
    return this.serial(sessionId, async () => {
      const index = await this.load(sessionId);
      const done = new Set(carried.map((item) => `${item.turn ?? ""}\0${item.path}`));
      index.pending = index.pending.filter((item) => !done.has(`${item.turn ?? ""}\0${item.path}`));
      await this.save(sessionId, index);
    });
  }

  /** Archive entries for the staged copies (read from the blobs at pack time). */
  async entries(sessionId: string): Promise<ScannedEntry[]> {
    const out: ScannedEntry[] = [];
    for (const record of await this.staged(sessionId)) {
      try {
        const stats = await lstat(record.blob, { bigint: true });
        if (!stats.isFile() || Number(stats.size) !== record.size) continue;
        out.push({ path: record.path, type: "file", size: record.size, sha256: record.sha256, source: record.blob, ...statFields(stats), mode: 0o644, ...(record.scrubbed ? { scrubbed: true } : {}) });
      } catch {
        // Gone (signed out meanwhile).
      }
    }
    return out;
  }

  forget(sessionId: string): Promise<void> {
    return this.serial(sessionId, async () => {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    });
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- context helpers -----------------------------------------------------------------------

export function safeHome(): string | null {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

/** The temp folders of this machine, as given and as real paths. */
export async function tempRoots(): Promise<string[]> {
  const out = new Set<string>();
  for (const value of [tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP, "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]) {
    if (!value || !isAbsolute(value)) continue;
    out.add(resolve(value));
    try {
      out.add(await realpath(value));
    } catch {
      // Not on this machine.
    }
  }
  return [...out];
}

/** A folder's forms to compare against: as given and its real path. */
export async function pathForms(dir: string): Promise<string[]> {
  const out = new Set([resolve(dir)]);
  try {
    out.add(await realpath(dir));
  } catch {
    // Not there.
  }
  return [...out];
}

/** The path with its folder as a real path (the file itself never followed); null when the folder is gone. */
export async function canonicalFile(path: string): Promise<string | null> {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch {
    return null;
  }
}

// --- the agent's tool calls -----------------------------------------------------------------

/** A tool call as both engines record it (`{ type: "tool", tool, callID, state: { input, time } }`). */
export type UsedToolCall = { callId: string | null; tool: string; input: Record<string, unknown>; start: number | null; end: number | null };

const READ_TOOLS = new Set(["read", "view", "cat", "file_read", "read_file", "open", "read_many_files", "readfile", "grep", "glob", "list", "ls", "search", "find", "codesearch"]);
const WRITE_TOOLS = new Set([
  "write", "edit", "multiedit", "multi_edit", "create", "file_write", "write_file", "patch", "apply_patch", "str_replace",
  "str_replace_editor", "str_replace_based_edit_tool", "notebook_edit", "notebookedit", "replace", "move", "rename",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "run_command", "run_shell_command", "exec", "terminal", "local_shell", "powershell", "cmd"]);
const PATH_KEYS = ["filePath", "file_path", "filepath", "path", "filename", "file_name", "target_path", "notebook_path", "absolute_path", "source", "destination"];
const CWD_KEYS = ["workdir", "cwd", "directory", "working_directory"];
const MAX_CALL_USES = 256;
/** A temp folder a call named: its files changed during the call are the call's (bounded walk). */
const MAX_TEMP_FOLDER_FILES = 128;
const MAX_TEMP_FOLDER_ENTRIES = 4_000;
const MAX_TEMP_FOLDER_DEPTH = 3;
const CALL_WINDOW_SLACK_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function toolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase().split(/[.:/]/).at(-1) || null;
}

/** A tool call from an engine tool part, or null. */
export function usedToolCallOf(part: unknown): UsedToolCall | null {
  if (!isRecord(part) || part.type !== "tool") return null;
  const tool = toolName(part.tool ?? part.name);
  if (!tool) return null;
  const state = isRecord(part.state) ? part.state : {};
  const input = isRecord(state.input) ? state.input : isRecord(part.input) ? part.input : null;
  if (!input) return null;
  const time = isRecord(state.time) ? state.time : {};
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return { callId: text(part.callID) ?? text(part.callId) ?? text(part.id), tool, input, start: number(time.start), end: number(time.end) };
}

/** Every tool call of a list of engine messages (or `{ messages }`), in order. */
export function usedToolCalls(messages: unknown): UsedToolCall[] {
  const list = Array.isArray(messages) ? messages : isRecord(messages) && Array.isArray(messages.messages) ? messages.messages : [];
  const out: UsedToolCall[] = [];
  for (const message of list) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      const call = usedToolCallOf(part);
      if (call) out.push(call);
    }
  }
  return out;
}

function expandHome(path: string, home: string | null): string | null {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return home ? join(home, path.slice(2)) : null;
  return path.startsWith("~") ? null : path;
}

/** Paths of an apply_patch body (`*** Add File: x`, `*** Update File: x`, `*** Move to: x`). */
function patchPaths(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 1024 * 1024) return [];
  const paths: string[] = [];
  for (const match of value.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to):[ \t]*(.+)$/gm)) {
    const path = match[1]?.trim().split(/\s+->\s+/u)[0];
    if (path) paths.push(path);
  }
  return paths;
}

/** The files one tool call names, absolute, with how it used them: file tool paths and shell command words. */
export function toolCallUses(call: UsedToolCall, root: string, home: string | null): Array<{ path: string; op: FilesUsedOp; implicit?: true }> {
  const out = new Map<string, FilesUsedOp>();
  /** Paths only ever read implicitly (a config a program loads): not listed when they are not there. */
  const implicit = new Set<string>();
  const explicit = new Set<string>();
  const add = (raw: unknown, op: FilesUsedOp, cwd: string, unnamed = false) => {
    if (out.size >= MAX_CALL_USES || typeof raw !== "string") return;
    const value = raw.trim();
    if (!value || value.length > 4_096 || value.includes("\0") || value.includes("\n") || value.includes("://")) return;
    const expanded = expandHome(value, home);
    if (!expanded) return;
    const path = resolve(cwd, expanded);
    out.set(path, strongerOp(out.get(path) ?? op, op));
    (unnamed ? implicit : explicit).add(path);
  };
  const input = call.input;
  const cwdValue = CWD_KEYS.map((key) => text(input[key])).find(Boolean);
  const cwd = cwdValue ? resolve(root, expandHome(cwdValue, home) ?? ".") : root;
  if (SHELL_TOOLS.has(call.tool)) {
    for (const key of ["command", "cmd", "script"]) {
      const value = input[key];
      const command = typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(" ") : null;
      if (command) for (const use of shellCommandUses(command, cwd, home)) add(use.path, use.op, cwd, use.implicit === true);
    }
  } else {
    const op: FilesUsedOp | null = WRITE_TOOLS.has(call.tool) ? "write" : READ_TOOLS.has(call.tool) ? "read" : null;
    if (op) {
      for (const key of PATH_KEYS) add(input[key], op, cwd);
      if (Array.isArray(input.paths)) for (const value of input.paths) add(value, op, cwd);
      if (Array.isArray(input.edits)) for (const edit of input.edits) if (isRecord(edit)) add(edit.filePath ?? edit.file_path ?? edit.path, op, cwd);
    }
    for (const key of ["patchText", "patch", "input", "content"]) for (const path of patchPaths(input[key])) add(path, "write", cwd);
  }
  return [...out].map(([path, op]) => (implicit.has(path) && !explicit.has(path) ? { path, op, implicit: true as const } : { path, op }));
}

/** The files under a temp folder a call named that changed during the call (mtime or ctime in its window). */
async function changedInFolder(dir: string, start: number, end: number): Promise<string[]> {
  const found: string[] = [];
  let entries = 0;
  const low = start - CALL_WINDOW_SLACK_MS;
  const high = end + CALL_WINDOW_SLACK_MS;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > MAX_TEMP_FOLDER_DEPTH || found.length >= MAX_TEMP_FOLDER_FILES) return;
    let children;
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (found.length >= MAX_TEMP_FOLDER_FILES || ++entries > MAX_TEMP_FOLDER_ENTRIES) return;
      const path = join(folder, child.name);
      if (child.isDirectory()) {
        if (child.name !== "node_modules" && child.name !== ".git" && child.name !== ".venv") await walk(path, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        const stats = await lstat(path);
        const changed = Math.max(stats.mtimeMs, stats.ctimeMs);
        if (changed >= low && changed <= high) found.push(path);
      } catch {
        // Gone.
      }
    }
  };
  await walk(dir, 0);
  return found;
}

// --- the end-of-turn snapshot ------------------------------------------------------------------

/** Turn-end work past this is left to the archive (hashes) or skipped; the snapshot walk gets less. */
export const TURN_END_BUDGET_MS = 250;
const SNAPSHOT_BUDGET_MS = 150;
const SNAPSHOT_MAX_ENTRIES = 20_000;
const SNAPSHOT_MAX_FILES = 500;
const SNAPSHOT_MAX_DEPTH = 16;

/**
 * The project's files created or changed since `since` (mtime or ctime,
 * with the call-window slack), gitignored ones included: a stat walk that
 * never enters .git, a dependency or a build output folder (they could use
 * up the file cap; their files are hash-only anyway) and never follows a link,
 * stopping at `deadline` or the entry and file caps. Never throws.
 */
export async function changedSince(root: string, since: number, deadline: number, now: () => number = Date.now): Promise<string[]> {
  const found: string[] = [];
  const low = since - CALL_WINDOW_SLACK_MS;
  let entries = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > SNAPSHOT_MAX_DEPTH || found.length >= SNAPSHOT_MAX_FILES || entries >= SNAPSHOT_MAX_ENTRIES || now() >= deadline) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const folders: string[] = [];
    for (const child of children) {
      if (found.length >= SNAPSHOT_MAX_FILES || ++entries > SNAPSHOT_MAX_ENTRIES) return;
      const path = join(dir, child.name);
      if (child.isDirectory()) {
        if (child.name !== ".git" && !DEPENDENCY_DIR_NAMES.has(child.name) && !BUILD_OUTPUT_DIR_NAMES.has(child.name)) folders.push(path);
        continue;
      }
      if (!child.isFile()) continue;
      if ((entries & 255) === 0 && now() >= deadline) return;
      try {
        const stats = await lstat(path);
        if (Math.max(stats.mtimeMs, stats.ctimeMs) >= low) found.push(path);
      } catch {
        // Gone.
      }
    }
    for (const folder of folders) await walk(folder, depth + 1);
  };
  try {
    await walk(root, 0);
  } catch {
    // Best effort.
  }
  return found;
}

// --- the tracker -----------------------------------------------------------------------------

/** What the tracker needs of the project archive. */
export type FilesUsedArchive = {
  /** Whether the session's chain records files used (a v2 chain, and omnirush.ai records them for the account). */
  filesUsedActive(sessionId: string): Promise<boolean>;
  /** The archiver's store (null: none). */
  readonly filesUsed: FilesUsedStore | null;
  /** A project-relative or absolute outside path the chain's scan must carry. */
  recordTouched(sessionId: string, path: string): void;
};

export type FilesUsedTrackerOptions = {
  archive: FilesUsedArchive;
  /** App state folders: never listed. */
  appDirs: readonly string[];
  home?: string | null;
  includeCredentialFiles?: boolean;
  log?: (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;
  now?: () => number;
  /** Tests: the temp folders (tempRoots() by default). */
  temps?: readonly string[];
  /**
   * A chat in the Linux sandbox (box/; CLI: `sandbox`, files-used-sandbox.ts):
   * `~` is the container's HOME, the temp folders are the container's, and
   * every path outside the mounted project is read in the container, never here.
   */
  sandboxFor?: (sessionId: string) => FilesUsedSandbox | null;
};

/** The sandbox's temp folders when the launcher names none. */
const SANDBOX_TEMPS = ["/tmp", "/var/tmp"];

/** A path the tracker looked at: where it really is, whether it is read on this machine, and (in the container) what is there. */
type Resolved = { absolute: string; local: boolean; facts?: ViewFacts };

type TrackedSession = {
  /** Calls whose files were kept at their end, by call id. */
  done: Set<string>;
  /** First call that used each path (absolute). */
  firstCall: Map<string, string>;
  turn: number;
  tail: Promise<unknown>;
  /** When the turn being followed started (turnStarted), for the end-of-turn snapshot. */
  turnStartedAt: number | null;
};

/** One line of timing per turn end, for the latency budget. */
export type TurnFilesUsed = { items: number; staged: number; ms: number; snapshot: number };

/**
 * See the module comment. Every method returns quickly and never throws;
 * one session's work runs in call order.
 */
export class FilesUsedTracker {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly home: string | null;
  private readonly now: () => number;
  private context: Promise<UseContext> | null = null;

  constructor(private readonly options: FilesUsedTrackerOptions) {
    this.home = options.home === undefined ? safeHome() : options.home;
    this.now = options.now ?? Date.now;
  }

  private session(sessionId: string): TrackedSession {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { done: new Set(), firstCall: new Map(), turn: 0, tail: Promise.resolve(), turnStartedAt: null };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private serial<T>(sessionId: string, task: () => Promise<T>, fallback: T): Promise<T> {
    const state = this.session(sessionId);
    const run = state.tail.then(task, task).catch((error: unknown) => {
      this.options.log?.("warn", "OmniRush files used: a step failed", { error: error instanceof Error ? error.message : String(error) });
      return fallback;
    });
    state.tail = run;
    return run;
  }

  private async useContext(root: string, sandbox: FilesUsedSandbox | null = null): Promise<UseContext> {
    this.context ??= (async () => ({
      roots: [],
      home: this.home,
      temps: this.options.temps ? [...this.options.temps] : await tempRoots(),
      appDirs: (await Promise.all(this.options.appDirs.map((dir) => pathForms(dir)))).flat(),
      includeCredentialFiles: this.options.includeCredentialFiles === true,
      isCredentialPath: isArchiveCredentialPath,
    }))();
    const base = await this.context;
    if (sandbox) return { ...base, home: sandbox.home, temps: [...(sandbox.temps ?? SANDBOX_TEMPS)], roots: await pathForms(root) };
    return { ...base, roots: await pathForms(root) };
  }

  private sandbox(sessionId: string): FilesUsedSandbox | null {
    return this.options.sandboxFor?.(sessionId) ?? null;
  }

  /** Asked at every step (cheap): the user's switch takes effect at the next tool call. */
  private async active(sessionId: string): Promise<boolean> {
    const store = this.options.archive.filesUsed;
    return store !== null && (await this.options.archive.filesUsedActive(sessionId).catch(() => false));
  }

  /** A turn of the session started: only its time is noted (nothing is read at turn start). */
  turnStarted(sessionId: string): void {
    this.session(sessionId).turnStartedAt = this.now();
  }

  /** The end of one tool call: the temp files it named or made and the allowlisted home config it read are kept now. */
  toolCallEnded(sessionId: string, root: string, call: UsedToolCall): Promise<void> {
    return this.serial(sessionId, async () => {
      if (!(await this.active(sessionId))) return;
      await this.keepCall(sessionId, root, call);
    }, undefined);
  }

  private async keepCall(sessionId: string, root: string, call: UsedToolCall): Promise<number> {
    const state = this.session(sessionId);
    const key = call.callId ?? `${call.tool}:${call.start ?? ""}:${JSON.stringify(call.input).slice(0, 200)}`;
    if (state.done.has(key)) return 0;
    state.done.add(key);
    const sandbox = this.sandbox(sessionId);
    const context = await this.useContext(root, sandbox);
    const uses = await this.callFiles(call, root, context, sandbox);
    const resolved = await this.resolvePaths(uses.map((use) => use.path), sandbox);
    const toStage: Array<{ where: Resolved; kind: UseClass }> = [];
    for (const use of uses) {
      const where = resolved.get(use.path)!;
      if (call.callId && !state.firstCall.has(where.absolute)) state.firstCall.set(where.absolute, call.callId);
      const kind = this.classify(where, context, sandbox);
      if (kind?.plan === "stage") toStage.push({ where, kind });
    }
    let staged = 0;
    for (const result of await this.stageFiles(sessionId, toStage, sandbox)) if (result !== null) staged += 1;
    return staged;
  }

  /** Whether a path is read on this machine: always without the sandbox; in it, only inside a folder mounted at the same path. */
  private isLocal(absolute: string, sandbox: FilesUsedSandbox | null): boolean {
    return !sandbox || sandbox.mounted.some((dir) => inside(dir, absolute));
  }

  /**
   * Where each path really is (its folder as a real path, the file never
   * followed). In the sandbox a path outside the mounted project, or one
   * whose real folder leaves it, is resolved and inspected in the container.
   */
  private async resolvePaths(paths: readonly string[], sandbox: FilesUsedSandbox | null): Promise<Map<string, Resolved>> {
    const out = new Map<string, Resolved>();
    const remote: string[] = [];
    for (const path of new Set(paths)) {
      if (!this.isLocal(path, sandbox)) {
        remote.push(path);
        continue;
      }
      const absolute = (await canonicalFile(path)) ?? resolve(path);
      if (this.isLocal(absolute, sandbox)) out.set(path, { absolute, local: true });
      else remote.push(path);
    }
    if (remote.length > 0 && sandbox) {
      const store = this.options.archive.filesUsed;
      const facts = await sandbox.view.inspect(remote, store?.currentLimits.maxFileBytes ?? DEFAULT_FILES_USED_LIMITS.maxFileBytes);
      for (const path of remote) {
        const found = facts.get(path) ?? { canonical: path, kind: "unreadable" as const };
        // A container path whose real folder is the mounted project is that project file (the same bytes here).
        out.set(path, this.isLocal(found.canonical, sandbox) ? { absolute: found.canonical, local: true } : { absolute: found.canonical, local: false, facts: found });
      }
    }
    return out;
  }

  /**
   * Where a file is and what may happen to its bytes (files-used-policy.ts).
   * In the sandbox the agent's home is the container's; a container file
   * outside the project is never scanned here: its bytes are kept from the
   * container (staged), like a temp file.
   */
  private classify(where: Resolved, context: UseContext, sandbox: FilesUsedSandbox | null): UseClass | null {
    let kind = classifyUse(where.absolute, context);
    if (!sandbox || where.local || !kind) return kind;
    if (kind.scope === "outside" && sandbox.hostHome) kind = classifyUse(where.absolute, { ...context, home: sandbox.hostHome }) ?? kind;
    if (kind.plan === "scan") kind = { ...kind, plan: "stage" };
    return kind;
  }

  /** A call's files: what it names, and the files changed during it in a temp folder it names. */
  private async callFiles(call: UsedToolCall, root: string, context: UseContext, sandbox: FilesUsedSandbox | null = null): Promise<Array<{ path: string; op: FilesUsedOp; implicit?: true }>> {
    const uses = toolCallUses(call, root, context.home);
    for (const use of [...uses]) {
      if (basename(use.path) !== ".yarnrc.yml" || !this.isLocal(use.path, sandbox)) continue;
      const text = await readFile(use.path, "utf8").catch(() => "");
      for (const file of yarnrcFiles(text.slice(0, 64 * 1024))) uses.push({ path: resolve(dirname(use.path), file), op: "exec", implicit: true });
    }
    if (!SHELL_TOOLS.has(call.tool) || call.start === null) return uses;
    const out = [...uses];
    const seen = new Set(uses.map((use) => use.path));
    const end = call.end ?? this.now();
    const inTemp = (path: string) => context.temps.some((temp) => belowDir(temp, path));
    const containerDirs: string[] = [];
    for (const use of uses) {
      if (!this.isLocal(use.path, sandbox)) {
        // The container's temp folders: walked there, in one step for the call.
        if (inTemp(use.path)) containerDirs.push(use.path);
        continue;
      }
      const real = (await canonicalFile(use.path)) ?? use.path;
      if (!inTemp(real) || !this.isLocal(real, sandbox)) continue;
      let stats;
      try {
        stats = await lstat(real);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;
      for (const file of await changedInFolder(real, call.start, end)) {
        if (!seen.has(file)) {
          seen.add(file);
          out.push({ path: file, op: "write" });
        }
      }
    }
    if (containerDirs.length > 0 && sandbox) {
      for (const file of await sandbox.view.changed(containerDirs, call.start - CALL_WINDOW_SLACK_MS, end + CALL_WINDOW_SLACK_MS)) {
        if (!seen.has(file)) {
          seen.add(file);
          out.push({ path: file, op: "write" });
        }
      }
    }
    return out;
  }

  /** Keeps a copy of each temp file or allowlisted home config (scrubbed); per file, what was kept, or null when nothing was. */
  private async stageFiles(sessionId: string, files: ReadonlyArray<{ where: Resolved; kind: UseClass }>, sandbox: FilesUsedSandbox | null): Promise<Array<{ size: number; sha256: string } | "too_large" | null>> {
    const store = this.options.archive.filesUsed;
    if (!store || files.length === 0) return files.map(() => null);
    const limits = store.currentLimits;
    const remote = files.filter(({ where }) => !where.local && where.facts?.kind === "file").map(({ where }) => where.absolute);
    const remoteBytes = remote.length > 0 && sandbox ? await sandbox.view.read(remote, limits.maxFileBytes) : new Map<string, Buffer | "too_large" | null>();
    const out: Array<{ size: number; sha256: string } | "too_large" | null> = [];
    for (const { where, kind } of files) {
      const bytes = where.local ? await readLocalFile(where.absolute, limits.maxFileBytes) : remoteBytes.get(where.absolute) ?? null;
      out.push(bytes === null || bytes === "too_large" ? bytes : await this.stageBytes(sessionId, where.absolute, kind.archivePath!, bytes, kind.scrub));
    }
    return out;
  }

  private async stageBytes(sessionId: string, absolute: string, archivePath: string, bytes: Buffer, scrub?: Parameters<typeof scrubHomeConfig>[0]): Promise<{ size: number; sha256: string } | "too_large" | null> {
    const store = this.options.archive.filesUsed;
    if (!store) return null;
    if (scrub) {
      const scrubbed = scrubHomeConfig(scrub, bytes.toString("utf8"));
      if (scrubbed === null) return null;
      bytes = Buffer.from(redactUploadContent(basename(absolute), scrubbed), "utf8");
    }
    const record = await store.stage(sessionId, archivePath, bytes, scrub !== undefined);
    return record === "too_large" ? record : { size: record.size, sha256: record.sha256 };
  }

  /**
   * The end of a turn: every tool call of `messages` (its new messages) is
   * looked at once more (calls whose end was not seen keep their files
   * now), each file they used is listed, the project and outside ones are
   * reported to the archive as touched, and the items wait for the next
   * state document. Resolves with what it did and how long it took.
   */
  turnEnded(sessionId: string, root: string, messages: unknown): Promise<TurnFilesUsed> {
    return this.serial(sessionId, async () => {
      const started = this.now();
      // Hashing past this point is left to the chain's own scan (scan and staged files) or skipped (hash-only files).
      const deadline = started + TURN_END_BUDGET_MS;
      const result: TurnFilesUsed = { items: 0, staged: 0, ms: 0, snapshot: 0 };
      const state = this.session(sessionId);
      const turnStartedAt = state.turnStartedAt;
      state.turnStartedAt = null;
      if (!(await this.active(sessionId))) return result;
      const store = this.options.archive.filesUsed!;
      state.turn += 1;
      const sandbox = this.sandbox(sessionId);
      const context = await this.useContext(root, sandbox);
      const limits = store.currentLimits;
      const uses = new Map<string, { op: FilesUsedOp; callId: string | null; implicit: boolean; where: Resolved }>();
      const calls = usedToolCalls(messages);
      const named: Array<{ use: { path: string; op: FilesUsedOp; implicit?: true }; callId: string | null }> = [];
      for (const call of calls) {
        result.staged += await this.keepCall(sessionId, root, call);
        for (const use of await this.callFiles(call, root, context, sandbox)) named.push({ use, callId: call.callId });
      }
      const resolved = await this.resolvePaths(named.map(({ use }) => use.path), sandbox);
      for (const { use, callId } of named) {
        const where = resolved.get(use.path)!;
        const known = uses.get(where.absolute);
        if (known) {
          known.op = strongerOp(known.op, use.op);
          known.implicit &&= use.implicit === true;
        } else if (uses.size < MAX_FILES_USED_ITEMS) uses.set(where.absolute, { op: use.op, callId: state.firstCall.get(where.absolute) ?? callId, implicit: use.implicit === true, where });
      }
      // The end-of-turn snapshot: files of the project created or changed during the turn (gitignored ones
      // too) that no call named. A stat walk, bounded by entries and by the turn-end budget.
      const since = turnStartedAt ?? calls.reduce<number | null>((low, call) => (call.start !== null && (low === null || call.start < low) ? call.start : low), null);
      if (since !== null) {
        const realRoot = (await pathForms(root)).at(-1) ?? root;
        for (const file of await changedSince(realRoot, since, Math.min(deadline, started + SNAPSHOT_BUDGET_MS))) {
          if (uses.has(file) || uses.size >= MAX_FILES_USED_ITEMS) continue;
          uses.set(file, { op: "write", callId: null, implicit: false, where: { absolute: file, local: true } });
          result.snapshot += 1;
        }
      }
      const items: PendingUse[] = [];
      for (const [absolute, use] of uses) {
        const kind = this.classify(use.where, context, sandbox);
        if (!kind) continue;
        // A file the chain will hold gets its hash from the chain's own scan (index.ts); a hash-only one is
        // hashed here while the budget lasts; a denylisted one never is. A container file: as the box answered.
        const hashBytes = kind.plan === "hold" && kind.reason !== "denylisted" && this.now() < deadline ? limits.maxFileBytes : -1;
        const facts = use.where.local ? await fileFacts(absolute, hashBytes) : viewFacts(use.where.facts);
        // A config a program loads without naming it is listed only when it is there.
        if (facts === "not_file" || ((facts === "missing" || facts === "unreadable") && use.implicit)) continue;
        if (facts === "unreadable") {
          // The sandbox could not be asked: listed, never guessed from this machine.
          items.push({ path: kind.path, scope: kind.scope, op: use.op, size: null, sha256: null, plan: "hold", reason: kind.plan === "hold" ? kind.reason : "missing", turn: state.turn, ...(kind.archivePath ? { archive_path: kind.archivePath } : {}), ...(use.callId ? { call_id: use.callId } : {}) });
          continue;
        }
        const present = facts !== "missing";
        let size = present ? facts.size : null;
        let sha256 = present ? facts.sha256 : null;
        let reason = kind.reason;
        if (kind.plan === "stage" && present) {
          const staged = (await this.stageFiles(sessionId, [{ where: use.where, kind }], sandbox))[0] ?? null;
          if (staged === "too_large") reason = "too_large";
          else if (staged) {
            // The archived copy (for a home config, the scrubbed one): its size and hash.
            size = staged.size;
            sha256 = staged.sha256;
          }
        } else if (kind.plan === "scan" && present) {
          if (facts.size > limits.maxFileBytes) reason = "too_large";
          else this.options.archive.recordTouched(sessionId, kind.scope === "project" ? kind.path : absolute);
        } else if (kind.plan === "hold" && present && facts.size > limits.maxFileBytes && kind.reason !== "denylisted") {
          reason = "too_large";
        }
        if (!present && kind.plan === "stage") {
          // Gone by the turn's end: the copy kept when its call ended stands for it.
          const kept = (await store.staged(sessionId)).find((record) => record.path === kind.archivePath);
          if (kept) {
            size = kept.size;
            sha256 = kept.sha256;
          }
        }
        items.push({
          path: kind.path,
          scope: kind.scope,
          op: use.op,
          size,
          sha256,
          plan: kind.plan === "stage" ? (reason === "too_large" ? "hold" : "staged") : kind.plan === "scan" && reason !== "too_large" ? "scan" : "hold",
          reason,
          turn: state.turn,
          ...(kind.archivePath ? { archive_path: kind.archivePath } : {}),
          ...(use.callId ? { call_id: use.callId } : {}),
        });
      }
      if (items.length > 0) await store.addPending(sessionId, items);
      result.items = items.length;
      result.ms = this.now() - started;
      return result;
    }, { items: 0, staged: 0, ms: 0, snapshot: 0 });
  }

  /** Forgets a session (deleted, or not archived). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// --- dependencies (deps.ts) -------------------------------------------------------------------

const DEPS_MAX_DEPTH = 6;
const DEPS_MAX_DIRS = 5_000;

/**
 * The state document's `dependencies`: every lockfile under `root` (a
 * bounded walk that skips .git, dot folders and the dependency and build
 * folders) read into its subproject's resolved versions (deps.ts). Never
 * throws.
 */
export async function collectDependencyProjects(root: string, signal?: AbortSignal): Promise<ToolchainProject[]> {
  const projects: ToolchainProject[] = [];
  let visited = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > DEPS_MAX_DEPTH || visited >= DEPS_MAX_DIRS || projects.length >= MAX_TOOLCHAIN_PROJECTS || signal?.aborted) return;
    visited += 1;
    const dir = rel ? join(root, ...rel.split("/")) : root;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const manifests = MANIFEST_NAMES.filter((name) => names.has(name)).map((name) => (rel ? `${rel}/${name}` : name));
    for (const name of names) {
      if (!lockfileEcosystem(name) || projects.length >= MAX_TOOLCHAIN_PROJECTS) continue;
      const lockfile = rel ? `${rel}/${name}` : name;
      try {
        const stats = await lstat(join(dir, name));
        if (!stats.isFile() || stats.size > MAX_LOCKFILE_BYTES) continue;
        const project = toolchainProject(lockfile, manifests, await readFile(join(dir, name), "utf8"));
        if (project) projects.push(project);
      } catch {
        // Unreadable: no versions from it.
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || DEPENDENCY_DIR_NAMES.has(entry.name) || BUILD_OUTPUT_DIR_NAMES.has(entry.name)) continue;
      await walk(rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  try {
    await walk("", 0);
  } catch {
    // Best effort.
  }
  return sortToolchainProjects(projects);
}

/** The files a `.yarnrc.yml` makes yarn load: its `yarnPath` release and its `plugins[].path`, as written. */
export function yarnrcFiles(text: string): string[] {
  return [...text.matchAll(/^(?:yarnPath|\s*(?:-\s+)?path)\s*:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/gm)].map((match) => match[1]!);
}

/** Whether an archive path is a lockfile or manifest (a change reads the dependencies again). */
export function isDependencyFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return lockfileEcosystem(name) !== null || MANIFEST_NAMES.includes(name);
}

// --- the engine's tool-call ends (opencode event stream) --------------------------------------

/** A finished tool call of one session from an engine event (v1 `message.part.updated`, v2 `session.tool.*`), or null. */
export function finishedToolCallOf(payload: unknown): { sessionId: string; call: UsedToolCall } | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.payload) && typeof payload.payload.type === "string") return finishedToolCallOf(payload.payload);
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message.part.updated") {
    const properties = isRecord(payload.properties) ? payload.properties : null;
    const part = properties && isRecord(properties.part) ? properties.part : null;
    if (!part || part.type !== "tool" || !isRecord(part.state)) return null;
    if (part.state.status !== "completed" && part.state.status !== "error") return null;
    const sessionId = text(part.sessionID);
    const call = usedToolCallOf(part);
    return sessionId && call ? { sessionId, call } : null;
  }
  if (/^session\.(?:next\.)?tool\.(?:completed|failed|error|result)$/.test(type)) {
    const data = isRecord(payload.data) ? payload.data : isRecord(payload.properties) ? payload.properties : null;
    if (!data || !isRecord(data.input)) return null;
    const sessionId = text(data.sessionID);
    const tool = toolName(data.tool ?? data.name);
    if (!sessionId || !tool) return null;
    const time = isRecord(data.time) ? data.time : {};
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
    return { sessionId, call: { callId: text(data.callID) ?? text(data.toolCallID) ?? text(data.id), tool, input: data.input, start: number(time.start), end: number(time.end) } };
  }
  return null;
}

const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/** Follows the engine's event stream until `signal` aborts, handing each finished tool call of `sessionId` to `onCall`. Never throws. */
export async function watchToolCallEnds(input: {
  url: string;
  headers: Headers;
  sessionId: string;
  signal: AbortSignal;
  fetch: (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;
  onCall: (call: UsedToolCall) => void;
}): Promise<void> {
  if (input.signal.aborted) return;
  try {
    const headers = new Headers(input.headers);
    headers.set("accept", "text/event-stream");
    const response = await input.fetch(input.url, { headers, signal: input.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = sseFrames(buffer);
      buffer = rest.length > MAX_FRAME_CHARS ? "" : rest;
      for (const raw of payloads) {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        const found = finishedToolCallOf(payload);
        if (found && found.sessionId === input.sessionId) {
          try {
            input.onCall(found.call);
          } catch {
            // Never stops the stream.
          }
        }
      }
    }
  } catch {
    // Aborted, or the engine went away.
  }
}
