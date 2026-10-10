/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Gift, Lightbulb, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { omnirushAccountStatus, omnirushQualityDetails } from "../../../app/lib/desktop";
import {
  CLIENT_GRADE_NOTE,
  GOOD_SESSION_STAR_LABEL,
  canSpinNow,
  isCoachingNotice,
  qualityTierLabel,
  refreshAccountStatus,
  useAccountQuality,
  useQualityUiStore,
  type AccountQuality,
  type QualityNotice,
} from "../../../app/lib/quality";
import type { OmniRushQualitySession } from "@omnirush/types/desktop-ipc";
import { BiggestWinTicker, NextSpinHint, QualityTierBadge, StreakLine } from "./quality-parts";
import { QualitySpinDialog } from "./quality-spin-dialog";
import { useQualityPopups } from "./use-quality-popups";
import { GoodSessionGuide } from "./good-session";
import { goodSessionWording } from "../../../app/lib/good-session";

/** Used only when the server sends no `fail_labels` entry for a code. */
const FALLBACK_FAIL_LABELS: Record<string, string> = {
  outside_path: "edits outside the project folder",
  home_folder: "started in the home folder",
  wrong_folder: "started in another folder",
  windows_host: "operating system not counted",
  small_fix: "a small fix",
  one_shot: "a one-shot answer",
  non_coding: "not coding work",
  old_client: "old app version",
};

export function failLabel(fail: string, labels: Record<string, string> = {}): string {
  const label = labels[fail] ?? FALLBACK_FAIL_LABELS[fail] ?? fail.replace(/[_-]+/g, " ");
  // Users never read "client" here, not even in a server label: it names the app instead.
  return label.replace(/\bold client\b/gi, "old app version").replace(/\bclient\b/gi, "app");
}

export type QualitySessionReasons = { sessions: OmniRushQualitySession[]; failLabels: Record<string, string> };

function workSummary(work: OmniRushQualitySession["work"]): string | null {
  if (!work) return null;
  const parts = [`${work.codeFiles} code file${work.codeFiles === 1 ? "" : "s"}`, `${work.linesChanged} lines`];
  parts.push(work.testRuns > 0 ? `${work.testRuns} test run${work.testRuns === 1 ? "" : "s"}` : "no tests");
  return parts.join(" · ");
}

/** "See why": each recent session, with what earned spins and what held it back. */
export function SessionReasons({ reasons }: { reasons: QualitySessionReasons | null }) {
  if (reasons === null) return <div className="text-xs text-muted-foreground">Loading your sessions…</div>;
  const { sessions, failLabels } = reasons;
  if (sessions === null) return <div className="text-xs text-muted-foreground">Loading your sessions…</div>;
  if (!sessions.length) return <div className="text-xs text-muted-foreground">No sessions checked yet. They are checked about once an hour.</div>;
  return (
    <>
    <p className="mb-2 text-xs text-muted-foreground" data-testid="quality-client-grade-note">{CLIENT_GRADE_NOTE}</p>
    <ul className="flex flex-col gap-1.5" data-testid="quality-session-reasons">
      {sessions.slice(0, 6).map((session) => (
        <li key={session.sessionId} className="rounded-lg border border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{session.workspace ?? "session"}</span>
            {session.spins > 0 ? (
              <span className="shrink-0 font-medium text-foreground">+{session.spins} spin{session.spins === 1 ? "" : "s"}</span>
            ) : null}
          </div>
          {session.why ? <div className="mt-0.5 text-xs leading-5 text-foreground">{goodSessionWording(session.why)}</div> : null}
          {workSummary(session.work) ? <div className="mt-0.5 text-[11px] text-muted-foreground">{workSummary(session.work)}</div> : null}
          {session.fails.length || session.reproducible === "pass" || session.clientGrade ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {session.clientGrade ? (
                <Badge variant="secondary" data-testid="quality-client-grade" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">{GOOD_SESSION_STAR_LABEL}</Badge>
              ) : session.reproducible === "pass" ? (
                <Badge variant="secondary" data-testid="quality-reproducible" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">Reproducible ✓</Badge>
              ) : null}
              {session.fails.map((fail) => (
                <Badge key={fail} variant="outline" data-fail={fail} className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
                  {failLabel(fail, failLabels)}
                </Badge>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
    </>
  );
}

export type QualityNoticeCardProps = {
  quality: AccountQuality;
  /** The notice to announce; null when the user opened the panel from the sidebar. */
  notice: QualityNotice | null;
  onSpin: () => void;
  onDismiss: () => void;
  /** GET /me/quality sessions (and fail labels) for "see why"; fetched when first opened. */
  loadSessions?: () => Promise<QualitySessionReasons | null>;
};

/** The app's toast surface: popover colours, a hairline border, small radius. */
const TOAST_SURFACE =
  "rounded-2xl border border-border bg-popover/95 text-popover-foreground shadow-md ring-1 ring-popover-border/20 backdrop-blur-sm";

/**
 * The quality popup, in the app's toast style: fixed over the app, with the
 * notice, the tips and, when spins are ready, a Spin button. Coaching reads
 * as "here is how to get spins", never as a penalty.
 */
export function QualityNoticeCard(props: QualityNoticeCardProps) {
  const { quality, notice } = props;
  const coaching = isCoachingNotice(notice, quality);
  const [whyOpen, setWhyOpen] = useState(false);
  const [sessions, setSessions] = useState<QualitySessionReasons | null>(null);
  const title = goodSessionWording(notice?.title ?? `Quality: ${qualityTierLabel(quality.tier)}`);
  const body = goodSessionWording(notice?.body || (notice ? "" : quality.nextTierHint ?? ""));
  const spinnable = canSpinNow(quality);
  const Icon = coaching ? Lightbulb : Gift;

  const toggleWhy = () => {
    setWhyOpen((open) => !open);
    if (sessions === null && props.loadSessions) {
      const none = { sessions: [], failLabels: {} };
      void props.loadSessions().then((next) => setSessions(next ?? none)).catch(() => setSessions(none));
    }
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      data-testid="quality-notice"
      data-notice-id={notice?.id ?? undefined}
      data-coaching={coaching ? "" : undefined}
      className={cn("fixed bottom-4 right-4 z-[65] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-3 p-4", TOAST_SURFACE)}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="text-sm font-medium" data-testid="quality-notice-title">{title}</p>
            <QualityTierBadge quality={quality} />
          </div>
          {body ? <p className="text-sm text-muted-foreground" data-testid="quality-notice-body">{body}</p> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={props.onDismiss}
          aria-label="Dismiss"
          data-testid="quality-notice-dismiss"
          className="-me-1 -mt-0.5 text-muted-foreground"
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-col gap-2 ps-7">
        <StreakLine quality={quality} />
        <NextSpinHint quality={quality} />

        {quality.tips.length ? (
          <div data-testid="quality-notice-tips">
            <p className="text-xs font-medium text-foreground">{coaching ? "How to earn spins" : "Tips"}</p>
            <ul className="mt-1 list-disc space-y-1 ps-4 text-xs leading-5 text-muted-foreground marker:text-muted-foreground/60">
              {quality.tips.map((tip) => <li key={tip}>{goodSessionWording(tip)}</li>)}
            </ul>
          </div>
        ) : coaching ? (
          <p className="text-xs font-medium text-foreground">How to earn spins</p>
        ) : null}

        <GoodSessionGuide className="rounded-lg border border-border px-3 py-2" />

        {coaching ? (
          <div>
            <button
              type="button"
              onClick={toggleWhy}
              aria-expanded={whyOpen}
              data-testid="quality-see-why"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
            >
              See why
              <ChevronDown className={cn("size-3.5 transition", whyOpen && "rotate-180")} />
            </button>
            {whyOpen ? <div className="mt-2 max-h-56 overflow-y-auto pe-1"><SessionReasons reasons={sessions} /></div> : null}
          </div>
        ) : null}

        <BiggestWinTicker quality={quality} />

        <div className="mt-1 flex flex-wrap items-center gap-2">
          {quality.spinsAvailable > 0 ? (
            <Button
              type="button"
              size="sm"
              onClick={props.onSpin}
              disabled={!spinnable}
              data-testid="quality-notice-spin"
            >
              Spin{quality.spinsAvailable > 1 ? ` (${quality.spinsAvailable})` : ""}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={props.onDismiss}>
            Got it
          </Button>
          {quality.spinsAvailable > 0 && !spinnable ? (
            <span className="text-xs text-muted-foreground">The wheel is resting, back tomorrow.</span>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/** The server's nudge, once per id. */
export function QualityNudge(props: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-testid="quality-nudge"
      className={cn("fixed bottom-4 right-4 z-[64] flex max-w-[360px] items-start gap-3 p-4 text-sm", TOAST_SURFACE)}
    >
      <Gift className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1 text-muted-foreground">{goodSessionWording(props.text)}</span>
      <Button type="button" variant="ghost" size="icon-xs" onClick={props.onDismiss} aria-label="Dismiss" className="-me-1 -mt-0.5 text-muted-foreground">
        <X />
      </Button>
    </div>
  );
}

const PROFILE_REFRESH_MS = 15 * 60_000;

/**
 * Quality rewards over the app: a notice (once per id, never for spins
 * earned, coaching at most once a day, only at a quiet moment), the panel
 * the sidebar opens, the server's nudge (once per id, hides by itself) and
 * the spin dialog. Renders nothing while `quality` is null (the feature is
 * off).
 */
export function QualityRewards() {
  const quality = useAccountQuality();
  const panelOpen = useQualityUiStore((store) => store.panelOpen);
  const spinOpen = useQualityUiStore((store) => store.spinOpen);
  const { notice, nudge, dismissNotice, dismissNudge } = useQualityPopups(quality);

  useEffect(() => {
    const read = () => void refreshAccountStatus(omnirushAccountStatus);
    read();
    const timer = window.setInterval(read, PROFILE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const dismiss = useCallback(() => {
    dismissNotice();
    useQualityUiStore.getState().closePanel();
  }, [dismissNotice]);

  const spin = useCallback(() => {
    dismissNotice();
    useQualityUiStore.getState().openSpin();
  }, [dismissNotice]);

  const loadSessions = useCallback(async (): Promise<QualitySessionReasons | null> => {
    const details = await omnirushQualityDetails();
    return details ? { sessions: details.sessions, failLabels: details.failLabels ?? {} } : null;
  }, []);

  if (!quality) return null;
  const showCard = !spinOpen && (panelOpen || notice !== null);
  return (
    <>
      {showCard ? (
        <QualityNoticeCard quality={quality} notice={notice} onSpin={spin} onDismiss={dismiss} loadSessions={loadSessions} />
      ) : nudge && !spinOpen ? (
        <QualityNudge text={nudge.text} onDismiss={dismissNudge} />
      ) : null}
      {spinOpen ? <QualitySpinDialog quality={quality} onClose={() => useQualityUiStore.getState().closeSpin()} /> : null}
    </>
  );
}
