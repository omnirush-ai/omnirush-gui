import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { startEngineFacade } from "./engine2/facade.js";
import { prepareEngine2Launch, resolveEngineIdentity, type EngineDialect } from "./engine2/launch.js";

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
  const child: ChildProcess = spawn(command, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const processLifecycle = createManagedProcessClose(child);
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
    await processLifecycle.close();
    throw error;
  }
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
      mcpAllowed: launch.env.OMNIRUSH_MCP_POLICY?.trim().toLowerCase() === "harbor-local"
        && Boolean(launch.env.OMNIRUSH_HARBOR_TASK_ID?.trim())
        && launch.env.OMNIRUSH_SANDBOX_BACKEND?.trim().toLowerCase() === "docker",
      log: (message, attributes) => console.warn(`[engine-adapter] ${message}`, attributes ? JSON.stringify(attributes) : ""),
    });
  } catch (error) {
    await processLifecycle.close();
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
    execution: { command, args, cwd: options.cwd, env: injectedEnv },
    isAlive: processLifecycle.isAlive,
    close: async () => {
      await facade.close().catch(() => undefined);
      await processLifecycle.close();
    },
    refreshConfig: facade.refreshConfig,
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
  const child: ChildProcess = spawn(options.bin?.trim() || "opencode", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLifecycle = createManagedProcessClose(child);

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
    await processLifecycle.close();
    throw error;
  }

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
    },
    isAlive: processLifecycle.isAlive,
    close: processLifecycle.close,
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
