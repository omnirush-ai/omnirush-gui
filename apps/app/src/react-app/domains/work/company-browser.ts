// The company's Work browser settings (`browser` in the Work state, from the server's capabilities, for a member of a
// company): the apps everyone gets, whether people may import bookmarks and history, and sign-ins, from other
// browsers, and where Work links open. A missing block (no company, an older server) is the defaults, so every other
// account keeps the browser as it was. Nothing here is about anyone's browsing.
import { useMemo } from "react";

import type { OmniRushWorkBrowserApp, OmniRushWorkState } from "@/app/lib/omnirush-server";
import { isElectronRuntime } from "@/app/utils";

import { BRAND_MARKS } from "./brands";
import { useCachedWorkState } from "./work-state-cache";

export const WORK_BROWSER_MAX_APPS = 24;
export const WORK_BROWSER_NAME_MAX = 60;

export type WorkBrowserPolicy = {
  /** The company sent its settings (a member of a company, on a server that has them). */
  managed: boolean;
  /** Who set them, for "Turned off by <company>" and "Set by <company>". */
  orgName: string | null;
  apps: OmniRushWorkBrowserApp[];
  importBookmarks: boolean;
  importSignIns: boolean;
  /** Work links open in the app's browser (else the system browser). */
  linksInApp: boolean;
  /** People cannot change where Work links open. */
  linksLocked: boolean;
};

export const DEFAULT_WORK_BROWSER: WorkBrowserPolicy = {
  managed: false, orgName: null, apps: [], importBookmarks: true, importSignIns: true, linksInApp: true, linksLocked: false,
};

/** The settings in a Work state; Work off, no block or an older server: the defaults. */
export function workBrowserPolicy(state: Pick<OmniRushWorkState, "enabled" | "browser"> | null | undefined): WorkBrowserPolicy {
  const block = state?.enabled ? state.browser : null;
  if (!block) return DEFAULT_WORK_BROWSER;
  return {
    managed: true,
    orgName: block.org_name?.trim() || null,
    apps: block.apps ?? [],
    importBookmarks: block.import_bookmarks !== false,
    importSignIns: block.import_signins !== false,
    linksInApp: block.links_in_app !== false,
    linksLocked: block.links_locked === true,
  };
}

/** Where Work links open: the company's choice when it locked it, else the person's own (Settings > Browser), else the
 *  company's default. `choice` null: the person never chose. */
export function workLinksInApp(policy: Pick<WorkBrowserPolicy, "linksInApp" | "linksLocked">, choice: boolean | null): boolean {
  return policy.linksLocked || choice === null ? policy.linksInApp : choice;
}

/**
 * The company's browser settings for components with no Work client (the browser panel, the import screens, the link
 * router): what the last Work state said, read again only when it changes.
 */
export function useWorkBrowserPolicy(): WorkBrowserPolicy {
  const state = useCachedWorkState();
  const block = state?.browser ?? null;
  return useMemo(() => workBrowserPolicy(block ? { enabled: true, browser: block } : null), [block]);
}

let signInsRevoked = false;

/**
 * A company that turned sign-in import off: this computer stops reading sign-ins from other browsers (the import's
 * sign-in step and any "keep in step" sync), as in a managed context, until the app starts again and reads the
 * company's choice anew. Sign-ins already copied stay. Asked once per launch.
 */
export function enforceCompanySignIns(state: Pick<OmniRushWorkState, "enabled" | "browser"> | null | undefined): void {
  if (signInsRevoked || workBrowserPolicy(state).importSignIns) return;
  const bridge = isElectronRuntime() ? window.__OMNIRUSH_ELECTRON__?.browserLogins ?? null : null;
  if (!bridge) return;
  signInsRevoked = true;
  void bridge.disableForManagedContext().catch(() => {
    signInsRevoked = false;
  });
}

// ---------------------------------------------------------------- app addresses and marks

export type AppUrlCheck = { url: string } | { error: "empty" | "https" | "credentials" | "invalid" | "too_long" };

/** An app address as typed: `tms.acme.com` gets https://; http and anything that is not a plain web address are refused
 *  (the server checks again). */
export function checkAppUrl(input: string): AppUrlCheck {
  const value = input.trim();
  if (!value) return { error: "empty" };
  if (value.length > 2048) return { error: "too_long" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "invalid" };
  }
  if (url.protocol !== "https:") return { error: url.protocol === "http:" ? "https" : "invalid" };
  if (url.username || url.password) return { error: "credentials" };
  const host = url.hostname.replace(/\.$/, "");
  if (!host || /\s/.test(value) || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return { error: "invalid" };
  return { url: url.href };
}

/** The address without https:// and a trailing slash, for rows: `tms.acme.com/board`. */
export function appHost(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.host.replace(/^www\./, "")}${rest}`;
  } catch {
    return url;
  }
}

/** Well-known web apps by host: the mark from brands.ts and the name people call them. Most specific first. */
const KNOWN_APPS: readonly (readonly [host: string, brand: string, name: string])[] = [
  ["mail.google.com", "gmail", "Gmail"],
  ["drive.google.com", "drive", "Google Drive"],
  ["docs.google.com", "drive", "Google Docs"],
  ["sheets.google.com", "drive", "Google Sheets"],
  ["calendar.google.com", "calendar", "Google Calendar"],
  ["google.com", "google", "Google"],
  ["outlook.office.com", "outlook", "Outlook"],
  ["outlook.office365.com", "outlook", "Outlook"],
  ["outlook.live.com", "outlook", "Outlook"],
  ["teams.microsoft.com", "teams", "Microsoft Teams"],
  ["teams.live.com", "teams", "Microsoft Teams"],
  ["onedrive.live.com", "onedrive", "OneDrive"],
  ["sharepoint.com", "sharepoint", "SharePoint"],
  ["office.com", "microsoft", "Microsoft 365"],
  ["microsoft365.com", "microsoft", "Microsoft 365"],
  ["slack.com", "slack", "Slack"],
  ["discord.com", "discord", "Discord"],
  ["web.whatsapp.com", "whatsapp", "WhatsApp"],
  ["web.telegram.org", "telegram", "Telegram"],
  ["notion.so", "notion", "Notion"],
  ["notion.site", "notion", "Notion"],
  ["dropbox.com", "dropbox", "Dropbox"],
  ["box.com", "box", "Box"],
  ["figma.com", "figma", "Figma"],
  ["airtable.com", "airtable", "Airtable"],
  ["linear.app", "linear", "Linear"],
  ["asana.com", "asana", "Asana"],
  ["trello.com", "trello", "Trello"],
  ["clickup.com", "clickup", "ClickUp"],
  ["monday.com", "monday", "monday.com"],
  ["github.com", "github", "GitHub"],
  ["gitlab.com", "gitlab", "GitLab"],
  ["hubspot.com", "hubspot", "HubSpot"],
  ["lightning.force.com", "salesforce", "Salesforce"],
  ["force.com", "salesforce", "Salesforce"],
  ["salesforce.com", "salesforce", "Salesforce"],
  ["pipedrive.com", "pipedrive", "Pipedrive"],
  ["zendesk.com", "zendesk", "Zendesk"],
  ["intercom.com", "intercom", "Intercom"],
  ["frontapp.com", "front", "Front"],
  ["freshdesk.com", "freshdesk", "Freshdesk"],
  ["qbo.intuit.com", "quickbooks", "QuickBooks"],
  ["quickbooks.intuit.com", "quickbooks", "QuickBooks"],
  ["xero.com", "xero", "Xero"],
  ["stripe.com", "stripe", "Stripe"],
  ["myshopify.com", "shopify", "Shopify"],
  ["shopify.com", "shopify", "Shopify"],
  ["calendly.com", "calendly", "Calendly"],
  ["zoom.us", "zoom", "Zoom"],
];

function knownApp(url: string): { brand: string; name: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  // Jira and Confluence share a host on Atlassian Cloud; the wiki lives under /wiki.
  if (host.endsWith(".atlassian.net")) return parsed.pathname.startsWith("/wiki") ? { brand: "confluence", name: "Confluence" } : { brand: "jira", name: "Jira" };
  const found = KNOWN_APPS.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
  if (!found) return null;
  // OneDrive for work lives on <company>-my.sharepoint.com.
  if (found[1] === "sharepoint" && /-my\.sharepoint\.com$/.test(host)) return { brand: "onedrive", name: "OneDrive" };
  return BRAND_MARKS[found[1]] ? { brand: found[1], name: found[2] } : null;
}

/** The brands.ts mark for an app's address (null: the app's first letter stands in; never a fetched icon). */
export function appBrand(url: string): string | null {
  return knownApp(url)?.brand ?? null;
}

/** A name to start with for a new app: the name people call a well-known one; empty for any other address. */
export function suggestedAppName(url: string): string {
  return knownApp(url)?.name ?? "";
}
