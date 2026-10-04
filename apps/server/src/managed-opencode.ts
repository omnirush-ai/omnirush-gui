import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { omnirushConfigDir } from "@omnirush/paths";
import constants from "../../../constants.json" with { type: "json" };
import { startEngineFacade } from "./engine2/facade.js";
import { prepareEngine2Launch, resolveEngineIdentity, type EngineDialect } from "./engine2/launch.js";
import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";
import { prepareSandboxedEngine, sandboxMode, type SandboxLaunch, type SandboxManifest } from "./vendor/sandbox/sandbox.js";

export type ManagedChildProcess = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
};

export type ManagedProcessCloseOptions = {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
};

/**
 * The OmniRush Docker sandbox an engine runs in (OMNIRUSH_SANDBOX=docker,
 * vendor/sandbox): its record, a captured session's `environment.sandbox`,
 * and the turn snapshots taken from it.
 */
export type ManagedOpencodeSandbox = Pick<SandboxLaunch, "manifest" | "changes" | "freeze" | "snapshot"> & {
  /** The sandbox's folder on this machine; turn snapshots go to <stateDir>/snapshots/<sessionId>/. */
  stateDir: string;
};

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  execution: OpencodeExecutionSnapshot;
  isAlive: () => boolean;
  close: () => Promise<void>;
  /**
   * Engines that re-read their config while running (the 2.x engine watches
   * its config file): re-renders that config from the runtime config file, so
   * a change reaches the engine without a restart. Absent on 1.x engines,
   * which only read their config when an instance is (re)built.
   */
  refreshConfig?: () => Promise<void>;
  /** Set when the engine runs in the OmniRush Docker sandbox instead of on this machine. */
  sandbox?: ManagedOpencodeSandbox;
};

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
  /** The sandbox's record when the engine runs in it (command and args stay the engine's own). */
  sandbox?: SandboxManifest;
};

export function createManagedProcessClose(
  child: ManagedChildProcess,
  options: ManagedProcessCloseOptions = {},
): { isAlive: () => boolean; close: () => Promise<void> } {
  let closePromise: Promise<void> | null = null;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) {
      resolve();
      return;
    }
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const didExit = await Promise.race([exitedPromise.then(() => true), timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return didExit;
  };
  const isAlive = () => !exited && child.exitCode === null && child.signalCode === null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (!isAlive()) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Re-check through the exit event before escalating.
      }
      if (await waitForExit(options.termTimeoutMs ?? 1_000)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Re-check below; kill can race a natural exit.
      }
      if (!await waitForExit(options.killTimeoutMs ?? 500)) {
        throw new Error("Managed OmniRush process did not exit after SIGKILL");
      }
    })();
    return closePromise;
  };
  return { isAlive, close };
}

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePortOnce(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

async function findFreePort(hostname: string, excludedPorts: number[] = []): Promise<number> {
  const excluded = new Set(
    excludedPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePortOnce(hostname);
    if (!excluded.has(port)) return port;
  }
  throw new Error("Failed to resolve free port outside the excluded set");
}

type ManagedOpencodeServerOptions = {
  bin?: string;
  /**
   * The engine API the binary speaks. Unset: resolved from the binary
   * (engine2/launch.ts). A 2.x engine is started behind the 1.x engine
   * adapter (engine2/facade.ts), whose URL and credentials are returned.
   */
  dialect?: EngineDialect;
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /**
   * With OMNIRUSH_SANDBOX=docker: the folders a sandboxed engine works in,
   * mounted read-write at their own paths (every local workspace). Default: [cwd].
   */
  sandboxWorkspaces?: string[];
};

class ManagedOpencodeExitError extends Error {
  readonly exitCode: number | null;

  constructor(exitCode: number | null, output: string) {
    super(`OmniRush server exited with code ${exitCode}${output.trim() ? `\n${output}` : ""}`);
    this.exitCode = exitCode;
  }
}

function isRetryableAddressInUseExit(error: unknown): boolean {
  return error instanceof ManagedOpencodeExitError &&
    error.exitCode === 1 &&
    /\bEADDRINUSE\b/.test(error.message);
}

function redactedEnv(entries: Record<string, string | undefined>): OpencodeExecutionEnvEntry[] {
  return Object.entries(entries)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
      redacted: SECRET_ENV_PATTERN.test(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The 2.x engine's Linux builds, for a sandbox that cannot run this machine's binary. */
const SANDBOX_ENGINE_NPM = {
  packages: { "linux/amd64": "@opencode/cli-linux-x64-baseline", "linux/arm64": "@opencode/cli-linux-arm64" },
  bin: "bin/opencode",
};

type SandboxedEngine = { launch: SandboxLaunch; sandbox: ManagedOpencodeSandbox };

/**
 * OMNIRUSH_SANDBOX=docker: the engine runs in the OmniRush Docker sandbox
 * (vendor/sandbox, shared with the CLI) instead of on this machine, so a
 * captured session's environment is an image digest plus what the session
 * changed in it. Null when the sandbox is off. Its errors (SandboxError) are
 * thrown: the engine is never started on this machine instead.
 */
async function prepareSandbox(options: ManagedOpencodeServerOptions, engine: {
  command: string;
  args: string[];
  /** The environment the engine would have been started with. */
  env: NodeJS.ProcessEnv;
  /** The names this server sets for the engine: passed by name, never on a command line. */
  passEnv: string[];
  dialect: EngineDialect;
  version: string | null;
  /** Host folders the engine reads by absolute path besides its config file's (mounted read-only). */
  mounts: string[];
}): Promise<SandboxedEngine | null> {
  const env = { ...process.env, ...options.env };
  if (sandboxMode(env) !== "docker") return null;
  // The app's data folder: the one the runtime config file is in.
  const stateDir = env.OMNIRUSH_SANDBOX_STATE_DIR?.trim()
    || join(env.OPENCODE_CONFIG ? dirname(env.OPENCODE_CONFIG) : omnirushConfigDir(), "sandbox");
  // OmniRush.ai's engine plugins are loaded by absolute path: their folder, as named and as it really is.
  const plugin = omnirushPluginPath("omnirush-engine2");
  const launch = await prepareSandboxedEngine({
    command: engine.command,
    args: engine.args,
    cwd: options.cwd,
    env: engine.env,
    passEnv: engine.passEnv,
    workspaces: options.sandboxWorkspaces,
    mounts: [...engine.mounts, dirname(plugin), ...(existsSync(plugin) ? [dirname(realpathSync(plugin))] : [])].map((path) => ({ path })),
    stateDir,
    engine: {
      name: "opencode",
      version: engine.version ?? constants.opencodeVersion.trim().replace(/^v/, ""),
      ...(isAbsolute(engine.command) ? { hostPath: engine.command } : {}),
      // Only the 2.x engine's Linux builds are known: a 1.x engine runs from its own binary, on a Linux host.
      ...(engine.dialect === "v2" ? { npm: SANDBOX_ENGINE_NPM } : {}),
    },
    app: "desktop",
  });
  const { manifest, changes, freeze, snapshot } = launch;
  return { launch, sandbox: { manifest, changes, freeze, snapshot, stateDir } };
}

/** Per session, the last turn frozen; after a restart, the last one its snapshot folder holds. */
const sandboxTurns = new Map<string, number>();

function savedSandboxTurns(dir: string): number {
  try {
    return Math.max(0, ...readdirSync(dir).map((name) => Number(/^turn-(\d+)\.json$/.exec(name)?.[1] ?? 0)));
  } catch {
    return 0;
  }
}

/**
 * A sandboxed engine's turn snapshot (vendor/sandbox README, "Turn
 * snapshots"), taken when a session's prompt is sent, before the engine gets
 * it: the environment is frozen now (a pause of about a second) and saved in
 * the background to <stateDir>/snapshots/<sessionId>/turn-<n>.tar and .json,
 * n counting the session's prompts. Never rejects: a failure is logged and
 * the prompt goes on.
 */
/** How long a prompt waits for its turn's freeze; a slower one goes on without a snapshot. */
const SANDBOX_FREEZE_TIMEOUT_MS = 10_000;

export async function freezeSandboxTurn(
  sandbox: Pick<ManagedOpencodeSandbox, "freeze" | "stateDir">,
  sessionId: string,
  log: (message: string, attributes: Record<string, unknown>) => void,
): Promise<void> {
  // The session id names a folder: an engine id, never a path.
  if (!/^[\w-]{1,128}$/.test(sessionId)) return;
  const dir = join(sandbox.stateDir, "snapshots", sessionId);
  const turn = (sandboxTurns.get(sessionId) ?? savedSandboxTurns(dir)) + 1;
  sandboxTurns.set(sessionId, turn);
  const failed = (message: string) => (error: unknown) => log(message, {
    "session.id": sessionId,
    "sandbox.turn": turn,
    "error.message": error instanceof Error ? error.message : String(error),
  });
  try {
    const frozen = await sandbox.freeze(`turn-${turn}`, { timeoutMs: SANDBOX_FREEZE_TIMEOUT_MS });
    void frozen.save(dir).catch(failed("Sandbox turn snapshot could not be saved."));
  } catch (error) {
    failed("Sandbox turn could not be frozen.")(error);
  }
}

/**
 * Starts a 2.x engine on an ephemeral loopback port and the 1.x engine
 * adapter on `port`: callers get the adapter's URL and Basic credentials,
 * exactly as they got the 1.x engine's.
 */
async function startManagedEngine2Server(
  options: ManagedOpencodeServerOptions,
  hostname: string,
  port: number,
  version: string | null,
): Promise<ManagedOpencodeServer> {
  const username = randomSecret();
  const password = randomSecret();
  const enginePassword = randomSecret();
  const command = options.bin?.trim() || "opencode";
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"];
  const adapterUrl = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  const adapterAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const engineEnvDefaults = { npm_config_audit: "false" };
  const launch = await prepareEngine2Launch({
    env: { ...process.env, ...engineEnvDefaults, ...options.env },
    cwd: options.cwd,
    password: enginePassword,
    adapterUrl,
    adapterAuthorization,
  });
  const env: NodeJS.ProcessEnv = { ...launch.env };
  delete env.OMNIRUSH_ENCRYPTION_KEY;
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  const injectedEnv = redactedEnv({
    ...engineEnvDefaults,
    ...(options.env ?? {}),
    OPENCODE_CONFIG: launch.configFile,
    OPENCODE_PASSWORD: enginePassword,
    OMNIRUSH_ENGINE_ADAPTER_URL: adapterUrl,
    OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION: adapterAuthorization,
  });
  const sandboxed = await prepareSandbox(options, {
    command,
    args,
    env,
    passEnv: injectedEnv.map((entry) => entry.name),
    dialect: "v2",
    version,
    // The plugin bridge, and the runtime config's folder (the skills its config names).
    mounts: [...launch.plugins, ...(launch.v1ConfigPath ? [dirname(launch.v1ConfigPath)] : [])],
  });
  // In the sandbox: the Docker command that runs the same engine and arguments.
  const child: ChildProcess = spawn(sandboxed?.launch.command ?? command, sandboxed?.launch.args ?? args, { cwd: options.cwd, env: sandboxed?.launch.env ?? env, stdio: ["ignore", "pipe", "pipe"] });
  const processLifecycle = createManagedProcessClose(child);
  // A sandboxed engine's container is removed once its process is closed.
  const close = sandboxed ? () => processLifecycle.close().finally(() => sandboxed.launch.dispose()) : processLifecycle.close;
  const timeoutMs = Math.max(options.timeoutMs ?? 15_000, 90_000);
  let engineUrl: string;
  try {
    engineUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for OmniRush server after ${timeoutMs}ms`)), timeoutMs);
      let output = "";
      const done = (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      };
      const fail = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        for (const line of output.split("\n")) {
          const match = line.match(/server listening on\s+(https?:\/\/[^\s]+)/);
          if (match?.[1]) return done(match[1]);
        }
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.once("error", fail);
      child.once("close", (code) => fail(new ManagedOpencodeExitError(code, output)));
    });
  } catch (error) {
    await close();
    throw error;
  }
  if (sandboxed) engineUrl = sandboxed.launch.mapUrl(engineUrl);
  let facade: Awaited<ReturnType<typeof startEngineFacade>>;
  try {
    facade = await startEngineFacade({
      upstreamUrl: engineUrl,
      upstreamPassword: enginePassword,
      username,
      password,
      hostname,
      port,
      version: version ?? "2",
      defaultDirectory: options.cwd,
      v1ConfigPath: launch.v1ConfigPath,
      writeEngineConfig: launch.writeEngineConfig,
      plugins: launch.plugins,
      log: (message, attributes) => console.warn(`[engine-adapter] ${message}`, attributes ? JSON.stringify(attributes) : ""),
    });
  } catch (error) {
    await close();
    const message = error instanceof Error ? error.message : String(error);
    throw new ManagedOpencodeExitError(1, `engine adapter could not listen: ${message}`);
  }
  child.once("exit", () => {
    void facade.close().catch(() => undefined);
  });
  return {
    url: facade.url,
    username,
    password,
    pid: child.pid ?? null,
    execution: { command, args, cwd: options.cwd, env: injectedEnv, ...(sandboxed ? { sandbox: sandboxed.sandbox.manifest } : {}) },
    isAlive: processLifecycle.isAlive,
    close: async () => {
      await facade.close().catch(() => undefined);
      await close();
    },
    refreshConfig: facade.refreshConfig,
    ...(sandboxed ? { sandbox: sandboxed.sandbox } : {}),
  };
}

async function startManagedOpencodeServer(
  options: ManagedOpencodeServerOptions,
  hostname: string,
  port: number,
): Promise<ManagedOpencodeServer> {
  const identity = options.dialect
    ? { dialect: options.dialect, version: null }
    : await resolveEngineIdentity(options.bin?.trim() || "opencode", { ...process.env, ...options.env });
  if (identity.dialect === "v2") return startManagedEngine2Server(options, hostname, port, identity.version);
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const command = options.bin?.trim() || "opencode";
  // The engine's in-process npm installs use Arborist, which audits by default.
  // That audit POST depends on npm's advisories endpoint, which has been observed
  // to hang for the full five-minute registry timeout, so first-run must not wait.
  // @npmcli/config reads npm_config_* settings from the environment.
  const engineEnvDefaults = { npm_config_audit: "false" };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...engineEnvDefaults,
    ...options.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  // The managed engine needs its own provider environment, but never the key
  // that decrypts OmniRush.ai-owned OAuth credentials.
  delete env.OMNIRUSH_ENCRYPTION_KEY;
  const injectedEnv = Object.entries({
    ...engineEnvDefaults,
    ...(options.env ?? {}),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
      redacted: SECRET_ENV_PATTERN.test(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sandboxed = await prepareSandbox(options, {
    command,
    args,
    env,
    passEnv: injectedEnv.map((entry) => entry.name),
    dialect: "v1",
    version: identity.version,
    mounts: [],
  });
  // In the sandbox: the Docker command that runs the same engine and arguments.
  const child: ChildProcess = spawn(sandboxed?.launch.command ?? command, sandboxed?.launch.args ?? args, {
    cwd: options.cwd,
    env: sandboxed?.launch.env ?? env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLifecycle = createManagedProcessClose(child);
  // A sandboxed engine's container is removed once its process is closed.
  const close = sandboxed ? () => processLifecycle.close().finally(() => sandboxed.launch.dispose()) : processLifecycle.close;

  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for OmniRush server after ${options.timeoutMs ?? 15000}ms`)), options.timeoutMs ?? 15000);
      let output = "";
      const done = (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      };
      const fail = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        for (const line of output.split("\n")) {
          if (!line.startsWith("opencode server listening")) continue;
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match?.[1]) return fail(new Error(`Failed to parse OmniRush server URL from: ${line}`));
          done(match[1]);
        }
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.once("error", fail);
      // ChildProcess can emit "exit" before its stdio pipes have drained. Wait
      // for "close" so retry classification includes every diagnostic line.
      child.once("close", (code) => fail(new ManagedOpencodeExitError(code, output)));
    });
  } catch (error) {
    await close();
    throw error;
  }
  if (sandboxed) url = sandboxed.launch.mapUrl(url);

  return {
    url,
    username,
    password,
    pid: child.pid ?? null,
    execution: {
      command,
      args,
      cwd: options.cwd,
      env: injectedEnv,
      ...(sandboxed ? { sandbox: sandboxed.sandbox.manifest } : {}),
    },
    isAlive: processLifecycle.isAlive,
    close,
    ...(sandboxed ? { sandbox: sandboxed.sandbox } : {}),
  };
}

export async function createManagedOpencodeServer(options: ManagedOpencodeServerOptions): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  try {
    return await startManagedOpencodeServer(options, hostname, port);
  } catch (error) {
    // The automatic free-port probe is necessarily racy. Retry exactly once on
    // the one startup failure that a new port can safely fix; explicit ports
    // and all other code-1 exits remain actionable.
    if (options.port !== undefined || !isRetryableAddressInUseExit(error)) throw error;
    const retryPort = await findFreePort(hostname, [...(options.excludedPorts ?? []), port]);
    return startManagedOpencodeServer(options, hostname, retryPort);
  }
}
