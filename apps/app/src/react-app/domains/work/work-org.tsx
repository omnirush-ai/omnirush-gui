/** @jsxImportSource react */
// Settings > Work > Organization (contract Addendum C2): the company profile (owner edits), the member's own role and
// tools, members, pending invites, removing, transferring and leaving. Each person's connectors stay their own.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, RotateCw, UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkMember, OmniRushWorkMembers } from "@/app/lib/omnirush-server";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import {
  LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { connectorLabel, DEMO_SOURCE, useWorkInviteLinks, useWorkState, workFailure, workMembersKey, workOnboardingKey, workStateKey, WORK_ONBOARDING_ROUTE, WORK_ORG_ROUTE, type WorkClient } from "./work-mode";
import { Chip, sizeOptions, TRUST_URL, TrustBadge, WorkInviteDialog } from "./work-onboarding";
import { ConnectorIcon } from "./work-views";

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

type Confirm = { kind: "remove" | "transfer"; member: OmniRushWorkMember } | { kind: "leave" } | null;

/** What leaving means for this person: blocked for an owner with others, the org goes for a sole owner. */
export function leaveState(data: Pick<OmniRushWorkMembers, "members" | "you_role"> | undefined): { blocked: boolean; message: string } {
  const owner = data?.you_role === "owner";
  const others = (data?.members ?? []).filter((member) => !member.you).length;
  if (owner && others > 0) return { blocked: true, message: t("work.org.leave_blocked") };
  if (owner) return { blocked: false, message: t("work.org.leave_sole_owner") };
  return { blocked: false, message: t("work.org.leave_member") };
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

function ToolChips(props: { offered: string[]; selected: string[]; onChange: (tools: string[]) => void; disabled?: boolean; testId?: string }) {
  if (!props.offered.length) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid={props.testId}>
      {props.offered.map((id) => (
        <Chip key={id} selected={props.selected.includes(id)} disabled={props.disabled} onClick={() => props.onChange(toggle(props.selected, id))}>
          <ConnectorIcon id={id} className="size-3.5 text-current" />
          {connectorLabel(id)}
        </Chip>
      ))}
    </div>
  );
}

/** Work > Organization (opened from Settings and the home checklist). */
export function WorkOrganizationPage(props: { client: WorkClient | null; openLink: (url: string) => void; onBack: () => void; backLabel?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const state = useWorkState(props.client);
  const offered = (state.data?.sources ?? []).filter((id) => id !== DEMO_SOURCE && id !== "mock");
  const links = useWorkInviteLinks((store) => store.links);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const query = useQuery({ queryKey: workMembersKey(props.client), queryFn: () => props.client!.listWorkMembers(), enabled: Boolean(props.client), retry: false });
  const data = query.data;
  const org = data?.org ?? null;
  const owner = data?.you_role === "owner";
  const you = data?.members.find((member) => member.you) ?? null;

  // Edits in progress; null shows what the server has.
  const saved = { name: org?.name ?? "", domain: org?.domain ?? "", size: org?.size ?? "", industry: org?.industry ?? "", tools: org?.tools ?? [] };
  const [companyDraft, setCompany] = useState<typeof saved | null>(null);
  const company = companyDraft ?? saved;
  const companyChanged = (["name", "domain", "size", "industry"] as const).some((field) => company[field].trim() !== saved[field].trim()) || !sameList(company.tools, saved.tools);
  // Only the fields the person touched: the server keeps one tools list per person, and an owner's is the company's.
  const [mineDraft, setMine] = useState<{ job_role?: string; tools?: string[] }>({});
  const mine = { job_role: mineDraft.job_role ?? you?.job_role ?? "", tools: mineDraft.tools ?? you?.tools ?? [] };
  const mineChanged = mine.job_role.trim() !== (you?.job_role ?? "").trim() || (mineDraft.tools !== undefined && !sameList(mineDraft.tools, you?.tools ?? []));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workMembersKey(props.client) });
    void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
  };
  const onError = (reason: unknown) => toast.error(workFailure(reason).text);
  const saveOrg = useMutation({
    mutationFn: () => props.client!.updateWorkOrg({
      name: company.name.trim(), tools: company.tools,
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
                  <span className="text-[13px] font-medium">{t("work.org.team_size")}</span>
                  <div className="flex flex-wrap gap-2">
                    {sizeOptions().map(([value, label]) => <Chip key={value} selected={company.size === value} disabled={!owner} onClick={() => setCompany({ ...company, size: company.size === value ? "" : value })}>{label}</Chip>)}
                  </div>
                </div>
                {offered.length ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">{t("work.org.company_tools")}</span>
                    <ToolChips offered={offered} selected={company.tools} disabled={!owner} onChange={(tools) => setCompany({ ...company, tools })} />
                  </div>
                ) : null}
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
                    <ToolChips offered={offered} selected={mine.tools} onChange={(tools) => setMine({ ...mineDraft, tools })} testId="work-org-my-tools" />
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" variant="outline" disabled={!mineChanged || saveMine.isPending} data-testid="work-org-me-save">{saveMine.isPending ? t("work.common.saving") : t("common.save")}</Button>
                </div>
              </form>
            </Section>

            <Section
              title={t("work.org.members")}
              testId="work-org-members"
              actions={<Button size="sm" variant="outline" onClick={() => setInviteOpen(true)} data-testid="work-org-invite"><UserPlus className="size-4" />{t("work.org.invite")}</Button>}
            >
              <ul className="rounded-xl border border-border">
                {(data?.members ?? []).map((member) => (
                  <li key={member.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-member={member.user_id} data-role={member.role}>
                    <div className="min-w-[12rem] flex-1">
                      <div className="truncate text-sm font-medium">{member.email}{member.you ? <span className="font-normal text-muted-foreground"> {t("work.org.you_tag")}</span> : null}</div>
                      {member.job_role ? <div className="truncate text-[12px] text-muted-foreground">{member.job_role}</div> : null}
                    </div>
                    <Badge variant={member.role === "owner" ? "default" : "secondary"}>{member.role === "owner" ? t("work.role.owner") : t("work.role.member")}</Badge>
                    {owner && !member.you ? (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "transfer", member })}>{t("work.org.make_owner")}</Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm({ kind: "remove", member })}>{t("common.remove")}</Button>
                      </div>
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
                        {owner ? (
                          <Button variant="ghost" size="sm" disabled={cancelInvite.isPending && cancelInvite.variables === invite.id} onClick={() => cancelInvite.mutate(invite.id)}>{t("common.cancel")}</Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}

            <Section title={t("work.org.security")} testId="work-org-security">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
                <div className="flex items-center gap-3">
                  <TrustBadge />
                  <span className="text-[13px] text-muted-foreground">{t("work.trust.alt")}</span>
                </div>
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
        title={confirm?.kind === "remove" ? t("work.org.remove_title", { email: confirm.member.email }) : confirm?.kind === "transfer" ? t("work.org.transfer_title", { email: confirm.member.email }) : t("work.org.leave_confirm_title")}
        message={confirm?.kind === "remove"
          ? t("work.org.remove_body")
          : confirm?.kind === "transfer"
            ? t("work.org.transfer_body")
            : leaving.message}
        confirmLabel={confirm?.kind === "remove" ? t("common.remove") : confirm?.kind === "transfer" ? t("work.org.make_owner") : t("work.org.leave")}
        cancelLabel={t("common.cancel")}
        variant={confirm?.kind === "transfer" ? "warning" : "danger"}
        onConfirm={() => {
          if (confirm?.kind === "remove") remove.mutate(confirm.member.user_id);
          else if (confirm?.kind === "transfer") transfer.mutate(confirm.member.user_id);
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
