import { memo, useCallback, useEffect, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import {
  selectSessionIsStickyBottom,
  useSessionScrollStore,
} from "./scroll-store";

/** Past this many pixels from the top, the chat offers the up arrow. */
const AWAY_FROM_TOP_PX = 48;

function useSessionScrollOverlayState(sessionId: string) {
  const isAtBottom = useSessionScrollStore((state) => selectSessionIsStickyBottom(state.sessions, sessionId));

  return { isAtBottom };
}

/**
 * Whether the transcript is scrolled away from its top, from its own scroll
 * position. Scroll events do not bubble, so they are caught on the way down
 * (capture) and matched against whichever element the ref holds now: the
 * scroller can be replaced (a session switch) while this overlay stays.
 */
function useAwayFromTop(sessionId: string, scrollRef: RefObject<HTMLElement | null>) {
  const [awayFromTop, setAwayFromTop] = useState(false);
  useEffect(() => {
    const read = () => {
      const container = scrollRef.current;
      setAwayFromTop(Boolean(container && container.scrollTop > AWAY_FROM_TOP_PX));
    };
    const onScroll = (event: Event) => {
      if (event.target === scrollRef.current) read();
    };
    read();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [sessionId, scrollRef]);
  return awayFromTop;
}

/** A round arrow button, as Codex's "jump to latest": the label is its tooltip and accessible name. */
const JUMP_BUTTON_CLASS =
  "pointer-events-auto flex size-8 items-center justify-center rounded-full border border-dls-border bg-dls-surface/95 text-dls-text shadow-(--dls-card-shadow) backdrop-blur-md transition-colors hover:bg-dls-hover";

type JumpToTopButtonProps = {
  onJumpToTop: (behavior?: ScrollBehavior) => void;
};

const JumpToTopButton = memo(function JumpToTopButton({
  onJumpToTop,
}: JumpToTopButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToTop("smooth");
  }, [onJumpToTop]);

  return (
    <button type="button" className={JUMP_BUTTON_CLASS} aria-label="Jump to top" title="Jump to top" onClick={handleClick}>
      <ArrowUp aria-hidden="true" className="size-4" />
    </button>
  );
});

type JumpToLatestButtonProps = {
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
};

const JumpToLatestButton = memo(function JumpToLatestButton({
  onJumpToLatest,
}: JumpToLatestButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToLatest("smooth");
  }, [onJumpToLatest]);

  return (
    <button type="button" className={JUMP_BUTTON_CLASS} aria-label="Jump to latest" title="Jump to latest" onClick={handleClick}>
      <ArrowDown aria-hidden="true" className="size-4" />
    </button>
  );
});

type SessionScrollOverlayProps = {
  sessionId: string;
  scrollRef: RefObject<HTMLElement | null>;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
  onJumpToTop: (behavior?: ScrollBehavior) => void;
};

export const SessionScrollOverlay = memo(function SessionScrollOverlay({
  sessionId,
  scrollRef,
  onJumpToLatest,
  onJumpToTop,
}: SessionScrollOverlayProps) {
  const { isAtBottom } = useSessionScrollOverlayState(sessionId);
  const showJumpToTop = useAwayFromTop(sessionId, scrollRef);
  const showJumpToLatest = !isAtBottom;

  if (!showJumpToTop && !showJumpToLatest) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
      <div className="flex items-center gap-2">
        {showJumpToTop ? (
          <JumpToTopButton onJumpToTop={onJumpToTop} />
        ) : null}
        {showJumpToLatest ? (
          <JumpToLatestButton onJumpToLatest={onJumpToLatest} />
        ) : null}
      </div>
    </div>
  );
});
