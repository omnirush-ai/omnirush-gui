// Sponsored placements, renderer side. The Electron main process decides
// (apps/desktop/electron/placements-desktop.mjs and the shared
// placements/placements.mjs): it answers a placement to draw or null (none,
// switched off, offline, any error) with its display id, counts it, and
// opens its link after a click. Here: the home display (the main process
// keeps it until a new conversation or 30 idle minutes), the turn line once
// per session, the dismissals of this run, and each display's events:
// rendered (first painted), viewable (placement-viewability.ts), click and
// dismiss, once per display. Nothing here is awaited on the way to the first
// screen, and nothing here touches a session's messages.

import { create } from "zustand";

import type { OmniRushPlacement, OmniRushPlacementAction, OmniRushPlacementSlot, OmniRushPlacementSurface } from "@omnirush/types/desktop-ipc";

import { omnirushPlacement, omnirushPlacementAction } from "./desktop";

export type Placement = OmniRushPlacement;

const SLOTS: readonly OmniRushPlacementSlot[] = ["home_banner", "turn_footer"];
const SURFACE: Record<OmniRushPlacementSlot, OmniRushPlacementSurface> = { home_banner: "desktop_home", turn_footer: "desktop_turn" };
const DISPLAY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Activity is reported at most this often (the main process only needs it for the 30-minute idle rule). */
export const ACTIVITY_EVERY_MS = 60_000;

/** Copy limits (the shared module clamps them already; checked again here). */
export const PLACEMENT_LIMITS = { sponsor: 40, title: 60, body: 140, ctaLabel: 20 } as const;

function shortText(value: unknown, max: number): value is string {
  return typeof value === "string" && Array.from(value).length <= max;
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** What the main process sent, if it is a placement this window may draw. */
export function asPlacement(value: unknown): Placement | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id || !SLOTS.includes(p.slot as OmniRushPlacementSlot)) return null;
  if (typeof p.displayId !== "string" || !DISPLAY_ID_RE.test(p.displayId)) return null;
  if (p.surface !== SURFACE[p.slot as OmniRushPlacementSlot]) return null;
  if (!shortText(p.sponsor, PLACEMENT_LIMITS.sponsor) || !p.sponsor) return null;
  if (!shortText(p.title, PLACEMENT_LIMITS.title) || !p.title) return null;
  if (!shortText(p.body, PLACEMENT_LIMITS.body) || !shortText(p.ctaLabel, PLACEMENT_LIMITS.ctaLabel) || !p.ctaLabel) return null;
  if (!httpsUrl(p.url)) return null;
  if (p.imageUrl !== null && !httpsUrl(p.imageUrl)) return null;
  // Older main processes send no domain: the link's host (never shown as a link).
  const domain = typeof p.domain === "string" && p.domain ? p.domain : new URL(p.url).hostname.replace(/^www\./, "");
  return {
    id: p.id,
    displayId: p.displayId,
    surface: p.surface as OmniRushPlacementSurface,
    slot: p.slot as OmniRushPlacementSlot,
    label: `Sponsored · ${p.sponsor}`,
    sponsor: p.sponsor,
    title: p.title,
    body: p.body,
    ctaLabel: p.ctaLabel,
    url: p.url,
    imageUrl: (p.imageUrl as string | null) ?? null,
    domain: domain.slice(0, 253),
    snoozeDays: typeof p.snoozeDays === "number" ? p.snoozeDays : 7,
  };
}

type PlacementsState = {
  /** undefined: not asked yet this run; null: nothing to show. */
  home: Placement | null | undefined;
  /** The turn line per session (null: asked, nothing; or it went away). */
  footers: Record<string, Placement | null>;
  setHome: (home: Placement | null) => void;
  setFooter: (sessionId: string, placement: Placement | null) => void;
  hide: (id: string) => void;
};

export const usePlacementsStore = create<PlacementsState>((set) => ({
  home: undefined,
  footers: {},
  setHome: (home) => set({ home }),
  setFooter: (sessionId, placement) => set((state) => ({ footers: { ...state.footers, [sessionId]: placement } })),
  hide: (id) => set((state) => ({
    home: state.home && state.home.id === id ? null : state.home,
    footers: Object.fromEntries(Object.entries(state.footers).map(([sid, p]) => [sid, p?.id === id ? null : p])),
  })),
}));

type Bridge = {
  placement: (input: { slot: OmniRushPlacementSlot; sessionId?: string }) => Promise<unknown>;
  action: (input: { action: OmniRushPlacementAction; id?: string; displayId?: string; sessionId?: string }) => Promise<unknown>;
};

let bridge: Bridge = {
  placement: (input) => omnirushPlacement(input),
  action: (input) => omnirushPlacementAction(input),
};

/** Tests: a stand-in for the main process, and a fresh run. */
export function setPlacementsBridgeForTests(next: Bridge | null): void {
  if (next) bridge = next;
  homeAsk = null;
  sent.clear();
  homeCards = 0;
  lastActivity = 0;
  lastConversation = null;
  usePlacementsStore.setState({ home: undefined, footers: {} });
}

let homeAsk: Promise<Placement | null> | null = null;

/**
 * The home display: asked whenever the home card mounts or the window comes
 * back; the main process answers the same display (same id) until a new
 * conversation or 30 idle minutes, so asking again never counts it again.
 */
export function loadHomePlacement(): Promise<Placement | null> {
  if (homeAsk) return homeAsk;
  homeAsk = Promise.resolve()
    .then(() => bridge.placement({ slot: "home_banner" }))
    .then(asPlacement)
    .catch(() => null)
    .then((placement) => {
      const current = usePlacementsStore.getState().home;
      // The same display: the card stays as it is (its timer keeps running).
      if (!(placement && current && current.displayId === placement.displayId)) usePlacementsStore.getState().setHome(placement);
      return placement;
    })
    .finally(() => {
      homeAsk = null;
    });
  return homeAsk;
}

/** The turn line for a session whose turn just finished (asked once per session in this run). */
export async function loadTurnFooter(sessionId: string): Promise<Placement | null> {
  if (!sessionId || sessionId in usePlacementsStore.getState().footers) return null;
  usePlacementsStore.getState().setFooter(sessionId, null);
  const placement = await Promise.resolve()
    .then(() => bridge.placement({ slot: "turn_footer", sessionId }))
    .then(asPlacement)
    .catch(() => null);
  if (placement) usePlacementsStore.getState().setFooter(sessionId, placement);
  return placement;
}

/** The next turn started: the line goes and does not come back for this session. */
export function endTurnFooter(sessionId: string): void {
  const footers = usePlacementsStore.getState().footers;
  if (footers[sessionId]) usePlacementsStore.getState().setFooter(sessionId, null);
}

/** `${displayId}:${kind}` already sent from this window (the main process refuses repeats too). */
const sent = new Set<string>();

function once(placement: Placement, action: "rendered" | "viewable" | "dismiss" | "report"): void {
  const key = `${placement.displayId}:${action}`;
  if (sent.has(key)) return;
  sent.add(key);
  void bridge.action({ action, id: placement.id, displayId: placement.displayId }).catch(() => undefined);
}

/** First painted: once per display. */
export function placementRendered(placement: Placement): void {
  once(placement, "rendered");
}

/** Measured viewable (≥ 50% for one continuous second, focused and visible): once per display. */
export function placementViewable(placement: Placement): void {
  once(placement, "viewable");
}

/** Whether this display was already measured viewable in this window. */
export function placementViewableSent(placement: Placement): boolean {
  return sent.has(`${placement.displayId}:viewable`);
}

/** The click: the main process opens the link in the system browser (one click event per display). */
export function openPlacement(placement: Placement): void {
  void bridge.action({ action: "open", id: placement.id, displayId: placement.displayId }).catch(() => undefined);
}

/** "Report ad": counted, then hidden like ×. */
export function reportPlacement(placement: Placement): void {
  usePlacementsStore.getState().hide(placement.id);
  once(placement, "report");
}

/** "Why am I seeing this": the main process opens the public measurement page. */
export function explainPlacement(): void {
  void bridge.action({ action: "why" }).catch(() => undefined);
}

/** ×: hidden for its snooze days. */
export function dismissPlacement(placement: Placement): void {
  usePlacementsStore.getState().hide(placement.id);
  once(placement, "dismiss");
}

let lastActivity = 0;
let lastConversation: string | null = null;

/** Home cards on screen now: a due rotation is asked for only while one is (a display nobody sees is never made). */
let homeCards = 0;

/** The home card mounted; resolves the unmount. */
export function homeCardMounted(): () => void {
  homeCards += 1;
  return () => {
    homeCards = Math.max(0, homeCards - 1);
  };
}

function rotateIfDue(answer: unknown): void {
  if (homeCards > 0 && answer && typeof answer === "object" && (answer as { rotate?: unknown }).rotate === true) void loadHomePlacement();
}

let activityInstalled = false;

/** Key presses and clicks anywhere in the window count as activity (installed once). */
export function installPlacementActivity(target: Pick<Window, "addEventListener"> | null = typeof window === "undefined" ? null : window): void {
  if (activityInstalled || !target) return;
  activityInstalled = true;
  const onInput = () => placementActivity();
  target.addEventListener("keydown", onInput, { capture: true, passive: true });
  target.addEventListener("pointerdown", onInput, { capture: true, passive: true });
}

/** The user typed or clicked (at most once a minute): the main process's 30-minute idle rule. */
export function placementActivity(now = Date.now()): void {
  if (now - lastActivity < ACTIVITY_EVERY_MS) return;
  lastActivity = now;
  void Promise.resolve().then(() => bridge.action({ action: "activity" })).then(rotateIfDue, () => undefined);
}

/** A turn started in `sessionId`: a different conversation than last time means a new home display next. */
export function placementConversation(sessionId: string): void {
  if (!sessionId || sessionId === lastConversation) return;
  lastConversation = sessionId;
  lastActivity = Date.now();
  void Promise.resolve().then(() => bridge.action({ action: "conversation", sessionId })).then(rotateIfDue, () => undefined);
}

/** Whether a turn just finished: this session was running and is not any more. */
export function turnJustFinished(previous: { sessionId: string; running: boolean }, current: { sessionId: string; running: boolean }): boolean {
  return previous.sessionId === current.sessionId && previous.running && !current.running;
}
