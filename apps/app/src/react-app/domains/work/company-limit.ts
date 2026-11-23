// An OmniRush Work company account's usage limit (judge S13, design D22). Wherever the app shows a usage limit (the
// chat's error card, the error above the composer, retries, desktop notifications, the sidebar account card,
// Settings, /status, voice and the wrap question), a company account reads one sentence: "Your company's usage limit
// is reached for now. It resets 5:30 AM (in 3 h)." The reset is written like the consumer copy's; nothing of the
// consumer allowance shows (no meter, no "How tokens work", no console link, no ways to earn tokens). Every other
// account keeps its copy as it was. It works on an older server too: enterprise mode alone turns a spent grant into
// the company's limit, whether or not the gateway marked it (`x-omnirush-limit-owner`, `error.omnirush.owner`).
import type { OmniRushAccountUsage } from "@omnirush/types/desktop-ipc";

import { gatewayRefusalEvent } from "@/app/lib/gateway-refusal";
import { localReset, type UsageClock } from "@/app/lib/omnirush-usage";
import { t } from "@/i18n";
import type { OmniRushErrorDetails } from "@/react-app/domains/session/sync/session-error";

import { useEnterpriseStore } from "./enterprise-mode";

/** The gateway's mark on a company account's usage limit (`error.omnirush.owner`). */
export const COMPANY_OWNER = "company";

/** The company sentence in any of the app's languages and the local server's English (`companyLimitCopy`). */
const COMPANY_TEXT = /company[’']s usage limit is reached|公司的用量上限/i;

/** Enterprise mode now, for code outside React (the chat sync, notifications): the last enterprise block seen. */
export function companyAccountNow(): boolean {
  return useEnterpriseStore.getState().block !== null;
}

/** What a limit says about its reset: the gateway's `scope` and `resets_at` (UTC ISO 8601). */
export type LimitReset = { scope?: string | null; resets_at?: string | null };

/**
 * The company sentence. A day or week reset on the user's clock as the consumer copy writes it ("5:30 AM (in 3 h)",
 * "Monday 5:30 AM (in 4 days)"), or as 00:00 UTC / Monday 00:00 UTC when its time is not known; a limit nothing
 * resets (nothing granted, a chat's own cap) or one with no reset at all: the first sentence only.
 */
export function companyLimitText(limit: LimitReset | null | undefined, clock: UsageClock = {}): string {
  const scope = limit?.scope?.trim().toLowerCase() || null;
  if (scope === "empty" || scope === "session") return t("work.ent.limit");
  const period = scope === "week" ? "week" : "day";
  const when = localReset(limit?.resets_at, period, clock)
    ?? (scope === "day" || scope === "model" ? "00:00 UTC" : scope === "week" ? "Monday 00:00 UTC" : null);
  return when ? t("work.ent.limit_resets", { time: when }) : t("work.ent.limit");
}

type LimitSource = {
  title?: string | null;
  technicalDetails?: string | null;
  omnirush?: OmniRushErrorDetails | null;
};

/** Whether text reads as a usage limit: the consumer allowance's words, a spent grant's code, or the company's. */
export function isUsageLimitText(text: string | null | undefined): boolean {
  if (!text) return false;
  return COMPANY_TEXT.test(text) || gatewayRefusalEvent({ title: text })?.properties.limit_type === "tokens";
}

/** Whether an error shows a usage limit: the gateway's stable code (or its mark), else the error's own words. */
export function isUsageLimit(source: LimitSource | null | undefined): boolean {
  if (!source) return false;
  if (source.omnirush?.owner === COMPANY_OWNER) return true;
  if (COMPANY_TEXT.test(source.title ?? "")) return true;
  return gatewayRefusalEvent(source)?.properties.limit_type === "tokens";
}

/** What a limit's words say ran out (a spent day, a week's cap, nothing granted); a bare code reads as the day's. */
function wordsScope(source: LimitSource): string {
  const scope = gatewayRefusalEvent(source)?.properties.scope;
  return typeof scope === "string" && scope !== "unknown" ? scope : "day";
}

/**
 * An error's presentation for a company account: a usage limit reads as the company's, with no description and no
 * console link; anything else, and every consumer, exactly as it came. The reset, in this order: the gateway's
 * `error.omnirush` (a limit nothing resets has none); the account's usage when it shows the limit reached (`usage`,
 * the account status the desktop reads: the 2.x engine keeps only the gateway's code); the company sentence the
 * local server already wrote; else as the consumer copy writes an unknown reset (00:00 UTC).
 */
export function companyLimitPresentation<T extends LimitSource & { description?: string | null; action?: unknown }>(
  presentation: T,
  enterprise: boolean,
  clock: UsageClock = {},
  usage?: OmniRushAccountUsage | null,
): T {
  if (!enterprise || !isUsageLimit(presentation)) return presentation;
  const details = presentation.omnirush;
  const scope = details?.scope?.trim().toLowerCase() || null;
  const title = details?.resets_at || scope === "empty" || scope === "session"
    ? companyLimitText(details, clock)
    : companyUsageLimit(usage, clock)
      ?? (COMPANY_TEXT.test(presentation.title ?? "") ? presentation.title ?? t("work.ent.limit") : companyLimitText({ scope: scope ?? wordsScope(presentation) }, clock));
  return { ...presentation, title, description: null, action: null };
}

/** A line of text (a retry's message, a notification) for a company account: a usage limit as the company's. */
export function companyLimitLine(text: string, enterprise: boolean, usage?: OmniRushAccountUsage | null, clock: UsageClock = {}): string {
  if (!enterprise || !isUsageLimitText(text)) return text;
  if (COMPANY_TEXT.test(text)) return text;
  return companyUsageLimit(usage, clock) ?? companyLimitText({ scope: wordsScope({ title: text }) }, clock);
}

/**
 * The account's usage limit as the company sentence while it is reached (from the account status the sidebar,
 * Settings and /status read); null while usage is left, a bonus pot still covers requests, or nothing is known.
 * Mirrors which limit binds in `omnirushUsageSummary`, without its numbers.
 */
export function companyUsageLimit(usage: OmniRushAccountUsage | null | undefined, clock: UsageClock = {}): string | null {
  if (!usage) return null;
  if (Math.max(0, usage.pot ?? 0) > 0) return null;
  const week = usage.week ?? null;
  const day = usage.grantModel === "daily" && usage.limitScope !== "week" ? usage.day : null;
  if (day) {
    if (day.allowance <= 0) return companyLimitText({ scope: "empty" }, clock);
    const dayLeft = Math.max(0, day.allowance - day.used - day.reserved);
    const weekLeft = week ? Math.max(0, week.limit - week.used - day.reserved) : null;
    const left = weekLeft === null ? dayLeft : Math.min(dayLeft, weekLeft);
    if (left > 0) return null;
    const capped = weekLeft !== null && weekLeft < dayLeft;
    return companyLimitText(capped ? { scope: "week", resets_at: week?.resetsAt } : { scope: "day", resets_at: day.resetsAt }, clock);
  }
  if (usage.grantModel === "daily" && week) {
    return week.limit - week.used > 0 ? null : companyLimitText({ scope: "week", resets_at: week.resetsAt }, clock);
  }
  return usage.remainingTokens > 0 ? null : companyLimitText({ scope: usage.period === "week" ? "week" : "day" }, clock);
}
