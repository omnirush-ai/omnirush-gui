import { USER_TABS_OWNER } from "@omnirush/browser-tabs";

/** The panel with no conversation selected (Work pages, the Work browser): the person's own tabs, never an agent's. */
export const NO_SESSION_SIDE_PANEL_KEY = USER_TABS_OWNER;

export function getSidePanelSessionKey(sessionId: string | null) {
  if (!sessionId?.trim()) {
    return NO_SESSION_SIDE_PANEL_KEY;
  }

  return sessionId;
}
