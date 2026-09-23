/**
 * Pass 2 of a capture (sections 5.5, 5.9, 5.10, 13.1): a streaming POSIX pax
 * tar writer, and the pipeline file -> tar -> zstd -> ORSEAL01 -> temp file.
 * Memory is bounded by a few output blocks and stream buffers whatever the
 * project size.
 */
import { createHash } from "node:crypto";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { PassThrough, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";

import {
  OPEN_ENTRY_FLAGS,
  compareArchivePaths,
  isSameFileIdentity,
  statKeyPrefix,
  type ManifestSource,
  type ScannedEntry,
} from "./manifest.js";
import { hintGarbageCollection } from "./files.js";
import { SealStream, type SealOptions } from "./seal.js";

export const MANIFEST_MEMBER = "__omnirush__/manifest.json";
export const UNSTABLE_MEMBER = "__omnirush__/unstable.json";
export const UNSTABLE_SCHEMA = "omnirush.archive.unstable.v1";
const TAR_BLOCK = 512;
/** Tar output is assembled in blocks of this size; file content is read straight into them. */
const OUTPUT_BLOCK = 1 << 20;
const MAX_OCTAL_11 = 8 ** 11 - 1;
const PAX_HEADER_NAME = Buffer.from("././@PaxHeader", "ascii");
const ZSTD_LEVEL = 3;
/** Output blocks (64 MiB), or members, between two garbage collection hints. */
const GC_HINT_BLOCKS = 64;
const GC_HINT_MEMBERS = 10_000;

type Typeflag = "0" | "2" | "5" | "x";

function isAscii(bytes: Buffer): boolean {
  for (const byte of bytes) if (byte >= 0x80) return false;
  return true;
}

/** The ustar fallback when a pax record carries the real value: non-ASCII bytes become `_`, cut to 100 bytes. */
function asciiFallback(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes.subarray(0, 100));
  for (let index = 0; index < out.length; index += 1) if (out[index]! >= 0x80) out[index] = 0x5f;
  return out;
}

function writeOctal(block: Buffer, offset: number, width: number, value: number): void {
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length > width - 1) throw new RangeError("tar numeric field overflow");
  block.write(digits, offset, width - 1, "ascii");
  block[offset + width - 1] = 0;
}

function clampMtime(seconds: number): number {
  return Math.min(Math.max(Math.floor(seconds), 0), MAX_OCTAL_11);
}

function ustarHeader(name: Buffer, mode: number, size: number, mtime: number, typeflag: Typeflag, linkname: Buffer | null): Buffer {
  const block = Buffer.alloc(TAR_BLOCK);
  name.copy(block, 0, 0, 100);
  writeOctal(block, 100, 8, mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime);
  block.fill(0x20, 148, 156);
  block.write(typeflag, 156, 1, "ascii");
  linkname?.copy(block, 157, 0, 100);
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

/** One `"<len> <key>=<value>\n"` record; `len` counts the whole record, its own digits included. */
function paxRecord(key: string, value: string): string {
  const rest = Buffer.byteLength(` ${key}=${value}\n`, "utf8");
  let digits = 1;
  while (String(rest + digits).length !== digits) digits += 1;
  return `${rest + digits} ${key}=${value}\n`;
}

function paddingFor(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}

export type TarMember = { name: string; mode: number; size: number; mtime: number; typeflag: "0" | "2" | "5"; linkname?: string };

/** The header blocks of one member: a pax `x` header first when the path, target or size needs one. */
export function tarMemberHeader(member: TarMember): Buffer {
  const mtime = clampMtime(member.mtime);
  const records: string[] = [];
  let name: Buffer = Buffer.from(member.name, "utf8");
  if (name.length > 100 || !isAscii(name)) {
    records.push(paxRecord("path", member.name));
    name = asciiFallback(name);
  }
  let linkname: Buffer | null = null;
  if (member.linkname !== undefined) {
    linkname = Buffer.from(member.linkname, "utf8");
    if (linkname.length > 100 || !isAscii(linkname)) {
      records.push(paxRecord("linkpath", member.linkname));
      linkname = asciiFallback(linkname);
    }
  }
  let size = member.size;
  if (size > MAX_OCTAL_11) {
    records.push(paxRecord("size", String(size)));
    size = 0;
  }
  const header = ustarHeader(name, member.mode, size, mtime, member.typeflag, linkname);
  if (records.length === 0) return header;
  const body = Buffer.from(records.join(""), "utf8");
  return Buffer.concat([
    ustarHeader(PAX_HEADER_NAME, 0o644, body.length, mtime, "x", null),
    body,
    Buffer.alloc(paddingFor(body.length)),
    header,
  ]);
}

export type PackInput = {
  root: string;
  /** `__omnirush__/manifest.json`: its bytes, or a source that serialises it while it is written. */
  manifest: Buffer | ManifestSource;
  /** created_at in seconds: the mtime of the manifest and unstable members. */
  createdAtSeconds: number;
  /** Exactly the manifest's `files`, in the same order. */
  entries: readonly ScannedEntry[];
  /** Stops the writer between members and output blocks: it then rejects with the signal's reason. */
  signal?: AbortSignal;
};

export type PackOutcome = { unstable: string[]; tarBytes: number };

export type TarPack = { stream: Readable; outcome: () => PackOutcome };

/** Takes a filled output block and resolves with the next (empty) one to fill. */
type EmitBlock = (block: Buffer) => Promise<Buffer>;

/**
 * Writes the tar stream of an archive into output blocks: the manifest, the
 * entries streamed from disk, then `__omnirush__/unstable.json` when an entry
 * changed after pass 1. File content is read straight into the blocks. Only
 * a full block waits on the consumer; the members themselves are plain async
 * calls (async generators, one chain per member, cost several times the
 * memory on a 200k-member tree).
 */
class TarWriter {
  private readonly unstable: string[] = [];
  private tarBytes = 0;
  private finished = false;
  private block: Buffer;
  private used = 0;
  private rotations = 0;
  /** The directories above the last entry read, from the root down, and whether each was a real directory. */
  private readonly parents: Array<{ name: string; real: boolean }> = [];

  constructor(private readonly input: PackInput, first: Buffer, private readonly emit: EmitBlock) {
    this.block = first;
  }

  outcome(): PackOutcome {
    if (!this.finished) throw new Error("the tar stream has not finished");
    return { unstable: [...this.unstable], tarBytes: this.tarBytes };
  }

  private async rotate(): Promise<void> {
    this.input.signal?.throwIfAborted();
    this.tarBytes += this.used;
    this.block = await this.emit(this.block);
    this.used = 0;
    this.rotations += 1;
    if (this.rotations % GC_HINT_BLOCKS === 0) hintGarbageCollection();
  }

  private async put(bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.used === OUTPUT_BLOCK) await this.rotate();
      const take = Math.min(bytes.length - offset, OUTPUT_BLOCK - this.used);
      bytes.copy(this.block, this.used, offset, offset + take);
      this.used += take;
      offset += take;
    }
  }

  private async zeros(count: number): Promise<void> {
    let left = count;
    while (left > 0) {
      if (this.used === OUTPUT_BLOCK) await this.rotate();
      const take = Math.min(left, OUTPUT_BLOCK - this.used);
      this.block.fill(0, this.used, this.used + take);
      this.used += take;
      left -= take;
    }
  }

  private async smallFile(name: string, content: Buffer | ManifestSource): Promise<void> {
    const source = Buffer.isBuffer(content) ? { size: content.length, chunks: () => [content] } : content;
    await this.put(tarMemberHeader({ name, mode: 0o644, size: source.size, mtime: this.input.createdAtSeconds, typeflag: "0" }));
    let written = 0;
    for (const piece of source.chunks()) {
      written += piece.length;
      if (written > source.size) break;
      await this.put(piece);
    }
    if (written !== source.size) throw new Error(`${name} changed while it was written`);
    await this.zeros(paddingFor(source.size));
  }

  /**
   * Whether every directory above `parts` (a root-relative path, split) is
   * still a real directory and not a symlink, so that opening the path cannot
   * leave the root. Each directory is lstat'ed once, parents first, when the
   * walk enters it, and the result holds for its subtree (contiguous in byte
   * order). A swap after that is caught per file by fileContent()'s identity
   * check.
   */
  private async parentsInRoot(parts: readonly string[]): Promise<boolean> {
    const { parents } = this;
    const depth = parts.length - 1;
    let kept = 0;
    while (kept < parents.length && kept < depth && parents[kept]!.name === parts[kept]) kept += 1;
    parents.length = kept;
    for (let index = kept; index < depth; index += 1) {
      let real = index === 0 || parents[index - 1]!.real;
      if (real) {
        try {
          real = (await lstat(join(this.input.root, ...parts.slice(0, index + 1)))).isDirectory();
        } catch {
          real = false;
        }
      }
      parents.push({ name: parts[index]!, real });
    }
    return depth === 0 || parents[depth - 1]!.real;
  }

  /**
   * Streams exactly entry.size bytes (truncated or NUL-padded); false when the
   * file is not what pass 1 saw. Bytes are copied only from the regular file
   * pass 1 lstat'ed (same st_dev and st_ino) under real directories; anything
   * else (a file replaced, reached through a directory swapped for a symlink,
   * a FIFO) is zero-filled.
   */
  private async fileContent(entry: ScannedEntry, absolute: string, parentsInRoot: boolean): Promise<boolean> {
    let stable = false;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    if (parentsInRoot) {
      try {
        handle = await open(absolute, OPEN_ENTRY_FLAGS);
        const stats = await handle.stat({ bigint: true });
        if (stats.isFile() && isSameFileIdentity(entry, stats)) {
          stable = stats.size === BigInt(entry.size) && entry.statKey.startsWith(statKeyPrefix(stats.size, stats.mtimeNs));
        } else {
          await handle.close();
          handle = null;
        }
      } catch {
        await handle?.close().catch(() => undefined);
        handle = null;
      }
    }
    const hash = createHash("sha256");
    let remaining = entry.size;
    try {
      while (handle && remaining > 0) {
        if (this.used === OUTPUT_BLOCK) await this.rotate();
        const want = Math.min(remaining, OUTPUT_BLOCK - this.used);
        let bytesRead = 0;
        try {
          ({ bytesRead } = await handle.read(this.block, this.used, want, null));
        } catch {
          stable = false;
        }
        if (bytesRead === 0) break;
        hash.update(this.block.subarray(this.used, this.used + bytesRead));
        this.used += bytesRead;
        remaining -= bytesRead;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (remaining > 0) {
      stable = false;
      await this.zeros(remaining);
    } else if (hash.digest("hex") !== entry.sha256) {
      stable = false;
    }
    return stable;
  }

  /** Writes the whole archive; the last, partial block is emitted too. */
  async write(): Promise<void> {
    const { input, unstable } = this;
    await this.smallFile(MANIFEST_MEMBER, input.manifest);
    let members = 0;
    for (const entry of input.entries) {
      input.signal?.throwIfAborted();
      members += 1;
      if (members % GC_HINT_MEMBERS === 0) hintGarbageCollection();
      if (entry.type === "dir") {
        await this.put(tarMemberHeader({ name: `${entry.path}/`, mode: entry.mode, size: 0, mtime: entry.mtime, typeflag: "5" }));
        continue;
      }
      const parts = entry.path.split("/");
      const absolute = join(input.root, ...parts);
      const parentsInRoot = await this.parentsInRoot(parts);
      if (entry.type === "symlink") {
        const target = entry.target ?? "";
        await this.put(tarMemberHeader({ name: entry.path, mode: entry.mode, size: 0, mtime: entry.mtime, typeflag: "2", linkname: target }));
        try {
          const stats = parentsInRoot ? await lstat(absolute) : null;
          if (!stats?.isSymbolicLink() || (await readlink(absolute)) !== target) unstable.push(entry.path);
        } catch {
          unstable.push(entry.path);
        }
        continue;
      }
      await this.put(tarMemberHeader({ name: entry.path, mode: entry.mode, size: entry.size, mtime: entry.mtime, typeflag: "0" }));
      const stable = await this.fileContent(entry, absolute, parentsInRoot);
      await this.zeros(paddingFor(entry.size));
      if (!stable) unstable.push(entry.path);
    }
    if (unstable.length > 0) {
      unstable.sort(compareArchivePaths);
      await this.smallFile(UNSTABLE_MEMBER, Buffer.from(JSON.stringify({ schema: UNSTABLE_SCHEMA, paths: unstable }), "utf8"));
    }
    await this.zeros(2 * TAR_BLOCK);
    if (this.used > 0) {
      this.tarBytes += this.used;
      await this.emit(this.block.subarray(0, this.used));
      this.used = 0;
    }
    this.finished = true;
  }
}

/** The tar stream of an archive as a Readable (fresh blocks: safe for any consumer). */
export function packArchiveTar(input: PackInput): TarPack {
  const stream = new PassThrough({ highWaterMark: OUTPUT_BLOCK });
  const writer = new TarWriter(input, Buffer.allocUnsafe(OUTPUT_BLOCK), async (block) => {
    if (!stream.write(block)) await once(stream, "drain");
    return Buffer.allocUnsafe(OUTPUT_BLOCK);
  });
  writer.write().then(() => stream.end(), (error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
  return { stream, outcome: () => writer.outcome() };
}

/**
 * A few output blocks recycled between the tar writer and the compressor: a
 * block returns to the pool once the compressor's write callback says it has
 * consumed it, so pass 2 allocates the same few MiB whatever the archive size.
 */
class BlockPool {
  private readonly free: Buffer[] = [];
  private readonly waiters: Array<(block: Buffer) => void> = [];
  private readonly owned = new Map<ArrayBufferLike, Buffer>();

  constructor(private readonly capacity: number) {}

  acquire(): Promise<Buffer> {
    const block = this.free.pop();
    if (block) return Promise.resolve(block);
    if (this.owned.size < this.capacity) {
      const fresh = Buffer.allocUnsafeSlow(OUTPUT_BLOCK);
      this.owned.set(fresh.buffer, fresh);
      return Promise.resolve(fresh);
    }
    return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
  }

  /** Takes back the block a (possibly partial) view belongs to. */
  release(view: Buffer): void {
    const block = this.owned.get(view.buffer);
    if (!block) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(block);
    else this.free.push(block);
  }

  /** After a failure: nobody may wait forever for a block. */
  unblock(): void {
    for (const waiter of this.waiters.splice(0)) waiter(Buffer.allocUnsafe(OUTPUT_BLOCK));
  }
}

const POOL_BLOCKS = 4;

type FileHandle = Awaited<ReturnType<typeof open>>;

/** The last stage: writes each chunk to the file and waits for it, then fsyncs. */
class FileSink extends Writable {
  constructor(private readonly handle: FileHandle) {
    super({ highWaterMark: OUTPUT_BLOCK });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writeAll([chunk]).then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  override _writev(chunks: Array<{ chunk: Buffer }>, callback: (error?: Error | null) => void): void {
    this.writeAll(chunks.map((item) => item.chunk)).then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  private async writeAll(buffers: Buffer[]): Promise<void> {
    let pending = buffers.filter((buffer) => buffer.length > 0);
    while (pending.length > 0) {
      let { bytesWritten } = await this.handle.writev(pending);
      while (pending.length > 0 && bytesWritten >= pending[0]!.length) {
        bytesWritten -= pending[0]!.length;
        pending = pending.slice(1);
      }
      if (pending.length > 0 && bytesWritten > 0) pending = [pending[0]!.subarray(bytesWritten), ...pending.slice(1)];
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.handle.sync().then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }
}

export type SealedArchive = PackOutcome & { size: number; sha256: string; kid: string };

/**
 * file -> tar -> zstd (level 3, checksum, one frame) -> ORSEAL01 -> `outputPath`,
 * then fsync. The output file must not exist yet.
 */
export async function writeSealedArchive(input: PackInput, seal: SealOptions, outputPath: string): Promise<SealedArchive> {
  const sealer = new SealStream(seal);
  const compressor = createZstdCompress({
    chunkSize: 256 * 1024,
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
    },
  });
  const handle = await open(outputPath, "wx", 0o600);
  try {
    const pool = new BlockPool(POOL_BLOCKS);
    let failure: unknown = null;
    const downstream = pipeline(compressor, sealer, new FileSink(handle));
    downstream.catch((error: unknown) => {
      failure ??= error;
      pool.unblock();
    });
    const writer = new TarWriter(input, await pool.acquire(), async (block) => {
      if (failure) throw failure;
      compressor.write(block, () => pool.release(block));
      return pool.acquire();
    });
    try {
      await writer.write();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      compressor.destroy();
      await downstream.catch(() => undefined);
      throw failure;
    }
    compressor.end();
    await downstream;
    return { ...writer.outcome(), ...sealer.result(), kid: sealer.kid };
  } finally {
    await handle.close();
  }
}
