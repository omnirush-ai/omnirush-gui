import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useControlAction, type OmniRushControlAction } from "./control/control-provider";
import { t } from "@/i18n";
import { companyAccountNow } from "../domains/work/company-limit";
import { useEnterpriseFlags } from "../domains/work/enterprise-mode";

// The same rules as the engine plugin and the CLI (apps/server/src/
// opencode-plugins/budget-wrap-rules.ts): one question per session and
// offer, only while the session is idle; every answer is final, and a failed
// wrap becomes a notice with a retry action, never the question again.
type Choice = "pending" | "accept" | "decline" | "done" | "failed";
const FINAL: readonly Choice[] = ["decline", "done", "failed"];
type Offer = { sessionID: string; offerID: string; scopes: string; choice: Choice; held?: boolean };
type WrapStore = {
  offers: Offer[];
  offer: (sessionID: string, offerID: string, scopes: string) => Choice;
  hold: (sessionID: string, offerID: string) => void;
  choose: (sessionID: string, offerID: string, choice: Choice) => void;
  clear: (sessionID: string, offerID: string) => void;
};

const useWrapStore = create<WrapStore>()(persist((set, get) => ({
  offers: [],
  offer: (sessionID, offerID, scopes) => {
    const existing = get().offers.find((entry) => entry.sessionID === sessionID && entry.offerID === offerID);
    if (existing) {
      // The session is idle again: an unanswered question may show.
      if (existing.held) set((state) => ({ offers: state.offers.map((entry) => entry === existing ? { ...entry, held: false } : entry) }));
      return existing.choice;
    }
    set((state) => ({ offers: [
      { sessionID, offerID, scopes, choice: "pending" },
      ...state.offers.filter((entry) => entry.sessionID !== sessionID),
    ] }));
    return "pending";
  },
  hold: (sessionID, offerID) => set((state) => ({
    offers: state.offers.map((entry) => entry.sessionID === sessionID && entry.offerID === offerID
      ? { ...entry, held: true } : entry),
  })),
  choose: (sessionID, offerID, choice) => set((state) => ({
    offers: state.offers.map((entry) => entry.sessionID === sessionID && entry.offerID === offerID
      ? { ...entry, choice } : entry),
  })),
  // The gateway withdrew the offer. An answer is kept, so the same offer
  // never asks again; only an unanswered question goes away.
  clear: (sessionID, offerID) => set((state) => ({
    offers: state.offers.filter((entry) => entry.sessionID !== sessionID || entry.offerID !== offerID
      || FINAL.includes(entry.choice)),
  })),
}), {
  name: "omnirush:budget-wrap-consent:v2",
  storage: createJSONStorage(() => localStorage),
  // Persist final choices, not a live popup: after a full app restart the
  // engine must renew an offer before Accept can start a real compaction.
  partialize: (state) => ({ offers: state.offers.filter((entry) => FINAL.includes(entry.choice)) }),
}));

function fields(args: unknown): { sessionID: string; offerID: string; scopes: string } | null {
  if (!args || typeof args !== "object") return null;
  if (!("sessionID" in args) || !("offerID" in args)
    || typeof args.sessionID !== "string" || typeof args.offerID !== "string") return null;
  const sessionID = args.sessionID.trim();
  const offerID = args.offerID.trim();
  if (!sessionID || !offerID) return null;
  return { sessionID, offerID, scopes: "scopes" in args && typeof args.scopes === "string" ? args.scopes : "" };
}

function retryWrap(sessionID: string, offerID: string) {
  const store = useWrapStore.getState();
  const entry = store.offers.find((item) => item.sessionID === sessionID && item.offerID === offerID);
  if (!entry || entry.choice !== "failed") return;
  // The engine starts it once the session is idle.
  store.choose(sessionID, offerID, "accept");
  toast.info("Wrapping up", { description: "Saving a handoff for this session." });
}

/** The question is asked once per session and offer, only while the session is idle. */
export function BudgetWrapConsent() {
  const offers = useWrapStore((state) => state.offers);
  const pending = offers.find((entry) => entry.choice === "pending" && !entry.held);
  // An OmniRush Work company account's limit is its company's: no token allowance in the question.
  const enterprise = useEnterpriseFlags().on;

  const updateAction = useMemo<OmniRushControlAction>(() => ({
    id: "budget.wrap.update",
    label: "Update pending quota wrap",
    description: "Show or settle a local, user-approved context wrap offer.",
    // The engine syncs a local offer through the query mailbox, so polling
    // does not turn on Control Mode or trigger its visible action animation.
    kind: "query",
    sideEffect: "none",
    requiresArgs: true,
    execute: (args) => {
      const parsed = fields(args);
      if (!parsed || !args || typeof args !== "object") return { ok: false, error: "Invalid wrap offer" };
      const operation = "operation" in args ? args.operation : undefined;
      const store = useWrapStore.getState();
      if (operation === "offer") return { choice: store.offer(parsed.sessionID, parsed.offerID, parsed.scopes) };
      if (operation === "hold") store.hold(parsed.sessionID, parsed.offerID);
      else if (operation === "finish") {
        store.choose(parsed.sessionID, parsed.offerID, "done");
        // An OmniRush Work company account has no tokens of its own: the company's words.
        toast.success("Wrap up complete", { description: companyAccountNow() ? t("work.ent.wrap_done") : "Your handoff is saved. You can keep working while tokens remain." });
      } else if (operation === "fail") {
        // Final for this offer: a notice with a retry action, not the question again.
        store.choose(parsed.sessionID, parsed.offerID, "failed");
        const { sessionID, offerID } = parsed;
        toast.warning("Wrap up did not finish", {
          description: "Your session is unchanged. You can retry, or keep working.",
          action: { label: "Retry", onClick: () => retryWrap(sessionID, offerID) },
          duration: 30_000,
        });
      }
      else if (operation === "clear") store.clear(parsed.sessionID, parsed.offerID);
      else return { ok: false, error: "Unknown wrap operation" };
      return { ok: true };
    },
  }), []);
  useControlAction(updateAction);

  // Closing the question (Esc, outside click) is "Keep working".
  return <Dialog open={Boolean(pending)} onOpenChange={(open) => {
    if (!open && pending) useWrapStore.getState().choose(pending.sessionID, pending.offerID, "decline");
  }}>
    <DialogContent showCloseButton={false} data-testid="budget-wrap-consent">
      <DialogHeader>
        <DialogTitle>Save a handoff for this session?</DialogTitle>
        <DialogDescription>
          {enterprise ? t("work.ent.wrap_body") : <>Your {pending?.scopes.replace(",", " and ") || "token"} allowance is nearly used. A wrap saves a summary of this session so you can resume it later. You can keep working while tokens remain, whether you wrap or not.</>}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" data-testid="budget-wrap-decline" onClick={() => {
          if (pending) useWrapStore.getState().choose(pending.sessionID, pending.offerID, "decline");
        }}>Keep working</Button>
        <Button data-testid="budget-wrap-accept" onClick={() => {
          if (pending) {
            useWrapStore.getState().choose(pending.sessionID, pending.offerID, "accept");
            toast.info("Wrapping up", { description: "Saving a handoff for this session." });
          }
        }}>Wrap up</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
