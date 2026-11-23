// Cloud tasks (backend docs/work-cloud.md, design e2e/work-cloud-cu-2026-11-23.md): jobs that run on a cloud computer
// for the company. Everything here reads the Work state's `cloud` block, which the server sends only while staff, the
// company and the global switch all have it on for this person; without it no Cloud tasks surface renders anywhere.
// The words, list caps, query keys and pure helpers the views and tests share. Nothing here renders.
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";

import { currentLocale, t } from "@/i18n";
import type {
  OmniRushServerClient, OmniRushWorkCloud, OmniRushWorkCloudOutput, OmniRushWorkCloudRun, OmniRushWorkCloudSchedule,
  OmniRushWorkCloudStatus, OmniRushWorkCloudTask, OmniRushWorkCloudWaiting, OmniRushWorkOrgCloud,
} from "@/app/lib/omnirush-server";

import { workFailure } from "../work-mode";

export type CloudClient = Pick<OmniRushServerClient,
  | "listWorkCloudTasks" | "createWorkCloudTask" | "getWorkCloudTask" | "updateWorkCloudTask" | "deleteWorkCloudTask" | "runWorkCloudTask"
  | "listWorkCloudRuns" | "getWorkCloudRun" | "listWorkCloudSteps" | "getWorkCloudStepShot" | "getWorkCloudFile"
  | "workCloudRunAction" | "handBackWorkCloudRun" | "sendWorkCloudCode" | "openWorkCloudLive"
  | "getWorkOrgCloud" | "setWorkOrgCloud" | "listWorkCloudSignins" | "addWorkCloudSignin" | "replaceWorkCloudSignin" | "removeWorkCloudSignin"
> & { baseUrl?: string };

// ── caps: no list runs on without a Show more ────────────────────────────────────────────────────────────────────────

/** Task rows before "Show more". */
export const TASK_ROWS = 8;
/** Records, steps and earlier runs a run view shows before "Show all". */
export const RECORD_ROWS = 5;
export const STEP_ROWS = 8;
export const RUN_ROWS = 5;
/** Rows the Today strip shows at most (Show all goes to the page). */
export const TODAY_ROWS = 3;
/** Company sites and saved sign-ins before "Show more". */
export const HOST_ROWS = 8;
export const SIGNIN_ROWS = 8;
/** A company lists at most this many sites. */
export const MAX_HOSTS = 20;
/** A run that is still going is read again this often; the list while one of its runs is open. */
export const RUN_POLL_MS = 3_000;
export const LIST_POLL_MS = 15_000;

// ── the capability block ─────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** Cloud tasks for this person from the Work state; null (absent, malformed, or Work off) hides every surface. */
export function workCloud(state: unknown): OmniRushWorkCloud | null {
  if (!isRecord(state) || state.enabled !== true || !isRecord(state.cloud) || state.cloud.on !== true) return null;
  const raw = state.cloud;
  const limits = isRecord(raw.limits) ? raw.limits : {};
  return { on: true, create: raw.create === true, admin: raw.admin === true, live: raw.live === true, vault: raw.vault === true, limits: { desktops: count(limits.desktops), minutes_left: count(limits.minutes_left) } };
}

// ── query keys and reads ────────────────────────────────────────────────────────────────────────────────────────────

const base = (client: { baseUrl?: string } | null) => client?.baseUrl?.trim() || "default";
/** Every Cloud tasks read starts with this, so one invalidation refreshes them all. */
export const CLOUD_KEY = "omnirush-work-cloud";
export type TaskFilter = "all" | "scheduled" | "needs_you" | "failed";
export const cloudTasksKey = (client: CloudClient | null, filter: TaskFilter, q: string) => [CLOUD_KEY, base(client), "tasks", filter, q];
export const cloudRunKey = (client: CloudClient | null, id: string) => [CLOUD_KEY, base(client), "run", id];
export const cloudRunsKey = (client: CloudClient | null, taskId: string) => [CLOUD_KEY, base(client), "runs", taskId];
export const cloudStepsKey = (client: CloudClient | null, id: string) => [CLOUD_KEY, base(client), "steps", id];
export const cloudWaitingKey = (client: CloudClient | null) => [CLOUD_KEY, base(client), "waiting"];
export const orgCloudKey = (client: CloudClient | null) => [CLOUD_KEY, base(client), "org"];
export const cloudSigninsKey = (client: CloudClient | null) => [CLOUD_KEY, base(client), "signins"];

export const isOpen = (status: OmniRushWorkCloudStatus | null | undefined) => status === "queued" || status === "starting" || status === "running" || status === "waiting";

/** One run, read again every few seconds while it is going. */
export function useCloudRun(client: CloudClient | null, id: string | null) {
  return useQuery<OmniRushWorkCloudRun>({
    queryKey: cloudRunKey(client, id ?? ""),
    queryFn: () => client!.getWorkCloudRun(id!),
    enabled: Boolean(client && id),
    retry: false,
    refetchInterval: (query) => (isOpen(query.state.data?.status) ? RUN_POLL_MS : false),
  });
}

/** Runs waiting for someone (the sidebar's count); only while Cloud tasks are on. */
export function useCloudWaiting(client: CloudClient | null, on: boolean) {
  return useQuery({
    queryKey: cloudWaitingKey(client),
    queryFn: () => client!.listWorkCloudRuns({ status: "waiting", limit: 20 }),
    enabled: Boolean(client) && on,
    retry: false,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** The company's settings (members read). */
export function useOrgCloud(client: CloudClient | null, enabled: boolean) {
  return useQuery<OmniRushWorkOrgCloud>({ queryKey: orgCloudKey(client), queryFn: () => client!.getWorkOrgCloud(), enabled: Boolean(client) && enabled, retry: false });
}

/** The saved sign-ins (labels and sites only); a 403 vault_off reads as none. */
export function useCloudSignins(client: CloudClient | null, enabled: boolean) {
  return useQuery({ queryKey: cloudSigninsKey(client), queryFn: () => client!.listWorkCloudSignins(), enabled: Boolean(client) && enabled, retry: false });
}

// ── the app's way to a task or run (chat card, Today, notifications) ────────────────────────────────────────────────

export const WORK_CLOUD_OPEN_EVENT = "omnirush:work-cloud-open";
export type CloudOpen = { task?: string | null; run?: string | null };
/** Opens Work > Cloud tasks at a task or run (the session route listens). */
export function openCloud(target: CloudOpen = {}): void {
  window.dispatchEvent(new CustomEvent<CloudOpen>(WORK_CLOUD_OPEN_EVENT, { detail: target }));
}
/** The page's query for a target: `?task=` and `?run=`. */
export function cloudSearch(target: CloudOpen): string {
  const params = new URLSearchParams();
  if (target.task) params.set("task", target.task);
  if (target.run) params.set("run", target.run);
  return params.size ? `?${params}` : "";
}

/** The client the chat card reads runs with: set by the session route while Cloud tasks are on, null otherwise. */
export const useCloudClientStore = create<{ client: CloudClient | null; live: boolean; setClient: (client: CloudClient | null, live: boolean) => void }>()((set) => ({
  client: null,
  live: false,
  setClient: (client, live) => set({ client, live }),
}));

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Monday" for 0 to "Sunday" for 6, in the app's language (1 Jan 2024 was a Monday). */
export function weekdayName(index: number, style: "long" | "short" = "long"): string {
  const day = new Date(2024, 0, 1 + Math.max(0, Math.min(6, index)));
  try { return day.toLocaleDateString(currentLocale(), { weekday: style }); } catch { return day.toLocaleDateString(undefined, { weekday: style }); }
}

export function deviceZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** "Every Monday at 08:00", "Every day at 07:30", "Runs when asked"; the zone only when it is not this computer's. */
export function scheduleText(schedule: OmniRushWorkCloudSchedule | null | undefined, zone = deviceZone()): string {
  if (!schedule) return t("work.cloud.when_asked");
  const at = schedule.at;
  const text = schedule.every === "day" ? t("work.cloud.every_day", { at })
    : schedule.every === "week" ? t("work.cloud.every_week", { day: weekdayName(schedule.weekday ?? 0), at })
      : schedule.every === "month" ? t("work.cloud.every_month", { day: schedule.day ?? 1, at })
        : t("work.cloud.once_at", { at });
  return schedule.tz && schedule.tz !== zone ? `${text} (${schedule.tz.replace(/_/g, " ")})` : text;
}

/** Where a run stands, in words: "Running, step 6", "Waiting for a sign-in code", "Done". */
export function statusText(run: { status: OmniRushWorkCloudStatus; waiting_for?: OmniRushWorkCloudWaiting | null; steps?: number | null }): string {
  if (run.status === "running") return run.steps ? t("work.cloud.status_running_step", { n: run.steps }) : t("work.cloud.status_running");
  if (run.status === "waiting") return waitingText(run.waiting_for);
  const words: Record<Exclude<OmniRushWorkCloudStatus, "running" | "waiting">, string> = {
    queued: t("work.cloud.status_queued"),
    starting: t("work.cloud.status_starting"),
    done: t("work.cloud.status_done"),
    failed: t("work.cloud.status_failed"),
    stopped: t("work.cloud.status_stopped"),
    limit: t("work.cloud.status_limit"),
    timed_out: t("work.cloud.status_timed_out"),
  };
  return words[run.status] ?? run.status;
}

export function waitingText(waiting: OmniRushWorkCloudWaiting | null | undefined): string {
  const words: Record<OmniRushWorkCloudWaiting, string> = {
    signin: t("work.cloud.wait_signin"),
    code: t("work.cloud.wait_code"),
    captcha: t("work.cloud.wait_captcha"),
    approval: t("work.cloud.wait_approval"),
    decision: t("work.cloud.wait_decision"),
    takeover: t("work.cloud.wait_takeover"),
  };
  return (waiting && words[waiting]) || t("work.cloud.wait_you");
}

/** The one thing a waiting run asks for, as its row's button. */
export function waitingAction(waiting: OmniRushWorkCloudWaiting | null | undefined, live: boolean): string {
  if (waiting === "code") return t("work.cloud.enter_code");
  if (waiting === "approval") return t("work.cloud.review");
  return live && waiting ? t("work.cloud.open_live") : t("work.cloud.open");
}

export type Tone = "waiting" | "running" | "ok" | "error" | "off";
export function statusTone(status: OmniRushWorkCloudStatus | null | undefined): Tone {
  if (status === "waiting") return "waiting";
  if (status === "queued" || status === "starting" || status === "running") return "running";
  if (status === "done") return "ok";
  if (status === "failed" || status === "limit" || status === "timed_out") return "error";
  return "off";
}
/** Dots and text per tone; text colours pass AA on the page in light and dark. */
export const TONE_DOT: Record<Tone, string> = { waiting: "bg-amber-9", running: "bg-blue-9", ok: "bg-green-9", error: "bg-red-9", off: "bg-muted-foreground/50" };
/** Amber words: step 11 is a hair under AA on the light page, so it is mixed a little darker there. */
export const WAIT_TEXT = "text-[color-mix(in_oklab,var(--amber-11)_84%,black)] dark:text-amber-11";
export const TONE_TEXT: Record<Tone, string> = { waiting: WAIT_TEXT, running: "text-foreground", ok: "text-muted-foreground", error: "text-red-11", off: "text-muted-foreground" };

/** Why a run ended, in words; a code this app does not know shows the server's words when they are words. */
export function runErrorText(error: { code: string; message?: string | null } | null | undefined): string | null {
  if (!error) return null;
  const words: Record<string, string> = {
    desktop_lost: t("work.cloud.err_desktop_lost"),
    wrong_model: t("work.cloud.err_wrong_model"),
    site_unreachable: t("work.cloud.err_site_unreachable"),
    model_error: t("work.cloud.err_model_error"),
    step_limit: t("work.cloud.err_step_limit"),
    time_limit: t("work.cloud.err_time_limit"),
    token_limit: t("work.cloud.err_token_limit"),
    limit_month: t("work.cloud.err_limit_month"),
    daily_grant_exhausted: t("work.cloud.err_daily_grant"),
    cloud_off: t("work.cloud.err_cloud_off"),
    member_left: t("work.cloud.err_member_left"),
    denied: t("work.cloud.err_denied"),
    cancelled: t("work.cloud.err_cancelled"),
    worker_unavailable: t("work.cloud.err_worker_unavailable"),
  };
  const message = error.message?.trim() ?? "";
  return words[error.code] ?? (message && !/^[a-z]+(_[a-z]+)+$/.test(message) ? message.slice(0, 300) : t("work.cloud.err_other"));
}

/** A request's failure in words: Cloud tasks' own codes first, then Work's. */
export function cloudFailure(error: unknown): { text: string; retry: boolean } {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const words: Record<string, string> = {
    cloud_off: t("work.cloud.fail_cloud_off"),
    not_allowed: t("work.cloud.fail_not_allowed"),
    vault_off: t("work.cloud.fail_vault_off"),
    not_found: t("work.cloud.fail_not_found"),
    run_open: t("work.cloud.fail_run_open"),
    limit_month: t("work.cloud.fail_limit_month"),
    profile_busy: t("work.cloud.fail_profile_busy"),
    host_not_allowed: t("work.cloud.fail_host_not_allowed"),
    bad_schedule: t("work.cloud.fail_bad_schedule"),
    live_unavailable: t("work.cloud.fail_live_unavailable"),
  };
  return words[code] ? { text: words[code], retry: false } : workFailure(error);
}

/** "1 min 12 s", "45 s", "1 h 5 min" from the run's minutes (one decimal). */
export function durationText(minutes: number | null | undefined): string {
  const seconds = Math.max(0, Math.round((minutes ?? 0) * 60));
  if (seconds < 60) return t("work.cloud.dur_s", { s: seconds });
  const whole = Math.floor(seconds / 60);
  if (whole < 60) return seconds % 60 ? t("work.cloud.dur_min_s", { m: whole, s: seconds % 60 }) : t("work.cloud.dur_min", { m: whole });
  return t("work.cloud.dur_h_min", { h: Math.floor(whole / 60), m: whole % 60 });
}

export function outputLabel(kind: OmniRushWorkCloudOutput): string {
  const words: Record<OmniRushWorkCloudOutput, string> = {
    invoice: t("work.cloud.out_invoice"), order: t("work.cloud.out_order"), ticket: t("work.cloud.out_ticket"),
    row: t("work.cloud.out_row"), files: t("work.cloud.out_files"), answer: t("work.cloud.out_answer"),
  };
  return words[kind] ?? kind;
}

/** "20 invoices", "1 order", "3 rows": what a run saved. */
export function savedText(kind: OmniRushWorkCloudOutput, saved: number): string {
  const key = kind === "invoice" ? "work.cloud.n_invoices" : kind === "order" ? "work.cloud.n_orders" : kind === "ticket" ? "work.cloud.n_tickets" : "work.cloud.n_records";
  return t(key, { count: saved, n: saved.toLocaleString() });
}

// ── sites ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function hostOf(url: string | null | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

/** Whether `host` is on the company's sites (`portal.acme.com`, or `*.acme.com` for acme.com and every host under it).
 *  The server checks again; this only words a start page before it is sent. */
export function siteAllowed(host: string, sites: string[]): boolean {
  const name = host.toLowerCase();
  return Boolean(name) && sites.some((site) => (site.startsWith("*.") ? name === site.slice(2) || name.endsWith(site.slice(1)) : name === site));
}

/** A site as typed into the company's list: lower case, no scheme or path; null when it is not one. */
export function siteEntry(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  return /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text) ? text : null;
}

/** A start page as typed: https added when no scheme was given; null when it is not an https page. */
export function startUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { return null; }
  return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password ? url.href : null;
}

// ── lists ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tasks matching a search on their titles and sites. */
export function filterTasks(tasks: OmniRushWorkCloudTask[], q: string): OmniRushWorkCloudTask[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return tasks;
  return tasks.filter((task) => {
    const text = `${task.title} ${hostOf(task.start_url)}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Whether a task's last run waits for someone. */
export const needsYou = (task: Pick<OmniRushWorkCloudTask, "last_run">) => task.last_run?.status === "waiting";

/** The sites a run's browser was stopped from reaching, each once. */
export function blockedHosts(run: Pick<OmniRushWorkCloudRun, "flags"> | null | undefined): string[] {
  const hosts = (run?.flags ?? []).filter((flag) => flag.kind === "blocked_host").map((flag) => (flag.host ?? flag.text).trim().toLowerCase()).filter(Boolean);
  return [...new Set(hosts)];
}

/** What the person should know: instructions on the screen the agent ignored, and its own notes. */
export const runNotes = (run: Pick<OmniRushWorkCloudRun, "flags"> | null | undefined) => (run?.flags ?? []).filter((flag) => flag.kind !== "blocked_host" && flag.text.trim());

/** A saved record's key as people read it: `webtask:<task8>:INV-4471` reads as INV-4471. */
export function recordKey(sourceId: string): string {
  const parts = sourceId.split(":");
  return parts.length >= 3 && parts[0] === "webtask" ? parts.slice(2).join(":") : sourceId;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return t("work.cloud.size_b", { n: bytes });
  if (bytes < 1024 * 1024) return t("work.cloud.size_kb", { n: Math.max(1, Math.round(bytes / 1024)) });
  return t("work.cloud.size_mb", { n: (bytes / (1024 * 1024)).toFixed(1) });
}

/** "Mon 24 Nov 08:00": a run's start, short. */
export function runWhen(value: string | null | undefined): string {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const locale = currentLocale();
  return `${at.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} ${at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
}

/** A live page the frame may show: `/omnirush/work/live/v/` with the ticket in the fragment, https (or the local
 *  server's loopback in tests). The local server already refused any page off the account's server. */
export function liveUrlOk(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.password && !url.search
    && url.pathname === "/omnirush/work/live/v/" && /^#t=[A-Za-z0-9_.-]{16,2048}$/.test(url.hash);
}

/** The minutes line: "188 of 600 minutes used this month". */
export function usageText(usage: OmniRushWorkOrgCloud["usage"] | null | undefined): string | null {
  if (!usage || !usage.minutes_limit) return null;
  return t("work.cloud.usage_minutes", { used: Math.round(usage.minutes).toLocaleString(), limit: usage.minutes_limit.toLocaleString() });
}

// ── the chat card ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The engine's names for Cloud tasks' tools (`omnirush-work_work_cloud_*`). */
export const isCloudTool = (name: string | null | undefined) => Boolean(name?.startsWith("omnirush-work_work_cloud_"));

export type CloudCard =
  | { kind: "task"; taskId: string; title: string; schedule: OmniRushWorkCloudSchedule | null; runId: string | null }
  | { kind: "run"; runId: string; taskId: string | null; title: string | null; status: OmniRushWorkCloudStatus; waiting: OmniRushWorkCloudWaiting | null; saved: number | null };

function parsed(value: unknown, depth = 0): unknown {
  if (depth > 3) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") || text.length > 256 * 1024) return null;
    try { return parsed(JSON.parse(text), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = isRecord(item) && typeof item.text === "string" ? parsed(item.text, depth + 1) : null;
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (isRecord(value.structuredContent)) return value.structuredContent;
  if (Array.isArray(value.content)) return parsed(value.content, depth + 1);
  return value;
}

const STATUSES: readonly OmniRushWorkCloudStatus[] = ["queued", "starting", "running", "waiting", "done", "failed", "stopped", "limit", "timed_out"];
const WAITING: readonly OmniRushWorkCloudWaiting[] = ["signin", "code", "captcha", "approval", "decision", "takeover"];
const isStatus = (value: unknown): value is OmniRushWorkCloudStatus => STATUSES.some((status) => status === value);
const isWaiting = (value: unknown): value is OmniRushWorkCloudWaiting => WAITING.some((waiting) => waiting === value);
const SCHEDULE_EVERY = new Set(["once", "day", "week", "month"]);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);

function scheduleOf(value: unknown): OmniRushWorkCloudSchedule | null {
  if (!isRecord(value) || typeof value.every !== "string" || !SCHEDULE_EVERY.has(value.every) || typeof value.at !== "string") return null;
  const every = value.every === "day" || value.every === "week" || value.every === "month" ? value.every : "once";
  return { every, at: value.at, tz: typeof value.tz === "string" ? value.tz : deviceZone(), ...(typeof value.weekday === "number" ? { weekday: value.weekday } : {}), ...(typeof value.day === "number" ? { day: value.day } : {}) };
}

/** A Cloud tasks tool's answer as a card: a task made or scheduled (work_cloud_task), or one run (work_cloud_run,
 *  work_cloud_result). Lists and sign-ins get no card; nor does anything that does not read as one. */
export function cloudCard(tool: string, output: unknown): CloudCard | null {
  const name = tool.replace(/^omnirush-work_/, "");
  const data = parsed(output);
  if (!isRecord(data)) return null;
  if (name === "work_cloud_task") {
    const task = isRecord(data.task) ? data.task : null;
    const id = text(task?.id);
    if (!task || !id) return null;
    return { kind: "task", taskId: id, title: text(task.title) ?? "", schedule: scheduleOf(task.schedule), runId: text(data.run_id) };
  }
  if (name === "work_cloud_run" || name === "work_cloud_result") {
    const runId = text(data.run_id) ?? text(data.id);
    const status = isStatus(data.status) ? data.status : null;
    if (!runId || !status) return null;
    const waiting = isWaiting(data.waiting_for) ? data.waiting_for : null;
    const saved = Array.isArray(data.source_ids) ? data.source_ids.length : null;
    return { kind: "run", runId, taskId: text(data.task_id), title: text(data.title), status, waiting, saved };
  }
  return null;
}
