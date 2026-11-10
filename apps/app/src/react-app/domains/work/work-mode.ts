import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { OmniRushServerClient, OmniRushWorkConnector, OmniRushWorkEntitySummary, OmniRushWorkHealth, OmniRushWorkState } from "@/app/lib/omnirush-server";

/** The window's top-level mode: Code (today's app) or Work (business chats). Remembered across restarts. */
export type AppMode = "code" | "work";

export const WORK_PRESET = "work";
export const WORK_HOME_ROUTE = "/work";
export const WORK_CONNECTORS_ROUTE = "/work/connectors";
export const WORK_KNOWLEDGE_ROUTE = "/work/knowledge";

type WorkModeStore = { mode: AppMode; setMode: (mode: AppMode) => void };

export const useWorkModeStore = create<WorkModeStore>()(
  persist((set) => ({ mode: "code", setMode: (mode) => set({ mode }) }), {
    name: "omnirush.appMode",
    storage: createJSONStorage(() => localStorage),
  }),
);

export type WorkClient = Pick<OmniRushServerClient, "getWorkState" | "ensureWorkWorkspace" | "listWorkConnectors" | "startWorkConnector" | "disconnectWorkConnector" | "setWorkConnectorSync"
  | "getWorkHealth" | "listWorkEntities" | "getWorkEntity" | "addWorkFact" | "updateWorkFact"> & { baseUrl?: string };

export const workStateKey = (client: WorkClient | null) => ["omnirush-work-state", client?.baseUrl?.trim() || "default"];
export const workConnectorsKey = (client: WorkClient | null) => ["omnirush-work-connectors", client?.baseUrl?.trim() || "default"];
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

/** Cmd/Ctrl+Shift+K: switch between Code and Work. */
export function isWorkModeShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean {
  return (mac ? event.metaKey : event.ctrlKey) && event.shiftKey && !event.altKey && event.key?.toLowerCase() === "k";
}

/** The sources shown on the Connectors page: everything the server offers (an `unavailable` one is hidden). */
export function visibleConnectors(rows: OmniRushWorkConnector[] | null | undefined): OmniRushWorkConnector[] {
  return (rows ?? []).filter((row) => row.status !== "unavailable");
}

/** A connect in progress is over once the source is connected (or syncing) or reports an error. */
export function connectSettled(rows: OmniRushWorkConnector[] | null | undefined, id: string): boolean {
  const row = rows?.find((item) => item.id === id);
  return Boolean(row && (row.status === "connected" || row.status === "syncing" || row.status === "error"));
}

/** Template cards on the Work home: each starts a chat with its brief. */
export const WORK_TEMPLATES = [
  {
    id: "inbox",
    title: "Inbox",
    description: "Triage, draft replies, follow-ups.",
    prompt: "Go through my inbox from the last few days. Group what needs a reply, what needs a follow-up and what can wait, and draft replies for the urgent ones. Don't send anything.",
  },
  {
    id: "support",
    title: "Support desk",
    description: "Answer and route tickets and emails.",
    prompt: "Look at the open support tickets and customer emails. For each, suggest who should handle it and draft an answer based on how we answered similar questions before.",
  },
  {
    id: "meetings",
    title: "Meetings",
    description: "Notes to tasks and CRM updates.",
    prompt: "Take the notes from my latest meeting, list the action items with owners and dates, and suggest the CRM updates they imply.",
  },
  {
    id: "sales",
    title: "Sales/CRM",
    description: "Log leads, follow up, write quotes.",
    prompt: "Find new leads from my email and chat that are not in the CRM yet, and list who I should follow up with this week and why.",
  },
  {
    id: "search",
    title: "Company search",
    description: "\"What did we quote X?\" across mail, Drive and chat.",
    prompt: "Search my mail, Drive and chat: what did we quote each customer most recently, and when? Link the source for each.",
  },
  {
    id: "backoffice",
    title: "Back office",
    description: "Invoices, purchase orders, reconciliation.",
    prompt: "List unpaid and overdue invoices, and match recent payments and bills against them. Flag anything that doesn't reconcile.",
  },
] as const;

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
  notion: "Notion", jira: "Jira", confluence: "Confluence", linear: "Linear", github: "GitHub", mock: "Test source",
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

/** What a health check says, in a line: missing scopes (reconnect), a failed check or the last error; null when all is well. */
export function healthProblem(health: OmniRushWorkHealth | null): { text: string; reconnect: boolean } | null {
  if (!health) return null;
  const missing = (health.missing_scopes ?? []).filter(Boolean);
  if (missing.length || health.scopes_ok === false) {
    return { text: `Missing permissions${missing.length ? `: ${missing.join(", ")}` : ""}. Reconnect to grant them.`, reconnect: true };
  }
  if (health.token_ok === false) return { text: "Sign-in expired or revoked. Reconnect.", reconnect: true };
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
