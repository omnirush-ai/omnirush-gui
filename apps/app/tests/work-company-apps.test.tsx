/** @jsxImportSource react */
// The company's Work browser settings in the app: the policy every surface reads, Apps for your team and Browser for
// your team in Work > Organization, and the import screens honouring the company's switches.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";

import type { ReactNode } from "react";

import type { BrowserImportInspection, BrowserImportRequest, BrowserImportSources, BrowserLibraryBridge } from "../src/app/lib/desktop";
import type { OmniRushWorkBrowser, OmniRushWorkMembers, OmniRushWorkOrgBrowser, OmniRushWorkOrgBrowserPatch } from "../src/app/lib/omnirush-server";

// The DOM comes before the views: the dialog's portal checks for it when its module loads.
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const toasts: string[] = [];
mock.module("@/components/ui/sonner", () => ({
  toast: {
    success: (message: string) => toasts.push(`success:${message}`),
    warning: (message: string) => toasts.push(`warning:${message}`),
    error: (message: string) => toasts.push(`error:${message}`),
  },
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { OmniRushServerError } = await import("../src/app/lib/omnirush-server");
const browser = await import("../src/react-app/domains/work/company-browser");
const { matchApps, nextApps, APPS_SHOWN } = await import("../src/react-app/domains/work/work-org-browser");
const { workMembersKey, workOrgBrowserKey, workStateKey } = await import("../src/react-app/domains/work/work-mode");
const { WorkOrganizationPage } = await import("../src/react-app/domains/work/work-org");
const { BrowserImportDialog, withCompanyPolicy } = await import("../src/react-app/domains/browser-logins/import-dialog");
const { BrowserImportSection } = await import("../src/react-app/domains/browser-logins/import-section");
const { LoginSyncCard } = await import("../src/react-app/domains/browser-logins/login-sync-card");
const { usePersistedBrowserLoginsStore } = await import("../src/react-app/domains/browser-logins/browser-logins-store");
const { t } = await import("../src/i18n");

const DEFAULTS: OmniRushWorkBrowser = { apps: [], import_bookmarks: true, import_signins: true, links_in_app: true, links_locked: false };
const APPS = [
  { name: "Acme TMS", url: "https://tms.acmefreight.example/" },
  { name: "Ops board", url: "https://acmefreight.atlassian.net/jira/software/projects/OPS/boards/1" },
  { name: "Wiki", url: "https://acmefreight.atlassian.net/wiki/spaces/OPS" },
  { name: "Support", url: "https://acmefreight.zendesk.com/agent" },
  { name: "Design", url: "https://www.figma.com/files/team/1" },
  { name: "HR portal", url: "https://hr.acmefreight.example/" },
  { name: "Payroll", url: "https://payroll.acmefreight.example/" },
];
const org = { id: "org_1", name: "Acme Freight" };
const members = (role: "owner" | "admin" | "member"): OmniRushWorkMembers => ({
  org, you_role: role, invites: [],
  members: [{ user_id: "u1", email: "ana@acmefreight.example", role, you: true }],
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  toasts.length = 0;
  Reflect.deleteProperty(window, "__OMNIRUSH_ELECTRON__");
});

async function render(node: ReactNode, queries: InstanceType<typeof QueryClient>) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<QueryClientProvider client={queries}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>));
  await settle();
  unmount = () => act(async () => root.unmount());
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error("nothing to click");
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};
const type = async (element: Element | null, value: string) => {
  if (!(element instanceof HTMLInputElement)) throw new Error("no input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
const rows = () => [...document.querySelectorAll("[data-company-app]")].map((row) => row.getAttribute("data-company-app"));

describe("the policy", () => {
  test("a missing block, Work off or an older server is the defaults; the block reads as the company set it", () => {
    expect(browser.workBrowserPolicy(undefined)).toEqual(browser.DEFAULT_WORK_BROWSER);
    expect(browser.workBrowserPolicy({ enabled: true })).toEqual(browser.DEFAULT_WORK_BROWSER);
    expect(browser.workBrowserPolicy({ enabled: false, browser: { ...DEFAULTS, import_signins: false } })).toEqual(browser.DEFAULT_WORK_BROWSER);
    expect(browser.workBrowserPolicy({ enabled: true, browser: { ...DEFAULTS, apps: APPS.slice(0, 1), import_signins: false, links_in_app: false, links_locked: true, org_name: " Acme Freight " } })).toEqual({
      managed: true, orgName: "Acme Freight", apps: APPS.slice(0, 1), importBookmarks: true, importSignIns: false, linksInApp: false, linksLocked: true,
    });
  });

  test("where Work links open: a lock wins, else the person's choice, else the company's default", () => {
    expect(browser.workLinksInApp({ linksInApp: true, linksLocked: false }, null)).toBe(true);
    expect(browser.workLinksInApp({ linksInApp: true, linksLocked: false }, false)).toBe(false);
    expect(browser.workLinksInApp({ linksInApp: false, linksLocked: false }, true)).toBe(true);
    expect(browser.workLinksInApp({ linksInApp: false, linksLocked: true }, true)).toBe(false);
    expect(browser.workLinksInApp({ linksInApp: true, linksLocked: true }, false)).toBe(true);
  });

  test("a member sees the company's apps as soon as a capabilities refresh lands in the Work state", async () => {
    const seen: string[][] = [];
    function Probe() {
      const policy = browser.useWorkBrowserPolicy();
      seen.push(policy.apps.map((app) => app.name));
      return <span data-testid="probe">{policy.apps.map((app) => app.name).join(",")}</span>;
    }
    const queries = new QueryClient();
    queries.setQueryData(["omnirush-work-state", "http://member.test"], { enabled: true, sources: [], message: null, workspaceId: null });
    await render(<Probe />, queries);
    expect(byTestId("probe")?.textContent).toBe("");
    await act(async () => queries.setQueryData(["omnirush-work-state", "http://member.test"], { enabled: true, sources: [], message: null, workspaceId: null, browser: { ...DEFAULTS, apps: APPS.slice(0, 2), org_name: "Acme Freight" } }));
    expect(byTestId("probe")?.textContent).toBe("Acme TMS,Ops board");
    // The same answer again renders nothing new.
    const renders = seen.length;
    await act(async () => queries.setQueryData(["omnirush-work-state", "http://member.test"], { enabled: true, sources: [], message: null, workspaceId: null, browser: { ...DEFAULTS, apps: APPS.slice(0, 2), org_name: "Acme Freight" } }));
    expect(seen.length).toBe(renders);
  });

  test("a company that turned sign-in import off stops it on this computer once per launch", async () => {
    const revoked: number[] = [];
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: { browserLogins: { disableForManagedContext: async () => { revoked.push(1); return {}; } } } });
    browser.enforceCompanySignIns({ enabled: true, browser: DEFAULTS });
    browser.enforceCompanySignIns({ enabled: false, browser: { ...DEFAULTS, import_signins: false } });
    expect(revoked).toEqual([]);
    browser.enforceCompanySignIns({ enabled: true, browser: { ...DEFAULTS, import_signins: false } });
    browser.enforceCompanySignIns({ enabled: true, browser: { ...DEFAULTS, import_signins: false } });
    await settle();
    expect(revoked).toEqual([1]);
  });

  test("app addresses: https only, a plain host gets https://, marks come from brands.ts, never a fetched icon", () => {
    expect(browser.checkAppUrl("tms.acmefreight.example")).toEqual({ url: "https://tms.acmefreight.example/" });
    expect(browser.checkAppUrl(" https://Linear.app/acme ")).toEqual({ url: "https://linear.app/acme" });
    expect(browser.checkAppUrl("https://tms.acmefreight.example:443/x")).toEqual({ url: "https://tms.acmefreight.example/x" });
    expect(browser.checkAppUrl("")).toEqual({ error: "empty" });
    expect(browser.checkAppUrl("http://tms.acmefreight.example")).toEqual({ error: "https" });
    expect(browser.checkAppUrl("javascript:alert(1)")).toEqual({ error: "invalid" });
    expect(browser.checkAppUrl("https://ana:pw@tms.acmefreight.example")).toEqual({ error: "credentials" });
    expect(browser.checkAppUrl("https://tms acme.example")).toEqual({ error: "invalid" });
    expect(browser.checkAppUrl(`https://${"a".repeat(2050)}.example`)).toEqual({ error: "too_long" });
    expect(browser.appBrand("https://acmefreight.atlassian.net/wiki/spaces/OPS")).toBe("confluence");
    expect(browser.appBrand("https://acmefreight.atlassian.net/jira/boards")).toBe("jira");
    expect(browser.appBrand("https://mail.google.com/mail/u/0")).toBe("gmail");
    expect(browser.appBrand("https://acme-my.sharepoint.com/personal")).toBe("onedrive");
    expect(browser.appBrand("https://acme.sharepoint.com/sites/ops")).toBe("sharepoint");
    expect(browser.appBrand("https://app.hubspot.com/contacts")).toBe("hubspot");
    expect(browser.appBrand("https://tms.acmefreight.example/")).toBeNull();
    expect(browser.appBrand("https://notgithub.com/")).toBeNull();
    expect(browser.suggestedAppName("https://www.figma.com/files")).toBe("Figma");
    expect(browser.suggestedAppName("https://tms.acmefreight.example/")).toBe("");
    expect(browser.appHost("https://www.figma.com/files/team/1?x=1")).toBe("figma.com/files/team/1?x=1");
    expect(browser.appHost("https://tms.acmefreight.example/")).toBe("tms.acmefreight.example");
    const source = readFileSync(new URL("../src/react-app/domains/work/work-org-browser.tsx", import.meta.url), "utf8")
      + readFileSync(new URL("../src/react-app/domains/work/company-browser.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/s2\/favicons|favicon|icon\.horse|duckduckgo\.com\/ip/);
  });

  test("the list helpers: search by name or address, add at the end, change one in place", () => {
    expect(matchApps(APPS, "atlassian").map((app) => app.name)).toEqual(["Ops board", "Wiki"]);
    expect(matchApps(APPS, " PAY ").map((app) => app.name)).toEqual(["Payroll"]);
    expect(matchApps(APPS, "")).toBe(APPS);
    const added = nextApps(APPS.slice(0, 2), null, { name: "New", url: "https://new.example/" });
    expect(added.map((app) => app.name)).toEqual(["Acme TMS", "Ops board", "New"]);
    expect(nextApps(added, 1, { name: "Board", url: "https://board.example/" }).map((app) => app.name)).toEqual(["Acme TMS", "Board", "New"]);
  });
});

describe("Work > Organization", () => {
  function setup(role: "owner" | "admin" | "member", start: OmniRushWorkBrowser | Error) {
    const patches: OmniRushWorkOrgBrowserPatch[] = [];
    let current = start instanceof Error ? DEFAULTS : start;
    const client = {
      baseUrl: "http://company-apps.test",
      listWorkMembers: async () => members(role),
      getWorkOrgConnectors: async () => { throw new OmniRushServerError(404, "request_failed", "Not Found"); },
      getWorkOrgBrowser: async (): Promise<OmniRushWorkOrgBrowser> => {
        if (start instanceof Error) throw start;
        return { browser: current, can_manage: role !== "member" };
      },
      setWorkOrgBrowser: async (patch: OmniRushWorkOrgBrowserPatch): Promise<OmniRushWorkOrgBrowser> => {
        patches.push(patch);
        current = { ...current, ...patch };
        return { browser: current, can_manage: true };
      },
    } as never;
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(workMembersKey(client), members(role));
    queries.setQueryData(workStateKey(client), { enabled: true, sources: [], message: null, workspaceId: null });
    return { client, queries, patches };
  }
  const page = (client: never) => <WorkOrganizationPage client={client} openLink={() => undefined} onBack={() => undefined} />;

  test("an admin adds an app: checked address, a known app names itself, the list saves whole and the state reads again", async () => {
    const { client, queries, patches } = setup("admin", { ...DEFAULTS, apps: APPS.slice(0, 2) });
    await render(page(client), queries);
    expect(byTestId("work-org-apps")?.textContent).toContain("Everyone at Acme Freight gets these in the Work browser, one click away.");
    expect(rows()).toEqual(APPS.slice(0, 2).map((app) => app.url));
    // Brand marks for known hosts, the first letter for the company's own app.
    expect(document.querySelector('[data-company-app="https://acmefreight.atlassian.net/jira/software/projects/OPS/boards/1"] [data-brand-tile="jira"]')).not.toBeNull();
    expect(document.querySelector('[data-company-app="https://tms.acmefreight.example/"] [data-brand-tile="custom"]')).not.toBeNull();
    // Long addresses truncate with the full one on hover.
    expect(document.querySelector('[data-company-app="https://acmefreight.atlassian.net/jira/software/projects/OPS/boards/1"] [title]')?.getAttribute("title")).toBe("Ops board");
    expect([...document.querySelectorAll('[data-company-app] .truncate[title^="https://"]')]).toHaveLength(2);

    await click(byTestId("work-org-app-add"));
    expect(byTestId("work-org-app-dialog")).not.toBeNull();
    expect(byTestId("work-org-app-remove")).toBeNull();
    await type(byTestId("work-org-app-url"), "http://figma.com/files");
    await act(async () => { byTestId("work-org-app-url")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await settle();
    await click(byTestId("work-org-app-save"));
    expect(patches).toEqual([]);
    expect(byTestId("work-org-app-url-error")?.textContent).toBe("Use an https:// address.");
    await type(byTestId("work-org-app-url"), "https://acmefreight.atlassian.net/wiki/spaces/OPS/");
    await type(byTestId("work-org-app-name"), "Wiki");
    await click(byTestId("work-org-app-save"));
    expect(patches).toEqual([{ apps: [...APPS.slice(0, 2), { name: "Wiki", url: "https://acmefreight.atlassian.net/wiki/spaces/OPS/" }] }]);
    expect(toasts).toContain("success:Added Wiki");
    expect(queries.getQueryState(workStateKey(client))?.isInvalidated).toBe(true);
    expect(rows()).toHaveLength(3);
    expect(byTestId("work-org-app-dialog")).toBeNull();

    // The same address twice is refused in the dialog.
    await click(byTestId("work-org-app-add"));
    await type(byTestId("work-org-app-url"), "tms.acmefreight.example");
    await type(byTestId("work-org-app-name"), "TMS again");
    await click(byTestId("work-org-app-save"));
    expect(byTestId("work-org-app-url-error")?.textContent).toBe("Acme TMS already uses this address.");
    expect(patches).toHaveLength(1);
    // A well-known app fills its name when the address is left; a name already typed stays.
    await type(byTestId("work-org-app-name"), "");
    await type(byTestId("work-org-app-url"), "https://www.figma.com/files");
    await act(async () => { byTestId("work-org-app-url")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await settle();
    expect((byTestId("work-org-app-name") as HTMLInputElement).value).toBe("Figma");
    expect(byTestId("work-org-app-url-error")).toBeNull();
  });

  test("edit, and remove from the app's dialog after a confirm; the list caps at 5 with Show all, a search box from 9, Add stops at 24", async () => {
    const many = Array.from({ length: 24 }, (_, index) => ({ name: `App ${index + 1}`, url: `https://app${index + 1}.acmefreight.example/` }));
    const { client, queries, patches } = setup("owner", { ...DEFAULTS, apps: APPS });
    await render(page(client), queries);
    expect(rows()).toHaveLength(APPS_SHOWN);
    expect(byTestId("work-org-apps-search")).toBeNull();
    await click(byTestId("work-org-apps-more"));
    expect(rows()).toHaveLength(APPS.length);
    expect(byTestId("work-org-apps-more")?.textContent).toBe("Show fewer");

    await click(byLabel("Edit Wiki"));
    expect((byTestId("work-org-app-url") as HTMLInputElement).value).toBe(APPS[2]!.url);
    await type(byTestId("work-org-app-name"), "Team wiki");
    await click(byTestId("work-org-app-save"));
    expect(patches.at(-1)?.apps?.[2]).toEqual({ name: "Team wiki", url: APPS[2]!.url });

    // Remove sits in the app's dialog (one quiet action per row), and asks first.
    expect(button("Remove", byTestId("work-org-apps-list")!)).toBeUndefined();
    await click(byLabel("Edit Support"));
    await click(byTestId("work-org-app-remove"));
    expect(byTestId("work-org-app-dialog")).toBeNull();
    const confirm = document.querySelector("[role=alertdialog]");
    expect(confirm?.textContent).toContain("Remove Support for everyone?");
    await click(button("Cancel", confirm!));
    expect(patches).toHaveLength(1);
    await click(byLabel("Edit Support"));
    await click(byTestId("work-org-app-remove"));
    await click(button("Remove", document.querySelector("[role=alertdialog]")!));
    expect(patches.at(-1)?.apps?.map((app) => app.name)).toEqual(["Acme TMS", "Ops board", "Team wiki", "Design", "HR portal", "Payroll"]);
    expect(toasts).toContain("success:Removed Support");

    await unmount?.();
    const full = setup("owner", { ...DEFAULTS, apps: many });
    await render(page(full.client), full.queries);
    expect(byTestId("work-org-app-add")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId("work-org-apps-full")?.textContent).toBe("That is the limit of 24 apps. Remove one to add another.");
    expect(byTestId("work-org-apps-more")?.textContent).toBe("Show all (24)");
    // Search results are capped the same way.
    await type(byTestId("work-org-apps-search"), "app 2");
    expect(rows()).toEqual(["https://app2.acmefreight.example/", ...Array.from({ length: 4 }, (_, index) => `https://app${20 + index}.acmefreight.example/`)]);
    expect(byTestId("work-org-apps-more")?.textContent).toBe("Show all (6)");
    await type(byTestId("work-org-apps-search"), "app 24");
    expect(rows()).toEqual(["https://app24.acmefreight.example/"]);
    await type(byTestId("work-org-apps-search"), "nothing like it");
    expect(byTestId("work-org-apps")?.textContent).toContain("No app matches that search.");
  });

  test("Browser for your team: each switch saves at once; Let people change this is the lock turned around", async () => {
    const { client, queries, patches } = setup("owner", DEFAULTS);
    await render(page(client), queries);
    expect(byTestId("work-org-apps-empty")?.textContent).toContain("No apps yet.");
    expect(byTestId("work-org-browser")?.textContent).toContain("What people at Acme Freight can do in the Work browser.");
    await click(byLabel("Import sign-ins"));
    await click(byLabel("Let people change this"));
    expect(patches).toEqual([{ import_signins: false }, { links_locked: true }]);
    expect(document.querySelector('[data-browser-rule="import_signins"]')?.getAttribute("data-on")).toBe("false");
    expect(document.querySelector('[data-browser-rule="links_locked"]')?.getAttribute("data-on")).toBe("false");
    expect(toasts.filter((item) => item === "success:Saved")).toHaveLength(2);
  });

  test("a member reads the apps only; no apps, an older server or a refusal: no section at all", async () => {
    const member = setup("member", { ...DEFAULTS, apps: APPS.slice(0, 3), import_signins: false });
    await render(page(member.client), member.queries);
    expect(byTestId("work-org-apps")?.textContent).toContain("Acme Freight added these for everyone. They open in the Work browser.");
    expect(rows()).toHaveLength(3);
    expect(byTestId("work-org-app-add")).toBeNull();
    expect(byLabel("Edit Acme TMS")).toBeNull();
    expect(byTestId("work-org-browser")).toBeNull();
    for (const start of [DEFAULTS, new OmniRushServerError(404, "request_failed", "Not Found"), new OmniRushServerError(409, "no_org", "no_org")]) {
      await unmount?.();
      const other = setup("member", start);
      await render(page(other.client), other.queries);
      expect(byTestId("work-org-members")).not.toBeNull();
      expect(byTestId("work-org-apps")).toBeNull();
      expect(byTestId("work-org-browser")).toBeNull();
    }
    // The owner on an older server sees the page as before too.
    await unmount?.();
    const old = setup("owner", new OmniRushServerError(404, "request_failed", "Not Found"));
    await render(page(old.client), old.queries);
    expect(byTestId("work-org-apps")).toBeNull();
    expect(byTestId("work-org-browser")).toBeNull();
    expect(old.queries.getQueryState(workOrgBrowserKey(old.client))?.status).toBe("error");
  });
});

describe("the import screens honour the company", () => {
  const SOURCES: BrowserImportSources = {
    platform: "darwin",
    historyDays: 90,
    browsers: [{
      browser: "chrome", label: "Google Chrome", short: "Chrome", signIns: { importable: true, reason: null }, access: "ok",
      profiles: [{ id: "chrome:Default", name: "Work", profile: "Default", has: { bookmarks: true, history: true, signIns: true } }],
    }],
  };
  const INSPECTION: BrowserImportInspection = {
    source: { id: "chrome:Default", browser: "chrome", label: "Google Chrome", name: "Work" },
    bookmarks: { state: "ready", count: 312 },
    history: { state: "ready", count: 4210, days: 90 },
    signIns: { state: "ready", previewId: "preview-1", cookieCount: 9, sites: [{ site: "linear.app", hosts: ["linear.app"], cookieCount: 2, sessionCookieCount: 1, lastUsedAt: null, category: "ordinary", preselected: true, reason: null }] },
    keepInStep: true,
  };
  function library() {
    const imports: BrowserImportRequest[] = [];
    const bridge = {
      sources: async () => SOURCES,
      inspect: async () => INSPECTION,
      import: async (request: BrowserImportRequest) => {
        imports.push(request);
        return { source: INSPECTION.source, bookmarks: request.bookmarks ? { state: "done", count: 312 } : null, history: request.history ? { state: "done", count: 4210 } : null, signIns: null };
      },
      onProgress: () => () => undefined,
      summary: async () => ({ imports: [], bookmarks: 0, history: 0 }),
      clear: async () => ({ imports: [], bookmarks: 0, history: 0 }),
      openFullDiskAccess: async () => true,
    } as unknown as BrowserLibraryBridge;
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, writable: true, value: { browserLibrary: bridge } });
    return imports;
  }
  const workState = (block: Partial<OmniRushWorkBrowser> | null) => {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queries.setQueryData(["omnirush-work-state", "http://work.test"], { enabled: true, sources: [], message: null, workspaceId: null, ...(block ? { browser: { ...DEFAULTS, org_name: "Acme Freight", ...block } } : {}) });
    return queries;
  };

  test("a part the company turned off reads as blocked and is never sent", () => {
    expect(withCompanyPolicy(INSPECTION, { importBookmarks: true, importSignIns: true })).toBe(INSPECTION);
    const noSignIns = withCompanyPolicy(INSPECTION, { importBookmarks: true, importSignIns: false });
    expect(noSignIns.signIns).toEqual({ state: "blocked", reason: "company_off" });
    expect(noSignIns.keepInStep).toBe(false);
    expect(noSignIns.bookmarks).toBe(INSPECTION.bookmarks);
    const noBookmarks = withCompanyPolicy(INSPECTION, { importBookmarks: false, importSignIns: true });
    expect([noBookmarks.bookmarks, noBookmarks.history]).toEqual([{ state: "blocked", reason: "company_off" }, { state: "blocked", reason: "company_off" }]);
    expect(noBookmarks.signIns).toBe(INSPECTION.signIns);
  });

  test("sign-ins off: the dialog names the company, imports bookmarks and history only", async () => {
    const imports = library();
    await render(<BrowserImportDialog open onOpenChange={() => undefined} />, workState({ import_signins: false }));
    await settle();
    expect(byTestId("browser-import-row-signIns")?.textContent).toContain("Turned off by Acme Freight.");
    expect(byTestId("browser-import-signins")).toBeNull();
    expect(byTestId("browser-import-keep")).toBeNull();
    await click(byTestId("browser-import-submit"));
    expect(imports).toEqual([{ sourceId: "chrome:Default", bookmarks: true, history: true, signIns: null }]);
  });

  test("bookmarks off: only sign-ins can come; the panel offer says so", async () => {
    const imports = library();
    const queries = workState({ import_bookmarks: false });
    await render(<BrowserImportDialog open onOpenChange={() => undefined} />, queries);
    await settle();
    expect(byTestId("browser-import-row-bookmarks")?.textContent).toContain("Turned off by Acme Freight.");
    expect(byTestId("browser-import-row-history")?.textContent).toContain("Turned off by Acme Freight.");
    await click(byTestId("browser-import-submit"));
    expect(imports[0]).toMatchObject({ bookmarks: false, history: false, signIns: { previewId: "preview-1", sites: ["linear.app"] } });
    await unmount?.();
    usePersistedBrowserLoginsStore.setState({ importOffer: null });
    await render(<LoginSyncCard />, workState({ import_bookmarks: false }));
    await settle();
    expect(byTestId("browser-import-offer")?.textContent).toContain("Bring your sign-ins from Chrome.");
  });

  test("both off: Settings says who turned it off and lists no browsers; the panel offers nothing", async () => {
    library();
    await render(<BrowserImportSection />, workState({ import_bookmarks: false, import_signins: false }));
    await settle();
    expect(byTestId("browser-import-company-off")?.textContent).toBe("Acme Freight turned off importing from other browsers.");
    expect(byTestId("browser-import-found")).toBeNull();
    await unmount?.();
    usePersistedBrowserLoginsStore.setState({ importOffer: null });
    await render(<LoginSyncCard />, workState({ import_bookmarks: false, import_signins: false }));
    await settle();
    expect(byTestId("browser-import-offer")).toBeNull();
    // No company block: the offer as before.
    await unmount?.();
    await render(<LoginSyncCard />, workState(null));
    await settle();
    expect(byTestId("browser-import-offer")?.textContent).toContain("Bring your bookmarks and sign-ins from Chrome.");
  });
});

test("every new string has a Chinese copy and no dashes", () => {
  const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
  const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
  const pattern = /"((?:work\.org\.(?:apps?|browser)_|browser_import\.(?:company_off|offer_signins_only))[a-z_]*)":\s*"([^"]*)"/g;
  const keys = (source: string) => new Map([...source.matchAll(pattern)].map((match) => [match[1]!, match[2]!]));
  const english = keys(en);
  expect(english.size).toBeGreaterThan(40);
  expect([...english.keys()].filter((key) => !keys(zh).has(key))).toEqual([]);
  for (const value of english.values()) expect(value).not.toMatch(/[\u2013\u2014!]/);
  expect(t("work.org.apps_show_all", { n: "12", lng: "zh" })).toBe("显示全部（12）");
});
