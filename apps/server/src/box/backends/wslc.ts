// Ported from the CLI (omnirush-cli src/box/backends/wslc.js,
// feat/local-box-backends); keep the two in step. Desktop differences: types;
// the container-name prefix (containerName's env); boxd missing from the
// sidecars is a reason.
//
// Windows: WSL containers (`wslc.exe`, alias `container.exe`), the container
// engine built into WSL since 3.0.1 (GA 2026-09-29; preview from 2.9.3).
// Containers share WSL 2's kernel; bind mounts take Windows paths and go
// over VirtioFS; `-p` publishes on Windows' loopback. One persistent
// container per project, like the Docker backend, with boxd mounted in from
// the run folder (there is no `cp -` from a tar stream) and published on a
// port chosen here. Snapshots are boxd's index walk (wslc has no `diff`).
//
// Written to wslc's real CLI (microsoft/WSL src/windows/wslc, Oct 2026:
// arguments/ArgumentDefinitions.h, commands/ContainerCreateCommand.cpp,
// VersionCommand.cpp, common/MountSpecParsing.cpp):
//   wslc version --format json            {"Client":{"Version":"3.0.1.0"}}
//   wslc container create --name --label k=v --mount type=bind,source=C:\..,target=/..[,readonly]
//        -p [ip:]host:container -e K=V -w DIR --entrypoint CMD --cpus N -m 4G IMAGE
//   wslc container start|inspect|remove --force|list --all [--size] --format json
//   wslc image pull|inspect|list|remove;  wslc exec -i [-t] [-u] [-w] [-e] NAME CMD...
// No --init: boxd is PID 1 and reaps itself (boxd's init mode).

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BOX_PORT, HOME_IN_BOX, LABEL, PKGLOG_LAYOUT, PKGLOG_LAYOUT_LABEL, RUN_DIR, SHIMS_DIR, containerName, containerRoot, firstLine, freePort, helperPath, newToken, pkglogBinds, pkglogMountPoints, type BoxInstallLog, type BoxRuntime } from "../common.js";
import { runCommand, type RunCommand, type RunResult } from "../run.js";
import type { RuntimeResult } from "../runtime.js";
import { parseSize } from "./container.js";
import { versionAtLeast } from "./shared.js";
import { removableImage, removalTarget } from "../retention.mjs";
import type { BoxDriver, OpenContext, Opened, PresentImage, Removed } from "./types.js";
import { ENABLE_HINT, decodeWsl, wslCall, wslExe } from "./wsl.js";
import { boxEgress } from "./bwrap.js";

type Env = NodeJS.ProcessEnv;
type Row = Record<string, unknown>;

/** WSL containers went GA in WSL 3.0.1; earlier previews (2.9.x) changed their CLI. */
export const SUPPORTED = { min: "3.0.1" };
export const UPDATE_HINT = "WSL is older than 3.0.1, which brings WSL containers (`wsl --update`, once)";

export function findWslc({ env = process.env, exists = existsSync }: { env?: Env; exists?: (file: string) => boolean } = {}): string | null {
  const asked = String(env.OMNIRUSH_BOX_WSLC_BIN || "").trim();
  if (asked) return exists(asked) ? asked : null;
  const dirs = String(env.Path || env.PATH || "").split(";").filter(Boolean);
  const pf = env.ProgramFiles || "C:\\Program Files";
  const local = env.LOCALAPPDATA || "";
  for (const dir of [...dirs, path.win32.join(pf, "WSL"), ...(local ? [path.win32.join(local, "Microsoft", "WindowsApps")] : [])]) {
    const file = path.win32.join(dir, "wslc.exe");
    if (exists(file)) return file;
  }
  return null;
}

/** `wslc version` (json or text): "3.0.1.0". */
export function parseWslcVersion(text: unknown): string {
  const s = decodeWsl(text).trim();
  try {
    const v: unknown = JSON.parse(s)?.Client?.Version;
    if (typeof v === "string" && v) return v;
  } catch { /* text */ }
  return (/(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(s) ?? [])[1] ?? "";
}

export async function probeWslc({ env = process.env, platform = process.platform, run = runCommand, exists = existsSync, timeoutMs = 15_000, arch = process.arch, explicit = false }: { env?: Env; platform?: NodeJS.Platform; run?: RunCommand; exists?: (file: string) => boolean; timeoutMs?: number; arch?: string; explicit?: boolean } = {}): Promise<RuntimeResult> {
  const base = { name: "wslc", backend: "wslc" };
  if (platform !== "win32") return { ...base, ok: false, reason: "WSL containers are Windows only" };
  // OMNIRUSH_BOX_WSL=0 turns off the WSL distro and engines; wslc asked for by name still runs.
  if (env.OMNIRUSH_BOX_WSL === "0" && !explicit) return { ...base, ok: false, reason: "turned off (OMNIRUSH_BOX_WSL=0)" };
  const bin = findWslc({ env, exists });
  if (!bin) {
    // Tell "WSL is old" (one `wsl --update`) from "WSL is off" (admin, restart).
    const wsl = wslExe({ env, exists });
    if (!wsl) return { ...base, ok: false, reason: ENABLE_HINT };
    const ver = await wslCall(wsl, ["--version"], { run, env, timeoutMs });
    const version = (/(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(ver.code === 0 ? ver.stdout : "") ?? [])[1] ?? "";
    if (!version) return { ...base, ok: false, reason: ver.code === 0 ? UPDATE_HINT : ENABLE_HINT };
    return { ...base, ok: false, reason: versionAtLeast(version, SUPPORTED.min) ? "wslc.exe is missing although WSL is 3.0.1 or later (`wsl --update`)" : `${UPDATE_HINT}; this is WSL ${version}` };
  }
  const res = await run(bin, ["version", "--format", "json"], { env, timeoutMs });
  let version = res.code === 0 ? parseWslcVersion(res.stdout) : "";
  if (!version) version = parseWslcVersion((await run(bin, ["version"], { env, timeoutMs })).stdout);
  if (!version) return { ...base, ok: false, bin, reason: `\`wslc version\` failed: ${firstLine(decodeWsl(res.stderr)) || res.code}` };
  if (!versionAtLeast(version, SUPPORTED.min)) return { ...base, ok: false, bin, version, reason: `${UPDATE_HINT}; wslc is ${version}` };
  return { ...base, ok: true, bin, version, os: "linux", arch: arch === "arm64" ? "arm64" : "amd64", flavor: "wslc", rootless: false, vm: true };
}

function rowOf(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** `container list --format json`: an array, or one object per line. */
export function parseJsonRows(text: unknown): Row[] {
  const s = decodeWsl(text).trim();
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(rowOf);
  } catch { /* lines */ }
  const out: Row[] = [];
  for (const line of s.split("\n")) {
    try { out.push(rowOf(JSON.parse(line))); } catch { /* skip */ }
  }
  return out;
}

/** Labels as a map (an object, or docker's "k=v,k=v"). */
export function labelsOf(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)]; }));
}

export function wslcResources({ env = process.env, cpus = os.cpus().length, memory = os.totalmem() }: { env?: Env; cpus?: number; memory?: number } = {}): string[] {
  const askedCpus = Number(env.OMNIRUSH_BOX_CPUS);
  const askedMem = String(env.OMNIRUSH_BOX_MEMORY || "").trim();
  const c = askedCpus > 0 ? Math.round(askedCpus) : Math.max(1, Math.min(8, cpus - 1));
  // wslc takes upper-case units only (512M, 4G).
  const m = askedMem ? askedMem.toUpperCase() : `${Math.max(2, Math.min(8, Math.floor(memory / 2 / 1024 ** 3)))}G`;
  return ["--cpus", String(c), "-m", m];
}

export function createWslcArgs({ name, key, root, croot, image, runFolder, shims = null, pkglog = null, token, port, env = process.env, egress = null }: { name: string; key: string; root: string; croot: string; image: string; runFolder: string; shims?: string | null; pkglog?: Pick<BoxInstallLog, "tools" | "raw"> | null; token: string; port: number; env?: Env; egress?: string | null }): string[] {
  return [
    "container", "create", "--name", name,
    "--label", `${LABEL}=1`, "--label", `${LABEL}.key=${key}`, "--label", `${LABEL}.root=${root}`, "--label", `${LABEL}.version=1`, "--label", `${LABEL}.port=${port}`,
    "--hostname", "omnirush-box",
    "--mount", `type=bind,source=${root},target=${croot}`,
    "--mount", `type=bind,source=${runFolder},target=${RUN_DIR}`,
    "--mount", `type=bind,source=${path.win32.join(runFolder, "bin")},target=/opt/omnirush/bin,readonly`,
    ...(shims ? ["--mount", `type=bind,source=${shims},target=${SHIMS_DIR}-src,readonly`] : []),
    // The install log: its wrappers read-only, only the raw folder writable (common.ts pkglogBinds).
    ...(pkglog ? pkglogBinds(pkglog, "win32").flatMap((bind) => ["--mount", `type=bind,source=${bind.source},target=${bind.target}${bind.readonly ? ",readonly" : ""}`]) : []),
    ...(pkglog ? ["--label", `${PKGLOG_LAYOUT_LABEL}=${PKGLOG_LAYOUT}`] : []),
    "-p", `127.0.0.1:${port}:${BOX_PORT}`,
    "-e", `BOXD_TOKEN=${token}`, "-e", "BOXD_UID=0", "-e", "BOXD_GID=0", "-e", `BOXD_HOME=${HOME_IN_BOX}`, "-e", `BOXD_ROOT=${croot}`, "-e", `BOXD_ENV_FILE=${RUN_DIR}/env`,
    "-e", "LANG=C.UTF-8", "-e", "DEBIAN_FRONTEND=noninteractive",
    // Farm runs (bwrap.ts boxEgress): boxd's egress, and a label so a box made the other way is made again.
    ...(egress ? ["-e", `BOXD_EGRESS=${egress}`, "--label", `${LABEL}.egress=${egress}`] : []),
    "-w", croot,
    ...wslcResources({ env }),
    "--entrypoint", "/opt/omnirush/bin/boxd",
    image,
  ];
}

function placeBoxd(runFolder: string, env: Env, goarch: string): string | null {
  const source = helperPath("boxd", { goos: "linux", goarch, env });
  if (!source) return `the sandbox helper boxd (linux-${goarch}) is missing from this install`;
  const dir = path.join(runFolder, "bin");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "boxd");
  let same = false;
  try { same = statSync(target).size === statSync(source).size && statSync(target).mtimeMs >= statSync(source).mtimeMs; } catch { /* missing */ }
  if (!same) {
    copyFileSync(source, target);
    try { chmodSync(target, 0o755); } catch { /* Windows */ }
  }
  return null;
}

async function wslc(runtime: BoxRuntime, args: string[], { run = runCommand, timeoutMs = 60_000, env }: { run?: RunCommand; timeoutMs?: number; env?: Env } = {}): Promise<RunResult> {
  const res = await run(runtime.bin, args, { timeoutMs, ...(env ? { env } : {}) });
  return { ...res, stdout: decodeWsl(res.stdout), stderr: decodeWsl(res.stderr) };
}

const nameOf = (r: Row) => String(r.Names ?? r.Name ?? "").replace(/^\//, "");

async function row(runtime: BoxRuntime, name: string, { run, size = false }: { run: RunCommand; size?: boolean }): Promise<Row | null> {
  const res = await wslc(runtime, ["container", "list", "--all", ...(size ? ["--size"] : []), "--no-trunc", "--format", "json"], { run, timeoutMs: 30_000 });
  if (res.code !== 0) return null;
  return parseJsonRows(res.stdout).find((r) => nameOf(r) === name) ?? null;
}

async function imagePresent(runtime: BoxRuntime, image: { pull: string }, { run = runCommand }: { run?: RunCommand } = {}): Promise<PresentImage | null> {
  const res = await wslc(runtime, ["image", "inspect", image.pull], { run, timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  const info = parseJsonRows(res.stdout)[0] ?? {};
  const digest = (Array.isArray(info.RepoDigests) ? info.RepoDigests : []).map((d) => String(d).split("@")[1]).find((d) => /^sha256:[0-9a-f]{64}$/.test(d || "")) ?? null;
  return { id: String(info.Id ?? info.ID ?? image.pull), digest, arch: String(info.Architecture ?? "") };
}

async function pull(runtime: BoxRuntime, image: { pull: string }, { run = runCommand }: { run?: RunCommand } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await wslc(runtime, ["image", "pull", image.pull], { run, timeoutMs: 60 * 60_000 });
  return res.code === 0 ? { ok: true } : { ok: false, error: firstLine(res.stderr) || firstLine(res.stdout) || `image pull exited ${res.code}` };
}

async function open(ctx: OpenContext): Promise<Opened> {
  const { key, name, root, croot, runtime, run, runFolder, image, pull: mayPull, shims, pkglog, env, log, onPulling } = ctx;
  let info = await row(runtime, name, { run });
  const labels = labelsOf(info?.Labels);
  if (info && labels[`${LABEL}.root`] && labels[`${LABEL}.root`] !== root) return { ok: false, error: `container ${name} belongs to another folder` };
  const egress = boxEgress(env);
  if (info && (labels[`${LABEL}.egress`] ?? null) !== egress) {
    // A box made for the other kind of run (farm egress or not): its network is fixed at create.
    log("info", "box made again for this run's network", { key, egress });
    const gone = await wslc(runtime, ["container", "remove", "--force", name], { run, timeoutMs: 60_000 });
    if (gone.code !== 0) return { ok: false, error: `could not replace the sandbox: ${firstLine(gone.stderr) || firstLine(gone.stdout)}` };
    info = null;
  }
  const placed = placeBoxd(runFolder, env, runtime.arch || "amd64");
  if (placed) return { ok: false, error: placed };
  const tokenFile = path.join(runFolder, "box-token");
  let created = null;
  if (!info) {
    let present = await imagePresent(runtime, image, { run });
    if (!present) {
      if (!mayPull) return { ok: false, error: "the sandbox image is not downloaded yet" };
      onPulling();
      const pulled = await pull(runtime, image, { run });
      if (!pulled.ok) return { ok: false, error: `could not download the sandbox image: ${pulled.error}` };
      present = await imagePresent(runtime, image, { run });
      if (!present) return { ok: false, error: "the sandbox image is not there after the download" };
    }
    const token = newToken();
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const port = await freePort();
    const made = await wslc(runtime, createWslcArgs({ name, key, root, croot, image: image.pull, runFolder, shims, pkglog, token, port, env, egress }), { run, timeoutMs: 120_000 });
    if (made.code !== 0) return { ok: false, error: `could not create the sandbox: ${firstLine(made.stderr) || firstLine(made.stdout)}` };
    created = { ref: image.ref, pull: image.pull, digest: image.digest || present.digest, id: present.id, stack: image.stack };
    log("info", "box created", { key, image: image.pull, stack: image.stack, backend: "wslc" });
    info = await row(runtime, name, { run });
    if (!info) return { ok: false, error: "the sandbox was created but is not listed" };
  }
  if (!/running/i.test(String(info.State ?? ""))) {
    const started = await wslc(runtime, ["container", "start", name], { run, timeoutMs: 120_000 });
    if (started.code !== 0) return { ok: false, error: `could not start the sandbox: ${firstLine(started.stderr) || firstLine(started.stdout)}` };
  }
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { /* none */ }
  const port = Number(labelsOf(info.Labels)[`${LABEL}.port`]) || 0;
  if (!token || !port) return { ok: false, error: "the sandbox has no port or token (Reset sandbox makes a new one)" };
  return { ok: true, created, endpoint: { host: "127.0.0.1", port, token }, uid: 0, gid: 0, containerId: String(info.ID ?? info.Id ?? name), imageId: String(info.Image ?? ""), mounts: [croot, RUN_DIR, ...(shims ? [`${SHIMS_DIR}-src`] : []), ...(pkglog ? wslcInstallLogMounts(labelsOf(info.Labels), pkglog) : [])] };
}

/** The install log's folders a wslc box was made with, from its label (as appleInstallLogMounts). */
export function wslcInstallLogMounts(labels: Record<string, string>, pkglog: BoxInstallLog): string[] {
  return labels[PKGLOG_LAYOUT_LABEL] === PKGLOG_LAYOUT ? pkglogMountPoints(pkglog, "win32") : [containerRoot(pkglog.root, "win32")];
}

export const wslcDriver: BoxDriver = {
  kind: "wslc",
  /** Its own container network: the box's servers reach this computer's 127.0.0.1 through boxd (ports.ts). */
  forwardsPorts: false,
  /** boxsh's fallback `<runtime> exec -i -w -u -e` matches wslc exec's flags. */
  execFallback: true,
  imagePresent,
  pull,
  pullCommand(runtime, image) {
    return { bin: runtime.bin, args: ["image", "pull", image.pull] };
  },
  async exists(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await wslc(runtime, ["container", "inspect", containerName(key, env)], { run, timeoutMs: 20_000 });
    return res.code === 0 && parseJsonRows(res.stdout).length > 0;
  },
  open,
  async list(runtime, { run = runCommand } = {}) {
    const res = await wslc(runtime, ["container", "list", "--all", "--no-trunc", "--format", "json"], { run, timeoutMs: 30_000 });
    if (res.code !== 0) return [];
    return parseJsonRows(res.stdout).map((r) => ({ r, labels: labelsOf(r.Labels) })).filter(({ labels }) => labels[LABEL] === "1").map(({ r, labels }) => ({
      key: labels[`${LABEL}.key`] ?? "", name: nameOf(r), root: labels[`${LABEL}.root`] ?? "",
      running: /running/i.test(String(r.State ?? "")), image: String(r.Image ?? ""), created: String(r.CreatedAt ?? ""),
    }));
  },
  async remove(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await wslc(runtime, ["container", "remove", "--force", containerName(key, env)], { run, timeoutMs: 60_000 });
    return { removed: res.code === 0 };
  },
  async gcImages(runtime, { run = runCommand, current, used, keep = { refs: current, digests: new Set<string>() }, dryRun = false }) {
    const removed: Removed[] = [];
    const res = await wslc(runtime, ["image", "list", "--format", "json"], { run, timeoutMs: 30_000 });
    for (const img of parseJsonRows(res.stdout)) {
      const ref = img.Repository && img.Tag ? `${img.Repository}:${img.Tag}` : String(img.Name ?? img.Reference ?? "");
      const image = { ref, digest: typeof img.Digest === "string" ? img.Digest : null, id: String(img.Id ?? img.ID ?? "") };
      if (!ref || !removableImage(image, { keep, used })) continue;
      const target = removalTarget(image) || ref;
      if (dryRun) { removed.push({ kind: "image", name: target, reason: "not current", dryRun: true }); continue; }
      const del = await wslc(runtime, ["image", "remove", target], { run, timeoutMs: 60_000 });
      if (del.code === 0) removed.push({ kind: "image", name: target, reason: "not current" });
    }
    return removed;
  },
  async stop(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await wslc(runtime, ["container", "stop", "-t", "1", containerName(key, env)], { run, timeoutMs: 60_000 });
    return { stopped: res.code === 0 };
  },
  async upperBytes(runtime, key, { run = runCommand, env = process.env } = {}) {
    const r = await row(runtime, containerName(key, env), { run, size: true });
    return r ? parseSize(r.Size) : null;
  },
  shellCommand(runtime, { key, croot, env = process.env }) {
    return { bin: runtime.bin, args: ["exec", "-it", "-w", croot, containerName(key, env), "/bin/bash", "-l"] };
  },
  execCommand(runtime, { key, env = process.env }) {
    return { bin: runtime.bin, args: ["exec", "-i", containerName(key, env)], env: {} };
  },
};
