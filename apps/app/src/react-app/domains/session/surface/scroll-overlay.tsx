import { memo, useCallback } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { t } from "@/i18n";

import {
  selectSessionIsStickyBottom,
  selectSessionTopClippedMessageId,
  useSessionScrollStore,
} from "./scroll-store";

function useSessionScrollOverlayState(sessionId: string) {
  const isAtBottom = useSessionScrollStore((state) => selectSessionIsStickyBottom(state.sessions, sessionId));
  const topClippedMessageId = useSessionScrollStore((state) => selectSessionTopClippedMessageId(state.sessions, sessionId));

  return { isAtBottom, topClippedMessageId };
}

type JumpToStartButtonProps = {
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

const JumpToStartButton = memo(function JumpToStartButton({
  onJumpToStartOfMessage,
}: JumpToStartButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToStartOfMessage("smooth");
  }, [onJumpToStartOfMessage]);

  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover @max-[34rem]/chatpane:p-1.5"
      onClick={handleClick}
      aria-label={t("scroll.jump_to_start")}
      title={t("scroll.jump_to_start")}
    >
      <ArrowUp className="hidden size-4 @max-[34rem]/chatpane:block" aria-hidden="true" />
      <span className="@max-[34rem]/chatpane:hidden">Jump to start</span>
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
      className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover @max-[34rem]/chatpane:p-1.5"
      onClick={handleClick}
      aria-label={t("scroll.jump_to_latest")}
      title={t("scroll.jump_to_latest")}
    >
      <ArrowDown className="hidden size-4 @max-[34rem]/chatpane:block" aria-hidden="true" />
      <span className="@max-[34rem]/chatpane:hidden">Jump to latest</span>
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
  sessionId,
  isStreaming,
  onJumpToLatest,
  onJumpToStartOfMessage,
}: SessionScrollOverlayProps) {
  const { isAtBottom, topClippedMessageId } = useSessionScrollOverlayState(sessionId);
  const showJumpToStart = !isStreaming && Boolean(topClippedMessageId);
  const showJumpToLatest = !isAtBottom;

  if (!showJumpToStart && !showJumpToLatest) {
    return null;
  }

  return (
    // Narrow chat (under 34rem): small round buttons at the bottom right, clear of the text column.
    <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center @max-[34rem]/chatpane:left-auto @max-[34rem]/chatpane:right-3 @max-[34rem]/chatpane:translate-x-0">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface p-1 shadow-(--dls-card-shadow) @max-[34rem]/chatpane:gap-1">
        {showJumpToStart ? (
          <JumpToStartButton onJumpToStartOfMessage={onJumpToStartOfMessage} />
        ) : null}
        {showJumpToLatest ? (
          <JumpToLatestButton onJumpToLatest={onJumpToLatest} />
        ) : null}
      </div>
    </div>
  );
});
