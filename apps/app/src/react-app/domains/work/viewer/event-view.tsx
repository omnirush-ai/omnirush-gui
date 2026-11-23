/** @jsxImportSource react */
// Calendar events (Google, Outlook, CalDAV, Calendly; design 2.5): the time, Join for Meet, Teams, Zoom or a link,
// the organizer and guests with their answers, the description. A guest answers (Yes, Maybe, No); the organizer can
// reschedule (keeping or adding the Meet) or cancel with the guests told.
import { CalendarClock, Check, CircleHelp, Copy, MapPin, Video, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { Avatar, PersonName, PlainText, SectionTitle, useViewer } from "./parts";
import {
  actionArgs, eventWhen, zoneName,
  type RecordAction, type RecordAnswer, type RecordAttendee, type RecordEvent, type SendFn, type WorkRecord,
} from "./records";

const JOIN_LABEL: Record<string, string> = { meet: "work.viewer.join_meet", teams: "work.viewer.join_teams", zoom: "work.viewer.join_zoom", webex: "work.viewer.join_webex" };

function AnswerMark(props: { answer: RecordAttendee["response"] }) {
  const answer = props.answer ?? "none";
  if (answer === "yes") return <Check className="size-3.5 text-green-11" aria-label={t("work.viewer.answer_yes")} />;
  if (answer === "no") return <X className="size-3.5 text-red-11" aria-label={t("work.viewer.answer_no")} />;
  if (answer === "maybe") return <CircleHelp className="size-3.5 text-amber-11" aria-label={t("work.viewer.answer_maybe")} />;
  return <span className="size-3.5 text-center text-[11px] leading-[14px] text-muted-foreground" aria-label={t("work.viewer.answer_none")}>·</span>;
}

/** "4 guests: 2 yes, 1 maybe, 1 no reply" */
export function guestSummary(event: RecordEvent): string {
  const people = event.attendees ?? [];
  if (!people.length) return "";
  const counts = event.counts ?? {};
  const parts = [
    counts.yes ? t("work.viewer.count_yes", { count: counts.yes }) : "",
    counts.maybe ? t("work.viewer.count_maybe", { count: counts.maybe }) : "",
    counts.no ? t("work.viewer.count_no", { count: counts.no }) : "",
    counts.none ? t("work.viewer.count_none", { count: counts.none }) : "",
  ].filter(Boolean);
  return t("work.viewer.guests_summary", { count: people.length, parts: parts.join(", ") });
}

/** Local date and time inputs as an ISO instant. */
export function localInstant(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const at = new Date(`${date}T${time}:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
const pad = (n: number) => String(n).padStart(2, "0");
export function dateInput(value: string | null | undefined): string {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` : "";
}
export function timeInput(value: string | null | undefined): string {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : "";
}

function Reschedule(props: { record: WorkRecord; event: RecordEvent; send: SendFn; onDone: () => void }) {
  const microsoft = props.record.source === "microsoft";
  const [date, setDate] = useState(dateInput(props.event.start));
  const [start, setStart] = useState(timeInput(props.event.start));
  const [end, setEnd] = useState(timeInput(props.event.end));
  const [video, setVideo] = useState<string>(props.event.join?.provider === (microsoft ? "teams" : "meet") ? (microsoft ? "teams" : "meet") : "");
  const [busy, setBusy] = useState(false);
  const from = localInstant(date, start);
  const to = localInstant(date, end);
  const valid = Boolean(from && to && new Date(to) > new Date(from));
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await props.send({
      action: "reschedule",
      args: actionArgs({ action: "reschedule", source: props.record.source, start: from!, end: to!, timezone: zoneName(), video: video || undefined }),
      label: t("work.viewer.rescheduling"),
      done: t("work.viewer.rescheduled"),
    });
    setBusy(false);
    if (ok) props.onDone();
  };
  return (
    <form className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-3" onSubmit={(event) => { event.preventDefault(); void save(); }} data-testid="work-event-reschedule">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">{t("work.viewer.date")}<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 w-[150px] text-[13px]" required /></label>
        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">{t("work.viewer.starts")}<Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 w-[108px] text-[13px]" required /></label>
        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">{t("work.viewer.ends")}<Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 w-[108px] text-[13px]" required /></label>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-foreground">
        <input type="checkbox" checked={Boolean(video)} onChange={(e) => setVideo(e.target.checked ? (microsoft ? "teams" : "meet") : "")} className="size-4 accent-[var(--primary)]" />
        {microsoft ? t("work.viewer.add_teams") : t("work.viewer.add_meet")}
      </label>
      {!valid && date && start && end ? <p className="text-[12px] text-red-11">{t("work.viewer.end_after_start")}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onDone}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>{t("work.viewer.save_time")}</Button>
      </div>
    </form>
  );
}

/** The event's controls: answer, reschedule, cancel (each only where the server offers it). */
export function EventActions(props: { record: WorkRecord; actions: RecordAction[]; send: SendFn; disabled?: string | null }) {
  const event = props.record.event ?? {};
  const rsvp = props.actions.find((a) => a.id === "rsvp");
  const reschedule = props.actions.find((a) => a.id === "reschedule");
  const cancel = props.actions.find((a) => a.id === "cancel");
  const [answer, setAnswer] = useState<string | null>(event.my_response ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!rsvp && !reschedule && !cancel) return null;
  const respond = async (response: RecordAnswer) => {
    if (busy) return;
    setBusy(response);
    const before = answer;
    setAnswer(response);
    const ok = await props.send({
      action: "rsvp",
      args: actionArgs({ action: "rsvp", source: props.record.source, response }),
      label: t("work.viewer.answering"),
      done: t(`work.viewer.answered_${response}`),
    });
    if (!ok) setAnswer(before);
    setBusy(null);
  };
  const blocked = Boolean(props.disabled);
  return (
    <div className="flex flex-col gap-3" data-testid="work-event-actions">
      {rsvp ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">{t("work.viewer.going")}</span>
          <div role="radiogroup" aria-label={t("work.viewer.going")} className="flex items-center gap-1 rounded-xl bg-muted p-0.5">
            {(["yes", "maybe", "no"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={answer === value}
                disabled={blocked || Boolean(rsvp.disabled) || busy !== null}
                onClick={() => void respond(value)}
                className={cn(
                  "h-7 rounded-[10px] px-3 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  answer === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
                data-rsvp={value}
              >
                {t(`work.viewer.answer_${value}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {reschedule || cancel ? (
        moving ? <Reschedule record={props.record} event={event} send={props.send} onDone={() => setMoving(false)} /> : (
          <div className="flex flex-wrap items-center gap-2">
            {reschedule ? <Button variant="outline" size="sm" disabled={blocked || Boolean(reschedule.disabled)} onClick={() => setMoving(true)} data-testid="work-event-reschedule-open"><CalendarClock className="size-3.5" />{t("work.viewer.reschedule")}</Button> : null}
            {cancel ? <Button variant="destructive" size="sm" disabled={blocked || Boolean(cancel.disabled)} onClick={() => setConfirm(true)}>{t("work.viewer.cancel_event")}</Button> : null}
          </div>
        )
      ) : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className="max-w-[380px] gap-0 rounded-[15px] border border-border p-6 ring-0 sm:max-w-[380px]">
          <AlertDialogTitle className="mb-2 text-[17px] leading-tight tracking-tight">{t("work.viewer.cancel_title")}</AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-5">{t("work.viewer.cancel_body")}</AlertDialogDescription>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel variant="ghost" size="sm">{t("work.viewer.keep_event")}</AlertDialogCancel>
            <AlertDialogAction size="sm" variant="destructive" onClick={() => {
              setConfirm(false);
              void props.send({ action: "cancel", args: actionArgs({ action: "cancel", source: props.record.source, notify: true }), label: t("work.viewer.cancelling"), done: t("work.viewer.cancelled") });
            }}>{t("work.viewer.cancel_event")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function EventView(props: { record: WorkRecord }) {
  const event = props.record.event ?? {};
  const viewer = useViewer();
  const people = event.attendees ?? [];
  const summary = guestSummary(event);
  const join = event.join;
  const starts = event.start ? new Date(event.start).getTime() : NaN;
  const soon = Number.isFinite(starts) && starts - Date.now() < 15 * 60_000 && (event.end ? new Date(event.end).getTime() : starts) > Date.now();
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-event-view">
      <div className="flex flex-col gap-1.5">
        <p className="text-[15px] font-medium leading-5 text-foreground" data-testid="work-event-when">{eventWhen(event)}</p>
        <p className="text-[12px] text-muted-foreground">{event.timezone || zoneName()}{event.recurring ? ` · ${t("work.viewer.repeats")}` : ""}{event.status === "cancelled" ? ` · ${t("work.viewer.event_cancelled")}` : ""}</p>
      </div>
      {join?.url ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={soon ? "default" : "outline"} onClick={() => viewer.openLink(join.url)} data-testid="work-event-join">
            <Video className="size-3.5" />{t(JOIN_LABEL[join.provider ?? ""] ?? "work.viewer.join")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(join.url); toast.success(t("work.viewer.link_copied")); }}>
            <Copy className="size-3.5" />{t("work.viewer.copy_link")}
          </Button>
        </div>
      ) : null}
      {event.location && event.location !== join?.url ? (
        <p className="flex items-start gap-2 text-[13px] text-foreground"><MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 break-words">{event.location}</span></p>
      ) : null}
      {event.organizer && (event.organizer.name || event.organizer.email) ? (
        <p className="text-[13px] text-muted-foreground">{t("work.viewer.organizer")} <PersonName person={event.organizer} className="font-medium text-foreground" /></p>
      ) : null}
      {people.length ? (
        <section aria-label={t("work.viewer.guests")}>
          <SectionTitle>{summary || t("work.viewer.guests")}</SectionTitle>
          <ul className="flex flex-col gap-1" data-testid="work-event-guests">
            {people.map((person, index) => (
              <li key={person.email ?? person.name ?? index} className="flex items-center gap-2.5 py-0.5">
                <span className="relative"><Avatar person={person} size="sm" /><span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-background"><AnswerMark answer={person.response} /></span></span>
                <PersonName person={person} className="min-w-0 text-[13px] text-foreground" />
                {person.organizer ? <span className="text-[11px] text-muted-foreground">{t("work.viewer.organizer_tag")}</span> : null}
                {person.optional ? <span className="text-[11px] text-muted-foreground">{t("work.viewer.optional")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {event.description?.trim() ? (
        <section aria-label={t("work.viewer.description")}>
          <SectionTitle>{t("work.viewer.description")}</SectionTitle>
          <PlainText text={event.description} fold={false} />
        </section>
      ) : null}
    </div>
  );
}
