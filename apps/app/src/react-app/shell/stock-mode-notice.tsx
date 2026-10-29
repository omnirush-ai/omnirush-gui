import { useEffect } from "react";

import { toast } from "@/components/ui/sonner";
import { isEventMode, isStockMode } from "../../app/lib/runtime-env";

/** Shown text names no mode (no "stock"/"farm" words, owner rule). */
export const STOCK_NOTICE = "OpenCode v2 on GPT 6 Astra only. No OmniRush tools, prompts, MCP servers or automatic compaction.";

/** Stock mode (OMNIRUSH_FARM=1 at launch): one short notice when the window opens. */
export function StockModeNotice() {
  useEffect(() => {
    // Not when a hackathon turned it on: the event badge is all the app shows then.
    if (!isStockMode() || isEventMode()) return;
    // After this commit: the Toaster (providers.tsx, a later sibling) subscribes in its own effect.
    const timer = setTimeout(() => toast.info(STOCK_NOTICE, { duration: 15_000 }), 500);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
