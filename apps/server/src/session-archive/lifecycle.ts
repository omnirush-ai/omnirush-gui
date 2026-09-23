/**
 * The project archive's place in the embedded server's session lifecycle
 * (README "Wiring"). Every method returns at once: engine reads and captures
 * run in the background, a bounded number at a time (one by default), and one
 * session's steps always run in call order. A base can wait for a quiet
 * period after the last prompt (baseIdleMs), so a burst of chats opened and
 * prompted one after another is packed once the burst is over. Nothing here
 * throws into the request path; an unexpected failure costs one warn line.
 */
import { realpath } from "node:fs/promises";

import type { CaptureResult, DrainResult, SessionArchiver } from "./index.js";

export type ProjectArchiver = Pick<SessionArchiver, "captureBase" | "captureDelta" | "drain" | "signOut" | "stop">;

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
  /** Tests. */
  now?: () => number;
};

const DEFAULT_CONSENT_RECHECK_MS = 10 * 60_000;

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
   * unfinished. Without one (signed out, or archiving turned off on this
   * device), removes whatever a previous run left: nothing queued under an
   * account may be uploaded later.
   */
  start(): void {
    if (this.enabled) this.kick();
    else this.track(this.archiver.signOut().catch((error: unknown) => this.warn("clear", error)));
  }

  /**
   * A prompt was dispatched on a local session. The first time per app run,
   * a root session gets its base archive with the number of turns it has
   * already completed; child (sub-agent) sessions are never archived.
   */
  sessionStarted(input: { sessionId: string; root: string; engine: ArchiveEngineReads }): void {
    if (!this.active || this.consentOff) return;
    const promptedAt = this.now();
    this.lastPromptAt = promptedAt;
    const known = this.sessions.get(input.sessionId);
    // Resolved, or its start step is still queued: nothing to add.
    if (known && (!known.start || known.starting)) return;
    // New, or unresolved because the engine could not be read: (re)try with this prompt's reads.
    const record: SessionRecord = known ?? { root: null, start: null, starting: false };
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
      if (!record.root || this.sessions.get(sessionId) !== record || this.consentOff) return;
      const result = await this.archiver.captureDelta(sessionId, record.root, turns);
      if (result.status === "skipped" && result.reason === "stopped") record.root = null;
      this.settle(result);
    });
  }

  /** The session was deleted: nothing to capture, the queue keeps uploading. */
  sessionEnded(sessionId: string): void {
    this.sessions.delete(sessionId);
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
    this.sessions.clear();
    await this.archiver.signOut().catch((error: unknown) => this.warn("sign-out", error));
  }

  /** Server shutdown: no new steps; the queue stays on disk for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeSleepers();
    await this.archiver.stop().catch((error: unknown) => this.warn("stop", error));
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
   * The engine could not be read for a session start (it can still be
   * starting, or be busy with a large session). Besides the session's next
   * prompt or completed turn, the start step runs again on its own after 1, 2,
   * 5 and 10 minutes, so a session whose first turn runs for hours still gets
   * its base; one retry waits at a time.
   */
  private unresolved(sessionId: string, record: SessionRecord, reason: string): false {
    const retries = record.retries ??= { count: 0, timer: null };
    const delay = retries.timer ? undefined : UNRESOLVED_RETRY_DELAYS_MS[retries.count];
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
   * never rejects), within the concurrency bound; never rejects.
   */
  private schedule(sessionId: string, step: string, task: () => Promise<void>, before?: () => Promise<void>): void {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(before).then(() => this.bounded(async () => {
      if (!this.active) return;
      try {
        await task();
      } catch (error) {
        this.warn(step, error, sessionId);
      }
    }));
    this.tails.set(sessionId, run);
    void run.then(() => {
      if (this.tails.get(sessionId) === run) this.tails.delete(sessionId);
    });
  }

  private async bounded(task: () => Promise<void>): Promise<void> {
    if (this.running < this.concurrency) this.running += 1;
    else await new Promise<void>((resolvePromise) => this.waiting.push(resolvePromise));
    try {
      await task();
    } finally {
      // The slot passes straight to the next waiter, if any.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  private warn(step: string, error: unknown, sessionId?: string): void {
    this.log("warn", "OmniRush project archive step failed", { step, ...(sessionId ? { sessionId } : {}), error: errorSummary(error) });
  }
}
