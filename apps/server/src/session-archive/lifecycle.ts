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
import type { MediaRecord } from "./media-store.js";
import { realpath } from "node:fs/promises";

import { attachmentsFromMessages } from "./attachments.js";
import type { StartCapture } from "./capture-v2.js";
import { completedTurnCount, isPromptMessage, promptTurnAt, steerPrompts } from "./turn-prompts.js";
import type { CaptureResult, DrainResult, FilesUsedStatus, FinalReason, SessionArchiver } from "./index.js";
import type { UsedToolCall } from "./files-used.js";

export type ProjectArchiver = Pick<
  SessionArchiver,
  "captureBase" | "captureDelta" | "captureFinal" | "startFinalCandidates" | "recordTouched" | "forgetTouched" | "drain" | "signOut" | "stop"
> & Partial<Pick<SessionArchiver, "claimAccount" | "discardAll" | "pendingStatus" | "startManifest" | "hasStartManifest" | "captureState" | "recordAttachments" | "recordMedia" | "recordBinary" | "filesUsedToolCallEnded" | "filesUsedTurnStarted" | "filesUsedTurnEnded" | "filesUsedMaybe" | "filesUsedStatus" | "touchedBaseDue">>;

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
  /**
   * No account is connected (a sign-in the server retired, or none yet):
   * the queue on disk waits for it rather than being removed.
   */
  accountMissing?: boolean;
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
  /** A touched-files session's base is taken this long after its first touched path (TOUCHED_BASE_DELAY_MS). */
  touchedBaseDelayMs?: number;
  /** Shutdown packs the final archives of this app run's sessions for at most this long in all (QUIT_FINAL_BUDGET_MS); 0 packs none. */
  quitBudgetMs?: number;
  /** A prompt waits at most this long for the turn before's delta (TURN_DELTA_WAIT_MS). */
  turnDeltaWaitMs?: number;
  /** Tests. */
  now?: () => number;
  /** A pre_tool state took files written after the turn before ended (the session uploader records them). */
  onLateWrites?: (late: LateWrites) => void;
  /**
   * What became of a session's base (its starting project copy): archived
   * (or held from an earlier run), deferred (touched-files mode: taken with
   * the first edit), or skipped with the reason. The session uploader
   * records it in the session's upload, so no missing base goes unexplained.
   */
  onProjectArchive?: (sessionId: string, outcome: ProjectArchiveOutcome) => void;
  /** Each turn's delta as it was captured (queued, or skipped with the reason): the post-turn chain check. */
  onTurnArchive?: (sessionId: string, result: CaptureResult) => void;
};

export type ProjectArchiveOutcome = {
  status: "archived" | "deferred" | "skipped";
  /** Skipped: why (a CaptureSkipReason, or archive_off, consent_off, root_missing, disk_budget). */
  reason?: string;
  /** More precisely (the gate's reason, the server's code, the bytes it needed). */
  detail?: string;
};

/** A base's capture result as a ProjectArchiveOutcome; null for a result that says nothing yet (unavailable is retried). */
export function projectArchiveOutcome(result: CaptureResult): ProjectArchiveOutcome | null {
  if (result.status === "queued") return { status: "archived" };
  if (result.status === "paused") return { status: "skipped", reason: "disk_budget", detail: `needs_${result.requiredBytes}_bytes` };
  if (result.reason === "exists") return { status: "archived", detail: "earlier_run" };
  if (result.reason === "unchanged") return { status: "deferred", reason: "touched_files_lazy" };
  return { status: "skipped", reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
}

/** A base the server's folder policy could not be asked for: not a refusal, the start step runs again (next prompt, turn or retry timer). */
export function baseRetried(result: CaptureResult): boolean {
  return result.status === "skipped" && result.reason === "unavailable" && result.detail === "policy_unavailable";
}

const DEFAULT_CONSENT_RECHECK_MS = 10 * 60_000;
/** The quiet window after a turn: with no new prompt by then, the session gets a final archive. */
export const FINAL_IDLE_MS = 10 * 60_000;
/** A touched-files base this long after the session's first touched path (its paths are on disk within 2 s). */
export const TOUCHED_BASE_DELAY_MS = 30_000;
/**
 * What shutdown spends, at most, packing final archives (the desktop app
 * waits for the server to stop before it quits). What does not fit is
 * checked at the next app start.
 */
export const QUIT_FINAL_BUDGET_MS = 5_000;
/**
 * How long a prompt waits at most for the turn before (the observer's settle,
 * then that turn's delta) when that turn ended a moment ago (startGate).
 */
export const TURN_DELTA_WAIT_MS = 5_000;
/** The prompt times kept per session (promptTimes). */
const PROMPT_TIMES_KEPT = 8;

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

export { completedTurnCount, isPromptMessage, promptTurnAt, steerPrompts } from "./turn-prompts.js";

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
  /** Capture v2: the completed turns last counted (the turn in progress is the next one). */
  turns?: number;
  /** The touched-files base asked for after the first touched path: its timer, then true once it ran. */
  touchedBase?: ReturnType<typeof setTimeout> | true;
  /** Capture v2: a prompt went out and this turn's first tool call has not been seen yet. */
  awaitingTool?: boolean;
  /** When the latest prompt, and the one before it, were dispatched. */
  promptedAt?: number;
  previousPromptAt?: number;
  /** When a turn of the session last settled (turnCompleted / turnIncomplete). */
  endedAt?: number;
  /** When this run's latest prompts went out (the newest last; a turn delta's cut is the first one after its turn ended). */
  promptTimes?: number[];
  /** The latest turn delta queued, until it ran (a prompt's gate waits for it). */
  pendingDelta?: Promise<void> | null;
  /** Prompt gates waiting for the observer to settle the turn before. */
  settleWaiters?: Array<() => void>;
};

/** A pre_tool state that took late writes of the turn before (lifecycle onLateWrites). */
export type LateWrites = {
  sessionId: string;
  /** The turn in progress, whose start the files are part of; the turn before wrote them. */
  turn: number;
  /** When the turn before ended (or, for a prompt sent into a running turn, when that prompt went out). */
  after: number;
  /** When this turn's first tool call started. */
  toolStartAt: number;
  paths: string[];
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
  private readonly touchedBaseDelayMs: number;
  private readonly quitBudgetMs: number;
  private readonly turnDeltaWaitMs: number;
  private readonly now: () => number;
  private readonly onLateWrites: ((late: LateWrites) => void) | undefined;
  private readonly onProjectArchive: ((sessionId: string, outcome: ProjectArchiveOutcome) => void) | undefined;
  private readonly onTurnArchive: ((sessionId: string, result: CaptureResult) => void) | undefined;
  private readonly enabled: boolean;
  private readonly accountMissing: boolean;
  private signedOut = false;
  private stopped = false;
  /** Archiving is off for the account until then (428 / 503 archive_disabled). */
  private consentOffUntil = 0;
  /** The run is ending: bases stop waiting for their quiet period (baseSettled). */
  private hurried = false;
  /** Sessions told their base is off for this run (archive_off, consent_off): once each. */
  private readonly offReported = new Set<string>();
  /** Sessions handed to captureBase in this app run. */
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tails = new Map<string, Promise<void>>();
  /** Drains and the start-up clear, for settled(). */
  private readonly background = new Set<Promise<void>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** Final archives wait for a slot behind every other step. */
  private readonly waitingLow: Array<() => void> = [];
  /** A turn delta a prompt may be waiting for (startGate) goes ahead of other sessions' steps. */
  private readonly waitingHigh: Array<() => void> = [];
  /** When the last prompt was dispatched on any session: bases wait for a quiet period after it. */
  private lastPromptAt = 0;
  /** Bases waiting for the quiet period; stop() and signOut() wake them. */
  private readonly sleepers = new Set<() => void>();

  constructor(options: ProjectArchiveLifecycleOptions) {
    this.archiver = options.archiver;
    this.enabled = options.enabled;
    this.accountMissing = options.accountMissing === true;
    this.log = options.log;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.consentRecheckMs = options.consentRecheckMs ?? DEFAULT_CONSENT_RECHECK_MS;
    this.baseIdleMs = Math.max(0, options.baseIdleMs ?? 0);
    this.baseMaxDeferMs = Math.max(this.baseIdleMs, options.baseMaxDeferMs ?? this.baseIdleMs * 5);
    this.finalIdleMs = Math.max(0, options.finalIdleMs ?? FINAL_IDLE_MS);
    this.touchedBaseDelayMs = Math.max(0, options.touchedBaseDelayMs ?? TOUCHED_BASE_DELAY_MS);
    this.quitBudgetMs = Math.max(0, options.quitBudgetMs ?? QUIT_FINAL_BUDGET_MS);
    this.turnDeltaWaitMs = Math.max(0, options.turnDeltaWaitMs ?? TURN_DELTA_WAIT_MS);
    this.now = options.now ?? Date.now;
    this.onLateWrites = options.onLateWrites;
    this.onProjectArchive = options.onProjectArchive;
    this.onTurnArchive = options.onTurnArchive;
  }

  private reportArchive(sessionId: string, outcome: ProjectArchiveOutcome | null): void {
    if (!outcome) return;
    try {
      this.onProjectArchive?.(sessionId, outcome);
    } catch (error) {
      this.warn("report", error);
    }
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
   * get to, or edits while the app was closed); a queue another account left
   * is set aside for it first (claimAccount, account-park.ts). Without an
   * account the queue waits for it (a user's sign-out keeps it too); with
   * archiving turned off on this device it is removed.
   */
  start(): void {
    if (!this.enabled) {
      // Archiving turned off on this device: what is queued goes (a signed-out start keeps it for its account).
      if (!this.accountMissing) this.track((this.archiver.discardAll ?? this.archiver.signOut).call(this.archiver).catch((error: unknown) => this.warn("clear", error)));
      return;
    }
    this.track((async () => {
      await this.archiver.claimAccount?.().catch((error: unknown) => this.warn("account", error));
      this.kick();
      const sessionIds = await this.archiver.startFinalCandidates();
      for (const sessionId of sessionIds) this.final(sessionId, "app_start");
    })().catch((error: unknown) => this.warn("start", error)));
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
    if (!this.active || this.consentOff) {
      if (!known && !this.stopped && !this.offReported.has(input.sessionId)) {
        this.offReported.add(input.sessionId);
        this.reportArchive(input.sessionId, { status: "skipped", reason: this.consentOff ? "consent_off" : this.signedOut ? "signed_out" : "archive_off" });
      }
      return;
    }
    const promptedAt = this.now();
    this.lastPromptAt = promptedAt;
    if (known) {
      known.engine = input.engine;
      known.activeAt = promptedAt;
      known.awaitingTool = true;
      known.previousPromptAt = known.promptedAt;
      known.promptedAt = promptedAt;
      known.promptTimes = [...(known.promptTimes ?? []), promptedAt].slice(-PROMPT_TIMES_KEPT);
    }
    // Resolved, or its start step is still queued: nothing to add.
    if (known && (!known.start || known.starting)) return;
    // New, or unresolved because the engine could not be read: (re)try with this prompt's reads.
    const record: SessionRecord = known ?? { root: null, start: null, starting: false, engine: input.engine, activeAt: promptedAt, idleTimer: null, idleFinal: null, awaitingTool: true, promptedAt, promptTimes: [promptedAt] };
    record.start = { root: input.root, engine: input.engine };
    record.starting = true;
    this.sessions.set(input.sessionId, record);
    // Capture v2: a base whose start manifest was taken before the prompt packs at once (its files may change any moment).
    const immediate = this.archiver.hasStartManifest?.(input.sessionId) === true;
    this.schedule(input.sessionId, "base", async () => {
      try {
        if (this.sessions.get(input.sessionId) === record && record.start) await this.resolve(input.sessionId, record, null);
      } finally {
        record.starting = false;
      }
    }, immediate ? undefined : () => this.quietPeriod(promptedAt));
  }

  /**
   * Capture v2, #8: call before a prompt is sent to the engine, and send it
   * once this resolves. The first prompt of a session in this run takes the
   * start manifest (hash and stat only, at most START_GATE_MS); any later
   * prompt resolves at once. Never rejects.
   */
  async startGate(sessionId: string, root: string, options: { previousEnded?: boolean } = {}): Promise<StartCapture | "skipped"> {
    if (options.previousEnded) await this.previousTurnArchived(sessionId);
    if (!this.active || this.consentOff || !this.archiver.startManifest) return "skipped";
    const known = this.sessions.get(sessionId);
    if (known && !known.start) return "skipped";
    try {
      return await this.archiver.startManifest(sessionId, root);
    } catch (error) {
      this.warn("start-manifest", error, sessionId);
      return "skipped";
    }
  }

  /**
   * Capture v2, #9: a tool call of the session started (tool-start.ts) at
   * `at` (the engine's event time when it has one). The first one of each
   * turn queues a pre_tool state, captured when anything changed since the
   * chain's last state; the tool itself is never held, so a file changed at
   * or after `at` (the tool's own writes) is left out of it and goes to the
   * turn's delta. What changed between the chain's last state and `at`
   * (a background process of the turn before still writing, the user's own
   * edits) is in it, marked `late_writes` when the turn before had ended.
   * The state is numbered with the prompt the tool answers, read from the
   * engine: a prompt sent before the previous turn settled is a turn of its
   * own.
   */
  toolStarted(sessionId: string, at: number = this.now()): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record || !record.awaitingTool || !this.archiver.captureState) return;
    record.awaitingTool = false;
    // Late: written after the turn before ended; for a prompt sent into a running turn (no end in between), after that prompt.
    const ended = record.endedAt !== undefined && (record.previousPromptAt === undefined || record.endedAt >= record.previousPromptAt) ? record.endedAt : undefined;
    // A turn this prompt cut settles after the prompt went out (the observer reads it then): it ended at the prompt at the latest.
    const lateAfter = ended !== undefined
      ? (record.promptedAt !== undefined ? Math.min(ended, record.promptedAt) : ended)
      : record.previousPromptAt !== undefined ? record.promptedAt : undefined;
    const capture = this.archiver.captureState.bind(this.archiver);
    this.schedule(sessionId, "pre_tool", async () => {
      if (this.sessions.get(sessionId) !== record || !record.root) return;
      const turn = promptTurnAt(await record.engine.messages().catch(() => null), at) ?? (record.turns ?? 0) + 1;
      const result = await capture(sessionId, turn, { before: at, ...(lateAfter !== undefined ? { lateAfter } : {}) });
      if (result.status === "queued" && result.late && result.late.length > 0 && lateAfter !== undefined) {
        try {
          this.onLateWrites?.({ sessionId, turn, after: lateAfter, toolStartAt: at, paths: result.late });
        } catch {
          // Bookkeeping only.
        }
      }
      if (result.status === "skipped" && result.reason === "stopped") record.root = null;
      this.settle(result);
    });
  }

  /**
   * Capture v2, #11: a settled turn's messages; the files attached to its
   * user messages are staged for the turn's archive (queued before its delta).
   */
  turnMessages(sessionId: string, messages: unknown): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record || !this.archiver.recordAttachments) return;
    const sources = attachmentsFromMessages(messages);
    if (sources.length === 0) return;
    const stage = this.archiver.recordAttachments.bind(this.archiver);
    this.schedule(sessionId, "attachments", async () => {
      if (this.sessions.get(sessionId) !== record) return;
      const root = record.root ?? record.start?.root;
      if (root) await stage(sessionId, root, sources);
    });
  }

  /** Screenshots of the chat's tool results (computer-use/media-capture.ts), staged for its next archive under `__media__/`. */
  mediaFiles(sessionId: string, records: readonly MediaRecord[]): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record || !this.archiver.recordMedia) return;
    const stage = this.archiver.recordMedia.bind(this.archiver);
    this.schedule(sessionId, "media", async () => {
      if (this.sessions.get(sessionId) !== record) return;
      await stage(sessionId, records);
    });
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
  turnCompleted(sessionId: string, messages: unknown, idleAt: number | null = null): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record) return;
    const turns = completedTurnCount(messages);
    if (turns !== null) record.turns = turns;
    record.endedAt = this.now();
    // The next prompt, when it went out before this delta's scan ended, cuts the delta there (captureDelta
    // `before`, read when the scan ends): the first prompt after the one that opened this turn (its message's
    // creation time in the engine), else after the engine went idle.
    const span = turns !== null ? turnSpan(messages, turns) : null;
    const cut = () => {
      const times = record.promptTimes ?? [];
      // The engine's times only count when this run sent that turn's prompt before it (the same clock). A prompt
      // sent while the turn still answered (a steer the classifier let through) is not the next one.
      const after = span !== null && times.some((at) => at <= span.opened) ? Math.max(span.opened, span.answered ?? span.opened) : idleAt;
      return after === null ? undefined : times.find((at) => at > after);
    };
    const delta = this.schedule(sessionId, "delta", async () => {
      if (this.sessions.get(sessionId) !== record) return;
      if (record.start && !(await this.resolve(sessionId, record, turns))) return;
      await this.captureTurn(sessionId, record, turns, false, cut);
    }, undefined, false, true);
    record.pendingDelta = delta;
    void delta.then(() => { if (record.pendingDelta === delta) record.pendingDelta = null; });
    this.turnSettled(record);
    this.armIdleFinal(sessionId, record);
  }

  /**
   * The session uploader saw the session touch a path (workspace-relative): a
   * tool's path in the trace, or a change on disk. Kept for a touched-files
   * session (the archiver drops it for any other); nothing for a session
   * this app run has not started or knows is not archived.
   */
  pathTouched(sessionId: string, path: string): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record || (!record.root && !record.start)) return;
    this.archiver.recordTouched(sessionId, path);
    // A touched-files base waited for the turn's end (hours on a long first turn, a day when the app quit first).
    if (record.root && !record.touchedBase && this.archiver.touchedBaseDue) {
      const timer = setTimeout(() => {
        record.touchedBase = true;
        this.schedule(sessionId, "final", async () => {
          if (this.consentOff || this.sessions.get(sessionId) !== record || !record.root) return;
          if (!(await this.archiver.touchedBaseDue?.(sessionId))) return;
          this.settle(await this.archiver.captureFinal(sessionId, "first_touch"));
        }, undefined, true);
      }, this.touchedBaseDelayMs);
      timer.unref?.();
      record.touchedBase = timer;
    }
  }

  /** Capture v2: a binary file the session uploader found in the session's workspace (workspace-relative). */
  binaryFile(sessionId: string, path: string): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record || (!record.root && !record.start)) return;
    this.archiver.recordBinary?.(sessionId, path);
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
    // Files used: the turn's start time, for its end-of-turn snapshot (nothing is read now).
    if (record && this.active && !this.consentOff) this.archiver.filesUsedTurnStarted?.(sessionId);
  }

  /** Files used, for the app's one-time notice: what omnirush.ai says. Never rejects. */
  async filesUsedStatus(): Promise<FilesUsedStatus> {
    try {
      if (this.archiver.filesUsedStatus) return await this.archiver.filesUsedStatus();
    } catch (error) {
      this.warn("files-used", error);
    }
    return { active: null, available: null, consentText: null };
  }

  /** Files used: whether tool calls are worth following now (the account's last answer). */
  filesUsedMaybe(): boolean {
    return this.active && !this.consentOff && this.archiver.filesUsedMaybe?.() === true;
  }

  /**
   * Files used: one tool call of the session ended. The temp files it named
   * or made and the allowlisted home config it read are kept right away (a
   * scratch file deleted later in the turn is not lost); this is not a step
   * of the session's queue, so a capture in progress does not hold it.
   */
  toolCallEnded(sessionId: string, call: UsedToolCall): void {
    const record = this.sessions.get(sessionId);
    const root = record?.root ?? record?.start?.root;
    if (!this.active || this.consentOff || !record || !root || !this.archiver.filesUsedToolCallEnded) return;
    this.track(this.archiver.filesUsedToolCallEnded(sessionId, root, call));
  }

  /**
   * Files used: a settled turn's messages. Every file its tool calls used is
   * listed for the turn's state, queued ahead of its delta (call before
   * turnCompleted), with the end-of-turn snapshot of the project.
   */
  turnFilesUsed(sessionId: string, messages: unknown): void {
    const record = this.sessions.get(sessionId);
    if (!this.active || this.consentOff || !record || !this.archiver.filesUsedTurnEnded) return;
    const ended = this.archiver.filesUsedTurnEnded.bind(this.archiver);
    this.schedule(sessionId, "files_used", async () => {
      if (this.sessions.get(sessionId) !== record) return;
      const root = record.root ?? record.start?.root;
      if (root) await ended(sessionId, root, messages);
    });
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
    record.endedAt = this.now();
    this.turnSettled(record);
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
   * A prompt of the session is about to go out right after the turn before
   * ended (startGate, `previousEnded`): that turn's delta is taken first, so it
   * holds the folder as the turn left it. The prompt waits for the observer
   * to settle that turn (it settles a moment after the engine goes idle, and
   * queues the turn's attachments, files used and delta in order), then for
   * that delta, at most turnDeltaWaitMs in all. A prompt that goes out
   * before the delta ran (the wait ended) still never gives it a later write:
   * the delta is cut at the prompt (turnCompleted). Sessions whose turn
   * before was archived wait for nothing and read nothing. Never rejects.
   */
  private async previousTurnArchived(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    // A base still queued (it may wait for a quiet period) would hold the prompt: the cut covers that turn instead.
    if (!this.active || this.consentOff || !record || !record.root || record.start || record.starting) return;
    const settled = record.endedAt !== undefined && record.promptedAt !== undefined && record.endedAt >= record.promptedAt;
    if (settled && !record.pendingDelta) return;
    const startedAt = Date.now();
    const gate = async () => {
      if (!settled) await new Promise<void>((resolveSettle) => (record.settleWaiters ??= []).push(resolveSettle));
      await record.pendingDelta;
    };
    const waited = await withDeadline(gate(), this.turnDeltaWaitMs).then(() => true, () => false);
    if (!waited) this.log("info", "OmniRush project archive: a prompt went out before the turn before's delta; the delta is cut at the prompt", { sessionId, waitedMs: Date.now() - startedAt });
  }

  /** The observer settled a turn of the session (turnCompleted / turnIncomplete): prompt gates waiting for it go on. */
  private turnSettled(record: SessionRecord): void {
    const waiters = record.settleWaiters ?? [];
    record.settleWaiters = [];
    for (const waiter of waiters) waiter();
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

  /** Queued archives now (a sign-out first sends what it can). */
  async pendingStatus(): Promise<{ jobs: number }> {
    return this.archiver.pendingStatus ? this.archiver.pendingStatus() : { jobs: 0 };
  }

  /** Sends what is queued now (before a sign-out); resolves when that drain ends. */
  async drainNow(): Promise<void> {
    if (!this.active) return;
    await this.archiver.drain();
  }

  /**
   * The account signed out or was invalidated: nothing is captured or
   * uploaded any more in this app run and uploads in flight stop. The queue
   * and the session records stay on disk for that account (account-park.ts).
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

  /**
   * The run is ending: a base still waiting for its quiet period is taken
   * now. Resolves once the session's queued steps ran (callers bound the
   * wait), so its outcome (onProjectArchive) is known before its end goes out.
   */
  async baseSettled(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    // Nothing waiting (resolved) and nothing running.
    if (!record || (!record.start && !record.starting)) return;
    this.hurried = true;
    this.wakeSleepers();
    await this.tails.get(sessionId)?.catch(() => undefined);
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
      this.archiver.forgetTouched(sessionId);
      return true;
    }
    const root = await realpath(start.root).catch(() => null);
    if (!root) {
      record.start = null;
      this.reportArchive(sessionId, { status: "skipped", reason: "root_missing" });
      return true;
    }
    const count = turns ?? completedTurnCount(await start.engine.messages().catch(() => null));
    if (count === null) return this.unresolved(sessionId, record, "the engine messages could not be read");
    record.turns ??= count;
    record.start = null;
    record.root = root;
    const result = await this.archiver.captureBase(sessionId, root, count);
    this.reportArchive(sessionId, projectArchiveOutcome(result));
    if (result.status === "paused" || baseRetried(result)) {
      record.start = { root, engine: start.engine };
      this.unresolved(sessionId, record, result.status === "paused" ? `archive paused: ${result.reason}` : "the folder policy could not be asked");
    }
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
  private async captureTurn(sessionId: string, record: SessionRecord, turns: number | null, finalWithoutCount = false, before?: () => number | undefined): Promise<void> {
    if (!record.root || this.sessions.get(sessionId) !== record || this.consentOff) return;
    let result: CaptureResult | null = null;
    if (!finalWithoutCount) {
      result = await this.archiver.captureDelta(sessionId, record.root, turns, before !== undefined ? { before } : {});
      try {
        this.onTurnArchive?.(sessionId, result);
      } catch (error) {
        this.warn("report", error);
      }
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
    if (record.touchedBase && record.touchedBase !== true) clearTimeout(record.touchedBase);
    this.cancelIdleFinal(record);
    this.cancelRetry(record);
    this.turnSettled(record);
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
    } else if (result.status === "skipped" && result.reason === "disabled") {
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
    while (this.active && !this.hurried) {
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
  /** Queues a step behind the session's earlier ones; resolves once it ran. `high`: ahead of other sessions' waiting steps. */
  private schedule(sessionId: string, step: string, task: () => Promise<void>, before?: () => Promise<void>, low = false, high = false): Promise<void> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(before).then(() => this.bounded(async () => {
      if (!this.active) return;
      try {
        await task();
      } catch (error) {
        this.warn(step, error, sessionId);
      }
    }, low, high));
    this.tails.set(sessionId, run);
    void run.then(() => {
      if (this.tails.get(sessionId) === run) this.tails.delete(sessionId);
    });
    return run;
  }

  private async bounded(task: () => Promise<void>, low = false, high = false): Promise<void> {
    if (this.running < this.concurrency) this.running += 1;
    else await new Promise<void>((resolvePromise) => (high ? this.waitingHigh : low ? this.waitingLow : this.waiting).push(resolvePromise));
    try {
      await task();
    } finally {
      // The slot passes straight to the next waiter, if any.
      const next = this.waitingHigh.shift() ?? this.waiting.shift() ?? this.waitingLow.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  private warn(step: string, error: unknown, sessionId?: string): void {
    this.log("warn", "OmniRush project archive step failed", { step, ...(sessionId ? { sessionId } : {}), error: errorSummary(error) });
  }
}

/** `promise`, or a rejection after `ms` (the promise itself goes on). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Turn `turn` (1 = the first) in the engine's messages: when its opening
 * prompt was created, and when its last answer ended (before the next
 * turn's prompt); null when it cannot be read.
 */
function turnSpan(messages: unknown, turn: number): { opened: number; answered: number | null } | null {
  if (!Array.isArray(messages) || turn < 1) return null;
  const steers = steerPrompts(messages);
  let opened = 0;
  let span: { opened: number; answered: number | null } | null = null;
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    const info = (typeof record.info === "object" && record.info !== null ? record.info : record) as Record<string, unknown>;
    const time = (typeof info.time === "object" && info.time !== null ? info.time : {}) as { created?: unknown; completed?: unknown };
    if (isPromptMessage(record) && !steers.has(typeof info.id === "string" ? info.id : index)) {
      opened += 1;
      if (opened === turn) {
        if (typeof time.created !== "number") return null;
        span = { opened: time.created, answered: null };
      } else if (opened > turn) {
        break;
      }
      continue;
    }
    if (span && info.role === "assistant" && typeof time.completed === "number") span.answered = Math.max(span.answered ?? 0, time.completed);
  }
  return span;
}
