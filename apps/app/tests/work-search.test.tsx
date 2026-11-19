import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createOmniRushServerClient, OmniRushServerError, type OmniRushWorkConnector, type OmniRushWorkCoverage, type OmniRushWorkDeal, type OmniRushWorkDealDetail, type OmniRushWorkImport, type OmniRushWorkSearch } from "../src/app/lib/omnirush-server";
import {
  askAboutDealPrompt, coverageAdds, coverageCanAdd, hasDeals, isWorkSearchShortcut, periodStart, snippetParts, workConnectorsKey, workCoverageKey, workDealKey, workDealsKey, workImportsKey, workOnboardingKey,
  WORK_DEALS_ROUTE, WORK_SEARCH_ROUTE,
} from "../src/react-app/domains/work/work-mode";
import { ChatImportCard, WorkConnectorsPage, WorkCoverageMeter } from "../src/react-app/domains/work/work-views";
import { WorkSearchPage } from "../src/react-app/domains/work/work-search";
import { DealPanel, WorkDealsPage } from "../src/react-app/domains/work/work-deals";
import { SampleDataBadge } from "../src/react-app/domains/work/work-onboarding";

const noop = () => {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function failQuery(queries: QueryClient, queryKey: readonly unknown[], error: Error) {
  queries.setQueryDefaults([...queryKey], { retryOnMount: false });
  queries.getQueryCache().build(queries, { queryKey: [...queryKey], retry: false }).setState({ status: "error", error, fetchStatus: "idle", errorUpdatedAt: 1 });
}
const wrap = (queries: QueryClient, node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={queries}>{node}</QueryClientProvider>);

const coverage: OmniRushWorkCoverage = {
  groups: [
    { group: "mail", label: "Mail", state: "connected", sources: ["google"], said_you_use: true },
    { group: "chat", label: "Chat", state: "missing", sources: ["slack", "whatsapp", "telegram"], said_you_use: true },
    { group: "docs", label: "Docs", state: "attention", sources: ["google"], said_you_use: true },
    { group: "calendar", label: "Calendar", state: "connected", sources: ["google"], said_you_use: true },
  ],
  connected: 3,
  total: 4,
  missing_used: ["slack"],
};

const item = (id: string, subject: string, snippet = "the **price** is too high") => ({ source_id: `gmail:${id}`, channel: "gmail", kind: "email", subject, snippet, who: "Dana Ruiz", occurred_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), url: `https://mail.test/${id}`, match: "both" });
const results: OmniRushWorkSearch = {
  query: "price",
  semantic: true,
  indexing: { embedded: 4210, total: 9800 },
  total: 6,
  groups: [
    { channel: "gmail", group: "mail", label: "Gmail", count: 5, items: [1, 2, 3, 4, 5].map((n) => item(String(n), `Quote ${n}`)) },
    { channel: "slack", group: "chat", label: "Slack", count: 1, items: [{ source_id: "slack:9", channel: "slack", kind: "message", subject: null, snippet: "can we lower the **price**", who: "Lee Chen", occurred_at: null, url: null, match: "meaning" }] },
  ],
  coverage_note: "WhatsApp isn't connected, so its results are not included.",
};

const deals: OmniRushWorkDeal[] = [
  { source_id: "demo:hubspot:deal:9001", url: "https://crm.test/9001", name: "Summit Gear wholesale", company: "Summit Gear", amount: 48000, stage: "Proposal sent", close_date: "2026-12-03", owner: "Sam", last_touch: { at: new Date(Date.now() - 2 * 86_400_000).toISOString(), channel: "gmail", direction: "in" }, risk: ["No contact in 14 days", "Competitor mentioned"] },
  { source_id: "demo:hubspot:deal:9002", url: null, name: "Pine Ridge renewal", company: null, amount: null, stage: "Qualified", close_date: null, owner: null, last_touch: null, risk: [] },
];

describe("Work search, deals and coverage (contract D6)", () => {
  test("the pages have all four layers: route, page branch, local route and client method", async () => {
    const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
    for (const name of ["WORK_SEARCH_ROUTE", "WORK_DEALS_ROUTE"]) expect(route).toContain(`location.pathname.startsWith(${name}) ? (`);
    expect(route).toContain("hasDeals(workDeals.data) ? { onOpenDeals");
    expect(WORK_SEARCH_ROUTE.startsWith("/work/")).toBe(true);
    expect(WORK_DEALS_ROUTE.startsWith("/work/")).toBe(true);
    const local = readFileSync(new URL("../../server/src/work/routes.ts", import.meta.url), "utf8");
    for (const path of ["/work/search", "/work/coverage", "/work/deals", "/work/deals/:id", "/work/imports"]) expect(local).toContain(`"${path}"`);
    const seen: { url: string; method: string; body: unknown }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      return Response.json(String(input).includes("/work/imports") && init?.method === "POST" ? { id: "i", status: "done", records: 2 } : { items: [] });
    }) as typeof fetch;
    try {
      const client = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:9" });
      await client.searchWork({ q: "price too high", channels: "gmail", from: "2026-11-01" });
      await client.getWorkCoverage();
      await client.listWorkDeals("at_risk");
      await client.getWorkDeal("demo:hubspot:deal:9001");
      await client.listWorkImports();
      expect(await client.importWorkChat("whatsapp", new File(["x"], "_chat.txt"))).toEqual({ id: "i", status: "done", records: 2 });
    } finally {
      globalThis.fetch = saved;
    }
    expect(seen.map((call) => `${call.method} ${call.url.replace("http://127.0.0.1:9", "")}`)).toEqual([
      "GET /work/search?q=price+too+high&channels=gmail&from=2026-11-01",
      "GET /work/coverage",
      "GET /work/deals?filter=at_risk",
      "GET /work/deals/demo%3Ahubspot%3Adeal%3A9001",
      "GET /work/imports",
      "POST /work/imports",
    ]);
    const form = seen.at(-1)?.body as FormData;
    expect(form.get("kind")).toBe("whatsapp");
    expect((form.get("file") as File).name).toBe("_chat.txt");
  });

  test("helpers: Cmd/Ctrl+K in Work, period starts, bold matches, what the meter offers, the deal brief", () => {
    const key = { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isWorkSearchShortcut(key, true)).toBe(true);
    expect(isWorkSearchShortcut(key, false)).toBe(false);
    expect(isWorkSearchShortcut({ ...key, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isWorkSearchShortcut({ ...key, shiftKey: true }, true)).toBe(false);
    const thursday = new Date(2026, 10, 19, 15, 30);
    expect(periodStart("week", thursday)).toBe("2026-11-16");
    expect(periodStart("month", thursday)).toBe("2026-11-01");
    expect(periodStart("quarter", thursday)).toBe("2026-10-01");
    expect(periodStart("week", new Date(2026, 10, 22))).toBe("2026-11-16");
    expect(periodStart("any", thursday)).toBeUndefined();
    expect(snippetParts("the **price** is <b>high</b>")).toEqual([{ text: "the ", bold: false }, { text: "price", bold: true }, { text: " is <b>high</b>", bold: false }]);
    expect(snippetParts(null)).toEqual([]);
    expect(coverageAdds(coverage)).toEqual(["slack"]);
    expect(coverageAdds({ ...coverage, missing_used: [] })).toEqual(["slack"]);
    expect(coverageAdds({ ...coverage, groups: [...coverage.groups, { group: "crm", label: "CRM", state: "missing", sources: ["hubspot"] }], missing_used: ["whatsapp"] })).toEqual(["whatsapp", "slack", "hubspot"]);
    expect(coverageAdds(undefined)).toEqual([]);
    expect(hasDeals({ items: deals })).toBe(true);
    expect(hasDeals({ items: [] })).toBe(false);
    expect(hasDeals(undefined)).toBe(false);
    const brief = askAboutDealPrompt(deals[0]!);
    expect(brief).toContain('"Summit Gear wholesale" with Summit Gear');
    expect(brief).toContain("demo:hubspot:deal:9001");
    expect(brief).toContain("work_deals");
  });

  test("coverage meter: N of M with + chips; hidden while loading, when complete, and when the route fails (404)", () => {
    const client = { baseUrl: "http://cov.test" } as never;
    const render = (setup: (queries: QueryClient) => void) => {
      const queries = new QueryClient();
      setup(queries);
      return wrap(queries, <WorkCoverageMeter client={client} onAdd={noop} />);
    };
    const shown = render((queries) => queries.setQueryData(workCoverageKey(client), { ...coverage, missing_used: ["slack", "whatsapp"] }));
    expect(shown).toContain("Ask sees 3 of 4 channels");
    expect(shown).toContain('role="meter"');
    expect(shown).toContain('aria-valuenow="3"');
    expect(shown.match(/data-coverage-group=/g)?.length).toBe(4);
    expect(shown).toContain('data-state="attention"');
    expect(shown).toMatch(/data-coverage-add="slack"[^>]*>.*Slack</);
    expect(shown).toContain(">WhatsApp import<");
    expect(shown).not.toMatch(/—/);
    expect(render(() => {})).toBe("");
    const complete = { ...coverage, groups: coverage.groups.map((group) => ({ ...group, state: "connected" })), connected: 4, missing_used: [] };
    expect(render((queries) => queries.setQueryData(workCoverageKey(client), complete))).toBe("");
    expect(render((queries) => failQuery(queries, workCoverageKey(client), new OmniRushServerError(404, "request_failed", "Not Found")))).toBe("");
    expect(render((queries) => failQuery(queries, workCoverageKey(client), new OmniRushServerError(500, "request_failed", "boom")))).toBe("");
    // Missing dots stay visible in dark mode.
    expect(shown).toContain("dark:bg-muted-foreground/40");
    // Sample data is no channel: with nothing else connected the meter names it instead of "0 of 4", and keeps the + chips.
    const none = { ...coverage, groups: coverage.groups.map((group) => ({ ...group, state: "missing" })), connected: 0 };
    const sample = render((queries) => { queries.setQueryData(workCoverageKey(client), none); queries.setQueryData(workOnboardingKey(client), { done: true, sample_data: true }); });
    expect(sample).toContain("Ask sees sample data only");
    expect(sample).not.toContain("0 of 4");
    expect(sample).not.toContain('role="meter"');
    expect(sample).toContain('data-coverage-add="slack"');
    expect(render((queries) => queries.setQueryData(workCoverageKey(client), none))).toContain("Ask sees 0 of 4 channels");
    const mixed = render((queries) => { queries.setQueryData(workCoverageKey(client), coverage); queries.setQueryData(workOnboardingKey(client), { done: true, sample_data: true }); });
    expect(mixed).toContain("Ask sees 3 of 4 channels");
  });

  test("search with the meter: + chips only where Connectors can add, one no-match line, no coverage note, no native clear button", async () => {
    const rows: OmniRushWorkConnector[] = [
      { id: "google", label: "Google", status: "connected", last_sync_at: null, records: 3, sync_enabled: true },
      { id: "slack", label: "Slack", status: "disconnected", last_sync_at: null, records: 0, sync_enabled: true },
      { id: "whatsapp", label: "WhatsApp", status: "disconnected", mode: "import", last_sync_at: null, records: 0, sync_enabled: true },
    ];
    expect(coverageCanAdd(rows, "slack")).toBe(true);
    expect(coverageCanAdd(rows, "telegram")).toBe(true);
    expect(coverageCanAdd(rows, "meetings")).toBe(false);
    expect(coverageCanAdd(undefined, "slack")).toBe(false);
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const withCalls = { ...coverage, groups: [...coverage.groups, { group: "calls", label: "Calls", state: "missing", sources: ["meetings"], said_you_use: false }], missing_used: ["slack", "meetings"] };
      const client = {
        baseUrl: "http://search-meter.test",
        getWorkCoverage: async () => withCalls,
        listWorkConnectors: async () => rows,
        searchWork: async (query: Record<string, unknown>) => (query.q === "zzz" ? { query: "zzz", semantic: false, total: 0, groups: [], coverage_note: "Slack isn't connected, so its results are not included." } : results),
      } as never;
      const queries = new QueryClient();
      document.body.innerHTML = '<div id="root"></div>';
      const root = createRoot(document.getElementById("root")!);
      await act(async () => root.render(<QueryClientProvider client={queries}><WorkSearchPage client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} /></QueryClientProvider>));
      await act(async () => { await sleep(0); });
      const box = document.querySelector<HTMLInputElement>('[data-testid="work-search-input"]')!;
      expect(box.className).toContain("[&::-webkit-search-cancel-button]:appearance-none");
      expect(document.querySelector('[data-coverage-add="slack"]')).not.toBeNull();
      expect(document.querySelector('[data-coverage-add="meetings"]')).toBeNull();
      const type = async (value: string) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, value);
          box.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => { await sleep(450); });
        await act(async () => { await sleep(0); });
      };
      await type("zzz");
      expect(document.querySelector('[data-testid="work-search-empty"]')?.textContent).toBe("No matches. Try other words.");
      expect(document.querySelector('[data-testid="work-search-note"]')).toBeNull();
      await type("price");
      expect(document.querySelectorAll("[data-search-group]").length).toBe(2);
      expect(document.querySelector('[data-testid="work-search-note"]')).toBeNull();
      await act(async () => root.unmount());
      queries.clear();
    } finally {
      if (registered) await GlobalRegistrator.unregister();
    }
  });

  test("search: loading, grouped results with bold matches and Show all, channel chips, empty, error, Ask; no meter when coverage 404s", async () => {
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const asked: string[] = [];
      const queriesSeen: Record<string, unknown>[] = [];
      let release: (() => void) | null = null;
      const client = {
        baseUrl: "http://search.test",
        getWorkCoverage: async () => { throw new OmniRushServerError(404, "request_failed", "Not Found"); },
        searchWork: async (query: Record<string, unknown>) => {
          queriesSeen.push(query);
          if (query.q === "slow") await new Promise<void>((resolve) => { release = resolve; });
          if (query.q === "boom") throw new OmniRushServerError(500, "request_failed", "boom");
          if (query.q === "zzz") return { query: "zzz", semantic: false, total: 0, groups: [] };
          if (query.q === "thin") return { ...results, groups: [...results.groups, { channel: "notion", group: "docs", label: "Notion", count: 5, items: [] }] };
          if (query.channels === "gmail") return { ...results, total: 5, groups: [results.groups[0]!] };
          return results;
        },
      } as never;
      const queries = new QueryClient();
      document.body.innerHTML = '<div id="root"></div>';
      const root = createRoot(document.getElementById("root")!);
      await act(async () => root.render(<QueryClientProvider client={queries}><WorkSearchPage client={client} openLink={noop} onAsk={async (prompt) => { asked.push(prompt); }} onOpenConnectors={noop} /></QueryClientProvider>));
      const box = document.querySelector<HTMLInputElement>('[data-testid="work-search-input"]')!;
      expect(document.activeElement).toBe(box);
      expect(box.placeholder).toBe("Search mail, chat, calls, docs and deals");
      const type = async (value: string) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, value);
          box.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => { await sleep(450); });
        await act(async () => { await sleep(0); });
      };
      const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`);
      // Nothing typed: no results area, and the meter stays out because coverage answered 404.
      expect(byTest("work-search-results")).toBeNull();
      expect(byTest("work-coverage")).toBeNull();
      expect(byTest("work-search-error")).toBeNull();

      await type("slow");
      expect(byTest("work-search-loading")).not.toBeNull();
      await act(async () => { release?.(); await sleep(0); });

      await type("price");
      expect(queriesSeen.at(-1)).toEqual({ q: "price" });
      expect(document.querySelectorAll("[data-search-group]").length).toBe(2);
      expect(document.querySelectorAll('[data-search-group="gmail"] [data-search-item]').length).toBe(3);
      expect(document.querySelector('[data-search-group="gmail"] strong')?.textContent).toBe("price");
      expect(byTest("work-search-mode")?.textContent).toBe("Meaning + keywords");
      expect(byTest("work-search-indexing")?.textContent).toBe("Indexing for search: 4,210 of 9,800");
      expect(byTest("work-search-note")?.textContent).toContain("WhatsApp isn't connected");
      expect(document.querySelectorAll("[data-search-channel]").length).toBe(3);
      // A hit without a subject reads as its channel, and one without a link opens nothing.
      expect(document.querySelector('[data-search-item="slack:9"]')?.getAttribute("role")).toBeNull();
      const showAll = byTest("work-search-show-all") as HTMLButtonElement;
      expect(showAll.textContent).toBe("Show all 5");
      await act(async () => { showAll.click(); await sleep(0); });
      await act(async () => { await sleep(0); });
      expect(queriesSeen.at(-1)).toEqual({ q: "price", channels: "gmail", limit: 100 });
      expect(document.querySelectorAll('[data-search-group="gmail"] [data-search-item]').length).toBe(5);
      expect(document.querySelector('[data-search-channel="gmail"]')?.getAttribute("aria-checked")).toBe("true");
      // The chips still list every channel of the unfiltered search.
      expect(document.querySelectorAll("[data-search-channel]").length).toBe(3);

      await act(async () => { document.querySelector<HTMLButtonElement>('[data-search-period="month"]')!.click(); await sleep(0); });
      await act(async () => { await sleep(0); });
      // A new period drops the picked channel, so the chips come back.
      expect(queriesSeen.at(-1)).toEqual({ q: "price", from: expect.stringMatching(/^\d{4}-\d{2}-01$/) });
      expect(document.querySelectorAll("[data-search-channel]").length).toBe(3);
      expect(document.querySelector('[data-search-channel="all"]')?.getAttribute("aria-checked")).toBe("true");

      // A channel with a count but no items keeps its header and Show all, without an empty box.
      await type("thin");
      const thin = document.querySelector('[data-search-group="notion"]')!;
      expect(thin.querySelector("ul")).toBeNull();
      expect(thin.querySelector('[data-testid="work-search-show-all"]')?.textContent).toBe("Show all 5");

      await type("zzz");
      expect(byTest("work-search-empty")?.textContent).toBe("No matches. Try other words, or connect more channels.");
      expect(byTest("work-search-mode")?.textContent).toBe("Keywords only");

      await type("boom");
      expect(byTest("work-search-error")?.textContent).toContain("Try again");

      await act(async () => { (byTest("work-search-ask") as HTMLButtonElement).click(); await sleep(0); });
      expect(asked).toEqual(["boom"]);
      await act(async () => root.unmount());
      queries.clear();
    } finally {
      if (registered) await GlobalRegistrator.unregister();
    }
  });

  test("deals: table with risk, last touch and narrow columns; empty and error states; the panel shows people, latest and Ask", () => {
    const client = { baseUrl: "http://deals.test" } as never;
    const render = (setup: (queries: QueryClient) => void) => {
      const queries = new QueryClient();
      setup(queries);
      return wrap(queries, <WorkDealsPage client={client} openLink={noop} onAsk={async () => {}} />);
    };
    const table = render((queries) => queries.setQueryData(workDealsKey(client, "open"), { items: deals }));
    expect(table.match(/data-deal="/g)?.length).toBe(2);
    expect(table).toContain("Summit Gear wholesale");
    expect(table).toContain("48,000");
    expect(table).toContain("No contact in 14 days");
    expect(table).toContain(">+1<");
    expect(table).toContain('data-connector-icon="gmail"');
    expect(table).toContain("None yet");
    expect(table).toContain("@2xl:table-cell");
    expect(table).toMatch(/aria-checked="true"[^>]*data-deal-filter="open"/);
    expect(table).not.toMatch(/—/);
    // Names wrap to two lines, never cut on one; Risk is narrower.
    expect(table).toContain("line-clamp-2");
    expect(table).toContain("w-[10rem]");
    expect(table).not.toContain("work-deals-more");
    // Five rows, then "Show N more".
    const many = Array.from({ length: 7 }, (_, index) => ({ ...deals[1]!, source_id: `demo:hubspot:deal:${index}`, name: `Deal ${index}` }));
    const capped = render((queries) => queries.setQueryData(workDealsKey(client, "open"), { items: many }));
    expect(capped.match(/data-deal="/g)?.length).toBe(5);
    expect(capped).toContain(">Show 2 more<");
    expect(render((queries) => queries.setQueryData(workDealsKey(client, "open"), { items: [] }))).toContain("No deals here.");
    expect(render(() => {})).toContain('data-testid="work-deals-loading"');
    const failed = render((queries) => failQuery(queries, workDealsKey(client, "open"), new OmniRushServerError(503, "request_failed", "Service Unavailable")));
    expect(failed).toContain('data-testid="work-deals-error"');
    expect(failed).toContain("Try again");

    const detail: OmniRushWorkDealDetail = {
      ...deals[0]!,
      contacts: [{ id: "e1", name: "Sam Okafor" }, { id: "e2", name: "Ana Diaz" }],
      activity: [{ channel: "gmail", items: [{ source_id: "gmail:1", kind: "email", channel: "gmail", subject: "Quote for 240 units", at: new Date().toISOString(), url: "https://mail.test/1" }] }],
    };
    const queries = new QueryClient();
    queries.setQueryData(workDealKey(client, deals[0]!.source_id), detail);
    const panel = wrap(queries, <DealPanel client={client} deal={deals[0]!} openLink={noop} onAsk={noop} asking={false} />);
    expect(panel).toContain("Proposal sent");
    expect(panel).toContain("Sam Okafor, Ana Diaz");
    expect(panel).toContain('data-deal-channel="gmail"');
    expect(panel).toContain("Quote for 240 units");
    expect(panel).toContain("Competitor mentioned");
    expect(panel).toContain("Ask about this deal");
    const missing = new QueryClient();
    failQuery(missing, workDealKey(client, deals[0]!.source_id), new OmniRushServerError(404, "unknown_deal", "That deal no longer exists."));
    expect(wrap(missing, <DealPanel client={client} deal={deals[0]!} openLink={noop} onAsk={noop} asking={false} />)).toContain("That deal no longer exists.");
  });

  test("removing sample data refreshes Deals (the sidebar entry) and the coverage meter at once", async () => {
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const client = { baseUrl: "http://sample.test", removeWorkDemo: async () => ({ ok: true }) } as never;
      const queries = new QueryClient();
      queries.setQueryData(workDealsKey(client, null), { items: deals });
      queries.setQueryData(workDealsKey(client, "open"), { items: deals });
      queries.setQueryData(workCoverageKey(client), coverage);
      document.body.innerHTML = '<div id="root"></div>';
      const root = createRoot(document.getElementById("root")!);
      await act(async () => root.render(<QueryClientProvider client={queries}><SampleDataBadge client={client} /></QueryClientProvider>));
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="work-sample-data-remove"]')!.click(); await sleep(0); });
      await act(async () => { await sleep(0); });
      for (const key of [workDealsKey(client, null), workDealsKey(client, "open"), workCoverageKey(client)]) expect(queries.getQueryState(key)?.isInvalidated).toBe(true);
      await act(async () => root.unmount());
      queries.clear();
    } finally {
      if (registered) await GlobalRegistrator.unregister();
    }
  });

  test("imports: WhatsApp and Telegram rows with the how-to and the last import; the import-mode row leaves the list; the strip sits above it", async () => {
    const client = { baseUrl: "http://imp.test" } as never;
    const imports: OmniRushWorkImport[] = [
      { id: "1", source: "telegram", file_name: "result.json", status: "failed", records: 0, error: "KeyError", created_at: new Date().toISOString() },
      { id: "2", source: "whatsapp", file_name: "_chat.txt", status: "done", records: 34, created_at: new Date(Date.now() - 7_200_000).toISOString() },
    ];
    const queries = new QueryClient();
    queries.setQueryData(workImportsKey(client), imports);
    const card = wrap(queries, <ChatImportCard client={client} />);
    expect(card).toContain("On your phone: open the chat, tap More, Export chat, Without media.");
    expect(card).toContain("Export Telegram data");
    expect(card).toContain("_chat.txt · 34 chat days · 2 h ago");
    expect(card).toContain("Couldn&#x27;t read result.json");
    expect(card).not.toContain("KeyError");
    expect(card).toContain('accept=".txt,.zip,text/plain,application/zip"');
    expect(card).toContain('aria-label="Import a Telegram chat"');
    const quiet = wrap(new QueryClient(), <ChatImportCard client={client} />);
    expect(quiet).not.toContain('data-testid="work-import-status"');
    // A file with no messages comes back done with 0 records: it reads as not read, never "0 chat days".
    const nothing = new QueryClient();
    nothing.setQueryData(workImportsKey(client), [{ id: "3", source: "telegram", file_name: "result.json", status: "done", records: 0, created_at: null }]);
    const none = wrap(nothing, <ChatImportCard client={client} />);
    expect(none).toContain("Couldn&#x27;t read result.json");
    expect(none).not.toContain("0 chat days");

    const rows: OmniRushWorkConnector[] = [
      { id: "google", label: "Google", status: "connected", last_sync_at: null, records: 3, sync_enabled: true },
      { id: "whatsapp", label: "WhatsApp", status: "disconnected", mode: "import", last_sync_at: null, records: 0, sync_enabled: true },
    ];
    const page = new QueryClient();
    page.setQueryData(workConnectorsKey(client), rows);
    page.setQueryData(workCoverageKey(client), coverage);
    const markup = wrap(page, <WorkConnectorsPage client={client} openLink={noop} />);
    expect(markup).toContain('data-work-connector="google"');
    expect(markup).not.toContain('data-work-connector="whatsapp"');
    expect(markup).toContain('data-work-import="whatsapp"');
    expect(markup.indexOf('data-testid="work-coverage"')).toBeLessThan(markup.indexOf('data-work-connector="google"'));
    // Chips only for what this page can add: Slack connects here, Telegram opens its import; Meetings has no row here, so no chip.
    const addable = new QueryClient();
    addable.setQueryData(workConnectorsKey(client), [...rows, { id: "slack", label: "Slack", status: "disconnected", last_sync_at: null, records: 0, sync_enabled: true }]);
    addable.setQueryData(workCoverageKey(client), { ...coverage, groups: [...coverage.groups, { group: "calls", label: "Calls", state: "missing", sources: ["meetings"], said_you_use: false }], missing_used: ["slack", "telegram"] });
    const chips = wrap(addable, <WorkConnectorsPage client={client} openLink={noop} />);
    expect(chips).toContain('data-coverage-add="slack"');
    expect(chips).toContain('data-coverage-add="telegram"');
    expect(chips).not.toContain('data-coverage-add="meetings"');
    expect(wrap(addable, <WorkCoverageMeter client={client} onAdd={noop} />)).toContain('data-coverage-add="meetings"');
    const old = new QueryClient();
    old.setQueryData(workConnectorsKey(client), rows);
    failQuery(old, workCoverageKey(client), new OmniRushServerError(404, "request_failed", "Not Found"));
    expect(wrap(old, <WorkConnectorsPage client={client} openLink={noop} />)).not.toContain('data-testid="work-coverage"');

    // Picking a file posts it with its kind; a file over 50 MB never leaves the app.
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const sent: { kind: string; name: string }[] = [];
      const live = { baseUrl: "http://imp-live.test", listWorkImports: async () => [], importWorkChat: async (kind: string, file: File) => { sent.push({ kind, name: file.name }); return { id: "x", status: "done", records: 3 }; } } as never;
      const liveQueries = new QueryClient();
      document.body.innerHTML = '<div id="root"></div>';
      const root = createRoot(document.getElementById("root")!);
      await act(async () => root.render(<QueryClientProvider client={liveQueries}><ChatImportCard client={live} /></QueryClientProvider>));
      const pick = async (kind: string, file: File) => {
        const input = document.querySelector<HTMLInputElement>(`[data-import-input="${kind}"]`)!;
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await sleep(0); });
      };
      await pick("telegram", new File(["{}"], "result.json"));
      expect(sent).toEqual([{ kind: "telegram", name: "result.json" }]);
      const big = new File(["x"], "huge.zip");
      Object.defineProperty(big, "size", { value: 50 * 1024 * 1024 + 1 });
      await pick("whatsapp", big);
      expect(sent.length).toBe(1);
      await act(async () => root.unmount());
      liveQueries.clear();
    } finally {
      if (registered) await GlobalRegistrator.unregister();
    }
  });
});
