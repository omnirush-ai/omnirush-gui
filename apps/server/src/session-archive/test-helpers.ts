/** Shared helpers for the session-archive tests (not used by production code). */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import vectors from "./__fixtures__/orseal_vectors.json" with { type: "json" };
import { openSealedBuffer, sealKeyring } from "./seal.js";

const created: string[] = [];

/** A fresh temp directory by its real path (macOS temp paths go through a /var symlink). */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `omnirush-archive-test-${prefix}-`)));
  created.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of stream) pieces.push(Buffer.from(piece));
  return Buffer.concat(pieces);
}

export type TarMemberRead = { name: string; typeflag: string; mode: number; size: number; mtime: number; linkname: string; uid: number; gid: number; content: Buffer };

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(block: Buffer, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/** A minimal pax-aware tar reader for assertions: ustar members plus `x` records (path, linkpath, size). */
export function readTar(tar: Buffer): TarMemberRead[] {
  const members: TarMemberRead[] = [];
  let offset = 0;
  let pax: Record<string, string> = {};
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
    if (sum !== octal(block, 148, 8)) throw new Error(`bad tar checksum at ${offset}`);
    const typeflag = field(block, 156, 1);
    let size = octal(block, 124, 12);
    offset += 512;
    if (typeflag === "x") {
      const body = tar.subarray(offset, offset + size);
      pax = {};
      let position = 0;
      while (position < body.length) {
        const space = body.indexOf(0x20, position);
        const length = Number.parseInt(body.subarray(position, space).toString("ascii"), 10);
        if (!(length > 0) || body[position + length - 1] !== 0x0a) throw new Error("bad pax record");
        const record = body.subarray(space + 1, position + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        pax[record.slice(0, equals)] = record.slice(equals + 1);
        position += length;
      }
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const prefix = field(block, 345, 155);
    let name = pax.path ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    if (pax.size) size = Number(pax.size);
    const linkname = pax.linkpath ?? field(block, 157, 100);
    if (typeflag === "5" && name.endsWith("/")) name = name.slice(0, -1);
    members.push({
      name,
      typeflag,
      mode: octal(block, 100, 8),
      size,
      mtime: octal(block, 136, 12),
      linkname,
      uid: octal(block, 108, 8),
      gid: octal(block, 116, 8),
      content: Buffer.from(tar.subarray(offset, offset + size)),
    });
    pax = {};
    offset += Math.ceil(size / 512) * 512;
  }
  return members;
}

export const testKeys = {
  publicKey: Buffer.from(vectors.keys.server.public_hex, "hex"),
  publicB64: vectors.keys.server.public_b64,
  kid: vectors.keys.server.kid,
  keyring: sealKeyring([Buffer.from(vectors.keys.server.private_hex, "hex")]),
};

/** Sealed archive bytes -> the tar members inside (unseal, unzstd, parse). */
export async function openArchive(sealed: Buffer): Promise<TarMemberRead[]> {
  return readTar(zstdDecompressSync(await openSealedBuffer(sealed, testKeys.keyring)));
}

export function manifestOf(members: readonly TarMemberRead[]): Record<string, unknown> {
  const first = members[0];
  if (!first || first.name !== "__omnirush__/manifest.json") throw new Error("the manifest is not the first member");
  const parsed: unknown = JSON.parse(first.content.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the manifest is not an object");
  return Object.fromEntries(Object.entries(parsed));
}
