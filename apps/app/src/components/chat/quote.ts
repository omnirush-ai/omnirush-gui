// Quote / reply: a message (or the text selected in it) goes into the chat's
// composer as a removable quote chip, sent with the prompt as a Markdown quote.
import { sendToChat, type ChatHandoffResult } from "@/react-app/domains/session/editor/chat-context"

const LABEL_WORDS = 48

/** The text as a Markdown quote block (`> ` on every line; blank lines kept as `>`). */
export function quoteText(text: string): string {
  return text
    .replace(/\s+$/, "")
    .replace(/^\s*\n/, "")
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n")
}

/** A sent prompt part that is a quote block: its text without the `>` markers, else null. */
export function unquoteBlock(text: string): string | null {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/)
  if (!lines.length || !lines.every((line) => line.startsWith(">"))) return null
  return lines.map((line) => line.replace(/^> ?/, "")).join("\n")
}

/** At most `max` user-perceived characters (an emoji or accented letter is never cut in half). */
export function clipGraphemes(text: string, max: number): string {
  const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
    : Array.from(text)
  return graphemes.length > max ? `${graphemes.slice(0, max).join("").trimEnd()}…` : text
}

/** The chip label: `Quote: first words…` (sendToChat makes it unique among the draft's chips). */
export function quoteLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return `Quote: ${clipGraphemes(flat, LABEL_WORDS)}`
}

export function quoteIntoComposer(sessionId: string | null, text: string): ChatHandoffResult {
  if (!text.trim()) return { ok: false, reason: "Nothing to quote." }
  return sendToChat(sessionId, "", [{ label: quoteLabel(text), text: quoteText(text) }])
}
