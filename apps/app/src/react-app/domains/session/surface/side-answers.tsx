import { MessageCircleQuestion, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownBlock } from "./markdown";
import type { SideAnswer } from "./side-question";

/** Side answers above the composer: marked as not part of the chat, each closed on its own. */
export function SideAnswers(props: { answers: SideAnswer[]; onDismiss: (id: number) => void }) {
  if (!props.answers.length) return null;
  return (
    <div className="flex max-h-[40vh] shrink-0 flex-col-reverse gap-2 overflow-y-auto pb-2" data-side-answers>
      {/* reversed list in a column-reverse box: oldest on top, and the scroll starts at the newest card */}
      {[...props.answers].reverse().map((item) => (
        <div
          key={item.id}
          className="flex w-full items-start gap-2.5 rounded-2xl border border-dashed border-border bg-popover/95 py-2 pl-3 pr-1.5 text-popover-foreground shadow-sm"
          data-side-answer={item.status}
          role="note"
          aria-label="Side answer, not part of the chat"
        >
          <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Side answer · not part of the chat</p>
            <p className="break-words text-[13px] font-medium leading-5">{item.question}</p>
            <div className={`max-h-64 overflow-y-auto text-[13px] leading-5 ${item.status === "error" ? "text-destructive" : ""}`}>
              {item.status === "thinking" ? <p className="text-muted-foreground">Thinking…</p> : item.status === "error" ? <p>{item.answer}</p> : <MarkdownBlock text={item.answer} />}
            </div>
            {item.sources.length ? (
              <p className="flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                Sources:
                {item.sources.slice(0, 5).map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="truncate text-link underline-offset-2 hover:underline">{url.replace(/^https?:\/\//, "")}</a>
                ))}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close side answer" onClick={() => props.onDismiss(item.id)} className="shrink-0 rounded-lg text-muted-foreground">
            <XIcon className="size-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
