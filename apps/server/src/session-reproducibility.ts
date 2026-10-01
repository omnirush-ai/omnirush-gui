import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";

const MAX_COMMAND_OUTPUT = 16 * 1024;
const MAX_PACKAGE_OUTPUT = 32 * 1024;
const MAX_LOCKFILES = 256;
const MAX_LOCKFILE_HASH_BYTES = 128 * 1024 * 1024;
const MAX_ENV_FILES = 32;
const MAX_ENV_KEYS = 512;
const MAX_ENV_FILE_BYTES = 256 * 1024;
const MAX_SOURCE_ENV_FILES = 100;
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 8;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".venv",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
]);
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "cargo.lock",
  "go.sum",
  "composer.lock",
  "gemfile.lock",
  "packages.lock.json",
]);
const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "pipfile",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "cmakelists.txt",
]);

export type ReproducibilityCommand = {
  command: string;
  version: string | null;
  available: boolean;
};

export type ReproducibilityLockfile = {
  path: string;
  bytes: number;
  sha256: string | null;
  binary: boolean;
  content_capture: "existing_archive_policy";
};

export type ReproducibilityManifest = {
  schema_version: 1;
  platform: {
    os: string;
    release: string;
    arch: string;
    distro: string | null;
    distro_version: string | null;
    wsl: boolean;
  };
  project_manifests: string[];
  runtimes: ReproducibilityCommand[];
  package_managers: ReproducibilityCommand[];
  lockfiles: ReproducibilityLockfile[];
  environment_variable_names: string[];
  system_packages: { manager: string; output: string; truncated: boolean }[];
  services: { manager: string; output: string; truncated: boolean }[];
  package_inventory: { manager: string; output: string; truncated: boolean }[];
  limitations: string[];
};

type CommandSpec = { command: string; args: string[]; marker: string[] };

const RUNTIMES: CommandSpec[] = [
  { command: "node", args: ["--version"], marker: ["package.json"] },
  { command: "python", args: ["--version"], marker: ["pyproject.toml", "requirements.txt", "pipfile"] },
  { command: "python3", args: ["--version"], marker: ["pyproject.toml", "requirements.txt", "pipfile"] },
  { command: "rustc", args: ["--version"], marker: ["cargo.toml"] },
  { command: "go", args: ["version"], marker: ["go.mod"] },
  { command: "java", args: ["-version"], marker: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { command: "dotnet", args: ["--version"], marker: ["dotnet"] },
  { command: "gcc", args: ["--version"], marker: ["cmakelists.txt"] },
  { command: "clang", args: ["--version"], marker: ["cmakelists.txt"] },
  { command: "cmake", args: ["--version"], marker: ["cmakelists.txt"] },
];

const PACKAGE_MANAGERS: CommandSpec[] = [
  { command: "npm", args: ["--version"], marker: ["package.json", "package-lock.json", "npm-shrinkwrap.json"] },
  { command: "pnpm", args: ["--version"], marker: ["package.json", "pnpm-lock.yaml"] },
  { command: "yarn", args: ["--version"], marker: ["package.json", "yarn.lock"] },
  { command: "bun", args: ["--version"], marker: ["package.json", "bun.lock", "bun.lockb"] },
  { command: "pip", args: ["--version"], marker: ["requirements.txt", "pyproject.toml", "pipfile"] },
  { command: "uv", args: ["--version"], marker: ["pyproject.toml", "uv.lock"] },
  { command: "poetry", args: ["--version"], marker: ["pyproject.toml", "poetry.lock"] },
  { command: "cargo", args: ["--version"], marker: ["cargo.toml", "cargo.lock"] },
  { command: "mvn", args: ["--version"], marker: ["pom.xml"] },
  { command: "gradle", args: ["--version"], marker: ["build.gradle", "build.gradle.kts"] },
];

function clipped(value: string, limit: number): { value: string; truncated: boolean } {
  const trimmed = value.trim();
  return trimmed.length > limit
    ? { value: trimmed.slice(0, limit), truncated: true }
    : { value: trimmed, truncated: false };
}

async function commandOutput(command: string, args: string[], timeout = 2_500): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: MAX_COMMAND_OUTPUT }, (error, stdout, stderr) => {
      const output = String(stdout || stderr || "").trim();
      resolve(error && !output ? null : output || null);
    });
  });
}

async function readDistro(): Promise<{ name: string | null; version: string | null }> {
  if (platform() !== "linux") return { name: null, version: null };
  try {
    const text = await readFile("/etc/os-release", "utf8");
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) continue;
      values.set(match[1], match[2].replace(/^"|"$/g, "").trim());
    }
    return { name: values.get("PRETTY_NAME") || values.get("NAME") || null, version: values.get("VERSION_ID") || null };
  } catch {
    return { name: null, version: null };
  }
}

async function isWsl(): Promise<boolean> {
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return true;
  if (platform() !== "linux") return false;
  try {
    const text = await readFile("/proc/version", "utf8");
    return /microsoft|wsl/i.test(text);
  } catch {
    return false;
  }
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_WALK_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_WALK_ENTRIES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) await visit(join(directory, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files.push(join(directory, entry.name));
      }
    }
  };
  await visit(root, 0);
  return files;
}

async function hashFile(path: string, bytes: number): Promise<string | null> {
  if (bytes > MAX_LOCKFILE_HASH_BYTES) return null;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function firstBytes(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of createReadStream(path, { start: 0, end: 4095 })) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return Buffer.alloc(0);
  }
  return Buffer.concat(chunks).subarray(0, 4096);
}

async function envKeys(path: string): Promise<string[]> {
  try {
    if ((await stat(path)).size > MAX_ENV_FILE_BYTES) return [];
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return match ? [match[1]] : [];
    });
  } catch {
    return [];
  }
}

async function sourceEnvKeys(path: string): Promise<string[]> {
  const extension = basename(path).toLowerCase().split(".").pop() ?? "";
  if (!(new Set(["c", "cc", "cpp", "cs", "go", "java", "js", "jsx", "mjs", "py", "rb", "rs", "ts", "tsx"])).has(extension)) return [];
  try {
    if ((await stat(path)).size > MAX_ENV_FILE_BYTES) return [];
    const text = await readFile(path, "utf8");
    const found = new Set<string>();
    const patterns = [
      /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
      /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
      /(?:os\.(?:getenv|environ\.get)|System\.getenv|Environment\.GetEnvironmentVariable|env::var)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) if (match[1]) found.add(match[1]);
    }
    return [...found];
  } catch {
    return [];
  }
}

async function commandEvidence(spec: CommandSpec, markers: Set<string>): Promise<ReproducibilityCommand | null> {
  if (!spec.marker.some((marker) => markers.has(marker))) return null;
  const version = await commandOutput(spec.command, spec.args);
  return { command: spec.command, version: version ? clipped(version, 256).value : null, available: version !== null };
}

async function packageEvidence(command: string, args: string[], manager: string): Promise<{ manager: string; output: string; truncated: boolean } | null> {
  const output = await commandOutput(command, args, 5_000);
  if (!output) return null;
  const clippedOutput = clipped(output, MAX_PACKAGE_OUTPUT);
  return { manager, output: clippedOutput.value, truncated: clippedOutput.truncated };
}

export async function collectReproducibility(root: string): Promise<ReproducibilityManifest> {
  const files = await walk(root);
  const names = new Set(files.map((path) => basename(path).toLowerCase()));
  const [distro, wsl] = await Promise.all([readDistro(), isWsl()]);
  const manifests = files
    .filter((path) => MANIFEST_NAMES.has(basename(path).toLowerCase()))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort()
    .slice(0, MAX_LOCKFILES);
  const lockfiles: ReproducibilityLockfile[] = [];
  for (const path of files) {
    if (lockfiles.length >= MAX_LOCKFILES || !LOCKFILE_NAMES.has(basename(path).toLowerCase())) continue;
    try {
      const info = await stat(path);
      const sample = await firstBytes(path);
      lockfiles.push({
        path: relative(root, path).split(sep).join("/"),
        bytes: info.size,
        sha256: await hashFile(path, info.size),
        binary: sample.includes(0),
        content_capture: "existing_archive_policy",
      });
    } catch {
      // A file that disappears during collection is covered by the next snapshot.
    }
  }
  const envPaths = files.filter((path) => /^\.env(?:\.|$)/i.test(basename(path))).slice(0, MAX_ENV_FILES);
  const sourcePaths = files.filter((path) => /\.(?:c|cc|cpp|cs|go|java|js|jsx|mjs|py|rb|rs|ts|tsx)$/i.test(path)).slice(0, MAX_SOURCE_ENV_FILES);
  const environmentVariableNames = [...new Set([
    ...(await Promise.all(envPaths.map(envKeys))).flat(),
    ...(await Promise.all(sourcePaths.map(sourceEnvKeys))).flat(),
  ])].sort().slice(0, MAX_ENV_KEYS);
  const markerSet = new Set([...names, ...manifests.map((path) => basename(path).toLowerCase())]);
  if (files.some((path) => /\.(?:csproj|sln)$/i.test(path))) markerSet.add("dotnet");
  const [runtimes, packageManagers] = await Promise.all([
    Promise.all(RUNTIMES.map((spec) => commandEvidence(spec, markerSet))).then((items) => items.filter((item): item is ReproducibilityCommand => item !== null)),
    Promise.all(PACKAGE_MANAGERS.map((spec) => commandEvidence(spec, markerSet))).then((items) => items.filter((item): item is ReproducibilityCommand => item !== null)),
  ]);
  const systemPackages: ReproducibilityManifest["system_packages"] = [];
  if (platform() === "linux") {
    const item = await packageEvidence("dpkg-query", ["-W", "-f=${binary:Package}\\t${Version}\\n"], "dpkg");
    if (item) systemPackages.push(item);
  } else if (platform() === "darwin") {
    const item = await packageEvidence("brew", ["list", "--versions"], "brew");
    if (item) systemPackages.push(item);
  } else if (platform() === "win32") {
    const item = await packageEvidence("winget", ["list", "--accept-source-agreements", "--disable-interactivity"], "winget");
    if (item) systemPackages.push(item);
  }
  const services: ReproducibilityManifest["services"] = [];
  const docker = await packageEvidence("docker", ["ps", "--format", "{{.Names}}\\t{{.Image}}"], "docker");
  if (docker) services.push(docker);
  const packageInventory: ReproducibilityManifest["package_inventory"] = [];
  if (lockfiles.length === 0) {
    if (names.has("package.json")) {
      const item = await packageEvidence("npm", ["ls", "--json", "--depth=0"], "npm");
      if (item) packageInventory.push(item);
    } else if (names.has("requirements.txt") || names.has("pyproject.toml")) {
      const item = await packageEvidence("python", ["-m", "pip", "freeze"], "pip");
      if (item) packageInventory.push(item);
    }
  }
  return {
    schema_version: 1,
    platform: { os: platform(), release: release(), arch: arch(), distro: distro.name, distro_version: distro.version, wsl },
    project_manifests: manifests,
    runtimes,
    package_managers: packageManagers,
    lockfiles,
    environment_variable_names: environmentVariableNames,
    system_packages: systemPackages,
    services,
    package_inventory: packageInventory,
    limitations: [
      "Lockfile bytes remain in the existing project archive; this manifest stores their path, size and hash.",
      "Personal credentials, environment values, git internals, build output and dependency directories are excluded by the existing capture policy.",
      "The first snapshot is queued by the existing session-start lifecycle; it is not a new synchronous pre-prompt upload.",
    ],
  };
}
