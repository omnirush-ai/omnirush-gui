/** @jsxImportSource react */
// Work > Cloud tasks (design 3.2, judge M21): the company's jobs that run on a cloud computer. What needs the person
// comes first, then the tasks (8, then Show more), with a search on titles and sites and four filters. A row opens the
// task and its latest run beside the list (`?task=` and `?run=` in the address, so a chat card or Today opens it too);
// New task opens the sheet. Shown only while the Work state has `cloud`.
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCw, Search, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import type { OmniRushWorkCloud, OmniRushWorkCloudTask, OmniRushWorkCloudWaiting } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { relativeTime } from "../work-mode";
import { openItem } from "../viewer/records";
import {
  CLOUD_KEY, cloudFailure, cloudSearch, cloudTasksKey, filterTasks, hostOf, isOpen, LIST_POLL_MS, needsYou, scheduleText, statusText, TASK_ROWS,
  usageText, useCloudSignins, useCloudWaiting, useOrgCloud, WAIT_TEXT, waitingAction, waitingText, type CloudClient, type CloudOpen, type TaskFilter,
} from "./cloud-model";
import { RunView, StatusLine } from "./run-view";
import { Segmented, TaskSheet } from "./task-sheet";

/** A last run's summary, unless it only repeats where the run stands ("Running, step 6" beside "Running"). */
export function summaryShown(last: NonNullable<OmniRushWorkCloudTask["last_run"]>): boolean {
  const summary = last.summary?.trim().toLowerCase() ?? "";
  if (!summary || isOpen(last.status)) return false;
  const status = statusText({ status: last.status }).toLowerCase();
  return summary.split(/[\s,]+/)[0] !== status.split(/[\s,]+/)[0];
}

function TaskRow(props: { task: OmniRushWorkCloudTask; now: number; active: boolean; onOpen: () => void }) {
  const task = props.task;
  const site = hostOf(task.start_url);
  const last = task.last_run;
  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        aria-current={props.active ? "true" : undefined}
        aria-label={t("work.cloud.open_task", { title: task.title })}
        className={cn("grid w-full grid-cols-1 items-center gap-x-4 gap-y-0.5 px-4 py-3 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @2xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1.25fr)]", props.active && "bg-muted/60")}
        data-cloud-task={task.id}
      >
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-foreground">{task.title}</span>
          {site ? <span className="block truncate text-[13px] text-muted-foreground">{site}</span> : null}
        </span>
        <span className={cn("min-w-0 text-[12px] @2xl:line-clamp-2 @2xl:text-[13px]", task.paused ? WAIT_TEXT : "text-muted-foreground")}>
          {task.paused ? (task.paused_reason || t("work.cloud.paused")) : scheduleText(task.schedule)}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] @2xl:text-[13px]">
          {last ? (
            <>
              <StatusLine status={last.status} className="shrink-0" />
              {summaryShown(last) ? <span className="min-w-0 truncate text-muted-foreground"><span aria-hidden>· </span>{last.summary}</span> : null}
              {last.at ? <span className="ms-auto shrink-0 text-[12px] text-muted-foreground">{relativeTime(last.at, props.now)}</span> : null}
            </>
          ) : <span className="text-muted-foreground">{t("work.cloud.never_run")}</span>}
        </span>
      </button>
    </li>
  );
}

function NeedsYouRow(props: { task: OmniRushWorkCloudTask; waiting: OmniRushWorkCloudWaiting | null; live: boolean; now: number; onOpen: () => void }) {
  const task = props.task;
  const run = task.last_run!;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-cloud-needs={task.id}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">{task.title}</span>
        <span className={cn("flex items-center gap-1.5 text-[12px]", WAIT_TEXT)}>
          <span aria-hidden className="size-1.5 rounded-full bg-amber-9" />
          <span className="truncate">{props.waiting ? waitingText(props.waiting) : run.summary || waitingText(null)}</span>
          {run.at ? <span className="shrink-0 text-muted-foreground">· {relativeTime(run.at, props.now)}</span> : null}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={props.onOpen} data-testid="work-cloud-needs-open">{waitingAction(props.waiting, props.live)}</Button>
    </li>
  );
}

type PageProps = { client: CloudClient | null; caps: OmniRushWorkCloud; orgName?: string | null; writesPaused: boolean; openLink: (url: string) => void };

/** The shell's title and page for Work > Cloud tasks, or nothing (the shell keeps its own). */
export function cloudPageProps(props: PageProps | null): { primaryTitle?: string; primarySlot?: ReactNode } {
  return props ? { primaryTitle: t("work.nav.cloud"), primarySlot: <WorkCloudPage {...props} /> } : {};
}

export function WorkCloudPage(props: PageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const openTask = params.get("task");
  const openRun = params.get("run");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState<{ task: OmniRushWorkCloudTask | null } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  useEffect(() => setMore(false), [filter, q]);
  const tasks = useQuery({
    queryKey: cloudTasksKey(props.client, filter, q),
    queryFn: () => props.client!.listWorkCloudTasks({ filter, ...(q ? { q } : {}), limit: 50 }),
    enabled: Boolean(props.client),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: (query) => ((query.state.data?.items ?? []).some((task) => isOpen(task.last_run?.status)) ? LIST_POLL_MS : 60_000),
    refetchOnWindowFocus: true,
  });
  const org = useOrgCloud(props.client, true);
  // What each waiting run asks for (the sidebar reads the same list).
  const waiting = useCloudWaiting(props.client, true);
  const waitingFor = (task: OmniRushWorkCloudTask) => (waiting.data?.items ?? []).find((run) => run.id === task.last_run?.id)?.waiting_for ?? null;
  const signins = useCloudSignins(props.client, props.caps.vault);
  const open = (target: CloudOpen) => navigate(`${location.pathname}${cloudSearch(target)}`);
  const close = () => navigate(location.pathname, { replace: true });

  const items = filterTasks(tasks.data?.items ?? [], typed);
  const needs = filter === "all" ? items.filter(needsYou) : [];
  const rest = filter === "all" ? items.filter((task) => !needsYou(task)) : items;
  const capped = rest.length > TASK_ROWS;
  const shown = capped && !more ? rest.slice(0, TASK_ROWS) : rest;
  const needsCount = (tasks.data?.items ?? []).filter(needsYou).length;
  const picked = openTask ? (tasks.data?.items ?? []).find((task) => task.id === openTask) ?? null : null;
  // A task opened by its id (a chat card, Today) that the list does not hold: read on its own.
  const single = useQuery({
    queryKey: [CLOUD_KEY, props.client?.baseUrl ?? "default", "task", openTask ?? ""],
    queryFn: () => props.client!.getWorkCloudTask(openTask!),
    enabled: Boolean(props.client && openTask && !picked && tasks.isFetched),
    retry: false,
  });
  // A run opened on its own (`?run=` only): its task comes from the run.
  const lone = useQuery({
    queryKey: [CLOUD_KEY, props.client?.baseUrl ?? "default", "run", openRun ?? ""],
    queryFn: () => props.client!.getWorkCloudRun(openRun!),
    enabled: Boolean(props.client && openRun && !openTask),
    retry: false,
  });
  useEffect(() => {
    if (!openTask && lone.data?.task_id) navigate(`${location.pathname}${cloudSearch({ task: lone.data.task_id, run: openRun })}`, { replace: true });
  }, [lone.data?.task_id, openRun, openTask]);
  const task = picked ?? single.data ?? null;
  const failure = tasks.error && !tasks.data ? cloudFailure(tasks.error) : null;
  const usage = usageText(org.data?.usage);
  const now = Date.now();
  const filters: { value: TaskFilter; label: string }[] = [
    { value: "all", label: t("work.cloud.filter_all") },
    { value: "scheduled", label: t("work.cloud.filter_scheduled") },
    { value: "needs_you", label: needsCount ? t("work.cloud.filter_needs_you_n", { n: needsCount }) : t("work.cloud.filter_needs_you") },
    { value: "failed", label: t("work.cloud.filter_failed") },
  ];
  const company = props.orgName?.trim();

  return (
    <div className="h-full overflow-y-auto" data-testid="work-cloud">
      <div className="@container mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 pb-10 pt-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-foreground">{t("work.nav.cloud")}</h1>
            <p className="mt-1 max-w-[40rem] text-[13px] text-muted-foreground" data-testid="work-cloud-subtitle">
              {company ? t("work.cloud.subtitle_org", { org: company }) : t("work.cloud.subtitle")}
              {usage ? ` ${usage}` : ""}
            </p>
          </div>
          {props.caps.create ? (
            <Button size="sm" onClick={() => setSheet({ task: null })} data-testid="work-cloud-new"><Plus className="size-4" />{t("work.cloud.new_task")}</Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-[18rem]">
            <Search aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape" && typed) { event.preventDefault(); setTyped(""); } }}
              placeholder={t("work.cloud.search")}
              aria-label={t("work.cloud.search")}
              className="h-8 ps-8 pe-8 text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
              data-testid="work-cloud-search"
            />
            {typed ? (
              <button type="button" aria-label={t("work.cloud.clear_search")} onClick={() => setTyped("")} className="absolute end-1.5 top-1/2 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button>
            ) : null}
          </div>
          <Segmented<TaskFilter> label={t("work.cloud.filter")} value={filter} onChange={setFilter} options={filters} testId="work-cloud-filter" />
        </div>

        {tasks.isLoading ? (
          <div className="rounded-xl border border-border" aria-busy="true" data-testid="work-cloud-loading">
            {[0, 1, 2].map((index) => <div key={index} className="border-b border-border px-4 py-3.5 last:border-b-0"><Skeleton className="h-3.5 w-2/3 rounded-md" /></div>)}
          </div>
        ) : failure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-cloud-error">
            <span className="text-[13px] text-muted-foreground">{failure.text}</span>
            {failure.retry ? <Button variant="outline" size="sm" onClick={() => void tasks.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
          </div>
        ) : !items.length ? (
          <div className="flex flex-col gap-1 rounded-xl border border-dashed border-border px-5 py-6" data-testid="work-cloud-empty">
            <p className="text-[13px] font-medium text-foreground">{typed || filter !== "all" ? t("work.cloud.none_match") : t("work.cloud.none_yet")}</p>
            {typed || filter !== "all" ? null : <p className="max-w-[36rem] text-[13px] text-muted-foreground">{props.caps.create ? t("work.cloud.none_yet_body") : t("work.cloud.none_yet_member")}</p>}
          </div>
        ) : (
          <div className={cn("flex flex-col gap-5", tasks.isPlaceholderData && "opacity-60")}>
            {needs.length ? (
              <section className="flex flex-col gap-2" aria-label={t("work.today.needs_you")} data-testid="work-cloud-needs">
                <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                  {t("work.today.needs_you")}
                  <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">{needs.length}</span>
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-amber-6 bg-background">
                  {needs.slice(0, TASK_ROWS).map((item) => <NeedsYouRow key={item.id} task={item} waiting={waitingFor(item)} live={props.caps.live} now={now} onOpen={() => open({ task: item.id, run: item.last_run?.id })} />)}
                </ul>
              </section>
            ) : null}
            {rest.length ? (
              <section className="flex flex-col gap-2" aria-label={t("work.cloud.tasks")} data-testid="work-cloud-tasks">
                {needs.length ? <h2 className="text-[13px] font-semibold text-foreground">{t("work.cloud.tasks")}</h2> : null}
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background">
                  {shown.map((item) => <TaskRow key={item.id} task={item} now={now} active={item.id === openTask} onOpen={() => open({ task: item.id })} />)}
                </ul>
                {capped ? (
                  <button type="button" aria-expanded={more} onClick={() => setMore(!more)} data-testid="work-cloud-more" className="self-start rounded text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    {more ? t("work.today.show_less") : t("work.today.show_more", { count: rest.length - TASK_ROWS })}
                  </button>
                ) : null}
              </section>
            ) : null}
            {tasks.data?.next ? <p className="text-[12px] text-muted-foreground">{t("work.cloud.search_for_more")}</p> : null}
          </div>
        )}
      </div>

      <Sheet open={Boolean(openTask)} onOpenChange={(next) => { if (!next) close(); }}>
        <SheetContent className="gap-0 p-0 data-[side=right]:w-[680px] data-[side=right]:max-w-[94vw] data-[side=right]:sm:max-w-[94vw] min-[1440px]:data-[side=right]:w-[880px]" data-testid="work-cloud-run-sheet">
          {task ? (
            <>
              <SheetHeader className="px-5 pb-3 pe-14 pt-5">
                <SheetTitle className="text-base font-semibold">{task.title}</SheetTitle>
                <SheetDescription className="sr-only">{t("work.cloud.run_sheet_body")}</SheetDescription>
              </SheetHeader>
              <RunView
                key={task.id}
                client={props.client}
                caps={props.caps}
                task={task}
                runId={openRun}
                writesPaused={props.writesPaused}
                onPickRun={(run) => open({ task: task.id, run })}
                onRan={(run) => open({ task: task.id, run })}
                onEdit={() => setSheet({ task })}
                onOpenRecord={(sourceId, list) => {
                  close();
                  openItem({ sourceId, source: "webtask", kind: task.output.kind, title: null, url: null, list: list.map((id) => ({ sourceId: id, source: "webtask", kind: task.output.kind })) }, props.openLink);
                }}
              />
            </>
          ) : single.isError ? (
            <div className="px-5 py-6 text-[13px] text-muted-foreground" data-testid="work-cloud-task-missing">{cloudFailure(single.error).text}</div>
          ) : (
            <div className="flex flex-col gap-3 px-5 py-6" aria-busy="true"><Skeleton className="h-5 w-48 rounded-md" /><Skeleton className="h-32 rounded-xl" /></div>
          )}
        </SheetContent>
      </Sheet>

      <TaskSheet
        open={sheet !== null}
        onOpenChange={(next) => { if (!next) setSheet(null); }}
        client={props.client}
        caps={props.caps}
        task={sheet?.task ?? null}
        sites={org.data?.hosts ?? []}
        signins={signins.data?.items ?? []}
        onSaved={(saved, runId) => {
          setSheet(null);
          queryClient.setQueryData([CLOUD_KEY, props.client?.baseUrl ?? "default", "task", saved.id], saved);
          open({ task: saved.id, run: runId });
        }}
        onDeleted={() => { setSheet(null); close(); }}
      />
    </div>
  );
}
