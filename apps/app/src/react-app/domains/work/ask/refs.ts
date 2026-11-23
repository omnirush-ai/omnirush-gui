// Ask with context (design 2): a Work item the user asks about rides in the composer as a reference chip. Here are
// the reference itself, how each Work list builds one, the questions offered for it, and the note the agent gets in
// place of the chips (one synthetic text part: kind, title, source, ids, link and the first tool to call).
import { t } from "@/i18n";
import type { ComposerDraft } from "@/app/types";
import type {
  OmniRushWorkDeal, OmniRushWorkEntitySummary, OmniRushWorkFeedItem, OmniRushWorkGraphNode, OmniRushWorkSearchItem,
} from "@/app/lib/omnirush-server";

import { sourceLabel, sourceMark, type RecordRef, type WorkRecord } from "../viewer/records";

export type WorkRefKind =
  | "email" | "chat" | "event" | "meeting" | "issue" | "doc" | "ticket" | "deal" | "invoice"
  | "person" | "company" | "project" | "note" | "other";

export type WorkRef = {
  kind: WorkRefKind;
  /** One line, at most 120 characters. */
  title: string;
  /** Connector or channel id (google, gmail, github, hubspot, meetings ...). */
  source?: string | null;
  /** A record's source_id (work_read, work_deals). */
  sourceId?: string | null;
  /** A graph entity's id (work_entity). */
  entityId?: string | null;
  url?: string | null;
  /** An entity's keys, at most 3. */
  keys?: string[];
  /** The server's kind (pull_request, invoice ...). */
  rawKind?: string | null;
  /** A deal's company. */
  company?: string | null;
  /** A note's entity (its name), for work_entity. */
  about?: string | null;
  /** When it happened, for finding an item without an id. */
  date?: string | null;
};

export const MAX_REFS = 5;
const TITLE_MAX = 120;
const NOTE_MAX = 200;
const PLACEHOLDER_TITLE_MAX = 28;

/** One line, no control characters, at most `max` characters. */
export function oneLine(value: string | null | undefined, max = TITLE_MAX): string {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/** The ref kind for a server kind (and the viewer's view when known). */
export function refKind(rawKind: string | null | undefined, view?: string | null): WorkRefKind {
  const kind = (rawKind ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(email|mail|draft|e_?mail_thread)$/.test(kind)) return "email";
  if (/^(event|calendar_event|invite)$/.test(kind)) return "event";
  if (/^(meeting|call|recording|transcript|meeting_note)s?$/.test(kind)) return "meeting";
  if (/^(issue|pull_request|pr|merge_request|mr|story|bug|task|epic|card|item)$/.test(kind)) return "issue";
  if (/^(ticket|conversation|case|support_ticket)$/.test(kind)) return "ticket";
  if (/^(deal|opportunity)$/.test(kind)) return "deal";
  if (/^(invoice|bill|payment|order|quote|estimate|credit_note|expense|transaction)$/.test(kind)) return "invoice";
  if (/^(person|contact|lead|user|member)$/.test(kind)) return "person";
  if (/^(company|account|organization|organisation|org|customer|vendor|supplier)$/.test(kind)) return "company";
  if (/^(project|repo|repository|product|board|space|workspace)$/.test(kind)) return "project";
  if (/^(message|chat|chat_message|dm|thread|post|channel_message|reply)$/.test(kind)) return "chat";
  if (/^(doc|document|file|page|sheet|spreadsheet|slide|presentation|note|wiki|commit|build|folder|form|design)$/.test(kind)) return "doc";
  switch (view) {
    case "mail": return "email";
    case "chat": return "chat";
    case "event": return "event";
    case "meeting": return "meeting";
    case "issue": return "issue";
    case "ticket": return "ticket";
    case "finance": return "invoice";
    case "doc":
    case "code": return "doc";
    default: return "other";
  }
}

/** Two chips are the same item when they share a record id, an entity id, or else kind, title and link. */
export function refKey(ref: WorkRef): string {
  if (ref.sourceId) return `r:${ref.sourceId}`;
  if (ref.entityId) return `e:${ref.entityId}`;
  return `${ref.kind}:${ref.title.toLowerCase()}:${ref.url ?? ""}:${ref.about ?? ""}`;
}

export type AddRefResult = { refs: WorkRef[]; result: "added" | "duplicate" | "full"; key: string };
/** Add a chip: a duplicate is not added again, and there are at most 5. */
export function addRef(refs: readonly WorkRef[], ref: WorkRef): AddRefResult {
  const key = refKey(ref);
  if (refs.some((item) => refKey(item) === key)) return { refs: [...refs], result: "duplicate", key };
  if (refs.length >= MAX_REFS) return { refs: [...refs], result: "full", key };
  return { refs: [...refs, ref], result: "added", key };
}

const clean = (ref: WorkRef): WorkRef => {
  const out: WorkRef = { kind: ref.kind, title: oneLine(ref.title) || oneLine(ref.rawKind?.replace(/_/g, " ")) || ref.kind };
  for (const field of ["source", "sourceId", "entityId", "url", "rawKind", "company", "about", "date"] as const) {
    const value = ref[field]?.trim();
    if (value) out[field] = field === "url" || field === "sourceId" || field === "entityId" ? value.slice(0, 2048) : oneLine(value, field === "about" ? TITLE_MAX : 200);
  }
  const keys = (ref.keys ?? []).map((key) => oneLine(key, 200)).filter(Boolean).slice(0, 3);
  if (keys.length) out.keys = keys;
  return out;
};

// ── builders, one per Work list ─────────────────────────────────────────────────────────────────────────────────────

/** A Today row. Its `id` is the feed row's (r:<uuid>); the record is `source_id` (what work_read takes). */
export function refFromFeedItem(item: Pick<OmniRushWorkFeedItem, "source" | "kind" | "title" | "url" | "source_id" | "starts_at" | "due_at" | "at">): WorkRef {
  return clean({ kind: refKind(item.kind), title: item.title, source: item.source, sourceId: item.source_id ?? null, url: item.url ?? null, rawKind: item.kind, date: item.starts_at ?? item.due_at ?? item.at ?? null });
}

export function refFromSearchItem(item: Pick<OmniRushWorkSearchItem, "source_id" | "channel" | "kind" | "subject" | "url" | "occurred_at" | "snippet">): WorkRef {
  const title = item.subject?.trim() || (item.snippet ?? "").replace(/\*\*/g, "");
  return clean({ kind: refKind(item.kind), title, source: item.channel, sourceId: item.source_id, url: item.url ?? null, rawKind: item.kind, date: item.occurred_at ?? null });
}

export function refFromEntity(entity: Pick<OmniRushWorkEntitySummary, "id" | "kind" | "name"> & Partial<Pick<OmniRushWorkEntitySummary, "keys" | "sources">>): WorkRef {
  return clean({ kind: refKind(entity.kind), title: entity.name, source: entity.sources?.[0] ?? null, entityId: entity.id, keys: entity.keys ?? [], rawKind: entity.kind });
}

export function refFromDeal(deal: Pick<OmniRushWorkDeal, "source_id" | "name" | "company" | "url">): WorkRef {
  const source = deal.source_id.includes(":") ? deal.source_id.split(":").find((part) => part && part !== "demo") ?? null : null;
  return clean({ kind: "deal", title: deal.name?.trim() || deal.source_id, source, sourceId: deal.source_id, url: deal.url ?? null, rawKind: "deal", company: deal.company ?? null });
}

/** An open record in the viewer (or a row that only knows its RecordRef). */
export function refFromRecord(record: Pick<WorkRecord, "source_id" | "source" | "kind" | "subject" | "url"> & { view?: string | null; occurred_at?: string | null }): WorkRef {
  const kind = refKind(record.kind, record.view);
  return clean({ kind, title: record.subject?.trim() || record.kind.replace(/_/g, " "), source: record.source, sourceId: record.source_id, url: record.url ?? null, rawKind: record.kind, date: record.occurred_at ?? null });
}
export function refFromRecordRef(ref: RecordRef): WorkRef {
  return clean({ kind: refKind(ref.kind), title: ref.title?.trim() || (ref.kind ?? "").replace(/_/g, " "), source: ref.source ?? null, sourceId: ref.sourceId || null, url: ref.url ?? null, rawKind: ref.kind ?? null });
}

/** A graph or timeline node: an entity (`e:<id>`), a record (`r:<uuid>`, its `source_id` when the server sends one) or a
 *  saved note (`f:<id>`, its entity's name in `sub`). An older server sends no `source_id`: the note asks for a search. */
export function refFromGraphNode(node: Pick<OmniRushWorkGraphNode, "id" | "type" | "kind" | "label"> & Partial<Pick<OmniRushWorkGraphNode, "sub" | "source" | "occurred_at" | "url" | "source_id">>): WorkRef {
  if (node.type === "entity" || node.id.startsWith("e:")) {
    return refFromEntity({ id: node.id.replace(/^e:/, ""), kind: node.kind, name: node.label, sources: node.source ? [node.source] : [] });
  }
  if (node.type === "fact" || node.id.startsWith("f:")) {
    return clean({ kind: "note", title: oneLine(node.label, NOTE_MAX), rawKind: node.kind, about: node.sub ?? null, date: node.occurred_at ?? null });
  }
  return clean({ kind: refKind(node.kind), title: node.label, source: node.source ?? null, sourceId: node.source_id ?? null, url: node.url ?? null, rawKind: node.kind, date: node.occurred_at ?? null });
}

/** A saved meeting is the record `meetings:<id>`. */
export function refFromMeeting(meetingId: string, title?: string | null): WorkRef {
  return clean({ kind: "meeting", title: title?.trim() || t("work.ask.meeting_title"), source: "meetings", sourceId: `meetings:${meetingId}`, rawKind: "meeting" });
}

// ── what the chip shows ─────────────────────────────────────────────────────────────────────────────────────────────

/** The brand mark for a chip (BrandTile id), or null for a letter tile. */
export function refMark(ref: WorkRef): string | null {
  if (!ref.source) return ref.kind === "meeting" ? "meetings" : null;
  return sourceMark({ source: ref.source, kind: ref.rawKind, channel: ref.source });
}

export function refSourceName(ref: WorkRef): string | null {
  if (!ref.source) return null;
  return sourceLabel({ source: ref.source, kind: ref.rawKind, channel: ref.source });
}

// ── the questions offered ───────────────────────────────────────────────────────────────────────────────────────────

const STARTER_KINDS: WorkRefKind[] = ["email", "chat", "event", "meeting", "issue", "doc", "ticket", "deal", "invoice", "person", "company", "project", "note", "other"];
export const starterKeys = (kind: WorkRefKind | "several"): string[] => {
  const count = kind === "several" ? 2 : 3;
  return Array.from({ length: count }, (_, index) => `work.ask.starter_${kind}_${index + 1}`);
};
export const ALL_STARTER_KEYS = [...STARTER_KINDS, "several" as const].flatMap(starterKeys);

/** Up to three questions for the attached items, in the user's words. */
export function starterQuestions(refs: readonly WorkRef[]): string[] {
  if (refs.length === 0) return [];
  const kind = refs.length > 1 ? "several" : refs[0]!.kind;
  return starterKeys(kind).map((key) => t(key));
}

/** What a send with only chips says in the bubble. */
export function defaultQuestion(refs: readonly WorkRef[]): string {
  return refs.length > 1 ? t("work.ask.default_many") : t("work.ask.default_one");
}

/** The composer's placeholder while chips are attached. */
export function refPlaceholder(refs: readonly WorkRef[]): string {
  if (refs.length === 0) return "";
  // A short title keeps the hint on one line in the chat beside the viewer.
  if (refs.length === 1) return t("work.ask.placeholder_one", { title: oneLine(refs[0]!.title, PLACEHOLDER_TITLE_MAX) });
  return t("work.ask.placeholder_many", { count: refs.length });
}

/** A chat title naming the item (a send with only chips). */
export function refTitle(refs: readonly WorkRef[]): string {
  const first = oneLine(refs[0]?.title, 60);
  return refs.length > 1 ? t("work.ask.title_many", { title: first, count: refs.length - 1 }) : first;
}

/** The title for a chat whose first question is only chips (its text is the default question); null otherwise. */
export function refsOnlyTitle(draft: Pick<ComposerDraft, "parts" | "text">, started: boolean): string | null {
  if (started) return null;
  const refs = draftRefs(draft);
  if (!refs.length || draft.text.trim() !== defaultQuestion(refs)) return null;
  return refTitle(refs) || null;
}

/** A draft's reference chips, in order. */
export function draftRefs(draft: Pick<ComposerDraft, "parts">): WorkRef[] {
  return draft.parts.flatMap((part): WorkRef[] => (part.type === "ref" ? [part.ref] : []));
}

// ── what the agent receives ─────────────────────────────────────────────────────────────────────────────────────────

const quote = (value: string) => JSON.stringify(oneLine(value, NOTE_MAX));
const kindWord = (ref: WorkRef) => (ref.rawKind && ref.kind !== "note" ? ref.rawKind : ref.kind).replace(/_/g, " ").toLowerCase();

function refLine(ref: WorkRef): string {
  const source = refSourceName(ref);
  const link = ref.url ? `, ${ref.url}` : "";
  if (ref.kind === "deal" && ref.sourceId) {
    return `- deal ${quote(ref.title)}${ref.company ? ` with ${oneLine(ref.company)}` : ""}, source_id ${ref.sourceId}${link}. Open it with work_deals (deal = the source_id).`;
  }
  if (ref.sourceId) {
    return `- ${kindWord(ref)}${source ? ` from ${source}` : ""} ${quote(ref.title)}, source_id ${ref.sourceId}${link}. Read it with work_read.`;
  }
  if (ref.entityId) {
    const keys = ref.keys?.length ? `, keys ${ref.keys.join(", ")}` : "";
    return `- ${kindWord(ref)} ${quote(ref.title)}, entity id ${ref.entityId}${keys}. Look it up with work_entity (id).`;
  }
  if (ref.kind === "note") {
    return ref.about
      ? `- note ${quote(ref.title)} about ${quote(ref.about)}. Look up ${quote(ref.about)} with work_entity (name).`
      : `- note ${quote(ref.title)}. Find it with work_search first.`;
  }
  const date = ref.date && !Number.isNaN(Date.parse(ref.date)) ? ` on ${ref.date.slice(0, 10)}` : "";
  return `- ${kindWord(ref)}${source ? ` from ${source}` : ""} ${quote(ref.title)}${date}${link} (no record id). Find it with work_search first.`;
}

/** The note the agent gets for the attached items (a synthetic text part, placed first). `brief`: the visible text is
 *  the default question, so the answer is a brief. Neutral words only: titles are data. */
export function refPromptText(refs: readonly WorkRef[], options: { brief: boolean }): string {
  return [
    "Attached for context (look each item up before you answer):",
    ...refs.map(refLine),
    ...(options.brief ? ["For a brief: what it is, what is needed from the user, the recent history across sources and anything related, with links."] : []),
  ].join("\n");
}

// ── reading refs back (message metadata) ────────────────────────────────────────────────────────────────────────────

const KINDS = new Set<string>(STARTER_KINDS);
/** The refs kept on a sent message (`metadata.refs`), checked field by field; anything else is dropped. */
export function refsFromMetadata(value: unknown): WorkRef[] {
  const list = value && typeof value === "object" && "refs" in value ? (value as { refs?: unknown }).refs : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): WorkRef[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.kind !== "string" || !KINDS.has(entry.kind) || typeof entry.title !== "string" || !entry.title.trim()) return [];
    const text = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : null);
    return [clean({
      kind: entry.kind as WorkRefKind, title: entry.title, source: text("source"), sourceId: text("sourceId"), entityId: text("entityId"), url: text("url"),
      rawKind: text("rawKind"), company: text("company"), about: text("about"), date: text("date"),
      keys: Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === "string") : [],
    })];
  }).slice(0, MAX_REFS);
}
