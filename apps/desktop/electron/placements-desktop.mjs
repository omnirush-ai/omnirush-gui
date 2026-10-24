// Sponsored placements in the desktop app (the main process's side).
//
// The rules live in ./placements/placements.mjs (the same file as the CLI's,
// PARITY.sha256 there). Here: the account's authorized call, the cache in the
// app's data folder, and what the window may ask (IPC omnirushPlacement and
// omnirushPlacementAction). The window only ever gets a placement to draw;
// the link is opened here, in the system browser, after a click.
//
// Displays and events (placements.mjs): the window reports each display it
// drew (rendered), the one it measured viewable (≥ 50% of the card on screen
// for one continuous second while the window is focused and visible: the
// renderer's timer, app/lib/placement-viewability.ts), the click and the ×,
// each with the display id it was given. It also says when a conversation
// starts and when the user is active, for the display rotation. The window's
// focus / minimize / show state is pushed to it (WINDOW_STATE_CHANNEL) so the
// timer stops when the window is minimized or hidden.
//
// OMNIRUSH_PLACEMENTS=0 turns it off (the server is not asked).

import path from "node:path";

import { createPlacements, osName, refreshDue, SLOTS, STATE_FILE, WHY_URL } from "./placements/placements.mjs";

/** After a failed ask, the window's next look waits at least this long before asking again. */
export const RETRY_AFTER_MS = 5 * 60_000;
const ACTIONS = new Set(["rendered", "impression", "viewable", "open", "dismiss", "report", "why", "conversation", "activity"]);
/** Main → window: { focused, minimized, visible } of the window. */
export const WINDOW_STATE_CHANNEL = "omnirush:placements:window";

/**
 * Pushes the window's focus / minimize / show state to its page (the
 * viewability timer's "window focused and visible"): on every change and
 * whenever the page (re)loads. The page cannot tell by itself: the window
 * keeps it "visible" while hidden or minimized (no background throttling).
 * Returns the unhook.
 * @param {{ on: Function, removeListener: Function, isFocused: () => boolean, isMinimized: () => boolean, isVisible: () => boolean, isDestroyed: () => boolean, webContents: { send: Function, on: Function, removeListener: Function, isDestroyed?: () => boolean } }} win
 */
export function watchWindowForPlacements(win) {
  const events = ["focus", "blur", "minimize", "restore", "show", "hide"];
  const send = () => {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed?.()) return;
      win.webContents.send(WINDOW_STATE_CHANNEL, { focused: win.isFocused(), minimized: win.isMinimized(), visible: win.isVisible() });
    } catch {
      /* closing */
    }
  };
  for (const name of events) win.on(name, send);
  win.webContents.on("did-finish-load", send);
  return () => {
    for (const name of events) win.removeListener(name, send);
    win.webContents.removeListener("did-finish-load", send);
  };
}

/** @param {Record<string, string | undefined>} [env] */
export function desktopPlacementsAllowed(env = process.env) {
  return !["0", "false", "no", "off"].includes(String(env.OMNIRUSH_PLACEMENTS ?? "").trim().toLowerCase());
}

/**
 * `request(pathAndQuery, init)` resolves { status, data } or null (signed
 * out); `openUrl(url)` opens an https link in the system browser.
 * @param {{
 *   request: import("./placements/placements.mjs").PlacementsRequest,
 *   userDataPath: string,
 *   version?: string,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   openUrl?: ((url: string) => Promise<{ ok: boolean } | boolean | void>) | null,
 *   now?: () => number,
 *   log?: (level: string, message: string, data?: object) => void,
 * }} options
 */
export function createDesktopPlacements({ request, userDataPath, version = "", platform = process.platform, env = process.env, openUrl = null, now = Date.now, log = () => undefined }) {
  const service = createPlacements({
    request,
    stateFile: path.join(userDataPath, STATE_FILE),
    client: "desktop",
    version,
    os: osName(platform),
    allowed: desktopPlacementsAllowed(env),
    now,
    log,
  });
  let lastAsk = 0;
  const openLink = (url) => (typeof openUrl === "function" ? Promise.resolve(openUrl(url)).then((r) => (typeof r === "object" && r !== null ? r.ok !== false : r !== false)).catch(() => false) : Promise.resolve(false));

  /** A fresh answer when the cache is due (signed in late, a long-running app), at most every RETRY_AFTER_MS. */
  async function refreshIfDue() {
    if (!refreshDue(service.state(), now()) || now() - lastAsk < RETRY_AFTER_MS) return;
    lastAsk = now();
    await service.refresh().catch(() => null);
  }

  return {
    service,
    start: () => {
      // The start's own ask counts: the window's first look does not ask again right after a failure.
      if (refreshDue(service.state(), now())) lastAsk = now();
      return service.start();
    },
    stop: () => service.stop(),
    /** IPC omnirushPlacement {slot, sessionId?}: the placement to draw, or null. */
    async placement(input) {
      const slot = typeof input?.slot === "string" && SLOTS.includes(input.slot) ? input.slot : null;
      if (!slot) return null;
      const sessionId = typeof input?.sessionId === "string" && input.sessionId.length <= 200 ? input.sessionId : null;
      if (slot === "turn_footer" && !sessionId) return null;
      await refreshIfDue();
      try {
        return service.claim(slot, { sessionId });
      } catch {
        return null;
      }
    },
    /**
     * IPC omnirushPlacementAction {action, displayId, id?, sessionId?}:
     * rendered, viewable, open (the click), dismiss or report of a display;
     * why (opens the public measurement page);
     * conversation {sessionId} (a turn started in it) and activity (both
     * resolve `rotate`: the home display is due for a change).
     */
    async action(input) {
      const action = typeof input?.action === "string" && ACTIONS.has(input.action) ? input.action : null;
      if (!action) return { ok: false };
      if (action === "activity") return { ok: true, rotate: service.activity() };
      if (action === "why") return { ok: true, opened: await openLink(WHY_URL) };
      if (action === "conversation") {
        const sessionId = typeof input?.sessionId === "string" && input.sessionId.length <= 200 ? input.sessionId : "";
        if (!sessionId) return { ok: false };
        service.conversation(sessionId);
        return { ok: true, rotate: service.activity() };
      }
      // The display id; a bare placement id (older windows) means its newest display.
      const id = typeof input?.displayId === "string" && input.displayId ? input.displayId : typeof input?.id === "string" ? input.id : "";
      if (!id || id.length > 64) return { ok: false };
      if (action === "rendered" || action === "impression") return { ok: service.rendered(id) };
      if (action === "viewable") return { ok: service.viewable(id) };
      if (action === "dismiss") return { ok: service.dismiss(id) };
      if (action === "report") return { ok: service.report(id) };
      const url = service.click(id);
      if (!url) return { ok: false };
      return { ok: true, opened: await openLink(url) };
    },
  };
}
