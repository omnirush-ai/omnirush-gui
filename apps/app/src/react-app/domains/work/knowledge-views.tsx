/** @jsxImportSource react */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Eye, EyeOff, History, List, Maximize2, MessageSquarePlus, Minus, Network, Plus, Search, Waypoints, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import type {
  OmniRushWorkEntityDetail, OmniRushWorkEntityRecord, OmniRushWorkEntitySummary, OmniRushWorkFact, OmniRushWorkGraph, OmniRushWorkGraphNode,
} from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutPrompt, connectorLabel, countLabel, ENTITY_KINDS, FACT_KINDS, keyLabel, workEntityKey, type WorkClient } from "./work-mode";
import { ConnectorIcon } from "./work-views";
import {
  categoryColor, categoryCounts, categoryKey, categoryOf, entityIdOf, GRAPH_CATEGORIES, GRAPH_GROUPS, groupByDay, matchNodes, mergeGraph, searchHits, visibleGraph,
} from "./graph-model";
import { GRAPH_SURFACE, KnowledgeGraph, type GraphApi } from "./knowledge-graph";

const PAGE = 50;

function when(value: string | null | undefined): string {
  if (!value) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A record's people, whatever shape the server sends (strings, or {name, email}). */
export function actorNames(actors: unknown): string {
  const list = Array.isArray(actors) ? actors : [];
  return list
    .map((actor) => (typeof actor === "string" ? actor : actor && typeof actor === "object" ? String((actor as { name?: unknown; email?: unknown }).name || (actor as { email?: unknown }).email || "") : ""))
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}

const KIND_NAMES: Record<string, string> = { person: "Person", company: "Company", deal: "Deal", project: "Project", product: "Product", other: "Other" };
const kindLabel = (kind: string) => KIND_NAMES[kind] ?? kind;
const factKindLabel = (kind: string) => FACT_KINDS.find((item) => item.id === kind)?.label ?? kind;

/** One entity in the list. */
export function EntityListItem(props: { entity: OmniRushWorkEntitySummary; active: boolean; onSelect: () => void }) {
  const entity = props.entity;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      data-work-entity={entity.id}
      aria-current={props.active ? "true" : undefined}
      className={cn("flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-start last:border-b-0 hover:bg-muted", props.active && "bg-muted")}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entity.name}</span>
        <span className="flex items-center gap-1">{entity.sources.slice(0, 4).map((source) => <ConnectorIcon key={source} id={source} className="size-3.5" />)}</span>
      </span>
      <span className="truncate text-[12px] text-muted-foreground">
        {[kindLabel(entity.kind), countLabel(entity.record_count, "record"), when(entity.last_activity_at)].filter(Boolean).join(" · ")}
      </span>
    </button>
  );
}

function Section(props: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function RecordRow(props: { record: OmniRushWorkEntityRecord; openLink: (url: string) => void }) {
  const record = props.record;
  const people = actorNames(record.actors);
  return (
    <li className="flex gap-3 border-b border-border py-2 last:border-b-0" data-work-record={record.source_id}>
      <ConnectorIcon id={record.source} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{record.subject || record.kind}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground">{when(record.occurred_at)}</span>
          {record.url ? (
            <button type="button" aria-label="Open at the source" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => props.openLink(record.url!)}>
              <ExternalLink className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="truncate text-[12px] text-muted-foreground">{[connectorLabel(record.source), record.kind, people].filter(Boolean).join(" · ")}</div>
        {record.text_preview ? <p className="mt-0.5 line-clamp-2 text-[13px] text-foreground/80">{record.text_preview}</p> : null}
      </div>
    </li>
  );
}

function FactKindSelect(props: { value: string; onChange: (value: string) => void }) {
  const items = FACT_KINDS.map((kind) => ({ value: kind.id, label: kind.label }));
  return (
    <Select value={props.value} items={items} onValueChange={(value) => value && props.onChange(String(value))}>
      <SelectTrigger className="w-36" aria-label="Kind"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  );
}

/** One saved fact: its text, kind and who saved it; Edit and Retire. */
export function FactRow(props: { fact: OmniRushWorkFact; busy: boolean; onSave: (text: string) => void; onRetire: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.fact.text);
  if (editing) {
    return (
      <li className="flex flex-col gap-2 rounded-lg border border-border p-2" data-work-fact={props.fact.id}>
        <Textarea aria-label="Fact" value={text} onChange={(event) => setText(event.target.value)} className="min-h-16" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setText(props.fact.text); setEditing(false); }}>Cancel</Button>
          <Button size="sm" disabled={props.busy || !text.trim()} onClick={() => { props.onSave(text.trim()); setEditing(false); }}>Save</Button>
        </div>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 rounded-lg border border-border px-3 py-2" data-work-fact={props.fact.id}>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{props.fact.text}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {[factKindLabel(props.fact.kind), props.fact.created_by === "agent" ? "saved by the agent" : props.fact.created_by === "user" ? "saved by you" : null, when(props.fact.updated_at ?? props.fact.created_at)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => setEditing(true)}>Edit</Button>
      <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onRetire}>Retire</Button>
    </li>
  );
}

/** One entity: keys, sources, saved facts (add, edit, retire), the timeline of its records and related entities. */
export function EntityDetail(props: {
  detail: OmniRushWorkEntityDetail;
  busy: boolean;
  openLink: (url: string) => void;
  onAsk: () => void;
  onSelect: (id: string) => void;
  onAddFact: (fact: { text: string; kind: string }) => void;
  onSaveFact: (id: string, text: string) => void;
  onRetireFact: (id: string) => void;
}) {
  const { entity, records, facts, related } = props.detail;
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<string>("fact");
  const active = facts.filter((fact) => fact.status !== "retired");
  const timeline = [...records].sort((a, b) => String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? "")));
  const add = () => {
    if (!text.trim()) return;
    props.onAddFact({ text: text.trim(), kind });
    setText("");
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-6" data-testid="work-entity-detail" data-entity={entity.id}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-3 break-words text-xl font-semibold leading-snug tracking-tight" title={entity.name}>{entity.name}</h2>
          <p className="text-sm text-muted-foreground">{[kindLabel(entity.kind), countLabel(entity.record_count, "record"), when(entity.last_activity_at) && `last activity ${when(entity.last_activity_at)}`].filter(Boolean).join(" · ")}</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={props.onAsk} data-testid="work-entity-ask"><MessageSquarePlus className="size-4" />Ask about this</Button>
      </div>

      {entity.keys.length || entity.sources.length ? (
        <div className="flex flex-wrap gap-1.5">
          {entity.sources.map((source) => (
            <Badge key={`s:${source}`} variant="secondary" className="gap-1"><ConnectorIcon id={source} className="size-3" />{connectorLabel(source)}</Badge>
          ))}
          {entity.keys.map((key) => <Badge key={`k:${key}`} variant="outline" className="font-mono text-[11px]">{keyLabel(key)}</Badge>)}
        </div>
      ) : null}

      <Section title="Remembered" action={adding ? null : <Button variant="ghost" size="sm" onClick={() => setAdding(true)} data-testid="work-fact-add">Add</Button>}>
        {adding ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
            <Textarea aria-label="New fact" placeholder="e.g. Dana approves every order over $5,000." value={text} onChange={(event) => setText(event.target.value)} className="min-h-16" />
            <div className="flex items-center justify-end gap-2">
              <FactKindSelect value={kind} onChange={setKind} />
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" disabled={props.busy || !text.trim()} onClick={add}>Save</Button>
            </div>
          </div>
        ) : null}
        {active.length ? (
          <ul className="flex flex-col gap-1.5">
            {active.map((fact) => (
              <FactRow key={fact.id} fact={fact} busy={props.busy} onSave={(value) => props.onSaveFact(fact.id, value)} onRetire={() => props.onRetireFact(fact.id)} />
            ))}
          </ul>
        ) : adding ? null : <p className="text-sm text-muted-foreground">Nothing saved yet. Add rules, decisions or notes the agent should keep in mind.</p>}
      </Section>

      <Section title="Timeline">
        {timeline.length ? (
          <ul className="flex flex-col">{timeline.map((record) => <RecordRow key={record.source_id} record={record} openLink={props.openLink} />)}</ul>
        ) : <p className="text-sm text-muted-foreground">No linked records yet.</p>}
      </Section>

      {related.length ? (
        <Section title="Related">
          <div className="flex flex-wrap gap-1.5">
            {related.map((item) => (
              <button key={item.id} type="button" onClick={() => props.onSelect(item.id)} title={item.reason ?? undefined}
                className="rounded-full border border-border px-2.5 py-1 text-[12px] hover:bg-muted" data-work-related={item.id}>
                {item.name} <span className="text-muted-foreground">· {kindLabel(item.kind)}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

/** One entity's detail with its saved knowledge (add, edit, retire) and "Ask about this". */
function EntityPanel(props: { client: WorkClient | null; entityId: string; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void>; onSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const detailKey = workEntityKey(props.client, props.entityId);
  const detail = useQuery({ queryKey: detailKey, queryFn: () => props.client!.getWorkEntity(props.entityId), enabled: Boolean(props.client) });
  const onError = (reason: unknown) => toast.error(reason instanceof Error ? reason.message : "That did not work. Try again.");
  const refresh = () => queryClient.invalidateQueries({ queryKey: detailKey });
  const addFact = useMutation({ mutationFn: (fact: { text: string; kind: string }) => props.client!.addWorkFact({ ...fact, entity_id: props.entityId }), onSuccess: refresh, onError });
  const updateFact = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { text?: string; status?: "active" | "retired" } }) => props.client!.updateWorkFact(id, patch),
    onSuccess: refresh,
    onError,
  });
  const [asking, setAsking] = useState(false);
  const ask = async (entity: OmniRushWorkEntitySummary) => {
    setAsking(true);
    try { await props.onAsk(askAboutPrompt(entity)); }
    catch (reason) { onError(reason); }
    finally { setAsking(false); }
  };
  if (detail.isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (detail.error || !detail.data) return <div className="text-sm text-muted-foreground">{detail.error instanceof Error ? detail.error.message : "This entry could not be loaded."}</div>;
  return (
    <EntityDetail
      detail={detail.data}
      busy={addFact.isPending || updateFact.isPending || asking}
      openLink={props.openLink}
      onAsk={() => void ask(detail.data.entity)}
      onSelect={props.onSelect}
      onAddFact={(fact) => addFact.mutate(fact)}
      onSaveFact={(id, text) => updateFact.mutate({ id, patch: { text } })}
      onRetireFact={(id) => updateFact.mutate({ id, patch: { status: "retired" } })}
    />
  );
}

/** The list view (kept for accessibility): entities by kind, the header's search, and the selected entity's detail. */
function KnowledgeList(props: { client: WorkClient | null; search: string; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void>; initialEntityId?: string | null }) {
  const search = props.search.trim();
  const [kind, setKind] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(props.initialEntityId ?? null);
  const base = props.client?.baseUrl?.trim() || "default";
  const list = useInfiniteQuery({
    queryKey: ["omnirush-work-entities", base, search, kind],
    queryFn: ({ pageParam }) => props.client!.listWorkEntities({ q: search || undefined, kind: kind ?? undefined, limit: PAGE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? null,
    enabled: Boolean(props.client),
  });
  const items = list.data?.pages.flatMap((page) => page.items ?? []) ?? [];
  const current = selected ?? items[0]?.id ?? null;
  return (
    <div className="flex min-h-0 flex-1" data-testid="work-knowledge-list">
      <div className="flex w-80 shrink-0 flex-col border-e border-border">
        <div className="flex flex-wrap gap-1 p-3" role="group" aria-label="Kind">
          {[{ id: null, label: "All" }, ...ENTITY_KINDS].map((item) => (
            <button key={item.id ?? "all"} type="button" aria-pressed={kind === item.id} data-entity-kind={item.id ?? "all"}
              onClick={() => { setKind(item.id); setSelected(null); }}
              className={cn("rounded-full border border-border px-2 py-0.5 text-[12px]", kind === item.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          {list.isLoading ? <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            : list.error ? <div className="p-4 text-sm text-muted-foreground">{list.error instanceof Error ? list.error.message : "Knowledge could not be loaded."}</div>
            : items.length === 0 ? <div className="p-4 text-sm text-muted-foreground">{search || kind ? "Nothing matches." : "Nothing here yet. Connect a source and it fills in as data syncs."}</div>
            : items.map((entity) => <EntityListItem key={entity.id} entity={entity} active={entity.id === current} onSelect={() => setSelected(entity.id)} />)}
          {list.hasNextPage ? (
            <div className="p-2"><Button variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button></div>
          ) : null}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        {current ? <EntityPanel client={props.client} entityId={current} openLink={props.openLink} onAsk={props.onAsk} onSelect={setSelected} /> : null}
      </div>
    </div>
  );
}

/** A category's swatch: its colour with the kind icon, as drawn in the graph. */
export function CategorySwatch(props: { categoryKey: string; dark: boolean; className?: string }) {
  const category = categoryOf(props.categoryKey);
  return (
    <span aria-hidden className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full text-white [&_svg]:size-3", props.className)} style={{ background: categoryColor(props.categoryKey, props.dark) }}>
      <category.icon strokeWidth={2.4} />
    </span>
  );
}

/** The left panel: categories grouped as Entities, Records and Knowledge, each with its count and a show/hide toggle. */
export function CategoryPanel(props: { counts: Map<string, number>; hidden: ReadonlySet<string>; dark: boolean; onToggle: (keys: string[], show: boolean) => void }) {
  return (
    <div className="flex flex-col gap-4" data-testid="work-graph-categories">
      {GRAPH_GROUPS.map((group) => {
        const rows = GRAPH_CATEGORIES.filter((category) => category.group === group.id && (props.counts.get(category.key) ?? 0) > 0);
        if (!rows.length) return null;
        const keys = rows.map((row) => row.key);
        const total = rows.reduce((sum, row) => sum + (props.counts.get(row.key) ?? 0), 0);
        const allShown = keys.every((key) => !props.hidden.has(key));
        return (
          <section key={group.id} aria-label={group.label}>
            <div className="flex items-center gap-2 px-2 pb-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</h3>
              <span className="text-[11px] tabular-nums text-muted-foreground">{total.toLocaleString()}</span>
              <button type="button" className="ms-auto text-[11px] text-muted-foreground hover:text-foreground" aria-pressed={allShown} data-graph-group={group.id}
                onClick={() => props.onToggle(keys, !allShown)}>
                {allShown ? "Hide all" : "Show all"}
              </button>
            </div>
            <ul className="flex flex-col">
              {rows.map((row) => {
                const shown = !props.hidden.has(row.key);
                return (
                  <li key={row.key}>
                    <button type="button" aria-pressed={shown} data-graph-category={row.key} onClick={() => props.onToggle([row.key], !shown)}
                      title={shown ? `Hide ${row.label.toLowerCase()}` : `Show ${row.label.toLowerCase()}`}
                      className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-[13px] hover:bg-muted", !shown && "text-muted-foreground")}>
                      <CategorySwatch categoryKey={row.key} dark={props.dark} className={cn(!shown && "opacity-35")} />
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      <span className="text-[12px] tabular-nums text-muted-foreground">{(props.counts.get(row.key) ?? 0).toLocaleString()}</span>
                      {shown ? <Eye className="size-3.5 text-muted-foreground" /> : <EyeOff className="size-3.5 text-muted-foreground" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function shortDate(value: string | null | undefined, time = false): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return time ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A record or a saved fact in the inspector: what it is, where it came from, and a link to it at its source. */
export function NodeCard(props: { node: OmniRushWorkGraphNode; dark: boolean; openLink: (url: string) => void }) {
  const { node } = props;
  const key = categoryKey(node);
  return (
    <div className="flex flex-col gap-3" data-testid="work-graph-node" data-node={node.id}>
      <div className="flex items-start gap-3">
        <CategorySwatch categoryKey={key} dark={props.dark} className="mt-0.5 size-7 [&_svg]:size-4" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-lg font-semibold leading-snug tracking-tight">{node.label}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[node.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), node.source ? connectorLabel(node.source) : null, shortDate(node.occurred_at)].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      {node.sub ? <p className="text-sm">{node.sub}</p> : null}
      <p className="text-[12px] text-muted-foreground">{countLabel(node.degree, "link")}</p>
      {node.url ? (
        <Button variant="outline" size="sm" className="self-start" onClick={() => props.openLink(node.url!)} data-testid="work-graph-open"><ExternalLink className="size-3.5" />Open at the source</Button>
      ) : null}
    </div>
  );
}

type KnowledgeView = "graph" | "timeline" | "list";

function ViewSwitch(props: { value: KnowledgeView; onChange: (value: KnowledgeView) => void }) {
  const option = (value: KnowledgeView, label: string, icon: React.ReactNode) => (
    <button type="button" role="radio" aria-checked={props.value === value} data-knowledge-view={value} onClick={() => props.onChange(value)}
      className={cn("flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] transition-colors [&_svg]:size-3.5",
        props.value === value ? "bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border dark:bg-gray-5" : "text-muted-foreground hover:text-foreground")}>
      {icon}{label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="View" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {option("graph", "Graph", <Network />)}
      {option("timeline", "Timeline", <History />)}
      {option("list", "List", <List />)}
    </div>
  );
}

/** The timeline view: records and saved facts newest first, by day, filtered by the same categories. */
function KnowledgeTimeline(props: { client: WorkClient | null; focus: OmniRushWorkGraphNode | null; hidden: ReadonlySet<string>; dark: boolean; search: string; selected: string | null; onSelect: (id: string) => void; onClearFocus: () => void; openLink: (url: string) => void }) {
  const base = props.client?.baseUrl?.trim() || "default";
  const timeline = useInfiniteQuery({
    queryKey: ["omnirush-work-timeline", base, props.focus?.id ?? null],
    queryFn: ({ pageParam }) => props.client!.getWorkTimeline({ focus: props.focus?.id, cursor: pageParam ?? undefined, limit: 100 }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? null,
    enabled: Boolean(props.client),
  });
  const words = props.search.toLowerCase().split(/\s+/).filter(Boolean);
  const items = (timeline.data?.pages.flatMap((page) => page.items ?? []) ?? [])
    .filter((item) => !props.hidden.has(categoryKey(item)))
    .filter((item) => words.every((word) => `${item.label} ${item.sub ?? ""} ${item.kind}`.toLowerCase().includes(word)));
  const days = groupByDay(items);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6" data-testid="work-timeline">
      {props.focus ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Around</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pe-1 ps-1">
            <CategorySwatch categoryKey={categoryKey(props.focus)} dark={props.dark} className="size-4 [&_svg]:size-2.5" />
            <span className="max-w-64 truncate font-medium">{props.focus.label}</span>
            <button type="button" aria-label="Show the whole account" className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onClearFocus}><X className="size-3.5" /></button>
          </span>
        </div>
      ) : null}
      {timeline.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
        : timeline.error ? <p className="text-sm text-muted-foreground">{timeline.error instanceof Error ? timeline.error.message : "The timeline could not be loaded."}</p>
        : days.length === 0 ? <p className="text-sm text-muted-foreground">{props.hidden.size || words.length ? "Nothing matches." : "Nothing here yet. Connect a source and it fills in as data syncs."}</p>
        : days.map((day) => (
          <section key={day.day || "undated"} aria-label={day.day || "Undated"}>
            <h3 className="sticky top-0 z-[1] bg-background/95 py-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
              {day.day ? new Date(`${day.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Undated"}
            </h3>
            <ol className="relative ms-2.5 border-s border-border">
              {day.items.map((item) => (
                <li key={item.id} className="relative">
                  <button type="button" onClick={() => props.onSelect(item.id)} data-timeline-item={item.id} aria-current={props.selected === item.id ? "true" : undefined}
                    className={cn("flex w-full items-start gap-3 rounded-md py-2 pe-2 ps-6 text-start hover:bg-muted", props.selected === item.id && "bg-muted")}>
                    <CategorySwatch categoryKey={categoryKey(item)} dark={props.dark} className="absolute -start-2.5 top-2.5 ring-4 ring-background" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.label}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">{[item.kind.replace(/_/g, " "), item.source ? connectorLabel(item.source) : null, item.sub].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="shrink-0 pt-0.5 text-[12px] tabular-nums text-muted-foreground">{shortDate(item.occurred_at, true)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ))}
      {timeline.hasNextPage ? <Button variant="ghost" size="sm" disabled={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()}>Load more</Button> : null}
    </div>
  );
}

const useDarkTheme = () => useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode) === "dark";

/**
 * Work > Knowledge: a graph explorer over the people, companies, deals, records and saved knowledge found across
 * the connected sources (contract Addendum B4), with a timeline and a list view.
 */
export function WorkKnowledgePage(props: {
  client: WorkClient | null;
  openLink: (url: string) => void;
  onAsk: (prompt: string) => Promise<void>;
  onBack?: () => void;
  initialEntityId?: string | null;
}) {
  const dark = useDarkTheme();
  const [view, setView] = useState<KnowledgeView>("graph");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(props.initialEntityId ? `e:${props.initialEntityId}` : null);
  const [timelineFocus, setTimelineFocus] = useState<OmniRushWorkGraphNode | null>(null);
  const [expansions, setExpansions] = useState<OmniRushWorkGraph[]>([]);
  const api = useRef<GraphApi | null>(null);
  const base = props.client?.baseUrl?.trim() || "default";
  const overview = useQuery({ queryKey: ["omnirush-work-graph", base], // The overview is the hubs only (people, companies, deals, saved knowledge); Expand pulls in a hub's records.
  queryFn: () => props.client!.getWorkGraph({ limit: 500, kinds: "entity,fact" }), enabled: Boolean(props.client) });
  const graph = useMemo(() => (overview.data ? expansions.reduce<OmniRushWorkGraph>(mergeGraph, overview.data) : null), [overview.data, expansions]);
  const shown = useMemo(() => (graph ? visibleGraph(graph, hidden) : { nodes: [], edges: [] }), [graph, hidden]);
  const counts = useMemo(() => (graph ? categoryCounts(graph) : new Map<string, number>()), [graph]);
  const matches = useMemo(() => matchNodes(shown.nodes, search), [shown.nodes, search]);
  const node = graph?.nodes.find((item) => item.id === selected) ?? null;
  // The search also asks the server (the list view's entity search): the graph holds only the hubs and what was expanded.
  const [query, setQuery] = useState("");
  const [hitsOpen, setHitsOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const found = useQuery({
    queryKey: ["omnirush-work-entities", base, query, "graph-search"],
    queryFn: () => props.client!.listWorkEntities({ q: query, limit: 8 }),
    enabled: Boolean(props.client) && view === "graph" && query.length >= 2,
  });
  // shortcut: records are matched among the account's newest 200 only; a server-side record search would reach all.
  const recent = useQuery({
    queryKey: ["omnirush-work-timeline-search", base],
    queryFn: () => props.client!.getWorkTimeline({ limit: 200 }),
    enabled: Boolean(props.client) && view === "graph" && query.length >= 2,
    staleTime: 60_000,
  });
  const hits = useMemo(
    () => (search.trim() ? searchHits(graph, matches, found.data?.items ?? [], recent.data?.items ?? [], search) : []),
    [graph, matches, found.data, recent.data, search],
  );
  const expand = useMutation({
    mutationFn: (id: string) => props.client!.getWorkGraph({ focus: id, depth: 1 }),
    onSuccess: (answer, id) => {
      setExpansions((list) => [...list, answer]);
      setTimeout(() => api.current?.centerOn(id), 350);
    },
    onError: (reason) => toast.error(reason instanceof Error ? reason.message : "Its neighbours could not be loaded."),
  });
  const select = (id: string | null) => setSelected(id);
  // A hit on the graph is selected and centred; one from the server is expanded (its neighbourhood joins the graph) first.
  const focusHit = (id: string) => {
    setHitsOpen(false);
    if (graph?.nodes.some((item) => item.id === id)) {
      setSelected(id);
      api.current?.centerOn(id);
      return;
    }
    expand.mutate(id, { onSuccess: () => setSelected(id) });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setSelected(null);
      setSearch("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (keys: string[], show: boolean) => setHidden((current) => {
    const next = new Set(current);
    for (const key of keys) if (show) next.delete(key); else next.add(key);
    return next;
  });
  const entityId = selected ? entityIdOf(selected) : null;
  const total = graph ? Object.values(graph.counts ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="work-knowledge">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        {props.onBack ? <Button variant="ghost" size="sm" className="-ms-2" onClick={props.onBack}><ArrowLeft className="size-4" />Back to Work</Button> : null}
        <h1 className="text-[15px] font-semibold tracking-tight">Knowledge</h1>
        <div className="relative mx-auto w-full max-w-md">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search knowledge" placeholder="Search people, companies, deals, records…" value={search} className="h-8 ps-8" data-testid="work-knowledge-search"
            onChange={(event) => { setSearch(event.target.value); setHitsOpen(true); }}
            onFocus={() => setHitsOpen(true)}
            onBlur={() => setHitsOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); setSearch(""); return; }
              if (event.key !== "Enter" || view !== "graph") return;
              if (hits[0]) focusHit(hits[0].id);
            }} />
          {view === "graph" && hitsOpen && hits.length ? (
            <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-md" data-testid="work-graph-search-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button type="button" data-search-hit={hit.id} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] hover:bg-muted"
                    onMouseDown={(event) => event.preventDefault()} onClick={() => focusHit(hit.id)}>
                    <CategorySwatch categoryKey={categoryKey(hit)} dark={dark} className="size-4 [&_svg]:size-2.5" />
                    <span className="min-w-0 flex-1 truncate" title={hit.label}>{hit.label}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{hit.loaded ? kindLabel(hit.kind) : "Add to graph"}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <ViewSwitch value={view} onChange={setView} />
      </div>

      {view === "list" ? (
        <KnowledgeList client={props.client} search={search} openLink={props.openLink} onAsk={props.onAsk} initialEntityId={entityId ?? props.initialEntityId} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-e border-border p-3">
            <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
              Showing the main people, companies and deals. Select one to inspect it; right-click it, or use Expand, to pull in its records.
            </p>
            <CategoryPanel counts={counts} hidden={hidden} dark={dark} onToggle={toggle} />
          </aside>

          <div className="relative min-w-0 flex-1 overflow-y-auto" style={view === "graph" ? { background: dark ? GRAPH_SURFACE.dark : GRAPH_SURFACE.light } : undefined}>
            {view === "timeline" ? (
              <KnowledgeTimeline client={props.client} focus={timelineFocus} hidden={hidden} dark={dark} search={search} selected={selected}
                onSelect={select} onClearFocus={() => setTimelineFocus(null)} openLink={props.openLink} />
            ) : overview.isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading…</div>
            ) : overview.error || !graph ? (
              <div className="flex flex-col items-start gap-3 p-6 text-sm text-muted-foreground">
                <p>{overview.error instanceof Error ? overview.error.message : "The graph could not be loaded."}</p>
                <Button variant="outline" size="sm" onClick={() => setView("list")}>Show the list</Button>
              </div>
            ) : graph.nodes.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Nothing here yet. Connect a source and it fills in as data syncs.</div>
            ) : (
              <>
                <KnowledgeGraph nodes={shown.nodes} edges={shown.edges} dark={dark} selected={selected} matches={matches} onSelect={select} onExpand={(id) => expand.mutate(id)} apiRef={api} />
                <div className="pointer-events-none absolute start-3 top-3 flex items-center gap-2 text-[12px] text-muted-foreground" data-testid="work-graph-count">
                  <span className="rounded-md border border-border bg-background/80 px-2 py-1 tabular-nums backdrop-blur">
                    {search.trim() ? `${matches.size.toLocaleString()} matching · ` : ""}{shown.nodes.length.toLocaleString()} shown{total > graph.nodes.length ? ` of ${total.toLocaleString()}` : ""}
                  </span>
                  {expand.isPending ? <span className="rounded-md border border-border bg-background/80 px-2 py-1 backdrop-blur">Expanding…</span> : null}
                </div>
                {/* The inspector narrows the canvas: the hint would cover the count. */}
                {selected ? null : <p className="pointer-events-none absolute end-3 top-3 hidden rounded-md border border-border bg-background/80 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground backdrop-blur xl:block">
                  Click for details · right-click to expand · scroll to zoom · drag to pin
                </p>}
                <div className="absolute bottom-3 end-3 flex flex-col overflow-hidden rounded-lg border border-border bg-background/90 shadow-sm backdrop-blur" role="group" aria-label="Zoom">
                  <button type="button" aria-label="Zoom in" className="p-2 hover:bg-muted" onClick={() => api.current?.zoomBy(1.4)}><Plus className="size-4" /></button>
                  <button type="button" aria-label="Zoom out" className="border-t border-border p-2 hover:bg-muted" onClick={() => api.current?.zoomBy(1 / 1.4)}><Minus className="size-4" /></button>
                  <button type="button" aria-label="Fit to view" className="border-t border-border p-2 hover:bg-muted" onClick={() => api.current?.fit()}><Maximize2 className="size-4" /></button>
                </div>
              </>
            )}
          </div>

          {selected ? (
            <aside className="flex w-96 shrink-0 flex-col border-s border-border" data-testid="work-graph-inspector">
              <div className="flex items-center gap-1 border-b border-border px-3 py-2">
                <Button variant="ghost" size="sm" disabled={expand.isPending} onClick={() => expand.mutate(selected)} data-testid="work-graph-expand"><Waypoints className="size-4" />Expand</Button>
                {node ? <Button variant="ghost" size="sm" onClick={() => { setTimelineFocus(node); setView("timeline"); }}><History className="size-4" />Timeline</Button> : null}
                <button type="button" aria-label="Close" className="ms-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setSelected(null)}><X className="size-4" /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {entityId ? <EntityPanel client={props.client} entityId={entityId} openLink={props.openLink} onAsk={props.onAsk} onSelect={(id) => { setSelected(`e:${id}`); api.current?.centerOn(`e:${id}`); }} />
                  : node ? <NodeCard node={node} dark={dark} openLink={props.openLink} />
                  : <p className="text-sm text-muted-foreground">This item is not in the graph any more.</p>}
              </div>
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}
