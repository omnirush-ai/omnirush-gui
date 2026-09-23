/**
 * Test double for the omnirush.ai archive routes and S3 multipart uploads,
 * served through an injectable `fetch` (no sockets). It follows sections 7.2
 * to 7.7 closely enough for the client's behaviour to be checked: auth,
 * consent, replay and restart semantics, presigned URL expiry, NoSuchUpload,
 * part listing and completion checks. A delta's turn may repeat its parent's
 * (a final archive), as the backend accepts from 1.0.11 on; `strictTurns`
 * emulates the backend before that.
 */
import { createHash, randomUUID } from "node:crypto";

import { testKeys } from "./test-helpers.js";

type Part = { etag: string; bytes: Buffer };

export type FakeArchive = {
  request: Record<string, unknown> & { archive_id: string; session_id: string; sequence: number; turn: number; size: number; kind: string; parent_archive_id: string | null };
  status: "uploading" | "uploaded" | "aborted" | "failed";
  uploadId: string;
  partSize: number;
  partCount: number;
  /** Parts S3 holds for the current multipart upload; null once S3 forgot the upload (NoSuchUpload). */
  parts: Map<number, Part> | null;
  object: Buffer | null;
};

export type FakeCall = { method: string; path: string; status: number; body?: unknown };

type Hook = (call: { method: string; path: string; body: unknown }) => Response | "network" | undefined;
type PutHook = (put: { archiveId: string; partNumber: number; attempt: number }) => Response | "network" | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class FakeArchiveServer {
  readonly gatewayUrl = "https://api.omnirush.test/omnirush/v1";
  private readonly apiRoot = "https://api.omnirush.test/omnirush/";
  private readonly s3Root = "https://bucket.s3.test/";
  token = "token-1";
  partSize = 1024;
  /** When set, every route but abort answers with this (428 archive_consent_required, 503 archive_disabled). */
  gate: { status: number; detail: string } | null = null;
  /** A backend without final archives: a delta's turn must be greater than its parent's (409 archive_parent_mismatch otherwise). */
  strictTurns = false;
  readonly archives = new Map<string, FakeArchive>();
  readonly calls: FakeCall[] = [];
  readonly puts: Array<{ archiveId: string; partNumber: number; status: number }> = [];
  /** Presigned URLs issued before this counter are expired. */
  private urlGeneration = 0;
  private expiredBefore = 0;
  apiHook: Hook | null = null;
  putHook: PutHook | null = null;
  private readonly putAttempts = new Map<string, number>();

  /** The injectable fetch: routes API and S3 URLs to the fakes. */
  readonly respond = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (input.startsWith(this.s3Root)) return this.s3(input, init);
    if (!input.startsWith(this.apiRoot)) throw new TypeError(`unexpected URL in fake fetch: ${input}`);
    const path = input.slice(this.apiRoot.length);
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const body: unknown = bodyText ? JSON.parse(bodyText) : undefined;
    const hooked = this.apiHook?.({ method, path, body });
    if (hooked === "network") throw new TypeError("fetch failed");
    const response = hooked ?? this.api(method, path, body, new Headers(init?.headers).get("authorization"));
    this.calls.push({ method, path, status: response.status, body });
    return response;
  };

  /** Presigned URLs issued so far stop working (403), as after their hour or a role session expiry. */
  expireUrls(): void {
    this.expiredBefore = this.urlGeneration;
  }

  /** S3 forgets the multipart upload (maintenance abort, lifecycle rule): NoSuchUpload from now on. */
  forgetUpload(archiveId: string): void {
    const archive = this.archives.get(archiveId);
    if (archive) archive.parts = null;
  }

  callPaths(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path} ${call.status}`);
  }

  objects(): FakeArchive[] {
    return [...this.archives.values()].filter((archive) => archive.status === "uploaded").sort((left, right) => left.request.sequence - right.request.sequence);
  }

  private presign(archive: FakeArchive, partNumber: number): string {
    const generation = this.urlGeneration;
    this.urlGeneration += 1;
    return `${this.s3Root}v1/${archive.request.archive_id}.orseal?uploadId=${archive.uploadId}&partNumber=${partNumber}&X-Amz-Signature=${generation}`;
  }

  private urls(archive: FakeArchive, numbers: number[]) {
    return numbers.map((partNumber) => ({ part_number: partNumber, url: this.presign(archive, partNumber) }));
  }

  private startUpload(archive: FakeArchive): void {
    archive.uploadId = randomUUID();
    archive.parts = new Map();
    archive.status = "uploading";
    archive.object = null;
  }

  private createdBody(archive: FakeArchive) {
    return {
      archive_id: archive.request.archive_id,
      status: archive.status,
      upload_id: archive.uploadId,
      object_key: `v1/users/u/sessions/${archive.request.session_id}/archives/${String(archive.request.sequence).padStart(6, "0")}-${archive.request.kind}-${archive.request.archive_id}.orseal`,
      part_size: archive.partSize,
      part_count: archive.partCount,
      parts: this.urls(archive, Array.from({ length: Math.min(100, archive.partCount) }, (_, index) => index + 1)),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  private api(method: string, path: string, body: unknown, authorization: string | null): Response {
    if (authorization !== `Bearer ${this.token}`) return json(401, { detail: "invalid_token" });
    const abort = /^archives\/([^/]+)\/abort$/.exec(path);
    if (this.gate && !abort) return json(this.gate.status, { detail: this.gate.detail });
    if (method === "GET" && path === "archives/key") return json(200, { kid: testKeys.kid, public_key: testKeys.publicB64, alg: "X25519-HKDF-SHA256-A256GCM" });
    if (method === "POST" && path === "archives") return this.create(body);
    const parts = /^archives\/([^/]+)\/parts$/.exec(path);
    if (method === "POST" && parts) return this.listParts(parts[1]!, body);
    const complete = /^archives\/([^/]+)\/complete$/.exec(path);
    if (method === "POST" && complete) return this.complete(complete[1]!, body);
    if (method === "POST" && abort) {
      const archive = this.archives.get(abort[1]!);
      if (!archive) return json(404, { detail: "archive_not_found" });
      if (archive.status === "uploaded") return json(409, { detail: "archive_already_uploaded" });
      archive.status = "aborted";
      archive.parts = null;
      return json(200, { archive_id: abort[1], status: "aborted" });
    }
    return json(404, { detail: "not_found" });
  }

  private create(body: unknown): Response {
    if (typeof body !== "object" || body === null) return json(422, { detail: [] });
    const request = Object.fromEntries(Object.entries(body));
    const { archive_id: archiveId, session_id: sessionId, sequence, turn, size, kind, parent_archive_id: parentId, kid } = request;
    if (typeof archiveId !== "string" || typeof sessionId !== "string" || typeof sequence !== "number" || typeof turn !== "number"
      || typeof size !== "number" || size < 1 || (kind !== "base" && kind !== "delta") || (parentId !== null && typeof parentId !== "string")) {
      return json(422, { detail: [] });
    }
    if (kind === "base" && (sequence !== 0 || parentId !== null)) return json(422, { detail: [] });
    if (kid !== testKeys.kid) return json(409, { detail: "archive_kid_unknown" });
    const existing = this.archives.get(archiveId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) return json(409, { detail: "archive_id_conflict" });
      if (existing.status === "uploaded") return json(200, { archive_id: archiveId, status: "uploaded", parts: [] });
      if (existing.status === "aborted" || existing.status === "failed") {
        this.startUpload(existing);
        return json(201, this.createdBody(existing));
      }
      return json(200, this.createdBody(existing));
    }
    for (const archive of this.archives.values()) {
      if (archive.request.session_id === sessionId && archive.request.sequence === sequence) return json(409, { detail: "archive_sequence_conflict" });
    }
    if (kind === "delta") {
      const parent = parentId ? this.archives.get(parentId) : undefined;
      if (!parent || parent.status !== "uploaded" || parent.request.sequence !== sequence - 1 || parent.request.session_id !== sessionId
        || turn < parent.request.turn || (this.strictTurns && turn === parent.request.turn)) {
        return json(409, { detail: "archive_parent_mismatch" });
      }
    }
    const partSize = this.partSize;
    const archive: FakeArchive = {
      request: { ...request, archive_id: archiveId, session_id: sessionId, sequence, turn, size, kind, parent_archive_id: parentId },
      status: "uploading",
      uploadId: "",
      partSize,
      partCount: Math.ceil(size / partSize),
      parts: null,
      object: null,
    };
    this.startUpload(archive);
    this.archives.set(archiveId, archive);
    return json(201, this.createdBody(archive));
  }

  private listParts(archiveId: string, body: unknown): Response {
    const archive = this.archives.get(archiveId);
    if (!archive) return json(404, { detail: "archive_not_found" });
    if (archive.status !== "uploading" || !archive.parts) {
      if (archive.status === "uploading") archive.status = "aborted";
      return json(409, { detail: "archive_not_uploading" });
    }
    const numbers = typeof body === "object" && body !== null && "part_numbers" in body && Array.isArray(body.part_numbers) ? body.part_numbers.filter((value): value is number => typeof value === "number") : [];
    return json(200, {
      archive_id: archiveId,
      parts: this.urls(archive, numbers),
      uploaded: [...archive.parts.entries()].sort(([left], [right]) => left - right).map(([partNumber, part]) => ({ part_number: partNumber, etag: part.etag, size: part.bytes.length })),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  private complete(archiveId: string, body: unknown): Response {
    const archive = this.archives.get(archiveId);
    if (!archive) return json(404, { detail: "archive_not_found" });
    if (archive.status === "uploaded") return json(200, { archive_id: archiveId, status: "uploaded", size: archive.request.size });
    if (archive.status !== "uploading" || !archive.parts) {
      if (archive.status === "uploading") archive.status = "aborted";
      return json(409, { detail: "archive_not_uploading" });
    }
    const listed = typeof body === "object" && body !== null && "parts" in body && Array.isArray(body.parts) ? body.parts : [];
    if (listed.length !== archive.partCount) return json(422, { detail: [] });
    const pieces: Buffer[] = [];
    for (let partNumber = 1; partNumber <= archive.partCount; partNumber += 1) {
      const claimed = listed.find((item: unknown) => typeof item === "object" && item !== null && "part_number" in item && item.part_number === partNumber);
      const held = archive.parts.get(partNumber);
      if (!held || typeof claimed !== "object" || claimed === null || !("etag" in claimed) || claimed.etag !== held.etag) return json(409, { detail: "archive_parts_invalid" });
      pieces.push(held.bytes);
    }
    const object = Buffer.concat(pieces);
    if (object.length !== archive.request.size) {
      archive.status = "failed";
      return json(409, { detail: "archive_size_mismatch" });
    }
    archive.object = object;
    archive.status = "uploaded";
    return json(200, { archive_id: archiveId, status: "uploaded", size: object.length, completed_at: new Date().toISOString() });
  }

  private async s3(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    const archiveId = url.pathname.replace(/^\/v1\//, "").replace(/\.orseal$/, "");
    const partNumber = Number(url.searchParams.get("partNumber"));
    const key = `${archiveId}:${partNumber}`;
    const attempt = (this.putAttempts.get(key) ?? 0) + 1;
    this.putAttempts.set(key, attempt);
    const record = (status: number) => this.puts.push({ archiveId, partNumber, status });
    const hooked = this.putHook?.({ archiveId, partNumber, attempt });
    if (hooked === "network") {
      record(0);
      throw new TypeError("fetch failed");
    }
    if (hooked) {
      record(hooked.status);
      return hooked;
    }
    if (init?.method !== "PUT") return new Response("", { status: 405 });
    const archive = this.archives.get(archiveId);
    if (Number(url.searchParams.get("X-Amz-Signature")) < this.expiredBefore) {
      record(403);
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    if (!archive || !archive.parts || url.searchParams.get("uploadId") !== archive.uploadId) {
      record(404);
      return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
    }
    const bytes = Buffer.from(await new Response(init.body ?? null).arrayBuffer());
    const etag = `"${createHash("md5").update(bytes).digest("hex")}"`;
    archive.parts.set(partNumber, { etag, bytes });
    record(200);
    return new Response(null, { status: 200, headers: { ETag: etag } });
  }
}

/**
 * A slow link for part 2 of every upload: its PUT would take 30 s. Records
 * each such PUT (its body size, and how long after `markCommand()` its
 * signal aborted); part 1 and the API go straight to the fake server.
 */
export function slowPartTwo(server: FakeArchiveServer) {
  let started!: () => void;
  const state = {
    started: new Promise<void>((resolvePromise) => { started = resolvePromise; }),
    commandAt: 0,
    puts: [] as Array<{ part: number; bytes: number | null; abortedAfterMs: number | null; completed: boolean }>,
    markCommand: () => { state.commandAt = Date.now(); },
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const part = input.startsWith("https://bucket.s3.test/") ? Number(new URL(input).searchParams.get("partNumber")) : 0;
      if (part !== 2) return server.respond(input, init);
      const entry = { part, bytes: init?.body instanceof Uint8Array ? init.body.byteLength : null, abortedAfterMs: null as number | null, completed: false };
      state.puts.push(entry);
      started();
      return new Promise<Response>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          entry.completed = true;
          resolvePromise(server.respond(input, init));
        }, 30_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          entry.abortedAfterMs = Date.now() - state.commandAt;
          reject(init.signal!.reason);
        }, { once: true });
      });
    },
  };
  return state;
}
