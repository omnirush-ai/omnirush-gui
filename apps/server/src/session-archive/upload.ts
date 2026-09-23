/**
 * The archive upload client (sections 7 and 13.5): JSON calls to the
 * omnirush.ai archive routes, and part PUTs straight to S3 through presigned
 * URLs, each part read from the sealed file when it is sent. Presigned URLs
 * and bearer tokens are credentials and are never logged.
 */
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";

import { parseArchivePolicy, type ArchivePolicy } from "./policy.js";
import { SEAL_ALG, SEAL_CONTENT, sealKid } from "./seal.js";

export type ArchiveFetch = (input: string, init?: RequestInit) => Promise<Response>;
/**
 * An authenticated request to the omnirush.ai API, relative to its root
 * (`archives/key`, `archives`, `archives/<id>/parts`, ...). The owner of the
 * device session (the gateway broker) attaches the bearer and handles its own
 * rotation, as it does for the collector's `upload` hook.
 */
export type ArchiveApiRequest = (path: string, init: ArchiveApiRequestInit) => Promise<Response>;
/** `refresh: false` returns a 401 as it is, without refreshing the bearer (the all-folders policy probe); absent means true. */
export type ArchiveApiRequestInit = { method: "GET" | "POST"; body?: string; signal?: AbortSignal; refresh?: false };
export type ArchiveLog = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;

export type RetryPolicy = {
  /** First backoff; doubles per attempt (1 s). */
  baseMs: number;
  /** Backoff cap (5 min). */
  maxMs: number;
  /** Attempts per request before it is left to the next drain (8). */
  attempts: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolvePromise();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseMs: 1_000, maxMs: 5 * 60_000, attempts: 8, sleep, random: Math.random };

/** Exponential backoff with plus or minus 20% jitter. */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  const exact = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exact * (0.8 + 0.4 * policy.random()));
}

const REQUEST_TIMEOUT_MS = 30_000;
/** The all-folders policy probe: one attempt this long at most, no backoff and no bearer refresh. */
export const POLICY_PROBE_TIMEOUT_MS = 5_000;
/** A part PUT may take this long at least, and longer for big parts on slow links (32 KB/s floor). */
const PART_MIN_TIMEOUT_MS = 10 * 60_000;
const PART_MIN_BYTES_PER_MS = 32;
/** A part is read from the sealed file in slices this big, checking for an abort between them. */
const PART_READ_SLICE_BYTES = 1024 * 1024;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PART_RETRYABLE_STATUSES = new Set([400, 408, 429, 500, 502, 503, 504]);
const MAX_PARTS_PER_REQUEST = 100;
const MAX_UPLOAD_ROUNDS = 6;
/** 422 on create for a marker whose policy is off (`folder`, `touched`). */
export const ARCHIVE_MARKER_NOT_ALLOWED = "archive_marker_not_allowed";
/** Create conflicts that end the session's chain (section 7.9). */
const CHAIN_ENDING_CODES = new Set(["archive_id_conflict", "archive_sequence_conflict", "archive_parent_mismatch", "archive_deleted"]);

/**
 * The omnirush.ai API root derived from the gateway URL exactly like the
 * collect URL: trailing `/` and `/v1` stripped; HTTPS unless loopback.
 */
export function resolveArchiveApiRoot(rawGatewayUrl: string | undefined): string | null {
  const value = rawGatewayUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname))) return null;
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export type ArchiveCreateRequest = {
  archive_id: string;
  session_id: string;
  kind: "base" | "delta";
  sequence: number;
  turn: number;
  parent_archive_id: string | null;
  size: number;
  sha256: string;
  kid: string;
  content: typeof SEAL_CONTENT;
  marker: string;
};

export type ArchiveUploadState = {
  upload_id: string;
  object_key: string;
  part_size: number;
  part_count: number;
  /** part number -> ETag exactly as S3 returned it (quotes included). */
  etags: Record<string, string>;
};

/** What the uploader needs from a queued job; it mutates `upload` and `recreates` and persists through the callback. */
export type ArchiveUploadJob = {
  request: ArchiveCreateRequest;
  sealedPath: string;
  upload: ArchiveUploadState | null;
  recreates: number;
};

export type ArchiveKey = { kid: string; publicKey: Buffer; alg: string };

export type KeyResult =
  /** The policy comes with the key, in the same response. */
  | { status: "ok"; key: ArchiveKey; policy: ArchivePolicy }
  | { status: "disabled"; code: string }
  | { status: "unavailable"; reason: string };

export type UploadOutcome =
  | { status: "uploaded" }
  /** 428 / 503 archive_disabled: archiving is off for the user, without error. */
  | { status: "disabled"; code: string }
  /** 401 after a refresh, or 403: stop draining and keep the queue. */
  | { status: "blocked"; reason: string }
  /** A chain-ending conflict, 413 or 422 (archive_marker_not_allowed, else archive_request_invalid): drop the session's jobs and stop archiving it. */
  | { status: "stop_session"; code: string }
  /** 409 archive_kid_unknown: the archive was sealed to a key the server no longer has. */
  | { status: "rekey"; code: string }
  /** Transient failure after the retries: leave the job to a later drain. */
  | { status: "retry_later"; reason: string }
  | { status: "aborted" };

const keySchema = z.object({ kid: z.string().regex(/^[0-9a-f]{16}$/), public_key: z.string(), alg: z.string() });
const partUrlSchema = z.object({ part_number: z.number().int().min(1), url: z.string().min(1) });
const createSchema = z.object({
  archive_id: z.string(),
  status: z.string(),
  upload_id: z.string().nullish(),
  object_key: z.string().nullish(),
  part_size: z.number().int().positive().nullish(),
  part_count: z.number().int().positive().nullish(),
  parts: z.array(partUrlSchema).nullish(),
});
const partsSchema = z.object({
  parts: z.array(partUrlSchema),
  uploaded: z.array(z.object({ part_number: z.number().int().min(1), etag: z.string().min(1), size: z.number().int().nonnegative() })).nullish(),
});

type ApiResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "error"; status: number; code: string | null }
  | { kind: "unavailable"; reason: string }
  | { kind: "aborted" };

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    if ("detail" in body && typeof body.detail === "string") return body.detail;
    if ("error" in body && typeof body.error === "string") return body.error;
  } catch {
    // Not JSON: the status alone decides.
  }
  return null;
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type ArchiveUploaderOptions = {
  gatewayUrl?: string;
  accessToken?: string;
  refreshAccessToken?: () => Promise<string | null>;
  /** External egress (S3 PUTs, and API calls without `request`). */
  fetch: ArchiveFetch;
  request?: ArchiveApiRequest;
  retry?: Partial<RetryPolicy>;
  log?: ArchiveLog;
};

type PartsResult = { urls: Map<number, string>; uploaded: Array<{ part_number: number; etag: string; size: number }> };

/**
 * One part of the sealed file, read into a single buffer (null once `signal`
 * aborted: nothing more is read). A single-chunk body gets a Content-Length
 * from every fetch and is copied once by Electron's net.fetch, which collects
 * a streamed body with one Buffer.concat per chunk before sending it; a 64 MiB
 * part streamed in 64 KiB Blob chunks costs seconds of main-process copying.
 */
async function readPart(file: FileHandle, start: number, length: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  while (offset < length) {
    if (signal?.aborted) return null;
    const { bytesRead } = await file.read(bytes, offset, Math.min(PART_READ_SLICE_BYTES, length - offset), start + offset);
    if (bytesRead === 0) throw new Error("archive file ended early");
    offset += bytesRead;
  }
  return signal?.aborted ? null : bytes;
}

export class ArchiveUploader {
  private token: string | null;
  private readonly apiRoot: string | null;
  private readonly retry: RetryPolicy;
  private readonly log: ArchiveLog;

  constructor(private readonly options: ArchiveUploaderOptions) {
    this.token = options.accessToken?.trim() || null;
    this.apiRoot = resolveArchiveApiRoot(options.gatewayUrl);
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.log = options.log ?? (() => undefined);
  }

  /** Whether the API can be reached at all: a request hook, or a gateway URL plus a bearer. */
  get configured(): boolean {
    return Boolean(this.options.request) || (this.apiRoot !== null && this.token !== null);
  }

  setAccessToken(token: string | null): void {
    this.token = token?.trim() || null;
  }

  private send(method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal, probe = false): Promise<Response> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const timeout = timeoutSignal(probe ? POLICY_PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS, signal);
    if (this.options.request) return this.options.request(path, { method, ...(payload === undefined ? {} : { body: payload }), signal: timeout, ...(probe ? { refresh: false as const } : {}) });
    if (!this.apiRoot || !this.token) return Promise.reject(new Error("archive API not configured"));
    return this.options.fetch(`${this.apiRoot}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: payload }),
      signal: timeout,
    });
  }

  private async refresh(): Promise<boolean> {
    if (!this.options.refreshAccessToken) return false;
    try {
      const token = (await this.options.refreshAccessToken())?.trim() ?? "";
      if (!token) return false;
      this.token = token;
      return true;
    } catch {
      return false;
    }
  }

  /** One API call: 401 refreshes the bearer once; network errors and retryable statuses back off. */
  private async call(method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal): Promise<ApiResult> {
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) return { kind: "aborted" };
      let response: Response;
      let failure: string;
      try {
        response = await this.send(method, path, body, signal);
        if (response.ok) {
          const parsed: unknown = await response.json().catch(() => null);
          return { kind: "ok", status: response.status, body: parsed };
        }
        const code = await errorCode(response);
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          if (await this.refresh()) continue;
        }
        if (!RETRYABLE_STATUSES.has(response.status) || (response.status === 503 && code === "archive_disabled")) {
          return { kind: "error", status: response.status, code };
        }
        failure = `status ${response.status}`;
      } catch (error) {
        if (signal?.aborted) return { kind: "aborted" };
        failure = error instanceof Error ? error.name : "network error";
      }
      attempt += 1;
      if (attempt >= this.retry.attempts) return { kind: "unavailable", reason: failure };
      await this.retry.sleep(backoffMs(this.retry, attempt), signal);
    }
  }

  /** The outcome for failures every route shares (7.1, 7.9); null when the caller decides. */
  private common(result: ApiResult): UploadOutcome | null {
    if (result.kind === "aborted") return { status: "aborted" };
    if (result.kind === "unavailable") return { status: "retry_later", reason: result.reason };
    if (result.kind === "ok") return null;
    if (result.status === 401) return { status: "blocked", reason: "unauthorized" };
    if (result.status === 403) return { status: "blocked", reason: result.code ?? "forbidden" };
    if (result.status === 428) return { status: "disabled", code: result.code ?? "archive_consent_required" };
    if (result.status === 503) return { status: "disabled", code: result.code ?? "archive_disabled" };
    if (result.status === 413) return { status: "stop_session", code: result.code ?? "archive_too_large" };
    // The server does not take this marker (a folder policy that is off): the chain goes, with no retry.
    if (result.status === 422) return { status: "stop_session", code: result.code === ARCHIVE_MARKER_NOT_ALLOWED ? result.code : "archive_request_invalid" };
    return null;
  }

  /** One GET with a single attempt: no bearer refresh on a 401, no backoff; a retryable failure is `unavailable`. */
  private async getOnce(path: string, signal?: AbortSignal): Promise<ApiResult> {
    if (signal?.aborted) return { kind: "aborted" };
    try {
      const response = await this.send("GET", path, undefined, signal, true);
      if (response.ok) return { kind: "ok", status: response.status, body: await response.json().catch(() => null) };
      const code = await errorCode(response);
      if (!RETRYABLE_STATUSES.has(response.status) || (response.status === 503 && code === "archive_disabled")) return { kind: "error", status: response.status, code };
      return { kind: "unavailable", reason: `status ${response.status}` };
    } catch (error) {
      if (signal?.aborted) return { kind: "aborted" };
      return { kind: "unavailable", reason: error instanceof Error ? error.name : "network error" };
    }
  }

  /** GET /archives/key (7.2). 428, 503 and a server without the route all mean archiving is off. */
  async fetchKey(signal?: AbortSignal): Promise<KeyResult> {
    if (!this.configured) return { status: "disabled", code: "not_configured" };
    return this.keyResult(await this.call("GET", "archives/key", undefined, signal));
  }

  /**
   * GET /archives/key as the all-folders policy probe (4.4): one attempt
   * within POLICY_PROBE_TIMEOUT_MS, no backoff, and a 401 is not answered
   * with a bearer refresh. The caller counts anything but `ok` with
   * `policy.allFolders` as the policy off.
   */
  async probeKey(signal?: AbortSignal): Promise<KeyResult> {
    if (!this.configured) return { status: "disabled", code: "not_configured" };
    return this.keyResult(await this.getOnce("archives/key", signal));
  }

  private keyResult(result: ApiResult): KeyResult {
    if (result.kind === "ok") {
      const parsed = keySchema.safeParse(result.body);
      if (!parsed.success) return { status: "unavailable", reason: "invalid key response" };
      const publicKey = Buffer.from(parsed.data.public_key, "base64");
      if (publicKey.length !== 32 || publicKey.toString("base64") !== parsed.data.public_key || sealKid(publicKey) !== parsed.data.kid || parsed.data.alg !== SEAL_ALG) {
        return { status: "unavailable", reason: "invalid key response" };
      }
      return { status: "ok", key: { kid: parsed.data.kid, publicKey, alg: parsed.data.alg }, policy: parseArchivePolicy(result.body) };
    }
    if (result.kind === "error" && result.status === 404) return { status: "disabled", code: "archive_routes_missing" };
    const outcome = this.common(result);
    if (outcome?.status === "disabled") return { status: "disabled", code: outcome.code };
    if (result.kind === "error") return { status: "unavailable", reason: `status ${result.status}` };
    return { status: "unavailable", reason: result.kind === "unavailable" ? result.reason : result.kind };
  }

  /** Best-effort POST /archives/{id}/abort (7.7); one attempt, result ignored. */
  async abort(archiveId: string, signal?: AbortSignal): Promise<void> {
    try {
      const response = await this.send("POST", `archives/${archiveId}/abort`, {}, signal);
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // The server's stale-upload maintenance aborts it within a day.
    }
  }

  private async create(job: ArchiveUploadJob, signal?: AbortSignal): Promise<UploadOutcome | { uploaded: true } | { upload: ArchiveUploadState; urls: Map<number, string> }> {
    const result = await this.call("POST", "archives", job.request, signal);
    if (result.kind === "ok") {
      const parsed = createSchema.safeParse(result.body);
      if (!parsed.success || parsed.data.archive_id !== job.request.archive_id) return { status: "retry_later", reason: "invalid create response" };
      if (parsed.data.status === "uploaded") return { uploaded: true };
      const { upload_id: uploadId, object_key: objectKey, part_size: partSize, part_count: partCount } = parsed.data;
      if (!uploadId || !objectKey || !partSize || !partCount || partCount !== Math.ceil(job.request.size / partSize)) {
        return { status: "retry_later", reason: "invalid create response" };
      }
      const urls = new Map((parsed.data.parts ?? []).map((part) => [part.part_number, part.url]));
      return { upload: { upload_id: uploadId, object_key: objectKey, part_size: partSize, part_count: partCount, etags: {} }, urls };
    }
    const outcome = this.common(result);
    if (outcome) return outcome;
    if (result.kind !== "error") return { status: "retry_later", reason: "create failed" };
    if (result.status === 409 && result.code === "archive_kid_unknown") return { status: "rekey", code: result.code };
    if (result.status === 409 && result.code && CHAIN_ENDING_CODES.has(result.code)) return { status: "stop_session", code: result.code };
    return { status: "retry_later", reason: `create status ${result.status}` };
  }

  private async listParts(job: ArchiveUploadJob, partNumbers: number[], signal?: AbortSignal): Promise<UploadOutcome | "recreate" | PartsResult> {
    const result = await this.call("POST", `archives/${job.request.archive_id}/parts`, { part_numbers: partNumbers }, signal);
    if (result.kind === "ok") {
      const parsed = partsSchema.safeParse(result.body);
      if (!parsed.success) return { status: "retry_later", reason: "invalid parts response" };
      return { urls: new Map(parsed.data.parts.map((part) => [part.part_number, part.url])), uploaded: parsed.data.uploaded ?? [] };
    }
    const outcome = this.common(result);
    if (outcome) return outcome;
    if (result.kind === "error" && (result.status === 404 || (result.status === 409 && result.code === "archive_not_uploading"))) return "recreate";
    return { status: "retry_later", reason: result.kind === "error" ? `parts status ${result.status}` : "parts failed" };
  }

  private async complete(job: ArchiveUploadJob, upload: ArchiveUploadState, signal?: AbortSignal): Promise<UploadOutcome | "recreate" | "relist" | { reupload: string }> {
    const parts = Array.from({ length: upload.part_count }, (_, index) => ({ part_number: index + 1, etag: upload.etags[String(index + 1)] ?? "" }));
    const result = await this.call("POST", `archives/${job.request.archive_id}/complete`, { parts }, signal);
    if (result.kind === "ok") return { status: "uploaded" };
    const outcome = this.common(result);
    if (outcome) return outcome;
    if (result.kind === "error") {
      if (result.status === 404 || (result.status === 409 && result.code === "archive_not_uploading")) return "recreate";
      if (result.status === 409 && result.code === "archive_parts_invalid") return "relist";
      if (result.status === 409 && (result.code === "archive_size_mismatch" || result.code === "archive_seal_invalid")) return { reupload: result.code };
      return { status: "retry_later", reason: `complete status ${result.status}` };
    }
    return { status: "retry_later", reason: "complete failed" };
  }

  /** PUT one part to its presigned URL; an abort of `signal` cancels the request at once. */
  private async putPart(url: string, body: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<{ etag: string } | "forbidden" | "gone" | { failed: string }> {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) return { failed: "aborted" };
      let failure: string;
      try {
        const timeout = Math.max(PART_MIN_TIMEOUT_MS, Math.ceil(body.byteLength / PART_MIN_BYTES_PER_MS));
        const response = await this.options.fetch(url, { method: "PUT", body, signal: timeoutSignal(timeout, signal) });
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) {
          const etag = response.headers.get("etag");
          if (etag) return { etag };
          failure = "missing etag";
        } else if (response.status === 403) {
          return "forbidden";
        } else if (response.status === 404) {
          return "gone";
        } else if (!PART_RETRYABLE_STATUSES.has(response.status)) {
          return { failed: `part status ${response.status}` };
        } else {
          failure = `part status ${response.status}`;
        }
      } catch (error) {
        if (signal?.aborted) return { failed: "aborted" };
        failure = error instanceof Error ? error.name : "network error";
      }
      attempt += 1;
      if (attempt >= this.retry.attempts) return { failed: failure };
      await this.retry.sleep(backoffMs(this.retry, attempt), signal);
    }
  }

  /** PUTs every part S3 does not hold yet; "recreate" when the multipart upload is gone. */
  private async putMissingParts(
    job: ArchiveUploadJob,
    upload: ArchiveUploadState,
    file: FileHandle,
    initialUrls: Map<number, string>,
    persist: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<UploadOutcome | "recreate" | "done"> {
    const urls = new Map(initialUrls);
    const size = job.request.size;
    const partBytes = (part: number) => Math.min(upload.part_size, size - (part - 1) * upload.part_size);
    const missing = () => {
      const parts: number[] = [];
      for (let part = 1; part <= upload.part_count; part += 1) if (!upload.etags[String(part)]) parts.push(part);
      return parts;
    };
    let forbiddenInRow = 0;
    for (;;) {
      if (signal?.aborted) return { status: "aborted" };
      const todo = missing();
      const part = todo[0];
      if (part === undefined) return "done";
      const url = urls.get(part);
      if (!url) {
        const listed = await this.listParts(job, todo.slice(0, MAX_PARTS_PER_REQUEST), signal);
        if (listed === "recreate" || "status" in listed) return listed;
        let learned = false;
        for (const held of listed.uploaded) {
          if (held.part_number <= upload.part_count && held.size === partBytes(held.part_number) && upload.etags[String(held.part_number)] !== held.etag) {
            upload.etags[String(held.part_number)] = held.etag;
            learned = true;
          }
        }
        if (learned) await persist();
        for (const [number, partUrl] of listed.urls) urls.set(number, partUrl);
        if (!urls.has(part) && !upload.etags[String(part)]) return { status: "retry_later", reason: "no part url" };
        continue;
      }
      let body: Uint8Array<ArrayBuffer> | null;
      try {
        body = await readPart(file, (part - 1) * upload.part_size, partBytes(part), signal);
      } catch (error) {
        // The next drain checks the file again (a truncated one stops the session).
        return { status: "retry_later", reason: `archive file read failed: ${error instanceof Error ? error.message : "unknown"}` };
      }
      if (!body) return { status: "aborted" };
      const result = await this.putPart(url, body, signal);
      if (result === "forbidden") {
        // An expired URL, or expired signing credentials: fetch fresh URLs and retry.
        forbiddenInRow += 1;
        if (forbiddenInRow > 2) return { status: "retry_later", reason: "part forbidden" };
        urls.clear();
        continue;
      }
      if (result === "gone") {
        // NoSuchUpload: /parts answers archive_not_uploading, then the upload is re-created.
        urls.clear();
        const listed = await this.listParts(job, [part], signal);
        if (listed === "recreate" || "status" in listed) return listed;
        for (const [number, partUrl] of listed.urls) urls.set(number, partUrl);
        forbiddenInRow += 1;
        if (forbiddenInRow > 2) return { status: "retry_later", reason: "part not found" };
        continue;
      }
      if ("failed" in result) {
        if (signal?.aborted) return { status: "aborted" };
        this.log("warn", "OmniRush archive part upload failed", { archiveId: job.request.archive_id, part, reason: result.failed });
        return { status: "retry_later", reason: result.failed };
      }
      forbiddenInRow = 0;
      upload.etags[String(part)] = result.etag;
      urls.delete(part);
      await persist();
    }
  }

  /**
   * Uploads one sealed archive: create (or resume), PUT the parts S3 lacks,
   * complete. Never throws; the job's upload state is persisted after every
   * part so a restart resumes where it stopped.
   */
  async upload(job: ArchiveUploadJob, persist: () => Promise<void>, signal?: AbortSignal): Promise<UploadOutcome> {
    if (signal?.aborted) return { status: "aborted" };
    let file: FileHandle;
    try {
      file = await open(job.sealedPath, "r");
    } catch {
      return { status: "stop_session", code: "archive_file_missing" };
    }
    try {
      if ((await file.stat()).size !== job.request.size) return { status: "stop_session", code: "archive_file_corrupt" };
      return await this.uploadFrom(file, job, persist, signal);
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  private async uploadFrom(file: FileHandle, job: ArchiveUploadJob, persist: () => Promise<void>, signal?: AbortSignal): Promise<UploadOutcome> {
    for (let round = 0; round < MAX_UPLOAD_ROUNDS; round += 1) {
      if (signal?.aborted) return { status: "aborted" };
      let urls = new Map<number, string>();
      if (!job.upload) {
        const created = await this.create(job, signal);
        if ("status" in created) return created;
        if ("uploaded" in created) return { status: "uploaded" };
        job.upload = created.upload;
        urls = created.urls;
        await persist();
      }
      const upload = job.upload;
      const put = await this.putMissingParts(job, upload, file, urls, persist, signal);
      if (put === "recreate") {
        job.upload = null;
        await persist();
        continue;
      }
      if (put !== "done") return put;
      const completed = await this.complete(job, upload, signal);
      if (completed === "recreate") {
        job.upload = null;
        await persist();
        continue;
      }
      if (completed === "relist") {
        // Trust S3's own part list: /parts reports what it holds and the rest is sent again.
        upload.etags = {};
        await persist();
        continue;
      }
      if ("reupload" in completed) {
        if (job.recreates >= 1) return { status: "stop_session", code: completed.reupload };
        job.recreates += 1;
        job.upload = null;
        await persist();
        continue;
      }
      return completed;
    }
    return { status: "retry_later", reason: "upload rounds exhausted" };
  }
}
