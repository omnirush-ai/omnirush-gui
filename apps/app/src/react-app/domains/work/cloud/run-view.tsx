/** @jsxImportSource react */
// One task and one of its runs (design 3.4, judge M21): where the run stands and the one thing it needs (a code, an
// approval, a person in the live view), then what it found: the answer, the records it saved (5, then Show all), its
// files, notes about on-screen instructions it ignored, sites it was stopped from opening (once, with Allow site for
// admins), and its steps (folded; a step opens its screenshot). Earlier runs are a short list under it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, FileText, Play, RotateCw, Square } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkCloud, OmniRushWorkCloudRun, OmniRushWorkCloudStatus, OmniRushWorkCloudTask, OmniRushWorkCloudWaiting } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { relativeTime } from "../work-mode";
import { Approval, StepShot } from "./approval";
import {
  blockedHosts, CLOUD_KEY, cloudFailure, cloudRunsKey, cloudStepsKey, durationText, fileSize, hostOf, isOpen, orgCloudKey,
  RECORD_ROWS, recordKey, RUN_ROWS, runErrorText, runNotes, runWhen, savedText, scheduleText, statusText, statusTone,
  STEP_ROWS, TONE_DOT, TONE_TEXT, useCloudRun, WAIT_TEXT, type CloudClient,
} from "./cloud-model";
import { CodeEntry } from "./code-entry";
import { LiveFrame } from "./live-frame";

/** A run's status as a dot and words (the dot is never the only cue). */
export function StatusLine(props: { status: OmniRushWorkCloudStatus; waiting?: OmniRushWorkCloudWaiting | null; steps?: number | null; className?: string }) {
  const tone = statusTone(props.status);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", TONE_TEXT[tone], props.className)} data-status={props.status}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], tone === "running" && "motion-safe:animate-pulse")} />
      <span className="truncate">{statusText({ status: props.status, waiting_for: props.waiting ?? null, steps: props.steps ?? null })}</span>
    </span>
  );
}

function Block(props: { label: string; children: React.ReactNode; testId?: string; action?: React.ReactNode }) {
  return (
    <section className="grid gap-x-6 gap-y-1.5 border-t border-border pt-4 @xl:grid-cols-[7.5rem_1fr]" aria-label={props.label} data-testid={props.testId}>
      <h3 className="text-[12px] font-medium text-muted-foreground @xl:pt-0.5">{props.label}</h3>
      <div className="flex min-w-0 flex-col gap-2 text-[13px] text-foreground">{props.children}{props.action}</div>
    </section>
  );
}

function MoreButton(props: { open: boolean; total: number; shown: number; onToggle: () => void; testId: string; all?: boolean }) {
  if (props.total <= props.shown && !props.open) return null;
  return (
    <button type="button" aria-expanded={props.open} onClick={props.onToggle} data-testid={props.testId} className="self-start rounded text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {props.open ? t("work.today.show_less") : props.all ? t("work.cloud.show_all", { count: props.total, n: props.total.toLocaleString() }) : t("work.today.show_more", { count: props.total - props.shown })}
    </button>
  );
}

function Steps(props: { client: CloudClient | null; run: OmniRushWorkCloudRun }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [shot, setShot] = useState<number | null>(null);
  const listId = useId();
  const steps = useQuery({
    queryKey: [...cloudStepsKey(props.client, props.run.id), props.run.steps],
    queryFn: () => props.client!.listWorkCloudSteps(props.run.id, { limit: 200 }),
    enabled: Boolean(props.client) && open,
    retry: false,
  });
  const items = steps.data ?? [];
  const shown = all ? items : items.slice(0, STEP_ROWS);
  if (!props.run.steps) return null;
  return (
    <Block label={t("work.cloud.steps")} testId="work-cloud-steps">
      <button type="button" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(!open)} className="flex items-center gap-1 self-start rounded text-[13px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" data-testid="work-cloud-steps-toggle">
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        {t("work.cloud.steps_count", { count: props.run.steps, n: props.run.steps.toLocaleString() })}
      </button>
      {open ? (
        steps.isLoading ? <Skeleton className="h-16 rounded-lg" /> : (
          <ol id={listId} className="flex flex-col divide-y divide-border rounded-lg border border-border" data-testid="work-cloud-step-list">
            {shown.map((step) => (
              <li key={step.n} className="flex flex-col gap-2 px-3 py-2" data-step={step.n}>
                <div className="flex items-start gap-3">
                  <span className="w-6 shrink-0 text-end text-[12px] tabular-nums text-muted-foreground">{step.n}</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[13px] text-foreground">{step.summary}</p>
                    {!step.ok && step.error ? <p className="text-[12px] text-red-11">{step.error}</p> : null}
                  </div>
                  {step.has_shot ? (
                    <Button size="xs" variant="ghost" aria-expanded={shot === step.n} onClick={() => setShot(shot === step.n ? null : step.n)} data-testid="work-cloud-step-shot">
                      {shot === step.n ? t("work.cloud.hide_screen") : t("work.cloud.show_screen")}
                    </Button>
                  ) : null}
                </div>
                {shot === step.n ? <StepShot client={props.client} runId={props.run.id} n={step.n} alt={t("work.cloud.step_shot_alt", { n: step.n })} className="ms-9 max-w-[calc(100%-2.25rem)]" /> : null}
              </li>
            ))}
          </ol>
        )
      ) : null}
      {open ? <MoreButton open={all} total={items.length} shown={STEP_ROWS} onToggle={() => setAll(!all)} testId="work-cloud-steps-more" all /> : null}
    </Block>
  );
}

export function RunView(props: {
  client: CloudClient | null;
  caps: OmniRushWorkCloud;
  task: OmniRushWorkCloudTask;
  /** The run to show; null shows the task's latest. */
  runId: string | null;
  writesPaused: boolean;
  onPickRun: (id: string) => void;
  onEdit: () => void;
  onRan: (runId: string) => void;
  onOpenRecord: (sourceId: string, list: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const task = props.task;
  const runId = props.runId ?? task.last_run?.id ?? null;
  const runQuery = useCloudRun(props.client, runId);
  const run = runQuery.data ?? null;
  const runs = useQuery({
    queryKey: cloudRunsKey(props.client, task.id),
    queryFn: () => props.client!.listWorkCloudRuns({ task_id: task.id, limit: 20 }),
    enabled: Boolean(props.client),
    retry: false,
  });
  const [allRecords, setAllRecords] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [CLOUD_KEY] });
  const onError = (reason: unknown) => toast.error(cloudFailure(reason).text);
  const runAgain = useMutation({
    mutationFn: () => props.client!.runWorkCloudTask(task.id),
    onSuccess: (answer) => { refresh(); props.onRan(answer.run_id); },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => props.client!.workCloudRunAction(id, "cancel"),
    onSuccess: () => { toast.success(t("work.cloud.cancelled")); refresh(); },
    onError,
  });
  const takeTask = useMutation({
    mutationFn: () => props.client!.updateWorkCloudTask(task.id, { owner: "me" }),
    onSuccess: () => { toast.success(t("work.cloud.task_taken")); refresh(); },
    onError,
  });
  const allowSite = useMutation({
    mutationFn: async (host: string) => {
      const org = await props.client!.getWorkOrgCloud();
      return props.client!.setWorkOrgCloud({ hosts: [...new Set([...org.hosts, host])] });
    },
    onSuccess: (org, host) => { queryClient.setQueryData(orgCloudKey(props.client), org); toast.success(t("work.cloud.site_allowed", { host })); },
    onError,
  });

  const open = isOpen(run?.status);
  const site = hostOf(task.start_url);
  const blocked = blockedHosts(run);
  const notes = runNotes(run);
  const sourceIds = run?.result?.records.source_ids ?? [];
  const records = allRecords ? sourceIds : sourceIds.slice(0, RECORD_ROWS);
  const files = run?.result?.files ?? [];
  const earlier = (runs.data?.items ?? []).filter((item) => item.id !== runId);
  const shownRuns = allRuns ? earlier : earlier.slice(0, RUN_ROWS);
  const error = runErrorText(run?.error);
  // An approval shows the screen it is about; the live view would only repeat it.
  const live = props.caps.live && Boolean(run?.live) && open && run?.waiting_for !== "approval";
  const download = async (name: string) => {
    if (!run) return;
    try {
      const file = await props.client!.getWorkCloudFile(run.id, name);
      const url = URL.createObjectURL(new Blob([file.data], { type: file.contentType ?? "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (reason) { onError(reason); }
  };

  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-testid="work-cloud-run-view" data-run={runId ?? ""}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4 pt-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span>{scheduleText(task.schedule)}</span>
          {site ? <><span aria-hidden>·</span><span className="truncate">{site}</span></> : null}
          {task.paused ? <><span aria-hidden>·</span><span className={WAIT_TEXT}>{task.paused_reason || t("work.cloud.paused")}</span></> : null}
        </div>

        {task.paused && task.paused_reason && props.caps.admin ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-4 py-3" data-testid="work-cloud-take-task">
            <span className="text-[13px] text-muted-foreground">{t("work.cloud.take_task_hint")}</span>
            <Button size="sm" variant="outline" disabled={takeTask.isPending} onClick={() => takeTask.mutate()}>{t("work.cloud.take_task")}</Button>
          </div>
        ) : null}

        {!runId ? (
          <p className="text-[13px] text-muted-foreground" data-testid="work-cloud-never-run">{t("work.cloud.never_run_body")}</p>
        ) : runQuery.isLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true"><Skeleton className="h-5 w-48 rounded-md" /><Skeleton className="h-24 rounded-xl" /></div>
        ) : runQuery.error || !run ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-3" data-testid="work-cloud-run-error">
            <span className="text-[13px] text-muted-foreground">{cloudFailure(runQuery.error).text}</span>
            <Button size="sm" variant="outline" onClick={() => void runQuery.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-[13px] text-muted-foreground">{runWhen(run.started_at)}</span>
              <span className="flex items-center gap-2 text-[13px]" data-testid="work-cloud-run-status">
                <StatusLine status={run.status} waiting={run.waiting_for} steps={open ? run.steps : null} className="font-medium" />
                {!open || run.minutes ? <span className="text-muted-foreground">· {durationText(run.minutes)}</span> : null}
                {!open && run.steps ? <span className="text-muted-foreground">· {t("work.cloud.steps_count", { count: run.steps, n: run.steps.toLocaleString() })}</span> : null}
              </span>
            </div>

            {run.status === "waiting" && run.waiting_for === "code" ? <CodeEntry client={props.client} run={run} site={site || task.title} autoFocus /> : null}
            {run.status === "waiting" && run.waiting_for === "approval" ? <Approval client={props.client} run={run} writesPaused={props.writesPaused} /> : null}
            {live ? <LiveFrame client={props.client} run={run} canControl /> : null}
            {!live && run.status === "waiting" && (run.waiting_for === "signin" || run.waiting_for === "captcha" || run.waiting_for === "decision") ? (
              <p className="rounded-xl border border-amber-6 bg-amber-2 px-4 py-3 text-[13px] text-amber-12" data-testid="work-cloud-needs-live">{t("work.cloud.needs_live")}</p>
            ) : null}
            {error ? <p className="rounded-xl border border-red-6 bg-red-2 px-4 py-3 text-[13px] text-red-11" role="status" data-testid="work-cloud-run-failed">{error}</p> : null}

            {run.result?.answer ? (
              <Block label={t("work.cloud.result")} testId="work-cloud-result">
                <p className="whitespace-pre-wrap break-words leading-[1.55]">{run.result.answer}</p>
              </Block>
            ) : null}

            {sourceIds.length ? (
              <Block label={t("work.cloud.records")} testId="work-cloud-records">
                <p className="text-muted-foreground">
                  {savedText(task.output.kind, run.result?.records.saved ?? sourceIds.length)}
                  {run.result?.records.skipped ? ` · ${t("work.cloud.skipped", { count: run.result.records.skipped, n: run.result.records.skipped })}` : ""}
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {records.map((id) => (
                    <li key={id}>
                      <button type="button" onClick={() => props.onOpenRecord(id, sourceIds)} title={id} className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring" data-cloud-record={id}>
                        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{recordKey(id)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <MoreButton open={allRecords} total={sourceIds.length} shown={RECORD_ROWS} onToggle={() => setAllRecords(!allRecords)} testId="work-cloud-records-more" all />
              </Block>
            ) : null}

            {files.length ? (
              <Block label={t("work.cloud.files")} testId="work-cloud-files">
                <ul className="flex flex-col gap-1">
                  {files.slice(0, RECORD_ROWS).map((file) => (
                    <li key={file.name} className="flex items-center gap-2">
                      <button type="button" onClick={() => void download(file.name)} className="flex min-w-0 items-center gap-1.5 rounded text-start text-[13px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" data-cloud-file={file.name}>
                        <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{file.name}</span>
                      </button>
                      <span className="shrink-0 text-[12px] text-muted-foreground">{fileSize(file.bytes)}</span>
                    </li>
                  ))}
                </ul>
                {files.length > RECORD_ROWS ? <p className="text-[12px] text-muted-foreground">{t("work.cloud.more_files", { count: files.length - RECORD_ROWS })}</p> : null}
              </Block>
            ) : null}

            {notes.length ? (
              <Block label={t("work.cloud.notes")} testId="work-cloud-notes">
                <ul className="flex flex-col gap-1.5">
                  {notes.slice(0, RECORD_ROWS).map((flag, index) => (
                    <li key={`${flag.kind}-${index}`} className={cn("leading-[1.5]", flag.kind === "ignored_instruction" ? WAIT_TEXT : "text-foreground")} data-cloud-flag={flag.kind}>{flag.text}</li>
                  ))}
                </ul>
              </Block>
            ) : null}

            {blocked.length ? (
              <Block label={t("work.cloud.blocked")} testId="work-cloud-blocked">
                <ul className="flex flex-col gap-1.5">
                  {blocked.map((host) => (
                    <li key={host} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-blocked-host={host}>
                      <span className="text-muted-foreground">{t("work.cloud.blocked_line", { host })}</span>
                      {props.caps.admin ? (
                        <Button size="xs" variant="outline" disabled={allowSite.isPending} onClick={() => allowSite.mutate(host)} data-testid="work-cloud-allow-site">{t("work.cloud.allow_site")}</Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {!props.caps.admin ? <p className="text-[12px] text-muted-foreground">{t("work.cloud.blocked_ask_admin")}</p> : null}
              </Block>
            ) : null}

            <Steps client={props.client} run={run} />
          </>
        )}

        {earlier.length ? (
          <Block label={t("work.cloud.earlier_runs")} testId="work-cloud-earlier">
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {shownRuns.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => props.onPickRun(item.id)} className="flex w-full items-center gap-3 px-3 py-2 text-start outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-cloud-run={item.id}>
                    <StatusLine status={item.status} waiting={item.waiting_for} className="min-w-0 flex-1 text-[13px]" />
                    <span className="shrink-0 text-[12px] text-muted-foreground">{runWhen(item.started_at) || relativeTime(item.ended_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <MoreButton open={allRuns} total={earlier.length} shown={RUN_ROWS} onToggle={() => setAllRuns(!allRuns)} testId="work-cloud-runs-more" />
          </Block>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3" data-testid="work-cloud-run-actions">
        {open && run ? (
          <Button variant="outline" size="sm" className="text-red-11" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)} data-testid="work-cloud-cancel"><Square className="size-3.5" />{t("work.cloud.cancel_run")}</Button>
        ) : (
          <Button size="sm" disabled={runAgain.isPending || task.paused} onClick={() => runAgain.mutate()} data-testid="work-cloud-run-again"><Play className="size-3.5" />{runId ? t("work.cloud.run_again") : t("work.cloud.run_now")}</Button>
        )}
        <Button variant="outline" size="sm" onClick={props.onEdit} data-testid="work-cloud-edit">{t("work.cloud.edit_task")}</Button>
      </div>
    </div>
  );
}
