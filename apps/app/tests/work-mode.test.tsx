import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import type { OmniRushWorkConnector, OmniRushWorkFeed, OmniRushWorkMembers } from "../src/app/lib/omnirush-server";
import { askAboutPrompt, checklistItems, CONNECTOR_ACCESS, connectOrder, connectSettled, connectorsBackState, countLabel, domainFromEmail, hasSampleData, healthFor, healthProblem, isWorkModeShortcut, keyLabel, shownInMode, visibleConnectors, workConnectorsKey, workErrorText, workInviteToken, workToolPermission,
  askAboutItemPrompt, coverageLine, relativeTime, workChatToolsKey, workFeedKey, workMembersKey, workToolNotices } from "../src/react-app/domains/work/work-mode";
import { SourceAttention, SourceStrip, sourceDot, WorkToday } from "../src/react-app/domains/work/work-today";
import { leaveState, WorkOrganizationPage } from "../src/react-app/domains/work/work-org";
import { SampleDataBadge, WorkOnboarding, WorkTryButton } from "../src/react-app/domains/work/work-onboarding";
import { ConnectorIcon, ConnectorRow, WorkConnectorsChip, WorkHome, WorkModeToggle, WorkToolNotices, WorkToolsBanner } from "../src/react-app/domains/work/work-views";
import { actorNames, EntityDetail } from "../src/react-app/domains/work/knowledge-views";

const row = (over: Partial<OmniRushWorkConnector>): OmniRushWorkConnector => ({
  id: "google", label: "Google", status: "disconnected", last_sync_at: null, records: 0, sync_enabled: false, ...over,
});
const noop = () => {};

describe("Work mode", () => {
  test("approvals name Work tools and their account in words", () => {
    expect(workToolPermission("omnirush-work_gmail_send")).toEqual({ label: "Send e-mail (Gmail)", scope: "Your Gmail account" });
    expect(workToolPermission("omnirush-work_mock_send")?.label).toBe("Send e-mail (Test source)");
    expect(workToolPermission("omnirush-work_hubspot_update_deal")?.label).toBe("Update a deal (HubSpot)");
    expect(workToolPermission("omnirush-work_work_remember")?.label).toBe("Save to company knowledge");
    expect(workToolPermission("omnirush-work_acme_frobnicate")?.label).toBe("Frobnicate (acme)");
    expect(workToolPermission("bash")).toBeNull();
  });

  test("the Work workspace shows only in Work, and nowhere while Work is off", () => {
    const work = { preset: "work" };
    const code = { preset: "starter" };
    expect(shownInMode(work, true, "work")).toBe(true);
    expect(shownInMode(code, true, "work")).toBe(false);
    expect(shownInMode(work, true, "code")).toBe(false);
    expect(shownInMode(work, false, "code")).toBe(false);
    expect(shownInMode(work, false, "work")).toBe(false);
    expect(shownInMode(code, false, "code")).toBe(true);
  });

  test("invite links open Join: the server's link and the app's own scheme, token in the fragment", () => {
    expect(workInviteToken("https://api.omnirush.ai/omnirush/work/invite#t=abc123")).toBe("abc123");
    expect(workInviteToken("omnirush://work/invite#t=abc123")).toBe("abc123");
    expect(workInviteToken("omnirush:///work/invite?t=abc123")).toBe("abc123");
    expect(workInviteToken("omnirush://work/invite")).toBeNull();
    expect(workInviteToken("omnirush://connect?token=abc123")).toBeNull();
    expect(workInviteToken("https://evil.example/work/invites#t=abc")).toBeNull();
    expect(workInviteToken("not a url")).toBeNull();
  });

  test("counts read naturally", () => {
    expect(countLabel(1, "record")).toBe("1 record");
    expect(countLabel(0, "record")).toBe("0 records");
    expect(countLabel(1200, "record")).toBe("1,200 records");
  });

  test("Cmd/Ctrl+Shift+K switches mode; Cmd/Ctrl+K stays the command palette", () => {
    const key = { key: "K", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
    expect(isWorkModeShortcut(key, true)).toBe(true);
    expect(isWorkModeShortcut(key, false)).toBe(false);
    expect(isWorkModeShortcut({ ...key, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isWorkModeShortcut({ ...key, shiftKey: false }, true)).toBe(false);
  });

  test("the toggle marks the current mode", () => {
    const markup = renderToStaticMarkup(<WorkModeToggle mode="work" onChange={noop} shortcut="⌘⇧K" />);
    expect(markup).toContain('data-app-mode="work"');
    expect(markup).toMatch(/aria-checked="true"[^>]*data-app-mode-option="work"/);
    expect(markup).toMatch(/aria-checked="false"[^>]*data-app-mode-option="code"/);
  });

  test("the composer Connectors chip shows in a Work chat (icons + count, or Connect tools) and not in Code", () => {
    const client = { baseUrl: "http://chip.test" } as never;
    const chip = (workChat: boolean, rows: OmniRushWorkConnector[]) => {
      const queries = new QueryClient();
      queries.setQueryData(workConnectorsKey(client), rows);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><MemoryRouter><WorkConnectorsChip workChat={workChat} client={client} /></MemoryRouter></QueryClientProvider>);
    };
    const linked = [row({ status: "connected" }), row({ id: "slack", label: "Slack", status: "syncing" }), row({ id: "notion", label: "Notion" })];
    const work = chip(true, linked);
    expect(work).toContain('data-testid="work-connectors-chip"');
    expect(work).toContain('aria-label="2 connectors"');
    expect(work).toContain('data-connector-icon="google"');
    expect(work).toContain('data-connector-icon="slack"');
    expect(work).not.toContain('data-connector-icon="notion"');
    expect(chip(true, [row({})])).toContain("Connect tools");
    expect(chip(false, linked)).toBe("");
    // A chat's path also starts with "/work" (/workspace/...): only the Work home itself is not a chat to go back to.
    expect(connectorsBackState("/work")).toBeUndefined();
    expect(connectorsBackState("/workspace/ws_1/session/ses_1", "?x=1")).toEqual({ state: { from: "/workspace/ws_1/session/ses_1?x=1" } });
  });

  test("the home asks what to get done, has no card grid, and centres the composer with the starter chips under it", () => {
    const markup = renderToStaticMarkup(<WorkHome composer={<div data-testid="composer-slot" />} onStart={async () => {}} starters={[{ title: "Overdue invoices", prompt: "List overdue invoices." }, { title: "Reply to leads", prompt: "x" }, { title: "Weekly summary", prompt: "y" }, { title: "Fourth", prompt: "z" }]} badge={<span data-testid="badge-slot" />} />);
    expect(markup).toContain("What do you want to get done?");
    expect(markup).toContain('data-testid="composer-slot"');
    expect(markup).toContain('data-testid="badge-slot"');
    expect(markup).not.toContain("data-work-template");
    // A 640 column between two equal spacers, with the chat composer's gutters and bottom spacing (composer.tsx), so
    // a send glides it into the chat's place.
    expect(markup).toContain("lg:px-8");
    expect(markup).toContain("max-w-[640px]");
    expect(markup).toContain("pb-[max(0.5rem,");
    expect(markup.match(/data-work-starter=/g)?.length).toBe(3);
    expect(markup.indexOf("composer-slot")).toBeLessThan(markup.indexOf("data-work-starter"));
    expect(renderToStaticMarkup(<WorkHome composer={null} onStart={async () => {}} />)).not.toContain("work-starters");
    // With Today the feed scrolls and the composer stays in the chat's place, starters just above it.
    const today = renderToStaticMarkup(<WorkHome composer={<div data-testid="composer-slot" />} onStart={async () => {}} starters={[{ title: "Overdue invoices", prompt: "x" }]} today={<div data-testid="today-slot" />} />);
    expect(today).toContain("max-w-[800px]");
    expect(today.indexOf("today-slot")).toBeLessThan(today.indexOf("data-work-starter"));
    expect(today.indexOf("data-work-starter")).toBeLessThan(today.indexOf("composer-slot"));
  });

  test("first run: domain from a work e-mail, recommended sources first, checklist, sample data", () => {
    expect(domainFromEmail("dana@Acme-Bakery.test")).toBe("acme-bakery.test");
    expect(domainFromEmail("someone@gmail.com")).toBe("");
    expect(domainFromEmail(null)).toBe("");
    const rows = [row({ id: "google" }), row({ id: "slack", label: "Slack" }), row({ id: "hubspot", label: "HubSpot" }), row({ id: "demo", label: "Sample", status: "connected" }), row({ id: "mock" })];
    expect(connectOrder(rows, ["hubspot", "slack"]).map((item) => item.id)).toEqual(["hubspot", "slack", "google"]);
    expect(visibleConnectors(rows).map((item) => item.id)).not.toContain("demo");
    expect(hasSampleData({ done: true, sample_data: true })).toBe(true);
    expect(hasSampleData({ done: true, sample_data: false })).toBe(false);
    expect(hasSampleData(undefined)).toBe(false);
    expect(checklistItems({ done: false, org: { id: "o1", name: "Acme" }, steps: { first_chat: false }, sample_data: true }, rows).map((item) => [item.id, item.done])).toEqual([["company", true], ["connected", true], ["first_chat", false]]);
    expect(checklistItems({ done: false, org: { id: "o1", name: "Acme" } }, rows).find((item) => item.id === "connected")?.done).toBe(false);
    expect(checklistItems(undefined, [row({})]).every((item) => !item.done)).toBe(true);
  });

  test("onboarding opens on the company step with the domain prefilled and the offered tools as chips", () => {
    const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><WorkOnboarding client={null} email="ops@acme-bakery.test" sources={["google", "slack", "demo", "mock"]} openLink={noop} onDone={noop} /></QueryClientProvider>);
    expect(markup).toContain('data-step="company"');
    expect(markup).toContain("Step 1 of 2");
    expect(markup).toContain('value="acme-bakery.test"');
    expect(markup).toContain('data-testid="work-onboarding-tool-google"');
    expect(markup).toContain('data-testid="work-onboarding-tool-slack"');
    expect(markup).not.toContain("work-onboarding-tool-demo");
    expect(markup).not.toContain("work-onboarding-tool-mock");
    expect(markup).not.toMatch(/consent|terms/i);
    expect(markup).toContain('data-testid="work-join-link"');
    expect(markup).toContain(">Just me<");
    expect(markup).toContain('data-testid="work-trust-badge"');
    expect(markup).toContain(">In progress<");
    expect(markup).toContain('aria-label="SOC 2 Type II audit in progress"');
    expect(markup).toContain("How we protect your data");
  });

  test("Try Work and the sample-data badge", () => {
    expect(renderToStaticMarkup(<WorkTryButton onTry={async () => {}} />)).toContain("Try Work");
    const badge = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><SampleDataBadge client={null} /></QueryClientProvider>);
    expect(badge).toContain("Sample data");
    expect(badge).toContain('data-testid="work-sample-data-remove"');
  });

  test("connectors: unavailable sources are hidden; a connect settles on connected, syncing or error", () => {
    const rows = [row({ id: "google" }), row({ id: "notion", status: "unavailable" }), row({ id: "slack", status: "syncing" })];
    expect(visibleConnectors(rows).map((item) => item.id)).toEqual(["google", "slack"]);
    expect(connectSettled(rows, "google")).toBe(false);
    expect(connectSettled(rows, "slack")).toBe(true);
    expect(connectSettled([row({ status: "error", error: "reconnect_required" })], "google")).toBe(true);
  });

  test("a connected source shows its account, records, last sync, sync switch and Disconnect", () => {
    const markup = renderToStaticMarkup(
      <ConnectorRow connector={row({ status: "connected", account: "ops@example.com", records: 1234, last_sync_at: "2026-11-09T10:00:00Z", sync_enabled: true })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />,
    );
    expect(markup).toContain("Connected");
    expect(markup).toContain("ops@example.com");
    expect(markup).toContain("records");
    expect(markup).toContain("Last sync");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain("Disconnect");
  });

  test("a source needing a new sign-in offers Reconnect; a disconnected one offers Connect and no switch", () => {
    const error = renderToStaticMarkup(<ConnectorRow connector={row({ status: "error", error: "reconnect_required" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(error).toContain("Sign-in expired");
    expect(error).toContain("Reconnect");
    const off = renderToStaticMarkup(<ConnectorRow connector={row({})} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(off).toContain(">Connect<");
    expect(off).not.toContain('role="switch"');
  });

  test("an errored source offers Reconnect and Disconnect; Check shows missing scopes with a Reconnect prompt", () => {
    const error = renderToStaticMarkup(<ConnectorRow connector={row({ status: "error", error: "reconnect_required" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} onCheck={noop} />);
    expect(error).toContain(">Reconnect<");
    expect(error).toContain(">Disconnect<");
    expect(error).toContain(">Check<");
    const scopes = renderToStaticMarkup(
      <ConnectorRow connector={row({ id: "jira", label: "Jira", status: "connected", records: 3, sync_enabled: true })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} onCheck={noop}
        health={{ id: "jira", token_ok: true, scopes_ok: false, missing_scopes: ["write:jira-work"] }} />,
    );
    expect(scopes).toContain("Missing permissions: write:jira-work");
    expect(scopes).toContain(">Reconnect<");
    const fine = renderToStaticMarkup(
      <ConnectorRow connector={row({ status: "connected" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} onCheck={noop} health={{ id: "google", token_ok: true, scopes_ok: true, checks: [{ name: "profile", ok: true }] }} />,
    );
    expect(fine).toContain("All checks passed.");
    expect(fine).not.toContain(">Reconnect<");
  });

  test("health answers: a list or {sources}; a failed check or last error is the line shown", () => {
    expect(healthFor({ sources: [{ id: "slack", last_error: "rate_limited" }] }, "slack")?.last_error).toBe("rate_limited");
    expect(healthFor([{ id: "slack" }], "google")).toBeNull();
    expect(healthProblem({ id: "x", checks: [{ name: "profile", ok: false, detail: "401" }] })).toEqual({ text: "profile: 401", reconnect: false });
    expect(healthProblem({ id: "x", checks: [{ name: "sync", ok: false, detail: "provider_error" }] })?.text).toBe("Sync: The service returned an error. Sync retries on its own.");
    expect(healthProblem({ id: "x", checks: [{ name: "sync", ok: false, detail: "sync off" }] })?.text).toBe("Sync: sync off");
    expect(healthProblem({ id: "x", token_ok: false })?.reconnect).toBe(true);
    // A failing token is the reason even when the scopes are reported not ok with it (none named missing).
    expect(healthProblem({ id: "x", token_ok: false, scopes_ok: false, missing_scopes: [] })?.text).toBe("Sign-in expired or revoked. Reconnect.");
    expect(healthProblem({ id: "x", token_ok: true, scopes_ok: false })?.text).toBe("Missing permissions. Reconnect to grant them.");
    expect(healthProblem({ id: "x", token_ok: false, missing_scopes: ["chat:read"] })?.text).toBe("Missing permissions: chat:read. Reconnect to grant them.");
    expect(healthProblem({ id: "x", last_error: "KeyError" })?.text).not.toContain("KeyError");
    expect(healthProblem({ id: "x", last_error: "rate_limited" })?.text).toContain("slow down");
    expect(healthProblem({ id: "x", token_ok: true, scopes_ok: true })).toBeNull();
  });

  test("errors read as words: known codes get their sentence, internal names never show", () => {
    const sync = renderToStaticMarkup(<ConnectorRow connector={row({ status: "error", error: "KeyError" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(sync).not.toContain("KeyError");
    expect(sync).toContain("Sync stopped after repeated errors");
    expect(workErrorText("provider_unreachable")).toContain("could not be reached");
  });

  test("a source not connected says what the agent may read and do; buttons name their source", () => {
    const off = renderToStaticMarkup(<ConnectorRow connector={row({ id: "slack", label: "Slack" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(off).toContain(CONNECTOR_ACCESS.slack);
    expect(off).toContain('aria-label="Connect Slack"');
    for (const id of ["google", "microsoft", "slack", "hubspot", "quickbooks", "notion", "jira", "confluence", "linear", "github"]) expect(CONNECTOR_ACCESS[id]).toContain("after you approve");
  });

  test("GitHub with its install link: Choose repositories, and a hint while nothing is visible", () => {
    const github = (records: number) => renderToStaticMarkup(
      <ConnectorRow connector={row({ id: "github", label: "GitHub", status: "connected", records, sync_enabled: true, setup_url: "https://github.com/apps/x/installations/new" })}
        connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} onSetup={noop} />,
    );
    expect(github(0)).toContain(">Choose repositories<");
    expect(github(0)).toContain('data-testid="work-connector-setup-hint"');
    expect(github(12)).toContain(">Choose repositories<");
    expect(github(12)).not.toContain('data-testid="work-connector-setup-hint"');
  });

  test("new connectors get their icon, an unknown id the generic one", () => {
    for (const id of ["jira", "confluence", "linear", "github"]) expect(renderToStaticMarkup(<ConnectorIcon id={id} />)).toContain(`data-connector-icon="${id}"`);
    expect(renderToStaticMarkup(<ConnectorIcon id="zendesk" />)).toContain('data-connector-icon="generic"');
    expect(renderToStaticMarkup(<ConnectorRow connector={row({ id: "zendesk", label: "" })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />)).toContain(">zendesk<");
  });

  test("an entity shows keys, sources, remembered facts (retired hidden), a timeline newest first and related entities", () => {
    const markup = renderToStaticMarkup(
      <EntityDetail
        busy={false} openLink={noop} onAsk={noop} onSelect={noop} onAddFact={noop} onSaveFact={noop} onRetireFact={noop}
        detail={{
          entity: { id: "ent_1", kind: "company", name: "Acme Bakery", keys: ["acme-bakery.test", "hubspot:company:77"], record_count: 12, sources: ["google", "hubspot"], last_activity_at: "2026-11-08T10:00:00Z" },
          records: [
            { source_id: "gmail:old", source: "google", kind: "email", subject: "Old quote", occurred_at: "2026-10-01T10:00:00Z", actors: [{ name: "Dana" }] },
            { source_id: "hubspot:deal:9", source: "hubspot", kind: "deal", subject: "Catering 2027", occurred_at: "2026-11-08T10:00:00Z", actors: ["sales@acme.test"], url: "https://app.hubspot.example/deal/9" },
          ],
          facts: [
            { id: "f1", kind: "policy", text: "Never discount more than 10%.", status: "active", created_by: "user" },
            { id: "f2", kind: "fact", text: "Old address", status: "retired" },
          ],
          related: [{ id: "ent_2", kind: "person", name: "Dana Lee", reason: "email" }],
        }}
      />,
    );
    expect(markup).toContain("Acme Bakery");
    expect(markup).toContain("acme-bakery.test");
    expect(keyLabel("email:ann@acme.test")).toBe("ann@acme.test");
    expect(keyLabel("domain:acme.test")).toBe("acme.test");
    expect(keyLabel("hubspot:company:77")).toBe("hubspot:company:77");
    expect(markup).toContain("Never discount more than 10%.");
    expect(markup).not.toContain("Old address");
    expect(markup).toContain(">Retire<");
    expect(markup.indexOf("Catering 2027")).toBeLessThan(markup.indexOf("Old quote"));
    expect(markup).toContain('aria-label="Open at the source"');
    expect(markup).toContain('data-work-related="ent_2"');
    expect(markup).toContain("Ask about this");
    expect(actorNames([{ name: "Dana" }, { email: "x@y.test" }, "Sam", 5])).toBe("Dana, x@y.test, Sam");
  });

  test("Ask about this briefs the chat through work_context on that entity", () => {
    const prompt = askAboutPrompt({ id: "ent_1", kind: "company", name: "Acme Bakery" });
    expect(prompt).toContain("work_context");
    expect(prompt).toContain("Acme Bakery");
    expect(prompt).toContain("ent_1");
  });
});

describe("Work Today, connectors attention, organization, tools (Addendum C)", () => {
  const feed: OmniRushWorkFeed = {
    generated_at: "2026-11-15T09:00:00Z",
    sources: [
      { id: "github", label: "GitHub", status: "error", attention: { kind: "failing", message: "GitHub sync keeps failing.", action: "retry", since: null } },
      { id: "google", label: "Google", status: "connected", attention: { kind: "reconnect", message: "Google needs reconnecting.", action: "reconnect", since: null } },
      { id: "notion", label: "Notion", status: "connected", attention: { kind: "coverage", message: "Notion sees 1 page.", action: "setup", since: null } },
      { id: "slack", label: "Slack", status: "syncing", attention: null },
    ],
    groups: {
      needs_you: [{ id: "github:pr:12", source: "github", kind: "pull_request", title: "Fix invoice rounding", who: "Dana", at: "2026-11-15T08:00:00Z", url: "https://github.test/pr/12", reason: "Review requested" }],
      today: [{ id: "calendar:e1", source: "google", kind: "event", title: "Supplier call", at: null, starts_at: "2026-11-15T14:00:00Z", url: null, reason: null }],
      fyi: [],
    },
  };

  test("source chips: one row, a dot per state and a filter each; fixes sit in the attention line", () => {
    expect(sourceDot(feed.sources[0]!)).toBe("error");
    expect(sourceDot(feed.sources[2]!)).toBe("attention");
    expect(sourceDot(feed.sources[3]!)).toBe("syncing");
    expect(sourceDot({ status: "connected", attention: null })).toBe("ok");
    const strip = renderToStaticMarkup(<SourceStrip sources={feed.sources} selected={null} onSelect={noop} onAdd={noop} />);
    expect(strip).toMatch(/data-work-source="github"[^>]*data-dot="error"/);
    expect(strip).toMatch(/data-work-source="github"[^>]*data-feed-filter="github"/);
    expect(strip).toContain('data-feed-filter="all"');
    expect(strip).toContain('data-testid="work-source-add"');
    expect(strip).not.toContain(">Retry<");
    expect(strip).not.toContain(">Reconnect<");
    const attention = renderToStaticMarkup(<SourceAttention sources={feed.sources} busy={null} onReconnect={noop} onRetry={noop} onSetup={noop} />);
    expect(attention).toContain('data-testid="work-source-attention"');
    expect(attention).toContain(">Retry<");
    expect(attention).toContain(">Reconnect<");
    expect(attention).toContain(">Fix<");
  });

  test("Today: three sections with counts, rows with reason, Open only with a link, Ask about this; skeleton while loading", () => {
    const client = { baseUrl: "http://today.test" } as never;
    const render = (data?: OmniRushWorkFeed) => {
      const queries = new QueryClient();
      if (data) queries.setQueryData(workFeedKey(client, null), data);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkToday client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} /></QueryClientProvider>);
    };
    const markup = render(feed);
    expect(markup.match(/data-feed-section=/g)?.length).toBe(3);
    expect(markup).toContain("Needs you");
    expect(markup).toContain("Review requested");
    expect(markup).toContain('aria-label="Open Fix invoice rounding"');
    expect(markup).not.toContain('aria-label="Open Supplier call"');
    expect(markup.match(/aria-label="Ask about /g)?.length).toBe(2);
    expect(markup).toContain('data-testid="work-source-strip"');
    expect(markup).toContain("Nothing new in the last 7 days.");
    expect(render()).not.toContain('data-testid="work-feed"');
    expect(markup).not.toMatch(/—|farm|stock/i);
    const prompt = askAboutItemPrompt(feed.groups.needs_you[0]!);
    expect(prompt).toContain("Fix invoice rounding");
    expect(prompt).toContain("github:pr:12");
  });

  test("the home shows Today in place of the empty column once something is connected", () => {
    const home = renderToStaticMarkup(<WorkHome composer={<div data-testid="composer-slot" />} onStart={async () => {}} today={<div data-testid="today-slot" />} onConnect={noop} />);
    expect(home).toContain("today-slot");
    expect(home).not.toContain("What do you want to get done?");
    expect(home.indexOf("today-slot")).toBeLessThan(home.indexOf("composer-slot"));
    const empty = renderToStaticMarkup(<WorkHome composer={null} onStart={async () => {}} onConnect={noop} />);
    expect(empty).toContain('data-testid="work-home-connect"');
    // Sources still loading: the composer waits in the chat's place, so it does not jump when Today arrives.
    const pending = renderToStaticMarkup(<WorkHome composer={<div data-testid="composer-slot" />} onStart={async () => {}} pending onConnect={noop} />);
    expect(pending).not.toContain("work-home-connect");
    expect(pending).not.toContain("What do you want to get done?");
    expect(pending).toContain("max-w-[800px]");
    expect(pending.indexOf('data-testid="work-home-column"')).toBeLessThan(pending.indexOf("composer-slot"));
  });

  test("relative times read short", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(relativeTime("2026-11-15T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-11-15T14:00:00Z", now)).toBe("in 2 h");
    expect(relativeTime("2026-11-14T08:00:00Z", now)).toBe("Yesterday");
    expect(relativeTime(null, now)).toBe("");
  });

  test("connectors: attention message and its button, coverage by kind, skipped records", () => {
    expect(coverageLine({ records: 2566, by_kind: { file: 573, email: 1992, event: 1, match: 0 } })).toBe("1,992 emails · 573 files · 1 event");
    expect(coverageLine(null)).toBeNull();
    const failing = renderToStaticMarkup(<ConnectorRow connector={row({ id: "github", label: "GitHub", status: "error", records: 40, coverage: { records: 40, by_kind: { pull_request: 40 } }, skipped_records: 3, attention: { kind: "failing", message: "GitHub sync keeps failing: a record could not be read.", action: "retry", since: null } })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} onRetry={noop} />);
    expect(failing).toContain("GitHub sync keeps failing");
    expect(failing).toContain(">Retry sync<");
    expect(failing).not.toContain(">Reconnect<");
    expect(failing).toContain("40 pull requests");
    expect(failing).toContain("3 items could not be imported and were skipped.");
    const coverage = renderToStaticMarkup(<ConnectorRow connector={row({ id: "notion", label: "Notion", status: "connected", records: 1, setup_url: "https://notion.test/setup", attention: { kind: "coverage", message: "Notion sees 1 page. Share more pages with Omnirush AI.", action: "setup", since: null } })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} onSetup={noop} />);
    expect(coverage).toContain(">Open setup<");
    expect(coverage).toMatch(/data-testid="work-connector-attention" data-kind="coverage"/);
    const reconnect = renderToStaticMarkup(<ConnectorRow connector={row({ status: "connected", attention: { kind: "reconnect", message: "Google needs reconnecting.", action: "reconnect", since: null } })} connecting={false} busy={false} onConnect={noop} onDisconnect={noop} onSync={noop} />);
    expect(reconnect).toContain(">Reconnect<");
    expect(reconnect).toContain("Needs attention");
  });

  test("organization: owner and member views, leave rules", () => {
    const client = { baseUrl: "http://org.test" } as never;
    const members = (you_role: "owner" | "member"): OmniRushWorkMembers => ({
      org: { id: "org_1", name: "Acme Bakery", domain: "acme-bakery.test", size: "11-50", tools: ["google"] },
      you_role,
      members: [
        { user_id: "u1", email: "owner@acme-bakery.test", role: "owner", you: you_role === "owner" },
        { user_id: "u2", email: "dana@acme-bakery.test", role: "member", job_role: "Ops", you: you_role === "member" },
      ],
      invites: [{ id: "inv_1", email: "sam@acme-bakery.test", expires_at: "2026-11-29T00:00:00Z" }],
    });
    const render = (data: OmniRushWorkMembers) => {
      const queries = new QueryClient();
      queries.setQueryData(workMembersKey(client), data);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><MemoryRouter><WorkOrganizationPage client={client} openLink={noop} onBack={noop} /></MemoryRouter></QueryClientProvider>);
    };
    const owner = render(members("owner"));
    expect(owner).toContain('value="Acme Bakery"');
    expect(owner).toContain('data-testid="work-org-save"');
    expect(owner).toContain(">Make owner<");
    expect(owner).toContain(">Remove<");
    expect(owner).toContain('data-work-invite="inv_1"');
    expect(owner).toContain(">Cancel<");
    expect(owner).toContain("Make someone else the owner before you leave.");
    expect(owner).toContain('data-testid="work-org-security"');
    expect(owner).toContain(">Trust page<");
    const member = render(members("member"));
    expect(member).not.toContain('data-testid="work-org-save"');
    expect(member).not.toContain(">Make owner<");
    expect(member).toContain('data-testid="work-org-me-save"');
    expect(member).toContain("Only the owner can change these.");
    expect(leaveState({ you_role: "owner", members: [{ user_id: "u1", email: "a", role: "owner", you: true }] }).message).toContain("deleted");
    expect(leaveState(members("member")).blocked).toBe(false);
  });

  test("Work tool notices: from the kept MCP result or the output text, Work tools only, each once", () => {
    expect(workToolNotices({ toolName: "omnirush-work_work_search", output: '{"items":[],"notices":["Google needs reconnecting in Work > Connectors."]}' })).toEqual(["Google needs reconnecting in Work > Connectors."]);
    expect(workToolNotices({ toolName: "omnirush-work_gmail_search", callProviderMetadata: { omnirush: { mcpResult: { content: [{ type: "text", text: "{}" }], notices: ["A", "A"] } } } })).toEqual(["A"]);
    expect(workToolNotices({ toolName: "omnirush-work_gmail_search", output: { content: [{ type: "text", text: '{"notices":["B"]}' }] } })).toEqual(["B"]);
    expect(workToolNotices({ toolName: "bash", output: '{"notices":["x"]}' })).toEqual([]);
    expect(workToolNotices({ toolName: "omnirush-work_work_search", output: "plain text" })).toEqual([]);
    expect(renderToStaticMarkup(<WorkToolNotices notices={["Google needs reconnecting."]} />)).toContain("Google needs reconnecting.");
  });

  test("the tools banner shows only in a Work chat whose engine lacks the Work tools", () => {
    const client = { baseUrl: "http://tools.test" } as never;
    const render = (workChat: boolean, attached: boolean) => {
      const queries = new QueryClient();
      queries.setQueryData(workChatToolsKey(client), { attached, reason: attached ? null : "Work tools were not added to this chat." });
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkToolsBanner workChat={workChat} client={client} /></QueryClientProvider>);
    };
    expect(render(true, false)).toContain("Work tools aren&#x27;t connected in this chat");
    expect(render(true, false)).toContain('data-testid="work-tools-fix"');
    expect(render(true, true)).toBe("");
    expect(render(false, false)).toBe("");
  });
});
