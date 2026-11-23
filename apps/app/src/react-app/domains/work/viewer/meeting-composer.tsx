/** @jsxImportSource react */
// New meeting and new mail, opened in the panel like a record (design 2.5, judge M10): a Google meeting gets a Meet link
// made with it (or Teams for Microsoft), and the answer shows the link to join and share. New mail uses the same
// recipient chips and rich editor as replies, with the same undo window.
import { Check, Copy, ExternalLink, Video } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { RichComposer, type RichComposerHandle } from "./composer";
import { localInstant, dateInput, timeInput } from "./event-view";
import { RecipientField } from "./mail-view";
import { useViewer } from "./parts";
import { clientActionId, draftKey, useRecordDrafts, zoneName, type RecordCompose, type RecordDraft } from "./records";

export type Calendar = "google" | "microsoft";

/** The next half hour from now, 30 minutes long. */
export function nextSlot(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
  return { start, end: new Date(start.getTime() + 30 * 60_000) };
}

/** POST /work/compose for a meeting. */
export function meetingBody(input: { connector: Calendar; title: string; date: string; start: string; end: string; attendees: string[]; video: boolean; description: string }) {
  const start = localInstant(input.date, input.start);
  const end = localInstant(input.date, input.end);
  if (!start || !end || new Date(end) <= new Date(start) || !input.title.trim()) return null;
  return {
    kind: "meeting" as const,
    connector: input.connector,
    title: input.title.trim(),
    start,
    end,
    timezone: zoneName(),
    attendees: input.attendees,
    video: input.video ? (input.connector === "google" ? "meet" : "teams") : "none",
    ...(input.description.trim() ? { description: input.description.trim() } : {}),
    send_invites: true,
    client_action_id: clientActionId(),
  };
}

function CalendarPick(props: { value: Calendar; options: Calendar[]; onChange: (value: Calendar) => void; label: string }) {
  if (props.options.length < 2) return null;
  return (
    <div role="radiogroup" aria-label={props.label} className="flex items-center gap-1 rounded-xl bg-muted p-0.5">
      {props.options.map((option) => (
        <button key={option} type="button" role="radio" aria-checked={props.value === option} onClick={() => props.onChange(option)} className={cn("h-7 rounded-[10px] px-3 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", props.value === option ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
          {option === "google" ? "Google" : "Microsoft 365"}
        </button>
      ))}
    </div>
  );
}

function Made(props: { title: string; result: Record<string, unknown> }) {
  const viewer = useViewer();
  const join = typeof props.result.meet_url === "string" ? props.result.meet_url : typeof props.result.join_url === "string" ? props.result.join_url : null;
  const open = typeof props.result.htmlLink === "string" ? props.result.htmlLink : typeof props.result.webLink === "string" ? props.result.webLink : null;
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-muted/20 p-4" data-testid="work-meeting-made">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-foreground"><Check className="size-4 text-green-11" aria-hidden />{t("work.viewer.meeting_made")}</p>
      <p className="text-[13px] text-muted-foreground">{props.title}</p>
      {join ? (
        <div className="flex w-full flex-col gap-2">
          <code className="block truncate rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground" data-testid="work-meeting-link">{join}</code>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => viewer.openLink(join)}><Video className="size-3.5" />{t("work.viewer.join")}</Button>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(join); toast.success(t("work.viewer.link_copied")); }}><Copy className="size-3.5" />{t("work.viewer.copy_link")}</Button>
            {open ? <Button size="sm" variant="ghost" onClick={() => viewer.openLink(open)}><ExternalLink className="size-3.5" />{t("work.viewer.open_calendar")}</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type MeetingForm = { connector: Calendar; title: string; date: string; start: string; end: string; guests: string[]; video: boolean; description: string; made: Record<string, unknown> | null };
/** A form being filled in survives the panel moving (a narrow window shows the panel as its own pane). */
const meetingForms = new Map<string, MeetingForm>();

function useKept<K extends keyof MeetingForm>(form: MeetingForm, key: K): [MeetingForm[K], (value: MeetingForm[K]) => void] {
  const [value, setValue] = useState<MeetingForm[K]>(form[key]);
  return [value, (next) => { form[key] = next; setValue(next); }];
}

export function NewMeeting(props: { formKey: string; compose: RecordCompose; calendars: Calendar[]; onError: (error: unknown) => void }) {
  const viewer = useViewer();
  const form = meetingForms.get(props.formKey) ?? (() => {
    const slot = nextSlot();
    const fresh: MeetingForm = {
      connector: props.compose.connector ?? props.calendars[0] ?? "google", title: props.compose.title ?? "",
      date: dateInput(slot.start.toISOString()), start: timeInput(slot.start.toISOString()), end: timeInput(slot.end.toISOString()),
      guests: props.compose.attendees ?? [], video: true, description: "", made: null,
    };
    meetingForms.set(props.formKey, fresh);
    return fresh;
  })();
  const [connector, setConnector] = useKept(form, "connector");
  const [title, setTitle] = useKept(form, "title");
  const [date, setDate] = useKept(form, "date");
  const [start, setStart] = useKept(form, "start");
  const [end, setEnd] = useKept(form, "end");
  const [guests, setGuests] = useKept(form, "guests");
  const [video, setVideo] = useKept(form, "video");
  const [description, setDescription] = useKept(form, "description");
  const [made, setMade] = useKept(form, "made");
  const [busy, setBusy] = useState(false);
  const body = meetingBody({ connector, title, date, start, end, attendees: guests, video, description });
  const submit = async () => {
    if (!body || busy || !viewer.client) return;
    setBusy(true);
    try {
      const answer = await viewer.client.composeWork(body);
      setMade((answer.result && typeof answer.result === "object" ? answer.result : {}) as Record<string, unknown>);
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(false);
    }
  };
  if (made) return <div className="p-4"><Made title={title} result={made} /></div>;
  if (!props.calendars.length) return <p className="p-4 text-[13px] text-muted-foreground">{t("work.viewer.no_calendar")}</p>;
  const label = "w-16 shrink-0 pt-1.5 text-[12px] text-muted-foreground";
  return (
    <form className="flex flex-col gap-3 p-4" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-testid="work-new-meeting">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold leading-5 text-foreground">{t("work.viewer.new_meeting")}</h2>
        <CalendarPick value={connector} options={props.calendars} onChange={setConnector} label={t("work.viewer.calendar")} />
      </div>
      <div className="flex items-start gap-2"><label className={label} htmlFor="work-meeting-title">{t("work.viewer.title")}</label><Input id="work-meeting-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("work.viewer.meeting_title_placeholder")} className="h-8 text-[13px]" maxLength={300} /></div>
      <div className="flex items-start gap-2">
        <span className={label}>{t("work.viewer.when")}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input type="date" aria-label={t("work.viewer.date")} value={date} onChange={(e) => setDate(e.target.value)} className="h-8 w-[150px] text-[13px]" />
          {/* The time range wraps as one piece, never "to" at a line end. */}
          <span className="flex items-center gap-1.5">
            <Input type="time" aria-label={t("work.viewer.starts")} value={start} onChange={(e) => setStart(e.target.value)} className="h-8 w-[104px] text-[13px]" />
            <span className="text-[12px] text-muted-foreground">{t("work.viewer.to")}</span>
            <Input type="time" aria-label={t("work.viewer.ends")} value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 w-[104px] text-[13px]" />
            <span className="text-[12px] text-muted-foreground">{zoneName()}</span>
          </span>
        </div>
      </div>
      <div className="rounded-xl border border-border"><RecipientField label={t("work.viewer.guests_short")} value={guests} onChange={setGuests} last testId="work-meeting-guests" /></div>
      <label className="flex items-center gap-2 text-[13px] text-foreground">
        <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} className="size-4 accent-[var(--primary)]" />
        {connector === "google" ? t("work.viewer.add_meet") : t("work.viewer.add_teams")}
      </label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("work.viewer.meeting_notes_placeholder")} aria-label={t("work.viewer.description")} rows={3} className="min-h-[72px] rounded-xl border border-border bg-background px-3 py-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30" />
      {!body && title && date && start && end ? <p className="text-[12px] text-red-11">{t("work.viewer.end_after_start")}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="submit" size="sm" disabled={!body || busy} data-testid="work-meeting-send">{guests.length ? t("work.viewer.send_invites") : t("work.viewer.save_meeting")}</Button>
      </div>
    </form>
  );
}

export function NewMail(props: { formKey: string; compose: RecordCompose; mailboxes: Calendar[]; onSend: (input: { connector: Calendar; to: string[]; cc: string[]; bcc: string[]; subject: string; editor: RichComposerHandle; draft?: boolean }) => void }) {
  // Kept on this computer like a reply's draft, so it survives the panel moving and an Undo.
  const key = draftKey(props.formKey, "compose");
  const kept = useRecordDrafts.getState().drafts[key];
  const save = (next: Partial<RecordDraft>) => useRecordDrafts.getState().save(key, { ...(useRecordDrafts.getState().drafts[key] ?? { action: "compose" }), ...next, action: "compose" });
  const [connector, setConnector] = useState<Calendar>(props.compose.connector ?? props.mailboxes[0] ?? "google");
  const [to, setToState] = useState<string[]>(kept?.to ?? props.compose.to ?? []);
  const [cc, setCcState] = useState<string[]>(kept?.cc ?? []);
  const [bcc, setBccState] = useState<string[]>(kept?.bcc ?? []);
  const [more, setMore] = useState(Boolean(kept?.cc?.length || kept?.bcc?.length));
  const [subject, setSubjectState] = useState(kept?.subject ?? props.compose.subject ?? "");
  const setTo = (v: string[]) => { setToState(v); save({ to: v }); };
  const setCc = (v: string[]) => { setCcState(v); save({ cc: v }); };
  const setBcc = (v: string[]) => { setBccState(v); save({ bcc: v }); };
  const setSubject = (v: string) => { setSubjectState(v); save({ subject: v }); };
  const editor = useRef<RichComposerHandle>(null);
  const [empty, setEmpty] = useState(!kept?.text?.trim());
  const ready = to.length > 0 && !empty;
  const send = (draft = false) => { if (editor.current && (ready || draft)) props.onSend({ connector, to, cc, bcc, subject, editor: editor.current, draft }); };
  if (!props.mailboxes.length) return <p className="p-4 text-[13px] text-muted-foreground">{t("work.viewer.no_mailbox")}</p>;
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="work-new-mail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold leading-5 text-foreground">{t("work.viewer.new_mail")}</h2>
        <CalendarPick value={connector} options={props.mailboxes} onChange={setConnector} label={t("work.viewer.send_from")} />
      </div>
      <div className="rounded-xl border border-border">
        <div className="relative">
          <RecipientField label={t("work.viewer.field_to")} value={to} onChange={setTo} autoFocus testId="work-new-mail-to" />
          {!more ? <button type="button" onClick={() => setMore(true)} className="absolute right-2 top-2 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline">{t("work.viewer.cc_bcc")}</button> : null}
        </div>
        {more ? <RecipientField label={t("work.viewer.field_cc")} value={cc} onChange={setCc} /> : null}
        {more ? <RecipientField label={t("work.viewer.field_bcc")} value={bcc} onChange={setBcc} /> : null}
        <div className="flex items-center gap-2 px-3">
          <label htmlFor="work-new-mail-subject" className="w-14 shrink-0 text-[12px] text-muted-foreground">{t("work.viewer.subject")}</label>
          <input id="work-new-mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" maxLength={900} />
        </div>
      </div>
      <RichComposer
        ref={editor}
        ariaLabel={t("work.viewer.message")}
        placeholder={t("work.viewer.write_message")}
        initial={{ editor: kept?.editor, text: kept?.text }}
        onChange={(state) => { setEmpty(!state.text.trim()); save({ editor: state.editor, text: state.text }); }}
        onSubmit={() => send()}
        footer={(
          <>
            <span className="flex-1" />
            <Button type="button" size="sm" variant="ghost" disabled={empty} onClick={() => send(true)}>{t("work.viewer.save_draft")}</Button>
            <Button type="button" size="sm" disabled={!ready} onClick={() => send()} data-testid="work-new-mail-send">{t("work.viewer.send")}<kbd className="ms-1 hidden text-[11px] opacity-70 @[22rem]/viewer:inline">{/Mac/i.test(navigator.platform) ? "⌘↵" : "Ctrl+↵"}</kbd></Button>
          </>
        )}
      />
    </div>
  );
}
