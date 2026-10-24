import * as React from "react"
import { createPortal } from "react-dom"
import { TextQuote } from "lucide-react"

import { Button } from "@/components/ui/button"
import { t } from "@/i18n"

import { quoteIntoComposer } from "./quote"

/** The message element a node sits in (`[data-message-id]`) inside `container`, else null. */
function messageOf(node: Node | null, container: HTMLElement): Element | null {
  const element = node instanceof Element ? node : node?.parentElement
  const message = element?.closest("[data-message-id]") ?? null
  return message && container.contains(message) ? message : null
}

/**
 * The text selected in this chat's transcript now, with the messages it starts and ends in; null when nothing is
 * selected there (a selection elsewhere, in another chat's transcript, or collapsed).
 */
export function transcriptSelection(selection: Selection | null, container: HTMLElement | null): { text: string; from: string; to: string; range: Range } | null {
  const text = selection?.toString() ?? ""
  if (!selection || selection.isCollapsed || !text.trim() || !container || !container.isConnected || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = messageOf(range.startContainer, container)
  const end = messageOf(range.endContainer, container)
  if (!start || !end) return null
  return { text, from: start.getAttribute("data-message-id") ?? "", to: end.getAttribute("data-message-id") ?? "", range }
}

/** The text selected inside one message element (both ends in it), else null: the context menu's quote. */
export function selectionInMessage(selection: Selection | null, messageId: string, container: ParentNode = document): string | null {
  const text = selection?.toString() ?? ""
  if (!selection || selection.isCollapsed || !text.trim() || selection.rangeCount === 0) return null
  const element = Array.from(container.querySelectorAll("[data-message-id]")).find((node) => node.getAttribute("data-message-id") === messageId)
  if (!element) return null
  const range = selection.getRangeAt(0)
  return element.contains(range.startContainer) && element.contains(range.endContainer) ? text.trim() : null
}

type Anchor = { top: number; left: number; sessionId: string; from: string; to: string }

/**
 * A "Quote" button over text selected in the transcript (one message or
 * several): it puts the selection into the composer as a quote chip. It belongs
 * to the chat and messages it was made in: another chat clears it, and the
 * click reads the selection again and quotes it only if it is still there.
 */
export function SelectionQuote({ sessionId, containerRef }: { sessionId: string; containerRef: React.RefObject<HTMLElement | null> }) {
  const [anchor, setAnchor] = React.useState<Anchor | null>(null)

  React.useEffect(() => {
    // A new chat (navigation) starts with no button.
    setAnchor(null)
    const update = () => {
      const found = transcriptSelection(window.getSelection(), containerRef.current)
      if (!found) {
        setAnchor(null)
        return
      }
      const rect = found.range.getBoundingClientRect()
      setAnchor({ top: Math.max(8, rect.top - 36), left: Math.min(window.innerWidth - 96, Math.max(8, rect.right - 72)), sessionId, from: found.from, to: found.to })
    }
    document.addEventListener("selectionchange", update)
    window.addEventListener("scroll", update, true)
    return () => {
      document.removeEventListener("selectionchange", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [containerRef, sessionId])

  if (!anchor || anchor.sessionId !== sessionId) return null
  // In <body>: a transformed ancestor would make `fixed` relative to it.
  return createPortal(
    <Button
      size="sm"
      variant="secondary"
      className="fixed z-50 h-7 gap-1 rounded-full px-2.5 text-xs shadow-md"
      style={{ top: anchor.top, left: anchor.left }}
      data-testid="selection-quote"
      // Keep the selection while the button is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const now = transcriptSelection(window.getSelection(), containerRef.current)
        // Quoted only if the same chat still has this selection (never text carried over from elsewhere).
        if (now && anchor.sessionId === sessionId && now.from === anchor.from && now.to === anchor.to) quoteIntoComposer(sessionId, now.text)
        window.getSelection()?.removeAllRanges()
        setAnchor(null)
      }}
    >
      <TextQuote className="size-3.5" />
      {t("message.quote")}
    </Button>,
    document.body,
  )
}
