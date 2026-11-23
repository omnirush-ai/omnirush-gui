// The toasts an Ask shows. Each kind has one fixed id, so a run of Shift+click adds updates one line in place
// ("Added 3 items to your question") and a refused add takes its place: at most one Ask line, never a pile of cards.
import { MessageSquarePlus } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

export const ASK_ADDED_TOAST_ID = "work-ask-added";
export const ASK_FULL_TOAST_ID = "work-ask-full";
export const ASK_CLAUDE_TOAST_ID = "work-ask-claude";
const DURATION_MS = 4000;

/** What is on screen: the added line (with how many adds it counts, for one composer) and the full line. */
const shown = { added: false, owner: "", count: 0, full: false };

export function askAddedTitle(count: number): string {
  return count > 1 ? t("work.ask.added_toast_many", { count }) : t("work.ask.added_toast");
}

/** A chip was added and the user stays on the page: one line from the top with Open (to the composer). */
export function showAskAdded(owner: string, open: () => void) {
  if (shown.full) {
    shown.full = false;
    toast.dismiss(ASK_FULL_TOAST_ID);
  }
  shown.count = shown.added && shown.owner === owner ? shown.count + 1 : 1;
  shown.owner = owner;
  shown.added = true;
  toast.undo(askAddedTitle(shown.count), {
    id: ASK_ADDED_TOAST_ID,
    icon: MessageSquarePlus,
    undo: { label: t("work.ask.open"), onClick: open },
    closeLabel: t("common.close"),
    duration: DURATION_MS,
    onClose: () => {
      shown.added = false;
      shown.count = 0;
    },
  });
}

/** The composer already holds 5 chips: the same one line, in place of the added one, with Open to remove one. */
export function showAskFull(open: () => void) {
  if (shown.added) {
    shown.added = false;
    shown.count = 0;
    toast.dismiss(ASK_ADDED_TOAST_ID);
  }
  shown.full = true;
  toast.undo(t("work.ask.max"), {
    id: ASK_FULL_TOAST_ID,
    icon: MessageSquarePlus,
    undo: { label: t("work.ask.open"), onClick: open },
    closeLabel: t("common.close"),
    duration: DURATION_MS,
    onClose: () => {
      shown.full = false;
    },
  });
}

/** The chat on screen runs on a Claude model, so the chip went to the Work home: said once, updated in place. */
export function showAskClaudeHome() {
  toast.info(t("work.ask.claude_home"), { id: ASK_CLAUDE_TOAST_ID });
}
