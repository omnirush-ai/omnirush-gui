/** @jsxImportSource react */
// Chat (Slack, Teams, Discord, WhatsApp, iMessage, Telegram; design 2.5): messages grouped by day and by author, the
// one the item was opened at marked and scrolled to, Markdown where the source writes it.
import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { AttachmentChips, Avatar, PersonName, PlainText, RecordMarkdown } from "./parts";
import { dayLabel, type ChatMessage, type RecordFile, type WorkRecord } from "./records";

/** A run of messages by one person within a few minutes shows their name once. */
const RUN_MS = 5 * 60_000;

export type ChatGroup = { day: string; runs: { from: ChatMessage["from"]; at: string | null; messages: ChatMessage[] }[] };

export function groupChat(messages: ChatMessage[], now = new Date()): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const m of messages) {
    const day = dayLabel(m.at, now) || t("work.viewer.earlier");
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) {
      group = { day, runs: [] };
      groups.push(group);
    }
    const run = group.runs[group.runs.length - 1];
    const who = (p: ChatMessage["from"]) => (p?.id || p?.email || p?.name || "").toLowerCase();
    const near = run && m.at && run.at && Math.abs(new Date(m.at).getTime() - new Date(run.messages[run.messages.length - 1]!.at ?? run.at).getTime()) < RUN_MS;
    if (run && who(run.from) === who(m.from) && (near || (!m.at && !run.at))) run.messages.push(m);
    else group.runs.push({ from: m.from, at: m.at ?? null, messages: [m] });
  }
  return groups;
}

export function ChatView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const messages = ((props.record.thread ?? []) as ChatMessage[]).filter((m) => (m.text ?? "").trim() || m.attachments?.length);
  const groups = groupChat(messages);
  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => { focus.current?.scrollIntoView({ block: "center" }); }, [props.record.source_id]);
  if (!messages.length) return <div className="px-4 py-4"><PlainText text={props.record.body?.content ?? ""} /></div>;
  return (
    <div className="flex flex-col px-2 py-3" data-testid="work-chat-view">
      {props.record.threaded ? <p className="px-2 pb-2 text-[12px] text-muted-foreground">{t("work.viewer.thread_replies", { count: Math.max(0, messages.length - 1) })}</p> : null}
      {groups.map((group, g) => (
        <section key={`${group.day}-${g}`} aria-label={group.day}>
          <div className="sticky top-0 z-[1] flex items-center gap-3 bg-background/95 px-2 py-2 backdrop-blur-sm">
            <span className="h-px flex-1 bg-border" aria-hidden />
            <span className="text-[12px] font-medium text-muted-foreground">{group.day}</span>
            <span className="h-px flex-1 bg-border" aria-hidden />
          </div>
          {group.runs.map((run, r) => (
            <div key={r} className="flex gap-2.5 px-2 py-1.5">
              <Avatar person={run.from} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <PersonName person={run.from} className="text-[13px] font-semibold text-foreground" />
                  <span className="text-[12px] tabular-nums text-muted-foreground">{run.at ? new Date(run.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                </div>
                {run.messages.map((m, i) => {
                  const mine = m.source_id === props.record.source_id;
                  return (
                    <div
                      key={m.source_id ?? i}
                      ref={mine ? focus : undefined}
                      data-chat-message={m.source_id}
                      data-opened={mine ? "true" : undefined}
                      className={cn("-ms-1.5 rounded-md py-0.5 ps-1.5 pe-1", mine && "bg-amber-3/60 ring-1 ring-inset ring-amber-6/50")}
                    >
                      {m.format === "markdown" ? <RecordMarkdown text={m.text} compact /> : <PlainText text={m.text} fold={false} />}
                      {m.attachments?.length && m.source_id ? <div className="mt-1.5"><AttachmentChips sourceId={m.source_id} files={m.attachments} onPreview={props.onPreview} /></div> : null}
                      {m.reply_count ? <p className="mt-0.5 text-[12px] font-medium text-foreground">{t("work.viewer.replies", { count: m.reply_count })}</p> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
