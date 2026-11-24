/** @jsxImportSource react */
// Cloud tasks in the desktop (design e2e/work-cloud-cu-2026-11-23.md 3, judge M8 and M21): the helpers, the page with
// Needs you first and capped lists, the sheet by keyboard, the run view (result, records, files, notes, blocked sites,
// steps), the code box, approvals, the live frame's ticket page and its take over and hand back, the Organization
// section, the Today strip, the chat card, and nothing new anywhere while the Work state has no `cloud`.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ReactNode } from "react";

import type { OmniRushWorkCloudRun, OmniRushWorkCloudTaskInput } from "../src/app/lib/omnirush-server";

const registered = typeof globalThis.window === "undefined";
// Frames never load in the test DOM (the live page is the server's); happy-dom's note about each one stays quiet.
const realError = console.error;
console.error = (...args: unknown[]) => { if (!String(args[0] ?? "").includes("Iframe page loading is disabled")) realError(...args); };
if (registered) GlobalRegistrator.register({ url: "http://localhost/", settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } as never });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });

const toasts: string[] = [];
mock.module("@/components/ui/sonner", () => ({
  toast: { success: (m: string) => toasts.push(`success:${m}`), warning: (m: string) => toasts.push(`warning:${m}`), error: (m: string) => toasts.push(`error:${m}`) },
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { OmniRushServerError } = await import("../src/app/lib/omnirush-server");
const model = await import("../src/react-app/domains/work/cloud/cloud-model");
const { WorkCloudPage } = await import("../src/react-app/domains/work/cloud/cloud-tasks");
const { TaskSheet, draftOf, taskInput, startProblem, looksLikePassword } = await import("../src/react-app/domains/work/cloud/task-sheet");
const { RunView } = await import("../src/react-app/domains/work/cloud/run-view");
const { CodeEntry, codeValue } = await import("../src/react-app/domains/work/cloud/code-entry");
const { Approval, shotStep } = await import("../src/react-app/domains/work/cloud/approval");
const { LiveFrame } = await import("../src/react-app/domains/work/cloud/live-frame");
const { OrgCloudSection } = await import("../src/react-app/domains/work/cloud/org-cloud");
const { CloudToolCard, CloudTodayStrip, useCloudHomeItems } = await import("../src/react-app/domains/work/cloud/cloud-card");
const { RecordView } = await import("../src/react-app/domains/work/viewer/record-view");
const records = await import("../src/react-app/domains/work/viewer/records");
const { WorkSidebarNav } = await import("../src/react-app/domains/session/sidebar/work-sidebar-nav");
const { workToolPermission } = await import("../src/react-app/domains/work/work-mode");
const en = (await import("../src/i18n/locales/en")).default;
const zh = (await import("../src/i18n/locales/zh")).default;
const F = await import("./fixtures/work-cloud");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; toasts.length = 0; model.useCloudClientStore.getState().setClient(null, false); });

async function render(node: ReactNode, queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }), path = "/work/cloud") {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<QueryClientProvider client={queries}><MemoryRouter initialEntries={[path]}>{node}</MemoryRouter></QueryClientProvider>));
  await act(async () => { await sleep(20); });
  unmount = () => act(async () => root.unmount());
  return queries;
}
const settle = () => act(async () => { await sleep(30); });
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error("nothing to click");
  await act(async () => { (element as HTMLElement).click(); await sleep(30); });
};
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(element: Element, name: string, extra: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...extra })); await sleep(20); });
}

/** A client that answers from the fixtures and records every call. */
function fakeClient(over: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const log = (name: string, ...args: unknown[]) => calls.push([name, ...args]);
  const client = {
    baseUrl: "http://cloud.test",
    listWorkCloudTasks: async (query: unknown) => { log("tasks", query); return { items: F.TASKS, next: null }; },
    getWorkCloudTask: async (id: string) => F.TASKS.find((task) => task.id === id)!,
    createWorkCloudTask: async (input: OmniRushWorkCloudTaskInput) => { log("create", input); return { ...F.TASKS[11]!, ...input, id: "t_created" }; },
    updateWorkCloudTask: async (id: string, patch: unknown) => { log("update", id, patch); return F.TASKS.find((task) => task.id === id)!; },
    deleteWorkCloudTask: async (id: string) => { log("delete", id); return { ok: true }; },
    runWorkCloudTask: async (id: string) => { log("run", id); return { run_id: "r_new", status: "queued" }; },
    listWorkCloudRuns: async (query: { task_id?: string; status?: string }) => { log("runs", query); return { items: query.status === "waiting" ? [F.RUNS.r_code!, F.RUNS.r_approval!] : F.BILLDESK_RUNS, next: null }; },
    getWorkCloudRun: async (id: string) => F.RUNS[id]!,
    listWorkCloudSteps: async (id: string) => { log("steps", id); return F.STEPS; },
    getWorkCloudStepShot: async () => ({ data: new ArrayBuffer(8), contentType: "image/webp", filename: null }),
    getWorkCloudFile: async (id: string, name: string) => { log("file", id, name); return { data: new ArrayBuffer(8), contentType: "application/pdf", filename: name }; },
    workCloudRunAction: async (id: string, action: string) => { log("action", id, action); return { ...F.RUNS[id]!, ...(action === "takeover" ? { waiting_for: "takeover" } : {}) }; },
    handBackWorkCloudRun: async (id: string, note?: string) => { log("handback", id, note); return { ...F.RUNS[id]!, status: "running", waiting_for: null }; },
    sendWorkCloudCode: async (id: string, code: string) => { log("code", id, code); return { ...F.RUNS[id]!, status: "running", waiting_for: null }; },
    openWorkCloudLive: async (id: string, mode: string) => { log("live", id, mode); return { url: `https://omnirush.ai/omnirush/work/live/v/#t=${F.LIVE_TICKET}`, expires_at: "2026-11-24T09:31:00Z" }; },
    getWorkOrgCloud: async () => F.ORG_CLOUD,
    setWorkOrgCloud: async (patch: unknown) => { log("org", patch); return { ...F.ORG_CLOUD, ...(patch as object) }; },
    listWorkCloudSignins: async () => ({ items: F.SIGNINS }),
    addWorkCloudSignin: async (input: unknown) => { log("addSignin", input); return F.SIGNINS[0]!; },
    replaceWorkCloudSignin: async (id: string, input: unknown) => { log("replaceSignin", id, input); return F.SIGNINS[0]!; },
    removeWorkCloudSignin: async (id: string) => { log("removeSignin", id); return { ok: true }; },
    ...over,
  };
  return { client: client as never, calls };
}

describe("helpers", () => {
  test("the block: only an `on` block while Work is on; every field checked", () => {
    expect(model.workCloud(undefined)).toBeNull();
    expect(model.workCloud({ enabled: true, sources: [] })).toBeNull();
    expect(model.workCloud({ enabled: false, cloud: F.CLOUD_ADMIN })).toBeNull();
    expect(model.workCloud({ enabled: true, cloud: { on: "true" } })).toBeNull();
    expect(model.workCloud({ enabled: true, cloud: { on: true, admin: 1, limits: { desktops: "2" } } })).toEqual({ on: true, create: false, admin: false, live: false, vault: false, limits: { desktops: 0, minutes_left: 0 } });
    expect(model.workCloud({ enabled: true, cloud: F.CLOUD_ADMIN })).toEqual(F.CLOUD_ADMIN);
  });

  test("words: schedules, statuses, durations, errors, sizes", () => {
    expect(model.scheduleText(null)).toBe("Runs when asked");
    expect(model.scheduleText({ every: "week", at: "08:00", weekday: 0, tz: "Europe/Berlin" }, "Europe/Berlin")).toBe("Every Monday at 08:00");
    expect(model.scheduleText({ every: "day", at: "07:30", tz: "America/New_York" }, "Europe/Berlin")).toBe("Every day at 07:30 (America/New York)");
    expect(model.scheduleText({ every: "month", at: "09:00", day: 1, tz: "UTC" }, "UTC")).toBe("Every month on day 1 at 09:00");
    expect(model.statusText({ status: "running", steps: 6 })).toBe("Running, step 6");
    expect(model.statusText({ status: "waiting", waiting_for: "code" })).toBe("Waiting for a sign-in code");
    expect(model.statusText({ status: "limit" })).toBe("Stopped at a limit");
    expect(model.durationText(1.2)).toBe("1 min 12 s");
    expect(model.durationText(0.4)).toBe("24 s");
    expect(model.durationText(65)).toBe("1 h 5 min");
    expect(model.runErrorText({ code: "site_unreachable", message: "site_unreachable" })).toBe("The site did not load.");
    expect(model.runErrorText({ code: "brand_new", message: "brand_new_code" })).toBe("The run did not finish.");
    expect(model.runErrorText({ code: "brand_new", message: "The portal is down for maintenance." })).toBe("The portal is down for maintenance.");
    expect(model.savedText("invoice", 20)).toBe("20 invoices saved to Work");
    expect(model.savedText("ticket", 1)).toBe("1 ticket saved to Work");
    expect(model.fileSize(48_000)).toBe("47 KB");
    expect(model.cloudFailure(new OmniRushServerError(403, "not_allowed", "That connector is not available for your company.")).text).toBe("Only the task's owner or a company admin can do that.");
    expect(model.cloudFailure(new OmniRushServerError(409, "run_open", "x")).text).toBe("This task is already running.");
    expect(model.waitingAction("code", true)).toBe("Enter code");
    expect(model.waitingAction("approval", true)).toBe("Review");
    expect(model.waitingAction("signin", true)).toBe("Open live view");
    expect(model.waitingAction("signin", false)).toBe("Open");
  });

  test("sites: the company's list with *.domain, what an admin types, start pages", () => {
    expect(model.siteAllowed("portal.northbeam.example", F.ORG_CLOUD.hosts)).toBe(true);
    expect(model.siteAllowed("daily.carrier-reports.example", F.ORG_CLOUD.hosts)).toBe(true);
    expect(model.siteAllowed("carrier-reports.example", F.ORG_CLOUD.hosts)).toBe(true);
    expect(model.siteAllowed("evilcarrier-reports.example", F.ORG_CLOUD.hosts)).toBe(false);
    expect(model.siteAllowed("northbeam.example", F.ORG_CLOUD.hosts)).toBe(false);
    expect(model.siteEntry(" HTTPS://Portal.Example.com/login?x=1 ")).toBe("portal.example.com");
    expect(model.siteEntry("*.acme.example")).toBe("*.acme.example");
    expect(model.siteEntry("10.0.0.1")).toBeNull();
    expect(model.siteEntry("localhost")).toBeNull();
    expect(model.startUrl("portal.example.com/login")).toBe("https://portal.example.com/login");
    expect(model.startUrl("http://portal.example.com")).toBeNull();
    expect(model.startUrl("javascript:alert(1)")).toBeNull();
    expect(startProblem("https://portal.northbeam.example/x", F.ORG_CLOUD.hosts, true)).toBeNull();
    expect(startProblem("https://other.example/x", F.ORG_CLOUD.hosts, true)).toBe("other.example is not on your company's sites. Add it in Organization first.");
    expect(startProblem("https://other.example/x", F.ORG_CLOUD.hosts, false)).toBe("other.example is not on your company's sites. Ask an admin to add it.");
    expect(startProblem("https://other.example/x", [], false)).toContain("no sites");
    expect(looksLikePassword("Sign in with password: hunter2")).toBe(true);
    expect(looksLikePassword("Reset the password field if it is empty")).toBe(false);
  });

  test("lists: search on titles and sites, Needs you, blocked sites once, record keys, files", () => {
    expect(model.filterTasks(F.TASKS, "billdesk").map((task) => task.id)).toEqual(["t_billdesk", "t_new"]);
    expect(model.filterTasks(F.TASKS, "northbeam invoices").map((task) => task.id)).toEqual(["t_invoices"]);
    expect(F.TASKS.filter(model.needsYou).map((task) => task.id)).toEqual(["t_invoices", "t_vat"]);
    expect(model.blockedHosts(F.RUNS.r_done)).toEqual(["cdn.billdesk-assets.example"]);
    expect(model.runNotes(F.RUNS.r_done).map((flag) => flag.kind)).toEqual(["ignored_instruction", "note"]);
    expect(model.recordKey("webtask:t_billd:INV-4471")).toBe("INV-4471");
    expect(model.recordKey("gmail:123")).toBe("gmail:123");
    expect(shotStep("/omnirush/work/cloud/runs/r_approval/steps/11/shot")).toBe(11);
    expect(shotStep("https://evil.example/x.png")).toBeNull();
    expect(codeValue(" 482 913 ")).toBe("482913");
    expect(codeValue("12")).toBeNull();
  });

  test("the live page: https, the live path, a ticket in the fragment, never a query", () => {
    expect(model.liveUrlOk(`https://omnirush.ai/omnirush/work/live/v/#t=${F.LIVE_TICKET}`)).toBe(true);
    expect(model.liveUrlOk(`http://127.0.0.1:18990/omnirush/work/live/v/#t=${F.LIVE_TICKET}`)).toBe(true);
    expect(model.liveUrlOk(`http://omnirush.ai/omnirush/work/live/v/#t=${F.LIVE_TICKET}`)).toBe(false);
    expect(model.liveUrlOk(`https://omnirush.ai/omnirush/work/live/v/?t=${F.LIVE_TICKET}`)).toBe(false);
    expect(model.liveUrlOk(`https://omnirush.ai/other/#t=${F.LIVE_TICKET}`)).toBe(false);
    expect(model.liveUrlOk("javascript:alert(1)")).toBe(false);
  });

  test("the chat card reads a task or a run; lists and sign-ins get none", () => {
    const task = { task: { ...F.TASKS[0], schedule: F.TASKS[0]!.schedule }, next_run_at: "x", run_id: null };
    expect(model.cloudCard("omnirush-work_work_cloud_task", { content: [{ type: "text", text: JSON.stringify(task) }] })).toEqual({ kind: "task", taskId: "t_invoices", title: "Pull supplier invoices", schedule: F.TASKS[0]!.schedule, runId: null });
    expect(model.cloudCard("omnirush-work_work_cloud_run", JSON.stringify({ run_id: "r_1", status: "queued" }))).toMatchObject({ kind: "run", runId: "r_1", status: "queued" });
    expect(model.cloudCard("omnirush-work_work_cloud_result", { structuredContent: { run_id: "r_done", status: "done", source_ids: ["a", "b"] } })).toMatchObject({ kind: "run", saved: 2 });
    expect(model.cloudCard("omnirush-work_work_cloud_result", { structuredContent: { run_id: "r_1", status: "exploded" } })).toBeNull();
    expect(model.cloudCard("omnirush-work_work_cloud_runs", { runs: [] })).toBeNull();
    expect(model.cloudCard("omnirush-work_work_cloud_signins", { signins: [] })).toBeNull();
    expect(model.isCloudTool("omnirush-work_work_cloud_task")).toBe(true);
    expect(model.isCloudTool("omnirush-work_gmail_send")).toBe(false);
    expect(workToolPermission("omnirush-work_work_cloud_task")).toEqual({ label: "Create a cloud task", scope: "Your company's cloud tasks" });
    expect(workToolPermission("omnirush-work_work_cloud_run")).toEqual({ label: "Run a cloud task", scope: "Your company's cloud tasks" });
  });

  test("copy: every key in en and zh, no dashes, no emoji, sentence case, placeholders kept", () => {
    const keys = (locale: Record<string, string>) => Object.keys(locale).filter((name) => name.startsWith("work.cloud.") || name === "work.nav.cloud" || name.startsWith("work.tool.cloud_"));
    const enKeys = keys(en);
    expect(enKeys.length).toBeGreaterThan(200);
    expect(keys(zh).sort()).toEqual([...enKeys].sort());
    for (const name of enKeys) {
      const text = en[name as keyof typeof en];
      expect(/[\u2013\u2014]/.test(text)).toBe(false);
      expect(/[\u2013\u2014]/.test(zh[name as keyof typeof zh])).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text + zh[name as keyof typeof zh])).toBe(false);
      // Sentence case: no Capitalised Word after the first word, unless it is a name or a known product.
      const caps = text.replace(/\{[a-z_]+\}/g, "").split(/(?<=[.?!:])\s+/).flatMap((sentence) => sentence.split(/\s+/).slice(1)).filter((word) => /^[A-Z][a-z]/.test(word) && !/^(Work|Organization|Settings|Monday|Invoices)\b/.test(word));
      expect(caps).toEqual([]);
      const holes = (value: string) => (value.match(/\{[a-z_]+\}/g) ?? []).sort().join(",");
      expect(holes(zh[name as keyof typeof zh])).toBe(holes(text));
    }
  });
});

describe("nothing new while the Work state has no cloud", () => {
  test("the sidebar has no Cloud tasks row; with it, a row and a count only when runs wait", async () => {
    const nav = { onOpenHome: () => undefined, onOpenOrganization: () => undefined, organizationActive: false, onOpenConnectors: () => undefined, connectorsActive: false, onOpenKnowledge: () => undefined, knowledgeActive: false, onOpenActivity: () => undefined, activityActive: false, connectors: [] };
    await render(<WorkSidebarNav nav={nav} />);
    expect($('[data-testid="sidebar-work-cloud"]')).toBeNull();
    const before = $('[data-testid="sidebar-work-tools"]')!.outerHTML;
    await unmount?.();
    await render(<WorkSidebarNav nav={{ ...nav, onOpenCloud: () => undefined, cloudWaiting: 0 }} />);
    expect($('[data-testid="sidebar-work-cloud"]')?.textContent).toBe("Cloud tasks");
    await unmount?.();
    await render(<WorkSidebarNav nav={{ ...nav, onOpenCloud: () => undefined, cloudWaiting: 2 }} />);
    expect($('[data-testid="sidebar-work-cloud"] [aria-label]')?.getAttribute("aria-label")).toBe("2 runs wait for someone");
    await unmount?.();
    // Without the row the markup is what it was.
    await render(<WorkSidebarNav nav={nav} />);
    expect($('[data-testid="sidebar-work-tools"]')!.outerHTML).toBe(before);
  });

  test("Today has no strip without the feed's cloud list; the Organization section asks nothing for a consumer account", async () => {
    await render(<CloudTodayStrip items={undefined} />);
    expect($('[data-testid="work-today-cloud"]')).toBeNull();
    await unmount?.();
    const { client, calls } = fakeClient({ getWorkOrgCloud: async () => { calls.push(["org-get"]); return F.ORG_CLOUD; } });
    await render(<OrgCloudSection client={client} cloud={null} manager enterprise={false} />);
    expect($('[data-testid="work-org-cloud"]')).toBeNull();
    expect(calls).toEqual([]);
  });

  test("an enterprise owner or admin whose company switched it off still reads the settings to turn it back on; a 403 shows nothing", async () => {
    const off = { ...F.ORG_CLOUD, enabled: false };
    const { client, calls } = fakeClient({ getWorkOrgCloud: async () => off });
    await render(<OrgCloudSection client={client} cloud={null} manager enterprise />);
    expect($('[data-testid="work-org-cloud"]')).not.toBeNull();
    expect($('[data-testid="work-org-cloud-hosts"]')).toBeNull();
    await click($('[data-testid="work-org-cloud-enabled"] [role="switch"]'));
    expect(calls).toContainEqual(["org", { enabled: true }]);
    await unmount?.();
    const refused = fakeClient({ getWorkOrgCloud: async () => { throw new OmniRushServerError(403, "cloud_off", "x"); } });
    await render(<OrgCloudSection client={refused.client} cloud={null} manager enterprise />);
    expect($('[data-testid="work-org-cloud"]')).toBeNull();
  });
});

describe("the Cloud tasks page", () => {
  test("Needs you first with what each run asks for, then 8 tasks and Show more; search; filters; New task only for creators", async () => {
    const { client, calls } = fakeClient();
    await render(<WorkCloudPage client={client} caps={F.CLOUD_ADMIN} orgName="Acme Freight" writesPaused={false} openLink={() => undefined} />);
    expect($('[data-testid="work-cloud-subtitle"]')?.textContent).toBe("Jobs that run on a cloud computer for Acme Freight. 188 of 600 minutes used this month.");
    expect($$("[data-cloud-needs]").map((row) => row.dataset.cloudNeeds)).toEqual(["t_invoices", "t_vat"]);
    expect($$('[data-testid="work-cloud-needs-open"]').map((b) => b.textContent)).toEqual(["Enter code", "Review"]);
    expect($$("[data-cloud-task]").length).toBe(8);
    expect($('[data-testid="work-cloud-more"]')?.textContent).toBe("Show 2 more");
    await click($('[data-testid="work-cloud-more"]'));
    expect($$("[data-cloud-task]").length).toBe(10);
    expect($('[data-cloud-task="t_old"]')?.textContent).toContain("Owner left the company");
    expect($('[data-cloud-task="t_new"]')?.textContent).toContain("Never run");
    // Search filters titles and sites at once, and asks the server too.
    await type($('[data-testid="work-cloud-search"]') as HTMLInputElement, "carrier");
    expect($$("[data-cloud-task]").map((row) => row.dataset.cloudTask)).toEqual(["t_carrier"]);
    expect($('[data-testid="work-cloud-needs"]')).toBeNull();
    await act(async () => { await sleep(300); });
    expect(calls).toContainEqual(["tasks", { filter: "all", q: "carrier", limit: 50 }]);
    await key($('[data-testid="work-cloud-search"]')!, "Escape");
    expect($$("[data-cloud-task]").length).toBe(8);
    // The filter is one radio group; arrows move it.
    expect($('[data-option="needs_you"]')?.textContent).toBe("Needs you (2)");
    await key($('[data-option="all"]')!, "ArrowRight");
    expect($('[data-option="scheduled"]')?.getAttribute("aria-checked")).toBe("true");
    await settle();
    expect(calls.some((call) => call[0] === "tasks" && (call[1] as { filter: string }).filter === "scheduled")).toBe(true);
    expect($('[data-testid="work-cloud-new"]')?.textContent).toBe("New task");
    await unmount?.();
    await render(<WorkCloudPage client={client} caps={F.CLOUD_MEMBER} writesPaused={false} openLink={() => undefined} />);
    expect($('[data-testid="work-cloud-new"]')).toBeNull();
    expect($('[data-testid="work-cloud-subtitle"]')?.textContent).toContain("for your company");
  });

  test("an empty company says what Cloud tasks are for; an error says it in words", async () => {
    const empty = fakeClient({ listWorkCloudTasks: async () => ({ items: [], next: null }) });
    await render(<WorkCloudPage client={empty.client} caps={F.CLOUD_ADMIN} writesPaused={false} openLink={() => undefined} />);
    expect($('[data-testid="work-cloud-empty"]')?.textContent).toContain("No cloud tasks yet");
    expect($('[data-testid="work-cloud-empty"]')?.textContent).toContain("supplier portal every Monday");
    await unmount?.();
    const off = fakeClient({ listWorkCloudTasks: async () => { throw new OmniRushServerError(403, "cloud_off", "x"); } });
    await render(<WorkCloudPage client={off.client} caps={F.CLOUD_ADMIN} writesPaused={false} openLink={() => undefined} />);
    expect($('[data-testid="work-cloud-error"]')?.textContent).toBe("Cloud tasks are turned off for your company.");
  });

  test("a row opens the task and its latest run beside the list", async () => {
    const { client } = fakeClient();
    await render(<WorkCloudPage client={client} caps={F.CLOUD_ADMIN} writesPaused={false} openLink={() => undefined} />);
    await click($('[data-cloud-task="t_billdesk"]'));
    await settle();
    expect($('[data-testid="work-cloud-run-view"]')?.dataset.run).toBe("r_done");
    expect($('[data-testid="work-cloud-run-status"]')?.textContent).toContain("Done");
  });
});

describe("the sheet", () => {
  test("keyboard only: type, Tab through, Enter saves and starts a test run; the start page is checked as typed", async () => {
    const { client, calls } = fakeClient();
    const saved: unknown[] = [];
    await render(<TaskSheet open onOpenChange={() => undefined} client={client} caps={F.CLOUD_ADMIN} task={null} sites={F.ORG_CLOUD.hosts} signins={F.SIGNINS} onSaved={(task, run) => saved.push([task.id, run])} />);
    const sheet = $('[data-testid="work-cloud-sheet"]')!;
    expect(sheet.textContent).toContain("Do not put passwords here. Use a saved sign-in.");
    expect(sheet.textContent).toContain("Runs on a cloud computer. Sites outside your company's list are blocked.");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("work-cloud-field-title");
    // Nothing is sent until it is complete.
    await key($('[data-testid="work-cloud-field-title"]')!, "Enter");
    await act(async () => { (sheet.querySelector("form") as HTMLFormElement).requestSubmit(); await sleep(20); });
    expect(calls).toEqual([]);
    expect(sheet.textContent).toContain("Give the task a title.");
    await type($('[data-testid="work-cloud-field-title"]') as HTMLInputElement, "Pull supplier invoices");
    await type($('[data-testid="work-cloud-field-what"]') as HTMLTextAreaElement, "Open Invoices and save each one. password: hunter2");
    expect($('[data-testid="work-cloud-password-warning"]')).not.toBeNull();
    await type($('[data-testid="work-cloud-field-what"]') as HTMLTextAreaElement, "Open Invoices and save each one with its PDF.");
    expect($('[data-testid="work-cloud-password-warning"]')).toBeNull();
    await type($('[data-testid="work-cloud-field-start"]') as HTMLInputElement, "unknown.example/login");
    expect(sheet.textContent).toContain("unknown.example is not on your company's sites. Add it in Organization first.");
    await type($('[data-testid="work-cloud-field-start"]') as HTMLInputElement, "portal.northbeam.example/login");
    // When: arrows move the choice; a weekly time appears.
    await key($('[data-testid="work-cloud-field-when"] [data-option="asked"]')!, "ArrowRight");
    await key($('[data-testid="work-cloud-field-when"] [data-option="day"]')!, "ArrowRight");
    expect($('[data-testid="work-cloud-field-when"] [data-option="week"]')?.getAttribute("aria-checked")).toBe("true");
    expect($('[data-testid="work-cloud-when-detail"]')).not.toBeNull();
    // Ctrl+Enter in the instructions submits: Test run now.
    await key($('[data-testid="work-cloud-field-what"]')!, "Enter", { ctrlKey: true });
    await settle();
    const created = calls.find((call) => call[0] === "create")?.[1] as OmniRushWorkCloudTaskInput;
    expect(created).toMatchObject({ title: "Pull supplier invoices", start_url: "https://portal.northbeam.example/login", signin_mode: "none", signin_id: null, output: { kind: "row" }, write_mode: "read" });
    expect(created.schedule).toMatchObject({ every: "week", at: "08:00", weekday: 0 });
    expect(calls.find((call) => call[0] === "run")).toEqual(["run", "t_created"]);
    expect(saved).toEqual([["t_created", "r_new"]]);
    expect(toasts).toContain("success:Task saved. The test run is starting.");
  });

  test("edit: the draft comes from the task; Save sends it with the pause switch; Delete asks first", async () => {
    const task = F.TASKS[0]!;
    expect(draftOf(task)).toMatchObject({ signin: "saved:s_northbeam", every: "week", weekday: 0, output: "invoice" });
    expect(taskInput(draftOf(task), "Europe/Berlin")).toEqual({ title: task.title, instructions: task.instructions, start_url: task.start_url, signin_mode: "saved", signin_id: "s_northbeam", output: { kind: "invoice" }, write_mode: "read", schedule: { every: "week", at: "08:00", tz: "Europe/Berlin", weekday: 0 } });
    const { client, calls } = fakeClient();
    let deleted = false;
    await render(<TaskSheet open onOpenChange={() => undefined} client={client} caps={F.CLOUD_ADMIN} task={task} sites={F.ORG_CLOUD.hosts} signins={F.SIGNINS} onSaved={() => undefined} onDeleted={() => { deleted = true; }} />);
    await click($('[data-testid="work-cloud-field-paused"]'));
    await click($('[data-testid="work-cloud-save"]'));
    await settle();
    expect(calls[0]).toEqual(["update", "t_invoices", expect.objectContaining({ paused: true, signin_mode: "saved", signin_id: "s_northbeam" })]);
    expect(calls.some((call) => call[0] === "run")).toBe(false);
    await click($('[data-testid="work-cloud-delete"]'));
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Delete Pull supplier invoices?");
    expect(calls.some((call) => call[0] === "delete")).toBe(false);
    await click(button("Delete task", document.querySelector("[role=alertdialog]")!));
    await settle();
    expect(calls).toContainEqual(["delete", "t_invoices"]);
    expect(deleted).toBe(true);
  });
});

describe("the run view", () => {
  const view = (client: never, task = F.TASKS[2]!, runId: string | null = null, caps = F.CLOUD_ADMIN, extra: Partial<{ onOpenRecord: (id: string, list: string[]) => void }> = {}) => (
    <RunView client={client} caps={caps} task={task} runId={runId} writesPaused={false} onPickRun={() => undefined} onEdit={() => undefined} onRan={() => undefined} onOpenRecord={extra.onOpenRecord ?? (() => undefined)} />
  );

  test("a done run: result, records 5 then Show all, files, notes, a blocked site once with Allow site, steps folded", async () => {
    const { client, calls } = fakeClient();
    const opened: unknown[] = [];
    await render(view(client, F.TASKS[2]!, null, F.CLOUD_ADMIN, { onOpenRecord: (id, list) => opened.push([id, list.length]) }));
    expect($('[data-testid="work-cloud-run-status"]')?.textContent).toBe("Done· 1 min 12 s· 14 steps");
    expect($('[data-testid="work-cloud-result"]')?.textContent).toContain("20 invoices saved to Work, 2 of them new since last week.");
    expect($('[data-testid="work-cloud-records"]')?.textContent).toContain("20 invoices saved to Work · 1 skipped");
    expect($$("[data-cloud-record]").length).toBe(5);
    expect($('[data-testid="work-cloud-records-more"]')?.textContent).toBe("Show all 20");
    await click($('[data-testid="work-cloud-records-more"]'));
    expect($$("[data-cloud-record]").length).toBe(20);
    await click($('[data-cloud-record="webtask:t_billd:INV-4471"]'));
    expect(opened).toEqual([["webtask:t_billd:INV-4471", 20]]);
    expect($$("[data-cloud-file]").length).toBe(5);
    expect($('[data-testid="work-cloud-files"]')?.textContent).toContain("And 2 more files, attached to their records.");
    await click($('[data-cloud-file="INV-4471.pdf"]'));
    expect(calls).toContainEqual(["file", "r_done", "INV-4471.pdf"]);
    expect($$("[data-cloud-flag]").map((row) => row.dataset.cloudFlag)).toEqual(["ignored_instruction", "note"]);
    expect($$("[data-blocked-host]").map((row) => row.textContent)).toEqual(["Blocked: cdn.billdesk-assets.exampleAllow site"]);
    await click($('[data-testid="work-cloud-allow-site"]'));
    await settle();
    expect(calls).toContainEqual(["org", { hosts: [...F.ORG_CLOUD.hosts, "cdn.billdesk-assets.example"] }]);
    // Steps stay folded (and unread) until asked for; then 8 and Show all, a step opens its screen.
    expect($('[data-testid="work-cloud-step-list"]')).toBeNull();
    expect(calls.some((call) => call[0] === "steps")).toBe(false);
    await click($('[data-testid="work-cloud-steps-toggle"]'));
    await settle();
    expect($$("[data-step]").length).toBe(8);
    await click($('[data-testid="work-cloud-steps-more"]'));
    expect($$("[data-step]").length).toBe(14);
    await click($('[data-step="1"] [data-testid="work-cloud-step-shot"]'));
    await settle();
    expect($('[data-step="1"] [data-testid="work-cloud-shot"]')?.getAttribute("alt")).toBe("The cloud computer's screen at step 1");
    // Earlier runs: 5, then Show more; one primary action (Run again).
    expect($$("[data-cloud-run]").length).toBe(5);
    expect($('[data-testid="work-cloud-run-again"]')?.textContent).toBe("Run again");
    expect($('[data-testid="work-cloud-cancel"]')).toBeNull();
  });

  test("a member sees the blocked site without Allow site; a failed run says why in words", async () => {
    const { client } = fakeClient();
    await render(view(client, F.TASKS[3]!, null, F.CLOUD_MEMBER));
    expect($('[data-testid="work-cloud-run-failed"]')?.textContent).toBe("The site did not load.");
    expect($('[data-testid="work-cloud-allow-site"]')).toBeNull();
    expect($('[data-testid="work-cloud-blocked"]')?.textContent).toContain("A company admin can allow a site in Organization.");
  });

  test("a run waiting for a code: the code box takes the cursor; Send types it once and empties the field", async () => {
    const { client, calls } = fakeClient();
    await render(view(client, F.TASKS[0]!, null));
    const input = $('[data-testid="work-cloud-code-input"]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect($('[data-testid="work-cloud-code"] label')?.textContent).toBe("Code from portal.northbeam.example");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(($('[data-testid="work-cloud-code-send"]') as HTMLButtonElement).disabled).toBe(true);
    await type(input, "482 913");
    await act(async () => { (input.form as HTMLFormElement).requestSubmit(); await sleep(30); });
    expect(calls).toContainEqual(["code", "r_code", "482913"]);
    expect(input.value).toBe("");
    // Cancel replaces Run again while a run is open.
    expect($('[data-testid="work-cloud-cancel"]')).not.toBeNull();
    expect($('[data-testid="work-cloud-run-again"]')).toBeNull();
  });

  test("an approval: the summary and the screen, Approve and Deny; paused actions refuse it", async () => {
    const { client, calls } = fakeClient();
    await render(<Approval client={client} run={F.RUNS.r_approval!} writesPaused={false} />);
    expect($('[data-testid="work-cloud-approval-summary"]')?.textContent).toContain("Submit the Q3 VAT return");
    await settle();
    expect($('[data-testid="work-cloud-shot"]')).not.toBeNull();
    await click($('[data-testid="work-cloud-approve"]'));
    expect(calls).toContainEqual(["action", "r_approval", "approve"]);
    await unmount?.();
    await render(<Approval client={client} run={F.RUNS.r_approval!} writesPaused />);
    expect(($('[data-testid="work-cloud-approve"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-testid="work-cloud-approval-paused"]')).not.toBeNull();
    await click($('[data-testid="work-cloud-deny"]'));
    expect(calls).toContainEqual(["action", "r_approval", "deny"]);
  });

  test("waiting for a code with notes: the frame keeps its bar with Take over, and the agent's own notes give way to the code box", async () => {
    const flags = [
      { kind: "note" as const, text: "Signing in to the portal." },
      { kind: "ignored_instruction" as const, text: "The page asked to open Purchase requests; I did not." },
      { kind: "note" as const, text: "Complete verification in the portal." },
    ];
    const waiting = { ...F.RUNS.r_code!, flags };
    const { client } = fakeClient({ getWorkCloudRun: async () => waiting });
    await render(view(client, F.TASKS[0]!, null));
    await settle();
    expect($('[data-testid="work-cloud-code"]')).not.toBeNull();
    const live = $('[data-testid="work-cloud-live"]')!;
    // The frame never shrinks inside the run view's scrolling column (the bar stayed clipped at 400 px before).
    expect(live.className.split(/\s+/)).toContain("shrink-0");
    expect(live.parentElement?.className).toContain("overflow-y-auto");
    const bar = live.lastElementChild as HTMLElement;
    expect(bar.querySelector('[data-testid="work-cloud-takeover"]')?.textContent).toBe("Take over");
    expect(bar.querySelector('[data-testid="work-cloud-live-line"]')).not.toBeNull();
    expect($$("[data-cloud-flag]").map((row) => row.textContent)).toEqual(["The page asked to open Purchase requests; I did not."]);
    // Once the code went in, only the latest of the agent's notes shows.
    expect(model.runNotes({ ...waiting, status: "running", waiting_for: null }).map((flag) => flag.text)).toEqual([
      "The page asked to open Purchase requests; I did not.",
      "Complete verification in the portal.",
    ]);
  });

  test("live: false hides the frame entirely", async () => {
    const { client, calls } = fakeClient();
    await render(view(client, F.TASKS[4]!, null, { ...F.CLOUD_ADMIN, live: false }));
    expect($('[data-testid="work-cloud-live"]')).toBeNull();
    expect(calls.some((call) => call[0] === "live")).toBe(false);
  });
});

describe("the live frame", () => {
  test("a sandboxed 16:10 frame with no referrer; view takes no input; Take over, a note, Hand back, by keyboard", async () => {
    const { client, calls } = fakeClient();
    let run: OmniRushWorkCloudRun = F.RUNS.r_running!;
    const queries = await render(<LiveFrame client={client} run={run} canControl />);
    const frame = $('[data-testid="work-cloud-live-frame"]') as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("src")).toBe(`https://omnirush.ai/omnirush/work/live/v/#t=${F.LIVE_TICKET}`);
    expect(frame.tabIndex).toBe(-1);
    expect($('[data-testid="work-cloud-live-shield"]')).not.toBeNull();
    expect($('[data-testid="work-cloud-live"]')?.className).toContain("rounded-xl");
    expect(frame.parentElement?.className).toContain("aspect-[16/10]");
    expect($('[data-testid="work-cloud-live-line"]')?.textContent).toBe("The agent is working.");
    expect(calls).toEqual([["live", "r_running", "view"]]);
    await click($('[data-testid="work-cloud-takeover"]'));
    expect(calls).toContainEqual(["action", "r_running", "takeover"]);
    // The server answers with the run under the person's control: a control ticket, the shield gone, Hand back focused.
    run = { ...run, status: "waiting", waiting_for: "takeover" };
    const root = document.getElementById("root")!;
    void root;
    await act(async () => { queries.setQueryData(model.cloudRunKey(client, "r_running"), run); });
    await unmount?.();
    await render(<LiveFrame client={client} run={run} canControl />, queries);
    expect(calls).toContainEqual(["live", "r_running", "control"]);
    expect($('[data-testid="work-cloud-live-shield"]')).toBeNull();
    expect(($('[data-testid="work-cloud-live-frame"]') as HTMLIFrameElement).tabIndex).toBe(0);
    expect($('[data-testid="work-cloud-live-line"]')?.textContent).toBe("You have control. The agent waits.");
    await click($('[data-testid="work-cloud-note-open"]'));
    await type($('[data-testid="work-cloud-note"]') as HTMLInputElement, "Signed in, carry on");
    await click($('[data-testid="work-cloud-handback"]'));
    expect(calls).toContainEqual(["handback", "r_running", "Signed in, carry on"]);
  });

  test("a page that is not a live page never loads; the frame says so and offers Try again", async () => {
    const { client } = fakeClient({ openWorkCloudLive: async () => ({ url: "https://evil.example/omnirush/work/live/v/?t=x", expires_at: null }) });
    await render(<LiveFrame client={client} run={F.RUNS.r_running!} canControl />);
    expect($('[data-testid="work-cloud-live-frame"]')).toBeNull();
    expect($('[data-testid="work-cloud-live-error"]')?.textContent).toContain("The live view is not available right now.");
    expect(($('[data-testid="work-cloud-takeover"]') as HTMLButtonElement).disabled).toBe(true);
  });

  test("keyboard: after Take over the cursor is on Hand back, after Hand back on Take over", async () => {
    const { client } = fakeClient();
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById("root")!);
    const show = (run: OmniRushWorkCloudRun) => act(async () => { root.render(<QueryClientProvider client={queries}><LiveFrame client={client} run={run} canControl /></QueryClientProvider>); await sleep(30); });
    unmount = () => act(async () => root.unmount());
    await show(F.RUNS.r_running!);
    await show({ ...F.RUNS.r_running!, status: "waiting", waiting_for: "takeover" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("work-cloud-handback");
    await show(F.RUNS.r_running!);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("work-cloud-takeover");
  });

  test("only people who may take over see Take over", async () => {
    const { client } = fakeClient();
    await render(<LiveFrame client={client} run={F.RUNS.r_running!} canControl={false} />);
    expect($('[data-testid="work-cloud-takeover"]')).toBeNull();
  });
});

describe("Organization", () => {
  test("admins: the switch, who creates, sites (8 then Show more, add and remove), sign-ins, notify, screenshots; members read", async () => {
    const { client, calls } = fakeClient();
    await render(<OrgCloudSection client={client} cloud={F.CLOUD_ADMIN} manager enterprise />);
    expect($('[data-testid="work-org-cloud-usage"]')?.textContent).toBe("188 of 600 minutes this month · 1,240 of 3,000 steps · 2 cloud computers at once");
    expect($$("[data-cloud-site]").length).toBe(8);
    await click($('[data-testid="work-org-cloud-sites-more"]'));
    expect($$("[data-cloud-site]").length).toBe(10);
    await type($('[data-testid="work-org-cloud-site-input"]') as HTMLInputElement, "https://New.Portal.example/login");
    await click($('[data-testid="work-org-cloud-site-add"]'));
    expect(calls).toContainEqual(["org", { hosts: [...F.ORG_CLOUD.hosts, "new.portal.example"] }]);
    await type($('[data-testid="work-org-cloud-site-input"]') as HTMLInputElement, "10.0.0.1");
    await click($('[data-testid="work-org-cloud-site-add"]'));
    expect($('[data-testid="work-org-cloud-hosts"] [role="alert"]')?.textContent).toBe("Enter a site like portal.example.com.");
    await click($('[aria-label="Remove billdesk.example"]'));
    expect(calls.at(-1)?.[1]).toEqual({ hosts: expect.not.arrayContaining(["billdesk.example"]) });
    await key($('[data-testid="work-org-cloud-creators"] [data-option="admins"]')!, "ArrowRight");
    expect(calls).toContainEqual(["org", { creators: "everyone" }]);
    await click($('[data-testid="work-org-cloud-retention"] [data-option="90"]'));
    expect(calls).toContainEqual(["org", { retention_days: 90 }]);
    expect($$("[data-cloud-signin]").length).toBe(3);
    expect($('[data-cloud-signin="s_northbeam"]')?.textContent).toContain("o***s@acme-freight.example");
    // A sign-in: the password field is a password field, sent once, gone when the dialog closes.
    await click($('[data-testid="work-org-cloud-signin-add"]'));
    const dialog = $('[data-testid="work-org-cloud-signin-dialog"]')!;
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input")];
    expect($('[data-testid="work-org-cloud-signin-password"]')?.getAttribute("type")).toBe("password");
    await type(inputs[0]!, "Northbeam (finance)");
    await type(inputs[1]!, "portal.northbeam.example");
    await type(inputs[2]!, "finance@acme-freight.example");
    await type(inputs[3]!, "correct horse");
    await click($('[data-testid="work-org-cloud-signin-save"]'));
    await settle();
    expect(calls).toContainEqual(["addSignin", { label: "Northbeam (finance)", hosts: ["portal.northbeam.example"], username: "finance@acme-freight.example", password: "correct horse", use: "admins" }]);
    expect($('[data-testid="work-org-cloud-signin-dialog"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain("correct horse");
    await click($('[data-testid="work-org-cloud-enabled"] [role="switch"]'));
    expect(calls).toContainEqual(["org", { enabled: false }]);
    await unmount?.();
    // A member reads it: no switches, no inputs, no sign-in buttons.
    const member = fakeClient();
    await render(<OrgCloudSection client={member.client} cloud={F.CLOUD_MEMBER} manager={false} enterprise />);
    expect($('[data-testid="work-org-cloud"] [role="switch"]')).toBeNull();
    expect($('[data-testid="work-org-cloud-site-input"]')).toBeNull();
    expect($('[data-testid="work-org-cloud-signin-add"]')).toBeNull();
    expect($('[data-testid="work-org-cloud-creators"]')?.textContent).toContain("Admins");
  });

  test("without staff's saved sign-ins switch the sign-ins row is not there", async () => {
    const { client } = fakeClient({ getWorkOrgCloud: async () => ({ ...F.ORG_CLOUD, vault: false }) });
    await render(<OrgCloudSection client={client} cloud={F.CLOUD_ADMIN} manager enterprise />);
    expect($('[data-testid="work-org-cloud"]')).not.toBeNull();
    expect($('[data-testid="work-org-cloud-signins"]')).toBeNull();
  });
});

describe("Today and the chat card", () => {
  test("Today: at most 3 rows of runs that need someone or failed, each with one action; Show all opens the page", async () => {
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener(model.WORK_CLOUD_OPEN_EVENT, listener);
    const items = [...F.FEED_CLOUD, { ...F.FEED_CLOUD[0]!, run_id: "r_x" }, { ...F.FEED_CLOUD[0]!, run_id: "r_done", status: "done" as const }];
    await render(<CloudTodayStrip items={items} />);
    expect($$("[data-cloud-feed]").map((row) => row.dataset.cloudFeed)).toEqual(["r_code", "r_approval", "r_failed"]);
    expect($$('[data-testid="work-today-cloud-open"]').map((b) => b.textContent)).toEqual(["Enter code", "Review", "Open"]);
    await click($('[data-testid="work-today-cloud-open"]'));
    await click($('[data-testid="work-today-cloud-all"]'));
    expect(opened).toEqual([{ task: "t_invoices", run: "r_code" }, {}]);
    window.removeEventListener(model.WORK_CLOUD_OPEN_EVENT, listener);
    expect(model.cloudSearch({ task: "t_1", run: "r_1" })).toBe("?task=t_1&run=r_1");
  });

  test("Home with no connector: the strip still shows runs that wait while Cloud tasks are on, and asks nothing while off", async () => {
    const feedCalls: unknown[] = [];
    const client = {
      baseUrl: "http://cloud.test",
      getWorkFeed: async (query: unknown) => { feedCalls.push(query); return { groups: { needs_you: [], today: [], fyi: [] }, sources: [], cloud: [...F.FEED_CLOUD, { ...F.FEED_CLOUD[0]!, run_id: "r_more" }] }; },
    };
    function Home(props: { on: boolean }) {
      const items = useCloudHomeItems(client as never, props.on);
      return items.length ? <CloudTodayStrip items={items} /> : <p data-testid="home-plain">plain</p>;
    }
    await render(<Home on />);
    await settle();
    expect($$("[data-cloud-feed]").map((row) => row.dataset.cloudFeed)).toEqual(["r_code", "r_approval", "r_failed"]);
    expect($$('[data-testid="work-today-cloud-open"]')[0]?.textContent).toBe("Enter code");
    expect(feedCalls.length).toBe(1);
    await unmount?.();
    unmount = null;
    feedCalls.length = 0;
    await render(<Home on={false} />);
    await settle();
    expect($('[data-testid="home-plain"]')).not.toBeNull();
    expect(feedCalls).toEqual([]);
  });

  test("a scheduled task card and a run line that updates; no Open button while Cloud tasks are off", async () => {
    const output = JSON.stringify({ task: F.TASKS[0], next_run_at: "x" });
    await render(<CloudToolCard toolName="omnirush-work_work_cloud_task" output={output} />);
    expect($('[data-testid="work-cloud-card"]')?.textContent).toBe(`Pull supplier invoicesScheduled: ${model.scheduleText(F.TASKS[0]!.schedule)}`);
    expect($('[data-testid="work-cloud-card-open"]')).toBeNull();
    await unmount?.();
    const { client } = fakeClient({ getWorkCloudRun: async () => ({ ...F.RUNS.r_running!, steps: 7 }) });
    model.useCloudClientStore.getState().setClient(client, true);
    await render(<CloudToolCard toolName="omnirush-work_work_cloud_run" output={JSON.stringify({ run_id: "r_running", status: "queued" })} />);
    await settle();
    expect($('[data-testid="work-cloud-card"]')?.getAttribute("data-status")).toBe("running");
    expect($('[data-testid="work-cloud-card"]')?.textContent).toContain("Running, step 7");
    expect($('[data-testid="work-cloud-card-open"]')?.textContent).toBe("Open");
  });
});


describe("cloud task records in the viewer", () => {
  test("the source reads Cloud task with the task's title, the File field opens the PDF, and no body repeats the fields", async () => {
    expect(records.connectorName("webtask")).toBe("Cloud task");
    expect(records.sourceLabel({ source: "webtask", kind: "invoice" })).toBe("Cloud task");
    const previewed: unknown[] = [];
    const record = {
      source_id: "webtask:t_billd:INV-4479", source: "webtask", kind: "invoice", view: "generic", subject: "Invoice INV-4479 - Maple Print Works",
      source_detail: "Pull Northbeam invoices every Monday",
      body: { format: "text", content: "" },
      fields: [{ label: "Invoice", value: "INV-4479" }, { label: "File", value: "PDF", attachment: 0 }],
      attachments: [{ n: 0, name: "INV-4479.pdf", size: 2048, content_type: "application/pdf", available: true }],
    };
    await render(<RecordView record={record as never} onPreview={(file, from) => previewed.push([file.name, from])} />);
    const fileButton = $('[data-field-file="0"]');
    expect(fileButton?.textContent).toBe("INV-4479.pdf");
    await click(fileButton);
    expect(previewed).toEqual([["INV-4479.pdf", "webtask:t_billd:INV-4479"]]);
    expect($('[data-testid="work-viewer-attachments"]')?.textContent).toContain("INV-4479.pdf");
    expect(document.body.textContent).not.toContain("Invoice: INV-4479");
    expect(document.body.textContent).not.toContain("File: PDF");
    expect(zh["work.cloud.record_source"]).toBe("云端任务");
  });
});
