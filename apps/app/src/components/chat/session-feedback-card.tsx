import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SessionRating = "positive" | "negative";

export type SessionFeedbackCardProps = {
  sessionId: string;
  turnCount: number;
};

/**
 * A small, explicit end-of-session rating. The chat cannot infer that an
 * assistant turn is the user's final turn, so SessionSurface only mounts this
 * after the user presses Finish session. Ratings use the existing anonymous
 * analytics queue; no transcript or project content is sent.
 */
export function SessionFeedbackCard({ sessionId, turnCount }: SessionFeedbackCardProps) {
  const [rating, setRating] = useState<SessionRating | null>(null);
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <div
        className="mx-3 mb-2 rounded-xl border border-dls-border bg-dls-surface/70 px-3 py-2 text-xs text-dls-secondary"
        data-testid="session-feedback-thanks"
        role="status"
      >
        Thanks for the feedback.
      </div>
    );
  }

  const submit = () => {
    if (!rating) return;
    captureAnalyticsEvent("session_feedback", {
      rating,
      session_turns: turnCount,
      session_id_present: Boolean(sessionId),
    });
    setSubmitted(true);
  };

  return (
    <div
      className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-dls-border bg-dls-surface/70 px-3 py-2 text-xs"
      data-testid="session-feedback-card"
      role="group"
      aria-label="Session feedback"
    >
      <span className="mr-auto text-dls-secondary">How was this session?</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Session was helpful"
        aria-pressed={rating === "positive"}
        data-testid="session-feedback-positive"
        className={cn(rating === "positive" && "bg-emerald-3 text-emerald-11")}
        onClick={() => setRating("positive")}
      >
        <ThumbsUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Session needs improvement"
        aria-pressed={rating === "negative"}
        data-testid="session-feedback-negative"
        className={cn(rating === "negative" && "bg-red-3 text-red-11")}
        onClick={() => setRating("negative")}
      >
        <ThumbsDown aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={!rating}
        data-testid="session-feedback-submit"
        onClick={submit}
      >
        Send
      </Button>
    </div>
  );
}
