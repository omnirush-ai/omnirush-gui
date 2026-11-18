// Ported from the CLI (omnirush-cli src/box/backends/wsl.js + wsl.json,
// feat/local-box-backends); keep the two in step. Desktop differences: types;
// wsl.json is a copy of the CLI's; the download (the distro, the helpers,
// the image) runs in the app's own process (pullCommand null: there is no
// `omnirush sandbox pull` to start detached).
//
// Windows: OmniRush's own WSL 2 distro as the box backend, so no Docker
// Desktop is needed. The distro ("OmniRushBox") is a small pinned root
// filesystem built FROM the same Debian base as the box images, with boxrun
// and boxd in /opt/omnirush and a wsl.conf that keeps Windows out (no
// Windows PATH, no interop: the 2.2.x "npm is the Windows npm" failure). It
// is imported per user with `wsl --import` (no admin once WSL is on). Each
// project's box runs inside it exactly like the Linux bubblewrap backend
// (boxrun, as root in the distro: unshare + overlay), from the same pinned
// images, so a Windows box is the same environment as a Linux one.
//
// The distro stays up while the app runs: a `wsl.exe ... boxrun up
// --foreground` keeper is this process's child (its stdin open). boxd
// listens on the distro's loopback; WSL forwards it to Windows' 127.0.0.1
// (NAT mode's localhost forwarding, or mirrored networking). With
// OMNIRUSH_BOX_WSL_LISTEN=any it listens on every address and the distro's
// own address is the second way in.
//
// WSL that is not enabled is never installed from here (`wsl --install`
// needs admin and a restart): one line gives the command, and the project
// runs on this machine meanwhile.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { GOARCH, containerName, firstLine, helperPath, pkglogMountPoints, readJson, writeJson, wslPath, type BoxLog, type BoxRuntime } from "../common.js";
import { runCommand, type RunCommand, type RunResult } from "../run.js";
import { externalFetch } from "../../server-fetch.js";
import type { RuntimeResult } from "../runtime.js";
import bundledPins from "../wsl.json" with { type: "json" };
import { IDLE_MINUTES, boxEgress, newMeta, upArgs, type BoxMeta } from "./bwrap.js";
import { YOUNG_IMAGE_MS, removableImage, removeTree, staleEntries } from "../retention.mjs";
import { boxshExec, num, parseOut, str } from "./shared.js";
import type { BoxDriver, OpenContext, Opened, PresentImage, Removed, SpawnLike } from "./types.js";
import { ping } from "../client.js";

type Env = NodeJS.ProcessEnv;
type WslRuntime = Pick<BoxRuntime, "bin" | "distro" | "arch" | "installed">;

export const DEFAULT_DISTRO = "OmniRushBox";
export const STORE = "/var/lib/omnirush/store";
export const BOXES = "/var/lib/omnirush/boxes";
/** Where a box's own build folders (shadows) live in the distro: one folder per box, mounted at the same path inside it. */
export const SHADOW_STORES = "/var/lib/omnirush/shadows";
export const ENABLE_HINT = "WSL 2 is not enabled on this Windows. One time, in an administrator terminal: `wsl --install --no-distribution`, then restart Windows";

export type WslAsset = { url: string | null; sha256: string | null; bytes?: number | null };
export type WslPins = { version?: string; distro?: string; base?: string; assets?: Record<string, WslAsset | undefined> };

export function loadWslPins(): WslPins {
  return bundledPins;
}

export function distroName(env: Env = process.env): string {
  return String(env.OMNIRUSH_BOX_WSL_DISTRO || "").trim() || DEFAULT_DISTRO;
}

/** wsl.exe, when Windows has it (System32). */
export function wslExe({ env = process.env, exists = existsSync }: { env?: Env; exists?: (file: string) => boolean } = {}): string | null {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const file = path.win32.join(root, "System32", "wsl.exe");
  return exists(file) ? file : null;
}

/**
 * wsl.exe's own output is UTF-16LE (with a BOM sometimes) unless WSL_UTF8=1
 * is honoured; read either way.
 */
export function decodeWsl(data: unknown): string {
  let text: string;
  if (Buffer.isBuffer(data)) {
    const nuls = data.subarray(0, 200).filter((b) => b === 0).length;
    const utf16 = nuls > 0 && nuls >= Math.min(data.length, 200) / 4;
    text = utf16 ? data.toString("utf16le") : data.toString("utf8");
  } else {
    text = String(data ?? "");
  }
  return text.replace(/^\uFEFF/, "").replace(/\uFEFF/g, "").replace(/\u0000/g, "").replace(/\r/g, "");
}

export type WslRow = { name: string; state: string; version: string; isDefault: boolean };

/** `wsl --list --verbose`: [{ name, state, version, isDefault }] (the header line is skipped). */
export function parseWslList(text: unknown): WslRow[] {
  const rows: WslRow[] = [];
  for (const raw of decodeWsl(text).split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || /^\s*\*?\s*NAME\s+STATE\s+VERSION/i.test(line)) continue;
    const isDefault = /^\s*\*/.test(line);
    const parts = line.replace(/^\s*\*?\s*/, "").split(/\s{2,}|\t+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3 || !/^[12]$/.test(parts[parts.length - 1]!)) continue;
    rows.push({ name: parts.slice(0, parts.length - 2).join(" "), state: parts[parts.length - 2]!, version: parts[parts.length - 1]!, isDefault });
  }
  return rows;
}

/**
 * `wsl --status` without its WSL 1 notes: Windows 11 with only Virtual
 * Machine Platform on (what `wsl --install --no-distribution` turns on) says
 * "WSL1 is not supported ... enable the "Windows Subsystem for Linux"
 * optional component to use WSL1", while WSL 2 works.
 */
export function withoutWsl1Notes(text: unknown): string {
  return String(text ?? "").split(/\r?\n/).filter((line) => !/\bWSL ?1\b/i.test(line)).join("\n");
}

const NOT_ENABLED = /not installed|is not enabled|optional component|virtual machine platform|HCS_E_HYPERV_NOT_INSTALLED|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|0x8007019e|0x80370102|wsl\.exe --install|enable the .*feature/i;
const NO_DISTROS = /no installed distributions|WSL_E_DEFAULT_DISTRO_NOT_FOUND|has no installed distributions/i;

/** Run wsl.exe; its output decoded (UTF-16 or UTF-8). */
export async function wslCall(bin: string, args: string[], { run = runCommand, env = process.env, timeoutMs = 20_000, input }: { run?: RunCommand; env?: Env; timeoutMs?: number; input?: string | Buffer } = {}): Promise<RunResult> {
  const res = await run(bin, args, { env: { ...env, WSL_UTF8: "1" }, timeoutMs, ...(input !== undefined ? { input } : {}) });
  return { ...res, stdout: decodeWsl(res.stdout), stderr: decodeWsl(res.stderr) };
}

/** A command inside the distro, as root, no shell in between. */
export function inDistro(runtime: Pick<BoxRuntime, "distro">, argv: string[]): string[] {
  return ["-d", runtime.distro ?? DEFAULT_DISTRO, "-u", "root", "--cd", "/", "--exec", ...argv];
}

function assetFor(pins: WslPins | null, arch: string): WslAsset | null {
  const asset = pins?.assets?.[GOARCH[arch] || "amd64"];
  return asset?.url && /^[0-9a-f]{64}$/.test(String(asset.sha256 || "")) ? asset : null;
}

export async function probeWslDistro({ env = process.env, platform = process.platform, run = runCommand, exists = existsSync, timeoutMs = 15_000, arch = process.arch, pins }: { env?: Env; platform?: NodeJS.Platform; run?: RunCommand; exists?: (file: string) => boolean; timeoutMs?: number; arch?: string; pins?: WslPins | null } = {}): Promise<RuntimeResult> {
  const base = { name: "wsl", backend: "wsl" };
  if (platform !== "win32") return { ...base, ok: false, reason: "the OmniRush WSL distro is for Windows" };
  if (env.OMNIRUSH_BOX_WSL === "0") return { ...base, ok: false, reason: "turned off (OMNIRUSH_BOX_WSL=0)" };
  const bin = wslExe({ env, exists });
  if (!bin) return { ...base, ok: false, reason: ENABLE_HINT };
  const status = await wslCall(bin, ["--status"], { run, env, timeoutMs });
  const said = withoutWsl1Notes(`${status.stdout}\n${status.stderr}`);
  if (NOT_ENABLED.test(said) || (status.code !== 0 && !NO_DISTROS.test(said))) {
    return { ...base, ok: false, bin, reason: NOT_ENABLED.test(said) || status.error === "ENOENT" ? ENABLE_HINT : `\`wsl --status\` failed: ${firstLine(said) || status.code}` };
  }
  if (/default version:\s*1\b/i.test(said) && /wsl 2 is not supported|requires an update/i.test(said)) {
    return { ...base, ok: false, bin, reason: ENABLE_HINT };
  }
  const listed = await wslCall(bin, ["--list", "--verbose"], { run, env, timeoutMs });
  const rows = listed.code === 0 ? parseWslList(listed.stdout) : [];
  const distro = distroName(env);
  const mine = rows.find((row) => row.name.toLowerCase() === distro.toLowerCase());
  if (mine && mine.version === "1") return { ...base, ok: false, bin, reason: `the ${distro} distro runs as WSL 1 (\`wsl --set-version ${distro} 2\`)` };
  if (!mine && !String(env.OMNIRUSH_BOX_WSL_ROOTFS || "").trim() && !assetFor(pins === undefined ? loadWslPins() : pins, arch)) {
    return { ...base, ok: false, bin, reason: "the OmniRush WSL image is not published yet (OMNIRUSH_BOX_WSL_ROOTFS=<built tar> to use one)" };
  }
  const ver = await wslCall(bin, ["--version"], { run, env, timeoutMs });
  const version = (/(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(ver.code === 0 ? ver.stdout : "") ?? [])[1] ?? "";
  return { ...base, ok: true, bin, distro, installed: Boolean(mine), state: mine?.state ?? null, version, flavor: "omnirush-distro", os: "linux", arch: GOARCH[arch] || "amd64", rootless: false, vm: true };
}

// --- the distro ----------------------------------------------------------------------

/** Where the distro's disk lives (per user, no admin). */
export function installDir(env: Env = process.env, distro = DEFAULT_DISTRO): string {
  const local = env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || "C:\\Users\\Default", "AppData", "Local");
  return path.win32.join(local, "OmniRush", "wsl", distro);
}

/** sha256 of a file. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

export type DownloadOptions = {
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** A download that sends nothing for this long fails (0: never; the CLI's download has the same option). */
  stallMs?: number;
  /** Bytes so far and the total (null when the server does not say), as they come. */
  onProgress?: (done: number, total: number | null) => void;
};

/** Download over https (redirects followed, through externalFetch: the app's proxy and CA settings) to `dest`, checked against `sha256`. */
export async function download(url: string, dest: string, sha256: string | null, { fetcher = externalFetch, stallMs = 0, onProgress }: DownloadOptions = {}): Promise<string> {
  if (!/^https:\/\//.test(url)) throw new Error("download: https only");
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (!stallMs) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`download: no data for ${Math.round(stallMs / 1000)} s`)), stallMs);
  };
  arm();
  try {
    const res = await fetcher(url, { headers: { "user-agent": "omnirush" }, redirect: "follow", signal: controller.signal });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`download: HTTP ${res.status}`);
    }
    if (res.url && !res.url.startsWith("https://")) throw new Error("download: https only");
    const total = Number(res.headers.get("content-length")) > 0 ? Number(res.headers.get("content-length")) : null;
    let done = 0;
    const source = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
      arm();
      done += chunk.length;
      try { onProgress?.(done, total); } catch { /* a listener's problem */ }
    });
    await pipeline(source, createWriteStream(tmp));
  } catch (error) {
    rmSync(tmp, { force: true });
    const reason = controller.signal.aborted ? controller.signal.reason : null;
    throw reason instanceof Error ? reason : error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const got = await sha256File(tmp);
  if (sha256 && got !== sha256) { rmSync(tmp, { force: true }); throw new Error(`download: sha256 mismatch (${got.slice(0, 12)}…)`); }
  renameSync(tmp, dest);
  return dest;
}

/** The pinned root filesystem tarball: OMNIRUSH_BOX_WSL_ROOTFS (a local file), else the pinned release asset. */
export async function rootfsTarball({ env = process.env, home, arch = process.arch, pins = loadWslPins(), fetchFile = download }: { env?: Env; home: string; arch?: string; pins?: WslPins; fetchFile?: typeof download }): Promise<string> {
  const asked = String(env.OMNIRUSH_BOX_WSL_ROOTFS || "").trim();
  if (asked) {
    if (!existsSync(asked)) throw new Error(`OMNIRUSH_BOX_WSL_ROOTFS: ${asked} is missing`);
    return asked;
  }
  const asset = assetFor(pins, arch);
  if (!asset?.url || !asset.sha256) throw new Error("the OmniRush WSL image is not published yet (set OMNIRUSH_BOX_WSL_ROOTFS to a built one)");
  const dest = path.join(home, "wsl", "cache", `${asset.sha256}.tar.gz`);
  if (existsSync(dest) && (await sha256File(dest)) === asset.sha256) return dest;
  return fetchFile(asset.url, dest, asset.sha256);
}

/** Import the distro when it is not there yet (`wsl --import <name> <dir> <tar> --version 2`). */
export async function ensureDistro(runtime: WslRuntime, { env = process.env, home, run = runCommand, log = () => {}, tarball = rootfsTarball }: { env?: Env; home: string; run?: RunCommand; log?: BoxLog; tarball?: typeof rootfsTarball }): Promise<{ ok: true; imported: boolean } | { ok: false; error: string }> {
  const distro = runtime.distro ?? DEFAULT_DISTRO;
  const listed = await wslCall(runtime.bin, ["--list", "--verbose"], { run, env });
  if (parseWslList(listed.stdout).some((row) => row.name.toLowerCase() === distro.toLowerCase())) return { ok: true, imported: false };
  let tar;
  try { tar = await tarball({ env, home }); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  const dir = installDir(env, distro);
  mkdirSync(dir, { recursive: true });
  const res = await wslCall(runtime.bin, ["--import", distro, dir, tar, "--version", "2"], { run, env, timeoutMs: 20 * 60_000 });
  if (res.code !== 0) return { ok: false, error: `wsl --import failed: ${firstLine(res.stderr) || firstLine(res.stdout) || res.code}` };
  log("info", "box wsl distro imported", { distro });
  return { ok: true, imported: true };
}

/** A stamp of the helpers this install ships (copied into the distro when it changes). */
function helperStamp(files: string[]): string {
  return files.map((f) => { try { const s = statSync(f); return `${s.size}-${Math.floor(s.mtimeMs)}`; } catch { return "0"; } }).join("_");
}

/** Copy boxrun and boxd into /opt/omnirush when this install's differ (cheap: one stamp file). */
export async function syncHelpers(runtime: WslRuntime, { env = process.env, run = runCommand }: { env?: Env; run?: RunCommand } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const goarch = runtime.arch || "amd64";
  const boxrun = helperPath("boxrun", { goos: "linux", goarch, env });
  const boxd = helperPath("boxd", { goos: "linux", goarch, env });
  if (!boxrun || !boxd) return { ok: false, error: "the sandbox helpers (linux boxrun, boxd) are missing from this install" };
  const stamp = helperStamp([boxrun, boxd]);
  const script = 'set -e; [ "$(cat /opt/omnirush/helpers.stamp 2>/dev/null)" = "$3" ] && exit 0; mkdir -p /opt/omnirush; install -m 0755 "$1" /opt/omnirush/boxrun.new; install -m 0755 "$2" /opt/omnirush/boxd.new; mv /opt/omnirush/boxrun.new /opt/omnirush/boxrun; mv /opt/omnirush/boxd.new /opt/omnirush/boxd; echo "$3" > /opt/omnirush/helpers.stamp';
  const res = await wslCall(runtime.bin, inDistro(runtime, ["/bin/sh", "-c", script, "sh", wslPath(boxrun), wslPath(boxd), stamp]), { run, env, timeoutMs: 120_000 });
  return res.code === 0 ? { ok: true } : { ok: false, error: `could not update the helpers in WSL: ${firstLine(res.stderr) || res.code}` };
}

async function boxrun(runtime: WslRuntime, args: string[], { run = runCommand, env = process.env, timeoutMs = 60_000 }: { run?: RunCommand; env?: Env; timeoutMs?: number } = {}) {
  const res = await wslCall(runtime.bin, inDistro(runtime, ["/opt/omnirush/boxrun", ...args]), { run, env, timeoutMs });
  return { res, out: parseOut(res.stdout) };
}

const metaFile = (home: string, key: string) => path.join(home, "wsl", "boxes", `${key}.json`);

/** An image reference as boxrun in the distro reads it: a local archive's Windows path through /mnt. */
export function distroRef(ref: string): string {
  const m = /^(docker-archive|oci-archive):(.+)$/.exec(String(ref));
  return m ? `${m[1]}:${wslPath(m[2]!)}` : String(ref);
}
const boxPath = (key: string) => `${BOXES}/${key}`;

async function imagePresent(runtime: BoxRuntime, image: { pull: string }, { run = runCommand, env = process.env }: { run?: RunCommand; env?: Env } = {}): Promise<PresentImage | null> {
  if (!runtime.installed) {
    const listed = await wslCall(runtime.bin, ["--list", "--verbose"], { run, env });
    const distro = (runtime.distro ?? DEFAULT_DISTRO).toLowerCase();
    if (!parseWslList(listed.stdout).some((row) => row.name.toLowerCase() === distro)) return null;
  }
  const { out } = await boxrun(runtime, ["image", "--store", STORE, "--ref", distroRef(image.pull), "--arch", runtime.arch || "amd64"], { run, env, timeoutMs: 60_000 });
  return out?.present ? { id: str(out.id), digest: str(out.digest) || null, arch: str(out.arch), config: str(out.config) } : null;
}

/** "Download": the distro (once), the helpers, then the image inside it. */
async function pull(runtime: BoxRuntime, image: { pull: string }, { run = runCommand, env = process.env, home = "", log = () => {} }: { run?: RunCommand; env?: Env; home?: string; log?: BoxLog } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const distro = await ensureDistro(runtime, { env, home, run, log });
  if (!distro.ok) return { ok: false, error: distro.error };
  const synced = await syncHelpers(runtime, { env, run });
  if (!synced.ok) return { ok: false, error: synced.error };
  const { res, out } = await boxrun(runtime, ["pull", "--store", STORE, "--ref", distroRef(image.pull), "--arch", runtime.arch || "amd64"], { run, env, timeoutMs: 60 * 60_000 });
  return out?.ok ? { ok: true } : { ok: false, error: String(out?.error || firstLine(res.stderr) || res.code).slice(0, 300) };
}

type Keeper = { child: ChildProcess; endpoint: { host: string; port: number; token: string }; alternates: Array<{ host: string; port: number; token: string }> };

/** Keepers (wsl.exe boxrun up --foreground) of this process, per box. */
const keepers = new Map<string, Keeper>();

export type KeeperResult = { ok: true; out: Record<string, unknown>; child: ChildProcess } | { ok: false; error: string };

/** Start the keeper and read boxrun's first JSON line (the port). */
export function startKeeper(runtime: WslRuntime, args: string[], { env = process.env, spawnImpl = spawn, timeoutMs = 180_000 }: { env?: Env; spawnImpl?: SpawnLike; timeoutMs?: number } = {}): Promise<KeeperResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(runtime.bin, inDistro(runtime, ["/opt/omnirush/boxrun", ...args, "--foreground"]), { env: { ...env, WSL_UTF8: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let buffered = "";
    let errText = "";
    let done = false;
    const finish = (value: { ok: true; out: Record<string, unknown> } | { ok: false; error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (value.ok) {
        // Keep it running for this process's lifetime, without holding the process open.
        child.stdout?.removeAllListeners("data");
        child.stdout?.resume();
        child.unref();
        for (const handle of [child.stdin, child.stdout, child.stderr]) {
          if (handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
        }
        resolve({ ...value, child });
      } else {
        try { child.kill(); } catch { /* gone */ }
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish({ ok: false, error: `WSL did not start the box in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += decodeWsl(chunk);
      const out = parseOut(buffered.split("\n").filter((line) => line.trim().startsWith("{")).join("\n"));
      if (out) finish(out.ok ? { ok: true, out } : { ok: false, error: str(out.error) || "boxrun up failed" });
    });
    child.stderr?.on("data", (chunk: Buffer) => { if (errText.length < 4000) errText += decodeWsl(chunk); });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({ ok: false, error: `the WSL keeper exited (${code}): ${firstLine(errText)}` }));
  });
}

type WslMeta = BoxMeta & { mounts?: string[]; shadows?: string[] };

async function open(ctx: OpenContext): Promise<Opened> {
  const { key, root, croot, runtime, run, home, runFolder, image, pull: mayPull, shims, pkglog, shadows = null, env, log, onPulling, spawnImpl } = ctx;
  const file = metaFile(home, key);
  let meta = readJson<WslMeta>(file);
  if (meta && meta.root !== root) return { ok: false, error: `box ${key} belongs to another folder` };
  const live = keepers.get(key);
  if (live && live.child.exitCode === null && meta) {
    // The keeper outlives boxd (its idle limit, a crash) and Windows' forward of the
    // distro's loopback (sleep): reused only when boxd answers, else started again.
    const asks = ctx.ping ?? ping;
    const answers = (await asks(live.endpoint, { timeoutMs: 1_500 })) || (live.alternates.length > 0 && (await asks(live.alternates[0]!, { timeoutMs: 1_500 })));
    if (answers) {
      return { ok: true, created: null, endpoint: live.endpoint, alternates: live.alternates, uid: 0, gid: 0, containerId: `wsl_${key}_${meta.instance}`, imageId: meta.config || meta.image, mounts: meta.mounts ?? [], shadows: meta.shadows ?? [] };
    }
    log("info", "box keeper running but boxd not answering; starting it again", { key });
    try { live.child.kill(); } catch { /* gone */ }
    keepers.delete(key);
  }
  let present = await imagePresent(runtime, image, { run, env });
  if (!present && !meta) {
    if (!mayPull) return { ok: false, error: runtime.installed ? "the sandbox image is not downloaded yet" : "the OmniRush WSL distro is not set up yet" };
    onPulling();
    const pulled = await pull(runtime, image, { run, env, home, log });
    if (!pulled.ok) return { ok: false, error: `could not set up the sandbox: ${pulled.error}` };
    present = await imagePresent(runtime, image, { run, env });
    if (!present) return { ok: false, error: "the sandbox image is not there after the download" };
  } else {
    const synced = await syncHelpers(runtime, { env, run });
    if (!synced.ok) return { ok: false, error: synced.error };
  }
  let created = null;
  if (!meta) {
    if (!present) return { ok: false, error: "the sandbox image is not downloaded yet" };
    meta = newMeta({ key, root, croot, present, image });
    mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, meta);
    created = { ref: image.ref, pull: image.pull, digest: meta.digest, id: present.config || present.id, stack: image.stack };
    log("info", "box created", { key, image: image.pull, stack: image.stack, backend: "wsl" });
  }
  const listenAny = String(env.OMNIRUSH_BOX_WSL_LISTEN || "").toLowerCase() === "any";
  const idle = Number(env.OMNIRUSH_BOX_IDLE_MIN) > 0 ? Number(env.OMNIRUSH_BOX_IDLE_MIN) : IDLE_MINUTES;
  const args = upArgs({
    box: boxPath(key), store: STORE, image: meta.image, boxd: "/opt/omnirush/boxd", portFile: `${wslPath(runFolder)}/boxd.port`,
    root, croot, runFolder, shims, pkglog, token: meta.token, idleMinutes: idle, listen: listenAny ? "0.0.0.0:0" : "127.0.0.1:0",
    platform: "win32", mapPath: wslPath, shadows, shadowStore: shadows ? `${SHADOW_STORES}/${key}` : null, egress: boxEgress(env),
  });
  const kept = await startKeeper(runtime, args, { env, ...(spawnImpl ? { spawnImpl } : {}) });
  if (!kept.ok) return { ok: false, error: `could not start the sandbox: ${kept.error}` };
  const port = num(kept.out.port) ?? 0;
  const endpoint = { host: "127.0.0.1", port, token: meta.token };
  const alternates: Keeper["alternates"] = [];
  if (listenAny) {
    const ip = await wslCall(runtime.bin, inDistro(runtime, ["/bin/sh", "-c", "hostname -I"]), { run, env });
    const addr = String(ip.stdout).split(/\s+/).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (addr) alternates.push({ host: addr, port, token: meta.token });
  }
  const mounts = [croot, "/run/omnirush", ...(shims ? ["/opt/omnirush/pkglog-src"] : []), ...(pkglog ? pkglogMountPoints(pkglog, "win32") : [])];
  // The folders boxrun shadowed (a box it found running keeps the set it started with).
  const reported = Array.isArray(kept.out.shadows) ? kept.out.shadows.filter((item): item is string => typeof item === "string") : null;
  const shadowed = reported ?? (kept.out.reused ? (meta.shadows ?? []) : []);
  if (!kept.out.reused) writeJson(file, { ...meta, mounts, shadows: shadowed, started_at: new Date().toISOString() });
  keepers.set(key, { child: kept.child, endpoint, alternates });
  return { ok: true, created, endpoint, alternates, uid: 0, gid: 0, containerId: `wsl_${key}_${meta.instance}`, imageId: meta.config || meta.image, mounts: kept.out.reused ? (meta.mounts ?? mounts) : mounts, shadows: shadowed };
}

function keeperAlive(key: string): boolean {
  const live = keepers.get(key);
  return Boolean(live && live.child.exitCode === null);
}

export const wslDriver: BoxDriver = {
  kind: "wsl",
  execFallback: false,
  /** boxrun runs as root in the distro: a box here gets its own build folders on a Windows host (required.ts). */
  shadows: true,
  imagePresent,
  pull,
  /** Desktop: the distro import, the helpers and the image download run in this process (launch.ts pullInBackground). */
  pullCommand() {
    return null;
  },
  async exists(_runtime, key, { home = "" } = {}) {
    return existsSync(metaFile(home, key));
  },
  open,
  async list(_runtime, { home = "" } = {}) {
    const dir = path.join(home, "wsl", "boxes");
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
    return names.map((n) => readJson<WslMeta>(path.join(dir, n))).filter((m): m is WslMeta => Boolean(m?.key)).map((m) => ({ key: m.key, name: containerName(m.key), root: m.root, running: keeperAlive(m.key), image: m.pull || m.ref, created: m.created_at || "" }));
  },
  async remove(runtime, key, { run = runCommand, env = process.env, home = "" } = {}) {
    keepers.get(key)?.child.kill();
    keepers.delete(key);
    const { out } = await boxrun(runtime, ["rm", "--box", boxPath(key)], { run, env, timeoutMs: 120_000 });
    const had = existsSync(metaFile(home, key));
    rmSync(metaFile(home, key), { force: true });
    return { removed: had && Boolean(out?.ok) };
  },
  async stop(runtime, key, { run = runCommand, env = process.env } = {}) {
    keepers.get(key)?.child.kill();
    keepers.delete(key);
    const { out } = await boxrun(runtime, ["stop", "--box", boxPath(key)], { run, env });
    return { stopped: Boolean(out?.ok) };
  },
  /**
   * Box images in the distro's store that no box uses and that are neither
   * the current nor the previous pins, and rootfs downloads of other pins
   * (the distro is imported once; a tarball of other pins is never read again).
   */
  async gcImages(runtime, { run = runCommand, env = process.env, home = "", current, used, keep = { refs: current, digests: new Set<string>() }, dryRun = false, now = Date.now(), pins = loadWslPins() }: Parameters<BoxDriver["gcImages"]>[1] & { pins?: WslPins | null }) {
    const removed: Removed[] = [];
    if (home) {
      const cache = path.join(home, "wsl", "cache");
      const wanted = new Set(Object.values(pins?.assets ?? {}).map((asset) => `${asset?.sha256}.tar.gz`));
      // The newest tarball of other pins stays (the previous box version's); older ones go.
      const others = staleEntries(cache, { now, maxAgeMs: -1, match: (name) => /^[0-9a-f]{64}\.tar\.gz$/.test(name) && !wanted.has(name) }).sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of others.slice(1)) {
        if (dryRun) removed.push({ kind: "download", name: item.path, reason: "rootfs of other pins", dryRun: true });
        else if (removeTree(item.path)) removed.push({ kind: "download", name: item.path, reason: "rootfs of other pins" });
      }
      // Partial downloads (`.part`) a stopped download left a day ago.
      for (const item of staleEntries(cache, { now, match: (name) => /\.tmp$|\.part$|\.download$/.test(name) })) {
        if (dryRun) removed.push({ kind: "download", name: item.path, reason: "left by a stopped download", dryRun: true });
        else if (removeTree(item.path)) removed.push({ kind: "download", name: item.path, reason: "left by a stopped download" });
      }
    }
    // The distro may not be there (never pulled): nothing in it to remove then.
    const wsl: WslRuntime = runtime;
    const listed = await wslCall(wsl.bin, ["--list", "--verbose"], { run, env }).catch(() => null);
    if (!listed || !parseWslList(listed.stdout).some((row) => row.name.toLowerCase() === String(wsl.distro).toLowerCase())) return removed;
    const script = `for f in ${STORE}/images/*/image.json; do [ -f "$f" ] || continue; d=\${f%/image.json}; printf '%s\\t%s\\t' "\${d##*/}" "$(stat -c %Y "$f" 2>/dev/null || echo 0)"; tr -d '\\n\\r' < "$f"; printf '\\n'; done`;
    const res = await wslCall(wsl.bin, inDistro(wsl, ["/bin/sh", "-c", script]), { run, env, timeoutMs: 60_000 });
    if (res.code !== 0) return removed;
    const usedIds = new Set<string>(used);
    for (const name of (() => { try { return readdirSync(path.join(home, "wsl", "boxes")).filter((n) => n.endsWith(".json")); } catch { return [] as string[]; } })()) {
      const meta = readJson<WslMeta>(path.join(home, "wsl", "boxes", name));
      if (meta?.image) usedIds.add(meta.image);
    }
    for (const line of String(res.stdout || "").split(/\r?\n/)) {
      const [rawId = "", mtime = "", ...rest] = line.split("\t");
      const id = rawId.trim();
      let img: { ref?: string; digest?: string } | null = null;
      try { img = JSON.parse(rest.join("\t")); } catch { continue; }
      // Unpacked in the last week (or its age unknown): another app may be about to make a box on it.
      const unpackedAt = Number(mtime) * 1000;
      if (!Number.isFinite(unpackedAt) || unpackedAt <= 0 || now - unpackedAt < YOUNG_IMAGE_MS) continue;
      if (!/^[0-9a-zA-Z._-]+$/.test(id) || !removableImage({ ref: img?.ref, digest: img?.digest, id }, { keep, used: usedIds })) continue;
      if (dryRun) { removed.push({ kind: "image", name: String(img?.ref), reason: "not current", dryRun: true }); continue; }
      const { out } = await boxrun(wsl, ["rmimage", "--store", STORE, "--id", id, "--boxes", BOXES], { run, env, timeoutMs: 120_000 });
      if (out?.ok) removed.push({ kind: "image", name: String(img?.ref), reason: "not current" });
    }
    return removed;
  },
  async upperBytes(runtime, key, { run = runCommand, env = process.env } = {}) {
    const { out } = await boxrun(runtime, ["status", "--box", boxPath(key)], { run, env });
    return num(out?.upper_bytes);
  },
  shellCommand(runtime, { key, croot }) {
    return { bin: runtime.bin, args: inDistro(runtime, ["/opt/omnirush/boxrun", "enter", "--box", boxPath(key), "--wd", croot, "--", "/bin/bash", "-l"]) };
  },
  execCommand: (_runtime, { key, home }) => boxshExec({ key, home, platform: "win32" }),
};
