/** @jsxImportSource react */
// Work > Organization > Cloud tasks (design 3.7): the company's own choices once staff have turned Cloud tasks on.
// Owners and admins change them, members read them: the team switch, who creates tasks, the sites tasks may open
// (8, then Show more), saved sign-ins (only while staff turned them on; values go in once and never come back), who
// hears about a run that waits, how long screenshots stay, and this month's use. Nothing shows while the server has
// no Cloud tasks for the company (an error or a 403 renders nothing).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { OmniRushWorkCloud, OmniRushWorkCloudSignin, OmniRushWorkOrgCloud, OmniRushWorkOrgCloudPatch } from "@/app/lib/omnirush-server";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

import { relativeTime, workStateKey, type WorkClient } from "../work-mode";
import { CLOUD_KEY, cloudFailure, cloudSigninsKey, HOST_ROWS, MAX_HOSTS, orgCloudKey, SIGNIN_ROWS, siteEntry, useCloudSignins, useOrgCloud, type CloudClient } from "./cloud-model";
import { Segmented } from "./task-sheet";

function Row(props: { title: string; hint?: string; children?: ReactNode; control?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5" data-testid={props.testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-[30rem]">
          <div className="text-[13px] font-medium text-foreground">{props.title}</div>
          {props.hint ? <div className="text-[12px] text-muted-foreground">{props.hint}</div> : null}
        </div>
        {props.control}
      </div>
      {props.children}
    </div>
  );
}

function Sites(props: { hosts: string[]; edit: boolean; busy: boolean; onChange: (hosts: string[]) => void }) {
  const [all, setAll] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const shown = all ? props.hosts : props.hosts.slice(0, HOST_ROWS);
  const add = () => {
    const site = siteEntry(typed);
    if (!site) { setError(t("work.cloud.site_bad")); return; }
    if (props.hosts.includes(site)) { setTyped(""); return; }
    if (props.hosts.length >= MAX_HOSTS) { setError(t("work.cloud.site_full", { n: MAX_HOSTS })); return; }
    setError(null);
    setTyped("");
    props.onChange([...props.hosts, site]);
  };
  return (
    <div className="flex flex-col gap-2">
      {props.hosts.length ? (
        <ul className="flex flex-wrap gap-1.5" data-testid="work-org-cloud-sites">
          {shown.map((host) => (
            <li key={host} className="flex h-7 items-center gap-1 rounded-full border border-border bg-background ps-2.5 pe-1 text-[12px] text-foreground" data-cloud-site={host}>
              <span className="max-w-[16rem] truncate">{host}</span>
              {props.edit ? (
                <button type="button" aria-label={t("work.cloud.remove_site", { host })} disabled={props.busy} onClick={() => props.onChange(props.hosts.filter((item) => item !== host))} className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                  <X className="size-3" />
                </button>
              ) : <span className="w-1.5" />}
            </li>
          ))}
        </ul>
      ) : <p className="text-[12px] text-muted-foreground" data-testid="work-org-cloud-no-sites">{t("work.cloud.no_sites")}</p>}
      {props.hosts.length > HOST_ROWS ? (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="self-start rounded text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" data-testid="work-org-cloud-sites-more">
          {all ? t("work.today.show_less") : t("work.today.show_more", { count: props.hosts.length - HOST_ROWS })}
        </button>
      ) : null}
      {props.edit ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <label htmlFor={inputId} className="sr-only">{t("work.cloud.add_site")}</label>
          <Input id={inputId} value={typed} onChange={(event) => { setTyped(event.target.value); setError(null); }} placeholder="portal.example.com" autoComplete="off" spellCheck={false} className="h-8 w-64 text-[13px]" aria-invalid={error ? true : undefined} data-testid="work-org-cloud-site-input" />
          <Button type="submit" size="sm" variant="outline" disabled={!typed.trim() || props.busy} data-testid="work-org-cloud-site-add"><Plus className="size-3.5" />{t("work.cloud.add_site")}</Button>
          {error ? <p role="alert" className="w-full text-[12px] text-red-11">{error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}

const RETENTION: (7 | 30 | 90)[] = [7, 30, 90];

type SigninForm = { label: string; host: string; username: string; password: string; use: "admins" | "everyone" };

/** Add or replace a saved sign-in. The values are sent once; the form forgets them when it closes. */
function SigninDialog(props: { open: boolean; replacing: OmniRushWorkCloudSignin | null; busy: boolean; onClose: () => void; onSave: (form: SigninForm) => void }) {
  const ids = { label: useId(), host: useId(), user: useId(), pass: useId(), use: useId() };
  const blank = (): SigninForm => ({ label: props.replacing?.label ?? "", host: props.replacing?.hosts[0] ?? "", username: "", password: "", use: props.replacing?.use ?? "admins" });
  const [form, setForm] = useState<SigninForm>(blank);
  const [tried, setTried] = useState(false);
  const [opened, setOpened] = useState(false);
  if (props.open !== opened) { setOpened(props.open); setForm(blank()); setTried(false); }
  const site = siteEntry(form.host);
  const ok = form.label.trim() && site && form.username.trim() && form.password;
  const field = "flex flex-col gap-1.5 text-[13px] font-medium text-foreground";
  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent data-testid="work-org-cloud-signin-dialog">
        <DialogHeader>
          <DialogTitle>{props.replacing ? t("work.cloud.replace_signin_title", { label: props.replacing.label }) : t("work.cloud.add_signin_title")}</DialogTitle>
          <DialogDescription>{t("work.cloud.signin_dialog_body")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTried(true);
            if (ok && !props.busy) props.onSave({ ...form, host: site });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor={ids.label} className={field}>{t("work.cloud.signin_name")}
              <Input id={ids.label} autoFocus maxLength={100} value={form.label} placeholder={t("work.cloud.signin_name_placeholder")} onChange={(event) => setForm({ ...form, label: event.target.value })} />
            </label>
            <label htmlFor={ids.host} className={field}>{t("work.cloud.signin_site")}
              <Input id={ids.host} value={form.host} placeholder="portal.example.com" autoComplete="off" spellCheck={false} onChange={(event) => setForm({ ...form, host: event.target.value })} aria-invalid={tried && !site ? true : undefined} />
            </label>
            <label htmlFor={ids.user} className={field}>{t("work.cloud.signin_user")}
              <Input id={ids.user} value={form.username} autoComplete="off" spellCheck={false} maxLength={254} onChange={(event) => setForm({ ...form, username: event.target.value })} />
            </label>
            <label htmlFor={ids.pass} className={field}>{t("work.cloud.signin_password")}
              <Input id={ids.pass} type="password" value={form.password} autoComplete="new-password" maxLength={1024} onChange={(event) => setForm({ ...form, password: event.target.value })} data-testid="work-org-cloud-signin-password" />
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <span id={ids.use} className="text-[13px] font-medium text-foreground">{t("work.cloud.signin_use")}</span>
            <Segmented label={t("work.cloud.signin_use")} labelId={ids.use} value={form.use} onChange={(use) => setForm({ ...form, use })} options={[{ value: "admins", label: t("work.cloud.use_admins") }, { value: "everyone", label: t("work.cloud.use_everyone") }]} />
          </div>
          {tried && !ok ? <p role="alert" className="text-[12px] text-red-11">{t("work.cloud.signin_incomplete")}</p> : null}
          <p className="text-[12px] text-muted-foreground">{t("work.cloud.signin_never_shown")}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={props.busy} data-testid="work-org-cloud-signin-save">{props.busy ? t("work.common.saving") : t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Signins(props: { client: CloudClient | null; edit: boolean }) {
  const queryClient = useQueryClient();
  const list = useCloudSignins(props.client, true);
  const [all, setAll] = useState(false);
  const [dialog, setDialog] = useState<{ replacing: OmniRushWorkCloudSignin | null } | null>(null);
  const [removing, setRemoving] = useState<OmniRushWorkCloudSignin | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: cloudSigninsKey(props.client) });
  const save = useMutation({
    mutationFn: (form: SigninForm) => {
      const body = { label: form.label.trim(), hosts: [form.host], username: form.username, password: form.password, use: form.use };
      return dialog?.replacing ? props.client!.replaceWorkCloudSignin(dialog.replacing.id, body) : props.client!.addWorkCloudSignin(body);
    },
    onSuccess: () => { toast.success(dialog?.replacing ? t("work.cloud.signin_replaced") : t("work.cloud.signin_added")); setDialog(null); refresh(); },
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  const remove = useMutation({
    mutationFn: (id: string) => props.client!.removeWorkCloudSignin(id),
    onSuccess: () => { toast.success(t("work.cloud.signin_removed")); refresh(); },
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  const items = list.data?.items ?? [];
  const shown = all ? items : items.slice(0, SIGNIN_ROWS);
  return (
    <Row
      title={t("work.cloud.signins")}
      hint={t("work.cloud.signins_hint")}
      testId="work-org-cloud-signins"
      control={props.edit ? <Button size="sm" variant="outline" onClick={() => setDialog({ replacing: null })} data-testid="work-org-cloud-signin-add"><KeyRound className="size-3.5" />{t("work.cloud.add_signin")}</Button> : null}
    >
      {items.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {shown.map((signin) => (
            <li key={signin.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-cloud-signin={signin.id}>
              <div className="min-w-[12rem] flex-1">
                <div className="truncate text-[13px] text-foreground">{signin.label}</div>
                <div className="line-clamp-2 break-words text-[12px] text-muted-foreground">
                  {[signin.hosts.join(", "), signin.username_hint, signin.use === "everyone" ? t("work.cloud.use_everyone") : t("work.cloud.use_admins"), signin.last_used_at ? t("work.cloud.last_used", { when: relativeTime(signin.last_used_at) }) : t("work.cloud.not_used")].filter(Boolean).join(" · ")}
                </div>
              </div>
              {props.edit ? (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ replacing: signin })}>{t("work.cloud.replace")}</Button>
                  <Button size="sm" variant="ghost" className="text-red-11" onClick={() => setRemoving(signin)}>{t("common.remove")}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : list.isFetched ? <p className="text-[12px] text-muted-foreground">{t("work.cloud.no_signins")}</p> : null}
      {items.length > SIGNIN_ROWS ? (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="self-start rounded text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {all ? t("work.today.show_less") : t("work.today.show_more", { count: items.length - SIGNIN_ROWS })}
        </button>
      ) : null}
      <SigninDialog open={dialog !== null} replacing={dialog?.replacing ?? null} busy={save.isPending} onClose={() => setDialog(null)} onSave={(form) => save.mutate(form)} />
      <ConfirmModal
        open={removing !== null}
        title={t("work.cloud.remove_signin_title", { label: removing?.label ?? "" })}
        message={t("work.cloud.remove_signin_body")}
        confirmLabel={t("common.remove")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => { if (removing) remove.mutate(removing.id); setRemoving(null); }}
        onCancel={() => setRemoving(null)}
      />
    </Row>
  );
}

/** The Organization page's Cloud tasks section. `cloud`: the Work state's block (null while the company switch is off,
 *  so an owner or admin of a company account still reads the settings to turn it back on). */
export function OrgCloudSection(props: { client: WorkClient | null; cloud: OmniRushWorkCloud | null; manager: boolean; enterprise: boolean }) {
  const queryClient = useQueryClient();
  const enabled = Boolean(props.cloud) || (props.enterprise && props.manager);
  const org = useOrgCloud(props.client, enabled);
  const edit = props.manager;
  const save = useMutation({
    mutationFn: (patch: OmniRushWorkOrgCloudPatch) => props.client!.setWorkOrgCloud(patch),
    onMutate: (patch) => {
      const before = queryClient.getQueryData<OmniRushWorkOrgCloud>(orgCloudKey(props.client));
      if (before) queryClient.setQueryData(orgCloudKey(props.client), { ...before, ...patch });
      return { before };
    },
    onSuccess: (view) => {
      queryClient.setQueryData(orgCloudKey(props.client), view);
      // The switch and who creates ride in the Work state's cloud block.
      void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
      void queryClient.invalidateQueries({ queryKey: [CLOUD_KEY] });
    },
    onError: (reason, _patch, context) => {
      if (context?.before) queryClient.setQueryData(orgCloudKey(props.client), context.before);
      toast.error(cloudFailure(reason).text);
    },
  });
  const data = org.data;
  if (!enabled || !data) return null;
  const usage = data.usage;
  const usageLine = [
    usage.minutes_limit ? t("work.cloud.usage_minutes_short", { used: Math.round(usage.minutes).toLocaleString(), limit: usage.minutes_limit.toLocaleString() }) : null,
    usage.steps_limit ? t("work.cloud.usage_steps", { used: usage.steps.toLocaleString(), limit: usage.steps_limit.toLocaleString() }) : null,
    usage.desktops ? t("work.cloud.usage_desktops", { count: usage.desktops, n: usage.desktops }) : null,
  ].filter(Boolean).join(" · ");
  const busy = save.isPending;
  const value = (text: string) => <span className="text-[13px] text-muted-foreground">{text}</span>;
  return (
    <section className="flex flex-col gap-3" data-testid="work-org-cloud">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{t("work.nav.cloud")}</h2>
          <p className="text-[12px] text-muted-foreground">{edit ? t("work.cloud.org_hint") : t("work.cloud.org_hint_member")}</p>
        </div>
      </div>
      <div className="divide-y divide-border rounded-xl border border-border">
        <Row
          title={t("work.cloud.team_switch")}
          hint={t("work.cloud.team_switch_hint")}
          testId="work-org-cloud-enabled"
          control={edit ? <Switch aria-label={t("work.cloud.team_switch")} checked={data.enabled} disabled={busy} onCheckedChange={(checked: boolean) => save.mutate({ enabled: checked })} /> : value(data.enabled ? t("work.cloud.on") : t("work.cloud.off"))}
        />
        {data.enabled ? (
          <>
            <Row
              title={t("work.cloud.creators")}
              testId="work-org-cloud-creators"
              control={edit ? (
                <Segmented label={t("work.cloud.creators")} value={data.creators} disabled={busy} onChange={(creators) => save.mutate({ creators })} options={[{ value: "admins", label: t("work.cloud.creators_admins") }, { value: "everyone", label: t("work.cloud.creators_everyone") }]} />
              ) : value(data.creators === "everyone" ? t("work.cloud.creators_everyone") : t("work.cloud.creators_admins"))}
            />
            <Row title={t("work.cloud.sites")} hint={t("work.cloud.sites_hint", { n: MAX_HOSTS })} testId="work-org-cloud-hosts">
              <Sites hosts={data.hosts} edit={edit} busy={busy} onChange={(hosts) => save.mutate({ hosts })} />
            </Row>
            {data.vault ? <Signins client={props.client} edit={edit} /> : null}
            <Row
              title={t("work.cloud.notify")}
              testId="work-org-cloud-notify"
              control={edit ? (
                <Segmented label={t("work.cloud.notify")} value={data.notify} disabled={busy} onChange={(notify) => save.mutate({ notify })} options={[{ value: "owner", label: t("work.cloud.notify_owner") }, { value: "owner_and_admins", label: t("work.cloud.notify_admins") }]} />
              ) : value(data.notify === "owner" ? t("work.cloud.notify_owner") : t("work.cloud.notify_admins"))}
            />
            <Row
              title={t("work.cloud.retention")}
              hint={t("work.cloud.retention_hint")}
              testId="work-org-cloud-retention"
              control={edit ? (
                <Segmented<7 | 30 | 90> label={t("work.cloud.retention")} value={data.retention_days} disabled={busy} onChange={(retention_days) => save.mutate({ retention_days })} options={RETENTION.map((days) => ({ value: days, label: t("work.cloud.days", { n: days }) }))} />
              ) : value(t("work.cloud.days", { n: data.retention_days }))}
            />
          </>
        ) : null}
        {usageLine ? <div className="px-4 py-3 text-[12px] text-muted-foreground" data-testid="work-org-cloud-usage">{usageLine}</div> : null}
      </div>
    </section>
  );
}
