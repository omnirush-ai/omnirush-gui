/** @jsxImportSource react */
// Work > Automation (F action-layer): the user's own automation controls and the activity log of writes the agent
// made in connected apps. Everyone has their own; gated behind Work being on. Settings: GET/PATCH /work/settings,
// log: GET /work/actions, undo: POST /work/actions/{id}/undo.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, PauseCircle, RotateCcw, RotateCw, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkAction, OmniRushWorkSettings } from "@/app/lib/omnirush-server";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { cn } from "@/lib/utils";

import { ListMore, useListCap } from "./list-cap";
import { connectorLabel, relativeTime, useWorkActions, useWorkSettings, workActionsKey, workFailure, workSettingsKey, workStateKey, type WorkClient } from "./work-mode";

/** The one-screen plain-language grants shown before a user turns an automation on. */
type Grant = "autopilot" | "full_access" | null;
function grantCopy(grant: "autopilot" | "full_access"): { title: string; body: string; confirm: string } {
  return grant === "autopilot"
    ? { title: t("work.automation.autopilot_grant_title"), body: t("work.automation.autopilot_grant_body"), confirm: t("work.automation.autopilot_grant_confirm") }
    : { title: t("work.automation.full_access_grant_title"), body: t("work.automation.full_access_grant_body"), confirm: t("work.automation.full_access_grant_confirm") };
}

function SettingRow(props: { title: string; description: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-foreground">{props.title}</div>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{props.description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{props.control}</div>
    </div>
  );
}

/** Rows the activity log shows before "Show N more". */
export const ACTIVITY_ROWS = 20;

const RESULT_BADGE: Record<OmniRushWorkAction["result"], { label: () => string; icon: string; Icon: typeof Check }> = {
  done: { label: () => t("work.automation.result_done"), icon: "text-green-11", Icon: Check },
  failed: { label: () => t("work.automation.result_failed"), icon: "text-red-11", Icon: X },
  undone: { label: () => t("work.automation.result_undone"), icon: "text-muted-foreground", Icon: RotateCcw },
};

/** The outcome as words in the foreground colour; only the icon carries the colour. */
function ResultBadge(props: { result: OmniRushWorkAction["result"] }) {
  const badge = RESULT_BADGE[props.result] ?? RESULT_BADGE.done;
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-background px-2 text-[12px] font-medium text-foreground" data-result={props.result}>
      <badge.Icon aria-hidden className={cn("size-3.5", badge.icon)} />{badge.label()}
    </span>
  );
}

function ActionRow(props: { action: OmniRushWorkAction; now: number; onUndo: (id: string) => void; undoing: boolean }) {
  const action = props.action;
  // Older rows (and failed writes) can have no target at all.
  const where = [connectorLabel(action.source), (action.target ?? "").trim()].filter(Boolean).join(" · ");
  const meta = `${where}${where ? " · " : ""}${relativeTime(action.created_at, props.now)}`;
  return (
    <li className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0" data-action={action.id}>
      <div className="min-w-0">
        <div className="truncate text-[13px] text-foreground" title={action.summary}>{action.summary}</div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground" title={meta}>{meta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ResultBadge result={action.result} />
        {action.undoable ? (
          <Button variant="outline" size="sm" disabled={props.undoing} onClick={() => props.onUndo(action.id)} data-testid="work-action-undo">
            <RotateCcw className="size-3.5" />{t("common.undo")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Work > Automation. Every Work user has their own settings and log. */
export function WorkAutomationPage(props: { client: WorkClient | null; onBack: () => void; backLabel?: string }) {
  const queryClient = useQueryClient();
  const settingsQuery = useWorkSettings(props.client, Boolean(props.client));
  const actionsQuery = useWorkActions(props.client, Boolean(props.client));
  const settings = settingsQuery.data;
  const [grant, setGrant] = useState<Grant>(null);
  const now = Date.now();

  const save = useMutation({
    mutationFn: (patch: Partial<OmniRushWorkSettings>) => props.client!.setWorkSettings(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(workSettingsKey(props.client), next);
      // The auto-approval gate reads capabilities from /work/state; refresh it so the change takes effect at once.
      void queryClient.invalidateQueries({ queryKey: workStateKey(props.client) });
    },
    onError: (reason) => toast.error(workFailure(reason).text),
  });
  const undo = useMutation({
    mutationFn: (id: string) => props.client!.undoWorkAction(id),
    onSuccess: () => { toast.success(t("work.automation.undone")); void queryClient.invalidateQueries({ queryKey: workActionsKey(props.client) }); },
    // A refused undo (too old, already undone) changes the row too: read the log again so its Undo goes.
    onError: (reason) => { toast.error(workFailure(reason).text); void queryClient.invalidateQueries({ queryKey: workActionsKey(props.client) }); },
  });

  const busy = save.isPending;
  // Full Access keeps autopilot on (the server enforces it), so the autopilot switch is locked on while it is set.
  const autopilotLocked = settings?.full_access === true;
  const actions = actionsQuery.data?.actions ?? [];
  const cap = useListCap(actions.length, ACTIVITY_ROWS);
  const settingsFailure = settingsQuery.error && !settings ? workFailure(settingsQuery.error) : null;
  const actionsFailure = actionsQuery.error ? workFailure(actionsQuery.error) : null;

  return (
    <div className="h-full overflow-y-auto" data-testid="work-automation">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-10 pt-10">
        <div>
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? t("work.common.back_to_work")}</Button>
          <h1 className="text-xl font-semibold tracking-tight">{t("work.nav.automation")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("work.automation.subtitle")}</p>
        </div>

        {settingsQuery.isLoading ? (
          <Skeleton className="h-[220px] rounded-xl" data-testid="work-automation-loading" />
        ) : settingsFailure ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-automation-error">
            <span className="text-sm text-muted-foreground">{settingsFailure.text}</span>
            {settingsFailure.retry ? <Button variant="outline" size="sm" onClick={() => void settingsQuery.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
          </div>
        ) : settings ? (
          <>
            {settings.writes_paused ? (
              <div className="flex items-center gap-2 rounded-xl border border-amber-6 bg-amber-3 px-4 py-3 text-[13px] text-amber-11" data-testid="work-automation-paused">
                <PauseCircle aria-hidden className="size-4 shrink-0" />
                {t("work.automation.paused_banner")}
              </div>
            ) : null}

            <section className="flex flex-col gap-3" data-testid="work-automation-settings">
              <div className="divide-y divide-border rounded-xl border border-border bg-background">
                <SettingRow
                  title={t("work.automation.pause")}
                  description={t("work.automation.pause_body")}
                  control={(
                    <Switch
                      aria-label={t("work.automation.pause")}
                      data-testid="work-automation-pause"
                      checked={settings.writes_paused}
                      disabled={busy}
                      onCheckedChange={(checked) => save.mutate({ writes_paused: checked })}
                    />
                  )}
                />
                <SettingRow
                  title={t("work.automation.autopilot")}
                  description={autopilotLocked ? t("work.automation.autopilot_locked") : t("work.automation.autopilot_body")}
                  control={(
                    <Switch
                      aria-label={t("work.automation.autopilot_grant_confirm")}
                      data-testid="work-automation-autopilot"
                      checked={settings.autopilot}
                      disabled={busy || autopilotLocked}
                      onCheckedChange={(checked) => (checked ? setGrant("autopilot") : save.mutate({ autopilot: false }))}
                    />
                  )}
                />
                <SettingRow
                  title={t("work.automation.full_access")}
                  description={t("work.automation.full_access_body")}
                  control={(
                    <Switch
                      aria-label={t("work.automation.full_access")}
                      data-testid="work-automation-full-access"
                      checked={settings.full_access}
                      disabled={busy}
                      onCheckedChange={(checked) => (checked ? setGrant("full_access") : save.mutate({ full_access: false }))}
                    />
                  )}
                />
              </div>
            </section>
          </>
        ) : null}

        {/* The log is its own read: a failed settings read never hides it. */}
        <section className="flex flex-col gap-3" data-testid="work-automation-activity">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold">{t("work.automation.recent")}</h2>
              <p className="text-[13px] text-muted-foreground">{t("work.automation.recent_body")}</p>
            </div>
            <Button variant="ghost" size="sm" disabled={actionsQuery.isFetching} onClick={() => void actionsQuery.refetch()} aria-label={t("work.automation.refresh")}><RotateCw className="size-3.5" /></Button>
          </div>
          {actionsQuery.isLoading ? (
            <div className="rounded-xl border border-border" aria-busy="true">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center justify-between gap-4 border-b border-border px-4 py-3.5 last:border-b-0">
                  <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3 rounded-md" /><Skeleton className="h-3 w-1/3 rounded-md" /></div>
                  <Skeleton className="h-5 w-14 rounded-md" />
                </div>
              ))}
            </div>
          ) : actionsFailure ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-automation-activity-error">
              <span className="text-sm text-muted-foreground">{actionsFailure.text}</span>
              {actionsFailure.retry ? <Button variant="outline" size="sm" onClick={() => void actionsQuery.refetch()}><RotateCw className="size-3.5" />{t("work.common.try_again")}</Button> : null}
            </div>
          ) : actions.length ? (
            <>
              <ul className="rounded-xl border border-border bg-background">
                {actions.slice(0, cap.shown).map((action) => (
                  <ActionRow key={action.id} action={action} now={now} undoing={undo.isPending && undo.variables === action.id} onUndo={(id) => undo.mutate(id)} />
                ))}
              </ul>
              <ListMore cap={cap} testId="work-automation-more" />
            </>
          ) : (
            <div className="rounded-xl border border-border px-4 py-10 text-center text-sm text-muted-foreground" data-testid="work-automation-empty">
              {t("work.automation.empty")}
            </div>
          )}
        </section>
      </div>

      <ConfirmModal
        open={grant !== null}
        title={grant ? grantCopy(grant).title : ""}
        message={grant ? grantCopy(grant).body : ""}
        confirmLabel={grant ? grantCopy(grant).confirm : ""}
        cancelLabel={t("work.common.not_now")}
        variant="warning"
        onConfirm={() => {
          if (grant === "autopilot") save.mutate({ autopilot: true });
          else if (grant === "full_access") save.mutate({ full_access: true });
          setGrant(null);
        }}
        onCancel={() => setGrant(null)}
      />
    </div>
  );
}
