/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { FileDiff, Gauge, Redo2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { omnirushAccountStatus } from "@/app/lib/desktop";
import { omnirushUsageSummary } from "@/app/lib/omnirush-usage";
import type { OmniRushServerClient, OmniRushPendingUploads, OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import { snapshotKey } from "@/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { refreshAccountStatus, useAccountStatusStore } from "@/app/lib/quality";
import type { ModelRef } from "@/app/types";
import { linuxSandboxView, useLinuxSandbox } from "@/react-app/domains/settings/linux-sandbox";
import { useSessionModelSelection } from "@/react-app/domains/session/surface/session-model-store";
import type { ProviderCatalog } from "@/react-app/domains/session/surface/use-model-behavior";
import { ChangesPanel } from "./changes-panel";
import { contextUse, sandboxLabel, uploadsLine } from "./context-usage";
import { useSessionCommandsStore } from "./session-commands-store";
import { chatUndoKey } from "./undo-key";
import { useCachedQueryData, useUndoRedo, visibleMessages, type SessionCommandTarget } from "./use-session-commands";
import { t } from "@/i18n";

export type SessionCommandModelProps = {
  selectedModel: ModelRef;
  modelLabel: string;
  modelVariant: string | null;
  modelVariantLabel: string;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  providerCatalog?: ProviderCatalog;
  onModelVariantChange: (value: string | null) => void;
};

export type SessionCommandControlsProps = SessionCommandTarget & {
  serverClient: OmniRushServerClient | null;
  model: SessionCommandModelProps | null;
};

const iconButton = "hidden rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground lg:inline-flex";

function isMac() {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

/**
 * The session header's chat commands: Undo last turn (and Redo while a turn
 * is undone), the Changes panel, and the Status popover.
 */
export function SessionCommandControls(props: SessionCommandControlsProps) {
  const commands = useUndoRedo(props);
  const openChanges = useSessionCommandsStore((state) => state.openChanges);
  const { undo, redo, canUndo, canRedo } = commands;

  const running = commands.running;
  // The same undo / redo for the header menu (narrow windows hide these buttons).
  const setHeaderActions = useSessionCommandsStore((state) => state.setHeaderActions);
  useEffect(() => {
    setHeaderActions(props.sessionId, { canUndo, canRedo, undo, redo });
    return () => setHeaderActions(props.sessionId, null);
  }, [canRedo, canUndo, props.sessionId, redo, setHeaderActions, undo]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = chatUndoKey(event, isMac(), props.sessionId);
      if (!action) return;
      // Only with the chat on screen: no dialog or menu in front of it.
      if (document.querySelector("[role=dialog][data-open], [role=alertdialog], [role=menu]")) return;
      if (action === "undo" && !canUndo) return;
      if (action === "redo" && !canRedo) return;
      event.preventDefault();
      event.stopPropagation();
      // The keyboard never stops a turn (a stray Ctrl+Z must not cut the agent off).
      if (running) {
        toast.info(t("session.undo_stop_first"), { duration: 4000 });
        return;
      }
      // A key press is easy to make by accident: the undo (the turn and its file changes) asks first.
      if (action === "undo" && !window.confirm(t("session.undo_confirm"))) return;
      void (action === "undo" ? undo() : redo());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [canRedo, canUndo, props.sessionId, redo, running, undo]);

  const mod = isMac() ? "⌘" : "Ctrl+";
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconButton}
              aria-label={t("session.undo_last_turn")}
              data-testid="session-undo"
              disabled={!canUndo}
              onClick={() => void undo()}
            >
              <Undo2 size={16} className={cn(commands.busyAction === "undo" && "animate-pulse")} />
            </Button>
          }
        />
        <TooltipContent>{t("session.undo_last_turn")} ({mod}Z)</TooltipContent>
      </Tooltip>
      {canRedo || commands.busyAction === "redo" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className={iconButton}
                aria-label={t("session.redo")}
                data-testid="session-redo"
                disabled={!canRedo}
                onClick={() => void redo()}
              >
                <Redo2 size={16} className={cn(commands.busyAction === "redo" && "animate-pulse")} />
              </Button>
            }
          />
          <TooltipContent>{t("session.redo_turn")} ({mod}{isMac() ? "⇧Z" : "Shift+Z"})</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconButton}
              aria-label={t("session.changes")}
              data-testid="session-changes"
              onClick={() => openChanges(props.sessionId)}
            >
              <FileDiff size={16} />
            </Button>
          }
        />
        <TooltipContent>{t("session.changes")}</TooltipContent>
      </Tooltip>
      <StatusPopover {...props} />
      <StatusDialog {...props} />
      <ChangesPanel
        workspaceId={props.workspaceId}
        sessionId={props.sessionId}
        opencodeBaseUrl={props.opencodeBaseUrl}
        token={props.token}
        workspaceRoot={props.workspaceRoot}
      />
    </>
  );
}

/** Status from the header menu (narrow windows, where the header button is hidden). */
function StatusDialog(props: SessionCommandControlsProps) {
  const open = useSessionCommandsStore((state) => state.statusOpenFor === props.sessionId);
  const closeStatus = useSessionCommandsStore((state) => state.closeStatus);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeStatus(); }}>
      <DialogContent className="max-w-sm gap-0 p-0" data-testid="session-status-dialog">
        <DialogTitle className="sr-only">{t("session.status")}</DialogTitle>
        {open ? <StatusRows {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function StatusPopover(props: SessionCommandControlsProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(iconButton, open && "bg-primary/10 text-link")}
                  aria-label={t("session.status")}
                  data-testid="session-status"
                >
                  <Gauge size={16} />
                </Button>
              }
            />
          }
        />
        <TooltipContent>{t("session.status")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[22rem] gap-0 rounded-2xl p-0" data-testid="session-status-popover">
        {open ? <StatusRows {...props} /> : null}
      </PopoverContent>
    </Popover>
  );
}

type Row = { label: string; value: string; detail?: string | null; tone?: "warning" };

function StatusRow({ row }: { row: Row }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2" data-status-row={row.label}>
      <span className="w-24 shrink-0 text-[12px] text-muted-foreground">{row.label}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[12.5px] text-foreground", row.tone === "warning" && "font-medium text-warning")}>{row.value}</span>
        {row.detail ? <span className="block text-[11.5px] text-muted-foreground">{row.detail}</span> : null}
      </span>
    </div>
  );
}

const FALLBACK_MODEL: SessionCommandModelProps = {
  selectedModel: { providerID: "", modelID: "" },
  modelLabel: "",
  modelVariant: null,
  modelVariantLabel: "",
  onModelVariantChange: () => undefined,
};

function StatusRows(props: SessionCommandControlsProps) {
  const model = props.model ?? FALLBACK_MODEL;
  const selection = useSessionModelSelection({
    sessionId: props.sessionId,
    fallbackModel: model.selectedModel,
    fallbackModelLabel: model.modelLabel,
    fallbackVariant: model.modelVariant,
    fallbackVariantLabel: model.modelVariantLabel,
    fallbackBehaviorOptions: model.modelBehaviorOptions,
    providerCatalog: model.providerCatalog,
    onFallbackVariantChange: model.onModelVariantChange,
  });
  const cached = useCachedQueryData<OmniRushSessionSnapshot>(snapshotKey(props.workspaceId, props.sessionId));
  const snapshot = cached?.session.id === props.sessionId ? cached : null;
  const account = useAccountStatusStore((store) => store.status);
  const [pending, setPending] = useState<OmniRushPendingUploads | null>(null);
  const [pendingFailed, setPendingFailed] = useState(false);

  useEffect(() => {
    void refreshAccountStatus(omnirushAccountStatus);
    // The newest reply's token counts (the chat's own query fetches them again).
    void getReactQueryClient().invalidateQueries({ queryKey: snapshotKey(props.workspaceId, props.sessionId) });
    let cancelled = false;
    if (props.serverClient) {
      props.serverClient.getPendingUploads().then(
        (value) => { if (!cancelled) setPending(value); },
        () => { if (!cancelled) setPendingFailed(true); },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [props.serverClient, props.sessionId, props.workspaceId]);

  const rows: Row[] = [];
  const messages = visibleMessages(snapshot).map((message) => message.info as { role?: string; tokens?: never; providerID?: string; modelID?: string });
  const lastModel = [...messages].reverse().find((item) => item.role === "assistant" && item.modelID);
  const modelName = selection.modelLabel || lastModel?.modelID || "";
  if (modelName) {
    rows.push({ label: "Model", value: modelName });
    rows.push({ label: "Effort", value: selection.modelVariantLabel || selection.modelVariant || "default" });
  }
  const context = contextUse(messages, (providerID, modelID) => {
    const limit = (model.providerCatalog?.[providerID]?.[modelID] as { limit?: { context?: number } } | undefined)?.limit?.context;
    return typeof limit === "number" ? limit : null;
  });
  if (context) rows.push({ label: "Context", value: context.text, tone: context.warning ? "warning" : undefined, detail: context.warning ? "The chat is close to its limit; it will be compacted soon." : null });
  else rows.push({ label: "Context", value: "nothing used yet" });

  const usage = account?.connected && account.usage ? omnirushUsageSummary(account.usage) : null;
  rows.push(usage
    ? { label: "Tokens left", value: usage.short, detail: usage.line !== usage.short ? usage.line : null }
    : { label: "Tokens left", value: account?.connected ? "unknown" : "sign in to see" });

  return (
    <div className="flex flex-col py-2">
      <div className="px-4 pb-1 pt-1 text-[13px] font-medium">Status</div>
      {rows.map((row) => <StatusRow key={row.label} row={row} />)}
      <SandboxRow client={props.serverClient} workspaceId={props.workspaceId} />
      <StatusRow
        row={{
          label: "Uploads",
          value: pending ? uploadsLine(pending, { signedOut: account?.connected === false }) ?? "unknown" : pendingFailed ? "unknown" : "checking…",
        }}
      />
    </div>
  );
}

function SandboxRow(props: { client: OmniRushServerClient | null; workspaceId: string }) {
  const sandbox = useLinuxSandbox(props.client, props.workspaceId, { fresh: false });
  const box = sandbox.box;
  if (!props.client) return null;
  if (!box) return <StatusRow row={{ label: "Sandbox", value: sandbox.problem ? "unknown" : "checking…" }} />;
  const view = linuxSandboxView(box, sandbox.pending);
  const value = sandboxLabel(box);
  return <StatusRow row={{ label: "Sandbox", value, detail: view.detail }} />;
}
