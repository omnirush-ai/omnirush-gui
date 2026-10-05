/**
 * Launch-time glue for the 2.x engine: which dialect a binary speaks, and the
 * config directory, plugin shim and environment a 2.x engine is started with.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { omnirushPluginPath } from "../omnirush-extensions-plugin-path.js";
import { buildEngine2Config } from "./config.js";
import { isRecord, type JsonRecord } from "./util.js";

export type EngineDialect = "v1" | "v2";
export type EngineIdentity = { dialect: EngineDialect; version: string | null };

const identityCache = new Map<string, EngineIdentity>();

function readHead(path: string, length: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function dialectOfVersion(version: string | null | undefined): EngineDialect {
  const major = Number(String(version ?? "").trim().replace(/^opencode\s+/i, "").replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 2 ? "v2" : "v1";
}

function parseVersion(output: string): string | null {
  const match = output.trim().match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/);
  return match ? match[1]! : null;
}

async function probeVersion(bin: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      done(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", () => done(null));
    child.once("close", (code) => done(code === 0 ? parseVersion(output) : null));
  });
}

/**
 * The engine API a binary speaks. OMNIRUSH_ENGINE_DIALECT overrides; a script
 * (a test stand-in) is 1.x; otherwise the sidecar's versions.json or the
 * binary's `--version` decides (major 2 and up is the 2.x API).
 */
export async function resolveEngineIdentity(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<EngineIdentity> {
  const forced = env.OMNIRUSH_ENGINE_DIALECT?.trim();
  if (forced === "v1" || forced === "v2") return { dialect: forced, version: null };
  const path = bin.trim() || "opencode";
  let key = path;
  try {
    const stat = statSync(path);
    key = `${path}:${stat.size}:${stat.mtimeMs}`;
    if (readHead(path, 2) === "#!") return { dialect: "v1", version: null };
  } catch {
    // A bare command name resolved through PATH: probe it.
  }
  const cached = identityCache.get(key);
  if (cached) return cached;
  let version: string | null = null;
  const versionsFile = join(dirname(path), "versions.json");
  if (existsSync(versionsFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(versionsFile, "utf8"));
      const recorded = isRecord(parsed) && isRecord(parsed.opencode) && typeof parsed.opencode.version === "string" ? parsed.opencode.version : null;
      if (recorded) version = recorded.replace(/^v/, "");
    } catch {
      version = null;
    }
  }
  version ??= await probeVersion(path, 15_000);
  const identity: EngineIdentity = { dialect: dialectOfVersion(version), version };
  identityCache.set(key, identity);
  return identity;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export type Engine2Launch = {
  configFile: string;
  v1ConfigPath: string | undefined;
  /** Plugin directories named in the rendered config. */
  plugins: string[];
  /** Environment for the engine process (OPENCODE_CONFIG names the rendered 2.x config). */
  env: NodeJS.ProcessEnv;
  writeEngineConfig: (config: JsonRecord) => Promise<void>;
};

/**
 * Prepares a 2.x engine start: renders the 1.x runtime config (OPENCODE_CONFIG)
 * into a 2.x config file beside it, places the plugin directory that loads
 * OmniRush.ai's plugin bridge, and returns the engine environment. The user's
 * global opencode config directory stays in effect, as with 1.x.
 */
export async function prepareEngine2Launch(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  password: string;
  adapterUrl: string;
  adapterAuthorization: string;
  pluginPath?: string;
}): Promise<Engine2Launch> {
  const v1ConfigPath = input.env.OPENCODE_CONFIG?.trim() || undefined;
  const root = input.env.OMNIRUSH_ENGINE2_CONFIG_DIR?.trim()
    || (v1ConfigPath ? join(dirname(v1ConfigPath), "engine2") : join(tmpdir(), `omnirush-engine2-${process.pid}`));
  const configFile = join(root, "opencode.json");
  const plugins: string[] = [];
  const pluginPath = input.pluginPath ?? omnirushPluginPath("omnirush-engine2");
  // OMNIRUSH_ENGINE_PLUGINS=0 starts the engine without OmniRush.ai's plugins (engine-level tests).
  if (input.env.OMNIRUSH_ENGINE_PLUGINS !== "0" && existsSync(pluginPath)) {
    const pluginDir = join(root, "omnirush-plugin");
    await writeAtomic(
      join(pluginDir, "index.js"),
      `// Generated by OmniRush.ai: loads the plugin bridge for the bundled engine.\nexport { default } from ${JSON.stringify(pathToFileURL(pluginPath).href)};\n`,
    );
    plugins.push(pluginDir);
  }
  const writeEngineConfig = (config: JsonRecord) => writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`);
  let v1: JsonRecord = {};
  if (v1ConfigPath) {
    try {
      const parsed: unknown = JSON.parse(await readFile(v1ConfigPath, "utf8"));
      if (isRecord(parsed)) v1 = parsed;
    } catch {
      v1 = {};
    }
  }
  await writeEngineConfig(buildEngine2Config({ v1, plugins }));
  const env: NodeJS.ProcessEnv = { ...input.env };
  delete env.OPENCODE_CONFIG_CONTENT;
  env.OPENCODE_CONFIG = configFile;
  env.OPENCODE_PASSWORD = input.password;
  env.OMNIRUSH_ENGINE_ADAPTER_URL = input.adapterUrl;
  env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION = input.adapterAuthorization;
  return { configFile, v1ConfigPath, plugins, env, writeEngineConfig };
}
