/** @jsxImportSource react */
// Mail (Gmail, Outlook, IMAP; design 2.5): the thread with older messages folded to one line, the latest and unread ones
// open, each HTML body in its sandboxed frame (html-frame.tsx), images held back until asked, files as chips. The mail
// composer: To, Cc and Bcc as chips with suggestions from the thread, the subject for a forward, the rich editor, and the
// original's files to forward.
import { CornerUpLeft, ImageOff } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { MailFrame } from "./html-frame";
import { AttachmentChips, Avatar, PersonName, PlainText, useLinkOpener, useViewer } from "./parts";
import {
  parseAddresses, personName, recipientsLine, shortWhen,
  type MailMessage, type RecordFile, type RecordPerson, type WorkRecord,
} from "./records";

/** Senders whose images always show (on this computer). */
type ImagePrefs = { senders: string[]; allow: (email: string) => void };
export const useImagePrefs = create<ImagePrefs>()(
  persist((set) => ({ senders: [], allow: (email) => set((state) => ({ senders: [...new Set([...state.senders, email.toLowerCase()])].slice(-500) })) }), {
    name: "omnirush.work.mail-images",
    storage: createJSONStorage(() => localStorage),
  }),
);

/** The thread's messages, oldest first (a record with no thread is one message). */
export function mailMessages(record: WorkRecord): MailMessage[] {
  const thread = (record.thread ?? []) as MailMessage[];
  if (thread.length) return thread;
  const from = (record.actors ?? []).find((a) => a.role === "from") ?? {};
  return [{
    source_id: record.source_id, from, to: [], cc: [], at: record.occurred_at ?? null, subject: record.subject ?? null,
    body: record.body ?? { format: "text", content: "" }, attachments: record.attachments ?? [],
  }];
}

/** Which messages start open: the newest, any unread, and the one the item was opened at. */
export function initiallyOpen(messages: MailMessage[], opened: string): Set<string> {
  const open = new Set<string>();
  const last = messages[messages.length - 1];
  if (last) open.add(last.source_id);
  for (const m of messages) if (m.unread || m.source_id === opened) open.add(m.source_id);
  return open;
}

function MessageHeader(props: { message: MailMessage; open: boolean; onToggle: () => void; onReply?: () => void }) {
  const m = props.message;
  const [details, setDetails] = useState(false);
  const line = recipientsLine(m.to, m.cc);
  return (
    <div className="flex items-start gap-2.5">
      <Avatar person={m.from} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button type="button" onClick={props.onToggle} className="min-w-0 truncate text-start text-[13px] font-semibold text-foreground outline-none focus-visible:underline" aria-expanded={props.open}>
            <PersonName person={m.from} />
          </button>
          {m.from.email && !m.from.me ? <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground @[26rem]/viewer:inline">{m.from.email}</span> : null}
          <span className="ms-auto shrink-0 text-[12px] tabular-nums text-muted-foreground" title={m.at ? new Date(m.at).toLocaleString() : undefined}>{shortWhen(m.at)}</span>
        </div>
        {line ? (
          <button type="button" onClick={() => setDetails(!details)} aria-expanded={details} className="block max-w-full truncate text-start text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
            {line}
          </button>
        ) : null}
        {details ? (
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-muted/50 px-2.5 py-2 text-[12px]" data-testid="work-mail-details">
            {([["from", [m.from]], ["to", m.to], ["cc", m.cc]] as const).map(([key, people]) => people.length ? (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{t(`work.viewer.field_${key}`)}</dt>
                <dd className="min-w-0 break-words text-foreground">{people.map((p) => (p.name && p.email ? `${p.name} <${p.email}>` : p.email || p.name)).join(", ")}</dd>
              </div>
            ) : null)}
            {m.at ? <><dt className="text-muted-foreground">{t("work.viewer.field_date")}</dt><dd className="text-foreground">{new Date(m.at).toLocaleString()}</dd></> : null}
          </dl>
        ) : null}
      </div>
      {props.onReply ? (
        <button type="button" onClick={props.onReply} aria-label={t("work.viewer.reply_to_this", { name: personName(m.from) })} title={t("work.viewer.reply")} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/message:opacity-100">
          <CornerUpLeft className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function ImagesBar(props: { sender: RecordPerson; onShow: () => void }) {
  const allow = useImagePrefs((s) => s.allow);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[12px] text-muted-foreground" data-testid="work-mail-images-hidden">
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      <span>{t("work.viewer.images_hidden")}</span>
      <button type="button" onClick={props.onShow} className="font-medium text-foreground outline-none hover:underline focus-visible:underline">{t("work.viewer.show_images")}</button>
      {props.sender.email ? (
        <button type="button" onClick={() => { allow(props.sender.email!); props.onShow(); }} className="font-medium text-foreground outline-none hover:underline focus-visible:underline">{t("work.viewer.always_show_images")}</button>
      ) : null}
    </div>
  );
}

function OpenMessage(props: { message: MailMessage; onToggle: () => void; onReply?: () => void; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const m = props.message;
  const viewer = useViewer();
  const open = useLinkOpener();
  const always = useImagePrefs((s) => (m.from.email ? s.senders.includes(m.from.email.toLowerCase()) : false));
  const [shown, setShown] = useState(false);
  const [remote, setRemote] = useState(0);
  const showImages = shown || always;
  return (
    <article className="group/message flex flex-col gap-3 px-4 py-4" data-mail-message={m.source_id} aria-label={t("work.viewer.message_from", { name: personName(m.from) || m.from.email || "" })}>
      <MessageHeader message={m} open onToggle={props.onToggle} onReply={props.onReply} />
      <div className="min-w-0 ps-[42px]">
        {remote > 0 && !showImages ? <ImagesBar sender={m.from} onShow={() => setShown(true)} /> : null}
        {m.body.format === "html" && m.body.content.trim() ? (
          <MailFrame
            html={m.body.content}
            sourceId={m.source_id}
            files={m.attachments}
            client={viewer.client}
            title={t("work.viewer.message_from", { name: personName(m.from) || m.from.email || "" })}
            showImages={showImages}
            onOpenLink={open}
            onRemoteImages={setRemote}
          />
        ) : m.body.content.trim() ? (
          <PlainText text={m.body.content} />
        ) : (
          <p className="text-[13px] italic text-muted-foreground">{m.snippet || t("work.viewer.no_body")}</p>
        )}
        {m.body.truncated ? <p className="mt-2 text-[12px] text-muted-foreground">{t("work.viewer.body_cut")}</p> : null}
        {m.attachments.some((f) => !f.inline) ? <div className="mt-3"><AttachmentChips sourceId={m.source_id} files={m.attachments} onPreview={props.onPreview} /></div> : null}
      </div>
    </article>
  );
}

function FoldedMessage(props: { message: MailMessage; onOpen: () => void }) {
  const m = props.message;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-start outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-mail-folded={m.source_id}
      aria-expanded={false}
    >
      <Avatar person={m.from} size="sm" />
      <span className={cn("w-28 shrink-0 truncate text-[13px] text-foreground @[30rem]/viewer:w-36", m.unread && "font-semibold")}><PersonName person={m.from} /></span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{m.snippet || m.body.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}</span>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{shortWhen(m.at)}</span>
    </button>
  );
}

export function MailView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void; onReplyTo?: (message: MailMessage) => void }) {
  const messages = useMemo(() => mailMessages(props.record), [props.record]);
  const [open, setOpen] = useState(() => initiallyOpen(messages, props.record.source_id));
  const [showAll, setShowAll] = useState(false);
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // A long thread folds its middle to one row: the first, "N more", then the last two.
  const middle = !showAll && messages.length > 4 ? messages.slice(1, -2).filter((m) => !open.has(m.source_id)) : [];
  const hidden = new Set(middle.map((m) => m.source_id));
  let foldShown = false;
  return (
    <div className="flex flex-col divide-y divide-border" data-testid="work-mail-view">
      {messages.map((m) => {
        if (hidden.has(m.source_id)) {
          if (foldShown) return null;
          foldShown = true;
          return (
            <div key={`more-${m.source_id}`} className="flex items-center justify-center py-1.5">
              <button type="button" onClick={() => setShowAll(true)} className="rounded-full border border-border bg-background px-3 py-0.5 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" data-testid="work-mail-more">
                {t("work.viewer.more_messages", { count: middle.length })}
              </button>
            </div>
          );
        }
        return open.has(m.source_id) ? (
          <OpenMessage key={m.source_id} message={m} onToggle={() => toggle(m.source_id)} onReply={props.onReplyTo ? () => props.onReplyTo!(m) : undefined} onPreview={props.onPreview} />
        ) : (
          <FoldedMessage key={m.source_id} message={m} onOpen={() => toggle(m.source_id)} />
        );
      })}
    </div>
  );
}

// ── the mail composer's fields ──────────────────────────────────────────────────────────────────────────────────────

export function RecipientField(props: { label: string; value: string[]; onChange: (value: string[]) => void; suggestions?: RecordPerson[]; autoFocus?: boolean; testId?: string }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = text.trim().toLowerCase();
  const matches = query
    ? (props.suggestions ?? []).filter((p) => p.email && !p.me && !props.value.includes(p.email.toLowerCase()) && (p.email.toLowerCase().includes(query) || (p.name ?? "").toLowerCase().includes(query))).slice(0, 5)
    : [];
  const add = (raw: string) => {
    const found = parseAddresses(raw);
    if (!found.length) return false;
    props.onChange([...new Set([...props.value, ...found])]);
    setText("");
    setActive(0);
    return true;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActive((at) => (at + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab" || event.key === ",") && text.trim()) {
      if (matches.length && !parseAddresses(text).length) {
        event.preventDefault();
        add(matches[active]!.email!);
        return;
      }
      if (add(text)) event.preventDefault();
      return;
    }
    if (event.key === "Backspace" && !text && props.value.length) {
      event.preventDefault();
      props.onChange(props.value.slice(0, -1));
    }
  };
  return (
    <div className="relative flex min-h-9 items-start gap-2 border-b border-border px-3 py-1" data-testid={props.testId}>
      <label className="mt-1.5 w-8 shrink-0 text-[12px] text-muted-foreground" onClick={() => inputRef.current?.focus()}>{props.label}</label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {props.value.map((address) => {
          const person = props.suggestions?.find((p) => p.email?.toLowerCase() === address);
          return (
            <span key={address} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-border bg-muted/60 ps-2 pe-0.5 text-[12px] text-foreground" title={address} data-recipient={address}>
              <span className="truncate">{person?.name || address}</span>
              <button type="button" aria-label={t("work.viewer.remove_recipient", { address })} onClick={() => props.onChange(props.value.filter((v) => v !== address))} className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">×</button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          autoFocus={props.autoFocus}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => { if (text.trim()) add(text); }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (parseAddresses(pasted).length > 1) { event.preventDefault(); add(pasted); }
          }}
          aria-label={props.label}
          className="h-7 min-w-[8rem] flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-autocomplete="list"
        />
      </div>
      {matches.length ? (
        <ul role="listbox" className="absolute left-12 top-full z-30 mt-1 w-[min(320px,calc(100%-3.5rem))] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-md">
          {matches.map((p, index) => (
            <li key={p.email} role="option" aria-selected={index === active}>
              <button type="button" onMouseDown={(event) => { event.preventDefault(); add(p.email!); }} className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-start text-[13px]", index === active ? "bg-muted" : "hover:bg-muted/60")}>
                <Avatar person={p} size="sm" />
                <span className="min-w-0 flex-1 truncate text-foreground">{p.name || p.email}</span>
                {p.name ? <span className="truncate text-[12px] text-muted-foreground">{p.email}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The original's files to send on with a forward (all on by default). */
export function ForwardFiles(props: { files: RecordFile[]; picked: number[]; onChange: (picked: number[]) => void }) {
  const files = props.files.filter((f) => !f.inline);
  if (!files.length) return null;
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[12px]" data-testid="work-forward-files">
      <legend className="sr-only">{t("work.viewer.forward_files")}</legend>
      <span className="text-muted-foreground">{t("work.viewer.include_files")}</span>
      {files.map((file) => (
        <label key={file.n} className="flex min-w-0 items-center gap-1.5 text-foreground">
          <Checkbox checked={props.picked.includes(file.n)} onCheckedChange={(on) => props.onChange(on ? [...props.picked, file.n] : props.picked.filter((n) => n !== file.n))} />
          <span className="max-w-[180px] truncate">{file.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
