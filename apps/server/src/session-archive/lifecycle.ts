/**
 * The project archive's place in the embedded server's session lifecycle
 * (README "Wiring"). Every method returns at once: engine reads and captures
 * run in the background, a bounded number at a time (one by default), and one
 * session's steps always run in call order. A base can wait for a quiet
 * period after the last prompt (baseIdleMs), so a burst of chats opened and
 * prompted one after another is packed once the burst is over. After the
 * last completed turn, a final archive catches what changed since: when the
 * session stays quiet (finalIdleMs), when a turn ends without completing,
 * when the session is deleted, when the app quits (within quitBudgetMs) and,
 * for what that missed, when the app starts again. Nothing here throws into
 * the request path; an unexpected failure costs one warn line.
 */
import { realpath } from "node:fs/promises";

import type { CaptureResult, DrainResult, FinalReason, SessionArchiver } from "./index.js";

export type ProjectArchiver = Pick<SessionArchiver, "captureBase" | "captureDelta" | "captureFinal" | "startFinalCandidates" | "drain" | "signOut" | "stop">;

/** Engine reads for one session, resolving to the parsed JSON, or null when it cannot be read. */
export type ArchiveEngineReads = {
  /** The session record (v1 `/session/:id`, v2 `/api/session/:id`). */
  session(): Promise<unknown>;
  /** The session's messages in order (v1 `/session/:id/message`, v2 `/api/session/:id/context`). */
  messages(): Promise<unknown>;
};

export type ArchiveLifecycleLog = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;

export type ProjectArchiveLifecycleOptions = {
  archiver: ProjectArchiver;
  /** An account is connected and OMNIRUSH_ARCHIVE_ENABLED is not off. */
  enabled: boolean;
  log: ArchiveLifecycleLog;
  /** Session steps (engine reads plus a capture) running at once. */
  concurrency?: number;
  /** While archiving is off for the account (428, 503 archive_disabled), consent is checked again at most this often. */
  consentRecheckMs?: number;
  /**
   * A base is packed only once no prompt has been dispatched on any session
   * for this long (0, the default: at once), and at the latest
   * baseMaxDeferMs after its own prompt.
   */
  baseIdleMs?: number;
  baseMaxDeferMs?: number;
  /** A session with no prompt for this long after a turn ended gets a final archive (FINAL_IDLE_MS). */
  finalIdleMs?: number;
  /** Shutdown packs the final archives of this app run's sessions for at most this long in all (QUIT_FINAL_BUDGET_MS); 0 packs none. */
  quitBudgetMs?: number;
  /** Tests. */
  now?: () => number;
};

const DEFAULT_CONSENT_RECHECK_MS = 10 * 60_000;
/** The quiet window after a turn: with no new prompt by then, the session gets a final archive. */
export const FINAL_IDLE_MS = 10 * 60_000;
/**
 * What shutdown spends, at most, packing final archives (the desktop app
 * waits for the server to stop before it quits). What does not fit is
 * checked at the next app start.
 */
export const QUIT_FINAL_BUDGET_MS = 5_000;

/** OMNIRUSH_ARCHIVE_ENABLED: on unless set to 0, false, no or off. */
export function projectArchiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "no", "off"].includes((env.OMNIRUSH_ARCHIVE_ENABLED ?? "").trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageInfo(message: Record<string, unknown>): Record<string, unknown> {
  return isRecord(message.info) ? message.info : message;
}

/** An assistant message that ended: a completion time, a finish reason, an error, or a finish part (v1 and v2 shapes). */
export function isFinishedAssistantMessage(message: Record<string, unknown>): boolean {
  const info = messageInfo(message);
  if (isRecord(info.time) && (typeof info.time.completed === "number" || typeof info.time.completed === "string")) return true;
  if (typeof info.finish === "string" || info.error != null) return true;
  const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(info.content) ? info.content : [];
  return parts.some((part) => isRecord(part) && ["step-finish", "finish", "error"].includes(String(part.type)));
}

/**
 * Completed turns in an engine message list: prompts answered by an assistant
 * message that ended (several assistant steps of one turn count once). Each
 * completed turn adds one, so the number strictly increases from one turn to
 * the next and survives app restarts. Null when the list could not be read.
 */
export function completedTurnCount(messages: unknown): number | null {
  if (!Array.isArray(messages)) return null;
  let turns = 0;
  let awaitingReply = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const info = messageInfo(message);
    const role = info.role ?? info.type;
    if (role === "user") {
      awaitingReply = true;
    } else if (role === "assistant" && awaitingReply && isFinishedAssistantMessage(message)) {
      turns += 1;
      awaitingReply = false;
    }
  }
  return turns;
}

/** The parent of a session record: a string for a child (sub-agent) session, null for a root one, undefined when unreadable. */
function parentSessionId(session: unknown): string | null | undefined {
  if (!isRecord(session)) return undefined;
  const info = isRecord(session.info) ? session.info : session;
  const parent = info.parentID ?? info.parentId ?? info.parent_id;
  return typeof parent === "string" && parent ? parent : null;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

/** What this app run knows about a session handed to captureBase. */
type SessionRecord = {
  /** The real path of the session root once resolved; null when deltas are pointless (child, not archivable, stopped) or not known yet. */
  root: string | null;
  /**
   * Where the start step reads the engine, until one read succeeded. While
   * it is set the session is unresolved (the engine may still be starting
   * after an app restart), and the next prompt or completed turn resolves it.
   */
  start: { root: string; engine: ArchiveEngineReads } | null;
  /** A start step is queued or running. */
  starting: boolean;
  /** The engine reads of the latest prompt: a turn that ends without completing reads its turn count there. */
  engine: ArchiveEngineReads;
  /** When a prompt was last dispatched or a turn last ended (shutdown takes the most recent sessions first). */
  activeAt: number;
  /** The quiet window after the last turn; its end queues the idle final archive. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Cancels the idle final archive while it is queued or packing: a new prompt ends the quiet period. */
  idleFinal: AbortController | null;
  /** Engine reads retried on their own while unresolved, and the retry waiting (see unresolved()). */
  retries?: { count: number; timer: ReturnType<typeof setTimeout> | null };
};

/** An unresolved session start reads the engine again after these waits, then only at its next prompt or turn. */
const UNRESOLVED_RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

export class ProjectArchiveLifecycle {
  private readonly archiver: ProjectArchiver;
  private readonly log: ArchiveLifecycleLog;
  private readonly concurrency: number;
  private readonly consentRecheckMs: number;
  private readonly baseIdleMs: number;
  private readonly baseMaxDeferMs: number;
  private readonly finalIdleMs: number;
  private readonly quitBudgetMs: number;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private signedOut = false;
  private stopped = false;
  /** Archiving is off for the account until then (428 / 503 archive_disabled). */
  private consentOffUntil = 0;
  /** Sessions handed to captureBase in this app run. */
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tails = new Map<string, Promise<void>>();
  /** Drains and the start-up clear, for settled(). */
  private readonly background = new Set<Promise<void>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** Final archives wait for a slot behind every other step. */
  private readonly waitingLow: Array<() => void> = [];
  /** When the last prompt was dispatched on any session: bases wait for a quiet period after it. */
  private lastPromptAt = 0;
  /** Bases waiting for the quiet period; stop() and signOut() wake them. */
  private readonly sleepers = new Set<() => void>();

  constructor(options: ProjectArchiveLifecycleOptions) {
    this.archiver = options.archiver;
    this.enabled = options.enabled;
    this.log = options.log;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.consentRecheckMs = options.consentRecheckMs ?? DEFAULT_CONSENT_RECHECK_MS;
    this.baseIdleMs = Math.max(0, options.baseIdleMs ?? 0);
    this.baseMaxDeferMs = Math.max(this.baseIdleMs, options.baseMaxDeferMs ?? this.baseIdleMs * 5);
    this.finalIdleMs = Math.max(0, options.finalIdleMs ?? FINAL_IDLE_MS);
    this.quitBudgetMs = Math.max(0, options.quitBudgetMs ?? QUIT_FINAL_BUDGET_MS);
    this.now = options.now ?? Date.now;
  }

  private get active(): boolean {
    return this.enabled && !this.signedOut && !this.stopped;
  }

  private get consentOff(): boolean {
    return this.now() < this.consentOffUntil;
  }

  /**
   * App start. With an account, resumes the uploads the last run left
   * unfinished, and checks the folders of recent sessions once for changes
   * made after their last archive (a final archive the last shutdown did not
   * get to, or edits while the app was closed). Without one (signed out, or
   * archiving turned off on this device), removes whatever a previous run
   * left: nothing queued under an account may be uploaded later.
   */
  start(): void {
    if (!this.enabled) {
      this.track(this.archiver.signOut().catch((error: unknown) => this.warn("clear", error)));
      return;
    }
    this.kick();
    this.track(this.archiver.startFinalCandidates().then((sessionIds) => {
      for (const sessionId of sessionIds) this.final(sessionId, "app_start");
    }, (error: unknown) => this.warn("start", error)));
  }

  /**
   * A prompt was dispatched on a local session. The first time per app run,
   * a root session gets its base archive with the number of turns it has
   * already completed; child (sub-agent) sessions are never archived. It
   * also ends the session's quiet period: its idle final archive is off.
   */
  sessionStarted(input: { sessionId: string; root: string; engine: ArchiveEngineReads }): void {
    const known = this.sessions.get(input.sessionId);
    if (known) this.cancelIdleFinal(known);
    if (!this.active || this.consentOff) return;
    const promptedAt = this.now();
    this.lastPromptAt = promptedAt;
    if (known) {
      known.engine = input.engine;
      known.activeAt = promptedAt;
    }
    // Resolved, or its start step is still queued: nothing to add.
    if (known && (!known.start || known.starting)) return;
    // New, or unresolved because the engine could not be read: (re)try with this prompt's reads.
    const record: SessionRecord = known ?? { root: null, start: null, starting: false, engine: input.engine, activeAt: promptedAt, idleTimer: null, idleFinal: null };
    record.start = { root: input.root, engine: input.engine };
    record.starting = true;
    this.sessions.set(input.sessionId, record);
    this.schedule(input.sessionId, "base", async () => {
      try {
        if (this.sessions.get(input.sessionId) === record && record.start) await this.resolve(input.sessionId, record, null);
      } finally {
        record.starting = false;
      }
    }, () => this.quietPeriod(promptedAt));
  }

  /**
   * The session settled after a turn. `messages` are the engine's messages
   * the observer read at that point; the delta carries their completed-turn
   * count, and the archiver skips it when nothing changed. Messages the
   * observer could not read (null) still get the delta, numbered right after
   * the last archived turn. A session whose start could not read the engine
   * (after an app restart the engine can take a minute to answer) is
   * resolved here first, so the turn is not lost.
   */
  turnCompleted(sessionId: string, messages: unknown): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record) return;
    const turns = completedTurnCount(messages);
    this.schedule(sessionId, "delta", async () => {
      if (this.sessions.get(sessionId) !== record) return;
      if (record.start && !(await this.resolve(sessionId, record, turns))) return;
      await this.captureTurn(sessionId, record, turns);
    });
    this.armIdleFinal(sessionId, record);
  }

  /**
   * The observer follows a turn of the session: it is not quiet. A turn that
   * ended just before (its turnCompleted can come after the next prompt's
   * sessionStarted, when that prompt went out while the turn settled) must
   * not leave its idle final archive armed through this turn, however long
   * it runs; this turn's own end arms the next one.
   */
  turnFollowed(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) this.cancelIdleFinal(record);
  }

  /**
   * The observer stopped following the session's turn without seeing it
   * complete: past its 24-hour safety bound, or on an unexpected error (an
   * engine that does not answer is waited out, and a server stop is not
   * this). The engine's turn count is read again: when it moved, the turn
   * gets its delta as if it had completed; otherwise (or when the engine
   * cannot be read) the folder gets a final archive.
   */
  turnIncomplete(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record) return;
    this.schedule(sessionId, "turn", async () => {
      if (this.sessions.get(sessionId) !== record) return;
      if (record.start && !(await this.resolve(sessionId, record, null))) return;
      if (!record.root) return;
      const turns = completedTurnCount(await record.engine.messages().catch(() => null));
      await this.captureTurn(sessionId, record, turns, turns === null);
    });
    this.armIdleFinal(sessionId, record);
  }

  /**
   * The session was deleted: a last final archive of its folder (when it
   * has a base and the folder is still there), then it is forgotten, with
   * its idle final and its start retry; the queue keeps uploading.
   */
  sessionEnded(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) this.release(record);
    this.sessions.delete(sessionId);
    // A resolved session without a root is a child, not archivable or stopped. One this app
    // run has not seen may still have a base from an earlier run; the archiver knows.
    if (this.active && !this.consentOff && (!record || record.root || record.start)) this.final(sessionId, "session_deleted");
    this.kick();
  }

  /**
   * The account signed out or was invalidated: nothing is captured or
   * uploaded any more, uploads in flight are aborted and every queued
   * archive and session record is deleted.
   */
  async signOut(): Promise<void> {
    this.signedOut = true;
    this.wakeSleepers();
    for (const record of this.sessions.values()) this.release(record);
    this.sessions.clear();
    await this.archiver.signOut().catch((error: unknown) => this.warn("sign-out", error));
  }

  /**
   * Server shutdown: no new steps, and the queue stays on disk for the next
   * start. Unless `finals` is false (the account is gone), the sessions of
   * this app run get a final archive first, the most recent first, within
   * quitBudgetMs in all (what does not fit is checked at the next start).
   */
  async stop(options: { finals?: boolean } = {}): Promise<void> {
    const finals = options.finals !== false && this.active && !this.consentOff && this.quitBudgetMs > 0
      ? [...this.sessions].filter(([, record]) => record.root || record.start).sort(([, left], [, right]) => right.activeAt - left.activeAt).map(([sessionId]) => sessionId)
      : [];
    this.stopped = true;
    this.wakeSleepers();
    for (const record of this.sessions.values()) this.release(record);
    await this.archiver.stop(finals.length > 0 ? { finals, budgetMs: this.quitBudgetMs } : {}).catch((error: unknown) => this.warn("stop", error));
  }

  /** Resolves once every scheduled step and drain has finished (tests). */
  async settled(): Promise<void> {
    while (this.tails.size > 0 || this.background.size > 0) await Promise.all([...this.tails.values(), ...this.background]);
  }

  /**
   * The start step: is it a root session (child sessions are never
   * archived), at which real path, and its base with `turns` completed turns
   * (read from the engine when null). The base is a no-op ("exists") when an
   * earlier app run captured it. False while the engine cannot be read: the
   * session stays unresolved, and is read again after a while (see
   * unresolved()) and at its next prompt or completed turn.
   */
  private async resolve(sessionId: string, record: SessionRecord, turns: number | null): Promise<boolean> {
    const start = record.start;
    if (!start) return true;
    const parent = parentSessionId(await start.engine.session().catch(() => null));
    if (parent === undefined) return this.unresolved(sessionId, record, "the engine session could not be read");
    if (parent !== null) {
      record.start = null;
      return true;
    }
    const root = await realpath(start.root).catch(() => null);
    if (!root) {
      record.start = null;
      return true;
    }
    const count = turns ?? completedTurnCount(await start.engine.messages().catch(() => null));
    if (count === null) return this.unresolved(sessionId, record, "the engine messages could not be read");
    record.start = null;
    record.root = root;
    const result = await this.archiver.captureBase(sessionId, root, count);
    if (result.status === "skipped" && result.reason === "disabled") this.sessions.delete(sessionId);
    if (result.status === "skipped" && (result.reason === "not_archivable" || result.reason === "stopped")) record.root = null;
    this.settle(result);
    return true;
  }

  /**
   * The capture at a turn's end: its delta, numbered with the engine's
   * completed-turn count (null: after the last archived turn). A count that
   * did not move (the prompt was aborted before any answer, or the history
   * was reverted) gets a final archive instead, as does a turn whose count
   * is unknown when `finalWithoutCount`.
   */
  private async captureTurn(sessionId: string, record: SessionRecord, turns: number | null, finalWithoutCount = false): Promise<void> {
    if (!record.root || this.sessions.get(sessionId) !== record || this.consentOff) return;
    let result: CaptureResult | null = null;
    if (!finalWithoutCount) {
      result = await this.archiver.captureDelta(sessionId, record.root, turns);
      if (result.status === "skipped" && result.reason === "stopped") record.root = null;
      this.settle(result);
    }
    if (result && !(result.status === "skipped" && result.reason === "stale_turn")) return;
    if (!record.root || this.consentOff) return;
    const final = await this.archiver.captureFinal(sessionId, "turn_incomplete");
    if (final.status === "skipped" && final.reason === "stopped") record.root = null;
    this.settle(final);
  }

  /**
   * Queues a final archive for the session, behind its earlier steps and
   * behind other sessions' waiting steps. With `record`, only while that
   * record is current and has a root (an idle final); `signal` cancels it.
   */
  private final(sessionId: string, reason: FinalReason, record?: SessionRecord, signal?: AbortSignal): void {
    this.schedule(sessionId, "final", async () => {
      if (signal?.aborted || this.consentOff) return;
      if (record && (this.sessions.get(sessionId) !== record || !record.root)) return;
      const result = await this.archiver.captureFinal(sessionId, reason, signal ? { signal } : {});
      if (record && result.status === "skipped" && result.reason === "stopped") record.root = null;
      this.settle(result);
    }, undefined, true);
  }

  /** A turn ended: the quiet window starts; without a prompt by its end, an idle final archive is queued. At most one per window. */
  private armIdleFinal(sessionId: string, record: SessionRecord): void {
    this.cancelIdleFinal(record);
    record.activeAt = this.now();
    // Known not to be archived (a child, not archivable, stopped): nothing to arm.
    if (!record.root && !record.start) return;
    const timer = setTimeout(() => {
      if (record.idleTimer !== timer) return;
      record.idleTimer = null;
      if (!this.active || this.sessions.get(sessionId) !== record) return;
      const controller = new AbortController();
      record.idleFinal = controller;
      this.final(sessionId, "idle", record, controller.signal);
    }, this.finalIdleMs);
    timer.unref?.();
    record.idleTimer = timer;
  }

  private cancelIdleFinal(record: SessionRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = null;
    record.idleFinal?.abort();
    record.idleFinal = null;
  }

  /** An unresolved start's retry waiting, if any, never runs. */
  private cancelRetry(record: SessionRecord): void {
    if (record.retries?.timer) clearTimeout(record.retries.timer);
    if (record.retries) record.retries.timer = null;
  }

  /** The session is forgotten (deleted, signed out, shutdown): none of its timers runs any more. */
  private release(record: SessionRecord): void {
    this.cancelIdleFinal(record);
    this.cancelRetry(record);
  }

  /**
   * The engine could not be read for a session start (it can still be
   * starting, or be busy with a large session). Besides the session's next
   * prompt or completed turn, the start step runs again on its own after 1, 2,
   * 5 and 10 minutes, so a session whose first turn runs for hours still gets
   * its base; one retry waits at a time, and none once the session is
   * forgotten or archiving stopped.
   */
  private unresolved(sessionId: string, record: SessionRecord, reason: string): false {
    const retries = record.retries ??= { count: 0, timer: null };
    const current = this.active && this.sessions.get(sessionId) === record;
    const delay = retries.timer || !current ? undefined : UNRESOLVED_RETRY_DELAYS_MS[retries.count];
    if (delay !== undefined) {
      retries.count += 1;
      retries.timer = setTimeout(() => {
        retries.timer = null;
        if (!this.active || this.consentOff || this.sessions.get(sessionId) !== record || !record.start || record.starting) return;
        record.starting = true;
        this.schedule(sessionId, "base", async () => {
          try {
            if (this.sessions.get(sessionId) === record && record.start) await this.resolve(sessionId, record, null);
          } finally {
            record.starting = false;
          }
        });
      }, delay);
      retries.timer.unref?.();
    }
    this.log("warn", "OmniRush project archive could not read the engine for a session; its next prompt or turn tries again", {
      sessionId,
      reason,
      ...(delay !== undefined ? { retryInMs: delay } : {}),
    });
    return false;
  }

  private settle(result: CaptureResult): void {
    if (result.status === "queued") {
      this.consentOffUntil = 0;
      this.kick();
    } else if (result.reason === "disabled") {
      this.archivingOff();
    }
  }

  /** Off quietly: no capture, consent check or upload until the recheck time (or the next app start). */
  private archivingOff(): void {
    this.consentOffUntil = this.now() + this.consentRecheckMs;
  }

  /** Starts a drain unless one is running (the archiver coalesces them). */
  private kick(): void {
    if (!this.active || this.consentOff) return;
    this.track(this.archiver.drain()
      .then((result: DrainResult) => {
        if (result.disabled) this.archivingOff();
      })
      .catch((error: unknown) => this.warn("drain", error)));
  }

  private track(work: Promise<void>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /**
   * Resolves once no prompt has been dispatched for baseIdleMs, or
   * baseMaxDeferMs after `since`, or when archiving stops. Waiting takes no
   * concurrency slot, so other sessions' deltas go ahead meanwhile.
   */
  private async quietPeriod(since: number): Promise<void> {
    if (this.baseIdleMs === 0) return;
    while (this.active) {
      const now = this.now();
      const wait = Math.min(this.lastPromptAt + this.baseIdleMs, since + this.baseMaxDeferMs) - now;
      if (wait <= 0) return;
      await new Promise<void>((resolvePromise) => {
        const wake = () => {
          clearTimeout(timer);
          this.sleepers.delete(wake);
          resolvePromise();
        };
        const timer = setTimeout(wake, wait);
        timer.unref?.();
        this.sleepers.add(wake);
      });
    }
  }

  private wakeSleepers(): void {
    for (const wake of [...this.sleepers]) wake();
  }

  /**
   * Runs `task` after the session's earlier steps and `before` (a wait that
   * never rejects), within the concurrency bound (a `low` step lets every
   * other waiting step go first); never rejects.
   */
  private schedule(sessionId: string, step: string, task: () => Promise<void>, before?: () => Promise<void>, low = false): void {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(before).then(() => this.bounded(async () => {
      if (!this.active) return;
      try {
        await task();
      } catch (error) {
        this.warn(step, error, sessionId);
      }
    }, low));
    this.tails.set(sessionId, run);
    void run.then(() => {
      if (this.tails.get(sessionId) === run) this.tails.delete(sessionId);
    });
  }

  private async bounded(task: () => Promise<void>, low = false): Promise<void> {
    if (this.running < this.concurrency) this.running += 1;
    else await new Promise<void>((resolvePromise) => (low ? this.waitingLow : this.waiting).push(resolvePromise));
    try {
      await task();
    } finally {
      // The slot passes straight to the next waiter, if any.
      const next = this.waiting.shift() ?? this.waitingLow.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  private warn(step: string, error: unknown, sessionId?: string): void {
    this.log("warn", "OmniRush project archive step failed", { step, ...(sessionId ? { sessionId } : {}), error: errorSummary(error) });
  }
}
