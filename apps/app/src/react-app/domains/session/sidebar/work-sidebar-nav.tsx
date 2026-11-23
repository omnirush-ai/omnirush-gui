/** @jsxImportSource react */
// The Work sidebar (enterprise design 2.4): the places as labelled rows (Home, Search, Deals, Knowledge, Automation,
// Organization, Insights) and the person's connectors with a logo, the name and where each stands ("Synced",
// "Syncing 42%", "Reconnect": always words beside the dot). A connector opens Home filtered to its items; Manage opens
// Work > Connectors. Sections fold, remembered, so the chat list keeps its height on a small window.
import { Activity, Building2, ChevronRight, Handshake, Home, Library, Mic, MoreHorizontal, Plug, Plus, Search, Settings2, Zap, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import type { OmniRushWorkConnector } from "@/app/lib/omnirush-server";
import { isMacPlatform } from "@/app/utils";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "@/react-app/domains/work/brand-icon";
import { connectorLabel, connectorProgress, isLinked, isPausedByAdmin, relativeTime, visibleConnectors } from "@/react-app/domains/work/work-mode";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";

import { SIDEBAR_SECTION_LANE } from "./sidebar-lanes";

/** Work's section labels (Work, Connectors, Chats): 12 px, a step above the Code sidebar's 11 px labels. */
export const WORK_SECTION_LABEL = "text-[12px] font-medium text-muted-foreground";

export type WorkNavigation = {
  onOpenHome: () => void; homeActive?: boolean;
  onOpenSearch?: () => void; searchActive?: boolean;
  onOpenDeals?: () => void; dealsActive?: boolean;
  onOpenMeetings?: () => void; meetingsActive?: boolean;
  onOpenOrganization: () => void; organizationActive: boolean;
  onOpenConnectors: (id?: string) => void; connectorsActive: boolean;
  onOpenKnowledge: () => void; knowledgeActive: boolean;
  onOpenActivity: () => void; activityActive: boolean;
  onOpenInsights?: () => void; insightsActive?: boolean;
  /** The person's connectors (GET /work/connectors) for the Connectors section; undefined while they load. */
  connectors?: OmniRushWorkConnector[] | null;
  /** Opens Home with only this connector's items. */
  onOpenConnector?: (id: string) => void;
  /** The connector Home is filtered to now. */
  connectorActive?: string | null;
};

/** Rows the Connectors section shows before "Show N more". */
export const SIDEBAR_CONNECTORS_SHOWN = 6;

export type ConnectorState = { tone: "ok" | "syncing" | "attention" | "error" | "off"; label: string; value: number | null };

/** Where a connector stands, in words and a tone for its dot. A sync's percent when the server says how far it got. */
export function connectorState(row: OmniRushWorkConnector): ConnectorState {
  if (isPausedByAdmin(row)) return { tone: "off", label: t("work.sidebar.off"), value: null };
  // "Reconnect" only when a new sign-in is the fix; a sync that keeps failing needs attention (Retry), not a sign-in.
  if (row.attention?.action === "reconnect" || row.attention?.kind === "reconnect" || (row.status === "error" && !row.attention)) return { tone: "error", label: t("work.sidebar.reconnect"), value: null };
  const progress = connectorProgress(row.progress);
  if (row.status === "syncing" || progress) {
    const value = progress?.value ?? null;
    return { tone: "syncing", label: value === null ? t("work.sidebar.syncing") : t("work.sidebar.syncing_percent", { n: value }), value };
  }
  if (row.attention) return { tone: row.attention.kind === "failing" || row.status === "error" ? "error" : "attention", label: t("work.sidebar.check"), value: null };
  return { tone: "ok", label: t("work.sidebar.synced"), value: null };
}

/** The connectors the section lists: connected ones and the ones the company turned off, problems first. */
export function sidebarConnectors(rows: OmniRushWorkConnector[] | null | undefined): OmniRushWorkConnector[] {
  const rank = { error: 0, attention: 1, syncing: 2, ok: 3, off: 4 } as const;
  return visibleConnectors(rows)
    .filter((row) => row.id !== "mock" && (isLinked(row) || isPausedByAdmin(row)))
    .map((row, index) => ({ row, index, tone: connectorState(row).tone }))
    .sort((a, b) => rank[a.tone] - rank[b.tone] || a.index - b.index)
    .map((entry) => entry.row);
}

// The Connectors page's StatusPill tones: syncing blue, attention amber.
const DOT = { ok: "bg-green-9", syncing: "bg-blue-9", attention: "bg-amber-9", error: "bg-red-9", off: "bg-muted-foreground/40" } as const;
// The words stay in the readable muted colour; the dot beside them carries the tone.
const TEXT = { ok: "text-muted-foreground", syncing: "text-muted-foreground", attention: "text-foreground", error: "text-foreground", off: "text-muted-foreground" } as const;

function Section(props: { id: string; label: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  const collapsed = useUiStateStore((state) => state.collapsedWorkSections.includes(props.id));
  const toggle = useUiStateStore((state) => state.toggleWorkSection);
  return (
    <div className="flex flex-col" data-testid={props.testId} data-collapsed={collapsed || undefined}>
      <div className={cn("group/work-section flex h-6 items-center", SIDEBAR_SECTION_LANE)}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => toggle(props.id)}
          className={cn("-ms-1 flex min-w-0 items-center gap-1 rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", WORK_SECTION_LABEL)}
        >
          <span className="truncate">{props.label}</span>
          <ChevronRight aria-hidden className={cn("size-3 opacity-0 transition-[opacity,transform] group-hover/work-section:opacity-100 group-focus-within/work-section:opacity-100 motion-reduce:transition-none", !collapsed && "rotate-90", collapsed && "opacity-100")} />
        </button>
        {props.action ? <span className="ms-auto flex items-center">{props.action}</span> : null}
      </div>
      {collapsed ? null : <div className="mx-2 mt-0.5 flex flex-col gap-px">{props.children}</div>}
    </div>
  );
}

function NavRow(props: { icon: LucideIcon; label: string; active?: boolean; onClick: () => void; hint?: string; testId: string }) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? "page" : undefined}
      data-active={props.active ? "" : undefined}
      data-testid={props.testId}
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-start text-[13px] text-sidebar-foreground/85 outline-none transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        "data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground",
        "mac:hover:bg-black/5 mac:data-active:bg-black/5 dark:mac:hover:bg-white/10 dark:mac:data-active:bg-white/10",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-sidebar-foreground/60" />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.hint ? <kbd className="shrink-0 font-sans text-[12px] text-muted-foreground">{props.hint}</kbd> : null}
    </button>
  );
}

function ConnectorRow(props: { row: OmniRushWorkConnector; active: boolean; onOpen: () => void; onManage: () => void }) {
  const name = connectorLabel(props.row.id, props.row.label.replace(/\s*\(.*\)$/, ""));
  const state = connectorState(props.row);
  const synced = props.row.last_sync_at ? relativeTime(props.row.last_sync_at) : "";
  const tip = [name, state.label, synced && state.tone === "ok" ? t("work.sidebar.last_sync", { when: synced }) : props.row.attention?.message ?? ""].filter(Boolean).join(" · ");
  const items = (Item: typeof DropdownMenuItem | typeof ContextMenuItem) => (
    <>
      <Item onClick={props.onOpen}><Home className="size-4" />{t("work.sidebar.show_items")}</Item>
      <Item onClick={props.onManage}><Settings2 className="size-4" />{t("work.sidebar.manage")}</Item>
    </>
  );
  const open = (
    <button
      type="button"
      onClick={props.onOpen}
      aria-current={props.active ? "page" : undefined}
      data-active={props.active ? "" : undefined}
      aria-label={`${name}, ${state.label}`}
      className={cn(
        // One height for every row; a sync's bar sits along the row's bottom edge.
        "relative flex h-[30px] w-full flex-col justify-center rounded-md px-2.5 text-start outline-none transition-colors",
        "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:bg-sidebar-accent",
        "mac:hover:bg-black/5 mac:data-active:bg-black/5 dark:mac:hover:bg-white/10 dark:mac:data-active:bg-white/10",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <ConnectorIcon id={props.row.id} className="size-4" />
        <span className={cn("min-w-0 flex-1 truncate text-[13px] text-sidebar-foreground/85", props.active && "font-medium text-sidebar-accent-foreground")}>{name}</span>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px] tabular-nums transition-opacity group-focus-within/connector:opacity-0 group-hover/connector:opacity-0", TEXT[state.tone])} data-testid="sidebar-connector-status">
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT[state.tone], state.tone === "syncing" && "motion-safe:animate-pulse")} />
          {state.label}
        </span>
      </span>
      {state.tone === "syncing" ? (
        <span aria-hidden className="absolute inset-x-2.5 bottom-0.5 ms-6 block h-0.5 overflow-hidden rounded-full bg-sidebar-border">
          <span className={cn("block h-full rounded-full bg-foreground/45", state.value === null && "w-1/4 motion-safe:animate-pulse")} style={state.value === null ? undefined : { width: `${Math.max(4, state.value)}%` }} />
        </span>
      ) : null}
    </button>
  );
  const row = (
    <div className="group/connector relative" data-sidebar-connector={props.row.id} data-tone={state.tone}>
      <Tooltip>
        <TooltipTrigger render={open} />
        <TooltipContent side="right">{tip}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("work.sidebar.options", { name })}
              className="absolute end-1 top-[3px] size-6 opacity-0 group-hover/connector:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-48">{items(DropdownMenuItem)}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-48">{items(ContextMenuItem)}</ContextMenuContent>
    </ContextMenu>
  );
}

/** The places and the connectors, as labelled rows above the chats. */
export function WorkSidebarNav(props: { nav: WorkNavigation }) {
  const nav = props.nav;
  const [all, setAll] = useState(false);
  const rows = sidebarConnectors(nav.connectors);
  const shown = all ? rows : rows.slice(0, SIDEBAR_CONNECTORS_SHOWN);
  const more = rows.length - shown.length;
  return (
    <div className="flex flex-col gap-3 pb-2 pt-1" data-testid="sidebar-work-tools">
      <Section id="nav" label={t("work.nav.work")} testId="sidebar-work-nav">
        <NavRow icon={Home} label={t("work.sidebar.home")} active={nav.homeActive && !nav.connectorActive} onClick={nav.onOpenHome} testId="sidebar-work-home" />
        {nav.onOpenSearch ? <NavRow icon={Search} label={t("work.nav.search")} active={nav.searchActive} onClick={nav.onOpenSearch} hint={isMacPlatform() ? "⌘K" : "Ctrl K"} testId="sidebar-work-search-row" /> : null}
        {nav.onOpenDeals ? <NavRow icon={Handshake} label={t("work.nav.deals")} active={nav.dealsActive} onClick={nav.onOpenDeals} testId="sidebar-work-deals" /> : null}
        {nav.onOpenMeetings ? <NavRow icon={Mic} label={t("work.nav.meetings")} active={nav.meetingsActive} onClick={nav.onOpenMeetings} testId="sidebar-work-meetings" /> : null}
        <NavRow icon={Library} label={t("work.nav.knowledge")} active={nav.knowledgeActive} onClick={nav.onOpenKnowledge} testId="sidebar-work-knowledge" />
        <NavRow icon={Zap} label={t("work.nav.automation")} active={nav.activityActive} onClick={nav.onOpenActivity} testId="sidebar-work-automation" />
        <NavRow icon={Building2} label={t("work.nav.organization")} active={nav.organizationActive} onClick={nav.onOpenOrganization} testId="sidebar-work-organization" />
        {nav.onOpenInsights ? <NavRow icon={Activity} label={t("work.nav.insights")} active={nav.insightsActive} onClick={nav.onOpenInsights} testId="sidebar-work-insights" /> : null}
      </Section>
      <Section
        id="connectors"
        label={t("work.nav.connectors")}
        testId="sidebar-work-connectors-section"
        action={(
          <button
            type="button"
            onClick={() => nav.onOpenConnectors()}
            aria-label={t("work.sidebar.add_connector")}
            title={t("work.sidebar.add_connector")}
            data-testid="sidebar-work-connectors"
            className={cn("flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring", nav.connectorsActive && "bg-sidebar-accent text-foreground")}
          >
            <Plus className="size-4" />
          </button>
        )}
      >
        {nav.connectors === undefined ? null : rows.length ? (
          <>
            {shown.map((row) => (
              <ConnectorRow
                key={row.id}
                row={row}
                active={nav.connectorActive === row.id}
                onOpen={() => (nav.onOpenConnector ? nav.onOpenConnector(row.id) : nav.onOpenConnectors(row.id))}
                onManage={() => nav.onOpenConnectors(row.id)}
              />
            ))}
            {more > 0 || all ? (
              <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className="flex h-[28px] items-center rounded-md px-2.5 ps-[34px] text-start text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring" data-testid="sidebar-connectors-more">
                {all ? t("work.today.show_less") : t("work.sidebar.show_more", { count: more })}
              </button>
            ) : null}
          </>
        ) : (
          // Nothing connected yet: a quiet line (the header's + and the home's checklist connect).
          <span className="flex h-[30px] items-center gap-2 px-2.5 text-[12px] text-muted-foreground" data-testid="sidebar-work-connect-tools">
            <Plug aria-hidden className="size-4 shrink-0 text-sidebar-foreground/50" />{t("work.sidebar.none_connected")}
          </span>
        )}
      </Section>
    </div>
  );
}
