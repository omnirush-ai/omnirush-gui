// @omnirush/browser-logins/safari — Safari's bookmarks, history and cookies (macOS).
//
// Safari keeps all three where macOS only lets apps with Full Disk Access read
// them. The readers here parse what the caller already read: `Bookmarks.plist`
// (a binary property list), `History.db` (see history.mjs) and
// `Cookies.binarycookies`. A read that macOS refuses comes back as EPERM;
// `isPermissionError` tells the caller to show the Full Disk Access steps.

import { statSync } from "node:fs";
import { join } from "node:path";

import { importableUrl } from "./bookmarks.mjs";

const APPLE_EPOCH_OFFSET_S = 978_307_200;
const MAX_DEPTH = 64;

/** Where Safari keeps its data under a home directory. Cookies moved into the app's container on newer macOS. */
export function safariPaths(home) {
  return {
    bookmarks: join(home, "Library", "Safari", "Bookmarks.plist"),
    history: join(home, "Library", "Safari", "History.db"),
    cookies: [
      join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies"),
      join(home, "Library", "Cookies", "Cookies.binarycookies"),
    ],
  };
}

/** macOS refused the read (no Full Disk Access) rather than the file being missing. */
export function isPermissionError(error) {
  const code = error && typeof error === "object" ? error.code : null;
  return code === "EPERM" || code === "EACCES";
}

function present(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    // A stat macOS refuses still means the file is there behind the privacy wall.
    return isPermissionError(error);
  }
}

/** The Safari profile on macOS (Safari has one), with the files it may hold. Null elsewhere. */
export function safariProfile({ platform, home }) {
  if (platform !== "darwin") return null;
  const paths = safariPaths(home);
  const cookies = paths.cookies.find(present) ?? null;
  const bookmarks = present(paths.bookmarks) ? paths.bookmarks : null;
  const history = present(paths.history) ? paths.history : null;
  if (!cookies && !bookmarks && !history) return null;
  return {
    id: "safari:Safari",
    browser: "safari",
    label: "Safari",
    profile: "Safari",
    name: "Safari",
    files: { bookmarks, history, cookies, sidebar: null },
    keychainService: null,
  };
}

// ---------------------------------------------------------------------------
// Binary property lists (bplist00)
// ---------------------------------------------------------------------------

function readUInt(buffer, offset, size) {
  let value = 0n;
  for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(buffer[offset + index]);
  return value;
}

/**
 * Parse a binary property list into plain values: dictionaries become objects,
 * arrays arrays, data `Buffer`s, dates `Date`s, UIDs `{ uid }`. Throws on
 * anything that is not a well-formed `bplist00`.
 */
export function parseBinaryPlist(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buffer.length < 40 || buffer.subarray(0, 8).toString("latin1") !== "bplist00") throw new Error("not-a-binary-plist");
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const objectCount = Number(readUInt(trailer, 8, 8));
  const topObject = Number(readUInt(trailer, 16, 8));
  const tableOffset = Number(readUInt(trailer, 24, 8));
  if (!offsetSize || !refSize || tableOffset + objectCount * offsetSize > buffer.length - 32) throw new Error("bad-plist-trailer");
  const offsets = [];
  for (let index = 0; index < objectCount; index += 1) offsets.push(Number(readUInt(buffer, tableOffset + index * offsetSize, offsetSize)));

  const lengthAt = (offset, marker) => {
    const low = marker & 0x0f;
    if (low !== 0x0f) return { length: low, start: offset + 1 };
    const intMarker = buffer[offset + 1];
    if ((intMarker & 0xf0) !== 0x10) throw new Error("bad-plist-length");
    const size = 1 << (intMarker & 0x0f);
    return { length: Number(readUInt(buffer, offset + 2, size)), start: offset + 2 + size };
  };

  const parse = (ref, depth, path) => {
    if (depth > MAX_DEPTH || path.has(ref)) throw new Error("bad-plist-nesting");
    const offset = offsets[ref];
    if (offset === undefined || offset >= buffer.length) throw new Error("bad-plist-ref");
    const marker = buffer[offset];
    const type = marker & 0xf0;
    switch (type) {
      case 0x00:
        return marker === 0x08 ? false : marker === 0x09 ? true : null;
      case 0x10: {
        const size = 1 << (marker & 0x0f);
        const value = readUInt(buffer, offset + 1, size);
        return size === 8 ? Number(BigInt.asIntN(64, value)) : Number(value);
      }
      case 0x20: {
        const size = 1 << (marker & 0x0f);
        return size === 4 ? buffer.readFloatBE(offset + 1) : buffer.readDoubleBE(offset + 1);
      }
      case 0x30:
        return new Date((buffer.readDoubleBE(offset + 1) + APPLE_EPOCH_OFFSET_S) * 1000);
      case 0x40: {
        const { length, start } = lengthAt(offset, marker);
        return Buffer.from(buffer.subarray(start, start + length));
      }
      case 0x50: {
        const { length, start } = lengthAt(offset, marker);
        return buffer.subarray(start, start + length).toString("latin1");
      }
      case 0x60: {
        const { length, start } = lengthAt(offset, marker);
        const bytes = Buffer.from(buffer.subarray(start, start + length * 2));
        bytes.swap16();
        return bytes.toString("utf16le");
      }
      case 0x80:
        return { uid: Number(readUInt(buffer, offset + 1, (marker & 0x0f) + 1)) };
      case 0xa0: {
        const { length, start } = lengthAt(offset, marker);
        const next = new Set(path).add(ref);
        const list = [];
        for (let index = 0; index < length; index += 1) list.push(parse(Number(readUInt(buffer, start + index * refSize, refSize)), depth + 1, next));
        return list;
      }
      case 0xd0: {
        const { length, start } = lengthAt(offset, marker);
        const next = new Set(path).add(ref);
        const object = {};
        for (let index = 0; index < length; index += 1) {
          const key = parse(Number(readUInt(buffer, start + index * refSize, refSize)), depth + 1, next);
          const value = parse(Number(readUInt(buffer, start + (length + index) * refSize, refSize)), depth + 1, next);
          if (typeof key === "string" && key !== "__proto__") object[key] = value;
        }
        return object;
      }
      default:
        throw new Error("bad-plist-object");
    }
  };

  return parse(topObject, 0, new Set());
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

const SAFARI_FOLDER_TITLES = {
  BookmarksBar: "Favorites",
  BookmarksMenu: "Bookmarks menu",
  "com.apple.ReadingList": "Reading list",
};

function safariChildren(list, depth, left) {
  const nodes = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (left.left <= 0 || !entry || typeof entry !== "object") continue;
    if (entry.WebBookmarkType === "WebBookmarkTypeLeaf") {
      const url = importableUrl(entry.URLString);
      if (!url) continue;
      left.left -= 1;
      const title = entry.URIDictionary && typeof entry.URIDictionary === "object" ? entry.URIDictionary.title : null;
      const added = entry.ReadingList && entry.ReadingList.DateAdded instanceof Date ? Math.trunc(entry.ReadingList.DateAdded.getTime() / 1000) : null;
      nodes.push({ kind: "url", title: cleanTitle(title, url), url, addedAt: added });
    } else if (entry.WebBookmarkType === "WebBookmarkTypeList") {
      const inner = safariChildren(entry.Children, depth + 1, left);
      if (depth >= 32) nodes.push(...inner);
      else if (inner.length > 0) {
        left.left -= 1;
        nodes.push({ kind: "folder", title: cleanTitle(SAFARI_FOLDER_TITLES[entry.Title] ?? entry.Title, "Folder"), children: inner, addedAt: null });
      }
    }
  }
  return nodes;
}

function cleanTitle(value, fallback) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, 300);
}

/**
 * Safari's bookmark tree from a parsed `Bookmarks.plist`: Favorites, the
 * bookmarks menu, the reading list and any top-level folders. Loose top-level
 * links go into one "Bookmarks" folder. History proxies are skipped.
 */
export function safariBookmarksTree(plist) {
  const left = { left: 50_000 };
  const top = safariChildren(plist?.Children, 1, left);
  const folders = top.filter((node) => node.kind === "folder");
  const loose = top.filter((node) => node.kind === "url");
  if (loose.length > 0) folders.push({ kind: "folder", title: "Bookmarks", children: loose, addedAt: null });
  return folders;
}

// ---------------------------------------------------------------------------
// Cookies.binarycookies
// ---------------------------------------------------------------------------

function cString(buffer, start, end) {
  if (start <= 0 || start >= end) return "";
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  return buffer.subarray(start, stop).toString("utf8");
}

/**
 * Parse Safari's `Cookies.binarycookies` into normalized cookies. Pages and
 * cookies that do not fit their declared sizes are skipped, never read past.
 */
export function parseBinaryCookies(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buffer.length < 8 || buffer.subarray(0, 4).toString("latin1") !== "cook") throw new Error("not-binary-cookies");
  const pageCount = buffer.readUInt32BE(4);
  if (8 + pageCount * 4 > buffer.length) throw new Error("bad-binary-cookies");
  const cookies = [];
  let pageOffset = 8 + pageCount * 4;
  for (let page = 0; page < pageCount; page += 1) {
    const pageSize = buffer.readUInt32BE(8 + page * 4);
    const pageEnd = pageOffset + pageSize;
    if (pageSize < 8 || pageEnd > buffer.length) break;
    const cookieCount = buffer.readUInt32LE(pageOffset + 4);
    for (let index = 0; index < cookieCount; index += 1) {
      const pointer = pageOffset + 8 + index * 4;
      if (pointer + 4 > pageEnd) break;
      const start = pageOffset + buffer.readUInt32LE(pointer);
      if (start + 56 > pageEnd) continue;
      const size = buffer.readUInt32LE(start);
      const end = Math.min(start + size, pageEnd);
      if (size < 56 || end < start + 56) continue;
      const flags = buffer.readUInt32LE(start + 8);
      const host = cString(buffer, start + buffer.readUInt32LE(start + 16), end);
      const name = cString(buffer, start + buffer.readUInt32LE(start + 20), end);
      const path = cString(buffer, start + buffer.readUInt32LE(start + 24), end) || "/";
      const value = cString(buffer, start + buffer.readUInt32LE(start + 28), end);
      const expiry = buffer.readDoubleLE(start + 40);
      const created = buffer.readDoubleLE(start + 48);
      if (!host || !name) continue;
      cookies.push({
        host,
        hostOnly: !host.startsWith("."),
        name,
        value,
        path,
        secure: (flags & 1) === 1,
        httpOnly: (flags & 4) === 4,
        sameSite: "unspecified",
        expiresAt: Number.isFinite(expiry) && expiry > 0 ? Math.trunc(expiry + APPLE_EPOCH_OFFSET_S) : null,
        // Safari keeps no last-access time; the creation time orders sites well enough.
        lastAccessedAt: Number.isFinite(created) && created > 0 ? Math.trunc(created + APPLE_EPOCH_OFFSET_S) : null,
      });
    }
    pageOffset = pageEnd;
  }
  return cookies;
}
