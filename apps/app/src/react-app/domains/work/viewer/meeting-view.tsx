/** @jsxImportSource react */
// Meetings (Work meetings, Zoom; design 2.5): summary, action items, who was there, then the transcript with a speaker
// filter and find in transcript.
import { Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { Body, RecordMarkdown, SectionTitle } from "./parts";
import type { WorkRecord } from "./records";

export function stamp(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MeetingView(props: { record: WorkRecord }) {
  const meeting = props.record.meeting ?? {};
  const segments = meeting.segments ?? [];
  const speakers = useMemo(() => [...new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))], [segments]);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const query = find.trim().toLowerCase();
  const shown = segments.filter((s) => (!speaker || s.speaker === speaker) && (!query || (s.text ?? "").toLowerCase().includes(query)));
  const items = (meeting.action_items ?? []).map((item) => (typeof item === "string" ? item : typeof item === "object" && item ? String((item as Record<string, unknown>).text ?? (item as Record<string, unknown>).title ?? "") : "")).filter(Boolean);
  return (
    <div
      className="flex flex-col gap-5 px-4 py-4"
      data-testid="work-meeting-view"
      onKeyDown={(event) => {
        // Cmd/Ctrl+F in the panel: find in the transcript.
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f" && findRef.current) {
          event.preventDefault();
          findRef.current.focus();
          findRef.current.select();
        }
      }}
    >
      {meeting.summary?.trim() ? (
        <section aria-label={t("work.viewer.summary")}><SectionTitle>{t("work.viewer.summary")}</SectionTitle><RecordMarkdown text={meeting.summary} /></section>
      ) : null}
      {items.length ? (
        <section aria-label={t("work.viewer.action_items")}>
          <SectionTitle count={items.length}>{t("work.viewer.action_items")}</SectionTitle>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-[13px] text-foreground">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </section>
      ) : null}
      {meeting.participants?.length ? <p className="text-[13px] text-muted-foreground">{meeting.participants.map((p) => p.name || p.email).filter(Boolean).join(", ")}</p> : null}
      {segments.length ? (
        <section aria-label={t("work.viewer.transcript")}>
          <SectionTitle count={segments.length}>{t("work.viewer.transcript")}</SectionTitle>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <label className="flex h-8 min-w-[160px] flex-1 items-center gap-1.5 rounded-lg border border-border px-2 focus-within:ring-2 focus-within:ring-ring/30">
              <Search className="size-3.5 text-muted-foreground" aria-hidden />
              <input ref={findRef} value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("work.viewer.find_transcript")} aria-label={t("work.viewer.find_transcript")} className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" data-transcript-find />
            </label>
            {speakers.length > 1 ? (
              <div role="radiogroup" aria-label={t("work.viewer.speaker")} className="flex flex-wrap gap-1">
                {[null, ...speakers].map((name) => (
                  <button key={name ?? "all"} type="button" role="radio" aria-checked={speaker === name} onClick={() => setSpeaker(name)} className={cn("h-7 rounded-full border px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring", speaker === name ? "border-foreground/20 bg-muted font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                    {name ?? t("work.viewer.everyone")}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <ol className="flex flex-col gap-2">
            {shown.map((segment, index) => (
              <li key={index} className="grid grid-cols-[64px_1fr] gap-2 text-[13px] leading-5">
                <span className="font-mono text-[11px] leading-5 text-muted-foreground">{stamp(segment.start_ms)}</span>
                <p className="min-w-0 text-foreground">{segment.speaker ? <span className="font-semibold">{segment.speaker}: </span> : null}{segment.text}</p>
              </li>
            ))}
            {!shown.length ? <li className="text-[13px] text-muted-foreground">{t("work.viewer.nothing_found")}</li> : null}
          </ol>
        </section>
      ) : <Body body={props.record.body} />}
    </div>
  );
}
