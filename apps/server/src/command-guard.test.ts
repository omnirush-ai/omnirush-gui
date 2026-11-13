// @ts-nocheck -- ported from the CLI suite; exercises loosely typed fakes.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as guard from "./command-guard.js";
import * as toolchain from "./toolchain.js";
import * as uploader from "./session-uploader.js";
import { readArchiveGit } from "./session-archive/manifest.js";

// macOS without the Command Line Tools: /usr/bin/git, python3, cc, clang,
// make … are shims that open the "install the command line developer tools"
// dialog. Capture asks `xcode-select -p` once per process and, when it fails,
// never runs a shim that resolves to /usr/bin: the toolchain marks the tool
// `skipped: "xcode_clt_missing"`, the git block is null with
// `git_skipped: "xcode_clt_missing"`, and the archive's git reads fall back.
// A binary outside /usr/bin is still run.
//
// The platform and the PATH lookup are faked (this runs on Linux too); the
// binaries that would run are fake scripts in a PATH directory that log every
// invocation, so "never spawned" is checked against what actually ran.
const hasZstd = typeof zlib.zstdDecompressSync === "function";

/** A PATH directory of logging fakes plus a fake xcode-select exiting `xcodeExit`. */
function fakeTools(xcodeExit, devDir?) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-clt-"));
  const log = path.join(dir, "invocations.log");
  fs.writeFileSync(log, "");
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  script("git", 'echo "git version 2.39.5"');
  script("python3", 'echo "Python 3.9.6"');
  script("make", 'echo "GNU Make 3.81"');
  script("xcode-select", xcodeExit === 0 ? `echo "${devDir ?? dir}"` : `exit ${xcodeExit}`);
  const invocations = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { dir, log, invocations, xcodeSelectBin: path.join(dir, "xcode-select") };
}

/** Pretends to be macOS where `usrBin` commands resolve to /usr/bin and the rest to /opt/homebrew/bin. */
function fakeMac(tools, usrBin) {
  guard.configureCltProbe({
    platform: "darwin",
    xcodeSelectBin: tools.xcodeSelectBin,
    resolve: (command) => (usrBin.includes(command) ? `/usr/bin/${command}` : `/opt/homebrew/bin/${command}`),
  });
}

async function withPath(dir, fn) {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = previous;
    guard.configureCltProbe(null);
  }
}

function gitProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-clt-proj-"));
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname='demo'\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test.skipIf(process.platform === "win32")("xcode-select is asked once per process; a failing one marks the tools missing", async () => {
  const tools = fakeTools(2);
  fakeMac(tools, ["git", "python3"]);
  try {
    assert.equal(await guard.xcodeCltMissing(), true);
    assert.equal(await guard.cltSkipReason("git"), "xcode_clt_missing");
    assert.equal(await guard.cltSkipReason("python3"), "xcode_clt_missing");
    assert.equal(await guard.gitSkipReason(), "xcode_clt_missing");
    // Outside /usr/bin, or not a shim: fine to run.
    assert.equal(await guard.cltSkipReason("node"), null);
    assert.equal(await guard.cltSkipReason("python3", "/opt/homebrew/bin/python3"), null);
    assert.equal(await guard.cltSkipReason("rustc", "/usr/bin/rustc"), null);
    assert.deepEqual(tools.invocations(), ["xcode-select -p"], "xcode-select ran once, nothing else ran");
  } finally {
    guard.configureCltProbe(null);
  }
  const installed = fakeTools(0);
  fakeMac(installed, ["git"]);
  try {
    assert.equal(await guard.gitSkipReason(), null);
  } finally {
    guard.configureCltProbe(null);
  }
  // Not macOS: no question asked at all.
  guard.configureCltProbe({ platform: "linux", xcodeSelect: async () => assert.fail("xcode-select asked off macOS") });
  try {
    assert.equal(await guard.xcodeCltMissing(), false);
    assert.equal(await guard.gitSkipReason(), null);
  } finally {
    guard.configureCltProbe(null);
  }
});

test.skipIf(process.platform === "win32")("the toolchain never runs a /usr/bin shim without the tools, marks it skipped, and still probes the rest", async () => {
  const tools = fakeTools(2);
  fakeMac(tools, ["python3", "make", "gcc", "clang"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-clt-tc-"));
  fs.writeFileSync(path.join(root, "requirements.txt"), "attrs\n");
  const spawned = [];
  try {
    const result = await toolchain.collectToolchain(root, {
      platform: "darwin",
      // python3, gcc and clang resolve to /usr/bin; node to Homebrew.
      resolve: (command) => ({ python3: "/usr/bin/python3", gcc: "/usr/bin/gcc", clang: "/usr/bin/clang", node: "/opt/homebrew/bin/node", uv: "/opt/homebrew/bin/uv" })[command] ?? null,
      run: async (file, args) => {
        spawned.push(`${file} ${args.join(" ")}`);
        return { code: 0, stdout: file.endsWith("node") ? "v22.19.0\n" : "uv 0.5.0\n", stderr: "" };
      },
    });
    assert.deepEqual(result.versions, { node: "v22.19.0", uv: "uv 0.5.0" });
    assert.deepEqual(result.skipped, { python3: "xcode_clt_missing", gcc: "xcode_clt_missing", clang: "xcode_clt_missing", pip_freeze: "xcode_clt_missing", machine_python: "xcode_clt_missing" });
    // /usr/bin/sw_vers is part of macOS, not a Command Line Tools shim.
    assert.ok(spawned.every((line) => !/^\/usr\/bin\/(python3|gcc|clang)\b/.test(line) && !line.includes("--python /usr/bin")), spawned.join("\n"));
    assert.ok(spawned.includes("/opt/homebrew/bin/node -v"));
    assert.equal(result.pip_freeze, undefined);
  } finally {
    guard.configureCltProbe(null);
  }

  // A pyenv/Homebrew python is probed even without the tools.
  const brew = fakeTools(2);
  fakeMac(brew, ["git"]);
  try {
    const ran = [];
    const result = await toolchain.collectToolchain(root, {
      platform: "darwin",
      resolve: (command) => (command === "python3" ? "/Users/a/.pyenv/shims/python3" : null),
      run: async (file, args) => {
        ran.push(args.join(" "));
        return { code: 0, stdout: args[0] === "--version" ? "Python 3.12.3\n" : "attrs==24.2.0\n", stderr: "" };
      },
    });
    assert.equal(result.versions.python3, "Python 3.12.3");
    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.pip_freeze, ["attrs==24.2.0"]);
    assert.equal(result.python_executable_kind, "pyenv");
  } finally {
    guard.configureCltProbe(null);
  }
});

test.skipIf(process.platform === "win32")("without the tools, capture never spawns /usr/bin/git: collectGitBlock and the archive's git read answer without it", async () => {
  const root = gitProject();
  const tools = fakeTools(2);
  await withPath(tools.dir, async () => {
    fakeMac(tools, ["git"]);
    assert.equal(await uploader.collectGitBlock(root), null);
    assert.equal(await readArchiveGit(root), null);
    assert.deepEqual(tools.invocations(), ["xcode-select -p"], "git was never spawned");
  });

  // Control: with the tools installed the same fake git does run, so the
  // spy above would have seen it.
  const installed = fakeTools(0);
  await withPath(installed.dir, async () => {
    fakeMac(installed, ["git"]);
    await uploader.collectGitBlock(root);
    assert.ok(installed.invocations().some((line) => line.startsWith("git ")), installed.invocations().join("\n"));
  });
});

test.skipIf(!hasZstd || process.platform === "win32")("without the tools, the envelope's git block is null with git_skipped, and no git or python3 shim runs", async () => {
  const root = gitProject();
  const tools = fakeTools(2);
  const envelopes = await withPath(tools.dir, async () => {
    fakeMac(tools, ["git", "python3", "make"]);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-clt-state-"));
    const sent = [];
    const workspaceSync = new uploader.SessionUploader({
      stateDir,
      fallbackScanMs: 60_000,
      capabilities: async () => ({ schema_versions: [2], canonical_trace: false }),
      // The toolchain resolves through the real PATH lookup, where the fakes
      // sit first; the guard is told those names live in /usr/bin.
      toolchain: {
        platform: "darwin",
        resolve: (command) => (["git", "python3", "make"].includes(command) ? `/usr/bin/${command}` : null),
      },
      upload: async (_sessionId, compressed) => {
        sent.push(JSON.parse(zlib.zstdDecompressSync(Buffer.from(compressed)).toString("utf8")));
        return new Response("{}", { status: 201 });
      },
    });
    const sessionId = "01a0dcd2-d8ee-7222-80eb-240063770431";
    workspaceSync.startSession(sessionId, "ws", root);
    workspaceSync.recordTrace?.(sessionId, "note", { text: "hi" });
    await workspaceSync.idle(sessionId);
    await workspaceSync.stop();
    return sent;
  });
  assert.ok(envelopes.length >= 1);
  for (const envelope of envelopes) {
    assert.equal(envelope.workspace.git, null);
    assert.equal(envelope.workspace.git_skipped, "xcode_clt_missing");
    assert.equal(envelope.environment.git_version, null);
  }
  const start = envelopes.find((envelope) => envelope.snapshot_type === "start");
  assert.equal(envelopes.at(-1).environment.toolchain.skipped.python3, "xcode_clt_missing");
  assert.ok(start.files.some((file) => file.path === "README.md"), "the snapshot still lists the project without git");
  assert.deepEqual(tools.invocations(), ["xcode-select -p"], "no shim was spawned");
});

test("xcode-select succeeding with a developer folder that is gone counts as missing tools", async () => {
  if (process.platform === "win32") return;
  const tools = fakeTools(0, path.join(os.tmpdir(), "omnirush-clt-gone-" + process.pid));
  fakeMac(tools, ["git"]);
  try {
    assert.equal(await guard.xcodeCltMissing(), true);
  } finally {
    guard.configureCltProbe(null);
  }
});

test("xcode-select succeeding with an existing developer folder counts as installed", async () => {
  if (process.platform === "win32") return;
  const tools = fakeTools(0);
  fakeMac(tools, ["git"]);
  try {
    assert.equal(await guard.xcodeCltMissing(), false);
  } finally {
    guard.configureCltProbe(null);
  }
});
