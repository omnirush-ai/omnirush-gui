/** Durable state files for the archiver: every write goes to a temp name, is fsynced, then renamed (with retry). */
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";

import { commitTempFile } from "../atomic-write.js";

/** The first 32 hex characters of SHA-256(text): state file names for session ids and root paths. */
export function stateKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

type WritableHandle = { write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }> };

async function writeAll(handle: WritableHandle, text: string): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

/** Writes text pieces to `path` atomically; large documents never become one string. */
export async function writeChunksAtomic(path: string, chunks: Iterable<string>): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    let pending: string[] = [];
    let pendingLength = 0;
    for (const chunk of chunks) {
      pending.push(chunk);
      pendingLength += chunk.length;
      if (pendingLength >= 1 << 20) {
        await writeAll(handle, pending.join(""));
        pending = [];
        pendingLength = 0;
      }
    }
    if (pending.length > 0) await writeAll(handle, pending.join(""));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  // Retried while Windows reports the target busy; the temp file is removed if it still fails.
  await commitTempFile(temp, path);
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return writeChunksAtomic(path, [`${JSON.stringify(value)}\n`]);
}

/** Parsed JSON, or null when the file is missing or not JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Runs a full garbage collection when the runtime offers one (Bun.gc); a
 * no-op elsewhere. Streaming an archive churns through hundreds of MiB of
 * short-lived buffers (zstd output, AES-GCM output) that the collector would
 * otherwise let pile up well past the stream's bounded working set. Callers
 * hint once per 64 MiB of data; a collection takes a few milliseconds at the
 * heap sizes involved.
 */
export function hintGarbageCollection(): void {
  const runtime: unknown = Reflect.get(globalThis, "Bun");
  if (typeof runtime !== "object" || runtime === null) return;
  const gc: unknown = Reflect.get(runtime, "gc");
  if (typeof gc === "function") Reflect.apply(gc, runtime, [true]);
}
