// @omnirush/browser-logins/bookmarks — bookmark trees from other browsers.
//
// Every reader returns the same shape: a list of top-level folders, each a
// tree of `{ kind: "folder", title, children }` and `{ kind: "url", title,
// url }` nodes, with `addedAt` in Unix seconds where the browser records it.
// Only http(s) links are kept (no `javascript:`, `chrome://` or `place:`).
// Nothing here opens a file: callers pass the file's text or a `query(sql)`
// over a copy of the browser's database.

/** Folders deeper than this are flattened into their parent; nobody files bookmarks 32 levels down. */
export const BOOKMARK_MAX_DEPTH = 32;
/** A tree stops growing at this many nodes so one enormous profile cannot stall the import. */
export const BOOKMARK_MAX_NODES = 50_000;

const CHROMIUM_EPOCH_OFFSET_US = 11_644_473_600n * 1_000_000n;
const TITLE_MAX = 300;
const URL_MAX = 4_096;

/** An http(s) URL worth importing, or null. */
export function importableUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url || url.length > URL_MAX || !/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname ? url : null;
  } catch {
    return null;
  }
}

function cleanTitle(value, fallback = "") {
  const title = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (title || fallback).slice(0, TITLE_MAX);
}

function chromiumSeconds(value) {
  try {
    const micros = BigInt(String(value ?? "0").trim() || "0");
    if (micros <= 0n) return null;
    return Number((micros - CHROMIUM_EPOCH_OFFSET_US) / 1_000_000n);
  } catch {
    return null;
  }
}

function budget() {
  return { left: BOOKMARK_MAX_NODES };
}

function urlNode(url, title, addedAt) {
  return { kind: "url", title: cleanTitle(title, hostOf(url)), url, addedAt };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function folderNode(title, children, addedAt = null) {
  return { kind: "folder", title: cleanTitle(title, "Folder"), children, addedAt };
}

/** Number of links in a tree (folders not counted). */
export function countBookmarks(nodes) {
  let total = 0;
  const stack = [...(Array.isArray(nodes) ? nodes : [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node?.kind === "url") total += 1;
    else if (node?.kind === "folder") stack.push(...node.children);
  }
  return total;
}

function chromiumChildren(children, depth, left) {
  const nodes = [];
  for (const child of Array.isArray(children) ? children : []) {
    if (left.left <= 0) break;
    if (!child || typeof child !== "object") continue;
    if (child.type === "url") {
      const url = importableUrl(child.url);
      if (!url) continue;
      left.left -= 1;
      nodes.push(urlNode(url, child.name, chromiumSeconds(child.date_added)));
    } else if (child.type === "folder") {
      const inner = chromiumChildren(child.children, depth + 1, left);
      if (depth >= BOOKMARK_MAX_DEPTH) {
        nodes.push(...inner);
      } else if (inner.length > 0) {
        left.left -= 1;
        nodes.push(folderNode(child.name, inner, chromiumSeconds(child.date_added)));
      }
    }
  }
  return nodes;
}

const CHROMIUM_ROOTS = [
  ["bookmark_bar", "Bookmarks bar"],
  ["other", "Other bookmarks"],
  ["synced", "Mobile bookmarks"],
];

/** Chrome, Edge, Brave, Vivaldi, Chromium and Arc: the profile's `Bookmarks` JSON file. */
export function parseChromiumBookmarks(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  const roots = data?.roots && typeof data.roots === "object" ? data.roots : {};
  const left = budget();
  const folders = [];
  for (const [key, fallback] of CHROMIUM_ROOTS) {
    const root = roots[key];
    if (!root || typeof root !== "object") continue;
    const children = chromiumChildren(root.children, 1, left);
    if (children.length > 0) folders.push(folderNode(root.name || fallback, children));
  }
  return folders;
}

const FIREFOX_ROOTS = [
  ["toolbar_____", "Bookmarks toolbar"],
  ["menu________", "Bookmarks menu"],
  ["unfiled_____", "Other bookmarks"],
  ["mobile______", "Mobile bookmarks"],
];

/** Firefox: `moz_bookmarks` joined to `moz_places` in a copy of `places.sqlite`. Tags are left out. */
export function readFirefoxBookmarks(query) {
  const rows = query(
    "SELECT b.id AS id, b.type AS type, b.parent AS parent, b.position AS position, b.title AS title, b.dateAdded AS dateAdded, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position",
  );
  const byParent = new Map();
  const byGuid = new Map();
  for (const row of rows) {
    const parent = Number(row.parent);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(row);
    if (typeof row.guid === "string") byGuid.set(row.guid, row);
  }
  const left = budget();
  const seconds = (value) => (Number(value) > 0 ? Math.trunc(Number(value) / 1_000_000) : null);
  const children = (id, depth, seen) => {
    const nodes = [];
    for (const row of byParent.get(Number(id)) ?? []) {
      if (left.left <= 0) break;
      const type = Number(row.type);
      if (type === 1) {
        const url = importableUrl(row.url);
        if (!url) continue;
        left.left -= 1;
        nodes.push(urlNode(url, row.title, seconds(row.dateAdded)));
      } else if (type === 2 && !seen.has(Number(row.id))) {
        seen.add(Number(row.id));
        const inner = children(row.id, depth + 1, seen);
        if (depth >= BOOKMARK_MAX_DEPTH) nodes.push(...inner);
        else if (inner.length > 0) {
          left.left -= 1;
          nodes.push(folderNode(row.title, inner, seconds(row.dateAdded)));
        }
      }
    }
    return nodes;
  };
  const folders = [];
  for (const [guid, title] of FIREFOX_ROOTS) {
    const root = byGuid.get(guid);
    if (!root) continue;
    const inner = children(root.id, 1, new Set([Number(root.id)]));
    if (inner.length > 0) folders.push(folderNode(title, inner));
  }
  return folders;
}

/** Arc lists items and spaces as `[id, object, id, object, ...]`; older files use a plain object. Both give a map. */
function arcEntries(value) {
  const map = new Map();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") map.set(entry.id, entry);
    }
  } else if (value && typeof value === "object") {
    for (const [id, entry] of Object.entries(value)) {
      if (entry && typeof entry === "object") map.set(typeof entry.id === "string" ? entry.id : id, entry);
    }
  }
  return map;
}

function arcIdsAfter(list, marker) {
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === marker && typeof list[index + 1] === "string") ids.push(list[index + 1]);
  }
  return ids;
}

/**
 * Arc (macOS): pinned tabs, folders and favourites from `StorableSidebar.json`.
 * Favourites become one folder; each space becomes a folder of its pinned tabs.
 * Unpinned tabs are left out (Arc archives them on its own).
 */
export function parseArcSidebar(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  const containers = Array.isArray(data?.sidebar?.containers) ? data.sidebar.containers : [];
  const items = new Map();
  const spaces = new Map();
  const topApps = [];
  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    for (const [id, item] of arcEntries(container.items)) items.set(id, item);
    for (const [id, space] of arcEntries(container.spaces)) spaces.set(id, space);
    if (Array.isArray(container.topAppsContainerIDs)) {
      for (const id of container.topAppsContainerIDs) if (typeof id === "string") topApps.push(id);
    }
  }
  const left = budget();
  const used = new Set();
  const children = (id, depth) => {
    const parent = items.get(id);
    const nodes = [];
    for (const childId of Array.isArray(parent?.childrenIds) ? parent.childrenIds : []) {
      if (left.left <= 0 || used.has(childId)) continue;
      const child = items.get(childId);
      if (!child) continue;
      used.add(childId);
      const tab = child.data?.tab;
      if (tab) {
        const url = importableUrl(tab.savedURL);
        if (!url) continue;
        left.left -= 1;
        nodes.push(urlNode(url, child.title || tab.savedTitle, null));
      } else if (child.data?.list || Array.isArray(child.childrenIds)) {
        const inner = children(childId, depth + 1);
        if (depth >= BOOKMARK_MAX_DEPTH) nodes.push(...inner);
        else if (inner.length > 0) {
          left.left -= 1;
          nodes.push(folderNode(child.title, inner));
        }
      }
    }
    return nodes;
  };
  const folders = [];
  const favourites = topApps.flatMap((id) => children(id, 1));
  if (favourites.length > 0) folders.push(folderNode("Favorites", favourites));
  for (const space of spaces.values()) {
    const pinned = arcIdsAfter(space.containerIDs, "pinned").flatMap((id) => children(id, 1));
    if (pinned.length > 0) folders.push(folderNode(space.title || "Space", pinned));
  }
  return folders;
}

/** Depth-first rows for storage: `parent` is the index of the parent row (or null), `position` the order inside it. */
export function flattenBookmarks(nodes) {
  const rows = [];
  const visit = (list, parent) => {
    list.forEach((node, position) => {
      const index = rows.length;
      rows.push({ parent, position, kind: node.kind, title: node.title, url: node.kind === "url" ? node.url : null, addedAt: node.addedAt ?? null });
      if (node.kind === "folder") visit(node.children, index);
    });
  };
  visit(Array.isArray(nodes) ? nodes : [], null);
  return rows;
}
