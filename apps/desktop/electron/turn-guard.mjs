// The don't-quit-mid-turn guard and the finish guard. The renderer reports whether a turn is
// running (`__setTurnRunning`); closing the window or quitting the app while
// one runs asks first, because a cut-off last turn keeps the session from
// counting as a Good session ★. "Finish it" is the default (and Escape);
// "Quit anyway" goes ahead. A second close or quit request, while the dialog
// is up or after "Finish it" in the same turn, quits without asking; the
// guard re-arms when the turn ends. OS shutdown, updater installs and
// relaunches call `allowQuit()` first and are never asked.
//
// `createQuitGuard` is the CLI's and the renderer's state machine
// (apps/app/src/app/lib/good-session.ts, the CLI's good-session-lib.js).

export const TURN_GUARD_TITLE = "A turn is still running.";
export const TURN_GUARD_DETAIL = "Quit now and this session won't count as a Good session ★.";
// "Finish it" keeps the app open and lets the running turn finish.
export const TURN_GUARD_BUTTONS = Object.freeze(["Finish it", "Quit anyway"]);
const WAIT = 0;

// The finish guard: no turn runs, but the last one was cut off ("cut") or
// ends on a question to the user ("awaiting"). Asked once per session and
// state; "Finish it" (the default) puts the reply in the composer.
export const FINISH_GUARD_TITLE = "This session is one step from counting.";
export const FINISH_GUARD_DETAIL = Object.freeze({
  awaiting: "The agent asked you a question. Answer it (or tell it to go ahead) and let the turn finish, or this session won't pass the quality check.",
  cut: "The last turn stopped before it finished. Send \"continue\" and let it finish, or this session won't pass the quality check.",
});
export const FINISH_GUARD_BUTTONS = Object.freeze(["Finish it", "Quit anyway"]);
/** Main → renderer: the user picked "Finish it" ({ sessionId, kind }). */
export const FINISH_GUARD_EVENT = "omnirush:finish-guard:finish";
const FINISH = 0;

/** `{ sessionId, kind }` from the renderer, or null when it names no session or no known state. */
export function finishState(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (!sessionId) return null;
  return { sessionId, kind: value.kind === "awaiting" || value.kind === "cut" ? value.kind : null };
}

/**
 * `request({ running, interactive, hangup, finish })` answers "quit" (go
 * ahead), "ask" (a turn runs: "Wait for it" / "Quit anyway") or "finish"
 * (`finish`, a "<session>:<state>" key: "Finish it" / "Quit anyway"). The
 * first quit request while a turn runs asks; a second one, whatever the
 * answer, quits. Each finish key asks once, ever. `answer(wait)` takes the
 * user's choice; `turnEnded()` re-arms the running-turn question for the
 * next turn and says whether the user was waiting. Headless runs and a
 * closed terminal (hangup) never ask.
 */
export function createQuitGuard() {
  let state = "idle"; // idle | asking | waiting
  let askingFinish = false;
  const asked = new Set();
  return {
    get state() {
      return state;
    },
    request({ running = false, interactive = true, hangup = false, finish = null } = {}) {
      if (!interactive || hangup) return "quit";
      if (running) {
        if (state === "idle") {
          state = "asking";
          askingFinish = false;
          return "ask";
        }
        return "quit";
      }
      if (finish && state !== "asking" && !asked.has(finish)) {
        asked.add(finish);
        state = "asking";
        askingFinish = true;
        return "finish";
      }
      return "quit";
    },
    answer(wait) {
      if (state !== "asking") return wait ? "wait" : "quit";
      if (askingFinish) {
        // Asked once for this state: the next request quits, and a new turn asks as usual.
        askingFinish = false;
        state = "idle";
        return wait ? "wait" : "quit";
      }
      if (wait) {
        state = "waiting";
        return "wait";
      }
      return "quit";
    },
    /** Whether the finish key was asked about already. */
    askedAbout(finish) {
      return asked.has(finish);
    },
    turnEnded() {
      const was = state;
      state = "idle";
      askingFinish = false;
      return was === "waiting" || was === "asking";
    },
  };
}

/**
 * @param {{
 *   showMessageBox: (window: import("electron").BrowserWindow | null, options: import("electron").MessageBoxOptions) => Promise<{ response: number }>,
 *   getWindow: () => import("electron").BrowserWindow | null,
 *   appName?: string,
 *   onFinish?: (detail: { sessionId: string, kind: "awaiting" | "cut" }) => void,
 * }} deps
 */
export function createTurnGuard(deps) {
  const guard = createQuitGuard();
  let turnRunning = false;
  /** Open sessions whose last turn needs finishing: sessionId → "awaiting" | "cut". */
  const finishing = new Map();
  const onFinish = deps.onFinish ?? ((detail) => {
    const win = deps.getWindow();
    if (!win || win.isDestroyed?.()) return;
    win.show?.();
    win.focus?.();
    win.webContents?.send(FINISH_GUARD_EVENT, detail);
  });
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
  /** The first open session whose finish state was not asked about yet. */
  function nextFinish() {
    for (const [sessionId, kind] of finishing) {
      const key = `${sessionId}:${kind}`;
      if (!guard.askedAbout(key)) return { sessionId, kind, key };
    }
    return null;
  }

  function decide(event, proceed) {
    if (allowed) return true;
    const finish = turnRunning ? null : nextFinish();
    const verdict = guard.request({ running: turnRunning, finish: finish?.key ?? null });
    if (verdict === "quit") {
      // The second request: it quits, and the open dialog goes with it.
      closeDialog();
      return true;
    }
    event.preventDefault();
    const asking = verdict === "finish" && finish ? finish : null;
    const controller = new AbortController();
    open = controller;
    void deps.showMessageBox(deps.getWindow() ?? null, {
      type: "warning",
      title: deps.appName ?? "OmniRush.ai",
      message: asking ? FINISH_GUARD_TITLE : TURN_GUARD_TITLE,
      detail: asking ? FINISH_GUARD_DETAIL[asking.kind] : TURN_GUARD_DETAIL,
      buttons: asking ? [...FINISH_GUARD_BUTTONS] : [...TURN_GUARD_BUTTONS],
      defaultId: asking ? FINISH : WAIT,
      cancelId: asking ? FINISH : WAIT,
      noLink: true,
      signal: controller.signal,
    })
      .then((result) => result.response === (asking ? FINISH : WAIT))
      .catch(() => false)
      .then((wait) => {
        // Closed by a second request, which already went ahead.
        if (controller.signal.aborted) return;
        open = null;
        if (guard.answer(wait) === "quit") {
          proceed();
          return;
        }
        if (asking) onFinish({ sessionId: asking.sessionId, kind: asking.kind });
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
    /** The renderer: an open session's last turn needs finishing (`kind`), or no longer does (`kind: null`). */
    setFinishState(value) {
      const next = finishState(value);
      if (!next) return false;
      if (next.kind) finishing.set(next.sessionId, next.kind);
      else finishing.delete(next.sessionId);
      return true;
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
