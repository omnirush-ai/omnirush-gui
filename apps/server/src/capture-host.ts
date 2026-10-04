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
import { isAbsolute } from "node:path";
import type { ContextOptions } from "./context/index.js";
import { readPromptAttachments, promptBodyForTrace, v2PromptBodyForTrace } from "./session-upload-attachments.js";
import {
  createSessionObservers,
  currentEngineTarget,
  engineReplaced,
  observeUploadedSession,
  followToolStart, followContextToolEvents,
  projectArchiveEngineReads,
  promptDispatched,
  type EngineReplacement,
  type EngineTarget,
  type SessionObservers,
} from "./session-upload-observer.js";
import type { CaptureStopOptions } from "./capture-protocol.js";
import { SessionArchiver, type SessionArchiverOptions } from "./session-archive/index.js";
import { ProjectArchiveLifecycle, type ArchiveLifecycleLog } from "./session-archive/lifecycle.js";
import { SessionUploader, type TraceCapabilities, type UploadMetrics, type UploadWebVisit } from "./session-uploader.js";
import { sandboxMode } from "./vendor/sandbox/sandbox.js";

export type { EngineReplacement, EngineTarget } from "./session-upload-observer.js";

export type CaptureLog = ArchiveLifecycleLog;

/** Prompt bodies larger than this are not parsed for the trace (nor for attachments). */
const MAX_TRACED_REQUEST_BYTES = 4 * 1024 * 1024;

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
  sessionUploader: {
    upload?: (sessionId: string, compressed: Uint8Array, signal?: AbortSignal) => Promise<Response>;
    uploadFile?: (sessionId: string, path: string, size: number, signal?: AbortSignal) => Promise<Response>;
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
  /** The record of the sandbox the managed engine runs in, null on the host (setSandbox). */
  private sandboxRecord: unknown = null;

  constructor(options: CaptureHostOptions) {
    // The managed engine runs in the Docker sandbox (OMNIRUSH_SANDBOX=docker):
    // this machine's packages, services, processes, network and toolchain are
    // not the session's, and a path outside the workspace names a file inside
    // the sandbox; the sandbox's record and turn snapshots carry those instead.
    const sandboxed = sandboxMode(process.env) === "docker";
    this.sessionUploader = new SessionUploader({
      ...options.sessionUploader,
      stateDir: options.stateDir,
      appVersion: options.appVersion,
      engineVersion: options.engineVersion,
      log: options.log,
      // environment.sandbox: the main thread sends the managed engine's record (setSandbox).
      sandbox: () => this.sandboxRecord,
      // Capture context (context/); OMNIRUSH_CAPTURE_CONTEXT=0 turns it off.
      context: sandboxed ? false : options.sessionUploader?.context ?? {},
      ...(sandboxed ? { toolchain: false as const } : {}),
      ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
      // The touched-files archive hears of every path a session touches, here on the same thread.
      onPathTouched: (sessionId, path) => {
        if (sandboxed && isAbsolute(path)) return;
        this.archive.pathTouched(sessionId, path);
      },
      // Capture v2: a binary file is never sent as text; the project archive keeps it byte for byte.
      onBinaryFile: (sessionId, path) => this.archive.binaryFile(sessionId, path),
    });
    const { enabled, excludedDirs, folderGate, baseIdleMs, baseMaxDeferMs, ...auth } = options.archive;
    this.appDirs = [options.stateDir, ...excludedDirs];
    this.archive = new ProjectArchiveLifecycle({
      archiver: new SessionArchiver({ stateDir: options.stateDir, excludedDirs, folderGate, log: options.log, ...auth }),
      enabled: enabled && this.sessionUploader.enabled,
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

  /** The record of the Docker sandbox the managed engine runs in (managed-opencode.ts), sent as environment.sandbox. */
  setSandbox(record: unknown): void {
    this.sandboxRecord = record;
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

  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed"): void {
    this.sessionUploader.captureSnapshot(sessionId, trigger);
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
  observeSession(sessionId: string, target: EngineTarget): void {
    const root = this.sessionRoots.get(sessionId);
    void observeUploadedSession({
      sessionUploader: this.sessionUploader,
      archive: this.archive,
      ...(root ? { turnFiles: { root, archive: this.archive, excludedDirs: this.appDirs } } : {}),
      observers: this.observers,
      sessionId,
      target,
    });
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
    const archiveStopped = this.archive.stop({ finals: options.archiveFinals });
    this.observers.controller.abort();
    await this.sessionUploader.stop().catch(() => undefined);
    await archiveStopped;
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
