/**
 * The capture worker: a worker thread running the server's CaptureHost (the
 * workspace collector, the project archive and the turn observers), so their
 * CPU work never holds the main event loop. Started and driven by
 * capture-client.ts; the messages are defined in capture-protocol.ts. The
 * gateway broker's requests and external egress are made by the main thread
 * on this worker's behalf; everything else (file reads, git, the scrubber,
 * zstd, sealing, the loopback engine reads) happens here.
 */
import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import { CaptureHost } from "./capture-host.js";
import {
  deserializeResponse,
  invokeCapture,
  transferables,
  type CaptureWorkerInit,
  type FromWorker,
  type HostRequest,
  type RequestChannel,
  type RequestResult,
  type ToWorker,
} from "./capture-protocol.js";
import type { ArchiveApiRequestInit } from "./session-archive/upload.js";

function mainThreadPort(): MessagePort {
  if (!parentPort) throw new Error("capture-worker runs as a worker thread only");
  return parentPort;
}

const port = mainThreadPort();
const init: CaptureWorkerInit = workerData;

function post(message: FromWorker, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

let requestSeq = 0;
const pending = new Map<number, (result: RequestResult) => void>();

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
}

/** Asks the main thread to perform `request`; an abort of `signal` cancels it there too. */
function ask(channel: RequestChannel, request: HostRequest, signal?: AbortSignal | null): Promise<RequestResult & { ok: true }> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const id = ++requestSeq;
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      pending.delete(id);
      post({ kind: "abort", id });
      if (signal) reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, (result) => {
      signal?.removeEventListener("abort", onAbort);
      if (result.ok) resolvePromise(result);
      else {
        const error = new Error(result.error);
        error.name = result.name;
        reject(error);
      }
    });
    post({ kind: "request", id, channel, request }, transferables(request));
  });
}

/** A private copy of a body, so the caller's buffer stays usable (a retry sends it again) while the copy is transferred. */
function ownedBody(body: RequestInit["body"]): Uint8Array<ArrayBuffer> | string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  throw new TypeError("capture worker requests carry string or byte bodies only");
}

/** External egress through the main thread's runtime (Electron's network stack in the desktop app). */
function hostFetch(channel: RequestChannel) {
  return async (url: string, requestInit: RequestInit = {}): Promise<Response> => {
    const body = ownedBody(requestInit.body);
    const result = await ask(channel, {
      type: "fetch",
      url,
      method: requestInit.method ?? "GET",
      headers: [...new Headers(requestInit.headers)],
      ...(body !== undefined ? { body } : {}),
    }, requestInit.signal);
    if (!result.response) throw new Error("the main thread returned no response");
    return deserializeResponse(result.response);
  };
}

function refreshAccessToken(channel: RequestChannel) {
  return async (): Promise<string | null> => (await ask(channel, { type: "refreshAccessToken" })).token ?? null;
}

const log = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => {
  post({ kind: "log", level, message, ...(attributes ? { attributes } : {}) });
};

const host = new CaptureHost({
  stateDir: init.stateDir,
  appVersion: init.appVersion,
  engineVersion: init.engineVersion,
  log,
  collector: {
    ...(init.collector.upload
      ? {
          upload: async (sessionId: string, compressed: Uint8Array) => {
            const body = new Uint8Array(compressed);
            const result = await ask("collector", { type: "collect", sessionId, body });
            if (!result.response) throw new Error("the main thread returned no response");
            return deserializeResponse(result.response);
          },
        }
      : {}),
    ...(init.collector.refreshAccessToken ? { refreshAccessToken: refreshAccessToken("collector") } : {}),
    fetch: hostFetch("collector"),
    ...(init.collector.gatewayUrl !== undefined ? { gatewayUrl: init.collector.gatewayUrl } : {}),
    ...(init.collector.accessToken !== undefined ? { accessToken: init.collector.accessToken } : {}),
  },
  archive: {
    enabled: init.archive.enabled,
    excludedDirs: init.archive.excludedDirs,
    folderGate: init.archive.folderGate,
    ...(init.archive.request
      ? {
          request: async (path: string, requestInit: ArchiveApiRequestInit) => {
            const result = await ask("archive", {
              type: "archiveRequest",
              path,
              method: requestInit.method,
              ...(requestInit.body !== undefined ? { body: requestInit.body } : {}),
              ...(requestInit.refresh === false ? { refresh: false as const } : {}),
            }, requestInit.signal);
            if (!result.response) throw new Error("the main thread returned no response");
            return deserializeResponse(result.response);
          },
        }
      : {}),
    ...(init.archive.refreshAccessToken ? { refreshAccessToken: refreshAccessToken("archive") } : {}),
    fetch: hostFetch("archive"),
    ...(init.archive.gatewayUrl !== undefined ? { gatewayUrl: init.archive.gatewayUrl } : {}),
    ...(init.archive.accessToken !== undefined ? { accessToken: init.archive.accessToken } : {}),
    ...(init.archive.baseIdleMs !== undefined ? { baseIdleMs: init.archive.baseIdleMs } : {}),
    ...(init.archive.baseMaxDeferMs !== undefined ? { baseMaxDeferMs: init.archive.baseMaxDeferMs } : {}),
  },
  onSessionClosed: (sessionId) => post({ kind: "closed", sessionId }),
});

port.on("message", (message: ToWorker) => {
  if (message.kind === "result") {
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle?.(message);
    return;
  }
  const { id } = message;
  let value: unknown;
  try {
    value = invokeCapture(host, message);
  } catch (error) {
    if (id !== null) post({ kind: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (id === null) {
    if (value instanceof Promise) value.catch(() => undefined);
    return;
  }
  Promise.resolve(value).then(
    (settled) => post({ kind: "reply", id, ok: true, value: settled ?? null }),
    (error: unknown) => post({ kind: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
});

post({ kind: "ready" });
