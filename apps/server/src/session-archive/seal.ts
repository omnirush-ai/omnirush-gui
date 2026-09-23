/**
 * ORSEAL01: seals a byte stream to the omnirush.ai archive key (X25519 +
 * HKDF-SHA256 + AES-256-GCM in authenticated frames). The format, the key id
 * and the decoder's error rules are normative in
 * docs/omnirush-project-archive.md section 6 of the backend repository; the
 * shared vectors are in __fixtures__/orseal_vectors.json.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type Hash,
  type KeyObject,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export const SEAL_MAGIC = Buffer.from("ORSEAL01", "ascii");
export const SEAL_ALG = "X25519-HKDF-SHA256-A256GCM";
export const SEAL_CONTENT = "tar+zstd";
/** The only chunk size production writers use. */
export const SEAL_CHUNK = 1 << 20;
export const SEAL_MIN_CHUNK = 16;
export const SEAL_MAX_CHUNK = 1 << 24;
export const SEAL_MAX_HEADER_LEN = 4096;
const TAG_LEN = 16;
const MAX_FRAMES = 2 ** 32;
const HKDF_INFO = Buffer.from("omnirush-seal-v1", "ascii");
const HEADER_KEYS = new Set(["alg", "chunk", "content", "epk", "kid", "salt", "v"]);
// DER wrappers that turn a raw 32-byte X25519 key into PKCS#8 / SPKI for Node's key objects.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export type SealErrorCode =
  | "bad_magic"
  | "bad_header"
  | "unsupported_version"
  | "unknown_kid"
  | "bad_frame_length"
  | "tag_mismatch"
  | "truncated"
  | "frame_after_final";

export class SealError extends Error {
  constructor(readonly code: SealErrorCode) {
    super(code);
    this.name = "SealError";
  }
}

function raw32(bytes: Uint8Array, what: string): Buffer {
  if (bytes.length !== 32) throw new TypeError(`${what} must be 32 bytes`);
  return Buffer.from(bytes);
}

export function x25519PrivateKey(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw32(raw, "X25519 private key")]), format: "der", type: "pkcs8" });
}

export function x25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw32(raw, "X25519 public key")]), format: "der", type: "spki" });
}

/** The raw 32-byte public key of an X25519 private or public key object. */
export function x25519PublicRaw(key: KeyObject): Buffer {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** kid: the first 16 lowercase hex characters of SHA-256(raw public key). */
export function sealKid(publicRaw: Uint8Array): string {
  return createHash("sha256").update(raw32(publicRaw, "X25519 public key")).digest("hex").slice(0, 16);
}

function deriveKey(shared: Buffer, salt: Buffer, epk: Buffer, serverPublic: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, salt, Buffer.concat([HKDF_INFO, epk, serverPublic]), 32));
}

function agree(privateKey: KeyObject, publicKey: KeyObject): Buffer | null {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    return null;
  }
  // A low-order point yields an all-zero secret; Node already throws on it,
  // the explicit check keeps that guarantee independent of the runtime.
  return shared.every((byte) => byte === 0) ? null : shared;
}

function frameNonce(index: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

function frameAad(headerHash: Buffer, index: number, final: boolean): Buffer {
  const aad = Buffer.alloc(41);
  headerHash.copy(aad, 0);
  aad.writeBigUInt64BE(BigInt(index), 32);
  aad[40] = final ? 1 : 0;
  return aad;
}

/** One frame as pieces (length prefix, ciphertext, tag): no second copy of the ciphertext is made. */
function encryptFrame(key: Buffer, headerHash: Buffer, index: number, final: boolean, plaintext: Buffer): Buffer[] {
  const cipher = createCipheriv("aes-256-gcm", key, frameNonce(index));
  cipher.setAAD(frameAad(headerHash, index, final));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(plaintext.length + TAG_LEN, 0);
  const body = cipher.update(plaintext);
  const tail = cipher.final();
  const pieces = [length, body];
  if (tail.length > 0) pieces.push(tail);
  pieces.push(cipher.getAuthTag());
  return pieces;
}

function decryptFrame(key: Buffer, headerHash: Buffer, index: number, final: boolean, frame: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, frameNonce(index));
    decipher.setAAD(frameAad(headerHash, index, final));
    decipher.setAuthTag(frame.subarray(frame.length - TAG_LEN));
    const head = decipher.update(frame.subarray(0, frame.length - TAG_LEN));
    const tail = decipher.final();
    return tail.length === 0 ? head : Buffer.concat([head, tail]);
  } catch {
    return null;
  }
}

export type SealOptions = {
  /** The recipient's raw 32-byte X25519 public key (GET /omnirush/archives/key). */
  publicKey: Uint8Array;
  /** Plaintext bytes per frame. Production MUST leave the default (1 MiB); the vectors use 16. */
  chunk?: number;
  /**
   * TEST VECTORS ONLY. Fixes the ephemeral private key and the salt so a seal
   * reproduces orseal_vectors.json byte for byte. Production code never sets
   * it: every archive gets a fresh ephemeral key and salt from the CSPRNG.
   */
  testOnlyFixedSecrets?: { ephemeralPrivateKey: Uint8Array; salt: Uint8Array };
};

export type SealResult = { size: number; sha256: string };

/**
 * The ORSEAL01 framing core, shared by SealStream and sealBuffer. It holds at
 * most one chunk of plaintext: a full chunk becomes a non-final frame only
 * once more input arrives, and whatever is held at the end (possibly a full
 * chunk, or nothing) becomes the final frame. It counts and hashes its own
 * output, which the create request needs.
 */
class FrameSealer {
  readonly kid: string;
  private readonly key: Buffer;
  private readonly headerHash: Buffer;
  private readonly prefix: Buffer;
  private readonly chunk: number;
  private readonly pending: Buffer;
  private pendingLength = 0;
  private index = 0;
  private started = false;
  private readonly outputHash: Hash = createHash("sha256");
  private outputBytes = 0;
  private sealed: SealResult | null = null;

  constructor(options: SealOptions) {
    const chunk = options.chunk ?? SEAL_CHUNK;
    if (!Number.isInteger(chunk) || chunk < SEAL_MIN_CHUNK || chunk > SEAL_MAX_CHUNK) throw new RangeError("invalid seal chunk size");
    const serverPublicRaw = raw32(options.publicKey, "X25519 public key");
    const ephemeral = options.testOnlyFixedSecrets
      ? x25519PrivateKey(options.testOnlyFixedSecrets.ephemeralPrivateKey)
      : generateKeyPairSync("x25519").privateKey;
    const salt = options.testOnlyFixedSecrets ? raw32(options.testOnlyFixedSecrets.salt, "salt") : randomBytes(32);
    const epk = x25519PublicRaw(ephemeral);
    const shared = agree(ephemeral, x25519PublicKey(serverPublicRaw));
    if (!shared) throw new RangeError("the archive public key is not a valid X25519 point");
    this.kid = sealKid(serverPublicRaw);
    this.chunk = chunk;
    this.key = deriveKey(shared, salt, epk, serverPublicRaw);
    // Key order alg, chunk, content, epk, kid, salt, v: sorted, as the format requires.
    const header = Buffer.from(JSON.stringify({
      alg: SEAL_ALG,
      chunk,
      content: SEAL_CONTENT,
      epk: epk.toString("base64"),
      kid: this.kid,
      salt: salt.toString("base64"),
      v: 1,
    }), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length, 0);
    this.prefix = Buffer.concat([SEAL_MAGIC, length, header]);
    this.headerHash = createHash("sha256").update(this.prefix).digest();
    this.pending = Buffer.allocUnsafe(chunk);
  }

  get result(): SealResult | null {
    return this.sealed;
  }

  private emit(bytes: Buffer, out: (bytes: Buffer) => void): void {
    this.outputHash.update(bytes);
    this.outputBytes += bytes.length;
    out(bytes);
  }

  private start(out: (bytes: Buffer) => void): void {
    if (this.started) return;
    this.started = true;
    this.emit(this.prefix, out);
  }

  private frame(final: boolean, out: (bytes: Buffer) => void): void {
    if (this.index >= MAX_FRAMES) throw new RangeError("too many seal frames");
    for (const piece of encryptFrame(this.key, this.headerHash, this.index, final, this.pending.subarray(0, this.pendingLength))) this.emit(piece, out);
    this.index += 1;
    this.pendingLength = 0;
  }

  update(bytes: Buffer, out: (bytes: Buffer) => void): void {
    if (this.sealed) throw new Error("the seal is already finished");
    this.start(out);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.pendingLength === this.chunk) this.frame(false, out);
      const take = Math.min(bytes.length - offset, this.chunk - this.pendingLength);
      bytes.copy(this.pending, this.pendingLength, offset, offset + take);
      this.pendingLength += take;
      offset += take;
    }
  }

  finish(out: (bytes: Buffer) => void): SealResult {
    if (this.sealed) throw new Error("the seal is already finished");
    this.start(out);
    this.frame(true, out);
    this.sealed = { size: this.outputBytes, sha256: this.outputHash.digest("hex") };
    return this.sealed;
  }
}

/** Streaming ORSEAL01 sealer (section 6.6); memory is one chunk plus stream buffers. */
export class SealStream extends Transform {
  private readonly sealer: FrameSealer;

  constructor(options: SealOptions) {
    super();
    this.sealer = new FrameSealer(options);
  }

  get kid(): string {
    return this.sealer.kid;
  }

  /** Ciphertext size and SHA-256; available once the stream has finished. */
  result(): SealResult {
    const result = this.sealer.result;
    if (!result) throw new Error("the seal stream has not finished");
    return result;
  }

  override _transform(data: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.sealer.update(typeof data === "string" ? Buffer.from(data, encoding) : data, (bytes) => this.push(bytes));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.sealer.finish((bytes) => this.push(bytes));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Seals a buffer in one call (tests and small payloads). */
export function sealBuffer(plaintext: Uint8Array, options: SealOptions): { sealed: Buffer; kid: string } & SealResult {
  const sealer = new FrameSealer(options);
  const out: Buffer[] = [];
  const push = (bytes: Buffer) => out.push(bytes);
  sealer.update(Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength), push);
  const result = sealer.finish(push);
  return { sealed: Buffer.concat(out), kid: sealer.kid, ...result };
}

// --- opening -------------------------------------------------------------------

export type SealKey = { kid: string; privateKey: KeyObject; publicRaw: Buffer };
/** kid -> key, every configured private key (current first). */
export type SealKeyring = Map<string, SealKey>;

export function sealKeyring(privateKeys: readonly Uint8Array[]): SealKeyring {
  const keyring: SealKeyring = new Map();
  for (const raw of privateKeys) {
    const privateKey = x25519PrivateKey(raw);
    const publicRaw = x25519PublicRaw(privateKey);
    const kid = sealKid(publicRaw);
    if (!keyring.has(kid)) keyring.set(kid, { kid, privateKey, publicRaw });
  }
  return keyring;
}

/** Exact reads plus a one-byte look-ahead over an async byte source. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered: Buffer[] = [];
  private length = 0;
  private done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(wanted: number): Promise<void> {
    while (this.length < wanted && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      if (next.value.length === 0) continue;
      const piece = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      this.buffered.push(piece);
      this.length += piece.length;
    }
  }

  /** Up to `count` bytes; fewer only at the end of the source. */
  async read(count: number): Promise<Buffer> {
    await this.fill(count);
    const take = Math.min(count, this.length);
    const joined = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered, this.length);
    const out = Buffer.from(joined.subarray(0, take));
    const rest = joined.subarray(take);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  async more(): Promise<boolean> {
    await this.fill(1);
    return this.length > 0;
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

function canonicalBase64Of32(value: unknown): Buffer {
  if (typeof value !== "string" || !B64_32.test(value)) throw new SealError("bad_header");
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== value) throw new SealError("bad_header");
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OpenedHeader = { chunk: number; key: Buffer; headerHash: Buffer; kid: string };

async function openHeader(reader: ByteReader, keyring: SealKeyring): Promise<OpenedHeader> {
  const magic = await reader.read(8);
  if (!magic.equals(SEAL_MAGIC)) throw new SealError("bad_magic");
  const rawLength = await reader.read(4);
  if (rawLength.length < 4) throw new SealError("truncated");
  const length = rawLength.readUInt32BE(0);
  if (length === 0 || length > SEAL_MAX_HEADER_LEN) throw new SealError("bad_header");
  const head = await reader.read(length);
  if (head.length < length) throw new SealError("truncated");
  let header: unknown;
  try {
    header = JSON.parse(UTF8.decode(head));
  } catch {
    throw new SealError("bad_header");
  }
  if (!isRecord(header)) throw new SealError("bad_header");
  const version = header.v;
  if (typeof version !== "number" || !Number.isInteger(version)) throw new SealError("bad_header");
  if (version !== 1) throw new SealError("unsupported_version");
  const keys = Object.keys(header);
  const { chunk, kid } = header;
  if (
    keys.length !== HEADER_KEYS.size
    || !keys.every((key) => HEADER_KEYS.has(key))
    || header.alg !== SEAL_ALG
    || header.content !== SEAL_CONTENT
    || typeof chunk !== "number"
    || !Number.isInteger(chunk)
    || chunk < SEAL_MIN_CHUNK
    || chunk > SEAL_MAX_CHUNK
    || typeof kid !== "string"
    || !/^[0-9a-f]{16}$/.test(kid)
  ) {
    throw new SealError("bad_header");
  }
  const epk = canonicalBase64Of32(header.epk);
  const salt = canonicalBase64Of32(header.salt);
  const recipient = keyring.get(kid);
  if (!recipient) throw new SealError("unknown_kid");
  let ephemeralPublic: KeyObject;
  try {
    ephemeralPublic = x25519PublicKey(epk);
  } catch {
    throw new SealError("bad_header");
  }
  const shared = agree(recipient.privateKey, ephemeralPublic);
  if (!shared) throw new SealError("bad_header");
  return {
    chunk,
    kid,
    key: deriveKey(shared, salt, epk, recipient.publicRaw),
    headerHash: createHash("sha256").update(Buffer.concat([magic, rawLength, head])).digest(),
  };
}

/**
 * Opens an ORSEAL01 stream frame by frame (section 6.7). The plaintext is
 * authentic only once the generator returns without throwing: a failing
 * stream can yield a verified prefix first, and a caller must discard
 * everything it received when a SealError is thrown.
 */
export async function* openSealed(source: AsyncIterable<Uint8Array>, keyring: SealKeyring): AsyncGenerator<Buffer, { kid: string }> {
  const reader = new ByteReader(source);
  try {
    const { chunk, key, headerHash, kid } = await openHeader(reader, keyring);
    for (let index = 0; ; index += 1) {
      const rawLength = await reader.read(4);
      if (rawLength.length < 4) throw new SealError("truncated");
      const length = rawLength.readUInt32BE(0);
      if (length < TAG_LEN || length > chunk + TAG_LEN) throw new SealError("bad_frame_length");
      const frame = await reader.read(length);
      if (frame.length < length) throw new SealError("truncated");
      const more = await reader.more();
      const full = length === chunk + TAG_LEN;
      const final = !full || !more;
      const plaintext = decryptFrame(key, headerHash, index, final, frame);
      if (!plaintext) {
        if (full && decryptFrame(key, headerHash, index, !final, frame)) {
          throw new SealError(final ? "truncated" : "frame_after_final");
        }
        throw new SealError("tag_mismatch");
      }
      yield plaintext;
      if (final) {
        if (more) throw new SealError("frame_after_final");
        return { kid };
      }
    }
  } finally {
    await reader.close();
  }
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Opens a whole sealed buffer; throws SealError on any failure. */
export async function openSealedBuffer(sealed: Uint8Array, keyring: SealKeyring): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of openSealed(once(sealed), keyring)) pieces.push(piece);
  return Buffer.concat(pieces);
}
