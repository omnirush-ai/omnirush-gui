/** @jsxImportSource react */
// Work > Search (contract D6): one box over every connected channel, results grouped by channel, the coverage meter on top.
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, MessageSquare, RotateCw, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkSearch, OmniRushWorkSearchGroup, OmniRushWorkSearchItem } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutItemPrompt, coverageCanAdd, periodStart, relativeTime, snippetParts, workConnectorsKey, workFailure, workSearchKey, WORK_SEARCH_FOCUS_EVENT, type SearchPeriod, type WorkClient } from "./work-mode";
import { ConnectorIcon, useCoverageMeter, WorkCoverageMeter } from "./work-views";
import { ListMore, ListSearch, matchesQuery, useListCap } from "./list-cap";
import { fitStrip, stripSources } from "./work-today";

/** Items a group shows before "Show all". */
export const GROUP_ROWS = 3;
/** Rows one channel's view shows before "Show N more". */
export const CHANNEL_ROWS = 20;

type Channel = { id: string; label: string; count: number };
const STRIP_GAP = 6;

/** The channel filter as one row that never wraps, like Today's: All, the channels with the most hits that fit whole
 *  (up to six), then More with search for the rest. The picked channel always stays on the row. */
export function ChannelStrip(props: { channels: Channel[]; total: number; selected: string | null; onSelect: (id: string | null) => void }) {
  const counts = Object.fromEntries(props.channels.map((channel) => [channel.id, channel.count]));
  const ranked = stripSources(props.channels, counts, props.selected);
  const stripRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    const measure = () => {
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
  return (
    <div ref={stripRef} className="flex min-w-0 items-center gap-1.5 overflow-hidden" data-testid="work-search-channels">
      <div role="radiogroup" aria-label={t("work.search.channels")} className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <button type="button" role="radio" aria-checked={props.selected === null} data-search-channel="all" data-strip-fixed="" onClick={() => props.onSelect(null)} className={chip(props.selected === null)}>
          {t("work.today.all")}<span className="tabular-nums text-muted-foreground">{props.total.toLocaleString()}</span>
        </button>
        {shown.map((channel) => (
          <button key={channel.id} type="button" role="radio" aria-checked={props.selected === channel.id} data-search-channel={channel.id} data-strip-chip={channel.id} title={`${channel.label} · ${channel.count.toLocaleString()}`} onClick={() => props.onSelect(channel.id)} className={chip(props.selected === channel.id)}>
            <ConnectorIcon id={channel.id} className="size-3.5 text-current" />
            <span className="max-w-[9rem] truncate">{channel.label}</span>
            <span className="tabular-nums text-muted-foreground">{channel.count.toLocaleString()}</span>
          </button>
        ))}
      </div>
      {rest.length ? <MoreChannels channels={rest} selected={props.selected} onSelect={props.onSelect} chip={chip(false)} /> : null}
    </div>
  );
}

/** More: the channels that are not on the row, with search. */
function MoreChannels(props: { channels: Channel[]; selected: string | null; onSelect: (id: string) => void; chip: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const found = props.channels.filter((channel) => matchesQuery(query, channel.label, channel.id));
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger
        render={(
          <button type="button" className={props.chip} data-testid="work-search-channels-more" aria-label={t("work.search.more_channels", { count: props.channels.length, n: props.channels.length })}>
            {t("work.today.more")}
            <span className="tabular-nums text-muted-foreground">{props.channels.length}</span>
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </button>
        )}
      />
      <PopoverContent align="start" className="w-72 gap-2 p-2" data-testid="work-search-channels-list">
        <ListSearch value={query} onChange={setQuery} label={t("work.search.search_channels")} />
        <ul className="flex max-h-72 flex-col overflow-y-auto" role="listbox" aria-label={t("work.search.channels")}>
          {found.map((channel) => (
            <li key={channel.id} role="option" aria-selected={props.selected === channel.id}>
              <button
                type="button"
                onClick={() => { props.onSelect(channel.id); setOpen(false); setQuery(""); }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-start text-[13px] outline-none hover:bg-muted focus-visible:bg-muted"
                data-search-channel={channel.id}
              >
                <ConnectorIcon id={channel.id} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate" title={channel.label}>{channel.label}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{channel.count.toLocaleString()}</span>
              </button>
            </li>
          ))}
          {found.length ? null : <li className="px-2 py-3 text-[13px] text-muted-foreground">{t("work.search.no_channel_match")}</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** One channel's hits (the channel view): the first CHANNEL_ROWS, then "Show N more". Keyed by channel, so a new
 *  channel starts at the first page again. */
function ChannelItems(props: { items: OmniRushWorkSearchItem[]; render: (item: OmniRushWorkSearchItem) => React.ReactNode }) {
  const cap = useListCap(props.items.length, CHANNEL_ROWS);
  return (
    <>
      <ul className="rounded-xl border border-border bg-background" data-testid="work-search-channel-items">
        {props.items.slice(0, cap.shown).map(props.render)}
      </ul>
      <ListMore cap={cap} testId="work-search-channel-more" />
    </>
  );
}
const TYPE_PAUSE_MS = 400;
const PERIODS = [
  { id: "any", get label() { return t("work.search.period_any"); } },
  { id: "week", get label() { return t("work.search.period_week"); } },
  { id: "month", get label() { return t("work.search.period_month"); } },
  { id: "quarter", get label() { return t("work.search.period_quarter"); } },
] as const satisfies readonly { id: SearchPeriod; label: string }[];

function Snippet(props: { text: string | null | undefined }) {
  return <>{snippetParts(props.text).map((part, index) => (part.bold ? <strong key={index} className="font-semibold text-foreground">{part.text}</strong> : <span key={index}>{part.text}</span>))}</>;
}

/** One hit: subject and when, then who and the snippet. The row opens the item; Open and Ask show on hover or focus. */
export function SearchRow(props: { item: OmniRushWorkSearchItem; label: string; now?: number; busy: boolean; onOpen: (url: string) => void; onAsk: (item: OmniRushWorkSearchItem) => void }) {
  const item = props.item;
  const title = item.subject?.trim() || props.label;
  const open = item.url ? () => props.onOpen(item.url!) : null;
  return (
    <li
      data-search-item={item.source_id}
      {...(open ? { role: "button", tabIndex: 0, "aria-label": t("work.today.open_item", { title }), onClick: open, onKeyDown: (event: React.KeyboardEvent) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } } } : {})}
      className={cn("group relative flex flex-col gap-0.5 border-b border-border px-3 py-2.5 last:border-b-0", open && "cursor-pointer outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {/* Room for Open and Ask while they show, so neither line runs under them. */}
      <div className="flex min-w-0 items-baseline gap-3 group-focus-within:pr-[8.5rem] group-hover:pr-[8.5rem]">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={title}>{title}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground group-focus-within:hidden group-hover:hidden">{relativeTime(item.occurred_at, props.now)}</span>
      </div>
      <div className="line-clamp-2 text-[13px] text-muted-foreground group-focus-within:pr-[8.5rem] group-hover:pr-[8.5rem]">
        {item.who ? <span className="text-foreground/80">{item.who}{item.snippet ? " · " : ""}</span> : null}
        <Snippet text={item.snippet} />
      </div>
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        {open ? <Button variant="ghost" size="sm" className="bg-muted" aria-label={t("work.search.open_name", { title })} onClick={(event) => { event.stopPropagation(); open(); }}><ExternalLink className="size-3.5" />{t("work.search.open")}</Button> : null}
        <Button variant="ghost" size="sm" className="bg-muted disabled:opacity-0" aria-label={t("work.today.ask_about", { title })} disabled={props.busy} onClick={(event) => { event.stopPropagation(); props.onAsk(item); }}>
          <MessageSquare className="size-3.5" />{t("work.today.ask")}
        </Button>
      </div>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-2" data-testid="work-search-loading" aria-busy="true">
      <Skeleton className="h-4 w-24 rounded-md" />
      <div className="rounded-xl border border-border">
        {[0, 1, 2].map((index) => (
          <div key={index} className="space-y-1.5 border-b border-border px-3 py-3 last:border-b-0"><Skeleton className="h-3.5 w-2/3 rounded-md" /><Skeleton className="h-3 w-5/6 rounded-md" /></div>
        ))}
      </div>
    </div>
  );
}

/** Work > Search: type to search (after a short pause), narrow by channel and period, Ask starts a Work chat with the question. */
export function WorkSearchPage(props: { client: WorkClient | null; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void>; onOpenConnectors: () => void; initialQuery?: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  // Opened with a question (`/work/search?q=...`): it is in the field and searched at once.
  const [text, setText] = useState(() => (props.initialQuery ?? "").slice(0, 500));
  const [q, setQ] = useState(() => (props.initialQuery ?? "").trim().slice(0, 500));
  const [period, setPeriod] = useState<SearchPeriod>("any");
  const [channel, setChannel] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const focus = () => input.current?.focus();
    focus();
    window.addEventListener(WORK_SEARCH_FOCUS_EVENT, focus);
    return () => window.removeEventListener(WORK_SEARCH_FOCUS_EVENT, focus);
  }, []);
  useEffect(() => {
    const next = text.trim().slice(0, 500);
    if (next === q) return;
    const timer = setTimeout(() => { setQ(next); setChannel(null); }, TYPE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [q, text]);
  const from = periodStart(period);
  const base = { q, ...(from ? { from } : {}) };
  const query = channel ? { ...base, channels: channel, limit: 100 } : base;
  const results = useQuery<OmniRushWorkSearch>({
    queryKey: workSearchKey(props.client, query),
    queryFn: () => props.client!.searchWork(query),
    enabled: Boolean(props.client) && q.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
  // "+" chips only for what Connectors can add (Meetings has no row there). While the meter shows, it alone says what is missing.
  const connectors = useQuery({ queryKey: workConnectorsKey(props.client), queryFn: () => props.client!.listWorkConnectors(), enabled: Boolean(props.client), retry: false });
  const canAdd = (id: string) => coverageCanAdd(connectors.data, id);
  const meterShown = useCoverageMeter(props.client, canAdd).shown;
  // The chips always show every channel of the unfiltered search, also while one is picked.
  const data = q ? results.data : undefined;
  const all = queryClient.getQueryData<OmniRushWorkSearch>(workSearchKey(props.client, base)) ?? (channel ? undefined : data);
  const groups: OmniRushWorkSearchGroup[] = (data?.groups ?? []).filter((group) => !channel || group.channel === channel);
  const failure = results.error && q ? workFailure(results.error) : null;
  const ask = async (prompt: string) => {
    if (asking || !prompt.trim()) return;
    setAsking(true);
    try { await props.onAsk(prompt); } catch (reason) { toast.error(workFailure(reason).text); } finally { setAsking(false); }
  };
  const askItem = (item: OmniRushWorkSearchItem, label: string) =>
    void ask(askAboutItemPrompt({ id: item.source_id, source: label, kind: item.kind, title: item.subject?.trim() || label, url: item.url ?? null }));
  const now = Date.now();
  return (
    <div className="h-full overflow-y-auto" data-testid="work-search">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pb-10 pt-10">
        <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-foreground">{t("work.nav.search")}</h1>
        <WorkCoverageMeter client={props.client} onAdd={props.onOpenConnectors} canAdd={canAdd} />
        <form className="flex items-center gap-2" role="search" onSubmit={(event) => { event.preventDefault(); setQ(text.trim().slice(0, 500)); }}>
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              type="search"
              value={text}
              maxLength={500}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("work.search.placeholder")}
              aria-label={t("work.search.placeholder")}
              data-testid="work-search-input"
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
            />
          </div>
          <Button type="button" variant="outline" className="h-10" disabled={!text.trim() || asking} onClick={() => void ask(text.trim())} data-testid="work-search-ask">
            <MessageSquare className="size-4" />{t("work.today.ask")}
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="radiogroup" aria-label={t("work.search.period")} className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {PERIODS.map(({ id, label }) => (
              <button key={id} type="button" role="radio" aria-checked={period === id} data-search-period={id} onClick={() => { setPeriod(id); setChannel(null); }}
                className={cn("h-6 rounded-md px-2 text-[12px] transition-colors", period === id ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-gray-5" : "text-muted-foreground hover:text-foreground")}>
                {label}
              </button>
            ))}
          </div>
          {data ? <span className="text-[12px] text-muted-foreground" data-testid="work-search-mode">{data.semantic ? t("work.search.meaning") : t("work.search.keywords")}</span> : null}
        </div>
        {data?.indexing && data.indexing.total > 0 ? (
          <p className="text-[12px] text-muted-foreground" data-testid="work-search-indexing">{t("work.search.indexing", { embedded: data.indexing.embedded.toLocaleString(), total: data.indexing.total.toLocaleString() })}</p>
        ) : null}
        {all && all.groups.length > 1 ? (
          <ChannelStrip channels={all.groups.map((group) => ({ id: group.channel, label: group.label, count: group.count }))} total={all.total} selected={channel} onSelect={setChannel} />
        ) : null}
        {!q ? null : results.isLoading ? <ResultsSkeleton /> : failure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-search-error">
            <span className="text-[13px] text-muted-foreground">{failure.text}</span>
            {failure.retry ? <Button variant="outline" size="sm" onClick={() => void results.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
          </div>
        ) : !groups.length ? (
          <p className="text-[13px] text-muted-foreground" data-testid="work-search-empty">{meterShown ? t("work.search.no_match") : t("work.search.empty")}</p>
        ) : (
          <div className={cn("flex flex-col gap-6", results.isPlaceholderData && "opacity-60")} data-testid="work-search-results">
            {groups.map((group) => {
              const items = channel ? group.items : group.items.slice(0, GROUP_ROWS);
              const row = (item: OmniRushWorkSearchItem) => <SearchRow key={item.source_id} item={item} label={group.label} now={now} busy={asking} onOpen={props.openLink} onAsk={(picked) => askItem(picked, group.label)} />;
              return (
                <section key={group.channel} data-search-group={group.channel} aria-label={group.label} className="flex flex-col gap-2">
                  <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                    <ConnectorIcon id={group.channel} className="size-3.5" />
                    {group.label}
                    <span className="rounded-full bg-muted px-1.5 text-[12px] font-medium text-foreground">{group.count.toLocaleString()}</span>
                  </h2>
                  {/* The backend fills items only for the top hits overall, so a lower-ranked channel can come with a count and no items. */}
                  {items.length && channel ? (
                    <ChannelItems key={`${group.channel}:${q}:${period}`} items={items} render={row} />
                  ) : items.length ? (
                    <ul className="rounded-xl border border-border bg-background">{items.map(row)}</ul>
                  ) : null}
                  {!channel && group.count > items.length ? (
                    <button type="button" onClick={() => setChannel(group.channel)} data-testid="work-search-show-all" className="self-start rounded-md px-1 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      {t("work.search.show_all", { count: group.count })}
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
        {data?.coverage_note && q && !meterShown ? <p className="text-[12px] text-muted-foreground" data-testid="work-search-note">{data.coverage_note}</p> : null}
      </div>
    </div>
  );
}
