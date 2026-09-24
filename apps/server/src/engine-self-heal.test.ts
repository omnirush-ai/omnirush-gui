import { afterEach, describe, expect, test } from "bun:test";

import { EnginePool, isEngineConnectionFailure, type EnginePoolHooks, type EngineSpawnTemplate } from "./engine-pool.js";
import { createManagedProcessClose, type ManagedChildProcess, type ManagedOpencodeServer } from "./managed-opencode.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const previousSpawnInterval = process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS;
const previousProbeInterval = process.env.OMNIRUSH_ENGINE_RECOVERY_PROBE_INTERVAL_MS;

afterEach(() => {
  if (previousSpawnInterval === undefined) delete process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS;
  else process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = previousSpawnInterval;
  if (previousProbeInterval === undefined) delete process.env.OMNIRUSH_ENGINE_RECOVERY_PROBE_INTERVAL_MS;
  else process.env.OMNIRUSH_ENGINE_RECOVERY_PROBE_INTERVAL_MS = previousProbeInterval;
});

function managedHandle(port: number) {
  let alive = true;
  let closeCalls = 0;
  const handle: ManagedOpencodeServer = {
    url: `http://127.0.0.1:${port}`,
    username: "user",
    password: "password",
    pid: null,
    execution: { command: "opencode", args: [], cwd: "/tmp", env: [] },
    isAlive: () => alive,
    close: async () => {
      closeCalls += 1;
      alive = false;
    },
  };
  return { handle, closeCalls: () => closeCalls };
}

function fixture(spawn: EnginePoolHooks["spawn"], overrides: Partial<EnginePoolHooks> = {}) {
  let now = 0;
  const scheduled: Array<() => void> = [];
  const workspace: WorkspaceInfo = {
    id: "ws_self_heal",
    name: "Self heal",
    path: "/tmp/self-heal",
    preset: "starter",
    workspaceType: "local",
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 8787,
    token: "token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [workspace.path],
    readOnly: false,
    startedAt: 0,
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const template: EngineSpawnTemplate = {
    cwd: workspace.path,
    runtimeConfigPath: "/tmp/runtime-opencode-config.json",
    env: {},
    reservedPorts: () => [],
  };
  const hooks: EnginePoolHooks = {
    reloadInPlace: async () => undefined,
    engineBusy: async () => false,
    postRefreshSync: async () => undefined,
    writeRuntimeConfigFile: async () => ({ path: template.runtimeConfigPath }),
    registerTrusted: () => undefined,
    clearTrusted: () => undefined,
    spawn,
    now: () => now,
    schedule: (operation) => {
      scheduled.push(operation);
      return setTimeout(() => undefined, 60_000);
    },
    waitForHealthy: async () => undefined,
    // Nothing listens on these fake engines' ports.
    probeHealth: async () => "refused",
    ...overrides,
  };
  const pool = new EnginePool({ config, template, hooks });
  return { pool, config, workspace, scheduled, setNow: (value: number) => { now = value; } };
}

async function settle(): Promise<void> {
  await Bun.sleep(10);
}

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" });
}

function timedOut(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ETIMEDOUT 127.0.0.1"), { code: "ETIMEDOUT" }),
  });
}

function connectionReset(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
  });
}

describe("managed engine self-heal", () => {
  test("classifies Node fetch reset causes as engine connection failures", () => {
    expect(isEngineConnectionFailure(connectionReset())).toBe(true);
  });

  test("requires three consecutive connection failures and throttles later bursts", async () => {
    process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = "30000";
    const old = managedHandle(41001);
    const replacements = [managedHandle(41002), managedHandle(41003)];
    let spawnCalls = 0;
    const testFixture = fixture(async () => replacements[spawnCalls++]!.handle);
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });

    testFixture.pool.reportRequestFailure(old.handle.url, refused(), testFixture.workspace);
    testFixture.pool.reportRequestSuccess(old.handle.url);
    testFixture.pool.reportRequestFailure(old.handle.url, refused(), testFixture.workspace);
    testFixture.pool.reportRequestFailure(old.handle.url, refused(), testFixture.workspace);
    await settle();
    expect(spawnCalls).toBe(0);

    testFixture.pool.reportRequestFailure(old.handle.url, refused(), testFixture.workspace);
    await settle();
    expect(spawnCalls).toBe(1);
    expect(old.closeCalls()).toBe(1);

    const firstReplacementUrl = testFixture.pool.primaryUrl();
    if (!firstReplacementUrl) throw new Error("Expected replacement engine");
    for (let failure = 0; failure < 3; failure += 1) {
      testFixture.pool.reportRequestFailure(firstReplacementUrl, refused(), testFixture.workspace);
    }
    await settle();
    expect(spawnCalls).toBe(1);

    testFixture.setNow(30_001);
    testFixture.pool.reportRequestFailure(firstReplacementUrl, refused(), testFixture.workspace);
    await settle();
    expect(spawnCalls).toBe(2);
    await testFixture.pool.disposeAll();
  });

  test("kills the old generation before spawn and schedules retry when replacement fails", async () => {
    process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = "30000";
    const old = managedHandle(42001);
    let oldAliveAtSpawn = true;
    const testFixture = fixture(async () => {
      oldAliveAtSpawn = old.handle.isAlive();
      throw new Error("replacement failed");
    });
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });

    for (let failure = 0; failure < 3; failure += 1) {
      testFixture.pool.reportRequestFailure(old.handle.url, refused(), testFixture.workspace);
    }
    await settle();

    expect(oldAliveAtSpawn).toBe(false);
    expect(old.handle.isAlive()).toBe(false);
    expect(testFixture.pool.primaryUrl()).toBeNull();
    expect(testFixture.scheduled).toHaveLength(1);
    await testFixture.pool.disposeAll();
  });

  test("treats loopback connect timeouts as recoverable engine failures", async () => {
    process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = "30000";
    const old = managedHandle(43001);
    const replacement = managedHandle(43002);
    let spawnCalls = 0;
    const testFixture = fixture(async () => {
      spawnCalls += 1;
      return replacement.handle;
    });
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });

    for (let failure = 0; failure < 3; failure += 1) {
      testFixture.pool.reportRequestFailure(old.handle.url, timedOut(), testFixture.workspace);
    }
    await settle();

    expect(spawnCalls).toBe(1);
    expect(old.handle.isAlive()).toBe(false);
    expect(testFixture.pool.primaryUrl()).toBe(replacement.handle.url);
    await testFixture.pool.disposeAll();
  });

  test("keeps a live primary that still answers its health check", async () => {
    process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = "30000";
    const old = managedHandle(44001);
    let spawnCalls = 0;
    let lost = 0;
    const testFixture = fixture(async () => {
      spawnCalls += 1;
      return managedHandle(44002).handle;
    }, { probeHealth: async () => "ok", onPrimaryLost: () => { lost += 1; } });
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });

    // An overloaded engine resets or times out proxied requests but is alive.
    for (let failure = 0; failure < 3; failure += 1) {
      testFixture.pool.reportRequestFailure(old.handle.url, connectionReset(), testFixture.workspace);
    }
    await settle();

    expect(spawnCalls).toBe(0);
    expect(lost).toBe(0);
    expect(old.closeCalls()).toBe(0);
    expect(testFixture.pool.primaryUrl()).toBe(old.handle.url);
    await testFixture.pool.disposeAll();
  });

  test("replaces an unresponsive live primary only after every spaced probe fails", async () => {
    process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = "30000";
    process.env.OMNIRUSH_ENGINE_RECOVERY_PROBE_INTERVAL_MS = "1";
    const old = managedHandle(45001);
    const replacement = managedHandle(45002);
    let probes = 0;
    let lost = 0;
    const testFixture = fixture(async () => replacement.handle, {
      probeHealth: async () => {
        probes += 1;
        return "failed";
      },
      onPrimaryLost: () => { lost += 1; },
    });
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });

    for (let failure = 0; failure < 3; failure += 1) {
      testFixture.pool.reportRequestFailure(old.handle.url, timedOut(), testFixture.workspace);
    }
    await settle();

    expect(probes).toBe(3);
    expect(lost).toBe(1);
    expect(old.handle.isAlive()).toBe(false);
    expect(testFixture.pool.primaryUrl()).toBe(replacement.handle.url);
    await testFixture.pool.disposeAll();
  });

  test("replaces a primary whose process already exited without probing it", async () => {
    process.env.OMNIRUSH_ENGINE_MIN_SPAWN_INTERVAL_MS = "30000";
    const old = managedHandle(46001);
    const replacement = managedHandle(46002);
    let probes = 0;
    const testFixture = fixture(async () => replacement.handle, {
      probeHealth: async () => {
        probes += 1;
        return "ok";
      },
    });
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });
    await old.handle.close();

    for (let failure = 0; failure < 3; failure += 1) {
      testFixture.pool.reportRequestFailure(old.handle.url, refused(), testFixture.workspace);
    }
    await settle();

    expect(probes).toBe(0);
    expect(testFixture.pool.primaryUrl()).toBe(replacement.handle.url);
    await testFixture.pool.disposeAll();
  });

  test("a reload whose busy probe fails rolls over instead of disposing the engine in place", async () => {
    const old = managedHandle(47001);
    const standby = managedHandle(47002);
    let inPlace = 0;
    let spawnCalls = 0;
    const testFixture = fixture(async () => {
      spawnCalls += 1;
      return standby.handle;
    }, {
      engineBusy: async () => { throw new Error("status probe timed out"); },
      reloadInPlace: async () => { inPlace += 1; },
    });
    testFixture.pool.adoptPrimary({ handle: old.handle, fingerprint: "one", registryId: null, trustedIdentity: null });

    const outcome = await testFixture.pool.requestRollover({ reason: "test", workspace: testFixture.workspace, manual: true });

    expect(outcome.action).toBe("rolled_over");
    expect(inPlace).toBe(0);
    expect(spawnCalls).toBe(1);
    expect(testFixture.pool.primaryUrl()).toBe(standby.handle.url);
    await testFixture.pool.disposeAll();
  });

  test("dispose escalates an ignored SIGTERM and waits for the child exit", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const exitListeners: Array<() => void> = [];
    const child: ManagedChildProcess = {
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => exitListeners.forEach((listener) => listener()));
        return true;
      },
      once(event, listener) {
        if (event === "exit") exitListeners.push(() => listener(0, "SIGKILL"));
      },
    };
    const lifecycle = createManagedProcessClose(child, { termTimeoutMs: 1, killTimeoutMs: 50 });

    await lifecycle.close();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(lifecycle.isAlive()).toBe(false);
  });
});
