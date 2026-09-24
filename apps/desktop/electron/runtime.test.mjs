import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandMatchesPackagedSidecar,
  createRuntimeManager,
  embeddedServerImportUrl,
  migrateOmniRushServerTokenStore,
  prepareRuntimeWorkspaceRoot,
  prioritizeWorkspacePaths,
  resetRuntimeStatesAfterFailedServerStart,
  resolveEvalLocalServerDelayMs,
  resolveOmniRushServerConfigPath,
  resolveOmniRushServerLogFile,
  resolveOmniRushServerReuse,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyOmniRushPortWorkspace,
  snapshotEngineState,
  snapshotOmniRushServerState,
} from "./runtime.mjs";
import {
  appendRuntimeRestartRecord,
  decideDeferredRestart,
  decideRuntimeRestart,
  DEFERRED_RESTART_UNKNOWN_MAX_MS,
  readRuntimeRestartRecords,
  runtimeRestartLogPath,
} from "./runtime-restart-log.mjs";

describe("workspace root preparation", () => {
  it("reports an inaccessible Windows drive as a controlled recoverable error", async () => {
    const mkdirError = Object.assign(new Error("drive is unavailable"), { code: "ENOENT" });
    let attemptedPath = null;

    await assert.rejects(
      prepareRuntimeWorkspaceRoot("\\\\?\\Z:\\Disconnected\\Workspace", {
        platform: "win32",
        mkdirImpl: async (workspaceRoot) => {
          attemptedPath = workspaceRoot;
          throw mkdirError;
        },
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.ok("workspacePath" in error);
        assert.equal(error.code, "workspace_inaccessible");
        assert.equal(error.workspacePath, "\\\\?\\Z:\\Disconnected\\Workspace");
        assert.equal(error.cause, mkdirError);
        return true;
      },
    );
    assert.equal(attemptedPath, "Z:\\Disconnected\\Workspace");
  });

  it("returns the runtime lifecycle to idle after root preparation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-runtime-root-"));
    try {
      const manager = createRuntimeManager({
        app: {
          getPath: (name) => name === "exe" ? path.join(root, "OmniRush.ai.exe") : root,
          isPackaged: false,
        },
        desktopRoot: path.dirname(fileURLToPath(import.meta.url)),
        listLocalWorkspacePaths: async () => [],
        localManagedMcpVaultKey: "test-key",
        workspaceMkdir: async () => {
          throw Object.assign(new Error("network share disconnected"), { code: "ENOENT" });
        },
        workspacePlatform: "win32",
      });

      await assert.rejects(
        manager.engineStart("\\\\server\\share\\Workspace"),
        (error) => error instanceof Error && "code" in error && error.code === "workspace_inaccessible",
      );
      const status = await manager.runtimeStatus();
      assert.equal(status.lifecycleState, "idle");
      assert.equal(status.engine.running, false);
      assert.equal(status.engine.projectDir, null);
      assert.equal(status.omnirushServer.running, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bundled OpenCode runtime", () => {
  it("pins the engine release containing the timestamp-based session loop repair", async () => {
    const constantsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../constants.json");
    const constants = JSON.parse(await readFile(constantsPath, "utf8"));

    // OpenCode #40990 stops old assistant messages with lexicographically
    // later IDs from short-circuiting a newly appended user turn. It shipped
    // in 1.18.18; the pin has since moved to 1.18.32 (2026-09-21) for the
    // patch-release fixes on top of it (apply_patch move-path metadata,
    // config snapshot comparison, provider SDK bumps, session header fixes).
    assert.equal(constants.opencodeVersion, "v1.18.32");
  });
});

describe("omnirush server snapshot", () => {
  it("reports a running in-process server", () => {
    const snapshot = snapshotOmniRushServerState({
      child: null,
      childExited: true,
      inProcess: true,
    });
    assert.equal(snapshot.running, true);
  });

  it("exposes the server log file so Settings > Debug can point at it", () => {
    const withLog = snapshotOmniRushServerState({
      child: null,
      childExited: true,
      inProcess: true,
      logFilePath: "/tmp/userData/logs/omnirush-server.log",
    });
    assert.equal(withLog.logFilePath, "/tmp/userData/logs/omnirush-server.log");
    const withoutLog = snapshotOmniRushServerState({ child: null, childExited: true, inProcess: false });
    assert.equal(withoutLog.logFilePath, null);
  });
});

describe("resolveOmniRushServerLogFile", () => {
  it("defaults to logs/omnirush-server.log under the user data dir", () => {
    assert.equal(
      resolveOmniRushServerLogFile("/tmp/userData", {}),
      path.join("/tmp/userData", "logs", "omnirush-server.log"),
    );
  });

  it("prefers an explicit OMNIRUSH_SERVER_LOG_FILE", () => {
    assert.equal(
      resolveOmniRushServerLogFile("/tmp/userData", { OMNIRUSH_SERVER_LOG_FILE: "  /var/log/ow.log " }),
      "/var/log/ow.log",
    );
    assert.equal(
      resolveOmniRushServerLogFile("/tmp/userData", { OMNIRUSH_SERVER_LOG_FILE: "   " }),
      path.join("/tmp/userData", "logs", "omnirush-server.log"),
    );
  });
});

describe("resolveOmniRushServerReuse", () => {
  const healthy = {
    forceRestart: undefined,
    inProcess: true,
    lifecycleState: "healthy",
    remoteAccessEnabled: false,
    requestedRemoteAccess: false,
    currentProjectDir: "/Users/person/workspace-a",
    requestedProjectDir: "/Users/person/workspace-a",
    platform: "darwin",
  };

  it("reuses the running server for the same workspace", () => {
    assert.deepEqual(resolveOmniRushServerReuse(healthy), { reuse: true, retarget: false });
  });

  it("retargets instead of restarting when a different workspace is requested", () => {
    // Regression: a workspace switch (e.g. opening Settings while another
    // workspace is routed) used to tear the server down here, aborting every
    // in-flight run in the workspace being left.
    assert.deepEqual(
      resolveOmniRushServerReuse({ ...healthy, requestedProjectDir: "/Users/person/workspace-b" }),
      { reuse: true, retarget: true },
    );
  });

  it("treats case-only path differences as the same workspace on win32", () => {
    assert.deepEqual(
      resolveOmniRushServerReuse({
        ...healthy,
        platform: "win32",
        currentProjectDir: "C:\\Work\\Space",
        requestedProjectDir: "c:\\work\\space",
      }),
      { reuse: true, retarget: false },
    );
  });

  it("gives up the server only for an explicit restart, host rebind, or unhealthy runtime", () => {
    assert.deepEqual(
      resolveOmniRushServerReuse({ ...healthy, forceRestart: true }),
      { reuse: false, retarget: false },
    );
    assert.deepEqual(
      resolveOmniRushServerReuse({ ...healthy, requestedRemoteAccess: true }),
      { reuse: false, retarget: false },
    );
    assert.deepEqual(
      resolveOmniRushServerReuse({ ...healthy, lifecycleState: "starting" }),
      { reuse: false, retarget: false },
    );
    assert.deepEqual(
      resolveOmniRushServerReuse({ ...healthy, inProcess: false }),
      { reuse: false, retarget: false },
    );
  });
});

describe("prioritizeWorkspacePaths", () => {
  it("keeps the active runtime workspace first", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current", ["/workspace/other", "/workspace/current"]),
      ["/workspace/current", "/workspace/other"],
    );
  });

  it("dedupes equivalent paths", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current/../current", ["/workspace/current"]),
      ["/workspace/current/../current"],
    );
  });
});

describe("seedWorkspacePathsForEmbeddedServer", () => {
  it("uses persisted server config instead of Electron workspace state once config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/legacy"], true),
      [],
    );
  });

  it("seeds from Electron workspace state before server config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/first"], false),
      ["/workspace/first"],
    );
  });
});

describe("selectStickyOmniRushPortWorkspace", () => {
  it("uses the requested workspace even when server config owns workspace loading", () => {
    assert.equal(
      selectStickyOmniRushPortWorkspace(["/workspace/current"], []),
      "/workspace/current",
    );
  });

  it("falls back to server workspace paths when no requested path is available", () => {
    assert.equal(
      selectStickyOmniRushPortWorkspace([], ["/workspace/from-server"]),
      "/workspace/from-server",
    );
  });
});

describe("resolveEvalLocalServerDelayMs", () => {
  it("enables only positive finite eval delays", () => {
    assert.equal(resolveEvalLocalServerDelayMs({ OMNIRUSH_EVAL_LOCAL_SERVER_DELAY_MS: "3000" }), 3000);
    assert.equal(resolveEvalLocalServerDelayMs({ OMNIRUSH_EVAL_LOCAL_SERVER_DELAY_MS: "0" }), 0);
    assert.equal(resolveEvalLocalServerDelayMs({ OMNIRUSH_EVAL_LOCAL_SERVER_DELAY_MS: "-1" }), 0);
    assert.equal(resolveEvalLocalServerDelayMs({ OMNIRUSH_EVAL_LOCAL_SERVER_DELAY_MS: "Infinity" }), 0);
    assert.equal(resolveEvalLocalServerDelayMs({ OMNIRUSH_EVAL_LOCAL_SERVER_DELAY_MS: "invalid" }), 0);
  });
});

describe("commandMatchesPackagedSidecar", () => {
  it("matches packaged opencode sidecars with platform suffixes", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/OmniRush.ai.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin serve --hostname 127.0.0.1 --port 49174 --cors *",
        ["/Applications/OmniRush.ai.app/Contents/Resources/sidecars"],
      ),
      true,
    );
  });

  it("does not match unrelated opencode processes outside sidecar directories", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49174",
        ["/Applications/OmniRush.ai.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });
});

describe("embeddedServerImportUrl", () => {
  it("returns the same file URL for unchanged metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omnirush-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");

      const first = embeddedServerImportUrl(embeddedPath);
      const second = embeddedServerImportUrl(embeddedPath);
      const url = new URL(first);

      assert.equal(first, second);
      assert.equal(url.protocol, "file:");
      assert.equal(fileURLToPath(url), embeddedPath);
      assert.ok(url.searchParams.get("mtimeMs"));
      assert.equal(url.searchParams.get("size"), String("export const value = 1;\n".length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes when the file metadata changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omnirush-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");
      const first = embeddedServerImportUrl(embeddedPath);

      await writeFile(embeddedPath, "export const value = 12;\n");

      assert.notEqual(embeddedServerImportUrl(embeddedPath), first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain file URL if stat fails", () => {
    const missingPath = path.join(os.tmpdir(), "omnirush-missing-embedded.js");

    assert.equal(embeddedServerImportUrl(missingPath), pathToFileURL(missingPath).href);
  });
});

describe("resolveOmniRushServerConfigPath", () => {
  it("respects explicit server config path", () => {
    assert.equal(
      resolveOmniRushServerConfigPath({ OMNIRUSH_SERVER_CONFIG: "/tmp/omnirush/server.json" }),
      "/tmp/omnirush/server.json",
    );
  });

  it("uses XDG config home on Unix", () => {
    if (process.platform === "win32") return;
    assert.equal(
      resolveOmniRushServerConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
      "/tmp/xdg/omnirush/server.json",
    );
  });
});

describe("OmniRush.ai server credential persistence", () => {
  it("deterministically migrates legacy workspace credentials into one server bundle", () => {
    const migrated = migrateOmniRushServerTokenStore({
      version: 1,
      workspaces: {
        "/workspace/z": {
          clientToken: "client-z",
          hostToken: "host-z",
          ownerToken: "owner-z",
          updatedAt: 20,
        },
        "/workspace/a": {
          clientToken: "client-a",
          hostToken: "host-a",
          ownerToken: "owner-a",
          updatedAt: 20,
        },
        "/workspace/old": {
          clientToken: "client-old",
          hostToken: "host-old",
          ownerToken: "owner-old",
          updatedAt: 10,
        },
      },
    });

    assert.deepEqual(migrated, {
      version: 2,
      credentials: {
        clientToken: "client-a",
        hostToken: "host-a",
        ownerToken: "owner-a",
        updatedAt: 20,
      },
    });
    assert.deepEqual(migrateOmniRushServerTokenStore(migrated), migrated);
  });
});

describe("snapshotEngineState", () => {
  it("reports server-managed OpenCode liveness and pid without a child handle", () => {
    const snapshot = snapshotEngineState({
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: null,
      opencodePassword: null,
      opencodeBinPath: null,
      opencodeBinSource: null,
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: null,
      lastStderr: null,
      execution: null,
    });
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.managedByServer, true);
    assert.equal(snapshot.pid, 12345);
  });
});

describe("resetRuntimeStatesAfterFailedServerStart", () => {
  function staleServerState() {
    return {
      child: null,
      childExited: true,
      inProcess: true,
      remoteAccessEnabled: true,
      host: "127.0.0.1",
      port: 4141,
      baseUrl: "http://127.0.0.1:4141",
      connectUrl: null,
      mdnsUrl: null,
      lanUrl: null,
      clientToken: "client-token",
      ownerToken: "owner-token",
      hostToken: "host-token",
      managedOpencodeBinPath: "/usr/local/bin/opencode",
      managedOpencodeBinSource: "known-location",
      lastStdout: "server stdout",
      lastStderr: "server stderr",
      managedOpencodeExecution: { command: "opencode" },
    };
  }

  function staleEngineState() {
    return {
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: "user",
      opencodePassword: "pass",
      opencodeBinPath: "/usr/local/bin/opencode",
      opencodeBinSource: "known-location",
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: "engine stdout",
      lastStderr: "engine stderr",
      execution: { command: "opencode" },
    };
  }

  it("clears a dead managed runtime so snapshots cannot report it running", () => {
    const serverState = staleServerState();
    const engineState = staleEngineState();

    resetRuntimeStatesAfterFailedServerStart(serverState, engineState, { manageOpencode: true });

    assert.equal(serverState.inProcess, false);
    assert.equal(serverState.port, null);
    assert.equal(serverState.baseUrl, null);
    assert.equal(serverState.ownerToken, null);
    // Diagnostics survive the reset.
    assert.equal(serverState.lastStdout, "server stdout");
    assert.equal(serverState.lastStderr, "server stderr");

    assert.equal(engineState.baseUrl, null);
    assert.equal(engineState.managedByServer, false);
    assert.equal(engineState.managedPid, null);
    assert.equal(snapshotEngineState(engineState).running, false);
    // A retry via engineRestart still knows its workspace.
    assert.equal(engineState.projectDir, "/workspace/current");
    assert.equal(engineState.lastStderr, "engine stderr");
  });

  it("leaves an external engine untouched when the failed start did not manage it", () => {
    const serverState = staleServerState();
    const engineState = staleEngineState();
    engineState.managedByServer = false;

    resetRuntimeStatesAfterFailedServerStart(serverState, engineState, { manageOpencode: false });

    assert.equal(serverState.inProcess, false);
    assert.equal(engineState.baseUrl, "http://127.0.0.1:4097");
    assert.equal(engineState.projectDir, "/workspace/current");
  });
});

describe("built-in server restart guard", () => {
  const idle = { sessions: 0, unknown: 0 };
  const busy = { sessions: 3, unknown: 0 };

  it("never lets an automatic trigger stop a healthy server with running sessions", () => {
    for (const action of ["engine-restart", "server-restart"]) {
      assert.deepEqual(
        decideRuntimeRestart({ action, userInitiated: false, serverRunning: true, serverHealthy: true, busy, sameSettings: false }),
        { verdict: "defer", why: "sessions_busy" },
      );
    }
  });

  it("treats an unreadable busy probe as busy", () => {
    assert.equal(
      decideRuntimeRestart({ action: "engine-restart", serverRunning: true, serverHealthy: true, busy: { sessions: 0, unknown: 1 } }).verdict,
      "defer",
    );
  });

  it("keeps a healthy server that already runs with the requested settings", () => {
    // A renderer health check that timed out while the server was busy, or a
    // renderer reload re-running boot, must not restart anything.
    assert.equal(
      decideRuntimeRestart({ action: "server-restart", serverRunning: true, serverHealthy: true, busy: idle, sameSettings: true }).verdict,
      "skip",
    );
    assert.equal(
      decideRuntimeRestart({ action: "engine-start", serverRunning: true, serverHealthy: true, busy }).verdict,
      "skip",
    );
  });

  it("restarts when the user asked, when nothing runs, when the server is gone, or when idle", () => {
    assert.equal(decideRuntimeRestart({ action: "server-restart", userInitiated: true, serverRunning: true, serverHealthy: true, busy, sameSettings: true }).verdict, "proceed");
    assert.equal(decideRuntimeRestart({ action: "server-restart", serverRunning: false, serverHealthy: false, busy: idle }).verdict, "proceed");
    assert.deepEqual(
      decideRuntimeRestart({ action: "engine-restart", serverRunning: true, serverHealthy: false, busy }),
      { verdict: "proceed", why: "server_unresponsive" },
    );
    assert.equal(decideRuntimeRestart({ action: "engine-restart", serverRunning: true, serverHealthy: true, busy: idle }).verdict, "proceed");
  });

  it("runs a deferred restart once idle, and gives up waiting on an engine that stays unreadable", () => {
    assert.equal(decideDeferredRestart({ serverRunning: true, serverHealthy: true, busy, deferredForMs: 60 * 60_000 }), "wait");
    assert.equal(decideDeferredRestart({ serverRunning: true, serverHealthy: true, busy: idle, deferredForMs: 0 }), "run");
    assert.equal(decideDeferredRestart({ serverRunning: true, serverHealthy: true, busy: { sessions: 0, unknown: 1 }, deferredForMs: 1_000 }), "wait");
    assert.equal(
      decideDeferredRestart({ serverRunning: true, serverHealthy: true, busy: { sessions: 0, unknown: 1 }, deferredForMs: DEFERRED_RESTART_UNKNOWN_MAX_MS }),
      "run",
    );
    assert.equal(decideDeferredRestart({ serverRunning: true, serverHealthy: false, busy, deferredForMs: 0 }), "run");
    assert.equal(decideDeferredRestart({ serverRunning: false, serverHealthy: false, busy: idle, deferredForMs: 0 }), "drop");
  });
});

describe("built-in server restart record", () => {
  it("writes each restart to omnirush-server.log and the history, newest first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-restart-log-"));
    try {
      const serverLogFile = path.join(root, "logs", "omnirush-server.log");
      appendRuntimeRestartRecord({
        serverLogFile,
        now: () => new Date("2026-09-24T07:11:00.000Z"),
        record: { kind: "server", action: "deferred", reason: "engine_reload_failed", source: "engine-reload", busySessions: 3 },
      });
      appendRuntimeRestartRecord({
        serverLogFile,
        now: () => new Date("2026-09-24T07:40:00.000Z"),
        record: { kind: "server", action: "restarting", reason: "engine_reload_failed (deferred until idle)", source: "engine-reload" },
      });

      const records = await readRuntimeRestartRecords(serverLogFile);
      assert.deepEqual(records.map((record) => [record.at, record.action]), [
        ["2026-09-24T07:40:00.000Z", "restarting"],
        ["2026-09-24T07:11:00.000Z", "deferred"],
      ]);
      assert.equal(records[1].busySessions, 3);

      const logLines = (await readFile(serverLogFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(logLines.length, 2);
      assert.equal(logLines[0].body, "Built-in server deferred: engine_reload_failed (engine-reload)");
      assert.equal(logLines[0].attributes["runtime.restart.busy_sessions"], 3);
      assert.equal(logLines[0].timeUnixNano, "1790233860000000000");
      assert.equal(path.dirname(runtimeRestartLogPath(serverLogFile)), path.dirname(serverLogFile));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips torn lines and reports an empty history when there is none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-restart-log-"));
    try {
      const serverLogFile = path.join(root, "omnirush-server.log");
      assert.deepEqual(await readRuntimeRestartRecords(serverLogFile), []);
      await writeFile(runtimeRestartLogPath(serverLogFile), '{"at":"2026-09-24T00:00:00.000Z","action":"started"}\n{"at":"2026-09-24T', "utf8");
      assert.deepEqual((await readRuntimeRestartRecords(serverLogFile)).map((record) => record.action), ["started"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the history and any pending restart with the server info", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-runtime-restarts-"));
    const previous = process.env.OMNIRUSH_SERVER_LOG_FILE;
    delete process.env.OMNIRUSH_SERVER_LOG_FILE;
    try {
      appendRuntimeRestartRecord({
        serverLogFile: resolveOmniRushServerLogFile(root),
        record: { kind: "engine", action: "restarted", reason: "engine_unreachable:process_exited", source: "engine-pool-watchdog" },
      });
      const manager = createRuntimeManager({
        app: { getPath: (name) => name === "exe" ? path.join(root, "OmniRush.ai.exe") : root, isPackaged: false },
        desktopRoot: path.dirname(fileURLToPath(import.meta.url)),
        listLocalWorkspacePaths: async () => [],
        localManagedMcpVaultKey: "test-key",
      });
      const info = await manager.omnirushServerInfo();
      assert.equal(info.running, false);
      assert.equal(info.pendingRestart, null);
      assert.deepEqual(info.restarts.map((record) => record.reason), ["engine_unreachable:process_exited"]);
    } finally {
      if (previous === undefined) delete process.env.OMNIRUSH_SERVER_LOG_FILE;
      else process.env.OMNIRUSH_SERVER_LOG_FILE = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
