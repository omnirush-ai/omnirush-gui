import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { USER_TABS_OWNER, type BrowserPanelTab, type BrowserStatePayload } from "@omnirush/browser-tabs";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BrowserLibraryBridge } from "../src/app/lib/desktop";

// The DOM exists before any component module loads (portals decide at import time whether they can render).
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});
notifyManager.setScheduler((callback) => callback());

const tab = (id: string, owner: string | null, url: string, extra: Partial<BrowserPanelTab> = {}): BrowserPanelTab => ({
  id, type: "browser", label: url ? `Page ${id}` : "New tab", url, favicon: null, status: "ready", canGoBack: false, canGoForward: false,
  ownerSessionId: owner, siteToolCount: 0, siteTools: [], siteToolActivity: [], browserTask: { status: "idle", operation: null }, ...extra,
});

const stateOf = (tabs: BrowserPanelTab[], active: Record<string, string> = {}): BrowserStatePayload => ({ tabs, activeTabIdByOwner: active, activeTabId: null, visibleSessionId: USER_TABS_OWNER });

function fakeBrowser(initial: BrowserStatePayload, answers: { suspendOldest?: string | null } = {}) {
  const calls = { created: [] as Array<[string | undefined, string | null | undefined]>, selected: [] as string[], oldest: [] as string[], restored: [] as Array<{ entries: Array<{ url: string; title: string }>; owner: string; active: number }>, navigated: [] as string[], shown: [] as Array<string | null | undefined>, visible: [] as Array<string | null>, context: [] as string[] };
  let state = initial;
  const listeners = new Set<(next: BrowserStatePayload) => void>();
  const browser = {
    show: async (_bounds: unknown, owner?: string | null) => { calls.shown.push(owner); },
    hide: async () => undefined,
    setBounds: async () => undefined,
    setVisibleSession: async (owner: string | null) => { calls.visible.push(owner); return owner; },
    navigate: async (url: string) => { calls.navigated.push(url); },
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getState: async () => state,
    onStateChange: (callback: (next: BrowserStatePayload) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    createTab: async (url?: string, owner?: string | null) => { calls.created.push([url, owner]); return { tabId: "created" }; },
    selectTab: async (id: string) => { calls.selected.push(id); return id; },
    closeTab: async (id: string) => id,
    suspendTab: async (id: string) => id,
    suspendOldest: async (owner: string) => { calls.oldest.push(owner); return answers.suspendOldest === undefined ? "u1" : answers.suspendOldest; },
    restoreSaved: async (entries: Array<{ url: string; title: string }>, owner: string, active: number) => { calls.restored.push({ entries, owner, active }); return entries.map((_entry, index) => `r${index + 1}`); },
    pageContext: async (id: string) => { calls.context.push(id); return { title: "Shipment 4471", url: "https://tms.example.com/s/4471", selection: "ETA moved to Friday\nCall Northwind" }; },
    pageStill: async () => "data:image/jpeg;base64,c3RpbGw=",
  };
  const emit = (next: BrowserStatePayload) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  return { browser, calls, emit };
}

function libraryBridge(overrides: Partial<BrowserLibraryBridge> = {}): BrowserLibraryBridge {
  return {
    sources: async () => ({ platform: "darwin", historyDays: 90, browsers: [] }),
    inspect: async () => { throw new Error("unused"); },
    import: async () => { throw new Error("unused"); },
    onProgress: () => () => undefined,
    bookmarks: async () => [],
    topBookmarks: async () => [],
    suggest: async () => [],
    recent: async () => ({ pages: [], total: 0 }),
    isBookmarked: async () => false,
    toggleBookmark: async () => ({ bookmarked: true }),
    summary: async () => ({ imports: [], bookmarks: 0, history: 0 }),
    clear: async () => ({ imports: [], bookmarks: 0, history: 0 }),
    openFullDiskAccess: async () => true,
    ...overrides,
  };
}

type Electron = { browser?: unknown; browserLibrary?: BrowserLibraryBridge; browserSites?: unknown };

async function withDom(
  run: (helpers: { mount: (node: ReactNode) => Promise<void>; act: (work: () => unknown) => Promise<void>; queries: QueryClient }) => Promise<void>,
  electron: Electron | null,
  workState: Record<string, unknown> | null = { enabled: true },
) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: electron });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (workState) queries.setQueryData(["omnirush-work-state", "http://work.test"], workState);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  const settle = async (work: () => unknown) => {
    await act(async () => {
      await work();
      for (let index = 0; index < 40; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (index >= 4 && queries.isFetching() === 0) break;
      }
    });
  };
  try {
    await run({
      mount: (node) => settle(() => root.render(<QueryClientProvider client={queries}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>)),
      act: settle,
      queries,
    });
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: undefined });
  }
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("work browser rules", () => {
  test("the person's tabs use the panel key no conversation owns", async () => {
    const { NO_SESSION_SIDE_PANEL_KEY } = await import("../src/react-app/domains/session/panel/side-panel-session");
    expect(NO_SESSION_SIDE_PANEL_KEY).toBe(USER_TABS_OWNER);
    expect(USER_TABS_OWNER).toBe("__omnirush_no_session__");
  });

  test("company apps: https only, named, no repeats, at most 24; anything else reads as none", async () => {
    const { companyApps } = await import("../src/react-app/domains/work/browser/work-browser");
    expect(companyApps(null)).toEqual([]);
    expect(companyApps({ enabled: true })).toEqual([]);
    expect(companyApps({ browser: { apps: "nope" } })).toEqual([]);
    expect(companyApps({ browser: { apps: [
      { name: " Acme TMS ", url: "https://tms.acme.example/" },
      { name: "Plain", url: "http://intranet.acme.example/" },
      { name: "", url: "https://blank.example/" },
      { name: "Again", url: "https://tms.acme.example/" },
      { name: "Script", url: "javascript:alert(1)" },
      { url: "https://nameless.example/" },
      { name: "Linear", url: "https://linear.app/acme" },
    ] } })).toEqual([{ name: "Acme TMS", url: "https://tms.acme.example/" }, { name: "Linear", url: "https://linear.app/acme" }]);
    const many = Array.from({ length: 30 }, (_value, index) => ({ name: `App ${index}`, url: `https://app${index}.example/` }));
    expect(companyApps({ browser: { apps: many } })).toHaveLength(24);
  });

  test("tiles show the app's own logos by host, else the site's letter", async () => {
    const { siteBrand } = await import("../src/react-app/domains/work/browser/work-browser");
    expect(siteBrand("https://linear.app/acme/team")).toBe("linear");
    expect(siteBrand("https://mail.google.com/mail/u/0")).toBe("gmail");
    expect(siteBrand("https://www.google.com/")).toBe("google");
    expect(siteBrand("https://acme.atlassian.net/browse/OPS-1")).toBe("jira");
    expect(siteBrand("https://acme.sharepoint.com/sites/ops")).toBe("sharepoint");
    expect(siteBrand("https://notlinear.app/")).toBeNull();
    expect(siteBrand("https://tms.acme.example/")).toBeNull();
  });

  test("Ask puts the page's title, address and selected text in the composer, nothing else", async () => {
    const { askPagePrompt } = await import("../src/react-app/domains/work/browser/work-browser");
    expect(askPagePrompt({ title: "Shipment 4471", url: "https://tms.example.com/s/4471", selection: " ETA moved\nCall them " }, "About this page"))
      .toBe("About this page: Shipment 4471\nhttps://tms.example.com/s/4471\n\n> ETA moved\n> Call them\n\n");
    expect(askPagePrompt({ title: "", url: "https://tms.example.com/s/4471", selection: "" }, "About this page"))
      .toBe("About this page: tms.example.com\nhttps://tms.example.com/s/4471\n\n");
  });

  test("Browser home shows on a blank tab the person opened, never on an agent's tab", async () => {
    const { isBrowserHomeTab, liveTabCount } = await import("../src/react-app/domains/work/browser/work-browser");
    expect(isBrowserHomeTab(tab("a", USER_TABS_OWNER, "about:blank"))).toBe(true);
    expect(isBrowserHomeTab(tab("a", USER_TABS_OWNER, ""))).toBe(true);
    expect(isBrowserHomeTab(tab("a", USER_TABS_OWNER, "https://example.com/"))).toBe(false);
    expect(isBrowserHomeTab(tab("a", "ses_1", "about:blank", { automationProtected: true }))).toBe(false);
    expect(isBrowserHomeTab(tab("a", "ses_1", "about:blank", { browserTask: { status: "running", operation: "navigate" } }))).toBe(false);
    expect(isBrowserHomeTab(tab("a", USER_TABS_OWNER, "about:blank", { status: "suspended" }))).toBe(false);
    expect(liveTabCount([tab("a", null, "https://a.example/"), tab("b", "x", "https://b.example/", { status: "suspended" }), tab("c", "y", "https://c.example/", { status: "loading" })])).toBe(2);
  });

  test("the restore list keeps web pages only (address and title), at most 30, with the active one", async () => {
    const { readSavedTabs, savedTabsFrom, writeSavedTabs, clearWorkBrowserTabs, WORK_BROWSER_TABS_KEY } = await import("../src/react-app/domains/work/browser/work-browser");
    const tabs = [tab("a", USER_TABS_OWNER, "https://a.example/"), tab("home", USER_TABS_OWNER, "about:blank"), tab("b", USER_TABS_OWNER, "https://b.example/x", { label: "https://b.example/x" })];
    const saved = savedTabsFrom(tabs, "b");
    expect(saved).toEqual({ tabs: [{ url: "https://a.example/", title: "Page a" }, { url: "https://b.example/x", title: "" }], active: 1 });
    writeSavedTabs(saved);
    expect(readSavedTabs()).toEqual(saved);
    localStorage.setItem(WORK_BROWSER_TABS_KEY, JSON.stringify({ tabs: [{ url: "file:///etc/passwd" }, { url: "https://ok.example/", title: 7 }], active: 9 }));
    expect(readSavedTabs()).toEqual({ tabs: [{ url: "https://ok.example/", title: "" }], active: 0 });
    localStorage.setItem(WORK_BROWSER_TABS_KEY, "not json");
    expect(readSavedTabs()).toEqual({ tabs: [], active: 0 });
    const many = Array.from({ length: 40 }, (_value, index) => tab(`t${index}`, USER_TABS_OWNER, `https://t${index}.example/`));
    expect(savedTabsFrom(many, null).tabs).toHaveLength(30);
    writeSavedTabs({ tabs: [], active: 0 });
    expect(localStorage.getItem(WORK_BROWSER_TABS_KEY)).toBeNull();
    writeSavedTabs(saved);
    clearWorkBrowserTabs();
    expect(localStorage.getItem(WORK_BROWSER_TABS_KEY)).toBeNull();
  });

  test("the strip lists the person's tabs only; the limit counts live tabs of every owner", async () => {
    const { userTabsFrom } = await import("../src/react-app/domains/work/browser/use-work-browser");
    const state = stateOf([
      tab("u1", USER_TABS_OWNER, "https://a.example/"), tab("c1", "ses_chat", "https://agent.example/"), tab("u2", USER_TABS_OWNER, "https://b.example/", { status: "suspended" }), tab("s1", null, "https://shared.example/"),
    ], { [USER_TABS_OWNER]: "u2", ses_chat: "c1" });
    const user = userTabsFrom(state);
    expect(user.tabs.map((entry) => entry.id)).toEqual(["u1", "u2"]);
    expect(user.activeTab?.id).toBe("u2");
    expect(user.liveCount).toBe(3);
    expect(userTabsFrom(null)).toMatchObject({ tabs: [], activeTab: null, liveCount: 0 });
  });

  test("the Work state is read from its own query only, and never mid-render", async () => {
    const { cachedWorkState, subscribeWorkState } = await import("../src/react-app/domains/work/work-state-cache");
    const queries = new QueryClient();
    let heard = 0;
    const stop = subscribeWorkState(queries, () => { heard += 1; });
    queries.setQueryData(["omnirush-deals", "x"], { rows: [] });
    queries.setQueryData(["browser-library", "summary"], { imports: [] });
    await wait(5);
    expect(heard).toBe(0);
    queries.setQueryData(["omnirush-work-state", "http://work.test"], { enabled: true, browser: { apps: [] } });
    // Heard after the change, not while it happened (a render that adds the query never updates another one).
    expect(heard).toBe(0);
    await wait(5);
    expect(heard).toBe(1);
    const first = cachedWorkState(queries);
    expect(first).toMatchObject({ enabled: true });
    queries.setQueryData(["omnirush-deals", "x"], { rows: [1] });
    expect(cachedWorkState(queries)).toBe(first);
    stop();
    queries.clear();
  });

  test("Cmd or Ctrl+Shift+B opens the Work browser", async () => {
    const { isWorkBrowserShortcut, WORK_BROWSER_ROUTE } = await import("../src/react-app/domains/work/work-mode");
    expect(WORK_BROWSER_ROUTE).toBe("/work/browser");
    const key = (init: Partial<KeyboardEvent>) => ({ key: "B", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, ...init });
    expect(isWorkBrowserShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isWorkBrowserShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isWorkBrowserShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isWorkBrowserShortcut(key({ metaKey: true, shiftKey: false }), true)).toBe(false);
    expect(isWorkBrowserShortcut(key({ metaKey: true, key: "k" }), true)).toBe(false);
  });

  test("Work navigation gets one Browser row with no count, only when the browser is here", async () => {
    const { WorkSidebarNav } = await import("../src/react-app/domains/session/sidebar/work-sidebar-nav");
    const noop = () => undefined;
    const nav = { onOpenHome: noop, homeActive: false, onOpenSearch: noop, onOpenOrganization: noop, organizationActive: false, onOpenConnectors: noop, connectorsActive: false, onOpenKnowledge: noop, knowledgeActive: false, onOpenActivity: noop, activityActive: false };
    const markup = renderToStaticMarkup(<WorkSidebarNav nav={{ ...nav, onOpenBrowser: noop, browserActive: true }} />);
    const row = markup.match(/<button[^>]*data-testid="sidebar-work-browser"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(row).toContain(">Browser<");
    expect(row).toContain('aria-current="page"');
    // No count and no hint beside it: one quiet row.
    expect(row.replace(/<[^>]+>/g, "")).toBe("Browser");
    expect(markup.match(/sidebar-work-browser/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<WorkSidebarNav nav={nav} />)).not.toContain("sidebar-work-browser");
  });

  test("every new string has a Chinese copy, and none has a dash", () => {
    const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
    const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
    const keys = (source: string) => new Set([...source.matchAll(/"(work_browser\.[a-z_0-9]+|work\.nav\.browser)":/g)].map((match) => match[1]));
    expect(keys(en).size).toBeGreaterThan(30);
    expect([...keys(en)].filter((key) => !keys(zh).has(key))).toEqual([]);
    for (const line of en.split("\n").filter((entry) => /"(work_browser\.|work\.nav\.browser)/.test(entry))) {
      expect(line).not.toMatch(/[\u2013\u2014!]/);
      expect(line).not.toMatch(/\bAI\b|default browser\?/);
    }
  });
});

describe("bookmark tiles", () => {
  test("the panel's bookmark tiles carry the same marks as Browser home", async () => {
    const { BookmarkTiles } = await import("../src/react-app/domains/browser-logins/bookmark-tiles");
    const library = libraryBridge({ topBookmarks: async () => [{ url: "https://northwind.zendesk.com/agent", title: "Zendesk" }, { url: "https://tms.acme.example/", title: "Acme TMS" }] });
    await withDom(async ({ mount }) => {
      await mount(<BookmarkTiles onOpen={() => undefined} />);
      const tiles = [...document.querySelectorAll('[data-testid="browser-bookmark-tiles"] [data-brand-tile]')];
      expect(tiles.map((entry) => entry.getAttribute("data-brand-tile"))).toEqual(["zendesk", "custom"]);
      // No brand: the letter of the bookmark's name (A for Acme TMS), never the host's first label.
      expect(tiles[1]?.textContent).toBe("A");
    }, { browserLibrary: library, browser: fakeBrowser(stateOf([])).browser });
  });
});

describe("restore after a restart", () => {
  test("a consumer account never restores or keeps a list", async () => {
    const { WORK_BROWSER_TABS_KEY } = await import("../src/react-app/domains/work/browser/work-browser");
    const { useWorkBrowserRestore } = await import("../src/react-app/domains/work/browser/use-work-browser");
    localStorage.setItem(WORK_BROWSER_TABS_KEY, JSON.stringify({ tabs: [{ url: "https://a.example/", title: "A" }], active: 0 }));
    const fake = fakeBrowser(stateOf([]));
    function Probe() { useWorkBrowserRestore(false); return null; }
    await withDom(async ({ mount }) => {
      await mount(<Probe />);
      expect(fake.calls.restored).toEqual([]);
    }, { browser: fake.browser });
  });

  test("3 tabs come back as unloaded entries for the person's key, and the list follows their tabs (never a chat's)", async () => {
    const { WORK_BROWSER_TABS_KEY } = await import("../src/react-app/domains/work/browser/work-browser");
    const { restoredTabIds, useWorkBrowserRestore } = await import("../src/react-app/domains/work/browser/use-work-browser");
    const saved = { tabs: [{ url: "https://tms.example.com/s/4471", title: "Shipment 4471" }, { url: "https://linear.app/acme", title: "Ops" }, { url: "https://mail.google.com/", title: "Inbox" }], active: 1 };
    localStorage.setItem(WORK_BROWSER_TABS_KEY, JSON.stringify(saved));
    const fake = fakeBrowser(stateOf([]));
    function Probe() { useWorkBrowserRestore(true); return null; }
    await withDom(async ({ mount, act }) => {
      await mount(<Probe />);
      expect(fake.calls.restored).toEqual([{ entries: saved.tabs, owner: USER_TABS_OWNER, active: 1 }]);
      expect([...restoredTabIds]).toEqual(["r1", "r2", "r3"]);
      // Until the native browser reports the restored tabs, the saved list is untouched.
      expect(JSON.parse(localStorage.getItem(WORK_BROWSER_TABS_KEY)!)).toEqual(saved);
      await act(async () => {
        fake.emit(stateOf([
          tab("r1", USER_TABS_OWNER, "https://tms.example.com/s/4471", { label: "Shipment 4471", status: "suspended" }),
          tab("c1", "ses_chat", "https://agent.example/"),
          tab("r2", USER_TABS_OWNER, "https://linear.app/acme", { label: "Ops" }),
        ], { [USER_TABS_OWNER]: "r2" }));
        await wait(450);
      });
      expect(JSON.parse(localStorage.getItem(WORK_BROWSER_TABS_KEY)!)).toEqual({ tabs: [{ url: "https://tms.example.com/s/4471", title: "Shipment 4471" }, { url: "https://linear.app/acme", title: "Ops" }], active: 1 });
    }, { browser: fake.browser });
    // Once per launch: a second mount (a remounted shell) does not restore again.
    await withDom(async ({ mount }) => {
      await mount(<Probe />);
      expect(fake.calls.restored).toHaveLength(1);
    }, { browser: fake.browser });
  });
});

describe("browser home", () => {
  const pages = (n: number) => Array.from({ length: n }, (_value, index) => ({ url: `https://site${index}.example/page`, title: `Page ${index}`, lastVisitAt: Date.now() - index * 60_000 }));

  test("groups hide when empty; tiles stop at 8 and Recent at 5, then Show all (n) with a filter past 12", async () => {
    const { BrowserHome } = await import("../src/react-app/domains/work/browser/browser-home");
    const top = Array.from({ length: 20 }, (_value, index) => ({ url: `https://app${index}.example/`, title: `App ${index}` }));
    const library = libraryBridge({ topBookmarks: async () => [{ url: "https://linear.app/acme", title: "Linear" }, ...top], recent: async () => ({ pages: pages(7), total: 7 }) });
    const opened: Array<[string, unknown]> = [];
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserHome companyName="Acme Freight" apps={[{ name: "Acme TMS", url: "https://tms.acme.example/" }, { name: "Linear", url: "https://linear.app/acme" }]} onOpen={(url, options) => opened.push([url, options])} />);
      expect(byTestId("browser-home-company")?.textContent).toContain("From Acme Freight");
      expect(byTestId("browser-home-company")?.querySelector('[data-brand-tile="linear"]')).not.toBeNull();
      // A company app is not repeated under Your apps.
      const yours = byTestId("browser-home-yours")!;
      expect(yours.querySelectorAll('[data-testid="browser-home-tile"]')).toHaveLength(8);
      expect(yours.textContent).not.toContain("Linear");
      expect(byTestId("browser-home-more-yours")?.textContent).toBe("Show all (20)");
      expect(byTestId("browser-home-more-company")).toBeNull();
      expect(allByTestId("browser-home-recent-row")).toHaveLength(5);
      expect(byTestId("browser-home-more-recent")?.textContent).toBe("Show all (7)");
      expect(byTestId("browser-home-empty")).toBeNull();
      await act(() => byTestId("browser-home-more-yours")!.click());
      expect(yours.querySelectorAll('[data-testid="browser-home-tile"]')).toHaveLength(20);
      expect(byTestId("browser-home-more-yours")?.textContent).toBe("Show less");
      const filter = byTestId("browser-home-filter-yours") as HTMLInputElement;
      expect(filter).not.toBeNull();
      await act(() => typeInto(filter, "app 1"));
      // App 1 and App 10 to App 19.
      expect(yours.querySelectorAll('[data-testid="browser-home-tile"]')).toHaveLength(11);
      expect(byTestId("browser-home-filter-recent")).toBeNull();
      await act(() => (yours.querySelector('[data-testid="browser-home-tile"]') as HTMLElement).click());
      expect(opened[0]).toEqual(["https://app1.example/", undefined]);
    }, { browserLibrary: library, browser: fakeBrowser(stateOf([])).browser });
  });

  test("Recent past 50 pages: the true count, Show more with no number, 50 rows, and a filter that asks the library", async () => {
    const { BrowserHome } = await import("../src/react-app/domains/work/browser/browser-home");
    const asked: Array<{ limit?: number; query?: string }> = [];
    const library = libraryBridge({
      recent: async (request) => {
        asked.push(request);
        if (request.query) return { pages: [{ url: "https://tms.example.com/shipments/1599", title: "Shipment 1599", lastVisitAt: Date.now() - 86_400_000 * 20 }], total: 1 };
        return { pages: pages(50), total: 1600 };
      },
    });
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserHome companyName={null} apps={[]} onOpen={() => undefined} />);
      expect(allByTestId("browser-home-recent-row")).toHaveLength(5);
      // Not "Show all (50)": there are 1,600, and the list shows 50 of them.
      expect(byTestId("browser-home-more-recent")?.textContent).toBe("Show more");
      await act(() => byTestId("browser-home-more-recent")!.click());
      expect(allByTestId("browser-home-recent-row")).toHaveLength(50);
      expect(byTestId("browser-home-recent-note")?.textContent).toBe("The 50 most recent pages. Filter to find any page from the last 30 days.");
      await act(async () => {
        typeInto(byTestId("browser-home-filter-recent") as HTMLInputElement, "1599");
        await wait(260);
      });
      expect(asked.at(-1)).toEqual({ limit: 50, query: "1599" });
      expect(allByTestId("browser-home-recent-row").map((row) => row.textContent)).toEqual([expect.stringContaining("Shipment 1599")]);
      expect(byTestId("browser-home-recent-note")).toBeNull();
    }, { browserLibrary: library, browser: fakeBrowser(stateOf([])).browser });
  });

  test("nothing yet: one calm line and one action; no company group without apps", async () => {
    const { BrowserHome } = await import("../src/react-app/domains/work/browser/browser-home");
    await withDom(async ({ mount }) => {
      await mount(<BrowserHome companyName="Acme Freight" apps={[]} onOpen={() => undefined} />);
      expect(byTestId("browser-home-empty")?.textContent).toContain("Your work apps, signed in, next to your Work");
      expect(allByTestId("browser-home-import")).toHaveLength(1);
      expect(byTestId("browser-home-company")).toBeNull();
      expect(byTestId("browser-home-yours")).toBeNull();
      expect(byTestId("browser-home-recent")).toBeNull();
    }, { browserLibrary: libraryBridge(), browser: fakeBrowser(stateOf([])).browser });
  });
});

describe("the Work browser page", () => {
  const userTabs = [tab("u1", USER_TABS_OWNER, "https://tms.example.com/s/4471", { label: "Shipment 4471", canGoBack: true }), tab("u2", USER_TABS_OWNER, "https://linear.app/acme", { label: "Ops board" })];
  const withChat = stateOf([...userTabs, tab("c1", "ses_chat", "https://agent.example/", { label: "Agent page" })], { [USER_TABS_OWNER]: "u1", ses_chat: "c1" });

  test("one toolbar row, the person's tabs only, shown for their key; no agent strip on their tabs", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const fake = fakeBrowser(withChat);
    await withDom(async ({ mount }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      expect(allByTestId("work-browser-tab").map((entry) => entry.textContent)).toEqual(["Shipment 4471", "Ops board"]);
      expect(document.body.textContent).not.toContain("Agent page");
      const toolbar = byTestId("work-browser-toolbar")!;
      const controls = [...toolbar.querySelectorAll("button, input")].map((element) => element.getAttribute("aria-label") ?? element.getAttribute("data-testid") ?? element.textContent);
      expect(controls).toEqual(["Go back", "Go forward", "Reload page", "Type an address", "Bookmark this page", "work-browser-ask", "More"]);
      expect(fake.calls.visible).toContain(USER_TABS_OWNER);
      expect(document.body.textContent).not.toContain("Built-in browser");
      expect(byTestId("browser-home")).toBeNull();
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("the 13th tab asks first: Suspend oldest frees a slot, then the tab opens; nothing is evicted without it", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const chats = Array.from({ length: 10 }, (_value, index) => tab(`c${index}`, `ses_${index}`, `https://agent${index}.example/`));
    const fake = fakeBrowser(stateOf([...userTabs, ...chats], { [USER_TABS_OWNER]: "u1" }));
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => byTestId("work-browser-new-tab")!.click());
      expect(fake.calls.created).toEqual([]);
      expect(byTestId("work-browser-limit")?.textContent).toContain("12 tabs are open.");
      expect(fake.calls.oldest).toEqual([]);
      await act(() => byTestId("work-browser-suspend-oldest")!.click());
      expect(fake.calls.oldest).toEqual([USER_TABS_OWNER]);
      expect(fake.calls.created).toEqual([["about:blank", USER_TABS_OWNER]]);
      expect(byTestId("work-browser-limit")).toBeNull();
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
    const none = fakeBrowser(stateOf([...userTabs, ...chats], { [USER_TABS_OWNER]: "u1" }), { suspendOldest: null });
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => byTestId("work-browser-new-tab")!.click());
      await act(() => byTestId("work-browser-suspend-oldest")!.click());
      expect(none.calls.created).toEqual([]);
      expect(byTestId("work-browser-limit")?.textContent).toContain("Close a tab to open another.");
      expect(byTestId("work-browser-suspend-oldest")).toBeNull();
    }, { browser: none.browser, browserLibrary: libraryBridge() });
  });

  test("every tab has a mark: the app's logo, else the page's icon, else a globe when that icon does not load", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const fake = fakeBrowser(stateOf([
      tab("u1", USER_TABS_OWNER, "https://linear.app/acme", { label: "Ops board" }),
      tab("u2", USER_TABS_OWNER, "https://tms.example.com/s/4471", { label: "Shipment 4471", favicon: "https://tms.example.com/favicon.ico" }),
      tab("u3", USER_TABS_OWNER, "https://tms.example.com/s/4472", { label: "Shipment 4472" }),
    ], { [USER_TABS_OWNER]: "u1" }));
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      const marks = allByTestId("work-browser-tab").map((entry) => entry.querySelector("svg, img"));
      expect(marks.every(Boolean)).toBe(true);
      expect(marks[0]?.getAttribute("data-connector-icon")).toBe("linear");
      expect(marks[1]?.tagName).toBe("IMG");
      expect(marks[2]?.getAttribute("data-testid")).toBe("work-browser-tab-globe");
      await act(() => { marks[1]!.dispatchEvent(new Event("error")); });
      expect(allByTestId("work-browser-tab")[1]?.querySelector('[data-testid="work-browser-tab-globe"]')).not.toBeNull();
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("Site settings in .. opens this site's choices; it is offered only where the app keeps them", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const { WORK_BROWSER_SITE_SETTINGS_EVENT } = await import("../src/react-app/domains/work/browser/work-browser");
    const opened: string[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent<{ url: string }>).detail.url);
    window.addEventListener(WORK_BROWSER_SITE_SETTINGS_EVENT, onOpen);
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => byTestId("work-browser-more")!.click());
      await act(() => byTestId("work-browser-menu-site-settings")!.click());
      expect(opened).toEqual(["https://tms.example.com/s/4471"]);
    }, { browser: fakeBrowser(withChat).browser, browserLibrary: libraryBridge(), browserSites: { list: async () => [] } });
    window.removeEventListener(WORK_BROWSER_SITE_SETTINGS_EVENT, onOpen);
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => byTestId("work-browser-more")!.click());
      expect(byTestId("work-browser-menu-site-settings")).toBeNull();
    }, { browser: fakeBrowser(withChat).browser, browserLibrary: libraryBridge() });
  });

  test("the import offer: one bar at a time, gone after an import from anywhere, and seen after one visit", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const { usePersistedBrowserLoginsStore } = await import("../src/react-app/domains/browser-logins/browser-logins-store");
    const chrome = { platform: "darwin" as const, historyDays: 90, browsers: [{ browser: "chrome" as const, label: "Google Chrome", short: "Chrome", profiles: [{ id: "chrome:Default", name: "Work", has: { bookmarks: true, history: true, signIns: true } }], signIns: { importable: true } }] };
    const sources = async () => chrome as unknown as Awaited<ReturnType<BrowserLibraryBridge["sources"]>>;
    // At the tab limit the limit bar is the one bar: the offer waits.
    usePersistedBrowserLoginsStore.setState({ importOffer: null });
    const chats = Array.from({ length: 10 }, (_value, index) => tab(`c${index}`, `ses_${index}`, `https://agent${index}.example/`));
    const full = fakeBrowser(stateOf([...userTabs, ...chats], { [USER_TABS_OWNER]: "u1" }));
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      const offer = byTestId("browser-import-offer");
      expect(offer).not.toBeNull();
      for (const button of offer!.querySelectorAll("button")) expect(button.className).toContain("text-[13px]");
      await act(() => byTestId("work-browser-new-tab")!.click());
      expect(byTestId("work-browser-limit")).not.toBeNull();
      expect(byTestId("browser-import-offer")).toBeNull();
    }, { browser: full.browser, browserLibrary: libraryBridge({ sources }) });
    // Shown during that visit: resolved once the page closed, so the next visit has no offer.
    expect(usePersistedBrowserLoginsStore.getState().importOffer).toBe("seen");
    await withDom(async ({ mount }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      expect(byTestId("browser-import-offer")).toBeNull();
    }, { browser: fakeBrowser(withChat).browser, browserLibrary: libraryBridge({ sources }) });
    // An import made anywhere else (Settings, Browser home): no offer, and it never comes back.
    usePersistedBrowserLoginsStore.setState({ importOffer: null });
    await withDom(async ({ mount }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      expect(byTestId("browser-import-offer")).toBeNull();
    }, { browser: fakeBrowser(withChat).browser, browserLibrary: libraryBridge({ sources, summary: async () => ({ imports: [{ sourceId: "chrome:Default", browser: "chrome", label: "Google Chrome", name: "Work", importedAt: Date.now(), bookmarks: 3, history: 3, signIns: null }], bookmarks: 3, history: 3 }) }) });
    expect(usePersistedBrowserLoginsStore.getState().importOffer).toBe("imported");
    usePersistedBrowserLoginsStore.setState({ importOffer: null });
  });

  test("Ask fills the composer with the title, address and selection; nothing is sent until Send", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const fake = fakeBrowser(withChat);
    const asked: string[] = [];
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async (prompt) => { asked.push(prompt); }} openExternal={() => undefined} />);
      await act(() => byTestId("work-browser-ask")!.click());
      expect(fake.calls.context).toEqual(["u1"]);
      const field = byTestId("work-browser-ask-input") as HTMLTextAreaElement;
      expect(field.value).toBe("About this page: Shipment 4471\nhttps://tms.example.com/s/4471\n\n> ETA moved to Friday\n> Call Northwind\n\n");
      expect(asked).toEqual([]);
      await act(() => byTestId("work-browser-ask-send")!.click());
      expect(asked).toEqual(["About this page: Shipment 4471\nhttps://tms.example.com/s/4471\n\n> ETA moved to Friday\n> Call Northwind"]);
      expect(byTestId("work-browser-ask-panel")).toBeNull();
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("a tab back from the last session loads once shown; a blank tab shows Browser home with the company's apps", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const { restoredTabIds } = await import("../src/react-app/domains/work/browser/use-work-browser");
    restoredTabIds.add("r9");
    const fake = fakeBrowser(stateOf([tab("r9", USER_TABS_OWNER, "https://tms.example.com/s/4471", { label: "Shipment 4471", status: "suspended" })], { [USER_TABS_OWNER]: "r9" }));
    await withDom(async ({ mount }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      expect(fake.calls.selected).toEqual(["r9"]);
      expect(restoredTabIds.has("r9")).toBe(false);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
    const blank = fakeBrowser(stateOf([tab("h1", USER_TABS_OWNER, "about:blank")], { [USER_TABS_OWNER]: "h1" }));
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      expect(byTestId("browser-home")).not.toBeNull();
      expect(byTestId("browser-home-company")?.textContent).toContain("Acme TMS");
      expect(allByTestId("work-browser-tab").map((entry) => entry.textContent)).toEqual(["New tab"]);
      // Nothing to ask about on Browser home: no Ask, no star.
      expect(byTestId("work-browser-ask")).toBeNull();
      expect(byTestId("browser-star")).toBeNull();
      await act(() => (byTestId("browser-home-company")!.querySelector('[data-testid="browser-home-tile"]') as HTMLElement).click());
      expect(blank.calls.navigated).toEqual(["https://tms.acme.example/"]);
    }, { browser: blank.browser, browserLibrary: libraryBridge() }, { enabled: true, browser: { apps: [{ name: "Acme TMS", url: "https://tms.acme.example/" }] } });
  });
});

describe("the side panel", () => {
  test("beside an Ask chat it shows the person's own tab (still theirs), and the chat's own tabs once that ends", async () => {
    const { SidePanel: Panel } = await import("../src/react-app/domains/session/panel/side-panel");
    const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider");
    const { sidePanelContentKey, useAskBesideStore } = await import("../src/react-app/domains/work/browser/use-work-browser");
    const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");
    const SidePanel = (props: Parameters<typeof Panel>[0]) => <DenAuthProvider><Panel {...props} /></DenAuthProvider>;
    const asked = tab("u1", USER_TABS_OWNER, "https://tms.example.com/s/4471", { label: "Shipment 4471" });
    const agent = tab("c1", "ses_ask", "https://agent.example/", { label: "Agent page" });
    usePanelTabStore.getState().openTab(USER_TABS_OWNER, asked);
    usePanelTabStore.getState().openTab("ses_ask", agent);
    useAskBesideStore.getState().add("ses_ask");
    const beside = useAskBesideStore.getState().sessions.ses_ask === true;
    expect(sidePanelContentKey("ses_ask", beside)).toBe(USER_TABS_OWNER);
    const fake = fakeBrowser(stateOf([asked, agent], { [USER_TABS_OWNER]: "u1", ses_ask: "c1" }));
    await withDom(async ({ mount }) => {
      await mount(<SidePanel sessionId={sidePanelContentKey("ses_ask", beside)} client={null} workspaceId={null} workspaceRoot="" onClose={() => undefined} />);
      expect(document.body.textContent).toContain("Shipment 4471");
      expect(document.body.textContent).not.toContain("Agent page");
      // The person's own panel (their key: the agent cannot list or drive it): Expand, and no agent strip.
      expect(byTestId("browser-expand")).not.toBeNull();
      expect(document.body.textContent).not.toContain("Built-in browser");
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
    useAskBesideStore.getState().end("ses_ask");
    expect(useAskBesideStore.getState().sessions.ses_ask).toBeUndefined();
    expect(sidePanelContentKey("ses_ask", false)).toBe("ses_ask");
    usePanelTabStore.getState().clearSession(USER_TABS_OWNER);
    usePanelTabStore.getState().clearSession("ses_ask");
  });

  test("for a chat it is unchanged; on Work pages a blank tab shows Browser home, Expand moves the tab, and no agent strip", async () => {
    const { SidePanel: Panel } = await import("../src/react-app/domains/session/panel/side-panel");
    const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider");
    const SidePanel = (props: Parameters<typeof Panel>[0]) => <DenAuthProvider><Panel {...props} /></DenAuthProvider>;
    const { WORK_BROWSER_EXPAND_EVENT } = await import("../src/react-app/domains/work/browser/work-browser");
    const chat = fakeBrowser(stateOf([tab("c1", "ses_chat", "https://agent.example/")], { ses_chat: "c1" }));
    await withDom(async ({ mount }) => {
      await mount(<SidePanel sessionId="ses_chat" client={null} workspaceId={null} workspaceRoot="" onClose={() => undefined} />);
      expect(document.body.textContent).toContain("Built-in browser");
      expect(document.body.textContent).toContain("Suspend");
      expect(byTestId("browser-expand")).toBeNull();
    }, { browser: chat.browser, browserLibrary: libraryBridge() });
    // A consumer account with no chat selected: exactly as before.
    const consumer = fakeBrowser(stateOf([tab("u1", USER_TABS_OWNER, "about:blank")], { [USER_TABS_OWNER]: "u1" }));
    await withDom(async ({ mount }) => {
      await mount(<SidePanel sessionId={USER_TABS_OWNER} client={null} workspaceId={null} workspaceRoot="" onClose={() => undefined} />);
      expect(document.body.textContent).toContain("Built-in browser");
      expect(byTestId("browser-expand")).toBeNull();
      expect(byTestId("browser-home")).toBeNull();
      expect((document.querySelector('input[placeholder="Enter URL..."]') as HTMLInputElement).value).toBe("about:blank");
    }, { browser: consumer.browser, browserLibrary: libraryBridge() }, null);
    const work = fakeBrowser(stateOf([tab("u1", USER_TABS_OWNER, "about:blank")], { [USER_TABS_OWNER]: "u1" }));
    const expanded: string[] = [];
    const onExpand = () => expanded.push("expand");
    window.addEventListener(WORK_BROWSER_EXPAND_EVENT, onExpand);
    await withDom(async ({ mount, act }) => {
      await mount(<SidePanel sessionId={USER_TABS_OWNER} client={null} workspaceId={null} workspaceRoot="" onClose={() => undefined} />);
      expect(document.body.textContent).not.toContain("Built-in browser");
      expect(byTestId("browser-home")).not.toBeNull();
      await act(() => byTestId("browser-expand")!.click());
      expect(expanded).toEqual(["expand"]);
    }, { browser: work.browser, browserLibrary: libraryBridge() });
    window.removeEventListener(WORK_BROWSER_EXPAND_EVENT, onExpand);
  });
});
