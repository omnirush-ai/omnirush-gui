// The Work browser's live state in the renderer: the person's own tabs from the native browser, the restore list kept
// on this computer, and the new-tab address for a Work account. The person's tabs use the panel key no conversation
// owns (USER_TABS_OWNER), so no agent ever lists or drives them.
import { USER_TABS_OWNER, type BrowserPanelTab, type BrowserStatePayload } from "@omnirush/browser-tabs";
import * as React from "react";
import { create } from "zustand";

import { useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { getElectronBrowser } from "../../session/panel/utils";
import { useEnterpriseFlags } from "../enterprise-mode";
import { useCachedWorkState } from "../work-state-cache";
import { type CompanyApp, companyApps, liveTabCount, readSavedTabs, savedTabsFrom, WORK_BROWSER_NEW_TAB_URL, writeSavedTabs } from "./work-browser";

/**
 * Work chats started from Ask in the Work browser (this launch): the chat opens with the person's own tabs in its side
 * panel, the page they asked about on screen beside it. The tabs stay theirs (the panel key no conversation owns), so
 * the chat's agent never lists, reads or drives them. It ends when the chat's own browser or a record needs the panel,
 * or the panel closes.
 */
type AskBeside = { sessions: Record<string, true>; add: (sessionId: string) => void; end: (sessionId: string) => void };
export const useAskBesideStore = create<AskBeside>()((set) => ({
  sessions: {},
  add: (sessionId) => set((state) => ({ sessions: { ...state.sessions, [sessionId]: true } })),
  end: (sessionId) => set((state) => {
    if (!state.sessions[sessionId]) return state;
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions };
  }),
}));

/** Which tabs a chat's side panel shows: the person's own beside an Ask chat, else the chat's. */
export function sidePanelContentKey(chatKey: string, pageBeside: boolean): string {
  return pageBeside ? USER_TABS_OWNER : chatKey;
}

/** Tabs that came back from the restore list this launch and have not loaded yet: they load when shown. */
export const restoredTabIds = new Set<string>();
let restoreStarted = false;

/**
 * Brings the person's tabs back after a restart (unloaded: address and title, loading when selected) and keeps the
 * restore list in step with their tabs. A Work account in the desktop app only; the list never leaves this computer.
 */
export function useWorkBrowserRestore(enabled: boolean) {
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!enabled || !browser?.restoreSaved || !browser.onStateChange) return;
    let ready = false;
    let disposed = false;
    let timer: number | null = null;
    const persist = (state: BrowserStatePayload) => {
      if (!ready || disposed) return;
      const tabs = (state.tabs ?? []).filter((tab) => tab.ownerSessionId === USER_TABS_OWNER);
      const active = state.activeTabIdByOwner?.[USER_TABS_OWNER] ?? null;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => writeSavedTabs(savedTabsFrom(tabs, active)), 400);
    };
    const unsubscribe = browser.onStateChange(persist);
    void (async () => {
      const saved = readSavedTabs();
      if (!restoreStarted) {
        restoreStarted = true;
        try {
          if (saved.tabs.length) for (const id of await browser.restoreSaved!(saved.tabs, USER_TABS_OWNER, saved.active)) restoredTabIds.add(id);
        } catch {
          // The tabs just do not come back; the saved list stays for the next launch.
          return;
        }
      }
      ready = true;
      const state = await browser.getState?.().catch(() => null);
      if (state) persist(state);
    })();
    return () => {
      disposed = true;
      unsubscribe?.();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled]);
}

export type UserBrowserTabs = {
  /** The person's own tabs, in strip order. */
  tabs: BrowserPanelTab[];
  activeTab: BrowserPanelTab | null;
  /** Tabs holding a page right now across the app (what the live limit counts). */
  liveCount: number;
};

const EMPTY: UserBrowserTabs = { tabs: [], activeTab: null, liveCount: 0 };

export function userTabsFrom(state: BrowserStatePayload | null): UserBrowserTabs {
  if (!state) return EMPTY;
  const all = state.tabs ?? [];
  const tabs = all.filter((tab) => tab.ownerSessionId === USER_TABS_OWNER);
  const activeId = state.activeTabIdByOwner?.[USER_TABS_OWNER] ?? null;
  return { tabs, activeTab: tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null, liveCount: liveTabCount(all) };
}

/** The person's tabs as the native browser reports them. */
export function useUserBrowserTabs(): UserBrowserTabs {
  const [state, setState] = React.useState<BrowserStatePayload | null>(null);
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;
    let current = true;
    const unsubscribe = browser.onStateChange?.((next) => { if (current) setState(next); });
    void browser.getState?.().then((next) => { if (current && next) setState(next); }).catch(() => undefined);
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, []);
  return React.useMemo(() => userTabsFrom(state), [state]);
}

/** Where "New tab" lands: Browser home for a Work account, the browser's default page for everyone else. */
export function useNewBrowserTabUrl(): string | undefined {
  return useBrowserLibraryAvailable() ? WORK_BROWSER_NEW_TAB_URL : undefined;
}

/** The company's apps and name for Browser home, from the Work state the app already holds (no request of its own). */
export function useCompanyApps(): { companyName: string | null; apps: CompanyApp[] } {
  const enterprise = useEnterpriseFlags();
  const state = useCachedWorkState();
  const apps = React.useMemo(() => companyApps(state), [state]);
  return { companyName: enterprise.orgName, apps };
}
