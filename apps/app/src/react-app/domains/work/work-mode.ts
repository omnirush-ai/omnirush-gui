import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { t } from "@/i18n";
import type { OmniRushServerClient, OmniRushWorkAction, OmniRushWorkConnector, OmniRushWorkCoverage, OmniRushWorkDeal, OmniRushWorkEntitySummary, OmniRushWorkFeedItem, OmniRushWorkHealth, OmniRushWorkInsights, OmniRushWorkOnboarding, OmniRushWorkSettings, OmniRushWorkStarter, OmniRushWorkState } from "@/app/lib/omnirush-server";

/** The window's top-level mode: Code (today's app) or Work (business chats). Remembered across restarts. */
export type AppMode = "code" | "work";

export const WORK_PRESET = "work";
export const WORK_HOME_ROUTE = "/work";
export const WORK_CONNECTORS_ROUTE = "/work/connectors";
export const WORK_KNOWLEDGE_ROUTE = "/work/knowledge";
export const WORK_ONBOARDING_ROUTE = "/work/welcome";
export const WORK_ORG_ROUTE = "/work/organization";
export const WORK_INSIGHTS_ROUTE = "/work/insights";
export const WORK_ACTIVITY_ROUTE = "/work/activity";
export const WORK_SEARCH_ROUTE = "/work/search";
export const WORK_DEALS_ROUTE = "/work/deals";
/** Shown only while the server transcribes meeting audio (`meetings` in the Work state). */
export const WORK_MEETINGS_ROUTE = "/work/meetings";

/**
 * The token of a Work invite link: the server's `<api>/omnirush/work/invite#t=…` or the app's own
 * `omnirush://work/invite#t=…` (same path and fragment), so the invite page can open the app on Join.
 */
export function workInviteToken(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (!/(^|\/)work\/invite\/?$/.test(parsed.host + parsed.pathname)) return null;
  return (new URLSearchParams(parsed.hash.slice(1)).get("t") ?? parsed.searchParams.get("t"))?.trim() || null;
}

/** An invite link the app was opened with, waiting for the Join prompt (shown even while Work is off). */
export const useWorkInviteStore = create<{ token: string | null; setToken: (token: string | null) => void }>()((set) => ({
  token: null,
  setToken: (token) => set({ token }),
}));

type WorkModeStore = { mode: AppMode; setMode: (mode: AppMode) => void };

export const useWorkModeStore = create<WorkModeStore>()(
  persist((set) => ({ mode: "code", setMode: (mode) => set({ mode }) }), {
    name: "omnirush.appMode",
    storage: createJSONStorage(() => localStorage),
  }),
);

export type WorkClient = Pick<OmniRushServerClient, "getWorkState" | "getWorkOrgInsights" | "ensureWorkWorkspace" | "listWorkConnectors" | "startWorkConnector" | "disconnectWorkConnector" | "setWorkConnectorSync"
  | "getWorkHealth" | "listWorkEntities" | "getWorkEntity" | "addWorkFact" | "updateWorkFact" | "getWorkGraph" | "getWorkTimeline"
  | "getWorkAnswerStyle" | "setWorkAnswerStyle"
  | "enableWork" | "getWorkOnboarding" | "saveWorkOnboarding" | "seedWorkDemo" | "removeWorkDemo" | "inviteWorkMember" | "acceptWorkInvite"
  | "listWorkMembers" | "updateWorkOrg" | "updateWorkOrgMe" | "cancelWorkInvite" | "removeWorkMember" | "transferWorkOrg" | "leaveWorkOrg"
  | "getWorkFeed" | "syncWorkConnector" | "getWorkChatTools" | "fixWorkChatTools"
  | "getWorkSettings" | "setWorkSettings" | "listWorkActions" | "undoWorkAction"
  | "importIMessage" | "getIMessageCount"
  | "searchWork" | "getWorkCoverage" | "listWorkDeals" | "getWorkDeal" | "listWorkImports" | "importWorkChat"
  | "createWorkMeeting" | "getWorkMeeting" | "updateWorkMeeting" | "uploadWorkMeetingAudio"> & { baseUrl?: string };

export const workStateKey = (client: WorkClient | null) => ["omnirush-work-state", client?.baseUrl?.trim() || "default"];
export const workConnectorsKey = (client: WorkClient | null) => ["omnirush-work-connectors", client?.baseUrl?.trim() || "default"];
export const workOnboardingKey = (client: WorkClient | null) => ["omnirush-work-onboarding", client?.baseUrl?.trim() || "default"];
export const workEntityKey = (client: WorkClient | null, id: string) => ["omnirush-work-entity", client?.baseUrl?.trim() || "default", id];
export const workFeedKey = (client: WorkClient | null, source: string | null) => ["omnirush-work-feed", client?.baseUrl?.trim() || "default", source ?? "all"];
export const workMembersKey = (client: WorkClient | null) => ["omnirush-work-members", client?.baseUrl?.trim() || "default"];
export const workChatToolsKey = (client: WorkClient | null) => ["omnirush-work-chat-tools", client?.baseUrl?.trim() || "default"];
export const workInsightsKey = (client: WorkClient | null, days: number) => ["omnirush-work-insights", client?.baseUrl?.trim() || "default", days];
export const workSettingsKey = (client: WorkClient | null) => ["omnirush-work-settings", client?.baseUrl?.trim() || "default"];
export const workActionsKey = (client: WorkClient | null) => ["omnirush-work-actions", client?.baseUrl?.trim() || "default"];
export const workSearchKey = (client: WorkClient | null, query: Record<string, unknown>) => ["omnirush-work-search", client?.baseUrl?.trim() || "default", query];
export const workCoverageKey = (client: WorkClient | null) => ["omnirush-work-coverage", client?.baseUrl?.trim() || "default"];
export const workDealsKey = (client: WorkClient | null, filter: string | null) => ["omnirush-work-deals", client?.baseUrl?.trim() || "default", filter ?? "all"];
export const workDealKey = (client: WorkClient | null, id: string) => ["omnirush-work-deal", client?.baseUrl?.trim() || "default", id];
export const workImportsKey = (client: WorkClient | null) => ["omnirush-work-imports", client?.baseUrl?.trim() || "default"];

/** Which channels Ask sees. Fails safe: an older server (404) or any error hides the meter, never shows an error. */
export function useWorkCoverage(client: WorkClient | null, enabled = true) {
  return useQuery<OmniRushWorkCoverage>({
    queryKey: workCoverageKey(client),
    queryFn: () => client!.getWorkCoverage(),
    enabled: Boolean(client) && enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** The connectors the meter offers to add: the ones the person said they use first, then one per missing group; at most 4. */
export function coverageAdds(coverage: OmniRushWorkCoverage | null | undefined): string[] {
  const missing = (coverage?.groups ?? []).filter((group) => group.state === "missing");
  const ids = [...(coverage?.missing_used ?? []), ...missing.map((group) => group.sources[0]).filter((id): id is string => Boolean(id))];
  return [...new Set(ids)].slice(0, 4);
}

/** The chat exports the app can import (contract D5): no sign-in, a file from the phone or Telegram Desktop. */
export const IMPORT_KINDS = ["whatsapp", "telegram"] as const;
export const isImportKind = (id: string): id is (typeof IMPORT_KINDS)[number] => (IMPORT_KINDS as readonly string[]).includes(id);

/** Sent on Cmd/Ctrl+K while Search is open: its box takes the cursor again. */
export const WORK_SEARCH_FOCUS_EVENT = "omnirush:work-search-focus";

/** Cmd/Ctrl+K inside Work: go to Search and put the cursor in its box (in Code it stays the command palette). */
export function isWorkSearchShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  return (mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey && event.key?.toLowerCase() === "k";
}

export type SearchPeriod = "week" | "month" | "quarter" | "any";
/** The first local day of this week (Monday), month or quarter as YYYY-MM-DD; undefined for Any time. */
export function periodStart(period: SearchPeriod, now = new Date()): string | undefined {
  if (period === "any") return undefined;
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  else day.setMonth(period === "quarter" ? day.getMonth() - (day.getMonth() % 3) : day.getMonth(), 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** A snippet's parts: the server wraps matched words in `**`, shown bold (odd parts). Never parsed as markup. */
export function snippetParts(snippet: string | null | undefined): { text: string; bold: boolean }[] {
  return (snippet ?? "").split("**").map((text, index) => ({ text, bold: index % 2 === 1 })).filter((part) => part.text);
}

/** Whether to list Deals in the sidebar: only once the server has deals (an error or an older server: no). */
export const hasDeals = (deals: { items?: OmniRushWorkDeal[] } | null | undefined) => (deals?.items?.length ?? 0) > 0;

/** "Ask about this deal": the brief a Work chat starts with, so the agent reads the deal through work_deals first. */
export function askAboutDealPrompt(deal: Pick<OmniRushWorkDeal, "source_id" | "name" | "company">): string {
  const name = deal.name?.trim() || deal.source_id;
  return `Brief me on the deal "${name}"${deal.company ? ` with ${deal.company}` : ""} (source id ${deal.source_id}). Call work_deals for it first, then tell me where it stands, what puts it at risk, the latest contact on each channel and what I should do next, with links.`;
}

/** The server's Work switch (re-read every 60 s); Work is hidden entirely while it is off or unknown. */
export function useWorkState(client: WorkClient | null) {
  return useQuery<OmniRushWorkState>({
    queryKey: workStateKey(client),
    queryFn: () => client!.getWorkState(),
    enabled: Boolean(client),
    refetchInterval: 60_000,
    retry: false,
  });
}

/** The owner's team insights (aggregate activity + alerts) for the chosen window; read only when owner opens the page. */
export function useWorkOrgInsights(client: WorkClient | null, days: number, enabled: boolean) {
  return useQuery<OmniRushWorkInsights>({
    queryKey: workInsightsKey(client, days),
    queryFn: () => client!.getWorkOrgInsights(days),
    enabled: Boolean(client) && enabled,
    retry: false,
  });
}

/** The company profile and first-run steps; read only while Work is on. */
export function useWorkOnboarding(client: WorkClient | null, enabled: boolean) {
  return useQuery<OmniRushWorkOnboarding>({
    queryKey: workOnboardingKey(client),
    queryFn: () => client!.getWorkOnboarding(),
    enabled: Boolean(client) && enabled,
    retry: false,
  });
}

/** The user's automation settings (F action-layer); read only while Work is on. */
export function useWorkSettings(client: WorkClient | null, enabled: boolean) {
  return useQuery<OmniRushWorkSettings>({
    queryKey: workSettingsKey(client),
    queryFn: () => client!.getWorkSettings(),
    enabled: Boolean(client) && enabled,
    retry: false,
  });
}

/** The newest-first activity log of writes the agent made in connected apps; read only while Work is on. */
export function useWorkActions(client: WorkClient | null, enabled: boolean) {
  return useQuery<{ actions: OmniRushWorkAction[] }>({
    queryKey: workActionsKey(client),
    queryFn: () => client!.listWorkActions(),
    enabled: Boolean(client) && enabled,
    retry: false,
  });
}

/** Whether autopilot auto-approves Work connector writes right now: on, and not paused. */
export function workAutopilotActive(state: OmniRushWorkState | null | undefined): boolean {
  return Boolean(state?.enabled) && state?.autopilot === true && state?.writes_paused !== true;
}

type WorkInviteLinks = { links: Record<string, string>; remember: (id: string, link: string) => void };

/** Invite links made on this device, by invite id: the server keeps only a hash, so only these can be copied again. */
export const useWorkInviteLinks = create<WorkInviteLinks>()(
  persist((set) => ({ links: {}, remember: (id, link) => set((state) => ({ links: { ...state.links, [id]: link } })) }), {
    name: "omnirush.workInviteLinks",
    storage: createJSONStorage(() => localStorage),
  }),
);

type WorkSetupStore = {
  /** The tailored first tasks onboarding answered, by org id (only POST /onboarding returns them). */
  starters: Record<string, OmniRushWorkStarter[]>;
  /** Orgs whose first-run checklist was dismissed. */
  checklistHidden: Record<string, true>;
  setStarters: (org: string, starters: OmniRushWorkStarter[]) => void;
  hideChecklist: (org: string) => void;
};

export const useWorkSetupStore = create<WorkSetupStore>()(
  persist((set) => ({
    starters: {},
    checklistHidden: {},
    setStarters: (org, starters) => set((state) => ({ starters: { ...state.starters, [org]: starters.slice(0, 3) } })),
    hideChecklist: (org) => set((state) => ({ checklistHidden: { ...state.checklistHidden, [org]: true } })),
  }), { name: "omnirush.workSetup", storage: createJSONStorage(() => localStorage) }),
);

/** The sample-data source: seeded by "Try with sample data", read-only, removed in one click. The server lists it in
 *  no connector row; GET /work/onboarding says whether it is seeded (`sample_data`). */
export const DEMO_SOURCE = "demo";
const LINKED = new Set(["connected", "syncing", "error"]);
export const isLinked = (row: Pick<OmniRushWorkConnector, "status">) => LINKED.has(row.status);
export const hasSampleData = (onboarding: OmniRushWorkOnboarding | null | undefined) => onboarding?.sample_data === true;
/** A real (non-sample) source is connected. */
export const hasRealSource = (rows: OmniRushWorkConnector[] | null | undefined) => visibleConnectors(rows).some((row) => row.id !== DEMO_SOURCE && row.id !== "mock" && isLinked(row));

const PERSONAL_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "qq.com"]);
/** The company domain an account e-mail suggests; none for personal mail. */
export function domainFromEmail(email: string | null | undefined): string {
  const domain = (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return domain && !PERSONAL_MAIL.has(domain) ? domain : "";
}

/** Sources for the connect step: the recommended ones first (in their order), then the rest; no sample data, test source
 *  or import source (WhatsApp has no sign-in: it is imported on Connectors). */
export function connectOrder(rows: OmniRushWorkConnector[] | null | undefined, recommended: string[] = []): OmniRushWorkConnector[] {
  const rank = (id: string) => { const at = recommended.indexOf(id); return at === -1 ? recommended.length : at; };
  return visibleConnectors(rows).filter((row) => row.id !== DEMO_SOURCE && row.id !== "mock" && row.mode !== "import").sort((a, b) => rank(a.id) - rank(b.id));
}

/** A coverage "+" chip has somewhere to go on Connectors: an import card, or a row that signs in (Meetings has neither). */
export const coverageCanAdd = (rows: OmniRushWorkConnector[] | null | undefined, id: string) =>
  isImportKind(id) || visibleConnectors(rows).some((row) => row.id === id && row.mode !== "import");

/** The first-run checklist: company, a source connected (or sample data), a first chat. */
export function checklistItems(onboarding: OmniRushWorkOnboarding | null | undefined, rows: OmniRushWorkConnector[] | null | undefined) {
  const steps = onboarding?.steps ?? {};
  return [
    { id: "company", label: t("work.checklist.company"), done: steps.company === true || Boolean(onboarding?.org) },
    { id: "connected", label: t("work.checklist.connected"), done: steps.connected === true || hasRealSource(rows) || hasSampleData(onboarding) },
    { id: "first_chat", label: t("work.checklist.first_chat"), done: steps.first_chat === true },
  ] as const;
}

/** Cmd/Ctrl+Shift+K: switch between Code and Work. */
export function isWorkModeShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  return (mac ? event.metaKey : event.ctrlKey) && event.shiftKey && !event.altKey && event.key?.toLowerCase() === "k";
}

/** The sources shown on the Connectors page: everything the server offers (an `unavailable` one and sample data are hidden). */
export function visibleConnectors(rows: OmniRushWorkConnector[] | null | undefined): OmniRushWorkConnector[] {
  // Sample data is no tool to connect: it shows as the "Sample data" badge.
  return (rows ?? []).filter((row) => row.status !== "unavailable" && row.id !== DEMO_SOURCE);
}

/** A connect in progress is over once the source is connected (or syncing) or reports an error. */
export function connectSettled(rows: OmniRushWorkConnector[] | null | undefined, id: string): boolean {
  const row = rows?.find((item) => item.id === id);
  return Boolean(row && (row.status === "connected" || row.status === "syncing" || row.status === "error"));
}

/** "1 record", "1,200 records": `key` is a plural key whose copy says `{n}` (the count as the locale writes it). */
export const countLabel = (count: number, key: string) => t(key, { count, n: count.toLocaleString() });

/** Which workspaces a mode lists: Work lists only the Work workspace; Code, and the whole app while Work is off, never do. */
export const shownInMode = (workspace: { preset?: string | null }, workEnabled: boolean, mode: AppMode) =>
  (workspace.preset === WORK_PRESET) === (workEnabled && mode === "work");

/** The engine's name for the hosted connector server's tools: `omnirush-work_<tool>`. */
export const WORK_TOOL_PREFIX = "omnirush-work_";

const WORK_APPS: Record<string, string> = {
  gmail: "Gmail", calendar: "Google Calendar", drive: "Google Drive", outlook: "Outlook", onedrive: "OneDrive", teams: "Teams",
  slack: "Slack", hubspot: "HubSpot", qbo: "QuickBooks", notion: "Notion", jira: "Jira", confluence: "Confluence",
  linear: "Linear", github: "GitHub",
};
function workAction(action: string): string | undefined {
  const actions: Record<string, string> = {
    send: t("work.tool.send"), draft: t("work.tool.draft"), post: t("work.tool.post"), create: t("work.tool.create"), note: t("work.tool.note"),
    create_task: t("work.tool.create_task"), update_deal: t("work.tool.update_deal"), create_invoice_draft: t("work.tool.create_invoice_draft"),
    create_page: t("work.tool.create_page"), comment: t("work.tool.comment"), create_issue: t("work.tool.create_issue"),
  };
  return actions[action];
}

/** An approval's tool and scope in words for a Work connector tool (`omnirush-work_gmail_send` → "Send e-mail (Gmail)",
 *  "Your Gmail account"); null for any other permission. */
export function workToolPermission(permission: string): { label: string; scope: string } | null {
  if (!permission.startsWith(WORK_TOOL_PREFIX)) return null;
  const tool = permission.slice(WORK_TOOL_PREFIX.length);
  if (tool === "work_remember") return { label: t("work.tool.remember"), scope: t("work.tool.knowledge_scope") };
  if (tool === "work_forget") return { label: t("work.tool.forget"), scope: t("work.tool.knowledge_scope") };
  const [app, ...rest] = tool.split("_");
  const action = workAction(rest.join("_")) ?? (rest.join(" ") || tool).replace(/^./, (c) => c.toUpperCase());
  const name = app === "mock" ? t("work.connector.mock") : WORK_APPS[app] ?? app;
  return { label: `${action} (${name})`, scope: t("work.tool.account_scope", { name }) };
}

/** Connector names for ids the server lists without a label; an unknown id shows as it is (with a generic icon). */
const CONNECTOR_LABELS: Record<string, string> = {
  google: "Google", microsoft: "Microsoft 365", slack: "Slack", hubspot: "HubSpot", quickbooks: "QuickBooks Online",
  notion: "Notion", jira: "Jira", confluence: "Confluence", linear: "Linear", github: "GitHub",
  whatsapp: "WhatsApp", whatsapp_business: "WhatsApp Business", telegram: "Telegram", imessage: "iMessage", meetings: "Meetings",
};
export const connectorLabel = (id: string, label?: string | null) =>
  label?.trim() || CONNECTOR_LABELS[id] || (id === "mock" ? t("work.connector.mock") : id === "demo" ? t("work.connector.demo") : id);

/** What each connector lets the agent do, in a line, for the Connectors page (an unknown id gets the generic line). */
export function connectorAccess(id: string): string {
  const access: Record<string, string> = {
    google: t("work.connector.access_google"),
    microsoft: t("work.connector.access_microsoft"),
    slack: t("work.connector.access_slack"),
    hubspot: t("work.connector.access_hubspot"),
    quickbooks: t("work.connector.access_quickbooks"),
    notion: t("work.connector.access_notion"),
    jira: t("work.connector.access_jira"),
    confluence: t("work.connector.access_confluence"),
    linear: t("work.connector.access_linear"),
    github: t("work.connector.access_github"),
  };
  return access[id] ?? t("work.connector.access_other");
}

/** A connector's setup link label: GitHub's is where the user picks repositories. */
export const setupLabel = (id: string) => (id === "github" ? t("work.connector.choose_repos") : t("work.connector.finish_setup"));

function workErrorCopy(code: string): string | undefined {
  const copy: Record<string, string> = {
    reconnect_required: t("work.error.reconnect_required"),
    rate_limited: t("work.error.rate_limited"),
    provider_error: t("work.error.provider_error"),
    provider_unreachable: t("work.error.provider_unreachable"),
    token_exchange_failed: t("work.error.token_exchange_failed"),
    connector_unavailable: t("work.error.connector_unavailable"),
    work_disabled: t("work.error.work_disabled"),
    not_connected: t("work.error.not_connected"),
  };
  return copy[code];
}

/** A server error code (a source's `error`, a health check detail) in words. Unknown codes (internal names such as
 *  `KeyError`) never reach the screen as they are. */
export function workErrorText(code: string | null | undefined): string {
  if (!code) return t("work.error.reconnect");
  return workErrorCopy(code) ?? t("work.error.sync_failed");
}

/** A source in `error`: its sync has stopped (signed out, or too many failures in a row) until it is reconnected. */
export function sourceErrorText(code: string | null | undefined): string {
  return code === "reconnect_required" || code === "token_exchange_failed" ? workErrorText(code) : t("work.error.sync_stopped");
}

const CODE = /^[a-z]+(_[a-z]+)+$/;

/**
 * A failed Work request in words, and whether trying again can help. A 4xx (a route this app's local server lacks,
 * an argument the server refused) answers the same every time, so it gets no Try again; a 5xx, a timeout or no
 * answer at all might pass. Server codes never reach the screen as they are.
 */
export function workFailure(error: unknown): { text: string; retry: boolean } {
  const failure = error && typeof error === "object" ? (error as { status?: unknown; code?: unknown; message?: unknown }) : {};
  const status = typeof failure.status === "number" ? failure.status : 0;
  const code = typeof failure.code === "string" ? failure.code : "";
  const copy: Record<string, string> = {
    bad_arguments: t("work.error.bad_arguments"),
    not_undoable: t("work.error.not_undoable"),
    cannot_undo: t("work.error.cannot_undo"),
    unknown_action: t("work.error.unknown_action"),
    not_owner: t("work.error.not_owner"),
    no_org: t("work.error.no_org"),
    omnirush_account_required: t("work.error.signed_out"),
    work_disabled: t("work.error.work_disabled"),
  };
  // The local server already words the codes it knows (WORK_ERRORS); a bare code or a bare HTTP status text is no
  // sentence. An error with no status is this app's own (already words) or the network's.
  const message = typeof failure.message === "string" ? failure.message.trim() : "";
  const fromServer = Boolean(code) && code !== "request_failed" && message !== code;
  const worded = message && !CODE.test(message) && (!status || fromServer) ? message : "";
  const known = copy[code] || workErrorCopy(code);
  // Not found on this side: an older app (no local route) or server (no such path). A known code (work_disabled,
  // not_connected) or a specific miss (unknown_*) is the server answering, not a missing route.
  if (status === 404 && !known && !code.startsWith("unknown_")) return { text: t("work.error.update_app"), retry: false };
  const retry = !status || status >= 500 || status === 408 || status === 429;
  return { text: known || worded || (retry ? t("work.error.try_again") : t("work.error.did_not_work")), retry };
}

/** One source's row of a GET /work/health answer (a list, or `{sources}` / `{items}`); null when absent. */
export function healthFor(answer: unknown, id: string): OmniRushWorkHealth | null {
  const box = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
  const rows = Array.isArray(answer) ? answer : Array.isArray(box?.sources) ? box.sources : Array.isArray(box?.items) ? box.items : [];
  const row = rows.find((item): item is OmniRushWorkHealth => Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === id);
  return row ?? null;
}

function checkName(name: string): string {
  const names: Record<string, string> = { token: t("work.health.token"), scopes: t("work.health.scopes"), sync: t("work.health.sync") };
  return names[name] ?? name;
}

/** How the composer chip opens Work > Connectors: from a chat its Back returns there; from the Work home it is the usual Back to Work. */
export function connectorsBackState(pathname: string, search = ""): { state: { from: string } } | undefined {
  return pathname === WORK_HOME_ROUTE ? undefined : { state: { from: `${pathname}${search}` } };
}

/** An entity key as shown: an address or domain without its `email:`/`domain:` tag; other keys (hubspot:company:77) as they are. */
export function keyLabel(key: string): string {
  return key.replace(/^(email|domain):(?=.)/, "");
}

/** What a health check says, in a line: missing scopes (reconnect), a failed check or the last error; null when all is well. */
export function healthProblem(health: OmniRushWorkHealth | null): { text: string; reconnect: boolean } | null {
  if (!health) return null;
  const missing = (health.missing_scopes ?? []).filter(Boolean);
  if (missing.length) return { text: t("work.health.missing_scopes", { scopes: missing.join(", ") }), reconnect: true };
  // A token that fails says nothing about the scopes (the server reports them as not ok then too).
  if (health.token_ok === false) return { text: t("work.health.token_failed"), reconnect: true };
  if (health.scopes_ok === false) return { text: t("work.health.scopes_failed"), reconnect: true };
  const failed = (health.checks ?? []).find((check) => !check.ok);
  if (failed) {
    const detail = failed.detail?.trim();
    // A check's detail is either a code (`provider_error`) or already words (`sync off`).
    const words = detail && /^[a-z]+(_[a-z]+)+$|^[A-Z]\w*Error$/.test(detail) ? workErrorText(detail) : detail;
    return { text: `${checkName(failed.name)}: ${words || t("work.health.failed")}`, reconnect: detail === "reconnect_required" };
  }
  if (health.last_error) return { text: workErrorText(health.last_error), reconnect: health.last_error === "reconnect_required" };
  return null;
}

// Labels are getters: t() reads the language when shown, not when this module loads.
export const ENTITY_KINDS = [
  { id: "person", get label() { return t("work.kind.people"); } },
  { id: "company", get label() { return t("work.kind.companies"); } },
  { id: "deal", get label() { return t("work.kind.deals"); } },
  { id: "project", get label() { return t("work.kind.projects"); } },
  { id: "product", get label() { return t("work.kind.products"); } },
  { id: "other", get label() { return t("work.kind.other"); } },
] as const;

export const FACT_KINDS = [
  { id: "fact", get label() { return t("work.fact.fact"); } },
  { id: "decision", get label() { return t("work.fact.decision"); } },
  { id: "preference", get label() { return t("work.fact.preference"); } },
  { id: "policy", get label() { return t("work.fact.policy"); } },
  { id: "contact_note", get label() { return t("work.fact.contact_note"); } },
] as const;

/** "Ask about this": the brief a Work chat starts with, so the agent calls work_context on the entity first. */
export function askAboutPrompt(entity: Pick<OmniRushWorkEntitySummary, "id" | "kind" | "name">): string {
  return `Brief me on ${entity.name} (${entity.kind}). Call work_context for "${entity.name}" first (entity id ${entity.id}), then summarise who or what this is, our recent history across every source, open items and anything we decided or agreed to remember, with links to the sources.`;
}

/** "1,992 emails · 573 files · 1 event": a source's coverage by kind, most first; null without one. */
export function coverageLine(coverage: OmniRushWorkConnector["coverage"]): string | null {
  const kinds = Object.entries(coverage?.by_kind ?? {}).filter(([, count]) => typeof count === "number" && count > 0).sort((a, b) => b[1] - a[1]);
  if (!kinds.length) return null;
  const plural = (noun: string, count: number) => (count === 1 ? noun : /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`);
  return kinds.map(([kind, count]) => `${count.toLocaleString()} ${plural(kind.replace(/_/g, " "), count)}`).join(" · ");
}

/** "5 min ago", "in 2 h", "Yesterday", "Tue": short, for feed rows. */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  const abs = Math.abs(minutes);
  if (abs < 1) return t("work.time.now");
  if (abs < 60) return minutes < 0 ? t("work.time.min_ago", { n: abs }) : t("work.time.in_min", { n: abs });
  const hours = Math.round(abs / 60);
  if (abs < 24 * 60) return minutes < 0 ? t("work.time.h_ago", { n: hours }) : t("work.time.in_h", { n: hours });
  if (minutes < 0 && abs < 48 * 60) return t("work.time.yesterday");
  if (minutes > 0 && abs < 48 * 60) return t("work.time.tomorrow");
  return new Date(at).toLocaleDateString(undefined, abs < 7 * 24 * 60 ? { weekday: "short" } : { month: "short", day: "numeric" });
}

/** "Ask about this" on a feed item: the brief a Work chat starts with. */
export function askAboutItemPrompt(item: Pick<OmniRushWorkFeedItem, "id" | "source" | "kind" | "title" | "url">): string {
  const source = connectorLabel(item.source);
  return `Help me with this ${item.kind.replace(/_/g, " ")} from ${source}: "${item.title}"${item.url ? ` (${item.url})` : ""}, source id ${item.id}. Look it up first, then tell me what it is, what is needed from me and anything related, with links.`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noticesIn(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    if (depth > 1 || value.length > 256 * 1024 || !value.includes("notices")) return [];
    try { return noticesIn(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap((item) => (isObject(item) && typeof item.text === "string" ? noticesIn(item.text, depth) : []));
  if (!isObject(value)) return [];
  if (Array.isArray(value.notices)) return value.notices.filter((notice): notice is string => typeof notice === "string" && Boolean(notice.trim())).map((notice) => notice.trim().slice(0, 400));
  return [...noticesIn(value.structuredContent, depth), ...noticesIn(value.content, depth)];
}

/** The `notices` a Work tool result carries (contract Addendum C1): from the kept MCP result, or the output text. */
export function workToolNotices(part: { toolName: string; output?: unknown; callProviderMetadata?: unknown }): string[] {
  if (!part.toolName.startsWith(WORK_TOOL_PREFIX)) return [];
  const omnirush = isObject(part.callProviderMetadata) && isObject(part.callProviderMetadata.omnirush) ? part.callProviderMetadata.omnirush : null;
  const kept = omnirush && isObject(omnirush.mcpResult) ? noticesIn(omnirush.mcpResult) : [];
  return [...new Set(kept.length ? kept : noticesIn(part.output))];
}
