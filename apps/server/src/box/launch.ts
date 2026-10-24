// Ported from the CLI (omnirush-cli src/box/launch.js,
// feat/local-box-backends); keep the shared parts in step. Desktop
// differences: the per-project choice lives in the workspace's OmniRush
// settings (service.ts), not box.json (box.json keeps only the machine's
// backend, as the CLI's does); the plan is per workspace (one engine serves
// every project); a run tracks its turns per chat; there is no --sandbox or
// --sandbox-backend flag (OMNIRUSH_BOX=1|0 and OMNIRUSH_BOX_BACKEND still
// override); a download with no detached command (the WSL distro) runs in
// this process.
//
// Whether a chat runs in its project's box, and the box's part in a run:
// the engine config bits (shell, plugin), the per-turn checkpoints, the
// trace label.
//
// Never blocking: the runtime probe and the image check are bounded; a
// missing image starts a download in the background and the project runs on
// this machine meanwhile (one line says so); the box itself starts in the
// background, and a shell call waits for it (boxsh).

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

import * as client from "./client.js";
import { boxKey, containerName, containerRoot, gcBoxes, installShell, openBox, recordFile, reviveFile, savedTurns, type Box, type BoxInstallLog, type BoxLabel, type BoxLog, type BoxRuntime, type CheckpointSummary } from "./box.js";
import { driverFor, normalizeBackend } from "./backends/index.js";
import type { BoxExec } from "./backends/types.js";
import { detectStack, imageFor, loadPins, type BoxImage } from "./images.js";
import { portForwards, type PortForwardOptions, type PortForwards } from "./ports.js";
import { rememberPins } from "./retention.mjs";
import { requiredFallback, shadowPlan, shadowsApply, shadowsNotice, type RequiredFallback, type ShadowPlan } from "./required.js";
import { detectRuntime, runCommand, type RunCommand, type RuntimeResult } from "./runtime.js";

export const MODES = ["off", "offer", "on"] as const;
export type ServerBoxDefault = (typeof MODES)[number];
/** A project's own choice: "on", "off", or none (the server's default). */
export type ProjectBoxMode = "on" | "off" | null;

function isMode(value: unknown): value is ServerBoxDefault {
  return MODES.some((mode) => mode === value);
}

// --- the server's default -----------------------------------------------------------

/** The server's switch as last seen (GET /collect/capabilities -> local_box.default). */
export function serverDefault(stateDir: string): ServerBoxDefault {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    return isMode(value?.default) ? value.default : "off";
  } catch {
    return "off";
  }
}

/** The server's allowlist of backends (local_box.backends; null: any). */
export function serverBackends(stateDir: string): string[] | null {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    return Array.isArray(value?.backends) ? value.backends.filter((b: unknown): b is string => typeof b === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Whether the server requires the sandbox for this device's new chats
 * (local_box.required, said only to a client at or above its minimum
 * version), what a machine that cannot run it does (`required_fallback`), and
 * whether images are fetched at app start (`setup.prefetch`). An older
 * server: not required, no prefetch.
 */
export function serverRequired(stateDir: string): { required: boolean; fallback: RequiredFallback; prefetch: boolean } {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    const required = value?.required === true;
    // Prefetch is part of the requirement: a server that says `on` also says prefetch, and a
    // device it does not require keeps today's behaviour (the image is fetched by a chat's plan).
    return { required, fallback: requiredFallback(value?.required_fallback), prefetch: required && value?.prefetch === true };
  } catch {
    return { required: false, fallback: "native", prefetch: false };
  }
}

/**
 * Remembers local_box.default (with its backends allowlist, `required`,
 * `required_fallback` and `setup.prefetch`) of a capabilities answer; whether
 * what decides where chats run changed: the default, the allowlist, or
 * `required` (with its fallback). Keys that first appear with their old
 * meaning (required false; prefetch) are no change, so boxes are not planned
 * again for them.
 */
/** The server's local_box as last seen (model_start, revision, ...), or null. */
export function serverLocalBox(stateDir: string): { model_start?: unknown; revision?: unknown } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function rememberServerDefault(stateDir: string, capabilities: { local_box?: unknown } | null | undefined): boolean {
  const block = capabilities?.local_box;
  if (!block || typeof block !== "object") return false;
  const fields: { default?: unknown; max_turn_bytes?: unknown; backends?: unknown; required?: unknown; required_fallback?: unknown; setup?: unknown; model_start?: unknown; revision?: unknown } = block;
  const value = isMode(fields.default) ? fields.default : "off";
  const backends = Array.isArray(fields.backends) ? fields.backends.filter((b): b is string => typeof b === "string").slice(0, 32) : null;
  const required = fields.required === true;
  const fallback = requiredFallback(fields.required_fallback);
  const setup: { prefetch?: unknown } = fields.setup && typeof fields.setup === "object" ? fields.setup : {};
  const was = serverRequired(stateDir);
  const before = JSON.stringify([serverDefault(stateDir), serverBackends(stateDir), was.required, was.required ? was.fallback : null]);
  try {
    mkdirSync(stateDir, { recursive: true });
    // The required keys are written only when the server requires the sandbox, so the file is
    // exactly what it was before them otherwise (the CLI's requiredBlock does the same).
    const extra = required ? { required, required_fallback: fallback, prefetch: setup.prefetch === true } : {};
    // How a new chat on each model starts (model_start, with the policy's revision), as the server said (model-modes/ serverModelStart).
    const starts = fields.model_start && typeof fields.model_start === "object" && !Array.isArray(fields.model_start)
      ? { model_start: Object.fromEntries(Object.entries(fields.model_start).slice(0, 64)), ...(typeof fields.revision === "string" ? { revision: fields.revision.slice(0, 32) } : {}) }
      : {};
    writeFileSync(path.join(stateDir, "box-server.json"), JSON.stringify({ default: value, max_turn_bytes: fields.max_turn_bytes ?? null, backends, ...extra, ...starts, at: Date.now() }), { mode: 0o600 });
  } catch { /* best effort */ }
  return before !== JSON.stringify([value, backends, required, required ? fallback : null]);
}

/**
 * Reads the server's default again every `everyMs` while the app runs (an app
 * started before a switch was flipped, or kept open for days, follows it
 * without a restart) and calls `apply` when it (or its backends allowlist)
 * changed. One read at a time; a failed one leaves the last answer. Returns
 * the stop.
 */
export function watchServerDefault({ stateDir, read, apply, everyMs }: { stateDir: string; read: () => Promise<{ local_box?: unknown } | null | undefined>; apply: () => Promise<unknown>; everyMs: number }): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void read()
      .then((capabilities) => (rememberServerDefault(stateDir, capabilities) ? apply() : undefined))
      .catch(() => undefined)
      .finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// --- the backend --------------------------------------------------------------------

/** What the backend setting holds: "auto" (the ranked order), one backend id, or "native" (no box). */
export type BackendSetting = string;

/** The machine's box settings file (the CLI's box.json; the desktop keeps only `backend` in it). */
export function settingsFile(stateDir: string): string {
  return path.join(stateDir, "box.json");
}

/** The saved backend setting ("auto" when none). */
export function readBackend(stateDir: string): BackendSetting {
  try {
    return normalizeBackend(JSON.parse(readFileSync(settingsFile(stateDir), "utf8"))?.backend) || "auto";
  } catch {
    return "auto";
  }
}

/** Save the backend boxes on this machine use: "auto" or one id (the desktop setting). */
export function saveBackend(stateDir: string, backend: unknown): BackendSetting {
  const id = normalizeBackend(backend);
  if (!id) throw new Error(`unknown sandbox backend "${String(backend)}"`);
  let current: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(settingsFile(stateDir), "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) current = Object.fromEntries(Object.entries(value));
  } catch { /* none */ }
  mkdirSync(stateDir, { recursive: true });
  const file = settingsFile(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...current, backend: id }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return id;
}

/** The backend asked for, and by whom: OMNIRUSH_BOX_BACKEND, then the saved setting. */
export function askedBackend({ env = process.env, stateDir }: { env?: NodeJS.ProcessEnv; stateDir: string }): { backend: string; source: "env" | "setting" | "auto" } {
  const flag = String(env.OMNIRUSH_BOX_BACKEND || "").trim();
  if (flag) return { backend: normalizeBackend(flag) ?? flag, source: "env" };
  const saved = readBackend(stateDir);
  return { backend: saved, source: saved !== "auto" ? "setting" : "auto" };
}

/**
 * On or off for a project, and why: OMNIRUSH_BOX=1|0 (every project), then
 * the server's `required` (every new chat in the box: the project's own
 * switch and the buildathon's choice no longer turn it off), then the
 * project's setting, then (a buildathon project, buildathon-repro.ts) the
 * event's `repro.box`, then the server's default ("on"; "offer" shows a
 * one-line offer until the project was offered it once; "off"). A buildathon
 * project kept off by OMNIRUSH_BOX=0 or its own switch says so (`lessRepro`).
 * OMNIRUSH_BOX=0 while the sandbox is required is the support-only escape:
 * `required` stays set so the chat reports it (launch reason env_off).
 * CLI: src/box/launch.js resolveMode, the same order.
 */
export function resolveMode({ env = process.env, project, server, offered = false, buildathon = null, required = false }: { env?: NodeJS.ProcessEnv; project: ProjectBoxMode; server: ServerBoxDefault; offered?: boolean; buildathon?: "on" | "offer" | "off" | null; required?: boolean }): { on: boolean; source: "env" | "project" | "server" | "default" | "buildathon" | "required"; offer: boolean; lessRepro?: true; required?: true } {
  const lessRepro = buildathon === "on" || buildathon === "offer" ? { lessRepro: true as const } : {};
  const asked = String(env.OMNIRUSH_BOX ?? "").trim().toLowerCase();
  if (["1", "on", "true"].includes(asked)) return { on: true, source: "env", offer: false, ...(required ? { required: true as const } : {}) };
  if (["0", "off", "false"].includes(asked)) return { on: false, source: "env", offer: false, ...lessRepro, ...(required ? { required: true as const } : {}) };
  if (required) return { on: true, source: "required", offer: false, required: true };
  if (project === "on" || project === "off") return { on: project === "on", source: "project", offer: false, ...(project === "off" ? lessRepro : {}) };
  if (buildathon === "on") return { on: true, source: "buildathon", offer: false };
  if (buildathon === "offer" && server !== "on") return { on: false, source: "buildathon", offer: !offered };
  if (server === "on") return { on: true, source: "server", offer: false };
  return { on: false, source: server === "offer" ? "server" : "default", offer: server === "offer" && !offered };
}

// --- background download ---------------------------------------------------------------

export function pullMarker(home: string, runtime: Pick<BoxRuntime, "backend" | "name">, image: string): string {
  return path.join(home, "pulls", `${runtime.backend ?? runtime.name}-${image.replace(/[^a-zA-Z0-9._-]+/g, "_")}.pid`);
}

/** The detached download's output (Desktop: its progress, pull-progress.ts). */
export function pullLog(marker: string): string {
  return marker.replace(/\.pid$/, ".log");
}

/** When a download's log last moved (ms since the epoch), or null: no log. */
export function pullActivityAt(home: string, runtime: Pick<BoxRuntime, "backend" | "name">, image: string): number | null {
  try { return Math.round(statSync(pullLog(pullMarker(home, runtime, image))).mtimeMs); } catch { return null; }
}

/**
 * Whether a wait for the first sandbox setup is over: `idle` (no progress
 * for `idleMs`: nothing moved in the download's log) or `max` (`maxMs` in all);
 * null while it goes on. The CLI's run limit counts the setup the same way
 * (src/box/setup-wait.js).
 */
export function setupWait({ startedAt, lastProgressAt, now, idleMs, maxMs }: { startedAt: number; lastProgressAt: number; now: number; idleMs: number; maxMs: number }): { over: "idle" | "max" | null } {
  if (now - startedAt >= maxMs) return { over: "max" };
  if (now - Math.max(startedAt, lastProgressAt) >= idleMs) return { over: "idle" };
  return { over: null };
}

/** Downloads running in this process (a backend with no detached command: the WSL distro). */
const inProcess = new Set<string>();

/** Whether a background download of `image` with this backend is running. */
export function pulling(home: string, runtime: Pick<BoxRuntime, "backend" | "name">, image: string): boolean {
  const marker = pullMarker(home, runtime, image);
  if (inProcess.has(marker)) return true;
  try {
    const pid = Number(readFileSync(marker, "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The log of a download in this process (the WSL distro, the Lima VM): its
 * lines appended as they come, for the setup panel's progress; the marker
 * (this process's pid) is touched so the start time reads right.
 */
export function inProcessLog(marker: string): { onLine: (stream: "stdout" | "stderr", line: string) => void; close: () => void } {
  let fd: number | null = null;
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, String(process.pid));
    fd = openSync(pullLog(marker), "w", 0o600);
  } catch { /* no progress then */ }
  return {
    onLine: (_stream, line) => {
      if (fd === null) return;
      try { writeSync(fd, `${line}\n`); } catch { /* best effort */ }
    },
    close: () => {
      if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } fd = null; }
      // The marker names this (still running) process: gone once the download ends, so it never reads as running.
      try { rmSync(marker, { force: true }); } catch { /* none */ }
    },
  };
}

/**
 * Start the backend's download detached (survives this run); one at a time
 * per image. A backend without a detached command (the WSL distro, whose
 * download imports the distro first) downloads in this process instead.
 */
export function pullInBackground(runtime: BoxRuntime, image: BoxImage, home: string, { spawnImpl = spawn, env = process.env, log = () => {} }: { spawnImpl?: (command: string, args: string[], options: { detached: boolean; stdio: "ignore" | ["ignore", number, number]; windowsHide: boolean }) => Pick<ChildProcess, "pid" | "unref">; env?: NodeJS.ProcessEnv; log?: BoxLog } = {}): { started: boolean; pid: number | undefined } {
  const marker = pullMarker(home, runtime, image.pull);
  if (inProcess.has(marker)) return { started: false, pid: process.pid };
  try {
    const pid = Number(readFileSync(marker, "utf8"));
    if (pid) { process.kill(pid, 0); return { started: false, pid }; }
  } catch { /* none running */ }
  mkdirSync(path.dirname(marker), { recursive: true });
  const driver = driverFor(runtime);
  const cmd = driver.pullCommand(runtime, image, home);
  if (!cmd) {
    inProcess.add(marker);
    // Its progress lines (the Lima VM's setup steps, boxrun's bytes) go to the same log a detached
    // download writes (pull-progress.ts reads it); the marker's time is when it started.
    const progress = inProcessLog(marker);
    void driver.pull(runtime, image, { home, env, log, onLine: progress.onLine })
      .then((res) => { if (!res.ok) log("warn", "box download failed", { backend: runtime.backend, error: res.error }); })
      .catch((error) => log("warn", "box download failed", { backend: runtime.backend, error: String(error?.message || error) }))
      .finally(() => { progress.close(); inProcess.delete(marker); });
    return { started: true, pid: process.pid };
  }
  // Its output goes to a log next to the marker (the Settings card reads its progress there).
  let out: number | null = null;
  try { out = openSync(pullLog(marker), "w", 0o600); } catch { /* no progress then */ }
  let child: Pick<ChildProcess, "pid" | "unref">;
  try {
    child = spawnImpl(cmd.bin, cmd.args, { detached: true, stdio: out === null ? "ignore" : ["ignore", out, out], windowsHide: true });
  } finally {
    if (out !== null) closeSync(out);
  }
  child.unref?.();
  try { writeFileSync(marker, String(child.pid ?? "")); } catch { /* best effort */ }
  return { started: true, pid: child.pid };
}

// --- one project -----------------------------------------------------------------------

export type ReadyPlan = {
  box: { key: string; home: string; root: string; runtime: BoxRuntime };
  notice: null;
  shell: string;
  /**
   * Open the box (once); resolves the Box (state "ready" or "failed").
   * `pkglog`: the install log's folder (phase 1: { root, bin, py } with
   * POSIX wrappers), mounted into a new box and put on its PATH.
   */
  start: (options?: { pkglog?: BoxInstallLog | null }) => Promise<Box>;
  /**
   * Open the box again (boxd stopped: its idle limit, a crash, the WSL distro
   * restarted). The backend starts boxd again when it does not answer; installs are kept.
   */
  restart?: () => Promise<Box>;
  /** What the box start is doing ("starting", "pulling", "ready", "failed"; null before it starts). */
  readonly phase: string | null;
  /** macOS / Windows with a backend that runs boxrun as root: the box's own build folders (required.ts), else null. */
  shadows?: ShadowPlan | null;
  /** The one line that says so (required.json texts.desktop.shadows), else null. */
  shadowsLine?: string | null;
};
export type NativePlan = { box: null; notice: string | null; runtime: RuntimeResult | null; image?: BoxImage; downloading?: boolean };
export type BoxPlan = ReadyPlan | NativePlan;

/** How long a plan under required waits for the backend to answer before it is "cannot run" (cold WSL / VM start). */
export const REQUIRED_REDETECT_MS = 45_000;

/**
 * The box's own build folders (required.ts shadowPlan), found now (bounded)
 * so the project's one line can say so: under the required sandbox only, on
 * macOS / Windows, with a backend that runs boxrun as root (the WSL distro,
 * the Lima VM). Else null (as before the required sandbox).
 */
export function boxShadows({ required, runtime, root, platform = process.platform, env = process.env, stateDir = null, log = () => {} }: { required: boolean; runtime: BoxRuntime; root: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; stateDir?: string | null; log?: BoxLog }): ShadowPlan | null {
  if (!required || !driverFor(runtime).shadows || !shadowsApply(platform, env)) return null;
  let shadows: ShadowPlan | null = null;
  try { shadows = shadowPlan(root, { platform, croot: containerRoot(root, platform), stateDir, env }); } catch (error) { log("warn", "box shadows scan failed", { error: error instanceof Error ? error.message : String(error) }); }
  if (shadows) log("info", "box shadows", { binds: shadows.binds.length, env: Object.keys(shadows.env), ms: shadows.ms, truncated: shadows.truncated });
  return shadows;
}

/**
 * Plan the box of the project at `root` (the project's box is on). Returns
 * { box: null, notice } when its chats run on this machine for now (no
 * runtime, no helpers, the image still downloading), else a ready plan.
 */
export async function planBox({ env = process.env, home, root, log = () => {}, run = runCommand, probeMs = 4_000, shims = null, asked = null, allow = null, platform = process.platform, stateDir = null, preferShadows = false, required = false }: { env?: NodeJS.ProcessEnv; home: string; root: string; log?: BoxLog; run?: RunCommand; probeMs?: number; shims?: string | null; asked?: string | null; allow?: string[] | null; platform?: NodeJS.Platform; stateDir?: string | null; preferShadows?: boolean; required?: boolean }): Promise<BoxPlan> {
  const key = boxKey(root);
  const bounded = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
  // Under required the chat waits for the box anyway: a backend slow to answer (a WSL VM booting) is not "cannot run".
  const detectMs = required ? Math.max(probeMs, REQUIRED_REDETECT_MS) : probeMs;
  const runtime = await bounded<RuntimeResult>(detectRuntime({ boxHome: home, env, run, ...(asked ? { asked } : {}), allow, ...(preferShadows ? { preferShadows } : {}), ...(required ? { required } : {}) }), detectMs, { ok: false, reason: "the sandbox backend did not answer in time" });
  if (!runtime.ok) {
    log("info", "box unavailable", { reason: runtime.reason });
    return { box: null, notice: `Sandbox off for now: ${runtime.reason}.`, runtime };
  }
  let shell: string;
  try {
    shell = installShell(home, { env });
  } catch (error) {
    return { box: null, notice: `Sandbox off for now: ${error instanceof Error ? error.message : String(error)}.`, runtime };
  }
  // A box already made keeps its image (and its installs); a new one needs the image here.
  const driver = driverFor(runtime);
  const existing = await bounded(driver.exists(runtime, key, { run, home, env, timeoutMs: probeMs }), probeMs, false);
  if (!existing) {
    const image = imageFor(detectStack(root), { env });
    const present = await bounded(driver.imagePresent(runtime, image, { run, home, env }), probeMs, null);
    if (!present) {
      pullInBackground(runtime, image, home, { env, log });
      return { box: null, notice: `Sandbox is downloading (${image.approxMb ? `about ${image.approxMb} MB, ` : ""}once${runtime.backend === "wsl" && !runtime.installed ? ", with the OmniRush WSL distro" : runtime.backend === "lima" && !runtime.installed ? ", with the OmniRush VM" : ""}); chats here run on this machine until it is ready.`, runtime, image, downloading: true };
    }
  }
  // The pins this box starts on are remembered: the next box version keeps their images as the previous ones.
  rememberPins(home, loadPins());
  if (env.OMNIRUSH_BOX_GC !== "off") setTimeout(() => gcInBackground(runtime, home, { log }), 30_000).unref?.();
  let opening: Promise<Box> | null = null;
  let phase: string | null = null;
  let startedWith: BoxInstallLog | null = null;
  const shadows = boxShadows({ required, runtime, root, platform, env, stateDir, log });
  const start = ({ pkglog = null }: { pkglog?: BoxInstallLog | null } = {}): Promise<Box> => {
    if (!opening) startedWith = pkglog;
    opening ??= openBox({ root, runtime, env, home, log, pull: false, shims, pkglog, revive: true, shadows, platform, onState: (state) => { phase = state; } });
    return opening;
  };
  return {
    box: { key, home, root, runtime },
    notice: null,
    shell,
    start,
    restart: () => {
      if (!opening) return start();
      opening = openBox({ root, runtime, env, home, log, pull: false, shims, pkglog: startedWith, revive: true, shadows, platform });
      return opening;
    },
    get phase() { return phase; },
    shadows,
    shadowsLine: shadowsNotice(shadows, platform),
  };
}

/**
 * Old boxes and images, at most once a day, in the background (never on the
 * start path): containers of folders that are gone or unused for 30 days,
 * box images that are neither current nor used. Labelled/named ones only.
 */
export function gcInBackground(runtime: BoxRuntime, home: string, { log = () => {}, now = Date.now(), everyMs = 24 * 3_600_000, gc = gcBoxes }: { log?: BoxLog; now?: number; everyMs?: number; gc?: typeof gcBoxes } = {}): Promise<Array<{ kind: string; name: string; reason: string }>> | null {
  const marker = path.join(home, "gc.json");
  try {
    if (now - Number(JSON.parse(readFileSync(marker, "utf8")).at) < everyMs) return null;
  } catch { /* never ran */ }
  try { mkdirSync(home, { recursive: true }); writeFileSync(marker, JSON.stringify({ at: now })); } catch { return null; }
  return gc(runtime, { home, pins: loadPins() })
    .then((removed) => { if (removed.length) log("info", "box gc", { removed: removed.map((item) => `${item.kind}:${item.name}`) }); return removed; })
    .catch((error) => { log("warn", "box gc failed", { error: String(error?.message || error) }); return []; });
}

/** The package-manager wrappers' source folder (phase 1), mounted read-only when present. */
export function shimsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = String(env.OMNIRUSH_BOX_SHIMS_DIR || "").trim();
  if (asked) return existsSync(path.join(asked, "install.sh")) ? path.resolve(asked) : null;
  return null;
}

/** Engine config additions for box runs: the shell and the plugin. */
export function engineConfig(bits: { shell: string; plugin: string } | null, config: Record<string, unknown>): Record<string, unknown> {
  if (!bits) return config;
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return {
    ...config,
    shell: bits.shell,
    plugin: [...plugins, bits.plugin],
  };
}

/** How often a project's box looks for a restart request from boxsh. */
export const REVIVE_POLL_MS = 400;

/** The record's error when boxd stopped and could not start again: why, and what the user can do. */
export function reviveError(error: string | null | undefined): string {
  const why = String(error || "it did not answer").replace(/\s+/g, " ").slice(0, 240);
  return `the sandbox stopped and could not start again (${why}). Restart the app (installs are kept), reset this folder's sandbox for a fresh one, or turn the sandbox off for this folder to run it on this computer`;
}

/** Turn the record off (the project went on without the box). */
export function recordOff(home: string, key: string, reason: string): void {
  try {
    const file = recordFile(home, key);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...rec, state: "off", error: reason, updated: Date.now() }), { mode: 0o600 });
  } catch { /* none */ }
}

// --- the box during a run ------------------------------------------------------------

export type Frozen = {
  label: string;
  turn: number | null;
  copied: number;
  carried: number;
  save: (outDir?: string) => Promise<{ label: string; changed: number; bytes: number }>;
  discard: () => Promise<null>;
};

export type BoxRun = {
  key: string;
  container: string;
  runtimeBin: string;
  /** Arguments before the runtime's own (`-e docker` for a WSL engine). */
  runtimeArgs: string[];
  /** The backend id (backends/index.ts). */
  backend: string;
  /** How to run a program in the box with stdin open when it is not `docker exec` (files-used reads); null for container engines. */
  exec: BoxExec | null;
  root: string;
  readonly native: boolean;
  readonly box: Box | null;
  ready: () => Promise<Box | null>;
  /** environment.sandbox for a chat's uploads; null while it is not (or no longer) the chat's. */
  label: (sessionId: string) => BoxLabel | null;
  setTurn: (turn: number) => void;
  /** Start boxd again when it does not answer (resolves the Box now in use). */
  heal: (why: string) => Promise<Box | null>;
  /** The box's ports open on this computer now (ports.ts). */
  forwardedPorts?: () => number[];
  /** Stop watching for restart requests and close the port forwards (the project's box is let go). */
  close: () => void;
  /** `sessionTurn`: the chat's own number of the prompt the checkpoint comes before (written as session_turn). */
  freeze: (label: string, options: { sessionId: string; turn?: number | null; sessionTurn?: number | null; chain?: string | null }) => Promise<Frozen | null>;
};

/**
 * What the capture wiring drives for one project's box: readiness, the
 * per-turn freeze, the label uploads carry (the toolchain probes run from
 * the capture worker: capture.ts). A box that
 * fails before any chat's first checkpoint turns the project native (record
 * "off"; the shell runs on this machine, its chats are not labelled); later
 * failures are logged and that turn has no checkpoint.
 */
export function boxRun(plan: ReadyPlan, { log = () => {}, readyWaitMs = 30_000, onNative = () => {}, onRevive = () => {}, onPort = () => {}, tmpRoot, pkglog = null, pollMs = REVIVE_POLL_MS, ping = client.ping, env = process.env, forwards: makeForwards = portForwards, required = false }: { required?: boolean; log?: BoxLog; readyWaitMs?: number; onNative?: (reason: string) => void; onRevive?: (event: { ok: boolean; why: string; error?: string }) => void; onPort?: (event: { port: number; open: boolean; line?: string; why?: string }) => void; tmpRoot?: string; pkglog?: BoxInstallLog | null; pollMs?: number; ping?: typeof client.ping; env?: NodeJS.ProcessEnv; forwards?: (options: PortForwardOptions) => PortForwards } = {}): BoxRun {
  const { key, home, runtime, root } = plan.box;
  let box: Box | null = null;
  let native = false;
  let closed = false;
  const checkpoints = new Map<string, number>();
  const requestFile = reviveFile(home, key);
  // A restart request nobody answered before (the app quit): this start answers it.
  try { rmSync(requestFile, { force: true }); } catch { /* not there */ }
  const opening = plan.start({ pkglog }).then((opened) => { box = opened; return opened; });
  // A box with its own network (Docker, Podman): its servers at the same port on this computer's 127.0.0.1
  // (ports.ts), polled while the box is usable (none before it is ready, after a failure, once let go).
  // Under the required sandbox only (a chat that would have run here keeps its servers reachable); OMNIRUSH_BOX_PORTS=off: never.
  const wantsForwards = required && driverFor(runtime).forwardsPorts === false && String(env.OMNIRUSH_BOX_PORTS ?? "").trim().toLowerCase() !== "off";
  const forwards = wantsForwards ? makeForwards({
    endpoint: () => { const current: Box | null = box; return current?.ready && !native && !closed ? current.endpoint : null; },
    log,
    onOpen: (port, line) => { try { onPort({ port, line, open: true }); } catch { /* the caller's problem */ } },
    onClose: (port, why) => { try { onPort({ port, open: false, why }); } catch { /* the caller's problem */ } },
  }) : null;
  const goNative = (reason: string) => {
    if (native) return;
    native = true;
    forwards?.close();
    recordOff(home, key, reason);
    log("warn", "box off for this project", { reason });
    onNative(reason);
  };
  // The time limit counts while the box starts, not while its image downloads (the CLI's
  // first --sandbox run on a slow link; here a box opens only once its image is in, so
  // this only matters if a start ever downloads).
  let settled = false;
  opening.finally(() => { settled = true; }).catch(() => {});
  const limit = () => new Promise<null>((resolve) => {
    let from = Date.now();
    const tick = () => {
      if (settled) return resolve(null);
      if (plan.phase === "pulling") from = Date.now();
      if (Date.now() - from >= readyWaitMs) return resolve(null);
      setTimeout(tick, Math.min(250, readyWaitMs)).unref?.();
    };
    tick();
  });
  // boxd stopped while the app ran (its idle limit, a crash, OOM, the WSL distro
  // restarted, sleep): start it again, once at a time. Asked by a shell call that
  // could not reach it (boxsh writes boxes/<key>.revive) and checked at each
  // turn's checkpoint. A box that cannot start again stays "failed" with the
  // reason and what to do (every shell call says it); the app says it once.
  // Never this computer instead.
  let healing: Promise<Box | null> | null = null;
  let lostSaid = false;
  let lastTurn: number | null = null;
  const heal = (why: string): Promise<Box | null> => {
    if (healing) return healing;
    const since = Date.now();
    healing = (async () => {
      try {
        const first = await opening;
        if (native || !first.ready || !plan.restart) return box;
        const current = box ?? first;
        if (current.ready && current.endpoint && (await ping(current.endpoint, { timeoutMs: 1_500 }))) return current;
        log("warn", "box not answering; starting it again", { why, key });
        const again = await plan.restart();
        box = again;
        if (lastTurn !== null) again.setTurn(lastTurn);
        if (again.ready) {
          log("info", "box started again", { why, key });
          lostSaid = false;
          onRevive({ ok: true, why });
        } else {
          log("warn", "box could not start again", { why, key, error: again.error });
          const error = reviveError(again.error);
          again.fail(error);
          if (!lostSaid) {
            lostSaid = true;
            onRevive({ ok: false, why, error });
          }
        }
        return again;
      } catch (error) {
        log("warn", "box restart failed", { why, error: error instanceof Error ? error.message : String(error) });
        return box;
      } finally {
        healing = null;
        // Answered: boxsh reads the record now. A request made after this check started waits for the next one.
        try { if (statSync(requestFile).mtimeMs <= since) rmSync(requestFile, { force: true }); } catch { /* none */ }
      }
    })();
    return healing;
  };
  const watcher = setInterval(() => {
    if (!native && !healing && existsSync(requestFile)) heal("request").catch(() => {});
  }, pollMs);
  watcher.unref?.();
  const ready = async (): Promise<Box | null> => {
    if (native) return null;
    const opened = await Promise.race([opening, limit()]);
    if (opened?.ready) {
      if (healing) await healing;
      return box?.ready ? box : null;
    }
    if ([...checkpoints.values()].every((count) => count === 0)) goNative(opened?.error || "the sandbox did not start in time");
    return null;
  };
  const pending = tmpRoot ?? path.join(home, "pending");
  return {
    key,
    container: containerName(key),
    runtimeBin: runtime.bin,
    runtimeArgs: runtime.prefix ?? [],
    backend: runtime.backend ?? runtime.name,
    exec: driverFor(runtime).kind === "container" ? null : driverFor(runtime).execCommand(runtime, { key, home }),
    root,
    get native() { return native; },
    get box() { return box; },
    ready,
    label: (sessionId) => (box?.ready && !native && (checkpoints.get(sessionId) ?? 0) > 0 ? box.label() : null),
    setTurn: (turn) => { lastTurn = turn; box?.setTurn(turn); },
    heal,
    forwardedPorts: () => forwards?.ports() ?? [],
    close: () => { closed = true; clearInterval(watcher); forwards?.close(); },
    /**
     * The old sandbox's freeze(label, { turn, chain }) -> { save(dir), discard() } | null:
     * the checkpoint is taken now and placed by save(); `final` (the state a
     * chat ends with) is a leaf, so a resumed chat chains on from its last turn.
     */
    freeze: async (label, { sessionId, turn = null, sessionTurn = null, chain = null }) => {
      await ready();
      if (native || !box) return null;
      // Each turn starts with a box that answers (started again when it stopped since the last turn,
      // or tried again when it could not start at the last try).
      const opened = await heal("turn");
      if (!opened?.ready) return null;
      const n = Number(turn ?? /^turn-(\d+)$/.exec(label)?.[1] ?? 0) || null;
      const name = n ? `turn-${n}` : label;
      const dir = chain ?? path.join(pending, `${process.pid}-${Date.now()}`);
      let taken: Awaited<ReturnType<Box["checkpoint"]>>;
      try {
        taken = await opened.checkpoint(dir, n, { label: name, leaf: !n, sessionTurn: n ? sessionTurn : null });
      } catch (error) {
        // A checkpoint that fails never fails the turn: it goes on with no checkpoint.
        log("warn", "box checkpoint failed; the turn goes on without one", { label: name, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
      checkpoints.set(sessionId, (checkpoints.get(sessionId) ?? 0) + 1);
      const summary: CheckpointSummary = taken.summary;
      return {
        label: name,
        turn: n,
        copied: summary.stats.copied,
        carried: Math.max(0, summary.stats.kept - summary.stats.copied),
        save: async (outDir) => {
          taken.commit(outDir ?? dir);
          return { label: name, changed: summary.delta.changed.length, bytes: summary.bytes };
        },
        discard: async () => { taken.discard(); return null; },
      };
    },
  };
}

/** A host path under the project, as the box sees it. */
export function mapToBox(p: string, root: string, croot: string): string {
  if (root === croot) return p;
  const rel = path.relative(root, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return croot;
  return rel ? `${croot}/${rel.split(path.sep).join("/")}` : croot;
}

export { savedTurns };
