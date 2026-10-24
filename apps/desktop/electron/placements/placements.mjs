// Sponsored placements: at most one quiet line or card on the home screen
// and one dim line after a finished turn. The same file ships in omnirush-cli
// (assets/extensions/omnirush/placements/) and omnirush-gui
// (apps/desktop/electron/placements/); both list it in PARITY.sha256 there.
//
// The server decides everything (GET /client/placements?client&version&os).
// Nothing shows unless it answers `enabled: true` with a usable placement:
// a 404, an error, a timeout (2 s), `enabled: false`, an empty list or a
// malformed answer all mean nothing. The answer is cached in the app's data
// folder and asked again after `refresh_after_s` (at least 15 minutes);
// start-up never waits for it.
//
// Local rules, on top of the server's: a placement's window (starts_at,
// ends_at), `max_per_day` displays per placement and slot per local day, at most
// `max_per_advertiser_per_day` (default 3) displays per `advertiser_id` (else
// per sponsor name) per local day, `snooze_days` after a dismissal, the turn
// slot once per session. Copy is plain text,
// clamped (sponsor 40, title 60, body 140, CTA 20) and always labelled
// "Sponsored · <sponsor>"; links are https only and opened by the app only
// after a click.
//
// Displays: every time a placement is put on screen anew it gets a display
// id, a random UUID made here (never derived from the user, device or
// account). The home slot keeps its display (same placement, same id, nothing
// counted or sent again) until a new conversation starts or after
// `rotate_after_idle_minutes` (default 30) without activity; only then may a
// new display (and a new placement) come.
//
// Events: { display_id, placement_id, kind, surface } and nothing else, at
// most one of each kind per display. Kinds: rendered (drawn), viewable (desktop only:
// the window measured ≥ 50% of the card on screen for one continuous second
// while focused and visible), click, dismiss. Surfaces: desktop_home,
// desktop_turn, cli_home, cli_turn. The CLI never sends viewable. Queued in the
// same file and sent in batches, best effort; a 404 or an answer that says
// placements are off drops them.
//
// Nothing here touches sessions, prompts, files or uploads. Node builtins
// only; the transport (`request`) is the app's own authorized call.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PLACEMENTS_PATH = "/client/placements";
export const EVENTS_PATH = "/client/placements/events";
export const STATE_FILE = "placements.json";
export const SLOTS = Object.freeze(["home_banner", "turn_footer"]);
export const LABEL = "Sponsored";
export const LIMITS = Object.freeze({ id: 64, sponsor: 40, title: 60, body: 140, cta_label: 20 });
export const FETCH_TIMEOUT_MS = 2_000;
export const MIN_REFRESH_S = 900;
export const DEFAULT_REFRESH_S = 3_600;
export const MAX_REFRESH_S = 86_400;
/** A cached answer older than this (no fresh one since) shows nothing. */
export const CACHE_MAX_AGE_MS = 24 * 3_600_000;
export const DEFAULT_SNOOZE_DAYS = 7;
export const MAX_SNOOZE_DAYS = 365;
export const MAX_PER_DAY_LIMIT = 24;
export const EVENT_KINDS = Object.freeze(["rendered", "viewable", "click", "dismiss"]);
/** Where a display was: `${client}_${home|turn}`. */
export const SURFACES = Object.freeze(["desktop_home", "desktop_turn", "cli_home", "cli_turn"]);
/** The surfaces whose displays may be measured viewable (the CLI's never are). */
export const VIEWABLE_SURFACES = Object.freeze(["desktop_home", "desktop_turn"]);
/** The home slot's display changes after this long without activity (or on a new conversation), unless the placement says `rotate_after_idle_minutes`. */
export const ROTATE_IDLE_MS = 30 * 60_000;
/** Displays per advertiser per local day (both slots), unless the placement says `max_per_advertiser_per_day`. */
export const ADVERTISER_DAILY_CAP = 3;
/** Displays remembered (for once-per-display events), the newest. */
export const MAX_DISPLAYS = 300;
export const EVENT_FLUSH_MS = 60_000;
export const MAX_QUEUED_EVENTS = 200;
export const MAX_EVENT_BATCH = 50;
/** Sessions whose turn line was shown, kept this many (newest). */
export const MAX_FOOTER_SESSIONS = 500;
const DAY_MS = 86_400_000;
const STATE_VERSION = 1;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DISPLAY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- copy -------------------------------------------------------------------

// Control characters, bidi overrides and zero-width marks never reach a screen.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Plain one-line text, at most `max` characters (cut with "…"); "" for anything else. */
export function clampText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** An https URL without credentials, else null. */
export function httpsOnly(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function time(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function intIn(value, min, max, fallback) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * One placement from the server, checked and clamped, or null when it is not
 * usable (no id, unknown slot, no sponsor or title, no https link, a window
 * that ends before it starts).
 */
export function parsePlacement(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null;
  const slot = SLOTS.includes(raw.slot) ? raw.slot : null;
  const sponsor = clampText(raw.sponsor, LIMITS.sponsor);
  const title = clampText(raw.title, LIMITS.title);
  const url = httpsOnly(raw.url);
  if (!id || !slot || !sponsor || !title || !url) return null;
  const startsAt = time(raw.starts_at);
  const endsAt = time(raw.ends_at);
  if (raw.starts_at != null && startsAt === null) return null;
  if (raw.ends_at != null && endsAt === null) return null;
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) return null;
  return {
    id,
    slot,
    sponsor,
    label: LABEL,
    title,
    body: clampText(raw.body, LIMITS.body),
    ctaLabel: clampText(raw.cta_label, LIMITS.cta_label) || "Learn more",
    url,
    imageUrl: httpsOnly(raw.image_url),
    startsAt,
    endsAt,
    maxPerDay: intIn(raw.max_per_day, 1, MAX_PER_DAY_LIMIT, 1),
    snoozeDays: intIn(raw.snooze_days, 1, MAX_SNOOZE_DAYS, DEFAULT_SNOOZE_DAYS),
    priority: intIn(raw.priority, -1_000_000, 1_000_000, 0),
    // The frequency cap's key: the server's advertiser id, else the sponsor's name.
    advertiser: advertiserId(raw.advertiser_id) ?? `name:${sponsor.toLowerCase()}`,
    maxPerAdvertiserPerDay: intIn(raw.max_per_advertiser_per_day, 1, MAX_PER_DAY_LIMIT, ADVERTISER_DAILY_CAP),
    rotateAfterIdleMs: intIn(raw.rotate_after_idle_minutes, 1, 1_440, ROTATE_IDLE_MS / 60_000) * 60_000,
  };
}

function advertiserId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return `id:${value}`;
  return typeof value === "string" && ID_RE.test(value) ? `id:${value}` : null;
}

/** The surface of `slot` in `client`: desktop_home, desktop_turn, cli_home or cli_turn. */
export function surfaceOf(client, slot) {
  return `${client === "desktop" ? "desktop" : "cli"}_${slot === "turn_footer" ? "turn" : "home"}`;
}

/**
 * The server's answer: { enabled, refreshAfterS, placements } with only the
 * usable placements, or null when it is not an answer at all. Off unless
 * `enabled` is exactly true.
 */
export function parseAnswer(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const refreshAfterS = intIn(body.refresh_after_s, MIN_REFRESH_S, MAX_REFRESH_S, DEFAULT_REFRESH_S);
  const enabled = body.enabled === true;
  const seen = new Set();
  const placements = [];
  if (enabled && Array.isArray(body.placements)) {
    for (const raw of body.placements.slice(0, 50)) {
      const placement = parsePlacement(raw);
      if (!placement) continue;
      // One id may run in both slots (one entry per slot); per-day count, dismiss and click stay keyed by id.
      const key = `${placement.slot}\n${placement.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      placements.push(placement);
    }
  }
  return { enabled: enabled && placements.length > 0, refreshAfterS, placements };
}

/** "Sponsored · Acme" */
export function sponsoredLabel(placement) {
  return `${LABEL} · ${placement.sponsor}`;
}

/**
 * The placement as one plain line of at most `width` characters:
 * "Sponsored · Acme — Title · body". `suffix` (a hint) is kept whole when it fits.
 */
export function placementLine(placement, { width = 100, suffix = "" } = {}) {
  const head = `${sponsoredLabel(placement)} — ${placement.title}${placement.body ? ` · ${placement.body}` : ""}`;
  const tail = suffix ? `  ${suffix}` : "";
  const room = Math.max(10, Math.floor(width));
  if (Array.from(head + tail).length <= room) return head + tail;
  if (tail && Array.from(tail).length < room - 20) return clampText(head, room - Array.from(tail).length) + tail;
  return clampText(head, room);
}

/** The placement as the apps show it (the UI never sees more), with its display. */
export function placementView(placement, display = null) {
  return {
    id: placement.id,
    displayId: display?.display_id ?? null,
    surface: display?.surface ?? null,
    slot: placement.slot,
    label: sponsoredLabel(placement),
    sponsor: placement.sponsor,
    title: placement.title,
    body: placement.body,
    ctaLabel: placement.ctaLabel,
    url: placement.url,
    imageUrl: placement.imageUrl,
    snoozeDays: placement.snoozeDays,
  };
}

/**
 * The `os` the server targets by: win, mac or linux.
 * @param {string} [platform]
 */
export function osName(platform = process.platform) {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  return "linux";
}

export function placementsQuery({ client, version, os }) {
  const query = new URLSearchParams();
  query.set("client", client === "desktop" ? "desktop" : "cli");
  query.set("version", typeof version === "string" && version ? version.slice(0, 40) : "0");
  query.set("os", ["win", "mac", "linux"].includes(os) ? os : osName());
  return `${PLACEMENTS_PATH}?${query.toString()}`;
}

/** The local calendar day of `ms` (YYYY-MM-DD). */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- state ------------------------------------------------------------------

/** An empty state. */
export function emptyState() {
  return {
    v: STATE_VERSION,
    fetched_at: 0,
    answer: null,
    shown: {},
    snoozed: {},
    hidden_until: 0,
    footer_sessions: [],
    events: [],
    displays: {},
    advertisers: {},
    home_display: null,
    last_active_at: 0,
    rotate_home: false,
    last_conversation: null,
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** The state file, repaired: anything damaged reads as empty. */
export function readState(file) {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  const base = emptyState();
  if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== STATE_VERSION) return base;
  const shown = {};
  for (const [id, entry] of Object.entries(record(data.shown))) {
    const e = record(entry);
    if (typeof e.day === "string" && Number.isFinite(e.count)) shown[id] = { day: e.day, count: Math.max(0, Math.floor(e.count)) };
  }
  const snoozed = {};
  for (const [id, until] of Object.entries(record(data.snoozed))) if (Number.isFinite(until)) snoozed[id] = until;
  const displays = {};
  for (const [displayId, entry] of Object.entries(record(data.displays))) {
    const d = record(entry);
    if (!DISPLAY_ID_RE.test(displayId) || typeof d.id !== "string" || !SLOTS.includes(d.slot) || !SURFACES.includes(d.surface) || !Number.isFinite(d.at)) continue;
    displays[displayId] = { display_id: displayId, id: d.id, slot: d.slot, surface: d.surface, at: d.at, sent: Array.isArray(d.sent) ? d.sent.filter((k) => EVENT_KINDS.includes(k)) : [] };
  }
  const advertisers = {};
  for (const [key, entry] of Object.entries(record(data.advertisers))) {
    const e = record(entry);
    if (typeof e.day === "string" && Number.isFinite(e.count)) advertisers[key] = { day: e.day, count: Math.max(0, Math.floor(e.count)) };
  }
  return {
    ...base,
    fetched_at: Number.isFinite(data.fetched_at) ? data.fetched_at : 0,
    answer: data.answer && typeof data.answer === "object" ? data.answer : null,
    shown,
    snoozed,
    hidden_until: Number.isFinite(data.hidden_until) ? data.hidden_until : 0,
    footer_sessions: Array.isArray(data.footer_sessions) ? data.footer_sessions.filter((s) => typeof s === "string").slice(-MAX_FOOTER_SESSIONS) : [],
    events: Array.isArray(data.events) ? data.events.filter(validEvent).slice(-MAX_QUEUED_EVENTS) : [],
    displays,
    advertisers,
    home_display: typeof data.home_display === "string" && displays[data.home_display]?.slot === "home_banner" ? data.home_display : null,
    last_active_at: Number.isFinite(data.last_active_at) ? data.last_active_at : 0,
    rotate_home: data.rotate_home === true,
    last_conversation: typeof data.last_conversation === "string" ? data.last_conversation.slice(0, 200) : null,
  };
}

/** An event as it is queued and sent: { display_id, placement_id, kind, surface }, nothing else. */
export function validEvent(e) {
  return Boolean(e) && typeof e === "object" && !Array.isArray(e) && Object.keys(e).length === 4
    && typeof e.display_id === "string" && DISPLAY_ID_RE.test(e.display_id)
    && typeof e.placement_id === "string" && ID_RE.test(e.placement_id)
    && EVENT_KINDS.includes(e.kind) && SURFACES.includes(e.surface)
    && (e.kind !== "viewable" || VIEWABLE_SURFACES.includes(e.surface));
}

export function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The cached answer, parsed again (the file may have been edited), or null when absent or too old. */
export function cachedAnswer(state, now) {
  if (!state.answer || !Number.isFinite(state.fetched_at) || state.fetched_at <= 0) return null;
  if (now - state.fetched_at > CACHE_MAX_AGE_MS || state.fetched_at - now > DAY_MS) return null;
  return parseAnswer(state.answer);
}

/** Whether the cached answer is due for a fresh one. */
export function refreshDue(state, now) {
  if (!state.fetched_at) return true;
  const answer = state.answer ? parseAnswer(state.answer) : null;
  const every = (answer?.refreshAfterS ?? DEFAULT_REFRESH_S) * 1000;
  return now - state.fetched_at >= every || state.fetched_at - now > DAY_MS;
}

/** The day's count of a placement is per slot: one id served in both slots has a `max_per_day` in each. */
export const shownKey = (placement) => `${placement.slot}:${placement.id}`;

/** Whether `placement` may show in `slot` now (window, snooze, the day's counts, hidden). */
export function eligible(placement, slot, state, now) {
  if (placement.slot !== slot) return false;
  if (placement.startsAt !== null && now < placement.startsAt) return false;
  if (placement.endsAt !== null && now >= placement.endsAt) return false;
  if (state.hidden_until && now < state.hidden_until) return false;
  const snoozedUntil = state.snoozed[placement.id];
  if (Number.isFinite(snoozedUntil) && now < snoozedUntil) return false;
  const shown = state.shown[shownKey(placement)];
  if (shown && shown.day === localDay(now) && shown.count >= placement.maxPerDay) return false;
  const advertiser = state.advertisers?.[placement.advertiser];
  if (advertiser && advertiser.day === localDay(now) && advertiser.count >= placement.maxPerAdvertiserPerDay) return false;
  return true;
}

/** The placement for `slot` now: the highest priority, then the soonest to end, then the id. */
export function pickPlacement(answer, slot, state, now) {
  if (!answer?.enabled) return null;
  const candidates = answer.placements.filter((p) => eligible(p, slot, state, now));
  candidates.sort((a, b) => b.priority - a.priority || (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates[0] ?? null;
}

// --- the service ----------------------------------------------------------------

const noop = () => undefined;

/**
 * @typedef {{ status: number, data?: any } | null} PlacementsResponse
 * @typedef {(pathAndQuery: string, init: { method?: string, body?: unknown, timeoutMs?: number }) => Promise<PlacementsResponse>} PlacementsRequest
 * @typedef {{
 *   request?: PlacementsRequest | null,
 *   stateFile: string,
 *   client: string,
 *   version?: string,
 *   os?: string,
 *   allowed?: boolean,
 *   now?: () => number,
 *   log?: (level: string, message: string, data?: object) => void,
 *   timeoutMs?: number,
 *   flushMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 *   newDisplayId?: () => string,
 * }} PlacementsOptions
 */

/**
 * The app's placements. `request(pathAndQuery, { method, body, timeoutMs })`
 * resolves { status, data } (data: the parsed JSON or null) or null when
 * signed out, and may throw; it is the app's own authorized call (renewing an
 * expired sign-in). `allowed: false` (headless, no terminal, CI, switched
 * off) never asks the server and never shows anything.
 * @param {PlacementsOptions} options
 */
export function createPlacements({
  request,
  stateFile,
  client,
  version = "",
  os = osName(),
  allowed = true,
  now = Date.now,
  log = noop,
  timeoutMs = FETCH_TIMEOUT_MS,
  flushMs = EVENT_FLUSH_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  newDisplayId = randomUUID,
}) {
  const appClient = client === "desktop" ? "desktop" : "cli";
  let state = allowed ? readState(stateFile) : emptyState();
  let refreshTimer = null;
  let flushTimer = null;
  let inFlight = null;
  let stopped = false;
  let started = false;
  /** This run's turn-slot display (the last one claimed). */
  let footerDisplay = null;
  const footerSessions = new Set(state.footer_sessions);

  const save = () => (allowed ? writeState(stateFile, state) : false);
  const answer = () => cachedAnswer(state, now());
  /** The placement with `id` (in `slot` when given: one id may have an entry per slot). */
  const known = (id, slot = null) => answer()?.placements.find((p) => p.id === id && (!slot || p.slot === slot)) ?? null;
  /** A display by its id, or (older callers) the newest display of a placement id. */
  const displayOf = (ref) => {
    if (typeof ref !== "string" || !ref) return null;
    if (Object.hasOwn(state.displays, ref)) return state.displays[ref];
    let newest = null;
    for (const d of Object.values(state.displays)) if (d.id === ref && (!newest || d.at >= newest.at)) newest = d;
    return newest;
  };

  const schedule = () => {
    if (stopped || !started) return;
    if (refreshTimer) clearTimer(refreshTimer);
    const every = (answer()?.refreshAfterS ?? DEFAULT_REFRESH_S) * 1000;
    const wait = Math.max(MIN_REFRESH_S * 1000, every - Math.max(0, now() - state.fetched_at));
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      void service.refresh().catch(noop).finally(schedule);
    }, wait);
    refreshTimer?.unref?.();
  };

  /** One event for a display, at most once per kind; false when it may not be sent. */
  const queue = (display, kind) => {
    if (!allowed || !display || !EVENT_KINDS.includes(kind) || !answer()?.enabled || !known(display.id, display.slot)) return false;
    if (kind === "viewable" && !VIEWABLE_SURFACES.includes(display.surface)) return false;
    if (display.sent.includes(kind)) return false;
    display.sent.push(kind);
    state.events.push({ display_id: display.display_id, placement_id: display.id, kind, surface: display.surface });
    if (state.events.length > MAX_QUEUED_EVENTS) state.events = state.events.slice(-MAX_QUEUED_EVENTS);
    save();
    if (!flushTimer && !stopped && started) {
      flushTimer = setTimer(() => {
        flushTimer = null;
        void service.flush().catch(noop);
      }, flushMs);
      flushTimer?.unref?.();
    }
    return true;
  };

  /** A new display of `placement` in `slot`: counted for the day (placement and advertiser). */
  const newDisplay = (placement, slot, at) => {
    let displayId = String(newDisplayId()).toLowerCase();
    while (Object.hasOwn(state.displays, displayId)) displayId = String(newDisplayId()).toLowerCase();
    const day = localDay(at);
    const shown = state.shown[shownKey(placement)];
    state.shown[shownKey(placement)] = { day, count: shown && shown.day === day ? shown.count + 1 : 1 };
    const advertiser = state.advertisers[placement.advertiser];
    state.advertisers[placement.advertiser] = { day, count: advertiser && advertiser.day === day ? advertiser.count + 1 : 1 };
    // Old days are forgotten.
    for (const [id, entry] of Object.entries(state.shown)) if (entry.day !== day) delete state.shown[id];
    for (const [key, entry] of Object.entries(state.advertisers)) if (entry.day !== day) delete state.advertisers[key];
    const display = { display_id: displayId, id: placement.id, slot, surface: surfaceOf(appClient, slot), at, sent: [] };
    state.displays[displayId] = display;
    const all = Object.values(state.displays);
    if (all.length > MAX_DISPLAYS) {
      all.sort((a, b) => a.at - b.at);
      for (const old of all.slice(0, all.length - MAX_DISPLAYS)) if (old.display_id !== state.home_display) delete state.displays[old.display_id];
    }
    return display;
  };

  /** How long the home display may sit idle before it changes (its placement's `rotate_after_idle_minutes`). */
  const idleLimit = () => {
    const kept = state.home_display ? state.displays[state.home_display] : null;
    return (kept ? known(kept.id, kept.slot)?.rotateAfterIdleMs : null) ?? ROTATE_IDLE_MS;
  };
  /** Activity: after the idle limit without any, the home display changes when next asked. */
  const touch = (at) => {
    if (state.last_active_at && state.home_display && at - state.last_active_at >= idleLimit()) state.rotate_home = true;
    const changed = at - state.last_active_at >= 60_000 || at < state.last_active_at;
    state.last_active_at = at;
    return changed;
  };

  const service = {
    /** Starts the background refresh (never waited for). */
    start() {
      if (!allowed || started || stopped) return service;
      started = true;
      if (refreshDue(state, now())) void service.refresh().catch(noop).finally(schedule);
      else schedule();
      if (state.events.length) {
        flushTimer = setTimer(() => {
          flushTimer = null;
          void service.flush().catch(noop);
        }, Math.min(flushMs, 5_000));
        flushTimer?.unref?.();
      }
      return service;
    },
    /** Stops the timers and sends what is queued (best effort, bounded by the request timeout). */
    async stop() {
      stopped = true;
      if (refreshTimer) clearTimer(refreshTimer);
      if (flushTimer) clearTimer(flushTimer);
      refreshTimer = null;
      flushTimer = null;
      if (allowed && state.events.length) await service.flush().catch(noop);
    },
    /** Asks the server once; resolves the parsed answer in use afterwards (null: nothing to show). */
    async refresh() {
      if (!allowed || typeof request !== "function") return null;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let result = null;
        try {
          result = await request(placementsQuery({ client, version, os }), { method: "GET", timeoutMs });
        } catch {
          result = null;
        }
        const at = now();
        if (result && result.status === 200) {
          const parsed = parseAnswer(result.data);
          // A malformed answer is an answer that shows nothing.
          state.answer = parsed ? result.data : { enabled: false };
          state.fetched_at = at;
          if (!parsed?.enabled) state.events = [];
          save();
          log("info", "placements refreshed", { enabled: Boolean(parsed?.enabled), count: parsed?.placements.length ?? 0 });
        } else if (result && (result.status === 404 || result.status === 410)) {
          // An older server: nothing, asked again after the default time.
          state.answer = { enabled: false };
          state.fetched_at = at;
          state.events = [];
          save();
        }
        // Signed out, offline, slow, 5xx: the last answer stays (until it is a day old).
        return answer();
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
    /**
     * The placement to show in `slot` with its display, or null.
     * The home slot: the same display (not counted, nothing sent again) until
     * a new conversation or the idle limit without activity; then a new one
     * (or nothing). The turn slot: once per `sessionId`, ever.
     */
    claim(slot, { sessionId = null } = {}) {
      if (!allowed || !SLOTS.includes(slot)) return null;
      const at = now();
      if (slot === "turn_footer") {
        if (typeof sessionId !== "string" || !sessionId || footerSessions.has(sessionId)) return null;
        const placement = pickPlacement(answer(), slot, state, at);
        if (!placement) return null;
        touch(at);
        footerSessions.add(sessionId);
        state.footer_sessions = [...state.footer_sessions.filter((s) => s !== sessionId), sessionId].slice(-MAX_FOOTER_SESSIONS);
        footerDisplay = newDisplay(placement, slot, at).display_id;
        save();
        return placementView(placement, state.displays[footerDisplay]);
      }
      // Idle since the last activity: due for a new display.
      const wasChanged = touch(at);
      const kept = state.home_display ? state.displays[state.home_display] : null;
      if (kept && !state.rotate_home) {
        const placement = known(kept.id, slot);
        if (wasChanged) save();
        return placement && eligibleKept(placement, at) ? placementView(placement, kept) : null;
      }
      const placement = pickPlacement(answer(), slot, state, at);
      if (!placement) {
        // Due for a change with nothing to show: the old display is over.
        if (kept) {
          state.home_display = null;
          state.rotate_home = false;
        }
        if (wasChanged || kept) save();
        return null;
      }
      state.rotate_home = false;
      state.home_display = newDisplay(placement, slot, at).display_id;
      save();
      return placementView(placement, state.displays[state.home_display]);
    },
    /** The display shown in `slot` now (not counted again), or null. */
    current(slot) {
      const displayId = slot === "home_banner" ? state.home_display : slot === "turn_footer" ? footerDisplay : null;
      const display = displayId ? state.displays[displayId] : null;
      const placement = display ? known(display.id, slot) : null;
      return placement && eligibleKept(placement, now()) ? placementView(placement, display) : null;
    },
    /**
     * A conversation started or was picked up (any opaque local id, never
     * sent): a different one than last time means the home slot's next ask is
     * a new display.
     */
    conversation(conversationId) {
      if (!allowed || typeof conversationId !== "string" || !conversationId) return false;
      const at = now();
      touch(at);
      const id = conversationId.slice(0, 200);
      const changed = id !== state.last_conversation;
      if (changed) {
        state.last_conversation = id;
        if (state.home_display) state.rotate_home = true;
      }
      save();
      return changed;
    },
    /** The user did something (typed, clicked); resolves whether the home display is due for a change. */
    activity() {
      if (!allowed) return false;
      if (touch(now())) save();
      return state.rotate_home;
    },
    /** It was drawn on screen (once per display). */
    rendered(ref) {
      return queue(displayOf(ref), "rendered");
    },
    /** Older name for rendered. */
    impression(ref) {
      return service.rendered(ref);
    },
    /** The window measured it viewable (desktop surfaces only, once per display). */
    viewable(ref) {
      return queue(displayOf(ref), "viewable");
    },
    /** The click: its https link (the app opens it) or null; one click event per display. */
    click(ref) {
      const display = displayOf(ref);
      const placement = display ? known(display.id, display.slot) : null;
      if (!placement) return null;
      queue(display, "click");
      touch(now());
      return placement.url;
    },
    /** × / hide: snoozed for its `snooze_days`; the slot stays empty until its next display. */
    dismiss(ref) {
      const display = displayOf(ref);
      const placement = display ? known(display.id, display.slot) : null;
      if (!allowed || !placement) return false;
      queue(display, "dismiss");
      state.snoozed[placement.id] = now() + placement.snoozeDays * DAY_MS;
      save();
      return true;
    },
    /** Hides every placement for `days` (0 shows them again). */
    hideAll(days = 30) {
      const n = intIn(days, 0, MAX_SNOOZE_DAYS, 30);
      state.hidden_until = n > 0 ? now() + n * DAY_MS : 0;
      return save() || !allowed;
    },
    /** What `omnirush placements` prints. */
    status() {
      const current = answer();
      return {
        allowed,
        enabled: Boolean(current?.enabled),
        count: current?.placements.length ?? 0,
        fetchedAt: state.fetched_at || null,
        hiddenUntil: state.hidden_until && state.hidden_until > now() ? state.hidden_until : null,
        snoozed: Object.values(state.snoozed).filter((until) => until > now()).length,
        queued: state.events.length,
      };
    },
    /** Sends the queued events (at most MAX_EVENT_BATCH per request). */
    async flush() {
      if (!allowed || typeof request !== "function" || !state.events.length) return 0;
      if (!answer()?.enabled) {
        state.events = [];
        save();
        return 0;
      }
      let sent = 0;
      while (state.events.length) {
        const batch = state.events.slice(0, MAX_EVENT_BATCH);
        let result = null;
        try {
          result = await request(`${EVENTS_PATH}?client=${appClient}`, { method: "POST", body: { events: batch }, timeoutMs });
        } catch {
          result = null;
        }
        if (!result) break;
        if (result.status >= 200 && result.status < 300) {
          state.events = state.events.slice(batch.length);
          sent += batch.length;
          save();
          continue;
        }
        if (result.status >= 400 && result.status < 500 && result.status !== 401 && result.status !== 408 && result.status !== 429) {
          // Refused (no route, off, bad batch): dropped, never retried.
          state.events = [];
          save();
        }
        break;
      }
      return sent;
    },
    /** Tests and the status command. */
    state: () => state,
  };

  // A display kept on screen stays while its window, snooze and hide allow it.
  function eligibleKept(placement, at) {
    if (!answer()?.enabled) return false;
    if (placement.endsAt !== null && at >= placement.endsAt) return false;
    if (state.hidden_until && at < state.hidden_until) return false;
    const snoozedUntil = state.snoozed[placement.id];
    return !(Number.isFinite(snoozedUntil) && at < snoozedUntil);
  }

  return service;
}
