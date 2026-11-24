import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { USER_TABS_OWNER, type BrowserPanelTab, type BrowserStatePayload } from "@omnirush/browser-tabs";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { BrowserDownload, BrowserFindResult, BrowserLibraryBridge, BrowserShortcutAction } from "../src/app/lib/desktop";
import type { Platform } from "../src/react-app/kernel/platform";

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

type Calls = {
  created: Array<[string | undefined, string | null | undefined]>;
  closed: string[];
  reloads: number;
  backs: number;
  finds: Array<[string, string, { forward?: boolean; next?: boolean } | undefined]>;
  stops: string[];
  focusedPage: string[];
  zooms: Array<[string, string | undefined]>;
  prints: string[];
  actions: Array<[string, string]>;
  tools: Array<{ tools?: boolean; page?: boolean; language?: string }>;
};

function fakeBrowser(initial: BrowserStatePayload, downloads: BrowserDownload[] = []) {
  const calls: Calls = { created: [], closed: [], reloads: 0, backs: 0, finds: [], stops: [], focusedPage: [], zooms: [], prints: [], actions: [], tools: [] };
  const findListeners = new Set<(result: BrowserFindResult) => void>();
  const shortcutListeners = new Set<(payload: { tabId: string | null; action: BrowserShortcutAction; url?: string }) => void>();
  const downloadListeners = new Set<(next: BrowserDownload[]) => void>();
  let factor = 1;
  let requestId = 0;
  const browser = {
    show: async () => undefined,
    hide: async () => undefined,
    setBounds: async () => undefined,
    setVisibleSession: async (owner: string | null) => owner,
    navigate: async () => undefined,
    back: async () => { calls.backs += 1; },
    forward: async () => undefined,
    reload: async () => { calls.reloads += 1; },
    getState: async () => initial,
    onStateChange: () => () => undefined,
    createTab: async (url?: string, owner?: string | null) => { calls.created.push([url, owner]); return { tabId: "created" }; },
    selectTab: async (id: string) => id,
    closeTab: async (id: string) => { calls.closed.push(id); return id; },
    suspendTab: async (id: string) => id,
    suspendOldest: async () => null,
    restoreSaved: async () => [],
    pageContext: async () => ({ title: "", url: "", selection: "" }),
    setUserTabTools: async (options: { tools?: boolean; page?: boolean; language?: string }) => { calls.tools.push(options); return { tools: true, page: true, language: "en" }; },
    find: async (tabId: string, text: string, options?: { forward?: boolean; next?: boolean }) => { calls.finds.push([tabId, text, options]); requestId += 1; return text ? requestId : null; },
    stopFind: async (tabId: string) => { calls.stops.push(tabId); return true; },
    focusPage: async (tabId: string) => { calls.focusedPage.push(tabId); return true; },
    zoom: async (tabId: string, action?: "in" | "out" | "reset") => {
      calls.zooms.push([tabId, action]);
      if (action === "in") factor = factor < 1.1 ? 1.1 : 1.25;
      if (action === "out") factor = 0.9;
      if (action === "reset") factor = 1;
      return { factor };
    },
    print: async (tabId: string) => { calls.prints.push(tabId); return true; },
    downloads: async () => downloads,
    downloadAction: async (id: string, action: "show" | "cancel" | "folder") => { calls.actions.push([id, action]); return downloads; },
    clearDownloads: async () => [],
    onFindResult: (callback: (result: BrowserFindResult) => void) => { findListeners.add(callback); return () => { findListeners.delete(callback); }; },
    onShortcut: (callback: (payload: { tabId: string | null; action: BrowserShortcutAction; url?: string }) => void) => { shortcutListeners.add(callback); return () => { shortcutListeners.delete(callback); }; },
    onDownloadsChange: (callback: (next: BrowserDownload[]) => void) => { downloadListeners.add(callback); return () => { downloadListeners.delete(callback); }; },
  };
  return {
    browser,
    calls,
    findResult: (result: BrowserFindResult) => { for (const listener of findListeners) listener(result); },
    shortcut: (action: BrowserShortcutAction, url?: string) => { for (const listener of shortcutListeners) listener({ tabId: "u1", action, url }); },
    downloadsChanged: (next: BrowserDownload[]) => { for (const listener of downloadListeners) listener(next); },
  };
}

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

const testPlatform: Platform = {
  platform: "desktop",
  os: "linux",
  capabilities: { nativeFilePicker: false, revealInFileManager: false, terminal: false, autoUpdate: false, osNotifications: false, localRuntimeControl: false, desktopBootstrap: false },
  openLink: () => undefined,
  async restart() {},
  async notify() {},
};

async function withDom(
  run: (helpers: { mount: (node: ReactNode) => Promise<void>; act: (work: () => unknown) => Promise<void>; unmount: () => Promise<void> }) => Promise<void>,
  electron: { browser?: unknown; browserLibrary?: BrowserLibraryBridge } | null,
) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: electron });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(["omnirush-work-state", "http://work.test"], { enabled: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { PlatformProvider } = await import("../src/react-app/kernel/platform");
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const settle = async (work: () => unknown) => {
    await act(async () => {
      await work();
      for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    });
  };
  try {
    await run({
      mount: (node) => settle(() => root.render(<QueryClientProvider client={queries}><PlatformProvider value={testPlatform}><TooltipProvider>{node}</TooltipProvider></PlatformProvider></QueryClientProvider>)),
      act: settle,
      unmount: async () => {
        mounted = false;
        await act(async () => root.unmount());
      },
    });
  } finally {
    if (mounted) await act(async () => root.unmount());
    queries.clear();
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: undefined });
  }
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const mac = () => /Mac/i.test(navigator.platform);
/** Cmd on macOS, Ctrl elsewhere, as the app reads it. */
function press(target: Element, key: string, extra: KeyboardEventInit = {}) {
  const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key === "[" ? "BracketLeft" : key === "]" ? "BracketRight" : key === "=" ? "Equal" : "";
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...(mac() ? { metaKey: true } : { ctrlKey: true }), ...extra });
  target.dispatchEvent(event);
  return event;
}
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const page = stateOf([
  tab("u1", USER_TABS_OWNER, "https://tms.example.com/s/4471", { label: "Shipment 4471", canGoBack: true }),
  tab("u2", USER_TABS_OWNER, "https://linear.app/acme", { label: "Ops board" }),
], { [USER_TABS_OWNER]: "u1" });

describe("Work browser basics", () => {
  test("browser keys act only while the Work browser has focus; elsewhere Cmd or Ctrl+T, Shift+T and P stay the app's", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const { useShellShortcuts } = await import("../src/react-app/shell/use-shell-shortcuts");
    const { useEditorStore } = await import("../src/react-app/domains/session/editor/editor-store");
    const shell = { next: 0, previous: 0 };
    function Shell() {
      useShellShortcuts({ canCreateTask: false, workspaceId: "", onCreateTask: () => undefined, onNextSessionTab: () => { shell.next += 1; }, onPrevSessionTab: () => { shell.previous += 1; } });
      return <input data-testid="elsewhere" aria-label="Somewhere else in the app" />;
    }
    const fake = fakeBrowser(page);
    await withDom(async ({ mount, act, unmount }) => {
      useEditorStore.getState().setQuickOpen(false);
      await mount(<><Shell /><WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} /></>);
      expect(fake.calls.tools).toEqual([{ page: true }]);
      // The page takes the keyboard when it opens.
      expect(document.activeElement).toBe(byTestId("work-browser"));
      const root = byTestId("work-browser")!;
      await act(() => press(root, "t"));
      expect(fake.calls.created).toEqual([["about:blank", USER_TABS_OWNER]]);
      await act(() => press(root, "w"));
      expect(fake.calls.closed).toEqual(["u1"]);
      await act(() => press(root, "r"));
      expect(fake.calls.reloads).toBe(1);
      await act(() => press(root, "["));
      expect(fake.calls.backs).toBe(1);
      await act(() => press(root, "p"));
      expect(fake.calls.prints).toEqual(["u1"]);
      await act(() => press(root, "="));
      expect(fake.calls.zooms).toEqual([["u1", "in"]]);
      await act(() => press(root, "l"));
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Type an address");
      // In the address field too, the browser's keys are the browser's.
      await act(() => press(document.activeElement!, "f"));
      expect(byTestId("work-browser-find")).not.toBeNull();
      expect(shell.next).toBe(0);
      expect(useEditorStore.getState().quickOpen).toBe(false);
      // Shift+T is not a browser key: the app's previous tab, even here.
      await act(() => press(root, "t", { shiftKey: true }));
      expect(shell.previous).toBe(1);

      // Focus elsewhere in the app: today's shortcuts, and the browser does nothing.
      const elsewhere = byTestId("elsewhere") as HTMLInputElement;
      elsewhere.focus();
      const created = fake.calls.created.length;
      await act(() => press(elsewhere, "t"));
      expect(shell.next).toBe(1);
      await act(() => press(elsewhere, "t", { shiftKey: true }));
      expect(shell.previous).toBe(2);
      await act(() => press(elsewhere, "p"));
      expect(useEditorStore.getState().quickOpen).toBe(true);
      await act(() => press(elsewhere, "r"));
      expect(fake.calls.created.length).toBe(created);
      expect(fake.calls.prints).toEqual(["u1"]);
      expect(fake.calls.reloads).toBe(1);

      // Keys caught on the web page arrive from the desktop app.
      await act(() => fake.shortcut("reload"));
      expect(fake.calls.reloads).toBe(2);
      await act(() => fake.shortcut("open-tab", "https://linear.app/acme/issue/OPS-482"));
      expect(fake.calls.created.at(-1)).toEqual(["https://linear.app/acme/issue/OPS-482", USER_TABS_OWNER]);
      await unmount();
      expect(fake.calls.tools.at(-1)).toEqual({ page: false });
      // Closed: nothing of the browser is left listening.
      const after = new KeyboardEvent("keydown", { key: "t", code: "KeyT", bubbles: true, cancelable: true, ...(mac() ? { metaKey: true } : { ctrlKey: true }) });
      document.body.dispatchEvent(after);
      expect(fake.calls.created.length).toBe(created + 1);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
    useEditorStore.getState().setQuickOpen(false);
  });

  test("find in page: typing searches the tab, the count shows, Enter and Shift+Enter step, Esc closes and gives the page the keyboard", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const fake = fakeBrowser(page);
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => fake.shortcut("find"));
      const input = byTestId("work-browser-find-input") as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      await act(async () => {
        typeInto(input, "pallet");
        await wait(120);
      });
      expect(fake.calls.finds.at(-1)).toEqual(["u1", "pallet", undefined]);
      await act(() => fake.findResult({ tabId: "u1", requestId: 9, matches: 12, active: 3, final: true }));
      expect(byTestId("work-browser-find-count")?.textContent).toBe("3 of 12");
      // Another tab's results are not this search's.
      await act(() => fake.findResult({ tabId: "u2", requestId: 10, matches: 1, active: 1, final: true }));
      expect(byTestId("work-browser-find-count")?.textContent).toBe("3 of 12");
      await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      expect(fake.calls.finds.at(-1)).toEqual(["u1", "pallet", { forward: true, next: true }]);
      await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
      expect(fake.calls.finds.at(-1)).toEqual(["u1", "pallet", { forward: false, next: true }]);
      await act(() => fake.findResult({ tabId: "u1", requestId: 99, matches: 0, active: 0, final: true }));
      expect(byTestId("work-browser-find-count")?.textContent).toBe("No matches");
      await act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(byTestId("work-browser-find")).toBeNull();
      expect(fake.calls.stops).toEqual(["u1"]);
      expect(fake.calls.focusedPage).toEqual(["u1"]);
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
    // Browser home has no page to search.
    const home = fakeBrowser(stateOf([tab("h1", USER_TABS_OWNER, "about:blank")], { [USER_TABS_OWNER]: "h1" }));
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => home.shortcut("find"));
      expect(byTestId("work-browser-find")).toBeNull();
      await act(() => press(byTestId("work-browser")!, "p"));
      expect(home.calls.prints).toEqual([]);
    }, { browser: home.browser, browserLibrary: libraryBridge() });
  });

  test("the .. menu: find, zoom with its percentage, print, and the last downloads with Show in folder", async () => {
    const { WorkBrowserPage } = await import("../src/react-app/domains/work/browser/work-browser-page");
    const downloads: BrowserDownload[] = [
      { id: "d3", filename: "Q4 carrier rates for every lane and every customer.xlsx", state: "progressing", receivedBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024, startedAt: 3 },
      { id: "d2", filename: "PO-7730.pdf", state: "completed", receivedBytes: 2_400_000, totalBytes: 2_400_000, startedAt: 2 },
      { id: "d1", filename: "manifest.csv", state: "failed", receivedBytes: 10, totalBytes: 0, startedAt: 1 },
    ];
    const fake = fakeBrowser(page, downloads);
    await withDom(async ({ mount, act }) => {
      await mount(<WorkBrowserPage onAsk={async () => undefined} openExternal={() => undefined} />);
      await act(() => byTestId("work-browser-more")!.click());
      expect(byTestId("work-browser-zoom-value")?.textContent).toBe("100%");
      expect(byTestId("work-browser-menu-downloads")?.textContent).toContain("1 downloading");
      await act(() => byTestId("work-browser-zoom-in")!.click());
      expect(fake.calls.zooms.at(-1)).toEqual(["u1", "in"]);
      expect(byTestId("work-browser-zoom-value")?.textContent).toBe("110%");
      await act(() => byTestId("work-browser-zoom-value")!.click());
      expect(byTestId("work-browser-zoom-value")?.textContent).toBe("100%");
      await act(() => byTestId("work-browser-menu-downloads")!.click());
      const rows = allByTestId("work-browser-download");
      expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Q4 carrier rates for every lane and every customer.xlsx", "PO-7730.pdf", "manifest.csv"]);
      expect(rows.map((row) => row.querySelectorAll("p")[1]?.textContent)).toEqual(["25% of 2.0 MB", "Done, 2.3 MB", "Did not finish"]);
      expect(rows[0]!.querySelector("p")?.getAttribute("title")).toBe("Q4 carrier rates for every lane and every customer.xlsx");
      await act(() => byTestId("work-browser-download-show")!.click());
      expect(fake.calls.actions).toEqual([["d2", "show"]]);
      await act(() => byTestId("work-browser-download-cancel")!.click());
      expect(fake.calls.actions.at(-1)).toEqual(["d3", "cancel"]);
      await act(() => byTestId("work-browser-downloads-folder")!.click());
      expect(fake.calls.actions.at(-1)).toEqual(["", "folder"]);
      await act(() => byTestId("work-browser-more")!.click());
      await act(() => byTestId("work-browser-menu-print")!.click());
      expect(fake.calls.prints).toEqual(["u1"]);
      await act(() => byTestId("work-browser-more")!.click());
      await act(() => byTestId("work-browser-menu-find")!.click());
      expect(byTestId("work-browser-find")).not.toBeNull();
      // The menu does not take the keyboard back from the find field when it closes.
      await act(() => wait(300));
      expect(document.activeElement).toBe(byTestId("work-browser-find-input"));
    }, { browser: fake.browser, browserLibrary: libraryBridge() });
  });

  test("download notes: a file that ended before the page opened is not news; one that ends while it is open is told once", async () => {
    const sonner = await import("../src/components/ui/sonner");
    const told = spyOn(sonner.toast, "success");
    const { downloadStatus, useDownloadNotices } = await import("../src/react-app/domains/work/browser/browser-downloads");
    const React = await import("react");
    let setList: (next: BrowserDownload[] | null) => void = () => undefined;
    function Notices() {
      const [list, set] = React.useState<BrowserDownload[] | null>(null);
      setList = set;
      useDownloadNotices(list);
      return null;
    }
    const pod: BrowserDownload = { id: "notes-pod", filename: "pod-4471.csv", state: "completed", receivedBytes: 38, totalBytes: 38, startedAt: 1 };
    const invoice: BrowserDownload = { id: "notes-invoice", filename: "invoice-4471.pdf", state: "progressing", receivedBytes: 10, totalBytes: 100, startedAt: 2 };
    expect(downloadStatus(pod)).toBe("Done, 38 B");
    try {
      await withDom(async ({ mount, act }) => {
        await mount(<Notices />);
        // The desktop app answers with what this session already downloaded: no note for it.
        await act(() => setList([pod]));
        await act(() => setList([invoice, pod]));
        await act(() => setList([{ ...invoice, state: "completed", receivedBytes: 100 }, pod]));
        // Told after React finished the update, never from inside it (the toaster could miss it there).
        expect(told).not.toHaveBeenCalled();
        await act(() => wait(5));
        await act(() => setList([{ ...invoice, state: "completed", receivedBytes: 100 }, pod]));
        await act(() => wait(5));
      }, { browser: fakeBrowser(page).browser, browserLibrary: libraryBridge() });
      // The page opens again (Expand from a tab): neither comes back.
      await withDom(async ({ mount, act }) => {
        await mount(<Notices />);
        await act(() => setList([{ ...invoice, state: "completed", receivedBytes: 100 }, pod]));
        await act(() => wait(5));
      }, { browser: fakeBrowser(page).browser, browserLibrary: libraryBridge() });
      expect(told.mock.calls.map((call) => call[0])).toEqual(["invoice-4471.pdf is in Downloads"]);
    } finally {
      told.mockRestore();
    }
  });

  test("download notes: two quick downloads while the page is open are both told once, also one first seen in the opening list", async () => {
    const sonner = await import("../src/components/ui/sonner");
    const told = spyOn(sonner.toast, "success");
    const { useDownloadNotices } = await import("../src/react-app/domains/work/browser/browser-downloads");
    const React = await import("react");
    let setList: (next: BrowserDownload[] | null) => void = () => undefined;
    function Notices() {
      const [list, set] = React.useState<BrowserDownload[] | null>(null);
      setList = set;
      useDownloadNotices(list);
      return null;
    }
    const later = Date.now() + 60_000;
    const pod: BrowserDownload = { id: "quick-pod", filename: "pod-4472.csv", state: "completed", receivedBytes: 38, totalBytes: 38, startedAt: later };
    const invoice: BrowserDownload = { id: "quick-invoice", filename: "invoice-4472.pdf", state: "progressing", receivedBytes: 0, totalBytes: 607, startedAt: later };
    try {
      await withDom(async ({ mount, act }) => {
        await mount(<Notices />);
        // The first list the page hears already has a file that started and ended after it opened: that is news.
        await act(() => setList([pod]));
        await act(() => setList([invoice, pod]));
        await act(() => setList([{ ...invoice, state: "completed", receivedBytes: 607 }, pod]));
        await act(() => wait(5));
        await act(() => setList([{ ...invoice, state: "completed", receivedBytes: 607 }, pod]));
        await act(() => wait(5));
      }, { browser: fakeBrowser(page).browser, browserLibrary: libraryBridge() });
      expect(told.mock.calls.map((call) => call[0])).toEqual(["pod-4472.csv is in Downloads", "invoice-4472.pdf is in Downloads"]);
    } finally {
      told.mockRestore();
    }
  });

  test("a Work account switches the basics on for the person's tabs; everyone else keeps the browser as before", async () => {
    const { useWorkBrowserTools } = await import("../src/react-app/domains/work/browser/browser-basics");
    function Tools({ on }: { on: boolean }) {
      useWorkBrowserTools(on);
      return null;
    }
    const work = fakeBrowser(page);
    await withDom(async ({ mount }) => {
      await mount(<Tools on />);
      expect(work.calls.tools).toEqual([{ tools: true, language: "en" }]);
      await mount(<Tools on={false} />);
      expect(work.calls.tools.at(-1)).toEqual({ tools: false, language: "en" });
    }, { browser: work.browser, browserLibrary: libraryBridge() });
  });

  test("shortcut map and labels", async () => {
    const { workBrowserShortcut, formatBytes, shortcutHint, downloadFraction } = await import("../src/react-app/domains/work/browser/browser-basics");
    const key = (value: string, extra: Partial<KeyboardEvent> = {}) => ({ key: value, code: `Key${value.toUpperCase()}`, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
    expect(workBrowserShortcut(key("t", { metaKey: true }), true)).toBe("new-tab");
    expect(workBrowserShortcut(key("t", { ctrlKey: true }), true)).toBeNull();
    expect(workBrowserShortcut(key("t", { ctrlKey: true }), false)).toBe("new-tab");
    expect(workBrowserShortcut(key("t", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(workBrowserShortcut(key("r", { ctrlKey: true, shiftKey: true }), false)).toBe("reload");
    expect(workBrowserShortcut(key("p", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(workBrowserShortcut({ ...key("["), code: "BracketLeft", metaKey: true }, true)).toBe("back");
    expect(workBrowserShortcut({ ...key("0"), code: "Digit0", ctrlKey: true }, false)).toBe("zoom-reset");
    expect(workBrowserShortcut(key("k", { metaKey: true }), true)).toBeNull();
    expect(shortcutHint("f", true)).toBe("⌘F");
    expect(shortcutHint("p", false)).toBe("Ctrl+P");
    expect(formatBytes(0)).toBe("0 B");
    // A small file is never "0 KB".
    expect(formatBytes(38)).toBe("38 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(2_400_000)).toBe("2.3 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
    expect(downloadFraction({ receivedBytes: 5, totalBytes: 0 })).toBeNull();
    expect(downloadFraction({ receivedBytes: 50, totalBytes: 100 })).toBe(0.5);
  });

  test("Clear browsing data also forgets the downloads list", async () => {
    const { BrowserImportSection } = await import("../src/react-app/domains/browser-logins/import-section");
    const fake = fakeBrowser(page);
    let cleared = 0;
    let libraryCleared = 0;
    const library = { ...libraryBridge(), summary: async () => ({ imports: [], bookmarks: 0, history: 3 }), clear: async () => { libraryCleared += 1; return { imports: [], bookmarks: 0, history: 0 }; } };
    const browser = { ...fake.browser, clearDownloads: async () => { cleared += 1; return []; } };
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserImportSection />);
      // Only pages visited here: still something to clear.
      expect(byTestId("browser-import-clear")?.textContent).toBe("Clear browsing data");
      await act(() => byTestId("browser-import-clear")!.click());
      await act(() => byTestId("browser-import-clear-confirm")!.click());
      expect(libraryCleared).toBe(1);
      expect(cleared).toBe(1);
    }, { browser, browserLibrary: library });
  });
});
