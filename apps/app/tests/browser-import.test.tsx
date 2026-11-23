import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

import type {
  BrowserImportInspection,
  BrowserImportProgress,
  BrowserImportRequest,
  BrowserImportResult,
  BrowserImportSources,
  BrowserLibraryBridge,
} from "../src/app/lib/desktop";
import { t } from "../src/i18n";

// The DOM exists before any component module loads: the dialog's portal decides at import time whether it can render.
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const SOURCES: BrowserImportSources = {
  platform: "darwin",
  historyDays: 90,
  browsers: [
    {
      browser: "chrome", label: "Google Chrome", short: "Chrome",
      signIns: { importable: true, reason: null }, access: "ok",
      profiles: [
        { id: "chrome:Default", name: "Work", profile: "Default", has: { bookmarks: true, history: true, signIns: true } },
        { id: "chrome:Profile 1", name: "Personal", profile: "Profile 1", has: { bookmarks: true, history: true, signIns: true } },
      ],
    },
    {
      browser: "firefox", label: "Firefox", short: "Firefox",
      signIns: { importable: true, reason: null }, access: "ok",
      profiles: [{ id: "firefox:abc:x.default-release", name: "Default", profile: "x.default-release", has: { bookmarks: true, history: true, signIns: true } }],
    },
    {
      browser: "safari", label: "Safari", short: "Safari",
      signIns: { importable: true, reason: null }, access: "full_disk_access",
      profiles: [{ id: "safari:Safari", name: "Safari", profile: "Safari", has: { bookmarks: true, history: true, signIns: true } }],
    },
  ],
};

const site = (name: string, category: "ordinary" | "finance", lastUsedAt: number | null) => ({
  site: name, hosts: [name], cookieCount: 2, sessionCookieCount: 1, lastUsedAt, category,
  preselected: category === "ordinary", reason: category === "finance" ? "Handles money." : null,
});

const INSPECTION: BrowserImportInspection = {
  source: { id: "chrome:Default", browser: "chrome", label: "Google Chrome", name: "Work" },
  bookmarks: { state: "ready", count: 312 },
  history: { state: "ready", count: 4210, days: 90 },
  signIns: { state: "ready", previewId: "preview-1", cookieCount: 9, sites: [site("tracker.example.org", "ordinary", Math.trunc(Date.now() / 1000)), site("docs.example.com", "ordinary", null), site("bank.example", "finance", null)] },
  keepInStep: true,
};

function fakeBridge(overrides: Partial<BrowserLibraryBridge> = {}) {
  const calls: { inspect: string[]; import: BrowserImportRequest[] } = { inspect: [], import: [] };
  const listeners = new Set<(progress: BrowserImportProgress) => void>();
  const bridge: BrowserLibraryBridge = {
    sources: async () => SOURCES,
    inspect: async ({ sourceId }) => {
      calls.inspect.push(sourceId);
      return sourceId === "chrome:Default" ? INSPECTION : { ...INSPECTION, source: { ...INSPECTION.source, id: sourceId }, signIns: { state: "unavailable", reason: "windows_locked" } };
    },
    import: async (request) => {
      calls.import.push(request);
      for (const kind of ["bookmarks", "history", "signIns"] as const) {
        for (const listener of listeners) listener({ kind, state: "running" });
        for (const listener of listeners) listener({ kind, state: "done", count: kind === "bookmarks" ? 312 : kind === "history" ? 4210 : 2 });
      }
      const result: BrowserImportResult = {
        source: INSPECTION.source,
        bookmarks: { state: "done", count: 312 },
        history: { state: "done", count: 4210 },
        signIns: { state: "done", count: 2, failed: 0, keepInStep: request.signIns?.keepInStep ?? false },
      };
      return result;
    },
    onProgress: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    bookmarks: async () => [],
    topBookmarks: async () => [],
    suggest: async () => [],
    isBookmarked: async () => false,
    toggleBookmark: async () => ({ bookmarked: true }),
    summary: async () => ({ imports: [], bookmarks: 0, history: 0 }),
    clear: async () => ({ imports: [], bookmarks: 0, history: 0 }),
    openFullDiskAccess: async () => true,
    ...overrides,
  };
  return { bridge, calls };
}

async function withDom(run: (helpers: { mount: (node: ReactNode) => Promise<void>; act: (work: () => unknown) => Promise<void>; queries: QueryClient }) => Promise<void>, bridge: BrowserLibraryBridge | null, workOn = true) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const electron = bridge ? { browserLibrary: bridge } : null;
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: electron });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (workOn) queries.setQueryData(["omnirush-work-state", "http://work.test"], { enabled: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  // Work, then let every query the work started answer and reach the view.
  const settle = async (work: () => unknown) => {
    await act(async () => {
      await work();
      for (let index = 0; index < 40; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (index >= 4 && queries.isFetching() === 0 && queries.isMutating() === 0) break;
      }
      for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    });
  };
  try {
    await run({
      mount: (node) => settle(() => root.render(<QueryClientProvider client={queries}>{node}</QueryClientProvider>)),
      act: settle,
      queries,
    });
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: undefined });
  }
}

// Query results reach the view at once, inside the test's act().
notifyManager.setScheduler((callback) => callback());

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = () => document.body.textContent ?? "";

describe("browser import", () => {
  test("copy is plain: summary sentences, failure reasons, and no dashes anywhere", async () => {
    const { importFailureText, importSummary } = await import("../src/react-app/domains/browser-logins/import-dialog");
    const { importedLine } = await import("../src/react-app/domains/browser-logins/import-section");
    expect(importSummary({ source: INSPECTION.source, bookmarks: { state: "done", count: 312 }, history: { state: "done", count: 4210 }, signIns: { state: "done", count: 31 } }))
      .toBe("312 bookmarks, 4,210 pages and 31 sign-ins");
    expect(importSummary({ source: INSPECTION.source, bookmarks: { state: "done", count: 1 }, history: null, signIns: { state: "cancelled", reason: "cancelled" } })).toBe("1 bookmark");
    expect(importSummary({ source: INSPECTION.source, bookmarks: null, history: null, signIns: null })).toBe("Nothing was imported.");
    expect(importFailureText("windows_locked", "Chrome")).toBe("Chrome on Windows locks sign-ins to itself, so they can't be imported.");
    expect(importFailureText("policy_off", "Chrome")).toBe("Sign-in import is off on this computer.");
    expect(importFailureText("busy", "Firefox")).toContain("Firefox");
    expect(importedLine({ sourceId: "x", browser: "chrome", label: "Google Chrome", name: "Work", importedAt: 0, bookmarks: 312, history: null, signIns: 4 })).toBe("312 bookmarks · 4 sign-ins");
    const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
    const lines = en.split("\n").filter((line) => /"browser_(import|library)\./.test(line));
    expect(lines.length).toBeGreaterThan(80);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u2013\u2014!]/);
      expect(line).not.toMatch(/Oops/i);
    }
  });

  test("the offer names the browser people use most; nothing is offered when no browser has anything", async () => {
    const { offerBrowser } = await import("../src/react-app/domains/browser-logins/use-browser-library");
    expect(offerBrowser(SOURCES)?.browser).toBe("chrome");
    expect(offerBrowser({ ...SOURCES, browsers: [SOURCES.browsers[1]!, SOURCES.browsers[2]!] })?.browser).toBe("safari");
    expect(offerBrowser({ ...SOURCES, browsers: [] })).toBeNull();
    const { displayUrl } = await import("../src/react-app/domains/session/panel/browser-library-bar");
    expect(displayUrl("https://www.example.com/")).toBe("example.com");
    expect(displayUrl("http://docs.example.com/a/b")).toBe("docs.example.com/a/b");
  });

  test("the dialog lists found browsers with logos and profile names, counts first, and imports what is ticked", async () => {
    const { bridge, calls } = fakeBridge();
    const { BrowserImportDialog } = await import("../src/react-app/domains/browser-logins/import-dialog");
    const imported: BrowserImportResult[] = [];
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserImportDialog open onOpenChange={() => undefined} onImported={(result) => imported.push(result)} />);
      expect(byTestId("browser-import-dialog")).not.toBeNull();
      for (const browser of ["chrome", "firefox", "safari"]) {
        expect(byTestId(`browser-import-browser-${browser}`)?.querySelector(`[data-browser-tile="${browser}"]`)).not.toBeNull();
      }
      expect(byTestId("browser-import-browser-chrome")?.getAttribute("aria-checked")).toBe("true");
      expect(byTestId("browser-import-profile-chrome:Default")?.textContent).toBe("Work");
      expect(byTestId("browser-import-profile-chrome:Profile 1")?.textContent).toBe("Personal");
      expect(calls.inspect).toEqual(["chrome:Default"]);
      expect(byTestId("browser-import-row-bookmarks")?.textContent).toContain("312 bookmarks");
      expect(byTestId("browser-import-row-history")?.textContent).toContain("4,210 pages");
      expect(byTestId("browser-import-row-history")?.textContent).toContain("last 90 days");
      expect(byTestId("browser-import-row-signIns")?.textContent).toContain("2 of 3 sites");
      expect(byTestId("browser-import-privacy")?.textContent).toBe("Everything stays on this computer. Saved passwords, payment cards and extensions are never imported.");

      await act(() => byTestId("browser-import-review-sites")!.click());
      expect(byTestId("browser-import-sites")?.textContent).toContain("Left unticked on purpose");
      expect(byTestId("browser-import-site-bank.example")?.getAttribute("aria-checked")).toBe("false");
      expect(byTestId("browser-import-site-tracker.example.org")?.getAttribute("aria-checked")).toBe("true");
      await act(() => byTestId("browser-import-site-docs.example.com")!.click());
      expect(byTestId("browser-import-row-signIns")?.textContent).toContain("1 of 3 sites");

      expect(byTestId("browser-import-keep")).not.toBeNull();
      await act(() => byTestId("browser-import-submit")!.click());
      expect(calls.import).toEqual([{
        sourceId: "chrome:Default",
        bookmarks: true,
        history: true,
        signIns: { previewId: "preview-1", sites: ["tracker.example.org"], keepInStep: false },
      }]);
      expect(byTestId("browser-import-done")).not.toBeNull();
      expect(text()).toContain("Imported from Chrome");
      expect(text()).toContain("312 bookmarks, 4,210 pages and 2 sign-ins");
      expect(imported).toHaveLength(1);
    }, bridge);
  });

  test("Safari without Full Disk Access shows the steps instead of reading; Windows-style refusals say why", async () => {
    const opened: string[] = [];
    const { bridge, calls } = fakeBridge({ openFullDiskAccess: async () => { opened.push("fda"); return true; } });
    const { BrowserImportDialog } = await import("../src/react-app/domains/browser-logins/import-dialog");
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserImportDialog open initialBrowser="safari" onOpenChange={() => undefined} />);
      expect(byTestId("browser-import-access")?.textContent).toContain("Full Disk Access");
      expect(calls.inspect).toEqual([]);
      expect(byTestId("browser-import-submit")?.hasAttribute("disabled")).toBe(true);
      await act(() => byTestId("browser-import-open-access")!.click());
      expect(opened).toEqual(["fda"]);
      await act(() => byTestId("browser-import-browser-chrome")!.click());
      await act(() => byTestId("browser-import-profile-chrome:Profile 1")!.click());
      expect(calls.inspect).toEqual(["chrome:Default", "chrome:Profile 1"]);
      expect(byTestId("browser-import-row-signIns")?.textContent).toContain("Chrome on Windows locks sign-ins to itself");
    }, bridge);
  });

  test("Settings: browsers found with profile names; nothing at all for a consumer account or outside the desktop app", async () => {
    const { bridge } = fakeBridge({
      summary: async () => ({ imports: [{ sourceId: "chrome:Default", browser: "chrome", label: "Google Chrome", name: "Work", importedAt: Date.UTC(2026, 10, 23), bookmarks: 312, history: 4210, signIns: 31 }], bookmarks: 312, history: 4210 }),
    });
    const { BrowserImportSection } = await import("../src/react-app/domains/browser-logins/import-section");
    await withDom(async ({ mount }) => {
      await mount(<BrowserImportSection />);
      expect(byTestId("browser-import-found-chrome")?.textContent).toContain("Work, Personal");
      expect(byTestId("browser-import-found-safari")?.textContent).toContain("Needs Full Disk Access");
      expect(byTestId("browser-import-imported")?.textContent).toContain("312 bookmarks · 4,210 pages · 31 sign-ins");
      expect(byTestId("browser-import-clear")).not.toBeNull();
    }, bridge);
    await withDom(async ({ mount }) => {
      await mount(<BrowserImportSection />);
      expect(document.getElementById("root")?.innerHTML).toBe("");
    }, bridge, false);
    await withDom(async ({ mount }) => {
      await mount(<BrowserImportSection />);
      expect(document.getElementById("root")?.innerHTML).toBe("");
    }, null);
  });

  test("the browser panel row: a Work account is offered its browser's bookmarks once, never the sync offer", async () => {
    const { bridge } = fakeBridge();
    const { LoginSyncCard } = await import("../src/react-app/domains/browser-logins/login-sync-card");
    const { usePersistedBrowserLoginsStore } = await import("../src/react-app/domains/browser-logins/browser-logins-store");
    await withDom(async ({ mount, act }) => {
      usePersistedBrowserLoginsStore.setState({ importOffer: null });
      await mount(<LoginSyncCard />);
      expect(byTestId("browser-import-offer")?.textContent).toContain("Bring your bookmarks and sign-ins from Chrome.");
      expect(byTestId("browser-import-offer")?.querySelector('[data-browser-tile="chrome"]')).not.toBeNull();
      expect(byTestId("login-sync-card")).toBeNull();
      await act(() => byTestId("browser-import-offer-dismiss")!.click());
      expect(byTestId("browser-import-offer")).toBeNull();
      expect(usePersistedBrowserLoginsStore.getState().importOffer).toBe("dismissed");
      await mount(<LoginSyncCard />);
      expect(byTestId("browser-import-offer")).toBeNull();
    }, bridge);
  });

  test("the toolbar: the star reflects the page and toggles it; the bookmarks menu offers import; consumers get no bar", async () => {
    let starred = false;
    const toggled: string[] = [];
    const { bridge } = fakeBridge({
      isBookmarked: async () => starred,
      toggleBookmark: async ({ url }) => { toggled.push(url); starred = !starred; return { bookmarked: starred }; },
    });
    const { BrowserLibraryBar } = await import("../src/react-app/domains/session/panel/browser-library-bar");
    const { TooltipProvider } = await import("../src/components/ui/tooltip");
    const tab = { id: "tab-1", type: "browser" as const, label: "Example", url: "https://example.com/", favicon: null, status: "ready" as const, canGoBack: false, canGoForward: false, ownerSessionId: "ses", siteToolCount: 0, siteTools: [] };
    const inputRef = { current: null as HTMLInputElement | null };
    await withDom(async ({ mount, act }) => {
      await mount(<TooltipProvider><input ref={(node) => { inputRef.current = node; }} /><BrowserLibraryBar sessionId="ses" tab={tab} inputRef={inputRef} /></TooltipProvider>);
      const star = byTestId("browser-star")!;
      expect(star.getAttribute("aria-pressed")).toBe("false");
      expect(star.getAttribute("aria-label")).toBe("Bookmark this page");
      await act(() => star.click());
      expect(toggled).toEqual(["https://example.com/"]);
      expect(byTestId("browser-star")?.getAttribute("aria-pressed")).toBe("true");
      expect(byTestId("browser-star")?.getAttribute("aria-label")).toBe("Remove bookmark");
      expect(byTestId("browser-bookmarks")).not.toBeNull();
    }, bridge);
    await withDom(async ({ mount }) => {
      await mount(<TooltipProvider><BrowserLibraryBar sessionId="ses" tab={tab} inputRef={inputRef} /></TooltipProvider>);
      expect(byTestId("browser-star")).toBeNull();
    }, bridge, false);
  });

  test("an account change refreshes the library; a cleared browser drops every chat's saved browser tabs", async () => {
    const { BrowserAccountChanges } = await import("../src/react-app/domains/browser-logins/browser-account-changes");
    const { browserLibraryKeys } = await import("../src/react-app/domains/browser-logins/use-browser-library");
    const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");
    const browserTab = (id: string, ownerSessionId: string) => ({
      id, type: "browser" as const, label: "Acme TMS", url: "https://tms.acme.example/", favicon: null, status: "ready" as const,
      canGoBack: false, canGoForward: false, ownerSessionId, siteToolCount: 0, siteTools: [], siteToolActivity: [],
    });
    const store = usePanelTabStore.getState();
    store.openTab("chat-a", browserTab("tab-1", "chat-a"));
    store.openTab("chat-a", { id: "record:gmail:1", type: "record", label: "Shipment 4471", sourceId: "gmail:1" });
    store.openTab("chat-b", browserTab("tab-2", "chat-b"));
    const listeners = new Set<(payload: { cleared: boolean }) => void>();
    const { bridge } = fakeBridge();
    await withDom(async ({ mount, act, queries }) => {
      window.__OMNIRUSH_ELECTRON__ = { ...window.__OMNIRUSH_ELECTRON__, browser: { onAccountChanged: (callback) => { listeners.add(callback); return () => listeners.delete(callback); } } };
      queries.setQueryData(browserLibraryKeys.summary, { imports: [], bookmarks: 4, history: 3 });
      await mount(<BrowserAccountChanges />);
      expect(listeners.size).toBe(1);

      await act(() => { for (const listener of listeners) listener({ cleared: false }); });
      expect(queries.getQueryState(browserLibraryKeys.summary)?.isInvalidated).toBe(true);
      expect(usePanelTabStore.getState().sessions["chat-b"]?.tabs.map((tab) => tab.id)).toEqual(["tab-2"]);

      await act(() => { for (const listener of listeners) listener({ cleared: true }); });
      const sessions = usePanelTabStore.getState().sessions;
      expect(sessions["chat-a"]?.tabs.map((tab) => tab.id)).toEqual(["record:gmail:1"]);
      expect(sessions["chat-a"]?.activeTabId).toBe("record:gmail:1");
      expect(sessions["chat-b"]?.tabs).toEqual([]);
      expect(localStorage.getItem("omnirush:panel-tabs:v1") ?? "").not.toContain("tab-2");
    }, bridge);
    expect(listeners.size).toBe(0);
    usePanelTabStore.getState().clearSession("chat-a");
    usePanelTabStore.getState().clearSession("chat-b");
  });

  test("every new string has a Chinese copy", () => {
    const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
    const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
    const keys = (source: string) => new Set([...source.matchAll(/"(browser_(?:import|library)\.[a-z_0-9]+?)(?:_one|_other)?":/g)].map((match) => match[1]));
    expect([...keys(en)].filter((key) => !keys(zh).has(key))).toEqual([]);
    expect(t("browser_import.count_sites", { count: 3, n: "3", lng: "zh" })).toBe("3 个网站");
  });
});
