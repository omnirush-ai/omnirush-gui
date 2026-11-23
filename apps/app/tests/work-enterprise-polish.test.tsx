/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { CONNECTED_SHOWN, ConnectorRow, WorkConnectorsPage } = await import("../src/react-app/domains/work/work-views");

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
