// The built-in browser's library: bookmarks and history brought over from
// other browsers on this computer, plus pages the user stars, kept in
// `<userData>/browser-library.sqlite`.
//
// What crosses IPC: profile names, counts, titles and URLs for the address
// bar and the bookmarks menu. What never does: file paths, cookie values
// (sign-ins go through the login sync, which returns counts only) and saved
// passwords, which are never read. Nothing here is uploaded or added to a
// chat; the agent does not see the library.
//
// Every row belongs to the OmniRush account that was signed in when it was
// imported or starred, and only that account sees it: a company's imported
// history never shows under another account on the same computer. Signed
// out, the library is empty.
import { chmodSync, closeSync, openSync } from "node:fs";
import { copyFile, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { IMPORT_BROWSERS, importSourceAvailability } from "@omnirush/browser-logins";
import { importProfiles, sqliteCompanionFiles } from "@omnirush/browser-logins/node";
import {
  countBookmarks,
  flattenBookmarks,
  importableUrl,
  parseArcSidebar,
  parseChromiumBookmarks,
  readFirefoxBookmarks,
} from "@omnirush/browser-logins/bookmarks";
import {
  HISTORY_DAYS,
  countChromiumHistory,
  countFirefoxHistory,
  countSafariHistory,
  historySince,
  readChromiumHistory,
  readFirefoxHistory,
  readSafariHistory,
} from "@omnirush/browser-logins/history";
import { isPermissionError, parseBinaryPlist, safariBookmarksTree } from "@omnirush/browser-logins/safari";

/** Pages the user starred in the built-in browser. */
export const USER_SOURCE = "omnirush";
export const SUGGESTION_LIMIT = 8;
const TREE_LIMIT = 20_000;
const FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  parent INTEGER,
  title TEXT NOT NULL,
  url TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER,
  source TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bookmarks_parent ON bookmarks(parent, position);
CREATE INDEX IF NOT EXISTS bookmarks_url ON bookmarks(account, url);
CREATE INDEX IF NOT EXISTS bookmarks_source ON bookmarks(account, source);
CREATE TABLE IF NOT EXISTS history (
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 1,
  last_visit_at INTEGER,
  source TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account, url, source)
);
CREATE INDEX IF NOT EXISTS history_last ON history(last_visit_at);
CREATE TABLE IF NOT EXISTS imports (
  source TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL,
  name TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  bookmarks INTEGER,
  history INTEGER,
  sign_ins INTEGER,
  PRIMARY KEY (account, source)
);
`;
const LIBRARY_TABLES = ["bookmarks", "history", "imports"];

/** A library from before rows named their account: history and imports are rebuilt (their keys change), bookmarks gain the column. */
function migrateToAccounts(store) {
  const columns = (table) => store.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
  const old = LIBRARY_TABLES.filter((table) => {
    const names = columns(table);
    return names.length > 0 && !names.includes("account");
  });
  if (old.length === 0) return;
  store.exec("BEGIN");
  try {
    if (old.includes("bookmarks")) store.exec("ALTER TABLE bookmarks ADD COLUMN account TEXT NOT NULL DEFAULT ''; DROP INDEX IF EXISTS bookmarks_url; DROP INDEX IF EXISTS bookmarks_source;");
    if (old.includes("history")) store.exec("DROP INDEX IF EXISTS history_last; ALTER TABLE history RENAME TO history_before_accounts;");
    if (old.includes("imports")) store.exec("ALTER TABLE imports RENAME TO imports_before_accounts;");
    store.exec(SCHEMA);
    if (old.includes("history")) store.exec("INSERT INTO history (url, title, visits, last_visit_at, source) SELECT url, title, visits, last_visit_at, source FROM history_before_accounts; DROP TABLE history_before_accounts;");
    if (old.includes("imports")) store.exec("INSERT INTO imports (source, browser, name, imported_at, bookmarks, history, sign_ins) SELECT source, browser, name, imported_at, bookmarks, history, sign_ins FROM imports_before_accounts; DROP TABLE imports_before_accounts;");
    store.exec("COMMIT");
  } catch (error) {
    store.exec("ROLLBACK");
    throw error;
  }
}

const CHROMIUM_FAMILY = new Set(["chrome", "edge", "arc", "brave", "vivaldi", "chromium"]);
/** @type {Map<string, { label: string, short: string }>} */
const BROWSER_INFO = new Map(IMPORT_BROWSERS.map((entry) => [entry.browser, entry]));

function defaultOpenDatabase(filePath) {
  return new DatabaseSync(filePath ?? ":memory:");
}

/** Reasons a read failed, in a word the renderer turns into copy. Never a path or a value. */
function failureCode(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (isPermissionError(error) || /full_disk_access|full-disk-access/i.test(message)) return "full_disk_access";
  if (/cancelled/i.test(message)) return "cancelled";
  if (/app-bound|unsupported_encryption/i.test(message)) return "unsupported_encryption";
  if (/key_denied|key-denied/i.test(message)) return "key_denied";
  if (/key_unavailable|key-unavailable|key-not-found|no-key/i.test(message)) return "key_unavailable";
  if (/expired/i.test(message)) return "expired";
  if (/ENOENT|no longer available/i.test(message)) return "missing";
  if (/SQLITE_BUSY|database is locked|malformed|source-changing/i.test(message)) return "busy";
  return "read_failed";
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function bareUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
}

/**
 * @param {{
 *   dbPath?: string | null,
 *   platform?: string,
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   loginSync?: {
 *     inspectSignIns: (request: { sourceId: string }) => Promise<{ previewId: string, sites: Array<Record<string, unknown>>, cookieCount: number, undecryptable: number }>,
 *     importOnce: (request: { previewId: string, sites: string[] }) => Promise<{ sites: Array<{ site: string, synced: number, failed: number }> }>,
 *     configure: (request: { previewId: string, sites: string[] }) => Promise<{ sites: Array<{ site: string, synced: number, failed: number }> }>,
 *     signInsAllowed: () => Promise<boolean>,
 *     evalSources?: () => Array<{ id: string, browser: string, label: string, profile: string }>,
 *   } | null,
 *   openDatabase?: (filePath: string | null) => DatabaseSync,
 *   openSourceDatabase?: (filePath: string) => DatabaseSync,
 *   readSourceFile?: (filePath: string) => Promise<Buffer>,
 *   probeFile?: (filePath: string) => Promise<void>,
 *   openExternal?: (url: string) => Promise<void>,
 *   now?: () => number,
 *   account?: () => Promise<string | null>,
 * }} [options]
 */
export function createBrowserLibrary({
  dbPath = null,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  loginSync = null,
  openDatabase = defaultOpenDatabase,
  openSourceDatabase = (filePath) => new DatabaseSync(filePath),
  readSourceFile = (filePath) => readFile(filePath),
  probeFile = async (filePath) => {
    const handle = await open(filePath, "r");
    await handle.close();
  },
  openExternal = async () => undefined,
  now = Date.now,
  // The signed-in OmniRush account (null when signed out): the rows this library shows and writes.
  account = async () => null,
} = {}) {
  let db = null;
  let importing = null;
  const adopted = new Set();

  function database() {
    if (!db) {
      if (dbPath) {
        // Imported history is private: the file (and the WAL files SQLite copies its mode to) is the user's alone.
        try {
          closeSync(openSync(dbPath, "a", 0o600));
          chmodSync(dbPath, 0o600);
        } catch {
          // Windows has no POSIX modes; the profile folder's ACL applies.
        }
      }
      db = openDatabase(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      migrateToAccounts(db);
      db.exec(SCHEMA);
    }
    return db;
  }

  /**
   * The account whose rows to use, or null when signed out. Rows saved before
   * the library named accounts go to the first account that opens it.
   */
  async function owner() {
    const id = await Promise.resolve().then(account).catch(() => null);
    if (typeof id !== "string" || !id) return null;
    if (!adopted.has(id)) {
      transaction((store) => {
        for (const table of LIBRARY_TABLES) {
          store.prepare(`UPDATE OR IGNORE ${table} SET account = ? WHERE account = ''`).run(id);
          store.prepare(`DELETE FROM ${table} WHERE account = ''`).run();
        }
      });
      adopted.add(id);
    }
    return id;
  }

  async function requireOwner() {
    const id = await owner();
    if (!id) throw new Error("Sign in to OmniRush to keep bookmarks and history.");
    return id;
  }

  function transaction(work) {
    const store = database();
    store.exec("BEGIN");
    try {
      const result = work(store);
      store.exec("COMMIT");
      return result;
    } catch (error) {
      store.exec("ROLLBACK");
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Sources on this computer
  // -------------------------------------------------------------------------

  function evalProfiles() {
    return (loginSync?.evalSources?.() ?? []).map((source) => ({
      id: source.id,
      browser: "firefox",
      label: source.label,
      profile: source.profile,
      name: source.profile,
      files: { bookmarks: null, history: null, cookies: "eval", sidebar: null },
      keychainService: null,
    }));
  }

  function profiles() {
    return [
      ...importProfiles({ platform, home, localAppData: env.LOCALAPPDATA ?? null, appData: env.APPDATA ?? null }),
      ...evalProfiles(),
    ];
  }

  function findProfile(sourceId) {
    const profile = profiles().find((candidate) => candidate.id === sourceId);
    if (!profile) throw new Error("That browser profile is no longer available.");
    return profile;
  }

  /** Whether macOS lets this app read the file (Safari: Full Disk Access). */
  async function readable(filePath) {
    if (!filePath) return true;
    try {
      await probeFile(filePath);
      return true;
    } catch (error) {
      return !isPermissionError(error);
    }
  }

  function has(profile) {
    return {
      bookmarks: Boolean(profile.files.bookmarks || profile.files.sidebar),
      history: Boolean(profile.files.history),
      signIns: Boolean(profile.files.cookies),
    };
  }

  /**
   * Why sign-ins cannot come from a browser here, as a code the renderer words:
   * `policy_off` (sign-in import is off on this computer), `windows_locked`
   * (Chrome and Edge on Windows lock them to the browser), `windows_unsupported`.
   */
  function signInBlock(browser, allowed) {
    if (!allowed) return "policy_off";
    if (importSourceAvailability(platform).find((entry) => entry.browser === browser)?.importable === true) return null;
    return browser === "chrome" || browser === "edge" ? "windows_locked" : "windows_unsupported";
  }

  /** The browsers found on this computer, their profiles, and what each can bring. No paths. */
  async function sources() {
    const signInsAllowed = loginSync ? await loginSync.signInsAllowed() : false;
    const grouped = new Map();
    for (const profile of profiles()) {
      const info = BROWSER_INFO.get(profile.browser);
      if (!info) continue;
      if (!grouped.has(profile.browser)) {
        const reason = signInBlock(profile.browser, signInsAllowed);
        grouped.set(profile.browser, {
          browser: profile.browser,
          label: info.label,
          short: info.short,
          signIns: { importable: reason === null, reason },
          access: "ok",
          profiles: [],
        });
      }
      const group = grouped.get(profile.browser);
      if (profile.browser === "safari") {
        // Safari's own folder answers for all three; its app container is never touched just to look.
        const files = [profile.files.bookmarks, profile.files.history].filter(Boolean);
        const results = await Promise.all(files.map((file) => readable(file)));
        if (results.some((ok) => !ok)) group.access = "full_disk_access";
      }
      group.profiles.push({ id: profile.id, name: profile.name, profile: profile.profile, has: has(profile) });
    }
    const order = IMPORT_BROWSERS.map((entry) => entry.browser);
    return {
      platform,
      historyDays: HISTORY_DAYS,
      browsers: [...grouped.values()].sort((left, right) => order.indexOf(left.browser) - order.indexOf(right.browser)),
    };
  }

  // -------------------------------------------------------------------------
  // Reading a profile
  // -------------------------------------------------------------------------

  /** Run `work(query)` over a private copy of a browser database (the browser may hold the original open). */
  async function withSqliteCopy(filePath, work) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const directory = await mkdtemp(path.join(tmpdir(), "omnirush-browser-import-"));
      const copyPath = path.join(directory, "source.sqlite");
      try {
        const companions = sqliteCompanionFiles(filePath);
        await copyFile(filePath, copyPath);
        for (const companion of companions) await copyFile(companion, `${copyPath}${companion.slice(filePath.length)}`);
        const source = openSourceDatabase(copyPath);
        try {
          const query = (sql, params = []) => {
            const statement = source.prepare(sql);
            statement.setReadBigInts?.(true);
            return statement.all(...params);
          };
          return work(query);
        } finally {
          source.close();
        }
      } catch (error) {
        lastError = error;
        if (isPermissionError(error) || error?.code === "ENOENT") throw error;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    throw lastError ?? new Error("read_failed");
  }

  async function readBookmarkTree(profile) {
    const { files } = profile;
    if (CHROMIUM_FAMILY.has(profile.browser)) {
      const tree = files.bookmarks ? parseChromiumBookmarks(String(await readSourceFile(files.bookmarks))) : [];
      return files.sidebar ? [...parseArcSidebar(String(await readSourceFile(files.sidebar))), ...tree] : tree;
    }
    if (profile.browser === "firefox") return files.bookmarks ? withSqliteCopy(files.bookmarks, readFirefoxBookmarks) : [];
    if (profile.browser === "safari") return files.bookmarks ? safariBookmarksTree(parseBinaryPlist(await readSourceFile(files.bookmarks))) : [];
    return [];
  }

  function historyReader(profile) {
    if (CHROMIUM_FAMILY.has(profile.browser)) return { read: readChromiumHistory, count: countChromiumHistory };
    if (profile.browser === "firefox") return { read: readFirefoxHistory, count: countFirefoxHistory };
    if (profile.browser === "safari") return { read: readSafariHistory, count: countSafariHistory };
    return null;
  }

  async function readHistory(profile, { countOnly }) {
    const reader = historyReader(profile);
    if (!reader || !profile.files.history) return countOnly ? 0 : [];
    const since = historySince(now());
    return withSqliteCopy(profile.files.history, (query) => (countOnly ? reader.count(query, { since }) : reader.read(query, { since })));
  }

  async function settle(task) {
    try {
      return await task();
    } catch (error) {
      const code = failureCode(error);
      return { state: code === "full_disk_access" ? "blocked" : "failed", reason: code };
    }
  }

  async function signInsFor(profile) {
    if (!profile.files.cookies) return { state: "empty" };
    const reason = signInBlock(profile.browser, loginSync ? await loginSync.signInsAllowed() : false);
    if (reason) return { state: "unavailable", reason };
    return settle(async () => {
      const preview = await loginSync.inspectSignIns({ sourceId: profile.id });
      return preview.sites.length === 0
        ? { state: "empty" }
        : { state: "ready", previewId: preview.previewId, sites: preview.sites, cookieCount: preview.cookieCount };
    });
  }

  /**
   * What one profile can bring, counted before anything is copied: bookmarks,
   * pages from the last 90 days, and the sites it is signed in to (names only).
   */
  /** @param {{ sourceId?: unknown }} [request] */
  async function inspect({ sourceId } = {}) {
    const profile = findProfile(String(sourceId ?? ""));
    const [bookmarks, history, signIns] = await Promise.all([
      settle(async () => {
        const count = has(profile).bookmarks ? countBookmarks(await readBookmarkTree(profile)) : 0;
        return count > 0 ? { state: "ready", count } : { state: "empty" };
      }),
      settle(async () => {
        const count = await readHistory(profile, { countOnly: true });
        return count > 0 ? { state: "ready", count, days: HISTORY_DAYS } : { state: "empty", days: HISTORY_DAYS };
      }),
      signInsFor(profile),
    ]);
    return {
      source: { id: profile.id, browser: profile.browser, label: profile.label, name: profile.name },
      bookmarks,
      history,
      signIns,
      keepInStep: signIns.state === "ready",
    };
  }

  // -------------------------------------------------------------------------
  // Writing the library
  // -------------------------------------------------------------------------

  /** The imported folder's name: the browser, and the profile when the browser has more than one. */
  function importFolderTitle(profile) {
    const short = BROWSER_INFO.get(profile.browser)?.short ?? profile.label;
    const siblings = profiles().filter((candidate) => candidate.browser === profile.browser).length;
    return siblings > 1 ? `${short} \u00b7 ${profile.name}` : short;
  }

  function storeBookmarks(profile, tree, id) {
    const rows = flattenBookmarks(tree);
    return transaction((store) => {
      store.prepare("DELETE FROM bookmarks WHERE source = ? AND account = ?").run(profile.id, id);
      if (rows.length === 0) return 0;
      const top = store.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM bookmarks WHERE parent IS NULL AND account = ?").get(id);
      const insert = store.prepare("INSERT INTO bookmarks (parent, title, url, position, added_at, source, account) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const folder = insert.run(null, importFolderTitle(profile), null, Number(top?.next ?? 1), Math.trunc(now() / 1000), profile.id, id);
      const ids = [];
      for (const row of rows) {
        const parent = row.parent === null ? Number(folder.lastInsertRowid) : ids[row.parent];
        const inserted = insert.run(parent, row.title, row.url, row.position, row.addedAt, profile.id, id);
        ids.push(Number(inserted.lastInsertRowid));
      }
      return rows.filter((row) => row.kind === "url").length;
    });
  }

  function storeHistory(profile, entries, id) {
    return transaction((store) => {
      store.prepare("DELETE FROM history WHERE source = ? AND account = ?").run(profile.id, id);
      const insert = store.prepare("INSERT OR REPLACE INTO history (url, title, visits, last_visit_at, source, account) VALUES (?, ?, ?, ?, ?, ?)");
      for (const entry of entries) insert.run(entry.url, entry.title, entry.visits, entry.lastVisitAt, profile.id, id);
      return entries.length;
    });
  }

  function recordImport(profile, result, id) {
    const count = (part) => (part?.state === "done" ? part.count : null);
    const store = database();
    const previous = store.prepare("SELECT bookmarks, history, sign_ins FROM imports WHERE source = ? AND account = ?").get(profile.id, id);
    store.prepare("INSERT OR REPLACE INTO imports (source, account, browser, name, imported_at, bookmarks, history, sign_ins) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      profile.id,
      id,
      profile.browser,
      profile.name,
      Math.trunc(now() / 1000),
      count(result.bookmarks) ?? previous?.bookmarks ?? null,
      count(result.history) ?? previous?.history ?? null,
      count(result.signIns) ?? previous?.sign_ins ?? null,
    );
  }

  async function step(kind, emit, work) {
    emit({ kind, state: "running" });
    try {
      const outcome = await work();
      emit({ kind, ...outcome });
      return outcome;
    } catch (error) {
      const reason = failureCode(error);
      const outcome = { state: reason === "cancelled" ? "cancelled" : reason === "full_disk_access" ? "blocked" : "failed", reason };
      emit({ kind, ...outcome });
      return outcome;
    }
  }

  /**
   * Import what the user ticked. Bookmarks and history replace what came from
   * this profile before (importing twice never doubles them). Sign-ins go
   * through the login sync: once, or kept in step when asked.
   */
  /**
   * @param {{ sourceId?: unknown, bookmarks?: unknown, history?: unknown, signIns?: unknown }} [request]
   * @param {(progress: Record<string, unknown>) => void} [emit]
   */
  async function runImport(request = {}, emit = () => undefined) {
    if (importing) throw new Error("An import is already running.");
    const profile = findProfile(String(request.sourceId ?? ""));
    /** @type {{ previewId?: unknown, sites?: unknown, keepInStep?: unknown } | null} */
    const signIns = request.signIns && typeof request.signIns === "object" ? request.signIns : null;
    const sites = Array.isArray(signIns?.sites) ? signIns.sites.map(String) : [];
    importing = (async () => {
      const id = await requireOwner();
      const result = { source: { id: profile.id, browser: profile.browser, label: profile.label, name: profile.name }, bookmarks: null, history: null, signIns: null };
      if (request.bookmarks === true) {
        result.bookmarks = await step("bookmarks", emit, async () => ({ state: "done", count: storeBookmarks(profile, await readBookmarkTree(profile), id) }));
      }
      if (request.history === true) {
        result.history = await step("history", emit, async () => ({ state: "done", count: storeHistory(profile, await readHistory(profile, { countOnly: false }), id) }));
      }
      if (signIns && sites.length > 0 && loginSync) {
        const keepInStep = signIns.keepInStep === true;
        result.signIns = await step("signIns", emit, async () => {
          const request = { previewId: String(signIns.previewId ?? ""), sites };
          const outcome = keepInStep ? await loginSync.configure(request) : await loginSync.importOnce(request);
          const count = outcome.sites.filter((site) => site.synced > 0).length;
          const failed = outcome.sites.filter((site) => site.synced === 0 && site.failed > 0).length;
          return { state: "done", count, failed, keepInStep };
        });
      }
      if (result.bookmarks?.state === "done" || result.history?.state === "done" || result.signIns?.state === "done") recordImport(profile, result, id);
      return result;
    })();
    try {
      return await importing;
    } finally {
      importing = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reading the library (address bar, bookmarks menu, new tab)
  // -------------------------------------------------------------------------

  /** The bookmarks menu: the user's own bookmarks first, then one folder per imported profile. */
  async function bookmarkTree() {
    const id = await owner();
    if (!id) return [];
    const rows = database().prepare(
      "SELECT b.id AS id, b.parent AS parent, b.title AS title, b.url AS url, b.source AS source, i.browser AS browser FROM bookmarks b LEFT JOIN imports i ON i.source = b.source AND i.account = b.account AND b.parent IS NULL WHERE b.account = ? ORDER BY CASE WHEN b.parent IS NULL AND b.source = ? THEN 0 ELSE 1 END, b.position, b.id LIMIT ?",
    ).all(id, USER_SOURCE, TREE_LIMIT);
    const nodes = new Map();
    const roots = [];
    for (const row of rows) {
      const id = Number(row.id);
      nodes.set(id, row.url
        ? { id, title: String(row.title), url: String(row.url) }
        : { id, title: String(row.title), children: [], ...(row.browser ? { browser: String(row.browser) } : {}) });
    }
    for (const row of rows) {
      const node = nodes.get(Number(row.id));
      const parent = row.parent === null ? null : nodes.get(Number(row.parent));
      if (parent && "children" in parent) parent.children.push(node);
      else if (row.parent === null) roots.push(node);
    }
    return roots;
  }

  /** Bookmarks for the new-tab page: the ones visited most, then the user's own. */
  async function topBookmarks(limit = SUGGESTION_LIMIT) {
    const id = await owner();
    if (!id) return [];
    const size = Math.max(1, Math.min(24, Math.trunc(Number(limit) || SUGGESTION_LIMIT)));
    return database().prepare(`
      SELECT b.url AS url, b.title AS title, COALESCE(h.visits, 0) AS visits
      FROM bookmarks b LEFT JOIN (SELECT url, SUM(visits) AS visits FROM history WHERE account = ? GROUP BY url) h ON h.url = b.url
      WHERE b.url IS NOT NULL AND b.account = ?
      GROUP BY b.url
      ORDER BY visits DESC, CASE WHEN b.source = ? THEN 0 ELSE 1 END, b.id
      LIMIT ?`).all(id, id, USER_SOURCE, size).map((row) => ({ url: String(row.url), title: String(row.title) }));
  }

  /**
   * Address bar suggestions for what was typed: a site typed from its start
   * ranks first, bookmarks and often-visited pages next. At most eight.
   */
  async function suggest(query) {
    const text = String(query ?? "").trim().toLowerCase();
    if (!text || text.length > 200) return [];
    const id = await owner();
    if (!id) return [];
    const like = `%${escapeLike(text)}%`;
    const store = database();
    const marks = store.prepare("SELECT url, title FROM bookmarks WHERE account = ? AND url IS NOT NULL AND (lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\') LIMIT 200").all(id, like, like);
    const pages = store.prepare("SELECT url, MAX(title) AS title, SUM(visits) AS visits, MAX(last_visit_at) AS last FROM history WHERE account = ? AND (lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\') GROUP BY url ORDER BY visits DESC LIMIT 200").all(id, like, like);
    const nowSeconds = Math.trunc(now() / 1000);
    const visited = new Map(pages.map((row) => [String(row.url), { visits: Number(row.visits ?? 1), last: Number(row.last ?? 0) }]));
    const scored = new Map();
    const score = (url, title, bookmark, visits, last) => {
      const bare = bareUrl(url);
      const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
      let value = 0;
      if (bare.startsWith(text)) value += 100;
      else if (bare.includes(`.${text}`) || bare.includes(`/${text}`)) value += 40;
      else if (bare.includes(text)) value += 20;
      if (words.some((word) => word.startsWith(text))) value += 30;
      else if (title.toLowerCase().includes(text)) value += 10;
      if (bookmark) value += 25;
      // A site's front page is what a typed name usually means.
      if (/^[^/]+\/?$/.test(bare)) value += 15;
      value += Math.min(30, Math.log2(1 + visits) * 5);
      if (last && nowSeconds - last < 7 * 86_400) value += 10;
      return value;
    };
    const add = (url, title, bookmark, visits, last) => {
      const key = url.replace(/\/$/, "");
      const value = score(url, title, bookmark, visits, last);
      const existing = scored.get(key);
      if (!existing || value > existing.score) {
        scored.set(key, { url, title: title || (existing?.title ?? ""), kind: bookmark || existing?.kind === "bookmark" ? "bookmark" : "history", score: value });
      } else if (bookmark) existing.kind = "bookmark";
    };
    for (const row of pages) add(String(row.url), String(row.title ?? ""), false, Number(row.visits ?? 1), Number(row.last ?? 0));
    for (const row of marks) {
      const seen = visited.get(String(row.url));
      add(String(row.url), String(row.title ?? ""), true, seen?.visits ?? 0, seen?.last ?? 0);
    }
    return [...scored.values()]
      .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
      .slice(0, SUGGESTION_LIMIT)
      .map(({ url, title, kind }) => ({ url, title, kind }));
  }

  async function isBookmarked(url) {
    const clean = importableUrl(url);
    if (!clean) return false;
    const id = await owner();
    if (!id) return false;
    return Boolean(database().prepare("SELECT 1 AS found FROM bookmarks WHERE account = ? AND url = ? LIMIT 1").get(id, clean));
  }

  /** Star or unstar a page. Unstarring removes the page from every folder, as the filled star promised. */
  /** @param {{ url?: unknown, title?: unknown }} [request] */
  async function toggleBookmark({ url, title } = {}) {
    const clean = importableUrl(url);
    if (!clean) throw new Error("Only web pages can be bookmarked.");
    const id = await requireOwner();
    return transaction((store) => {
      if (store.prepare("SELECT 1 AS found FROM bookmarks WHERE account = ? AND url = ? LIMIT 1").get(id, clean)) {
        store.prepare("DELETE FROM bookmarks WHERE account = ? AND url = ?").run(id, clean);
        return { bookmarked: false };
      }
      const next = store.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM bookmarks WHERE parent IS NULL AND source = ? AND account = ?").get(USER_SOURCE, id);
      const label = typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : bareUrl(clean).split("/")[0];
      store.prepare("INSERT INTO bookmarks (parent, title, url, position, added_at, source, account) VALUES (NULL, ?, ?, ?, ?, ?, ?)").run(label, clean, Number(next?.next ?? 1), Math.trunc(now() / 1000), USER_SOURCE, id);
      return { bookmarked: true };
    });
  }

  /** What is in the library and where it came from, for Settings. */
  async function summary() {
    const id = await owner();
    if (!id) return { imports: [], bookmarks: 0, history: 0 };
    const store = database();
    const imports = store.prepare("SELECT source, browser, name, imported_at, bookmarks, history, sign_ins FROM imports WHERE account = ? ORDER BY imported_at DESC").all(id).map((row) => ({
      sourceId: String(row.source),
      browser: String(row.browser),
      label: BROWSER_INFO.get(String(row.browser))?.label ?? String(row.browser),
      name: String(row.name),
      importedAt: Number(row.imported_at) * 1000,
      bookmarks: row.bookmarks === null ? null : Number(row.bookmarks),
      history: row.history === null ? null : Number(row.history),
      signIns: row.sign_ins === null ? null : Number(row.sign_ins),
    }));
    const bookmarks = Number(store.prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE account = ? AND url IS NOT NULL").get(id)?.n ?? 0);
    const history = Number(store.prepare("SELECT COUNT(DISTINCT url) AS n FROM history WHERE account = ?").get(id)?.n ?? 0);
    return { imports, bookmarks, history };
  }

  /** Forget imported bookmarks and history. Starred pages and sign-ins stay (sign out of sites in the list below). */
  async function clear() {
    const id = await owner();
    if (id) {
      transaction((store) => {
        store.prepare("DELETE FROM bookmarks WHERE account = ? AND source <> ?").run(id, USER_SOURCE);
        store.prepare("DELETE FROM history WHERE account = ?").run(id);
        store.prepare("DELETE FROM imports WHERE account = ?").run(id);
      });
    }
    return summary();
  }

  async function openFullDiskAccess() {
    if (platform !== "darwin") return false;
    await openExternal(FULL_DISK_ACCESS_URL);
    return true;
  }

  function registerIpc(ipcMain) {
    const request = (value) => (value && typeof value === "object" ? value : {});
    ipcMain.handle("omnirush:browser-library:sources", () => sources());
    ipcMain.handle("omnirush:browser-library:inspect", (_event, value) => inspect(request(value)));
    ipcMain.handle("omnirush:browser-library:import", (event, value) => runImport(request(value), (progress) => {
      if (!event.sender.isDestroyed?.()) event.sender.send("omnirush:browser-library:progress", progress);
    }));
    ipcMain.handle("omnirush:browser-library:bookmarks", () => bookmarkTree());
    ipcMain.handle("omnirush:browser-library:top", (_event, limit) => topBookmarks(limit));
    ipcMain.handle("omnirush:browser-library:suggest", (_event, query) => suggest(query));
    ipcMain.handle("omnirush:browser-library:isBookmarked", (_event, url) => isBookmarked(url));
    ipcMain.handle("omnirush:browser-library:toggleBookmark", (_event, value) => toggleBookmark(request(value)));
    ipcMain.handle("omnirush:browser-library:summary", () => summary());
    ipcMain.handle("omnirush:browser-library:clear", () => clear());
    ipcMain.handle("omnirush:browser-library:openFullDiskAccess", () => openFullDiskAccess());
  }

  function close() {
    db?.close();
    db = null;
  }

  return {
    sources,
    inspect,
    runImport,
    bookmarkTree,
    topBookmarks,
    suggest,
    isBookmarked,
    toggleBookmark,
    summary,
    clear,
    openFullDiskAccess,
    registerIpc,
    close,
  };
}
