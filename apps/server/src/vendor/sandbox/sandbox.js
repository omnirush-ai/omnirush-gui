// OmniRush sandbox: run an OmniRush engine (`opencode serve` or the CLI's
// fork of it) inside a pinned Linux container instead of on the user's
// machine, so a captured session's environment is an image digest plus the
// changes the session made inside it. That is what turns a trace into a task
// anyone can rebuild with `docker build`.
//
// This file is the single source of the sandbox. omnirush-cli
// (src/vendor/sandbox/) and omnirush-gui (apps/server/src/vendor/sandbox/)
// carry byte-identical copies listed in their PARITY.sha256. Edit it in
// omnirush-sandbox and run `node scripts/sync.mjs <cli checkout> <gui checkout>`.
//
// Zero dependencies; runs on Node 20+, Bun and Electron. Only the Docker CLI
// is required on the machine, and only when the sandbox is on.
//
// SPDX-License-Identifier: MIT

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Version of the manifest a sandboxed session records (`environment.sandbox`). */
export const SANDBOX_SCHEMA = 1;
/** The published image. OMNIRUSH_SANDBOX_IMAGE overrides it (a local build, a pinned digest). */
export const DEFAULT_IMAGE = "ghcr.io/omnirush-ai/sandbox:1";
/** HOME inside the sandbox, the same in the session and in every task built from it. */
export const SANDBOX_HOME = "/home/omnirush";
/** Where the engine binary is mounted (read-only). It is never part of the image. */
export const ENGINE_DIR = "/opt/omnirush/engine";
/** Named volume for the session's caches (npm, uv, the engine's provider packages). */
export const CACHE_VOLUME = "omnirush-sandbox-cache";
/** Label on every container and image the sandbox creates. */
export const LABEL = "ai.omnirush.sandbox";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DOCKER_ARCH = { x64: "amd64", arm64: "arm64" };

// Paths a session changes that say nothing about its environment, or that
// the sandbox itself writes. They never enter a snapshot.
const NOISE_PREFIXES = [
  "/tmp",
  "/var/tmp",
  "/run",
  "/proc",
  "/sys",
  "/dev",
  "/var/log",
  "/var/cache/apt",
  "/var/cache/debconf/templates.dat-old",
  "/var/lib/apt/lists",
  "/root/.cache",
  "/root/.npm/_cacache",
  "/root/.npm/_logs",
  `${SANDBOX_HOME}/.cache`,
  `${SANDBOX_HOME}/.npm/_cacache`,
  `${SANDBOX_HOME}/.npm/_logs`,
  `${SANDBOX_HOME}/.bun/install/cache`,
  // The engine's own config and data (the task's agent brings its own).
  `${SANDBOX_HOME}/.config/opencode`,
  `${SANDBOX_HOME}/.config/omnirush`,
  `${SANDBOX_HOME}/.local/share/opencode`,
  `${SANDBOX_HOME}/.local/share/omnirush`,
  `${SANDBOX_HOME}/.local/state/opencode`,
  `${SANDBOX_HOME}/.local/state/omnirush`,
  ENGINE_DIR,
  // Docker's init (`--init`), mounted in by the runtime.
  "/usr/sbin/docker-init",
];
// Files the container runtime and the entrypoint rewrite on every start.
const NOISE_FILES = new Set(["/etc/passwd", "/etc/group", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/etc/mtab"]);

// Host environment never copied into the container: it describes the host.
const NEVER_PASS = new Set(["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]);
// Host environment that is safe and useful inside: terminal, locale, proxies.
const ALWAYS_PASS = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "NO_COLOR", "FORCE_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
const NEVER_PASS_PATTERN = /^(?:DOCKER_|OMNIRUSH_SANDBOX)|^OMNIRUSH_ENCRYPTION_KEY$|REFRESH_TOKEN$/;
const PASS_PATTERN = /^(OPENCODE_|OMNIRUSH_|npm_config_)/;

export class SandboxError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] unavailable | image | engine | mount | docker
   */
  constructor(message, code = "docker") {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/** "docker" when OMNIRUSH_SANDBOX asks for it, else "off". */
export function sandboxMode(env = process.env) {
  const value = String(env.OMNIRUSH_SANDBOX ?? "").trim().toLowerCase();
  return value === "docker" || value === "1" || value === "on" || value === "true" ? "docker" : "off";
}

/** The Docker platform (`linux/amd64`) for a Node arch (`x64`). */
export function dockerPlatform(arch = process.arch) {
  const mapped = DOCKER_ARCH[arch];
  return mapped ? `linux/${mapped}` : null;
}

/**
 * Loopback ports named in some text: http://127.0.0.1:4096, localhost:80,
 * [::1]:3000. The sandbox relays them to the host in bridge mode.
 * @param {Iterable<string>} texts
 */
export function loopbackPorts(texts) {
  const ports = new Set();
  const pattern = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\b/g;
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(pattern)) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * The URL the host uses for an engine URL printed inside the sandbox:
 * `http://0.0.0.0:4096` is reached at `http://127.0.0.1:4096` (the port is
 * published to the same number on the host's loopback).
 */
export function mapEngineUrl(url) {
  return String(url).replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\]|localhost)(?=[:/]|$)/, "$1127.0.0.1");
}

/** `docker diff` output as entries ({ kind: "A" | "C" | "D", path }). */
export function parseDockerDiff(stdout) {
  const entries = [];
  for (const line of String(stdout).split("\n")) {
    const match = line.match(/^([ACD]) (\/.*)$/);
    if (match) entries.push({ kind: match[1], path: match[2] });
  }
  return entries;
}

function within(child, parent) {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * The environment changes worth keeping: no runtime noise, nothing inside a
 * mounted folder (the workspace is captured on its own), and not the empty
 * folders Docker creates to mount them on.
 * @param {{ kind: string, path: string }[]} entries
 * @param {{ mounts?: string[] }} [options]
 */
export function filterChanges(entries, { mounts = [] } = {}) {
  const dropped = [];
  const kept = entries.filter(({ path: entry }) => {
    const noise = NOISE_FILES.has(entry)
      || NOISE_PREFIXES.some((prefix) => within(entry, prefix))
      || mounts.some((target) => within(entry, target) || within(target, entry));
    if (noise) dropped.push(entry);
    return !noise;
  });
  // A folder Docker lists only because of something dropped above (`C /etc`
  // for /etc/passwd, `A ~/.config` for the engine's config) is not a change
  // either. Deepest first, so `C /usr` goes once `C /usr/sbin` has gone.
  const ancestors = (entry) => {
    const list = [];
    for (let at = entry.lastIndexOf("/"); at > 0; at = entry.lastIndexOf("/", at - 1)) list.push(entry.slice(0, at));
    return list;
  };
  const keptBelow = new Map();
  for (const { path: entry } of kept) for (const parent of ancestors(entry)) keptBelow.set(parent, (keptBelow.get(parent) ?? 0) + 1);
  const droppedBelow = new Set(dropped.flatMap(ancestors));
  const gone = new Set();
  const deepestFirst = kept.filter(({ kind }) => kind !== "D").sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const { path: entry } of deepestFirst) {
    if (!droppedBelow.has(entry) || keptBelow.get(entry)) continue;
    gone.add(entry);
    for (const parent of ancestors(entry)) {
      keptBelow.set(parent, keptBelow.get(parent) - 1);
      droppedBelow.add(parent);
    }
  }
  return kept.filter(({ path: entry }) => !gone.has(entry));
}

/** user.name / user.email from the user's git config files, without running git. */
export function gitIdentity(home = os.homedir(), env = process.env) {
  const files = [path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config"), path.join(home, ".gitconfig")];
  const identity = {};
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let section = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const header = line.match(/^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]$/);
      if (header) {
        section = header[1].toLowerCase();
        continue;
      }
      if (section !== "user") continue;
      const pair = line.match(/^(name|email)\s*=\s*(.*)$/i);
      if (!pair) continue;
      const value = pair[2].replace(/^"(.*)"$/, "$1").trim();
      if (value) identity[pair[1].toLowerCase()] = value;
    }
  }
  return identity;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "x";
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

function checkMountPath(value, what) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new SandboxError(`${what} must be an absolute path: ${value}`, "mount");
  if (/[,\n\r]/.test(value)) throw new SandboxError(`${what} has a comma or a line break, which Docker mounts cannot carry: ${value}`, "mount");
  return value;
}

function defaultRun(command, args, { env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && typeof error.code !== "number" ? String(error.message) : "") });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The value after `--flag value` or `--flag=value` in an argv, with its index. */
function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) return { index: i + 1, value: args[i + 1] };
    if (typeof args[i] === "string" && args[i].startsWith(`${flag}=`)) return { index: i, value: args[i].slice(flag.length + 1), inline: true };
  }
  return null;
}

function setFlag(args, flag, value) {
  const found = flagValue(args, flag);
  if (!found) return [...args, flag, String(value)];
  const next = [...args];
  next[found.index] = found.inline ? `${flag}=${value}` : String(value);
  return next;
}

/**
 * A sandbox bound to one Docker CLI. Everything that talks to Docker goes
 * through `run`, so tests can drive it without a daemon.
 *
 * @param {{
 *   docker?: string,
 *   env?: Record<string, string | undefined>,
 *   run?: typeof defaultRun,
 *   spawnImpl?: typeof spawn,
 *   fetchImpl?: typeof fetch,
 *   platform?: NodeJS.Platform,
 *   arch?: string,
 *   uid?: number | null,
 *   gid?: number | null,
 *   homedir?: string,
 *   hostname?: string,
 *   pid?: number,
 *   freePort?: () => Promise<number>,
 * }} [options]
 */
export function createSandbox(options = {}) {
  const docker = options.docker || options.env?.OMNIRUSH_SANDBOX_DOCKER || process.env.OMNIRUSH_SANDBOX_DOCKER || "docker";
  const hostEnv = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const uid = options.uid !== undefined ? options.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const gid = options.gid !== undefined ? options.gid : typeof process.getgid === "function" ? process.getgid() : null;
  const homedir = options.homedir ?? os.homedir();
  const hostname = options.hostname ?? os.hostname();
  const pid = options.pid ?? process.pid;
  const pickPort = options.freePort ?? freePort;
  const dockerEnv = { ...process.env, ...hostEnv };
  const call = (args, extra = {}) => run(docker, args, { env: dockerEnv, ...extra });

  /** The Docker daemon this CLI reaches, or { ok: false, error }. */
  async function inspect() {
    const version = await call(["version", "--format", "{{json .}}"], { timeoutMs: 20_000 });
    if (version.code !== 0) return { ok: false, error: firstLine(version.stderr) || "Docker is not running" };
    let server = {};
    try {
      server = JSON.parse(version.stdout).Server ?? {};
    } catch {
      return { ok: false, error: "could not read `docker version`" };
    }
    const info = await call(["info", "--format", "{{json .}}"], { timeoutMs: 20_000 });
    let details = {};
    try {
      details = info.code === 0 ? JSON.parse(info.stdout) : {};
    } catch {
      details = {};
    }
    const operatingSystem = String(details.OperatingSystem ?? "");
    const remote = /^(ssh|tcp|https?):\/\//i.test(String(hostEnv.DOCKER_HOST ?? ""));
    return {
      ok: true,
      version: String(server.Version ?? ""),
      os: String(server.Os ?? "linux"),
      arch: String(server.Arch ?? ""),
      operatingSystem,
      desktop: /docker desktop/i.test(operatingSystem),
      remote,
    };
  }

  /**
   * "bridge" (the default everywhere): the sandbox has its own network, the
   * engine's port is published on the host's loopback, and only the host
   * services the engine was given are relayed in, so nothing else listening
   * on this machine's loopback is reachable. "host" (OMNIRUSH_SANDBOX_NETWORK
   * =host, Linux only) shares the host's network and reaches all of it.
   */
  function networkMode() {
    const forced = String(hostEnv.OMNIRUSH_SANDBOX_NETWORK ?? "").trim().toLowerCase();
    return forced === "host" ? "host" : "bridge";
  }

  /**
   * How a relayed host service is reached from inside. A Linux daemon on
   * this machine shares its filesystem, so each service gets a unix socket
   * in a folder only this sandbox mounts ("socket"). Docker Desktop and
   * colima run in a VM whose shared folders carry no sockets; there the
   * relay goes through the VM's host gateway ("gateway").
   */
  function relayMode(info) {
    return platform === "linux" && !info.desktop && !info.remote ? "socket" : "gateway";
  }

  /**
   * One unix socket per host port in a fresh folder: each connection on
   * `<dir>/p<port>.sock` is piped to 127.0.0.1:<port>. The entrypoint
   * listens on 127.0.0.1:<port> inside and connects to the socket.
   */
  async function socketRelays(ports) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omnirush-relay-"));
    const servers = await Promise.all(ports.map((port) => new Promise((resolve, reject) => {
      const server = net.createServer((inside) => {
        const host = net.connect(port, "127.0.0.1");
        inside.on("error", () => host.destroy());
        host.on("error", () => inside.destroy());
        inside.pipe(host).pipe(inside);
      });
      server.once("error", reject);
      server.listen(path.join(dir, `p${port}.sock`), () => {
        server.unref();
        resolve(server);
      });
    })));
    return {
      dir,
      close: () => {
        for (const server of servers) server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** The image, pulled when missing, with the digest a task pins. */
  async function resolveImage(ref) {
    let inspected = await call(["image", "inspect", ref, "--format", "{{json .}}"], { timeoutMs: 30_000 });
    if (inspected.code !== 0) {
      if (String(hostEnv.OMNIRUSH_SANDBOX_PULL ?? "") === "0") throw new SandboxError(`The sandbox image ${ref} is not on this machine (pulling is off).`, "image");
      const pulled = await call(["pull", ref], { timeoutMs: 60 * 60_000 });
      if (pulled.code !== 0) throw new SandboxError(`Could not pull the sandbox image ${ref}: ${firstLine(pulled.stderr)}`, "image");
      inspected = await call(["image", "inspect", ref, "--format", "{{json .}}"], { timeoutMs: 30_000 });
      if (inspected.code !== 0) throw new SandboxError(`Could not inspect the sandbox image ${ref}: ${firstLine(inspected.stderr)}`, "image");
    }
    let data;
    try {
      data = JSON.parse(inspected.stdout);
    } catch {
      throw new SandboxError(`Could not read the sandbox image ${ref}.`, "image");
    }
    const repo = ref.replace(/@sha256:[0-9a-f]+$/, "").replace(/:[^/:]+$/, "");
    const digests = Array.isArray(data.RepoDigests) ? data.RepoDigests : [];
    const match = digests.find((entry) => entry.startsWith(`${repo}@`)) ?? null;
    // Only an image from a registry can be pulled by digest elsewhere; a
    // local build (`omnirush-sandbox:dev`) is recorded but is not portable.
    const registry = repo.includes("/") && /[.:]|^localhost$/.test(repo.split("/")[0]);
    return {
      ref,
      id: String(data.Id ?? ""),
      digest: match ? match.slice(match.indexOf("@") + 1) : null,
      pinned: registry && match ? match : null,
      platform: `${data.Os ?? "linux"}/${data.Architecture ?? ""}`,
      schema: data.Config?.Labels?.[`${LABEL}.schema`] ?? null,
    };
  }

  /**
   * A Linux build of the engine for the sandbox's platform. On a Linux host
   * of the same architecture the app's own binary is mounted; elsewhere the
   * engine's npm package for that platform is fetched (checked against the
   * registry's sha512) into a named volume, once per version.
   */
  async function ensureEngine(engine, image) {
    if (!engine?.name || !engine?.version) throw new SandboxError("The sandbox needs the engine's name and version.", "engine");
    const name = slug(engine.name);
    const target = image.platform;
    if (engine.hostPath && platform === "linux" && dockerPlatform(arch) === target && existsSync(engine.hostPath)) {
      const source = checkMountPath(realpathSync(engine.hostPath), "The engine binary");
      return {
        path: `${ENGINE_DIR}/${name}`,
        mount: { type: "bind", source, target: `${ENGINE_DIR}/${name}`, readonly: true },
        record: { name: engine.name, version: engine.version, source: "host", package: null },
      };
    }
    const pkg = engine.npm?.packages?.[target];
    if (!pkg) throw new SandboxError(`No ${engine.name} build is known for ${target}.`, "engine");
    const volume = `omnirush-engine-${name}-${slug(engine.version)}-${slug(target.replace("/", "-"))}`;
    const record = { name: engine.name, version: engine.version, source: "npm", package: `${pkg}@${engine.version}` };
    const mount = { type: "volume", source: volume, target: ENGINE_DIR, readonly: true };
    const present = await call(["run", "--rm", "--network", "none", "--entrypoint", "test", "--mount", `type=volume,src=${volume},dst=/engine,readonly`, image.id || image.ref, "-x", `/engine/${name}`], { timeoutMs: 60_000 });
    if (present.code === 0) return { path: `${ENGINE_DIR}/${name}`, mount, record };

    const registry = String(engine.npm.registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
    if (typeof fetchImpl !== "function") throw new SandboxError("This runtime has no fetch to download the engine.", "engine");
    const response = await fetchImpl(`${registry}/${pkg}/${encodeURIComponent(engine.version)}`);
    if (!response.ok) throw new SandboxError(`The npm registry answered ${response.status} for ${pkg}@${engine.version}.`, "engine");
    const meta = await response.json();
    const tarball = meta?.dist?.tarball;
    const integrity = String(meta?.dist?.integrity ?? "");
    if (!tarball || !integrity.startsWith("sha512-")) throw new SandboxError(`${pkg}@${engine.version} has no tarball with a sha512 integrity.`, "engine");
    const sha512 = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
    const bin = String(engine.npm.bin || `bin/${engine.name}`).replace(/^\/+/, "");
    const script = [
      "set -eu",
      'curl -fsSL --retry 3 "$ENGINE_URL" -o /tmp/engine.tgz',
      'echo "$ENGINE_SHA512  /tmp/engine.tgz" | sha512sum -c - >/dev/null',
      "mkdir -p /tmp/engine && tar -xzf /tmp/engine.tgz -C /tmp/engine",
      'install -m 0755 "/tmp/engine/package/$ENGINE_BIN" "/engine/$ENGINE_NAME.tmp"',
      'mv "/engine/$ENGINE_NAME.tmp" "/engine/$ENGINE_NAME"',
      'printf "%s\\n" "$ENGINE_PACKAGE" > /engine/PACKAGE',
    ].join("\n");
    const fetched = await call([
      "run", "--rm", "--user", "0", "--entrypoint", "sh",
      "--label", `${LABEL}=engine-fetch`,
      "--mount", `type=volume,src=${volume},dst=/engine`,
      "-e", `ENGINE_URL=${tarball}`, "-e", `ENGINE_SHA512=${sha512}`, "-e", `ENGINE_BIN=${bin}`,
      "-e", `ENGINE_NAME=${name}`, "-e", `ENGINE_PACKAGE=${record.package}`,
      image.id || image.ref, "-c", script,
    ], { timeoutMs: 30 * 60_000 });
    if (fetched.code !== 0) throw new SandboxError(`Could not fetch ${record.package} into the sandbox: ${firstLine(fetched.stderr)}`, "engine");
    return { path: `${ENGINE_DIR}/${name}`, mount, record };
  }

  /** Remove engine containers whose app on this machine is gone (a crash, a SIGKILL). */
  async function reapOrphans() {
    const listed = await call(["ps", "-a", "--filter", `label=${LABEL}=engine`, "--format", `{{.Names}}\t{{.Label "${LABEL}.owner"}}`], { timeoutMs: 20_000 });
    if (listed.code !== 0) return [];
    const removed = [];
    for (const line of listed.stdout.split("\n")) {
      const [container, owner] = line.split("\t");
      if (!container || !owner) continue;
      const at = owner.lastIndexOf(":");
      const ownerHost = owner.slice(0, at);
      const ownerPid = Number(owner.slice(at + 1));
      if (ownerHost !== hostname || !Number.isInteger(ownerPid) || ownerPid === pid || processAlive(ownerPid)) continue;
      const result = await call(["rm", "-f", container], { timeoutMs: 30_000 });
      if (result.code === 0) removed.push(container);
    }
    return removed;
  }

  /**
   * Everything needed to start an engine inside the sandbox instead of on the
   * host. Spawn `command`/`args` with `env` where the app spawned the engine,
   * read the readiness URL as before and pass it through mapUrl().
   *
   * @param {{
   *   command: string,
   *   args: string[],
   *   cwd: string,
   *   env: Record<string, string | undefined>,
   *   passEnv?: string[],
   *   workspaces?: string[],
   *   mounts?: { path: string, readonly?: boolean }[],
   *   stateDir: string,
   *   engine: { name: string, version: string, hostPath?: string, npm?: { registry?: string, packages: Record<string, string>, bin?: string } } | null,
   *   image?: string,
   *   app: string,
   *   interactive?: boolean,
   * }} input
   */
  async function prepareEngine(input) {
    const info = await inspect();
    if (!info.ok) throw new SandboxError(`The sandbox needs Docker: ${info.error}`, "unavailable");
    if (info.remote) throw new SandboxError("The sandbox needs a local Docker daemon (DOCKER_HOST points at another machine, which cannot see this folder).", "unavailable");
    void reapOrphans().catch(() => undefined);

    const image = await resolveImage(input.image || hostEnv.OMNIRUSH_SANDBOX_IMAGE || DEFAULT_IMAGE);
    // No engine: run `command` itself from the image (a shell, a check).
    const engine = input.engine ? await ensureEngine(input.engine, image) : null;
    const network = networkMode();
    const env = input.env ?? {};
    const cwd = checkMountPath(path.resolve(input.cwd), "The engine folder");

    // The folders the session works in, mounted at the same absolute paths so
    // every path in the trace is valid inside the sandbox and in the task. A
    // home folder or a filesystem root is never mounted: the engine's own
    // folder must not be one, and other such workspaces are left out.
    const notProject = (folder) => folder === path.parse(folder).root || folder === homedir;
    if (notProject(cwd)) throw new SandboxError(`The sandbox mounts only project folders, not ${cwd}. Open a project folder.`, "mount");
    const requested = [...new Set((input.workspaces?.length ? input.workspaces : [cwd]).map((entry) => path.resolve(entry)))];
    const skipped = requested.filter(notProject);
    const workspaces = requested.filter((entry) => !notProject(entry));
    for (const workspace of workspaces) checkMountPath(workspace, "A workspace");
    const stateDir = checkMountPath(path.resolve(input.stateDir), "The sandbox state folder");
    const dataHome = path.join(stateDir, "data");
    const stateHome = path.join(stateDir, "state");
    mkdirSync(dataHome, { recursive: true });
    mkdirSync(stateHome, { recursive: true });

    const binds = [];
    const addBind = (source, readonly) => {
      const resolved = checkMountPath(path.resolve(source), "A mount");
      if (!existsSync(resolved)) return;
      const covering = binds.find((bind) => within(resolved, bind.source));
      if (covering && (!covering.readonly || readonly)) return;
      binds.push({ type: "bind", source: resolved, target: resolved, readonly: Boolean(readonly) });
    };
    for (const workspace of workspaces) addBind(workspace, false);
    // Only the engine's data: the rest of stateDir (turn snapshots) stays out of the agent's reach.
    addBind(dataHome, false);
    addBind(stateHome, false);
    if (env.OPENCODE_CONFIG && path.isAbsolute(env.OPENCODE_CONFIG)) addBind(path.dirname(env.OPENCODE_CONFIG), true);
    for (const extra of input.mounts ?? []) addBind(extra.path, extra.readonly !== false);
    if (!binds.some((bind) => within(cwd, bind.source))) addBind(cwd, false);

    // A server (`serve --port`) listens inside; the host connects to the same port number.
    let args = [...input.args];
    const serves = Boolean(flagValue(args, "--port") || flagValue(args, "--hostname"));
    let port = Number(flagValue(args, "--port")?.value ?? 0);
    if (network === "bridge" && serves) {
      if (!port) port = await pickPort();
      args = setFlag(setFlag(args, "--hostname", "0.0.0.0"), "--port", port);
    }

    // Names passed through by name only (`-e NAME`): their values travel in
    // the Docker CLI's environment, never on a command line.
    const names = new Set([...(input.passEnv ?? []), ...ALWAYS_PASS]);
    for (const key of Object.keys(env)) if (PASS_PATTERN.test(key)) names.add(key);
    const passed = {};
    for (const key of names) {
      if (NEVER_PASS.has(key) || NEVER_PASS_PATTERN.test(key)) continue;
      const value = env[key] ?? (ALWAYS_PASS.includes(key) ? hostEnv[key] : undefined);
      if (typeof value === "string") passed[key] = value;
    }
    let configText = "";
    if (env.OPENCODE_CONFIG) {
      try {
        configText = readFileSync(env.OPENCODE_CONFIG, "utf8");
      } catch {
        configText = "";
      }
    }
    const relayed = network === "bridge" ? loopbackPorts([...Object.values(passed), configText]).filter((entry) => entry !== port) : [];
    const relays = relayed.length && relayMode(info) === "socket" ? await socketRelays(relayed) : null;
    if (relays) binds.push({ type: "bind", source: relays.dir, target: relays.dir, readonly: false });
    const identity = gitIdentity(homedir, hostEnv);
    const inline = {
      HOME: SANDBOX_HOME,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      OMNIRUSH_SANDBOX_SESSION: "1",
      ...(relayed.length ? { OMNIRUSH_SANDBOX_HOST_PORTS: relayed.join(",") } : {}),
      ...(relays ? { OMNIRUSH_SANDBOX_RELAY_DIR: relays.dir } : {}),
      ...(hostEnv.OMNIRUSH_SANDBOX_HOST_GATEWAY ? { OMNIRUSH_SANDBOX_HOST_GATEWAY: hostEnv.OMNIRUSH_SANDBOX_HOST_GATEWAY } : {}),
      ...(identity.name && !passed.GIT_AUTHOR_NAME ? { GIT_AUTHOR_NAME: identity.name, GIT_COMMITTER_NAME: identity.name } : {}),
      ...(identity.email && !passed.GIT_AUTHOR_EMAIL ? { GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_EMAIL: identity.email } : {}),
    };

    const container = `omnirush-engine-${slug(input.app || "app")}-${randomBytes(5).toString("hex")}`;
    const mounts = [
      ...binds,
      ...(engine ? [engine.mount] : []),
      { type: "volume", source: CACHE_VOLUME, target: `${SANDBOX_HOME}/.cache`, readonly: false },
    ];
    const dockerArgs = [
      "run", "--rm", "--init",
      ...(input.interactive ? ["--interactive", "--tty"] : []),
      "--name", container,
      "--label", `${LABEL}=engine`,
      "--label", `${LABEL}.app=${slug(input.app || "app")}`,
      "--label", `${LABEL}.owner=${hostname}:${pid}`,
      ...(network === "host"
        ? ["--network", "host"]
        : [...(serves ? ["--publish", `127.0.0.1:${port}:${port}`] : []), "--add-host", "host.docker.internal:host-gateway"]),
      ...(uid !== null && gid !== null ? ["--user", `${uid}:${gid}`] : []),
      ...Object.keys(passed).sort().flatMap((key) => ["-e", key]),
      ...Object.entries(inline).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      ...mounts.flatMap((mount) => ["--mount", `type=${mount.type},src=${mount.source},dst=${mount.target}${mount.readonly ? ",readonly" : ""}`]),
      "--workdir", cwd,
      image.id || image.ref,
      engine ? engine.path : input.command,
      ...args,
    ];

    const manifest = {
      schema: SANDBOX_SCHEMA,
      mode: "docker",
      image: { ref: image.ref, id: image.id, digest: image.digest, pinned: image.pinned, platform: image.platform },
      engine: engine ? engine.record : null,
      network,
      user: uid !== null && gid !== null ? `${uid}:${gid}` : null,
      home: SANDBOX_HOME,
      workdir: cwd,
      workspaces,
      docker: { version: info.version, os: info.operatingSystem || info.os },
      app: input.app || null,
    };
    const mountTargets = mounts.map((mount) => mount.target);

    let disposed = null;
    const dispose = () => {
      disposed ??= call(["rm", "-f", container], { timeoutMs: 30_000 }).then(() => undefined, () => undefined).finally(() => relays?.close());
      return disposed;
    };

    /** What the session changed outside its mounted folders so far. */
    const changes = async () => {
      const result = await call(["diff", container], { timeoutMs: 60_000 });
      if (result.code !== 0) throw new SandboxError(`Could not read the sandbox's changes: ${firstLine(result.stderr)}`, "docker");
      return filterChanges(parseDockerDiff(result.stdout), { mounts: mountTargets });
    };

    /**
     * Freeze the environment as it is now: call it when a turn's prompt is
     * sent, before the agent acts. It reads the changes and commits them to a
     * still copy (a pause of about a second), so the session can go on while
     * `save(outDir)` writes `<label>.tar` and `<label>.json` from that copy.
     * The image the task starts FROM plus this tar (minus the deletions) is
     * the turn's starting environment. Call save() or discard() once.
     *
     * With `timeoutMs`, a freeze that takes longer (a very large install to
     * commit) stops holding the prompt: it rejects, finishes on its own and
     * is dropped, and that turn has no snapshot.
     */
    const freeze = async (label, { timeoutMs = 0 } = {}) => {
      const name = slug(label);
      const tag = `omnirush-snapshot:${slug(`${container}-${name}`)}`;
      const work = (async () => {
        const entries = await changes();
        const keep = entries.filter((entry) => entry.kind !== "D").map((entry) => entry.path);
        if (!keep.length) return { entries, keep, frozen: null };
        const committed = await call(["commit", "--pause=true", "--change", `LABEL ${LABEL}=snapshot`, container, tag], { timeoutMs: 5 * 60_000 });
        if (committed.code !== 0) throw new SandboxError(`Could not freeze the sandbox: ${firstLine(committed.stderr)}`, "docker");
        return { entries, keep, frozen: tag };
      })();
      let timer;
      const late = timeoutMs > 0 ? new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }) : null;
      const done = late ? await Promise.race([work, late]).finally(() => clearTimeout(timer)) : await work;
      if (!done) {
        void work.then(({ frozen: leftover }) => leftover && call(["rmi", "-f", leftover], { timeoutMs: 60_000 }), () => undefined);
        throw new SandboxError(`The ${name} snapshot took longer than ${timeoutMs} ms; the turn goes on without one.`, "docker");
      }
      const { entries, keep, frozen } = done;
      const release = () => (frozen ? call(["rmi", "-f", frozen], { timeoutMs: 60_000 }).then(() => undefined, () => undefined) : Promise.resolve());
      let settled = null;
      return {
        label: name,
        changed: entries.length,
        save: (outDir) => {
          settled ??= (async () => {
            const summary = {
              schema: SANDBOX_SCHEMA,
              label: name,
              image: manifest.image,
              changed: entries.length,
              added: entries.filter((entry) => entry.kind === "A").length,
              modified: entries.filter((entry) => entry.kind === "C").length,
              deleted: entries.filter((entry) => entry.kind === "D").map((entry) => entry.path),
              tar: null,
              bytes: 0,
              sha256: null,
            };
            mkdirSync(outDir, { recursive: true });
            // The folder describes itself: the record of the sandbox its snapshots came from.
            const recordFile = path.join(outDir, "record.json");
            if (!existsSync(recordFile)) writeFileSync(recordFile, `${JSON.stringify(manifest, null, 2)}\n`);
            try {
              if (frozen) {
                const file = path.join(outDir, `${name}.tar`);
                const { bytes, sha256 } = await exportPaths(frozen, keep, file);
                Object.assign(summary, { tar: path.basename(file), bytes, sha256 });
              }
            } finally {
              await release();
            }
            writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify({ ...summary, paths: entries }, null, 2)}\n`);
            return summary;
          })();
          return settled;
        },
        discard: () => {
          settled ??= release().then(() => null);
          return settled;
        },
      };
    };

    /** freeze(label), then save(outDir): one turn's snapshot, start to finish. */
    const snapshot = async ({ label, outDir }) => (await freeze(label)).save(outDir);

    return {
      command: docker,
      args: dockerArgs,
      env: { ...dockerEnv, ...passed },
      container,
      network,
      port: port || null,
      manifest,
      mapUrl: mapEngineUrl,
      changes,
      freeze,
      snapshot,
      dispose,
      skippedWorkspaces: skipped,
    };
  }

  /** tar of `paths` (no recursion: `docker diff` lists every path) out of an image. */
  function exportPaths(image, paths, file) {
    const child = spawnImpl(docker, ["run", "--rm", "-i", "--network", "none", "--user", "0", "--entrypoint", "tar", image, "--create", "--file=-", "--numeric-owner", "--no-recursion", "--files-from=-"], { env: dockerEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const hash = createHash("sha256");
    const out = createWriteStream(file);
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const written = new Promise((resolve, reject) => {
      out.once("finish", resolve);
      out.once("error", reject);
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdout.pipe(out);
    child.stdin.end(`${paths.join("\n")}\n`);
    return Promise.all([exited, written]).then(([code]) => {
      // tar exits 1 when a file changed while it was read; the frozen copy makes that rare.
      if (code !== 0 && code !== 1) throw new SandboxError(`Could not export the sandbox snapshot: ${firstLine(stderr)}`, "docker");
      return { bytes, sha256: hash.digest("hex") };
    });
  }

  return { inspect, networkMode, relayMode, resolveImage, ensureEngine, reapOrphans, prepareEngine };
}

/**
 * The one call an app makes. The sandbox's own settings (OMNIRUSH_SANDBOX_*)
 * are read from the engine's environment, like OMNIRUSH_SANDBOX itself.
 */
export function prepareSandboxedEngine(input) {
  return createSandbox({ env: input.env, ...(input.sandbox ?? {}) }).prepareEngine(input);
}
