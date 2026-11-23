import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import {
  appHost,
  blockedSignIn,
  blockedSignInFromPage,
  blockedSignInFromUrl,
  handOffBrowser,
  handOffUrl,
  isSignInHost,
  needsPageCheck,
  PASSKEY_GUARD_ARG,
  PASSKEY_TIMEOUT_MS,
  siteAuthAnswer,
  siteAuthRequest,
  watchSignIns,
} from "./browser-signin-guard.mjs";

const require = createRequire(import.meta.url);
// The preload asks for Electron; under node that would fetch the Electron binary. It gets an empty module instead.
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = /** @type {any} */ ({ id: electronEntry, filename: electronEntry, loaded: true, exports: {} });
// Through a variable: the preload is browser code, checked on its own, not through this test.
const PRELOAD = "./browser-content-preload.cjs";
const preload = require(PRELOAD);

test("Google's rejected page and Microsoft device rules are told apart from ordinary sign-in pages", () => {
  assert.equal(blockedSignInFromUrl("https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F"), "google");
  assert.equal(blockedSignInFromUrl("https://accounts.google.com/signin/rejected"), "google");
  assert.equal(blockedSignInFromUrl("https://accounts.google.com/v3/signin/identifier?continue=x"), null);
  assert.equal(blockedSignInFromUrl("https://evil.example/v3/signin/rejected"), null);
  // Entra hands the error back to the app's address when it cannot show its own page.
  assert.equal(blockedSignInFromUrl("https://outlook.office.com/owa/?error=access_denied&error_description=AADSTS53000%3A+Device+is+not+in+required+device+state"), "microsoft_device");
  assert.equal(blockedSignInFromUrl("https://app.acme.example/callback#error=access_denied&error_description=AADSTS53001: Device is not domain joined"), "microsoft_device");
  assert.equal(blockedSignInFromUrl("https://app.acme.example/callback?error_codes=%5B53000%5D"), "microsoft_device");
  // MFA required, a wrong password or another rule: not a device rule, the person can finish here.
  assert.equal(blockedSignInFromUrl("https://app.acme.example/callback?error_description=AADSTS50076: MFA required"), null);
  assert.equal(blockedSignInFromUrl("https://app.acme.example/callback?error_description=AADSTS530035"), null);
  assert.equal(blockedSignInFromUrl("not a url"), null);
  assert.equal(blockedSignInFromUrl("file:///v3/signin/rejected"), null);

  assert.equal(needsPageCheck("https://accounts.google.com/v3/signin/challenge/pwd"), true);
  assert.equal(needsPageCheck("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"), true);
  assert.equal(needsPageCheck("https://mail.google.com/"), false);
  assert.equal(blockedSignInFromPage("https://accounts.google.com/v3/signin/identifier", { insecure: true, code: null }), "google");
  assert.equal(blockedSignInFromPage("https://login.microsoftonline.com/common/login", { insecure: false, code: "53000" }), "microsoft_device");
  assert.equal(blockedSignInFromPage("https://login.microsoftonline.com/common/login", { insecure: false, code: "50126" }), null);
  // The same words on any other site mean nothing.
  assert.equal(blockedSignInFromPage("https://blog.example/why-google-says-not-secure", { insecure: true, code: "53000" }), null);
});

test("the page check answers yes or no, never the page's text", () => {
  const source = readFileSync(new URL("./browser-signin-guard.mjs", import.meta.url), "utf8");
  const check = source.slice(source.indexOf("SIGN_IN_PAGE_CHECK ="), source.indexOf("})()`;") + 6);
  assert.match(check, /return \{ insecure: [^,]+, code: match \? match\[1\] : null \}/);
  assert.doesNotMatch(check, /return text|innerText\s*;|fetch\(|sendBeacon|XMLHttpRequest/);
});

test("Open in <browser> hands off the app the person was going to, never the sign-in page", () => {
  assert.equal(handOffUrl("google", "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F", null), "https://mail.google.com/mail/u/0/");
  // A continue that is itself a sign-in page or not https: the last app page in the tab instead.
  assert.equal(handOffUrl("google", "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Faccounts.google.com%2Fx", "https://calendar.google.com/"), "https://calendar.google.com/");
  assert.equal(handOffUrl("google", "https://accounts.google.com/v3/signin/rejected?continue=javascript%3Aalert(1)", null), "https://accounts.google.com/v3/signin/rejected?continue=javascript%3Aalert(1)");
  assert.equal(handOffUrl("microsoft_device", "https://login.microsoftonline.com/common/login", "https://outlook.office.com/mail/"), "https://outlook.office.com/mail/");
  assert.equal(handOffUrl("passkey", "https://github.com/login", "https://github.com/acme"), "https://github.com/login");
  assert.equal(handOffUrl("site_auth", "about:blank", null), null);
  assert.equal(appHost("https://www.Notion.so/acme"), "notion.so");
  assert.equal(appHost("https://acme.okta.com/app/x"), null);
  assert.equal(isSignInHost("login.microsoftonline.com"), true);
  assert.equal(isSignInHost("tms.acme.example"), false);
  assert.deepEqual(blockedSignIn("google", "https://accounts.google.com/v3/signin/rejected", "https://mail.google.com/", { id: null, name: "Google Chrome" }),
    { kind: "google", url: "https://mail.google.com/", host: "mail.google.com", browser: { id: null, name: "Google Chrome" } });
});

test("the bar names Edge for a Microsoft device rule when it is installed, else the default browser", () => {
  const installed = [{ id: "chrome", name: "Google Chrome" }, { id: "edge", name: "Microsoft Edge" }];
  assert.deepEqual(handOffBrowser("microsoft_device", installed, "Google Chrome"), { id: "edge", name: "Microsoft Edge" });
  assert.deepEqual(handOffBrowser("microsoft_device", [{ id: "chrome", name: "Google Chrome" }], "Google Chrome"), { id: null, name: "Google Chrome" });
  assert.deepEqual(handOffBrowser("google", installed, "Firefox.app"), { id: null, name: "Firefox" });
  // Nothing useful from the system (or our own name): "your browser".
  assert.deepEqual(handOffBrowser("passkey", [], ""), { id: null, name: null });
  assert.deepEqual(handOffBrowser("passkey", [], "OmniRush.ai"), { id: null, name: null });
  assert.deepEqual(handOffBrowser("passkey", [], "x".repeat(60)), { id: null, name: null });
});

test("a site's sign-in request shows its host and its own words, short; the answer is checked", () => {
  assert.deepEqual(siteAuthRequest("auth_1", "tab_1", { url: "https://intranet.acme.example/hr/" }, { isProxy: false, scheme: "Basic", host: "intranet.acme.example", port: 443, realm: "Acme\nintranet" }),
    { id: "auth_1", tabId: "tab_1", host: "intranet.acme.example", realm: "Acme intranet", scheme: "basic", url: "https://intranet.acme.example/hr/" });
  assert.equal(siteAuthRequest("a", "t", { url: "https://x.example/" }, { realm: "r".repeat(500) }).realm.length, 120);
  assert.deepEqual(siteAuthAnswer({ username: "pat", password: "hunter2" }), { username: "pat", password: "hunter2" });
  assert.equal(siteAuthAnswer({ username: "", password: "x" }), null);
  assert.equal(siteAuthAnswer({ username: "pat", password: 7 }), null);
  assert.equal(siteAuthAnswer({ username: "pat", password: "x".repeat(2000) }), null);
  assert.equal(siteAuthAnswer(null), null);
});

function fakeTab(url = "about:blank") {
  /** @type {any} */
  const contents = new EventEmitter();
  contents.url = url;
  contents.getURL = () => contents.url;
  contents.isDestroyed = () => false;
  contents.go = (next) => { contents.url = next; contents.emit("did-start-navigation", null, next, false, true); contents.emit("did-navigate", null, next); };
  return { tabId: "tab_1", view: { webContents: contents }, contents };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a tab is marked when Google refuses, cleared when it moves on, and only for Work accounts", async () => {
  const tab = fakeTab();
  let on = true;
  let published = 0;
  const watcher = watchSignIns(tab, { isOn: () => on, chooseBrowser: async () => ({ id: null, name: "Google Chrome" }), publish: () => { published += 1; }, checkPage: async () => null });
  tab.contents.go("https://mail.google.com/mail/u/0/");
  assert.equal(tab.lastAppUrl, "https://mail.google.com/mail/u/0/");
  tab.contents.go("https://accounts.google.com/v3/signin/rejected");
  await flush();
  assert.deepEqual(tab.blockedSignIn, { kind: "google", url: "https://mail.google.com/mail/u/0/", host: "mail.google.com", browser: { id: null, name: "Google Chrome" } });
  assert.equal(published, 1);
  tab.contents.go("https://www.google.com/");
  assert.equal(tab.blockedSignIn, null);
  // A passkey that never answered: marked, then gone when the page is left.
  tab.contents.url = "https://github.com/login";
  watcher.passkeyTimedOut();
  await flush();
  assert.equal(tab.blockedSignIn?.kind, "passkey");
  tab.contents.emit("did-start-navigation", null, "https://github.com/login#x", true, true);
  assert.equal(tab.blockedSignIn?.kind, "passkey", "an in-page move keeps it");
  tab.contents.go("https://github.com/sessions/new");
  assert.equal(tab.blockedSignIn, null);
  // A site's sign-in request comes before its page commits: the bar names the request's own address, stays on that
  // site's 401 page and goes when the tab moves to another site.
  tab.contents.url = "about:blank";
  watcher.siteAuthBlocked("https://intranet.acme.example/hr/");
  await flush();
  assert.deepEqual(tab.blockedSignIn, { kind: "site_auth", url: "https://intranet.acme.example/hr/", host: "intranet.acme.example", browser: { id: null, name: "Google Chrome" } });
  tab.contents.go("https://intranet.acme.example/hr/");
  assert.equal(tab.blockedSignIn?.kind, "site_auth");
  tab.contents.go("https://linear.app/acme");
  assert.equal(tab.blockedSignIn, null);
  // Everyone else: nothing is marked.
  on = false;
  tab.contents.go("https://accounts.google.com/v3/signin/rejected");
  watcher.passkeyTimedOut();
  await flush();
  assert.equal(tab.blockedSignIn, null);
});

test("the page check runs only on Google and Microsoft sign-in pages, and a late answer for a page left is dropped", async () => {
  const tab = fakeTab();
  const checked = [];
  let answer = { insecure: false, code: "53000" };
  watchSignIns(tab, { isOn: () => true, chooseBrowser: async (kind) => (kind === "microsoft_device" ? { id: "edge", name: "Microsoft Edge" } : { id: null, name: null }), publish: () => {}, checkPage: async (contents) => { checked.push(contents.getURL()); return answer; } });
  tab.contents.go("https://outlook.office.com/mail/");
  tab.contents.emit("did-stop-loading");
  assert.deepEqual(checked, []);
  tab.contents.go("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x");
  tab.contents.emit("did-stop-loading");
  await flush(); await flush();
  assert.deepEqual(tab.blockedSignIn, { kind: "microsoft_device", url: "https://outlook.office.com/mail/", host: "outlook.office.com", browser: { id: "edge", name: "Microsoft Edge" } });
  const other = fakeTab();
  answer = { insecure: true, code: null };
  watchSignIns(other, { isOn: () => true, chooseBrowser: async () => ({ id: null, name: null }), publish: () => {}, checkPage: async () => { other.contents.url = "https://mail.google.com/"; return answer; } });
  other.contents.go("https://accounts.google.com/v3/signin/identifier");
  other.contents.emit("did-stop-loading");
  await flush(); await flush();
  assert.equal(other.blockedSignIn ?? null, null);
});

/** The page's credentials container, as the test's fakes shape it. */
const credentials = () => /** @type {any} */ (navigator.credentials);

/** A page's main world with a WebAuthn container whose requests never answer unless told to. */
function passkeyRealm({ mac = false } = {}) {
  const previous = { navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), window: globalThis.window, PublicKeyCredential: globalThis.PublicKeyCredential };
  const calls = [];
  class Container {
    create(options) { calls.push({ op: "create", options }); return new Promise((resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); if (options?.answer) setTimeout(() => resolve(options.answer), 10); }); }
    get(options) { calls.push({ op: "get", options }); return new Promise((resolve) => { if (options?.answer) setTimeout(() => resolve(options.answer), 10); }); }
  }
  class PublicKeyCredential {
    static isUserVerifyingPlatformAuthenticatorAvailable() { return Promise.resolve(true); }
    static getClientCapabilities() { return Promise.resolve({ conditionalGet: true, userVerifyingPlatformAuthenticator: true, passkeyPlatformAuthenticator: true, hybridTransport: true }); }
  }
  const window = new EventTarget();
  const events = [];
  window.addEventListener("omnirush:passkey-timeout", () => events.push(Date.now()));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: new Container() } });
  globalThis.window = /** @type {any} */ (window);
  globalThis.PublicKeyCredential = /** @type {any} */ (PublicKeyCredential);
  assert.equal(preload.installPasskeyGuard(mac, PASSKEY_TIMEOUT_MS), true);
  return {
    calls, events, PublicKeyCredential,
    restore() {
      if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator); else delete globalThis.navigator;
      if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
      if (previous.PublicKeyCredential === undefined) delete globalThis.PublicKeyCredential; else globalThis.PublicKeyCredential = previous.PublicKeyCredential;
    },
  };
}

test("a passkey create that never answers settles after 30 s with NotAllowedError, aborts the request and tells the tab", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realm = passkeyRealm();
  try {
    assert.equal(PASSKEY_TIMEOUT_MS, 30_000);
    assert.equal(preload.PASSKEY_TIMEOUT_MS, PASSKEY_TIMEOUT_MS);
    assert.equal(preload.PASSKEY_GUARD_ARG, PASSKEY_GUARD_ARG);
    /** @type {any} */
    let settled = null;
    const pending = credentials().create({ publicKey: { challenge: new Uint8Array(32) } }).then(() => { settled = "resolved"; }, (error) => { settled = error; });
    t.mock.timers.tick(29_999);
    await Promise.resolve();
    assert.equal(settled, null, "still waiting before 30 s");
    t.mock.timers.tick(1);
    await pending;
    assert.equal(settled?.name, "NotAllowedError");
    assert.equal(realm.events.length, 1, "the tab hears it once");
    assert.equal(realm.calls[0].options.signal.aborted, true, "the browser's own request is aborted");
    assert.ok(realm.calls[0].options.publicKey, "the request reached the browser unchanged otherwise");
  } finally {
    realm.restore();
  }
});

test("a passkey that answers in time, passkey autofill and password requests pass through untouched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realm = passkeyRealm();
  try {
    const answered = credentials().get({ publicKey: { challenge: new Uint8Array(32) }, answer: "credential" });
    t.mock.timers.tick(10);
    assert.equal(await answered, "credential");
    t.mock.timers.tick(31_000);
    assert.equal(realm.events.length, 0);
    // Autofill waits as long as the page wants; a password or federated request is not a passkey.
    const conditional = { publicKey: { challenge: new Uint8Array(32) }, mediation: "conditional" };
    void credentials().get(conditional);
    void credentials().get({ password: true });
    t.mock.timers.tick(60_000);
    assert.equal(realm.events.length, 0);
    assert.equal(realm.calls[1].options, conditional, "autofill gets the page's own options");
    // The page's own abort still works.
    const controller = new AbortController();
    const aborted = credentials().create({ publicKey: { challenge: new Uint8Array(32) }, signal: controller.signal }).catch((error) => error.name);
    controller.abort();
    assert.equal(await aborted, "AbortError");
    // Installing twice is a no-op.
    assert.equal(preload.installPasskeyGuard(false, PASSKEY_TIMEOUT_MS), false);
  } finally {
    realm.restore();
  }
});

test("on macOS no platform authenticator is reported; elsewhere the page sees what the browser says", async () => {
  const mac = passkeyRealm({ mac: true });
  try {
    assert.equal(await mac.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), false);
    assert.deepEqual(await mac.PublicKeyCredential.getClientCapabilities(), { conditionalGet: true, userVerifyingPlatformAuthenticator: false, passkeyPlatformAuthenticator: false, hybridTransport: true });
  } finally {
    mac.restore();
  }
  const windows = passkeyRealm({ mac: false });
  try {
    assert.equal(await windows.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true);
  } finally {
    windows.restore();
  }
});

test("the guard is serialized into the page, so it must not reach outside its own body", () => {
  const source = preload.installPasskeyGuard.toString();
  assert.doesNotMatch(source, /require\(|ipcRenderer|contextBridge|process\.|electron/);
  const file = readFileSync(new URL("./browser-content-preload.cjs", import.meta.url), "utf8");
  assert.match(file, /if \(passkeyGuardOn\(\)\)/, "only tabs created for a Work account get it");
  assert.match(file, /executeInMainWorld\(\{ func: installPasskeyGuard, args: \[mac, PASSKEY_TIMEOUT_MS\] \}\)/);
});

test("the built-in browser never rewrites its user agent: Google sees the untouched Electron one", () => {
  // computer-use-agent-browser.mjs strips Electron/ for its own never signed-in browser; the person's browser must not.
  for (const file of ["browser-panel.mjs", "browser-signin-guard.mjs", "browser-task.mjs", "media-permissions.mjs", "browser-content-preload.cjs", "browser-login-sync.mjs", "main.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /setUserAgent|userAgentFallback/, `${file} leaves the user agent alone`);
    // main.mjs names a user agent only for its own icon downloads (a request header), never for a browser session.
    if (file !== "main.mjs") assert.doesNotMatch(source, /userAgent|user-agent/i, `${file} leaves the user agent alone`);
  }
});
