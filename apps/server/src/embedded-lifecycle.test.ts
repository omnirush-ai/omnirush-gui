import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";

import { startEmbeddedServer, type EmbeddedServerHandle, type EmbeddedServerOptions } from "./embedded.js";
import { readEngineRegistry } from "./engine-registry.js";
import * as managedOpencodeModule from "./managed-opencode.js";
import { OPENCODE_V2_PERMISSIONS_MESSAGE, OpencodeConfigCompatError } from "./opencode-config-compat.js";
import * as opencodeConfigCompatModule from "./opencode-config-compat.js";
import { writeOmniRushRuntimeConfigFile } from "./omnirush-runtime-config.js";
import { writeGlobalRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import * as serverModule from "./server.js";
import type { ServerConfig } from "./types.js";

const HOST = "127.0.0.1";
const SERVER_TOKEN = "server-token";
const HOST_TOKEN = "host-token";
const PROVIDER_ID = "lifecycle_anthropic";
const PROVIDER = { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] };
const ENV_NAMES: string[] = [
  "HOME",
  "OMNIRUSH_DEV_MODE",
  "OMNIRUSH_RUNTIME_DB",
  "OMNIRUSH_ENCRYPTION_KEY",
  "OMNIRUSH_OPENCODE_BASE_URL",
  "OMNIRUSH_LIFECYCLE_LOG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_MODELS_URL",
];

type Fixture = {
  root: string;
  opencodeBin: string;
  logPath: string;
  handles: EmbeddedServerHandle[];
  restore: () => Promise<void>;
};

function restoreProcessEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeFakeOpencodeBin(root: string): Promise<string> {
  const binPath = join(root, "fake-opencode.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "import { appendFileSync } from 'node:fs';",
    "const portIndex = process.argv.indexOf('--port');",
    "const requestedPort = Number(process.argv[portIndex + 1] ?? 0);",
    "const logPath = process.env.OMNIRUSH_LIFECYCLE_LOG;",
    "const append = (line) => { if (logPath) appendFileSync(logPath, `${line}\\n`); };",
    "append(`vault-key:${process.env.OMNIRUSH_ENCRYPTION_KEY ? 'present' : 'absent'}`);",
    "append(`server-url:${process.env.OMNIRUSH_SERVER_URL ?? ''}`);",
    "const server = Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: requestedPort,",
    "  fetch(request) { append(new URL(request.url).pathname); return Response.json({}); },",
    "});",
    "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
    "process.on('SIGTERM', () => { append('SIGTERM'); server.stop(true); process.exit(0); });",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

async function writeUnreadyOpencodeBin(root: string): Promise<string> {
  const binPath = join(root, "unready-opencode.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "import { appendFileSync } from 'node:fs';",
    "const logPath = process.env.OMNIRUSH_LIFECYCLE_LOG;",
    "process.on('SIGTERM', () => { if (logPath) appendFileSync(logPath, 'SIGTERM\\n'); process.exit(0); });",
    "if (logPath) appendFileSync(logPath, 'READY\\n');",
    "setInterval(() => undefined, 1000);",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-embedded-lifecycle-"));
  const previousEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  const logPath = join(root, "managed-opencode.log");
  const opencodeBin = await writeFakeOpencodeBin(root);
  const handles: EmbeddedServerHandle[] = [];

  process.env.HOME = join(root, "home");
  process.env.OMNIRUSH_DEV_MODE = "1";
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OMNIRUSH_LIFECYCLE_LOG = logPath;
  process.env.OPENCODE_MODELS_URL = "https://catalog.example.test/models";
  delete process.env.OMNIRUSH_OPENCODE_BASE_URL;

  return {
    root,
    opencodeBin,
    logPath,
    handles,
    async restore() {
      const errors: unknown[] = [];
      for (const handle of handles.reverse()) {
        try {
          await handle.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const name of ENV_NAMES) restoreProcessEnv(name, previousEnv.get(name));
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to clean up embedded lifecycle test");
      }
    },
  };
}

async function startManaged(fixture: Fixture, name: string): Promise<EmbeddedServerHandle> {
  const workspace = join(fixture.root, `${name}-workspace`);
  await mkdir(workspace, { recursive: true });
  const handle = await startEmbeddedServer({
    configPath: join(fixture.root, `${name}-server.json`),
    host: HOST,
    port: 0,
    token: SERVER_TOKEN,
    hostToken: HOST_TOKEN,
    workspaces: [workspace],
    manageOpencode: true,
    opencodeBin: fixture.opencodeBin,
    opencodeCwd: workspace,
  });
  fixture.handles.push(handle);
  return handle;
}

function managedOptions(fixture: Fixture, name: string): EmbeddedServerOptions {
  const workspace = join(fixture.root, `${name}-workspace`);
  return {
    configPath: join(fixture.root, `${name}-server.json`),
    host: HOST,
    port: 0,
    token: SERVER_TOKEN,
    hostToken: HOST_TOKEN,
    workspaces: [workspace],
    manageOpencode: true,
    opencodeBin: fixture.opencodeBin,
    opencodeCwd: workspace,
  };
}

function workspaceId(config: ServerConfig): string {
  const id = config.workspaces[0]?.id;
  if (!id) throw new Error("Expected an embedded workspace");
  return id;
}

// The injected file is rendered from the ENGINE_GLOBAL row only, so file
// barrier tests mutate the global row.
async function mutateGlobalRuntime(config: ServerConfig, label: string): Promise<void> {
  await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
    ...current,
    mcp: { [label]: { type: "remote", url: `https://${label}.example.test/mcp` } },
  }));
}

// Workspace rows never reach the injected file; used to witness inertness.
async function mutateWorkspace(config: ServerConfig, id: string, label: string): Promise<void> {
  await writeRuntimeOpencodeConfig(config, id, (current) => ({
    ...current,
    mcp: { [label]: { type: "remote", url: `https://${label}.example.test/mcp` } },
  }));
}

async function patchProviders(handle: EmbeddedServerHandle): Promise<Record<string, unknown>> {
  const response = await fetch(`${handle.url}/runtime-config/providers`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-omnirush-host-token": HOST_TOKEN,
    },
    body: JSON.stringify({ provider: { [PROVIDER_ID]: PROVIDER } }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error("Expected a runtime provider response");
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function logLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean);
}

describe("embedded server lifecycle", () => {
  test.serial("spawns the engine against the actually bound server port and records it in the registry", async () => {
    const fixture = await createFixture();
    // Occupy a port so serve-node's EADDRINUSE fallback rebinds to an
    // OS-assigned one: the engine env must follow the bound port, not the
    // requested one.
    const blocker = net.createServer();
    const blockedPort = await new Promise<number>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, HOST, () => {
        const address = blocker.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to bind blocker"));
      });
    });
    try {
      await mkdir(join(fixture.root, "bound-port-workspace"), { recursive: true });
      const handle = await startEmbeddedServer({
        ...managedOptions(fixture, "bound-port"),
        port: blockedPort,
      });
      fixture.handles.push(handle);

      expect(handle.port).not.toBe(blockedPort);
      expect(handle.config.port).toBe(handle.port);
      expect(await logLines(fixture.logPath)).toContain(`server-url:http://${HOST}:${handle.port}`);

      const entries = await readEngineRegistry(handle.config);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.role).toBe("primary");
      expect(entries[0]?.pid).toBe(handle.managedOpencode?.pid ?? -1);
      expect(entries[0]?.ownerPid).toBe(process.pid);

      await handle.stop();
      expect(await readEngineRegistry(handle.config)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await fixture.restore();
    }
  });

  test.serial("does not expose the vault encryption key to managed OpenCode", async () => {
    const fixture = await createFixture();
    process.env.OMNIRUSH_ENCRYPTION_KEY = "server-only-vault-key";
    let managed: Awaited<ReturnType<typeof managedOpencodeModule.createManagedOpencodeServer>> | null = null;
    try {
      managed = await managedOpencodeModule.createManagedOpencodeServer({
        bin: fixture.opencodeBin,
        cwd: fixture.root,
        env: { OMNIRUSH_LIFECYCLE_LOG: fixture.logPath },
      });
      expect(await logLines(fixture.logPath)).toContain("vault-key:absent");
    } finally {
      await managed?.close();
      await fixture.restore();
    }
  });

  test.serial("managed OpenCode readiness failure closes the spawned child", async () => {
    const fixture = await createFixture();
    try {
      const bin = await writeUnreadyOpencodeBin(fixture.root);
      await expect(managedOpencodeModule.createManagedOpencodeServer({
        bin,
        cwd: fixture.root,
        timeoutMs: 500,
        env: { OMNIRUSH_LIFECYCLE_LOG: fixture.logPath },
      })).rejects.toThrow("Timeout waiting for OpenCode server");
      expect(await logLines(fixture.logPath)).toContain("READY");
      expect((await logLines(fixture.logPath)).filter((line) => line === "SIGTERM")).toHaveLength(1);
    } finally {
      await fixture.restore();
    }
  });

  test.serial("a stopped server no longer writes generated runtime configuration", async () => {
    const fixture = await createFixture();
    try {
      const serverA = await startManaged(fixture, "server-a");
      await serverA.stop();

      await mutateGlobalRuntime(serverA.config, "stopped-server");
      const barrier = await writeOmniRushRuntimeConfigFile(serverA.config);

      // The explicit barrier is the first writer only when the stopped
      // server's subscription did not enqueue a write ahead of it.
      expect(barrier.changed).toBe(true);
    } finally {
      await fixture.restore();
    }
  });

  test.serial("only the replacement server responds to shared runtime database changes", async () => {
    const fixture = await createFixture();
    try {
      const serverA = await startManaged(fixture, "server-a");
      await serverA.stop();
      const serverB = await startManaged(fixture, "server-b");

      await mutateGlobalRuntime(serverA.config, "stale-server");
      const afterStoppedServerMutation = await writeOmniRushRuntimeConfigFile(serverB.config);
      expect(afterStoppedServerMutation.changed).toBe(false);

      await mutateGlobalRuntime(serverB.config, "active-server");
      const afterActiveServerMutation = await writeOmniRushRuntimeConfigFile(serverB.config);
      expect(afterActiveServerMutation.changed).toBe(false);
    } finally {
      await fixture.restore();
    }
  });

  test.serial("an identical provider update after replacement is inert", async () => {
    const fixture = await createFixture();
    try {
      const serverA = await startManaged(fixture, "server-a");
      const serverAWorkspace = workspaceId(serverA.config);
      await serverA.stop();
      const serverB = await startManaged(fixture, "server-b");

      const first = await patchProviders(serverB);
      expect(first).toMatchObject({ changed: true, reload: "reloaded" });
      const fileAfterFirstPatch = await readFile(join(fixture.root, "runtime-opencode-config.json"));
      const disposalsAfterFirstPatch = (await logLines(fixture.logPath)).filter((line) => line === "/instance/dispose").length;

      await mutateWorkspace(serverA.config, serverAWorkspace, "stale-server");
      const second = await patchProviders(serverB);

      expect(second).toMatchObject({ changed: false, reload: "skipped" });
      expect(await readFile(join(fixture.root, "runtime-opencode-config.json"))).toEqual(fileAfterFirstPatch);
      expect((await logLines(fixture.logPath)).filter((line) => line === "/instance/dispose")).toHaveLength(disposalsAfterFirstPatch);
    } finally {
      await fixture.restore();
    }
  });

  test.serial("stop shares one shutdown operation and releases each resource once", async () => {
    const fixture = await createFixture();
    const originalStartServer = serverModule.startServer;
    let httpStopCalls = 0;
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async (config) => {
      const server = await originalStartServer(config);
      return {
        ...server,
        async stop() {
          httpStopCalls += 1;
          await server.stop();
        },
      };
    });
    const clearTrustedSpy = spyOn(serverModule, "clearTrustedOpencodeProcess");

    try {
      const handle = await startManaged(fixture, "idempotent");
      const firstStop = handle.stop();
      const secondStop = handle.stop();
      expect(secondStop).toBe(firstStop);
      await Promise.all([firstStop, secondStop]);

      expect(httpStopCalls).toBe(1);
      expect(clearTrustedSpy).toHaveBeenCalledTimes(1);
      expect((await logLines(fixture.logPath)).filter((line) => line === "SIGTERM")).toHaveLength(1);
      expect(handle.managedOpencode?.isAlive()).toBe(false);
      await expect(fetch(handle.url)).rejects.toThrow();
      await expect(handle.stop()).resolves.toBeUndefined();
    } finally {
      clearTrustedSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("HTTP startup failure aborts before any engine is spawned", async () => {
    const fixture = await createFixture();
    const startupError = new Error("forced HTTP startup failure");
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async () => {
      throw startupError;
    });
    const managedSpy = spyOn(managedOpencodeModule, "createManagedOpencodeServer");

    try {
      const options = managedOptions(fixture, "startup-failure");
      await mkdir(options.opencodeCwd ?? "", { recursive: true });
      await expect(startEmbeddedServer(options)).rejects.toBe(startupError);

      // The HTTP server binds before the engine spawns, so a bind failure
      // must leave no engine child (and nothing to SIGTERM).
      expect(managedSpy).not.toHaveBeenCalled();
      expect((await logLines(fixture.logPath)).filter((line) => line === "SIGTERM")).toHaveLength(0);
    } finally {
      managedSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("a global OpenCode config with V2 permissions aborts before any engine is spawned", async () => {
    const fixture = await createFixture();
    // The engine reads its global config from OPENCODE_CONFIG_DIR when set;
    // the pre-flight must look at the same directory.
    const globalDir = join(fixture.root, "opencode-config");
    const globalFile = join(globalDir, "opencode.json");
    await mkdir(globalDir, { recursive: true });
    await writeFile(globalFile, JSON.stringify({ permissions: { bash: "deny" } }), "utf8");
    process.env.OPENCODE_CONFIG_DIR = globalDir;
    const managedSpy = spyOn(managedOpencodeModule, "createManagedOpencodeServer");

    try {
      const options = managedOptions(fixture, "v2-global");
      await mkdir(options.opencodeCwd ?? "", { recursive: true });
      let thrown: unknown;
      try {
        await startEmbeddedServer(options);
      } catch (error) {
        thrown = error;
      }

      // 1.18.32 would exit at boot with this message buried in stderr; the
      // pre-flight names the file and the fix without spawning anything.
      expect(thrown).toBeInstanceOf(OpencodeConfigCompatError);
      if (!(thrown instanceof OpencodeConfigCompatError)) throw new Error("Expected OpencodeConfigCompatError");
      expect(thrown.message).toContain(`Configuration is invalid at ${globalFile}`);
      expect(thrown.message).toContain(OPENCODE_V2_PERMISSIONS_MESSAGE);
      expect(thrown.findings).toEqual([
        { scope: "global", file: globalFile, issues: [{ path: ["permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }] },
      ]);
      expect(managedSpy).not.toHaveBeenCalled();
      expect((await logLines(fixture.logPath)).filter((line) => line === "SIGTERM")).toHaveLength(0);
    } finally {
      managedSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("a workspace OpenCode config with V2 permissions is reported but still boots the engine", async () => {
    const fixture = await createFixture();
    process.env.OPENCODE_CONFIG_DIR = join(fixture.root, "opencode-config");
    const workspace = join(fixture.root, "v2-workspace-workspace");
    const workspaceFile = join(workspace, ".opencode", "opencode.json");
    await mkdir(join(workspace, ".opencode"), { recursive: true });
    await writeFile(workspaceFile, JSON.stringify({ agent: { build: { permissions: { bash: "allow" } } } }), "utf8");
    const originalAssert = opencodeConfigCompatModule.assertOpencodeConfigCompat;
    const reported: opencodeConfigCompatModule.OpencodeConfigCompatFinding[][] = [];
    const assertSpy = spyOn(opencodeConfigCompatModule, "assertOpencodeConfigCompat").mockImplementation(async (input) => {
      const findings = await originalAssert(input);
      reported.push(findings);
      return findings;
    });

    try {
      const handle = await startManaged(fixture, "v2-workspace");

      // Other workspaces keep working, so the engine must still come up; the
      // finding is logged and that workspace's routes answer opencode_config_invalid.
      expect(handle.managedOpencode?.pid).toBeGreaterThan(0);
      expect(reported).toEqual([[
        { scope: "workspace", file: workspaceFile, issues: [{ path: ["agent", "build", "permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }] },
      ]]);
    } finally {
      assertSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("engine spawn failure after HTTP start releases the server and subscription", async () => {
    const fixture = await createFixture();
    const spawnError = new Error("forced engine spawn failure");
    let failedConfig: ServerConfig | null = null;
    let httpStopCalls = 0;
    const originalStartServer = serverModule.startServer;
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async (config) => {
      failedConfig = config;
      const server = await originalStartServer(config);
      return {
        ...server,
        async stop() {
          httpStopCalls += 1;
          await server.stop();
        },
      };
    });
    const managedSpy = spyOn(managedOpencodeModule, "createManagedOpencodeServer").mockImplementation(async () => {
      throw spawnError;
    });
    const clearTrustedSpy = spyOn(serverModule, "clearTrustedOpencodeProcess");

    try {
      const options = managedOptions(fixture, "spawn-failure");
      await mkdir(options.opencodeCwd ?? "", { recursive: true });
      await expect(startEmbeddedServer(options)).rejects.toBe(spawnError);
      if (!failedConfig) throw new Error("Expected startup to bind the HTTP server");

      const config = failedConfig;
      await mutateGlobalRuntime(config, "after-spawn-failure");
      const barrier = await writeOmniRushRuntimeConfigFile(config);

      expect(barrier.changed).toBe(true);
      expect(httpStopCalls).toBe(1);
      // Nothing was registered, so nothing gets cleared.
      expect(clearTrustedSpy).not.toHaveBeenCalled();
      expect(await readEngineRegistry(config)).toEqual([]);
    } finally {
      clearTrustedSpy.mockRestore();
      managedSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("shutdown errors remain observable while every later resource is released", async () => {
    const fixture = await createFixture();
    const managedError = new Error("forced managed OpenCode shutdown failure");
    const httpError = new Error("forced HTTP shutdown failure");
    const originalCreateManagedOpencodeServer = managedOpencodeModule.createManagedOpencodeServer;
    const originalStartServer = serverModule.startServer;
    let managedCloseCalls = 0;
    let httpStopCalls = 0;
    const managedSpy = spyOn(managedOpencodeModule, "createManagedOpencodeServer").mockImplementation(async (options) => {
      const managed = await originalCreateManagedOpencodeServer(options);
      return {
        ...managed,
        async close() {
          managedCloseCalls += 1;
          await managed.close();
          throw managedError;
        },
      };
    });
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async (config) => {
      const server = await originalStartServer(config);
      return {
        ...server,
        async stop() {
          httpStopCalls += 1;
          await server.stop();
          throw httpError;
        },
      };
    });

    try {
      const handle = await startManaged(fixture, "shutdown-failure");
      const firstStop = handle.stop();
      const secondStop = handle.stop();
      expect(secondStop).toBe(firstStop);

      let observed: unknown;
      try {
        await firstStop;
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(AggregateError);
      if (!(observed instanceof AggregateError)) throw new Error("Expected aggregate shutdown failure");
      expect(observed.errors).toEqual([managedError, httpError]);

      await mutateGlobalRuntime(handle.config, "after-shutdown-failure");
      const barrier = await writeOmniRushRuntimeConfigFile(handle.config);
      expect(barrier.changed).toBe(true);
      expect(managedCloseCalls).toBe(1);
      expect(httpStopCalls).toBe(1);
      expect((await logLines(fixture.logPath)).filter((line) => line === "SIGTERM")).toHaveLength(1);
      await expect(fetch(handle.url)).rejects.toThrow();
      fixture.handles.splice(fixture.handles.indexOf(handle), 1);
    } finally {
      managedSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });
});
