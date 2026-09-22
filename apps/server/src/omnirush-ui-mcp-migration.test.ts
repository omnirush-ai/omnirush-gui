import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMcp, setMcpEnabled } from "./mcp.js";
import {
  migrateLegacyOmniRushUiMcpCommand,
  normalizeOmniRushUiMcpLaunch,
} from "./omnirush-ui-mcp-migration.js";
import {
  ENGINE_GLOBAL_RUNTIME_CONFIG_ID,
  readRuntimeOpencodeConfig,
  runtimeDbPath,
  writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.OMNIRUSH_RUNTIME_DB;

afterEach(async () => {
  if (process.platform !== "win32") {
    while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  } else {
    roots.length = 0;
  }
  if (previousRuntimeDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
  else process.env.OMNIRUSH_RUNTIME_DB = previousRuntimeDb;
});

async function fixtureConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-ui-mcp-migration-"));
  roots.push(root);
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "omnirush.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "One", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

/**
 * Stores a runtime row the way desktop 1.0.x left it. The runtime store now
 * refuses to write registry launches, so the row is seeded with SQL.
 */
async function seedRuntimeRow(config: ServerConfig, workspaceId: string, value: RuntimeOpencodeConfig): Promise<void> {
  // Creates the database and table through the store first.
  await writeRuntimeOpencodeConfig(config, workspaceId, () => ({}));
  const sqlite = new Database(runtimeDbPath(config));
  try {
    sqlite.query("UPDATE runtime_opencode_configs SET config_json = ?, updated_at = ? WHERE workspace_id = ?")
      .run(JSON.stringify(value), Date.now(), workspaceId);
  } finally {
    sqlite.close();
  }
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

const LEGACY = ["npx", "-y", "omnirush-ui-mcp"];
const NOTHING_TO_DO = { changed: false, rewritten: [], refreshed: [], removed: [] };
const BUNDLED = {
  command: [
    "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai",
    "/Applications/OmniRush.ai.app/Contents/Resources/omnirush-ui-mcp/index.mjs",
  ],
  environment: {
    ELECTRON_RUN_AS_NODE: "1",
    OMNIRUSH_UI_CONTROL_DISCOVERY: "/Users/me/Library/Application Support/ai.omnirush.desktop/omnirush-ui-control.json",
  },
};

describe("legacy UI-control MCP command migration", () => {
  test("never accepts a package-runner command as the replacement launch", () => {
    expect(normalizeOmniRushUiMcpLaunch({ command: LEGACY })).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch({ command: ["npx", "-y", "something-else"] })).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch({ command: ["bunx", "something-else"] })).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch({ command: ["C:\\Program Files\\nodejs\\npx.cmd", "-y", "x"] })).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch({ command: ["pnpm", "dlx", "omnirush-ui-mcp"] })).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch({ command: [] })).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch(null)).toBeNull();
    expect(normalizeOmniRushUiMcpLaunch(BUNDLED)).toEqual(BUNDLED);
  });

  test("rewrites stored registry launches to the bundled launch in every runtime row", async () => {
    const config = await fixtureConfig();
    await seedRuntimeRow(config, "ws_1", {
      mcp: {
        "omnirush-ui": {
          type: "local",
          command: LEGACY,
          enabled: true,
          environment: { OMNIRUSH_UI_CONTROL_DISCOVERY: "/stale/omnirush-ui-control.json", KEEP_ME: "1" },
        },
        "ui-control-bunx": { type: "local", command: ["bunx", "omnirush-ui-mcp@latest"], enabled: true },
        "user-tool": { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], enabled: true },
        "user-remote": { type: "remote", url: "https://mcp.example.com/mcp" },
      },
    });
    await seedRuntimeRow(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, {
      mcp: { "ui-control-renamed": { type: "local", command: LEGACY, enabled: false } },
    });

    const result = await migrateLegacyOmniRushUiMcpCommand(config, BUNDLED);

    expect(result.changed).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.rewritten).toHaveLength(3);
    expect(result.rewritten).toEqual(expect.arrayContaining([
      { workspaceId: "ws_1", name: "omnirush-ui" },
      { workspaceId: "ws_1", name: "ui-control-bunx" },
      { workspaceId: ENGINE_GLOBAL_RUNTIME_CONFIG_ID, name: "ui-control-renamed" },
    ]));
    const workspace = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(workspace.mcp?.["omnirush-ui"]).toEqual({
      type: "local",
      command: BUNDLED.command,
      enabled: true,
      environment: { ...BUNDLED.environment, KEEP_ME: "1" },
    });
    // Other registry launches of the package move to the bundled launch too.
    expect(workspace.mcp?.["ui-control-bunx"]).toEqual({
      type: "local",
      command: BUNDLED.command,
      enabled: true,
      environment: BUNDLED.environment,
    });
    // User-authored entries, including other npx commands, are untouched.
    expect(workspace.mcp?.["user-tool"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
      enabled: true,
    });
    expect(workspace.mcp?.["user-remote"]).toEqual({ type: "remote", url: "https://mcp.example.com/mcp" });
    // Enablement is preserved: a disabled entry stays disabled after rewrite.
    expect((await readRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID)).mcp?.["ui-control-renamed"]).toEqual({
      type: "local",
      command: BUNDLED.command,
      enabled: false,
      environment: BUNDLED.environment,
    });

    // One-time: a second run finds nothing left to rewrite.
    expect(await migrateLegacyOmniRushUiMcpCommand(config, BUNDLED)).toEqual(NOTHING_TO_DO);
  });

  test("removes stored registry launches when no bundled launch is available, so the toggle cannot revive them", async () => {
    const config = await fixtureConfig();
    await seedRuntimeRow(config, "ws_1", {
      mcp: {
        "omnirush-ui": { type: "local", command: LEGACY, enabled: true },
        "already-off": { type: "local", command: ["pnpm", "dlx", "omnirush-ui-mcp"], enabled: false },
        "user-tool": { type: "local", command: ["node", "/opt/tools/mcp.mjs"], enabled: true },
      },
    });

    // cli.ts (standalone server) runs the migration without a bundled launch.
    expect(await migrateLegacyOmniRushUiMcpCommand(config, null)).toEqual({
      changed: true,
      rewritten: [],
      refreshed: [],
      removed: [
        { workspaceId: "ws_1", name: "omnirush-ui" },
        { workspaceId: "ws_1", name: "already-off" },
      ],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toEqual({
      "user-tool": { type: "local", command: ["node", "/opt/tools/mcp.mjs"], enabled: true },
    });
    expect(await migrateLegacyOmniRushUiMcpCommand(config, null)).toEqual(NOTHING_TO_DO);

    // Flipping the MCP switch finds no entry (the route answers 404) and does
    // not bring the npx command back.
    expect(await setMcpEnabled(config, "ws_1", "omnirush-ui", true)).toBe(false);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["omnirush-ui"]).toBeUndefined();

    // Re-adding the old command after the migration (a 1.0.x desktop against
    // an updated server, a pasted snippet, a plugin import) is refused.
    expect(await rejection(addMcp(config, "ws_1", "omnirush-ui", { type: "local", command: LEGACY, enabled: true })))
      .toMatchObject({ status: 400, code: "unsafe_mcp_command" });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["omnirush-ui"]).toBeUndefined();
  });

  test("refuses to enable a registry launch that is still stored; disabling it removes it", async () => {
    const config = await fixtureConfig();
    await seedRuntimeRow(config, "ws_1", {
      mcp: {
        "omnirush-ui": { type: "local", command: LEGACY, enabled: false },
        "ui-copy": { type: "local", command: LEGACY, enabled: true },
      },
    });

    expect(await rejection(setMcpEnabled(config, "ws_1", "omnirush-ui", true)))
      .toMatchObject({ status: 400, code: "unsafe_mcp_command" });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["omnirush-ui"])
      .toEqual({ type: "local", command: LEGACY, enabled: false });

    expect(await setMcpEnabled(config, "ws_1", "ui-copy", false)).toBe(true);
    // The write also drops the other leftover registry launch in the row.
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp).toBeUndefined();
  });

  test("does not touch runtime rows while the server is read-only", async () => {
    const config = await fixtureConfig();
    await seedRuntimeRow(config, "ws_1", {
      mcp: { "omnirush-ui": { type: "local", command: LEGACY, enabled: true } },
    });
    config.readOnly = true;

    expect(await migrateLegacyOmniRushUiMcpCommand(config, BUNDLED)).toEqual(NOTHING_TO_DO);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["omnirush-ui"]?.command).toEqual(LEGACY);
  });

  test("refreshes a bundled launch whose app path moved and leaves current ones alone", async () => {
    const config = await fixtureConfig();
    const moved = [
      "/Users/me/Downloads/OmniRush.ai.app/Contents/MacOS/OmniRush.ai",
      "/Users/me/Downloads/OmniRush.ai.app/Contents/Resources/omnirush-ui-mcp/index.mjs",
    ];
    const windowsLaunch = [
      "C:\\Users\\me\\AppData\\Local\\Programs\\OmniRush.ai\\OmniRush.ai.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\OmniRush.ai\\resources\\omnirush-ui-mcp\\index.mjs",
    ];
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "omnirush-ui": { type: "local", command: moved, enabled: true, environment: { ELECTRON_RUN_AS_NODE: "1" } },
        "windows-ui": { type: "local", command: windowsLaunch, enabled: true },
        "current-ui": { type: "local", command: BUNDLED.command, enabled: true, environment: BUNDLED.environment },
        "other-index": { type: "local", command: ["node", "/opt/tools/other-mcp/index.mjs"], enabled: true },
      },
    }));

    const result = await migrateLegacyOmniRushUiMcpCommand(config, BUNDLED);

    expect(result.rewritten).toEqual([]);
    expect(result.refreshed).toEqual([
      { workspaceId: "ws_1", name: "omnirush-ui" },
      { workspaceId: "ws_1", name: "windows-ui" },
    ]);
    const mcp = (await readRuntimeOpencodeConfig(config, "ws_1")).mcp ?? {};
    expect(mcp["omnirush-ui"]).toEqual({ type: "local", command: BUNDLED.command, enabled: true, environment: BUNDLED.environment });
    expect(mcp["windows-ui"]).toEqual({ type: "local", command: BUNDLED.command, enabled: true, environment: BUNDLED.environment });
    expect(mcp["current-ui"]).toEqual({ type: "local", command: BUNDLED.command, enabled: true, environment: BUNDLED.environment });
    expect(mcp["other-index"]).toEqual({ type: "local", command: ["node", "/opt/tools/other-mcp/index.mjs"], enabled: true });

    // Without a bundled launch, already-bundled entries are left as they are.
    expect(await migrateLegacyOmniRushUiMcpCommand(config, null)).toEqual(NOTHING_TO_DO);
  });
});
