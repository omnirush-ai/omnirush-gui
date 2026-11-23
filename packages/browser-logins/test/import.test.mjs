import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSourceAvailability, IMPORT_BROWSERS } from "../index.mjs";
import { countBookmarks, flattenBookmarks, importableUrl, parseArcSidebar, parseChromiumBookmarks, readFirefoxBookmarks } from "../bookmarks.mjs";
import { APPLE_EPOCH_OFFSET_S, countChromiumHistory, countFirefoxHistory, countSafariHistory, historySince, readChromiumHistory, readFirefoxHistory, readSafariHistory } from "../history.mjs";
import { linuxChromiumKeys, readLinuxKeyringPassword } from "../linux-keyring.mjs";
import { decryptChromiumValue, deriveChromiumKey, firefoxProfileNames, importProfiles, readChromiumCookies } from "../node.mjs";
import { isPermissionError, parseBinaryCookies, parseBinaryPlist, safariBookmarksTree, safariProfile } from "../safari.mjs";

const NOW = Date.UTC(2026, 10, 23, 12);
const nowSeconds = Math.trunc(NOW / 1000);
const CHROMIUM_EPOCH_OFFSET_S = 11_644_473_600;
const chromiumTime = (unixSeconds) => String(BigInt(unixSeconds + CHROMIUM_EPOCH_OFFSET_S) * 1_000_000n);
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

function sqlite() {
  const db = new Database(":memory:");
  return { db, query: (sql, params = []) => db.query(sql).all(...params) };
}

/** A Chrome profile's `Bookmarks` file as Chrome writes it (trimmed to the fields readers use). */
const CHROME_BOOKMARKS = {
  checksum: "0",
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        { type: "url", name: "Docs", url: "https://docs.example.com/", date_added: chromiumTime(nowSeconds - 86_400) },
        {
          type: "folder",
          name: "Team",
          date_added: chromiumTime(nowSeconds - 172_800),
          children: [
            { type: "url", name: "Board", url: "https://tracker.example.org/board" },
            { type: "url", name: "Bookmarklet", url: "javascript:void(0)" },
            { type: "folder", name: "Empty", children: [] },
          ],
        },
      ],
    },
    other: { type: "folder", name: "Other bookmarks", children: [{ type: "url", name: "", url: "https://www.example.net/path" }] },
    synced: { type: "folder", name: "Mobile bookmarks", children: [] },
  },
};

/** Arc's sidebar file: favourites in a top-apps container, one space with a pinned folder; unpinned tabs left out. */
const ARC_SIDEBAR = {
  sidebar: {
    containers: [
      { global: {} },
      {
        spaces: [
          "space-1",
          { id: "space-1", title: "Work", containerIDs: ["unpinned", "c-unpinned", "pinned", "c-pinned"] },
        ],
        topAppsContainerIDs: [{ default: true }, "c-top"],
        items: [
          "c-top", { id: "c-top", childrenIds: ["fav-1"], data: { itemContainer: { containerType: { topApps: { _0: { default: true } } } } } },
          "fav-1", { id: "fav-1", parentID: "c-top", childrenIds: [], title: null, data: { tab: { savedTitle: "Mail", savedURL: "https://mail.example.com/" } } },
          "c-pinned", { id: "c-pinned", childrenIds: ["folder-1", "tab-2"], data: { itemContainer: { containerType: { spaceItems: { _0: "space-1" } } } } },
          "folder-1", { id: "folder-1", parentID: "c-pinned", title: "Projects", childrenIds: ["tab-1"], data: { list: {} } },
          "tab-1", { id: "tab-1", parentID: "folder-1", childrenIds: [], title: "Roadmap (renamed)", data: { tab: { savedTitle: "Roadmap", savedURL: "https://roadmap.example.com/" } } },
          "tab-2", { id: "tab-2", parentID: "c-pinned", childrenIds: [], title: null, data: { tab: { savedTitle: "Calendar", savedURL: "https://calendar.example.com/" } } },
          "c-unpinned", { id: "c-unpinned", childrenIds: ["tab-3"], data: { itemContainer: { containerType: { spaceItems: { _0: "space-1" } } } } },
          "tab-3", { id: "tab-3", parentID: "c-unpinned", childrenIds: [], data: { tab: { savedTitle: "Scratch", savedURL: "https://scratch.example.com/" } } },
        ],
      },
    ],
  },
};

function chromeHistoryDb() {
  const { db, query } = sqlite();
  db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)");
  const insert = db.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, ?)");
  insert.run("https://docs.example.com/", "Docs", 12, Number(chromiumTime(nowSeconds - 3_600)), 0);
  insert.run("https://old.example.com/", "Old", 3, Number(chromiumTime(nowSeconds - 200 * 86_400)), 0);
  insert.run("chrome://settings/", "Settings", 9, Number(chromiumTime(nowSeconds - 60)), 0);
  insert.run("https://hidden.example.com/", "Hidden", 1, Number(chromiumTime(nowSeconds - 60)), 1);
  insert.run("https://tracker.example.org/board", "Board", 40, Number(chromiumTime(nowSeconds - 7_200)), 0);
  return query;
}

function firefoxPlacesDb() {
  const { db, query } = sqlite();
  db.exec("CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER DEFAULT 0, last_visit_date INTEGER)");
  db.exec("CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT)");
  const place = db.prepare("INSERT INTO moz_places (id, url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, ?, ?)");
  place.run(1, "https://firefox.example.com/", "Firefox page", 5, 0, (nowSeconds - 600) * 1_000_000);
  place.run(2, "https://ancient.example.com/", "Ancient", 1, 0, (nowSeconds - 400 * 86_400) * 1_000_000);
  place.run(3, "place:sort=8", "Recent tags", 0, 0, null);
  place.run(4, "https://tagged.example.com/", "Tagged", 2, 0, (nowSeconds - 60) * 1_000_000);
  const mark = db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  mark.run(1, 2, null, 0, 0, "", 0, "root________");
  mark.run(2, 2, null, 1, 0, "menu", 0, "menu________");
  mark.run(3, 2, null, 1, 1, "toolbar", 0, "toolbar_____");
  mark.run(4, 2, null, 1, 2, "tags", 0, "tags________");
  mark.run(5, 2, null, 1, 3, "unfiled", 0, "unfiled_____");
  mark.run(10, 1, 1, 3, 0, "Firefox page", (nowSeconds - 100) * 1_000_000, "a1");
  mark.run(11, 2, null, 3, 1, "Reading", 0, "f1");
  mark.run(12, 1, 4, 11, 0, "Tagged page", 0, "a2");
  mark.run(13, 3, null, 11, 1, "", 0, "sep");
  mark.run(14, 1, 3, 2, 0, "Smart folder", 0, "a3");
  mark.run(15, 2, null, 4, 0, "a-tag", 0, "t1");
  mark.run(16, 1, 4, 15, 0, null, 0, "a4");
  return query;
}

function safariHistoryDb() {
  const { db, query } = sqlite();
  db.exec("CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER)");
  db.exec("CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)");
  db.exec(`INSERT INTO history_items VALUES (1, 'https://safari.example.com/', 4), (2, 'https://stale.example.com/', 1), (3, 'file:///etc/hosts', 1)`);
  const visit = db.prepare("INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)");
  visit.run(1, nowSeconds - 3_600 - APPLE_EPOCH_OFFSET_S, "Safari page (old title)");
  visit.run(1, nowSeconds - 60 - APPLE_EPOCH_OFFSET_S, "Safari page");
  visit.run(1, nowSeconds - 30 - APPLE_EPOCH_OFFSET_S, null);
  visit.run(2, nowSeconds - 100 * 86_400 - APPLE_EPOCH_OFFSET_S, "Stale");
  visit.run(3, nowSeconds - 60 - APPLE_EPOCH_OFFSET_S, "hosts");
  return query;
}

describe("bookmarks", () => {
  test("Chrome: folders as in the browser, http(s) links only, empty folders dropped", () => {
    const tree = parseChromiumBookmarks(JSON.stringify(CHROME_BOOKMARKS));
    expect(tree.map((folder) => folder.title)).toEqual(["Bookmarks bar", "Other bookmarks"]);
    const bar = tree[0];
    expect(bar.kind).toBe("folder");
    expect(bar.children[0]).toEqual({ kind: "url", title: "Docs", url: "https://docs.example.com/", addedAt: nowSeconds - 86_400 });
    expect(bar.children[1]).toMatchObject({ kind: "folder", title: "Team", children: [{ kind: "url", title: "Board" }] });
    expect(tree[1].children[0]).toMatchObject({ title: "example.net", url: "https://www.example.net/path" });
    expect(countBookmarks(tree)).toBe(3);
    expect(parseChromiumBookmarks("{not json")).toEqual([]);
  });

  test("Firefox: toolbar, menu and other bookmarks from places.sqlite; tags and place: queries left out", () => {
    const tree = readFirefoxBookmarks(firefoxPlacesDb());
    expect(tree.map((folder) => folder.title)).toEqual(["Bookmarks toolbar"]);
    expect(tree[0].children).toEqual([
      { kind: "url", title: "Firefox page", url: "https://firefox.example.com/", addedAt: nowSeconds - 100 },
      { kind: "folder", title: "Reading", addedAt: null, children: [{ kind: "url", title: "Tagged page", url: "https://tagged.example.com/", addedAt: null }] },
    ]);
  });

  test("Arc: favourites and each space's pinned tabs, folders kept, unpinned tabs left out", () => {
    const tree = parseArcSidebar(JSON.stringify(ARC_SIDEBAR));
    expect(tree).toEqual([
      { kind: "folder", title: "Favorites", addedAt: null, children: [{ kind: "url", title: "Mail", url: "https://mail.example.com/", addedAt: null }] },
      {
        kind: "folder", title: "Work", addedAt: null, children: [
          { kind: "folder", title: "Projects", addedAt: null, children: [{ kind: "url", title: "Roadmap (renamed)", url: "https://roadmap.example.com/", addedAt: null }] },
          { kind: "url", title: "Calendar", url: "https://calendar.example.com/", addedAt: null },
        ],
      },
    ]);
    expect(JSON.stringify(tree)).not.toContain("scratch.example.com");
  });

  test("Safari: the binary plist parses; Favorites, reading list and loose links, bookmarklets dropped", () => {
    const plist = parseBinaryPlist(fixture("Bookmarks.plist"));
    const tree = safariBookmarksTree(plist);
    expect(tree.map((folder) => folder.title)).toEqual(["Favorites", "Reading list", "Bookmarks"]);
    expect(tree[0].children[1]).toMatchObject({ kind: "folder", title: "Work", children: [{ title: "Board ✓", url: "https://tracker.example.org/board" }] });
    expect(tree[1].children[0]).toEqual({ kind: "url", title: "A long read", url: "https://blog.example.net/post", addedAt: Date.UTC(2026, 10, 1, 12) / 1000 });
    expect(countBookmarks(tree)).toBe(4);
    expect(JSON.stringify(tree)).not.toContain("javascript:");
  });

  test("a damaged plist is refused, never read past its end", () => {
    const good = fixture("Bookmarks.plist");
    expect(() => parseBinaryPlist(good.subarray(0, 20))).toThrow();
    expect(() => parseBinaryPlist(Buffer.from("not a plist at all, but long enough to have a trailer"))).toThrow("not-a-binary-plist");
    const broken = Buffer.from(good);
    broken.writeUInt32BE(0xffffff, broken.length - 4);
    expect(() => parseBinaryPlist(broken)).toThrow();
  });

  test("flattened rows keep the tree order and parents for storage", () => {
    const rows = flattenBookmarks(parseChromiumBookmarks(JSON.stringify(CHROME_BOOKMARKS)));
    expect(rows.map((row) => [row.parent, row.position, row.kind, row.title])).toEqual([
      [null, 0, "folder", "Bookmarks bar"],
      [0, 0, "url", "Docs"],
      [0, 1, "folder", "Team"],
      [2, 0, "url", "Board"],
      [null, 1, "folder", "Other bookmarks"],
      [4, 0, "url", "example.net"],
    ]);
    expect(importableUrl(" https://a.example/ ")).toBe("https://a.example/");
    expect(importableUrl("ftp://a.example/")).toBeNull();
  });
});

describe("history", () => {
  const since = historySince(NOW);

  test("Chrome: the last 90 days of web pages, newest first, hidden and internal pages left out", () => {
    const query = chromeHistoryDb();
    expect(readChromiumHistory(query, { since })).toEqual([
      { url: "https://docs.example.com/", title: "Docs", visits: 12, lastVisitAt: nowSeconds - 3_600 },
      { url: "https://tracker.example.org/board", title: "Board", visits: 40, lastVisitAt: nowSeconds - 7_200 },
    ]);
    expect(countChromiumHistory(query, { since })).toBe(2);
    expect(readChromiumHistory(query, { since, limit: 1 })).toHaveLength(1);
  });

  test("Firefox: moz_places within 90 days", () => {
    const query = firefoxPlacesDb();
    expect(readFirefoxHistory(query, { since }).map((row) => row.url)).toEqual(["https://tagged.example.com/", "https://firefox.example.com/"]);
    expect(countFirefoxHistory(query, { since })).toBe(2);
  });

  test("Safari: one row per page with its latest title and visit", () => {
    const query = safariHistoryDb();
    expect(readSafariHistory(query, { since })).toEqual([
      { url: "https://safari.example.com/", title: "Safari page", visits: 4, lastVisitAt: nowSeconds - 30 },
    ]);
    expect(countSafariHistory(query, { since })).toBe(1);
  });
});

describe("Safari cookies and access", () => {
  test("Cookies.binarycookies parses across pages with flags, dates and host-only marks", () => {
    const cookies = parseBinaryCookies(fixture("Cookies.binarycookies"));
    expect(cookies).toEqual([
      { host: ".example.com", hostOnly: false, name: "sid", value: "safari-session-fixture", path: "/", secure: true, httpOnly: true, sameSite: "unspecified", expiresAt: 2_000_000_000, lastAccessedAt: 1_795_000_000 - 60 },
      { host: "www.example.com", hostOnly: true, name: "theme", value: "dark", path: "/", secure: true, httpOnly: false, sameSite: "unspecified", expiresAt: 2_000_000_000, lastAccessedAt: 1_795_000_000 - 120 },
      { host: "bank.example", hostOnly: true, name: "auth", value: "bank-fixture", path: "/", secure: false, httpOnly: true, sameSite: "unspecified", expiresAt: 2_000_000_000, lastAccessedAt: 1_795_000_000 - 30 },
    ]);
  });

  test("a cut-off cookie file yields the whole cookies before the cut and nothing invented", () => {
    const full = fixture("Cookies.binarycookies");
    expect(() => parseBinaryCookies(Buffer.from("nope"))).toThrow();
    const cut = parseBinaryCookies(full.subarray(0, full.length - 120));
    expect(cut.every((cookie) => cookie.name && cookie.host)).toBe(true);
    expect(cut.length).toBeLessThan(3);
  });

  test("a refused read is a permission error (Full Disk Access), a missing file is not", () => {
    expect(isPermissionError(Object.assign(new Error("Operation not permitted"), { code: "EPERM" }))).toBe(true);
    expect(isPermissionError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(true);
    expect(isPermissionError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(false);
  });

  test("the Safari profile is listed on macOS only, with the container cookie file first", () => {
    const home = mkdtempSync(join(tmpdir(), "safari-home-"));
    expect(safariProfile({ platform: "darwin", home })).toBeNull();
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });
    writeFileSync(join(home, "Library", "Safari", "Bookmarks.plist"), fixture("Bookmarks.plist"));
    const cookieDir = join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies");
    mkdirSync(cookieDir, { recursive: true });
    writeFileSync(join(cookieDir, "Cookies.binarycookies"), fixture("Cookies.binarycookies"));
    expect(safariProfile({ platform: "darwin", home })).toMatchObject({
      id: "safari:Safari", browser: "safari", name: "Safari",
      files: { bookmarks: join(home, "Library", "Safari", "Bookmarks.plist"), history: null, cookies: join(cookieDir, "Cookies.binarycookies") },
    });
    expect(safariProfile({ platform: "linux", home })).toBeNull();
  });
});

describe("profiles on this machine", () => {
  test("Chrome profiles carry the names Chrome shows; Arc brings its sidebar; Firefox names come from profiles.ini", () => {
    const home = mkdtempSync(join(tmpdir(), "import-profiles-"));
    const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
    mkdirSync(join(chrome, "Default"), { recursive: true });
    writeFileSync(join(chrome, "Default", "Bookmarks"), JSON.stringify(CHROME_BOOKMARKS));
    mkdirSync(join(chrome, "Profile 1", "Network"), { recursive: true });
    writeFileSync(join(chrome, "Profile 1", "History"), "");
    writeFileSync(join(chrome, "Profile 1", "Network", "Cookies"), "");
    mkdirSync(join(chrome, "Profile 9"), { recursive: true });
    mkdirSync(join(chrome, "Crashpad"), { recursive: true });
    writeFileSync(join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work", user_name: "someone@example.com" }, "Profile 1": { name: "Personal\u0007" } } } }));
    const arc = join(home, "Library", "Application Support", "Arc");
    mkdirSync(join(arc, "User Data", "Default"), { recursive: true });
    writeFileSync(join(arc, "User Data", "Default", "History"), "");
    writeFileSync(join(arc, "StorableSidebar.json"), JSON.stringify(ARC_SIDEBAR));
    const firefoxRoot = join(home, "Library", "Application Support", "Firefox", "Profiles");
    mkdirSync(join(firefoxRoot, "abcd1234.default-release"), { recursive: true });
    writeFileSync(join(firefoxRoot, "abcd1234.default-release", "places.sqlite"), "");
    mkdirSync(join(firefoxRoot, "efgh5678.dev"), { recursive: true });
    writeFileSync(join(firefoxRoot, "efgh5678.dev", "cookies.sqlite"), "");
    writeFileSync(join(home, "Library", "Application Support", "Firefox", "profiles.ini"), "[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=Side project\nIsRelative=1\nPath=Profiles/efgh5678.dev\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd1234.default-release\nDefault=1\n");

    const profiles = importProfiles({ platform: "darwin", home });
    const view = profiles.map(({ id, browser, name, files }) => ({ id, browser, name, has: Object.entries(files).filter(([, path]) => path).map(([kind]) => kind) }));
    expect(view).toEqual([
      { id: "chrome:Default", browser: "chrome", name: "Work", has: ["bookmarks"] },
      { id: "chrome:Profile 1", browser: "chrome", name: "Personal", has: ["history", "cookies"] },
      { id: "arc:Default", browser: "arc", name: "Default", has: ["history", "sidebar"] },
      expect.objectContaining({ browser: "firefox", name: "Default", has: ["bookmarks", "history"] }),
      expect.objectContaining({ browser: "firefox", name: "Side project", has: ["cookies"] }),
    ]);
    expect(JSON.stringify(profiles)).not.toContain("someone@example.com");
    expect(firefoxProfileNames("[Profile0]\r\nName=Main\r\nPath=x\\\\y.main\r\n")).toEqual({ "y.main": "Main" });
  });

  test("availability: Windows refuses Chrome and Edge sign-ins with the reason; Linux reads the key ring; Safari is macOS only", () => {
    const windows = importSourceAvailability("win32");
    expect(windows.find((entry) => entry.browser === "chrome")).toEqual({
      browser: "chrome", label: "Google Chrome", importable: false,
      reason: "Chrome on Windows locks sign-ins to itself, so they can't be imported. Bookmarks and history can.",
    });
    expect(windows.find((entry) => entry.browser === "edge")?.reason).toContain("Edge on Windows locks sign-ins");
    expect(windows.find((entry) => entry.browser === "firefox")).toMatchObject({ importable: true, reason: null });
    expect(windows.some((entry) => entry.browser === "safari" || entry.browser === "arc")).toBe(false);
    expect(importSourceAvailability("linux").every((entry) => entry.importable)).toBe(true);
    expect(importSourceAvailability("darwin").map((entry) => entry.browser)).toEqual(IMPORT_BROWSERS.map((entry) => entry.browser));
    for (const entry of windows) expect(entry.reason ?? "").not.toMatch(/[–—]/);
  });
});

describe("Linux key ring", () => {
  function encrypt(prefix, key, plain) {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from(prefix, "latin1"), cipher.update(plain), cipher.final()]);
  }

  test("secret-tool is asked by the browser's attribute, in order, and a miss falls back", async () => {
    const calls = [];
    const execFile = (file, args, _options, callback) => {
      calls.push([file, ...args]);
      if (args[2] === "chromium") callback(null, "ring-password\n", "");
      else callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
    };
    expect(await readLinuxKeyringPassword("brave", { execFile })).toBe("ring-password");
    expect(calls).toEqual([["secret-tool", "lookup", "application", "brave"], ["secret-tool", "lookup", "application", "chromium"]]);
    expect(await readLinuxKeyringPassword("chrome", { execFile })).toBeNull();
    const missing = (_file, _args, _options, callback) => callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", "");
    expect(await readLinuxKeyringPassword("chrome", { execFile: missing })).toBeNull();
    expect(await readLinuxKeyringPassword("unknown-browser", { execFile })).toBeNull();
  });

  test("v10 values use the built-in password, v11 the key ring's, and the empty password when the ring says nothing", () => {
    const ring = linuxChromiumKeys("ring-password");
    const host = ".example.com";
    const hashed = (value) => Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
    const v10 = encrypt("v10", deriveChromiumKey("peanuts", { platform: "linux" }), hashed("basic-store"));
    const v11 = encrypt("v11", deriveChromiumKey("ring-password", { platform: "linux" }), hashed("keyring-store"));
    const v11Empty = encrypt("v11", deriveChromiumKey("", { platform: "linux" }), hashed("empty-ring"));
    expect(decryptChromiumValue(v10, ring, { hostKey: host, hashPrefixed: true })).toBe("basic-store");
    expect(decryptChromiumValue(v11, ring, { hostKey: host, hashPrefixed: true })).toBe("keyring-store");
    expect(decryptChromiumValue(v11Empty, ring, { hostKey: host, hashPrefixed: true })).toBe("empty-ring");
    expect(() => decryptChromiumValue(v11, linuxChromiumKeys(null), { hostKey: host, hashPrefixed: true })).toThrow();

    const { db, query } = sqlite();
    db.exec("CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24')");
    db.exec("CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT DEFAULT '', name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, samesite INTEGER)");
    const insert = db.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, samesite) VALUES (?, ?, '', ?, '/', ?, 1, 1, ?, 1, 1, 1)");
    insert.run(host, "a", v10, Number(chromiumTime(nowSeconds + 3_600)), Number(chromiumTime(nowSeconds)));
    insert.run(host, "b", v11, Number(chromiumTime(nowSeconds + 3_600)), Number(chromiumTime(nowSeconds)));
    const read = readChromiumCookies(query, { key: ring });
    expect(read.undecryptable).toBe(0);
    expect(read.cookies.map((cookie) => cookie.value)).toEqual(["basic-store", "keyring-store"]);
  });
});
