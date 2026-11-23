import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BrowserPanelTab } from "@omnirush/browser-tabs";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

import type { BrowserScreenSource, BrowserSitePermission, BrowserSitesBridge } from "../src/app/lib/desktop";
import { setLocale, t } from "../src/i18n";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

type Choice = Parameters<BrowserSitesBridge["answer"]>[2];

const SOURCES: BrowserScreenSource[] = [
  { id: "screen:1:0", name: "Entire screen", kind: "screen", thumbnail: null },
  ...Array.from({ length: 11 }, (_, index) => ({
    id: `window:${index + 10}:0`,
    name: index === 0 ? "Quarterly operations review for the northeast lanes, final draft with carrier rates" : `Window ${index + 1}`,
    kind: "window" as const,
    thumbnail: null,
  })),
];

const entry = (origin: string, at: number, overrides: Partial<BrowserSitePermission> = {}): BrowserSitePermission => ({
  origin, camera: null, microphone: null, notifications: null, at, ...overrides,
});

function fakeSites(list: BrowserSitePermission[] = []) {
  const calls = { prompts: [] as boolean[], answers: [] as Array<[string, string, Choice]>, forgot: [] as string[], settings: [] as string[], sources: [] as string[] };
  let current = [...list];
  const bridge: BrowserSitesBridge = {
    setPrompts: async (enabled) => { calls.prompts.push(enabled); return enabled; },
    answer: async (tabId, promptId, choice) => { calls.answers.push([tabId, promptId, choice]); return true; },
    screenSources: async (_tabId, promptId) => { calls.sources.push(promptId); return { access: "granted", sources: SOURCES }; },
    openSystemSettings: async (kind) => { calls.settings.push(kind); return true; },
    list: async () => current,
    forget: async (origin) => { calls.forgot.push(origin); current = current.filter((item) => item.origin !== origin); return true; },
    onChanged: () => () => undefined,
  };
  return { bridge, calls };
}

async function withDom(
  run: (helpers: { mount: (node: ReactNode) => Promise<void>; act: (work: () => unknown) => Promise<void> }) => Promise<void>,
  sites: BrowserSitesBridge | null,
  workOn = true,
) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const electron = sites ? { browserSites: sites, browserLibrary: {} } : null;
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: electron });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (workOn) queries.setQueryData(["omnirush-work-state", "http://work.test"], { enabled: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
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
    await run({ mount: (node) => settle(() => root.render(<QueryClientProvider client={queries}>{node}</QueryClientProvider>)), act: settle });
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: undefined });
  }
}

notifyManager.setScheduler((callback) => callback());

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const text = () => document.body.textContent ?? "";

function tab(sitePrompt: BrowserPanelTab["sitePrompt"]): BrowserPanelTab {
  return {
    id: "tab-1", type: "browser", label: "Meet", url: "https://meet.google.com/abc-defg-hij", favicon: null, status: "ready",
    canGoBack: false, canGoForward: false, ownerSessionId: "__omnirush_no_session__", sitePrompt,
    siteToolCount: 0, siteTools: [], siteToolActivity: [],
  };
}

describe("calls and alerts in the built-in browser", () => {
  test("copy is plain, short and in both languages, with no dashes", () => {
    const read = (name: string) => readFileSync(new URL(`../src/i18n/locales/${name}.ts`, import.meta.url), "utf8")
      .split("\n").filter((line) => line.includes('"site_permissions.'));
    const en = read("en");
    const zh = read("zh");
    expect(en.length).toBeGreaterThan(30);
    expect(zh.map((line) => line.split(":")[0])).toEqual(en.map((line) => line.split(":")[0]));
    for (const line of [...en, ...zh]) {
      expect(line).not.toMatch(/[\u2013\u2014!]/);
      expect(line.toLowerCase()).not.toMatch(/\bai\b|ai browser/);
    }
  });

  test("questions and the list read naturally in English and Chinese", async () => {
    const { sitePromptMessage, sitePromptParts, sitePermissionSummary, siteHost, siteBrand, siteName, MEETINGS_OPEN_IN_APP, meetingLinksOpenInApp } = await import("../src/react-app/domains/browser-logins/site-permissions");
    setLocale("en");
    expect(sitePromptMessage({ origin: "https://meet.google.com", kinds: ["camera", "microphone"] })).toBe("meet.google.com wants to use your camera and microphone.");
    expect(sitePromptMessage({ origin: "https://meet.google.com", kinds: ["microphone"] })).toBe("meet.google.com wants to use your microphone.");
    expect(sitePromptMessage({ origin: "https://app.slack.com", kinds: ["notifications"] })).toBe("app.slack.com wants to show notifications.");
    expect(sitePromptMessage({ origin: "https://meet.google.com", kinds: ["camera"], system: true })).toBe("Your computer blocks the camera for OmniRush. Turn it on in settings.");
    // A long site name can be shortened on screen; the question around it stays whole.
    expect(sitePromptParts({ origin: "https://meet.google.com", kinds: ["camera", "microphone"] })).toEqual({ before: "", host: "meet.google.com", after: " wants to use your camera and microphone." });
    expect(sitePromptParts({ origin: "https://meet.google.com", kinds: ["camera"], system: true }).host).toBeNull();
    expect(sitePermissionSummary(entry("https://meet.google.com", 1, { camera: "allow", microphone: "allow", notifications: "block" }))).toBe("Camera and microphone allowed · Notifications blocked");
    expect(sitePermissionSummary(entry("https://app.slack.com", 1, { notifications: "allow" }))).toBe("Notifications allowed");
    expect(siteHost("http://localhost:8080")).toBe("localhost:8080");
    expect(siteBrand("https://meet.google.com")).toBe("google");
    expect(siteBrand("https://acme.zoom.us")).toBe("zoom");
    expect(siteBrand("https://teams.microsoft.com")).toBe("teams");
    expect(siteBrand("https://acmefreight.slack.com")).toBe("slack");
    expect(siteBrand("https://tms.acmefreight.example")).toBeNull();
    expect(siteBrand("https://app.hubspot.com")).toBe("hubspot");
    expect(siteBrand("https://acmefreight.atlassian.net")).toBe("jira");
    expect(siteName("https://app.hubspot.com")).toBe("hubspot");
    expect(siteName("https://tms.acmefreight.co.uk")).toBe("acmefreight");
    expect(siteName("http://localhost:8080")).toBe("localhost");
    setLocale("zh");
    expect(sitePromptMessage({ origin: "https://meet.google.com", kinds: ["camera", "microphone"] })).toBe("meet.google.com 想使用你的摄像头和麦克风。");
    expect(sitePermissionSummary(entry("https://meet.google.com", 1, { camera: "allow", microphone: "allow" }))).toBe("已允许摄像头和麦克风");
    expect(sitePromptParts({ origin: "https://meet.google.com", kinds: ["notifications"] })).toEqual({ before: "", host: "meet.google.com", after: " 想向你发送通知。" });
    setLocale("en");
    // Meeting links stay in the person's own browser until a real call passed on macOS and Windows.
    expect(MEETINGS_OPEN_IN_APP).toBe(false);
    expect(meetingLinksOpenInApp()).toBe(false);
  });

  test("the bar asks above the page and sends Allow or Block for that question", async () => {
    const { bridge, calls } = fakeSites();
    const { SitePermissionBar, ScreenSharePicker } = await import("../src/react-app/domains/browser-logins/site-permission-bar");
    await withDom(async ({ mount, act }) => {
      await mount(<><SitePermissionBar tab={tab({ id: "site_1", origin: "https://meet.google.com", kinds: ["camera", "microphone"] })} /><ScreenSharePicker tab={tab({ id: "site_1", origin: "https://meet.google.com", kinds: ["camera", "microphone"] })} /></>);
      expect(byTestId("site-permission-bar")?.textContent).toContain("meet.google.com wants to use your camera and microphone.");
      expect(byTestId("screen-share-picker")).toBeNull();
      await act(() => byTestId("site-permission-allow")!.click());
      await act(() => byTestId("site-permission-block")!.click());
      expect(calls.answers).toEqual([["tab-1", "site_1", "allow"], ["tab-1", "site_1", "block"]]);
    }, bridge);
  });

  test("no question, no bar; and the computer blocking the camera points to its settings", async () => {
    const { bridge, calls } = fakeSites();
    const { SitePermissionBar } = await import("../src/react-app/domains/browser-logins/site-permission-bar");
    await withDom(async ({ mount }) => {
      await mount(<SitePermissionBar tab={tab(null)} />);
      expect(byTestId("site-permission-bar")).toBeNull();
    }, bridge);
    await withDom(async ({ mount, act }) => {
      await mount(<SitePermissionBar tab={tab({ id: "site_2", origin: "https://meet.google.com", kinds: ["camera"], system: true })} />);
      expect(byTestId("site-permission-allow")).toBeNull();
      const open = [...document.querySelectorAll("button")].find((button) => button.textContent === "Open settings")!;
      await act(() => open.click());
      expect(calls.settings).toEqual(["camera"]);
      expect(calls.answers.at(-1)).toEqual(["tab-1", "site_2", "dismiss"]);
    }, bridge);
    // Outside the desktop app there is nothing to ask.
    await withDom(async ({ mount }) => {
      await mount(<SitePermissionBar tab={tab({ id: "site_3", origin: "https://meet.google.com", kinds: ["camera"] })} />);
      expect(byTestId("site-permission-bar")).toBeNull();
    }, null);
  });

  test("the screen picker shows screens, then windows up to eight tiles, and shares only what was picked", async () => {
    const { bridge, calls } = fakeSites();
    const { ScreenSharePicker, SitePermissionBar } = await import("../src/react-app/domains/browser-logins/site-permission-bar");
    const screenTab = tab({ id: "site_4", origin: "https://meet.google.com", kinds: ["screen"] });
    await withDom(async ({ mount, act }) => {
      await mount(<><SitePermissionBar tab={screenTab} /><ScreenSharePicker tab={screenTab} /></>);
      expect(byTestId("site-permission-bar")).toBeNull();
      expect(text()).toContain("Choose what to share with meet.google.com");
      expect(calls.sources).toEqual(["site_4"]);
      expect(allByTestId("screen-share-source")).toHaveLength(8);
      const long = allByTestId("screen-share-source")[1]!;
      expect(long.getAttribute("title")).toBe(SOURCES[1]!.name);
      expect(byTestId("screen-share-share")?.hasAttribute("disabled")).toBe(true);
      const showAll = [...document.querySelectorAll("button")].find((button) => button.textContent === "Show all (11)")!;
      await act(() => showAll.click());
      expect(allByTestId("screen-share-source")).toHaveLength(12);
      await act(() => long.click());
      expect(long.getAttribute("aria-pressed")).toBe("true");
      await act(() => byTestId("screen-share-share")!.click());
      expect(calls.answers.at(-1)).toEqual(["tab-1", "site_4", { share: { id: SOURCES[1]!.id, name: SOURCES[1]!.name } }]);
      await act(() => byTestId("screen-share-cancel")!.click());
      expect(calls.answers.at(-1)).toEqual(["tab-1", "site_4", "dismiss"]);
    }, bridge);
  });

  test("Work accounts turn the questions on; everyone else keeps them off", async () => {
    const { BrowserSitePrompts } = await import("../src/react-app/domains/browser-logins/site-permission-bar");
    const work = fakeSites();
    await withDom(async ({ mount }) => { await mount(<BrowserSitePrompts />); }, work.bridge, true);
    expect(work.calls.prompts).toEqual([true]);
    const consumer = fakeSites();
    await withDom(async ({ mount }) => { await mount(<BrowserSitePrompts />); }, consumer.bridge, false);
    expect(consumer.calls.prompts).toEqual([false]);
  });

  test("Site settings from the Work browser's .. menu: this site's camera, microphone and notification choices, with Remove", async () => {
    const { BrowserSitePrompts, SITE_SETTINGS_EVENT } = await import("../src/react-app/domains/browser-logins/site-permission-bar");
    const { bridge, calls } = fakeSites([entry("https://meet.google.com", 2, { camera: "allow", notifications: "block" }), entry("https://app.slack.com", 1, { notifications: "allow" })]);
    const open = (url: string) => window.dispatchEvent(new CustomEvent(SITE_SETTINGS_EVENT, { detail: { url } }));
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserSitePrompts />);
      expect(byTestId("site-settings-dialog")).toBeNull();
      await act(() => open("https://meet.google.com/abc-defg-hij?authuser=0"));
      expect(byTestId("site-settings-dialog")?.textContent).toContain("meet.google.com");
      expect(allByTestId("site-settings-row").map((row) => row.textContent)).toEqual(["CameraAllowed", "MicrophoneAsks first", "NotificationsBlocked"]);
      await act(() => byTestId("site-settings-remove")!.click());
      expect(calls.forgot).toEqual(["https://meet.google.com"]);
      // Forgotten: every choice asks again, and there is nothing left to remove.
      expect(allByTestId("site-settings-row").map((row) => row.textContent)).toEqual(["CameraAsks first", "MicrophoneAsks first", "NotificationsAsks first"]);
      expect(byTestId("site-settings-remove")).toBeNull();
      await act(() => byTestId("site-settings-done")!.click());
      expect(byTestId("site-settings-dialog")).toBeNull();
      // A site with no choices yet still opens, with nothing to remove.
      await act(() => open("https://tms.acme.example/s/4471"));
      expect(allByTestId("site-settings-row")).toHaveLength(3);
      expect(byTestId("site-settings-remove")).toBeNull();
    }, bridge);
    // Without Work: nothing listens.
    const consumer = fakeSites([entry("https://meet.google.com", 2, { camera: "allow" })]);
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserSitePrompts />);
      await act(() => open("https://meet.google.com/x"));
      expect(byTestId("site-settings-dialog")).toBeNull();
    }, consumer.bridge, false);
  });

  test("Settings lists eight sites, then Show all, with a search; Remove forgets a site; nothing shows when empty", async () => {
    const many = Array.from({ length: 11 }, (_, index) => entry(`https://site${index + 1}.example`, 100 - index, { camera: "allow" }));
    many[0] = entry("https://meet.google.com", 200, { camera: "allow", microphone: "allow", notifications: "block" });
    const { bridge, calls } = fakeSites(many);
    const { BrowserSitePermissionsSection } = await import("../src/react-app/domains/browser-logins/site-permissions-section");
    await withDom(async ({ mount, act }) => {
      await mount(<BrowserSitePermissionsSection />);
      expect(text()).toContain(t("site_permissions.section_title"));
      expect(allByTestId("site-permissions-row")).toHaveLength(8);
      expect(allByTestId("site-permissions-row")[0]?.textContent).toContain("Camera and microphone allowed · Notifications blocked");
      expect(allByTestId("site-permissions-row")[0]?.querySelector("[data-brand-tile=\"google\"]")).not.toBeNull();
      expect(byTestId("site-permissions-show-all")?.textContent).toBe("Show all (11)");
      await act(() => byTestId("site-permissions-show-all")!.click());
      expect(allByTestId("site-permissions-row")).toHaveLength(11);
      const search = byTestId("site-permissions-search") as HTMLInputElement;
      expect(search).not.toBeNull();
      await act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(search, "site1");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(allByTestId("site-permissions-row").map((row) => row.querySelector("p")?.textContent)).toEqual(["site10.example", "site11.example"]);
      await act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(search, "nothing-like-this");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(byTestId("site-permissions-no-match")).not.toBeNull();
      await act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(search, "meet");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const remove = allByTestId("site-permissions-row")[0]!.querySelector("button")!;
      expect(remove.getAttribute("aria-label")).toBe("Remove meet.google.com");
      await act(() => remove.click());
      expect(calls.forgot).toEqual(["https://meet.google.com"]);
    }, bridge);

    const empty = fakeSites([]);
    await withDom(async ({ mount }) => {
      await mount(<BrowserSitePermissionsSection />);
      expect(byTestId("site-permissions")).toBeNull();
    }, empty.bridge);

    // A short list: no search, no Show all.
    const few = fakeSites([entry("https://app.slack.com", 1, { notifications: "allow" })]);
    await withDom(async ({ mount }) => {
      await mount(<BrowserSitePermissionsSection />);
      expect(allByTestId("site-permissions-row")).toHaveLength(1);
      expect(byTestId("site-permissions-search")).toBeNull();
      expect(byTestId("site-permissions-show-all")).toBeNull();
    }, few.bridge);

    // Without Work the section is not there at all.
    const consumer = fakeSites([entry("https://app.slack.com", 1, { notifications: "allow" })]);
    await withDom(async ({ mount }) => {
      await mount(<BrowserSitePermissionsSection />);
      expect(byTestId("site-permissions")).toBeNull();
    }, consumer.bridge, false);
  });
});
