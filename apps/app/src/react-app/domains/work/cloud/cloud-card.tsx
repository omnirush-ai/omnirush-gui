/** @jsxImportSource react */
// Cloud tasks outside their page (design 3.5, 3.6): the compact card under a work_cloud_* tool line in a Work chat
// ("Scheduled Pull supplier invoices, every Monday 08:00 [Open task]", or a run line that updates while it is on
// screen), and the Today strip (runs that need the person or failed in the last day, at most 3, Show all goes to the
// page). Both open Work > Cloud tasks through `openCloud`.
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Cloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { OmniRushWorkCloudFeedItem } from "@/app/lib/omnirush-server";

import { relativeTime, workFeedKey, type WorkClient } from "../work-mode";
import { cloudCard, cloudRunKey, isOpen, openCloud, RUN_POLL_MS, savedText, scheduleText, TODAY_ROWS, useCloudClientStore, waitingAction, type CloudCard } from "./cloud-model";
import { StatusLine } from "./run-view";

/** The card's run line, read again while it is going (only while Cloud tasks are on: the session route sets the client). */
function RunLine(props: { card: Extract<CloudCard, { kind: "run" }> }) {
  const client = useCloudClientStore((state) => state.client);
  const run = useQuery({
    queryKey: cloudRunKey(client, props.card.runId),
    queryFn: () => client!.getWorkCloudRun(props.card.runId),
    enabled: Boolean(client),
    retry: false,
    refetchInterval: (query) => (isOpen(query.state.data?.status ?? props.card.status) ? RUN_POLL_MS : false),
    refetchIntervalInBackground: false,
  });
  const status = run.data?.status ?? props.card.status;
  const waiting = run.data?.waiting_for ?? props.card.waiting;
  const steps = run.data?.steps ?? null;
  const taskId = run.data?.task_id ?? props.card.taskId;
  const saved = run.data?.result?.records.saved ?? props.card.saved;
  const action = status === "waiting" ? waitingAction(waiting, false) : t("work.cloud.open_run");
  return (
    <div className="mt-1.5 flex max-w-[34rem] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-background px-3 py-2" data-testid="work-cloud-card" data-kind="run" data-status={status}>
      <Cloud aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {props.card.title ? <div className="truncate text-[13px] font-medium text-foreground">{props.card.title}</div> : null}
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <StatusLine status={status} waiting={waiting} steps={steps} />
          {status === "done" && saved ? <span className="truncate text-muted-foreground">· {savedText("row", saved)}</span> : null}
        </div>
      </div>
      {client ? <Button size="xs" variant="outline" onClick={() => openCloud({ task: taskId, run: props.card.runId })} data-testid="work-cloud-card-open">{action}</Button> : null}
    </div>
  );
}

/** The card under a Cloud tasks tool's line; nothing for lists, sign-ins or an answer that does not read as a card. */
export function CloudToolCard(props: { toolName: string; output: unknown }) {
  const card = cloudCard(props.toolName, props.output);
  const client = useCloudClientStore((state) => state.client);
  if (!card) return null;
  if (card.kind === "run") return <RunLine card={card} />;
  return (
    <div className="mt-1.5 flex max-w-[34rem] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-background px-3 py-2" data-testid="work-cloud-card" data-kind="task">
      <CalendarClock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">{card.title || t("work.cloud.task")}</div>
        <div className="truncate text-[12px] text-muted-foreground">{card.schedule ? t("work.cloud.card_scheduled", { when: scheduleText(card.schedule) }) : t("work.cloud.card_saved")}</div>
      </div>
      {client ? <Button size="xs" variant="outline" onClick={() => openCloud({ task: card.taskId, run: card.runId })} data-testid="work-cloud-card-open">{t("work.cloud.open_task_short")}</Button> : null}
    </div>
  );
}

/** The feed's Cloud tasks rows that need the person or failed. */
export function actionableCloud(items: OmniRushWorkCloudFeedItem[] | null | undefined): OmniRushWorkCloudFeedItem[] {
  return (items ?? []).filter((item) => item.status === "waiting" || item.status === "failed" || item.status === "limit" || item.status === "timed_out");
}

/** How often Work Home reads the feed for the strip while nothing is connected (a code or a sign-in may be waiting). */
export const CLOUD_HOME_REFRESH_MS = 60_000;

/**
 * Cloud tasks runs for Work Home when no connector is connected, so the Today view is not there (the main use: portals
 * with no API). Reads the feed only while `on` (Cloud tasks on for this person); otherwise asks nothing.
 */
export function useCloudHomeItems(client: Pick<WorkClient, "getWorkFeed" | "baseUrl"> | null, on: boolean): OmniRushWorkCloudFeedItem[] {
  const feed = useQuery({
    queryKey: workFeedKey(client as WorkClient | null, null),
    queryFn: () => client!.getWorkFeed({ tz: zoneName(), limit: 60 }),
    enabled: Boolean(client) && on,
    refetchInterval: CLOUD_HOME_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  return on ? actionableCloud(feed.data?.cloud) : [];
}

function zoneName(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** Today's Cloud tasks strip: only rows that need the person or failed, at most 3; nothing when there are none. */
export function CloudTodayStrip(props: { items: OmniRushWorkCloudFeedItem[] | null | undefined; now?: number }) {
  const items = actionableCloud(props.items);
  if (!items.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={t("work.nav.cloud")} data-testid="work-today-cloud">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground"><Cloud aria-hidden className="size-3.5 text-muted-foreground" />{t("work.nav.cloud")}</h2>
        <button type="button" onClick={() => openCloud()} className="rounded text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" data-testid="work-today-cloud-all">{t("work.cloud.show_all_tasks")}</button>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background">
        {items.slice(0, TODAY_ROWS).map((item) => (
          <li key={item.run_id} className="flex items-center gap-3 px-3 py-2.5" data-cloud-feed={item.run_id}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">{item.title}</div>
              <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
                <StatusLine status={item.status} waiting={item.waiting_for} />
                {item.at ? <span className="shrink-0 text-muted-foreground">· {relativeTime(item.at, props.now)}</span> : null}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => openCloud({ task: item.task_id, run: item.run_id })} data-testid="work-today-cloud-open">
              {item.status === "waiting" ? waitingAction(item.waiting_for, false) : t("work.cloud.open_run")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
