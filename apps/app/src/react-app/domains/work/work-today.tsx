/** @jsxImportSource react */
// The Work home's Today view (contract Addendum C2): sources that need a fix, the sources as filter chips, then
// Needs you / Today / Recent from GET /work/feed (empty sections stay out). Each row opens at its source or starts a Work chat about it.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Plus, RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkConnector, OmniRushWorkFeed, OmniRushWorkFeedItem } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutItemPrompt, connectorLabel, relativeTime, signsInWithForm, workConnectorsKey, workFailure, workFeedKey, type WorkClient } from "./work-mode";
import { ConnectorIcon } from "./work-views";

export const FEED_REFRESH_MS = 5 * 60_000;
/** Rows a section shows before "Show N more". */
export const SECTION_ROWS = 5;
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

const DOT_CLASS = { ok: "bg-green-9", syncing: "bg-blue-9 animate-pulse", attention: "bg-amber-9", error: "bg-red-9" } as const;
const dotLabel = (dot: keyof typeof DOT_CLASS) => (dot === "ok" ? t("work.today.dot_ok") : dot === "syncing" ? t("work.today.dot_syncing") : t("work.today.dot_attention"));

function localZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** One row: an "All" chip and one chip per source that shows its status dot and filters the feed. Add sits at the end.
 * With one source there is nothing to filter: its pill only shows the status. */
export function SourceStrip(props: { sources: FeedSource[]; selected: string | null; onSelect: (id: string | null) => void; onAdd: () => void }) {
  const solo = props.sources.length === 1;
  const chip = (active: boolean) => cn(
    "flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] text-foreground transition-colors",
    active ? "border-foreground/20 bg-muted font-medium" : "border-border bg-background hover:bg-muted/50",
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="work-source-strip">
      <div className="flex flex-wrap items-center gap-1.5" {...(solo ? {} : { role: "radiogroup", "aria-label": t("work.today.filter") })}>
        {solo ? null : <button type="button" role="radio" aria-checked={props.selected === null} data-feed-filter="all" onClick={() => props.onSelect(null)} className={chip(props.selected === null)}>{t("work.today.all")}</button>}
        {props.sources.map((source) => {
          const dot = sourceDot(source);
          const active = props.selected === source.id;
          const pill = { "data-work-source": source.id, "data-dot": dot, title: source.attention?.message ?? dotLabel(dot) };
          const body = (
            <>
              <ConnectorIcon id={source.id} className="size-3.5 text-current" />
              {/* "Google (Gmail, Drive, Calendar)" reads as "Google" on a chip. */}
              <span className="max-w-[10rem] truncate">{connectorLabel(source.id, source.label.replace(/\s*\(.*\)$/, ""))}</span>
              <span aria-label={dotLabel(dot)} role="img" className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[dot])} />
            </>
          );
          return solo ? <span key={source.id} {...pill} className={cn(chip(false), "hover:bg-background")}>{body}</span> : (
            <button key={source.id} type="button" role="radio" aria-checked={active} {...pill} data-feed-filter={source.id} onClick={() => props.onSelect(source.id)} className={chip(active)}>{body}</button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={props.onAdd}
        data-testid="work-source-add"
        className="flex h-8 items-center gap-1 rounded-full border border-dashed border-border px-3 text-[12px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
      >
        <Plus aria-hidden className="size-3.5" />
        {t("common.add")}
      </button>
    </div>
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
          <span className="flex min-w-0 items-center gap-2 text-[12px] text-foreground">
            <span className="flex shrink-0 items-center gap-1">{needs.map((source) => <ConnectorIcon key={source.id} id={source.id} className="size-3.5" />)}</span>
            <span className="truncate">{t("work.today.attention_count", { count: needs.length })}</span>
          </span>
          <Button variant="outline" size="sm" aria-expanded={open} aria-controls={open ? rowsId : undefined} onClick={() => setOpen(!open)}>{open ? t("common.hide") : t("work.today.review")}</Button>
        </div>
      ) : null}
      {many && !open ? null : <div id={rowsId} className="flex flex-col divide-y divide-border">{needs.map((source) => {
        const action = source.attention!.action!;
        const label = action === "reconnect" ? t("work.connectors.reconnect") : action === "retry" ? t("common.retry") : t("work.today.fix");
        return (
          <div key={source.id} data-work-attention={source.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
              <ConnectorIcon id={source.id} className="size-3.5 shrink-0" />
              <span className="truncate">{source.attention!.message}</span>
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

/** One feed row: source, title, who and when, why it is here. The whole row opens the item; Ask takes the reason's place on hover or focus. */
export function FeedRow(props: { item: OmniRushWorkFeedItem; now?: number; busy: boolean; onOpen: (url: string) => void; onAsk: (item: OmniRushWorkFeedItem) => void }) {
  const item = props.item;
  const when = relativeTime(item.starts_at ?? item.due_at ?? item.at, props.now);
  const open = item.url ? () => props.onOpen(item.url!) : null;
  // A GitHub path (owner/repo/dir/file) reads as its name, with repo/dir in the meta line. Drive names may hold "/" and stay whole.
  const cut = item.kind === "file" && item.source === "github" ? item.title.lastIndexOf("/") : -1;
  const [name, folder] = cut > 0 && cut < item.title.length - 1 ? [item.title.slice(cut + 1), item.title.slice(0, cut).replace(/^[^/]+\//, "")] : [item.title, null];
  return (
    <li
      data-feed-item={item.id}
      data-source={item.source}
      {...(open ? { role: "button", tabIndex: 0, "aria-label": t("work.today.open_item", { title: item.title }), onClick: open, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } } } : {})}
      className={cn(
        "group relative flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0",
        open && "cursor-pointer outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
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
export function WorkToday(props: { client: WorkClient | null; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void>; onOpenConnectors: () => void; badge?: React.ReactNode; checklist?: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const pick = (id: string | null) => { setSource(id); setMore({}); };
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
    if (source && feed.data && !feed.data.sources.some((item) => item.id === source)) { setSource(null); setMore({}); }
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
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const now = Date.now();
  const failure = feed.error && !feed.data ? workFailure(feed.error) : null;
  // A source in view that needs reconnecting or keeps failing may be holding back what needs you, so no all-clear then.
  const broken = sources.some((item) => (!source || item.id === source) && (item.attention?.action === "reconnect" || item.attention?.action === "retry"));
  // A source in view still on its first import may bring something that needs you: no all-clear yet either.
  const importing = sources.some((item) => (!source || item.id === source) && sourceDot(item) === "syncing");
  const groups = { needs_you: feed.data?.groups.needs_you ?? [], today: feed.data?.groups.today ?? [], fyi: feed.data?.groups.fyi ?? [] };
  return (
    <div className="flex w-full flex-col gap-6" data-testid="work-today">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-foreground">{t("work.today.today")}</h1>
          <span className="text-[13px] text-muted-foreground">{today}</span>
        </div>
        {props.badge}
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
      {sources.length ? <SourceStrip sources={sources} selected={source} onSelect={pick} onAdd={props.onOpenConnectors} /> : null}
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
            const items = capped && !more[section.id] ? all.slice(0, SECTION_ROWS) : all;
            // The same reason on every Recent row ("Edited") says nothing, so it is left out.
            const same = recent && all.length > 1 && all.every((item) => item.reason === all[0]!.reason);
            return (
              <section key={section.id} data-feed-section={section.id} aria-label={section.label} className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                  {section.label}
                  {recent ? null : <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground" data-testid="work-feed-count">{all.length}</span>}
                </h2>
                <ul className="rounded-xl border border-border bg-background">
                  {items.map((item) => <FeedRow key={item.id} item={same ? { ...item, reason: null } : item} now={now} busy={asking} onOpen={props.openLink} onAsk={(picked) => void ask(picked)} />)}
                </ul>
                {capped ? (
                  <button type="button" aria-expanded={Boolean(more[section.id])} onClick={() => setMore({ ...more, [section.id]: !more[section.id] })} data-testid="work-feed-more" className="self-start text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                    {more[section.id] ? t("work.today.show_less") : t("work.today.show_more", { count: all.length - SECTION_ROWS })}
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
