/** @jsxImportSource react */
// Work > Organization: the company's apps (Apps for your team: everyone sees them, the owner and admins add, edit and
// remove them) and, for the owner and admins only, what people may do in the Work browser (Browser for your team).
// Saved for the company on the server (GET/PATCH /work/org/browser); members also get them in their Work state. An
// app's mark comes from brands.ts or its first letter: no icon is ever fetched.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import type { OmniRushWorkBrowser, OmniRushWorkBrowserApp, OmniRushWorkOrgBrowser, OmniRushWorkOrgBrowserPatch } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

import { BrandTile } from "./brand-icon";
import { appBrand, appHost, checkAppUrl, suggestedAppName, WORK_BROWSER_MAX_APPS, WORK_BROWSER_NAME_MAX, type AppUrlCheck } from "./company-browser";
import { workFailure, workOrgBrowserKey, workStateKey, type WorkClient } from "./work-mode";

/** Secondary text: the muted colour, a touch lighter in dark mode so it keeps AA contrast (4.5:1) on the page. */
const SUBTLE = "text-muted-foreground dark:text-foreground/55";

/** Rows shown before "Show all", and the list size from which a search box helps. */
export const APPS_SHOWN = 5;
export const APPS_SEARCH_FROM = 9;

type Switches = Pick<OmniRushWorkBrowser, "import_bookmarks" | "import_signins" | "links_in_app" | "links_locked">;

/** The apps a search keeps: by name or address, case-insensitive. */
export function matchApps(apps: OmniRushWorkBrowserApp[], query: string): OmniRushWorkBrowserApp[] {
  const words = query.trim().toLowerCase();
  return words ? apps.filter((app) => app.name.toLowerCase().includes(words) || appHost(app.url).toLowerCase().includes(words)) : apps;
}

/** The list after adding or changing one app (`index` null adds it at the end). */
export function nextApps(apps: OmniRushWorkBrowserApp[], index: number | null, app: OmniRushWorkBrowserApp): OmniRushWorkBrowserApp[] {
  return index === null ? [...apps, app] : apps.map((item, at) => (at === index ? app : item));
}

function urlError(check: AppUrlCheck): string | null {
  if ("url" in check) return null;
  return t(`work.org.app_url_${check.error}`);
}

function OrgSection(props: { title: string; description?: string; actions?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section className="flex flex-col gap-3" data-testid={props.testId}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{props.title}</h2>
          {props.description ? <p className={cn("text-[13px]", SUBTLE)}>{props.description}</p> : null}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

/** Apps for your team, and Browser for your team for the owner and admins. Nothing from an older server (404), and
 *  nothing for a member while the company has no apps. */
export function TeamBrowser(props: { client: WorkClient | null; company: string }) {
  const queryClient = useQueryClient();
  const key = workOrgBrowserKey(props.client);
  const query = useQuery<OmniRushWorkOrgBrowser>({ queryKey: key, queryFn: () => props.client!.getWorkOrgBrowser(), enabled: Boolean(props.client), retry: false });
  const save = useMutation({
    mutationFn: (change: { patch: OmniRushWorkOrgBrowserPatch; done?: string }) => props.client!.setWorkOrgBrowser(change.patch),
    onSuccess: (answer, change) => {
      queryClient.setQueryData(key, answer);
      // The person's own Work state carries the settings too (the browser home, the import screens).
      void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
      toast.success(change.done ?? t("work.org.saved"));
    },
    onError: (reason) => toast.error(workFailure(reason).text),
  });
  const data = query.data;
  if (!data) return null;
  const manage = data.can_manage;
  const pending = save.isPending ? save.variables.patch : null;
  const apps = pending?.apps ?? data.browser.apps;
  const switches: Switches = { ...data.browser, ...pending };
  if (!manage && apps.length === 0) return null;
  return (
    <>
      <TeamApps
        apps={apps}
        company={props.company}
        manage={manage}
        busy={save.isPending}
        onSave={(next, done) => save.mutate({ patch: { apps: next }, done })}
      />
      {manage ? <TeamBrowserRules company={props.company} value={switches} busy={save.isPending} onChange={(patch) => save.mutate({ patch })} /> : null}
    </>
  );
}

type Editing = { index: number | null; app: OmniRushWorkBrowserApp } | null;

function TeamApps(props: {
  apps: OmniRushWorkBrowserApp[];
  company: string;
  manage: boolean;
  busy: boolean;
  onSave: (apps: OmniRushWorkBrowserApp[], done: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const full = props.apps.length >= WORK_BROWSER_MAX_APPS;
  const found = matchApps(props.apps, query);
  const visible = all ? found : found.slice(0, APPS_SHOWN);
  const removed = removing === null ? null : props.apps[removing] ?? null;
  return (
    <OrgSection
      title={t("work.org.apps_title")}
      description={props.manage ? t("work.org.apps_hint_manage", { company: props.company }) : t("work.org.apps_hint", { company: props.company })}
      testId="work-org-apps"
      actions={props.manage ? (
        <Button size="sm" variant="outline" disabled={full || props.busy} onClick={() => setEditing({ index: null, app: { name: "", url: "" } })} data-testid="work-org-app-add">
          <Plus className="size-4" />{t("work.org.apps_add")}
        </Button>
      ) : null}
    >
      {props.apps.length >= APPS_SEARCH_FROM ? (
        <label className="relative block">
          <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("work.org.apps_search")} aria-label={t("work.org.apps_search")} className="ps-9" data-testid="work-org-apps-search" />
        </label>
      ) : null}
      {props.apps.length === 0 ? (
        <div className={cn("rounded-xl border border-dashed border-border px-4 py-4 text-[13px]", SUBTLE)} data-testid="work-org-apps-empty">{t("work.org.apps_empty")}</div>
      ) : found.length === 0 ? (
        <div className={cn("rounded-xl border border-border px-4 py-3 text-[13px]", SUBTLE)}>{t("work.org.apps_no_match")}</div>
      ) : (
        <ul className="rounded-xl border border-border" data-testid="work-org-apps-list">
          {visible.map((app) => {
            const index = props.apps.indexOf(app);
            return (
              <li key={app.url} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0" data-company-app={app.url}>
                <BrandTile id={appBrand(app.url)} name={app.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" title={app.name}>{app.name}</div>
                  <div className={cn("truncate text-[13px]", SUBTLE)} title={app.url}>{appHost(app.url)}</div>
                </div>
                {props.manage ? (
                  <Button variant="ghost" size="sm" className="shrink-0" disabled={props.busy} aria-label={t("work.org.apps_edit_for", { name: app.name })} onClick={() => setEditing({ index, app })}>{t("common.edit")}</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {found.length > APPS_SHOWN || (props.manage && full) ? (
        <div className="-mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {found.length > APPS_SHOWN ? (
            <Button variant="ghost" size="sm" className={cn("-ms-2", SUBTLE)} onClick={() => setAll(!all)} aria-expanded={all} data-testid="work-org-apps-more">
              {all ? t("work.org.apps_show_fewer") : t("work.org.apps_show_all", { n: found.length.toLocaleString() })}
            </Button>
          ) : null}
          {props.manage && full ? <p className={cn("text-[13px]", SUBTLE)} data-testid="work-org-apps-full">{t("work.org.apps_full", { n: WORK_BROWSER_MAX_APPS })}</p> : null}
        </div>
      ) : null}
      {editing ? (
        <AppDialog
          company={props.company}
          editing={editing}
          apps={props.apps}
          busy={props.busy}
          onClose={() => setEditing(null)}
          onRemove={editing.index === null ? null : () => { setRemoving(editing.index); setEditing(null); }}
          onSave={(app) => {
            props.onSave(nextApps(props.apps, editing.index, app), editing.index === null ? t("work.org.app_added", { name: app.name }) : t("work.org.app_updated", { name: app.name }));
            setEditing(null);
          }}
        />
      ) : null}
      <ConfirmModal
        open={removed !== null}
        title={removed ? t("work.org.app_remove_title", { name: removed.name }) : ""}
        message={t("work.org.app_remove_body", { company: props.company })}
        confirmLabel={t("common.remove")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => {
          if (removed) props.onSave(props.apps.filter((app) => app !== removed), t("work.org.app_removed", { name: removed.name }));
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </OrgSection>
  );
}

/** Add or edit one app: the address first (a well-known app fills its name), then the name. */
function AppDialog(props: {
  company: string;
  editing: NonNullable<Editing>;
  apps: OmniRushWorkBrowserApp[];
  busy: boolean;
  onClose: () => void;
  /** Editing one: remove it (asks first). */
  onRemove: (() => void) | null;
  onSave: (app: OmniRushWorkBrowserApp) => void;
}) {
  const urlId = useId();
  const nameId = useId();
  const [url, setUrl] = useState(props.editing.app.url);
  const [name, setName] = useState(props.editing.app.name);
  const [shown, setShown] = useState(false);
  const check = checkAppUrl(url);
  const taken = "url" in check ? props.apps.find((app, index) => index !== props.editing.index && app.url === check.url) ?? null : null;
  const problem = urlError(check) ?? (taken ? t("work.org.app_url_taken", { name: taken.name }) : null);
  const ready = !problem && name.trim() !== "";
  const fillName = () => {
    if (!name.trim() && "url" in check) setName(suggestedAppName(check.url));
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="lg:max-w-[520px]" data-testid="work-org-app-dialog">
        <DialogHeader>
          <DialogTitle>{props.editing.index === null ? t("work.org.app_add_title") : t("work.org.app_edit_title")}</DialogTitle>
          <DialogDescription className={SUBTLE}>{t("work.org.app_dialog_body", { company: props.company })}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setShown(true);
            if (ready && "url" in check) props.onSave({ name: name.trim().slice(0, WORK_BROWSER_NAME_MAX), url: check.url });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlId} className="text-[13px] font-medium">{t("work.org.app_url")}</label>
            <Input
              id={urlId}
              autoFocus={props.editing.index === null}
              inputMode="url"
              spellCheck={false}
              maxLength={2048}
              value={url}
              placeholder="https://tms.example.com"
              aria-invalid={shown && problem ? true : undefined}
              aria-describedby={shown && problem ? `${urlId}-error` : undefined}
              onChange={(event) => setUrl(event.target.value)}
              onBlur={() => { fillName(); if (url.trim()) setShown(true); }}
              data-testid="work-org-app-url"
            />
            {shown && problem ? <p id={`${urlId}-error`} className="text-[13px] text-red-11" data-testid="work-org-app-url-error">{problem}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-[13px] font-medium">{t("work.org.app_name")}</label>
            <Input id={nameId} autoFocus={props.editing.index !== null} maxLength={WORK_BROWSER_NAME_MAX} value={name} placeholder={t("work.org.app_name_placeholder")} onChange={(event) => setName(event.target.value)} data-testid="work-org-app-name" />
          </div>
          <DialogFooter>
            {props.onRemove ? (
              <Button type="button" variant="ghost" className="text-red-11 sm:me-auto" disabled={props.busy} onClick={props.onRemove} data-testid="work-org-app-remove">
                {t("work.org.app_remove")}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={props.onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={props.busy || !url.trim() || !name.trim()} data-testid="work-org-app-save">
              {props.editing.index === null ? t("work.org.apps_add") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What people may do in the Work browser (owner and admins). Each switch saves at once. */
function TeamBrowserRules(props: { company: string; value: Switches; busy: boolean; onChange: (patch: Partial<Switches>) => void }) {
  const rows: { key: keyof Switches; title: string; hint: string; checked: boolean; nested?: boolean }[] = [
    { key: "import_bookmarks", title: t("work.org.browser_bookmarks"), hint: t("work.org.browser_bookmarks_hint"), checked: props.value.import_bookmarks },
    { key: "import_signins", title: t("work.org.browser_signins"), hint: t("work.org.browser_signins_hint"), checked: props.value.import_signins },
    { key: "links_in_app", title: t("work.org.browser_links"), hint: t("work.org.browser_links_hint"), checked: props.value.links_in_app },
    { key: "links_locked", title: t("work.org.browser_links_choice"), hint: t("work.org.browser_links_choice_hint"), checked: !props.value.links_locked, nested: true },
  ];
  return (
    <OrgSection title={t("work.org.browser_title")} description={t("work.org.browser_hint", { company: props.company })} testId="work-org-browser">
      <ul className="rounded-xl border border-border">
        {rows.map((row) => {
          const id = `work-org-browser-${row.key}`;
          return (
            <li key={row.key} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0" data-browser-rule={row.key} data-on={row.checked}>
              <label htmlFor={id} className={row.nested ? "min-w-0 flex-1 ps-6" : "min-w-0 flex-1"}>
                <span className="block text-sm font-medium">{row.title}</span>
                <span className={cn("block text-[13px]", SUBTLE)}>{row.hint}</span>
              </label>
              <Switch
                id={id}
                aria-label={row.title}
                checked={row.checked}
                disabled={props.busy}
                onCheckedChange={(checked: boolean) => props.onChange(row.key === "links_locked" ? { links_locked: !checked } : { [row.key]: checked })}
              />
            </li>
          );
        })}
      </ul>
    </OrgSection>
  );
}
