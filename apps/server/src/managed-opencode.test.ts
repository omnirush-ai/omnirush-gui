import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import constants from "../../../constants.json" with { type: "json" };
import { createManagedOpencodeServer, freezeSandboxTurn, type ManagedOpencodeSandbox } from "./managed-opencode.js";
import { createManagedOpencodeV2Server } from "./managed-opencode-v2.js";
import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";
import { SandboxError } from "./vendor/sandbox/sandbox.js";

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

type DockerLogEntry = { argv?: string[]; host?: string; token?: string | null };

/**
 * A stand-in for the Docker CLI (OMNIRUSH_SANDBOX_DOCKER): answers version,
 * info and image inspect, records every call in FAKE_DOCKER_LOG, and for the
 * engine's `run` listens where Docker publishes the engine and prints the
 * line `opencode serve` prints inside the container.
 */
async function writeFakeDocker(root: string): Promise<string> {
  return writeExecutable(root, "fake-docker.mjs", [
    "import { appendFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const record = (entry) => appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(entry)}\\n`);",
    "record({ argv: args });",
    "const reply = (value) => { console.log(JSON.stringify(value)); process.exit(0); };",
    "if (process.env.FAKE_DOCKER_DOWN) { console.error('Cannot connect to the Docker daemon'); process.exit(1); }",
    "if (args[0] === 'version') reply({ Server: { Version: '29.0.0', Os: 'linux', Arch: 'amd64' } });",
    "if (args[0] === 'info') reply({ OperatingSystem: 'Docker Desktop' });",
    "if (args[0] === 'image') reply({ Id: `sha256:${'a'.repeat(64)}`, RepoDigests: [`ghcr.io/omnirush-ai/sandbox@sha256:${'b'.repeat(64)}`], Os: 'linux', Architecture: 'amd64' });",
    // `run --entrypoint test …` asks whether the engine is already in its volume: it is.
    "if (args[0] !== 'run' || args.includes('--entrypoint')) process.exit(0);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "record({ token: process.env.OMNIRUSH_SERVER_TOKEN ?? null });",
    "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch(request) {",
    "  record({ host: request.headers.get('host') });",
    "  if (new URL(request.url).pathname === '/api/event') return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });",
    "  return Response.json({});",
    "} });",
    "console.log(`opencode server listening on http://0.0.0.0:${port}`);",
    "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
  ]);
}

async function dockerLog(path: string): Promise<DockerLogEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line): DockerLogEntry => JSON.parse(line));
}

/** The values after each `flag` in an argv. */
function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1]] : []));
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Two workspaces, the app's data folder with its runtime config file, and an engine binary that must never run on this machine. */
async function sandboxFixture() {
  const root = await createRoot();
  const project = join(root, "project");
  const other = join(root, "other");
  const appDir = join(root, "app");
  for (const dir of [project, other, appDir]) await mkdir(dir, { recursive: true });
  const runtimeConfig = join(appDir, "runtime-opencode-config.json");
  await writeFile(runtimeConfig, "{}\n");
  const engineMarker = join(root, "engine-ran-on-host");
  const bin = await writeExecutable(root, "opencode", [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(engineMarker)}, 'ran');`,
  ]);
  const log = join(root, "docker.log");
  const env: Record<string, string | undefined> = {
    OMNIRUSH_SANDBOX: "docker",
    OMNIRUSH_SANDBOX_DOCKER: await writeFakeDocker(root),
    OMNIRUSH_SANDBOX_IMAGE: "ghcr.io/omnirush-ai/sandbox:1",
    OMNIRUSH_SANDBOX_NETWORK: "bridge",
    DOCKER_HOST: undefined,
    FAKE_DOCKER_LOG: log,
    OPENCODE_CONFIG: runtimeConfig,
  };
  return { project, other, appDir, engineMarker, bin, log, env };
}

describe("managed OpenCode in the Docker sandbox (OMNIRUSH_SANDBOX=docker)", () => {
  test("runs the engine through docker: loopback URL, the sandbox's record, workspace mounts, secrets by name only, container removed on close", async () => {
    const fixture = await sandboxFixture();
    const token = `server-token-${randomUUID()}`;
    const version = constants.opencodeVersion.replace(/^v/, "");
    const managed = await createManagedOpencodeServer({
      bin: fixture.bin,
      dialect: "v2",
      cwd: fixture.project,
      env: { ...fixture.env, OMNIRUSH_SERVER_TOKEN: token },
      sandboxWorkspaces: [fixture.project, fixture.other],
    });
    let run: string[] = [];
    try {
      expect(managed.sandbox?.stateDir).toBe(join(fixture.appDir, "sandbox"));
      expect(managed.sandbox?.manifest).toMatchObject({
        schema: 1,
        mode: "docker",
        app: "desktop",
        network: "bridge",
        workdir: fixture.project,
        workspaces: [fixture.project, fixture.other],
        image: { digest: `sha256:${"b".repeat(64)}` },
        engine: { name: "opencode", version, source: "npm", package: `@opencode/cli-linux-x64-baseline@${version}` },
      });
      expect(managed.execution.sandbox).toEqual(managed.sandbox?.manifest);
      expect(managed.execution.command).toBe(fixture.bin);

      run = (await dockerLog(fixture.log)).flatMap((entry) => entry.argv?.[0] === "run" && !entry.argv.includes("--entrypoint") ? [entry.argv] : []).at(0) ?? [];
      const port = flagValues(run, "--port")[0];
      // The engine and its arguments run from the image, published on this machine's loopback only.
      expect(flagValues(run, "--publish")).toEqual([`127.0.0.1:${port}:${port}`]);
      expect(run.slice(run.indexOf(`sha256:${"a".repeat(64)}`) + 1)).toEqual(["/opt/omnirush/engine/opencode", "serve", "--hostname", "0.0.0.0", "--port", port]);
      // The workspaces and the engine's data read-write at their paths (not the sandbox folder itself,
      // which holds the turn snapshots); the app's runtime config and plugins read-only.
      const mounts = flagValues(run, "--mount");
      const plugins = dirname(omnirushPluginPath("omnirush-engine2"));
      for (const dir of [fixture.project, fixture.other, join(fixture.appDir, "sandbox", "data"), join(fixture.appDir, "sandbox", "state")]) expect(mounts).toContain(`type=bind,src=${dir},dst=${dir}`);
      expect(mounts).not.toContain(`type=bind,src=${join(fixture.appDir, "sandbox")},dst=${join(fixture.appDir, "sandbox")}`);
      for (const dir of [fixture.appDir, plugins]) expect(mounts).toContain(`type=bind,src=${dir},dst=${dir},readonly`);
      // Secrets are named on Docker's command line and travel in its environment.
      expect(flagValues(run, "-e")).toEqual(expect.arrayContaining(["OMNIRUSH_SERVER_TOKEN", "OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION", "OPENCODE_PASSWORD"]));
      const argv = JSON.stringify((await dockerLog(fixture.log)).flatMap((entry) => entry.argv ?? []));
      for (const secret of [token, managed.password, Buffer.from(`${managed.username}:${managed.password}`).toString("base64")]) expect(argv).not.toContain(secret);
      expect((await dockerLog(fixture.log)).some((entry) => entry.token === token)).toBe(true);
      // The adapter reaches the engine at the URL mapped to this machine's loopback, not the 0.0.0.0 it printed.
      await until(async () => (await dockerLog(fixture.log)).some((entry) => entry.host), "the adapter's first engine request");
      const hosts = (await dockerLog(fixture.log)).flatMap((entry) => entry.host ?? []);
      expect(new Set(hosts)).toEqual(new Set([`127.0.0.1:${port}`]));
    } finally {
      await managed.close();
    }
    const container = flagValues(run, "--name")[0];
    expect((await dockerLog(fixture.log)).map((entry) => entry.argv)).toContainEqual(["rm", "-f", container]);
    expect(existsSync(fixture.engineMarker)).toBe(false);
  });

  test("a sandbox that cannot start fails the engine's start, once, and never runs the engine on this machine", async () => {
    const fixture = await sandboxFixture();
    let thrown: unknown;
    try {
      await createManagedOpencodeServer({ bin: fixture.bin, dialect: "v2", cwd: fixture.project, env: { ...fixture.env, FAKE_DOCKER_DOWN: "1" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SandboxError);
    if (!(thrown instanceof SandboxError)) throw new Error("Expected a SandboxError");
    expect(thrown.code).toBe("unavailable");
    expect((await dockerLog(fixture.log)).map((entry) => entry.argv)).toEqual([["version", "--format", "{{json .}}"]]);
    expect(existsSync(fixture.engineMarker)).toBe(false);
  });

  test("with OMNIRUSH_SANDBOX unset the engine starts on this machine as before, and Docker is never asked", async () => {
    const root = await createRoot();
    const log = join(root, "docker.log");
    const bin = await writeExecutable(root, "host-engine.mjs", [
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ ok: true }) });",
      "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
      "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    ]);
    const managed = await createManagedOpencodeServer({
      bin,
      cwd: root,
      // Unset even when the environment running the tests sets it.
      env: { OMNIRUSH_SANDBOX: undefined, OMNIRUSH_SANDBOX_DOCKER: await writeFakeDocker(root), FAKE_DOCKER_LOG: log },
    });
    try {
      expect(managed.sandbox).toBeUndefined();
      expect("sandbox" in managed.execution).toBe(false);
      expect(managed.execution.command).toBe(bin);
      expect(managed.url).toStartWith("http://127.0.0.1:");
      expect((await fetch(managed.url)).ok).toBe(true);
    } finally {
      await managed.close();
    }
    expect(existsSync(log)).toBe(false);
  });

  test("each prompt freezes its session's next turn and saves it in the background; a failure is logged, never thrown", async () => {
    const root = await createRoot();
    const stateDir = join(root, "sandbox");
    const frozen: string[] = [];
    const saved: string[] = [];
    const logged: string[] = [];
    let failFreeze = false;
    let failSave = false;
    let releaseSaves = () => {};
    const savesReleased = new Promise<void>((resolve) => { releaseSaves = resolve; });
    const sandbox: Pick<ManagedOpencodeSandbox, "freeze" | "stateDir"> = {
      stateDir,
      freeze: async (label) => {
        if (failFreeze) throw new SandboxError("Could not freeze the sandbox: paused");
        frozen.push(label);
        return {
          label,
          changed: 1,
          save: async (outDir) => {
            await savesReleased;
            if (failSave) throw new SandboxError("Could not export the sandbox snapshot");
            await mkdir(outDir, { recursive: true });
            await writeFile(join(outDir, `${label}.json`), "{}\n");
            saved.push(join(outDir, `${label}.json`));
            return {
              schema: 1,
              label,
              image: { ref: "ghcr.io/omnirush-ai/sandbox:1", id: "sha256:a", digest: null, pinned: null, platform: "linux/amd64" },
              changed: 1, added: 1, modified: 0, deleted: [], tar: null, bytes: 0, sha256: null,
            };
          },
          discard: async () => null,
        };
      },
    };
    const log = (message: string) => { logged.push(message); };
    const first = `ses_${randomUUID().replace(/-/g, "")}`;
    const second = `ses_${randomUUID().replace(/-/g, "")}`;

    await freezeSandboxTurn(sandbox, first, log);
    await freezeSandboxTurn(sandbox, first, log);
    await freezeSandboxTurn(sandbox, second, log);
    // The prompt waited for the freeze only: nothing is saved yet.
    expect(frozen).toEqual(["turn-1", "turn-2", "turn-1"]);
    expect(saved).toEqual([]);
    releaseSaves();
    await until(async () => saved.length === 3, "the saves");
    expect(readdirSync(join(stateDir, "snapshots", first)).sort()).toEqual(["turn-1.json", "turn-2.json"]);

    // After a restart a session goes on from the last turn its folder holds.
    const resumed = `ses_${randomUUID().replace(/-/g, "")}`;
    await mkdir(join(stateDir, "snapshots", resumed), { recursive: true });
    await writeFile(join(stateDir, "snapshots", resumed, "turn-4.json"), "{}\n");
    await freezeSandboxTurn(sandbox, resumed, log);
    expect(frozen.at(-1)).toBe("turn-5");
    await until(async () => saved.length === 4, "the resumed turn's save");
    expect(readdirSync(join(stateDir, "snapshots", resumed)).sort()).toEqual(["turn-4.json", "turn-5.json"]);

    // A session id never names a folder outside the snapshots folder.
    await freezeSandboxTurn(sandbox, "../../escape", log);
    expect(frozen).toHaveLength(4);

    failSave = true;
    await freezeSandboxTurn(sandbox, second, log);
    await until(async () => logged.includes("Sandbox turn snapshot could not be saved."), "the failed save's log");
    failFreeze = true;
    await freezeSandboxTurn(sandbox, second, log);
    expect(logged).toEqual(["Sandbox turn snapshot could not be saved.", "Sandbox turn could not be frozen."]);
  });

  test("the vendored sandbox matches its PARITY.sha256 (the same files ship in the CLI)", () => {
    const dir = join(import.meta.dir, "vendor", "sandbox");
    const lines = readFileSync(join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    const listed = Object.fromEntries(lines.map((line) => line.split(/\s+/).reverse()));
    const files = readdirSync(dir).filter((name) => name !== "PARITY.sha256").sort();
    expect(Object.keys(listed).sort()).toEqual(files);
    // A mismatch: change src/ in omnirush-sandbox and run its scripts/sync.mjs, never these copies.
    expect(Object.fromEntries(files.map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]))).toEqual(listed);
  });
});
