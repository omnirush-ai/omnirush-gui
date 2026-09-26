/**
 * Atomic replacement of small settings and state files.
 *
 * Every write goes to a unique temp file next to the target, is flushed to
 * disk (open, write, fsync, close), then renamed over the target, so a reader
 * sees either the old content or the new one, never a partial file.
 *
 * On Windows, replacing a file fails for a moment while another process has
 * it (or the new temp file) open without delete sharing: antivirus, the
 * search indexer, a backup agent, a concurrent reader. The rename then fails
 * with EPERM, EBUSY or EACCES (ENOTEMPTY for a directory in the way), and
 * clears on its own within milliseconds to a second or so. The rename is
 * retried with backoff (about 2 s in all) before giving up, and the temp file
 * is removed whatever happens.
 */
import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { platform } from "node:os";

/** Codes a rename fails with while another process briefly holds the file. */
export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/** Waits between rename attempts: 10 attempts over about 2 s. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80, 120, 180, 250, 330, 430, 550];

/** Waits between attempts to remove a temp file that is itself briefly held. */
const REMOVE_RETRY_DELAYS_MS: readonly number[] = [20, 50, 100, 200];

type OpenedFile = {
  writeFile(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
};

/** The file operations the helper uses; tests swap them to simulate a busy file. */
export type AtomicWriteFs = {
  open(path: string, flags: string, mode?: number): Promise<OpenedFile>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
  sleep(ms: number): Promise<void>;
};

/**
 * The process-wide defaults. Tests (and only tests) may replace members to
 * simulate transient or permanent failures; always restore them afterwards.
 */
export const atomicWriteFs: AtomicWriteFs = {
  open: (path, flags, mode) => open(path, flags, mode),
  rename: (from, to) => rename(from, to),
  rm: (path, options) => rm(path, options),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type RenameRetryOptions = {
  /** Waits between attempts; defaults to RENAME_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  /** Replaces some of the file operations (tests). */
  fs?: Partial<AtomicWriteFs>;
};

export type AtomicWriteOptions = RenameRetryOptions & {
  /** File mode for the new file (e.g. 0o600 for files holding secrets); applied before the rename. */
  mode?: number;
};

/** A write that still failed after the retries; `code` is the original errno code. */
export class AtomicWriteError extends Error {
  readonly code: string;
  readonly path: string;
  readonly attempts: number;

  constructor(path: string, code: string, attempts: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      attempts > 1
        ? `Could not save ${path}: ${code} (the file stayed busy after ${attempts} attempts): ${detail}`
        : `Could not save ${path}: ${code}: ${detail}`,
      { cause },
    );
    this.name = "AtomicWriteError";
    this.code = code;
    this.path = path;
    this.attempts = attempts;
  }
}

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "EUNKNOWN";
}

function resolveFs(options: RenameRetryOptions | undefined): AtomicWriteFs {
  return options?.fs ? { ...atomicWriteFs, ...options.fs } : atomicWriteFs;
}

/** A unique temp path next to `path` (same directory, so the rename never crosses filesystems). */
export function atomicTempPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

async function renameAttempts(from: string, to: string, fs: AtomicWriteFs, delays: readonly number[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const delay = delays[attempt];
      if (delay === undefined || !TRANSIENT_RENAME_CODES.has(code)) {
        throw new AtomicWriteError(to, code, attempt + 1, error);
      }
      await fs.sleep(delay);
    }
  }
}

/** Removes a temp file; the same busy-file errors that stop a rename are retried briefly. Never throws. */
async function removeTemp(temp: string, fs: AtomicWriteFs): Promise<void> {
  for (const delay of [...REMOVE_RETRY_DELAYS_MS, undefined]) {
    try {
      await fs.rm(temp, { force: true });
      return;
    } catch (error) {
      if (delay === undefined || !TRANSIENT_RENAME_CODES.has(errorCode(error))) return;
      await fs.sleep(delay);
    }
  }
}

/**
 * Renames `from` over `to`, retrying while Windows reports the file busy.
 * Throws AtomicWriteError (with the original code) when it still fails;
 * `from` is left in place for the caller to clean up or reuse.
 */
export async function renameWithRetry(from: string, to: string, options?: RenameRetryOptions): Promise<void> {
  await renameAttempts(from, to, resolveFs(options), options?.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS);
}

/**
 * Moves an already written (and synced) temp file over `path` with retries,
 * removing the temp file when that fails. For writers that stream their own
 * temp file.
 */
export async function commitTempFile(temp: string, path: string, options?: RenameRetryOptions): Promise<void> {
  const fs = resolveFs(options);
  try {
    await renameAttempts(temp, path, fs, options?.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS);
  } catch (error) {
    await removeTemp(temp, fs);
    throw error;
  }
}

/**
 * Replaces `path` with `data` atomically: unique temp file, fsync, rename
 * with retry. The parent directory must exist. Throws AtomicWriteError (the
 * original errno code on `.code`) when it fails; no temp file is left behind.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, options?: AtomicWriteOptions): Promise<void> {
  const fs = resolveFs(options);
  const temp = atomicTempPath(path);
  try {
    const handle = await fs.open(temp, "wx", options?.mode);
    try {
      await handle.writeFile(data);
      if (options?.mode !== undefined) {
        // The process umask may have narrowed the mode; chmod is a no-op on Windows.
        await handle.chmod(options.mode).catch((error: unknown) => {
          if (platform() !== "win32") throw error;
        });
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameAttempts(temp, path, fs, options?.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS);
  } catch (error) {
    await removeTemp(temp, fs);
    if (error instanceof AtomicWriteError) throw error;
    // Creating or writing the temp file failed: no rename was attempted.
    throw new AtomicWriteError(path, errorCode(error), 0, error);
  }
}
