import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertHeadlessLaunchSafety,
  installedProductionHeadlessEnv,
  resolveHeadlessClientConnection,
  resolveInstalledProductionHeadlessState,
  resolveHeadlessWorldRuntimePaths,
} from "../src/headless-web.ts";

test("headless production state resolves installed stores and credentials without copying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnirush-headless-production-"));
  try {
    const dataDir = join(root, ".omnirush", "omnirush-server");
    const configDir = join(root, ".config", "omnirush");
    const opencodeConfigDir = join(root, ".config", "opencode");
    const userDataDir = join(root, "Library", "Application Support", "ai.omnirush.desktop");
    const opencodeDb = join(root, "Library", "Application Support", "opencode", "opencode.db");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(opencodeConfigDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(dirname(opencodeDb), { recursive: true });
    await writeFile(opencodeDb, "fixture", "utf8");
    for (const name of ["desktop-bootstrap.json", "env.json", "server.json"]) {
      await writeFile(join(configDir, name), "{}\n", "utf8");
    }
    await writeFile(join(userDataDir, "omnirush-server-state.json"), "{}\n", "utf8");
    await writeFile(join(userDataDir, "omnirush-workspaces.json"), JSON.stringify({
      workspaces: [{ path: "/Users/me/production-workspace" }],
    }), "utf8");
    await writeFile(join(userDataDir, "omnirush-server-tokens.json"), JSON.stringify({
      version: 2,
      credentials: { clientToken: "client-token", hostToken: "host-token" },
    }), "utf8");

    const state = await resolveInstalledProductionHeadlessState({
      env: {},
      fallbackWorkspace: "/fallback",
      homeDir: root,
      platform: "darwin",
    });
    assert.equal(state.workspace, "/Users/me/production-workspace");
    assert.equal(state.token, "client-token");
    assert.equal(state.hostToken, "host-token");
    assert.equal(state.opencodeDb, opencodeDb);
    const env = installedProductionHeadlessEnv(state);
    assert.equal(env.OMNIRUSH_DATA_DIR, dataDir);
    assert.equal(env.OMNIRUSH_SERVER_CONFIG, join(configDir, "server.json"));
    assert.equal(env.OPENCODE_DB, opencodeDb);
    assert.equal(env.OMNIRUSH_DEV_SHARED_STATE, "1");
    assert.equal(env.OMNIRUSH_DESKTOP_DISABLE_WORKSPACE_RECOVERY, "0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("headless production state remains macOS-only", async () => {
  await assert.rejects(
    () => resolveInstalledProductionHeadlessState({
      env: {},
      fallbackWorkspace: "/tmp",
      homeDir: "/tmp",
      platform: "linux",
    }),
    /supported only on macOS/,
  );
});

test("headless production state refuses every remote exposure setting", () => {
  for (const env of [
    { OMNIRUSH_REMOTE_ACCESS: "1" },
    { OMNIRUSH_PUBLIC_HOST: "dev.example.com" },
    { HOST: "0.0.0.0" },
    { VITE_HOST: "192.0.2.10" },
  ]) {
    assert.throws(
      () => assertHeadlessLaunchSafety("installed-production", env),
      /require loopback-only access/,
    );
  }
  assert.doesNotThrow(() => assertHeadlessLaunchSafety("installed-production", {
    HOST: "127.0.0.1",
    VITE_HOST: "localhost",
  }));
  assert.doesNotThrow(() => assertHeadlessLaunchSafety("isolated", {
    OMNIRUSH_REMOTE_ACCESS: "1",
  }));
});

test("headless production state pins browser credentials to its generated loopback server", () => {
  const production = resolveHeadlessClientConnection({
    state: "installed-production",
    env: {
      VITE_OMNIRUSH_URL: "https://attacker.example",
      VITE_OMNIRUSH_PORT: "443",
      VITE_OMNIRUSH_TOKEN: "attacker-selected-token",
    },
    omnirushUrl: "http://127.0.0.1:8778",
    omnirushPort: 8778,
    token: "installed-production-token",
  });
  assert.deepEqual(production, {
    url: "http://127.0.0.1:8778",
    port: "8778",
    token: "installed-production-token",
  });

  const isolated = resolveHeadlessClientConnection({
    state: "isolated",
    env: { VITE_OMNIRUSH_URL: "http://127.0.0.1:9999" },
    omnirushUrl: "http://127.0.0.1:8778",
    omnirushPort: 8778,
    token: "isolated-token",
  });
  assert.equal(isolated.url, "http://127.0.0.1:9999");
});

test("named headless worlds own separate runtime paths while the compatibility world keeps legacy paths", () => {
  const repoRoot = "/repo/omnirush";
  const compatibility = resolveHeadlessWorldRuntimePaths(repoRoot, "dev-headless");
  const production = resolveHeadlessWorldRuntimePaths(repoRoot, "headless-prod-live");

  assert.equal(compatibility.runtimeManifestPath, join(repoRoot, "tmp", "dev-headless-web.json"));
  assert.equal(production.runtimeManifestPath, join(
    repoRoot,
    "tmp",
    "worlds",
    "runtime",
    "headless-prod-live",
    "runtime.json",
  ));
  assert.notEqual(production.serverConfigPath, compatibility.serverConfigPath);
});
