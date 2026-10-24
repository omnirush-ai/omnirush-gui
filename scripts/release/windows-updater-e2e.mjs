#!/usr/bin/env node
/**
 * Drives a published Windows release's own in-app updater, end to end, on a
 * Windows machine (CI runner): installs v<from> with its NSIS installer, opens
 * it with a DevTools port, and calls the same bridge the Updates page and the
 * required-update screen call (check, download, installAndRestart). Then waits
 * for the installed version to change and checks the app data is still there.
 *
 *   node scripts/release/windows-updater-e2e.mjs --from 3.3.8 --expect 3.4.3 --feed <dir>
 *   node scripts/release/windows-updater-e2e.mjs --from 3.3.8 --expect 3.4.1        (the public Latest feed)
 *   node scripts/release/windows-updater-e2e.mjs --from 3.3.8 --expect none --feed <dir with 3.3.8's latest.yml>
 *
 * --feed serves a directory (latest.yml + installer) on a loopback port and
 * points the app at it with OMNIRUSH_UPDATER_DEV_FEED_URL, which every
 * release since the updater rewrite honors for loopback URLs only.
 * --expect none: the check must report no update, and nothing may install.
 * --from-installer <exe>: install this local build instead of the published
 * v<from> (to test an updater change before it ships). The feed answers single
 * Range requests and the run reports the installer bytes it served, so a
 * differential download shows up as a fraction of the installer size.
 */
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const REPO = "omnirush-ai/omnirush-gui";
const CDP_PORT = 9339;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const from = argValue("--from");
const expect = argValue("--expect");
const feedDir = argValue("--feed");
const fromInstaller = argValue("--from-installer");
const workDir = path.resolve(argValue("--work") ?? path.join(process.cwd(), "updater-e2e"));
if (!from || !expect) {
  console.error("Usage: windows-updater-e2e.mjs --from X.Y.Z --expect X.Y.Z|none [--feed dir] [--work dir]");
  process.exit(2);
}
mkdirSync(workDir, { recursive: true });

function log(message, data) {
  console.log(`[e2e] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
}

function installs() {
  const script = "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'omnirush' } | Select-Object DisplayName,DisplayVersion,UninstallString | ConvertTo-Json -Compress";
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  if (!out) return [];
  const value = JSON.parse(out);
  return Array.isArray(value) ? value : [value];
}

function installFolder(entry) {
  const match = /^"([^"]+)"/.exec(entry.UninstallString ?? "");
  return match ? path.dirname(match[1]) : null;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

// Bytes the feed sent per file.
const served = new Map();

function servedReport(directory) {
  return [...served].map(([name, bytes]) => {
    const size = statSync(path.join(directory, name)).size;
    return { name, served: bytes, size, percent: Math.round((1000 * bytes) / size) / 10 };
  });
}

function serveFeed(directory) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname.slice(1));
      const file = path.join(directory, name);
      log(`feed ${request.method} /${name}`);
      if (!name || name.includes("/") || name.includes("\\") || !existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      const size = statSync(file).size;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (range && start > end) {
        response.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      if (request.headers.range && !range) log(`feed: multi-range request answered in full: ${request.headers.range.slice(0, 60)}`);
      response.writeHead(range ? 206 : 200, {
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "content-type": "application/octet-stream",
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === "HEAD") return response.end();
      served.set(name, (served.get(name) ?? 0) + end - start + 1);
      createReadStream(file, { start, end }).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function cdpTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      waiter(message);
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values()) waiter({ error: { message: "socket closed" } });
      pending.clear();
    });
    socket.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)));
    socket.addEventListener("open", () => resolve({
      socket,
      async evaluate(expression, timeoutMs = 600_000) {
        nextId += 1;
        const id = nextId;
        const answer = new Promise((done) => pending.set(id, done));
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
        const message = await Promise.race([answer, sleep(timeoutMs).then(() => ({ error: { message: "timed out" } }))]);
        if (message.error) throw new Error(message.error.message);
        if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails));
        return message.result?.result?.value;
      },
    }));
  });
}

async function bridgePage(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const target of (await cdpTargets()).filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
      try {
        const page = await connect(target.webSocketDebuggerUrl);
        const ready = await page.evaluate("typeof window.__OMNIRUSH_ELECTRON__?.updater?.check === 'function'", 10_000);
        if (ready) {
          log(`bridge on ${target.url}`);
          return page;
        }
        page.socket.close();
      } catch {
        // Not ready yet.
      }
    }
    await sleep(2_000);
  }
  throw new Error("the app window never exposed the updater bridge");
}

function appProcesses() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq OmniRush.ai.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.startsWith('"OmniRush.ai.exe"')).length;
  } catch {
    return 0;
  }
}

async function waitForProcess(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appProcesses() > 0) return true;
    await sleep(2_000);
  }
  return false;
}

function stopApp() {
  try {
    execFileSync("taskkill", ["/F", "/T", "/IM", "OmniRush.ai.exe"], { stdio: "ignore" });
  } catch {
    // Not running.
  }
}

async function main() {
  const installer = fromInstaller ? path.resolve(fromInstaller) : path.join(workDir, `omnirush-win-x64-${from}.exe`);
  if (!fromInstaller) await download(`https://github.com/${REPO}/releases/download/v${from}/omnirush-win-x64-${from}.exe`, installer);
  execFileSync(installer, ["/S"], { stdio: "inherit" });
  const before = installs();
  log("installed", before);
  if (before.length !== 1 || before[0].DisplayVersion !== from) throw new Error(`expected one install of ${from}`);
  const folder = installFolder(before[0]);
  const exe = readdirSync(folder).find((name) => name.endsWith(".exe") && !/^Uninstall/i.test(name));
  log("app", { folder, exe });

  // Data the update must keep: a marker in userData (%APPDATA%\ai.omnirush.desktop).
  const userData = path.join(process.env.APPDATA, "ai.omnirush.desktop");
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, "updater-e2e-marker.txt"), "kept");

  const feed = feedDir ? await serveFeed(path.resolve(feedDir)) : null;
  const env = {
    ...process.env,
    OMNIRUSH_ELECTRON_REMOTE_DEBUG_PORT: String(CDP_PORT),
    ...(feed ? { OMNIRUSH_UPDATER_DEV_FEED_URL: feed.url } : {}),
  };
  const output = openSync(path.join(workDir, `app-${from}.log`), "a");
  const child = spawn(path.join(folder, exe), [], { env, detached: true, stdio: ["ignore", output, output] });
  child.unref();

  const page = await bridgePage(240_000);
  const run = (call) => page.evaluate(`window.__OMNIRUSH_ELECTRON__.updater.${call}`);
  log("getChannel", await run("getChannel()"));
  const checked = await run("check('stable')");
  log("check", checked);

  if (expect === "none") {
    const downloaded = await run("download()");
    log("download", downloaded);
    stopApp();
    feed?.server.close();
    if (checked?.available !== false) throw new Error("the check offered an update");
    if (downloaded?.ok !== false) throw new Error("a download started with no update available");
    const after = installs();
    if (after.length !== 1 || after[0].DisplayVersion !== from) throw new Error("the installed version changed");
    log(`PASS: ${from} finds no update (feed offers ${checked.latestVersion}); download says: ${downloaded.reason}`);
    return;
  }

  if (!checked?.available || checked.latestVersion !== expect) throw new Error(`the check did not offer ${expect}`);
  const downloaded = await run("download()");
  log("download", downloaded);
  if (feed) log("feed bytes served", servedReport(path.resolve(feedDir)));
  if (!downloaded?.ok) throw new Error(`download failed: ${downloaded?.reason}`);
  // The app quits into the installer; the answer may never arrive.
  void page.evaluate("window.__OMNIRUSH_ELECTRON__.updater.installAndRestart()", 180_000)
    .then((result) => log("installAndRestart", result))
    .catch((error) => log(`installAndRestart: ${error.message}`));

  const deadline = Date.now() + 420_000;
  let after = [];
  while (Date.now() < deadline) {
    after = installs();
    if (after.length === 1 && after[0].DisplayVersion === expect) break;
    await sleep(5_000);
  }
  log("after", after);
  if (after.length !== 1 || after[0].DisplayVersion !== expect) throw new Error(`the install did not reach ${expect}`);
  if (installFolder(after[0]) !== folder) throw new Error(`the update moved the app to ${installFolder(after[0])}`);
  const version = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${path.join(folder, exe)}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();
  log("executable version", version);
  if (readFileSync(path.join(userData, "updater-e2e-marker.txt"), "utf8") !== "kept") throw new Error("app data was lost");
  // The updated app relaunches by itself (quitAndInstall forceRunAfter).
  const relaunched = await waitForProcess(120_000);
  log("relaunched", relaunched);
  stopApp();
  feed?.server.close();
  log(`PASS: ${from} updated itself to ${version} in ${folder}, data kept, relaunched=${relaunched}`);
}

main().then(() => process.exit(0), (error) => {
  console.error(`[e2e] FAIL: ${error.message}`);
  stopApp();
  process.exit(1);
});
