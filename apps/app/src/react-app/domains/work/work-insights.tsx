/** @jsxImportSource react */
// Work > Insights (owner only): the manager's view of how the team is working: aggregate activity and smart alerts
// from GET /omnirush/work/org/insights. It never shows message content: only counts, trends, meetings and flags.
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, RotateCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import type { OmniRushWorkInsights, OmniRushWorkInsightsAlert, OmniRushWorkInsightsMember, OmniRushWorkMember } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { ListMore, ListSearch, matchesQuery, PersonAvatar, useListCap } from "./list-cap";
import { connectorLabel, relativeTime, useWorkOrgInsights, workFailure, workMembersKey, workRoleLabel, type WorkClient } from "./work-mode";

const RANGES = [7, 14, 30, 90] as const;
const DEFAULT_DAYS = 14;

/** A member's title and second line: the display name over the e-mail, job role and role; the e-mail as the title when
 *  there is no name. */
export function memberName(member: OmniRushWorkInsightsMember): { primary: string; secondary: string | null } {
  const role = member.role ? workRoleLabel(member.role) : null;
  const name = member.name?.trim() || null;
  const tags = [name ? member.email : null, member.job_role, role].filter((part): part is string => Boolean(part));
  return { primary: name ?? member.email, secondary: tags.length ? tags.join(" · ") : null };
}

/** Adds the members list's display names to the insights people (joined on `user_id`); a name the server sent wins. */
export function withNames(members: OmniRushWorkInsightsMember[], people: OmniRushWorkMember[] | undefined): OmniRushWorkInsightsMember[] {
  if (!people?.length) return members;
  const names = new Map(people.filter((person) => person.name?.trim()).map((person) => [person.user_id, person.name!.trim()]));
  return members.map((member) => (member.name?.trim() || !names.has(member.user_id) ? member : { ...member, name: names.get(member.user_id) }));
}

/** An alert in words, by its kind; a kind this app does not know shows the server's own text. */
export function alertText(alert: OmniRushWorkInsightsAlert, member: Pick<OmniRushWorkInsightsMember, "trend" | "meetings">): string {
  const overdue = Number(alert.text.match(/\d+/)?.[0] ?? Number.NaN);
  if (alert.kind === "idle") return t("work.insights.alert_idle");
  if (alert.kind === "drop_off") return t("work.insights.alert_drop_off", { n: Math.abs(member.trend) });
  if (alert.kind === "overload") return t("work.insights.alert_overload", { n: member.trend });
  if (alert.kind === "meeting_load") return t("work.insights.alert_meetings", { count: member.meetings, n: member.meetings });
  if (alert.kind === "overdue" && Number.isFinite(overdue)) return t("work.insights.alert_overdue", { count: overdue, n: overdue });
  return alert.text;
}

/** Members with a serious alert come first, then by activity desc; ties keep the server's order. */
export function sortMembers(members: OmniRushWorkInsightsMember[]): OmniRushWorkInsightsMember[] {
  const serious = (member: OmniRushWorkInsightsMember) => (member.alerts.some((alert) => alert.level === "serious") ? 1 : 0);
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => serious(b.member) - serious(a.member) || b.member.activity - a.member.activity || a.index - b.index)
    .map((entry) => entry.member);
}

/** No tracked activity in the window: folded into one line under the list. */
export const isIdle = (member: Pick<OmniRushWorkInsightsMember, "activity" | "alerts">) => member.activity === 0;
/** People the list shows before "Show N more". */
export const INSIGHTS_PEOPLE = 10;

/** A compact daily-activity sparkline: a 2px baseline-anchored line over a faint fill; flat line when the window is empty. */
function Sparkline(props: { data: OmniRushWorkInsightsMember["daily"]; label: string }) {
  const values = props.data.map((point) => point.n);
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(1, ...values);
  const w = 104;
  const h = 28;
  const pad = 2;
  const count = values.length;
  const x = (i: number) => (count <= 1 ? w / 2 : pad + (i * (w - pad * 2)) / (count - 1));
  const y = (value: number) => h - pad - (value / max) * (h - pad * 2);
  const line = count ? values.map((value, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ") : "";
  const area = count ? `${line} L${x(count - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z` : "";
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={t("work.insights.sparkline", { name: props.label, total, count, n: count })}
      className="shrink-0 text-blue-9"
      preserveAspectRatio="none"
    >
      {total > 0 ? <path d={area} className="fill-current opacity-10" /> : null}
      <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cn(total === 0 && "text-border")} />
    </svg>
  );
}

/** The signed change vs the previous window, as an arrow (not colour alone) plus percent in the foreground colour. */
function Trend(props: { trend: number }) {
  if (props.trend === 0) return <span className="text-[13px] text-muted-foreground">{t("work.insights.no_change")}</span>;
  const up = props.trend > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-0.5 text-[13px] font-medium text-foreground" aria-label={up ? t("work.insights.trend_up", { n: Math.abs(props.trend) }) : t("work.insights.trend_down", { n: Math.abs(props.trend) })}>
      <Icon aria-hidden className={cn("size-3.5", up ? "text-green-11" : "text-red-11")} />{up ? "+" : ""}{props.trend}%
    </span>
  );
}

function AlertBadge(props: { alert: OmniRushWorkInsightsAlert; member: OmniRushWorkInsightsMember }) {
  const serious = props.alert.level === "serious";
  const Icon = serious ? AlertTriangle : AlertCircle;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground" data-alert-level={props.alert.level}>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", serious ? "text-red-11" : "text-amber-11")} />
      <span>{alertText(props.alert, props.member)}</span>
    </span>
  );
}

function Stat(props: { label: string; value: string | number; tone?: "default" | "alert" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border px-4 py-3">
      <span className="text-[13px] text-muted-foreground">{props.label}</span>
      <span className={cn("flex items-center gap-1.5 text-[20px] font-semibold tabular-nums leading-tight text-foreground")}>
        {props.tone === "alert" ? <AlertTriangle aria-hidden className="size-4 text-red-11" /> : null}{props.value}
      </span>
    </div>
  );
}

/** Thread sources that are part of a bigger connector (Gmail is Google's, Teams is Microsoft 365's). */
const THREAD_SOURCES: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", teams: "Teams", calendar: "Calendar", email: "Email" };

/** A work area's label without the server's type prefix ("email:ana@x.com" reads "ana@x.com"). A thread key
 *  ("thread:slack:C1:1794650400.000000") reads as its source's thread ("Slack thread"). */
export function focusLabel(label: string): string {
  const thread = label.match(/^thread:([a-z0-9_-]+)(?::|$)/i);
  if (thread) {
    const source = thread[1]!.toLowerCase();
    const name = THREAD_SOURCES[source] ?? connectorLabel(source).replace(/\s*\(.*\)$/, "");
    return t("work.insights.thread_label", { name });
  }
  return label.replace(/^(email|domain|person|company|org|deal|project|channel|repo|topic):/i, "");
}

/** The work areas as readable labels, the same label once (two Slack threads are one "Slack thread" chip with both
 *  counts), highest first. `email` is the person's own address: it and its domain (the company's own) match everything
 *  they touch, so they say nothing and are left out. */
export function focusAreas(focus: OmniRushWorkInsightsMember["focus"], email?: string | null): [string, number][] {
  const own = email?.trim().toLowerCase() ?? "";
  const ownDomain = own.includes("@") ? own.slice(own.lastIndexOf("@") + 1) : "";
  const merged = new Map<string, number>();
  for (const [label, count] of focus) {
    const text = focusLabel(label).trim();
    const key = text.toLowerCase();
    if (own && (key === own || (ownDomain && key === ownDomain))) continue;
    if (text) merged.set(text, (merged.get(text) ?? 0) + count);
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]);
}

function FocusChips(props: { focus: OmniRushWorkInsightsMember["focus"]; email?: string | null }) {
  const areas = focusAreas(props.focus, props.email);
  if (!areas.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="work-insights-focus">
      {areas.slice(0, 5).map(([label, count]) => (
        <span key={label} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[12px] text-foreground" title={`${label} · ${count}`}>
          <span className="max-w-[14rem] truncate">{label}</span>
          <span className="tabular-nums text-muted-foreground">{count}</span>
        </span>
      ))}
    </div>
  );
}

function MemberCard(props: { member: OmniRushWorkInsightsMember; now: number }) {
  const member = props.member;
  const name = memberName(member);
  return (
    <li className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0" data-member={member.user_id}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <PersonAvatar name={member.name?.trim() || member.email} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-foreground" title={name.primary}>{name.primary}</div>
            {name.secondary ? <div className="truncate text-[13px] text-muted-foreground" title={name.secondary}>{name.secondary}</div> : null}
          </div>
        </div>
        <Sparkline data={member.daily} label={name.primary} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span><span className="font-medium tabular-nums text-foreground">{member.activity}</span> {t("work.insights.activity_unit")}</span>
        <Trend trend={member.trend} />
        <span><span className="font-medium tabular-nums text-foreground">{member.meetings}</span> {t("work.insights.meetings_unit", { count: member.meetings })}</span>
        <span><span className="font-medium tabular-nums text-foreground">{member.active_days}</span> {t("work.insights.active_days_unit", { count: member.active_days })}</span>
        <span>{member.last_active ? t("work.insights.last_active", { when: relativeTime(member.last_active, props.now) }) : t("work.insights.no_activity")}</span>
      </div>
      <FocusChips focus={member.focus} email={member.email} />
      {member.alerts.length ? (
        <div className="flex flex-wrap gap-2" data-testid="work-insights-alerts">
          {member.alerts.map((alert, index) => <AlertBadge key={`${alert.kind}-${index}`} alert={alert} member={member} />)}
        </div>
      ) : null}
    </li>
  );
}

function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="work-insights-loading">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[70px] rounded-xl" />)}
      </div>
      <div className="rounded-xl border border-border">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-1/3 rounded-md" /><Skeleton className="h-3 w-1/4 rounded-md" /></div>
              <Skeleton className="h-7 w-[104px] rounded-md" />
            </div>
            <Skeleton className="h-3 w-2/3 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Work > Insights. Owner only: the shell gates the nav entry and this route; the server refuses a member (not_owner). */
export function WorkInsightsPage(props: { client: WorkClient | null; onBack: () => void; backLabel?: string }) {
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const query = useWorkOrgInsights(props.client, days, Boolean(props.client));
  // The members list carries the display names (the insights only e-mails on an older server).
  const people = useQuery({ queryKey: workMembersKey(props.client), queryFn: () => props.client!.listWorkMembers(), enabled: Boolean(props.client), retry: false });
  const data: OmniRushWorkInsights | undefined = query.data;
  const members = data ? sortMembers(withNames(data.members, people.data?.members)) : [];
  const [search, setSearch] = useState("");
  const [showIdle, setShowIdle] = useState(false);
  const found = members.filter((member) => matchesQuery(search, member.name, member.email, member.job_role, ...member.focus.map(([label]) => focusLabel(label))));
  // People with no tracked activity fold into one line (searching shows everyone who matches).
  const idle = search.trim() ? [] : found.filter(isIdle);
  const active = search.trim() ? found : found.filter((member) => !isIdle(member));
  const cap = useListCap(active.length, INSIGHTS_PEOPLE);
  // Alerts worth a look: "no tracked activity" is the idle line, not an alert per person.
  const openAlerts = data ? data.members.reduce((sum, member) => sum + member.alerts.filter((alert) => alert.kind !== "idle").length, 0) : 0;
  const failure = query.error && !data ? workFailure(query.error) : null;
  const now = Date.now();
  const rangeChip = (active: boolean) => cn(
    "h-8 rounded-full px-3 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-foreground text-background" : "border border-border bg-background text-foreground hover:bg-muted",
  );

  return (
    <div className="h-full overflow-y-auto" data-testid="work-insights">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-10 pt-10">
        <div>
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? t("work.common.back_to_work")}</Button>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t("work.nav.insights")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("work.insights.subtitle")}</p>
            </div>
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("work.insights.range")}>
              {RANGES.map((value) => (
                <button key={value} type="button" role="radio" aria-checked={days === value} onClick={() => setDays(value)} className={rangeChip(days === value)} data-range={value}>
                  {t("work.insights.days_short", { n: value })}
                </button>
              ))}
            </div>
          </div>
        </div>

        {query.isLoading ? <InsightsSkeleton /> : failure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-insights-error">
            <span className="text-sm text-muted-foreground">{failure.text}</span>
            {failure.retry ? <Button variant="outline" size="sm" onClick={() => void query.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="work-insights-summary">
              <Stat label={t("work.insights.active_members")} value={`${data.team.active_members} / ${data.team.members}`} />
              <Stat label={t("work.insights.activity")} value={data.team.total_activity} />
              <Stat label={t("work.insights.meetings")} value={data.team.meetings} />
              <Stat label={t("work.insights.open_alerts")} value={openAlerts} tone={data.members.some((member) => member.alerts.some((alert) => alert.level === "serious" && alert.kind !== "idle")) ? "alert" : "default"} />
            </div>
            {members.length ? (
              <div className="flex flex-col gap-3">
                {members.length > INSIGHTS_PEOPLE ? (
                  <ListSearch value={search} onChange={(value) => { setSearch(value); cap.reset(); }} label={t("work.insights.search")} testId="work-insights-search" />
                ) : null}
                {active.length ? (
                  <ul className="rounded-xl border border-border bg-background" data-testid="work-insights-members">
                    {active.slice(0, cap.shown).map((member) => <MemberCard key={member.user_id} member={member} now={now} />)}
                  </ul>
                ) : search.trim() ? <p className="text-[14px] text-muted-foreground" data-testid="work-insights-no-match">{t("work.insights.no_match")}</p> : null}
                <ListMore cap={cap} testId="work-insights-more" />
                {idle.length ? (
                  <div className="rounded-xl border border-border bg-background" data-testid="work-insights-idle">
                    <button type="button" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)} className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-start text-[13px] text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
                      <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", !showIdle && "-rotate-90")} />
                      <span className="min-w-0 flex-1 truncate">{t("work.insights.idle_line", { count: idle.length, n: idle.length.toLocaleString() })}</span>
                    </button>
                    {showIdle ? (
                      <ul className="flex flex-col border-t border-border px-4 py-2" data-testid="work-insights-idle-list">
                        {idle.slice(0, 50).map((member) => (
                          <li key={member.user_id} className="truncate py-1 text-[13px] text-muted-foreground" title={member.name?.trim() ? `${member.name.trim()} (${member.email})` : member.email} data-member={member.user_id}>{member.name?.trim() || member.email}</li>
                        ))}
                        {idle.length > 50 ? <li className="py-1 text-[13px] text-muted-foreground">{t("work.insights.idle_more", { n: (idle.length - 50).toLocaleString() })}</li> : null}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-xl border border-border px-4 py-10 text-center text-sm text-muted-foreground" data-testid="work-insights-empty">
                {t("work.insights.empty")}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
