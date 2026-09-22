import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  OPENCODE_CONFIG_COMPAT_HINT,
  OPENCODE_V2_PERMISSIONS_MESSAGE,
  OpencodeConfigCompatError,
  assertOpencodeConfigCompat,
  diagnoseOpencodeConfigCompat,
  findUnsupportedV2PermissionPaths,
  formatOpencodeConfigCompatFinding,
  globalOpencodeConfigFiles,
  parseOpencodeConfigErrorBody,
  workspaceOpencodeConfigFiles,
} from "./opencode-config-compat.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-opencode-config-compat-"));
  roots.push(root);
  return root;
}

async function writeConfig(path: string, content: string | Record<string, unknown>): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
}

type Logged = { level: "warn" | "error"; message: string; attributes?: Record<string, unknown> };

function recordingLogger(): { logger: { log: (level: "warn" | "error", message: string, attributes?: Record<string, unknown>) => void }; lines: Logged[] } {
  const lines: Logged[] = [];
  return {
    lines,
    logger: { log: (level, message, attributes) => { lines.push({ level, message, attributes }); } },
  };
}

describe("findUnsupportedV2PermissionPaths", () => {
  test("mirrors the engine: top-level and agent/agents/mode.<name>.permissions are fatal, permission is fine", () => {
    expect(findUnsupportedV2PermissionPaths({ permission: { bash: "deny" } })).toEqual([]);
    expect(findUnsupportedV2PermissionPaths({ permissions: { bash: "deny" } })).toEqual([["permissions"]]);
    // Presence is what the engine checks; the value does not matter.
    expect(findUnsupportedV2PermissionPaths({ permissions: null })).toEqual([["permissions"]]);
    expect(findUnsupportedV2PermissionPaths({
      agent: { build: { permissions: {} }, plan: { permission: {} } },
      agents: { review: { permissions: [] } },
      mode: { chat: { permissions: "deny" }, other: "not-a-record" },
    })).toEqual([
      ["agents", "review", "permissions"],
      ["agent", "build", "permissions"],
      ["mode", "chat", "permissions"],
    ]);
  });

  test("ignores non-record input and permissions keys nested anywhere else", () => {
    expect(findUnsupportedV2PermissionPaths(null)).toEqual([]);
    expect(findUnsupportedV2PermissionPaths([{ permissions: {} }])).toEqual([]);
    expect(findUnsupportedV2PermissionPaths("permissions")).toEqual([]);
    expect(findUnsupportedV2PermissionPaths({ mcp: { srv: { permissions: {} } }, agent: "x" })).toEqual([]);
  });
});

describe("diagnoseOpencodeConfigCompat", () => {
  test("scans the engine's global files and the workspace candidates, tolerating comments, missing and malformed files", async () => {
    const root = await createRoot();
    const globalDir = join(root, "global-config");
    const workspace = join(root, "workspace");
    const env = { ...process.env, OPENCODE_CONFIG_DIR: globalDir };

    expect(globalOpencodeConfigFiles(env)).toEqual([
      join(globalDir, "config.json"),
      join(globalDir, "opencode.json"),
      join(globalDir, "opencode.jsonc"),
    ]);
    expect(workspaceOpencodeConfigFiles(workspace)).toEqual([
      join(workspace, "opencode.jsonc"),
      join(workspace, "opencode.json"),
      join(workspace, ".opencode", "opencode.jsonc"),
      join(workspace, ".opencode", "opencode.json"),
    ]);

    // Nothing on disk yet: no findings, no throw.
    expect(await diagnoseOpencodeConfigCompat({ workspaceRoots: [workspace], env })).toEqual([]);

    await writeConfig(join(globalDir, "opencode.jsonc"), [
      "{",
      "  // comment and trailing comma are valid JSONC",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "permissions": { "bash": "deny" },',
      "}",
    ].join("\n"));
    await writeConfig(join(globalDir, "config.json"), "{ not json");
    await writeConfig(join(workspace, ".opencode", "opencode.json"), {
      permission: { webfetch: "deny" },
      agent: { build: { permissions: { bash: "allow" } } },
    });
    await writeConfig(join(workspace, "opencode.json"), { permission: { bash: "deny" } });

    const findings = await diagnoseOpencodeConfigCompat({ workspaceRoots: [workspace, workspace, " "], env });
    expect(findings).toEqual([
      {
        scope: "global",
        file: join(globalDir, "opencode.jsonc"),
        issues: [{ path: ["permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }],
      },
      {
        scope: "workspace",
        file: join(workspace, ".opencode", "opencode.json"),
        issues: [{ path: ["agent", "build", "permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }],
      },
    ]);
    expect(formatOpencodeConfigCompatFinding(findings[0]!)).toBe(
      `Configuration is invalid at ${join(globalDir, "opencode.jsonc")}: ${OPENCODE_V2_PERMISSIONS_MESSAGE} (permissions)`,
    );
  });
});

describe("assertOpencodeConfigCompat", () => {
  test("a global V2 permissions file throws with the engine's message, the file, and the fix", async () => {
    const root = await createRoot();
    const globalDir = join(root, "global-config");
    const file = join(globalDir, "opencode.json");
    await writeConfig(file, { permissions: { bash: "deny" } });
    const { logger, lines } = recordingLogger();

    let thrown: unknown;
    try {
      await assertOpencodeConfigCompat({ workspaceRoots: [join(root, "workspace")], env: { ...process.env, OPENCODE_CONFIG_DIR: globalDir }, logger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OpencodeConfigCompatError);
    if (!(thrown instanceof OpencodeConfigCompatError)) throw new Error("Expected OpencodeConfigCompatError");
    expect(thrown.code).toBe("opencode_config_invalid");
    expect(thrown.findings).toHaveLength(1);
    expect(thrown.message).toContain(`Configuration is invalid at ${file}`);
    expect(thrown.message).toContain(OPENCODE_V2_PERMISSIONS_MESSAGE);
    expect(thrown.message).toContain("(permissions)");
    expect(thrown.message).toContain(OPENCODE_CONFIG_COMPAT_HINT);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      attributes: { "opencode.config.scope": "global", "opencode.config.file": file, "opencode.config.issues": "permissions" },
    });
  });

  test("a workspace V2 permissions file only warns and returns the finding", async () => {
    const root = await createRoot();
    const globalDir = join(root, "global-config");
    const workspace = join(root, "workspace");
    const file = join(workspace, ".opencode", "opencode.jsonc");
    await writeConfig(join(globalDir, "opencode.json"), { permission: { bash: "deny" } });
    await writeConfig(file, { mode: { chat: { permissions: {} } } });
    const { logger, lines } = recordingLogger();

    const findings = await assertOpencodeConfigCompat({ workspaceRoots: [workspace], env: { ...process.env, OPENCODE_CONFIG_DIR: globalDir }, logger });

    expect(findings).toEqual([
      { scope: "workspace", file, issues: [{ path: ["mode", "chat", "permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      attributes: { "opencode.config.scope": "workspace", "opencode.config.file": file, "opencode.config.issues": "mode.chat.permissions" },
    });
  });
});

describe("parseOpencodeConfigErrorBody", () => {
  test("turns the engine's 400 ConfigInvalidError body into an actionable message", () => {
    const parsed = parseOpencodeConfigErrorBody({
      name: "ConfigInvalidError",
      data: {
        path: "/ws/.opencode/opencode.json",
        issues: [{ path: ["permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }, { path: ["agent", "build", "permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE }, "junk"],
      },
    });
    expect(parsed).toEqual({
      name: "ConfigInvalidError",
      file: "/ws/.opencode/opencode.json",
      message: `OpenCode configuration is invalid at /ws/.opencode/opencode.json: ${OPENCODE_V2_PERMISSIONS_MESSAGE} (permissions); ${OPENCODE_V2_PERMISSIONS_MESSAGE} (agent.build.permissions)`,
      issues: [
        { path: ["permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE },
        { path: ["agent", "build", "permissions"], message: OPENCODE_V2_PERMISSIONS_MESSAGE },
      ],
    });
  });

  test("keeps a plain message, treats the engine's 'config' placeholder as no file, and covers the JSON error", () => {
    expect(parseOpencodeConfigErrorBody({ name: "ConfigJsonError", data: { path: "/ws/opencode.json", message: "Unexpected token" } })).toEqual({
      name: "ConfigJsonError",
      file: "/ws/opencode.json",
      message: "OpenCode configuration is invalid at /ws/opencode.json: Unexpected token",
      issues: [],
    });
    expect(parseOpencodeConfigErrorBody({ name: "ConfigInvalidError", data: { path: "config" } })).toEqual({
      name: "ConfigInvalidError",
      file: null,
      message: "OpenCode configuration is invalid",
      issues: [],
    });
  });

  test("returns null for every other engine error body", () => {
    expect(parseOpencodeConfigErrorBody({ name: "UnknownError", data: { message: "boom" } })).toBeNull();
    expect(parseOpencodeConfigErrorBody({ name: "ConfigRemoteAuthError", data: { url: "x", remote: "y" } })).toBeNull();
    expect(parseOpencodeConfigErrorBody({ message: "fetch failed" })).toBeNull();
    expect(parseOpencodeConfigErrorBody("ConfigInvalidError")).toBeNull();
    expect(parseOpencodeConfigErrorBody(null)).toBeNull();
  });
});
