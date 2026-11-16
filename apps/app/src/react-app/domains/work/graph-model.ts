/**
 * The Knowledge graph explorer's model (contract Addendum B4): categories and their colours, merging an expanded
 * neighbourhood into the graph, filtering, node sizes, which labels fit, and the timeline's days.
 */
import {
  BookOpen, Building2, CalendarDays, CircleDot, Contact, File, FileText, FolderKanban, Gavel, GitPullRequest, Handshake, Heart,
  Landmark, Lightbulb, Mail, MessageSquare, Package, Receipt, ScrollText, Shapes, StickyNote, Ticket, User, type LucideIcon,
} from "lucide-react";

import type { OmniRushWorkGraph, OmniRushWorkGraphNode } from "@/app/lib/omnirush-server";
import { t } from "@/i18n";

export type GraphGroup = "entity" | "record" | "fact";
export type GraphCategory = { key: string; group: GraphGroup; label: string; icon: LucideIcon; slot: number };

/**
 * One categorical palette for nodes and legend: the dataviz reference order (blue, orange, aqua, yellow, magenta,
 * green, violet), light and dark steps, checked with its validator (adjacent pairs pass CVD and normal vision in
 * both modes). Entity kinds get a hue each; records share green and knowledge violet, told apart by the kind icon
 * drawn in every node (the secondary encoding the all-pairs case needs). Slot 7 is the neutral "other".
 */
export const GRAPH_PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#8a8984"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#7c7b75"],
} as const;

const RECORD = 5;
const FACT = 6;
const OTHER = 7;

// Labels are getters: t() reads the language when shown, not when this module loads.
export const GRAPH_GROUPS: { id: GraphGroup; label: string }[] = [
  { id: "entity", get label() { return t("work.graph.entities"); } },
  { id: "record", get label() { return t("work.graph.records"); } },
  { id: "fact", get label() { return t("work.nav.knowledge"); } },
];

export const GRAPH_CATEGORIES: GraphCategory[] = [
  { key: "entity:person", group: "entity", get label() { return t("work.kind.people"); }, icon: User, slot: 0 },
  { key: "entity:company", group: "entity", get label() { return t("work.kind.companies"); }, icon: Building2, slot: 1 },
  { key: "entity:deal", group: "entity", get label() { return t("work.kind.deals"); }, icon: Handshake, slot: 2 },
  { key: "entity:project", group: "entity", get label() { return t("work.kind.projects"); }, icon: FolderKanban, slot: 3 },
  { key: "entity:product", group: "entity", get label() { return t("work.kind.products"); }, icon: Package, slot: 4 },
  { key: "entity:other", group: "entity", get label() { return t("work.kind.other"); }, icon: Shapes, slot: OTHER },
  { key: "record:email", group: "record", get label() { return t("work.graph.emails"); }, icon: Mail, slot: RECORD },
  { key: "record:message", group: "record", get label() { return t("work.graph.messages"); }, icon: MessageSquare, slot: RECORD },
  { key: "record:ticket", group: "record", get label() { return t("work.graph.tickets"); }, icon: Ticket, slot: RECORD },
  { key: "record:issue", group: "record", get label() { return t("work.graph.issues"); }, icon: CircleDot, slot: RECORD },
  { key: "record:pull_request", group: "record", get label() { return t("work.graph.pull_requests"); }, icon: GitPullRequest, slot: RECORD },
  { key: "record:page", group: "record", get label() { return t("work.graph.pages"); }, icon: BookOpen, slot: RECORD },
  { key: "record:file", group: "record", get label() { return t("work.graph.files"); }, icon: File, slot: RECORD },
  { key: "record:event", group: "record", get label() { return t("work.graph.events"); }, icon: CalendarDays, slot: RECORD },
  { key: "record:invoice", group: "record", get label() { return t("work.graph.invoices"); }, icon: Receipt, slot: RECORD },
  { key: "record:bill", group: "record", get label() { return t("work.graph.bills"); }, icon: Landmark, slot: RECORD },
  { key: "record:contact", group: "record", get label() { return t("work.graph.crm_records"); }, icon: Contact, slot: RECORD },
  { key: "record:other", group: "record", get label() { return t("work.kind.other"); }, icon: FileText, slot: RECORD },
  { key: "fact:decision", group: "fact", get label() { return t("work.graph.decisions"); }, icon: Gavel, slot: FACT },
  { key: "fact:policy", group: "fact", get label() { return t("work.graph.policies"); }, icon: ScrollText, slot: FACT },
  { key: "fact:preference", group: "fact", get label() { return t("work.graph.preferences"); }, icon: Heart, slot: FACT },
  { key: "fact:fact", group: "fact", get label() { return t("work.graph.facts"); }, icon: Lightbulb, slot: FACT },
  { key: "fact:contact_note", group: "fact", get label() { return t("work.graph.contact_notes"); }, icon: StickyNote, slot: FACT },
];

const BY_KEY = new Map(GRAPH_CATEGORIES.map((category) => [category.key, category]));
// CRM objects synced as records (HubSpot companies and deals) sit with the CRM contacts.
const RECORD_ALIASES: Record<string, string> = { company: "contact", deal: "contact", customer: "contact", vendor: "contact" };

/** A node's category key (`entity:person`, `record:email`, …); kinds the app does not know fall into their group's "other". */
export function categoryKey(node: Pick<OmniRushWorkGraphNode, "type" | "kind">): string {
  const group: GraphGroup = node.type === "entity" || node.type === "fact" ? node.type : "record";
  const kind = group === "record" ? RECORD_ALIASES[node.kind] ?? node.kind : node.kind;
  const key = `${group}:${kind}`;
  if (BY_KEY.has(key)) return key;
  return group === "fact" ? "fact:fact" : `${group}:other`;
}

export const categoryOf = (key: string): GraphCategory => BY_KEY.get(key) ?? BY_KEY.get("record:other")!;
export const categoryColor = (key: string, dark: boolean): string => (dark ? GRAPH_PALETTE.dark : GRAPH_PALETTE.light)[categoryOf(key).slot]!;

/** Counts per category: the server's totals where it sends them (summed into our keys), else what is loaded. */
export function categoryCounts(graph: Pick<OmniRushWorkGraph, "nodes" | "counts">): Map<string, number> {
  const out = new Map<string, number>();
  const counts = Object.entries(graph.counts ?? {});
  if (counts.length) {
    for (const [raw, count] of counts) {
      const [type = "", kind = ""] = raw.split(":", 2);
      const key = categoryKey({ type, kind });
      out.set(key, (out.get(key) ?? 0) + (Number(count) || 0));
    }
    return out;
  }
  for (const node of graph.nodes) out.set(categoryKey(node), (out.get(categoryKey(node)) ?? 0) + 1);
  return out;
}

const edgeId = (edge: { a: string; b: string; kind: string }) => (edge.a < edge.b ? `${edge.a}|${edge.b}|${edge.kind}` : `${edge.b}|${edge.a}|${edge.kind}`);

/** The graph with an expanded neighbourhood added: nodes by id (the newer copy wins), edges once, counts kept from the overview. */
export function mergeGraph(current: OmniRushWorkGraph | null, incoming: OmniRushWorkGraph): OmniRushWorkGraph {
  if (!current) return incoming;
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  for (const node of incoming.nodes) nodes.set(node.id, { ...nodes.get(node.id), ...node });
  const edges = new Map(current.edges.map((edge) => [edgeId(edge), edge]));
  for (const edge of incoming.edges) if (!edges.has(edgeId(edge))) edges.set(edgeId(edge), edge);
  return { nodes: [...nodes.values()], edges: [...edges.values()], counts: current.counts, truncated: current.truncated };
}

/** The graph without hidden categories (and without edges to a node that is not there). */
export function visibleGraph(graph: OmniRushWorkGraph, hidden: ReadonlySet<string>): Pick<OmniRushWorkGraph, "nodes" | "edges"> {
  const nodes = graph.nodes.filter((node) => !hidden.has(categoryKey(node)));
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: graph.edges.filter((edge) => edge.a !== edge.b && ids.has(edge.a) && ids.has(edge.b)) };
}

/** A node's radius in px at zoom 1: entities grow with their links, records and facts stay small. */
export function nodeRadius(node: Pick<OmniRushWorkGraphNode, "type" | "degree">): number {
  if (node.type !== "entity") return node.type === "fact" ? 8 : 7;
  return Math.min(30, 12 + 3 * Math.sqrt(Math.max(0, node.degree)));
}

export type LabelBox = { id: string; x: number; y: number; width: number; height: number; priority: number };

/**
 * Where labels go: the highest priority first, each at its first spot (boxes with the same id are one label's spots,
 * in order) that overlaps no label already placed nor a blocked box. Labels that fit nowhere are left out.
 */
export function placeLabels<T extends LabelBox>(boxes: T[], gap = 4, blocked: LabelBox[] = []): Map<string, T> {
  const placed: LabelBox[] = [...blocked];
  const out = new Map<string, T>();
  for (const box of [...boxes].sort((a, b) => b.priority - a.priority)) {
    if (out.has(box.id)) continue;
    const hit = placed.some((other) => box.x < other.x + other.width + gap && other.x < box.x + box.width + gap && box.y < other.y + other.height + gap && other.y < box.y + box.height + gap);
    if (hit) continue;
    placed.push(box);
    out.set(box.id, box);
  }
  return out;
}

/** Nodes whose label, sub-line or kind contains every word of the search. */
export function matchNodes(nodes: Pick<OmniRushWorkGraphNode, "id" | "kind" | "label" | "sub">[], query: string): Set<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return new Set();
  return new Set(nodes.filter((node) => {
    const text = `${node.label} ${node.sub ?? ""} ${node.kind}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }).map((node) => node.id));
}

export type SearchHit = Pick<OmniRushWorkGraphNode, "id" | "type" | "kind" | "label"> & { loaded: boolean };

/**
 * The search's results: matching nodes already on the graph (most linked first), then the server's entity search
 * (the list view's, which reaches past the overview's hubs) and the account's newest records (the timeline's) that
 * match but are not loaded yet; picking one of those expands it into the graph.
 */
export function searchHits(
  graph: Pick<OmniRushWorkGraph, "nodes"> | null,
  matches: ReadonlySet<string>,
  found: { id: string; kind: string; name: string }[],
  records: Pick<OmniRushWorkGraphNode, "id" | "type" | "kind" | "label" | "sub">[],
  query: string,
  max = 8,
): SearchHit[] {
  const nodes = graph?.nodes ?? [];
  const loaded = new Set(nodes.map((node) => node.id));
  const onGraph = nodes.filter((node) => matches.has(node.id)).sort((a, b) => b.degree - a.degree)
    .map((node) => ({ id: node.id, type: node.type, kind: node.kind, label: node.label, loaded: true }));
  const entities = found.map((entity) => ({ id: `e:${entity.id}`, type: "entity" as const, kind: entity.kind, label: entity.name, loaded: false }));
  const hit = matchNodes(records, query);
  const fetched = records.filter((record) => hit.has(record.id)).map((record) => ({ id: record.id, type: record.type, kind: record.kind, label: record.label, loaded: false }));
  const seen = new Set(loaded);
  const more = [...entities, ...fetched].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return [...onGraph, ...more].slice(0, max);
}

/** Timeline items by local day, newest day first (items keep the server's order); undated items go last. */
export function groupByDay<T extends { occurred_at?: string | null }>(items: T[]): { day: string; items: T[] }[] {
  const days = new Map<string, T[]>();
  for (const item of items) {
    const at = item.occurred_at ? new Date(item.occurred_at) : null;
    const day = at && !Number.isNaN(at.getTime())
      ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
      : "";
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return [...days.entries()].sort(([a], [b]) => (a && b ? b.localeCompare(a) : a ? -1 : 1)).map(([day, list]) => ({ day, items: list }));
}

/** The id the entity routes take for a graph node (`e:<id>` → `<id>`); null for records and facts. */
export const entityIdOf = (nodeId: string): string | null => (nodeId.startsWith("e:") ? nodeId.slice(2) : null);
