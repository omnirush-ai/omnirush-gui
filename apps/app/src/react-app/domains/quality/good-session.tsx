/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type { OmniRushSessionStatus } from "@omnirush/types/desktop-ipc";
import { AlertTriangle, CircleCheck, CircleDashed, CircleX, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

import { omnirushQualityDetails, omnirushSessionStatus, openDesktopUrl } from "../../../app/lib/desktop";
import {
  FINISH_GUARD_DETAIL,
  FINISH_GUARD_EVENT,
  FINISH_GUARD_FINISH,
  FINISH_GUARD_PROMPT,
  FINISH_GUARD_QUIT,
  FINISH_GUARD_TITLE,
  FOLLOW_UP_HINT,
  FOLLOW_UP_OFF_KEY,
  FOLLOW_UP_QUIET_MS,
  GOOD_SESSION_GUIDE,
  GOOD_SESSION_GUIDE_LINK,
  NUDGE_TITLE,
  TURN_GUARD_DETAIL,
  TURN_GUARD_QUIT,
  TURN_GUARD_TITLE,
  TURN_GUARD_WAIT,
  autoRetryMessage,
  finishGuardKind,
  followUpHintDue,
  goodSessionChecklist,
  goodSessionNudge,
  messageFacts,
  oneMoreTurnHint,
  promptsInTranscript,
  serverStatusUsable,
  sessionStatusPollMs,
  shouldNudge,
  shownChecklist,
  type FinishGuardKind,
  type GoodSessionCheckState,
  type ShownChecklist,
} from "../../../app/lib/good-session";
import {
  GOOD_SESSION_TURN_END_DELAY_MS,
  goodSessionCopy,
  nextGoodSessionCheckMs,
} from "../../../app/lib/good-session-integrity";
import type { OmniRushGoodSession, OmniRushServerClient } from "../../../app/lib/omnirush-server";
import { readPref, useAccountQuality, writePref } from "../../../app/lib/quality";
import { isDesktopRuntime } from "../../../app/utils";
import { hasLiveSessionActivity, useSessionActivityStore } from "../session/status/session-activity-store";

/** The four steps (native Windows, macOS and Linux alike). */
export function GoodSessionGuide({ className }: { className?: string }) {
  return (
    <div className={cn("text-xs", className)} data-testid="good-session-guide">
      <p className="font-medium text-foreground">{GOOD_SESSION_GUIDE_LINK}</p>
      <ol className="mt-1 list-decimal space-y-0.5 ps-4 leading-5 text-muted-foreground marker:text-muted-foreground/60">
        {GOOD_SESSION_GUIDE.map((step) => <li key={step}>{step}</li>)}
      </ol>
    </div>
  );
}

const CHECK_STATE_LABEL: Record<GoodSessionCheckState, string> = {
  pass: "Passed",
  fail: "Not passed",
  warn: "Warning",
  pending: "Pending",
};

function CheckStateIcon({ state }: { state: GoodSessionCheckState }) {
  if (state === "pass") return <CircleCheck className="size-4 shrink-0 text-emerald-11" strokeWidth={2.5} aria-hidden="true" />;
  if (state === "warn") return <AlertTriangle className="size-4 shrink-0 text-amber-11" strokeWidth={2.5} aria-hidden="true" />;
  if (state === "fail") return <CircleX className="size-4 shrink-0 text-amber-11" strokeWidth={2.5} aria-hidden="true" />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />;
}

function CompactSessionStatus({ checklist, result, serverAvailable }: {
  checklist: ShownChecklist;
  result: OmniRushGoodSession | null;
  serverAvailable: boolean;
}) {
  const copy = goodSessionCopy(result);
  if (copy.state === "not-good" || checklist.verdict === "incomplete") {
    return { label: "Session Details: Needs attention", state: "warning" as const };
  }
  if (copy.state === "good" || checklist.verdict === "good") {
    return { label: "Good session", state: "good" as const };
  }
  if (serverAvailable && copy.state === "pending") {
    return { label: "Checking", state: "checking" as const };
  }
  return { label: "On track", state: "on-track" as const };
}

function CountingStatus({ checklist, result, serverAvailable }: {
  checklist: ShownChecklist;
  result: OmniRushGoodSession | null;
  serverAvailable: boolean;
}) {
  const copy = goodSessionCopy(result);
  if (copy.state === "not-good") return "Not a Good session";
  if (copy.state === "good" || checklist.verdict === "good") return "Counting as a Good session";
  if (serverAvailable && copy.state === "pending") return "Checking session quality…";
  if (checklist.verdict === "on-track") return "On track — final check after upload";
  return "Not counting yet";
}

function GoodSessionDetailsDialog({ checklist, result, serverAvailable, open, onOpenChange }: {
  checklist: ShownChecklist;
  result: OmniRushGoodSession | null;
  serverAvailable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const copy = goodSessionCopy(result);
  const warningChecks = checklist.checks.filter((check) => check.state === "fail" || check.state === "warn");
  const hasWarnings = Boolean(
    warningChecks.length
    || checklist.message
    || checklist.reasons.length
    || checklist.delivery
    || checklist.dock
    || copy.state === "not-good",
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      // Ensure the dialog always displays from the very top on open
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }
      });
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden resize lg:max-w-4xl min-w-[360px] min-h-[380px] max-w-[95vw]"
        data-testid="good-session-details-dialog"
      >
        <DialogHeader className="shrink-0 pb-1 border-b border-border/40">
          <DialogTitle>Good session details</DialogTitle>
          <DialogDescription>See what this session needs to count as a Good session.</DialogDescription>
        </DialogHeader>

        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto pt-3 pe-2"
        >
          {/* Top Counting Status summary */}
          <section aria-labelledby="good-session-counting-status" data-testid="good-session-counting-status" className="mb-4 rounded-xl border border-border bg-muted/20 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <h3 id="good-session-counting-status" className="font-semibold text-foreground">Counting status</h3>
              <span className="font-medium text-foreground">{CountingStatus({ checklist, result, serverAvailable })}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="good-session-counting-work">
              Counts: {checklist.work.codeFiles} code files · {checklist.work.lines} lines · {checklist.work.testRuns} test runs
            </p>
          </section>

          {/* 2-Column Horizontal Layout on medium/large screens */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Left Column: Checklist */}
            <section aria-labelledby="good-session-checklist-title" data-testid="good-session-details-checklist" className="flex flex-col gap-2">
              <h3 id="good-session-checklist-title" className="text-sm font-semibold text-foreground">Checklist</h3>
              <ul className="space-y-2">
                {checklist.checks.map((check) => (
                  <li
                    key={check.id}
                    data-check={check.id}
                    data-state={check.state}
                    className="flex items-start gap-2 rounded-lg border border-border/70 bg-card/40 px-3 py-2"
                  >
                    <CheckStateIcon state={check.state} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
                        <span className="font-medium text-foreground">{check.label}</span>
                        <span className="text-muted-foreground">{CHECK_STATE_LABEL[check.state]}</span>
                      </div>
                      {check.hint ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{check.hint}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* Right Column: Warnings & How to make a Good session Guide */}
            <div className="flex flex-col gap-4">
              <section aria-labelledby="good-session-warnings-title" data-testid="good-session-warnings" className="rounded-xl border border-border/70 bg-card/30 p-3">
                <h3 id="good-session-warnings-title" className="mb-2 text-sm font-semibold text-foreground">Warnings</h3>
                {hasWarnings ? (
                  <ul className="space-y-1.5 text-xs leading-4 text-amber-11">
                    {warningChecks.map((check) => <li key={`check-${check.id}`}>{check.label}: {check.hint}</li>)}
                    {checklist.message ? <li>{checklist.message}</li> : null}
                    {checklist.reasons.map((reason) => <li key={`reason-${reason}`}>{reason}</li>)}
                    {checklist.delivery ? <li>{checklist.delivery}</li> : null}
                    {checklist.dock ? (
                      <li className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">{checklist.dock.message}</span>
                        {checklist.dock.link ? (
                          <button
                            type="button"
                            className="shrink-0 font-medium underline underline-offset-2"
                            onClick={() => void openDesktopUrl(checklist.dock?.link ?? "").catch(() => undefined)}
                          >
                            Open details
                          </button>
                        ) : null}
                      </li>
                    ) : null}
                    {copy.state === "not-good" ? (
                      <li className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">{copy.text}</span>
                        <button
                          type="button"
                          data-testid="good-session-rewards-link"
                          className="shrink-0 font-medium underline underline-offset-2"
                          onClick={() => void openDesktopUrl(copy.link.url).catch(() => undefined)}
                        >
                          {copy.link.label}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No warnings.</p>
                )}
              </section>

              <GoodSessionGuide className="rounded-xl border border-border bg-card/30 p-3" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const NUDGED_STORAGE_KEY = "omnirush.goodSession.nudged.v1";
const FOLLOW_UP_STORAGE_KEY = "omnirush.goodSession.followUp.v1";
const NUDGED_KEEP = 200;

function nudgedSessions(): string[] {
  return rememberedSessions(NUDGED_STORAGE_KEY);
}

function rememberNudged(sessionId: string) {
  rememberSession(NUDGED_STORAGE_KEY, sessionId);
}

export type GoodSessionChecklistBarProps = {
  sessionId: string;
  messages: readonly UIMessage[];
  workspaceRoot: string;
  isRemoteWorkspace: boolean;
  turnRunning: boolean;
  /** "Finish it": put the reply in the composer and focus it (never sends). */
  onFinishIt?: (prompt: string) => void;
  /** Send a prompt on its own (the server's auto-retry). */
  onAutoRetry?: (prompt: string) => void;
  /** The local server, for the server-confirmed "Good session ★" line (none without it). */
  client?: Pick<OmniRushServerClient, "getGoodSession">;
};

/** How long a turn's end settles before an auto-retry is judged (late Stop or error events land first). */
const AUTO_RETRY_SETTLE_MS = 4_000;
/** Sessions whose running turn the user stopped (the Stop button); cleared when a turn starts. */
const userStops = new Set<string>();
/** Automatic retries in a row per session; reset when a turn finishes. */
const autoRetries = new Map<string, number>();

/** The Stop button: no auto-retry follows this turn. */
export function noteUserStop(sessionId: string) {
  userStops.add(sessionId);
}

const ONE_MORE_TURN_STORAGE_KEY = "omnirush.goodSession.oneMoreTurn.v1";

function rememberedSessions(key: string): string[] {
  try {
    const parsed = JSON.parse(readPref(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberSession(key: string, sessionId: string) {
  const ids = rememberedSessions(key).filter((id) => id !== sessionId);
  ids.push(sessionId);
  writePref(key, JSON.stringify(ids.slice(-NUDGED_KEEP)));
}

/** The open sessions' finish states, for the in-app delete guard (the native quit guard gets them over IPC). */
const finishStates = new Map<string, FinishGuardKind>();

export function finishGuardFor(sessionId: string): FinishGuardKind | null {
  return finishStates.get(sessionId) ?? null;
}

function reportFinishState(sessionId: string, kind: FinishGuardKind | null) {
  if (kind) finishStates.set(sessionId, kind);
  else finishStates.delete(sessionId);
  if (!isDesktopRuntime()) return;
  void Promise.resolve(window.__OMNIRUSH_ELECTRON__?.invokeDesktop?.("__setFinishState", { sessionId, kind })).catch(() => undefined);
}

/** "Finish it" for a session: its checklist bar fills the composer. */
export function requestFinishIt(sessionId: string, kind: FinishGuardKind) {
  window.dispatchEvent(new CustomEvent(FINISH_GUARD_EVENT, { detail: { sessionId, kind } }));
}

/**
 * The server's live status for the open session (GET
 * /me/sessions/{id}/status, 3 s), re-read every `poll_seconds` (30 s or
 * more, 60 s by default) and when a turn starts or ends. Null while it is
 * unknown, the request failed or outside the desktop: the bar then shows
 * the local checklist.
 */
function useServerSessionStatus(sessionId: string, active: boolean, turnRunning: boolean): OmniRushSessionStatus | null {
  const [read, setRead] = useState<{ sessionId: string; status: OmniRushSessionStatus | null }>({ sessionId, status: null });
  useEffect(() => {
    if (!active || !isDesktopRuntime()) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const status = await omnirushSessionStatus({ sessionId }).catch(() => null);
      if (cancelled) return;
      setRead({ sessionId, status });
      timer = window.setTimeout(() => void poll(), sessionStatusPollMs(status));
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, sessionId, turnRunning]);
  return read.sessionId === sessionId ? read.status : null;
}

/** Final answers (true or false) per session, until that session's next turn ends. */
const finalGoodSessions = new Map<string, OmniRushGoodSession>();

/**
 * The server's "Good session ★" for the open session (GET
 * /omnirush/integrity/:sessionId): once when it opens, once about 5 s after
 * each turn ends, and while "pending" again at 30 s, 1 m, 2 m, 5 m, then
 * every 10 m, up to 24 h after the last turn. True and false are final
 * until the next turn ends. Null while unknown (shown as pending).
 */
function useGoodSession(
  client: Pick<OmniRushServerClient, "getGoodSession"> | undefined,
  sessionId: string,
  active: boolean,
  turnRunning: boolean,
  endedAt: number | null,
): OmniRushGoodSession | null {
  const [read, setRead] = useState<{ sessionId: string; result: OmniRushGoodSession | null }>(() => ({
    sessionId,
    result: finalGoodSessions.get(sessionId) ?? null,
  }));
  const edge = useRef({ sessionId, running: turnRunning });
  const lastEnd = useRef(endedAt);
  lastEnd.current = endedAt;
  useEffect(() => {
    const previous = edge.current;
    edge.current = { sessionId, running: turnRunning };
    if (!client || !active || turnRunning) return;
    const turnEnded = previous.sessionId === sessionId && previous.running;
    if (turnEnded) finalGoodSessions.delete(sessionId);
    const known = finalGoodSessions.get(sessionId) ?? null;
    setRead({ sessionId, result: known });
    if (known) return;
    const lastTurnEndedAt = turnEnded ? Date.now() : lastEnd.current ?? Date.now();
    let cancelled = false;
    let timer: number | undefined;
    let pendingChecks = 0;
    const check = async () => {
      const result = await client.getGoodSession(sessionId).catch(() => null);
      if (cancelled) return;
      if (result && result.good_session !== "pending") finalGoodSessions.set(sessionId, result);
      setRead({ sessionId, result });
      pendingChecks += 1;
      const wait = nextGoodSessionCheckMs({ result, pendingChecks, lastTurnEndedAt, now: Date.now() });
      if (wait !== null) timer = window.setTimeout(() => void check(), wait);
    };
    timer = window.setTimeout(() => void check(), turnEnded ? GOOD_SESSION_TURN_END_DELAY_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, client, sessionId, turnRunning]);
  return read.sessionId === sessionId ? read.result : null;
}

/** "Good session ★", "Checking session quality…" (muted) or why not, with the rewards guide. */
export function GoodSessionLine({ result }: { result: OmniRushGoodSession | null }) {
  const copy = goodSessionCopy(result);
  return (
    <p role="status" data-testid="good-session-confirmed" data-state={copy.state} className="mx-auto max-w-[800px] pb-1 text-[11px] leading-4">
      {copy.state === "good" ? (
        <span className="font-medium text-foreground">{copy.text}</span>
      ) : copy.state === "pending" ? (
        <span className="text-muted-foreground">{copy.text}</span>
      ) : (
        <span className="text-amber-11">
          {copy.text}{" "}
          <button
            type="button"
            data-testid="good-session-rewards-link"
            className="font-medium underline underline-offset-2"
            onClick={() => void openDesktopUrl(copy.link.url).catch(() => undefined)}
          >
            {copy.link.label}
          </button>
        </span>
      )}
    </p>
  );
}

const SERVER_VERDICT_REFRESH_MS = 5 * 60_000;

/**
 * The server's verdict on this session (GET /me/quality: `client_grade`),
 * once the local checks pass and no turn runs. Sessions are checked about
 * once an hour after upload, so this is usually false during the session.
 */
function useServerGood(sessionId: string, ask: boolean): boolean {
  const quality = useAccountQuality();
  const [good, setGood] = useState<{ sessionId: string; good: boolean }>({ sessionId, good: false });
  const lastRead = useRef<{ sessionId: string; at: number } | null>(null);
  useEffect(() => {
    if (!ask || !quality) return;
    const last = lastRead.current;
    if (last && last.sessionId === sessionId && Date.now() - last.at < SERVER_VERDICT_REFRESH_MS) return;
    lastRead.current = { sessionId, at: Date.now() };
    let cancelled = false;
    void omnirushQualityDetails()
      .then((details) => {
        if (cancelled) return;
        const session = details?.sessions.find((entry) => entry.sessionId === sessionId);
        setGood({ sessionId, good: session?.clientGrade === true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ask, quality, sessionId]);
  return good.sessionId === sessionId && good.good;
}

/**
 * The live checklist over the composer: "Good session: code changed ✓ ·
 * ran/tested ✗ · in project ✓ · finish your turn". When every local check
 * passes it reads "On track for a Good session ★ (final check after
 * upload)" with an outlined star; the star fills only on the server's
 * verdict. One gentle nudge per session when a turn ends with something
 * missing.
 */
export function GoodSessionChecklistBar(props: GoodSessionChecklistBarProps) {
  const facts = useMemo(() => messageFacts(props.messages), [props.messages]);
  const local = useMemo(() => goodSessionChecklist({
    ...facts,
    workspaceRoot: props.workspaceRoot,
    isRemoteWorkspace: props.isRemoteWorkspace,
    turnRunning: props.turnRunning,
  }), [facts, props.isRemoteWorkspace, props.turnRunning, props.workspaceRoot]);
  const hasPrompt = props.messages.some((message) => message.role === "user");
  const server = useServerSessionStatus(props.sessionId, hasPrompt, props.turnRunning);
  const goodSession = useGoodSession(props.client, props.sessionId, hasPrompt, props.turnRunning, facts.endedAt);
  // /me/quality's client grade only while the server says nothing about this session.
  const serverGood = useServerGood(props.sessionId, local.onTrack && !serverStatusUsable(server));
  const checklist = useMemo(
    () => shownChecklist({ local, server, sessionId: props.sessionId, serverGood }),
    [local, props.sessionId, server, serverGood],
  );
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The finish guard: the desktop asks before quitting, closing or deleting while this is set.
  const finishKind = hasPrompt
    ? finishGuardKind({ turnRunning: props.turnRunning, ended: facts.ended, endedAt: facts.endedAt, server })
    : null;
  useEffect(() => {
    const sessionId = props.sessionId;
    reportFinishState(sessionId, finishKind);
    return () => reportFinishState(sessionId, null);
  }, [finishKind, props.sessionId]);
  // The server's auto-retry: on this session's running → done edge, after
  // the end settles, judged on the latest transcript.
  const latest = useRef({ facts, server, turnRunning: props.turnRunning, onAutoRetry: props.onAutoRetry });
  latest.current = { facts, server, turnRunning: props.turnRunning, onAutoRetry: props.onAutoRetry };
  const retryEdge = useRef<{ sessionId: string; running: boolean }>({ sessionId: props.sessionId, running: props.turnRunning });
  useEffect(() => {
    const previous = retryEdge.current;
    const sessionId = props.sessionId;
    retryEdge.current = { sessionId, running: props.turnRunning };
    if (props.turnRunning) {
      if (!previous.running) userStops.delete(sessionId);
      return;
    }
    if (previous.sessionId !== sessionId || !previous.running) return;
    const timer = window.setTimeout(() => {
      const now = latest.current;
      if (now.facts.ended === "pass" || now.facts.ended === "awaiting") {
        autoRetries.delete(sessionId);
        return;
      }
      const retriesInARow = autoRetries.get(sessionId) ?? 0;
      if (!now.onAutoRetry) return;
      const message = autoRetryMessage({
        turnRunning: now.turnRunning,
        ended: now.facts.ended,
        retryable: now.facts.retryable,
        userStopped: userStops.has(sessionId),
        retriesInARow,
        server: now.server,
      });
      if (!message) return;
      autoRetries.set(sessionId, retriesInARow + 1);
      now.onAutoRetry(message);
    }, AUTO_RETRY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [props.sessionId, props.turnRunning]);

  // One more turn would make it count (the server's `depth` item): once per session.
  const depthHint = props.turnRunning ? null : oneMoreTurnHint(server);
  useEffect(() => {
    if (!depthHint || rememberedSessions(ONE_MORE_TURN_STORAGE_KEY).includes(props.sessionId)) return;
    rememberSession(ONE_MORE_TURN_STORAGE_KEY, props.sessionId);
    // The server's own nudge showed: the follow-up hint is not added on top.
    rememberSession(FOLLOW_UP_STORAGE_KEY, props.sessionId);
    toast(NUDGE_TITLE, { id: `good-session-depth:${props.sessionId}`, description: depthHint, duration: 12_000 });
  }, [depthHint, props.sessionId]);

  // The follow-up hint: one finished turn, then a quiet minute; a quiet line in the bar, once per session.
  const prompts = useMemo(() => promptsInTranscript(props.messages), [props.messages]);
  const [followUpFor, setFollowUpFor] = useState<string | null>(null);
  const [followUpOff, setFollowUpOff] = useState(() => readPref(FOLLOW_UP_OFF_KEY) === "1");
  const serverFollowUpOff = serverStatusUsable(server) && server.client?.oneMoreTurn === false;
  useEffect(() => {
    const sessionId = props.sessionId;
    // The server's switch only (a fresh status read every poll must not restart the quiet minute).
    const quiet = { prompts, running: props.turnRunning, off: followUpOff || serverFollowUpOff };
    if (!followUpHintDue({ ...quiet, quitting: true, shown: rememberedSessions(FOLLOW_UP_STORAGE_KEY).includes(sessionId) })) return;
    const timer = window.setTimeout(() => {
      if (!followUpHintDue({ ...quiet, quietMs: FOLLOW_UP_QUIET_MS, shown: rememberedSessions(FOLLOW_UP_STORAGE_KEY).includes(sessionId) })) return;
      rememberSession(FOLLOW_UP_STORAGE_KEY, sessionId);
      setFollowUpFor(sessionId);
    }, FOLLOW_UP_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [followUpOff, prompts, props.sessionId, props.turnRunning, serverFollowUpOff]);
  const followUpShown = followUpFor === props.sessionId && !followUpOff && prompts === 1;

  const onFinishIt = props.onFinishIt;
  useEffect(() => {
    if (!onFinishIt) return;
    const sessionId = props.sessionId;
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object" || !("sessionId" in detail) || !("kind" in detail)) return;
      if (detail.sessionId !== sessionId || (detail.kind !== "awaiting" && detail.kind !== "cut")) return;
      onFinishIt(FINISH_GUARD_PROMPT[detail.kind]);
    };
    window.addEventListener(FINISH_GUARD_EVENT, listener);
    return () => window.removeEventListener(FINISH_GUARD_EVENT, listener);
  }, [onFinishIt, props.sessionId]);

  // The nudge: on the running → done edge of this session's turn.
  const wasRunning = useRef<{ sessionId: string; running: boolean }>({ sessionId: props.sessionId, running: props.turnRunning });
  useEffect(() => {
    const previous = wasRunning.current;
    wasRunning.current = { sessionId: props.sessionId, running: props.turnRunning };
    if (previous.sessionId !== props.sessionId || !hasPrompt) return;
    const alreadyNudged = nudgedSessions().includes(props.sessionId);
    if (!shouldNudge({ wasRunning: previous.running, running: props.turnRunning, checklist, alreadyNudged })) return;
    const nudge = goodSessionNudge(checklist);
    if (!nudge) return;
    rememberNudged(props.sessionId);
    toast(nudge.title, { id: `good-session-nudge:${props.sessionId}`, description: nudge.body, duration: 12_000 });
  }, [checklist, hasPrompt, props.sessionId, props.turnRunning]);

  if (!hasPrompt) return null;
  const verdict = checklist.verdict;
  const compactStatus = CompactSessionStatus({ checklist, result: goodSession, serverAvailable: Boolean(props.client) });
  return (
    <div className="px-4 max-lg:px-3 lg:px-8" data-testid="good-session-checklist" data-verdict={verdict} data-source={checklist.source}>
      {followUpShown ? (
        <div className="mx-auto flex max-w-[800px] items-center gap-2 pb-1 text-[11px] leading-4 text-muted-foreground" data-testid="good-session-follow-up" role="status">
          <span className="min-w-0 flex-1">{FOLLOW_UP_HINT}</span>
          <button
            type="button"
            data-testid="good-session-follow-up-off"
            className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              writePref(FOLLOW_UP_OFF_KEY, "1");
              setFollowUpOff(true);
            }}
          >
            Don't show again
          </button>
        </div>
      ) : null}
      <div className="mx-auto flex max-w-[800px] items-center gap-2 pb-1.5">
        <div
          className="flex min-w-0 flex-1 items-center gap-2 text-[11px] leading-4 text-muted-foreground"
          aria-label={checklist.text}
          role="status"
          data-testid="good-session-status"
          data-state={compactStatus.state}
        >
          <Star
            data-testid="good-session-star"
            data-filled={compactStatus.state === "good" ? "" : undefined}
            className={cn("size-3 shrink-0", compactStatus.state === "good" ? "fill-current text-foreground" : compactStatus.state === "warning" ? "text-amber-11" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className={cn("min-w-0 truncate font-medium", compactStatus.state === "warning" ? "text-amber-11" : "text-foreground")}>
            {compactStatus.label}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="good-session-details"
          aria-haspopup="dialog"
          onClick={() => setDetailsOpen(true)}
        >
          Details
        </Button>
      </div>
      <GoodSessionDetailsDialog
        checklist={checklist}
        result={goodSession}
        serverAvailable={Boolean(props.client)}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </div>
  );
}

/** The finish guard in the app (deleting the session): "Finish it" (the default) or "Quit anyway". */
export function FinishGuardDialog(props: { kind: FinishGuardKind | null; onFinish: () => void; onQuit: () => void }) {
  return (
    <AlertDialog open={props.kind !== null} onOpenChange={(open) => { if (!open) props.onFinish(); }}>
      <AlertDialogContent data-testid="finish-guard-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-amber-3/50 text-amber-11">
            <AlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>{FINISH_GUARD_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{props.kind ? FINISH_GUARD_DETAIL[props.kind] : null}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction variant="outline" data-testid="finish-guard-quit" onClick={props.onQuit}>
            {FINISH_GUARD_QUIT}
          </AlertDialogAction>
          <AlertDialogCancel variant="default" autoFocus data-testid="finish-guard-finish">
            {FINISH_GUARD_FINISH}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The confirm before switching or deleting a session whose turn is running. */
export function TurnGuardDialog(props: { open: boolean; onWait: () => void; onQuit: () => void }) {
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => { if (!open) props.onWait(); }}>
      <AlertDialogContent data-testid="turn-guard-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-amber-3/50 text-amber-11">
            <AlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>{TURN_GUARD_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{TURN_GUARD_DETAIL}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction variant="outline" data-testid="turn-guard-quit" onClick={props.onQuit}>
            {TURN_GUARD_QUIT}
          </AlertDialogAction>
          <AlertDialogCancel variant="default" autoFocus data-testid="turn-guard-wait">
            {TURN_GUARD_WAIT}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Tells the desktop shell whether any turn is running, so closing or quitting asks first. */
export function TurnRunningSync() {
  const running = useSessionActivityStore((store) => hasLiveSessionActivity(store.statusesByWorkspaceId));
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void Promise.resolve(window.__OMNIRUSH_ELECTRON__?.invokeDesktop?.("__setTurnRunning", running)).catch(() => undefined);
  }, [running]);
  return null;
}
