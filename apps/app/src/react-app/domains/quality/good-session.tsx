/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type { OmniRushSessionStatus } from "@omnirush/types/desktop-ipc";
import { AlertTriangle, ChevronDown, CircleCheck, CircleX, Star } from "lucide-react";

const CHECKLIST_OPEN_KEY = "omnirush.goodSession.checklistOpen";

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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  checklistHeading,
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
  type GoodSessionCheck,
  type GoodSessionTone,
} from "../../../app/lib/good-session";
import {
  GOOD_SESSION_TURN_END_DELAY_MS,
  goodSessionCopy,
  nextGoodSessionCheckMs,
} from "../../../app/lib/good-session-integrity";
import type { OmniRushGoodSession, OmniRushServerClient } from "../../../app/lib/omnirush-server";
import { readPref, useAccountQuality, writePref } from "../../../app/lib/quality";
import { AllowanceHelpLink } from "./allowance-help";
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

function CheckMark({ check }: { check: GoodSessionCheck }) {
  return (
    <span
      title={check.hint}
      data-check={check.id}
      data-state={check.state}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        check.state === "pass" && "text-foreground",
        (check.state === "fail" || check.state === "warn") && "text-warning",
      )}
    >
      {check.label}
      {check.state === "pending" ? null : check.state === "pass" ? (
        <CircleCheck className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      ) : check.state === "warn" ? (
        <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      ) : (
        <CircleX className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      )}
    </span>
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
/** How much longer it waits for a last reply still open then (no end time, no error yet) to close. */
export const AUTO_RETRY_REPLY_WAIT_MS = 3_000;
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
export function GoodSessionLine({ result, announce = true }: { result: OmniRushGoodSession | null; announce?: boolean }) {
  const copy = goodSessionCopy(result);
  return (
    <p role={announce ? "status" : undefined} data-testid="good-session-confirmed" data-state={copy.state} className="text-[11px] leading-4">
      {copy.state === "good" ? (
        <span className="font-medium text-foreground">{copy.text}</span>
      ) : copy.state === "pending" ? (
        <span className="text-muted-foreground">{copy.text}</span>
      ) : (
        <span className="text-warning">
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

/** A status line's lead ("Not a good session", "Good session"), for spotting two lines that give the same verdict. */
function statusLead(text: string): string {
  return text.toLowerCase().replace(/★/g, "").split(/[:.]/)[0]!.replace(/\s+/g, " ").trim();
}

/** A sentence for screen readers: ends with one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…★]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const TONE_TEXT: Record<GoodSessionTone, string> = { amber: "text-warning", red: "text-red-11" };
const TONE_BOX: Record<GoodSessionTone, string> = {
  amber: "border-amber-7/40 bg-amber-2/30 text-warning",
  red: "border-red-7/40 bg-red-2/30 text-red-11",
};

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
    let replyDeadline = 0;
    const judge = () => {
      const now = latest.current;
      // The engine says idle before it writes a failed turn's error onto
      // the reply: an open reply is waited for (up to 3 s), never judged.
      if (now.facts.replyOpen && !now.turnRunning) {
        replyDeadline ||= Date.now() + AUTO_RETRY_REPLY_WAIT_MS;
        if (Date.now() < replyDeadline) {
          timer = window.setTimeout(judge, 100);
          return;
        }
      }
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
    };
    let timer = window.setTimeout(judge, AUTO_RETRY_SETTLE_MS);
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
  // The checklist opens on demand (remembered); the summary always shows how many checks pass.
  const [checklistOpen, setChecklistOpen] = useState(() => readPref(CHECKLIST_OPEN_KEY) === "1");
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
  const passedChecks = checklist.checks.filter((check) => check.state === "pass").length;
  // The status (server message, reasons, delivery, the integrity verdict): in the chip's tooltip and
  // expanded view only. One verdict, not two: while the integrity check is pending the server's message
  // stands; when both give the same verdict, the more useful one stays (the integrity line has the
  // reason, the fix and the guide link).
  const verdictCopy = props.client ? goodSessionCopy(goodSession) : null;
  let showMessage = Boolean(checklist.message);
  let showVerdict = Boolean(verdictCopy);
  if (verdictCopy && checklist.message) {
    if (verdictCopy.state === "pending") showVerdict = false;
    else if (statusLead(checklist.message) === statusLead(verdictCopy.text)) {
      if (verdictCopy.state === "not-good") showMessage = false;
      else showVerdict = false;
    }
  }
  const statusLines = [
    ...(showMessage && checklist.message ? [checklist.message] : []),
    ...checklist.reasons,
    ...(checklist.delivery ? [checklist.delivery] : []),
    ...(showVerdict && verdictCopy ? [verdictCopy.text] : []),
  ];
  const dock = checklist.dock;
  const dockLink = dock?.link;
  return (
    // A container: the checklist lays out by the chat's own width (the chat can be narrow beside the editor), not the window's.
    <div className="@container/quality" data-testid="good-session-checklist" data-verdict={verdict} data-source={checklist.source}>
      {dock ? (
        <div
          role="status"
          data-testid="good-session-dock"
          data-tone={dock.tone}
          className={cn("mb-1.5 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs", TONE_BOX[dock.tone])}
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{dock.message}</span>
          {dockLink ? (
            <button
              type="button"
              data-testid="good-session-dock-link"
              className="shrink-0 font-medium underline underline-offset-2"
              onClick={() => void openDesktopUrl(dockLink).catch(() => undefined)}
            >
              Details
            </button>
          ) : null}
        </div>
      ) : null}
      {followUpShown ? (
        <div className="flex items-center gap-2 pb-1 text-[11px] leading-4 text-muted-foreground" data-testid="good-session-follow-up" role="status">
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
      {/* At every width: a compact summary ("On track ★ 4/6") that opens to the full checklist,
          and the guide link on its own line under it (never cut off at the right edge). */}
      <div className="flex flex-col items-start gap-1 pb-1.5" data-testid="good-session-row" data-expanded={checklistOpen ? "" : undefined}>
        <span role="status" className="sr-only">{[checklist.text, ...statusLines].map(sentence).join(" ")}</span>
        <button
          type="button"
          onClick={() => {
            const next = !checklistOpen;
            setChecklistOpen(next);
            writePref(CHECKLIST_OPEN_KEY, next ? "1" : "0");
          }}
          aria-expanded={checklistOpen}
          aria-label={checklist.text}
          title={statusLines.join("\n") || undefined}
          data-testid="good-session-summary"
          className={cn(
            "flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 border border-border bg-popover/60 px-2.5 py-1 text-start text-[11px] leading-4 text-muted-foreground transition-colors hover:bg-muted/60",
            checklistOpen ? "w-full rounded-xl px-3 py-1.5" : "rounded-full",
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Star
              data-testid="good-session-star"
              data-filled={verdict === "good" ? "" : undefined}
              className={cn("size-3 shrink-0", verdict === "good" ? "fill-current text-foreground" : verdict === "on-track" ? "text-foreground" : "text-muted-foreground")}
              aria-hidden="true"
            />
            <span className="truncate font-medium text-foreground">{checklistHeading(verdict)}</span>
            <span className={cn("shrink-0 tabular-nums", passedChecks < checklist.checks.length && "text-warning")} data-testid="good-session-count">
              {passedChecks}/{checklist.checks.length}
            </span>
            <ChevronDown className={cn("size-3 shrink-0 transition-transform", checklistOpen && "rotate-180")} aria-hidden="true" />
          </span>
          {checklistOpen ? (
            <span className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1" data-testid="good-session-checks">
              {checklist.checks.map((check) => <CheckMark key={check.id} check={check} />)}
            </span>
          ) : null}
        </button>
        {/* The status (server message, reasons, delivery, the integrity verdict) lives here and in the
            chip's tooltip, never as extra lines over the chat. */}
        {checklistOpen && statusLines.length ? (
          <div className="w-full px-3 text-[11px] leading-4 text-muted-foreground" data-testid="good-session-server-message">
            {showMessage && checklist.message ? (
              <p className={cn("font-medium", checklist.messageTone ? TONE_TEXT[checklist.messageTone] : "text-foreground")}>{checklist.message}</p>
            ) : null}
            {checklist.reasons.map((reason) => <p key={reason} className="text-warning">{reason}</p>)}
            {checklist.delivery ? <p data-testid="good-session-delivery">{checklist.delivery}</p> : null}
            {/* The chip's own status already announces it. */}
            {showVerdict ? <GoodSessionLine result={goodSession} announce={false} /> : null}
          </div>
        ) : null}
        <Popover>
          <PopoverTrigger
            render={(
              <button
                type="button"
                data-testid="good-session-guide-link"
                className="shrink-0 whitespace-nowrap ps-1 text-[11px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
              />
            )}
          >
            {GOOD_SESSION_GUIDE_LINK}
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-72 gap-2 rounded-2xl p-3">
            <GoodSessionGuide />
            <AllowanceHelpLink tab="good-session" label="The full guide" testId="good-session-full-guide" />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

/** The finish guard in the app (deleting the session): "Finish it" (the default) or "Quit anyway". */
export function FinishGuardDialog(props: { kind: FinishGuardKind | null; onFinish: () => void; onQuit: () => void }) {
  return (
    <AlertDialog open={props.kind !== null} onOpenChange={(open) => { if (!open) props.onFinish(); }}>
      <AlertDialogContent data-testid="finish-guard-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-amber-3/50 text-warning">
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
          <AlertDialogMedia className="bg-amber-3/50 text-warning">
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
