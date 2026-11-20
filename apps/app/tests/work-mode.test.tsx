import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { matchRoutes, MemoryRouter } from "react-router";

import { OmniRushServerError, type OmniRushWorkAction, type OmniRushWorkConnector, type OmniRushWorkFeed, type OmniRushWorkMembers } from "../src/app/lib/omnirush-server";
import { askAboutPrompt, checklistItems, connectorAccess, connectOrder, connectSettled, connectorsBackState, countLabel, domainFromEmail, hasSampleData, healthFor, healthProblem, isWorkModeShortcut, keyLabel, shownInMode, visibleConnectors, workConnectorsKey, workErrorText, workInviteToken, workToolPermission,
  askAboutItemPrompt, coverageLine, relativeTime, workActionsKey, workChatToolsKey, workFailure, workFeedKey, workInsightsKey, workMembersKey, workSettingsKey, workStateKey, workToolNotices,
  WORK_ACTIVITY_ROUTE, WORK_CONNECTORS_ROUTE, WORK_DEALS_ROUTE, WORK_HOME_ROUTE, WORK_INSIGHTS_ROUTE, WORK_KNOWLEDGE_ROUTE, WORK_MEETINGS_ROUTE, WORK_ONBOARDING_ROUTE, WORK_ORG_ROUTE, WORK_SEARCH_ROUTE } from "../src/react-app/domains/work/work-mode";
import { SourceAttention, SourceStrip, sourceDot, WorkToday } from "../src/react-app/domains/work/work-today";
import { leaveState, mePatch, WorkOrganizationPage } from "../src/react-app/domains/work/work-org";
import { alertText, WorkInsightsPage } from "../src/react-app/domains/work/work-insights";
import { WorkAutomationPage } from "../src/react-app/domains/work/work-activity";
import { SampleDataBadge, WorkOnboarding, WorkTryButton } from "../src/react-app/domains/work/work-onboarding";
import { ConnectorIcon, ConnectorRow, localChatError, LocalChatsCard, WorkConnectorsChip, WorkConnectorsPage, WorkHome, WorkModeToggle, WorkToolNotices, WorkToolsBanner } from "../src/react-app/domains/work/work-views";
import { actorNames, EntityDetail } from "../src/react-app/domains/work/knowledge-views";

const row = (over: Partial<OmniRushWorkConnector>): OmniRushWorkConnector => ({
  id: "google", label: "Google", status: "disconnected", last_sync_at: null, records: 0, sync_enabled: false, ...over,
});
const noop = () => {};
/** A query left in its error state, as a failed read leaves it (and not read again when the page mounts). */
function failQuery(queries: QueryClient, queryKey: readonly unknown[], error: Error) {
  queries.setQueryDefaults([...queryKey], { retryOnMount: false });
  queries.getQueryCache().build(queries, { queryKey: [...queryKey], retry: false }).setState({ status: "error", error, fetchStatus: "idle", errorUpdatedAt: 1 });
}

describe("Work mode", () => {
  test("every Work page has a route in the app (none falls through to the catch-all)", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-root.tsx", import.meta.url), "utf8");
    const routes = [...source.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => ({ path: match[1]! }));
    expect(routes.some((route) => route.path === "*")).toBe(true);
    for (const path of [WORK_HOME_ROUTE, WORK_CONNECTORS_ROUTE, WORK_KNOWLEDGE_ROUTE, WORK_ONBOARDING_ROUTE, WORK_ORG_ROUTE, WORK_INSIGHTS_ROUTE, WORK_ACTIVITY_ROUTE, WORK_SEARCH_ROUTE, WORK_DEALS_ROUTE, WORK_MEETINGS_ROUTE]) {
      expect(matchRoutes(routes, path)?.[0]?.route.path ?? "none").not.toBe("*");
    }
  });

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
    expect(countLabel(1, "work.count.records")).toBe("1 record");
    expect(countLabel(0, "work.count.records")).toBe("0 records");
    expect(countLabel(1200, "work.count.records")).toBe("1,200 records");
  });

  test("Cmd/Ctrl+Shift+K switches mode (Cmd/Ctrl+K is Search inside Work, the command palette in Code)", () => {
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
    // An import source has no sign-in: onboarding offers no Connect for it (Connectors has its import card).
    expect(connectOrder([...rows, row({ id: "whatsapp", label: "WhatsApp", mode: "import" })], ["whatsapp"]).map((item) => item.id)).toEqual(["google", "slack", "hubspot"]);
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
    expect(off).toContain(connectorAccess("slack"));
    expect(off).toContain('aria-label="Connect Slack"');
    for (const id of ["google", "microsoft", "slack", "hubspot", "quickbooks", "notion", "jira", "confluence", "linear", "github"]) expect(connectorAccess(id)).toContain("after you approve");
    expect(connectorAccess("zendesk")).toContain("asks you before");
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
  const files = Array.from({ length: 8 }, (_, i) => ({ id: `github:file:${i}`, source: "github", kind: "file", title: `acme/api/docs/rule${i}.md`, at: "2026-11-15T08:00:00Z", url: `https://github.test/f/${i}`, reason: "Edited" }));

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
    expect(strip).toMatch(/data-feed-filter="all"[^>]*class="[^"]*bg-muted/);
    // One source: nothing to filter, so no All and no radios, but its status dot and Add stay.
    const solo = renderToStaticMarkup(<SourceStrip sources={[feed.sources[3]!]} selected={null} onSelect={noop} onAdd={noop} />);
    expect(solo).toMatch(/data-work-source="slack"[^>]*data-dot="syncing"/);
    expect(solo).toContain('data-testid="work-source-add"');
    expect(solo).not.toContain('data-feed-filter="all"');
    expect(solo).not.toContain('role="radio');
    expect(renderToStaticMarkup(<SourceStrip sources={[{ ...feed.sources[1]!, label: "Google (Gmail, Drive, Calendar)" }]} selected={null} onSelect={noop} onAdd={noop} />)).toContain(">Google<");
    // Three sources need a fix: one summary line with Review, the per-source rows folded away.
    const attention = renderToStaticMarkup(<SourceAttention sources={feed.sources} busy={null} onReconnect={noop} onRetry={noop} onSetup={noop} />);
    expect(attention).toContain('data-testid="work-source-attention"');
    expect(attention).toContain("3 connections need attention");
    expect(attention).toMatch(/aria-expanded="false"[^>]*>Review</);
    expect(attention).not.toContain("aria-controls="); // only points at the rows once they render
    expect(attention).not.toContain("data-work-attention=");
    expect(attention).not.toContain(">Retry<");
    // Exactly one: its row and button as is, no summary.
    const single = renderToStaticMarkup(<SourceAttention sources={[feed.sources[0]!, feed.sources[3]!]} busy={null} onReconnect={noop} onRetry={noop} onSetup={noop} />);
    expect(single).toContain('data-work-attention="github"');
    expect(single).toContain(">Retry<");
    expect(single).not.toContain('data-testid="work-attention-summary"');
    expect(renderToStaticMarkup(<SourceAttention sources={[feed.sources[3]!]} busy={null} onReconnect={noop} onRetry={noop} onSetup={noop} />)).toBe("");
  });

  test("Today: non-empty sections with counts, rows with reason, Open only with a link, Ask about this; skeleton while loading", () => {
    const client = { baseUrl: "http://today.test" } as never;
    const render = (data?: OmniRushWorkFeed) => {
      const queries = new QueryClient();
      if (data) queries.setQueryData(workFeedKey(client, null), data);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkToday client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} /></QueryClientProvider>);
    };
    const markup = render(feed);
    expect(markup.match(/data-feed-section=/g)?.length).toBe(2);
    expect(markup).not.toContain('data-feed-section="fyi"');
    expect(markup).not.toContain('data-testid="work-feed-clear"');
    expect(markup).toContain("Needs you");
    expect(markup).toMatch(/data-testid="work-feed-reason">Review requested</);
    expect(markup).toContain('aria-label="Open Fix invoice rounding"');
    expect(markup).not.toContain('aria-label="Open Supplier call"');
    expect(markup.match(/aria-label="Ask about /g)?.length).toBe(2);
    // Ask takes the reason's place on hover or keyboard focus, so it stays reachable without a reserved column.
    expect(markup).toContain("group-focus-within:opacity-100");
    expect(markup).toContain("group-focus-within:opacity-0");
    expect(markup).toContain('data-testid="work-source-strip"');
    expect(markup.indexOf('data-testid="work-source-attention"')).toBeLessThan(markup.indexOf('data-testid="work-source-strip"'));
    expect(render()).not.toContain('data-testid="work-feed"');
    // Nothing anywhere and every source fine: one quiet line, no empty sections.
    const healthy = [feed.sources[2]!, { ...feed.sources[3]!, status: "connected" as const }];
    const clear = render({ ...feed, sources: healthy, groups: { needs_you: [], today: [], fyi: [] } });
    expect(clear).toContain("Nothing needs you today.");
    expect(clear).not.toContain("data-feed-section=");
    // A source still on its first import: no all-clear yet, a quiet line instead.
    const importing = render({ ...feed, sources: [feed.sources[2]!, feed.sources[3]!], groups: { needs_you: [], today: [], fyi: [] } });
    expect(importing).not.toContain('data-testid="work-feed-clear"');
    expect(importing).toContain('data-testid="work-feed-importing"');
    // A long title ends before Ask while Ask shows.
    expect(markup).toContain("group-hover:pr-[4.5rem]");
    // A source to reconnect or retry may be holding things back: no all-clear then.
    const blocked = render({ ...feed, groups: { needs_you: [], today: [], fyi: [] } });
    expect(blocked).not.toContain('data-testid="work-feed-clear"');
    // ...and never a blank feed: say the fixes come first.
    expect(blocked).toContain("Nothing to show until the connections above are fixed.");
    expect(render({ ...feed, groups: { needs_you: [], today: [], fyi: [feed.groups.needs_you[0]!] } })).not.toContain('data-testid="work-feed-blocked"');
    // One source: its pill (dot) and Add stay, nothing to filter.
    const one = render({ ...feed, sources: [feed.sources[3]!] });
    expect(one).toContain('data-testid="work-source-add"');
    expect(one).toContain('data-dot="syncing"');
    expect(one).not.toContain('data-feed-filter="all"');
    // Recent: 5 rows, then Show N more; a GitHub file reads as its name with repo/folder in the meta line.
    const recent = render({ ...feed, sources: healthy, groups: { needs_you: [], today: [], fyi: files } });
    expect(recent).toContain("Nothing needs you today.");
    expect(recent).toContain('data-feed-section="fyi"');
    expect(recent).toContain(">Recent<");
    expect(recent).not.toContain('data-testid="work-feed-count"');
    expect(recent.match(/data-feed-item=/g)?.length).toBe(5);
    expect(recent).toMatch(/aria-expanded="false"[^>]*>Show 3 more</);
    expect(recent).toContain('title="acme/api/docs/rule0.md">rule0.md<');
    expect(recent).toContain(" · api/docs<");
    expect(recent).toContain('aria-label="Open acme/api/docs/rule0.md"');
    // "Edited" on every Recent row says nothing; a reason that differs stays.
    expect(recent).not.toContain('data-testid="work-feed-reason"');
    expect(render({ ...feed, groups: { needs_you: [], today: [], fyi: [...files.slice(0, 2), { ...files[2]!, reason: "Mentioned you" }] } })).toContain(">Mentioned you<");
    // A Drive file name may hold "/": it stays whole.
    const drive = render({ ...feed, groups: { needs_you: [], today: [], fyi: [{ id: "google:file:1", source: "google", kind: "file", title: "Budget 2026/27", at: "2026-11-15T08:00:00Z", url: "https://drive.test/1", reason: "Edited" }] } });
    expect(drive).toContain('title="Budget 2026/27">Budget 2026/27<');
    expect(render({ ...feed, groups: { needs_you: [], today: [], fyi: files.slice(0, 5) } })).not.toContain('data-testid="work-feed-more"');
    // Every section is capped, not only Recent: Needs you keeps its count.
    const busy = render({ ...feed, groups: { needs_you: files, today: [], fyi: [] } });
    expect(busy.match(/data-feed-item=/g)?.length).toBe(5);
    expect(busy).toMatch(/data-testid="work-feed-count">8</);
    expect(busy).toMatch(/aria-expanded="false"[^>]*>Show 3 more</);
    expect(markup).not.toMatch(/—|farm|stock/i);
    const prompt = askAboutItemPrompt(feed.groups.needs_you[0]!);
    expect(prompt).toContain("Fix invoice rounding");
    expect(prompt).toContain("github:pr:12");
  });

  test("Today: Review opens the fixes, Show more opens Recent, a source filter folds it back", async () => {
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const data = { ...feed, groups: { needs_you: [], today: [], fyi: files } };
      let slackGone = false;
      const client = { baseUrl: "http://today.test", getWorkFeed: async (query: { source?: string }) => (query.source === "slack"
        ? { ...data, sources: slackGone ? data.sources.filter((source) => source.id !== "slack") : data.sources, groups: { needs_you: [], today: [], fyi: [] } }
        : data) } as never;
      const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
      queries.setQueryData(workFeedKey(client, null), data);
      document.body.innerHTML = '<div id="root"></div>';
      const root = createRoot(document.getElementById("root")!);
      await act(async () => root.render(<QueryClientProvider client={queries}><WorkToday client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} /></QueryClientProvider>));
      const rows = () => document.querySelectorAll("[data-feed-item]").length;
      const review = [...document.querySelectorAll("button")].find((button) => button.textContent === "Review")!;
      expect(document.querySelectorAll("[data-work-attention]").length).toBe(0);
      await act(async () => review.click());
      expect(review.getAttribute("aria-expanded")).toBe("true");
      expect(review.textContent).toBe("Hide");
      expect(document.getElementById(review.getAttribute("aria-controls")!)?.querySelectorAll("[data-work-attention]").length).toBe(3);
      const more = document.querySelector<HTMLButtonElement>('[data-testid="work-feed-more"]')!;
      expect(rows()).toBe(5);
      await act(async () => more.click());
      expect(rows()).toBe(8);
      expect(more.textContent).toBe("Show less");
      await act(async () => document.querySelector<HTMLButtonElement>('[data-feed-filter="github"]')!.click());
      expect(rows()).toBe(5);
      expect(document.querySelector('[data-testid="work-feed-more"]')?.textContent).toBe("Show 3 more");
      // Slack is fine (still importing) and empty while GitHub is broken: not "fix the connections above".
      await act(async () => document.querySelector<HTMLButtonElement>('[data-feed-filter="slack"]')!.click());
      expect(document.querySelector('[data-testid="work-feed-blocked"]')).toBeNull();
      expect(document.querySelector('[data-testid="work-feed-importing"]')).not.toBeNull();
      // Slack goes away while picked: the filter goes back to all.
      slackGone = true;
      await act(async () => {
        await queries.refetchQueries({ queryKey: workFeedKey(client, "slack") });
        await new Promise((resolve) => setTimeout(resolve, 0)); // the query's update reaches the view on a timer
      });
      expect(document.querySelector('[data-feed-filter="all"]')?.getAttribute("aria-checked")).toBe("true");
      await act(async () => root.unmount());
      queries.clear();
    } finally {
      if (registered) await GlobalRegistrator.unregister();
    }
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

  test("the tools banner shows only in a Work chat whose engine lacks the Work tools, saying it once", () => {
    const client = { baseUrl: "http://tools.test" } as never;
    const render = (workChat: boolean, attached: boolean, reason: string | null = null) => {
      const queries = new QueryClient();
      queries.setQueryData(workChatToolsKey(client), { attached, reason: attached ? null : reason });
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkToolsBanner workChat={workChat} client={client} /></QueryClientProvider>);
    };
    const banner = render(true, false);
    expect(banner).toContain(">Work tools aren&#x27;t connected<");
    expect(banner).toContain('data-testid="work-tools-fix"');
    expect(banner.match(/<p[ >]/g)?.length).toBe(1);
    // A reason that adds to the title shows under it.
    expect(render(true, false, "Work is off for your account.")).toContain(">Work is off for your account.<");
    expect(render(true, true)).toBe("");
    expect(render(false, false)).toBe("");
    // A Work chat started on Claude never gets the tools: one plain notice, no Fix.
    const claude = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><WorkToolsBanner workChat client={client} claude /></QueryClientProvider>);
    expect(claude).toContain(">Claude can&#x27;t use your Work tools. Pick another model to start a new chat.<");
    expect(claude).not.toContain("work-tools-fix");
    expect(renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><WorkToolsBanner client={client} claude /></QueryClientProvider>)).toBe("");
  });
  test("a failed Work request reads as words, and only a failure that can pass offers Try again", () => {
    const missing = workFailure(new OmniRushServerError(404, "not_found", "Not found"));
    expect(missing).toEqual({ text: "This needs the latest OmniRush. Update and reopen.", retry: false });
    expect(workFailure(new OmniRushServerError(404, "unsupported_work_path", "unsupported_work_path")).retry).toBe(false);
    const refused = workFailure(new OmniRushServerError(422, "bad_arguments", "bad_arguments"));
    expect(refused.text).not.toContain("bad_arguments");
    expect(refused.retry).toBe(false);
    expect(workFailure(new OmniRushServerError(409, "not_undoable", "not_undoable")).text).toBe("This action can no longer be undone.");
    // A code the local server words already keeps its sentence; a bare code or HTTP status text never shows.
    expect(workFailure(new OmniRushServerError(410, "invite_used", "This invite was already used. Ask for a new one.")).text).toBe("This invite was already used. Ask for a new one.");
    expect(workFailure(new OmniRushServerError(400, "odd_code", "odd_code")).text).toBe("That did not work.");
    expect(workFailure(new OmniRushServerError(404, "work_disabled", "work_disabled")).text).toBe("Work is turned off for your account.");
    expect(workFailure(new OmniRushServerError(404, "not_connected", "not_connected")).text).not.toBe(missing.text);
    expect(workFailure(new OmniRushServerError(400, "request_failed", "Bad Request")).text).toBe("That did not work.");
    expect(workFailure(new OmniRushServerError(503, "request_failed", "Service Unavailable"))).toEqual({ text: "Something went wrong. Try again.", retry: true });
    expect(workFailure(new Error("Request timed out."))).toEqual({ text: "Request timed out.", retry: true });
    expect(workFailure(undefined).retry).toBe(true);
  });

  test("Today: a refused feed read shows words and no dead Try again; a server hiccup offers it", () => {
    const client = { baseUrl: "http://today-error.test" } as never;
    const render = (error: Error) => {
      const queries = new QueryClient();
      failQuery(queries, workFeedKey(client, null), error);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkToday client={client} openLink={noop} onAsk={async () => {}} onOpenConnectors={noop} /></QueryClientProvider>);
    };
    const refused = render(new OmniRushServerError(422, "bad_arguments", "bad_arguments"));
    expect(refused).toContain('data-testid="work-feed-error"');
    expect(refused).not.toContain("bad_arguments");
    expect(refused).not.toContain("Try again");
    expect(render(new OmniRushServerError(502, "provider_error", "The service returned an error. Try again."))).toContain("Try again");
  });

  test("organization: a failed read is an error, never 'no company' with Set up; no company is its own state", () => {
    const client = { baseUrl: "http://org-error.test" } as never;
    const render = (setup: (queries: QueryClient) => void) => {
      const queries = new QueryClient();
      setup(queries);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><MemoryRouter><WorkOrganizationPage client={client} openLink={noop} onBack={noop} /></MemoryRouter></QueryClientProvider>);
    };
    const failed = render((queries) => failQuery(queries, workMembersKey(client), new OmniRushServerError(404, "not_found", "Not found")));
    expect(failed).toContain('data-testid="work-org-error"');
    expect(failed).not.toContain('data-testid="work-org-none"');
    expect(failed).not.toContain("Set up your company");
    expect(failed).not.toContain("Try again");
    expect(render((queries) => failQuery(queries, workMembersKey(client), new Error("Request timed out.")))).toContain("Try again");
    const none = render((queries) => queries.setQueryData(workMembersKey(client), { org: null, members: [], invites: [] }));
    expect(none).toContain('data-testid="work-org-none"');
    expect(none).toContain("Set up your company");
  });

  test("organization: an owner's tools are the company's (no second picker); Save waits for an edit; a sole owner sees what leaving deletes", () => {
    const client = { baseUrl: "http://org-tools.test" } as never;
    const render = (data: OmniRushWorkMembers) => {
      const queries = new QueryClient();
      queries.setQueryData(workStateKey(client), { enabled: true, sources: ["google", "slack"] });
      queries.setQueryData(workMembersKey(client), data);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><MemoryRouter><WorkOrganizationPage client={client} openLink={noop} onBack={noop} /></MemoryRouter></QueryClientProvider>);
    };
    const org = { id: "org_1", name: "Acme", tools: ["google"] };
    const owner = render({ org, you_role: "owner", members: [{ user_id: "u1", email: "o@acme.test", role: "owner", you: true }], invites: [] });
    expect(owner).not.toContain('data-testid="work-org-my-tools"');
    expect(owner).toMatch(/disabled=""[^>]*data-testid="work-org-save"/);
    expect(owner).toMatch(/disabled=""[^>]*data-testid="work-org-me-save"/);
    expect(owner).toContain("the organization and its pending invites are deleted");
    const member = render({ org, you_role: "member", members: [{ user_id: "u1", email: "o@acme.test", role: "owner" }, { user_id: "u2", email: "m@acme.test", role: "member", you: true }], invites: [] });
    expect(member).toContain('data-testid="work-org-my-tools"');
    // The company's chips are shown, not offered: a member cannot press them.
    expect(member.match(/aria-pressed="(true|false)" disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    // Saving only a role never sends tools: an owner's tools are the company's, and a member's never come back from the server.
    expect(mePatch({ job_role: " Founder " }, { job_role: null })).toEqual({ job_role: "Founder" });
    expect(mePatch({ tools: ["slack"] }, { job_role: "Ops" })).toEqual({ job_role: "Ops", tools: ["slack"] });
  });

  test("insights: alerts in the app's words by kind, roles as labels, a missing route says update with no retry", () => {
    const client = { baseUrl: "http://insights.test" } as never;
    const member = { user_id: "u2", email: "m@acme.test", role: "member", job_role: "Ops", activity: 3, prev_activity: 10, trend: -70, active_days: 1, last_active: null, meetings: 1, by_source: {}, by_kind: {}, focus: [], daily: [{ d: "2026-11-15", n: 3 }], alerts: [{ kind: "drop_off", level: "warn" as const, text: "Activity down 70% vs the previous period" }, { kind: "overdue", level: "serious" as const, text: "2 assigned items overdue" }, { kind: "new_kind", level: "warn" as const, text: "Server words" }] };
    expect(alertText(member.alerts[0]!, member)).toBe("Activity down 70% vs the previous period");
    expect(alertText(member.alerts[1]!, member)).toBe("2 assigned items overdue");
    expect(alertText(member.alerts[2]!, member)).toBe("Server words");
    const render = (setup: (queries: QueryClient) => void) => {
      const queries = new QueryClient();
      setup(queries);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkInsightsPage client={client} onBack={noop} /></QueryClientProvider>);
    };
    const page = render((queries) => queries.setQueryData(workInsightsKey(client, 14), { org: { id: "o", name: "Acme" }, range: { days: 14, from: "", to: "" }, team: { members: 2, active_members: 1, total_activity: 3, meetings: 1, alerts: 2 }, members: [member] }));
    expect(page).toContain("Ops · Member");
    expect(page).not.toContain("—");
    const missing = render((queries) => failQuery(queries, workInsightsKey(client, 14), new OmniRushServerError(404, "not_found", "Not found")));
    expect(missing).toContain("This needs the latest OmniRush.");
    expect(missing).not.toContain("Try again");
  });

  test("automation: the log shows even when the settings read fails; the consent copy promises only what ships", () => {
    const client = { baseUrl: "http://automation.test" } as never;
    const action: OmniRushWorkAction = { id: "a1", source: "slack", tool: "post", target: "#ops", summary: "Posted the weekly summary", result: "done", undoable: true, created_at: "2026-11-15T09:00:00Z", undone_at: null };
    const render = (setup: (queries: QueryClient) => void) => {
      const queries = new QueryClient();
      setup(queries);
      return renderToStaticMarkup(<QueryClientProvider client={queries}><WorkAutomationPage client={client} onBack={noop} /></QueryClientProvider>);
    };
    const failed = render((queries) => {
      failQuery(queries, workSettingsKey(client), new OmniRushServerError(404, "not_found", "Not found"));
      queries.setQueryData(workActionsKey(client), { actions: [action] });
    });
    expect(failed).toContain('data-testid="work-automation-error"');
    expect(failed).toContain('data-action="a1"');
    expect(failed).toContain('data-testid="work-action-undo"');
    const page = render((queries) => {
      queries.setQueryData(workSettingsKey(client), { autopilot: false, full_access: false, writes_paused: false });
      queries.setQueryData(workActionsKey(client), { actions: [] });
    });
    expect(page).toContain('data-testid="work-automation-full-access"');
    expect(page).toContain('data-testid="work-automation-empty"');
    expect(page).not.toMatch(/—|screen|proactive/);
  });

  test("Mac chat sync: errors read plainly, a repeated one is one line; the cards show only in the Mac desktop app", () => {
    expect(localChatError("whatsapp", null, 0)).toBeNull();
    expect(localChatError("whatsapp", "unsupported_schema", 1)).toBe("This WhatsApp version is not supported yet.");
    expect(localChatError("imessage", "fda_required", 1)).toBe("OmniRush needs Full Disk Access to read iMessage.");
    expect(localChatError("whatsapp", "http_502", 3)).toBe("Sync failed. It tries again on its own. Failed 3 times in a row.");
    const card = (() => {
      const queries = new QueryClient();
      const at = new Date(Date.now() - 5 * 60_000).toISOString();
      queries.setQueryData(["omnirush-chat-sync"], {
        imessage: { enabled: true, lastSyncAt: at, lastError: null, failures: 0, running: false },
        whatsapp: { enabled: null, lastSyncAt: null, lastError: "fda_required", failures: 4, running: false },
      });
      queries.setQueryData(["omnirush-imessage-count", "http://connectors.test"], { records: 12 });
      return renderToStaticMarkup(<QueryClientProvider client={queries}><LocalChatsCard client={{ baseUrl: "http://connectors.test" } as never} openLink={noop} /></QueryClientProvider>);
    })();
    expect(card).toContain("12 conversation days synced · last sync 5 min ago");
    // A repeated error is one line with its count, and the Full Disk Access step shows once.
    expect(card.match(/data-testid="work-local-chat-error"/g)?.length).toBe(1);
    expect(card).toContain("OmniRush needs Full Disk Access to read WhatsApp. Failed 4 times in a row.");
    expect(card.match(/data-testid="work-local-chat-fda"/g)?.length).toBe(1);
    expect(card).not.toMatch(/—/);
    const client = { baseUrl: "http://connectors.test" } as never;
    const queries = new QueryClient();
    queries.setQueryData(workConnectorsKey(client), [row({})]);
    const page = renderToStaticMarkup(<QueryClientProvider client={queries}><MemoryRouter><WorkConnectorsPage client={client} openLink={noop} /></MemoryRouter></QueryClientProvider>);
    expect(page).toContain('data-work-connector="google"');
    expect(page).not.toContain('data-testid="work-imessage-card"');
    expect(page).not.toContain('data-testid="work-local-chats"');
    // Off the Mac app, WhatsApp says in one line why it stays a manual export.
    expect(page).toContain('data-testid="work-import-whatsapp-manual"');
    expect(page).not.toMatch(/—/);
  });
});
