/**
 * The server's handle on session capture (the workspace collector, the
 * project archive and the turn observers, see capture-host.ts). By default
 * the capture runs on a worker thread (capture-worker.ts): the main event
 * loop, which serves the app (in the desktop app, the Electron main process),
 * only posts calls and answers the worker's requests for the gateway broker
 * and external egress. Opening or switching sessions never waits on a scan,
 * a snapshot or an archive. If the worker cannot start (a runtime without
 * worker support for this module, or OMNIRUSH_CAPTURE_WORKER=0) the same host
 * runs in-process; a worker that dies after starting is replaced, a bounded
 * number of times.
 */
import { Worker } from "node:worker_threads";

import { CaptureHost, type CaptureDiagnostics, type CaptureHostOptions, type EngineTarget, type PromptRecord } from "./capture-host.js";
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
import { isCollectableWebUrl, workspaceCollectorEnabled, type CollectorWebVisit } from "./workspace-collector.js";

/** A prompt body larger than this is not traced, so it is not copied to the worker either. */
const MAX_TRACED_REQUEST_BYTES = 4 * 1024 * 1024;
/** Shutdown waits this long for the last traces and end snapshots before the worker is terminated. */
const STOP_TIMEOUT_MS = 20_000;
/** Shutdown waits this long to learn whether the account is still there (for the final project archives), else packs none. */
const ACCOUNT_CHECK_TIMEOUT_MS = 1_000;
/** A worker that exits unexpectedly is replaced at most this many times per server. */
const MAX_WORKER_RESTARTS = 3;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type CaptureServiceOptions = Omit<CaptureHostOptions, "onSessionClosed"> & {
  /** Run capture on a worker thread; default on unless OMNIRUSH_CAPTURE_WORKER is 0, false, no or off. */
  worker?: boolean;
};

export type CaptureService = {
  /** The collector has an account to upload to (the sign-in gate's question). */
  readonly collectorEnabled: boolean;
  /** Where capture runs right now. */
  mode(): "starting" | "worker" | "local" | "down";
  /** Whether the collector is tracking this session (started and not finished). */
  hasSession(sessionId: string): boolean;
  startSession(sessionId: string, workspaceId: string, root: string): void;
  recordTrace(sessionId: string, type: string, data?: unknown): void;
  /** The "engine.request" event of a collected request (its body parsed off the main thread), plus a prompt's attachments. */
  recordPrompt(sessionId: string, prompt: Omit<PromptRecord, "body"> & { body: ArrayBuffer | undefined }): void;
  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed"): void;
  /** Whether the visit is recorded (a tracked session and a collectable URL). */
  recordWebVisit(sessionId: string, visit: CollectorWebVisit): boolean;
  archiveSessionStarted(sessionId: string, root: string, target: EngineTarget): void;
  observeSession(sessionId: string, target: EngineTarget): void;
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
};

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
  readonly collectorEnabled: boolean;
  private current: "starting" | "worker" | "local" | "down" = "starting";
  private worker: Worker | null = null;
  private local: CaptureHost | null = null;
  private queue: QueuedCall[] = [];
  private callSeq = 0;
  /** Calls waiting for the worker's reply. */
  private readonly replies = new Map<number, (value: unknown) => void>();
  /** The worker's requests being served on this thread. */
  private readonly served = new Map<number, { controller: AbortController; channel: RequestChannel }>();
  /** Sessions the worker's collector tracks: true while live, false once finishing. */
  private readonly sessions = new Map<string, boolean>();
  private restarts = 0;
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: CaptureServiceOptions) {
    this.collectorEnabled = workspaceCollectorEnabled({
      upload: Boolean(options.collector.upload),
      gatewayUrl: options.collector.gatewayUrl,
      accessToken: options.collector.accessToken,
    });
    if (options.worker ?? captureWorkerEnabled()) this.spawn();
    else this.runLocally(null);
  }

  mode(): "starting" | "worker" | "local" | "down" {
    return this.current;
  }

  hasSession(sessionId: string): boolean {
    if (this.local) return this.local.collector.hasSession(sessionId);
    return this.sessions.get(sessionId) === true;
  }

  startSession(sessionId: string, workspaceId: string, root: string): void {
    if (this.collectorEnabled && SESSION_ID_PATTERN.test(sessionId) && !this.sessions.has(sessionId)) this.sessions.set(sessionId, true);
    this.send({ kind: "call", id: null, method: "startSession", args: [sessionId, workspaceId, root] });
  }

  recordTrace(sessionId: string, type: string, data?: unknown): void {
    this.send({ kind: "call", id: null, method: "recordTrace", args: data === undefined ? [sessionId, type] : [sessionId, type, data] });
  }

  recordPrompt(sessionId: string, prompt: Omit<PromptRecord, "body"> & { body: ArrayBuffer | undefined }): void {
    // The body is still forwarded to the engine: the worker gets its own copy, moved rather than cloned.
    const body = prompt.body && prompt.body.byteLength > 0 && prompt.body.byteLength <= MAX_TRACED_REQUEST_BYTES ? new Uint8Array(prompt.body.slice(0)) : null;
    this.send({ kind: "call", id: null, method: "recordPrompt", args: [sessionId, { ...prompt, body }] }, body ? [body.buffer] : []);
  }

  captureSnapshot(sessionId: string, trigger: "prompt" | "turn_completed"): void {
    this.send({ kind: "call", id: null, method: "captureSnapshot", args: [sessionId, trigger] });
  }

  recordWebVisit(sessionId: string, visit: CollectorWebVisit): boolean {
    if (this.local) return this.local.recordWebVisit(sessionId, visit);
    if (!this.hasSession(sessionId) || typeof visit.url !== "string" || !isCollectableWebUrl(visit.url)) return false;
    this.send({ kind: "call", id: null, method: "recordWebVisit", args: [sessionId, visit] });
    return true;
  }

  archiveSessionStarted(sessionId: string, root: string, target: EngineTarget): void {
    this.send({ kind: "call", id: null, method: "archiveSessionStarted", args: [sessionId, root, target] });
  }

  observeSession(sessionId: string, target: EngineTarget): void {
    this.send({ kind: "call", id: null, method: "observeSession", args: [sessionId, target] });
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

  stop(options: { archiveFinals?: boolean | Promise<boolean> } = {}): Promise<void> {
    this.stopping ??= this.shutdown(options.archiveFinals ?? true);
    return this.stopping;
  }

  private async shutdown(archiveFinals: boolean | Promise<boolean>): Promise<void> {
    // First, and synchronously: archive uploads this thread makes for the worker are aborted now.
    for (const { controller, channel } of this.served.values()) if (channel === "archive") controller.abort();
    const finals = await withinTimeout(archiveFinals, ACCOUNT_CHECK_TIMEOUT_MS);
    const done = this.dispatch({ kind: "call", id: null, method: "stop", args: [{ archiveFinals: finals }] }, [], true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolvePromise) => {
      timer = setTimeout(() => {
        this.options.log("warn", "OmniRush capture did not stop in time; the capture worker is terminated", { timeoutMs: STOP_TIMEOUT_MS });
        resolvePromise();
      }, STOP_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([done, timedOut]);
    clearTimeout(timer);
    const worker = this.worker;
    this.worker = null;
    this.current = "down";
    if (worker) await worker.terminate().catch(() => undefined);
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
    else this.queue.push({ call, transfer });
    return reply;
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
    const { collector, archive } = this.options;
    return {
      stateDir: this.options.stateDir,
      appVersion: this.options.appVersion,
      engineVersion: this.options.engineVersion,
      collector: {
        upload: Boolean(collector.upload),
        refreshAccessToken: Boolean(collector.refreshAccessToken),
        ...(collector.gatewayUrl !== undefined ? { gatewayUrl: collector.gatewayUrl } : {}),
        ...(collector.accessToken !== undefined ? { accessToken: collector.accessToken } : {}),
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
    this.current = "starting";
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { workerData: this.workerInit() });
    } catch (error) {
      this.runLocally(error);
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
        this.current = "worker";
        const queued = this.queue;
        this.queue = [];
        for (const { call, transfer } of queued) this.post(worker, call, transfer);
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
    for (const { controller } of this.served.values()) controller.abort();
    this.settleOutstanding();
    if (this.stopping) return;
    if (this.current === "starting") {
      this.runLocally(new Error(`the capture worker exited with code ${code} before it was ready`));
      return;
    }
    // Its sessions are gone with it; each resumes on its next prompt.
    this.sessions.clear();
    if (this.restarts < MAX_WORKER_RESTARTS) {
      this.restarts += 1;
      this.options.log("warn", "OmniRush capture worker exited; starting a new one", { code, restarts: this.restarts });
      this.spawn();
      return;
    }
    this.current = "down";
    this.options.log("warn", "OmniRush capture worker exited too often; capture is off until the app restarts", { code });
  }

  /** Every caller waiting on the worker gets an empty result. */
  private settleOutstanding(): void {
    for (const resolvePromise of this.replies.values()) resolvePromise(null);
    this.replies.clear();
    this.served.clear();
  }

  /** No worker: the host runs on this thread, starting with the calls queued so far. */
  private runLocally(reason: unknown): void {
    if (reason !== null) {
      this.options.log("warn", "OmniRush capture worker could not start; capturing in-process", { error: errorSummary(reason) });
    }
    const { worker: _worker, ...hostOptions } = this.options;
    try {
      this.local = new CaptureHost(hostOptions);
    } catch (error) {
      // Only reached after a worker failed the same way: capture is off rather than the server down.
      if (reason === null) throw error;
      this.options.log("warn", "OmniRush capture could not start in-process either; capture is off until the app restarts", { error: errorSummary(error) });
      this.current = "down";
      this.queue = [];
      this.settleOutstanding();
      return;
    }
    this.current = "local";
    const queued = this.queue;
    this.queue = [];
    for (const { call } of queued) {
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
    const { collector, archive } = this.options;
    switch (request.type) {
      case "collect": {
        if (!collector.upload) throw new Error("no collector upload hook");
        return { kind: "result", id, ok: true, response: await serializeResponse(await collector.upload(request.sessionId, request.body)) };
      }
      case "refreshAccessToken": {
        const refresh = channel === "archive" ? archive.refreshAccessToken : collector.refreshAccessToken;
        return { kind: "result", id, ok: true, response: null, token: refresh ? await refresh() : null };
      }
      case "archiveRequest": {
        if (!archive.request) throw new Error("no archive request hook");
        const response = await archive.request(request.path, { method: request.method, ...(request.body !== undefined ? { body: request.body } : {}), signal });
        return { kind: "result", id, ok: true, response: await serializeResponse(response) };
      }
      case "fetch": {
        const egress = (channel === "archive" ? archive.fetch : collector.fetch) ?? externalFetch;
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

function isDiagnostics(value: unknown): value is CaptureDiagnostics {
  return typeof value === "object" && value !== null && "metrics" in value && "cache" in value;
}

export function startCaptureService(options: CaptureServiceOptions): CaptureService {
  return new CaptureClient(options);
}
