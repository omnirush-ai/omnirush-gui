/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ReactNode } from "react";
import type { OmniRushWorkConnector, OmniRushWorkInsightsMember, OmniRushWorkMembers, OmniRushWorkSearch } from "../src/app/lib/omnirush-server";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { workConnectorsKey, workMembersKey, workSearchKey } = await import("../src/react-app/domains/work/work-mode");
const { personInitials, PersonAvatar } = await import("../src/react-app/domains/work/list-cap");
const { focusAreas, focusLabel, memberName, withNames } = await import("../src/react-app/domains/work/work-insights");
const { WorkOrganizationPage } = await import("../src/react-app/domains/work/work-org");
const { CHANNEL_ROWS, ChannelStrip, WorkSearchPage } = await import("../src/react-app/domains/work/work-search");
const { CONNECTED_SHOWN, ChatImportCard, ConnectorRow, LocalChatsCard, WorkConnectorsPage } = await import("../src/react-app/domains/work/work-views");
const { useEnterpriseStore } = await import("../src/react-app/domains/work/enterprise-mode");
const { dealAmount } = await import("../src/react-app/domains/work/work-deals");
const { workCoverageKey } = await import("../src/react-app/domains/work/work-mode");

const companyBlock = {
  status: "active" as const,
  org: { id: "org_1", name: "Atlas Logistics", domain: "atlas.example" },
  role: "owner" as const,
  code: false,
  capture: { code: false, chat: true },
  portal_url: null,
};
const coverage = { groups: [{ group: "mail", label: "Mail", state: "connected", sources: ["google"] }, { group: "chat", label: "Chat", state: "missing", sources: ["whatsapp", "slack"] }], connected: 1, total: 2, missing_used: ["whatsapp"] };

const noop = () => {};
const client = { baseUrl: "http://polish.test" } as never;
const row = (over: Partial<OmniRushWorkConnector>): OmniRushWorkConnector => ({ id: "google", label: "Google", status: "connected", last_sync_at: new Date().toISOString(), records: 3, sync_enabled: true, ...over });

describe("people read by name", () => {
  test("initials come from the first and last word of a name, or the e-mail's first letter", () => {
    expect(personInitials("Maximilian van den Berghe-Oyelaran")).toBe("MB");
    expect(personInitials("ana")).toBe("A");
    expect(personInitials("cli-e2e-ana@juniperfreight.example")).toBe("C");
    expect(personInitials("  ")).toBe("?");
    expect(renderToStaticMarkup(<PersonAvatar name="Ana Ruiz" />)).toContain(">AR<");
  });

  test("insights: the members list's names join on user_id; the e-mail moves to the second line", () => {
    const member = { user_id: "u1", email: "ana@x.test", role: "owner", job_role: "Ops", focus: [] } as unknown as OmniRushWorkInsightsMember;
    const [named] = withNames([member], [{ user_id: "u1", email: "ana@x.test", name: "Ana Ruiz", role: "owner" }]);
    expect(named!.name).toBe("Ana Ruiz");
    expect(memberName(named!)).toEqual({ primary: "Ana Ruiz", secondary: "ana@x.test · Ops · Owner" });
    expect(memberName(member)).toEqual({ primary: "ana@x.test", secondary: "Ops · Owner" });
    expect(withNames([member], undefined)[0]).toBe(member);
  });

  test("work areas: thread keys read as their source's thread, once, with the counts added", () => {
    expect(focusLabel("thread:slack:C1:1794650400.000000")).toBe("Slack thread");
    expect(focusLabel("thread:gmail:gm-t-pallets")).toBe("Gmail thread");
    expect(focusLabel("email:ana@x.test")).toBe("ana@x.test");
    expect(focusAreas([["thread:slack:C1:1", 3], ["thread:slack:D1:2", 2], ["domain:acme.test", 4]])).toEqual([["Slack thread", 5], ["acme.test", 4]]);
    // The person's own address and the company's own domain match everything, so they are left out.
    expect(focusAreas([["domain:acme.test", 200], ["email:Max@Acme.test", 200], ["company:ColdChain", 9]], "max@acme.test")).toEqual([["ColdChain", 9]]);
    for (const [label] of focusAreas([["thread:gmail:x", 1], ["thread:imap:y", 1]])) expect(label).not.toContain("thread:");
  });
});

describe("organization", () => {
  const members = (role: string): OmniRushWorkMembers => ({
    org: { id: "o1", name: "Atlas Logistics" }, you_role: role, invites: [],
    members: [
      { user_id: "u1", email: "max@atlas.test", name: "Maximilian van den Berghe", role: "owner", you: role === "owner" },
      { user_id: "u2", email: "ben@atlas.test", name: "Ben Ade", role: "admin", you: role === "admin" },
      { user_id: "u3", email: "cara@atlas.test", role: "member", you: role === "member" },
    ],
  });
  const render = (data: OmniRushWorkMembers) => {
    const queries = new QueryClient();
    queries.setQueryData(workMembersKey(client), data);
    return renderToStaticMarkup(<QueryClientProvider client={queries}><MemoryRouter><WorkOrganizationPage client={client} openLink={noop} onBack={noop} /></MemoryRouter></QueryClientProvider>);
  };

  test("owners and admins get Edit; members read who can change the profile", () => {
    expect(render(members("owner"))).toContain('data-testid="work-org-edit"');
    const admin = render(members("admin"));
    expect(admin).toContain('data-testid="work-org-edit"');
    expect(admin).not.toContain("Only owners and admins can change these.");
    const member = render(members("member"));
    expect(member).not.toContain('data-testid="work-org-edit"');
    expect(member).toContain("Only owners and admins can change these.");
  });

  test("members show the name as the title, the e-mail below and initials from the name; no name falls back to the e-mail", () => {
    const markup = render(members("owner"));
    expect(markup).toContain('title="Maximilian van den Berghe (max@atlas.test)">Maximilian van den Berghe<');
    expect(markup).toContain(">MB<");
    expect(markup).toContain('title="cara@atlas.test">cara@atlas.test<');
    // Leave reads in red-11 (4.5:1 in light), still behind a confirm.
    expect(markup).toMatch(/data-testid="work-org-leave-button" class="[^"]*text-red-11/);
  });
});

describe("connectors", () => {
  test("the meta line leads with the last sync; the person's own address is left out but kept in the title", () => {
    const own = renderToStaticMarkup(<ConnectorRow connector={row({ account: "ops@example.com" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} ownEmail="Ops@Example.com" />);
    expect(own).toMatch(/data-testid="work-connector-meta">Last sync[^<]*· 3 records</);
    expect(own).toContain('· ops@example.com" data-testid="work-connector-meta"');
    const other = renderToStaticMarkup(<ConnectorRow connector={row({ account: "shared@example.com" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} ownEmail="ops@example.com" />);
    expect(other).toMatch(/data-testid="work-connector-meta">Last sync[^<]*· 3 records · shared@example\.com</);
  });

  test("the connected group shows the first rows with problems first, then Show N more", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `src${index}`);
    const rows = [
      ...ids.map((id) => row({ id, label: id.toUpperCase() })),
      row({ id: "slack", label: "Slack", status: "error", error: "reconnect_required" }),
    ];
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(workConnectorsKey(client), rows);
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<QueryClientProvider client={queries}><MemoryRouter><WorkConnectorsPage client={client} openLink={noop} /></MemoryRouter></QueryClientProvider>));
    const shown = () => [...document.querySelectorAll('[data-connector-group="connected"] [data-work-connector]')].map((node) => node.getAttribute("data-work-connector"));
    expect(shown().length).toBe(CONNECTED_SHOWN);
    expect(shown()[0]).toBe("slack");
    const more = document.querySelector<HTMLButtonElement>('[data-testid="work-connected-more"] [data-list-more]')!;
    expect(more.textContent).toBe("Show 5 more");
    await act(async () => more.click());
    expect(shown().length).toBe(13);
    await act(async () => root.unmount());
  });
});

describe("company accounts: one clear action on Connectors and Search", () => {
  const render = async (node: ReactNode, setup: (queries: InstanceType<typeof QueryClient>) => void) => {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    setup(queries);
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<QueryClientProvider client={queries}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>));
    return root;
  };

  test("connectors: no channel meter; WhatsApp and Telegram fold into one named Import chats row; own e-mail from the members list", async () => {
    await act(async () => { useEnterpriseStore.getState().setBlock(companyBlock); });
    const root = await render(<WorkConnectorsPage client={client} openLink={noop} />, (queries) => {
      queries.setQueryData(workConnectorsKey(client), [row({ account: "max@atlas.example" })]);
      queries.setQueryData(workCoverageKey(client), coverage);
      queries.setQueryData(workMembersKey(client), { org: null, invites: [], members: [{ user_id: "u1", email: "max@atlas.example", role: "owner", you: true }] } satisfies OmniRushWorkMembers);
    });
    expect(document.querySelector('[data-testid="work-coverage"]')).toBeNull();
    const card = document.querySelector('[data-testid="work-import-card"]')!;
    expect(card.getAttribute("data-folded")).toBe("true");
    expect(card.querySelector('[data-testid="work-import-names"]')!.textContent).toBe("WhatsApp and Telegram chat exports");
    expect(card.querySelectorAll("[data-work-import]").length).toBe(0);
    await act(async () => card.querySelector<HTMLButtonElement>('[data-testid="work-import-toggle"]')!.click());
    expect([...card.querySelectorAll("[data-work-import]")].map((node) => node.getAttribute("data-work-import"))).toEqual(["whatsapp", "telegram"]);
    expect(card.querySelector("[data-work-import] .text-\\[12px\\]")).toBeNull();
    expect(document.querySelector('[data-testid="work-connector-meta"]')!.textContent).not.toContain("max@atlas.example");
    await act(async () => root.unmount());
    await act(async () => { useEnterpriseStore.getState().setBlock(null); });
  });

  test("connectors: WhatsApp the company turned off stays listed with the reason; owners get Change in Organization", async () => {
    let managed = 0;
    const root = await render(
      <>
        <ChatImportCard client={client} off={["whatsapp"]} folded onManage={() => { managed += 1; }} />
        <LocalChatsCard client={client} openLink={noop} off={["whatsapp"]} keepOff onManage={() => { managed += 1; }} />
      </>,
      () => {},
    );
    const card = document.querySelector('[data-testid="work-import-card"]')!;
    expect(card.querySelector('[data-testid="work-import-names"]')!.textContent).toBe("WhatsApp and Telegram chat exports");
    await act(async () => card.querySelector<HTMLButtonElement>('[data-testid="work-import-toggle"]')!.click());
    const whatsapp = card.querySelector('[data-work-import="whatsapp"]')!;
    expect(whatsapp.querySelector('[data-testid="work-import-off"]')!.textContent).toBe("Turned off by your company");
    expect(whatsapp.querySelector('[aria-label="Import a WhatsApp chat"]')).toBeNull();
    expect(card.querySelector('[data-work-import="telegram"] [aria-label="Import a Telegram chat"]')).not.toBeNull();
    await act(async () => whatsapp.querySelector<HTMLButtonElement>('[data-testid="work-import-off-manage"]')!.click());
    const local = document.querySelector('[data-testid="work-whatsapp-card"]')!;
    expect(local.getAttribute("data-off")).toBe("true");
    await act(async () => local.querySelector<HTMLButtonElement>('[data-testid="work-local-off-manage"]')!.click());
    expect(managed).toBe(2);
    await act(async () => root.unmount());
  });

  test("connectors: Work users without a company keep the meter and the open import rows", async () => {
    const root = await render(<WorkConnectorsPage client={client} openLink={noop} />, (queries) => {
      queries.setQueryData(workConnectorsKey(client), [row({})]);
      queries.setQueryData(workCoverageKey(client), coverage);
    });
    expect(document.querySelector('[data-testid="work-coverage"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="work-import-card"]')!.getAttribute("data-folded")).toBeNull();
    expect(document.querySelectorAll("[data-work-import]").length).toBe(2);
    await act(async () => root.unmount());
  });

  test("search: a company account gets the search box without the channel meter", async () => {
    await act(async () => { useEnterpriseStore.getState().setBlock(companyBlock); });
    const root = await render(<WorkSearchPage client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} />, (queries) => {
      queries.setQueryData(workConnectorsKey(client), []);
      queries.setQueryData(workCoverageKey(client), coverage);
    });
    expect(document.querySelector('[data-testid="work-coverage"]')).toBeNull();
    expect(document.querySelector('[data-testid="work-search-input"]')).not.toBeNull();
    await act(async () => root.unmount());
    await act(async () => { useEnterpriseStore.getState().setBlock(null); });
  });
});

describe("deals", () => {
  test("an amount shows in its currency when the CRM sent one, else as the bare number", () => {
    expect(dealAmount(48000, "EUR")).toBe(new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(48000));
    expect(dealAmount(9000, null)).toBe((9000).toLocaleString(undefined, { maximumFractionDigits: 0 }));
    expect(dealAmount(null, "EUR")).toBe("");
  });
});

describe("search", () => {
  const groups = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, label: `Channel ${index}`, count: 40 - index }));

  test("the channel row keeps the six channels with the most hits; the rest go under More", () => {
    const markup = renderToStaticMarkup(<ChannelStrip channels={groups} total={400} selected={null} onSelect={noop} />);
    expect(markup.match(/data-strip-chip="/g)?.length).toBe(6);
    expect(markup).toContain('data-testid="work-search-channels-more"');
    expect(markup).not.toContain("flex-wrap");
    // The picked channel stays on the row.
    expect(renderToStaticMarkup(<ChannelStrip channels={groups} total={400} selected="c11" onSelect={noop} />)).toContain('data-strip-chip="c11"');
  });

  test("a channel view shows the first page of hits, then Show N more; ?q= fills the field", async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ source_id: `gmail:${index}`, channel: "gmail", kind: "email", subject: `Reefer ${index}`, snippet: "x", who: "Dana", occurred_at: new Date().toISOString(), url: null, match: "both" }));
    const data = (count: number): OmniRushWorkSearch => ({ query: "reefer", total: 60, semantic: false, groups: [{ channel: "gmail", label: "Gmail", count: 45, items: items.slice(0, count) }, { channel: "slack", label: "Slack", count: 15, items: [] }] } as unknown as OmniRushWorkSearch);
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(workSearchKey(client, { q: "reefer" }), data(3));
    queries.setQueryData(workSearchKey(client, { q: "reefer", channels: "gmail", limit: 100 }), data(45));
    queries.setQueryData(workConnectorsKey(client), []);
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<QueryClientProvider client={queries}><WorkSearchPage client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} initialQuery="reefer" /></QueryClientProvider>));
    expect(document.querySelector<HTMLInputElement>('[data-testid="work-search-input"]')!.value).toBe("reefer");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="work-search-show-all"]')!.click());
    expect(document.querySelectorAll("[data-search-item]").length).toBe(CHANNEL_ROWS);
    const more = document.querySelector<HTMLButtonElement>('[data-testid="work-search-channel-more"] [data-list-more]')!;
    await act(async () => more.click());
    expect(document.querySelectorAll("[data-search-item]").length).toBe(40);
    await act(async () => root.unmount());
  });
});

describe("appearance for company accounts", () => {
  test("only Mode and Accent colour, with the swatches and no custom colour field", async () => {
    const { AppearanceView } = await import("../src/react-app/domains/settings/pages/appearance-view");
    const props = { busy: false, themeMode: "light" as const, setThemeMode: noop, language: "en" as never, setLanguage: noop, hideTitlebar: false, toggleHideTitlebar: noop };
    await act(async () => { useEnterpriseStore.getState().setBlock(companyBlock); });
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<AppearanceView {...props} />));
    const company = document.body.innerHTML;
    await act(async () => root.unmount());
    expect(company).toContain('data-testid="appearance-accent"');
    expect(company).not.toContain('data-testid="accent-hex"');
    expect(company).not.toContain("Discord");
    expect(company).not.toContain("theme code");
    expect(company.match(/data-slot="item-title"/g)?.length).toBe(2);
    await act(async () => { useEnterpriseStore.getState().setBlock(null); });
  });
});
