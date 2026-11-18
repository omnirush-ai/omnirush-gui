// Ported from the CLI (omnirush-cli src/box/backends/apple.js,
// feat/local-box-backends); keep the two in step. Desktop differences: types;
// the container-name prefix (containerName's env); boxd missing from the
// sidecars is a reason.
//
// Apple's `container` (github.com/apple/container) as a box backend: macOS 26+
// on Apple silicon, each container its own lightweight VM, no Docker. One
// persistent container per project, made with `container create`, the
// project and the run folder shared in at their paths (virtiofs), boxd
// started as the entrypoint from the run folder and published on this
// machine's loopback at a port chosen here (`-p` needs one named), with the
// container's own address as the second way in. Snapshots are boxd's index
// walk (there is no `container diff`).
//
// Written to the CLI of the 1.x line (1.0.0 froze the CLI; checked against
// docs/command-reference.md and the Swift sources of 1.5.0, Sep 2026):
//   container system version --format json   [{appName, version, buildType, commit}]
//   container system status                   exit 0 while the API server runs
//   container create|start|delete --force|inspect|list --all --format json
//   container image pull --platform linux/arm64 | image inspect | image list --format json | image delete
//   create: --name --label k=v --mount type=bind,source=,target=[,readonly] -p ip:host:container
//           -e K=V --workdir --cpus --memory --init --entrypoint
//   list/inspect JSON: { configuration: { id, image: { reference, descriptor: { digest } },
//                        labels, publishedPorts }, status: running|stopped|stopping|unknown,
//                        networks: [{ ipv4Address: "192.168.64.3/24" }] }

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BOX_PORT, HOME_IN_BOX, LABEL, PKGLOG_LAYOUT, PKGLOG_LAYOUT_LABEL, RUN_DIR, SHIMS_DIR, containerName, containerRoot, firstLine, freePort, helperPath, newToken, pkglogBinds, pkglogMountPoints, type BoxInstallLog, type BoxRuntime } from "../common.js";
import { runCommand, type RunCommand } from "../run.js";
import type { RuntimeResult } from "../runtime.js";
import { versionAtLeast } from "./shared.js";
import { removableImage } from "../retention.mjs";
import type { BoxDriver, OpenContext, Opened, PresentImage, Removed } from "./types.js";

type Env = NodeJS.ProcessEnv;

/** The `container` releases this backend is written for: 1.x (the CLI is frozen within it). */
export const SUPPORTED = { min: "1.0.0", below: "2.0.0", tested: "1.5.0" };

const BIN_DIRS = ["/usr/local/bin", "/opt/homebrew/bin"];

export function findAppleBin({ env = process.env, exists = existsSync }: { env?: Env; exists?: (file: string) => boolean } = {}): string | null {
  const asked = String(env.OMNIRUSH_BOX_APPLE_BIN || "").trim();
  if (asked) return exists(asked) ? asked : null;
  const dirs = [...String(env.PATH || "").split(":").filter(Boolean), ...BIN_DIRS];
  for (const dir of dirs) {
    const file = path.posix.join(dir, "container");
    if (exists(file)) return file;
  }
  return null;
}

const SYSTEM_VERSION = "/System/Library/CoreServices/SystemVersion.plist";

/** This Mac's ProductVersion ("27.0.1") from SystemVersion.plist, or null. */
export function systemProductVersion(read: (file: string) => string = (file) => readFileSync(file, "utf8")): string | null {
  try {
    const match = /<key>ProductVersion<\/key>\s*<string>(\d+(?:\.\d+)*)<\/string>/.exec(read(SYSTEM_VERSION));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * macOS major version: this Mac's own ProductVersion when asked about this
 * machine, else from the Darwin release (20-24 = macOS 11-15, 25 = macOS 26).
 */
export function macosMajor(release = os.release(), product: string | null = release === os.release() ? systemProductVersion() : null): number | null {
  const own = Number.parseInt(String(product ?? ""), 10);
  if (Number.isFinite(own) && own >= 10) return own;
  const darwin = Number.parseInt(String(release).split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwin) || darwin < 20) return null;
  return darwin <= 24 ? darwin - 9 : darwin + 1;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Versions from `container system version --format json` (or `--version` text). */
export function parseVersions(stdout: unknown): { version: string; server?: string | null } {
  const text = String(stdout ?? "").trim();
  try {
    const list: unknown = JSON.parse(text);
    if (Array.isArray(list)) {
      const entries = list.map(record);
      const cli = entries.find((entry) => /^container$|cli/i.test(String(entry.appName ?? ""))) ?? entries[0];
      const server = entries.find((entry) => /apiserver/i.test(String(entry.appName ?? "")));
      return { version: String(cli?.version ?? ""), server: server ? String(server.version ?? "") : null };
    }
  } catch { /* text */ }
  const match = /(\d+\.\d+\.\d+)/.exec(text);
  return { version: match ? match[1]! : "" };
}

export async function probeApple({ env = process.env, platform = process.platform, arch = process.arch, release = os.release(), run = runCommand, exists = existsSync, timeoutMs = 6_000 }: { env?: Env; platform?: NodeJS.Platform; arch?: string; release?: string; run?: RunCommand; exists?: (file: string) => boolean; timeoutMs?: number } = {}): Promise<RuntimeResult> {
  const base = { name: "apple", backend: "apple" };
  if (platform !== "darwin") return { ...base, ok: false, reason: "Apple container is macOS only" };
  if (arch !== "arm64") return { ...base, ok: false, reason: "Apple container needs an Apple silicon Mac" };
  const major = macosMajor(release);
  if (major !== null && major < 26) return { ...base, ok: false, reason: `Apple container needs macOS 26 or later (this is macOS ${major})` };
  const bin = findAppleBin({ env, exists });
  if (!bin) return { ...base, ok: false, reason: "Apple container is not installed (github.com/apple/container releases)" };
  let res = await run(bin, ["system", "version", "--format", "json"], { env, timeoutMs });
  let versions = res.code === 0 ? parseVersions(res.stdout) : { version: "" };
  if (!versions.version) {
    res = await run(bin, ["--version"], { env, timeoutMs });
    versions = parseVersions(res.stdout);
  }
  const { version } = versions;
  if (!version) return { ...base, ok: false, bin, reason: `could not read Apple container's version: ${firstLine(res.stderr) || res.code}` };
  if (!versionAtLeast(version, SUPPORTED.min) || versionAtLeast(version, SUPPORTED.below)) {
    return { ...base, ok: false, bin, version, reason: `Apple container ${version} is outside the supported ${SUPPORTED.min.split(".")[0]}.x line (tested with ${SUPPORTED.tested})` };
  }
  const status = await run(bin, ["system", "status"], { env, timeoutMs });
  const said = `${status.stdout}\n${status.stderr}`;
  if (status.code !== 0 || /not running|not registered|unavailable/i.test(said) || versions.server === null) {
    return { ...base, ok: false, bin, version, reason: "Apple container is installed but not running (OmniRush never starts it; `container system start` is known to hang on macOS 27)" };
  }
  return { ...base, ok: true, bin, version, os: "linux", arch: "arm64", flavor: "apple-container", rootless: true, vm: true };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The first sha256 digest of an image record (index, descriptor, then anywhere). */
export function findDigest(value: unknown): string | null {
  const ok = (d: unknown): d is string => typeof d === "string" && DIGEST.test(d);
  const rec = record(Array.isArray(value) ? value[0] : value);
  const configuration = record(rec.configuration);
  for (const cand of [record(rec.index).digest, record(rec.descriptor).digest, record(record(configuration.image).descriptor).digest, rec.digest]) if (ok(cand)) return cand;
  let found: string | null = null;
  const walk = (v: unknown) => {
    if (found || v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "digest" && ok(x)) { found = x; return; }
      walk(x);
    }
  };
  walk(rec);
  return found;
}

function parseJson(text: unknown): unknown {
  try { return JSON.parse(String(text ?? "").trim()); } catch { return null; }
}

export type AppleBoxInfo = { id: string; running: boolean; status: string; image: string; digest: string | null; labels: Record<string, string>; address: string | null; created: string | null };

export function snapshotInfo(snap: unknown): AppleBoxInfo {
  const s = record(snap);
  const cfg = record(s.configuration);
  const image = record(cfg.image);
  const networks = Array.isArray(s.networks) ? s.networks.map(record) : [];
  const address = networks.map((n) => String(n.ipv4Address ?? n.address ?? "").split("/")[0]).find(Boolean) ?? null;
  const labels = Object.fromEntries(Object.entries(record(cfg.labels)).map(([k, v]) => [k, String(v)]));
  const digest = record(image.descriptor).digest;
  return {
    id: String(cfg.id ?? ""),
    running: String(s.status ?? "") === "running",
    status: String(s.status ?? ""),
    image: String(image.reference ?? ""),
    digest: typeof digest === "string" ? digest : null,
    labels,
    address,
    created: typeof cfg.creationDate === "string" || typeof cfg.creationDate === "number" ? String(cfg.creationDate) : null,
  };
}

async function inspectBox(runtime: BoxRuntime, name: string, run: RunCommand): Promise<AppleBoxInfo | null> {
  const res = await run(runtime.bin, ["inspect", name], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  const parsed = parseJson(res.stdout);
  const snap = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record(snap).configuration) return null;
  return snapshotInfo(snap);
}

/** VM size for a box: what the user asked, else half the Mac (2–8 CPUs, 2–8 GiB; Apple's default 1 GiB is too small for installs). */
export function appleResources({ env = process.env, cpus = os.cpus().length, memory = os.totalmem() }: { env?: Env; cpus?: number; memory?: number } = {}): string[] {
  const askedCpus = Number(env.OMNIRUSH_BOX_CPUS);
  const askedMem = String(env.OMNIRUSH_BOX_MEMORY || "").trim();
  const c = askedCpus > 0 ? askedCpus : Math.max(2, Math.min(8, Math.floor(cpus / 2)));
  const m = askedMem || `${Math.max(2, Math.min(8, Math.floor(memory / 2 / 1024 ** 3)))}G`;
  return ["--cpus", String(c), "--memory", m];
}

export function createAppleArgs({ name, key, root, croot, image, runFolder, shims = null, pkglog = null, token, port, env = process.env }: { name: string; key: string; root: string; croot: string; image: string; runFolder: string; shims?: string | null; pkglog?: Pick<BoxInstallLog, "tools" | "raw"> | null; token: string; port: number; env?: Env }): string[] {
  return [
    "create", "--name", name,
    "--label", `${LABEL}=1`, "--label", `${LABEL}.key=${key}`, "--label", `${LABEL}.root=${root}`, "--label", `${LABEL}.version=1`, "--label", `${LABEL}.port=${port}`,
    "--mount", `type=bind,source=${root},target=${croot}`,
    "--mount", `type=bind,source=${runFolder},target=${RUN_DIR}`,
    "--mount", `type=bind,source=${path.join(runFolder, "bin")},target=/opt/omnirush/bin,readonly`,
    ...(shims ? ["--mount", `type=bind,source=${shims},target=${SHIMS_DIR}-src,readonly`] : []),
    // The install log: its wrappers read-only, only the raw folder writable (common.ts pkglogBinds).
    ...(pkglog ? pkglogBinds(pkglog, "darwin").flatMap((bind) => ["--mount", `type=bind,source=${bind.source},target=${bind.target}${bind.readonly ? ",readonly" : ""}`]) : []),
    ...(pkglog ? ["--label", `${PKGLOG_LAYOUT_LABEL}=${PKGLOG_LAYOUT}`] : []),
    "-p", `127.0.0.1:${port}:${BOX_PORT}`,
    "-e", `BOXD_TOKEN=${token}`, "-e", "BOXD_UID=0", "-e", "BOXD_GID=0", "-e", `BOXD_HOME=${HOME_IN_BOX}`, "-e", `BOXD_ROOT=${croot}`, "-e", `BOXD_ENV_FILE=${RUN_DIR}/env`,
    "-e", "LANG=C.UTF-8", "-e", "DEBIAN_FRONTEND=noninteractive",
    "--workdir", croot,
    ...appleResources({ env }),
    "--init",
    "--entrypoint", "/opt/omnirush/bin/boxd",
    image,
  ];
}

/** Copy boxd into the run folder's bin/ (mounted read-only at /opt/omnirush/bin). */
function placeBoxd(runFolder: string, env: Env): string | null {
  const source = helperPath("boxd", { goos: "linux", goarch: "arm64", env });
  if (!source) return "the sandbox helper boxd (linux-arm64) is missing from this install";
  const dir = path.join(runFolder, "bin");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "boxd");
  let same = false;
  try { same = statSync(target).size === statSync(source).size && statSync(target).mtimeMs >= statSync(source).mtimeMs; } catch { /* missing */ }
  if (!same) {
    copyFileSync(source, `${target}.tmp`);
    chmodSync(`${target}.tmp`, 0o755);
    copyFileSync(`${target}.tmp`, target);
    chmodSync(target, 0o755);
  }
  return null;
}

async function imagePresent(runtime: BoxRuntime, image: { pull: string }, { run = runCommand }: { run?: RunCommand } = {}): Promise<PresentImage | null> {
  const res = await run(runtime.bin, ["image", "inspect", image.pull], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  const parsed = parseJson(res.stdout);
  if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) return null;
  const digest = findDigest(parsed);
  return { id: digest || image.pull, digest, arch: "arm64" };
}

async function pull(runtime: BoxRuntime, image: { pull: string }, { run = runCommand }: { run?: RunCommand } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await run(runtime.bin, ["image", "pull", "--platform", "linux/arm64", image.pull], { timeoutMs: 60 * 60_000 });
  return res.code === 0 ? { ok: true } : { ok: false, error: firstLine(res.stderr) || `image pull exited ${res.code}` };
}

async function open(ctx: OpenContext): Promise<Opened> {
  const { key, name, root, croot, runtime, run, runFolder, image, pull: mayPull, shims, pkglog, env, log, onPulling } = ctx;
  let info = await inspectBox(runtime, name, run);
  if (info && info.labels[`${LABEL}.root`] && info.labels[`${LABEL}.root`] !== root) return { ok: false, error: `container ${name} belongs to another folder` };
  const placed = placeBoxd(runFolder, env);
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
    const made = await run(runtime.bin, createAppleArgs({ name, key, root, croot, image: image.pull, runFolder, shims, pkglog, token, port, env }), { timeoutMs: 120_000 });
    if (made.code !== 0) return { ok: false, error: `could not create the sandbox: ${firstLine(made.stderr)}` };
    created = { ref: image.ref, pull: image.pull, digest: image.digest || present.digest, id: present.id, stack: image.stack };
    log("info", "box created", { key, image: image.pull, stack: image.stack, backend: "apple" });
    info = await inspectBox(runtime, name, run);
    if (!info) return { ok: false, error: "the sandbox was created but cannot be inspected" };
  }
  if (!info.running) {
    const started = await run(runtime.bin, ["start", name], { timeoutMs: 120_000 });
    if (started.code !== 0) return { ok: false, error: `could not start the sandbox: ${firstLine(started.stderr)}` };
    info = (await inspectBox(runtime, name, run)) ?? info;
  }
  let token = "";
  try { token = readFileSync(tokenFile, "utf8").trim(); } catch { /* none */ }
  const port = Number(info.labels[`${LABEL}.port`]) || 0;
  if (!token || !port) return { ok: false, error: "the sandbox has no port or token (Reset sandbox makes a new one)" };
  const alternates = info.address ? [{ host: info.address, port: BOX_PORT, token }] : [];
  return { ok: true, created, endpoint: { host: "127.0.0.1", port, token }, alternates, uid: 0, gid: 0, containerId: info.id || name, imageId: info.digest || info.image, mounts: [croot, RUN_DIR, ...(shims ? [`${SHIMS_DIR}-src`] : []), ...(pkglog ? appleInstallLogMounts(info.labels, pkglog) : [])] };
}

/**
 * The install log's folders an Apple box was made with (the mounts are not read back): the read-only layout when
 * its label says so, else the old single read-write folder (box.ts then gives it its own copies).
 */
export function appleInstallLogMounts(labels: Record<string, string> | undefined, pkglog: BoxInstallLog): string[] {
  return labels?.[PKGLOG_LAYOUT_LABEL] === PKGLOG_LAYOUT ? pkglogMountPoints(pkglog, "darwin") : [containerRoot(pkglog.root, "darwin")];
}

export const appleDriver: BoxDriver = {
  kind: "apple",
  /** Its own VM network: the box's servers reach this computer's 127.0.0.1 through boxd (ports.ts). */
  forwardsPorts: false,
  execFallback: false,
  imagePresent,
  pull,
  pullCommand(runtime, image) {
    return { bin: runtime.bin, args: ["image", "pull", "--platform", "linux/arm64", image.pull] };
  },
  async exists(runtime, key, { run = runCommand, env = process.env } = {}) {
    return Boolean(await inspectBox(runtime, containerName(key, env), run));
  },
  open,
  async list(runtime, { run = runCommand } = {}) {
    const res = await run(runtime.bin, ["list", "--all", "--format", "json"], { timeoutMs: 30_000 });
    if (res.code !== 0) return [];
    const parsed = parseJson(res.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(snapshotInfo).filter((info) => info.labels[LABEL] === "1").map((info) => ({ key: info.labels[`${LABEL}.key`] ?? "", name: info.id, root: info.labels[`${LABEL}.root`] ?? "", running: info.running, image: info.image, created: String(info.created ?? "") }));
  },
  async remove(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await run(runtime.bin, ["delete", "--force", containerName(key, env)], { timeoutMs: 60_000 });
    return { removed: res.code === 0 };
  },
  async gcImages(runtime, { run = runCommand, current, used, keep = { refs: current, digests: new Set<string>() }, dryRun = false }) {
    const removed: Removed[] = [];
    const res = await run(runtime.bin, ["image", "list", "--format", "json"], { timeoutMs: 30_000 });
    const parsed = parseJson(res.stdout);
    for (const entry of Array.isArray(parsed) ? parsed.map(record) : []) {
      const ref = String(entry.reference ?? entry.name ?? "");
      const digest = record(entry.descriptor).digest ?? entry.digest;
      if (!ref || !removableImage({ ref, digest: typeof digest === "string" ? digest : null, id: "" }, { keep, used })) continue;
      if (dryRun) { removed.push({ kind: "image", name: ref, reason: "not current", dryRun: true }); continue; }
      const del = await run(runtime.bin, ["image", "delete", ref], { timeoutMs: 60_000 });
      if (del.code === 0) removed.push({ kind: "image", name: ref, reason: "not current" });
    }
    return removed;
  },
  async stop(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await run(runtime.bin, ["stop", containerName(key, env)], { timeoutMs: 60_000 });
    return { stopped: res.code === 0 };
  },
  async upperBytes() {
    return null;
  },
  shellCommand(runtime, { key, croot, env = process.env }) {
    return { bin: runtime.bin, args: ["exec", "--interactive", "--tty", "--workdir", croot, containerName(key, env), "/bin/bash", "-l"] };
  },
  execCommand(runtime, { key, env = process.env }) {
    return { bin: runtime.bin, args: ["exec", "--interactive", containerName(key, env)], env: {} };
  },
};
