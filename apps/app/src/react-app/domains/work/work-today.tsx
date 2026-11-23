/** @jsxImportSource react */
// The Work home's Today view (contract Addendum C2): sources that need a fix, the sources as filter chips, then
// Needs you / Today / Recent from GET /work/feed (empty sections stay out). Each row opens at its source or starts a Work chat about it.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CalendarPlus, Check, ChevronDown, Loader2, Mail, MessageSquare, Plus, RotateCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkConnector, OmniRushWorkFeed, OmniRushWorkFeedItem } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutItemPrompt, connectorLabel, relativeTime, signsInWithForm, workConnectorsKey, workFailure, workFeedKey, type WorkClient } from "./work-mode";
import { BrandTile, ConnectorIcon } from "./brand-icon";
import { useOpenRecordId } from "./viewer/record-tabs";
import { canOpen, isMac, openItem, openModifiers, requestOpenRecord, useViewerSupport, type RecordRef } from "./viewer/records";
import { useListKeys } from "./viewer/shortcuts";
import { ListSearch, matchesQuery } from "./list-cap";

export const FEED_REFRESH_MS = 5 * 60_000;
/** Rows a section shows before "Show N more". */
export const SECTION_ROWS = 5;
/** Rows each "Show N more" adds. */
export const SECTION_STEP = 20;
const SECTIONS = [
  { id: "needs_you", get label() { return t("work.today.needs_you"); } },
  { id: "today", get label() { return t("work.today.today"); } },
  { id: "fyi", get label() { return t("work.today.fyi"); } },
] as const;

type FeedSource = OmniRushWorkFeed["sources"][number];

/** A source pill's dot: ok, syncing, or attention (red when it needs reconnecting or keeps failing). */
export function sourceDot(source: Pick<FeedSource, "status" | "attention">): "ok" | "syncing" | "attention" | "error" {
  if (source.attention) return source.attention.kind === "reconnect" || source.attention.kind === "failing" ? "error" : "attention";
  if (source.status === "error") return "error";
  return source.status === "syncing" ? "syncing" : "ok";
}

/** A source's status in words (the same words as the sidebar and Connectors). */
const statusWord = (source: Pick<FeedSource, "status" | "attention">): string => {
  const dot = sourceDot(source);
  if (dot === "ok") return t("work.today.dot_ok");
  if (dot === "syncing") return t("work.today.dot_syncing");
  return source.attention?.kind === "reconnect" ? t("work.sidebar.reconnect") : t("work.today.dot_attention");
};

function localZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** Source chips the strip shows before More. */
export const STRIP_SOURCES = 6;

/** The strip's chips: every source when they fit, else the picked one and the ones with the most items in view
 *  (ties keep the server's order), up to STRIP_SOURCES; the rest go under More. */
export function stripSources<T extends { id: string }>(sources: T[], counts: Record<string, number>, selected: string | null): { shown: T[]; rest: T[] } {
  if (sources.length <= STRIP_SOURCES + 1) return { shown: sources, rest: [] };
  const ranked = sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => Number(b.source.id === selected) - Number(a.source.id === selected) || (counts[b.source.id] ?? 0) - (counts[a.source.id] ?? 0) || a.index - b.index)
    .map((entry) => entry.source);
  const shown = new Set(ranked.slice(0, STRIP_SOURCES).map((source) => source.id));
  return { shown: sources.filter((source) => shown.has(source.id)), rest: sources.filter((source) => !shown.has(source.id)) };
}

const STRIP_GAP = 6;
/** Room kept for the More chip when some sources do not fit. */
const MORE_WIDTH = 96;
/** A chip not measured yet (it appeared after the first layout). */
const CHIP_GUESS = 120;

/** The chips that fit whole in `room` px (null: not measured yet, so every candidate), the rest under More; the
 *  picked source always stays on the row. */
export function fitStrip<T extends { id: string }>(ranked: { shown: T[]; rest: T[] }, room: number | null, width: (id: string) => number | undefined, selected: string | null): { shown: T[]; rest: T[] } {
  if (room === null) return ranked;
  const size = (item: T) => (width(item.id) ?? CHIP_GUESS) + STRIP_GAP;
  const total = ranked.shown.reduce((sum, item) => sum + size(item), 0);
  if (!ranked.rest.length && total <= room) return ranked;
  let used = MORE_WIDTH;
  let fit = 0;
  for (const item of ranked.shown) {
    if (used + size(item) > room) break;
    used += size(item);
    fit += 1;
  }
  let shown = ranked.shown.slice(0, fit);
  const picked = ranked.shown.find((item) => item.id === selected);
  if (picked && !shown.includes(picked)) shown = [...shown.slice(0, Math.max(0, fit - 1)), picked];
  const kept = new Set(shown.map((item) => item.id));
  return { shown: ranked.shown.filter((item) => kept.has(item.id)), rest: [...ranked.shown.filter((item) => !kept.has(item.id)), ...ranked.rest] };
}

/** Items in view per source, from the unfiltered feed. */
export function sourceCounts(feed: Pick<OmniRushWorkFeed, "groups"> | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of [...(feed?.groups.needs_you ?? []), ...(feed?.groups.today ?? []), ...(feed?.groups.fyi ?? [])]) counts[item.source] = (counts[item.source] ?? 0) + 1;
  return counts;
}

/** A problem shows as an icon beside the name (a shape, not a colour alone); fine sources show none. */
function ChipState(props: { source: FeedSource }) {
  const dot = sourceDot(props.source);
  if (dot === "ok") return null;
  const Icon = dot === "syncing" ? Loader2 : AlertCircle;
  return <Icon role="img" aria-label={statusWord(props.source)} className={cn("size-3.5 shrink-0", dot === "syncing" ? "text-muted-foreground motion-safe:animate-spin" : dot === "error" ? "text-red-11" : "text-amber-11")} />;
}

/** One row that never wraps: "All", up to six source chips and More (every other source, with search), then Add.
 *  With one source there is nothing to filter: its pill only shows the status. */
export function SourceStrip(props: { sources: FeedSource[]; selected: string | null; onSelect: (id: string | null) => void; onAdd: () => void; counts?: Record<string, number> }) {
  const solo = props.sources.length === 1;
  const ranked = stripSources(props.sources, props.counts ?? {}, props.selected);
  // Only whole chips: the row measures its room and the chips' widths, and what does not fit goes under More.
  const stripRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // Not laid out (hidden, or a test DOM without layout): every candidate chip, as before measuring.
      if (!strip.clientWidth) return setRoom(null);
      strip.querySelectorAll<HTMLElement>("[data-strip-chip]").forEach((chip) => { if (chip.offsetWidth) widths.current.set(chip.dataset.stripChip ?? "", chip.offsetWidth); });
      const fixed = [...strip.querySelectorAll<HTMLElement>("[data-strip-fixed]")].reduce((sum, node) => sum + node.offsetWidth + STRIP_GAP, 0);
      setRoom(strip.clientWidth - fixed);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);
  const { shown, rest } = fitStrip(ranked, room, (id) => widths.current.get(id), props.selected);
  const chip = (active: boolean) => cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    active ? "border-foreground/20 bg-muted font-medium" : "border-border bg-background hover:bg-muted/50",
  );
  const name = (source: FeedSource) => connectorLabel(source.id, source.label.replace(/\s*\(.*\)$/, ""));
  return (
    <div ref={stripRef} className="flex min-w-0 items-center gap-1.5 overflow-hidden" data-testid="work-source-strip">
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden" {...(solo ? {} : { role: "radiogroup", "aria-label": t("work.today.filter") })}>
        {solo ? null : <button type="button" role="radio" aria-checked={props.selected === null} data-feed-filter="all" data-strip-fixed="" onClick={() => props.onSelect(null)} className={chip(props.selected === null)}>{t("work.today.all")}</button>}
        {shown.map((source) => {
          const dot = sourceDot(source);
          const active = props.selected === source.id;
          const pill = { "data-work-source": source.id, "data-strip-chip": source.id, "data-dot": dot, title: `${connectorLabel(source.id, source.label)} · ${source.attention?.message ?? statusWord(source)}` };
          const body = (
            <>
              <BrandTile id={source.id} size="chip" className="-ms-1.5 rounded-full" />
              {/* "Google (Gmail, Drive, Calendar)" reads as "Google" on a chip. */}
              <span className="max-w-[9rem] truncate">{name(source)}</span>
              <ChipState source={source} />
            </>
          );
          return solo ? <span key={source.id} {...pill} className={cn(chip(false), "hover:bg-background")}>{body}</span> : (
            <button key={source.id} type="button" role="radio" aria-checked={active} {...pill} data-feed-filter={source.id} onClick={() => props.onSelect(source.id)} className={chip(active)}>{body}</button>
          );
        })}
      </div>
      {rest.length ? <MoreSources sources={rest} selected={props.selected} onSelect={props.onSelect} name={name} chip={chip(false)} /> : null}
      <button
        type="button"
        onClick={props.onAdd}
        data-testid="work-source-add"
        data-strip-fixed=""
        className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-3 text-[13px] text-muted-foreground outline-none transition-colors hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus aria-hidden className="size-3.5" />
        {t("common.add")}
      </button>
    </div>
  );
}

/** More: the sources that are not on the strip, with search, each with its status in words. */
function MoreSources(props: { sources: FeedSource[]; selected: string | null; onSelect: (id: string) => void; name: (source: FeedSource) => string; chip: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const found = props.sources.filter((source) => matchesQuery(query, source.label, props.name(source)));
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger
        render={(
          <button type="button" className={props.chip} data-testid="work-source-more" aria-label={t("work.today.more_sources", { count: props.sources.length, n: props.sources.length })}>
            {t("work.today.more")}
            <span className="tabular-nums text-muted-foreground">{props.sources.length}</span>
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </button>
        )}
      />
      <PopoverContent align="start" className="w-72 gap-2 p-2" data-testid="work-source-more-list">
        <ListSearch value={query} onChange={setQuery} label={t("work.today.search_sources")} />
        <ul className="flex max-h-72 flex-col overflow-y-auto" role="listbox" aria-label={t("work.today.filter")}>
          {found.map((source) => (
            <li key={source.id} role="option" aria-selected={props.selected === source.id}>
              <button
                type="button"
                onClick={() => { props.onSelect(source.id); setOpen(false); setQuery(""); }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-start text-[13px] outline-none hover:bg-muted focus-visible:bg-muted"
                data-feed-filter={source.id}
                data-work-source={source.id}
                data-dot={sourceDot(source)}
              >
                <BrandTile id={source.id} size="chip" />
                <span className="min-w-0 flex-1 truncate" title={connectorLabel(source.id, source.label)}>{props.name(source)}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">{statusWord(source)}</span>
              </button>
            </li>
          ))}
          {found.length ? null : <li className="px-2 py-3 text-[13px] text-muted-foreground">{t("work.today.no_sources_found")}</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Sources that need a fix (reconnect, retry or setup): one line each, or one summary line with Review when 2+ do. */
export function SourceAttention(props: { sources: FeedSource[]; busy: string | null; onReconnect: (id: string) => void; onRetry: (id: string) => void; onSetup: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const rowsId = useId();
  const needs = props.sources.filter((source) => { const a = source.attention?.action; return a === "reconnect" || a === "retry" || a === "setup"; });
  if (!needs.length) return null;
  const many = needs.length > 1;
  return (
    <div className="flex flex-col divide-y divide-border rounded-xl border border-border" data-testid="work-source-attention">
      {many ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2" data-testid="work-attention-summary">
          <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
            <AlertCircle aria-hidden className="size-4 shrink-0 text-amber-11" />
            <span className="truncate" title={needs.map((source) => connectorLabel(source.id, source.label)).join(", ")}>{t("work.today.attention_count", { count: needs.length })}</span>
            <span className="flex shrink-0 items-center gap-1">{needs.slice(0, 5).map((source) => <ConnectorIcon key={source.id} id={source.id} className="size-3.5" />)}</span>
          </span>
          <Button variant="outline" size="sm" aria-expanded={open} aria-controls={open ? rowsId : undefined} onClick={() => setOpen(!open)}>{open ? t("common.hide") : t("work.today.review")}</Button>
        </div>
      ) : null}
      {many && !open ? null : <div id={rowsId} className="flex flex-col divide-y divide-border">{needs.map((source) => {
        const action = source.attention!.action!;
        const label = action === "reconnect" ? t("work.connectors.reconnect") : action === "retry" ? t("common.retry") : t("work.today.fix");
        return (
          <div key={source.id} data-work-attention={source.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
              <ConnectorIcon id={source.id} className="size-3.5 shrink-0" />
              <span className="truncate" title={source.attention!.message}>{source.attention!.message}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={props.busy === source.id}
              onClick={() => (action === "reconnect" ? props.onReconnect(source.id) : action === "retry" ? props.onRetry(source.id) : props.onSetup(source.id))}
            >
              {label}
            </Button>
          </div>
        );
      })}</div>}
    </div>
  );
}

/** One feed row: source, title, who and when, why it is here. The whole row opens the item (in the viewer panel when
 *  the server has it, Cmd/Ctrl+click at its source); Ask takes the reason's place on hover or focus. */
export function FeedRow(props: { item: OmniRushWorkFeedItem; now?: number; busy: boolean; selected?: boolean; onOpen: (item: OmniRushWorkFeedItem, options: { external: boolean; newTab: boolean }) => void; onAsk: (item: OmniRushWorkFeedItem) => void }) {
  const item = props.item;
  const when = relativeTime(item.starts_at ?? item.due_at ?? item.at, props.now);
  const open = canOpen({ sourceId: item.source_id ?? undefined, url: item.url }) ? (options: { external: boolean; newTab: boolean }) => props.onOpen(item, options) : null;
  // A GitHub path (owner/repo/dir/file) reads as its name, with repo/dir in the meta line. Drive names may hold "/" and stay whole.
  const cut = item.kind === "file" && item.source === "github" ? item.title.lastIndexOf("/") : -1;
  const [name, folder] = cut > 0 && cut < item.title.length - 1 ? [item.title.slice(cut + 1), item.title.slice(0, cut).replace(/^[^/]+\//, "")] : [item.title, null];
  return (
    <li
      data-feed-item={item.id}
      data-source={item.source}
      {...(open ? {
        role: "button", tabIndex: 0, "data-record-row": item.source_id ?? item.id, "aria-current": props.selected ? "true" : undefined,
        "aria-label": t("work.today.open_item", { title: item.title }),
        onClick: (event: React.MouseEvent) => open(openModifiers(event, isMac())),
        onKeyDown: (event: React.KeyboardEvent) => { if (event.target === event.currentTarget && event.key === " ") { event.preventDefault(); open({ external: false, newTab: false }); } },
      } : {})}
      className={cn(
        "group relative flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0",
        open && "cursor-pointer outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected && "bg-muted/70 hover:bg-muted/70",
      )}
    >
      {props.selected ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-foreground/70" /> : null}
      <ConnectorIcon id={item.source} />
      {/* Room for Ask while it shows, so a long title ends in an ellipsis before it. */}
      <div className="min-w-0 flex-1 group-focus-within:pr-[4.5rem] group-hover:pr-[4.5rem]">
        <div className="truncate text-[13px] font-medium text-foreground" title={item.title}>{name}</div>
        <div className="truncate text-[12px] text-muted-foreground">{[item.who, when, folder].filter(Boolean).join(" · ")}</div>
      </div>
      {item.reason ? <span className="hidden shrink-0 text-[12px] text-muted-foreground transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 sm:inline" data-testid="work-feed-reason">{item.reason}</span> : null}
      <Button variant="ghost" size="sm" className="absolute right-3 top-1/2 -translate-y-1/2 bg-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 disabled:opacity-0" aria-label={t("work.today.ask_about", { title: item.title })} disabled={props.busy} onClick={(event) => { event.stopPropagation(); props.onAsk(item); }}>
        <MessageSquare className="size-3.5" />{t("work.today.ask")}
      </Button>
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="work-feed-loading" aria-busy="true">
      {[3, 2].map((rows, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24 rounded-md" />
          <div className="rounded-xl border border-border">
            {Array.from({ length: rows }, (_, index) => (
              <div key={index} className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0">
                <Skeleton className="size-4 rounded-md" />
                <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3 rounded-md" /><Skeleton className="h-3 w-1/3 rounded-md" /></div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Today view: fixes, source filters and the non-empty sections (re-read on focus and every 5 minutes). */
export function WorkToday(props: {
  client: WorkClient | null; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void>; onOpenConnectors: () => void; checklist?: React.ReactNode;
  /** The filter kept by the caller (the route's `?source=`, so a sidebar connector opens Home filtered to it). */
  source?: string | null; onSourceChange?: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [ownSource, setOwnSource] = useState<string | null>(null);
  const source = props.onSourceChange ? props.source ?? null : ownSource;
  const [asking, setAsking] = useState(false);
  // Rows each section shows now (SECTION_ROWS until "Show N more").
  const [more, setMore] = useState<Record<string, number>>({});
  const pick = (id: string | null) => { if (props.onSourceChange) props.onSourceChange(id); else setOwnSource(id); setMore({}); };
  const feed = useQuery({
    queryKey: workFeedKey(props.client, source),
    queryFn: () => props.client!.getWorkFeed({ ...(source ? { source } : {}), tz: localZone(), limit: 60 }),
    enabled: Boolean(props.client),
    refetchInterval: FEED_REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  // The picked source went away: show all again (one source left has no All chip to clear it).
  useEffect(() => {
    if (source && feed.data && !feed.data.sources.some((item) => item.id === source)) pick(null);
  }, [feed.data, source]);
  // The strip and the chips always show every source, also while one is picked.
  const all = queryClient.getQueryData<OmniRushWorkFeed>(workFeedKey(props.client, null));
  const sources = (source ? all?.sources : feed.data?.sources) ?? feed.data?.sources ?? [];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["omnirush-work-feed"] });
    void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
  };
  const onError = (reason: unknown) => toast.error(workFailure(reason).text);
  const reconnect = useMutation({
    mutationFn: (id: string) => props.client!.startWorkConnector(id),
    onSuccess: (answer) => props.openLink(answer.auth_url),
    onError,
  });
  const retry = useMutation({
    mutationFn: (id: string) => props.client!.syncWorkConnector(id),
    onSuccess: () => { toast.success(t("work.common.sync_started")); refresh(); },
    onError,
  });
  const ask = async (item: OmniRushWorkFeedItem) => {
    if (asking) return;
    setAsking(true);
    try { await props.onAsk(askAboutItemPrompt(item)); } catch (reason) { onError(reason); } finally { setAsking(false); }
  };
  const groupsNow = { needs_you: feed.data?.groups.needs_you ?? [], today: feed.data?.groups.today ?? [], fyi: feed.data?.groups.fyi ?? [] };
  // Every row on screen, in order, so [ and ] in the viewer step through what the page shows.
  const refs: RecordRef[] = [...groupsNow.needs_you, ...groupsNow.today, ...groupsNow.fyi]
    .filter((item) => item.source_id)
    .map((item) => ({ sourceId: item.source_id!, source: item.source, kind: item.kind, title: item.title, url: item.url ?? null }));
  const openFeedItem = (item: OmniRushWorkFeedItem, options: { external: boolean; newTab: boolean }) =>
    openItem({ sourceId: item.source_id ?? "", source: item.source, kind: item.kind, title: item.title, url: item.url ?? null, list: refs }, props.openLink, options);
  const listKeys = useListKeys((row, options) => {
    const item = [...groupsNow.needs_you, ...groupsNow.today, ...groupsNow.fyi].find((entry) => (entry.source_id ?? entry.id) === row.dataset.recordRow);
    if (item) openFeedItem(item, options);
  });
  const openId = useOpenRecordId();
  const support = useViewerSupport((state) => state.support);
  const canCompose = support !== "no" && sources.some((entry) => (entry.id === "google" || entry.id === "microsoft") && entry.status !== "error");
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const now = Date.now();
  const failure = feed.error && !feed.data ? workFailure(feed.error) : null;
  // A source in view that needs reconnecting or keeps failing may be holding back what needs you, so no all-clear then.
  const broken = sources.some((item) => (!source || item.id === source) && (item.attention?.action === "reconnect" || item.attention?.action === "retry"));
  // A source in view still on its first import may bring something that needs you: no all-clear yet either.
  const importing = sources.some((item) => (!source || item.id === source) && sourceDot(item) === "syncing");
  const groups = groupsNow;
  return (
    <div className="flex w-full flex-col gap-6" data-testid="work-today">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-foreground">{t("work.today.today")}</h1>
          <span className="text-[13px] text-muted-foreground">{today}</span>
        </div>
        {canCompose ? (
          <div className="flex items-center gap-1.5" data-testid="work-today-compose">
            <Button variant="outline" size="sm" onClick={() => requestOpenRecord({ sourceId: "", compose: { kind: "mail" } })}><Mail className="size-3.5" />{t("work.viewer.new_mail")}</Button>
            <Button variant="outline" size="sm" onClick={() => requestOpenRecord({ sourceId: "", compose: { kind: "meeting" } })}><CalendarPlus className="size-3.5" />{t("work.viewer.schedule")}</Button>
          </div>
        ) : null}
      </div>
      {sources.length ? (
        <SourceAttention
          sources={sources}
          busy={reconnect.isPending ? reconnect.variables ?? null : retry.isPending ? retry.variables ?? null : null}
          onReconnect={(id) => (signsInWithForm(queryClient.getQueryData<OmniRushWorkConnector[]>(workConnectorsKey(props.client)), id) ? props.onOpenConnectors() : reconnect.mutate(id))}
          onRetry={(id) => retry.mutate(id)}
          onSetup={props.onOpenConnectors}
        />
      ) : null}
      {sources.length ? <SourceStrip sources={sources} selected={source} onSelect={pick} onAdd={props.onOpenConnectors} counts={sourceCounts(all ?? feed.data)} /> : null}
      {props.checklist}
      {feed.isLoading ? <FeedSkeleton /> : failure ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-feed-error">
          <span className="text-[13px] text-muted-foreground">{failure.text}</span>
          {failure.retry ? <Button variant="outline" size="sm" onClick={() => void feed.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
        </div>
      ) : (
        <div className={cn("flex flex-col gap-6", feed.isPlaceholderData && "opacity-60")} data-testid="work-feed">
          {groups.needs_you.length || groups.today.length ? null : !broken ? (importing ? (
            <p className="text-[13px] text-muted-foreground" data-testid="work-feed-importing">{t("work.today.importing")}</p>
          ) : (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground" data-testid="work-feed-clear"><Check aria-hidden className="size-3.5" />{t("work.today.all_clear")}</p>
          )) : groups.fyi.length ? null : (
            // A broken source can be why the feed is empty, so no all-clear and never a blank page.
            <p className="text-[13px] text-muted-foreground" data-testid="work-feed-blocked">{t("work.today.empty_broken")}</p>
          )}
          {SECTIONS.map((section) => {
            const all = groups[section.id];
            if (!all.length) return null;
            const recent = section.id === "fyi";
            const capped = all.length > SECTION_ROWS;
            const limit = more[section.id] ?? SECTION_ROWS;
            const items = all.slice(0, limit);
            const left = all.length - items.length;
            const expanded = limit > SECTION_ROWS;
            // The same reason on every Recent row ("Edited") says nothing, so it is left out.
            const same = recent && all.length > 1 && all.every((item) => item.reason === all[0]!.reason);
            return (
              <section key={section.id} data-feed-section={section.id} aria-label={section.label} className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                  {section.label}
                  {recent ? null : <span className="rounded-full bg-muted px-1.5 text-[12px] font-medium text-foreground" data-testid="work-feed-count">{all.length}</span>}
                </h2>
                <ul className="overflow-hidden rounded-xl border border-border bg-background" data-work-list onKeyDown={listKeys}>
                  {items.map((item) => <FeedRow key={item.id} item={same ? { ...item, reason: null } : item} now={now} busy={asking} selected={Boolean(openId && item.source_id === openId)} onOpen={openFeedItem} onAsk={(picked) => void ask(picked)} />)}
                </ul>
                {capped ? (
                  // A page of SECTION_STEP rows at a time, so a long day never draws hundreds of rows at once.
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setMore({ ...more, [section.id]: left > 0 ? limit + SECTION_STEP : SECTION_ROWS })}
                      data-testid="work-feed-more"
                      className="rounded-md px-1 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {left > 0 ? t("work.today.show_more", { count: Math.min(left, SECTION_STEP) }) : t("work.today.show_less")}
                    </button>
                    {left > 0 && expanded ? (
                      <button type="button" onClick={() => setMore({ ...more, [section.id]: SECTION_ROWS })} data-testid="work-feed-less" className="rounded-md px-1 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                        {t("work.today.show_less")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
