/**
 * The server's handle on session capture (the session uploader, the
 * project archive and the turn observers, see capture-host.ts). By default
 * the capture runs on a worker thread (capture-worker.ts): the main event
 * loop, which serves the app (in the desktop app, the Electron main process),
 * only posts calls and answers the worker's requests for the gateway broker
 * and external egress. Opening or switching sessions never waits on a scan,
 * a snapshot or an archive. If the worker cannot start (a runtime without
 * worker support for this module, or OMNIRUSH_CAPTURE_WORKER=0) the same host
 * runs in-process; a worker that dies after starting is replaced, again and
 * again with a growing pause, and the calls made meanwhile wait for it.
 */
import { Worker } from "node:worker_threads";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { START_GATE_MS } from "./session-archive/capture-v2.js";
import type { FilesUsedStatus } from "./session-archive/index.js";

import { CaptureHost, type CaptureDiagnostics, type CaptureHostOptions, type EngineReplacement, type EngineTarget, type PromptRecord } from "./capture-host.js";
import {
  invokeCapture,
  serializeResponse,
  transferables,
  type CaptureCall,
  type CaptureWorkerInit,
  type FromWorker,
  type HostRequest,
  type RequestChannel,
  type RequestResult,
  type ToWorker,
} from "./capture-protocol.js";
import { externalFetch } from "./server-fetch.js";
import { isUploadableWebUrl, MAX_UPLOAD_COMPRESSED_BYTES, sessionUploaderEnabled, type UploadWebVisit } from "./session-uploader.js";

/** A prompt body larger than this is not traced, so it is not copied to the worker either. */
const MAX_TRACED_REQUEST_BYTES = 4 * 1024 * 1024;
/** Shutdown waits this long for the last traces and end snapshots before the worker is terminated. */
const STOP_TIMEOUT_MS = 20_000;
/** Shutdown waits this long to learn whether the account is still there (for the final project archives), else packs none. */
const ACCOUNT_CHECK_TIMEOUT_MS = 1_000;
/** The pause before a new worker: `baseMs` doubled per consecutive exit, at most `maxMs`; `stableMs` up and ready starts over. */
type RestartBackoff = { baseMs: number; maxMs: number; stableMs?: number };
/** A worker that exits unexpectedly is replaced after 1 s, then 2 s, 4 s, ... at most 60 s. */
const RESTART_BACKOFF: RestartBackoff = { baseMs: 1_000, maxMs: 60_000 };
/** A worker that stayed up and ready this long starts the backoff over. */
const RESTART_STABLE_MS = 5 * 60_000;
/** Calls waiting for a worker to start; past this the oldest one nobody waits on is dropped. */
const MAX_QUEUED_CALLS = 20_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
/** Chats whose engine is remembered for a restarted worker. */
const MAX_OBSERVED_TARGETS = 256;

export type CaptureServiceOptions = Omit<CaptureHostOptions, "onSessionClosed"> & {
  /** Run capture on a worker thread; default on unless OMNIRUSH_CAPTURE_WORKER is 0, false, no or off. */
  worker?: boolean;
  /** How long shutdown waits for the capture to stop; STOP_TIMEOUT_MS unless a test lowers it. */
  stopTimeoutMs?: number;
  /** RESTART_BACKOFF and RESTART_STABLE_MS unless a test lowers them. */
  restartBackoffMs?: RestartBackoff;
  /** Told each time the mode changes. */
  onModeChange?: (mode: CaptureMode) => void;
};

/**
 * Where capture runs: "restarting" between a worker's exit and the next
 * one's start, and "down" only once stopped. While "starting" or
 * "restarting", calls wait for the worker.
 */
export type CaptureMode = "starting" | "worker" | "local" | "restarting" | "down";

export type CaptureService = {
  /** The session uploader has an account to upload to (the sign-in gate's question). */
  readonly uploadEnabled: boolean;
  /** Where capture runs right now. */
  mode(): CaptureMode;
  /** The mode, when it began, and how many times a worker was replaced (the app's status). */
  status(): { mode: CaptureMode; since: Date; restarts: number };
  /** Whether the session uploader is tracking this session (started and not finished). */
  hasSession(sessionId: string): boolean;
  startSession(sessionId: string, workspaceId: string, root: string): void;
  recordTrace(sessionId: string, type: string, data?: unknown): void;
  flushTrace(sessionId: string, finalTrace?: unknown): void;
  finishSession(sessionId: string, finalTrace?: unknown): void;
  /** The "engine.request" event of a captured request (its body parsed off the main thread), plus a prompt's attachments. */
  recordPrompt(sessionId: string, prompt: Omit<PromptRecord, "body"> & { body: ArrayBuffer | undefined }): void;
  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed", outcome?: "aborted"): void;
  /** Whether the visit is recorded (a tracked session and an uploadable URL). */
  recordWebVisit(sessionId: string, visit: UploadWebVisit): boolean;
  archiveSessionStarted(sessionId: string, root: string, target: EngineTarget): void;
  /**
   * Capture v2: resolves once the project archive took the session-start
   * manifest (hash and stat only, START_GATE_MS at most); the prompt goes to
   * the engine after it. Never rejects.
   */
  archiveStartGate(sessionId: string, root: string): Promise<void>;
  observeSession(sessionId: string, target: EngineTarget): void;
  /** An engine was closed and another took over its sessions: turn observers reading it move there. */
  engineReplaced(closedBaseUrl: string, replacement: EngineReplacement): void;
  sessionDeleted(sessionId: string): void;
  signOut(): Promise<void>;
  /**
   * Stops capture. `archiveFinals` (default true) says whether the account is
   * still connected, so that the project archive packs its final archives;
   * a user sign-out clears the account before it restarts the server.
   */
  stop(options?: { archiveFinals?: boolean | Promise<boolean> }): Promise<void>;
  /** Every queued capture, upload and archive step settled (tests, profiling). */
  idle(): Promise<void>;
  diagnostics(): Promise<CaptureDiagnostics | null>;
  /** Files used, for the app's one-time notice (null: capture is not running). */
  filesUsedStatus(): Promise<FilesUsedStatus | null>;
};

/** How much longer than the start gate's own cap the main thread waits for the worker's answer. */
const START_GATE_SLACK_MS = 1_000;

export function captureWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "no", "off"].includes((env.OMNIRUSH_CAPTURE_WORKER ?? "").trim().toLowerCase());
}

function workerUrl(): URL {
  // Tests and development run the TypeScript sources; builds run the compiled modules.
  return new URL(import.meta.url.endsWith(".ts") ? "./capture-worker.ts" : "./capture-worker.js", import.meta.url);
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type QueuedCall = { call: CaptureCall; transfer: ArrayBuffer[] };

class CaptureClient implements CaptureService {
  readonly uploadEnabled: boolean;
  private current: CaptureMode = "starting";
  private since = new Date();
  private worker: Worker | null = null;
  private local: CaptureHost | null = null;
  private queue: QueuedCall[] = [];
  private callSeq = 0;
  /** Calls waiting for the worker's reply. */
  private readonly replies = new Map<number, (value: unknown) => void>();
  /** The worker's requests being served on this thread. */
  private readonly served = new Map<number, { controller: AbortController; channel: RequestChannel }>();
  /** Sessions the worker's session uploader tracks: true while live, false once finishing. */
  private readonly sessions = new Map<string, boolean>();
  private restarts = 0;
  /** Exits since a worker last stayed up RESTART_STABLE_MS: the next pause doubles with each. */
  private attempt = 0;
  private readyAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Only the first start falls back to capturing in-process; later failures start new workers. */
  private canRunLocally = true;
  private overflowing = false;
  /** The engine each recently observed chat's requests went to: a restarted worker settles their open turns there. */
  private readonly observedTargets = new Map<string, EngineTarget>();
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: CaptureServiceOptions) {
    this.uploadEnabled = sessionUploaderEnabled({
      upload: Boolean(options.sessionUploader.upload || options.sessionUploader.uploadFile),
      gatewayUrl: options.sessionUploader.gatewayUrl,
      accessToken: options.sessionUploader.accessToken,
    });
    if (options.worker ?? captureWorkerEnabled()) this.spawn();
    else this.runLocally(null);
  }

  mode(): CaptureMode {
    return this.current;
  }

  status(): { mode: CaptureMode; since: Date; restarts: number } {
    return { mode: this.current, since: this.since, restarts: this.restarts };
  }

  private setMode(mode: CaptureMode): void {
    if (mode === this.current) return;
    this.current = mode;
    this.since = new Date();
    this.options.onModeChange?.(mode);
  }

  hasSession(sessionId: string): boolean {
    if (this.local) return this.local.sessionUploader.hasSession(sessionId);
    return this.sessions.get(sessionId) === true;
  }

  startSession(sessionId: string, workspaceId: string, root: string): void {
    if (this.uploadEnabled && SESSION_ID_PATTERN.test(sessionId) && !this.sessions.has(sessionId)) this.sessions.set(sessionId, true);
    this.send({ kind: "call", id: null, method: "startSession", args: [sessionId, workspaceId, root] });
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    this.send({ kind: "call", id: null, method: "recordTrace", args: data === undefined ? [sessionId, type] : [sessionId, type, data] });
  }

  flushTrace(sessionId: string, finalTrace?: unknown): void {
    this.send({ kind: "call", id: null, method: "flushTrace", args: finalTrace === undefined ? [sessionId] : [sessionId, finalTrace] });
  }

  finishSession(sessionId: string, finalTrace?: unknown): void {
    if (this.sessions.get(sessionId) === true) this.sessions.set(sessionId, false);
    this.send({ kind: "call", id: null, method: "finishSession", args: finalTrace === undefined ? [sessionId] : [sessionId, finalTrace] });
  }

  recordPrompt(sessionId: string, prompt: Omit<PromptRecord, "body"> & { body: ArrayBuffer | undefined }): void {
    // The body is still forwarded to the engine: the worker gets its own copy, moved rather than cloned.
    const body = prompt.body && prompt.body.byteLength > 0 && prompt.body.byteLength <= MAX_TRACED_REQUEST_BYTES ? new Uint8Array(prompt.body.slice(0)) : null;
    this.send({ kind: "call", id: null, method: "recordPrompt", args: [sessionId, { ...prompt, body }] }, body ? [body.buffer] : []);
  }

  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed", outcome?: "aborted"): void {
    this.send({ kind: "call", id: null, method: "captureSnapshot", args: outcome ? [sessionId, trigger, outcome] : [sessionId, trigger] });
  }

  recordWebVisit(sessionId: string, visit: UploadWebVisit): boolean {
    if (this.local) return this.local.recordWebVisit(sessionId, visit);
    if (!this.hasSession(sessionId) || typeof visit.url !== "string" || !isUploadableWebUrl(visit.url)) return false;
    this.send({ kind: "call", id: null, method: "recordWebVisit", args: [sessionId, visit] });
    return true;
  }

  archiveSessionStarted(sessionId: string, root: string, target: EngineTarget): void {
    this.send({ kind: "call", id: null, method: "archiveSessionStarted", args: [sessionId, root, target] });
  }

  async archiveStartGate(sessionId: string, root: string): Promise<void> {
    // The worker answers within the gate's cap; a busy or stuck worker never holds a prompt longer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.query({ kind: "call", id: null, method: "archiveStartGate", args: [sessionId, root] }).catch(() => undefined),
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, START_GATE_MS + START_GATE_SLACK_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  observeSession(sessionId: string, target: EngineTarget): void {
    this.observedTargets.delete(sessionId);
    this.observedTargets.set(sessionId, target);
    if (this.observedTargets.size > MAX_OBSERVED_TARGETS) this.observedTargets.delete(this.observedTargets.keys().next().value as string);
    this.send({ kind: "call", id: null, method: "observeSession", args: [sessionId, target] });
  }

  engineReplaced(closedBaseUrl: string, replacement: EngineReplacement): void {
    this.send({ kind: "call", id: null, method: "engineReplaced", args: [closedBaseUrl, replacement] });
  }

  sessionDeleted(sessionId: string): void {
    if (this.sessions.get(sessionId) === true) this.sessions.set(sessionId, false);
    this.send({ kind: "call", id: null, method: "sessionDeleted", args: [sessionId] });
  }

  async signOut(): Promise<void> {
    await this.query({ kind: "call", id: null, method: "signOut", args: [] });
  }

  async idle(): Promise<void> {
    await this.query({ kind: "call", id: null, method: "idle", args: [] });
  }

  async diagnostics(): Promise<CaptureDiagnostics | null> {
    const value = await this.query({ kind: "call", id: null, method: "diagnostics", args: [] });
    return isDiagnostics(value) ? value : null;
  }

  async filesUsedStatus(): Promise<FilesUsedStatus | null> {
    return filesUsedStatusOf(await this.query({ kind: "call", id: null, method: "filesUsedStatus", args: [] }));
  }

  stop(options: { archiveFinals?: boolean | Promise<boolean> } = {}): Promise<void> {
    this.stopping ??= this.shutdown(options.archiveFinals ?? true);
    return this.stopping;
  }

  private async shutdown(archiveFinals: boolean | Promise<boolean>): Promise<void> {
    // First, and synchronously: archive uploads this thread makes for the worker are aborted now.
    for (const { controller, channel } of this.served.values()) if (channel === "archive") controller.abort();
    // Between workers: the next one starts now, so the queued calls and the stop reach it.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.spawn();
    }
    const finals = await withinTimeout(archiveFinals, ACCOUNT_CHECK_TIMEOUT_MS);
    const done = this.dispatch({ kind: "call", id: null, method: "stop", args: [{ archiveFinals: finals }] }, [], true);
    const timeoutMs = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolvePromise) => {
      timer = setTimeout(() => {
        this.options.log("warn", this.local
          ? "OmniRush capture did not stop in time; its uploads in flight are aborted"
          : "OmniRush capture did not stop in time; the capture worker is terminated", { timeoutMs });
        resolvePromise(true);
      }, timeoutMs);
      timer.unref?.();
    });
    const late = await Promise.race([done.then(() => false), timedOut]);
    clearTimeout(timer);
    // In-process there is no worker to terminate: its uploads end here instead (spooled for the next start).
    if (late) this.local?.sessionUploader.abortUploads();
    const worker = this.worker;
    this.worker = null;
    this.setMode("down");
    if (worker) await worker.terminate().catch(() => undefined);
    // Also aborts the requests this thread was still serving for the worker.
    this.settleOutstanding();
  }

  // --- calls ------------------------------------------------------------------

  private send(call: CaptureCall, transfer: ArrayBuffer[] = []): void {
    if (this.stopping) return;
    void this.dispatch(call, transfer, false);
  }

  private query(call: CaptureCall): Promise<unknown> {
    if (this.stopping) return Promise.resolve(null);
    return this.dispatch(call, [], true);
  }

  /** Runs or posts one call; resolves with its result when `awaited`, else at once. */
  private dispatch(call: CaptureCall, transfer: ArrayBuffer[], awaited: boolean): Promise<unknown> {
    if (this.local) {
      try {
        return Promise.resolve(invokeCapture(this.local, call)).catch(() => null);
      } catch (error) {
        this.options.log("warn", "OmniRush capture call failed", { method: call.method, error: errorSummary(error) });
        return Promise.resolve(null);
      }
    }
    if (this.current === "down") return Promise.resolve(null);
    let reply: Promise<unknown> = Promise.resolve(null);
    if (awaited) {
      const id = ++this.callSeq;
      call.id = id;
      reply = new Promise((resolvePromise) => this.replies.set(id, resolvePromise));
    }
    if (this.current === "worker" && this.worker) this.post(this.worker, call, transfer);
    else this.enqueue({ call, transfer });
    return reply;
  }

  /** Queues a call for the next worker; a full queue drops its oldest call nobody waits on (an awaited one only if all are). */
  private enqueue(queued: QueuedCall): void {
    if (this.queue.length >= MAX_QUEUED_CALLS) {
      const [dropped] = this.queue.splice(Math.max(0, this.queue.findIndex((item) => item.call.id === null)), 1);
      if (dropped && dropped.call.id !== null) {
        this.replies.get(dropped.call.id)?.(null);
        this.replies.delete(dropped.call.id);
      }
      if (!this.overflowing) {
        this.overflowing = true;
        this.options.log("warn", "OmniRush capture calls are queued past the limit while the capture worker starts; the oldest are dropped", { limit: MAX_QUEUED_CALLS });
      }
    }
    this.queue.push(queued);
  }

  /** Hands the queued calls over (the worker is ready, or the host runs in-process). */
  private takeQueue(): QueuedCall[] {
    const queued = this.queue;
    this.queue = [];
    this.overflowing = false;
    return queued;
  }

  /** Posts a call; one whose arguments cannot be cloned is dropped with a warn line, never thrown into the request. */
  private post(worker: Worker, call: CaptureCall, transfer: ArrayBuffer[]): void {
    try {
      worker.postMessage(call satisfies ToWorker, transfer);
    } catch (error) {
      this.options.log("warn", "OmniRush capture call could not be sent to the capture worker", { method: call.method, error: errorSummary(error) });
      if (call.id === null) return;
      const resolvePromise = this.replies.get(call.id);
      this.replies.delete(call.id);
      resolvePromise?.(null);
    }
  }

  // --- the worker -----------------------------------------------------------------

  private workerInit(): CaptureWorkerInit {
    const { sessionUploader, archive } = this.options;
    return {
      stateDir: this.options.stateDir,
      appVersion: this.options.appVersion,
      engineVersion: this.options.engineVersion,
      accountId: Boolean(this.options.accountId),
      sessionIntegrity: Boolean(this.options.sessionIntegrity),
      // Always: the chats this thread saw observed are known here even without a resolver.
      engineTarget: true,
      sessionUploader: {
        upload: Boolean(sessionUploader.upload),
        uploadFile: Boolean(sessionUploader.uploadFile),
        capabilities: Boolean(sessionUploader.capabilities),
        refreshAccessToken: Boolean(sessionUploader.refreshAccessToken),
        ...(sessionUploader.gatewayUrl !== undefined ? { gatewayUrl: sessionUploader.gatewayUrl } : {}),
        ...(sessionUploader.accessToken !== undefined ? { accessToken: sessionUploader.accessToken } : {}),
      },
      archive: {
        enabled: archive.enabled,
        excludedDirs: archive.excludedDirs,
        folderGate: archive.folderGate,
        request: Boolean(archive.request),
        refreshAccessToken: Boolean(archive.refreshAccessToken),
        ...(archive.gatewayUrl !== undefined ? { gatewayUrl: archive.gatewayUrl } : {}),
        ...(archive.accessToken !== undefined ? { accessToken: archive.accessToken } : {}),
        ...(archive.baseIdleMs !== undefined ? { baseIdleMs: archive.baseIdleMs } : {}),
        ...(archive.baseMaxDeferMs !== undefined ? { baseMaxDeferMs: archive.baseMaxDeferMs } : {}),
      },
    };
  }

  private spawn(): void {
    this.restartTimer = null;
    this.setMode("starting");
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { workerData: this.workerInit() });
    } catch (error) {
      if (this.canRunLocally) this.runLocally(error);
      else this.scheduleRestart("OmniRush capture worker could not start; starting a new one", { error: errorSummary(error) });
      return;
    }
    // The server's listener keeps the process alive; the worker never holds it open on its own.
    worker.unref();
    this.worker = worker;
    worker.on("message", (message: FromWorker) => this.onMessage(worker, message));
    worker.on("error", (error: unknown) => {
      if (worker === this.worker) this.options.log("warn", "OmniRush capture worker failed", { error: errorSummary(error) });
    });
    worker.on("exit", (code: number) => this.onExit(worker, code));
  }

  private onMessage(worker: Worker, message: FromWorker): void {
    if (worker !== this.worker) return;
    switch (message.kind) {
      case "ready": {
        this.setMode("worker");
        this.readyAt = Date.now();
        this.canRunLocally = false;
        for (const { call, transfer } of this.takeQueue()) this.post(worker, call, transfer);
        return;
      }
      case "log":
        this.options.log(message.level, message.message, message.attributes);
        return;
      case "closed":
        if (this.sessions.get(message.sessionId) === false) this.sessions.delete(message.sessionId);
        return;
      case "reply": {
        const resolvePromise = this.replies.get(message.id);
        this.replies.delete(message.id);
        resolvePromise?.(message.ok ? message.value : null);
        return;
      }
      case "abort":
        this.served.get(message.id)?.controller.abort();
        return;
      case "request":
        void this.serve(worker, message.id, message.channel, message.request);
        return;
    }
  }

  private onExit(worker: Worker, code: number): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.settleOutstanding();
    if (this.stopping) return;
    if (this.current === "starting" && this.canRunLocally) {
      this.runLocally(new Error(`the capture worker exited with code ${code} before it was ready`));
      return;
    }
    // Its sessions are gone with it; each resumes on its next prompt.
    this.sessions.clear();
    this.scheduleRestart("OmniRush capture worker exited; starting a new one", { code });
  }

  /** Starts a new worker after the backoff's pause; calls made meanwhile are queued for it. */
  private scheduleRestart(message: string, attributes: Record<string, unknown>): void {
    const { baseMs, maxMs, stableMs = RESTART_STABLE_MS } = this.options.restartBackoffMs ?? RESTART_BACKOFF;
    if (this.readyAt && Date.now() - this.readyAt >= stableMs) this.attempt = 0;
    this.readyAt = 0;
    const delayMs = Math.min(baseMs * 2 ** this.attempt, maxMs);
    this.attempt += 1;
    this.restarts += 1;
    this.setMode("restarting");
    this.options.log("warn", message, { ...attributes, attempt: this.attempt, delayMs });
    this.restartTimer = setTimeout(() => this.spawn(), delayMs);
    this.restartTimer.unref?.();
  }

  /**
   * The worker is gone: every caller waiting on it gets an empty result, and
   * every request this thread still serves for it (a session upload that
   * outlasted the stop, an archive or egress fetch) is aborted, so none runs
   * on for up to its own deadline with no one left to take the answer.
   */
  private settleOutstanding(): void {
    for (const resolvePromise of this.replies.values()) resolvePromise(null);
    this.replies.clear();
    for (const { controller } of this.served.values()) controller.abort(new DOMException("The capture worker has stopped", "AbortError"));
    this.served.clear();
  }

  /** No worker: the host runs on this thread, starting with the calls queued so far. */
  private runLocally(reason: unknown): void {
    if (reason !== null) {
      this.options.log("warn", "OmniRush capture worker could not start; capturing in-process", { error: errorSummary(reason) });
    }
    const { worker: _worker, stopTimeoutMs: _stopTimeoutMs, restartBackoffMs: _backoff, onModeChange: _onModeChange, ...hostOptions } = this.options;
    this.canRunLocally = false;
    try {
      this.local = new CaptureHost(hostOptions);
    } catch (error) {
      // Only reached after a worker failed the same way: new workers are tried, with the queued calls kept for them.
      if (reason === null) throw error;
      this.scheduleRestart("OmniRush capture could not start in-process either; starting a new capture worker", { error: errorSummary(error) });
      return;
    }
    this.setMode("local");
    for (const { call } of this.takeQueue()) {
      const id = call.id;
      let value: unknown = null;
      try {
        value = invokeCapture(this.local, call);
      } catch (error) {
        this.options.log("warn", "OmniRush capture call failed", { method: call.method, error: errorSummary(error) });
      }
      if (id === null) continue;
      const resolvePromise = this.replies.get(id);
      this.replies.delete(id);
      Promise.resolve(value).then((settled) => resolvePromise?.(settled), () => resolvePromise?.(null));
    }
  }

  // --- the worker's requests ------------------------------------------------------------

  private async serve(worker: Worker, id: number, channel: RequestChannel, request: HostRequest): Promise<void> {
    const controller = new AbortController();
    // Shutting down: archive uploads were aborted, and none starts again.
    if (this.stopping && channel === "archive") controller.abort();
    this.served.set(id, { controller, channel });
    let result: RequestResult;
    try {
      if (controller.signal.aborted) throw new DOMException("The server is stopping", "AbortError");
      result = await this.perform(channel, request, controller.signal, id);
    } catch (error) {
      result = { kind: "result", id, ok: false, error: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : "Error" };
    } finally {
      this.served.delete(id);
    }
    if (worker !== this.worker) return;
    worker.postMessage(result satisfies ToWorker, result.ok ? transferables(result.response) : []);
  }

  private async perform(channel: RequestChannel, request: HostRequest, signal: AbortSignal, id: number): Promise<RequestResult> {
    const { sessionUploader, archive } = this.options;
    switch (request.type) {
      case "upload": {
        if (!sessionUploader.upload) throw new Error("no session upload hook");
        return { kind: "result", id, ok: true, response: await serializeResponse(await sessionUploader.upload(request.sessionId, request.body, signal, request.options)) };
      }
      case "uploadFile": {
        if (!sessionUploader.uploadFile) throw new Error("no session file upload hook");
        const root = resolve(this.options.stateDir);
        const path = resolve(request.path);
        if (!path.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("capture file is outside the state directory");
        const file = await lstat(path);
        if (!file.isFile() || file.size !== request.size || file.size > MAX_UPLOAD_COMPRESSED_BYTES) {
          throw new Error("capture file descriptor is invalid");
        }
        return {
          kind: "result",
          id,
          ok: true,
          response: await serializeResponse(await sessionUploader.uploadFile(request.sessionId, path, request.size, signal, request.options)),
        };
      }
      case "capabilities": {
        if (!sessionUploader.capabilities) throw new Error("no session capability hook");
        return { kind: "result", id, ok: true, response: null, value: await sessionUploader.capabilities() };
      }
      case "sessionIntegrity": {
        if (!this.options.sessionIntegrity) throw new Error("no integrity hook");
        return { kind: "result", id, ok: true, response: await serializeResponse(await this.options.sessionIntegrity(request.sessionId, {
          ...(request.summary ? { summary: true } : {}),
          ...(request.turns !== undefined ? { turns: request.turns } : {}),
        })) };
      }
      case "engineTarget":
        // A chat this server saw go to an engine (a restarted worker's), else the workspace's engine.
        return {
          kind: "result",
          id,
          ok: true,
          response: null,
          target: this.observedTargets.get(request.sessionId) ?? (this.options.engineTarget ? await this.options.engineTarget(request.sessionId, request.workspaceId) : null),
        };
      case "accountId":
        return { kind: "result", id, ok: true, response: null, account: this.options.accountId ? await this.options.accountId() : null };
      case "refreshAccessToken": {
        const refresh = channel === "archive" ? archive.refreshAccessToken : sessionUploader.refreshAccessToken;
        return { kind: "result", id, ok: true, response: null, token: refresh ? await refresh() : null };
      }
      case "archiveRequest": {
        if (!archive.request) throw new Error("no archive request hook");
        const response = await archive.request(request.path, {
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
          ...(request.refresh === false ? { refresh: false as const } : {}),
          signal,
        });
        return { kind: "result", id, ok: true, response: await serializeResponse(response) };
      }
      case "fetch": {
        const egress = (channel === "archive" ? archive.fetch : sessionUploader.fetch) ?? externalFetch;
        const response = await egress(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
          signal,
        });
        return { kind: "result", id, ok: true, response: await serializeResponse(response) };
      }
    }
  }
}

/** The answer if it comes within `ms`, else false (as for a failed check). */
async function withinTimeout(answer: boolean | Promise<boolean>, ms: number): Promise<boolean> {
  if (typeof answer === "boolean") return answer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([answer.catch(() => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

function filesUsedStatusOf(value: unknown): FilesUsedStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const flag = (item: unknown) => (typeof item === "boolean" ? item : null);
  return { active: flag(record.active), available: flag(record.available), consentText: typeof record.consentText === "string" ? record.consentText : null };
}

function isDiagnostics(value: unknown): value is CaptureDiagnostics {
  return typeof value === "object" && value !== null && "metrics" in value && "cache" in value;
}

export function startCaptureService(options: CaptureServiceOptions): CaptureService {
  return new CaptureClient(options);
}
