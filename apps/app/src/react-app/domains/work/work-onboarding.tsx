/** @jsxImportSource react */
// Work first run (contract Addendum B3): Try Work, the company step, the connect step, the home checklist, invites
// and the sample-data badge. Shown only while capabilities.work is enabled (or `available`, for Try Work).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Briefcase, Check, Copy, Database, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import type { OmniRushWorkConnector } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import {
  LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import {
  checklistItems, connectorLabel, connectOrder, DEMO_SOURCE, domainFromEmail, isLinked, useWorkInviteStore, useWorkSetupStore, useWorkState,
  workConnectorsKey, workOnboardingKey, workStateKey, type WorkClient,
} from "./work-mode";
import { CONNECT_POLL_MS, CONNECT_TIMEOUT_MS, ConnectorIcon } from "./work-views";

// The server's size values, with how they read.
const SIZES = [["1", "Just me"], ["2-10", "2–10"], ["11-50", "11–50"], ["51-200", "51–200"], ["201-1000", "201–1,000"], ["1000+", "1,000+"]] as const;
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : "That did not work. Try again.");

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
      {busy ? "Turning on Work…" : "Try Work"}
    </button>
  );
}

function Chip(props: { selected: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-testid={props.testId}
      onClick={props.onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors",
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
      toast.success("You joined your team");
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
          <DialogTitle>Join your team in Work</DialogTitle>
          <DialogDescription>
            {props.client
              ? "A teammate invited you to their company. Each person connects their own tools; nobody sees another person's data."
              : "Sign in with the e-mail address the invite was sent to, then open the invite link again."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setToken(null)}>Not now</Button>
          <Button disabled={!props.client || !token || join.isPending} onClick={() => { if (token) join.mutate(token); }} data-testid="work-join-invite-submit">
            {join.isPending ? "Joining…" : "Join team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      toast.error("Sign-in did not finish. Try connecting again.");
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
          <div className="text-[12px] font-medium text-muted-foreground">Step {step === "company" ? 1 : 2} of 2</div>
          <h1 className="text-balance text-[22px] font-semibold leading-[28px] tracking-[-0.02em]">
            {step === "company" ? "Set up Work for your company" : "Connect your tools"}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {step === "company"
              ? "Tell us a little about your company so Work can suggest where to start."
              : "Work searches and reads the tools you connect, and asks before it sends or changes anything."}
          </p>
        </div>

        {step === "company" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => { event.preventDefault(); if (company.trim() && !save.isPending) save.mutate(); }}
          >
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Company name
              <Input autoFocus required maxLength={200} value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Acme Bakery" data-testid="work-onboarding-company" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Company website
              <Input maxLength={253} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="acme-bakery.com" data-testid="work-onboarding-domain" />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Team size</span>
              <div className="flex flex-wrap gap-2">
                {SIZES.map(([value, label]) => <Chip key={value} selected={size === value} onClick={() => setSize(size === value ? null : value)}>{label}</Chip>)}
              </div>
            </div>
            {offered.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Tools you use</span>
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
              <span>Your role <span className="font-normal text-muted-foreground">(optional)</span></span>
              <Input maxLength={100} value={role} onChange={(event) => setRole(event.target.value)} placeholder="Operations manager" />
            </label>
            <div className="flex justify-end">
              <Button type="submit" disabled={!company.trim() || save.isPending || !props.client} data-testid="work-onboarding-continue">
                {save.isPending ? "Saving…" : "Continue"}<ArrowRight className="size-4" />
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
            <span className="text-[13px] font-medium">Join a team</span>
            <span className="text-[12px] text-muted-foreground">Got an invite from a teammate? Paste the link to join their company instead.</span>
            <div className="flex items-center gap-2">
              <Input value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="Paste invite link" aria-label="Invite link" data-testid="work-join-link" />
              <Button type="submit" variant="outline" disabled={!invite.trim() || join.isPending || !props.client} data-testid="work-join-submit">{join.isPending ? "Joining…" : "Join"}</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-border bg-background">
              {connectors.isLoading ? <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div> : rows.map((row: OmniRushWorkConnector) => (
                <div key={row.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0" data-work-connect={row.id}>
                  <ConnectorIcon id={row.id} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{connectorLabel(row.id, row.label)}</span>
                  {recommended.includes(row.id) && !isLinked(row) ? <Badge variant="secondary">Recommended</Badge> : null}
                  {isLinked(row) ? (
                    <span className="flex items-center gap-1 text-[12px] text-muted-foreground"><Check className="size-3.5" />Connected</span>
                  ) : (
                    <Button size="sm" variant={recommended.includes(row.id) ? "default" : "outline"} disabled={connect.isPending || connecting?.id === row.id} onClick={() => connect.mutate(row.id)}>
                      {connecting?.id === row.id ? "Waiting for sign-in…" : "Connect"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" disabled={demo.isPending || !props.client} onClick={() => demo.mutate()} data-testid="work-onboarding-demo">
                <Database className="size-4" />{demo.isPending ? "Adding sample data…" : "Try with sample data"}
              </Button>
              <Button variant={anyLinked ? "default" : "ghost"} onClick={props.onDone} data-testid="work-onboarding-finish">
                {anyLinked ? "Continue" : "Skip for now"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The home's small first-run checklist (company, connected, first chat), until dismissed or done. */
export function WorkChecklist(props: { client: WorkClient | null; onboarding: Parameters<typeof checklistItems>[0]; connectors: OmniRushWorkConnector[] | undefined; orgId: string; onConnect: () => void; onInvite: () => void }) {
  const hidden = useWorkSetupStore((state) => Boolean(state.checklistHidden[props.orgId]));
  const hide = useWorkSetupStore((state) => state.hideChecklist);
  const items = checklistItems(props.onboarding, props.connectors);
  if (hidden || items.every((item) => item.done)) return null;
  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3" data-testid="work-checklist">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">Get started</span>
        <button type="button" aria-label="Hide checklist" onClick={() => hide(props.orgId)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /></button>
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
          <button type="button" className="text-start underline-offset-2 hover:underline" onClick={props.onInvite} data-testid="work-checklist-invite">Invite teammates</button>
        </li>
      </ul>
    </div>
  );
}

/** Invite a teammate by e-mail: the server answers a link to share (they join the company and get Work). */
export function WorkInviteDialog(props: { client: WorkClient | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => props.client!.inviteWorkMember(email.trim()),
    onSuccess: (answer) => setLink(answer.link),
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
          <DialogTitle>Invite teammates</DialogTitle>
          <DialogDescription>They join your company in Work. Each person connects their own tools; nobody sees another person's data.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="flex items-center gap-2">
            <Input readOnly value={link} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
            <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success("Link copied"))}><Copy className="size-4" />Copy</Button>
          </div>
        ) : (
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (email.trim()) invite.mutate(); }}>
            <Input type="email" autoFocus required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" aria-label="Teammate e-mail" />
            <Button type="submit" disabled={!email.trim() || invite.isPending || !props.client}>{invite.isPending ? "Inviting…" : "Invite"}</Button>
          </form>
        )}
        <DialogFooter>
          {link ? <Button variant="ghost" onClick={() => { setEmail(""); setLink(null); }}>Invite another</Button> : null}
          <Button variant="outline" onClick={() => close(false)}>Done</Button>
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
      toast.success("Sample data removed");
      void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
    },
    onError: (reason) => toast.error(errorText(reason)),
  });
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-7/50 bg-amber-2/50 py-0.5 pe-1 ps-2.5 text-[12px] text-amber-11" data-testid="work-sample-data">
      <Database aria-hidden className="size-3.5" />
      Sample data
      <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()} className="rounded-full px-2 py-0.5 font-medium hover:bg-amber-3 disabled:opacity-60" data-testid="work-sample-data-remove">
        {remove.isPending ? "Removing…" : "Remove"}
      </button>
    </span>
  );
}

/** Settings > Preferences: invite teammates to the company, while Work is on for the account. */
export function WorkInviteSetting(props: { client: WorkClient | null }) {
  const state = useWorkState(props.client);
  const [open, setOpen] = useState(false);
  if (!state.data?.enabled) return null;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>Work teammates</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>Invite people from your company to Work. Each person connects their own tools.</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-invite" onClick={() => setOpen(true)}>Invite</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      <WorkInviteDialog client={props.client} open={open} onOpenChange={setOpen} />
    </LayoutSectionItem>
  );
}
