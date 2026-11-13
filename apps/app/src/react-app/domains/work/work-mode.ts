import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { OmniRushServerClient, OmniRushWorkConnector, OmniRushWorkEntitySummary, OmniRushWorkHealth, OmniRushWorkOnboarding, OmniRushWorkStarter, OmniRushWorkState } from "@/app/lib/omnirush-server";

/** The window's top-level mode: Code (today's app) or Work (business chats). Remembered across restarts. */
export type AppMode = "code" | "work";

export const WORK_PRESET = "work";
export const WORK_HOME_ROUTE = "/work";
export const WORK_CONNECTORS_ROUTE = "/work/connectors";
export const WORK_KNOWLEDGE_ROUTE = "/work/knowledge";
export const WORK_ONBOARDING_ROUTE = "/work/welcome";

type WorkModeStore = { mode: AppMode; setMode: (mode: AppMode) => void };

export const useWorkModeStore = create<WorkModeStore>()(
  persist((set) => ({ mode: "code", setMode: (mode) => set({ mode }) }), {
    name: "omnirush.appMode",
    storage: createJSONStorage(() => localStorage),
  }),
);

export type WorkClient = Pick<OmniRushServerClient, "getWorkState" | "ensureWorkWorkspace" | "listWorkConnectors" | "startWorkConnector" | "disconnectWorkConnector" | "setWorkConnectorSync"
  | "getWorkHealth" | "listWorkEntities" | "getWorkEntity" | "addWorkFact" | "updateWorkFact"
  | "enableWork" | "getWorkOnboarding" | "saveWorkOnboarding" | "seedWorkDemo" | "removeWorkDemo" | "inviteWorkMember"> & { baseUrl?: string };

export const workStateKey = (client: WorkClient | null) => ["omnirush-work-state", client?.baseUrl?.trim() || "default"];
export const workConnectorsKey = (client: WorkClient | null) => ["omnirush-work-connectors", client?.baseUrl?.trim() || "default"];
export const workOnboardingKey = (client: WorkClient | null) => ["omnirush-work-onboarding", client?.baseUrl?.trim() || "default"];
export const workEntityKey = (client: WorkClient | null, id: string) => ["omnirush-work-entity", client?.baseUrl?.trim() || "default", id];

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

/** The company profile and first-run steps; read only while Work is on. */
export function useWorkOnboarding(client: WorkClient | null, enabled: boolean) {
  return useQuery<OmniRushWorkOnboarding>({
    queryKey: workOnboardingKey(client),
    queryFn: () => client!.getWorkOnboarding(),
    enabled: Boolean(client) && enabled,
    retry: false,
  });
}

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

/** The sample-data source: seeded by "Try with sample data", read-only, removed in one click. */
export const DEMO_SOURCE = "demo";
const LINKED = new Set(["connected", "syncing", "error"]);
export const isLinked = (row: Pick<OmniRushWorkConnector, "status">) => LINKED.has(row.status);
export const hasSampleData = (rows: OmniRushWorkConnector[] | null | undefined) => (rows ?? []).some((row) => row.id === DEMO_SOURCE && isLinked(row));
/** A real (non-sample) source is connected. */
export const hasRealSource = (rows: OmniRushWorkConnector[] | null | undefined) => visibleConnectors(rows).some((row) => row.id !== DEMO_SOURCE && row.id !== "mock" && isLinked(row));

const PERSONAL_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "qq.com"]);
/** The company domain an account e-mail suggests; none for personal mail. */
export function domainFromEmail(email: string | null | undefined): string {
  const domain = (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return domain && !PERSONAL_MAIL.has(domain) ? domain : "";
}

/** Sources for the connect step: the recommended ones first (in their order), then the rest; no sample data or test source. */
export function connectOrder(rows: OmniRushWorkConnector[] | null | undefined, recommended: string[] = []): OmniRushWorkConnector[] {
  const rank = (id: string) => { const at = recommended.indexOf(id); return at === -1 ? recommended.length : at; };
  return visibleConnectors(rows).filter((row) => row.id !== DEMO_SOURCE && row.id !== "mock").sort((a, b) => rank(a.id) - rank(b.id));
}

/** The first-run checklist: company, a source connected (or sample data), a first chat. */
export function checklistItems(onboarding: OmniRushWorkOnboarding | null | undefined, rows: OmniRushWorkConnector[] | null | undefined) {
  const steps = onboarding?.steps ?? {};
  return [
    { id: "company", label: "Add your company", done: steps.company === true || Boolean(onboarding?.org) },
    { id: "connected", label: "Connect a tool or try sample data", done: steps.connected === true || hasRealSource(rows) || hasSampleData(rows) },
    { id: "first_chat", label: "Start your first chat", done: steps.first_chat === true },
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

/** "1 record", "2 records". */
export const countLabel = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

/** Which workspaces a mode lists: Work lists only the Work workspace; Code, and the whole app while Work is off, never do. */
export const shownInMode = (workspace: { preset?: string | null }, workEnabled: boolean, mode: AppMode) =>
  (workspace.preset === WORK_PRESET) === (workEnabled && mode === "work");

/** The engine's name for the hosted connector server's tools: `omnirush-work_<tool>`. */
export const WORK_TOOL_PREFIX = "omnirush-work_";

const WORK_APPS: Record<string, string> = {
  gmail: "Gmail", calendar: "Google Calendar", drive: "Google Drive", outlook: "Outlook", onedrive: "OneDrive", teams: "Teams",
  slack: "Slack", hubspot: "HubSpot", qbo: "QuickBooks", notion: "Notion", jira: "Jira", confluence: "Confluence",
  linear: "Linear", github: "GitHub", mock: "Test source",
};
const WORK_ACTIONS: Record<string, string> = {
  send: "Send e-mail", draft: "Draft e-mail", post: "Post a message", create: "Create an event", note: "Add a note",
  create_task: "Create a task", update_deal: "Update a deal", create_invoice_draft: "Create an invoice draft",
  create_page: "Create a page", comment: "Add a comment", create_issue: "Create an issue",
};

/** An approval's tool and scope in words for a Work connector tool (`omnirush-work_gmail_send` → "Send e-mail (Gmail)",
 *  "Your Gmail account"); null for any other permission. */
export function workToolPermission(permission: string): { label: string; scope: string } | null {
  if (!permission.startsWith(WORK_TOOL_PREFIX)) return null;
  const tool = permission.slice(WORK_TOOL_PREFIX.length);
  if (tool === "work_remember") return { label: "Save to company knowledge", scope: "Your Work knowledge" };
  if (tool === "work_forget") return { label: "Forget saved knowledge", scope: "Your Work knowledge" };
  const [app, ...rest] = tool.split("_");
  const action = WORK_ACTIONS[rest.join("_")] ?? (rest.join(" ") || tool).replace(/^./, (c) => c.toUpperCase());
  const name = WORK_APPS[app] ?? app;
  return { label: `${action} (${name})`, scope: `Your ${name} account` };
}

/** Connector names for ids the server lists without a label; an unknown id shows as it is (with a generic icon). */
export const CONNECTOR_LABELS: Record<string, string> = {
  google: "Google", microsoft: "Microsoft 365", slack: "Slack", hubspot: "HubSpot", quickbooks: "QuickBooks Online",
  notion: "Notion", jira: "Jira", confluence: "Confluence", linear: "Linear", github: "GitHub", mock: "Test source", demo: "Sample data",
};
export const connectorLabel = (id: string, label?: string | null) => label?.trim() || CONNECTOR_LABELS[id] || id;

/** What each connector lets the agent do, in a line, for the Connectors page (an unknown id gets the generic line). */
export const CONNECTOR_ACCESS: Record<string, string> = {
  google: "Reads Gmail, Drive and Calendar. Drafts and sends e-mail and creates events only after you approve.",
  microsoft: "Reads Outlook, OneDrive, SharePoint and Teams chats (work or school account). Sends and posts only after you approve.",
  slack: "Reads the channels, DMs and files you can see. Posts as you only after you approve.",
  hubspot: "Reads contacts, companies, deals and tickets. Adds notes and tasks and updates deals only after you approve.",
  quickbooks: "Reads customers, invoices, bills and payments. Creates invoice drafts only after you approve.",
  notion: "Reads only the pages you share with OmniRush when you connect. Creates pages only after you approve.",
  jira: "Reads issues and comments on the sites you allow. Comments and creates issues only after you approve.",
  confluence: "Reads pages, spaces and comments on the sites you allow. Creates pages only after you approve.",
  linear: "Reads issues, projects and comments. Comments and creates issues only after you approve.",
  github: "Reads issues, pull requests and docs in the repositories you install the OmniRush app on. Comments and creates issues only after you approve.",
};
export const connectorAccess = (id: string) => CONNECTOR_ACCESS[id] ?? "Connect to let the agent search and use it. It asks you before it sends or changes anything.";

/** A connector's setup link label: GitHub's is where the user picks repositories. */
export const setupLabel = (id: string) => (id === "github" ? "Choose repositories" : "Finish setup");

const WORK_ERROR_COPY: Record<string, string> = {
  reconnect_required: "Sign-in expired or access was revoked. Reconnect.",
  rate_limited: "The service asked us to slow down. Sync resumes on its own.",
  provider_error: "The service returned an error. Sync retries on its own.",
  provider_unreachable: "The service could not be reached. Sync retries on its own.",
  token_exchange_failed: "The service did not accept the sign-in. Reconnect.",
  connector_unavailable: "This connector is not available on this server right now.",
  work_disabled: "Work is turned off for your account.",
  not_connected: "Not connected.",
};

/** A server error code (a source's `error`, a health check detail) in words. Unknown codes (internal names such as
 *  `KeyError`) never reach the screen as they are. */
export function workErrorText(code: string | null | undefined): string {
  if (!code) return "Something went wrong. Reconnect.";
  return WORK_ERROR_COPY[code] ?? "Sync failed. OmniRush retries on its own; reconnect if it keeps failing.";
}

/** A source in `error`: its sync has stopped (signed out, or too many failures in a row) until it is reconnected. */
export function sourceErrorText(code: string | null | undefined): string {
  return code === "reconnect_required" || code === "token_exchange_failed" ? workErrorText(code) : "Sync stopped after repeated errors. Reconnect to start it again.";
}

/** One source's row of a GET /work/health answer (a list, or `{sources}` / `{items}`); null when absent. */
export function healthFor(answer: unknown, id: string): OmniRushWorkHealth | null {
  const box = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
  const rows = Array.isArray(answer) ? answer : Array.isArray(box?.sources) ? box.sources : Array.isArray(box?.items) ? box.items : [];
  const row = rows.find((item): item is OmniRushWorkHealth => Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === id);
  return row ?? null;
}

const CHECK_NAMES: Record<string, string> = { token: "Sign-in", scopes: "Permissions", sync: "Sync" };

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
  if (missing.length) return { text: `Missing permissions: ${missing.join(", ")}. Reconnect to grant them.`, reconnect: true };
  // A token that fails says nothing about the scopes (the server reports them as not ok then too).
  if (health.token_ok === false) return { text: "Sign-in expired or revoked. Reconnect.", reconnect: true };
  if (health.scopes_ok === false) return { text: "Missing permissions. Reconnect to grant them.", reconnect: true };
  const failed = (health.checks ?? []).find((check) => !check.ok);
  if (failed) {
    const detail = failed.detail?.trim();
    // A check's detail is either a code (`provider_error`) or already words (`sync off`).
    const words = detail && /^[a-z]+(_[a-z]+)+$|^[A-Z]\w*Error$/.test(detail) ? workErrorText(detail) : detail;
    return { text: `${CHECK_NAMES[failed.name] ?? failed.name}: ${words || "failed"}`, reconnect: detail === "reconnect_required" };
  }
  if (health.last_error) return { text: workErrorText(health.last_error), reconnect: health.last_error === "reconnect_required" };
  return null;
}

export const ENTITY_KINDS = [
  { id: "person", label: "People" },
  { id: "company", label: "Companies" },
  { id: "deal", label: "Deals" },
  { id: "project", label: "Projects" },
  { id: "product", label: "Products" },
  { id: "other", label: "Other" },
] as const;

export const FACT_KINDS = [
  { id: "fact", label: "Fact" },
  { id: "decision", label: "Decision" },
  { id: "preference", label: "Preference" },
  { id: "policy", label: "Policy" },
  { id: "contact_note", label: "Contact note" },
] as const;

/** "Ask about this": the brief a Work chat starts with, so the agent calls work_context on the entity first. */
export function askAboutPrompt(entity: Pick<OmniRushWorkEntitySummary, "id" | "kind" | "name">): string {
  return `Brief me on ${entity.name} (${entity.kind}). Call work_context for "${entity.name}" first (entity id ${entity.id}), then summarise who or what this is, our recent history across every source, open items and anything we decided or agreed to remember, with links to the sources.`;
}
