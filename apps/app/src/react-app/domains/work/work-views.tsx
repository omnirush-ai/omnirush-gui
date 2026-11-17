/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, BookOpen, Briefcase, Calculator, Cloud, Code2, Database, FileText, Github, Handshake, Hash, Info, Kanban, Mail, MessageSquare, Plug, Shapes, Sparkles, Ticket,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { OmniRushWorkConnector, OmniRushWorkHealth, OmniRushWorkStarter } from "@/app/lib/omnirush-server";
import { desktopBridge } from "@/app/lib/desktop";
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
  connectorAccess, connectorLabel, connectorsBackState, connectSettled, countLabel, coverageLine, healthFor, healthProblem, setupLabel, useWorkState, visibleConnectors, WORK_CONNECTORS_ROUTE,
  sourceErrorText, workChatToolsKey, workConnectorsKey, workFailure, workStateKey, type AppMode, type WorkClient,
} from "./work-mode";

const CONNECTOR_ICONS: Record<string, LucideIcon> = {
  google: Mail, microsoft: Cloud, slack: Hash, hubspot: Handshake, quickbooks: Calculator, notion: FileText,
  jira: Ticket, confluence: BookOpen, linear: Kanban, github: Github, mock: Shapes, demo: Database,
};

/** A connector's icon; an id the app does not know gets the generic plug. */
export function ConnectorIcon(props: { id: string; className?: string }) {
  const Icon = CONNECTOR_ICONS[props.id] ?? Plug;
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", props.className)} data-connector-icon={CONNECTOR_ICONS[props.id] ? props.id : "generic"} />;
}

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
  /** The "Sample data" badge while the demo source is seeded. */
  badge?: ReactNode;
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
    return (
      <div className="flex h-full flex-col" data-testid="work-home">
        <div className="min-h-0 flex-1 overflow-y-auto mask-b-from-[calc(100%-1.5rem)]">
          <div className={cn(COMPOSER_GUTTER, "py-8")}>
            <div className="mx-auto w-full max-w-[800px]" data-testid="work-home-column">{props.today}</div>
          </div>
        </div>
        <div className={cn(COMPOSER_GUTTER, COMPOSER_BOTTOM, "mb-2 shrink-0 pt-1")}>
          <div className={cn(COMPOSER_WIDTH, "flex flex-col gap-2")}>
            {starterChips}
            {props.composer}
            {message}
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
            {props.badge}
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
  return t("work.connectors.status_unavailable");
}

function lastSync(value: string | null): string {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? t("work.connectors.last_sync", { when: at.toLocaleString() }) : t("work.connectors.not_synced");
}

export const CONNECT_POLL_MS = 2_000;
// Sign-in with a second factor or an admin prompt often takes over a minute.
export const CONNECT_TIMEOUT_MS = 180_000;

/** One source on the Connectors page. */
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
}) {
  const row = props.connector;
  const name = connectorLabel(row.id, row.label);
  const connected = row.status === "connected" || row.status === "syncing" || row.status === "error";
  const problem = healthProblem(props.health ?? null);
  // The server's own account of a problem (contract Addendum C1) decides the button when it sends one.
  const attention = connected ? row.attention ?? null : null;
  const reconnect = attention ? attention.action === "reconnect" || Boolean(problem?.reconnect) : row.status === "error" || Boolean(problem?.reconnect);
  // Connected and caught up with nothing to read: for GitHub, the App is not installed on any repository yet.
  const needsSetup = !attention && Boolean(row.setup_url) && row.status === "connected" && row.records === 0;
  const coverage = coverageLine(row.coverage);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-connector={row.id} data-status={row.status}>
      <ConnectorIcon id={row.id} />
      {/* The text keeps at least 16rem; on a narrow window the controls wrap under it instead of squeezing it. */}
      <div className="min-w-[16rem] flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <Badge variant={row.status === "error" || attention?.kind === "reconnect" || attention?.kind === "failing" ? "destructive" : row.status === "disconnected" ? "outline" : "secondary"} data-testid="work-connector-status">
            {props.connecting ? t("work.common.waiting_sign_in") : attention ? statusLabel("error") : statusLabel(row.status)}
          </Badge>
        </div>
        <div className="mt-0.5 break-words text-[12px] text-muted-foreground">
          {row.status === "error" && !attention
            ? sourceErrorText(row.error)
            : connected
              ? [row.account, coverage ?? countLabel(row.records, "work.count.records"), lastSync(row.last_sync_at)].filter(Boolean).join(" · ")
              : connectorAccess(row.id)}
        </div>
        {attention ? (
          <div
            className={cn("mt-0.5 break-words text-[12px]", attention.kind === "reconnect" || attention.kind === "failing" ? "text-destructive" : "text-amber-11")}
            data-testid="work-connector-attention"
            data-kind={attention.kind}
          >
            {attention.message}
          </div>
        ) : null}
        {connected && (row.skipped_records ?? 0) > 0 ? (
          <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-connector-skipped">
            {t("work.connectors.skipped", { count: row.skipped_records ?? 0, n: (row.skipped_records ?? 0).toLocaleString() })}
          </div>
        ) : null}
        {needsSetup ? (
          <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-connector-setup-hint">
            {t("work.connectors.setup_hint", { action: setupLabel(row.id) })}
          </div>
        ) : null}
        {connected && props.health !== undefined ? (
          <div className={cn("mt-0.5 text-[12px]", problem ? "text-destructive" : "text-muted-foreground")} data-testid="work-connector-health">
            {props.health === null ? t("work.connectors.no_health") : problem ? problem.text : t("work.connectors.health_ok")}
          </div>
        ) : null}
      </div>
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
      {connected ? (
        <label className="me-2 flex items-center gap-2 text-[12px] text-muted-foreground">
          {t("work.connectors.data_sync")}
          <Switch
            aria-label={t("work.connectors.data_sync_for", { name })}
            checked={row.sync_enabled}
            disabled={props.busy}
            onCheckedChange={(checked: boolean) => props.onSync(checked)}
          />
        </label>
      ) : null}
      {connected && props.onCheck ? (
        <Button variant="ghost" size="sm" aria-label={t("work.connectors.check_name", { name })} disabled={props.checking} onClick={props.onCheck}>{props.checking ? t("work.connectors.checking") : t("work.connectors.check")}</Button>
      ) : null}
      {connected && attention?.action === "retry" && props.onRetry ? (
        <Button size="sm" aria-label={t("work.connectors.retry_sync_for", { name })} disabled={props.retrying} onClick={props.onRetry}>{props.retrying ? t("work.connectors.starting") : t("work.connectors.retry_sync")}</Button>
      ) : null}
      {connected && row.setup_url && props.onSetup ? (
        <Button variant={needsSetup || attention?.action === "setup" ? "default" : "ghost"} size="sm" onClick={props.onSetup}>{attention?.action === "setup" ? t("work.connectors.open_setup") : setupLabel(row.id)}</Button>
      ) : null}
      {connected && reconnect ? (
        <Button size="sm" aria-label={t("work.connectors.reconnect_name", { name })} disabled={props.busy || props.connecting} onClick={props.onConnect}>{t("work.connectors.reconnect")}</Button>
      ) : null}
      {connected ? (
        <Button variant="outline" size="sm" aria-label={t("work.connectors.disconnect_name", { name })} disabled={props.busy} onClick={props.onDisconnect}>{t("work.connectors.disconnect")}</Button>
      ) : (
        <Button size="sm" aria-label={t("work.connectors.connect_name", { name })} disabled={props.busy || props.connecting} onClick={props.onConnect}>{t("work.common.connect")}</Button>
      )}
      </div>
    </div>
  );
}

const IMESSAGE_FDA_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

function imessageRowidKey(client: WorkClient | null) {
  return `omnirush-imessage-rowid:${client?.baseUrl?.trim() || "default"}`;
}

/** The server takes at most 2,000 records and 20 MB per iMessage push: slices well under both (JSON length is
 *  UTF-16 units; a unit is at most 3 bytes of UTF-8). Each record is a whole chat-day, so no record is split. */
export function importBatches<T>(records: T[], maxRecords = 500, maxChars = 6_000_000): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let chars = 0;
  for (const record of records) {
    const size = JSON.stringify(record).length;
    if (batch.length && (batch.length >= maxRecords || chars + size > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(record);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** iMessage has no API and nothing on a server: it is read only from the
 *  Mac's local Messages database, after the user grants Full Disk Access.
 *  macOS desktop only (the Connectors page shows it nowhere else). */
export function IMessageCard(props: { client: WorkClient | null; openLink: (url: string) => void }) {
  const queryClient = useQueryClient();
  const [fdaNeeded, setFdaNeeded] = useState(false);
  const countKey = ["omnirush-imessage-count", props.client?.baseUrl?.trim() || "default"];
  const count = useQuery({
    queryKey: countKey,
    queryFn: () => props.client!.getIMessageCount(),
    enabled: Boolean(props.client),
  });
  const run = useMutation({
    mutationFn: async () => {
      const since = Number(localStorage.getItem(imessageRowidKey(props.client))) || 0;
      const result = await desktopBridge.workImessageRead(since);
      if (result.status === "error") {
        setFdaNeeded(result.code === "fda_required");
        throw new Error(
          result.code === "no_messages_db"
            ? t("work.imessage.no_db")
            : result.code === "unsupported_os"
              ? t("work.imessage.mac_only")
              : t("work.imessage.fda_needed"),
        );
      }
      setFdaNeeded(false);
      // The read position moves only once every slice is in: a failed push is read and sent again next time.
      for (const batch of importBatches(result.records)) await props.client!.importIMessage(batch);
      if (result.lastRowid > since) {
        localStorage.setItem(imessageRowidKey(props.client), String(result.lastRowid));
      }
      return result;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: countKey });
      toast.success(result.records.length > 0 ? t("work.imessage.imported", { count: result.messageCount, n: result.messageCount.toLocaleString() }) : t("work.imessage.no_new"));
    },
    onError: (reason) => toast.error(workFailure(reason).text),
  });
  const records = count.data?.records ?? 0;
  return (
    <div className="rounded-xl border border-border bg-background p-4" data-work-connector="imessage" data-testid="work-imessage-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <MessageSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">iMessage</span>
            <Badge variant="secondary">{t("work.imessage.local_import")}</Badge>
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-imessage-count">
            {records > 0 ? t("work.imessage.synced_days", { count: records, n: records.toLocaleString() }) : t("work.imessage.intro")}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate()} data-testid="work-imessage-import">
          {run.isPending ? t("work.imessage.reading") : records > 0 ? t("work.imessage.sync_new") : t("work.imessage.import")}
        </Button>
      </div>
      {fdaNeeded ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-[12px]" data-testid="work-imessage-fda">
          <p className="text-muted-foreground">
            {t("work.imessage.fda_steps")}
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => props.openLink(IMESSAGE_FDA_URL)}>
              {t("work.imessage.open_settings")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
              {t("work.common.try_again")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Work > Connectors (also reachable from Settings): each source's status, record count, last sync and sync switch. */
export function WorkConnectorsPage(props: { client: WorkClient | null; openLink: (url: string) => void; onBack?: () => void; backLabel?: string; notice?: ReactNode }) {
  const queryClient = useQueryClient();
  const key = workConnectorsKey(props.client);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<OmniRushWorkConnector | null>(null);
  const [health, setHealth] = useState<Record<string, OmniRushWorkHealth | null>>({});
  const connectStarted = useRef(0);
  const query = useQuery({
    queryKey: key,
    queryFn: () => props.client!.listWorkConnectors(),
    enabled: Boolean(props.client),
    refetchInterval: connecting ? CONNECT_POLL_MS : false,
  });
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
  const connect = useMutation({
    mutationFn: (id: string) => props.client!.startWorkConnector(id),
    onSuccess: (answer, id) => {
      connectStarted.current = Date.now();
      setConnecting(id);
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
  const retry = useMutation({
    mutationFn: (id: string) => props.client!.syncWorkConnector(id),
    onSuccess: () => {
      toast.success(t("work.common.sync_started"));
      void refresh();
    },
    onError,
  });
  const rows = visibleConnectors(query.data);
  const busy = connect.isPending || disconnect.isPending || sync.isPending;
  const failure = query.error ? workFailure(query.error) : null;
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
        <div className="rounded-xl border border-border bg-background">
          {query.isLoading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">{t("common.loading")}</div>
          ) : failure ? (
            <div className="flex flex-col items-start gap-2 px-4 py-4" data-testid="work-connectors-error">
              <span className="text-sm text-muted-foreground">{failure.text}</span>
              {failure.retry ? <Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t("work.common.try_again")}</Button> : null}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">{t("work.connectors.none")}</div>
          ) : rows.map((row) => (
            <ConnectorRow
              key={row.id}
              connector={row}
              connecting={connecting === row.id}
              busy={busy}
              onConnect={() => connect.mutate(row.id)}
              onDisconnect={() => setConfirmDisconnect(row)}
              onSync={(enabled) => sync.mutate({ id: row.id, enabled })}
              onSetup={row.setup_url ? () => props.openLink(row.setup_url!) : undefined}
              health={health[row.id]}
              checking={check.isPending && check.variables === row.id}
              onCheck={() => check.mutate(row.id)}
              retrying={retry.isPending && retry.variables === row.id}
              onRetry={() => retry.mutate(row.id)}
            />
          ))}
        </div>
        {isDesktopRuntime() && isMacPlatform() ? <IMessageCard client={props.client} openLink={props.openLink} /> : null}
      </div>
      <ConfirmModal
        open={confirmDisconnect !== null}
        title={t("work.connectors.disconnect_title", { name: confirmDisconnect ? connectorLabel(confirmDisconnect.id, confirmDisconnect.label) : "" })}
        message={t("work.connectors.disconnect_body")}
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
      className="flex h-9 max-h-9 min-w-9 shrink-[4] items-center gap-1.5 overflow-hidden rounded-md px-2.5 text-sm text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
    >
      {connected.length ? connected.slice(0, 3).map((row) => <ConnectorIcon key={row.id} id={row.id} className="size-3.5 text-current" />) : <Plug aria-hidden className="size-4 shrink-0" />}
      <span className="min-w-0 truncate whitespace-nowrap">{label}</span>
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

/** A Work chat whose engine has no hosted Work tools (the agent would only see local files): says so, with Fix. */
export function WorkToolsBanner(props: { workChat?: boolean; client: WorkClient | null }) {
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
    <div role="status" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-7/50 bg-amber-2/50 px-3 py-2 text-[13px] text-amber-11" data-testid="work-tools-banner">
      <Plug aria-hidden className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{t("work.tools.banner")}</span>
        {query.data.reason ? <span className="text-amber-11/80"> {query.data.reason}</span> : null}
      </div>
      <Button size="sm" variant="outline" disabled={fix.isPending} onClick={() => fix.mutate()} data-testid="work-tools-fix">{fix.isPending ? t("work.tools.fixing") : t("work.today.fix")}</Button>
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
