// #22 On-the-fly tools (npx, pnpm dlx, yarn dlx, bunx, uvx, pipx run,
// go run pkg@version, deno run npm:/jsr:): the package and the version that
// actually ran. npx and bunx run a local copy first: the executable in the
// nearest node_modules/.bin (walking up from the command's folder, as npx
// does) is followed to the package that owns it (`local`). Otherwise an
// exact requested version is taken as is, else the runner's cache entry
// is read (npx: the _npx/<hash> folder of the exact specs asked for; pnpm's
// dlx cache, bun's install cache, uv's cache and tool environments, pipx's
// run cache, the go module cache, deno's npm cache). The registry is never
// asked: what can't be found is `unresolved`. A version line the command
// printed is kept apart as `output_version`.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type EphemeralTool = {
  tool_call_id: string | null;
  runner: string;
  package: string;
  /** The executable asked for (`tsc` in `npx -p typescript tsc`). */
  bin: string | null;
  requested: string | null;
  version: string | null;
  resolved: "exact" | "local" | "cache" | "unresolved";
  source: "spec" | "local" | "npx_cache" | "pnpm_cache" | "bun_cache" | "uv_cache" | "pipx_venv" | "go_modcache" | "deno_cache" | "unresolved";
  /** A `<name> <semver>` / `v<semver>` line at the start of the command's output. */
  output_version: string | null;
};

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const PY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SCAN_DIRS = 2_000;

export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "_");
}

/** The ecosystem of a runner. */
export function ecosystemOf(runner: string): "npm" | "pypi" | "go" | "deno" {
  if (runner === "uvx" || runner === "pipx run" || runner === "uv tool" || runner === "pipx") return "pypi";
  if (runner === "go run") return "go";
  if (runner === "deno run") return "deno";
  return "npm";
}

async function newestFirst(dirs: string[]): Promise<string[]> {
  const stamped = await Promise.all(dirs.map(async (dir) => ({ dir, at: await stat(dir).then((s) => s.mtimeMs, () => 0) })));
  return stamped.sort((a, b) => b.at - a.at).map((entry) => entry.dir);
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).slice(0, MAX_SCAN_DIRS).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function packageVersion(manifest: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export type CacheDirs = {
  home: string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
};

function npmCache({ home, platform, env }: CacheDirs): string | null {
  if (env.npm_config_cache) return env.npm_config_cache;
  if (platform === "win32") return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "npm-cache") : null;
  return home ? join(home, ".npm") : null;
}

function cacheHome({ home, platform, env }: CacheDirs): string | null {
  if (env.XDG_CACHE_HOME) return env.XDG_CACHE_HOME;
  if (platform === "darwin") return home ? join(home, "Library", "Caches") : null;
  if (platform === "win32") return env.LOCALAPPDATA ?? null;
  return home ? join(home, ".cache") : null;
}

/** npx installs the specs it was given into _npx/<first 16 hex of sha512(sorted specs joined by newlines)> (libnpmexec). */
export function npxCacheDir(specs: string[]): string {
  return createHash("sha512").update([...specs].sort((a, b) => a.localeCompare(b, "en")).join("\n")).digest("hex").slice(0, 16);
}

/** The version of `pkg` in the npx cache entry of exactly these specs. */
export async function npxCacheVersion(pkg: string, specs: string[], dirs: CacheDirs): Promise<string | null> {
  const cache = npmCache(dirs);
  return cache ? packageVersion(join(cache, "_npx", npxCacheDir(specs), "node_modules", pkg, "package.json")) : null;
}

async function readSmall(path: string): Promise<string | null> {
  try {
    return (await stat(path)).size <= 64 * 1024 ? await readFile(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * The package owning `bin` in the nearest node_modules/.bin above `cwd` (npm/yarn/bun symlinks,
 * pnpm sh shims, Windows .cmd shims): its name and version from its own package.json.
 */
export async function localBin(bin: string, cwd: string, platform: NodeJS.Platform): Promise<{ package: string; version: string } | null> {
  const names = platform === "win32" ? [`${bin}.cmd`, bin] : [bin];
  for (let dir = resolve(cwd), depth = 0; depth < 64; dir = dirname(dir), depth += 1) {
    const binDir = join(dir, "node_modules", ".bin");
    for (const name of names) {
      const link = join(binDir, name);
      const info = await lstat(link).catch(() => null);
      if (!info) continue;
      let target = info.isSymbolicLink() ? await realpath(link).catch(() => link) : link;
      if (!info.isSymbolicLink()) {
        // A shim: `"%dp0%\\..\\typescript\\bin\\tsc"` (cmd), `"$basedir/../typescript/bin/tsc"` (sh).
        const rel = /(?:%~?dp0%?|\$basedir)[\\/]+(\.\.[\\/][^"'%*\s]+)/.exec((await readSmall(link)) ?? "")?.[1];
        if (rel) target = await realpath(resolve(binDir, rel.replace(/[\\/]/g, sep))).catch(() => resolve(binDir, rel.replace(/[\\/]/g, sep)));
      }
      // The last node_modules/<pkg> of the target (greedy; `.bin`, `.pnpm` never match a name).
      const match = /^(.*[\\/]node_modules[\\/])((?:@[^\\/]+[\\/])?[^.\\/@][^\\/]*)[\\/]/.exec(target);
      if (!match) continue;
      const manifest = await readSmall(join(match[1]!, match[2]!, "package.json"));
      try {
        const parsed = JSON.parse(manifest ?? "") as { name?: unknown; version?: unknown };
        if (typeof parsed.name === "string" && typeof parsed.version === "string") return { package: parsed.name, version: parsed.version };
      } catch {
        // not a package: keep looking further up
      }
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

/** A version the command printed first: `webpack 5.11.0`, `webpack: 5.11.0`, `v3.2.7` or a bare `3.3.3` among its first 3 lines. */
export function outputVersion(output: string | null | undefined, names: string[]): string | null {
  if (!output) return null;
  const wanted = new Set(names.filter(Boolean).map((name) => name.toLowerCase()));
  const lines = output.slice(0, 4096).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3);
  for (const line of lines) {
    const match = /^(?:([@\w./-]+):?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)$/.exec(line);
    if (match && (!match[1] || wanted.has(match[1].toLowerCase()) || wanted.has(match[1].replace(/^@[^/]+\//, "").toLowerCase()))) return match[2]!;
  }
  return null;
}

/** pnpm dlx: <cache>/pnpm/dlx/<hash>/<stamp>/node_modules/<pkg>/package.json (and the older flat layout). */
export async function pnpmDlxVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const bases = [cacheHome(dirs) ? join(cacheHome(dirs)!, "pnpm", "dlx") : null, dirs.platform === "win32" && dirs.env.LOCALAPPDATA ? join(dirs.env.LOCALAPPDATA, "pnpm-cache", "dlx") : null].filter(Boolean) as string[];
  for (const base of bases) {
    for (const hash of await newestFirst(await listDirs(base))) {
      const direct = await packageVersion(join(hash, "node_modules", pkg, "package.json"));
      if (direct) return direct;
      for (const stamp of await newestFirst(await listDirs(hash))) {
        const version = await packageVersion(join(stamp, "node_modules", pkg, "package.json"));
        if (version) return version;
      }
    }
  }
  return null;
}

/** bunx: ~/.bun/install/cache/<pkg>@<version>@@@1 folders. */
export async function bunCacheVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const base = dirs.env.BUN_INSTALL_CACHE_DIR ?? (dirs.home ? join(dirs.home, ".bun", "install", "cache") : null);
  if (!base) return null;
  const scoped = pkg.startsWith("@") ? pkg.split("/") : null;
  const dir = scoped ? join(base, scoped[0]!) : base;
  const prefix = `${scoped ? scoped[1] : pkg}@`;
  const candidates = (await listDirs(dir)).filter((path) => path.split(/[\\/]/).at(-1)!.startsWith(prefix));
  for (const entry of await newestFirst(candidates)) {
    const match = /@(\d[^@]*)@@@/.exec(entry.split(/[\\/]/).at(-1)!);
    if (match) return match[1]!;
  }
  return null;
}

/** A `<name>-<version>.dist-info` folder for the package, searched breadth-first under `base` (bounded). */
async function distInfoVersion(base: string, pkg: string, maxDepth: number): Promise<string | null> {
  const wanted = normalizePyName(pkg);
  let level = [base];
  let visited = 0;
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    const found: string[] = [];
    for (const dir of level) {
      if (visited++ > MAX_SCAN_DIRS) return null;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = /^(.+)-([^-]+)\.dist-info$/.exec(entry.name);
        if (match && normalizePyName(match[1]!) === wanted) found.push(join(dir, entry.name));
        else if (!entry.name.endsWith(".dist-info") && entry.name !== "__pycache__") next.push(join(dir, entry.name));
      }
    }
    if (found.length > 0) {
      const newest = (await newestFirst(found))[0]!;
      return /-([^-]+)\.dist-info$/.exec(newest)![1]!;
    }
    level = next;
  }
  return null;
}

/** uvx: uv's tool environments, then its archive cache. */
export async function uvVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const data = dirs.env.UV_TOOL_DIR ?? (dirs.platform === "win32" ? (dirs.env.APPDATA ? join(dirs.env.APPDATA, "uv", "tools") : null) : dirs.home ? join(dirs.env.XDG_DATA_HOME ?? join(dirs.home, ".local", "share"), "uv", "tools") : null);
  if (data) {
    const version = await distInfoVersion(join(data, pkg), pkg, 5);
    if (version) return version;
  }
  const cache = dirs.env.UV_CACHE_DIR ?? (dirs.platform === "win32" ? (dirs.env.LOCALAPPDATA ? join(dirs.env.LOCALAPPDATA, "uv", "cache") : null) : dirs.home ? join(dirs.env.XDG_CACHE_HOME ?? join(dirs.home, ".cache"), "uv") : null);
  if (!cache) return null;
  // archive-v0/<hash>/lib/python3.x/site-packages/<pkg>-<v>.dist-info (Windows: Lib/site-packages).
  for (const archive of (await listDirs(cache)).filter((dir) => /archive-v\d+$/.test(dir))) {
    for (const entry of (await newestFirst(await listDirs(archive))).slice(0, 200)) {
      const version = await distInfoVersion(entry, pkg, 4);
      if (version) return version;
    }
  }
  return null;
}

/** pipx run: <pipx home>/.cache/<hash>/ venvs. */
export async function pipxVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const homes = [dirs.env.PIPX_HOME, dirs.home ? join(dirs.home, ".local", "pipx") : null, dirs.home ? join(dirs.env.XDG_DATA_HOME ?? join(dirs.home, ".local", "share"), "pipx") : null].filter(Boolean) as string[];
  for (const home of homes) {
    for (const venv of await newestFirst(await listDirs(join(home, ".cache")))) {
      const version = await distInfoVersion(venv, pkg, 5);
      if (version) return version;
    }
    const installed = await distInfoVersion(join(home, "venvs", pkg), pkg, 5);
    if (installed) return installed;
  }
  return null;
}

/** go run pkg@latest: the newest version the module cache downloaded for the module or one of its parents. */
export async function goModVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const modcache = dirs.env.GOMODCACHE ?? (dirs.env.GOPATH ? join(dirs.env.GOPATH.split(dirs.platform === "win32" ? ";" : ":")[0]!, "pkg", "mod") : dirs.home ? join(dirs.home, "go", "pkg", "mod") : null);
  if (!modcache) return null;
  const parts = pkg.split("/");
  for (let n = parts.length; n >= 2; n -= 1) {
    // Upper-case letters are escaped as !lower in the module cache.
    const module = parts.slice(0, n).join("/").replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
    const dir = join(modcache, "cache", "download", ...module.split("/"), "@v");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".info"));
    } catch {
      continue;
    }
    const newest = await newestFirst(names.map((name) => join(dir, name)));
    if (newest[0]) return newest[0].split(/[\\/]/).at(-1)!.replace(/\.info$/, "");
  }
  return null;
}

/** deno run npm:pkg: <DENO_DIR>/npm/registry.npmjs.org/<pkg>/<version>. */
export async function denoNpmVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const denoDir = dirs.env.DENO_DIR ?? (cacheHome(dirs) ? join(cacheHome(dirs)!, "deno") : null);
  if (!denoDir || pkg.startsWith("jsr:")) return null;
  const newest = await newestFirst(await listDirs(join(denoDir, "npm", "registry.npmjs.org", ...pkg.split("/"))));
  return newest[0] ? newest[0].split(/[\\/]/).at(-1)! : null;
}

export type ResolveEphemeralOptions = Partial<CacheDirs>;

/** The version of one on-the-fly tool run (see the module comment). */
export async function resolveEphemeral(
  call: { tool_call_id: string | null; runner: string; package: string; requested: string | null; bin?: string | null; specs?: string[]; cwd?: string | null; output?: string | null },
  options: ResolveEphemeralOptions = {},
): Promise<EphemeralTool> {
  const dirs: CacheDirs = { home: options.home ?? null, platform: options.platform ?? process.platform, env: options.env ?? process.env };
  const bin = call.bin ?? null;
  const base = { tool_call_id: call.tool_call_id, runner: call.runner, package: call.package, bin, requested: call.requested, output_version: outputVersion(call.output, [bin ?? "", call.package]) };
  const unresolved = { ...base, version: null, resolved: "unresolved", source: "unresolved" } as const;
  const ecosystem = ecosystemOf(call.runner);
  const validName = ecosystem === "pypi" ? PY_NAME.test(call.package) : ecosystem === "go" ? /^[\w.~/-]+$/.test(call.package) : NPM_NAME.test(call.package.replace(/^jsr:/, ""));
  if (!validName) return unresolved;
  // npx/bunx run the local copy when the project has the executable (and it is the version asked for, if any).
  if ((call.runner === "npx" || call.runner === "bunx") && bin && call.cwd && /^[\w@.~-][\w.~-]*$/.test(bin)) {
    const local = await localBin(bin, call.cwd, dirs.platform).catch(() => null);
    // `npx tsc`: whatever owns the bin; `npx -p typescript tsc`, `npx @scope/tool`: only that package.
    if (local && (bin === call.package || local.package === call.package) && (!call.requested || call.requested.replace(/^v/, "") === local.version)) {
      return { ...base, package: local.package, version: local.version, resolved: "local", source: "local" };
    }
  }
  if (call.requested && EXACT.test(call.requested)) return { ...base, version: call.requested.replace(/^v(?=\d)/, ecosystem === "go" ? "v" : ""), resolved: "exact", source: "spec" };
  let version: string | null = null;
  let source: EphemeralTool["source"] = "unresolved";
  const attempt = async (value: Promise<string | null>, from: EphemeralTool["source"]) => {
    if (version) return;
    version = await value.catch(() => null);
    if (version) source = from;
  };
  if (call.runner === "npx") await attempt(npxCacheVersion(call.package, call.specs?.length ? call.specs : [call.requested ? `${call.package}@${call.requested}` : call.package], dirs), "npx_cache");
  else if (call.runner === "pnpm dlx") await attempt(pnpmDlxVersion(call.package, dirs), "pnpm_cache");
  else if (call.runner === "bunx") await attempt(bunCacheVersion(call.package, dirs), "bun_cache");
  else if (ecosystem === "pypi") {
    if (call.runner === "pipx run") await attempt(pipxVersion(call.package, dirs), "pipx_venv");
    await attempt(uvVersion(call.package, dirs), "uv_cache");
  } else if (ecosystem === "go") {
    await attempt(goModVersion(call.package, dirs), "go_modcache");
  } else if (ecosystem === "deno") {
    await attempt(denoNpmVersion(call.package, dirs), "deno_cache");
  }
  return version ? { ...base, version, resolved: "cache", source } : unresolved;
}
