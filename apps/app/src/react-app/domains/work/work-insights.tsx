/** @jsxImportSource react */
// Work > Insights (owner only): the manager's view of how the team is working — aggregate activity and smart alerts
// from GET /omnirush/work/org/insights. It never shows message content: only counts, trends, meetings and flags.
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, RotateCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { OmniRushWorkInsights, OmniRushWorkInsightsAlert, OmniRushWorkInsightsMember } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { relativeTime, useWorkOrgInsights, type WorkClient } from "./work-mode";

const RANGES = [7, 14, 30, 90] as const;
const DEFAULT_DAYS = 14;

/** A member's name line from the three bits the server gives (email is always there, the rest when set). */
function memberName(member: OmniRushWorkInsightsMember): { primary: string; secondary: string | null } {
  const tags = [member.job_role, member.role === "owner" ? "Owner" : member.role].filter((part): part is string => Boolean(part));
  return { primary: member.email, secondary: tags.length ? tags.join(" · ") : null };
}

/** Members with a serious alert come first, then by activity desc; ties keep the server's order. */
export function sortMembers(members: OmniRushWorkInsightsMember[]): OmniRushWorkInsightsMember[] {
  const serious = (member: OmniRushWorkInsightsMember) => (member.alerts.some((alert) => alert.level === "serious") ? 1 : 0);
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => serious(b.member) - serious(a.member) || b.member.activity - a.member.activity || a.index - b.index)
    .map((entry) => entry.member);
}

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
      aria-label={`${props.label}: ${total} over ${count} day${count === 1 ? "" : "s"}`}
      className="shrink-0 text-blue-9"
      preserveAspectRatio="none"
    >
      {total > 0 ? <path d={area} className="fill-current opacity-10" /> : null}
      <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cn(total === 0 && "text-border")} />
    </svg>
  );
}

/** The signed change vs the previous window, as an arrow (not colour alone) plus percent. */
function Trend(props: { trend: number }) {
  if (props.trend === 0) return <span className="text-[12px] text-muted-foreground" aria-label="No change">No change</span>;
  const up = props.trend > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[12px] font-medium", up ? "text-green-11" : "text-red-11")} aria-label={`${up ? "Up" : "Down"} ${Math.abs(props.trend)} percent`}>
      <Icon aria-hidden className="size-3" />{up ? "+" : ""}{props.trend}%
    </span>
  );
}

function AlertBadge(props: { alert: OmniRushWorkInsightsAlert }) {
  const serious = props.alert.level === "serious";
  const Icon = serious ? AlertTriangle : AlertCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]",
        serious ? "border-red-6 bg-red-3 text-red-11" : "border-amber-6 bg-amber-3 text-amber-11",
      )}
      data-alert-level={props.alert.level}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{props.alert.text}</span>
    </span>
  );
}

function Stat(props: { label: string; value: string | number; tone?: "default" | "alert" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border px-4 py-3">
      <span className="text-[12px] text-muted-foreground">{props.label}</span>
      <span className={cn("text-[20px] font-semibold tabular-nums leading-tight", props.tone === "alert" && "text-red-11")}>{props.value}</span>
    </div>
  );
}

function FocusChips(props: { focus: OmniRushWorkInsightsMember["focus"] }) {
  if (!props.focus.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="work-insights-focus">
      {props.focus.map(([label, count]) => (
        <span key={label} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[12px] text-foreground">
          <span className="max-w-[12rem] truncate">{label}</span>
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
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-foreground" title={name.primary}>{name.primary}</div>
          {name.secondary ? <div className="truncate text-[12px] text-muted-foreground">{name.secondary}</div> : null}
        </div>
        <Sparkline data={member.daily} label={`${name.primary} daily activity`} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span><span className="font-medium tabular-nums text-foreground">{member.activity}</span> activity</span>
        <Trend trend={member.trend} />
        <span><span className="font-medium tabular-nums text-foreground">{member.meetings}</span> meeting{member.meetings === 1 ? "" : "s"}</span>
        <span><span className="font-medium tabular-nums text-foreground">{member.active_days}</span> active day{member.active_days === 1 ? "" : "s"}</span>
        <span>{member.last_active ? `Last active ${relativeTime(member.last_active, props.now)}` : "No activity yet"}</span>
      </div>
      <FocusChips focus={member.focus} />
      {member.alerts.length ? (
        <div className="flex flex-wrap gap-2" data-testid="work-insights-alerts">
          {member.alerts.map((alert, index) => <AlertBadge key={`${alert.kind}-${index}`} alert={alert} />)}
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

/** Work > Insights. Owner only — the shell gates both the nav entry and this route; a member never reaches it. */
export function WorkInsightsPage(props: { client: WorkClient | null; onBack: () => void; backLabel?: string }) {
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const query = useWorkOrgInsights(props.client, days, Boolean(props.client));
  const data: OmniRushWorkInsights | undefined = query.data;
  const members = data ? sortMembers(data.members) : [];
  const now = Date.now();
  const rangeChip = (active: boolean) => cn(
    "h-8 rounded-full px-3 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-foreground text-background" : "border border-border bg-background text-foreground hover:bg-muted",
  );

  return (
    <div className="h-full overflow-y-auto" data-testid="work-insights">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-10 pt-10">
        <div>
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? "Back to Work"}</Button>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Team insights</h1>
              <p className="mt-1 text-sm text-muted-foreground">How your team is working. Aggregate activity and alerts only — never the content of anyone's messages.</p>
            </div>
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Time range">
              {RANGES.map((value) => (
                <button key={value} type="button" role="radio" aria-checked={days === value} onClick={() => setDays(value)} className={rangeChip(days === value)} data-range={value}>
                  {value}d
                </button>
              ))}
            </div>
          </div>
        </div>

        {query.isLoading ? <InsightsSkeleton /> : query.error && !data ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-insights-error">
            <span className="text-sm text-muted-foreground">{query.error instanceof Error ? query.error.message : "Insights could not be loaded."}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}><RotateCw className="size-3.5" />Try again</Button>
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="work-insights-summary">
              <Stat label="Active members" value={`${data.team.active_members} / ${data.team.members}`} />
              <Stat label="Activity" value={data.team.total_activity} />
              <Stat label="Meetings" value={data.team.meetings} />
              <Stat label="Open alerts" value={data.team.alerts} tone={data.team.alerts > 0 ? "alert" : "default"} />
            </div>
            {members.length ? (
              <ul className="rounded-xl border border-border bg-background" data-testid="work-insights-members">
                {members.map((member) => <MemberCard key={member.user_id} member={member} now={now} />)}
              </ul>
            ) : (
              <div className="rounded-xl border border-border px-4 py-10 text-center text-sm text-muted-foreground" data-testid="work-insights-empty">
                No team activity yet. Insights fill in as your team uses Work.
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
