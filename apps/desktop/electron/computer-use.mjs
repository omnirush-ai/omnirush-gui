// Computer use in the desktop app (contract v2): the host runs in this main
// process, behind the server switch (the local server's /computer-use/state:
// GET /collect/capabilities `computer_use`, or OMNIRUSH_COMPUTER_USE=0/1).
//
// - The agent's own display (app_id "virtual:main", the default): Linux with
//   Xvfb uses the shared Xvfb backend; macOS, Windows and Linux without Xvfb
//   use the agent-only browser (computer-use-agent-browser.mjs). It never asks.
// - The person's real screen: Windows and Linux X11 through the shared portable
//   host + native worker (apps/server/src/computer-use/shared/, the same files
//   as the CLI's); macOS through the signed Swift helper (computer-use-host.mjs).
//   Off until the person turns it on once in Settings (desktop IPC from the
//   main window only); then it runs without questions.
//
// The engine reaches the host only as the built-in MCP server `computer-use`
// (the local server adds it from host.json; the id is reserved). What stays:
// the indicator and Stop, the deny list, stuck-input release, the server switch.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, Notification, screen, session } from "electron";
import { startAgentBrowser } from "./computer-use-agent-browser.mjs";
import { testAnswersAllowed } from "./computer-use-answers.mjs";
import { createHostGate } from "./computer-use-gate.mjs";
import { createComputerUseHost } from "./computer-use-host.mjs";
import { createComputerPreview } from "./computer-use-preview.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const STATUS_CHANNEL = "omnirush:computer-use:status";
// A per-launch secret, held in this process only (the local server runs in this process and reads it here):
// the host and event routes take it, so a client token read from disk cannot replace the host or forge events.
const HOST_SECRET = randomBytes(32).toString("hex");
globalThis[Symbol.for("omnirush.computer-use.host-secret")] = HOST_SECRET;
const secretHeaders = { "x-omnirush-computer-use-secret": HOST_SECRET };
// The profile folder the local server expects the host in (computer-use/desktop.ts expectedHostCommand).
const profileDir = () => process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR?.trim() || app.getPath("userData");
const SYNTHETIC_MESSAGE = "Use your own mouse or keyboard to continue.";
// Continue (after the person took over the real screen) needs a physical press in this app's window. OMNIRUSH_COMPUTER_USE_TEST_ANSWERS=1 accepts
// remote-debugging clicks, in builds run from source only (the e2e rig).
// Packaged apps ignore it (computer-use-answers.mjs).
const testAnswers = testAnswersAllowed(process.env, app.isPackaged, (message) => console.warn(`[computer-use] ${message}`));
// The pressed button in screen pixels (the worker's press coordinates): content bounds + CSS box × zoom.
function screenRectOf(rect) {
  const window = deps?.getWindow?.();
  if (!window || window.isDestroyed() || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const content = window.getContentBounds(), zoom = window.webContents.getZoomFactor();
  const dip = { x: Math.round(content.x + rect.x * zoom), y: Math.round(content.y + rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) };
  if (process.platform === "win32") return screen.dipToScreenRect(window, dip);
  if (process.platform === "linux") {
    const factor = screen.getDisplayMatching(dip).scaleFactor || 1;
    return { x: dip.x * factor, y: dip.y * factor, width: dip.width * factor, height: dip.height * factor };
  }
  return dip; // macOS: points, as the helper reports presses
}

// A physical press within 1.5 s, in this app's window, on the pressed button (or Enter/Space on it).
async function personAnswered(rect) {
  if (!host) return false;
  if (await host.syntheticInput()) return false;
  return testAnswers || host.physicalInput(1500, { foregroundPid: process.pid, rect: screenRectOf(rect) });
}

let deps = null;
let server = null; // the last /computer-use/state answer
let host = null;
let hostPromise = null;
// Starts in flight go stale on off/stop; older state answers never undo newer ones (computer-use-gate.mjs).
const gate = createHostGate();
let listener = null;
let preview = null;
let shared = null;
let pollTimer = null;
let refreshTimer = null;
let failedAt = 0; // a host that did not start is tried again after a minute
const cursors = new Map(); // session id → the agent cursor's latest move (live view)
let cursorSeq = 0;
let realScreenNoticeShown = false;
// The server's yes for this account's real screen (`real_screen` and `real_screen_opt_in`), taken only from a
// fresh read (the refresh route answers from the server's answer in memory). The 5 s state poll reads the local
// state folder, which the agent's shell can write: it can only take this back to no, never to yes.
let serverRealScreen = false;

function shippedModule(name) {
  // Packaged: app.asar/server/dist; dev: apps/server/dist (OMNIRUSH_DEV_MODE prefers it).
  const candidates = [
    path.resolve(__dirname, "..", "server", "dist", "computer-use", "shared", name),
    path.resolve(__dirname, "..", "..", "server", "dist", "computer-use", "shared", name),
    path.resolve(__dirname, "..", "..", "server", "src", "computer-use", "shared", name),
  ];
  if (process.env.OMNIRUSH_DEV_MODE === "1") candidates.unshift(candidates.splice(1, 1)[0]);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Computer use is missing from this build. Reinstall OmniRush.ai.");
  return pathToFileURL(found).href;
}

async function sharedModules() {
  if (!shared) {
    const [hostModule, mediaModule, policyModule, contractModule, imageModule, virtualModule, virtualWorker] = await Promise.all(["portable-host.mjs", "media.mjs", "policy.mjs", "contract.mjs", "image.mjs", "virtual-host.mjs", "virtual-worker.mjs"].map((name) => import(shippedModule(name))));
    shared = { hostModule, mediaModule, policyModule, contractModule, imageModule, virtualModule, virtualWorker, ancestors: policyModule.readAncestors() };
  }
  return shared;
}

async function serverFetch(pathname, init = {}) {
  const info = await deps?.serverInfo?.();
  const token = info?.clientToken ?? info?.ownerToken;
  if (!info?.baseUrl || !token) throw new Error("The local OmniRush.ai server is not ready.");
  // loopback-fetch: the locally managed OmniRush.ai server.
  const response = await fetch(`${info.baseUrl}${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`computer use route ${pathname}: ${response.status}`);
  return response.json();
}

function supported() {
  return process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
}

function statusNow() {
  // Each session carries its cursor's latest move, so the live view glides it from `from` to `to`.
  const sessions = host ? host.state().map((s) => (cursors.has(s.id) ? { ...s, cursor_move: cursors.get(s.id) } : s)) : [];
  const device = deviceOn();
  return {
    enabled: server?.enabled === true && device,
    // The person's own on/off for this device (Settings > Computer use; on by default).
    device_on: device,
    // The agent's own display works without desktop access (no helper, Wayland), so only "off" is unavailable.
    supported: supported(),
    message: !device ? "Computer use is turned off on this computer." : server?.enabled ? (supported() ? null : "Computer use is unavailable on this desktop.") : server?.unavailable ?? server?.setting?.message ?? (server ? "Computer use is turned off." : null),
    // The models that can use it (null: any).
    models: server?.setting?.models ?? null,
    mode: server?.mode ?? "normal",
    sessions,
  };
}

function pushStatus() {
  const window = deps?.getWindow?.();
  if (window && !window.isDestroyed()) window.webContents.send(STATUS_CHANNEL, statusNow());
  // macOS: the helper shows its own pill for the real screen; the floating preview is for the agent's display.
  if (host) preview?.update(host.state().filter((s) => process.platform !== "darwin" || s.display === "virtual"));
}

function onCursor(move) {
  cursors.set(move.session_id, { ...move, seq: ++cursorSeq, at: Date.now() });
  pushStatus();
  preview?.cursor(move);
}

// The person's on/off for computer use on this device (policy.mjs COMPUTER_USE_SETTING, on by default), saved in
// the profile and set only from the main window. Off: the host stops, so the engine gets no computer-use tools.
const deviceFile = () => path.join(profileDir(), "computer-use", shared?.policyModule?.COMPUTER_USE_FILE ?? "device.json");
let deviceSaved; // undefined: not read yet
function deviceOn() {
  const policy = shared?.policyModule;
  if (!policy) return true; // shown only: apply() loads the rules before it starts anything
  if (deviceSaved === undefined) {
    try { const value = JSON.parse(readFileSync(deviceFile(), "utf8"))?.[policy.COMPUTER_USE_SETTING]; deviceSaved = typeof value === "boolean" ? value : null; } catch { deviceSaved = null; }
  }
  return policy.deviceComputerUse(deviceSaved ?? undefined);
}

async function setComputerUseOn(on) {
  if (typeof on !== "boolean") throw new Error("Choose on or off.");
  const { policyModule } = await sharedModules();
  const file = deviceFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ [policyModule.COMPUTER_USE_SETTING]: on }), { mode: 0o600 });
  renameSync(temp, file);
  deviceSaved = on;
  // Live: off stops the host now (the engine drops the tools); on starts it with the next state read.
  await apply(server);
  return statusNow();
}

// The person's one-time real-screen setting (policy.mjs REAL_SCREEN_SETTING), saved in the profile, set only
// from the main window (desktop IPC), never through the local server an agent's shell can reach.
const realScreenFile = () => path.join(profileDir(), "computer-use", "real-screen.json");
let realScreenSaved; // undefined: not read yet (read once; later writes count only through the setter)
function savedRealScreen(policy) {
  if (realScreenSaved === undefined) {
    try { const value = JSON.parse(readFileSync(realScreenFile(), "utf8"))?.[policy.REAL_SCREEN_SETTING]; realScreenSaved = typeof value === "boolean" ? value : null; } catch { realScreenSaved = null; }
  }
  return realScreenSaved ?? undefined;
}
/** Whether the person turned the real screen on (false until the shared rules are loaded). */
function realScreenOn() {
  const policy = shared?.policyModule;
  // The environment can turn it on only in an app run from source (never a line slipped into a shell profile).
  return policy ? policy.realScreenOptIn({ env: process.env, saved: savedRealScreen(policy), allowEnvOn: !app.isPackaged }) : false;
}

/** Whether a state answer says yes for this account's real screen (both keys exactly true). */
function saysRealScreen(answer) {
  return Boolean(shared?.policyModule?.serverRealScreen?.(answer?.setting)) && answer?.enabled === true;
}

/** Ends the sessions on the person's screen (the agent's own display keeps running). */
async function stopRealScreen() {
  if (!host) return;
  if (typeof host.stopRealScreen === "function") await host.stopRealScreen("server").catch(() => {});
  else for (const s of host.state()) if (s.display !== "virtual" && s.phase !== "ended") await host.control({ session_id: s.id, action: "stop" }).catch(() => {});
}

/** Whether the host may run now: the server says on, this OS can, and the person has not turned it off here. */
function allowedNow() {
  return server?.enabled === true && supported() && Boolean(shared?.policyModule) && deviceOn();
}

function hostSettings() {
  const setting = server?.setting ?? {};
  return { enabled: allowedNow(), real_screen: serverRealScreen, real_screen_opt_in: serverRealScreen, real_screen_on: realScreenOn(), virtual_display: setting.virtual_display !== false, limits: setting.limits ?? null, deny_apps: setting.deny_apps ?? [], message: setting.message ?? null };
}

async function hostContext() {
  const metrics = (() => { try { return app.getAppMetrics().map((m) => m.pid); } catch { return []; } })();
  // The chat now (the one that just called), not the last poll's.
  const asked = gate.ask();
  const fresh = await serverFetch("/computer-use/state").catch(() => null);
  if (fresh && gate.fresh(asked)) server = fresh;
  // No fresh answer: no chat, never the last poll's.
  return { ancestors: shared?.ancestors ?? [], self_pids: [process.pid, ...metrics], chat: fresh ? fresh.chat ?? null : null };
}

/** Before each open: the server's switch and limits read now (not a cached answer). False when unread. */
async function hostRefresh() {
  const asked = gate.ask();
  const fresh = await serverFetch("/computer-use/refresh", { method: "POST", body: JSON.stringify({ max_age_ms: 0 }) }).catch(() => null);
  if (!fresh) { serverRealScreen = false; return false; }
  // An answer older than one already applied cannot give anything back.
  if (!gate.fresh(asked)) return false;
  server = fresh;
  // Only the server's answer just read can say yes; anything else is no.
  serverRealScreen = fresh.read === true && saysRealScreen(fresh);
  return fresh.read === true;
}

async function reportEvent(event) {
  const session = host?.state().find((s) => s.id === event.session_id);
  await serverFetch("/computer-use/event", { method: "POST", headers: secretHeaders, body: JSON.stringify({ event, ...(session?.chat ? { chat: session.chat } : {}) }) }).catch(() => {});
}

async function startHost() {
  if (hostPromise) return hostPromise;
  const taken = gate.begin();
  // Turned off (or stopped) while this start was in flight: close what it made, publish nothing.
  const stale = () => !gate.current(taken) || !allowedNow();
  const abandon = async (made, madeListener) => {
    await madeListener?.close().catch(() => {});
    await made?.stopAll?.("server").catch(() => {});
    await made?.close?.().catch(() => {});
    throw Object.assign(new Error("Computer use is turned off."), { code: "computer_use_stale_start" });
  };
  const pending = (async () => {
    const { hostModule, mediaModule, policyModule, contractModule, imageModule, virtualModule, virtualWorker } = await sharedModules();
    const spool = server?.spool ? mediaModule.createMediaSpool(server.spool) : null;
    const onState = () => { pushStatus(); scheduleRefresh(); };
    const onFrame = (frame) => preview?.image(frame.data_url, frame.session_id);
    const onEvent = (event) => { if (["stopped", "closed", "expired"].includes(event.event)) cursors.delete(event.session_id); void reportEvent(event); };
    const koffiPath = () => require.resolve("koffi");
    const virtual = virtualModule.createVirtualHost({
      // Linux with Xvfb (and a browser for it): a whole display of its own; elsewhere the agent-only browser in this app.
      startBackend: (name, options) => (process.platform === "linux" && virtualModule.which("Xvfb") && (!options.browser || virtualModule.findBrowser())
        ? virtualModule.startXvfbBackend({ name, ...options, nodePath: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, koffiPath: koffiPath() })
        : startAgentBrowser({ electron: { BrowserWindow, session, clipboard }, glidePath: virtualWorker.glidePath, url: options.url })),
      settings: hostSettings, context: hostContext, spool, onEvent, onState, onFrame, onCursor,
    });
    const callbacks = { spool, settings: hostSettings, context: hostContext, refresh: hostRefresh, virtual, onEvent, onState, onFrame };
    // No desktop access (no helper, Wayland): the agent's own display still works on this host.
    const stubNative = (error) => ({ ready: Promise.resolve({ supported: false, code: "native_unavailable", error }), held: { keys: [], buttons: [] }, onEvent() { return () => {}; }, call: async () => { throw Object.assign(new Error(error), { code: "native_unavailable" }); }, close: async () => {} });
    let created;
    if (process.platform === "darwin") {
      const executable = resolveComputerUseExecutable();
      created = executable
        ? await createComputerUseHost({ executable, ...callbacks, shared: { portable: hostModule, policy: policyModule, contract: contractModule, image: imageModule } })
        : await hostModule.createPortableHost({ native: stubNative("The Computer Use helper is unavailable. Rebuild or reinstall OmniRush.ai."), ...callbacks, platform: "darwin" });
    } else {
      const nativeFactory = () => hostModule.createNativeWorker({ nodePath: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, koffiPath: koffiPath() });
      created = await hostModule.createPortableHost({ native: nativeFactory(), nativeFactory, ...callbacks });
    }
    if (stale()) return abandon(created);
    preview = createComputerPreview();
    preview.bind(created);
    host = created;
    // The real screen on: said once per launch (the setting is a file the agent's shell could also write).
    if (!realScreenNoticeShown && realScreenOn() && serverRealScreen) {
      realScreenNoticeShown = true;
      try { if (Notification.isSupported()) new Notification({ title: "Computer use can use your own screen", body: "The agent can click and type in your apps without asking. Stop it any time with Stop; turn it off in Settings > Computer use." }).show(); } catch { /* best effort */ }
    }
    const madeListener = await created.listen(path.join(profileDir(), "computer-use"));
    // Checked again right before anything is published (host.json, the listener the relays find).
    if (stale()) { if (host === created) { host = null; preview?.close(); preview = null; } return abandon(created, madeListener); }
    listener = madeListener;
    const relay = app.isPackaged ? path.join(process.resourcesPath, "computer-use", "relay.mjs") : path.join(__dirname, "computer-use-relay.mjs");
    const command = [process.execPath, relay, listener.discoveryPath];
    const environment = { ELECTRON_RUN_AS_NODE: "1" };
    await serverFetch("/computer-use/host", { method: "POST", headers: secretHeaders, body: JSON.stringify({ command, environment }) });
    // Off while host.json was being written: take it back now.
    if (stale()) { await stopHost("server"); throw Object.assign(new Error("Computer use is turned off."), { code: "computer_use_stale_start" }); }
    pushStatus();
    return created;
  })().catch((error) => { if (hostPromise === pending) { hostPromise = null; host = null; } throw error; });
  hostPromise = pending;
  return pending;
}

async function stopHost(by = "server") {
  // A start still in flight goes stale and closes what it made (startHost).
  gate.revoke();
  hostPromise = null;
  const current = host;
  await serverFetch("/computer-use/host", { method: "POST", headers: secretHeaders, body: JSON.stringify({ host: null }) }).catch(() => {});
  if (!current) return;
  await current.stopAll(by).catch(() => {});
  cursors.clear();
  await listener?.close().catch(() => {});
  await current.close().catch(() => {});
  preview?.close(); preview = null;
  host = null; hostPromise = null; listener = null;
  pushStatus();
}

async function apply(next) {
  await sharedModules().catch(() => null);
  server = next;
  // A periodic answer can only take the account's real screen away; a fresh read gives it (hostRefresh).
  if (next?.read === true) serverRealScreen = saysRealScreen(next);
  // A refresh that could not read the server (read false) or a no: no (fail closed).
  else if (next?.read === false || !saysRealScreen(next)) serverRealScreen = false;
  if (!serverRealScreen) await stopRealScreen();
  const wanted = server?.enabled && supported() && deviceOn();
  if (wanted && !hostPromise && Date.now() - failedAt < 60_000) { pushStatus(); return; }
  // A start made stale by off is no failure (the next on starts at once).
  if (wanted) await startHost().catch((error) => { if (error?.code === "computer_use_stale_start") return; failedAt = Date.now(); deps?.log?.("computer use host did not start", error); });
  else if (host || hostPromise) await stopHost("server");
  pushStatus();
}

// While a session is open the switch is read again every 60 s: off closes it within a minute.
function scheduleRefresh() {
  const open = host?.state().some((s) => s.phase !== "ended") ?? false;
  if (open && !refreshTimer) {
    refreshTimer = setInterval(() => {
      // A failed read is a no for the person's screen (fail closed); the agent's own display keeps running.
      const asked = gate.ask();
      void serverFetch("/computer-use/refresh", { method: "POST", body: "{}" }).then((answer) => (gate.fresh(asked) ? apply(answer) : undefined)).catch(() => { serverRealScreen = false; void stopRealScreen(); });
    }, 60_000);
    refreshTimer.unref?.();
  } else if (!open && refreshTimer) {
    clearInterval(refreshTimer); refreshTimer = null;
  }
}

/** Starts following the switch (main.mjs, once the local server runs). */
export function initComputerUse(options) {
  deps = options;
  const poll = () => { const asked = gate.ask(); void serverFetch("/computer-use/state").then((answer) => (gate.fresh(asked) ? apply(answer) : undefined)).catch(() => {}); };
  poll();
  // The state route is local: the chat in use and the switch are read every few seconds.
  pollTimer = setInterval(poll, 5_000);
  pollTimer.unref?.();
}

app.on("before-quit", () => { if (pollTimer) clearInterval(pollTimer); void stopHost("agent"); });

async function getComputerUseState() {
  return statusNow();
}

/** The person's real-screen setting (main window only, main.mjs checks the sender). */
async function getComputerUseRealScreen() {
  const { policyModule } = await sharedModules();
  // forced: OMNIRUSH_COMPUTER_USE_REAL_SCREEN decides, whatever is saved.
  const forced = policyModule.realScreenOptIn({ env: process.env, saved: true, allowEnvOn: !app.isPackaged }) === policyModule.realScreenOptIn({ env: process.env, saved: false, allowEnvOn: !app.isPackaged });
  // allowed: the server says yes for this account (its opt-in, set only in the web console), read just now.
  await hostRefresh().catch(() => false);
  return { on: realScreenOn(), forced, allowed: serverRealScreen };
}

async function setComputerUseRealScreen(on) {
  if (typeof on !== "boolean") throw new Error("Choose on or off.");
  const { policyModule } = await sharedModules();
  const file = realScreenFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ [policyModule.REAL_SCREEN_SETTING]: on }), { mode: 0o600 });
  renameSync(temp, file);
  realScreenSaved = on;
  // Off: sessions on the person's screen end now (the agent's own display keeps running).
  if (!realScreenOn() && host) for (const s of host.state()) if (s.display !== "virtual" && s.phase !== "ended") await host.control({ session_id: s.id, action: "stop" }).catch(() => {});
  pushStatus();
  return getComputerUseRealScreen();
}

async function computerUseControl(value) {
  if (!host) throw new Error("Computer use is not running.");
  if (value?.action === "continue" && !(await personAnswered(value.rect))) throw new Error(SYNTHETIC_MESSAGE);
  await host.control({ session_id: value?.session_id, action: value?.action });
  pushStatus();
}

function getComputerUseMcpEnvironment() { return { ELECTRON_RUN_AS_NODE: "1" }; }

async function getComputerUseMcpCommand() {
  await sharedModules();
  // The person's off on this device counts as much as the server's: no host, listener or tools.
  if (!server?.enabled) throw new Error(server?.setting?.message ?? "Computer use is turned off.");
  if (!allowedNow()) throw new Error("Computer use is turned off on this computer.");
  await startHost();
  if (!listener || !allowedNow()) throw new Error("Computer use is turned off.");
  const relay = app.isPackaged ? path.join(process.resourcesPath, "computer-use", "relay.mjs") : path.join(__dirname, "computer-use-relay.mjs");
  // The copied CLI connection: its own token (cli-connection.json), so its calls belong to no chat of this app.
  // The engine's relay alone reads engine-connection.json.
  return [process.execPath, relay, listener.externalDiscoveryPath];
}

// ---------------------------------------------------------------------------
// macOS helper: locating the bundled app, permission checks (spawn --check for
// a fresh TCC read), running-app listing for @App mentions, permission setup.
// ---------------------------------------------------------------------------

const COMPUTER_USE_HELPER_APP_NAME = "OmniRush.ai Computer Use.app";
const COMPUTER_USE_HELPER_EXECUTABLE = "ComputerUse";

function computerUseHelperAppPath() {
  const explicitApp = process.env.OMNIRUSH_COMPUTER_USE_APP?.trim();
  const candidates = [
    explicitApp,
    process.resourcesPath ? path.join(process.resourcesPath, "helpers", COMPUTER_USE_HELPER_APP_NAME) : null,
    path.resolve(__dirname, "..", "resources", "helpers", COMPUTER_USE_HELPER_APP_NAME),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveComputerUseExecutable() {
  const explicit = process.env.OMNIRUSH_COMPUTER_USE_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const bin = path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE);
    if (existsSync(bin)) return bin;
  }
  if (!app.isPackaged) {
    const swiftPkg = path.resolve(__dirname, "../../..", "packages/computer-use/native");
    for (const c of [".build/release/ComputerUse", ".build/arm64-apple-macosx/release/ComputerUse", ".build/debug/ComputerUse", ".build/arm64-apple-macosx/debug/ComputerUse"].map((rel) => path.join(swiftPkg, rel))) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

async function checkComputerUsePermissions() {
  if (process.platform !== "darwin") {
    const available = host?.availability ?? { supported: false, error: server?.enabled ? "Computer use is starting." : "Computer use is turned off." };
    return { ok: available.supported, accessibility: available.supported, screenRecording: available.supported, supported: available.supported, protocolVersion: "omnirush.computer-use/2", platform: process.platform, modes: ["observe", "control"], backgroundControl: false, ...(available.error ? { error: available.error } : {}) };
  }
  const bin = resolveComputerUseExecutable();
  if (!bin) return { ok: false, accessibility: false, screenRecording: false, error: "Helper binary not found. Run pnpm dev to build it." };
  return spawnJson(bin, ["--check"], (parsed) => ({
    ok: parsed?.ok === true,
    accessibility: parsed?.accessibility === true,
    screenRecording: parsed?.screenRecording === true,
    supported: parsed?.supported === true,
    protocolVersion: parsed?.protocolVersion,
  }), { ok: false, accessibility: false, screenRecording: false, error: "Permission check returned invalid output." });
}

function spawnJson(bin, args, map, fallback) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve(fallback));
    child.on("close", () => { try { resolve(map(JSON.parse(stdout.trim()))); } catch { resolve(fallback); } });
  });
}

async function listRunningApps() {
  if (process.platform !== "darwin") {
    if (!host) return { ok: false, apps: [] };
    const connection = host.connect();
    try {
      const reply = await connection.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_discover", arguments: {} } });
      const state = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
      return { ok: state.ok === true, apps: [...new Set((state.apps ?? []).filter((a) => a.windows?.length).map((a) => a.name))] };
    } finally { await connection.close(); }
  }
  const bin = resolveComputerUseExecutable();
  if (!bin) return { ok: false, apps: [] };
  return spawnJson(bin, ["--list-apps"], (parsed) => ({ ok: parsed?.ok === true, apps: Array.isArray(parsed?.apps) ? parsed.apps.filter((name) => typeof name === "string" && name.trim()) : [] }), { ok: false, apps: [] });
}

let setupProcess = null;

async function openComputerUseSetupApp() {
  if (process.platform !== "darwin") return;
  const bin = resolveComputerUseExecutable();
  if (!bin) throw new Error("The Computer Use helper is unavailable. Rebuild or reinstall OmniRush.ai.");
  // Keep the responsible application consistent with --check and the MCP child.
  if (setupProcess && setupProcess.exitCode === null && !setupProcess.killed) { setupProcess.kill("SIGUSR1"); return; }
  const child = spawn(bin, ["setup"], { stdio: "ignore" });
  setupProcess = child;
  child.once("exit", () => { if (setupProcess === child) setupProcess = null; });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => { if (setupProcess === child) setupProcess = null; reject(error); });
  });
  child.unref();
}

/** The chat permission mode the built-in browser follows, read now as computer use does (else the last poll's). */
async function browserPermissionMode() {
  const fresh = await serverFetch("/computer-use/state").catch(() => null);
  if (fresh) server = fresh;
  return server?.mode ?? "normal";
}

let browserPolicy = null;
/**
 * Whether one built-in browser act asks first: the computer use rules
 * (policy.mjs actApproval), reasons with their people-facing text. If the
 * rules cannot load, every act asks.
 */
async function browserActApproval(input) {
  try {
    browserPolicy ??= import(shippedModule("policy.mjs"));
    const policy = await browserPolicy;
    const decision = policy.actApproval(input, { sendDelete: server?.setting?.ask_send_delete === true });
    return { ask: decision.ask, reasons: decision.reasons.map((reason) => ({ ...reason, text: policy.ASK_REASONS[reason.code] ?? null })) };
  } catch {
    browserPolicy = null;
    return { ask: true, reasons: [] };
  }
}

export {
  browserActApproval,
  browserPermissionMode,
  getComputerUseState,
  getComputerUseRealScreen,
  setComputerUseRealScreen,
  setComputerUseOn,
  computerUseControl,
  getComputerUseMcpEnvironment,
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
};
