/**
 * The messages between the server's main thread and its capture worker
 * (capture-client.ts, capture-worker.ts). The main thread calls the
 * CaptureHost methods named in CaptureCalls; the worker asks the main thread
 * for what only it can do (the gateway broker's authenticated requests, and
 * external egress through the embedding runtime's network stack) and reports
 * logs and closed sessions. Everything is plain data; request and response
 * bodies travel as transferred buffers.
 */
import type { CaptureHost, EngineTarget, PromptRecord } from "./capture-host.js";
import type { FolderGateOptions } from "./session-archive/detect.js";
import type { CollectorWebVisit } from "./workspace-collector.js";

/** How the capture stops: `archiveFinals` false (the account is gone) packs no final project archives. */
export type CaptureStopOptions = { archiveFinals: boolean };

/** CaptureHost methods callable from the main thread, with their arguments. */
export type CaptureCalls = {
  startSession: [sessionId: string, workspaceId: string, root: string];
  recordTrace: [sessionId: string, type: string, data?: unknown];
  recordPrompt: [sessionId: string, prompt: PromptRecord];
  captureSnapshot: [sessionId: string, trigger: "prompt" | "turn_completed"];
  recordWebVisit: [sessionId: string, visit: CollectorWebVisit];
  archiveSessionStarted: [sessionId: string, root: string, target: EngineTarget];
  observeSession: [sessionId: string, target: EngineTarget];
  sessionDeleted: [sessionId: string];
  signOut: [];
  stop: [options?: CaptureStopOptions];
  idle: [];
  diagnostics: [];
};

export type CaptureCallName = keyof CaptureCalls;

/** One call; `id` is set when the caller waits for its result. */
export type CaptureCall = { [M in CaptureCallName]: { kind: "call"; id: number | null; method: M; args: CaptureCalls[M] } }[CaptureCallName];

/** What a worker asks of the main thread. `channel` says whose request it is: archive requests are aborted first at shutdown. */
export type HostRequest =
  | { type: "collect"; sessionId: string; body: Uint8Array<ArrayBuffer> }
  | { type: "refreshAccessToken" }
  | { type: "archiveRequest"; path: string; method: "GET" | "POST"; body?: string }
  | { type: "fetch"; url: string; method: string; headers: Array<[string, string]>; body?: Uint8Array<ArrayBuffer> | string };

export type RequestChannel = "collector" | "archive";

export type SerializedResponse = { status: number; statusText: string; headers: Array<[string, string]>; body: ArrayBuffer | null };

export type RequestResult =
  | { kind: "result"; id: number; ok: true; response: SerializedResponse | null; token?: string | null }
  | { kind: "result"; id: number; ok: false; error: string; name: string };

export type ToWorker = CaptureCall | RequestResult;

export type FromWorker =
  | { kind: "ready" }
  | { kind: "log"; level: "info" | "warn"; message: string; attributes?: Record<string, unknown> }
  | { kind: "closed"; sessionId: string }
  | { kind: "reply"; id: number; ok: true; value: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "request"; id: number; channel: RequestChannel; request: HostRequest }
  | { kind: "abort"; id: number };

/** What the worker is built with (its workerData): the main thread's hooks become requests. */
export type CaptureWorkerInit = {
  stateDir: string;
  appVersion: string;
  engineVersion: string;
  collector: { upload: boolean; refreshAccessToken: boolean; gatewayUrl?: string; accessToken?: string };
  archive: {
    enabled: boolean;
    excludedDirs: string[];
    folderGate?: FolderGateOptions;
    request: boolean;
    refreshAccessToken: boolean;
    gatewayUrl?: string;
    accessToken?: string;
    baseIdleMs?: number;
    baseMaxDeferMs?: number;
  };
};

export async function serializeResponse(response: Response): Promise<SerializedResponse> {
  const body = response.body ? await response.arrayBuffer() : null;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body: body && body.byteLength > 0 ? body : null,
  };
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function deserializeResponse(value: SerializedResponse): Response {
  return new Response(NULL_BODY_STATUSES.has(value.status) ? null : value.body, {
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
  });
}

/** The buffers of a request or result that can be transferred instead of copied. */
export function transferables(value: HostRequest | SerializedResponse | null): ArrayBuffer[] {
  if (!value) return [];
  const body = "body" in value ? value.body : undefined;
  if (body instanceof ArrayBuffer) return [body];
  if (body instanceof Uint8Array && body.byteOffset === 0 && body.byteLength === body.buffer.byteLength) return [body.buffer];
  return [];
}

/** Runs one call on a host (the worker's, or the in-process fallback). */
export function invokeCapture(host: CaptureHost, call: CaptureCall): unknown {
  switch (call.method) {
    case "startSession":
      return host.startSession(...call.args);
    case "recordTrace":
      return host.recordTrace(...call.args);
    case "recordPrompt":
      return host.recordPrompt(...call.args);
    case "captureSnapshot":
      return host.captureSnapshot(...call.args);
    case "recordWebVisit":
      return host.recordWebVisit(...call.args);
    case "archiveSessionStarted":
      return host.archiveSessionStarted(...call.args);
    case "observeSession":
      return host.observeSession(...call.args);
    case "sessionDeleted":
      return host.sessionDeleted(...call.args);
    case "signOut":
      return host.signOut();
    case "stop":
      return host.stop(...call.args);
    case "idle":
      return host.idle();
    case "diagnostics":
      return host.diagnostics();
  }
}
