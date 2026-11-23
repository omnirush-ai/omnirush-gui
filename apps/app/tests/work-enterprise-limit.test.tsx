// OmniRush Work company accounts: a usage limit reads as the company's everywhere the app shows one (judge S13,
// design D22), with the reset written like the consumer copy, no meter, no allowance help and no console link; it works
// against an older server (enterprise mode alone); every other account keeps its copy as it was.
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OmniRushAccountUsage } from "@omnirush/types/desktop-ipc";
import { companyLimitCopy } from "@omnirush/types/gateway-errors";

import { gatewayRefusalEvent } from "../src/app/lib/gateway-refusal";
import { omnirushUsageSummary } from "../src/app/lib/omnirush-usage";
import { t } from "../src/i18n";
import en from "../src/i18n/locales/en";
import zh from "../src/i18n/locales/zh";
import { createSessionErrorUIMessage } from "../src/react-app/domains/session/sync/usechat-adapter";
import { omnirushErrorDetails, presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error";
import {
  companyAccountNow,
  companyLimitLine,
  companyLimitPresentation,
  companyLimitText,
  companyUsageLimit,
  isUsageLimit,
} from "../src/react-app/domains/work/company-limit";
import { useEnterpriseStore } from "../src/react-app/domains/work/enterprise-mode";
import type { OmniRushWorkEnterprise } from "../src/app/lib/omnirush-server";

const NOW = Date.parse("2037-09-23T21:00:00Z");
const RESETS = "2037-09-24T00:00:00Z";
const clock = { now: NOW, timeZone: "UTC", hourCycle: "h12" as const };
const block: OmniRushWorkEnterprise = {
  status: "active",
  org: { id: "org_1", name: "Acme Freight", domain: "acme.example" },
  role: "member",
  code: false,
  capture: { code: false, chat: true },
  portal_url: "https://omnirush.ai/console/enterprise",
};

const DAY_LIMIT = "Your company's usage limit is reached for now. It resets 12:00 AM (in 3 h).";
const consumerWords = /tokens|allowance|console|Discord|GitHub|refill|upgrade|omnirush\.ai/i;

describe("the company sentence", () => {
  test("reads exactly as the judge wrote it, with the reset like the consumer copy's", () => {
    expect(companyLimitText({ scope: "day", resets_at: RESETS }, clock)).toBe(DAY_LIMIT);
    expect(companyLimitText({ scope: "model", resets_at: RESETS }, clock)).toBe(DAY_LIMIT);
    expect(companyLimitText({ scope: "week", resets_at: "2037-09-28T00:00:00Z" }, clock))
      .toBe("Your company's usage limit is reached for now. It resets Monday 12:00 AM (in 4 days).");
    // Nothing resets it: the first sentence only.
    expect(companyLimitText({ scope: "empty" }, clock)).toBe("Your company's usage limit is reached for now.");
    expect(companyLimitText({ scope: "session", resets_at: RESETS }, clock)).toBe("Your company's usage limit is reached for now.");
    // A day or week whose time is not known: as the consumer copy writes it.
    expect(companyLimitText({ scope: "day" }, clock)).toBe("Your company's usage limit is reached for now. It resets 00:00 UTC.");
    expect(companyLimitText({ scope: "week" }, clock)).toBe("Your company's usage limit is reached for now. It resets Monday 00:00 UTC.");
    expect(companyLimitText(null, clock)).toBe("Your company's usage limit is reached for now.");
    for (const text of [DAY_LIMIT, companyLimitText({ scope: "empty" }, clock)]) {
      expect(text).not.toMatch(consumerWords);
      expect(text).not.toMatch(/[–—!]/);
    }
  });

  test("the local server's words are the app's English strings, and every shipped language has them", () => {
    expect(companyLimitCopy("5:30 AM (in 3 h)")).toBe(t("work.ent.limit_resets", { time: "5:30 AM (in 3 h)", lng: "en" }));
    expect(companyLimitCopy(null)).toBe(t("work.ent.limit", { lng: "en" }));
    for (const key of ["work.ent.limit", "work.ent.limit_resets", "work.ent.usage", "work.ent.wrap_body", "work.ent.wrap_done"]) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
    expect(zh["work.ent.limit_resets"]).toContain("{time}");
    expect(t("work.ent.limit_resets", { time: "5:30 AM", lng: "zh" })).toContain("5:30 AM");
  });
});

describe("the account's usage (sidebar card, Settings, /status)", () => {
  const usage = (fields: Partial<OmniRushAccountUsage>): OmniRushAccountUsage => ({ tokenLimit: 0, usedTokens: 0, remainingTokens: 0, ...fields });
  const daily = (used: number, fields: Partial<OmniRushAccountUsage> = {}) => usage({
    grantModel: "daily",
    day: { allowance: 1_000_000, used, reserved: 0, resetsAt: RESETS },
    week: { limit: 5_000_000, used: 1_000_000, resetsAt: "2037-09-28T00:00:00Z" },
    ...fields,
  });

  test("only while the limit is reached, as the company's, never the numbers", () => {
    expect(companyUsageLimit(daily(400_000), clock)).toBeNull();
    expect(companyUsageLimit(daily(1_000_000), clock)).toBe(DAY_LIMIT);
    // The weekly cap binds: its reset.
    expect(companyUsageLimit(daily(200_000, { week: { limit: 1_000_000, used: 1_000_000, resetsAt: "2037-09-28T00:00:00Z" } }), clock))
      .toBe("Your company's usage limit is reached for now. It resets Monday 12:00 AM (in 4 days).");
    // A bonus pot still covers requests: not reached.
    expect(companyUsageLimit(daily(1_000_000, { pot: 50_000 }), clock)).toBeNull();
    // Nothing granted: no reset.
    expect(companyUsageLimit(usage({ grantModel: "daily", day: { allowance: 0, used: 0, reserved: 0, resetsAt: RESETS } }), clock))
      .toBe("Your company's usage limit is reached for now.");
    expect(companyUsageLimit(usage({ grantModel: "daily", week: { limit: 10, used: 10, resetsAt: "2037-09-28T00:00:00Z" } }), clock))
      .toContain("It resets Monday");
    expect(companyUsageLimit(usage({ tokenLimit: 10, usedTokens: 10, remainingTokens: 0, period: "day" }), clock))
      .toBe("Your company's usage limit is reached for now. It resets 00:00 UTC.");
    expect(companyUsageLimit(null, clock)).toBeNull();
    // The consumer meter's own line is untouched.
    expect(omnirushUsageSummary(daily(1_000_000), clock).line).toBe("Today's tokens are used up. They refill at 12:00 AM (in 3 h).");
  });
});

describe("an error's presentation", () => {
  const spentDay = {
    name: "APIError",
    data: {
      message: "omnirush.ai: today's tokens are used up. They refill at 5:30 AM (in 3 h).",
      statusCode: 403,
      responseBody: JSON.stringify({ error: { code: "daily_grant_exhausted", message: "x", omnirush: { code: "limit_tokens", scope: "day", resets_at: RESETS, retry: false } } }),
    },
  };
  const noTokens = {
    name: "APIError",
    data: { message: "omnirush.ai: you have no tokens left. Link Discord or connect GitHub in the console to earn tokens every day: https://omnirush.ai/console/account", statusCode: 403 },
  };

  test("a company account's limit is the company's sentence, with no description and no console link", () => {
    const shown = companyLimitPresentation(presentOpencodeSessionError(spentDay), true, clock);
    expect(shown.title).toBe(DAY_LIMIT);
    expect(shown.description).toBeNull();
    expect(shown.action).toBeNull();
    const empty = presentOpencodeSessionError(noTokens);
    expect(empty.action).toEqual({ label: "Open console", link: "https://omnirush.ai/console/account" });
    const emptyShown = companyLimitPresentation(empty, true, clock);
    expect(emptyShown.title).toBe("Your company's usage limit is reached for now.");
    expect(emptyShown.action).toBeNull();
  });

  test("an older server: the consumer words or a bare code in enterprise mode are the company's too", () => {
    // The 2.x engine keeps only the gateway's code (the app's copy for it): the reset as the consumer copy writes it.
    const older = presentOpencodeSessionError({ name: "UnknownError", data: { message: "omnirush.ai: you have used today's model allowance. It refills at 00:00 UTC.", code: "daily_grant_exhausted", statusCode: 403 } });
    expect(companyLimitPresentation(older, true, clock).title).toBe("Your company's usage limit is reached for now. It resets 00:00 UTC.");
    expect(companyLimitLine("daily_grant_exhausted", true)).toBe("Your company's usage limit is reached for now. It resets 00:00 UTC.");
    expect(companyLimitLine("omnirush.ai: this week's cap is reached. It resets Monday 00:00 UTC.", true)).toBe("Your company's usage limit is reached for now. It resets Monday 00:00 UTC.");
    // The account's usage shows the limit reached (the desktop reads it): its exact reset.
    const spentUsage: OmniRushAccountUsage = { tokenLimit: 1, usedTokens: 1, remainingTokens: 0, grantModel: "daily", day: { allowance: 10, used: 10, reserved: 0, resetsAt: RESETS } };
    expect(companyLimitPresentation(older, true, clock, spentUsage).title).toBe(DAY_LIMIT);
    expect(companyLimitLine("daily_grant_exhausted", true, spentUsage, clock)).toBe(DAY_LIMIT);
    // The local server already wrote the company's sentence (no error object): kept as it came.
    const local = presentOpencodeSessionError({ name: "APIError", data: { message: "Your company's usage limit is reached for now. It resets 5:30 AM (in 3 h).", statusCode: 403 } });
    expect(companyLimitPresentation(local, true, clock).title).toBe("Your company's usage limit is reached for now. It resets 5:30 AM (in 3 h).");
  });

  test("the gateway's mark is read, and counted as a token limit", () => {
    expect(omnirushErrorDetails({ code: "limit_tokens", scope: "day", owner: "company" })?.owner).toBe("company");
    expect(isUsageLimit({ title: "x", omnirush: { code: "limit_tokens", owner: "company" } })).toBe(true);
    expect(gatewayRefusalEvent({ title: "Your company's usage limit is reached for now." })?.properties).toMatchObject({ limit_type: "tokens" });
  });

  test("consumers, and every other error of a company account, are exactly as before", () => {
    const consumer = presentOpencodeSessionError(spentDay);
    expect(companyLimitPresentation(consumer, false, clock)).toBe(consumer);
    const empty = presentOpencodeSessionError(noTokens);
    expect(companyLimitPresentation(empty, false, clock)).toBe(empty);
    expect(companyLimitLine("omnirush.ai: today's tokens are used up.", false)).toBe("omnirush.ai: today's tokens are used up.");
    for (const message of [
      "omnirush.ai: your company's OmniRush Work account is not active yet. Open Work to see where it stands.",
      "omnirush.ai: too many answers are already running on this model. Wait for one to finish, then try again.",
      "This session isn't being recorded, so it's paused after 40M tokens.",
      "Provider authentication failed",
    ]) {
      const presentation = presentOpencodeSessionError({ name: "APIError", data: { message } });
      expect(companyLimitPresentation(presentation, true, clock)).toBe(presentation);
      expect(companyLimitLine(message, true)).toBe(message);
    }
  });
});

describe("the chat's error card", () => {
  const spent = {
    name: "APIError",
    data: {
      message: "omnirush.ai: you have no tokens left. Link Discord or connect GitHub in the console to earn tokens every day: https://omnirush.ai/console/account",
      statusCode: 403,
      responseBody: JSON.stringify({ error: { code: "daily_grant_exhausted", omnirush: { code: "limit_tokens", scope: "day", resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString(), retry: false } } }),
    },
  };

  test("a company account sees the company's sentence and none of the consumer allowance; a consumer sees the card as before", async () => {
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const { MessageList } = await import("../src/components/chat/message-list");
      const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
      document.body.innerHTML = '<div id="root"></div>';
      const root = createRoot(document.getElementById("root")!);
      const message = createSessionErrorUIMessage("assistant-turn", presentOpencodeSessionError(spent));
      const render = () => root.render(
        <MessageListProvider
          workspaceId="workspace-1"
          sessionId="session-1"
          showThinking={false}
          developerMode={false}
          dispatchAction={() => undefined}
          setPrompt={() => undefined}
          onRevertToUserMessage={() => undefined}
          onForkAtMessage={() => undefined}
          onEditUserMessage={() => undefined}
          onMcpReconnect={async () => "connected"}
          onMcpReopenAuthorization={async () => undefined}
          onMcpRetry={() => undefined}
        >
          <MessageList messages={[message]} status="ready" />
        </MessageListProvider>,
      );
      const card = () => document.getElementById("root")!;

      await act(async () => { useEnterpriseStore.getState().setBlock(null); });
      await act(async () => render());
      expect(card().textContent).toContain("you have no tokens left");
      expect(card().querySelector('[data-testid="session-error-action"]')).not.toBeNull();
      expect(card().querySelector('[data-testid="session-error-allowance-help"]')).not.toBeNull();
      expect(card().querySelector('[data-testid="session-error-company-limit"]')).toBeNull();
      const consumerMarkup = card().innerHTML;

      await act(async () => { useEnterpriseStore.getState().setBlock(block); });
      expect(companyAccountNow()).toBe(true);
      expect(card().textContent).toMatch(/Your company's usage limit is reached for now\. It resets \d{1,2}:\d{2}( [AP]M)? \(in 3 h\)\./);
      expect(card().textContent).not.toMatch(/tokens|Discord|console|How tokens work/i);
      expect(card().querySelector('[data-testid="session-error-action"]')).toBeNull();
      expect(card().querySelector('[data-testid="session-error-allowance-help"]')).toBeNull();
      // A calm notice until it resets, not the destructive error card.
      expect(card().querySelector('[data-testid="session-error-company-limit"]')?.getAttribute("role")).toBe("status");
      expect(card().querySelector('[data-testid="session-error-company-limit"]')!.className).not.toContain("destructive");
      expect(card().querySelector(".lucide-triangle-alert, .lucide-alert-triangle")).toBeNull();

      // Back to a consumer: the same markup as before, byte for byte.
      await act(async () => { useEnterpriseStore.getState().setBlock(null); });
      expect(card().innerHTML).toBe(consumerMarkup);
      await act(async () => root.unmount());
    } finally {
      useEnterpriseStore.getState().setBlock(null);
      if (registered) await GlobalRegistrator.unregister();
    }
  });
});

describe("the sidebar account card", () => {
  test("a company account at its limit: the company's sentence under the name, an amber dot, no meter or allowance help; a consumer as before", async () => {
    const registered = typeof globalThis.window === "undefined";
    if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const { SidebarProvider } = await import("../src/components/ui/sidebar");
      const { ShellConfigProvider } = await import("../src/react-app/shell/shell-config");
      const { NativeAccountFooter } = await import("../src/react-app/domains/session/sidebar/app-sidebar");
      const { useAccountStatusStore } = await import("../src/app/lib/quality");
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(<ShellConfigProvider><SidebarProvider><NativeAccountFooter onOpenAccountSettings={() => {}} /></SidebarProvider></ShellConfigProvider>);
        await tick();
      });
      const spent = {
        connected: true,
        gatewayConfigured: true,
        displayName: "Ana Ortiz",
        email: "cli-e2e-ana@acme.example",
        usage: {
          tokenLimit: 1_000_000, usedTokens: 1_000_000, remainingTokens: 0, grantModel: "daily" as const,
          day: { allowance: 1_000_000, used: 1_000_000, reserved: 0, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
          week: { limit: 5_000_000, used: 2_000_000, resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
        },
      };
      await act(async () => { useEnterpriseStore.getState().setBlock(null); useAccountStatusStore.getState().set(spent); await tick(); });
      const detail = () => host.querySelector('[data-testid="native-account-detail"]')!.textContent ?? "";
      const profile = () => host.querySelector<HTMLElement>('[data-testid="native-account-profile"]')!;
      expect(detail()).toContain("Today's tokens used up");
      expect(host.querySelector('[data-testid="native-account-allowance-help"]')).not.toBeNull();
      expect(profile().getAttribute("data-usage-limit")).toBeNull();

      await act(async () => { useEnterpriseStore.getState().setBlock(block); await tick(); });
      expect(detail()).toMatch(/^Your company's usage limit is reached for now\. It resets \d{1,2}:\d{2}( [AP]M)? \(in 3 h\)\.$/);
      expect(profile().getAttribute("data-usage-limit")).toBe("company");
      expect(host.querySelector('[data-testid="native-account-allowance-help"]')).toBeNull();
      expect(host.querySelector('[data-testid="sidebar-whats-new"]')).toBeNull();
      expect(host.innerHTML).not.toMatch(/tokens left|bg-highlight" style="width/);
      expect(host.querySelector(".bg-amber-9")).not.toBeNull();

      // Usage left: the company name, as D-A shows it.
      await act(async () => {
        useAccountStatusStore.getState().set({ ...spent, usage: { ...spent.usage, day: { ...spent.usage.day, used: 10 } } });
        await tick();
      });
      expect(detail()).toBe("Acme Freight");
      expect(profile().getAttribute("data-usage-limit")).toBeNull();
      await act(async () => root.unmount());
    } finally {
      useEnterpriseStore.getState().setBlock(null);
      if (registered) await GlobalRegistrator.unregister();
    }
  });
});
