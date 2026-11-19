// Ported from the CLI (omnirush-cli src/box/box.js, feat/local-box-backends);
// keep the two in step. Desktop differences, each marked "Desktop:": types;
// what common.ts lists (the sidecars' helpers, the shell-desktop link, the
// container-name prefix).
//
// OmniRush box: one persistent Linux box per project, opt-in. The engine,
// the app and the model calls stay on this machine; the engine's shell tool
// runs in the box (boxsh -> boxd). The project folder is mounted at the same
// path (Windows: /c/Users/...), so the user's editor, git and files stay as
// they are, and chat history stays in the engine's one store. Installs live
// in the box, which survives resume, restarts and new sessions until the
// user resets it.
//
// What runs the box is a backend (backends/: bubblewrap, Apple container,
// WSL containers, OmniRush's WSL distro, Docker, Podman and what speaks
// their CLIs), chosen per machine by backends/index.ts. Every backend runs
// the same boxd from the same pinned image, so a box is the same
// environment everywhere.
//
// Each turn's starting environment is a checkpoint of what the box changed
// (boxd's walk against the image index it took at the first start; a
// container's `diff` as the fallback), then only what changed since the
// session's previous checkpoint, written where the project archive picks it
// up (<state>/sandbox/snapshots/<session>/turn-N.{json,tar}, the same
// transport the 2.2.3 sandbox used; record schema 2).

import { gitChildEnv } from "../git-env.js";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as client from "./client.js";
import type { BoxEndpoint, BoxStat } from "./client.js";
import { DEPS_MAX_BYTES, FILE_MAX_BYTES, HOME_IN_BOX, RECORD_SCHEMA, RUN_DIR, SHIMS_DIR, TAR_MAX_BYTES, boxHome, boxKey, containerName, containerRoot, firstLine, installLogLayout, readJson, readRecord, recordFile, runDir, writeJson, type BoxInstallLog, type BoxLog, type BoxRecord, type BoxRuntime } from "./common.js";
import { driverFor } from "./backends/index.js";
import { boxEgress } from "./backends/bwrap.js";
import type { ListedBox, SpawnLike } from "./backends/types.js";
import { detectStack, imageFor, type BoxImage, type ImagePins } from "./images.js";
import { runCommand, type RunCommand, type RunOptions } from "./run.js";
import { keptImages } from "./retention.mjs";
import { REQUIRED_RULES, shadowRecord, shadowsNotice, type ShadowBind, type ShadowPlan } from "./required.js";

type Env = NodeJS.ProcessEnv;

export { BOX_PORT, DEPS_MAX_BYTES, FILE_MAX_BYTES, GOARCH, GOOS, HOME_IN_BOX, LABEL, RECORD_SCHEMA, RUN_DIR, SHIMS_DIR, TAR_MAX_BYTES, boxHome, boxKey, canonicalRoot, containerName, containerRoot, engineToolsRoot, helperDirs, helperPath, installShell, readRecord, recordFile, runDir, setToolsRoot, wslPath, type BoxInstallLog, type BoxLog, type BoxRecord, type BoxRuntime } from "./common.js";
export { commandUser, createArgs, inspectImage, parseSize, pullImage, resourceArgs, rt, singleFileTar } from "./backends/container.js";
export type { ListedBox } from "./backends/types.js";

/** Where the server saves each chat's turn checkpoints (the project archive carries them: session-archive/index.ts). */
export function boxSnapshotsDir(stateDir: string): string {
  return path.join(stateDir, "sandbox", "snapshots");
}

// --- snapshot rules -------------------------------------------------------------

/** The chain's signature of a path a checkpoint left out: never equal to a real one. */
export const UNKNOWN_SIGNATURE = "?";
/** How many paths of a failed tar a checkpoint lists in `skipped` (the rest: `skipped_omitted`). */
export const SKIPPED_LISTED = 1000;

const H = HOME_IN_BOX;
/** Never part of a turn's environment: runtime state, logs, download caches the ledger replays. */
export const NOISE_PREFIXES = [
  "/run", "/proc", "/sys", "/dev", "/var/log", "/var/cache/apt", "/var/lib/apt/lists", "/var/cache/debconf/templates.dat-old",
  "/opt/omnirush", "/etc/profile.d/omnirush-offline.sh", "/usr/sbin/docker-init", "/sbin/docker-init", "/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/cache/ldconfig/aux-cache",
  `${H}/.cache/pip`, `${H}/.cache/uv`, `${H}/.cache/pre-commit`, `${H}/.cache/yarn`, `${H}/.cache/go-build`, `${H}/.cache/pnpm`,
  `${H}/.npm/_cacache`, `${H}/.npm/_logs`, `${H}/.npm/_update-notifier-last-checked`, `${H}/.npm/_npx`,
  `${H}/.bun/install/cache`, `${H}/.yarn/berry/cache`, `${H}/.local/share/pnpm/store`, `${H}/.cargo/registry/cache`, "/usr/local/cargo/registry/cache",
  `${H}/go/pkg/mod/cache/download`, `${H}/.cache/go-build`, `${H}/.m2/repository/.cache`, `${H}/.gem/cache`, `${H}/.local/share/gem/cache`,
  `${H}/.gradle/caches`, `${H}/.gradle/daemon`, `${H}/.gradle/native`, `${H}/.bash_history`, `${H}/.python_history`,
  `${H}/.node_repl_history`, `${H}/.lesshst`, `${H}/.wget-hsts`, `${H}/.sudo_as_admin_successful`,
];
/**
 * Kept although they are under a cache folder: rebuilt turns need them
 * (bake-off 2026-10-11: pnpm via corepack and Playwright browsers break otherwise).
 */
export const KEEP_PREFIXES = [`${H}/.cache/node/corepack`, `${H}/.cache/ms-playwright`];
export const NOISE_PATTERNS = [/(?:^|\/)__pycache__(?:\/|$)/, /\.py[co]$/, /(?:^|\/)\.(?:pytest|mypy|ruff)_cache(?:\/|$)/, /^\/tmp\/\.bun-[^/]+\.(?:node|so)$/, /^\/tmp\/\.X11-unix/];
export const NOISE_FILES = new Set(["/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow", "/etc/passwd-", "/etc/group-", "/etc/.pwd.lock", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/etc/mtab", "/etc/sudoers.d/omnirush", "/etc/sudoers.d"]);
const CREDENTIAL_NAMES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".netrc", ".git-credentials", ".pypirc", ".password-store", ".vault-token", ".docker"]);
const CREDENTIAL_SUBPATHS = [".config/gh", ".config/gcloud", ".config/hub", ".config/op", ".config/rclone", ".config/doctl"];
const CREDENTIAL_FILE = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|kdbx|jks|keystore))$/i;
/** Project dependency folders whose contents a turn's snapshot carries (capped). */
export const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv"]);

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Package trees: their .pem/.key files are package data (certifi's cacert.pem), never a user's key. */
const PACKAGE_SEGMENT = /(?:^|\/)(?:site-packages|dist-packages|node_modules|gems|pkg\/mod|\.rustup|\.cargo|\.m2|\.gradle|\.npm|\.cache|\.local\/lib|\.local\/share|go|\.bun|\.pyenv|\.nvm|\.venv|venv)(?:\/|$)/;

/** A credential under a home folder (the box's own, or a user's). */
export function credentialPath(entry: string): boolean {
  const home = /^(?:\/root|\/home\/[^/]+)\/(.*)$/.exec(entry);
  if (!home) return false;
  const rel = home[1]!;
  const first = rel.split("/")[0]!;
  if (CREDENTIAL_NAMES.has(first)) return true;
  if (CREDENTIAL_SUBPATHS.some((prefix) => within(rel, prefix))) return true;
  return CREDENTIAL_FILE.test(rel) && !PACKAGE_SEGMENT.test(path.posix.dirname(rel));
}

export type DiffEntry = { kind: string; path: string };

export function parseDiff(stdout: string): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const line of String(stdout).split("\n")) {
    const match = /^([ACD]) (\/.*)$/.exec(line);
    if (match) out.push({ kind: match[1]!, path: match[2]! });
  }
  return out;
}

function ancestors(entry: string): string[] {
  const out: string[] = [];
  let current = path.posix.dirname(entry);
  while (current !== "/" && current !== ".") {
    out.push(current);
    current = path.posix.dirname(current);
  }
  return out;
}

/** What of `docker diff` is the environment: no noise, nothing in a mount, no credentials. */
export function filterChanges(entries: DiffEntry[], { mounts = [] }: { mounts?: string[] } = {}): DiffEntry[] {
  const dropped = new Set<string>();
  const kept: DiffEntry[] = [];
  for (const entry of entries) {
    const p = entry.path;
    const keep = KEEP_PREFIXES.some((prefix) => within(p, prefix));
    const noise = !keep && (NOISE_FILES.has(p)
      || NOISE_PREFIXES.some((prefix) => within(p, prefix))
      || NOISE_PATTERNS.some((pattern) => pattern.test(p))
      || credentialPath(p))
      || mounts.some((target) => within(p, target) || within(target, p));
    if (noise) dropped.add(p);
    else kept.push(entry);
  }
  // A folder listed only because of what was dropped below it is no change.
  // Deepest first, so `C /var` goes once `C /var/lib/apt` has gone.
  const keptBelow = new Map<string, number>();
  for (const { path: p } of kept) for (const parent of ancestors(p)) keptBelow.set(parent, (keptBelow.get(parent) ?? 0) + 1);
  const droppedBelow = new Set<string>();
  for (const p of dropped) for (const parent of ancestors(p)) droppedBelow.add(parent);
  const gone = new Set<string>();
  const deepestFirst = kept.filter(({ kind }) => kind === "C").sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const { path: p } of deepestFirst) {
    if (!droppedBelow.has(p) || keptBelow.get(p)) continue;
    gone.add(p);
    for (const parent of ancestors(p)) {
      keptBelow.set(parent, (keptBelow.get(parent) ?? 1) - 1);
      droppedBelow.add(parent);
    }
  }
  return kept.filter(({ path: p }) => !gone.has(p));
}

function signature(entry: BoxStat): string {
  if (entry.type === "dir") return `d|${entry.mode}|${entry.uid}:${entry.gid}`;
  if (entry.type === "symlink") return `l|${entry.link}|${entry.uid}:${entry.gid}`;
  return `${entry.type}|${entry.mode}|${entry.size}|${entry.mtime_ns}|${entry.ctime_ns}|${entry.uid}:${entry.gid}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

/** Topmost paths only (a removed folder covers what was under it). */
function topmost(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort();
  const out: string[] = [];
  for (const p of sorted) if (!out.some((top) => within(p, top))) out.push(p);
  return out;
}

/**
 * Dependency folders of the project (top level, and one or two levels down).
 * `skip`: project-relative POSIX paths left out (the box's own shadow copies,
 * required.ts: never in a snapshot; a rebuild makes them from the manifests).
 */
export function dependencyFolders(root: string, { maxDepth = 2, skip = null }: { maxDepth?: number; skip?: Set<string> | null } = {}): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (skip?.has(path.relative(root, full).split(path.sep).join("/"))) continue;
      if (DEPENDENCY_DIRS.has(entry.name)) { out.push(full); continue; }
      if (depth < maxDepth && !entry.name.startsWith(".") && entry.name !== "dist" && entry.name !== "build" && entry.name !== "target") visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

// --- the box ---------------------------------------------------------------------

export type BoxState = "starting" | "pulling" | "ready" | "failed";
type OnState = (state: BoxState, error: string | null) => void;

/**
 * Open (create or start) the project's box with the runtime's backend.
 * Returns a Box. `onState` sees "starting", "pulling", "ready", "failed"
 * (the record boxsh reads says the same). Throws only for programming
 * errors; a box that cannot start is a Box with state "failed" and `error`.
 */
export async function openBox({ root, runtime, env = process.env, platform = process.platform, home = boxHome(env), run = runCommand, log = () => {}, shims = null, pkglog = null, pull = true, image: asked = null, onState = () => {}, onLine, spawnImpl, readyMs = 15_000, revive = false, shadows = null }: { root: string; runtime: BoxRuntime; env?: Env; platform?: NodeJS.Platform; home?: string; run?: RunCommand; log?: BoxLog; shims?: string | null; pkglog?: BoxInstallLog | null; pull?: boolean; image?: BoxImage | null; onState?: OnState; onLine?: RunOptions["onLine"]; spawnImpl?: SpawnLike; readyMs?: number; revive?: boolean; shadows?: ShadowPlan | null }): Promise<Box> {
  const projectRoot = path.resolve(root);
  const key = boxKey(projectRoot, { platform });
  const name = containerName(key, env);
  const croot = containerRoot(projectRoot, platform);
  const runFolder = runDir(home, key);
  mkdirSync(path.join(runFolder, "state"), { recursive: true });
  const box = new Box({ key, name, root: projectRoot, croot, runtime, home, runFolder, run, log, platform, env });
  // The app restarts boxd when a shell call finds it stopped (boxsh asks through boxes/<key>.revive).
  box.revive = revive;
  const driver = driverFor(runtime);
  // Shadows only where the backend applies them (driver.shadows: boxrun as root, macOS/Windows hosts).
  const wanted = driver.shadows && shadows && (shadows.binds?.length || Object.keys(shadows.env ?? {}).length) ? shadows : null;
  const lock = await acquireLock(home, key);
  try {
    box.setState("starting", null, onState);
    const chosen = asked ?? imageFor(detectStack(projectRoot), { env });
    let opened: Awaited<ReturnType<typeof driver.open>>;
    for (let attempt = 0; ; attempt += 1) {
      opened = await driver.open({ key, name, root: projectRoot, croot, runtime, run, home, runFolder, image: chosen, pull, shims, pkglog, shadows: wanted, env, platform, log, ...(spawnImpl ? { spawnImpl } : {}), ...(onLine ? { onLine } : {}), onPulling: () => box.setState("pulling", null, onState) });
      if (!opened.ok) return box.fail(opened.error, onState);
      if (opened.created || attempt > 0 || !(await mountReplaced(opened, { croot, readyMs }))) break;
      // The folder was deleted and made again at its path (a new clone) while its box ran:
      // the box still has the old, deleted one, where every command fails. A restart mounts the new one.
      log("info", "box restarted: its folder was replaced since it started", { key });
      await driver.stop(runtime, key, { run, env, home });
    }
    if (opened.created) writeJson(path.join(home, "chains", key, "image.json"), { ...opened.created, backend: runtime.backend ?? runtime.name, created_at: new Date().toISOString() });
    // The first address that answers: the published/loopback one, then the box's own (Apple, WSL any).
    const ways = [opened.endpoint, ...(opened.alternates ?? [])];
    let identity = null;
    for (let i = 0; i < ways.length && !identity; i += 1) {
      box.connect({ ...ways[i]!, uid: opened.uid, gid: opened.gid, containerId: opened.containerId, imageId: opened.imageId });
      const endpoint = box.endpoint!;
      const deadline = Date.now() + (i === ways.length - 1 ? readyMs : Math.min(readyMs, 5_000));
      while (!identity && Date.now() < deadline) {
        identity = await client.ping(endpoint, { timeoutMs: 1_000 });
        if (!identity) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!identity) return box.fail(`the sandbox helper did not answer${boxEgress(env) ? " (farm mode: it does not start where the box cannot be kept offline)" : ""}`, onState);
    box.identity = identity;
    if (shims) await box.installShims().catch((error) => log("warn", "box wrappers not installed", { error: String(error?.message || error) }));
    else if (pkglog) {
      const layout = installLogLayout(opened.mounts, pkglog, platform);
      if (layout === "ro") box.useInstallLog(pkglog);
      else if (layout === "legacy" && pkglog.legacy) {
        // Made before the wrappers were read-only: this box can write all of pkglog/, so it runs
        // its own copies there (this machine runs only the checked ones in pkglog-wrappers/).
        box.useInstallLog({ ...pkglog, bin: pkglog.legacy.bin, py: pkglog.legacy.py });
        log("info", "box made before the read-only install log: it uses its own wrapper copies (Reset sandbox gives it the read-only ones)", { key });
      } else log("info", "box made before the install log: its wrappers are not in this box (Reset sandbox adds them)", { key });
    }
    try { box.useGitIdentity(); } catch (error) { log("warn", "box git identity not set", { error: error instanceof Error ? error.message : String(error) }); }
    // The shadows boxrun really bound (a box another start made before keeps its own set until it stops):
    // what a checkpoint leaves out follows those, whatever this plan said.
    const bound = Array.isArray(opened.shadows) ? opened.shadows.filter((t): t is string => typeof t === "string") : null;
    if (wanted || bound?.length) box.useShadows(wanted ?? { binds: [], env: {}, dirs: [], scanned: 0, truncated: false, ms: 0 }, bound, { lazy: Boolean(wanted) });
    else rmSync(path.join(runFolder, "shadows.json"), { force: true });
    box.setState("ready", null, onState);
    return box;
  } catch (error) {
    return box.fail(error instanceof Error ? error.message : String(error), onState);
  } finally {
    lock.release();
  }
}

async function acquireLock(home: string, key: string, { waitMs = 60_000 }: { waitMs?: number } = {}): Promise<{ release: () => void }> {
  const file = path.join(home, "locks", `${key}.lock`);
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return { release: () => { try { unlinkSync(file); } catch { /* gone */ } } };
    } catch {
      let stale = false;
      try {
        const pid = Number(readFileSync(file, "utf8"));
        stale = !pid || Date.now() - statSync(file).mtimeMs > 120_000 || !alive(pid);
      } catch { stale = true; }
      if (stale) { try { unlinkSync(file); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) return { release: () => {} };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/**
 * Whether the box's project folder is a deleted one (link count 0): the
 * folder on this machine was removed and made again since the box started.
 * Asks boxd at the first address that answers; false when it cannot tell.
 */
export async function mountReplaced(opened: { endpoint?: BoxEndpoint; alternates?: BoxEndpoint[] }, { croot, readyMs = 15_000, exec = client.exec, ping = client.ping }: { croot: string; readyMs?: number; exec?: typeof client.exec; ping?: typeof client.ping }): Promise<boolean> {
  for (const way of [opened.endpoint, ...(opened.alternates ?? [])]) {
    if (!way) continue;
    const deadline = Date.now() + Math.min(readyMs, 5_000);
    while (Date.now() < deadline) {
      if (await ping(way, { timeoutMs: 1_000 })) {
        try {
          const res = await exec(way, ["stat", "-c", "%h", croot], { cwd: "/", timeoutMs: 5_000 });
          return res.code === 0 && String(res.stdout).trim() === "0";
        } catch {
          return false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"; }
}

export type CheckpointSummary = {
  schema: number;
  label: string;
  turn: number | null;
  /** The chat's own turn number of the prompt this checkpoint comes before (when known). */
  session_turn?: number;
  tar: string | null;
  bytes: number;
  sha256: string | null;
  full: boolean;
  leaf?: true;
  delta: { parent: string | null; changed: string[]; removed: string[] };
  checkpoint: Record<string, unknown>;
  skipped: Array<{ path: string; size: number; reason: string }>;
  /** Paths left out but not listed in `skipped`, counted by reason. */
  skipped_omitted?: Record<string, number>;
  deps?: Record<string, unknown>;
  stats: { source: string; diff_entries: number; kept: number; copied: number; removed: number; diff_ms: number; stat_ms: number; tar_ms: number; total_ms: number; warning?: string; tar_error?: string };
};

export type Checkpoint = {
  summary: CheckpointSummary;
  commit: (to?: string) => CheckpointSummary;
  discard: () => void;
};

type Chain = { container: string; last: string | null; signatures: Record<string, string> };

export type BoxLabel = {
  kind: string;
  box_id: string;
  /** The backend id (backends/index.ts BACKENDS). */
  backend: string;
  runtime: { name: string; flavor: string; version: string | null; rootless: boolean };
  image: { ref: string | null; digest: string | null; stack: string | null };
  host_os: string;
  host_arch: string;
};

type BoxInit = { key: string; name: string; root: string; croot: string; runtime: BoxRuntime; home: string; runFolder: string; run: RunCommand; log: BoxLog; platform: NodeJS.Platform; env: Env };

export class Box {
  readonly key: string;
  readonly name: string;
  readonly root: string;
  readonly croot: string;
  readonly runtime: BoxRuntime;
  readonly home: string;
  readonly runFolder: string;
  readonly run: RunCommand;
  readonly log: BoxLog;
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  readonly container: string;
  state: BoxState = "starting";
  error: string | null = null;
  /** The record tells boxsh the app restarts boxd when asked. */
  revive = false;
  endpoint: BoxEndpoint | null = null;
  identity: Record<string, unknown> | null = null;
  pathPrefix = "";
  uid: number | undefined;
  gid: number | undefined;
  containerId: string | undefined;
  imageId: string | undefined;
  /** The box's own build folders in use (macOS/Windows hosts; required.ts), null with none. */
  shadows: ShadowPlan | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ key, name, root, croot, runtime, home, runFolder, run, log, platform, env }: BoxInit) {
    this.key = key;
    this.name = name;
    this.root = root;
    this.croot = croot;
    this.runtime = runtime;
    this.home = home;
    this.runFolder = runFolder;
    this.run = run;
    this.log = log;
    this.platform = platform;
    this.env = env;
    this.container = name;
  }

  connect({ host = "127.0.0.1", port, token, uid, gid, containerId, imageId }: BoxEndpoint & { uid: number; gid: number; containerId: string; imageId: string }): void {
    this.endpoint = { host, port, token };
    this.uid = uid;
    this.gid = gid;
    this.containerId = containerId;
    this.imageId = imageId;
  }

  execFallback(): boolean {
    return Boolean(driverFor(this.runtime).execFallback) && !boxEgress(this.env);
  }

  /** The record boxsh reads (boxes/<key>.json). */
  writeRecord(): void {
    const fallback = this.execFallback();
    const record: BoxRecord = {
      v: 1, key: this.key, root: this.root, croot: this.croot, container: this.name, backend: this.runtime.backend ?? this.runtime.name ?? "",
      // boxsh's fallback when boxd does not answer: `<runtime> exec` (container engines and wslc only; never
      // in farm runs, where it would run the command outside boxd's offline network).
      runtime: fallback ? this.runtime.bin ?? "" : "", runtime_args: fallback ? this.runtime.prefix ?? [] : [],
      host: this.endpoint?.host ?? "127.0.0.1", port: this.endpoint?.port ?? 0, token: this.endpoint?.token ?? "",
      state: this.state, error: this.error ?? "", uid: this.uid ?? 0, gid: this.gid ?? 0, home: HOME_IN_BOX, shell: "/bin/bash",
      path_prefix: this.pathPrefix, env_file: `${RUN_DIR}/env`, updated: Date.now(), pid: process.pid, revive: this.revive,
      // The agent's box notice adds this line (plugin-lib.ts BOX_NOTE): the CLI's words, so both apps tell the model the same.
      ...(this.shadows ? { shadows_note: shadowsNotice(this.shadows, this.platform, "cli") ?? undefined } : {}),
    };
    writeJson(recordFile(this.home, this.key), record);
  }

  setState(state: BoxState, error: string | null, onState: OnState = () => {}): void {
    this.state = state;
    this.error = error;
    this.writeRecord();
    onState(state, error);
  }

  fail(error: string, onState?: OnState): Box {
    this.setState("failed", error, onState);
    this.log("warn", "box failed", { key: this.key, error });
    return this;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  /** The image the container runs (pin, digest, stack) as recorded at creation. */
  image(): { ref: string | null; digest: string | null; id: string | null; stack: string | null; created_at?: string } {
    return readJson(path.join(this.home, "chains", this.key, "image.json")) ?? { ref: null, digest: null, id: this.imageId ?? null, stack: null };
  }

  /** The package-manager wrappers, installed inside (their install.sh), and the env they need. */
  async installShims(): Promise<void> {
    const res = await client.exec(this.endpoint!, ["/bin/sh", `${SHIMS_DIR}-src/install.sh`, SHIMS_DIR, `${RUN_DIR}/ledger.jsonl`, `${RUN_DIR}/state`], { timeoutMs: 30_000, root: true });
    if (res.code !== 0) throw new Error(firstLine(res.stderr) || `install.sh exited ${res.code}`);
    const lines: string[] = [];
    for (const raw of res.stdout.split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
      if (!match) continue;
      const [, name, value] = match;
      // `dir:$PATH`, `dir${PYTHONPATH:+:$PYTHONPATH}`: our part only (boxd adds PATH itself).
      const own = value!.replace(/\$\{[A-Z_]+:\+[^}]*\}/g, "").replace(/:?\$[A-Z_]+$/, "").replace(/ \$\{NODE_OPTIONS[^}]*\}$/, "");
      if (name === "PATH") this.pathPrefix = own;
      else lines.push(`${name}=${own}`);
    }
    // boxd puts BOXD_PATH_PREFIX in front of the image's own PATH.
    if (this.pathPrefix) lines.push(`BOXD_PATH_PREFIX=${this.pathPrefix}`);
    this.writeEnv(lines);
    this.writeRecord();
  }

  /**
   * The install log's wrappers (phase 1) in front of the box's PATH and its
   * pip hook on PYTHONPATH; the per-run folder they note calls in comes with
   * each call (OMNIRUSH_PKGLOG_DIR, forwarded by boxsh).
   */
  useInstallLog(pkglog: BoxInstallLog): void {
    const inBox = (p: string) => containerRoot(p, this.platform);
    this.pathPrefix = inBox(pkglog.bin);
    // What sudo (root) notes in the per-run folders goes back to the user, so this machine can clear it.
    this.writeEnv([`BOXD_PATH_PREFIX=${this.pathPrefix}`, `PYTHONPATH=${inBox(pkglog.py)}`, `BOXD_CHOWN_DIRS=${inBox(pkglog.raw)}`]);
    this.writeRecord();
  }

  /**
   * This machine's git identity (`git config --global user.name/email`) as the box's
   * system git config (<run>/gitconfig, GIT_CONFIG_SYSTEM in the env file): commits in
   * the box carry the user's name, as on this machine. Lowest priority (the box's own
   * global or repository config wins); never in a checkpoint. CLI: the same.
   */
  useGitIdentity(read: (env: Env) => { name: string; email: string } = hostGitIdentity): void {
    const { name, email } = read(this.env);
    const file = path.join(this.runFolder, "env");
    let lines: string[] = [];
    try { lines = readFileSync(file, "utf8").split("\n").filter((line) => line && !line.startsWith("GIT_CONFIG_SYSTEM=")); } catch { /* none yet */ }
    if (name || email) {
      const quote = (value: string) => `"${value.replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      writeFileSync(path.join(this.runFolder, "gitconfig"), `[user]\n${name ? `\tname = ${quote(name)}\n` : ""}${email ? `\temail = ${quote(email)}\n` : ""}`, { mode: 0o644 });
      lines.push(`GIT_CONFIG_SYSTEM=${RUN_DIR}/gitconfig`);
    }
    this.writeEnv(lines);
  }

  /**
   * The box's own build folders (required.ts shadowPlan): `applied` lists the
   * folders inside that boxrun bound (null: all of the plan). Their
   * redirections (UV_PROJECT_ENVIRONMENT, ...) go in the env file for every
   * command; shadows.json in the run folder tells boxd which folders are
   * shadowed and what to bind when a new package appears mid-chat. CLI: the same.
   */
  useShadows(plan: ShadowPlan, applied: string[] | null = null, { lazy: mid = true }: { lazy?: boolean } = {}): void {
    // `applied` (boxrun's answer) wins over the plan: a box started before keeps the set it was made with.
    const binds = Array.isArray(applied)
      ? applied.map((target) => plan.binds.find((b) => b.target === target) ?? this.shadowOf(target)).filter((b): b is ShadowBind => b !== null)
      : plan.binds;
    this.shadows = { ...plan, binds, dirs: [...new Set(binds.map((b) => b.path.split("/").pop()!))] };
    const rules = REQUIRED_RULES.shadows;
    // Folders shadowed mid-chat only under the plan's rules (the required sandbox); none otherwise.
    const lazy = mid ? rules.binds.filter((rule) => rule.even_if_absent).map((rule) => ({ dir: rule.dir, when_any: rule.when_any })) : [];
    writeJson(path.join(this.runFolder, "shadows.json"), { v: 1, root: this.croot, store: rules.store, active: binds.map((b) => b.target), lazy, limits: rules.limits, skip_dirs: rules.skip_dirs }, 0o644);
    // The env file keeps what the wrappers and the git identity wrote; the redirections are set once.
    const names = Object.keys(plan.env ?? {});
    const file = path.join(this.runFolder, "env");
    let lines: string[] = [];
    try { lines = readFileSync(file, "utf8").split("\n").filter((line) => line && !names.some((name) => line.startsWith(`${name}=`))); } catch { /* none yet */ }
    lines.push(...Object.entries(plan.env ?? {}).map(([k, v]) => `${k}=${v}`));
    this.writeEnv(lines);
    this.writeRecord();
  }

  /** The env file boxd reads before each command: this machine's time zone first (one line; the writers above keep the file's lines), then `lines`. CLI: writeEnv. */
  private writeEnv(lines: string[]): void {
    const zone = hostZone(this.env);
    writeFileSync(path.join(this.runFolder, "env"), `${[...(zone ? [`TZ=${zone}`] : []), ...lines.filter((line) => !line.startsWith("TZ="))].join("\n")}\n`, { mode: 0o644 });
  }

  /** A bound folder (inside path) the plan does not list: its project-relative path, or null outside the project. */
  shadowOf(target: string): ShadowBind | null {
    const rel = path.posix.relative(this.croot, path.posix.normalize(String(target)));
    if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) return null;
    return { path: rel, existed: false, target: `${this.croot}/${rel}` };
  }

  /** The shadows in use now: the start's, plus the folders boxd bound mid-chat (shadows-lazy.json in the run folder). */
  currentShadows(): ShadowPlan | null {
    if (!this.shadows) return null;
    const lazy = readJson<{ binds?: Array<{ path?: unknown }> }>(path.join(this.runFolder, "shadows-lazy.json"));
    const extra = (Array.isArray(lazy?.binds) ? lazy.binds : []).filter((b): b is { path: string } => typeof b?.path === "string" && !this.shadows!.binds.some((x) => x.path === b.path));
    if (!extra.length) return this.shadows;
    const more: ShadowBind[] = extra.map((b) => ({ path: b.path, existed: false, target: `${this.croot}/${b.path}` }));
    return { ...this.shadows, binds: [...this.shadows.binds, ...more] };
  }

  /** The prompt number the package-manager wrappers write into their lines. */
  setTurn(turn: number): void {
    try { writeFileSync(path.join(this.runFolder, "state", "turn"), `${turn}\n`); } catch { /* best effort */ }
  }

  /** Where the wrappers' lines land on this machine. */
  get ledgerPath(): string {
    return path.join(this.runFolder, "ledger.jsonl");
  }

  /** The record a session's snapshots folder starts with (record.json; environment.sandbox in uploads). */
  describe() {
    const image = this.image();
    return {
      schema: RECORD_SCHEMA,
      kind: "omnirush-box",
      box: { id: `box_${this.key}`, container: this.name, created_at: image.created_at ?? null },
      backend: this.runtime.backend ?? this.runtime.name,
      runtime: { name: this.runtime.name, version: this.runtime.version ?? null, flavor: this.runtime.flavor ?? "unknown", rootless: Boolean(this.runtime.rootless), os: "linux", arch: this.runtime.arch || null },
      image: { ref: image.ref ?? null, digest: image.digest ?? null, id: image.id ?? this.imageId ?? null, stack: image.stack ?? null },
      host: { os: this.platform, arch: process.arch, os_version: os.release() },
      project: { host_root: this.root, container_root: this.croot },
      user: { uid: this.uid ?? 0, gid: this.gid ?? 0, home: HOME_IN_BOX },
      environment: { HOME: HOME_IN_BOX, shims: this.pathPrefix ? SHIMS_DIR : null },
      excluded: { prefixes: NOISE_PREFIXES, keep: KEEP_PREFIXES, patterns: NOISE_PATTERNS.map(String), dependency_dirs: [...DEPENDENCY_DIRS] },
      // The box's own copies of build folders (macOS/Windows hosts), never in a checkpoint.
      ...(this.shadows ? { [REQUIRED_RULES.shadows.record_key]: shadowRecord(this.currentShadows()) } : {}),
    };
  }

  /** The block trace envelopes carry as environment.sandbox. */
  label(): BoxLabel {
    const d = this.describe();
    return { kind: d.kind, box_id: d.box.id, backend: d.backend, runtime: { name: d.runtime.name, flavor: d.runtime.flavor, version: d.runtime.version, rootless: d.runtime.rootless }, image: { ref: d.image.ref, digest: d.image.digest, stack: d.image.stack }, host_os: d.host.os, host_arch: d.host.arch };
  }

  /** Run a command in the box (toolchain probes, status). */
  exec(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<client.ExecResult> {
    return client.exec(this.endpoint!, argv, opts);
  }

  /**
   * The checkpoint of turn `turn` for a session: what the box changed since
   * the session's previous committed checkpoint in `dir` (all of it for the
   * first). It is staged: `commit()` places it in `dir` and makes it the
   * parent of the next one (`leaf`: placed, never a parent: `final`);
   * `discard()` drops it (a turn that never came). Checkpoints are taken one
   * at a time. Resolves { summary, commit, discard }.
   */
  checkpoint(dir: string, turn: number | null, opts: { label?: string | null; leaf?: boolean; sessionTurn?: number | null; deps?: boolean; tarMax?: number; depsMax?: number } = {}): Promise<Checkpoint> {
    const work = this.queue.then(() => this.takeCheckpoint(dir, turn, opts));
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async takeCheckpoint(dir: string, turn: number | null, { label: asked = null, leaf = false, sessionTurn = null, deps = this.env.OMNIRUSH_BOX_DEPS !== "off", tarMax = Number(this.env.OMNIRUSH_BOX_TAR_MAX) || TAR_MAX_BYTES, depsMax = Number(this.env.OMNIRUSH_BOX_DEPS_MAX) || DEPS_MAX_BYTES }: { label?: string | null; leaf?: boolean; sessionTurn?: number | null; deps?: boolean; tarMax?: number; depsMax?: number } = {}): Promise<Checkpoint> {
    if (!this.ready || !this.endpoint) throw new Error(`the sandbox is ${this.state}`);
    const endpoint = this.endpoint;
    const t0 = Date.now();
    mkdirSync(dir, { recursive: true });
    const chainFile = path.join(dir, ".chain.json");
    let chain = readJson<Chain>(chainFile);
    const full = !chain || chain.container !== this.containerId;
    if (!chain || full) chain = { container: this.containerId ?? "", last: null, signatures: {} };

    // What the box changed against its image: boxd's walk (fast, any runtime), else `diff`
    // (overlay2's naive diff walks the whole image on most Linux kernels: ~1 s for 1 GB).
    const mounts = [this.croot, RUN_DIR, `${SHIMS_DIR}-src`];
    // The shadow store's mount point (made at the box's start) is no change of the box.
    const shadowed = this.currentShadows();
    const walked = await client.changes(endpoint, shadowed ? [...NOISE_PREFIXES, path.posix.dirname(REQUIRED_RULES.shadows.store)] : NOISE_PREFIXES, KEEP_PREFIXES);
    let entries: DiffEntry[];
    let stats: BoxStat[];
    let source = "boxd";
    if (walked) {
      entries = filterChanges(walked.map((entry) => ({ kind: entry.kind, path: entry.path })), { mounts });
      const keptPaths = new Set(entries.map((entry) => entry.path));
      stats = walked.filter((entry) => entry.kind !== "D" && keptPaths.has(entry.path));
    } else {
      source = "diff";
      const driver = driverFor(this.runtime);
      if (!driver.diff) throw new Error("the sandbox helper could not list the changes");
      const diff = await driver.diff(this.runtime, this.key, { run: this.run, home: this.home, env: this.env });
      if (diff.code !== 0) throw new Error(`diff failed: ${firstLine(diff.stderr)}`);
      entries = filterChanges(parseDiff(diff.stdout), { mounts });
      const present = entries.filter((entry) => entry.kind !== "D").map((entry) => entry.path);
      stats = present.length ? await client.stat(endpoint, present) : [];
    }
    const tDiff = Date.now();
    // Project dependency folders, walked inside (they are in the bind mount, which `diff` never lists).
    let depStats: BoxStat[] = [];
    let depsInfo: { folders: number; entries: number; truncated: boolean } | null = null;
    if (deps) {
      const skip = shadowed ? new Set(shadowed.binds.map((b) => b.path)) : null;
      const folders = dependencyFolders(this.root, { skip }).map((folder) => path.posix.join(this.croot, path.relative(this.root, folder).split(path.sep).join("/")));
      if (folders.length) {
        const walkedDeps = await client.walk(endpoint, folders);
        depStats = (walkedDeps.entries ?? []).filter((entry) => !NOISE_PATTERNS.some((pattern) => pattern.test(entry.path)) && !/\/node_modules\/\.cache(\/|$)/.test(entry.path));
        depsInfo = { folders: folders.length, entries: depStats.length, truncated: Boolean(walkedDeps.truncated) };
      }
    }
    const tStat = Date.now();
    const now: Record<string, string> = {};
    const sized = new Map<string, BoxStat>();
    for (const entry of [...stats, ...depStats]) {
      if (entry.type === "missing" || entry.type === "other") continue;
      now[entry.path] = signature(entry);
      sized.set(entry.path, entry);
    }
    const before = chain.signatures ?? {};
    const isDep = (p: string) => p.startsWith(`${this.croot}/`);
    // In the parent but not changed now: really gone (removed), or back at
    // the image's state, which the rebuild only has if this layer carries it.
    const left = Object.keys(before).filter((p) => !(p in now));
    const gone: string[] = [];
    if (left.length) {
      for (const entry of await client.stat(endpoint, left)) {
        if (entry.type === "missing") gone.push(entry.path);
        else if (entry.type !== "other") {
          now[entry.path] = signature(entry);
          sized.set(entry.path, entry);
        }
      }
    }
    const candidates = Object.keys(now).filter((p) => before[p] !== now[p]).sort();
    const removed = topmost(gone);
    // Caps: whole files past FILE_MAX left out; dependency folders up to depsMax; the tar up to tarMax.
    const skipped: Array<{ path: string; size: number; reason: string }> = [];
    let depBytes = 0;
    let total = 0;
    let changed: string[] = [];
    let depsCut = false;
    for (const p of [...candidates.filter((x) => !isDep(x)), ...candidates.filter(isDep)]) {
      const entry = sized.get(p);
      const size = entry?.type === "file" ? entry.size ?? 0 : 0;
      if (size > FILE_MAX_BYTES) { skipped.push({ path: p, size, reason: "too_large" }); continue; }
      if (isDep(p)) {
        if (depsCut || depBytes + size > depsMax) { depsCut = true; skipped.push({ path: p, size, reason: "dependency_cap" }); continue; }
        depBytes += size;
      }
      if (total + size > tarMax) { skipped.push({ path: p, size, reason: "tar_cap" }); continue; }
      total += size;
      changed.push(p);
    }
    const label = asked ?? `turn-${turn}`;
    const stage = path.join(dir, `.stage-${label}-${process.pid}-${randomBytes(3).toString("hex")}`);
    mkdirSync(stage, { recursive: true });
    let tarInfo: client.TarResult | null = null;
    let tarError: string | null = null;
    // Paths the tar does not carry after all. A failed tar lists its first
    // SKIPPED_LISTED paths (a failed npm install would make the summary huge), the
    // rest as a count; every one still gets the "unknown" signature below.
    const leftOut = new Set<string>();
    const omitted: Record<string, number> = {};
    const leaveOut = (items: client.SkippedPath[]) => {
      let listed = skipped.filter((item) => item.reason === "tar_failed").length;
      for (const { path: p, reason } of items) {
        const entry = sized.get(p);
        const size = entry?.type === "file" ? entry.size ?? 0 : 0;
        leftOut.add(p);
        if (isDep(p)) depBytes -= size;
        if (reason === "tar_failed" && listed >= SKIPPED_LISTED) { omitted[reason] = (omitted[reason] ?? 0) + 1; continue; }
        if (reason === "tar_failed") listed += 1;
        skipped.push({ path: p, size, reason });
      }
      changed = changed.filter((p) => !leftOut.has(p));
    };
    if (changed.length) {
      try {
        tarInfo = await client.tarTo(endpoint, changed, path.join(stage, `${label}.tar`));
      } catch (error) {
        // A tar that cannot be written never stops the turn: the checkpoint is
        // incomplete, its paths left out (so the next checkpoint tries them again).
        tarError = firstLine(error instanceof Error ? error.message : String(error)) || "tar failed";
        this.log("warn", "box checkpoint tar failed", { label, paths: changed.length, error: tarError });
        rmSync(path.join(stage, `${label}.tar`), { force: true });
        leaveOut(changed.map((p) => ({ path: p, reason: "tar_failed" })));
      }
      if (tarInfo?.skipped?.length) leaveOut(tarInfo.skipped);
      if (tarInfo && !changed.length) {
        tarInfo = null;
        rmSync(path.join(stage, `${label}.tar`), { force: true });
      }
    }
    for (const item of skipped) leftOut.add(item.path);
    const tTar = Date.now();
    // What a later checkpoint compares with. A path left out keeps an "unknown"
    // signature (not none): the next checkpoint looks at it again, so it is copied
    // then if it is still there, or listed as removed if it is gone.
    const signatures: Record<string, string> = {};
    for (const [p, sig] of Object.entries(now)) signatures[p] = leftOut.has(p) ? UNKNOWN_SIGNATURE : sig;
    const image = this.image();
    const parent = full ? null : chain.last;
    const id = `cp_${createHash("sha256").update(canonical({ schema: RECORD_SCHEMA, box: this.key, container: this.containerId, label, turn, parent, image: image.digest || image.id, changed, removed, sha256: tarInfo?.sha256 ?? null })).digest("hex")}`;
    const summary: CheckpointSummary = {
      schema: RECORD_SCHEMA,
      label,
      turn: turn ?? null,
      // The chat's own turn number of this checkpoint's prompt: a chat that ran on this
      // machine before its box was on has its first checkpoint (turn-1) before a later prompt.
      ...(sessionTurn && Number.isInteger(sessionTurn) && sessionTurn > 0 ? { session_turn: sessionTurn } : {}),
      tar: tarInfo ? `${label}.tar` : null,
      bytes: tarInfo?.bytes ?? 0,
      sha256: tarInfo?.sha256 ?? null,
      full,
      ...(leaf ? { leaf: true as const } : {}),
      delta: { parent, changed, removed },
      checkpoint: { schema: RECORD_SCHEMA, id, parent, turn: turn ?? null, image: { ref: image.ref ?? null, digest: image.digest ?? null }, status: tarError ? "incomplete" : "complete", capturedAt: new Date().toISOString() },
      skipped,
      ...(Object.keys(omitted).length ? { skipped_omitted: omitted } : {}),
      ...(depsInfo ? { deps: { ...depsInfo, bytes: depBytes, cut: depsCut } } : {}),
      stats: { source, diff_entries: entries.length, kept: Object.keys(now).length, copied: changed.length, removed: removed.length, diff_ms: tDiff - t0, stat_ms: tStat - tDiff, tar_ms: tTar - tStat, total_ms: Date.now() - t0, ...(tarInfo?.warning ? { warning: tarInfo.warning } : {}), ...(tarError ? { tar_error: tarError } : {}) },
    };
    writeJson(path.join(stage, `${label}.json`), summary, 0o600);
    this.log(tarError ? "warn" : "info", "box checkpoint", { label, full, copied: changed.length, removed: removed.length, bytes: summary.bytes, ms: summary.stats.total_ms, ...(tarError ? { status: "incomplete" } : {}) });
    let settled = false;
    const record = this.describe();
    return {
      summary,
      /** Place it in `to` (default: the folder it was taken for) and, unless a leaf, chain on from it. */
      commit: (to = dir) => {
        if (settled) return summary;
        settled = true;
        mkdirSync(to, { recursive: true });
        const recordPath = path.join(to, "record.json");
        // A folder boxd shadowed mid-chat is in the next checkpoint's record (shadows are never in the tar).
        const shadowsNow = (record as { shadows?: unknown }).shadows;
        if (!existsSync(recordPath) || (shadowsNow && JSON.stringify(readJson<{ shadows?: unknown }>(recordPath)?.shadows ?? null) !== JSON.stringify(shadowsNow))) writeJson(recordPath, record, 0o600);
        rmSync(path.join(to, `${label}.tar`), { force: true });
        for (const name of readdirSync(stage)) renameSync(path.join(stage, name), path.join(to, name));
        rmSync(stage, { recursive: true, force: true });
        if (!leaf) writeJson(path.join(to, ".chain.json"), { container: this.containerId, last: id, label, turn, signatures }, 0o600);
        return summary;
      },
      discard: () => {
        if (settled) return;
        settled = true;
        rmSync(stage, { recursive: true, force: true });
      },
    };
  }

  /** Disk the box's own layer uses (bytes), when the backend says. */
  upperBytes(): Promise<number | null> {
    return driverFor(this.runtime).upperBytes(this.runtime, this.key, { run: this.run, home: this.home, env: this.env });
  }
}

// --- status, reset, gc --------------------------------------------------------------

type Removed = Array<{ kind: string; name: string; reason: string; size?: string | null; path?: string; dryRun?: boolean }>;

/** Boxes on this machine: { key, name, root, running, image, created }[] */
/** Where boxsh asks the app to start a stopped boxd again (launch.ts boxRun). */
export function reviveFile(home: string, key: string): string {
  return path.join(home, "boxes", `${key}.revive`);
}

export async function listBoxes(runtime: BoxRuntime, { run = runCommand, env = process.env, home = boxHome(env) }: { run?: RunCommand; env?: Env; home?: string } = {}): Promise<ListedBox[]> {
  return driverFor(runtime).list(runtime, { run, env, home });
}

/** Remove a project's box (the next start makes a new one). */
export async function resetBox(runtime: BoxRuntime, root: string, { env = process.env, platform = process.platform, home = boxHome(env), run = runCommand }: { env?: Env; platform?: NodeJS.Platform; home?: string; run?: RunCommand } = {}): Promise<{ key: string; removed: boolean }> {
  const key = boxKey(root, { platform });
  const res = await driverFor(runtime).remove(runtime, key, { run, env, home });
  rmSync(recordFile(home, key), { force: true });
  rmSync(path.join(home, "chains", key), { recursive: true, force: true });
  return { key, removed: Boolean(res.removed) };
}

/** Stop a project's box (its installs stay; the next chat starts it again). */
export async function stopBox(runtime: BoxRuntime, root: string, { env = process.env, platform = process.platform, home = boxHome(env), run = runCommand }: { env?: Env; platform?: NodeJS.Platform; home?: string; run?: RunCommand } = {}): Promise<{ key: string; stopped: boolean }> {
  const key = boxKey(root, { platform });
  return { key, ...(await driverFor(runtime).stop(runtime, key, { run, env, home })) };
}

/**
 * Remove boxes whose folder is gone or that were not used for `maxIdleDays`,
 * and box images no box uses that are neither the current nor the previous pins (retention.mjs). Only boxes and
 * images labelled/named as OmniRush boxes are touched; nothing is pruned.
 */
export async function gcBoxes(runtime: BoxRuntime, { env = process.env, home = boxHome(env), run = runCommand, maxIdleDays = 30, pins = null, now = Date.now(), exists = existsSync, dryRun = false }: { env?: Env; home?: string; run?: RunCommand; maxIdleDays?: number; pins?: ImagePins | null; now?: number; exists?: (file: string) => boolean; dryRun?: boolean } = {}): Promise<Removed> {
  const driver = driverFor(runtime);
  const removed: Removed = [];
  const boxes = await driver.list(runtime, { run, env, home });
  for (const box of boxes) {
    // Only this box home's own boxes (the ones it has a record of), never one another live process uses:
    // a shared engine (rootful Docker) lists every user's boxes, and another user's folder can look gone here.
    const rec = readRecord(home, box.key);
    if (!rec || (rec.pid && rec.pid !== process.pid && alive(rec.pid)) || (rec.root && box.root && path.resolve(rec.root) !== path.resolve(box.root))) continue;
    const idle = rec.updated ? (now - rec.updated) / 86_400_000 : Infinity;
    if ((box.root && !exists(box.root)) || idle > maxIdleDays) {
      if (dryRun) { removed.push({ kind: "container", name: box.name, reason: box.root && !exists(box.root) ? "folder gone" : "unused", dryRun: true }); continue; }
      const res = await driver.remove(runtime, box.key, { run, env, home });
      if (res.removed) {
        removed.push({ kind: "container", name: box.name, reason: box.root && !exists(box.root) ? "folder gone" : "unused" });
        rmSync(recordFile(home, box.key), { force: true });
        rmSync(path.join(home, "chains", box.key), { recursive: true, force: true });
      }
    }
  }
  // Kept: the current pins, the box version before them, and every image a box uses.
  const keep = keptImages(home, pins, { write: !dryRun, now });
  // The first run knows only the current pins (the previous ones were never recorded): no image goes yet.
  if (keep.firstRun) return removed;
  const used = new Set<string>();
  for (const box of await driver.list(runtime, { run, env, home })) used.add(box.image);
  removed.push(...await driver.gcImages(runtime, { run, env, home, current: keep.refs, keep, used, dryRun, now }));
  return removed;
}

/** Count of complete turn checkpoints in a session's folder (resume continues after it). */
export function savedTurns(dir: string): number {
  try {
    return readdirSync(dir).map((name) => /^turn-(\d+)\.json$/.exec(name)?.[1]).filter((n): n is string => Boolean(n)).map(Number).reduce((a, b) => Math.max(a, b), 0);
  } catch {
    return 0;
  }
}

/** The time zone the box's commands get: TZ as set here, else the zone this machine uses (the box's own is UTC). CLI: the same. */
export function hostZone(env: Env = process.env): string | null {
  // An empty TZ is UTC to glibc, the box's own zone already (and Intl calls it "Etc/Unknown").
  if (env.TZ === "") return null;
  // A file (TZ=:/etc/localtime) would name the box's own file: the zone name it points at instead.
  if (/^:?\//.test(env.TZ ?? "")) {
    try {
      return realpathSync(env.TZ!.replace(/^:/, "")).split("/zoneinfo/")[1] || null;
    } catch {
      return null;
    }
  }
  const zone = env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone !== "Etc/Unknown" ? zone : null;
}

/** This machine's `git config --global user.name` and `user.email` (empty when unset or git is missing). */
export function hostGitIdentity(env: Env = process.env): { name: string; email: string } {
  const get = (field: string) => {
    try {
      return execFileSync("git", ["config", "--global", "--get", field], { encoding: "utf8", timeout: 3_000, env: gitChildEnv({}, env), stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  return { name: get("user.name"), email: get("user.email") };
}
