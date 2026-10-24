/** @jsxImportSource react */
import { useState } from "react";
import { Box, X } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { linuxSandboxView, useLinuxSandbox, type LinuxSandboxClient, type LinuxSandboxView } from "@/react-app/domains/settings/linux-sandbox";

type Props = {
  client: LinuxSandboxClient | null;
  workspaceId: string | null;
  /** The open chat (null: a new chat); a started chat keeps where it runs. */
  sessionId?: string | null;
  /** The chat's model (omnirush.ai id): its start decides whether the sandbox can be switched for it. */
  model?: string | null;
  /** Opens Settings > General at the sandbox card. */
  onOpenSettings?: () => void;
};

const DOT: Record<LinuxSandboxView["tone"], string> = {
  off: "bg-gray-8",
  busy: "bg-amber-9 motion-safe:animate-pulse",
  ready: "bg-green-9",
  attention: "bg-amber-9",
  error: "bg-red-9",
};

/**
 * The composer's sandbox indicator, beside Full permissions: shown only when
 * the project's Linux sandbox is on (its state as a dot, the line in the
 * tooltip; a click opens its Settings card), or as a small dismissible
 * "Use sandbox" prompt when the server offers it. Nothing otherwise.
 */
export function SandboxStatusChip(props: Props) {
  if (!props.client || !props.workspaceId) return null;
  return <SandboxChip key={props.workspaceId} client={props.client} workspaceId={props.workspaceId} sessionId={props.sessionId ?? null} model={props.model ?? null} onOpenSettings={props.onOpenSettings} />;
}

/** "Turning the sandbox on applies to new chats" note for a chat that already started (it keeps where it runs). */
export const PINNED_CHAT_TOGGLE_NOTE = "New chats in this project use the sandbox. This chat keeps running where it started.";

function SandboxChip(props: { client: LinuxSandboxClient; workspaceId: string; sessionId: string | null; model: string | null; onOpenSettings?: () => void }) {
  const sandbox = useLinuxSandbox(props.client, props.workspaceId, { fresh: false, sessionId: props.sessionId });
  const [offerDismissed, setOfferDismissed] = useState(false);
  const box = sandbox.box;
  if (!box) return null;
  // The server's start for this model (local_box.model_start): a model that cannot be switched (box-only,
  // native-only) shows no sandbox toggle at all; a started chat keeps its pin.
  const start = props.model ? box.modelStart?.[props.model] ?? null : null;
  if (start && !start.switchable) return null;
  const pinned = Boolean(box.chatPin);
  const chip = "flex h-9 max-h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12";

  if (!box.on && sandbox.pending !== "on") {
    // The server's default left this project on this computer (its folder has this computer's builds), or the
    // sandbox is required but the project only builds on this OS: say why.
    const offWhy = box.hostBuilds?.native ? box.hostBuilds.notice : box.source === "host-only" ? box.hostOnly?.notice ?? null : null;
    if (offWhy) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={<button type="button" aria-label="Linux sandbox: off for this project" data-testid="sandbox-host-builds-chip" className={chip} onClick={props.onOpenSettings} />}
          >
            <span className="relative">
              <Box className="size-4" aria-hidden />
              <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-dls-surface ${DOT.off}`} />
            </span>
            <span className="hidden whitespace-nowrap @min-[760px]/composer:inline">Sandbox off</span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex max-w-64 flex-col">
              <span className="font-medium">Linux sandbox: off for this project</span>
              <span>{offWhy}</span>
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }
    if (!box.offer || offerDismissed) return null;
    return (
      <div className="flex shrink-0 items-center rounded-md border border-dashed border-gray-6" data-testid="sandbox-offer-chip">
        <Tooltip>
          <TooltipTrigger
            render={
              <button type="button" className={`${chip} h-8 max-h-8 pr-1.5`} onClick={() => { void sandbox.setEnabled(true); if (pinned) toast(PINNED_CHAT_TOGGLE_NOTE); }} data-testid="sandbox-offer-accept" />
            }
          >
            <Box className="size-4" aria-hidden />
            <span className="whitespace-nowrap">Use sandbox</span>
          </TooltipTrigger>
          <TooltipContent>Your omnirush.ai server recommends running this project's commands in a Linux sandbox. Click to turn it on.</TooltipContent>
        </Tooltip>
        <button type="button" aria-label="Not now" className="mr-1 flex size-6 items-center justify-center rounded text-gray-9 hover:bg-gray-3 hover:text-gray-12" onClick={() => setOfferDismissed(true)}>
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  const view = linuxSandboxView(box, sandbox.pending);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Linux sandbox: ${view.title}`}
            data-testid="sandbox-status-chip"
            data-tone={view.tone}
            className={chip}
            onClick={props.onOpenSettings}
          />
        }
      >
        <span className="relative">
          <Box className="size-4" aria-hidden />
          <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-dls-surface ${DOT[view.tone]}`} />
        </span>
        {/* An icon (its state in the tooltip and aria-label) until the composer is wide enough. */}
        <span className="hidden whitespace-nowrap @min-[760px]/composer:inline">Sandbox</span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex max-w-64 flex-col">
          <span className="font-medium">Linux sandbox: {view.title}</span>
          {view.progress ? <span>{view.progress.label}</span> : view.detail ? <span>{view.detail}</span> : null}
          {box.required && box.requiredText ? <span className="mt-1 text-gray-9">{box.requiredText.line}</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
