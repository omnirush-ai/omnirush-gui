/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Box, Check, CheckCircle2, Circle, ExternalLink, LoaderCircle, Monitor, XCircle } from "lucide-react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { openDesktopUrl } from "@/app/lib/desktop";
import type { OmniRushWorkspaceBox } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";
import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { useLinuxSandbox, type LinuxSandboxClient } from "@/react-app/domains/settings/linux-sandbox";
import { sandboxSetupView, type SandboxSetupButton, type SandboxSetupStep, type SandboxSetupView } from "@/react-app/domains/settings/sandbox-setup";

type Props = {
  client: LinuxSandboxClient | null;
  workspaceId: string | null;
  /** The chat shown (null on the new-chat screen): a chat kept on this computer says so instead. */
  sessionId?: string | null;
  /** A chat runs now: "Restart now" waits. */
  chatRunning?: boolean;
  onOpenSettings?: () => void;
};

/**
 * "Setting up the sandbox", across the chat above the composer: shown while
 * the account requires the sandbox and the project's box is not ready (the
 * download and start with progress; Windows' WSL setup with its restart;
 * Ubuntu's one-time Allow; why it cannot run on this computer), then
 * "ready" for a moment. Nothing for a project the sandbox is not required
 * for.
 */
export function SandboxSetupPanel(props: Props) {
  if (!props.client || !props.workspaceId) return null;
  return <Panel key={props.workspaceId} client={props.client} workspaceId={props.workspaceId} sessionId={props.sessionId ?? null} chatRunning={props.chatRunning ?? false} onOpenSettings={props.onOpenSettings} />;
}

/** As wide as the composer below it: the chat's notice column, or the new-task composer's own column. */
const WIDTH = "mb-2";

const TONE: Record<SandboxSetupView["tone"], string> = {
  busy: "text-dls-secondary",
  attention: "text-warning",
  error: "text-red-11",
  ready: "text-green-11",
  off: "text-dls-secondary",
};

function ToneIcon({ tone }: { tone: SandboxSetupView["tone"] }) {
  const className = `size-5 shrink-0 ${TONE[tone]}`;
  if (tone === "busy") return <LoaderCircle aria-hidden className={`${className} motion-safe:animate-spin`} />;
  if (tone === "ready") return <CheckCircle2 aria-hidden className={className} />;
  if (tone === "attention") return <AlertTriangle aria-hidden className={className} />;
  if (tone === "error") return <XCircle aria-hidden className={className} />;
  return <Box aria-hidden className={className} />;
}

function Step({ step }: { step: SandboxSetupStep }) {
  return (
    <li className="flex min-w-0 items-start gap-2.5" data-testid="sandbox-setup-step" data-step={step.id} data-state={step.state}>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {step.state === "done" ? <Check aria-hidden className="size-4 text-green-11" />
          : step.state === "active" ? <LoaderCircle aria-hidden className="size-4 text-dls-text motion-safe:animate-spin" />
          : <Circle aria-hidden className="size-3 text-gray-8" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] ${step.state === "todo" ? "text-dls-secondary" : "text-dls-text"}`}>{step.label}</div>
        {step.progress ? (
          <ProgressPrimitive.Root value={step.progress.value} aria-label={step.label} getAriaValueText={() => step.progress?.label ?? ""} className="mt-1 flex h-[18px] items-center gap-2" data-testid="sandbox-setup-progress">
            <ProgressTrack className="h-1.5 flex-1 bg-dls-hover">
              <ProgressIndicator className={`rounded-full bg-dls-text/70 motion-safe:duration-500 motion-reduce:transition-none ${step.progress.value === null ? "w-1/4 motion-safe:animate-pulse" : ""}`} />
            </ProgressTrack>
            <span className="shrink-0 text-[11px] tabular-nums text-dls-secondary">{step.progress.label}</span>
          </ProgressPrimitive.Root>
        ) : null}
      </div>
    </li>
  );
}

function ActionButton({ button, onPress }: { button: SandboxSetupButton; onPress: (button: SandboxSetupButton) => void }) {
  return (
    <Button size="sm" variant={button.primary ? "default" : "outline"} disabled={button.disabled} onClick={() => onPress(button)} data-testid={`sandbox-setup-${button.action}`} title={button.hint}>
      {button.label}
    </Button>
  );
}

function Panel(props: { client: LinuxSandboxClient; workspaceId: string; sessionId: string | null; chatRunning: boolean; onOpenSettings?: () => void }) {
  const sandbox = useLinuxSandbox(props.client, props.workspaceId, { fresh: false, sessionId: props.sessionId });
  const [consenting, setConsenting] = useState(false);
  const [later, setLater] = useState(false);
  const [justReady, setJustReady] = useState(false);
  const shown = useRef(false);
  const box: OmniRushWorkspaceBox | null = sandbox.box;
  // A turn started or ended: look again (a reopened chat is known to stay on this computer after its first prompt here).
  const { reload } = sandbox;
  const required = box?.required === true;
  useEffect(() => {
    if (required && props.sessionId) void reload();
  }, [props.chatRunning, props.sessionId, required, reload]);
  // Shown while not ready, then "ready" for a few seconds.
  useEffect(() => {
    if (!box?.required || !box.on) return;
    if (box.state !== "ready") {
      shown.current = true;
      return;
    }
    if (!shown.current) return;
    shown.current = false;
    setJustReady(true);
    const timer = setTimeout(() => setJustReady(false), 5_000);
    return () => clearTimeout(timer);
  }, [box?.required, box?.on, box?.state]);

  if (!box) return null;
  if (box.required && box.chatKept && props.sessionId) {
    return (
      <div className={`${WIDTH} flex items-center gap-2 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-xs text-dls-secondary`} data-testid="sandbox-kept-chat">
        <Monitor aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{box.requiredText?.keptOldChat}</span>
      </div>
    );
  }
  const view = sandboxSetupView(box, { pending: sandbox.pending, chatRunning: props.chatRunning, consenting, justReady });
  if (!view || (later && box.setup?.need === "win_restart")) return null;

  const press = (button: SandboxSetupButton) => {
    if (button.action === "consent") return setConsenting(true);
    if (button.action === "cancel") return setConsenting(false);
    if (button.action === "later") return setLater(true);
    if (button.action === "settings") return props.onOpenSettings?.();
    if (button.action === "retry") return void sandbox.retry();
    setConsenting(false);
    void sandbox.setup(button.action);
  };

  if (view.kind === "line" || view.kind === "ready") {
    return (
      <div className={`${WIDTH} flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-dls-border bg-dls-surface px-3 py-2`} data-testid="sandbox-setup-panel" data-kind={view.kind}>
        <ToneIcon tone={view.tone} />
        <div className="min-w-0 flex-1 basis-48 text-xs">
          <span className="font-medium text-dls-text" role="status">{view.title}</span>
          {view.detail ? <span className="ml-1.5 text-dls-secondary">{view.detail}</span> : null}
        </div>
        {view.buttons.map((button) => <ActionButton key={button.action} button={button} onPress={press} />)}
      </div>
    );
  }

  return (
    <section className={`${WIDTH} rounded-2xl border border-dls-border bg-dls-surface`} aria-labelledby="sandbox-setup-title" data-testid="sandbox-setup-panel" data-kind={view.kind} data-need={box.setup?.need ?? box.state}>
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <ToneIcon tone={view.tone} />
        <div className="min-w-0 flex-1">
          <h2 id="sandbox-setup-title" className="text-[14px] font-semibold text-dls-text" role="status" aria-live="polite">{view.title}</h2>
          {view.detail ? <p className="mt-0.5 text-[12px] leading-[18px] text-dls-secondary">{view.detail}</p> : null}
          {view.consent ? <p className="mt-1.5 rounded-lg border border-dls-border bg-dls-hover px-3 py-2 text-[12px] leading-[18px] text-dls-text" data-testid="sandbox-setup-consent">{view.consent}</p> : null}
          {view.steps.length ? <ol className="mt-3 space-y-2" aria-label="Setup steps">{view.steps.map((step) => <Step key={step.id} step={step} />)}</ol> : null}
          {view.howTo.length ? (
            <ol className="mt-2.5 list-decimal space-y-1 pl-5 text-[12px] leading-[18px] text-dls-text" data-testid="sandbox-setup-howto">
              {view.howTo.map((line) => <li key={line}>{line}</li>)}
            </ol>
          ) : null}
          {view.next?.command ? (
            <code className="mt-2 block truncate rounded-lg border border-dls-border bg-dls-hover px-3 py-1.5 font-mono text-[11px] text-dls-text" title={view.next.command}>{view.next.command}</code>
          ) : null}
          {view.result ? <p className={`mt-2 text-[12px] ${view.result.ok ? "text-green-11" : "text-red-11"}`} data-testid="sandbox-setup-result">{view.result.message}</p> : null}
          {sandbox.problem ? <p className="mt-2 text-[12px] text-red-11" role="alert">{sandbox.problem.message}</p> : null}
          {view.buttons.length || view.link ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {view.buttons.map((button) => <ActionButton key={button.action} button={button} onPress={press} />)}
              {view.link ? (
                <Button size="sm" variant="link" className="px-1" onClick={() => void openDesktopUrl(view.link?.href ?? "").catch(() => undefined)} data-testid="sandbox-setup-link">
                  {view.link.label}
                  <ExternalLink aria-hidden className="size-3.5" />
                </Button>
              ) : null}
              {view.buttons.find((button) => button.hint && button.disabled) ? <span className="text-[11px] text-dls-secondary">{view.buttons.find((button) => button.hint && button.disabled)?.hint}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
      {view.fallbackLine ? <div className="border-t border-dls-border px-4 py-2 pl-12 text-[11px] text-dls-secondary" data-testid="sandbox-setup-fallback">{view.fallbackLine}</div> : null}
    </section>
  );
}
