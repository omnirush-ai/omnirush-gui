import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const hooks = `
export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: "electron-stub:browser-library", shortCircuit: true };
  return next(specifier, context);
}
export function load(url, context, next) {
  if (url === "electron-stub:browser-library") return { format: "module", source: "export const session = { fromPartition() { throw new Error('unused'); } };", shortCircuit: true };
  return next(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { createBrowserLibrary } = await import("./browser-library.mjs");
const { createBrowserLoginSync } = await import("./browser-login-sync.mjs");

const NOW = Date.UTC(2026, 10, 23, 12);
const nowSeconds = Math.trunc(NOW / 1000);
const CHROMIUM_EPOCH_OFFSET_S = 11_644_473_600n;
const chromiumTime = (unixSeconds) => (BigInt(unixSeconds) + CHROMIUM_EPOCH_OFFSET_S) * 1_000_000n;
const SESSION_VALUE = "firefox-session-value-fixture";
const BANK_VALUE = "bank-session-value-fixture";

/** A home directory with Chrome (two named profiles), Firefox (bookmarks, history, sign-ins) and Safari's files. */
function fixtureHome({ platform = "darwin" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "browser-library-home-"));
  const chromeRoot = platform === "win32"
    ? join(home, "AppData", "Local", "Google", "Chrome", "User Data")
    : join(home, "Library", "Application Support", "Google", "Chrome");
  for (const profile of ["Default", "Profile 1"]) mkdirSync(join(chromeRoot, profile, "Network"), { recursive: true });
  writeFileSync(join(chromeRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work" }, "Profile 1": { name: "Personal" } } } }));
  writeFileSync(join(chromeRoot, "Default", "Bookmarks"), JSON.stringify({
    roots: {
      bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [
        { type: "url", name: "Team tracker", url: "https://tracker.example.org/board" },
        { type: "folder", name: "Docs", children: [{ type: "url", name: "Handbook", url: "https://docs.example.com/handbook" }] },
      ] },
      other: { type: "folder", name: "Other bookmarks", children: [{ type: "url", name: "Example", url: "https://www.example.com/" }] },
    },
  }));
  const history = new DatabaseSync(join(chromeRoot, "Default", "History"));
  history.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)");
  const insert = history.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, 0, ?)");
  insert.run("https://tracker.example.org/board", "Board", 50, chromiumTime(nowSeconds - 600));
  insert.run("https://example.com/pricing", "Pricing", 3, chromiumTime(nowSeconds - 86_400));
  insert.run("https://exampleapp.io/login", "Example app", 9, chromiumTime(nowSeconds - 3_600));
  insert.run("https://old.example.net/", "Old", 1, chromiumTime(nowSeconds - 200 * 86_400));
  history.close();
  writeFileSync(join(chromeRoot, "Profile 1", "Network", "Cookies"), "");

  const firefoxRoot = platform === "win32"
    ? join(home, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles")
    : join(home, "Library", "Application Support", "Firefox", "Profiles");
  const firefox = join(firefoxRoot, "abcd1234.default-release");
  mkdirSync(firefox, { recursive: true });
  const places = new DatabaseSync(join(firefox, "places.sqlite"));
  places.exec("CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER DEFAULT 0, last_visit_date INTEGER)");
  places.exec("CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT)");
  places.prepare("INSERT INTO moz_places VALUES (1, 'https://firefox.example.com/', 'Firefox page', 4, 0, ?)").run((nowSeconds - 60) * 1_000_000);
  places.exec("INSERT INTO moz_bookmarks VALUES (1, 2, NULL, 0, 0, '', 0, 'root________'), (2, 2, NULL, 1, 0, 'toolbar', 0, 'toolbar_____'), (3, 1, 1, 2, 0, 'Firefox page', 0, 'b1')");
  places.close();
  const cookies = new DatabaseSync(join(firefox, "cookies.sqlite"));
  cookies.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)");
  const cookie = cookies.prepare("INSERT INTO moz_cookies (name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, '/', ?, ?, 0, 1, 1, 1)");
  cookie.run("sid", SESSION_VALUE, ".firefoxsite.com", nowSeconds + 86_400, (nowSeconds - 30) * 1_000_000);
  cookie.run("auth", BANK_VALUE, ".bank.example", nowSeconds + 86_400, (nowSeconds - 60) * 1_000_000);
  cookies.close();
  writeFileSync(join(firefoxRoot, "..", "profiles.ini"), "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd1234.default-release\n");

  if (platform === "darwin") {
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });
    writeFileSync(join(home, "Library", "Safari", "Bookmarks.plist"), readFileSync(new URL("../../../packages/browser-logins/test/fixtures/Bookmarks.plist", import.meta.url)));
  }
  return {
    home,
    env: platform === "win32" ? { LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming") } : {},
  };
}

function nodeSqliteReader(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      // Chromium's microsecond times pass 2^53; better-sqlite3 hands them over as plain numbers.
      statement.setReadBigInts(true);
      return { all: (...params) => statement.all(...params) };
    },
    close: () => db.close(),
  };
}

function fakeSession() {
  const store = new Map();
  return {
    store,
    cookies: {
      async set(details) { store.set(`${details.domain ?? details.url}|${details.path}|${details.name}`, details); },
      async get() { return [...store.values()].map((details) => ({ ...details, domain: details.domain ?? new URL(details.url).hostname })); },
      async remove(url, name) { for (const [key, value] of store) if (value.name === name && (value.url === url || key.includes(new URL(url).hostname))) store.delete(key); },
      async flushStore() {},
    },
    async clearStorageData() {},
  };
}

function setup({ platform = "darwin", confirm = async () => true, blockSafari = false, policyAllowed = true, fixture = null, readLinuxKeyring = async () => null } = {}) {
  const { home, env } = fixture ?? fixtureHome({ platform });
  const session = fakeSession();
  const confirmations = [];
  const loginSync = createBrowserLoginSync({
    platform,
    home,
    env,
    getSession: () => session,
    openDatabase: nodeSqliteReader,
    readKeychainPassword: async () => "unused",
    readLinuxKeyring,
    readSourceFile: async (filePath) => {
      if (blockSafari && filePath.includes("com.apple.Safari")) throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
      return readFileSync(filePath);
    },
    now: () => NOW,
    pollIntervalMs: 0,
    watchSource: null,
    initialPolicyAllowed: policyAllowed,
    confirmUserAction: async (input) => {
      confirmations.push(input);
      return confirm();
    },
  });
  const permissionDenied = () => Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  const library = createBrowserLibrary({
    platform,
    home,
    env,
    loginSync,
    now: () => NOW,
    readSourceFile: async (filePath) => {
      if (blockSafari && filePath.includes(join("Library", "Safari"))) throw permissionDenied();
      return readFileSync(filePath);
    },
    probeFile: async (filePath) => {
      if (blockSafari && filePath.includes(join("Library", "Safari"))) throw permissionDenied();
    },
  });
  return { library, loginSync, session, confirmations, home };
}

/** The IPC handlers as the renderer reaches them, with every answer kept so the test can scan them for values. */
function ipcHarness(library) {
  const handlers = new Map();
  const answers = [];
  const sent = [];
  library.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler) });
  const event = { sender: { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false } };
  return {
    channels: [...handlers.keys()],
    sent,
    answers,
    async call(channel, ...args) {
      const answer = await handlers.get(channel)(event, ...args);
      answers.push(answer);
      return answer;
    },
  };
}

test("sources list each browser with its profiles' own names and what they hold, never a path", async () => {
  const { library, home } = setup();
  const sources = await library.sources();
  assert.deepEqual(sources.browsers.map((browser) => [browser.browser, browser.profiles.map((profile) => profile.name)]), [
    ["chrome", ["Work", "Personal"]],
    ["firefox", ["Default"]],
    ["safari", ["Safari"]],
  ]);
  assert.deepEqual(sources.browsers[0].profiles[0].has, { bookmarks: true, history: true, signIns: false });
  assert.equal(sources.browsers[2].access, "ok");
  assert.ok(!JSON.stringify(sources).includes(home));
  assert.equal(sources.historyDays, 90);
});

test("inspect counts before anything is copied; the import fills the library; a second import replaces, never doubles", async () => {
  const { library } = setup();
  const ipc = ipcHarness(library);
  const inspected = await ipc.call("omnirush:browser-library:inspect", { sourceId: "chrome:Default" });
  assert.deepEqual(inspected.bookmarks, { state: "ready", count: 3 });
  assert.deepEqual(inspected.history, { state: "ready", count: 3, days: 90 });
  assert.deepEqual(inspected.signIns, { state: "empty" });
  assert.deepEqual(await library.bookmarkTree(), []);

  const result = await ipc.call("omnirush:browser-library:import", { sourceId: "chrome:Default", bookmarks: true, history: true });
  assert.deepEqual(result.bookmarks, { state: "done", count: 3 });
  assert.deepEqual(result.history, { state: "done", count: 3 });
  assert.deepEqual(ipc.sent.map(({ channel, payload }) => [channel, payload.kind, payload.state]), [
    ["omnirush:browser-library:progress", "bookmarks", "running"],
    ["omnirush:browser-library:progress", "bookmarks", "done"],
    ["omnirush:browser-library:progress", "history", "running"],
    ["omnirush:browser-library:progress", "history", "done"],
  ]);

  const tree = await ipc.call("omnirush:browser-library:bookmarks");
  assert.equal(tree.length, 1);
  assert.equal(tree[0].title, "Chrome · Work");
  assert.equal(tree[0].browser, "chrome");
  assert.deepEqual(tree[0].children.map((folder) => folder.title), ["Bookmarks bar", "Other bookmarks"]);
  assert.deepEqual(tree[0].children[0].children.map((node) => node.title), ["Team tracker", "Docs"]);

  await library.runImport({ sourceId: "chrome:Default", bookmarks: true, history: true });
  assert.equal(library.summary().bookmarks, 3);
  assert.equal(library.summary().history, 3);
  assert.deepEqual(library.summary().imports.map(({ sourceId, browser, name, bookmarks, history, signIns }) => ({ sourceId, browser, name, bookmarks, history, signIns })), [
    { sourceId: "chrome:Default", browser: "chrome", name: "Work", bookmarks: 3, history: 3, signIns: null },
  ]);
});

test("address bar suggestions: a site typed from its start first, bookmarks and frequent pages next, eight at most", async () => {
  const { library } = setup();
  await library.runImport({ sourceId: "chrome:Default", bookmarks: true, history: true });
  const suggestions = library.suggest("exam");
  assert.deepEqual(suggestions.map((entry) => entry.url).slice(0, 3), ["https://www.example.com/", "https://exampleapp.io/login", "https://example.com/pricing"]);
  assert.equal(suggestions[0].kind, "bookmark");
  assert.equal(library.suggest("tracker")[0].url, "https://tracker.example.org/board");
  assert.equal(library.suggest("handbook")[0].title, "Handbook");
  assert.deepEqual(library.suggest(""), []);
  assert.deepEqual(library.suggest("100%_"), []);
  assert.deepEqual(library.topBookmarks(2).map((entry) => entry.title), ["Team tracker", "Handbook"]);
});

test("the star adds and removes a page; clearing imports keeps starred pages", async () => {
  const { library } = setup();
  await library.runImport({ sourceId: "chrome:Default", bookmarks: true, history: true });
  assert.equal(library.isBookmarked("https://news.example.com/"), false);
  assert.deepEqual(library.toggleBookmark({ url: "https://news.example.com/", title: "News" }), { bookmarked: true });
  assert.equal(library.isBookmarked("https://news.example.com/"), true);
  assert.equal(library.bookmarkTree()[0].title, "News");
  assert.deepEqual(library.toggleBookmark({ url: "https://tracker.example.org/board" }), { bookmarked: false });
  assert.equal(library.isBookmarked("https://tracker.example.org/board"), false);
  assert.throws(() => library.toggleBookmark({ url: "file:///etc/passwd" }), /Only web pages/);

  const cleared = library.clear();
  assert.deepEqual(cleared, { imports: [], bookmarks: 1, history: 0 });
  assert.deepEqual(library.bookmarkTree().map((node) => node.title), ["News"]);
  assert.deepEqual(library.suggest("exam").map((entry) => entry.url), ["https://news.example.com/"]);
});

test("sign-ins: the dialog sees site names only; a one-time import asks first and writes the chosen sites; no cookie value crosses IPC", async () => {
  const { library, loginSync, session, confirmations } = setup();
  const ipc = ipcHarness(library);
  const inspected = await ipc.call("omnirush:browser-library:inspect", { sourceId: (await library.sources()).browsers[1].profiles[0].id });
  assert.equal(inspected.signIns.state, "ready");
  assert.deepEqual(inspected.signIns.sites.map((site) => [site.site, site.preselected]), [["firefoxsite.com", true], ["bank.example", false]]);
  assert.equal(inspected.keepInStep, true);
  assert.equal(confirmations.length, 0, "reading site names asks nothing; only copying values does");

  const result = await ipc.call("omnirush:browser-library:import", {
    sourceId: inspected.source.id,
    bookmarks: true,
    history: true,
    signIns: { previewId: inspected.signIns.previewId, sites: ["firefoxsite.com"], keepInStep: false },
  });
  assert.deepEqual(result.signIns, { state: "done", count: 1, failed: 0, keepInStep: false });
  assert.deepEqual(result.bookmarks, { state: "done", count: 1 });
  assert.deepEqual(confirmations.map((entry) => [entry.action, entry.sites]), [["import", ["firefoxsite.com"]]]);
  assert.deepEqual([...session.store.values()].map((cookie) => [cookie.domain, cookie.value]), [[".firefoxsite.com", SESSION_VALUE]]);
  assert.equal((await ipc.call("omnirush:browser-library:summary")).imports[0].signIns, 1);
  assert.equal((await loginSync.getState()).configured, false, "a one-time import does not set up continuing sync");

  for (const channel of ipc.channels) if (!["omnirush:browser-library:import", "omnirush:browser-library:inspect", "omnirush:browser-library:clear", "omnirush:browser-library:openFullDiskAccess", "omnirush:browser-library:toggleBookmark"].includes(channel)) await ipc.call(channel, "exam");
  const everything = JSON.stringify([ipc.answers, ipc.sent]);
  assert.ok(!everything.includes(SESSION_VALUE));
  assert.ok(!everything.includes(BANK_VALUE));
});

test("sign-ins kept in step use the sync; a declined confirmation imports nothing and says so", async () => {
  let allow = false;
  const { library, loginSync, session } = setup({ confirm: async () => allow });
  const sourceId = (await library.sources()).browsers[1].profiles[0].id;
  const first = await library.inspect({ sourceId });
  const declined = await library.runImport({ sourceId, signIns: { previewId: first.signIns.previewId, sites: ["firefoxsite.com"] } });
  assert.deepEqual(declined.signIns, { state: "cancelled", reason: "cancelled" });
  assert.equal(session.store.size, 0);

  allow = true;
  const second = await library.inspect({ sourceId });
  const kept = await library.runImport({ sourceId, signIns: { previewId: second.signIns.previewId, sites: ["firefoxsite.com"], keepInStep: true } });
  assert.deepEqual(kept.signIns, { state: "done", count: 1, failed: 0, keepInStep: true });
  const state = await loginSync.getState();
  assert.equal(state.active, true);
  assert.deepEqual(state.selectedSites, ["firefoxsite.com"]);
  loginSync.shutdown();
});

test("Windows: Chrome sign-ins are refused with the reason; its bookmarks and history still import; Firefox sign-ins work", async () => {
  const { library } = setup({ platform: "win32" });
  const sources = await library.sources();
  const chrome = sources.browsers.find((browser) => browser.browser === "chrome");
  assert.deepEqual(chrome.signIns, { importable: false, reason: "windows_locked" });
  assert.deepEqual(sources.browsers.find((browser) => browser.browser === "firefox").signIns, { importable: true, reason: null });
  assert.equal(sources.browsers.some((browser) => browser.browser === "safari"), false);
  const inspected = await library.inspect({ sourceId: "chrome:Profile 1" });
  assert.deepEqual(inspected.signIns, { state: "unavailable", reason: "windows_locked" });
  const result = await library.runImport({ sourceId: "chrome:Default", bookmarks: true, history: true });
  assert.equal(result.bookmarks.count, 3);
  assert.equal(result.history.count, 3);
  const firefox = await library.inspect({ sourceId: sources.browsers.find((browser) => browser.browser === "firefox").profiles[0].id });
  assert.equal(firefox.signIns.state, "ready");
});

test("Safari without Full Disk Access is listed with the access step and its reads come back blocked; with access it imports", async () => {
  const blocked = setup({ blockSafari: true });
  const sources = await blocked.library.sources();
  assert.equal(sources.browsers.find((browser) => browser.browser === "safari").access, "full_disk_access");
  const inspected = await blocked.library.inspect({ sourceId: "safari:Safari" });
  assert.deepEqual(inspected.bookmarks, { state: "blocked", reason: "full_disk_access" });
  const result = await blocked.library.runImport({ sourceId: "safari:Safari", bookmarks: true });
  assert.deepEqual(result.bookmarks, { state: "blocked", reason: "full_disk_access" });

  const open = setup();
  const counted = await open.library.inspect({ sourceId: "safari:Safari" });
  assert.deepEqual(counted.bookmarks, { state: "ready", count: 4 });
  const imported = await open.library.runImport({ sourceId: "safari:Safari", bookmarks: true });
  assert.deepEqual(imported.bookmarks, { state: "done", count: 4 });
  assert.deepEqual(open.library.bookmarkTree()[0].children.map((folder) => folder.title), ["Favorites", "Reading list", "Bookmarks"]);
});

test("sign-in import off on this computer (managed Desktop): bookmarks and history still offered, sign-ins say why", async () => {
  const { library } = setup({ policyAllowed: false });
  const sources = await library.sources();
  assert.deepEqual(sources.browsers.find((browser) => browser.browser === "firefox").signIns, { importable: false, reason: "policy_off" });
  const inspected = await library.inspect({ sourceId: sources.browsers.find((browser) => browser.browser === "firefox").profiles[0].id });
  assert.deepEqual(inspected.signIns, { state: "unavailable", reason: "policy_off" });
  assert.equal(inspected.bookmarks.state, "ready");
});

test("one import at a time", async () => {
  const { library } = setup();
  const first = library.runImport({ sourceId: "chrome:Default", bookmarks: true, history: true });
  await assert.rejects(library.runImport({ sourceId: "chrome:Default", bookmarks: true }), /already running/);
  await first;
});

/** A Linux Chrome cookie store whose values are encrypted the two ways Chrome does: v10 (no key ring) and v11 (key ring). */
function linuxChromeHome() {
  const home = mkdtempSync(join(tmpdir(), "browser-library-linux-"));
  const profile = join(home, ".config", "google-chrome", "Default");
  mkdirSync(join(profile, "Network"), { recursive: true });
  const keyFor = (password) => pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const encrypt = (prefix, password, host, value) => {
    const cipher = createCipheriv("aes-128-cbc", keyFor(password), Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
    return Buffer.concat([Buffer.from(prefix, "latin1"), cipher.update(plain), cipher.final()]);
  };
  const db = new DatabaseSync(join(profile, "Network", "Cookies"));
  db.exec("CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24')");
  db.exec("CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT DEFAULT '', name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, samesite INTEGER)");
  const insert = db.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, samesite) VALUES (?, ?, '', ?, '/', ?, 1, 1, ?, 1, 1, 1)");
  insert.run(".keyring-site.com", "sid", encrypt("v11", "ring-secret", ".keyring-site.com", "v11-value-fixture"), chromiumTime(nowSeconds + 86_400), chromiumTime(nowSeconds - 10));
  insert.run(".basic-site.com", "sid", encrypt("v10", "peanuts", ".basic-site.com", "v10-value-fixture"), chromiumTime(nowSeconds + 86_400), chromiumTime(nowSeconds - 20));
  db.close();
  return { home, env: {} };
}

test("Linux Chrome: sign-ins decrypt with the desktop key ring (v11) and the built-in password (v10)", async () => {
  const asked = [];
  const { library, session } = setup({
    platform: "linux",
    fixture: linuxChromeHome(),
    readLinuxKeyring: async (browser) => {
      asked.push(browser);
      return "ring-secret";
    },
  });
  const sources = await library.sources();
  assert.deepEqual(sources.browsers.map((browser) => [browser.browser, browser.signIns]), [["chrome", { importable: true, reason: null }]]);
  const inspected = await library.inspect({ sourceId: "chrome:Default" });
  assert.deepEqual(inspected.signIns.sites.map((site) => site.site), ["keyring-site.com", "basic-site.com"]);
  assert.deepEqual(asked, [], "listing sites reads no key");
  const result = await library.runImport({ sourceId: "chrome:Default", signIns: { previewId: inspected.signIns.previewId, sites: ["keyring-site.com", "basic-site.com"] } });
  assert.deepEqual(result.signIns, { state: "done", count: 2, failed: 0, keepInStep: false });
  assert.deepEqual(asked, ["chrome"]);
  assert.deepEqual([...session.store.values()].map((cookie) => cookie.value).sort(), ["v10-value-fixture", "v11-value-fixture"]);
  assert.ok(!JSON.stringify([inspected, result]).includes("value-fixture"));
});

test("Safari sign-ins: read from the binary cookie file with access; without it the step says Full Disk Access", async () => {
  const fixture = fixtureHome();
  const cookieDir = join(fixture.home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies");
  mkdirSync(cookieDir, { recursive: true });
  writeFileSync(join(cookieDir, "Cookies.binarycookies"), readFileSync(new URL("../../../packages/browser-logins/test/fixtures/Cookies.binarycookies", import.meta.url)));

  const { library, session } = setup({ fixture });
  const inspected = await library.inspect({ sourceId: "safari:Safari" });
  assert.deepEqual(inspected.signIns.sites.map((site) => [site.site, site.preselected]), [["bank.example", false], ["example.com", true]]);
  const result = await library.runImport({ sourceId: "safari:Safari", signIns: { previewId: inspected.signIns.previewId, sites: ["example.com"] } });
  assert.equal(result.signIns.count, 1);
  assert.deepEqual([...session.store.values()].map((cookie) => [cookie.domain, cookie.value]), [[".example.com", "safari-session-fixture"]]);

  const blocked = setup({ fixture, blockSafari: true });
  assert.deepEqual((await blocked.library.inspect({ sourceId: "safari:Safari" })).signIns, { state: "blocked", reason: "full_disk_access" });
});

test("the sign-in sync setup (Settings > Permissions) lists what it always listed: no Safari, no Linux Chrome", async () => {
  const mac = setup();
  const listed = await mac.loginSync.listSources();
  assert.deepEqual(listed.profiles.map((profile) => profile.browser).sort(), ["chrome", "firefox"]);
  assert.deepEqual(listed.availability.find((entry) => entry.browser === "safari"), {
    browser: "safari", label: "Safari", importable: false, reason: "Safari keeps its cookies where only Safari can read them without Full Disk Access.",
  });
  const linux = setup({ platform: "linux", fixture: linuxChromeHome() });
  const linuxListed = await linux.loginSync.listSources();
  assert.deepEqual(linuxListed.profiles, []);
  assert.equal(linuxListed.availability.find((entry) => entry.browser === "chrome")?.importable, false);
  // Importing still reaches Linux Chrome through the key ring (the test above).
  assert.equal((await linux.library.sources()).browsers[0].signIns.importable, true);
});
