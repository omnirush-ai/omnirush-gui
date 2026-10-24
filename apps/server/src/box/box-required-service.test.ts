import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boxKey, setToolsRoot } from "./box.js";
import { planBox, rememberServerDefault, REQUIRED_REDETECT_MS, resolveMode, serverRequired, type BoxRun } from "./launch.js";
import type { RunCommand } from "./run.js";
import { DESKTOP_PROJECTS_FILE } from "./plugin-lib.js";
import { setupState } from "./setup.js";
import { BoxRequiredError, BoxService, type BoxWorkspace } from "./service.js";

const dirs: string[] = [];
afterEach(async () => {
  setToolsRoot(null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `omnirush-boxreq-${name}-`));
  dirs.push(dir);
  return dir;
}

type Settings = Map<string, { mode: "on" | "off" | null; offered: boolean }>;
function service(input: { stateDir: string; workspaces: BoxWorkspace[]; settings?: Settings; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
  const settings = input.settings ?? new Map();
  return new BoxService({
    stateDir: input.stateDir,
    readSettings: async (id) => settings.get(id) ?? { mode: null, offered: false },
    writeSettings: async (id, update) => {
      const current = settings.get(id) ?? { mode: null, offered: false };
      settings.set(id, { mode: update.mode === undefined ? current.mode : update.mode, offered: update.offered ?? current.offered });
    },
    workspaces: () => input.workspaces,
    pluginPath: () => "/plugins/omnirush-box.js",
    env: input.env,
    ...(input.platform ? { platform: input.platform } : {}),
  });
}

function fakeRun(root: string, frozen: string[]): BoxRun {
  return {
    key: boxKey(root), container: "c", runtimeBin: "docker", runtimeArgs: [], backend: "docker", exec: null, root, native: false, box: null,
    ready: async () => null, label: () => null, setTurn: () => {}, heal: async () => null, close: () => {},
    freeze: async (label, { sessionId, turn = null }) => {
      frozen.push(`${sessionId} ${label}`);
      return { label, turn, copied: 0, carried: 0, save: async () => ({ label, changed: 0, bytes: 0 }), discard: async () => null };
    },
  };
}

const NO_RUNTIME = { PATH: "", OMNIRUSH_BOX_RUNTIME: "/nonexistent/docker" };

describe("required sandbox: the server's answer", () => {
  test("required, its fallback and prefetch are remembered; keys that first appear with their old meaning are no change", async () => {
    const state = await temp("state");
    expect(rememberServerDefault(state, { local_box: { default: "on" } })).toBe(true);
    // A newer server says the same thing with more keys: nothing to plan again.
    expect(rememberServerDefault(state, { local_box: { default: "on", required: false, required_fallback: null, setup: { prefetch: true } } })).toBe(false);
    // Not required: prefetch is never on and the file holds exactly the keys it held before.
    expect(serverRequired(state)).toEqual({ required: false, fallback: "native", prefetch: false });
    expect(Object.keys(JSON.parse(await readFile(join(state, "box-server.json"), "utf8"))).sort()).toEqual(["at", "backends", "default", "max_turn_bytes"]);
    expect(rememberServerDefault(state, { local_box: { default: "on", required: true, required_fallback: "native", setup: { prefetch: true } } })).toBe(true);
    expect(serverRequired(state)).toEqual({ required: true, fallback: "native", prefetch: true });
    expect(rememberServerDefault(state, { local_box: { default: "on", required: true, required_fallback: "native_uncounted", setup: { prefetch: true } } })).toBe(true);
    expect(rememberServerDefault(state, { local_box: { default: "on", required: true, required_fallback: "native_uncounted", setup: { prefetch: false } } })).toBe(false);
    expect(JSON.parse(await readFile(join(state, "box-server.json"), "utf8"))).toMatchObject({ default: "on", required: true, required_fallback: "native_uncounted", prefetch: false });
    // An older server's answer: not required.
    expect(rememberServerDefault(state, { local_box: { default: "on" } })).toBe(true);
    expect(serverRequired(state).required).toBe(false);
  });

  test("resolveMode: required beats the project's off and the buildathon; OMNIRUSH_BOX=0 is the escape and says so", () => {
    expect(resolveMode({ env: {}, project: "off", server: "on", required: true })).toEqual({ on: true, source: "required", offer: false, required: true });
    expect(resolveMode({ env: {}, project: null, server: "on", buildathon: "off", required: true })).toEqual({ on: true, source: "required", offer: false, required: true });
    expect(resolveMode({ env: { OMNIRUSH_BOX: "0" }, project: null, server: "on", required: true })).toEqual({ on: false, source: "env", offer: false, required: true });
    expect(resolveMode({ env: {}, project: "off", server: "on" })).toEqual({ on: false, source: "project", offer: false });
  });
});

describe("required sandbox: the desktop's projects", () => {
  test("off and the backend Off are refused; the status says required with the texts and what setup is needed", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_req", path: root, workspaceType: "local" };
    const settings: Settings = new Map([["ws_req", { mode: "off", offered: true }]]);
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true, required_fallback: "native" } });
    const boxes = service({ stateDir, workspaces: [workspace], settings, env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), ...NO_RUNTIME } });
    await expect(boxes.setMode(workspace, "off")).rejects.toBeInstanceOf(BoxRequiredError);
    await expect(boxes.setBackend("native")).rejects.toThrow("Required for new chats on this account");
    const status = await boxes.status(workspace);
    expect(status).toMatchObject({ on: true, source: "required", required: true, state: "unavailable" });
    expect(status.requiredText?.optOut).toBe("Required for new chats on this account. Chats started before keep running where they started.");
    expect(status.setup).toMatchObject({ need: process.platform === "linux" ? "runtime" : expect.any(String), fallback: "native", declined: false });
    // No step this app can run here (no backend at all): the chat runs here, as cannot_run (the CLI's reason too).
    expect(await boxes.beforePrompt("ses_req_none1", workspace)).toBeNull();
    expect(await boxes.planOutcome("ses_req_none1", workspace)).toMatchObject({ native: true, source: "required", reason: "cannot_run", required: true, capable: false, fallback: "native" });
  });

  test("a box that fails to start under required is a machine that can't run it: fallback native (counted in full)", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_fail", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true, required_fallback: "native_uncounted" } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), ...NO_RUNTIME } });
    const projects: Map<string, unknown> = Reflect.get(boxes, "projects");
    projects.set(boxKey(root), { run: { ...fakeRun(root, []), native: true }, notice: null, planning: null, nextPlanAt: Date.now() + 60_000, waitingImage: false });
    expect(await boxes.planOutcome("ses_req_fail1", workspace)).toEqual({ native: true, source: "required", reason: "box_failed", required: true, capable: false, fallback: "native" });
  });

  test("planBox under required: a backend slow to answer (a VM booting) is waited for, not \"did not answer in time\"", async () => {
    if (process.platform !== "linux") return;
    const home = await temp("boxhome");
    const root = await temp("project");
    const bin = await temp("bin");
    await mkdir(join(bin, `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`), { recursive: true });
    await writeFile(join(bin, `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`, "boxsh"), "#!/bin/sh\n");
    const dockerDir = await temp("dockerbin");
    await writeFile(join(dockerDir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { OMNIRUSH_BOX_HOME: home, OMNIRUSH_BOX_BIN_DIR: bin, PATH: dockerDir, OMNIRUSH_BOX_RUNTIME: join(dockerDir, "docker"), OMNIRUSH_BOX_GC: "off" };
    const run: RunCommand = async (cmd, args) => {
      if (/docker$/.test(String(cmd)) && args[0] === "info") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { code: 0, stdout: JSON.stringify({ OSType: "linux", ServerVersion: "29.0.0", Architecture: "x86_64" }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "Error: No such object" };
    };
    const slow = await planBox({ env, home, root, run, asked: "docker", probeMs: 100, platform: "linux" });
    expect(slow.box ? slow.box.runtime : slow.runtime).toMatchObject({ ok: false, reason: "the sandbox backend did not answer in time" });
    const waited = await planBox({ env, home: await temp("boxhome2"), root, run, asked: "docker", probeMs: 100, platform: "linux", required: true });
    expect(waited.box !== null || waited.runtime?.ok === true).toBe(true);
    expect(REQUIRED_REDETECT_MS).toBe(45_000);
  });

  test("a new chat goes in the box; a reopened native chat stays here without waiting (kept_old_chat)", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_new", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: home } });
    const frozen: string[] = [];
    boxes.ensure = async () => fakeRun(root, frozen);
    expect(await boxes.beforePrompt("ses_req_old1", workspace, { turnsBefore: 3 })).toBeNull();
    await boxes.beforePrompt("ses_req_new1", workspace);
    expect(frozen).toEqual(["ses_req_new1 turn-1"]);
    expect(await boxes.planOutcome("ses_req_old1", workspace)).toEqual({ native: true, source: "chat", reason: "kept_old_chat", required: true, fallback: "native" });
    expect(await boxes.planOutcome("ses_req_new1", workspace)).toEqual({ native: false, source: "required", reason: "box", required: true, capable: true });
    expect(JSON.parse(await readFile(join(home, DESKTOP_PROJECTS_FILE), "utf8")).native_chats).toEqual(["ses_req_old1"]);
  });

  test("a new chat on a model that runs only on this computer stays here, exempt from the required box (native_model)", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_nm", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: home } });
    const frozen: string[] = [];
    boxes.ensure = async () => fakeRun(root, frozen);
    expect(await boxes.beforePrompt("ses_kimi_new", workspace, { nativeModel: true })).toBeNull();
    // A chat that already ran in the box keeps it (its model never changed).
    await boxes.beforePrompt("ses_box_first", workspace);
    await boxes.beforePrompt("ses_box_first", workspace, { nativeModel: true });
    expect(frozen).toEqual(["ses_box_first turn-1", "ses_box_first turn-2"]);
    expect(await boxes.planOutcome("ses_kimi_new", workspace)).toEqual({ native: true, source: "model", reason: "native_model", required: true, fallback: "native" });
    expect(JSON.parse(await readFile(join(home, DESKTOP_PROJECTS_FILE), "utf8")).native_chats).toEqual(["ses_kimi_new"]);
  });

  test("offer level (backend #505): a chat pins where it started and its revision; a box chat is refused when its project's box goes off; a native chat stays native when it goes on", async () => {
    const stateDir = await temp("state");
    const home = await temp("boxhome");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_pin", path: root, workspaceType: "local" };
    const LB = { default: "offer", model_start: { "gpt-6-astra": { start: "native", switchable: true }, "kimi-k3.1-pro": { start: "native", switchable: false } }, revision: "lb1:5050a1b2c3d4" };
    rememberServerDefault(stateDir, { local_box: LB });
    const settings: Settings = new Map();
    const boxes = service({ stateDir, workspaces: [workspace], settings, env: { OMNIRUSH_BOX_HOME: home } });
    const frozen: string[] = [];
    boxes.ensure = async () => ((await boxes.status(workspace)).on ? fakeRun(root, frozen) : null);
    // Offer: the project's box is off until the person turns it on.
    expect(await boxes.beforePrompt("ses_native1", workspace)).toBeNull();
    expect(boxes.chatPin("ses_native1")).toEqual({ box: false, revision: "lb1:5050a1b2c3d4" });
    settings.set("ws_pin", { mode: "on", offered: true });
    await boxes.beforePrompt("ses_box1", workspace);
    expect(boxes.chatPin("ses_box1")).toEqual({ box: true, revision: "lb1:5050a1b2c3d4" });
    // Turned on since: the native chat stays native (no checkpoint, kept_old_chat).
    await boxes.beforePrompt("ses_native1", workspace, { turnsBefore: 1 });
    expect(frozen).toEqual(["ses_box1 turn-1"]);
    expect(await boxes.planOutcome("ses_native1", workspace)).toMatchObject({ native: true, reason: "kept_old_chat" });
    // Turned off since: the box chat is refused, never moved here.
    settings.set("ws_pin", { mode: "off", offered: true });
    expect(await boxes.pinnedBoxGone("ses_box1", workspace)).toBe(true);
    expect(await boxes.pinnedBoxGone("ses_native1", workspace)).toBe(false);
    // The status names the server's starts, the revision and the chat's pin.
    const status = await boxes.status(workspace, { sessionId: "ses_box1" });
    expect(status.modelStart?.["kimi-k3.1-pro"]).toEqual({ start: "native", switchable: false });
    expect(status.revision).toBe("lb1:5050a1b2c3d4");
    expect(status.chatPin).toEqual({ box: true, revision: "lb1:5050a1b2c3d4" });
    // A new service (app restart) reads the pins back.
    const again = service({ stateDir, workspaces: [workspace], settings, env: { OMNIRUSH_BOX_HOME: home } });
    expect(again.chatPin("ses_box1")?.box).toBe(true);
  });

  test("the first prompt waits while the image downloads, then runs in the box", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_wait", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: await temp("boxhome") } });
    const frozen: string[] = [];
    const projects: unknown = Reflect.get(boxes, "projects");
    if (!(projects instanceof Map)) throw new Error("no projects map");
    let tries = 0;
    boxes.ensure = async () => {
      tries += 1;
      if (tries < 3) {
        projects.set(boxKey(root), { run: null, notice: "downloading", planning: null, nextPlanAt: 0, waitingImage: true, why: { reason: "downloading" } });
        return null;
      }
      return fakeRun(root, frozen);
    };
    const started = Date.now();
    await boxes.beforePrompt("ses_req_wait1", workspace);
    expect(tries).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(frozen).toEqual(["ses_req_wait1 turn-1"]);
  });

  test("OMNIRUSH_BOX=0 is env_off; a host-only project stays here (host_only); the host-builds gate no longer keeps it", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true } });
    const workspace: BoxWorkspace = { id: "ws_env", path: root, workspaceType: "local" };
    const off = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), OMNIRUSH_BOX: "0" } });
    expect(await off.planOutcome("ses_req_env1", workspace)).toEqual({ native: true, source: "env", reason: "env_off", required: true, capable: true, fallback: "native" });

    const mac = await temp("macproject");
    await mkdir(join(mac, "App.xcodeproj"));
    const macWs: BoxWorkspace = { id: "ws_mac", path: mac, workspaceType: "local" };
    const boxes = service({ stateDir, workspaces: [macWs], env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), ...NO_RUNTIME }, platform: "darwin" });
    const status = await boxes.status(macWs);
    expect(status).toMatchObject({ on: false, source: "host-only", required: true, hostOnly: { things: ["App.xcodeproj"] } });
    expect(status.notice).toContain("only builds on Mac (App.xcodeproj)");
    expect(await boxes.planOutcome("ses_req_mac1", macWs)).toEqual({ native: true, source: "host-only", reason: "host_only", required: true, fallback: "native" });

    // A Mac-built node_modules: required puts the chat in the box anyway (no host-builds gate).
    const built = await temp("builtproject");
    await mkdir(join(built, "node_modules", "esbuild-darwin-arm64"), { recursive: true });
    await writeFile(join(built, "node_modules", "esbuild-darwin-arm64", "package.json"), JSON.stringify({ name: "esbuild-darwin-arm64", os: ["darwin"] }));
    const builtWs: BoxWorkspace = { id: "ws_built", path: built, workspaceType: "local" };
    const builtBoxes = service({ stateDir, workspaces: [builtWs], env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), ...NO_RUNTIME }, platform: "darwin" });
    expect(await builtBoxes.status(builtWs)).toMatchObject({ on: true, source: "required", hostBuilds: null });
  });

  test("an opened project is planned at once; prefetch only when the server asks for it", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_open", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on", required: true } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), ...NO_RUNTIME } });
    const asked: string[] = [];
    boxes.ensure = async (ws) => { asked.push(ws.id); return null; };
    boxes.opened(workspace);
    boxes.opened({ id: "ws_remote", path: root, workspaceType: "remote" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual(["ws_open"]);
    expect(await boxes.prefetch()).toBe(false);
  });

  test("the admin setup steps run only when the sandbox is required", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const home = await temp("boxhome");
    const workspace: BoxWorkspace = { id: "ws_setup", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: home, ...NO_RUNTIME }, platform: "win32" });
    await boxes.setup(workspace, "decline");
    await boxes.setup(workspace, "win_install");
    expect(setupState(home).win).toBeUndefined();
  });

  test("a server that says `on` with prefetch: no prefetch for a device it does not require", async () => {
    const stateDir = await temp("state");
    rememberServerDefault(stateDir, { local_box: { default: "on", required: false, setup: { prefetch: true } } });
    expect(serverRequired(stateDir).prefetch).toBe(false);
    const boxes = service({ stateDir, workspaces: [], env: { OMNIRUSH_BOX_HOME: await temp("boxhome") } });
    let detected = false;
    (boxes as unknown as { detect: () => Promise<null> }).detect = async () => { detected = true; return null; };
    expect(await boxes.prefetch()).toBe(false);
    expect(detected).toBe(false);
  });

  test("an older server: unchanged (the project's off still turns it off, no setup, not required)", async () => {
    const stateDir = await temp("state");
    const root = await temp("project");
    const workspace: BoxWorkspace = { id: "ws_old", path: root, workspaceType: "local" };
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    const boxes = service({ stateDir, workspaces: [workspace], env: { OMNIRUSH_BOX_HOME: await temp("boxhome"), ...NO_RUNTIME } });
    const status = await boxes.setMode(workspace, "off");
    expect(status).toMatchObject({ on: false, source: "project", required: false, requiredText: null, setup: null, hostOnly: null });
    expect(await boxes.planOutcome("ses_old_srv1", workspace)).toEqual({ native: true, source: "project", reason: "off" });
  });
});
