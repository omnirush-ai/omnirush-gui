/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Briefcase, Calendar, ChevronDown, Code2, Copy, Info, Mail, MoreHorizontal, Plug, Plus, RotateCw, Settings2, Sparkles, Stethoscope, Unplug } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import type { OmniRushWorkConnector, OmniRushWorkCredentials, OmniRushWorkHealth, OmniRushWorkImport, OmniRushWorkImportKind, OmniRushWorkStart, OmniRushWorkStarter } from "@/app/lib/omnirush-server";
import type { WorkChatSyncSource, WorkChatSyncStatus, WorkTelegramLoginStep } from "@omnirush/types/desktop-ipc";
import { desktopBridge } from "@/app/lib/desktop";
import { useAccountStatusStore } from "@/app/lib/quality";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { isMacPlatform } from "@/app/utils";
import { cn } from "@/lib/utils";

import { useLocation, useNavigate } from "react-router";

import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { COMPOSER_BOTTOM, COMPOSER_GLIDE, COMPOSER_GUTTER, COMPOSER_WIDTH } from "@/react-app/domains/session/surface/composer/composer";

import {
  chatSyncProgress, connectorAccess, connectorChoicesTitle, isLinked, connectorLabel, connectorProgress, connectorsBackState, connectSettled, countLabel, coverageAdds, coverageCanAdd, coverageLine, healthFor, healthProblem, IMPORT_KINDS, isImportKind, isPausedByAdmin, localSourcesOff, relativeTime, setupLabel, signsInWithForm, useWorkCoverage, useWorkOrgConnectors, useWorkState, visibleConnectors, WORK_CONNECTORS_ROUTE,
  sourceErrorText, workChatToolsKey, workConnectorsKey, workCoverageKey, workFailure, workImportsKey, workStateKey, type AppMode, type SyncProgressView, type WorkClient,
} from "./work-mode";

import { connectorState } from "@/react-app/domains/session/sidebar/work-sidebar-nav";
import { ListMore, ListSearch, matchesQuery, StatusPill, useListCap, WORK_DESTRUCTIVE, type PillTone } from "./list-cap";
import { useWorkCatalog } from "./catalog";

// Connector marks live in brand-icon.tsx (one tile style for every Work list); re-exported for the pages that import them here.
export { BrandTile, ConnectorIcon } from "./brand-icon";
import { BrandTile, ConnectorIcon } from "./brand-icon";

/** The Code | Work switch at the top of the sidebar (Cmd/Ctrl+Shift+K). Shown only while Work is on for the account. */
export function WorkModeToggle(props: { mode: AppMode; onChange: (mode: AppMode) => void; shortcut: string }) {
  const option = (mode: AppMode, label: string, icon: ReactNode) => {
    const active = props.mode === mode;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        data-app-mode-option={mode}
        onClick={() => props.onChange(mode)}
        className={cn(
          "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] transition-colors [&_svg]:size-3.5",
          active
            ? "bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border dark:bg-gray-5"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        {label}
      </button>
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label={t("work.mode.label")}
      title={t("work.mode.switch", { shortcut: props.shortcut })}
      data-app-mode={props.mode}
      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 mac:titlebar-no-drag"
    >
      {option("code", t("work.mode.code"), <Code2 />)}
      {option("work", t("work.nav.work"), <Briefcase />)}
    </div>
  );
}

/** Whether a scroll area has content below its visible part (it is not scrolled to the end). */
function useRunsOnBelow(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) {
      setBelow(false);
      return;
    }
    const check = () => setBelow(element.scrollHeight - element.scrollTop - element.clientHeight > 1);
    check();
    element.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, [active, ref]);
  return below;
}

/** Work home: the Today view once a source is connected (or sample data is in), above the real chat composer (passed
 *  in, the same one the running Work chat uses) with up to three tailored starter chips from onboarding just above it.
 *  Before that, "What do you want to get done?" and the composer centred, the starters, checklist and connect button
 *  under them; a starter glides the composer into the chat's place. */
export function WorkHome(props: {
  composer: ReactNode;
  onStart: (prompt: string) => Promise<void>;
  busy?: boolean;
  message?: string | null;
  starters?: OmniRushWorkStarter[];
  checklist?: ReactNode;
  /** The Today view (work-today.tsx); null while nothing is connected. */
  today?: ReactNode;
  /** Sources still loading: keep the Today layout so the composer does not jump once they arrive. */
  pending?: boolean;
  onConnect?: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const busy = Boolean(props.busy) || starting;
  const start = async (prompt: string) => {
    if (busy) return;
    setStarting(true);
    try {
      await props.onStart(prompt);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t("work.home_start_failed"));
    } finally {
      setStarting(false);
    }
  };
  const feed = Boolean(props.today || props.pending);
  const feedRef = useRef<HTMLDivElement>(null);
  const feedRunsOn = useRunsOnBelow(feedRef, feed);
  const starters = (props.starters ?? []).slice(0, 3);
  const starterChips = starters.length ? (
    <div className={cn("flex flex-wrap gap-2", !feed && "justify-center")} data-testid="work-starters">
      {starters.map((starter) => (
        <button
          key={starter.title}
          type="button"
          data-work-starter={starter.title}
          title={starter.prompt}
          disabled={busy}
          onClick={() => void start(starter.prompt)}
          className="flex h-8 max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:border-foreground/25 hover:bg-muted disabled:opacity-60"
        >
          <Sparkles aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{starter.title}</span>
        </button>
      ))}
    </div>
  ) : null;
  const message = props.message ? <p className="text-center text-[12px] text-muted-foreground">{props.message}</p> : null;
  if (feed) {
    // The composer dock is its own solid surface below the feed (no fade over feed text): the feed scrolls in the room
    // above it, so every row can scroll fully clear of the dock however tall the chips and questions make it. A hairline
    // marks the edge while feed rows run on below it.
    return (
      <div className="flex h-full flex-col" data-testid="work-home">
        <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="work-home-feed">
          <div className={cn(COMPOSER_GUTTER, "pt-8 pb-10")}>
            <div className="mx-auto w-full max-w-[800px]" data-testid="work-home-column">{props.today}</div>
          </div>
        </div>
        <div
          className={cn("shrink-0 border-t bg-dls-surface transition-colors", feedRunsOn ? "border-border" : "border-transparent")}
          data-testid="work-home-dock"
          data-feed-below={feedRunsOn || undefined}
        >
          <div className={cn(COMPOSER_GUTTER, COMPOSER_BOTTOM, "mb-2 pt-3")}>
            <div className={cn(COMPOSER_WIDTH, "flex flex-col gap-2")}>
              {starterChips}
              {props.composer}
              {message}
            </div>
          </div>
        </div>
      </div>
    );
  }
  // Same layout as the Code home (session-empty-hero.tsx): two equal spacers centre the heading and composer.
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="work-home">
      <div className="min-h-8 grow basis-0" />
      <div className={cn(COMPOSER_GUTTER, COMPOSER_BOTTOM, "mb-2 shrink-0 pt-1")}>
        <div className={cn("mx-auto flex w-full flex-col gap-2", COMPOSER_GLIDE, starting ? "max-w-[800px]" : "max-w-[640px]")} data-testid="work-home-column">
          <div className={cn("mb-2 space-y-1.5 text-center", COMPOSER_GLIDE, starting && "opacity-0")}>
            <h1 className="text-balance text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">{t("work.home_title")}</h1>
            <p className="text-[13px] text-muted-foreground">{t("work.home_subtitle")}</p>
          </div>
          {props.composer}
          {message}
        </div>
      </div>
      <div className={cn(COMPOSER_GUTTER, "basis-0", COMPOSER_GLIDE, starting ? "grow-0" : "grow")}>
        {starting ? null : (
          <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-4 pb-8">
            {starterChips}
            {props.checklist ? <div className="w-full max-w-[420px]">{props.checklist}</div> : null}
            {props.onConnect ? (
              <Button variant="outline" size="sm" onClick={props.onConnect} data-testid="work-home-connect"><Plug className="size-4" />{t("work.home_connect")}</Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabel(status: OmniRushWorkConnector["status"]): string {
  if (status === "connected") return t("work.connectors.status_connected");
  if (status === "syncing") return t("work.connectors.status_syncing");
  if (status === "error") return t("work.today.dot_attention");
  if (status === "disconnected") return t("work.error.not_connected");
  if (status === "paused_by_admin") return t("work.connectors.status_paused");
  return t("work.connectors.status_unavailable");
}

export const CONNECT_POLL_MS = 2_000;
// Sign-in with a second factor or an admin prompt often takes over a minute.
export const CONNECT_TIMEOUT_MS = 180_000;
// While a source imports its history, its bar moves with this poll.
export const PROGRESS_POLL_MS = 5_000;
// The chat sync's status (an IPC call) while a read runs, and otherwise.
export const CHAT_SYNC_POLL_MS = 1_500;
const CHAT_SYNC_IDLE_POLL_MS = 15_000;

/** The thin bar under a source's line while it syncs: filled as far as it got, or a short pulsing piece while how much
 *  is left is not known, with its words beside it (under it on a narrow card). One width on every row, so the bars line
 *  up; the coverage meter's colours. */
export function SyncProgressBar(props: { view: SyncProgressView; name: string }) {
  const { view } = props;
  return (
    <ProgressPrimitive.Root
      value={view.value}
      aria-label={t("work.connectors.progress_for", { name: props.name })}
      getAriaValueText={() => view.label}
      className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1"
      data-testid="work-sync-progress"
      data-value={view.value ?? "unknown"}
    >
      <ProgressTrack className="h-1 w-40 max-w-full shrink-0 bg-muted-foreground/15 dark:bg-muted-foreground/25">
        <ProgressIndicator className={cn("rounded-full bg-foreground/45 motion-safe:duration-500 motion-reduce:transition-none dark:bg-foreground/55", view.value === null && "w-1/4 motion-safe:animate-pulse")} />
      </ProgressTrack>
      <span className="text-[12px] tabular-nums text-muted-foreground">{view.label}</span>
    </ProgressPrimitive.Root>
  );
}

/** Whether a chat sync read runs now (the cards poll faster then). */
const chatSyncRunning = (status: WorkChatSyncStatus | undefined) => Boolean(status && Object.values(status).some((source) => source?.running));
const chatSyncPoll = (query: { state: { data?: WorkChatSyncStatus } }) => (chatSyncRunning(query.state.data) ? CHAT_SYNC_POLL_MS : CHAT_SYNC_IDLE_POLL_MS);

/** Calls `done` when the source's read stops running (an automatic one too), so its count is read again. */
function useRunEnded(running: boolean, done: () => void) {
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) done();
    was.current = running;
  });
}

/** A connector's status pill on the Connectors page: the sidebar's words (Synced, Syncing 42%, Attention,
 *  Reconnect, Paused), or Not connected / Waiting for sign-in. */
export function connectorPill(row: OmniRushWorkConnector, connecting: boolean): { tone: PillTone; label: string } {
  if (connecting) return { tone: "syncing", label: t("work.common.waiting_sign_in") };
  const linked = row.status === "connected" || row.status === "syncing" || row.status === "error";
  if (!linked && !isPausedByAdmin(row)) return { tone: "neutral", label: row.status === "disconnected" ? t("work.connectors.status_not_connected") : statusLabel(row.status) };
  const state = connectorState(row);
  return { tone: state.tone, label: state.label };
}

/** One source on the Connectors page: logo, name, status pill and one line of facts; the one action it needs now
 *  (Connect, Reconnect, Retry, Set up) as a button, everything else (sync, check, Disconnect) in its menu. */
export function ConnectorRow(props: {
  connector: OmniRushWorkConnector;
  connecting: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSync: (enabled: boolean) => void;
  /** Opens the connector's `setup_url` (GitHub: choose repositories). */
  onSetup?: () => void;
  /** The source's last health check (GET /work/health); undefined: not checked yet. */
  health?: OmniRushWorkHealth | null;
  checking?: boolean;
  onCheck?: () => void;
  /** Clears the backoff and syncs now (an `attention` with action `retry`). */
  onRetry?: () => void;
  retrying?: boolean;
  /** Saves what a picking source reads (Asana's workspaces; [] is all). */
  onPick?: (picked: string[]) => void;
  /** The company's owner or an admin: a connector the company turned off says so for the team, and opens Organization. */
  onManage?: () => void;
  /** The signed-in person's e-mail: an account that is the same address is not repeated on the row. */
  ownEmail?: string | null;
}) {
  const row = props.connector;
  const fullName = connectorLabel(row.id, row.label);
  // "Microsoft 365 (Outlook, OneDrive/SharePoint, Teams, Calendar)" reads as "Microsoft 365"; the rest is in its title.
  const name = fullName.replace(/\s*\(.*\)$/, "") || fullName;
  const connected = row.status === "connected" || row.status === "syncing" || row.status === "error";
  // Turned off by the company: what was connected stays, and Disconnect is the only action.
  const paused = isPausedByAdmin(row);
  const problem = healthProblem(props.health ?? null);
  // The server's own account of a problem (contract Addendum C1) decides the button when it sends one.
  const attention = connected ? row.attention ?? null : null;
  const reconnect = attention ? attention.action === "reconnect" || Boolean(problem?.reconnect) : row.status === "error" || Boolean(problem?.reconnect);
  // Connected and caught up with nothing to read: for GitHub, the App is not installed on any repository yet.
  const needsSetup = !attention && Boolean(row.setup_url) && row.status === "connected" && row.records === 0;
  const coverage = coverageLine(row.coverage);
  // The history import's bar (servers that send `progress`); nothing once it is caught up.
  const progress = connected ? connectorProgress(row.progress) : null;
  const pill = connectorPill(row, props.connecting);
  const synced = row.last_sync_at ? relativeTime(row.last_sync_at) : "";
  // The person's own address says nothing on their own list: it is left out (still in the line's title).
  const ownAccount = Boolean(row.account && props.ownEmail && row.account.trim().toLowerCase() === props.ownEmail.trim().toLowerCase());
  const meta = row.status === "error" && !attention
    ? sourceErrorText(row.error)
    : connected
      ? [synced ? t("work.connectors.last_sync", { when: synced }) : t("work.connectors.not_synced"), row.sync_enabled ? null : t("work.connectors.sync_off"), coverage ?? countLabel(row.records, "work.count.records"), ownAccount ? null : row.account].filter(Boolean).join(" · ")
      : paused
        ? [row.account, countLabel(row.records, "work.count.records")].filter(Boolean).join(" · ")
        : connectorAccess(row.id);
  const setupPrimary = connected && Boolean(row.setup_url) && Boolean(props.onSetup) && (needsSetup || attention?.action === "setup");
  const primary = !connected && !paused ? (
    <Button size="sm" aria-label={t("work.connectors.connect_name", { name: fullName })} disabled={props.busy || props.connecting} onClick={props.onConnect}>{t("work.common.connect")}</Button>
  ) : connected && reconnect ? (
    <Button size="sm" aria-label={t("work.connectors.reconnect_name", { name: fullName })} disabled={props.busy || props.connecting} onClick={props.onConnect}>{t("work.connectors.reconnect")}</Button>
  ) : connected && attention?.action === "retry" && props.onRetry ? (
    <Button size="sm" aria-label={t("work.connectors.retry_sync_for", { name: fullName })} disabled={props.retrying} onClick={props.onRetry}>{props.retrying ? t("work.connectors.starting") : t("work.connectors.retry_sync")}</Button>
  ) : setupPrimary ? (
    <Button size="sm" onClick={props.onSetup}>{attention?.action === "setup" ? t("work.connectors.open_setup") : setupLabel(row.id)}</Button>
  ) : paused ? (
    // Turned off by the company: Disconnect is all it offers, so it shows (in the destructive style), with a confirm.
    <Button variant="destructive" size="sm" className={WORK_DESTRUCTIVE} aria-label={t("work.connectors.disconnect_name", { name: fullName })} disabled={props.busy} onClick={props.onDisconnect}>{t("work.connectors.disconnect")}</Button>
  ) : null;
  const line = "mt-0.5 truncate text-[13px]";
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3 transition-colors duration-500 last:border-b-0 data-highlight:bg-muted/70" data-work-connector={row.id} data-status={row.status}>
      <BrandTile id={row.id} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[14px] font-medium text-foreground" title={fullName}>{name}</span>
          <StatusPill tone={pill.tone} label={pill.label} testId="work-connector-status" />
        </div>
        <div className={cn(line, "text-muted-foreground")} title={connected && row.account && ownAccount ? `${meta} · ${row.account}` : meta} data-testid="work-connector-meta">{meta}</div>
        {paused ? (
          <div className={cn(line, "text-foreground")} data-testid="work-connector-paused" data-by={row.paused_by}>
            {row.paused_by === "staff" ? t("work.connectors.paused_by_staff") : props.onManage ? t("work.connectors.paused_for_team") : t("work.connectors.paused_by_org")}
            {row.paused_by !== "staff" && props.onManage ? (
              <>
                {" "}
                <button type="button" className="rounded underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={props.onManage} data-testid="work-connector-paused-manage">
                  {t("work.connectors.paused_manage")}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {progress ? <SyncProgressBar view={progress} name={fullName} /> : null}
        {attention ? (
          <div className={cn(line, "text-foreground")} title={attention.message} data-testid="work-connector-attention" data-kind={attention.kind}>
            {attention.message}
          </div>
        ) : null}
        {connected && (row.skipped_records ?? 0) > 0 ? (
          <div className={cn(line, "text-muted-foreground")} data-testid="work-connector-skipped">
            {t("work.connectors.skipped", { count: row.skipped_records ?? 0, n: (row.skipped_records ?? 0).toLocaleString() })}
          </div>
        ) : null}
        {needsSetup ? (
          <div className={cn(line, "text-muted-foreground")} data-testid="work-connector-setup-hint">
            {t("work.connectors.setup_hint", { action: setupLabel(row.id) })}
          </div>
        ) : null}
        {connected && props.onPick && (row.choices?.length ?? 0) > 1 ? (
          <ConnectorChoices title={connectorChoicesTitle(row.id)} choices={row.choices!} busy={props.busy} onPick={props.onPick} />
        ) : null}
        {connected && props.health !== undefined ? (
          <div className={cn(line, problem ? "text-red-11" : "text-muted-foreground")} data-testid="work-connector-health">
            {props.health === null ? t("work.connectors.no_health") : problem ? problem.text : t("work.connectors.health_ok")}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {primary}
        {connected ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button variant="ghost" size="icon-sm" aria-label={t("work.sidebar.options", { name: fullName })} data-testid="work-connector-menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              )}
            />
            <DropdownMenuContent align="end" className="w-56">
              {(
                <DropdownMenuCheckboxItem checked={row.sync_enabled} disabled={props.busy} onCheckedChange={(checked: boolean) => props.onSync(checked)} aria-label={t("work.connectors.data_sync_for", { name: fullName })}>
                  {t("work.connectors.data_sync")}
                </DropdownMenuCheckboxItem>
              )}
              {props.onCheck ? (
                <DropdownMenuItem disabled={props.checking} onClick={props.onCheck} aria-label={t("work.connectors.check_name", { name: fullName })}>
                  <Stethoscope className="size-4" />{props.checking ? t("work.connectors.checking") : t("work.connectors.check")}
                </DropdownMenuItem>
              ) : null}
              {row.setup_url && props.onSetup && !setupPrimary ? (
                <DropdownMenuItem onClick={props.onSetup}><Settings2 className="size-4" />{setupLabel(row.id)}</DropdownMenuItem>
              ) : null}
              {!reconnect ? (
                <DropdownMenuItem disabled={props.busy || props.connecting} onClick={props.onConnect}><RotateCw className="size-4" />{t("work.connectors.reconnect")}</DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={props.busy}
                onClick={props.onDisconnect}
                aria-label={t("work.connectors.disconnect_name", { name: fullName })}
                className="text-red-11 focus:text-red-11 *:[svg]:text-red-11"
                data-testid="work-connector-disconnect"
              >
                <Unplug className="size-4" />{t("work.connectors.disconnect")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

const CHOICES_SHOWN = 5;

/** What a picking source reads (Asana's workspaces), as checkboxes; the last checked one stays checked. */
function ConnectorChoices(props: { title: string; choices: NonNullable<OmniRushWorkConnector["choices"]>; busy: boolean; onPick: (picked: string[]) => void }) {
  const [all, setAll] = useState(false);
  const idBase = useId();
  const picked = props.choices.filter((choice) => choice.picked).map((choice) => choice.id);
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...picked, id] : picked.filter((item) => item !== id);
    // Every one checked is the same as none picked: all of them, and any added later.
    props.onPick(next.length === props.choices.length ? [] : next);
  };
  const shown = all ? props.choices : props.choices.slice(0, CHOICES_SHOWN);
  return (
    <div className="mt-2" role="group" aria-label={props.title} data-testid="work-connector-choices">
      <div className="text-[12px] font-medium">{props.title}</div>
      <div className="mt-1 flex flex-col gap-1">
        {shown.map((choice) => (
          <div key={choice.id} className="flex items-center gap-2 text-[12px]">
            <Checkbox
              id={`${idBase}-${choice.id}`}
              checked={choice.picked}
              disabled={props.busy || (choice.picked && picked.length === 1)}
              onCheckedChange={(checked: boolean) => toggle(choice.id, checked)}
              nativeButton
              render={<button type="button" />}
              data-choice={choice.id}
            />
            <label htmlFor={`${idBase}-${choice.id}`} className="truncate">{choice.name}</label>
          </div>
        ))}
      </div>
      {!all && props.choices.length > CHOICES_SHOWN ? (
        <Button variant="ghost" size="sm" className="-ms-2 mt-1 h-7 text-[12px]" onClick={() => setAll(true)}>
          {t("work.connectors.choices_more", { count: props.choices.length - CHOICES_SHOWN })}
        </Button>
      ) : null}
      <div className="mt-1 text-[12px] text-muted-foreground">{t("work.connectors.choices_note")}</div>
    </div>
  );
}

/** The connect form's providers: the server knows each one's address; `help` is where the provider makes an app password. */
type FormPreset = { id: string; label: string; help?: string };
const APPLE_HELP = "https://support.apple.com/en-us/102654";
const FASTMAIL_HELP = "https://www.fastmail.help/hc/en-us/articles/360058752854";
const ZOHO_HELP = "https://www.zoho.com/mail/help/imap-access.html";
const MAIL_PRESETS: FormPreset[] = [
  { id: "icloud", label: "iCloud Mail", help: APPLE_HELP },
  { id: "fastmail", label: "Fastmail", help: FASTMAIL_HELP },
  { id: "zoho", label: "Zoho Mail", help: ZOHO_HELP },
  { id: "yahoo", label: "Yahoo Mail", help: "https://help.yahoo.com/kb/SLN15241.html" },
  { id: "gmx", label: "GMX", help: "https://support.gmx.com/pop-imap/toggle.html" },
  // No Outlook.com: Microsoft ended app passwords for it (2024-09-16). The form says so and points work or school accounts to Microsoft 365.
  { id: "other", label: t("work.mailcal.other_mail") },
];
const CALENDAR_PRESETS: FormPreset[] = [
  { id: "icloud", label: "iCloud Calendar", help: APPLE_HELP },
  { id: "fastmail", label: "Fastmail", help: FASTMAIL_HELP },
  { id: "nextcloud", label: "Nextcloud", help: "https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html" },
  { id: "zoho", label: "Zoho Calendar", help: ZOHO_HELP },
  { id: "other", label: t("work.mailcal.other_calendar") },
  { id: "link", label: t("work.mailcal.link") },
];

/** Other email (IMAP) and other calendar (CalDAV or a link): pick the provider, fill in the server and an app password,
 *  and Test and save tries the login before anything is saved. The password goes to the server once and is not kept here. */
export function CredentialsForm(props: { connector: OmniRushWorkConnector; client: WorkClient | null; openLink: (url: string) => void; onDone: () => void; onCancel: () => void }) {
  const mail = props.connector.id === "imap";
  const presets = mail ? MAIL_PRESETS : CALENDAR_PRESETS;
  const [preset, setPreset] = useState(presets[0]!.id);
  const [field, setField] = useState({ host: "", port: "993", security: "tls", url: "", username: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const chosen = presets.find((item) => item.id === preset);
  const link = preset === "link";
  const server = mail && preset === "other";
  const address = !mail && (link || preset === "other" || preset === "nextcloud");
  const form = (): OmniRushWorkCredentials => ({
    preset,
    ...(server ? { host: field.host.trim(), port: Number(field.port) || 993, security: field.security === "starttls" ? "starttls" : "tls" } : {}),
    ...(address ? { url: field.url.trim() } : {}),
    ...(link ? {} : { username: field.username.trim(), password: field.password }),
  });
  const save = useMutation({
    mutationFn: () => props.client!.connectWorkCredentials(props.connector.id, form()),
    onSuccess: () => {
      setField((current) => ({ ...current, password: "" }));
      toast.success(t("work.mailcal.connected", { name: connectorLabel(props.connector.id, props.connector.label) }));
      props.onDone();
    },
    onError: (reason) => setError(workFailure(reason).text),
  });
  const ready = Boolean(props.client) && (!server || field.host.trim()) && (!address || field.url.trim()) && (link || (field.username.trim() && field.password));
  const input = (key: keyof typeof field, label: string, extra: { type?: string; placeholder?: string; autoComplete?: string; inputMode?: "numeric" } = {}) => (
    <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
      {label}
      <Input
        className="h-8"
        value={field[key]}
        disabled={save.isPending}
        onChange={(event) => { setError(null); setField({ ...field, [key]: event.target.value }); }}
        data-credentials-field={key}
        {...extra}
      />
    </label>
  );
  const securityItems = [{ value: "tls", label: t("work.mailcal.tls") }, { value: "starttls", label: "STARTTLS" }];
  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-muted/30 px-4 py-3 last:border-b-0"
      data-testid={`work-credentials-${props.connector.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
          {t("work.mailcal.provider")}
          <Select value={preset} items={presets.map((item) => ({ value: item.id, label: item.label }))} onValueChange={(value) => { if (value) { setPreset(value); setError(null); } }}>
            <SelectTrigger className="h-8" aria-label={t("work.mailcal.provider")} data-testid="work-credentials-preset"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{presets.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </label>
        {server ? input("host", t("work.mailcal.server"), { placeholder: "mail.example.com", autoComplete: "off" }) : null}
        {server ? input("port", t("work.mailcal.port"), { inputMode: "numeric", autoComplete: "off" }) : null}
        {server ? (
          <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
            {t("work.mailcal.security")}
            <Select value={field.security} items={securityItems} onValueChange={(value) => { if (value) setField({ ...field, security: value, port: value === "starttls" ? "143" : "993" }); }}>
              <SelectTrigger className="h-8" aria-label={t("work.mailcal.security")}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{securityItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </label>
        ) : null}
        {address ? input("url", link ? t("work.mailcal.link_url") : preset === "nextcloud" ? t("work.mailcal.nextcloud_url") : t("work.mailcal.caldav_url"), {
          placeholder: link ? "https://calendar.example.com/private.ics" : preset === "nextcloud" ? "cloud.example.com" : "https://dav.example.com/",
          autoComplete: "off",
        }) : null}
        {link ? null : input("username", t("work.mailcal.username"), { placeholder: "you@example.com", autoComplete: "username" })}
        {link ? null : input("password", t("work.mailcal.app_password"), { type: "password", autoComplete: "current-password" })}
      </div>
      {mail ? <p className="text-[12px] text-muted-foreground" data-testid="work-credentials-outlook">{t("work.mailcal.outlook_note")}</p> : null}
      <p className="text-[12px] text-muted-foreground" data-testid="work-credentials-note">
        {link ? t("work.mailcal.link_note") : t("work.mailcal.app_password_note")}
        {!link && chosen?.help ? (
          <>
            {" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => props.openLink(chosen.help!)} data-testid="work-credentials-help">
              {t("work.mailcal.app_password_help", { name: chosen.label })}
            </button>
          </>
        ) : null}
      </p>
      {error ? <p className="text-[12px] text-destructive" role="alert" data-testid="work-credentials-error">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={!ready || save.isPending} data-testid="work-credentials-save">
          {save.isPending ? t("work.mailcal.testing") : t("work.mailcal.test_and_save")}
        </Button>
      </div>
    </form>
  );
}

/** The pasted-key sources: where the key is (the steps and a link), its field's name, the account's address where it has one
 *  (Freshdesk, Shopify; GitLab's is optional: empty is gitlab.com), Shopify's Client ID, Trello's second secret (the token),
 *  for Figma the links to follow (Figma cannot list every file), and whether the key is also used for writes the user approves
 *  ("token": the note says token). */
type KeyFormSpec = {
  help: string; placeholder: string; where: () => string; label: () => string;
  host?: () => string; hostPlaceholder?: string; hostOptional?: boolean; clientId?: () => string; token?: () => string; links?: () => string;
  writes?: boolean | "token";
};
const KEY_FORMS: Record<string, KeyFormSpec> = {
  stripe: { help: "https://dashboard.stripe.com/apikeys", placeholder: "rk_live_...", where: () => t("work.key.where_stripe"), label: () => t("work.key.label_stripe") },
  freshdesk: {
    help: "https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key",
    placeholder: "",
    where: () => t("work.key.where_freshdesk"),
    label: () => t("work.key.label_freshdesk"),
    host: () => t("work.key.host_freshdesk"),
  },
  pipedrive: { help: "https://pipedrive.readme.io/docs/how-to-find-the-api-token", placeholder: "", where: () => t("work.key.where_pipedrive"), label: () => t("work.key.label_pipedrive") },
  trello: {
    help: "https://trello.com/apps/admin",
    placeholder: "",
    where: () => t("work.key.where_trello"),
    label: () => t("work.key.label_trello"),
    token: () => t("work.key.token_trello"),
    writes: true,
  },
  clickup: { help: "https://app.clickup.com/settings/apps", placeholder: "pk_...", where: () => t("work.key.where_clickup"), label: () => t("work.key.label_clickup"), writes: true },
  monday: {
    help: "https://developer.monday.com/api-reference/docs/authentication",
    placeholder: "",
    where: () => t("work.key.where_monday"),
    label: () => t("work.key.label_monday"),
    writes: true,
  },
  gitlab: {
    help: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
    placeholder: "glpat-...",
    where: () => t("work.key.where_gitlab"),
    label: () => t("work.key.label_gitlab"),
    host: () => t("work.key.host_gitlab"),
    hostPlaceholder: "gitlab.com",
    hostOptional: true,
    writes: true,
  },
  shopify: {
    help: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
    placeholder: "shpss_... or shpat_...",
    where: () => t("work.key.where_shopify"),
    label: () => t("work.key.label_shopify"),
    host: () => t("work.key.host_shopify"),
    hostPlaceholder: "yourstore.myshopify.com",
    clientId: () => t("work.key.client_id_shopify"),
    writes: true,
  },
  airtable: { help: "https://airtable.com/create/tokens", placeholder: "pat...", where: () => t("work.key.where_airtable"), label: () => t("work.key.label_token"), writes: "token" },
  calendly: {
    help: "https://calendly.com/app/developer?tab=personal_access_tokens",
    placeholder: "",
    where: () => t("work.key.where_calendly"),
    label: () => t("work.key.label_token"),
    writes: "token",
  },
  figma: {
    help: "https://developers.figma.com/docs/rest-api/personal-access-tokens/",
    placeholder: "figd_...",
    where: () => t("work.key.where_figma"),
    label: () => t("work.key.label_token"),
    links: () => t("work.key.links_figma"),
    writes: "token",
  },
};

/** A source connected with a pasted API key or token (Stripe, Freshdesk, Pipedrive, Trello, ClickUp, monday.com, GitLab, Shopify,
 *  Airtable, Calendly, Figma): where to find it, paste it, and Test and save tries it before anything is saved. The key goes to
 *  the server once and is not kept here. */
export function KeyForm(props: { connector: OmniRushWorkConnector; client: WorkClient | null; openLink: (url: string) => void; onDone: () => void; onCancel: () => void }) {
  const id = props.connector.id;
  const spec: KeyFormSpec = KEY_FORMS[id] ?? { help: "", placeholder: "", where: () => "", label: () => t("work.key.label_freshdesk") };
  const name = connectorLabel(id, props.connector.label);
  const [field, setField] = useState({ api_key: "", host: "", client_id: "", token: "", url: "" });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      props.client!.connectWorkCredentials(id, {
        api_key: field.api_key.trim(),
        ...(spec.host && field.host.trim() ? { host: field.host.trim() } : {}),
        ...(spec.clientId && field.client_id.trim() ? { client_id: field.client_id.trim() } : {}),
        ...(spec.token ? { token: field.token.trim() } : {}),
        // Figma's links, one per line (the server also splits on spaces and commas).
        ...(spec.links ? { url: field.url.trim() } : {}),
      }),
    onSuccess: () => {
      setField({ api_key: "", host: "", client_id: "", token: "", url: "" });
      toast.success(t("work.mailcal.connected", { name }));
      props.onDone();
    },
    onError: (reason) => setError(workFailure(reason).text),
  });
  const ready = Boolean(props.client) && Boolean(field.api_key.trim()) && (!spec.host || spec.hostOptional || Boolean(field.host.trim())) && (!spec.token || Boolean(field.token.trim())) && (!spec.links || Boolean(field.url.trim()));
  const input = (key: keyof typeof field, label: string, extra: { type?: string; placeholder?: string } = {}) => (
    <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
      {label}
      <Input
        className="h-8"
        value={field[key]}
        disabled={save.isPending}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => { setError(null); setField({ ...field, [key]: event.target.value }); }}
        data-key-field={key}
        {...extra}
      />
    </label>
  );
  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-muted/30 px-4 py-3 last:border-b-0"
      data-testid={`work-key-${id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
    >
      <p className="text-[12px] text-muted-foreground" data-testid="work-key-where">
        {spec.where()}
        {spec.help ? (
          <>
            {" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => props.openLink(spec.help)} data-testid="work-key-help">
              {t("work.key.find")}
            </button>
          </>
        ) : null}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {spec.host ? input("host", spec.host(), { placeholder: spec.hostPlaceholder ?? "yourcompany.freshdesk.com" }) : null}
        {spec.clientId ? input("client_id", spec.clientId()) : null}
        {input("api_key", spec.label(), { type: "password", placeholder: spec.placeholder })}
        {spec.token ? input("token", spec.token(), { type: "password" }) : null}
      </div>
      {spec.links ? (
        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
          {spec.links()}
          <Textarea
            className="min-h-[4.5rem] text-[12px]"
            value={field.url}
            disabled={save.isPending}
            autoComplete="off"
            spellCheck={false}
            placeholder="www.figma.com/files/team/..."
            onChange={(event) => { setError(null); setField({ ...field, url: event.target.value }); }}
            data-key-field="url"
          />
        </label>
      ) : null}
      <p className="text-[12px] text-muted-foreground">{spec.writes === "token" ? t("work.key.note_token_write") : spec.writes ? t("work.key.note_write") : t("work.key.note")}</p>
      {error ? <p className="text-[12px] text-destructive" role="alert" data-testid="work-key-error">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={!ready || save.isPending} data-testid="work-key-save">
          {save.isPending ? t("work.mailcal.testing") : t("work.mailcal.test_and_save")}
        </Button>
      </div>
    </form>
  );
}

const REGIONS = [
  { value: "us", label: () => t("work.start.region_us") },
  { value: "eu", label: () => t("work.start.region_eu") },
  { value: "au", label: () => t("work.start.region_au") },
] as const;

/** What a sign-in source asks before its sign-in page opens (`start_fields`): Zendesk's address, Intercom's region. */
export function StartForm(props: { connector: OmniRushWorkConnector; busy: boolean; onStart: (form: OmniRushWorkStart) => void; onCancel: () => void }) {
  const id = props.connector.id;
  const fields = props.connector.start_fields ?? [];
  const name = connectorLabel(id, props.connector.label);
  const [host, setHost] = useState("");
  const [region, setRegion] = useState<OmniRushWorkStart["region"]>("us");
  const asksHost = fields.includes("host");
  const asksRegion = fields.includes("region");
  const ready = !asksHost || Boolean(host.trim());
  const items = REGIONS.map((item) => ({ value: item.value, label: item.label() }));
  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-muted/30 px-4 py-3 last:border-b-0"
      data-testid={`work-start-${id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !props.busy) props.onStart({ ...(asksHost ? { host: host.trim() } : {}), ...(asksRegion ? { region } : {}) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {asksHost ? (
          <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
            {t("work.start.host", { name })}
            <Input
              className="h-8"
              value={host}
              disabled={props.busy}
              autoComplete="off"
              spellCheck={false}
              placeholder={`yourcompany.${id}.com`}
              onChange={(event) => setHost(event.target.value)}
              data-start-field="host"
            />
          </label>
        ) : null}
        {asksRegion ? (
          <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
            {t("work.start.region", { name })}
            <Select value={region} items={items} onValueChange={(value) => { if (value) setRegion(value as OmniRushWorkStart["region"]); }}>
              <SelectTrigger className="h-8" aria-label={t("work.start.region", { name })} data-start-field="region"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </label>
        ) : null}
      </div>
      <p className="text-[12px] text-muted-foreground">{asksHost ? t("work.start.host_note", { name }) : t("work.start.region_note", { name })}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={!ready || props.busy} data-testid="work-start-continue">{t("work.start.continue")}</Button>
      </div>
    </form>
  );
}

const HOOK_TOOLS = [
  { id: "zapier", label: "Zapier", steps: () => t("work.hook.howto_zapier") },
  { id: "make", label: "Make", steps: () => t("work.hook.howto_make") },
  { id: "n8n", label: "n8n", steps: () => t("work.hook.howto_n8n") },
] as const;
const HOOK_EXAMPLE = JSON.stringify(
  { id: "lead-42", title: "New lead: Acme", text: "Wants 10 seats", url: "https://crm.example.com/leads/42", people: ["Ann Lee <ann@acme.example>"], kind: "deal" },
  null,
  2,
);

/** The inbound hook for Zapier, Make and n8n: one row per hook the server lists ("hook", and "hook_org" for the org's owner).
 *  Create or New URL shows the URL once (it is not kept here); Delete stops it, the records stay. Hidden when none is listed. */
export function HookCard(props: { rows: OmniRushWorkConnector[]; client: WorkClient | null; onChanged: () => void }) {
  const [shown, setShown] = useState<{ id: string; url: string } | null>(null);
  const [tool, setTool] = useState<(typeof HOOK_TOOLS)[number]["id"]>("zapier");
  // The how-to is folded until asked for.
  const [howto, setHowto] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; action: "regenerate" | "delete" } | null>(null);
  const make = useMutation({
    mutationFn: (id: string) => props.client!.createWorkHook(id),
    onSuccess: (answer, id) => { setShown({ id, url: answer.url }); props.onChanged(); },
    onError: (reason) => toast.error(workFailure(reason).text),
  });
  const remove = useMutation({
    mutationFn: (id: string) => props.client!.disconnectWorkConnector(id),
    onSuccess: (_answer, id) => { setShown((current) => (current?.id === id ? null : current)); props.onChanged(); },
    onError: (reason) => toast.error(workFailure(reason).text),
  });
  if (!props.rows.length) return null;
  const busy = make.isPending || remove.isPending;
  return (
    <div className="rounded-xl border border-border bg-background" data-testid="work-hook-card">
      <div className="flex items-start gap-4 border-b border-border px-4 py-3">
        <BrandTile id="hook" />
        <div className="min-w-[16rem] flex-1">
          <span className="text-[14px] font-medium">{t("work.hook.title")}</span>
          <div className="mt-0.5 text-[13px] text-muted-foreground">{t("work.hook.body")}</div>
        </div>
      </div>
      {props.rows.map((row) => {
        const on = row.status === "connected" || row.status === "syncing" || row.status === "error";
        const company = row.id === "hook_org";
        const url = shown?.id === row.id ? shown.url : null;
        return (
          <div key={row.id} className="flex flex-col gap-2 border-b border-border px-4 py-3" data-work-hook={row.id} data-status={on ? "on" : "off"}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-[16rem] flex-1">
                <span className="text-[14px] font-medium">{company ? t("work.hook.company") : t("work.hook.mine")}</span>
                <div className="mt-0.5 text-[13px] text-muted-foreground" data-testid="work-hook-status">
                  {!on
                    ? t("work.hook.off")
                    : row.records
                      ? [countLabel(row.records, "work.count.records"), relativeTime(row.last_sync_at)].filter(Boolean).join(" · ")
                      : t("work.hook.nothing_yet")}
                </div>
                {company ? <div className="mt-0.5 text-[13px] text-muted-foreground">{t("work.hook.company_note")}</div> : null}
              </div>
              <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
                {on ? (
                  <>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm({ id: row.id, action: "regenerate" })}>{t("work.hook.regenerate")}</Button>
                    <Button variant="destructive" size="sm" className={WORK_DESTRUCTIVE} disabled={busy} onClick={() => setConfirm({ id: row.id, action: "delete" })}>{t("work.hook.delete")}</Button>
                  </>
                ) : (
                  <Button size="sm" disabled={busy || !props.client} onClick={() => make.mutate(row.id)} data-testid="work-hook-create">{t("work.hook.create")}</Button>
                )}
              </div>
            </div>
            {url ? (
              <div className="flex flex-col gap-1" data-testid="work-hook-url">
                <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                  {t("work.hook.url_label")}
                  <div className="flex gap-2">
                    <Input className="h-8 font-mono text-[12px]" value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
                    <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success(t("work.common.link_copied")))}>
                      <Copy className="size-3.5" />{t("work.invite.copy")}
                    </Button>
                  </div>
                </label>
                <p className="text-[12px] text-amber-11">{t("work.hook.shown_once")}</p>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-col gap-2 px-4 py-3" data-testid="work-hook-howto">
        <button
          type="button"
          aria-expanded={howto}
          onClick={() => setHowto(!howto)}
          className="-mx-1 flex items-center gap-1.5 self-start rounded-md px-1 text-[13px] font-medium text-foreground outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="work-hook-howto-toggle"
        >
          <ChevronDown aria-hidden className={cn("size-4 text-muted-foreground transition-transform motion-reduce:transition-none", !howto && "-rotate-90")} />
          {t("work.hook.howto")}
        </button>
        {howto ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {HOOK_TOOLS.map((item) => (
                <Button key={item.id} variant={tool === item.id ? "secondary" : "ghost"} size="sm" aria-pressed={tool === item.id} onClick={() => setTool(item.id)}>{item.label}</Button>
              ))}
            </div>
            <p className="text-[13px] text-muted-foreground" data-testid="work-hook-steps">{HOOK_TOOLS.find((item) => item.id === tool)!.steps()}</p>
            <pre className="overflow-x-auto rounded-md bg-muted/50 px-3 py-2 text-[12px]">{HOOK_EXAMPLE}</pre>
            <p className="text-[13px] text-muted-foreground">{t("work.hook.fields")}</p>
          </>
        ) : null}
      </div>
      <ConfirmModal
        open={confirm !== null}
        title={confirm?.action === "delete" ? t("work.hook.delete_title") : t("work.hook.regenerate_title")}
        message={confirm?.action === "delete" ? t("work.hook.delete_body") : t("work.hook.regenerate_body")}
        confirmLabel={confirm?.action === "delete" ? t("work.hook.delete") : t("work.hook.regenerate")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => {
          if (confirm?.action === "delete") remove.mutate(confirm.id);
          else if (confirm) make.mutate(confirm.id);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

/** The Connectors page shows its search field from this many sources. */
export const CONNECTORS_SEARCH_FROM = 8;
/** Connected rows shown before "Show N more" (the ones that need something come first). */
export const CONNECTED_SHOWN = 8;
const CONNECTED_RANK: Record<PillTone, number> = { error: 0, attention: 1, syncing: 2, ok: 3, off: 4, neutral: 5 };

const FDA_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

const LOCAL_CHAT_NAMES: Record<WorkChatSyncSource, string> = { imessage: "iMessage", whatsapp: "WhatsApp", telegram: "Telegram" };

/** The server's answer for a source the company (or OmniRush) turned off. */
const turnedOff = (code: string | null | undefined) => code === "connector_off" || code === "connector_not_allowed";

/** What a chat sync error says on the card; repeated failures are one line with the count. */
export function localChatError(source: WorkChatSyncSource, code: string | null, failures: number): string | null {
  if (!code) return null;
  // The company (or OmniRush) turned it off: no failure, and no count of tries.
  if (code === "connector_off") return t("work.connectors.paused_by_org");
  if (code === "connector_not_allowed") return t("work.connectors.paused_by_staff");
  const name = LOCAL_CHAT_NAMES[source];
  const text = code === "fda_required" ? t("work.chatsync.fda_needed", { name })
    : code === "no_messages_db" ? t("work.imessage.no_db")
    : code === "no_whatsapp" ? t("work.chatsync.no_whatsapp")
    : code === "unsupported_schema" ? t("work.chatsync.unsupported")
    : code === "flood_wait" ? t("work.telegram.flood_sync")
    : code === "signed_out" ? t("work.telegram.signed_out")
    : code === "no_keyring" ? t("work.telegram.no_keyring")
    : code === "timeout" ? t("work.chatsync.timeout")
    : t("work.chatsync.failed");
  return failures > 1 ? `${text} ${t("work.chatsync.repeated", { n: failures })}` : text;
}

/** iMessage and the WhatsApp Mac app have no API: the desktop reads their databases on this Mac (Full Disk Access) and
 *  syncs on its own while Data sync is on (it turns on after the first good read). macOS desktop only. */
export function LocalChatCard(props: { source: WorkChatSyncSource; client: WorkClient | null; openLink: (url: string) => void }) {
  const queryClient = useQueryClient();
  const { source } = props;
  const name = LOCAL_CHAT_NAMES[source];
  const statusKey = ["omnirush-chat-sync"];
  const countKey = [`omnirush-${source}-count`, props.client?.baseUrl?.trim() || "default"];
  const status = useQuery({ queryKey: statusKey, queryFn: () => desktopBridge.workChatSyncStatus(), refetchInterval: chatSyncPoll });
  const count = useQuery({
    queryKey: countKey,
    queryFn: () => (source === "imessage" ? props.client!.getIMessageCount() : props.client!.getWhatsAppLocalCount()),
    enabled: Boolean(props.client),
  });
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: statusKey });
    void queryClient.invalidateQueries({ queryKey: countKey });
    void queryClient.invalidateQueries({ queryKey: workCoverageKey(props.client) });
  };
  const syncNow = useMutation({
    mutationFn: () => desktopBridge.workChatSyncNow(source),
    onSuccess: (result) => {
      if (result.status === "ok") toast.success(result.messages > 0 ? t("work.imessage.imported", { count: result.messages, n: result.messages.toLocaleString() }) : t("work.imessage.no_new"));
    },
    onSettled: settle,
  });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => desktopBridge.workChatSyncSet(source, enabled), onSettled: settle });
  const state = status.data?.[source];
  const busy = syncNow.isPending || toggle.isPending || Boolean(state?.running);
  useRunEnded(Boolean(state?.running), () => {
    void queryClient.invalidateQueries({ queryKey: countKey });
    void queryClient.invalidateQueries({ queryKey: workCoverageKey(props.client) });
  });
  const records = count.data?.records ?? 0;
  // While a read runs its bar shows instead of the last run's error.
  const progress = state?.running ? chatSyncProgress(state.progress, t("work.chatsync.reading_mac")) : null;
  const error = progress ? null : localChatError(source, state?.lastError ?? null, state?.failures ?? 0);
  const line = [
    records > 0 ? countLabel(records, "work.imessage.synced_days") : source === "imessage" ? t("work.imessage.intro") : t("work.chatsync.whatsapp_intro"),
    state?.lastSyncAt ? t("work.chatsync.last_sync", { when: relativeTime(state.lastSyncAt) }) : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-connector={source} data-testid={`work-${source}-card`}>
      <BrandTile id={source} />
      <div className="min-w-[16rem] flex-1">
        <span className="text-sm font-medium">{name}</span>
        <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-local-chat-line">{line}</div>
        {progress ? <SyncProgressBar view={progress} name={name} /> : null}
        {error ? <div className={cn("mt-0.5 text-[12px]", turnedOff(state?.lastError) ? "text-amber-11" : "text-destructive")} data-testid="work-local-chat-error" data-code={state?.lastError}>{error}</div> : null}
        {error && state?.lastError === "fda_required" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground" data-testid="work-local-chat-fda">
            {t("work.chatsync.fda_steps")}
            <Button type="button" variant="outline" size="sm" onClick={() => props.openLink(FDA_URL)}>{t("work.imessage.open_settings")}</Button>
          </div>
        ) : null}
      </div>
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
        <label className="me-2 flex items-center gap-2 text-[12px] text-muted-foreground">
          {t("work.connectors.data_sync")}
          <Switch
            aria-label={t("work.connectors.data_sync_for", { name })}
            checked={state?.enabled === true}
            disabled={!status.data || toggle.isPending}
            onCheckedChange={(checked: boolean) => toggle.mutate(checked)}
          />
        </label>
        <Button type="button" variant="outline" size="sm" disabled={busy || !status.data} onClick={() => syncNow.mutate()} data-testid={`work-${source}-sync`}>
          {busy ? (progress?.value != null ? t("work.chatsync.syncing") : t("work.imessage.reading")) : t("work.chatsync.sync_now")}
        </Button>
      </div>
    </div>
  );
}

/** The chats this Mac syncs on its own (iMessage, the WhatsApp app); `off` leaves out the ones the company turned off. */
export function LocalChatsCard(props: { client: WorkClient | null; openLink: (url: string) => void; off?: readonly string[] }) {
  const sources = (["whatsapp", "imessage"] as const).filter((source) => !props.off?.includes(source));
  return (
    <div className="rounded-xl border border-border bg-background" data-testid="work-local-chats">
      {sources.map((source) => <LocalChatCard key={source} source={source} client={props.client} openLink={props.openLink} />)}
    </div>
  );
}

/** What a Telegram sign-in error says. */
export function telegramLoginError(code: string, waitSeconds?: number): string {
  if (code === "flood_wait") return waitSeconds ? t("work.telegram.wait", { n: Math.max(1, Math.ceil(waitSeconds / 60)) }) : t("work.telegram.wait_later");
  return code === "no_keyring" ? t("work.telegram.no_keyring")
    : code === "bad_phone" ? t("work.telegram.error_bad_phone")
    : code === "wrong_code" ? t("work.telegram.error_wrong_code")
    : code === "code_expired" ? t("work.telegram.error_code_expired")
    : code === "wrong_password" ? t("work.telegram.error_wrong_password")
    : code === "not_registered" ? t("work.telegram.error_not_registered")
    : t("work.telegram.error_failed");
}

const TELEGRAM_DAYS = [30, 90, 365].map((n) => ({ value: String(n), label: t("work.telegram.days", { n }) }));

/** Telegram syncs from the user's own login on this computer (the login never leaves it): sign in with the phone, the
 *  code and the two-step password, then it syncs on its own like the Mac chats. Only in desktop builds that carry the
 *  app's Telegram credentials. */
export function TelegramCard(props: { client: WorkClient | null }) {
  const queryClient = useQueryClient();
  const statusKey = ["omnirush-telegram"];
  const syncKey = ["omnirush-chat-sync"];
  const countKey = ["omnirush-telegram-count", props.client?.baseUrl?.trim() || "default"];
  const status = useQuery({ queryKey: statusKey, queryFn: () => desktopBridge.workTelegramStatus(), enabled: isDesktopRuntime() });
  const data = status.data?.available ? status.data : null;
  const signedIn = data?.step === "signed_in";
  const sync = useQuery({ queryKey: syncKey, queryFn: () => desktopBridge.workChatSyncStatus(), refetchInterval: chatSyncPoll, enabled: signedIn });
  const count = useQuery({ queryKey: countKey, queryFn: () => props.client!.getTelegramCount(), enabled: Boolean(props.client) && signedIn });
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const settle = () => {
    for (const queryKey of [statusKey, syncKey, countKey, workCoverageKey(props.client)]) void queryClient.invalidateQueries({ queryKey });
  };
  const login = useMutation({
    mutationFn: (step: WorkTelegramLoginStep) => desktopBridge.workTelegramLogin(step),
    onSuccess: (result) => {
      setError("error" in result ? telegramLoginError(result.error, result.waitSeconds) : null);
      if (!("error" in result)) setValue("");
    },
    onSettled: settle,
  });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => desktopBridge.workChatSyncSet("telegram", enabled), onSettled: settle });
  const syncNow = useMutation({
    mutationFn: () => desktopBridge.workChatSyncNow("telegram"),
    onSuccess: (result) => {
      if (result.status === "ok") toast.success(result.messages > 0 ? t("work.imessage.imported", { count: result.messages, n: result.messages.toLocaleString() }) : t("work.imessage.no_new"));
      // Telegram's wait is not over yet: Sync now does not ask it again before then.
      else if (result.status === "skipped" && result.reason === "flood_wait") toast.info(t("work.telegram.flood_sync"));
    },
    onSettled: settle,
  });
  const settings = useMutation({ mutationFn: (change: { channels?: boolean; days?: number }) => desktopBridge.workTelegramSettings(change), onSettled: settle });
  const logout = useMutation({ mutationFn: () => desktopBridge.workTelegramLogout(), onSettled: settle });
  useRunEnded(Boolean(sync.data?.telegram?.running), () => {
    void queryClient.invalidateQueries({ queryKey: countKey });
    void queryClient.invalidateQueries({ queryKey: workCoverageKey(props.client) });
  });
  if (!data) return null;
  const state = sync.data?.telegram;
  const records = count.data?.records ?? 0;
  const progress = signedIn && state?.running ? chatSyncProgress(state.progress, t("work.chatsync.reading_telegram")) : null;
  const asking = data.step === "signed_out" || data.step === "code" || data.step === "password";
  const busy = login.isPending || logout.isPending;
  const line = signedIn
    ? [t("work.telegram.signed_in", { name: data.name ?? "" }), records > 0 ? countLabel(records, "work.imessage.synced_days") : null, state?.lastSyncAt ? t("work.chatsync.last_sync", { when: relativeTime(state.lastSyncAt) }) : null].filter(Boolean).join(" · ")
    : data.step === "other_account" ? t("work.telegram.other_account")
    : data.step === "code" ? (data.via === "app" ? t("work.telegram.code_app") : t("work.telegram.code_sms"))
    : data.step === "password" ? (data.hint ? t("work.telegram.password_hint", { hint: data.hint }) : t("work.telegram.password_intro"))
    : t("work.telegram.intro");
  const shownError = error ?? (signedIn && !progress ? localChatError("telegram", state?.lastError ?? null, state?.failures ?? 0) : null);
  const submit = (): WorkTelegramLoginStep => (data.step === "code" ? { code: value } : data.step === "password" ? { password: value } : { phone: value });
  return (
    <div className="rounded-xl border border-border bg-background" data-testid="work-telegram-card" data-step={data.step}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <BrandTile id="telegram" />
        <div className="min-w-[16rem] flex-1">
          <span className="text-sm font-medium">Telegram</span>
          <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-telegram-line">{line}</div>
          {progress ? <SyncProgressBar view={progress} name="Telegram" /> : null}
          {shownError ? <div className="mt-0.5 text-[12px] text-destructive" data-testid="work-telegram-error">{shownError}</div> : null}
          {asking ? (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (value.trim()) login.mutate(submit());
              }}
            >
              <Input
                className="h-8 w-56"
                type={data.step === "password" ? "password" : "text"}
                inputMode={data.step === "code" ? "numeric" : data.step === "signed_out" ? "tel" : undefined}
                autoComplete={data.step === "code" ? "one-time-code" : data.step === "password" ? "current-password" : "tel"}
                placeholder={data.step === "signed_out" ? "+44 7700 900123" : undefined}
                aria-label={data.step === "code" ? t("work.telegram.code") : data.step === "password" ? t("work.telegram.password") : t("work.telegram.phone")}
                value={value}
                disabled={busy}
                onChange={(event) => setValue(event.target.value)}
                data-testid="work-telegram-input"
              />
              <Button type="submit" size="sm" disabled={busy || !value.trim()}>{data.step === "signed_out" ? t("work.telegram.send_code") : t("work.telegram.sign_in")}</Button>
              {data.step !== "signed_out" ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => login.mutate({ cancel: true })}>{t("common.cancel")}</Button> : null}
            </form>
          ) : null}
          {signedIn ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted-foreground">
              <label className="flex items-center gap-2">
                {t("work.telegram.channels")}
                <Switch aria-label={t("work.telegram.channels")} checked={data.channels} disabled={settings.isPending} onCheckedChange={(channels: boolean) => settings.mutate({ channels })} />
              </label>
              <span className="flex items-center gap-2">
                {t("work.telegram.first_days")}
                <Select value={String(data.days)} items={TELEGRAM_DAYS} onValueChange={(days) => days && settings.mutate({ days: Number(days) })}>
                  <SelectTrigger className="h-7 w-28" aria-label={t("work.telegram.first_days")}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{TELEGRAM_DAYS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </span>
            </div>
          ) : null}
        </div>
        <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
          {signedIn ? (
            <>
              <label className="me-2 flex items-center gap-2 text-[12px] text-muted-foreground">
                {t("work.connectors.data_sync")}
                <Switch aria-label={t("work.connectors.data_sync_for", { name: "Telegram" })} checked={state?.enabled === true} disabled={!sync.data || toggle.isPending} onCheckedChange={(checked: boolean) => toggle.mutate(checked)} />
              </label>
              <Button type="button" variant="outline" size="sm" disabled={syncNow.isPending || Boolean(state?.running) || !sync.data} onClick={() => syncNow.mutate()} data-testid="work-telegram-sync">
                {syncNow.isPending || state?.running ? (progress?.value != null ? t("work.chatsync.syncing") : t("work.imessage.reading")) : t("work.chatsync.sync_now")}
              </Button>
            </>
          ) : null}
          {signedIn || data.step === "other_account" ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} aria-label={t("work.connectors.disconnect_name", { name: "Telegram" })} onClick={() => setConfirmLogout(true)}>{t("work.connectors.disconnect")}</Button>
          ) : null}
        </div>
      </div>
      <ConfirmModal
        open={confirmLogout}
        title={t("work.connectors.disconnect_title", { name: "Telegram" })}
        message={t("work.telegram.disconnect_body")}
        confirmLabel={t("work.connectors.disconnect")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => {
          setConfirmLogout(false);
          logout.mutate();
        }}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
}

const METER_DOT = { connected: "bg-foreground/45", attention: "bg-amber-9", missing: "bg-muted-foreground/25 dark:bg-muted-foreground/40" } as const;

/** The meter's "+" chips (only those `canAdd` allows) and whether it shows: not while it loads, not when nothing is missing,
 *  not when the read fails (an older server answers 404). */
export function useCoverageMeter(client: WorkClient | null, canAdd?: (id: string) => boolean) {
  const data = useWorkCoverage(client).data;
  const adds = coverageAdds(data).filter((id) => canAdd?.(id) ?? true);
  return { data, adds, shown: Boolean(data && data.total && (data.connected < data.total || adds.length)) };
}

/** "Ask sees 3 of 4 channels" with a dot per channel group and "+ Slack" chips for what is missing. It never shows an error. */
export function WorkCoverageMeter(props: { client: WorkClient | null; onAdd?: (id: string) => void; canAdd?: (id: string) => boolean; className?: string }) {
  const { data, adds, shown } = useCoverageMeter(props.client, props.canAdd);
  if (!shown || !data) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground", props.className)} data-testid="work-coverage">
      <span className="flex items-center gap-2">
        <span role="meter" aria-valuemin={0} aria-valuemax={data.total} aria-valuenow={data.connected} aria-label={t("work.coverage.sees", { connected: data.connected, total: data.total })} className="flex items-center gap-0.5">
          {data.groups.map((group) => (
            <span key={group.group} title={group.label} data-coverage-group={group.group} data-state={group.state} className={cn("h-1.5 w-3 rounded-full", METER_DOT[group.state as keyof typeof METER_DOT] ?? METER_DOT.missing)} />
          ))}
        </span>
        <span>{t("work.coverage.sees", { connected: data.connected, total: data.total })}</span>
      </span>
      {adds.map((id) => {
        const label = isImportKind(id) ? t("work.coverage.add_import", { name: connectorLabel(id) }) : connectorLabel(id);
        return props.onAdd ? (
          <button key={id} type="button" data-coverage-add={id} onClick={() => props.onAdd!(id)} className="flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 transition-colors hover:border-foreground/25 hover:text-foreground">
            <Plus aria-hidden className="size-3" />{label}
          </button>
        ) : <span key={id} data-coverage-add={id} className="flex items-center gap-1"><Plus aria-hidden className="size-3" />{label}</span>;
      })}
    </div>
  );
}

/** The Mac desktop app, where iMessage and the WhatsApp app sync on their own. */
const macDesktop = () => isDesktopRuntime() && isMacPlatform();

/** The server refuses a chat export over 50 MB. */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const IMPORT_ACCEPT: Record<OmniRushWorkImportKind, string> = { whatsapp: ".txt,.zip,text/plain,application/zip", telegram: ".json,application/json" };

/** WhatsApp and Telegram have no sign-in: a chat export from the phone (or Telegram Desktop) is uploaded instead. Each row says
 *  how to export, Import opens the file picker, and the line under it shows the last import. `off` leaves out the kinds
 *  the company turned off. */
export function ChatImportCard(props: { client: WorkClient | null; off?: readonly string[] }) {
  const queryClient = useQueryClient();
  const imports = useQuery({ queryKey: workImportsKey(props.client), queryFn: () => props.client!.listWorkImports(), enabled: Boolean(props.client), retry: false });
  const upload = useMutation({
    mutationFn: ({ kind, file }: { kind: OmniRushWorkImportKind; file: File }) => {
      if (file.size > IMPORT_MAX_BYTES) throw new Error(t("work.import.too_large"));
      return props.client!.importWorkChat(kind, file);
    },
    onSuccess: (result) => {
      if (result.status === "failed" || !result.records) toast.error(t("work.import.unreadable"));
      else toast.success(t("work.import.done", { count: result.records, n: result.records.toLocaleString() }));
    },
    onError: (reason) => toast.error(workFailure(reason).text),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workImportsKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: workCoverageKey(props.client) });
    },
  });
  const latest = (kind: string): OmniRushWorkImport | undefined => (Array.isArray(imports.data) ? imports.data : []).find((item) => (item.source ?? "whatsapp") === kind);
  const kinds = IMPORT_KINDS.filter((kind) => !props.off?.includes(kind));
  if (!kinds.length) return null;
  return (
    <div className="rounded-xl border border-border bg-background" data-testid="work-import-card">
      {kinds.map((kind) => {
        const last = latest(kind);
        // A file with no messages in it (a Telegram file that is no export) comes back done with nothing: not read either.
        const failed = last?.status === "failed" || (last?.status === "done" && !last.records);
        const busy = upload.isPending && upload.variables?.kind === kind;
        return (
          <div key={kind} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-import={kind}>
            <BrandTile id={kind} />
            <div className="min-w-[16rem] flex-1">
              <span className="text-sm font-medium">{connectorLabel(kind)}</span>
              <div className="mt-0.5 text-[12px] text-muted-foreground">{kind === "whatsapp" ? t("work.import.howto_whatsapp") : t("work.import.howto_telegram")}</div>
              {kind === "whatsapp" && !macDesktop() ? <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-import-whatsapp-manual">{t("work.import.whatsapp_no_local")}</div> : null}
              {last ? (
                <div className={cn("mt-0.5 truncate text-[12px]", failed ? "text-destructive" : "text-muted-foreground")} data-testid="work-import-status" data-status={failed ? "failed" : last.status}>
                  {failed
                    ? t("work.import.failed_line", { file: last.file_name ?? "" })
                    : [last.file_name, last.status === "parsing" ? t("work.import.reading") : countLabel(last.records, "work.import.days"), relativeTime(last.created_at)].filter(Boolean).join(" · ")}
                </div>
              ) : null}
            </div>
            <input
              type="file"
              hidden
              accept={IMPORT_ACCEPT[kind]}
              data-import-input={kind}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) upload.mutate({ kind, file });
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="ms-auto"
              disabled={upload.isPending}
              aria-label={t("work.import.import_name", { name: connectorLabel(kind) })}
              onClick={(event) => event.currentTarget.parentElement?.querySelector<HTMLInputElement>("[data-import-input]")?.click()}
            >
              {busy ? t("work.import.importing") : t("work.import.import")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Work > Connectors (also reachable from Settings): each source's status, record count, last sync and sync switch.
 *  `onOpenOrganization` opens Work > Organization (where the owner and admins choose the team's connectors). */
export function WorkConnectorsPage(props: { client: WorkClient | null; openLink: (url: string) => void; onBack?: () => void; backLabel?: string; notice?: ReactNode; onOpenOrganization?: () => void }) {
  const queryClient = useQueryClient();
  const key = workConnectorsKey(props.client);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<OmniRushWorkConnector | null>(null);
  const [health, setHealth] = useState<Record<string, OmniRushWorkHealth | null>>({});
  // The source whose server and password form is open (other email, other calendar).
  const [form, setForm] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // The kinds of tool opened (the connected group is always open).
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const ownEmail = useAccountStatusStore((state) => state.status?.email ?? null);
  const connectStarted = useRef(0);
  const query = useQuery({
    queryKey: key,
    queryFn: () => props.client!.listWorkConnectors(),
    enabled: Boolean(props.client),
    refetchInterval: (current) => (connecting ? CONNECT_POLL_MS : current.state.data?.some((row) => connectorProgress(row.progress)) ? PROGRESS_POLL_MS : false),
  });
  // The company's list: the WhatsApp import and the Mac's WhatsApp leave the page while it is turned off. On an older
  // server (404) nothing is off.
  const team = useWorkOrgConnectors(props.client);
  const off = localSourcesOff(query.data, team.data);
  const manage = team.data?.can_manage ? props.onOpenOrganization : undefined;
  useEffect(() => {
    if (!connecting) return;
    if (connectSettled(query.data, connecting)) {
      setConnecting(null);
      return;
    }
    if (Date.now() - connectStarted.current > CONNECT_TIMEOUT_MS) {
      setConnecting(null);
      toast.error(t("work.common.sign_in_timeout"));
    }
  }, [connecting, query.data]);
  const onError = (reason: unknown) => {
    toast.error(workFailure(reason).text);
    // Work was switched off: the app leaves Work now rather than when its switch is next read.
    if ((reason as { code?: unknown } | null)?.code === "work_disabled") void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  // Opened at one connector (the sidebar's Manage, `#slack`): scrolled to and marked for a moment once the rows are in.
  const target = decodeURIComponent(useLocation().hash.slice(1));
  const rowsIn = Boolean(query.data);
  useEffect(() => {
    if (!target || !rowsIn || !/^[a-z][a-z0-9_-]{0,31}$/.test(target)) return;
    const found = document.querySelector<HTMLElement>(`[data-work-connector="${target}"]`);
    if (!found) return;
    found.scrollIntoView({ block: "center" });
    found.setAttribute("data-highlight", "");
    const timer = window.setTimeout(() => found.removeAttribute("data-highlight"), 1600);
    return () => window.clearTimeout(timer);
  }, [rowsIn, target, openGroups.length]);
  const connect = useMutation({
    mutationFn: ({ id, form: start }: { id: string; form?: OmniRushWorkStart }) => props.client!.startWorkConnector(id, start),
    onSuccess: (answer, { id }) => {
      connectStarted.current = Date.now();
      setConnecting(id);
      setForm((current) => (current === id ? null : current));
      props.openLink(answer.auth_url);
    },
    onError,
  });
  const disconnect = useMutation({ mutationFn: (id: string) => props.client!.disconnectWorkConnector(id), onSuccess: refresh, onError });
  const check = useMutation({
    mutationFn: async (id: string) => healthFor(await props.client!.getWorkHealth(id), id),
    onSuccess: (found, id) => {
      setHealth((current) => ({ ...current, [id]: found }));
      void refresh();
    },
    onError,
  });
  const sync = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => props.client!.setWorkConnectorSync(id, enabled),
    onSuccess: refresh,
    onError,
  });
  const pick = useMutation({
    mutationFn: ({ id, picked }: { id: string; picked: string[] }) => props.client!.setWorkConnectorPicked(id, picked),
    onSuccess: refresh,
    onError,
  });
  const retry = useMutation({
    mutationFn: (id: string) => props.client!.syncWorkConnector(id),
    onSuccess: () => {
      toast.success(t("work.common.sync_started"));
      void refresh();
    },
    onError,
  });
  // An import source (WhatsApp) has no sign-in: it is imported in the card under the list. The hooks have their own card.
  const rows = visibleConnectors(query.data).filter((row) => row.mode !== "import" && row.mode !== "hook");
  const hookRows = visibleConnectors(query.data).filter((row) => row.mode === "hook");
  const busy = connect.isPending || disconnect.isPending || sync.isPending || pick.isPending;
  // The meter's "+ Slack" connects Slack here; "+ WhatsApp import" opens the import's file picker. A source this page does not
  // list (Meetings) gets no chip.
  const canAdd = (id: string) => !off.includes(id) && coverageCanAdd(query.data, id);
  const add = (id: string) => {
    if (isImportKind(id)) document.querySelector<HTMLInputElement>(`[data-import-input="${id}"]`)?.click();
    else if (signsInWithForm(query.data, id)) setForm(id);
    else if (canAdd(id) && !busy) connect.mutate({ id });
  };
  const failure = query.error ? workFailure(query.error) : null;
  // Connected sources first, then the rest by kind of tool (folded until opened), with search once the list is long.
  const catalog = useWorkCatalog(props.client, [], Boolean(props.client));
  const searching = Boolean(search.trim());
  const folding = rows.length > CONNECTORS_SEARCH_FROM;
  const inUse = (row: OmniRushWorkConnector) => isLinked(row) || isPausedByAdmin(row) || connecting === row.id || form === row.id;
  const found = rows.filter((row) => matchesQuery(search, row.label, row.id, connectorLabel(row.id, row.label)));
  const categoryOf = (id: string) => catalog.connectors.find((tool) => tool.id === id)?.category ?? "other";
  // Reconnect, Attention and Syncing lead the connected group, then the rest in the server's order.
  const connectedRows = found
    .filter(inUse)
    .map((row, index) => ({ row, index, rank: CONNECTED_RANK[connectorPill(row, connecting === row.id).tone] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.row);
  const connectedCap = useListCap(connectedRows.length, CONNECTED_SHOWN);
  const groups = [
    { id: "connected", label: t("work.connectors.group_connected"), rows: connectedRows },
    ...[...catalog.categories, { id: "other", label: t("work.connectors.group_other") }].map((category) => ({
      id: category.id,
      label: category.label,
      rows: found.filter((row) => !inUse(row) && (categoryOf(row.id) === category.id || (category.id === "other" && !catalog.categories.some((known) => known.id === categoryOf(row.id))))),
    })),
  ].filter((group) => group.rows.length > 0);
  // Opened at one connector (`#slack`) or its sign-in form: its group opens too.
  const wanted = target || form;
  useEffect(() => {
    if (!wanted || !rowsIn) return;
    const group = groups.find((entry) => entry.id !== "connected" && entry.rows.some((row) => row.id === wanted));
    if (group && !openGroups.includes(group.id)) setOpenGroups([...openGroups, group.id]);
  }, [wanted, rowsIn]);
  // The first rows of the connected group, plus the one the page was opened at (`#slack`) or whose form is open.
  const cappedConnected = connectedRows.filter((row, index) => index < connectedCap.shown || row.id === wanted);
  const renderRow = (row: OmniRushWorkConnector) => [
    <ConnectorRow
      key={row.id}
      connector={row}
      connecting={connecting === row.id}
      busy={busy}
      onConnect={() => (row.mode === "credentials" || row.mode === "key" || row.start_fields?.length ? setForm(form === row.id ? null : row.id) : connect.mutate({ id: row.id }))}
      onDisconnect={() => setConfirmDisconnect(row)}
      onSync={(enabled) => sync.mutate({ id: row.id, enabled })}
      onSetup={row.setup_url ? () => props.openLink(row.setup_url!) : undefined}
      health={health[row.id]}
      checking={check.isPending && check.variables === row.id}
      onCheck={() => check.mutate(row.id)}
      retrying={retry.isPending && retry.variables === row.id}
      onRetry={() => retry.mutate(row.id)}
      onPick={(picked) => pick.mutate({ id: row.id, picked })}
      onManage={manage}
      ownEmail={ownEmail}
    />,
    form === row.id ? (
      (() => {
        const formProps = {
          connector: row,
          client: props.client,
          openLink: props.openLink,
          onDone: () => { setForm(null); void refresh(); void queryClient.invalidateQueries({ queryKey: workCoverageKey(props.client) }); },
          onCancel: () => setForm(null),
        };
        if (row.start_fields?.length) {
          return <StartForm key={`${row.id}-form`} connector={row} busy={connect.isPending} onStart={(start) => connect.mutate({ id: row.id, form: start })} onCancel={() => setForm(null)} />;
        }
        return row.mode === "key" ? <KeyForm key={`${row.id}-form`} {...formProps} /> : <CredentialsForm key={`${row.id}-form`} {...formProps} />;
      })()
    ) : null,
  ];
  return (
    <div className="h-full overflow-y-auto" data-testid="work-connectors">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pb-10 pt-10">
        <div>
          {props.onBack ? <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? t("work.common.back_to_work")}</Button> : null}
          <h1 className="text-xl font-semibold tracking-tight">{t("work.nav.connectors")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("work.connectors.subtitle")}
          </p>
          {props.notice ? <div className="mt-3">{props.notice}</div> : null}
        </div>
        <WorkCoverageMeter client={props.client} onAdd={add} canAdd={canAdd} />
        {query.isLoading ? (
          <div className="rounded-xl border border-border px-4 py-6 text-[14px] text-muted-foreground">{t("common.loading")}</div>
        ) : failure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-connectors-error">
            <span className="text-[14px] text-muted-foreground">{failure.text}</span>
            {failure.retry ? <Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t("work.common.try_again")}</Button> : null}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-6 text-[14px] text-muted-foreground">{t("work.connectors.none")}</div>
        ) : (
          <div className="flex flex-col gap-4" data-testid="work-connector-groups">
            {rows.length > CONNECTORS_SEARCH_FROM ? (
              <ListSearch value={search} onChange={setSearch} label={t("work.connectors.search")} testId="work-connectors-search" />
            ) : null}
            {groups.map((group) => {
              // A short list shows whole; a long one folds each kind of tool until opened.
              const open = !folding || group.id === "connected" || searching || openGroups.includes(group.id);
              return (
                <section key={group.id} className="flex flex-col gap-2" data-connector-group={group.id} data-open={open}>
                  {group.id === "connected" || !folding ? (
                    <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">{group.label}<span className="font-normal tabular-nums text-muted-foreground">{group.rows.length}</span></h2>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenGroups(open ? openGroups.filter((id) => id !== group.id) : [...openGroups, group.id])}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-1 text-start text-[13px] font-semibold text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="work-connector-group-toggle"
                    >
                      <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", !open && "-rotate-90")} />
                      <span className="min-w-0 truncate">{group.label}</span>
                      <span className="font-normal tabular-nums text-muted-foreground">{group.rows.length}</span>
                      {open ? null : <span aria-hidden className="ms-auto flex items-center gap-1">{group.rows.slice(0, 5).map((row) => <BrandTile key={row.id} id={row.id} size="chip" />)}</span>}
                    </button>
                  )}
                  {open ? (
                    <div className="rounded-xl border border-border bg-background">
                      {(group.id === "connected" ? cappedConnected : group.rows).map(renderRow)}
                    </div>
                  ) : null}
                  {group.id === "connected" ? <ListMore cap={connectedCap} className="px-1" testId="work-connected-more" /> : null}
                </section>
              );
            })}
            {searching && !groups.length ? <p className="px-1 text-[14px] text-muted-foreground" data-testid="work-connectors-no-match">{t("work.connectors.no_match")}</p> : null}
          </div>
        )}
        <HookCard rows={hookRows} client={props.client} onChanged={() => void refresh()} />
        <ChatImportCard client={props.client} off={off} />
        {macDesktop() ? <LocalChatsCard client={props.client} openLink={props.openLink} off={off} /> : null}
        <TelegramCard client={props.client} />
      </div>
      <ConfirmModal
        open={confirmDisconnect !== null}
        title={t("work.connectors.disconnect_title", { name: confirmDisconnect ? connectorLabel(confirmDisconnect.id, confirmDisconnect.label) : "" })}
        message={confirmDisconnect && isPausedByAdmin(confirmDisconnect) ? t("work.connectors.disconnect_body_paused") : t("work.connectors.disconnect_body")}
        confirmLabel={t("work.connectors.disconnect")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => {
          if (confirmDisconnect) disconnect.mutate(confirmDisconnect.id);
          setConfirmDisconnect(null);
        }}
        onCancel={() => setConfirmDisconnect(null)}
      />
    </div>
  );
}

/** The composer's chip in a Work chat (nothing elsewhere): the connected sources' icons and count, or "Connect tools".
 *  Opens Work > Connectors, whose Back returns to this chat. */
export function WorkConnectorsChip(props: { workChat?: boolean; client: WorkClient | null }) {
  return props.workChat ? <WorkConnectorsChipButton client={props.client} /> : null;
}

function WorkConnectorsChipButton(props: { client: WorkClient | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const query = useQuery({ queryKey: workConnectorsKey(props.client), queryFn: () => props.client!.listWorkConnectors(), enabled: Boolean(props.client) });
  const connected = visibleConnectors(query.data).filter((row) => row.status === "connected" || row.status === "syncing" || row.status === "error");
  const label = connected.length ? countLabel(connected.length, "work.count.connectors") : t("work.connectors.chip_connect");
  return (
    <button
      type="button"
      data-testid="work-connectors-chip"
      title={connected.length ? t("work.connectors.chip_title", { names: connected.map((row) => connectorLabel(row.id, row.label)).join(", ") }) : t("work.connectors.chip_connect")}
      aria-label={label}
      onClick={() => navigate(WORK_CONNECTORS_ROUTE, connectorsBackState(location.pathname, location.search))}
      className="flex h-9 max-h-9 min-w-9 shrink-[4] items-center gap-1.5 overflow-hidden rounded-md px-2.5 text-sm text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
    >
      {connected.length ? connected.slice(0, 3).map((row) => <ConnectorIcon key={row.id} id={row.id} className="size-3.5 text-current" />) : <Plug aria-hidden className="size-4 shrink-0" />}
      {/* Nothing connected: the icon alone, so the home's checklist keeps the one "Connect" in words. */}
      <span className={connected.length ? "min-w-0 truncate whitespace-nowrap" : "sr-only"}>{label}</span>
    </button>
  );
}

/** Settings > Preferences: the way to Work > Connectors, while Work is on for the account. */
export function WorkConnectorsSetting(props: { client: WorkClient | null }) {
  const navigate = useNavigate();
  const state = useWorkState(props.client);
  if (!state.data?.enabled) return null;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("work.connectors.setting_title")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("work.connectors.setting_body")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-connectors" onClick={() => navigate(WORK_CONNECTORS_ROUTE)}>{t("work.common.open")}</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}

/**
 * A Work chat whose engine has no hosted Work tools (the agent would only see local files): says so, with Fix.
 * A Work chat started on Claude never has them (a chat keeps its model): a plain notice instead.
 */
export function WorkToolsBanner(props: { workChat?: boolean; client: WorkClient | null; claude?: boolean }) {
  if (props.workChat && props.claude) {
    return (
      <div role="status" className="mb-2 flex items-center gap-3 rounded-xl border border-amber-7/50 bg-amber-2/30 px-3 py-2.5 text-xs" data-testid="work-claude-notice">
        <Plug aria-hidden className="size-4 shrink-0 text-warning" />
        <p className="min-w-0 flex-1 font-medium text-dls-text">{t("work.tools.claude_notice")}</p>
      </div>
    );
  }
  return props.workChat && props.client ? <WorkToolsBannerCheck client={props.client} /> : null;
}

function WorkToolsBannerCheck(props: { client: WorkClient }) {
  const queryClient = useQueryClient();
  const key = workChatToolsKey(props.client);
  const query = useQuery({ queryKey: key, queryFn: () => props.client.getWorkChatTools(), refetchInterval: 60_000, retry: false });
  const fix = useMutation({
    mutationFn: () => props.client.fixWorkChatTools(),
    onSuccess: (answer) => {
      queryClient.setQueryData(key, answer);
      if (answer.attached) toast.success(t("work.tools.connected"));
      else toast.error(answer.reason ?? t("work.tools.still_not_connected"));
    },
    onError: (reason) => toast.error(workFailure(reason).text),
  });
  if (!query.data || query.data.attached) return null;
  return (
    // The chat's run status card (session-surface SessionRunStatus) in its warning tone, so stacked notices read as one;
    // a single line sits centred with its button, two lines start at the top like the card.
    <div role="status" className={cn("mb-2 flex gap-3 rounded-xl border border-amber-7/50 bg-amber-2/30 px-3 py-2.5 text-xs", query.data.reason ? "items-start" : "items-center")} data-testid="work-tools-banner">
      <Plug aria-hidden className={cn("size-4 shrink-0 text-warning", query.data.reason && "mt-0.5")} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-dls-text">{t("work.tools.banner")}</p>
        {query.data.reason ? <p className="mt-0.5 text-dls-secondary">{query.data.reason}</p> : null}
      </div>
      <button
        type="button"
        className="shrink-0 rounded-md border border-dls-border px-2.5 py-1 font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-wait disabled:opacity-60"
        disabled={fix.isPending}
        onClick={() => fix.mutate()}
        data-testid="work-tools-fix"
      >
        {fix.isPending ? t("work.tools.fixing") : t("work.today.fix")}
      </button>
    </div>
  );
}

/** The `notices` Work tool results carried in this turn (e.g. a source that needs reconnecting), each once. */
export function WorkToolNotices(props: { notices: string[] }) {
  if (!props.notices.length) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="work-tool-notices">
      {props.notices.map((notice) => (
        <div key={notice} className="flex items-start gap-2 rounded-lg bg-amber-2/50 px-2.5 py-1.5 text-[12px] text-amber-11">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      ))}
    </div>
  );
}
