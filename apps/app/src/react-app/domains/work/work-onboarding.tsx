/** @jsxImportSource react */
// Work first run (contract Addendum B3): Try Work, the company step, the connect step, the home checklist, invites
// and the sample-data badge. Shown only while capabilities.work is enabled (or `available`, for Try Work).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Briefcase, Building2, Check, Copy, Database, ShieldCheck, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkConnector } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import {
  checklistItems, connectorLabel, connectOrder, DEMO_SOURCE, domainFromEmail, isLinked, useWorkInviteLinks, useWorkInviteStore, useWorkSetupStore,
  workConnectorsKey, workFailure, workOnboardingKey, workStateKey, type WorkClient,
} from "./work-mode";
import { CONNECT_POLL_MS, CONNECT_TIMEOUT_MS, ConnectorIcon } from "./work-views";

// The server's size values, with how they read.
export const sizeOptions = () => [["1", t("work.onboarding.just_me")], ["2-10", "2–10"], ["11-50", "11–50"], ["51-200", "51–200"], ["201-1000", "201–1,000"], ["1000+", "1,000+"]] as const;
const errorText = (reason: unknown) => workFailure(reason).text;

/** In place of the Code | Work switch while Work is off but the account may try it. */
export function WorkTryButton(props: { onTry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-testid="work-try"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await props.onTry(); } catch (reason) { toast.error(errorText(reason)); } finally { setBusy(false); }
      }}
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-muted text-[12px] font-medium text-foreground transition-colors hover:bg-muted/70 disabled:opacity-60 mac:titlebar-no-drag [&_svg]:size-3.5"
    >
      <Briefcase aria-hidden />
      {busy ? t("work.onboarding.turning_on") : t("work.onboarding.try")}
    </button>
  );
}

export function Chip(props: { selected: boolean; onClick: () => void; children: React.ReactNode; testId?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-60",
        props.selected ? "border-foreground/40 bg-foreground/[0.06] text-foreground" : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground",
      )}
    >
      {props.selected ? <Check aria-hidden className="size-3.5" /> : null}
      {props.children}
    </button>
  );
}

/** Accepts an invite (the link or its token): the account joins the teammate's company and Work turns on. */
function useJoinWork(client: WorkClient | null, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (link: string) => client!.acceptWorkInvite(link),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workOnboardingKey(client) });
      void queryClient.invalidateQueries({ queryKey: workStateKey(client) });
      toast.success(t("work.onboarding.joined"));
      onDone();
    },
    onError: (reason) => toast.error(errorText(reason)),
  });
}

/** Opened by an invite link (`omnirush://work/invite#t=…`): join the teammate's company, also while Work is hidden. */
export function WorkJoinDialog(props: { client: WorkClient | null; onJoined: () => void }) {
  const token = useWorkInviteStore((state) => state.token);
  const setToken = useWorkInviteStore((state) => state.setToken);
  const join = useJoinWork(props.client, () => { setToken(null); props.onJoined(); });
  return (
    <Dialog open={Boolean(token)} onOpenChange={(open) => { if (!open) setToken(null); }}>
      <DialogContent data-testid="work-join-invite">
        <DialogHeader>
          <DialogTitle>{t("work.onboarding.join_title")}</DialogTitle>
          <DialogDescription>
            {props.client ? t("work.onboarding.join_body") : t("work.onboarding.join_signed_out")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setToken(null)}>{t("work.common.not_now")}</Button>
          <Button disabled={!props.client || !token || join.isPending} onClick={() => { if (token) join.mutate(token); }} data-testid="work-join-invite-submit">
            {join.isPending ? t("work.onboarding.joining") : t("work.onboarding.join_team")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const TRUST_URL = "https://omnirush.ai/trust";
// Our own SOC 2 badge (contract D7); a release flips it when the CPA report arrives. Never "certified" before that.
export const SOC2_STATUS = { title: "SOC 2 Type II", get status() { return t("work.trust.status"); }, get alt() { return t("work.trust.alt"); } };

/** The SOC 2 status badge: outlined, neutral, the words "In progress" on the badge itself. */
export function TrustBadge() {
  return (
    <span role="img" aria-label={SOC2_STATUS.alt} title={SOC2_STATUS.alt} className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-foreground" data-testid="work-trust-badge">
      <ShieldCheck className="size-4 shrink-0" aria-hidden />
      <span className="flex flex-col leading-tight">
        <span className="text-[12px] font-semibold">{SOC2_STATUS.title}</span>
        <span className="text-[11px] text-muted-foreground">{SOC2_STATUS.status}</span>
      </span>
    </span>
  );
}

/** The two onboarding steps: the company (one screen), then connect a tool, try sample data or skip. */
export function WorkOnboarding(props: { client: WorkClient | null; email?: string | null; sources: string[]; openLink: (url: string) => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const setStarters = useWorkSetupStore((state) => state.setStarters);
  const [step, setStep] = useState<"company" | "connect">("company");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState(() => domainFromEmail(props.email));
  const [size, setSize] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [recommended, setRecommended] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<{ id: string; at: number } | null>(null);
  const offered = props.sources.filter((id) => id !== DEMO_SOURCE && id !== "mock");

  const save = useMutation({
    mutationFn: () => props.client!.saveWorkOnboarding({
      company: company.trim(), tools,
      ...(domain.trim() ? { domain: domain.trim() } : {}), ...(size ? { size } : {}), ...(role.trim() ? { role: role.trim() } : {}),
    }),
    onSuccess: (answer) => {
      if (answer.org?.id) setStarters(answer.org.id, answer.starters ?? []);
      setRecommended(answer.recommended_sources?.length ? answer.recommended_sources : tools);
      void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
      setStep("connect");
    },
    onError: (reason) => toast.error(errorText(reason)),
  });
  const connectors = useQuery({
    queryKey: workConnectorsKey(props.client),
    queryFn: () => props.client!.listWorkConnectors(),
    enabled: Boolean(props.client) && step === "connect",
    refetchInterval: connecting ? CONNECT_POLL_MS : false,
  });
  useEffect(() => {
    if (!connecting) return;
    if ((connectors.data ?? []).some((row) => row.id === connecting.id && isLinked(row))) setConnecting(null);
    else if (Date.now() - connecting.at > CONNECT_TIMEOUT_MS) {
      setConnecting(null);
      toast.error(t("work.common.sign_in_timeout"));
    }
  }, [connecting, connectors.data]);
  const connect = useMutation({
    mutationFn: (id: string) => props.client!.startWorkConnector(id),
    onSuccess: (answer, id) => { setConnecting({ id, at: Date.now() }); props.openLink(answer.auth_url); },
    onError: (reason) => toast.error(errorText(reason)),
  });
  const demo = useMutation({
    mutationFn: () => props.client!.seedWorkDemo(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
      props.onDone();
    },
    onError: (reason) => toast.error(errorText(reason)),
  });

  const [invite, setInvite] = useState("");
  const join = useJoinWork(props.client, props.onDone);

  const rows = connectOrder(connectors.data, recommended);
  const anyLinked = rows.some(isLinked);
  return (
    <div className="h-full overflow-y-auto" data-testid="work-onboarding" data-step={step}>
      <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center gap-6 px-6 py-10">
        <div className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted-foreground">{t("work.onboarding.step", { n: step === "company" ? 1 : 2 })}</div>
          <h1 className="text-balance text-[22px] font-semibold leading-[28px] tracking-[-0.02em]">
            {step === "company" ? t("work.onboarding.company_title") : t("work.home.connect")}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {step === "company" ? t("work.onboarding.company_body") : t("work.onboarding.connect_body")}
          </p>
        </div>

        {step === "company" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => { event.preventDefault(); if (company.trim() && !save.isPending) save.mutate(); }}
          >
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              {t("work.org.company_name")}
              <Input autoFocus required maxLength={200} value={company} onChange={(event) => setCompany(event.target.value)} placeholder={t("work.onboarding.company_placeholder")} data-testid="work-onboarding-company" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              {t("work.org.company_website")}
              <Input maxLength={253} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="acme-bakery.com" data-testid="work-onboarding-domain" />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">{t("work.org.team_size")}</span>
              <div className="flex flex-wrap gap-2">
                {sizeOptions().map(([value, label]) => <Chip key={value} selected={size === value} onClick={() => setSize(size === value ? null : value)}>{label}</Chip>)}
              </div>
            </div>
            {offered.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">{t("work.org.your_tools")}</span>
                <div className="flex flex-wrap gap-2">
                  {offered.map((id) => (
                    <Chip key={id} testId={`work-onboarding-tool-${id}`} selected={tools.includes(id)} onClick={() => setTools(tools.includes(id) ? tools.filter((tool) => tool !== id) : [...tools, id])}>
                      <ConnectorIcon id={id} className="size-3.5 text-current" />
                      {connectorLabel(id)}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              <span>{t("work.org.your_role")} <span className="font-normal text-muted-foreground">{t("work.onboarding.optional")}</span></span>
              <Input maxLength={100} value={role} onChange={(event) => setRole(event.target.value)} placeholder={t("work.org.role_placeholder")} />
            </label>
            <div className="flex justify-end">
              <Button type="submit" disabled={!company.trim() || save.isPending || !props.client} data-testid="work-onboarding-continue">
                {save.isPending ? t("work.common.saving") : t("work.common.continue")}<ArrowRight className="size-4" />
              </Button>
            </div>
          </form>
        ) : null}
        {step === "company" ? (
          <form
            className="flex flex-col gap-1.5 border-t border-border pt-5"
            data-testid="work-join"
            onSubmit={(event) => { event.preventDefault(); if (invite.trim() && !join.isPending) join.mutate(invite.trim()); }}
          >
            <span className="text-[13px] font-medium">{t("work.onboarding.join_a_team")}</span>
            <span className="text-[12px] text-muted-foreground">{t("work.onboarding.join_hint")}</span>
            <div className="flex items-center gap-2">
              <Input value={invite} onChange={(event) => setInvite(event.target.value)} placeholder={t("work.onboarding.paste_invite")} aria-label={t("work.onboarding.invite_link")} data-testid="work-join-link" />
              <Button type="submit" variant="outline" disabled={!invite.trim() || join.isPending || !props.client} data-testid="work-join-submit">{join.isPending ? t("work.onboarding.joining") : t("work.onboarding.join")}</Button>
            </div>
          </form>
        ) : null}
        {step === "company" ? (
          <div className="flex flex-wrap items-center gap-3" data-testid="work-onboarding-trust">
            <TrustBadge />
            <Button variant="link" size="sm" className="px-0" onClick={() => props.openLink(TRUST_URL)}>{t("work.onboarding.how_we_protect")}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-border bg-background">
              {connectors.isLoading ? <div className="px-4 py-6 text-sm text-muted-foreground">{t("common.loading")}</div> : rows.map((row: OmniRushWorkConnector) => (
                <div key={row.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0" data-work-connect={row.id}>
                  <ConnectorIcon id={row.id} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{connectorLabel(row.id, row.label)}</span>
                  {recommended.includes(row.id) && !isLinked(row) ? <Badge variant="secondary">{t("work.onboarding.recommended")}</Badge> : null}
                  {isLinked(row) ? (
                    <span className="flex items-center gap-1 text-[12px] text-muted-foreground"><Check className="size-3.5" />{t("work.connectors.status_connected")}</span>
                  ) : (
                    <Button size="sm" variant={recommended.includes(row.id) ? "default" : "outline"} disabled={connect.isPending || connecting?.id === row.id} onClick={() => connect.mutate(row.id)}>
                      {connecting?.id === row.id ? t("work.common.waiting_sign_in") : t("work.common.connect")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" disabled={demo.isPending || !props.client} onClick={() => demo.mutate()} data-testid="work-onboarding-demo">
                <Database className="size-4" />{demo.isPending ? t("work.onboarding.adding_demo") : t("work.onboarding.try_demo")}
              </Button>
              <Button variant={anyLinked ? "default" : "ghost"} onClick={props.onDone} data-testid="work-onboarding-finish">
                {anyLinked ? t("work.common.continue") : t("work.onboarding.skip")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The home's small first-run checklist (company, connected, first chat), until dismissed or done. */
export function WorkChecklist(props: { client: WorkClient | null; onboarding: Parameters<typeof checklistItems>[0]; connectors: OmniRushWorkConnector[] | undefined; orgId: string; onConnect: () => void; onInvite: () => void; onOrganization?: () => void }) {
  const hidden = useWorkSetupStore((state) => Boolean(state.checklistHidden[props.orgId]));
  const hide = useWorkSetupStore((state) => state.hideChecklist);
  const items = checklistItems(props.onboarding, props.connectors);
  if (hidden || items.every((item) => item.done)) return null;
  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3" data-testid="work-checklist">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{t("work.checklist.title")}</span>
        <button type="button" aria-label={t("work.checklist.hide")} onClick={() => hide(props.orgId)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /></button>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} data-checklist-item={item.id} data-done={item.done} className="flex items-center gap-2 text-[13px]">
            <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", item.done ? "border-transparent bg-foreground text-background" : "border-border")}>
              {item.done ? <Check aria-hidden className="size-3" /> : null}
            </span>
            {item.id === "connected" && !item.done
              ? <button type="button" className="text-start underline-offset-2 hover:underline" onClick={props.onConnect}>{item.label}</button>
              : <span className={item.done ? "text-muted-foreground line-through" : ""}>{item.label}</span>}
          </li>
        ))}
        <li className="flex items-center gap-2 text-[13px]">
          <UserPlus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <button type="button" className="text-start underline-offset-2 hover:underline" onClick={props.onInvite} data-testid="work-checklist-invite">{t("work.invite.title")}</button>
        </li>
        {props.onOrganization ? (
          <li className="flex items-center gap-2 text-[13px]">
            <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <button type="button" className="text-start underline-offset-2 hover:underline" onClick={props.onOrganization} data-testid="work-checklist-organization">{t("work.checklist.organization")}</button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Invite a teammate by e-mail: the server answers a link to share (they join the company and get Work). */
export function WorkInviteDialog(props: { client: WorkClient | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const rememberLink = useWorkInviteLinks((state) => state.remember);
  const invite = useMutation({
    mutationFn: () => props.client!.inviteWorkMember(email.trim()),
    onSuccess: (answer) => {
      setLink(answer.link);
      if (answer.id) rememberLink(answer.id, answer.link);
    },
    onError: (reason) => toast.error(errorText(reason)),
  });
  const close = (open: boolean) => {
    if (!open) { setEmail(""); setLink(null); }
    props.onOpenChange(open);
  };
  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent data-testid="work-invite">
        <DialogHeader>
          <DialogTitle>{t("work.invite.title")}</DialogTitle>
          <DialogDescription>{t("work.invite.body")}</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="flex items-center gap-2">
            <Input readOnly value={link} aria-label={t("work.onboarding.invite_link")} onFocus={(event) => event.currentTarget.select()} />
            <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success(t("work.common.link_copied")))}><Copy className="size-4" />{t("work.invite.copy")}</Button>
          </div>
        ) : (
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (email.trim()) invite.mutate(); }}>
            <Input type="email" autoFocus required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" aria-label={t("work.invite.email")} />
            <Button type="submit" disabled={!email.trim() || invite.isPending || !props.client}>{invite.isPending ? t("work.invite.inviting") : t("work.org.invite")}</Button>
          </form>
        )}
        <DialogFooter>
          {link ? <Button variant="ghost" onClick={() => { setEmail(""); setLink(null); }}>{t("work.invite.another")}</Button> : null}
          <Button variant="outline" onClick={() => close(false)}>{t("work.invite.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Sample data" badge with a one-click Remove, shown while the demo source is seeded. */
export function SampleDataBadge(props: { client: WorkClient | null }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => props.client!.removeWorkDemo(),
    onSuccess: () => {
      toast.success(t("work.onboarding.demo_removed"));
      void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
    },
    onError: (reason) => toast.error(errorText(reason)),
  });
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-7/50 bg-amber-2/50 py-0.5 pe-1 ps-2.5 text-[12px] text-amber-11" data-testid="work-sample-data">
      <Database aria-hidden className="size-3.5" />
      {t("work.connector.demo")}
      <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()} className="rounded-full px-2 py-0.5 font-medium hover:bg-amber-3 disabled:opacity-60" data-testid="work-sample-data-remove">
        {remove.isPending ? t("work.onboarding.removing") : t("common.remove")}
      </button>
    </span>
  );
}
