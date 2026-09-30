// Windows / X11 use the same MCP contract and main-window-only approvals as Mac.
// The private native bridge is never reachable over the MCP transport.
import { createServer } from "node:net";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createNativeDesktop } from "./computer-use-native.mjs";

const modes = ["observe", "control"];
const methods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
const string = { type: "string" };
const session = { session_id: string };
const tools = [
  tool("computer_discover", "List running app identities without window contents. Start an app yourself if it is closed. Windows and Linux X11 support observe and foreground control; assist is unavailable.", {}),
  tool("computer_open_session", "Ask the person to approve one visible app window. Never infer consent. Wait for this tool to return before observing.", { app_id: string, pid: { type: "integer" }, mode: { type: "string", enum: modes }, purpose: string }, ["app_id", "purpose"]),
  tool("computer_observe", "Get a fresh screenshot of the approved window. Visual models are required. Coordinates for actions are screenshot pixels, relative to the window. Observe again after every action or failure.", { ...session, include_image: { type: "boolean" } }, ["session_id"]),
  tool("computer_act", "Perform one action using a fresh, single-use observation. Supported: click/double_click (x,y), drag (path [{x,y}]), scroll (x,y,delta in steps (positive down/right),axis), type (text), key (key,modifiers ctrl/shift/alt). Foreground only. Never retry an action when may_have_acted is true; observe and inspect its result.", { ...session, observation_id: string, request_id: string, action: { type: "object", properties: { type: { type: "string", enum: ["click", "double_click", "drag", "scroll", "type", "key"] }, x: { type: "number" }, y: { type: "number" }, path: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } }, delta: { type: "integer" }, axis: { type: "string", enum: ["vertical", "horizontal"] }, text: string, key: string, modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "shift", "alt"] } } }, required: ["type"], additionalProperties: false } }, ["session_id", "observation_id", "request_id", "action"]),
  tool("computer_session_status", "Read the session status. After person input, wait for the person to choose Continue; the agent cannot resume itself.", session, ["session_id"]),
  tool("computer_close_session", "End access and release mouse and keyboard input.", session, ["session_id"]),
];
const failure = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const content = (state, image) => ({ content: [{ type: "text", text: JSON.stringify(state) }, ...(image ? [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] : [])], isError: state.ok !== true });
const digest = (image) => createHash("sha256").update(image).digest("hex");
const sameBounds = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validateAction(action, size) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("An action object is required.");
  const point = (p) => { if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= size.width || p.y >= size.height) throw new Error("The point must be inside the approved screenshot."); };
  if (["click", "double_click", "scroll"].includes(action.type)) point(action);
  else if (action.type === "drag") { if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > 64) throw new Error("A drag needs 2 to 64 points."); action.path.forEach(point); }
  else if (action.type === "type") { if (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(action.text)) throw new Error("Text must contain 1 to 1000 printable characters."); }
  else if (action.type === "key") { if (typeof action.key !== "string" || action.key.length > 20) throw new Error("A supported key name is required."); }
  else throw new Error("This action is unavailable. Use click, double_click, drag, scroll, type, or key.");
  if (action.type === "scroll" && (!Number.isInteger(action.delta) || Math.abs(action.delta) > 20 || action.delta === 0 || !["vertical", "horizontal", undefined].includes(action.axis))) throw new Error("Scroll needs 1 to 20 steps and a vertical or horizontal axis.");
}
export async function createPortableComputerUseHost({ profile, capture, preview }) {
  const native = createNativeDesktop();
  const availability = await native.ready;
  const captureWindow = process.platform === "linux" ? (window) => native.call("capture", { window }) : capture;
  const directory = path.join(profile, "computer-use");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const discoveryPath = path.join(directory, "connection.json");
  const token = randomBytes(32).toString("hex");
  const connections = new Map();
  let lease = null, closed = false;
  const state = () => [...connections.values()].flatMap((entry) => entry.session ? [{
    connectionId: entry.id, id: entry.session.id, phase: entry.session.phase, appName: entry.session.window.appName,
    task: entry.session.purpose, mode: entry.session.mode, windows: entry.session.windows.map((w) => ({ id: w.id, title: w.title })),
    windowTitle: entry.session.window.title, windowBounds: entry.session.window.bounds, status: entry.session.status, recoverable: false,
    canContinue: entry.session.phase === "paused", previewVisible: entry.session.previewVisible,
    remainingSeconds: Math.max(0, Math.ceil((entry.session.expiresAt - Date.now()) / 1000)),
  }] : []);
  const update = () => preview?.update(state());
  async function stop(entry) {
    const value = entry.session;
    if (!value) return;
    entry.session = null; value.observation = null; value.approval?.resolve(failure("approval_cancelled", "The request ended without access."));
    if (lease === entry.id) lease = null;
    await native.call("stop").catch(() => {});
    update();
  }
  function pause(entry, message) {
    const value = entry.session;
    if (!value || value.phase === "approval") return;
    value.phase = "paused"; value.observation = null; value.status = message;
    void native.call("stop").catch(() => {}); update();
  }
  native.onInput(() => {
    for (const entry of connections.values()) if (entry.session?.phase === "working") pause(entry, "Your input interrupted control. Choose Continue when you are ready.");
  });
  const server = createServer((socket) => {
    if (closed || connections.size >= 16) { socket.destroy(); return; }
    const entry = { id: randomUUID(), session: null, socket, busy: false };
    connections.set(entry.id, entry);
    let incoming = "", authenticated = false;
    const authTimer = setTimeout(() => socket.destroy(), 5000);
    socket.setEncoding("utf8");
    const close = () => { clearTimeout(authTimer); connections.delete(entry.id); void stop(entry); };
    socket.once("close", close); socket.on("error", () => socket.destroy());
    const send = (message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
    const respond = async (message) => {
      if (!message || message.jsonrpc !== "2.0" || !methods.has(message.method)) {
        send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32601, message: "Method not available to the agent." } }); return;
      }
      if (message.method === "notifications/cancelled") { if (entry.session?.approvalRequest === message.params?.requestId) await stop(entry); return; }
      if (message.method === "notifications/initialized") return;
      let result;
      try {
        if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "omnirush-computer-use", version: "0.1.0" }, instructions: "Use only the approved app window. Foreground control pauses on person input. Only the person can approve or Continue. Observe after every action; never retry partial input automatically. For Blender background work prefer its Python CLI or an app connector." };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools };
        else {
          const name = message.params?.name, args = message.params?.arguments ?? {};
          if (entry.busy && !["computer_session_status", "computer_close_session"].includes(name)) result = content(failure("busy", "Wait for the previous operation."));
          else {
            const ownsBusy = !["computer_session_status", "computer_close_session"].includes(name);
            if (ownsBusy) entry.busy = true;
            try { result = await call(entry, name, args, message.id); }
            finally { if (ownsBusy) entry.busy = false; }
          }
        }
        if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) { if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: content(failure(error.code ?? "desktop_error", error.message)) }); }
    };
    socket.on("data", (chunk) => {
      incoming += chunk;
      if (incoming.length > 1_048_576) { socket.destroy(); return; }
      let end;
      while ((end = incoming.indexOf("\n")) >= 0) {
        const line = incoming.slice(0, end); incoming = incoming.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { socket.destroy(); return; }
        if (!authenticated) {
          const candidate = typeof message.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
          if (candidate.length !== token.length || !timingSafeEqual(candidate, Buffer.from(token))) { socket.destroy(); return; }
          authenticated = true; clearTimeout(authTimer); continue;
        }
        void respond(message);
      }
    });
  });
  async function active(entry, id) {
    const value = entry.session;
    if (!value || value.id !== id || value.phase === "approval") return null;
    if (Date.now() >= value.expiresAt) { await stop(entry); return null; }
    if (Date.now() - value.lastOperation > 120_000 && value.phase === "working") pause(entry, "Paused after two minutes without work. Choose Continue when ready.");
    return value;
  }
  async function observation(entry, value, includeImage) {
    if (value.phase !== "working") return content(failure("session_paused", value.status, { next: "human_takeover" }));
    const before = await native.call("state");
    const window = await native.call("window", { id: value.window.id });
    if (window.identity !== value.window.identity) { await stop(entry); return content(failure("window_unavailable", "The approved app closed or restarted. Start a new session.")); }
    let captured = await captureWindow(window);
    let stable = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const next = await captureWindow(window);
      if (digest(next.image) === digest(captured.image)) { captured = next; stable = true; break; }
      captured = next;
    }
    if (!stable) return content(failure("window_changing", "Wait for the app to finish updating, then observe again."));

    const after = await native.call("state");
    if (entry.session !== value || value.phase !== "working" || before.generation !== after.generation || !after.available) { pause(entry, "Desktop input or availability changed. Choose Continue when ready."); return content(failure("session_paused", "Observe after the person continues.")); }
    const id = randomUUID();
    value.window = window; value.lastOperation = Date.now();
    value.observation = { id, time: Date.now(), generation: after.generation, window, size: captured.size, hash: digest(captured.image) };
    preview?.image(captured.image);
    update();
    return content({ ok: true, session_id: value.id, observation_id: id, window_title: window.title, image_size: captured.size, window_bounds: window.bounds, coordinates: "screenshot pixels relative to the approved window", elements: [], modes, requires_visual_model: true }, includeImage ? captured.image : undefined);
  }
  async function call(entry, name, args, requestId) {
    if (!tools.some((item) => item.name === name)) return content(failure("unknown_tool", "Unknown Computer Use tool."));
    if (!availability.supported) return content(failure(availability.code ?? "desktop_unavailable", availability.error));
    if (name === "computer_discover") {
      const windows = await native.call("list");
      const apps = new Map();
      for (const window of windows) apps.set(window.pid, { app_id: window.appId, pid: window.pid, name: window.appName });
      return content({ ok: true, modes, background_control: false, apps: [...apps.values()] });
    }
    if (name === "computer_open_session") {
      if (!modes.includes(args.mode ?? "observe")) return content(failure("unsupported_mode", "This platform supports read-only observation or foreground mouse and keyboard control."));
      if (typeof args.app_id !== "string" || typeof args.purpose !== "string" || !args.purpose.trim() || args.purpose.length > 500) return content(failure("invalid_request", "Name a running app and describe the task in up to 500 characters."));
      if (lease) return content(failure("session_busy", "Another Computer Use request is active. End it first."));
      lease = entry.id;
      try {
        const windows = (await native.call("list")).filter((window) => window.appId === args.app_id && (args.pid === undefined || window.pid === args.pid));
        if (!windows.length) { lease = null; return content(failure("app_unavailable", "Open the app yourself, then discover its windows again.")); }
        const value = { id: randomUUID(), window: windows[0], windows, mode: args.mode ?? "observe", purpose: args.purpose, phase: "approval", previewVisible: true, expiresAt: Date.now() + 900_000, lastOperation: Date.now(), attempts: 0, requests: new Set(), observation: null, approvalRequest: requestId };
        entry.session = value;
        const approval = new Promise((resolve) => { value.approval = { resolve }; });
        const timeout = setTimeout(() => { if (entry.session === value) void stop(entry); }, 60_000);
        update();
        try {
          const result = await approval;
          if (result.ok !== true) return content(result);
          return content({ ok: true, session_id: value.id, state: "active", app_id: value.window.appId, pid: value.window.pid, mode: value.mode, window_title: value.window.title, expires_in_seconds: 900, background_control: false });
        } finally { clearTimeout(timeout); value.approval = null; }
      } catch (error) { if (lease === entry.id) lease = null; throw error; }
    }
    const value = await active(entry, args.session_id);
    if (!value) return content(failure("session_unavailable", "This session has ended or belongs to another client."));
    if (name === "computer_close_session") { await stop(entry); return content({ ok: true }); }
    if (name === "computer_session_status") return content({ ok: true, session_id: value.id, state: value.phase === "working" ? "active" : "paused", phase: value.phase, mode: value.mode, background_control: false, panel_visible: value.previewVisible, remaining_seconds: Math.max(0, Math.ceil((value.expiresAt - Date.now()) / 1000)), message: value.status });
    if (name === "computer_observe") return observation(entry, value, args.include_image !== false);
    if (value.mode !== "control") return content(failure("scope_denied", "This session is read-only."));
    if (value.phase !== "working") return content(failure("session_paused", value.status, { next: "human_takeover" }));
    if (++value.attempts > 200) { await stop(entry); return content(failure("action_limit", "Start a new session after 200 action attempts.")); }
    const observed = value.observation; value.observation = null;
    if (typeof args.request_id !== "string" || !args.request_id || args.request_id.length > 100 || value.requests.has(args.request_id)) return content(failure("duplicate_request", "Use a unique request ID. Observe the current state instead of repeating input."));
    value.requests.add(args.request_id);
    if (!observed || observed.id !== args.observation_id || Date.now() - observed.time > 15_000) return content(failure("stale_observation", "Observe the window again before acting.", { may_have_acted: false }));
    try { validateAction(args.action, observed.size); } catch (error) { return content(failure("invalid_action", error.message, { may_have_acted: false })); }
    const current = await native.call("window", { id: value.window.id });
    if (current.identity !== observed.window.identity || !sameBounds(current.bounds, observed.window.bounds)) return content(failure("window_changed", "The window moved or changed. Observe again.", { may_have_acted: false }));
    try { await native.call("check", { window: current, generation: observed.generation, deadline: value.expiresAt }); }
    catch (error) { pause(entry, error.message); return content(failure(error.code ?? "input_interrupted", error.message, { may_have_acted: false, next: "human_takeover" })); }
    const fresh = await captureWindow(current);
    if (digest(fresh.image) !== observed.hash) return content(failure("stale_observation", "The window changed. Observe again.", { may_have_acted: false }));
    if (entry.session !== value || value.phase !== "working") return content(failure("session_paused", "The session was interrupted.", { may_have_acted: false }));
    const scale = (p) => ({ ...p, x: Math.min(current.bounds.width - 1, Math.floor(p.x * current.bounds.width / observed.size.width)), y: Math.min(current.bounds.height - 1, Math.floor(p.y * current.bounds.height / observed.size.height)) });
    const action = args.action.type === "drag" ? { ...args.action, path: args.action.path.map(scale) } : ["click", "double_click", "scroll"].includes(args.action.type) ? scale(args.action) : args.action;
    try {
      await native.call("act", { window: current, generation: observed.generation, action, deadline: value.expiresAt });
      value.lastOperation = Date.now();
      return content({ ok: true, session_id: value.id, request_id: args.request_id, dispatched: true, next: "observe" });
    } catch (error) {
      pause(entry, error.message);
      return content(failure(error.code ?? "input_interrupted", error.message, { may_have_acted: true, next: "human_takeover" }));
    }
  }
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Computer Use could not create its local connection.");
  const endpoint = { version: 1, host: "127.0.0.1", port: address.port, token };
  const temp = discoveryPath + "." + randomUUID();
  await writeFile(temp, JSON.stringify(endpoint), { mode: 0o600, flag: "wx" });
  await rename(temp, discoveryPath);
  const expiry = setInterval(() => { for (const entry of connections.values()) { const value = entry.session; if (!value) continue; if (Date.now() >= value.expiresAt) void stop(entry); else if (value.phase === "working" && Date.now() - value.lastOperation > 120_000) pause(entry, "Paused after two minutes without work. Choose Continue when ready."); } update(); }, 1000);
  const host = {
    discoveryPath, state, availability,
    pause(connectionId) { const entry = connections.get(connectionId); if (entry) pause(entry, "You took over. Choose Continue in OmniRush.ai when ready."); },
    async apps() { if (!availability.supported) return { ok: false, apps: [] }; const windows = await native.call("list"); return { ok: true, apps: [...new Set(windows.map((w) => w.appName))] }; },
    async action(input) {
      const entry = connections.get(input?.connectionId), value = entry?.session;
      if (!value || value.id !== input.id || !["approve", "deny", "resume", "stop", "hide", "show"].includes(input.action)) throw new Error("This Computer Use request has ended.");
      if (input.action === "stop" || input.action === "deny") return stop(entry);
      if (input.action === "hide") { value.previewVisible = false; update(); return; }
      if (input.action === "show") { value.previewVisible = true; update(); return; }
      if ((input.action === "approve" && value.phase !== "approval") || (input.action === "resume" && value.phase !== "paused")) throw new Error("This action is unavailable.");
      const selected = input.action === "approve" ? value.windows.find((w) => w.id === input.windowId) : value.window;
      if (!selected) throw new Error("Choose a window.");
      const current = await native.call("window", { id: selected.id });
      if (current.identity !== selected.identity) { await stop(entry); throw new Error("The app restarted. Start a new session."); }
      if (value.mode === "control") {
        native.grantForeground?.();
        await native.call("focus", { window: current });
      }
      await native.call("start");
      if (entry.session !== value) throw new Error("The request ended.");
      value.window = current; value.phase = "working"; value.status = ""; value.lastOperation = Date.now(); value.observation = null;
      if (input.action === "approve") value.expiresAt = Date.now() + 900_000;
      value.approval?.resolve({ ok: true }); update();
    },
    async close() { if (closed) return; closed = true; clearInterval(expiry); for (const entry of connections.values()) { await stop(entry); entry.socket.destroy(); } server.close(); preview?.close(); await native.close(); await unlink(discoveryPath).catch(() => {}); },
  };
  preview?.bind(host);
  return host;
}
