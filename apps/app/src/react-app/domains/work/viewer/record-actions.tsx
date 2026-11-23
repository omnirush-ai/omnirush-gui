/** @jsxImportSource react */
// What can be done on a record, at the foot of the viewer (design 2.5): Reply, Reply all and Forward for mail; a reply
// box for chat; a comment, reply or internal note for issues, docs and tickets; a note, task or stage for CRM; answer,
// reschedule or cancel for events. Only what the server offers; a disabled one says why (and links the fix, a GitHub
// install). Drafts are kept on this computer until sent.
import { CornerUpLeft, CornerUpRight, Forward, Info, MessageSquare, PauseCircle, ReplyAll } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { RichComposer, type RichComposerHandle } from "./composer";
import { EventActions } from "./event-view";
import { ForwardFiles, RecipientField, mailMessages } from "./mail-view";
import {
  actionLabel, defaultRecipients, disabledReason, draftKey, isMac, useRecordDrafts,
  type ComposerContent, type MailFields, type MailMessage, type RecordAction, type SendFn, type WorkRecord,
} from "./records";

export type ComposerMode = { action: string; message?: string } | null;
export type SubmitPayload = { content: ComposerContent; mail?: MailFields; subject?: string; due?: string; stage?: string };

const SEND_KEYS = () => (isMac() ? "⌘↵" : "Ctrl+↵");
const MESSAGE_ACTIONS = new Set(["reply", "reply_all", "forward", "post", "comment", "note"]);
export const holdsSend = (action: string) => MESSAGE_ACTIONS.has(action);

/** HubSpot's default pipeline stages (a deal can sit in another pipeline: then its stage id is typed in). */
export const HUBSPOT_STAGES = [
  ["appointmentscheduled", "Appointment scheduled"],
  ["qualifiedtobuy", "Qualified to buy"],
  ["presentationscheduled", "Presentation scheduled"],
  ["decisionmakerboughtin", "Decision maker bought-in"],
  ["contractsent", "Contract sent"],
  ["closedwon", "Closed won"],
  ["closedlost", "Closed lost"],
] as const;

/** A draft saved as the composer changes (a short pause), read back when it opens again. */
function useDraft(sourceId: string, action: string) {
  const key = draftKey(sourceId, action);
  const draft = useRecordDrafts((s) => s.drafts[key]);
  const save = useRecordDrafts((s) => s.save);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initial = useRef(draft);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const put = (next: Partial<Parameters<typeof save>[1]>) => {
    if (timer.current) clearTimeout(timer.current);
    const merged = { ...(useRecordDrafts.getState().drafts[key] ?? { action }), ...next, action };
    timer.current = setTimeout(() => save(key, merged), 250);
  };
  const discard = () => { if (timer.current) clearTimeout(timer.current); useRecordDrafts.getState().clear(key); };
  return { initial: initial.current, put, discard };
}

function SendButton(props: { disabled: boolean; onClick: () => void; label?: string; testId?: string }) {
  return (
    <Button type="button" size="sm" disabled={props.disabled} onClick={props.onClick} data-testid={props.testId ?? "work-composer-send"}>
      {props.label ?? t("work.viewer.send")}
      <kbd className="ms-0.5 hidden font-sans text-[11px] opacity-60 @[24rem]/viewer:inline">{SEND_KEYS()}</kbd>
    </Button>
  );
}

/** Reply, reply all, forward (and Save draft) on a mail thread. */
function MailComposer(props: {
  record: WorkRecord; action: "reply" | "reply_all" | "forward"; messageId?: string; offered: RecordAction[];
  onSwitch: (action: string) => void; onCancel: () => void; onSubmit: (action: string, payload: SubmitPayload) => void;
}) {
  const messages = mailMessages(props.record);
  const answered: MailMessage | null = (props.messageId ? messages.find((m) => m.source_id === props.messageId) : null)
    ?? [...messages].reverse().find((m) => !m.draft) ?? null;
  const draft = useDraft(props.record.source_id, props.action);
  const start = defaultRecipients(props.action, answered);
  const [to, setTo] = useState<string[]>(draft.initial?.to ?? start.to);
  const [cc, setCc] = useState<string[]>(draft.initial?.cc ?? start.cc);
  const [bcc, setBcc] = useState<string[]>(draft.initial?.bcc ?? []);
  const [more, setMore] = useState(Boolean(draft.initial?.bcc?.length || cc.length));
  const [subject, setSubject] = useState(draft.initial?.subject ?? (props.action === "forward" ? `Fwd: ${(answered?.subject ?? props.record.subject ?? "").replace(/^(fwd?|wg):\s*/i, "")}` : ""));
  const files = answered?.attachments ?? [];
  const [picked, setPicked] = useState<number[]>(draft.initial?.attachments ?? files.filter((f) => !f.inline).map((f) => f.n));
  const editor = useRef<RichComposerHandle>(null);
  const [empty, setEmpty] = useState(!draft.initial?.text?.trim());
  const people = props.record.people ?? [];
  const canDraft = props.offered.some((a) => a.id === "draft" && !a.disabled);
  useEffect(() => {
    // Switching between reply, reply all and forward: the recipients that action starts with.
    if (draft.initial) return;
    const next = defaultRecipients(props.action, answered);
    setTo(next.to);
    setCc(next.cc);
    // Only on a switch.
  }, [props.action]);
  const mail = (): MailFields => ({
    to, cc, bcc,
    ...(props.action === "forward" ? { subject, attachments: picked } : {}),
    ...(answered && answered.source_id !== props.record.source_id ? { message: answered.source_id } : answered ? { message: answered.source_id } : {}),
  });
  const submit = (action: string) => {
    const content = editor.current?.content();
    if (!content || (!content.text.trim() && action !== "draft")) return;
    if (!to.length && action !== "draft") { toast.error(t("work.viewer.add_recipient")); return; }
    props.onSubmit(action, { content, mail: mail() });
  };
  const modes = (["reply", "reply_all", "forward"] as const).filter((id) => props.offered.some((a) => a.id === id));
  return (
    <div className="flex flex-col gap-2" data-testid="work-mail-composer" data-mode={props.action}>
      {modes.length > 1 ? (
        <div role="radiogroup" aria-label={t("work.viewer.reply_mode")} className="flex items-center gap-1 self-start rounded-xl bg-muted p-0.5">
          {modes.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={props.action === id} onClick={() => props.onSwitch(id)} className={cn("h-7 rounded-[10px] px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", props.action === id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
              {actionLabel({ id }, "mail")}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rounded-xl border border-border">
        <div className="relative">
          <RecipientField label={t("work.viewer.field_to")} value={to} onChange={(v) => { setTo(v); draft.put({ to: v }); }} suggestions={people} autoFocus={props.action === "forward"} testId="work-mail-to" />
          {!more ? <button type="button" onClick={() => setMore(true)} className="absolute right-2 top-2 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline">{t("work.viewer.cc_bcc")}</button> : null}
        </div>
        {more ? <RecipientField label={t("work.viewer.field_cc")} value={cc} onChange={(v) => { setCc(v); draft.put({ cc: v }); }} suggestions={people} testId="work-mail-cc" /> : null}
        {more ? <RecipientField label={t("work.viewer.field_bcc")} value={bcc} onChange={(v) => { setBcc(v); draft.put({ bcc: v }); }} suggestions={people} testId="work-mail-bcc" /> : null}
        {props.action === "forward" ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <label htmlFor="work-forward-subject" className="w-8 shrink-0 text-[12px] text-muted-foreground">{t("work.viewer.subject")}</label>
              <input id="work-forward-subject" value={subject} onChange={(e) => { setSubject(e.target.value); draft.put({ subject: e.target.value }); }} className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" maxLength={900} />
            </div>
            <ForwardFiles files={files} picked={picked} onChange={(v) => { setPicked(v); draft.put({ attachments: v }); }} />
          </>
        ) : null}
        <RichComposer
          ref={editor}
          ariaLabel={actionLabel({ id: props.action }, "mail")}
          placeholder={props.action === "forward" ? t("work.viewer.forward_placeholder") : t("work.viewer.reply_placeholder", { name: answered?.from.name || answered?.from.email || "" })}
          initial={{ editor: draft.initial?.editor, text: draft.initial?.text }}
          autoFocus={props.action !== "forward"}
          onChange={(state) => { setEmpty(!state.text.trim()); draft.put({ editor: state.editor, text: state.text }); }}
          onSubmit={() => submit(props.action)}
          onEscape={() => { props.onCancel(); return true; }}
          className="rounded-none rounded-b-xl border-0 focus-within:ring-0"
          testId="work-mail-editor"
          footer={(
            <>
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { draft.discard(); props.onCancel(); }}>{t("work.viewer.discard")}</Button>
              <span className="flex-1" />
              {canDraft ? <Button type="button" variant="ghost" size="sm" disabled={empty} onClick={() => submit("draft")}>{t("work.viewer.save_draft")}</Button> : null}
              <SendButton disabled={empty || !to.length} onClick={() => submit(props.action)} />
            </>
          )}
        />
      </div>
    </div>
  );
}

/** A comment, reply, internal note or chat message: the rich editor and Send (the provider's format is picked on send). */
function TextComposer(props: {
  record: WorkRecord; action: string; choices: RecordAction[]; compact?: boolean; autoFocus?: boolean; placeholder: string;
  onSwitch?: (action: string) => void; onCancel?: () => void; onSubmit: (action: string, payload: SubmitPayload) => void; disabled?: boolean;
}) {
  const draft = useDraft(props.record.source_id, props.action);
  const editor = useRef<RichComposerHandle>(null);
  const [empty, setEmpty] = useState(!draft.initial?.text?.trim());
  const submit = () => {
    const content = editor.current?.content();
    if (!content?.text.trim() || props.disabled) return;
    props.onSubmit(props.action, { content });
  };
  const internal = props.action === "note" || (props.action === "comment" && props.record.view === "ticket");
  return (
    <div className="flex flex-col gap-2" data-testid="work-text-composer" data-action={props.action}>
      {props.choices.length > 1 && props.onSwitch ? (
        <div role="radiogroup" aria-label={t("work.viewer.compose_kind")} className="flex items-center gap-1 self-start rounded-xl bg-muted p-0.5">
          {props.choices.map((choice) => (
            <button key={choice.id} type="button" role="radio" aria-checked={props.action === choice.id} onClick={() => props.onSwitch!(choice.id)} className={cn("h-7 rounded-[10px] px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", props.action === choice.id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
              {actionLabel(choice, props.record.view)}
            </button>
          ))}
        </div>
      ) : null}
      <RichComposer
        key={props.action}
        ref={editor}
        ariaLabel={actionLabel({ id: props.action }, props.record.view)}
        placeholder={props.placeholder}
        initial={{ editor: draft.initial?.editor, text: draft.initial?.text }}
        compact={props.compact}
        toolbar={!props.compact}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        onChange={(state) => { setEmpty(!state.text.trim()); draft.put({ editor: state.editor, text: state.text }); }}
        onSubmit={submit}
        onEscape={props.onCancel ? () => { props.onCancel!(); return true; } : undefined}
        className={cn(internal && "border-amber-6/70 bg-amber-2/60 dark:bg-amber-3/20")}
        testId={`work-composer-${props.action}`}
        footer={(
          <>
            {internal ? <span className="text-[12px] text-amber-11">{t("work.viewer.internal_hint")}</span> : null}
            <span className="flex-1" />
            {props.onCancel ? <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={props.onCancel}>{t("common.cancel")}</Button> : null}
            <SendButton disabled={empty || Boolean(props.disabled)} onClick={submit} label={props.action === "note" || internal ? t("work.viewer.add") : props.action === "comment" ? t("work.viewer.comment") : t("work.viewer.send")} />
          </>
        )}
      />
    </div>
  );
}

function TaskComposer(props: { record: WorkRecord; onCancel: () => void; onSubmit: (action: string, payload: SubmitPayload) => void }) {
  const [subject, setSubject] = useState("");
  const [due, setDue] = useState("");
  const [details, setDetails] = useState("");
  const ok = subject.trim().length > 0;
  return (
    <form className="flex flex-col gap-2 rounded-xl border border-border p-3" onSubmit={(e) => { e.preventDefault(); if (ok) props.onSubmit("task", { content: { html: "", markdown: details, text: details }, subject, due: due || undefined }); }} data-testid="work-task-composer">
      <Input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("work.viewer.task_placeholder")} aria-label={t("work.viewer.task")} className="h-8 text-[13px]" maxLength={255} />
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder={t("work.viewer.task_details")} aria-label={t("work.viewer.task_details")} rows={2} className="rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30" />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">{t("work.viewer.due")}<Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="h-8 w-[150px] text-[13px]" /></label>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={!ok}>{t("work.viewer.add_task")}</Button>
      </div>
    </form>
  );
}

function StageComposer(props: { record: WorkRecord; onCancel: () => void; onSubmit: (action: string, payload: SubmitPayload) => void }) {
  const current = (props.record.stage ?? "").toLowerCase();
  const known = HUBSPOT_STAGES.some(([id]) => id === current);
  const [stage, setStage] = useState(known ? current : "");
  const [custom, setCustom] = useState(!known && current ? current : "");
  const value = stage === "other" ? custom.trim() : stage;
  return (
    <form className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3" onSubmit={(e) => { e.preventDefault(); if (value) props.onSubmit("stage", { content: { html: "", markdown: "", text: "" }, stage: value }); }} data-testid="work-stage-composer">
      <label className="sr-only" htmlFor="work-stage">{t("work.viewer.stage")}</label>
      <select id="work-stage" value={stage} onChange={(e) => setStage(e.target.value)} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
        <option value="" disabled>{t("work.viewer.pick_stage")}</option>
        {HUBSPOT_STAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        <option value="other">{t("work.viewer.other_stage")}</option>
      </select>
      {stage === "other" ? <Input autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t("work.viewer.stage_id")} aria-label={t("work.viewer.stage_id")} className="h-8 w-[180px] text-[13px]" /> : null}
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>{t("common.cancel")}</Button>
      <Button type="submit" size="sm" disabled={!value || value === current}>{t("work.viewer.change_stage")}</Button>
    </form>
  );
}

function Notice(props: { icon?: ReactNode; children: ReactNode; action?: ReactNode; tone?: "neutral" | "amber"; testId?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] leading-5", props.tone === "amber" ? "border-amber-6/70 bg-amber-2 text-amber-12 dark:bg-amber-3/30" : "border-border bg-muted/40 text-muted-foreground")} data-testid={props.testId}>
      <span className="mt-0.5 shrink-0">{props.icon ?? <Info className="size-3.5" aria-hidden />}</span>
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.action}
    </div>
  );
}

function ActionButton(props: { action: RecordAction; view: string; keys?: string; icon?: ReactNode; primary?: boolean; source: string; onPress: () => void }) {
  const reason = disabledReason(props.action, props.source);
  const button = (
    <Button type="button" variant={props.primary ? "default" : "outline"} size="sm" disabled={Boolean(props.action.disabled)} onClick={props.onPress} data-action={props.action.id}>
      {props.icon}{actionLabel(props.action, props.view)}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
      <TooltipContent>{reason ?? (props.keys ? `${actionLabel(props.action, props.view)} (${props.keys})` : actionLabel(props.action, props.view))}</TooltipContent>
    </Tooltip>
  );
}

/** The foot of the viewer. */
export function ActionArea(props: {
  record: WorkRecord; mode: ComposerMode; setMode: (mode: ComposerMode) => void; send: SendFn;
  onSubmit: (action: string, payload: SubmitPayload) => void; onOpenSettings: () => void; onOpenLink: (url: string) => void; onReconnect: () => void;
}) {
  const record = props.record;
  const actions = useMemo(() => (record.actions ?? []).filter((a) => a.id !== "draft" || record.view === "mail"), [record.actions, record.view]);
  const paused = Boolean(record.writes_paused);
  const live = actions.filter((a) => !a.disabled);
  const blocked = actions.find((a) => a.disabled);
  const reconnect = actions.some((a) => a.disabled === "reconnect_required");
  const view = record.view;
  const by = (id: string) => actions.find((a) => a.id === id);

  const notices: ReactNode[] = [];
  if (paused && actions.length) {
    notices.push(<Notice key="paused" tone="amber" icon={<PauseCircle className="size-3.5" aria-hidden />} testId="work-viewer-paused" action={<button type="button" onClick={props.onOpenSettings} className="shrink-0 font-medium underline-offset-2 hover:underline">{t("work.viewer.open_settings")}</button>}>{t("work.viewer.writes_paused")}</Notice>);
  }
  if (blocked && !live.length) {
    const reason = disabledReason(blocked, record.source);
    notices.push(
      <Notice key="blocked" testId="work-viewer-blocked" action={blocked.setup_url ? <button type="button" onClick={() => props.onOpenLink(blocked.setup_url!)} className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline">{record.source === "github" ? t("work.viewer.install_github") : t("work.viewer.fix")}</button> : reconnect ? <button type="button" onClick={props.onReconnect} className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline">{t("work.connectors.reconnect")}</button> : undefined}>
        {reason}
      </Notice>,
    );
  }
  if (!actions.length && record.read_only) {
    const sender = (record.thread as MailMessage[] | undefined)?.[(record.thread?.length ?? 1) - 1]?.from?.email ?? null;
    notices.push(
      <Notice key="read" testId="work-viewer-read-only" action={record.source === "imap" && sender ? <button type="button" onClick={() => { void navigator.clipboard?.writeText(sender); toast.success(t("work.viewer.copied")); }} className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline">{t("work.viewer.copy_address")}</button> : undefined}>
        {record.read_only}
      </Notice>,
    );
  }
  if (!actions.length) return notices.length ? <div className="flex flex-col gap-2">{notices}</div> : null;

  const disabled = paused;
  const mode = props.mode;
  const close = () => props.setMode(null);
  let body: ReactNode = null;

  if (view === "event") {
    body = <EventActions record={record} actions={actions} send={props.send} disabled={paused ? "writes_paused" : null} />;
  } else if (view === "mail") {
    const current = mode && ["reply", "reply_all", "forward"].includes(mode.action) ? (mode.action as "reply" | "reply_all" | "forward") : null;
    body = current && !disabled ? (
      <MailComposer record={record} action={current} messageId={mode?.message} offered={actions} onSwitch={(id) => props.setMode({ action: id, message: mode?.message })} onCancel={close} onSubmit={props.onSubmit} />
    ) : (
      <div className="flex flex-wrap items-center gap-2" data-testid="work-mail-actions">
        {by("reply") ? <ActionButton action={by("reply")!} view={view} source={record.source} keys="R" primary icon={<CornerUpLeft className="size-3.5" />} onPress={() => props.setMode({ action: "reply" })} /> : null}
        {by("reply_all") ? <ActionButton action={by("reply_all")!} view={view} source={record.source} keys="⇧R" icon={<ReplyAll className="size-3.5" />} onPress={() => props.setMode({ action: "reply_all" })} /> : null}
        {by("forward") ? <ActionButton action={by("forward")!} view={view} source={record.source} keys="F" icon={<Forward className="size-3.5" />} onPress={() => props.setMode({ action: "forward" })} /> : null}
      </div>
    );
  } else if (view === "chat") {
    const reply = by("reply");
    const post = by("post");
    const choices = [reply, post].filter((a): a is RecordAction => Boolean(a && !a.disabled));
    const current = mode && choices.some((c) => c.id === mode.action) ? mode.action : choices[0]?.id;
    body = current ? (
      <TextComposer
        record={record}
        action={current}
        choices={choices}
        compact
        autoFocus={Boolean(mode)}
        disabled={disabled}
        placeholder={current === "post" ? t("work.viewer.post_placeholder", { where: record.where ?? "" }) : record.source === "slack" ? t("work.viewer.thread_placeholder") : t("work.viewer.chat_placeholder")}
        onSwitch={(id) => props.setMode({ action: id })}
        onSubmit={props.onSubmit}
      />
    ) : null;
  } else {
    const textual = actions.filter((a) => ["comment", "reply", "note"].includes(a.id));
    const other = actions.filter((a) => ["task", "stage"].includes(a.id));
    const current = mode?.action;
    if (current === "task" && !disabled) body = <TaskComposer record={record} onCancel={close} onSubmit={props.onSubmit} />;
    else if (current === "stage" && !disabled) body = <StageComposer record={record} onCancel={close} onSubmit={props.onSubmit} />;
    else if (current && textual.some((a) => a.id === current) && !disabled) {
      body = (
        <TextComposer
          record={record}
          action={current}
          choices={textual.filter((a) => !a.disabled)}
          autoFocus
          placeholder={current === "reply" ? t("work.viewer.reply_customer_placeholder") : current === "note" || view === "ticket" ? t("work.viewer.note_placeholder") : t("work.viewer.comment_placeholder")}
          onSwitch={(id) => props.setMode({ action: id })}
          onCancel={close}
          onSubmit={props.onSubmit}
        />
      );
    } else {
      const first = textual.find((a) => !a.disabled) ?? textual[0];
      body = (
        <div className="flex flex-col gap-2" data-testid="work-comment-actions">
          {first ? (
            <button
              type="button"
              disabled={Boolean(first.disabled) || disabled}
              onClick={() => props.setMode({ action: first.id })}
              className="flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-background px-3 text-start text-[13px] text-muted-foreground outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              data-testid="work-comment-open"
            >
              <MessageSquare className="size-3.5" aria-hidden />
              <span className="flex-1">{first.id === "reply" ? t("work.viewer.reply_customer_placeholder") : first.id === "note" ? t("work.viewer.note_placeholder") : t("work.viewer.comment_placeholder")}</span>
              <kbd className="rounded border border-border px-1 font-sans text-[11px]">C</kbd>
            </button>
          ) : null}
          {textual.length > 1 || other.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {textual.slice(1).map((a) => <ActionButton key={a.id} action={a} view={view} source={record.source} icon={a.id === "reply" ? <CornerUpRight className="size-3.5" /> : undefined} onPress={() => props.setMode({ action: a.id })} />)}
              {other.map((a) => <ActionButton key={a.id} action={a} view={view} source={record.source} onPress={() => props.setMode({ action: a.id })} />)}
            </div>
          ) : null}
        </div>
      );
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="work-viewer-actions">
      {notices}
      {body}
    </div>
  );
}
