/** @jsxImportSource react */
// The Work home's Today view (contract Addendum C2): the connected sources as a strip, then Needs you / Today / FYI
// from GET /work/feed, with per-source filters. Each row opens at its source or starts a Work chat about it.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageSquare, Plus, RotateCw } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import type { OmniRushWorkFeed, OmniRushWorkFeedItem } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutItemPrompt, connectorLabel, relativeTime, workConnectorsKey, workFeedKey, type WorkClient } from "./work-mode";
import { ConnectorIcon } from "./work-views";

export const FEED_REFRESH_MS = 5 * 60_000;
const SECTIONS = [
  { id: "needs_you", label: "Needs you", empty: "Nothing is waiting on you." },
  { id: "today", label: "Today", empty: "Nothing scheduled or due today." },
  { id: "fyi", label: "FYI", empty: "Nothing new in the last 7 days." },
] as const;

type FeedSource = OmniRushWorkFeed["sources"][number];

/** A source pill's dot: ok, syncing, or attention (red when it needs reconnecting or keeps failing). */
export function sourceDot(source: Pick<FeedSource, "status" | "attention">): "ok" | "syncing" | "attention" | "error" {
  if (source.attention) return source.attention.kind === "reconnect" || source.attention.kind === "failing" ? "error" : "attention";
  if (source.status === "error") return "error";
  return source.status === "syncing" ? "syncing" : "ok";
}

const DOT_CLASS = { ok: "bg-green-9", syncing: "bg-blue-9 animate-pulse", attention: "bg-amber-9", error: "bg-red-9" } as const;
const DOT_LABEL = { ok: "Up to date", syncing: "Syncing", attention: "Needs attention", error: "Needs attention" } as const;

function localZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** The connected sources, each with its status and, when it has a problem, the fix inline. */
export function SourceStrip(props: { sources: FeedSource[]; busy: string | null; onReconnect: (id: string) => void; onRetry: (id: string) => void; onAdd: () => void; onSetup: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="work-source-strip">
      {props.sources.map((source) => {
        const dot = sourceDot(source);
        const action = source.attention?.action ?? null;
        return (
          <div
            key={source.id}
            data-work-source={source.id}
            data-dot={dot}
            title={source.attention?.message ?? DOT_LABEL[dot]}
            className="flex h-8 items-center gap-1.5 rounded-full border border-border bg-background ps-2.5 pe-1 text-[12px] text-foreground"
          >
            <ConnectorIcon id={source.id} className="size-3.5" />
            <span className="max-w-[10rem] truncate">{connectorLabel(source.id, source.label)}</span>
            <span aria-label={DOT_LABEL[dot]} role="img" className={cn("mx-1 size-2 shrink-0 rounded-full", DOT_CLASS[dot])} />
            {action === "reconnect" || action === "retry" || action === "setup" ? (
              <button
                type="button"
                disabled={props.busy === source.id}
                onClick={() => (action === "reconnect" ? props.onReconnect(source.id) : action === "retry" ? props.onRetry(source.id) : props.onSetup())}
                className="rounded-full px-2 py-0.5 font-medium text-foreground hover:bg-muted disabled:opacity-60"
              >
                {action === "reconnect" ? "Reconnect" : action === "retry" ? "Retry" : "Fix"}
              </button>
            ) : <span className="w-1" />}
          </div>
        );
      })}
      <button
        type="button"
        onClick={props.onAdd}
        data-testid="work-source-add"
        className="flex h-8 items-center gap-1 rounded-full border border-dashed border-border px-3 text-[12px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
      >
        <Plus aria-hidden className="size-3.5" />
        Add
      </button>
    </div>
  );
}

/** One feed row: source, title, who and when, why it is here, Open and Ask about this. */
export function FeedRow(props: { item: OmniRushWorkFeedItem; now?: number; busy: boolean; onOpen: (url: string) => void; onAsk: (item: OmniRushWorkFeedItem) => void }) {
  const item = props.item;
  const when = relativeTime(item.starts_at ?? item.due_at ?? item.at, props.now);
  return (
    <li className="group flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0" data-feed-item={item.id} data-source={item.source}>
      <ConnectorIcon id={item.source} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground" title={item.title}>{item.title}</div>
        <div className="truncate text-[12px] text-muted-foreground">{[item.who, when].filter(Boolean).join(" · ")}</div>
      </div>
      {item.reason ? <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex" data-testid="work-feed-reason">{item.reason}</Badge> : null}
      <div className="flex shrink-0 items-center gap-1">
        {item.url ? (
          <Button variant="ghost" size="sm" aria-label={`Open ${item.title}`} onClick={() => props.onOpen(item.url!)}>
            <ExternalLink className="size-3.5" />Open
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" aria-label={`Ask about ${item.title}`} disabled={props.busy} onClick={() => props.onAsk(item)}>
          <MessageSquare className="size-3.5" />Ask about this
        </Button>
      </div>
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

/** The Today view: source strip, filters and the three sections (re-read on focus and every 5 minutes). */
export function WorkToday(props: { client: WorkClient | null; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void>; onOpenConnectors: () => void; badge?: React.ReactNode; checklist?: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const feed = useQuery({
    queryKey: workFeedKey(props.client, source),
    queryFn: () => props.client!.getWorkFeed({ ...(source ? { source } : {}), tz: localZone(), limit: 60 }),
    enabled: Boolean(props.client),
    refetchInterval: FEED_REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  // The strip and the chips always show every source, also while one is picked.
  const all = queryClient.getQueryData<OmniRushWorkFeed>(workFeedKey(props.client, null));
  const sources = (source ? all?.sources : feed.data?.sources) ?? feed.data?.sources ?? [];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["omnirush-work-feed"] });
    void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
  };
  const onError = (reason: unknown) => toast.error(reason instanceof Error ? reason.message : "That did not work. Try again.");
  const reconnect = useMutation({
    mutationFn: (id: string) => props.client!.startWorkConnector(id),
    onSuccess: (answer) => props.openLink(answer.auth_url),
    onError,
  });
  const retry = useMutation({
    mutationFn: (id: string) => props.client!.syncWorkConnector(id),
    onSuccess: () => { toast.success("Sync started"); refresh(); },
    onError,
  });
  const ask = async (item: OmniRushWorkFeedItem) => {
    if (asking) return;
    setAsking(true);
    try { await props.onAsk(askAboutItemPrompt(item)); } catch (reason) { onError(reason); } finally { setAsking(false); }
  };
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const now = Date.now();
  return (
    <div className="flex w-full flex-col gap-5" data-testid="work-today">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-foreground">Today</h1>
          <p className="text-[13px] text-muted-foreground">{today}</p>
        </div>
        {props.badge}
      </div>
      {sources.length ? (
        <SourceStrip
          sources={sources}
          busy={reconnect.isPending ? reconnect.variables ?? null : retry.isPending ? retry.variables ?? null : null}
          onReconnect={(id) => reconnect.mutate(id)}
          onRetry={(id) => retry.mutate(id)}
          onAdd={props.onOpenConnectors}
          onSetup={props.onOpenConnectors}
        />
      ) : null}
      {props.checklist}
      {sources.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Filter by source" data-testid="work-feed-filters">
          {[null, ...sources.map((item) => item.id)].map((id) => (
            <button
              key={id ?? "all"}
              type="button"
              role="radio"
              aria-checked={source === id}
              data-feed-filter={id ?? "all"}
              onClick={() => setSource(id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors",
                source === id ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {id ? <ConnectorIcon id={id} className="size-3 text-current" /> : null}
              {id ? connectorLabel(id, sources.find((item) => item.id === id)?.label) : "All"}
            </button>
          ))}
        </div>
      ) : null}
      {feed.isLoading ? <FeedSkeleton /> : feed.error && !feed.data ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-feed-error">
          <span className="text-[13px] text-muted-foreground">{feed.error instanceof Error ? feed.error.message : "Today could not be loaded."}</span>
          <Button variant="outline" size="sm" onClick={() => void feed.refetch()}><RotateCw className="size-3.5" />Try again</Button>
        </div>
      ) : (
        <div className={cn("flex flex-col gap-6", feed.isPlaceholderData && "opacity-60")} data-testid="work-feed">
          {SECTIONS.map((section) => {
            const items = feed.data?.groups[section.id] ?? [];
            return (
              <section key={section.id} data-feed-section={section.id} aria-label={section.label} className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                  {section.label}
                  <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground" data-testid="work-feed-count">{items.length}</span>
                </h2>
                {items.length ? (
                  <ul className="rounded-xl border border-border bg-background">
                    {items.map((item) => <FeedRow key={item.id} item={item} now={now} busy={asking} onOpen={props.openLink} onAsk={(picked) => void ask(picked)} />)}
                  </ul>
                ) : <p className="px-1 text-[12px] text-muted-foreground">{section.empty}</p>}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
