/**
 * Everything the embedded server captures about sessions, under one owner:
 * the session uploader, the project archive and the turn observers. The
 * server runs it on a worker thread (capture-worker.ts, driven through
 * capture-client.ts), so reading, hashing and scrubbing files, building JSON
 * and tar streams, compressing and sealing never hold the main event loop
 * that serves the app; where no worker can start it runs in-process with the
 * same behaviour. Every call takes and returns plain data, so the same calls
 * cross the thread boundary unchanged.
 */
import type { ContextOptions } from "./context/index.js";
import { readPromptAttachments, promptBodyForTrace, v2PromptBodyForTrace } from "./session-upload-attachments.js";
import {
  readSessionTranscript,
  createSessionObservers,
  currentEngineTarget,
  engineReplaced,
  observeUploadedSession,
  followToolStart, followContextToolEvents, followFilesUsedCalls,
  projectArchiveEngineReads,
  promptDispatched,
  type EngineReplacement,
  type EngineTarget,
  type SessionObservers,
} from "./session-upload-observer.js";
import type { CaptureStopOptions } from "./capture-protocol.js";
import { SessionArchiver, type FilesUsedStatus, type SessionArchiverOptions } from "./session-archive/index.js";
import { ProjectArchiveLifecycle, type ArchiveLifecycleLog } from "./session-archive/lifecycle.js";
import { SessionUploader, type RecoveredTurn, type TraceCapabilities, type UploadMetrics, type UploadRequestOptions, type UploadWebVisit } from "./session-uploader.js";

export type { EngineReplacement, EngineTarget } from "./session-upload-observer.js";

export type CaptureLog = ArchiveLifecycleLog;

/** Prompt bodies larger than this are not parsed for the trace (nor for attachments). */
const MAX_TRACED_REQUEST_BYTES = 4 * 1024 * 1024;
/** An app quit gives the turns still open this long in all to be settled from the engine. */
const QUIT_SETTLE_BUDGET_MS = 5_000;
/** A recovered turn asks for its engine again after these waits (the engine may still be starting). */
const RECOVERY_TARGET_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000, 60_000];

/** A captured engine request, as the "engine.request" trace event and the prompt's attachments are built from it. */
export type PromptRecord = {
  method: string;
  path: string;
  /** The request body; null when there is none or it is larger than a traced body may be. */
  body: Uint8Array | null;
  engine: "v1" | "v2";
  /** The workspace root, where attached files copied into the workspace are read from. */
  root: string;
  /** A prompt dispatch: its file parts become "attachment" events. */
  attachments: boolean;
  /**
   * When a prompt dispatch went out (epoch milliseconds, taken before the
   * engine saw it): a turn of the session still being followed ends here.
   */
  dispatchedAt?: number;
};

export type CaptureHostOptions = {
  /** The session uploader state dir (the archive keeps its files under it too). */
  stateDir: string;
  appVersion: string;
  engineVersion: string;
  log: CaptureLog;
  /** The signed-in account's id (null: not known now); spooled uploads are stamped with it. */
  accountId?: () => Promise<string | null>;
  /**
   * The engine holding a chat of this workspace, for settling a turn a
   * previous process left open; null when there is none (remote, unknown,
   * or the engine does not have the chat).
   */
  engineTarget?: (sessionId: string, workspaceId: string) => Promise<EngineTarget | null>;
  /** GET /omnirush/me/sessions/{id}/integrity with the device bearer. */
  sessionIntegrity?: (sessionId: string, options?: { summary?: boolean; turns?: number }) => Promise<Response>;
  sessionUploader: {
    upload?: (sessionId: string, compressed: Uint8Array, signal?: AbortSignal, request?: UploadRequestOptions) => Promise<Response>;
    uploadFile?: (sessionId: string, path: string, size: number, signal?: AbortSignal, request?: UploadRequestOptions) => Promise<Response>;
    capabilities?: () => Promise<TraceCapabilities>;
    refreshAccessToken?: () => Promise<string | null>;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    gatewayUrl?: string;
    accessToken?: string;
    /** Capture context (context/): false turns it off, an object overrides its options. */
    context?: false | Partial<ContextOptions>;
  };
  archive: Pick<SessionArchiverOptions, "request" | "refreshAccessToken" | "fetch" | "gatewayUrl" | "accessToken" | "folderGate"> & {
    /** Archiving is on for this device (OMNIRUSH_ARCHIVE_ENABLED) and an account is connected. */
    enabled: boolean;
    /** App data, config and cache directories: pruned under a project root, never archived as one. */
    excludedDirs: string[];
    baseIdleMs?: number;
    baseMaxDeferMs?: number;
  };
  /** A finished session's last upload settled (the in-process `hasSession` mirror of a worker follows it). */
  onSessionClosed?: (sessionId: string) => void;
};

export type CaptureDiagnostics = {
  metrics: UploadMetrics;
  cache: { roots: number; entries: number };
};

function requestPayload(body: Uint8Array | null): unknown {
  if (!body || body.byteLength > MAX_TRACED_REQUEST_BYTES) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

export class CaptureHost {
  readonly sessionUploader: SessionUploader;
  readonly archive: ProjectArchiveLifecycle;
  private readonly observers: SessionObservers = createSessionObservers();
  /** Each started session's workspace root, for the turn's file record (session-archive/turn-files.ts). */
  private readonly sessionRoots = new Map<string, string>();
  /** The state dir and the app's data/config/cache dirs: never reported or recorded as a touched file. */
  private readonly appDirs: string[];
  private readonly engineTarget?: CaptureHostOptions["engineTarget"];

  constructor(options: CaptureHostOptions) {
    this.engineTarget = options.engineTarget;
    this.sessionUploader = new SessionUploader({
      ...options.sessionUploader,
      stateDir: options.stateDir,
      appVersion: options.appVersion,
      engineVersion: options.engineVersion,
      log: options.log,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.sessionIntegrity ? { sessionIntegrity: options.sessionIntegrity } : {}),
      // A turn a crashed process or worker left open is settled from the engine's messages.
      onRecoveredTurn: (turn) => void this.recoverTurn(turn),
      // Parts the server is missing are re-sent from the engine's transcript.
      repairTranscript: (chat) => this.transcript(chat),
      // Capture context (context/); OMNIRUSH_CAPTURE_CONTEXT=0 turns it off.
      context: options.sessionUploader?.context ?? {},
      ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
      // The touched-files archive hears of every path a session touches, here on the same thread.
      onPathTouched: (sessionId, path) => this.archive.pathTouched(sessionId, path),
      // Capture v2: a binary file is never sent as text; the project archive keeps it byte for byte.
      onBinaryFile: (sessionId, path) => this.archive.binaryFile(sessionId, path),
    });
    const { enabled, excludedDirs, folderGate, baseIdleMs, baseMaxDeferMs, ...auth } = options.archive;
    this.appDirs = [options.stateDir, ...excludedDirs];
    this.archive = new ProjectArchiveLifecycle({
      archiver: new SessionArchiver({
        stateDir: options.stateDir,
        excludedDirs,
        folderGate,
        log: options.log,
        ...auth,
        // Through the gateway broker, the account behind the device bearer (claimAccount()).
        ...(auth.request && options.accountId ? { accountId: options.accountId } : {}),
      }),
      enabled: enabled && this.sessionUploader.enabled,
      accountMissing: !this.sessionUploader.enabled,
      log: options.log,
      ...(baseIdleMs !== undefined ? { baseIdleMs } : {}),
      ...(baseMaxDeferMs !== undefined ? { baseMaxDeferMs } : {}),
    });
    this.archive.start();
  }

  startSession(sessionId: string, workspaceId: string, root: string): void {
    this.sessionRoots.set(sessionId, root);
    this.sessionUploader.startSession(sessionId, workspaceId, root);
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    this.sessionUploader.recordTrace(sessionId, type, data);
  }

  flushTrace(sessionId: string, finalTrace?: unknown): void {
    this.sessionUploader.flushTrace(sessionId, finalTrace);
  }

  finishSession(sessionId: string, finalTrace?: unknown): void {
    this.sessionUploader.finishSession(sessionId, finalTrace);
    this.archive.sessionEnded(sessionId);
    this.observers.lastMessageIds.delete(sessionId);
    this.sessionRoots.delete(sessionId);
  }

  /** The "engine.request" event of a captured request and, for a prompt dispatch, one "attachment" event per attached file. */
  recordPrompt(sessionId: string, prompt: PromptRecord): void {
    // The turn this prompt follows takes its end snapshot first, ahead of this prompt's own.
    if (prompt.dispatchedAt !== undefined) promptDispatched(this.observers, this.sessionUploader, sessionId, prompt.dispatchedAt);
    const payload = requestPayload(prompt.body);
    this.sessionUploader.recordTrace(sessionId, "engine.request", {
      method: prompt.method,
      path: prompt.path,
      body: prompt.engine === "v2" ? v2PromptBodyForTrace(payload) : promptBodyForTrace(payload),
    });
    if (!prompt.attachments) return;
    void readPromptAttachments(payload, prompt.root).then((attachments) => {
      for (const attachment of attachments) this.sessionUploader.recordAttachment(sessionId, attachment);
    }).catch(() => undefined);
  }

  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed", outcome?: "aborted"): void {
    this.sessionUploader.captureSnapshot(sessionId, trigger, outcome);
  }

  recordWebVisit(sessionId: string, visit: UploadWebVisit): boolean {
    return this.sessionUploader.recordWebVisit(sessionId, visit);
  }

  /** A prompt was dispatched: the project archive's session start (a base once per session, see lifecycle.ts). */
  archiveSessionStarted(sessionId: string, root: string, target: EngineTarget): void {
    this.archive.sessionStarted({ sessionId, root, engine: projectArchiveEngineReads(() => currentEngineTarget(this.observers, target), sessionId) });
    // Capture v2: this turn's first tool call takes the folder's state (in the background).
    followToolStart({ observers: this.observers, archive: this.archive, sessionId, target });
    // Capture context: each tool call's start and end, for the network observer.
    followContextToolEvents({ observers: this.observers, context: this.sessionUploader.context, sessionId, target });
    // Files used: each tool call's end, so its temp files are kept before a later call deletes them.
    followFilesUsedCalls({ observers: this.observers, archive: this.archive, sessionId, target });
  }

  /** Capture v2: the session-start manifest, before the first prompt reaches the engine (lifecycle.ts startGate). */
  async archiveStartGate(sessionId: string, root: string): Promise<void> {
    await this.archive.startGate(sessionId, root);
  }

  /** An engine was closed and `replacement` took over its sessions: observations reading it move there. */
  engineReplaced(closedBaseUrl: string, replacement: EngineReplacement): void {
    engineReplaced(this.observers, closedBaseUrl, replacement);
  }

  /** The engine accepted a captured request: follow the session until its turn settles. */
  observeSession(sessionId: string, target: EngineTarget, recovered = false): void {
    const root = this.sessionRoots.get(sessionId);
    void observeUploadedSession({
      sessionUploader: this.sessionUploader,
      archive: this.archive,
      ...(root ? { turnFiles: { root, archive: this.archive, excludedDirs: this.appDirs } } : {}),
      observers: this.observers,
      sessionId,
      target,
      ...(recovered ? { recovered } : {}),
    });
  }

  /**
   * A turn a previous process (or worker) left open: the chat resumes here
   * and its observer settles the turn from the engine's messages, or follows
   * it to its end when it is still running. Without an engine that has the
   * chat, its messages wait for its next prompt (the checkpoint did not move).
   */
  private async recoverTurn(turn: RecoveredTurn): Promise<void> {
    if (!this.engineTarget) return;
    const stopped = this.observers.controller.signal;
    // The chat was resumed meanwhile (the app's own task recovery, or the user): its
    // observer settles the interrupted turn with the next one; the trace says it was recovered.
    const resumed = (): boolean => {
      if (!this.sessionUploader.hasSession(turn.sessionId)) return false;
      this.sessionUploader.recordTrace(turn.sessionId, "collector.recovered", { reason: "restart", turn_open: true, settled_by: "resumed_chat" });
      return true;
    };
    for (const delay of RECOVERY_TARGET_DELAYS_MS) {
      if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay).unref?.());
      if (stopped.aborted || resumed()) return;
      const target = await this.engineTarget(turn.sessionId, turn.workspaceId).catch(() => null);
      if (stopped.aborted || resumed()) return;
      if (!target) continue;
      this.startSession(turn.sessionId, turn.workspaceId, turn.root);
      this.observeSession(turn.sessionId, target, true);
      return;
    }
  }

  /** Files used, for the app's one-time notice: what omnirush.ai says. */
  filesUsedStatus(): Promise<FilesUsedStatus> {
    return this.archive.filesUsedStatus();
  }

  /** The session was deleted in the engine. */
  sessionDeleted(sessionId: string): void {
    this.sessionUploader.recordTrace(sessionId, "session.deleted");
    this.sessionUploader.finishSession(sessionId);
    this.archive.sessionEnded(sessionId);
    this.observers.lastMessageIds.delete(sessionId);
    this.sessionRoots.delete(sessionId);
  }

  /** The account is gone: queued archives and spooled uploads are deleted, nothing more is archived. */
  async signOut(): Promise<void> {
    await this.archive.signOut();
    await this.sessionUploader.clearSpool().catch(() => undefined);
  }

  /**
   * Server shutdown: in-flight archive uploads abort first, then every
   * session's trace and end snapshot go out, next to the project archive's
   * final archives (unless `archiveFinals` is false: the account is gone).
   */
  async stop(options: CaptureStopOptions = { archiveFinals: true }): Promise<void> {
    // Turns still open get their messages and their end first, within a bounded budget.
    await this.settleOpenTurns(QUIT_SETTLE_BUDGET_MS);
    const archiveStopped = this.archive.stop({ finals: options.archiveFinals });
    this.observers.controller.abort();
    await this.sessionUploader.stop().catch(() => undefined);
    await archiveStopped;
  }

  /** A chat's whole transcript from the engine that has it; null without one. */
  private async transcript(chat: RecoveredTurn): Promise<unknown[][] | null> {
    const target = this.engineTarget ? await this.engineTarget(chat.sessionId, chat.workspaceId).catch(() => null) : null;
    return target ? readSessionTranscript(target, chat.sessionId, this.observers.controller.signal) : null;
  }

  /** Settles every followed turn as the engine has it now, waiting at most `budgetMs`. */
  private async settleOpenTurns(budgetMs: number): Promise<void> {
    const open = [...this.observers.sessions.values()].map((session) => session.settleNow?.().catch(() => undefined));
    if (open.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(open),
      new Promise((resolvePromise) => {
        timer = setTimeout(resolvePromise, budgetMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /** Resolves once every queued capture, upload and archive step has settled (tests, profiling). */
  async idle(): Promise<void> {
    await this.sessionUploader.idleAll();
    await this.archive.settled();
  }

  diagnostics(): CaptureDiagnostics {
    return { metrics: { ...this.sessionUploader.metrics }, cache: this.sessionUploader.cacheStatus() };
  }
}
