// @omnirush/browser-logins/history: recent browsing history from other browsers.
//
// Each reader takes a `query(sql, params)` over a *copy* of the browser's
// database and returns `{ url, title, visits, lastVisitAt }` rows (Unix
// seconds), newest first, http(s) only. Counts use the same filter so the
// number shown before an import is the number imported.

import { importableUrl } from "./bookmarks.mjs";

/** History older than this is left behind. */
export const HISTORY_DAYS = 90;
/** At most this many pages come over from one profile. */
export const HISTORY_LIMIT = 25_000;

const CHROMIUM_EPOCH_OFFSET_S = 11_644_473_600;
/** Seconds between 1970 and 2001 (Safari's and Core Data's epoch). */
export const APPLE_EPOCH_OFFSET_S = 978_307_200;
const HTTP_ONLY = "(url LIKE 'http://%' OR url LIKE 'https://%')";
const TITLE_MAX = 300;

/** The first second still imported, `days` before `now` (ms). */
export function historySince(now = Date.now(), days = HISTORY_DAYS) {
  return Math.trunc(now / 1000) - days * 86_400;
}

function row(url, title, visits, lastVisitAt) {
  const clean = importableUrl(url);
  if (!clean) return null;
  const text = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
  return { url: clean, title: text, visits: Math.max(1, Math.trunc(Number(visits) || 1)), lastVisitAt };
}

function rows(list, map) {
  const out = [];
  for (const entry of list) {
    const mapped = map(entry);
    if (mapped) out.push(mapped);
  }
  return out;
}

function columnNames(query, table) {
  try {
    return new Set(query(`PRAGMA table_info(${table})`).map((column) => String(column.name)));
  } catch {
    return new Set();
  }
}

function chromiumWhere(query) {
  return columnNames(query, "urls").has("hidden") ? `hidden = 0 AND last_visit_time >= ? AND ${HTTP_ONLY}` : `last_visit_time >= ? AND ${HTTP_ONLY}`;
}

/** Chromium times pass 2^53 microseconds, so the bound value is a BigInt (exact in every SQLite driver). */
const chromiumMicros = (seconds) => BigInt(Math.trunc(seconds) + CHROMIUM_EPOCH_OFFSET_S) * 1_000_000n;

/** Chrome-family `History` database (`urls` table; times in microseconds since 1601). */
export function readChromiumHistory(query, { since = historySince(), limit = HISTORY_LIMIT } = {}) {
  const list = query(
    `SELECT url, title, visit_count, last_visit_time FROM urls WHERE ${chromiumWhere(query)} ORDER BY last_visit_time DESC LIMIT ?`,
    [chromiumMicros(since), limit],
  );
  return rows(list, (entry) => row(entry.url, entry.title, entry.visit_count, Math.trunc(Number(entry.last_visit_time) / 1_000_000) - CHROMIUM_EPOCH_OFFSET_S));
}

export function countChromiumHistory(query, { since = historySince(), limit = HISTORY_LIMIT } = {}) {
  const [result] = query(`SELECT COUNT(*) AS n FROM urls WHERE ${chromiumWhere(query)}`, [chromiumMicros(since)]);
  return Math.min(limit, Number(result?.n ?? 0));
}

function firefoxWhere(query) {
  return columnNames(query, "moz_places").has("hidden") ? `hidden = 0 AND last_visit_date >= ? AND ${HTTP_ONLY}` : `last_visit_date >= ? AND ${HTTP_ONLY}`;
}

/** Firefox `places.sqlite` (`moz_places`; times in microseconds since 1970). */
export function readFirefoxHistory(query, { since = historySince(), limit = HISTORY_LIMIT } = {}) {
  const list = query(
    `SELECT url, title, visit_count, last_visit_date FROM moz_places WHERE ${firefoxWhere(query)} ORDER BY last_visit_date DESC LIMIT ?`,
    [since * 1_000_000, limit],
  );
  return rows(list, (entry) => row(entry.url, entry.title, entry.visit_count, Math.trunc(Number(entry.last_visit_date) / 1_000_000)));
}

export function countFirefoxHistory(query, { since = historySince(), limit = HISTORY_LIMIT } = {}) {
  const [result] = query(`SELECT COUNT(*) AS n FROM moz_places WHERE ${firefoxWhere(query)}`, [since * 1_000_000]);
  return Math.min(limit, Number(result?.n ?? 0));
}

const SAFARI_LATEST = `SELECT i.id AS id, i.url AS url, i.visit_count AS visit_count, MAX(v.visit_time) AS last_visit
  FROM history_items i JOIN history_visits v ON v.history_item = i.id
  WHERE (i.url LIKE 'http://%' OR i.url LIKE 'https://%')
  GROUP BY i.id HAVING last_visit >= ?`;

/** Safari `History.db` (`history_items` + `history_visits`; times in seconds since 2001). */
export function readSafariHistory(query, { since = historySince(), limit = HISTORY_LIMIT } = {}) {
  const list = query(
    `SELECT latest.url AS url, latest.visit_count AS visit_count, latest.last_visit AS last_visit,
       (SELECT t.title FROM history_visits t WHERE t.history_item = latest.id AND t.title IS NOT NULL AND t.title <> '' ORDER BY t.visit_time DESC LIMIT 1) AS title
     FROM (${SAFARI_LATEST}) latest ORDER BY latest.last_visit DESC LIMIT ?`,
    [since - APPLE_EPOCH_OFFSET_S, limit],
  );
  return rows(list, (entry) => row(entry.url, entry.title, entry.visit_count, Math.trunc(Number(entry.last_visit)) + APPLE_EPOCH_OFFSET_S));
}

export function countSafariHistory(query, { since = historySince(), limit = HISTORY_LIMIT } = {}) {
  const [result] = query(`SELECT COUNT(*) AS n FROM (${SAFARI_LATEST})`, [since - APPLE_EPOCH_OFFSET_S]);
  return Math.min(limit, Number(result?.n ?? 0));
}
