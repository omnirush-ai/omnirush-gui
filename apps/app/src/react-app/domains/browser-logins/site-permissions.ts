// Calls and alerts in the built-in browser (Work): camera, microphone, notifications and screen sharing ask per site,
// in the person's own tabs only (the panel with no chat selected, and the Work browser). A chat's tabs are the agent's
// and keep every one of them denied. Choices are remembered on this computer and never sent anywhere. Accounts without
// Work keep the browser exactly as before: the app turns the questions on only for them (useSitePromptsGate).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { BrowserSiteKind, BrowserSitePermission, BrowserSitesBridge } from "@/app/lib/desktop";
import { currentLocale, t } from "@/i18n";
import { isElectronRuntime } from "@/app/utils";

import { useBrowserLibraryAvailable } from "./use-browser-library";

/**
 * Meeting hosts (Meet, Zoom, Teams, Webex) open in OmniRush only once a real call with camera, microphone and screen
 * sharing passed on macOS and Windows. Until then they stay in the person's own browser. The Work link routing reads
 * this; flip it with the matrix results, never before.
 */
export const MEETINGS_OPEN_IN_APP = false;

/** Whether meeting links may open in the built-in browser on this build. */
export function meetingLinksOpenInApp(): boolean {
  return MEETINGS_OPEN_IN_APP && getBrowserSitesBridge() !== null;
}

export function getBrowserSitesBridge(): BrowserSitesBridge | null {
  if (!isElectronRuntime()) return null;
  return window.__OMNIRUSH_ELECTRON__?.browserSites ?? null;
}

export const browserSitePermissionsKey = ["browser-site-permissions"] as const;

/** Work accounts turn the per-site questions on; for everyone else every one of them stays denied. */
export function useSitePromptsGate() {
  const available = useBrowserLibraryAvailable();
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = getBrowserSitesBridge();
    if (!bridge) return;
    void bridge.setPrompts(available).catch(() => undefined);
  }, [available]);
  useEffect(() => {
    const bridge = getBrowserSitesBridge();
    if (!bridge) return;
    return bridge.onChanged(() => { void queryClient.invalidateQueries({ queryKey: browserSitePermissionsKey }); });
  }, [queryClient]);
}

export function useSitePermissionList(enabled: boolean) {
  return useQuery<BrowserSitePermission[]>({
    queryKey: browserSitePermissionsKey,
    queryFn: () => getBrowserSitesBridge()!.list(),
    enabled: enabled && getBrowserSitesBridge() !== null,
    retry: false,
  });
}

/** "meet.google.com" from "https://meet.google.com"; the origin itself when it is not a URL. */
export function siteHost(origin: string): string {
  try {
    const url = new URL(origin);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return origin;
  }
}

/** Sites by the domain they live on, for the brand marks in brands.ts. Most specific first. */
const SITE_BRANDS: ReadonlyArray<readonly [domain: string, brand: string]> = [
  ["mail.google.com", "gmail"], ["calendar.google.com", "calendar"], ["drive.google.com", "drive"], ["docs.google.com", "drive"],
  ["google.com", "google"], ["zoom.us", "zoom"], ["zoom.com", "zoom"],
  ["teams.microsoft.com", "teams"], ["teams.live.com", "teams"], ["teams.cloud.microsoft", "teams"],
  ["outlook.office.com", "outlook"], ["outlook.live.com", "outlook"], ["outlook.office365.com", "outlook"],
  ["sharepoint.com", "sharepoint"], ["onedrive.live.com", "onedrive"], ["slack.com", "slack"], ["discord.com", "discord"],
  ["web.whatsapp.com", "whatsapp"], ["telegram.org", "telegram"], ["notion.so", "notion"], ["figma.com", "figma"],
  ["linear.app", "linear"], ["hubspot.com", "hubspot"], ["zendesk.com", "zendesk"], ["salesforce.com", "salesforce"],
  ["force.com", "salesforce"], ["github.com", "github"], ["gitlab.com", "gitlab"], ["asana.com", "asana"],
  ["trello.com", "trello"], ["clickup.com", "clickup"], ["monday.com", "monday"], ["airtable.com", "airtable"],
  ["dropbox.com", "dropbox"], ["box.com", "box"], ["intercom.com", "intercom"], ["front.com", "front"],
  ["freshdesk.com", "freshdesk"], ["pipedrive.com", "pipedrive"], ["calendly.com", "calendly"], ["stripe.com", "stripe"],
  ["shopify.com", "shopify"], ["xero.com", "xero"], ["intuit.com", "quickbooks"],
];

/** The brand mark for a site people often allow (brands.ts ids); null for every other site (it gets a letter). */
export function siteBrand(origin: string): string | null {
  const host = siteHost(origin).toLowerCase().replace(/:\d+$/, "");
  if (host.endsWith(".atlassian.net")) return "jira";
  const found = SITE_BRANDS.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  return found ? found[1] : null;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** The name a site goes by, for its letter: "hubspot" for app.hubspot.com, "acmefreight" for tms.acmefreight.co.uk. */
export function siteName(origin: string): string {
  const labels = siteHost(origin).toLowerCase().replace(/:\d+$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return labels[0] ?? origin;
  const index = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? labels.length - 3 : labels.length - 2;
  return labels[index]!;
}

const KIND_ORDER: BrowserSiteKind[] = ["camera", "microphone", "notifications"];

/** "camera and microphone" (in the app's language), for the bar and the list. */
export function kindsList(kinds: readonly string[]): string {
  const names = KIND_ORDER.filter((kind) => kinds.includes(kind)).map((kind) => t(`site_permissions.kind_${kind}`));
  try {
    return new Intl.ListFormat(currentLocale(), { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/** One line per site for the list: "Camera and microphone allowed · Notifications blocked". */
export function sitePermissionSummary(entry: BrowserSitePermission): string {
  const allowed = KIND_ORDER.filter((kind) => entry[kind] === "allow");
  const blocked = KIND_ORDER.filter((kind) => entry[kind] === "block");
  const parts: string[] = [];
  if (allowed.length > 0) parts.push(capitalize(t("site_permissions.allowed_list", { list: kindsList(allowed) })));
  if (blocked.length > 0) parts.push(capitalize(t("site_permissions.blocked_list", { list: kindsList(blocked) })));
  return parts.join(" · ");
}

/**
 * The bar's question in three parts around the site's name, so a long name can be shortened on screen without
 * losing what is asked: { before: "", host: "meet.google.com", after: " wants to use your camera." }.
 */
export function sitePromptParts(prompt: { origin: string; kinds: readonly string[]; system?: boolean }): { before: string; host: string | null; after: string } {
  const marker = "\u0000";
  const text = sitePromptMessage(prompt, marker);
  const at = text.indexOf(marker);
  if (at < 0) return { before: text, host: null, after: "" };
  return { before: text.slice(0, at), host: siteHost(prompt.origin), after: text.slice(at + marker.length) };
}

/** The bar's question, e.g. "meet.google.com wants to use your camera and microphone." */
export function sitePromptMessage(prompt: { origin: string; kinds: readonly string[]; system?: boolean }, hostText?: string): string {
  const host = hostText ?? siteHost(prompt.origin);
  const camera = prompt.kinds.includes("camera");
  const microphone = prompt.kinds.includes("microphone");
  if (prompt.system) {
    if (camera && microphone) return t("site_permissions.system_camera_microphone");
    return t(camera ? "site_permissions.system_camera" : "site_permissions.system_microphone");
  }
  if (prompt.kinds.includes("notifications")) return t("site_permissions.prompt_notifications", { host });
  if (camera && microphone) return t("site_permissions.prompt_camera_microphone", { host });
  return t(camera ? "site_permissions.prompt_camera" : "site_permissions.prompt_microphone", { host });
}
