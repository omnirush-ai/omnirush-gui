import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { USER_TABS_OWNER, type BrowserPanelTab } from "@omnirush/browser-tabs";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

import type { BrowserLibraryBridge, BrowserSiteAuthRequest } from "../src/app/lib/desktop";
import type { OmniRushWorkFeed } from "../src/app/lib/omnirush-server";
import type { Platform } from "../src/react-app/kernel/platform";

// The DOM exists before any component module loads (portals decide at import time whether they can render).
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});
notifyManager.setScheduler((callback) => callback());

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

function libraryBridge(): BrowserLibraryBridge {
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
  };
}

function fakeBrowser(options: { limit?: boolean } = {}) {
  const calls = {
    created: [] as Array<[string | undefined, string | null | undefined]>,
    elsewhere: [] as Array<[string, string | null]>,
    blocked: [] as string[],
    dismissed: [] as string[],
    answers: [] as Array<[string, unknown]>,
    oldest: [] as string[],
    work: [] as boolean[],
  };
  let auth: ((request: BrowserSiteAuthRequest) => void) | null = null;
  let full = options.limit === true;
  const browser = {
    show: async () => undefined, hide: async () => undefined, setBounds: async () => undefined, setVisibleSession: async (id: string | null) => id,
    getState: async () => ({ tabs: [], activeTabIdByOwner: {} }), onStateChange: () => () => undefined,
    createTab: async (url?: string, owner?: string | null) => {
      if (full) throw new Error("Error invoking remote method 'omnirush:browser:createTab': BrowserTaskError: OmniRush.ai has 12 browser tabs open. Close an unused browser tab in any conversation, then try again.");
      calls.created.push([url, owner]);
      return { tabId: "created" };
    },
    suspendOldest: async (owner: string) => { calls.oldest.push(owner); full = false; return "u1"; },
    setWorkFeatures: async (on: boolean) => { calls.work.push(on); return on; },
    defaultBrowser: async () => ({ name: "Google Chrome" }),
    openBlockedElsewhere: async (tabId: string) => { calls.blocked.push(tabId); return { name: "Google Chrome" }; },
    dismissBlocked: async (tabId: string) => { calls.dismissed.push(tabId); return true; },
    openElsewhere: async (url: string, id: string | null) => { calls.elsewhere.push([url, id]); return true; },
    authAnswer: async (id: string, answer: unknown) => { calls.answers.push([id, answer]); return true; },
    onAuthRequest: (callback: (request: BrowserSiteAuthRequest) => void) => { auth = callback; return () => { auth = null; }; },
    onAuthDone: () => () => undefined,
  };
  return { browser, calls, ask: (request: BrowserSiteAuthRequest) => auth?.(request) };
}

function testPlatform(opened: string[]): Platform {
  return {
    platform: "desktop",
    capabilities: { nativeFilePicker: false, revealInFileManager: false, terminal: false, autoUpdate: false, osNotifications: false, localRuntimeControl: false, desktopBootstrap: false },
    openLink: (url: string) => { opened.push(url); },
  } as Platform;
}

type Electron = { browser?: unknown; browserLibrary?: BrowserLibraryBridge };

async function withDom(
  run: (helpers: { mount: (node: ReactNode) => Promise<void>; act: (work: () => unknown) => Promise<void>; opened: string[] }) => Promise<void>,
  electron: Electron | null,
  workState: Record<string, unknown> | null = { enabled: true },
) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: electron });
  localStorage.clear();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (workState) queries.setQueryData(["omnirush-work-state", "http://work.test"], workState);
  const opened: string[] = [];
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { PlatformProvider } = await import("../src/react-app/kernel/platform");
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  const settle = async (work: () => unknown) => {
    await act(async () => {
      await work();
      for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    });
  };
  try {
    await run({
      mount: (node) => settle(() => root.render(<PlatformProvider value={testPlatform(opened)}><QueryClientProvider client={queries}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider></PlatformProvider>)),
      act: settle,
      opened,
    });
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    localStorage.clear();
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: undefined });
  }
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("where a Work link opens", () => {
  test("Open goes beside Work; Cmd or Ctrl click, meeting hosts, sites set elsewhere and the setting send it out", async () => {
    const { workLinkTarget } = await import("../src/react-app/domains/work/browser/work-links");
    const base = { inApp: true, elsewhere: [] };
    expect(workLinkTarget("https://acme.zendesk.com/agent/tickets/8812", base)).toEqual({ kind: "panel" });
    expect(workLinkTarget("https://mail.google.com/mail/u/0/#inbox/1", base)).toEqual({ kind: "panel" });
    expect(workLinkTarget("https://acme.zendesk.com/agent/tickets/8812", { ...base, external: true })).toEqual({ kind: "system" });
    for (const url of ["https://meet.google.com/abc-defg-hij", "https://us02web.zoom.us/j/123", "https://teams.microsoft.com/l/meetup-join/x", "https://acme.webex.com/meet/pat"]) {
      expect(workLinkTarget(url, base)).toEqual({ kind: "system" });
    }
    expect(workLinkTarget("mailto:pat@acme.example", base)).toEqual({ kind: "system" });
    expect(workLinkTarget("https://outlook.office.com/mail/", { ...base, elsewhere: [{ host: "outlook.office.com", browserId: "edge", browserName: "Microsoft Edge" }] }))
      .toEqual({ kind: "elsewhere", browserId: "edge" });
    expect(workLinkTarget("https://www.notion.so/acme/q4", { ...base, elsewhere: [{ host: "notion.so", browserId: null, browserName: null }] })).toEqual({ kind: "system" });
    expect(workLinkTarget("https://acme.zendesk.com/agent/tickets/8812", { ...base, inApp: false })).toEqual({ kind: "system" });
    // If Google refuses sign-in here on real machines, Google links go to the person's browser by default.
    expect(workLinkTarget("https://docs.google.com/document/d/1", { ...base, googleInApp: false })).toEqual({ kind: "system" });
    expect(workLinkTarget("https://acme.zendesk.com/agent/tickets/8812", { ...base, googleInApp: false })).toEqual({ kind: "panel" });
  });

  test("the company's setting: no block is OmniRush and the person's choice; a lock wins over the choice", async () => {
    const { linksInApp, workLinkPolicy } = await import("../src/react-app/domains/work/browser/work-links");
    expect(workLinkPolicy(null)).toEqual({ inApp: true, locked: false, orgName: null });
    expect(workLinkPolicy({ enabled: true })).toEqual({ inApp: true, locked: false, orgName: null });
    expect(workLinkPolicy({ enabled: false, browser: { links_in_app: false, links_locked: true } })).toEqual({ inApp: true, locked: false, orgName: null });
    const locked = workLinkPolicy({ enabled: true, browser: { apps: [], links_in_app: false, links_locked: true, org_name: " Acme Freight " } });
    expect(locked).toEqual({ inApp: false, locked: true, orgName: "Acme Freight" });
    expect(linksInApp(locked, true)).toBe(false);
    const open = workLinkPolicy({ enabled: true, browser: { links_in_app: true, links_locked: false } });
    expect(linksInApp(open, null)).toBe(true);
    expect(linksInApp(open, false)).toBe(false);
    expect(linksInApp({ ...open, inApp: false }, null)).toBe(false);
  });

  test("the person's choices stay on this computer: one entry per site, newest first, nothing malformed", async () => {
    const links = await import("../src/react-app/domains/work/browser/work-links");
    const store = memory();
    expect(links.readLinksChoice(store)).toBeNull();
    links.writeLinksChoice(false, store);
    expect(links.readLinksChoice(store)).toBe(false);
    links.addElsewhereHost({ host: "www.Notion.so", browserId: null, browserName: "Google Chrome" }, store);
    links.addElsewhereHost({ host: "outlook.office.com", browserId: "edge", browserName: "Microsoft Edge" }, store);
    links.addElsewhereHost({ host: "notion.so", browserId: null, browserName: "Firefox" }, store);
    expect(links.readElsewhereHosts(store)).toEqual([
      { host: "notion.so", browserId: null, browserName: "Firefox" },
      { host: "outlook.office.com", browserId: "edge", browserName: "Microsoft Edge" },
    ]);
    links.removeElsewhereHost("notion.so", store);
    expect(links.readElsewhereHosts(store).map((entry) => entry.host)).toEqual(["outlook.office.com"]);
    store.setItem(links.WORK_LINKS_ELSEWHERE_KEY, JSON.stringify([{ host: "bad host/" }, { host: 3 }, "x", { host: "ok.example", browserId: "../../x" }]));
    expect(links.readElsewhereHosts(store)).toEqual([{ host: "ok.example", browserId: null, browserName: null }]);
    store.setItem(links.WORK_LINKS_ELSEWHERE_KEY, "{not json");
    expect(links.readElsewhereHosts(store)).toEqual([]);
  });

  test("every new string has a Chinese copy, and none has a dash", () => {
    const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
    const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
    const keys = (source: string) => new Set([...source.matchAll(/"(work_links\.[a-z_0-9]+)":/g)].map((match) => match[1]));
    expect(keys(en).size).toBeGreaterThan(25);
    expect([...keys(en)].filter((key) => !keys(zh).has(key))).toEqual([]);
    for (const line of [...en.split("\n"), ...zh.split("\n")].filter((entry) => entry.includes('"work_links.'))) {
      expect(line).not.toMatch(/[–—!]/);
      expect(line).not.toMatch(/\bAI\b|default browser\?/);
    }
  });
});

const feed = (items: OmniRushWorkFeed["groups"]["fyi"], attention = false): OmniRushWorkFeed => ({
  generated_at: "2026-11-23T09:00:00Z",
  sources: [{ id: "google", label: "Google", status: "connected", attention: attention ? { kind: "reconnect", message: "Google needs reconnecting.", action: "reconnect", since: null } : null }],
  groups: { needs_you: [], today: items, fyi: [] },
});

async function mountToday(mount: (node: ReactNode) => Promise<void>, data: OmniRushWorkFeed, client: Record<string, unknown> = {}) {
  const { WorkToday } = await import("../src/react-app/domains/work/work-today");
  const { useOpenWorkLink } = await import("../src/react-app/domains/work/browser/use-work-links");
  const { usePlatform } = await import("../src/react-app/kernel/platform");
  const today = { baseUrl: "http://today.test", getWorkFeed: async () => data, ...client } as never;
  // As the shell wires it: item links through the Work router, sign-in pages to the person's browser.
  function Today() {
    const openWorkLink = useOpenWorkLink();
    const platform = usePlatform();
    return <WorkToday client={today} openLink={openWorkLink} openExternal={(url) => platform.openLink(url)} onAsk={async () => undefined} onOpenConnectors={() => undefined} />;
  }
  await mount(<Today />);
}

describe("Work pages open links beside Work", () => {
  const item = { id: "zendesk:t:8812", source: "zendesk", kind: "ticket", title: "Ticket 8812: Delay on PO 7730", at: "2026-11-23T08:00:00Z", url: "https://acme.zendesk.com/agent/tickets/8812", reason: "Assigned to you" };

  test("a Today Open lands in the side panel; Cmd or Ctrl click goes to the person's browser", async () => {
    const fake = fakeBrowser();
    await withDom(async ({ mount, act, opened }) => {
      await mountToday(mount, feed([item]));
      const row = document.querySelector<HTMLElement>(`[data-feed-item="${item.id}"]`)!;
      await act(() => row.click());
      expect(fake.calls.created).toEqual([[item.url, USER_TABS_OWNER]]);
      expect(opened).toEqual([]);
      await act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true })));
      expect(opened).toEqual([item.url]);
      expect(fake.calls.created.length).toBe(1);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("Connect Google (reconnect) stays in the person's browser", async () => {
    const fake = fakeBrowser();
    await withDom(async ({ mount, act, opened }) => {
      await mountToday(mount, feed([item], true), { startWorkConnector: async () => ({ auth_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" }) });
      const reconnect = [...document.querySelectorAll("button")].find((button) => button.textContent === "Reconnect")!;
      expect(reconnect).toBeDefined();
      await act(() => reconnect.click());
      expect(opened).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?client_id=x"]);
      expect(fake.calls.created).toEqual([]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("the setting sends links out; a site set elsewhere opens in that browser; a company lock wins", async () => {
    const fake = fakeBrowser();
    await withDom(async ({ mount, act, opened }) => {
      localStorage.setItem("omnirush:work-browser:links:v1", "system");
      await mountToday(mount, feed([item]));
      await act(() => document.querySelector<HTMLElement>(`[data-feed-item="${item.id}"]`)!.click());
      expect(opened).toEqual([item.url]);
      expect(fake.calls.created).toEqual([]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
    const pinned = fakeBrowser();
    await withDom(async ({ mount, act, opened }) => {
      localStorage.setItem("omnirush:work-browser:elsewhere:v1", JSON.stringify([{ host: "acme.zendesk.com", browserId: "edge", browserName: "Microsoft Edge" }]));
      await mountToday(mount, feed([item]));
      await act(() => document.querySelector<HTMLElement>(`[data-feed-item="${item.id}"]`)!.click());
      expect(pinned.calls.elsewhere).toEqual([[item.url, "edge"]]);
      expect(opened).toEqual([]);
    }, { browser: pinned.browser, browserLibrary: libraryBridge() });
    const locked = fakeBrowser();
    await withDom(async ({ mount, act, opened }) => {
      localStorage.setItem("omnirush:work-browser:links:v1", "app");
      await mountToday(mount, feed([item]));
      await act(() => document.querySelector<HTMLElement>(`[data-feed-item="${item.id}"]`)!.click());
      expect(opened).toEqual([item.url]);
      expect(locked.calls.created).toEqual([]);
    }, { browser: locked.browser, browserLibrary: libraryBridge() }, { enabled: true, browser: { apps: [], links_in_app: false, links_locked: true, org_name: "Acme Freight" } });
  });

  test("at the live tab limit the person chooses Suspend oldest; nothing is closed without it", async () => {
    const fake = fakeBrowser({ limit: true });
    const { openInWorkPanel } = await import("../src/react-app/domains/work/browser/use-work-links");
    const { Toaster } = await import("../src/components/ui/sonner");
    await withDom(async ({ mount, act }) => {
      await mount(<Toaster />);
      await act(() => openInWorkPanel(item.url));
      expect(fake.calls.created).toEqual([]);
      expect(fake.calls.oldest).toEqual([]);
      const suspend = [...document.querySelectorAll("button")].find((button) => button.textContent === "Suspend oldest");
      expect(suspend).toBeDefined();
      await act(() => suspend!.click());
      expect(fake.calls.oldest).toEqual([USER_TABS_OWNER]);
      expect(fake.calls.created).toEqual([[item.url, USER_TABS_OWNER]]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("a consumer account keeps every link in its own browser", async () => {
    const fake = fakeBrowser();
    await withDom(async ({ mount, act, opened }) => {
      await mountToday(mount, feed([item]));
      await act(() => document.querySelector<HTMLElement>(`[data-feed-item="${item.id}"]`)!.click());
      expect(opened).toEqual([item.url]);
      expect(fake.calls.created).toEqual([]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() }, null);
  });
});

describe("a record's Open", () => {
  test("opens a tab in the record's own panel; a meeting link stays in the person's browser", async () => {
    const { RecordPanel } = await import("../src/react-app/domains/work/viewer/record-panel");
    const { MemoryRouter } = await import("react-router");
    const record = (url: string) => ({ source_id: "zendesk:t:8812", source: "zendesk", kind: "ticket", view: "ticket", subject: "Delay on PO 7730", url, occurred_at: "2026-11-23T08:00:00Z", actors: [] });
    for (const [url, panel] of [["https://acme.zendesk.com/agent/tickets/8812", true], ["https://meet.google.com/abc-defg-hij", false]] as const) {
      const fake = fakeBrowser();
      const client = { baseUrl: "http://records.test", getWorkRecord: async () => record(url) } as never;
      await withDom(async ({ mount, act, opened }) => {
        await mount(<MemoryRouter><RecordPanel panelKey={USER_TABS_OWNER} tab={{ id: "rec1", type: "record", label: "Delay on PO 7730", sourceId: "zendesk:t:8812", source: "zendesk", url }} client={client} onClose={() => undefined} /></MemoryRouter>);
        await act(() => byTestId("work-viewer-open")!.click());
        expect(fake.calls.created).toEqual(panel ? [[url, USER_TABS_OWNER]] : []);
        expect(opened).toEqual(panel ? [] : [url]);
      }, { browser: fake.browser, browserLibrary: libraryBridge() });
    }
  });
});

describe("Settings > Browser: Open links from Work in", () => {
  test("defaults to OmniRush; a company lock shows who set it and the choice is fixed", async () => {
    const { WorkLinksSettings } = await import("../src/react-app/domains/work/browser/work-links-settings");
    await withDom(async ({ mount }) => {
      await mount(<WorkLinksSettings />);
      expect(document.body.textContent).toContain("Open links from Work in");
      expect(byTestId("work-links-choice")?.textContent).toContain("OmniRush");
      expect(byTestId("work-links-locked")).toBeNull();
      expect(byTestId("work-links-elsewhere")).toBeNull();
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() });
    await withDom(async ({ mount }) => {
      await mount(<WorkLinksSettings />);
      expect(byTestId("work-links-locked")?.textContent).toBe("Set by Acme Freight");
      expect(byTestId("work-links-choice")?.textContent).toContain("Google Chrome");
      // Fixed: the choice reads as plain text, not a menu.
      expect(byTestId("work-links-choice")?.tagName).toBe("SPAN");
      expect(document.querySelector('[data-testid="work-links-choice"] button, button[data-testid="work-links-choice"]')).toBeNull();
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() }, { enabled: true, browser: { apps: [], links_in_app: false, links_locked: true, org_name: "Acme Freight" } });
    // A consumer account has no Work browser: nothing here.
    await withDom(async ({ mount }) => {
      await mount(<WorkLinksSettings />);
      expect(document.body.textContent).not.toContain("Open links from Work in");
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() }, null);
  });

  test("sites set elsewhere: 8 rows, then Show all (n), search and Remove", async () => {
    const { WorkLinksSettings } = await import("../src/react-app/domains/work/browser/work-links-settings");
    const { addElsewhereHost } = await import("../src/react-app/domains/work/browser/work-links");
    const hosts = ["mail.google.com", "outlook.office.com", "acme.zendesk.com", "tms.acmefreight.example", "app.hubspot.com", "linear.app", "notion.so", "figma.com", "go.xero.com", "a-very-long-intranet-host-name-for-the-holiday-calendar.acmefreight.example"];
    await withDom(async ({ mount, act }) => {
      for (const host of hosts) addElsewhereHost({ host, browserId: host === "outlook.office.com" ? "edge" : null, browserName: host === "outlook.office.com" ? "Microsoft Edge" : "Google Chrome" });
      await mount(<WorkLinksSettings />);
      expect(allByTestId("work-links-elsewhere-row").length).toBe(8);
      expect(byTestId("work-links-show-all")?.textContent).toBe("Show all (10)");
      await act(() => byTestId("work-links-show-all")!.click());
      expect(allByTestId("work-links-elsewhere-row").length).toBe(10);
      const long = allByTestId("work-links-elsewhere-row").map((row) => row.querySelector("[title]")?.getAttribute("title"));
      expect(long).toContain("a-very-long-intranet-host-name-for-the-holiday-calendar.acmefreight.example");
      await act(() => typeInto(byTestId("work-links-search") as HTMLInputElement, "zendesk"));
      expect(allByTestId("work-links-elsewhere-row").map((row) => row.textContent)).toEqual(["acme.zendesk.comGoogle ChromeRemove"]);
      await act(() => (allByTestId("work-links-elsewhere-row")[0]!.querySelector("button") as HTMLButtonElement).click());
      expect(JSON.parse(localStorage.getItem("omnirush:work-browser:elsewhere:v1")!).map((entry: { host: string }) => entry.host)).not.toContain("acme.zendesk.com");
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() });
  });
});

const tab = (blocked: BrowserPanelTab["blockedSignIn"]): BrowserPanelTab => ({
  id: "u1", type: "browser", label: "Sign in", url: "https://accounts.google.com/v3/signin/rejected", favicon: null, status: "ready", canGoBack: true, canGoForward: false,
  ownerSessionId: USER_TABS_OWNER, siteToolCount: 0, siteTools: [], siteToolActivity: [], browserTask: { status: "idle", operation: null }, blockedSignIn: blocked,
});

describe("never a dead end", () => {
  test("Google's rejected page: one bar with Open in <browser> and Always open <host> there", async () => {
    const { BrowserSignInBar } = await import("../src/react-app/domains/session/panel/browser-signin-bar");
    const fake = fakeBrowser();
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserSignInBar tab={tab({ kind: "google", url: "https://mail.google.com/mail/u/0/", host: "mail.google.com", browser: { id: null, name: "Google Chrome" } })} />);
      expect(allByTestId("browser-signin-bar").length).toBe(1);
      expect(byTestId("browser-signin-bar")?.textContent).toContain("Google does not allow sign-in in this browser.");
      expect(byTestId("browser-signin-open")?.textContent).toBe("Open in Google Chrome");
      expect(byTestId("browser-signin-always")?.textContent).toBe("Always open mail.google.com there");
      expect(byTestId("browser-signin-always")?.getAttribute("title")).toBe("Always open mail.google.com there");
      await act(() => byTestId("browser-signin-always")!.click());
      expect(fake.calls.blocked).toEqual(["u1"]);
      expect(JSON.parse(localStorage.getItem("omnirush:work-browser:elsewhere:v1")!)).toEqual([{ host: "mail.google.com", browserId: null, browserName: "Google Chrome" }]);
      await act(() => byTestId("browser-signin-dismiss")!.click());
      expect(fake.calls.dismissed).toEqual(["u1"]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("a Microsoft device rule names Edge; a passkey names the way out; no app host, no Always", async () => {
    const { BrowserSignInBar } = await import("../src/react-app/domains/session/panel/browser-signin-bar");
    await withDom(async ({ mount }) => {
      await mount(<BrowserSignInBar tab={tab({ kind: "microsoft_device", url: "https://outlook.office.com/mail/", host: "outlook.office.com", browser: { id: "edge", name: "Microsoft Edge" } })} />);
      expect(byTestId("browser-signin-bar")?.textContent).toContain("managed browser");
      expect(byTestId("browser-signin-open")?.textContent).toBe("Open in Microsoft Edge");
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() });
    await withDom(async ({ mount }) => {
      await mount(<BrowserSignInBar tab={tab({ kind: "passkey", url: "https://login.microsoftonline.com/", host: null, browser: { id: null, name: null } })} />);
      expect(byTestId("browser-signin-bar")?.textContent).toContain("Passkeys do not work here yet. Use another way, or open in your browser.");
      expect(byTestId("browser-signin-open")?.textContent).toBe("Open in your browser");
      expect(byTestId("browser-signin-always")).toBeNull();
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() });
    // A consumer account never sees it (the desktop never marks their tabs either).
    await withDom(async ({ mount }) => {
      await mount(<BrowserSignInBar tab={tab({ kind: "google", url: "https://mail.google.com/", host: "mail.google.com", browser: { id: null, name: "Google Chrome" } })} />);
      expect(byTestId("browser-signin-bar")).toBeNull();
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() }, null);
  });

  test("a site asking for a password gets a sign-in sheet; the answer goes back once", async () => {
    const { BrowserSiteAuthSheet } = await import("../src/react-app/domains/session/panel/browser-site-auth");
    const fake = fakeBrowser();
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserSiteAuthSheet enabled />);
      expect(byTestId("browser-site-auth")).toBeNull();
      await act(() => fake.ask({ id: "auth_1", tabId: "u1", host: "intranet.acmefreight.example", realm: "Acme intranet", scheme: "basic", url: "https://intranet.acmefreight.example/hr/" }));
      expect(byTestId("browser-site-auth")?.textContent).toContain("Sign in to intranet.acmefreight.example");
      expect(byTestId("browser-site-auth-realm")?.textContent).toBe("The site says: Acme intranet");
      expect((byTestId("browser-site-auth-submit") as HTMLButtonElement).disabled).toBe(true);
      await act(() => typeInto(byTestId("browser-site-auth-user") as HTMLInputElement, "pat"));
      await act(() => typeInto(byTestId("browser-site-auth-password") as HTMLInputElement, "hunter2"));
      await act(() => byTestId("browser-site-auth-submit")!.click());
      expect(fake.calls.answers).toEqual([["auth_1", { username: "pat", password: "hunter2" }]]);
      expect(byTestId("browser-site-auth")).toBeNull();
      await act(() => fake.ask({ id: "auth_2", tabId: "u1", host: "intranet.acmefreight.example", realm: "", scheme: "ntlm", url: "https://intranet.acmefreight.example/" }));
      await act(() => byTestId("browser-site-auth-elsewhere")!.click());
      expect(fake.calls.answers.at(-1)).toEqual(["auth_2", null]);
      expect(fake.calls.elsewhere).toEqual([["https://intranet.acmefreight.example/", null]]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });
});

describe("Browser home: sign in once with the company's sign-in", () => {
  test("the company's own Okta first, then Microsoft, then Google; Okta's own pages do not count", async () => {
    const { companySignIn } = await import("../src/react-app/domains/work/browser/sign-in-once");
    expect(companySignIn([])).toBeNull();
    expect(companySignIn(["https://www.okta.com/pricing", "https://help.okta.com/en-us"])).toBeNull();
    expect(companySignIn(["https://accounts.google.com/v3/signin", "https://login.microsoftonline.com/common/oauth2", "https://acmefreight.okta.com/app/UserHome"]))
      .toEqual({ idp: "okta", name: "Okta", url: "https://acmefreight.okta.com/", host: "acmefreight.okta.com" });
    expect(companySignIn(["https://accounts.google.com/v3/signin", "https://login.microsoftonline.com/common/oauth2"])?.idp).toBe("microsoft");
    expect(companySignIn(["https://accounts.google.com/v3/signin", "not a url"])).toEqual({ idp: "google", name: "Google", url: "https://accounts.google.com/", host: "accounts.google.com" });
  });

  test("one dismissible row on Browser home; used or dismissed, it does not come back", async () => {
    const { BrowserHome } = await import("../src/react-app/domains/work/browser/browser-home");
    const library = { ...libraryBridge(), suggest: async (query: string) => (query === "okta.com" ? [{ url: "https://acmefreight.okta.com/app/UserHome", title: "Acme Freight", kind: "history" as const }] : []) };
    const opened: string[] = [];
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserHome companyName="Acme Freight" apps={[]} onOpen={(url) => opened.push(url)} />);
      expect(allByTestId("browser-home-sign-in").length).toBe(1);
      expect(byTestId("browser-home-sign-in")?.textContent).toContain("Sign in once with Okta");
      expect(byTestId("browser-home-sign-in")?.querySelector('[data-brand-tile="okta"]')).not.toBeNull();
      await act(() => byTestId("browser-home-sign-in-open")!.click());
      expect(opened).toEqual(["https://acmefreight.okta.com/"]);
      expect(byTestId("browser-home-sign-in")).toBeNull();
      expect(JSON.parse(localStorage.getItem("omnirush:work-browser:sign-in-once:v1")!)).toEqual(["acmefreight.okta.com"]);
    }, { browser: fakeBrowser().browser, browserLibrary: library });
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserHome companyName="Acme Freight" apps={[]} onOpen={() => undefined} />);
      await act(() => byTestId("browser-home-sign-in-dismiss")!.click());
      expect(byTestId("browser-home-sign-in")).toBeNull();
    }, { browser: fakeBrowser().browser, browserLibrary: library });
    // Nothing in the library: no row.
    await withDom(async ({ mount }) => {
      await mount(<BrowserHome companyName="Acme Freight" apps={[]} onOpen={() => undefined} />);
      expect(byTestId("browser-home-sign-in")).toBeNull();
    }, { browser: fakeBrowser().browser, browserLibrary: libraryBridge() });
  });
});
