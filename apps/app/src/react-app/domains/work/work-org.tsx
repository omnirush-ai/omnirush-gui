/** @jsxImportSource react */
// Settings > Work > Organization (contract Addendum C2): the company profile (owner edits), the member's own role and
// tools, members, pending invites, removing, transferring and leaving. Each person's connectors stay their own.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import type { OmniRushWorkMember, OmniRushWorkMembers } from "@/app/lib/omnirush-server";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import {
  LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { connectorLabel, DEMO_SOURCE, useWorkInviteLinks, useWorkState, workMembersKey, workOnboardingKey, workStateKey, WORK_ONBOARDING_ROUTE, WORK_ORG_ROUTE, type WorkClient } from "./work-mode";
import { Chip, SIZES, WorkInviteDialog } from "./work-onboarding";
import { ConnectorIcon } from "./work-views";

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : "That did not work. Try again.");
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

type Confirm = { kind: "remove" | "transfer"; member: OmniRushWorkMember } | { kind: "leave" } | null;

/** What leaving means for this person: blocked for an owner with others, the org goes for a sole owner. */
export function leaveState(data: Pick<OmniRushWorkMembers, "members" | "you_role"> | undefined): { blocked: boolean; message: string } {
  const owner = data?.you_role === "owner";
  const others = (data?.members ?? []).filter((member) => !member.you).length;
  if (owner && others > 0) return { blocked: true, message: "Make someone else the owner before you leave." };
  if (owner) return { blocked: false, message: "You are the only member, so the organization and its pending invites are deleted. You keep Work and your own connected tools." };
  return { blocked: false, message: "You keep Work and your own connected tools. You can join again with a new invite." };
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
        <Chip key={id} selected={props.selected.includes(id)} onClick={() => { if (!props.disabled) props.onChange(toggle(props.selected, id)); }}>
          <ConnectorIcon id={id} className="size-3.5 text-current" />
          {connectorLabel(id)}
        </Chip>
      ))}
    </div>
  );
}

/** Work > Organization (opened from Settings and the home checklist). */
export function WorkOrganizationPage(props: { client: WorkClient | null; onBack: () => void; backLabel?: string }) {
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
  const [companyDraft, setCompany] = useState<{ name: string; domain: string; size: string; industry: string; tools: string[] } | null>(null);
  const [mineDraft, setMine] = useState<{ job_role: string; tools: string[] } | null>(null);
  const company = companyDraft ?? { name: org?.name ?? "", domain: org?.domain ?? "", size: org?.size ?? "", industry: org?.industry ?? "", tools: org?.tools ?? [] };
  const mine = mineDraft ?? { job_role: you?.job_role ?? "", tools: you?.tools ?? [] };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workMembersKey(props.client) });
    void queryClient.invalidateQueries({ queryKey: workOnboardingKey(props.client) });
  };
  const onError = (reason: unknown) => toast.error(errorText(reason));
  const saveOrg = useMutation({
    mutationFn: () => props.client!.updateWorkOrg({
      name: company.name.trim(), tools: company.tools,
      ...(company.domain.trim() ? { domain: company.domain.trim() } : {}), ...(company.size ? { size: company.size } : {}), ...(company.industry.trim() ? { industry: company.industry.trim() } : {}),
    }),
    onSuccess: () => { toast.success("Company saved"); setCompany(null); refresh(); },
    onError,
  });
  const saveMine = useMutation({
    mutationFn: () => props.client!.updateWorkOrgMe({ job_role: mine.job_role.trim(), tools: mine.tools }),
    onSuccess: () => { toast.success("Saved"); setMine(null); refresh(); },
    onError,
  });
  const cancelInvite = useMutation({ mutationFn: (id: string) => props.client!.cancelWorkInvite(id), onSuccess: () => { toast.success("Invite cancelled"); refresh(); }, onError });
  const remove = useMutation({ mutationFn: (id: string) => props.client!.removeWorkMember(id), onSuccess: () => { toast.success("Member removed"); refresh(); }, onError });
  const transfer = useMutation({ mutationFn: (id: string) => props.client!.transferWorkOrg(id), onSuccess: () => { toast.success("Ownership transferred"); refresh(); }, onError });
  const leave = useMutation({
    mutationFn: () => props.client!.leaveWorkOrg(),
    onSuccess: () => {
      toast.success("You left the organization");
      refresh();
      void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
      props.onBack();
    },
    onError,
  });
  const leaving = leaveState(data);
  const noOrg = !query.isLoading && (!org || (query.error as { code?: unknown } | null)?.code === "no_org");

  return (
    <div className="h-full overflow-y-auto" data-testid="work-organization">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-10 pt-10">
        <div>
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? "Back to Work"}</Button>
          <h1 className="text-xl font-semibold tracking-tight">Organization</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your company in Work. Each person connects their own tools; nobody sees another person's data.</p>
        </div>

        {query.isLoading ? <div className="text-sm text-muted-foreground">Loading…</div> : noOrg ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-border px-4 py-4" data-testid="work-org-none">
            <span className="text-sm text-muted-foreground">{query.error && (query.error as { code?: unknown }).code !== "no_org" ? errorText(query.error) : "You haven't set up a company yet."}</span>
            <Button size="sm" onClick={() => navigate(WORK_ONBOARDING_ROUTE)}>Set up your company</Button>
          </div>
        ) : (
          <>
            <Section title="Company" description={owner ? undefined : "Only the owner can change these."} testId="work-org-company">
              <form
                className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
                onSubmit={(event) => { event.preventDefault(); if (owner && company.name.trim() && !saveOrg.isPending) saveOrg.mutate(); }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                    Company name
                    <Input required maxLength={200} disabled={!owner} value={company.name} onChange={(event) => setCompany({ ...company, name: event.target.value })} data-testid="work-org-name" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                    Company website
                    <Input maxLength={253} disabled={!owner} value={company.domain} onChange={(event) => setCompany({ ...company, domain: event.target.value })} placeholder="example.com" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] font-medium sm:col-span-2">
                    Industry
                    <Input maxLength={100} disabled={!owner} value={company.industry} onChange={(event) => setCompany({ ...company, industry: event.target.value })} placeholder="Retail" />
                  </label>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Team size</span>
                  <div className="flex flex-wrap gap-2">
                    {SIZES.map(([value, label]) => <Chip key={value} selected={company.size === value} onClick={() => { if (owner) setCompany({ ...company, size: company.size === value ? "" : value }); }}>{label}</Chip>)}
                  </div>
                </div>
                {offered.length ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Tools the company uses</span>
                    <ToolChips offered={offered} selected={company.tools} disabled={!owner} onChange={(tools) => setCompany({ ...company, tools })} />
                  </div>
                ) : null}
                {owner ? (
                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={!company.name.trim() || saveOrg.isPending} data-testid="work-org-save">{saveOrg.isPending ? "Saving…" : "Save"}</Button>
                  </div>
                ) : null}
              </form>
            </Section>

            <Section title="You" description="Your role and the tools you use help Work suggest where to start." testId="work-org-me">
              <form
                className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
                onSubmit={(event) => { event.preventDefault(); if (!saveMine.isPending) saveMine.mutate(); }}
              >
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  Your role
                  <Input maxLength={100} value={mine.job_role} onChange={(event) => setMine({ ...mine, job_role: event.target.value })} placeholder="Operations manager" data-testid="work-org-role" />
                </label>
                {offered.length ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Tools you use</span>
                    <ToolChips offered={offered} selected={mine.tools} onChange={(tools) => setMine({ ...mine, tools })} />
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" variant="outline" disabled={saveMine.isPending} data-testid="work-org-me-save">{saveMine.isPending ? "Saving…" : "Save"}</Button>
                </div>
              </form>
            </Section>

            <Section
              title="Members"
              testId="work-org-members"
              actions={<Button size="sm" variant="outline" onClick={() => setInviteOpen(true)} data-testid="work-org-invite"><UserPlus className="size-4" />Invite</Button>}
            >
              <ul className="rounded-xl border border-border">
                {(data?.members ?? []).map((member) => (
                  <li key={member.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-member={member.user_id} data-role={member.role}>
                    <div className="min-w-[12rem] flex-1">
                      <div className="truncate text-sm font-medium">{member.email}{member.you ? <span className="font-normal text-muted-foreground"> (you)</span> : null}</div>
                      {member.job_role ? <div className="truncate text-[12px] text-muted-foreground">{member.job_role}</div> : null}
                    </div>
                    <Badge variant={member.role === "owner" ? "default" : "secondary"}>{member.role === "owner" ? "Owner" : "Member"}</Badge>
                    {owner && !member.you ? (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "transfer", member })}>Make owner</Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm({ kind: "remove", member })}>Remove</Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>

            {(data?.invites ?? []).length ? (
              <Section title="Pending invites" description="Invites expire after 14 days. Links can be copied again only on the device that made them." testId="work-org-invites">
                <ul className="rounded-xl border border-border">
                  {(data?.invites ?? []).map((invite) => {
                    const link = invite.link ?? links[invite.id] ?? null;
                    return (
                      <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0" data-work-invite={invite.id}>
                        <div className="min-w-[12rem] flex-1">
                          <div className="truncate text-sm">{invite.email}</div>
                          {invite.expires_at ? <div className="text-[12px] text-muted-foreground">Expires {new Date(invite.expires_at).toLocaleDateString()}</div> : null}
                        </div>
                        {link ? (
                          <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success("Link copied"))}><Copy className="size-3.5" />Copy link</Button>
                        ) : null}
                        {owner ? (
                          <Button variant="ghost" size="sm" disabled={cancelInvite.isPending && cancelInvite.variables === invite.id} onClick={() => cancelInvite.mutate(invite.id)}>Cancel</Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}

            <Section title="Leave organization" testId="work-org-leave">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
                <span className="max-w-[32rem] text-[13px] text-muted-foreground">{leaving.blocked ? leaving.message : "You keep Work and your own connected tools."}</span>
                <Button variant="outline" size="sm" className="text-destructive" disabled={leaving.blocked || leave.isPending} onClick={() => setConfirm({ kind: "leave" })} data-testid="work-org-leave-button">Leave</Button>
              </div>
            </Section>
          </>
        )}
      </div>
      <WorkInviteDialog client={props.client} open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) refresh(); }} />
      <ConfirmModal
        open={confirm !== null}
        title={confirm?.kind === "remove" ? `Remove ${confirm.member.email}?` : confirm?.kind === "transfer" ? `Make ${confirm.member.email} the owner?` : "Leave the organization?"}
        message={confirm?.kind === "remove"
          ? "They leave the company in Work. They keep Work and their own connected tools."
          : confirm?.kind === "transfer"
            ? "They can edit the company, invite and remove people. You become a member."
            : leaving.message}
        confirmLabel={confirm?.kind === "remove" ? "Remove" : confirm?.kind === "transfer" ? "Make owner" : "Leave"}
        cancelLabel="Cancel"
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
        <LayoutSectionItemTitle>Work organization</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>Your company, members and invites. Each person connects their own tools.</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-organization" onClick={() => navigate(WORK_ORG_ROUTE, { state: { from: `${location.pathname}${location.search}` } })}>Open</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
