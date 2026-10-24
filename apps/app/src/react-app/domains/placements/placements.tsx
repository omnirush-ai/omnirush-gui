/** @jsxImportSource react */
// Sponsored placements (app/lib/placements.ts): one card on the home /
// new-chat screen and one in the transcript after a finished turn, once per
// session. Always labelled (the sponsor and a "Sponsored" badge); plain text,
// the theme's own colours, no motion, no sound, no toast. The link opens in
// the system browser only on a click; × or "Hide this ad" hides it for the
// placement's snooze days; "…" also has "Why am I seeing this?" (the public
// measurement page) and "Report ad".
// Nothing renders while the main process has no placement to show.
//
// Each display reports rendered when first painted and viewable once it has
// been ≥ 50% on screen for one continuous second with the window focused and
// visible (placement-viewability.ts); both once per display id.

import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUpRight, Ellipsis, EyeOff, Flag, Info, X } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import {
  dismissPlacement,
  endTurnFooter,
  explainPlacement,
  homeCardMounted,
  installPlacementActivity,
  loadHomePlacement,
  loadTurnFooter,
  openPlacement,
  placementConversation,
  placementRendered,
  placementViewable,
  placementViewableSent,
  reportPlacement,
  turnJustFinished,
  usePlacementsStore,
  type Placement,
} from "../../../app/lib/placements";
import { observeViewability, trackPlacementWindow } from "../../../app/lib/placement-viewability";

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
      className={ICON_BUTTON}
      data-testid={props.testId}
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  );
}

const ICON_BUTTON = "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The sponsor's logo (an https image the server allows), else its first letter. */
function SponsorMark(props: { placement: Placement; testId: string }) {
  const [broken, setBroken] = useState(false);
  if (props.placement.imageUrl && !broken) {
    return (
      <img
        src={props.placement.imageUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="size-5 shrink-0 rounded object-cover"
        data-testid={`${props.testId}-image`}
      />
    );
  }
  return (
    <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold text-muted-foreground" data-testid={`${props.testId}-letter`}>
      {Array.from(props.placement.sponsor)[0]?.toUpperCase()}
    </span>
  );
}

/** "…": hide, why am I seeing this, report. */
function PlacementMenu(props: { placement: Placement; testId: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" aria-label="Sponsored message options" className={ICON_BUTTON} data-testid={`${props.testId}-menu`}>
            <Ellipsis className="size-3.5" aria-hidden="true" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem onClick={() => dismissPlacement(props.placement)}><EyeOff />Hide this ad</DropdownMenuItem>
        <DropdownMenuItem onClick={() => explainPlacement()}><Info />Why am I seeing this?</DropdownMenuItem>
        <DropdownMenuItem onClick={() => reportPlacement(props.placement)}><Flag />Report ad</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The card (home screen and in the transcript after a finished turn): the
 * sponsor's mark and name, a "Sponsored" badge, "…" and ×, then the title,
 * the body, the call to action and the advertiser's domain. The theme's own
 * colours (light and dark), no motion.
 */
function PlacementCard(props: { placement: Placement; testId: string; measureRef: RefObject<HTMLElement | null> }) {
  const { placement, testId } = props;
  return (
    <aside
      ref={props.measureRef}
      aria-label={placement.label}
      data-testid={testId}
      data-placement-id={placement.id}
      data-display-id={placement.displayId}
      className="rounded-xl border border-border bg-card px-3.5 py-3 text-card-foreground"
    >
      <div className="flex items-center gap-2">
        <SponsorMark placement={placement} testId={testId} />
        <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground" data-testid={`${testId}-sponsor`}>{placement.sponsor}</span>
        <span className="rounded border border-border px-1.5 text-[10px] font-medium leading-4 text-muted-foreground" data-testid={`${testId}-label`}>Sponsored</span>
        <span className="flex-1" />
        <PlacementMenu placement={placement} testId={testId} />
        <DismissButton placement={placement} testId={`${testId}-dismiss`} />
      </div>
      <div className="mt-1.5 text-[13.5px] font-semibold leading-5 text-foreground" data-testid={`${testId}-title`}>{placement.title}</div>
      {placement.body ? (
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-muted-foreground" data-testid={`${testId}-body`}>{placement.body}</p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => openPlacement(placement)}
          className="inline-flex h-7 shrink-0 items-center rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          data-testid={`${testId}-cta`}
        >
          {placement.ctaLabel}
        </button>
        {placement.domain ? (
          <button
            type="button"
            onClick={() => openPlacement(placement)}
            aria-label={`Open ${placement.domain}`}
            className="inline-flex min-w-0 items-center gap-0.5 rounded text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testId}-domain`}
          >
            <span className="truncate">{placement.domain}</span>
            <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </aside>
  );
}

/** The home / new-chat card: under the composer and the suggestions. */
export function PlacementHomeCard() {
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

/** The home card itself (tests render it directly). */
export function PlacementHomeCardView({ placement }: { placement: Placement }) {
  const ref = useRef<HTMLElement | null>(null);
  useDisplayMeasurement(ref, placement);
  return <PlacementCard placement={placement} testId="placement-home" measureRef={ref} />;
}

/**
 * The card in the transcript after a finished turn (the server's turn_inline
 * or turn_footer entry): asked on the running → done edge of this session's
 * turn, so it never interrupts a stream; gone when the next turn starts; once
 * per session (the main process remembers it across runs too).
 */
export function PlacementTurnFooter(props: { sessionId: string; turnRunning: boolean }) {
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

/** The card in the transcript, under the last answer (tests render it directly). */
export function PlacementTurnFooterView({ placement }: { placement: Placement }) {
  const ref = useRef<HTMLElement | null>(null);
  useDisplayMeasurement(ref, placement);
  return (
    <div className="not-prose mt-3 px-2 md:px-10">
      <PlacementCard placement={placement} testId="placement-turn-footer" measureRef={ref} />
    </div>
  );
}
