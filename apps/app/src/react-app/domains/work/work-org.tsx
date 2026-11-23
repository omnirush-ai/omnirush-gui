/** @jsxImportSource react */
// Settings > Work > Organization (contract Addendum C2): the company profile (owner edits), the member's own role and
// tools, members, pending invites, removing, transferring and leaving. Each person's connectors stay their own; the owner
// and admins pick which connectors members see (Connectors for your team), and the owner makes admins.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Copy, RotateCw, UserPlus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { OmniRushWorkMember, OmniRushWorkMembers, OmniRushWorkOrgConnector, OmniRushWorkOrgConnectors } from "@/app/lib/omnirush-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { isMacPlatform } from "@/app/utils";
import { cn } from "@/lib/utils";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import {
  LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { connectorLabel, DEMO_SOURCE, useWorkInviteLinks, useWorkOrgConnectors, useWorkState, workConnectorsKey, workFailure, workMembersKey, workOnboardingKey, workOrgConnectorsKey, workRoleLabel, workStateKey, WORK_ONBOARDING_ROUTE, WORK_ORG_ROUTE, type WorkClient } from "./work-mode";
import { BrandTile } from "./brand-icon";
import { pickerGroups, toolLabel, useWorkCatalog } from "./catalog";
import { useEnterpriseFlags } from "./enterprise-mode";
import { OrgCloudSection } from "./cloud/org-cloud";
import { workCloud } from "./cloud/cloud-model";
import { SizeChips, ToolPicker } from "./onboarding-steps";
import { TRUST_URL, WorkInviteDialog } from "./work-onboarding";

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

type Confirm = { kind: "remove" | "transfer"; member: OmniRushWorkMember } | { kind: "leave" } | { kind: "hide"; connector: OmniRushWorkOrgConnector } | null;

/** What leaving means for this person: blocked for an owner with others, the org goes for a sole owner. */
export function leaveState(data: Pick<OmniRushWorkMembers, "members" | "you_role"> | undefined): { blocked: boolean; message: string } {
  const owner = data?.you_role === "owner";
  const others = (data?.members ?? []).filter((member) => !member.you).length;
  if (owner && others > 0) return { blocked: true, message: t("work.org.leave_blocked") };
  if (owner) return { blocked: false, message: t("work.org.leave_sole_owner") };
  return { blocked: false, message: t("work.org.leave_member") };
}

/** The PATCH /work/org/connectors body after one switch. Before any choice (`shown` null) every connector shows, also the
 *  ones offered later; the first switch turned off makes it a list. Once it is a list, ids on it that this page does not
 *  offer right now (switched off for everyone, or not set up on this server) stay on it, so a save never changes what
 *  the page does not show, and no "all" (null) is sent that would bring back ones the company turned off. Staff's own
 *  list refuses ids outside it, so with one only the listed ids are sent. */
export function nextShown(view: Pick<OmniRushWorkOrgConnectors, "allowed" | "shown" | "staff_limited">, id: string, on: boolean): string[] | null {
  const allowed = view.allowed ?? [];
  const listed = allowed.filter((row) => (row.id === id ? on : row.shown)).map((row) => row.id);
  if (!Array.isArray(view.shown)) return listed.length === allowed.length ? null : listed;
  const offered = new Set(allowed.map((row) => row.id));
  const kept = view.staff_limited ? [] : view.shown.filter((item) => !offered.has(item));
  return [...new Set([...listed, ...kept])];
}

/** The PATCH /work/org/me body: the role, and tools only when the person changed them. The server keeps one tools
 *  list per person and an owner's is the company's, so sending an untouched (empty) list would wipe it. */
export function mePatch(draft: { job_role?: string; tools?: string[] }, you: Pick<OmniRushWorkMember, "job_role"> | null): { job_role: string; tools?: string[] } {
  return { job_role: (draft.job_role ?? you?.job_role ?? "").trim(), ...(draft.tools ? { tools: draft.tools } : {}) };
}

function Section(props: { title: string; description?: string; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-3" data-testid={props.testId}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{props.title}</h2>
          {props.description ? <p className="text-[12px] text-muted-foreground">{props.description}</p> : null}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

function ToolChips(props: { offered: string[]; selected: string[]; onChange: (tools: string[]) => void; disabled?: boolean; testId?: string; label?: (id: string) => string }) {
  if (!props.offered.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={props.testId}>
      {props.offered.map((id) => {
        const selected = props.selected.includes(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            disabled={props.disabled}
            onClick={() => props.onChange(toggle(props.selected, id))}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full border ps-1 pe-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
              selected ? "border-foreground/50 bg-foreground/[0.06] text-foreground" : "border-border text-foreground/90 hover:border-foreground/30 hover:bg-muted/60",
            )}
          >
            <BrandTile id={id} size="chip" className="rounded-full" />
            {props.label ? props.label(id) : connectorLabel(id)}
          </button>
        );
      })}
    </div>
  );
}

/** The company's tools as read-only tiles (everyone but the owner, who edits them). */
function ToolList(props: { ids: string[]; custom: string[]; label: (id: string) => string }) {
  if (!props.ids.length && !props.custom.length) return <span className="text-[13px] text-muted-foreground">{t("work.org.no_tools")}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid="work-org-tool-list">
      {props.ids.map((id) => (
        <li key={id} className="flex h-8 items-center gap-1.5 rounded-full border border-border ps-1 pe-3 text-[13px]"><BrandTile id={id} size="chip" className="rounded-full" />{props.label(id)}</li>
      ))}
      {props.custom.map((name) => (
        <li key={`custom:${name}`} className="flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border ps-1 pe-3 text-[13px]" data-custom-tool={name}><BrandTile name={name} size="chip" className="rounded-full" />{name}</li>
      ))}
    </ul>
  );
}

/** Connectors for your team (owner or admin): every connector the company may use, a switch each and how many people
 *  connected it. Members only see the ones switched on. `pending` is the list being saved, shown at once. */
function TeamConnectors(props: { view: OmniRushWorkOrgConnectors; pending: string[] | null | undefined; busy: boolean; onChange: (row: OmniRushWorkOrgConnector, on: boolean) => void }) {
  const allowed = props.view.allowed ?? [];
  const isOn = (row: OmniRushWorkOrgConnector) => (props.pending === undefined ? row.shown : props.pending === null || props.pending.includes(row.id));
  const on = allowed.filter(isOn).length;
  return (
    <Section
      title={t("work.org.team_connectors")}
      description={t("work.org.team_connectors_hint")}
      testId="work-org-connectors"
      actions={allowed.length ? <span className="shrink-0 text-[12px] text-muted-foreground" data-testid="work-org-connectors-count">{t("work.org.team_on", { on, total: allowed.length })}</span> : null}
    >
      {allowed.length ? (
        <ul className="rounded-xl border border-border">
          {allowed.map((row) => {
            const name = connectorLabel(row.id, row.label);
            return (
              <li key={row.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0" data-org-connector={row.id} data-shown={isOn(row)}>
                <BrandTile id={row.id} name={name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{t("work.org.team_connected", { count: row.members_connected, n: row.members_connected.toLocaleString() })}</div>
                </div>
                <Switch aria-label={t("work.org.team_switch_for", { name })} checked={isOn(row)} disabled={props.busy} onCheckedChange={(checked: boolean) => props.onChange(row, checked)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-border px-4 py-3 text-[13px] text-muted-foreground">{t("work.connectors.none")}</div>
      )}
      {props.view.staff_limited ? <p className="text-[12px] text-muted-foreground" data-testid="work-org-connectors-limited">{t("work.org.team_connectors_limited")}</p> : null}
    </Section>
  );
}

/** Work > Organization (opened from Settings and the home checklist). */
export function WorkOrganizationPage(props: { client: WorkClient | null; openLink: (url: string) => void; onBack: () => void; backLabel?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const state = useWorkState(props.client);
  const offered = (state.data?.sources ?? []).filter((id) => id !== DEMO_SOURCE && id !== "mock");
  const catalog = useWorkCatalog(props.client, state.data?.sources ?? []);
  const groups = pickerGroups(catalog, { mac: isMacPlatform(), desktop: isDesktopRuntime() });
  const label = (id: string) => toolLabel(catalog, id);
  const sizeLabelId = useId();
  // A company account: members read, admins invite and remove members, the owner does everything (the server checks).
  const enterprise = useEnterpriseFlags();
  const links = useWorkInviteLinks((store) => store.links);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const query = useQuery({ queryKey: workMembersKey(props.client), queryFn: () => props.client!.listWorkMembers(), enabled: Boolean(props.client), retry: false });
  const data = query.data;
  const org = data?.org ?? null;
  const owner = data?.you_role === "owner";
  const admin = data?.you_role === "admin";
  const canInvite = !enterprise.on || owner || admin;
  const canRemove = (member: OmniRushWorkMember) => owner || (enterprise.on && admin && member.role === "member");
  const you = data?.members.find((member) => member.you) ?? null;
  // The company's connector list; an older server has none (404), so the page stays as it was: no section, no admins.
  const teamQuery = useWorkOrgConnectors(props.client, Boolean(org));
  const team = teamQuery.data?.can_manage && teamQuery.data.allowed ? teamQuery.data : null;
  const rolesKnown = Boolean(teamQuery.data);

  // Edits in progress; null shows what the server has.
  const saved = { name: org?.name ?? "", domain: org?.domain ?? "", size: org?.size ?? "", industry: org?.industry ?? "", tools: org?.tools ?? [], custom: org?.custom_tools ?? [] };
  const [companyDraft, setCompany] = useState<typeof saved | null>(null);
  const company = companyDraft ?? saved;
  const companyChanged = (["name", "domain", "size", "industry"] as const).some((field) => company[field].trim() !== saved[field].trim()) || !sameList(company.tools, saved.tools) || !sameList(company.custom, saved.custom);
  // A size saved before the smaller bands (2-10, 11-50, …) shows as it was, first.
  const sizes = company.size && !catalog.sizes.includes(company.size) ? [company.size, ...catalog.sizes] : catalog.sizes;
  // Only the fields the person touched: the server keeps one tools list per person, and an owner's is the company's.
  const [mineDraft, setMine] = useState<{ job_role?: string; tools?: string[] }>({});
  const mine = { job_role: mineDraft.job_role ?? you?.job_role ?? "", tools: mineDraft.tools ?? you?.tools ?? [] };
  const mineChanged = mine.job_role.trim() !== (you?.job_role ?? "").trim() || (mineDraft.tools !== undefined && !sameList(mineDraft.tools, you?.tools ?? []));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workMembersKey(props.client) });
    void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
    void queryClient.invalidateQueries({ queryKey: workOrgConnectorsKey(props.client) });
  };
  const onError = (reason: unknown) => toast.error(workFailure(reason).text);
  const saveOrg = useMutation({
    mutationFn: () => props.client!.updateWorkOrg({
      name: company.name.trim(), tools: company.tools,
      // Custom tools go only when changed: an older server does not take them.
      ...(!sameList(company.custom, saved.custom) ? { custom_tools: company.custom } : {}),
      ...(company.domain.trim() ? { domain: company.domain.trim() } : {}), ...(company.size ? { size: company.size } : {}), ...(company.industry.trim() ? { industry: company.industry.trim() } : {}),
    }),
    onSuccess: () => { toast.success(t("work.org.company_saved")); setCompany(null); refresh(); },
    onError,
  });
  const saveMine = useMutation({
    mutationFn: () => props.client!.updateWorkOrgMe(mePatch(mineDraft, you)),
    onSuccess: () => { toast.success(t("work.org.saved")); setMine({}); refresh(); },
    onError,
  });
  const cancelInvite = useMutation({ mutationFn: (id: string) => props.client!.cancelWorkInvite(id), onSuccess: () => { toast.success(t("work.org.invite_cancelled")); refresh(); }, onError });
  const remove = useMutation({ mutationFn: (id: string) => props.client!.removeWorkMember(id), onSuccess: () => { toast.success(t("work.org.member_removed")); refresh(); }, onError });
  const transfer = useMutation({ mutationFn: (id: string) => props.client!.transferWorkOrg(id), onSuccess: () => { toast.success(t("work.org.transferred")); refresh(); }, onError });
  const saveShown = useMutation({
    mutationFn: (shown: string[] | null) => props.client!.setWorkOrgConnectors(shown),
    onSuccess: (view) => {
      queryClient.setQueryData(workOrgConnectorsKey(props.client), view);
      // This person's own connectors and Work sources follow the company's list too.
      void queryClient.invalidateQueries({ queryKey: workConnectorsKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
    },
    onError,
  });
  const showConnector = (row: OmniRushWorkOrgConnector, on: boolean) => {
    // Turning off one that people use pauses their connection: ask first.
    if (!on && row.members_connected > 0) setConfirm({ kind: "hide", connector: row });
    else if (team) saveShown.mutate(nextShown(team, row.id, on));
  };
  const setRole = useMutation({
    mutationFn: (change: { member: OmniRushWorkMember; role: "admin" | "member" }) => props.client!.setWorkMemberRole(change.member.user_id, change.role),
    onSuccess: (_answer, change) => {
      toast.success(change.role === "admin" ? t("work.org.made_admin", { email: change.member.email }) : t("work.org.removed_admin", { email: change.member.email }));
      refresh();
    },
    onError,
  });
  const leave = useMutation({
    mutationFn: () => props.client!.leaveWorkOrg(),
    onSuccess: () => {
      toast.success(t("work.org.left"));
      refresh();
      void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
      props.onBack();
    },
    onError,
  });
  const leaving = leaveState(data);
  const failure = query.error && !data ? workFailure(query.error) : null;

  return (
    <div className="h-full overflow-y-auto" data-testid="work-organization">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-10 pt-10">
        <div>
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? t("work.common.back_to_work")}</Button>
          <h1 className="text-xl font-semibold tracking-tight">{t("work.nav.organization")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("work.org.subtitle")}</p>
        </div>

        {query.isLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true" data-testid="work-org-loading">
            <Skeleton className="h-5 w-24 rounded-md" />
            <Skeleton className="h-[220px] rounded-xl" />
          </div>
        ) : failure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-org-error">
            <span className="text-sm text-muted-foreground">{failure.text}</span>
            {failure.retry ? <Button variant="outline" size="sm" onClick={() => void query.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
          </div>
        ) : !org ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-border px-4 py-4" data-testid="work-org-none">
            <span className="text-sm text-muted-foreground">{t("work.org.none")}</span>
            <Button size="sm" onClick={() => navigate(WORK_ONBOARDING_ROUTE)}>{t("work.org.set_up")}</Button>
          </div>
        ) : (
          <>
            <Section title={t("work.org.company")} description={owner ? undefined : t("work.org.owner_only")} testId="work-org-company">
              <form
                className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
                onSubmit={(event) => { event.preventDefault(); if (owner && company.name.trim() && companyChanged && !saveOrg.isPending) saveOrg.mutate(); }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                    {t("work.org.company_name")}
                    <Input required maxLength={200} disabled={!owner} value={company.name} onChange={(event) => setCompany({ ...company, name: event.target.value })} data-testid="work-org-name" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                    {t("work.org.company_website")}
                    <Input maxLength={253} disabled={!owner} value={company.domain} onChange={(event) => setCompany({ ...company, domain: event.target.value })} placeholder="example.com" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] font-medium sm:col-span-2">
                    {t("work.org.industry")}
                    <Input maxLength={100} disabled={!owner} value={company.industry} onChange={(event) => setCompany({ ...company, industry: event.target.value })} placeholder={t("work.org.industry_placeholder")} />
                  </label>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span id={sizeLabelId} className="text-[13px] font-medium">{t("work.org.team_size")}</span>
                  <SizeChips sizes={sizes} value={company.size || null} disabled={!owner} labelId={sizeLabelId} onChange={(size) => setCompany({ ...company, size: size ?? "" })} />
                </div>
                <div className="flex flex-col gap-1.5" data-testid="work-org-tools">
                  <span className="text-[13px] font-medium">{t("work.org.company_tools")}</span>
                  {owner && groups.length ? (
                    <ToolPicker groups={groups} selected={company.tools} custom={company.custom} onToggle={(id) => setCompany({ ...company, tools: toggle(company.tools, id) })} onCustom={(custom) => setCompany({ ...company, custom })} />
                  ) : (
                    <ToolList ids={company.tools} custom={company.custom} label={label} />
                  )}
                </div>
                {owner ? (
                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={!company.name.trim() || !companyChanged || saveOrg.isPending} data-testid="work-org-save">{saveOrg.isPending ? t("work.common.saving") : t("common.save")}</Button>
                  </div>
                ) : null}
              </form>
            </Section>

            <Section title={t("work.org.you")} description={owner ? t("work.org.you_hint_owner") : t("work.org.you_hint")} testId="work-org-me">
              <form
                className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
                onSubmit={(event) => { event.preventDefault(); if (mineChanged && !saveMine.isPending) saveMine.mutate(); }}
              >
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  {t("work.org.your_role")}
                  <Input maxLength={100} value={mine.job_role} onChange={(event) => setMine({ ...mineDraft, job_role: event.target.value })} placeholder={t("work.org.role_placeholder")} data-testid="work-org-role" />
                </label>
                {/* An owner's own tools are the company's (one list on the server): the picker above edits them. */}
                {offered.length && !owner ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">{t("work.org.your_tools")}</span>
                    <ToolChips offered={offered} selected={mine.tools} label={label} onChange={(tools) => setMine({ ...mineDraft, tools })} testId="work-org-my-tools" />
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" variant="outline" disabled={!mineChanged || saveMine.isPending} data-testid="work-org-me-save">{saveMine.isPending ? t("work.common.saving") : t("common.save")}</Button>
                </div>
              </form>
            </Section>

            <Section
              title={t("work.org.members")}
              description={owner && rolesKnown ? t("work.org.members_hint") : undefined}
              testId="work-org-members"
              actions={canInvite ? <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)} data-testid="work-org-invite"><UserPlus className="size-4" />{t("work.org.invite")}</Button> : null}
            >
              <ul className="rounded-xl border border-border">
                {(data?.members ?? []).map((member) => (
                  <li key={member.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-member={member.user_id} data-role={member.role}>
                    <div className="min-w-[12rem] flex-1">
                      <div className="truncate text-sm font-medium">{member.email}{member.you ? <span className="font-normal text-muted-foreground"> {t("work.org.you_tag")}</span> : null}</div>
                      {member.job_role ? <div className="truncate text-[12px] text-muted-foreground">{member.job_role}</div> : null}
                    </div>
                    <Badge variant={member.role === "owner" ? "default" : "secondary"}>{workRoleLabel(member.role)}</Badge>
                    {owner && !member.you ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {rolesKnown && member.role !== "owner" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={setRole.isPending && setRole.variables?.member.user_id === member.user_id}
                            onClick={() => setRole.mutate({ member, role: member.role === "admin" ? "member" : "admin" })}
                            data-testid="work-org-member-role"
                          >
                            {member.role === "admin" ? t("work.org.remove_admin") : t("work.org.make_admin")}
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "transfer", member })}>{t("work.org.make_owner")}</Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm({ kind: "remove", member })}>{t("common.remove")}</Button>
                      </div>
                    ) : !member.you && canRemove(member) ? (
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm({ kind: "remove", member })} data-testid="work-org-member-remove">{t("common.remove")}</Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>

            {(data?.invites ?? []).length ? (
              <Section title={t("work.org.pending_invites")} description={t("work.org.pending_invites_hint")} testId="work-org-invites">
                <ul className="rounded-xl border border-border">
                  {(data?.invites ?? []).map((invite) => {
                    const link = invite.link ?? links[invite.id] ?? null;
                    return (
                      <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-invite={invite.id}>
                        <div className="min-w-[12rem] flex-1">
                          <div className="truncate text-sm">{invite.email}</div>
                          {invite.expires_at ? <div className="text-[12px] text-muted-foreground">{t("work.org.expires", { date: new Date(invite.expires_at).toLocaleDateString() })}</div> : null}
                        </div>
                        {link ? (
                          <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success(t("work.common.link_copied")))}><Copy className="size-3.5" />{t("work.org.copy_link")}</Button>
                        ) : null}
                        {owner || (enterprise.on && admin) ? (
                          <Button variant="ghost" size="sm" disabled={cancelInvite.isPending && cancelInvite.variables === invite.id} onClick={() => cancelInvite.mutate(invite.id)}>{t("common.cancel")}</Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}

            {team ? (
              <TeamConnectors view={team} pending={saveShown.isPending ? saveShown.variables : undefined} busy={saveShown.isPending} onChange={showConnector} />
            ) : null}

            {enterprise.on && enterprise.portalUrl && (owner || admin) ? (
              <Section title={t("work.ent.manage_portal")} testId="work-org-portal">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
                  <span className="max-w-[32rem] text-[13px] text-muted-foreground">{t("work.ent.manage_portal_body")}</span>
                  <Button variant="outline" size="sm" onClick={() => props.openLink(enterprise.portalUrl!)} data-testid="work-org-portal-open">{t("work.ent.manage_open")}<ArrowUpRight className="size-4" /></Button>
                </div>
              </Section>
            ) : null}

            {/* Cloud tasks: only once staff turned them on for the company (its own block). */}
            <OrgCloudSection client={props.client} cloud={workCloud(state.data)} manager={owner || admin} enterprise={enterprise.on} />

            <Section title={t("work.org.security")} testId="work-org-security">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
                <span className="max-w-[32rem] text-[13px] text-muted-foreground" data-testid="work-org-privacy">{t("work.setup.privacy_line")}</span>
                <Button variant="outline" size="sm" onClick={() => props.openLink(TRUST_URL)} data-testid="work-org-trust">{t("work.org.trust_page")}</Button>
              </div>
            </Section>

            <Section title={t("work.org.leave_title")} testId="work-org-leave">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
                <span className="max-w-[32rem] text-[13px] text-muted-foreground">{leaving.message}</span>
                <Button variant="outline" size="sm" className="text-destructive" disabled={leaving.blocked || leave.isPending} onClick={() => setConfirm({ kind: "leave" })} data-testid="work-org-leave-button">{t("work.org.leave")}</Button>
              </div>
            </Section>
          </>
        )}
      </div>
      <WorkInviteDialog client={props.client} open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) refresh(); }} />
      <ConfirmModal
        open={confirm !== null}
        title={confirm?.kind === "remove"
          ? t("work.org.remove_title", { email: confirm.member.email })
          : confirm?.kind === "transfer"
            ? t("work.org.transfer_title", { email: confirm.member.email })
            : confirm?.kind === "hide"
              ? t("work.org.team_off_title", { name: connectorLabel(confirm.connector.id, confirm.connector.label) })
              : t("work.org.leave_confirm_title")}
        message={confirm?.kind === "remove"
          ? t("work.org.remove_body")
          : confirm?.kind === "transfer"
            ? t("work.org.transfer_body")
            : confirm?.kind === "hide"
              ? t("work.org.team_off_body", { count: confirm.connector.members_connected, n: confirm.connector.members_connected.toLocaleString() })
              : leaving.message}
        confirmLabel={confirm?.kind === "remove" ? t("common.remove") : confirm?.kind === "transfer" ? t("work.org.make_owner") : confirm?.kind === "hide" ? t("work.org.team_off") : t("work.org.leave")}
        cancelLabel={t("common.cancel")}
        variant={confirm?.kind === "transfer" || confirm?.kind === "hide" ? "warning" : "danger"}
        onConfirm={() => {
          if (confirm?.kind === "remove") remove.mutate(confirm.member.user_id);
          else if (confirm?.kind === "transfer") transfer.mutate(confirm.member.user_id);
          else if (confirm?.kind === "hide" && team) saveShown.mutate(nextShown(team, confirm.connector.id, false));
          else if (confirm?.kind === "leave") leave.mutate();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

/** Settings > Preferences: the way to Work > Organization, while Work is on for the account. */
export function WorkOrganizationSetting(props: { client: WorkClient | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const state = useWorkState(props.client);
  if (!state.data?.enabled) return null;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("work.org.setting_title")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("work.org.setting_body")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-organization" onClick={() => navigate(WORK_ORG_ROUTE, { state: { from: `${location.pathname}${location.search}` } })}>{t("work.common.open")}</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
