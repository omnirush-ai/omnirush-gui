/** @jsxImportSource react */
// Sponsored placements (app/lib/placements.ts): a slim, quiet card on the
// home / new-chat screen and one dim line after a finished turn, once per
// session. Always labelled "Sponsored · <sponsor>"; plain text, the app's own
// colours, no motion, no sound, no toast. The link opens in the system
// browser only on a click; × hides it for the placement's snooze days.
// Nothing renders while the main process has no placement to show.
//
// Each display reports rendered when first painted and viewable once it has
// been ≥ 50% on screen for one continuous second with the window focused and
// visible (placement-viewability.ts); both once per display id.

import { useEffect, useRef, type RefObject } from "react";
import { ArrowUpRight, X } from "lucide-react";

import {
  dismissPlacement,
  endTurnFooter,
  homeCardMounted,
  installPlacementActivity,
  loadHomePlacement,
  loadTurnFooter,
  openPlacement,
  placementConversation,
  placementRendered,
  placementViewable,
  placementViewableSent,
  turnJustFinished,
  usePlacementsStore,
  type Placement,
} from "../../../app/lib/placements";
import { observeViewability, trackPlacementWindow } from "../../../app/lib/placement-viewability";
import { useEnterpriseFlags } from "@/react-app/domains/work/enterprise-mode";

// The window's focus / minimize / show state from the start, before any card mounts.
trackPlacementWindow();

/** rendered on the first paint, viewable when measured: once per display. */
function useDisplayMeasurement(ref: RefObject<HTMLElement | null>, placement: Placement) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame: number | null = null;
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(() => placementRendered(placement));
    else placementRendered(placement);
    const stop = placementViewableSent(placement) ? () => undefined : observeViewability(element, () => placementViewable(placement));
    return () => {
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      stop();
    };
    // One measurement per display: a new display id starts a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement.displayId]);
}

function DismissButton(props: { placement: Placement; testId: string }) {
  return (
    <button
      type="button"
      aria-label="Hide this sponsored message"
      title={`Hide for ${props.placement.snoozeDays} day${props.placement.snoozeDays === 1 ? "" : "s"}`}
      onClick={() => dismissPlacement(props.placement)}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      data-testid={props.testId}
    >
      <X className="size-3" aria-hidden="true" />
    </button>
  );
}

/** The home / new-chat card: under the composer and the suggestions. Never for a company account (OmniRush Work). */
export function PlacementHomeCard() {
  return useEnterpriseFlags().on ? null : <PlacementHomeCardLive />;
}

function PlacementHomeCardLive() {
  const placement = usePlacementsStore((state) => state.home);
  useEffect(() => {
    installPlacementActivity();
    const unmount = homeCardMounted();
    void loadHomePlacement();
    // Back to the window: the same display, or a new one after 30 idle minutes.
    const back = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void loadHomePlacement();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      unmount();
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
  if (!placement) return null;
  return <PlacementHomeCardView key={placement.displayId} placement={placement} />;
}

/** The card itself (tests render it directly). */
export function PlacementHomeCardView({ placement }: { placement: Placement }) {
  const ref = useRef<HTMLElement | null>(null);
  useDisplayMeasurement(ref, placement);
  return (
    <aside
      ref={ref}
      aria-label={placement.label}
      data-testid="placement-home"
      data-placement-id={placement.id}
      data-display-id={placement.displayId}
      className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2"
    >
      {placement.imageUrl ? (
        <img
          src={placement.imageUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-8 shrink-0 rounded-md object-cover"
          data-testid="placement-home-image"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] leading-4 text-muted-foreground" data-testid="placement-home-label">{placement.label}</div>
        <div className="truncate text-[12.5px] font-medium leading-5 text-foreground" data-testid="placement-home-title">{placement.title}</div>
        {placement.body ? (
          <div className="line-clamp-2 text-[12px] leading-4 text-muted-foreground" data-testid="placement-home-body">{placement.body}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => openPlacement(placement)}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/80 px-2.5 text-[12px] font-medium text-foreground hover:bg-accent"
        data-testid="placement-home-cta"
      >
        {placement.ctaLabel}
        <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
      <DismissButton placement={placement} testId="placement-home-dismiss" />
    </aside>
  );
}

/**
 * The line after a finished turn, above the composer: asked on the running →
 * done edge of this session's turn, gone when the next turn starts, once per
 * session (the main process remembers it across runs too).
 */
export function PlacementTurnFooter(props: { sessionId: string; turnRunning: boolean }) {
  return useEnterpriseFlags().on ? null : <PlacementTurnFooterLive {...props} />;
}

function PlacementTurnFooterLive(props: { sessionId: string; turnRunning: boolean }) {
  const placement = usePlacementsStore((state) => state.footers[props.sessionId] ?? null);
  const previous = useRef({ sessionId: props.sessionId, running: props.turnRunning });
  useEffect(() => {
    const before = previous.current;
    const now = { sessionId: props.sessionId, running: props.turnRunning };
    previous.current = now;
    if (props.turnRunning) {
      installPlacementActivity();
      // A turn in this conversation: the home card's next display may be a new one.
      placementConversation(props.sessionId);
      endTurnFooter(props.sessionId);
      return;
    }
    if (turnJustFinished(before, now)) void loadTurnFooter(props.sessionId);
  }, [props.sessionId, props.turnRunning]);
  const visible = Boolean(placement) && !props.turnRunning;
  if (!visible || !placement) return null;
  return <PlacementTurnFooterView key={placement.displayId} placement={placement} />;
}

/** The line itself (tests render it directly). */
export function PlacementTurnFooterView({ placement }: { placement: Placement }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDisplayMeasurement(ref, placement);
  return (
    <div
      ref={ref}
      role="note"
      aria-label={placement.label}
      data-testid="placement-turn-footer"
      data-placement-id={placement.id}
      data-display-id={placement.displayId}
      className="flex items-center gap-2 pb-1 text-[11px] leading-4 text-muted-foreground/80"
    >
      <span className="min-w-0 flex-1 truncate">
        <span>{placement.label}</span>
        <span aria-hidden="true"> — </span>
        <span className="text-muted-foreground">{placement.title}</span>
        {placement.body ? <span> · {placement.body}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => openPlacement(placement)}
        className="inline-flex shrink-0 items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
        data-testid="placement-turn-footer-cta"
      >
        {placement.ctaLabel}
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </button>
      <DismissButton placement={placement} testId="placement-turn-footer-dismiss" />
    </div>
  );
}
