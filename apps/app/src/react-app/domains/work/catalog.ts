// The connector catalog the Work pickers show (onboarding, Organization): GET /work/catalog from the server, with a
// built-in copy for an older server (404) so the pickers never go empty. Labels are the brands' own names.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { t } from "@/i18n";

import type { OmniRushWorkCatalog, OmniRushWorkCatalogConnector } from "@/app/lib/omnirush-server";

import type { WorkClient } from "./work-mode";

/** Team sizes the server takes (smallest first; no one-person band). */
export const WORK_SIZES = ["2-5", "6-10", "11-25", "26-50", "51-100", "101-250", "251-1000", "1000+"] as const;

/** A size as it reads: thousands with a comma. A size from before (2-10, 11-50, …) reads as it was saved. */
export function sizeLabel(value: string): string {
  return value.replace(/\d{4,}/g, (digits) => Number(digits).toLocaleString("en-US"));
}

export type CatalogTool = OmniRushWorkCatalogConnector;
export type CatalogGroup = { id: string; label: string; tools: CatalogTool[] };

/** Where a desktop-only source can be read: iMessage from the Mac's Messages, WhatsApp and Telegram from the desktop. */
export type LocalPlatform = { mac: boolean; desktop: boolean };

const BUILT_IN_CATEGORIES = ["email", "chat", "docs", "projects", "sales", "finance", "automation"] as const;
const CATEGORY_LABEL_KEYS: Record<(typeof BUILT_IN_CATEGORIES)[number], string> = {
  email: "work.catalog.email",
  chat: "work.catalog.chat",
  docs: "work.catalog.docs",
  projects: "work.catalog.projects",
  sales: "work.catalog.sales",
  finance: "work.catalog.finance",
  automation: "work.catalog.automation",
};

type BuiltIn = Omit<CatalogTool, "offered"> & { local?: "mac" | "desktop" };
const tool = (id: string, label: string, category: string, extra: Partial<BuiltIn> = {}): BuiltIn => ({ id, label, category, ...extra });

const BUILT_IN_TOOLS: BuiltIn[] = [
  tool("google", "Google Workspace", "email", { includes: ["Gmail", "Drive", "Calendar"] }),
  tool("microsoft", "Microsoft 365", "email", { includes: ["Outlook", "OneDrive", "Teams"] }),
  tool("imap", "", "email", { mode: "credentials" }),
  tool("caldav", "", "email", { mode: "credentials" }),
  tool("calendly", "Calendly", "email", { mode: "key" }),
  tool("zoom", "Zoom", "email"),
  tool("slack", "Slack", "chat"),
  tool("discord", "Discord", "chat"),
  tool("whatsapp_business", "WhatsApp Business", "chat"),
  tool("imessage", "iMessage", "chat", { local: "mac", local_only: true }),
  tool("whatsapp", "WhatsApp", "chat", { local: "desktop", local_only: true }),
  tool("telegram", "Telegram", "chat", { local: "desktop", local_only: true }),
  tool("notion", "Notion", "docs"),
  tool("confluence", "Confluence", "docs"),
  tool("dropbox", "Dropbox", "docs"),
  tool("box", "Box", "docs"),
  tool("figma", "Figma", "docs", { mode: "key" }),
  tool("airtable", "Airtable", "docs", { mode: "key" }),
  tool("jira", "Jira", "projects"),
  tool("linear", "Linear", "projects"),
  tool("asana", "Asana", "projects"),
  tool("trello", "Trello", "projects", { mode: "key" }),
  tool("clickup", "ClickUp", "projects", { mode: "key" }),
  tool("monday", "monday.com", "projects", { mode: "key" }),
  tool("github", "GitHub", "projects"),
  tool("gitlab", "GitLab", "projects", { mode: "key" }),
  tool("hubspot", "HubSpot", "sales"),
  tool("salesforce", "Salesforce", "sales"),
  tool("pipedrive", "Pipedrive", "sales", { mode: "key" }),
  tool("zendesk", "Zendesk", "sales"),
  tool("intercom", "Intercom", "sales"),
  tool("front", "Front", "sales"),
  tool("freshdesk", "Freshdesk", "sales", { mode: "key" }),
  tool("quickbooks", "QuickBooks", "finance"),
  tool("xero", "Xero", "finance"),
  tool("stripe", "Stripe", "finance", { mode: "key" }),
  tool("shopify", "Shopify", "finance", { mode: "key" }),
  tool("hook", "Zapier, Make or n8n", "automation", { mode: "hook" }),
];

/** Never a pick: the company's own hook (the same tool as `hook`), the test source and the old sample data. */
const NEVER_PICKED = new Set(["hook_org", "mock", "demo", "meetings"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 80) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** A server catalog, checked; null when it is not one (the built-in copy is used then). */
export function readCatalog(value: unknown): OmniRushWorkCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.connectors) || !Array.isArray(value.categories)) return null;
  const categories = value.categories.flatMap((row) => {
    const id = isRecord(row) ? text(row.id, 32) : null;
    const label = isRecord(row) ? text(row.label) : null;
    return id && label ? [{ id, label }] : [];
  });
  const connectors = value.connectors.flatMap((row): CatalogTool[] => {
    if (!isRecord(row)) return [];
    const id = text(row.id, 32);
    const label = text(row.label);
    const category = text(row.category, 32);
    if (!id || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !label || !category) return [];
    const includes = Array.isArray(row.includes) ? row.includes.flatMap((item) => (text(item) ? [text(item)!] : [])).slice(0, 8) : [];
    return [{ id, label, category, short: text(row.short), mode: text(row.mode, 32), includes, offered: row.offered === true, local_only: row.local_only === true }];
  });
  const sizes = Array.isArray(value.sizes) ? value.sizes.flatMap((size) => (text(size, 16) ? [text(size, 16)!] : [])) : [];
  if (!connectors.length || !categories.length) return null;
  return { version: typeof value.version === "number" || typeof value.version === "string" ? value.version : 0, sizes: sizes.length ? sizes : [...WORK_SIZES], categories, connectors };
}

/** The built-in catalog for an older server: a source is offered when the server lists it in the Work switch. */
export function builtInCatalog(sources: readonly string[]): OmniRushWorkCatalog {
  const listed = new Set(sources);
  const generic: Record<string, string> = { imap: t("work.catalog.other_email"), caldav: t("work.catalog.other_calendar") };
  return {
    version: 0,
    sizes: [...WORK_SIZES],
    categories: BUILT_IN_CATEGORIES.map((id) => ({ id, label: t(CATEGORY_LABEL_KEYS[id]) })),
    connectors: BUILT_IN_TOOLS.map(({ local: _local, ...row }) => ({ ...row, label: generic[row.id] ?? row.label, offered: listed.has(row.id) })),
  };
}

const LOCAL_WHERE = new Map(BUILT_IN_TOOLS.filter((row) => row.local).map((row) => [row.id, row.local!]));

/** Whether this computer can read a desktop-only source. */
export function localAvailable(id: string, platform: LocalPlatform): boolean {
  const where = LOCAL_WHERE.get(id);
  return where === "mac" ? platform.mac && platform.desktop : where === "desktop" ? platform.desktop : false;
}

/** The tools to pick from, grouped in the catalog's order: what the server offers, plus the desktop-only sources this
 *  computer can read. Empty groups are left out. */
export function pickerGroups(catalog: OmniRushWorkCatalog, platform: LocalPlatform): CatalogGroup[] {
  const shown = catalog.connectors.filter((row) => !NEVER_PICKED.has(row.id) && (row.local_only || LOCAL_WHERE.has(row.id) ? localAvailable(row.id, platform) : row.offered));
  return catalog.categories
    .map((category) => ({ ...category, tools: shown.filter((row) => row.category === category.id) }))
    .filter((group) => group.tools.length > 0);
}

/** A tool's name in a picker (the catalog's, or the id for one it does not list). */
export function toolLabel(catalog: OmniRushWorkCatalog, id: string): string {
  return catalog.connectors.find((row) => row.id === id)?.label ?? id;
}

const fold = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** The catalog tool a typed name means (its name, id, short name or a product it includes: "gmail" is Google
 *  Workspace), or null. Only exact names: "git" is no tool. */
export function matchTool(groups: CatalogGroup[], typed: string): CatalogTool | null {
  const wanted = fold(typed);
  if (!wanted) return null;
  for (const group of groups) {
    for (const row of group.tools) {
      const names = [row.label, row.id, row.short ?? "", ...(row.includes ?? [])].map(fold);
      if (names.includes(wanted) || fold(row.label.replace(/\.com$/, "")) === wanted) return row;
    }
  }
  return null;
}

/** The tools a search shows: names (and included products) containing what was typed, in catalog order. */
export function searchTools(groups: CatalogGroup[], typed: string): CatalogTool[] {
  const wanted = fold(typed);
  const all = groups.flatMap((group) => group.tools);
  if (!wanted) return all;
  return all.filter((row) => [row.label, row.id, row.short ?? "", ...(row.includes ?? [])].some((name) => fold(name).includes(wanted)));
}

export const CUSTOM_TOOLS_MAX = 10;
export const CUSTOM_TOOL_LENGTH = 40;
const CUSTOM_TOOL = /^[\p{L}\p{N} .&+-]+$/u;

/** A tool the catalog does not have, as it will be saved; null when it cannot be (too long, odd characters). */
export function customToolName(typed: string): string | null {
  const name = typed.trim().replace(/\s+/g, " ");
  if (!name || name.length > CUSTOM_TOOL_LENGTH || !CUSTOM_TOOL.test(name)) return null;
  return name;
}

/** Adds a custom tool to a list: no duplicates (any case), at most ten. */
export function addCustomTool(list: readonly string[], typed: string): string[] {
  const name = customToolName(typed);
  if (!name || list.length >= CUSTOM_TOOLS_MAX || list.some((item) => fold(item) === fold(name))) return [...list];
  return [...list, name];
}

export const workCatalogKey = (client: WorkClient | null) => ["omnirush-work-catalog", client?.baseUrl?.trim() || "default"];

/** The catalog: the server's when it has one, else the built-in copy (offered = the Work switch's sources). */
export function useWorkCatalog(client: WorkClient | null, sources: readonly string[], enabled = true): OmniRushWorkCatalog {
  const query = useQuery({
    queryKey: workCatalogKey(client),
    queryFn: async () => readCatalog(await client!.getWorkCatalog()),
    enabled: Boolean(client) && enabled,
    retry: false,
    staleTime: 60 * 60_000,
  });
  // One object per list of sources (the ids are the key), so it is no new value every render.
  const key = sources.join(",");
  const fallback = useMemo(() => builtInCatalog(key ? key.split(",") : []), [key]);
  return query.data ?? fallback;
}
