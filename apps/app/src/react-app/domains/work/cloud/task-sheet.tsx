/** @jsxImportSource react */
// New task and Edit task (design 3.3): one column. A title, what to do in plain words, the start page (on the
// company's sites, checked as it is typed), how it signs in, what it saves, when it runs and whether it may change
// anything on the site. "Test run now" saves and starts it at once; Save only saves.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import type { OmniRushWorkCloud, OmniRushWorkCloudOutput, OmniRushWorkCloudSignin, OmniRushWorkCloudTask, OmniRushWorkCloudTaskInput } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

import { CLOUD_KEY, cloudFailure, deviceZone, hostOf, outputLabel, siteAllowed, startUrl, WAIT_TEXT, weekdayName, type CloudClient } from "./cloud-model";

/** A row of buttons that act as one choice (arrow keys move it, like any radio group). */
export function Segmented<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string; labelId?: string; disabled?: boolean; testId?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + props.options.length) % props.options.length;
    props.onChange(props.options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" {...(props.labelId ? { "aria-labelledby": props.labelId } : { "aria-label": props.label })} className="flex flex-wrap items-center gap-0.5 self-start rounded-lg bg-muted p-0.5" data-testid={props.testId}>
      {props.options.map((option, index) => {
        const on = option.value === props.value;
        return (
          <button
            key={String(option.value)}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            data-option={String(option.value)}
            className={cn("h-7 rounded-md px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60", on ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-gray-5" : "text-muted-foreground hover:text-foreground")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

type Every = "asked" | "day" | "week" | "month";
export type TaskDraft = {
  title: string; instructions: string; start: string; signin: string; output: OmniRushWorkCloudOutput;
  every: Every; at: string; weekday: number; day: number; write: "read" | "ask"; paused: boolean;
};

export function draftOf(task: OmniRushWorkCloudTask | null | undefined): TaskDraft {
  const schedule = task?.schedule ?? null;
  return {
    title: task?.title ?? "",
    instructions: task?.instructions ?? "",
    start: task?.start_url ?? "",
    signin: task?.signin_mode === "saved" && task.signin_id ? `saved:${task.signin_id}` : task?.signin_mode ?? "none",
    output: task?.output.kind ?? "row",
    every: !schedule || schedule.every === "once" ? "asked" : schedule.every,
    at: schedule?.at ?? "08:00",
    weekday: schedule?.weekday ?? 0,
    day: schedule?.day ?? 1,
    write: task?.write_mode ?? "read",
    paused: task?.paused ?? false,
  };
}

/** The task as the server takes it (the zone is this computer's). */
export function taskInput(draft: TaskDraft, zone = deviceZone()): OmniRushWorkCloudTaskInput {
  const saved = draft.signin.startsWith("saved:") ? draft.signin.slice(6) : null;
  return {
    title: draft.title.trim(),
    instructions: draft.instructions.trim(),
    start_url: startUrl(draft.start) ?? draft.start.trim(),
    signin_mode: saved ? "saved" : draft.signin === "person" ? "person" : "none",
    signin_id: saved,
    output: { kind: draft.output },
    write_mode: draft.write,
    schedule: draft.every === "asked" ? null : {
      every: draft.every, at: draft.at, tz: zone,
      ...(draft.every === "week" ? { weekday: draft.weekday } : {}),
      ...(draft.every === "month" ? { day: draft.day } : {}),
    },
  };
}

/** Instructions that look like they carry a password. */
export const looksLikePassword = (text: string) => /\b(?:password|passwd|pwd|passcode|pin)\b\s*(?:is\s*)?[:=]\s*\S+/i.test(text);

/** What is wrong with the start page, in words; null when it may be sent. */
export function startProblem(value: string, sites: string[], admin: boolean): string | null {
  if (!value.trim()) return null;
  const url = startUrl(value);
  if (!url) return t("work.cloud.start_bad");
  const host = hostOf(url);
  if (!sites.length) return admin ? t("work.cloud.start_no_sites_admin") : t("work.cloud.start_no_sites");
  if (!siteAllowed(host, sites)) return admin ? t("work.cloud.start_off_list_admin", { host }) : t("work.cloud.start_off_list", { host });
  return null;
}

function Field(props: { label: string; htmlFor?: string; labelId?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {props.htmlFor ? <label htmlFor={props.htmlFor} className="text-[13px] font-medium text-foreground">{props.label}</label> : <span id={props.labelId} className="text-[13px] font-medium text-foreground">{props.label}</span>}
      {props.children}
      {props.error ? <p role="alert" className="text-[12px] text-red-11">{props.error}</p> : props.hint ? <p className="text-[12px] text-muted-foreground">{props.hint}</p> : null}
    </div>
  );
}

export function TaskSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: CloudClient | null;
  caps: OmniRushWorkCloud;
  /** Edit this task; null makes a new one. */
  task: OmniRushWorkCloudTask | null;
  /** The company's sites (start pages must be on them). */
  sites: string[];
  signins: OmniRushWorkCloudSignin[];
  onSaved: (task: OmniRushWorkCloudTask, runId: string | null) => void;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const ids = { title: useId(), what: useId(), start: useId(), signin: useId(), output: useId(), when: useId(), write: useId(), paused: useId() };
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf(props.task));
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (props.open) { setDraft(draftOf(props.task)); setTried(false); } }, [props.open, props.task]);
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const editing = Boolean(props.task);
  const usable = props.signins.filter((signin) => signin.use === "everyone" || props.caps.admin);
  const start = startProblem(draft.start, props.sites, props.caps.admin);
  const errors = {
    title: !draft.title.trim() ? t("work.cloud.title_needed") : null,
    instructions: !draft.instructions.trim() ? t("work.cloud.what_needed") : null,
    start: !draft.start.trim() ? t("work.cloud.start_needed") : start,
  };
  const valid = !errors.title && !errors.instructions && !errors.start;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [CLOUD_KEY] });
  const save = useMutation({
    mutationFn: async (run: boolean) => {
      const input = taskInput(draft);
      const task = props.task
        ? await props.client!.updateWorkCloudTask(props.task.id, { ...input, ...(props.task.schedule || input.schedule ? { paused: draft.paused } : {}) })
        : await props.client!.createWorkCloudTask(input);
      const started = run ? await props.client!.runWorkCloudTask(task.id) : null;
      return { task, runId: started?.run_id ?? null };
    },
    onSuccess: ({ task, runId }) => {
      refresh();
      toast.success(runId ? t("work.cloud.started") : t("work.cloud.saved"));
      props.onSaved(task, runId);
    },
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  const remove = useMutation({
    mutationFn: () => props.client!.deleteWorkCloudTask(props.task!.id),
    onSuccess: () => { refresh(); toast.success(t("work.cloud.deleted")); props.onDeleted?.(); },
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  const submit = (run: boolean) => {
    setTried(true);
    if (!valid || save.isPending) return;
    save.mutate(run);
  };
  const signinItems = [
    { value: "none", label: t("work.cloud.signin_none") },
    ...(props.caps.live ? [{ value: "person", label: t("work.cloud.signin_person") }] : []),
    ...usable.map((signin) => ({ value: `saved:${signin.id}`, label: t("work.cloud.signin_saved", { label: signin.label }) })),
  ];
  // A saved sign-in this person may no longer use still reads as what the task has.
  if (draft.signin.startsWith("saved:") && !signinItems.some((item) => item.value === draft.signin)) signinItems.push({ value: draft.signin, label: t("work.cloud.signin_unavailable") });
  const outputs: OmniRushWorkCloudOutput[] = ["invoice", "order", "ticket", "row", "files", "answer"];
  const days = Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));
  const show = (error: string | null) => (tried ? error : null);
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="gap-0 p-0 data-[side=right]:w-[560px] data-[side=right]:max-w-[94vw] data-[side=right]:sm:max-w-[94vw]" data-testid="work-cloud-sheet">
        <SheetHeader className="border-b border-border px-5 pb-4 pe-14 pt-5">
          <SheetTitle className="text-base font-semibold">{editing ? t("work.cloud.edit_title") : t("work.cloud.new_title")}</SheetTitle>
          <SheetDescription className="text-[13px]">{t("work.cloud.sheet_body")}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => { event.preventDefault(); submit(!editing); }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            <Field label={t("work.cloud.field_title")} htmlFor={ids.title} error={show(errors.title)}>
              <Input id={ids.title} autoFocus maxLength={200} value={draft.title} placeholder={t("work.cloud.title_placeholder")} onChange={(event) => set("title", event.target.value)} aria-invalid={show(errors.title) ? true : undefined} data-testid="work-cloud-field-title" />
            </Field>
            <Field
              label={t("work.cloud.field_what")}
              htmlFor={ids.what}
              error={show(errors.instructions)}
              hint={looksLikePassword(draft.instructions) ? <span className={WAIT_TEXT} data-testid="work-cloud-password-warning">{t("work.cloud.password_warning")}</span> : t("work.cloud.no_passwords")}
            >
              <Textarea
                id={ids.what}
                rows={5}
                maxLength={4000}
                value={draft.instructions}
                placeholder={t("work.cloud.what_placeholder")}
                onChange={(event) => set("instructions", event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(!editing); } }}
                className="min-h-28 text-[13px]"
                aria-invalid={show(errors.instructions) ? true : undefined}
                data-testid="work-cloud-field-what"
              />
            </Field>
            <Field label={t("work.cloud.field_start")} htmlFor={ids.start} error={draft.start.trim() ? errors.start : show(errors.start)} hint={t("work.cloud.start_hint")}>
              <Input id={ids.start} inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} value={draft.start} placeholder="https://portal.example.com" onChange={(event) => set("start", event.target.value)} aria-invalid={errors.start && draft.start.trim() ? true : undefined} data-testid="work-cloud-field-start" />
            </Field>
            <Field label={t("work.cloud.field_signin")} labelId={ids.signin} hint={props.caps.vault ? t("work.cloud.signin_hint_vault") : t("work.cloud.signin_hint")}>
              <Select value={draft.signin} items={signinItems} onValueChange={(value) => { if (value) set("signin", String(value)); }}>
                <SelectTrigger className="w-full" aria-labelledby={ids.signin} data-testid="work-cloud-field-signin"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{signinItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field label={t("work.cloud.field_output")} labelId={ids.output}>
              <Select value={draft.output} items={outputs.map((kind) => ({ value: kind, label: outputLabel(kind) }))} onValueChange={(value) => { const kind = outputs.find((item) => item === value); if (kind) set("output", kind); }}>
                <SelectTrigger className="w-full" aria-labelledby={ids.output} data-testid="work-cloud-field-output"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{outputs.map((kind) => <SelectItem key={kind} value={kind}>{outputLabel(kind)}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field label={t("work.cloud.field_when")} labelId={ids.when}>
              <Segmented<Every>
                label={t("work.cloud.field_when")}
                labelId={ids.when}
                value={draft.every}
                onChange={(every) => set("every", every)}
                options={[{ value: "asked", label: t("work.cloud.when_asked_short") }, { value: "day", label: t("work.cloud.when_day") }, { value: "week", label: t("work.cloud.when_week") }, { value: "month", label: t("work.cloud.when_month") }]}
                testId="work-cloud-field-when"
              />
              {draft.every !== "asked" ? (
                <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground" data-testid="work-cloud-when-detail">
                  {draft.every === "week" ? (
                    <Segmented<number> label={t("work.cloud.weekday")} value={draft.weekday} onChange={(weekday) => set("weekday", weekday)} options={Array.from({ length: 7 }, (_, index) => ({ value: index, label: weekdayName(index, "short") }))} testId="work-cloud-field-weekday" />
                  ) : null}
                  {draft.every === "month" ? (
                    <>
                      <span>{t("work.cloud.on_day")}</span>
                      <Select value={String(draft.day)} items={days} onValueChange={(value) => { if (value !== null) set("day", Number(value)); }}>
                        <SelectTrigger className="h-8 w-20" aria-label={t("work.cloud.day_of_month")}><SelectValue /></SelectTrigger>
                        <SelectContent><SelectGroup>{days.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                      </Select>
                    </>
                  ) : null}
                  <span>{t("work.cloud.at")}</span>
                  <Input type="time" value={draft.at} onChange={(event) => { if (/^\d{2}:\d{2}$/.test(event.target.value)) set("at", event.target.value); }} aria-label={t("work.cloud.time")} className="h-8 w-28" data-testid="work-cloud-field-time" />
                  <span className="text-[12px]">{deviceZone().replace(/_/g, " ")}</span>
                </div>
              ) : null}
            </Field>
            <Field label={t("work.cloud.field_write")} labelId={ids.write}>
              <div role="radiogroup" aria-labelledby={ids.write} className="flex flex-col gap-1.5" data-testid="work-cloud-field-write">
                {(["read", "ask"] as const).map((mode) => (
                  <label key={mode} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] transition-colors", draft.write === mode ? "border-foreground/40 bg-muted/50" : "border-border hover:bg-muted/30")}>
                    <input type="radio" name={ids.write} value={mode} checked={draft.write === mode} onChange={() => set("write", mode)} className="mt-0.5 accent-foreground" />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">{mode === "read" ? t("work.cloud.write_read") : t("work.cloud.write_ask")}</span>
                      <span className="text-[12px] text-muted-foreground">{mode === "read" ? t("work.cloud.write_read_hint") : t("work.cloud.write_ask_hint")}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
            {editing && (props.task?.schedule || draft.every !== "asked") ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                <label htmlFor={ids.paused} className="text-[13px] text-foreground">{t("work.cloud.pause_schedule")}</label>
                <Switch id={ids.paused} checked={draft.paused} onCheckedChange={(checked: boolean) => set("paused", checked)} data-testid="work-cloud-field-paused" />
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 border-t border-border px-5 py-3">
            <p className="text-[12px] text-muted-foreground">{t("work.cloud.sheet_footer")}</p>
            <div className="flex flex-wrap items-center gap-2">
              {editing ? (
                <>
                  <Button type="button" variant="ghost" size="sm" className="me-auto text-red-11" onClick={() => setConfirmDelete(true)} data-testid="work-cloud-delete">{t("work.cloud.delete_task")}</Button>
                  <Button type="submit" size="sm" disabled={save.isPending} data-testid="work-cloud-save">{save.isPending ? t("work.common.saving") : t("common.save")}</Button>
                </>
              ) : (
                <>
                  <Button type="button" variant="outline" size="sm" className="ms-auto" disabled={save.isPending} onClick={() => submit(false)} data-testid="work-cloud-save">{t("common.save")}</Button>
                  <Button type="submit" size="sm" disabled={save.isPending} data-testid="work-cloud-test-run">{save.isPending ? t("work.common.saving") : t("work.cloud.test_run")}</Button>
                </>
              )}
            </div>
          </div>
        </form>
        <ConfirmModal
          open={confirmDelete}
          title={t("work.cloud.delete_title", { title: props.task?.title ?? "" })}
          message={t("work.cloud.delete_body")}
          confirmLabel={t("work.cloud.delete_task")}
          cancelLabel={t("common.cancel")}
          variant="danger"
          onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
