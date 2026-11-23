// Record viewers (enterprise design 2.5, judge M18 to M20): the shapes GET /work/records/detail answers, how a Work item
// opens in the side panel (a `record` panel tab), the composer drafts kept on this computer, undo send, and the pure
// helpers the views and tests share. Nothing here renders.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkRecordDetail } from "@/app/lib/omnirush-server";

import { builtInCatalog, toolLabel } from "../catalog";
import { connectorLabel, type WorkClient } from "../work-mode";

// ── what the server answers ─────────────────────────────────────────────────────────────────────────────────────────

export type RecordPerson = { name?: string | null; email?: string | null; id?: string | null; me?: boolean };
export type RecordFile = {
  n: number; name: string; size?: number | null; content_type?: string | null; available?: boolean;
  cid?: string; inline?: boolean; skipped?: string;
};
export type RecordBody = { format: "html" | "markdown" | "text" | string; content: string; truncated?: boolean; origin?: string };
export type MailMessage = {
  source_id: string; from: RecordPerson; to: RecordPerson[]; cc: RecordPerson[]; reply_to?: RecordPerson[];
  at?: string | null; subject?: string | null; message_id?: string | null; references?: string | null;
  unread?: boolean; draft?: boolean; mine?: boolean; snippet?: string | null; body: RecordBody; attachments: RecordFile[];
};
export type ChatMessage = {
  source_id?: string; from: RecordPerson; at?: string | null; text: string; format?: string;
  ts?: string | null; thread_ts?: string | null; reply_count?: number | null; reply_to?: string; attachments?: RecordFile[];
};
export type RecordComment = {
  source_id?: string; author: RecordPerson; at?: string | null; body: { format: string; content: string };
  internal?: boolean; inbound?: boolean; reply?: boolean;
};
export type RecordField = { label: string; value: string };
export type RecordAnswer = "yes" | "maybe" | "no" | "none";
export type RecordAttendee = RecordPerson & { response?: RecordAnswer | string; organizer?: boolean; optional?: boolean };
export type RecordEvent = {
  start?: string | null; end?: string | null; all_day?: boolean; timezone?: string | null; location?: string | null;
  description?: string | null; join?: { provider: string | null; url: string } | null; organizer?: RecordPerson;
  is_organizer?: boolean; attendees?: RecordAttendee[]; counts?: Partial<Record<RecordAnswer, number>>;
  my_response?: RecordAnswer | string | null; recurring?: boolean; status?: string | null;
};
export type RecordAction = { id: string; label?: string; disabled?: string; reason?: string; setup_url?: string };
export type RecordLink = { source_id: string; source: string; kind: string; view?: string; subject?: string | null; occurred_at?: string | null; reason?: string | null };
export type RecordFinance = {
  number?: string | null; customer?: string | null; amount?: string | null; currency?: string | null; balance?: string | null;
  status?: string | null; issued?: string | null; due?: string | null; lines?: { description?: string | null; amount?: string | null }[];
};
export type RecordMeeting = {
  title?: string | null; started_at?: string | null; ended_at?: string | null; summary?: string | null; notes?: string | null;
  action_items?: unknown[]; participants?: RecordPerson[];
  segments?: { start_ms?: number | null; end_ms?: number | null; speaker?: string | null; text?: string | null }[];
};
export type RecordCode = {
  sha?: string | null; message?: string | null; author?: string | null; committed_at?: string | null; parents?: string[];
  files?: { path?: string | null; status?: string | null; additions?: number | null; deletions?: number | null }[];
  status?: string | null; ref?: string | null; source?: string | null; duration?: number | null;
};
export type RecordPullRequest = {
  merged?: boolean; draft?: boolean; head?: { ref?: string; label?: string } | string; base?: { ref?: string; label?: string } | string;
  changed_files?: number; additions?: number; deletions?: number;
};
export type WorkRecord = Omit<OmniRushWorkRecordDetail, "body" | "attachments" | "thread" | "comments" | "fields" | "event" | "links" | "actions" | "actors"> & {
  body?: RecordBody | null;
  attachments?: RecordFile[];
  thread?: (MailMessage | ChatMessage)[];
  comments?: RecordComment[];
  fields?: RecordField[];
  event?: RecordEvent | null;
  links?: RecordLink[];
  actions?: RecordAction[];
  actors?: (RecordPerson & { role?: string | null })[];
  origin?: string;
  read_only?: string;
  note?: string;
  people?: RecordPerson[];
  where?: string | null;
  threaded?: boolean;
  ref?: { repo?: string | null; number?: number | null; key?: string | null };
  labels?: string[];
  pull_request?: RecordPullRequest;
  requester?: RecordPerson;
  finance?: RecordFinance;
  meeting?: RecordMeeting;
  code?: RecordCode;
  stage?: string | null;
  path?: string | null;
};

export type RecordClient = Pick<WorkClient, "getWorkRecord" | "getWorkRecordAttachment" | "runWorkRecordAction" | "composeWork" | "undoWorkAction" | "startWorkConnector"> & { baseUrl?: string };

export const workRecordKey = (client: { baseUrl?: string } | null, sourceId: string) => ["omnirush-work-record", client?.baseUrl?.trim() || "default", sourceId];

// ── opening an item ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What a list row knows about the item it opens. */
export type RecordRef = { sourceId: string; source?: string | null; kind?: string | null; title?: string | null; url?: string | null };
/** A new mail or meeting, opened in the panel like a record. */
export type RecordCompose = { kind: "mail" | "meeting"; connector?: "google" | "microsoft"; to?: string[]; attendees?: string[]; title?: string; subject?: string };
export type OpenRecordRequest = RecordRef & {
  /** The list it was opened from, so [ and ] step through it. */
  list?: RecordRef[];
  /** Open beside the current record instead of in its place. */
  newTab?: boolean;
  compose?: RecordCompose;
};

export const OPEN_WORK_RECORD_EVENT = "omnirush-open-work-record";
export const ASK_WORK_RECORD_EVENT = "omnirush-ask-work-record";
export const RECORD_TAB_PREFIX = "record:";
/** A record's tab is the record's; each new mail or meeting gets a tab of its own. */
export const recordTabId = (request: Pick<OpenRecordRequest, "sourceId" | "compose">) =>
  request.compose ? `${RECORD_TAB_PREFIX}compose:${request.compose.kind}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : `${RECORD_TAB_PREFIX}${request.sourceId}`;

/** Whether this server has the viewers: unknown until the first record answers; an older server (404 on the route)
 *  makes every item open at its source again, as before. */
type ViewerSupport = { support: "unknown" | "yes" | "no"; setSupport: (support: "yes" | "no") => void };
export const useViewerSupport = create<ViewerSupport>((set) => ({ support: "unknown", setSupport: (support) => set({ support }) }));

/** The lists items were opened from (by record tab), for [ and ]. Kept in memory only. */
const lists = new Map<string, RecordRef[]>();
export function recordList(tabId: string): RecordRef[] { return lists.get(tabId) ?? []; }
export function setRecordList(tabId: string, list: RecordRef[] | undefined) { if (list?.length) lists.set(tabId, list); }
export function neighbour(list: RecordRef[], sourceId: string, step: 1 | -1): RecordRef | null {
  const at = list.findIndex((item) => item.sourceId === sourceId);
  if (at < 0) return null;
  return list[at + step] ?? null;
}

/** Ask the side panel to show an item (the session page listens). */
export function requestOpenRecord(request: OpenRecordRequest) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenRecordRequest>(OPEN_WORK_RECORD_EVENT, { detail: request }));
}
export function onOpenRecordRequest(handler: (request: OpenRecordRequest) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<OpenRecordRequest>).detail;
    if (detail && typeof detail.sourceId === "string") handler(detail);
  };
  window.addEventListener(OPEN_WORK_RECORD_EVENT, listener);
  return () => window.removeEventListener(OPEN_WORK_RECORD_EVENT, listener);
}
/** "Ask" in a viewer: a Work chat about the record (the session route starts it). */
export function requestAskAbout(prompt: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(ASK_WORK_RECORD_EVENT, { detail: prompt }));
}

/** A row's open: in the panel when the item has a record id and the server has viewers, else at its source as before.
 *  `external` (Cmd/Ctrl+Enter or a modifier click) always opens at the source. */
export function openItem(ref: RecordRef & { list?: RecordRef[] }, openLink: (url: string) => void, options: { external?: boolean; newTab?: boolean } = {}) {
  const support = useViewerSupport.getState().support;
  if (options.external || !ref.sourceId || support === "no") {
    if (ref.url) openLink(ref.url);
    return;
  }
  requestOpenRecord({ ...ref, newTab: options.newTab });
}
/** Whether a row can open at all (a record id or a link). */
export const canOpen = (ref: Partial<RecordRef>) => Boolean(ref.sourceId || ref.url);

/** A modifier click or Cmd/Ctrl+Enter: open at the source. Shift: beside the current record. */
export function openModifiers(event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, mac: boolean) {
  return { external: Boolean(mac ? event.metaKey : event.ctrlKey), newTab: Boolean(event.shiftKey) };
}
export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

/** An older server: the route is missing (404 with no Work code). A known miss (`unknown_record`) is the server's answer. */
export function isMissingRoute(error: unknown): boolean {
  const failure = error && typeof error === "object" ? (error as { status?: unknown; code?: unknown }) : {};
  if (failure.status !== 404) return false;
  const code = typeof failure.code === "string" ? failure.code : "";
  return !code || code === "Not Found" || code === "not_found" || code === "request_failed";
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = {
  gmail: "Gmail", calendar: "Google Calendar", drive: "Google Drive", outlook: "Outlook", teams: "Teams",
  onedrive: "OneDrive", sharepoint: "SharePoint",
};
let catalog: ReturnType<typeof builtInCatalog> | null = null;
/** A connector's name as people know it ("Xero", "monday.com"), from the built-in catalog, else the Work label. */
export function connectorName(source: string): string {
  catalog ??= builtInCatalog([]);
  const known = toolLabel(catalog, source);
  return (known && known !== source && source !== "google" && source !== "microsoft" ? known : connectorLabel(source)).replace(/\s*\(.*\)$/, "");
}
/** The product a Google or Microsoft record belongs to (its mark and name): Gmail, Calendar, Drive, Outlook, Teams. */
export function channelFor(source: string | null | undefined, kind: string | null | undefined, channel?: string | null): string | null {
  if (channel && CHANNEL_LABELS[channel]) return channel;
  if (source === "google") return kind === "email" ? "gmail" : kind === "event" ? "calendar" : kind === "file" ? "drive" : null;
  if (source === "microsoft") return kind === "email" || kind === "event" ? "outlook" : kind === "message" || kind === "chat" ? "teams" : kind === "file" ? "onedrive" : null;
  return null;
}
/** "Gmail", "Slack", "GitHub": the record's product when it names one, else its connector. */
export function sourceLabel(record: { source: string; kind?: string | null; channel?: string | null }): string {
  const channel = channelFor(record.source, record.kind, record.channel);
  return (channel && CHANNEL_LABELS[channel]) || connectorName(record.source);
}
/** The mark a record shows: its product's (Gmail, Outlook, Teams), else its connector's. */
export function sourceMark(record: { source?: string | null; kind?: string | null; channel?: string | null }): string {
  return channelFor(record.source, record.kind, record.channel) ?? record.source ?? "generic";
}
/** "AUTHORISED" or "open" as "Authorised", "Open". */
export function stateLabel(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  if (!text) return text;
  const lower = text === text.toUpperCase() ? text.toLowerCase() : text;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function personName(person: RecordPerson | null | undefined): string {
  if (!person) return "";
  if (person.me) return t("work.viewer.you");
  return person.name?.trim() || person.email?.trim() || "";
}
export function initials(person: RecordPerson | null | undefined): string {
  const name = person?.name?.trim() || person?.email?.split("@")[0] || "";
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase();
}
/** A stable soft tint for an avatar (radix steps, never a gradient). */
const TINTS = ["bg-blue-4 text-blue-11", "bg-green-4 text-green-11", "bg-amber-4 text-amber-11", "bg-purple-4 text-purple-11", "bg-red-4 text-red-11", "bg-cyan-4 text-cyan-11", "bg-pink-4 text-pink-11", "bg-gray-4 text-gray-11"];
export function tint(person: RecordPerson | null | undefined): string {
  const key = (person?.email || person?.name || "?").toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length]!;
}

/** "to you, Ben Okafor and 2 more" */
export function recipientsLine(to: RecordPerson[], cc: RecordPerson[] = []): string {
  const names = [...new Set([...to, ...cc].map(personName).filter(Boolean))];
  if (!names.length) return "";
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? t("work.viewer.to_more", { names: shown, count: names.length - 2 }) : t("work.viewer.to_names", { names: shown });
}

export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const SAME_DAY = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** "09:12" today, "Nov 21, 10:02" this year, "Nov 21, 2025" before. */
export function shortWhen(value: string | null | undefined, now = new Date()): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  if (SAME_DAY(at, now)) return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
/** "Today", "Yesterday", "Mon, Nov 24" for chat day dividers. */
export function dayLabel(value: string | null | undefined, now = new Date()): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  if (SAME_DAY(at, now)) return t("work.viewer.today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (SAME_DAY(at, yesterday)) return t("work.viewer.yesterday");
  return at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
/** An event's time: "Mon, Nov 24 · 15:21 to 15:51", an all-day "Mon, Nov 24", or across days. */
export function eventWhen(event: Pick<RecordEvent, "start" | "end" | "all_day">): string {
  if (!event.start) return "";
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return event.start;
  const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const end = event.end ? new Date(event.end) : null;
  if (event.all_day || (/^\d{4}-\d{2}-\d{2}$/.test(event.start))) return day(start);
  if (!end || Number.isNaN(end.getTime())) return `${day(start)} · ${time(start)}`;
  if (SAME_DAY(start, end)) return t("work.viewer.time_range", { day: day(start), start: time(start), end: time(end) });
  return t("work.viewer.time_span", { start: `${day(start)} ${time(start)}`, end: `${day(end)} ${time(end)}` });
}
export function zoneName(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The composer each action opens and what it sends. */
export type ComposeKind = "mail" | "chat" | "comment" | "note" | "task" | "stage" | "rsvp" | "reschedule" | "cancel";
export const ACTION_KIND: Record<string, ComposeKind> = {
  reply: "mail", reply_all: "mail", forward: "mail", draft: "mail",
  post: "chat", comment: "comment", note: "note", task: "task", stage: "stage",
  rsvp: "rsvp", reschedule: "reschedule", cancel: "cancel",
};
/** For chat, ticket and CRM views `reply` is a message in place, not a mail. */
export function composeKind(view: string, action: string): ComposeKind {
  if (action === "reply" && view !== "mail") return view === "chat" ? "chat" : "comment";
  return ACTION_KIND[action] ?? "comment";
}

export function actionLabel(action: Pick<RecordAction, "id" | "label">, view?: string): string {
  const own: Record<string, string> = {
    reply: view === "chat" ? t("work.viewer.reply_thread") : view === "ticket" ? t("work.viewer.reply_customer") : t("work.viewer.reply"),
    reply_all: t("work.viewer.reply_all"),
    forward: t("work.viewer.forward"),
    draft: t("work.viewer.save_draft"),
    post: t("work.viewer.post_channel"),
    comment: view === "ticket" ? t("work.viewer.internal_comment") : t("work.viewer.comment"),
    note: view === "ticket" ? t("work.viewer.internal_note") : t("work.viewer.add_note"),
    task: t("work.viewer.add_task"),
    stage: t("work.viewer.change_stage"),
    rsvp: t("work.viewer.respond"),
    reschedule: t("work.viewer.reschedule"),
    cancel: t("work.viewer.cancel_event"),
  };
  return own[action.id] ?? action.label ?? action.id;
}

/** Why an action can't run yet, in words (the server's own reason first). */
export function disabledReason(action: RecordAction, source: string): string | null {
  if (!action.disabled) return null;
  if (action.reason) return action.reason;
  const name = connectorName(source);
  if (action.disabled === "not_connected") return t("work.viewer.not_connected", { name });
  if (action.disabled === "reconnect_required") return t("work.viewer.reconnect_to_act", { name });
  if (action.disabled === "needs_install") return t("work.viewer.needs_install_generic");
  if (action.disabled === "needs_permission") return t("work.viewer.needs_permission_generic");
  return t("work.viewer.cannot_act");
}

/** Comment-like actions send Markdown where the provider reads it, else plain text, plus HTML where it is kept. */
const MARKDOWN_SOURCES = new Set(["github", "gitlab", "linear", "trello", "slack", "discord"]);
export type ComposerContent = { html: string; text: string; markdown: string };
export type MailFields = { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; message?: string; attachments?: number[] };

/** The `args` of POST /work/records/action for what the composer holds (design 3.10, records.py plans). */
export function actionArgs(input: {
  action: string; source: string; content?: ComposerContent; mail?: MailFields; response?: RecordAnswer; comment?: string;
  stage?: string; subject?: string; due?: string; start?: string; end?: string; timezone?: string; title?: string; video?: string; notify?: boolean;
}): Record<string, unknown> {
  const { action, source, content } = input;
  const out: Record<string, unknown> = {};
  if (action === "rsvp") {
    out.response = input.response;
    if (input.comment?.trim()) out.comment = input.comment.trim();
    return out;
  }
  if (action === "reschedule") {
    if (input.start) out.start = input.start;
    if (input.end) out.end = input.end;
    if (input.timezone) out.timezone = input.timezone;
    if (input.title?.trim()) out.title = input.title.trim();
    if (input.video) out.video = input.video;
    return out;
  }
  if (action === "cancel") return { notify: input.notify !== false };
  if (action === "stage") return { stage: input.stage };
  if (action === "task") {
    out.subject = (input.subject ?? "").trim();
    if (content?.text.trim()) out.body = content.text.trim();
    if (input.due) out.due = input.due;
    return out;
  }
  if (content) {
    out.body = content.text;
    if (MARKDOWN_SOURCES.has(source)) out.markdown = content.markdown;
    if (content.html) out.html = content.html;
  }
  if (input.mail) {
    const mail = input.mail;
    for (const key of ["to", "cc", "bcc"] as const) if (mail[key]?.length) out[key] = mail[key];
    if (mail.subject?.trim()) out.subject = mail.subject.trim();
    if (mail.message) out.message = mail.message;
    if (action === "forward" && mail.attachments) out.attachments = mail.attachments;
  }
  if (action === "draft") out.mode = input.mail?.subject?.toLowerCase().startsWith("fwd") ? "forward" : "reply";
  return out;
}

/** A fresh id the server uses to answer a retried send once (8 to 128 of [A-Za-z0-9_.:-]). */
export function clientActionId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `viewer-${random}`.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
}

/** Who a reply goes to by default (the server fills these too; shown as chips so they can be changed). */
export function defaultRecipients(action: "reply" | "reply_all" | "forward", message: MailMessage | null): { to: string[]; cc: string[] } {
  if (!message || action === "forward") return { to: [], cc: [] };
  const email = (p: RecordPerson) => p.email?.trim().toLowerCase() || "";
  const mine = (p: RecordPerson) => Boolean(p.me);
  const fromMe = mine(message.from);
  const sender = (message.reply_to?.length ? message.reply_to : [message.from]).filter((p) => !mine(p));
  const base = fromMe ? message.to.filter((p) => !mine(p)) : sender;
  const to = [...new Set(base.map(email).filter(Boolean))];
  if (action === "reply") return { to, cc: [] };
  const more = message.to.filter((p) => !mine(p)).map(email).filter((e) => e && !to.includes(e));
  const cc = [...new Set(message.cc.filter((p) => !mine(p)).map(email).filter((e) => e && !to.includes(e) && !more.includes(e)))];
  return { to: [...to, ...more], cc };
}

export const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
/** Addresses pasted or typed into a recipient field ("Ana <ana@x.com>, ben@y.com"). */
export function parseAddresses(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const angle = part.match(/<([^>]+)>/);
    const address = (angle ? angle[1]! : part).trim().toLowerCase();
    if (EMAIL_RE.test(address) && !out.includes(address)) out.push(address);
  }
  return out;
}

// ── drafts and undo send ────────────────────────────────────────────────────────────────────────────────────────────

/** A composer draft kept on this computer until it is sent (a send held when the app quits is dropped; the draft stays). */
export type RecordDraft = { action: string; editor?: string; text?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; attachments?: number[]; updatedAt: number };
type DraftStore = {
  drafts: Record<string, RecordDraft>;
  save: (key: string, draft: Omit<RecordDraft, "updatedAt">) => void;
  clear: (key: string) => void;
};
export const draftKey = (sourceId: string, action: string) => `${sourceId}::${action}`;
const DRAFT_DAYS = 30;
export const useRecordDrafts = create<DraftStore>()(
  persist(
    (set) => ({
      drafts: {},
      save: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: { ...draft, updatedAt: Date.now() } } })),
      clear: (key) => set((state) => {
        if (!(key in state.drafts)) return state;
        const drafts = { ...state.drafts };
        delete drafts[key];
        return { drafts };
      }),
    }),
    {
      name: "omnirush.work.viewer-drafts",
      storage: createJSONStorage(() => localStorage),
      // Old drafts go after a month; at most 200 are kept.
      merge: (persisted, current) => {
        const found = (persisted as { drafts?: Record<string, RecordDraft> } | undefined)?.drafts ?? {};
        const cutoff = Date.now() - DRAFT_DAYS * 86_400_000;
        const kept = Object.entries(found).filter(([, d]) => d && d.updatedAt > cutoff).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 200);
        return { ...current, drafts: Object.fromEntries(kept) };
      },
    },
  ),
);
export function hasDraft(sourceId: string): boolean {
  const prefix = `${sourceId}::`;
  return Object.entries(useRecordDrafts.getState().drafts).some(([key, d]) => key.startsWith(prefix) && Boolean(d.text?.trim()));
}

/** Undo send: how long a send waits (seconds; 0 = at once). Settings > Work, default 5 (judge decision 10). */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20] as const;
export type UndoSendDelay = (typeof UNDO_SEND_CHOICES)[number];
type UndoSendStore = { delay: UndoSendDelay; setDelay: (delay: UndoSendDelay) => void };
export const useUndoSendStore = create<UndoSendStore>()(
  persist((set) => ({ delay: 5, setDelay: (delay) => set({ delay: UNDO_SEND_CHOICES.includes(delay) ? delay : 5 }) }), {
    name: "omnirush.work.undo-send",
    storage: createJSONStorage(() => localStorage),
  }),
);

/** Sends waiting out the undo window (design 2.5): a toast says "Sending" with Undo (and Cmd/Ctrl+Z) until it goes.
 *  Undo drops the send and calls `onUndo` (the composer opens again with its draft, which was never cleared). */
export type HeldSend = { id: string; sourceId: string; label: string; due: number; timer: ReturnType<typeof setTimeout> | null; onUndo?: () => void };
type HoldStore = { held: HeldSend[] };
export const useHeldSends = create<HoldStore>(() => ({ held: [] }));

/** Whether focus is somewhere text is typed (keys there are the text's, not shortcuts). */
export function isEditable(target: EventTarget | null | undefined): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test((element as HTMLInputElement).type));
}

let undoKey = false;
function installUndoKey() {
  if (undoKey || typeof window === "undefined") return;
  undoKey = true;
  window.addEventListener("keydown", (event) => {
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "z" || !useHeldSends.getState().held.length) return;
    // Text being typed keeps its own undo.
    const target = event.target as HTMLElement | null;
    if (isEditable(target) && (target?.textContent || (target as HTMLInputElement | null)?.value || "").trim()) return;
    event.preventDefault();
    event.stopPropagation();
    cancelHeld();
  }, true);
}

export function holdSend(input: { sourceId: string; label: string; delayMs: number; run: () => void; onUndo?: () => void }): string {
  const id = clientActionId();
  const entry: HeldSend = { id, sourceId: input.sourceId, label: input.label, due: Date.now() + input.delayMs, timer: null, onUndo: input.onUndo };
  const fire = () => {
    const still = useHeldSends.getState().held.some((h) => h.id === id);
    useHeldSends.setState((state) => ({ held: state.held.filter((h) => h.id !== id) }));
    toast.dismiss(id);
    if (still) input.run();
  };
  if (input.delayMs <= 0) {
    input.run();
    return id;
  }
  installUndoKey();
  entry.timer = setTimeout(fire, input.delayMs);
  useHeldSends.setState((state) => ({ held: [...state.held, entry] }));
  toast.undo(t("work.viewer.sending", { label: input.label }), {
    id,
    duration: input.delayMs,
    undo: { label: t("work.viewer.undo"), onClick: () => { cancelHeld(id); } },
    closeLabel: t("common.close"),
  });
  return id;
}
export function cancelHeld(id?: string): HeldSend | null {
  const held = useHeldSends.getState().held;
  const found = id ? held.find((h) => h.id === id) : held[held.length - 1];
  if (!found) return null;
  if (found.timer) clearTimeout(found.timer);
  useHeldSends.setState((state) => ({ held: state.held.filter((h) => h.id !== found.id) }));
  toast.dismiss(found.id);
  found.onUndo?.();
  return found;
}
export const isHeld = (sourceId: string) => useHeldSends.getState().held.some((h) => h.sourceId === sourceId);

/** A record tab may be replaced by the next item opened unless it holds a draft or a send in its undo window. */
export function replaceable(sourceId: string | undefined): boolean {
  if (!sourceId) return true;
  return !hasDraft(sourceId) && !isHeld(sourceId);
}

/** Prompt for "Ask": the same words as Ask on a Today row. */
export function askPrompt(record: Pick<WorkRecord, "source" | "kind" | "subject" | "url" | "source_id">): string {
  const source = connectorLabel(record.source);
  const title = record.subject?.trim() || record.kind;
  return `Help me with this ${record.kind.replace(/_/g, " ")} from ${source}: "${title}"${record.url ? ` (${record.url})` : ""}, source id ${record.source_id}. Look it up first, then tell me what it is, what is needed from me and anything related, with links.`;
}

/** One write from a view: the action, its args, what the toast says, and whether it waits out the undo window
 *  (mail, chat and comments do; answering an invite or moving an event does not). Resolves true once done. */
export type SendInput = { action: string; args: Record<string, unknown>; label: string; hold?: boolean; pending?: string; done?: string };
export type SendFn = (input: SendInput) => Promise<boolean>;
