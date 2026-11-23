import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Test switches for capture. OMNIRUSH_ELECTRON_FAKE_MEDIA gives Chromium a
 * fake microphone (a beep); OMNIRUSH_VOICE_INPUT_FILE (the voice-core test
 * hook) plays that WAV file through the fake microphone once, so voice
 * dictation runs end to end, AudioWorklet included, without a real device.
 */
export function configureFakeMediaForTests(app, enabled, env = process.env) {
  const audioFile = String(env.OMNIRUSH_VOICE_INPUT_FILE ?? "").trim();
  if (!enabled && !audioFile) return;
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  if (!audioFile) return;
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${audioFile}%noloop`);
}

function isLocalRendererOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "file://") return true;
  try {
    const url = new URL(value);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function shouldAllowMainWindowPermission(input) {
  const { webContents, permission, origin, details, mainWindow, request = false } = input;
  if (!mainWindow || !webContents || webContents.id !== mainWindow.webContents.id) return false;
  if (!isLocalRendererOrigin(origin)) return false;
  if (permission !== "media" && permission !== "audioCapture") return true;
  const mediaType = typeof details.mediaType === "string" ? details.mediaType : "";
  if (mediaType && mediaType !== "audio") return false;
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  // getDisplayMedia asks with no device types, but so does the legacy getUserMedia({ chromeMediaSource: "desktop" }),
  // which never reaches the display-media handler and gets the whole screen. Only the app's own top frame may ask.
  if (request && permission === "media" && !mediaType && mediaTypes.length === 0) return details.isMainFrame === true;
  return mediaType === "audio" || (mediaTypes.includes("audio") && !mediaTypes.includes("video"));
}

export function installMediaPermissionHandlers(session, getMainWindow) {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: details?.requestingUrl,
      details: details ?? {},
      mainWindow: getMainWindow(),
      request: true,
    }));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: requestingOrigin,
      details: details ?? {},
      mainWindow: getMainWindow(),
    })
  ));
}

/**
 * Meeting notes' system audio ("Them"): getDisplayMedia from the app's own window is answered with that window as
 * the video (tab capture, no Screen Recording permission; the page stops it at once) and loopback audio: the Core
 * Audio tap on macOS 14.2+ (Chromium's MacCatapLoopbackAudioForScreenShare, on by default; never disable it, or macOS
 * falls back to ScreenCaptureKit and Screen Recording), WASAPI loopback on Windows, the default sink's monitor on
 * Linux. Any other frame or origin is refused.
 */
export function displayAudioAnswer(request, mainWindow) {
  const frame = request?.frame;
  const main = mainWindow?.webContents?.mainFrame;
  if (!frame || !main || frame.processId !== main.processId || frame.routingId !== main.routingId) return {};
  if (!isLocalRendererOrigin(request.securityOrigin)) return {};
  return { video: frame, audio: "loopback" };
}

export function installDisplayAudioHandler(session, getMainWindow) {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => callback(displayAudioAnswer(request, getMainWindow())));
}

// The built-in browser shows arbitrary websites. Only harmless, page-local
// capabilities are granted; camera, microphone, location, notifications,
// clipboard reads, screen capture, devices and the rest are denied.
const BROWSER_PANEL_ALLOWED_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "fileSystem",
  "fullscreen",
  "keyboardLock",
  "mediaKeySystem",
  "pointerLock",
  "storage-access",
  "top-level-storage-access",
]);

function isDesktopSchemeUrl(url) {
  return /^omnirush(?:-dev)?:/i.test(String(url ?? "").trim());
}

/**
 * @param {string} permission
 */
export function isBrowserPanelPermissionAllowed(permission) {
  return BROWSER_PANEL_ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Permission policy for the built-in browser's session (persist:omnirush-browser).
 * Handing a link to the OS ("openExternal") asks the user first, except
 * omnirush:// links, which only the browser panel's own confirmation forwards.
 * Camera, microphone, notifications and screen sharing go to `sitePermissions`
 * (createSitePermissions below) when it is given, and stay denied otherwise.
 *
 * @param {Electron.Session} browserSession
 * @param {{
 *   confirmExternal: (url: string, sourceUrl: string) => Promise<boolean>,
 *   sitePermissions?: ReturnType<typeof createSitePermissions> | null,
 * }} options
 */
export function installBrowserPanelPermissionHandlers(browserSession, { confirmExternal, sitePermissions = null }) {
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (sitePermissions && requestedSiteKinds(permission, /** @type {{ mediaTypes?: unknown }} */ (details)) !== null) {
      Promise.resolve()
        .then(() => sitePermissions.request(webContents, permission, details ?? {}))
        .then((allowed) => callback(allowed === true), () => callback(false));
      return;
    }
    if (permission !== "openExternal") {
      callback(isBrowserPanelPermissionAllowed(permission));
      return;
    }
    const request = /** @type {{ externalURL?: string, requestingUrl?: string }} */ (details ?? {});
    const externalUrl = String(request.externalURL ?? "");
    if (!externalUrl || isDesktopSchemeUrl(externalUrl)) {
      callback(false);
      return;
    }
    const sourceUrl = String(request.requestingUrl ?? webContents?.getURL?.() ?? "");
    Promise.resolve()
      .then(() => confirmExternal(externalUrl, sourceUrl))
      .then((allowed) => callback(allowed === true), () => callback(false));
  });
  browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (sitePermissions && checkedSiteKinds(permission, details) !== null) {
      try {
        return sitePermissions.check(webContents, permission, requestingOrigin, details ?? {}) === true;
      } catch {
        return false;
      }
    }
    return isBrowserPanelPermissionAllowed(permission);
  });
  // getDisplayMedia: only the source the person picked for that page, never a default screen.
  browserSession.setDisplayMediaRequestHandler?.((request, callback) => {
    let answer = {};
    try {
      answer = sitePermissions?.displayMedia(request) ?? {};
    } catch {
      answer = {};
    }
    callback(answer);
  });
}

// Calls and alerts in the built-in browser (Work). Camera, microphone,
// notifications and screen sharing ask per site, and only in the person's own
// tabs (the panel with no conversation selected, and the Work browser). A tab a
// conversation owns is the agent's: it keeps every one of them denied, so the
// agent never gets a camera through a choice the person made earlier. Camera,
// microphone and notification choices are remembered per site on this computer
// (<userData>/browser-site-permissions.json) and never sent anywhere. Screen
// sharing asks every time, with a picker. Without Work the browser is as before.

/** Owner key of the person's own tabs (the app's NO_SESSION_SIDE_PANEL_KEY). */
export const USER_TAB_OWNER = "__omnirush_no_session__";
/** Given to the person's own tabs while Work's calls and alerts are on; browser-content-preload.cjs reads it. */
export const SITE_PROMPTS_ARGUMENT = "--omnirush-site-prompts";
/** What a site can be allowed or blocked, remembered per site. Screen sharing is never remembered. */
export const SITE_PERMISSION_KINDS = Object.freeze(["camera", "microphone", "notifications"]);
const SITE_PERMISSION_LIMIT = 500;
// getDisplayMedia tells the app it is the caller just before it asks (browser-content-preload.cjs).
const SCREEN_INTENT_MS = 10_000;
const SCREEN_PICK_MS = 60_000;
const SITE_PROMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * The site a choice belongs to: an https origin, or http on this computer.
 * Anything else (http sites, file:, data:, about:) can never be asked.
 * @param {unknown} value
 * @returns {string | null}
 */
export function sitePermissionOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
  } catch {
    // not a URL
  }
  return null;
}

/**
 * What a permission request asks for: ["camera"], ["camera", "microphone"],
 * ["notifications"] or ["screen"] (a request with no device types, which is how
 * getDisplayMedia arrives). [] for a media request with a type we do not know.
 * null when it is not a call or alert permission.
 * @param {string} permission
 * @param {{ mediaTypes?: unknown }} [details]
 */
export function requestedSiteKinds(permission, details) {
  if (permission === "notifications") return ["notifications"];
  if (permission !== "media") return null;
  const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  if (types.length === 0) return ["screen"];
  const kinds = [];
  if (types.includes("video")) kinds.push("camera");
  if (types.includes("audio")) kinds.push("microphone");
  return kinds.length === new Set(types).size ? kinds : [];
}

/**
 * What a permission check is about. A media check from navigator.permissions
 * names no device type, so it covers both.
 * @param {string} permission
 * @param {{ mediaType?: unknown }} [details]
 */
export function checkedSiteKinds(permission, details) {
  if (permission === "notifications") return ["notifications"];
  if (permission !== "media") return null;
  if (details?.mediaType === "video") return ["camera"];
  if (details?.mediaType === "audio") return ["microphone"];
  return ["camera", "microphone"];
}

/**
 * Remembered choices, one record per site: { origin, camera?, microphone?,
 * notifications?, at }, each "allow" or "block". Read once, written whole
 * (owner-only) after every change.
 * @param {{ filePath: string | (() => string | null), now?: () => number, limit?: number }} options
 */
export function createSitePermissionStore({ filePath, now = Date.now, limit = SITE_PERMISSION_LIMIT }) {
  /** @type {Map<string, { at: number, camera?: "allow" | "block", microphone?: "allow" | "block", notifications?: "allow" | "block" }> | null} */
  let sites = null;

  function file() {
    try {
      return typeof filePath === "function" ? filePath() : filePath;
    } catch {
      return null;
    }
  }

  function load() {
    if (sites) return sites;
    sites = new Map();
    const target = file();
    if (!target) return sites;
    try {
      const saved = JSON.parse(readFileSync(target, "utf8"));
      for (const entry of Array.isArray(saved?.sites) ? saved.sites : []) {
        const origin = sitePermissionOrigin(entry?.origin);
        if (!origin || origin !== entry.origin) continue;
        /** @type {{ at: number, camera?: "allow" | "block", microphone?: "allow" | "block", notifications?: "allow" | "block" }} */
        const record = { at: Number.isFinite(entry.at) ? entry.at : 0 };
        for (const kind of SITE_PERMISSION_KINDS) {
          if (entry[kind] === "allow" || entry[kind] === "block") record[kind] = entry[kind];
        }
        if (SITE_PERMISSION_KINDS.some((kind) => record[kind])) sites.set(origin, record);
      }
    } catch {
      // No file yet, or unreadable: nothing remembered.
    }
    return sites;
  }

  function save() {
    const target = file();
    if (!target) return;
    const list = [...load()].map(([origin, record]) => ({ origin, ...record }));
    try {
      if (list.length === 0) {
        rmSync(target, { force: true });
        return;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, sites: list }), { mode: 0o600 });
      renameSync(temp, target);
    } catch {
      // Kept for this launch only.
    }
  }

  return {
    /** @param {string | null} origin @param {string} kind @returns {"allow" | "block" | null} */
    decision(origin, kind) {
      if (!origin) return null;
      const value = load().get(origin)?.[/** @type {"camera"} */ (kind)];
      return value === "allow" || value === "block" ? value : null;
    },
    /** @param {string} origin @param {string[]} kinds @param {"allow" | "block"} decision */
    remember(origin, kinds, decision) {
      if (!sitePermissionOrigin(origin) || (decision !== "allow" && decision !== "block")) return;
      const all = load();
      const record = { ...(all.get(origin) ?? {}), at: now() };
      for (const kind of kinds) if (SITE_PERMISSION_KINDS.includes(kind)) record[/** @type {"camera"} */ (kind)] = decision;
      all.delete(origin);
      all.set(origin, record);
      while (all.size > limit) all.delete(/** @type {string} */ (all.keys().next().value));
      save();
    },
    /** Forget every choice for one site; it asks again next time. */
    forget(origin) {
      const removed = load().delete(String(origin ?? ""));
      if (removed) save();
      return removed;
    },
    clear() {
      load().clear();
      save();
    },
    /** Newest first. */
    list() {
      return [...load()]
        .map(([origin, record]) => ({
          origin,
          camera: record.camera ?? null,
          microphone: record.microphone ?? null,
          notifications: record.notifications ?? null,
          at: record.at,
        }))
        .sort((left, right) => right.at - left.at);
    },
  };
}

/**
 * The calls and alerts policy for the built-in browser's tabs.
 *
 * @param {{
 *   store: ReturnType<typeof createSitePermissionStore>,
 *   enabled: () => boolean,
 *   tabFor: (webContents: any) => { tabId: string, user: boolean } | null,
 *   contentsForFrame?: (frame: any) => any,
 *   show: (tabId: string, prompt: { id: string, origin: string, kinds: string[], system?: boolean } | null) => void,
 *   systemAccess?: (kinds: string[]) => Promise<boolean>,
 *   onChange?: () => void,
 *   now?: () => number,
 *   timeoutMs?: number,
 * }} options
 */
export function createSitePermissions({ store, enabled, tabFor, contentsForFrame = () => null, show, systemAccess = async () => true, onChange = () => {}, now = Date.now, timeoutMs = SITE_PROMPT_TIMEOUT_MS }) {
  /** @type {Map<string, { current: any, waiting: any[] }>} */
  const queues = new Map();
  /** @type {Map<number, { origin: string, at: number }>} */
  const intents = new Map();
  /** @type {Map<number, { origin: string, source: { id: string, name: string }, at: number }>} */
  const picks = new Map();
  let promptCounter = 0;

  /** The person's own tab, while Work's calls and alerts are on. */
  function eligibleTab(webContents) {
    if (!webContents || !enabled()) return null;
    const tab = tabFor(webContents);
    return tab?.user ? tab : null;
  }

  /** The page's own site, when `requesting` is that site (a frame of another site never asks). */
  function pageOrigin(webContents, requesting) {
    let top = null;
    try {
      top = sitePermissionOrigin(webContents.getURL());
    } catch {
      top = null;
    }
    return top && sitePermissionOrigin(requesting) === top ? top : null;
  }

  function stateOf(origin, kind) {
    return store.decision(origin, kind) ?? "ask";
  }

  function settle(entry, answer) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(answer);
  }

  function next(tabId) {
    const queue = queues.get(tabId);
    if (!queue || queue.current) return;
    while (queue.waiting.length > 0) {
      const entry = queue.waiting.shift();
      if (!entry.system && entry.kinds[0] !== "screen") {
        // A choice made while this one waited answers it too.
        if (entry.kinds.some((kind) => store.decision(entry.origin, kind) === "block")) {
          settle(entry, "block");
          continue;
        }
        const open = entry.kinds.filter((kind) => store.decision(entry.origin, kind) !== "allow");
        if (open.length === 0) {
          settle(entry, "allow");
          continue;
        }
        entry.kinds = open;
      }
      queue.current = entry;
      entry.timer = setTimeout(() => { void answer(tabId, entry.id, "dismiss"); }, timeoutMs);
      entry.timer.unref?.();
      show(tabId, { id: entry.id, origin: entry.origin, kinds: [...entry.kinds], ...(entry.system ? { system: true } : {}) });
      return;
    }
    queues.delete(tabId);
    show(tabId, null);
  }

  /** One question at a time per tab, in the order pages asked. */
  function enqueue(tabId, prompt) {
    return new Promise((resolve) => {
      promptCounter += 1;
      const entry = { id: `site_${promptCounter.toString(36)}`, tabId, ...prompt, resolve, timer: null };
      const queue = queues.get(tabId) ?? { current: null, waiting: [] };
      queues.set(tabId, queue);
      queue.waiting.push(entry);
      next(tabId);
    });
  }

  /**
   * The person answered the bar or the picker: "allow" or "block" (remembered
   * for the site), "dismiss" (this time only), { share: { id, name } } for a
   * screen. A stale or unknown prompt id is ignored.
   */
  function answer(tabId, promptId, choice) {
    const queue = queues.get(tabId);
    const entry = queue?.current;
    if (!entry || entry.id !== promptId) return false;
    queue.current = null;
    /** @type {"allow" | "block" | "dismiss" | { share: { id: string, name: string } }} */
    let result = "dismiss";
    if (entry.system) {
      result = "dismiss";
    } else if (entry.kinds[0] === "screen") {
      const share = choice && typeof choice === "object" ? choice.share : null;
      result = share && typeof share.id === "string" && share.id ? { share: { id: share.id, name: String(share.name ?? "").slice(0, 200) } } : "dismiss";
    } else if (choice === "allow" || choice === "block") {
      store.remember(entry.origin, entry.kinds, choice);
      result = choice;
      onChange();
    }
    settle(entry, result);
    next(tabId);
    return true;
  }

  async function request(webContents, permission, details) {
    const kinds = requestedSiteKinds(permission, details);
    if (!kinds || kinds.length === 0) return false;
    const tab = eligibleTab(webContents);
    if (!tab) return false;
    const origin = pageOrigin(webContents, details?.requestingUrl ?? details?.securityOrigin);
    if (!origin) return false;
    if (kinds[0] === "screen") {
      // Only right after this page called getDisplayMedia: a page using the old
      // chromeMediaSource constraint would otherwise get the whole screen.
      const intent = intents.get(webContents.id);
      intents.delete(webContents.id);
      if (!intent || intent.origin !== origin || now() - intent.at > SCREEN_INTENT_MS) return false;
      const picked = await enqueue(tab.tabId, { origin, kinds: ["screen"] });
      if (!picked || typeof picked !== "object" || !picked.share) return false;
      picks.set(webContents.id, { origin, source: picked.share, at: now() });
      return true;
    }
    if (kinds.some((kind) => store.decision(origin, kind) === "block")) return false;
    const open = kinds.filter((kind) => store.decision(origin, kind) !== "allow");
    if (open.length > 0) {
      const choice = await enqueue(tab.tabId, { origin, kinds: open });
      if (choice !== "allow") return false;
    }
    const devices = kinds.filter((kind) => kind === "camera" || kind === "microphone");
    if (devices.length > 0 && !(await systemAccess(devices).catch(() => false))) {
      // The computer itself blocks the app: say where to turn it on, once per site.
      const queue = queues.get(tab.tabId);
      const shown = [queue?.current, ...(queue?.waiting ?? [])].some((entry) => entry?.system && entry.origin === origin);
      if (!shown) void enqueue(tab.tabId, { origin, kinds: devices, system: true });
      return false;
    }
    return true;
  }

  /** A permission check (synchronous): true only for a remembered "allow" in the person's own tab. */
  function check(webContents, permission, requestingOrigin, details) {
    const kinds = checkedSiteKinds(permission, details);
    if (!kinds) return false;
    if (!enabled()) return false;
    if (!webContents) {
      // A site's service worker showing a notification: that site's own choice.
      return kinds.length === 1 && kinds[0] === "notifications"
        && store.decision(sitePermissionOrigin(requestingOrigin), "notifications") === "allow";
    }
    if (!eligibleTab(webContents)) return false;
    const origin = pageOrigin(webContents, requestingOrigin);
    return Boolean(origin) && kinds.every((kind) => store.decision(origin, kind) === "allow");
  }

  /** setDisplayMediaRequestHandler: the source the person picked for this page, used once. */
  function displayMedia(request) {
    const contents = request?.frame ? contentsForFrame(request.frame) : null;
    if (!contents || typeof contents.id !== "number") return {};
    const pick = picks.get(contents.id);
    picks.delete(contents.id);
    if (!pick || now() - pick.at > SCREEN_PICK_MS || !eligibleTab(contents)) return {};
    if (sitePermissionOrigin(request.securityOrigin) !== pick.origin || pageOrigin(contents, pick.origin) !== pick.origin) return {};
    return { video: { id: pick.source.id, name: pick.source.name } };
  }

  /** The page world says getDisplayMedia is next (browser-content-preload.cjs). */
  function noteScreenIntent(webContents, frameOrigin) {
    if (!eligibleTab(webContents)) return false;
    const origin = pageOrigin(webContents, frameOrigin);
    if (!origin) return false;
    intents.set(webContents.id, { origin, at: now() });
    return true;
  }

  /**
   * What a frame's page world may report before it asks: "ask", "allow" or
   * "block" per kind. null for every frame that can never ask (an agent's tab,
   * another site's frame, or Work's calls and alerts off).
   */
  function frameState(webContents, frameOrigin) {
    if (!eligibleTab(webContents)) return null;
    const origin = pageOrigin(webContents, frameOrigin);
    if (!origin) return null;
    return { camera: stateOf(origin, "camera"), microphone: stateOf(origin, "microphone"), notifications: stateOf(origin, "notifications") };
  }

  /** A tab closed or left its page: its questions are answered "no". */
  function cancelTab(tabId) {
    const queue = queues.get(tabId);
    if (!queue) return;
    queues.delete(tabId);
    if (queue.current) settle(queue.current, "dismiss");
    for (const entry of queue.waiting) settle(entry, "dismiss");
    show(tabId, null);
  }

  function cancelAll() {
    for (const tabId of [...queues.keys()]) cancelTab(tabId);
    intents.clear();
    picks.clear();
  }

  function forgetContents(contentsId) {
    intents.delete(contentsId);
    picks.delete(contentsId);
  }

  return {
    request,
    check,
    displayMedia,
    answer,
    noteScreenIntent,
    frameState,
    cancelTab,
    cancelAll,
    forgetContents,
    /** The current question for a tab, if any. */
    promptFor: (tabId) => {
      const current = queues.get(tabId)?.current;
      return current ? { id: current.id, origin: current.origin, kinds: [...current.kinds], ...(current.system ? { system: true } : {}) } : null;
    },
    list: () => store.list(),
    forget(origin) {
      const removed = store.forget(origin);
      if (removed) onChange();
      return removed;
    },
    clear() {
      cancelAll();
      store.clear();
      onChange();
    },
  };
}
