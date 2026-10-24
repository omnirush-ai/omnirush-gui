/** @jsxImportSource react */
// Computer use, findable: the Settings card (on/off for this computer, "Use my own screen") and the hint above
// the composer when a draft asks for something on a screen. Computer use is on by default and works on the
// agent's own display; the person's own screen is off until they turn it on here (with a confirm).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, MousePointer2, X } from "lucide-react";

import type { ComputerUseRealScreen } from "@omnirush/types/desktop-ipc";

import { desktopBridge } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { useComputerUseStatus } from "./status-store";

/** Mirrors SCREEN_INTENT in apps/server/src/computer-use/shared/policy.mjs (setup.test.ts compares them). */
export const SCREEN_INTENT = /(?:^|[.,;!]\s*|\b(?:and|then|please|to)\s+)(?:double[- ])?click\b|\b(?:my (?:browser|screen|desktop|mouse|computer)|(?:use|open|launch|start) (?:the |a |my )?(?:browser|chrome|firefox|edge|safari|app|application|program)|screenshot|computer use|take over my|fill (?:in|out) (?:the |this )?form)\b/i;
export const screenIntent = (text: string) => SCREEN_INTENT.test(text);

export const COMPUTER_USE_TITLE = "Computer use";
export const COMPUTER_USE_ON = "On. The agent works on its own display, with its own cursor and browser, and never asks for approval there.";
export const COMPUTER_USE_OFF = "Off on this computer. The agent gets no computer use tools.";
export const OWN_SCREEN_HELP = "Off by default. When on, the agent can also click and type in the apps on your screen, without asking. Stop it any time with Stop.";
export const OWN_SCREEN_CONFIRM = "The agent will be able to use your own screen, mouse and keyboard without asking: it can click and type in your apps.";
export const OWN_SCREEN_SERVER_OFF = "Your own screen is turned off for everyone right now; the agent uses its own display.";

const REAL_SCREEN_KEY = ["computer-use", "real-screen"];

/** The status, this computer's switches, and the confirm before the person's own screen is turned on. */
export function useComputerUseSetup(active = true) {
  const status = useComputerUseStatus();
  const queryClient = useQueryClient();
  const enabled = status?.enabled === true;
  const realScreen = useQuery({
    queryKey: REAL_SCREEN_KEY,
    queryFn: async (): Promise<ComputerUseRealScreen> => desktopBridge.getComputerUseRealScreen(),
    enabled: active && enabled,
    retry: false,
    staleTime: 30_000,
  });
  const setOwnScreen = useMutation({
    mutationFn: async (on: boolean) => desktopBridge.setComputerUseRealScreen(on),
    onSuccess: (next) => queryClient.setQueryData(REAL_SCREEN_KEY, next),
  });
  const setOn = useMutation({ mutationFn: async (on: boolean) => desktopBridge.setComputerUseOn(on) });
  const ownScreenReady = realScreen.data?.on === true && realScreen.data.allowed;
  return { status, enabled, deviceOn: status?.device_on !== false, realScreen, setOwnScreen, setOn, ownScreenReady };
}

function statusLine(status: ReturnType<typeof useComputerUseStatus>) {
  if (!status) return "Checking…";
  if (status.device_on === false) return COMPUTER_USE_OFF;
  if (status.enabled) return COMPUTER_USE_ON;
  return status.message ?? "Computer use is turned off right now.";
}

function modelsLine(models: string[] | null | undefined) {
  return models?.length ? `Works with ${models.join(", ")}. Pick one of them in the chat.` : null;
}

/** "Turn on" / "Cancel" under a short warning: the one-time confirm before the person's own screen. */
function OwnScreenConfirm(props: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-dls-border p-3" role="alertdialog" aria-label="Use my own screen" data-computer-use-confirm>
      <div className="text-[11px] text-dls-text">{OWN_SCREEN_CONFIRM}</div>
      <div className="flex gap-2">
        <Button type="button" size="xs" onClick={props.onConfirm} data-computer-use-confirm-on>Turn on</Button>
        <Button type="button" variant="ghost" size="xs" onClick={props.onCancel}>Keep it off</Button>
      </div>
    </div>
  );
}

/** Settings > General > Computer use. */
export function ComputerUseSettingsCard() {
  const setup = useComputerUseSetup();
  const data = setup.realScreen.data;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => { setError(null); action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "That did not work. Try again.")); };
  // The switch is the person's own choice; while the server has computer use off here (macOS), only the reason shows.
  const showSwitch = setup.status !== null && (setup.enabled || !setup.deviceOn);
  return (
    <div className="space-y-3" data-computer-use-settings>
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">{COMPUTER_USE_TITLE}</div>
      <div className="space-y-3 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
            <MousePointer2 size={17} className="text-dls-secondary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-dls-text">{COMPUTER_USE_TITLE}</div>
            <div id="computer-use-status" className="text-[11px] text-dls-secondary" role="status" data-computer-use-status>{statusLine(setup.status)}</div>
            {setup.enabled && modelsLine(setup.status?.models) ? <div className="text-[11px] text-dls-secondary">{modelsLine(setup.status?.models)}</div> : null}
          </div>
          {showSwitch ? (
            <Switch
              aria-label={COMPUTER_USE_TITLE}
              aria-describedby="computer-use-status"
              checked={setup.deviceOn}
              disabled={setup.setOn.isPending}
              onCheckedChange={(on: boolean) => run(() => setup.setOn.mutateAsync(on))}
              data-computer-use-on
            />
          ) : null}
        </div>
        {setup.enabled ? (
          <div className="flex items-start gap-4 border-t border-dls-border pt-3">
            {/* The same icon column as the row above, so both rows' text lines up. */}
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
              <Monitor size={17} className="text-dls-secondary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-dls-text">Use my own screen</div>
              <div id="computer-use-own-screen-help" className="text-[11px] text-dls-secondary">
                {data?.forced ? "Set by the OMNIRUSH_COMPUTER_USE_REAL_SCREEN environment variable." : OWN_SCREEN_HELP}
              </div>
              {data && !data.allowed ? <div className="mt-1 text-[11px] text-dls-secondary">{OWN_SCREEN_SERVER_OFF}</div> : null}
              {confirming ? <OwnScreenConfirm onConfirm={() => { setConfirming(false); run(() => setup.setOwnScreen.mutateAsync(true)); }} onCancel={() => setConfirming(false)} /> : null}
              {error ? <div className="mt-1 text-[11px] text-red-11" role="alert">{error}</div> : null}
            </div>
            <Switch
              aria-label="Use my own screen"
              aria-describedby="computer-use-own-screen-help"
              checked={data?.on === true}
              disabled={!data || data.forced || setup.setOwnScreen.isPending}
              onCheckedChange={(on: boolean) => (on ? setConfirming(true) : run(() => setup.setOwnScreen.mutateAsync(false)))}
              data-computer-use-real-screen
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// "Not now": hidden for the rest of this launch.
let hintDismissed = false;

/** Above the composer, while the draft asks for something on a screen and the person's own screen is not on. */
export function useComputerUseHint(draft: string) {
  const intent = !hintDismissed && screenIntent(draft);
  const setup = useComputerUseSetup(intent);
  const [, rerender] = useState(0);
  const [confirming, setConfirming] = useState(false);
  // Off on this computer: no tips. On but the server has the person's screen off: nothing they can do here.
  if (!intent || !setup.status || !setup.deviceOn || setup.ownScreenReady) return null;
  if (setup.enabled && (!setup.realScreen.data || !setup.realScreen.data.allowed || setup.realScreen.data.forced)) return null;
  const dismiss = () => { hintDismissed = true; rerender((n) => n + 1); };
  const message = !setup.enabled
    ? statusLine(setup.status)
    : "The agent can already do this on its own display, with its own browser and cursor. To let it use your screen and apps, turn on your own screen.";
  return (
    <div className="mb-2 flex items-start gap-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-2" role="status" data-computer-use-hint>
      <MousePointer2 size={15} className="mt-0.5 shrink-0 text-dls-secondary" />
      <div className="min-w-0 flex-1 text-[12px] text-dls-text">
        <div className="font-medium">{COMPUTER_USE_TITLE}</div>
        <div className="text-dls-secondary">{message}</div>
        {confirming ? <OwnScreenConfirm onConfirm={() => { setConfirming(false); void setup.setOwnScreen.mutateAsync(true).catch(() => undefined); }} onCancel={() => setConfirming(false)} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {setup.enabled && !confirming ? (
          <Button type="button" variant="outline" size="xs" onClick={() => setConfirming(true)} data-computer-use-hint-action>
            Use my own screen
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Not now" onClick={dismiss}>
          <X />
        </Button>
      </div>
    </div>
  );
}
