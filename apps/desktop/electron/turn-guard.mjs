// The don't-quit-mid-turn guard. The renderer reports whether a turn is
// running (`__setTurnRunning`); closing the window or quitting the app while
// one runs asks first, because a cut-off last turn keeps the session from
// counting as a Good session ★. "Wait for it" is the default (and Escape);
// "Quit anyway" goes ahead. A second close or quit request, while the dialog
// is up or after "Wait for it" in the same turn, quits without asking; the
// guard re-arms when the turn ends. OS shutdown, updater installs and
// relaunches call `allowQuit()` first and are never asked.
//
// `createQuitGuard` is the CLI's and the renderer's state machine
// (apps/app/src/app/lib/good-session.ts, the CLI's good-session-lib.js).

export const TURN_GUARD_TITLE = "A turn is still running.";
export const TURN_GUARD_DETAIL = "Quit now and this session won't count as a Good session ★.";
export const TURN_GUARD_BUTTONS = Object.freeze(["Wait for it", "Quit anyway"]);
const WAIT = 0;

/**
 * `request({ running, interactive, hangup })` answers "quit" (go ahead) or
 * "ask" (show TURN_GUARD_MESSAGE with "Wait for it" / "Quit anyway"). The
 * first quit request while a turn runs asks; a second one, whatever the
 * answer, quits. `answer(wait)` takes the user's choice; `turnEnded()`
 * re-arms the guard for the next turn and says whether the user was waiting.
 * Headless runs and a closed terminal (hangup) never ask.
 */
export function createQuitGuard() {
  let state = "idle"; // idle | asking | waiting
  return {
    get state() {
      return state;
    },
    request({ running = false, interactive = true, hangup = false } = {}) {
      if (!interactive || hangup || !running) return "quit";
      if (state === "idle") {
        state = "asking";
        return "ask";
      }
      return "quit";
    },
    answer(wait) {
      if (state !== "asking") return wait ? "wait" : "quit";
      if (wait) {
        state = "waiting";
        return "wait";
      }
      return "quit";
    },
    turnEnded() {
      const was = state;
      state = "idle";
      return was === "waiting" || was === "asking";
    },
  };
}

/**
 * @param {{
 *   showMessageBox: (window: import("electron").BrowserWindow | null, options: import("electron").MessageBoxOptions) => Promise<{ response: number }>,
 *   getWindow: () => import("electron").BrowserWindow | null,
 *   appName?: string,
 * }} deps
 */
export function createTurnGuard(deps) {
  const guard = createQuitGuard();
  let turnRunning = false;
  let allowed = false;
  /** @type {AbortController | null} */
  let open = null;

  function closeDialog() {
    if (!open) return;
    const controller = open;
    open = null;
    controller.abort();
  }

  /**
   * One close or quit request. Returns true when it may go on now; otherwise
   * it has prevented the event and calls `proceed` once the user picks
   * "Quit anyway".
   */
  function decide(event, proceed) {
    if (allowed) return true;
    if (guard.request({ running: turnRunning }) === "quit") {
      // The second request: it quits, and the open dialog goes with it.
      closeDialog();
      return true;
    }
    event.preventDefault();
    const controller = new AbortController();
    open = controller;
    void deps.showMessageBox(deps.getWindow() ?? null, {
      type: "warning",
      title: deps.appName ?? "OmniRush.ai",
      message: TURN_GUARD_TITLE,
      detail: TURN_GUARD_DETAIL,
      buttons: [...TURN_GUARD_BUTTONS],
      defaultId: WAIT,
      cancelId: WAIT,
      noLink: true,
      signal: controller.signal,
    })
      .then((result) => result.response === WAIT)
      .catch(() => false)
      .then((wait) => {
        // Closed by a second request, which already went ahead.
        if (controller.signal.aborted) return;
        open = null;
        if (guard.answer(wait) === "quit") proceed();
      });
    return false;
  }

  return {
    setTurnRunning(value) {
      const running = value === true;
      // The turn ended: the next turn asks again. An open dialog stays;
      // either answer is fine now.
      if (turnRunning && !running) guard.turnEnded();
      turnRunning = running;
      return turnRunning;
    },
    isTurnRunning() {
      return turnRunning;
    },
    /** `before-quit`: true when the quit may go on now; `quit` quits again after "Quit anyway". */
    guardQuit(event, quit) {
      return decide(event, quit);
    },
    /** The window's `close`: the same question; "Quit anyway" closes it (`close`). */
    guardClose(event, close) {
      return decide(event, close);
    },
    /** OS shutdown or logout, an updater install, a relaunch, a reset: never ask again. */
    allowQuit() {
      allowed = true;
      closeDialog();
    },
    /** An update install that was let through did not start: ask again from now on. */
    restoreQuit() {
      allowed = false;
    },
    get state() {
      return guard.state;
    },
  };
}
