import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createManagedOpencodeServer,
  createManagedProcessClose,
  engineStartTimeoutMs,
  pluginsNoDepsEnv,
  type ManagedChildProcess,
} from "./managed-opencode.js";
import { createManagedOpencodeV2Server } from "./managed-opencode-v2.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-managed-opencode-"));
  roots.push(root);
  return root;
}

async function writeExecutable(root: string, name: string, lines: string[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, ["#!/usr/bin/env bun", ...lines].join("\n"));
  await chmod(path, 0o755);
  return path;
}

describe("managed OpenCode startup", () => {
  test("gives the next engine a policy-only credential without inheriting the client credential", async () => {
    const root = await createRoot();
    const bin = await writeExecutable(root, "policy-env.mjs", [
      "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {",
      "  if (new URL(request.url).pathname === '/env') return Response.json({ policy: process.env.OMNIRUSH_POLICY_TOKEN, client: process.env.OMNIRUSH_SERVER_TOKEN ?? null });",
      "  return Response.json({ healthy: true, version: 'test', pid: process.pid });",
      "} });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeV2Server({
      bin, rootDir: root,
      env: { OMNIRUSH_SERVER_TOKEN: "must-stay-private", OMNIRUSH_POLICY_TOKEN: "policy-only-test-token" },
    });
    try {
      expect(await managed.fetchJson("/env")).toEqual({ status: 200, json: { policy: "policy-only-test-token", client: null } });
    } finally { await managed.close(); }
  });

  test("the next engine reads a project's descriptive config; its gates are on", async () => {
    const root = await createRoot();
    const bin = await writeExecutable(root, "project-config-env.mjs", [
      "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {",
      "  if (new URL(request.url).pathname === '/env') return Response.json({ a: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null, b: process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? null, gate: process.env.OMNIRUSH_GATE_PROVIDERS ?? null });",
      "  return Response.json({ healthy: true, version: 'test', pid: process.pid });",
      "} });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeV2Server({ bin, rootDir: root, env: {} });
    try {
      expect(await managed.fetchJson("/env")).toEqual({ status: 200, json: { a: null, b: null, gate: "omnirush,omnirush-claude" } });
    } finally { await managed.close(); }
  });

  test("passes the model-catalog fetch switch to the next engine", async () => {
    const root = await createRoot();
    const bin = await writeExecutable(root, "catalog-env.mjs", [
      "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {",
      "  if (new URL(request.url).pathname === '/env') return Response.json({ disableFetch: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? null });",
      "  return Response.json({ healthy: true, version: 'test', pid: process.pid });",
      "} });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeV2Server({
      bin, rootDir: root,
      env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
    });
    try {
      expect(await managed.fetchJson("/env")).toEqual({ status: 200, json: { disableFetch: "1" } });
    } finally { await managed.close(); }
  });

  test("spawns the engine with npm audit disabled so first-run installs never wait on the advisories endpoint", async () => {
    const root = await createRoot();
    const defaultDumpPath = join(root, "default-env.log");
    const overrideDumpPath = join(root, "override-env.log");
    const bin = await writeExecutable(root, "dump-npm-audit-env.mjs", [
      "import { writeFileSync } from 'node:fs';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "writeFileSync(process.env.ENV_DUMP_PATH, process.env.npm_config_audit ?? '<unset>');",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);

    const managedDefault = await createManagedOpencodeServer({ bin, cwd: root, env: { ENV_DUMP_PATH: defaultDumpPath } });
    expect(await readFile(defaultDumpPath, "utf8")).toBe("false");
    await managedDefault.close();

    const managedOverride = await createManagedOpencodeServer({
      bin,
      cwd: root,
      env: { ENV_DUMP_PATH: overrideDumpPath, npm_config_audit: "true" },
    });
    expect(await readFile(overrideDumpPath, "utf8")).toBe("true");
    await managedOverride.close();
  });

  test("spawns the engine with session sharing off, whatever the caller's environment says", async () => {
    const root = await createRoot();
    const dumpPath = join(root, "share-env.json");
    const bin = await writeExecutable(root, "dump-share-env.mjs", [
      "import { writeFileSync } from 'node:fs';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "writeFileSync(process.env.ENV_DUMP_PATH, JSON.stringify({ disable: process.env.OPENCODE_DISABLE_SHARE, auto: process.env.OPENCODE_AUTO_SHARE }));",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeServer({
      bin,
      cwd: root,
      env: { ENV_DUMP_PATH: dumpPath, OPENCODE_DISABLE_SHARE: "0", OPENCODE_AUTO_SHARE: "1" },
    });
    try {
      expect(JSON.parse(await readFile(dumpPath, "utf8"))).toEqual({ disable: "1", auto: "false" });
    } finally { await managed.close(); }
  });

  test("waits for inherited diagnostic streams before retrying a code-1 EADDRINUSE exit", async () => {
    const root = await createRoot();
    const attemptsPath = join(root, "attempts.log");
    const markerPath = join(root, "first-attempt");
    const diagnosticPath = join(root, "delayed-eaddrinuse.mjs");
    await writeFile(diagnosticPath, [
      "const port = process.argv[2];",
      "setTimeout(() => console.error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), 50);",
    ].join("\n"));
    const bin = await writeExecutable(root, "retry-eaddrinuse.mjs", [
      "import { spawn } from 'node:child_process';",
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "appendFileSync(process.env.ATTEMPTS_PATH, `start:${port}\\n`);",
      "if (!existsSync(process.env.MARKER_PATH)) {",
      "  writeFileSync(process.env.MARKER_PATH, 'claimed');",
      "  spawn(process.execPath, [process.env.DIAGNOSTIC_PATH, String(port)], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
      "  process.exit(1);",
      "}",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { appendFileSync(process.env.ATTEMPTS_PATH, 'SIGTERM\\n'); server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeServer({
      bin,
      cwd: root,
      env: { ATTEMPTS_PATH: attemptsPath, DIAGNOSTIC_PATH: diagnosticPath, MARKER_PATH: markerPath },
    });

    await managed.close();

    const lines = (await readFile(attemptsPath, "utf8")).trim().split("\n");
    const ports = lines.filter((line) => line.startsWith("start:")).map((line) => line.slice("start:".length));
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);
    expect(lines.filter((line) => line === "SIGTERM")).toHaveLength(1);
  });

  test("keeps an unknown code-1 exit actionable and does not retry it", async () => {
    const root = await createRoot();
    const attemptsPath = join(root, "attempts.log");
    const bin = await writeExecutable(root, "unknown-code-one.mjs", [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.ATTEMPTS_PATH, 'start\\n');",
      "console.log('startup diagnostics from stdout');",
      "console.error('fatal provider configuration mismatch');",
      "process.exit(1);",
    ]);
    let thrown: unknown;

    try {
      await createManagedOpencodeServer({ bin, cwd: root, env: { ATTEMPTS_PATH: attemptsPath } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("Expected managed OpenCode startup to fail");
    expect(thrown.message).toContain("OmniRush server exited with code 1");
    expect(thrown.message).toContain("startup diagnostics from stdout");
    expect(thrown.message).toContain("fatal provider configuration mismatch");
    expect((await readFile(attemptsPath, "utf8")).trim().split("\n")).toEqual(["start"]);
  });
});

describe("managed OpenCode on slow machines (Windows)", () => {
  test("the start wait is longer on Windows and can be set", () => {
    expect(engineStartTimeoutMs({}, "win32")).toBe(60_000);
    expect(engineStartTimeoutMs({}, "linux")).toBe(15_000);
    expect(engineStartTimeoutMs({ OMNIRUSH_ENGINE_START_TIMEOUT_MS: "90000" }, "linux")).toBe(90_000);
    expect(engineStartTimeoutMs({ OMNIRUSH_ENGINE_START_TIMEOUT_MS: "soon" }, "darwin")).toBe(15_000);
  });

  test("a start that never listens fails with the start timeout", async () => {
    const root = await createRoot();
    const bin = await writeExecutable(root, "never-listens.mjs", ["setInterval(() => {}, 1000);"]);
    const error = await createManagedOpencodeServer({ bin, cwd: root, env: { OMNIRUSH_ENGINE_START_TIMEOUT_MS: "300" } })
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toBe("Timeout waiting for OmniRush server after 300ms");
  });

  function stubbornChild(): ManagedChildProcess & { signals: (NodeJS.Signals | number | undefined)[] } {
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    return {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      killed: false,
      signals,
      kill: (signal) => { signals.push(signal); return true; },
      once: () => undefined,
    };
  }

  test("close succeeds when the process is gone but its exit event has not arrived", async () => {
    const child = stubbornChild();
    const lifecycle = createManagedProcessClose(child, { termTimeoutMs: 5, killTimeoutMs: 5, processExists: () => false });
    await lifecycle.close();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("close still reports a process that is really still running", async () => {
    const child = stubbornChild();
    const lifecycle = createManagedProcessClose(child, { termTimeoutMs: 5, killTimeoutMs: 5, processExists: () => true });
    await expect(lifecycle.close()).rejects.toThrow("Managed OmniRush process did not exit after SIGKILL");
  });

  test("our bundled plugins are named to the engine, also by their real path", () => {
    const env = pluginsNoDepsEnv(["/app/link/a.js", "/app/b.js", "/gone/c.js"], (file) => {
      if (file === "/gone/c.js") throw new Error("ENOENT");
      return file.replace("/link", "/real");
    });
    expect(env.OMNIRUSH_PLUGINS_NO_DEPS?.split("\n")).toEqual(["/app/link/a.js", "/app/real/a.js", "/app/b.js", "/gone/c.js"]);
    expect(pluginsNoDepsEnv([])).toEqual({});
  });
});
