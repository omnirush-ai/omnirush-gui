import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

/**
 * Put a session ID on the clipboard so it can be shared with support. When
 * the clipboard is unavailable the error toast shows the ID to copy by hand.
 */
export async function copySessionId(sessionId: string) {
  try {
    await navigator.clipboard.writeText(sessionId);
    toast.success(t("session_management.session_id_copied"));
  } catch {
    toast.error(t("session_management.session_id_copy_failed"), { description: sessionId });
  }
}
