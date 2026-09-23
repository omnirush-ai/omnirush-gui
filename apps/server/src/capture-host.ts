/**
 * Everything the embedded server captures about sessions, under one owner:
 * the workspace collector, the project archive and the turn observers. The
 * server runs it on a worker thread (capture-worker.ts, driven through
 * capture-client.ts), so reading, hashing and scrubbing files, building JSON
 * and tar streams, compressing and sealing never hold the main event loop
 * that serves the app; where no worker can start it runs in-process with the
 * same behaviour. Every call takes and returns plain data, so the same calls
 * cross the thread boundary unchanged.
 */
import { collectPromptAttachments, promptBodyForTrace, v2PromptBodyForTrace } from "./collector-attachments.js";
import {
  createSessionObservers,
  observeCollectedSession,
  projectArchiveEngineReads,
  type EngineTarget,
  type SessionObservers,
} from "./collector-observer.js";
import { SessionArchiver, type SessionArchiverOptions } from "./session-archive/index.js";
import { ProjectArchiveLifecycle, type ArchiveLifecycleLog } from "./session-archive/lifecycle.js";
import { WorkspaceCollector, type CollectorMetrics, type CollectorWebVisit } from "./workspace-collector.js";

export type { EngineTarget } from "./collector-observer.js";

export type CaptureLog = ArchiveLifecycleLog;

/** Prompt bodies larger than this are not parsed for the trace (nor for attachments). */
const MAX_TRACED_REQUEST_BYTES = 4 * 1024 * 1024;

/** A collected engine request, as the "engine.request" trace event and the prompt's attachments are built from it. */
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
};

export type CaptureHostOptions = {
  /** The collector state dir (the archive keeps its files under it too). */
  stateDir: string;
  appVersion: string;
  engineVersion: string;
  log: CaptureLog;
  collector: {
    upload?: (sessionId: string, compressed: Uint8Array) => Promise<Response>;
    refreshAccessToken?: () => Promise<string | null>;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    gatewayUrl?: string;
    accessToken?: string;
  };
  archive: Pick<SessionArchiverOptions, "request" | "refreshAccessToken" | "fetch" | "gatewayUrl" | "accessToken"> & {
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
  metrics: CollectorMetrics;
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
  readonly collector: WorkspaceCollector;
  readonly archive: ProjectArchiveLifecycle;
  private readonly observers: SessionObservers = createSessionObservers();

  constructor(options: CaptureHostOptions) {
    this.collector = new WorkspaceCollector({
      ...options.collector,
      stateDir: options.stateDir,
      appVersion: options.appVersion,
      engineVersion: options.engineVersion,
      log: options.log,
      ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
    });
    const { enabled, excludedDirs, baseIdleMs, baseMaxDeferMs, ...auth } = options.archive;
    this.archive = new ProjectArchiveLifecycle({
      archiver: new SessionArchiver({ stateDir: options.stateDir, excludedDirs, log: options.log, ...auth }),
      enabled: enabled && this.collector.enabled,
      log: options.log,
      ...(baseIdleMs !== undefined ? { baseIdleMs } : {}),
      ...(baseMaxDeferMs !== undefined ? { baseMaxDeferMs } : {}),
    });
    this.archive.start();
  }

  startSession(sessionId: string, workspaceId: string, root: string): void {
    this.collector.startSession(sessionId, workspaceId, root);
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    this.collector.recordTrace(sessionId, type, data);
  }

  /** The "engine.request" event of a collected request and, for a prompt dispatch, one "attachment" event per attached file. */
  recordPrompt(sessionId: string, prompt: PromptRecord): void {
    const payload = requestPayload(prompt.body);
    this.collector.recordTrace(sessionId, "engine.request", {
      method: prompt.method,
      path: prompt.path,
      body: prompt.engine === "v2" ? v2PromptBodyForTrace(payload) : promptBodyForTrace(payload),
    });
    if (!prompt.attachments) return;
    void collectPromptAttachments(payload, prompt.root).then((attachments) => {
      for (const attachment of attachments) this.collector.recordAttachment(sessionId, attachment);
    }).catch(() => undefined);
  }

  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed"): void {
    this.collector.captureSnapshot(sessionId, trigger);
  }

  recordWebVisit(sessionId: string, visit: CollectorWebVisit): boolean {
    return this.collector.recordWebVisit(sessionId, visit);
  }

  /** A prompt was dispatched: the project archive's session start (a base once per session, see lifecycle.ts). */
  archiveSessionStarted(sessionId: string, root: string, target: EngineTarget): void {
    this.archive.sessionStarted({ sessionId, root, engine: projectArchiveEngineReads(target, sessionId) });
  }

  /** The engine accepted a collected request: follow the session until its turn settles. */
  observeSession(sessionId: string, target: EngineTarget): void {
    observeCollectedSession({ collector: this.collector, archive: this.archive, observers: this.observers, sessionId, target });
  }

  /** The session was deleted in the engine. */
  sessionDeleted(sessionId: string): void {
    this.collector.recordTrace(sessionId, "session.deleted");
    this.collector.finishSession(sessionId);
    this.archive.sessionEnded(sessionId);
    this.observers.lastMessageIds.delete(sessionId);
  }

  /** The account is gone: queued archives and spooled uploads are deleted, nothing more is archived. */
  async signOut(): Promise<void> {
    await this.archive.signOut();
    await this.collector.clearSpool().catch(() => undefined);
  }

  /** Server shutdown: in-flight archive uploads abort first, then every session's trace and end snapshot go out. */
  async stop(): Promise<void> {
    const archiveStopped = this.archive.stop();
    this.observers.controller.abort();
    await this.collector.stop().catch(() => undefined);
    await archiveStopped;
  }

  /** Resolves once every queued capture, upload and archive step has settled (tests, profiling). */
  async idle(): Promise<void> {
    await this.collector.idleAll();
    await this.archive.settled();
  }

  diagnostics(): CaptureDiagnostics {
    return { metrics: { ...this.collector.metrics }, cache: this.collector.cacheStatus() };
  }
}
