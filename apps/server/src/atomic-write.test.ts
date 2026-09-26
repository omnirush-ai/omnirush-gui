import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AtomicWriteError,
  RENAME_RETRY_DELAYS_MS,
  atomicWriteFs,
  commitTempFile,
  renameWithRetry,
  writeFileAtomic,
  type AtomicWriteFs,
} from "./atomic-write.js";
import { readSubagentModelSetting, writeSubagentModelSetting } from "./omnirush-subagent-model.js";
import type { ServerConfig } from "./types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omnirush-atomic-write-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: operation not permitted, rename`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** A rename that fails with `code` the first `failures` times, then renames for real. */
function flakyRename(code: string, failures: number) {
  const calls: Array<[string, string]> = [];
  const renameFn = async (from: string, to: string) => {
    calls.push([from, to]);
    if (calls.length <= failures) throw errno(code);
    await rename(from, to);
  };
  return { calls, rename: renameFn };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

describe("writeFileAtomic", () => {
  test("the default backoff is about 10 attempts over about 2 s", () => {
    expect(RENAME_RETRY_DELAYS_MS.length + 1).toBe(10);
    const total = RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(1_500);
    expect(total).toBeLessThanOrEqual(2_500);
  });

  for (const code of ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]) {
    test(`a rename refused with ${code} a few times is retried and the file is saved`, async () => {
      const target = join(root, "setting.json");
      await writeFile(target, '{"old":true}\n');
      const flaky = flakyRename(code, 4);
      const { waits, sleep } = recordingSleep();
      await writeFileAtomic(target, '{"new":true}\n', { fs: { rename: flaky.rename, sleep } });
      expect(await readFile(target, "utf8")).toBe('{"new":true}\n');
      expect(flaky.calls).toHaveLength(5);
      expect(waits).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 4));
      // Every attempt renamed the same unique temp file next to the target.
      expect(new Set(flaky.calls.map(([from]) => from)).size).toBe(1);
      expect(flaky.calls[0]![0].startsWith(`${target}.`)).toBe(true);
      expect(await readdir(root)).toEqual(["setting.json"]);
    });
  }

  test("a rename that never succeeds throws the original code, removes the temp file and keeps the old content", async () => {
    const target = join(root, "setting.json");
    await writeFile(target, '{"old":true}\n');
    const flaky = flakyRename("EPERM", Number.POSITIVE_INFINITY);
    const { waits, sleep } = recordingSleep();
    const error = await writeFileAtomic(target, '{"new":true}\n', { fs: { rename: flaky.rename, sleep } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AtomicWriteError);
    expect((error as AtomicWriteError).code).toBe("EPERM");
    expect((error as AtomicWriteError).attempts).toBe(10);
    expect((error as AtomicWriteError).message).toContain("EPERM");
    expect((error as AtomicWriteError).message).toContain(target);
    expect(flaky.calls).toHaveLength(10);
    expect(waits).toEqual([...RENAME_RETRY_DELAYS_MS]);
    expect(await readdir(root)).toEqual(["setting.json"]);
    expect(await readFile(target, "utf8")).toBe('{"old":true}\n');
  });

  test("a temp file that is itself briefly held is still removed after a failed save", async () => {
    const target = join(root, "setting.json");
    let removals = 0;
    const { sleep } = recordingSleep();
    const error = await writeFileAtomic(target, "x", {
      retryDelaysMs: [],
      fs: {
        rename: flakyRename("EPERM", 99).rename,
        rm: async (path, options) => {
          removals += 1;
          if (removals <= 2) throw errno("EBUSY");
          await rm(path, options);
        },
        sleep,
      },
    }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("EPERM");
    expect(removals).toBe(3);
    expect(await readdir(root)).toEqual([]);
  });

  test("an error that is not a busy file is not retried", async () => {
    const target = join(root, "setting.json");
    const flaky = flakyRename("EXDEV", Number.POSITIVE_INFINITY);
    const { waits, sleep } = recordingSleep();
    const error = await writeFileAtomic(target, "x", { fs: { rename: flaky.rename, sleep } }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("EXDEV");
    expect(flaky.calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  test("injected delays replace the default backoff", async () => {
    const target = join(root, "setting.json");
    const flaky = flakyRename("EBUSY", Number.POSITIVE_INFINITY);
    const { waits, sleep } = recordingSleep();
    const error = await writeFileAtomic(target, "x", { retryDelaysMs: [1, 2], fs: { rename: flaky.rename, sleep } }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("EBUSY");
    expect((error as AtomicWriteError).attempts).toBe(3);
    expect(waits).toEqual([1, 2]);
    expect(await readdir(root)).toEqual([]);
  });

  test("the data is written, synced and closed before the rename; a failed write leaves no temp file", async () => {
    const target = join(root, "setting.json");
    const steps: string[] = [];
    const fs: Partial<AtomicWriteFs> = {
      open: async (path, flags, mode) => {
        const handle = await atomicWriteFs.open(path, flags, mode);
        return {
          writeFile: async (data) => { steps.push("write"); return handle.writeFile(data); },
          chmod: async (value) => { steps.push("chmod"); return handle.chmod(value); },
          sync: async () => { steps.push("sync"); return handle.sync(); },
          close: async () => { steps.push("close"); return handle.close(); },
        };
      },
      rename: async (from, to) => { steps.push("rename"); await rename(from, to); },
    };
    await writeFileAtomic(target, "hello", { mode: 0o600, fs });
    expect(steps).toEqual(["write", "chmod", "sync", "close", "rename"]);

    const failing: Partial<AtomicWriteFs> = {
      open: async (path, flags, mode) => {
        const handle = await atomicWriteFs.open(path, flags, mode);
        return { writeFile: async () => { throw errno("ENOSPC"); }, sync: () => handle.sync(), chmod: (value) => handle.chmod(value), close: () => handle.close() };
      },
    };
    const error = await writeFileAtomic(target, "again", { fs: failing }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("ENOSPC");
    expect(await readdir(root)).toEqual(["setting.json"]);
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  test.skipIf(process.platform === "win32")("keeps the mode callers ask for", async () => {
    const target = join(root, "secret.json");
    await writeFileAtomic(target, "{}", { mode: 0o600 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  test("writes buffers", async () => {
    const target = join(root, "blob.bin");
    await writeFileAtomic(target, Buffer.from([1, 2, 3]));
    expect([...await readFile(target)]).toEqual([1, 2, 3]);
  });
});

describe("renameWithRetry and commitTempFile", () => {
  test("renameWithRetry retries a busy file and leaves the source on permanent failure", async () => {
    const from = join(root, "a.tmp");
    const to = join(root, "a.json");
    await writeFile(from, "1");
    const { sleep } = recordingSleep();
    await renameWithRetry(from, to, { fs: { rename: flakyRename("EACCES", 2).rename, sleep } });
    expect(await readFile(to, "utf8")).toBe("1");

    await writeFile(from, "2");
    const error = await renameWithRetry(from, to, { fs: { rename: flakyRename("EPERM", 99).rename, sleep } }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("EPERM");
    expect((await readdir(root)).sort()).toEqual(["a.json", "a.tmp"]);
  });

  test("commitTempFile removes the temp file when the rename keeps failing", async () => {
    const temp = join(root, "b.json.123.tmp");
    await writeFile(temp, "x");
    const { sleep } = recordingSleep();
    const error = await commitTempFile(temp, join(root, "b.json"), { fs: { rename: flakyRename("EBUSY", 99).rename, sleep } }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("EBUSY");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("the sub-agent picker's setting file", () => {
  const original = { ...atomicWriteFs };
  let previousRuntimeDb: string | undefined;
  let config: ServerConfig;

  beforeEach(async () => {
    previousRuntimeDb = process.env.OMNIRUSH_RUNTIME_DB;
    process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime", "runtime.sqlite");
    await mkdir(join(root, "runtime"), { recursive: true });
    config = { configPath: join(root, "server.json") } as unknown as ServerConfig;
  });

  afterEach(() => {
    Object.assign(atomicWriteFs, original);
    if (previousRuntimeDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
    else process.env.OMNIRUSH_RUNTIME_DB = previousRuntimeDb;
  });

  test("survives Windows refusing the rename a few times", async () => {
    const flaky = flakyRename("EPERM", 3);
    atomicWriteFs.rename = flaky.rename;
    atomicWriteFs.sleep = async () => undefined;
    expect(await writeSubagentModelSetting(config, { model: "gpt-6-sol", effort: "high" })).toEqual({ model: "gpt-6-sol", effort: "high" });
    expect(flaky.calls).toHaveLength(4);
    expect(await readSubagentModelSetting(config)).toEqual({ model: "gpt-6-sol", effort: "high" });
    expect((await readdir(join(root, "runtime"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a save that keeps failing throws with the code and keeps the previous setting", async () => {
    await writeSubagentModelSetting(config, { model: "gpt-6-astra", effort: null });
    atomicWriteFs.rename = flakyRename("EBUSY", 99).rename;
    atomicWriteFs.sleep = async () => undefined;
    const error = await writeSubagentModelSetting(config, { model: "gpt-6-sol", effort: "low" }).catch((caught: unknown) => caught);
    expect((error as AtomicWriteError).code).toBe("EBUSY");
    expect(await readSubagentModelSetting(config)).toEqual({ model: "gpt-6-astra", effort: null });
    expect((await readdir(join(root, "runtime"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
