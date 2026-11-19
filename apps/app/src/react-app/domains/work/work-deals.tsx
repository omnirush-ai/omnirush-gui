/** @jsxImportSource react */
// Work > Deals (contract D3/D6): open deals with stage, amount, close date, last touch and risk; a row opens the deal.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageSquare, RotateCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkDeal, OmniRushWorkDealDetail, OmniRushWorkDealFilter } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { askAboutDealPrompt, connectorLabel, relativeTime, workDealKey, workDealsKey, workFailure, type WorkClient } from "./work-mode";
import { ConnectorIcon } from "./work-views";

const FILTERS = [
  { id: "open", get label() { return t("work.deals.filter_open"); } },
  { id: "at_risk", get label() { return t("work.deals.filter_at_risk"); } },
  { id: "closing_soon", get label() { return t("work.deals.filter_closing_soon"); } },
] as const satisfies readonly { id: OmniRushWorkDealFilter; label: string }[];

export const dealAmount = (amount: number | null | undefined) => (typeof amount === "number" ? amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "");
export function dealDate(value: string | null | undefined): string {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

/** Risk reasons as quiet amber text: the first one, and "+N" with all of them on hover. */
function RiskChips(props: { risk: string[] }) {
  if (!props.risk.length) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-amber-11" title={props.risk.join("\n")} data-testid="work-deal-risk">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-9" />
      <span className="truncate">{props.risk[0]}</span>
      {props.risk.length > 1 ? <span className="shrink-0 text-muted-foreground">+{props.risk.length - 1}</span> : null}
    </span>
  );
}

function LastTouch(props: { touch: OmniRushWorkDeal["last_touch"]; now?: number }) {
  if (!props.touch?.at) return <span className="text-muted-foreground">{t("work.deals.no_touch")}</span>;
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground" title={connectorLabel(props.touch.channel)}>
      <ConnectorIcon id={props.touch.channel} className="size-3.5" />{relativeTime(props.touch.at, props.now)}
    </span>
  );
}

/** One deal opened beside the list: details, people, the latest records per channel, risks and Ask about this deal. */
export function DealPanel(props: { client: WorkClient | null; deal: OmniRushWorkDeal; openLink: (url: string) => void; onAsk: () => void; asking: boolean }) {
  const detail = useQuery<OmniRushWorkDealDetail>({
    queryKey: workDealKey(props.client, props.deal.source_id),
    queryFn: () => props.client!.getWorkDeal(props.deal.source_id),
    enabled: Boolean(props.client),
    retry: false,
  });
  const deal = detail.data ?? props.deal;
  const facts = [
    [t("work.deals.stage"), deal.stage],
    [t("work.deals.amount"), dealAmount(deal.amount)],
    [t("work.deals.close_date"), dealDate(deal.close_date)],
    [t("work.deals.owner"), deal.owner],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  const failure = detail.error ? workFailure(detail.error) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4 text-[13px]" data-testid="work-deal-panel">
      {facts.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {facts.flatMap(([label, value]) => [<dt key={`${label}-t`} className="text-muted-foreground">{label}</dt>, <dd key={`${label}-d`} className="text-foreground">{value}</dd>])}
        </dl>
      ) : null}
      {deal.risk.length ? (
        <section className="flex flex-col gap-1.5" aria-label={t("work.deals.risk")}>
          <h3 className="text-[12px] font-semibold text-foreground">{t("work.deals.risk")}</h3>
          <ul className="flex flex-col gap-1">{deal.risk.map((reason) => <li key={reason} className="flex items-center gap-2 text-amber-11"><span aria-hidden className="size-1.5 rounded-full bg-amber-9" />{reason}</li>)}</ul>
        </section>
      ) : null}
      {detail.isLoading ? <Skeleton className="h-24 rounded-lg" data-testid="work-deal-loading" /> : failure ? (
        <p className="text-muted-foreground" data-testid="work-deal-error">{failure.text}</p>
      ) : (
        <>
          {detail.data?.contacts?.length ? (
            <section className="flex flex-col gap-1.5" aria-label={t("work.deals.people")}>
              <h3 className="text-[12px] font-semibold text-foreground">{t("work.deals.people")}</h3>
              <p className="text-foreground">{detail.data.contacts.map((person) => person.name).join(", ")}</p>
            </section>
          ) : null}
          {detail.data?.activity?.length ? (
            <section className="flex flex-col gap-3" aria-label={t("work.deals.latest")}>
              <h3 className="text-[12px] font-semibold text-foreground">{t("work.deals.latest")}</h3>
              {detail.data.activity.map((channel) => (
                <div key={channel.channel} className="flex flex-col gap-1" data-deal-channel={channel.channel}>
                  <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><ConnectorIcon id={channel.channel} className="size-3.5" />{connectorLabel(channel.channel)}</span>
                  <ul className="flex flex-col">
                    {channel.items.slice(0, 3).map((item) => (
                      <li key={item.source_id} className="flex items-baseline gap-2">
                        {item.url ? (
                          <button type="button" className="min-w-0 flex-1 truncate text-start text-foreground hover:underline" onClick={() => props.openLink(item.url!)}>{item.subject || item.kind}</button>
                        ) : <span className="min-w-0 flex-1 truncate text-foreground">{item.subject || item.kind}</span>}
                        <span className="shrink-0 text-[12px] text-muted-foreground">{relativeTime(item.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        <Button size="sm" disabled={props.asking} onClick={props.onAsk} data-testid="work-deal-ask"><MessageSquare className="size-3.5" />{t("work.deals.ask")}</Button>
        {deal.url ? <Button variant="outline" size="sm" onClick={() => props.openLink(deal.url!)}><ExternalLink className="size-3.5" />{t("work.search.open")}</Button> : null}
      </div>
    </div>
  );
}

/** Work > Deals: Open, At risk or Closing soon; the table drops stage and close date on a narrow window. */
export function WorkDealsPage(props: { client: WorkClient | null; openLink: (url: string) => void; onAsk: (prompt: string) => Promise<void> }) {
  const [filter, setFilter] = useState<OmniRushWorkDealFilter>("open");
  const [picked, setPicked] = useState<OmniRushWorkDeal | null>(null);
  const [asking, setAsking] = useState(false);
  const deals = useQuery({
    queryKey: workDealsKey(props.client, filter),
    queryFn: () => props.client!.listWorkDeals(filter),
    enabled: Boolean(props.client),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const ask = async (deal: OmniRushWorkDeal) => {
    if (asking) return;
    setAsking(true);
    try { await props.onAsk(askAboutDealPrompt(deal)); setPicked(null); } catch (reason) { toast.error(workFailure(reason).text); } finally { setAsking(false); }
  };
  const failure = deals.error && !deals.data ? workFailure(deals.error) : null;
  const items = deals.data?.items ?? [];
  const now = Date.now();
  const narrow = "hidden @2xl:table-cell";
  return (
    <div className="h-full overflow-y-auto" data-testid="work-deals">
      <div className="@container mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 pb-10 pt-10">
        <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-foreground">{t("work.nav.deals")}</h1>
        <div role="radiogroup" aria-label={t("work.deals.filter")} className="flex items-center gap-0.5 self-start rounded-lg bg-muted p-0.5">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" role="radio" aria-checked={filter === id} data-deal-filter={id} onClick={() => setFilter(id)}
              className={cn("h-6 rounded-md px-2 text-[12px] transition-colors", filter === id ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-gray-5" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        {deals.isLoading ? (
          <div className="rounded-xl border border-border" data-testid="work-deals-loading" aria-busy="true">
            {[0, 1, 2].map((index) => <div key={index} className="border-b border-border px-3 py-3 last:border-b-0"><Skeleton className="h-3.5 w-2/3 rounded-md" /></div>)}
          </div>
        ) : failure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-deals-error">
            <span className="text-[13px] text-muted-foreground">{failure.text}</span>
            {failure.retry ? <Button variant="outline" size="sm" onClick={() => void deals.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
          </div>
        ) : !items.length ? (
          <p className="text-[13px] text-muted-foreground" data-testid="work-deals-empty">{t("work.deals.none")}</p>
        ) : (
          <div className={cn("overflow-hidden rounded-xl border border-border", deals.isPlaceholderData && "opacity-60")}>
            <table className="w-full table-fixed text-[13px]" data-testid="work-deals-table">
              <thead className="text-left text-[12px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">{t("work.deals.deal")}</th>
                  <th className={cn("w-[8rem] px-3 py-2 font-medium", narrow)}>{t("work.deals.stage")}</th>
                  <th className="w-[6.5rem] px-3 py-2 text-right font-medium">{t("work.deals.amount")}</th>
                  <th className={cn("w-[5.5rem] px-3 py-2 font-medium", narrow)}>{t("work.deals.close_date")}</th>
                  <th className="w-[7rem] px-3 py-2 font-medium">{t("work.deals.last_touch")}</th>
                  <th className="w-[13rem] px-3 py-2 font-medium">{t("work.deals.risk")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((deal) => (
                  <tr
                    key={deal.source_id}
                    data-deal={deal.source_id}
                    tabIndex={0}
                    aria-label={t("work.deals.open_deal", { name: deal.name ?? deal.source_id })}
                    onClick={() => setPicked(deal)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPicked(deal); } }}
                    className="cursor-pointer border-b border-border outline-none last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <td className="px-3 py-2.5">
                      <div className="truncate font-medium text-foreground" title={deal.name ?? ""}>{deal.name || deal.source_id}</div>
                      {deal.company ? <div className="truncate text-[12px] text-muted-foreground">{deal.company}</div> : null}
                    </td>
                    <td className={cn("truncate px-3 py-2.5 text-muted-foreground", narrow)}>{deal.stage}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{dealAmount(deal.amount)}</td>
                    <td className={cn("px-3 py-2.5 text-muted-foreground", narrow)}>{dealDate(deal.close_date)}</td>
                    <td className="px-3 py-2.5 text-[12px]"><LastTouch touch={deal.last_touch} now={now} /></td>
                    <td className="px-3 py-2.5"><RiskChips risk={deal.risk} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Sheet open={picked !== null} onOpenChange={(open) => { if (!open) setPicked(null); }}>
        <SheetContent className="w-[420px] max-w-[92vw] gap-0 p-0 sm:max-w-[420px]">
          {picked ? (
            <>
              <SheetHeader className="border-b border-border px-5 pb-4 pe-14 pt-5">
                <SheetTitle className="text-base font-semibold">{picked.name || picked.source_id}</SheetTitle>
                {picked.company ? <SheetDescription>{picked.company}</SheetDescription> : null}
              </SheetHeader>
              <DealPanel client={props.client} deal={picked} openLink={props.openLink} onAsk={() => void ask(picked)} asking={asking} />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
