import assert from "node:assert/strict";
import test from "node:test";

import { configureFakeMediaForTests } from "./media-permissions.mjs";

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
