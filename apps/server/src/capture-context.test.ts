// @ts-nocheck -- ported from the CLI suite (test/capture-context.test.js); exercises loosely typed fakes.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as privacy from "./context/privacy.js";
import * as exec from "./context/exec.js";
import * as systemPackages from "./context/system-packages.js";
import * as processes from "./context/processes.js";
import * as services from "./context/services.js";
import * as setup from "./context/setup.js";
import * as pmConfig from "./context/pm-config.js";
import * as shellAliases from "./context/shell-aliases.js";
import * as commands from "./context/commands.js";
import * as outside from "./context/outside.js";
import * as ephemeral from "./context/ephemeral.js";
import * as network from "./context/network.js";
import * as context from "./context/index.js";
import * as uploader from "./session-uploader.js";

// Capture context (capture v2): machine context recorded as trace events —
// system packages (#5), services (#7), outside folders (#10), the agent's
// setup (#16), package-manager config (#17), shell aliases (#18), processes
// and ports (#19), network hosts per tool call (#20), reused temp files
// (#21) and on-the-fly tools (#22). Every item is scrubbed, `~` replaces
// the home directory, and OMNIRUSH_CAPTURE_CONTEXT=0 turns it all off.
const hasZstd = typeof zlib.zstdDecompressSync === "function";

/** The uploader's real CONFIG scrub. */
const SCRUB = {
  text: (text) => uploader.redactUploadText(text).text,
  json: (value) => uploader.redactUploadJson(value).value,
  content: (file, text) => uploader.redactUploadContent(file, text),
};

// Real-looking secrets (synthetic).
const GH_TOKEN = "ghp_R4nd0mT0k3nV4lu3F0rT3st1ngPurp0s3sXyZ";
const NPM_TOKEN = "npm_9fK2LmQ8rT1vX4zB7nC3dE6gH0jP5sW2yA1u";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const PASSWORD = "Hunter2-Sup3rS3cret!";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omnirush-ctx-${prefix}-`));
}

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

const ok = (stdout, stderr = "") => ({ code: 0, stdout, stderr, truncated: false, timedOut: false });

function fakeRun(outputs, calls = []) {
  return async (file, args, options = {}) => {
    calls.push({ file, args, env: options.env });
    const output = outputs[path.basename(file)];
    if (output === undefined) return null;
    return typeof output === "function" ? output(args) : output;
  };
}

function assertNoSecrets(value, secrets = [GH_TOKEN, NPM_TOKEN, AWS_SECRET, PASSWORD]) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 8)}…: ${text.slice(0, 400)}`);
}

// --- privacy ------------------------------------------------------------------------

test("privacy: a Windows account name in a profile path is masked in every form, the path kept (WSL, Git Bash, \\wsl$, names with spaces)", () => {
  // WSL: the Windows account is called the same as the Linux one, or not; never "/mnt/c~".
  const same = { home: "/home/sam", user: "sam" };
  assert.equal(privacy.tildeText("cd /mnt/c/Users/sam/app && ls /home/sam", same), "cd /mnt/c/Users/user/app && ls ~");
  assert.equal(privacy.tildeText("/mnt/c/Users/WinName/app", same), "/mnt/c/Users/user/app");
  assert.equal(privacy.tildeText("/mnt/d/Users/sam", same), "/mnt/d/Users/user");
  assert.equal(privacy.tildeText("/mnt/c/Users/user/x and /Users/user/y", { home: "/home/user", user: "user" }), "/mnt/c/Users/user/x and ~/y");
  // Names with spaces: the whole segment (another segment or a closing quote follows); in prose the name ends at a space.
  assert.equal(privacy.maskWindowsProfiles("cd '/mnt/c/Users/Jane Doe/proj'"), "cd '/mnt/c/Users/user/proj'");
  assert.equal(privacy.maskWindowsProfiles('"C:\\Users\\Jane Doe"'), '"C:\\Users\\user"');
  assert.equal(privacy.maskWindowsProfiles("C:\\Users\\sam and more."), "C:\\Users\\user and more.");
  // Drive paths, either slash, any case, JSON-escaped; Git Bash and Cygwin; the WSL home from Windows.
  assert.equal(privacy.maskWindowsProfiles("C:\\Users\\Al.ice\\x c:/users/bob D:\\Users\\Carol."), "C:\\Users\\user\\x c:/users/user D:\\Users\\user.");
  assert.equal(privacy.maskWindowsProfiles('{"cwd":"C:\\\\Users\\\\sam\\\\proj"}'), '{"cwd":"C:\\\\Users\\\\user\\\\proj"}');
  assert.equal(privacy.maskWindowsProfiles("/c/Users/Alice/x /cygdrive/c/Users/Alice"), "/c/Users/user/x /cygdrive/c/Users/user");
  assert.equal(privacy.maskWindowsProfiles("\\\\wsl$\\Ubuntu\\home\\sam\\p \\\\wsl.localhost\\Ubuntu-22.04\\home\\sam //wsl$/Ubuntu/home/sam"), "\\\\wsl$\\Ubuntu\\home\\user\\p \\\\wsl.localhost\\Ubuntu-22.04\\home\\user //wsl$/Ubuntu/home/user");
  // The same name always masks the same; shared profiles and lookalikes stay.
  assert.equal(privacy.maskWindowsProfiles("/mnt/c/Users/sam/a /mnt/c/Users/sam/b"), "/mnt/c/Users/user/a /mnt/c/Users/user/b");
  for (const kept of ["C:\\Users\\Public\\Desktop", "/mnt/c/Users/", "src/c/Users/x", "C:\\Program Files\\x", "/home/sam"]) assert.equal(privacy.maskWindowsProfiles(kept), kept);
  // The uploader's scrub masks it in every trace string and file too, and counts it (a changed text is never "clean").
  assert.deepEqual(uploader.redactUploadText("cd /mnt/c/Users/WinName/app"), { text: "cd /mnt/c/Users/user/app", count: 1 });
  assert.deepEqual(uploader.redactUploadText("cd /mnt/c/Users/user/app"), { text: "cd /mnt/c/Users/user/app", count: 0 });
});

test("privacy: the home directory and the account name become ~; URLs lose userinfo; addresses become classes", () => {
  const ctx = { home: "/home/alice", user: "alice" };
  assert.equal(privacy.tildeText("cd /home/alice/proj && ls /home/alice", ctx), "cd ~/proj && ls ~");
  assert.equal(privacy.tildeText("/home/alicex/a stays", ctx), "/home/alicex/a stays");
  assert.equal(privacy.tildeText("C:\\Users\\alice\\x and /Users/alice/y", { home: "C:\\Users\\alice", user: "alice" }), "~\\x and ~/y");
  assert.equal(privacy.cleanUrl("https://bob:pw@registry.example.com/npm/?token=abc&x=1"), "https://registry.example.com/npm/?token=[REDACTED]&x=1");
  assert.equal(privacy.cleanUrl("https://conda.anaconda.org/t/abc-123/mychannel"), "https://conda.anaconda.org/t/[REDACTED]/mychannel");
  assert.equal(privacy.addressClass("127.0.0.1"), "loopback");
  assert.equal(privacy.addressClass("::1"), "loopback");
  assert.equal(privacy.addressClass("0.0.0.0"), "any");
  assert.equal(privacy.addressClass("192.168.1.4"), "private");
  assert.equal(privacy.addressClass("140.82.112.3"), "public");
  assert.ok(privacy.isSecretKey("//registry.npmjs.org/:_authToken"));
  assert.ok(privacy.isSecretKey("_auth"));
  assert.ok(privacy.isSecretKey("npmAuthToken"));
  assert.ok(!privacy.isSecretKey("registry"));
  assert.ok(!privacy.isSecretKey("index-url"));
});

test("context switches: OMNIRUSH_CAPTURE_CONTEXT=0 turns everything off, OMNIRUSH_CAPTURE_NETWORK=0 only the network observer", () => {
  assert.equal(context.captureContextEnabled({}), true);
  assert.equal(context.captureContextEnabled({ OMNIRUSH_CAPTURE_CONTEXT: "0" }), false);
  assert.equal(context.captureContextEnabled({ OMNIRUSH_CAPTURE_CONTEXT: "off" }), false);
  assert.equal(context.captureNetworkEnabled({ OMNIRUSH_CAPTURE_NETWORK: "0" }), false);
  assert.equal(context.captureNetworkEnabled({ OMNIRUSH_CAPTURE_CONTEXT: "0" }), false);
  const capture = new context.ContextCapture({ client: "cli", scrub: SCRUB, record: () => assert.fail("nothing is recorded"), env: { OMNIRUSH_CAPTURE_CONTEXT: "0" } });
  assert.equal(capture.enabled, false);
  capture.sessionStarted("s1-aaaaaaaa", tmp("off"));
  capture.turnStarted("s1-aaaaaaaa");
  capture.turnMessages("s1-aaaaaaaa", []);
});

// --- exec / CLT guard ----------------------------------------------------------------

test("exec: a missing tool is never spawned; a /usr/bin CLT shim is never run on a Mac without the tools", async () => {
  const calls = [];
  assert.equal(await exec.runTool("nope", [], { resolve: () => null, run: fakeRun({}, calls) }), null);
  exec.configureContextCltProbe({ platform: "darwin", xcodeSelect: async () => false });
  try {
    assert.equal(await exec.runTool("git", ["--version"], { resolve: () => "/usr/bin/git", run: fakeRun({ git: ok("git 2") }, calls) }), null);
    assert.deepEqual((await exec.runTool("git", ["--version"], { resolve: () => "/opt/homebrew/bin/git", run: fakeRun({ git: ok("git 2") }, calls) })).stdout, "git 2");
  } finally {
    exec.configureContextCltProbe(null);
  }
  assert.equal(calls.length, 1);
});

test.skipIf(process.platform === "win32")("exec: a hanging command is killed at its timeout, its group included", async () => {
  const started = Date.now();
  const result = await exec.runCommand("/bin/sh", ["-c", "(sleep 30) & sleep 30"], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2_000);
});

// --- #5 system packages ------------------------------------------------------------------

test("#5 system packages: dpkg/apk/winget parsing, 256 KiB cap, once a day per machine", async () => {
  assert.deepEqual(systemPackages.parseNameVersionLines("bash 5.2.21-2ubuntu4\nzlib1g 1:1.3\n"), [{ name: "bash", version: "5.2.21-2ubuntu4" }, { name: "zlib1g", version: "1:1.3" }]);
  assert.deepEqual(systemPackages.parseApk("musl-1.2.4-r2\nca-certificates-bundle-20230506-r0\n"), [{ name: "musl", version: "1.2.4-r2" }, { name: "ca-certificates-bundle", version: "20230506-r0" }]);
  const winget = "Name                 Id                      Version   Source\n--------------------------------------------------------------\nGit                  Git.Git                 2.44.0    winget\nNode.js LTS          OpenJS.NodeJS.LTS       20.11.1   winget\n";
  assert.deepEqual(systemPackages.parseWinget(winget), [{ name: "Git.Git", version: "2.44.0" }, { name: "OpenJS.NodeJS.LTS", version: "20.11.1" }]);
  assert.equal(systemPackages.wingetWouldPrompt({ code: 1, stdout: "Do you agree to all the source agreements terms? [Y] Yes", stderr: "" }), true);

  const big = Array.from({ length: 20_000 }, (_, i) => `package-number-${i} 1.0.${i}-ubuntu1`).join("\n");
  const calls = [];
  const cacheDir = tmp("pkgcache");
  let day = new Date(2026, 9, 4, 10);
  const options = { platform: "linux", cacheDir, machine: "box/linux", now: () => day, resolve: (c) => (c === "dpkg-query" ? "/usr/bin/dpkg-query" : null), run: fakeRun({ "dpkg-query": ok(big) }, calls) };
  const first = await systemPackages.systemPackages(options);
  assert.equal(first.manager, "dpkg");
  assert.equal(first.count, 20_000);
  assert.equal(first.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first.packages)) <= 256 * 1024);
  assert.deepEqual(calls[0].args, ["-W", "-f", "${Package} ${Version}\\n"]);
  await systemPackages.systemPackages(options);
  assert.equal(calls.length, 1, "the same day reuses the cache");
  day = new Date(2026, 9, 5, 9);
  await systemPackages.systemPackages(options);
  assert.equal(calls.length, 2, "the next day lists again");
  assert.deepEqual(await systemPackages.listSystemPackages({ platform: "darwin", resolve: () => null }), { skipped: "not_found" });
  const winCalls = [];
  const prompted = await systemPackages.listSystemPackages({ platform: "win32", resolve: () => "C:\\winget.exe", run: fakeRun({ "C:\\winget.exe": { code: 1, stdout: "You must accept the source agreements [Y] Yes [N] No", stderr: "", truncated: false, timedOut: false } }, winCalls) });
  assert.deepEqual(prompted, { skipped: "would_prompt" });
  assert.ok(winCalls[0].args.includes("--disable-interactivity"));
});

// --- #19 processes ---------------------------------------------------------------------

test("#19 parsers: /proc stat and addresses, ss, lsof, netstat, ps", () => {
  assert.deepEqual(processes.parseProcStat("123 (node server) S 45 123 123 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 11 0 9876 1 1"), { comm: "node server", ppid: 45, startTicks: 9876 });
  assert.deepEqual(processes.parseProcAddress("0100007F:1F90"), { address: "127.0.0.1", port: 8080 });
  assert.deepEqual(processes.parseProcAddress("00000000000000000000000001000000:0050"), { address: "::1", port: 80 });
  assert.deepEqual(processes.parseSsListening('LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=812,fd=6))\nLISTEN 0 511 [::]:3000 [::]:*\n'), [
    { proto: "tcp", address: "127.0.0.1", port: 5432, pid: 812, process: "postgres" },
    { proto: "tcp", address: "::", port: 3000, pid: null, process: null },
  ]);
  assert.deepEqual(processes.parseLsofListen("p501\ncnode\nn*:3000\nn127.0.0.1:9229\n"), [
    { proto: "tcp", address: "0.0.0.0", port: 3000, pid: 501, process: "node" },
    { proto: "tcp", address: "127.0.0.1", port: 9229, pid: 501, process: "node" },
  ]);
  assert.deepEqual(processes.parseNetstat("  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   1044\n  TCP 10.0.0.2:5000 1.2.3.4:443 ESTABLISHED 77\n"), [{ local: "0.0.0.0:135", remote: "0.0.0.0:0", pid: 1044 }]);
  assert.equal(processes.isDevProcess("python3.12"), true);
  assert.equal(processes.isDevProcess("bash", "node server.js"), true);
  assert.equal(processes.isDevProcess("Xorg"), false);
});

test.skipIf(process.platform !== "linux")("#19 snapshot: dev processes with scrubbed arguments, listening ports as address classes, own engine left out", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)", "--", `--token=${GH_TOKEN}`, `--password`, PASSWORD, `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = await processes.processSnapshot("turn_start", 3, { privacy: privacy.currentPrivacy(), scrub: SCRUB });
    assert.equal(snapshot.phase, "turn_start");
    assert.equal(snapshot.turn, 3);
    const mine = snapshot.processes.find((entry) => entry.pid === child.pid);
    assert.ok(mine, "the node child is a dev process");
    assert.ok(mine.command.includes("--token=[REDACTED]"));
    assertNoSecrets(snapshot);
    assert.ok(!snapshot.processes.some((entry) => entry.pid === process.pid), "capture's own process is left out");
    const listening = snapshot.listening.find((entry) => entry.port === port);
    assert.ok(listening, `port ${port} is listed`);
    assert.equal(listening.address, "loopback");
    assert.ok(snapshot.processes.length <= processes.MAX_PROCESSES);
    assert.ok(!JSON.stringify(snapshot).includes(os.homedir() + "/"), "no home path");
  } finally {
    child.kill();
    server.close();
  }
});

// --- #7 services -------------------------------------------------------------------------

test("#7 services: docker containers with image digests, local databases by port with client versions, compose files", async () => {
  assert.deepEqual(services.composeFilesOfLabels("com.docker.compose.project=demo,com.docker.compose.project.config_files=/srv/demo/compose.yaml,com.docker.compose.service=db"), ["/srv/demo/compose.yaml"]);
  const root = write(tmp("svc"), { "docker-compose.yml": "services: {}\n", "deploy/compose.prod.yaml": "services: {}\n", "node_modules/x/compose.yml": "" });
  const calls = [];
  const run = fakeRun({
    docker: (args) => {
      if (args[0] === "ps") return ok([
        JSON.stringify({ ID: "abc123", Names: "demo-db-1", Image: "postgres:16", Ports: "127.0.0.1:5432->5432/tcp", Status: "Up 2 hours", Labels: "com.docker.compose.project.config_files=/srv/demo/compose.yaml" }),
        JSON.stringify({ ID: "def456", Names: "telegram-bot", Image: "secret/bot:1", Ports: "", Status: "Up 9 days", Labels: "com.docker.compose.project.config_files=/home/someone/private/bot/compose.yml" }),
      ].join("\n") + "\n");
      // demo-db-1 bind-mounts the project; telegram-bot is unrelated and older than the session.
      if (args[0] === "inspect") return ok(`abc123 sha256:img1 2020-01-01T00:00:00.123456789Z ${JSON.stringify([{ Type: "bind", Source: `${root}/data` }])}\ndef456 sha256:img2 2020-01-01T00:00:00Z ${JSON.stringify([{ Type: "bind", Source: "/home/someone/private/bot" }])}\n`);
      if (args[0] === "image") return ok('sha256:img1 ["postgres@sha256:deadbeef"]\n');
      return null;
    },
    psql: ok("psql (PostgreSQL) 16.3\n"),
    "redis-server": ok("Redis server v=7.2.4 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=abc\n"),
  }, calls);
  const result = await services.collectServices({
    root,
    listening: [
      { proto: "tcp", address: "127.0.0.1", port: 5432, pid: 1, process: "docker-proxy" },
      { proto: "tcp", address: "0.0.0.0", port: 6379, pid: 2, process: "redis-server" },
      { proto: "tcp", address: "127.0.0.1", port: 3000, pid: 3, process: "node" },
    ],
    processes: [],
    privacy: privacy.currentPrivacy(),
    scrub: SCRUB,
    platform: "darwin",
    run,
    resolve: (command) => (["docker", "psql", "redis-server"].includes(command) ? `/usr/local/bin/${command}` : null),
  });
  assert.equal(result.docker.reachable, true);
  assert.equal(result.docker.other_containers, 1, "the unrelated container is counted, not named");
  assert.ok(!JSON.stringify(result).includes("telegram") && !JSON.stringify(result).includes("private/bot"));
  assert.deepEqual(result.docker.containers, [{ name: "demo-db-1", image: "postgres:16", image_digest: "postgres@sha256:deadbeef", ports: "127.0.0.1:5432->5432/tcp".replace("127.0.0.1", uploader.redactUploadText("127.0.0.1").text), status: "Up 2 hours" }]);
  assert.deepEqual(result.databases, [
    { kind: "postgres", port: 5432, address: "loopback", client_version: "psql (PostgreSQL) 16.3", process: "docker-proxy" },
    { kind: "redis", port: 6379, address: "any", client_version: "Redis server v=7.2.4 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=abc", process: "redis-server" },
  ]);
  assert.ok(calls.filter((call) => /psql|redis/.test(call.file)).every((call) => call.args.length === 1 && call.args[0] === "--version"), "clients are only asked their version");
  assert.deepEqual(result.compose_files.sort(), ["$PROJECT/deploy/compose.prod.yaml", "$PROJECT/docker-compose.yml", "/srv/demo/compose.yaml"]);
  const noDocker = await services.collectServices({ root, listening: [], processes: [], privacy: privacy.currentPrivacy(), scrub: SCRUB, platform: "linux", resolve: () => null });
  assert.deepEqual(noDocker.docker, { reachable: false, containers: [], skipped: "not_installed" });
});

// --- #16 setup -----------------------------------------------------------------------------

test("#16 setup: skills/plugins with scrubbed texts, MCP servers with names only for env, secret args redacted, versions resolved", async () => {
  const home = tmp("home");
  const root = tmp("proj");
  const bundled = write(tmp("bundled"), { "omnirush-build/SKILL.md": "---\nname: omnirush-build\nversion: 1.2.0\n---\nBuild.\n" });
  write(home, {
    ".config/opencode/skills/deploy/SKILL.md": `---\nname: deploy\nversion: 0.3.1\n---\nexport GITHUB_TOKEN=${GH_TOKEN}\n`,
    ".config/opencode/skills/deploy/scripts/run.sh": `#!/bin/sh\ncurl -H "Authorization: Bearer ${NPM_TOKEN}" https://api.example.com\n`,
    ".config/opencode/skills/deploy/.env": `SECRET=${PASSWORD}\n`,
    ".config/opencode/plugin/notify.ts": `export const apiKey = "${GH_TOKEN}";\n`,
    ".config/opencode/opencode.json": JSON.stringify({
      model: "omnirush/gpt",
      plugin: ["opencode-wakatime@1.4.0", "opencode-other"],
      agent: { build: { model: "omnirush/gpt", variant: "high", options: { reasoningEffort: "high", apiKey: GH_TOKEN } } },
      mcp: {
        github: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-github@2025.4.8", "--token", GH_TOKEN], environment: { GITHUB_PERSONAL_ACCESS_TOKEN: GH_TOKEN } },
        remote: { type: "remote", url: `https://user:${PASSWORD}@mcp.example.com/sse?api_key=${NPM_TOKEN}`, headers: { Authorization: `Bearer ${NPM_TOKEN}` } },
      },
    }),
    ".cache/opencode/node_modules/opencode-other/package.json": JSON.stringify({ name: "opencode-other", version: "3.1.4" }),
  });
  const installed = write(tmp("mcpinst"), { "node_modules/@acme/mcp-db/package.json": JSON.stringify({ name: "@acme/mcp-db", version: "0.9.2" }), "node_modules/@acme/mcp-db/dist/index.js": "" });
  write(root, { ".mcp.json": JSON.stringify({ mcpServers: { db: { command: "node", args: [path.join(installed, "node_modules/@acme/mcp-db/dist/index.js"), `--password=${PASSWORD}`], env: { DB_PASSWORD: PASSWORD } } } }) });
  const ctx = { home, user: path.basename(home) };
  const { setup: result, files } = await setup.collectSetup({
    root,
    client: "cli",
    appVersion: "omnirush-cli/2.0.9",
    engineVersion: "1.18.32",
    model: { provider_id: "omnirush", model_id: "gpt", variant: "high", agent: "build" },
    bundledSkillDirs: [bundled],
    privacy: ctx,
    scrub: SCRUB,
    denied: (rel) => uploader.isUploadPathDenied(rel),
    env: { XDG_CONFIG_HOME: path.join(home, ".config") },
  });
  assert.equal(result.app_version, "omnirush-cli/2.0.9");
  assert.deepEqual(result.bundled_skills.map((s) => [s.name, s.version]), [["omnirush-build", "1.2.0"]]);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, "deploy");
  assert.equal(result.skills[0].version, "0.3.1");
  assert.equal(result.skills[0].root, "~/.config/opencode/skills/deploy");
  assert.deepEqual(files.filter((f) => f.kind === "skill").map((f) => f.rel).sort(), ["SKILL.md", "scripts/run.sh"], "the .env file is denied");
  assert.ok(files.find((f) => f.rel === "SKILL.md").content.includes("Build") === false);
  assert.deepEqual(result.plugins.map((p) => [p.name, p.version, p.source]).sort(), [["notify", null, "file"], ["opencode-other", "3.1.4", "npm"], ["opencode-wakatime", "1.4.0", "npm"]]);
  const github = result.mcp_servers.find((s) => s.name === "github");
  assert.deepEqual([github.package, github.version, github.version_source], ["@modelcontextprotocol/server-github", "2025.4.8", "spec"]);
  assert.deepEqual(github.env_names, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  assert.deepEqual(github.args.slice(-2), ["--token", "[REDACTED]"]);
  const remote = result.mcp_servers.find((s) => s.name === "remote");
  assert.equal(remote.type, "remote");
  assert.deepEqual(remote.header_names, ["Authorization"]);
  assert.ok(remote.url.startsWith("https://mcp.example.com/sse"));
  const db = result.mcp_servers.find((s) => s.name === "db");
  assert.deepEqual([db.package, db.version, db.version_source, db.scope], ["@acme/mcp-db", "0.9.2", "installed", "project"]);
  assert.ok(db.args.includes("--password=[REDACTED]"));
  assert.equal(result.settings.agent.build.reasoningEffort, "high");
  assert.equal(result.settings.agent.build.variant, "high");
  assertNoSecrets({ result, files });
  assert.ok(!JSON.stringify({ result, files }).includes(home), "home is ~");
});

// --- #17 package-manager config -------------------------------------------------------------

test("#17 package-manager config: keys and safe values kept, every credential key dropped, URLs stripped, scrub on top", async () => {
  const goCalls = [];
  const home = tmp("pmhome");
  write(home, {
    ".npmrc": `registry=https://registry.npmjs.org/\n@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=${NPM_TOKEN}\n//registry.npmjs.org/:_auth=${Buffer.from(`u:${PASSWORD}`).toString("base64")}\n_password=${PASSWORD}\nemail=dev@acme.dev\nstrict-ssl=true\nproxy=http://proxyuser:${PASSWORD}@proxy.acme.dev:8080\n`,
    ".yarnrc.yml": `npmRegistryServer: "https://npm.acme.dev"\nnpmAuthToken: ${NPM_TOKEN}\nnpmScopes:\n  acme:\n    npmRegistryServer: https://npm.acme.dev\n    npmAuthToken: ${NPM_TOKEN}\nenableTelemetry: false\n`,
    ".config/pip/pip.conf": `[global]\nindex-url = https://pypi-user:${PASSWORD}@pypi.acme.dev/simple\nextra-index-url = https://pypi.org/simple\ntrusted-host = pypi.acme.dev\n`,
    ".config/uv/uv.toml": `index-url = "https://__token__:${GH_TOKEN}@pypi.acme.dev/simple"\n[[index]]\nname = "acme"\nurl = "https://pypi.acme.dev/simple"\n`,
    ".cargo/config.toml": `[registries.acme]\nindex = "sparse+https://cargo.acme.dev/index/"\ntoken = "${GH_TOKEN}"\n[net]\ngit-fetch-with-cli = true\n`,
    ".gradle/gradle.properties": `org.gradle.jvmargs=-Xmx2g\nsigning.password=${PASSWORD}\nmavenPassword=${PASSWORD}\nsonatypeToken=${NPM_TOKEN}\n`,
    ".m2/settings.xml": `<settings><mirrors><mirror><id>acme</id><url>https://repo.acme.dev/maven</url><mirrorOf>*</mirrorOf></mirror></mirrors><servers><server><id>acme</id><username>deploy</username><password>${PASSWORD}</password></server></servers></settings>`,
    ".condarc": `channels:\n  - https://conda.anaconda.org/t/${GH_TOKEN}/acme\n  - conda-forge\nssl_verify: true\n`,
  });
  const result = await pmConfig.collectPmConfig({
    privacy: { home, user: null },
    scrub: SCRUB,
    platform: "linux",
    env: {},
    resolve: (command) => (command === "go" ? "/usr/local/go/bin/go" : null),
    run: fakeRun({ go: ok(JSON.stringify({ GOPROXY: `https://gouser:${PASSWORD}@goproxy.acme.dev,direct`, GOPRIVATE: "github.com/acme/*", GOFLAGS: "-mod=mod" })) }, goCalls),
  });
  assert.equal(goCalls[0].env.GOTOOLCHAIN, "local", "go env never downloads a toolchain");
  const byTool = Object.fromEntries(result.files.map((file) => [`${file.tool}:${file.path}`, file]));
  const npm = byTool["npm:~/.npmrc"];
  assert.deepEqual(npm.entries, { registry: "https://registry.npmjs.org/", "@acme:registry": "https://npm.acme.dev/", "strict-ssl": "true", proxy: "http://proxy.acme.dev:8080" });
  assert.equal(npm.dropped_keys, 4);
  assert.equal(byTool["yarn:~/.yarnrc.yml"].entries["npmScopes.acme.npmRegistryServer"], "https://npm.acme.dev");
  assert.equal(byTool["pip:~/.config/pip/pip.conf"].entries["global.index-url"], "https://pypi.acme.dev/simple");
  assert.equal(byTool["uv:~/.config/uv/uv.toml"].entries["index[0].url"], "https://pypi.acme.dev/simple");
  assert.equal(byTool["cargo:~/.cargo/config.toml"].entries["registries.acme.index"], "sparse+https://cargo.acme.dev/index/");
  assert.equal("registries.acme.token" in byTool["cargo:~/.cargo/config.toml"].entries, false);
  assert.deepEqual(byTool["gradle:~/.gradle/gradle.properties"].entries, { "org.gradle.jvmargs": "-Xmx2g" });
  assert.deepEqual(byTool["maven:~/.m2/settings.xml"].entries, { "mirrors[0].id": "acme", "mirrors[0].url": "https://repo.acme.dev/maven", "mirrors[0].mirrorOf": "*", "servers[0].id": "acme" });
  assert.equal(byTool["conda:~/.condarc"].entries["channels[0]"], "https://conda.anaconda.org/t/[REDACTED]/acme");
  assert.deepEqual(result.go_env, { GOPROXY: "https://goproxy.acme.dev,direct", GOPRIVATE: "github.com/acme/*", GOFLAGS: "-mod=mod" });
  assertNoSecrets(result);
  assert.ok(!JSON.stringify(result).includes("dev@acme.dev"), "email is dropped");
  assert.ok(!JSON.stringify(result).includes(home));
});

// --- #18 shell aliases -----------------------------------------------------------------------

test("#18 shell aliases: toolchain aliases and functions from rc files (never sourced), scrubbed; shims on PATH", async () => {
  const home = tmp("rc");
  write(home, {
    ".bashrc": `alias python=python3\nalias pip='pip3'\nalias ll='ls -la'\nalias gh-api="curl -H 'Authorization: token ${GH_TOKEN}'"\nnode() { /opt/node20/bin/node "$@"; }\nexport PATH=$PATH:~/bin\n`,
    ".zshrc": "alias -g npmi='npm install'\nalias k=kubectl\n",
    ".config/fish/config.fish": "alias py 'python3'\nabbr -a gco git checkout\n",
  });
  const bin = tmp("bin");
  fs.writeFileSync(path.join(bin, "python3.12"), "");
  fs.symlinkSync(path.join(bin, "python3.12"), path.join(bin, "python"));
  const result = await shellAliases.collectShellAliases({
    privacy: { home, user: null },
    scrub: SCRUB,
    platform: "linux",
    env: {},
    resolve: (command) => exec.resolveCommand(command, { pathEnv: bin, platform: "linux" }),
  });
  const names = result.aliases.map((alias) => `${alias.name}=${alias.value}@${alias.file}:${alias.kind}`);
  assert.ok(names.includes("python=python3@~/.bashrc:alias"));
  assert.ok(names.includes("pip=pip3@~/.bashrc:alias"));
  assert.ok(names.includes("node=/opt/node20/bin/node \"$@\"@~/.bashrc:function"));
  assert.ok(names.includes("npmi=npm install@~/.zshrc:alias"));
  assert.ok(names.includes("k=kubectl@~/.zshrc:alias"));
  assert.ok(names.includes("py=python3@~/.config/fish/config.fish:alias"));
  assert.ok(names.includes("gco=git checkout@~/.config/fish/config.fish:abbr"));
  assert.ok(!names.some((name) => name.startsWith("ll=")), "non-toolchain aliases are left out");
  assert.ok(!names.some((name) => name.startsWith("gh-api=")), "curl aliases are not toolchain aliases");
  assert.deepEqual(result.shims, [{ name: "python", target: "python3.12", kind: "symlink" }]);
  assert.deepEqual(shellAliases.parsePowerShellRc("Set-Alias python py\nNew-Alias -Name pip -Value 'py -m pip'\nfunction node { & 'C:\\node\\node.exe' @args }\n").map((a) => a.name), ["python", "pip", "node"]);
  const leaky = shellAliases.parsePosixRc(`alias npmpub="NPM_TOKEN=${NPM_TOKEN} npm publish"\n`);
  const cleaned = await shellAliases.collectShellAliases({ privacy: { home: write(tmp("rc2"), { ".bashrc": `alias npmpub="NPM_TOKEN=${NPM_TOKEN} npm publish"\n` }), user: null }, scrub: SCRUB, platform: "linux", env: {}, resolve: () => null });
  assert.equal(leaky[0].name, "npmpub");
  assert.ok(cleaned.aliases.length === 0 || !JSON.stringify(cleaned).includes(NPM_TOKEN));
});

// --- shell command parsing (#10/#21/#22) -------------------------------------------------------

test("command effects: cd chains, created folders, writes, executed scripts, heredocs and on-the-fly tools", () => {
  const home = "/home/u";
  const e = commands.commandEffects(
    "mkdir -p ~/apps/demo && cd ~/apps/demo && git clone --depth 1 https://github.com/acme/tool.git && npm create vite@latest web -- --template react\n"
    + "cat > /tmp/gen.py <<'EOF'\nprint('x')\nrm -rf /\nEOF\npython3 /tmp/gen.py > out.txt; bash ../run.sh; ./bin/build --fast; source ~/.venvrc\n"
    + "npx -y cowsay@1.6.0 hi | pnpm dlx create-next-app my-app; uvx ruff==0.6.9 check .; pipx run black --version; bunx prettier; go run golang.org/x/tools/cmd/stringer@v0.24.0 -h; deno run npm:chalk@5.3.0",
    "/proj",
    home,
  );
  assert.deepEqual(e.folders.map((f) => [f.path, f.via, f.created]), [
    ["/home/u/apps/demo", "mkdir", true],
    ["/home/u/apps/demo", "cd", false],
    ["/home/u/apps/demo/tool", "git clone", true],
    ["/home/u/apps/demo/web", "create", true],
    ["/home/u/apps/demo/my-app", "create", true],
  ]);
  assert.ok(e.writes.includes("/tmp/gen.py"));
  assert.ok(e.writes.includes("/home/u/apps/demo/out.txt"));
  assert.ok(!e.writes.includes("/"), "heredoc bodies are not commands");
  assert.deepEqual(e.executed, ["/tmp/gen.py", "/home/u/apps/run.sh", "/home/u/apps/demo/bin/build", "/home/u/.venvrc"]);
  assert.deepEqual(e.ephemeral.map((t) => [t.runner, t.package, t.requested]), [
    ["npx", "cowsay", "1.6.0"],
    ["pnpm dlx", "create-next-app", null],
    ["uvx", "ruff", "0.6.9"],
    ["pipx run", "black", null],
    ["bunx", "prettier", null],
    ["go run", "golang.org/x/tools/cmd/stringer", "v0.24.0"],
    ["deno run", "chalk", "5.3.0"],
  ]);
  const calls = commands.toolCallsOf([{ info: { role: "assistant" }, parts: [
    { type: "tool", tool: "bash", callID: "c2", state: { status: "completed", input: { command: "ls", workdir: "~/x" }, time: { start: 20, end: 30 } } },
    { type: "tool", tool: "write", callID: "c1", state: { status: "completed", input: { filePath: "/tmp/a.txt" }, time: { start: 10, end: 11 } } },
  ] }], "/proj", home);
  assert.deepEqual(calls.map((c) => [c.callId, c.command, c.cwd]), [["c1", null, "/proj"], ["c2", "ls", "/home/u/x"]]);
});

// --- #10 / #21 outside folders and files ------------------------------------------------------

function tracker(root, temp, extra = {}) {
  const reported = [];
  const t = new outside.OutsideTracker({
    root,
    sessionStartMs: Date.now() - 1_000,
    privacy: extra.privacy ?? privacy.currentPrivacy(),
    scrub: SCRUB,
    exclusion: (abs) => (uploader.isUploadPathDenied(abs.replace(/^\/+/, "")) ? "credential" : null),
    reportPath: (abs) => reported.push(abs),
    tempRoots: [temp],
    ...extra,
  });
  return { t, reported };
}

const shellCall = (callId, command, cwd, start) => ({ callId, tool: "bash", input: { command }, status: "completed", start, end: start + 1, command, cwd });

test("#10 outside folders: a created folder is reported whole (minus regenerable dirs), with the session cap; executed scripts are inlined, scrubbed", async () => {
  const root = tmp("proj10");
  const base = tmp("outside10");
  const temp = tmp("temp10");
  const app = path.join(base, "demo");
  write(app, { "package.json": "{}", "src/index.js": "console.log(1)\n", "node_modules/left-pad/index.js": "x", ".git/HEAD": "ref", "big.bin": Buffer.alloc(2048), ".env": `TOKEN=${GH_TOKEN}\n` });
  const script = write(base, { "deploy.sh": `#!/bin/sh\nexport AWS_SECRET_ACCESS_KEY=${AWS_SECRET}\necho deploying\n` });
  const { t, reported } = tracker(root, temp, { maxFolderBytes: 1024 });
  const result = await t.processCalls([shellCall("call-1", `mkdir -p ${app} && cd ${app} && npm init -y && sh ${path.join(base, "deploy.sh")}`, root, 1)]);
  assert.equal(result.folders.length, 1);
  const folder = result.folders[0];
  assert.equal(folder.reason, "created");
  assert.equal(folder.via, "mkdir");
  assert.equal(folder.tool_call_id, "call-1");
  assert.equal(folder.truncated, true, "the 2 KiB file does not fit the 1 KiB cap");
  assert.deepEqual(reported.filter((p) => p.startsWith(app)).map((p) => path.relative(app, p)).sort(), ["package.json", "src/index.js"]);
  assert.ok(folder.excluded_regenerable >= 2, "node_modules and .git are left out");
  const executed = result.files.find((file) => file.kind === "executed");
  assert.ok(executed && executed.content.includes("echo deploying"));
  assertNoSecrets(result);
  assert.ok(reported.includes(path.join(base, "deploy.sh")));
  // A later turn adds a file: only the new one is reported.
  write(app, { "src/extra.js": "1\n" });
  const again = await t.processCalls([shellCall("call-2", `cd ${app} && ls`, root, 5)]);
  assert.deepEqual(again.folders.map((f) => f.files), [3]);
  // The project itself, the home directory and a file system root are never expanded.
  const safe = await tracker(root, temp).t.processCalls([shellCall("c", `cd ${os.homedir()} && cd / && cd ${root}/sub`, root, 1)]);
  assert.deepEqual(safe.folders, []);
});

test("#10 an existing folder the agent worked in contributes only the files changed during the session", async () => {
  const root = tmp("proj10b");
  const other = write(tmp("other10"), { "old.txt": "old\n" });
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(other, "old.txt"), past, past);
  const { t, reported } = tracker(root, tmp("temp10b"), { sessionStartMs: Date.now() - 100 });
  write(other, { "new.txt": "new\n" });
  const result = await t.processCalls([shellCall("c1", `cd ${other} && echo new > new.txt`, root, 1)]);
  assert.equal(result.folders[0].reason, "modified");
  assert.deepEqual(reported.map((p) => path.basename(p)), ["new.txt"]);
});

test("#21 temp files: written by one call and read or run by a later one are inlined (scrubbed); a temp file never reused is not", async () => {
  const root = tmp("proj21");
  const temp = tmp("temp21");
  const script = path.join(temp, "probe.py");
  const unused = path.join(temp, "scratch.txt");
  const { t } = tracker(root, temp);
  fs.writeFileSync(script, `import os\nAPI_KEY = "${GH_TOKEN}"\nprint(os.getcwd())\n`);
  fs.writeFileSync(unused, "never read\n");
  const first = await t.processCalls([
    { callId: "w1", tool: "write", input: { filePath: script }, status: "completed", start: 1, end: 2, command: null, cwd: root },
    shellCall("w2", `echo hi > ${unused}`, root, 3),
  ]);
  assert.deepEqual(first.files, [], "writing alone records nothing");
  const second = await t.processCalls([shellCall("r1", `python3 ${script}`, root, 10)]);
  assert.equal(second.files.length, 1);
  const file = second.files[0];
  assert.equal(file.kind, "temp");
  assert.equal(file.written_by, "w1");
  assert.equal(file.tool_call_id, "r1");
  assert.ok(file.content.includes("print(os.getcwd())"));
  assertNoSecrets(second);
  const third = await t.processCalls([{ callId: "r2", tool: "read", input: { filePath: unused }, status: "completed", start: 20, end: 21, command: null, cwd: root }]);
  assert.equal(third.files.length, 1, "a read of an earlier-written temp file counts");
  const repeat = await t.processCalls([shellCall("r3", `cat ${unused}`, root, 30)]);
  assert.equal(repeat.files.length, 0, "the same content is recorded once");
  assert.equal(outside.isTempPath("/private/var/folders/ab/cdefg/T/x.py", []), true);
});

// --- #22 ephemeral tools --------------------------------------------------------------------------

test("#22 on-the-fly tools: exact versions, cache lookups per runner, registry fallback only without a cache hit", async () => {
  const home = tmp("eph");
  write(home, {
    ".npm/_npx/1a2b/node_modules/cowsay/package.json": JSON.stringify({ name: "cowsay", version: "1.6.0" }),
    ".npm/_npx/3c4d/node_modules/@scope/tool/package.json": JSON.stringify({ name: "@scope/tool", version: "2.3.4" }),
    ".bun/install/cache/prettier@3.3.3@@@1/package.json": "{}",
    ".cache/uv/archive-v0/xyz/lib/python3.12/site-packages/ruff-0.6.9.dist-info/METADATA": "",
    ".local/share/pipx/.cache/abc/lib/python3.11/site-packages/black-24.8.0.dist-info/METADATA": "",
    "go/pkg/mod/cache/download/golang.org/x/tools/@v/v0.24.0.info": "{}",
    ".cache/pnpm/dlx/hash1/1700000000/node_modules/create-next-app/package.json": JSON.stringify({ version: "14.2.5" }),
    ".cache/deno/npm/registry.npmjs.org/chalk/5.3.0/package.json": "{}",
  });
  const opts = { home, platform: "linux", env: {}, registryFallback: false };
  const r = (runner, pkg, requested = null) => ephemeral.resolveEphemeral({ tool_call_id: "c", runner, package: pkg, requested }, opts);
  assert.deepEqual(await r("npx", "cowsay", "1.6.0"), { tool_call_id: "c", runner: "npx", package: "cowsay", requested: "1.6.0", version: "1.6.0", resolved: "exact", source: null });
  assert.equal((await r("npx", "cowsay")).source, "npx_cache");
  assert.equal((await r("npx", "@scope/tool", "latest")).version, "2.3.4");
  assert.deepEqual([(await r("bunx", "prettier")).version, (await r("bunx", "prettier")).source], ["3.3.3", "bun_cache"]);
  assert.deepEqual([(await r("uvx", "ruff")).version, (await r("uvx", "ruff")).source], ["0.6.9", "uv_cache"]);
  assert.deepEqual([(await r("pipx run", "black")).version, (await r("pipx run", "black")).source], ["24.8.0", "pipx_venv"]);
  assert.deepEqual([(await r("go run", "golang.org/x/tools/cmd/stringer", "latest")).version, (await r("go run", "golang.org/x/tools/cmd/stringer", "latest")).source], ["v0.24.0", "go_modcache"]);
  assert.equal((await r("pnpm dlx", "create-next-app")).version, "14.2.5");
  assert.equal((await r("deno run", "chalk")).version, "5.3.0");
  assert.equal((await r("uvx", "not-cached")).resolved, "unresolved");
  const calls = [];
  const viaRegistry = await ephemeral.resolveEphemeral({ tool_call_id: "c", runner: "npx", package: "left-pad", requested: null }, {
    home, platform: "linux", env: {}, resolve: () => "/usr/bin/npm", run: fakeRun({ npm: ok("1.3.0\n") }, calls),
  });
  assert.deepEqual([viaRegistry.version, viaRegistry.resolved, viaRegistry.source], ["1.3.0", "registry_latest", "registry"]);
  assert.deepEqual(calls[0].args, ["view", "left-pad", "version"]);
  const cached = await ephemeral.resolveEphemeral({ tool_call_id: "c", runner: "npx", package: "cowsay", requested: null }, { home, platform: "linux", env: {}, run: () => assert.fail("no registry call on a cache hit") });
  assert.equal(cached.resolved, "cache");
  assert.equal((await ephemeral.resolveEphemeral({ tool_call_id: "c", runner: "npx", package: "bad name; rm -rf /", requested: null }, { home, run: () => assert.fail("never") })).resolved, "unresolved");
});

// --- #20 network -------------------------------------------------------------------------------

test("#20 parsing: tool shells, lsof connections, hostnames in a command (credentials never kept)", () => {
  assert.equal(network.shellCommandOf(["/bin/bash", "-c", "curl https://x.dev"]), "curl https://x.dev");
  assert.equal(network.shellCommandOf(["/usr/bin/zsh", "-lc", "ls"]), "ls");
  assert.equal(network.shellCommandOf(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "dir"]), "dir");
  assert.equal(network.shellCommandOf(["node", "-c", "x"]), null);
  assert.deepEqual(network.splitArgs("/bin/bash -c curl -s 'https://a.dev' | jq ."), ["/bin/bash", "-c", "curl -s 'https://a.dev' | jq ."]);
  assert.deepEqual(network.parseLsofConnections("p12\nn10.0.0.2:50000->140.82.112.3:443\nn*:3000\n"), [{ pid: 12, ip: "140.82.112.3", port: 443 }]);
  assert.deepEqual(network.hostnamesInCommand(`curl -H "Authorization: Bearer ${GH_TOKEN}" https://user:${PASSWORD}@api.github.com/repos && git clone git@gitlab.com:acme/x.git && cat main.py && ping example.org`), ["api.github.com", "gitlab.com", "example.org"]);
});

test("#20 attribution: a tool shell's connections go to the call that ran its command; unmatched shells to the turn; no IPs, no secrets", async () => {
  const resolver = { lookup: async (host) => (host === "api.github.com" ? ["140.82.112.3"] : []), reverse: async (ip) => (ip === "151.101.1.69" ? ["dualstack.n.sni.global.fastly.net"] : []) };
  const now = Date.now();
  const command = `curl -H "Authorization: Bearer ${GH_TOKEN}" https://api.github.com/user`;
  const roots = [
    { pid: 10, command, firstSeen: now, connections: new Map([["140.82.112.3|443", { ip: "140.82.112.3", port: 443, first: now }], ["127.0.0.1|5432", { ip: "127.0.0.1", port: 5432, first: now }]]) },
    { pid: 11, command: "some-daemon", firstSeen: now, connections: new Map([["151.101.1.69|443", { ip: "151.101.1.69", port: 443, first: now }]]) },
  ];
  const calls = [shellCall("call-net", command, "/proj", now - 100)];
  const events = await network.attributeConnections(roots, calls, { turn: 2, method: "proc", pollMs: 250, resolver });
  assert.equal(events.length, 2);
  const call = events.find((e) => e.scope === "call");
  assert.equal(call.tool_call_id, "call-net");
  assert.deepEqual(call.connections.map((c) => [c.host, c.port, c.address_class, c.resolved_by]), [["api.github.com", 443, "public", "command"], ["localhost", 5432, "loopback", "loopback"]]);
  const turn = events.find((e) => e.scope === "turn");
  assert.equal(turn.tool_call_id, null);
  assert.deepEqual(turn.connections.map((c) => [c.host, c.resolved_by]), [["dualstack.n.sni.global.fastly.net", "reverse"]]);
  const scrubbed = SCRUB.json(events);
  assertNoSecrets(scrubbed);
  assert.ok(!JSON.stringify(scrubbed).includes("140.82.112.3"));
});

test.skipIf(process.platform !== "linux")("#20 live (Linux /proc): a bash call that connects to a local server is seen and attributed to its call", async () => {
  const server = net.createServer((socket) => setTimeout(() => socket.end(), 1_500)).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const command = `node -e "const s=require('net').connect(${port},'127.0.0.1');s.on('data',()=>{});s.on('close',()=>process.exit(0))"`;
  const observer = new network.NetworkObserver({ sampler: network.linuxSampler("/proc", 100) });
  observer.start();
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 150)); // the turn's first sample notes what already runs
  const child = spawn("/bin/bash", ["-c", command], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  const roots = await observer.stop();
  server.close();
  const events = await network.attributeConnections(roots, [shellCall("call-live", command, "/proj", started)], { turn: 1, method: "proc", pollMs: 100 });
  const event = events.find((e) => e.tool_call_id === "call-live");
  assert.ok(event, `attributed: ${JSON.stringify(events)}`);
  assert.deepEqual(event.connections.map((c) => [c.host, c.port, c.address_class]), [["localhost", port, "loopback"]]);
  assert.ok(observer.samples >= 1);
});

// --- the uploader end to end ----------------------------------------------------------------------

function traceEventsOf(envelopes) {
  const out = [];
  for (const envelope of envelopes) {
    // Schema 2 carries the events in __omnirush__/trace.json (and mirrors them in `trace`).
    const file = (envelope.files ?? []).find((entry) => entry.path === "__omnirush__/trace.json");
    out.push(...(file ? JSON.parse(file.content).events ?? [] : envelope.trace ?? []));
  }
  return out;
}

async function runSession(contextOptions) {
  const root = write(tmp("e2e"), { "package.json": "{}", "src/a.js": "1\n" });
  const stateDir = tmp("e2e-state");
  const envelopes = [];
  const touched = [];
  const syncer = new uploader.SessionUploader({
    stateDir,
    fallbackScanMs: 60_000,
    capabilities: async () => ({ schema_versions: [2], canonical_trace: false }),
    upload: async (_sessionId, compressed) => {
      envelopes.push(JSON.parse(zlib.zstdDecompressSync(Buffer.from(compressed)).toString("utf8")));
      return new Response("{}", { status: 201 });
    },
    onPathTouched: (_sessionId, p) => touched.push(p),
    context: { sections: { system_packages: false, services: false, pm_config: false }, sampler: null, ephemeral: { registryFallback: false }, env: {}, ...contextOptions },
  });
  const sessionId = "01a0dcd2-d8ee-7222-80eb-240063770431";
  syncer.startSession(sessionId, "ws", root);
  syncer.captureSnapshot(sessionId, "prompt");
  syncer.recordTrace(sessionId, "turn.messages", { messages: [{ info: { role: "assistant" }, parts: [
    { type: "tool", tool: "bash", callID: "call-e2e", state: { status: "completed", input: { command: `npx -y cowsay@1.6.0 "token ${GH_TOKEN}"` }, time: { start: Date.now(), end: Date.now() + 1 } } },
  ] }] });
  syncer.captureSnapshot(sessionId, "turn_completed");
  // A loaded machine may take longer than the 1 s the session end waits for context.
  await syncer.context?.settled(sessionId, 30_000);
  syncer.finishSession(sessionId);
  await syncer.idle(sessionId);
  await syncer.stop();
  return { events: traceEventsOf(envelopes), envelopes, touched };
}

test.skipIf(!hasZstd)("uploader: the session's trace carries the context events, scrubbed; OMNIRUSH_CAPTURE_CONTEXT=0 sends none", async () => {
  const { events } = await runSession({});
  const types = events.map((event) => event.type).filter((type) => type.startsWith("context."));
  assert.ok(types.includes("context.environment"), types.join(","));
  assert.equal(types.filter((type) => type === "context.processes").length, 2, "session start and turn start");
  assert.ok(types.includes("context.ephemeral_tool"));
  const environment = events.find((event) => event.type === "context.environment").data;
  assert.equal(environment.schema, 1);
  assert.equal(environment.setup.client, "gui");
  assert.ok("shell_aliases" in environment && !("system_packages" in environment));
  const tool = events.find((event) => event.type === "context.ephemeral_tool").data;
  assert.deepEqual([tool.tool_call_id, tool.package, tool.version, tool.resolved], ["call-e2e", "cowsay", "1.6.0", "exact"]);
  assertNoSecrets(events);
  assert.ok(!JSON.stringify(events.filter((e) => e.type.startsWith("context."))).includes(os.homedir() + path.sep), "no home path in context events");

  const off = await runSession({ env: { OMNIRUSH_CAPTURE_CONTEXT: "0" } });
  assert.deepEqual(off.events.filter((event) => event.type.startsWith("context.")), []);
  assert.ok(off.events.length > 0, "the rest of the trace is unchanged");
});

test("CLI/desktop parity: the context modules match PARITY.sha256 (the same list ships in the CLI)", async () => {
  const { createHash } = await import("node:crypto");
  const contextDir = path.join(import.meta.dir, "context");
  const lines = fs.readFileSync(path.join(contextDir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  const listed = new Map(lines.map((line) => { const [hash, name] = line.split(/\s+/); return [name, hash]; }));
  const files = fs.readdirSync(contextDir).filter((name) => name.endsWith(".ts") || name.endsWith(".json")).sort();
  assert.deepEqual([...listed.keys()].sort(), files);
  for (const name of files) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(contextDir, name))).digest("hex"), listed.get(name), `${name} changed: port it to the CLI and update PARITY.sha256 in both`);
});

// --- review fixes: settings folders, secret stores, credential files -----------------------

test("credential files are never captured outside the project, wherever they are", async () => {
  for (const file of [
    "/h/Library/Application Support/Google/Chrome/Default/Cookies", "/h/.config/google-chrome/Default/Login Data", "/x/Web Data", "/x/Local State",
    "/h/.mozilla/firefox/p.default/key4.db", "/x/logins.json", "/x/cookies.sqlite", "/h/Library/Keychains/login.keychain-db", "/h/.config/gh/hosts.yml",
    "/h/.netrc", "/h/.pgpass", "/h/.npmrc", "/h/.pypirc", "/h/.aws/credentials", "/x/credentials.json", "/x/server.pem", "/x/tls.key", "/h/.ssh/id_ed25519",
    "/h/.docker/config.json", "/h/.kube/config", "/x/dev.kubeconfig", "/h/.git-credentials", "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies",
  ]) assert.equal(privacy.isSecretFile(file), true, file);
  for (const file of ["/x/index.js", "/x/config.json", "/x/README.md", "/x/keys.ts", "/x/hosts.yml", "/x/kube/deploy.yaml"]) assert.equal(privacy.isSecretFile(file), false, file);
  const archiveOutside = await import("./session-archive/outside.js");
  for (const file of ["/srv/app/Cookies", "/srv/app/.npmrc", "/srv/app/id_rsa", "/srv/app/cert.pem", "/srv/gh/hosts.yml"]) {
    assert.equal(archiveOutside.outsideExclusion(file, { appDirs: [], home: "/h", includeCredentialFiles: true }), "credential", file);
  }
});

test("a folder the agent only worked in is refused when it is a settings folder, a secret store or another account's repository", async () => {
  const home = tmp("home-refuse");
  const root = tmp("proj-refuse");
  const later = { "fresh.txt": "changed this session\n" };
  const dirs = {
    chrome: write(path.join(home, "Library/Application Support/Google/Chrome/Default"), { Cookies: "c", "Login Data": "l", "Preferences": "{}" }),
    config: write(path.join(home, ".config/gh"), { "hosts.yml": `oauth_token: ${GH_TOKEN}\n`, "config.yml": "git_protocol: ssh\n" }),
    local: write(path.join(home, ".local/share/app"), later),
    appdata: write(path.join(home, "AppData/Roaming/Code/User"), later),
    snap: write(path.join(home, "snap/firefox/common"), later),
    pass: write(path.join(tmp("pm"), "Bitwarden"), later),
  };
  const { t, reported } = tracker(root, tmp("temp-refuse"), { privacy: { home, user: null }, sessionStartMs: Date.now() - 60_000 });
  const calls = Object.values(dirs).map((dir, i) => shellCall(`c${i}`, `cd ${JSON.stringify(dir)} && ls`, root, i));
  calls.push({ callId: "w", tool: "bash", input: { command: "ls" }, status: "completed", start: 9, end: 10, command: "ls", cwd: path.join(home, ".config") });
  const result = await t.processCalls(calls);
  assert.deepEqual(result.folders, []);
  assert.deepEqual(reported, []);
  for (const dir of Object.values(dirs)) assert.ok((await t.refusedWorkFolder(dir)) !== null, dir);
  // Another account's git work tree, even outside home.
  const foreign = write(tmp("foreign"), { ".git/HEAD": "ref: refs/heads/main\n", "src/a.js": "1\n" });
  const other = tracker(root, tmp("temp-foreign"), { uid: (process.getuid?.() ?? 0) + 1, sessionStartMs: Date.now() - 60_000 });
  assert.equal(await other.t.refusedWorkFolder(path.join(foreign, "src")), "foreign_git");
  const foreignResult = await other.t.processCalls([shellCall("f", `cd ${foreign}/src && ls`, root, 1)]);
  assert.deepEqual(foreignResult.folders, []);
  assert.deepEqual(other.reported, []);
  // The same repository is fine for its owner.
  const own = tracker(root, tmp("temp-own"), { sessionStartMs: Date.now() - 60_000 });
  assert.equal(await own.t.refusedWorkFolder(path.join(foreign, "src")), null);
});

test("a folder the agent created stays allowed, even under ~/.config, minus credential files and secret stores", async () => {
  const home = tmp("home-created");
  const root = tmp("proj-created");
  const made = path.join(home, ".config", "newtool");
  const { t, reported } = tracker(root, tmp("temp-created"), { privacy: { home, user: null } });
  write(made, {
    "settings.json": "{}", "src/main.js": "1\n", Cookies: "c", "Login Data": "l", ".npmrc": `//r/:_authToken=${NPM_TOKEN}\n`, "id_rsa": "k", "tls.key": "k", "cert.pem": "p",
    ".docker/config.json": "{}", "gh/hosts.yml": "x", "credentials.json": "{}", "Chrome/Default/Preferences": "{}", "1Password/data.sqlite": "x",
  });
  const result = await t.processCalls([shellCall("mk", `mkdir -p ${made} && cd ${made} && echo ok`, root, 1)]);
  assert.equal(result.folders.length, 1);
  assert.equal(result.folders[0].reason, "created");
  assert.deepEqual(reported.map((p) => path.relative(made, p)).sort(), ["settings.json", "src/main.js"]);
});

test("Windows: a timed-out command's whole process tree is ended (taskkill /T /F)", () => {
  assert.deepEqual(exec.windowsTreeKillArgs(4242), ["/PID", "4242", "/T", "/F"]);
});

// --- release e2e fixes: process privacy, docker, network per call, final messages ---------

test("#19 privacy: only the session's process tree and processes in its folders are named; other ports are port + base name", async () => {
  const project = tmp("proc-proj");
  const table = [
    { pid: 100, ppid: 1, name: "node", command: "node /usr/lib/omnirush/bin.js" },
    { pid: 101, ppid: 100, name: "opencode", command: "opencode serve --port 4096" },
    { pid: 102, ppid: 101, name: "bash", command: `bash -c npm test --token=${GH_TOKEN}` },
    { pid: 103, ppid: 102, name: "node", command: "node server.js" },
    { pid: 200, ppid: 1, name: "python3", command: "python3 /home/other/telegram-bot/bot.py --api-key=xyz" },
    { pid: 201, ppid: 1, name: "node", command: "node /opt/bootstrapper/agent.js" },
    { pid: 202, ppid: 1, name: "vite", command: "/usr/bin/node vite --port 5173" },
  ];
  const listening = [
    { proto: "tcp", address: "127.0.0.1", port: 3000, pid: 103, process: "node" },
    { proto: "tcp", address: "0.0.0.0", port: 8443, pid: 200, process: "/home/other/telegram-bot/venv/bin/python3" },
    { proto: "tcp", address: "127.0.0.1", port: 5173, pid: 202, process: "vite" },
  ];
  const snapshot = await processes.processSnapshot("turn_start", 1, {
    privacy: { home: "/home/me", user: "me" },
    scrub: SCRUB,
    selfPid: 100,
    precomputed: { processes: table, listening },
    scope: { rootPid: 100, folders: () => [project] },
    cwdOf: async (pids) => new Map(pids.map((pid) => [pid, pid === 202 ? path.join(project, "web") : "/home/other/telegram-bot"])),
  });
  assert.deepEqual(snapshot.processes.map((p) => [p.pid, p.scope]), [[102, "session"], [103, "session"], [202, "folder"]]);
  assert.ok(snapshot.processes.find((p) => p.pid === 102).command.includes("--token=[REDACTED]"));
  assert.deepEqual(snapshot.listening, [
    { proto: "tcp", address: "loopback", port: 3000, pid: 103, process: "node" },
    { proto: "tcp", port: 8443, process: "python3" },
    { proto: "tcp", address: "loopback", port: 5173, pid: 202, process: "vite" },
  ]);
  assert.equal(snapshot.total_processes, table.length);
  const text = JSON.stringify(snapshot);
  for (const leaked of ["telegram", "bootstrapper", "/home/other", "xyz", "opencode serve"]) assert.ok(!text.includes(leaked), leaked);
});

test.skipIf(process.platform !== "linux")("#19 privacy, live (Linux): the snapshot lists this process's children, never another account's or an unrelated process", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)", "--", "child-marker"], { stdio: "ignore" });
  const outsider = spawn("/bin/sh", ["-c", "exec sleep 20"], { stdio: "ignore", detached: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = await processes.processSnapshot("turn_start", 1, { privacy: privacy.currentPrivacy(), scrub: SCRUB, scope: { rootPid: process.pid, folders: () => [] } });
    assert.ok(snapshot.processes.some((p) => p.pid === child.pid && p.command.includes("child-marker")));
    const pids = new Set(snapshot.processes.map((p) => p.pid));
    const all = await processes.linuxProcesses();
    const tree = processes.descendantsOf(process.pid, all);
    for (const pid of pids) assert.ok(tree.has(pid), `pid ${pid} is in the session tree`);
  } finally {
    child.kill();
    outsider.kill();
  }
});

test("#20 a shell call's start makes the observer sample every 50 ms", async () => {
  const times = [];
  const sampler = { method: "fake", pollMs: 1_000, tree: async () => { times.push(Date.now()); return []; }, connections: async () => [] };
  const observer = new network.NetworkObserver({ sampler });
  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = times.length;
  observer.boost(600);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await observer.stop();
  assert.ok(times.length - before >= 6, `samples while boosted: ${times.length - before}`);
});

test("#20 attribution: a shell fed its command on stdin goes to the one call running; a socket-table root to its call", async () => {
  const now = Date.now();
  const resolver = { lookup: async (host) => (host === "example.com" ? ["93.184.215.14"] : []), reverse: async () => [] };
  const calls = [
    { callId: "c-curl", tool: "bash", input: {}, status: "completed", start: now, end: now + 300, command: "curl -s https://example.com -o /dev/null", cwd: "/p" },
    { callId: "c-npx", tool: "bash", input: {}, status: "completed", start: now + 1_000, end: now + 4_000, command: "npx -y cowsay@1.6.0 hi", cwd: "/p" },
  ];
  const roots = [
    { pid: 5, command: "/bin/bash", bareShell: true, firstSeen: now + 50, connections: new Map([["93.184.215.14|443", { ip: "93.184.215.14", port: 443, first: now + 50 }]]) },
    { pid: -1, command: "x", firstSeen: now + 1_200, callId: "c-npx", connections: new Map([["104.16.0.1|443", { ip: "104.16.0.1", port: 443, first: now + 1_200 }]]) },
  ];
  const events = await network.attributeConnections(roots, calls, { turn: 1, method: "proc", pollMs: 250, resolver });
  assert.deepEqual(events.map((e) => [e.tool_call_id, e.scope]).sort(), [["c-curl", "call"], ["c-npx", "call"]]);
  assert.equal(events.find((e) => e.tool_call_id === "c-curl").connections[0].host, "example.com");
  // The socket-table diff keeps only peers of hosts the command names.
  const before = new Map([["a", { ip: "1.1.1.1", port: 443 }]]);
  const after = new Map([["a", { ip: "1.1.1.1", port: 443 }], ["b", { ip: "93.184.215.14", port: 443 }], ["c", { ip: "8.8.8.8", port: 443 }]]);
  const diff = await network.socketDiffConnections(before, after, "curl https://example.com", now, resolver);
  assert.deepEqual([...diff.keys()], ["93.184.215.14|443"]);
});

test("#20 opencode tool events: message.part.updated running and completed (and v2) are parsed", async () => {
  const toolEvents = await import("./context/tool-events.js");
  const part = (status) => ({ type: "message.part.updated", properties: { part: { type: "tool", tool: "bash", callID: "call_1", sessionID: "ses_1", state: { status, input: { command: "curl https://example.com", workdir: "/w" }, time: { start: 10, end: 20 } } } } });
  assert.deepEqual(toolEvents.toolEventOf(part("running")), { sessionId: "ses_1", event: { callId: "call_1", tool: "bash", status: "running", command: "curl https://example.com", workdir: "/w", at: 10 } });
  assert.equal(toolEvents.toolEventOf(part("completed")).event.status, "completed");
  assert.equal(toolEvents.toolEventOf({ payload: part("pending") }).event.status, "running");
  assert.equal(toolEvents.toolEventOf({ type: "message.part.updated", properties: { part: { type: "text" } } }), null);
  assert.deepEqual(toolEvents.toolEventOf({ type: "session.tool.called", data: { sessionID: "s", callID: "c", tool: "bash", input: { command: "ls" } } }), { sessionId: "s", event: { callId: "c", tool: "bash", status: "running", command: "ls", workdir: null } });
});

test("#20 the turn's network waits for its last messages: a call known only from the final flush still gets its tool_call_id", async () => {
  const self = process.pid;
  let live = false;
  const sampler = {
    method: "fake",
    pollMs: 1_000,
    tree: async () => (live ? [{ pid: 999_001, ppid: self, argv: ["/bin/bash"] }] : []),
    connections: async (pids) => (pids.includes(999_001) ? [{ pid: 999_001, ip: "93.184.215.14", port: 443 }] : []),
  };
  const resolver = { lookup: async (host) => (host === "example.com" ? ["93.184.215.14"] : []), reverse: async () => [] };
  const recorded = [];
  const capture = new context.ContextCapture({
    client: "cli", scrub: SCRUB, record: (_id, type, data) => recorded.push({ type, data }), env: {}, sampler, resolver, platform: "darwin",
    sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false },
    ephemeral: { registryFallback: false },
  });
  const sid = "ses-final-msgs";
  capture.sessionStarted(sid, tmp("final"));
  capture.turnStarted(sid);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const command = "curl -s https://example.com -o /dev/null";
  const start = Date.now();
  capture.toolEvent(sid, { callId: "call-curl", tool: "bash", status: "running", command });
  live = true;
  await new Promise((resolve) => setTimeout(resolve, 150));
  live = false;
  capture.toolEvent(sid, { callId: "call-curl", tool: "bash", status: "completed" });
  // The milestone comes before the uploader flushes the turn's last messages.
  capture.turnEnded(sid);
  await new Promise((resolve) => setTimeout(resolve, 50));
  capture.turnMessages(sid, [{ info: { role: "assistant" }, parts: [
    { type: "tool", tool: "bash", callID: "call-curl", state: { status: "completed", input: { command }, time: { start, end: Date.now() } } },
    { type: "tool", tool: "bash", callID: "call-npx", state: { status: "completed", input: { command: "npx -y cowsay@1.6.0 hi" }, time: { start: Date.now() + 1_000, end: Date.now() + 2_000 } } },
  ] }], true);
  await capture.settled(sid, 10_000);
  const net = recorded.filter((e) => e.type === "context.network").map((e) => e.data);
  assert.deepEqual(net.map((e) => [e.tool_call_id, e.scope, e.connections[0]?.host]), [["call-curl", "call", "example.com"]]);
  const tools = recorded.filter((e) => e.type === "context.ephemeral_tool").map((e) => e.data);
  assert.deepEqual(tools.map((t) => [t.tool_call_id, t.package, t.version]), [["call-npx", "cowsay", "1.6.0"]]);
});

test.skipIf(process.platform !== "linux")("#20 live (Linux): a curl-short connection (~20 ms) is tied to its call by the tool-start boost and the socket-table diff", async () => {
  // The client closes first (as curl does after a response): its socket lingers in TIME_WAIT.
  const server = net.createServer((socket) => socket.on("end", () => socket.end())).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const recorded = [];
  const capture = new context.ContextCapture({
    client: "cli", scrub: SCRUB, record: (_id, type, data) => recorded.push({ type, data }), env: {}, platform: "linux",
    sections: { system_packages: false, services: false, setup: false, pm_config: false, shell_aliases: false, processes: false },
    ephemeral: { registryFallback: false },
  });
  const sid = "ses-live-short";
  capture.sessionStarted(sid, tmp("live-short"));
  capture.turnStarted(sid);
  const command = `node -e "const s=require('net').connect(${port},'127.0.0.1',()=>s.end());s.on('close',()=>process.exit(0))"`;
  const start = Date.now();
  capture.toolEvent(sid, { callId: "call-short", tool: "bash", status: "running", command });
  await new Promise((resolve) => spawn("/bin/bash", ["-c", command], { stdio: "ignore" }).on("exit", resolve));
  capture.toolEvent(sid, { callId: "call-short", tool: "bash", status: "completed" });
  capture.turnEnded(sid);
  capture.turnMessages(sid, [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "call-short", state: { status: "completed", input: { command }, time: { start, end: Date.now() } } }] }], true);
  await capture.settled(sid, 10_000);
  server.close();
  const event = recorded.find((e) => e.type === "context.network" && e.data.tool_call_id === "call-short");
  assert.ok(event, JSON.stringify(recorded.filter((e) => e.type === "context.network")));
  assert.ok(event.data.connections.some((c) => c.port === port && c.address_class === "loopback"));
});

test.skipIf(!hasZstd)("uploader: the turn's last messages (the final flush, not turn.messages) feed the ephemeral tools", async () => {
  const root = write(tmp("final-flush"), { "package.json": "{}" });
  const envelopes = [];
  const syncer = new uploader.SessionUploader({
    stateDir: tmp("final-flush-state"),
    fallbackScanMs: 60_000,
    capabilities: async () => ({ schema_versions: [2], canonical_trace: false }),
    upload: async (_sessionId, compressed) => {
      envelopes.push(JSON.parse(zlib.zstdDecompressSync(Buffer.from(compressed)).toString("utf8")));
      return new Response("{}", { status: 201 });
    },
    context: { sections: { system_packages: false, services: false, pm_config: false, setup: false, shell_aliases: false }, sampler: null, ephemeral: { registryFallback: false }, env: {} },
  });
  const sessionId = "01a0dcd2-d8ee-7222-80eb-240063770432";
  syncer.startSession(sessionId, "ws", root);
  syncer.captureSnapshot(sessionId, "prompt");
  syncer.captureSnapshot(sessionId, "turn_completed");
  syncer.flushTrace(sessionId, { messages: [{ info: { role: "assistant" }, parts: [
    { type: "tool", tool: "bash", callID: "call-cow", state: { status: "completed", input: { command: "npx -y cowsay@1.6.0 hi" }, time: { start: Date.now(), end: Date.now() } } },
  ] }] });
  await syncer.context?.settled(sessionId, 30_000);
  syncer.finishSession(sessionId);
  await syncer.idle(sessionId);
  await syncer.stop();
  const tools = traceEventsOf(envelopes).filter((e) => e.type === "context.ephemeral_tool").map((e) => e.data);
  assert.deepEqual(tools.map((t) => [t.tool_call_id, t.package, t.version, t.resolved]), [["call-cow", "cowsay", "1.6.0", "exact"]]);
});
