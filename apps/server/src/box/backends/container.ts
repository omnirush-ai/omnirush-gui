// Ported from the CLI (omnirush-cli src/box/backends/container.js,
// feat/local-box-backends); keep the two in step. Desktop differences:
// types; the container-name prefix (containerName's env).
//
// Container engines as box backends: Docker (and what speaks its CLI:
// Docker Desktop, OrbStack, colima, Rancher Desktop, a Docker engine in
// WSL 2) and Podman (rootless on Linux, Podman machine elsewhere). One
// persistent container per project; boxd is copied in and published on
// this machine's loopback.

import { readFileSync } from "node:fs";
import os from "node:os";

import { BOX_PORT, GOARCH, HOME_IN_BOX, LABEL, RUN_DIR, SHIMS_DIR, containerName, containerRoot, firstLine, helperPath, newToken, wslPath, type BoxInstallLog, type BoxRuntime } from "../common.js";
import { runCommand, type RunCommand, type RunOptions } from "../run.js";
import type { BoxDriver, ListedBox, OpenContext, Opened } from "./types.js";

type Env = NodeJS.ProcessEnv;

/**
 * A tar with one executable file at `name` (and its folders), for `cp - <c>:/`:
 * `cp <file> <c>:<path>` needs the folder to exist in the image already.
 */
export function singleFileTar(name: string, data: Buffer, mode = 0o755): Buffer {
  const blocks: Buffer[] = [];
  const header = (entry: string, type: string, size: number, entryMode: number) => {
    const h = Buffer.alloc(512);
    h.write(entry, 0, 100, "utf8");
    h.write(`${entryMode.toString(8).padStart(7, "0")}\0`, 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return h;
  };
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i += 1) blocks.push(header(`${parts.slice(0, i).join("/")}/`, "5", 0, 0o755));
  blocks.push(header(name, "0", data.length, mode));
  blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// --- the runtime CLI ------------------------------------------------------------

/** Runs the runtime's CLI (`wsl.exe -e docker ...` for a WSL engine, `docker --context x ...`). */
export function rt(runtime: BoxRuntime, run: RunCommand = runCommand) {
  const prefix = Array.isArray(runtime.prefix) ? runtime.prefix : [];
  return (args: string[], opts: RunOptions = {}) => run(runtime.bin, [...prefix, ...args], { timeoutMs: 60_000, ...opts });
}

/** Where the runtime finds a folder of this machine (a WSL engine sees Windows drives under /mnt). */
function source(runtime: BoxRuntime, p: string): string {
  return runtime.wsl ? wslPath(p) : p;
}

/** Whether `image` is present locally; its id and repo digest when it is. */
export async function inspectImage(runtime: BoxRuntime, image: string, { run = runCommand }: { run?: RunCommand } = {}): Promise<{ id: string; digest: string | null; arch: string; size: number } | null> {
  const res = await rt(runtime, run)(["image", "inspect", image, "--format", "{{json .}}"], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  try {
    const info = JSON.parse(res.stdout.trim().split("\n")[0] ?? "");
    const digests: unknown[] = Array.isArray(info.RepoDigests) ? info.RepoDigests : [];
    const digest = digests.map((entry) => String(entry).split("@")[1]).find((d) => /^sha256:[0-9a-f]{64}$/.test(d || "")) || null;
    return { id: String(info.Id || ""), digest, arch: String(info.Architecture || ""), size: Number(info.Size || 0) };
  } catch {
    return null;
  }
}

/** `pull` with retries (a flaky link picks up where it stopped). */
export async function pullImage(runtime: BoxRuntime, image: string, { run = runCommand, pauses = [2_000, 8_000], timeoutMs = 60 * 60_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: { run?: RunCommand; pauses?: number[]; timeoutMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<{ ok: true; attempts: number } | { ok: false; error: string }> {
  let last = null;
  for (let attempt = 0; attempt <= pauses.length; attempt += 1) {
    last = await rt(runtime, run)(["pull", image], { timeoutMs });
    if (last.code === 0) return { ok: true, attempts: attempt + 1 };
    if (attempt < pauses.length) await sleep(pauses[attempt]!);
  }
  const said = String(last?.stderr || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || `pull exited with ${last?.code}`;
  return { ok: false, error: said.slice(0, 300) };
}

type ContainerInfo = { id: string; running: boolean; image: string; labels: Record<string, string>; env: string[]; mounts: string[] };

async function inspectContainer(runtime: BoxRuntime, name: string, run: RunCommand): Promise<ContainerInfo | null> {
  const res = await rt(runtime, run)(["container", "inspect", name, "--format", "{{json .}}"], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  try {
    const info = JSON.parse(res.stdout.trim().split("\n")[0] ?? "");
    return {
      id: String(info.Id || ""),
      running: Boolean(info.State?.Running),
      image: String(info.Image || ""),
      labels: info.Config?.Labels ?? {},
      env: Array.isArray(info.Config?.Env) ? info.Config.Env : [],
      mounts: Array.isArray(info.Mounts) ? info.Mounts.map((mount: { Destination?: unknown }) => String(mount.Destination ?? "")) : [],
    };
  } catch {
    return null;
  }
}

/** The host port boxd is published on. */
async function publishedPort(runtime: BoxRuntime, name: string, run: RunCommand): Promise<number | null> {
  const res = await rt(runtime, run)(["port", name, `${BOX_PORT}/tcp`], { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  for (const line of res.stdout.split("\n")) {
    const match = /:(\d+)\s*$/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/** Resource limits a new box gets (a VM runtime has its own; only the process cap then). */
export function resourceArgs({ runtime, env = process.env, cpus = os.cpus().length, memory = os.totalmem() }: { runtime: BoxRuntime; env?: Env; cpus?: number; memory?: number }): string[] {
  const args = ["--pids-limit", String(Number(env.OMNIRUSH_BOX_PIDS) || 4096)];
  const askedCpus = Number(env.OMNIRUSH_BOX_CPUS);
  const askedMem = String(env.OMNIRUSH_BOX_MEMORY || "").trim();
  if (askedCpus > 0) args.push("--cpus", String(askedCpus));
  else if (!runtime.vm) args.push("--cpus", String(Math.max(1, Math.min(8, cpus - 1))));
  if (askedMem) args.push("--memory", askedMem);
  else if (!runtime.vm) {
    const gib = Math.max(2, Math.min(8, Math.floor(memory / 2 / 1024 ** 3)));
    args.push("--memory", `${gib}g`);
  }
  return args;
}

/** Who commands run as: root where root maps to the user (rootless, VMs), else the user's own uid. */
export function commandUser(runtime: BoxRuntime, { platform = process.platform, uid = process.getuid?.(), gid = process.getgid?.() }: { platform?: NodeJS.Platform; uid?: number; gid?: number } = {}): { uid: number; gid: number } {
  if (platform !== "linux" || runtime.rootless || runtime.vm || uid === undefined || gid === undefined || uid === 0) return { uid: 0, gid: 0 };
  return { uid, gid };
}

/**
 * Create a box container (not started): the project folder at `croot`, the
 * launcher's run folder at /run/omnirush, the package-manager wrappers (when
 * there are) read-only, boxd published on this machine's loopback only.
 * Nothing else of this machine goes in: no home folder, no credentials, no
 * docker socket.
 */
export function createArgs({ name, key, root, croot, image, runtime, run: runFolder, shims, pkglog = null, token, user, env = process.env, platform = process.platform }: { name: string; key: string; root: string; croot: string; image: string; runtime: BoxRuntime; run: string; shims: string | null; pkglog?: BoxInstallLog | null; token: string; user: { uid: number; gid: number }; env?: Env; platform?: NodeJS.Platform }): string[] {
  return [
    "create", "--name", name, "--hostname", "omnirush-box", "--init",
    "--label", `${LABEL}=1`, "--label", `${LABEL}.key=${key}`, "--label", `${LABEL}.root=${root}`, "--label", `${LABEL}.version=1`,
    "--mount", `type=bind,source=${source(runtime, root)},target=${croot}`,
    "--mount", `type=bind,source=${source(runtime, runFolder)},target=${RUN_DIR}`,
    ...(shims ? ["--mount", `type=bind,source=${source(runtime, shims)},target=${SHIMS_DIR}-src,readonly`] : []),
    // The install log's folder (phase 1: its wrappers, pip hook and the per-run folders the
    // wrappers note calls in), at the path the launcher reads it at.
    ...(pkglog ? ["--mount", `type=bind,source=${source(runtime, pkglog.root)},target=${containerRoot(pkglog.root, platform)}`] : []),
    "-p", `127.0.0.1::${BOX_PORT}`,
    "-e", `BOXD_TOKEN=${token}`, "-e", `BOXD_UID=${user.uid}`, "-e", `BOXD_GID=${user.gid}`,
    "-e", `BOXD_HOME=${HOME_IN_BOX}`, "-e", `BOXD_ROOT=${croot}`, "-e", `BOXD_ENV_FILE=${RUN_DIR}/env`,
    "-e", "LANG=C.UTF-8", "-e", "DEBIAN_FRONTEND=noninteractive",
    "-w", croot,
    ...resourceArgs({ runtime, env }),
    ...(runtime.name === "podman" ? ["--security-opt", "label=disable"] : []),
    // Docker on Linux has no host.docker.internal by itself (Docker Desktop and Podman do): services on this machine.
    ...(runtime.name === "docker" && platform === "linux" && runtime.flavor !== "desktop" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
    ...(user.uid === 0 ? ["--security-opt", "no-new-privileges"] : []),
    "--entrypoint", "/opt/omnirush/bin/boxd",
    image,
  ];
}

/** "57.2MB (virtual 1.1GB)" -> bytes of the first number. */
export function parseSize(text: unknown): number | null {
  const match = /([\d.]+)\s*([kKMGT]?i?B)/.exec(String(text));
  if (!match) return null;
  const unit = match[2]!.replace(/i/, "").toUpperCase();
  const mult = ({ B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 } satisfies Record<string, number>)[unit] ?? 1;
  return Math.round(Number(match[1]) * mult);
}

// --- the driver ------------------------------------------------------------------

/** Create (or start) the project's container; boxd answers on a published loopback port. */
async function open(ctx: OpenContext): Promise<Opened> {
  const { key, name, root, croot, runtime, run, runFolder, image, pull, shims, pkglog, env, platform, log, onPulling } = ctx;
  let info = await inspectContainer(runtime, name, run);
  if (info && info.labels?.[`${LABEL}.root`] && info.labels[`${LABEL}.root`] !== root) {
    return { ok: false, error: `container ${name} belongs to another folder` };
  }
  let created = null;
  if (!info) {
    let present = await inspectImage(runtime, image.pull, { run });
    if (!present) {
      if (!pull) return { ok: false, error: "the sandbox image is not downloaded yet" };
      onPulling();
      const pulled = await pullImage(runtime, image.pull, { run });
      if (!pulled.ok) return { ok: false, error: `could not download the sandbox image: ${pulled.error}` };
      present = await inspectImage(runtime, image.pull, { run });
      if (!present) return { ok: false, error: "the sandbox image is not there after the download" };
    }
    const goarch = GOARCH[present.arch] || GOARCH[runtime.arch ?? ""] || "amd64";
    const boxd = helperPath("boxd", { goos: "linux", goarch, env });
    if (!boxd) return { ok: false, error: `the sandbox helper is missing (linux-${goarch}/boxd)` };
    const user = commandUser(runtime, { platform });
    const made = await rt(runtime, run)(createArgs({ name, key, root, croot, image: image.pull, runtime, run: runFolder, shims, pkglog, token: newToken(), user, env, platform }), { timeoutMs: 120_000 });
    if (made.code !== 0) return { ok: false, error: `could not create the sandbox: ${firstLine(made.stderr)}` };
    const copied = await rt(runtime, run)(["cp", "-", `${name}:/`], { timeoutMs: 60_000, input: singleFileTar("opt/omnirush/bin/boxd", readFileSync(boxd)) });
    if (copied.code !== 0) {
      await rt(runtime, run)(["rm", "-f", name], { timeoutMs: 30_000 });
      return { ok: false, error: `could not copy the sandbox helper in: ${firstLine(copied.stderr)}` };
    }
    created = { ref: image.ref, pull: image.pull, digest: image.digest || present.digest, id: present.id, stack: image.stack };
    info = await inspectContainer(runtime, name, run);
    if (!info) return { ok: false, error: "the sandbox was not there after it was created" };
    log("info", "box created", { key, image: image.pull, stack: image.stack, backend: runtime.backend ?? runtime.name });
  }
  if (!info.running) {
    const started = await rt(runtime, run)(["start", name], { timeoutMs: 60_000 });
    if (started.code !== 0) return { ok: false, error: `could not start the sandbox: ${firstLine(started.stderr)}` };
  }
  const env0 = info.env;
  const envOf = (k: string, d = "") => (env0.find((kv) => kv.startsWith(`${k}=`)) || `${k}=${d}`).slice(k.length + 1);
  const port = await publishedPort(runtime, name, run);
  const token = envOf("BOXD_TOKEN");
  if (!port || !token) return { ok: false, error: "the sandbox started without its port" };
  return { ok: true, created, endpoint: { host: "127.0.0.1", port, token }, uid: Number(envOf("BOXD_UID", "0")), gid: Number(envOf("BOXD_GID", "0")), containerId: info.id, imageId: info.image, mounts: info.mounts };
}

/** Boxes on this machine: { key, name, root, running, image, created }[] */
export async function listContainers(runtime: BoxRuntime, { run = runCommand }: { run?: RunCommand } = {}): Promise<ListedBox[]> {
  const res = await rt(runtime, run)(["ps", "-a", "--filter", `label=${LABEL}=1`, "--format", "{{json .}}"], { timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  const out: ListedBox[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const labels: Record<string, string> = typeof row.Labels === "string"
        ? Object.fromEntries(row.Labels.split(",").map((kv: string) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }))
        : (row.Labels ?? {});
      const name = Array.isArray(row.Names) ? row.Names[0] : String(row.Names ?? "");
      out.push({ key: labels[`${LABEL}.key`] ?? "", name, root: labels[`${LABEL}.root`] ?? "", running: /^up|running/i.test(String(row.Status ?? row.State ?? "")), image: String(row.Image ?? ""), created: String(row.CreatedAt ?? row.Created ?? "") });
    } catch { /* skip */ }
  }
  return out;
}

export const containerDriver: BoxDriver = {
  kind: "container",
  /** `docker exec` works when boxd is down (boxsh's fallback). */
  execFallback: true,
  async imagePresent(runtime, image, { run = runCommand } = {}) {
    const found = await inspectImage(runtime, image.pull, { run });
    return found ? { id: found.id, digest: found.digest, arch: found.arch } : null;
  },
  pull(runtime, image, { run = runCommand } = {}) {
    return pullImage(runtime, image.pull, { run });
  },
  /** The detached download (the app keeps no handle on it). */
  pullCommand(runtime, image) {
    return { bin: runtime.bin, args: [...(runtime.prefix ?? []), "pull", image.pull] };
  },
  async exists(runtime, key, { run = runCommand, env = process.env, timeoutMs = 20_000 } = {}) {
    const res = await rt(runtime, run)(["container", "inspect", containerName(key, env), "--format", "{{.Id}}"], { timeoutMs });
    return res.code === 0;
  },
  open,
  list: (runtime, { run = runCommand } = {}) => listContainers(runtime, { run }),
  async remove(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await rt(runtime, run)(["rm", "-f", containerName(key, env)], { timeoutMs: 60_000 });
    return { removed: res.code === 0 };
  },
  /** Box images that no box uses and that are not the current pins (`omnirush-ai/box-*` only; never a prune). */
  async gcImages(runtime, { run = runCommand, current, used }) {
    const removed = [];
    const images = await rt(runtime, run)(["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"], { timeoutMs: 30_000 });
    for (const line of images.stdout.split("\n")) {
      const [ref, id] = line.trim().split(/\s+/);
      if (!ref || !/(^|\/)omnirush-ai\/box-[a-z]+:/.test(ref) || current.has(ref) || used.has(ref) || (id && used.has(id))) continue;
      const res = await rt(runtime, run)(["rmi", ref], { timeoutMs: 60_000 });
      if (res.code === 0) removed.push({ kind: "image", name: ref, reason: "not current" });
    }
    return removed;
  },
  async stop(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await rt(runtime, run)(["stop", "-t", "1", containerName(key, env)], { timeoutMs: 60_000 });
    return { stopped: res.code === 0 };
  },
  async upperBytes(runtime, key, { run = runCommand, env = process.env } = {}) {
    const res = await rt(runtime, run)(["ps", "-a", "-s", "--filter", `name=^/?${containerName(key, env)}$`, "--format", "{{.Size}}"], { timeoutMs: 30_000 });
    return parseSize(res.stdout);
  },
  diff(runtime, key, { run = runCommand, env = process.env } = {}) {
    return rt(runtime, run)(["diff", containerName(key, env)], { timeoutMs: 120_000, maxBytes: 256 << 20 });
  },
  /** An interactive shell in the box. */
  shellCommand(runtime, { key, croot, uid, gid, env = process.env }) {
    const user = uid ? ["-u", `${uid}:${gid ?? uid}`] : [];
    return { bin: runtime.bin, args: [...(runtime.prefix ?? []), "exec", "-it", ...user, "-e", `HOME=${HOME_IN_BOX}`, "-w", croot, containerName(key, env), "/bin/bash"] };
  },
  /** How to run a program in the box with stdin open (files-used reads). */
  execCommand(runtime, { key, env = process.env }) {
    return { bin: runtime.bin, args: [...(runtime.prefix ?? []), "exec", "-i", containerName(key, env)], env: {} };
  },
};
