// Sponsored placements: the shared module (./placements/placements.mjs, the same
// file in the CLI, PARITY.sha256) and the main process's side
// (placements-desktop.mjs, the account store's placementsRequest). The CLI's
// test/placements.test.js covers the same rules with its own launcher.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  clampText,
  createPlacements,
  FETCH_TIMEOUT_MS,
  httpsOnly,
  LIMITS,
  MIN_REFRESH_S,
  parseAnswer,
  parsePlacement,
  placementsQuery,
} from "./placements/placements.mjs";
import { createDesktopPlacements, desktopPlacementsAllowed, WINDOW_STATE_CHANNEL, watchWindowForPlacements } from "./placements-desktop.mjs";
import { createDesktopOmniRushAccountStore } from "./omnirush-account.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-18T09:00:00");

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `placements-${name}-`));
}

function placement(over = {}) {
  return {
    id: "plc_abc",
    slot: "home_banner",
    sponsor: "Acme",
    label: "Sponsored",
    title: "Fast CI for your repo",
    body: "Run your tests in half the time.",
    cta_label: "Try it",
    url: "https://acme.example/ci",
    image_url: null,
    starts_at: "2026-10-01T00:00:00Z",
    ends_at: "2026-11-01T00:00:00Z",
    max_per_day: 1,
    snooze_days: 7,
    priority: 0,
    ...over,
  };
}

function answer(list = [placement()], over = {}) {
  return { enabled: true, refresh_after_s: 3600, placements: list, ...over };
}

function desktop({ routes = (/** @type {string} */ _p, /** @type {any} */ _o) => /** @type {any} */ ({ status: 200, data: answer() }), now = () => T0, userDataPath = tmp("desk"), env = {}, opened = [] } = {}) {
  const calls = [];
  const d = createDesktopPlacements({
    request: async (p, o = {}) => {
      calls.push({ path: p, ...o });
      return routes(p, o);
    },
    userDataPath,
    version: "3.5.5",
    platform: "darwin",
    env,
    now,
    openUrl: async (url) => {
      opened.push(url);
      return { ok: true };
    },
  });
  return { d, calls, opened, userDataPath };
}

// --- the shared rules ------------------------------------------------------------------------

test("shared: copy is clamped, single-line and labelled Sponsored", () => {
  const p = parsePlacement(placement({ title: "T".repeat(80), body: `a\nb ${"x".repeat(300)}`, cta_label: "C".repeat(30), label: "Recommended" }));
  assert.equal(Array.from(p.title).length, LIMITS.title);
  assert.equal(Array.from(p.body).length, LIMITS.body);
  assert.equal(Array.from(p.ctaLabel).length, LIMITS.cta_label);
  assert.equal(p.label, "Sponsored");
  assert.equal(clampText("x‮y\u0000z", 10), "x y z");
});

test("shared: https links only", () => {
  for (const bad of ["http://acme.example", "javascript:alert(1)", "file:///x", "https://a:b@acme.example", "data:,x"]) {
    assert.equal(httpsOnly(bad), null, bad);
    assert.equal(parsePlacement(placement({ url: bad })), null, bad);
  }
  assert.equal(parsePlacement(placement({ image_url: "http://x.example/a.png" })).imageUrl, null);
});

test("shared: disabled, empty and malformed answers are off; refresh at least 15 minutes", () => {
  assert.equal(parseAnswer({ enabled: false, placements: [placement()] }).enabled, false);
  assert.equal(parseAnswer(answer([])).enabled, false);
  assert.equal(parseAnswer(answer([/** @type {any} */ ({ id: 1 })])).enabled, false);
  assert.equal(parseAnswer("x"), null);
  assert.equal(parseAnswer(answer(undefined, { refresh_after_s: 1 })).refreshAfterS, MIN_REFRESH_S);
  assert.equal(placementsQuery({ client: "desktop", version: "3.5.5", os: "mac" }), "/client/placements?client=desktop&version=3.5.5&os=mac");
});

test("shared: caps, snooze and expiry", async () => {
  let now = T0;
  const stateFile = path.join(tmp("caps"), "placements.json");
  const make = () => createPlacements({ request: async () => ({ status: 200, data: answer([placement({ snooze_days: 2 })]) }), stateFile, client: "desktop", now: () => now });
  const a = make();
  await a.refresh();
  assert.ok(a.claim("home_banner"));
  const same = make();
  assert.ok(same.claim("home_banner"), "a restart within 30 minutes: the same display");
  same.conversation("ses_new");
  assert.equal(same.claim("home_banner"), null, "a new display is due; max_per_day 1: not again today");
  now = T0 + DAY;
  const b = make();
  await b.refresh();
  assert.ok(b.claim("home_banner"), "the next day");
  assert.ok(b.dismiss("plc_abc"));
  now = T0 + 2 * DAY;
  const c = make();
  await c.refresh();
  assert.equal(c.claim("home_banner"), null, "snoozed");
  now = T0 + 3 * DAY + 1;
  const d = make();
  await d.refresh();
  assert.ok(d.claim("home_banner"), "snooze over");
  now = Date.parse("2026-11-02T00:00:00Z");
  const e = make();
  await e.refresh();
  assert.equal(e.claim("home_banner"), null, "ended");
});

test("shared: one id in both slots: both entries kept, the count shared by id", async () => {
  const both = [placement({ id: "plc_both", slot: "home_banner", max_per_day: 2 }), placement({ id: "plc_both", slot: "turn_footer", title: "Turn copy", max_per_day: 2 })];
  assert.equal(parseAnswer(answer(both)).placements.length, 2);
  const { d } = desktop({ routes: () => ({ status: 200, data: answer(both) }) });
  assert.equal((await d.placement({ slot: "home_banner" })).slot, "home_banner");
  const turn = await d.placement({ slot: "turn_footer", sessionId: "ses_1" });
  assert.equal(turn.slot, "turn_footer");
  assert.equal(turn.title, "Turn copy");
  assert.equal(d.service.state().shown.plc_both.count, 2);
  assert.equal(await d.placement({ slot: "turn_footer", sessionId: "ses_2" }), null, "shared max_per_day");
  assert.deepEqual(await d.action({ id: "plc_both", action: "dismiss" }), { ok: true });
  assert.equal(d.service.current("turn_footer"), null);
});

test("shared: events go to /client/placements/events?client=desktop", async () => {
  const paths = [];
  const { d } = desktop({ routes: (p) => { paths.push(p); return p.startsWith("/client/placements/events") ? { status: 204 } : { status: 200, data: answer() }; } });
  const p = await d.placement({ slot: "home_banner" });
  await d.action({ id: p.id, displayId: p.displayId, action: "rendered" });
  assert.equal(await d.service.flush(), 1);
  assert.equal(paths.at(-1), "/client/placements/events?client=desktop");
});

test("shared: the file is the CLI's (PARITY.sha256)", () => {
  const dir = path.join(here, "placements");
  const rows = fs.readFileSync(path.join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const [hash, name] = row.split(/\s+/);
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"), hash, `${name} changed: port it to the CLI and update PARITY.sha256 in both`);
  }
});

// --- the main process's side --------------------------------------------------------------------

test("desktop: asks with client=desktop and the OS, 2 s timeout, and hands the window a placement", async () => {
  const { d, calls } = desktop();
  const p = await d.placement({ slot: "home_banner" });
  assert.equal(calls[0].path, "/client/placements?client=desktop&version=3.5.5&os=mac");
  assert.equal(calls[0].timeoutMs, FETCH_TIMEOUT_MS);
  assert.deepEqual(Object.keys(p).sort(), ["body", "ctaLabel", "displayId", "domain", "id", "imageUrl", "label", "slot", "snoozeDays", "sponsor", "surface", "title", "url"]);
  assert.equal(p.label, "Sponsored · Acme");
  assert.equal(p.surface, "desktop_home");
  assert.match(p.displayId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // The same display while nothing changed.
  assert.deepEqual(await d.placement({ slot: "home_banner" }), p);
  assert.equal(calls.length, 1, "asked once");
});

test("desktop: the turn line needs a session and shows once per session", async () => {
  const { d } = desktop({ routes: () => ({ status: 200, data: answer([placement({ slot: "turn_footer", max_per_day: 5 })]) }) });
  assert.equal(await d.placement({ slot: "turn_footer" }), null);
  assert.ok(await d.placement({ slot: "turn_footer", sessionId: "ses_1" }));
  assert.equal(await d.placement({ slot: "turn_footer", sessionId: "ses_1" }), null);
  assert.equal(await d.placement({ slot: "popup" }), null);
});

test("desktop: off answers, 404, errors and signed out show nothing; a failed ask is not repeated at once", async () => {
  for (const routes of [() => ({ status: 200, data: { enabled: false } }), () => ({ status: 404 }), () => ({ status: 500 }), () => null, () => { throw new Error("timeout"); }]) {
    const { d, calls } = desktop({ routes });
    assert.equal(await d.placement({ slot: "home_banner" }), null);
    assert.equal(await d.placement({ slot: "home_banner" }), null);
    assert.equal(calls.length, 1);
  }
});

test("desktop: a failed ask at start is not repeated by the window's first look", async () => {
  const { d, calls } = desktop({ routes: () => ({ status: 500 }) });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await d.placement({ slot: "home_banner" }), null);
  assert.equal(calls.length, 1);
  await d.stop();
});

test("desktop: OMNIRUSH_PLACEMENTS=0: never asks", async () => {
  assert.equal(desktopPlacementsAllowed({ OMNIRUSH_PLACEMENTS: "0" }), false);
  assert.equal(desktopPlacementsAllowed({}), true);
  const { d, calls, userDataPath } = desktop({ env: { OMNIRUSH_PLACEMENTS: "0" } });
  d.start();
  assert.equal(await d.placement({ slot: "home_banner" }), null);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(userDataPath, "placements.json")), false);
});

test("desktop: open (the click) opens the placement's own https link; dismiss snoozes; bad input is refused", async () => {
  const { d, opened } = desktop();
  const p = await d.placement({ slot: "home_banner" });
  const displayId = p.displayId;
  assert.deepEqual(await d.action({ displayId, action: "rendered" }), { ok: true });
  assert.deepEqual(await d.action({ displayId, action: "open" }), { ok: true, opened: true });
  assert.deepEqual(opened, ["https://acme.example/ci"]);
  assert.deepEqual(await d.action({ displayId: "other", action: "open" }), { ok: false });
  assert.deepEqual(await d.action({ displayId, action: "navigate" }), { ok: false });
  assert.deepEqual(await d.action({ displayId, action: "dismiss" }), { ok: true });
  assert.equal(await d.placement({ slot: "home_banner" }), null);
  assert.deepEqual(d.service.state().events.map((e) => e.kind), ["rendered", "click", "dismiss"]);
});

test("desktop: why opens only the measurement page; report counts and hides; domain reaches the window", async () => {
  const { d, opened } = desktop();
  const p = await d.placement({ slot: "home_banner" });
  assert.equal(p.domain, "acme.example");
  assert.deepEqual(await d.action({ action: "why", displayId: p.displayId }), { ok: true, opened: true });
  assert.deepEqual(opened, ["https://omnirush.ai/advertise/measurement"]);
  assert.deepEqual(await d.action({ displayId: p.displayId, action: "report" }), { ok: true });
  assert.equal(await d.placement({ slot: "home_banner" }), null);
  assert.deepEqual(d.service.state().events.map((e) => e.kind), ["report", "dismiss"]);
});

test("desktop: viewable once per display, with the exact event shape", async () => {
  const { d } = desktop();
  const p = await d.placement({ slot: "home_banner" });
  assert.deepEqual(await d.action({ displayId: p.displayId, action: "rendered" }), { ok: true });
  assert.deepEqual(await d.action({ displayId: p.displayId, action: "rendered" }), { ok: false }, "once");
  assert.deepEqual(await d.action({ displayId: p.displayId, action: "viewable" }), { ok: true });
  assert.deepEqual(await d.action({ displayId: p.displayId, action: "viewable" }), { ok: false }, "never recounted");
  // The window asks again (re-mount, focus): the same display, nothing new.
  const again = await d.placement({ slot: "home_banner" });
  assert.equal(again.displayId, p.displayId);
  assert.deepEqual(await d.action({ displayId: again.displayId, action: "viewable" }), { ok: false });
  assert.deepEqual(d.service.state().events, [
    { display_id: p.displayId, placement_id: "plc_abc", kind: "rendered", surface: "desktop_home" },
    { display_id: p.displayId, placement_id: "plc_abc", kind: "viewable", surface: "desktop_home" },
  ]);
});

test("desktop: the turn line is its own display (desktop_turn), viewable too", async () => {
  const { d } = desktop({ routes: () => ({ status: 200, data: answer([placement({ id: "plc_t", slot: "turn_footer", max_per_day: 5 })]) }) });
  const t = await d.placement({ slot: "turn_footer", sessionId: "ses_1" });
  assert.equal(t.surface, "desktop_turn");
  assert.deepEqual(await d.action({ displayId: t.displayId, action: "viewable" }), { ok: true });
  assert.deepEqual(d.service.state().events.map((e) => `${e.kind}:${e.surface}`), ["viewable:desktop_turn"]);
});

test("desktop: rotation: a new conversation or 30 idle minutes gives a new display; activity keeps it", async () => {
  let now = T0;
  const { d } = desktop({ now: () => now, routes: () => ({ status: 200, data: answer([placement({ max_per_day: 10 })]) }) });
  const a = await d.placement({ slot: "home_banner" });
  assert.deepEqual(await d.action({ action: "conversation", sessionId: "ses_1" }), { ok: true, rotate: true });
  const b = await d.placement({ slot: "home_banner" });
  assert.notEqual(b.displayId, a.displayId, "new conversation");
  assert.deepEqual(await d.action({ action: "conversation", sessionId: "ses_1" }), { ok: true, rotate: false }, "the same one again: no change");
  for (let i = 0; i < 4; i++) {
    now += 20 * 60_000;
    assert.deepEqual(await d.action({ action: "activity" }), { ok: true, rotate: false });
  }
  assert.equal((await d.placement({ slot: "home_banner" })).displayId, b.displayId, "active all along: same display");
  now += 31 * 60_000;
  assert.deepEqual(await d.action({ action: "activity" }), { ok: true, rotate: true }, "back after 31 idle minutes");
  const c = await d.placement({ slot: "home_banner" });
  assert.notEqual(c.displayId, b.displayId);
  assert.deepEqual(await d.action({ action: "conversation" }), { ok: false }, "needs a session");
});

test("desktop: the window state goes to the page on focus, blur, minimize, restore, show and hide", () => {
  const handlers = new Map();
  const sent = [];
  const state = { focused: true, minimized: false, visible: true };
  const win = {
    on: (name, fn) => handlers.set(name, fn),
    removeListener: (name) => handlers.delete(name),
    isFocused: () => state.focused,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isDestroyed: () => false,
    webContents: { send: (channel, detail) => sent.push({ channel, detail }), isDestroyed: () => false, on: (name, fn) => handlers.set(`page:${name}`, fn), removeListener: (name) => handlers.delete(`page:${name}`) },
  };
  const off = watchWindowForPlacements(win);
  assert.deepEqual([...handlers.keys()].sort(), ["blur", "focus", "hide", "minimize", "page:did-finish-load", "restore", "show"]);
  state.focused = false;
  state.minimized = true;
  handlers.get("minimize")();
  assert.deepEqual(sent, [{ channel: WINDOW_STATE_CHANNEL, detail: { focused: false, minimized: true, visible: true } }]);
  handlers.get("page:did-finish-load")();
  assert.equal(sent.length, 2, "a (re)loaded page gets the state too");
  off();
  assert.equal(handlers.size, 0);
  const preload = fs.readFileSync(path.join(here, "preload.mjs"), "utf8");
  assert.ok(preload.includes(`ipcRenderer.on("${WINDOW_STATE_CHANNEL}"`), "the preload passes it on");
  const main = fs.readFileSync(path.join(here, "main.mjs"), "utf8");
  assert.match(main, /watchWindowForPlacements\(mainWindow\)/);
});

test("desktop: the cache lives in the app's data folder, not in any workspace", async () => {
  const { d, userDataPath } = desktop();
  await d.placement({ slot: "home_banner" });
  const saved = JSON.parse(fs.readFileSync(path.join(userDataPath, "placements.json"), "utf8"));
  assert.equal(saved.v, 1);
  assert.equal(saved.answer.placements[0].id, "plc_abc");
});

test("account store: placementsRequest goes to the account server with the device credential (renewed on a 401)", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = new Headers(init.headers);
    seen.push({ method: init.method ?? "GET", path: `${u.pathname}${u.search}`, auth: headers.get("authorization"), client: headers.get("x-omnirush-client"), body: init.body ?? null, signal: Boolean(init.signal) });
    if (u.pathname.endsWith("/client/placements") && headers.get("authorization") === "Bearer access-1") return new Response("", { status: 401 });
    if (u.pathname.includes("/device/token") || u.pathname.includes("/refresh")) {
      return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init.method === "POST" && u.pathname.endsWith("/client/placements/events")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-placements-"));
  const store = createDesktopOmniRushAccountStore({
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => ({
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
      decryptStringAsync: async (value) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
    }),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { OMNIRUSH_DEV_MODE: "1" },
    sleep: async () => undefined,
    execFileImpl: async (file) => { throw new Error(`unexpected ${file}`); },
    clientVersion: "3.5.5",
    fetchImpl,
  });
  assert.equal(await store.placementsRequest("/client/placements?client=desktop"), null, "signed out: null, nothing asked");
  assert.equal(seen.length, 0);
  await store.save({ gatewayUrl: "http://localhost:8090/omnirush/v1", accessToken: "access-1", refreshToken: "refresh-1" });
  const got = await store.placementsRequest("/client/placements?client=desktop&version=3.5.5&os=linux");
  assert.equal(got.status, 200);
  assert.equal(got.data.enabled, true);
  const asks = seen.filter((s) => s.path.startsWith("/omnirush/client/placements?"));
  assert.equal(asks[0].path, "/omnirush/client/placements?client=desktop&version=3.5.5&os=linux");
  assert.equal(asks.at(-1).auth, "Bearer access-2", "renewed once");
  assert.equal(asks[0].client, "gui/3.5.5");
  assert.ok(asks.every((s) => s.signal), "always with a timeout");
  const posted = await store.placementsRequest("/client/placements/events", { method: "POST", body: { events: [{ id: "plc_abc", kind: "impression", at: "x" }] } });
  assert.equal(posted.status, 204);
  assert.equal(posted.data, null);
  assert.deepEqual(JSON.parse(seen.at(-1).body), { events: [{ id: "plc_abc", kind: "impression", at: "x" }] });
});
