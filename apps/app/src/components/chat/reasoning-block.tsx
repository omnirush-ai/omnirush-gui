"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { MessageContent } from "@/components/ui/message"
import { cn } from "@/lib/utils"

type ReasoningBlockProps = {
  text: string
  isStreaming: boolean
  className?: string
}

const HEADING_LINE = /^\*\*(.+?)\*\*\s*(?:<!--\s*-->)?$/

/**
 * A reasoning summary split into its bold status headings (whole lines like
 * "**Planning the fix**") and its prose. The ChatGPT/Codex backend sends
 * heading-only summaries for its models (openai/codex#34873), sometimes with
 * an empty `<!-- -->` placeholder after the heading, so `body` is often "".
 */
export function reasoningSummaryParts(text: string): { headings: string[]; body: string } {
  const headings: string[] = []
  const body: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    const heading = HEADING_LINE.exec(trimmed)
    if (heading) headings.push(heading[1]!.trim())
    else if (trimmed !== "<!-- -->") body.push(line)
  }
  return { headings, body: body.join("\n").trim() }
}

/** Whether a reasoning part renders anything: prose, or a heading while it streams. */
export function reasoningIsShown(text: string, isStreaming: boolean): boolean {
  return isStreaming || reasoningSummaryParts(text).body !== ""
}

/**
 * Reasoning with prose is collapsed by default: a single "Reasoning trace"
 * line with a chevron; the full reasoning renders as markdown only when the
 * user opens it. Heading-only reasoning works like Codex's status row: while
 * the model thinks, its latest heading is a live "Thinking · …" line, and
 * once it is done nothing is left to open, so it renders nothing.
 */
export function ReasoningBlock({ text, isStreaming, className }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false)
  const { headings, body } = reasoningSummaryParts(text)

  if (!body) {
    if (!isStreaming) return null
    const latest = headings.at(-1)
    return (
      <div role="status" data-reasoning-status="" className={cn("w-full text-sm text-muted-foreground", className)}>
        <span className="animate-pulse">{latest ? `Thinking · ${latest}` : "Thinking…"}</span>
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("w-full", className)} data-reasoning-block="">
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(isStreaming && "animate-pulse")}>
          {isStreaming ? "Reasoning trace…" : "Reasoning trace"}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 text-muted-foreground/70 transition-transform duration-150 group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <MessageContent
          markdown
          isStreaming={isStreaming}
          className="text-muted-foreground prose mt-1 w-full min-w-0 rounded-lg bg-transparent p-0 text-sm"
        >
          {text}
        </MessageContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
