/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, BookOpen, Briefcase, Calculator, Cloud, Code2, Database, FileText, Github, Handshake, Hash, Kanban, Mail, Plug, Shapes, Sparkles, Ticket,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import type { OmniRushWorkConnector, OmniRushWorkHealth, OmniRushWorkStarter } from "@/app/lib/omnirush-server";
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
import { COMPOSER_BOTTOM, COMPOSER_GUTTER, COMPOSER_WIDTH } from "@/react-app/domains/session/surface/composer/composer";

import {
  connectorAccess, connectorLabel, connectorsBackState, connectSettled, countLabel, healthFor, healthProblem, setupLabel, useWorkState, visibleConnectors, WORK_CONNECTORS_ROUTE,
  sourceErrorText, workConnectorsKey, workStateKey, type AppMode, type WorkClient,
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
      aria-label="Mode"
      title={`Switch between Code and Work (${props.shortcut})`}
      data-app-mode={props.mode}
      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 mac:titlebar-no-drag"
    >
      {option("code", "Code", <Code2 />)}
      {option("work", "Work", <Briefcase />)}
    </div>
  );
}

/** Work home: "What do you want to get done?" and the first-run checklist above the real chat composer (passed in, the
 *  same one the running Work chat uses), with up to three tailored starter chips from onboarding just above it. */
export function WorkHome(props: {
  composer: ReactNode;
  onStart: (prompt: string) => Promise<void>;
  busy?: boolean;
  message?: string | null;
  starters?: OmniRushWorkStarter[];
  /** The "Sample data" badge while the demo source is seeded. */
  badge?: ReactNode;
  checklist?: ReactNode;
}) {
  const [starting, setStarting] = useState(false);
  const busy = Boolean(props.busy) || starting;
  const start = async (prompt: string) => {
    if (busy) return;
    setStarting(true);
    try {
      await props.onStart(prompt);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The chat could not be started.");
    } finally {
      setStarting(false);
    }
  };
  const starters = (props.starters ?? []).slice(0, 3);
  return (
    <div className="flex h-full flex-col" data-testid="work-home">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(COMPOSER_GUTTER, "flex min-h-full flex-col justify-center py-8")}>
          <div className="mx-auto flex w-full max-w-[800px] flex-col items-center gap-4" data-testid="work-home-column">
            <div className="space-y-1.5 text-center">
              <h1 className="text-balance text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">What do you want to get done?</h1>
              <p className="text-[13px] text-muted-foreground">Ask about your email, documents, customers or invoices.</p>
            </div>
            {props.badge}
            {props.checklist ? <div className="w-full max-w-[420px]">{props.checklist}</div> : null}
          </div>
        </div>
      </div>
      <div className={cn(COMPOSER_GUTTER, COMPOSER_BOTTOM, "mb-2 shrink-0 pt-1")}>
        <div className={cn(COMPOSER_WIDTH, "flex flex-col gap-2")}>
          {starters.length ? (
            <div className="flex flex-wrap gap-2" data-testid="work-starters">
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
          ) : null}
          {props.composer}
          {props.message ? <p className="text-center text-[12px] text-muted-foreground">{props.message}</p> : null}
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<OmniRushWorkConnector["status"], string> = {
  connected: "Connected",
  syncing: "Importing history",
  error: "Needs attention",
  disconnected: "Not connected",
  unavailable: "Unavailable",
};

function lastSync(value: string | null): string {
  if (!value) return "Not synced yet";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "Not synced yet" : `Last sync ${at.toLocaleString()}`;
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
}) {
  const row = props.connector;
  const name = connectorLabel(row.id, row.label);
  const connected = row.status === "connected" || row.status === "syncing" || row.status === "error";
  const problem = healthProblem(props.health ?? null);
  const reconnect = row.status === "error" || Boolean(problem?.reconnect);
  // Connected and caught up with nothing to read: for GitHub, the App is not installed on any repository yet.
  const needsSetup = Boolean(row.setup_url) && row.status === "connected" && row.records === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-connector={row.id} data-status={row.status}>
      <ConnectorIcon id={row.id} />
      {/* The text keeps at least 16rem; on a narrow window the controls wrap under it instead of squeezing it. */}
      <div className="min-w-[16rem] flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <Badge variant={row.status === "error" ? "destructive" : row.status === "disconnected" ? "outline" : "secondary"} data-testid="work-connector-status">
            {props.connecting ? "Waiting for sign-in…" : STATUS_LABEL[row.status]}
          </Badge>
        </div>
        <div className="mt-0.5 break-words text-[12px] text-muted-foreground">
          {row.status === "error"
            ? sourceErrorText(row.error)
            : connected
              ? [row.account, countLabel(row.records, "record"), lastSync(row.last_sync_at)].filter(Boolean).join(" · ")
              : connectorAccess(row.id)}
        </div>
        {needsSetup ? (
          <div className="mt-0.5 text-[12px] text-muted-foreground" data-testid="work-connector-setup-hint">
            Nothing to read yet. {setupLabel(row.id)} to pick what OmniRush can see.
          </div>
        ) : null}
        {connected && props.health !== undefined ? (
          <div className={cn("mt-0.5 text-[12px]", problem ? "text-destructive" : "text-muted-foreground")} data-testid="work-connector-health">
            {props.health === null ? "No health report for this source yet." : problem ? problem.text : "All checks passed."}
          </div>
        ) : null}
      </div>
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
      {connected ? (
        <label className="me-2 flex items-center gap-2 text-[12px] text-muted-foreground">
          Data sync
          <Switch
            aria-label={`Data sync for ${name}`}
            checked={row.sync_enabled}
            disabled={props.busy}
            onCheckedChange={(checked: boolean) => props.onSync(checked)}
          />
        </label>
      ) : null}
      {connected && props.onCheck ? (
        <Button variant="ghost" size="sm" aria-label={`Check ${name}`} disabled={props.checking} onClick={props.onCheck}>{props.checking ? "Checking…" : "Check"}</Button>
      ) : null}
      {connected && row.setup_url && props.onSetup ? (
        <Button variant={needsSetup ? "default" : "ghost"} size="sm" onClick={props.onSetup}>{setupLabel(row.id)}</Button>
      ) : null}
      {connected && reconnect ? (
        <Button size="sm" aria-label={`Reconnect ${name}`} disabled={props.busy || props.connecting} onClick={props.onConnect}>Reconnect</Button>
      ) : null}
      {connected ? (
        <Button variant="outline" size="sm" aria-label={`Disconnect ${name}`} disabled={props.busy} onClick={props.onDisconnect}>Disconnect</Button>
      ) : (
        <Button size="sm" aria-label={`Connect ${name}`} disabled={props.busy || props.connecting} onClick={props.onConnect}>Connect</Button>
      )}
      </div>
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
      toast.error("Sign-in did not finish. Try connecting again.");
    }
  }, [connecting, query.data]);
  const onError = (reason: unknown) => {
    toast.error(reason instanceof Error ? reason.message : "That did not work. Try again.");
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
  const rows = visibleConnectors(query.data);
  const busy = connect.isPending || disconnect.isPending || sync.isPending;
  return (
    <div className="h-full overflow-y-auto" data-testid="work-connectors">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pb-10 pt-10">
        <div>
          {props.onBack ? <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? "Back to Work"}</Button> : null}
          <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect the tools your business uses. The agent can search and read them in Work chats, and asks you before it sends or changes anything. Data sync keeps a copy up to date; switch it off to stop collecting new data.
          </p>
          {props.notice ? <div className="mt-3">{props.notice}</div> : null}
        </div>
        <div className="rounded-xl border border-border bg-background">
          {query.isLoading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
          ) : query.error ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">{query.error instanceof Error ? query.error.message : "The connectors could not be loaded."}</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No connectors are available yet.</div>
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
            />
          ))}
        </div>
      </div>
      <ConfirmModal
        open={confirmDisconnect !== null}
        title={`Disconnect ${confirmDisconnect ? connectorLabel(confirmDisconnect.id, confirmDisconnect.label) : ""}?`}
        message="OmniRush signs out of it and stops syncing, and Work chats can no longer read or act in it. Records already imported stay in Knowledge and search. To pause collecting new data instead, switch Data sync off."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
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
  const label = connected.length ? countLabel(connected.length, "connector") : "Connect tools";
  return (
    <button
      type="button"
      data-testid="work-connectors-chip"
      title={connected.length ? `Connectors: ${connected.map((row) => connectorLabel(row.id, row.label)).join(", ")}` : "Connect tools"}
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
        <LayoutSectionItemTitle>Work connectors</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>Connect your mail, chat, documents, CRM, tickets and accounting for Work chats.</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-connectors" onClick={() => navigate(WORK_CONNECTORS_ROUTE)}>Open</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
