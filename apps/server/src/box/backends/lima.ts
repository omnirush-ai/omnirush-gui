// Ported from the CLI (omnirush-cli src/box/backends/lima.js, feat/box-required);
// keep the two in step: the CLI and the desktop app SHARE one VM, so the VM's
// name, LIMA_HOME, the owner lock, the leases, the idle watcher's file, the
// contract in the VM and the helpers' folders are the same files in the same
// formats. Desktop differences, each marked "Desktop:": types; limactl bundled
// in the app is <sidecars>/lima/bin/limactl (signed with the virtualization
// entitlement); the download (Lima, the VM image, the box image) runs in the
// app's own process (pullCommand null) and says how far it is in setup lines
// ({"setup":{"step","bytes","total"}}) next to boxrun's own progress lines
// (pull-progress.ts reads both); the idle watcher is lima-idle.ts run with the
// app's own binary (ELECTRON_RUN_AS_NODE=1); the contract names client "desktop".
//
// macOS: OmniRush's own Linux VM as the box backend (backend id `lima`), so no
// Docker, OrbStack or colima is needed. One VM per user ("omnirush-box"),
// run by a pinned Lima (limactl, Apple's Virtualization.framework through the
// `vz` driver, no admin). Its disk is a pinned Debian image (box/vm), its
// LIMA_HOME is <box home>/vm (short: Lima keeps sockets there), and the user's
// home, /Volumes and /private/tmp are shared into it at the same paths
// (virtiofs, writable). Each project's box runs inside it exactly like the WSL
// distro's: boxrun as root (unshare + overlay) from the same pinned images, so
// a Mac box is the same environment as a Linux or Windows one. Boxes bind
// only their project.
//
// boxd listens on the VM's loopback at a port chosen here; Lima's host agent
// forwards guest loopback ports to this Mac's 127.0.0.1 (within ~3 s).
//
// One VM for the CLI and the desktop app:
//   lima/vm.lock            the owner lock for create/start/stop/edit ({pid, started, nonce, at}; stale when the pid is gone or reused)
//   lima/leases/<key>-<pid>-<n>.json   one per running box of a live process ({pid, started, key})
//   lima/idle.json          the idle watcher (lima-idle.ts / the CLI's lima-idle.js): stops the VM after
//                           setup.darwin.vm.idle_stop_min with no live lease
//   /opt/omnirush/vm.json   (in the VM) the contract the VM was made with: a newer
//                           client never replaces the disk under an older one's box
//   /opt/omnirush/h/<stamp> (in the VM) each install's boxrun and boxd

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import serverPackage from "../../../package.json" with { type: "json" };
import { ping } from "../client.js";
import { GOARCH, containerName, firstLine, freePort, helperPath, newToken, readJson, toolsRoot, writeJson, type BoxLog, type BoxRuntime } from "../common.js";
import { REQUIRED_RULES } from "../required.js";
import { YOUNG_IMAGE_MS, removableImage, removeTree, staleEntries } from "../retention.mjs";
import { runCommand, type RunCommand, type RunOptions, type RunResult } from "../run.js";
import type { RuntimeResult } from "../runtime.js";
import { macosMajor } from "./apple.js";
import { IDLE_MINUTES, newMeta, upArgs, type BoxMeta } from "./bwrap.js";
import { boxshExec, num, parseOut, str } from "./shared.js";
import type { BoxDriver, ListedBox, OpenContext, Opened, PresentImage, Removed, SpawnLike } from "./types.js";
import { download, type DownloadOptions } from "./wsl.js";

type Env = NodeJS.ProcessEnv;
type OnLine = RunOptions["onLine"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STORE = "/var/lib/omnirush/store";
export const BOXES = "/var/lib/omnirush/boxes";
export const OPT = "/opt/omnirush";
/** Where a box's own build folders (shadows) live in the VM: one folder per box, on the VM's disk. */
export const SHADOW_STORES = "/var/lib/omnirush/shadows";
/** The VM layout this client makes and understands (/opt/omnirush/vm.json `contract`). */
export const VM_CONTRACT = 1;
/** Lima's own name for an architecture. */
export const LIMA_ARCH: Record<string, string> = { arm64: "aarch64", amd64: "x86_64", x64: "x86_64" };
/** The folders of this Mac the VM shares (same path, writable), besides a project outside them. */
export const BASE_MOUNTS = ["/Volumes", "/private/tmp"];
/** A VM that failed to start is not picked again for this long (a running OrbStack/Docker is used meanwhile). */
export const FAILED_MS = 60 * 60_000;
const GIB = 1024 ** 3;

type Asset = { url: string | null; sha256: string | null };
export type DarwinSetup = {
  backend?: string;
  min_macos?: string;
  lima?: { version?: string; assets?: Record<string, Asset | undefined> };
  vm?: {
    name?: string; cpus_max?: number; memory_min_gib?: number; memory_fraction?: number; disk_gib?: number; idle_stop_min?: number; contract?: number;
    image?: {
      custom?: { version?: string | null; arm64?: Asset; x64?: Asset };
      fallback?: { version?: string | null; arm64?: { url: string | null; sha512: string | null }; x64?: { url: string | null; sha512: string | null } };
    };
  };
};

/** required.json's setup.darwin (lima pins, vm resources and image pins). */
export function loadDarwinSetup(): DarwinSetup {
  return REQUIRED_RULES.setup.darwin as DarwinSetup;
}

export function vmName(setup: DarwinSetup = loadDarwinSetup(), env: Env = process.env): string {
  return String(env.OMNIRUSH_BOX_LIMA_VM || "").trim() || setup.vm?.name || "omnirush-box";
}

// --- where things live ---------------------------------------------------------------

export const limaDir = (home: string): string => path.join(home, "lima");
/** macOS' limit for a unix socket path, and the longest one Lima makes in an instance folder. */
const SUN_PATH_MAX = 104;
const sockPath = (lh: string, instance: string) => path.join(lh, instance, "ssh.sock.1234567890123456");
/**
 * LIMA_HOME: OMNIRUSH_BOX_LIMA_HOME, else <box home>/vm, else (a long box home
 * or user name: Lima keeps unix sockets in it and macOS allows 104 bytes)
 * ~/.omnirush-vm. The CLI and the desktop app work it out the same way, so
 * they find the same VM.
 */
export function limaHome(home: string, env: Env = process.env, userHome = os.homedir(), instance = vmName(loadDarwinSetup(), env)): string {
  const asked = String(env.OMNIRUSH_BOX_LIMA_HOME || "").trim();
  if (asked) return asked;
  const own = path.join(home, "vm");
  if (Buffer.byteLength(sockPath(own, instance)) < SUN_PATH_MAX) return own;
  return path.join(userHome, ".omnirush-vm");
}
/** Whether Lima can keep its sockets under this LIMA_HOME. */
export function limaHomeFits(lh: string, instance = vmName()): boolean {
  return Buffer.byteLength(sockPath(lh, instance)) < SUN_PATH_MAX;
}
const metaFile = (home: string, key: string) => path.join(limaDir(home), "boxes", `${key}.json`);
const leaseDir = (home: string) => path.join(limaDir(home), "leases");
const lockFile = (home: string) => path.join(limaDir(home), "vm.lock");
const idleFile = (home: string) => path.join(limaDir(home), "idle.json");
const failedFile = (home: string) => path.join(limaDir(home), "failed.json");
const presentFile = (home: string) => path.join(limaDir(home), "images.json");
const pendingFile = (home: string) => path.join(limaDir(home), "pending-rm.json");
const boxPath = (key: string) => `${BOXES}/${key}`;

/** The environment every limactl call gets: its home, never the user's LIMA_INSTANCE. */
export function limaEnv(home: string, env: Env = process.env): Env {
  const { LIMA_INSTANCE: _instance, LIMA_SHELL: _shell, LIMA_WORKDIR: _workdir, ...rest } = env;
  return { ...rest, LIMA_HOME: limaHome(home, env), PATH: rest.PATH || "/usr/bin:/bin:/usr/sbin:/sbin" };
}

/** What the VM's calls need of a runtime (the probe's answer, or the parts of one a caller has). */
export type LimaRuntime = Pick<BoxRuntime, "arch" | "installed" | "limactlSource" | "helpers"> & { bin: string; home: string; instance: string };

/**
 * limactl, best first: OMNIRUSH_BOX_LIMACTL; the one this app ships
 * (<sidecars>/lima/bin/limactl, signed with the virtualization entitlement);
 * the pinned release downloaded earlier (<box home>/lima/dist/<version>/bin/limactl,
 * the CLI's download too). { bin, source }, bin null: not here yet.
 */
export function findLimactl({ env = process.env, home, exists = existsSync, setup = loadDarwinSetup(), tools = toolsRoot() }: { env?: Env; home?: string; exists?: (file: string) => boolean; setup?: DarwinSetup; tools?: string | null } = {}): { bin: string | null; source: "env" | "bundled" | "download" } {
  const asked = String(env.OMNIRUSH_BOX_LIMACTL || "").trim();
  if (asked) return { bin: exists(asked) ? asked : null, source: "env" };
  if (tools) {
    const bundled = path.join(tools, "lima", "bin", "limactl");
    if (exists(bundled)) return { bin: bundled, source: "bundled" };
  }
  const version = setup.lima?.version;
  if (home && version) {
    const cached = path.join(limaDir(home), "dist", version, "bin", "limactl");
    if (exists(cached)) return { bin: cached, source: "download" };
  }
  return { bin: null, source: "download" };
}

/** The pinned limactl release asset for this Mac ({ url, sha256 }) or null. */
export function limaAsset(setup: DarwinSetup = loadDarwinSetup(), arch: string = process.arch): { url: string; sha256: string } | null {
  const asset = setup.lima?.assets?.[arch === "arm64" ? "arm64" : "x64"];
  return asset?.url && /^[0-9a-f]{64}$/.test(String(asset.sha256 || "")) ? { url: asset.url, sha256: String(asset.sha256) } : null;
}

export type VmImage = { url: string | null; file: string | null; algo: "sha256" | "sha512" | null; digest: string | null; kind: "local" | "custom" | "debian"; version: string | null };

/**
 * The VM disk image to use: OMNIRUSH_BOX_LIMA_IMAGE (a local qcow2/raw file),
 * else OmniRush's own image when published, else the pinned official Debian
 * one. Null: none for this Mac.
 */
export function vmImage({ env = process.env, setup = loadDarwinSetup(), arch = process.arch, home }: { env?: Env; setup?: DarwinSetup; arch?: string; home?: string } = {}): VmImage | null {
  const asked = String(env.OMNIRUSH_BOX_LIMA_IMAGE || "").trim();
  if (asked) return { url: null, file: asked, algo: null, digest: null, kind: "local", version: path.basename(asked) };
  const a = arch === "arm64" ? "arm64" : "x64";
  const image = setup.vm?.image ?? {};
  const custom = image.custom?.[a];
  const fallback = image.fallback?.[a];
  const pick: Omit<VmImage, "file"> | null = custom?.url && /^[0-9a-f]{64}$/.test(String(custom.sha256 || ""))
    ? { url: custom.url, algo: "sha256", digest: String(custom.sha256), kind: "custom", version: image.custom?.version ?? null }
    : fallback?.url && /^[0-9a-f]{128}$/.test(String(fallback.sha512 || ""))
      ? { url: fallback.url, algo: "sha512", digest: String(fallback.sha512), kind: "debian", version: image.fallback?.version ?? null }
      : null;
  if (!pick?.digest || !pick.url) return null;
  const ext = /\.raw(\.|$)/.test(pick.url) ? "raw" : "qcow2";
  return { ...pick, file: home ? path.join(limaDir(home), "images", `${pick.digest.slice(0, 32)}.${ext}`) : null };
}

/** A file's hex digest (sha256 or sha512). */
export function hashFile(file: string, algo: "sha256" | "sha512" = "sha256"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

export type FetchFile = (url: string, dest: string, sha256: string | null, options?: DownloadOptions) => Promise<string>;

/** Download `url` to `dest` and check it (any algorithm); nothing is left at `dest` on a mismatch. */
export async function fetchChecked(url: string, dest: string, { algo = "sha256", digest, fetchFile = download, hash = hashFile, stallMs = 90_000, tries = 3, onProgress }: { algo?: "sha256" | "sha512"; digest: string; fetchFile?: FetchFile; hash?: typeof hashFile; stallMs?: number; tries?: number; onProgress?: DownloadOptions["onProgress"] }): Promise<string> {
  const done = async () => existsSync(dest) && (await hash(dest, algo).catch(() => null)) === digest;
  if (await done()) return dest;
  // Its own part file per download: the desktop and a CLI setting up at once never write into one file.
  const part = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.dl`;
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    // A stalled or dropped connection is tried again (three tries); a wrong file is not.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fetchFile(url, part, algo === "sha256" ? digest : null, { stallMs, ...(onProgress ? { onProgress } : {}) });
        break;
      } catch (error) {
        rmSync(part, { force: true });
        // Another app finished the same download meanwhile: that file is the one wanted.
        if (await done()) return dest;
        if (attempt >= tries || /mismatch|https only|HTTP 4\d\d/.test(String(error instanceof Error ? error.message : error))) throw error;
      }
    }
    const got = await hash(part, algo);
    if (got !== digest) {
      if (await done()) return dest;
      throw new Error(`download: ${algo} mismatch (${got.slice(0, 12)}…)`);
    }
    // Same name, same checked content: a rename over another app's finished copy is harmless.
    renameSync(part, dest);
    return dest;
  } finally {
    rmSync(part, { force: true });
  }
}

// --- setup progress (Desktop) --------------------------------------------------------

/** The VM setup's steps, in order, as the setup panel shows them. */
export const SETUP_STEPS = ["lima", "vm_image", "vm_boot", "image"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** One setup line (pull-progress.ts parseSetupLine reads it back). */
export function setupLine(step: SetupStep, bytes: number | null = null, total: number | null = null): string {
  return JSON.stringify({ setup: { step, ...(bytes !== null ? { bytes } : {}), ...(total !== null ? { total } : {}) } });
}

/** Byte progress for a step, at most every 500 ms (and the last byte). */
function stepProgress(step: SetupStep, onLine: OnLine | undefined): DownloadOptions["onProgress"] {
  if (!onLine) return undefined;
  let lastAt = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - lastAt < 500 && done !== total) return;
    lastAt = now;
    try { onLine("stdout", setupLine(step, done, total)); } catch { /* a listener's problem */ }
  };
}
function say(onLine: OnLine | undefined, step: SetupStep): void {
  try { onLine?.("stdout", setupLine(step)); } catch { /* a listener's problem */ }
}

// --- the probe -----------------------------------------------------------------------

export type LimaRow = { name?: string; status?: string; dir?: string; config?: { mounts?: Array<{ location: string; mountPoint?: string; writable?: boolean }> } };

/** `limactl list --json`: the instance's row ({ name, status, dir, config, ... }) or null. */
export function parseList(stdout: unknown, name: string): LimaRow | null {
  for (const line of String(stdout ?? "").split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const row: unknown = JSON.parse(text);
      if (row && typeof row === "object" && Reflect.get(row, "name") === name) return row as LimaRow;
    } catch { /* next */ }
  }
  return null;
}

/** The VM's row from `limactl list` (null: not made yet). */
export async function vmRow(runtime: Pick<LimaRuntime, "bin" | "home" | "instance">, { run = runCommand, env = process.env, timeoutMs = 15_000 }: { run?: RunCommand; env?: Env; timeoutMs?: number } = {}): Promise<{ row: LimaRow | null; res: RunResult; missing: boolean }> {
  const res = await run(runtime.bin, ["list", "--json", runtime.instance], { env: limaEnv(runtime.home, env), timeoutMs });
  const row = res.code === 0 ? parseList(res.stdout, runtime.instance) : null;
  // limactl 2.x: a name with no instance is "No instance matching ... found" + "unmatched instances", exit 1.
  const missing = !row && (res.code === 0 || /No instance matching|unmatched instances/i.test(String(res.stderr ?? "")));
  return { row, res, missing };
}

export async function probeLima({ env = process.env, platform = process.platform, arch = process.arch, release = os.release(), run = runCommand, exists = existsSync, home, timeoutMs = 10_000, setup = loadDarwinSetup(), now = Date.now(), tools = toolsRoot(), explicit = false }: { env?: Env; platform?: NodeJS.Platform; arch?: string; release?: string; run?: RunCommand; exists?: (file: string) => boolean; home?: string; timeoutMs?: number; setup?: DarwinSetup; now?: number; tools?: string | null; explicit?: boolean } = {}): Promise<RuntimeResult> {
  const base = { name: "lima", backend: "lima" };
  if (platform !== "darwin") return { ...base, ok: false, reason: "the OmniRush VM is for macOS" };
  if (env.OMNIRUSH_BOX_LIMA === "0") return { ...base, ok: false, reason: "turned off (OMNIRUSH_BOX_LIMA=0)" };
  const major = macosMajor(release);
  const min = Number.parseInt(String(setup.min_macos ?? "13"), 10) || 13;
  if (major !== null && major < min) return { ...base, ok: false, reason: `the OmniRush VM needs macOS ${min} or later (this is macOS ${major})`, code: "old_macos" };
  const boxHomeDir = home ?? path.join(os.homedir(), ".omnirush", "box");
  // A VM that failed to start an hour ago is not tried again yet: a runtime that works is used instead.
  const failed = readJson<{ at?: number; reason?: string }>(failedFile(boxHomeDir));
  if (!explicit && failed && now - Number(failed.at) >= 0 && now - Number(failed.at) < FAILED_MS) {
    return { ...base, ok: false, reason: `the OmniRush VM did not start (${failed.reason}); tried again within the hour, or now by choosing it in Settings (sandbox backend)`, code: "failed" };
  }
  const found = findLimactl({ env, home: boxHomeDir, exists, setup, tools });
  if (!found.bin && found.source === "env") return { ...base, ok: false, reason: `OMNIRUSH_BOX_LIMACTL: ${env.OMNIRUSH_BOX_LIMACTL} is missing` };
  if (!found.bin && !limaAsset(setup, arch)) return { ...base, ok: false, reason: "the OmniRush VM (Lima) is not published for this Mac yet" };
  if (!vmImage({ env, setup, arch, home: boxHomeDir })) return { ...base, ok: false, reason: "the OmniRush VM image is not published yet (OMNIRUSH_BOX_LIMA_IMAGE=<qcow2> to use one)" };
  const instance = vmName(setup, env);
  const lh = limaHome(boxHomeDir, env, undefined, instance);
  if (!limaHomeFits(lh, instance)) return { ...base, ok: false, reason: `the OmniRush VM's folder path is too long for macOS (${lh}); set OMNIRUSH_BOX_LIMA_HOME to a shorter folder` };
  const goarch = GOARCH[arch] || "arm64";
  const ready = { ...base, ok: true as const, limactlSource: found.source, home: boxHomeDir, instance, os: "linux", arch: goarch, flavor: "omnirush-vm", rootless: false, vm: true };
  // Desktop: bin "" until limactl is here (the first setup downloads it; RuntimeInfo.bin is a string).
  if (!found.bin) return { ...ready, bin: "", installed: false, state: null, version: setup.lima?.version ?? "" };
  const ver = await run(found.bin, ["--version"], { env: limaEnv(boxHomeDir, env), timeoutMs });
  if (ver.code !== 0) return { ...base, ok: false, bin: found.bin, reason: `limactl does not run here: ${firstLine(ver.stderr) || ver.error || ver.code}` };
  const version = (/(\d+\.\d+\.\d+)/.exec(ver.stdout) ?? [])[1] ?? "";
  const { row } = await vmRow({ bin: found.bin, home: boxHomeDir, instance }, { run, env, timeoutMs });
  return { ...ready, bin: found.bin, installed: Boolean(row), state: row?.status ?? null, version };
}

// --- the VM --------------------------------------------------------------------------

/** cpus, memory (GiB) and disk (GiB) for this Mac, from required.json setup.darwin.vm. */
export function vmResources({ setup = loadDarwinSetup(), cpus = os.cpus().length, memBytes = os.totalmem(), env = process.env }: { setup?: DarwinSetup; cpus?: number; memBytes?: number; env?: Env } = {}): { cpus: number; memory: number; disk: number } {
  const vm = setup.vm ?? {};
  const cpuMax = Number(vm.cpus_max) > 0 ? Number(vm.cpus_max) : 4;
  const wantCpus = Number(env.OMNIRUSH_BOX_LIMA_CPUS) > 0 ? Number(env.OMNIRUSH_BOX_LIMA_CPUS) : Math.min(cpuMax, Math.max(2, Math.floor(cpus / 2)));
  const floor = Number(vm.memory_min_gib) > 0 ? Number(vm.memory_min_gib) : 3;
  const fraction = Number(vm.memory_fraction) > 0 ? Number(vm.memory_fraction) : 0.25;
  const memory = Number(env.OMNIRUSH_BOX_LIMA_MEMORY_GIB) > 0 ? Number(env.OMNIRUSH_BOX_LIMA_MEMORY_GIB) : Math.max(floor, Math.floor((memBytes / GIB) * fraction));
  const disk = Number(vm.disk_gib) > 0 ? Number(vm.disk_gib) : 30;
  return { cpus: wantCpus, memory, disk };
}

/** The idle stop in minutes (0: never). */
export function idleStopMinutes({ setup = loadDarwinSetup(), env = process.env }: { setup?: DarwinSetup; env?: Env } = {}): number {
  if (env.OMNIRUSH_BOX_LIMA_IDLE_MIN !== undefined && env.OMNIRUSH_BOX_LIMA_IDLE_MIN !== "") return Math.max(0, Number(env.OMNIRUSH_BOX_LIMA_IDLE_MIN) || 0);
  return Number(setup.vm?.idle_stop_min) >= 0 ? Number(setup.vm?.idle_stop_min) : 30;
}

/** Whether `p` is `dir` or inside it. */
function under(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The folders the VM shares: this user's home, /Volumes, /private/tmp, plus `extra` (projects outside them). */
export function vmMounts({ userHome = os.homedir(), extra = [] }: { userHome?: string; extra?: string[] } = {}): string[] {
  const list = [userHome, ...BASE_MOUNTS];
  for (const dir of extra) if (dir && !list.some((m) => under(dir, m))) list.push(dir);
  return list;
}

/** Folders of `paths` that none of `mounts` covers (each is shared in at its own path). */
export function uncovered(paths: Array<string | null | undefined>, mounts: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!p || !path.isAbsolute(p)) continue;
    if (mounts.some((m) => under(p, m)) || out.some((m) => under(p, m))) continue;
    out.push(p);
  }
  return out;
}

/**
 * The provision script (as root, every boot): swap (the 3 GiB VM keeps a
 * build from being killed), the store and box folders, nothing else. The
 * same text as the CLI's (a VM made by either app is the same VM).
 */
export const PROVISION = [
  "#!/bin/sh",
  "set -eu",
  "mkdir -p /opt/omnirush /var/lib/omnirush/store /var/lib/omnirush/boxes /var/lib/omnirush/shadows",
  "if [ ! -f /var/lib/omnirush/swap ]; then fallocate -l 2G /var/lib/omnirush/swap 2>/dev/null || dd if=/dev/zero of=/var/lib/omnirush/swap bs=1M count=2048; chmod 600 /var/lib/omnirush/swap; mkswap /var/lib/omnirush/swap >/dev/null; fi",
  "swapon --show=NAME --noheadings | grep -qx /var/lib/omnirush/swap || swapon /var/lib/omnirush/swap || true",
  "sysctl -qw vm.swappiness=10 || true",
  "systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true",
  "",
].join("\n");

/**
 * The Lima config of the VM (YAML is a superset of JSON, so it is written as
 * JSON). `image`: a local file (downloaded and checked here first: Lima's own
 * cache is never used).
 */
export function vmConfig({ image, arch = process.arch, cpus, memory, disk, mounts }: { image: string; arch?: string; cpus: number; memory: number; disk: number; mounts: string[] }): Record<string, unknown> {
  const limaArch = LIMA_ARCH[GOARCH[arch] || arch] || "aarch64";
  return {
    vmType: "vz",
    os: "Linux",
    arch: limaArch,
    images: [{ location: image, arch: limaArch }],
    cpus,
    memory: `${memory}GiB`,
    disk: `${disk}GiB`,
    mountType: "virtiofs",
    mounts: mounts.map((location) => ({ location, mountPoint: location, writable: true })),
    containerd: { system: false, user: false },
    ssh: { loadDotSSHPubKeys: false, forwardAgent: false },
    upgradePackages: false,
    provision: [{ mode: "system", script: PROVISION }],
    // Guest loopback ports reach this Mac's 127.0.0.1 (boxd's, and a dev server's in a box).
    portForwards: [{ guestIP: "127.0.0.1", guestPortRange: [1024, 65535], hostIP: "127.0.0.1" }],
  };
}

// --- the owner lock and the leases ---------------------------------------------------

/**
 * When process `pid` started (ms since the epoch, whole seconds: `ps -o lstart`), or null when
 * unknown (no such process, no ps). A lock, lease or watcher file keeps it next to the pid, so a
 * pid the system gave to another process since never reads as the holder still alive.
 */
export function processStart(pid: number, { exec = execFileSync as (file: string, args: string[], opts: object) => string | Buffer }: { exec?: (file: string, args: string[], opts: object) => string | Buffer } = {}): number | null {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || process.platform === "win32") return null;
  try {
    const out = String(exec("/bin/ps", ["-o", "lstart=", "-p", String(Number(pid))], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" }, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })).trim();
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

let ownStart: number | null | undefined;
/** This process' start (processStart), worked out once. */
export function selfStart(): number | null {
  if (ownStart === undefined) ownStart = processStart(process.pid);
  return ownStart;
}

type PidAlive = (pid: number, started?: number | null) => boolean;

/** Whether `pid` runs and (when its start is known on both sides) is the same process as when written. */
export function alive(pid: number, started: number | null = null, { start = processStart }: { start?: (pid: number) => number | null } = {}): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (error) { if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "EPERM")) return false; }
  if (started === null || started === undefined || !Number.isFinite(Number(started))) return true;
  const now = start(pid);
  // ps gives whole seconds: a second or two either way is the same process.
  return now === null || Math.abs(now - Number(started)) <= 2_000;
}

/**
 * The owner lock on the VM (create, start, stop, edit): one process at a
 * time, CLI or desktop. Stale when its pid is gone (or reused: the start
 * time is kept with it) or after `staleMs`. A stale lock is first renamed to
 * a name of its own and checked there, so two apps clearing it at once never
 * remove the lock a third one just took. Waits up to `waitMs`; returns
 * release() or null.
 */
export async function lockVm(home: string, { waitMs = 5 * 60_000, staleMs = 15 * 60_000, pidAlive = alive, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = () => Date.now(), what = "vm" }: { waitMs?: number; staleMs?: number; pidAlive?: PidAlive; sleep?: (ms: number) => Promise<void>; now?: () => number; what?: string } = {}): Promise<(() => void) | null> {
  const file = lockFile(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = now() + waitMs;
  const nonce = randomUUID();
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, started: selfStart(), nonce, at: now(), what })); } finally { closeSync(fd); }
      return () => {
        try { if (JSON.parse(readFileSync(file, "utf8"))?.nonce === nonce) unlinkSync(file); } catch { /* gone */ }
      };
    } catch (error) {
      if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST")) return null;
      let held: { pid?: number; started?: number | null; nonce?: string } | null = null;
      try { held = JSON.parse(readFileSync(file, "utf8")); } catch { /* half written */ }
      let age = 0;
      try { age = now() - statSync(file).mtimeMs; } catch { continue; }
      if ((held && !pidAlive(Number(held.pid), held.started ?? null)) || (!held && age > 5_000) || age > staleMs) {
        clearStale(file, held);
        continue;
      }
      if (now() > deadline) return null;
      await sleep(200);
    }
  }
}

/**
 * Remove the stale lock `held` (read from `file`): renamed aside first, then
 * removed only when the moved file is still that one; a lock someone took
 * meanwhile is put back (a link: never over a newer one).
 */
export function clearStale(file: string, held: { pid?: number; nonce?: string } | null): boolean {
  const aside = `${file}.stale.${process.pid}.${randomUUID().slice(0, 8)}`;
  try { renameSync(file, aside); } catch { return false; }
  let moved: { pid?: number; nonce?: string } | null = null;
  try { moved = JSON.parse(readFileSync(aside, "utf8")); } catch { /* half written */ }
  const same = held ? moved?.nonce === held.nonce && moved?.pid === held.pid : !moved;
  if (!same) {
    try { linkSync(aside, file); } catch { /* a newer lock is there: this one's holder sees it gone and asks again */ }
  }
  try { unlinkSync(aside); } catch { /* gone */ }
  return same;
}

/** A lease: this process runs box `key` in the VM. Returns release(). */
let leaseCount = 0;
export function takeLease(home: string, key: string, { pid = process.pid, client = "desktop", started = pid === process.pid ? selfStart() : processStart(pid) }: { pid?: number; client?: string; started?: number | null } = {}): () => void {
  // Its own file per lease (a keeper being replaced releases its old one later).
  leaseCount += 1;
  const file = path.join(leaseDir(home), `${key}-${pid}-${leaseCount}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, { pid, started, key, client, at: new Date().toISOString() });
  return () => { try { unlinkSync(file); } catch { /* gone */ } };
}

export type Lease = { pid: number; key: string; client: string; file: string };

/** The live leases; a lease of a gone process (or a reused pid) is removed. */
export function liveLeases(home: string, { pidAlive = alive, except = null }: { pidAlive?: PidAlive; except?: number | null } = {}): Lease[] {
  let names: string[] = [];
  try { names = readdirSync(leaseDir(home)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: Lease[] = [];
  for (const name of names) {
    const file = path.join(leaseDir(home), name);
    const lease = readJson<{ pid?: number; started?: number | null; key?: string; client?: string }>(file);
    if (!lease?.pid || !pidAlive(Number(lease.pid), lease.started ?? null)) { try { unlinkSync(file); } catch { /* raced */ } continue; }
    if (except && Number(lease.pid) === except) continue;
    out.push({ pid: Number(lease.pid), key: String(lease.key ?? ""), client: String(lease.client ?? ""), file });
  }
  return out;
}

// --- limactl calls -------------------------------------------------------------------

/** Whether a `limactl shell` failure is the VM being away (stopped, asleep, ssh gone), not the command's own. */
export function vmAway(res: Pick<RunResult, "code" | "stderr"> & { stdout?: string; error?: string | undefined }): boolean {
  if (res.error === "timeout") return true;
  const said = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
  return res.code === 255 || /is not running|not running|instance .* does not exist|ssh: connect|Connection refused|Connection reset|Broken pipe|kex_exchange|ControlSocket|mux_client|exit status 255/i.test(said);
}

/** A command in the VM as root, no shell in between. */
export function inVm(runtime: Pick<LimaRuntime, "instance">, argv: string[]): string[] {
  return ["shell", "--workdir", "/", runtime.instance, "sudo", "-n", ...argv];
}

type Ensure = (() => Promise<{ ok: boolean }>) | null;

/**
 * Run a command in the VM as root. After a failure that says the VM is away
 * (sleep, a stopped VM, a dead ssh master), the VM is started and the command
 * tried again; a VM listed as running whose ssh still refuses is restarted once.
 */
export async function vmCall(runtime: LimaRuntime, argv: string[], { run = runCommand, env = process.env, timeoutMs = 60_000, input, ensure = null, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), tries = 4, onLine, lock = lockVm }: { run?: RunCommand; env?: Env; timeoutMs?: number; input?: string; ensure?: Ensure; sleep?: (ms: number) => Promise<void>; tries?: number; onLine?: OnLine; lock?: typeof lockVm } = {}): Promise<RunResult> {
  const call = () => run(runtime.bin, inVm(runtime, argv), { env: limaEnv(runtime.home, env), timeoutMs, ...(input !== undefined ? { input } : {}), ...(onLine ? { onLine } : {}) });
  let res = await call();
  if (res.code === 0 || !vmAway(res) || !ensure) return res;
  const again = async (): Promise<RunResult> => {
    const started = await ensure();
    if (!started?.ok) return res;
    // A VM that is up but whose sshd drops the first connections (just woken, many at once): a few more tries.
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      res = await call();
      if (res.code === 0 || !vmAway(res) || attempt === tries) return res;
      await sleep(1_000 * attempt);
    }
    return res;
  };
  res = await again();
  // Listed as running but its ssh still refuses (sshd gone after a sleep, an idle stop half done): restart it once.
  if (res.code === 0 || !vmAway(res) || res.error === "timeout") return res;
  if (!(await restartVm(runtime, { run, env, lock })).ok) return res;
  return again();
}

/**
 * Stop a VM whose ssh does not answer, under the owner lock, so the next
 * ensure starts it again; never while a box runs in it.
 */
export async function restartVm(runtime: LimaRuntime, { run = runCommand, env = process.env, lock = lockVm, pidAlive = alive }: { run?: RunCommand; env?: Env; lock?: typeof lockVm; pidAlive?: PidAlive } = {}): Promise<{ ok: boolean }> {
  // Running boxes (another app's, this one's) keep running without ssh (ports go through Lima's agent): never taken down for this.
  if (liveLeases(runtime.home, { pidAlive, except: process.pid }).length || [...keepers.values()].some((k) => k.child && k.child.exitCode === null)) return { ok: false };
  const release = await lock(runtime.home, { what: "restart" });
  if (!release) return { ok: false };
  try {
    const check = await run(runtime.bin, inVm(runtime, ["true"]), { env: limaEnv(runtime.home, env), timeoutMs: 30_000 });
    // ssh answers again (another app restarted it, or the failure was the command's own): nothing to do.
    if (check.code === 0) return { ok: false };
    return stopVm(runtime, { run, env });
  } finally {
    release();
  }
}

/** Start the VM (made before). */
async function startVm(runtime: LimaRuntime, { run = runCommand, env = process.env, log = () => {} }: { run?: RunCommand; env?: Env; log?: BoxLog } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await run(runtime.bin, ["--tty=false", "start", runtime.instance, "--timeout", "5m"], { env: limaEnv(runtime.home, env), timeoutMs: 6 * 60_000 });
  writeLog(runtime.home, "start", res);
  if (res.code !== 0) return { ok: false, error: `the VM did not start: ${limaError(res)}` };
  log("info", "box vm started", { vm: runtime.instance });
  return { ok: true };
}

/** Stop the VM (`limactl stop`; forced after a minute). */
export async function stopVm(runtime: LimaRuntime, { run = runCommand, env = process.env }: { run?: RunCommand; env?: Env } = {}): Promise<{ ok: boolean }> {
  let res = await run(runtime.bin, ["--tty=false", "stop", runtime.instance], { env: limaEnv(runtime.home, env), timeoutMs: 90_000 });
  if (res.code !== 0 && !/not running/i.test(`${res.stderr}`)) res = await run(runtime.bin, ["--tty=false", "stop", "--force", runtime.instance], { env: limaEnv(runtime.home, env), timeoutMs: 60_000 });
  return { ok: res.code === 0 || /not running/i.test(`${res.stderr}`) };
}

/** The line of limactl's output that says why (its fatal/error line, else the last). */
export function limaError(res: Pick<RunResult, "code" | "stderr"> & { stdout?: string; error?: string | undefined }): string {
  const lines = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = [...lines].reverse().find((l) => /level=(fatal|error)/.test(l)) ?? [...lines].reverse().find((l) => /error|failed|denied|not supported/i.test(l)) ?? lines.at(-1) ?? String(res.error || res.code);
  const msg = /msg="((?:[^"\\]|\\.)*)"/.exec(pick);
  return (msg ? msg[1]!.replace(/\\"/g, '"') : pick).slice(0, 300);
}

function writeLog(home: string, what: string, res: RunResult): void {
  try {
    mkdirSync(limaDir(home), { recursive: true });
    writeFileSync(path.join(limaDir(home), `${what}.log`), `${new Date().toISOString()} code=${res.code}${res.error ? ` error=${res.error}` : ""}\n${String(res.stdout ?? "").slice(-20_000)}\n${String(res.stderr ?? "").slice(-40_000)}`);
  } catch { /* best effort */ }
}

type EnsureOptions = { env?: Env; arch?: string; setup?: DarwinSetup; run?: RunCommand; fetchFile?: FetchFile; log?: BoxLog; onLine?: OnLine };

/** limactl itself: downloaded once (pinned, sha256-checked) when this app ships none. */
export async function ensureLimactl(runtime: LimaRuntime, { env = process.env, arch = process.arch, setup = loadDarwinSetup(), run = runCommand, fetchFile = download, log = () => {}, onLine }: EnsureOptions = {}): Promise<{ ok: true; bin: string } | { ok: false; error: string }> {
  if (runtime.bin && existsSync(runtime.bin)) return { ok: true, bin: runtime.bin };
  const asset = limaAsset(setup, arch);
  const version = setup.lima?.version;
  if (!asset || !version) return { ok: false, error: "the OmniRush VM (Lima) is not published for this Mac yet" };
  const dir = limaDir(runtime.home);
  const dest = path.join(dir, "dist", version);
  const finished = path.join(dest, "bin", "limactl");
  // Another app (a CLI) set it up first: the unpacked folder only ever appears whole (a rename).
  const use = (): { ok: true; bin: string } => {
    runtime.bin = finished;
    runtime.limactlSource = "download";
    return { ok: true, bin: finished };
  };
  if (existsSync(finished)) return use();
  const tarball = path.join(dir, "cache", `lima-${asset.sha256.slice(0, 16)}.tar.gz`);
  say(onLine, "lima");
  try {
    await fetchChecked(asset.url, tarball, { algo: "sha256", digest: asset.sha256, fetchFile, onProgress: stepProgress("lima", onLine) });
  } catch (error) {
    if (existsSync(finished)) return use();
    return { ok: false, error: `could not download Lima: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (existsSync(finished)) return use();
  const tmp = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  mkdirSync(tmp, { recursive: true });
  const res = await run("/usr/bin/tar", ["-xzf", tarball, "-C", tmp], { env, timeoutMs: 120_000 });
  if (res.code !== 0 || !existsSync(path.join(tmp, "bin", "limactl"))) {
    rmSync(tmp, { recursive: true, force: true });
    // The tarball another app unpacked and removed meanwhile.
    if (existsSync(finished)) return use();
    return { ok: false, error: `could not unpack Lima: ${firstLine(res.stderr) || res.code}` };
  }
  // Only limactl and the Linux guest agent are used (vz is built in): the other drivers, the macOS guest agent and the wrappers go.
  const ls = (d: string) => { try { return readdirSync(d); } catch { return [] as string[]; } };
  rmSync(path.join(tmp, "libexec"), { recursive: true, force: true });
  for (const name of ls(path.join(tmp, "bin"))) if (name !== "limactl") rmSync(path.join(tmp, "bin", name), { force: true });
  for (const name of ls(path.join(tmp, "share", "lima"))) if (/^lima-guestagent\.Darwin/.test(name)) rmSync(path.join(tmp, "share", "lima", name), { force: true });
  if (existsSync(finished)) { rmSync(tmp, { recursive: true, force: true }); return use(); }
  // A whole folder another app renamed in first wins; a half-made one (no limactl: never one of ours) makes way.
  let moved: boolean | null = null;
  for (let attempt = 0; attempt < 2 && !moved; attempt += 1) {
    try { renameSync(tmp, dest); moved = true; } catch (error) {
      if (existsSync(finished)) break;
      if (attempt === 0 && existsSync(dest)) { rmSync(dest, { recursive: true, force: true }); continue; }
      rmSync(tmp, { recursive: true, force: true });
      return { ok: false, error: `could not unpack Lima: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!moved) { rmSync(tmp, { recursive: true, force: true }); return use(); }
  rmSync(tarball, { force: true });
  log("info", "box vm lima downloaded", { version });
  return use();
}

/** The VM disk image, downloaded once and checked (a local OMNIRUSH_BOX_LIMA_IMAGE is used as it is). */
export async function ensureImage(runtime: Pick<LimaRuntime, "home">, { env = process.env, arch = process.arch, setup = loadDarwinSetup(), fetchFile = download, onLine }: EnsureOptions = {}): Promise<{ ok: true; image: VmImage & { file: string } } | { ok: false; error: string }> {
  const image = vmImage({ env, setup, arch, home: runtime.home });
  if (!image?.file) return { ok: false, error: "the OmniRush VM image is not published yet" };
  const file = image.file;
  if (image.kind === "local") return existsSync(file) ? { ok: true, image: { ...image, file } } : { ok: false, error: `OMNIRUSH_BOX_LIMA_IMAGE: ${file} is missing` };
  mkdirSync(path.dirname(file), { recursive: true });
  say(onLine, "vm_image");
  try {
    await fetchChecked(String(image.url), file, { algo: image.algo ?? "sha256", digest: String(image.digest), fetchFile, onProgress: stepProgress("vm_image", onLine) });
  } catch (error) {
    return { ok: false, error: `could not download the VM image: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, image: { ...image, file } };
}

export type VmContract = { contract: number; image: { kind: string; version: string | null; digest: string | null } | null; client: string; client_version: string; lima: string; created_at: string };

/** /opt/omnirush/vm.json in the VM (null: none yet, or the VM is away). */
async function readContract(runtime: LimaRuntime, opts: { run?: RunCommand; env?: Env }): Promise<VmContract | null> {
  const res = await vmCall(runtime, ["cat", `${OPT}/vm.json`], { ...opts, timeoutMs: 30_000 });
  if (res.code !== 0) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

/** Desktop: this app's version (the server package's, the app's own in a packaged build). */
function ownVersion(env: Env = process.env): string {
  return String(env.OMNIRUSH_APP_VERSION || serverPackage.version || "");
}

/** What this client would write as the VM's contract. */
export function contractFor(image: Pick<VmImage, "kind" | "version" | "digest" | "algo"> | null, { client = "desktop", clientVersion = ownVersion(), lima = "" }: { client?: string; clientVersion?: string; lima?: string } = {}): VmContract {
  return { contract: VM_CONTRACT, image: image ? { kind: image.kind, version: image.version, digest: image.digest ? `${image.algo}:${image.digest}` : null } : null, client, client_version: clientVersion, lima, created_at: new Date().toISOString() };
}

/**
 * Whether this client may use a VM made under `have` (its /opt/omnirush/vm.json):
 * "use" (same contract), "replace" (an older contract: only when no box runs), "newer" (made by a newer client: used as it is,
 * never changed).
 */
export function contractVerdict(have: { contract?: unknown } | null | undefined): "use" | "replace" | "newer" {
  const got = Number(have?.contract);
  if (!Number.isFinite(got) || got === VM_CONTRACT) return "use";
  return got < VM_CONTRACT ? "replace" : "newer";
}

export type EnsureVmOptions = {
  env?: Env; run?: RunCommand; log?: BoxLog; paths?: Array<string | null | undefined>; arch?: string; setup?: DarwinSetup; fetchFile?: FetchFile; userHome?: string;
  spawnImpl?: SpawnLike; clientVersion?: string; client?: string; resources?: { cpus: number; memory: number; disk: number } | null; now?: () => number; selfKey?: string | null; onLine?: OnLine;
};
export type EnsureVmResult = { ok: true; started: boolean; created?: boolean; contract?: VmContract | null; verdict?: "use" | "replace" | "newer" } | { ok: false; error: string };

/**
 * Make sure the VM runs and can take `paths` (the folders a box binds):
 * limactl and the image downloaded, the VM made (or started), a folder outside
 * the shared ones added (one restart, only while no other box runs), the
 * contract written. Holds the owner lock while it changes the VM.
 */
export async function ensureVm(runtime: LimaRuntime, { env = process.env, run = runCommand, log = () => {}, paths = [], arch = process.arch, setup = loadDarwinSetup(), fetchFile = download, userHome = os.homedir(), spawnImpl, clientVersion = ownVersion(env), client = "desktop", resources = null, now = Date.now, selfKey = null, onLine }: EnsureVmOptions = {}): Promise<EnsureVmResult> {
  const lima = await ensureLimactl(runtime, { env, arch, setup, run, fetchFile, log, onLine });
  if (!lima.ok) return lima;
  const first = await vmRow(runtime, { run, env });
  let { row } = first;
  if (!row && !first.missing) return { ok: false, error: `limactl does not answer: ${limaError(first.res)}` };
  const wanted = (r: LimaRow | null) => uncovered(paths, (r?.config?.mounts ?? []).map((m) => m.mountPoint || m.location));
  if (row?.status === "Running" && !wanted(row).length) {
    keepIdleWatch(runtime, { env, ...(spawnImpl ? { spawnImpl } : {}) });
    return { ok: true, started: false };
  }
  let image: (VmImage & { file: string }) | null = null;
  if (!row) {
    const got = await ensureImage(runtime, { env, arch, setup, fetchFile, onLine });
    if (!got.ok) return got;
    image = got.image;
  }
  let madeNow = false;
  say(onLine, "vm_boot");
  const release = await lockVm(runtime.home, { what: row ? "start" : "create" });
  if (!release) return { ok: false, error: "another OmniRush app is setting up the sandbox VM; try again in a minute" };
  try {
    ({ row } = await vmRow(runtime, { run, env }));
    const missing = row ? wanted(row) : [];
    if (row && missing.length) {
      // A project outside the shared folders: the VM gets it on its next start.
      if (row.status === "Running") {
        // Every running box counts, this process' other ones too (the desktop runs many); not the one starting now.
        const others = liveLeases(runtime.home).filter((l) => !(l.pid === process.pid && (l.key === selfKey || l.key === "pull")));
        if (others.length) return { ok: false, error: `${missing[0]} is outside the folders the sandbox VM shares, and it can only add it while no other chat uses the sandbox (move the project under your home folder, or close the other chats)` };
        log("info", "box vm restarting to share a folder", { folders: missing });
        await stopVm(runtime, { run, env });
      }
      const mounts = [...(row.config?.mounts ?? []).map((m) => ({ location: m.location, mountPoint: m.mountPoint || m.location, writable: m.writable !== false })), ...missing.map((location) => ({ location, mountPoint: location, writable: true }))];
      const edit = await run(runtime.bin, ["--tty=false", "edit", runtime.instance, "--set", `.mounts = ${JSON.stringify(mounts)}`], { env: limaEnv(runtime.home, env), timeoutMs: 60_000 });
      if (edit.code !== 0) return { ok: false, error: `could not share ${missing[0]} with the sandbox VM: ${limaError(edit)}` };
      row = { ...row, status: "Stopped" };
    }
    if (!row) {
      if (!image) {
        // Deleted by someone else meanwhile: made again here.
        const got = await ensureImage(runtime, { env, arch, setup, fetchFile, onLine });
        if (!got.ok) return got;
        image = got.image;
      }
      const res = resources ?? vmResources({ setup, env });
      const config = vmConfig({ image: image.file, arch, ...res, mounts: vmMounts({ userHome, extra: uncovered(paths, vmMounts({ userHome })) }) });
      const file = path.join(limaDir(runtime.home), `${runtime.instance}.yaml`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `# Written by OmniRush for its sandbox VM (made once; \`limactl edit\` changes it).\n${JSON.stringify(config, null, 2)}\n`);
      const started = now();
      const made = await run(runtime.bin, ["--tty=false", "start", "--name", runtime.instance, "--timeout", "8m", file], { env: limaEnv(runtime.home, env), timeoutMs: 10 * 60_000 });
      writeLog(runtime.home, "create", made);
      if (made.code !== 0) {
        markFailed(runtime.home, limaError(made));
        return { ok: false, error: `could not set up the sandbox VM: ${limaError(made)}` };
      }
      runtime.installed = true;
      madeNow = true;
      // A new VM has none of the old one's boxes or images (one deleted with limactl, a reset).
      for (const f of [presentFile(runtime.home), pendingFile(runtime.home)]) rmSync(f, { force: true });
      rmSync(path.join(limaDir(runtime.home), "boxes"), { recursive: true, force: true });
      log("info", "box vm created", { vm: runtime.instance, image: image.kind, version: image.version, ms: now() - started });
      const contract = contractFor(image, { client, clientVersion, lima: (await limaVersion(runtime, { run, env })) || "" });
      const wrote = await vmCall(runtime, ["/bin/sh", "-c", `mkdir -p ${OPT} && cat > ${OPT}/vm.json.new && mv ${OPT}/vm.json.new ${OPT}/vm.json`], { run, env, input: JSON.stringify(contract) });
      if (wrote.code !== 0) log("warn", "box vm contract not written", { error: firstLine(wrote.stderr) });
    } else if (row.status !== "Running") {
      const started = await startVm(runtime, { run, env, log });
      if (!started.ok) {
        markFailed(runtime.home, started.error);
        return started;
      }
    }
    clearFailed(runtime.home);
  } finally {
    release();
  }
  const have = await readContract(runtime, { run, env });
  const verdict = contractVerdict(have);
  if (verdict === "replace") log("info", "box vm made by an older OmniRush; kept until no box uses it", { contract: have?.contract });
  await runPendingRemovals(runtime, { run, env });
  keepIdleWatch(runtime, { env, ...(spawnImpl ? { spawnImpl } : {}) });
  return { ok: true, started: true, created: madeNow, contract: have, verdict };
}

async function limaVersion(runtime: LimaRuntime, { run = runCommand, env = process.env }: { run?: RunCommand; env?: Env } = {}): Promise<string> {
  const res = await run(runtime.bin, ["--version"], { env: limaEnv(runtime.home, env), timeoutMs: 10_000 });
  return (/(\d+\.\d+\.\d+)/.exec(res.stdout ?? "") ?? [])[1] ?? "";
}

function markFailed(home: string, reason: string): void {
  try { writeJson(failedFile(home), { at: Date.now(), reason: String(reason).slice(0, 200) }); } catch { /* best effort */ }
}
function clearFailed(home: string): void {
  try { rmSync(failedFile(home), { force: true }); } catch { /* none */ }
}

/**
 * Desktop: the idle watcher's script, next to this module (lima-idle.js in a
 * build; lima-idle.ts when the server runs from source under bun).
 */
export function idleMain(dir = HERE, exists: (file: string) => boolean = existsSync): string | null {
  return [path.join(dir, "lima-idle.js"), path.join(dir, "lima-idle.ts")].find((file) => exists(file)) ?? null;
}

/**
 * The idle watcher, one per VM (the CLI's or this app's; idle.json names its
 * pid): started detached when none runs. Desktop: run with this app's own
 * binary as node (ELECTRON_RUN_AS_NODE=1), so it outlives the app.
 */
export function keepIdleWatch(runtime: Pick<LimaRuntime, "home" | "bin" | "instance">, { env = process.env, spawnImpl = spawn, node = process.execPath, pidAlive = alive, script = idleMain() }: { env?: Env; spawnImpl?: SpawnLike; node?: string; pidAlive?: PidAlive; script?: string | null } = {}): number | null {
  if (idleStopMinutes({ env }) <= 0 || !script) return null;
  const held = readJson<{ pid?: number; started?: number | null }>(idleFile(runtime.home));
  if (held?.pid && pidAlive(Number(held.pid), held.started ?? null)) return Number(held.pid);
  try {
    const child: ChildProcess = spawnImpl(node, [script, runtime.home, runtime.bin, runtime.instance], {
      env: { ...env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), OMNIRUSH_BOX_LIMA_IDLE_PARENT: String(process.pid) },
      detached: true,
      stdio: "ignore",
    });
    child.unref?.();
    if (child.pid) writeJson(idleFile(runtime.home), { pid: child.pid, started: processStart(child.pid), at: new Date().toISOString() });
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * One step of the idle watcher: { stop: true } when the VM runs, no lease is
 * live and it has been idle for `idleMs` since `busyAt` (the caller stops it
 * under the owner lock); { done: true } when the VM is not running.
 */
export async function idleStep(runtime: LimaRuntime, { busyAt, now = Date.now(), idleMs, run = runCommand, env = process.env, pidAlive = alive }: { busyAt: number; now?: number; idleMs: number; run?: RunCommand; env?: Env; pidAlive?: PidAlive }): Promise<{ busyAt: number; stop?: true; done?: true }> {
  const { row, missing } = await vmRow(runtime, { run, env });
  if (missing || (row && row.status !== "Running")) return { done: true, busyAt };
  if (liveLeases(runtime.home, { pidAlive }).length) return { busyAt: now };
  return now - busyAt >= idleMs ? { stop: true, busyAt } : { busyAt };
}

/** Stop the VM when it is still idle, under the owner lock (the idle watcher's last step). */
export async function stopIfIdle(runtime: LimaRuntime, { run = runCommand, env = process.env, pidAlive = alive, lock = lockVm }: { run?: RunCommand; env?: Env; pidAlive?: PidAlive; lock?: typeof lockVm } = {}): Promise<{ stopped: boolean; reason?: string }> {
  const release = await lock(runtime.home, { waitMs: 30_000, what: "idle-stop" });
  if (!release) return { stopped: false, reason: "locked" };
  try {
    if (liveLeases(runtime.home, { pidAlive }).length) return { stopped: false, reason: "busy" };
    const done = await stopVm(runtime, { run, env });
    return { stopped: done.ok };
  } finally {
    release();
  }
}

// --- the helpers in the VM -----------------------------------------------------------

/** A stamp of the helpers this install ships (the CLI's formula: the same helpers get the same folder). */
function helperStamp(files: string[]): string {
  const hash = createHash("sha256");
  for (const f of files) { try { const s = statSync(f); hash.update(`${s.size}-${Math.floor(s.mtimeMs)};`); } catch { hash.update("0;"); } }
  return hash.digest("hex").slice(0, 16);
}

/** The install script for the helpers in the VM: the same text as the CLI's (the same folders, the same newest-five rule). */
export const HELPER_SCRIPT = 'set -e; d="$1"; if [ ! -x "$d/boxd" ]; then mkdir -p "$d.tmp"; install -m 0755 "$2/boxrun" "$d.tmp/boxrun"; install -m 0755 "$2/boxd" "$d.tmp/boxd"; rm -rf "$d"; mv "$d.tmp" "$d"; fi; touch "$d"; ln -sfn "$d/boxrun" /opt/omnirush/boxrun; ln -sfn "$d/boxd" /opt/omnirush/boxd; ls -1dt /opt/omnirush/h/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf';

/**
 * Copy this install's boxrun and boxd into the VM, each install's into its
 * own folder (/opt/omnirush/h/<stamp>), so the CLI and the desktop app (each
 * with its own helpers) never swap them under each other. Staged through the
 * box home (shared into the VM).
 */
export async function syncHelpers(runtime: LimaRuntime, { env = process.env, run = runCommand, ensure = null }: { env?: Env; run?: RunCommand; ensure?: Ensure } = {}): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const goarch = runtime.arch || "arm64";
  const boxrun = helperPath("boxrun", { goos: "linux", goarch, env });
  const boxd = helperPath("boxd", { goos: "linux", goarch, env });
  if (!boxrun || !boxd) return { ok: false, error: "the sandbox helpers (linux boxrun, boxd) are missing from this install" };
  const stamp = helperStamp([boxrun, boxd]);
  const dir = `${OPT}/h/${stamp}`;
  if (runtime.helpers === dir) return { ok: true, dir };
  const stage = path.join(limaDir(runtime.home), "helpers", stamp);
  if (!existsSync(path.join(stage, "boxd"))) {
    mkdirSync(stage, { recursive: true });
    copyFileSync(boxrun, path.join(stage, "boxrun"));
    copyFileSync(boxd, path.join(stage, "boxd"));
  }
  const res = await vmCall(runtime, ["/bin/sh", "-c", HELPER_SCRIPT, "sh", dir, stage], { run, env, timeoutMs: 120_000, ensure });
  if (res.code !== 0) return { ok: false, error: `could not update the helpers in the sandbox VM: ${firstLine(res.stderr) || res.code}` };
  runtime.helpers = dir;
  // The staged copies are only a way in.
  try { for (const name of readdirSync(path.dirname(stage))) if (name !== stamp) rmSync(path.join(path.dirname(stage), name), { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true, dir };
}

async function boxrun(runtime: LimaRuntime, args: string[], { run = runCommand, env = process.env, timeoutMs = 60_000, ensure = null, onLine }: { run?: RunCommand; env?: Env; timeoutMs?: number; ensure?: Ensure; onLine?: OnLine } = {}): Promise<{ res: RunResult; out: Record<string, unknown> | null }> {
  const res = await vmCall(runtime, [`${runtime.helpers || OPT}/boxrun`, ...args], { run, env, timeoutMs, ensure, ...(onLine ? { onLine } : {}) });
  return { res, out: parseOut(res.stdout) };
}

// --- images --------------------------------------------------------------------------

function readPresent(home: string): Record<string, PresentImage & { at?: string }> {
  const data = readJson<Record<string, PresentImage & { at?: string }>>(presentFile(home));
  return data && typeof data === "object" ? data : {};
}
function notePresent(home: string, ref: string, value: PresentImage | null): void {
  try {
    const data = readPresent(home);
    if (value) data[ref] = { ...value, at: new Date().toISOString() };
    else delete data[ref];
    writeJson(presentFile(home), data);
  } catch { /* best effort */ }
}

/** The runtime as the VM's calls need it (the box home and the VM's name filled in; limactl when it is here). */
function withHome(runtime: BoxRuntime | LimaRuntime, home: string | undefined): LimaRuntime {
  const rt = runtime as BoxRuntime & Partial<LimaRuntime>;
  if (!rt.home && home) rt.home = home;
  if (!rt.instance) rt.instance = vmName();
  if (!rt.bin && rt.home) rt.bin = findLimactl({ home: rt.home }).bin ?? "";
  return rt as LimaRuntime;
}

/** The VM, running: is it? (no start) */
async function running(runtime: LimaRuntime, { run = runCommand, env = process.env }: { run?: RunCommand; env?: Env } = {}): Promise<boolean> {
  if (!runtime.bin || !existsSync(runtime.bin)) return false;
  const { row } = await vmRow(runtime, { run, env });
  return row?.status === "Running";
}

/**
 * The image in the VM's store: asked of boxrun while the VM runs; while it is
 * stopped, what the last look found (images.json): a status never boots the VM to ask.
 */
async function imagePresent(runtime: BoxRuntime | LimaRuntime, image: { pull: string }, { run = runCommand, env = process.env, home }: { run?: RunCommand; env?: Env; home?: string } = {}): Promise<PresentImage | null> {
  const rt = withHome(runtime, home);
  if (!rt.bin || !existsSync(rt.bin)) return null;
  const { row } = await vmRow(rt, { run, env });
  if (!row) return null;
  if (row.status !== "Running") return readPresent(rt.home)[image.pull] ?? null;
  const synced = await syncHelpers(rt, { env, run });
  if (!synced.ok) return readPresent(rt.home)[image.pull] ?? null;
  const { out } = await boxrun(rt, ["image", "--store", STORE, "--ref", image.pull, "--arch", rt.arch || "arm64"], { run, env });
  const present = out?.present ? { id: str(out.id), digest: str(out.digest) || null, arch: str(out.arch), config: str(out.config) } : null;
  notePresent(rt.home, image.pull, present);
  return present;
}

type PullOptions = { run?: RunCommand; env?: Env; home?: string; log?: BoxLog; onLine?: OnLine; ensureOpts?: EnsureVmOptions };

/** "Download": Lima and the VM (once), the helpers, then the image inside it. */
async function pull(runtime: BoxRuntime | LimaRuntime, image: { pull: string }, opts: PullOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  // A lease for the download: the idle stop never takes the VM away under a long first download.
  const release = takeLease(opts.home || String((runtime as Partial<LimaRuntime>).home ?? ""), "pull");
  try { return await pullNow(runtime, image, opts); } finally { release(); }
}

async function pullNow(runtime: BoxRuntime | LimaRuntime, image: { pull: string }, { run = runCommand, env = process.env, home, log = () => {}, onLine, ensureOpts = {} }: PullOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const rt = withHome(runtime, home);
  const base = { env, run, log, paths: [rt.home], ...ensureOpts, ...(onLine ? { onLine } : {}) };
  const vm = await ensureVm(rt, base);
  if (!vm.ok) return { ok: false, error: vm.error };
  const ensure = () => ensureVm(rt, base);
  const synced = await syncHelpers(rt, { env, run, ensure });
  if (!synced.ok) return { ok: false, error: synced.error };
  say(onLine, "image");
  const { res, out } = await boxrun(rt, ["pull", "--store", STORE, "--ref", image.pull, "--arch", rt.arch || "arm64"], { run, env, timeoutMs: 60 * 60_000, ensure, ...(onLine ? { onLine } : {}) });
  if (!out?.ok) return { ok: false, error: String(str(out?.error) || firstLine(res.stderr) || res.code).slice(0, 300) };
  await imagePresent(rt, image, { run, env });
  return { ok: true };
}

// --- boxes ---------------------------------------------------------------------------

type Keeper = { child: ChildProcess; endpoint: { host: string; port: number; token: string }; release: () => void };

/** Keepers (`limactl shell ... boxrun up --foreground`) of this process, per box, with their leases. */
const keepers = new Map<string, Keeper>();
let exitHook = false;
function releaseAllOnExit(): void {
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { for (const k of keepers.values()) try { k.release(); } catch { /* gone */ } });
}

export type KeeperResult = { ok: true; out: Record<string, unknown>; child: ChildProcess } | { ok: false; error: string; code?: number | null; away?: boolean };

/** Start the keeper and read boxrun's first JSON line (the port). */
export function startKeeper(runtime: LimaRuntime, args: string[], { env = process.env, spawnImpl = spawn, timeoutMs = 180_000 }: { env?: Env; spawnImpl?: SpawnLike; timeoutMs?: number } = {}): Promise<KeeperResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(runtime.bin, inVm(runtime, [`${runtime.helpers || OPT}/boxrun`, ...args, "--foreground"]), { env: limaEnv(runtime.home, env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let buffered = "";
    let errText = "";
    let done = false;
    const finish = (value: { ok: true; out: Record<string, unknown> } | { ok: false; error: string; code?: number | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (value.ok) {
        child.stdout?.removeAllListeners("data");
        child.stdout?.resume();
        child.unref();
        for (const handle of [child.stdin, child.stdout, child.stderr]) {
          if (handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
        }
        resolve({ ...value, child });
      } else {
        try { child.kill(); } catch { /* gone */ }
        resolve({ ...value, away: vmAway({ code: value.code ?? -1, stderr: errText }) });
      }
    };
    const timer = setTimeout(() => finish({ ok: false, error: `the sandbox VM did not start the box in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += String(chunk);
      const out = parseOut(buffered.split("\n").filter((line) => line.trim().startsWith("{")).join("\n"));
      if (out) finish(out.ok ? { ok: true, out } : { ok: false, error: str(out.error) || "boxrun up failed" });
    });
    child.stderr?.on("data", (chunk: Buffer) => { if (errText.length < 4000) errText += String(chunk); });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({ ok: false, code, error: `the sandbox VM's keeper exited (${code}): ${firstLine(errText)}` }));
  });
}

type LimaMeta = BoxMeta & { shadows?: string[]; started_at?: string };

/** The host folders a box binds (each must be shared into the VM). */
export function bindSources({ root, runFolder, shims, pkglog }: { root: string; runFolder: string; shims?: string | null; pkglog?: { root: string } | null }): string[] {
  return [root, runFolder, shims, pkglog?.root].filter((p): p is string => Boolean(p));
}

/** Desktop: what the tests swap in (the VM's own calls, the idle watcher's spawn, the downloads). */
export type LimaOpenExtras = { idleSpawn?: SpawnLike; fetchFile?: FetchFile; userHome?: string; resources?: { cpus: number; memory: number; disk: number }; freePort?: () => Promise<number> };

async function open(ctx: OpenContext & LimaOpenExtras): Promise<Opened> {
  const { key, root, runtime: given, home, log } = ctx;
  const runtime = withHome(given, home);
  const file = metaFile(home, key);
  const meta = readJson<LimaMeta>(file);
  if (meta && meta.root !== root) return { ok: false, error: `box ${key} belongs to another folder` };
  const live = keepers.get(key);
  if (live && live.child.exitCode === null && meta) {
    // After sleep the forward of the VM's loopback (or boxd, at its idle limit) can be gone: reused only when boxd answers.
    if (await (ctx.ping ?? ping)(live.endpoint, { timeoutMs: 1_500 })) {
      return { ok: true, created: null, endpoint: live.endpoint, uid: 0, gid: 0, containerId: `lima_${key}_${meta.instance}`, imageId: meta.config || meta.image, mounts: meta.mounts ?? [], shadows: meta.shadows ?? [] };
    }
    log("info", "box keeper running but boxd not answering; starting it again", { key });
    try { live.child.kill(); } catch { /* gone */ }
    live.release();
    keepers.delete(key);
  }
  // The lease from the start (a first start downloads for minutes): the idle stop leaves the VM up meanwhile.
  const release = takeLease(home, key);
  try {
    const opened = await openWithLease(ctx, runtime, meta, release);
    if (!opened.ok) release();
    return opened;
  } catch (error) {
    release();
    throw error;
  }
}

async function openWithLease(ctx: OpenContext & LimaOpenExtras, runtime: LimaRuntime, given: LimaMeta | null, release: () => void): Promise<Opened> {
  const { key, root, croot, run, home, runFolder, image, pull: mayPull, shims, pkglog, shadows = null, env, log, onPulling, onLine, spawnImpl } = ctx;
  let meta = given;
  const file = metaFile(home, key);
  const paths = bindSources({ root, runFolder, shims, pkglog });
  const ensureOpts: EnsureVmOptions = { ...(ctx.idleSpawn ? { spawnImpl: ctx.idleSpawn } : {}), ...(ctx.fetchFile ? { fetchFile: ctx.fetchFile } : {}), ...(ctx.userHome ? { userHome: ctx.userHome } : {}), ...(ctx.resources ? { resources: ctx.resources } : {}), selfKey: key, ...(onLine ? { onLine } : {}) };
  const ensure = () => ensureVm(runtime, { env, run, log, paths, ...ensureOpts });
  const made = runtime.bin && existsSync(runtime.bin) ? Boolean((await vmRow(runtime, { run, env })).row) : false;
  if (!made) {
    // Making the VM is the "download" of this backend (Lima, the VM image, then the box image).
    if (!mayPull) return { ok: false, error: "the OmniRush sandbox VM is not set up yet" };
    onPulling();
  }
  const vm = await ensure();
  if (!vm.ok) return { ok: false, error: `could not start the sandbox VM: ${vm.error}` };
  const synced = await syncHelpers(runtime, { env, run, ensure });
  if (!synced.ok) return { ok: false, error: synced.error };
  if (vm.created) meta = null;
  let present = await imagePresent(runtime, image, { run, env });
  // (a box whose image went from the store, e.g. a VM made again, gets it again when it may download)
  if (!present && (!meta || mayPull)) {
    if (!mayPull) return { ok: false, error: "the sandbox image is not downloaded yet" };
    onPulling();
    const pulled = await pull(runtime, image, { run, env, home, log, ...(onLine ? { onLine } : {}), ensureOpts: { ...ensureOpts, paths } });
    if (!pulled.ok) return { ok: false, error: `could not set up the sandbox: ${pulled.error}` };
    present = await imagePresent(runtime, image, { run, env });
    if (!present) return { ok: false, error: "the sandbox image is not there after the download" };
  }
  let created = null;
  if (!meta) {
    if (!present) return { ok: false, error: "the sandbox image is not downloaded yet" };
    meta = newMeta({ key, root, croot, present, image });
    mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, meta);
    created = { ref: image.ref, pull: image.pull, digest: meta.digest, id: present.config || present.id, stack: image.stack };
    log("info", "box created", { key, image: image.pull, stack: image.stack, backend: "lima" });
  }
  const idle = Number(env.OMNIRUSH_BOX_IDLE_MIN) > 0 ? Number(env.OMNIRUSH_BOX_IDLE_MIN) : IDLE_MINUTES;
  // A port free on this Mac, so Lima's forward of the VM's loopback lands at the same number.
  const port = await (ctx.freePort ?? freePort)();
  const args = upArgs({
    box: boxPath(key), store: STORE, image: meta.image, boxd: `${runtime.helpers}/boxd`, portFile: path.join(runFolder, "boxd.port"),
    root, croot, runFolder, shims, pkglog, token: meta.token, idleMinutes: idle, listen: `127.0.0.1:${port}`, platform: "darwin",
    shadows, shadowStore: shadows ? `${SHADOW_STORES}/${key}` : null,
  });
  releaseAllOnExit();
  let kept = await startKeeper(runtime, args, { env, ...(spawnImpl ? { spawnImpl } : {}) });
  if (!kept.ok && kept.away) {
    // The VM went away between the check and the start (sleep, an idle stop): started once more.
    const again = await ensure();
    if (again.ok) kept = await startKeeper(runtime, args, { env, ...(spawnImpl ? { spawnImpl } : {}) });
  }
  if (!kept.ok) return { ok: false, error: `could not start the sandbox: ${kept.error}` };
  const endpoint = { host: "127.0.0.1", port: num(kept.out.port) ?? 0, token: meta.token };
  const mounts = [croot, "/run/omnirush", ...(shims ? ["/opt/omnirush/pkglog-src"] : []), ...(pkglog ? [pkglog.root] : [])];
  // The folders boxrun shadowed (a box it found running keeps the set it started with).
  const reported = Array.isArray(kept.out.shadows) ? kept.out.shadows.filter((item): item is string => typeof item === "string") : null;
  const shadowed = reported ?? (kept.out.reused ? (meta.shadows ?? []) : []);
  if (!kept.out.reused) writeJson(file, { ...meta, mounts, shadows: shadowed, started_at: new Date().toISOString() });
  const entry: Keeper = { child: kept.child, endpoint, release };
  kept.child.on?.("close", () => { release(); if (keepers.get(key) === entry) keepers.delete(key); });
  keepers.set(key, entry);
  return { ok: true, created, endpoint, uid: 0, gid: 0, containerId: `lima_${key}_${meta.instance}`, imageId: meta.config || meta.image, mounts: kept.out.reused ? (meta.mounts ?? mounts) : mounts, shadows: shadowed, timing: { ...(num(kept.out.ms) !== null ? { ms: Number(kept.out.ms) } : {}), reused: Boolean(kept.out.reused) } };
}

function keeperAlive(key: string): boolean {
  const live = keepers.get(key);
  return Boolean(live && live.child.exitCode === null);
}

async function list(runtime: BoxRuntime | LimaRuntime, { home = "" }: { home?: string } = {}): Promise<ListedBox[]> {
  const dir = path.join(limaDir(home), "boxes");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  void runtime;
  const leases = new Set(liveLeases(home).map((l) => l.key));
  return names.map((n) => readJson<LimaMeta>(path.join(dir, n))).filter((m): m is LimaMeta => Boolean(m?.key)).map((m) => ({ key: m.key, name: containerName(m.key), root: m.root, running: leases.has(m.key) || keeperAlive(m.key), image: m.pull || m.ref, created: m.created_at || "" }));
}

/** Box removals asked for while the VM was stopped: done at its next start (never a start of their own). */
async function runPendingRemovals(runtime: LimaRuntime, { run = runCommand, env = process.env }: { run?: RunCommand; env?: Env } = {}): Promise<void> {
  const keys = readJson<unknown[]>(pendingFile(runtime.home));
  if (!Array.isArray(keys) || !keys.length) return;
  const left: string[] = [];
  for (const key of keys) {
    if (!/^[0-9a-zA-Z_-]+$/.test(String(key))) continue;
    if (!runtime.helpers) await syncHelpers(runtime, { env, run });
    const { out } = await boxrun(runtime, ["rm", "--box", boxPath(String(key))], { run, env, timeoutMs: 120_000 });
    if (!out?.ok) left.push(String(key));
  }
  if (left.length) writeJson(pendingFile(runtime.home), left);
  else rmSync(pendingFile(runtime.home), { force: true });
}

export const limaDriver: BoxDriver = {
  kind: "lima",
  execFallback: false,
  /** boxrun runs as root in the VM: a box here gets its own build folders on this Mac (required.ts). */
  shadows: true,
  /** Lima forwards the VM's loopback ports to this Mac's 127.0.0.1 itself (the boxes share the VM's network). */
  forwardsPorts: true,
  imagePresent,
  pull,
  /** Desktop: Lima, the VM and the image download run in this process (launch.ts pullInBackground), as for the WSL distro. */
  pullCommand() {
    return null;
  },
  /** The box's record, in a VM that is still there (one deleted with limactl takes its boxes along). */
  async exists(runtime, key, { home = "", run = runCommand, env = process.env } = {}) {
    if (!existsSync(metaFile(home, key))) return false;
    const rt = withHome(runtime, home);
    if (!rt.bin || !existsSync(rt.bin)) return false;
    return !(await vmRow(rt, { run, env })).missing;
  },
  open,
  list,
  async remove(runtime, key, { run = runCommand, env = process.env, home = "" } = {}) {
    const rt = withHome(runtime, home);
    const k = keepers.get(key);
    try { k?.child.kill(); } catch { /* gone */ }
    k?.release();
    keepers.delete(key);
    const had = existsSync(metaFile(home, key));
    let ok = false;
    if (await running(rt, { run, env })) {
      if (!rt.helpers) await syncHelpers(rt, { env, run });
      ok = Boolean((await boxrun(rt, ["rm", "--box", boxPath(key)], { run, env, timeoutMs: 120_000 })).out?.ok);
    } else if (had) {
      const pending = readJson<unknown[]>(pendingFile(home));
      writeJson(pendingFile(home), [...new Set([...(Array.isArray(pending) ? pending.map(String) : []), key])]);
      ok = true;
    }
    rmSync(metaFile(home, key), { force: true });
    return { removed: had && ok };
  },
  async stop(runtime, key, { run = runCommand, env = process.env, home = "" } = {}) {
    const rt = withHome(runtime, home);
    const k = keepers.get(key);
    try { k?.child.kill(); } catch { /* gone */ }
    k?.release();
    keepers.delete(key);
    if (!(await running(rt, { run, env }))) return { stopped: true };
    if (!rt.helpers) await syncHelpers(rt, { env, run });
    const { out } = await boxrun(rt, ["stop", "--box", boxPath(key)], { run, env });
    return { stopped: Boolean(out?.ok) };
  },
  /**
   * Box images in the VM's store that no box uses and that are neither the
   * current nor the previous pins (only while the VM runs: never started for
   * this), downloads of other Lima versions and VM images on this Mac.
   */
  async gcImages(runtime, { run = runCommand, env = process.env, home = "", current, used, keep = { refs: current, digests: new Set<string>() }, dryRun = false, now = Date.now(), setup = loadDarwinSetup() }: Parameters<BoxDriver["gcImages"]>[1] & { setup?: DarwinSetup }) {
    const rt = withHome(runtime, home);
    const removed: Removed[] = [];
    if (home) {
      const drop = (item: { path: string }, reason: string) => {
        if (dryRun) removed.push({ kind: "download", name: item.path, reason, dryRun: true });
        else if (removeTree(item.path)) removed.push({ kind: "download", name: item.path, reason });
      };
      const version = setup.lima?.version;
      // Lima of other pins: unused once a newer one is here (the one in use is never removed).
      const inUse = rt.bin ? path.resolve(rt.bin, "..", "..") : null;
      for (const item of staleEntries(path.join(limaDir(home), "dist"), { now, maxAgeMs: -1, match: (name: string) => name !== version && !name.endsWith(".tmp") })) if (item.path !== inUse) drop(item, "Lima of other pins");
      // The VM image of other pins (a made VM no longer reads its image; the current one stays for a re-make).
      const image = vmImage({ env, setup, home });
      for (const item of staleEntries(path.join(limaDir(home), "images"), { now, maxAgeMs: -1, match: (name: string) => /\.(qcow2|raw)$/.test(name) && (!image?.file || name !== path.basename(image.file)) })) drop(item, "VM image of other pins");
      for (const dir of ["images", "cache", "dist"]) for (const item of staleEntries(path.join(limaDir(home), dir), { now, match: (name: string) => /\.dl$|\.tmp$|\.part$/.test(name) })) drop(item, "left by a stopped download");
    }
    if (!(await running(rt, { run, env }))) return removed;
    if (!rt.helpers) await syncHelpers(rt, { env, run });
    const script = `for f in ${STORE}/images/*/image.json; do [ -f "$f" ] || continue; d=\${f%/image.json}; printf '%s\\t%s\\t' "\${d##*/}" "$(stat -c %Y "$f" 2>/dev/null || echo 0)"; tr -d '\\n\\r' < "$f"; printf '\\n'; done`;
    const res = await vmCall(rt, ["/bin/sh", "-c", script], { run, env, timeoutMs: 60_000 });
    if (res.code !== 0) return removed;
    const usedIds = new Set<string>(used);
    for (const box of await list(rt, { home })) {
      const meta = readJson<LimaMeta>(metaFile(home, box.key));
      if (meta?.image) usedIds.add(meta.image);
    }
    for (const line of String(res.stdout || "").split(/\r?\n/)) {
      const [rawId = "", mtime = "", ...rest] = line.split("\t");
      const id = rawId.trim();
      let img: { ref?: string; digest?: string } | null = null;
      try { img = JSON.parse(rest.join("\t")); } catch { continue; }
      const unpackedAt = Number(mtime) * 1000;
      if (!Number.isFinite(unpackedAt) || unpackedAt <= 0 || now - unpackedAt < YOUNG_IMAGE_MS) continue;
      if (!/^[0-9a-zA-Z._-]+$/.test(id) || !removableImage({ ref: img?.ref, digest: img?.digest, id }, { keep, used: usedIds })) continue;
      if (dryRun) { removed.push({ kind: "image", name: String(img?.ref), reason: "not current", dryRun: true }); continue; }
      const { out } = await boxrun(rt, ["rmimage", "--store", STORE, "--id", id, "--boxes", BOXES], { run, env, timeoutMs: 120_000 });
      if (out?.ok) { removed.push({ kind: "image", name: String(img?.ref), reason: "not current" }); notePresent(home, String(img?.ref), null); }
    }
    return removed;
  },
  async upperBytes(runtime, key, { run = runCommand, env = process.env, home = "" } = {}) {
    const rt = withHome(runtime, home);
    if (!(await running(rt, { run, env }))) return null;
    if (!rt.helpers) await syncHelpers(rt, { env, run });
    const { out } = await boxrun(rt, ["status", "--box", boxPath(key)], { run, env });
    return num(out?.upper_bytes);
  },
  shellCommand(runtime, { key, croot, home }) {
    const rt = withHome(runtime, home);
    // LIMA_HOME rides on the command line: the terminal's own environment is passed as it is.
    return { bin: "/usr/bin/env", args: [`LIMA_HOME=${limaHome(rt.home)}`, rt.bin, ...inVm(rt, [`${OPT}/boxrun`, "enter", "--box", boxPath(key), "--wd", croot, "--", "/bin/bash", "-l"])] };
  },
  execCommand: (_runtime, { key, home }) => boxshExec({ key, home, platform: "darwin" }),
};
