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

/** Whether a reasoning part renders anything: only reasoning with prose does. */
export function reasoningIsShown(text: string): boolean {
  return reasoningSummaryParts(text).body !== ""
}

/** The latest reasoning heading of the run since the last user message, for the live "Working" row. */
export function latestReasoningHeading(messages: readonly { role: string; parts: readonly { type: string; text?: string }[] }[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === "user") return null
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]!
      if (part.type !== "reasoning" || typeof part.text !== "string") continue
      const heading = reasoningSummaryParts(part.text).headings.at(-1)
      if (heading) return heading
    }
  }
  return null
}

/**
 * Reasoning with prose is collapsed by default: a single "Reasoning trace"
 * line with a chevron; the full reasoning renders as markdown only when the
 * user opens it. Heading-only reasoning renders nothing here: as in Codex's
 * status row, its latest heading rides on the live "Working" row instead
 * (latestReasoningHeading), and a finished one has nothing to open.
 */
export function ReasoningBlock({ text, isStreaming, className }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false)

  if (!reasoningIsShown(text)) return null

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
