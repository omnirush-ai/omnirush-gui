/** @jsxImportSource react */
// Work first run (contract Addendum B3, enterprise design 2.3): Try Work, the stepped setup (company, tools, connect,
// invite, done), the home checklist and invites. Shown only while capabilities.work is enabled (or `available`, for Try
// Work). No sample data: setup connects real tools.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Briefcase, Building2, Check, Copy, UserPlus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkConnector, OmniRushWorkOnboardingResult, OmniRushWorkStart } from "@/app/lib/omnirush-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { isMacPlatform } from "@/app/utils";
import { cn } from "@/lib/utils";

import { BrandTile } from "./brand-icon";
import { pickerGroups, useWorkCatalog, type CatalogTool } from "./catalog";
import { useEnterpriseFlags } from "./enterprise-mode";
import { companyFromDomain, EmailChips, MoreConnectors, onboardingSteps, SizeChips, StarterRows, StepActions, StepBar, StepHeading, ToolPicker, type OnboardingStep } from "./onboarding-steps";
import {
  checklistItems, connectorLabel, connectorProgress, connectOrder, domainFromEmail, isLinked, isPausedByAdmin, setupLabel, useWorkInviteLinks, useWorkInviteStore, useWorkOnboarding, useWorkSetupStore,
  visibleConnectors, workConnectorsKey, workFailure, workMembersKey, workOnboardingKey, workRoleLabel, workStateKey, type WorkClient,
} from "./work-mode";
import { CONNECT_POLL_MS, CONNECT_TIMEOUT_MS, CredentialsForm, KeyForm, PROGRESS_POLL_MS, StartForm, SyncProgressBar } from "./work-views";

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

/** Accepts an invite (the link or its token): the account joins the teammate's company. Work turns on when the company
 *  grants it; otherwise the person is told it waits for OmniRush (the switch is read again after a join). */
function useJoinWork(client: WorkClient | null, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (link: string) => client!.acceptWorkInvite(link),
    onSuccess: async (answer) => {
      void queryClient.invalidateQueries({ queryKey: workOnboardingKey(client) });
      const state = await client!.getWorkState().catch(() => null);
      if (state) queryClient.setQueryData(workStateKey(client), state);
      else void queryClient.invalidateQueries({ queryKey: workStateKey(client) });
      if (state && !state.enabled) toast.info(t("work.setup.waiting_work", { name: answer.org?.name ?? t("work.setup.your_company") }));
      else toast.success(t("work.onboarding.joined"));
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

type Starter = { title: string; prompt: string };

/** An older server takes neither custom tools nor the new team sizes (422): the answer goes again without custom tools
 *  and with the nearest size it knows, so setup never gets stuck on a server that has not caught up. */
const LEGACY_SIZE: Record<string, string> = { "2-5": "2-10", "6-10": "2-10", "11-25": "11-50", "26-50": "11-50", "51-100": "51-200", "101-250": "51-200", "251-1000": "201-1000", "1000+": "1000+" };
const refused = (reason: unknown) => (reason as { status?: unknown } | null)?.status === 422 || (reason as { status?: unknown } | null)?.status === 400;
async function withOlderServer<T, I extends { size?: string; custom_tools?: string[] }>(input: I, send: (input: I) => Promise<T>): Promise<T> {
  try {
    return await send(input);
  } catch (reason) {
    if (!refused(reason) || (!input.custom_tools?.length && !(input.size && LEGACY_SIZE[input.size] !== input.size))) throw reason;
    const { custom_tools: _custom, ...rest } = input;
    return send({ ...rest, ...(input.size ? { size: LEGACY_SIZE[input.size] ?? input.size } : {}) } as I);
  }
}

/** Invites, one call each; an older server takes the address alone. How many went out, and the ones that did not. */
async function sendInvites(client: WorkClient, emails: string[], role: "member" | "admin"): Promise<{ sent: string[]; failed: { email: string; text: string }[] }> {
  const sent: string[] = [];
  const failed: { email: string; text: string }[] = [];
  for (const email of emails) {
    try {
      await client.inviteWorkMember(email, { role, sendEmail: true }).catch((reason: unknown) => {
        if (!refused(reason)) throw reason;
        return client.inviteWorkMember(email);
      });
      sent.push(email);
    } catch (reason) {
      failed.push({ email, text: errorText(reason) });
    }
  }
  return { sent, failed };
}

/** Where each picked tool stands in the connect step. */
type ConnectKind = "oauth" | "form" | "local" | "elsewhere";
function connectKind(row: OmniRushWorkConnector | undefined, tool: CatalogTool | undefined): ConnectKind {
  if (tool?.local_only) return "local";
  if (!row) return "elsewhere";
  if (row.mode === "import" || row.mode === "hook") return "elsewhere";
  return row.mode === "credentials" || row.mode === "key" || row.start_fields?.length ? "form" : "oauth";
}

/** One tool in the connect step: tile, name and what it includes, then Connect (sign-in page or its form inline), the
 *  bar while it syncs, or where to set it up. */
function ConnectStepRow(props: {
  id: string;
  tool: CatalogTool | undefined;
  row: OmniRushWorkConnector | undefined;
  client: WorkClient | null;
  openLink: (url: string) => void;
  connecting: boolean;
  busy: boolean;
  onConnect: () => void;
  onStart: (form: OmniRushWorkStart) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const row = props.row;
  const name = props.tool?.label ?? connectorLabel(props.id, row?.label);
  const kind = connectKind(row, props.tool);
  const linked = row ? isLinked(row) : false;
  const progress = row && linked ? connectorProgress(row.progress) : null;
  const paused = row ? isPausedByAdmin(row) : false;
  const detail = props.tool?.includes?.length ? props.tool.includes.join(", ") : null;
  return (
    <li className="border-b border-border last:border-b-0" data-work-connect={props.id} data-linked={linked}>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <BrandTile id={props.id} name={name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{name}</div>
          {paused ? <div className="truncate text-[12px] text-amber-11">{t("work.setup.turned_off")}</div>
            : progress ? <SyncProgressBar view={progress} name={name} />
              : linked && row?.account ? <div className="truncate text-[12px] text-muted-foreground">{row.account}</div>
                : kind === "local" || kind === "elsewhere" ? <div className="truncate text-[12px] text-muted-foreground">{t("work.setup.set_up_in_connectors")}</div>
                  : detail ? <div className="truncate text-[12px] text-muted-foreground">{detail}</div> : null}
        </div>
        {paused ? null : linked ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground" data-testid="work-onboarding-connected">
            <span className="size-1.5 rounded-full bg-green-9" aria-hidden />
            {row?.status === "syncing" ? t("work.connectors.status_syncing") : t("work.connectors.status_connected")}
          </span>
        ) : kind === "oauth" ? (
          <Button size="sm" variant="outline" disabled={props.busy || props.connecting} onClick={props.onConnect} aria-label={t("work.connectors.connect_name", { name })}>
            {props.connecting ? t("work.common.waiting_sign_in") : t("work.common.connect")}
          </Button>
        ) : kind === "form" ? (
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={t("work.connectors.connect_name", { name })}>
            {open ? t("common.cancel") : t("work.common.connect")}
          </Button>
        ) : null}
      </div>
      {/* GitHub: where the app is installed, and installing it on another organization. */}
      {linked && row?.setup_url ? (
        <div className="-mt-1 px-4 pb-2.5 ps-14">
          <button type="button" className="text-[12px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" onClick={() => props.openLink(row.setup_url!)}>
            {props.id === "github" ? t("work.setup.github_install_more") : setupLabel(props.id)}
          </button>
        </div>
      ) : null}
      {open && row && !linked ? (
        <div className="px-4 pb-3">
          {row.start_fields?.length
            ? <StartForm connector={row} busy={props.busy} onStart={(form) => { props.onStart(form); setOpen(false); }} onCancel={() => setOpen(false)} />
            : row.mode === "key"
              ? <KeyForm connector={row} client={props.client} openLink={props.openLink} onDone={() => { setOpen(false); props.onChanged(); }} onCancel={() => setOpen(false)} />
              : <CredentialsForm connector={row} client={props.client} openLink={props.openLink} onDone={() => { setOpen(false); props.onChanged(); }} onCancel={() => setOpen(false)} />}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Work's first run, one short step at a time with a bar on top: the company (name, website, team size, role), the tools
 * the team uses (search or add), connecting them, inviting the team (owners and admins), then a done screen with three
 * starters. A company made on the web starts at Connect with its picks; an invited member gets a welcome and Connect.
 */
export function WorkOnboarding(props: {
  client: WorkClient | null;
  email?: string | null;
  sources: string[];
  openLink: (url: string) => void;
  onDone: () => void;
  /** Starts a Work chat with a starter's prompt (the done screen). */
  onStart?: (prompt: string) => Promise<void>;
  onOpenConnectors?: () => void;
}) {
  const queryClient = useQueryClient();
  const setStarters = useWorkSetupStore((state) => state.setStarters);
  const finish = useWorkSetupStore((state) => state.finishOnboarding);
  const onboarding = useWorkOnboarding(props.client, Boolean(props.client));
  const members = useQuery({ queryKey: workMembersKey(props.client), queryFn: () => props.client!.listWorkMembers(), enabled: Boolean(props.client), retry: false });
  const catalog = useWorkCatalog(props.client, props.sources);
  const platform = { mac: isMacPlatform(), desktop: isDesktopRuntime() };
  const groups = pickerGroups(catalog, platform);
  const org = onboarding.data?.org ?? null;
  const role = members.data?.you_role ?? (org ? null : "owner");

  // The flow is fixed once the answers are in (saving the company must not change the steps under the person).
  const [frozen, setFlow] = useState<OnboardingStep[] | null>(null);
  const ready = !onboarding.isPending && (!org || !members.isPending);
  const flow = frozen ?? (ready ? onboardingSteps({ hasOrg: Boolean(org), role, changeTools: onboarding.data?.next === "tools" }) : null);
  useEffect(() => {
    if (!frozen && flow) setFlow(flow);
  }, [flow, frozen]);
  const [index, setIndex] = useState(0);
  const step = flow?.[index] ?? null;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (!step) return;
    if (firstStep.current) { firstStep.current = false; return; }
    titleRef.current?.focus();
  }, [step]);
  const go = (next: OnboardingStep) => {
    if (!flow) return;
    const at = flow.indexOf(next);
    if (at >= 0) { setIndex(at); return; }
    // "Change tools" from Connect: tools goes in before it.
    const list = [...flow.slice(0, index), next, ...flow.slice(index)];
    setFlow(list);
  };
  const forward = () => setIndex((at) => Math.min(at + 1, (flow?.length ?? 1) - 1));
  const back = index > 0 ? () => setIndex(index - 1) : undefined;

  // Answers. The company name and website start from the account's work e-mail.
  const emailDomain = domainFromEmail(props.email);
  const [company, setCompany] = useState(() => companyFromDomain(emailDomain));
  const [domain, setDomain] = useState(emailDomain);
  const [size, setSize] = useState<string | null>(null);
  const [jobRole, setJobRole] = useState("");
  const [tools, setTools] = useState<string[] | null>(null);
  const [custom, setCustom] = useState<string[] | null>(null);
  const picked = tools ?? org?.tools ?? [];
  const customPicked = custom ?? org?.custom_tools ?? [];
  const [starters, setLocalStarters] = useState<Starter[]>([]);
  const remembered = useWorkSetupStore((state) => (org?.id ? state.starters[org.id] : undefined));
  const sizeLabelId = useId();

  const onError = (reason: unknown) => toast.error(errorText(reason));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
    void queryClient.invalidateQueries({ queryKey: workMembersKey(props.client) });
  };
  const answer = (withTools: boolean) => ({
    company: company.trim(),
    tools: withTools ? picked.slice(0, 30) : [],
    ...(withTools && customPicked.length ? { custom_tools: customPicked } : {}),
    ...(domain.trim() ? { domain: domain.trim() } : {}),
    ...(size ? { size } : {}),
    ...(jobRole.trim() ? { role: jobRole.trim() } : {}),
  });
  const saved = (result: OmniRushWorkOnboardingResult) => {
    if (result.org?.id) setStarters(result.org.id, result.starters ?? []);
    setLocalStarters((result.starters ?? []).slice(0, 3));
    refresh();
  };
  // Step 1 saves the company at once (it is there if the app closes); step 2 saves it again with the tools.
  const saveCompany = useMutation({
    mutationFn: () => withOlderServer(answer(false), (input) => props.client!.saveWorkOnboarding(input)),
    onSuccess: (result) => { saved(result); forward(); },
    onError,
  });
  const saveTools = useMutation({
    mutationFn: async () => {
      if (flow?.[0] === "company") return withOlderServer(answer(true), (input) => props.client!.saveWorkOnboarding(input));
      await withOlderServer({ tools: picked.slice(0, 30), ...(customPicked.length ? { custom_tools: customPicked } : {}) }, (input) => props.client!.updateWorkOrg(input));
      return null;
    },
    onSuccess: (result) => { if (result) saved(result); else refresh(); go("connect"); },
    onError,
  });
  const saveWelcome = useMutation({
    mutationFn: () => props.client!.updateWorkOrgMe({ job_role: jobRole.trim() }),
    onSuccess: () => { refresh(); forward(); },
    onError,
  });

  // Connect: the account's connectors, polled while a sign-in or a first sync runs.
  const [connecting, setConnecting] = useState<{ id: string; at: number } | null>(null);
  const connectors = useQuery({
    queryKey: workConnectorsKey(props.client),
    queryFn: () => props.client!.listWorkConnectors(),
    enabled: Boolean(props.client) && step === "connect",
    refetchInterval: (query) => (connecting ? CONNECT_POLL_MS : query.state.data?.some((row) => connectorProgress(row.progress)) ? PROGRESS_POLL_MS : false),
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
    mutationFn: ({ id, form }: { id: string; form?: OmniRushWorkStart }) => props.client!.startWorkConnector(id, form),
    onSuccess: (result, { id }) => { setConnecting({ id, at: Date.now() }); props.openLink(result.auth_url); },
    onError,
  });
  const rows = visibleConnectors(connectors.data).filter((row) => row.id !== "mock");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const toolById = new Map(catalog.connectors.map((row) => [row.id, row]));
  const pickedIds = picked.filter((id) => byId.has(id) || toolById.get(id)?.local_only);
  const others = connectOrder(connectors.data).filter((row) => !pickedIds.includes(row.id));
  const anyLinked = rows.some(isLinked);

  // Invite (owners and admins).
  const [emails, setEmails] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const invite = useMutation({
    mutationFn: () => sendInvites(props.client!, emails, inviteRole),
    onSuccess: (result) => {
      if (result.sent.length) toast.success(t("work.setup.invites_sent", { count: result.sent.length, n: result.sent.length }));
      for (const failure of result.failed) toast.error(`${failure.email}: ${failure.text}`);
      setEmails(result.failed.map((failure) => failure.email));
      if (!result.failed.length) forward();
    },
    onError,
  });

  // Join a team instead (step 1): one link, folded.
  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const join = useJoinWork(props.client, props.onDone);

  const done = () => {
    if (org?.id) finish(org.id);
    else {
      const id = (queryClient.getQueryData<{ org?: { id?: string } | null }>(workOnboardingKey(props.client)))?.org?.id;
      if (id) finish(id);
    }
    props.onDone();
  };
  const [starting, setStarting] = useState(false);
  const startWith = async (prompt: string) => {
    if (!props.onStart || starting) return;
    setStarting(true);
    try { if (org?.id) finish(org.id); await props.onStart(prompt); } catch (reason) { onError(reason); } finally { setStarting(false); }
  };

  const shown: OnboardingStep[] = flow?.filter((item) => item !== "done") ?? [];
  const stepNumber = step ? Math.min(shown.indexOf(step), shown.length - 1) : 0;
  const finalStarters = (starters.length ? starters : remembered ?? []).slice(0, 3);
  const orgName = org?.name ?? company.trim();

  if (!flow || !step) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="work-onboarding" data-step="loading" aria-busy="true">
        <div className="w-full max-w-[560px] space-y-4 px-6">
          <Skeleton className="h-1 w-full rounded-full" />
          <Skeleton className="h-7 w-2/3 rounded-md" />
          <Skeleton className="h-[220px] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="work-onboarding" data-step={step === "done" ? shown.length + 1 : stepNumber + 1} data-step-name={step}>
      {/* One 560 px column; the tool picker gets more room so the whole catalog fits without scrolling. */}
      <div className={cn("mx-auto flex min-h-full w-full flex-col justify-center gap-6 px-6 py-8", step === "tools" ? "max-w-[780px]" : "max-w-[560px]")}>
        {step === "done" ? <StepBar total={shown.length} current={shown.length - 1} label={t("work.setup.all_done")} /> : <StepBar total={shown.length} current={stepNumber} />}
        <div key={step} className="flex flex-col gap-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
          {step === "company" ? (
            <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (company.trim() && !saveCompany.isPending) saveCompany.mutate(); }}>
              <StepHeading titleRef={titleRef} title={t("work.onboarding.company_title")} body={t("work.setup.company_body")} />
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  {t("work.org.company_name")}
                  <Input autoFocus required maxLength={200} value={company} onChange={(event) => setCompany(event.target.value)} placeholder={t("work.onboarding.company_placeholder")} data-testid="work-onboarding-company" />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  {t("work.org.company_website")}
                  <Input maxLength={253} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="acme.com" data-testid="work-onboarding-domain" />
                </label>
                <div className="flex flex-col gap-1.5">
                  <span id={sizeLabelId} className="text-[13px] font-medium">{t("work.org.team_size")}</span>
                  <SizeChips sizes={catalog.sizes} value={size} onChange={setSize} labelId={sizeLabelId} />
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  <span>{t("work.org.your_role")} <span className="font-normal text-muted-foreground">{t("work.onboarding.optional")}</span></span>
                  <Input maxLength={100} value={jobRole} onChange={(event) => setJobRole(event.target.value)} placeholder={t("work.org.role_placeholder")} />
                </label>
              </div>
              <StepActions primary={(
                <Button type="submit" disabled={!company.trim() || saveCompany.isPending || !props.client} data-testid="work-onboarding-continue">
                  {saveCompany.isPending ? t("work.common.saving") : t("work.common.continue")}<ArrowRight className="size-4" />
                </Button>
              )} />
              <div className="border-t border-border pt-4" data-testid="work-join">
                {joinOpen ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-muted-foreground">{t("work.onboarding.join_hint")}</span>
                    <div className="flex items-center gap-2">
                      <Input autoFocus value={inviteLink} onChange={(event) => setInviteLink(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (inviteLink.trim() && !join.isPending) join.mutate(inviteLink.trim()); } }} placeholder={t("work.onboarding.paste_invite")} aria-label={t("work.onboarding.invite_link")} data-testid="work-join-link" />
                      <Button type="button" variant="outline" disabled={!inviteLink.trim() || join.isPending || !props.client} onClick={() => join.mutate(inviteLink.trim())} data-testid="work-join-submit">{join.isPending ? t("work.onboarding.joining") : t("work.onboarding.join")}</Button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setJoinOpen(true)} className="text-[13px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" data-testid="work-join-open">
                    {t("work.setup.joining_team")}
                  </button>
                )}
              </div>
            </form>
          ) : step === "welcome" ? (
            <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (jobRole.trim()) saveWelcome.mutate(); else forward(); }}>
              <StepHeading titleRef={titleRef} title={t("work.setup.welcome_title", { name: orgName || t("work.setup.your_company") })} body={t("work.setup.welcome_body")} />
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                <span>{t("work.org.your_role")} <span className="font-normal text-muted-foreground">{t("work.onboarding.optional")}</span></span>
                <Input autoFocus maxLength={100} value={jobRole} onChange={(event) => setJobRole(event.target.value)} placeholder={t("work.org.role_placeholder")} data-testid="work-onboarding-role" />
              </label>
              <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-[13px] leading-5 text-muted-foreground" data-testid="work-onboarding-privacy">{t("work.setup.privacy_line")}</p>
              <StepActions primary={<Button type="submit" disabled={saveWelcome.isPending} data-testid="work-onboarding-continue">{t("work.common.continue")}<ArrowRight className="size-4" /></Button>} />
            </form>
          ) : step === "tools" ? (
            <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (!saveTools.isPending) saveTools.mutate(); }}>
              <StepHeading titleRef={titleRef} title={t("work.setup.tools_title")} body={t("work.setup.tools_body")} />
              <ToolPicker
                groups={groups}
                selected={picked}
                custom={customPicked}
                onToggle={(id) => setTools(picked.includes(id) ? picked.filter((item) => item !== id) : [...picked, id].slice(0, 30))}
                onCustom={setCustom}
              />
              <StepActions
                onBack={back}
                onSkip={() => go("connect")}
                primary={<Button type="submit" disabled={saveTools.isPending || !props.client} data-testid="work-onboarding-continue">{saveTools.isPending ? t("work.common.saving") : t("work.common.continue")}<ArrowRight className="size-4" /></Button>}
              />
            </form>
          ) : step === "connect" ? (
            <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); forward(); }}>
              <StepHeading titleRef={titleRef} title={t("work.home_connect")} body={t("work.setup.connect_body")} />
              {connectors.isLoading ? <Skeleton className="h-[168px] rounded-xl" /> : (
                <div className="flex flex-col gap-3">
                  {pickedIds.length ? (
                    <ul className="overflow-hidden rounded-xl border border-border bg-background" data-testid="work-onboarding-connect-list">
                      {pickedIds.map((id) => (
                        <ConnectStepRow
                          key={id}
                          id={id}
                          tool={toolById.get(id)}
                          row={byId.get(id)}
                          client={props.client}
                          openLink={props.openLink}
                          connecting={connecting?.id === id}
                          busy={connect.isPending}
                          onConnect={() => connect.mutate({ id })}
                          onStart={(form) => connect.mutate({ id, form })}
                          onChanged={() => void connectors.refetch()}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground" data-testid="work-onboarding-connect-none">{t("work.setup.connect_none")}</p>
                  )}
                  {customPicked.length ? <p className="text-[13px] text-muted-foreground" data-testid="work-onboarding-noted">{t("work.setup.noted", { count: customPicked.length, names: customPicked.join(", ") })}</p> : null}
                  {flow.includes("tools") || flow[0] === "connect" ? (
                    <button type="button" onClick={() => go("tools")} className="self-start text-[13px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" data-testid="work-onboarding-change-tools">{t("work.setup.change_tools")}</button>
                  ) : null}
                  <MoreConnectors count={others.length}>
                    <ul className="overflow-hidden rounded-xl border border-border bg-background">
                      {others.map((row) => (
                        <ConnectStepRow
                          key={row.id}
                          id={row.id}
                          tool={toolById.get(row.id)}
                          row={row}
                          client={props.client}
                          openLink={props.openLink}
                          connecting={connecting?.id === row.id}
                          busy={connect.isPending}
                          onConnect={() => connect.mutate({ id: row.id })}
                          onStart={(form) => connect.mutate({ id: row.id, form })}
                          onChanged={() => void connectors.refetch()}
                        />
                      ))}
                    </ul>
                  </MoreConnectors>
                </div>
              )}
              <StepActions
                onBack={back}
                onSkip={anyLinked ? undefined : forward}
                primary={<Button type="submit" variant={anyLinked ? "default" : "outline"} data-testid="work-onboarding-continue">{t("work.common.continue")}<ArrowRight className="size-4" /></Button>}
              />
            </form>
          ) : step === "invite" ? (
            <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (emails.length && !invite.isPending) invite.mutate(); else if (!emails.length) forward(); }}>
              <StepHeading titleRef={titleRef} title={t("work.invite.title")} body={t("work.setup.invite_body")} />
              <div className="flex flex-col gap-3">
                <EmailChips emails={emails} onChange={setEmails} disabled={invite.isPending} />
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="text-muted-foreground">{t("work.setup.invite_as")}</span>
                  <div role="radiogroup" aria-label={t("work.setup.invite_as")} className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
                    {(["member", "admin"] as const).map((value) => (
                      <button key={value} type="button" role="radio" aria-checked={inviteRole === value} onClick={() => setInviteRole(value)} className={cn("h-7 rounded-md px-2.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", inviteRole === value ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border" : "text-muted-foreground hover:text-foreground")} data-invite-role={value}>
                        {workRoleLabel(value)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <StepActions
                onBack={back}
                onSkip={forward}
                primary={<Button type="submit" disabled={!emails.length || invite.isPending} data-testid="work-onboarding-send-invites">{invite.isPending ? t("work.invite.inviting") : t("work.setup.send_invites")}</Button>}
              />
            </form>
          ) : (
            <div className="flex flex-col gap-6" data-testid="work-onboarding-done">
              <StepHeading titleRef={titleRef} title={t("work.setup.done_title")} body={finalStarters.length ? t("work.setup.done_body") : t("work.setup.done_body_plain")} />
              {finalStarters.length && props.onStart ? <StarterRows starters={finalStarters} busy={starting} onStart={(prompt) => void startWith(prompt)} /> : null}
              <div className="flex items-center justify-between gap-2">
                {props.onOpenConnectors && picked.some((id) => connectKind(byId.get(id), toolById.get(id)) !== "oauth" && connectKind(byId.get(id), toolById.get(id)) !== "form") ? (
                  <Button type="button" variant="ghost" size="sm" className="-ms-2 text-muted-foreground" onClick={() => { if (org?.id) finish(org.id); props.onOpenConnectors?.(); }}>{t("work.setup.open_connectors")}</Button>
                ) : <span />}
                <Button type="button" autoFocus onClick={done} data-testid="work-onboarding-finish">{t("work.setup.open_work")}<ArrowRight className="size-4" /></Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Who may invite: anyone in a pilot company, the owner and admins of a company account (the server checks too). */
export const canInviteRole = (role: string | null | undefined, enterprise: boolean) => !enterprise || role === "owner" || role === "admin";

/** The checklist's rows for this person: "Add your company" only for the owner, invites only for those who may. */
export function checklistRows(items: ReturnType<typeof checklistItems>, role: string | null | undefined) {
  return items.filter((item) => item.id !== "company" || role === "owner");
}

/** Whether the home shows the checklist now (not dismissed on this device, something left). */
export function useChecklistShown(onboarding: Parameters<typeof checklistItems>[0], connectors: OmniRushWorkConnector[] | undefined, orgId: string | null, role: string | null | undefined): boolean {
  const hidden = useWorkSetupStore((state) => Boolean(orgId && state.checklistHidden[orgId]));
  if (!orgId || hidden) return false;
  return checklistRows(checklistItems(onboarding, connectors), role).some((item) => !item.done);
}

/** The home's small first-run checklist (company, connected, first chat), until dismissed or done. Role aware: a
 *  member never sees the company step or an invite the server would refuse. */
export function WorkChecklist(props: { client: WorkClient | null; onboarding: Parameters<typeof checklistItems>[0]; connectors: OmniRushWorkConnector[] | undefined; orgId: string; role?: string | null; onConnect: () => void; onInvite: () => void; onOrganization?: () => void }) {
  const hide = useWorkSetupStore((state) => state.hideChecklist);
  const enterprise = useEnterpriseFlags();
  const shown = useChecklistShown(props.onboarding, props.connectors, props.orgId, props.role);
  const items = checklistRows(checklistItems(props.onboarding, props.connectors), props.role);
  const invite = Boolean(props.role) && canInviteRole(props.role, enterprise.on);
  if (!shown) return null;
  const link = "rounded text-start outline-none underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3" data-testid="work-checklist">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">{t("work.checklist.title")}</span>
        <button type="button" aria-label={t("work.checklist.hide")} onClick={() => hide(props.orgId)} className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id} data-checklist-item={item.id} data-done={item.done} className="flex items-center gap-2 text-[13px]">
            <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", item.done ? "border-transparent bg-foreground text-background" : "border-border")}>
              {item.done ? <Check aria-hidden className="size-3" /> : null}
            </span>
            {item.id === "connected" && !item.done
              ? <button type="button" className={cn(link, "font-medium")} onClick={props.onConnect} data-testid="work-checklist-connect">{item.label}</button>
              : <span className={item.done ? "text-muted-foreground line-through" : ""}>{item.label}</span>}
          </li>
        ))}
        {invite ? (
          <li className="flex items-center gap-2 text-[13px]">
            <UserPlus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <button type="button" className={link} onClick={props.onInvite} data-testid="work-checklist-invite">{t("work.invite.title")}</button>
          </li>
        ) : null}
        {props.onOrganization ? (
          <li className="flex items-center gap-2 text-[13px]">
            <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <button type="button" className={link} onClick={props.onOrganization} data-testid="work-checklist-organization">{t("work.checklist.organization")}</button>
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
