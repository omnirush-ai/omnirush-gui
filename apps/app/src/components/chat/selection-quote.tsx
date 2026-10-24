import * as React from "react"
import { createPortal } from "react-dom"
import { TextQuote } from "lucide-react"

import { Button } from "@/components/ui/button"

import { quoteIntoComposer } from "./quote"

/**
 * A "Quote" button over text selected in the transcript (one message or
 * several): it puts the selection into the composer as a quote chip.
 */
export function SelectionQuote({ sessionId, containerRef }: { sessionId: string; containerRef: React.RefObject<HTMLElement | null> }) {
  const [anchor, setAnchor] = React.useState<{ top: number; left: number; text: string } | null>(null)

  React.useEffect(() => {
    const update = () => {
      const selection = window.getSelection()
      const container = containerRef.current
      const text = selection?.toString() ?? ""
      if (!selection || selection.isCollapsed || !text.trim() || !container || selection.rangeCount === 0) {
        setAnchor(null)
        return
      }
      const range = selection.getRangeAt(0)
      const inMessage = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement
        return Boolean(element && container.contains(element) && element.closest("[data-message-id]"))
      }
      if (!inMessage(range.startContainer) || !inMessage(range.endContainer)) {
        setAnchor(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setAnchor({ top: Math.max(8, rect.top - 36), left: Math.min(window.innerWidth - 96, Math.max(8, rect.right - 72)), text })
    }
    document.addEventListener("selectionchange", update)
    window.addEventListener("scroll", update, true)
    return () => {
      document.removeEventListener("selectionchange", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [containerRef])

  if (!anchor) return null
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
        quoteIntoComposer(sessionId, anchor.text)
        window.getSelection()?.removeAllRanges()
        setAnchor(null)
      }}
    >
      <TextQuote className="size-3.5" />
      Quote
    </Button>,
    document.body,
  )
}
