import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { startCaptureService, type CaptureService, type CaptureServiceOptions } from "./capture-client.js";
import { FakeArchiveServer, slowPartTwo } from "./session-archive/fake-archive-server.js";

/**
 * The capture worker: the collector's and the archiver's work runs off the
 * main event loop, a resumed session starts with the whole workspace, and
 * shutdown with work in flight settles in bounded time with archive uploads
 * aborted first.
 */

const execFileAsync = promisify(execFile);
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type Envelope = {
  session_id: string;
  snapshot_type: string;
  trigger: string;
  files_scope: string;
  changed_paths?: string[];
  files: Array<{ path: string; content: string }>;
  manifest: Array<{ path: string; sha256: string }>;
};

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `omnirush-capture-${prefix}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args]);
}

/**
 * A git workspace of `count` source files of about 5 KiB each, every one with
 * an e-mail address and a secret-named assignment, so the scrubber rewrites
 * all of them: a scan reads, hashes and scrubs every byte.
 */
async function syntheticWorkspace(count: number): Promise<string> {
  const root = await tempDir("workspace");
  await git(root, "init", "-q");
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const files = Array.from({ length: count }, (_, index) => index);
  for (let start = 0; start < files.length; start += 256) {
    await Promise.all(files.slice(start, start + 256).map(async (index) => {
      const dir = join(root, "src", `m${index % 64}`);
      await mkdir(dir, { recursive: true });
      const lines = [`// module ${index}`, `export const owner = "dev${index}@example.com";`, `const password = "Pa55-word-${index}-x";`];
      for (let line = 0; line < 90; line += 1) lines.push(`export const v${line} = "${words[(index + line) % words.length]} ${index * 31 + line}";`);
      await writeFile(join(dir, `file${index}.ts`), `${lines.join("\n")}\n`);
    }));
  }
  return root;
}

function uploadSink() {
  const compressed: Array<{ sessionId: string; bytes: Uint8Array }> = [];
  return {
    compressed,
    // Only kept here: decoding a large envelope on this thread would itself stall the loop being measured.
    upload: async (sessionId: string, bytes: Uint8Array) => {
      compressed.push({ sessionId, bytes });
      return Response.json({ ok: true }, { status: 201 });
    },
    envelopes: (): Envelope[] => compressed.map((item) => JSON.parse(zstdDecompressSync(item.bytes).toString("utf8"))),
  };
}

function service(options: Partial<CaptureServiceOptions> & Pick<CaptureServiceOptions, "stateDir" | "collector">): CaptureService {
  const capture = startCaptureService({
    appVersion: "0.0.0-test",
    engineVersion: "0.0.0-test",
    log: () => undefined,
    archive: { enabled: false, excludedDirs: [] },
    worker: true,
    ...options,
  });
  cleanups.push(() => capture.stop());
  return capture;
}

/** The longest the main event loop went without running a 5 ms timer, less the 5 ms. */
function loopMonitor() {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  return { stop: () => {
    clearInterval(timer);
    return worst;
  } };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe("capture worker", () => {
  test("a 6,000-file start snapshot is read, scrubbed, compressed and uploaded without a main-loop stall over 100 ms", async () => {
    const root = await syntheticWorkspace(6_000);
    const sink = uploadSink();
    const capture = service({ stateDir: await tempDir("state"), collector: { upload: sink.upload } });
    const monitor = loopMonitor();
    const started = performance.now();
    capture.startSession("session-offload-0001", "workspace-offload", root);
    await until(() => sink.compressed.length > 0, 90_000, "the start snapshot");
    const elapsedMs = performance.now() - started;
    const worstStallMs = monitor.stop();
    expect(capture.mode()).toBe("worker");

    const [start] = sink.envelopes();
    expect(start).toMatchObject({ snapshot_type: "start", trigger: "session_start", files_scope: "full" });
    const sources = start!.files.filter((file) => file.path.startsWith("src/"));
    expect(sources).toHaveLength(6_000);
    // The privacy rails ran on the worker exactly as in-process.
    expect(sources.every((file) => !file.content.includes("@example.com") && file.content.includes("[REDACTED_PII]"))).toBe(true);
    expect(sources.every((file) => file.content.includes('const password = "[REDACTED]";'))).toBe(true);
    const diagnostics = await capture.diagnostics();
    expect(diagnostics?.metrics.fileRedactions).toBeGreaterThanOrEqual(6_000);
    // Seconds of reading, hashing and scrubbing, and the loop kept running throughout.
    expect(elapsedMs).toBeGreaterThan(200);
    expect(worstStallMs).toBeLessThan(100);
    await capture.stop();
  }, 120_000);

  test("a resumed session's start snapshot through the worker carries the whole workspace, with what changed while the app was closed", async () => {
    const root = await syntheticWorkspace(50);
    const stateDir = await tempDir("state");
    const sessionId = "session-resume-0001";
    const firstSink = uploadSink();
    const first = service({ stateDir, collector: { upload: firstSink.upload } });
    first.startSession(sessionId, "workspace-resume", root);
    await first.stop();
    expect(firstSink.envelopes().map((item) => [item.snapshot_type, item.files_scope])).toEqual([["start", "full"], ["end", "changed"]]);

    await writeFile(join(root, "src", "m7", "file7.ts"), "export const edited = true;\n");
    const secondSink = uploadSink();
    const second = service({ stateDir, collector: { upload: secondSink.upload } });
    second.startSession(sessionId, "workspace-resume", root);
    await second.idle();
    const [resumed] = secondSink.envelopes();
    expect(resumed).toMatchObject({ snapshot_type: "start", trigger: "resume", files_scope: "full" });
    expect(resumed!.changed_paths).toBeUndefined();
    const sources = resumed!.files.filter((file) => file.path.startsWith("src/"));
    expect(sources).toHaveLength(50);
    expect(sources.find((file) => file.path === "src/m7/file7.ts")?.content).toBe("export const edited = true;\n");
    expect(resumed!.manifest).toHaveLength(50);
    await second.stop();
  }, 60_000);

  test("stopping with a start snapshot in flight finishes it and the session's end snapshot, then ends the worker", async () => {
    const root = await syntheticWorkspace(3_000);
    const sink = uploadSink();
    const capture = service({ stateDir: await tempDir("state"), collector: { upload: sink.upload } });
    capture.startSession("session-stop-00001", "workspace-stop", root);
    await capture.diagnostics();
    const stopping = performance.now();
    await capture.stop();
    expect(performance.now() - stopping).toBeLessThan(15_000);
    expect(capture.mode()).toBe("down");
    expect(sink.envelopes().map((item) => item.snapshot_type)).toEqual(["start", "end"]);
    // Nothing runs after stop: calls are dropped, queries answer at once.
    capture.startSession("session-stop-00002", "workspace-stop", root);
    expect(await capture.diagnostics()).toBeNull();
  }, 60_000);

  test("stopping aborts an archive part upload in flight on the main thread within a second", async () => {
    const root = await tempDir("project");
    await writeFile(join(root, "README.md"), "# project\n".repeat(200));
    await git(root, "init", "-q");
    await git(root, "add", "README.md");
    await git(root, "commit", "-q", "-m", "initial");
    const archive = new FakeArchiveServer();
    archive.partSize = 256;
    const slow = slowPartTwo(archive);
    const engine = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (new URL(request.url).pathname.endsWith("/message") ? Response.json([]) : Response.json({ id: "ses_archive_0001" })),
    });
    cleanups.push(() => engine.stop(true));
    const sink = uploadSink();
    const capture = service({
      stateDir: await tempDir("state"),
      collector: { upload: sink.upload },
      archive: {
        enabled: true,
        excludedDirs: [],
        request: (path, init) => archive.respond(`https://api.omnirush.test/omnirush/${path}`, {
          method: init.method,
          headers: { authorization: `Bearer ${archive.token}` },
          ...(init.body === undefined ? {} : { body: init.body }),
        }),
        refreshAccessToken: async () => null,
        fetch: slow.fetch,
        baseIdleMs: 0,
      },
    });
    capture.startSession("ses_archive_0001", "workspace-archive", root);
    capture.archiveSessionStarted("ses_archive_0001", root, { baseUrl: `http://127.0.0.1:${engine.port}`, headers: [], search: "", engine: "v1" });
    await slow.started;

    slow.markCommand();
    await capture.stop();
    expect(slow.puts).toEqual([{ part: 2, bytes: 256, abortedAfterMs: expect.any(Number), completed: false }]);
    expect(slow.puts[0]!.abortedAfterMs!).toBeLessThan(1_000);
    // The collector still delivered the session's end snapshot on the way out.
    expect(sink.envelopes().map((item) => item.snapshot_type)).toContain("end");
  }, 60_000);

  test("stopping packs the project archive's final archives on the worker, unless the account is gone", async () => {
    const results: string[][] = [];
    for (const archiveFinals of [undefined, Promise.resolve(false)]) {
      const root = await tempDir("project");
      await writeFile(join(root, "README.md"), "# project\n");
      await git(root, "init", "-q");
      await git(root, "add", "README.md");
      await git(root, "commit", "-q", "-m", "initial");
      const archive = new FakeArchiveServer();
      const engine = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => (new URL(request.url).pathname.endsWith("/message") ? Response.json([]) : Response.json({ id: "ses_final_stop_01" })),
      });
      cleanups.push(() => engine.stop(true));
      const stateDir = await tempDir("state");
      const capture = service({
        stateDir,
        collector: { upload: uploadSink().upload },
        archive: {
          enabled: true,
          excludedDirs: [],
          request: (path, init) => archive.respond(`https://api.omnirush.test/omnirush/${path}`, {
            method: init.method,
            headers: { authorization: `Bearer ${archive.token}` },
            ...(init.body === undefined ? {} : { body: init.body }),
          }),
          refreshAccessToken: async () => null,
          fetch: archive.respond,
          baseIdleMs: 0,
        },
      });
      capture.startSession("ses_final_stop_01", "workspace-final", root);
      capture.archiveSessionStarted("ses_final_stop_01", root, { baseUrl: `http://127.0.0.1:${engine.port}`, headers: [], search: "", engine: "v1" });
      await capture.idle();
      expect(archive.objects().map((object) => object.request.kind)).toEqual(["base"]);
      // Edited after the chat's last turn, then the app quits (or the user signs out).
      await writeFile(join(root, "notes.md"), "after the last turn\n");
      await capture.stop(archiveFinals === undefined ? {} : { archiveFinals });
      results.push(await readdir(join(stateDir, "omnirush-archive", "queue")));
    }
    expect(results[0]).toHaveLength(1);
    expect(results[1]).toEqual([]);
  }, 60_000);

  test("the archiver on the worker reads the all-folders policy from the key and archives a folder without .git only while it is on", async () => {
    const engine = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (new URL(request.url).pathname.endsWith("/message") ? Response.json([]) : Response.json({ id: "ses_folder_0001" })),
    });
    cleanups.push(() => engine.stop(true));
    for (const policy of [undefined, { all_folders: true }]) {
      const home = await tempDir("home");
      const root = join(home, "notes");
      await mkdir(root);
      await writeFile(join(root, "plan.md"), "# plan\n");
      const archive = new FakeArchiveServer();
      archive.policy = policy;
      const refreshFlags: unknown[] = [];
      const capture = service({
        stateDir: await tempDir("state"),
        collector: { upload: uploadSink().upload },
        archive: {
          enabled: true,
          excludedDirs: [],
          folderGate: { homeDir: home },
          request: (path, init) => {
            refreshFlags.push("refresh" in init ? init.refresh : "absent");
            return archive.respond(`https://api.omnirush.test/omnirush/${path}`, {
              method: init.method,
              headers: { authorization: `Bearer ${archive.token}` },
              ...(init.body === undefined ? {} : { body: init.body }),
            });
          },
          refreshAccessToken: async () => null,
          fetch: archive.respond,
          baseIdleMs: 0,
        },
      });
      capture.startSession("ses_folder_0001", "workspace-folder", root);
      capture.archiveSessionStarted("ses_folder_0001", root, { baseUrl: `http://127.0.0.1:${engine.port}`, headers: [], search: "", engine: "v1" });
      await until(() => archive.calls.some((call) => call.path === "archives/key"), 20_000, "the key read");
      await capture.idle();
      expect(capture.mode()).toBe("worker");
      if (policy) {
        await until(() => archive.objects().length === 1, 20_000, "the folder's base archive");
        expect(archive.objects()[0]!.request).toMatchObject({ session_id: "ses_folder_0001", kind: "base", marker: "folder" });
      } else {
        expect(archive.callPaths()).toEqual(["GET archives/key 200"]);
      }
      // The policy probe reached the main thread's request hook with no bearer refresh.
      expect(refreshFlags[0]).toBe(false);
      await capture.stop();
    }
  }, 60_000);

  test("OMNIRUSH_CAPTURE_WORKER=0 captures in-process with the same envelopes", async () => {
    const root = await syntheticWorkspace(20);
    const results: Array<Array<[string, string, number]>> = [];
    for (const worker of [true, false]) {
      const sink = uploadSink();
      const capture = service({ stateDir: await tempDir("state"), collector: { upload: sink.upload }, worker });
      expect(capture.mode()).toBe(worker ? "starting" : "local");
      capture.startSession("session-modes-0001", "workspace-modes", root);
      expect(capture.hasSession("session-modes-0001")).toBe(true);
      expect(capture.recordWebVisit("session-modes-0001", { url: "https://example.com/docs", title: "Docs", text: "mail jane@example.com" })).toBe(true);
      expect(capture.recordWebVisit("session-modes-0001", { url: "http://localhost:3000/" })).toBe(false);
      await capture.stop();
      expect(capture.mode()).toBe("down");
      results.push(sink.envelopes().map((item) => [item.snapshot_type, item.files_scope, item.files.length]));
    }
    expect(results[0]).toEqual([["start", "full", 21], ["trace", "full", 1], ["end", "changed", 1]]);
    expect(results[1]).toEqual(results[0]!);
  }, 60_000);
});
