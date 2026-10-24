import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";

export type NativeUploadRequest = (route: string, init: {method: "GET" | "POST"; body?: string; signal?: AbortSignal; refresh?: false}) => Promise<Response>;
export type NativeCaptureCapabilities = {
  schema: 1;
  native: {enabled: boolean; max_bytes: number};
  checkpoint: {enabled: boolean; max_bytes: number; retention_days: number | null};
};
export type NativeArchivePayload = "claude_native" | "claude_checkpoint";
export type NativeArchiveCreate = {
  archive_id: string; session_id: string; kind: "base"; sequence: number; turn: number;
  parent_archive_id: null; marker: "project"; payload: NativeArchivePayload; harness: "claude-code";
  engine_version: string; binding_id: string; contract_hash: string; manifest_sha256: string;
  content: "tar+zstd" | "zip"; size: number; sha256: string; kid: string;
  plain_size: number; plain_sha256: string; box_image?: string;
};
export type NativeArchiveJob = {
  request: NativeArchiveCreate; sealedPath: string;
  upload: {upload_id: string; object_key: string; part_size: number; part_count: number; etags: Record<string, string>} | null;
  recreates: number;
};
type ArchiveKeyResult =
  | {status: "ok"; key: {kid: string; publicKey: Buffer; alg: string}}
  | {status: "disabled"; code: string}
  | {status: "unavailable"; reason: string};
type ArchiveOutcome = {status: string; code?: string; reason?: string};
type Sealer = Transform & {kid: string; result(): {size: number; sha256: string}};
/** Each surface supplies its existing archive crypto, tar headers and multipart uploader. */
export type NativeArchiveDriver = {
  fetchKey(signal?: AbortSignal): Promise<ArchiveKeyResult>;
  upload(job: NativeArchiveJob, persist: () => Promise<void>, signal?: AbortSignal): Promise<ArchiveOutcome>;
  sealer(options: {publicKey: Uint8Array; content: "tar+zstd" | "zip"}): Sealer;
  tarHeader(member: {name: string; mode: number; size: number; mtime: number; typeflag: "0"}): Buffer;
};
export type NativeUploadOptions = {
  sessionId: string; owner: string; turn: number; bindingId: string; contractHash: string; engineVersion: string;
  nativeDirectory: string; stateDirectory: string;
  checkpointFile?: string; checkpointManifestSha256?: string; boxImage?: string;
  capabilities: NativeCaptureCapabilities; driver: NativeArchiveDriver; signal?: AbortSignal;
};
export type NativePayloadReceipt = {
  status: "uploaded" | "pending" | "disabled"; payload: NativeArchivePayload; retained: true;
  code?: string; archiveId?: string; sequence?: number; sha256?: string; bytes?: number;
  plainSha256?: string; plainBytes?: number; manifestSha256?: string;
};
export type NativeUploadReceipt = {
  status: "uploaded" | "partial" | "pending" | "disabled";
  native: NativePayloadReceipt; checkpoint: NativePayloadReceipt;
};
type Member = {name: string; file: string; bytes: number; sha256: string};
type SavedJob = {schema: 1; owner: string; fingerprint: string; state: "pending" | "uploaded"; job: NativeArchiveJob};
const MANIFEST = "__omnirush__/manifest.json";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hasCode = (error: unknown, code: string) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
class NativeArchiveFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

export function parseNativeCaptureCapabilities(value: unknown): NativeCaptureCapabilities | null {
  if (!record(value) || value.schema !== 1 || !record(value.native) || !record(value.checkpoint)) return null;
  const native = value.native, checkpoint = value.checkpoint;
  if (typeof native.enabled !== "boolean" || typeof checkpoint.enabled !== "boolean"
    || typeof native.max_bytes !== "number" || !Number.isSafeInteger(native.max_bytes) || native.max_bytes <= 0
    || typeof checkpoint.max_bytes !== "number" || !Number.isSafeInteger(checkpoint.max_bytes) || checkpoint.max_bytes <= 0
    || !(checkpoint.retention_days === null || typeof checkpoint.retention_days === "number" && Number.isSafeInteger(checkpoint.retention_days) && checkpoint.retention_days > 0)) return null;
  return {schema: 1, native: {enabled: native.enabled, max_bytes: native.max_bytes}, checkpoint: {enabled: checkpoint.enabled, max_bytes: checkpoint.max_bytes, retention_days: checkpoint.retention_days}};
}

async function fileHash(file: string, signal?: AbortSignal): Promise<{bytes: number; sha256: string}> {
  const digest = createHash("sha256"); let bytes = 0;
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(); if (!before.isFile()) throw new NativeArchiveFailure("archive_member_not_regular");
    for await (const chunk of handle.createReadStream({autoClose: false})) { signal?.throwIfAborted(); digest.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new NativeArchiveFailure("archive_source_changed");
    return {bytes, sha256: digest.digest("hex")};
  } finally { await handle.close(); }
}

async function members(directory: string, signal?: AbortSignal): Promise<Member[]> {
  const out: Member[] = [];
  const visit = async (dir: string): Promise<void> => {
    const stat = await fsp.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeArchiveFailure("archive_directory_invalid");
    const entries = await fsp.readdir(dir, {withFileTypes: true}); entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      signal?.throwIfAborted(); const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile()) throw new NativeArchiveFailure("archive_member_unsupported");
      out.push({name: path.relative(directory, file).split(path.sep).join("/"), file, ...await fileHash(file, signal)});
    }
  };
  await visit(directory); return out;
}

async function* exactBytes(member: Member, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const handle = await fsp.open(member.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const digest = createHash("sha256"); let bytes = 0;
  try {
    if (!(await handle.stat()).isFile()) throw new NativeArchiveFailure("archive_member_not_regular");
    for await (const chunk of handle.createReadStream({autoClose: false})) {
      signal?.throwIfAborted(); bytes += chunk.length; digest.update(chunk); yield chunk;
    }
    if (bytes !== member.bytes || digest.digest("hex") !== member.sha256) throw new NativeArchiveFailure("archive_source_changed");
  } finally { await handle.close(); }
}

async function* nativeTar(input: Member[], driver: NativeArchiveDriver, signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (const member of input) {
    signal?.throwIfAborted();
    yield driver.tarHeader({name: member.name, mode: 0o600, size: member.bytes, mtime: 0, typeflag: "0"});
    yield* exactBytes(member, signal);
    if (member.bytes % 512) yield Buffer.alloc(512 - member.bytes % 512);
  }
  yield Buffer.alloc(1024);
}

async function persist(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fsp.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, file);
  if (process.platform !== "win32") { const parent = await fsp.open(path.dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); } }
}

function receipt(saved: SavedJob, status: NativePayloadReceipt["status"], code?: string): NativePayloadReceipt {
  const request = saved.job.request;
  return {status, payload: request.payload, retained: true, ...(code ? {code} : {}), archiveId: request.archive_id,
    sequence: request.sequence, sha256: request.sha256, bytes: request.size, plainSha256: request.plain_sha256,
    plainBytes: request.plain_size, manifestSha256: request.manifest_sha256};
}

function validateManifest(bytes: Buffer, input: Member[], options: NativeUploadOptions): void {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new NativeArchiveFailure("archive_manifest_invalid"); }
  if (!record(value) || value.schema !== "omnirush.claude.native.v1" || value.session_id !== options.sessionId
    || value.root_session_id !== options.sessionId || value.binding_id !== options.bindingId || value.contract_hash !== options.contractHash
    || value.harness !== "claude-code" || value.engine_version !== options.engineVersion || value.payload !== "claude_native" || !Array.isArray(value.files)) throw new NativeArchiveFailure("archive_manifest_binding_mismatch");
  const actual = input.filter(member => member.name !== MANIFEST).map(member => ({path: member.name, size: member.bytes, sha256: member.sha256})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(value.files) !== JSON.stringify(actual)) throw new NativeArchiveFailure("archive_manifest_members_mismatch");
}

async function payload(options: NativeUploadOptions, kind: NativeArchivePayload): Promise<NativePayloadReceipt> {
  const gate = kind === "claude_native" ? options.capabilities.native : options.capabilities.checkpoint;
  const state = (status: NativePayloadReceipt["status"], code: string): NativePayloadReceipt => ({status, payload: kind, retained: true, code});
  if (!gate.enabled) return state("disabled", "archive_payload_disabled");
  if (options.signal?.aborted) return state("pending", "aborted");
  if (kind === "claude_checkpoint" && (!options.checkpointFile || !isHash(options.checkpointManifestSha256) || !options.boxImage)) return state("pending", "checkpoint_not_prepared");
  let input: Member[], manifestSha: string;
  if (kind === "claude_native") {
    input = await members(options.nativeDirectory, options.signal);
    const manifest = input.find(member => member.name === MANIFEST);
    if (!manifest) throw new NativeArchiveFailure("archive_manifest_missing");
    const bytes = await fsp.readFile(manifest.file);
    if (sha(bytes) !== manifest.sha256) throw new NativeArchiveFailure("archive_source_changed");
    validateManifest(bytes, input, options); manifestSha = manifest.sha256;
    input = [manifest, ...input.filter(member => member !== manifest)];
  } else {
    if (!options.checkpointFile || !options.checkpointManifestSha256) throw new Error("Checkpoint was not prepared");
    input = [{name: "session.zip", file: options.checkpointFile, ...await fileHash(options.checkpointFile, options.signal)}];
    manifestSha = options.checkpointManifestSha256;
    if (input[0]!.bytes > gate.max_bytes) return state("pending", "archive_too_large");
  }
  const fingerprint = sha(JSON.stringify({session: options.sessionId, owner: options.owner, kind, binding: options.bindingId,
    contract: options.contractHash, engine: options.engineVersion, turn: options.turn, manifestSha,
    image: kind === "claude_checkpoint" ? options.boxImage : null, files: input.map(({name, bytes, sha256}) => ({name, bytes, sha256}))}));
  const directory = path.join(options.stateDirectory, kind); await fsp.mkdir(directory, {recursive: true, mode: 0o700});
  const savedPath = path.join(directory, `${fingerprint}.json`);
  let saved: SavedJob | undefined;
  try {
    const value: SavedJob = JSON.parse(await fsp.readFile(savedPath, "utf8"));
    if (value.schema !== 1 || value.owner !== options.owner || value.fingerprint !== fingerprint || value.job?.request?.session_id !== options.sessionId || value.job?.request?.payload !== kind) throw new NativeArchiveFailure("archive_resume_identity_mismatch");
    saved = value;
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  if (!saved) {
    const key = await options.driver.fetchKey(options.signal);
    if (key.status !== "ok") return state(key.status === "disabled" ? "disabled" : "pending", key.status === "disabled" ? key.code : key.reason);
    let sequence = 0;
    for (const name of await fsp.readdir(directory)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const prior: SavedJob = JSON.parse(await fsp.readFile(path.join(directory, name), "utf8"));
      if (prior.owner !== options.owner || prior.job?.request?.session_id !== options.sessionId || prior.job?.request?.payload !== kind || !Number.isSafeInteger(prior.job.request.sequence)) throw new NativeArchiveFailure("archive_sequence_ledger_invalid");
      sequence = Math.max(sequence, prior.job.request.sequence + 1);
    }
    const archiveId = randomUUID(), sealedPath = path.join(directory, `${archiveId}.orseal`), temporary = `${sealedPath}.tmp`;
    const content = kind === "claude_native" ? "tar+zstd" : "zip";
    const sealer = options.driver.sealer({publicKey: key.key.publicKey, content});
    const plainHash = createHash("sha256"); let plainBytes = 0;
    const meter = new Transform({transform(chunk: Buffer, _encoding, callback) { plainBytes += chunk.length; plainHash.update(chunk); callback(null, chunk); }});
    const output = fs.createWriteStream(temporary, {flags: "wx", mode: 0o600});
    try {
      if (kind === "claude_native") {
        const compressor = createZstdCompress({params: {[zlibConstants.ZSTD_c_compressionLevel]: 3, [zlibConstants.ZSTD_c_checksumFlag]: 1}});
        await pipeline(Readable.from(nativeTar(input, options.driver, options.signal)), compressor, meter, sealer, output, {signal: options.signal});
      } else await pipeline(Readable.from(exactBytes(input[0]!, options.signal)), meter, sealer, output, {signal: options.signal});
      const handle = await fsp.open(temporary, "r"); try { await handle.sync(); } finally { await handle.close(); }
      await fsp.rename(temporary, sealedPath);
    } catch (error) { await fsp.rm(temporary, {force: true}); throw error; }
    const sealed = sealer.result();
    if (sealer.kid !== key.key.kid) throw new NativeArchiveFailure("archive_key_mismatch");
    saved = {schema: 1, owner: options.owner, fingerprint, state: "pending", job: {request: {
      archive_id: archiveId, session_id: options.sessionId, kind: "base", sequence, turn: options.turn, parent_archive_id: null,
      marker: "project", payload: kind, harness: "claude-code", engine_version: options.engineVersion, binding_id: options.bindingId,
      contract_hash: options.contractHash, manifest_sha256: manifestSha, content, size: sealed.size, sha256: sealed.sha256,
      kid: sealer.kid, plain_size: plainBytes, plain_sha256: plainHash.digest("hex"),
      ...(kind === "claude_checkpoint" ? {box_image: options.boxImage} : {}),
    }, sealedPath, upload: null, recreates: 0}};
    await persist(savedPath, saved);
  }
  if (saved.state === "uploaded") return receipt(saved, "uploaded");
  if (saved.job.request.size > gate.max_bytes) return receipt(saved, "pending", "archive_too_large");
  const actual = await fileHash(saved.job.sealedPath, options.signal);
  if (actual.bytes !== saved.job.request.size || actual.sha256 !== saved.job.request.sha256) return receipt(saved, "pending", "archive_file_corrupt");
  const job = saved;
  const outcome = await options.driver.upload(job.job, () => persist(savedPath, job), options.signal);
  if (outcome.status === "uploaded") { job.state = "uploaded"; await persist(savedPath, job); return receipt(job, "uploaded"); }
  return receipt(job, outcome.status === "disabled" || outcome.code === "archive_payload_disabled" ? "disabled" : "pending", outcome.code ?? outcome.reason ?? outcome.status);
}

/** Originals and sealed jobs remain local on every outcome, including caps and account gates. */
export async function uploadNativeBundle(options: NativeUploadOptions): Promise<NativeUploadReceipt> {
  if (!options.sessionId || !options.owner || !options.bindingId || !options.engineVersion || !isHash(options.contractHash)
    || !Number.isSafeInteger(options.turn) || options.turn < 0 || !parseNativeCaptureCapabilities(options.capabilities)) throw new Error("Invalid native archive binding or capabilities");
  await fsp.mkdir(options.stateDirectory, {recursive: true, mode: 0o700});
  const lockFile = path.join(options.stateDirectory, "upload.lock");
  let lock: Awaited<ReturnType<typeof fsp.open>>;
  try { lock = await fsp.open(lockFile, "wx", 0o600); }
  catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const pid = Number(await fsp.readFile(lockFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Archive upload lock needs recovery; evidence retained");
    try { process.kill(pid, 0); throw new Error("A native archive upload is already in progress"); }
    catch (probe) { if (!hasCode(probe, "ESRCH")) throw probe; }
    await fsp.unlink(lockFile); lock = await fsp.open(lockFile, "wx", 0o600);
  }
  try {
    await lock.writeFile(String(process.pid)); await lock.sync();
    const run = async (kind: NativeArchivePayload): Promise<NativePayloadReceipt> => {
      try { return await payload(options, kind); }
      catch (error) {
        const code = options.signal?.aborted ? "aborted" : error instanceof NativeArchiveFailure ? error.code
          : hasCode(error, "ENOENT") ? "archive_source_missing" : hasCode(error, "ENOSPC") ? "archive_storage_full"
          : hasCode(error, "EACCES") || hasCode(error, "EPERM") ? "archive_source_unreadable" : "archive_preparation_failed";
        return {status: "pending", payload: kind, retained: true, code};
      }
    };
    const native = await run("claude_native"), checkpoint = await run("claude_checkpoint");
    const states = [native.status, checkpoint.status];
    const status = states.every(value => value === "disabled") ? "disabled"
      : states.includes("pending") ? states.includes("uploaded") ? "partial" : "pending" : "uploaded";
    const result: NativeUploadReceipt = {status, native, checkpoint};
    const observation = {schema: 1, sessionId: options.sessionId, owner: options.owner, at: new Date().toISOString(), ...result};
    await persist(path.join(options.stateDirectory, "last-upload.json"), observation);
    const audit = await fsp.open(path.join(options.stateDirectory, "upload-events.jsonl"), "a", 0o600);
    try { await audit.writeFile(JSON.stringify(observation) + "\n"); await audit.sync(); } finally { await audit.close(); }
    return result;
  } finally { await lock.close(); await fsp.unlink(lockFile); }
}
