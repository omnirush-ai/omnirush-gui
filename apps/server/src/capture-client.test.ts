import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { startCaptureService, type CaptureService, type CaptureServiceOptions } from "./capture-client.js";
import { FakeArchiveServer, slowPartTwo } from "./session-archive/fake-archive-server.js";
import { openArchive } from "./session-archive/test-helpers.js";

/**
 * The capture worker: the session uploader's and the archiver's work runs off the
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
  await execFileAsync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "user.name=Dev", "-c", "user.email=dev@acme-mail.io", ...args]);
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

function service(options: Partial<CaptureServiceOptions> & Pick<CaptureServiceOptions, "stateDir" | "sessionUploader">): CaptureService {
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
  // These pin the worker's exact envelope sequence; capture context would add a trace of its own.
  let contextSwitch: string | undefined;
  beforeAll(() => {
    contextSwitch = process.env.OMNIRUSH_CAPTURE_CONTEXT;
    process.env.OMNIRUSH_CAPTURE_CONTEXT = "0";
  });
  afterAll(() => {
    if (contextSwitch === undefined) delete process.env.OMNIRUSH_CAPTURE_CONTEXT;
    else process.env.OMNIRUSH_CAPTURE_CONTEXT = contextSwitch;
  });
  test("a 6,000-file start snapshot is read, scrubbed, compressed and uploaded without a main-loop stall over 100 ms", async () => {
    const root = await syntheticWorkspace(6_000);
    const sink = uploadSink();
    const capture = service({ stateDir: await tempDir("state"), sessionUploader: { upload: sink.upload } });
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
    const first = service({ stateDir, sessionUploader: { upload: firstSink.upload } });
    first.startSession(sessionId, "workspace-resume", root);
    await first.stop();
    expect(firstSink.envelopes().map((item) => [item.snapshot_type, item.files_scope])).toEqual([["start", "full"], ["end", "changed"]]);

    await writeFile(join(root, "src", "m7", "file7.ts"), "export const edited = true;\n");
    const secondSink = uploadSink();
    const second = service({ stateDir, sessionUploader: { upload: secondSink.upload } });
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
    const capture = service({ stateDir: await tempDir("state"), sessionUploader: { upload: sink.upload } });
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
      sessionUploader: { upload: sink.upload },
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
    // The session uploader still delivered the session's end snapshot on the way out.
    expect(sink.envelopes().map((item) => item.snapshot_type)).toContain("end");
  }, 60_000);

  test("a stop that runs out of time aborts the session upload this thread still serves for the worker, and does not wait for it", async () => {
    const root = await syntheticWorkspace(5);
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    const capture = service({
      stateDir: await tempDir("state"),
      stopTimeoutMs: 300,
      sessionUploader: {
        // The gateway never answers and this hook ignores its signal, as a stalled upload on the main thread would.
        upload: (_sessionId, _bytes, signal) => {
          signals.push(signal!);
          started();
          return new Promise<Response>(() => undefined);
        },
      },
    });
    capture.startSession("session-served-0001", "workspace-served", root);
    await inFlight;
    expect(signals[0]!.aborted).toBe(false);
    const stopping = performance.now();
    await capture.stop();
    expect(performance.now() - stopping).toBeLessThan(5_000);
    expect(capture.mode()).toBe("down");
    // Terminating the worker ended the request it had asked this thread to make.
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  }, 60_000);

  test("in-process, a stop that runs out of time aborts the upload in flight and spools it for the next start", async () => {
    const root = await syntheticWorkspace(5);
    const stateDir = await tempDir("state");
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    const capture = service({
      stateDir,
      worker: false,
      stopTimeoutMs: 300,
      sessionUploader: {
        upload: (_sessionId, _bytes, signal) => {
          signals.push(signal!);
          started();
          return new Promise<Response>(() => undefined);
        },
      },
    });
    capture.startSession("session-local-stop-01", "workspace-local-stop", root);
    await inFlight;
    const stopping = performance.now();
    await capture.stop();
    expect(performance.now() - stopping).toBeLessThan(5_000);
    expect(signals[0]!.aborted).toBe(true);
    // The start snapshot and the session's end snapshot wait in the spool, the end one never sent.
    const spoolDir = join(stateDir, "omnirush-upload-spool");
    const spooledTypes = async () => (await Promise.all((await readdir(spoolDir).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => (JSON.parse(await readFile(join(spoolDir, name), "utf8")) as { snapshot_type: string }).snapshot_type))).sort();
    await until(async () => (await spooledTypes()).length === 2, 10_000, "the spooled snapshots");
    expect(await spooledTypes()).toEqual(["end", "start"]);
    expect(signals).toHaveLength(1);
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
        sessionUploader: { upload: uploadSink().upload },
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
        sessionUploader: { upload: uploadSink().upload },
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

  test("on the worker, the paths the session uploader sees a session touch reach the touched-files archive: a folder without .git gets only those files", async () => {
    const sessionId = "ses_touched_0001";
    const engine = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (new URL(request.url).pathname.endsWith("/message") ? Response.json([]) : Response.json({ id: sessionId })),
    });
    cleanups.push(() => engine.stop(true));
    const home = await tempDir("home");
    const root = join(home, "report");
    await mkdir(root);
    const brief = randomBytes(64 * 1024);
    await writeFile(join(root, "brief.pdf"), brief);
    await writeFile(join(root, "untouched.txt"), "never touched\n");
    const archive = new FakeArchiveServer();
    archive.policy = { touched_files: true };
    const stateDir = await tempDir("state");
    const capture = service({
      stateDir,
      sessionUploader: { upload: uploadSink().upload },
      archive: {
        enabled: true,
        excludedDirs: [],
        folderGate: { homeDir: home },
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
    capture.startSession(sessionId, "workspace-touched", root);
    capture.archiveSessionStarted(sessionId, root, { baseUrl: `http://127.0.0.1:${engine.port}`, headers: [], search: "", engine: "v1" });
    await until(() => archive.calls.some((call) => call.path === "archives/key"), 20_000, "the key read");
    await capture.idle();
    expect(capture.mode()).toBe("worker");
    // Registered: nothing packed before a capture with a touched file.
    expect(archive.callPaths()).toEqual(["GET archives/key 200"]);
    // The agent reads the PDF; the app quits: the quit's final archive is the chain's base.
    capture.recordTrace(sessionId, "tool.read", { input: { filePath: join(root, "brief.pdf") } });
    await capture.idle();
    await capture.stop();
    const archiveDir = join(stateDir, "omnirush-archive");
    const queue = await readdir(join(archiveDir, "queue"));
    expect(queue).toHaveLength(1);
    const record = JSON.parse(await readFile(join(archiveDir, "queue", queue[0]!), "utf8"));
    expect(record.request).toMatchObject({ session_id: sessionId, kind: "base", sequence: 0, turn: 0, marker: "touched" });
    const members = await openArchive(await readFile(join(archiveDir, "pending", record.sealed_file)));
    expect(members.map((member) => member.name)).toEqual(["__omnirush__/manifest.json", "brief.pdf"]);
    expect(members[1]!.content.equals(brief)).toBe(true);
  }, 60_000);

  test("through the worker, uploads carry their Idempotency-Key, the integrity read reaches the main thread and the spool is stamped with the account", async () => {
    const stateDir = await tempDir("keys-state");
    const root = await tempDir("keys-root");
    await writeFile(join(root, "app.txt"), "hello\n");
    const keys: Array<string | undefined> = [];
    const integrity: string[] = [];
    const capture = service({
      stateDir,
      accountId: async () => "user-worker-1",
      sessionIntegrity: async (sessionId, options) => {
        integrity.push(`${sessionId}:${options?.summary === true}`);
        return Response.json({ detail: "session_not_found" }, { status: 404 });
      },
      sessionUploader: {
        upload: async (_sessionId, _bytes, _signal, request) => {
          keys.push(request?.idempotencyKey);
          return Response.json({ detail: "unavailable" }, { status: 503 });
        },
      },
    });
    capture.startSession("session-worker-keys", "workspace-keys", root);
    await capture.idle();
    await capture.stop();
    expect(integrity).toEqual(["session-worker-keys:true"]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => typeof key === "string" && /^[0-9a-f]{64}$/.test(key))).toBe(true);
    const spool = join(stateDir, "omnirush-upload-spool");
    const metas = await Promise.all((await readdir(spool)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(spool, name), "utf8")) as Record<string, unknown>));
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((meta) => meta.account_id === "user-worker-1" && typeof meta.idempotency_key === "string")).toBe(true);
  });

  test("OMNIRUSH_CAPTURE_WORKER=0 captures in-process with the same envelopes", async () => {
    const root = await syntheticWorkspace(20);
    const results: Array<Array<[string, string, number]>> = [];
    for (const worker of [true, false]) {
      const sink = uploadSink();
      const capture = service({ stateDir: await tempDir("state"), sessionUploader: { upload: sink.upload }, worker });
      expect(capture.mode()).toBe(worker ? "starting" : "local");
      capture.startSession("session-modes-0001", "workspace-modes", root);
      expect(capture.hasSession("session-modes-0001")).toBe(true);
      expect(capture.recordWebVisit("session-modes-0001", { url: "https://example.com/docs", title: "Docs", text: "mail jane@acme-mail.io" })).toBe(true);
      expect(capture.recordWebVisit("session-modes-0001", { url: "http://localhost:3000/" })).toBe(false);
      await capture.stop();
      expect(capture.mode()).toBe("down");
      results.push(sink.envelopes().map((item) => [item.snapshot_type, item.files_scope, item.files.length]));
    }
    expect(results[0]).toEqual([["start", "full", 21], ["trace", "full", 1], ["end", "changed", 1]]);
    expect(results[1]).toEqual(results[0]!);
  }, 60_000);
});

describe("capture worker restarts", () => {
  // The worker's test-only crash hook (capture-worker.ts) answers only with this set.
  let crashSwitch: string | undefined;
  beforeAll(() => {
    crashSwitch = process.env.OMNIRUSH_CAPTURE_TEST_CRASH;
    process.env.OMNIRUSH_CAPTURE_TEST_CRASH = "1";
  });
  afterAll(() => {
    if (crashSwitch === undefined) delete process.env.OMNIRUSH_CAPTURE_TEST_CRASH;
    else process.env.OMNIRUSH_CAPTURE_TEST_CRASH = crashSwitch;
  });

  function crashing(options: Partial<CaptureServiceOptions> = {}) {
    const restarts: Array<Record<string, unknown>> = [];
    const modes: string[] = [];
    const capture = service({
      stateDir: "",
      sessionUploader: {},
      log: (_level, message, attributes) => {
        if (message.includes("starting a new") && attributes) restarts.push(attributes);
      },
      onModeChange: (mode) => modes.push(mode),
      ...options,
    });
    const crash = async () => {
      await until(() => capture.mode() === "worker", 10_000, "a ready worker");
      capture.recordTrace("session-crash-0001", "omnirush.test.worker_crash");
      await until(() => capture.mode() === "restarting", 10_000, "the worker's exit");
    };
    return { capture, restarts, modes, crash };
  }

  test("a worker that keeps exiting is replaced every time, after a pause that doubles up to its cap, and is \"down\" only once stopped", async () => {
    const { capture, restarts, modes, crash } = crashing({ stateDir: await tempDir("state"), restartBackoffMs: { baseMs: 40, maxMs: 160 } });
    for (let index = 0; index < 5; index += 1) await crash();
    expect(restarts.map((item) => [item.code, item.attempt, item.delayMs])).toEqual([[70, 1, 40], [70, 2, 80], [70, 3, 160], [70, 4, 160], [70, 5, 160]]);
    expect(capture.status()).toMatchObject({ mode: "restarting", restarts: 5 });
    await until(() => capture.mode() === "worker", 10_000, "the sixth worker");
    expect(await capture.diagnostics()).not.toBeNull();
    expect(modes).toEqual([...Array.from({ length: 5 }, () => ["worker", "restarting", "starting"]).flat(), "worker"]);
    await capture.stop();
    expect(capture.mode()).toBe("down");
    expect(modes.at(-1)).toBe("down");
  }, 60_000);

  test("a worker that stayed up long enough starts the backoff over", async () => {
    const { capture, restarts, crash } = crashing({ stateDir: await tempDir("state"), restartBackoffMs: { baseMs: 40, maxMs: 1_000, stableMs: 300 } });
    await crash();
    await crash();
    await until(() => capture.mode() === "worker", 10_000, "the third worker");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    await crash();
    expect(restarts.map((item) => [item.attempt, item.delayMs])).toEqual([[1, 40], [2, 80], [1, 40]]);
    expect(capture.status().restarts).toBe(3);
  }, 30_000);

  test("calls made while restarting reach the next worker", async () => {
    const root = await syntheticWorkspace(5);
    const sink = uploadSink();
    const { capture, crash } = crashing({ stateDir: await tempDir("state"), sessionUploader: { upload: sink.upload }, restartBackoffMs: { baseMs: 400, maxMs: 400 } });
    await crash();
    capture.startSession("session-restart-0001", "workspace-restart", root);
    const diagnostics = capture.diagnostics();
    expect(capture.mode()).toBe("restarting");
    expect(await diagnostics).not.toBeNull();
    expect(capture.mode()).toBe("worker");
    await capture.idle();
    expect(sink.envelopes().map((item) => [item.session_id, item.snapshot_type])).toEqual([["session-restart-0001", "start"]]);
  }, 30_000);
});

describe("turns left open: worker restarts and quits", () => {
  let crashSwitch: string | undefined;
  let contextSwitch: string | undefined;
  beforeAll(() => {
    crashSwitch = process.env.OMNIRUSH_CAPTURE_TEST_CRASH;
    contextSwitch = process.env.OMNIRUSH_CAPTURE_CONTEXT;
    process.env.OMNIRUSH_CAPTURE_TEST_CRASH = "1";
    process.env.OMNIRUSH_CAPTURE_CONTEXT = "0";
  });
  afterAll(() => {
    if (crashSwitch === undefined) delete process.env.OMNIRUSH_CAPTURE_TEST_CRASH;
    else process.env.OMNIRUSH_CAPTURE_TEST_CRASH = crashSwitch;
    if (contextSwitch === undefined) delete process.env.OMNIRUSH_CAPTURE_CONTEXT;
    else process.env.OMNIRUSH_CAPTURE_CONTEXT = contextSwitch;
  });

  const SESSION = "ses_recovered_0001";

  /** A fake engine with one chat: its status and its messages. */
  function fakeEngine() {
    const control = { busy: true, messages: [] as Array<{ info: Record<string, unknown>; parts: unknown[] }> };
    const message = (id: string, role: "user" | "assistant") => ({
      info: { id, sessionID: SESSION, role, time: role === "assistant" ? { created: 1, completed: 2 } : { created: 1 } },
      parts: [{ id: `${id}_p`, messageID: id, sessionID: SESSION, type: "text", text: `${role} ${id}` }],
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/session/status") return Response.json(control.busy ? { [SESSION]: { type: "busy" } } : {});
        if (url.pathname === `/session/${SESSION}/message`) return Response.json(control.messages);
        if (url.pathname === `/session/${SESSION}/children`) return Response.json([]);
        if (url.pathname === `/session/${SESSION}`) return Response.json({ id: SESSION });
        return Response.json({ code: "not_found" }, { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    const target = { baseUrl: `http://127.0.0.1:${server.port}`, headers: [] as Array<[string, string]>, search: "", engine: "v1" as const };
    return { control, message, target };
  }

  test("a worker killed mid-turn: the next worker uploads the turn's journaled events, marked recovered, and settles the turn from the engine", async () => {
    const root = await tempDir("recover-root");
    await writeFile(join(root, "app.txt"), "hello\n");
    const sink = uploadSink();
    const engine = fakeEngine();
    engine.control.messages = [engine.message("msg_1", "user")];
    const capture = service({
      stateDir: await tempDir("recover-state"),
      sessionUploader: { upload: sink.upload },
      restartBackoffMs: { baseMs: 50, maxMs: 50 },
    });
    capture.startSession(SESSION, "workspace-recover", root);
    capture.captureSnapshot(SESSION, "prompt");
    capture.recordTrace(SESSION, "engine.request", { body: "do the task" });
    capture.recordTrace(SESSION, "tool.call", { name: "edit", marker: "before-the-crash" });
    capture.observeSession(SESSION, engine.target);
    // The journal is on disk within its flush interval; then the worker dies.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    capture.recordTrace(SESSION, "omnirush.test.worker_crash");
    await until(() => capture.mode() === "restarting", 10_000, "the worker's exit");
    // The turn finishes while the new worker comes up.
    engine.control.messages.push(engine.message("msg_2", "assistant"));
    engine.control.busy = false;
    await until(() => sink.envelopes().some((item) => JSON.stringify(item).includes("\"recovered\":true")), 30_000, "the settled recovered turn");
    const envelopes = sink.envelopes() as unknown as Array<{ snapshot_type: string; trace?: Array<{ type: string; data?: unknown }> }>;
    const recovered = envelopes.find((item) => item.trace?.[0]?.type === "collector.recovered");
    expect(recovered).toBeDefined();
    expect(JSON.stringify(recovered)).toContain("before-the-crash");
    const settled = envelopes.find((item) => item.trace?.some((event) => event.type === "turn.completed"));
    const completed = settled?.trace?.find((event) => event.type === "turn.completed");
    expect(completed?.data).toMatchObject({ recovered: true });
    expect(JSON.stringify(completed)).toContain("msg_2");
  }, 60_000);

  test("an app quit settles a turn still running before the chat ends", async () => {
    const root = await tempDir("quit-root");
    await writeFile(join(root, "app.txt"), "hello\n");
    const sink = uploadSink();
    const engine = fakeEngine();
    engine.control.messages = [engine.message("msg_1", "user"), engine.message("msg_2", "assistant")];
    const capture = service({ stateDir: await tempDir("quit-state"), sessionUploader: { upload: sink.upload } });
    capture.startSession(SESSION, "workspace-quit", root);
    capture.captureSnapshot(SESSION, "prompt");
    capture.observeSession(SESSION, engine.target);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    await capture.stop();
    const envelopes = sink.envelopes() as unknown as Array<{ snapshot_type: string; trace?: Array<{ type: string; data?: unknown }> }>;
    const completed = envelopes.flatMap((item) => item.trace ?? []).find((event) => event.type === "turn.completed");
    expect(completed?.data).toMatchObject({ reason: "app_quit" });
    expect(JSON.stringify(completed)).toContain("msg_2");
    expect(envelopes.at(-1)?.snapshot_type).toBe("end");
  }, 60_000);
});
