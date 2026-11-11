/** @jsxImportSource react */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, MessageSquarePlus, Search } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import type { OmniRushWorkEntityDetail, OmniRushWorkEntityRecord, OmniRushWorkEntitySummary, OmniRushWorkFact } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutPrompt, connectorLabel, countLabel, ENTITY_KINDS, FACT_KINDS, keyLabel, workEntityKey, type WorkClient } from "./work-mode";
import { ConnectorIcon } from "./work-views";

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
          <h2 className="truncate text-xl font-semibold tracking-tight">{entity.name}</h2>
          <p className="text-sm text-muted-foreground">{[kindLabel(entity.kind), countLabel(entity.record_count, "record"), when(entity.last_activity_at) && `last activity ${when(entity.last_activity_at)}`].filter(Boolean).join(" · ")}</p>
        </div>
        <Button size="sm" onClick={props.onAsk} data-testid="work-entity-ask"><MessageSquarePlus className="size-4" />Ask about this</Button>
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

/** Work > Knowledge: the people, companies and deals found across the connected sources, and what to remember about them. */
export function WorkKnowledgePage(props: {
  client: WorkClient | null;
  openLink: (url: string) => void;
  onAsk: (prompt: string) => Promise<void>;
  onBack?: () => void;
  initialEntityId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(props.initialEntityId ?? null);
  const base = props.client?.baseUrl?.trim() || "default";
  const list = useInfiniteQuery({
    queryKey: ["omnirush-work-entities", base, search.trim(), kind],
    queryFn: ({ pageParam }) => props.client!.listWorkEntities({ q: search.trim() || undefined, kind: kind ?? undefined, limit: PAGE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? null,
    enabled: Boolean(props.client),
  });
  const items = list.data?.pages.flatMap((page) => page.items ?? []) ?? [];
  const current = selected ?? items[0]?.id ?? null;
  const detailKey = workEntityKey(props.client, current ?? "");
  const detail = useQuery({ queryKey: detailKey, queryFn: () => props.client!.getWorkEntity(current!), enabled: Boolean(props.client && current) });
  const onError = (reason: unknown) => toast.error(reason instanceof Error ? reason.message : "That did not work. Try again.");
  const refresh = () => queryClient.invalidateQueries({ queryKey: detailKey });
  const addFact = useMutation({ mutationFn: (fact: { text: string; kind: string }) => props.client!.addWorkFact({ ...fact, entity_id: current! }), onSuccess: refresh, onError });
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
  const busy = addFact.isPending || updateFact.isPending || asking;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="work-knowledge">
      <div className="border-b border-border px-6 pb-4 pt-8">
        {props.onBack ? <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />Back to Work</Button> : null}
        <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">People, companies and deals found across your connected sources, and what the agent should remember about them.</p>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col border-e border-border">
          <div className="flex flex-col gap-2 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search knowledge" placeholder="Search people, companies, deals…" value={search} onChange={(event) => { setSearch(event.target.value); setSelected(null); }} className="ps-8" data-testid="work-knowledge-search" />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Kind">
              {[{ id: null, label: "All" }, ...ENTITY_KINDS].map((item) => (
                <button key={item.id ?? "all"} type="button" aria-pressed={kind === item.id} data-entity-kind={item.id ?? "all"}
                  onClick={() => { setKind(item.id); setSelected(null); }}
                  className={cn("rounded-full border border-border px-2 py-0.5 text-[12px]", kind === item.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
            {list.isLoading ? <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              : list.error ? <div className="p-4 text-sm text-muted-foreground">{list.error instanceof Error ? list.error.message : "Knowledge could not be loaded."}</div>
              : items.length === 0 ? <div className="p-4 text-sm text-muted-foreground">{search.trim() || kind ? "Nothing matches." : "Nothing here yet. Connect a source and it fills in as data syncs."}</div>
              : items.map((entity) => <EntityListItem key={entity.id} entity={entity} active={entity.id === current} onSelect={() => setSelected(entity.id)} />)}
            {list.hasNextPage ? (
              <div className="p-2"><Button variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button></div>
            ) : null}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
          {!current ? null
            : detail.isLoading ? <div className="text-sm text-muted-foreground">Loading…</div>
            : detail.error || !detail.data ? <div className="text-sm text-muted-foreground">{detail.error instanceof Error ? detail.error.message : "This entry could not be loaded."}</div>
            : (
              <EntityDetail
                detail={detail.data}
                busy={busy}
                openLink={props.openLink}
                onAsk={() => void ask(detail.data.entity)}
                onSelect={setSelected}
                onAddFact={(fact) => addFact.mutate(fact)}
                onSaveFact={(id, text) => updateFact.mutate({ id, patch: { text } })}
                onRetireFact={(id) => updateFact.mutate({ id, patch: { status: "retired" } })}
              />
            )}
        </div>
      </div>
    </div>
  );
}
