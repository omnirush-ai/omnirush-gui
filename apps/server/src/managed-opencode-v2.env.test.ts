import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { v2BoxBits } from "./engine-v2-preview.js";
import { omnirushBoxNextPluginPath } from "./omnirush-extensions-plugin-path.js";

import { assertEngineGates, createManagedOpencodeV2Server, engineV2SpawnEnv } from "./managed-opencode-v2.js";

const posix = process.platform === "win32" ? test.skip : test;

posix("the v2 engine gets its own empty config home, not the user's global opencode config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-env-"));
  try {
    const record = join(dir, "env.txt");
    const bin = join(dir, "fake-v2");
    await writeFile(bin, `#!/bin/sh\nenv > "${record}"\nexit 3\n`);
    await chmod(bin, 0o755);
    const userConfig = join(dir, "user-config");
    await createManagedOpencodeV2Server({ bin, rootDir: join(dir, "state"), bootTimeoutMs: 5_000, env: { XDG_CONFIG_HOME: userConfig } })
      .then((server) => server.close(), () => undefined);
    const env = await readFile(record, "utf8");
    const configHome = /^XDG_CONFIG_HOME=(.*)$/m.exec(env)?.[1];
    expect(configHome).toBe(join(dir, "state", "xdg-config"));
    // Only agent shells get the user's config home back (omnirush-session-next.ts).
    expect(env.replace(/^OMNIRUSH_USER_XDG_CONFIG_HOME=.*$/m, "")).not.toContain(userConfig);
    expect(env).toMatch(/^OMNIRUSH_USER_XDG_CONFIG_HOME=.*user-config$/m);
    // Project config stays on (engine patch 0003 keeps only its descriptive keys); the gates are on.
    expect(env).not.toMatch(/^OPENCODE_DISABLE_PROJECT_CONFIG=/m);
    expect(env).toMatch(/^OMNIRUSH_GATE_PROVIDERS=omnirush,omnirush-claude$/m);
    expect(env).toMatch(/^OMNIRUSH_GATE_MCP=$/m);
    expect(env).toMatch(/^OMNIRUSH_NO_SYSTEM_CONFIG=1$/m);
    expect(env).toMatch(/^OPENCODE_DISABLE_AUTOUPDATE=1$/m);
    expect(/^XDG_DATA_HOME=(.*)$/m.exec(env)?.[1]).toBe(join(dir, "state", "data"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the engine's gates are applied last and a spawn without them is refused", () => {
  const env = engineV2SpawnEnv({ OMNIRUSH_GATE_PROVIDERS: "*", OMNIRUSH_GATE_MCP: "anything", OMNIRUSH_NO_SYSTEM_CONFIG: "0", PATH: "/bin" });
  expect(env).toMatchObject({ OMNIRUSH_GATE_PROVIDERS: "omnirush,omnirush-claude", OMNIRUSH_GATE_MCP: "", OMNIRUSH_NO_SYSTEM_CONFIG: "1", PATH: "/bin" });
  expect(() => assertEngineGates({ PATH: "/bin" })).toThrow(/gates are missing/);
  expect(() => assertEngineGates({ OMNIRUSH_GATE_PROVIDERS: "omnirush", OMNIRUSH_NO_SYSTEM_CONFIG: "1" })).toThrow(/gates are missing/);
});

posix("the stock websearch tool searches through Exa only while the server's switch is on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-ws-"));
  try {
    const bin = join(dir, "fake-v2");
    await writeFile(bin, "#!/bin/sh\nexit 3\n");
    await chmod(bin, 0o755);
    for (const on of [true, false]) {
      const rootDir = join(dir, String(on));
      await createManagedOpencodeV2Server({ bin, rootDir, bootTimeoutMs: 5_000, webSearch: () => on }).then((server) => server.close(), () => undefined);
      const config = JSON.parse(await readFile(join(rootDir, "config", "opencode.json"), "utf8"));
      expect(config.websearch).toEqual(on ? { provider: "exa" } : undefined);
      expect(config).toMatchObject({ share: "disabled", update: "disable" });
      // Only the app's providers may run a model (the CLI's policies), beside the gate env.
      expect(config.policies).toEqual([
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "omnirush", effect: "allow" },
        { action: "provider.use", resource: "omnirush-claude", effect: "allow" },
      ]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

posix("the 2.x engine runs the box shell and the 2.x box plugin while a workspace's box is on, and neither when it is off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-box-"));
  try {
    const bin = join(dir, "fake-v2");
    await writeFile(bin, "#!/bin/sh\nexit 3\n");
    await chmod(bin, 0o755);
    const shell = join(dir, "box", "shell-desktop", "bash");
    // BoxService.engineBits as the server hands it over (a 1.x plugin file), mapped for the 2.x engine.
    const engineBits = { shell, plugin: join(dir, "omnirush-box.ts") };
    expect(v2BoxBits(engineBits)).toEqual({ shell, plugin: omnirushBoxNextPluginPath() });
    expect(v2BoxBits(null)).toBeNull();
    for (const on of [true, false]) {
      const rootDir = join(dir, String(on));
      await createManagedOpencodeV2Server({ bin, rootDir, bootTimeoutMs: 5_000, box: async () => v2BoxBits(on ? engineBits : null) })
        .then((server) => server.close(), () => undefined);
      const config = JSON.parse(await readFile(join(rootDir, "config", "opencode.json"), "utf8"));
      expect(config.shell).toEqual(on ? shell : undefined);
      // 2.x loads plugins from directories: the box one re-exports omnirush-box-next.
      const boxDirs = (config.plugins as string[]).filter((entry) => entry.endsWith("omnirush-box-next"));
      expect(boxDirs.length).toBe(on ? 1 : 0);
      if (on) expect(await readFile(join(boxDirs[0]!, "server.js"), "utf8")).toContain(pathToFileURL(omnirushBoxNextPluginPath()).href);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Claude provider is an AI SDK file package of the catalog's Claude models, with no request timeout", async () => {
  const { claudeEngineProvider } = await import("./omnirush-runtime-config.js");
  expect(claudeEngineProvider([], {})).toBeNull();
  const spec = claudeEngineProvider([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }], { grantURL: "http://127.0.0.1:1/omnirush-claude/turn", grantKey: "k" });
  expect(spec).toMatchObject({ id: "omnirush-claude", settings: { grantURL: "http://127.0.0.1:1/omnirush-claude/turn", grantKey: "k", timeout: false } });
  expect(spec?.package).toMatch(/^aisdk:file:\/\/.*claude-provider\/index\.js$/);
  expect(spec?.models.map((model) => [model.id, model.name])).toEqual([["claude-opus-5-5", "Claude Opus 5.5"]]);
});
