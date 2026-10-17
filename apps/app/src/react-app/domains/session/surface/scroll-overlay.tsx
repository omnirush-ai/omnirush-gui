import { memo, useCallback } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

type JumpToStartButtonProps = {
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

const JUMP_BUTTON_CLASS =
  "pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full border border-dls-border bg-dls-surface/95 px-2.5 text-[11px] font-medium text-dls-text shadow-(--dls-card-shadow) backdrop-blur-md transition-all hover:bg-dls-hover hover:scale-105 active:scale-95 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-dls-border";

const JumpToStartButton = memo(function JumpToStartButton({
  onJumpToStartOfMessage,
}: JumpToStartButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToStartOfMessage("smooth");
  }, [onJumpToStartOfMessage]);

  return (
    <button
      type="button"
      className={JUMP_BUTTON_CLASS}
      aria-label="Jump to start"
      title="Jump to start"
      data-testid="jump-to-start"
      onClick={handleClick}
    >
      <ArrowUp aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">Jump to start</span>
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
    <button
      type="button"
      className={JUMP_BUTTON_CLASS}
      aria-label="Jump to end"
      title="Jump to end"
      data-testid="jump-to-latest"
      onClick={handleClick}
    >
      <ArrowDown aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">Jump to end</span>
    </button>
  );
});

type SessionScrollOverlayProps = {
  sessionId: string;
  isStreaming: boolean;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

export const SessionScrollOverlay = memo(function SessionScrollOverlay({
  onJumpToLatest,
  onJumpToStartOfMessage,
}: SessionScrollOverlayProps) {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 end-3 z-30 flex flex-col items-end py-3"
      data-testid="session-scroll-rail"
      aria-label="Chat navigation"
    >
      <JumpToStartButton onJumpToStartOfMessage={onJumpToStartOfMessage} />
      <div className="mt-auto">
        <JumpToLatestButton onJumpToLatest={onJumpToLatest} />
      </div>
    </div>
  );
});
