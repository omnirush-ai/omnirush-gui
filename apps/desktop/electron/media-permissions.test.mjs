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
