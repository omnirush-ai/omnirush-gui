// The Work browser (/work/browser): the person's own tabs, full size beside Work. Plain rules shared by the page, the
// side panel and the app shell: which tab shows Browser home, the company's apps from the Work state, which brand a
// site is, what Ask puts in the composer, and the restore list kept on this computer. Nothing here is sent anywhere.
import type { BrowserPanelTab } from "@omnirush/browser-tabs";

/** Sent by the side panel's Expand: the shell opens the Work browser with the same tab. */
export const WORK_BROWSER_EXPAND_EVENT = "omnirush:work-browser-expand";

/**
 * "Site settings" in the Work browser's ".." menu: the site's camera, microphone and notification choices. Sent with
 * the page's address; the app's site permissions (Settings > Browser) answer it. Offered only where the desktop app
 * keeps those choices.
 */
export const WORK_BROWSER_SITE_SETTINGS_EVENT = "omnirush:work-browser-site-settings";

export function siteSettingsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const electron = (window as { __OMNIRUSH_ELECTRON__?: Record<string, unknown> }).__OMNIRUSH_ELECTRON__;
  return Boolean(electron && typeof electron === "object" && electron.browserSites);
}

export function openSiteSettings(url: string) {
  window.dispatchEvent(new CustomEvent<{ url: string }>(WORK_BROWSER_SITE_SETTINGS_EVENT, { detail: { url } }));
}

/** A new tab for a Work account opens Browser home (drawn by the app over a blank page), not a search site. */
export const WORK_BROWSER_NEW_TAB_URL = "about:blank";

/** Tiles each home section shows before "Show all (n)"; Recent shows rows. A filter appears past SEARCH_FROM. */
export const HOME_TILES_SHOWN = 8;
export const HOME_RECENT_SHOWN = 5;
export const HOME_SEARCH_FROM = 12;
/** Rows Recent lists when shown in full (the library answers at most this many; its filter finds the rest). */
export const HOME_RECENT_LIMIT = 50;

/** Live tabs the app keeps at once (browser-panel.mjs). Restored and suspended tabs hold no page and do not count. */
export const LIVE_TAB_LIMIT = 12;

/** Whether the tab is a blank page the person opened: the app shows Browser home there. Never an agent's tab. */
export function isBrowserHomeTab(tab: BrowserPanelTab): boolean {
  return (tab.url === "" || tab.url === "about:blank")
    && (tab.status === "ready" || tab.status === "loading")
    && !tab.automationProtected
    && (tab.browserTask?.status ?? "idle") === "idle"
    && !tab.browserApproval;
}

/** Tabs holding a page right now (every owner): what the live tab limit counts. */
export function liveTabCount(tabs: BrowserPanelTab[]): number {
  return tabs.filter((tab) => tab.status !== "suspended").length;
}

export type CompanyApp = { name: string; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The company's apps from the Work state's `browser` block (the `work.browser` capability, set by an owner or admin):
 * name and https address, at most 24. Missing or malformed reads as none, and the section stays hidden.
 */
export function companyApps(state: unknown): CompanyApp[] {
  const block = isRecord(state) && isRecord(state.browser) ? state.browser : null;
  const apps = block && Array.isArray(block.apps) ? block.apps : [];
  const seen = new Set<string>();
  const out: CompanyApp[] = [];
  for (const app of apps) {
    if (!isRecord(app) || typeof app.url !== "string" || typeof app.name !== "string") continue;
    const url = app.url.trim();
    const name = app.name.trim().slice(0, 80);
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== "https:" || !name || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    out.push({ name, url: parsed.href });
    if (out.length === 24) break;
  }
  return out;
}

export function siteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Hosts of the brands the app has marks for (brands.ts), so a tile shows the real logo. Longest match wins. */
const BRAND_HOSTS: Array<[string, string]> = [
  ["mail.google.com", "gmail"], ["drive.google.com", "drive"], ["docs.google.com", "drive"], ["sheets.google.com", "drive"],
  ["calendar.google.com", "calendar"], ["meet.google.com", "google"], ["google.com", "google"],
  ["outlook.office.com", "outlook"], ["outlook.office365.com", "outlook"], ["outlook.live.com", "outlook"],
  ["teams.microsoft.com", "teams"], ["teams.live.com", "teams"], ["onedrive.live.com", "onedrive"], ["sharepoint.com", "sharepoint"],
  ["office.com", "microsoft"], ["microsoft.com", "microsoft"], ["microsoft365.com", "microsoft"],
  ["slack.com", "slack"], ["discord.com", "discord"], ["web.whatsapp.com", "whatsapp"], ["web.telegram.org", "telegram"],
  ["notion.so", "notion"], ["notion.com", "notion"], ["dropbox.com", "dropbox"], ["box.com", "box"], ["figma.com", "figma"],
  ["airtable.com", "airtable"], ["atlassian.net", "jira"], ["linear.app", "linear"], ["asana.com", "asana"], ["trello.com", "trello"],
  ["clickup.com", "clickup"], ["monday.com", "monday"], ["github.com", "github"], ["gitlab.com", "gitlab"],
  ["hubspot.com", "hubspot"], ["salesforce.com", "salesforce"], ["force.com", "salesforce"], ["pipedrive.com", "pipedrive"],
  ["zendesk.com", "zendesk"], ["intercom.com", "intercom"], ["front.com", "front"], ["frontapp.com", "front"], ["freshdesk.com", "freshdesk"],
  ["intuit.com", "quickbooks"], ["xero.com", "xero"], ["stripe.com", "stripe"], ["shopify.com", "shopify"], ["myshopify.com", "shopify"],
  ["calendly.com", "calendly"], ["zoom.us", "zoom"],
];

/** The brand id (brands.ts) a site's address belongs to, or null (the tile shows the site's letter). */
export function siteBrand(url: string): string | null {
  const host = siteHost(url).toLowerCase();
  let best: [string, string] | null = null;
  for (const entry of BRAND_HOSTS) {
    if ((host === entry[0] || host.endsWith(`.${entry[0]}`)) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

/** What Ask puts in the Work chat composer: the page's title, its address and the selected text. Nothing is sent. */
export function askPagePrompt(page: { title: string; url: string; selection: string }, label: string): string {
  const lines = [`${label}: ${page.title.trim() || siteHost(page.url)}`, page.url];
  const selection = page.selection.trim();
  if (selection) lines.push("", ...selection.split(/\r?\n/).map((line) => `> ${line}`));
  return `${lines.join("\n")}\n\n`;
}

/** The restore list: the person's tabs (address and title), kept in this app's storage on this computer only. */
export const WORK_BROWSER_TABS_KEY = "omnirush:work-browser:tabs:v1";
const SAVED_LIMIT = 30;

export type SavedTabs = { tabs: Array<{ url: string; title: string }>; active: number };

const isPage = (url: string) => /^https?:\/\//i.test(url);

/** The restore list from the person's tabs now: web pages only (a blank home tab has nothing to bring back). */
export function savedTabsFrom(tabs: BrowserPanelTab[], activeTabId: string | null): SavedTabs {
  const pages = tabs.filter((tab) => isPage(tab.url)).slice(0, SAVED_LIMIT);
  const active = pages.findIndex((tab) => tab.id === activeTabId);
  return {
    tabs: pages.map((tab) => ({ url: tab.url, title: tab.label === tab.url ? "" : tab.label.slice(0, 300) })),
    active: Math.max(0, active),
  };
}

export function readSavedTabs(storage: Pick<Storage, "getItem"> = localStorage): SavedTabs {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(WORK_BROWSER_TABS_KEY) ?? "null");
    if (!isRecord(parsed) || !Array.isArray(parsed.tabs)) return { tabs: [], active: 0 };
    const tabs = parsed.tabs
      .filter((entry): entry is { url: string; title?: unknown } => isRecord(entry) && typeof entry.url === "string" && isPage(entry.url))
      .slice(0, SAVED_LIMIT)
      .map((entry) => ({ url: entry.url, title: typeof entry.title === "string" ? entry.title.slice(0, 300) : "" }));
    const active = typeof parsed.active === "number" && Number.isInteger(parsed.active) && parsed.active >= 0 && parsed.active < tabs.length ? parsed.active : 0;
    return { tabs, active };
  } catch {
    return { tabs: [], active: 0 };
  }
}

export function writeSavedTabs(saved: SavedTabs, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage) {
  try {
    if (saved.tabs.length === 0) storage.removeItem(WORK_BROWSER_TABS_KEY);
    else storage.setItem(WORK_BROWSER_TABS_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or unavailable: the tabs just do not come back.
  }
}

/** Forget the restore list (signing out of a company account clears it with the rest of the browser). */
export function clearWorkBrowserTabs(storage: Pick<Storage, "removeItem"> = localStorage) {
  try {
    storage.removeItem(WORK_BROWSER_TABS_KEY);
  } catch {
    // Nothing to clear.
  }
}
