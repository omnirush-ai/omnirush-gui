import { useCallback, useEffect, useRef, useState } from "react";

import type { OmniRushBestPractices, OmniRushBestPracticesChange, OmniRushServerClient } from "@/app/lib/omnirush-server";

export type BestPracticesClient = Pick<OmniRushServerClient, "getBestPractices" | "setBestPractices">;

export const BEST_PRACTICES_HELP = "Built-in guides help the agent plan, build, test, and fix your work. On by default. Saved on this server.";

export function bestPracticesChangeMessage(result: OmniRushBestPracticesChange): string {
  const choice = result.enabled ? "on" : "off";
  switch (result.engine.status) {
    case "applied":
      return `Best practices ${choice}. Ready for your next request.`;
    case "deferred":
      return `Best practices ${choice} saved. This change waits until the engine is idle.`;
    case "failed":
      return `Best practices ${choice} saved. The engine change could not be confirmed. Use Reload in Settings to apply it.`;
    case "unconfigured":
      return `Best practices ${choice} saved. The choice will apply when the engine starts.`;
  }
}

/** A failed apply keeps the server's saved choice visible, with its warning. */
export function useBestPractices(client: BestPracticesClient | null) {
  const [setting, setSetting] = useState<OmniRushBestPractices | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // A GET begun before a PUT must not replace the newly saved choice.
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const startedAt = sequence.current;
    let cancelled = false;
    setSetting(null);
    setBusy(false);
    setStatus("");
    if (client) {
      void client.getBestPractices()
        .then((value) => {
          if (!cancelled && sequence.current === startedAt) setSetting(value);
        })
        .catch(() => {
          if (!cancelled && sequence.current === startedAt) setStatus("Best practices could not be loaded. Try opening Settings again.");
        });
    }
    return () => { cancelled = true; };
  }, [client]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!client || busy) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setBusy(true);
    setStatus("Saving best practices…");
    try {
      const result = await client.setBestPractices(enabled);
      if (sequence.current !== startedAt) return;
      setSetting({ enabled: result.enabled });
      setStatus(bestPracticesChangeMessage(result));
    } catch {
      if (sequence.current !== startedAt) return;
      // The server may have saved before the response was lost. Re-read the
      // choice, but never infer that an engine reload completed.
      const saved = await client.getBestPractices().catch(() => null);
      if (sequence.current !== startedAt) return;
      if (saved) setSetting(saved);
      setStatus("Best practices could not be applied. Open Settings again to check the saved choice, then use Reload.");
    } finally {
      if (sequence.current === startedAt) setBusy(false);
    }
  }, [busy, client]);

  return { setting, busy, status, setEnabled };
}
