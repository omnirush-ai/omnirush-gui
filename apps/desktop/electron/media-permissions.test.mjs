import assert from "node:assert/strict";
import test from "node:test";

import { configureFakeMediaForTests, displayAudioAnswer, isBrowserPanelPermissionAllowed, shouldAllowMainWindowPermission } from "./media-permissions.mjs";

function fakeApp() {
  const switches = [];
  return { switches, commandLine: { appendSwitch: (...args) => switches.push(args) } };
}

test("no test switches without the flags", () => {
  const app = fakeApp();
  configureFakeMediaForTests(app, false, {});
  assert.deepEqual(app.switches, []);
});

test("OMNIRUSH_ELECTRON_FAKE_MEDIA gives a fake device only", () => {
  const app = fakeApp();
  configureFakeMediaForTests(app, true, {});
  assert.deepEqual(app.switches, [["use-fake-device-for-media-stream"]]);
});

test("OMNIRUSH_VOICE_INPUT_FILE plays the WAV once through the fake microphone", () => {
  const app = fakeApp();
  configureFakeMediaForTests(app, false, { OMNIRUSH_VOICE_INPUT_FILE: " /tmp/clip.wav " });
  assert.deepEqual(app.switches, [
    ["use-fake-device-for-media-stream"],
    ["use-fake-ui-for-media-stream"],
    ["use-file-for-fake-audio-capture", "/tmp/clip.wav%noloop"],
  ]);
});

test("the built-in browser grants only page-local permissions", () => {
  for (const permission of ["media", "geolocation", "notifications", "display-capture", "clipboard-read", "midiSysex", "openExternal", "unknown"]) {
    assert.equal(isBrowserPanelPermissionAllowed(permission), false, permission);
  }
  for (const permission of ["fullscreen", "clipboard-sanitized-write", "pointerLock"]) {
    assert.equal(isBrowserPanelPermissionAllowed(permission), true, permission);
  }
});

test("system audio: only the app's own window gets its frame as video and loopback audio", () => {
  const frame = { processId: 4, routingId: 1 };
  const mainWindow = { webContents: { mainFrame: { processId: 4, routingId: 1 } } };
  const request = (overrides) => ({ frame, securityOrigin: "http://127.0.0.1:5173", videoRequested: true, audioRequested: true, ...overrides });
  assert.deepEqual(displayAudioAnswer(request({}), mainWindow), { video: frame, audio: "loopback" });
  assert.deepEqual(displayAudioAnswer(request({ securityOrigin: "file://" }), mainWindow), { video: frame, audio: "loopback" });
  assert.deepEqual(displayAudioAnswer(request({ securityOrigin: "https://example.com" }), mainWindow), {});
  assert.deepEqual(displayAudioAnswer(request({ frame: { processId: 9, routingId: 1 } }), mainWindow), {});
  assert.deepEqual(displayAudioAnswer(request({ frame: null }), mainWindow), {});
  assert.deepEqual(displayAudioAnswer(request({}), null), {});
});

test("the app's window may ask for the microphone and for display media (no device types), never the camera", () => {
  const mainWindow = { webContents: { id: 1 } };
  const ask = (details, extra = {}) => shouldAllowMainWindowPermission({ webContents: { id: 1 }, permission: "media", origin: "http://localhost:5173", details, mainWindow, request: true, ...extra });
  assert.equal(ask({ mediaTypes: ["audio"] }), true);
  assert.equal(ask({ mediaTypes: [], isMainFrame: true }), true);
  // A subframe (an MCP app's sandbox iframe) asking with no device types could be legacy desktop getUserMedia.
  assert.equal(ask({ mediaTypes: [], isMainFrame: false }), false);
  assert.equal(ask({ mediaTypes: [] }), false);
  assert.equal(ask({ mediaTypes: ["video"] }), false);
  assert.equal(ask({ mediaTypes: ["audio", "video"] }), false);
  assert.equal(ask({ mediaTypes: [], isMainFrame: true }, { request: false }), false);
  assert.equal(ask({ mediaTypes: [], isMainFrame: true }, { webContents: { id: 2 } }), false);
  assert.equal(ask({ mediaTypes: [], isMainFrame: true }, { origin: "https://example.com" }), false);
});

// Calls and alerts in the built-in browser (Work).

const { mkdtempSync, statSync, writeFileSync: writeText, rmSync: removePath } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const {
  checkedSiteKinds,
  createSitePermissionStore,
  createSitePermissions,
  installBrowserPanelPermissionHandlers,
  requestedSiteKinds,
  sitePermissionOrigin,
  USER_TAB_OWNER,
} = await import("./media-permissions.mjs");

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "site-permissions-"));
  t.after(() => removePath(dir, { recursive: true, force: true }));
  return join(dir, "browser-site-permissions.json");
}

/** A tab's web contents: its page URL and a stable id. */
function contents(id, url) {
  return { id, url, getURL() { return this.url; } };
}

/**
 * The policy with a fake browser: tab ids by contents id, `user` tabs are the person's own (USER_TAB_OWNER), the
 * rest belong to a conversation. `shown` records every question put on screen.
 * @param {{ enabled?: boolean, systemAccess?: (kinds: string[]) => Promise<boolean>, filePath?: string | null }} [options]
 */
function harness({ enabled = true, systemAccess = undefined, filePath = null } = {}) {
  const state = { enabled };
  const tabs = new Map();
  const shown = [];
  let changes = 0;
  const store = createSitePermissionStore({ filePath, now: () => 1_000 });
  const policy = createSitePermissions({
    store,
    enabled: () => state.enabled,
    tabFor: (webContents) => tabs.get(webContents.id) ?? null,
    contentsForFrame: (frame) => frame.contents,
    show: (tabId, prompt) => shown.push({ tabId, prompt }),
    ...(systemAccess ? { systemAccess } : {}),
    onChange: () => { changes += 1; },
  });
  const addTab = (id, url, owner) => {
    tabs.set(id, { tabId: `tab-${id}`, user: owner === USER_TAB_OWNER });
    return contents(id, url);
  };
  const lastPrompt = (tabId) => shown.filter((entry) => entry.tabId === tabId).at(-1)?.prompt ?? null;
  return { state, policy, store, shown, addTab, lastPrompt, changes: () => changes };
}

const flushTurns = () => new Promise((resolve) => setImmediate(resolve));

test("call and alert requests are told apart: camera and microphone by device type, a request with none is a screen", () => {
  assert.deepEqual(requestedSiteKinds("media", { mediaTypes: ["video", "audio"] }), ["camera", "microphone"]);
  assert.deepEqual(requestedSiteKinds("media", { mediaTypes: ["audio"] }), ["microphone"]);
  assert.deepEqual(requestedSiteKinds("media", { mediaTypes: ["video"] }), ["camera"]);
  assert.deepEqual(requestedSiteKinds("media", { mediaTypes: [] }), ["screen"]);
  assert.deepEqual(requestedSiteKinds("media", {}), ["screen"]);
  assert.deepEqual(requestedSiteKinds("media", { mediaTypes: ["video", "lidar"] }), []);
  assert.deepEqual(requestedSiteKinds("notifications", {}), ["notifications"]);
  for (const permission of ["geolocation", "clipboard-read", "openExternal", "fullscreen", "display-capture", "midiSysex"]) {
    assert.equal(requestedSiteKinds(permission, {}), null, permission);
  }
  assert.deepEqual(checkedSiteKinds("media", { mediaType: "video" }), ["camera"]);
  assert.deepEqual(checkedSiteKinds("media", { mediaType: "audio" }), ["microphone"]);
  assert.deepEqual(checkedSiteKinds("media", {}), ["camera", "microphone"]);
  assert.deepEqual(checkedSiteKinds("notifications", {}), ["notifications"]);
  assert.equal(checkedSiteKinds("geolocation", {}), null);
});

test("only https sites, and http on this computer, can ever be asked", () => {
  assert.equal(sitePermissionOrigin("https://meet.google.com/abc-defg-hij?authuser=0"), "https://meet.google.com");
  assert.equal(sitePermissionOrigin("https://meet.google.com/"), "https://meet.google.com");
  assert.equal(sitePermissionOrigin("http://localhost:8080/call"), "http://localhost:8080");
  assert.equal(sitePermissionOrigin("http://127.0.0.1/"), "http://127.0.0.1");
  for (const value of ["http://example.com/", "file:///tmp/a.html", "data:text/html,x", "about:blank", "", null, "not a url"]) {
    assert.equal(sitePermissionOrigin(value), null, String(value));
  }
});

test("choices are kept per site in an owner-only file, newest first, and survive a restart", (t) => {
  const filePath = tempFile(t);
  let clock = 10;
  const store = createSitePermissionStore({ filePath, now: () => clock });
  assert.equal(store.decision("https://meet.google.com", "camera"), null);
  store.remember("https://meet.google.com", ["camera", "microphone"], "allow");
  clock = 20;
  store.remember("https://app.slack.com", ["notifications"], "block");
  clock = 30;
  store.remember("https://meet.google.com", ["notifications"], "block");
  store.remember("http://example.com", ["camera"], "allow");
  store.remember("https://ignored.example", ["geolocation"], "allow");
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);

  const again = createSitePermissionStore({ filePath });
  assert.deepEqual(again.list().map((entry) => entry.origin), ["https://meet.google.com", "https://app.slack.com"]);
  assert.deepEqual(again.list()[0], { origin: "https://meet.google.com", camera: "allow", microphone: "allow", notifications: "block", at: 30 });
  assert.equal(again.decision("https://app.slack.com", "notifications"), "block");
  assert.equal(again.decision("https://app.slack.com", "camera"), null);
  assert.equal(again.forget("https://app.slack.com"), true);
  assert.equal(again.forget("https://app.slack.com"), false);
  assert.deepEqual(createSitePermissionStore({ filePath }).list().map((entry) => entry.origin), ["https://meet.google.com"]);
  again.clear();
  assert.throws(() => statSync(filePath), /ENOENT/);
});

test("a damaged or foreign file means nothing is remembered, and the oldest sites go past the limit", (t) => {
  const filePath = tempFile(t);
  writeText(filePath, "{ not json");
  assert.deepEqual(createSitePermissionStore({ filePath }).list(), []);
  writeText(filePath, JSON.stringify({ sites: [
    { origin: "https://ok.example", camera: "allow", at: 1 },
    { origin: "https://ok.example/path", camera: "allow" },
    { origin: "http://plain.example", camera: "allow" },
    { origin: "https://odd.example", camera: "always" },
  ] }));
  assert.deepEqual(createSitePermissionStore({ filePath }).list().map((entry) => entry.origin), ["https://ok.example"]);

  let clock = 0;
  const small = createSitePermissionStore({ filePath: tempFile(t), now: () => ++clock, limit: 2 });
  small.remember("https://one.example", ["camera"], "allow");
  small.remember("https://two.example", ["camera"], "allow");
  small.remember("https://one.example", ["microphone"], "allow");
  small.remember("https://three.example", ["camera"], "allow");
  assert.deepEqual(small.list().map((entry) => entry.origin), ["https://three.example", "https://one.example"]);
});

test("an agent's tab never gets a camera, even for a site the person allowed in their own tab", async () => {
  const { policy, store, shown, addTab } = harness();
  store.remember("https://meet.google.com", ["camera", "microphone", "notifications"], "allow");
  const agentTab = addTab(2, "https://meet.google.com/abc", "ses_chat");
  assert.equal(await policy.request(agentTab, "media", { mediaTypes: ["video", "audio"], requestingUrl: "https://meet.google.com/abc" }), false);
  assert.equal(await policy.request(agentTab, "notifications", { requestingUrl: "https://meet.google.com/abc" }), false);
  assert.equal(policy.check(agentTab, "media", "https://meet.google.com/", { mediaType: "video" }), false);
  assert.equal(policy.check(agentTab, "notifications", "https://meet.google.com/", {}), false);
  assert.equal(policy.frameState(agentTab, "https://meet.google.com"), null);
  assert.equal(policy.noteScreenIntent(agentTab, "https://meet.google.com"), false);
  assert.deepEqual(shown, []);

  const userTab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  assert.equal(await policy.request(userTab, "media", { mediaTypes: ["video", "audio"], requestingUrl: "https://meet.google.com/abc" }), true);
  assert.equal(policy.check(userTab, "media", "https://meet.google.com/", { mediaType: "video" }), true);
});

test("without Work every call and alert stays denied and nothing is asked", async () => {
  const { policy, state, store, shown, addTab } = harness({ enabled: false });
  store.remember("https://meet.google.com", ["camera"], "allow");
  const tab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  assert.equal(await policy.request(tab, "media", { mediaTypes: ["video"], requestingUrl: "https://meet.google.com/abc" }), false);
  assert.equal(policy.check(tab, "media", "https://meet.google.com/", { mediaType: "video" }), false);
  assert.equal(policy.check(null, "notifications", "https://meet.google.com/", {}), false);
  assert.equal(policy.frameState(tab, "https://meet.google.com"), null);
  assert.deepEqual(shown, []);
  state.enabled = true;
  assert.equal(policy.check(tab, "media", "https://meet.google.com/", { mediaType: "video" }), true);
});

test("the person's own tab asks once per site: Allow and Block are remembered, a dismissed question asks again", async () => {
  const { policy, store, addTab, lastPrompt, changes } = harness();
  const tab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  const ask = () => policy.request(tab, "media", { mediaTypes: ["video", "audio"], requestingUrl: "https://meet.google.com/abc" });

  assert.deepEqual(policy.frameState(tab, "https://meet.google.com"), { camera: "ask", microphone: "ask", notifications: "ask" });
  assert.equal(policy.check(tab, "media", "https://meet.google.com/", {}), false);

  let pending = ask();
  await flushTurns();
  const first = lastPrompt("tab-1");
  assert.deepEqual({ ...first, id: "x" }, { id: "x", origin: "https://meet.google.com", kinds: ["camera", "microphone"] });
  assert.equal(policy.answer("tab-1", "stale", "allow"), false, "a stale answer is ignored");
  assert.equal(policy.answer("tab-1", first.id, "dismiss"), true);
  assert.equal(await pending, false);
  assert.equal(lastPrompt("tab-1"), null, "the bar goes away");
  assert.equal(store.decision("https://meet.google.com", "camera"), null, "a dismissed question is not remembered");
  assert.equal(changes(), 0);

  pending = ask();
  await flushTurns();
  policy.answer("tab-1", lastPrompt("tab-1").id, "allow");
  assert.equal(await pending, true);
  assert.equal(changes(), 1);
  assert.equal(await ask(), true, "remembered: no second question");
  assert.equal(policy.check(tab, "media", "https://meet.google.com/", {}), true);
  assert.equal(policy.check(tab, "media", "https://meet.google.com/", { mediaType: "audio" }), true);
  assert.deepEqual(policy.frameState(tab, "https://meet.google.com"), { camera: "allow", microphone: "allow", notifications: "ask" });

  pending = policy.request(tab, "notifications", { requestingUrl: "https://meet.google.com/abc" });
  await flushTurns();
  assert.deepEqual(lastPrompt("tab-1").kinds, ["notifications"]);
  policy.answer("tab-1", lastPrompt("tab-1").id, "block");
  assert.equal(await pending, false);
  assert.equal(await policy.request(tab, "notifications", { requestingUrl: "https://meet.google.com/abc" }), false, "blocked: asked no more");
  assert.equal(policy.check(tab, "notifications", "https://meet.google.com/", {}), false);
  assert.deepEqual(policy.frameState(tab, "https://meet.google.com"), { camera: "allow", microphone: "allow", notifications: "block" });

  assert.equal(policy.forget("https://meet.google.com"), true);
  assert.deepEqual(policy.frameState(tab, "https://meet.google.com"), { camera: "ask", microphone: "ask", notifications: "ask" });
});

test("only the page's own site may ask: another site's frame, an http page and a mismatched origin are refused", async () => {
  const { policy, shown, addTab } = harness();
  const tab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  assert.equal(await policy.request(tab, "media", { mediaTypes: ["video"], requestingUrl: "https://ads.example/frame" }), false);
  assert.equal(policy.check(tab, "media", "https://ads.example/", { mediaType: "video" }), false);
  assert.equal(policy.frameState(tab, "https://ads.example"), null);
  const plain = addTab(3, "http://intranet.example/", USER_TAB_OWNER);
  assert.equal(await policy.request(plain, "media", { mediaTypes: ["video"], requestingUrl: "http://intranet.example/" }), false);
  assert.deepEqual(shown, []);
  // A same-site frame asks for its page.
  const pending = policy.request(tab, "media", { mediaTypes: ["audio"], requestingUrl: "https://meet.google.com/frame.html" });
  await flushTurns();
  assert.deepEqual(shown.at(-1).prompt.kinds, ["microphone"]);
  policy.cancelTab("tab-1");
  assert.equal(await pending, false);
});

test("questions come one at a time per tab, and an answer covers the ones waiting behind it", async () => {
  const { policy, shown, addTab } = harness();
  const tab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  const camera = policy.request(tab, "media", { mediaTypes: ["video"], requestingUrl: "https://meet.google.com/abc" });
  const both = policy.request(tab, "media", { mediaTypes: ["video", "audio"], requestingUrl: "https://meet.google.com/abc" });
  const again = policy.request(tab, "media", { mediaTypes: ["video"], requestingUrl: "https://meet.google.com/abc" });
  await flushTurns();
  assert.equal(shown.filter((entry) => entry.prompt).length, 1, "one question on screen");
  policy.answer("tab-1", shown.at(-1).prompt.id, "allow");
  assert.equal(await camera, true);
  await flushTurns();
  // The camera is settled; only the microphone is left to ask, and the repeat camera request needs no question.
  assert.deepEqual(shown.at(-1).prompt.kinds, ["microphone"]);
  policy.answer("tab-1", shown.at(-1).prompt.id, "allow");
  assert.equal(await both, true);
  assert.equal(await again, true);
  assert.equal(shown.at(-1).prompt, null);
});

test("closing or leaving the page answers its questions with no", async () => {
  const { policy, addTab, lastPrompt } = harness();
  const tab = addTab(1, "https://app.slack.com/client", USER_TAB_OWNER);
  const first = policy.request(tab, "notifications", { requestingUrl: "https://app.slack.com/client" });
  const second = policy.request(tab, "media", { mediaTypes: ["audio"], requestingUrl: "https://app.slack.com/client" });
  await flushTurns();
  assert.ok(lastPrompt("tab-1"));
  policy.cancelTab("tab-1");
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(lastPrompt("tab-1"), null);
  const later = policy.request(tab, "notifications", { requestingUrl: "https://app.slack.com/client" });
  await flushTurns();
  policy.cancelAll();
  assert.equal(await later, false);
});

test("an unanswered question times out as no", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tabs = new Map([[1, { tabId: "tab-1", user: true }]]);
  const shown = [];
  const policy = createSitePermissions({
    store: createSitePermissionStore({ filePath: null }),
    enabled: () => true,
    tabFor: (webContents) => tabs.get(webContents.id) ?? null,
    show: (tabId, prompt) => shown.push(prompt),
    timeoutMs: 5_000,
  });
  const pending = policy.request(contents(1, "https://meet.google.com/x"), "media", { mediaTypes: ["video"], requestingUrl: "https://meet.google.com/x" });
  await flushTurns();
  t.mock.timers.tick(5_000);
  assert.equal(await pending, false);
  assert.equal(shown.at(-1), null);
});

test("screen sharing: only right after getDisplayMedia, never remembered, and the page gets exactly the picked source once", async () => {
  const { policy, store, addTab, lastPrompt } = harness();
  const tab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  const screenRequest = () => policy.request(tab, "media", { mediaTypes: [], requestingUrl: "https://meet.google.com/abc" });
  const frame = { contents: tab };

  // The old chromeMediaSource constraint arrives the same way but without the page-world notice: refused, no picker.
  assert.equal(await screenRequest(), false);
  assert.equal(lastPrompt("tab-1"), null);
  assert.deepEqual(policy.displayMedia({ frame, securityOrigin: "https://meet.google.com/" }), {});

  assert.equal(policy.noteScreenIntent(tab, "https://meet.google.com"), true);
  let pending = screenRequest();
  await flushTurns();
  assert.deepEqual(lastPrompt("tab-1").kinds, ["screen"]);
  policy.answer("tab-1", lastPrompt("tab-1").id, "dismiss");
  assert.equal(await pending, false, "Cancel shares nothing");
  assert.equal(await screenRequest(), false, "the notice is used once");

  policy.noteScreenIntent(tab, "https://meet.google.com");
  pending = screenRequest();
  await flushTurns();
  assert.equal(policy.answer("tab-1", lastPrompt("tab-1").id, "allow"), true);
  assert.equal(await pending, false, "a screen needs a picked source");

  policy.noteScreenIntent(tab, "https://meet.google.com");
  pending = screenRequest();
  await flushTurns();
  policy.answer("tab-1", lastPrompt("tab-1").id, { share: { id: "window:42:0", name: "Quarterly plan" } });
  assert.equal(await pending, true);
  assert.deepEqual(policy.displayMedia({ frame: { contents: addTab(9, "https://meet.google.com/abc", USER_TAB_OWNER) }, securityOrigin: "https://meet.google.com/" }), {}, "another tab gets nothing");
  assert.deepEqual(policy.displayMedia({ frame, securityOrigin: "https://evil.example/" }), {}, "another site gets nothing");
  assert.deepEqual(store.list(), [], "screen choices are never remembered");

  policy.noteScreenIntent(tab, "https://meet.google.com");
  pending = screenRequest();
  await flushTurns();
  policy.answer("tab-1", lastPrompt("tab-1").id, { share: { id: "screen:1:0", name: "Entire screen" } });
  assert.equal(await pending, true);
  assert.deepEqual(policy.displayMedia({ frame, securityOrigin: "https://meet.google.com/" }), { video: { id: "screen:1:0", name: "Entire screen" } });
  assert.deepEqual(policy.displayMedia({ frame, securityOrigin: "https://meet.google.com/" }), {}, "used once");
});

test("a site's service worker may show notifications only when the person allowed that site", () => {
  const { policy, store } = harness();
  assert.equal(policy.check(null, "notifications", "https://app.slack.com/", {}), false);
  store.remember("https://app.slack.com", ["notifications"], "allow");
  assert.equal(policy.check(null, "notifications", "https://app.slack.com/", {}), true);
  store.remember("https://app.slack.com", ["camera"], "allow");
  assert.equal(policy.check(null, "media", "https://app.slack.com/", { mediaType: "video" }), false, "a worker never gets a camera");
});

test("when the computer blocks the app's camera the page is refused and the bar says where to turn it on, once", async () => {
  const asked = [];
  const { policy, store, addTab, shown } = harness({ systemAccess: async (kinds) => { asked.push(kinds); return false; } });
  store.remember("https://meet.google.com", ["camera", "microphone"], "allow");
  const tab = addTab(1, "https://meet.google.com/abc", USER_TAB_OWNER);
  const request = () => policy.request(tab, "media", { mediaTypes: ["video", "audio"], requestingUrl: "https://meet.google.com/abc" });
  assert.equal(await request(), false);
  assert.equal(await request(), false);
  assert.deepEqual(asked, [["camera", "microphone"], ["camera", "microphone"]]);
  const notices = shown.filter((entry) => entry.prompt?.system);
  assert.equal(notices.length, 1);
  assert.deepEqual({ ...notices[0].prompt, id: "x" }, { id: "x", origin: "https://meet.google.com", kinds: ["camera", "microphone"], system: true });
  policy.answer("tab-1", notices[0].prompt.id, "allow");
  assert.equal(store.decision("https://meet.google.com", "camera"), "allow", "the notice changes no choice");
});

test("the browser session sends calls and alerts to the policy and keeps every other permission as before", async () => {
  /** @type {any} */
  const session = { setPermissionRequestHandler(handler) { this.request = handler; }, setPermissionCheckHandler(handler) { this.check = handler; }, setDisplayMediaRequestHandler(handler) { this.display = handler; } };
  const calls = [];
  /** @type {any} */
  const sitePermissions = {
    request: async (...args) => { calls.push(["request", args[1]]); return true; },
    check: (...args) => { calls.push(["check", args[1]]); return true; },
    displayMedia: () => ({ video: { id: "screen:1:0", name: "Screen" } }),
  };
  installBrowserPanelPermissionHandlers(session, { confirmExternal: async () => false, sitePermissions });
  const answer = (permission, details = {}) => new Promise((resolve) => session.request({ getURL: () => "https://x.example/" }, permission, resolve, details));
  assert.equal(await answer("media", { mediaTypes: ["video"] }), true);
  assert.equal(await answer("notifications"), true);
  assert.equal(await answer("geolocation"), false);
  assert.equal(await answer("fullscreen"), true);
  assert.equal(session.check(null, "media", "https://x.example/", { mediaType: "video" }), true);
  assert.equal(session.check(null, "geolocation", "https://x.example/", {}), false);
  assert.deepEqual(calls, [["request", "media"], ["request", "notifications"], ["check", "media"]]);
  assert.deepEqual(await new Promise((resolve) => session.display({ frame: {} }, resolve)), { video: { id: "screen:1:0", name: "Screen" } });

  // Without the policy (and for consumers, whose policy is off) calls and alerts stay denied.
  /** @type {any} */
  const plain = { setPermissionRequestHandler(handler) { this.request = handler; }, setPermissionCheckHandler(handler) { this.check = handler; }, setDisplayMediaRequestHandler(handler) { this.display = handler; } };
  installBrowserPanelPermissionHandlers(plain, { confirmExternal: async () => false });
  /** @type {Array<[string, object]>} */
  const denied = [["media", { mediaTypes: ["video"] }], ["media", { mediaTypes: [] }], ["notifications", {}]];
  for (const [permission, details] of denied) {
    assert.equal(await new Promise((resolve) => plain.request({}, permission, resolve, details)), false, permission);
  }
  assert.equal(plain.check(null, "notifications", "https://x.example/", {}), false);
  assert.deepEqual(await new Promise((resolve) => plain.display({ frame: {} }, resolve)), {});
});
