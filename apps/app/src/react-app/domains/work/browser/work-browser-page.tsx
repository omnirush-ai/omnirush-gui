/** @jsxImportSource react */
// The Work browser (/work/browser): the person's own tabs, full size beside Work. "Your work apps, signed in, next to
// your Work." The tabs use the panel key no conversation owns, so no agent ever lists, reads or drives them. One
// toolbar row (back, forward, reload, address, star, Ask, ".."); everything else is in "..". A new tab is Browser home.
// Tabs come back after a restart unloaded and load when shown. At the live tab limit the person chooses to suspend
// their oldest tab; nothing is closed or suspended without that choice. Ask fills a Work chat composer with the page's
// title, address and selected text; nothing is sent until Send. Find in page, zoom, print and downloads are in "..";
// the browser's keyboard shortcuts act only while this page has focus (browser-basics.ts).
import { USER_TABS_OWNER, type BrowserPanelTab } from "@omnirush/browser-tabs";
import { BookMarked, ChevronDown, ChevronRight, Copy, Download, ExternalLink, Globe, Loader2, MessageSquareText, Minus, Moon, MoreHorizontal, Plus, Printer, Search, SlidersHorizontal, X, ZoomIn } from "lucide-react";
import * as React from "react";

import type { BrowserDownload, BrowserShortcutAction } from "@/app/lib/desktop";

import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { LoginSyncCard, useImportOfferVisit } from "../../browser-logins/login-sync-card";
import { BrowserImportDialog } from "../../browser-logins/import-dialog";
import { BookmarkBrowser, BrowserLibraryBar } from "../../session/panel/browser-library-bar";
import {
  agentWorkingIn,
  BrowserAddressField,
  BrowserAgentStrip,
  BrowserApprovalOverlay,
  BrowserNavButtons,
  BrowserPageStill,
  reportBrowserError,
  useNativeBrowserView,
} from "../../session/panel/browser-surface";
import { getElectronBrowser } from "../../session/panel/utils";
import { BrowserHome } from "./browser-home";
import { shortcutHint, useBrowserDownloads, useWorkBrowserShortcuts, zoomPercent } from "./browser-basics";
import { DownloadsView, useDownloadNotices } from "./browser-downloads";
import { FindBar, type FindBarHandle } from "./find-bar";
import { TabMark } from "./tab-mark";
import { restoredTabIds, useCompanyApps, useUserBrowserTabs } from "./use-work-browser";
import { askPagePrompt, isBrowserHomeTab, LIVE_TAB_LIMIT, openSiteSettings, siteHost, siteSettingsAvailable, WORK_BROWSER_NEW_TAB_URL } from "./work-browser";

export type WorkBrowserPageProps = {
  /** Starts a Work chat with this text. Called only when the person presses Send in Ask. */
  onAsk: (prompt: string) => Promise<void>;
  /** Opens a page in the person's default browser. */
  openExternal: (url: string) => void;
};

/** What waits behind the live tab limit until the person decides. */
type Pending = { kind: "new"; url?: string } | { kind: "select"; tabId: string };

/** Shown in the toolbar while there is no tab: Browser home with an empty address field. */
const NO_TAB: BrowserPanelTab = {
  id: "", type: "browser", label: "", url: "", favicon: null, status: "ready", canGoBack: false, canGoForward: false,
  ownerSessionId: USER_TABS_OWNER, siteToolCount: 0, siteTools: [], siteToolActivity: [],
};

const isTabLimit = (error: unknown) => /browser tabs open/i.test(error instanceof Error ? error.message : String(error));

export function WorkBrowserPage(props: WorkBrowserPageProps) {
  if (!getElectronBrowser()) {
    return (
      <div className="mx-auto max-w-md px-6 pt-24 text-center" data-testid="work-browser-desktop-only">
        <Globe aria-hidden className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-3 text-[13px] text-dls-secondary">{t("work_browser.desktop_only")}</p>
      </div>
    );
  }
  return (
    <TooltipProvider delay={600}>
      <WorkBrowser {...props} />
    </TooltipProvider>
  );
}

function WorkBrowser({ onAsk, openExternal }: WorkBrowserPageProps) {
  const { tabs, activeTab, liveCount } = useUserBrowserTabs();
  const company = useCompanyApps();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const findRef = React.useRef<FindBarHandle>(null);
  const [findOpen, setFindOpen] = React.useState(false);
  const focusAddressRef = React.useRef(false);
  const downloads = useBrowserDownloads();
  useDownloadNotices(downloads);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [noneToSuspend, setNoneToSuspend] = React.useState(false);
  const [ask, setAsk] = React.useState<string | null>(null);
  // While a menu or dialog covers the page, a picture of it stays in its place (the page itself steps aside).
  const [still, setStill] = React.useState<string | null>(null);
  const tab = activeTab ?? NO_TAB;
  const home = !activeTab || isBrowserHomeTab(activeTab);
  const unloaded = activeTab?.status === "suspended";
  // A tab back from the last session loads by itself once it is on screen, unless the limit holds it.
  const restoring = Boolean(unloaded && activeTab && restoredTabIds.has(activeTab.id) && !pending);
  useNativeBrowserView(contentRef, USER_TABS_OWNER, !activeTab || home, { onStill: setStill });
  // The import offer shows in one visit to this page at most.
  useImportOfferVisit();

  // The person's tabs take the screen while this page is open (the side panel of Work pages uses the same key).
  React.useEffect(() => {
    void getElectronBrowser()?.setVisibleSession?.(USER_TABS_OWNER);
  }, []);

  const atLimit = liveCount >= LIVE_TAB_LIMIT;
  const run = React.useCallback(async (next: Pending) => {
    const browser = getElectronBrowser();
    try {
      if (next.kind === "new") await browser?.createTab?.(next.url ?? WORK_BROWSER_NEW_TAB_URL, USER_TABS_OWNER);
      else {
        restoredTabIds.delete(next.tabId);
        await browser?.selectTab?.(next.tabId);
      }
    } catch (error) {
      if (isTabLimit(error)) setPending(next);
      else reportBrowserError(error);
    }
  }, []);
  const open = React.useCallback((next: Pending) => {
    if (atLimit) {
      setNoneToSuspend(false);
      setPending(next);
      return;
    }
    void run(next);
  }, [atLimit, run]);
  const newTab = React.useCallback((url?: string) => open({ kind: "new", url }), [open]);
  const selectTab = React.useCallback((target: BrowserPanelTab) => {
    if (target.status === "suspended") open({ kind: "select", tabId: target.id });
    else void run({ kind: "select", tabId: target.id });
  }, [open, run]);

  React.useEffect(() => {
    if (activeTab && restoring) open({ kind: "select", tabId: activeTab.id });
  }, [activeTab, open, restoring]);

  const suspendOldest = React.useCallback(async () => {
    const waiting = pending;
    try {
      const suspended = await getElectronBrowser()?.suspendOldest?.(USER_TABS_OWNER);
      if (!suspended) {
        setNoneToSuspend(true);
        return;
      }
      setPending(null);
      if (waiting) await run(waiting);
    } catch (error) {
      reportBrowserError(error);
    }
  }, [pending, run]);

  // Home tiles open in this tab; Cmd or Ctrl click, or no tab yet, opens a new one.
  const openFromHome = React.useCallback((url: string, options?: { newTab?: boolean }) => {
    if (!activeTab || options?.newTab) newTab(url);
    else void getElectronBrowser()?.navigate?.(url).catch(reportBrowserError);
  }, [activeTab, newTab]);

  const startAsk = React.useCallback(async () => {
    if (!activeTab) return;
    try {
      const page = await getElectronBrowser()?.pageContext?.(activeTab.id);
      setAsk(askPagePrompt(page ?? { title: activeTab.label, url: activeTab.url, selection: "" }, t("work_browser.ask_label")));
    } catch {
      setAsk(askPagePrompt({ title: activeTab.label, url: activeTab.url, selection: "" }, t("work_browser.ask_label")));
    }
  }, [activeTab]);
  const pageOpen = Boolean(activeTab && /^https?:\/\//i.test(activeTab.url) && activeTab.status !== "suspended");
  const pageTabId = pageOpen && activeTab ? activeTab.id : null;

  // The browser's keys while this page has focus. Keys pressed on the web page itself arrive from the desktop app.
  const runShortcut = React.useCallback((action: BrowserShortcutAction, url?: string) => {
    const browser = getElectronBrowser();
    switch (action) {
      case "address":
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      case "new-tab":
      case "open-tab":
        focusAddressRef.current = action === "new-tab";
        newTab(url);
        return;
      case "close-tab":
        if (activeTab) void browser?.closeTab?.(activeTab.id)?.catch(reportBrowserError);
        return;
      case "reload":
        if (activeTab?.status === "suspended") selectTab(activeTab);
        else if (pageTabId) void browser?.reload?.()?.catch(reportBrowserError);
        return;
      case "back":
        if (activeTab?.canGoBack) void browser?.back?.()?.catch(reportBrowserError);
        return;
      case "forward":
        if (activeTab?.canGoForward) void browser?.forward?.()?.catch(reportBrowserError);
        return;
      case "find":
        if (!pageTabId) return;
        if (findOpen) findRef.current?.focus();
        else setFindOpen(true);
        return;
      case "print":
        if (pageTabId) void browser?.print?.(pageTabId)?.catch(reportBrowserError);
        return;
      case "zoom-in":
      case "zoom-out":
      case "zoom-reset":
        if (pageTabId) void browser?.zoom?.(pageTabId, action === "zoom-in" ? "in" : action === "zoom-out" ? "out" : "reset")?.catch(reportBrowserError);
        return;
      default:
    }
  }, [activeTab, findOpen, newTab, pageTabId, selectTab]);
  useWorkBrowserShortcuts(rootRef, runShortcut);

  // The browser takes the keyboard when it opens (unless the person is typing somewhere), so its keys work at once.
  React.useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  // A new tab from the keyboard: the address field, ready to type in.
  React.useEffect(() => {
    if (!focusAddressRef.current || !home) return;
    focusAddressRef.current = false;
    inputRef.current?.focus();
  }, [activeTab?.id, home]);
  // Find belongs to the page it searched: another tab, or no page, closes it.
  React.useEffect(() => {
    setFindOpen(false);
  }, [activeTab?.id]);

  // One bar under the toolbar at a time: whatever needs an answer, in this order, and the offer to import only when
  // nothing else does.
  const notice = [
    pending ? (
      <LimitBar
        none={noneToSuspend}
        onSuspend={() => void suspendOldest()}
        onDismiss={() => {
          // A held tab from the last session now waits for Load page instead of loading by itself.
          if (pending.kind === "select") restoredTabIds.delete(pending.tabId);
          setPending(null);
          setNoneToSuspend(false);
        }}
      />
    ) : null,
  ].find(Boolean) ?? (activeTab && !home ? <LoginSyncCard visit /> : null);

  return (
    <div ref={rootRef} tabIndex={-1} className="flex h-full min-h-0 flex-col bg-background outline-none" data-testid="work-browser" data-work-browser="">
      <TabStrip tabs={tabs} activeTab={activeTab} onSelect={selectTab} onNew={() => newTab()} />
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2" data-testid="work-browser-toolbar">
        <BrowserNavButtons tab={tab} />
        <BrowserAddressField
          tab={tab}
          inputRef={inputRef}
          blankAsEmpty
          compact
          placeholder={t("work_browser.address")}
          onNavigate={activeTab ? undefined : (url) => newTab(url)}
          className="h-8 rounded-lg"
          inputClassName="h-8 text-[13px]"
        />
        {activeTab && !home ? <BrowserLibraryBar sessionId={USER_TABS_OWNER} tab={activeTab} inputRef={inputRef} page /> : null}
        {home ? null : (
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px]" disabled={!pageOpen} aria-pressed={ask !== null} onClick={() => void startAsk()} data-testid="work-browser-ask">
                  <MessageSquareText />
                  {t("work_browser.ask")}
                </Button>
              )}
            />
            <TooltipContent>{t("work_browser.ask_title")}</TooltipContent>
          </Tooltip>
        )}
        <MoreMenu
          tab={activeTab}
          openExternal={openExternal}
          pageTabId={pageTabId}
          downloads={downloads}
          onFind={() => runShortcut("find")}
          onPrint={() => runShortcut("print")}
        />
      </div>
      {findOpen && pageTabId && activeTab ? <FindBar ref={findRef} tabId={pageTabId} url={activeTab.url} onClose={() => setFindOpen(false)} /> : null}
      {notice}
      {activeTab && agentWorkingIn(activeTab) ? <BrowserAgentStrip tab={activeTab} /> : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div ref={contentRef} className="relative h-full overflow-hidden" data-browser-page="">
            {activeTab && !home && !unloaded ? <BrowserPageStill still={still} /> : null}
            {activeTab && unloaded ? (
              restoring ? (
                <div className="flex h-full items-center justify-center gap-2 text-[13px] text-dls-secondary">
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                  <span className="max-w-[60%] truncate">{tabTitle(activeTab)}</span>
                </div>
              ) : <UnloadedNotice tab={activeTab} onLoad={() => selectTab(activeTab)} />
            ) : null}
          </div>
          {home ? (
            <div className="absolute inset-0">
              <BrowserHome companyName={company.companyName} apps={company.apps} onOpen={openFromHome} />
            </div>
          ) : null}
          {activeTab ? <BrowserApprovalOverlay tab={activeTab} /> : null}
        </div>
        {ask !== null ? <AskPanel draft={ask} onDraftChange={setAsk} onClose={() => setAsk(null)} onSend={onAsk} /> : null}
      </div>
    </div>
  );
}

function tabTitle(tab: BrowserPanelTab): string {
  return isBrowserHomeTab(tab) ? t("work_browser.new_tab") : tab.label || siteHost(tab.url);
}

/** The person's tabs. Past 8, or once they no longer fit, "All tabs (n)" lists every one. */
function TabStrip(props: { tabs: BrowserPanelTab[]; activeTab: BrowserPanelTab | null; onSelect: (tab: BrowserPanelTab) => void; onNew: () => void }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState(false);
  React.useEffect(() => {
    const strip = scrollRef.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflow(strip.scrollWidth > strip.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    measure();
    return () => observer.disconnect();
  }, [props.tabs.length]);
  React.useEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>("[data-active-tab]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeTab?.id]);
  const close = (tab: BrowserPanelTab) => { void getElectronBrowser()?.closeTab?.(tab.id); };
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/30 px-2" data-testid="work-browser-tabs">
      <div ref={scrollRef} className={cn("no-scrollbar min-w-0 flex-1 overflow-x-auto", overflow && "mask-r-from-[calc(100%-2rem)]")}>
        <PanelTabList values={props.tabs.map((tab) => tab.id)} onReorder={() => undefined} className="w-full min-w-0">
          {props.tabs.length === 0 ? (
            <PanelTabItem value="new" className="w-44">
              <PanelTab active aria-current="page" className="pr-2 text-[13px]"><Globe />{t("work_browser.new_tab")}</PanelTab>
            </PanelTabItem>
          ) : props.tabs.map((tab) => {
            const active = tab.id === props.activeTab?.id;
            const title = tabTitle(tab);
            const unloaded = tab.status === "suspended";
            return (
              <PanelTabItem key={tab.id} value={tab.id} className="w-auto min-w-[156px] max-w-[232px] shrink basis-[232px]">
                <div className="relative" data-active-tab={active ? "" : undefined}>
                  <PanelTab
                    active={active}
                    onClick={() => props.onSelect(tab)}
                    title={unloaded ? `${title}\n${tab.url}\n${t("work_browser.unloaded")}` : `${title}\n${tab.url}`}
                    aria-label={t("work_browser.select_tab", { title })}
                    aria-current={active ? "page" : undefined}
                    className={cn("text-[13px]", !active && "text-dls-secondary")}
                    data-testid="work-browser-tab"
                  >
                    <span className={cn("flex shrink-0 [&_svg]:size-3.5", unloaded && "opacity-60")}><TabMark tab={tab} /></span>
                    <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                  </PanelTab>
                  <PanelTabClose active={active} label={title} onClose={() => close(tab)} />
                </div>
              </PanelTabItem>
            );
          })}
        </PanelTabList>
      </div>
      {overflow || props.tabs.length > 8 ? <AllTabs tabs={props.tabs} activeId={props.activeTab?.id ?? null} onSelect={props.onSelect} /> : null}
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button variant="ghost" size="icon-sm" onClick={props.onNew} aria-label={t("work_browser.new_tab")} data-testid="work-browser-new-tab">
              <Plus />
            </Button>
          )}
        />
        <TooltipContent>{t("work_browser.new_tab")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function AllTabs(props: { tabs: BrowserPanelTab[]; activeId: string | null; onSelect: (tab: BrowserPanelTab) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[13px] text-dls-secondary" data-testid="work-browser-all-tabs">
            {t("work_browser.all_tabs", { n: props.tabs.length })}
            <ChevronDown />
          </Button>
        )}
      />
      <PopoverContent align="end" sideOffset={6} className="w-80 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl p-1" data-browser-occluder="" data-work-browser="">
        <div className="max-h-96 overflow-y-auto" role="list">
          {props.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="listitem"
              title={tab.url}
              onClick={() => {
                setOpen(false);
                props.onSelect(tab);
              }}
              className={cn("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none [&_svg]:size-3.5", tab.id === props.activeId && "bg-muted/70 font-medium")}
            >
              <span className={cn("flex shrink-0 text-dls-secondary", tab.status === "suspended" && "opacity-60")}><TabMark tab={tab} /></span>
              <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
              <span className="max-w-[40%] shrink-0 truncate text-xs text-dls-secondary">{siteHost(tab.url)}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MenuRow(props: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; trailing?: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-dls-secondary"
      data-testid={props.testId}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.trailing}
    </button>
  );
}

/** The zoom of the page on screen: out, the percentage (back to 100%), in. Kept per site. */
function ZoomRow({ tabId, open }: { tabId: string | null; open: boolean }) {
  const [factor, setFactor] = React.useState(1);
  React.useEffect(() => {
    if (!open || !tabId) return;
    let current = true;
    void getElectronBrowser()?.zoom?.(tabId)?.then((value) => { if (current) setFactor(value.factor); }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [open, tabId]);
  const zoom = (action: "in" | "out" | "reset") => {
    if (!tabId) return;
    void getElectronBrowser()?.zoom?.(tabId, action)?.then((value) => setFactor(value.factor)).catch(reportBrowserError);
  };
  const disabled = !tabId;
  const percent = zoomPercent(factor);
  return (
    <div className={cn("flex h-9 items-center gap-2.5 rounded-lg ps-2.5 pe-1 text-[13px] text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-dls-secondary", disabled && "opacity-50")} data-testid="work-browser-menu-zoom">
      <ZoomIn aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t("work_browser.zoom")}</span>
      <Button variant="ghost" size="icon-sm" className="size-7" disabled={disabled || percent <= 50} onClick={() => zoom("out")} aria-label={t("work_browser.zoom_out")} title={t("work_browser.zoom_out")} data-testid="work-browser-zoom-out">
        <Minus />
      </Button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => zoom("reset")}
        title={t("work_browser.zoom_reset")}
        aria-label={`${t("work_browser.zoom_reset")} (${percent}%)`}
        className="h-7 min-w-12 rounded-md px-1 text-center text-[13px] tabular-nums text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none"
        data-testid="work-browser-zoom-value"
      >
        {percent}%
      </button>
      <Button variant="ghost" size="icon-sm" className="size-7" disabled={disabled || percent >= 300} onClick={() => zoom("in")} aria-label={t("work_browser.zoom_in")} title={t("work_browser.zoom_in")} data-testid="work-browser-zoom-in">
        <Plus />
      </Button>
    </div>
  );
}

const Hint = ({ letter }: { letter: string }) => <span className="shrink-0 text-xs text-dls-secondary">{shortcutHint(letter)}</span>;

type MoreMenuProps = {
  tab: BrowserPanelTab | null;
  openExternal: (url: string) => void;
  /** The tab when it shows a web page (find, zoom and print need one). */
  pageTabId: string | null;
  downloads: BrowserDownload[];
  onFind: () => void;
  onPrint: () => void;
};

/**
 * Everything that is not on the toolbar row. Groups, in order: the library (bookmarks), the tab (suspend), page tools
 * (find in page, zoom, print, downloads), and the site (its settings, default browser, copy link).
 */
function MoreMenu({ tab, openExternal, pageTabId, downloads, onFind, onPrint }: MoreMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<"menu" | "bookmarks" | "downloads">("menu");
  const downloading = downloads.filter((download) => download.state === "progressing").length;
  const [importOpen, setImportOpen] = React.useState(false);
  const page = tab && /^https?:\/\//i.test(tab.url) ? tab.url : null;
  // Closing from a sub-view (bookmarks, downloads) opens on the menu next time.
  const close = () => {
    setOpen(false);
    setView("menu");
  };
  const groups: React.ReactNode[][] = [
    [<MenuRow key="bookmarks" icon={<BookMarked />} label={t("browser_library.bookmarks")} onClick={() => setView("bookmarks")} trailing={<ChevronRight className="size-3.5!" />} testId="work-browser-menu-bookmarks" />],
    [
      <MenuRow
        key="suspend"
        icon={<Moon />}
        label={t("work_browser.suspend")}
        disabled={!tab || tab.status !== "ready" || Boolean(tab.automationProtected) || isBrowserHomeTab(tab)}
        onClick={() => {
          close();
          if (tab) void getElectronBrowser()?.suspendTab?.(tab.id).catch(reportBrowserError);
        }}
        testId="work-browser-menu-suspend"
      />,
    ],
    [
      <MenuRow key="find" icon={<Search />} label={t("work_browser.find")} disabled={!pageTabId} onClick={() => { close(); onFind(); }} trailing={<Hint letter="f" />} testId="work-browser-menu-find" />,
      <ZoomRow key="zoom" tabId={pageTabId} open={open && view === "menu"} />,
      <MenuRow key="print" icon={<Printer />} label={t("work_browser.print")} disabled={!pageTabId} onClick={() => { close(); onPrint(); }} trailing={<Hint letter="p" />} testId="work-browser-menu-print" />,
      <MenuRow
        key="downloads"
        icon={<Download />}
        label={t("work_browser.downloads")}
        onClick={() => setView("downloads")}
        trailing={(
          <span className="flex shrink-0 items-center gap-1 text-xs text-dls-secondary">
            {downloading ? t("work_browser.downloads_active", { n: downloading }) : null}
            <ChevronRight className="size-3.5!" />
          </span>
        )}
        testId="work-browser-menu-downloads"
      />,
    ],
    [
      ...(siteSettingsAvailable() ? [
        <MenuRow key="site" icon={<SlidersHorizontal />} label={t("work_browser.site_settings")} disabled={!page} onClick={() => { close(); if (page) openSiteSettings(page); }} testId="work-browser-menu-site-settings" />,
      ] : []),
      <MenuRow key="external" icon={<ExternalLink />} label={t("work_browser.open_default")} disabled={!page} onClick={() => { close(); if (page) openExternal(page); }} testId="work-browser-menu-external" />,
      <MenuRow
        key="copy"
        icon={<Copy />}
        label={t("work_browser.copy_link")}
        disabled={!page}
        onClick={() => {
          close();
          if (page) void navigator.clipboard?.writeText(page).then(() => toast.success(t("work_browser.copied")), reportBrowserError);
        }}
        testId="work-browser-menu-copy"
      />,
    ],
  ];
  return (
    <>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setView("menu"); }}>
        <Tooltip>
          <TooltipTrigger
            render={(
              <PopoverTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" className="size-8" aria-label={t("work_browser.more")} data-testid="work-browser-more">
                    <MoreHorizontal />
                  </Button>
                )}
              />
            )}
          />
          <TooltipContent>{t("work_browser.more")}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" sideOffset={6} className="w-72 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl p-0" data-browser-occluder="" data-work-browser="" data-testid="work-browser-menu">
          {view === "bookmarks" ? (
            <BookmarkBrowser sessionId={USER_TABS_OWNER} tab={null} onDone={close} onImport={() => setImportOpen(true)} onBack={() => setView("menu")} />
          ) : view === "downloads" ? (
            <DownloadsView downloads={downloads} onBack={() => setView("menu")} onDone={close} />
          ) : (
            <div className="flex flex-col p-1">
              {groups.filter((group) => group.length > 0).map((group, index) => (
                <div key={index} className={cn("flex flex-col", index > 0 && "mt-1 border-t border-border pt-1")}>{group}</div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <BrowserImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}

/** In place of a tab that holds no page (suspended, or back from the last session and held by the limit). */
function UnloadedNotice({ tab, onLoad }: { tab: BrowserPanelTab; onLoad: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" data-testid="work-browser-unloaded">
      <p className="max-w-md truncate text-[15px] font-medium text-foreground" title={tab.url}>{tabTitle(tab)}</p>
      <p className="max-w-md truncate text-[13px] text-dls-secondary">{siteHost(tab.url)}</p>
      <p className="mt-1 max-w-sm text-[13px] leading-5 text-dls-secondary">{t("work_browser.unloaded_body")}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onLoad} data-testid="work-browser-load">{t("work_browser.load")}</Button>
    </div>
  );
}

/** At the live tab limit: the person chooses to suspend their oldest tab, or not. */
function LimitBar(props: { none: boolean; onSuspend: () => void; onDismiss: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/50 px-4 py-2.5" role="alert" data-testid="work-browser-limit">
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-foreground">
        <span className="font-medium">{t("work_browser.limit_title", { n: LIVE_TAB_LIMIT })}</span>{" "}
        <span className="text-dls-secondary">{props.none ? t("work_browser.limit_none") : t("work_browser.limit_body")}</span>
      </p>
      <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[13px]" onClick={props.onDismiss}>{t("work_browser.not_now")}</Button>
      {props.none ? null : (
        <Button size="sm" className="h-7 px-3 text-[13px]" onClick={props.onSuspend} data-testid="work-browser-suspend-oldest">{t("work_browser.limit_suspend")}</Button>
      )}
    </div>
  );
}

/** Ask about this page: a Work chat composer, filled with the page's title, address and selected text. */
function AskPanel(props: { draft: string; onDraftChange: (value: string) => void; onClose: () => void; onSend: (prompt: string) => Promise<void> }) {
  const [sending, setSending] = React.useState(false);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  const send = async () => {
    const prompt = props.draft.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      await props.onSend(prompt);
      props.onClose();
    } catch (error) {
      reportBrowserError(error);
    } finally {
      setSending(false);
    }
  };
  return (
    <aside className="flex w-[clamp(280px,32%,380px)] shrink-0 flex-col border-s border-border bg-background" aria-label={t("work_browser.ask_title")} data-testid="work-browser-ask-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border ps-4 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t("work_browser.ask_title")}</h2>
        <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={t("common.close")}><X /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <textarea
          ref={fieldRef}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
            if (event.key === "Escape") props.onClose();
          }}
          placeholder={t("work_browser.ask_placeholder")}
          className="field-sizing-content max-h-[60vh] min-h-36 w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-[13px] leading-5 text-foreground outline-none placeholder:text-dls-secondary focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          data-testid="work-browser-ask-input"
        />
        <p className="text-xs leading-4 text-dls-secondary">{t("work_browser.ask_hint")}</p>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void send()} disabled={sending || !props.draft.trim()} data-testid="work-browser-ask-send">
            {sending ? <Loader2 className="animate-spin" /> : null}
            {t("work_browser.send")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
