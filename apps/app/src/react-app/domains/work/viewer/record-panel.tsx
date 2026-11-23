/** @jsxImportSource react */
// A record tab in the side panel (design 2.5, A12, A13, A22): the record from GET /work/records/detail with its header
// (source, title, people), state notes, the body for its view, related records and what can be done on it. Sends wait
// out an undo window (Settings > Work), every action goes through POST /work/records/action, and the keyboard map
// (?) covers reading, replying and stepping through the list it came from. An older server (no route) closes the tab and
// opens the item at its source, as before.
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Copy, ExternalLink, Keyboard, Link2, MessageSquare, MoreHorizontal, RefreshCw, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { isElectronRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/react-app/kernel/platform";

import { usePanelTabStore, type RecordPanelTab } from "../../session/panel/panel-tab-store";
import { BrandTile } from "../brand-icon";
import { useOpenWorkLink } from "../browser/use-work-links";
import type { OpenWorkLinkOptions } from "../browser/work-links";
import { workConnectorsKey, workFailure, WORK_ACTIVITY_ROUTE } from "../work-mode";
import { issueRef, issueState } from "./issue-view";
import { mailMessages } from "./mail-view";
import { NewMail, NewMeeting, type Calendar } from "./meeting-composer";
import { AttachmentPreview, Pill, RecordSkeleton, RelatedList, statusTone, ViewerContext, type ViewerContextValue } from "./parts";
import { ActionArea, holdsSend, type ComposerMode, type SubmitPayload } from "./record-actions";
import { openRecordTab } from "./record-tabs";
import { RecordView } from "./record-view";
import {
  actionArgs, askPrompt, clientActionId, draftKey, holdSend, isEditable, isMac, isMissingRoute, neighbour, personName, recordList,
  connectorName, requestAskAbout, sourceLabel, sourceMark, useRecordDrafts, useUndoSendStore, useViewerSupport, workRecordKey,
  type RecordFile, type RecordRef, type SendFn, type SendInput, type WorkRecord,
} from "./records";
import { RECORD_SHORTCUTS, shortcutKeys } from "./shortcuts";

/** A failed write in words, with the fix when there is one (install the GitHub App, reconnect, resume actions). */
export function sendFailure(error: unknown, source: string): { text: string; fix?: "setup" | "reconnect" | "settings"; url?: string } {
  const failure = error && typeof error === "object" ? (error as { code?: unknown; details?: unknown; status?: unknown }) : {};
  const code = typeof failure.code === "string" ? failure.code : "";
  const details = failure.details && typeof failure.details === "object" ? (failure.details as Record<string, unknown>) : {};
  const reason = typeof details.reason === "string" ? details.reason : "";
  const url = typeof details.setup_url === "string" ? details.setup_url : undefined;
  const name = connectorName(source);
  if (code === "writes_paused") return { text: t("work.viewer.writes_paused"), fix: "settings" };
  if (code === "needs_install" || code === "needs_permission" || code === "repo_not_installed") return { text: reason || workFailure(error).text, fix: url ? "setup" : undefined, url };
  if (code === "reconnect_required") return { text: t("work.viewer.reconnect_to_act", { name }), fix: "reconnect" };
  if (code === "not_connected") return { text: t("work.viewer.not_connected", { name }) };
  if (code === "connector_off" || code === "connector_not_allowed") return { text: t("work.viewer.turned_off") };
  if (code === "not_supported") return { text: reason && !/ on [a-z_]+ [a-z_]+$/.test(reason) ? reason : t("work.viewer.not_supported") };
  if (code === "rate_limited") {
    const wait = Number(details.retry_after);
    return { text: Number.isFinite(wait) && wait > 0 ? t("work.viewer.rate_limited_in", { seconds: Math.ceil(wait) }) : t("work.viewer.rate_limited") };
  }
  if (code === "bad_arguments") {
    const field = typeof details.field === "string" ? details.field : "";
    return { text: field === "to" ? t("work.viewer.check_recipients") : t("work.viewer.check_message") };
  }
  return { text: workFailure(error).text };
}

/** Header text for a record: "3 messages", "#ops-dock", "owner/repo #12". */
function sourceDetail(record: WorkRecord): string {
  if (record.view === "mail") {
    const n = mailMessages(record).length;
    return n > 1 ? t("work.viewer.messages_count", { count: n }) : "";
  }
  if (record.view === "chat") return record.where ?? "";
  if (record.view === "issue") return issueRef(record);
  return record.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function stateWord(record: WorkRecord): string | null {
  if (record.view === "issue") return issueState(record);
  if (record.view === "crm" && record.stage) return record.stage;
  if (record.view === "ticket") return record.fields?.find((f) => /^(status|state)$/i.test(f.label))?.value ?? null;
  return null;
}

function HeaderButton(props: { label: string; keys?: string; onPress: () => void; children: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={props.label} onClick={props.onPress} disabled={props.disabled} data-testid={props.testId}>{props.children}</Button>} />
      <TooltipContent>{props.keys ? `${props.label} (${props.keys})` : props.label}</TooltipContent>
    </Tooltip>
  );
}

function ShortcutsSheet(props: { view: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} tabIndex={-1} className="absolute inset-0 z-30 flex flex-col bg-background/95 outline-none backdrop-blur-sm" role="dialog" aria-label={t("work.viewer.shortcuts")} data-testid="work-viewer-shortcuts">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-[13px] font-semibold text-foreground">{t("work.viewer.shortcuts")}</h2>
        <Button variant="ghost" size="sm" onClick={props.onClose}>{t("common.close")}</Button>
      </div>
      <dl className="grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-6 gap-y-2.5 overflow-y-auto p-4 text-[13px]">
        {RECORD_SHORTCUTS.filter((s) => !s.views || s.views.includes(props.view)).map((s) => (
          <div key={s.id} className="contents">
            <dt className="flex flex-wrap gap-1">{shortcutKeys(s.keys, isMac()).map((k, i) => <kbd key={i} className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-[12px] text-foreground">{k}</kbd>)}</dt>
            <dd className="text-muted-foreground">{t(s.label)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Banner(props: { children: ReactNode; action?: ReactNode; tone?: "neutral" | "amber" | "red"; testId?: string }) {
  return (
    <div className={cn(
      "mx-4 mt-3 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] leading-5",
      props.tone === "red" ? "border-red-6/60 bg-red-2 text-red-11 dark:bg-red-3/30" : props.tone === "amber" ? "border-amber-6/60 bg-amber-2 text-amber-12 dark:bg-amber-3/30" : "border-border bg-muted/40 text-muted-foreground",
    )} role="status" data-testid={props.testId}>
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.action}
    </div>
  );
}

function Failure(props: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="work-viewer-failure">
      <p className="text-[14px] font-semibold text-foreground">{props.title}</p>
      {props.body ? <p className="max-w-[300px] text-[13px] text-muted-foreground">{props.body}</p> : null}
      {props.action}
    </div>
  );
}

const openComposers = new Map<string, ComposerMode>();

export function RecordPanel(props: { panelKey: string; tab: RecordPanelTab; client: OmniRushServerClient | null; onClose: () => void }) {
  const client = props.client;
  const platform = usePlatform();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const tab = props.tab;
  const sourceId = tab.sourceId;
  const [live, setLive] = useState<"auto" | "1">("auto");
  // An open composer survives the panel moving (a narrow window shows it as its own pane).
  const [mode, setModeState] = useState<ComposerMode>(() => openComposers.get(tab.id) ?? null);
  const setMode = useCallback((next: ComposerMode) => {
    if (next) openComposers.set(tab.id, next); else openComposers.delete(tab.id);
    setModeState(next);
  }, [tab.id]);
  const [preview, setPreview] = useState<{ file: RecordFile; sourceId: string } | null>(null);
  const [help, setHelp] = useState(false);
  const setSupport = useViewerSupport((s) => s.setSupport);
  const delay = useUndoSendStore((s) => s.delay);

  const record = useQuery({
    queryKey: [...workRecordKey(client, sourceId), live],
    queryFn: async () => (await client!.getWorkRecord(sourceId, live)) as unknown as WorkRecord,
    enabled: Boolean(client && sourceId && !tab.compose),
    retry: (count, error) => !isMissingRoute(error) && count < 1 && ((error as { status?: number }).status ?? 500) >= 500,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const data = record.data;
  const connectors = useQuery({
    queryKey: workConnectorsKey(client),
    queryFn: () => client!.listWorkConnectors(),
    enabled: Boolean(client && tab.compose),
    staleTime: 60_000,
  });

  // A record's Open and the links in it: the Work link router (a tab in this panel, or the person's own browser).
  const routeLink = useOpenWorkLink(props.panelKey);
  const openLink = useCallback((url: string, options?: OpenWorkLinkOptions) => {
    if (isElectronRuntime()) routeLink(url, options);
    else platform.openLink(url);
  }, [platform, routeLink]);
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  // An older server: no viewers. The item opens at its source, as before, and later ones go straight there.
  useEffect(() => {
    if (record.isSuccess) setSupport("yes");
    if (record.error && isMissingRoute(record.error)) {
      setSupport("no");
      usePanelTabStore.getState().closeTab(props.panelKey, tab.id);
      if (tab.url) openLinkRef.current(tab.url);
    }
  }, [record.isSuccess, record.error, setSupport, props.panelKey, tab.id, tab.url]);

  // The tab's label follows the record's title once known.
  useEffect(() => {
    if (!data) return;
    const label = data.subject?.trim() ? (data.subject.length > 80 ? `${data.subject.slice(0, 79)}…` : data.subject) : tab.label;
    if (label === tab.label && sourceMark(data) === tab.mark) return;
    const store = usePanelTabStore.getState();
    const session = store.sessions[props.panelKey];
    const current = session?.tabs.find((entry) => entry.id === tab.id);
    if (current?.type === "record") store.openTab(props.panelKey, { ...current, label, source: data.source, mark: sourceMark(data), kind: data.kind, url: data.url ?? current.url });
    if (session?.activeTabId && session.activeTabId !== tab.id) store.selectTab(props.panelKey, session.activeTabId);
  }, [data, props.panelKey, tab.id, tab.label, tab.mark]);

  const openRecord = useCallback((ref: RecordRef) => { openRecordTab(props.panelKey, ref); }, [props.panelKey]);
  const composeTo = useCallback((address: string) => { openRecordTab(props.panelKey, { sourceId: "", compose: { kind: "mail", to: [address] } }); }, [props.panelKey]);
  const viewer = useMemo<ViewerContextValue>(() => ({ client, openLink, openRecord, composeTo }), [client, openLink, openRecord, composeTo]);

  const reconnect = useCallback(async () => {
    const source = data?.source ?? tab.source;
    if (!client || !source) return;
    try {
      const answer = await client.startWorkConnector(source);
      platform.openLink(answer.auth_url);
    } catch (error) {
      toast.error(workFailure(error).text);
    }
  }, [client, data?.source, platform, tab.source]);
  const openSettings = useCallback(() => navigate(WORK_ACTIVITY_ROUTE), [navigate]);

  const refresh = useCallback(() => {
    if (data?.can_live) setLive("1");
    void queryClient.invalidateQueries({ queryKey: workRecordKey(client, sourceId) });
  }, [client, data?.can_live, queryClient, sourceId]);

  const failed = useCallback((error: unknown, source: string) => {
    const failure = sendFailure(error, source);
    toast.error(failure.text, failure.fix === "setup" && failure.url ? { action: { label: source === "github" ? t("work.viewer.install_github") : t("work.viewer.fix"), onClick: () => platform.openLink(failure.url!) } }
      : failure.fix === "reconnect" ? { action: { label: t("work.connectors.reconnect"), onClick: () => void reconnect() } }
      : failure.fix === "settings" ? { action: { label: t("work.viewer.open_settings"), onClick: openSettings } } : undefined);
  }, [openSettings, platform, reconnect]);

  /** One write, through the undo window when it reaches people. */
  const send: SendFn = useCallback((input: SendInput) => new Promise<boolean>((resolve) => {
    if (!client || !data) { resolve(false); return; }
    const source = data.source;
    const id = clientActionId();
    const run = async () => {
      try {
        const answer = await client.runWorkRecordAction({ source_id: data.source_id, action: input.action, args: input.args, client_action_id: id });
        const drafts = useRecordDrafts.getState();
        for (const key of Object.keys(drafts.drafts)) if (key === draftKey(data.source_id, input.action) || (input.action === "draft" && key.startsWith(`${data.source_id}::`))) drafts.clear(key);
        const done = input.done ?? (input.action === "draft" ? t("work.viewer.draft_saved") : t("work.viewer.sent"));
        if (answer.undo?.available && answer.action_id) {
          const actionId = answer.action_id;
          toast.undo(done, { undo: { label: t("work.viewer.undo"), onClick: () => { void client.undoWorkAction(actionId).then(() => { toast.success(t("work.viewer.undone")); refresh(); }).catch((error: unknown) => toast.error(workFailure(error).text)); } }, closeLabel: t("common.close") });
        } else {
          toast.success(done);
        }
        // Read again from the source: the new message shows (the saved copy has it only after the next sync).
        window.setTimeout(refresh, 600);
        resolve(true);
      } catch (error) {
        failed(error, source);
        // The draft is still there: the composer opens with it.
        if (holdsSend(input.action)) setMode({ action: input.action });
        resolve(false);
      }
    };
    if (input.hold && delay > 0) {
      holdSend({
        sourceId: data.source_id,
        label: input.label,
        delayMs: delay * 1000,
        run: () => void run(),
        onUndo: () => { setMode({ action: input.action }); resolve(false); },
      });
    } else {
      void run();
    }
  }), [client, data, delay, failed, refresh]);

  const submit = useCallback((action: string, payload: SubmitPayload) => {
    if (!data) return;
    const args = actionArgs({ action, source: data.source, content: payload.content, mail: payload.mail, subject: payload.subject, due: payload.due, stage: payload.stage });
    const target = payload.mail?.to?.length ? payload.mail.to.join(", ") : data.subject || "";
    const label = action === "forward" ? t("work.viewer.label_forward", { to: target }) : action === "reply" || action === "reply_all" ? (data.view === "mail" ? t("work.viewer.label_reply", { to: target }) : t("work.viewer.label_message")) : action === "post" ? t("work.viewer.label_message") : action === "note" ? t("work.viewer.label_note") : action === "comment" ? t("work.viewer.label_comment") : action === "draft" ? t("work.viewer.label_draft") : actionLabelFor(action);
    setMode(null);
    void send({ action, args, label, hold: holdsSend(action) });
  }, [data, send]);

  // Keyboard: reading and replying keys while the panel (or a Work list) has focus; Esc closes the composer first.
  const list = recordList(tab.id);
  const step = useCallback((by: 1 | -1) => {
    const next = neighbour(list, sourceId, by);
    if (next) openRecordTab(props.panelKey, { ...next });
  }, [list, props.panelKey, sourceId]);
  const offered = useMemo(() => new Set((data?.actions ?? []).filter((a) => !a.disabled && !data?.writes_paused).map((a) => a.id)), [data]);
  useEffect(() => {
    const root = rootRef.current;
    const capture = (event: KeyboardEvent) => {
      const inside = root && event.target instanceof Node && root.contains(event.target);
      if (event.key === "Escape" && inside) {
        if (preview) { setPreview(null); event.stopPropagation(); event.preventDefault(); return; }
        if (help) { setHelp(false); event.stopPropagation(); event.preventDefault(); return; }
        if (mode && data?.view !== "chat") { setMode(null); root?.focus(); event.stopPropagation(); event.preventDefault(); return; }
      }
    };
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (isEditable(target)) return;
      const inside = root && target instanceof Node && root.contains(target);
      const inList = Boolean(target?.closest?.("[data-work-list]"));
      if (!inside && !inList && target !== document.body) return;
      if (!data || preview || help) return;
      const key = event.key;
      const go = (fn: () => void) => { event.preventDefault(); fn(); };
      if (key === "?") return go(() => setHelp(true));
      if (key === "Escape" && !inside) return go(props.onClose);
      if (key === "[") return go(() => step(-1));
      if (key === "]") return go(() => step(1));
      if (key.toLowerCase() === "o" && data.url) return go(() => openLink(data.url!));
      if (data.view === "mail") {
        if (key === "r" && offered.has("reply")) return go(() => setMode({ action: "reply" }));
        if (key === "R" && offered.has("reply_all")) return go(() => setMode({ action: "reply_all" }));
        if (key.toLowerCase() === "f" && offered.has("forward")) return go(() => setMode({ action: "forward" }));
      }
      if (key.toLowerCase() === "c" || (key === "r" && data.view !== "mail")) {
        const first = ["comment", "reply", "note", "post"].find((id) => offered.has(id));
        if (first) return go(() => setMode({ action: first }));
      }
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("keydown", capture, true); window.removeEventListener("keydown", keys); };
  }, [data, help, mode, offered, openLink, preview, props.onClose, step]);

  // New mail / new meeting tabs.
  if (tab.compose) {
    const connected = (connectors.data ?? []).filter((c) => (c.id === "google" || c.id === "microsoft") && (c.status === "connected" || c.status === "syncing")).map((c) => c.id as Calendar);
    return (
      <ViewerContext.Provider value={viewer}>
        <div ref={rootRef} className="@container/viewer relative h-full overflow-y-auto bg-background" data-testid="work-record-panel" data-compose={tab.compose.kind}>
          {connectors.isLoading ? <RecordSkeleton /> : tab.compose.kind === "meeting" ? (
            <NewMeeting formKey={tab.id} compose={tab.compose} calendars={connected} onError={(error) => failed(error, tab.compose?.connector ?? "google")} />
          ) : (
            <NewMail formKey={tab.id} compose={tab.compose} mailboxes={connected} onSend={({ connector, to, cc, bcc, subject, editor, draft }) => {
              if (!client) return;
              const content = editor.content();
              const body = { kind: "mail" as const, connector, to, cc, bcc, subject, body: content.text, ...(content.html ? { html: content.html } : {}), ...(draft ? { draft: true } : {}), client_action_id: clientActionId() };
              const run = async () => {
                try {
                  await client.composeWork(body);
                  useRecordDrafts.getState().clear(draftKey(tab.id, "compose"));
                  toast.success(draft ? t("work.viewer.draft_saved") : t("work.viewer.sent"));
                  usePanelTabStore.getState().closeTab(props.panelKey, tab.id);
                } catch (error) { failed(error, connector); }
              };
              if (draft || delay <= 0) { void run(); return; }
              holdSend({ sourceId: tab.id, label: t("work.viewer.label_mail", { to: to.join(", ") }), delayMs: delay * 1000, run: () => void run(), onUndo: () => toast.success(t("work.viewer.send_undone")) });
            }} />
          )}
        </div>
      </ViewerContext.Provider>
    );
  }

  if (!data) {
    if (record.isLoading || (record.error && isMissingRoute(record.error))) return <RecordSkeleton />;
    const error = record.error as { code?: string; status?: number } | null;
    const code = error?.code ?? "";
    if (code === "unknown_record") return <Failure title={t("work.viewer.gone_title")} body={t("work.viewer.gone_body")} action={tab.url ? <Button variant="outline" size="sm" onClick={() => openLink(tab.url!)}><ExternalLink className="size-3.5" />{t("work.viewer.open_source", { name: connectorName(tab.source ?? "") })}</Button> : undefined} />;
    if (code === "connector_off" || code === "connector_not_allowed") return <Failure title={t("work.viewer.turned_off")} body={t("work.viewer.turned_off_body")} />;
    if (code === "reconnect_required") return <Failure title={t("work.viewer.reconnect_to_see", { name: connectorName(tab.source ?? "") })} action={<Button size="sm" onClick={() => void reconnect()}>{t("work.connectors.reconnect")}</Button>} />;
    const failure = workFailure(record.error);
    return <Failure title={t("work.viewer.load_failed")} body={failure.text} action={<Button variant="outline" size="sm" onClick={() => void record.refetch()}><RefreshCw className="size-3.5" />{t("work.common.try_again")}</Button>} />;
  }

  const label = sourceLabel(data);
  const detail = sourceDetail(data);
  const state = stateWord(data);
  const at = list.findIndex((item) => item.sourceId === sourceId);
  const people = data.view === "mail" ? [...new Set((data.people ?? []).map(personName).filter(Boolean))] : [];
  const meetingPeople = (data.view === "mail" ? data.people ?? [] : data.event?.attendees ?? []).filter((p) => p.email && !p.me).map((p) => p.email!.toLowerCase());
  const liveName = sourceLabel(data);

  return (
    <ViewerContext.Provider value={viewer}>
      <div ref={rootRef} tabIndex={-1} className="@container/viewer relative flex h-full min-h-0 flex-col bg-background outline-none" data-testid="work-record-panel" data-view={data.view} data-source={data.source}>
        <header className="shrink-0 border-b border-border px-4 pb-3 pt-3">
          <div className="flex items-center gap-2">
            <BrandTile id={sourceMark(data)} size="chip" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" data-testid="work-viewer-source" title={[label, detail].filter(Boolean).join(" · ")}>{[label, detail].filter(Boolean).join(" · ")}</span>
            {list.length > 1 && at >= 0 ? (
              <span className="flex items-center">
                <span className="me-1 hidden text-[12px] tabular-nums text-muted-foreground @[22rem]/viewer:inline">{t("work.viewer.position", { at: at + 1, count: list.length })}</span>
                <HeaderButton label={t("work.viewer.previous")} keys="[" onPress={() => step(-1)} disabled={at <= 0}><ChevronUp /></HeaderButton>
                <HeaderButton label={t("work.viewer.next")} keys="]" onPress={() => step(1)} disabled={at >= list.length - 1}><ChevronDown /></HeaderButton>
              </span>
            ) : null}
            <HeaderButton label={t("work.viewer.ask")} onPress={() => requestAskAbout(askPrompt(data))} testId="work-viewer-ask"><MessageSquare /></HeaderButton>
            {data.url ? <HeaderButton label={t("work.viewer.open_source", { name: label })} keys="O" onPress={() => openLink(data.url!)} testId="work-viewer-open"><ExternalLink /></HeaderButton> : null}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("work.viewer.more")} data-testid="work-viewer-menu"><MoreHorizontal /></Button>} />
              <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-56">
                {data.url ? <DropdownMenuItem onClick={() => platform.openLink(data.url!)}><ExternalLink className="size-4" />{t("work.viewer.open_default_browser")}</DropdownMenuItem> : null}
                {data.url ? <DropdownMenuItem onClick={() => { void navigator.clipboard?.writeText(data.url!); toast.success(t("work.viewer.link_copied")); }}><Link2 className="size-4" />{t("work.viewer.copy_link")}</DropdownMenuItem> : null}
                <DropdownMenuItem onClick={() => { void navigator.clipboard?.writeText(data.source_id); toast.success(t("work.viewer.copied")); }}><Copy className="size-4" />{t("work.viewer.copy_id")}</DropdownMenuItem>
                {data.can_live ? <DropdownMenuItem onClick={refresh}><RefreshCw className="size-4" />{t("work.viewer.refresh", { name: liveName })}</DropdownMenuItem> : null}
                {(data.view === "mail" || data.view === "event") && meetingPeople.length ? (
                  <DropdownMenuItem onClick={() => openRecordTab(props.panelKey, { sourceId: "", compose: { kind: "meeting", attendees: meetingPeople, title: data.subject ?? undefined } })}><Video className="size-4" />{t("work.viewer.meet_with_them")}</DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setHelp(true)}><Keyboard className="size-4" />{t("work.viewer.shortcuts")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <h2 className="mt-2 line-clamp-2 break-words text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground" data-testid="work-viewer-title">{data.subject?.trim() || detail || label}</h2>
          {state || people.length ? (
            <div className="mt-1.5 flex min-w-0 items-center gap-2">
              {state ? <Pill state tone={statusTone(state)}>{state}</Pill> : null}
              {people.length ? <p className="min-w-0 truncate text-[12px] text-muted-foreground" title={people.join(", ")}>{people.join(", ")}</p> : null}
            </div>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="work-viewer-body">
          {data.live_error === "reconnect_required" ? (
            <Banner tone="amber" testId="work-viewer-reconnect" action={<button type="button" onClick={() => void reconnect()} className="shrink-0 font-medium underline-offset-2 hover:underline">{t("work.connectors.reconnect")}</button>}>{t("work.viewer.reconnect_latest", { name: liveName })}</Banner>
          ) : data.live_error === "deleted_at_source" ? (
            <Banner tone="red" testId="work-viewer-deleted">{t("work.viewer.deleted_at_source")}</Banner>
          ) : data.live_error && data.live_error !== "not_supported" ? (
            <Banner testId="work-viewer-saved-copy">{t("work.viewer.saved_copy", { name: liveName })}</Banner>
          ) : null}
          <RecordView record={data} onPreview={(file, from) => setPreview({ file, sourceId: from })} onReplyTo={(message) => setMode({ action: "reply", message: message.source_id })} />
          {data.links?.length ? <div className="px-4 pb-5"><RelatedList links={data.links} /></div> : null}
        </div>
        <footer className="max-h-[62%] shrink-0 overflow-y-auto border-t border-border bg-background px-4 py-3 empty:hidden" data-testid="work-viewer-footer">
          <ActionArea record={data} mode={mode} setMode={setMode} send={send} onSubmit={submit} onOpenSettings={openSettings} onOpenLink={openLink} onReconnect={() => void reconnect()} />
        </footer>
        {preview ? <AttachmentPreview file={preview.file} sourceId={preview.sourceId} onClose={() => setPreview(null)} /> : null}
        {help ? <ShortcutsSheet view={data.view} onClose={() => setHelp(false)} /> : null}
      </div>
    </ViewerContext.Provider>
  );
}

function actionLabelFor(action: string): string {
  return action === "task" ? t("work.viewer.label_task") : action === "stage" ? t("work.viewer.label_stage") : t("work.viewer.label_action");
}
