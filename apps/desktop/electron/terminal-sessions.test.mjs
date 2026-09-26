import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTerminalSessions, descendantsOf, terminalShells } from "./terminal-sessions.mjs";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(check, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(50);
  }
  return false;
}

test("shell list: Windows offers PowerShell (7 first when installed) and Command Prompt", () => {
  const shells = terminalShells({
    platform: "win32",
    env: { PATH: "C:\\Tools;C:\\Program Files\\PowerShell\\7", SystemRoot: "C:\\Windows", COMSPEC: "C:\\Windows\\system32\\cmd.exe" },
    exists: (file) => file === "C:\\Program Files\\PowerShell\\7\\pwsh.exe" || file.endsWith("powershell.exe"),
  });
  assert.deepEqual(shells.map((shell) => shell.id), ["pwsh", "powershell", "cmd"]);
  assert.equal(shells[0].path, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(shells[1].path, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(shells[2].path, "C:\\Windows\\system32\\cmd.exe");
  const plain = terminalShells({ platform: "win32", env: { PATH: "" }, exists: () => false });
  assert.deepEqual(plain.map((shell) => [shell.id, shell.path]), [["powershell", "powershell.exe"], ["cmd", "cmd.exe"]]);
});

test("shell list: macOS and Linux start the user's shell first; macOS shells are login shells", () => {
  const installed = new Set(["/opt/homebrew/bin/fish", "/bin/zsh", "/bin/bash", "/bin/sh"]);
  const mac = terminalShells({ platform: "darwin", env: { SHELL: "/opt/homebrew/bin/fish" }, exists: (file) => installed.has(file) });
  assert.deepEqual(mac.map((shell) => shell.path), ["/opt/homebrew/bin/fish", "/bin/zsh", "/bin/bash", "/bin/sh"]);
  assert.deepEqual(mac[0].args, ["-l"]);
  assert.deepEqual(mac.at(-1).args, []);
  const linux = terminalShells({ platform: "linux", env: {}, exists: (file) => file === "/bin/bash" || file === "/bin/sh" });
  assert.deepEqual(linux.map((shell) => [shell.id, shell.args]), [["bash", []], ["sh", []]]);
});

test("descendantsOf walks the whole process tree below a shell", () => {
  const listing = "  1     0\n 10     1\n 11    10\n 12    11\n 13    10\n 20     1\n";
  assert.deepEqual(descendantsOf(10, listing).sort(), [11, 12, 13]);
  assert.deepEqual(descendantsOf(20, listing), []);
});

function fakePty() {
  const spawned = [];
  const spawn = (file, args, options) => {
    const listeners = { data: [], exit: [] };
    const child = {
      pid: 4242 + spawned.length,
      file, args, options,
      written: [], resized: [], killed: [],
      onData: (fn) => listeners.data.push(fn),
      onExit: (fn) => listeners.exit.push(fn),
      write: (data) => child.written.push(data),
      resize: (cols, rows) => child.resized.push([cols, rows]),
      kill: (signal) => child.killed.push(signal ?? "default"),
      emit: (data) => listeners.data.forEach((fn) => fn(data)),
      exit: (exitCode) => listeners.exit.forEach((fn) => fn({ exitCode, signal: 0 })),
    };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

test("tabs are separate shells in their workspace folder, owned by their window", async () => {
  const { spawn, spawned } = fakePty();
  const sent = [];
  const sessions = createTerminalSessions({
    spawn,
    platform: "linux",
    env: { PATH: "/usr/bin" },
    resolveCwd: async (cwd) => String(cwd),
    shells: () => [{ id: "bash", label: "bash", path: "/bin/bash", args: [] }, { id: "sh", label: "sh", path: "/bin/sh", args: [] }],
    run: async () => "",
    isAlive: () => false,
  });
  const send = (channel, payload) => sent.push([channel, payload]);
  const a = await sessions.create({ ownerId: 1, workspaceId: "ws_a", cwd: "/work/a", cols: 100, rows: 30, send });
  const b = await sessions.create({ ownerId: 1, workspaceId: "ws_a", cwd: "/work/a", cols: 5, rows: 1, shellId: "sh", send });
  const c = await sessions.create({ ownerId: 2, workspaceId: "ws_b", cwd: "/work/b", send });
  assert.notEqual(a.terminalId, b.terminalId);
  assert.deepEqual(spawned.map((child) => [child.file, child.options.cwd, child.options.cols, child.options.rows]), [
    ["/bin/bash", "/work/a", 100, 30],
    ["/bin/sh", "/work/a", 20, 5],
    ["/bin/bash", "/work/b", 80, 24],
  ]);
  assert.equal(spawned[0].options.env.OMNIRUSH_TERMINAL, "1");
  assert.equal(b.shellLabel, "sh");

  spawned[0].emit("hello");
  assert.deepEqual(sent.at(-1), ["omnirush:terminal:data", { terminalId: a.terminalId, data: "hello" }]);
  // Another window cannot type into, resize or end a tab it does not own.
  sessions.write(2, a.terminalId, "rm -rf /\r");
  sessions.resize(2, a.terminalId, 200, 50);
  await sessions.kill(2, a.terminalId);
  assert.deepEqual(spawned[0].written, []);
  assert.deepEqual(spawned[0].resized, []);
  assert.deepEqual(spawned[0].killed, []);
  sessions.write(1, a.terminalId, "ls\r");
  assert.deepEqual(spawned[0].written, ["ls\r"]);

  // A shell the user exits tells its tab.
  spawned[1].exit(0);
  assert.deepEqual(sent.at(-1), ["omnirush:terminal:exit", { terminalId: b.terminalId, exitCode: 0, signal: 0 }]);
  assert.deepEqual(sessions.list(1), [a.terminalId]);

  // A closed tab ends its shell with SIGHUP and sends nothing more.
  await sessions.kill(1, a.terminalId);
  assert.deepEqual(spawned[0].killed, ["SIGHUP"]);
  const before = sent.length;
  spawned[0].emit("late");
  spawned[0].exit(129);
  assert.equal(sent.length, before);

  // A removed workspace ends only its own shells; a closed window ends its own.
  const d = await sessions.create({ ownerId: 1, workspaceId: "ws_b", cwd: "/work/b", send });
  assert.equal(await sessions.killWorkspace("ws_b"), 2);
  assert.deepEqual(spawned[2].killed, ["SIGHUP"]);
  assert.deepEqual(spawned[3].killed, ["SIGHUP"]);
  assert.deepEqual(sessions.list(1), []);
  assert.ok(d.terminalId);
  await sessions.create({ ownerId: 3, cwd: "/", send });
  await sessions.create({ ownerId: 4, cwd: "/", send });
  assert.equal(await sessions.killOwner(3), 1);
  assert.deepEqual(sessions.list(4).length, 1);
  await sessions.killAll();
  assert.deepEqual(sessions.list(4), []);
});

test("Windows: a closed tab ends the whole process tree with taskkill before closing the ConPTY", async () => {
  const { spawn, spawned } = fakePty();
  const runs = [];
  const sessions = createTerminalSessions({
    spawn,
    platform: "win32",
    env: {},
    resolveCwd: async (cwd) => String(cwd),
    shells: () => [{ id: "powershell", label: "Windows PowerShell", path: "powershell.exe", args: ["-NoLogo"] }],
    run: async (command, args) => {
      runs.push([command, ...args, `killed-before-close=${spawned[0].killed.length === 0}`]);
      return "";
    },
  });
  const { terminalId } = await sessions.create({ ownerId: 1, workspaceId: "ws", cwd: "C:\\work", send: () => undefined });
  assert.equal(spawned[0].options.useConpty, true);
  assert.deepEqual(spawned[0].args, ["-NoLogo"]);
  await sessions.kill(1, terminalId);
  assert.deepEqual(runs, [["taskkill", "/PID", String(spawned[0].pid), "/T", "/F", "killed-before-close=true"]]);
  assert.deepEqual(spawned[0].killed, ["default"]);
});

test("a shell that ignores SIGHUP, and what it started, are ended with SIGTERM then SIGKILL", async () => {
  const { spawn, spawned } = fakePty();
  const living = new Set([4242, 5001, 5002]);
  const signals = [];
  const sessions = createTerminalSessions({
    spawn,
    platform: "darwin",
    env: {},
    resolveCwd: async (cwd) => String(cwd),
    shells: () => [{ id: "zsh", label: "zsh", path: "/bin/zsh", args: ["-l"] }],
    run: async () => "4242 1\n5001 4242\n5002 5001\n6000 1\n4243 1\n5003 4243\n",
    isAlive: (pid) => living.has(pid),
    sendSignal: (pid, name) => {
      signals.push([pid, name]);
      if (name === "SIGKILL" || pid === 5002) living.delete(pid);
    },
    graceMs: 100,
    sleep: (ms) => sleep(Math.min(ms, 5)),
  });
  const { terminalId } = await sessions.create({ ownerId: 1, cwd: "/", send: () => undefined });
  await sessions.kill(1, terminalId);
  assert.deepEqual(spawned[0].killed, ["SIGHUP"]);
  assert.deepEqual(signals, [[4242, "SIGTERM"], [5001, "SIGTERM"], [5002, "SIGTERM"], [4242, "SIGKILL"], [5001, "SIGKILL"]]);
  assert.equal(living.size, 0);

  // A window that closed started ending its shells; the app's quit waits for that to finish.
  living.add(4243).add(5003);
  signals.length = 0;
  await sessions.create({ ownerId: 2, cwd: "/", send: () => undefined });
  const closing = sessions.killOwner(2);
  await sessions.killAll();
  assert.equal(living.size, 0, "killAll resolved before the closing window's shells were gone");
  await closing;
});

test("real shell (macOS/Linux): closing a tab leaves no process it started behind", { skip: process.platform === "win32" }, async () => {
  let pty;
  try {
    pty = require("node-pty");
  } catch {
    return;
  }
  const cwd = mkdtempSync(path.join(os.tmpdir(), "omnirush-terminal-"));
  try {
    const sessions = createTerminalSessions({
      spawn: (file, args, options) => pty.spawn(file, args, options),
      resolveCwd: async (dir) => String(dir),
      shells: () => [{ id: "sh", label: "sh", path: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: [] }],
      graceMs: 800,
    });
    let output = "";
    const { terminalId } = await sessions.create({ ownerId: 1, workspaceId: "ws", cwd, send: (channel, payload) => { if (channel === "omnirush:terminal:data") output += payload.data; } });
    // A background job that ignores SIGHUP, and a foreground one.
    sessions.write(1, terminalId, "pwd; (trap '' HUP; exec sleep 3001) & echo BG=$!; sleep 3002 &\r");
    sessions.write(1, terminalId, "echo FG_START; exec 2>&1; sleep 3003\r");
    assert.ok(await waitFor(() => /BG=\d+/.test(output) && output.includes("FG_START")), output);
    assert.ok(output.includes(realpathSync(cwd)) || output.includes(cwd), "the shell starts in the workspace folder");
    /** @type {string} */
    const listing = await new Promise((resolve) => require("node:child_process").execFile("ps", ["-A", "-o", "pid=,args="], (_e, out) => resolve(String(out))));
    const sleeps = listing.split("\n").filter((line) => /sleep 300[123]/.test(line)).map((line) => Number(line.trim().split(/\s+/)[0]));
    assert.equal(sleeps.length, 3, listing);
    await sessions.kill(1, terminalId);
    assert.ok(await waitFor(() => sleeps.every((pid) => !alive(pid)), 5000), `still running: ${sleeps.filter(alive)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
