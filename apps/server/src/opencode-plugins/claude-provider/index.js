// The "omnirush-claude" engine provider: each turn of a Claude chat runs real
// Claude Code (headless, stream-json) in the project's OmniRush box, and its
// events become the engine's parts (map.js). AI SDK LanguageModelV3, loaded by
// the 2.x engine as `aisdk:file://…/index.js` (the first `create*` export).
// Shared by omnirush-cli and omnirush-gui (PARITY.sha256).
//
// Settings (the provider's config options, nothing else is read from the app):
//   grantURL   the app's local route, POST JSON with header x-omnirush-usage-key: grantKey
//                {op:"grant", sessionID, model, resume, earlier, directory, prompt, refresh?}
//                  -> {ok:true, token, baseUrl, client} | {ok:false, message}
//                  (resume: Claude has a transcript of this chat; earlier: the engine
//                  history has replies; asked again every 60 s while a turn runs, refresh: true)
//                {op:"end", sessionID, uuid, ok} after a turn (the app uploads the transcript)
//   grantKey   that header's value
//   shell      boxsh (the engine's box shell); boxHome the box home (boxes/<key>.json,
//              projects/<key> = the box's /run/omnirush)
//   directory  the project folder (default: the engine's cwd); a request header
//              x-omnirush-directory names it instead (one desktop engine, many projects)
//   client     "cli/2.7.3" | "gui/3.8.0": X-OmniRush-Client to the relay
//   note       optional text shown once at a chat's start
//   runtime    "vm": a lane VM (Windows only for now): Claude Code's own Windows build runs on this machine, no box;
//              each turn needs the grant's `runtime: "vm"` (the server's lane list), else it is refused.
//              vmHome is its folder (<vmHome>/bin/<version>, <vmHome>/<key> = the run folder)
// The relay token lives in the box's run folder, read by Claude Code's
// apiKeyHelper; nothing else of this machine's env enters the box.
// Claude's session id is uuidv5(engine session id); its config folder is the
// box's /run/omnirush/claude/config (host: <boxHome>/projects/<key>/claude/config).
//
// Stop arrives as the stream's cancel() (the engine passes no abortSignal):
// an interrupt on Claude's stdin, then SIGINT, then SIGKILL.
//
// One Claude per chat: a title request is never a turn (the engine asks the chat's model for the title when the
// title model fails), and LAUNCH ends any earlier Claude of the same chat still running in the box (a launch boxsh
// runs again with `<runtime> exec` after boxd's connection failed, a stopped turn's leftover); the turn's first
// message is a file in the run folder, so a launch run again reads it too.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apiError, ClaudeStreamMapper, lastUserContent } from "./map.js";

export const CLAUDE_CODE_VERSION = "2.1.306";
// The pinned linux build (npm @anthropic-ai/claude-code-linux-<arch>): installed into the box on first use.
// shortcut: until the box image carries it (box-base 2026.11.x), each box downloads it once (131 MB).
export const CLAUDE_CODE_BUILDS = {
  x64: { url: `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz`, integrity: "sha512-4gsb0IQhxzi1NhoUETXkNZb1t6wJ9tnfAYBKmb0+NmsAwOG37Dacq7bLqsooEkusaT0PyQRFUMt0SgWxx9LEEA==" },
  arm64: { url: `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-${CLAUDE_CODE_VERSION}.tgz`, integrity: "sha512-AePKWuymgDSCh7nScJ4dx/pF1Kppzk4IwQuh6JCROiqQdBVGaaHw6jVf/fY5PhbSjy9EQML6yOiUfc50aFpnTA==" },
};
// The pinned Windows build (npm @anthropic-ai/claude-code-win32-x64) for a lane VM (`runtime: "vm"`).
// shortcut: x64 only, the lane's VMs are x64; add win32-arm64 when a lane runs on it.
export const CLAUDE_CODE_WIN_BUILDS = {
  x64: { url: `https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-${CLAUDE_CODE_VERSION}.tgz`, integrity: "sha512-MpqvdPxktYYaCzTp+Lcvjp5r2fnLWRWxSd7hwilVCUfAvJC6Zm/W+t7TCeEk1xGH++3BWL57FmHDN/w5k9AiiQ==" },
};
export const PROVIDER_ID = "omnirush-claude";
/** A lane-VM turn for an account the server did not put on the lane list. */
export const NOT_LANE = "Claude runs only in the OmniRush sandbox for this account: this machine's lane mode isn't enabled for it.";
/** A Claude turn where the sandbox isn't running (off, or it cannot run on this machine). */
export const NO_BOX = "Claude runs only in the OmniRush sandbox, and the sandbox isn't running for this project, so Claude can't start here.";
const BOX_RUN = "/run/omnirush";
const BOX_BIN = `/opt/omnirush/claude/${CLAUDE_CODE_VERSION}/claude`;
const STOP_GRACE_MS = 5_000;
const REFRESH_MS = 60_000;
// Claude's session id for an engine chat: uuid v5 of its id in this namespace.
const NAMESPACE = "6f1c2b8e-4d3a-5f60-9a7b-0c1d2e3f4a5b";

/** uuid v5 (sha1) of `name` in `namespace`. */
export function uuidv5(name, namespace = NAMESPACE) {
  const hash = createHash("sha1").update(Buffer.from(namespace.replace(/-/g, ""), "hex")).update(String(name)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The box key of a folder (the same as src/box/plugin-lib.js keyOf). */
export function boxKey(dir) {
  let resolved = path.resolve(dir);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* keep */ }
  if (process.platform === "win32") resolved = resolved.toLowerCase();
  return createHash("sha256").update(resolved).digest("hex").slice(0, 12);
}

/** The contract the relay token is bound to: this Claude Code, this provider, the box. */
export const CONTRACT = createHash("sha256").update(JSON.stringify({ claude_code: CLAUDE_CODE_VERSION, provider: 1, runtime: "box" })).digest("hex");
/** The same for a lane VM's turns (`runtime: "vm"`). */
export const VM_CONTRACT = createHash("sha256").update(JSON.stringify({ claude_code: CLAUDE_CODE_VERSION, provider: 1, runtime: "vm" })).digest("hex");

/** Whether Claude already has a transcript for `uuid` in the config folder (then the turn resumes it). */
export function hasTranscript(configDir, uuid) {
  try {
    return fs.readdirSync(path.join(configDir, "projects")).some((dir) => fs.existsSync(path.join(configDir, "projects", dir, `${uuid}.jsonl`)));
  } catch { return false; }
}

/** Claude Code's argv for a turn (LAUNCH adds --resume or --session-id in the box). */
export function claudeArgs({ model }) {
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", model, "--permission-mode", "bypassPermissions"];
}

/**
 * The turn's command in the box: sh -c LAUNCH <claude> <run folder> <uuid> <claudeArgs...>.
 * Ends any other Claude of this chat (with its process group, unless it is ours), resumes when
 * Claude has the chat's transcript, then gives Claude turn-<uuid>.jsonl and the provider's stdin after it.
 */
export const LAUNCH = [
  "bin=$0 run=$1 id=$2; shift 2",
  "me=$(cut -d' ' -f5 /proc/$$/stat 2>/dev/null)",
  'for c in $(grep -lsaF -- "$id" /proc/[0-9]*/cmdline); do',
  '  p=${c%/cmdline}; n=${p#/proc/}; [ "$n" = "$$" ] && continue',
  "  case \"$(tr '\\0' ' ' 2>/dev/null <\"$p/cmdline\")\" in",
  "    *\"$bin \"*\" $id \"*) g=$(cut -d' ' -f5 \"$p/stat\" 2>/dev/null); [ -n \"$g\" ] && [ \"$g\" != \"$me\" ] && kill -KILL -- \"-$g\" 2>/dev/null; kill -KILL \"$n\" 2>/dev/null;;",
  "  esac",
  "done",
  'if ls "$CLAUDE_CONFIG_DIR"/projects/*/"$id.jsonl" >/dev/null 2>&1; then set -- "$@" --resume "$id"; else set -- "$@" --session-id "$id"; fi',
  'f="$run/turn-$id.jsonl"; i=0; while [ ! -s "$f" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
  // The feeder ends with Claude: a Claude that exits early (an error) must not leave the turn waiting on stdin.
  't=$(mktemp /tmp/omnirush-feed.XXXXXX)',
  'sh -c \'echo $$ > "$1"; cat "$2"; exec cat\' feed "$t" "$f" | { "$bin" "$@"; c=$?; i=0; while [ ! -s "$t" ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done; kill "$(cat "$t")" 2>/dev/null; rm -f "$t"; exit $c; }',
].join("\n");

/**
 * The install log's folder for this chat's commands, as the app's box plugin gives the engine's own shell calls:
 * a desktop chat notes in the desktop's box folder (<boxHome>/desktop-projects.json `pkglog_dir`), a CLI chat in
 * the engine's (OMNIRUSH_PKGLOG_DIR). Null when the install log is off.
 */
export function installLogDir(boxHome, client, env = process.env) {
  if (boxHome && String(client).startsWith("gui/")) {
    try {
      const dir = JSON.parse(fs.readFileSync(path.join(boxHome, "desktop-projects.json"), "utf8"))?.pkglog_dir;
      if (typeof dir === "string" && dir) return dir;
    } catch { /* not listed */ }
  }
  return env.OMNIRUSH_PKGLOG_DIR || null;
}

/** The env Claude Code runs with in the box (passed by boxsh through OMNIRUSH_BOX_PASS_ENV). */
export function claudeEnv({ model, baseUrl, sessionID, client, pkglogDir = null, runtime = "box", configDir = null }) {
  const env = {
    CLAUDE_CONFIG_DIR: runtime === "vm" ? configDir : `${BOX_RUN}/claude/config`,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: `${runtime === "vm" ? "X-OmniRush-Runtime: vm" : "X-OmniRush-Box: 1"}\nX-OmniRush-Session-Id: ${sessionID}\nX-OmniRush-Client: ${client}`,
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(REFRESH_MS),
    // The relay serves the chat's model only: every model Claude Code would pick on its own is that one.
    ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    // The box (or the disposable lane VM) is the boundary that makes running without asks acceptable.
    IS_SANDBOX: "1",
    // The install log: Claude's commands (its sub-agents' too) note installs where the app reads this chat's, and
    // name the chat (the engine names no call of Claude's: the app matches them to the chat's turn).
    OMNIRUSH_SESSION: sessionID,
    ...(pkglogDir ? { OMNIRUSH_PKGLOG_DIR: pkglogDir } : {}),
  };
  return env;
}

/** This machine's env for a lane VM's Claude Code: the app's own variables (and any Anthropic credential) stay out. */
export function hostEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(OMNIRUSH_|OPENCODE_|ANTHROPIC_|CLAUDE_)/i.test(name)));
}

/** Claude Code's apiKeyHelper on a lane VM: node reads the token file (no `cat` outside Git Bash). */
export function hostKeyHelper(run, node = process.execPath) {
  const slash = (p) => p.split(path.sep).join("/");
  return `"${slash(node)}" "${slash(path.join(run, "token-helper.cjs"))}"`;
}

const lower = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const lineText = (content) => content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

function readRecord(home, key) {
  try { return JSON.parse(fs.readFileSync(path.join(home, "boxes", `${key}.json`), "utf8")); } catch { return null; }
}

/** One command in the box through boxsh; resolves its exit code. */
function inBox(shell, env, cwd, command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command, ...args], { cwd, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => resolve({ code: 127, err: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, err }));
  });
}

async function download(build, file) {
  const response = await fetch(build.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
  const tmp = `${file}.${process.pid}.tmp`;
  const hash = createHash("sha512");
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  try {
    for await (const chunk of response.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise((r) => out.once("drain", r)); }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (`sha512-${hash.digest("base64")}` !== build.integrity) throw new Error("the download did not match its pinned checksum");
    fs.renameSync(tmp, file);
  } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
}

const installs = new Map();
/** Claude Code at BOX_BIN in this box: probed, else the pinned build downloaded once per machine and unpacked in the box. */
function ensureClaude({ shell, env, cwd, home, run }) {
  const key = env.OMNIRUSH_BOX_KEY;
  if (!installs.has(key)) {
    installs.set(key, (async () => {
      if ((await inBox(shell, env, cwd, `test -x ${BOX_BIN}`)).code === 0) return;
      const build = CLAUDE_CODE_BUILDS[os.arch()] ?? CLAUDE_CODE_BUILDS.x64;
      const cache = path.join(home, "claude");
      fs.mkdirSync(cache, { recursive: true });
      const tgz = path.join(cache, path.basename(new URL(build.url).pathname));
      if (!fs.existsSync(tgz)) await download(build, tgz);
      const staged = path.join(run, "install.tgz");
      fs.rmSync(staged, { force: true });
      try { fs.linkSync(tgz, staged); } catch { fs.copyFileSync(tgz, staged); }
      try {
        const dir = path.posix.dirname(BOX_BIN);
        // The box user is root or has passwordless sudo (src/box BOX_NOTE).
        const done = await inBox(shell, env, cwd, `S=; [ "$(id -u)" = 0 ] || S="sudo -n"; $S mkdir -p ${dir} && $S tar -xzf ${BOX_RUN}/claude/install.tgz -C ${dir} --strip-components=1 --no-same-owner package/claude && $S chmod 755 ${BOX_BIN} && ${BOX_BIN} --version >/dev/null`);
        if (done.code !== 0) throw new Error(`Claude Code could not be installed in the sandbox (${done.err.trim().split("\n").at(-1) || done.code})`);
      } finally { fs.rmSync(staged, { force: true }); }
    })().catch((error) => { installs.delete(key); throw error; }));
  }
  return installs.get(key);
}

function exec(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => resolve({ code: 127, err: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, err }));
  });
}

/** The pinned Windows build under <vmHome>/bin/<version>: downloaded (sha512-checked) and unpacked once. */
function ensureHostClaude(vmHome) {
  const key = `vm:${vmHome}`;
  if (!installs.has(key)) {
    installs.set(key, (async () => {
      const dir = path.join(vmHome, "bin", CLAUDE_CODE_VERSION);
      const bin = path.join(dir, "claude.exe");
      if (fs.existsSync(bin)) return bin;
      const build = CLAUDE_CODE_WIN_BUILDS[os.arch()];
      if (!build) throw new Error(`Claude Code's lane build isn't pinned for ${os.arch()}`);
      fs.mkdirSync(dir, { recursive: true });
      const tgz = path.join(vmHome, "bin", path.basename(new URL(build.url).pathname));
      if (!fs.existsSync(tgz)) await download(build, tgz);
      const staged = path.join(vmHome, "bin", `stage-${process.pid}`);
      fs.rmSync(staged, { recursive: true, force: true });
      fs.mkdirSync(staged, { recursive: true });
      try {
        // Windows 10+ ships bsdtar as tar.exe.
        const done = await exec("tar", ["-xzf", tgz, "-C", staged]);
        if (done.code !== 0 || !fs.existsSync(path.join(staged, "package", "claude.exe"))) throw new Error(`Claude Code could not be unpacked (${done.err.trim().split("\n").at(-1) || done.code})`);
        fs.renameSync(path.join(staged, "package", "claude.exe"), bin);
      } finally { fs.rmSync(staged, { recursive: true, force: true }); }
      return bin;
    })().catch((error) => { installs.delete(key); throw error; }));
  }
  return installs.get(key);
}

class ClaudeCodeModel {
  specificationVersion = "v3";
  provider = PROVIDER_ID;
  supportedUrls = {};

  constructor(modelId, settings) {
    this.modelId = modelId;
    this.settings = settings;
  }

  async doGenerate() {
    throw apiError("Claude chats stream their turns.");
  }

  /** The app's answer for this chat's turn: { token, baseUrl, client } or a refusal (thrown, never retried). */
  async grant(body) {
    const { grantURL, grantKey } = this.settings;
    if (!grantURL) throw apiError("Claude can't run from here.");
    let answer = null;
    try {
      const response = await fetch(grantURL, { method: "POST", headers: { "content-type": "application/json", "x-omnirush-usage-key": grantKey || "" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      answer = await response.json();
    } catch { answer = null; }
    if (!answer?.ok) throw apiError(answer?.message || "Claude could not start: the app did not answer.");
    return answer;
  }

  async doStream(options) {
    const headers = lower(options.headers);
    const sessionID = String(headers["x-session-id"] || headers["x-opencode-session-id"] || "");
    if (!sessionID) throw apiError("A Claude turn needs its chat.");
    if (headers["x-omnirush-side"] === "1") throw apiError("Side questions aren't available in Claude chats yet.");
    // A title the title model could not make (refused, busy) is asked again on the chat's model: here that ran the
    // first message as a second Claude turn next to the real one ("Session ID … is already in use", two agents).
    if (headers["x-omnirush-title"] === "1" || headers["x-omnirush-agent"] === "title") throw apiError("A Claude chat's title comes from the title model.");
    const compaction = headers["x-omnirush-agent"] === "compaction";
    const { shell, boxHome, directory, client = "cli", note, vmHome } = this.settings;
    const vm = this.settings.runtime === "vm" && Boolean(vmHome);
    // One desktop engine serves every project: the request names its folder.
    const root = path.resolve(headers["x-omnirush-directory"] || directory || process.cwd());
    const key = boxKey(root);
    const record = !vm && boxHome ? readRecord(boxHome, key) : null;
    // `noBox`: the app's own words for where to look (the CLI names its command; the desktop has none).
    if (!vm && (!shell || !record || record.state === "off")) throw apiError(this.settings.noBox || NO_BOX);
    const run = vm ? path.join(vmHome, key) : path.join(boxHome, "projects", key, "claude");
    const configDir = path.join(run, "config");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const uuid = uuidv5(sessionID);
    const resume = hasTranscript(configDir, uuid);
    const content = compaction ? [{ type: "text", text: "/compact" }] : lastUserContent(options.prompt);
    if (!content.length) throw apiError("Nothing to send to Claude.");
    const earlier = (options.prompt ?? []).some((m) => m?.role === "assistant");
    const ask = { op: "grant", sessionID, model: this.modelId, resume, earlier, directory: root, prompt: lineText(content).slice(0, 4000) };
    let grant = await this.grant(ask);
    // A lane VM's turn only with the server's word for this account (its lane list), never the machine's own.
    if (vm && grant.runtime !== "vm") throw apiError(NOT_LANE);
    const tokenFile = path.join(run, "token");
    const writeToken = (token) => { fs.writeFileSync(`${tokenFile}.tmp`, token, { mode: 0o600 }); fs.renameSync(`${tokenFile}.tmp`, tokenFile); };
    writeToken(grant.token);
    if (vm) fs.writeFileSync(path.join(run, "token-helper.cjs"), `process.stdout.write(require("fs").readFileSync(${JSON.stringify(tokenFile)}, "utf8"));\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "settings.json"), `${JSON.stringify({ apiKeyHelper: vm ? hostKeyHelper(run) : `cat ${BOX_RUN}/claude/token` })}\n`, { mode: 0o600 });

    const passed = claudeEnv({ model: this.modelId, baseUrl: grant.baseUrl, sessionID, client: grant.client || client, pkglogDir: vm ? null : installLogDir(boxHome, client), runtime: vm ? "vm" : "box", configDir });
    const env = vm ? { ...hostEnv(process.env), ...passed } : { ...process.env, ...passed, OMNIRUSH_BOX_KEY: key, OMNIRUSH_BOX_HOME: boxHome, OMNIRUSH_BOX_PASS_ENV: Object.keys(passed).join(",") };
    let hostBin = null;
    try {
      if (vm) hostBin = await ensureHostClaude(vmHome);
      else await ensureClaude({ shell, env, cwd: root, home: boxHome, run });
    } catch (error) { throw apiError(error?.message || "Claude Code could not be installed in the sandbox."); }

    const turnFile = path.join(run, `turn-${uuid}.jsonl`);
    const turnLine = `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: uuid })}\n`;
    if (!vm) fs.writeFileSync(turnFile, turnLine, { mode: 0o600 });
    // shortcut: a lane VM runs one chat at a time, so no sweep for an earlier Claude of the chat (LAUNCH's); add one if lanes share a VM.
    const child = vm
      ? spawn(hostBin, [...claudeArgs({ model: this.modelId }), ...(resume ? ["--resume", uuid] : ["--session-id", uuid])], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn(shell, ["-c", LAUNCH, BOX_BIN, `${BOX_RUN}/claude`, uuid, ...claudeArgs({ model: this.modelId })], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (vm) { child.stdin.on("error", () => undefined); child.stdin.write(turnLine); }
    const mapper = new ClaudeStreamMapper({ compaction });
    let stderr = "";
    let done = false;
    let stopped = false;
    const refresh = setInterval(() => { void this.grant({ ...ask, refresh: true }).then((next) => { grant = next; writeToken(next.token); }).catch(() => undefined); }, REFRESH_MS);
    refresh.unref?.();
    const timers = [];
    const end = () => { done = true; clearInterval(refresh); for (const t of timers) clearTimeout(t); };
    child.stdin.on("error", () => undefined);
    // The box has read it once Claude answers; a launch boxsh runs again reads it too.
    child.on("close", () => fs.rmSync(turnFile, { force: true }));
    const settings = this.settings;
    return {
      stream: new ReadableStream({
        start(controller) {
          const send = (part) => { if (!done) controller.enqueue(part); };
          send({ type: "stream-start", warnings: [] });
          if (note && !resume && !earlier && !compaction) for (const part of mapper.note(`${note}\n\n`)) send(part);
          child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
          let buffer = "";
          child.stdout.on("data", (chunk) => {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, at).trim();
              buffer = buffer.slice(at + 1);
              if (!line) continue;
              let event;
              try { event = JSON.parse(line); } catch { continue; }
              for (const part of mapper.push(event)) send(part);
              // The turn is over: Claude exits once its input ends.
              if (event.type === "result") child.stdin.end();
            }
          });
          child.on("error", (error) => { if (done) return; send({ type: "error", error: apiError(`Claude Code could not start in the sandbox (${error.message}).`) }); end(); controller.close(); });
          // The turn's native transcript goes up with the chat (best effort), a stopped turn's too once Claude has exited.
          const ended = (ok) => void fetch(settings.grantURL, { method: "POST", headers: { "content-type": "application/json", "x-omnirush-usage-key": settings.grantKey || "" }, body: JSON.stringify({ op: "end", sessionID, uuid, ok }) }).catch(() => undefined);
          child.on("close", (code) => {
            if (stopped) return ended(false);
            if (done) return;
            const tail = stderr.trim().split("\n").filter(Boolean).at(-1);
            const last = mapper.finish(`Claude Code stopped before the turn finished${tail ? `: ${tail.slice(0, 300)}` : ` (exit ${code})`}.`);
            for (const part of mapper.close()) send(part);
            send(last);
            end();
            controller.close();
            ended(last.type === "finish");
          });
        },
        cancel() {
          if (done || stopped) return;
          stopped = true;
          end();
          try { child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`); child.stdin.end(); } catch { /* gone */ }
          const stillRunning = () => child.exitCode === null && child.signalCode === null;
          timers.push(setTimeout(() => { if (stillRunning()) child.kill("SIGINT"); }, STOP_GRACE_MS));
          timers.push(setTimeout(() => { if (stillRunning()) child.kill("SIGKILL"); }, STOP_GRACE_MS * 2));
          for (const t of timers) t.unref?.();
        },
      }),
    };
  }
}

/** The engine's factory: settings are the provider's config options. */
export function createOmnirushClaude(settings = {}) {
  const provider = (id) => new ClaudeCodeModel(id, settings);
  provider.languageModel = provider;
  return provider;
}

export default createOmnirushClaude;
