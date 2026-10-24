import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Box, boxKey, containerName, containerRoot, createArgs, credentialPath, filterChanges, helperPath, installShell, parseDiff, parseSize, rt, setToolsRoot, singleFileTar, wslPath } from "./box.js";
import { readBoxSettings } from "./desktop.js";
import { detectStack, imageFor } from "./images.js";
import { boxRun, engineConfig, gcInBackground, mapToBox, pullInBackground, pullLog, pullMarker, rememberServerDefault, resolveMode, serverDefault, watchServerDefault, type BoxRun } from "./launch.js";
import { clearLayerSizes, layerSizes, parseManifestSizes, parsePullLog, pullProgress } from "./pull-progress.js";
import { DESKTOP_PROJECTS_FILE } from "./plugin-lib.js";
import { candidates, detectRuntime, explainFailure, probe, probeWsl, wslLauncher, type RunCommand } from "./runtime.js";
import { BoxService, runtimeWhy, type BoxWorkspace } from "./service.js";
import { OmniRushBox } from "../opencode-plugins/omnirush-box.js";

const dirs: string[] = [];
const savedEnv = { ...process.env };

async function temp(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `omnirush-box-${name}-`));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  setToolsRoot(null);
});

afterEach(async () => {
  process.env = { ...savedEnv };
  setToolsRoot(null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const HOST_GOOS = process.platform === "win32" ? "windows" : process.platform;
const HOST_GOARCH = process.arch === "arm64" ? "arm64" : "amd64";

/** A helpers folder with this machine's boxsh and both boxd files (empty stand-ins). */
async function helpers(): Promise<string> {
  const dir = await temp("bin");
  await mkdir(join(dir, `${HOST_GOOS}-${HOST_GOARCH}`), { recursive: true });
  await writeFile(join(dir, `${HOST_GOOS}-${HOST_GOARCH}`, process.platform === "win32" ? "boxsh.exe" : "boxsh"), "#!/bin/sh\n");
  for (const arch of ["amd64", "arm64"]) {
    await mkdir(join(dir, `linux-${arch}`), { recursive: true });
    await writeFile(join(dir, `linux-${arch}`, "boxd"), "");
  }
  return dir;
}

describe("box runtime", () => {
  test("a Windows docker.exe seen from WSL is skipped with the reason, never used", () => {
    const list = candidates({ platform: "linux", home: "/home/u", env: { PATH: "/usr/bin:/mnt/c/Program Files/Docker/Docker/resources/bin" }, wsl: true, exists: (file) => file.startsWith("/mnt/c/") && file.endsWith("/docker") });
    expect(list).toHaveLength(1);
    expect(list[0]!.skipped).toContain("WSL");
  });

  test("OMNIRUSH_BOX_RUNTIME as a path is the only candidate", () => {
    expect(candidates({ platform: "linux", env: { OMNIRUSH_BOX_RUNTIME: "/opt/podman/bin/podman", PATH: "/usr/bin" }, exists: () => true })).toEqual([{ name: "podman", bin: "/opt/podman/bin/podman" }]);
  });

  test("failures read as one line for the user", () => {
    expect(explainFailure("docker", { code: 1, stderr: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" })).toContain("docker group");
    const mac = explainFailure("docker", { code: 1, stderr: "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock" }, { platform: "darwin", env: {}, exists: () => true });
    expect(mac).toContain("another macOS user");
    expect(mac).not.toMatch(/usermod|docker group/);
    expect(explainFailure("docker", { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" }, { platform: "darwin" })).toContain("start Docker Desktop");
    expect(explainFailure("docker", { code: -1, stderr: "", error: "ENOENT" })).toBe("docker is not installed");
    // Docker 29's wording, and a stopped daemon told by its missing socket whatever the words.
    const d29 = "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory";
    expect(explainFailure("docker", { code: 1, stderr: d29 }, { platform: "linux", env: {}, exists: () => false })).toBe("the Docker daemon is not running");
    expect(explainFailure("docker", { code: 1, stderr: "some new wording" }, { platform: "darwin", env: {}, home: "/Users/sam", exists: () => false })).toContain("start Docker Desktop");
    const said = explainFailure("docker", { code: 1, stderr: `docker: ${"wordy ".repeat(60)}end` }, { platform: "linux", env: {}, exists: () => true });
    expect(said.length <= 220 && said.endsWith("wordy…")).toBe(true);
  });

  test("a docker probe reads `docker info`; a remote DOCKER_HOST is refused", async () => {
    const run: RunCommand = async () => ({ code: 0, stdout: JSON.stringify({ OSType: "linux", ServerVersion: "27.1", Architecture: "x86_64", OperatingSystem: "Docker Desktop", SecurityOptions: [] }), stderr: "" });
    expect(await probe({ name: "docker", bin: "/usr/bin/docker" }, { run, platform: "darwin", env: {} })).toMatchObject({ ok: true, flavor: "desktop", vm: true, version: "27.1" });
    expect(await probe({ name: "docker", bin: "/usr/bin/docker" }, { run, env: { DOCKER_HOST: "ssh://elsewhere" } })).toMatchObject({ ok: false });
  });

  test("no runtime: one reason per platform, cached for the next ask", async () => {
    const home = await temp("home");
    let calls = 0;
    const run: RunCommand = async () => { calls += 1; return { code: 0, stdout: "{}", stderr: "" }; };
    const result = await detectRuntime({ boxHome: home, platform: "linux", env: { PATH: "" }, exists: () => false, run, now: 1_000 });
    // Linux ranks bubblewrap first: without boxrun it says so, and no container CLI is there either.
    expect(result).toMatchObject({ ok: false, reason: "bwrap: the sandbox helper boxrun is missing from this install" });
    expect(await detectRuntime({ boxHome: home, platform: "linux", env: { PATH: "" }, exists: () => false, run, now: 2_000 })).toMatchObject({ ok: false, cached: true });
    expect(calls).toBe(0);
  });
});

describe("box core", () => {
  test("key, container name and the in-box project path", async () => {
    const root = await temp("project");
    expect(boxKey(root)).toMatch(/^[0-9a-f]{12}$/);
    expect(containerName("abc123def456", {})).toBe("omnirush-box-abc123def456");
    expect(containerName("abc123def456", { OMNIRUSH_BOX_CONTAINER_PREFIX: "guibox-" })).toBe("guibox-abc123def456");
    expect(containerName("abc123def456", { OMNIRUSH_BOX_CONTAINER_PREFIX: "../bad" })).toBe("omnirush-box-abc123def456");
    expect(containerRoot("C:\\Users\\Sam\\proj", "win32")).toBe("/c/Users/Sam/proj");
    expect(containerRoot("/home/sam/proj", "linux")).toBe("/home/sam/proj");
    expect(mapToBox("/a/proj/src", "/a/proj", "/c/proj")).toBe("/c/proj/src");
    expect(mapToBox("/elsewhere", "/a/proj", "/c/proj")).toBe("/c/proj");
  });

  test("a new box: the project at the same path, boxd on loopback only, nothing else of this machine", () => {
    const args = createArgs({ name: "omnirush-box-k", key: "k", root: "/p", croot: "/p", image: "img", runtime: { name: "docker", bin: "docker", vm: false }, run: "/h/projects/k", shims: null, token: "t", user: { uid: 1000, gid: 1000 }, env: {} });
    expect(args).toContain("type=bind,source=/p,target=/p");
    expect(args).toContain("127.0.0.1::7777");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.filter((arg) => arg.startsWith("type=bind")).length).toBe(2);
    // Docker on Linux: this machine's services as host.docker.internal (Podman and Docker Desktop have it already).
    const base = { name: "n", key: "k", root: "/p", croot: "/p", image: "img", run: "/h/projects/k", shims: null, token: "t", user: { uid: 1000, gid: 1000 }, env: {} };
    expect(createArgs({ ...base, runtime: { name: "docker", bin: "docker", vm: false }, platform: "linux" }).join(" ")).toContain("--add-host host.docker.internal:host-gateway");
    expect(createArgs({ ...base, runtime: { name: "podman", bin: "podman", vm: false }, platform: "linux" })).not.toContain("--add-host");
    expect(createArgs({ ...base, runtime: { name: "docker", bin: "docker", vm: true, flavor: "desktop" }, platform: "linux" })).not.toContain("--add-host");
    expect(createArgs({ ...base, runtime: { name: "docker", bin: "docker", vm: true }, platform: "darwin" })).not.toContain("--add-host");
  });

  test("this machine's git identity is the box's system git config (lowest priority), kept with the env file", async () => {
    const runFolder = await temp("run");
    await writeFile(join(runFolder, "env"), "BOXD_PATH_PREFIX=/opt/w\n");
    const box = new Box({ key: "k", name: "n", root: "/p", croot: "/p", runtime: { name: "docker", bin: "docker" }, home: await temp("home"), runFolder, run: async () => ({ code: 0, stdout: "", stderr: "" }), log: () => {}, platform: "linux", env: {} });
    box.useGitIdentity(() => ({ name: 'Sam "S" \\ R', email: "sam@example.invalid" }));
    expect(await readFile(join(runFolder, "env"), "utf8")).toBe("BOXD_PATH_PREFIX=/opt/w\nGIT_CONFIG_SYSTEM=/run/omnirush/gitconfig\n");
    expect(await readFile(join(runFolder, "gitconfig"), "utf8")).toBe('[user]\n\tname = "Sam \\"S\\" \\\\ R"\n\temail = "sam@example.invalid"\n');
    box.useGitIdentity(() => ({ name: "", email: "" }));
    expect(await readFile(join(runFolder, "env"), "utf8")).toBe("BOXD_PATH_PREFIX=/opt/w\n");
  });

  test("snapshot filter: noise, mounts and credentials out; a folder changed only by them goes too", () => {
    const kept = filterChanges(parseDiff(["C /var", "C /var/lib", "A /var/lib/apt/lists/x", "C /usr", "A /usr/local/bin/tool", "A /root/.ssh/id_ed25519", "A /p/src/a.ts", "A /root/.cache/ms-playwright/chromium"].join("\n")), { mounts: ["/p"] });
    expect(kept.map((entry) => entry.path)).toEqual(["/usr", "/usr/local/bin/tool", "/root/.cache/ms-playwright/chromium"]);
    expect(credentialPath("/home/u/.aws/credentials")).toBe(true);
    expect(credentialPath("/usr/lib/x.so")).toBe(false);
    // Package data, not a key: certifi's bundle has to survive a rebuild (`import requests`).
    expect(credentialPath("/root/.local/lib/python3.11/site-packages/certifi/cacert.pem")).toBe(false);
    expect(credentialPath("/root/project/node_modules/x/test/key.pem")).toBe(false);
    expect(credentialPath("/root/.ssh/id_ed25519")).toBe(true);
    expect(credentialPath("/root/server.key")).toBe(true);
  });

  test("tar header and size parsing", () => {
    const tar = singleFileTar("opt/omnirush/bin/boxd", Buffer.from("hi"));
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(512 * 3, 512 * 3 + 21).toString()).toBe("opt/omnirush/bin/boxd");
    expect(parseSize("57.2MB (virtual 1.1GB)")).toBe(57_200_000);
  });

  test("stack detection and image overrides", async () => {
    const root = await temp("go");
    await writeFile(join(root, "go.mod"), "module x\n");
    expect(detectStack(root)).toBe("go");
    expect(imageFor("go", { env: {} }).ref).toContain("box-go");
    expect(imageFor("go", { env: { OMNIRUSH_BOX_IMAGE: "local/base:dev" } })).toMatchObject({ pull: "local/base:dev", override: true });
  });

  test("missing helpers mean unavailable (null, or a reason thrown to the planner), found in the sidecars' box folder", async () => {
    const home = await temp("home");
    expect(helperPath("boxsh", { goos: "linux", goarch: "amd64", env: {} })).toBeNull();
    expect(() => installShell(home, { env: {} })).toThrow("sandbox shell helper is missing");
    const sidecars = await temp("sidecars");
    const bin = await helpers();
    expect(helperPath("boxd", { goos: "linux", goarch: "amd64", env: {}, toolsRoot: sidecars })).toBeNull();
    expect(helperPath("boxd", { goos: "linux", goarch: "amd64", env: { OMNIRUSH_BOX_BIN_DIR: bin } })).toBe(join(bin, "linux-amd64", "boxd"));
    if (process.platform !== "win32") {
      expect(installShell(home, { env: { OMNIRUSH_BOX_BIN_DIR: bin } })).toBe(join(home, "shell-desktop", "bash"));
    }
  });
});

describe("box mode and engine config", () => {
  test("precedence: OMNIRUSH_BOX, then the project, then the server default (offer until offered once)", () => {
    expect(resolveMode({ env: { OMNIRUSH_BOX: "0" }, project: "on", server: "on" })).toEqual({ on: false, source: "env", offer: false });
    expect(resolveMode({ env: {}, project: "off", server: "on" })).toEqual({ on: false, source: "project", offer: false });
    expect(resolveMode({ env: {}, project: null, server: "on" })).toEqual({ on: true, source: "server", offer: false });
    expect(resolveMode({ env: {}, project: null, server: "offer" })).toEqual({ on: false, source: "server", offer: true });
    expect(resolveMode({ env: {}, project: null, server: "offer", offered: true })).toEqual({ on: false, source: "server", offer: false });
    expect(resolveMode({ env: {}, project: null, server: "off" })).toEqual({ on: false, source: "default", offer: false });
  });

  test("the server default is remembered from /collect/capabilities", async () => {
    const state = await temp("state");
    expect(serverDefault(state)).toBe("off");
    expect(rememberServerDefault(state, { local_box: { default: "offer" } })).toBe(true);
    expect(serverDefault(state)).toBe("offer");
    expect(rememberServerDefault(state, { local_box: { default: "offer" } })).toBe(false);
    expect(rememberServerDefault(state, {})).toBe(false);
    expect(rememberServerDefault(state, { local_box: { default: "bogus" } })).toBe(true);
    expect(serverDefault(state)).toBe("off");
  });

  test("engine config: the shell and the plugin appended; nothing without bits", () => {
    expect(engineConfig(null, { plugin: ["a"] })).toEqual({ plugin: ["a"] });
    expect(engineConfig({ shell: "/h/shell-desktop/bash", plugin: "/p/omnirush-box.js" }, { plugin: ["a"], model: "m" })).toEqual({ plugin: ["a", "/p/omnirush-box.js"], model: "m", shell: "/h/shell-desktop/bash" });
  });

  test("workspace settings: localBox.mode and offered", () => {
    expect(readBoxSettings({})).toEqual({ mode: null, offered: false });
    expect(readBoxSettings({ localBox: { mode: "on", offered: true } })).toEqual({ mode: "on", offered: true });
    expect(readBoxSettings({ localBox: { mode: "maybe" } })).toEqual({ mode: null, offered: false });
  });
});

describe("box plugin", () => {
  test("routes only listed projects with a live record; file tools stay in the project; the prompt says linux", async () => {
    const home = await temp("boxhome");
    const root = await temp("project");
    process.env.OMNIRUSH_BOX_HOME = home;
    const key = boxKey(root);
    const hooks = await OmniRushBox({ directory: root });
    const env: Record<string, string> = {};
    await hooks["shell.env"]({ callID: "c1", sessionID: "s1" }, { env });
    expect(env).toEqual({});
    await mkdir(join(home, "boxes"), { recursive: true });
    await writeFile(join(home, "boxes", `${key}.json`), JSON.stringify({ state: "ready", uid: 0 }));
    // A record alone (a CLI run's) does not route a desktop chat.
    await hooks["shell.env"]({ callID: "c1", sessionID: "s1" }, { env });
    expect(env).toEqual({});
    await writeFile(join(home, DESKTOP_PROJECTS_FILE), JSON.stringify({ keys: [key] }));
    await hooks["shell.env"]({ callID: "c1", sessionID: "s1" }, { env });
    expect(env).toEqual({ OMNIRUSH_BOX_KEY: key, OMNIRUSH_CALL: "c1", OMNIRUSH_SESSION: "s1" });
    await expect(hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "/etc/hostname" } })).rejects.toThrow("outside the project folder");
    await hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: join(root, "a.txt") } });
    const system = ["You are...\nPlatform: darwin\n"];
    const same = system;
    await hooks["experimental.chat.system.transform"]({}, { system });
    expect(same).toBe(system);
    expect(system[0]).toContain("Platform: linux");
    expect(system[1]).toContain("Sandbox: shell commands run in a Linux (Debian) container");
    await writeFile(join(home, "boxes", `${key}.json`), JSON.stringify({ state: "off" }));
    const off: Record<string, string> = {};
    await hooks["shell.env"]({ callID: "c2" }, { env: off });
    expect(off).toEqual({});
  });

  test("a chat listed as native (and its sub-agents) stays on this machine; other chats of the project use the box", async () => {
    const home = await temp("boxhome");
    const root = await temp("project");
    process.env.OMNIRUSH_BOX_HOME = home;
    const key = boxKey(root);
    await mkdir(join(home, "boxes"), { recursive: true });
    await writeFile(join(home, "boxes", `${key}.json`), JSON.stringify({ state: "ready", uid: 0 }));
    await writeFile(join(home, DESKTOP_PROJECTS_FILE), JSON.stringify({ keys: [key], native_chats: ["ses_top"] }));
    const parents: Record<string, string> = { ses_kid: "ses_top", ses_grandkid: "ses_kid" };
    const asked: string[] = [];
    const client = { session: { get: async ({ path: { id } }: { path: { id: string } }) => { asked.push(id); return { data: { parentID: parents[id] } }; } } };
    const hooks = await OmniRushBox({ directory: root, client });
    const envOf = async (sessionID: string) => {
      const env: Record<string, string> = {};
      await hooks["shell.env"]({ callID: "c", sessionID }, { env });
      return env.OMNIRUSH_BOX_KEY ?? null;
    };
    expect(await envOf("ses_top")).toBeNull();
    expect(await envOf("ses_grandkid")).toBeNull();
    expect(await envOf("ses_grandkid")).toBeNull();
    expect(await envOf("ses_new")).toBe(key);
    // Each chat's parents are asked once.
    expect(asked).toEqual(["ses_grandkid", "ses_kid", "ses_top", "ses_new"]);
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_top" }, { args: { filePath: "/etc/hostname" } });
    const system = ["Platform: darwin"];
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_kid" }, { system });
    expect(system).toEqual(["Platform: darwin"]);
  });
});

describe("box service", () => {
  type Settings = Map<string, { mode: "on" | "off" | null; offered: boolean }>;
  function service(input: { stateDir: string; workspaces: BoxWorkspace[]; settings: Settings; env: NodeJS.ProcessEnv }) {
    return new BoxService({
      stateDir: input.stateDir,
      readSettings: async (id) => input.settings.get(id) ?? { mode: null, offered: false },
      writeSettings: async (id, update) => {
        const current = input.settings.get(id) ?? { mode: null, offered: false };
        input.settings.set(id, { mode: update.mode === undefined ? current.mode : update.mode, offered: update.offered ?? current.offered });
      },
      workspaces: () => input.workspaces,
      pluginPath: () => "/plugins/omnirush-box.js",
      env: input.env,
    });
  }

  test("the toggle: engine bits once a workspace is on (or the server offers it), only with the helpers; no runtime is no error", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const bin = await helpers();
    const workspace: BoxWorkspace = { id: "ws_1", path: root, workspaceType: "local" };
    const settings: Settings = new Map();
    const env = { OMNIRUSH_BOX_HOME: home, OMNIRUSH_BOX_BIN_DIR: bin, PATH: "", OMNIRUSH_BOX_RUNTIME: "/nonexistent/docker" };
    const boxes = service({ stateDir, workspaces: [workspace], settings, env });
    expect(await boxes.engineBits()).toBeNull();
    const status = await boxes.setMode(workspace, "on");
    expect(settings.get("ws_1")).toEqual({ mode: "on", offered: true });
    expect(status).toMatchObject({ mode: "on", on: true, source: "project", state: "unavailable" });
    expect(status.runtime?.ok).toBe(false);
    if (process.platform !== "win32") expect(await boxes.engineBits()).toEqual({ shell: join(home, "shell-desktop", "bash"), plugin: "/plugins/omnirush-box.js" });
    // Unavailable: the plugin is not told to route this project, and a prompt goes on natively.
    await boxes.ensure(workspace);
    expect(await boxes.listedProjects()).toEqual([]);
    expect(await boxes.beforePrompt("ses_box_test_1", workspace)).toBeNull();
    await boxes.setMode(workspace, "off");
    expect(await boxes.engineBits()).toBeNull();
    rememberServerDefault(stateDir, { local_box: { default: "offer" } });
    expect(await boxes.status(workspace)).toMatchObject({ on: false, offer: false, state: "off" });
    await boxes.setMode(workspace, null);
    expect(await boxes.status(workspace)).toMatchObject({ mode: null, on: false, source: "server", offer: false });
    if (process.platform !== "win32") expect(await boxes.engineBits()).not.toBeNull();
    // Without helpers there are no engine bits, whatever the settings.
    const none = service({ stateDir, workspaces: [workspace], settings, env: { ...env, OMNIRUSH_BOX_BIN_DIR: join(bin, "nothing") } });
    expect(await none.engineBits()).toBeNull();
  });

  test("Try again with no runtime: a fresh look, still unavailable, with the OS for the card's next step", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_t", path: root, workspaceType: "local" };
    const settings: Settings = new Map([["ws_t", { mode: "on", offered: true }]]);
    const boxes = service({ stateDir, workspaces: [workspace], settings, env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), OMNIRUSH_BOX_BIN_DIR: await helpers(), PATH: "", OMNIRUSH_BOX_RUNTIME: "/nonexistent/docker" } });
    const status = await boxes.retry(workspace);
    expect(status).toMatchObject({ on: true, state: "unavailable", platform: process.platform, progress: null });
    expect(settings.get("ws_t")).toEqual({ mode: "on", offered: true });
  });

  test("a chat that ran natively names its turn in each checkpoint (session_turn)", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_t", path: root, workspaceType: "local" };
    const env = { OMNIRUSH_BOX_HOME: await temp("boxhome") };
    const frozen: Array<string> = [];
    const run: BoxRun = {
      key: "k", container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box: null,
      ready: async () => null,
      label: () => null,
      setTurn: () => {}, heal: async () => null, close: () => {},
      freeze: async (label, { sessionId, turn = null, sessionTurn = null }) => {
        frozen.push(`${sessionId} ${label} ${sessionTurn}`);
        return { label, turn, copied: 0, carried: 0, save: async () => ({ label, changed: 0, bytes: 0 }), discard: async () => null };
      },
    };
    let on = false;
    const start = () => {
      const boxes = service({ stateDir, workspaces: [workspace], settings: new Map(), env });
      boxes.ensure = async () => (on ? run : null);
      return boxes;
    };
    // Two turns with the box off, a steer (not captured), then the box turned on mid-chat: one pin per
    // chat (2026-10-24), it stays on this machine and takes no checkpoint.
    let boxes = start();
    await boxes.beforePrompt("ses_turns_a1", workspace);
    await boxes.beforePrompt("ses_turns_a1", workspace);
    await boxes.beforePrompt("ses_turns_a1", workspace, { capture: false });
    on = true;
    await boxes.beforePrompt("ses_turns_a1", workspace);
    await boxes.beforePrompt("ses_turns_a1", workspace);
    expect(frozen.splice(0)).toEqual([]);
    // Reopened after a restart with 4 native turns: it stays there too.
    boxes = start();
    await boxes.beforePrompt("ses_turns_b1", workspace, { turnsBefore: 4 });
    await boxes.beforePrompt("ses_turns_b1", workspace);
    expect(frozen.splice(0)).toEqual([]);
    // Saved checkpoints go on numbering the files; the chat's turn comes from the engine's count.
    await mkdir(join(stateDir, "sandbox", "snapshots", "ses_turns_c1"), { recursive: true });
    await writeFile(join(boxes.snapshotsDir, "ses_turns_c1", "turn-7.json"), "{}");
    await boxes.beforePrompt("ses_turns_c1", workspace, { turnsBefore: 2 });
    expect(frozen.splice(0)).toEqual(["ses_turns_c1 turn-8 3"]);
  });

  test("a reopened chat that ran on this machine stays there, whoever turned the box on", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_n", path: root, workspaceType: "local" };
    const settings: Settings = new Map();
    const frozen: string[] = [];
    const run: BoxRun = {
      key: boxKey(root), container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box: null,
      ready: async () => null,
      label: () => null,
      setTurn: () => {}, heal: async () => null, close: () => {},
      freeze: async (label, { sessionId, turn = null }) => {
        frozen.push(`${sessionId} ${label}`);
        return { label, turn, copied: 0, carried: 0, save: async () => ({ label, changed: 0, bytes: 0 }), discard: async () => null };
      },
    };
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    const boxes = service({ stateDir, workspaces: [workspace], settings, env: { OMNIRUSH_BOX_HOME: home } });
    boxes.ensure = async () => run;
    const listed = async () => JSON.parse(await readFile(join(home, DESKTOP_PROJECTS_FILE), "utf8")).native_chats ?? [];
    // Reopened with 2 turns and no checkpoint: no checkpoint now either, and the plugin is told to leave it here.
    expect(await boxes.beforePrompt("ses_native_r1", workspace, { turnsBefore: 2 })).toBeNull();
    await boxes.beforePrompt("ses_native_r1", workspace);
    // A new chat and a chat that already has checkpoints go in the box.
    await boxes.beforePrompt("ses_native_n1", workspace);
    await mkdir(join(boxes.snapshotsDir, "ses_native_b1"), { recursive: true });
    await writeFile(join(boxes.snapshotsDir, "ses_native_b1", "turn-1.json"), "{}");
    await boxes.beforePrompt("ses_native_b1", workspace, { turnsBefore: 3 });
    expect(frozen.splice(0)).toEqual(["ses_native_n1 turn-1", "ses_native_b1 turn-2"]);
    expect(await listed()).toEqual(["ses_native_r1"]);
    // The user turns the project on: one pin per chat (2026-10-24), the chat stays on this machine;
    // new chats go in the box.
    boxes.ensure = async () => run;
    await boxes.setMode(workspace, "on");
    await boxes.beforePrompt("ses_native_r1", workspace);
    expect(frozen.splice(0)).toEqual([]);
    expect(await listed()).toEqual(["ses_native_r1"]);
    // Reopened after the user turned it on: it stays there too.
    await boxes.beforePrompt("ses_native_r2", workspace, { turnsBefore: 4 });
    expect(frozen.splice(0)).toEqual([]);
  });

  test("the server's default turned on while the app runs: chats that ran on this machine stay there, new ones go in the box", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_l", path: root, workspaceType: "local" };
    const frozen: string[] = [];
    let failNext = false;
    const run: BoxRun = {
      key: boxKey(root), container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box: null,
      ready: async () => null,
      label: () => null,
      setTurn: () => {}, heal: async () => null, close: () => {},
      freeze: async (label, { sessionId, turn = null }) => {
        frozen.push(`${sessionId} ${label}`);
        if (failNext) { failNext = false; throw new Error("checkpoint failed"); }
        return { label, turn, copied: 0, carried: 0, save: async () => ({ label, changed: 0, bytes: 0 }), discard: async () => null };
      },
    };
    rememberServerDefault(stateDir, { local_box: { default: "off" } });
    const boxes = service({ stateDir, workspaces: [workspace], settings: new Map(), env: { OMNIRUSH_BOX_HOME: home } });
    let on = false;
    boxes.ensure = async () => (on ? run : null);
    const listed = async () => JSON.parse(await readFile(join(home, DESKTOP_PROJECTS_FILE), "utf8")).native_chats ?? [];
    // Before the switch: two turns on this machine (the first chat after it, too, while its image downloads).
    expect(await boxes.beforePrompt("ses_live_old1", workspace)).toBeNull();
    expect(await boxes.beforePrompt("ses_live_old1", workspace)).toBeNull();
    // The app reads the switch (watchServerDefault) and the project's box is ready.
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    on = true;
    expect(await boxes.beforePrompt("ses_live_old1", workspace)).toBeNull();
    expect(await listed()).toEqual(["ses_live_old1"]);
    // A new chat goes in; one whose first checkpoint failed stays in (its commands already ran there).
    await boxes.beforePrompt("ses_live_new1", workspace);
    failNext = true;
    await boxes.beforePrompt("ses_live_new2", workspace);
    await boxes.beforePrompt("ses_live_new2", workspace);
    expect(frozen.splice(0)).toEqual(["ses_live_new1 turn-1", "ses_live_new2 turn-1", "ses_live_new2 turn-1"]);
    expect(await listed()).toEqual(["ses_live_old1"]);
  });

  test("planOutcome: each chat says once where it runs and why (box.plan)", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_o", path: root, workspaceType: "local" };
    const run: BoxRun = {
      key: boxKey(root), container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box: null,
      ready: async () => null, label: () => null, setTurn: () => {}, heal: async () => null, close: () => {},
      freeze: async (label, { turn = null }) => ({ label, turn, copied: 0, carried: 0, save: async () => ({ label, changed: 0, bytes: 0 }), discard: async () => null }),
    };
    rememberServerDefault(stateDir, { local_box: { default: "off" } });
    const boxes = service({ stateDir, workspaces: [workspace], settings: new Map(), env: { OMNIRUSH_BOX_HOME: home } });
    boxes.ensure = async () => null;
    await boxes.beforePrompt("ses_out_off1", workspace);
    expect(await boxes.planOutcome("ses_out_off1", workspace)).toEqual({ native: true, source: "default", reason: "off" });
    expect(await boxes.planOutcome("ses_out_off1", workspace)).toBeNull();
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    expect(await boxes.planOutcome("ses_out_wait1", workspace)).toEqual({ native: true, source: "server", reason: "planning" });
    boxes.ensure = async () => run;
    await boxes.beforePrompt("ses_out_box1", workspace);
    expect(await boxes.planOutcome("ses_out_box1", workspace)).toEqual({ native: false, source: "server", reason: "box" });
    // The chat that ran here before the switch stays (kept_old_chat).
    await boxes.beforePrompt("ses_out_off1", workspace);
    expect(await boxes.planOutcome("ses_out_off1", workspace)).toBeNull();
    await boxes.beforePrompt("ses_out_old2", workspace, { turnsBefore: 3 });
    expect(await boxes.planOutcome("ses_out_old2", workspace)).toEqual({ native: true, source: "chat", reason: "kept_old_chat" });
    expect(await boxes.planOutcome("ses_out_remote", { id: "ws_r", path: root, workspaceType: "remote" })).toBeNull();
  });

  test("runtimeWhy: the backend and its failure code, never its text or a path", () => {
    expect(runtimeWhy({ name: "bwrap", code: "apparmor", reason: "AppArmor blocks /usr/bin/bwrap" })).toEqual({ name: "bwrap", code: "apparmor" });
    expect(runtimeWhy({ name: "docker", reason: "the sandbox backend did not answer in time" })).toEqual({ name: "docker", code: "timeout" });
    expect(runtimeWhy({ name: "C:\\docker.exe", code: "Not A Code", reason: "x" })).toEqual({ name: null, code: null });
  });

  test("watchServerDefault reads the server's default again and applies only a change", async () => {
    const stateDir = await temp("state");
    rememberServerDefault(stateDir, { local_box: { default: "off" } });
    const answers: Array<{ local_box?: unknown } | null> = [{ local_box: { default: "off" } }, null, { local_box: { default: "on" } }, { local_box: { default: "on" } }];
    let applied = 0;
    const stop = watchServerDefault({ stateDir, read: async () => answers.shift() ?? null, apply: async () => { applied += 1; }, everyMs: 5 });
    try {
      for (let i = 0; i < 100 && answers.length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      stop();
    }
    // Unchanged, no answer (the last one stays), then on once.
    expect(serverDefault(stateDir)).toBe("on");
    expect(applied).toBe(1);
  });

  test("a box on a backend the server no longer allows is planned again", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_a", path: root, workspaceType: "local" };
    const boxes = service({ stateDir, workspaces: [workspace], settings: new Map(), env: { OMNIRUSH_BOX_HOME: await temp("boxhome") } });
    const run: BoxRun = {
      key: boxKey(root), container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box: null,
      ready: async () => null, label: () => null, setTurn: () => {}, heal: async () => null, close: () => {}, freeze: async () => null,
    };
    const projects = boxes["projects"];
    projects.set(boxKey(root), { run, notice: null, planning: null, nextPlanAt: Date.now() + 60_000, waitingImage: false });
    rememberServerDefault(stateDir, { local_box: { default: "on", backends: ["docker", "podman"] } });
    await boxes.serverBackendsChanged();
    expect(projects.get(boxKey(root))?.run).toBe(run);
    expect(await boxes.listedProjects()).toEqual([boxKey(root)]);
    rememberServerDefault(stateDir, { local_box: { default: "on", backends: ["podman"] } });
    await boxes.serverBackendsChanged();
    expect(projects.get(boxKey(root))).toMatchObject({ run: null, nextPlanAt: 0 });
    expect(await boxes.listedProjects()).toEqual([]);
  });

  test("a running box whose folder was replaced (a new clone) is planned again at the next prompt", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_c", path: root, workspaceType: "local" };
    let replaced = false;
    const asked: string[] = [];
    const boxes = new BoxService({
      stateDir,
      readSettings: async () => ({ mode: "on", offered: true }),
      writeSettings: async () => {},
      workspaces: () => [workspace],
      pluginPath: () => "/plugins/omnirush-box.js",
      env: { OMNIRUSH_BOX_HOME: home, PATH: "", OMNIRUSH_BOX_RUNTIME: "/nonexistent/docker" },
      folderReplaced: async ({ croot }) => { asked.push(croot); return replaced; },
    });
    const box = new Box({ key: boxKey(root), name: "n", root, croot: root, runtime: { name: "docker", bin: "docker" }, home, runFolder: await temp("run"), run: async () => ({ code: 0, stdout: "", stderr: "" }), log: () => {}, platform: "linux", env: {} });
    box.connect({ port: 1, token: "t", uid: 0, gid: 0, containerId: "c", imageId: "i" });
    box.setState("ready", null);
    const run: BoxRun = {
      key: boxKey(root), container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box,
      ready: async () => box, label: () => null, setTurn: () => {}, heal: async () => null, close: () => {}, freeze: async () => null,
    };
    boxes["projects"].set(boxKey(root), { run, notice: null, planning: null, nextPlanAt: 0, waitingImage: false });
    expect(await boxes.ensure(workspace)).toBe(run);
    replaced = true;
    // Planned again (no runtime here, so no box this time): the old run is dropped, never handed out again.
    expect(await boxes.ensure(workspace)).toBeNull();
    expect(boxes["projects"].get(boxKey(root))?.run).toBeNull();
    expect(asked).toEqual([root, root]);
  });

  test("a remote workspace never gets a box", async () => {
    const stateDir = await temp("state");
    const workspace: BoxWorkspace = { id: "ws_r", path: "/remote", workspaceType: "remote" };
    const settings: Settings = new Map([["ws_r", { mode: "on", offered: true }]]);
    const boxes = service({ stateDir, workspaces: [workspace], settings, env: { OMNIRUSH_BOX_HOME: await temp("boxhome") } });
    expect(await boxes.ensure(workspace)).toBeNull();
    expect(await boxes.status(workspace)).toMatchObject({ on: false, state: "off" });
  });
});

describe("box on Windows: a WSL engine (detected, never installed)", () => {
  const WSL = "C:\\Windows\\System32\\wsl.exe";
  const winEnv = { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" };
  const has = (...files: string[]) => (file: string) => files.includes(file);

  test("Docker Desktop is used when WSL is off (the WSL engine is not even asked)", async () => {
    const asked: string[] = [];
    const run: RunCommand = async (bin, args) => {
      asked.push([bin, ...args].join(" "));
      if (bin === WSL) return { code: 1, stdout: "", stderr: "Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'." };
      return { code: 0, stdout: JSON.stringify({ ServerVersion: "27.3.1", OSType: "linux", Architecture: "x86_64", OperatingSystem: "Docker Desktop" }), stderr: "" };
    };
    const found = await detectRuntime({ platform: "win32", home: "C:\\Users\\sam", env: winEnv, exists: has("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", WSL), run, fresh: true });
    expect(found).toMatchObject({ ok: true, flavor: "desktop", backend: "docker-desktop" });
    expect(asked.some((line) => line.startsWith(`${WSL} -e`))).toBe(false);
  });

  test("without Docker Desktop: Docker in the default WSL distro, through wsl.exe", async () => {
    expect(wslLauncher({ env: winEnv, exists: has(WSL) })).toBe(WSL);
    expect(wslLauncher({ env: winEnv, exists: () => false })).toBeNull();
    const run: RunCommand = async (bin, args) => (bin === WSL && args.join(" ") === "-e docker info --format {{json .}}"
      ? { code: 0, stdout: JSON.stringify({ ServerVersion: "28.1.1", OSType: "linux", Architecture: "x86_64", OperatingSystem: "Ubuntu 24.04.1 LTS", SecurityOptions: [] }), stderr: "" }
      : { code: -1, stdout: "", stderr: "", error: "ENOENT" });
    const found = await detectRuntime({ platform: "win32", home: "C:\\Users\\sam", env: winEnv, exists: has(WSL), run, fresh: true });
    expect(found).toMatchObject({ ok: true, bin: WSL, prefix: ["-e", "docker"], flavor: "wsl", wsl: true, vm: true });
  });

  test("no distribution, or no engine in it, is a one-line reason; OMNIRUSH_BOX_WSL=0 never asks; Podman works too", async () => {
    const noDistro = await probeWsl(WSL, { run: async () => ({ code: 1, stdout: "", stderr: "Windows Subsystem for Linux has no installed distributions.\u0000" }) });
    expect(noDistro.ok).toBe(false);
    if (!noDistro.ok) expect(noDistro.reason).toContain("no Linux distribution");
    const noEngine = await probeWsl(WSL, { run: async () => ({ code: 127, stdout: "", stderr: "/bin/bash: line 1: docker: command not found" }) });
    if (!noEngine.ok) expect(noEngine.reason).toContain("no Docker or Podman engine");
    expect(noEngine.ok).toBe(false);
    const off = await detectRuntime({ platform: "win32", home: "C:\\Users\\sam", env: { ...winEnv, OMNIRUSH_BOX_WSL: "0" }, exists: has(WSL), run: async () => { throw new Error("not asked"); }, fresh: true });
    expect(off.ok).toBe(false);
    const podman = await probeWsl(WSL, { run: async (_bin, args) => (args[1] === "podman" ? { code: 0, stdout: JSON.stringify({ host: { arch: "amd64", security: { rootless: true } }, version: { Version: "4.9.3" } }), stderr: "" } : { code: 127, stdout: "", stderr: "docker: not found" }) });
    expect(podman).toMatchObject({ ok: true, name: "podman", prefix: ["-e", "podman"], rootless: true });
  });

  test("Windows folders mount through /mnt/<drive>; the prefix goes on every call", async () => {
    expect(wslPath("C:\\Users\\Sam\\proj")).toBe("/mnt/c/Users/Sam/proj");
    const args = createArgs({ name: "n", key: "k", root: "C:\\Users\\Sam\\proj", croot: "/c/Users/Sam/proj", image: "img", runtime: { name: "docker", bin: "wsl.exe", wsl: true, vm: true, prefix: ["-e", "docker"] }, run: "C:\\Users\\Sam\\.omnirush\\box\\projects\\k", shims: null, pkglog: { root: "C:\\Users\\Sam\\state\\pkglog", bin: "C:\\Users\\Sam\\state\\pkglog\\bin-1", py: "C:\\Users\\Sam\\state\\pkglog\\py-1" }, token: "t", user: { uid: 0, gid: 0 }, env: {}, platform: "win32" });
    expect(args).toContain("type=bind,source=/mnt/c/Users/Sam/proj,target=/c/Users/Sam/proj");
    expect(args).toContain("type=bind,source=/mnt/c/Users/Sam/.omnirush/box/projects/k,target=/run/omnirush");
    expect(args).toContain("type=bind,source=/mnt/c/Users/Sam/state/pkglog,target=/c/Users/Sam/state/pkglog");
    const calls: string[][] = [];
    await rt({ name: "docker", bin: WSL, prefix: ["-e", "docker"] }, async (bin, a) => { calls.push([bin, ...a]); return { code: 0, stdout: "", stderr: "" }; })(["ps"]);
    expect(calls).toEqual([[WSL, "-e", "docker", "ps"]]);
  });
});

describe("box install log and upkeep", () => {
  test("a new box mounts the install log's folder at the same path", () => {
    const args = createArgs({ name: "n", key: "k", root: "/p", croot: "/p", image: "img", runtime: { name: "docker", bin: "docker", vm: false }, run: "/h/projects/k", shims: null, pkglog: { root: "/s/pkglog", bin: "/s/pkglog/bin-1", py: "/s/pkglog/py-1" }, token: "t", user: { uid: 0, gid: 0 }, env: {} });
    expect(args).toContain("type=bind,source=/s/pkglog,target=/s/pkglog");
  });

  test("the daily cleanup runs at most once a day, in the background", async () => {
    const home = await temp("gc");
    let runs = 0;
    const gc = async () => { runs += 1; return []; };
    expect(gcInBackground({ name: "docker", bin: "docker" }, home, { now: 1_000_000_000, gc })).not.toBeNull();
    expect(gcInBackground({ name: "docker", bin: "docker" }, home, { now: 1_000_000_000 + 3_600_000, gc })).toBeNull();
    expect(gcInBackground({ name: "docker", bin: "docker" }, home, { now: 1_000_000_000 + 25 * 3_600_000, gc })).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
  });

  test("the plugin points box calls at the box's install log folder and names the folder inside on Windows-like roots", async () => {
    const home = await temp("boxhome");
    const root = await temp("project");
    process.env.OMNIRUSH_BOX_HOME = home;
    const key = boxKey(root);
    await mkdir(join(home, "boxes"), { recursive: true });
    await writeFile(join(home, "boxes", `${key}.json`), JSON.stringify({ state: "ready", uid: 0, croot: "/c/proj" }));
    await writeFile(join(home, DESKTOP_PROJECTS_FILE), JSON.stringify({ keys: [key], pkglog_dir: "/state/pkglog/raw/1-box-ab" }));
    const hooks = await OmniRushBox({ directory: root });
    const env: Record<string, string> = {};
    await hooks["shell.env"]({ callID: "c1" }, { env });
    expect(env).toMatchObject({ OMNIRUSH_BOX_KEY: key, OMNIRUSH_PKGLOG_DIR: "/state/pkglog/raw/1-box-ab" });
    const system: string[] = [];
    await hooks["experimental.chat.system.transform"]({}, { system });
    expect(system[0]).toContain(`${root} is /c/proj inside the container`);
  });
});

describe("box download progress (the Settings card's bar)", () => {
  const DOCKER_LOG = [
    "2026.10.2: Pulling from omnirush-ai/box-go",
    "aaaaaaaaaaaa: Already exists",
    "bbbbbbbbbbbb: Pulling fs layer",
    "cccccccccccc: Pulling fs layer",
    "bbbbbbbbbbbb: Waiting",
    "cccccccccccc: Downloading",
    "cccccccccccc: Verifying Checksum",
    "cccccccccccc: Download complete",
    "",
  ].join("\n");

  test("the runtime's piped output: layers named and downloaded (Docker and Podman)", () => {
    expect(parsePullLog(DOCKER_LOG)).toEqual({ seen: ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"], done: new Set(["aaaaaaaaaaaa", "cccccccccccc"]), bytes: null, layers: 3 });
    const podman = parsePullLog("Trying to pull ghcr.io/x...\nCopying blob sha256:dddddddddddd1111 done   |\nCopying blob eeeeeeeeeeee2222\nCopying blob ffffffffffff skipped: already exists\n");
    expect(podman).toEqual({ seen: ["dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"], done: new Set(["dddddddddddd", "ffffffffffff"]), bytes: null, layers: 3 });
    // bubblewrap's boxrun: its byte count (the latest line wins), and whole layers as they land.
    const boxrun = parsePullLog(`{"progress":{"bytes":0,"total":259000000}}\n{"progress":{"bytes":52000000,"total":259000000}}\nlayer 1/3 sha256:${"a".repeat(64)} 52000000 bytes\n{"progress":{"bytes":131000000,"total":259000000}}\n{"progress":{"by`);
    expect(boxrun).toMatchObject({ bytes: { done: 131_000_000, total: 259_000_000 }, layers: 3, done: new Set(["aaaaaaaaaaaa"]) });
  });

  test("layer sizes for this platform from `manifest inspect -v` (a list or one manifest)", () => {
    const list = JSON.stringify([
      { Descriptor: { platform: { os: "linux", architecture: "arm64" } }, OCIManifest: { layers: [{ digest: `sha256:${"9".repeat(64)}`, size: 1 }] } },
      { Descriptor: { platform: { os: "linux", architecture: "amd64" } }, OCIManifest: { layers: [{ digest: `sha256:${"a".repeat(64)}`, size: 1000 }, { digest: `sha256:${"b".repeat(64)}`, size: 5000 }] } },
    ]);
    expect(parseManifestSizes(list, "amd64")).toEqual(new Map([["aaaaaaaaaaaa", 1000], ["bbbbbbbbbbbb", 5000]]));
    expect(parseManifestSizes(JSON.stringify({ SchemaV2Manifest: { layers: [{ digest: `sha256:${"c".repeat(64)}`, size: 7 }] } }), "arm64")).toEqual(new Map([["cccccccccccc", 7]]));
    expect(parseManifestSizes("not json")).toBeNull();
    expect(parseManifestSizes(list, "riscv64")).toBeNull();
  });

  test("progress: bytes of the downloaded layers out of the layers the runtime downloads; layers only without sizes", async () => {
    const home = await temp("pulls");
    const marker = join(home, "docker-img.pid");
    await writeFile(marker, "123");
    await writeFile(pullLog(marker), DOCKER_LOG);
    const sizes = new Map([["aaaaaaaaaaaa", 100], ["bbbbbbbbbbbb", 300], ["cccccccccccc", 600], ["dddddddddddd", 9_999]]);
    // dddd... is in the image but already here and never named: not part of this download.
    expect(pullProgress(pullLog(marker), marker, sizes)).toMatchObject({ bytesDone: 700, bytesTotal: 1000, layersDone: 2, layersTotal: 3 });
    expect(pullProgress(pullLog(marker), marker, null)).toMatchObject({ bytesDone: null, bytesTotal: null, layersDone: 2, layersTotal: 3 });
    // Sizes that do not cover a named layer belong to something else: no bytes.
    expect(pullProgress(pullLog(marker), marker, new Map([["aaaaaaaaaaaa", 1]]))).toMatchObject({ bytesDone: null, bytesTotal: null });
    expect(pullProgress(pullLog(marker), marker, sizes)?.startedAt).toBeGreaterThan(0);
    await writeFile(pullLog(marker), `{"progress":{"bytes":65000000,"total":259000000}}\n`);
    expect(pullProgress(pullLog(marker), marker, null)).toMatchObject({ bytesDone: 65_000_000, bytesTotal: 259_000_000 });
    // No log (a download in this process): no progress.
    expect(pullProgress(join(home, "none.log"), marker, sizes)).toBeNull();
  });

  test("the sizes are asked once per image, in the background, and only of Docker", async () => {
    clearLayerSizes();
    const calls: string[][] = [];
    const run: RunCommand = async (_bin, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ SchemaV2Manifest: { layers: [{ digest: `sha256:${"a".repeat(64)}`, size: 42 }] } }), stderr: "" };
    };
    const image = { stack: "base", ref: "r", digest: null, pull: "r:1" };
    expect(layerSizes({ name: "podman", bin: "podman" }, image, { run })).toBeNull();
    expect(layerSizes({ name: "docker", bin: "docker" }, image, { run })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(layerSizes({ name: "docker", bin: "docker" }, image, { run })).toEqual(new Map([["aaaaaaaaaaaa", 42]]));
    expect(calls).toEqual([["manifest", "inspect", "-v", "r:1"]]);
    clearLayerSizes();
  });

  test("the detached download writes its output next to its marker", async () => {
    const home = await temp("boxhome");
    const runtime = { name: "docker", bin: "docker", backend: "docker" };
    const image = { stack: "base", ref: "img", digest: null, pull: "img:1" };
    let seen: unknown = null;
    const started = pullInBackground(runtime, image, home, {
      spawnImpl: (_command, _args, options) => {
        seen = options.stdio;
        if (Array.isArray(options.stdio)) writeSync(options.stdio[1], "aaaaaaaaaaaa: Pulling fs layer\n");
        return { pid: 999_999_999, unref: () => {} };
      },
    });
    expect(started.started).toBe(true);
    expect(Array.isArray(seen) && seen[0] === "ignore").toBe(true);
    expect(await readFile(pullLog(pullMarker(home, runtime, image.pull)), "utf8")).toBe("aaaaaaaaaaaa: Pulling fs layer\n");
  });
});

describe("box start limit", () => {
  test("the start limit counts while the box starts, not while its image downloads", async () => {
    const home = await temp("boxhome");
    const root = await temp("project");
    const box = new Box({ key: "k", name: "n", root, croot: root, runtime: { name: "docker", bin: "docker" }, home, runFolder: join(home, "run"), run: async () => ({ code: 0, stdout: "", stderr: "" }), log: () => {}, platform: "linux", env: {} });
    let phase: string | null = "pulling";
    let open: (value: Box) => void = () => {};
    const opening = new Promise<Box>((resolve) => { open = resolve; });
    const run = boxRun({ box: { key: "k", home, root, runtime: { name: "docker", bin: "docker" } }, notice: null, shell: "bash", start: () => opening, get phase() { return phase; } }, { readyWaitMs: 60 });
    const waiting = run.ready();
    // 200 ms of download: longer than the 60 ms limit, which does not run meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 200));
    phase = "starting";
    box.setState("ready", null);
    open(box);
    expect(await waiting).toBe(box);
    expect(run.native).toBe(false);
  });

  test("a start that takes longer than the limit (no download) goes on without the box", async () => {
    const home = await temp("boxhome");
    const root = await temp("project");
    const run = boxRun({ box: { key: "k2", home, root, runtime: { name: "docker", bin: "docker" } }, notice: null, shell: "bash", start: () => new Promise<Box>(() => {}), get phase() { return "starting"; } }, { readyWaitMs: 40 });
    expect(await run.ready()).toBeNull();
    expect(run.native).toBe(true);
  });
});
