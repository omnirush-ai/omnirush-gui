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
import type { OmniRushWorkAction, OmniRushWorkSettings } from "@/app/lib/omnirush-server";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { cn } from "@/lib/utils";

import { connectorLabel, relativeTime, useWorkActions, useWorkSettings, workActionsKey, workSettingsKey, workStateKey, type WorkClient } from "./work-mode";

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : "That did not work. Try again.");

/** The one-screen plain-language grants shown before a user turns an automation on. */
type Grant = "autopilot" | "full_access" | null;
const GRANT_COPY: Record<"autopilot" | "full_access", { title: string; body: string; confirm: string }> = {
  autopilot: {
    title: "Allow all writes?",
    body: "OmniRush will send replies, schedule, and update things across your connected apps without asking each time. You stay in control — pause anytime, and undo recent actions.",
    confirm: "Allow all writes",
  },
  full_access: {
    title: "Turn on Full Access?",
    body: "OmniRush acts across all your channels, remembers what's on your screen, uses all your connected apps, and nudges you proactively — everything in one place. You can turn this off whenever you like.",
    confirm: "Turn on Full Access",
  },
};

function SettingRow(props: { title: string; description: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-foreground">{props.title}</div>
        <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{props.description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{props.control}</div>
    </div>
  );
}

const RESULT_BADGE: Record<OmniRushWorkAction["result"], { label: string; className: string; Icon: typeof Check }> = {
  done: { label: "Done", className: "border-green-6 bg-green-3 text-green-11", Icon: Check },
  failed: { label: "Failed", className: "border-red-6 bg-red-3 text-red-11", Icon: X },
  undone: { label: "Undone", className: "border-border bg-muted text-muted-foreground", Icon: RotateCcw },
};

function ResultBadge(props: { result: OmniRushWorkAction["result"] }) {
  const badge = RESULT_BADGE[props.result];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium", badge.className)} data-result={props.result}>
      <badge.Icon aria-hidden className="size-3" />{badge.label}
    </span>
  );
}

function ActionRow(props: { action: OmniRushWorkAction; now: number; onUndo: (id: string) => void; undoing: boolean }) {
  const action = props.action;
  const where = [connectorLabel(action.source), action.target.trim()].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 last:border-b-0" data-action={action.id}>
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">{action.summary}</div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{where}{where ? " · " : ""}{relativeTime(action.created_at, props.now)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ResultBadge result={action.result} />
        {action.undoable ? (
          <Button variant="outline" size="sm" disabled={props.undoing} onClick={() => props.onUndo(action.id)} data-testid="work-action-undo">
            <RotateCcw className="size-3.5" />Undo
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
    onError: (reason) => toast.error(errorText(reason)),
  });
  const undo = useMutation({
    mutationFn: (id: string) => props.client!.undoWorkAction(id),
    onSuccess: () => { toast.success("Action undone"); void queryClient.invalidateQueries({ queryKey: workActionsKey(props.client) }); },
    onError: (reason) => toast.error(errorText(reason)),
  });

  const busy = save.isPending;
  // Full Access keeps autopilot on (the server enforces it), so the autopilot switch is locked on while it is set.
  const autopilotLocked = settings?.full_access === true;
  const actions = actionsQuery.data?.actions ?? [];

  return (
    <div className="h-full overflow-y-auto" data-testid="work-automation">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-10 pt-10">
        <div>
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={props.onBack}><ArrowLeft className="size-4" />{props.backLabel ?? "Back to Work"}</Button>
          <h1 className="text-xl font-semibold tracking-tight">Automation</h1>
          <p className="mt-1 text-sm text-muted-foreground">Choose how much OmniRush can do on its own in your connected apps, and review or undo recent actions.</p>
        </div>

        {settingsQuery.isLoading ? (
          <Skeleton className="h-[220px] rounded-xl" data-testid="work-automation-loading" />
        ) : settingsQuery.error && !settings ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4" data-testid="work-automation-error">
            <span className="text-sm text-muted-foreground">{errorText(settingsQuery.error)}</span>
            <Button variant="outline" size="sm" onClick={() => void settingsQuery.refetch()}><RotateCw className="size-3.5" />Try again</Button>
          </div>
        ) : settings ? (
          <>
            {settings.writes_paused ? (
              <div className="flex items-center gap-2 rounded-xl border border-amber-6 bg-amber-3 px-4 py-3 text-[13px] text-amber-11" data-testid="work-automation-paused">
                <PauseCircle aria-hidden className="size-4 shrink-0" />
                All actions are paused. OmniRush will not send or change anything until you resume.
              </div>
            ) : null}

            <section className="flex flex-col gap-3" data-testid="work-automation-settings">
              <div className="divide-y divide-border rounded-xl border border-border bg-background">
                <SettingRow
                  title="Pause all actions"
                  description="Stop OmniRush from sending or changing anything, no matter the settings below. Reading still works."
                  control={(
                    <Switch
                      aria-label="Pause all actions"
                      data-testid="work-automation-pause"
                      checked={settings.writes_paused}
                      disabled={busy}
                      onCheckedChange={(checked) => save.mutate({ writes_paused: checked })}
                    />
                  )}
                />
                <SettingRow
                  title="Allow all writes (stop asking)"
                  description={autopilotLocked
                    ? "On with Full Access. Replies, scheduling and updates happen without asking each time."
                    : "Let OmniRush send replies, schedule and update things in your connected apps without asking each time. Off means it asks you first."}
                  control={(
                    <Switch
                      aria-label="Allow all writes"
                      data-testid="work-automation-autopilot"
                      checked={settings.autopilot}
                      disabled={busy || autopilotLocked}
                      onCheckedChange={(checked) => (checked ? setGrant("autopilot") : save.mutate({ autopilot: false }))}
                    />
                  )}
                />
                <SettingRow
                  title="Full Access"
                  description="One switch: OmniRush acts across all your channels, remembers what's on your screen, uses all your connected apps, and nudges you proactively. You can turn it off anytime."
                  control={(
                    <Switch
                      aria-label="Full Access"
                      data-testid="work-automation-full-access"
                      checked={settings.full_access}
                      disabled={busy}
                      onCheckedChange={(checked) => (checked ? setGrant("full_access") : save.mutate({ full_access: false }))}
                    />
                  )}
                />
              </div>
            </section>

            <section className="flex flex-col gap-3" data-testid="work-automation-activity">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold">Recent activity</h2>
                  <p className="text-[12px] text-muted-foreground">What OmniRush sent or changed in your connected apps. Undo recent ones you didn't want.</p>
                </div>
                <Button variant="ghost" size="sm" disabled={actionsQuery.isFetching} onClick={() => void actionsQuery.refetch()} aria-label="Refresh activity"><RotateCw className="size-3.5" /></Button>
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
              ) : actionsQuery.error ? (
                <div className="flex flex-col items-start gap-2 rounded-xl border border-border px-4 py-4">
                  <span className="text-sm text-muted-foreground">{errorText(actionsQuery.error)}</span>
                  <Button variant="outline" size="sm" onClick={() => void actionsQuery.refetch()}><RotateCw className="size-3.5" />Try again</Button>
                </div>
              ) : actions.length ? (
                <ul className="rounded-xl border border-border bg-background">
                  {actions.map((action) => (
                    <ActionRow key={action.id} action={action} now={now} undoing={undo.isPending && undo.variables === action.id} onUndo={(id) => undo.mutate(id)} />
                  ))}
                </ul>
              ) : (
                <div className="rounded-xl border border-border px-4 py-10 text-center text-sm text-muted-foreground" data-testid="work-automation-empty">
                  No actions yet. When OmniRush sends or changes something in a connected app, it shows up here.
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>

      <ConfirmModal
        open={grant !== null}
        title={grant ? GRANT_COPY[grant].title : ""}
        message={grant ? GRANT_COPY[grant].body : ""}
        confirmLabel={grant ? GRANT_COPY[grant].confirm : ""}
        cancelLabel="Not now"
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
